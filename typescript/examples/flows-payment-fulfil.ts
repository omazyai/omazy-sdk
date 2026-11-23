// The worked example of the flows kit: Joya's payment fulfilment (RFC-0901
// 7.8, 7.9, W29). After a manual bank payment for billing is approved, an
// automation starts the `payment_fulfil` workflow: check the payment, find
// what was bought, mark the invoice paid (not built yet, so it goes on
// finance's list), apply the level and extend the term (R3, four eyes), open
// go-live when the checks pass (R3), then tell the owner and the team. It
// makes no model call. It ships in dry run.
//
// The capabilities here are stand-ins over Maps; Joya's real ones live in
// Joya. Runtime neutral: the bun tests run it on the memory runner, and
// examples/flows-worker.ts runs it on Cloudflare Workflows.

import { createAi, memoryRunStore, promptTemplates, type RunStore } from '../src/ai/index'
import { type BaseCtx, defineCapabilities, registry, schema } from '../src/capabilities/index'
import {
  automation,
  createAutomations,
  createFlows,
  type FlowDeps,
  type Flows,
  type FlowStarter,
  type FlowStore,
  memoryFlowStore,
  memoryRunner,
  on,
  step,
  workflow,
} from '../src/flows/index'
import { approver, createGuard, type GuardStore, memoryGuardStore, policies, type StepUpVerifier } from '../src/guard/index'

type Permission = 'payments.read' | 'billing.read' | 'tenants.read' | 'tenants.write'
const { capability } = defineCapabilities<BaseCtx, Permission, 'platform'>()
const D = (s: string) => `${s} Used by the payment fulfilment workflow after a manual bank payment for billing is approved.`

// ---------------------------------------------------------------- the product's data

export type Level = 'essential' | 'professional' | 'enterprise' | 'pilot' | 'demo'
export interface Payment {
  id: string
  status: 'pending' | 'paid' | 'refunded'
  rail: 'manual_bank' | 'online' | 'erp'
  purpose: 'billing' | 'customer'
  tenant_id: string
  invoice_ref: string
  order_level: Level | null
  order_months: number | null
}
export interface Tenant {
  id: string
  level: Level
  status: 'setup' | 'rehearsal' | 'live' | 'suspended'
  basis: 'trial' | 'order' | null
  order_ref: string | null
  /** The five blocking go-live checks, as Joya's `go_live_checks` reads them. */
  missing: string[]
  version: number
}

export function world() {
  const payments = new Map<string, Payment>()
  const tenants = new Map<string, Tenant>()
  /** Every write a capability made, in order: what "dry run writes nothing" checks. */
  const writes: { capability: string; args: unknown }[] = []
  /** Calls per capability, retries included. */
  const calls = new Map<string, number>()
  const roles = new Map<string, string[]>([
    ['u_finance', ['finance_lead']],
    ['u_admin', ['platform_admin']],
    ['u_admin2', ['platform_admin']],
  ])
  /** Capabilities to fail, and how many more times: a stand-in for an outage. */
  const fail = new Map<string, number>()
  const count = (name: string) => {
    calls.set(name, (calls.get(name) ?? 0) + 1)
    const left = fail.get(name) ?? 0
    if (left > 0) {
      fail.set(name, left - 1)
      throw new Error(`${name} is down`)
    }
  }
  return { payments, tenants, writes, calls, roles, fail, count }
}
export type World = ReturnType<typeof world>

export function paymentCapabilities(w: World) {
  const tenantOf = (id: string) => {
    const t = w.tenants.get(id)
    if (!t) throw Object.assign(new Error(`no tenant ${id}`), { code: 'not_found' })
    return t
  }
  const version = (t: Tenant) => `v${t.version}`
  return [
    capability({
      name: 'payment_get',
      audiences: ['platform'],
      title: 'Read a payment',
      description: D('Reads one payment: status, rail, purpose, tenant, invoice reference and the level and months bought.'),
      permission: 'payments.read',
      risk: 'R1',
      input: schema.object({ payment_id: schema.id() }),
      version: 1,
      run: (_c, i) => {
        w.count('payment_get')
        const p = w.payments.get(i.payment_id)
        if (!p) throw new Error(`no payment ${i.payment_id}`)
        return { ...p }
      },
    }),
    capability({
      name: 'billing_order_get',
      audiences: ['platform'],
      title: 'Find what was bought',
      description: D('Reads the level and term a billing payment bought, from the payment until Business Brain orders can be read.'),
      permission: 'billing.read',
      risk: 'R0',
      input: schema.object({ payment_id: schema.id() }),
      version: 1,
      run: (_c, i) => {
        w.count('billing_order_get')
        const p = w.payments.get(i.payment_id)
        return p?.order_level ? { level: p.order_level, months: p.order_months ?? 12, missing: false } : { level: null, months: null, missing: true }
      },
    }),
    capability({
      name: 'tenant_get',
      audiences: ['platform'],
      title: 'Read a tenant',
      description: D('Reads one tenant: its level, its go-live status and basis, and its state version.'),
      permission: 'tenants.read',
      risk: 'R1',
      input: schema.object({ tenant_id: schema.id() }),
      version: 1,
      run: (_c, i) => {
        w.count('tenant_get')
        const t = tenantOf(i.tenant_id)
        return { id: t.id, level: t.level, status: t.status, basis: t.basis, version: version(t) }
      },
    }),
    capability({
      name: 'tenant_level_set',
      audiences: ['platform'],
      title: 'Set a tenant level',
      description: D('Sets the level a tenant is on, such as professional. Goes through four eyes approval.'),
      permission: 'tenants.write',
      risk: 'R3',
      approval: 'platform_four_eyes',
      input: schema.object({ tenant_id: schema.id(), level: schema.enum(['essential', 'professional', 'enterprise', 'pilot', 'demo']) }),
      version: 1,
      preview: (_c, i) => {
        const t = tenantOf(i.tenant_id)
        return { summary: `set ${t.id} from ${t.level} to ${i.level}`, before: { level: t.level }, after: { level: i.level }, stateVersion: version(t) }
      },
      run: (_c, i) => {
        w.count('tenant_level_set')
        const t = tenantOf(i.tenant_id)
        w.writes.push({ capability: 'tenant_level_set', args: i })
        t.level = i.level
        t.version++
        return { level: t.level }
      },
    }),
    capability({
      name: 'tenant_go_live_basis_set',
      audiences: ['platform'],
      title: 'Move a live tenant to an order',
      description: D('Moves a live tenant from a trial basis to an order basis with the invoice as the order reference, so the trial end no longer returns it to rehearsal.'),
      permission: 'tenants.write',
      risk: 'R3',
      approval: 'platform_four_eyes',
      input: schema.object({ tenant_id: schema.id(), order_ref: schema.text(64) }),
      version: 1,
      preview: (_c, i) => ({ summary: `move ${i.tenant_id} from its trial to order ${i.order_ref}`, stateVersion: version(tenantOf(i.tenant_id)) }),
      run: (_c, i) => {
        w.count('tenant_go_live_basis_set')
        const t = tenantOf(i.tenant_id)
        w.writes.push({ capability: 'tenant_go_live_basis_set', args: i })
        t.basis = 'order'
        t.order_ref = i.order_ref
        t.version++
        return { basis: t.basis }
      },
    }),
    capability({
      name: 'go_live_checks',
      audiences: ['platform'],
      title: 'Run the go-live checks',
      description: D('Runs the five blocking go-live checks for a tenant and says which are missing.'),
      permission: 'tenants.read',
      risk: 'R0',
      input: schema.object({ tenant_id: schema.id() }),
      version: 1,
      run: (_c, i) => {
        w.count('go_live_checks')
        const t = tenantOf(i.tenant_id)
        return { ready: t.missing.length === 0, missing: [...t.missing] }
      },
    }),
    capability({
      name: 'tenant_go_live_approve',
      audiences: ['platform'],
      title: 'Approve go-live',
      description: D('Makes a tenant live on an order basis with the invoice as the order reference. Paying never makes a tenant live by itself: this waits for approval.'),
      permission: 'tenants.write',
      risk: 'R3',
      approval: 'platform_four_eyes',
      input: schema.object({ tenant_id: schema.id(), order_ref: schema.text(64) }),
      version: 1,
      preview: (_c, i) => ({ summary: `make ${i.tenant_id} live on order ${i.order_ref}`, stateVersion: version(tenantOf(i.tenant_id)) }),
      run: (_c, i) => {
        w.count('tenant_go_live_approve')
        const t = tenantOf(i.tenant_id)
        w.writes.push({ capability: 'tenant_go_live_approve', args: i })
        t.status = 'live'
        t.basis = 'order'
        t.order_ref = i.order_ref
        t.version++
        return { status: t.status }
      },
    }),
    // invoice_mark_paid is not built until the Business Brain connector exists.
  ]
}

// ---------------------------------------------------------------- the workflow and its automation

export const paymentFulfil = workflow({
  id: 'payment_fulfil',
  version: 1,
  steps: [
    step.read('check', 'payment_get', {
      args: (s) => ({ payment_id: s.input.payment_id }),
      stop: (p) =>
        p.status !== 'paid'
          ? `payment ${p.id} is ${p.status}, not paid`
          : p.rail !== 'manual_bank' || p.purpose !== 'billing'
            ? `payment ${p.id} is not a manual bank payment for billing`
            : null,
    }),
    step.read('tenant', 'tenant_get', {
      args: (s) => ({ tenant_id: s.check.tenant_id }),
      stop: (t) => (t.status === 'suspended' ? `tenant ${t.id} is suspended` : null),
    }),
    step.read('order', 'billing_order_get', { args: (s) => ({ payment_id: s.input.payment_id }) }),
    step.write('invoice', 'invoice_mark_paid', {
      skipIf: 'not_built',
      todo: (s) => `Mark ${s.check.invoice_ref} paid in Business Brain.`,
      args: (s) => ({ invoice_ref: s.check.invoice_ref }),
    }),
    step.write('level', 'tenant_level_set', {
      when: (s) => !s.order.missing && s.order.level !== s.tenant.level,
      args: (s) => ({ tenant_id: s.tenant.id, level: s.order.level }),
    }),
    step.write('term', 'tenant_go_live_basis_set', {
      when: (s) => !s.order.missing && s.tenant.status === 'live' && s.tenant.basis === 'trial',
      args: (s) => ({ tenant_id: s.tenant.id, order_ref: s.check.invoice_ref }),
    }),
    step.read('checks', 'go_live_checks', {
      when: (s) => s.tenant.status === 'setup' || s.tenant.status === 'rehearsal',
      args: (s) => ({ tenant_id: s.tenant.id }),
    }),
    step.write('go_live', 'tenant_go_live_approve', {
      when: (s) => s.checks?.ready === true,
      args: (s) => ({ tenant_id: s.tenant.id, order_ref: s.check.invoice_ref }),
    }),
    step.notify('tell', 'payment_fulfilled', {
      data: (s) => ({
        payment: s.input.payment_id,
        tenant: s.tenant.id,
        level: s.level ? s.order.level : null,
        go_live_missing: s.checks?.missing ?? [],
        order_missing: s.order.missing,
      }),
    }),
  ],
})

export const fulfilOnApprove = automation({
  id: 'payment_fulfil',
  on: on.event('payment.approve', { rail: 'manual_bank', purpose: 'billing' }),
  run: paymentFulfil,
  instanceId: (e) => `fulfil:${e.payment_id}`,
  input: (e) => ({ payment_id: e.payment_id }),
  owner: 'finance_lead',
  budget: { runsPerDay: 50 },
  mode: 'dry_run',
})

// ---------------------------------------------------------------- wiring

/** For the example only: code 000000 proves anyone. Joya uses its own code and passkey verifiers. */
export const demoStepUp: StepUpVerifier<BaseCtx> = {
  methods: ['code'],
  verify: async (_c, proof) => (proof.codes?.email === '000000' ? { ok: true, method: 'code' } : { ok: false, reason: 'wrong code' }),
}

export interface FulfilmentOptions {
  w?: World
  store?: FlowStore
  /** The ai kit's run store, which holds each run's ledger. Default: in memory. */
  runs?: RunStore
  guardStore?: GuardStore
  /** Default: the memory runner. The Worker passes Cloudflare's. */
  starter?: (deps: FlowDeps) => FlowStarter
  now?: () => number
  /** Collects the guard's background work, so a test can wait for it. */
  waitUntil?: (p: Promise<unknown>) => void
}

export function fulfilment(o: FulfilmentOptions = {}) {
  const w = o.w ?? world()
  const reg = registry(paymentCapabilities(w))
  const store = o.store ?? memoryFlowStore()
  const notices: { template: string; data: unknown }[] = []
  const handoffs: { step: string; kind: string; message: string }[] = []
  const reports: string[][] = []
  let flows: Flows | undefined
  const roles = (ctx: BaseCtx) => w.roles.get(ctx.principal.id) ?? []
  const guard = createGuard<BaseCtx, Permission>({
    registry: reg,
    can: () => true,
    secret: 'example-secret-example-secret-0123456789',
    store: o.guardStore ?? memoryGuardStore(),
    policies: {
      platform_four_eyes: policies.fourEyes({ approver: approver.role(['platform_admin', 'finance']), stepUp: 'code', expires: '24h' }),
    },
    rolesOf: roles,
    stepUp: demoStepUp,
    onApproval: (e) => flows?.onApproval(e),
    ...(o.waitUntil ? { waitUntil: o.waitUntil } : {}),
    ...(o.now ? { now: o.now } : {}),
  })
  const ai = createAi<BaseCtx>({
    omazy: () => ({
      ai: {
        complete: async () => {
          throw new Error('payment_fulfil makes no model call')
        },
      },
    }),
    runs: o.runs ?? memoryRunStore(),
    prompts: promptTemplates({}),
    guard,
    registry: reg,
    ...(o.now ? { now: o.now } : {}),
  })
  const deps: FlowDeps = {
    ai,
    guard,
    registry: reg,
    store,
    roles,
    notify: (_c, n) => {
      notices.push({ template: n.template, data: n.data })
    },
    handoff: (_c, h) => {
      handoffs.push({ step: h.step, kind: h.kind, message: h.message })
    },
    report: (_c, r) => {
      reports.push(r.lines)
    },
    ...(o.now ? { now: o.now } : {}),
  }
  const runner = memoryRunner(deps, [paymentFulfil])
  const starter = o.starter ? o.starter(deps) : runner
  flows = createFlows({ store, runs: ai.runs, starter, ...(o.now ? { now: o.now } : {}) })
  const automations = createAutomations({ automations: [fulfilOnApprove], store, starter, roles, ...(o.now ? { now: o.now } : {}) })
  return { w, reg, guard, ai, store, deps, runner, flows, automations, notices, handoffs, reports }
}

/** The seats in this example. */
export const seats = {
  finance: (): BaseCtx => ({
    principal: { kind: 'member', id: 'u_finance', name: 'Finance lead' },
    seat: { id: 'seat_finance', door: 'platform', tenant: null },
    tenant: null,
    channel: 'console',
    approvalId: null,
    requestId: 'req_finance',
  }),
  admin: (id = 'u_admin'): BaseCtx => ({
    principal: { kind: 'member', id, name: 'Platform admin' },
    seat: { id: `seat_${id}`, door: 'platform', tenant: null },
    tenant: null,
    channel: 'console',
    approvalId: null,
    requestId: `req_${id}`,
  }),
}

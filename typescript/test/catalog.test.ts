import { describe, expect, test } from 'bun:test'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { copilotUnit, promptTemplates } from '../src/ai/index'
import { type BaseCtx, capability, registry, schema } from '../src/capabilities/index'
import { approver, createGuard, type Guard, GuardRefusal, memoryGuardStore, policies, type StepUpVerifier } from '../src/guard/index'
import {
  assertApprovals,
  assertCatalogParity,
  assertTenantIsolation,
  assertTierSnapshot,
  CatalogCheckFailure,
  checkApprovals,
  checkCatalogParity,
  checkTenantIsolation,
  checkTierSnapshot,
  formatCatalogReport,
} from '../src/testing/index'

// ---------------------------------------------------------------- a small product with two tenants

const D = (s: string) => `${s} This sentence pads the description so that it passes the eighty character minimum of the kit.`

const bookings: Record<string, { tenant: string; who: string }> = { bk_a1: { tenant: 'tA', who: 'Rina' }, bk_b1: { tenant: 'tB', who: 'Karim' } }
const payments: Record<string, string> = { pay_a1: 'tA', pay_b1: 'tB' }
const effects = { n: 0 }

const bookingGet = capability({
  name: 'booking_get',
  audiences: ['org'],
  title: 'Get a booking',
  description: D('Reads one booking by its id.'),
  permission: 'bookings.read',
  risk: 'R1',
  input: schema.object({ booking_id: schema.id() }),
  version: 1,
  run: (_c, i) => {
    const b = bookings[i.booking_id]
    if (!b) throw new GuardRefusal('not_found', 'not_found', 'There is no such booking.')
    return b
  },
})
const staffAdd = capability({
  name: 'staff_add',
  audiences: ['org'],
  title: 'Add a staff member',
  description: D('Adds one staff member to the tenant with a role.'),
  permission: 'staff.write',
  risk: 'R2',
  input: schema.object({ name: schema.text(80), tenant_id: schema.id().optional() }),
  version: 1,
  preview: (_c, i) => ({ summary: `Add ${i.name}`, stateVersion: 's1' }),
  run: () => {
    effects.n++
    return { ok: true }
  },
})
const refundSpec = {
  name: 'payment_refund',
  audiences: ['org'] as const,
  title: 'Refund a payment',
  description: D('Refunds one payment in full to the card it came from.'),
  permission: 'payments.refund',
  risk: 'R3' as const,
  approval: 'single',
  input: schema.object({ payment_id: schema.id() }),
  version: 1,
  preview: (_c: BaseCtx, i: { payment_id: string }) => ({ summary: `Refund ${i.payment_id}`, stateVersion: 'p1' }),
  run: () => {
    effects.n++
    return { refunded: true }
  },
}
const paymentRefund = capability(refundSpec)
const tenantDelete = capability({
  name: 'tenant_delete',
  audiences: ['org'],
  title: 'Delete a tenant',
  description: D('Deletes a tenant and every record it holds.'),
  permission: 'tenants.delete',
  risk: 'R4',
  approval: 'four_eyes',
  input: schema.object({ tenant_id: schema.id() }),
  version: 1,
  preview: (_c, i) => ({ summary: `Delete ${i.tenant_id}` }),
  run: () => {
    effects.n++
    return { deleted: true }
  },
})
const reg = registry([bookingGet, staffAdd, paymentRefund, tenantDelete])

const seat = (id: string, tenant = 'tA'): BaseCtx => ({
  principal: { kind: 'member', id },
  seat: { id: `seat_${id}`, door: 'org', tenant },
  tenant,
  channel: 'console',
  approvalId: null,
  requestId: `req_${id}`,
})
const rina = seat('p_rina')
const farid = seat('p_farid')

const codeOnly: StepUpVerifier<BaseCtx> = {
  methods: ['code'],
  verify: async (_c, proof) => (proof.codes?.sms === '123456' ? { ok: true, method: 'code' } : { ok: false, reason: 'wrong code' }),
}

function guardFor(o: { stepUp?: StepUpVerifier<BaseCtx>; fourEyes?: boolean; tenantsOf?: boolean } = {}): Guard<BaseCtx> {
  return createGuard<BaseCtx, string>({
    registry: reg,
    can: () => true,
    secret: 'test-secret-test-secret-test-secret-0123',
    store: memoryGuardStore(),
    policies: {
      single: policies.single({ approver: approver.role('finance'), stepUp: 'code', expires: '1h' }),
      four_eyes: (o.fourEyes ?? true ? policies.fourEyes : policies.single)({ approver: approver.role(['finance', 'member']), stepUp: 'code', expires: '24h' }),
    },
    rolesOf: () => ['finance', 'member'],
    stepUp: o.stepUp ?? codeOnly,
    tenantsOf:
      o.tenantsOf === false
        ? undefined
        : (_c, cap, input) => {
            const i = input as Record<string, string>
            if (cap.name === 'booking_get') return bookings[i.booking_id] ? [bookings[i.booking_id]!.tenant] : []
            if (cap.name === 'payment_refund') return payments[i.payment_id] ? [payments[i.payment_id]!] : []
            return []
          },
  })
}

const approvalArgs = { payment_refund: { payment_id: 'pay_a1' }, tenant_delete: { tenant_id: 'tA' } }
const goodProof = () => ({ method: 'code', codes: { sms: '123456' } })

// ---------------------------------------------------------------- approvals

describe('approval invariant', () => {
  test('a sound guard passes: nothing at R3 or R4 runs before a decided, step-up verified approval', async () => {
    effects.n = 0
    const r = await assertApprovals({ registry: reg, guard: guardFor(), requester: rina, decider: farid, proof: goodProof, args: approvalArgs, effects: () => effects.n })
    expect(r.ok).toBe(true)
    expect(r.checked).toEqual(['payment_refund', 'tenant_delete'])
    // Each approved action ran once, on the valid decision.
    expect(effects.n).toBe(2)
    expect(formatCatalogReport(r)).toBe('PASS approvals: 2 capabilities, 0 problems')
  })

  test('without a decider only the asking side is checked', async () => {
    effects.n = 0
    const r = await checkApprovals({ registry: reg, guard: guardFor(), requester: rina, args: approvalArgs })
    expect(r.ok).toBe(true)
    expect(effects.n).toBe(0)
  })

  test('a wrapper that trusts the ctx approval id is caught', async () => {
    const real = guardFor()
    const leaky: Guard<BaseCtx> = Object.assign(Object.create(real), {
      call: async (ctx: BaseCtx, name: string, args: unknown, opts?: object) => {
        if (ctx.approvalId) return { outcome: 'ok', result: await reg.get(name)!.run(ctx, args), requestId: ctx.requestId }
        return real.call(ctx, name, args, opts)
      },
    })
    const r = await checkApprovals({ registry: reg, guard: leaky, requester: rina, args: approvalArgs, effects: () => effects.n })
    expect(r.ok).toBe(false)
    const steps = r.problems.map((p) => `${p.capability} ${p.step} ${p.kind}`)
    expect(steps).toContain('payment_refund forged_approval_id violation')
    expect(r.problems.find((p) => p.step === 'forged_approval_id')!.message).toBe('a call carrying the waiting approval id ran it without a decided approval')
    await expect(assertApprovals({ registry: reg, guard: leaky, requester: rina, args: approvalArgs })).rejects.toThrow(CatalogCheckFailure)
  })

  test('a verifier that accepts any proof, and a four eyes policy the requester can pass, are caught', async () => {
    const lax: StepUpVerifier<BaseCtx> = { methods: ['code'], verify: async () => ({ ok: true, method: 'code' }) }
    const r = await checkApprovals({ registry: reg, guard: guardFor({ stepUp: lax }), requester: rina, decider: farid, proof: goodProof, args: approvalArgs })
    expect(r.problems.map((p) => `${p.capability} ${p.step}`)).toEqual(['payment_refund decide_bad_proof', 'tenant_delete decide_bad_proof'])

    // The guard itself enforces four eyes, so an honest guard passes the self-approval step.
    const fine = await checkApprovals({ registry: reg, guard: guardFor(), requester: rina, decider: farid, proof: goodProof, args: { tenant_delete: { tenant_id: 'tA' } }, skip: ['payment_refund'] })
    expect(fine.ok).toBe(true)
    // A product that lets the requester decide through its own wrapper is caught.
    const real = guardFor()
    const selfish: Guard<BaseCtx> = Object.assign(Object.create(real), {
      decide: (id: string, who: BaseCtx, d: object, o?: object) => real.decide(id, who.principal.id === 'p_rina' ? farid : who, d as never, o),
    })
    const bad = await checkApprovals({ registry: reg, guard: selfish, requester: rina, decider: farid, proof: goodProof, args: { tenant_delete: { tenant_id: 'tA' } }, skip: ['payment_refund'] })
    expect(bad.problems.map((p) => p.step)).toContain('self_approval')
  })

  test('missing arguments, a refused requester and a missing proof are setup problems', async () => {
    const strict = createGuard<BaseCtx, string>({
      registry: reg,
      can: (c) => c.principal.id !== 'p_rina',
      secret: 'test-secret-test-secret-test-secret-0123',
      store: memoryGuardStore(),
      policies: { single: policies.single({ approver: approver.role('finance'), stepUp: 'code', expires: '1h' }) },
    })
    const r = await checkApprovals({ registry: reg, guard: strict, requester: rina, args: { payment_refund: { payment_id: 'pay_a1' } } })
    expect(r.problems).toEqual([
      { kind: 'setup', capability: 'payment_refund', step: 'call', message: 'the requester was refused, refused_permission (no_permission): You do not have permission to do this.; give a requester that may ask' },
      { kind: 'setup', capability: 'tenant_delete', step: 'arguments', message: 'R4 with no arguments to drive it; add them to args or list it in skip' },
    ])
    const noProof = await checkApprovals({ registry: reg, guard: guardFor(), requester: rina, decider: farid, args: approvalArgs })
    expect(noProof.problems.every((p) => p.kind === 'setup' && p.step === 'decide')).toBe(true)
    expect(formatCatalogReport(r).split('\n')[2]).toBe('  - tenant_delete arguments: R4 with no arguments to drive it; add them to args or list it in skip')
  })
})

// ---------------------------------------------------------------- tenant isolation

describe('tenant isolation', () => {
  const args = { booking_get: { booking_id: 'bk_b1' }, staff_add: { name: 'Mita' }, payment_refund: { payment_id: 'pay_b1' }, tenant_delete: { tenant_id: 'tB' } }

  test('every capability refuses tenant B\'s ids from a tenant A seat', async () => {
    effects.n = 0
    const r = await assertTenantIsolation({ registry: reg, guard: guardFor(), seat: rina, args, otherTenant: 'tB', skip: ['staff_add'], effects: () => effects.n })
    expect(r.checked).toEqual(['booking_get', 'payment_refund', 'tenant_delete'])
    expect(effects.n).toBe(0)
  })

  test('a lookup the guard cannot see across is a violation, and the tenant field probe is added', async () => {
    const r = await checkTenantIsolation({ registry: reg, guard: guardFor({ tenantsOf: false }), seat: rina, args, otherTenant: 'tB' })
    expect(r.problems.map((p) => `${p.kind} ${p.capability} ${p.step}: ${p.message}`)).toEqual([
      "violation booking_get tenant_b_ids: answered ok for tenant B's records",
      "violation staff_add tenant_b_ids: reached a confirm with a preview of tenant B's record",
      "violation payment_refund tenant_b_ids: opened an approval for tenant B's record",
    ])
    expect(r.checked).toContain('tenant_delete')
  })

  test('a capability with no arguments, or invalid ones, is a setup problem', async () => {
    const r = await checkTenantIsolation({ registry: reg, guard: guardFor(), seat: rina, args: { booking_get: { booking_id: 'bk_b1' }, staff_add: { name: '' }, tenant_delete: { tenant_id: 'tB' } } })
    expect(r.problems.map((p) => `${p.kind} ${p.capability} ${p.step}`)).toEqual(['setup staff_add tenant_b_ids', 'setup payment_refund arguments'])
    expect(r.problems[0]!.message).toMatch(/^ended invalid \(invalid_arguments\)/)
  })
})

// ---------------------------------------------------------------- tier snapshot

describe('tier snapshot', () => {
  test('passes when the registry matches the committed snapshot', async () => {
    const r = await assertTierSnapshot({ registry: reg, snapshot: reg.snapshot(), update: false })
    expect(r.ok).toBe(true)
    expect(r.changes).toEqual([])
    expect(r.checked.length).toBe(4)
  })

  test('a lowered tier fails until the snapshot is updated; the file is written on update', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'omazy-snap-'))
    const file = join(dir, 'catalog.snapshot.json')
    writeFileSync(file, `${JSON.stringify(reg.snapshot(), null, 2)}\n`)
    const lowered = registry([bookingGet, staffAdd, capability({ ...refundSpec, risk: 'R2', approval: undefined, version: 1 }), tenantDelete])
    const r = await checkTierSnapshot({ registry: lowered, snapshot: file, update: false })
    expect(r.ok).toBe(false)
    expect(r.tiers).toEqual([{ name: 'payment_refund', from: 'R3', to: 'R2' }])
    expect(r.problems[0]).toEqual({ kind: 'violation', capability: 'payment_refund', step: 'tier', message: 'tier lowered from R3 to R2; it no longer waits for an approval; update the snapshot once reviewed' })
    expect(r.changelog).toContain('`payment_refund`: tier R3 to R2')
    await expect(assertTierSnapshot({ registry: lowered, snapshot: file, update: false })).rejects.toThrow(CatalogCheckFailure)

    const w = await checkTierSnapshot({ registry: lowered, snapshot: file, update: true })
    expect(w.ok).toBe(true)
    expect(w.written).toBe(true)
    expect(JSON.parse(readFileSync(file, 'utf8')).capabilities.find((c: { name: string }) => c.name === 'payment_refund').risk).toBe('R2')
    expect((await checkTierSnapshot({ registry: lowered, snapshot: file, update: false })).ok).toBe(true)
  })

  test('a breaking change fails and is never written; a missing file is written only on update', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'omazy-snap-'))
    const file = join(dir, 'snap.json')
    writeFileSync(file, JSON.stringify(reg.snapshot()))
    const smaller = registry([bookingGet, staffAdd, paymentRefund])
    const r = await checkTierSnapshot({ registry: smaller, snapshot: file, update: true, today: '2026-11-24' })
    expect(r.written).toBe(false)
    expect(r.problems).toEqual([{ kind: 'violation', capability: 'tenant_delete', step: 'breaking', message: 'removed without deprecation' }])
    expect(r.tiers).toEqual([{ name: 'tenant_delete', from: 'R4', to: null }])

    const missing = join(dir, 'sub', 'new.json')
    const none = await checkTierSnapshot({ registry: reg, snapshot: missing, update: false })
    expect(none.problems[0]!.step).toBe('no_snapshot')
    const made = await checkTierSnapshot({ registry: reg, snapshot: missing, update: true })
    expect(made.written).toBe(true)
    expect(JSON.parse(readFileSync(missing, 'utf8'))).toEqual(reg.snapshot())
  })

  test('a description change alone still needs the snapshot updated', async () => {
    const before = reg.snapshot()
    const reworded = registry([capability({ ...refundSpec, title: 'Refund a card payment' }), bookingGet, staffAdd, tenantDelete])
    const r = await checkTierSnapshot({ registry: reworded, snapshot: before, update: false })
    expect(r.problems.map((p) => p.step)).toEqual(['changed'])
  })
})

// ---------------------------------------------------------------- parity

describe('catalog parity', () => {
  const prompts = promptTemplates({ 'copilot/main': { 1: { en: 'You help.' } } })
  const unit = (allow: string[], maxTier: 'R1' | 'R4') =>
    copilotUnit({
      id: 'org_helper',
      version: 1,
      owner: 'org',
      model: { use: 'converse' },
      prompt: { template: 'copilot/main', version: 1, languages: ['en'] },
      context: { layers: ['unit'], budgetTokens: 8000 },
      memory: { read: [], write: [] },
      tools: { allow, maxTier },
      evals: 'evals/copilot/helper.jsonl',
      caps: { perRunUsd: 0.5, perDayUsd: 5 },
    })

  test('passes when surfaces and units agree with the registry', () => {
    const r = assertCatalogParity({ registry: reg, surfaces: { 'mcp org': { audience: 'org', tools: ['booking_get', 'staff_add'] } }, audiences: ['org'], units: [unit(['booking_get'], 'R1')], prompts })
    expect(r.ok).toBe(true)
  })

  test('lists a surface naming a missing tool, a door that cannot see it and a unit above its tier', () => {
    const r = checkCatalogParity({
      registry: reg,
      surfaces: { 'copilot core': ['booking_get', 'bookings_search'], 'mcp host': { audience: 'host', tools: ['staff_add'] } },
      units: [unit(['booking_get', 'tenant_delete'], 'R1')],
    })
    expect(r.problems.map((p) => `${p.step} ${p.capability ?? ''}: ${p.message}`)).toEqual([
      'surface copilot core bookings_search: not in the registry',
      'surface mcp host staff_add: not visible to door host',
      "unit org_helper : tool tenant_delete is R4, above the unit's maxTier R1",
    ])
    expect(() => assertCatalogParity({ registry: reg, surfaces: { x: ['nope_get'] } })).toThrow(/FAIL parity/)
  })
})

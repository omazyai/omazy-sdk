import { Database } from 'bun:sqlite'
import { describe, expect, test } from 'bun:test'
import { fulfilment, type Payment, seats, type Tenant, type World, world } from '../examples/flows-payment-fulfil'
import { applyAiMigrations, createAi, d1RunStore, memoryRunStore, promptTemplates, task } from '../src/ai/index'
import { type BaseCtx, defineCapabilities, registry, schema } from '../src/capabilities/index'
import {
  applyFlowMigrations,
  automation,
  AutomationError,
  createAutomations,
  createFlows,
  cron,
  CronError,
  isTimeZone,
  localMinute,
  localTime,
  d1FlowStore,
  FLOW_LIMITS,
  type FlowDeps,
  instanceIdFor,
  memoryFlowStore,
  memoryRunner,
  on,
  step,
  workflow,
  WorkflowError,
  workflowProblems,
} from '../src/flows/index'
import { createGuard, type D1DatabaseLike, type D1PreparedStatementLike, memoryGuardStore, memorySwitches } from '../src/guard/index'

// ---------------------------------------------------------------- helpers

const payment = (id: string, over: Partial<Payment> = {}): Payment => ({
  id,
  status: 'paid',
  rail: 'manual_bank',
  purpose: 'billing',
  tenant_id: 'tA',
  invoice_ref: 'INV-0042',
  order_level: 'professional',
  order_months: 12,
  ...over,
})
const tenant = (over: Partial<Tenant> = {}): Tenant => ({ id: 'tA', level: 'essential', status: 'rehearsal', basis: null, order_ref: null, missing: [], version: 1, ...over })

function setup(o: { tenant?: Partial<Tenant>; payments?: Payment[] } = {}) {
  const w = world()
  w.tenants.set('tA', tenant(o.tenant))
  for (const p of o.payments ?? [payment('pay_1')]) w.payments.set(p.id, p)
  const pending: Promise<unknown>[] = []
  const f = fulfilment({ w, waitUntil: (p) => pending.push(p) })
  /** Waits for the guard's background events and every run. */
  const settle = async () => {
    for (let i = 0; i < 5; i++) {
      await Promise.all(pending.splice(0))
      await f.runner.idle()
    }
  }
  return { ...f, settle }
}

const approveEvent = (payment_id: string) => ({ type: 'payment.approve', tenant: null, data: { payment_id, rail: 'manual_bank', purpose: 'billing' } })
const decide = (f: ReturnType<typeof setup>, approvalId: string, approve = true, who = 'u_admin') =>
  f.guard.decide(approvalId, seats.admin(who), approve ? { approve: true, proof: { method: 'code', codes: { email: '000000' } } } : { approve: false, reason: 'not this month' })
const waitingApproval = async (f: ReturnType<typeof setup>, key: string, stepId: string) => {
  const row = (await f.flows.steps(key)).find((s) => s.key === stepId)
  expect(row?.status).toBe('waiting')
  return row!.approvalId!
}

// ---------------------------------------------------------------- definitions

describe('workflow definitions', () => {
  test('a bad definition lists every rule it breaks', () => {
    const p = workflowProblems({
      id: 'Bad-Id',
      version: 0,
      steps: [
        step.read('a', 'payment_get'),
        step.read('a', 'payment_get'),
        { ...step.write('w', 'tenant_level_set'), retries: { limit: 3 } } as never,
        step.bulk('b', 'staff_add', { items: () => [], args: (x) => x, chunk: FLOW_LIMITS.maxChunk + 1 }),
        step.read('input', 'payment_get'),
      ],
    })
    expect(p.join('\n')).toContain('id must be')
    expect(p.join('\n')).toContain('version must be')
    expect(p.join('\n')).toContain('id repeats')
    expect(p.join('\n')).toContain('a write step never retries')
    expect(p.join('\n')).toContain(`chunk must be a whole number from 1 to ${FLOW_LIMITS.maxChunk}`)
    expect(p.join('\n')).toContain("input is the run's input")
    expect(() => workflow({ id: 'x_y', version: 1, steps: [] })).toThrow(WorkflowError)
  })

  test('the workflow carries a unit whose tools are its capabilities, at R3 at most by default', async () => {
    const f = setup()
    expect(f.reg.has('invoice_mark_paid')).toBe(false)
    const wf = (await import('../examples/flows-payment-fulfil')).paymentFulfil
    expect(wf.maxTier).toBe('R3')
    expect(wf.unit.tools?.allow).toContain('tenant_go_live_approve')
    expect(wf.unit.kind).toBe('workflow')
  })

  test('automations check their owner, trigger and budget', () => {
    const wf = workflow({ id: 'w_x', version: 1, steps: [step.notify('n', 't')] })
    expect(() => automation({ id: 'a_b', on: on.event('x.y'), run: wf, owner: '', budget: { perYear: 3 } as never })).toThrow(AutomationError)
    expect(automation({ id: 'a_b', on: on.event('x.y'), run: wf, owner: 'finance_lead' }).mode).toBe('dry_run')
  })
})

// ---------------------------------------------------------------- the worked example

describe('payment fulfilment (RFC-0901 W29)', () => {
  test('dry run writes nothing, previews every write and reports what it would do', async () => {
    const f = setup()
    expect((await f.automations.enable(seats.finance(), 'payment_fulfil')).ok).toBe(true)
    const [r] = await f.automations.dispatch(approveEvent('pay_1'))
    expect(r).toMatchObject({ outcome: 'started', key: 'fulfil:pay_1' })
    await f.settle()
    const run = await f.flows.run('fulfil:pay_1')
    expect(run).toMatchObject({ status: 'ok', mode: 'dry_run', reported: false })
    expect(f.w.writes).toEqual([])
    expect(f.w.calls.get('tenant_level_set')).toBeUndefined()
    expect(await f.guard.approval('x')).toBeNull()
    expect(f.notices).toEqual([])
    const steps = Object.fromEntries((await f.flows.steps('fulfil:pay_1')).map((s) => [s.key, s]))
    expect(steps.check!.status).toBe('ok')
    expect(steps.invoice).toMatchObject({ status: 'skipped', code: 'not_built' })
    expect(steps.level).toMatchObject({ status: 'planned', message: 'set tA from essential to professional' })
    expect(steps.term).toMatchObject({ status: 'skipped', code: 'condition' })
    expect(steps.go_live).toMatchObject({ status: 'planned', message: 'make tA live on order INV-0042' })
    expect(steps.tell).toMatchObject({ status: 'planned' })
    expect(run!.report).toEqual(['level: would set tA from essential to professional', 'go_live: would make tA live on order INV-0042', 'tell: would send payment_fulfilled'])
    expect(f.reports).toEqual([run!.report])
    expect(f.handoffs).toEqual([{ step: 'invoice', kind: 'not_built', message: 'Mark INV-0042 paid in Business Brain.' }])
    // One ledger: reads ran through the guard, writes were previewed through it, and every step is a row.
    const effects = await f.ai.runs.effects('fulfil:pay_1')
    expect(effects.map((e) => `${e.step}:${e.capability}:${e.outcome}${e.preview ? ':preview' : ''}`)).toEqual([
      'check:payment_get:ok',
      'tenant:tenant_get:ok',
      'order:billing_order_get:ok',
      'invoice:invoice_mark_paid:skipped',
      'level:tenant_level_set:planned:preview',
      'term:tenant_go_live_basis_set:skipped',
      'checks:go_live_checks:ok',
      'go_live:tenant_go_live_approve:planned:preview',
      'tell:payment_fulfilled:planned',
    ])
    expect(effects.filter((e) => e.outcome === 'ok').every((e) => e.mode === 'read')).toBe(true)
    expect(effects[0]!.requestId).toBe('fulfil:pay_1:check')
    expect(effects[4]).toMatchObject({ stepKind: 'write', tier: 'R3', message: 'set tA from essential to professional' })
  })

  test('an approval pauses the run and its decision resumes it; refused approvals let the run go on', async () => {
    const f = setup()
    await f.automations.enable(seats.finance(), 'payment_fulfil', { mode: 'live' })
    await f.automations.dispatch(approveEvent('pay_1'))
    await f.settle()
    expect((await f.flows.run('fulfil:pay_1'))!.status).toBe('waiting')
    expect(f.runner.status('fulfil:pay_1')).toBe('waiting')
    const levelApproval = await waitingApproval(f, 'fulfil:pay_1', 'level')
    expect(f.w.tenants.get('tA')!.level).toBe('essential')

    // Four eyes: the automation's owner cannot decide it.
    expect(await f.guard.canDecide(levelApproval, seats.finance())).toMatchObject({ ok: false })
    const d = await decide(f, levelApproval)
    expect(d.outcome).toBe('approved')
    await f.settle()
    expect(f.w.tenants.get('tA')!.level).toBe('professional')
    expect(f.w.calls.get('tenant_level_set')).toBe(1)

    const goLive = await waitingApproval(f, 'fulfil:pay_1', 'go_live')
    await decide(f, goLive, false)
    await f.settle()
    const run = await f.flows.run('fulfil:pay_1')
    expect(run).toMatchObject({ status: 'ok', reported: true })
    const steps = Object.fromEntries((await f.flows.steps('fulfil:pay_1')).map((s) => [s.key, s]))
    expect(steps.level).toMatchObject({ status: 'ok', approvalId: levelApproval, tier: 'R3' })
    expect(steps.go_live).toMatchObject({ status: 'refused', code: 'approval_refused', message: 'not this month' })
    expect(f.w.tenants.get('tA')!.status).toBe('rehearsal')
    expect(f.notices).toEqual([{ template: 'payment_fulfilled', data: { payment: 'pay_1', tenant: 'tA', level: 'professional', go_live_missing: [], order_missing: false } }])
    const effects = await f.ai.runs.effects('fulfil:pay_1')
    expect(effects.filter((e) => e.outcome === 'pending_approval').map((e) => e.capability)).toEqual(['tenant_level_set', 'tenant_go_live_approve'])
    expect((await f.ai.runs.getRun('fulfil:pay_1'))!.outcome).toBe('ok')
  })

  test("the guard's failed and stale events wake the run, with no approvalSettled call", async () => {
    const f = setup()
    await f.automations.enable(seats.finance(), 'payment_fulfil', { mode: 'live' })
    await f.automations.dispatch(approveEvent('pay_1'))
    await f.settle()
    f.w.fail.set('tenant_level_set', 1)
    await decide(f, await waitingApproval(f, 'fulfil:pay_1', 'level'))
    await f.settle()
    expect((await f.flows.steps('fulfil:pay_1')).find((s) => s.key === 'level')).toMatchObject({ status: 'failed', code: 'run_failed' })
    expect(f.handoffs.at(-1)).toMatchObject({ step: 'level', kind: 'failed' })
    expect(f.w.calls.get('tenant_level_set')).toBe(1)

    const g = setup()
    await g.automations.enable(seats.finance(), 'payment_fulfil', { mode: 'live' })
    await g.automations.dispatch(approveEvent('pay_1'))
    await g.settle()
    const level = await waitingApproval(g, 'fulfil:pay_1', 'level')
    g.w.tenants.get('tA')!.version++
    await decide(g, level)
    await g.settle()
    expect((await g.flows.steps('fulfil:pay_1')).find((s) => s.key === 'level')).toMatchObject({ status: 'refused', code: 'stale' })
    expect(g.handoffs.at(-1)).toMatchObject({ step: 'level', kind: 'stale' })
    expect(g.w.tenants.get('tA')!.level).toBe('essential')
  })

  test('an approval nobody decides times out to a person', async () => {
    const f = setup()
    await f.automations.enable(seats.finance(), 'payment_fulfil', { mode: 'live' })
    await f.automations.dispatch(approveEvent('pay_1'))
    await f.settle()
    await f.runner.advance(25 * 3_600_000)
    await f.settle()
    const steps = Object.fromEntries((await f.flows.steps('fulfil:pay_1')).map((s) => [s.key, s]))
    expect(steps.level).toMatchObject({ status: 'refused', code: 'expired' })
    expect(f.handoffs.at(-1)).toMatchObject({ step: 'level', kind: 'expired' })
    await f.flows.resolve('fulfil:pay_1', 'level', { action: 'stop', by: 'u_finance' })
    await f.settle()
    expect(await f.flows.run('fulfil:pay_1')).toMatchObject({ status: 'stopped', reason: 'level refused: stopped by u_finance' })
  })

  test('one run per payment: a second event and a second start do nothing', async () => {
    const f = setup()
    await f.automations.enable(seats.finance(), 'payment_fulfil')
    expect((await f.automations.dispatch(approveEvent('pay_1')))[0]!.outcome).toBe('started')
    expect((await f.automations.dispatch(approveEvent('pay_1')))[0]!.outcome).toBe('exists')
    const again = await f.flows.start(seats.finance(), (await import('../examples/flows-payment-fulfil')).paymentFulfil, 'fulfil:pay_1', { input: { payment_id: 'pay_1' } })
    expect(again.outcome).toBe('exists')
    await f.settle()
    expect(f.w.calls.get('payment_get')).toBe(1)
    expect(f.runner.instances.size).toBe(1)
  })

  test('events that do not match the trigger start nothing; a payment that is not for billing stops at the check', async () => {
    const f = setup({ payments: [payment('pay_c', { purpose: 'customer' })] })
    await f.automations.enable(seats.finance(), 'payment_fulfil', { mode: 'live' })
    expect(await f.automations.dispatch({ type: 'payment.approve', tenant: null, data: { payment_id: 'pay_c', rail: 'manual_bank', purpose: 'customer' } })).toEqual([])
    const r = await f.flows.start(seats.finance(), (await import('../examples/flows-payment-fulfil')).paymentFulfil, 'fulfil:pay_c', { input: { payment_id: 'pay_c' } })
    expect(r.outcome).toBe('started')
    await f.settle()
    expect(await f.flows.run('fulfil:pay_c')).toMatchObject({ status: 'stopped', reason: 'payment pay_c is not a manual bank payment for billing' })
  })

  test('the owner losing the role stops the automation, mid-run and for later events', async () => {
    const f = setup({ payments: [payment('pay_1'), payment('pay_2')] })
    await f.automations.enable(seats.finance(), 'payment_fulfil', { mode: 'live' })
    await f.automations.dispatch(approveEvent('pay_1'))
    await f.settle()
    const level = await waitingApproval(f, 'fulfil:pay_1', 'level')
    f.w.roles.set('u_finance', [])
    await decide(f, level)
    await f.settle()
    expect(await f.flows.run('fulfil:pay_1')).toMatchObject({ status: 'stopped', reason: 'owner_lost_role' })
    // The approved change itself ran: it was decided by a person.
    expect(f.w.tenants.get('tA')!.level).toBe('professional')
    expect(f.w.calls.get('go_live_checks')).toBeUndefined()
    const row = (await f.store.listAutomations())[0]!
    expect(row).toMatchObject({ on: false, stoppedReason: 'owner_lost_role' })
    expect((await f.automations.dispatch(approveEvent('pay_2')))[0]!.outcome).toBe('off')

    // Turned on again while the role is still gone: refused at the next event and recorded.
    const g = setup({ payments: [payment('pay_3')] })
    await g.automations.enable(seats.finance(), 'payment_fulfil')
    g.w.roles.set('u_finance', ['member'])
    const [r] = await g.automations.dispatch(approveEvent('pay_3'))
    expect(r!.outcome).toBe('owner_lost_role')
    expect((await g.store.listRuns({ status: 'refused' })).length).toBe(1)
    expect(await g.automations.enable(seats.finance(), 'payment_fulfil')).toMatchObject({ ok: false, code: 'no_role' })
  })

  test('the budget refuses runs past it, and the refusal is recorded', async () => {
    const f = setup({ payments: Array.from({ length: 3 }, (_, i) => payment(`pay_${i}`)) })
    await f.automations.enable(seats.finance(), 'payment_fulfil')
    const wfA = automation({ ...f.automations.list[0]!, budget: { runsPerDay: 2 } })
    const a = createAutomations({ automations: [wfA], store: f.store, starter: f.runner, roles: (c) => f.w.roles.get(c.principal.id) ?? [] })
    const out = []
    for (let i = 0; i < 3; i++) out.push((await a.dispatch(approveEvent(`pay_${i}`)))[0]!.outcome)
    expect(out).toEqual(['started', 'started', 'refused_budget'])
    const refused = await f.store.listRuns({ status: 'refused' })
    expect(refused[0]!.reason).toBe('Budget spent: 2 of 2 runs today.')
    expect(await f.store.usage({ automation: 'payment_fulfil', tenant: null, since: '2000-01-01' })).toEqual({ runs: 2, costMicros: 0 })
  })

  test('a switch turns an automation off', async () => {
    const f = setup()
    await f.automations.enable(seats.finance(), 'payment_fulfil')
    const switches = memorySwitches([{ key: 'automation:payment_fulfil', scope: 'global', subject: null, on: false }])
    const a = createAutomations({ automations: f.automations.list, store: f.store, starter: f.runner, roles: () => ['finance_lead'], switches })
    expect((await a.dispatch(approveEvent('pay_1')))[0]!.outcome).toBe('switched_off')
    await f.automations.disable(seats.finance(), 'payment_fulfil')
    expect((await f.automations.dispatch(approveEvent('pay_1')))[0]!.outcome).toBe('off')
  })
})

// ---------------------------------------------------------------- a product of its own

type Cx = BaseCtx
const { capability } = defineCapabilities<Cx, string, 'org'>()
const D = (s: string) => `${s} This sentence pads the description so that it passes the eighty character minimum.`

function product(o: { failWrite?: boolean; readFailures?: number; deny?: string[] } = {}) {
  const calls: Record<string, number> = {}
  const added: string[] = []
  let readFails = o.readFailures ?? 0
  const bump = (n: string) => (calls[n] = (calls[n] ?? 0) + 1)
  const caps = [
    capability({
      name: 'staff_list',
      audiences: ['org'],
      title: 'List staff',
      description: D('Lists the staff to import.'),
      permission: 'x',
      risk: 'R0',
      input: schema.object({ n: schema.integer({ min: 0, max: 10_000 }) }),
      version: 1,
      run: (_c, i) => {
        bump('staff_list')
        if (readFails > 0) {
          readFails--
          throw new Error('the database blinked')
        }
        return { rows: Array.from({ length: i.n }, (_, k) => ({ name: `person ${k}` })) }
      },
    }),
    capability({
      name: 'staff_add',
      audiences: ['org'],
      title: 'Add a staff member',
      description: D('Adds one staff member.'),
      permission: 'x',
      risk: 'R2',
      input: schema.object({ name: schema.text(80) }),
      version: 1,
      preview: (_c, i) => ({ summary: `add ${i.name}` }),
      run: (_c, i) => {
        bump('staff_add')
        if (o.failWrite) throw new Error('the mail server refused')
        added.push(i.name)
        return { added: i.name }
      },
    }),
  ]
  const reg = registry(caps)
  const guard = createGuard<Cx, string>({ registry: reg, can: (_c, _p, cap) => !o.deny?.includes(cap.name), secret: 'test-secret-test-secret-test-secret-0123', store: memoryGuardStore() })
  const answer = { text: '{"summary":"all good"}', output: { summary: 'all good' }, stop_reason: 'stop', model: 'm', usage: { input_tokens: 1000, output_tokens: 100 } }
  const ai = createAi<Cx>({
    omazy: () => ({ ai: { complete: async () => answer as never } }),
    runs: memoryRunStore(),
    prompts: promptTemplates({ 'tasks/summary': { 1: { en: 'Summarise.' } } }),
    guard,
    registry: reg,
    prices: { m: { input: 100, output: 200 }, converse: { input: 100, output: 200 } },
  })
  const store = memoryFlowStore()
  const handoffs: unknown[] = []
  const deps: FlowDeps = { ai, guard, registry: reg, store, roles: () => ['ops'], handoff: (_c, h) => void handoffs.push(h), notify: () => {} }
  const runner = memoryRunner(deps, [])
  const flows = createFlows({ store, runs: ai.runs, starter: runner })
  const ctx: Cx = { principal: { kind: 'member', id: 'u1' }, seat: { id: 's1', door: 'org', tenant: 'tA' }, tenant: 'tA', channel: 'console', approvalId: null, requestId: 'r1' }
  return { calls, added, reg, guard, ai, store, deps, runner, flows, ctx, handoffs }
}

describe('writes, reads and retries', () => {
  const wf = workflow({
    id: 'staff_import',
    version: 1,
    steps: [step.read('list', 'staff_list', { args: () => ({ n: 1 }) }), step.write('add', 'staff_add', { args: (s) => s.list.rows[0], confirm: 'upstream' })],
  })

  test('a write is never retried: it fails once and goes to a person', async () => {
    const p = product({ failWrite: true })
    await p.flows.start(p.ctx, wf, 'imp:1', { input: null })
    await p.runner.idle()
    expect(p.calls.staff_add).toBe(1)
    expect(p.runner.attempts('imp:1', 'add')).toBe(1)
    expect(await p.flows.run('imp:1')).toMatchObject({ status: 'waiting' })
    expect(p.handoffs).toMatchObject([{ step: 'add', kind: 'failed', waits: true }])
    const row = (await p.flows.steps('imp:1')).find((s) => s.key === 'add')!
    expect(row).toMatchObject({ status: 'failed' })
    // The person did it by hand and lets the run go on.
    await p.flows.resolve('imp:1', 'add', { action: 'continue', output: { added: 'by hand' } })
    await p.runner.idle()
    expect(await p.flows.run('imp:1')).toMatchObject({ status: 'ok' })
    expect(p.calls.staff_add).toBe(1)
  })

  test('a failed write nobody settles ends the run failed', async () => {
    const p = product({ failWrite: true })
    await p.flows.start(p.ctx, wf, 'imp:2', { input: null })
    await p.runner.advance(FLOW_LIMITS.resolveTimeoutMs)
    expect(await p.flows.run('imp:2')).toMatchObject({ status: 'failed' })
    expect((await p.ai.runs.getRun('imp:2'))!.outcome).toBe('error')
  })

  test('a read keeps its retries', async () => {
    const p = product({ readFailures: 2 })
    await p.flows.start(p.ctx, wf, 'imp:3', { input: null })
    await p.runner.idle()
    expect(p.calls.staff_list).toBe(3)
    expect(await p.flows.run('imp:3')).toMatchObject({ status: 'ok' })
    expect(p.added).toEqual(['person 0'])
  })

  test('dry run asks the guard: permission applies, and an unconfirmed R2 write is reported as going to a person', async () => {
    const p = product({ deny: ['staff_add'] })
    await p.flows.start(p.ctx, wf, 'dry:1', { input: null, mode: 'dry_run' })
    await p.runner.idle()
    expect(await p.flows.run('dry:1')).toMatchObject({ status: 'ok', report: ['add: would be refused (no_permission): You do not have permission to do this.'] })
    expect((await p.flows.steps('dry:1')).find((s) => s.key === 'add')).toMatchObject({ status: 'refused', code: 'no_permission', outcome: 'refused_permission', preview: true })
    expect(p.calls.staff_add).toBeUndefined()

    const q = product()
    const unconfirmed = workflow({ id: 'staff_import_raw', version: 1, steps: [step.write('add', 'staff_add', { args: () => ({ name: 'x' }) })] })
    await q.flows.start(q.ctx, unconfirmed, 'dry:2', { input: null, mode: 'dry_run' })
    await q.flows.start(q.ctx, wf, 'dry:3', { input: null, mode: 'dry_run' })
    await q.runner.idle()
    expect((await q.flows.run('dry:2'))!.report).toEqual(['add: would go to a person to confirm: add x'])
    expect((await q.flows.run('dry:3'))!.report).toEqual(['add: would add person 0'])
    expect(q.calls.staff_add).toBeUndefined()
  })

  test('an R2 write a person has not confirmed goes to a person', async () => {
    const p = product()
    const unconfirmed = workflow({ id: 'staff_import_raw', version: 1, steps: [step.write('add', 'staff_add', { args: () => ({ name: 'x' }) })] })
    await p.flows.start(p.ctx, unconfirmed, 'imp:4', { input: null })
    await p.runner.idle()
    expect(p.added).toEqual([])
    expect(p.handoffs).toMatchObject([{ step: 'add', kind: 'confirm' }])
    // The guard's row says what it asked for; the run's own row says why a workflow cannot give it.
    expect((await p.ai.runs.effects('imp:4')).map((e) => `${e.step}:${e.outcome}`)).toEqual(['add:confirm_required', 'add:refused'])
    expect((await p.flows.steps('imp:4'))[0]).toMatchObject({ status: 'refused', code: 'confirm_required', message: 'This change needs a person to confirm it; a workflow cannot.' })
  })
})

describe('bulk steps', () => {
  const bulk = (n: number, chunk = 50, maxSteps?: number) =>
    workflow({
      id: 'staff_bulk',
      version: 1,
      ...(maxSteps ? { maxSteps } : {}),
      steps: [step.read('list', 'staff_list', { args: () => ({ n }) }), step.bulk('add', 'staff_add', { items: (s) => s.list.rows, args: (r) => ({ name: r.name }), chunk, confirm: 'upstream' })],
    })

  test('items run in chunks, one durable step each', async () => {
    const p = product()
    await p.flows.start(p.ctx, bulk(230), 'bulk:1', { input: null })
    await p.runner.idle()
    const rows = (await p.flows.steps('bulk:1')).filter((s) => s.key.startsWith('add#'))
    expect(rows.map((r) => r.key)).toEqual(['add#1', 'add#2', 'add#3', 'add#4', 'add#5'])
    expect(rows.map((r) => r.message)).toEqual(['50 items: 50 done', '50 items: 50 done', '50 items: 50 done', '50 items: 50 done', '30 items: 30 done'])
    expect(p.calls.staff_add).toBe(230)
    expect(p.runner.attempts('bulk:1', 'add#5')).toBe(1)
    expect(await p.flows.run('bulk:1')).toMatchObject({ status: 'ok' })
  })

  test('a chunk with failed items goes to a person and the rest waits', async () => {
    const p = product({ failWrite: true })
    await p.flows.start(p.ctx, bulk(120), 'bulk:f', { input: null })
    await p.runner.idle()
    expect(p.calls.staff_add).toBe(50)
    expect(await p.flows.run('bulk:f')).toMatchObject({ status: 'waiting' })
    await p.flows.resolve('bulk:f', 'add#1', { action: 'stop' })
    await p.runner.idle()
    expect(await p.flows.run('bulk:f')).toMatchObject({ status: 'stopped' })
    expect(p.calls.staff_add).toBe(50)
  })

  test('dry run plans every item, chunk by chunk', async () => {
    const p = product()
    await p.flows.start(p.ctx, bulk(230), 'bulk:2', { input: null, mode: 'dry_run' })
    await p.runner.idle()
    const rows = (await p.flows.steps('bulk:2')).filter((s) => s.key.startsWith('add#'))
    expect(rows.length).toBe(5)
    expect(rows.every((r) => r.status === 'planned')).toBe(true)
    expect(rows.at(-1)!.message).toBe('30 items: 0 done, 30 planned')
    expect(p.calls.staff_add).toBeUndefined()
    expect((await p.flows.run('bulk:2'))!.report).toEqual(['add: would run staff_add on 230 items'])
  })

  test('more items than the run may take are refused before any runs', async () => {
    const p = product()
    await p.flows.start(p.ctx, bulk(500, 10, 20), 'bulk:3', { input: null })
    await p.runner.idle()
    expect((await p.flows.run('bulk:3'))!.status).toBe('stopped')
    expect(p.calls.staff_add).toBeUndefined()
  })
})

describe('tasks, conditions and nothing to report', () => {
  const summary = task({
    id: 'week_summary',
    version: 1,
    owner: 'ops',
    model: { use: 'converse' },
    prompt: { template: 'tasks/summary', version: 1, languages: ['en'] },
    context: { layers: ['unit'], budgetTokens: 2000 },
    memory: { read: [], write: [] },
    output: schema.object({ summary: schema.text(500) }),
    evals: 'evals/summary.jsonl',
    caps: { perRunUsd: 1, perDayUsd: 5 },
  })
  const weekly = workflow({
    id: 'weekly',
    version: 1,
    nothingToReport: (s) => s.list.rows.length === 0,
    steps: [step.read('list', 'staff_list', { args: (s) => ({ n: s.input.n }) }), step.task('sum', summary, { input: () => ({}) }), step.notify('tell', 'weekly_summary')],
  })

  test('a task step runs through the ai kit and its spend counts against the monthly budget', async () => {
    const p = product()
    const a = automation({ id: 'weekly', on: on.schedule('0 9 * * 0'), run: weekly, input: () => ({ n: 2 }), owner: 'ops', mode: 'live', budget: { usdPerMonth: 0.1 } })
    const autos = createAutomations({ automations: [a], store: p.store, starter: p.runner, roles: () => ['ops'] })
    await autos.enable(p.ctx, 'weekly')
    const sunday = Date.UTC(2026, 10, 8, 9, 0)
    expect(await autos.tick(sunday - 60_000)).toEqual([])
    const [r] = await autos.tick(sunday)
    expect(r!.outcome).toBe('started')
    await p.runner.idle()
    const run = (await p.store.getRun(r!.key!))!
    expect(run.status).toBe('ok')
    expect(run.costMicros).toBeGreaterThan(0)
    // The next Sunday: the month's budget is spent.
    const [r2] = await autos.tick(sunday + 7 * 86_400_000)
    expect(r2).toMatchObject({ outcome: 'refused_budget', reason: 'Budget spent: $0.12 of $0.1 this month.' })
  })

  test('nothing to report: notices are recorded, not delivered', async () => {
    const p = product()
    const sent: unknown[] = []
    p.deps.notify = (_c, n) => void sent.push(n)
    await p.flows.start(p.ctx, weekly, 'wk:1', { input: { n: 0 } })
    await p.runner.idle()
    expect(sent).toEqual([])
    expect((await p.flows.steps('wk:1')).find((s) => s.key === 'tell')).toMatchObject({ status: 'skipped', code: 'nothing_to_report' })
    expect(await p.flows.run('wk:1')).toMatchObject({ status: 'ok', reported: false })
  })

  test('a condition that finds nothing records a nothing run and starts none', async () => {
    const p = product()
    const trialEnding = automation({ id: 'trial_ending', on: on.condition('0 * * * *', async () => []), run: weekly, owner: 'ops' })
    const autos = createAutomations({ automations: [trialEnding], store: p.store, starter: p.runner, roles: () => ['ops'] })
    await autos.enable(p.ctx, 'trial_ending')
    const [r] = await autos.tick(Date.UTC(2026, 10, 24, 10, 0))
    expect(r!.outcome).toBe('nothing')
    expect(p.runner.instances.size).toBe(0)
    expect((await p.store.listRuns({ status: 'nothing' })).length).toBe(1)
  })
})

describe('cron', () => {
  test('reads five fields in UTC', () => {
    const c = cron('*/15 9-17 * * 1-5')
    expect(c.matches(Date.UTC(2026, 10, 24, 9, 30))).toBe(true)
    expect(c.matches(Date.UTC(2026, 10, 24, 9, 31))).toBe(false)
    expect(c.matches(Date.UTC(2026, 10, 29, 9, 30))).toBe(false)
    expect(cron('0 9 * * 7').matches(Date.UTC(2026, 10, 29, 9, 0))).toBe(true)
    expect(() => cron('0 9 * *')).toThrow(CronError)
    expect(() => cron('61 * * * *')).toThrow(CronError)
  })

  const minutesOfMatching = (c: ReturnType<typeof cron>, from: number, to: number) => {
    const out: string[] = []
    for (let t = from; t < to; t += 60_000) if (c.matches(t)) out.push(new Date(t).toISOString().slice(0, 16))
    return out
  }

  test('Sunday 09:00 in New York follows the clock across both daylight saving changes', () => {
    const c = cron('0 9 * * 0', { tz: 'America/New_York' })
    expect(c.tz).toBe('America/New_York')
    // 1 March 2026, EST (UTC-5); 8 March, the change to EDT (UTC-4).
    expect(c.matches(Date.UTC(2026, 2, 1, 14, 0))).toBe(true)
    expect(c.matches(Date.UTC(2026, 2, 1, 13, 0))).toBe(false)
    expect(c.matches(Date.UTC(2026, 2, 8, 13, 0))).toBe(true)
    expect(c.matches(Date.UTC(2026, 2, 8, 14, 0))).toBe(false)
    // 25 October, EDT; 1 November, the change back to EST.
    expect(c.matches(Date.UTC(2026, 9, 25, 13, 0))).toBe(true)
    expect(c.matches(Date.UTC(2026, 10, 1, 14, 0))).toBe(true)
    expect(c.matches(Date.UTC(2026, 10, 1, 13, 0))).toBe(false)
    // Each Sunday has exactly one 09:00.
    expect(minutesOfMatching(c, Date.UTC(2026, 2, 8, 0, 0), Date.UTC(2026, 2, 9, 0, 0))).toEqual(['2026-03-08T13:00'])
  })

  test('a time in the skipped hour does not occur; one in the repeated hour matches twice', () => {
    const skipped = cron('30 2 * * *', { tz: 'America/New_York' })
    expect(minutesOfMatching(skipped, Date.UTC(2026, 2, 8, 5, 0), Date.UTC(2026, 2, 9, 5, 0))).toEqual([])
    expect(minutesOfMatching(skipped, Date.UTC(2026, 2, 9, 5, 0), Date.UTC(2026, 2, 10, 5, 0))).toEqual(['2026-03-09T06:30'])
    const repeated = cron('30 1 * * *', { tz: 'America/New_York' })
    expect(minutesOfMatching(repeated, Date.UTC(2026, 10, 1, 4, 0), Date.UTC(2026, 10, 2, 4, 0))).toEqual(['2026-11-01T05:30', '2026-11-01T06:30'])
    expect(localMinute(Date.UTC(2026, 10, 1, 5, 30), 'America/New_York')).toBe(localMinute(Date.UTC(2026, 10, 1, 6, 30), 'America/New_York'))
  })

  test('Asia/Dhaka is UTC+6 all year, and its day changes before UTC does', () => {
    const sunday9 = cron('0 9 * * 0', { tz: 'Asia/Dhaka' })
    expect(sunday9.matches(Date.UTC(2026, 10, 8, 3, 0))).toBe(true)
    expect(sunday9.matches(Date.UTC(2026, 10, 8, 9, 0))).toBe(false)
    expect(sunday9.matches(Date.UTC(2026, 6, 5, 3, 0))).toBe(true)
    // Monday 00:00 in Dhaka is Sunday 18:00 UTC.
    const monday = cron('0 0 * * 1', { tz: 'Asia/Dhaka' })
    expect(monday.matches(Date.UTC(2026, 10, 8, 18, 0))).toBe(true)
    expect(monday.matches(Date.UTC(2026, 10, 9, 0, 0))).toBe(false)
    expect(localTime(Date.UTC(2026, 10, 8, 18, 0), 'Asia/Dhaka')).toEqual({ year: 2026, month: 11, day: 9, hour: 0, minute: 0, weekday: 1 })
    // The first of the month, read in the zone.
    expect(cron('0 0 1 * *', { tz: 'Asia/Dhaka' }).matches(Date.UTC(2026, 10, 30, 18, 0))).toBe(true)
  })

  test('an unknown zone is refused when the cron is made', () => {
    expect(() => cron('0 9 * * *', { tz: 'Mars/Olympus' })).toThrow(CronError)
    expect(() => on.schedule('0 9 * * *', { tz: 'Mars/Olympus' })).toThrow(CronError)
    expect(isTimeZone('Asia/Dhaka')).toBe(true)
    expect(isTimeZone('Asia/Dhaka ')).toBe(false)
  })
})

describe('schedules in tenant time', () => {
  const tell = workflow({ id: 'weekly_tell', version: 1, steps: [step.notify('tell', 'weekly_summary')] })
  const zones: Record<string, string> = { tA: 'Asia/Dhaka', tB: 'America/New_York', tC: 'Nowhere/Land' }
  const seat = (tenant: string): Cx => ({ principal: { kind: 'member', id: `u_${tenant}` }, seat: { id: `s_${tenant}`, door: 'org', tenant }, tenant, channel: 'console', approvalId: null, requestId: 'r' })

  test("Sunday 09:00 tenant time starts each tenant's run at its own 09:00", async () => {
    const p = product()
    const a = automation({ id: 'weekly_tell', on: on.schedule('0 9 * * 0', { tz: 'tenant' }), run: tell, owner: 'ops', mode: 'live' })
    expect(() => createAutomations({ automations: [a], store: p.store, starter: p.runner, roles: () => ['ops'] })).toThrow(/timeZone/)
    const autos = createAutomations({ automations: [a], store: p.store, starter: p.runner, roles: () => ['ops'], timeZone: (t) => zones[t ?? ''] })
    await autos.enable(seat('tA'), 'weekly_tell')
    await autos.enable(seat('tB'), 'weekly_tell')
    const at = (h: number, d = 8) => Date.UTC(2026, 10, d, h, 0)
    expect(await autos.tick(at(3))).toEqual([{ automation: 'weekly_tell', tenant: 'tA', outcome: 'started', key: 'weekly_tell:tA:2026-11-08T09:00' }])
    expect(await autos.tick(at(9))).toEqual([])
    expect(await autos.tick(at(14))).toEqual([{ automation: 'weekly_tell', tenant: 'tB', outcome: 'started', key: 'weekly_tell:tB:2026-11-08T09:00' }])
    await p.runner.idle()
    expect((await p.store.getRun('weekly_tell:tA:2026-11-08T09:00'))!.status).toBe('ok')
    // A tenant whose zone the runtime does not know runs nothing and says why.
    await autos.enable(seat('tC'), 'weekly_tell')
    expect((await autos.tick(at(3, 15))).map((r) => `${r.tenant}:${r.outcome}`)).toEqual(['tA:started', 'tC:bad_time_zone'])
  })

  test('the hour a daylight saving change repeats starts one run, not two', async () => {
    const p = product()
    const a = automation({ id: 'nightly', on: on.schedule('30 1 * * *', { tz: 'America/New_York' }), run: tell, owner: 'ops', mode: 'live' })
    const autos = createAutomations({ automations: [a], store: p.store, starter: p.runner, roles: () => ['ops'] })
    await autos.enable(seat('tB'), 'nightly')
    expect((await autos.tick(Date.UTC(2026, 10, 1, 5, 30)))[0]).toMatchObject({ outcome: 'started', key: 'nightly:tB:2026-11-01T01:30' })
    expect((await autos.tick(Date.UTC(2026, 10, 1, 6, 30)))[0]).toMatchObject({ outcome: 'exists', key: 'nightly:tB:2026-11-01T01:30' })
    expect(p.runner.instances.size).toBe(1)
  })
})

describe('Cloudflare instance ids', () => {
  test('keys Cloudflare refuses get a clean prefix and a hash', async () => {
    expect(await instanceIdFor('fulfil_pay-1')).toBe('fulfil_pay-1')
    const id = await instanceIdFor('fulfil:pay_1')
    expect(id).toMatch(/^fulfil-pay_1-[0-9a-f]{16}$/)
    expect(await instanceIdFor('fulfil:pay_1')).toBe(id)
    expect(await instanceIdFor('fulfil/pay_1')).not.toBe(id)
  })
})

// ---------------------------------------------------------------- D1

function d1(db: Database): D1DatabaseLike {
  const stmt = (sql: string, params: unknown[] = []): D1PreparedStatementLike & { exec(): { changes: number } } => ({
    bind: (...v: unknown[]) => stmt(sql, v),
    first: async <T>() => (db.query(sql).get(...(params as never[])) as T) ?? null,
    all: async <T>() => ({ success: true, results: db.query(sql).all(...(params as never[])) as T[] }),
    run: async () => ({ success: true, meta: { changes: db.query(sql).run(...(params as never[])).changes } }),
    exec: () => ({ changes: db.query(sql).run(...(params as never[])).changes }),
  })
  return {
    prepare: (sql) => stmt(sql),
    batch: async (stmts) => db.transaction(() => stmts.map((s) => ({ success: true, meta: { changes: (s as ReturnType<typeof stmt>).exec().changes } })))(),
  }
}

describe('D1 store', () => {
  test('the worked example runs end to end on D1', async () => {
    const raw = new Database(':memory:')
    const db = d1(raw)
    await applyFlowMigrations(db)
    await applyFlowMigrations(db)
    await applyAiMigrations(db)
    const tables = (raw.query("SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE 'flow_%' ORDER BY name").all() as { name: string }[]).map((t) => t.name)
    expect(tables).toEqual(['flow_automations', 'flow_links', 'flow_runs'])
    const w: World = world()
    w.tenants.set('tA', tenant())
    w.payments.set('pay_1', payment('pay_1'))
    const pending: Promise<unknown>[] = []
    const f = fulfilment({ w, store: d1FlowStore(db), runs: d1RunStore(db), waitUntil: (p) => pending.push(p) })
    await f.automations.enable(seats.finance(), 'payment_fulfil', { mode: 'live' })
    expect((await f.automations.dispatch(approveEvent('pay_1')))[0]!.outcome).toBe('started')
    expect((await f.automations.dispatch(approveEvent('pay_1')))[0]!.outcome).toBe('exists')
    await f.runner.idle()
    const steps = await f.flows.steps('fulfil:pay_1')
    const level = steps.find((s) => s.key === 'level')!
    expect(level.status).toBe('waiting')
    await decide({ ...f, settle: async () => {} } as never, level.approvalId!)
    for (let i = 0; i < 4; i++) {
      await Promise.all(pending.splice(0))
      await f.runner.idle()
    }
    const go = (await f.flows.steps('fulfil:pay_1')).find((s) => s.key === 'go_live')!
    await decide({ ...f, settle: async () => {} } as never, go.approvalId!)
    for (let i = 0; i < 4; i++) {
      await Promise.all(pending.splice(0))
      await f.runner.idle()
    }
    const run = await f.store.getRun('fulfil:pay_1')
    expect(run).toMatchObject({ status: 'ok', reported: true, mode: 'live' })
    expect(w.tenants.get('tA')).toMatchObject({ level: 'professional', status: 'live', basis: 'order', order_ref: 'INV-0042' })
    const final = await f.flows.steps('fulfil:pay_1')
    expect(final.map((s) => `${s.key}:${s.status}`)).toEqual([
      'check:ok',
      'tenant:ok',
      'order:ok',
      'invoice:skipped',
      'level:ok',
      'term:skipped',
      'checks:ok',
      'go_live:ok',
      'tell:ok',
    ])
    expect(final.find((s) => s.key === 'level')).toMatchObject({ outcome: 'ok', tier: 'R3', approvalId: level.approvalId })
    expect(level.outcome).toBe('pending_approval')
    expect(await f.store.usage({ automation: 'payment_fulfil', tenant: null, since: '2000-01-01' })).toEqual({ runs: 1, costMicros: 0 })
    expect((await f.store.listAutomations({ on: true })).length).toBe(1)
  })
})

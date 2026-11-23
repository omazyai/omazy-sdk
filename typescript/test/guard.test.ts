import { describe, expect, test } from 'bun:test'
import { type Ctx, defineCapabilities, registry, schema } from '../src/capabilities/index'
import {
  approver,
  codeStepUp,
  createGuard,
  type GuardOptions,
  GuardRefusal,
  memoryGuardStore,
  memoryRateLimiter,
  memoryRequestLog,
  memorySwitches,
  policies,
  REQUEST_ID_HEADER,
  requestIdFrom,
  type RequestLogSink,
  SYSTEM_PRINCIPAL_KIND,
  tighten,
  withRequestId,
} from '../src/guard/index'

type AppCtx = Ctx<{ locale: 'en' | 'bn' }>
type Perm = string
const kit = defineCapabilities<AppCtx, Perm, 'platform' | 'org'>()

// The product's world, in memory.
const state = { briefVersion: 'v1', deviceVersion: 'd1', tenantVersion: 't1' }
const runs: Record<string, unknown[]> = {}
const ran = (name: string, input: unknown) => {
  ;(runs[name] ??= []).push(input)
}
const owners: Record<string, string[]> = { dev_1: ['owner_a'] }

const D = (s: string) => `${s} This sentence pads the description so that it passes the eighty character minimum of the kit.`

const tenantsList = kit.capability({
  name: 'tenants_list',
  audiences: ['platform'],
  title: 'List tenants',
  description: D('Lists tenants.'),
  permission: 'tenants.read',
  risk: 'R0',
  input: schema.object({ limit: schema.integer({ min: 1, max: 100 }).default(10) }),
  version: 1,
  run: (_c, i) => ({ rows: [], limit: i.limit }),
})

const staffList = kit.capability({
  name: 'staff_list',
  audiences: ['org'],
  title: 'List staff',
  description: D('Lists staff with phone numbers.'),
  permission: 'staff.read',
  risk: 'R1',
  input: schema.object({ tenant_id: schema.id().optional() }),
  pii: ['rows.*.phone'],
  version: 1,
  run: () => ({ rows: [{ name: 'Rashed', phone: '+8801700000000' }] }),
})

const briefSave = kit.capability({
  name: 'brief_draft_save',
  audiences: ['org'],
  title: 'Save the brief draft',
  description: D('Saves a draft of the brief.'),
  permission: 'brief.write',
  risk: 'R2',
  input: schema.object({ text: schema.text(500) }),
  version: 1,
  preview: (_c, i) => ({ summary: `Save "${i.text}"`, stateVersion: state.briefVersion }),
  run: (_c, i) => {
    ran('brief_draft_save', i)
    state.briefVersion = `${state.briefVersion}+`
    return { saved: true }
  },
})

const deviceApprove = kit.capability({
  name: 'device_approve',
  audiences: ['org'],
  title: 'Approve a device',
  description: D('Approves a paired kiosk device for this tenant.'),
  permission: 'devices.write',
  risk: 'R3',
  approval: 'tenant_self',
  input: schema.object({ device_id: schema.id(), tenant_id: schema.id().optional() }),
  version: 1,
  preview: (_c, i) => ({ summary: `Approve ${i.device_id}`, stateVersion: state.deviceVersion }),
  run: (c, i) => {
    ran('device_approve', { ...i, approvalId: c.approvalId })
    return { approved: i.device_id, auditId: 'audit_1' }
  },
})

const paymentRecord = kit.capability({
  name: 'payment_record_manual_bank',
  audiences: ['platform'],
  title: 'Record a manual bank payment',
  description: D('Records a pending bank transfer. A second person approves it.'),
  permission: 'payments',
  risk: 'R3',
  approval: 'platform_four_eyes',
  input: schema.object({ tenant_id: schema.id(), amount: schema.minorUnits() }),
  version: 1,
  preview: (_c, i) => ({ summary: `Record ${i.amount}`, stateVersion: 'p1' }),
  run: (_c, i) => {
    ran('payment_record_manual_bank', i)
    return { id: 'pay_1' }
  },
})

const tenantDelete = kit.capability({
  name: 'tenant_delete',
  audiences: ['platform'],
  title: 'Delete a tenant',
  description: D('Deletes a tenant after a grace period.'),
  permission: 'tenants.delete',
  risk: 'R4',
  approval: 'super_admin_step_up',
  input: schema.object({ tenant_id: schema.id() }),
  version: 1,
  preview: (_c, i) => ({ summary: `Delete ${i.tenant_id}`, stateVersion: state.tenantVersion }),
  run: (_c, i) => {
    ran('tenant_delete', i)
    return { deleting: i.tenant_id }
  },
})

const flagSet = kit.capability({
  name: 'flag_set',
  audiences: ['platform'],
  title: 'Set a switch',
  description: D('Turns a kill switch on or off. Turning one off is never held for approval.'),
  permission: 'flags.write',
  risk: 'R3',
  riskFor: (i) => (i.enabled ? 'R3' : 'R2'),
  approval: 'platform_single',
  input: schema.object({ key: schema.text(80), enabled: schema.boolean() }),
  version: 1,
  preview: (_c, i) => ({ summary: `${i.enabled ? 'Turn on' : 'Turn off'} ${i.key}` }),
  run: (_c, i) => {
    ran('flag_set', i)
    return { key: i.key, on: i.enabled }
  },
})

const reg = registry([tenantsList, staffList, briefSave, deviceApprove, paymentRecord, tenantDelete, flagSet])

const perms: Record<string, string[]> = {
  member_a: ['staff.read', 'brief.write', 'devices.write'],
  owner_a: ['staff.read', 'brief.write', 'devices.write'],
  member_c: ['staff.read', 'devices.write'],
  admin_1: ['tenants.read', 'payments', 'flags.write'],
  finance_1: ['payments'],
  imran: ['tenants.read', 'tenants.delete', 'payments', 'flags.write'],
}
const roles: Record<string, string[]> = { admin_1: ['platform_admin'], finance_1: ['finance'], imran: ['super_admin', 'platform_admin'] }

const orgCtx = (id: string, tenant = 'tA'): AppCtx => ({
  principal: { kind: 'member', id },
  seat: { id: `seat_${id}`, door: 'org', tenant },
  tenant,
  channel: 'mcp',
  approvalId: null,
  requestId: `req_${id}_0001`,
  locale: 'en',
})
const platCtx = (id: string): AppCtx => ({
  principal: { kind: 'staff', id },
  seat: { id: `seat_${id}`, door: 'platform', tenant: null },
  tenant: null,
  channel: 'console',
  approvalId: null,
  requestId: `req_${id}_0001`,
  locale: 'en',
})

function setup(extra: Partial<GuardOptions<AppCtx, Perm>> = {}) {
  const store = memoryGuardStore()
  const log = memoryRequestLog()
  const switches = memorySwitches()
  const sent: { person: string; channel: string; code: string }[] = []
  const codes = codeStepUp<AppCtx>({ store, send: (c, channel, code) => void sent.push({ person: c.principal.id, channel, code }) })
  const twoChannel = codeStepUp<AppCtx>({ store, channels: ['email', 'phone'], send: (c, channel, code) => void sent.push({ person: c.principal.id, channel, code }) })
  const pending: Promise<unknown>[] = []
  const guard = createGuard<AppCtx, Perm>({
    registry: reg,
    can: (c, p) => (perms[c.principal.id] ?? []).includes(p),
    secret: 'test-secret-test-secret-test-secret-0123',
    store,
    policies: {
      tenant_self: policies.single({ approver: approver.authorOrRecordOwner(), stepUp: 'code', expires: '24h' }),
      platform_four_eyes: policies.fourEyes({ approver: approver.role(['platform_admin', 'finance']), stepUp: 'code', expires: '24h' }),
      platform_single: policies.single({ approver: approver.role('platform_admin'), stepUp: 'code', expires: '24h' }),
      super_admin_step_up: policies.single({ approver: approver.role('super_admin'), stepUp: ['passkey', 'two_channel'], typedTarget: true, expires: '1h' }),
    },
    recordOwner: (_c, _cap, input) => owners[(input as { device_id?: string }).device_id ?? ''] ?? [],
    rolesOf: (c) => roles[c.principal.id] ?? [],
    stepUp: [codes, twoChannel],
    switches,
    log,
    waitUntil: (p) => void pending.push(p),
    onError: () => {},
    ...extra,
  })
  const flush = () => Promise.all(pending.splice(0))
  /** Starts a code for the decider and returns the proof. */
  const prove = async (c: AppCtx, approvalId: string) => {
    const row = await guard.approval(approvalId)
    await codes.start(c, row!)
    return { method: 'code', codes: { email: sent.at(-1)!.code } }
  }
  return { guard, store, log, switches, sent, codes, twoChannel, flush, prove }
}

for (const k of Object.keys(runs)) delete runs[k]
const reset = () => {
  for (const k of Object.keys(runs)) delete runs[k]
  state.briefVersion = 'v1'
  state.deviceVersion = 'd1'
  state.tenantVersion = 't1'
}

describe('guard: reads', () => {
  test('R0 runs and R1 is masked by the pii fields', async () => {
    reset()
    const { guard } = setup()
    const r0 = await guard.call(platCtx('admin_1'), 'tenants_list', {})
    expect(r0).toMatchObject({ outcome: 'ok', tier: 'R0', result: { limit: 10 } })
    const r1 = await guard.call(orgCtx('member_a'), 'staff_list', {})
    expect(r1.outcome).toBe('ok')
    expect(r1.outcome === 'ok' && r1.result).toEqual({ rows: [{ name: 'Rashed', phone: '[redacted]' }] })
  })

  test('a product mask hook replaces the default', async () => {
    const { guard } = setup({ mask: (_c, _cap, r) => ({ masked: true, r }) })
    const r1 = await guard.call(orgCtx('member_a'), 'staff_list', {})
    expect(r1.outcome === 'ok' && (r1.result as { masked: boolean }).masked).toBe(true)
  })

  test('unknown tools and bad arguments are invalid', async () => {
    const { guard } = setup()
    expect(await guard.call(platCtx('admin_1'), 'nope_list', {})).toMatchObject({ outcome: 'invalid', code: 'unknown_tool' })
    expect(await guard.call(platCtx('admin_1'), 'tenants_list', { limit: 500 })).toMatchObject({ outcome: 'invalid', code: 'invalid_arguments' })
    expect(await guard.call(platCtx('admin_1'), 'tenants_list', { extra: 1 })).toMatchObject({ outcome: 'invalid' })
  })

  test('permission is checked live on every call', async () => {
    const { guard } = setup()
    expect(await guard.call(orgCtx('stranger'), 'staff_list', {})).toMatchObject({ outcome: 'refused_permission', code: 'no_permission' })
  })
})

describe('guard: tenant isolation', () => {
  test('a tenant A seat with tenant B ids is refused', async () => {
    reset()
    const { guard } = setup()
    expect(await guard.call(orgCtx('member_a'), 'staff_list', { tenant_id: 'tB' })).toMatchObject({ outcome: 'refused_permission', code: 'cross_tenant' })
    expect(await guard.call(orgCtx('member_a'), 'staff_list', { tenant_id: 'tA' })).toMatchObject({ outcome: 'ok' })
  })

  test('record ids from another tenant are refused through tenantsOf', async () => {
    reset()
    const { guard, store } = setup({ tenantsOf: (_c, _cap, i) => ((i as { device_id?: string }).device_id === 'dev_b' ? ['tB'] : []) })
    expect(await guard.call(orgCtx('member_a'), 'device_approve', { device_id: 'dev_b' })).toMatchObject({ outcome: 'refused_permission', code: 'cross_tenant' })
    expect(store.approvals.size).toBe(0)
  })

  test('a ctx whose tenant differs from its seat is refused', async () => {
    const { guard } = setup()
    const c = { ...orgCtx('member_a'), tenant: 'tB' }
    expect(await guard.call(c, 'staff_list', {})).toMatchObject({ outcome: 'refused_permission', code: 'cross_tenant' })
  })

  test('a decider from tenant B cannot decide a tenant A request', async () => {
    reset()
    const { guard, prove } = setup()
    const p = await guard.call(orgCtx('member_a'), 'device_approve', { device_id: 'dev_1' })
    if (p.outcome !== 'pending_approval') throw new Error(p.outcome)
    const b = orgCtx('member_a', 'tB')
    expect(await guard.decide(p.approval.id, b, { approve: true, proof: await prove(b, p.approval.id) })).toMatchObject({ outcome: 'not_allowed' })
  })
})

describe('guard: tiers and switches', () => {
  test('a seat capped at R2 is refused an R3 call', async () => {
    const { guard } = setup({ maxTier: () => 'R2' })
    expect(await guard.call(orgCtx('member_a'), 'device_approve', { device_id: 'dev_1' })).toMatchObject({ outcome: 'refused_tier' })
  })

  test('read-only reach rules refuse writes and let reads through', async () => {
    reset()
    const { guard } = setup({ readOnly: () => 'This tenant is live; the platform door reads only.' })
    expect(await guard.call(orgCtx('member_a'), 'brief_draft_save', { text: 'hi' })).toMatchObject({
      outcome: 'read_only',
      message: 'This tenant is live; the platform door reads only.',
    })
    expect((await guard.call(orgCtx('member_a'), 'staff_list', {})).outcome).toBe('ok')
  })

  test('a global switch off wins over a tenant switch on', async () => {
    const { guard, switches } = setup()
    await switches.set({ key: 'door:org', scope: 'tenant', subject: 'tA', on: true })
    await switches.set({ key: 'door:org', scope: 'global', subject: null, on: false, reason: 'The org door is closed for maintenance.' })
    const r = await guard.call(orgCtx('member_a'), 'staff_list', {})
    expect(r).toMatchObject({ outcome: 'switched_off', switch: { key: 'door:org', scope: 'global' }, message: 'The org door is closed for maintenance.' })
  })

  test('switches are read on every call, with no cache', async () => {
    const { guard, switches } = setup()
    expect((await guard.call(orgCtx('member_a'), 'staff_list', {})).outcome).toBe('ok')
    await switches.set({ key: 'all', scope: 'person', subject: 'member_a', on: false })
    expect((await guard.call(orgCtx('member_a'), 'staff_list', {})).outcome).toBe('switched_off')
    expect((await guard.call(orgCtx('owner_a'), 'staff_list', {})).outcome).toBe('ok')
    await switches.set({ key: 'all', scope: 'person', subject: 'member_a', on: true })
    expect((await guard.call(orgCtx('member_a'), 'staff_list', {})).outcome).toBe('ok')
  })

  test('tenant and unit switches, and the product keys', async () => {
    const { guard, switches } = setup({ switchKeys: (c) => (c.channel === 'copilot' ? ['ai.off'] : []) })
    await switches.set({ key: 'ai.off', scope: 'global', subject: null, on: false })
    expect((await guard.call(orgCtx('member_a'), 'staff_list', {})).outcome).toBe('ok')
    expect((await guard.call({ ...orgCtx('member_a'), channel: 'copilot' }, 'staff_list', {})).outcome).toBe('switched_off')
    await switches.set({ key: 'unit:mcp', scope: 'tenant', subject: 'tB', on: false })
    expect((await guard.call(orgCtx('member_a'), 'staff_list', {})).outcome).toBe('ok')
    expect((await guard.call(orgCtx('member_x', 'tB'), 'staff_list', {})).outcome).toBe('switched_off')
  })

  test('a switch store that fails stops the call', async () => {
    const { guard } = setup({ switches: { read: async () => Promise.reject(new Error('db down')), set: async () => {}, list: async () => [] } })
    expect(await guard.call(orgCtx('member_a'), 'staff_list', {})).toMatchObject({ outcome: 'error', code: 'hook_failed' })
  })

  test('turning a switch off is a confirm, never held for approval; turning it on is', async () => {
    reset()
    const { guard, switches } = setup({ switchExempt: ['flag_set'] })
    await switches.set({ key: 'all', scope: 'global', subject: null, on: false })
    const off = await guard.call(platCtx('admin_1'), 'flag_set', { key: 'ai.off', enabled: false })
    expect(off.outcome).toBe('confirm_required')
    const on = await guard.call(platCtx('admin_1'), 'flag_set', { key: 'ai.off', enabled: true })
    expect(on.outcome).toBe('pending_approval')
  })

  test('rate limits per seat by mode', async () => {
    const { guard } = setup({ rateLimit: memoryRateLimiter({ perSeat: { read: 2, write: 1 } }) })
    const c = orgCtx('member_a')
    expect((await guard.call(c, 'staff_list', {})).outcome).toBe('ok')
    expect((await guard.call(c, 'staff_list', {})).outcome).toBe('ok')
    const r = await guard.call(c, 'staff_list', {})
    expect(r).toMatchObject({ outcome: 'rate_limited' })
    expect(r.outcome === 'rate_limited' && r.retryAfter! > 0).toBe(true)
    expect((await guard.call(c, 'brief_draft_save', { text: 'x' })).outcome).toBe('confirm_required')
  })
})

describe('guard: confirm tokens (R2)', () => {
  test('preview, then run once with the token', async () => {
    reset()
    const { guard } = setup()
    const c = orgCtx('member_a')
    const first = await guard.call(c, 'brief_draft_save', { text: 'hello' })
    if (first.outcome !== 'confirm_required') throw new Error(first.outcome)
    expect(first.preview.summary).toBe('Save "hello"')
    expect(runs.brief_draft_save).toBeUndefined()
    const second = await guard.call(c, 'brief_draft_save', { text: 'hello' }, { confirmToken: first.token })
    expect(second.outcome).toBe('ok')
    expect(runs.brief_draft_save).toHaveLength(1)
  })

  test('single use', async () => {
    reset()
    const { guard } = setup()
    const c = orgCtx('member_a')
    const first = await guard.call(c, 'brief_draft_save', { text: 'hello' })
    if (first.outcome !== 'confirm_required') throw new Error(first.outcome)
    await guard.call(c, 'brief_draft_save', { text: 'hello' }, { confirmToken: first.token })
    // The state moved, so put it back to show the nonce alone refuses the replay.
    state.briefVersion = 'v1'
    expect(await guard.call(c, 'brief_draft_save', { text: 'hello' }, { confirmToken: first.token })).toMatchObject({ outcome: 'invalid', code: 'confirm_used' })
    expect(runs.brief_draft_save).toHaveLength(1)
  })

  test('bound to the arguments, the tool and the seat', async () => {
    reset()
    const { guard } = setup()
    const c = orgCtx('member_a')
    const first = await guard.call(c, 'brief_draft_save', { text: 'hello' })
    if (first.outcome !== 'confirm_required') throw new Error(first.outcome)
    expect(await guard.call(c, 'brief_draft_save', { text: 'HELLO' }, { confirmToken: first.token })).toMatchObject({ code: 'confirm_mismatch' })
    expect(await guard.call(orgCtx('owner_a'), 'brief_draft_save', { text: 'hello' }, { confirmToken: first.token })).toMatchObject({ code: 'confirm_mismatch' })
    expect(await guard.call(c, 'brief_draft_save', { text: 'hello' }, { confirmToken: `${first.token}x` })).toMatchObject({ code: 'confirm_bad' })
    expect(runs.brief_draft_save).toBeUndefined()
    // Still good for the right arguments: a mismatch does not spend it.
    expect((await guard.call(c, 'brief_draft_save', { text: 'hello' }, { confirmToken: first.token })).outcome).toBe('ok')
  })

  test('stale when the target changed', async () => {
    reset()
    const { guard } = setup()
    const c = orgCtx('member_a')
    const first = await guard.call(c, 'brief_draft_save', { text: 'hello' })
    if (first.outcome !== 'confirm_required') throw new Error(first.outcome)
    state.briefVersion = 'v2'
    expect(await guard.call(c, 'brief_draft_save', { text: 'hello' }, { confirmToken: first.token })).toMatchObject({ outcome: 'stale' })
    expect(runs.brief_draft_save).toBeUndefined()
  })

  test('expires after ten minutes', async () => {
    reset()
    let t = 1_000_000
    const { guard } = setup({ now: () => t })
    const c = orgCtx('member_a')
    const first = await guard.call(c, 'brief_draft_save', { text: 'hello' })
    if (first.outcome !== 'confirm_required') throw new Error(first.outcome)
    t += 10 * 60_000 + 1
    expect(await guard.call(c, 'brief_draft_save', { text: 'hello' }, { confirmToken: first.token })).toMatchObject({ code: 'confirm_expired' })
  })

  test('a token signed with a previous secret still works during rotation', async () => {
    reset()
    const old = 'old-secret-old-secret-old-secret-0123456'
    const a = setup({ secret: old })
    const first = await a.guard.call(orgCtx('member_a'), 'brief_draft_save', { text: 'r' })
    if (first.outcome !== 'confirm_required') throw new Error(first.outcome)
    const b = setup({ secret: { current: 'new-secret-new-secret-new-secret-0123456', previous: [old] }, store: a.store })
    expect((await b.guard.call(orgCtx('member_a'), 'brief_draft_save', { text: 'r' }, { confirmToken: first.token })).outcome).toBe('ok')
  })
})

describe('guard: approvals (R3, R4)', () => {
  test('no R3 runs on the call: it creates a waiting approval', async () => {
    reset()
    const { guard, store } = setup({ reviewUrl: (a) => `https://admin.example/approvals/${a.id}` })
    const p = await guard.call(orgCtx('member_a'), 'device_approve', { device_id: 'dev_1' })
    if (p.outcome !== 'pending_approval') throw new Error(p.outcome)
    expect(p.approval.reviewUrl).toContain(p.approval.id)
    expect(p.approval.decider).toContain("requester or the record's owner")
    expect(runs.device_approve).toBeUndefined()
    const row = store.approvals.get(p.approval.id)!
    expect(row).toMatchObject({ status: 'waiting', action: 'device_approve', tenant: 'tA', policy: 'tenant_self', stateVersion: 'd1' })
    expect(row.argsSealed).not.toContain('dev_1')
    expect(await guard.approvalArgs(p.approval.id)).toEqual({ device_id: 'dev_1' })
  })

  test('no R3 or R4 runs without step-up', async () => {
    reset()
    const { guard } = setup()
    const p = await guard.call(orgCtx('member_a'), 'device_approve', { device_id: 'dev_1' })
    if (p.outcome !== 'pending_approval') throw new Error(p.outcome)
    expect(await guard.decide(p.approval.id, orgCtx('member_a'), { approve: true })).toMatchObject({ outcome: 'step_up_required', methods: ['code'] })
    expect(await guard.decide(p.approval.id, orgCtx('member_a'), { approve: true, proof: { method: 'code', codes: { email: '000000' } } })).toMatchObject({
      outcome: 'step_up_failed',
    })
    expect(await guard.decide(p.approval.id, orgCtx('member_a'), { approve: true, proof: { method: 'passkey' } })).toMatchObject({ outcome: 'step_up_failed' })
    expect(await guard.execute(p.approval.id)).toMatchObject({ outcome: 'refused_permission', code: 'not_approved' })
    expect(runs.device_approve).toBeUndefined()
  })

  test('a policy without step-up is refused at the call', async () => {
    const { guard } = setup({
      policies: { tenant_self: { approver: approver.authorOrRecordOwner(), fourEyes: false, stepUp: [], expiresMs: 1000, typedTarget: false } },
    })
    expect(await guard.call(orgCtx('member_a'), 'device_approve', { device_id: 'dev_1' })).toMatchObject({ outcome: 'error', code: 'no_policy' })
  })

  test('the author decides after step-up, and only the stored arguments run', async () => {
    reset()
    const { guard, prove } = setup()
    const a = orgCtx('member_a')
    const p = await guard.call(a, 'device_approve', { device_id: 'dev_1' })
    if (p.outcome !== 'pending_approval') throw new Error(p.outcome)
    const d = await guard.decide(p.approval.id, a, { approve: true, proof: await prove(a, p.approval.id) })
    if (d.outcome !== 'approved') throw new Error(d.outcome)
    expect(d.execution).toMatchObject({ outcome: 'ok', result: { approved: 'dev_1' }, approvalId: p.approval.id })
    expect(runs.device_approve).toEqual([{ device_id: 'dev_1', approvalId: p.approval.id }])
    expect(d.approval).toMatchObject({ status: 'executed', verification: 'code', auditId: 'audit_1', decider: { id: 'member_a' } })
  })

  test('the record owner may decide; a third member may not', async () => {
    reset()
    const { guard, prove } = setup()
    const p = await guard.call(orgCtx('member_a'), 'device_approve', { device_id: 'dev_1' })
    if (p.outcome !== 'pending_approval') throw new Error(p.outcome)
    const c = orgCtx('member_c')
    expect(await guard.canDecide(p.approval.id, c)).toMatchObject({ ok: false })
    expect(await guard.decide(p.approval.id, c, { approve: true, proof: await prove(c, p.approval.id) })).toMatchObject({ outcome: 'not_allowed' })
    const o = orgCtx('owner_a')
    expect(await guard.canDecide(p.approval.id, o)).toEqual({ ok: true })
    expect((await guard.decide(p.approval.id, o, { approve: true, proof: await prove(o, p.approval.id) })).outcome).toBe('approved')
  })

  test('four eyes: the requester cannot decide a payment, another person can', async () => {
    reset()
    const { guard, prove } = setup()
    const admin = platCtx('admin_1')
    const p = await guard.call(admin, 'payment_record_manual_bank', { tenant_id: 'tA', amount: 50000 })
    if (p.outcome !== 'pending_approval') throw new Error(p.outcome)
    expect(await guard.decide(p.approval.id, admin, { approve: true, proof: await prove(admin, p.approval.id) })).toMatchObject({
      outcome: 'not_allowed',
      message: 'Someone other than the requester must decide this.',
    })
    expect(runs.payment_record_manual_bank).toBeUndefined()
    const fin = platCtx('finance_1')
    const d = await guard.decide(p.approval.id, fin, { approve: true, proof: await prove(fin, p.approval.id) })
    expect(d.outcome).toBe('approved')
    expect(runs.payment_record_manual_bank).toEqual([{ tenant_id: 'tA', amount: 50000 }])
  })

  test('a proof for one approval does not decide another', async () => {
    reset()
    const { guard, prove } = setup()
    const a = orgCtx('member_a')
    const p1 = await guard.call(a, 'device_approve', { device_id: 'dev_1' })
    const p2 = await guard.call(a, 'device_approve', { device_id: 'dev_2' })
    if (p1.outcome !== 'pending_approval' || p2.outcome !== 'pending_approval') throw new Error('not pending')
    const proof1 = await prove(a, p1.approval.id)
    expect(await guard.decide(p2.approval.id, a, { approve: true, proof: proof1 })).toMatchObject({ outcome: 'step_up_failed' })
  })

  test('codes lock after too many wrong attempts', async () => {
    reset()
    const { guard, codes } = setup()
    const a = orgCtx('member_a')
    const p = await guard.call(a, 'device_approve', { device_id: 'dev_1' })
    if (p.outcome !== 'pending_approval') throw new Error(p.outcome)
    await codes.start(a, (await guard.approval(p.approval.id))!)
    for (let i = 0; i < 5; i++) await guard.decide(p.approval.id, a, { approve: true, proof: { method: 'code', codes: { email: 'bad' } } })
    const r = await guard.decide(p.approval.id, a, { approve: true, proof: { method: 'code', codes: { email: 'bad' } } })
    expect(r.outcome === 'step_up_failed' && r.message).toContain('too many')
  })

  test('a refusal needs a reason, and is a compare-and-swap', async () => {
    reset()
    const { guard, prove } = setup()
    const a = orgCtx('member_a')
    const p = await guard.call(a, 'device_approve', { device_id: 'dev_1' })
    if (p.outcome !== 'pending_approval') throw new Error(p.outcome)
    expect(await guard.decide(p.approval.id, a, { approve: false })).toEqual({ outcome: 'reason_required' })
    expect(await guard.decide(p.approval.id, a, { approve: false, reason: 'Not our device.' })).toMatchObject({ outcome: 'refused', approval: { reason: 'Not our device.' } })
    expect(await guard.decide(p.approval.id, a, { approve: true, proof: await prove(a, p.approval.id) })).toMatchObject({ outcome: 'already_decided' })
    expect(runs.device_approve).toBeUndefined()
  })

  test('two deciders at once: one wins, it runs once', async () => {
    reset()
    const { guard, prove } = setup()
    const a = orgCtx('member_a')
    const o = orgCtx('owner_a')
    const p = await guard.call(a, 'device_approve', { device_id: 'dev_1' })
    if (p.outcome !== 'pending_approval') throw new Error(p.outcome)
    const [pa, po] = [await prove(a, p.approval.id), await prove(o, p.approval.id)]
    const [x, y] = await Promise.all([guard.decide(p.approval.id, a, { approve: true, proof: pa }), guard.decide(p.approval.id, o, { approve: true, proof: po })])
    expect([x.outcome, y.outcome].sort()).toEqual(['already_decided', 'approved'])
    expect(runs.device_approve).toHaveLength(1)
  })

  test('expiry: a late decision is refused and the sweep marks the rest', async () => {
    reset()
    let t = 5_000_000
    const { guard, prove } = setup({ now: () => t })
    const a = orgCtx('member_a')
    const p1 = await guard.call(a, 'device_approve', { device_id: 'dev_1' })
    const p2 = await guard.call(a, 'device_approve', { device_id: 'dev_2' })
    if (p1.outcome !== 'pending_approval' || p2.outcome !== 'pending_approval') throw new Error('not pending')
    t += 24 * 3_600_000 + 1
    expect(await guard.decide(p1.approval.id, a, { approve: true, proof: await prove(a, p1.approval.id) })).toMatchObject({ outcome: 'expired' })
    expect(await guard.expireDue()).toBe(1)
    expect((await guard.approval(p2.approval.id))?.status).toBe('expired')
    expect(runs.device_approve).toBeUndefined()
  })

  test('stale when the target changed between request and decision', async () => {
    reset()
    const { guard, prove } = setup()
    const a = orgCtx('member_a')
    const p = await guard.call(a, 'device_approve', { device_id: 'dev_1' })
    if (p.outcome !== 'pending_approval') throw new Error(p.outcome)
    state.deviceVersion = 'd2'
    const d = await guard.decide(p.approval.id, a, { approve: true, proof: await prove(a, p.approval.id) })
    expect(d.outcome === 'approved' && d.execution.outcome).toBe('stale')
    expect((await guard.approval(p.approval.id))?.status).toBe('stale')
    expect(runs.device_approve).toBeUndefined()
  })

  test('execution re-checks the requester as of now', async () => {
    reset()
    const { guard, prove } = setup()
    const a = orgCtx('member_c')
    owners.dev_9 = ['owner_a']
    const p = await guard.call(a, 'device_approve', { device_id: 'dev_9' })
    if (p.outcome !== 'pending_approval') throw new Error(p.outcome)
    const saved = perms.member_c
    perms.member_c = []
    try {
      const o = orgCtx('owner_a')
      const d = await guard.decide(p.approval.id, o, { approve: true, proof: await prove(o, p.approval.id) })
      expect(d.outcome === 'approved' && d.execution).toMatchObject({ outcome: 'refused_permission', code: 'no_permission' })
      expect(runs.device_approve).toBeUndefined()
    } finally {
      perms.member_c = saved!
    }
  })

  test('execution is idempotent on the approval id', async () => {
    reset()
    const { guard, prove } = setup()
    const a = orgCtx('member_a')
    const p = await guard.call(a, 'device_approve', { device_id: 'dev_1' })
    if (p.outcome !== 'pending_approval') throw new Error(p.outcome)
    await guard.decide(p.approval.id, a, { approve: true, proof: await prove(a, p.approval.id) })
    const again = await guard.execute(p.approval.id)
    const third = await guard.execute(p.approval.id)
    expect(again).toMatchObject({ outcome: 'ok', result: { approved: 'dev_1' } })
    expect(third.outcome).toBe('ok')
    expect(runs.device_approve).toHaveLength(1)
  })

  test('sealed arguments that were changed in the store never run', async () => {
    reset()
    const { guard, store, prove } = setup()
    const a = orgCtx('member_a')
    const p1 = await guard.call(a, 'device_approve', { device_id: 'dev_1' })
    const p2 = await guard.call(a, 'device_approve', { device_id: 'dev_2' })
    if (p1.outcome !== 'pending_approval' || p2.outcome !== 'pending_approval') throw new Error('not pending')
    // Copy approval 2's sealed arguments into approval 1: the seal is bound to the id.
    store.approvals.get(p1.approval.id)!.argsSealed = store.approvals.get(p2.approval.id)!.argsSealed
    await expect(prove(a, p1.approval.id).then((proof) => guard.decide(p1.approval.id, a, { approve: true, proof }))).rejects.toThrow()
    expect(runs.device_approve).toBeUndefined()
  })

  test('R4: one super admin, two channels, a typed target', async () => {
    reset()
    const { guard, twoChannel, sent } = setup()
    const imran = platCtx('imran')
    const p = await guard.call(imran, 'tenant_delete', { tenant_id: 'tA' })
    if (p.outcome !== 'pending_approval') throw new Error(p.outcome)
    await twoChannel.start(imran, (await guard.approval(p.approval.id))!)
    const [email, phone] = sent.slice(-2)
    const proof = { method: 'two_channel', codes: { email: email!.code, phone: phone!.code } }
    expect(await guard.decide(p.approval.id, imran, { approve: true, proof, typedTarget: 'tB' })).toEqual({ outcome: 'typed_target_mismatch' })
    expect(await guard.decide(p.approval.id, platCtx('admin_1'), { approve: true, proof, typedTarget: 'tA' })).toMatchObject({ outcome: 'not_allowed' })
    const d = await guard.decide(p.approval.id, imran, { approve: true, proof, typedTarget: 'tA' })
    expect(d.outcome).toBe('approved')
    expect(runs.tenant_delete).toEqual([{ tenant_id: 'tA' }])
  })

  test('a code for one channel is not enough for two-channel step-up', async () => {
    reset()
    const { guard, twoChannel, sent } = setup()
    const imran = platCtx('imran')
    const p = await guard.call(imran, 'tenant_delete', { tenant_id: 'tA' })
    if (p.outcome !== 'pending_approval') throw new Error(p.outcome)
    await twoChannel.start(imran, (await guard.approval(p.approval.id))!)
    const email = sent.at(-2)!
    expect(await guard.decide(p.approval.id, imran, { approve: true, proof: { method: 'two_channel', codes: { email: email.code } }, typedTarget: 'tA' })).toMatchObject({
      outcome: 'step_up_failed',
    })
  })

  test('a tenant may tighten a policy, never loosen it', async () => {
    reset()
    const loose = policies.single({ approver: approver.role('anyone'), stepUp: ['code', 'none'], expires: '30d' })
    const strict = policies.fourEyes({ approver: approver.authorOrRecordOwner(), stepUp: 'code', expires: '1h' })
    const { guard, prove } = setup({ tenantPolicy: (t) => (t === 'tA' ? strict : t === 'tB' ? loose : null) })
    const tightA = await guard.policyFor('tenant_self', 'tA')
    expect(tightA).toMatchObject({ fourEyes: true, expiresMs: 3_600_000, stepUp: ['code'] })
    const tightB = await guard.policyFor('tenant_self', 'tB')
    expect(tightB).toMatchObject({ fourEyes: false, expiresMs: 86_400_000, stepUp: ['code'] })
    // In tA the author may no longer decide; the record owner, a second person, may.
    const a = orgCtx('member_a')
    const p = await guard.call(a, 'device_approve', { device_id: 'dev_1' })
    if (p.outcome !== 'pending_approval') throw new Error(p.outcome)
    expect((await guard.decide(p.approval.id, a, { approve: true, proof: await prove(a, p.approval.id) })).outcome).toBe('not_allowed')
    const o = orgCtx('owner_a')
    expect((await guard.decide(p.approval.id, o, { approve: true, proof: await prove(o, p.approval.id) })).outcome).toBe('approved')
    // In tB the "anyone" role does not widen who decides: both rules must hold.
    expect(tighten(policies.single({ approver: approver.role('x'), stepUp: 'code', expires: '1h' }), loose).approver.kind).toBe('all')
  })

  test('notices go to the product hook and never fail a call', async () => {
    reset()
    const events: string[] = []
    const { guard, flush, prove } = setup({
      onApproval: (e) => {
        events.push(e.type)
        if (e.type === 'requested') throw new Error('slack is down')
      },
    })
    const a = orgCtx('member_a')
    const p = await guard.call(a, 'device_approve', { device_id: 'dev_1' })
    expect(p.outcome).toBe('pending_approval')
    if (p.outcome !== 'pending_approval') return
    await guard.decide(p.approval.id, a, { approve: true, proof: await prove(a, p.approval.id) })
    await flush()
    expect(events).toEqual(['requested', 'decided', 'executed'])
  })

  test('withdraw: only the requester or the system, only while it waits, logged, with an event', async () => {
    reset()
    const events: { type: string; status: string; by?: string }[] = []
    const { guard, flush, prove, log } = setup({ onApproval: (e) => void events.push({ type: e.type, status: e.approval.status, ...('ctx' in e ? { by: e.ctx.principal.id } : {}) }) })
    const a = orgCtx('member_a')
    const p = await guard.call(a, 'device_approve', { device_id: 'dev_1' })
    if (p.outcome !== 'pending_approval') throw new Error(p.outcome)
    const id = p.approval.id
    // Not someone else, not the same id in another tenant, not a decider, and not without a reason.
    expect(await guard.withdraw(id, orgCtx('member_b'), 'mine now')).toMatchObject({ outcome: 'not_allowed' })
    expect(await guard.withdraw(id, orgCtx('member_a', 'tB'), 'other tenant')).toMatchObject({ outcome: 'not_allowed' })
    expect(await guard.withdraw(id, orgCtx('owner_a'), 'owner')).toMatchObject({ outcome: 'not_allowed' })
    expect(await guard.withdraw(id, { ...a, principal: { kind: 'service', id: 'member_a' } }, 'same id, other kind')).toMatchObject({ outcome: 'not_allowed' })
    expect(await guard.withdraw(id, a, '   ')).toEqual({ outcome: 'reason_required' })
    expect(await guard.withdraw('apr_none', a, 'gone')).toEqual({ outcome: 'not_found' })
    // The requester takes it back.
    const w = await guard.withdraw(id, a, 'another call in the same batch was refused')
    expect(w).toMatchObject({ outcome: 'withdrawn', approval: { status: 'withdrawn', reason: 'another call in the same batch was refused' } })
    // Nobody can decide it now, and it never runs.
    const o = orgCtx('owner_a')
    expect(await guard.canDecide(id, o)).toMatchObject({ ok: false })
    expect((await guard.decide(id, o, { approve: true, proof: await prove(o, id) })).outcome).toBe('already_decided')
    expect(await guard.execute(id)).toMatchObject({ outcome: 'refused_permission', code: 'not_approved' })
    expect(runs.device_approve).toBeUndefined()
    // A second withdrawal is a no-op.
    expect(await guard.withdraw(id, a, 'again')).toMatchObject({ outcome: 'already_decided' })
    // An approved one cannot be withdrawn.
    const q = await guard.call(a, 'device_approve', { device_id: 'dev_2' })
    if (q.outcome !== 'pending_approval') throw new Error(q.outcome)
    expect((await guard.decide(q.approval.id, a, { approve: true, proof: await prove(a, q.approval.id) })).outcome).toBe('approved')
    expect(await guard.withdraw(q.approval.id, a, 'too late')).toMatchObject({ outcome: 'already_decided' })
    expect(runs.device_approve).toMatchObject([{ device_id: 'dev_2' }])
    // The system may withdraw any waiting approval of its tenant; a null tenant reaches every tenant.
    const r = await guard.call(a, 'device_approve', { device_id: 'dev_3' })
    if (r.outcome !== 'pending_approval') throw new Error(r.outcome)
    const system = (tenant: string | null): AppCtx => ({ principal: { kind: SYSTEM_PRINCIPAL_KIND, id: 'cleanup' }, seat: null, tenant, channel: 'automation', approvalId: null, requestId: 'req_sys_0001' })
    expect(await guard.withdraw(r.approval.id, system('tB'), 'wrong tenant')).toMatchObject({ outcome: 'not_allowed' })
    expect(await guard.withdraw(r.approval.id, system(null), 'the record was deleted')).toMatchObject({ outcome: 'withdrawn' })
    await flush()
    expect(events.filter((e) => e.type === 'withdrawn')).toEqual([
      { type: 'withdrawn', status: 'withdrawn', by: 'member_a' },
      { type: 'withdrawn', status: 'withdrawn', by: 'cleanup' },
    ])
    const rows = log.records.filter((x) => x.method === 'approval/withdraw')
    expect(rows.map((x) => [x.outcome, x.errorCode, x.principalId])).toEqual([
      ['refused_permission', 'not_requester', 'member_b'],
      ['refused_permission', 'not_requester', 'member_a'],
      ['refused_permission', 'not_requester', 'owner_a'],
      ['refused_permission', 'not_requester', 'member_a'],
      ['invalid', 'reason_required', 'member_a'],
      ['not_found', 'not_found', 'member_a'],
      ['ok', null, 'member_a'],
      ['invalid', 'already_decided', 'member_a'],
      ['invalid', 'already_decided', 'member_a'],
      ['refused_permission', 'not_requester', 'cleanup'],
      ['ok', null, 'cleanup'],
    ])
    expect(rows[6]).toMatchObject({ tool: 'device_approve', approvalId: id })
  })

  test('an approved change that goes stale or fails as it runs sends stale or failed', async () => {
    reset()
    const events: { type: string; status: string; error?: string | null }[] = []
    const { guard, flush, prove } = setup({ onApproval: (e) => void events.push({ type: e.type, status: e.approval.status, error: e.approval.error ?? null }) })
    const a = orgCtx('member_a')
    const p = await guard.call(a, 'device_approve', { device_id: 'dev_1' })
    if (p.outcome !== 'pending_approval') throw new Error(p.outcome)
    state.deviceVersion = 'd2'
    await guard.decide(p.approval.id, a, { approve: true, proof: await prove(a, p.approval.id) })
    await flush()
    expect(events.map((e) => e.type)).toEqual(['requested', 'decided', 'stale'])
    expect(events.at(-1)).toMatchObject({ status: 'stale', error: 'state_changed' })

    // The requester lost permission before the decision: the change fails at execution.
    events.length = 0
    const c = orgCtx('member_c')
    owners.dev_9 = ['owner_a']
    const q = await guard.call(c, 'device_approve', { device_id: 'dev_9' })
    if (q.outcome !== 'pending_approval') throw new Error(q.outcome)
    const saved = perms.member_c
    perms.member_c = []
    try {
      const o = orgCtx('owner_a')
      await guard.decide(q.approval.id, o, { approve: true, proof: await prove(o, q.approval.id) })
    } finally {
      perms.member_c = saved!
    }
    await flush()
    expect(events.map((e) => e.type)).toEqual(['requested', 'decided', 'failed'])
    expect(events.at(-1)).toMatchObject({ status: 'failed', error: 'no_permission' })
    // Asking again reads the stored end and sends nothing more.
    await guard.execute(q.approval.id)
    await flush()
    expect(events.length).toBe(3)
  })

  test('a GuardRefusal from run ends with its own outcome and is not retried', async () => {
    reset()
    const failing = kit.capability({
      name: 'thing_close',
      audiences: ['org'],
      title: 'Close a thing',
      description: D('Closes a thing.'),
      permission: 'brief.write',
      risk: 'R1',
      input: schema.object({}),
      version: 1,
      run: () => {
        throw new GuardRefusal('read_only', 'frozen', 'The desk is frozen.')
      },
    })
    const { guard } = setup({ registry: registry([failing]) })
    expect(await guard.call(orgCtx('member_a'), 'thing_close', {})).toMatchObject({ outcome: 'read_only', code: 'frozen', message: 'The desk is frozen.' })
  })
})

describe('guard: preview', () => {
  test('runs the checks and the preview, never the capability, and says what a call would do', async () => {
    reset()
    const { guard, store, log, flush } = setup()
    const a = orgCtx('member_a')
    expect(await guard.preview(a, 'brief_draft_save', { text: 'hi' })).toMatchObject({ outcome: 'ok', tier: 'R2', next: 'confirm', preview: { summary: 'Save "hi"' } })
    expect(await guard.preview(a, 'brief_draft_save', { text: 'hi' }, { confirm: 'upstream' })).toMatchObject({ outcome: 'ok', next: 'run' })
    const r3 = await guard.preview(a, 'device_approve', { device_id: 'dev_1' })
    expect(r3).toMatchObject({ outcome: 'ok', tier: 'R3', next: 'approval', approval: { policy: 'tenant_self' } })
    expect(await guard.preview(a, 'staff_list', {})).toMatchObject({ outcome: 'ok', tier: 'R1', next: 'run', preview: { summary: 'List staff' } })
    expect(runs).toEqual({})
    expect(await store.listApprovals()).toEqual([])
    await flush()
    expect(log.records.map((r) => `${r.method}:${r.outcome}`)).toEqual(['tools/preview:ok', 'tools/preview:ok', 'tools/preview:ok', 'tools/preview:ok'])
  })

  test('permission, tenant, tier and switches refuse a preview as they refuse a call', async () => {
    reset()
    const { guard, switches } = setup({ maxTier: (c) => (c.principal.id === 'owner_a' ? 'R1' : null), readOnly: (c) => (c.principal.id === 'member_a' && c.tenant === 'tB' ? 'tB is frozen' : false) })
    expect(await guard.preview(orgCtx('member_c'), 'brief_draft_save', { text: 'x' })).toMatchObject({ outcome: 'refused_permission', code: 'no_permission' })
    expect(await guard.preview(orgCtx('owner_a'), 'brief_draft_save', { text: 'x' })).toMatchObject({ outcome: 'refused_tier', code: 'tier_above_seat' })
    expect(await guard.preview(orgCtx('member_a', 'tB'), 'brief_draft_save', { text: 'x' })).toMatchObject({ outcome: 'read_only', message: 'tB is frozen' })
    expect(await guard.preview(orgCtx('member_a'), 'payment_record_manual_bank', { tenant_id: 'tB', amount: 5 })).toMatchObject({ outcome: 'refused_permission', code: 'cross_tenant' })
    expect(await guard.preview(orgCtx('member_a'), 'brief_draft_save', { text: 'x', extra: 1 })).toMatchObject({ outcome: 'invalid' })
    await switches.set({ key: 'all', scope: 'person', subject: 'member_a', on: false })
    expect(await guard.preview(orgCtx('member_a'), 'brief_draft_save', { text: 'x' })).toMatchObject({ outcome: 'switched_off' })
    expect(runs).toEqual({})
  })

  test('is not rate limited, and an ephemeral guard says what it would refuse', async () => {
    reset()
    const { guard } = setup({ rateLimit: memoryRateLimiter({ perSeat: { read: 1, write: 1 } }) })
    const a = orgCtx('member_a')
    for (let i = 0; i < 3; i++) expect((await guard.preview(a, 'brief_draft_save', { text: 'x' })).outcome).toBe('ok')
    const eph = createGuard<AppCtx, Perm>({ registry: reg, can: (c, p) => (perms[c.principal.id] ?? []).includes(p), ephemeral: true })
    expect(await eph.preview(a, 'brief_draft_save', { text: 'x' })).toMatchObject({ outcome: 'refused_tier', code: 'confirm_unavailable' })
    expect(await eph.preview(a, 'brief_draft_save', { text: 'x' }, { confirm: 'upstream' })).toMatchObject({ outcome: 'ok', next: 'run' })
    expect(await eph.preview(a, 'device_approve', { device_id: 'dev_1' })).toMatchObject({ outcome: 'refused_tier', code: 'no_approvals' })
  })
})

describe('guard: request log and tracing', () => {
  test('one record per call, redacted, nothing for R0, written after the response', async () => {
    reset()
    const { guard, log, flush } = setup()
    await guard.call(platCtx('admin_1'), 'tenants_list', {}, { client: { id: 'c1', name: 'claude.ai', version: '1' }, country: 'BD' })
    await guard.call(orgCtx('member_a'), 'staff_list', { tenant_id: 'tA' })
    await guard.call(orgCtx('member_a'), 'staff_list', { tenant_id: 'tB' })
    await flush()
    expect(log.records.map((r) => r.outcome)).toEqual(['ok', 'ok', 'refused_permission'])
    expect(log.records[0]).toMatchObject({ tool: 'tenants_list', tier: 'R0', args: null, clientName: 'claude.ai', country: 'BD', method: 'tools/call', door: 'platform' })
    expect(log.records[1]).toMatchObject({ tier: 'R1', args: '{"tenant_id":"tA"}', errorCode: null, tenant: 'tA', requestId: 'req_member_a_0001' })
    expect(log.records[2]?.errorCode).toBe('cross_tenant')
    expect(log.records[1]?.argsHash).toHaveLength(64)
  })

  test('the log never delays the response, and a failing log never fails it', async () => {
    reset()
    const never: RequestLogSink = { write: () => new Promise(() => {}) }
    const slow = setup({ log: never })
    const t0 = performance.now()
    const r = await Promise.race([slow.guard.call(orgCtx('member_a'), 'staff_list', {}), new Promise((res) => setTimeout(() => res('timeout'), 200))])
    expect((r as { outcome: string }).outcome).toBe('ok')
    expect(performance.now() - t0).toBeLessThan(150)
    const broken = setup({ log: { write: async () => Promise.reject(new Error('d1 down')) } })
    expect((await broken.guard.call(orgCtx('member_a'), 'staff_list', {})).outcome).toBe('ok')
    await broken.flush()
    const sync = setup({
      log: {
        write: () => {
          throw new Error('throws at once')
        },
      },
    })
    expect((await sync.guard.call(orgCtx('member_a'), 'staff_list', {})).outcome).toBe('ok')
    await sync.flush()
  })

  test('without waitUntil the log is still written, in the background', async () => {
    const log = memoryRequestLog()
    const { guard } = setup({ log, waitUntil: undefined })
    await guard.call(orgCtx('member_a'), 'staff_list', {})
    await new Promise((r) => setTimeout(r, 5))
    expect(log.records).toHaveLength(1)
  })

  test('listings are sampled and carry their rate', async () => {
    const { guard, log, flush } = setup({ sample: { 'tools/list': 4 } })
    for (let i = 0; i < 400; i++) guard.logRequest(orgCtx('member_a'), { method: 'tools/list' })
    guard.logRequest(orgCtx('member_a'), { method: 'tools/list', outcome: 'error' })
    await flush()
    const ok = log.records.filter((r) => r.outcome === 'ok')
    expect(ok.length).toBeGreaterThan(50)
    expect(ok.length).toBeLessThan(160)
    expect(ok.every((r) => r.sampleRate === 4)).toBe(true)
    expect(log.records.filter((r) => r.outcome === 'error')).toHaveLength(1)
  })

  test('a request refused before it had a principal is logged with none', async () => {
    const { guard, log, flush } = setup()
    guard.logAnonymous({ door: 'org', method: 'tools/call', requestId: 'req_anon_000001', client: { name: 'cursor' }, country: 'BD', errorCode: 'wrong_door' })
    guard.logAnonymous({ door: null, method: 'initialize', requestId: 'req_anon_000002', outcome: 'refused_auth' })
    await flush()
    expect(log.records).toHaveLength(2)
    expect(log.records[0]).toMatchObject({
      outcome: 'refused_auth',
      door: 'org',
      seat: null,
      principalKind: null,
      principalId: null,
      tenant: null,
      channel: 'mcp',
      clientName: 'cursor',
      errorCode: 'wrong_door',
      requestId: 'req_anon_000001',
      sampleRate: 1,
    })
  })

  test('the request id travels in a header', () => {
    const h = withRequestId({ 'content-type': 'application/json' }, 'req_abcdef123456')
    expect(h.get(REQUEST_ID_HEADER)).toBe('req_abcdef123456')
    expect(requestIdFrom(new Request('https://x.example', { headers: h }))).toBe('req_abcdef123456')
    expect(requestIdFrom(new Headers({ [REQUEST_ID_HEADER]: 'bad id with spaces' }))).toMatch(/^req_/)
    expect(requestIdFrom(null)).toMatch(/^req_/)
  })

  test('approval executions are logged with their approval id', async () => {
    reset()
    const { guard, log, flush, prove } = setup()
    const a = orgCtx('member_a')
    const p = await guard.call(a, 'device_approve', { device_id: 'dev_1' })
    if (p.outcome !== 'pending_approval') throw new Error(p.outcome)
    await guard.decide(p.approval.id, a, { approve: true, proof: await prove(a, p.approval.id) })
    await flush()
    expect(log.records.map((r) => [r.method, r.outcome, r.approvalId])).toEqual([
      ['tools/call', 'pending_approval', p.approval.id],
      ['approval/execute', 'ok', p.approval.id],
    ])
  })
})

describe('guard: what the second product asked for', () => {
  test('a write confirmed upstream runs in one call, reads the switches once, and logs both steps', async () => {
    reset()
    const { guard, log, switches, flush } = setup()
    let reads = 0
    const read = switches.read.bind(switches)
    switches.read = (q) => (reads++, read(q))
    const out = await guard.call(orgCtx('member_a'), 'brief_draft_save', { text: 'hello' }, { confirm: 'upstream' })
    expect(out.outcome).toBe('ok')
    expect(reads).toBe(1)
    await flush()
    expect(log.records.map((r) => [r.tool, r.outcome])).toEqual([
      ['brief_draft_save', 'confirm_required'],
      ['brief_draft_save', 'ok'],
    ])
    // R3 is unchanged: still an approval.
    const held = await guard.call(orgCtx('member_a'), 'device_approve', { device_id: 'dev_1' }, { confirm: 'upstream' })
    expect(held.outcome).toBe('pending_approval')
  })

  test('not_found is its own outcome', async () => {
    const find = kit.capability({
      name: 'device_get',
      audiences: ['org'],
      title: 'Get a device',
      description: D('Reads one device by id.'),
      permission: 'staff.read',
      risk: 'R0',
      input: schema.object({ id: schema.id() }),
      version: 1,
      run: (_c, i) => {
        throw new GuardRefusal('not_found', 'not_found', `No device ${i.id}.`)
      },
    })
    const log = memoryRequestLog()
    const pending: Promise<unknown>[] = []
    const g = createGuard<AppCtx, Perm>({ registry: registry([find]), can: () => true, ephemeral: true, log, waitUntil: (p) => void pending.push(p) })
    const out = await g.call(orgCtx('member_a'), 'device_get', { id: 'x' })
    expect(out).toMatchObject({ outcome: 'not_found', code: 'not_found', message: 'No device x.' })
    await Promise.all(pending)
    expect(log.records[0]?.outcome).toBe('not_found')
  })

  test('an ephemeral guard needs no store or secret; a persistent one needs both', () => {
    expect(() => createGuard<AppCtx, Perm>({ registry: reg, can: () => true, ephemeral: true })).not.toThrow()
    expect(() => createGuard<AppCtx, Perm>({ registry: reg, can: () => true } as never)).toThrow(/store and a secret/)
  })

  test('guard.http builds a ctx from a request, calls through the guard and logs the route', async () => {
    reset()
    const { guard, log, flush } = setup()
    const req = new Request('https://app.example/api/briefs', { method: 'POST', headers: { [REQUEST_ID_HEADER]: 'req-rest-0001' } })
    const rest = guard.http(req, {
      principal: { kind: 'member', id: 'member_a' },
      seat: { id: 'seat_member_a', door: 'org', tenant: 'tA' },
      confirm: 'upstream',
      ctx: (base) => ({ ...base, locale: 'en' }),
    })
    expect(rest.ctx).toMatchObject({ channel: 'rest', tenant: 'tA', requestId: 'req-rest-0001', locale: 'en' })
    expect(rest.headers).toEqual({ [REQUEST_ID_HEADER]: 'req-rest-0001' })
    const out = await rest.call('brief_draft_save', { text: 'via rest' })
    expect(out.outcome).toBe('ok')
    expect(rest.status(out)).toBe(200)
    const bad = await rest.call('brief_draft_save', { text: '' })
    expect(rest.status(bad)).toBe(400)
    await flush()
    expect(log.records.map((r) => [r.method, r.channel, r.outcome])).toEqual([
      ['POST /api/briefs', 'rest', 'confirm_required'],
      ['POST /api/briefs', 'rest', 'ok'],
      ['POST /api/briefs', 'rest', 'invalid'],
    ])
  })
})

import { Database } from 'bun:sqlite'
import { describe, expect, test } from 'bun:test'
import { type Ctx, registry, schema, capability } from '../src/capabilities/index'
import {
  type ApprovalRow,
  applyGuardMigrations,
  approver,
  auditStatement,
  checkPurgePlan,
  codeStepUp,
  createGuard,
  type D1DatabaseLike,
  type D1PreparedStatementLike,
  d1GuardStore,
  d1RequestLog,
  d1Switches,
  type GuardStore,
  guardMigrationSql,
  memoryGuardStore,
  memoryRateLimiter,
  policies,
  purgeTenant,
  rateLimitBindings,
} from '../src/guard/index'

/** D1's API over bun:sqlite, enough for the adapters. */
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

async function freshD1() {
  const raw = new Database(':memory:')
  const db = d1(raw)
  await applyGuardMigrations(db)
  await applyGuardMigrations(db) // idempotent
  return { raw, db }
}

const row = (id: string, over: Partial<ApprovalRow> = {}): ApprovalRow => ({
  id,
  action: 'device_approve',
  actionVersion: 1,
  tier: 'R3',
  requester: { kind: 'member', id: 'u1', name: 'Rina' },
  seat: 's1',
  door: 'org',
  channel: 'mcp',
  tenant: 'tA',
  target: 'tA',
  argsSealed: 'sealed',
  argsHash: 'h'.repeat(64),
  stateVersion: 'v1',
  preview: { summary: 'Approve a device', before: { ok: false } },
  policy: 'tenant_self',
  rule: { approver: { kind: 'author_or_record_owner' }, fourEyes: false, stepUp: ['code'], expiresMs: 1000, typedTarget: false },
  status: 'waiting',
  requestId: 'req_1',
  createdAt: '2026-11-24T10:00:00.000Z',
  expiresAt: '2026-11-25T10:00:00.000Z',
  ...over,
})

// The same contract for every GuardStore.
const stores: [string, () => Promise<GuardStore>][] = [
  ['memory', async () => memoryGuardStore()],
  ['d1', async () => d1GuardStore((await freshD1()).db)],
]

for (const [name, make] of stores) {
  describe(`GuardStore contract: ${name}`, () => {
    test('a nonce is taken once, and not after expiry', async () => {
      const s = await make()
      await s.putNonce('n1', 2000)
      await s.putNonce('n2', 500)
      expect(await s.takeNonce('n1', 1000)).toBe(true)
      expect(await s.takeNonce('n1', 1000)).toBe(false)
      expect(await s.takeNonce('n2', 1000)).toBe(false)
      expect(await s.takeNonce('nope', 1000)).toBe(false)
    })

    test('approvals round-trip and update by compare-and-swap', async () => {
      const s = await make()
      await s.insertApproval(row('a1'))
      expect(await s.getApproval('a1')).toEqual(row('a1'))
      const patch = { status: 'approved' as const, decider: { kind: 'member', id: 'u2' }, decidedAt: '2026-11-24T11:00:00.000Z', verification: 'code' }
      expect(await s.updateApproval('a1', 'waiting', patch)).toBe(true)
      expect(await s.updateApproval('a1', 'waiting', { status: 'refused' })).toBe(false)
      expect(await s.getApproval('a1')).toMatchObject({ status: 'approved', decider: { id: 'u2' }, verification: 'code' })
      expect(await s.updateApproval('a1', 'approved', { status: 'executed', result: { id: 'x', n: [1] }, auditId: 'au1' })).toBe(true)
      expect(await s.getApproval('a1')).toMatchObject({ status: 'executed', result: { id: 'x', n: [1] }, auditId: 'au1' })
      expect(await s.getApproval('none')).toBeNull()
    })

    test('list and expire', async () => {
      const s = await make()
      await s.insertApproval(row('a1', { expiresAt: '2026-11-24T10:30:00.000Z' }))
      await s.insertApproval(row('a2', { tenant: 'tB', createdAt: '2026-11-24T10:01:00.000Z' }))
      expect((await s.listApprovals({ tenant: 'tA' })).map((r) => r.id)).toEqual(['a1'])
      expect((await s.listApprovals()).map((r) => r.id)).toEqual(['a2', 'a1'])
      expect(await s.expireApprovals(Date.parse('2026-11-24T11:00:00.000Z'))).toBe(1)
      expect((await s.listApprovals({ status: 'expired' })).map((r) => r.id)).toEqual(['a1'])
    })

    test('challenges count attempts', async () => {
      const s = await make()
      await s.putChallenge({ id: 'c1', approvalId: 'a1', person: 'u1', channel: 'email', codeHash: 'x', expiresAt: 9, attempts: 0 })
      expect(await s.bumpChallenge('c1')).toBe(1)
      expect(await s.bumpChallenge('c1')).toBe(2)
      expect((await s.getChallenge('c1'))?.attempts).toBe(2)
      await s.deleteChallenge('c1')
      expect(await s.getChallenge('c1')).toBeNull()
    })
  })
}

describe('D1 adapters end to end', () => {
  type C = Ctx
  const owners: Record<string, string[]> = { d1: ['owner'] }
  const ran: unknown[] = []
  const cap = capability<{ device_id: string }, unknown, C, string>({
    name: 'device_approve',
    audiences: ['org'],
    title: 'Approve a device',
    description: 'Approves a paired device for this tenant. Padding to reach the eighty character minimum of descriptions.',
    permission: 'devices',
    risk: 'R3',
    approval: 'tenant_self',
    input: schema.object({ device_id: schema.id() }),
    version: 1,
    preview: (_c, i) => ({ summary: `Approve ${i.device_id}`, stateVersion: 'v1' }),
    run: (_c, i) => {
      ran.push(i)
      return { ok: true }
    },
  })
  const ctx = (id: string): C => ({
    principal: { kind: 'member', id },
    seat: { id: `seat_${id}`, door: 'org', tenant: 'tA' },
    tenant: 'tA',
    channel: 'mcp',
    approvalId: null,
    requestId: `req_${id}_00000`,
  })

  test('approval, step-up, execution, log and switches, all in D1', async () => {
    const { db, raw } = await freshD1()
    const store = d1GuardStore(db)
    const log = d1RequestLog(db)
    const switches = d1Switches(db)
    const sent: string[] = []
    const codes = codeStepUp<C>({ store, send: (_c, _ch, code) => void sent.push(code) })
    const pending: Promise<unknown>[] = []
    const guard = createGuard<C, string>({
      registry: registry([cap]),
      can: () => true,
      secret: 'd1-secret-d1-secret-d1-secret-d1-secret',
      store,
      policies: { tenant_self: policies.single({ approver: approver.authorOrRecordOwner(), stepUp: 'code', expires: '24h' }) },
      recordOwner: (_c, _cap, i) => owners[(i as { device_id: string }).device_id] ?? [],
      stepUp: codes,
      switches,
      log,
      waitUntil: (p) => void pending.push(p),
    })
    const p = await guard.call(ctx('member'), 'device_approve', { device_id: 'd1' })
    if (p.outcome !== 'pending_approval') throw new Error(p.outcome)
    const owner = ctx('owner')
    await codes.start(owner, (await guard.approval(p.approval.id))!)
    const d = await guard.decide(p.approval.id, owner, { approve: true, proof: { method: 'code', codes: { email: sent[0]! } } })
    expect(d.outcome === 'approved' && d.execution.outcome).toBe('ok')
    expect(await guard.execute(p.approval.id)).toMatchObject({ outcome: 'ok' })
    expect(ran).toHaveLength(1)
    await Promise.all(pending)
    const rows = await log.recent()
    expect(rows.map((r) => r.outcome).sort()).toEqual(['ok', 'pending_approval'])
    expect(rows.every((r) => r.approvalId === p.approval.id)).toBe(true)

    await switches.set({ key: 'door:org', scope: 'tenant', subject: 'tA', on: true })
    await switches.set({ key: 'all', scope: 'global', subject: null, on: false, reason: 'Stopped.' })
    expect(await guard.call(ctx('member'), 'device_approve', { device_id: 'd1' })).toMatchObject({ outcome: 'switched_off', message: 'Stopped.' })
    await switches.set({ key: 'all', scope: 'global', subject: null, on: true })
    expect((await guard.call(ctx('member'), 'device_approve', { device_id: 'd1' })).outcome).toBe('pending_approval')
    expect((await switches.list()).length).toBe(2)

    const pruned = await store.prune(Date.parse('2027-06-01T00:00:00Z'))
    expect(pruned.cleared).toBe(1)
    expect(raw.query('SELECT count(*) AS n FROM guard_approvals WHERE args_sealed IS NULL').get()).toEqual({ n: 1 })
  })

  test('an anonymous refusal fits the D1 request log', async () => {
    const { db } = await freshD1()
    const log = d1RequestLog(db)
    const pending: Promise<unknown>[] = []
    const guard = createGuard<C, string>({
      registry: registry([cap]),
      can: () => true,
      secret: 'd1-secret-d1-secret-d1-secret-d1-secret',
      store: d1GuardStore(db),
      log,
      waitUntil: (p) => void pending.push(p),
      onError: (e) => {
        throw e
      },
    })
    guard.logAnonymous({ door: 'org', method: 'tools/call', requestId: 'req_anon_000001' })
    await Promise.all(pending)
    expect(await log.recent()).toMatchObject([{ outcome: 'refused_auth', principalId: null, principalKind: null, door: 'org' }])
  })

  test('the migration text is one file a product can commit', () => {
    const sql = guardMigrationSql()
    expect(sql).toContain('-- 0001_guard')
    expect(sql).toContain('CREATE TABLE IF NOT EXISTS guard_requests')
  })
})

describe('audit helper', () => {
  test('a statement with via, approval_id and request_id, batched with the change', async () => {
    const { db, raw } = await freshD1()
    raw.run('CREATE TABLE audit_log (id INTEGER PRIMARY KEY, action TEXT, via TEXT, approval_id TEXT, request_id TEXT, detail TEXT)')
    raw.run('CREATE TABLE devices (id TEXT, state TEXT)')
    raw.run("INSERT INTO devices VALUES ('d1', 'pending')")
    const ctx = { principal: { kind: 'member', id: 'u1' }, seat: null, tenant: 'tA', channel: 'mcp', approvalId: 'apr_1', requestId: 'req_123456' }
    await db.batch([db.prepare("UPDATE devices SET state = 'approved' WHERE id = ?").bind('d1'), auditStatement(db, ctx, { action: 'device.approve', detail: { id: 'd1' } })])
    expect(raw.query('SELECT action, via, approval_id, request_id, detail FROM audit_log').get()).toEqual({
      action: 'device.approve',
      via: 'mcp',
      approval_id: 'apr_1',
      request_id: 'req_123456',
      detail: '{"id":"d1"}',
    })
    expect(() => auditStatement(db, ctx, { 'bad name': 1 })).toThrow()
  })
})

describe('tenant purge', () => {
  test('chunked, resumable, keeps what the plan keeps, never touches other tenants', async () => {
    const { db, raw } = await freshD1()
    raw.run('CREATE TABLE visitors (id INTEGER PRIMARY KEY, tenant_id TEXT)')
    raw.run('CREATE TABLE payments (id INTEGER PRIMARY KEY, tenant TEXT, kind TEXT)')
    raw.run('CREATE TABLE do_not_call (id INTEGER PRIMARY KEY, tenant_id TEXT)')
    const ins = raw.prepare('INSERT INTO visitors (tenant_id) VALUES (?)')
    for (let i = 0; i < 250; i++) ins.run(i % 5 === 0 ? 'tB' : 'tA')
    for (let i = 0; i < 30; i++) raw.run('INSERT INTO payments (tenant, kind) VALUES (?, ?)', ['tA', i < 10 ? 'payment' : 'note'])
    raw.run("INSERT INTO do_not_call (tenant_id) VALUES ('tA')")
    const plan = {
      tables: [{ table: 'visitors' }, { table: 'payments', tenantColumn: 'tenant', keepWhere: { sql: 'kind = ?', params: ['payment'] } }],
      keep: ['do_not_call'],
      protectedTenants: ['betopia'],
    }
    checkPurgePlan(plan)
    let cur = await purgeTenant(db, 'tA', plan, { chunk: 50, maxChunks: 2 })
    expect(cur).toMatchObject({ done: false, table: 0, deleted: { visitors: 100 } })
    let guard = 0
    while (!cur.done && guard++ < 20) cur = await purgeTenant(db, 'tA', plan, { cursor: cur, chunk: 50, maxChunks: 2 })
    expect(cur.done).toBe(true)
    expect(cur.deleted).toEqual({ visitors: 200, payments: 20 })
    expect(raw.query("SELECT count(*) AS n FROM visitors WHERE tenant_id = 'tB'").get()).toEqual({ n: 50 })
    expect(raw.query("SELECT count(*) AS n FROM payments WHERE kind = 'payment'").get()).toEqual({ n: 10 })
    expect(raw.query('SELECT count(*) AS n FROM do_not_call').get()).toEqual({ n: 1 })
    await expect(purgeTenant(db, 'betopia', plan)).rejects.toThrow()
    expect(() => checkPurgePlan({ tables: [{ table: 'do_not_call' }], keep: ['do_not_call'] })).toThrow()
    expect(() => checkPurgePlan({ tables: [{ table: 'x; DROP TABLE y' }] })).toThrow()
  })
})

describe('rate limit adapters', () => {
  test('the Cloudflare binding adapter keys by seat and mode, then tenant', async () => {
    const keys: string[] = []
    const binding = (allow: boolean) => ({ limit: async ({ key }: { key: string }) => (keys.push(key), { success: allow }) })
    const rl = rateLimitBindings({ read: binding(true), write: binding(false), tenant: binding(true) })
    expect(await rl.check({ seat: 's1', tenant: 'tA', mode: 'read', tool: 'x' })).toEqual({ ok: true })
    expect(await rl.check({ seat: 's1', tenant: 'tA', mode: 'write', tool: 'x' })).toMatchObject({ ok: false, limit: 'seat_write' })
    expect(keys).toEqual(['seat:s1:read', 'tenant:tA', 'seat:s1:write'])
  })

  test('the memory limiter opens again after the window', async () => {
    let t = 0
    const rl = memoryRateLimiter({ perTenant: 1, windowMs: 1000, now: () => t })
    expect((await rl.check({ seat: 'a', tenant: 'tA', mode: 'read', tool: 'x' })).ok).toBe(true)
    expect((await rl.check({ seat: 'b', tenant: 'tA', mode: 'read', tool: 'x' })).ok).toBe(false)
    t = 1000
    expect((await rl.check({ seat: 'b', tenant: 'tA', mode: 'read', tool: 'x' })).ok).toBe(true)
  })
})

describe('d1Switches cache', () => {
  test('no cache by default; cacheMs keeps a read that long, and set() clears it', async () => {
    const { db, raw } = await freshD1()
    let t = 0
    const q = { keys: ['all', 'tool:x'], tenant: null, person: 'p1' }
    const plain = d1Switches(db)
    const cached = d1Switches(db, { cacheMs: 5000, now: () => t })
    expect(await cached.read(q)).toEqual([])
    raw.query("INSERT INTO guard_switches (key, scope, subject, is_on, updated_at) VALUES ('tool:x', 'global', '', 0, 'now')").run()
    expect((await plain.read(q)).length).toBe(1)
    expect(await cached.read(q)).toEqual([])
    t = 5001
    expect((await cached.read(q)).length).toBe(1)
    raw.query('DELETE FROM guard_switches').run()
    await cached.set({ key: 'tool:y', scope: 'global', subject: null, on: true })
    expect(await cached.read(q)).toEqual([])
  })
})

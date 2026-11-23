// Cloudflare D1 adapters for the guard's stores, and the SQL they need. The
// types below are the part of D1's API the kit uses, so the package needs no
// Cloudflare types; a real D1 binding fits them.
//
// Apply GUARD_MIGRATIONS once (wrangler migrations, or applyGuardMigrations).
// A product with a busy main database can give the guard a second one, as
// Joya does with joya-ops, so log writes never queue behind its own.

import type { Tier } from '../capabilities/tiers.js'
import type { ApprovalRow, ApprovalStatus, ChallengeRow, GuardStore, Outcome, RequestLogSink, RequestRecord, SwitchRow, SwitchScope, SwitchStore } from './types.js'

export interface D1ResultLike<T = unknown> {
  results?: T[]
  success?: boolean
  meta?: { changes?: number }
}

export interface D1PreparedStatementLike {
  bind(...values: unknown[]): D1PreparedStatementLike
  first<T = Record<string, unknown>>(): Promise<T | null>
  all<T = Record<string, unknown>>(): Promise<D1ResultLike<T>>
  run(): Promise<D1ResultLike>
}

export interface D1DatabaseLike {
  prepare(sql: string): D1PreparedStatementLike
  batch(statements: D1PreparedStatementLike[]): Promise<D1ResultLike[]>
}

/** The guard's tables. Additive only: a later migration adds, never changes. */
export const GUARD_MIGRATIONS: readonly { id: string; sql: string }[] = Object.freeze([
  {
    id: '0001_guard',
    sql: `
CREATE TABLE IF NOT EXISTS guard_nonces (
  nonce TEXT PRIMARY KEY,
  expires_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS guard_nonces_expiry ON guard_nonces (expires_at);

CREATE TABLE IF NOT EXISTS guard_approvals (
  id TEXT PRIMARY KEY,
  action TEXT NOT NULL,
  action_version INTEGER NOT NULL,
  tier TEXT NOT NULL,
  requester_kind TEXT NOT NULL,
  requester_id TEXT NOT NULL,
  requester_name TEXT,
  seat TEXT,
  door TEXT,
  channel TEXT NOT NULL,
  tenant TEXT,
  target TEXT,
  args_sealed TEXT,
  args_hash TEXT NOT NULL,
  state_version TEXT,
  preview TEXT NOT NULL,
  policy TEXT NOT NULL,
  rule TEXT NOT NULL,
  status TEXT NOT NULL,
  request_id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  decided_at TEXT,
  decider_kind TEXT,
  decider_id TEXT,
  decider_name TEXT,
  decider_seat TEXT,
  verification TEXT,
  reason TEXT,
  executed_at TEXT,
  result TEXT,
  error TEXT,
  audit_id TEXT
);
CREATE INDEX IF NOT EXISTS guard_approvals_status ON guard_approvals (status, expires_at);
CREATE INDEX IF NOT EXISTS guard_approvals_tenant ON guard_approvals (tenant, status, created_at);

CREATE TABLE IF NOT EXISTS guard_challenges (
  id TEXT PRIMARY KEY,
  approval_id TEXT NOT NULL,
  person TEXT NOT NULL,
  channel TEXT NOT NULL,
  code_hash TEXT NOT NULL,
  expires_at INTEGER NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS guard_switches (
  key TEXT NOT NULL,
  scope TEXT NOT NULL,
  subject TEXT NOT NULL DEFAULT '',
  is_on INTEGER NOT NULL,
  reason TEXT,
  updated_at TEXT NOT NULL,
  updated_by TEXT,
  PRIMARY KEY (scope, subject, key)
);

CREATE TABLE IF NOT EXISTS guard_requests (
  id TEXT PRIMARY KEY,
  at TEXT NOT NULL,
  request_id TEXT NOT NULL,
  door TEXT,
  seat TEXT,
  principal_kind TEXT,
  principal_id TEXT,
  tenant TEXT,
  channel TEXT NOT NULL,
  client_id TEXT,
  client_name TEXT,
  client_version TEXT,
  method TEXT NOT NULL,
  tool TEXT,
  tier TEXT,
  args TEXT,
  args_hash TEXT,
  outcome TEXT NOT NULL,
  error_code TEXT,
  approval_id TEXT,
  ms INTEGER NOT NULL,
  country TEXT,
  sample_rate INTEGER NOT NULL DEFAULT 1
);
CREATE INDEX IF NOT EXISTS guard_requests_at ON guard_requests (at);
CREATE INDEX IF NOT EXISTS guard_requests_tenant ON guard_requests (tenant, at);
CREATE INDEX IF NOT EXISTS guard_requests_request ON guard_requests (request_id);
`,
  },
])

/** Every migration as one SQL text, for a wrangler migrations file. */
export const guardMigrationSql = (): string => GUARD_MIGRATIONS.map((m) => `-- ${m.id}\n${m.sql.trim()}\n`).join('\n')

/** Runs the migrations statement by statement. They are idempotent. */
export async function applyGuardMigrations(db: D1DatabaseLike): Promise<void> {
  const stmts = GUARD_MIGRATIONS.flatMap((m) => m.sql.split(';'))
    .map((s) => s.trim())
    .filter(Boolean)
  await db.batch(stmts.map((s) => db.prepare(s)))
}

// ---------------------------------------------------------------- approvals

const json = (v: unknown) => (v === undefined ? null : JSON.stringify(v))
const parse = <T>(v: unknown): T | undefined => (typeof v === 'string' ? (JSON.parse(v) as T) : undefined)

/** ApprovalRow field to column, with how to write it. */
const COLS: Record<string, [string, (v: unknown) => unknown]> = {
  action: ['action', (v) => v],
  actionVersion: ['action_version', (v) => v],
  tier: ['tier', (v) => v],
  seat: ['seat', (v) => v],
  door: ['door', (v) => v],
  channel: ['channel', (v) => v],
  tenant: ['tenant', (v) => v],
  target: ['target', (v) => v],
  argsSealed: ['args_sealed', (v) => v],
  argsHash: ['args_hash', (v) => v],
  stateVersion: ['state_version', (v) => v],
  preview: ['preview', json],
  policy: ['policy', (v) => v],
  rule: ['rule', json],
  status: ['status', (v) => v],
  requestId: ['request_id', (v) => v],
  createdAt: ['created_at', (v) => v],
  expiresAt: ['expires_at', (v) => v],
  decidedAt: ['decided_at', (v) => v],
  deciderSeat: ['decider_seat', (v) => v],
  verification: ['verification', (v) => v],
  reason: ['reason', (v) => v],
  executedAt: ['executed_at', (v) => v],
  result: ['result', json],
  error: ['error', (v) => v],
  auditId: ['audit_id', (v) => v],
}

function toColumns(p: Partial<ApprovalRow>): [string, unknown][] {
  const out: [string, unknown][] = []
  for (const [k, v] of Object.entries(p)) {
    if (v === undefined || k === 'id') continue
    if (k === 'requester') {
      const r = v as ApprovalRow['requester']
      out.push(['requester_kind', r.kind], ['requester_id', r.id], ['requester_name', r.name ?? null])
    } else if (k === 'decider') {
      const d = v as ApprovalRow['decider']
      out.push(['decider_kind', d?.kind ?? null], ['decider_id', d?.id ?? null], ['decider_name', d?.name ?? null])
    } else {
      const c = COLS[k]
      if (c) out.push([c[0], c[1](v ?? null)])
    }
  }
  return out
}

type Row = Record<string, unknown>
const s = (v: unknown) => (v === null || v === undefined ? null : String(v))

function fromRow(r: Row): ApprovalRow {
  const row: ApprovalRow = {
    id: String(r.id),
    action: String(r.action),
    actionVersion: Number(r.action_version),
    tier: r.tier as Tier,
    requester: { kind: String(r.requester_kind), id: String(r.requester_id), ...(r.requester_name ? { name: String(r.requester_name) } : {}) },
    seat: s(r.seat),
    door: s(r.door),
    channel: String(r.channel),
    tenant: s(r.tenant),
    target: s(r.target),
    argsSealed: String(r.args_sealed ?? ''),
    argsHash: String(r.args_hash),
    stateVersion: s(r.state_version),
    preview: parse(r.preview) ?? { summary: '' },
    policy: String(r.policy),
    rule: parse(r.rule) as ApprovalRow['rule'],
    status: r.status as ApprovalStatus,
    requestId: String(r.request_id),
    createdAt: String(r.created_at),
    expiresAt: String(r.expires_at),
  }
  const opt: Partial<ApprovalRow> = {
    decidedAt: s(r.decided_at),
    decider: r.decider_id ? { kind: String(r.decider_kind), id: String(r.decider_id), ...(r.decider_name ? { name: String(r.decider_name) } : {}) } : null,
    deciderSeat: s(r.decider_seat),
    verification: s(r.verification),
    reason: s(r.reason),
    executedAt: s(r.executed_at),
    result: parse(r.result),
    error: s(r.error),
    auditId: s(r.audit_id),
  }
  // Optional fields only when set, so a row reads back as it was written.
  for (const [k, v] of Object.entries(opt)) if (v !== null && v !== undefined) (row as unknown as Record<string, unknown>)[k] = v
  return row
}

export interface D1GuardStore extends GuardStore {
  /**
   * Deletes spent nonces and challenges, and clears the sealed arguments of
   * approvals decided more than `argsDays` (default 90) ago. For a daily cron.
   */
  prune(now: number, opts?: { argsDays?: number }): Promise<{ nonces: number; challenges: number; cleared: number }>
}

export function d1GuardStore(db: D1DatabaseLike): D1GuardStore {
  const changes = (r: D1ResultLike) => r.meta?.changes ?? 0
  return {
    async putNonce(nonce, expiresAt) {
      await db.prepare('INSERT INTO guard_nonces (nonce, expires_at) VALUES (?, ?)').bind(nonce, expiresAt).run()
    },
    async takeNonce(nonce, now) {
      const r = await db.prepare('DELETE FROM guard_nonces WHERE nonce = ? RETURNING expires_at').bind(nonce).first<{ expires_at: number }>()
      return !!r && Number(r.expires_at) > now
    },
    async insertApproval(row) {
      const cols = [['id', row.id] as [string, unknown], ...toColumns(row)]
      await db
        .prepare(`INSERT INTO guard_approvals (${cols.map((c) => c[0]).join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`)
        .bind(...cols.map((c) => c[1]))
        .run()
    },
    async getApproval(id) {
      const r = await db.prepare('SELECT * FROM guard_approvals WHERE id = ?').bind(id).first<Row>()
      return r ? fromRow(r) : null
    },
    async updateApproval(id, from, patch) {
      const cols = toColumns(patch)
      if (!cols.length) return false
      const r = await db
        .prepare(`UPDATE guard_approvals SET ${cols.map((c) => `${c[0]} = ?`).join(', ')} WHERE id = ? AND status = ?`)
        .bind(...cols.map((c) => c[1]), id, from)
        .run()
      return changes(r) === 1
    },
    async listApprovals(q = {}) {
      const where: string[] = []
      const args: unknown[] = []
      if (q.tenant !== undefined) {
        where.push(q.tenant === null ? 'tenant IS NULL' : 'tenant = ?')
        if (q.tenant !== null) args.push(q.tenant)
      }
      if (q.status) {
        where.push('status = ?')
        args.push(q.status)
      }
      const sql = `SELECT * FROM guard_approvals ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY created_at DESC LIMIT ?`
      const r = await db
        .prepare(sql)
        .bind(...args, Math.min(Math.max(1, q.limit ?? 100), 500))
        .all<Row>()
      return (r.results ?? []).map(fromRow)
    },
    async expireApprovals(now) {
      const r = await db.prepare("UPDATE guard_approvals SET status = 'expired' WHERE status = 'waiting' AND expires_at <= ?").bind(new Date(now).toISOString()).run()
      return changes(r)
    },
    async putChallenge(c) {
      await db
        .prepare('INSERT OR REPLACE INTO guard_challenges (id, approval_id, person, channel, code_hash, expires_at, attempts) VALUES (?, ?, ?, ?, ?, ?, ?)')
        .bind(c.id, c.approvalId, c.person, c.channel, c.codeHash, c.expiresAt, c.attempts)
        .run()
    },
    async getChallenge(id) {
      const r = await db.prepare('SELECT * FROM guard_challenges WHERE id = ?').bind(id).first<Row>()
      if (!r) return null
      return {
        id: String(r.id),
        approvalId: String(r.approval_id),
        person: String(r.person),
        channel: String(r.channel),
        codeHash: String(r.code_hash),
        expiresAt: Number(r.expires_at),
        attempts: Number(r.attempts),
      } satisfies ChallengeRow
    },
    async bumpChallenge(id) {
      const r = await db.prepare('UPDATE guard_challenges SET attempts = attempts + 1 WHERE id = ? RETURNING attempts').bind(id).first<{ attempts: number }>()
      return r ? Number(r.attempts) : 0
    },
    async deleteChallenge(id) {
      await db.prepare('DELETE FROM guard_challenges WHERE id = ?').bind(id).run()
    },
    async prune(now, opts = {}) {
      const cutoff = new Date(now - (opts.argsDays ?? 90) * 86_400_000).toISOString()
      const [a, b, c] = await db.batch([
        db.prepare('DELETE FROM guard_nonces WHERE expires_at <= ?').bind(now),
        db.prepare('DELETE FROM guard_challenges WHERE expires_at <= ?').bind(now),
        db.prepare("UPDATE guard_approvals SET args_sealed = NULL WHERE args_sealed IS NOT NULL AND status <> 'waiting' AND status <> 'approved' AND COALESCE(decided_at, expires_at) <= ?").bind(cutoff),
      ])
      return { nonces: changes(a!), challenges: changes(b!), cleared: changes(c!) }
    },
  }
}

// ---------------------------------------------------------------- request log

const LOG_COLS = [
  ['id', 'id'],
  ['at', 'at'],
  ['request_id', 'requestId'],
  ['door', 'door'],
  ['seat', 'seat'],
  ['principal_kind', 'principalKind'],
  ['principal_id', 'principalId'],
  ['tenant', 'tenant'],
  ['channel', 'channel'],
  ['client_id', 'clientId'],
  ['client_name', 'clientName'],
  ['client_version', 'clientVersion'],
  ['method', 'method'],
  ['tool', 'tool'],
  ['tier', 'tier'],
  ['args', 'args'],
  ['args_hash', 'argsHash'],
  ['outcome', 'outcome'],
  ['error_code', 'errorCode'],
  ['approval_id', 'approvalId'],
  ['ms', 'ms'],
  ['country', 'country'],
  ['sample_rate', 'sampleRate'],
] as const satisfies readonly (readonly [string, keyof RequestRecord])[]

/** The request log in D1. One INSERT per record, in one batch. */
export function d1RequestLog(db: D1DatabaseLike): RequestLogSink & { recent(limit?: number): Promise<RequestRecord[]> } {
  const sql = `INSERT INTO guard_requests (${LOG_COLS.map((c) => c[0]).join(', ')}) VALUES (${LOG_COLS.map(() => '?').join(', ')})`
  return {
    async write(records) {
      if (!records.length) return
      await db.batch(records.map((r) => db.prepare(sql).bind(...LOG_COLS.map(([, k]) => r[k] ?? null))))
    },
    async recent(limit = 50) {
      const r = await db.prepare('SELECT * FROM guard_requests ORDER BY at DESC LIMIT ?').bind(Math.min(limit, 500)).all<Row>()
      return (r.results ?? []).map((row) => {
        const out: Record<string, unknown> = {}
        for (const [col, key] of LOG_COLS) out[key] = row[col] ?? null
        out.ms = Number(out.ms)
        out.sampleRate = Number(out.sampleRate)
        out.outcome = out.outcome as Outcome
        return out as unknown as RequestRecord
      })
    },
  }
}

// ---------------------------------------------------------------- switches

export interface D1SwitchesOptions {
  /**
   * Milliseconds to keep what one read returned, per set of keys, tenant and
   * person. Default 0: every guard call reads D1. A cache delays an
   * emergency stop by up to this long on every isolate that cached the
   * switch, so keep it short. It helps only when the store lives in module
   * scope; one made per request starts empty.
   */
  cacheMs?: number
  /** For tests. */
  now?: () => number
}

/**
 * Kill switches in D1: every key a call needs in one indexed read, once per
 * guard call. No cache unless `cacheMs` is set.
 */
export function d1Switches(db: D1DatabaseLike, opts: D1SwitchesOptions = {}): SwitchStore {
  const cacheMs = Math.max(0, opts.cacheMs ?? 0)
  const now = opts.now ?? Date.now
  const cache = new Map<string, { until: number; rows: SwitchRow[] }>()
  const toRow = (r: Row): SwitchRow => ({
    key: String(r.key),
    scope: r.scope as SwitchScope,
    subject: r.subject ? String(r.subject) : null,
    on: Number(r.is_on) === 1,
    reason: s(r.reason),
    updatedAt: String(r.updated_at),
    updatedBy: s(r.updated_by),
  })
  return {
    async read(q) {
      if (!q.keys.length) return []
      const keys = q.keys.slice(0, 90)
      const id = cacheMs ? JSON.stringify([keys, q.tenant ?? null, q.person ?? null]) : ''
      if (cacheMs) {
        const hit = cache.get(id)
        if (hit && hit.until > now()) return hit.rows.map((r) => ({ ...r }))
      }
      const marks = keys.map(() => '?').join(', ')
      const r = await db
        .prepare(
          `SELECT * FROM guard_switches WHERE key IN (${marks}) AND ((scope = 'global' AND subject = '') OR (scope = 'tenant' AND subject = ?) OR (scope = 'person' AND subject = ?))`,
        )
        .bind(...keys, q.tenant ?? '\u0000', q.person ?? '\u0000')
        .all<Row>()
      const rows = (r.results ?? []).map(toRow)
      if (cacheMs) {
        if (cache.size >= 1000) cache.clear()
        cache.set(id, { until: now() + cacheMs, rows })
      }
      return rows
    },
    async set(row) {
      cache.clear()
      await db
        .prepare(
          'INSERT INTO guard_switches (key, scope, subject, is_on, reason, updated_at, updated_by) VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT (scope, subject, key) DO UPDATE SET is_on = excluded.is_on, reason = excluded.reason, updated_at = excluded.updated_at, updated_by = excluded.updated_by',
        )
        .bind(row.key, row.scope, row.scope === 'global' ? '' : (row.subject ?? ''), row.on ? 1 : 0, row.reason ?? null, row.updatedAt ?? new Date().toISOString(), row.updatedBy ?? null)
        .run()
    },
    async list() {
      const r = await db.prepare('SELECT * FROM guard_switches ORDER BY scope, subject, key').all<Row>()
      return (r.results ?? []).map(toRow)
    },
  }
}

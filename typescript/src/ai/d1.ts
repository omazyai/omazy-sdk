// Cloudflare D1 adapters for the run store and memory, and the SQL they need.
// Apply AI_MIGRATIONS once (wrangler migrations, or applyAiMigrations). A
// product with a busy main database gives these their own, as Joya does with
// joya-ops. Scope lives in the WHERE clause of every memory read.

import type { Tier } from '../capabilities/tiers.js'
import type { D1DatabaseLike } from '../guard/d1.js'
import type { Message } from '../types.js'
import type { UnitKind } from './manifest.js'
import { type LongTermScope, type MemoryOwner, type MemoryRow, type MemoryStatus, type MemoryStore, readThreadCursor, type ThreadKey, type ThreadListItem, threadCursor, threadPageSize } from './memory.js'
import type { EffectOutcome, EffectRow, RunOutcome, RunRow, RunStore } from './runs.js'

/** The kit's tables. Additive only: a later migration adds, never changes. */
export const AI_MIGRATIONS: readonly { id: string; sql: string }[] = Object.freeze([
  {
    id: '0001_ai',
    sql: `
CREATE TABLE IF NOT EXISTS ai_runs (
  id TEXT PRIMARY KEY,
  unit TEXT NOT NULL,
  unit_kind TEXT NOT NULL,
  unit_version INTEGER NOT NULL,
  prompt_template TEXT NOT NULL,
  prompt_version INTEGER NOT NULL,
  language TEXT NOT NULL,
  role TEXT NOT NULL,
  model TEXT,
  seat TEXT,
  tenant TEXT,
  person TEXT,
  channel TEXT NOT NULL,
  request_id TEXT NOT NULL,
  started_at TEXT NOT NULL,
  ended_at TEXT,
  outcome TEXT NOT NULL,
  error_code TEXT,
  error TEXT,
  calls INTEGER NOT NULL DEFAULT 0,
  cache_hits INTEGER NOT NULL DEFAULT 0,
  input_tokens INTEGER NOT NULL DEFAULT 0,
  output_tokens INTEGER NOT NULL DEFAULT 0,
  cached_input_tokens INTEGER NOT NULL DEFAULT 0,
  cost_micros INTEGER NOT NULL DEFAULT 0,
  cost_estimated INTEGER NOT NULL DEFAULT 0,
  unpriced_calls INTEGER NOT NULL DEFAULT 0,
  context TEXT
);
CREATE INDEX IF NOT EXISTS ai_runs_spend ON ai_runs (started_at, tenant, unit);
CREATE INDEX IF NOT EXISTS ai_runs_tenant ON ai_runs (tenant, started_at);
CREATE INDEX IF NOT EXISTS ai_runs_person ON ai_runs (person, started_at);

CREATE TABLE IF NOT EXISTS ai_effects (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL,
  seq INTEGER NOT NULL,
  capability TEXT NOT NULL,
  tier TEXT,
  mode TEXT NOT NULL,
  args_hash TEXT NOT NULL,
  idempotency_key TEXT NOT NULL,
  outcome TEXT NOT NULL,
  code TEXT,
  approval_id TEXT,
  request_id TEXT NOT NULL,
  at TEXT NOT NULL,
  ms INTEGER NOT NULL,
  step TEXT,
  step_kind TEXT,
  message TEXT,
  ref TEXT,
  preview INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS ai_effects_run ON ai_effects (run_id, seq);
CREATE INDEX IF NOT EXISTS ai_effects_key ON ai_effects (idempotency_key);

CREATE TABLE IF NOT EXISTS ai_memory (
  id TEXT PRIMARY KEY,
  tenant TEXT,
  scope TEXT NOT NULL,
  subject TEXT NOT NULL,
  text TEXT NOT NULL,
  status TEXT NOT NULL,
  unit TEXT,
  run_id TEXT,
  mentions TEXT NOT NULL DEFAULT '[]',
  proposed_at TEXT NOT NULL,
  decided_at TEXT,
  decided_by TEXT,
  last_used_at TEXT
);
CREATE INDEX IF NOT EXISTS ai_memory_owner ON ai_memory (tenant, scope, subject, status);

CREATE TABLE IF NOT EXISTS ai_memory_mentions (
  memory_id TEXT NOT NULL,
  tenant TEXT,
  ref TEXT NOT NULL,
  PRIMARY KEY (memory_id, ref)
);
CREATE INDEX IF NOT EXISTS ai_memory_mentions_ref ON ai_memory_mentions (ref);

-- A thread is keyed by its tenant, its person and its id: two people may use
-- the same id and each has their own. A person with no tenant is stored with
-- tenant '' (a key column cannot be NULL and still be unique).
CREATE TABLE IF NOT EXISTS ai_threads (
  tenant TEXT NOT NULL,
  person TEXT NOT NULL,
  id TEXT NOT NULL,
  summary TEXT,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (tenant, person, id)
);
CREATE INDEX IF NOT EXISTS ai_threads_owner ON ai_threads (tenant, person, updated_at);

CREATE TABLE IF NOT EXISTS ai_turns (
  tenant TEXT NOT NULL,
  person TEXT NOT NULL,
  thread_id TEXT NOT NULL,
  seq INTEGER NOT NULL,
  message TEXT NOT NULL,
  at TEXT NOT NULL,
  PRIMARY KEY (tenant, person, thread_id, seq)
);
`,
  },
])

/** Every migration as one SQL text, for a wrangler migrations file. */
export const aiMigrationSql = (): string => AI_MIGRATIONS.map((m) => `-- ${m.id}\n${m.sql.trim()}\n`).join('\n')

/** Runs the migrations statement by statement. They are idempotent. */
export async function applyAiMigrations(db: D1DatabaseLike): Promise<void> {
  const stmts = AI_MIGRATIONS.flatMap((m) => m.sql.split(';'))
    .map((s) => s.trim())
    .filter(Boolean)
  await db.batch(stmts.map((s) => db.prepare(s)))
}

// ---------------------------------------------------------------- runs

const RUN_COLUMNS: [keyof RunRow, string][] = [
  ['id', 'id'],
  ['unit', 'unit'],
  ['unitKind', 'unit_kind'],
  ['unitVersion', 'unit_version'],
  ['promptTemplate', 'prompt_template'],
  ['promptVersion', 'prompt_version'],
  ['language', 'language'],
  ['role', 'role'],
  ['model', 'model'],
  ['seat', 'seat'],
  ['tenant', 'tenant'],
  ['person', 'person'],
  ['channel', 'channel'],
  ['requestId', 'request_id'],
  ['startedAt', 'started_at'],
  ['endedAt', 'ended_at'],
  ['outcome', 'outcome'],
  ['errorCode', 'error_code'],
  ['error', 'error'],
  ['calls', 'calls'],
  ['cacheHits', 'cache_hits'],
  ['inputTokens', 'input_tokens'],
  ['outputTokens', 'output_tokens'],
  ['cachedInputTokens', 'cached_input_tokens'],
  ['costMicros', 'cost_micros'],
  ['costEstimated', 'cost_estimated'],
  ['unpricedCalls', 'unpriced_calls'],
  ['context', 'context'],
]
const RUN_COL = new Map(RUN_COLUMNS)

function toRunValue(key: keyof RunRow, v: unknown): unknown {
  if (v === undefined) return null
  if (key === 'costEstimated') return v ? 1 : 0
  if (key === 'context') return v === null ? null : JSON.stringify(v)
  return v
}

function fromRunRow(r: Record<string, unknown>): RunRow {
  const out: Record<string, unknown> = {}
  for (const [k, col] of RUN_COLUMNS) out[k] = r[col] ?? null
  out.costEstimated = r.cost_estimated === 1
  out.context = typeof r.context === 'string' ? JSON.parse(r.context) : null
  out.unitKind = r.unit_kind as UnitKind
  out.outcome = r.outcome as RunOutcome
  return out as unknown as RunRow
}

function fromEffect(r: Record<string, unknown>): EffectRow {
  return {
    id: r.id as string,
    runId: r.run_id as string,
    seq: r.seq as number,
    capability: r.capability as string,
    tier: (r.tier as Tier | null) ?? null,
    mode: r.mode as 'read' | 'write',
    argsHash: r.args_hash as string,
    idempotencyKey: r.idempotency_key as string,
    outcome: r.outcome as EffectOutcome,
    code: (r.code as string | null) ?? null,
    approvalId: (r.approval_id as string | null) ?? null,
    requestId: r.request_id as string,
    at: r.at as string,
    ms: r.ms as number,
    step: (r.step as string | null) ?? null,
    stepKind: (r.step_kind as string | null) ?? null,
    message: (r.message as string | null) ?? null,
    ref: (r.ref as string | null) ?? null,
    preview: r.preview === 1,
  }
}

export function d1RunStore(db: D1DatabaseLike): RunStore {
  return {
    async insertRun(row) {
      const cols = RUN_COLUMNS.map(([, c]) => c)
      await db
        .prepare(`INSERT INTO ai_runs (${cols.join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`)
        .bind(...RUN_COLUMNS.map(([k]) => toRunValue(k, row[k])))
        .run()
    },
    async updateRun(id, patch) {
      const keys = (Object.keys(patch) as (keyof RunRow)[]).filter((k) => k !== 'id' && RUN_COL.has(k))
      if (!keys.length) return
      await db
        .prepare(`UPDATE ai_runs SET ${keys.map((k) => `${RUN_COL.get(k)} = ?`).join(', ')} WHERE id = ?`)
        .bind(...keys.map((k) => toRunValue(k, patch[k])), id)
        .run()
    },
    async getRun(id) {
      const r = await db.prepare('SELECT * FROM ai_runs WHERE id = ?').bind(id).first()
      return r ? fromRunRow(r) : null
    },
    async listRuns(q = {}) {
      const where: string[] = []
      const args: unknown[] = []
      if (q.tenant !== undefined) {
        where.push('tenant IS ?')
        args.push(q.tenant)
      }
      if (q.unit) {
        where.push('unit = ?')
        args.push(q.unit)
      }
      if (q.outcome) {
        where.push('outcome = ?')
        args.push(q.outcome)
      }
      const sql = `SELECT * FROM ai_runs ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY started_at DESC LIMIT ?`
      const res = await db
        .prepare(sql)
        .bind(...args, q.limit ?? 100)
        .all()
      return (res.results ?? []).map(fromRunRow)
    },
    async spend(q) {
      const where = ['started_at >= ?']
      const args: unknown[] = [q.since]
      if (q.tenant !== undefined) {
        where.push('tenant IS ?')
        args.push(q.tenant)
      }
      if (q.unit !== undefined) {
        where.push('unit = ?')
        args.push(q.unit)
      }
      if (q.person !== undefined) {
        where.push('person IS ?')
        args.push(q.person)
      }
      const r = await db
        .prepare(`SELECT COALESCE(SUM(cost_micros), 0) AS n FROM ai_runs WHERE ${where.join(' AND ')}`)
        .bind(...args)
        .first<{ n: number }>()
      return Number(r?.n ?? 0)
    },
    async insertEffect(e) {
      await db
        .prepare(
          'INSERT INTO ai_effects (id, run_id, seq, capability, tier, mode, args_hash, idempotency_key, outcome, code, approval_id, request_id, at, ms, step, step_kind, message, ref, preview) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
        )
        .bind(
          e.id,
          e.runId,
          e.seq,
          e.capability,
          e.tier,
          e.mode,
          e.argsHash,
          e.idempotencyKey,
          e.outcome,
          e.code,
          e.approvalId,
          e.requestId,
          e.at,
          e.ms,
          e.step ?? null,
          e.stepKind ?? null,
          e.message ?? null,
          e.ref ?? null,
          e.preview ? 1 : 0,
        )
        .run()
    },
    async effects(runId) {
      const res = await db.prepare('SELECT * FROM ai_effects WHERE run_id = ? ORDER BY seq').bind(runId).all()
      return (res.results ?? []).map(fromEffect)
    },
  }
}

// ---------------------------------------------------------------- memory

function fromMemory(r: Record<string, unknown>): MemoryRow {
  return {
    id: r.id as string,
    tenant: (r.tenant as string | null) ?? null,
    scope: r.scope as LongTermScope,
    subject: r.subject as string,
    text: r.text as string,
    status: r.status as MemoryStatus,
    unit: (r.unit as string | null) ?? null,
    runId: (r.run_id as string | null) ?? null,
    mentions: JSON.parse((r.mentions as string) || '[]'),
    proposedAt: r.proposed_at as string,
    decidedAt: (r.decided_at as string | null) ?? null,
    decidedBy: (r.decided_by as string | null) ?? null,
    lastUsedAt: (r.last_used_at as string | null) ?? null,
  }
}

/** The owner's visibility, as SQL: their tenant, and their own person rows or the tenant's rows. */
const VISIBLE = "tenant IS ? AND (scope = 'tenant' OR (scope = 'person' AND subject = ?))"
const visibleArgs = (o: MemoryOwner) => [o.tenant, o.person]

/** A thread's tenant as its key column holds it: '' for none. A tenant id of '' is refused, so it never meets a person with no tenant. */
function tenantKey(tenant: string | null): string {
  if (tenant === '') throw new RangeError('a tenant id cannot be empty')
  return tenant ?? ''
}
const THREAD = 'tenant = ? AND person = ? AND id = ?'
const TURNS = 'tenant = ? AND person = ? AND thread_id = ?'
const threadArgs = (t: ThreadKey): [string, string, string] => [tenantKey(t.tenant), t.person, t.id]

export function d1MemoryStore(db: D1DatabaseLike): MemoryStore {
  return {
    async insert(row) {
      const stmts = [
        db
          .prepare(
            'INSERT INTO ai_memory (id, tenant, scope, subject, text, status, unit, run_id, mentions, proposed_at, decided_at, decided_by, last_used_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
          )
          .bind(row.id, row.tenant, row.scope, row.subject, row.text, row.status, row.unit, row.runId, JSON.stringify(row.mentions), row.proposedAt, row.decidedAt, row.decidedBy, row.lastUsedAt),
        ...[...new Set(row.mentions)].map((ref) => db.prepare('INSERT INTO ai_memory_mentions (memory_id, tenant, ref) VALUES (?, ?, ?)').bind(row.id, row.tenant, ref)),
      ]
      await db.batch(stmts)
    },
    async find(o, id) {
      const r = await db
        .prepare(`SELECT * FROM ai_memory WHERE id = ? AND ${VISIBLE}`)
        .bind(id, ...visibleArgs(o))
        .first()
      return r ? fromMemory(r) : null
    },
    async list(o, q = {}) {
      const where = [VISIBLE]
      const args: unknown[] = visibleArgs(o)
      if (q.scope) {
        where.push('scope = ?')
        args.push(q.scope)
      }
      if (q.status) {
        where.push('status = ?')
        args.push(q.status)
      }
      const res = await db
        .prepare(`SELECT * FROM ai_memory WHERE ${where.join(' AND ')} ORDER BY proposed_at DESC LIMIT ?`)
        .bind(...args, q.limit ?? 100)
        .all()
      return (res.results ?? []).map(fromMemory)
    },
    async recall(o, scopes, limit) {
      if (!scopes.length) return []
      const res = await db
        .prepare(
          `SELECT * FROM ai_memory WHERE status = 'confirmed' AND scope IN (${scopes.map(() => '?').join(', ')}) AND ${VISIBLE} ORDER BY COALESCE(last_used_at, decided_at) DESC LIMIT ?`,
        )
        .bind(...scopes, ...visibleArgs(o), limit)
        .all()
      return (res.results ?? []).map(fromMemory)
    },
    async decide(o, id, patch) {
      const r = await db
        .prepare(`UPDATE ai_memory SET status = ?, decided_at = ?, decided_by = ? WHERE id = ? AND status = 'proposed' AND ${VISIBLE}`)
        .bind(patch.status, patch.decidedAt, patch.decidedBy, id, ...visibleArgs(o))
        .run()
      return (r.meta?.changes ?? 0) > 0
    },
    async touch(ids, at) {
      if (!ids.length) return
      await db
        .prepare(`UPDATE ai_memory SET last_used_at = ? WHERE id IN (${ids.map(() => '?').join(', ')})`)
        .bind(at, ...ids)
        .run()
    },
    async remove(o, id) {
      const r = await db
        .prepare(`DELETE FROM ai_memory WHERE id = ? AND ${VISIBLE}`)
        .bind(id, ...visibleArgs(o))
        .run()
      const gone = (r.meta?.changes ?? 0) > 0
      if (gone) await db.prepare('DELETE FROM ai_memory_mentions WHERE memory_id = ?').bind(id).run()
      return gone
    },
    async removeWhere(q) {
      const where: string[] = []
      const args: unknown[] = []
      if (q.tenant !== undefined) {
        where.push('tenant IS ?')
        args.push(q.tenant)
      }
      if (q.person !== undefined) {
        where.push("scope = 'person' AND subject = ?")
        args.push(q.person)
      }
      if (q.mention !== undefined) {
        where.push('id IN (SELECT memory_id FROM ai_memory_mentions WHERE ref = ?)')
        args.push(q.mention)
      }
      if (!where.length) throw new Error('removeWhere needs a tenant, a person or a mention')
      const res = await db
        .prepare(`SELECT id FROM ai_memory WHERE ${where.join(' AND ')}`)
        .bind(...args)
        .all<{ id: string }>()
      const ids = (res.results ?? []).map((r) => r.id)
      // In chunks under D1's 100 bound parameters.
      for (let i = 0; i < ids.length; i += 90) {
        const chunk = ids.slice(i, i + 90)
        const marks = chunk.map(() => '?').join(', ')
        await db.batch([
          db.prepare(`DELETE FROM ai_memory_mentions WHERE memory_id IN (${marks})`).bind(...chunk),
          db.prepare(`DELETE FROM ai_memory WHERE id IN (${marks})`).bind(...chunk),
        ])
      }
      return ids.length
    },

    async appendTurns(t, turns, at) {
      const k = threadArgs(t)
      const th = await db.prepare(`SELECT 1 AS n FROM ai_threads WHERE ${THREAD}`).bind(...k).first()
      const last = await db.prepare(`SELECT COALESCE(MAX(seq), 0) AS n FROM ai_turns WHERE ${TURNS}`).bind(...k).first<{ n: number }>()
      let seq = Number(last?.n ?? 0)
      await db.batch([
        th
          ? db.prepare(`UPDATE ai_threads SET updated_at = ? WHERE ${THREAD}`).bind(at, ...k)
          : db.prepare('INSERT INTO ai_threads (tenant, person, id, summary, updated_at) VALUES (?, ?, ?, NULL, ?)').bind(...k, at),
        ...turns.map((m) => db.prepare('INSERT INTO ai_turns (tenant, person, thread_id, seq, message, at) VALUES (?, ?, ?, ?, ?, ?)').bind(...k, ++seq, JSON.stringify(m), at)),
      ])
    },
    async thread(t, limit) {
      const k = threadArgs(t)
      const th = await db.prepare(`SELECT summary FROM ai_threads WHERE ${THREAD}`).bind(...k).first<{ summary: string | null }>()
      if (!th) return { summary: null, turns: [] }
      const res = await db
        .prepare(`SELECT message FROM (SELECT seq, message FROM ai_turns WHERE ${TURNS} ORDER BY seq DESC LIMIT ?) ORDER BY seq`)
        .bind(...k, limit)
        .all<{ message: string }>()
      return { summary: th.summary ?? null, turns: (res.results ?? []).map((r) => JSON.parse(r.message) as Message) }
    },
    async compactThread(t, summary, keep) {
      const k = threadArgs(t)
      const th = await db.prepare(`SELECT 1 AS n FROM ai_threads WHERE ${THREAD}`).bind(...k).first()
      if (!th) return
      await db.batch([
        db.prepare(`UPDATE ai_threads SET summary = ? WHERE ${THREAD}`).bind(summary, ...k),
        db.prepare(`DELETE FROM ai_turns WHERE ${TURNS} AND seq NOT IN (SELECT seq FROM ai_turns WHERE ${TURNS} ORDER BY seq DESC LIMIT ?)`).bind(...k, ...k, Math.max(0, keep)),
      ])
    },
    async removeThreads(q) {
      const where: string[] = []
      const args: unknown[] = []
      if (q.tenant !== undefined) {
        where.push('tenant = ?')
        args.push(tenantKey(q.tenant))
      }
      if (q.person !== undefined) {
        where.push('person = ?')
        args.push(q.person)
      }
      if (!where.length) throw new Error('removeThreads needs a tenant or a person')
      const cond = where.join(' AND ')
      const [, del] = await db.batch([db.prepare(`DELETE FROM ai_turns WHERE ${cond}`).bind(...args), db.prepare(`DELETE FROM ai_threads WHERE ${cond}`).bind(...args)])
      return del?.meta?.changes ?? 0
    },
    async listThreads(o, q) {
      const limit = threadPageSize(q)
      const after = q?.cursor ? readThreadCursor(q.cursor) : null
      // ai_threads_owner (tenant, person, updated_at) finds the owner's rows in order.
      const res = await db
        .prepare(
          `SELECT id, summary, updated_at FROM ai_threads WHERE tenant = ? AND person = ?${after ? ' AND (updated_at < ? OR (updated_at = ? AND id < ?))' : ''} ORDER BY updated_at DESC, id DESC LIMIT ?`,
        )
        .bind(tenantKey(o.tenant), o.person, ...(after ? [after.updatedAt, after.updatedAt, after.id] : []), limit + 1)
        .all<{ id: string; summary: string | null; updated_at: string }>()
      const rows = (res.results ?? []).map((r): ThreadListItem => ({ id: r.id, summary: r.summary ?? null, updatedAt: r.updated_at }))
      const page = rows.slice(0, limit)
      return { threads: page, next: rows.length > limit ? threadCursor(page.at(-1)!) : null }
    },
  }
}


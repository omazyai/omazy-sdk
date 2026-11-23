// Cloudflare D1 adapter for the flow store, and the SQL it needs. Apply
// FLOW_MIGRATIONS once (wrangler migrations, or applyFlowMigrations), in the
// same database as the ai kit's tables or beside them. The steps of a run are
// not here: they are rows in the ai kit's effects ledger (ai_effects).
// flow_runs, flow_links and flow_automations hold what orchestration needs.

import type { D1DatabaseLike } from '../guard/d1.js'
import type { AutomationRow, FlowRunRow, FlowStore } from './types.js'

/** The kit's tables. Additive only: a later migration adds, never changes. */
export const FLOW_MIGRATIONS: readonly { id: string; sql: string }[] = Object.freeze([
  {
    id: '0001_flows',
    sql: `
CREATE TABLE IF NOT EXISTS flow_runs (
  id TEXT PRIMARY KEY,
  workflow TEXT NOT NULL,
  workflow_version INTEGER NOT NULL,
  mode TEXT NOT NULL,
  status TEXT NOT NULL,
  automation TEXT,
  tenant TEXT,
  person TEXT,
  reason TEXT,
  cost_micros INTEGER NOT NULL DEFAULT 0,
  reported INTEGER NOT NULL DEFAULT 0,
  report TEXT NOT NULL DEFAULT '[]',
  started_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  ended_at TEXT
);
CREATE INDEX IF NOT EXISTS flow_runs_automation ON flow_runs (automation, tenant, started_at);
CREATE INDEX IF NOT EXISTS flow_runs_tenant ON flow_runs (tenant, started_at);

CREATE TABLE IF NOT EXISTS flow_links (
  kind TEXT NOT NULL,
  ref TEXT NOT NULL,
  run_id TEXT NOT NULL,
  event_type TEXT NOT NULL,
  PRIMARY KEY (kind, ref)
);

CREATE TABLE IF NOT EXISTS flow_automations (
  id TEXT NOT NULL,
  tenant TEXT NOT NULL DEFAULT '',
  on_ INTEGER NOT NULL,
  mode TEXT NOT NULL,
  role TEXT NOT NULL,
  enabled_by TEXT NOT NULL,
  seat TEXT,
  enabled_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  stopped_reason TEXT,
  PRIMARY KEY (id, tenant)
)`,
  },
])

export const flowMigrationSql = (): string => FLOW_MIGRATIONS.map((m) => `-- ${m.id}\n${m.sql.trim()};\n`).join('\n')

/** Runs the migrations statement by statement. They are idempotent. */
export async function applyFlowMigrations(db: D1DatabaseLike): Promise<void> {
  const stmts = FLOW_MIGRATIONS.flatMap((m) => m.sql.split(';'))
    .map((s) => s.trim())
    .filter(Boolean)
  await db.batch(stmts.map((s) => db.prepare(s)))
}

type Rec = Record<string, unknown>
const str = (v: unknown) => (v == null ? null : String(v))

const RUN_COLS: Record<keyof FlowRunRow, string> = {
  id: 'id',
  workflow: 'workflow',
  workflowVersion: 'workflow_version',
  mode: 'mode',
  status: 'status',
  automation: 'automation',
  tenant: 'tenant',
  person: 'person',
  reason: 'reason',
  costMicros: 'cost_micros',
  reported: 'reported',
  report: 'report',
  startedAt: 'started_at',
  updatedAt: 'updated_at',
  endedAt: 'ended_at',
}
const runVal = (k: keyof FlowRunRow, v: unknown) => (k === 'reported' ? (v ? 1 : 0) : k === 'report' ? JSON.stringify(v ?? []) : (v ?? null))
const runOf = (r: Rec): FlowRunRow => ({
  id: String(r.id),
  workflow: String(r.workflow),
  workflowVersion: Number(r.workflow_version),
  mode: r.mode as FlowRunRow['mode'],
  status: r.status as FlowRunRow['status'],
  automation: str(r.automation),
  tenant: str(r.tenant),
  person: str(r.person),
  reason: str(r.reason),
  costMicros: Number(r.cost_micros ?? 0),
  reported: Number(r.reported) === 1,
  report: JSON.parse(String(r.report ?? '[]')),
  startedAt: String(r.started_at),
  updatedAt: String(r.updated_at),
  endedAt: str(r.ended_at),
})
const autoOf = (r: Rec): AutomationRow => ({
  id: String(r.id),
  tenant: r.tenant === '' || r.tenant == null ? null : String(r.tenant),
  on: Number(r.on_) === 1,
  mode: r.mode as AutomationRow['mode'],
  role: String(r.role),
  enabledBy: JSON.parse(String(r.enabled_by)),
  seat: r.seat ? JSON.parse(String(r.seat)) : null,
  enabledAt: String(r.enabled_at),
  updatedAt: String(r.updated_at),
  stoppedReason: str(r.stopped_reason),
})

export function d1FlowStore(db: D1DatabaseLike): FlowStore {
  return {
    async claimRun(row) {
      const keys = Object.keys(RUN_COLS) as (keyof FlowRunRow)[]
      const r = await db
        .prepare(`INSERT INTO flow_runs (${keys.map((k) => RUN_COLS[k]).join(', ')}) VALUES (${keys.map(() => '?').join(', ')}) ON CONFLICT (id) DO NOTHING`)
        .bind(...keys.map((k) => runVal(k, row[k])))
        .run()
      return (r.meta?.changes ?? 0) > 0
    },
    async getRun(id) {
      const r = await db.prepare('SELECT * FROM flow_runs WHERE id = ?').bind(id).first<Rec>()
      return r ? runOf(r) : null
    },
    async updateRun(id, patch) {
      const keys = (Object.keys(patch) as (keyof FlowRunRow)[]).filter((k) => k !== 'id' && k in RUN_COLS)
      if (!keys.length) return
      await db
        .prepare(`UPDATE flow_runs SET ${keys.map((k) => `${RUN_COLS[k]} = ?`).join(', ')} WHERE id = ?`)
        .bind(...keys.map((k) => runVal(k, patch[k])), id)
        .run()
    },
    async listRuns(q = {}) {
      const where: string[] = []
      const args: unknown[] = []
      if (q.automation !== undefined) where.push('automation = ?') && args.push(q.automation)
      if (q.tenant !== undefined) q.tenant === null ? where.push('tenant IS NULL') : where.push('tenant = ?') && args.push(q.tenant)
      if (q.status) where.push('status = ?') && args.push(q.status)
      const r = await db
        .prepare(`SELECT * FROM flow_runs ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY started_at DESC LIMIT ?`)
        .bind(...args, q.limit ?? 100)
        .all<Rec>()
      return (r.results ?? []).map(runOf)
    },
    async usage(q) {
      const r = await db
        .prepare(
          `SELECT COUNT(*) AS n, COALESCE(SUM(cost_micros), 0) AS cost FROM flow_runs
           WHERE automation = ? AND ${q.tenant === null ? 'tenant IS NULL' : 'tenant = ?'} AND started_at >= ? AND status NOT IN ('refused', 'nothing')`,
        )
        .bind(...(q.tenant === null ? [q.automation, q.since] : [q.automation, q.tenant, q.since]))
        .first<{ n: number; cost: number }>()
      return { runs: Number(r?.n ?? 0), costMicros: Number(r?.cost ?? 0) }
    },
    async link(kind, ref, runId, eventType) {
      await db
        .prepare('INSERT INTO flow_links (kind, ref, run_id, event_type) VALUES (?, ?, ?, ?) ON CONFLICT (kind, ref) DO UPDATE SET run_id = excluded.run_id, event_type = excluded.event_type')
        .bind(kind, ref, runId, eventType)
        .run()
    },
    async linked(kind, ref) {
      const r = await db.prepare('SELECT run_id, event_type FROM flow_links WHERE kind = ? AND ref = ?').bind(kind, ref).first<Rec>()
      return r ? { runId: String(r.run_id), eventType: String(r.event_type) } : null
    },
    async getAutomation(id, tenant) {
      const r = await db.prepare('SELECT * FROM flow_automations WHERE id = ? AND tenant = ?').bind(id, tenant ?? '').first<Rec>()
      return r ? autoOf(r) : null
    },
    async putAutomation(a) {
      await db
        .prepare(
          `INSERT INTO flow_automations (id, tenant, on_, mode, role, enabled_by, seat, enabled_at, updated_at, stopped_reason) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT (id, tenant) DO UPDATE SET on_ = excluded.on_, mode = excluded.mode, role = excluded.role, enabled_by = excluded.enabled_by,
             seat = excluded.seat, enabled_at = excluded.enabled_at, updated_at = excluded.updated_at, stopped_reason = excluded.stopped_reason`,
        )
        .bind(a.id, a.tenant ?? '', a.on ? 1 : 0, a.mode, a.role, JSON.stringify(a.enabledBy), a.seat ? JSON.stringify(a.seat) : null, a.enabledAt, a.updatedAt, a.stoppedReason)
        .run()
    },
    async listAutomations(q = {}) {
      const where: string[] = []
      const args: unknown[] = []
      if (q.tenant !== undefined) where.push('tenant = ?') && args.push(q.tenant ?? '')
      if (q.on !== undefined) where.push('on_ = ?') && args.push(q.on ? 1 : 0)
      const r = await db
        .prepare(`SELECT * FROM flow_automations ${where.length ? `WHERE ${where.join(' AND ')}` : ''}`)
        .bind(...args)
        .all<Rec>()
      return (r.results ?? []).map(autoOf)
    },
  }
}

// Deleting a tenant's rows table by table, inside D1's limits: each
// statement binds a handful of values (never near 100), each deletes at most
// `chunk` rows, and one invocation runs at most `maxChunks` statements. The
// cursor it returns lets a Workflow step, a queue or a cron carry on where it
// stopped. Export the tenant first; the purge does not.

import type { D1DatabaseLike } from './d1.js'

const IDENT = /^[A-Za-z_][A-Za-z0-9_]*$/
export const D1_MAX_BOUND = 100

export interface PurgeTable {
  table: string
  /** The column holding the tenant id. Default `tenant_id`. */
  tenantColumn?: string
  /** A unique key to delete by. Default `rowid`; name one for a WITHOUT ROWID table. */
  key?: string
  /** Rows to keep, such as payments kept for seven years: `{ sql: "kind = ?", params: ['payment'] }`. */
  keepWhere?: { sql: string; params?: readonly unknown[] }
}

export interface PurgePlan {
  /** In order: children before parents when there are foreign keys. */
  tables: readonly PurgeTable[]
  /** Tables that are never purged. A plan that names one is refused. */
  keep?: readonly string[]
  /** Tenants that can never be purged. */
  protectedTenants?: readonly string[]
}

export interface PurgeCursor {
  /** Index into `plan.tables` of the next table. */
  table: number
  deleted: Record<string, number>
  done: boolean
}

export interface PurgeOptions {
  cursor?: PurgeCursor
  /** Rows per statement. Default 500. */
  chunk?: number
  /** Statements per invocation. Default 40. */
  maxChunks?: number
}

/** Throws on anything unsafe in a plan. Run it in a test, so a bad plan fails before it meets data. */
export function checkPurgePlan(plan: PurgePlan): void {
  const keep = new Set(plan.keep ?? [])
  for (const t of plan.tables) {
    for (const name of [t.table, t.tenantColumn ?? 'tenant_id', t.key ?? 'rowid']) if (!IDENT.test(name)) throw new Error(`not a plain SQL name: ${name}`)
    if (keep.has(t.table)) throw new Error(`${t.table} is on the keep list and cannot be purged`)
    if (t.keepWhere && /;|--|\/\*/.test(t.keepWhere.sql)) throw new Error(`${t.table}: keepWhere must be one condition`)
    if (2 + (t.keepWhere?.params?.length ?? 0) > D1_MAX_BOUND) throw new Error(`${t.table}: too many bound values for D1`)
  }
}

/** Runs the purge for up to `maxChunks` statements. Call again with the cursor until `done`. */
export async function purgeTenant(db: D1DatabaseLike, tenant: string, plan: PurgePlan, opts: PurgeOptions = {}): Promise<PurgeCursor> {
  if (!tenant) throw new Error('purge needs a tenant id')
  if (plan.protectedTenants?.includes(tenant)) throw new Error(`tenant ${tenant} can never be purged`)
  checkPurgePlan(plan)
  const chunk = Math.max(1, Math.min(opts.chunk ?? 500, 10_000))
  let budget = Math.max(1, opts.maxChunks ?? 40)
  const cur: PurgeCursor = opts.cursor ? { table: opts.cursor.table, deleted: { ...opts.cursor.deleted }, done: opts.cursor.done } : { table: 0, deleted: {}, done: false }
  while (cur.table < plan.tables.length && budget > 0) {
    const t = plan.tables[cur.table]!
    const col = t.tenantColumn ?? 'tenant_id'
    const key = t.key ?? 'rowid'
    const keep = t.keepWhere ? ` AND NOT (${t.keepWhere.sql})` : ''
    const sql = `DELETE FROM ${t.table} WHERE ${key} IN (SELECT ${key} FROM ${t.table} WHERE ${col} = ?${keep} LIMIT ?)`
    const r = await db
      .prepare(sql)
      .bind(tenant, ...(t.keepWhere?.params ?? []), chunk)
      .run()
    budget--
    const n = r.meta?.changes ?? 0
    cur.deleted[t.table] = (cur.deleted[t.table] ?? 0) + n
    if (n < chunk) cur.table++
  }
  cur.done = cur.table >= plan.tables.length
  return cur
}

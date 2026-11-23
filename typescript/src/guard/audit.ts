// The product's own audit row, carrying who acted through what: `via` (the
// channel), `approval_id` and `request_id`. The statement is returned, not
// run, so the product batches it with the change it records.

import type { BaseCtx } from '../capabilities/capability.js'
import type { D1DatabaseLike, D1PreparedStatementLike } from './d1.js'

export interface AuditFields {
  via: string
  approval_id: string | null
  request_id: string
}

/** The three columns every audit row gets from the ctx. */
export const auditFields = (ctx: BaseCtx): AuditFields => ({ via: ctx.channel, approval_id: ctx.approvalId ?? null, request_id: ctx.requestId })

const IDENT = /^[A-Za-z_][A-Za-z0-9_]*$/

export interface AuditStatementOptions {
  /** Default `audit_log`. */
  table?: string
  /** Column names for the three fields, when the product's differ. */
  columns?: Partial<Record<keyof AuditFields, string>>
}

/**
 * An INSERT into the product's audit table with the ctx fields and the
 * change's own columns. Objects are written as JSON.
 *
 *     await env.DB.batch([updateDevice, auditStatement(env.DB, ctx, { action: 'device.approve', target: id, actor_id: ctx.principal.id })])
 */
export function auditStatement(db: D1DatabaseLike, ctx: BaseCtx, change: Record<string, unknown>, opts: AuditStatementOptions = {}): D1PreparedStatementLike {
  const table = opts.table ?? 'audit_log'
  const f = auditFields(ctx)
  const row: Record<string, unknown> = {}
  for (const k of Object.keys(f) as (keyof AuditFields)[]) row[opts.columns?.[k] ?? k] = f[k]
  for (const [k, v] of Object.entries(change)) if (v !== undefined) row[k] = v !== null && typeof v === 'object' ? JSON.stringify(v) : v
  const cols = Object.keys(row)
  for (const name of [table, ...cols]) if (!IDENT.test(name)) throw new Error(`not a plain SQL name: ${name}`)
  if (cols.length > 100) throw new Error('an audit row may bind at most 100 values')
  return db.prepare(`INSERT INTO ${table} (${cols.join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`).bind(...cols.map((c) => row[c]))
}

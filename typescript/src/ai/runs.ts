// The run record and the effects ledger. One row per run of a unit, with its
// version, prompt version, who ran it, where, how it ended, and the tokens and
// cost the platform reported. One row per capability call the run made
// through the guard, refused ones included. Both live in the product's
// database through a store adapter.

import type { Tier } from '../capabilities/tiers.js'
import type { BuiltContext } from './context.js'
import type { UnitKind } from './manifest.js'

/** What the context builder reported for a call: tokens per layer, what was dropped, compaction. */
export type ContextReport = Pick<BuiltContext, 'tokens' | 'layers' | 'compaction'>

export type RunOutcome =
  | 'running'
  | 'ok'
  /** A cap stopped it: the kit's own check before a call, or the platform's 402. */
  | 'refused_cap'
  /** The reply did not match the output schema. Nothing was saved. */
  | 'invalid_output'
  | 'error'
  | 'cancelled'

export interface RunRow {
  id: string
  unit: string
  unitKind: UnitKind
  unitVersion: number
  promptTemplate: string
  promptVersion: number
  language: string
  /** The role the unit asked for. */
  role: string
  /** The model the last call ran on, as the platform reported it. */
  model: string | null
  seat: string | null
  tenant: string | null
  person: string | null
  channel: string
  requestId: string
  startedAt: string
  endedAt: string | null
  outcome: RunOutcome
  errorCode: string | null
  error: string | null
  calls: number
  cacheHits: number
  inputTokens: number
  outputTokens: number
  cachedInputTokens: number
  /** Millionths of a US dollar: what the platform reported, else priced from the product's rate card. */
  costMicros: number
  /** True when any part of the cost came from the rate card rather than the platform. */
  costEstimated: boolean
  /** Calls with no price from the platform or the rate card. Not in costMicros. */
  unpricedCalls: number
  /** The context builder's report of the last call: tokens per layer, drops, compaction. */
  context: ContextReport | null
}

/**
 * Every way one effect of a run can end: the guard's outcomes, the kit's own
 * refusals before the guard, and the states of a workflow step that a
 * workflow records itself (`ai.recordInRun`).
 */
export type EffectOutcome =
  | 'ok'
  | 'refused_permission'
  | 'refused_tier'
  | 'read_only'
  | 'pending_approval'
  | 'confirm_required'
  | 'stale'
  | 'rate_limited'
  | 'invalid'
  | 'not_found'
  | 'switched_off'
  | 'error'
  /** Not in the unit's tools, or above its highest tier. The guard was not asked. */
  | 'refused_unit'
  /** The same write was already made in this run. Writes are never sent twice. */
  | 'duplicate'
  /** A dry run's preview: the guard's checks passed and the capability's preview ran; nothing changed. `preview` is true. */
  | 'planned'
  /** Not run on purpose: a condition, a capability not built yet, nothing to report. `code` says which. */
  | 'skipped'
  /** Started and not ended: waiting for an approval, an actor session or a person. */
  | 'waiting'
  /** It ran and failed, or nobody settled it in time. Not retried. */
  | 'failed'
  /** A workflow refused it for a reason of its own: a budget, an approval refused or expired. `code` says which. */
  | 'refused'

/** The outcomes a workflow records itself through `ai.recordInRun`. The rest come from the guard and the kit. */
export const RECORDED_OUTCOMES: readonly EffectOutcome[] = ['ok', 'planned', 'skipped', 'waiting', 'failed', 'refused', 'stale']

export interface EffectRow {
  id: string
  runId: string
  /** 1, 2, 3 within the run. */
  seq: number
  capability: string
  tier: Tier | null
  mode: 'read' | 'write'
  argsHash: string
  /** SHA-256 of the tenant, the capability and the canonical arguments: the intended effect. */
  idempotencyKey: string
  outcome: EffectOutcome
  code: string | null
  approvalId: string | null
  requestId: string
  at: string
  ms: number
  /** The workflow step that made it, such as `level` or `add#2` for a bulk chunk. Null outside a workflow. */
  step: string | null
  /** The step's kind: `read`, `write`, `task`, `actor`, `notify` or `bulk`. */
  stepKind: string | null
  /** A plain sentence: the guard's refusal, the preview's summary, why a step was skipped. */
  message: string | null
  /** The task's own run, or the actor session, a step started. */
  ref: string | null
  /** True for a dry run's preview-only effect: nothing ran. */
  preview: boolean
}

export interface RunQuery {
  tenant?: string | null
  unit?: string
  outcome?: RunOutcome
  limit?: number
}

export interface SpendQuery {
  /** ISO time; runs started at or after it. */
  since: string
  tenant?: string | null
  unit?: string
  person?: string | null
}

export interface RunStore {
  insertRun(row: RunRow): Promise<void>
  updateRun(id: string, patch: Partial<RunRow>): Promise<void>
  getRun(id: string): Promise<RunRow | null>
  listRuns(q?: RunQuery): Promise<RunRow[]>
  /** The cost of runs since a time, filtered by any of tenant, unit and person, in micros. */
  spend(q: SpendQuery): Promise<number>
  insertEffect(row: EffectRow): Promise<void>
  /** In seq order. */
  effects(runId: string): Promise<EffectRow[]>
}

const clone = <T>(v: T): T => structuredClone(v)

export function memoryRunStore(): RunStore & { runs: Map<string, RunRow>; effectRows: EffectRow[] } {
  const runs = new Map<string, RunRow>()
  const effectRows: EffectRow[] = []
  return {
    runs,
    effectRows,
    async insertRun(row) {
      if (runs.has(row.id)) throw new Error(`run ${row.id} exists`)
      runs.set(row.id, clone(row))
    },
    async updateRun(id, patch) {
      const row = runs.get(id)
      if (row) runs.set(id, { ...row, ...clone(patch), id })
    },
    async getRun(id) {
      const r = runs.get(id)
      return r ? clone(r) : null
    },
    async listRuns(q = {}) {
      let rows = [...runs.values()]
      if (q.tenant !== undefined) rows = rows.filter((r) => r.tenant === q.tenant)
      if (q.unit) rows = rows.filter((r) => r.unit === q.unit)
      if (q.outcome) rows = rows.filter((r) => r.outcome === q.outcome)
      rows.sort((a, b) => b.startedAt.localeCompare(a.startedAt))
      return clone(rows.slice(0, q.limit ?? 100))
    },
    async spend(q) {
      let n = 0
      for (const r of runs.values()) {
        if (r.startedAt < q.since) continue
        if (q.tenant !== undefined && r.tenant !== q.tenant) continue
        if (q.unit !== undefined && r.unit !== q.unit) continue
        if (q.person !== undefined && r.person !== q.person) continue
        n += r.costMicros
      }
      return n
    },
    async insertEffect(row) {
      effectRows.push(clone(row))
    },
    async effects(runId) {
      return clone(effectRows.filter((e) => e.runId === runId).sort((a, b) => a.seq - b.seq))
    },
  }
}

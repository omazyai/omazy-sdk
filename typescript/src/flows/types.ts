// The flows kit's types: step specs, the rows its store keeps, what a runner
// gives the engine, and what the product plugs in. Everything a workflow
// carries between steps is plain JSON, because Cloudflare Workflows keeps
// each step's result and replays the run from them.

import type { ActorRuntime } from '../actors/runtime.js'
import type { Ai } from '../ai/ai.js'
import type { EffectOutcome, EffectRow } from '../ai/runs.js'
import type { AnyUnit } from '../ai/manifest.js'
import type { BaseCtx, Principal, Seat } from '../capabilities/capability.js'
import type { Registry } from '../capabilities/registry.js'
import type { Tier } from '../capabilities/tiers.js'
import type { Guard, SwitchStore } from '../guard/types.js'

// ---------------------------------------------------------------- limits

/**
 * The limits a run is held to. A bulk chunk is one durable step, so it must
 * stay inside one Worker invocation (subrequests) and inside D1's bound
 * values per statement; the steps of a run stay inside a Workflow's step cap.
 */
export const FLOW_LIMITS = Object.freeze({
  /** Default items per bulk chunk. */
  chunk: 25,
  /** Most items per bulk chunk: D1 binds at most 100 values per statement, and each item is at least one call. */
  maxChunk: 100,
  /** Most durable steps one run may take. Cloudflare's default cap is 1,024 on the free plan. */
  maxSteps: 1000,
  /** Default wait for an approval past its own expiry, and for a person to settle a failed write. */
  resolveTimeoutMs: 7 * 86_400_000,
})

// ---------------------------------------------------------------- steps

/** The outputs so far, by step id, and the run's `input`. */
export type FlowState = { input: any; [step: string]: any }

export type StepKind = 'read' | 'write' | 'task' | 'actor' | 'notify' | 'bulk'

/** Cloudflare's retry settings for one step. `delay` in milliseconds. */
export interface RetryConfig {
  limit: number
  delay?: number
  backoff?: 'constant' | 'linear' | 'exponential'
}

interface StepBase {
  /** Lower case words joined by `_`. Its output is `s[id]` for later steps. */
  id: string
  kind: StepKind
  /** Runs the step only when this holds. Must read only `s`: it is evaluated again on every replay. */
  when?: (s: FlowState) => boolean
}

export interface CapabilityStep extends StepBase {
  kind: 'read' | 'write'
  capability: string
  /** The arguments, from the state. Default: the run's input. */
  args?: (s: FlowState) => unknown
  /**
   * `not_built`: when the capability is not in the registry, the step is
   * recorded `skipped` and `todo` goes to a person instead. A function gives
   * a reason to skip, or nothing to run.
   */
  skipIf?: 'not_built' | ((s: FlowState) => string | false | null | undefined)
  /** What a person should do by hand when the capability is not built, such as "mark INV-0042 paid". */
  todo?: (s: FlowState) => string
  /** After a step that ended `done`: a reason here ends the run `stopped`, such as "the payment is not for billing". */
  stop?: (output: any, s: FlowState) => string | false | null | undefined
  /** Read steps only. Default: the runner's own (Cloudflare: 5 tries, exponential). Writes never retry. */
  retries?: RetryConfig
  /** Write steps only: the person already confirmed this R2 change upstream, such as the form that started the run. */
  confirm?: 'upstream'
}

export interface TaskStep extends StepBase {
  kind: 'task'
  unit: AnyUnit
  input: (s: FlowState) => unknown
}

export interface ActorStep extends StepBase {
  kind: 'actor'
  actor: string
  prefill?: (s: FlowState) => Readonly<Record<string, unknown>>
  /** How long to wait for the person. Default 7 days. */
  timeout?: string | number
}

export interface NotifyStep extends StepBase {
  kind: 'notify'
  /** The product's template name. Notices are fixed templates, never model text. */
  template: string
  data?: (s: FlowState) => Readonly<Record<string, unknown>>
}

export interface BulkStep extends StepBase {
  kind: 'bulk'
  capability: string
  /** Every item, from the state (an earlier read step). */
  items: (s: FlowState) => readonly unknown[]
  args: (item: any, s: FlowState) => unknown
  /** Items per chunk, at most `FLOW_LIMITS.maxChunk`. Default 25. */
  chunk?: number
  /** R2 items the person already confirmed upstream, such as an import they submitted. R3 and above are not for bulk steps. */
  confirm?: 'upstream'
}

export type FlowStep = CapabilityStep | TaskStep | ActorStep | NotifyStep | BulkStep

// ---------------------------------------------------------------- the ledger

export type FlowMode = 'live' | 'dry_run'

/** Where one step is: the latest of its rows in the ai kit's effects ledger. */
export type StepStatus = 'planned' | 'skipped' | 'waiting' | 'ok' | 'refused' | 'failed'

/**
 * - `running`, `waiting`: started, not ended; `waiting` for an approval, an actor or a person
 * - `ok`: every step ran or was skipped. The same word as the guard's and the ai ledger's outcome
 * - `stopped`: a step's `stop`, a refused read, a person, the owner's role or the budget ended it
 * - `failed`: a step failed and nobody settled it in time
 * - `refused`: never started: the budget, a switch or the owner's role refused it
 * - `nothing`: a condition found nothing to do; recorded, not delivered
 */
export type FlowStatus = 'queued' | 'running' | 'waiting' | 'ok' | 'stopped' | 'failed' | 'refused' | 'nothing'

export interface FlowRunRow {
  /** The run's key, such as `fulfil:pay_42`. One run per key. Also the id of its row in the ai kit's run store. */
  id: string
  workflow: string
  workflowVersion: number
  mode: FlowMode
  status: FlowStatus
  automation: string | null
  tenant: string | null
  person: string | null
  reason: string | null
  /** Model spend by the run's task steps, millionths of a US dollar. */
  costMicros: number
  /** Notices delivered. False on a "nothing to report" run and on a dry run. */
  reported: boolean
  /** In dry run, what each write would have done. */
  report: string[]
  startedAt: string
  updatedAt: string
  endedAt: string | null
}

/**
 * One step of a run, read from the ai kit's effects ledger (`flowSteps`). The
 * ledger keeps every row a step wrote; this is where the step stands now.
 */
export interface FlowStepRow {
  runId: string
  /** The step id, or `<id>#<n>` for chunk n of a bulk step. */
  key: string
  /** 1, 2, 3 in the order the run reached the steps. */
  seq: number
  kind: StepKind
  /** The capability, unit, actor or template. */
  target: string
  tier: Tier | null
  status: StepStatus
  /** Why: `not_built`, `condition`, `nothing_to_report`, a guard refusal code, `expired`. */
  code: string | null
  /** The ledger outcome of its latest row, such as `pending_approval` or `refused_permission`. */
  outcome: EffectOutcome
  message: string | null
  approvalId: string | null
  /** The task's own run, or the actor session. */
  ref: string | null
  /** The ai kit's idempotency key of the step's capability call: the tenant, the capability and the arguments. */
  idempotencyKey: string | null
  /** True when the step's latest row is a dry run's preview. */
  preview: boolean
  at: string
  updatedAt: string
}

const STEP_STATUS: Partial<Record<EffectOutcome, StepStatus>> = {
  ok: 'ok',
  duplicate: 'ok',
  planned: 'planned',
  skipped: 'skipped',
  waiting: 'waiting',
  pending_approval: 'waiting',
  failed: 'failed',
  error: 'failed',
}

/** Folds a run's ledger rows into one row per step, in the order the run reached them. Rows with no step are left out. */
export function stepsFromEffects(effects: readonly EffectRow[]): FlowStepRow[] {
  const out = new Map<string, FlowStepRow>()
  for (const e of [...effects].sort((a, b) => a.seq - b.seq)) {
    if (!e.step) continue
    const prev = out.get(e.step)
    const status = STEP_STATUS[e.outcome] ?? 'refused'
    out.set(e.step, {
      runId: e.runId,
      key: e.step,
      seq: prev?.seq ?? out.size + 1,
      kind: (e.stepKind ?? prev?.kind ?? 'read') as StepKind,
      target: e.capability,
      tier: e.tier ?? prev?.tier ?? null,
      status,
      outcome: e.outcome,
      code: e.code ?? (status === 'refused' || (status === 'failed' && e.outcome !== 'failed') ? e.outcome : null),
      message: e.message,
      approvalId: e.approvalId ?? prev?.approvalId ?? null,
      ref: e.ref ?? prev?.ref ?? null,
      idempotencyKey: prev?.idempotencyKey ?? (e.idempotencyKey || null),
      preview: e.preview,
      at: prev?.at ?? e.at,
      updatedAt: e.at,
    })
  }
  return [...out.values()]
}

export interface AutomationRow {
  id: string
  tenant: string | null
  on: boolean
  mode: FlowMode
  /** The role the person who enabled it held, and must keep. */
  role: string
  enabledBy: Principal
  seat: Seat | null
  enabledAt: string
  updatedAt: string
  /** Why it went off, such as `owner_lost_role`. */
  stoppedReason: string | null
}

export interface RunUsageQuery {
  automation: string
  tenant: string | null
  /** ISO time. */
  since: string
}

export interface FlowStore {
  /** Inserts the row unless one with its id exists. True when inserted. */
  claimRun(row: FlowRunRow): Promise<boolean>
  getRun(id: string): Promise<FlowRunRow | null>
  updateRun(id: string, patch: Partial<FlowRunRow>): Promise<void>
  listRuns(q?: { automation?: string; tenant?: string | null; status?: FlowStatus; limit?: number }): Promise<FlowRunRow[]>
  /** Runs that started (not `refused` or `nothing`) and their spend, since a time. */
  usage(q: RunUsageQuery): Promise<{ runs: number; costMicros: number }>
  /** What wakes a waiting run: an approval or an actor session, to the run and the event type. */
  link(kind: 'approval' | 'actor', ref: string, runId: string, eventType: string): Promise<void>
  linked(kind: 'approval' | 'actor', ref: string): Promise<{ runId: string; eventType: string } | null>
  getAutomation(id: string, tenant: string | null): Promise<AutomationRow | null>
  putAutomation(row: AutomationRow): Promise<void>
  listAutomations(q?: { tenant?: string | null; on?: boolean }): Promise<AutomationRow[]>
}

// ---------------------------------------------------------------- what a runner gives the engine

export type WaitResult<T = unknown> = { payload: T } | { timedOut: true }

/**
 * The durable step API, as Cloudflare's `WorkflowStep` has it. A runner keeps
 * each `do` result by name and replays the run from them, so code between
 * steps must read only earlier results.
 */
export interface StepHost {
  do<T>(name: string, config: { retries?: RetryConfig } | undefined, fn: () => Promise<T>): Promise<T>
  waitForEvent<T = unknown>(name: string, opts: { type: string; timeoutMs: number }): Promise<WaitResult<T>>
}

/** What starts a run, as a workflow's params. Plain JSON. */
export interface FlowParams {
  /** The run's key, such as `fulfil:pay_42`. */
  key: string
  workflow: string
  input: unknown
  mode: FlowMode
  /** Whose seat the run acts in. */
  as: { principal: Principal; seat: Seat | null; tenant: string | null }
  /** Set when an automation started it: the role the owner must keep, and its budget. */
  automation?: { id: string; role: string; usdPerMonth?: number }
}

export interface FlowResult {
  runId: string
  status: FlowStatus
  reason: string | null
  reported: boolean
  report: string[]
}

/** A notice the run sends: a fixed template and its data. */
export interface Notice {
  runId: string
  workflow: string
  template: string
  data: Readonly<Record<string, unknown>>
}

/** Work that goes to a person: a failed or refused write, a step not built, an expired approval. */
export interface Handoff {
  runId: string
  workflow: string
  step: string
  kind: 'failed' | 'refused' | 'not_built' | 'confirm' | 'expired' | 'stale'
  message: string
  /** Send this with `flows.resolve` to settle it, when the run waits. */
  waits: boolean
}

/** What the product gives every run. */
export interface FlowDeps<C extends BaseCtx = BaseCtx> {
  /** Every capability call and every step's record go through it: `ai.runs` holds the run's ledger. */
  ai: Ai<C>
  guard: Guard<C>
  registry: Registry<C, any, any>
  store: FlowStore
  /** Adds the product's own fields to the base ctx. Required when its ctx has more than BaseCtx. */
  ctx?: (base: BaseCtx) => C | Promise<C>
  /** The roles a person holds now, for an automation's owner check. Without it, an automation run is refused. */
  roles?: (ctx: C) => readonly string[] | Promise<readonly string[]>
  actors?: ActorRuntime<C>
  notify?: (ctx: C, notice: Notice) => void | Promise<void>
  handoff?: (ctx: C, handoff: Handoff) => void | Promise<void>
  /** A dry run's report, at its end: what each write would have done. */
  report?: (ctx: C, report: { runId: string; workflow: string; lines: string[] }) => void | Promise<void>
  switches?: SwitchStore
  now?: () => number
  onError?: (err: unknown, where: string) => void
}

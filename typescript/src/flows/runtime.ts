// Starting runs and waking them. A starter is the runner's door: the memory
// runner, or Cloudflare Workflows through `cloudflareStarter`. `createFlows`
// claims the run's key first, so one key is one run whatever the runner, and
// turns the guard's approval events and an actor's end into the events a
// waiting run listens for.

import type { RunStore } from '../ai/runs.js'
import type { BaseCtx, Principal, Seat } from '../capabilities/capability.js'
import type { ApprovalEvent } from '../guard/types.js'
import { flowEvents, type Resolution } from './engine.js'
import { type FlowMode, type FlowParams, type FlowRunRow, type FlowStepRow, type FlowStore, stepsFromEffects } from './types.js'
import type { Workflow } from './workflow.js'

/** Starts a run and sends it events. */
export interface FlowStarter {
  /** Starts the run under `params.key`; `started: false` when it already exists. */
  start(wf: Workflow, params: FlowParams): Promise<{ started: boolean }>
  send(key: string, event: { type: string; payload: unknown }): Promise<void>
}

export interface StartRunInput {
  input: unknown
  /** Default `live`. */
  mode?: FlowMode
  /** Whose seat the run acts in. Default: the ctx's. */
  as?: { principal: Principal; seat: Seat | null; tenant: string | null }
  automation?: FlowParams['automation']
}

export type StartRunResult = { outcome: 'started' | 'exists'; key: string }

export interface Flows<C extends BaseCtx = BaseCtx> {
  /** Starts a run by key, such as `fulfil:<payment id>`. A second start with the same key does nothing. */
  start(ctx: C, wf: Workflow, key: string, input: StartRunInput): Promise<StartRunResult>
  /**
   * Give it to the guard as `onApproval` (or call it from yours): wakes the
   * run waiting on that approval when it is decided, expires, or runs and
   * ends `executed`, `failed` or `stale`.
   */
  onApproval(event: ApprovalEvent<C>): Promise<void>
  /**
   * A fallback: wakes the run waiting on an approval, whatever happened to
   * it. Only for a product whose guard events cannot reach `onApproval`, such
   * as a guard in another Worker.
   */
  approvalSettled(approvalId: string): Promise<void>
  /** Call when an actor session ends: wakes the run waiting on it. */
  actorEnded(session: string): Promise<void>
  /** A person settles a failed step: carry on (with the output they made by hand) or stop the run. */
  resolve(key: string, step: string, resolution: Resolution): Promise<void>
  run(key: string): Promise<FlowRunRow | null>
  /** Where each step stands, from the ai kit's effects ledger. `ai.runs.effects(key)` gives every row. */
  steps(key: string): Promise<FlowStepRow[]>
}

export interface FlowsOptions {
  store: FlowStore
  /** The ai kit's run store (`ai.runs`): a run's steps are rows in its effects ledger. */
  runs: RunStore
  starter: FlowStarter
  now?: () => number
  onError?: (err: unknown, where: string) => void
}

/** The product's handle on its workflows. */
export function createFlows<C extends BaseCtx = BaseCtx>(o: FlowsOptions): Flows<C> {
  const now = () => o.now?.() ?? Date.now()
  const onError = o.onError ?? ((e: unknown, where: string) => console.error(`flows ${where}:`, e))
  const wake = async (kind: 'approval' | 'actor', ref: string, payload: unknown) => {
    const l = await o.store.linked(kind, ref)
    if (!l) return
    await o.starter.send(l.runId, { type: l.eventType, payload })
  }
  return {
    async start(ctx, wf, key, input) {
      const params: FlowParams = {
        key,
        workflow: wf.id,
        input: input.input ?? null,
        mode: input.mode ?? 'live',
        as: input.as ?? { principal: ctx.principal, seat: ctx.seat, tenant: ctx.tenant },
        ...(input.automation ? { automation: input.automation } : {}),
      }
      return startRun(o.store, o.starter, wf, params, now)
    },
    async onApproval(event) {
      if (event.type === 'requested') return
      try {
        await wake('approval', event.approval.id, { status: event.approval.status })
      } catch (e) {
        onError(e, 'onApproval')
      }
    },
    async approvalSettled(approvalId) {
      await wake('approval', approvalId, { settled: true })
    },
    async actorEnded(session) {
      await wake('actor', session, { session })
    },
    async resolve(key, step, resolution) {
      await o.starter.send(key, { type: flowEvents.resolve(step), payload: resolution })
    },
    run: (key) => o.store.getRun(key),
    steps: async (key) => stepsFromEffects(await o.runs.effects(key)),
  }
}

/** Claims the key, then starts the runner. Used by `createFlows` and by automations. */
export async function startRun(store: FlowStore, starter: FlowStarter, wf: Workflow, params: FlowParams, now: () => number = Date.now): Promise<StartRunResult> {
  const at = new Date(now()).toISOString()
  const claimed = await store.claimRun({
    id: params.key,
    workflow: wf.id,
    workflowVersion: wf.version,
    mode: params.mode,
    status: 'queued',
    automation: params.automation?.id ?? null,
    tenant: params.as.tenant,
    person: params.as.principal.id,
    reason: null,
    costMicros: 0,
    reported: false,
    report: [],
    startedAt: at,
    updatedAt: at,
    endedAt: null,
  })
  if (!claimed) return { outcome: 'exists', key: params.key }
  const r = await starter.start(wf, params)
  return { outcome: r.started ? 'started' : 'exists', key: params.key }
}

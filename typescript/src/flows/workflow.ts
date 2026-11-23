// Workflow definitions: an id, a version and the steps, each one a
// capability (read or write), an ai task, an actor, a notice or a bulk
// capability over many items. Checked when the module loads, like
// capabilities and units.

import type { AnyUnit } from '../ai/manifest.js'
import { NAME_PATTERN } from '../capabilities/capability.js'
import { isTier, type Tier } from '../capabilities/tiers.js'
import { durationMs } from '../guard/policies.js'
import { type ActorStep, type BulkStep, type CapabilityStep, FLOW_LIMITS, type FlowState, type FlowStep, type NotifyStep, type RetryConfig, type TaskStep } from './types.js'

export const WORKFLOW_ID_PATTERN = /^[a-z][a-z0-9]*(_[a-z0-9]+)*$/
const STEP_ID = /^[a-z][a-z0-9]*(_[a-z0-9]+)*$/

export interface WorkflowSpec {
  /** Lower case words joined by `_`, such as `payment_fulfil`. */
  id: string
  /** Starts at 1. Raised when the steps change. A run keeps the version it started on. */
  version: number
  steps: readonly FlowStep[]
  /**
   * The highest tier a step may reach. Default R3: an R4 step needs a person
   * at the console, not a workflow.
   */
  maxTier?: Tier
  /** True when the run has nothing worth telling anyone: notices are recorded, not delivered. */
  nothingToReport?: (s: FlowState) => boolean
  /** How long a failed write waits for a person before the run ends `failed`. `24h`, `7d` or milliseconds. Default 7 days. */
  resolveTimeout?: string | number
  /** Most durable steps a run may take. Default `FLOW_LIMITS.maxSteps`. */
  maxSteps?: number
}

export interface Workflow extends Readonly<Omit<WorkflowSpec, 'steps'>> {
  readonly kind: 'workflow'
  readonly steps: readonly FlowStep[]
  readonly maxTier: Tier
  readonly resolveTimeoutMs: number
  /** Every capability its steps name. */
  readonly capabilities: readonly string[]
  /**
   * The unit its capability calls are recorded under in the ai kit's run
   * store: the workflow's id and version, its capabilities as tools.
   */
  readonly unit: AnyUnit
}

export class WorkflowError extends Error {
  constructor(
    readonly workflow: string,
    readonly problems: string[],
  ) {
    super(`workflow ${workflow || '(unnamed)'}: ${problems.join('; ')}`)
    this.name = 'WorkflowError'
  }
}

/** Every rule a definition breaks, as sentences. Empty means it is sound. */
export function workflowProblems(spec: Partial<WorkflowSpec>): string[] {
  const p: string[] = []
  if (!WORKFLOW_ID_PATTERN.test(spec.id ?? '') || (spec.id ?? '').length > 64) p.push('id must be lower case words joined by _, at most 64 characters')
  if (!Number.isInteger(spec.version) || (spec.version as number) < 1) p.push('version must be a whole number from 1')
  if (spec.maxTier !== undefined && !isTier(spec.maxTier)) p.push(`maxTier must be one of R0 to R4, is ${String(spec.maxTier)}`)
  if (spec.maxSteps !== undefined && !(Number.isInteger(spec.maxSteps) && spec.maxSteps > 0)) p.push('maxSteps must be a whole number from 1')
  if (spec.resolveTimeout !== undefined) {
    try {
      durationMs(spec.resolveTimeout)
    } catch (e) {
      p.push(`resolveTimeout: ${(e as Error).message}`)
    }
  }
  const steps = spec.steps
  if (!Array.isArray(steps) || steps.length === 0) {
    p.push('steps must hold at least one step')
    return p
  }
  const seen = new Set<string>()
  for (const s of steps as FlowStep[]) {
    const where = `step ${s?.id ?? '(unnamed)'}`
    if (!s || !STEP_ID.test(s.id ?? '') || s.id.length > 48) p.push(`${where}: id must be lower case words joined by _, at most 48 characters`)
    else if (s.id === 'input') p.push(`${where}: input is the run's input, not a step id`)
    else if (seen.has(s.id)) p.push(`${where}: id repeats`)
    else seen.add(s.id)
    if (s.when !== undefined && typeof s.when !== 'function') p.push(`${where}: when must be a function`)
    switch (s?.kind) {
      case 'read':
      case 'write':
        if (!NAME_PATTERN.test(s.capability ?? '')) p.push(`${where}: capability must name one`)
        if (s.kind === 'write' && s.retries) p.push(`${where}: a write step never retries; remove retries`)
        if (s.kind === 'read' && s.confirm) p.push(`${where}: confirm is for write steps`)
        if (s.retries && !(Number.isInteger(s.retries.limit) && s.retries.limit >= 0)) p.push(`${where}: retries.limit must be a whole number from 0`)
        if (s.skipIf !== undefined && s.skipIf !== 'not_built' && typeof s.skipIf !== 'function') p.push(`${where}: skipIf must be 'not_built' or a function`)
        break
      case 'task':
        if (!s.unit || s.unit.kind !== 'task') p.push(`${where}: unit must be an ai task`)
        if (typeof s.input !== 'function') p.push(`${where}: input must be a function of the state`)
        break
      case 'actor':
        if (typeof s.actor !== 'string' || !s.actor) p.push(`${where}: actor must name one`)
        if (s.timeout !== undefined) {
          try {
            durationMs(s.timeout)
          } catch (e) {
            p.push(`${where}: timeout: ${(e as Error).message}`)
          }
        }
        break
      case 'notify':
        if (typeof s.template !== 'string' || !s.template) p.push(`${where}: template must name one`)
        break
      case 'bulk':
        if (!NAME_PATTERN.test(s.capability ?? '')) p.push(`${where}: capability must name one`)
        if (typeof s.items !== 'function' || typeof s.args !== 'function') p.push(`${where}: items and args must be functions`)
        if (s.chunk !== undefined && !(Number.isInteger(s.chunk) && s.chunk >= 1 && s.chunk <= FLOW_LIMITS.maxChunk)) {
          p.push(`${where}: chunk must be a whole number from 1 to ${FLOW_LIMITS.maxChunk}`)
        }
        break
      default:
        p.push(`${where}: kind must be read, write, task, actor, notify or bulk`)
    }
  }
  return p
}

/**
 * Defines a workflow and checks it. Throws `WorkflowError` listing every rule
 * it breaks.
 *
 *     export const paymentFulfil = workflow({
 *       id: 'payment_fulfil', version: 1,
 *       steps: [step.read('check', 'payment_get', { args: (s) => ({ id: s.input.payment_id }) }), ...],
 *     })
 */
export function workflow(spec: WorkflowSpec): Workflow {
  const problems = workflowProblems(spec)
  if (problems.length) throw new WorkflowError(spec.id ?? '', problems)
  const caps = [...new Set(spec.steps.flatMap((s) => (s.kind === 'read' || s.kind === 'write' || s.kind === 'bulk' ? [s.capability] : [])))]
  const maxTier = spec.maxTier ?? 'R3'
  // Only the fields the ai kit reads for a capability call recorded in a run.
  const unit = Object.freeze({ id: spec.id, kind: 'workflow', version: spec.version, tools: Object.freeze({ allow: Object.freeze(caps), maxTier }) }) as unknown as AnyUnit
  return Object.freeze({
    ...spec,
    kind: 'workflow' as const,
    steps: Object.freeze([...spec.steps]),
    maxTier,
    resolveTimeoutMs: spec.resolveTimeout === undefined ? FLOW_LIMITS.resolveTimeoutMs : durationMs(spec.resolveTimeout),
    capabilities: Object.freeze(caps),
    unit,
  })
}

type Opt<T extends FlowStep> = Omit<T, 'id' | 'kind' | 'capability' | 'unit' | 'actor' | 'template'>

/** Step builders. */
export const step = {
  /** An R0 or R1 capability. Keeps the runner's default retries. */
  read: (id: string, capability: string, o: Omit<Opt<CapabilityStep>, 'confirm'> = {}): CapabilityStep => ({ ...o, id, kind: 'read', capability }),
  /** An R2 or higher capability. Never retried; R3 waits for its approval; a failure goes to a person. */
  write: (id: string, capability: string, o: Omit<Opt<CapabilityStep>, 'retries'> = {}): CapabilityStep => ({ ...o, id, kind: 'write', capability }),
  /** An ai task. Its save, when it has a target, is a write and is never retried. */
  task: (id: string, unit: AnyUnit, o: Opt<TaskStep>): TaskStep => ({ ...o, id, kind: 'task', unit }),
  /** An actor a person talks to. The run waits until the session ends. */
  actor: (id: string, actor: string, o: Opt<ActorStep> = {}): ActorStep => ({ ...o, id, kind: 'actor', actor }),
  /** A notice from a fixed template. Never retried. */
  notify: (id: string, template: string, o: Opt<NotifyStep> = {}): NotifyStep => ({ ...o, id, kind: 'notify', template }),
  /** One capability over many items, in chunks. */
  bulk: (id: string, capability: string, o: Opt<BulkStep>): BulkStep => ({ ...o, id, kind: 'bulk', capability }),
}

export type { RetryConfig }

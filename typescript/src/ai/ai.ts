// The run layer. `createAi` takes the product's pieces (a Core client per
// tenant, the run store, prompts, memory, retrievers, the guard) and gives
// `ai.run` for tasks and `ai.start` for the kits that hold a conversation.
// Every model call goes through a run's gateway: the unit's role, the tags,
// the cache policy, the caps and the usage all come from there. `ai.resume`
// opens an earlier run again, so a conversation that spans requests stays one
// run with one spend.

import type { BaseCtx } from '../capabilities/capability.js'
import type { Registry } from '../capabilities/registry.js'
import { type JsonSchema, type SchemaLike, validate } from '../capabilities/standard.js'
import { modeOf, type Tier, tierRank } from '../capabilities/tiers.js'
import { argsHash, canonicalJson, sha256Hex } from '../guard/crypto.js'
import type { CallOptions, Guard, GuardOutcome, PreviewOutcome } from '../guard/types.js'
import type { CompleteRequest, CompleteResult, Image, Message, StreamEvent } from '../types.js'
import { type BuiltContext, buildContext, type ContextParts, type Retrieved, type Untrusted } from './context.js'
import { type AnyUnit, layersOf, type Unit } from './manifest.js'
import { createMemory, knownLines, type LongTermScope, type Memory, type MemoryRow, type MemoryStore, type ThreadKey } from './memory.js'
import type { Prompts, RenderedPrompt } from './prompts.js'
import { type EffectOutcome, type EffectRow, RECORDED_OUTCOMES, type RunOutcome, type RunRow, type RunStore } from './runs.js'
import { MAX_TAGS, mergeTags, type Tags } from './tags.js'
import { estimateTokens } from './tokens.js'

// ---------------------------------------------------------------- the product's pieces

/** What the kit needs of the Core client. `Omazy` fits; so does a fake in tests. */
export interface CoreLike {
  ai: {
    complete(req: CompleteRequest, signal?: AbortSignal): Promise<CompleteResult>
    /** Needed only for `scope.stream`. */
    stream?(req: CompleteRequest, signal?: AbortSignal): AsyncIterable<StreamEvent>
  }
}

/** US dollars per million tokens. Tokens times this is micros. */
export interface Price {
  input: number
  output: number
  /** Default: `input`. */
  cachedInput?: number
}

/** Caps across units, per UTC day. RFC-0901 adds per person and per tenant per month; a product can check those in `beforeRun`. */
export interface AiLimits {
  perTenantDayUsd?: number
  perPersonDayUsd?: number
  globalDayUsd?: number
}

export interface LayerSources<C extends BaseCtx> {
  /** The product's persona and rules. Fixed per version: it is the start of every prompt's cached prefix. */
  platform?: (ctx: C, unit: AnyUnit) => string | Promise<string>
  /** The tenant's name, level, country, language. No visitor data. */
  tenant?: (ctx: C, unit: AnyUnit) => string | Promise<string>
  /** The seat's role and what it may do, so the model does not propose what will be refused. */
  role?: (ctx: C, unit: AnyUnit) => string | Promise<string>
  /** The screen and record, rebuilt on the server. */
  surface?: (ctx: C, unit: AnyUnit, input: Readonly<Record<string, unknown>>) => string | Promise<string>
}

export type Retriever<C extends BaseCtx> = (ctx: C, q: { unit: AnyUnit; input: Readonly<Record<string, unknown>> }) => readonly Retrieved[] | Promise<readonly Retrieved[]>

export interface AiOptions<C extends BaseCtx> {
  /** The Core client for this ctx, usually the tenant's install token. */
  omazy: (ctx: C) => CoreLike
  runs: RunStore
  prompts: Prompts
  /** Every capability call a run makes goes through it. Needed for `call` and a unit's `target`. */
  guard?: Guard<C>
  /** The registry the guard uses, for each call's tier. Needed with `guard`. */
  registry?: Registry<C, any, any>
  memory?: Memory<C> | MemoryStore
  layers?: LayerSources<C>
  retrievers?: Record<string, Retriever<C>>
  /**
   * Role to model id, for an account whose roles the platform does not
   * resolve yet. A role the map lacks is sent as `role:<name>` for the
   * platform to resolve.
   */
  roles?: Readonly<Record<string, string>>
  /** Rates by model id (as the platform reports it) or by role, for cost when the platform does not give one, and for cap estimates. */
  prices?: Readonly<Record<string, Price>>
  limits?: AiLimits
  /**
   * How a task's output is forced. `response_format` (default) sends a JSON
   * Schema and falls back to a forced single tool call when the model says
   * `MODEL_UNSUPPORTED`; `tool` always uses the tool call.
   */
  structured?: 'response_format' | 'tool'
  /**
   * Folds dropped turns into the thread's summary. A model call belongs to a
   * unit, so this should run a task of its own (`ai.run(ctx, summarise, ...)`).
   */
  compact?: (ctx: C, dropped: Message[], summary: string | undefined) => Promise<string>
  /** Output tokens assumed for a cap estimate when the unit sets no maxOutputTokens. Default 1000. */
  defaultOutputTokens?: number
  now?: () => number
  newId?: (kind: 'run' | 'effect') => string
}

// ---------------------------------------------------------------- refusals and results

export type CapName = 'run' | 'day' | 'tenant_day' | 'person_day' | 'global_day' | 'platform'

/** A run, or a call within one, that a cap stopped before the model was called. */
export class CapRefusal extends Error {
  override readonly name = 'CapRefusal'
  constructor(
    readonly cap: CapName,
    message: string,
    readonly detail: { limitUsd?: number; spentUsd?: number; estimateUsd?: number; code?: string } = {},
  ) {
    super(message)
  }
  /** The run it stopped, once recorded. */
  runId?: string
}

/** A capability call the kit refused before asking the guard. */
export interface UnitRefusal {
  outcome: 'refused_unit' | 'duplicate'
  code: 'tool_not_allowed' | 'tier_above_unit' | 'already_done' | 'no_guard'
  message: string
  requestId: string
  /** For `duplicate`: the effect that already made this change. */
  effectId?: string
}

export type RunCallOutcome<O = unknown> = GuardOutcome<O> | UnitRefusal

/** What `previewInRun` found: the guard's preview, or the kit's refusal before the guard. */
export type RunPreviewOutcome = PreviewOutcome | (UnitRefusal & { outcome: 'refused_unit' })

/** The workflow step a ledger row belongs to. */
export interface StepTag {
  /** The step id, or `<id>#<n>` for chunk n of a bulk step. */
  key: string
  kind: string
}

/** `callInRun` and `previewInRun` options: the guard's, and the step the row belongs to. */
export interface InRunOptions extends CallOptions {
  step?: StepTag
}

/** A ledger row a workflow writes itself: a step planned, skipped, waiting, failed or refused, or one that ended `ok` outside a guard call. */
export interface RecordInput {
  /** The capability, or for a step that calls none, its target: the unit, actor or template. */
  capability: string
  outcome: EffectOutcome
  step: StepTag
  requestId: string
  tier?: Tier | null
  /** Default: from the tier, else `write`. */
  mode?: 'read' | 'write'
  code?: string | null
  message?: string | null
  approvalId?: string | null
  ref?: string | null
  idempotencyKey?: string | null
  preview?: boolean
}

export interface RunUsage {
  calls: number
  cacheHits: number
  inputTokens: number
  outputTokens: number
  cachedInputTokens: number
  costMicros: number
  costEstimated: boolean
  unpricedCalls: number
}

/** A model call as a unit makes it. The gateway sets the model, temperature, output limit, cache and tags. */
export interface ModelRequest {
  system?: string
  messages: Message[]
  tools?: CompleteRequest['tools']
  tool_choice?: CompleteRequest['tool_choice']
  response_format?: CompleteRequest['response_format']
  /** At most the unit's maxOutputTokens. */
  max_tokens?: number
}

/** The tags every call carries, for the platform's ledger and usage report. */
export interface CallTags {
  unit: string
  unit_version: string
  prompt_version: string
  run_id: string
  /**
   * The role this call was sent on, only when the product's `roles` map
   * turned it into a model name and a tag key is free. A call sent as
   * `role:<name>` has its role in the platform's ledger already.
   */
  role?: string
}

/** Options of one model call. */
export interface CallModelOptions {
  signal?: AbortSignal
  /** This call carries live data: `cache_ttl: 0`. Default: the unit's recipe. */
  live?: boolean
  /** Product tags for this call only, over the unit's and the run's. */
  tags?: Tags
  /**
   * Another model role for this call only, such as the unit's
   * `attachments.vision` for a turn with an image. Only a role the manifest
   * declares (`model.use`, `model.fallback`, `attachments.vision`); any other
   * throws before anything is sent. A role other than `model.use` is tried
   * alone, with no fallback.
   */
  role?: string
}

export interface RunScope<C extends BaseCtx = BaseCtx> {
  readonly id: string
  readonly unit: AnyUnit
  readonly ctx: C
  readonly prompt: RenderedPrompt
  /** Resolved entities, shown as `[known]` lines when the unit reads `known`. */
  readonly known: Map<string, string>
  /** The run's scratch, shown when the unit reads `working`. */
  readonly working: Record<string, unknown>
  readonly usage: Readonly<RunUsage>
  /** Builds the call's context from the unit's recipe. Records its report on the run. */
  context(o?: ContextInput): Promise<BuiltContext>
  /** One model call through the gateway. Throws `CapRefusal` when a cap stops it. */
  complete(req: ModelRequest, o?: CallModelOptions): Promise<CompleteResult>
  /**
   * The same call as a stream of `delta` events and one `done`, with the same
   * tags, caps and usage. A fallback role is tried only before any event.
   */
  stream(req: ModelRequest, o?: CallModelOptions): AsyncGenerator<StreamEvent>
  /** The unit's output forced through its schema, then checked. */
  structured<O = unknown>(built: BuiltContext, o?: CallModelOptions): Promise<StructuredResult<O>>
  /** A capability call through the guard, written to the effects ledger. */
  call<O = unknown>(name: string, args: unknown, opts?: CallOptions): Promise<RunCallOutcome<O>>
  /** A long-term memory the model proposes. Needs the scope in the unit's `memory.write`. */
  propose(scope: LongTermScope, text: string, mentions?: readonly string[]): Promise<MemoryRow>
  /** Ends the run. Idempotent: a second finish keeps the first outcome. */
  finish(outcome: Exclude<RunOutcome, 'running'>, error?: { code?: string; message?: string }): Promise<RunRow>
}

export interface ContextInput {
  /** The run's input. Fields the recipe names untrusted are fenced; the rest fill nothing (the template got them at start). */
  input?: Readonly<Record<string, unknown>>
  thread?: ThreadKey
  images?: readonly Image[]
  /** Overrides for single layers, such as a surface the caller already built. */
  parts?: Partial<ContextParts>
}

export type StructuredResult<O> = { ok: true; output: O; via: 'response_format' | 'tool'; result: CompleteResult } | { ok: false; issues: { message: string; path: string }[]; result: CompleteResult }

export interface RunOptions {
  /** One of the unit's prompt languages. Default its first. */
  language?: string
  thread?: ThreadKey
  images?: readonly Image[]
  /** Default true: a valid output is saved through the unit's target. */
  save?: boolean
  signal?: AbortSignal
  /** Overrides the recipe: this call carries live data, never cache it. */
  live?: boolean
  /** Product tags for every call of this run, over the unit's. */
  tags?: Tags
}

export type RunResult<O> =
  | { outcome: 'ok'; runId: string; output: O; save?: RunCallOutcome; usage: RunUsage }
  | { outcome: 'refused_cap'; runId: string; cap: CapName; message: string; usage: RunUsage }
  | { outcome: 'invalid_output'; runId: string; issues: { message: string; path: string }[]; usage: RunUsage }
  | { outcome: 'error'; runId: string; code: string; message: string; usage: RunUsage }

export interface StartOptions {
  language?: string
  /** Variables for the prompt template. Never the untrusted inputs. */
  vars?: Readonly<Record<string, unknown>>
  /** Product tags for every call of this run, over the unit's. */
  tags?: Tags
}

export interface ResumeOptions {
  /** The template's variables, as given at start. */
  vars?: Readonly<Record<string, unknown>>
  /** The run's product tags, as given at start. They are not stored on the run. */
  tags?: Tags
}

/** Why `ai.resume` would not open a run. A run in another tenant is `not_found`. */
export class ResumeRefusal extends Error {
  override readonly name = 'ResumeRefusal'
  constructor(
    readonly code: 'not_found' | 'finished' | 'other_seat' | 'other_unit' | 'other_version',
    message: string,
    readonly runId: string,
  ) {
    super(message)
  }
}

export interface Ai<C extends BaseCtx> {
  /** Runs a task: context, a structured call, the check, the save. Never throws for the model's or the platform's refusals. */
  run<I, O>(ctx: C, unit: Unit<I, O, any>, input: I, opts?: RunOptions): Promise<RunResult<O>>
  /** Opens a run for a unit that holds a conversation (actors, the copilot). Throws `CapRefusal` when a cap is already reached. */
  start(ctx: C, unit: AnyUnit, opts?: StartOptions): Promise<RunScope<C>>
  /**
   * Opens an earlier run again, in a later request, bound to the same row:
   * its usage carries on and its caps keep counting what it has spent. Pass
   * the same `vars` and `tags` as at start; the prompt is rendered again in
   * the run's language. Throws `ResumeRefusal` when the run is finished,
   * belongs to another tenant, seat or person, or was started by another
   * unit, unit version or prompt version, and `CapRefusal` when a day cap is
   * reached (the run stays open).
   */
  resume(ctx: C, unit: AnyUnit, runId: string, opts?: ResumeOptions): Promise<RunScope<C>>
  /**
   * A capability call recorded against an earlier run, such as the confirm
   * of a task's save after the person clicked. Same checks as `scope.call`.
   */
  callInRun<O = unknown>(ctx: C, unit: AnyUnit, runId: string, name: string, args: unknown, opts?: InRunOptions): Promise<RunCallOutcome<O>>
  /**
   * A dry run's preview-only effect: the unit's checks, then `guard.preview`
   * (switches, permission, tier, tenant and the capability's preview). Never
   * runs the capability. Recorded `planned` with `preview: true`, or with the
   * refusal's outcome.
   */
  previewInRun(ctx: C, unit: AnyUnit, runId: string, name: string, args: unknown, opts?: InRunOptions): Promise<RunPreviewOutcome>
  /** Writes a ledger row that is not a guard call, such as a workflow step skipped, waiting or failed. */
  recordInRun(runId: string, row: RecordInput): Promise<EffectRow>
  readonly memory: Memory<C> | undefined
  readonly runs: RunStore
  /** The guard from `createAi`, for what a unit's caller does beside calls, such as withdrawing an approval it asked for. */
  readonly guard: Guard<C> | undefined
}

// ---------------------------------------------------------------- helpers

const DAY_MS = 86_400_000
const usd = (micros: number) => micros / 1_000_000
const micros = (dollars: number) => Math.round(dollars * 1_000_000)

/** Errors that say this model cannot serve the call at all, so the fallback role may. */
const FALLBACK_CODES = new Set(['MODEL_UNAVAILABLE', 'MODEL_NOT_FOUND', 'UNKNOWN_MODEL', 'MODEL_UNKNOWN', 'UNKNOWN_ROLE', 'ROLE_UNKNOWN', 'PROVIDER_ERROR'])
const statusOf = (e: unknown): number | undefined => (typeof (e as { status?: unknown })?.status === 'number' ? (e as { status: number }).status : undefined)
const codeOf = (e: unknown): string | undefined => (typeof (e as { code?: unknown })?.code === 'string' ? (e as { code: string }).code : undefined)
const refusalOf = (e: unknown): unknown =>
  statusOf(e) === 402 ? new CapRefusal('platform', (e as Error).message || 'The platform refused the call: a cap is reached.', { code: codeOf(e) }) : e
const fallbackable = (e: unknown) => {
  const s = statusOf(e)
  return s === 0 || s === 404 || (s !== undefined && s >= 500) || FALLBACK_CODES.has(codeOf(e) ?? '')
}

/** True when every object in the schema is closed and lists every property as required: what `strict` asks. */
export function strictable(schema: unknown, depth = 0): boolean {
  if (depth > 32 || schema === null || typeof schema !== 'object') return true
  const s = schema as Record<string, unknown>
  if (s.type === 'object' || s.properties) {
    if (s.additionalProperties !== false) return false
    const props = Object.keys((s.properties as object) ?? {})
    const req = new Set((s.required as string[]) ?? [])
    if (!props.every((p) => req.has(p))) return false
  }
  for (const v of Object.values(s)) {
    if (Array.isArray(v)) {
      if (!v.every((x) => strictable(x, depth + 1))) return false
    } else if (v && typeof v === 'object' && !strictable(v, depth + 1)) return false
  }
  return true
}

/** The name of the forced tool a task's output comes back through when the model cannot take a JSON Schema. */
export const OUTPUT_TOOL = 'submit_output'

function untrustedOf(unit: AnyUnit, input: Readonly<Record<string, unknown>>): Untrusted[] {
  const out: Untrusted[] = []
  for (const name of unit.context.untrusted ?? []) {
    const v = input[name]
    if (v === undefined || v === null || v === '') continue
    const list = Array.isArray(v) ? v : [v]
    for (const x of list) out.push({ name, text: typeof x === 'string' ? x : JSON.stringify(x) })
  }
  return out
}

function varsOf(unit: AnyUnit, input: unknown): Record<string, unknown> {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return {}
  const skip = new Set(unit.context.untrusted ?? [])
  return Object.fromEntries(Object.entries(input).filter(([k]) => !skip.has(k)))
}

// ---------------------------------------------------------------- createAi

export function createAi<C extends BaseCtx>(opts: AiOptions<C>): Ai<C> {
  const nowMs = opts.now ?? Date.now
  const iso = () => new Date(nowMs()).toISOString()
  const newId = opts.newId ?? ((kind: 'run' | 'effect') => `${kind === 'run' ? 'run' : 'eff'}_${crypto.randomUUID().replace(/-/g, '')}`)
  const memory: Memory<C> | undefined = !opts.memory ? undefined : 'propose' in opts.memory ? opts.memory : createMemory<C>({ store: opts.memory, now: opts.now })
  const runs = opts.runs

  const modelFor = (role: string) => opts.roles?.[role] ?? `role:${role}`
  const priceFor = (model: string | undefined, sent: string, role: string): Price | undefined =>
    (model ? opts.prices?.[model] : undefined) ?? opts.prices?.[sent] ?? opts.prices?.[role]

  async function capCheck(ctx: C, unit: AnyUnit, runSpent: number, estimate: number, whole: boolean): Promise<void> {
    const est = usd(estimate)
    const runCap = unit.caps.perRunUsd
    if (usd(runSpent) >= runCap || usd(runSpent + estimate) > runCap) {
      throw new CapRefusal('run', `This run of ${unit.id} would pass its cap of $${runCap} a run (spent $${usd(runSpent).toFixed(4)}, next call about $${est.toFixed(4)}).`, {
        limitUsd: runCap,
        spentUsd: usd(runSpent),
        estimateUsd: est,
      })
    }
    if (!whole) return
    const since = new Date(Math.floor(nowMs() / DAY_MS) * DAY_MS).toISOString()
    const checks: { cap: CapName; limit: number | undefined; q: Parameters<RunStore['spend']>[0]; what: string }[] = [
      { cap: 'day', limit: unit.caps.perDayUsd, q: { since, tenant: ctx.tenant, unit: unit.id }, what: `${unit.id} in this tenant` },
      { cap: 'tenant_day', limit: opts.limits?.perTenantDayUsd, q: { since, tenant: ctx.tenant }, what: 'this tenant' },
      { cap: 'person_day', limit: opts.limits?.perPersonDayUsd, q: { since, person: ctx.principal.id }, what: 'this person' },
      { cap: 'global_day', limit: opts.limits?.globalDayUsd, q: { since }, what: 'the product' },
    ]
    for (const c of checks) {
      if (c.limit === undefined) continue
      const spent = await runs.spend(c.q)
      // Reached, or passed by this run's estimate.
      if (usd(spent) >= c.limit || usd(spent + estimate) > c.limit) {
        throw new CapRefusal(c.cap, `AI spend today for ${c.what} would pass its cap of $${c.limit} (spent $${usd(spent).toFixed(4)}, this run about $${est.toFixed(4)}).`, {
          limitUsd: c.limit,
          spentUsd: usd(spent),
          estimateUsd: est,
        })
      }
    }
  }

  /** The next seq in a run's ledger. */
  const nextSeq = async (runId: string) => (await runs.effects(runId)).reduce((m, e) => Math.max(m, e.seq), 0) + 1

  async function recordEffect(
    ctx: C,
    unit: AnyUnit,
    runId: string,
    seq: () => Promise<number>,
    name: string,
    args: unknown,
    callOpts?: InRunOptions,
    previewOnly = false,
  ): Promise<RunCallOutcome<any> | RunPreviewOutcome> {
    const started = nowMs()
    const reg = opts.registry
    const tier: Tier | null = reg ? reg.tier(name, args) : null
    const mode = modeOf(tier ?? 'R4')
    const key = await sha256Hex(canonicalJson({ tenant: ctx.tenant, capability: name, args }))
    const hash = await argsHash(args ?? null)
    const { step, ...guardOpts } = callOpts ?? {}
    const write = async (outcome: EffectOutcome, code: string | null, approvalId: string | null, requestId: string, message: string | null) => {
      const row: EffectRow = {
        id: newId('effect'),
        runId,
        seq: await seq(),
        capability: name,
        tier,
        mode,
        argsHash: hash,
        idempotencyKey: key,
        outcome,
        code,
        approvalId,
        requestId,
        at: new Date(started).toISOString(),
        ms: nowMs() - started,
        step: step?.key ?? null,
        stepKind: step?.kind ?? null,
        message,
        ref: null,
        preview: previewOnly,
      }
      await runs.insertEffect(row)
      return row
    }
    const refuse = async (outcome: UnitRefusal['outcome'], code: UnitRefusal['code'], message: string, effectId?: string): Promise<UnitRefusal> => {
      await write(outcome, code, null, ctx.requestId, message)
      return { outcome, code, message, requestId: ctx.requestId, ...(effectId ? { effectId } : {}) } as UnitRefusal
    }

    const isTarget = name === unit.target
    if (!isTarget && !unit.tools?.allow.includes(name)) return refuse('refused_unit', 'tool_not_allowed', `${unit.id} may not call ${name}.`)
    if (!isTarget && tierRank(tier) > tierRank(unit.tools!.maxTier)) {
      return refuse('refused_unit', 'tier_above_unit', `${name} is ${tier ?? 'of unknown tier'}, above what ${unit.id} may reach (${unit.tools!.maxTier}).`)
    }
    if (!opts.guard || !reg) return refuse('refused_unit', 'no_guard', 'Capability calls need the guard and its registry in createAi.')
    if (previewOnly) {
      const p = await opts.guard.preview(ctx, name, args, guardOpts)
      if (p.outcome === 'ok') await write('planned', null, null, p.requestId, p.preview.summary)
      else await write(p.outcome as EffectOutcome, p.code, null, p.requestId, p.message)
      return p
    }
    if (mode === 'write') {
      const done = (await runs.effects(runId)).find((e) => e.idempotencyKey === key && !e.preview && (e.outcome === 'ok' || e.outcome === 'pending_approval'))
      if (done) return refuse('duplicate', 'already_done', `This run already made this change (${done.outcome === 'ok' ? 'done' : 'waiting for approval'}); it is not sent twice.`, done.id)
    }
    const out = await opts.guard.call(ctx, name, args, guardOpts)
    const code = 'code' in out ? (out.code as string) : null
    const approvalId = out.outcome === 'pending_approval' ? out.approval.id : out.outcome === 'ok' ? (out.approvalId ?? null) : null
    const message = 'message' in out ? out.message : out.outcome === 'pending_approval' ? out.approval.preview.summary : out.outcome === 'confirm_required' ? out.preview.summary : null
    await write(out.outcome as EffectOutcome, code, approvalId, out.requestId, message)
    return out
  }

  const zeroUsage = (): RunUsage => ({ calls: 0, cacheHits: 0, inputTokens: 0, outputTokens: 0, cachedInputTokens: 0, costMicros: 0, costEstimated: false, unpricedCalls: 0 })

  async function start(ctx: C, unit: AnyUnit, so: StartOptions = {}): Promise<RunScope<C>> {
    const prompt = opts.prompts.render(unit.prompt, so.vars ?? {}, so.language)
    mergeTags(unit.tags, so.tags) // a run's tags that break the platform's rules fail before it starts
    const id = newId('run')
    const row: RunRow = {
      id,
      unit: unit.id,
      unitKind: unit.kind,
      unitVersion: unit.version,
      promptTemplate: prompt.template,
      promptVersion: prompt.version,
      language: prompt.language,
      role: unit.model.use,
      model: null,
      seat: ctx.seat?.id ?? null,
      tenant: ctx.tenant,
      person: ctx.principal.id,
      channel: ctx.channel,
      requestId: ctx.requestId,
      startedAt: iso(),
      endedAt: null,
      outcome: 'running',
      errorCode: null,
      error: null,
      ...zeroUsage(),
      context: null,
    }
    await runs.insertRun(row)
    const scope = scopeOf(ctx, unit, row, prompt, so.tags, 0)
    // A cap already reached stops the run before anything is built.
    try {
      await capCheck(ctx, unit, 0, 0, true)
    } catch (e) {
      if (e instanceof CapRefusal) {
        await scope.finish('refused_cap', { code: `cap_${e.cap}`, message: e.message })
        e.runId = id
      }
      throw e
    }
    return scope
  }

  async function resume(ctx: C, unit: AnyUnit, runId: string, ro: ResumeOptions = {}): Promise<RunScope<C>> {
    const row = await runs.getRun(runId)
    // Another tenant's run is not said to exist.
    if (!row || row.tenant !== ctx.tenant) throw new ResumeRefusal('not_found', 'No such run in this tenant.', runId)
    if (row.seat !== (ctx.seat?.id ?? null) || row.person !== ctx.principal.id) throw new ResumeRefusal('other_seat', 'This run belongs to another seat or person.', runId)
    if (row.unit !== unit.id) throw new ResumeRefusal('other_unit', `This run is of ${row.unit}, not ${unit.id}.`, runId)
    if (row.unitVersion !== unit.version) throw new ResumeRefusal('other_version', `This run is of ${unit.id} version ${row.unitVersion}; the unit is now version ${unit.version}.`, runId)
    if (row.outcome !== 'running') throw new ResumeRefusal('finished', `This run has finished (${row.outcome}).`, runId)
    const prompt = opts.prompts.render(unit.prompt, ro.vars ?? {}, row.language)
    if (prompt.version !== row.promptVersion || prompt.template !== row.promptTemplate || prompt.language !== row.language) {
      throw new ResumeRefusal('other_version', `This run used prompt ${row.promptTemplate} version ${row.promptVersion} in ${row.language}; the unit now renders ${prompt.template} version ${prompt.version} in ${prompt.language}.`, runId)
    }
    mergeTags(unit.tags, ro.tags)
    // The day caps, as at start, against what the run has already spent. The run stays open.
    await capCheck(ctx, unit, row.costMicros, 0, true)
    const seq0 = (await runs.effects(runId)).reduce((m, e) => Math.max(m, e.seq), 0)
    return scopeOf(ctx, unit, row, prompt, ro.tags, seq0)
  }

  /** A scope bound to a run row, new or resumed. Usage starts from the row's. */
  function scopeOf(ctx: C, unit: AnyUnit, row: RunRow, prompt: RenderedPrompt, runTags: Tags | undefined, seq0: number): RunScope<C> {
    const id = row.id
    const usage: RunUsage = {
      calls: row.calls,
      cacheHits: row.cacheHits,
      inputTokens: row.inputTokens,
      outputTokens: row.outputTokens,
      cachedInputTokens: row.cachedInputTokens,
      costMicros: row.costMicros,
      costEstimated: row.costEstimated,
      unpricedCalls: row.unpricedCalls,
    }
    let lastModel: string | null = row.model
    let lastRole = row.role
    let finished: RunRow | null = null
    const finish: RunScope<C>['finish'] = async (outcome, error) => {
      if (finished) return finished
      const patch: Partial<RunRow> = { outcome, endedAt: iso(), errorCode: error?.code ?? null, error: error?.message ?? null, ...usage, model: lastModel, role: lastRole }
      await runs.updateRun(id, patch)
      finished = { ...row, ...patch }
      return finished
    }
    const so = { tags: runTags }
    const declared = new Set([unit.model.use, unit.model.fallback, unit.attachments?.vision].filter((r): r is string => !!r))

    const client = opts.omazy(ctx)
    const runTagsOf = (role: string, model: string, product: Record<string, string>): CallTags => ({
      unit: unit.id,
      unit_version: String(unit.version),
      prompt_version: String(prompt.version),
      run_id: id,
      // The platform sees `role:<name>` and records it; a mapped model name hides the role, so tag it when there is room.
      ...(model !== `role:${role}` && Object.keys(product).length < MAX_TAGS ? { role } : {}),
    })
    let effectSeq = seq0
    const seq = async () => ++effectSeq

    // The request each role would send, with its cost estimate. Fallback roles follow the first.
    const plan = (req: ModelRequest, o: CallModelOptions) => {
      if (finished) throw new Error(`run ${id} has finished`)
      if (o.role !== undefined && !declared.has(o.role)) {
        throw new Error(`${unit.id} does not declare the role ${o.role}; a call may use ${[...declared].join(', ')}`)
      }
      const product = mergeTags(unit.tags, so.tags, o.tags)
      const roles = o.role !== undefined && o.role !== unit.model.use ? [o.role] : [unit.model.use, ...(unit.model.fallback ? [unit.model.fallback] : [])]
      const live = o.live ?? unit.context.live === true
      const cacheTtl = live ? 0 : unit.context.cacheTtl
      const cap = unit.model.maxOutputTokens
      const maxOut = req.max_tokens !== undefined && cap !== undefined ? Math.min(req.max_tokens, cap) : (req.max_tokens ?? cap)
      const promptTokens =
        estimateTokens(req.system ?? '') +
        req.messages.reduce((n, m) => n + estimateTokens(m.content) + estimateTokens(JSON.stringify(m.tool_calls ?? m.tool_results ?? '')), 0) +
        estimateTokens(JSON.stringify(req.tools ?? ''))
      return roles.map((role) => {
        const model = modelFor(role)
        const price = priceFor(undefined, model, role)
        const outTokens = maxOut ?? opts.defaultOutputTokens ?? 1000
        const body: CompleteRequest = {
          ...req,
          model,
          ...(unit.model.temperature !== undefined ? { temperature: unit.model.temperature } : {}),
          ...(maxOut !== undefined ? { max_tokens: maxOut } : {}),
          ...(cacheTtl !== undefined ? { cache_ttl: cacheTtl } : {}),
          metadata: { ...product, ...runTagsOf(role, model, product) },
        }
        return { role, body, estimate: price ? Math.ceil(promptTokens * price.input + outTokens * price.output) : 0 }
      })
    }

    // Usage, summed on the run and written at once so a crash keeps it.
    const account = async (res: CompleteResult, model: string, role: string) => {
      const u = res.usage ?? { input_tokens: 0, output_tokens: 0, cached_input_tokens: 0 }
      usage.calls++
      if (res.cache_hit) usage.cacheHits++
      usage.inputTokens += u.input_tokens ?? 0
      usage.outputTokens += u.output_tokens ?? 0
      usage.cachedInputTokens += u.cached_input_tokens ?? 0
      // The platform's price from its ledger, else the product's rate card.
      const reported = u.cost_micros
      if (typeof reported === 'number') usage.costMicros += reported
      else if (!res.cache_hit) {
        const p = priceFor(res.model, model, role)
        if (p) {
          const cached = u.cached_input_tokens ?? 0
          usage.costMicros += Math.ceil(((u.input_tokens ?? 0) - cached) * p.input + cached * (p.cachedInput ?? p.input) + (u.output_tokens ?? 0) * p.output)
          usage.costEstimated = true
        } else usage.unpricedCalls++
      }
      lastModel = res.model ?? model
      lastRole = role
      await runs.updateRun(id, { ...usage, model: lastModel, role })
    }

    const scope: RunScope<C> = {
      id,
      unit,
      ctx,
      prompt,
      known: new Map(),
      working: {},
      usage,

      async context(ci = {}) {
        const input = ci.input ?? {}
        const reads = unit.memory.read
        const layers = layersOf(unit)
        const parts: ContextParts = {}
        const src = opts.layers ?? {}
        if (layers.includes('platform') && src.platform) parts.platform = await src.platform(ctx, unit)
        if (layers.includes('tenant') && src.tenant) parts.tenant = await src.tenant(ctx, unit)
        if (layers.includes('role') && src.role) parts.role = await src.role(ctx, unit)
        if (layers.includes('surface') && src.surface) parts.surface = await src.surface(ctx, unit, input)
        parts.unit = prompt.text

        const lines: string[] = []
        if (reads.includes('working') && Object.keys(scope.working).length) {
          for (const [k, v] of Object.entries(scope.working)) lines.push(`[working] ${k} = ${typeof v === 'string' ? v : JSON.stringify(v)}`)
        }
        if (reads.includes('known')) lines.push(...knownLines(scope.known))
        const longTerm = reads.filter((s): s is LongTermScope => s === 'person' || s === 'tenant')
        if (longTerm.length && memory) {
          for (const m of await memory.recall(ctx, longTerm)) lines.push(`[remembered, ${m.scope}] ${m.text}`)
        }
        if (lines.length) parts.memory = lines

        const retrieved: Retrieved[] = []
        for (const name of unit.context.retrievers ?? []) {
          const r = opts.retrievers?.[name]
          if (!r) throw new Error(`${unit.id} names retriever ${name}, which createAi was not given`)
          retrieved.push(...(await r(ctx, { unit, input })))
        }
        if (retrieved.length) parts.retrieved = retrieved

        let thread: { summary: string | null; turns: Message[] } | undefined
        if (reads.includes('conversation') && ci.thread) {
          if (!memory) throw new Error(`${unit.id} reads the conversation, and createAi has no memory store`)
          thread = await memory.store.thread(ci.thread, 200)
          parts.conversation = { summary: thread.summary ?? undefined, turns: thread.turns }
        }
        const untrusted = untrustedOf(unit, input)
        if (untrusted.length) parts.untrusted = untrusted
        if (ci.images?.length) parts.images = ci.images
        Object.assign(parts, ci.parts ?? {})

        const built = await buildContext(parts, {
          layers,
          budgetTokens: unit.context.budgetTokens,
          budgets: unit.context.budgets,
          ...(opts.compact && thread ? { compact: (dropped, summary) => opts.compact!(ctx, dropped, summary) } : {}),
        })
        if (built.compaction && built.summary !== undefined && ci.thread && memory && thread) {
          await memory.store.compactThread(ci.thread, built.summary, Math.max(0, thread.turns.length - built.compaction.dropped))
        }
        await runs.updateRun(id, { context: { tokens: built.tokens, layers: built.layers, ...(built.compaction ? { compaction: built.compaction } : {}) } })
        return built
      },

      async complete(req, o = {}) {
        const attempts = plan(req, o)
        let lastErr: unknown
        for (let i = 0; i < attempts.length; i++) {
          const a = attempts[i]!
          await capCheck(ctx, unit, usage.costMicros, a.estimate, false)
          let res: CompleteResult
          try {
            res = await client.ai.complete(a.body, o.signal)
          } catch (e) {
            lastErr = refusalOf(e)
            if (lastErr instanceof CapRefusal) throw lastErr
            if (i + 1 < attempts.length && fallbackable(e)) continue
            throw e
          }
          await account(res, a.body.model!, a.role)
          return res
        }
        throw lastErr
      },

      async *stream(req, o = {}) {
        if (!client.ai.stream) throw new Error('this Core client cannot stream')
        const attempts = plan(req, o)
        for (let i = 0; i < attempts.length; i++) {
          const a = attempts[i]!
          await capCheck(ctx, unit, usage.costMicros, a.estimate, false)
          let started = false
          try {
            for await (const ev of client.ai.stream(a.body, o.signal)) {
              started = true
              if (ev.type === 'done') await account(ev.result, a.body.model!, a.role)
              yield ev
            }
            return
          } catch (e) {
            const r = refusalOf(e)
            if (r instanceof CapRefusal) throw r
            // A stream that has sent text is not started again on another model.
            if (!started && i + 1 < attempts.length && fallbackable(e)) continue
            throw e
          }
        }
      },

      async structured<O>(built: BuiltContext, o: CallModelOptions = {}): Promise<StructuredResult<O>> {
        const schema = unit.outputJson as JsonSchema | undefined
        if (!schema || !unit.output) throw new Error(`${unit.id} has no output schema`)
        const base = { system: built.system, messages: built.messages }
        const check = async (value: unknown, via: 'response_format' | 'tool', result: CompleteResult): Promise<StructuredResult<O>> => {
          const v = await validate(unit.output as SchemaLike<O>, value)
          return v.ok ? { ok: true, output: v.value, via, result } : { ok: false, issues: v.issues, result }
        }
        if ((opts.structured ?? 'response_format') === 'response_format') {
          try {
            const res = await scope.complete(
              { ...base, response_format: { type: 'json_schema', json_schema: { name: 'output', schema, ...(strictable(schema) ? { strict: true } : {}) } } },
              o,
            )
            if (res.output !== undefined) return check(res.output, 'response_format', res)
            try {
              return check(JSON.parse(res.text), 'response_format', res)
            } catch {
              return { ok: false, issues: [{ message: 'the reply was not JSON', path: '' }], result: res }
            }
          } catch (e) {
            if (codeOf(e) !== 'MODEL_UNSUPPORTED') throw e
          }
        }
        const res = await scope.complete(
          {
            ...base,
            tools: [{ name: OUTPUT_TOOL, description: 'Submit the result. Call this exactly once with the whole result.', input_schema: schema }],
            tool_choice: { type: 'tool', name: OUTPUT_TOOL },
          },
          o,
        )
        const call = res.tool_calls?.find((t) => t.name === OUTPUT_TOOL)
        if (!call) return { ok: false, issues: [{ message: `the model did not call ${OUTPUT_TOOL}`, path: '' }], result: res }
        return check(call.input, 'tool', res)
      },

      call: (name, args, callOpts) => recordEffect(ctx, unit, id, seq, name, args, callOpts) as Promise<RunCallOutcome<any>>,

      async propose(s, text, mentions) {
        if (!unit.memory.write.includes(s)) throw new Error(`${unit.id} may not write ${s} memory`)
        if (!memory) throw new Error('createAi has no memory store')
        return memory.propose(ctx, { scope: s, text, mentions, unit: unit.id, runId: id })
      },

      finish,
    }
    return scope
  }

  return {
    memory,
    guard: opts.guard,
    runs,
    start,
    resume,

    async run<I, O>(ctx: C, unit: Unit<I, O, any>, input: I, ro: RunOptions = {}): Promise<RunResult<O>> {
      if (unit.kind !== 'task') throw new Error(`ai.run runs tasks; ${unit.id} is a ${unit.kind}, use ai.start`)
      let parsed: I = input
      if (unit.input) {
        const v = await validate(unit.input as SchemaLike<I>, input)
        if (!v.ok) throw new Error(`${unit.id} input: ${v.issues.map((i) => `${i.path || '(root)'} ${i.message}`).join('; ')}`)
        parsed = v.value
      }
      const zero = zeroUsage()
      let scope: RunScope<C>
      try {
        scope = await start(ctx, unit, { language: ro.language, vars: varsOf(unit, parsed), tags: ro.tags })
      } catch (e) {
        if (e instanceof CapRefusal) return { outcome: 'refused_cap', runId: e.runId ?? '', cap: e.cap, message: e.message, usage: zero }
        throw e
      }
      const usage = () => ({ ...scope.usage })
      try {
        const built = await scope.context({ input: (parsed ?? {}) as Record<string, unknown>, thread: ro.thread, images: ro.images })
        // The whole run's estimate, against the day caps, before the first call.
        const price = priceFor(undefined, modelFor(unit.model.use), unit.model.use)
        const outTokens = unit.model.maxOutputTokens ?? opts.defaultOutputTokens ?? 1000
        const estimate = price ? Math.ceil(built.tokens * price.input + outTokens * price.output) : 0
        await capCheck(ctx, unit, 0, estimate, true)

        const s = await scope.structured<O>(built, { signal: ro.signal, live: ro.live })
        if (!s.ok) {
          await scope.finish('invalid_output', { code: 'invalid_output', message: s.issues.map((i) => `${i.path || '(root)'} ${i.message}`).join('; ') })
          return { outcome: 'invalid_output', runId: scope.id, issues: s.issues, usage: usage() }
        }
        let save: RunCallOutcome | undefined
        if (unit.target && ro.save !== false) save = await scope.call(unit.target, s.output)
        await scope.finish('ok')
        return { outcome: 'ok', runId: scope.id, output: s.output, ...(save ? { save } : {}), usage: usage() }
      } catch (e) {
        if (e instanceof CapRefusal) {
          await scope.finish('refused_cap', { code: `cap_${e.cap}`, message: e.message })
          return { outcome: 'refused_cap', runId: scope.id, cap: e.cap, message: e.message, usage: usage() }
        }
        const code = codeOf(e) ?? 'error'
        const message = (e as Error)?.message ?? String(e)
        await scope.finish('error', { code, message })
        return { outcome: 'error', runId: scope.id, code, message, usage: usage() }
      }
    },

    async callInRun(ctx, unit, runId, name, args, callOpts) {
      const run = await runs.getRun(runId)
      if (!run || run.unit !== unit.id || run.tenant !== ctx.tenant) {
        return { outcome: 'refused_unit', code: 'tool_not_allowed', message: 'No such run for this unit in this tenant.', requestId: ctx.requestId }
      }
      let n = (await nextSeq(runId)) - 1
      return recordEffect(ctx, unit, runId, async () => ++n, name, args, callOpts) as Promise<RunCallOutcome<any>>
    },

    async previewInRun(ctx, unit, runId, name, args, callOpts) {
      const run = await runs.getRun(runId)
      if (!run || run.unit !== unit.id || run.tenant !== ctx.tenant) {
        return { outcome: 'refused_unit', code: 'tool_not_allowed', message: 'No such run for this unit in this tenant.', requestId: ctx.requestId }
      }
      let n = (await nextSeq(runId)) - 1
      return recordEffect(ctx, unit, runId, async () => ++n, name, args, callOpts, true) as Promise<RunPreviewOutcome>
    },

    async recordInRun(runId, r) {
      if (!RECORDED_OUTCOMES.includes(r.outcome)) throw new TypeError(`recordInRun records ${RECORDED_OUTCOMES.join(', ')}; ${r.outcome} comes from the guard`)
      const tier = r.tier ?? null
      const row: EffectRow = {
        id: newId('effect'),
        runId,
        seq: await nextSeq(runId),
        capability: r.capability,
        tier,
        mode: r.mode ?? (tier ? modeOf(tier) : 'write'),
        argsHash: '',
        idempotencyKey: r.idempotencyKey ?? '',
        outcome: r.outcome,
        code: r.code ?? null,
        approvalId: r.approvalId ?? null,
        requestId: r.requestId,
        at: new Date(nowMs()).toISOString(),
        ms: 0,
        step: r.step.key,
        stepKind: r.step.kind,
        message: r.message ?? null,
        ref: r.ref ?? null,
        preview: r.preview ?? false,
      }
      await runs.insertEffect(row)
      return row
    },
  }
}

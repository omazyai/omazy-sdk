// An actor's definition: the target it submits, its slots and their order,
// and the unit manifest its model calls belong to. Checked when the module
// loads, the way `capability()` and `task()` are; the slots are matched to
// the target's input schema when the runtime is built.

import { NAME_PATTERN } from '../capabilities/capability.js'
import type { StandardSchemaV1 } from '../capabilities/standard.js'
import { type JsonSchema, withJsonSchema } from '../capabilities/standard.js'
import { isTier, needsConfirm, type Tier } from '../capabilities/tiers.js'
import { actorUnit, type ContextRecipe, type Unit, type UnitSpec } from '../ai/manifest.js'
import type { BaseCtx } from '../capabilities/capability.js'
import type { ActorSession, AttachmentRef, CardRow, Choice } from './types.js'

/** The values filled so far, by slot name. */
export type Values = Readonly<Record<string, unknown>>

/** Words per language. A plain string is used for every language. */
export type Words = string | Readonly<Record<string, string>>

export interface LookupSpec<C extends BaseCtx = BaseCtx> {
  /** A read capability (R0 or R1), called through the guard. */
  capability: string
  /** The read's arguments from what the person wrote and the values so far. */
  args: (query: string | undefined, values: Values, ctx: C) => unknown
  /** The records the read found, as choices. One is filled; two or more are asked; none is said. */
  choices: (result: unknown, query: string | undefined) => Choice[]
  /** Run without a query once the slots in `after` are filled (an open invoice for the tenant). */
  auto?: boolean
}

export interface CheckSpec<C extends BaseCtx = BaseCtx> {
  /** A read capability (R0 or R1), such as `payment_ref_unused`, called through the guard. */
  capability: string
  args: (value: unknown, values: Values, ctx: C) => unknown
  /** True when the read says the value is good, or one sentence saying why not. */
  ok: (result: unknown, value: unknown) => true | string
}

export interface DeriveInput<C extends BaseCtx = BaseCtx> {
  values: Values
  ctx: C
  attachments: readonly AttachmentRef[]
  session: Readonly<ActorSession>
}

export interface SlotOptions<C extends BaseCtx = BaseCtx> {
  /** The slot's name for a person. Default: the schema's title, or the field name in words. */
  label?: Words
  /** What the extractor is told about the field. Default: the schema's description. */
  hint?: string
  /** The question for a missing value. Default: "What is the <label>?" */
  ask?: Words
  /** Default: required in the schema, with no default and not derived. */
  required?: boolean
  /** Slots that must be filled before this one is asked or looked up. */
  after?: readonly string[]
  /** The slot is part of the input only while this holds. */
  when?: (values: Values, ctx: C) => boolean
  /** Used when nothing was given. A function of the values so far is evaluated at the card. */
  default?: unknown | ((values: Values, ctx: C) => unknown)
  /** Computed by code, never extracted or asked: `recorded_by` from the ctx, `proof_key` from the attachment. */
  derive?: (d: DeriveInput<C>) => unknown
  /** False: the extractor's values for this slot are refused. Default true, false for derived slots. */
  extract?: boolean
  /** Below this confidence a value is asked about, never filled. Default the actor's (0.8). */
  threshold?: number
  /** Resolves what the person wrote to an id. Ids are never taken from the model. */
  lookup?: LookupSpec<C>
  /** A guard-checked read that must pass, such as "this bank reference is not used". */
  check?: CheckSpec<C>
  /** The product's own check, the same function its route runs. True, or one sentence. */
  validate?: (value: unknown, values: Values, ctx: C) => true | string | Promise<true | string>
  /** Turns what was read into the value the target takes (taka to minor units). Throw or return undefined to refuse it. */
  parse?: (raw: unknown) => unknown
  /** How a value reads to a person. */
  format?: (value: unknown, language: string) => string
  /** Fixed choices offered with the question, such as currencies. */
  choices?: readonly Choice[]
}

export interface SlotDef<C extends BaseCtx = BaseCtx> extends SlotOptions<C> {
  name: string
}

/** One slot: a field of the target's input, and how to collect it. */
export function slot<C extends BaseCtx = BaseCtx>(name: string, opts: SlotOptions<C> = {}): SlotDef<C> {
  return { name, ...opts }
}

export interface CrossIssue {
  slot: string
  message: string
}

/** The part of a capability `actor()` reads when it is given the capability itself. */
export interface TargetRef {
  name: string
  risk: Tier
}

export interface ActorSpec<C extends BaseCtx = BaseCtx> extends Omit<UnitSpec, 'target' | 'output' | 'input' | 'tools' | 'context' | 'memory'> {
  /**
   * The one capability it submits, R2 or higher, so a person's confirm or an
   * approval through the guard always stands between the conversation and
   * the change. Its input schema is where the slots come from. Give the
   * capability itself and its tier is checked here; give its name and it is
   * checked when the runtime is built.
   */
  target: string | TargetRef
  /** What the card is about, such as "Record a manual bank payment". Default the target's title. */
  title?: Words
  /** Slots in the order they are asked. Fields of the target not listed come after, in schema order. */
  slots?: readonly SlotDef<C>[]
  /** Only the listed slots: other fields of the target are left out of the input. */
  only?: boolean
  /** Default `{ layers: ['unit'], budgetTokens: 6000 }`. `known`, `message` and `attachment` are always untrusted. */
  context?: Partial<ContextRecipe>
  memory?: UnitSpec['memory']
  /** More capabilities the actor may call. The lookups and checks of its slots are added. Default maxTier R1. */
  tools?: { allow?: readonly string[]; maxTier?: Tier }
  /** Checks across fields, once every required slot is filled. */
  check?: (values: Values, ctx: C) => CrossIssue[] | Promise<CrossIssue[]>
  /** The card's sentence, from the values and how each reads. Default: the guard's preview at R2, else the title. */
  summary?: (values: Values, language: string, rows: readonly CardRow[]) => string
  /** The form's link, pre-filled. */
  handoff?: (prefill: Record<string, unknown>, session: Readonly<ActorSession>) => string
  /** Idle time before a session expires. Default 24 hours. */
  idleMs?: number
  /** The confidence below which a value is asked about. Default 0.8. */
  threshold?: number
}

export interface Actor<C extends BaseCtx = BaseCtx> {
  readonly kind: 'actor'
  readonly id: string
  readonly version: number
  readonly target: string
  readonly title: Words | undefined
  readonly slots: readonly SlotDef<C>[]
  readonly only: boolean
  readonly threshold: number
  readonly idleMs: number
  readonly check?: ActorSpec<C>['check']
  readonly summary?: ActorSpec<C>['summary']
  readonly handoff?: ActorSpec<C>['handoff']
  /** The manifest of its model calls. A turn with an image uses its `attachments.vision` role for that call. */
  readonly unit: Unit<unknown, Extraction>
}

export type AnyActor = Actor<any>

export class ActorError extends Error {
  constructor(
    readonly actor: string,
    readonly problems: string[],
  ) {
    super(`actor ${actor || '(unnamed)'}: ${problems.join('; ')}`)
    this.name = 'ActorError'
  }
}

// ---------------------------------------------------------------- the extractor's output

/** One value the extractor read. */
export interface ExtractedItem {
  slot: string
  value: string | number | boolean | null
  /** 0 to 1. */
  confidence: number
  /** The words, or the part of an attachment, it was read from. */
  evidence: string
  /** `message`, or the attachment id. */
  from: string
}

export interface Extraction {
  items: ExtractedItem[]
}

/** The JSON Schema every extraction is forced through. Closed and strict. */
export const EXTRACTION_JSON: JsonSchema = Object.freeze({
  type: 'object',
  properties: {
    items: {
      type: 'array',
      maxItems: 64,
      items: {
        type: 'object',
        properties: {
          slot: { type: 'string', description: 'A field name from the list.' },
          value: { type: ['string', 'number', 'boolean', 'null'], description: 'The value as read.' },
          confidence: { type: 'number', minimum: 0, maximum: 1 },
          evidence: { type: 'string', description: 'The words or the part of the attachment it was read from.' },
          from: { type: 'string', description: 'message, or the attachment id.' },
        },
        required: ['slot', 'value', 'confidence', 'evidence', 'from'],
        additionalProperties: false,
      },
    },
  },
  required: ['items'],
  additionalProperties: false,
}) as JsonSchema

const extractionStandard: StandardSchemaV1<unknown, Extraction> = {
  '~standard': {
    version: 1,
    vendor: 'omazy',
    validate(v: unknown): StandardSchemaV1.Result<Extraction> {
      const fail = (message: string, path: (string | number)[] = []) => ({ issues: [{ message, path }] })
      if (!v || typeof v !== 'object' || !Array.isArray((v as { items?: unknown }).items)) return fail('items must be a list', ['items'])
      const items: ExtractedItem[] = []
      const raw = (v as { items: unknown[] }).items
      for (let i = 0; i < raw.length && i < 64; i++) {
        const x = raw[i] as Record<string, unknown> | null
        if (!x || typeof x !== 'object') return fail('an item must be an object', ['items', i])
        if (typeof x.slot !== 'string' || !x.slot) return fail('slot must be a field name', ['items', i, 'slot'])
        const value = x.value
        if (!(value === null || ['string', 'number', 'boolean'].includes(typeof value))) return fail('value must be a string, number, boolean or null', ['items', i, 'value'])
        const c = typeof x.confidence === 'number' && Number.isFinite(x.confidence) ? Math.min(1, Math.max(0, x.confidence)) : 0
        items.push({
          slot: x.slot,
          value: value as ExtractedItem['value'],
          confidence: c,
          evidence: typeof x.evidence === 'string' ? x.evidence.slice(0, 500) : '',
          from: typeof x.from === 'string' && x.from ? x.from : 'message',
        })
      }
      return { value: { items } }
    },
  },
}

/** The extractor's output schema, for an actor's unit. */
export const extractionSchema = withJsonSchema(extractionStandard, EXTRACTION_JSON as JsonSchema)

/** The inputs every actor turn fences as untrusted. */
export const ACTOR_UNTRUSTED = ['known', 'message', 'attachment'] as const

// ---------------------------------------------------------------- actor()

const DAY = 86_400_000

/**
 * Defines an actor. Throws `ActorError` (or `UnitError` for the manifest
 * part) listing every problem, so a bad actor never reaches a session.
 */
export function actor<C extends BaseCtx = BaseCtx>(spec: ActorSpec<C>): Actor<C> {
  const p: string[] = []
  const ref = spec.target
  const target = typeof ref === 'string' ? ref : ref && typeof ref === 'object' ? ref.name : undefined
  if (typeof target !== 'string' || !NAME_PATTERN.test(target)) p.push('target must name a capability')
  else if (typeof ref === 'object') {
    const tp = targetTierProblem(target, ref.risk)
    if (tp) p.push(tp)
  }
  const slots = spec.slots ?? []
  const names = new Set<string>()
  for (const s of slots) {
    if (!s || typeof s.name !== 'string' || !/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(s.name)) {
      p.push(`slot ${String(s?.name)} must be a field name`)
      continue
    }
    if (names.has(s.name)) p.push(`slot ${s.name} is listed twice`)
    names.add(s.name)
  }
  for (const s of slots) {
    if (s.threshold !== undefined && !(typeof s.threshold === 'number' && s.threshold > 0 && s.threshold <= 1)) p.push(`slot ${s.name}: threshold must be above 0 and at most 1`)
    for (const a of s.after ?? []) {
      if (!names.has(a)) p.push(`slot ${s.name} comes after ${a}, which is not a listed slot`)
      if (a === s.name) p.push(`slot ${s.name} comes after itself`)
    }
    if (s.derive && s.lookup) p.push(`slot ${s.name} is derived, so it has no lookup`)
    if (s.derive && s.extract === true) p.push(`slot ${s.name} is derived, so it is never extracted`)
    for (const r of [s.lookup, s.check]) {
      if (r && (typeof r.capability !== 'string' || !NAME_PATTERN.test(r.capability))) p.push(`slot ${s.name}: a lookup or check must name a capability`)
    }
    if (s.lookup && (typeof s.lookup.args !== 'function' || typeof s.lookup.choices !== 'function')) p.push(`slot ${s.name}: a lookup needs args and choices`)
    if (s.check && (typeof s.check.args !== 'function' || typeof s.check.ok !== 'function')) p.push(`slot ${s.name}: a check needs args and ok`)
  }
  // A cycle in `after` would leave slots no one can ask.
  const visiting = new Set<string>()
  const done = new Set<string>()
  const byName = new Map(slots.map((s) => [s.name, s]))
  const visit = (n: string): boolean => {
    if (done.has(n)) return false
    if (visiting.has(n)) return true
    visiting.add(n)
    const cyc = (byName.get(n)?.after ?? []).some(visit)
    visiting.delete(n)
    done.add(n)
    return cyc
  }
  if (slots.some((s) => visit(s.name))) p.push('slots depend on each other in a circle')
  const threshold = spec.threshold ?? 0.8
  if (!(threshold > 0 && threshold <= 1)) p.push('threshold must be above 0 and at most 1')
  const idleMs = spec.idleMs ?? DAY
  if (!(Number.isInteger(idleMs) && idleMs >= 60_000)) p.push('idleMs must be a whole number of at least 60000')
  const maxTier = spec.tools?.maxTier ?? 'R1'
  if (!isTier(maxTier)) p.push('tools.maxTier must be R0 to R4')
  if (p.length) throw new ActorError(spec.id, p)

  const reads = slots.flatMap((s) => [s.lookup?.capability, s.check?.capability]).filter((x): x is string => !!x)
  const allow = [...new Set([...(spec.tools?.allow ?? []), ...reads])]
  const ctxSpec = spec.context ?? {}
  const context: ContextRecipe = {
    layers: ctxSpec.layers ?? ['unit'],
    budgetTokens: ctxSpec.budgetTokens ?? 6000,
    ...(ctxSpec.budgets ? { budgets: ctxSpec.budgets } : {}),
    ...(ctxSpec.retrievers ? { retrievers: ctxSpec.retrievers } : {}),
    untrusted: [...new Set([...ACTOR_UNTRUSTED, ...(ctxSpec.untrusted ?? [])])],
    // A session's values change every turn; a stored reply would be wrong.
    live: ctxSpec.live ?? true,
  }
  const {
    target: _target,
    title,
    slots: _s,
    only,
    context: _c,
    tools: _t,
    check,
    summary,
    handoff,
    idleMs: _i,
    threshold: _th,
    memory,
    ...rest
  } = spec
  const base = {
    ...rest,
    target: target!,
    context,
    memory: memory ?? { read: [], write: [] },
    output: extractionSchema,
    ...(allow.length ? { tools: { allow, maxTier } } : {}),
  } satisfies UnitSpec<unknown, Extraction>
  const unit = actorUnit<{}, unknown, Extraction>(base)

  return Object.freeze({
    kind: 'actor' as const,
    id: spec.id,
    version: spec.version,
    target: target!,
    title,
    slots: Object.freeze([...slots]),
    only: only === true,
    threshold,
    idleMs,
    ...(check ? { check } : {}),
    ...(summary ? { summary } : {}),
    ...(handoff ? { handoff } : {}),
    unit,
  })
}

/**
 * Null when a capability of this tier may be an actor's target. R0 and R1 run
 * with no confirm, so a conversation would end in a change no person agreed
 * to on a card. Anything that is not a tier counts as R4 and passes.
 */
export function targetTierProblem(name: string, risk: unknown): string | null {
  if (isTier(risk) && !needsConfirm(risk)) {
    return `target ${name} is ${risk}; an actor's target must be R2 or higher, so a person confirms the change through the guard`
  }
  return null
}

// One action a product offers, defined once: who may see it, how risky it
// is, what it takes and gives, which fields hold personal data, and the two
// functions that preview it and run it. Every surface (MCP doors, a copilot,
// AI units, console forms) is generated from this definition.

import { type Issue, type JsonSchema, type SchemaLike, toJsonSchema } from './standard.js'
import { isTier, needsApproval, needsConfirm, type Tier, tierRank } from './tiers.js'

/** Where a call came from. */
export type Channel = 'console' | 'mcp' | 'copilot' | 'actor' | 'workflow' | 'automation' | (string & {})

/** Who is acting: a person, a service key or an automation. */
export interface Principal {
  /** The product's own kinds, such as `super_admin`, `member`, `service`, `automation`. */
  kind: string
  id: string
  name?: string
}

/** One principal at one door and, for tenant doors, one tenant. */
export interface Seat {
  id: string
  door: string
  tenant: string | null
}

/** What every capability call carries. A product adds its own fields with `Ctx<{ ... }>`. */
export interface BaseCtx {
  principal: Principal
  seat: Seat | null
  /** Always the seat's tenant when there is a seat. No argument moves a call to another tenant. */
  tenant: string | null
  channel: Channel
  /** Set when the call runs on a decided approval. */
  approvalId: string | null
  /** Carried across services and written on every log and audit row. */
  requestId: string
}

export type Ctx<X extends object = {}> = BaseCtx & X

/** What a preview shows before a change: a plain before and after, and the target's state version. */
export interface Preview {
  /** One sentence a person reads on a confirm card or an approval page. */
  summary: string
  before?: unknown
  after?: unknown
  /**
   * The target's version as read now (its updated_at, or a hash of the rows
   * the change touches). A confirm token or approval is refused as stale when
   * it has moved by the time the change runs.
   */
  stateVersion?: string
  [extra: string]: unknown
}

export interface Deprecation {
  /** YYYY-MM-DD, the day it was marked. */
  since: string
  /** YYYY-MM-DD, the day it may be removed. Defaults to 90 days after `since`. */
  removeAfter?: string
  /** The capability that replaces it. */
  use?: string
  reason?: string
}

export interface CapabilitySpec<I, O, C extends BaseCtx = BaseCtx, P = unknown, A extends string = string> {
  /** `<noun>_<verb>` in lower case, such as `payment_record` or `tenants_list`. Never renamed once shipped. */
  name: string
  /** The doors that may see it, such as `platform`, `org`, `host`. */
  audiences: readonly A[]
  /** A short label for people. */
  title: string
  /**
   * A prompt, 80 to 600 characters: what it does, what it does not, and
   * "Not for X: use Y" when there is a near neighbour.
   */
  description: string
  /** Other words people use for it. Searched, not sent to the model by default. */
  synonyms?: readonly string[]
  /** Passed as is to the product's permission hook. */
  permission: P
  /** The highest tier this capability can reach. */
  risk: Tier
  /**
   * A lower tier for some inputs, such as turning a kill switch off. It never
   * weakens caution: a tier above `risk` is used as is (and warned about once,
   * because the MCP hints come from `risk`), and a value that is not a tier,
   * or a throw, counts as R4.
   */
  riskFor?: (input: I) => Tier
  /** The approval policy name, from the product's policy table. Required at R3 and R4. */
  approval?: string
  input: SchemaLike<I>
  output?: SchemaLike<O>
  /**
   * Paths of fields that hold personal data, in the input or the output:
   * `email`, `visitor.phone`, `rows.*.name`. Redacted from logs.
   */
  pii?: readonly string[]
  /** Starts at 1. Raised on every additive schema change. */
  version: number
  deprecated?: Deprecation
  /** Reaches outside the product (sends mail, posts on the web). Sets the MCP openWorldHint. */
  openWorld?: boolean
  /** Required at R2 and above: what would change, without changing it. */
  preview?: (ctx: C, input: I) => Preview | Promise<Preview>
  run: (ctx: C, input: I) => O | Promise<O>
  /**
   * The text a model reads for a completed call, such as "Filed NCR-10042:
   * pothole at Main St." The output still goes out as structured content.
   * Default: the output as JSON text.
   */
  say?: (output: O, ctx: C) => string
  /**
   * What to do with an argument the input schema does not name. `refuse`
   * (the default) ends the call `invalid`. `strip` drops it, runs the call
   * and writes the dropped paths to the request log. Use `strip` only to keep
   * clients that always sent extra fields working.
   */
  unknownFields?: 'refuse' | 'strip'
  /** The one sentence for an `invalid` call, from its validation issues. Default: each issue with its path. */
  invalidMessage?: (issues: Issue[]) => string
}

/** A checked capability. Its JSON Schemas are computed once, closed. */
export interface Capability<I = any, O = any, C extends BaseCtx = any, P = any, A extends string = string>
  extends Readonly<CapabilitySpec<I, O, C, P, A>> {
  readonly kind: 'capability'
  readonly inputJson: JsonSchema
  readonly outputJson: JsonSchema | undefined
}

export type AnyCapability = Capability<any, any, any, any, string>

export class CapabilityError extends Error {
  constructor(
    readonly capability: string,
    readonly problems: string[],
  ) {
    super(`capability ${capability || '(unnamed)'}: ${problems.join('; ')}`)
    this.name = 'CapabilityError'
  }
}

export const NAME_PATTERN = /^[a-z][a-z0-9]*(_[a-z0-9]+)+$/
export const DESCRIPTION_MIN = 80
export const DESCRIPTION_MAX = 600
export const DEPRECATION_DAYS = 90

const DATE = /^\d{4}-\d{2}-\d{2}$/
const isDate = (s: unknown): s is string => typeof s === 'string' && DATE.test(s) && !Number.isNaN(Date.parse(`${s}T00:00:00Z`))

/** The day a deprecated capability may be removed. */
export function removeAfter(d: Deprecation): string {
  if (d.removeAfter) return d.removeAfter
  const t = Date.parse(`${d.since}T00:00:00Z`) + DEPRECATION_DAYS * 86_400_000
  return new Date(t).toISOString().slice(0, 10)
}

/**
 * Every rule a definition must meet, as sentences. Empty means it is sound.
 * `capability()` throws on these; the parity check reports them.
 */
export function definitionProblems(spec: Partial<CapabilitySpec<unknown, unknown, any, unknown, string>>): string[] {
  const p: string[] = []
  const name = spec.name ?? ''
  if (!NAME_PATTERN.test(name) || name.length > 64) p.push('name must be <noun>_<verb>: lower case words joined by _, at most 64 characters')
  if (!Array.isArray(spec.audiences) || spec.audiences.length === 0) p.push('audiences must name at least one door')
  else if (new Set(spec.audiences).size !== spec.audiences.length) p.push('audiences repeat a door')
  if (!spec.title?.trim()) p.push('title is empty')
  const len = [...(spec.description ?? '')].length
  if (len < DESCRIPTION_MIN || len > DESCRIPTION_MAX) p.push(`description must be ${DESCRIPTION_MIN} to ${DESCRIPTION_MAX} characters, is ${len}`)
  if (spec.synonyms && !spec.synonyms.every((s) => typeof s === 'string' && s.trim())) p.push('synonyms must be non-empty strings')
  if (!isTier(spec.risk)) p.push(`risk must be one of R0 to R4, is ${String(spec.risk)}`)
  else {
    if (needsApproval(spec.risk) && !spec.approval) p.push(`${spec.risk} needs an approval policy`)
    if (needsConfirm(spec.risk) && typeof spec.preview !== 'function') p.push(`${spec.risk} needs a preview`)
  }
  if (spec.approval !== undefined && (typeof spec.approval !== 'string' || !spec.approval)) p.push('approval must be a policy name')
  if (!Number.isInteger(spec.version) || (spec.version as number) < 1) p.push('version must be a whole number from 1')
  if (typeof spec.run !== 'function') p.push('run is missing')
  if (spec.say !== undefined && typeof spec.say !== 'function') p.push('say must be a function')
  if (spec.invalidMessage !== undefined && typeof spec.invalidMessage !== 'function') p.push('invalidMessage must be a function')
  if (spec.unknownFields !== undefined && spec.unknownFields !== 'refuse' && spec.unknownFields !== 'strip') p.push("unknownFields must be 'refuse' or 'strip'")
  if (!spec.input) p.push('input schema is missing')
  if (spec.pii && !spec.pii.every((x) => typeof x === 'string' && /^[^.\s]+(\.[^.\s]+)*$/.test(x))) p.push('pii must be dotted paths')
  const d = spec.deprecated
  if (d) {
    if (!isDate(d.since)) p.push('deprecated.since must be YYYY-MM-DD')
    if (d.removeAfter !== undefined && !isDate(d.removeAfter)) p.push('deprecated.removeAfter must be YYYY-MM-DD')
    if (d.use !== undefined && !NAME_PATTERN.test(d.use)) p.push('deprecated.use must name a capability')
  }
  return p
}

function schemaOf(name: string, side: 'input' | 'output', s: SchemaLike<unknown>, problems: string[]): JsonSchema | undefined {
  try {
    const json = toJsonSchema(s, side)
    if (side === 'input' && (json.type !== 'object' || json.additionalProperties !== false)) {
      problems.push('input must be a closed object schema (type object, additionalProperties false)')
    }
    return json
  } catch (e) {
    problems.push(`${side} schema: ${(e as Error).message}`)
    return undefined
  }
}

/**
 * Defines a capability and checks it. Throws `CapabilityError` listing every
 * rule it breaks, so a bad definition fails when the module loads.
 */
export function capability<I, O, C extends BaseCtx = BaseCtx, P = unknown, A extends string = string>(
  spec: CapabilitySpec<I, O, C, P, A>,
): Capability<I, O, C, P, A> {
  const problems = definitionProblems(spec as CapabilitySpec<unknown, unknown, any, unknown, string>)
  const inputJson = spec.input ? schemaOf(spec.name, 'input', spec.input, problems) : undefined
  const outputJson = spec.output ? schemaOf(spec.name, 'output', spec.output, problems) : undefined
  if (problems.length) throw new CapabilityError(spec.name, problems)
  return Object.freeze({
    ...spec,
    audiences: Object.freeze([...spec.audiences]),
    ...(spec.synonyms ? { synonyms: Object.freeze([...spec.synonyms]) } : {}),
    ...(spec.pii ? { pii: Object.freeze([...spec.pii]) } : {}),
    kind: 'capability' as const,
    inputJson: inputJson as JsonSchema,
    outputJson,
  })
}

/**
 * Binds the product's context, permission and door types once, so each
 * definition is checked against them without repeating the generics.
 *
 *     const { capability } = defineCapabilities<MyCtx, MyPermission, 'platform' | 'org'>()
 */
export function defineCapabilities<C extends BaseCtx, P = unknown, A extends string = string>() {
  return {
    capability: <I, O>(spec: CapabilitySpec<I, O, C, P, A>) => capability<I, O, C, P, A>(spec),
  }
}

const warnedAbove = new Set<string>()

/**
 * Called when `riskFor` returns a tier above the declared `risk`. The call
 * still runs at the higher tier; this only tells the developer that `risk`
 * (and so the MCP hints) understates the capability. Replace it to send the
 * warning elsewhere, or to throw in tests.
 */
let onTierAboveRisk = (name: string, declared: Tier, got: Tier): void => {
  if (warnedAbove.has(name)) return
  warnedAbove.add(name)
  console.warn(`capability ${name}: riskFor gave ${got}, above its declared risk ${declared}; raise risk to ${got}`)
}

/** Sets the handler for a `riskFor` tier above `risk`. */
export function setTierAboveRiskHandler(fn: (name: string, declared: Tier, got: Tier) => void): void {
  onTierAboveRisk = fn
}

/**
 * The tier of one call. `riskFor(input)` may lower it below `risk`. A tier
 * above `risk` is used, the stricter one, and reported. Anything that is not a
 * tier, a throw, or an unknown `risk` gives R4.
 */
export function tierFor<I>(cap: Pick<CapabilitySpec<I, unknown, any>, 'risk' | 'riskFor'> & { name?: string }, input: I): Tier {
  const declared: Tier = isTier(cap.risk) ? cap.risk : 'R4'
  if (!cap.riskFor) return declared
  let t: unknown
  try {
    t = cap.riskFor(input)
  } catch {
    return 'R4'
  }
  if (!isTier(t)) return 'R4'
  if (tierRank(t) > tierRank(declared)) onTierAboveRisk(cap.name ?? '(unnamed)', declared, t)
  return t
}

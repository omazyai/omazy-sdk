// Unit manifests. Every model call belongs to a unit: a task, an actor, a
// copilot or a workflow. The manifest names the model role, the prompt
// version, the context recipe, the memory scopes, the tools and their highest
// tier, the output, the evals and the caps. It is checked when the module
// loads, the way `capability()` checks a capability, so a bad manifest never
// reaches a run.

import { NAME_PATTERN } from '../capabilities/capability.js'
import { type JsonSchema, type SchemaLike, toJsonSchema } from '../capabilities/standard.js'
import { isTier, type Tier } from '../capabilities/tiers.js'
import { type Tags, tagProblems } from './tags.js'

export type UnitKind = 'task' | 'actor' | 'copilot' | 'workflow'

/** The context layers, in the order the builder always uses. */
export const LAYERS = ['platform', 'tenant', 'role', 'surface', 'unit', 'memory', 'retrieved', 'conversation', 'untrusted'] as const
export type LayerName = (typeof LAYERS)[number]

/**
 * What a unit may read or write. `working` and `known` live on the run;
 * `conversation` on the thread; `person` and `tenant` are long-term memory,
 * which reaches a prompt only after a person confirms it.
 */
export const MEMORY_SCOPES = ['working', 'known', 'conversation', 'person', 'tenant'] as const
export type MemoryScope = (typeof MEMORY_SCOPES)[number]

export interface ModelSpec {
  /** A model role, such as `extract.fast`, never a model name. The account maps roles to models. */
  use: string
  /** The role tried once when the first refuses the call or fails. */
  fallback?: string
  /** 0 to 2. */
  temperature?: number
  maxOutputTokens?: number
}

export interface PromptSpec {
  /** The template's key in the product's prompt map, such as `tasks/brief-from-site`. */
  template: string
  /** Raised with every change to the text. Every run records it. */
  version: number
  /** The languages the template has, first is the default. */
  languages: readonly string[]
}

export interface ContextRecipe {
  /**
   * The fixed layers this unit uses, from platform, tenant, role, surface and
   * unit. `unit` is required. Memory, retrieved, conversation and untrusted
   * are added from the memory scopes, the retrievers and the untrusted inputs.
   */
  layers: readonly LayerName[]
  /** The product's retrievers to run, by name. Their text is fenced as data. */
  retrievers?: readonly string[]
  /** The whole prompt's budget, estimated. */
  budgetTokens: number
  /** A tighter budget for one layer. */
  budgets?: Partial<Record<LayerName, number>>
  /** Input fields that come from outside (a person's message, a web page, a slip). Fenced as untrusted, never put in the template. */
  untrusted?: readonly string[]
  /**
   * True when the context holds live data (balances, statuses): every call
   * sends `cache_ttl: 0` so the gateway never answers from an old reply.
   */
  live?: boolean
  /** Seconds a stored reply may be served again, when not live. Left out, the gateway's own setting. */
  cacheTtl?: number
}

export interface MemorySpec {
  read: readonly MemoryScope[]
  write: readonly MemoryScope[]
}

export interface AttachmentSpec {
  /** MIME types, such as `image/jpeg` or `application/pdf`. */
  kinds: readonly string[]
  maxBytes?: number
  /** The role that reads an attachment, such as `vision.strong`. */
  vision?: string
}

export interface ToolSpec {
  /** Capabilities the unit may call. Any other is refused before the guard. */
  allow: readonly string[]
  /** The highest tier the unit may reach. A call above it is refused before the guard. */
  maxTier: Tier
}

/** Where a unit's golden set is and the share of its cases that must pass. */
export interface EvalSpec {
  /** A `.jsonl` path in the product. */
  path: string
  /** 0 to 1. Left out, the set's `$meta.threshold`, else 0.9. */
  threshold?: number
}

export interface Caps {
  /** Checked before the run and before each further model call. */
  perRunUsd: number
  /** Checked before the run against the run store's spend today (UTC) for this unit in this tenant. */
  perDayUsd: number
}

export interface UnitSpec<I = unknown, O = unknown> {
  /** Lower case words joined by `_`, such as `brief_draft_from_site`. */
  id: string
  /** Starts at 1. Raised when the prompt, model or recipe changes. */
  version: number
  /** The team that answers for it. */
  owner: string
  /** Where it appears, such as `copilot:admin` or `mcp:platform`. */
  surfaces?: readonly string[]
  model: ModelSpec
  prompt: PromptSpec
  context: ContextRecipe
  memory: MemorySpec
  attachments?: AttachmentSpec
  /** The one capability whose input the unit's output becomes (a task's save, an actor's submit). */
  target?: string
  tools?: ToolSpec
  /** Checked input. */
  input?: SchemaLike<I>
  /** The output, forced through its JSON Schema. Required for a task. */
  output?: SchemaLike<O>
  /**
   * The golden set: a `.jsonl` path in the product, or `{ path, threshold }`
   * when the unit carries its own pass mark. The testing kit reads it.
   */
  evals: string | EvalSpec
  caps: Caps
  /**
   * Product tags on every call of this unit, such as `{ feature: 'onboarding' }`.
   * At most 8 keys matching [a-z][a-z0-9_.-]*, values at most 200 bytes.
   */
  tags?: Tags
}

/** A checked manifest. */
export type Unit<I = unknown, O = unknown, X extends object = {}> = Readonly<UnitSpec<I, O>> &
  Readonly<X> & {
    readonly kind: UnitKind
    /** The output's JSON Schema, closed, when there is an output. */
    readonly outputJson: JsonSchema | undefined
  }

export type AnyUnit = Unit<any, any, any>

export class UnitError extends Error {
  constructor(
    readonly unit: string,
    readonly problems: string[],
  ) {
    super(`unit ${unit || '(unnamed)'}: ${problems.join('; ')}`)
    this.name = 'UnitError'
  }
}

export const UNIT_ID_PATTERN = /^[a-z][a-z0-9]*(_[a-z0-9]+)*$/
/** `extract.fast`, `vision.strong`, `converse`. A slash means a model name, which a manifest never holds. */
export const ROLE_PATTERN = /^[a-z][a-z0-9_]*(\.[a-z0-9_]+)*$/
const LANGUAGE = /^[a-z]{2,3}(-[A-Za-z0-9]{2,8})*$/
const MIME = /^[a-z]+\/[a-z0-9.+-]+$/
const FIXED: readonly LayerName[] = ['platform', 'tenant', 'role', 'surface', 'unit']

const positive = (n: unknown): n is number => typeof n === 'number' && Number.isFinite(n) && n > 0
const whole = (n: unknown, min: number): n is number => Number.isInteger(n) && (n as number) >= min
const strings = (a: unknown): a is readonly string[] => Array.isArray(a) && a.every((s) => typeof s === 'string' && s.trim() !== '')
const unique = (a: readonly string[]) => new Set(a).size === a.length

function roleProblem(field: string, role: unknown): string | null {
  if (typeof role !== 'string' || !role) return `${field} must name a model role`
  if (role.includes('/') || role.startsWith('role:')) return `${field} must be a role such as extract.fast, not a model name (${role})`
  if (!ROLE_PATTERN.test(role)) return `${field} must be lower case words joined by dots, such as extract.fast`
  return null
}

/** Every rule a manifest breaks, as sentences. Empty means it is sound. */
export function unitProblems(kind: UnitKind, spec: Partial<UnitSpec<unknown, unknown>>): string[] {
  const p: string[] = []
  const id = spec.id ?? ''
  if (!UNIT_ID_PATTERN.test(id) || id.length > 64) p.push('id must be lower case words joined by _, at most 64 characters')
  if (!whole(spec.version, 1)) p.push('version must be a whole number from 1')
  if (typeof spec.owner !== 'string' || !spec.owner.trim()) p.push('owner is empty')
  if (spec.surfaces !== undefined && (!strings(spec.surfaces) || !unique(spec.surfaces))) p.push('surfaces must be distinct non-empty strings')

  const m = spec.model
  if (!m) p.push('model is missing')
  else {
    const use = roleProblem('model.use', m.use)
    if (use) p.push(use)
    if (m.fallback !== undefined) {
      const fb = roleProblem('model.fallback', m.fallback)
      if (fb) p.push(fb)
      else if (m.fallback === m.use) p.push('model.fallback is the same role as model.use')
    }
    if (m.temperature !== undefined && !(typeof m.temperature === 'number' && m.temperature >= 0 && m.temperature <= 2)) p.push('model.temperature must be 0 to 2')
    if (m.maxOutputTokens !== undefined && !(whole(m.maxOutputTokens, 1) && m.maxOutputTokens <= 200_000)) p.push('model.maxOutputTokens must be a whole number from 1 to 200000')
  }

  const pr = spec.prompt
  if (!pr) p.push('prompt is missing')
  else {
    if (typeof pr.template !== 'string' || !/^[a-z0-9][a-z0-9_./-]*$/.test(pr.template)) p.push('prompt.template must be a key such as tasks/brief-from-site')
    if (!whole(pr.version, 1)) p.push('prompt.version must be a whole number from 1')
    if (!strings(pr.languages) || pr.languages.length === 0) p.push('prompt.languages must name at least one language')
    else if (!unique(pr.languages) || !pr.languages.every((l) => LANGUAGE.test(l))) p.push('prompt.languages must be distinct language codes such as en or bn')
  }

  const c = spec.context
  if (!c) p.push('context is missing')
  else {
    if (!Array.isArray(c.layers) || !c.layers.every((l) => (LAYERS as readonly string[]).includes(l))) p.push(`context.layers must be from ${LAYERS.join(', ')}`)
    else {
      if (!unique(c.layers)) p.push('context.layers repeat a layer')
      if (!c.layers.includes('unit')) p.push('context.layers must include unit')
    }
    if (!whole(c.budgetTokens, 1)) p.push('context.budgetTokens must be a whole number from 1')
    for (const [layer, b] of Object.entries(c.budgets ?? {})) {
      if (!(LAYERS as readonly string[]).includes(layer)) p.push(`context.budgets names an unknown layer ${layer}`)
      else if (!whole(b, 1) || (whole(c.budgetTokens, 1) && (b as number) > c.budgetTokens)) p.push(`context.budgets.${layer} must be a whole number from 1 to budgetTokens`)
    }
    if (c.retrievers !== undefined && (!strings(c.retrievers) || !unique(c.retrievers))) p.push('context.retrievers must be distinct names')
    if (c.untrusted !== undefined && (!strings(c.untrusted) || !unique(c.untrusted))) p.push('context.untrusted must be distinct input names')
    if (c.cacheTtl !== undefined) {
      if (c.live) p.push('context.cacheTtl cannot be set on a live context, which is never cached')
      else if (!(whole(c.cacheTtl, 0) && (c.cacheTtl === 0 || (c.cacheTtl >= 60 && c.cacheTtl <= 2_592_000)))) p.push('context.cacheTtl must be 0 or 60 to 2592000 seconds')
    }
  }

  const mem = spec.memory
  if (!mem) p.push('memory is missing (use { read: [], write: [] } for none)')
  else {
    for (const side of ['read', 'write'] as const) {
      const s = mem[side]
      if (!Array.isArray(s) || !s.every((x) => (MEMORY_SCOPES as readonly string[]).includes(x))) p.push(`memory.${side} must be from ${MEMORY_SCOPES.join(', ')}`)
      else if (!unique(s)) p.push(`memory.${side} repeats a scope`)
    }
    if (Array.isArray(mem.write) && mem.write.includes('working')) p.push('memory.write cannot name working, which the runtime owns')
  }

  const a = spec.attachments
  if (a) {
    if (!strings(a.kinds) || a.kinds.length === 0 || !a.kinds.every((k) => MIME.test(k))) p.push('attachments.kinds must be MIME types such as image/jpeg')
    if (a.maxBytes !== undefined && !whole(a.maxBytes, 1)) p.push('attachments.maxBytes must be a whole number from 1')
    if (a.vision !== undefined) {
      const v = roleProblem('attachments.vision', a.vision)
      if (v) p.push(v)
    }
  }

  if (spec.target !== undefined && !NAME_PATTERN.test(spec.target)) p.push('target must name a capability')
  const t = spec.tools
  if (t) {
    if (!Array.isArray(t.allow) || !t.allow.every((n) => typeof n === 'string' && NAME_PATTERN.test(n))) p.push('tools.allow must name capabilities')
    else if (!unique(t.allow)) p.push('tools.allow repeats a capability')
    if (!isTier(t.maxTier)) p.push(`tools.maxTier must be one of R0 to R4, is ${String(t.maxTier)}`)
  }

  const ev = spec.evals
  const evPath = typeof ev === 'string' ? ev : ev && typeof ev === 'object' ? (ev as EvalSpec).path : undefined
  if (typeof evPath !== 'string' || !/\.jsonl$/.test(evPath)) p.push('evals must be the path of a .jsonl golden set, or { path, threshold }')
  if (ev && typeof ev === 'object') {
    const t = (ev as EvalSpec).threshold
    if (t !== undefined && !(typeof t === 'number' && t >= 0 && t <= 1)) p.push('evals.threshold must be a number from 0 to 1')
    const extra = Object.keys(ev).filter((k) => k !== 'path' && k !== 'threshold')
    if (extra.length) p.push(`evals has unknown fields: ${extra.join(', ')}`)
  }

  const caps = spec.caps
  if (!caps) p.push('caps are missing')
  else {
    if (!positive(caps.perRunUsd)) p.push('caps.perRunUsd must be above 0')
    if (!positive(caps.perDayUsd)) p.push('caps.perDayUsd must be above 0')
    else if (positive(caps.perRunUsd) && caps.perDayUsd < caps.perRunUsd) p.push('caps.perDayUsd must be at least caps.perRunUsd')
  }

  p.push(...tagProblems(spec.tags))

  if (kind === 'task' && !spec.output) p.push('a task needs an output schema: its reply is forced through it')
  if (kind === 'actor' && !spec.target) p.push('an actor needs a target: the one capability it submits')
  if (kind !== 'actor' && kind !== 'task' && spec.target !== undefined) p.push(`a ${kind} has no target; it calls tools`)
  return p
}

function define<I, O, X extends object>(kind: UnitKind, spec: UnitSpec<I, O> & X): Unit<I, O, X> {
  const problems = unitProblems(kind, spec as Partial<UnitSpec<unknown, unknown>>)
  let outputJson: JsonSchema | undefined
  if (spec.output) {
    try {
      outputJson = toJsonSchema(spec.output as SchemaLike<unknown>, 'output')
      if (outputJson.type !== 'object') problems.push('output must be an object schema')
    } catch (e) {
      problems.push(`output schema: ${(e as Error).message}`)
    }
  }
  if (spec.input) {
    try {
      toJsonSchema(spec.input as SchemaLike<unknown>, 'input')
    } catch (e) {
      problems.push(`input schema: ${(e as Error).message}`)
    }
  }
  if (problems.length) throw new UnitError(spec.id, problems)
  const freeze = <T>(a: readonly T[] | undefined) => (a ? Object.freeze([...a]) : a)
  return Object.freeze({
    ...spec,
    kind,
    outputJson,
    model: Object.freeze({ ...spec.model }),
    prompt: Object.freeze({ ...spec.prompt, languages: freeze(spec.prompt.languages)! }),
    context: Object.freeze({
      ...spec.context,
      layers: freeze(spec.context.layers)!,
      retrievers: freeze(spec.context.retrievers),
      untrusted: freeze(spec.context.untrusted),
    }),
    memory: Object.freeze({ read: freeze(spec.memory.read)!, write: freeze(spec.memory.write)! }),
    caps: Object.freeze({ ...spec.caps }),
    evals: typeof spec.evals === 'string' ? spec.evals : Object.freeze({ ...spec.evals }),
    ...(spec.tools ? { tools: Object.freeze({ allow: freeze(spec.tools.allow)!, maxTier: spec.tools.maxTier }) } : {}),
    ...(spec.surfaces ? { surfaces: freeze(spec.surfaces) } : {}),
    ...(spec.tags ? { tags: Object.freeze({ ...spec.tags }) } : {}),
  }) as unknown as Unit<I, O, X>
}

/** One structured model call: the reply forced through `output`, saved through `target` when given. */
export function task<I = unknown, O = unknown>(spec: UnitSpec<I, O>): Unit<I, O> {
  return define<I, O, {}>('task', spec)
}

/**
 * An actor's manifest. The slot-machine runtime is the actors kit; this
 * checks the manifest and keeps any extra fields (slots, handoff) as given.
 */
export function actorUnit<X extends object = {}, I = unknown, O = unknown>(spec: UnitSpec<I, O> & X): Unit<I, O, X> {
  return define<I, O, X>('actor', spec)
}

/** A copilot's manifest. The runtime is the copilot kit. */
export function copilotUnit<X extends object = {}>(spec: UnitSpec & X): Unit<unknown, unknown, X> {
  return define<unknown, unknown, X>('copilot', spec)
}

/** A workflow's manifest, for the model calls its steps make. The runtime is the flows kit. */
export function workflowUnit<X extends object = {}>(spec: UnitSpec & X): Unit<unknown, unknown, X> {
  return define<unknown, unknown, X>('workflow', spec)
}

/** A unit's golden set as `{ path, threshold? }`, whichever form the manifest used. */
export function evalsOf(unit: Pick<AnyUnit, 'evals'>): EvalSpec {
  const e = unit.evals
  return typeof e === 'string' ? { path: e } : { path: e.path, ...(e.threshold !== undefined ? { threshold: e.threshold } : {}) }
}

/** The layers a run of this unit gets, in the fixed order. */
export function layersOf(unit: Pick<AnyUnit, 'context' | 'memory'>): LayerName[] {
  const on = new Set<LayerName>(unit.context.layers.filter((l) => FIXED.includes(l)))
  const reads = unit.memory.read
  if (reads.some((s) => s === 'known' || s === 'person' || s === 'tenant' || s === 'working') || unit.context.layers.includes('memory')) on.add('memory')
  if ((unit.context.retrievers?.length ?? 0) > 0 || unit.context.layers.includes('retrieved')) on.add('retrieved')
  if (reads.includes('conversation') || unit.context.layers.includes('conversation')) on.add('conversation')
  if ((unit.context.untrusted?.length ?? 0) > 0 || unit.context.layers.includes('untrusted')) on.add('untrusted')
  return LAYERS.filter((l) => on.has(l))
}

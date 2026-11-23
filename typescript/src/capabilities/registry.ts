// The registry: every capability of a product in one place, and every
// surface generated from it. MCP tool lists, model tool lists for
// /core/ai/complete and form schemas all come from here, so they cannot
// drift from each other or from the code that runs.

import type { ToolDefinition } from '../types.js'
import { type AnyCapability, type BaseCtx, type Capability, CapabilityError, removeAfter, tierFor } from './capability.js'
import { redact, redactedJson } from './redact.js'
import { type SearchHit, type SearchIndex, type SearchOptions, searchIndex } from './search.js'
import { type Issue, type JsonSchema, unknownFields, validate } from './standard.js'
import { assertParity, type Surfaces } from './parity.js'
import { annotationsOf, type McpAnnotations, type Mode, modeOf, type Tier, tierRank } from './tiers.js'
import { type CatalogSnapshot, snapshotOf } from './versioning.js'

/** An MCP tool as `tools/list` returns it (2025-06-18 and later). */
export interface McpToolDefinition {
  name: string
  title: string
  description: string
  inputSchema: JsonSchema
  outputSchema?: JsonSchema
  annotations: McpAnnotations
}

export type ParseResult<I = unknown> =
  | {
      ok: true
      capability: AnyCapability
      input: I
      tier: Tier
      mode: Mode
      /** Paths of arguments dropped because the schema does not name them, on a capability with `unknownFields: 'strip'`. */
      stripped?: string[]
    }
  | { ok: false; reason: 'unknown_tool'; issues: Issue[] }
  | { ok: false; reason: 'invalid'; capability: AnyCapability; issues: Issue[] }

export interface DescribeOptions {
  /** Appends "Also called: ..." with the synonyms. Off by default. */
  synonyms?: boolean
}

export interface ToolListOptions<A extends string = string> extends DescribeOptions {
  /** Only capabilities this door may see. */
  audience?: A
  /** Only these names, in registry order. */
  names?: readonly string[]
  /** Only capabilities whose declared tier is at or below this one, such as R1 for a read-only copilot or R2 for a personal key. */
  maxTier?: Tier
}

export interface Registry<C extends BaseCtx = BaseCtx, P = unknown, A extends string = string> {
  readonly size: number
  /** Every capability, or those a door may see, in definition order. */
  list(audience?: A): Capability<any, any, C, P, A>[]
  get(name: string): Capability<any, any, C, P, A> | undefined
  has(name: string): boolean
  /** Derived from the tier, never stored. An unknown name is a write. */
  mode(name: string): Mode
  /** The tier of one call, taking `riskFor` into account. An unknown name is R4. */
  tier(name: string, input?: unknown): Tier
  /** MCP annotations from the declared tier. An unknown name gets the most cautious hints. */
  annotations(name: string): McpAnnotations
  /** Validates arguments against the input schema and returns the parsed input with the call's tier. */
  parse(name: string, args: unknown): Promise<ParseResult>
  /** The description a model or client reads, with a deprecation note when there is one. */
  describe(name: string, opts?: DescribeOptions): string
  /** `tools/list` for one door: inputSchema, outputSchema and annotations from the tier. */
  mcpTools(audience: A, opts?: Omit<ToolListOptions<A>, 'audience'>): McpToolDefinition[]
  /** Tool definitions for `ai.complete` (`/core/ai/complete`). */
  modelTools(opts?: ToolListOptions<A>): ToolDefinition[]
  /** The capabilities a tool list would hold, for callers that build their own shape. */
  select(opts?: ToolListOptions<A>): Capability<any, any, C, P, A>[]
  /** The input JSON Schema with title and description, for a form. */
  formSchema(name: string): JsonSchema
  /** A copy of `value` with the capability's personal fields replaced. An unknown name redacts nothing. */
  redact<T>(name: string, value: T): T
  /** Redacted JSON capped at `maxBytes` (4096) for a request log. */
  logArgs(name: string, value: unknown, maxBytes?: number): string
  /** BM25 over name, title, description and synonyms. */
  search(query: string, opts?: SearchOptions<A>): SearchHit[]
  /** The catalog as data, for the additive-only check and the tools changelog. */
  snapshot(): CatalogSnapshot
  /**
   * Throws `ParityError` when an entry is unsound or a surface names a tool
   * the registry lacks (or one its door may not see). Each surface is a list
   * of names, or `{ audience, tools }` to check the door too.
   */
  parity(surfaces?: Surfaces<A>, opts?: { audiences?: readonly A[] }): void
}

/** A copy of `value` without the fields at these dotted paths. */
function withoutPaths(value: unknown, paths: readonly string[]): unknown {
  const copy = structuredClone(value)
  for (const path of paths) {
    const parts = path.split('.')
    let node: unknown = copy
    for (const part of parts.slice(0, -1)) node = node && typeof node === 'object' ? (node as Record<string, unknown>)[part] : undefined
    if (node && typeof node === 'object') delete (node as Record<string, unknown>)[parts[parts.length - 1]!]
  }
  return copy
}

/** Builds a registry. Throws `CapabilityError` on a repeated name. */
export function createRegistry<C extends BaseCtx = BaseCtx, P = unknown, A extends string = string>(
  capabilities: readonly Capability<any, any, C, P, A>[],
): Registry<C, P, A> {
  const byName = new Map<string, Capability<any, any, C, P, A>>()
  for (const c of capabilities) {
    if (!c || c.kind !== 'capability') throw new CapabilityError(String((c as { name?: string })?.name ?? ''), ['not made with capability()'])
    if (byName.has(c.name)) throw new CapabilityError(c.name, ['name is used twice'])
    byName.set(c.name, c)
  }
  const all = [...byName.values()]
  let index: SearchIndex | undefined

  const describe = (name: string, opts: DescribeOptions = {}): string => {
    const c = byName.get(name)
    if (!c) return ''
    let d = c.description
    if (c.deprecated) {
      const use = c.deprecated.use ? ` Use ${c.deprecated.use} instead.` : ''
      d = `Deprecated, removed after ${removeAfter(c.deprecated)}.${use} ${d}`
    }
    if (opts.synonyms && c.synonyms?.length) d += ` Also called: ${c.synonyms.join(', ')}.`
    return d
  }

  const reg: Registry<C, P, A> = {
    size: all.length,
    list: (audience) => (audience === undefined ? [...all] : all.filter((c) => c.audiences.includes(audience))),
    get: (name) => byName.get(name),
    has: (name) => byName.has(name),
    mode: (name) => modeOf(byName.get(name)?.risk),
    tier: (name, input) => {
      const c = byName.get(name)
      if (!c) return 'R4'
      return input === undefined ? c.risk : tierFor(c, input)
    },
    annotations: (name) => {
      const c = byName.get(name)
      return annotationsOf(c?.risk, { title: c?.title, openWorld: c?.openWorld })
    },
    async parse(name, args) {
      const c = byName.get(name)
      if (!c) return { ok: false, reason: 'unknown_tool', issues: [{ message: `unknown tool: ${name}`, path: '' }] }
      let raw: unknown = args ?? {}
      // The closed JSON Schema is the contract, whatever the library does with extra fields.
      let extra = unknownFields(c.inputJson, raw)
      let stripped: string[] | undefined
      if (extra.length && c.unknownFields === 'strip') {
        stripped = extra.map((e) => e.path)
        raw = withoutPaths(raw, stripped)
        extra = unknownFields(c.inputJson, raw)
      }
      const r = await validate(c.input, raw)
      if (!r.ok || extra.length) {
        const issues = [...extra, ...(r.ok ? [] : r.issues.filter((i) => !extra.some((e) => e.path === i.path)))]
        return { ok: false, reason: 'invalid', capability: c, issues }
      }
      const tier = tierFor(c, r.value)
      return { ok: true, capability: c, input: r.value, tier, mode: modeOf(tier), ...(stripped ? { stripped } : {}) }
    },
    describe,
    select(opts = {}) {
      const wanted = opts.names ? new Set(opts.names) : undefined
      const max = opts.maxTier === undefined ? 4 : tierRank(opts.maxTier)
      return reg.list(opts.audience).filter((c) => (!wanted || wanted.has(c.name)) && tierRank(c.risk) <= max)
    },
    mcpTools: (audience, opts = {}) =>
      reg.select({ ...opts, audience }).map((c) => ({
        name: c.name,
        title: c.title,
        description: describe(c.name, opts),
        inputSchema: c.inputJson,
        ...(c.outputJson ? { outputSchema: c.outputJson } : {}),
        annotations: reg.annotations(c.name),
      })),
    modelTools: (opts = {}) => reg.select(opts).map((c) => ({ name: c.name, description: describe(c.name, opts), input_schema: c.inputJson })),
    formSchema(name) {
      const c = byName.get(name)
      if (!c) throw new CapabilityError(name, ['unknown capability'])
      return { ...c.inputJson, title: c.title, description: c.description }
    },
    redact: (name, value) => redact(value, byName.get(name)?.pii ?? []),
    logArgs: (name, value, maxBytes) => redactedJson(value, byName.get(name)?.pii ?? [], maxBytes),
    search(query, opts) {
      index ??= searchIndex(all)
      return index.search(query, opts as SearchOptions<string>)
    },
    snapshot: () => snapshotOf(all),
    parity(surfaces = {}, opts = {}) {
      assertParity(all, { surfaces, ...(opts.audiences ? { audiences: opts.audiences } : {}) })
    },
  }
  return reg
}

/** The name RFC 2292 uses: `registry([...])` is `createRegistry([...])`. */
export const registry = createRegistry

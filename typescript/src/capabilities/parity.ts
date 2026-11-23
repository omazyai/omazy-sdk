// The parity check a product runs in CI: every capability is sound, every
// name is used once, and no surface (an MCP door, a copilot's core set, an
// AI unit's tool list, a console route table) names a tool the registry
// lacks or one its door may not see.

import { type AnyCapability, definitionProblems } from './capability.js'
import type { Registry } from './registry.js'

/**
 * The surfaces to check, by name (such as `mcp /org` or `copilot core set`):
 * a list of tool names, or `{ audience, tools }` to check the door too. The
 * same shape `registry.parity` takes.
 */
export type Surfaces<A extends string = string> = Record<string, readonly string[] | { audience?: A; tools: readonly string[] }>

/** One surface in the array form. Deprecated with that form: name the surfaces in a `Surfaces` record. */
export interface Surface {
  /** For the report, such as `mcp /org` or `copilot core set`. */
  name: string
  /** When set, every tool must be visible to this door. */
  audience?: string
  tools: readonly string[]
}

export interface ParityOptions {
  /**
   * A `Surfaces` record, as `registry.parity` takes. The array form
   * (`[{ name, audience?, tools }]`) still works and is deprecated: it goes
   * before the first release.
   */
  surfaces?: Surfaces | readonly Surface[]
  /** The doors the product has. When set, a capability on any other door is a problem. */
  audiences?: readonly string[]
}

export interface ParityProblem {
  capability?: string
  surface?: string
  problem: string
}

const capsOf = (x: Registry<any, any, any> | readonly AnyCapability[]): readonly AnyCapability[] =>
  Array.isArray(x) ? (x as readonly AnyCapability[]) : (x as Registry<any, any, any>).list()

/** The surfaces as a list, from either form. */
function surfaceList(surfaces: Surfaces | readonly Surface[] = {}): Surface[] {
  if (Array.isArray(surfaces)) return [...(surfaces as readonly Surface[])]
  return Object.entries(surfaces as Surfaces).map(([name, s]) =>
    Array.isArray(s) ? { name, tools: s as readonly string[] } : { name, ...(s as { audience?: string; tools: readonly string[] }) },
  )
}

/** Every problem found, empty when the catalog and its surfaces agree. */
export function parityProblems(catalog: Registry<any, any, any> | readonly AnyCapability[], opts: ParityOptions = {}): ParityProblem[] {
  const caps = capsOf(catalog)
  const out: ParityProblem[] = []
  const byName = new Map<string, AnyCapability>()
  for (const c of caps) {
    for (const problem of definitionProblems(c)) out.push({ capability: c.name, problem })
    if (byName.has(c.name)) out.push({ capability: c.name, problem: 'name is used twice' })
    byName.set(c.name, c)
    if (opts.audiences) for (const a of c.audiences) if (!opts.audiences.includes(a)) out.push({ capability: c.name, problem: `unknown door ${a}` })
    if (c.deprecated?.use && !caps.some((x) => x.name === c.deprecated!.use))
      out.push({ capability: c.name, problem: `deprecated in favour of ${c.deprecated.use}, which is not in the registry` })
  }
  for (const s of surfaceList(opts.surfaces)) {
    const seen = new Set<string>()
    for (const t of s.tools) {
      if (seen.has(t)) out.push({ surface: s.name, capability: t, problem: 'listed twice' })
      seen.add(t)
      const c = byName.get(t)
      if (!c) out.push({ surface: s.name, capability: t, problem: 'not in the registry' })
      else if (s.audience !== undefined && !c.audiences.includes(s.audience)) out.push({ surface: s.name, capability: t, problem: `not visible to door ${s.audience}` })
    }
  }
  return out
}

export class ParityError extends Error {
  constructor(readonly problems: ParityProblem[]) {
    super(
      `capability parity failed:\n${problems
        .map((p) => `  ${[p.surface, p.capability].filter(Boolean).join(' / ') || '(catalog)'}: ${p.problem}`)
        .join('\n')}`,
    )
    this.name = 'ParityError'
  }
}

/** Throws `ParityError` listing every problem. For a test: `assertParity(registry, { surfaces })`. */
export function assertParity(catalog: Registry<any, any, any> | readonly AnyCapability[], opts?: ParityOptions): void {
  const problems = parityProblems(catalog, opts)
  if (problems.length) throw new ParityError(problems)
}

// Checks for a product's CI. `checkUnits` loads every manifest against the
// registry and the prompt map; `findDirectModelCalls` fails any model call
// made outside a unit, the rule that keeps every call tagged, capped and
// recorded.

import type { Registry } from '../capabilities/registry.js'
import { tierRank } from '../capabilities/tiers.js'
import type { AnyUnit } from './manifest.js'
import type { Prompts } from './prompts.js'

export interface UnitCheckOptions {
  registry?: Registry<any, any, any>
  prompts?: Prompts
  /** Retriever names createAi is given. */
  retrievers?: readonly string[]
}

export interface UnitProblem {
  unit: string
  problem: string
}

/** Every problem across the units: repeated ids, tools the registry lacks or holds above the unit's tier, missing prompts and retrievers. */
export function checkUnits(units: readonly AnyUnit[], opts: UnitCheckOptions = {}): UnitProblem[] {
  const out: UnitProblem[] = []
  const seen = new Set<string>()
  for (const u of units) {
    const add = (problem: string) => out.push({ unit: u.id, problem })
    if (seen.has(u.id)) add('the id is used by another unit')
    seen.add(u.id)
    const reg = opts.registry
    if (reg) {
      for (const name of u.tools?.allow ?? []) {
        const cap = reg.get(name)
        if (!cap) add(`tool ${name} is not in the registry`)
        else if (tierRank(cap.risk) > tierRank(u.tools!.maxTier)) add(`tool ${name} is ${cap.risk}, above the unit's maxTier ${u.tools!.maxTier}`)
      }
      if (u.target && !reg.has(u.target)) add(`target ${u.target} is not in the registry`)
    }
    if (opts.prompts) for (const p of opts.prompts.problems(u.prompt)) add(p)
    if (opts.retrievers) for (const r of u.context.retrievers ?? []) if (!opts.retrievers.includes(r)) add(`retriever ${r} is not given to createAi`)
  }
  return out
}

/** Throws with every problem `checkUnits` finds. */
export function assertUnits(units: readonly AnyUnit[], opts: UnitCheckOptions = {}): void {
  const p = checkUnits(units, opts)
  if (p.length) throw new Error(`units:\n${p.map((x) => `- ${x.unit}: ${x.problem}`).join('\n')}`)
}

export interface DirectCall {
  file: string
  line: number
  text: string
}

/** `.ai.complete(`, `.ai.stream(` and `/core/ai/complete`, the ways a model is reached without a unit. */
export const DIRECT_MODEL_CALL = /\.ai\s*\.\s*(complete|stream)\s*\(|\/core\/ai\/complete\b|\/ai\/complete\b/

/**
 * The lines in a product's source that call a model without a unit. Give it
 * the files to scan (path to text); paths in `allow` (the AI kit's own
 * adapters, tests) are skipped. Fail CI when it returns anything.
 */
export function findDirectModelCalls(files: Readonly<Record<string, string>>, opts: { allow?: readonly (string | RegExp)[] } = {}): DirectCall[] {
  const allowed = (f: string) => (opts.allow ?? []).some((a) => (typeof a === 'string' ? f.startsWith(a) : a.test(f)))
  const out: DirectCall[] = []
  for (const [file, text] of Object.entries(files)) {
    if (allowed(file)) continue
    text.split('\n').forEach((l, i) => {
      if (DIRECT_MODEL_CALL.test(l) && !/^\s*(\/\/|\*)/.test(l)) out.push({ file, line: i + 1, text: l.trim() })
    })
  }
  return out
}

// Tool picking: real requests, in the languages people write them, against the
// registry. Builder's Lab's method: the right tool must be in the top k (5)
// for at least 95% of requests. By default the picker is the registry's own
// BM25 search, the one a copilot's search tool uses; `modelPicker` asks a
// model with the registry's model tools instead.

import type { Ai } from '../ai/ai.js'
import type { AnyUnit } from '../ai/manifest.js'
import type { BaseCtx } from '../capabilities/capability.js'
import type { Registry } from '../capabilities/registry.js'
import type { Tier } from '../capabilities/tiers.js'
import type { GoldenSet } from './golden.js'

/**
 * One request. A JSONL line:
 * `{ "request": "নভেম্বরের বকেয়া ইনভয়েস দেখাও", "language": "bn", "expected": "invoices_open" }`.
 * `expected` may list several names when any of them is right.
 */
export interface ToolPickingCase {
  id?: string
  request: string
  /** Such as `en` or `bn`. The report breaks results down by it. Default `und`. */
  language?: string
  expected: string | readonly string[]
  /** The door the request comes through, over the option's. */
  audience?: string
}

/** Ranked tool names for one request, best first. */
export type Picker = (c: ToolPickingCase) => readonly string[] | Promise<readonly string[]>

export interface ToolPickingOptions {
  registry: Registry<any, any, any>
  cases: readonly ToolPickingCase[] | GoldenSet
  /** Default 5. */
  k?: number
  /** Default 0.95. */
  threshold?: number
  /** The door every case searches, unless the case names one. */
  audience?: string
  /** Default the registry's `search`. */
  pick?: Picker
}

export interface ToolPickingMiss {
  id: string
  request: string
  language: string
  expected: readonly string[]
  got: readonly string[]
}

export interface ToolPickingReport {
  k: number
  threshold: number
  total: number
  /** Share with a right tool first. */
  top1: number
  /** Share with a right tool in the top k. The pass mark applies to this. */
  topK: number
  pass: boolean
  byLanguage: Record<string, { total: number; top1: number; topK: number }>
  misses: ToolPickingMiss[]
}

function casesOf(cases: ToolPickingOptions['cases']): ToolPickingCase[] {
  const raw = Array.isArray(cases) ? cases : (cases as GoldenSet).cases.map((c) => c as unknown as ToolPickingCase)
  return raw.map((c, i) => {
    const where = c.id ?? `#${i + 1}`
    if (typeof c.request !== 'string' || !c.request.trim()) throw new Error(`tool picking case ${where}: request must be text`)
    const exp: readonly unknown[] = Array.isArray(c.expected) ? c.expected : [c.expected]
    if (!exp.length || !exp.every((e) => typeof e === 'string' && e)) throw new Error(`tool picking case ${where}: expected must name a tool`)
    return { ...c, id: where }
  })
}

const share = (n: number, d: number) => (d ? Math.round((n / d) * 10_000) / 10_000 : 0)

/**
 * Runs the fixture. Every expected name must be in the registry, so a renamed
 * tool fails the fixture instead of scoring as a miss.
 */
export async function toolPicking(o: ToolPickingOptions): Promise<ToolPickingReport> {
  const k = o.k ?? 5
  const threshold = o.threshold ?? 0.95
  const cases = casesOf(o.cases)
  const unknown = [...new Set(cases.flatMap((c) => (Array.isArray(c.expected) ? c.expected : [c.expected])).filter((n) => !o.registry.get(n)))]
  if (unknown.length) throw new Error(`the tool picking fixture expects tools the registry lacks: ${unknown.join(', ')}`)
  const pick: Picker = o.pick ?? ((c) => o.registry.search(c.request, { audience: c.audience ?? o.audience, limit: k }).map((h) => h.name))
  const by: ToolPickingReport['byLanguage'] = {}
  const misses: ToolPickingMiss[] = []
  let top1 = 0
  let topK = 0
  for (const c of cases) {
    const expected = Array.isArray(c.expected) ? c.expected : [c.expected as string]
    const got = (await pick(c)).slice(0, k)
    const lang = c.language ?? 'und'
    const row = (by[lang] ??= { total: 0, top1: 0, topK: 0 })
    row.total++
    const first = got[0] !== undefined && expected.includes(got[0])
    const inK = got.some((g) => expected.includes(g))
    if (first) {
      top1++
      row.top1++
    }
    if (inK) {
      topK++
      row.topK++
    } else misses.push({ id: c.id!, request: c.request, language: lang, expected, got })
  }
  for (const row of Object.values(by)) {
    row.top1 = share(row.top1, row.total)
    row.topK = share(row.topK, row.total)
  }
  const rate = share(topK, cases.length)
  return { k, threshold, total: cases.length, top1: share(top1, cases.length), topK: rate, pass: cases.length > 0 && rate >= threshold, byLanguage: by, misses }
}

/** The verdict, each language and the first misses, for CI. */
export function formatToolPicking(r: ToolPickingReport, o: { maxMisses?: number } = {}): string {
  const p = (n: number) => `${(n * 100).toFixed(1)}%`
  const lines = [`${r.pass ? 'PASS' : 'FAIL'} tool picking: top-${r.k} ${p(r.topK)}, top-1 ${p(r.top1)} of ${r.total}, threshold ${p(r.threshold)}`]
  for (const [lang, row] of Object.entries(r.byLanguage)) lines.push(`  ${lang}: top-${r.k} ${p(row.topK)}, top-1 ${p(row.top1)} of ${row.total}`)
  const max = o.maxMisses ?? 10
  for (const m of r.misses.slice(0, max)) lines.push(`  x ${m.id} [${m.language}] "${m.request}": expected ${m.expected.join(' or ')}, got ${m.got.join(', ') || 'nothing'}`)
  if (r.misses.length > max) lines.push(`  ... and ${r.misses.length - max} more`)
  return lines.join('\n')
}

export const PICK_PROMPT = 'Call the one tool that best serves the request. Do not answer in text.'

/**
 * A picker that asks a model, through the AI kit: one run of `unit` per
 * request, with the registry's model tools for the door (at or below
 * `maxTier`) and a forced tool call. The ranked list is the tools the model
 * called, in order. The unit should allow nothing to run; this only reads
 * which tool it chose.
 */
export function modelPicker<C extends BaseCtx>(o: {
  ai: Ai<C>
  ctx: C
  unit: AnyUnit
  registry: Registry<C, any, any>
  audience?: string
  maxTier?: Tier
  system?: string
}): Picker {
  return async (c) => {
    const scope = await o.ai.start(o.ctx, o.unit, { tags: { eval: 'tool_picking' } })
    try {
      const res = await scope.complete({
        system: o.system ?? PICK_PROMPT,
        messages: [{ role: 'user', content: c.request }],
        tools: o.registry.modelTools({ audience: c.audience ?? o.audience, ...(o.maxTier ? { maxTier: o.maxTier } : {}) }),
        tool_choice: 'any',
      })
      await scope.finish('ok')
      return (res.tool_calls ?? []).map((t) => t.name)
    } catch (e) {
      await scope.finish('error', { message: (e as Error)?.message })
      throw e
    }
  }
}

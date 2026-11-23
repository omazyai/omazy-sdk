// The golden-set runner. A unit's `evals` path names a JSONL file, one case a
// line: `{ "input": ..., "expected": ... }`. The runner runs the unit on each
// case (against the fake Core API, or the live one behind a flag), scores it,
// and passes only at or above the threshold. The report is JSON for the
// product's records and a few lines of text for CI.

import { type AnyUnit, evalsOf } from '../ai/manifest.js'
import type { CoreLike } from '../ai/ai.js'
import { Omazy } from '../index.js'
import type { FakeAnswer, FakeCore } from './fake-core.js'
import type { EvalCase, Scorer, ScoreResult } from './scorers.js'

/** A parsed golden set: its cases and the settings line, when it has one. */
export interface GoldenSet {
  cases: EvalCase[]
  /** From a line `{ "$meta": { "threshold": 0.95 } }`. */
  meta: { threshold?: number; [k: string]: unknown }
  source?: string
}

export class GoldenSetError extends Error {
  override readonly name = 'GoldenSetError'
}

/**
 * Parses JSONL. Blank lines and lines starting with `//` are skipped. Each
 * other line is an object with `input`; a line holding only `$meta` sets the
 * threshold and other settings. A bad line throws with its number.
 */
export function parseJsonl(text: string, source = 'golden set'): GoldenSet {
  const cases: EvalCase[] = []
  let meta: GoldenSet['meta'] = {}
  const lines = text.split(/\r?\n/)
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!.trim()
    if (!line || line.startsWith('//')) continue
    let v: unknown
    try {
      v = JSON.parse(line)
    } catch (e) {
      throw new GoldenSetError(`${source} line ${i + 1}: not JSON (${(e as Error).message})`)
    }
    if (!v || typeof v !== 'object' || Array.isArray(v)) throw new GoldenSetError(`${source} line ${i + 1}: a case must be an object`)
    const o = v as Record<string, unknown>
    if ('$meta' in o) {
      meta = { ...meta, ...(o.$meta as object) }
      continue
    }
    if (!('input' in o)) throw new GoldenSetError(`${source} line ${i + 1}: a case needs an input`)
    cases.push({ ...o, id: typeof o.id === 'string' ? o.id : `#${i + 1}` } as EvalCase)
  }
  if (meta.threshold !== undefined && !(typeof meta.threshold === 'number' && meta.threshold >= 0 && meta.threshold <= 1)) {
    throw new GoldenSetError(`${source}: $meta.threshold must be a number from 0 to 1`)
  }
  return { cases, meta, source }
}

export interface LoadOptions {
  /** The folder the unit's `evals` path is under. Default the working directory. */
  root?: string
  /** Reads a file. Default `node:fs/promises`, so loading needs Node, Bun or Deno; the rest of the kit does not. */
  read?: (path: string) => Promise<string>
}

/** Reads and parses a golden set: a unit's `evals` file, or a path. */
export async function loadGoldenSet(from: AnyUnit | string, o: LoadOptions = {}): Promise<GoldenSet> {
  const rel = typeof from === 'string' ? from : evalsOf(from).path
  const root = o.root ?? (globalThis as { process?: { cwd(): string } }).process?.cwd() ?? '.'
  const path = rel.startsWith('/') ? rel : `${root.replace(/\/$/, '')}/${rel}`
  const read =
    o.read ??
    (async (p: string) => {
      const fs = (await import('node:fs/promises' as string)) as { readFile(p: string, enc: 'utf8'): Promise<string> }
      return fs.readFile(p, 'utf8')
    })
  return parseJsonl(await read(path), rel)
}

/** True when `OMAZY_EVAL_LIVE=1`: run against the live Core API, not the fake. */
export function liveFromEnv(): boolean {
  return (globalThis as { process?: { env?: Record<string, string | undefined> } }).process?.env?.OMAZY_EVAL_LIVE === '1'
}

/**
 * The Core client an eval should use: the fake, or with `live` a real client
 * on `OMAZY_TOKEN` and `OMAZY_BASE_URL` (or the ones given).
 */
export function evalCore(o: { fake: FakeCore; live?: boolean; token?: string; baseUrl?: string }): CoreLike {
  if (!(o.live ?? liveFromEnv())) return o.fake.client
  const env = (globalThis as { process?: { env?: Record<string, string | undefined> } }).process?.env ?? {}
  const token = o.token ?? env.OMAZY_TOKEN
  if (!token) throw new Error('a live eval needs OMAZY_TOKEN')
  const baseUrl = o.baseUrl ?? env.OMAZY_BASE_URL
  return new Omazy({ token, ...(baseUrl ? { baseUrl } : {}) })
}

// ---------------------------------------------------------------- the runner

export interface EvalOptions {
  cases: readonly EvalCase[] | GoldenSet
  /**
   * Runs the unit on one case and gives its output. A `RunResult` from
   * `ai.run` is read for you: `ok` gives its output and usage, anything else
   * fails the case with the refusal.
   */
  run: (c: EvalCase, i: number) => unknown | Promise<unknown>
  scorers: readonly Scorer[]
  /**
   * The share of cases that must pass, 0 to 1. Left out: the unit manifest's
   * `evals.threshold`, then the set's `$meta.threshold`, then 0.9.
   */
  threshold?: number
  /** Each case's `fake` replies are queued on it before the case runs, unless live. */
  fake?: FakeCore
  /** Run against the live API: the cases' `fake` replies are not used. Default `liveFromEnv()`. */
  live?: boolean
  /** Cases run at once. Default 1, and always 1 with a fake, whose script is shared. */
  concurrency?: number
  /** A set smaller than this gets a warning in the report. Default 30, as RFC-0901 asks per unit. */
  minCases?: number
}

export interface CaseScore {
  name: string
  score: number
  pass: boolean
  detail?: string
}

export interface CaseReport {
  id: string
  pass: boolean
  scores: CaseScore[]
  output?: unknown
  expected?: unknown
  error?: string
}

export interface EvalReport {
  unit: { id: string; kind: string; version: number; promptVersion: number; evals: string } | null
  live: boolean
  threshold: number
  total: number
  passed: number
  /** Cases whose run threw or was refused. They count as failed. */
  errors: number
  passRate: number
  /** True at or above the threshold, with at least one case. */
  pass: boolean
  scorers: Record<string, { mean: number; passed: number }>
  cases: CaseReport[]
  usage: { calls: number; costMicros: number }
  warnings: string[]
  ms: number
}

type RunLike = { outcome: string; runId: string; usage?: { calls?: number; costMicros?: number }; output?: unknown; message?: string; issues?: { message: string; path: string }[] }
const isRunResult = (v: unknown): v is RunLike =>
  !!v && typeof v === 'object' && typeof (v as RunLike).outcome === 'string' && typeof (v as RunLike).runId === 'string' && 'usage' in (v as object)

const norm = (r: number | ScoreResult): ScoreResult => (typeof r === 'number' ? { score: r } : r)
const clamp = (n: number) => (Number.isFinite(n) ? Math.min(1, Math.max(0, n)) : 0)

/**
 * Runs a golden set. `unit` names what is being judged in the report; give
 * `null` for a set that is not one unit's.
 *
 *     const set = await loadGoldenSet(briefFromSite)
 *     const report = await evalUnit(briefFromSite, {
 *       cases: set,
 *       fake,
 *       run: (c) => ai.run(ctx, briefFromSite, c.input, { save: false }),
 *       scorers: [schemaValid(), jsonFields({ fields: ['title'] })],
 *     })
 *     console.log(formatReport(report))
 */
export async function evalUnit(unit: AnyUnit | null, o: EvalOptions): Promise<EvalReport> {
  const started = Date.now()
  const set: GoldenSet = Array.isArray(o.cases) ? { cases: [...(o.cases as EvalCase[])], meta: {} } : (o.cases as GoldenSet)
  const live = o.live ?? liveFromEnv()
  const threshold = o.threshold ?? (unit ? evalsOf(unit).threshold : undefined) ?? set.meta.threshold ?? 0.9
  if (!(threshold >= 0 && threshold <= 1)) throw new Error('threshold must be from 0 to 1')
  if (!o.scorers.length) throw new Error('evalUnit needs at least one scorer')
  const warnings: string[] = []
  const minCases = o.minCases ?? 30
  if (set.cases.length < minCases) warnings.push(`${set.cases.length} cases; a unit's golden set should hold at least ${minCases}`)
  if (live && o.fake) warnings.push('live run: the cases\' fake replies were not used')
  const usage = { calls: 0, costMicros: 0 }

  const one = async (c: EvalCase, i: number): Promise<CaseReport> => {
    const id = c.id ?? `#${i + 1}`
    if (o.fake && !live && c.fake !== undefined) {
      o.fake.clear()
      o.fake.push(...((Array.isArray(c.fake) ? c.fake : [c.fake]) as FakeAnswer[]))
    }
    let output: unknown
    try {
      const got = await o.run(c, i)
      if (isRunResult(got)) {
        usage.calls += got.usage?.calls ?? 0
        usage.costMicros += got.usage?.costMicros ?? 0
        if (got.outcome !== 'ok') {
          const why = got.message ?? got.issues?.map((x) => `${x.path || '(root)'} ${x.message}`).join('; ') ?? ''
          return { id, pass: false, scores: [], expected: c.expected, error: `${got.outcome}${why ? `: ${why}` : ''}` }
        }
        output = got.output
      } else output = got
    } catch (e) {
      return { id, pass: false, scores: [], expected: c.expected, error: (e as Error)?.message ?? String(e) }
    }
    const scores: CaseScore[] = []
    for (const s of o.scorers) {
      try {
        const r = norm(await s.score({ input: c.input, output, expected: c.expected, case: c, ...(unit ? { unit } : {}) }))
        const score = clamp(r.score)
        scores.push({ name: s.name, score, pass: score >= s.passAt, ...(r.detail ? { detail: r.detail } : {}) })
      } catch (e) {
        scores.push({ name: s.name, score: 0, pass: false, detail: `the scorer failed: ${(e as Error)?.message ?? String(e)}` })
      }
    }
    return { id, pass: scores.every((s) => s.pass), scores, output, expected: c.expected }
  }

  const reports: CaseReport[] = new Array(set.cases.length)
  const width = o.fake && !live ? 1 : Math.max(1, o.concurrency ?? 1)
  let next = 0
  await Promise.all(
    Array.from({ length: Math.min(width, set.cases.length) }, async () => {
      while (next < set.cases.length) {
        const i = next++
        reports[i] = await one(set.cases[i]!, i)
      }
    }),
  )

  const passed = reports.filter((r) => r.pass).length
  const scorers: EvalReport['scorers'] = {}
  for (const s of o.scorers) {
    const rows = reports.flatMap((r) => r.scores.filter((x) => x.name === s.name))
    // A case that errored scores 0 on every scorer.
    const n = reports.length
    const sum = rows.reduce((a, x) => a + x.score, 0)
    scorers[s.name] = { mean: n ? Math.round((sum / n) * 10_000) / 10_000 : 0, passed: rows.filter((x) => x.pass).length }
  }
  const total = reports.length
  const passRate = total ? passed / total : 0
  return {
    unit: unit ? { id: unit.id, kind: unit.kind, version: unit.version, promptVersion: unit.prompt.version, evals: evalsOf(unit).path } : null,
    live,
    threshold,
    total,
    passed,
    errors: reports.filter((r) => r.error !== undefined).length,
    passRate: Math.round(passRate * 10_000) / 10_000,
    pass: total > 0 && passRate >= threshold,
    scorers,
    cases: reports,
    usage,
    warnings,
    ms: Date.now() - started,
  }
}

const pct = (n: number) => `${(Math.round(n * 1000) / 10).toFixed(1)}%`

/** A few lines for CI: the verdict, each scorer's mean, the first failures. */
export function formatReport(r: EvalReport, o: { maxFailures?: number } = {}): string {
  const name = r.unit ? `${r.unit.id} v${r.unit.version} (prompt ${r.unit.promptVersion})` : 'golden set'
  const lines = [
    `${r.pass ? 'PASS' : 'FAIL'} ${name}: ${r.passed}/${r.total} passed (${pct(r.passRate)}), threshold ${pct(r.threshold)}${r.live ? ', live' : ''}`,
    `  scorers: ${Object.entries(r.scorers)
      .map(([k, v]) => `${k} ${v.mean.toFixed(3)}`)
      .join(', ')}`,
  ]
  if (r.usage.calls) lines.push(`  usage: ${r.usage.calls} calls, $${(r.usage.costMicros / 1_000_000).toFixed(4)}`)
  for (const w of r.warnings) lines.push(`  warning: ${w}`)
  const failed = r.cases.filter((c) => !c.pass)
  const max = o.maxFailures ?? 10
  for (const c of failed.slice(0, max)) {
    const why = c.error ?? c.scores
      .filter((s) => !s.pass)
      .map((s) => `${s.name} ${s.score.toFixed(2)}${s.detail ? ` (${s.detail})` : ''}`)
      .join('; ')
    lines.push(`  x ${c.id}: ${why}`)
  }
  if (failed.length > max) lines.push(`  ... and ${failed.length - max} more`)
  return lines.join('\n')
}

export class EvalFailure extends Error {
  override readonly name = 'EvalFailure'
  constructor(readonly report: EvalReport) {
    super(formatReport(report))
  }
}

/** Throws `EvalFailure`, with the summary as its message, when the report did not pass. */
export function assertEval(r: EvalReport): EvalReport {
  if (!r.pass) throw new EvalFailure(r)
  return r
}

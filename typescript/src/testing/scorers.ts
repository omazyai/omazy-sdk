// Scorers. Each takes one case's input, output and expected value and gives a
// score from 0 to 1. A case passes when every scorer reaches its `passAt`.
// The deterministic ones need no model; `judge` and the autoevals wrappers
// live in judge.ts.

import type { ActorReply, ActorRuntime, ReplyInput, StartInput } from '../actors/index.js'
import type { AnyUnit } from '../ai/manifest.js'
import type { BaseCtx } from '../capabilities/capability.js'
import { type SchemaLike, validate } from '../capabilities/standard.js'
import { canonicalJson } from '../guard/crypto.js'

/** One line of a golden set. Fields beyond these are the product's own and reach every scorer. */
export interface EvalCase {
  /** Shown in the report. Default `#<line>`. */
  id?: string
  input: unknown
  expected?: unknown
  /** What the fake Core answers for this case, in order, when the set runs without the live API. */
  fake?: unknown
  tags?: readonly string[]
  [field: string]: unknown
}

export interface ScoreArgs {
  input: unknown
  output: unknown
  expected: unknown
  case: EvalCase
  unit?: AnyUnit
}

export interface ScoreResult {
  /** 0 to 1. */
  score: number
  /** One line on what was wrong, for the report. */
  detail?: string
  metadata?: Record<string, unknown>
}

export interface Scorer {
  name: string
  /** The score a case needs from this scorer to pass. */
  passAt: number
  score(args: ScoreArgs): number | ScoreResult | Promise<number | ScoreResult>
}

/** A scorer from a function. `passAt` defaults to 1. */
export function scorer(name: string, fn: Scorer['score'], passAt = 1): Scorer {
  return { name, passAt, score: fn }
}

/** The value at a dotted path, such as `items.0.slot`. */
export function at(value: unknown, path: string | undefined): unknown {
  if (!path) return value
  let v: unknown = value
  for (const k of path.split('.')) {
    if (v === null || v === undefined || typeof v !== 'object') return undefined
    v = (v as Record<string, unknown>)[k]
  }
  return v
}

const same = (a: unknown, b: unknown) => canonicalJson(a ?? null) === canonicalJson(b ?? null)
const loose = (v: unknown): unknown => (typeof v === 'string' ? v.normalize('NFKC').trim().replace(/\s+/g, ' ').toLowerCase() : v)
const show = (v: unknown) => {
  const s = typeof v === 'string' ? JSON.stringify(v) : canonicalJson(v ?? null)
  return s.length > 80 ? `${s.slice(0, 77)}...` : s
}
const textOf = (v: unknown) => (typeof v === 'string' ? v : v === undefined ? '' : JSON.stringify(v))

interface PickOptions {
  /** Compare the output at this dotted path. */
  path?: string
  /** Where the expected value is. Default the case's `expected`. */
  expected?: (c: EvalCase) => unknown
  passAt?: number
}

/** The output (or the value at `path`) equals the expected value, compared as canonical JSON. */
export function exact(o: PickOptions & { name?: string } = {}): Scorer {
  return scorer(
    o.name ?? 'exact',
    ({ output, case: c, expected }) => {
      const want = o.expected ? o.expected(c) : expected
      const got = at(output, o.path)
      return same(got, want) ? 1 : { score: 0, detail: `expected ${show(want)}, got ${show(got)}` }
    },
    o.passAt ?? 1,
  )
}

/**
 * The output's text holds each expected string. Expected is a string or a
 * list; the score is the share found. Case and spacing are ignored unless
 * `exactCase`.
 */
export function includes(o: PickOptions & { name?: string; exactCase?: boolean } = {}): Scorer {
  return scorer(
    o.name ?? 'includes',
    ({ output, case: c, expected }) => {
      const want = o.expected ? o.expected(c) : expected
      const needles = (Array.isArray(want) ? want : [want]).filter((x) => x !== undefined && x !== null).map(String)
      if (!needles.length) return { score: 0, detail: 'the case names nothing to look for' }
      const norm = (s: string) => (o.exactCase ? s : (loose(s) as string))
      const hay = norm(textOf(at(output, o.path)))
      const missing = needles.filter((n) => !hay.includes(norm(n)))
      return { score: (needles.length - missing.length) / needles.length, ...(missing.length ? { detail: `missing ${missing.map(show).join(', ')}` } : {}) }
    },
    o.passAt ?? 1,
  )
}

/**
 * Field by field: each field of the expected object (or the `fields` named,
 * as dotted paths) equals the output's. The score is the share that match.
 * `loose` compares strings without case and extra spaces.
 */
export function jsonFields(o: PickOptions & { name?: string; fields?: readonly string[]; loose?: boolean } = {}): Scorer {
  return scorer(
    o.name ?? 'json_fields',
    ({ output, case: c, expected }) => {
      const want = o.expected ? o.expected(c) : expected
      if (!want || typeof want !== 'object') return { score: 0, detail: 'expected is not an object' }
      const got = at(output, o.path)
      const fields = o.fields ?? Object.keys(want)
      if (!fields.length) return 1
      const wrong: string[] = []
      for (const f of fields) {
        const a = at(got, f)
        const b = Object.hasOwn(want, f) ? (want as Record<string, unknown>)[f] : at(want, f)
        if (!(o.loose ? same(loose(a), loose(b)) : same(a, b))) wrong.push(`${f}: expected ${show(b)}, got ${show(a)}`)
      }
      return { score: (fields.length - wrong.length) / fields.length, ...(wrong.length ? { detail: wrong.join('; ') } : {}), metadata: { wrong: wrong.length } }
    },
    o.passAt ?? 1,
  )
}

/** The output passes a schema: the one given, else the unit's output schema. */
export function schemaValid(schema?: SchemaLike<unknown>, o: { name?: string; path?: string } = {}): Scorer {
  return scorer(o.name ?? 'schema_valid', async ({ output, unit }) => {
    const s = schema ?? (unit?.output as SchemaLike<unknown> | undefined)
    if (!s) return { score: 0, detail: 'no schema: give one, or a unit with an output' }
    const v = await validate(s, at(output, o.path))
    return v.ok ? 1 : { score: 0, detail: v.issues.map((i) => `${i.path || '(root)'} ${i.message}`).join('; ') }
  })
}

// ---------------------------------------------------------------- actors

/** One actor case, as it went. The output `runActorCase` gives and `slotAccuracy` scores. */
export interface ActorTranscript {
  session: string
  replies: ActorReply[]
  /** The slot each question asked about, in order. */
  asked: string[]
  /** The card's input when a card was reached, else the pre-fill so far. */
  values: Record<string, unknown>
  state: ActorReply['state']
  /** The person turn (from 1) after which the card or an approval stood, or null. */
  turnsToComplete: number | null
}

/** An actor case's input: the person's turns, in order, and what the product already knew. */
export interface ActorCaseInput {
  turns: readonly (string | ReplyInput)[]
  prefill?: Readonly<Record<string, unknown>>
  language?: string
}

const READY = new Set(['confirm', 'pending_approval', 'done'])

/**
 * Plays an actor case through the runtime: the first turn starts the session,
 * each next one replies. It never confirms the card. Pass it as the run of
 * `evalUnit` and score it with `slotAccuracy`.
 */
export async function runActorCase<C extends BaseCtx>(rt: ActorRuntime<C>, ctx: C, actor: string, input: ActorCaseInput): Promise<ActorTranscript> {
  const turns = input.turns.map((t) => (typeof t === 'string' ? { text: t } : t))
  const replies: ActorReply[] = []
  const first: StartInput = { ...(turns[0] ?? {}), ...(input.prefill ? { prefill: input.prefill } : {}), ...(input.language ? { language: input.language } : {}) }
  let r = await rt.start(ctx, actor, first)
  replies.push(r)
  let done: number | null = READY.has(r.state) ? 1 : null
  for (let i = 1; i < turns.length; i++) {
    r = await rt.reply(ctx, r.session, turns[i]!)
    replies.push(r)
    if (done === null && READY.has(r.state)) done = i + 1
  }
  const status = r.card ? r : await rt.status(ctx, r.session)
  const values = r.card?.input ?? status.handoff?.prefill ?? {}
  return { session: r.session, replies, asked: replies.flatMap((x) => (x.question ? [x.question.slot] : [])), values: { ...values }, state: r.state, turnsToComplete: done }
}

/** What an actor case expects. */
export interface ActorExpected {
  /** The slot values the card should hold. */
  slots?: Readonly<Record<string, unknown>>
  /** The slots the actor should ask about, in order. */
  asked?: readonly string[]
  /** The card should stand after at most this many turns. */
  turns?: number
  /** The state after the last turn, such as `confirm`. */
  state?: string
}

/**
 * Slot accuracy for an actor case: the share of expected values the card
 * holds, whether it asked the expected questions in order, whether the card
 * stood within the expected turns, and the final state. The score is the mean
 * of the parts the case names; `detail` lists what was off.
 */
export function slotAccuracy(o: { name?: string; passAt?: number; loose?: boolean } = {}): Scorer {
  return scorer(
    o.name ?? 'slot_accuracy',
    ({ output, expected }) => {
      const t = output as ActorTranscript | undefined
      const e = (expected ?? {}) as ActorExpected
      if (!t || !Array.isArray(t.asked)) return { score: 0, detail: 'the output is not an actor transcript (use runActorCase)' }
      const parts: number[] = []
      const notes: string[] = []
      const metadata: Record<string, unknown> = {}
      if (e.slots) {
        const keys = Object.keys(e.slots)
        const wrong = keys.filter((k) => !(o.loose === false ? same(t.values[k], e.slots![k]) : same(loose(t.values[k]), loose(e.slots![k]))))
        parts.push(keys.length ? (keys.length - wrong.length) / keys.length : 1)
        metadata.values = keys.length ? (keys.length - wrong.length) / keys.length : 1
        for (const k of wrong) notes.push(`${k}: expected ${show(e.slots[k])}, got ${show(t.values[k])}`)
      }
      if (e.asked) {
        const ok = same(t.asked, e.asked)
        const shared = e.asked.filter((s, i) => t.asked[i] === s).length
        const q = ok ? 1 : shared / Math.max(e.asked.length, t.asked.length, 1)
        parts.push(q)
        metadata.questions = q
        if (!ok) notes.push(`asked ${show(t.asked)}, expected ${show(e.asked)}`)
      }
      if (e.turns !== undefined) {
        const ok = t.turnsToComplete !== null && t.turnsToComplete <= e.turns
        parts.push(ok ? 1 : 0)
        metadata.turns = t.turnsToComplete
        if (!ok) notes.push(`card ${t.turnsToComplete === null ? 'never stood' : `stood after ${t.turnsToComplete} turns`}, expected at most ${e.turns}`)
      }
      if (e.state !== undefined) {
        parts.push(t.state === e.state ? 1 : 0)
        if (t.state !== e.state) notes.push(`state ${t.state}, expected ${e.state}`)
      }
      if (!parts.length) return { score: 0, detail: 'the case expects nothing: give slots, asked, turns or state' }
      return { score: parts.reduce((a, b) => a + b, 0) / parts.length, ...(notes.length ? { detail: notes.join('; ') } : {}), metadata }
    },
    o.passAt ?? 1,
  )
}

// The slot machine. Code owns the journey: which slot comes next, every
// check, the card and the submit. The model does one narrow job per turn,
// through `scope.structured`: it reads what the person sent into
// `{slot, value, confidence, evidence}` items. Nothing it returns can reach
// the target; only `confirm()`, called on a person's click with the card's
// id, sends the target through the guard.
//
// A session is one run of the actor's unit: every turn's model call, every
// lookup and check, and the submit, resumed request after request.

import type { Ai, RunCallOutcome, RunScope } from '../ai/ai.js'
import { CapRefusal, ResumeRefusal } from '../ai/ai.js'
import type { RunOutcome, RunStore } from '../ai/runs.js'
import type { BaseCtx } from '../capabilities/capability.js'
import type { Registry } from '../capabilities/registry.js'
import type { JsonSchema } from '../capabilities/standard.js'
import { needsApproval, needsConfirm, type Tier } from '../capabilities/tiers.js'
import { canonicalJson, sha256Hex } from '../guard/crypto.js'
import type { CallOptions, Guard } from '../guard/types.js'
import type { Image } from '../types.js'
import { type Actor, ActorError, type ExtractedItem, targetTierProblem, type Values } from './actor.js'
import { display, labelOf, normalise, propIssue, type ResolvedSlot, resolveSlots, wordsIn } from './slots.js'
import type { SqlSessionStore } from './stores.js'
import { type ActorText, textFor } from './text.js'
import {
  type ActorReply,
  type ActorSession,
  type Attachment,
  type AttachmentRef,
  type Card,
  type CardRow,
  type Change,
  type Choice,
  FINAL_STATES,
  type Handoff,
  OPEN_STATES,
  type Question,
  type QuestionKind,
  type ReplyInput,
  type SessionStore,
  type SlotState,
  type TurnRecord,
} from './types.js'

export interface ActorRuntimeOptions<C extends BaseCtx> {
  /** Every model call and every capability call of a session goes through it. */
  ai: Ai<C>
  /** The registry the guard uses: the target's input schema and tier come from it. */
  registry: Registry<C, any, any>
  actors: readonly Actor<C>[]
  sessions: SessionStore
  /**
   * A second store every write is copied to, so a session held in a Durable
   * Object can be found and resumed from another surface (D1 beside a DO).
   */
  drafts?: SessionStore
  /** Lets `status` settle a session waiting for approval. */
  guard?: Guard<C>
  /** The person's language, such as `bn`. Default `en`. */
  language?: (ctx: C) => string | undefined
  /** The product's own sentences, by language, over the kit's. */
  text?: Readonly<Record<string, Partial<ActorText>>>
  /**
   * Rephrases a question, through a task of the product's own. The template's
   * text is used when it returns nothing or throws. Choices never change.
   */
  phrase?: (ctx: C, question: Question, language: string) => Promise<string | null | undefined>
  /** Turns kept on a session. Default 50. */
  maxTurns?: number
  now?: () => number
  newId?: () => string
  onError?: (err: unknown, where: string) => void
}

export interface StartInput extends ReplyInput {
  /** Values the product already knows, such as the tenant on the screen. Trusted, still checked. */
  prefill?: Readonly<Record<string, unknown>>
  language?: string
}

export interface ActorRuntime<C extends BaseCtx> {
  /** Opens a session. With text or attachments, the first turn runs at once. */
  start(ctx: C, actor: string, input?: StartInput): Promise<ActorReply>
  /** One turn: extract, validate, clarify. A reply on the card goes back to collecting. */
  reply(ctx: C, session: string, input: ReplyInput): Promise<ActorReply>
  /** The person's click on the card. The only path to the target. */
  confirm(ctx: C, session: string, card: string): Promise<ActorReply>
  /** Ends the session and returns the form's pre-fill. */
  handoff(ctx: C, session: string): Promise<ActorReply>
  cancel(ctx: C, session: string): Promise<ActorReply>
  /** Where the session is, with the pre-fill. Settles a waiting approval when the runtime has the guard. */
  status(ctx: C, session: string): Promise<ActorReply>
  /** This person's newest open session, for any actor or one. */
  resume(ctx: C, actor?: string): Promise<ActorReply | null>
  /** The session, when it is this person's in this tenant. */
  session(ctx: C, id: string): Promise<ActorSession | null>
  actor(id: string): Actor<C> | undefined
  readonly actors: readonly Actor<C>[]
}

/** A call the runtime cannot answer with a turn: no such session or actor, or another write got there first. */
export class ActorRefusal extends Error {
  override readonly name = 'ActorRefusal'
  constructor(
    readonly code: 'unknown_actor' | 'not_found' | 'conflict',
    message: string,
  ) {
    super(message)
  }
}

// ---------------------------------------------------------------- helpers

const same = (a: unknown, b: unknown) => canonicalJson(a ?? null) === canonicalJson(b ?? null)
const isOpen = (s: ActorSession) => OPEN_STATES.includes(s.state)

interface Work<C extends BaseCtx> {
  ctx: C
  actor: Actor<C>
  slots: ResolvedSlot<C>[]
  s: ActorSession
  text: ActorText
  turn: TurnRecord
  changes: Change[]
  notes: string[]
  refusal?: { code: string; message: string }
  /** The session's run, resumed (or started) when the turn first needs it: a model call, a lookup, the submit. */
  scope?: RunScope<C>
}

// ---------------------------------------------------------------- the runtime

export function actorRuntime<C extends BaseCtx>(opts: ActorRuntimeOptions<C>): ActorRuntime<C> {
  const now = opts.now ?? Date.now
  const iso = () => new Date(now()).toISOString()
  const newId = opts.newId ?? (() => `act_${crypto.randomUUID().replace(/-/g, '')}`)
  const maxTurns = opts.maxTurns ?? 50
  const onError = opts.onError ?? ((e, where) => console.error(`actors: ${where}`, e))
  const { ai, registry } = opts

  // Every actor matched to its target once, at build time.
  const byId = new Map<string, { actor: Actor<C>; slots: ResolvedSlot<C>[] }>()
  for (const a of opts.actors) {
    const cap = registry.get(a.target)
    if (!cap) throw new Error(`actor ${a.id}: target ${a.target} is not in the registry`)
    const tp = targetTierProblem(a.target, cap.risk)
    if (tp) throw new ActorError(a.id, [tp])
    const problems: string[] = []
    for (const s of a.slots) {
      for (const r of [s.lookup, s.check]) {
        if (!r) continue
        const c = registry.get(r.capability)
        if (!c) problems.push(`slot ${s.name} reads ${r.capability}, which is not in the registry`)
        else if (c.risk !== 'R0' && c.risk !== 'R1') problems.push(`slot ${s.name} reads ${r.capability}, which is ${c.risk}; a lookup or check must be R0 or R1`)
      }
    }
    if (problems.length) throw new Error(`actor ${a.id}: ${problems.join('; ')}`)
    if (byId.has(a.id)) throw new Error(`actor ${a.id} is given twice`)
    byId.set(a.id, { actor: a, slots: resolveSlots(a, cap.inputJson) })
  }

  const textOf = (lang: string) => textFor(lang, opts.text)

  // ---------------------------------------------------------------- storage

  async function save(s: ActorSession, expect: number | null): Promise<void> {
    if (!(await opts.sessions.put(s, expect))) throw new ActorRefusal('conflict', 'This conversation changed in another window. Open it again to continue.')
    if (opts.drafts) {
      try {
        const ok = (await opts.drafts.put(s, expect)) || (await opts.drafts.put(s, null))
        if (!ok) onError(new Error(`draft ${s.id} not written`), 'drafts.put')
      } catch (e) {
        onError(e, 'drafts.put')
      }
    }
  }

  async function load(ctx: C, id: string): Promise<{ s: ActorSession; entry: { actor: Actor<C>; slots: ResolvedSlot<C>[] } }> {
    let s = await opts.sessions.get(id)
    if (!s && opts.drafts) {
      s = await opts.drafts.get(id)
      // Resumed from the draft: put it back in the session store.
      if (s && !(await opts.sessions.put(s, null))) s = await opts.sessions.get(id)
    }
    if (!s || s.person !== ctx.principal.id || s.tenant !== ctx.tenant) throw new ActorRefusal('not_found', 'No such conversation.')
    const entry = byId.get(s.actor)
    if (!entry) throw new ActorRefusal('unknown_actor', `No actor ${s.actor}.`)
    // 24 hours idle, by default, ends a session nobody finished.
    if (isOpen(s) && now() > Date.parse(s.expiresAt)) {
      const prev = s.version
      s = expiredSession(s, iso(), ctx.channel, maxTurns)
      await save(s, prev)
      await endRun(ai.runs, s, 'cancelled', iso(), onError)
    }
    return { s, entry }
  }

  function pushTurn(s: ActorSession, t: TurnRecord) {
    s.turns = [...s.turns, t].slice(-maxTurns)
  }

  // ---------------------------------------------------------------- runs

  /**
   * The session's run. Resumed when the session has one; started on the
   * session's first need. A session continued on another seat, or after a new
   * version of the actor, cannot carry its run on: the old run is closed and
   * a new one starts, so `runs` lists both.
   */
  async function scopeFor(w: Work<C>): Promise<RunScope<C>> {
    if (w.scope) return w.scope
    const unit = w.actor.unit
    const vars = { title: titleOf(w), fields: fieldsOf(w) }
    const last = w.s.runs.at(-1)
    if (last && last.unit === unit.id) {
      try {
        w.scope = await ai.resume(w.ctx, unit, last.run, { vars })
        w.turn.run = last.run
        return w.scope
      } catch (e) {
        if (!(e instanceof ResumeRefusal)) throw e
        if (e.code !== 'not_found') await endRun(ai.runs, w.s, 'ok', iso(), onError)
      }
    }
    const scope = await ai.start(w.ctx, unit, { language: w.s.language, vars })
    w.scope = scope
    w.s.runs = [...w.s.runs, { unit: unit.id, run: scope.id }]
    w.turn.run = scope.id
    return scope
  }

  const titleOf = (w: Pick<Work<C>, 'actor' | 's'>) => wordsIn(w.actor.title, w.s.language) ?? registry.get(w.actor.target)?.title ?? w.actor.target

  function fieldsOf(w: Work<C>): string {
    return w.slots
      .filter((sl) => sl.extractable)
      .map((sl) => {
        const t = sl.prop.type ? (Array.isArray(sl.prop.type) ? sl.prop.type.join(' or ') : String(sl.prop.type)) : 'text'
        const kind = sl.lookup ? 'text, looked up by name' : sl.parse ? 'as written' : t
        const hint = sl.hint ?? (typeof sl.prop.description === 'string' ? sl.prop.description : labelOf(sl, 'en'))
        const en = Array.isArray(sl.prop.enum) ? ` One of: ${(sl.prop.enum as unknown[]).join(', ')}.` : ''
        return `- ${sl.name} (${kind}${sl.required ? ', required' : ''}): ${hint}${en}`
      })
      .join('\n')
  }

  /** The person's own values so far, for the extractor. Fenced as untrusted: they came from people. */
  function knownOf(w: Work<C>, asked: Question | null): string {
    const values: Record<string, unknown> = {}
    const doubtful: Record<string, unknown> = {}
    for (const sl of w.slots) {
      const st = w.s.slots[sl.name]
      if (!st || !sl.extractable) continue
      if (st.status === 'filled') values[sl.name] = st.display ?? st.value
      else if (st.status !== 'empty') doubtful[sl.name] = st.query ?? st.display ?? st.value
    }
    return JSON.stringify({ values, unsettled: doubtful, last_question: asked ? { slot: asked.slot, text: asked.text } : null })
  }

  // ---------------------------------------------------------------- one turn

  function setSlot(w: Work<C>, name: string, next: SlotState) {
    const before = w.s.slots[name]
    w.s.slots[name] = { ...next, turn: w.turn.n }
    if (!before || !same(before.value, next.value) || before.status !== next.status) {
      // Anything that depends on this slot is looked up or checked again.
      for (const sl of w.slots) {
        if (!(sl.after ?? []).includes(name)) continue
        const st = w.s.slots[sl.name]
        if (!st || st.status === 'empty') continue
        if (sl.lookup && (st.query !== undefined || sl.lookup.auto)) {
          // Looked up again for the new value; the old label stays so the change can be said.
          w.s.slots[sl.name] = { status: 'waiting', query: st.query, confidence: st.confidence, source: st.source, evidence: st.evidence, attachment: st.attachment, display: st.display }
        } else w.s.slots[sl.name] = { ...st, checked: false }
      }
    }
  }

  const slotOf = (w: Work<C>, name: string) => w.slots.find((sl) => sl.name === name)

  function noteChange(w: Work<C>, sl: ResolvedSlot<C>, before: SlotState | undefined, to: string) {
    // A filled value, or a lookup waiting to replace one, that now reads differently.
    const was = before && (before.status === 'filled' || before.status === 'waiting') ? (before.display ?? (before.status === 'filled' ? display(sl, before.value, w.s.language) : undefined)) : undefined
    if (was !== undefined && was !== to) w.changes.push({ slot: sl.name, from: was, to })
  }

  /** The extractor's items, by code: unknown and derived slots dropped, values read, conflicts and doubts kept. */
  function applyItems(w: Work<C>, items: readonly ExtractedItem[], refs: readonly AttachmentRef[]) {
    const lang = w.s.language
    const dropped = new Set<string>()
    const groups = new Map<string, ExtractedItem[]>()
    for (const it of items) {
      const sl = slotOf(w, it.slot)
      if (!sl || !sl.extractable || (sl.when && !sl.when(valuesOf(w), w.ctx))) {
        dropped.add(it.slot)
        continue
      }
      const list = groups.get(sl.name) ?? []
      list.push(it)
      groups.set(sl.name, list)
    }
    w.turn.slots = [...groups.keys()]
    if (dropped.size) w.turn.dropped = [...dropped].map((d) => d.slice(0, 64)).slice(0, 20)
    const attachmentIds = new Set(refs.map((r) => r.id))

    for (const [name, list] of groups) {
      const sl = slotOf(w, name)!
      const before = w.s.slots[name]
      // Read each item into the slot's value; group equal values.
      const read: { value: unknown; raw: string; confidence: number; items: ExtractedItem[] }[] = []
      let issue: string | undefined
      for (const it of list) {
        const raw = it.value === null ? '' : String(it.value)
        const n = sl.lookup ? (raw.trim() ? { value: raw.trim() } : { issue: 'empty' }) : normalise(sl, it.value)
        if ('issue' in n) {
          issue ??= n.issue
          continue
        }
        const hit = read.find((r) => same(r.value, n.value) || (sl.lookup && String(r.value).toLowerCase() === String(n.value).toLowerCase()))
        if (hit) {
          hit.confidence = Math.max(hit.confidence, it.confidence)
          hit.items.push(it)
        } else read.push({ value: n.value, raw, confidence: it.confidence, items: [it] })
      }
      if (!read.length) {
        // Nothing readable: keep a good value, say why otherwise.
        if (before?.status !== 'filled' && issue && issue !== 'empty') setSlot(w, name, { status: 'invalid', issue: w.text.issue(issue, labelOf(sl, lang)), evidence: list[0]?.evidence })
        continue
      }
      const sourceOf = (its: ExtractedItem[]) => {
        const fromAtt = its.find((i) => attachmentIds.has(i.from))
        const fromMsg = its.find((i) => !attachmentIds.has(i.from))
        return {
          source: (fromMsg ? 'message' : 'attachment') as SlotState['source'],
          evidence: its
            .map((i) => i.evidence)
            .filter(Boolean)
            .join(' | ')
            .slice(0, 300),
          ...(fromAtt ? { attachment: fromAtt.from } : {}),
        }
      }
      const sure = read.filter((r) => r.confidence >= sl.threshold)
      if (read.length > 1 && sure.length !== 1) {
        // The message and an attachment disagree, or two readings are both unsure: the person chooses.
        const choices: Choice[] = read.map((r) => ({ id: r.value as Choice['id'], label: sl.lookup ? String(r.value) : display(sl, r.value, lang), detail: sourceOf(r.items).source }))
        setSlot(w, name, { status: 'choice', choices, evidence: sourceOf(read.flatMap((r) => r.items)).evidence, issue: 'conflict' })
        continue
      }
      const pick = sure[0] ?? read[0]!
      const src = sourceOf(pick.items)
      if (sl.lookup) {
        // A name is never an id: it waits for the lookup.
        if (before?.status === 'choice' && before.choices) {
          const q = String(pick.value).toLowerCase()
          const c = before.choices.find((x) => String(x.id).toLowerCase() === q || x.label.toLowerCase() === q)
          if (c && before.issue !== 'conflict') {
            noteChange(w, sl, before, c.label)
            setSlot(w, name, { status: 'filled', value: c.id, display: c.label, query: before.query, confidence: pick.confidence, ...src, source: 'person' })
            continue
          }
        }
        if (before?.status === 'filled' && before.query?.toLowerCase() === String(pick.value).toLowerCase()) continue
        setSlot(w, name, { status: 'waiting', query: String(pick.value), confidence: pick.confidence, ...src })
        if (before?.status === 'filled') w.s.slots[name] = { ...w.s.slots[name]!, display: before.display }
        continue
      }
      const shown = display(sl, pick.value, lang)
      if (before?.status === 'filled' && same(before.value, pick.value)) {
        w.s.slots[name] = { ...before, confidence: Math.max(before.confidence ?? 0, pick.confidence) }
        continue
      }
      // The doubtful value, said again with confidence, is settled.
      if (pick.confidence < sl.threshold) {
        setSlot(w, name, { status: 'doubtful', value: pick.value, display: shown, confidence: pick.confidence, ...src })
        continue
      }
      noteChange(w, sl, before, shown)
      setSlot(w, name, { status: 'filled', value: pick.value, display: shown, confidence: pick.confidence, ...src })
    }
  }

  const valuesOf = (w: Pick<Work<C>, 's' | 'slots'>): Values => {
    const v: Record<string, unknown> = {}
    for (const sl of w.slots) {
      const st = w.s.slots[sl.name]
      if (st?.status === 'filled') v[sl.name] = st.value
    }
    return v
  }

  const depsFilled = (w: Work<C>, sl: ResolvedSlot<C>) => (sl.after ?? []).every((d) => w.s.slots[d]?.status === 'filled')
  const applies = (w: Work<C>, sl: ResolvedSlot<C>) => !sl.when || sl.when(valuesOf(w), w.ctx)

  /** A capability call on the turn's run. A cap that stops the run is a refusal, not a throw. */
  async function read(w: Work<C>, capability: string, args: unknown, callOpts?: CallOptions): Promise<RunCallOutcome> {
    let scope: RunScope<C>
    try {
      scope = await scopeFor(w)
    } catch (e) {
      if (!(e instanceof CapRefusal)) throw e
      return { outcome: 'error', code: `cap_${e.cap}`, message: e.message, requestId: w.ctx.requestId }
    }
    return scope.call(capability, args, callOpts)
  }

  /** Derived values, lookups and checks, until nothing moves. */
  async function settle(w: Work<C>) {
    const lang = w.s.language
    for (let pass = 0; pass <= w.slots.length; pass++) {
      let moved = false
      for (const sl of w.slots) {
        if (!applies(w, sl)) continue
        const st = w.s.slots[sl.name] ?? { status: 'empty' }

        if (sl.derive) {
          if (!depsFilled(w, sl)) continue
          let v: unknown
          try {
            v = sl.derive({ values: valuesOf(w), ctx: w.ctx, attachments: w.s.attachments, session: w.s })
          } catch (e) {
            onError(e, `derive ${sl.name}`)
          }
          const next: SlotState = v === undefined ? { status: 'empty' } : { status: 'filled', value: v, display: display(sl, v, lang), confidence: 1, source: 'derived', checked: true }
          if (!same(st.value, next.value) || st.status !== next.status) {
            setSlot(w, sl.name, next)
            moved = true
          }
          continue
        }

        if (sl.lookup && depsFilled(w, sl) && (st.status === 'waiting' || (sl.lookup.auto && st.status === 'empty' && st.issue === undefined))) {
          const q = st.status === 'waiting' ? st.query : undefined
          const out = await read(w, sl.lookup.capability, sl.lookup.args(q, valuesOf(w), w.ctx))
          const label = labelOf(sl, lang)
          if (out.outcome !== 'ok') {
            setSlot(w, sl.name, { ...st, status: q === undefined ? 'empty' : 'invalid', issue: w.text.uncheckable(label) })
            moved = true
            continue
          }
          let choices: Choice[]
          try {
            choices = sl.lookup.choices(out.result, q)
          } catch (e) {
            onError(e, `lookup ${sl.name}`)
            choices = []
          }
          const conf = st.confidence ?? 1
          if (choices.length === 1) {
            const c = choices[0]!
            const before = w.s.slots[sl.name]
            noteChange(w, sl, before, c.label)
            const auto = q === undefined
            setSlot(w, sl.name, {
              status: auto || conf >= sl.threshold ? 'filled' : 'doubtful',
              value: c.id,
              display: c.label,
              query: q,
              confidence: auto ? 1 : conf,
              source: auto ? 'lookup' : st.source,
              evidence: st.evidence,
              attachment: st.attachment,
            })
          } else if (choices.length > 1) setSlot(w, sl.name, { status: 'choice', choices: choices.slice(0, 10), query: q, confidence: conf, source: st.source, evidence: st.evidence })
          else if (q !== undefined) setSlot(w, sl.name, { status: 'not_found', query: q, issue: w.text.notFound(label, q), source: st.source, evidence: st.evidence })
          // An automatic lookup that found nothing is asked as missing; mark it tried.
          else setSlot(w, sl.name, { status: 'empty', issue: 'none' })
          moved = true
          continue
        }

        if (st.status === 'filled' && !st.checked && st.source !== 'derived') {
          const issue = await checkValue(w, sl, st.value)
          if (issue) setSlot(w, sl.name, { ...st, status: 'invalid', issue })
          else w.s.slots[sl.name] = { ...st, checked: true }
          moved = true
        }
      }
      if (!moved) break
    }
  }

  /** The slot's own checks: the schema, the product's function, the guard-checked read. Null when it passes. */
  async function checkValue(w: Work<C>, sl: ResolvedSlot<C>, v: unknown): Promise<string | null> {
    const label = labelOf(sl, w.s.language)
    if (!sl.lookup) {
      const code = propIssue(sl.prop, v)
      if (code) return w.text.issue(code, label)
    }
    if (sl.validate) {
      try {
        const r = await sl.validate(v, valuesOf(w), w.ctx)
        if (r !== true) return typeof r === 'string' && r ? r : w.text.issue('invalid', label)
      } catch (e) {
        onError(e, `validate ${sl.name}`)
        return w.text.uncheckable(label)
      }
    }
    if (sl.check) {
      const out = await read(w, sl.check.capability, sl.check.args(v, valuesOf(w), w.ctx))
      if (out.outcome !== 'ok') return w.text.uncheckable(label)
      const ok = sl.check.ok(out.result, v)
      if (ok !== true) return ok || w.text.issue('invalid', label)
    }
    return null
  }

  /** Slots the input needs: required ones, what they depend on, and any with a value in doubt. */
  function needed(w: Work<C>): Set<string> {
    const need = new Set<string>()
    const add = (name: string) => {
      if (need.has(name)) return
      need.add(name)
      for (const d of slotOf(w, name)?.after ?? []) add(d)
    }
    for (const sl of w.slots) {
      if (!applies(w, sl) || sl.derive) continue
      const st = w.s.slots[sl.name]
      if (sl.required || (st && st.status !== 'empty' && st.status !== 'filled')) add(sl.name)
    }
    return need
  }

  /** The next question, in slot order, or null when every needed slot is filled. */
  function nextQuestion(w: Work<C>): Question | null {
    const lang = w.s.language
    const need = needed(w)
    for (const sl of w.slots) {
      if (!need.has(sl.name) || !applies(w, sl) || sl.derive) continue
      const st = w.s.slots[sl.name] ?? { status: 'empty' }
      if (st.status === 'filled') continue
      if (!depsFilled(w, sl)) continue
      const label = labelOf(sl, lang)
      const ask = wordsIn(sl.ask, lang) ?? w.text.missing(label)
      const fixed = sl.choices ? [...sl.choices] : Array.isArray(sl.prop.enum) && (sl.prop.enum as unknown[]).length <= 10 ? (sl.prop.enum as Choice['id'][]).map((id) => ({ id, label: display(sl, id, lang) })) : undefined
      switch (st.status) {
        case 'doubtful':
          return { slot: sl.name, kind: 'doubtful', text: w.text.doubtful(label, st.display ?? display(sl, st.value, lang)), affirm: true }
        case 'choice':
          if (st.issue === 'conflict' && st.choices && st.choices.length >= 2) {
            return { slot: sl.name, kind: 'conflict', text: w.text.conflict(label, st.choices[0]!.label, st.choices[1]!.label), choices: st.choices }
          }
          return { slot: sl.name, kind: 'choice', text: w.text.choice(label, st.query ?? ''), choices: st.choices ?? [] }
        case 'not_found':
          return { slot: sl.name, kind: 'not_found', text: st.issue ?? w.text.notFound(label, st.query ?? ''), ...(fixed ? { choices: fixed } : {}) }
        case 'invalid':
          return { slot: sl.name, kind: 'invalid', text: w.text.invalid(label, st.issue ?? ''), ...(fixed ? { choices: fixed } : {}) }
        default:
          // Empty, or a lookup still waiting on something.
          return { slot: sl.name, kind: 'missing', text: ask, ...(fixed ? { choices: fixed } : {}) }
      }
    }
    return null
  }

  /** The target's input: filled values, then defaults. Doubtful values never. */
  function inputOf(w: Pick<Work<C>, 's' | 'slots' | 'ctx'>, withDefaults = true): Record<string, unknown> {
    const values = valuesOf(w)
    const input: Record<string, unknown> = {}
    for (const sl of w.slots) {
      if (sl.when && !sl.when(values, w.ctx)) continue
      const st = w.s.slots[sl.name]
      if (st?.status === 'filled') input[sl.name] = st.value
      else if (withDefaults) {
        const d = typeof sl.default === 'function' ? (sl.default as (v: Values, c: C) => unknown)(values, w.ctx) : sl.default
        if (d !== undefined) input[sl.name] = d
      }
    }
    return input
  }

  function handoffOf(w: Pick<Work<C>, 's' | 'slots' | 'ctx' | 'actor'>): Handoff {
    const prefill = inputOf(w)
    const pending: Record<string, unknown> = {}
    for (const sl of w.slots) {
      const st = w.s.slots[sl.name]
      if (st && st.status !== 'filled' && st.status !== 'empty') pending[sl.name] = st.value ?? st.query
    }
    let url: string | undefined
    try {
      url = w.actor.handoff?.(prefill, w.s)
    } catch (e) {
      onError(e, 'handoff')
    }
    return { prefill, pending, ...(url ? { url } : {}) }
  }

  const needsOf = (t: Tier): Card['needs'] => (needsApproval(t) ? 'approval' : 'confirm')

  /**
   * The target through the guard, on the session's run. A spend cap stops
   * model calls, not the person's own submit: when the run cannot be resumed
   * for a cap, the call is recorded on it without one.
   */
  async function targetCall(w: Work<C>, input: Record<string, unknown>, callOpts?: CallOptions): Promise<RunCallOutcome> {
    try {
      const scope = await scopeFor(w)
      return await scope.call(w.actor.target, input, callOpts)
    } catch (e) {
      if (!(e instanceof CapRefusal)) throw e
      const last = w.s.runs.at(-1)
      if (last && last.unit === w.actor.unit.id) {
        w.turn.run = last.run
        return ai.callInRun(w.ctx, w.actor.unit, last.run, w.actor.target, input, callOpts)
      }
      return { outcome: 'error', code: `cap_${e.cap}`, message: e.message, requestId: w.ctx.requestId }
    }
  }

  /** Builds the card, or puts the problems the target's own parse finds back on the slots. */
  async function buildCard(w: Work<C>): Promise<Card | null> {
    const lang = w.s.language
    const values = valuesOf(w)
    if (w.actor.check) {
      let issues: { slot: string; message: string }[] = []
      try {
        issues = await w.actor.check(values, w.ctx)
      } catch (e) {
        onError(e, 'check')
        w.refusal = { code: 'check_failed', message: w.text.unread() }
        return null
      }
      let hit = false
      for (const i of issues) {
        const st = w.s.slots[i.slot]
        if (!slotOf(w, i.slot) || !st) continue
        setSlot(w, i.slot, { ...st, status: 'invalid', issue: i.message })
        hit = true
      }
      if (hit) return null
    }
    const input = inputOf(w)
    const parsed = await registry.parse(w.actor.target, input)
    if (!parsed.ok) {
      let hit = false
      for (const i of parsed.issues) {
        const name = i.path.split('.')[0] ?? ''
        const sl = slotOf(w, name)
        if (!sl || sl.derive) continue
        const st = w.s.slots[name] ?? { status: 'empty' }
        setSlot(w, name, { ...st, status: st.status === 'filled' ? 'invalid' : 'empty', issue: `${w.text.issue('invalid', labelOf(sl, lang))}` })
        hit = true
      }
      if (!hit) w.refusal = { code: 'invalid', message: parsed.issues.map((i) => `${i.path || 'input'}: ${i.message}`).join('; ') }
      return null
    }
    const tier = parsed.tier
    if (!needsConfirm(tier)) {
      // A target whose riskFor lowers this input below R2 would run with no confirm. The actor never submits that.
      w.refusal = { code: 'tier_below_confirm', message: `${titleOf(w)} would run at ${tier} for these values, with no confirm. Finish it in the form.` }
      return null
    }
    const rows: CardRow[] = []
    for (const sl of w.slots) {
      if (!(sl.name in input)) continue
      const st = w.s.slots[sl.name]
      rows.push({
        slot: sl.name,
        label: labelOf(sl, lang),
        value: input[sl.name],
        display: st?.status === 'filled' ? (st.display ?? display(sl, input[sl.name], lang)) : display(sl, input[sl.name], lang),
        source: st?.status === 'filled' ? (st.source ?? 'message') : 'default',
        ...(st?.status === 'filled' && st.evidence ? { evidence: st.evidence } : {}),
        ...(st?.status === 'filled' && st.attachment ? { attachment: st.attachment } : {}),
      })
    }
    const id = (await sha256Hex(canonicalJson({ session: w.s.id, turn: w.turn.n, input }))).slice(0, 24)
    let summary: string | undefined
    try {
      summary = w.actor.summary?.(values, lang, rows)
    } catch (e) {
      onError(e, 'summary')
    }
    const card: Card = { id, title: titleOf(w), summary: summary ?? titleOf(w), rows, input, tier, needs: needsOf(tier) }
    if (card.needs === 'confirm') {
      // R2: the guard's preview and confirm token for exactly this input. Nothing runs.
      const out = await targetCall(w, input)
      if (out.outcome === 'confirm_required') {
        card.preview = out.preview
        if (!summary) card.summary = out.preview.summary
        w.s.confirmToken = out.token
      } else if (out.outcome === 'invalid' && 'issues' in out && out.issues?.length) {
        for (const i of out.issues) {
          const name = i.path.split('.')[0] ?? ''
          const st = w.s.slots[name]
          if (st && slotOf(w, name)) setSlot(w, name, { ...st, status: 'invalid', issue: i.message })
        }
        return null
      } else {
        w.refusal = { code: 'code' in out ? String(out.code) : out.outcome, message: 'message' in out ? out.message : `The target answered ${out.outcome}.` }
        return null
      }
    }
    return card
  }

  /** After a turn's values moved: settle, then the next question or the card. */
  async function decide(w: Work<C>): Promise<Question | null> {
    for (let round = 0; round < 3; round++) {
      await settle(w)
      const q = nextQuestion(w)
      if (q) {
        w.s.state = 'collect'
        w.s.card = null
        w.s.confirmToken = undefined
        w.s.asking = { slot: q.slot, kind: q.kind }
        return q
      }
      const card = await buildCard(w)
      if (card) {
        w.s.state = 'confirm'
        w.s.card = card
        w.s.asking = null
        return null
      }
      if (w.refusal) break
    }
    w.s.state = 'collect'
    w.s.card = null
    w.s.asking = null
    return null
  }

  async function phrased(w: Work<C>, q: Question | null): Promise<Question | null> {
    if (!q || !opts.phrase) return q
    try {
      const t = await opts.phrase(w.ctx, q, w.s.language)
      return typeof t === 'string' && t.trim() ? { ...q, text: t.trim() } : q
    } catch (e) {
      onError(e, 'phrase')
      return q
    }
  }

  function replyOf(w: Pick<Work<C>, 's' | 'slots' | 'ctx' | 'actor' | 'text'> & Partial<Pick<Work<C>, 'changes' | 'notes' | 'refusal'>>, q: Question | null): ActorReply {
    const s = w.s
    const t = w.text
    const lang = s.language
    const parts: string[] = [...(w.notes ?? [])]
    for (const c of w.changes ?? []) {
      const sl = slotOf(w as Work<C>, c.slot)
      parts.push(t.changed(sl ? labelOf(sl, lang) : c.slot, c.from, c.to))
    }
    if (w.refusal) parts.push(w.refusal.message)
    const out: ActorReply = { session: s.id, actor: s.actor, state: s.state, message: '' }
    switch (s.state) {
      case 'confirm':
        if (s.card) {
          parts.push(s.card.summary, t.confirm(s.card.needs))
          out.card = s.card
        }
        break
      case 'pending_approval':
        parts.push(t.pending(s.approval?.decider ?? ''))
        if (s.approval) out.approval = s.approval
        break
      case 'done':
        parts.push(s.outcome?.startsWith('approval_') ? t.approvalEnded(s.outcome.slice(9)) : t.done())
        if (s.result !== undefined) out.result = s.result
        break
      case 'handoff':
        parts.push(t.handoff())
        break
      case 'cancelled':
        parts.push(t.cancelled())
        break
      case 'expired':
        parts.push(t.expired())
        break
      default:
        if (q) {
          parts.push(q.text)
          out.question = q
        }
    }
    out.message = parts.filter(Boolean).join(' ')
    if (w.changes?.length) out.changes = w.changes
    if (w.notes?.length) out.notes = w.notes
    if (w.refusal) out.refusal = w.refusal
    if (s.state === 'handoff' || s.state === 'expired' || s.state === 'cancelled' || isOpen(s)) out.handoff = handoffOf(w)
    return out
  }

  /** The question for the slot being asked, rebuilt from the stored state. */
  function currentQuestion(w: Work<C>): Question | null {
    if (!isOpen(w.s) || w.s.state === 'confirm') return null
    return nextQuestion(w)
  }

  function accept(w: Work<C>, list: readonly Attachment[] | undefined): Attachment[] {
    const spec = w.actor.unit.attachments
    const ok: Attachment[] = []
    for (const a of list ?? []) {
      const kind = String(a.kind ?? '').toLowerCase()
      if (!spec || !spec.kinds.includes(kind) || (spec.maxBytes !== undefined && (a.bytes ?? 0) > spec.maxBytes) || (a.image && !spec.vision && !a.text)) {
        w.notes.push(w.text.attachmentRefused(kind || 'unknown'))
        continue
      }
      const used = new Set(w.s.attachments.map((r) => r.id))
      let id = typeof a.id === 'string' && /^[A-Za-z0-9_.-]{1,64}$/.test(a.id) && !used.has(a.id) ? a.id : ''
      for (let n = w.s.attachments.length + 1; !id || used.has(id); n++) id = `att_${n}`
      const ref: AttachmentRef = { id, kind, ...(a.name ? { name: a.name.slice(0, 200) } : {}), ...(a.key ? { key: a.key } : {}), ...(a.bytes !== undefined ? { bytes: a.bytes } : {}) }
      w.s.attachments = [...w.s.attachments, ref]
      ok.push({ ...a, id, kind })
    }
    return ok
  }

  /** The one model call of a turn. Nothing it returns is trusted beyond a slot value. */
  async function extract(w: Work<C>, text: string | undefined, atts: Attachment[], asked: Question | null): Promise<ExtractedItem[]> {
    const images: Image[] = atts.filter((a) => a.image).map((a) => a.image!)
    // A turn with an image runs on the vision role, for this call only, in the same run.
    const vision = images.length ? w.actor.unit.attachments?.vision : undefined
    let scope: RunScope<C>
    try {
      scope = await scopeFor(w)
    } catch (e) {
      if (!(e instanceof CapRefusal)) onError(e, 'start')
      w.refusal = { code: e instanceof CapRefusal ? `cap_${e.cap}` : 'start_failed', message: w.text.unread() }
      return []
    }
    try {
      let n = 0
      const attachment = atts.map((a) => {
        const head = `attachment ${a.id}, ${a.kind}${a.name ? `, ${a.name}` : ''}${a.image ? `, image ${++n}` : ''}`
        return a.text ? `${head}\n${a.text}` : head
      })
      const built = await scope.context({
        input: { known: knownOf(w, asked), message: text ?? '', attachment },
        ...(vision ? { images } : {}),
      })
      const r = await scope.structured<{ items: ExtractedItem[] }>(built, vision ? { role: vision } : {})
      if (!r.ok) {
        w.turn.note = 'invalid_output'
        w.notes.push(w.text.unread())
        return []
      }
      return r.output.items
    } catch (e) {
      const code = e instanceof CapRefusal ? `cap_${e.cap}` : ((e as { code?: string })?.code ?? 'error')
      if (!(e instanceof CapRefusal)) onError(e, 'extract')
      w.turn.note = code
      w.refusal = { code, message: w.text.unread() }
      return []
    }
  }

  /** The run stays open while the session is; it ends with the session (pending approval included: the submit is made). */
  async function finishWork(w: Work<C>) {
    if (isOpen(w.s)) return
    const outcome = runOutcomeOf(w.s)
    if (!w.scope) return endRun(ai.runs, w.s, outcome, iso(), onError)
    try {
      await w.scope.finish(outcome)
    } catch (e) {
      onError(e, 'finish')
    }
  }

  async function begin(ctx: C, id: string, kind: TurnRecord['kind']): Promise<Work<C>> {
    const { s: stored, entry } = await load(ctx, id)
    const s: ActorSession = structuredClone(stored)
    const turn: TurnRecord = { n: nextTurn(s), at: iso(), channel: ctx.channel, kind, state: s.state }
    return { ctx, actor: entry.actor, slots: entry.slots, s, text: textOf(s.language), turn, changes: [], notes: [] }
  }

  async function commit(w: Work<C>, expect: number | null, q: Question | null): Promise<ActorReply> {
    await finishWork(w)
    w.s.channel = w.ctx.channel
    w.s.updatedAt = iso()
    w.s.expiresAt = new Date(now() + w.actor.idleMs).toISOString()
    w.s.version = (expect ?? 0) + 1
    w.turn.state = w.s.state
    if (w.changes.length) w.turn.changes = w.changes
    if (q) w.turn.question = { slot: q.slot, kind: q.kind }
    pushTurn(w.s, w.turn)
    await save(w.s, expect)
    return replyOf(w, await phrased(w, q))
  }

  async function turn(w: Work<C>, input: ReplyInput): Promise<ActorReply> {
    const expect = w.s.version
    const asked = currentQuestion(w)
    if (w.s.state === 'confirm' && (input.text || input.attachments?.length || input.choose || input.affirm !== undefined)) {
      // Anything said on the card reopens it.
      w.s.state = 'collect'
      w.s.card = null
      w.s.confirmToken = undefined
    }
    const lang = w.s.language
    if (input.choose) {
      const sl = slotOf(w, input.choose.slot)
      const st = sl ? w.s.slots[sl.name] : undefined
      const pool = st?.choices ?? (sl?.choices ? [...sl.choices] : undefined)
      const c = pool?.find((x) => same(x.id, input.choose!.id) || String(x.id) === String(input.choose!.id))
      if (!sl || !c || sl.derive) w.notes.push(w.text.unread())
      else {
        const before = w.s.slots[sl.name]
        // A lookup's or a conflict's choice is already the value; a fixed choice is read like any value.
        const fromState = st?.choices?.includes(c) === true
        const value =
          sl.lookup || fromState
            ? c.id
            : (() => {
                const n = normalise(sl, c.id)
                return 'value' in n ? n.value : c.id
              })()
        noteChange(w, sl, before, c.label)
        setSlot(w, sl.name, { status: 'filled', value, display: sl.lookup || fromState ? c.label : display(sl, value, lang), query: st?.query, confidence: 1, source: 'person', evidence: st?.evidence, attachment: st?.attachment })
      }
    }
    if (input.affirm !== undefined) {
      const a = w.s.asking
      const st = a ? w.s.slots[a.slot] : undefined
      if (a && st && st.status === 'doubtful') {
        if (input.affirm) setSlot(w, a.slot, { ...st, status: 'filled', confidence: 1, source: st.source, checked: false })
        else setSlot(w, a.slot, { status: 'empty' })
      }
    }
    const atts = accept(w, input.attachments)
    if ((input.text && input.text.trim()) || atts.length) {
      const items = await extract(w, input.text?.slice(0, 20_000), atts, asked)
      applyItems(w, items, w.s.attachments)
    }
    const q = await decide(w)
    return commit(w, expect, q)
  }

  // ---------------------------------------------------------------- the surface

  const runtime: ActorRuntime<C> = {
    actors: opts.actors,
    actor: (id) => byId.get(id)?.actor,

    async start(ctx, actorId, input = {}) {
      const entry = byId.get(actorId)
      if (!entry) throw new ActorRefusal('unknown_actor', `No actor ${actorId}.`)
      const language = input.language ?? opts.language?.(ctx) ?? 'en'
      const at = iso()
      const s: ActorSession = {
        id: newId(),
        actor: entry.actor.id,
        actorVersion: entry.actor.version,
        target: entry.actor.target,
        tenant: ctx.tenant,
        person: ctx.principal.id,
        channel: ctx.channel,
        language,
        state: 'start',
        version: 0,
        slots: {},
        asking: null,
        card: null,
        attachments: [],
        runs: [],
        turns: [],
        createdAt: at,
        updatedAt: at,
        expiresAt: new Date(now() + entry.actor.idleMs).toISOString(),
      }
      const w: Work<C> = { ctx, actor: entry.actor, slots: entry.slots, s, text: textOf(language), turn: { n: 1, at, channel: ctx.channel, kind: 'start', state: 'start' }, changes: [], notes: [] }
      for (const [name, raw] of Object.entries(input.prefill ?? {})) {
        const sl = slotOf(w, name)
        if (!sl || sl.derive || raw === undefined) continue
        const n = sl.lookup ? { value: raw } : normalise(sl, raw)
        if ('value' in n) setSlot(w, name, { status: 'filled', value: n.value, display: display(sl, n.value, language), confidence: 1, source: 'prefill' })
      }
      w.s.state = 'collect'
      const atts = accept(w, input.attachments)
      if ((input.text && input.text.trim()) || atts.length) applyItems(w, await extract(w, input.text?.slice(0, 20_000), atts, null), w.s.attachments)
      const q = await decide(w)
      // A new session: written only when no other has the id.
      await finishWork(w)
      w.s.version = 1
      w.turn.state = w.s.state
      if (w.changes.length) w.turn.changes = w.changes
      if (q) w.turn.question = { slot: q.slot, kind: q.kind }
      w.s.turns = [w.turn]
      await save(w.s, null)
      return replyOf(w, await phrased(w, q))
    },

    async reply(ctx, id, input) {
      const w = await begin(ctx, id, input.choose ? 'choose' : input.affirm !== undefined && !input.text ? 'affirm' : 'reply')
      if (!isOpen(w.s)) return replyOf({ ...w, refusal: { code: 'closed', message: `This conversation is ${w.s.state.replace('_', ' ')}.` } }, null)
      return turn(w, input)
    },

    async confirm(ctx, id, cardId) {
      const w = await begin(ctx, id, 'confirm')
      const expect = w.s.version
      const card = w.s.card
      if (w.s.state !== 'confirm' || !card || card.id !== cardId) {
        // A card from before a change, or a session no longer on its card.
        return replyOf({ ...w, refusal: { code: 'stale_card', message: 'This card is out of date. Check the latest one.' } }, isOpen(w.s) ? currentQuestion(w) : null)
      }
      const callOpts = card.needs === 'confirm' && w.s.confirmToken ? { confirmToken: w.s.confirmToken } : undefined
      const out = await targetCall(w, card.input, callOpts)
      w.s.confirmToken = undefined
      switch (out.outcome) {
        case 'ok':
          w.s.state = 'done'
          w.s.outcome = 'ok'
          w.s.result = out.result
          w.s.card = card
          break
        case 'pending_approval':
          w.s.state = 'pending_approval'
          w.s.approval = { id: out.approval.id, decider: out.approval.decider, expiresAt: out.approval.expiresAt, ...(out.approval.reviewUrl ? { reviewUrl: out.approval.reviewUrl } : {}) }
          break
        case 'duplicate':
          w.s.state = 'done'
          w.s.outcome = 'ok'
          break
        case 'confirm_required':
        case 'stale': {
          // The token ran out or the record moved: a fresh card for the person to check again.
          w.refusal = { code: out.outcome, message: 'message' in out ? out.message : 'The confirm expired. Check the card again.' }
          const q = await decide(w)
          return commit(w, expect, q)
        }
        case 'invalid': {
          for (const i of ('issues' in out ? out.issues : undefined) ?? []) {
            const name = i.path.split('.')[0] ?? ''
            const st = w.s.slots[name]
            if (st && slotOf(w, name)) setSlot(w, name, { ...st, status: 'invalid', issue: i.message })
          }
          w.refusal = { code: 'invalid', message: out.message }
          const q = await decide(w)
          return commit(w, expect, q)
        }
        default:
          // Permission, switches, rate limits: the card stays; the person may try later or hand off.
          w.refusal = { code: String(out.code), message: out.message }
          w.s.card = null
          w.s.state = 'collect'
          {
            const q = await decide(w)
            return commit(w, expect, q)
          }
      }
      return commit(w, expect, null)
    },

    async handoff(ctx, id) {
      const w = await begin(ctx, id, 'handoff')
      if (!isOpen(w.s)) return replyOf({ ...w, refusal: { code: 'closed', message: `This conversation is ${w.s.state.replace('_', ' ')}.` } }, null)
      const expect = w.s.version
      w.s.state = 'handoff'
      w.s.card = null
      w.s.confirmToken = undefined
      w.s.asking = null
      return commit(w, expect, null)
    },

    async cancel(ctx, id) {
      const w = await begin(ctx, id, 'cancel')
      if (!isOpen(w.s)) return replyOf({ ...w, refusal: { code: 'closed', message: `This conversation is ${w.s.state.replace('_', ' ')}.` } }, null)
      const expect = w.s.version
      w.s.state = 'cancelled'
      w.s.card = null
      w.s.confirmToken = undefined
      w.s.asking = null
      return commit(w, expect, null)
    },

    async status(ctx, id) {
      const w = await begin(ctx, id, 'approval')
      if (w.s.state === 'pending_approval' && w.s.approval && opts.guard) {
        const row = await opts.guard.approval(w.s.approval.id)
        const st = row?.status
        if (st && st !== 'waiting' && st !== 'approved' && st !== 'running') {
          const expect = w.s.version
          w.s.state = 'done'
          w.s.outcome = st === 'executed' ? 'ok' : `approval_${st}`
          if (st === 'executed') w.s.result = row?.result
          return commit(w, expect, null)
        }
      }
      return replyOf(w, currentQuestion(w))
    },

    async resume(ctx, actorId) {
      const store = opts.drafts?.open ? opts.drafts : opts.sessions
      if (!store.open) return null
      const list = await store.open({ tenant: ctx.tenant, person: ctx.principal.id, ...(actorId ? { actor: actorId } : {}), limit: 5 })
      for (const s of list) {
        try {
          const r = await runtime.status(ctx, s.id)
          if (OPEN_STATES.includes(r.state)) return r
        } catch (e) {
          if (!(e instanceof ActorRefusal)) throw e
        }
      }
      return null
    },

    async session(ctx, id) {
      try {
        return (await load(ctx, id)).s
      } catch (e) {
        if (e instanceof ActorRefusal) return null
        throw e
      }
    },
  }
  return runtime
}




// ---------------------------------------------------------------- expiry

const nextTurn = (s: ActorSession) => (s.turns.at(-1)?.n ?? 0) + 1

/** The session, expired: nothing to confirm, nothing asked, one more turn. */
function expiredSession(s: ActorSession, at: string, channel: string, maxTurns: number): ActorSession {
  const turn: TurnRecord = { n: nextTurn(s), at, channel, kind: 'expire', state: 'expired' }
  return { ...s, state: 'expired', version: s.version + 1, updatedAt: at, card: null, confirmToken: undefined, asking: null, turns: [...s.turns, turn].slice(-maxTurns) }
}

const runOutcomeOf = (s: ActorSession): Exclude<RunOutcome, 'running'> => (s.state === 'cancelled' || s.state === 'expired' ? 'cancelled' : 'ok')

/** Closes the session's last run in the store, when it is still running. */
async function endRun(runs: RunStore | undefined, s: ActorSession, outcome: Exclude<RunOutcome, 'running'>, at: string, onError: (e: unknown, where: string) => void): Promise<void> {
  const last = s.runs.at(-1)
  if (!runs || !last) return
  try {
    const row = await runs.getRun(last.run)
    if (row?.outcome === 'running') await runs.updateRun(last.run, { outcome, endedAt: at })
  } catch (e) {
    onError(e, 'endRun')
  }
}

export interface ExpireIdleOptions {
  /** The run store, so each expired session's run is closed too. */
  runs?: RunStore
  /** Sessions read at most, oldest first. Default 100. */
  limit?: number
  /** Turns kept on a session, as the runtime's `maxTurns`. Default 50. */
  maxTurns?: number
  onError?: (err: unknown, where: string) => void
}

/**
 * Expires every open session whose idle time ran out before `now`, for a
 * product's cron. A session someone wrote to meanwhile is skipped (the
 * compare-and-swap refuses the write); the runtime expires it on its next
 * load if it is still idle. Run it again while `expired` equals the limit.
 */
export async function expireIdle(
  store: Pick<SqlSessionStore, 'idle' | 'put'>,
  now: number | Date = Date.now(),
  o: ExpireIdleOptions = {},
): Promise<{ expired: number; skipped: number }> {
  const at = new Date(now).toISOString()
  const onError = o.onError ?? ((e, where) => console.error(`actors: ${where}`, e))
  let expired = 0
  let skipped = 0
  for (const s of await store.idle(at, o.limit ?? 100)) {
    if (!OPEN_STATES.includes(s.state) || Date.parse(s.expiresAt) >= Date.parse(at)) {
      skipped++
      continue
    }
    const next = expiredSession(s, at, 'cron', o.maxTurns ?? 50)
    if (!(await store.put(next, s.version))) {
      skipped++
      continue
    }
    expired++
    await endRun(o.runs, next, 'cancelled', at, onError)
  }
  return { expired, skipped }
}

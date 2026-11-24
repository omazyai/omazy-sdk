// The copilot: an open conversation that answers from the product's data,
// hands the person to actors, starts workflows and proposes changes. Each
// turn is one run of the copilot unit. The model sees a core set of tools and
// a search tool that finds the rest. Every capability call goes through the
// guard, and the whole batch the model proposes is checked before any of it
// runs: a read paired with a change that needs a person does not run first.
// R2 becomes a consent card the person clicks, R3 and above an approval card
// with its review link, unless a standing grant covers that one R2.

import type { ActorRuntime } from '../actors/runtime.js'
import { actorToolSource, copilotActorStep } from '../actors/surfaces.js'
import type { ActorReply } from '../actors/types.js'
import type { Ai, RunCallOutcome, RunScope } from '../ai/ai.js'
import { CapRefusal } from '../ai/ai.js'
import { fence } from '../ai/context.js'
import type { AnyUnit } from '../ai/manifest.js'
import type { LongTermScope, ThreadKey, ThreadListQuery, ThreadPage } from '../ai/memory.js'
import type { BaseCtx, Preview } from '../capabilities/capability.js'
import type { Registry } from '../capabilities/registry.js'
import { type Tier, tierRank } from '../capabilities/tiers.js'
import type { CompleteResult, Message, ToolCall, ToolDefinition, ToolResult } from '../types.js'
import type { GrantUse, Grants, StandingGrant } from './grants.js'
import { type UiMessage, type UiWriter, uiResponse, uiWriter } from './stream.js'
import type { ApprovalEvent } from '../guard/types.js'
import { type ApprovalCard, type ApprovalCardStatus, type ConsentCard, type CopilotThread, type CopilotThreadStore, SETTLED_APPROVAL, type StoredCard, type ThreadEvent } from './threads.js'

// ---------------------------------------------------------------- options and results

/** The tool the model searches the rest of its tools with. */
export const SEARCH_TOOL = 'tool_search'
/** The tool the model proposes a long-term memory with, when the unit writes one. */
export const REMEMBER_TOOL = 'memory_propose'
/** The tool that hands the conversation to an actor. */
export const ACTOR_TOOL = 'actor_start'

/** Added to the unit's prompt on every copilot call, after the product's own text. */
export const COPILOT_RULES =
  'You act only through your tools. A change is done only when its tool result says status "ok". ' +
  'When a result says confirm_required, pending_approval, not_run or refused, say plainly that it is not done and who it waits for. ' +
  'Never say you did something you did not do. If you need a tool you do not have, call tool_search first.'

const THREAD_ID = /^[A-Za-z0-9_-]{1,64}$/
const SCREEN_NAME = /^[a-z][a-z0-9_./-]{0,63}$/
const RECORD_ID = /^[A-Za-z0-9_.:-]{1,128}$/

/** The screen the person is on, as the client may name it: a screen name and a record id, nothing else. */
export interface ScreenRef {
  name: string
  id?: string | null
}

export interface CopilotOptions<C extends BaseCtx> {
  ai: Ai<C>
  /** The registry the guard uses. */
  registry: Registry<C, any, any>
  /** A unit made with `copilotUnit`: its tools, highest tier, prompt, recipe and caps. */
  unit: AnyUnit
  threads: CopilotThreadStore
  /** The door whose capabilities tool search may find. Default: any the unit allows. */
  audience?: string
  /**
   * The tools the model gets up front: a number takes the first of the
   * unit's `tools.allow`, a list names them. Default 16. The rest are found
   * through `tool_search`, at most `limit` a search (default 5).
   */
  toolSearch?: { core?: number | readonly string[]; limit?: number }
  /** Standing grants, from `createGrants`. Without it every R2 is a card. */
  standingGrants?: Grants<C>
  /**
   * The screen context, rebuilt on the server from the screen name and the
   * record id. Whatever the client sends beside those two is ignored. Return
   * null for a screen you do not describe. The text is fenced as data.
   */
  surface?: (ctx: C, screen: string, id: string | null) => string | null | undefined | Promise<string | null | undefined>
  /**
   * Actors the model may hand the conversation to. The person's messages then
   * go to the actor until it closes. Default: the actors behind any
   * `actorTools` in the registry, so one registry serves an actor over MCP
   * and in the copilot. The registry's actor_start, actor_reply,
   * actor_status and actor_confirm are never shown to the copilot's model; it
   * hands off with its own actor_start.
   */
  actors?: { runtime: ActorRuntime<C> | (() => ActorRuntime<C>); ids?: readonly string[] }
  /** The prompt language for this person. Default the unit's first. */
  language?: (ctx: C) => string | undefined
  /** Variables for the prompt template. Never the person's message. */
  vars?: (ctx: C) => Record<string, unknown>
  /** Model calls in one turn. Default 6. */
  maxSteps?: number
  /** How long a turn may hold its thread, in ms. Default 120000. */
  lockMs?: number
  /** UI messages kept on a thread. Default 200. */
  maxMessages?: number
  /** Characters of one tool result the model reads. Default 8000. */
  maxResultChars?: number
  now?: () => number
  newId?: (kind: 'thread' | 'message' | 'card' | 'turn') => string
  onError?: (err: unknown, where: string) => void
}

export interface TurnInput {
  /** The thread id. A thread belongs to the ctx's tenant and person; another person's id opens their own thread of that name, never someone else's. */
  thread: string
  /** The person's message. */
  text: string
  screen?: ScreenRef | null
}

/** What happened to each call of a turn, from the code, not from the model. */
export interface CallOutcome {
  name: string
  toolCallId: string
  status: 'ok' | 'confirm_required' | 'pending_approval' | 'not_run' | 'refused' | 'handed_over' | 'proposed'
  card?: string
  message?: string
}

export interface TurnReport {
  runId: string | null
  outcome: 'ok' | 'refused_cap' | 'error' | 'actor'
  text: string
  calls: CallOutcome[]
  error?: string
}

export type TurnStart =
  | { ok: true; stream: ReadableStream<Uint8Array>; done: Promise<TurnReport> }
  | { ok: false; status: 400 | 409; code: 'bad_request' | 'busy'; message: string }

export type CardOutcome =
  | { outcome: 'confirmed'; card: ConsentCard; result: unknown }
  | { outcome: 'declined' | 'expired' | 'stale' | 'failed' | 'already_settled'; card: ConsentCard; message?: string }
  | { outcome: 'actor'; reply: ActorReply }
  | { outcome: 'not_found' | 'busy' }

export interface Copilot<C extends BaseCtx> {
  readonly unit: AnyUnit
  /** One turn. Takes the thread's lock, then streams the reply as a UI message stream. */
  turn(ctx: C, input: TurnInput): Promise<TurnStart>
  /** A turn from a `useChat` request: the chat id is the thread, the last user message is the text. */
  sse(req: Request, ctx: C, opts?: { waitUntil?: (p: Promise<unknown>) => void }): Promise<Response>
  /** The person's click on a consent card, or on an actor's card. The only way a carded R2 runs. */
  confirm(ctx: C, input: { thread: string; card: string }): Promise<CardOutcome>
  decline(ctx: C, input: { thread: string; card: string }): Promise<CardOutcome>
  /** What the person saw, to start `useChat` from (`messages`), the consent cards still waiting, and the approvals not yet settled. */
  history(ctx: C, thread: string): Promise<{ messages: UiMessage[]; waiting: ConsentCard[]; approvals: ApprovalCard[]; actor: CopilotThread['actor'] }>
  /**
   * The guard's approval events, for an approval this copilot asked for:
   * the card's status moves in the thread's history, and the next turn
   * shows the card again and tells the model. Give it to the guard as
   * `onApproval` (beside `flows.onApproval`, if you have one). Never throws.
   */
  onApproval(event: ApprovalEvent<C>): Promise<void>
  /**
   * The person's threads in this tenant, newest first, a page at a time,
   * from the ai kit's memory store. Null when the unit keeps no conversation
   * there (it does not read `conversation`, or the ai kit has no memory
   * store). Throws `RangeError` for a cursor the kit did not make.
   */
  listThreads(ctx: C, q?: ThreadListQuery): Promise<ThreadPage | null>
  /**
   * Routes `POST …/chat`, `GET …/threads` (`?limit=&cursor=`),
   * `GET …/threads/<id>`, `POST …/cards/<id>/confirm` and
   * `POST …/cards/<id>/decline` (body `{ thread }`). Null for any other path.
   */
  handle(req: Request, ctx: C, opts?: { waitUntil?: (p: Promise<unknown>) => void }): Promise<Response | null>
}

// ---------------------------------------------------------------- helpers

type Kind = 'read' | 'grant' | 'consent' | 'approval'

interface Planned {
  call: ToolCall
  args: unknown
  tier: Tier
  kind: Kind
  grant?: StandingGrant
  use?: GrantUse
}

interface ToolAnswer {
  status: CallOutcome['status']
  result?: unknown
  card?: string
  summary?: string
  decider?: string
  reviewUrl?: string
  message?: string
}

const publicCard = (c: StoredCard): ConsentCard => {
  const { runId: _r, toolCallId: _t, args: _a, token: _k, ...rest } = c
  return rest
}

const textOf = (m: UiMessage) =>
  m.parts
    .filter((p): p is { type: 'text'; text: string } => p.type === 'text')
    .map((p) => p.text)
    .join('')

function answerOf(out: RunCallOutcome): ToolAnswer {
  switch (out.outcome) {
    case 'ok':
      return { status: 'ok', result: out.result }
    case 'confirm_required':
      return { status: 'confirm_required', summary: out.preview.summary, message: 'Not done. A consent card is shown to the person; it runs only if they confirm it. Do not say it is done.' }
    case 'pending_approval':
      return {
        status: 'pending_approval',
        summary: out.approval.preview.summary,
        decider: out.approval.decider,
        ...(out.approval.reviewUrl ? { reviewUrl: out.approval.reviewUrl } : {}),
        message: `Not done. It waits for approval by ${out.approval.decider}. Do not say it is done.`,
      }
    default:
      return { status: 'refused', message: out.message }
  }
}

function screenOf(v: unknown): ScreenRef | null {
  if (!v || typeof v !== 'object') return null
  const o = v as { name?: unknown; id?: unknown }
  if (typeof o.name !== 'string' || !SCREEN_NAME.test(o.name)) return null
  const id = typeof o.id === 'string' && RECORD_ID.test(o.id) ? o.id : null
  return { name: o.name, id }
}

/** The text of the last user message of a `useChat` request. */
function lastUserText(messages: unknown): string | null {
  if (!Array.isArray(messages)) return null
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i] as { role?: unknown; parts?: unknown; content?: unknown }
    if (m?.role !== 'user') continue
    if (Array.isArray(m.parts)) {
      return m.parts
        .filter((p): p is { type: 'text'; text: string } => (p as { type?: unknown })?.type === 'text' && typeof (p as { text?: unknown }).text === 'string')
        .map((p) => p.text)
        .join('\n')
    }
    if (typeof m.content === 'string') return m.content
    return null
  }
  return null
}

const json = (v: unknown, status = 200) => new Response(JSON.stringify(v), { status, headers: { 'content-type': 'application/json' } })

/** The card status an approval event moves to. Null for `requested`, which the turn already shows. */
function approvalStatus(e: ApprovalEvent<any>): ApprovalCardStatus | null {
  switch (e.type) {
    case 'requested':
      return null
    case 'decided':
      return e.approval.status === 'refused' ? 'refused' : e.approval.status === 'approved' || e.approval.status === 'running' ? 'approved' : null
    default:
      return e.type
  }
}

// ---------------------------------------------------------------- createCopilot

export function createCopilot<C extends BaseCtx>(o: CopilotOptions<C>): Copilot<C> {
  const { ai, registry: reg, unit, threads } = o
  const now = o.now ?? Date.now
  const iso = (ms = now()) => new Date(ms).toISOString()
  const newId = o.newId ?? ((kind) => `${kind === 'message' ? 'msg' : kind}_${crypto.randomUUID().replace(/-/g, '')}`)
  const onError = o.onError ?? ((e, where) => console.error(`copilot: ${where}`, e))
  const maxSteps = o.maxSteps ?? 6
  const lockMs = o.lockMs ?? 120_000
  const maxMessages = o.maxMessages ?? 200
  const maxResult = o.maxResultChars ?? 8000
  const searchLimit = o.toolSearch?.limit ?? 5

  // The manifest, checked once.
  const problems: string[] = []
  if (unit.kind !== 'copilot') problems.push(`${unit.id} is a ${unit.kind}; createCopilot takes a unit made with copilotUnit`)
  if (!unit.context.untrusted?.includes('message')) problems.push(`${unit.id} must list "message" in context.untrusted: the person's message is fenced, never an instruction`)
  if (!unit.memory.read.includes('working')) problems.push(`${unit.id} must read working memory: that is how a turn learns what happened to its cards`)
  if (o.surface && !unit.context.layers.includes('surface')) problems.push(`${unit.id} must use the surface layer when createCopilot is given a surface`)
  // The actor tools a door serves (from actorTools) stay out of the model's
  // reach here: the copilot hands off with its own actor_start instead.
  const actorCaps = reg.list().filter((c) => actorToolSource(c) !== undefined)
  const hidden = new Set(actorCaps.map((c) => c.name))
  const fromRegistry = actorCaps.length ? actorToolSource<C>(actorCaps[0]) : undefined
  const allow = new Set((unit.tools?.allow ?? []).filter((n) => !hidden.has(n)))
  const maxRank = tierRank(unit.tools?.maxTier ?? 'R0')
  for (const name of allow) if (!reg.has(name)) problems.push(`${unit.id} allows ${name}, which is not in the registry`)
  for (const name of [SEARCH_TOOL, REMEMBER_TOOL, ACTOR_TOOL]) if (reg.has(name) && !hidden.has(name)) problems.push(`the registry has a capability named ${name}, which the copilot uses for its own tool`)
  const reads = unit.memory.read
  if (reads.includes('conversation') && !ai.memory) problems.push(`${unit.id} reads the conversation, and the ai kit has no memory store`)
  const remember = unit.memory.write.filter((s): s is LongTermScope => s === 'person' || s === 'tenant')
  if (remember.length && !ai.memory) problems.push(`${unit.id} writes long-term memory, and the ai kit has no memory store`)
  const coreOpt = o.toolSearch?.core ?? 16
  const coreNames = (typeof coreOpt === 'number' ? [...allow].slice(0, Math.max(0, coreOpt)) : [...coreOpt]).filter((n) => {
    if (!allow.has(n)) {
      problems.push(`toolSearch.core names ${n}, which ${unit.id} does not allow`)
      return false
    }
    return tierRank(reg.get(n)?.risk) <= maxRank
  })
  if (problems.length) throw new Error(`createCopilot: ${problems.join('; ')}`)

  const actorsFrom = o.actors ?? (fromRegistry ? { runtime: fromRegistry.runtime, ids: fromRegistry.actors } : undefined)
  const step = actorsFrom ? copilotActorStep(actorsFrom.runtime, actorsFrom.ids ? { actors: actorsFrom.ids } : {}) : undefined
  const reachable = (name: string) => !hidden.has(name) && allow.has(name) && tierRank(reg.get(name)?.risk) <= maxRank && (o.audience === undefined || (reg.get(name)?.audiences as readonly string[] | undefined)?.includes(o.audience) === true)

  const keyOf = (ctx: C, id: string): ThreadKey => ({ id, tenant: ctx.tenant, person: ctx.principal.id })
  const asCopilot = (ctx: C): C => ({ ...ctx, channel: 'copilot' })

  // ------------------------------------------------------------ the thread's lock

  async function lock(key: ThreadKey, turn: string): Promise<CopilotThread | null> {
    for (let i = 0; i < 3; i++) {
      const cur = await threads.get(key)
      const busy = { turn, until: now() + lockMs }
      if (!cur) {
        const fresh: CopilotThread = { key, version: 1, messages: [], cards: {}, approvals: {}, found: [], actor: null, events: [], busy, createdAt: iso(), updatedAt: iso() }
        if (await threads.put(fresh, null)) return fresh
        continue
      }
      if (cur.busy && cur.busy.until > now()) return null
      const next = { ...cur, version: cur.version + 1, busy, updatedAt: iso() }
      if (await threads.put(next, cur.version)) return next
    }
    return null
  }

  /** Writes the thread and lets it go. */
  async function release(t: CopilotThread): Promise<void> {
    const next: CopilotThread = { ...t, version: t.version + 1, busy: null, updatedAt: iso(), messages: t.messages.slice(-maxMessages) }
    // Settled cards older than a day are dropped.
    const cutoff = iso(now() - 86_400_000)
    for (const [id, c] of Object.entries(next.cards)) if (c.status !== 'waiting' && c.expiresAt < cutoff) delete next.cards[id]
    next.approvals = { ...(next.approvals ?? {}) }
    for (const [id, a] of Object.entries(next.approvals)) if (SETTLED_APPROVAL.includes(a.status) && (a.updatedAt ?? a.expiresAt) < cutoff) delete next.approvals[id]
    if (!(await threads.put(next, t.version))) onError(new Error(`thread ${t.key.id} was written by another turn`), 'release')
  }

  // ------------------------------------------------------------ one turn

  function toolList(loaded: Set<string>): ToolDefinition[] {
    const tools = reg.modelTools({ names: [...loaded] })
    if ([...allow].some((n) => !loaded.has(n) && reachable(n))) {
      tools.push({
        name: SEARCH_TOOL,
        description: 'Finds more of your tools by what the person wants to do. Give a few plain words, such as "add a staff member". Returns tool names you may then call.',
        input_schema: { type: 'object', properties: { query: { type: 'string', maxLength: 200 } }, required: ['query'], additionalProperties: false },
      })
    }
    if (step) tools.push(...step.tools())
    if (remember.length) {
      tools.push({
        name: REMEMBER_TOOL,
        description: 'Suggests a fact or preference worth remembering about this person or their organisation. It is kept only after the person confirms it. Never for a visitor\'s personal details.',
        input_schema: {
          type: 'object',
          properties: { scope: { type: 'string', enum: remember }, text: { type: 'string', maxLength: 500 } },
          required: ['scope', 'text'],
          additionalProperties: false,
        },
      })
    }
    return tools
  }

  const resultText = (name: string, a: ToolAnswer) => {
    let s = JSON.stringify(a)
    if (s.length > maxResult) s = `${s.slice(0, maxResult)} [cut for length]`
    return fence('data', `tool:${name}`, s)
  }

  async function runTurn(ctx: C, t: CopilotThread, input: { text: string; screen: ScreenRef | null }, w: UiWriter): Promise<TurnReport> {
    const calls: CallOutcome[] = []
    const events: ThreadEvent[] = t.events
    t.events = []
    // Approval cards that moved since the last turn show again, as they stand now.
    for (const id of new Set(events.map((e) => e.card).filter((c): c is string => !!c))) {
      const a = t.approvals?.[id]
      if (a) w.data('approval', a, id)
    }
    const report = (outcome: TurnReport['outcome'], runId: string | null, error?: string): TurnReport => ({ runId, outcome, text: textOf(w.message), calls, ...(error ? { error } : {}) })
    const remember_ = async (assistant: string) => {
      if (!ai.memory || !reads.includes('conversation')) return
      const turns: Message[] = [
        { role: 'user', content: input.text },
        { role: 'assistant', content: assistant || '(no reply)' },
      ]
      await ai.memory.store.appendTurns(t.key, turns, iso())
    }
    const outcomeLines = () =>
      calls.filter((c) => c.status !== 'ok' || !c.name.startsWith('tool_')).map((c) => `[${c.name}: ${c.status}${c.card ? `, card ${c.card}` : ''}]`)

    // An open actor takes the person's message, word for word.
    if (t.actor && step) {
      try {
        const r = await step.route(ctx, t.actor.session, { text: input.text })
        if (r) {
          showActor(w, r)
          if (!['start', 'collect', 'confirm'].includes(r.state)) t.actor = null
          await remember_(r.message)
          return report('actor', null)
        }
      } catch (e) {
        onError(e, 'actor route')
      }
      t.actor = null
    }

    let scope: RunScope<C> | undefined
    try {
      scope = await ai.start(ctx, unit, { language: o.language?.(ctx), vars: o.vars?.(ctx) ?? {} })
      const waiting = Object.values(t.cards).filter((c) => c.status === 'waiting')
      if (events.length) scope.working.since_last_turn = events.map((e) => e.text)
      const open = Object.values(t.approvals ?? {}).filter((a) => !SETTLED_APPROVAL.includes(a.status))
      if (waiting.length) scope.working.cards_waiting = waiting.map((c) => `${c.capability}: ${c.preview.summary} (card ${c.id})`)
      if (open.length) scope.working.approvals_open = open.map((a) => `${a.capability}: ${a.preview.summary} (approval ${a.id}, ${a.status === 'waiting' ? `waits for ${a.decider}` : 'approved, running'})`)

      let surface: string | undefined
      if (input.screen && o.surface) {
        const s = await o.surface(ctx, input.screen.name, input.screen.id ?? null)
        if (s) surface = `The person is on the ${input.screen.name} screen${input.screen.id ? `, record ${input.screen.id}` : ''}.\n${fence('data', 'screen', s)}`
      }
      const built = await scope.context({
        input: { message: input.text },
        ...(reads.includes('conversation') ? { thread: t.key } : {}),
        parts: { unit: `${scope.prompt.text}\n\n${COPILOT_RULES}`, ...(surface ? { surface } : {}) },
      })
      const messages: Message[] = built.messages.map((m) => ({ ...m }))
      const loaded = new Set<string>([...coreNames, ...t.found.filter(reachable)])
      let noTools = false

      for (let i = 0; i < maxSteps; i++) {
        // Tools stay listed (a model needs them to read earlier calls); after a held batch it may only answer in words.
        const tools = toolList(loaded)
        let result: CompleteResult | undefined
        let sawDelta = false
        for await (const ev of scope.stream({ system: built.system, messages, ...(tools.length ? { tools, tool_choice: noTools ? ('none' as const) : ('auto' as const) } : {}) })) {
          if (ev.type === 'delta') {
            sawDelta = true
            w.text(ev.text)
          } else {
            result = ev.result
            // A reply that came whole (a cache hit) still shows.
            if (!sawDelta && ev.result.text) w.text(ev.result.text)
          }
        }
        const toolCalls = result?.tool_calls ?? []
        // A call asked for when tools were closed never runs.
        if (!toolCalls.length || noTools) break
        messages.push({ role: 'assistant', content: result?.text ?? '', tool_calls: toolCalls })
        const b = await batch(ctx, scope, t, toolCalls, loaded, input.text, w, calls)
        messages.push({ role: 'user', content: '', tool_results: b.results })
        if (b.handedOver) break
        if (b.held) noTools = true
        // The last step answers in words: no tools.
        if (i === maxSteps - 2) noTools = true
      }
      await scope.finish('ok')
      await remember_([textOf(w.message), ...outcomeLines()].filter(Boolean).join('\n'))
      return report('ok', scope.id)
    } catch (e) {
      if (e instanceof CapRefusal) {
        w.error('The AI spend limit is reached for now. Nothing more was done.')
        await scope?.finish('refused_cap', { code: `cap_${e.cap}`, message: e.message })
        return report('refused_cap', scope?.id ?? e.runId ?? null, e.message)
      }
      onError(e, 'turn')
      w.error('The copilot could not finish this answer. Nothing else was done.')
      await scope?.finish('error', { code: 'error', message: (e as Error)?.message ?? String(e) }).catch(() => {})
      return report('error', scope?.id ?? null, (e as Error)?.message ?? String(e))
    }
  }

  function showActor(w: UiWriter, r: ActorReply) {
    w.text(r.message)
    w.data(
      'actor',
      {
        session: r.session,
        actor: r.actor,
        state: r.state,
        ...(r.question ? { question: r.question } : {}),
        ...(r.card ? { card: { id: r.card.id, title: r.card.title, summary: r.card.summary, rows: r.card.rows, needs: r.card.needs, tier: r.card.tier } } : {}),
        ...(r.approval ? { approval: r.approval } : {}),
        ...(r.handoff ? { handoff: r.handoff } : {}),
      },
      r.session,
    )
  }

  /** Gives back the grant runs held for calls that did not run. */
  async function giveBack(plan: Planned[]): Promise<void> {
    for (const p of plan) {
      if (!p.use) continue
      const use = p.use
      delete p.use
      await o.standingGrants!.release(use).catch((e) => onError(e, 'grant release'))
    }
  }

  /** One batch of tool calls: checked whole, then run, or held for the person. */
  async function batch(
    ctx: C,
    scope: RunScope<C>,
    t: CopilotThread,
    toolCalls: readonly ToolCall[],
    loaded: Set<string>,
    personText: string,
    w: UiWriter,
    calls: CallOutcome[],
  ): Promise<{ results: ToolResult[]; held: boolean; handedOver: boolean }> {
    const answers = new Map<string, { name: string; a: ToolAnswer }>()
    const set = (c: ToolCall, a: ToolAnswer) => answers.set(c.id, { name: c.name, a })
    const finish = (held: boolean, handedOver: boolean) => {
      const results: ToolResult[] = []
      for (const c of toolCalls) {
        const got = answers.get(c.id) ?? { name: c.name, a: { status: 'not_run' as const, message: 'Not run.' } }
        w.tool(c.id, c.name, c.input, got.a)
        calls.push({ name: c.name, toolCallId: c.id, status: got.a.status, ...(got.a.card ? { card: got.a.card } : {}), ...(got.a.message ? { message: got.a.message } : {}) })
        results.push({ call_id: c.id, content: resultText(c.name, got.a), ...(got.a.status === 'refused' ? { is_error: true } : {}) })
      }
      return { results, held, handedOver }
    }

    // A hand-off to an actor ends the batch: nothing else in it runs.
    const handoff = step ? toolCalls.find((c) => c.name === ACTOR_TOOL) : undefined
    if (handoff && step) {
      for (const c of toolCalls) if (c !== handoff) set(c, { status: 'not_run', message: 'Not run: the conversation was handed to a guided form.' })
      const r = await step.start(ctx, handoff, { text: personText })
      if (!r) {
        set(handoff, { status: 'refused', message: 'There is no such guided form.' })
        return finish(false, false)
      }
      if (['start', 'collect', 'confirm'].includes(r.state)) t.actor = { session: r.session, actor: r.actor }
      set(handoff, { status: 'handed_over', message: 'The guided form now talks to the person. Do not answer for it.' })
      const out = finish(false, true)
      showActor(w, r)
      return out
    }

    // The kit's own tools touch no product data: search and a memory proposal.
    const caps: ToolCall[] = []
    for (const c of toolCalls) {
      if (c.name === SEARCH_TOOL) {
        const q = String((c.input as { query?: unknown } | null)?.query ?? '').slice(0, 200)
        const hits = reg
          .search(q, { limit: searchLimit + loaded.size, exclude: [...loaded], ...(o.audience !== undefined ? { audience: o.audience } : {}) })
          .filter((h) => reachable(h.name))
          .slice(0, searchLimit)
        for (const h of hits) {
          loaded.add(h.name)
          if (!t.found.includes(h.name)) t.found = [...t.found, h.name].slice(-32)
        }
        set(c, { status: 'ok', result: { tools: hits.map((h) => ({ name: h.name, description: reg.describe(h.name) })) } })
      } else if (c.name === REMEMBER_TOOL && remember.length) {
        const i = (c.input ?? {}) as { scope?: unknown; text?: unknown }
        const s = remember.find((x) => x === i.scope)
        const text = typeof i.text === 'string' ? i.text.trim().slice(0, 500) : ''
        if (!s || !text) {
          set(c, { status: 'refused', message: `Give a scope (${remember.join(' or ')}) and the text.` })
          continue
        }
        const row = await scope.propose(s, text)
        w.data('memory', { id: row.id, scope: row.scope, text: row.text, status: row.status }, row.id)
        set(c, { status: 'proposed', message: 'Kept as a suggestion. It is remembered only after the person confirms it.' })
      } else caps.push(c)
    }
    if (!caps.length) return finish(false, false)

    // The whole batch, checked before any of it runs.
    const plan: Planned[] = []
    const refused: { c: ToolCall; message: string }[] = []
    for (const c of caps) {
      if (!loaded.has(c.name)) {
        refused.push({ c, message: `${c.name} is not one of your tools now.${reachable(c.name) ? ' Find it with tool_search first.' : ''}` })
        continue
      }
      const p = await reg.parse(c.name, c.input)
      if (!p.ok) {
        refused.push({ c, message: `The arguments for ${c.name} are not valid: ${p.issues.map((x) => `${x.path || '(root)'} ${x.message}`).join('; ')}` })
        continue
      }
      if (tierRank(p.tier) > maxRank) {
        refused.push({ c, message: `${c.name} with these arguments is ${p.tier}, above what this copilot may propose.` })
        continue
      }
      const kind: Kind = tierRank(p.tier) <= 1 ? 'read' : p.tier === 'R2' ? 'consent' : 'approval'
      plan.push({ call: c, args: c.input, tier: p.tier, kind })
    }
    if (refused.length) {
      for (const r of refused) set(r.c, { status: 'refused', message: `${r.message} Nothing in this batch ran.` })
      for (const p of plan) set(p.call, { status: 'not_run', message: 'Not run: another call in the same batch was refused, so none of them ran.' })
      return finish(false, false)
    }

    // Standing grants: checked against today's cap before anything runs.
    if (o.standingGrants) {
      const counted = new Map<string, number>()
      for (const p of plan) {
        if (p.kind !== 'consent') continue
        const g = await o.standingGrants.covering(ctx, p.call.name, p.tier)
        if (!g) continue
        const n = counted.get(g.id) ?? 0
        if (n < (await o.standingGrants.left(g))) {
          p.kind = 'grant'
          p.grant = g
          counted.set(g.id, n + 1)
        }
      }
    }
    let holds = plan.some((p) => p.kind === 'consent' || p.kind === 'approval')
    if (!holds) {
      // Each granted run is held before the calls, so another turn at the same time cannot pass the cap.
      for (const p of plan) {
        if (p.kind !== 'grant') continue
        const use = await o.standingGrants!.take(p.grant!)
        if (use) p.use = use
        else {
          p.kind = 'consent'
          holds = true
        }
      }
      if (holds) await giveBack(plan)
    }

    if (!holds) {
      // A granted run counts only when the guard ran it: a refusal, or a call that never got that far, is given back.
      try {
        for (const p of plan) {
          const out = await scope.call(p.call.name, p.args, p.kind === 'grant' ? { confirm: 'upstream' } : undefined)
          if (out.outcome === 'ok') delete p.use
          set(p.call, answerOf(out))
        }
      } finally {
        await giveBack(plan)
      }
      return finish(false, false)
    }

    // Held: nothing runs now. Reads wait with the change they came with.
    for (const p of plan) {
      if (p.kind === 'read' || p.kind === 'grant') set(p.call, { status: 'not_run', message: 'Not run: this batch waits for the person, so none of it ran yet. Ask again after they decide.' })
    }
    const minted: { p: Planned; out: Extract<RunCallOutcome, { outcome: 'confirm_required' }> }[] = []
    let stopped: string | null = null
    for (const p of plan.filter((x) => x.kind === 'consent')) {
      const out = await scope.call(p.call.name, p.args)
      if (out.outcome === 'confirm_required') minted.push({ p, out })
      else {
        set(p.call, answerOf(out))
        stopped ??= `${p.call.name} was refused`
      }
    }
    const asked: { p: Planned; out: Extract<RunCallOutcome, { outcome: 'pending_approval' }> }[] = []
    if (!stopped) {
      for (const p of plan.filter((x) => x.kind === 'approval')) {
        const out = await scope.call(p.call.name, p.args)
        if (out.outcome === 'pending_approval') asked.push({ p, out })
        else {
          set(p.call, answerOf(out))
          stopped = `${p.call.name} was refused`
          break
        }
      }
    }
    if (stopped) {
      // No card is shown and no approval left waiting when part of the batch was refused.
      const notRun = `Not run: ${stopped}, so nothing in this batch was put to the person.`
      for (const m of minted) set(m.p.call, { status: 'not_run', message: notRun })
      for (const a of asked) {
        const w_ = await ai.guard?.withdraw(a.out.approval.id, ctx, `Withdrawn by the copilot: ${stopped} in the same batch.`).catch((e) => {
          onError(e, 'withdraw')
          return undefined
        })
        if (w_?.outcome !== 'withdrawn') onError(new Error(`approval ${a.out.approval.id} was not withdrawn: ${w_?.outcome ?? 'no guard'}`), 'withdraw')
        set(a.p.call, { status: 'not_run', message: `${notRun} Its approval request was withdrawn.` })
      }
      for (const p of plan.filter((x) => x.kind === 'approval')) if (!answers.has(p.call.id)) set(p.call, { status: 'not_run', message: notRun })
      return finish(true, false)
    }
    const cards: StoredCard[] = []
    for (const { p, out } of minted) {
      const card: StoredCard = {
        kind: 'consent',
        id: newId('card'),
        capability: p.call.name,
        title: reg.get(p.call.name)?.title ?? p.call.name,
        tier: p.tier,
        preview: out.preview,
        input: p.args,
        expiresAt: out.expiresAt,
        status: 'waiting',
        runId: scope.id,
        toolCallId: p.call.id,
        args: p.args,
        token: out.token,
      }
      t.cards[card.id] = card
      cards.push(card)
      set(p.call, { status: 'confirm_required', card: card.id, summary: out.preview.summary, message: 'Not done. A consent card is shown to the person; it runs only if they confirm it. Do not say it is done.' })
    }
    const approvals: ApprovalCard[] = []
    for (const { p, out } of asked) {
      const a = answerOf(out)
      approvals.push({
        kind: 'approval',
        id: out.approval.id,
        capability: p.call.name,
        title: reg.get(p.call.name)?.title ?? p.call.name,
        tier: p.tier,
        preview: out.approval.preview as Preview,
        decider: out.approval.decider,
        expiresAt: out.approval.expiresAt,
        ...(out.approval.reviewUrl ? { reviewUrl: out.approval.reviewUrl } : {}),
        status: 'waiting',
      })
      a.card = out.approval.id
      set(p.call, a)
    }
    for (const a of approvals) {
      t.approvals = { ...(t.approvals ?? {}), [a.id]: a }
      // The guard's events name the approval, not the thread: link them.
      await threads.link(a.id, t.key).catch((e) => onError(e, 'approval link'))
    }
    const res = finish(true, false)
    for (const c of cards) w.data('consent', publicCard(c), c.id)
    for (const a of approvals) w.data('approval', a, a.id)
    return res
  }

  // ------------------------------------------------------------ cards

  async function settle(ctx0: C, input: { thread: string; card: string }, decline: boolean): Promise<CardOutcome> {
    if (!THREAD_ID.test(input.thread) || typeof input.card !== 'string' || input.card.length > 200) return { outcome: 'not_found' }
    const ctx = asCopilot(ctx0)
    const key = keyOf(ctx, input.thread)
    const t = await lock(key, newId('turn'))
    if (!t) return (await threads.get(key)) ? { outcome: 'busy' } : { outcome: 'not_found' }
    try {
      const card = t.cards[input.card]
      if (!card) {
        // An actor's card: the actor runtime holds it.
        if (t.actor && actorsFrom) {
          const rt = typeof actorsFrom.runtime === 'function' ? actorsFrom.runtime() : actorsFrom.runtime
          const reply = decline ? await rt.cancel(ctx, t.actor.session) : await rt.confirm(ctx, t.actor.session, input.card)
          if (!['start', 'collect', 'confirm'].includes(reply.state)) t.actor = null
          t.events.push({ at: iso(), text: `The guided form ${reply.actor} is ${reply.state}: ${reply.message}` })
          return { outcome: 'actor', reply }
        }
        return { outcome: 'not_found' }
      }
      if (card.status !== 'waiting') return { outcome: 'already_settled', card: publicCard(card) }
      const mark = (status: StoredCard['status'], extra: Partial<StoredCard>, text: string) => {
        Object.assign(card, { status, ...extra })
        t.events.push({ at: iso(), text })
        // The card in the message the person saw shows its outcome too.
        for (const m of t.messages) {
          for (let i = 0; i < m.parts.length; i++) {
            const part = m.parts[i] as { type: string; id?: string }
            if (part.type === 'data-consent' && part.id === card.id) m.parts[i] = { type: 'data-consent', id: card.id, data: publicCard(card) }
          }
        }
      }
      if (decline) {
        mark('declined', { token: '' }, `${card.capability}: the person declined the card (${card.preview.summary}). It did not run.`)
        return { outcome: 'declined', card: publicCard(card) }
      }
      if (card.expiresAt <= iso()) {
        mark('expired', { token: '' }, `${card.capability}: the card expired before the person confirmed it. It did not run.`)
        return { outcome: 'expired', card: publicCard(card) }
      }
      const out = await ai.callInRun(ctx, unit, card.runId, card.capability, card.args, { confirmToken: card.token })
      if (out.outcome === 'ok') {
        mark('confirmed', { token: '', result: out.result }, `${card.capability}: the person confirmed the card and it ran (${card.preview.summary}).`)
        return { outcome: 'confirmed', card: publicCard(card), result: out.result }
      }
      const message = 'message' in out ? out.message : `It did not run (${out.outcome}).`
      const status = out.outcome === 'stale' ? 'stale' : 'code' in out && String(out.code).startsWith('confirm_') && out.code !== 'confirm_mismatch' ? 'expired' : 'failed'
      mark(status, { token: '', message }, `${card.capability}: the person confirmed the card, and it did not run: ${message}`)
      return { outcome: status, card: publicCard(card), message }
    } finally {
      await release(t)
    }
  }

  // ------------------------------------------------------------ the copilot

  const copilot: Copilot<C> = {
    unit,

    async turn(ctx0, input) {
      if (typeof input.thread !== 'string' || !THREAD_ID.test(input.thread)) return { ok: false, status: 400, code: 'bad_request', message: 'The thread id must be 1 to 64 letters, digits, - or _.' }
      const text = typeof input.text === 'string' ? input.text.trim() : ''
      if (!text) return { ok: false, status: 400, code: 'bad_request', message: 'The message is empty.' }
      const ctx = asCopilot(ctx0)
      const t = await lock(keyOf(ctx, input.thread), newId('turn'))
      if (!t) return { ok: false, status: 409, code: 'busy', message: 'This thread is answering another message. Try again in a moment.' }
      const w = uiWriter(newId('message'))
      const userMessage: UiMessage = { id: newId('message'), role: 'user', parts: [{ type: 'text', text }] }
      const done = (async () => {
        let r: TurnReport
        try {
          r = await runTurn(ctx, t, { text, screen: input.screen ? screenOf(input.screen) : null }, w)
        } catch (e) {
          onError(e, 'turn')
          r = { runId: null, outcome: 'error', text: '', calls: [], error: String(e) }
        }
        try {
          w.message.metadata = { runId: r.runId, outcome: r.outcome }
          t.messages.push(userMessage, structuredClone(w.message))
          await release(t)
        } catch (e) {
          onError(e, 'save')
        }
        w.close(r.outcome === 'error' ? 'error' : 'stop')
        return r
      })()
      return { ok: true, stream: w.stream, done }
    },

    async sse(req, ctx, opts = {}) {
      let body: Record<string, unknown>
      try {
        body = (await req.json()) as Record<string, unknown>
      } catch {
        return json({ error: { code: 'bad_request', message: 'The body must be JSON.' } }, 400)
      }
      if (body.trigger !== undefined && body.trigger !== 'submit-message') {
        return json({ error: { code: 'bad_request', message: 'Only a new message is taken; regenerating is not supported.' } }, 400)
      }
      const thread = typeof body.id === 'string' ? body.id : typeof body.thread === 'string' ? body.thread : ''
      // Only the last user message is read. The history is the server's, never the client's.
      const text = lastUserText(body.messages) ?? (typeof body.text === 'string' ? body.text : '')
      const r = await copilot.turn(ctx, { thread, text, screen: screenOf(body.screen) })
      if (!r.ok) return json({ error: { code: r.code, message: r.message } }, r.status)
      opts.waitUntil?.(r.done)
      return uiResponse(r.stream)
    },

    confirm: (ctx, input) => settle(ctx, input, false),
    decline: (ctx, input) => settle(ctx, input, true),

    async history(ctx, thread) {
      if (!THREAD_ID.test(thread)) return { messages: [], waiting: [], approvals: [], actor: null }
      const t = await threads.get(keyOf(ctx, thread))
      if (!t) return { messages: [], waiting: [], approvals: [], actor: null }
      return {
        messages: t.messages,
        waiting: Object.values(t.cards).filter((c) => c.status === 'waiting').map(publicCard),
        approvals: Object.values(t.approvals ?? {}).filter((a) => !SETTLED_APPROVAL.includes(a.status)),
        actor: t.actor,
      }
    },

    async onApproval(event) {
      try {
        const status = approvalStatus(event)
        if (!status) return
        const row = event.approval
        const key = await threads.linked(row.id)
        // Only the thread of the person who asked, in their tenant.
        if (!key || key.person !== row.requester.id || key.tenant !== row.tenant) return
        const message = status === 'refused' || status === 'withdrawn' ? (row.reason ?? undefined) : status === 'failed' ? (row.error ?? undefined) : undefined
        await threads.approval(key, { id: row.id, status, at: iso(), ...(message ? { message } : {}) })
      } catch (e) {
        onError(e, 'onApproval')
      }
    },

    async listThreads(ctx, q) {
      if (!ai.memory || !reads.includes('conversation')) return null
      return ai.memory.store.listThreads({ tenant: ctx.tenant, person: ctx.principal.id }, q)
    },

    async handle(req, ctx, opts = {}) {
      const url = new URL(req.url)
      const path = url.pathname
      if (req.method === 'POST' && path.endsWith('/chat')) return copilot.sse(req, ctx, opts)
      if (req.method === 'GET' && path.endsWith('/threads')) {
        const limit = url.searchParams.get('limit')
        const cursor = url.searchParams.get('cursor')
        if (limit !== null && !/^\d{1,3}$/.test(limit)) return json({ error: { code: 'bad_request', message: 'limit is a number from 1 to 100.' } }, 400)
        try {
          const page = await copilot.listThreads(ctx, { ...(limit !== null ? { limit: Number(limit) } : {}), ...(cursor ? { cursor } : {}) })
          if (!page) return json({ error: { code: 'not_found', message: 'This copilot keeps no list of threads.' } }, 404)
          return json(page)
        } catch (e) {
          if (e instanceof RangeError) return json({ error: { code: 'bad_request', message: e.message } }, 400)
          throw e
        }
      }
      const th = path.match(/\/threads\/([A-Za-z0-9_-]{1,64})$/)
      if (req.method === 'GET' && th) return json(await copilot.history(ctx, th[1]!))
      const card = path.match(/\/cards\/([A-Za-z0-9_.:-]{1,200})\/(confirm|decline)$/)
      if (req.method === 'POST' && card) {
        const body = (await req.json().catch(() => ({}))) as { thread?: unknown }
        const input = { thread: typeof body.thread === 'string' ? body.thread : '', card: card[1]! }
        const out = card[2] === 'confirm' ? await copilot.confirm(ctx, input) : await copilot.decline(ctx, input)
        return json(out, out.outcome === 'not_found' ? 404 : out.outcome === 'busy' ? 409 : 200)
      }
      return null
    },
  }
  return copilot
}

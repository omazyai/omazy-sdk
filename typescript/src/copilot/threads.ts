// Where a copilot thread lives: what the person saw (the UI messages), the
// cards still waiting for them, the actor the conversation is handed to, and
// a lock so two turns of one thread never run at once. One thread belongs to
// one tenant and one person; every read and write names both.
//
// - `memoryThreadStore`: tests, and a single process.
// - `durableObjectThreads` and `CopilotThreadObject`: one Durable Object per
//   thread on Cloudflare Workers.
//
// The conversation the model reads (turns and summary) is the ai kit's
// thread, in its memory store (`d1MemoryStore` keeps it in D1, keyed by
// tenant, person and id). This store holds the rest. A thread id is the
// person's own: two people who pick the same id have two threads here, two
// Durable Objects, and two conversations there.
//
// An approval card's status comes from the guard's `onApproval` events,
// which know the approval and not the thread: the store links an approval
// to its thread, and applies an update at once when no turn holds the
// thread, or when the turn that holds it lets it go.

import type { Preview } from '../capabilities/capability.js'
import type { Tier } from '../capabilities/tiers.js'
import type { ThreadKey } from '../ai/memory.js'
import type { DurableObjectNamespaceLike, DurableStorageLike } from '../actors/stores.js'
import type { UiMessage } from './stream.js'

export type CardStatus = 'waiting' | 'confirmed' | 'declined' | 'expired' | 'failed' | 'stale'

/** A consent card for one R2 call, as the person sees it. */
export interface ConsentCard {
  kind: 'consent'
  id: string
  capability: string
  title: string
  tier: Tier
  /** The guard's preview: what would change, in a sentence, with before and after. */
  preview: Preview
  /** The arguments, as the guard will get them. Shown on the card. */
  input: unknown
  expiresAt: string
  status: CardStatus
  /** What happened when the person clicked: the result, or why it did not run. */
  result?: unknown
  message?: string
}

/** Where an approval stands, as its card shows it. */
export type ApprovalCardStatus = 'waiting' | 'approved' | 'refused' | 'executed' | 'failed' | 'stale' | 'expired' | 'withdrawn'

/** Statuses an approval card never leaves. */
export const SETTLED_APPROVAL: readonly ApprovalCardStatus[] = ['refused', 'executed', 'failed', 'stale', 'expired', 'withdrawn']

/** An approval card for one R3 or R4 call: who decides and where. */
export interface ApprovalCard {
  kind: 'approval'
  /** The approval id. */
  id: string
  capability: string
  title: string
  tier: Tier
  preview: Preview
  decider: string
  expiresAt: string
  reviewUrl?: string
  /** `approved` while the approved change runs; then `executed`, `failed` or `stale`. */
  status: ApprovalCardStatus
  /** Why it was refused or withdrawn, or the code it failed with. */
  message?: string
  /** When the status last changed. */
  updatedAt?: string
}

/** A new status for an approval card, from the guard's `onApproval`. */
export interface ApprovalUpdate {
  id: string
  status: ApprovalCardStatus
  at: string
  message?: string
}

/** A consent card as the thread stores it: with the run it belongs to and the guard's token, never sent to a client or a model. */
export interface StoredCard extends ConsentCard {
  runId: string
  toolCallId: string
  args: unknown
  token: string
}

/** Something that happened between turns, for the next turn's working memory. */
export interface ThreadEvent {
  at: string
  text: string
  /** The approval card it is about, shown again on the next turn's stream. */
  card?: string
}

export interface CopilotThread {
  key: ThreadKey
  /** Raised on every write; a write from an older version is refused. */
  version: number
  messages: UiMessage[]
  /** Waiting and settled consent cards, by id. Settled ones are kept for a while so a second click reads the outcome. */
  cards: Record<string, StoredCard>
  /** Approval cards by approval id, kept as the guard's events move them. */
  approvals: Record<string, ApprovalCard>
  /** Tools found by search in earlier turns, kept so the model can use them again. */
  found: string[]
  /** The actor this conversation is handed to, until its session closes. */
  actor: { session: string; actor: string } | null
  /** Card outcomes and other news since the last turn. Cleared when a turn reads them. */
  events: ThreadEvent[]
  /** The turn that holds the thread, and until when (epoch ms). */
  busy: { turn: string; until: number } | null
  createdAt: string
  updatedAt: string
}

export interface CopilotThreadStore {
  /** The thread when it belongs to this tenant and person; null otherwise. */
  get(key: ThreadKey): Promise<CopilotThread | null>
  /**
   * Writes when the stored version is `expect` (null: only when there is
   * none). False when another writer got there first. A write that lets the
   * thread go (`busy` null) applies the approval updates that came in while
   * it was held.
   */
  put(thread: CopilotThread, expect: number | null): Promise<boolean>
  /** Records which thread asked for an approval. */
  link(approvalId: string, key: ThreadKey): Promise<void>
  /** The thread that asked for an approval, or null. */
  linked(approvalId: string): Promise<ThreadKey | null>
  /**
   * Moves an approval card: at once when no turn holds the thread, else when
   * the turn that holds it writes it back. Nothing when there is no thread.
   */
  approval(key: ThreadKey, update: ApprovalUpdate): Promise<void>
}

/**
 * Applies an approval's new status to its card, to the card in the message
 * the person saw, and to the events the next turn reads. False when there
 * is no such card or the card already moved past it: a settled card never
 * changes, and `approved` never follows a later status.
 */
export function applyApprovalUpdate(t: CopilotThread, u: ApprovalUpdate): boolean {
  const card = t.approvals?.[u.id]
  if (!card || card.status === u.status || SETTLED_APPROVAL.includes(card.status)) return false
  if (u.status === 'waiting') return false
  Object.assign(card, { status: u.status, updatedAt: u.at, ...(u.message ? { message: u.message.slice(0, 500) } : {}) })
  for (const m of t.messages) {
    for (let i = 0; i < m.parts.length; i++) {
      const part = m.parts[i] as { type: string; id?: string }
      if (part.type === 'data-approval' && part.id === card.id) m.parts[i] = { type: 'data-approval', id: card.id, data: structuredClone(card) }
    }
  }
  const words: Record<ApprovalCardStatus, string> = {
    waiting: 'waits for approval',
    approved: 'was approved and is running',
    refused: 'was refused by the approver. It did not run',
    executed: 'was approved and ran',
    failed: 'was approved and failed when it ran',
    stale: 'was approved, and did not run because the record changed after the request',
    expired: 'expired before anyone decided. It did not run',
    withdrawn: 'was withdrawn. It did not run',
  }
  t.events = [...(t.events ?? []), { at: u.at, text: `${card.capability}: the approval request ${words[u.status]} (${card.preview.summary}).${u.message ? ` ${u.message.slice(0, 200)}` : ''}`, card: card.id }]
  return true
}

const free = (t: CopilotThread, now: number) => !t.busy || t.busy.until <= now

const clone = <T>(v: T): T => structuredClone(v)
const sameOwner = (a: ThreadKey, b: ThreadKey) => a.id === b.id && a.tenant === b.tenant && a.person === b.person

/** The name a thread's Durable Object is found by: its tenant, its person and its id. */
export const threadObjectName = (key: ThreadKey): string => JSON.stringify(['copilot', key.tenant, key.person, key.id])

/** The name an approval's link is found by. */
export const approvalObjectName = (approvalId: string): string => JSON.stringify(['copilot-approval', approvalId])

export function memoryThreadStore(o: { now?: () => number } = {}): CopilotThreadStore & { readonly size: number } {
  const now = o.now ?? Date.now
  const rows = new Map<string, CopilotThread>()
  const pending = new Map<string, ApprovalUpdate[]>()
  const links = new Map<string, ThreadKey>()
  return {
    get size() {
      return rows.size
    },
    async get(key) {
      const t = rows.get(threadObjectName(key))
      return t && sameOwner(t.key, key) ? clone(t) : null
    },
    async put(t, expect) {
      const name = threadObjectName(t.key)
      const cur = rows.get(name)
      if (expect === null ? cur !== undefined : cur?.version !== expect) return false
      const next = clone(t)
      if (!next.busy) {
        for (const u of pending.get(name) ?? []) applyApprovalUpdate(next, u)
        pending.delete(name)
      }
      rows.set(name, next)
      return true
    },
    async link(id, key) {
      links.set(id, { ...key })
    },
    async linked(id) {
      const k = links.get(id)
      return k ? { ...k } : null
    },
    async approval(key, u) {
      const name = threadObjectName(key)
      const cur = rows.get(name)
      if (!cur || !sameOwner(cur.key, key)) return
      if (!free(cur, now())) {
        pending.set(name, [...(pending.get(name) ?? []), clone(u)])
        return
      }
      if (applyApprovalUpdate(cur, u)) cur.version += 1
    },
  }
}

// ---------------------------------------------------------------- Durable Objects

const KEY = 'thread'
const PENDING = 'pending'
const LINK = 'link'

/**
 * The Durable Object class for one copilot thread. Export it from the Worker
 * and bind it, then give `durableObjectThreads(env.COPILOT_THREADS)` to
 * `createCopilot`. The object refuses a read or write that names another
 * tenant or person than the thread's.
 *
 * ```ts
 * export class CopilotThreads extends CopilotThreadObject {}
 * ```
 */
export class CopilotThreadObject {
  private readonly storage: DurableStorageLike
  constructor(state: { storage: DurableStorageLike }, _env?: unknown) {
    this.storage = state.storage
  }

  async fetch(req: Request): Promise<Response> {
    if (req.method !== 'POST') return new Response('method not allowed', { status: 405 })
    const body = (await req.json()) as { op?: string; key?: ThreadKey; thread?: CopilotThread; expect?: number | null; update?: ApprovalUpdate }
    // An approval's own object holds only its link.
    if (body.op === 'link') {
      if (!body.key || typeof body.key.id !== 'string') return Response.json({ ok: false }, { status: 400 })
      await this.storage.put(LINK, body.key)
      return Response.json({ ok: true })
    }
    if (body.op === 'linked') return Response.json({ key: (await this.storage.get<ThreadKey>(LINK)) ?? null })
    const cur = await this.storage.get<CopilotThread>(KEY)
    if (body.op === 'get') {
      if (!body.key) return Response.json({ thread: null }, { status: 400 })
      return Response.json({ thread: cur && sameOwner(cur.key, body.key) ? cur : null })
    }
    if (body.op === 'put') {
      const t = body.thread
      if (!t || typeof t.key?.id !== 'string' || typeof t.version !== 'number') return Response.json({ ok: false }, { status: 400 })
      if (cur && !sameOwner(cur.key, t.key)) return Response.json({ ok: false }, { status: 409 })
      const expect = body.expect ?? null
      if (expect === null ? cur !== undefined : cur?.version !== expect) return Response.json({ ok: false })
      if (!t.busy) {
        // The updates that came in while the thread was held.
        const queued = (await this.storage.get<ApprovalUpdate[]>(PENDING)) ?? []
        for (const u of queued) applyApprovalUpdate(t, u)
        if (queued.length) await this.storage.put(PENDING, [])
      }
      await this.storage.put(KEY, t)
      return Response.json({ ok: true })
    }
    if (body.op === 'approval') {
      const u = body.update
      if (!body.key || !u || typeof u.id !== 'string') return Response.json({ ok: false }, { status: 400 })
      if (!cur || !sameOwner(cur.key, body.key)) return Response.json({ ok: false })
      if (!free(cur, Date.now())) {
        await this.storage.put(PENDING, [...((await this.storage.get<ApprovalUpdate[]>(PENDING)) ?? []), u])
        return Response.json({ ok: true })
      }
      if (applyApprovalUpdate(cur, u)) {
        cur.version += 1
        await this.storage.put(KEY, cur)
      }
      return Response.json({ ok: true })
    }
    return Response.json({ error: 'unknown op' }, { status: 400 })
  }
}

/** A thread store over a namespace of `CopilotThreadObject`s, one object per thread, named by tenant, person and id. */
export function durableObjectThreads(ns: DurableObjectNamespaceLike): CopilotThreadStore {
  const post = (name: string, body: unknown) =>
    ns.get(ns.idFromName(name)).fetch('https://copilot-thread/', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
  const call = (key: ThreadKey, body: unknown) => post(threadObjectName(key), body)
  return {
    async get(key) {
      const r = await call(key, { op: 'get', key })
      if (!r.ok) throw new Error(`copilot thread ${key.id}: ${r.status}`)
      return ((await r.json()) as { thread: CopilotThread | null }).thread
    },
    async put(thread, expect) {
      const r = await call(thread.key, { op: 'put', thread, expect })
      if (r.status === 409) return false
      if (!r.ok) throw new Error(`copilot thread ${thread.key.id}: ${r.status}`)
      return ((await r.json()) as { ok: boolean }).ok === true
    },
    async link(id, key) {
      const r = await post(approvalObjectName(id), { op: 'link', key })
      if (!r.ok) throw new Error(`copilot approval link ${id}: ${r.status}`)
    },
    async linked(id) {
      const r = await post(approvalObjectName(id), { op: 'linked' })
      if (!r.ok) throw new Error(`copilot approval link ${id}: ${r.status}`)
      return ((await r.json()) as { key: ThreadKey | null }).key
    },
    async approval(key, update) {
      const r = await call(key, { op: 'approval', key, update })
      if (!r.ok) throw new Error(`copilot thread ${key.id}: ${r.status}`)
    },
  }
}

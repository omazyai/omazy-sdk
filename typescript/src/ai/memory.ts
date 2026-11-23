// Memory. Working memory and known ids live on the run; the conversation on
// a thread; long-term memory in the product's database. Long-term memory is
// proposed by the model and confirmed by a person, and only confirmed memory
// reaches a prompt. Scope is in every store query: a person's memory never
// reaches another person, a tenant's never another tenant.

import type { BaseCtx } from '../capabilities/capability.js'
import type { Message } from '../types.js'

export type LongTermScope = 'person' | 'tenant'
export type MemoryStatus = 'proposed' | 'confirmed' | 'rejected'

export interface MemoryRow {
  id: string
  /** Null for a person with no tenant (platform staff). */
  tenant: string | null
  scope: LongTermScope
  /** The person's id for `person`, the tenant's id for `tenant`. Taken from the ctx, never from the model. */
  subject: string
  text: string
  status: MemoryStatus
  /** The unit and run that proposed it. */
  unit: string | null
  runId: string | null
  /** Ids the text names (a visitor, a staff member), so an erasure can find it. */
  mentions: string[]
  proposedAt: string
  decidedAt: string | null
  decidedBy: string | null
  lastUsedAt: string | null
}

/** Whose memory a query may see: their own person memory and their tenant's. */
export interface MemoryOwner {
  tenant: string | null
  person: string
}

export interface MemoryListQuery {
  scope?: LongTermScope
  status?: MemoryStatus
  limit?: number
}

/** A conversation, held to one tenant and one person. The three together are its key: another person's thread of the same id is another thread. */
export interface ThreadKey {
  id: string
  tenant: string | null
  person: string
}

export interface Thread {
  summary: string | null
  /** Oldest first. */
  turns: Message[]
}

/** One thread in a person's list: its id, its summary once compacted, and when it last changed. */
export interface ThreadListItem {
  id: string
  summary: string | null
  updatedAt: string
}

export interface ThreadListQuery {
  /** 1 to 100. Default 20. */
  limit?: number
  /** The `next` of the page before. */
  cursor?: string | null
}

/** A page of threads, newest first. `next` is null on the last page. */
export interface ThreadPage {
  threads: ThreadListItem[]
  next: string | null
}

/** Default and largest page of `listThreads`. */
export const THREAD_PAGE = { default: 20, max: 100 } as const

/** The page size a query asks for, within 1 and 100. */
export const threadPageSize = (q?: ThreadListQuery): number => Math.min(THREAD_PAGE.max, Math.max(1, Math.floor(q?.limit ?? THREAD_PAGE.default) || THREAD_PAGE.default))

/** The cursor after this thread: opaque to callers, the thread's time and id inside. */
export function threadCursor(t: Pick<ThreadListItem, 'id' | 'updatedAt'>): string {
  const bytes = new TextEncoder().encode(JSON.stringify([t.updatedAt, t.id]))
  return btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

/** The time and id in a cursor. Throws `RangeError` for one this kit did not make. */
export function readThreadCursor(cursor: string): { updatedAt: string; id: string } {
  try {
    const bin = atob(cursor.replace(/-/g, '+').replace(/_/g, '/'))
    const v = JSON.parse(new TextDecoder().decode(Uint8Array.from(bin, (c) => c.charCodeAt(0)))) as unknown
    if (Array.isArray(v) && v.length === 2 && typeof v[0] === 'string' && typeof v[1] === 'string') return { updatedAt: v[0], id: v[1] }
  } catch {}
  throw new RangeError('That thread cursor is not valid.')
}

export interface MemoryStore {
  insert(row: MemoryRow): Promise<void>
  /** The row when the owner may see it. */
  find(owner: MemoryOwner, id: string): Promise<MemoryRow | null>
  /** Rows the owner may see, newest first. */
  list(owner: MemoryOwner, q?: MemoryListQuery): Promise<MemoryRow[]>
  /** Confirmed rows only, in these scopes, that the owner may see. Most recently used first. */
  recall(owner: MemoryOwner, scopes: readonly LongTermScope[], limit: number): Promise<MemoryRow[]>
  /** Compare-and-swap from `proposed`. */
  decide(owner: MemoryOwner, id: string, patch: Pick<MemoryRow, 'status' | 'decidedAt' | 'decidedBy'>): Promise<boolean>
  touch(ids: readonly string[], at: string): Promise<void>
  /** Deletes a row the owner may see. */
  remove(owner: MemoryOwner, id: string): Promise<boolean>
  /** Erasure: rows of a tenant, of a person, or naming an id. Returns how many went. */
  removeWhere(q: { tenant?: string | null; person?: string; mention?: string }): Promise<number>

  appendTurns(thread: ThreadKey, turns: readonly Message[], at: string): Promise<void>
  /** The summary and the last `limit` turns, only when tenant and person match the thread's. */
  thread(thread: ThreadKey, limit: number): Promise<Thread>
  /** Sets the summary and drops turns older than the last `keep`. */
  compactThread(thread: ThreadKey, summary: string, keep: number): Promise<void>
  removeThreads(q: { tenant?: string | null; person?: string }): Promise<number>
  /** The owner's threads, newest change first, a page at a time. Throws `RangeError` for a bad cursor. */
  listThreads(owner: MemoryOwner, q?: ThreadListQuery): Promise<ThreadPage>
}

const visible = (o: MemoryOwner, r: MemoryRow) => r.tenant === o.tenant && (r.scope === 'tenant' || r.subject === o.person)
const clone = <T>(v: T): T => structuredClone(v)

export function memoryMemoryStore(): MemoryStore & { rows: Map<string, MemoryRow> } {
  const rows = new Map<string, MemoryRow>()
  // Keyed by tenant, person and id: two people's threads of one id are two threads.
  const threads = new Map<string, { id: string; tenant: string | null; person: string; summary: string | null; turns: Message[]; updatedAt: string }>()
  const keyOf = (t: ThreadKey) => JSON.stringify([t.tenant, t.person, t.id])
  return {
    rows,
    async insert(row) {
      if (rows.has(row.id)) throw new Error(`memory ${row.id} exists`)
      rows.set(row.id, clone(row))
    },
    async find(o, id) {
      const r = rows.get(id)
      return r && visible(o, r) ? clone(r) : null
    },
    async list(o, q = {}) {
      return clone(
        [...rows.values()]
          .filter((r) => visible(o, r) && (!q.scope || r.scope === q.scope) && (!q.status || r.status === q.status))
          .sort((a, b) => b.proposedAt.localeCompare(a.proposedAt))
          .slice(0, q.limit ?? 100),
      )
    },
    async recall(o, scopes, limit) {
      return clone(
        [...rows.values()]
          .filter((r) => r.status === 'confirmed' && scopes.includes(r.scope) && visible(o, r))
          .sort((a, b) => (b.lastUsedAt ?? b.decidedAt ?? '').localeCompare(a.lastUsedAt ?? a.decidedAt ?? ''))
          .slice(0, limit),
      )
    },
    async decide(o, id, patch) {
      const r = rows.get(id)
      if (!r || !visible(o, r) || r.status !== 'proposed') return false
      rows.set(id, { ...r, ...patch })
      return true
    },
    async touch(ids, at) {
      for (const id of ids) {
        const r = rows.get(id)
        if (r) r.lastUsedAt = at
      }
    },
    async remove(o, id) {
      const r = rows.get(id)
      if (!r || !visible(o, r)) return false
      rows.delete(id)
      return true
    },
    async removeWhere(q) {
      let n = 0
      for (const [id, r] of rows) {
        if (q.tenant !== undefined && r.tenant !== q.tenant) continue
        if (q.person !== undefined && !(r.scope === 'person' && r.subject === q.person)) continue
        if (q.mention !== undefined && !r.mentions.includes(q.mention)) continue
        rows.delete(id)
        n++
      }
      return n
    },
    async appendTurns(t, turns, at) {
      const row = threads.get(keyOf(t)) ?? { id: t.id, tenant: t.tenant, person: t.person, summary: null, turns: [], updatedAt: at }
      row.turns.push(...clone([...turns]))
      row.updatedAt = at
      threads.set(keyOf(t), row)
    },
    async thread(t, limit) {
      const th = threads.get(keyOf(t))
      if (!th) return { summary: null, turns: [] }
      return clone({ summary: th.summary, turns: th.turns.slice(-limit) })
    },
    async compactThread(t, summary, keep) {
      const th = threads.get(keyOf(t))
      if (!th) return
      th.summary = summary
      th.turns = keep > 0 ? th.turns.slice(-keep) : []
    },
    async removeThreads(q) {
      let n = 0
      for (const [k, th] of threads) {
        if (q.tenant !== undefined && th.tenant !== q.tenant) continue
        if (q.person !== undefined && th.person !== q.person) continue
        threads.delete(k)
        n++
      }
      return n
    },
    async listThreads(o, q) {
      const limit = threadPageSize(q)
      const after = q?.cursor ? readThreadCursor(q.cursor) : null
      const mine = [...threads.values()]
        .filter((th) => th.tenant === o.tenant && th.person === o.person)
        .map((th): ThreadListItem => ({ id: th.id, summary: th.summary, updatedAt: th.updatedAt }))
        .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt) || (a.id < b.id ? 1 : a.id > b.id ? -1 : 0))
        .filter((t) => !after || t.updatedAt < after.updatedAt || (t.updatedAt === after.updatedAt && t.id < after.id))
      const page = mine.slice(0, limit)
      return { threads: page, next: mine.length > limit ? threadCursor(page.at(-1)!) : null }
    },
  }
}

// ---------------------------------------------------------------- the memory API

/** Channels where a person, not a model, acts. Only these may confirm or reject memory. */
export const DEFAULT_DECIDE_CHANNELS: readonly string[] = ['console']

/** At most this many long-term memories in one prompt. */
export const RECALL_LIMIT = 25

export interface MemoryOptions<C extends BaseCtx = BaseCtx> {
  store: MemoryStore
  /** Default `['console']`. A copilot, actor, workflow, automation or MCP call never confirms. */
  decideChannels?: readonly string[]
  /**
   * The product's own rule for who may confirm, reject or forget a row, on
   * top of the kit's: a person decides their own person memory; anyone in the
   * tenant decides tenant memory unless this says no (only owners, say).
   */
  canDecide?: (ctx: C, row: MemoryRow) => boolean | Promise<boolean>
  now?: () => number
  newId?: () => string
}

export type DecideMemoryResult =
  | { ok: true; row: MemoryRow }
  | { ok: false; reason: 'not_found' | 'not_a_person' | 'not_allowed' | 'already_decided' }

export interface Memory<C extends BaseCtx = BaseCtx> {
  readonly store: MemoryStore
  /** A model's proposal. Stored as `proposed`; it reaches no prompt until a person confirms it. */
  propose(ctx: C, input: { scope: LongTermScope; text: string; mentions?: readonly string[]; unit?: string; runId?: string }): Promise<MemoryRow>
  confirm(ctx: C, id: string): Promise<DecideMemoryResult>
  reject(ctx: C, id: string): Promise<DecideMemoryResult>
  /** What the person may see: their own memory and their tenant's. For a "what we remember" page. */
  list(ctx: C, q?: MemoryListQuery): Promise<MemoryRow[]>
  /** Confirmed memory for a prompt, at most 25. */
  recall(ctx: C, scopes: readonly LongTermScope[], limit?: number): Promise<MemoryRow[]>
  /** Removes one row the person may see and decide. */
  forget(ctx: C, id: string): Promise<boolean>
  /** Erasure of a person: their memory and their threads. */
  forgetPerson(tenant: string | null, person: string): Promise<number>
  /** Erasure of anyone a row names, such as a visitor. */
  forgetMentioning(tenant: string | null, id: string): Promise<number>
  /** A tenant's purge. */
  forgetTenant(tenant: string): Promise<number>
}

export const ownerOf = (ctx: BaseCtx): MemoryOwner => ({ tenant: ctx.tenant, person: ctx.principal.id })

export function createMemory<C extends BaseCtx = BaseCtx>(opts: MemoryOptions<C>): Memory<C> {
  const store = opts.store
  const now = () => new Date((opts.now ?? Date.now)()).toISOString()
  const newId = opts.newId ?? (() => `mem_${crypto.randomUUID().replace(/-/g, '')}`)
  const channels = opts.decideChannels ?? DEFAULT_DECIDE_CHANNELS

  async function allowed(ctx: C, row: MemoryRow): Promise<boolean> {
    if (row.scope === 'person' && row.subject !== ctx.principal.id) return false
    if (opts.canDecide && !(await opts.canDecide(ctx, row))) return false
    return true
  }

  async function decide(ctx: C, id: string, status: 'confirmed' | 'rejected'): Promise<DecideMemoryResult> {
    if (!channels.includes(ctx.channel)) return { ok: false, reason: 'not_a_person' }
    const owner = ownerOf(ctx)
    const row = await store.find(owner, id)
    if (!row) return { ok: false, reason: 'not_found' }
    if (row.status !== 'proposed') return { ok: false, reason: 'already_decided' }
    if (!(await allowed(ctx, row))) return { ok: false, reason: 'not_allowed' }
    const patch = { status, decidedAt: now(), decidedBy: ctx.principal.id }
    if (!(await store.decide(owner, id, patch))) return { ok: false, reason: 'already_decided' }
    return { ok: true, row: { ...row, ...patch } }
  }

  return {
    store,
    async propose(ctx, input) {
      const text = input.text.trim()
      if (!text) throw new Error('memory text is empty')
      if (input.scope === 'tenant' && !ctx.tenant) throw new Error('tenant memory needs a tenant')
      const row: MemoryRow = {
        id: newId(),
        tenant: ctx.tenant,
        scope: input.scope,
        subject: input.scope === 'person' ? ctx.principal.id : ctx.tenant!,
        text: text.slice(0, 1000),
        status: 'proposed',
        unit: input.unit ?? null,
        runId: input.runId ?? null,
        mentions: [...(input.mentions ?? [])],
        proposedAt: now(),
        decidedAt: null,
        decidedBy: null,
        lastUsedAt: null,
      }
      await store.insert(row)
      return row
    },
    confirm: (ctx, id) => decide(ctx, id, 'confirmed'),
    reject: (ctx, id) => decide(ctx, id, 'rejected'),
    list: (ctx, q) => store.list(ownerOf(ctx), q),
    async recall(ctx, scopes, limit = RECALL_LIMIT) {
      if (!scopes.length) return []
      const rows = await store.recall(ownerOf(ctx), scopes, Math.min(limit, RECALL_LIMIT))
      if (rows.length) await store.touch(rows.map((r) => r.id), now())
      return rows
    },
    async forget(ctx, id) {
      const owner = ownerOf(ctx)
      const row = await store.find(owner, id)
      if (!row || !(await allowed(ctx, row))) return false
      return store.remove(owner, id)
    },
    async forgetPerson(tenant, person) {
      return (await store.removeWhere({ tenant, person })) + (await store.removeThreads({ tenant, person }))
    },
    forgetMentioning: (tenant, id) => store.removeWhere({ tenant, mention: id }),
    async forgetTenant(tenant) {
      return (await store.removeWhere({ tenant })) + (await store.removeThreads({ tenant }))
    },
  }
}

/** One `[known]` line per resolved entity, as the prompt shows them. */
export function knownLines(known: ReadonlyMap<string, string>): string[] {
  return [...known].map(([k, v]) => `[known] ${k} = ${v}`)
}

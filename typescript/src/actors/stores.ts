// Where sessions live. Every store writes with compare-and-swap on the
// session's version, so two surfaces answering at once cannot both win.
//
// - `memorySessionStore`: tests, and a single process.
// - `d1SessionStore`: Cloudflare D1. The draft every surface can resume.
// - `pgSessionStore`: Postgres, for a Node product, through any driver's `query`.
// - `durableObjectSessions` and `ActorSessionObject`: one Durable Object per
//   session, for Workers that want the session beside its own lock.
//
// Apply ACTOR_MIGRATIONS once for D1 or Postgres; the SQL is the same.

import type { D1DatabaseLike } from '../guard/d1.js'
import { OPEN_STATES } from './types.js'
import type { ActorSession, SessionStore } from './types.js'

const clone = <T>(v: T): T => structuredClone(v)

// ---------------------------------------------------------------- memory

export function memorySessionStore(): SqlSessionStore & { readonly size: number } {
  const rows = new Map<string, ActorSession>()
  return {
    get size() {
      return rows.size
    },
    async get(id) {
      const s = rows.get(id)
      return s ? clone(s) : null
    },
    async put(s, expect) {
      const cur = rows.get(s.id)
      if (expect === null ? cur !== undefined : cur?.version !== expect) return false
      rows.set(s.id, clone(s))
      return true
    },
    async open(q) {
      return [...rows.values()]
        .filter((s) => s.tenant === q.tenant && s.person === q.person && (!q.actor || s.actor === q.actor) && OPEN_STATES.includes(s.state))
        .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
        .slice(0, q.limit ?? 10)
        .map(clone)
    },
    async idle(at, limit = 100) {
      return [...rows.values()]
        .filter((s) => OPEN_STATES.includes(s.state) && s.expiresAt < at)
        .sort((a, b) => a.expiresAt.localeCompare(b.expiresAt))
        .slice(0, limit)
        .map(clone)
    },
  }
}

// ---------------------------------------------------------------- SQL (D1 and Postgres)

/** The sessions table. Additive only. Plain SQL that D1 (SQLite) and Postgres both run. */
export const ACTOR_MIGRATIONS: readonly { id: string; sql: string }[] = Object.freeze([
  {
    id: '0001_actor_sessions',
    sql: `
CREATE TABLE IF NOT EXISTS actor_sessions (
  id TEXT PRIMARY KEY,
  actor TEXT NOT NULL,
  actor_version INTEGER NOT NULL,
  tenant_key TEXT NOT NULL,
  person TEXT NOT NULL,
  state TEXT NOT NULL,
  version INTEGER NOT NULL,
  data TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  expires_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS actor_sessions_open ON actor_sessions (tenant_key, person, state, updated_at);
CREATE INDEX IF NOT EXISTS actor_sessions_expires ON actor_sessions (state, expires_at);
`,
  },
])

export const actorMigrationSql = (): string => ACTOR_MIGRATIONS.map((m) => `-- ${m.id}\n${m.sql.trim()}\n`).join('\n')

const statements = () =>
  ACTOR_MIGRATIONS.flatMap((m) => m.sql.split(';'))
    .map((s) => s.trim())
    .filter(Boolean)

/** The tenant as a key: null is stored as '' so one equality works on SQLite and Postgres. */
const tenantKey = (t: string | null) => t ?? ''
const OPEN_SQL = OPEN_STATES.map((s) => `'${s}'`).join(', ')

const SQL = {
  get: 'SELECT data FROM actor_sessions WHERE id = ?',
  insert:
    'INSERT INTO actor_sessions (id, actor, actor_version, tenant_key, person, state, version, data, created_at, updated_at, expires_at) ' +
    'VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT (id) DO NOTHING',
  update: 'UPDATE actor_sessions SET state = ?, version = ?, data = ?, updated_at = ?, expires_at = ? WHERE id = ? AND version = ?',
  open: `SELECT data FROM actor_sessions WHERE tenant_key = ? AND person = ? AND state IN (${OPEN_SQL}) ORDER BY updated_at DESC LIMIT ?`,
  openActor: `SELECT data FROM actor_sessions WHERE tenant_key = ? AND person = ? AND actor = ? AND state IN (${OPEN_SQL}) ORDER BY updated_at DESC LIMIT ?`,
  expire: `SELECT data FROM actor_sessions WHERE state IN (${OPEN_SQL}) AND expires_at < ? ORDER BY expires_at LIMIT ?`,
}

const insertArgs = (s: ActorSession) => [s.id, s.actor, s.actorVersion, tenantKey(s.tenant), s.person, s.state, s.version, JSON.stringify(s), s.createdAt, s.updatedAt, s.expiresAt]
const updateArgs = (s: ActorSession, expect: number) => [s.state, s.version, JSON.stringify(s), s.updatedAt, s.expiresAt, s.id, expect]
const decode = (row: { data?: unknown } | null | undefined): ActorSession | null => (row && typeof row.data === 'string' ? (JSON.parse(row.data) as ActorSession) : null)

/** A SQL store adds a listing of sessions past their idle time, for a cron that wants to close them. */
export interface SqlSessionStore extends SessionStore {
  /** Open sessions whose idle time ran out before `at` (ISO), oldest first. `expireIdle` expires them. */
  idle(at: string, limit?: number): Promise<ActorSession[]>
}

// ---------------------------------------------------------------- D1

export async function applyActorMigrations(db: D1DatabaseLike): Promise<void> {
  await db.batch(statements().map((s) => db.prepare(s)))
}

export function d1SessionStore(db: D1DatabaseLike): SqlSessionStore {
  return {
    async get(id) {
      return decode(await db.prepare(SQL.get).bind(id).first<{ data: string }>())
    },
    async put(s, expect) {
      const r = expect === null ? await db.prepare(SQL.insert).bind(...insertArgs(s)).run() : await db.prepare(SQL.update).bind(...updateArgs(s, expect)).run()
      return (r.meta?.changes ?? 0) === 1
    },
    async open(q) {
      const limit = Math.min(Math.max(q.limit ?? 10, 1), 100)
      const r = q.actor
        ? await db.prepare(SQL.openActor).bind(tenantKey(q.tenant), q.person, q.actor, limit).all<{ data: string }>()
        : await db.prepare(SQL.open).bind(tenantKey(q.tenant), q.person, limit).all<{ data: string }>()
      return (r.results ?? []).map(decode).filter((s): s is ActorSession => s !== null)
    },
    async idle(at, limit = 100) {
      const r = await db.prepare(SQL.expire).bind(at, limit).all<{ data: string }>()
      return (r.results ?? []).map(decode).filter((s): s is ActorSession => s !== null)
    },
  }
}

// ---------------------------------------------------------------- Postgres

/** The part of a Postgres driver the store uses: `pg`'s `pool.query` and `postgres.js` wrapped both fit. */
export type PgQuery = (text: string, params: unknown[]) => Promise<{ rows: Record<string, unknown>[]; rowCount?: number | null }>

/** `?` placeholders to `$1, $2 ...`. The kit's SQL has no `?` inside strings. */
const numbered = (sql: string) => {
  let n = 0
  return sql.replace(/\?/g, () => `$${++n}`)
}

/** Runs ACTOR_MIGRATIONS on Postgres. */
export async function applyActorMigrationsPg(query: PgQuery): Promise<void> {
  for (const s of statements()) await query(s, [])
}

export function pgSessionStore(query: PgQuery): SqlSessionStore {
  const q = (sql: string, params: unknown[]) => query(numbered(sql), params)
  return {
    async get(id) {
      return decode((await q(SQL.get, [id])).rows[0] as { data?: unknown })
    },
    async put(s, expect) {
      const r = expect === null ? await q(SQL.insert, insertArgs(s)) : await q(SQL.update, updateArgs(s, expect))
      return (r.rowCount ?? 0) === 1
    },
    async open(o) {
      const limit = Math.min(Math.max(o.limit ?? 10, 1), 100)
      const r = o.actor ? await q(SQL.openActor, [tenantKey(o.tenant), o.person, o.actor, limit]) : await q(SQL.open, [tenantKey(o.tenant), o.person, limit])
      return r.rows.map((x) => decode(x as { data?: unknown })).filter((s): s is ActorSession => s !== null)
    },
    async idle(at, limit = 100) {
      return (await q(SQL.expire, [at, limit])).rows.map((x) => decode(x as { data?: unknown })).filter((s): s is ActorSession => s !== null)
    },
  }
}

// ---------------------------------------------------------------- Durable Objects

/** The part of `DurableObjectStorage` the helper uses. */
export interface DurableStorageLike {
  get<T = unknown>(key: string): Promise<T | undefined>
  put<T = unknown>(key: string, value: T): Promise<void>
}

export interface DurableObjectStubLike {
  fetch(input: string | Request, init?: RequestInit): Promise<Response>
}

/** The part of `DurableObjectNamespace` the helper uses. */
export interface DurableObjectNamespaceLike {
  idFromName(name: string): unknown
  get(id: any): DurableObjectStubLike
}

const KEY = 'session'

/**
 * The Durable Object class for one session. Export it from the Worker and
 * bind it, then give `durableObjectSessions(env.ACTOR_SESSIONS)` to the
 * runtime. A Durable Object handles one request at a time per storage
 * operation, so the version check and the write cannot interleave.
 *
 * ```ts
 * export class ActorSession extends ActorSessionObject {}
 * ```
 */
export class ActorSessionObject {
  private readonly storage: DurableStorageLike
  constructor(state: { storage: DurableStorageLike }, _env?: unknown) {
    this.storage = state.storage
  }

  async fetch(req: Request): Promise<Response> {
    if (req.method === 'GET') {
      const s = await this.storage.get<ActorSession>(KEY)
      return Response.json({ session: s ?? null })
    }
    if (req.method === 'PUT') {
      const body = (await req.json()) as { session?: ActorSession; expect?: number | null }
      if (!body.session || typeof body.session.id !== 'string') return Response.json({ ok: false }, { status: 400 })
      const cur = await this.storage.get<ActorSession>(KEY)
      const expect = body.expect ?? null
      if (cur && cur.id !== body.session.id) return Response.json({ ok: false }, { status: 409 })
      if (expect === null ? cur !== undefined : cur?.version !== expect) return Response.json({ ok: false })
      await this.storage.put(KEY, body.session)
      return Response.json({ ok: true })
    }
    return new Response('method not allowed', { status: 405 })
  }
}

/** A session store over a namespace of `ActorSessionObject`s, one object per session id. No listing: pair it with D1 as `drafts`. */
export function durableObjectSessions(ns: DurableObjectNamespaceLike): SessionStore {
  const stub = (id: string) => ns.get(ns.idFromName(id))
  const URL_ = 'https://actor-session/'
  return {
    async get(id) {
      const r = await stub(id).fetch(URL_, { method: 'GET' })
      if (!r.ok) throw new Error(`actor session ${id}: ${r.status}`)
      return ((await r.json()) as { session: ActorSession | null }).session
    },
    async put(s, expect) {
      const r = await stub(s.id).fetch(URL_, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ session: s, expect }) })
      if (r.status === 409) return false
      if (!r.ok) throw new Error(`actor session ${s.id}: ${r.status}`)
      return ((await r.json()) as { ok: boolean }).ok === true
    },
  }
}

// Where the token endpoint keeps three things: a lock per grant, held while
// one refresh runs; the hashes of rotated refresh tokens, so a token that
// comes back revokes its grant; and a tombstone per revoked grant.
//
// The tombstone is there because the library keeps grants in KV and writes
// the whole grant back on every refresh. KV is read through a cache in each
// location for up to about 60 seconds, and the last write wins. A refresh in
// a location that still has the grant cached, after it was revoked
// elsewhere, writes it back: the revoked grant is live again everywhere. No
// mark or lock can stop that write, since the library makes it. So the kit
// keeps the fact of the revocation in this store, for as long as any token
// of the grant can live, and checks it before the library sees a refresh
// token or a code, and before an access token resolves. A grant that came
// back is revoked again.
//
// KV alone cannot do any of this reliably. It has no compare and swap, so
// two refreshes with one token at the same moment can both pass; and a write
// is seen in other locations only after up to about 60 seconds, so a rotated
// token replayed, or a revoked grant refreshed, from another region in that
// window is not yet marked. The KV store narrows the first to one isolate (an
// in-memory lock) and leaves the others open: its tombstone sits in the same
// cache as the grant. A Durable Object or D1 closes all three: each answers
// from one place, in order.

import { KV_MIN_TTL, KV_PREFIX, type KvLike } from './kv.js'
import type { D1DatabaseLike } from '../guard/d1.js'

/** Who a rotated refresh token belonged to. */
export interface RetiredRefresh {
  userId: string
  grantId: string
}

export interface RefreshStore {
  /** True when every read sees every earlier write, from anywhere: a Durable Object or D1. False for KV. */
  readonly consistent: boolean
  /** Takes the grant's lock for at most `ms`. A holder id to unlock with, or null while another refresh holds it. */
  lock(grantId: string, ms: number): Promise<string | null>
  unlock(grantId: string, holder: string): Promise<void>
  /** Marks a rotated refresh token for `ttlSeconds`. */
  retire(grantId: string, tokenHash: string, owner: RetiredRefresh, ttlSeconds: number): Promise<void>
  /** The owner of a rotated refresh token, or null when it was never rotated (or the mark expired). */
  retired(grantId: string, tokenHash: string): Promise<RetiredRefresh | null>
  /** Drops a mark the library did not rotate (it refused the token). Never called for a reused token: that mark lives out its TTL. */
  forget(grantId: string, tokenHash: string): Promise<void>
  /** Records that a grant was revoked, for `ttlSeconds`. Kept when one already exists, with the later expiry. */
  tombstone(grantId: string, owner: RetiredRefresh, ttlSeconds: number): Promise<void>
  /** The owner of a revoked grant, or null when it was never revoked (or the tombstone expired). */
  tombstoned(grantId: string): Promise<RetiredRefresh | null>
}

const newHolder = (): string => {
  const b = crypto.getRandomValues(new Uint8Array(12))
  return Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('')
}

// One isolate's locks, shared by every server built in it (a product may
// build the server per request).
const isolateLocks = new Map<string, { holder: string; until: number }>()

function isolateLock(key: string, ms: number): string | null {
  const now = Date.now()
  const cur = isolateLocks.get(key)
  if (cur && cur.until > now) return null
  if (isolateLocks.size >= 10_000) for (const [k, v] of isolateLocks) if (v.until <= now) isolateLocks.delete(k)
  const holder = newHolder()
  isolateLocks.set(key, { holder, until: now + ms })
  return holder
}

function isolateUnlock(key: string, holder: string): void {
  if (isolateLocks.get(key)?.holder === holder) isolateLocks.delete(key)
}

/**
 * The default: marks in KV (`omazy-oauth:rt:<hash>`), tombstones in KV
 * (`omazy-oauth:gt:<grant>`), the lock in this isolate's memory. Not
 * consistent: two isolates may refresh one token at once, and a mark or a
 * tombstone written in one region reaches others within about 60 seconds, the
 * same window in which a stale grant can be written back. A platform door
 * refuses it unless the product accepts that race.
 */
export function kvRefreshStore(kv: KvLike): RefreshStore {
  const key = (hash: string) => `${KV_PREFIX}rt:${hash}`
  const grave = (grantId: string) => `${KV_PREFIX}gt:${grantId}`
  return {
    consistent: false,
    async lock(grantId, ms) {
      return isolateLock(grantId, ms)
    },
    async unlock(grantId, holder) {
      isolateUnlock(grantId, holder)
    },
    async retire(_grantId, hash, owner, ttl) {
      await kv.put(key(hash), JSON.stringify(owner), { expirationTtl: Math.max(KV_MIN_TTL, ttl) })
    },
    async retired(_grantId, hash) {
      return ((await kv.get(key(hash), { type: 'json' })) as RetiredRefresh | null) ?? null
    },
    async forget(_grantId, hash) {
      await kv.delete(key(hash))
    },
    async tombstone(grantId, owner, ttl) {
      await kv.put(grave(grantId), JSON.stringify({ userId: owner.userId, grantId: owner.grantId }), { expirationTtl: Math.max(KV_MIN_TTL, ttl) })
    },
    async tombstoned(grantId) {
      return ((await kv.get(grave(grantId), { type: 'json' })) as RetiredRefresh | null) ?? null
    },
  }
}

// ---------------------------------------------------------------- D1

/** The tables `d1RefreshStore` needs. Additive only. */
export const OAUTH_D1_MIGRATIONS: readonly { id: string; sql: readonly string[] }[] = Object.freeze([
  {
    id: '0001_oauth_refresh',
    sql: [
      'CREATE TABLE IF NOT EXISTS omazy_oauth_refresh_lock (grant_id TEXT PRIMARY KEY, holder TEXT NOT NULL, until_ms INTEGER NOT NULL)',
      'CREATE TABLE IF NOT EXISTS omazy_oauth_refresh_retired (token_hash TEXT PRIMARY KEY, user_id TEXT NOT NULL, grant_id TEXT NOT NULL, until_ms INTEGER NOT NULL)',
      'CREATE INDEX IF NOT EXISTS omazy_oauth_refresh_retired_until ON omazy_oauth_refresh_retired (until_ms)',
    ],
  },
  {
    id: '0002_oauth_grant_tombstone',
    sql: [
      'CREATE TABLE IF NOT EXISTS omazy_oauth_grant_tombstone (grant_id TEXT PRIMARY KEY, user_id TEXT NOT NULL, until_ms INTEGER NOT NULL)',
      'CREATE INDEX IF NOT EXISTS omazy_oauth_grant_tombstone_until ON omazy_oauth_grant_tombstone (until_ms)',
    ],
  },
])

/** Creates the tables if they are missing. Safe to run on every deploy. */
export async function applyOAuthD1Migrations(db: D1DatabaseLike): Promise<void> {
  for (const m of OAUTH_D1_MIGRATIONS) for (const sql of m.sql) await db.prepare(sql).run()
}

export interface D1RefreshStore extends RefreshStore {
  /** Deletes expired locks, marks and tombstones. For a daily cron. */
  prune(now?: number): Promise<number>
}

/**
 * Locks and marks in D1, by conditional writes on the primary. Do not read
 * these tables through a D1 session with read replicas.
 */
export function d1RefreshStore(db: D1DatabaseLike): D1RefreshStore {
  return {
    consistent: true,
    async lock(grantId, ms) {
      const now = Date.now()
      const holder = newHolder()
      const r = await db
        .prepare(
          `INSERT INTO omazy_oauth_refresh_lock (grant_id, holder, until_ms) VALUES (?1, ?2, ?3)
           ON CONFLICT(grant_id) DO UPDATE SET holder = excluded.holder, until_ms = excluded.until_ms
           WHERE omazy_oauth_refresh_lock.until_ms <= ?4`,
        )
        .bind(grantId, holder, now + ms, now)
        .run()
      return r.meta?.changes === 1 ? holder : null
    },
    async unlock(grantId, holder) {
      await db.prepare('DELETE FROM omazy_oauth_refresh_lock WHERE grant_id = ?1 AND holder = ?2').bind(grantId, holder).run()
    },
    async retire(grantId, hash, owner, ttl) {
      await db
        .prepare('INSERT OR REPLACE INTO omazy_oauth_refresh_retired (token_hash, user_id, grant_id, until_ms) VALUES (?1, ?2, ?3, ?4)')
        .bind(hash, owner.userId, grantId, Date.now() + ttl * 1000)
        .run()
    },
    async retired(_grantId, hash) {
      const row = await db
        .prepare('SELECT user_id, grant_id FROM omazy_oauth_refresh_retired WHERE token_hash = ?1 AND until_ms > ?2')
        .bind(hash, Date.now())
        .first<{ user_id: string; grant_id: string }>()
      return row ? { userId: row.user_id, grantId: row.grant_id } : null
    },
    async forget(_grantId, hash) {
      await db.prepare('DELETE FROM omazy_oauth_refresh_retired WHERE token_hash = ?1').bind(hash).run()
    },
    async tombstone(grantId, owner, ttl) {
      await db
        .prepare(
          `INSERT INTO omazy_oauth_grant_tombstone (grant_id, user_id, until_ms) VALUES (?1, ?2, ?3)
           ON CONFLICT(grant_id) DO UPDATE SET until_ms = MAX(omazy_oauth_grant_tombstone.until_ms, excluded.until_ms)`,
        )
        .bind(grantId, owner.userId, Date.now() + ttl * 1000)
        .run()
    },
    async tombstoned(grantId) {
      const row = await db
        .prepare('SELECT user_id, grant_id FROM omazy_oauth_grant_tombstone WHERE grant_id = ?1 AND until_ms > ?2')
        .bind(grantId, Date.now())
        .first<{ user_id: string; grant_id: string }>()
      return row ? { userId: row.user_id, grantId: row.grant_id } : null
    },
    async prune(now = Date.now()) {
      let n = 0
      for (const t of ['omazy_oauth_refresh_lock', 'omazy_oauth_refresh_retired', 'omazy_oauth_grant_tombstone'])
        n += (await db.prepare(`DELETE FROM ${t} WHERE until_ms <= ?1`).bind(now).run()).meta?.changes ?? 0
      return n
    },
  }
}

// ---------------------------------------------------------------- Durable Object

/** The part of a Durable Object's storage the lock uses. */
export interface DurableObjectStorageLike {
  get<T = unknown>(key: string): Promise<T | undefined>
  put(key: string, value: unknown): Promise<void>
  delete(key: string): Promise<boolean>
  list<T = unknown>(options?: { prefix?: string }): Promise<Map<string, T>>
  getAlarm(): Promise<number | null>
  setAlarm(scheduledTime: number): Promise<void>
}

/** The part of a Durable Object namespace binding the store uses. */
export interface DurableObjectNamespaceLike {
  idFromName(name: string): unknown
  get(id: unknown): { fetch(input: string, init?: RequestInit): Promise<Response> }
}

type LockOp =
  | { op: 'lock'; holder: string; ms: number }
  | { op: 'unlock'; holder: string }
  | { op: 'retire'; hash: string; owner: RetiredRefresh; ttl: number }
  | { op: 'retired'; hash: string }
  | { op: 'forget'; hash: string }
  | { op: 'tombstone'; owner: RetiredRefresh; ttl: number }
  | { op: 'tombstoned' }

const ok = (body: unknown) => new Response(JSON.stringify(body), { headers: { 'content-type': 'application/json' } })
const HASH = /^[0-9a-f]{64}$/

/**
 * A Durable Object, one per grant, holding that grant's refresh lock, the
 * marks of its rotated tokens and, once revoked, its tombstone. A Durable Object runs one request's storage
 * reads and writes without another request in between, so the lock is
 * exact. Export it from the Worker and bind it:
 *
 *     export { OAuthRefreshLock } from '@omazyai/sdk/oauth'
 *     // wrangler.jsonc
 *     "durable_objects": { "bindings": [{ "name": "OAUTH_REFRESH", "class_name": "OAuthRefreshLock" }] },
 *     "migrations": [{ "tag": "oauth-refresh-1", "new_sqlite_classes": ["OAuthRefreshLock"] }]
 *
 * then pass `refresh: { store: durableObjectRefreshStore(env.OAUTH_REFRESH) }`.
 */
export class OAuthRefreshLock {
  constructor(
    private readonly state: { storage: DurableObjectStorageLike },
    _env?: unknown,
  ) {}

  async fetch(req: Request): Promise<Response> {
    let op: LockOp
    try {
      op = (await req.json()) as LockOp
    } catch {
      return new Response('bad request', { status: 400 })
    }
    const s = this.state.storage
    const now = Date.now()
    switch (op?.op) {
      case 'lock': {
        if (typeof op.holder !== 'string' || !Number.isFinite(op.ms) || op.ms <= 0) break
        const cur = await s.get<{ holder: string; until: number }>('lock')
        if (cur && cur.until > now) return ok({ holder: null })
        await s.put('lock', { holder: op.holder, until: now + Math.min(op.ms, 60_000) })
        return ok({ holder: op.holder })
      }
      case 'unlock': {
        const cur = await s.get<{ holder: string; until: number }>('lock')
        if (cur?.holder === op.holder) await s.delete('lock')
        return ok({})
      }
      case 'retire': {
        if (!HASH.test(op.hash) || typeof op.owner?.userId !== 'string' || typeof op.owner?.grantId !== 'string' || !Number.isFinite(op.ttl)) break
        const until = now + op.ttl * 1000
        await s.put(`rt:${op.hash}`, { owner: { userId: op.owner.userId, grantId: op.owner.grantId }, until })
        const alarm = await s.getAlarm()
        if (alarm === null || alarm < until) await s.setAlarm(until)
        return ok({})
      }
      case 'retired': {
        if (!HASH.test(op.hash)) break
        const rec = await s.get<{ owner: RetiredRefresh; until: number }>(`rt:${op.hash}`)
        return ok({ owner: rec && rec.until > now ? rec.owner : null })
      }
      case 'forget': {
        if (!HASH.test(op.hash)) break
        await s.delete(`rt:${op.hash}`)
        return ok({})
      }
      case 'tombstone': {
        if (typeof op.owner?.userId !== 'string' || typeof op.owner?.grantId !== 'string' || !Number.isFinite(op.ttl)) break
        const cur = await s.get<{ owner: RetiredRefresh; until: number }>('tombstone')
        const until = Math.max(now + op.ttl * 1000, cur?.until ?? 0)
        await s.put('tombstone', { owner: { userId: op.owner.userId, grantId: op.owner.grantId }, until })
        const alarm = await s.getAlarm()
        if (alarm === null || alarm < until) await s.setAlarm(until)
        return ok({})
      }
      case 'tombstoned': {
        const rec = await s.get<{ owner: RetiredRefresh; until: number }>('tombstone')
        return ok({ owner: rec && rec.until > now ? rec.owner : null })
      }
    }
    return new Response('bad request', { status: 400 })
  }

  /** Deletes expired marks and an expired tombstone; the alarm is set to the latest expiry. */
  async alarm(): Promise<void> {
    const now = Date.now()
    for (const [k, v] of await this.state.storage.list<{ until: number }>({ prefix: 'rt:' })) if (v.until <= now) await this.state.storage.delete(k)
    const t = await this.state.storage.get<{ until: number }>('tombstone')
    if (t && t.until <= now) await this.state.storage.delete('tombstone')
  }
}

/** A refresh store on the `OAuthRefreshLock` Durable Object, one object per grant. */
export function durableObjectRefreshStore(ns: DurableObjectNamespaceLike): RefreshStore {
  const call = async <T>(grantId: string, op: LockOp): Promise<T> => {
    const res = await ns.get(ns.idFromName(grantId)).fetch('https://oauth-refresh-lock/', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(op) })
    if (!res.ok) throw new Error(`oauth: refresh lock answered ${res.status}`)
    return (await res.json()) as T
  }
  return {
    consistent: true,
    async lock(grantId, ms) {
      return (await call<{ holder: string | null }>(grantId, { op: 'lock', holder: newHolder(), ms })).holder
    },
    async unlock(grantId, holder) {
      await call(grantId, { op: 'unlock', holder })
    },
    async retire(grantId, hash, owner, ttl) {
      await call(grantId, { op: 'retire', hash, owner, ttl })
    },
    async retired(grantId, hash) {
      return (await call<{ owner: RetiredRefresh | null }>(grantId, { op: 'retired', hash })).owner
    },
    async forget(grantId, hash) {
      await call(grantId, { op: 'forget', hash })
    },
    async tombstone(grantId, owner, ttl) {
      await call(grantId, { op: 'tombstone', owner, ttl })
    },
    async tombstoned(grantId) {
      return (await call<{ owner: RetiredRefresh | null }>(grantId, { op: 'tombstoned' })).owner
    },
  }
}

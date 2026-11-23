// The storage the kit runs on: a Cloudflare KV namespace, the model the
// wrapped library already uses for grants, tokens, clients and consent
// handles. The kit keeps its own records (keys, retired refresh tokens, last
// use, counters) in the same namespace under `omazy-oauth:`, a prefix the
// library never writes. `memoryKv()` is an in-memory namespace for tests.

export interface KvPutOptions {
  /** Seconds from now. */
  expirationTtl?: number
  /** Seconds since the epoch. */
  expiration?: number
  metadata?: unknown
}

export interface KvListResult {
  keys: { name: string; expiration?: number; metadata?: unknown }[]
  list_complete: boolean
  cursor?: string
}

/** The part of a Workers `KVNamespace` the kit and the library use. A real binding fits it. */
export interface KvLike {
  get(key: string, options?: unknown): Promise<any>
  put(key: string, value: string, options?: KvPutOptions): Promise<void>
  delete(key: string): Promise<void>
  list(options?: { prefix?: string; limit?: number; cursor?: string }): Promise<KvListResult>
}

/** Where the kit's own records live. The library's keys (`grant:`, `token:`, `client:`, ...) never start with it. */
export const KV_PREFIX = 'omazy-oauth:'

/** KV refuses an expiration less than 60 seconds away. */
export const KV_MIN_TTL = 60

/** Ids the kit puts inside KV keys and tokens: no `:` and nothing odd. */
export const SAFE_ID = /^[A-Za-z0-9._@-]{1,128}$/

interface Entry {
  value: string
  expiresAt?: number
  metadata?: unknown
}

/**
 * An in-memory KV namespace with expiry, metadata and cursor paging, for
 * tests and local runs. Expiry follows `Date.now()`, so a test can move the
 * clock with `setSystemTime`.
 */
export function memoryKv(): KvLike & { size(): number; dump(): string[] } {
  const data = new Map<string, Entry>()
  const live = (key: string): Entry | undefined => {
    const e = data.get(key)
    if (!e) return undefined
    if (e.expiresAt !== undefined && e.expiresAt * 1000 <= Date.now()) {
      data.delete(key)
      return undefined
    }
    return e
  }
  return {
    async get(key, options) {
      const e = live(key)
      if (!e) return null
      const type = typeof options === 'string' ? options : (options as { type?: string } | undefined)?.type
      return type === 'json' ? JSON.parse(e.value) : e.value
    },
    async put(key, value, options = {}) {
      if (typeof value !== 'string') throw new TypeError('memoryKv stores strings only')
      const now = Math.floor(Date.now() / 1000)
      let expiresAt: number | undefined
      if (options.expiration !== undefined) expiresAt = options.expiration
      else if (options.expirationTtl !== undefined) {
        if (options.expirationTtl < KV_MIN_TTL) throw new Error(`KV expirationTtl must be at least ${KV_MIN_TTL}`)
        expiresAt = now + options.expirationTtl
      }
      if (expiresAt !== undefined && expiresAt - now < KV_MIN_TTL) throw new Error(`KV expiration must be at least ${KV_MIN_TTL} s away`)
      data.set(key, { value, ...(expiresAt !== undefined ? { expiresAt } : {}), ...(options.metadata !== undefined ? { metadata: options.metadata } : {}) })
    },
    async delete(key) {
      data.delete(key)
    },
    async list(options = {}) {
      const prefix = options.prefix ?? ''
      const limit = Math.min(Math.max(options.limit ?? 1000, 1), 1000)
      const names = [...data.keys()].filter((k) => k.startsWith(prefix) && live(k)).sort()
      const start = options.cursor ? Number(options.cursor) : 0
      const page = names.slice(start, start + limit)
      const end = start + page.length
      return {
        keys: page.map((name) => {
          const e = data.get(name)!
          return { name, ...(e.expiresAt !== undefined ? { expiration: e.expiresAt } : {}), ...(e.metadata !== undefined ? { metadata: e.metadata } : {}) }
        }),
        list_complete: end >= names.length,
        ...(end < names.length ? { cursor: String(end) } : {}),
      }
    },
    size: () => [...data.keys()].filter((k) => live(k)).length,
    dump: () => [...data.keys()].filter((k) => live(k)).sort(),
  }
}

/** Every key under a prefix, across pages. */
export async function listAll(kv: KvLike, prefix: string): Promise<KvListResult['keys']> {
  const out: KvListResult['keys'] = []
  let cursor: string | undefined
  do {
    const page = await kv.list({ prefix, limit: 1000, ...(cursor ? { cursor } : {}) })
    out.push(...page.keys)
    cursor = page.list_complete ? undefined : page.cursor
  } while (cursor)
  return out
}

/**
 * A fixed-window counter: adds one and returns the count in this window.
 * KV has no atomic increment, so two requests at once may both read the same
 * count. It is a brake on abuse, not an exact limit.
 */
export async function bump(kv: KvLike, bucket: string, id: string, windowSeconds: number): Promise<number> {
  const window = Math.floor(Date.now() / 1000 / windowSeconds)
  const key = `${KV_PREFIX}rl:${bucket}:${id}:${window}`
  const n = Number((await kv.get(key)) ?? 0) + 1
  await kv.put(key, String(n), { expirationTtl: Math.max(KV_MIN_TTL, windowSeconds + 60) })
  return n
}

/** Reads a counter without changing it. */
export async function peek(kv: KvLike, bucket: string, id: string, windowSeconds: number): Promise<number> {
  const window = Math.floor(Date.now() / 1000 / windowSeconds)
  return Number((await kv.get(`${KV_PREFIX}rl:${bucket}:${id}:${window}`)) ?? 0)
}

/**
 * A numeric option: a whole number from `min` (default 1) up, or undefined
 * when it was left out. NaN, Infinity, a fraction, a string or anything below
 * `min` throws at start: a comparison with NaN is always false, so it would
 * pass every check and lift the limit it sets.
 */
export function wholeNumber(name: string, value: unknown, min = 1): number | undefined {
  if (value === undefined) return undefined
  if (typeof value !== 'number' || !Number.isInteger(value) || value < min) throw new Error(`oauth: ${name} must be a whole number of at least ${min}`)
  return value
}

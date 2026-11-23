// Personal keys and service keys: bearer secrets for clients that cannot run
// OAuth, such as Claude Code with a pasted key or a tenant's own integration.
// Each is a seat at one door. The secret is shown once and stored only as its
// SHA-256; the record is found by that hash and expires in KV on its own.
//
// Its own entry, `@omazyai/sdk/oauth/keys`: it loads neither the OAuth
// provider nor `cloudflare:workers`, so a Node script or a plain test can mint
// a key. `@omazyai/sdk/oauth` re-exports it.
//
// Revocation. A key record lives in KV, and each location reads KV through a
// cache for up to about 60 seconds, so a key deleted in one location still
// resolves in another for that long, and `transferService` there can write it
// back. KV's listing lags by about as long, so a key minted a moment ago can
// be missing from `list` and `revokeOwned`. Given a consistent store (the
// refresh store's Durable Object or D1), a revoked key gets a tombstone there,
// checked by `resolve`, `list` and `transferService`, every key is entered in
// its owner's index there when it is minted, and `resolve` refuses a key made
// before a revocation of its owner (`personLostRole`). Without a store the
// keys work as before, with that window.

import type { Principal, Seat } from '../capabilities/capability.js'
import { isTier, type Tier, tierRank } from '../capabilities/tiers.js'
import { b64url, sha256Hex } from '../guard/crypto.js'
import type { SeatGrant } from '../mcp/server.js'
import { KV_MIN_TTL, KV_PREFIX, type KvLike, listAll, SAFE_ID, wholeNumber } from './kv.js'
import { type KeyStore, keyTombstone, personIndex, revocationCovers } from './refresh.js'

export { type KvLike, type KvListResult, type KvPutOptions, memoryKv } from './kv.js'
export {
  applyOAuthD1Migrations,
  d1RefreshStore,
  durableObjectRefreshStore,
  type IndexEntry,
  type KeyStore,
  kvRefreshStore,
  OAUTH_D1_MIGRATIONS,
  OAuthRefreshLock,
  type PersonRevocation,
  type RefreshStore,
} from './refresh.js'

export const PERSONAL_MAX_DAYS = 90
export const SERVICE_MAX_DAYS = 365
/** The highest tier a personal key may ever reach, whatever the product configures. */
export const PERSONAL_TIER_CAP: Tier = 'R2'
/** A service key's tier cap unless the product sets another. */
export const SERVICE_DEFAULT_TIER: Tier = 'R2'
/** The highest service key cap unless the product sets `keys.service.allowR4`. */
export const SERVICE_TIER_CAP: Tier = 'R3'

export interface KeyOptions<D extends string> {
  personal?: {
    /** The prefix of a personal key for a door, such as `joya_mcp_platform_`. Lowercase letters, digits and `_`, ending in `_`. */
    prefix: (door: D) => string
    /** At most 90. Default 90. */
    maxDays?: number
    /** At most R2. Default R2. */
    maxTier?: Tier
  }
  service?: {
    prefix: (door: D) => string
    /** At most 365. Default 365. */
    maxDays?: number
    /** The tier cap of every service key. Default R2; a product may set another tier explicitly, up to R3. */
    maxTier?: Tier
    /** Lets `maxTier` be R4. Without it, R4 throws at start: a key that can do the most dangerous things outlives any session. */
    allowR4?: boolean
    /**
     * Platform doors (no tenant seats) that take service keys. A service key
     * at any other platform door is refused: its tenant would mean nothing there.
     */
    platformDoors?: readonly D[]
  }
}

export type KeyKind = 'personal' | 'service'

/** A key as listed: never the secret, never its hash. */
export interface KeyInfo {
  id: string
  kind: KeyKind
  name: string
  door: string
  tenant: string | null
  /** The person who made it and answers for it. */
  owner: string
  createdAt: number
  expiresAt: number
  maxTier?: Tier
  tools?: readonly string[]
}

interface KeyRecord extends KeyInfo {
  principal: Principal
  seat: Seat
  /** When the current owner took a moved service key. A revocation of the owner covers the key only if it came after. */
  ownedSince?: number
}

const DAY = 86_400_000
const SEEN_MAX = 10_000
const recordKey = (hash: string) => `${KV_PREFIX}key:${hash}`
const ownerIndex = (owner: string, id?: string) => `${KV_PREFIX}keys:${owner}:${id ?? ''}`
const tenantIndex = (tenant: string, id?: string) => `${KV_PREFIX}tkeys:${tenant}:${id ?? ''}`
const lastUseKey = (id: string) => `${KV_PREFIX}lastuse:${id}`

const PREFIX = /^[a-z][a-z0-9_]{1,40}_$/

function checkPrefix(p: string): string {
  if (!PREFIX.test(p)) throw new Error(`oauth: key prefix "${p}" must be lowercase letters, digits and _, ending in _`)
  return p
}

function lifetime(days: number | undefined, max: number): number {
  const d = days ?? max
  if (!Number.isFinite(d) || d <= 0) throw new Error('oauth: a key must expire in a positive number of days')
  if (d > max) throw new Error(`oauth: a key may last at most ${max} days`)
  return d
}

function capTier(asked: Tier | undefined, cap: Tier | undefined): Tier | undefined {
  if (asked !== undefined && !isTier(asked)) throw new Error(`oauth: unknown tier ${String(asked)}`)
  if (!cap) return asked
  if (asked === undefined) return cap
  if (tierRank(asked) > tierRank(cap)) throw new Error(`oauth: this key may reach at most ${cap}`)
  return asked
}

export interface CreatedKey {
  /** The secret. Show it once; it cannot be read again. */
  key: string
  info: KeyInfo
}

export class Keys<D extends string> {
  private readonly personalMax: number
  private readonly personalTier: Tier
  private readonly serviceMax: number
  private readonly serviceTier: Tier
  private readonly seen = new Map<string, number>()
  private readonly prefixes: string[] = []

  constructor(
    private readonly kv: KvLike,
    private readonly doors: readonly D[],
    private readonly opts: KeyOptions<D>,
    /** Doors whose seats have no tenant. Service keys are refused there unless `service.platformDoors` lists the door. */
    private readonly platformDoors: readonly D[] = [],
    /**
     * A consistent store (the refresh store's Durable Object or D1) for key
     * tombstones, the owner index and person revocations. Optional: without
     * one a revoked key keeps resolving for about 60 seconds in a location
     * whose KV cache holds it, and a key minted in the last minute may be
     * missing from `list` and `revokeOwned`.
     */
    private readonly revocations?: KeyStore,
  ) {
    // A misspelt tier would rank above R4 and cap nothing, so it throws.
    for (const [kind, t] of [
      ['personal', opts.personal?.maxTier],
      ['service', opts.service?.maxTier],
    ] as const)
      if (t !== undefined && !isTier(t)) throw new Error(`oauth: ${kind} key maxTier ${String(t)} is not a tier (R0 to R4)`)
    if (opts.service?.maxTier !== undefined && tierRank(opts.service.maxTier) > tierRank(SERVICE_TIER_CAP) && opts.service.allowR4 !== true)
      throw new Error(`oauth: service key maxTier ${opts.service.maxTier} is above ${SERVICE_TIER_CAP}; set keys.service.allowR4 to accept that`)
    for (const d of opts.service?.platformDoors ?? []) if (!platformDoors.includes(d)) throw new Error(`oauth: service.platformDoors names ${d}, which is not a platform door`)
    this.personalMax = Math.min(wholeNumber('keys.personal.maxDays', opts.personal?.maxDays) ?? PERSONAL_MAX_DAYS, PERSONAL_MAX_DAYS)
    const tier = opts.personal?.maxTier ?? PERSONAL_TIER_CAP
    this.personalTier = tierRank(tier) > tierRank(PERSONAL_TIER_CAP) ? PERSONAL_TIER_CAP : tier
    this.serviceMax = Math.min(wholeNumber('keys.service.maxDays', opts.service?.maxDays) ?? SERVICE_MAX_DAYS, SERVICE_MAX_DAYS)
    this.serviceTier = opts.service?.maxTier ?? SERVICE_DEFAULT_TIER
    const prefixes = new Set<string>()
    for (const d of doors) {
      for (const p of [opts.personal?.prefix(d), opts.service?.prefix(d)]) {
        if (p === undefined) continue
        checkPrefix(p)
        for (const q of prefixes) if (p.startsWith(q) || q.startsWith(p)) throw new Error(`oauth: key prefixes "${p}" and "${q}" overlap`)
        prefixes.add(p)
      }
    }
    this.prefixes = [...prefixes]
  }

  private door(d: string): D {
    if (!(this.doors as readonly string[]).includes(d)) throw new Error(`oauth: unknown door ${d}`)
    return d as D
  }

  private async store(prefix: string, rec: Omit<KeyRecord, 'id'>, id: string): Promise<CreatedKey> {
    const secret = `${prefix}${b64url(crypto.getRandomValues(new Uint8Array(32)))}`
    const hash = await sha256Hex(secret)
    const record: KeyRecord = { ...rec, id }
    const expiration = Math.floor(record.expiresAt / 1000) + KV_MIN_TTL
    // Indexed first: a key that is in KV is in its owner's index, so a revocation finds it at once.
    await this.indexKey(record, hash)
    await this.kv.put(recordKey(hash), JSON.stringify(record), { expiration })
    await this.kv.put(ownerIndex(record.owner, id), hash, { expiration })
    if (record.kind === 'service' && record.tenant) await this.kv.put(tenantIndex(record.tenant, id), hash, { expiration })
    return { key: secret, info: infoOf(record) }
  }

  /**
   * A personal key: the person's own seat at one door, at most R2 and 90 days.
   * The product checks the person holds the seat before calling this.
   */
  async createPersonal(input: { principal: Principal; seat: Seat; name: string; days?: number; maxTier?: Tier }): Promise<CreatedKey> {
    if (!this.opts.personal) throw new Error('oauth: personal keys are not configured')
    const door = this.door(input.seat.door)
    if (input.seat.tenant === null && !this.platformDoors.includes(door)) throw new Error(`oauth: ${door} is not a platform door; a seat there needs a tenant`)
    if (!SAFE_ID.test(input.principal.id)) throw new Error('oauth: the principal id has characters a key cannot carry')
    const days = lifetime(input.days, this.personalMax)
    const maxTier = capTier(input.maxTier, this.personalTier)!
    const now = Date.now()
    return this.store(
      this.opts.personal.prefix(door),
      {
        kind: 'personal',
        name: input.name.slice(0, 80),
        door,
        tenant: input.seat.tenant,
        owner: input.principal.id,
        createdAt: now,
        expiresAt: now + days * DAY,
        maxTier,
        principal: input.principal,
        seat: input.seat,
      },
      `pk_${randomId()}`,
    )
  }

  /**
   * A service key: a `service` principal in one tenant, limited to a list of
   * tools, at most 365 days. The owner is the person who minted it; it is
   * revoked with them unless it is moved to another owner first.
   */
  async createService(input: { owner: Principal; tenant: string; door: D; tools: readonly string[]; name: string; days?: number; maxTier?: Tier }): Promise<CreatedKey> {
    if (!this.opts.service) throw new Error('oauth: service keys are not configured')
    const door = this.door(input.door)
    if (this.platformDoors.includes(door) && !(this.opts.service.platformDoors ?? []).includes(door))
      throw new Error(`oauth: ${door} is a platform door; service keys are refused there unless keys.service.platformDoors lists it`)
    if (!input.tenant) throw new Error('oauth: a service key belongs to one tenant')
    if (!SAFE_ID.test(input.owner.id) || !SAFE_ID.test(input.tenant)) throw new Error('oauth: the owner or tenant id has characters a key cannot carry')
    const tools = [...new Set(input.tools)].filter((t) => typeof t === 'string' && t.length > 0)
    if (tools.length === 0) throw new Error('oauth: a service key needs an allow list of tools')
    const days = lifetime(input.days, this.serviceMax)
    const maxTier = capTier(input.maxTier, this.serviceTier)
    const id = `sk_${randomId()}`
    const now = Date.now()
    const name = input.name.slice(0, 80)
    return this.store(
      this.opts.service.prefix(door),
      {
        kind: 'service',
        name,
        door,
        tenant: input.tenant,
        owner: input.owner.id,
        createdAt: now,
        expiresAt: now + days * DAY,
        ...(maxTier ? { maxTier } : {}),
        tools,
        principal: { kind: 'service', id, name },
        seat: { id, door, tenant: input.tenant },
      },
      id,
    )
  }

  /** Whether a bearer token is shaped like one of this door's keys. A key never holds `:`; a library token always does. */
  isKey(token: string, door: D): boolean {
    if (token.includes(':')) return false
    const p = this.opts.personal?.prefix(door)
    const s = this.opts.service?.prefix(door)
    return (!!p && token.startsWith(p)) || (!!s && token.startsWith(s))
  }

  /** Whether an id starts with any key prefix of any door. Such a person id is refused at sign-in. */
  hasKeyPrefix(id: string): boolean {
    return this.prefixes.some((p) => id.startsWith(p))
  }

  private async indexKey(rec: KeyRecord, hash: string): Promise<void> {
    if (!this.revocations) return
    await this.revocations.indexPut(personIndex(rec.owner), { kind: 'key', id: rec.id, ref: hash, door: rec.door, tenant: rec.tenant, until: rec.expiresAt + KV_MIN_TTL * 1000 })
  }

  /** Whether the store says this key is revoked: a tombstone, or a revocation of its owner made after the owner took it. */
  private async revoked(rec: KeyRecord): Promise<boolean> {
    if (!this.revocations) return false
    const [grave, marks] = await Promise.all([this.revocations.tombstoned(keyTombstone(rec.id)), this.revocations.personRevocations(rec.owner)])
    return !!grave || revocationCovers(marks, { door: rec.door, tenant: rec.tenant, at: rec.ownedSince ?? rec.createdAt })
  }

  /** Finds the seat a key holds at this door, or null when it is unknown, expired, revoked or for another door. */
  async resolve(token: string, door: D): Promise<{ grant: SeatGrant; info: KeyInfo } | null> {
    if (!this.isKey(token, door) || token.length > 200) return null
    const rec = (await this.kv.get(recordKey(await sha256Hex(token)), { type: 'json' })) as KeyRecord | null
    if (!rec || rec.door !== door || rec.expiresAt <= Date.now()) return null
    const expected = rec.kind === 'personal' ? this.opts.personal?.prefix(door) : this.opts.service?.prefix(door)
    if (!expected || !token.startsWith(expected)) return null
    if (await this.revoked(rec)) return null
    let maxTier = rec.maxTier
    // A key never reaches past today's cap for its kind, even one minted under a looser setting.
    const cap = rec.kind === 'personal' ? this.personalTier : this.serviceTier
    if (!maxTier || !isTier(maxTier) || tierRank(maxTier) > tierRank(cap)) maxTier = cap
    const grant: SeatGrant = {
      principal: rec.principal,
      seat: rec.seat,
      ...(maxTier ? { maxTier } : {}),
      ...(rec.kind === 'service' ? { tools: rec.tools ?? [] } : {}),
    }
    return { grant, info: infoOf(rec) }
  }

  /** Writes last use at most every five minutes per key and isolate. The isolate remembers at most 10,000 ids, oldest dropped first. */
  async touch(id: string): Promise<void> {
    const now = Date.now()
    if ((this.seen.get(id) ?? 0) > now - 300_000) return
    this.seen.delete(id)
    while (this.seen.size >= SEEN_MAX) this.seen.delete(this.seen.keys().next().value!)
    this.seen.set(id, now)
    await this.kv.put(lastUseKey(id), String(now), { expirationTtl: SERVICE_MAX_DAYS * 86_400 })
  }

  async lastUse(id: string): Promise<number | null> {
    const v = await this.kv.get(lastUseKey(id))
    return v ? Number(v) : null
  }

  /**
   * The keys under a person's KV index and, with a store, their index there,
   * which also holds a key minted a moment ago that KV's listing misses.
   */
  private async owned(owner: string): Promise<(KeyRecord & { hash: string })[]> {
    const [listed, entries] = await Promise.all([
      listAll(this.kv, ownerIndex(owner)),
      this.revocations ? this.revocations.indexList(personIndex(owner)) : Promise.resolve([]),
    ])
    const seen = new Set<string>()
    const out: (KeyRecord & { hash: string })[] = []
    const add = (rec: (KeyRecord & { hash: string }) | null) => {
      if (rec && rec.owner === owner && !seen.has(rec.id)) {
        seen.add(rec.id)
        out.push(rec)
      }
    }
    for (const rec of await Promise.all(listed.map((k) => this.recordAt(k.name)))) add(rec)
    const missing = entries.filter((e) => e.kind === 'key' && e.ref && !seen.has(e.id))
    for (const rec of await Promise.all(missing.map((e) => this.recordByHash(e.ref!)))) add(rec)
    return out
  }

  /** Every live key a person owns. */
  async list(owner: string): Promise<(KeyInfo & { lastUsedAt: number | null })[]> {
    const recs = await this.owned(owner)
    const gone = await Promise.all(recs.map((r) => this.revoked(r)))
    const live = recs.filter((_, i) => !gone[i])
    return Promise.all(live.map(async (rec) => ({ ...infoOf(rec), lastUsedAt: await this.lastUse(rec.id) })))
  }

  /** Every live service key of a tenant. Its index is a KV listing, so a key minted in the last minute may be missing. */
  async listService(tenant: string): Promise<(KeyInfo & { lastUsedAt: number | null })[]> {
    const out: (KeyInfo & { lastUsedAt: number | null })[] = []
    for (const k of await listAll(this.kv, tenantIndex(tenant))) {
      const rec = await this.recordAt(k.name)
      if (rec && rec.tenant === tenant && !(await this.revoked(rec))) out.push({ ...infoOf(rec), lastUsedAt: await this.lastUse(rec.id) })
    }
    return out
  }

  private async recordAt(indexKey: string): Promise<(KeyRecord & { hash: string }) | null> {
    const hash = await this.kv.get(indexKey)
    return hash ? this.recordByHash(hash) : null
  }

  private async recordByHash(hash: string): Promise<(KeyRecord & { hash: string }) | null> {
    const rec = (await this.kv.get(recordKey(hash), { type: 'json' })) as KeyRecord | null
    if (!rec || rec.expiresAt <= Date.now()) return null
    return { ...rec, hash }
  }

  /** One key the owner holds, through KV or, with a store, the owner's index there. */
  private async ownedKey(owner: string, id: string): Promise<(KeyRecord & { hash: string }) | null> {
    const rec = await this.recordAt(ownerIndex(owner, id))
    if (rec) return rec
    if (!this.revocations) return null
    const e = (await this.revocations.indexList(personIndex(owner))).find((x) => x.kind === 'key' && x.id === id && x.ref)
    return e ? this.recordByHash(e.ref!) : null
  }

  /** Revokes one key the owner holds. Returns false when there is no such key. */
  async revoke(owner: string, id: string): Promise<boolean> {
    const rec = await this.ownedKey(owner, id)
    if (!rec || rec.owner !== owner) return false
    await this.drop(rec)
    return true
  }

  /** Tombstone first, with a store: once it is written, no location resolves or moves the key, whatever its cache holds. */
  private async drop(rec: KeyRecord & { hash: string }): Promise<void> {
    if (this.revocations) {
      const ttl = Math.max(KV_MIN_TTL, Math.ceil((rec.expiresAt - Date.now()) / 1000) + 3600)
      await this.revocations.tombstone(keyTombstone(rec.id), { userId: rec.owner, grantId: rec.id }, ttl)
    }
    await this.kv.delete(recordKey(rec.hash))
    await this.kv.delete(ownerIndex(rec.owner, rec.id))
    if (rec.tenant) await this.kv.delete(tenantIndex(rec.tenant, rec.id))
    await this.kv.delete(lastUseKey(rec.id))
    await this.revocations?.indexDelete(personIndex(rec.owner), rec.id).catch(() => undefined)
  }

  /** Revokes the keys a person owns, optionally only at one door or tenant. Returns how many. */
  async revokeOwned(owner: string, filter: { door?: string; tenant?: string; kind?: KeyKind } = {}): Promise<number> {
    let n = 0
    for (const rec of await this.owned(owner)) {
      if (filter.door && rec.door !== filter.door) continue
      if (filter.tenant && rec.tenant !== filter.tenant) continue
      if (filter.kind && rec.kind !== filter.kind) continue
      await this.drop(rec)
      n++
    }
    return n
  }

  /**
   * Moves a service key to another owner in the same tenant, when an owner
   * leaves and another re-confirms the key. The product checks the new owner
   * may hold it. False for a key that is unknown, not a service key, not the
   * owner's or, with a store, revoked: a location whose KV cache still holds
   * a revoked key would otherwise write it back.
   */
  async transferService(fromOwner: string, id: string, to: Principal): Promise<boolean> {
    if (!SAFE_ID.test(to.id)) throw new Error('oauth: the owner id has characters a key cannot carry')
    const rec = await this.ownedKey(fromOwner, id)
    if (!rec || rec.kind !== 'service' || rec.owner !== fromOwner) return false
    if (await this.revoked(rec)) return false
    const { hash, ...plain } = rec
    const next: KeyRecord = { ...plain, owner: to.id, ownedSince: Date.now() }
    const expiration = Math.floor(next.expiresAt / 1000) + KV_MIN_TTL
    await this.indexKey(next, hash)
    await this.kv.put(recordKey(hash), JSON.stringify(next), { expiration })
    await this.kv.put(ownerIndex(to.id, id), hash, { expiration })
    await this.kv.delete(ownerIndex(fromOwner, id))
    await this.revocations?.indexDelete(personIndex(fromOwner), id).catch(() => undefined)
    return true
  }
}

function infoOf(r: KeyRecord): KeyInfo {
  return {
    id: r.id,
    kind: r.kind,
    name: r.name,
    door: r.door,
    tenant: r.tenant,
    owner: r.owner,
    createdAt: r.createdAt,
    expiresAt: r.expiresAt,
    ...(r.maxTier ? { maxTier: r.maxTier } : {}),
    ...(r.tools ? { tools: r.tools } : {}),
  }
}

function randomId(): string {
  return b64url(crypto.getRandomValues(new Uint8Array(12)))
}

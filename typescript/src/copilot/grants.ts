// Standing grants. A person may let the copilot run one named R2 capability
// without a consent card: for at most 90 days, at most a set number of times a
// day (UTC), and only in their own tenant. A grant is set through `grants.set`
// from a settings page (a channel where a person acts, `console` by default),
// never by the copilot or a model, and never for R3 or R4: an approval cannot
// be waived. A call whose tier for its arguments is not R2 is never covered.

import type { BaseCtx } from '../capabilities/capability.js'
import type { Registry } from '../capabilities/registry.js'
import type { Tier } from '../capabilities/tiers.js'
import type { D1DatabaseLike } from '../guard/d1.js'

export interface StandingGrant {
  id: string
  tenant: string | null
  person: string
  capability: string
  grantedAt: string
  expiresAt: string
  /** Runs allowed per UTC day. */
  dailyCap: number
  revokedAt: string | null
}

export interface GrantOwner {
  tenant: string | null
  person: string
}

export interface GrantStore {
  insert(g: StandingGrant): Promise<void>
  /** The newest unrevoked grant of this owner for this capability that has not expired at `at`. */
  active(owner: GrantOwner, capability: string, at: string): Promise<StandingGrant | null>
  /** Every grant of this owner, newest first. */
  list(owner: GrantOwner): Promise<StandingGrant[]>
  /** Revokes a grant of this owner. False when there is none to revoke. */
  revoke(owner: GrantOwner, id: string, at: string): Promise<boolean>
  /** Runs counted on this grant on this day (`YYYY-MM-DD`). */
  used(id: string, day: string): Promise<number>
  /** Counts one run when the day's count is below `cap`. Atomic: true at most `cap` times a day. */
  take(id: string, day: string, cap: number): Promise<boolean>
  /** Takes back one run counted on that day, never below zero. For a call the guard did not run. */
  untake(id: string, day: string): Promise<void>
}

/** One run counted on a grant, until the call it was taken for comes back. */
export interface GrantUse {
  grant: string
  /** The UTC day it was counted on. */
  day: string
}

/** At most this many days. */
export const MAX_GRANT_DAYS = 90
/** At most this many runs a day. */
export const MAX_GRANT_DAILY_CAP = 500
/** Channels where a person, not a model, acts. Only these may set a grant. */
export const DEFAULT_GRANT_CHANNELS: readonly string[] = ['console']

export type GrantRefusal = 'not_a_person' | 'unknown_capability' | 'not_r2' | 'bad_days' | 'bad_cap'

export type SetGrantResult = { ok: true; grant: StandingGrant } | { ok: false; reason: GrantRefusal; message: string }

export interface GrantsOptions<C extends BaseCtx = BaseCtx> {
  store: GrantStore
  registry: Registry<C, any, any>
  /** Default `['console']`. A copilot, actor, MCP or automation call never sets a grant. */
  channels?: readonly string[]
  /** The product's own rule for who may hold a grant for this capability, on top of the kit's. */
  canGrant?: (ctx: C, capability: string) => boolean | Promise<boolean>
  now?: () => number
  newId?: () => string
}

export interface Grants<C extends BaseCtx = BaseCtx> {
  readonly store: GrantStore
  /** The settings function. Replaces an earlier grant for the same capability. */
  set(ctx: C, input: { capability: string; days: number; dailyCap: number }): Promise<SetGrantResult>
  revoke(ctx: C, id: string): Promise<boolean>
  /** The person's grants, for the settings page. */
  list(ctx: C): Promise<StandingGrant[]>
  /** The grant that covers this call, when the call's tier is R2 and the grant is active. Does not count a run. */
  covering(ctx: C, capability: string, tier: Tier): Promise<StandingGrant | null>
  /** Runs left today on a grant. */
  left(grant: StandingGrant): Promise<number>
  /**
   * Holds one of today's runs before the call, so two calls at once cannot
   * pass the cap. Null when today's cap is reached. Give it back with
   * `release` unless the guard ran the call.
   */
  take(grant: StandingGrant): Promise<GrantUse | null>
  /** Gives back a run held by `take`: the call was refused or did not run, so it does not count. */
  release(use: GrantUse): Promise<void>
}

const DAY_MS = 86_400_000
const ownerOf = (ctx: BaseCtx): GrantOwner => ({ tenant: ctx.tenant, person: ctx.principal.id })

export function createGrants<C extends BaseCtx = BaseCtx>(o: GrantsOptions<C>): Grants<C> {
  const now = o.now ?? Date.now
  const iso = (ms = now()) => new Date(ms).toISOString()
  const day = () => iso().slice(0, 10)
  const newId = o.newId ?? (() => `grant_${crypto.randomUUID().replace(/-/g, '')}`)
  const channels = o.channels ?? DEFAULT_GRANT_CHANNELS
  if (channels.includes('copilot')) throw new Error('standing grants cannot be set from the copilot channel')
  const refuse = (reason: GrantRefusal, message: string): SetGrantResult => ({ ok: false, reason, message })

  return {
    store: o.store,
    async set(ctx, input) {
      if (!channels.includes(ctx.channel)) return refuse('not_a_person', 'A standing grant is set by a person on the settings page, not from this channel.')
      const cap = o.registry.get(input.capability)
      if (!cap) return refuse('unknown_capability', `There is no capability ${input.capability}.`)
      if (cap.risk !== 'R2') {
        return refuse('not_r2', `${input.capability} is ${cap.risk}. A standing grant is only for an R2 capability; R3 and R4 always need an approval, and reads need no grant.`)
      }
      if (!Number.isInteger(input.days) || input.days < 1 || input.days > MAX_GRANT_DAYS) return refuse('bad_days', `A standing grant lasts 1 to ${MAX_GRANT_DAYS} days.`)
      if (!Number.isInteger(input.dailyCap) || input.dailyCap < 1 || input.dailyCap > MAX_GRANT_DAILY_CAP) return refuse('bad_cap', `The daily cap is 1 to ${MAX_GRANT_DAILY_CAP} runs.`)
      if (o.canGrant && !(await o.canGrant(ctx, input.capability))) return refuse('not_a_person', `You may not hold a standing grant for ${input.capability}.`)
      const owner = ownerOf(ctx)
      const at = iso()
      const old = await o.store.active(owner, input.capability, at)
      if (old) await o.store.revoke(owner, old.id, at)
      const grant: StandingGrant = {
        id: newId(),
        tenant: ctx.tenant,
        person: ctx.principal.id,
        capability: input.capability,
        grantedAt: at,
        expiresAt: iso(now() + input.days * DAY_MS),
        dailyCap: input.dailyCap,
        revokedAt: null,
      }
      await o.store.insert(grant)
      return { ok: true, grant }
    },
    // Revoking is always allowed, from any channel: taking a permission back is never held up.
    revoke: (ctx, id) => o.store.revoke(ownerOf(ctx), id, iso()),
    list: (ctx) => o.store.list(ownerOf(ctx)),
    async covering(ctx, capability, tier) {
      if (tier !== 'R2') return null
      if (o.registry.get(capability)?.risk !== 'R2') return null
      return o.store.active(ownerOf(ctx), capability, iso())
    },
    async left(grant) {
      return Math.max(0, grant.dailyCap - (await o.store.used(grant.id, day())))
    },
    async take(grant) {
      const d = day()
      return (await o.store.take(grant.id, d, grant.dailyCap)) ? { grant: grant.id, day: d } : null
    },
    release: (use) => o.store.untake(use.grant, use.day),
  }
}

// ---------------------------------------------------------------- memory

export function memoryGrantStore(): GrantStore & { readonly rows: Map<string, StandingGrant> } {
  const rows = new Map<string, StandingGrant>()
  const uses = new Map<string, number>()
  const mine = (o: GrantOwner, g: StandingGrant) => g.tenant === o.tenant && g.person === o.person
  return {
    rows,
    async insert(g) {
      rows.set(g.id, { ...g })
    },
    async active(o, capability, at) {
      const live = [...rows.values()].filter((g) => mine(o, g) && g.capability === capability && !g.revokedAt && g.expiresAt > at)
      live.sort((a, b) => b.grantedAt.localeCompare(a.grantedAt))
      return live[0] ? { ...live[0] } : null
    },
    async list(o) {
      return [...rows.values()].filter((g) => mine(o, g)).sort((a, b) => b.grantedAt.localeCompare(a.grantedAt)).map((g) => ({ ...g }))
    },
    async revoke(o, id, at) {
      const g = rows.get(id)
      if (!g || !mine(o, g) || g.revokedAt) return false
      g.revokedAt = at
      return true
    },
    async used(id, d) {
      return uses.get(`${id}|${d}`) ?? 0
    },
    async take(id, d, cap) {
      const k = `${id}|${d}`
      const n = uses.get(k) ?? 0
      if (n >= cap) return false
      uses.set(k, n + 1)
      return true
    },
    async untake(id, d) {
      const k = `${id}|${d}`
      const n = uses.get(k) ?? 0
      if (n > 0) uses.set(k, n - 1)
    },
  }
}

// ---------------------------------------------------------------- D1

/** The grants tables. Additive only. */
export const GRANT_MIGRATIONS: readonly { id: string; sql: string }[] = Object.freeze([
  {
    id: '0001_copilot_grants',
    sql: `
CREATE TABLE IF NOT EXISTS copilot_grants (
  id TEXT PRIMARY KEY,
  tenant_key TEXT NOT NULL,
  person TEXT NOT NULL,
  capability TEXT NOT NULL,
  granted_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  daily_cap INTEGER NOT NULL,
  revoked_at TEXT
);
CREATE INDEX IF NOT EXISTS copilot_grants_owner ON copilot_grants (tenant_key, person, capability);
CREATE TABLE IF NOT EXISTS copilot_grant_uses (
  grant_id TEXT NOT NULL,
  day TEXT NOT NULL,
  n INTEGER NOT NULL,
  PRIMARY KEY (grant_id, day)
);
`,
  },
])

export const grantMigrationSql = (): string => GRANT_MIGRATIONS.map((m) => `-- ${m.id}\n${m.sql.trim()}\n`).join('\n')

export async function applyGrantMigrations(db: D1DatabaseLike): Promise<void> {
  const stmts = GRANT_MIGRATIONS.flatMap((m) => m.sql.split(';'))
    .map((s) => s.trim())
    .filter(Boolean)
  await db.batch(stmts.map((s) => db.prepare(s)))
}

type GrantRow = { id: string; tenant_key: string; person: string; capability: string; granted_at: string; expires_at: string; daily_cap: number; revoked_at: string | null }
const tk = (t: string | null) => t ?? ''
const decode = (r: GrantRow): StandingGrant => ({
  id: r.id,
  tenant: r.tenant_key === '' ? null : r.tenant_key,
  person: r.person,
  capability: r.capability,
  grantedAt: r.granted_at,
  expiresAt: r.expires_at,
  dailyCap: r.daily_cap,
  revokedAt: r.revoked_at,
})

export function d1GrantStore(db: D1DatabaseLike): GrantStore {
  return {
    async insert(g) {
      await db
        .prepare('INSERT INTO copilot_grants (id, tenant_key, person, capability, granted_at, expires_at, daily_cap, revoked_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
        .bind(g.id, tk(g.tenant), g.person, g.capability, g.grantedAt, g.expiresAt, g.dailyCap, g.revokedAt)
        .run()
    },
    async active(o, capability, at) {
      const r = await db
        .prepare(
          'SELECT * FROM copilot_grants WHERE tenant_key = ? AND person = ? AND capability = ? AND revoked_at IS NULL AND expires_at > ? ORDER BY granted_at DESC LIMIT 1',
        )
        .bind(tk(o.tenant), o.person, capability, at)
        .first<GrantRow>()
      return r ? decode(r) : null
    },
    async list(o) {
      const r = await db.prepare('SELECT * FROM copilot_grants WHERE tenant_key = ? AND person = ? ORDER BY granted_at DESC LIMIT 200').bind(tk(o.tenant), o.person).all<GrantRow>()
      return (r.results ?? []).map(decode)
    },
    async revoke(o, id, at) {
      const r = await db
        .prepare('UPDATE copilot_grants SET revoked_at = ? WHERE id = ? AND tenant_key = ? AND person = ? AND revoked_at IS NULL')
        .bind(at, id, tk(o.tenant), o.person)
        .run()
      return (r.meta?.changes ?? 0) === 1
    },
    async used(id, d) {
      const r = await db.prepare('SELECT n FROM copilot_grant_uses WHERE grant_id = ? AND day = ?').bind(id, d).first<{ n: number }>()
      return r?.n ?? 0
    },
    async take(id, d, cap) {
      if (cap < 1) return false
      // One statement: insert the first run of the day, or count one more while below the cap.
      const r = await db
        .prepare('INSERT INTO copilot_grant_uses (grant_id, day, n) VALUES (?, ?, 1) ON CONFLICT (grant_id, day) DO UPDATE SET n = n + 1 WHERE copilot_grant_uses.n < ?')
        .bind(id, d, cap)
        .run()
      return (r.meta?.changes ?? 0) === 1
    },
    async untake(id, d) {
      await db.prepare('UPDATE copilot_grant_uses SET n = n - 1 WHERE grant_id = ? AND day = ? AND n > 0').bind(id, d).run()
    },
  }
}

// An MCP authorization server a product mounts beside its MCP doors, on
// Cloudflare's Workers OAuth provider (pinned exactly). The library does the
// OAuth protocol: metadata, the token endpoint, PKCE checks, resource-bound
// grants, hashed storage, CIMD and optional DCR. This kit adds what the
// library leaves to the application, and which is where its own advisories
// were: the consent page, the client allow list per door, the sign-in hand-off
// to the product, refresh family revocation, keys, connected apps, and the
// rule that a token names only a seat and a door while permissions are read
// live through the guard on every call.

import {
  type AuthRequest,
  AuthorizationError,
  authorizationErrorRedirect,
  CimdFetchError,
  OAuthAuthorizationServer,
  type OAuthHelpers,
} from '@cloudflare/workers-oauth-provider'
import type { Principal, Seat } from '../capabilities/capability.js'
import { sha256Hex } from '../guard/crypto.js'
import type { RateLimitBinding } from '../guard/ratelimit.js'
import type { SeatGrant } from '../mcp/server.js'
import { type ClientStatus, consentPage, messagePage, newNonce, pageHeaders } from './consent.js'
import { type KeyInfo, type KeyOptions, Keys } from './keys.js'
import { bump, KV_MIN_TTL, type KvLike, peek, SAFE_ID } from './kv.js'
import { kvRefreshStore, type RefreshStore } from './refresh.js'
import { CLIENT_AUTH_PARAMS, tokenForm, tokenRequestClient } from './token-request.js'

/** The one scope the server grants. It means "this seat at this door"; what the seat may do is read live. */
export const OAUTH_SCOPE = 'mcp'
export const ACCESS_TTL_SECONDS = 3600
export const REFRESH_TTL_SECONDS = 30 * 86_400

/** What to do with a client at a door. */
export interface ClientPolicy {
  /**
   * Exact client ids the product knows: the full URL of a Client ID Metadata
   * Document (`https://claude.ai/oauth/mcp-oauth-client-metadata`) or the id
   * of a pre-registered client. Never a bare domain: any document on a
   * domain, or any client that can redirect through it, would pass.
   */
  known?: readonly string[]
  /**
   * Opt in: metadata document hosts to treat as known, such as `claude.ai`.
   * A client on one is known only when every redirect URI it lists is on its
   * own host or under it (or a loopback address). Refused on a platform door.
   */
  knownDomains?: readonly string[]
  /** Clients with a verified metadata document that are not known. Default `allow`, and `block` at a platform door. */
  others?: 'allow' | 'block'
  /** Clients with no metadata document (dynamic registration, or pre-registered and not on the list). Default `block`. */
  unverified?: 'allow' | 'block'
  /**
   * Lets a platform door take clients that are not on its `known` list
   * (`others` or `unverified` set to `allow`), or run with an empty list.
   * Without it either throws at start: a platform door hands out tokens for
   * operator seats, and any metadata document can call itself "Claude".
   */
  dangerouslyAllowUnlistedClients?: boolean
}

/** A security event the product may alert on. Never carries a token. */
export type OAuthEvent =
  | { type: 'refresh_reuse'; userId: string; grantId: string }
  | { type: 'code_reuse'; userId: string; grantId: string }
  | { type: 'refresh_contended'; userId: string; grantId: string }
  | { type: 'client_blocked'; door: string; clientId: string; status: ClientStatus }
  | { type: 'client_metadata_refused'; clientId: string; reason: 'redirect' | 'unreadable' | 'mismatch' }
  // `ip` is the bucket that ran out: an IPv4 address, an IPv6 /64 such as `2001:db8:1:2::/64`, or a /48 such as `2001:db8:1::/48`.
  | { type: 'registration_limited'; ip: string }
  | { type: 'authorize_limited'; ip: string }
  | { type: 'token_limited'; ip: string }
  | { type: 'turnstile_failed'; ip: string }
  | { type: 'sign_in_failed'; door: string; reason: 'no_code' | 'refused' | 'error' | 'bad_person' | 'no_seat' | 'tenantless_seat' }
  | { type: 'request_refused'; reason: 'resource_missing' | 'pkce_missing' | 'no_address' }
  | { type: 'oauth_error'; code: string; reason: string }

export interface AuthorizationServerOptions<D extends string> {
  /** The issuer, such as `https://mcp.getjoya.ai`. The kit serves `/authorize`, `/oauth/callback`, `/oauth/token` and `/oauth/register` under it. */
  issuer: string
  /** The KV namespace for the library's records and the kit's. */
  kv: KvLike
  /** Each door and its canonical resource URL, such as `{ platform: 'https://mcp.getjoya.ai/platform' }`. */
  doors: Record<D, string>
  /** Shown on the consent page. */
  productName: string
  /** Names for the doors on the consent page, such as `{ org: 'your organisation' }`. */
  doorLabels?: Partial<Record<D, string>>
  /** The product's sign-in. The kit never owns identity. */
  signIn: {
    /**
     * The product's sign-in page. The kit adds `state`, `door` and `return_to`.
     * The page checks `return_to` is exactly the server's `callbackUrl`, and
     * when the person is signed in sends the browser there with the same
     * `state` and a one-time `code` issued for that state, or with
     * `error=access_denied`, after one click: a form POST when the page is
     * on the issuer's own site (the flow cookie is SameSite=Lax), a GET link
     * when it is on another site.
     */
    url: string | ((door: D) => string)
    /**
     * Redeems the one-time code over the back channel. `state` is the state
     * the callback carried, already checked against this browser's cookie:
     * refuse a code that was not issued for it (`signInCodes` does), or a
     * leaked code finishes an attacker's flow as the victim. Null when the
     * code is unknown, used, expired or for another state.
     */
    authenticate: (code: string, state: string, req: Request) => Principal | null | Promise<Principal | null>
  }
  /** Which seat this person takes at this door: for a tenant door, which tenant. Null refuses. */
  chooseSeat: (person: Principal, door: D, req: Request) => Seat | null | Promise<Seat | null>
  /**
   * Checked on every call before a seat is used: return false when the seat
   * is gone (the person left the tenant, lost the platform role). Permissions
   * themselves are read by the guard's `can()` on every call. Required when
   * there is a platform door; without it the kit warns at start.
   */
  checkSeat?: (grant: SeatGrant, door: D, req: Request) => boolean | Promise<boolean>
  /**
   * Client policy per door. A tenant door without one allows verified
   * clients and blocks unverified ones. A platform door needs one, with a
   * non-empty `known` list, and blocks every other client.
   */
  clients?: Partial<Record<D, ClientPolicy>>
  /**
   * Required. Doors whose seats have no tenant: an operator or super admin
   * door. Stricter rules hold there, and a seat without a tenant is refused
   * at every other door. Pass `[]` when there is none. The kit never guesses
   * from a door's name.
   */
  platformDoors: readonly D[]
  /**
   * RFC 7591 dynamic registration, deprecated by MCP 2026-07-28. Off unless
   * enabled. `perHourPerIp` (default 10) counts per address bucket;
   * `perHourPer48` (default ten times that) counts per IPv6 /48.
   */
  registration?: { enabled: boolean; perHourPerIp?: number; perHourPer48?: number; clientTtlDays?: number }
  /** Client ID Metadata Documents. On by default; needs the `global_fetch_strictly_public` compatibility flag. */
  clientMetadataDocuments?: boolean
  /**
   * Whether a metadata document that stops answering (404, 5xx, a timeout)
   * is replaced by the last copy that validated. Default `false`: a document
   * its owner withdraws stops working at once. `{ maxAgeSeconds }` (60 to
   * 3600) keeps a copy that long, to ride out a client's outage; a 410
   * always deletes it.
   */
  clientMetadataFallback?: false | { maxAgeSeconds: number }
  /**
   * The product's rate limits, as Workers Rate Limiting bindings. `authorize`
   * counts every GET /authorize per address (key `authorize:<ip>`) before any
   * work, since each one writes to KV unauthenticated. `token` counts every
   * POST to the token endpoint per address (key `token:<ip>`) before the body
   * is read. Without either the kit warns at start. An IPv6 address counts
   * by its /64, since one host is handed a whole /64, and a 6to4 address
   * (2002::/16) as the IPv4 address it carries. `authorizePer48` and
   * `tokenPer48` count an IPv6 address by its /48 as well (keys
   * `authorize:<p>::/48`, `token:<p>::/48`), since one tunnel or hosting
   * account can hold a whole /48 and with it 65,536 /64 buckets: bind them
   * with a higher limit than `authorize` and `token`. Without them the kit
   * warns at start. MCP clients hosted on Workers reach you from
   * Cloudflare's own addresses, which many such clients share: size the
   * limits for that.
   */
  rateLimit?: { authorize?: RateLimitBinding; token?: RateLimitBinding; authorizePer48?: RateLimitBinding; tokenPer48?: RateLimitBinding }
  /**
   * The request header that carries the caller's address, for rate limits,
   * registration counts and Turnstile. Default `cf-connecting-ip`, which
   * Cloudflare sets on every request from the internet. Name another only
   * when your own front sets it and a caller cannot. Its value must be one
   * IPv4 or IPv6 address; a request without one is refused wherever an
   * address is counted, never put in a shared bucket. A header any caller
   * can send (`x-forwarded-for`, `x-real-ip`, `forwarded`, `true-client-ip`
   * and the like) throws at start unless `trustClientIpHeader` is set.
   */
  clientIpHeader?: string
  /**
   * Opt in: `clientIpHeader` names a header a caller can also send, and your
   * own front overwrites it on every request. Without that front, every
   * request can name a new address and get a fresh bucket.
   */
  trustClientIpHeader?: boolean
  /** Turnstile on the consent page once an address has opened it `after` times in an hour (default 3). */
  turnstile?: { siteKey: string; verify: (token: string, ip: string | null) => boolean | Promise<boolean>; after?: number }
  keys?: KeyOptions<D>
  /**
   * Where refreshes are locked per grant, rotated tokens marked and revoked
   * grants tombstoned. Default: KV with a lock per isolate, which leaves
   * three races: two isolates refreshing one token at once, a replay from
   * another region within about 60 seconds, before KV shows the mark there,
   * and a revoked grant written back by a refresh in a region whose KV cache
   * still holds it. A platform door refuses the default unless
   * `acceptKvRace` is true; use `durableObjectRefreshStore` or
   * `d1RefreshStore`.
   *
   * `tombstoneCacheSeconds` (0 to 5, default 0) lets `resolveSeat` remember
   * for that long, per server instance, that a grant has no tombstone, which
   * saves one store call per MCP request. The trade-off: a revocation made
   * from another isolate takes up to that long to stop an access token.
   * Refreshes, code exchanges and connected apps always read the store, and
   * a revocation made by this server instance applies at once.
   */
  refresh?: { store?: RefreshStore; acceptKvRace?: boolean; tombstoneCacheSeconds?: number }
  /** Shorter lifetimes only: access at most 1 hour, refresh at most 30 days. */
  ttl?: { accessSeconds?: number; refreshSeconds?: number }
  onEvent?: (event: OAuthEvent) => void
}

/** A connected app as the connected apps page lists it. */
export interface ConnectedApp {
  grantId: string
  clientId: string
  clientName: string
  status: ClientStatus
  door: string
  seatId: string
  tenant: string | null
  createdAt: number
  expiresAt: number | null
  lastUsedAt: number | null
}

export interface ConnectedApps {
  apps: ConnectedApp[]
  keys: (KeyInfo & { lastUsedAt: number | null })[]
}

export interface DoorAuth {
  resolveSeat: (token: string, req: Request) => Promise<SeatGrant | null>
  resourceMetadataUrl: string
}

export interface OAuthServer<D extends string> {
  /** Where the product's sign-in sends the browser back. The sign-in page compares `return_to` to it exactly. */
  callbackUrl: string
  /** Answers the kit's routes; null for any other request, so the product can route on. */
  route(req: Request, exec?: { waitUntil(p: Promise<unknown>): void }): Promise<Response | null>
  /** `route`, with 404 for anything else. */
  fetch(req: Request, env?: unknown, exec?: { waitUntil(p: Promise<unknown>): void }): Promise<Response>
  /** What `mcpServer` needs for a door: spread it into its options. */
  door(door: D): DoorAuth
  /** Turns an access token or key into a seat at this door, or null. */
  resolveSeat(door: D, token: string, req: Request): Promise<SeatGrant | null>
  resourceMetadataUrl(door: D): string
  /** Every app and key a person has connected, with last use. */
  connectedApps(personId: string): Promise<ConnectedApps>
  /** Disconnects one app. False when the person has no such grant. */
  revokeApp(personId: string, grantId: string): Promise<boolean>
  /** Personal and service keys. */
  keys: Keys<D>
  /**
   * Call when a person loses a role: revokes their grants and keys, at one
   * door or tenant if given. Service keys they own go too unless moved first
   * with `keys.transferService`.
   */
  personLostRole(personId: string, filter?: { door?: D; tenant?: string }): Promise<{ grants: number; keys: number }>
  /** The library's helpers, for pre-registering clients and purging expired data from a cron. */
  api(): OAuthHelpers
}

interface GrantProps {
  principal: Principal
  seat: Seat
}

/** Which list made a client known at consent: its exact id, or its metadata host under `knownDomains`. */
type KnownBy = 'id' | 'domain'

interface GrantMeta {
  door: string
  seatId: string
  tenant: string | null
  clientName: string
  status: ClientStatus
  knownBy?: KnownBy
}

/** The part of the library's grant record the kit reads. */
interface StoredGrant {
  clientId?: string
  /** The hash of the grant's authorization code. */
  authCodeId?: string
  /** Present until the code is exchanged; the library deletes it then. */
  authCodeWrappedKey?: string
  refreshTokenId?: string
  previousRefreshTokenId?: string
  metadata?: Partial<GrantMeta>
}

interface UpstreamData {
  door: string
  clientName: string
  status: ClientStatus
  knownBy?: KnownBy
}

type LibEnv = { OAUTH_KV: KvLike }

const json = (body: unknown, status: number, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', 'cache-control': 'no-store', ...headers } })

const warned = new Set<string>()
const warnOnce = (msg: string) => {
  if (warned.has(msg)) return
  warned.add(msg)
  console.warn(msg)
}


const grantUseKey = (grantId: string) => `grant-${grantId}`

function checkResource(door: string, r: string): string {
  let u: URL
  try {
    u = new URL(r)
  } catch {
    throw new Error(`oauth: door ${door} has no valid resource URL`)
  }
  const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(u.hostname)
  if (u.protocol !== 'https:' && !(u.protocol === 'http:' && loopback)) throw new Error(`oauth: door ${door} must be served over https`)
  if (!r.startsWith(u.origin) || u.hash || u.username || u.password) throw new Error(`oauth: door ${door} resource must be canonical: lowercase scheme and host, no fragment or userinfo`)
  return r
}

/**
 * How long one refresh or code exchange may hold its grant's lock. Above the
 * library's worst case, so the lock does not lapse while it works: a client's
 * metadata document may take it 10 s, and its JWKS another 10 s.
 */
const TOKEN_LOCK_MS = 30_000

/** Where a code exchange in flight is recorded, apart from the record of a used code. */
const pendingCode = (hash: string) => sha256Hex(`omazy-oauth:pending-code:${hash}`)

/** How long the library's authorization code lives: its grant is written with this TTL until the exchange. */
const CODE_TTL_SECONDS = 600

/** What a tombstoned grant answers at the token endpoint. */
const grantRevoked = () => json({ error: 'invalid_grant', error_description: 'The grant was revoked' }, 400)

/**
 * Headers a caller can send itself. Cloudflare passes them through as sent
 * unless the product's own front overwrites them, so naming one needs an opt in.
 */
const CLIENT_SETTABLE_IP_HEADERS = new Set([
  'x-forwarded-for',
  'x-forwarded',
  'forwarded',
  'forwarded-for',
  'x-real-ip',
  'x-client-ip',
  'client-ip',
  'x-cluster-client-ip',
  'true-client-ip',
  'x-originating-ip',
  'x-remote-ip',
  'x-remote-addr',
  'fastly-client-ip',
  'x-envoy-external-address',
])

const IPV4 = /^(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)(?:\.(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)){3}$/

/** The eight groups of a normalised IPv6 address (no brackets, no dotted tail), or null. */
function ipv6Groups(s: string): number[] | null {
  const halves = s.split('::')
  if (halves.length > 2) return null
  const head = halves[0] ? halves[0].split(':') : []
  const tail = halves.length === 2 ? (halves[1] ? halves[1].split(':') : []) : null
  const groups = tail === null ? head : [...head, ...Array<string>(8 - head.length - tail.length).fill('0'), ...tail]
  if (groups.length !== 8 || groups.some((g) => !/^[0-9a-f]{1,4}$/.test(g))) return null
  return groups.map((g) => Number.parseInt(g, 16))
}

/**
 * The caller's address, the bucket it counts in and, for IPv6, the wider
 * /48 bucket, or null when the value is not exactly one IPv4 or IPv6
 * address. IPv4 counts as itself; IPv6 by its /64, which one customer is
 * usually handed whole, and its /48; an IPv4-mapped address and a 6to4
 * address (2002::/16, whose next 32 bits are the IPv4 address that owns
 * the whole /48) as their IPv4 address.
 */
function addressOf(raw: string | null | undefined): { ip: string; bucket: string; wide?: string } | null {
  const v = raw?.trim()
  if (!v || v.length > 64) return null
  if (IPV4.test(v)) return { ip: v, bucket: v }
  if (!v.includes(':') || !/^[0-9A-Fa-f:.]+$/.test(v)) return null
  let host: string
  try {
    // The URL parser checks the address and writes it in one form: lower case, compressed, any dotted tail in hex.
    host = new URL(`http://[${v}]/`).hostname
  } catch {
    return null
  }
  const g = ipv6Groups(host.slice(1, -1))
  if (!g) return null
  if (g.slice(0, 5).every((x) => x === 0) && g[5] === 0xffff) {
    const ip = `${g[6]! >> 8}.${g[6]! & 255}.${g[7]! >> 8}.${g[7]! & 255}`
    return { ip, bucket: ip }
  }
  const hex = (n: number) => g.slice(0, n).map((x) => x.toString(16)).join(':')
  if (g[0] === 0x2002) return { ip: host.slice(1, -1), bucket: `${g[1]! >> 8}.${g[1]! & 255}.${g[2]! >> 8}.${g[2]! & 255}` }
  return { ip: host.slice(1, -1), bucket: `${hex(4)}::/64`, wide: `${hex(3)}::/48` }
}

/** The user and grant a library token names (`user:grant:secret`, read from the right as the library does), or null. */
function tokenOwner(token: string): { userId: string; grantId: string } | null {
  const parts = token.split(':')
  if (parts.length < 3) return null
  const grantId = parts[parts.length - 2]!
  const userId = parts.slice(0, -2).join(':')
  return userId && grantId ? { userId, grantId } : null
}

function metadataFallback(f: AuthorizationServerOptions<string>['clientMetadataFallback']): false | { maxAgeSeconds: number } {
  if (f === undefined || f === false) return false
  const s = f.maxAgeSeconds
  if (!Number.isInteger(s) || s < 60 || s > 3600) throw new Error('oauth: clientMetadataFallback.maxAgeSeconds must be a whole number from 60 to 3600')
  return { maxAgeSeconds: s }
}

/**
 * The User-Agent the pinned library (1.3.0) sends when it fetches a metadata
 * document. The kit's own check sends the same headers, so a server that
 * answers by User-Agent gives both the same answer.
 */
const LIBRARY_USER_AGENT = 'workers-oauth-provider/1.3.0 (+https://github.com/cloudflare/workers-oauth-provider)'

/** The parts of a metadata document that decide where access goes and what the consent page shows. */
const documentSignature = (name: unknown, redirectUris: unknown): string => JSON.stringify([typeof name === 'string' ? name : null, Array.isArray(redirectUris) ? redirectUris : null])

/** Whether a redirect URI is listed, with any port on a loopback address (RFC 8252), as the library matches it. */
function redirectListed(uri: string, listed: readonly unknown[]): boolean {
  if (listed.includes(uri)) return true
  let u: URL
  try {
    u = new URL(uri)
  } catch {
    return false
  }
  const loop = (h: string) => LOOPBACK.has(h) || /^127\.\d+\.\d+\.\d+$/.test(h)
  if (!loop(u.hostname)) return false
  return listed.some((l) => {
    if (typeof l !== 'string') return false
    try {
      const v = new URL(l)
      return loop(v.hostname) && v.protocol === u.protocol && v.hostname === u.hostname && v.pathname === u.pathname && v.search === u.search
    } catch {
      return false
    }
  })
}

/** A client metadata document the kit refused to trust: it redirected, could not be read without following one, or differs from the library's copy. */
class MetadataRefused extends Error {}

const LOOPBACK = new Set(['localhost', '127.0.0.1', '[::1]'])

/** Whether a redirect URI stays on a metadata host: https on the host or under it, or a loopback address. */
function redirectStaysOn(uri: string, host: string): boolean {
  let u: URL
  try {
    u = new URL(uri)
  } catch {
    return false
  }
  const h = u.hostname.toLowerCase()
  if ((u.protocol === 'http:' || u.protocol === 'https:') && (LOOPBACK.has(h) || /^127\.\d+\.\d+\.\d+$/.test(h))) return true
  return u.protocol === 'https:' && (h === host || h.endsWith(`.${host}`))
}

function checkPolicy(door: string, p: ClientPolicy | undefined, platform: boolean): void {
  if (platform) {
    if (p?.dangerouslyAllowUnlistedClients === true) warnOnce(`oauth: platform door ${door} takes clients that are not on its known list (dangerouslyAllowUnlistedClients)`)
    else {
      if ((p?.known ?? []).length === 0) throw new Error(`oauth: platform door ${door} needs clients.${door}.known: the exact client ids that may connect there`)
      if (p?.others === 'allow' || p?.unverified === 'allow')
        throw new Error(`oauth: platform door ${door} allows clients that are not on its known list; set dangerouslyAllowUnlistedClients: true to accept that`)
    }
  }
  if (!p) return
  for (const k of p.known ?? []) {
    // A pre-registered id has no dot; a metadata document id is an https URL with a path.
    let url: URL | null = null
    try {
      url = new URL(k)
    } catch {}
    if (url ? url.protocol !== 'https:' || url.pathname === '/' : k.includes('.'))
      throw new Error(`oauth: door ${door} knows "${k}": name the exact client id (the full metadata document URL), or list a domain under knownDomains`)
  }
  if (platform && (p.knownDomains ?? []).length > 0) throw new Error(`oauth: door ${door} is a platform door; list exact client ids under known, not knownDomains`)
  for (const k of p.knownDomains ?? []) if (!/^[a-z0-9.-]+$/.test(k) || !k.includes('.')) throw new Error(`oauth: door ${door} knownDomains "${k}" must be a lowercase host name`)
}

/** The RFC 9728 metadata URL of a resource: the well-known path inserted before the resource's path. */
export function metadataUrlFor(resource: string): string {
  const u = new URL(resource)
  const path = u.pathname === '/' ? '' : u.pathname
  return `${u.origin}/.well-known/oauth-protected-resource${path}${u.search}`
}

/**
 * The authorization server.
 *
 *     const oauth = authorizationServer({
 *       issuer: 'https://mcp.example.com', kv: env.OAUTH_KV, productName: 'Example',
 *       doors: { platform: 'https://mcp.example.com/platform', org: 'https://mcp.example.com/org' },
 *       signIn: { url: 'https://app.example.com/mcp-sign-in', authenticate: (code, state) => codes.redeem(code, state) },
 *       chooseSeat: (person, door) => seatFor(person, door),
 *       clients: { platform: { known: ['claude.ai'], others: 'block', unverified: 'block' } },
 *       keys: { personal: { prefix: (d) => `ex_mcp_${d}_` } },
 *     })
 *     const org = mcpServer({ registry, guard, door: 'org', ...oauth.door('org'), info })
 *     export default { fetch: async (req, env, exec) => (await oauth.route(req, exec)) ?? org.fetch(req, env, exec) }
 */
export function authorizationServer<D extends string>(opts: AuthorizationServerOptions<D>): OAuthServer<D> {
  const issuer = opts.issuer.replace(/\/+$/, '')
  const doorNames = Object.keys(opts.doors) as D[]
  if (doorNames.length === 0) throw new Error('oauth: at least one door is required')
  const resourceOf = {} as Record<D, string>
  const doorOf = new Map<string, D>()
  for (const d of doorNames) {
    resourceOf[d] = checkResource(d, opts.doors[d])
    doorOf.set(resourceOf[d], d)
  }
  const accessTtl = Math.min(opts.ttl?.accessSeconds ?? ACCESS_TTL_SECONDS, ACCESS_TTL_SECONDS)
  const refreshTtl = Math.min(opts.ttl?.refreshSeconds ?? REFRESH_TTL_SECONDS, REFRESH_TTL_SECONDS)
  if (accessTtl < KV_MIN_TTL || refreshTtl < KV_MIN_TTL) throw new Error('oauth: token lifetimes must be at least 60 seconds')
  const registration = opts.registration?.enabled === true
  const ipHeader = opts.clientIpHeader ?? 'cf-connecting-ip'
  if (!/^[a-z0-9-]{1,64}$/i.test(ipHeader)) throw new Error('oauth: clientIpHeader must be a header name')
  if (CLIENT_SETTABLE_IP_HEADERS.has(ipHeader.toLowerCase()) && opts.trustClientIpHeader !== true)
    throw new Error(`oauth: clientIpHeader ${ipHeader} is a header any caller can send; set trustClientIpHeader: true only when your own front overwrites it on every request`)
  /** The caller's address and its bucket, or null when the request does not carry exactly one address. */
  const ipOf = (req: Request) => addressOf(req.headers.get(ipHeader))
  if (!Array.isArray(opts.platformDoors)) throw new Error('oauth: name the platform doors (seats with no tenant) in platformDoors, or pass [] for none')
  const platformDoors = new Set<D>(opts.platformDoors)
  for (const d of platformDoors) if (!doorNames.includes(d)) throw new Error(`oauth: platform door ${d} is not a door`)
  for (const d of doorNames) checkPolicy(d, opts.clients?.[d], platformDoors.has(d))
  if (platformDoors.size > 0 && !opts.checkSeat) throw new Error('oauth: a platform door needs checkSeat, so a lost platform role refuses its tokens')
  if (!opts.checkSeat) warnOnce('oauth: no checkSeat: a removed seat keeps working until its access token expires')
  if (!opts.rateLimit?.authorize) warnOnce('oauth: no rateLimit.authorize: GET /authorize writes to KV with no limit per address')
  if (!opts.rateLimit?.token) warnOnce('oauth: no rateLimit.token: the token endpoint has no limit per address')
  if ((opts.rateLimit?.authorize && !opts.rateLimit.authorizePer48) || (opts.rateLimit?.token && !opts.rateLimit.tokenPer48))
    warnOnce('oauth: rateLimit.authorizePer48 or tokenPer48 is missing: one IPv6 /48 gets a fresh bucket for each of its 65,536 /64s')
  /** The bucket a request ran out of at this endpoint, its /64 (or IPv4 address) first, then its /48. Null while it has room. */
  const overLimit = async (kind: 'authorize' | 'token', ip: { bucket: string; wide?: string }): Promise<string | null> => {
    const narrow = opts.rateLimit?.[kind]
    const wide = opts.rateLimit?.[`${kind}Per48`]
    if (narrow && !(await narrow.limit({ key: `${kind}:${ip.bucket}` })).success) return ip.bucket
    if (wide && ip.wide && !(await wide.limit({ key: `${kind}:${ip.wide}` })).success) return ip.wide
    return null
  }
  const refreshStore = opts.refresh?.store ?? kvRefreshStore(opts.kv)
  if (platformDoors.size > 0 && !refreshStore.consistent && opts.refresh?.acceptKvRace !== true)
    throw new Error(
      'oauth: a platform door needs a consistent refresh store (durableObjectRefreshStore or d1RefreshStore); KV lets a replayed refresh token through for about 60 s. Pass refresh: { acceptKvRace: true } to accept that',
    )
  const event = (e: OAuthEvent) => {
    try {
      opts.onEvent?.(e)
    } catch {}
  }
  // A tombstone outlives every token of its grant: a refresh token lives at
  // most refreshTtl from the code exchange, and the hour covers a code
  // exchanged, or an access token minted, as the tombstone was written.
  const tombstoneTtl = refreshTtl + ACCESS_TTL_SECONDS
  const tombstoneCacheSeconds = opts.refresh?.tombstoneCacheSeconds ?? 0
  if (!Number.isInteger(tombstoneCacheSeconds) || tombstoneCacheSeconds < 0 || tombstoneCacheSeconds > 5)
    throw new Error('oauth: refresh.tombstoneCacheSeconds must be a whole number from 0 to 5')
  /** Grants `resolveSeat` found without a tombstone, and until when that answer stands. */
  const untombstoned = new Map<string, number>()

  const paths = {
    authorize: `${issuer}/authorize`,
    callback: `${issuer}/oauth/callback`,
    token: `${issuer}/oauth/token`,
    register: `${issuer}/oauth/register`,
  }

  const lib = new OAuthAuthorizationServer<LibEnv>({
    issuer,
    resources: doorNames.map((d) => resourceOf[d]),
    authorizeEndpoint: paths.authorize,
    tokenEndpoint: paths.token,
    accessTokenTTL: accessTtl,
    refreshTokenTTL: refreshTtl,
    scopesSupported: [OAUTH_SCOPE],
    clientIdMetadataDocumentEnabled: opts.clientMetadataDocuments !== false,
    // The library keeps a last-good copy for 24 hours by default, so a withdrawn document kept working.
    clientIdMetadataDocumentFallback: metadataFallback(opts.clientMetadataFallback),
    ...(registration
      ? { clientRegistrationEndpoint: paths.register, clientRegistrationTTL: Math.max(1, opts.registration?.clientTtlDays ?? 90) * 86_400 }
      : {}),
    onError: (e: { code: string; internal?: { reason?: string } }) => {
      event({ type: 'oauth_error', code: e.code, reason: e.internal?.reason ?? '' })
    },
  })
  const env: LibEnv = { OAUTH_KV: opts.kv }
  const helpers = () => lib.getOAuthApi(env)

  /**
   * Revokes a grant, tombstone first. The library deletes the grant from KV,
   * but a refresh in a location whose cache still holds it writes it back;
   * the tombstone, in the consistent store, is what says it was revoked.
   */
  async function bury(userId: string, grantId: string): Promise<void> {
    untombstoned.delete(grantId)
    await refreshStore.tombstone(grantId, { userId, grantId }, tombstoneTtl)
    await helpers().revokeGrant(grantId, userId)
  }

  /** True when the grant was revoked and has come back through a stale write: it is revoked again. */
  async function risen(userId: string, grantId: string): Promise<boolean> {
    if (!(await refreshStore.tombstoned(grantId))) return false
    await helpers().revokeGrant(grantId, userId)
    return true
  }

  /** `risen` for `resolveSeat`, with the optional short memory of a grant that has no tombstone. */
  async function risenOnCall(userId: string, grantId: string): Promise<boolean> {
    if (tombstoneCacheSeconds === 0) return risen(userId, grantId)
    const until = untombstoned.get(grantId)
    if (until !== undefined && until > Date.now()) return false
    if (await risen(userId, grantId)) {
      untombstoned.delete(grantId)
      return true
    }
    if (untombstoned.size >= 10_000) for (const [k, u] of untombstoned) if (u <= Date.now()) untombstoned.delete(k)
    if (untombstoned.size >= 10_000) untombstoned.delete(untombstoned.keys().next().value!)
    untombstoned.set(grantId, Date.now() + tombstoneCacheSeconds * 1000)
    return false
  }
  const keys = new Keys<D>(opts.kv, doorNames, opts.keys ?? {}, [...platformDoors])

  const execOf = (exec?: { waitUntil(p: Promise<unknown>): void }) =>
    ({ waitUntil: (p: Promise<unknown>) => exec?.waitUntil(p), passThroughOnException() {}, props: {} }) as never

  const page = (status: number, title: string, text: string, base?: Headers) => {
    const nonce = newNonce()
    return new Response(messagePage(title, text, nonce), { status, headers: pageHeaders(nonce, false, base) })
  }
  const redirect = (to: string, base?: Headers) => {
    const h = new Headers(base)
    h.set('location', to)
    h.set('cache-control', 'no-store')
    return new Response(null, { status: 302, headers: h })
  }

  /**
   * The client's status at a door. Known means its exact id is on the door's
   * list, or (opted in) its metadata host is and every redirect URI it lists
   * stays on that host. A metadata document whose redirect URIs leave its own
   * host proves nothing about where access goes, so that client counts as
   * unverified.
   */
  async function policyStatus(
    door: D,
    clientId: string,
    domain: string | undefined,
    shown?: { name: string; redirectUri: string },
  ): Promise<{ status: ClientStatus; knownBy?: KnownBy; blocked: boolean }> {
    const policy = opts.clients?.[door] ?? {}
    let status: ClientStatus
    let knownBy: KnownBy | undefined
    if ((policy.known ?? []).includes(clientId)) {
      status = 'known'
      knownBy = 'id'
    } else if (!domain) status = 'unverified'
    else {
      const client = await helpers().lookupClient(clientId)
      const bound = !!client && client.redirectUris.length > 0 && client.redirectUris.every((u) => redirectStaysOn(u, domain))
      status = !bound ? 'unverified' : (policy.knownDomains ?? []).includes(domain) ? 'known' : 'verified'
      if (status === 'known') knownBy = 'domain'
    }
    if (domain) await refuseMetadataRedirect(clientId, shown)
    const others = policy.others ?? (platformDoors.has(door) ? 'block' : 'allow')
    const blocked = (status === 'verified' && others === 'block') || (status === 'unverified' && (policy.unverified ?? 'block') === 'block')
    return { status, ...(knownBy ? { knownBy } : {}), blocked }
  }

  /**
   * The door's client policy as it stands now, for a grant already given:
   * checked on every refresh, code exchange and `resolveSeat`, so a client
   * the product blocks or takes off its `known` list stops at once. No
   * network: the status recorded at consent stands unless the lists moved
   * it. A client recorded known by its host under `knownDomains` stays known
   * while the host is listed: its redirect URIs were bound to that host at
   * consent. A client known by its exact id, now off the list, is looked up
   * again for its redirect URIs, even when its host is listed, and so is a
   * grant with no record of its status. That lookup takes the same redirect
   * check as consent, and its answer is remembered for five minutes per
   * server instance, as `metadataChecked` is.
   */
  async function stillAllowed(
    door: D,
    clientId: string,
    recorded: () => Promise<{ status?: ClientStatus; knownBy?: KnownBy } | undefined>,
  ): Promise<{ allowed: boolean; status: ClientStatus }> {
    const policy = opts.clients?.[door] ?? {}
    if ((policy.known ?? []).includes(clientId)) return { allowed: true, status: 'known' }
    const others = policy.others ?? (platformDoors.has(door) ? 'block' : 'allow')
    const unverified = policy.unverified ?? 'block'
    const host = metadataHost(clientId)
    if (!host) return { allowed: unverified === 'allow', status: 'unverified' }
    const byDomain = (policy.knownDomains ?? []).includes(host)
    const rec = await recorded()
    let status = rec?.status
    if (status === 'verified' && byDomain) status = 'known'
    else if (status === undefined || (status === 'known' && !(byDomain && rec?.knownBy === 'domain'))) {
      let bound: boolean
      try {
        bound = await boundNow(clientId, host)
      } catch {
        return { allowed: false, status: 'unverified' }
      }
      status = !bound ? 'unverified' : byDomain ? 'known' : 'verified'
    }
    const allowed = status === 'known' || (status === 'verified' && others === 'allow') || (status === 'unverified' && unverified === 'allow')
    return { allowed, status }
  }

  /**
   * Whether every redirect URI of a metadata document client stays on its
   * host, read again for a grant the lists no longer decide. The document
   * goes through the same redirect and match check as at consent; a refusal
   * throws. A good answer is kept five minutes, so a delisted client costs
   * no fetch on every call.
   */
  const boundChecked = new Map<string, { at: number; bound: boolean }>()
  async function boundNow(clientId: string, host: string): Promise<boolean> {
    const memo = boundChecked.get(clientId)
    if (memo && memo.at > Date.now() - 300_000) return memo.bound
    const client = await helpers().lookupClient(clientId)
    const bound = !!client && client.redirectUris.length > 0 && client.redirectUris.every((u) => redirectStaysOn(u, host))
    await refuseMetadataRedirect(clientId)
    if (boundChecked.size >= 1000) boundChecked.delete(boundChecked.keys().next().value!)
    boundChecked.set(clientId, { at: Date.now(), bound })
    return bound
  }

  /** A grant's door and client, checked against the policy now. Null when allowed, else the answer to send. */
  async function grantRefused(grant: StoredGrant): Promise<Response | null> {
    const door = doorNames.find((d) => d === grant.metadata?.door)
    const verdict = door ? await stillAllowed(door, grant.clientId ?? '', async () => grant.metadata) : { allowed: false, status: 'unverified' as const }
    if (verdict.allowed) return null
    event({ type: 'client_blocked', door: grant.metadata?.door ?? '', clientId: grant.clientId ?? '', status: verdict.status })
    return json({ error: 'invalid_grant', error_description: 'This app may no longer connect here' }, 400)
  }

  async function clientStatus(
    door: D,
    request: AuthRequest,
  ): Promise<{ name: string; status: ClientStatus; knownBy?: KnownBy; domain?: string; redirectHost: string; loopback: boolean; blocked: boolean }> {
    const d = await helpers().describeConsent(request)
    const domain = d.clientDomain
    const { status, knownBy, blocked } = await policyStatus(door, request.clientId, domain, { name: d.clientName, redirectUri: request.redirectUri })
    return { name: d.clientName, status, ...(knownBy ? { knownBy } : {}), ...(domain ? { domain } : {}), redirectHost: d.redirectHost, loopback: d.redirectIsLoopback, blocked }
  }

  /** The host of a metadata document client id, as the library reads one, or undefined. */
  const metadataHost = (clientId: string): string | undefined => {
    if (opts.clientMetadataDocuments === false || !/^https:\/\/[^/?#]+\//.test(clientId)) return undefined
    try {
      return new URL(clientId).hostname
    } catch {
      return undefined
    }
  }

  // The library fetches a metadata document with the runtime's default, which
  // follows redirects (the CIMD draft says it must not), and offers no fetch
  // hook. It is a peer dependency the product installs, so a patch here would
  // never reach a product's deploy. The kit fetches the same URL itself, with
  // the library's own headers and redirects refused, and then requires the
  // document it read to match the one the library resolved (name and
  // redirect URIs). A client id that redirects is refused, and so is one whose
  // server gave the library a different document, by User-Agent, by order or
  // by timing. A good answer is remembered for five minutes per isolate,
  // together with what it said, and checked against the library each time.
  const metadataChecked = new Map<string, { at: number; doc: { name: unknown; uris: unknown } }>()
  async function refuseMetadataRedirect(clientId: string, shown?: { name: string; redirectUri: string }): Promise<void> {
    const libClient = await helpers().lookupClient(clientId)
    const libSig = libClient ? documentSignature(libClient.clientName, libClient.redirectUris) : null
    // What this request was validated and shown with must be in the document the kit reads.
    const matches = (d: { name: unknown; uris: unknown }) =>
      documentSignature(d.name, d.uris) === libSig && (!shown || (d.name === shown.name && Array.isArray(d.uris) && redirectListed(shown.redirectUri, d.uris)))
    const memo = metadataChecked.get(clientId)
    if (memo && memo.at > Date.now() - 300_000 && matches(memo.doc)) return
    // A failure that is not a redirect means the origin is having trouble. The
    // library has just resolved the document, from the origin or (when the
    // product chose a fallback) from its last good copy, so only a product
    // with a fallback lets that pass.
    const tolerate = opts.clientMetadataFallback !== undefined && opts.clientMetadataFallback !== false
    const refuse = (reason: 'redirect' | 'unreadable' | 'mismatch') => {
      event({ type: 'client_metadata_refused', clientId, reason })
      return new MetadataRefused()
    }
    let res: Response
    try {
      res = await fetch(clientId, {
        method: 'GET',
        redirect: 'manual',
        headers: { accept: 'application/json', 'cache-control': 'no-store', 'user-agent': LIBRARY_USER_AGENT },
        cache: 'no-store',
        signal: AbortSignal.timeout(10_000),
      })
    } catch {
      if (tolerate) return
      throw refuse('unreadable')
    }
    if (res.type === 'opaqueredirect' || (res.status >= 300 && res.status < 400)) {
      await res.body?.cancel().catch(() => undefined)
      throw refuse('redirect')
    }
    if (!res.ok) {
      await res.body?.cancel().catch(() => undefined)
      if (tolerate) return
      throw refuse('unreadable')
    }
    let doc: { name: unknown; uris: unknown }
    try {
      const text = await res.text()
      if (text.length > 64 * 1024) throw new Error('too large')
      const d = JSON.parse(text) as { client_name?: unknown; redirect_uris?: unknown }
      doc = { name: d.client_name, uris: d.redirect_uris }
    } catch {
      if (tolerate) return
      throw refuse('unreadable')
    }
    if (!matches(doc)) throw refuse('mismatch')
    if (metadataChecked.size >= 1000) metadataChecked.delete(metadataChecked.keys().next().value!)
    metadataChecked.set(clientId, { at: Date.now(), doc })
  }

  /** Shown on the kit's own origin. Never a redirect: only a known client gets errors at its redirect URI. */
  function renderAuthError(e: unknown, base?: Headers): Response {
    if (e instanceof AuthorizationError) return page(400, 'This request cannot be completed', e.description, base)
    if (e instanceof CimdFetchError || e instanceof MetadataRefused) return page(400, 'This app could not be verified', 'Its metadata document could not be read. Try again later.', base)
    throw e
  }

  const notAllowed = (base?: Headers) => page(403, 'This app cannot connect here', `${opts.productName} does not allow this app to connect here.`, base)

  /** Where an address is counted, a request without one is refused rather than put in a bucket every such request shares. */
  const noAddress = () => {
    event({ type: 'request_refused', reason: 'no_address' })
    return page(400, 'This request cannot be completed', 'The request did not say where it came from. Open the link from the app again.')
  }
  const noAddressJson = () => {
    event({ type: 'request_refused', reason: 'no_address' })
    return json({ error: 'invalid_request', error_description: 'The request did not carry the caller address' }, 400)
  }

  async function authorizeGet(req: Request): Promise<Response> {
    const ip = ipOf(req)
    if (!ip && (opts.rateLimit?.authorize || opts.rateLimit?.authorizePer48 || opts.turnstile)) return noAddress()
    if (ip) {
      const out = await overLimit('authorize', ip)
      if (out) {
        event({ type: 'authorize_limited', ip: out })
        const r = page(429, 'Too many requests', 'Wait a minute, then open the link from the app again.')
        r.headers.set('retry-after', '60')
        return r
      }
    }
    const url = new URL(req.url)
    const resources = url.searchParams.getAll('resource')
    const asked = resources.length === 1 ? doorOf.get(resources[0]!) : undefined
    let request: AuthRequest
    try {
      request = await helpers().parseAuthRequest(req)
    } catch (e) {
      // An error the library would send to the client's redirect URI goes
      // there only when the door knows the client; anything else would make
      // this origin an open redirect for any registered or metadata client.
      if (e instanceof AuthorizationError && e.redirectTo && asked) {
        const clientId = url.searchParams.get('client_id') ?? ''
        try {
          if ((await policyStatus(asked, clientId, metadataHost(clientId))).status === 'known') return redirect(e.redirectTo)
        } catch {}
      }
      return renderAuthError(e)
    }
    const door = resources.length === 1 && request.resource ? doorOf.get(request.resource) : undefined
    if (!door) {
      event({ type: 'request_refused', reason: 'resource_missing' })
      return page(400, 'This request cannot be completed', 'The app must name one server here as its resource.')
    }
    // The client's status first: it decides whether any error may go back to the client.
    let c: Awaited<ReturnType<typeof clientStatus>>
    try {
      c = await clientStatus(door, request)
    } catch (e) {
      return renderAuthError(e)
    }
    if (c.blocked) {
      event({ type: 'client_blocked', door, clientId: request.clientId, status: c.status })
      return notAllowed()
    }
    if (url.searchParams.get('code_challenge_method') !== 'S256' || !url.searchParams.get('code_challenge') || request.codeChallengeMethod !== 'S256') {
      event({ type: 'request_refused', reason: 'pkce_missing' })
      const text = 'PKCE with S256 is required'
      return c.status === 'known' ? redirect(authorizationErrorRedirect(request, 'invalid_request', text)) : page(400, 'This request cannot be completed', text)
    }

    const attempts = opts.turnstile && ip ? await bump(opts.kv, 'consent', ip.bucket, 3600) : 0
    const challenge = !!opts.turnstile && attempts > (opts.turnstile.after ?? 3)
    const consent = await helpers().beginConsent(request)
    const nonce = newNonce()
    const html = consentPage(
      {
        productName: opts.productName,
        door,
        ...(opts.doorLabels?.[door] ? { doorLabel: opts.doorLabels[door] } : {}),
        clientName: c.name,
        status: c.status,
        ...(c.domain ? { clientDomain: c.domain } : {}),
        redirectHost: c.redirectHost,
        redirectIsLoopback: c.loopback,
        handle: consent.handle,
        action: new URL(paths.authorize).pathname,
        ...(challenge ? { turnstileSiteKey: opts.turnstile!.siteKey } : {}),
      },
      nonce,
    )
    return new Response(html, { status: 200, headers: pageHeaders(nonce, challenge, consent.headers) })
  }

  async function authorizePost(req: Request): Promise<Response> {
    const ct = req.headers.get('content-type') ?? ''
    if (!ct.startsWith('application/x-www-form-urlencoded') && !ct.startsWith('multipart/form-data')) return page(400, 'This request cannot be completed', 'Open the link from the app again.')
    const form = await req.clone().formData()
    const handle = String(form.get('handle') ?? '')
    if (!handle) return page(400, 'This request cannot be completed', 'Open the link from the app again.')
    try {
      if (form.get('decision') !== 'approve') {
        const denied = await helpers().denyConsent(req, handle)
        return redirect(denied.redirectTo, denied.headers)
      }
      if (opts.turnstile) {
        const ip = ipOf(req)
        if (!ip) return noAddress()
        if ((await peek(opts.kv, 'consent', ip.bucket, 3600)) > (opts.turnstile.after ?? 3)) {
          const token = String(form.get('cf-turnstile-response') ?? '')
          if (!token || !(await opts.turnstile.verify(token, ip.ip))) {
            event({ type: 'turnstile_failed', ip: ip.bucket })
            return page(400, 'Please try again', 'The check that you are a person did not pass. Open the link from the app again.')
          }
        }
      }
      const approved = await helpers().approveConsent(req, handle, { scope: [OAUTH_SCOPE] })
      const door = approved.request.resource ? doorOf.get(approved.request.resource) : undefined
      if (!door) return page(400, 'This request cannot be completed', 'The app must name one server here as its resource.', approved.headers)
      // Checked again: the policy may have changed while the page was open.
      let c: Awaited<ReturnType<typeof clientStatus>>
      try {
        c = await clientStatus(door, approved.request)
      } catch (e) {
        return renderAuthError(e, approved.headers)
      }
      if (c.blocked) {
        event({ type: 'client_blocked', door, clientId: approved.request.clientId, status: c.status })
        return notAllowed(approved.headers)
      }
      const data: UpstreamData = { door, clientName: c.name, status: c.status, ...(c.knownBy ? { knownBy: c.knownBy } : {}) }
      const up = await helpers().beginUpstream(approved.request, { data, headers: approved.headers })
      const target = new URL(typeof opts.signIn.url === 'function' ? opts.signIn.url(door) : opts.signIn.url)
      target.searchParams.set('state', up.state)
      target.searchParams.set('door', door)
      target.searchParams.set('return_to', paths.callback)
      return redirect(target.toString(), up.headers)
    } catch (e) {
      if (e instanceof AuthorizationError) return page(400, 'This page has expired', 'It was used already, timed out or was opened in another browser. Open the link from the app again.')
      return renderAuthError(e)
    }
  }

  /**
   * The callback's parameters. A sign-in page may send them back by form POST
   * (the code then stays out of the address bar, history and request logs)
   * or in the query of a GET. A POST is read into the query of an equivalent
   * GET, which is what the library reads the state from. The flow cookie is
   * SameSite=Lax, so a POST carries it only from a sign-in on the issuer's
   * own site; a sign-in on another site uses the one-click GET.
   */
  async function callbackRequest(req: Request): Promise<Request | null> {
    if (req.method !== 'POST') return req
    const ct = (req.headers.get('content-type') ?? '').split(';')[0]!.trim().toLowerCase()
    if (ct !== 'application/x-www-form-urlencoded') return null
    let fd: FormData
    try {
      fd = await req.formData()
    } catch {
      return null
    }
    const url = new URL(paths.callback)
    for (const k of ['state', 'code', 'error']) {
      const v = fd.get(k)
      if (typeof v === 'string') url.searchParams.set(k, v)
    }
    return new Request(url, { method: 'GET', headers: req.headers })
  }

  async function callback(original: Request): Promise<Response> {
    const req = await callbackRequest(original)
    if (!req) return page(400, 'This sign-in cannot be completed', 'Open the link from the app again.')
    const url = new URL(req.url)
    const code = url.searchParams.get('code')
    const state = url.searchParams.get('state')
    let spent = false
    // A code that reached the callback is spent even when the flow fails: a
    // code issued in a victim's browser for an attacker's state, which fails
    // here for want of his cookie, must not stay good in her history or logs.
    const spend = async () => {
      if (spent || !code || !state) return
      spent = true
      try {
        await opts.signIn.authenticate(code, state, req)
      } catch {}
    }
    let resumed: Awaited<ReturnType<OAuthHelpers['finishUpstream']>>
    try {
      resumed = await helpers().finishUpstream<UpstreamData>(req)
    } catch (e) {
      await spend()
      if (e instanceof AuthorizationError) return page(400, 'This sign-in has expired', 'It was used already, timed out or was opened in another browser. Open the link from the app again.')
      throw e
    }
    const { request, headers } = resumed
    const data = resumed.data as UpstreamData
    const door = doorOf.get(request.resource ?? '')
    const deny = async (reason: Extract<OAuthEvent, { type: 'sign_in_failed' }>['reason'], text = 'Sign-in did not complete') => {
      await spend()
      event({ type: 'sign_in_failed', door: door ?? '', reason })
      return redirect(authorizationErrorRedirect(request, 'access_denied', text), headers)
    }
    if (!door || door !== data?.door) return deny('error')
    if (url.searchParams.get('error')) return deny('refused')
    if (!code || !state) return deny('no_code')
    let person: Principal | null
    spent = true
    try {
      // The state finishUpstream just matched to this browser: the code must have been issued for it.
      person = await opts.signIn.authenticate(code, state, req)
    } catch {
      return deny('error')
    }
    if (!person) return deny('refused')
    // An id that starts like a key would be read as one by resolveSeat; refuse it.
    if (!SAFE_ID.test(person.id) || typeof person.kind !== 'string' || keys.hasKeyPrefix(person.id)) return deny('bad_person')
    let seat: Seat | null
    try {
      seat = await opts.chooseSeat(person, door, req)
    } catch {
      return deny('error')
    }
    if (!seat || seat.door !== door) return deny('no_seat', 'You have no access here')
    // A seat with no tenant is an operator seat: only a platform door hands one out.
    if (seat.tenant === null && !platformDoors.has(door)) return deny('tenantless_seat', 'You have no access here')
    const props: GrantProps = { principal: { kind: person.kind, id: person.id, ...(person.name ? { name: person.name } : {}) }, seat }
    const metadata: GrantMeta = { door, seatId: seat.id, tenant: seat.tenant, clientName: data.clientName, status: data.status, ...(data.knownBy ? { knownBy: data.knownBy } : {}) }
    const { redirectTo } = await helpers().completeAuthorization({ request, userId: person.id, metadata, scope: [OAUTH_SCOPE], props, revokeExistingGrants: false })
    // One grant per person, client, door and seat: a person with two tenants keeps both.
    const newGrant = new URL(redirectTo).searchParams.get('code')?.split(':')[1]
    for (const g of await grantsOf(person.id)) {
      const m = g.metadata as GrantMeta | undefined
      if (g.id !== newGrant && g.clientId === request.clientId && m?.door === door && m?.seatId === seat.id) await bury(person.id, g.id)
    }
    return redirect(redirectTo, headers)
  }

  async function grantsOf(personId: string) {
    const out: Awaited<ReturnType<OAuthHelpers['listUserGrants']>>['items'] = []
    let cursor: string | undefined
    do {
      const page = await helpers().listUserGrants(personId, { limit: 1000, ...(cursor ? { cursor } : {}) })
      out.push(...page.items)
      cursor = page.cursor
    } while (cursor)
    return out
  }

  /**
   * A rotated refresh token that came back: revoke the grant. Null when the
   * token was never rotated. The mark stays for its TTL: if a stale location
   * writes the grant back, the same token is still a reuse.
   */
  async function reused(owner: { userId: string; grantId: string }, hash: string): Promise<Response | null> {
    const used = await refreshStore.retired(owner.grantId, hash)
    if (!used) return null
    await bury(used.userId, used.grantId)
    event({ type: 'refresh_reuse', userId: used.userId, grantId: used.grantId })
    return json({ error: 'invalid_grant', error_description: 'The refresh token was already used; the grant is revoked' }, 400)
  }

  /**
   * The exchange of a code the library issued: once per code. The library
   * marks a code used in its grant in KV, and on a second use revokes the
   * grant (RFC 9700) with no tombstone, so a location whose cache still holds
   * the grant writes it back on its next refresh. And a location whose cache
   * still holds the grant from before the exchange would exchange the code
   * again. So the kit records each exchange in the refresh store and answers
   * a code that comes back itself (`codeReplayed`).
   *
   * Only a request from the grant's own client is locked and recorded. Any
   * other goes to the library, which refuses a code issued to another client
   * before it reads anything else, so a code holder naming another client
   * (one whose metadata document he serves slowly, say) holds no lock and
   * leaves no record. A code the kit has recorded as used is never handed to
   * the library.
   *
   * Under the grant's lock the exchange is recorded as pending, with the
   * lock's holder, while the library works, and settled when it answers: a
   * 4xx means it did not exchange the code (a wrong verifier, say) and the
   * record goes; a 2xx, a 5xx or a throw records the code as used, failing
   * closed. A request that finds an exchange still pending holds a lock that
   * lapsed under it, so that exchange's outcome is not known yet: it gets 503
   * and tries again, never a replay's answer.
   */
  async function redeem(
    req: Request,
    form: Map<string, string>,
    owner: { userId: string; grantId: string },
    grant: StoredGrant,
    hash: string,
    exec?: { waitUntil(p: Promise<unknown>): void },
  ): Promise<Response> {
    if (!grant.authCodeWrappedKey) return codeReplayed(req, form, owner, grant, exec)
    if (tokenRequestClient(req.headers.get('authorization'), form) !== grant.clientId)
      return (await refreshStore.retired(owner.grantId, hash)) ? codeReplayed(req, form, owner, grant, exec) : lib.fetch(req, env, execOf(exec))
    const busy = () => {
      event({ type: 'refresh_contended', userId: owner.userId, grantId: owner.grantId })
      return json({ error: 'temporarily_unavailable', error_description: 'Another request for this grant is in progress; try again shortly' }, 503, { 'retry-after': '5' })
    }
    const holder = await refreshStore.lock(owner.grantId, TOKEN_LOCK_MS)
    if (!holder) return busy()
    try {
      if (await refreshStore.retired(owner.grantId, hash)) return await codeReplayed(req, form, owner, grant, exec)
      const pending = await pendingCode(hash)
      if (await refreshStore.retired(owner.grantId, pending)) return busy()
      // The pending record names the lock's holder in place of a user.
      await refreshStore.retire(owner.grantId, pending, { userId: holder, grantId: owner.grantId }, CODE_TTL_SECONDS)
      let res: Response
      try {
        res = await lib.fetch(req, env, execOf(exec))
      } catch (e) {
        await refreshStore.retire(owner.grantId, hash, owner, CODE_TTL_SECONDS)
        await refreshStore.forget(owner.grantId, pending).catch(() => undefined)
        throw e
      }
      // Used first, then the pending record dropped: a failure in between leaves the code used.
      if (res.status < 400 || res.status >= 500) await refreshStore.retire(owner.grantId, hash, owner, CODE_TTL_SECONDS)
      await refreshStore.forget(owner.grantId, pending).catch(() => undefined)
      if (res.ok) await keys.touch(grantUseKey(owner.grantId))
      return res
    } finally {
      await refreshStore.unlock(owner.grantId, holder).catch(() => undefined)
    }
  }

  /**
   * A code that was exchanged already. The library is never asked again: a
   * location whose KV cache still holds the grant from before the exchange
   * would exchange it a second time. Another client, or a request that names
   * none, gets `invalid_grant` and revokes nothing. The library revokes the
   * grant only for the grant's own client, once authenticated, so the kit
   * does too: a client that fails `clientCheck` gets that answer. Fails
   * closed: a tombstone that cannot be written answers 503 with nothing
   * revoked.
   */
  async function codeReplayed(
    req: Request,
    form: Map<string, string>,
    owner: { userId: string; grantId: string },
    grant: StoredGrant,
    exec?: { waitUntil(p: Promise<unknown>): void },
  ): Promise<Response> {
    if (tokenRequestClient(req.headers.get('authorization'), form) !== grant.clientId)
      return json({ error: 'invalid_grant', error_description: 'Invalid authorization code' }, 400)
    const checked = await clientCheck(req, form, exec)
    if (checked.status !== 200) return checked
    try {
      await bury(owner.userId, owner.grantId)
    } catch {
      return unrecorded()
    }
    event({ type: 'code_reuse', userId: owner.userId, grantId: owner.grantId })
    return json({ error: 'invalid_grant', error_description: 'Authorization code already used' }, 400)
  }

  async function token(req: Request, exec?: { waitUntil(p: Promise<unknown>): void }): Promise<Response> {
    // Anything but a POST is the library's to answer (405, CORS preflight).
    if (req.method !== 'POST') return lib.fetch(req, env, execOf(exec))
    if (opts.rateLimit?.token || opts.rateLimit?.tokenPer48) {
      const ip = ipOf(req)
      if (!ip) return noAddressJson()
      const out = await overLimit('token', ip)
      if (out) {
        event({ type: 'token_limited', ip: out })
        return json({ error: 'too_many_requests', error_description: 'Too many token requests; try again later' }, 429, { 'retry-after': '60' })
      }
    }
    // The kit must read every body the library reads, or a refresh token could
    // reach the library without passing the reuse check below.
    const form = await tokenForm(req)
    if (form instanceof Response) return form
    const grantType = form.get('grant_type')
    // RFC 7009: the library serves revocation at the token endpoint, for a body with a token and no grant type.
    if (!grantType && form.has('token')) return revocation(req, form, exec)
    const refresh = grantType === 'refresh_token' ? (form.get('refresh_token') ?? '') : ''
    const owner = tokenOwner(refresh)
    if (grantType === 'authorization_code') {
      // A code for a grant revoked since it was issued, which a stale
      // location wrote back. Checked only when the grant is there to use, so
      // a made-up code opens nothing in the store.
      const code = form.get('code') ?? ''
      const c = tokenOwner(code)
      const grant = c ? ((await opts.kv.get(`grant:${c.userId}:${c.grantId}`, { type: 'json' })) as StoredGrant | null) : null
      if (c && grant) {
        if (await risen(c.userId, c.grantId)) return grantRevoked()
        // The client may have been blocked since the person consented.
        const refused = await grantRefused(grant)
        if (refused) return refused
        const hash = await sha256Hex(code)
        if (hash === grant.authCodeId) return redeem(req, form, c, grant, hash, exec)
      }
    }
    if (owner) {
      // The library's own record of the grant. Nothing is locked or written
      // for a token the grant does not hold: a made-up token, or one naming a
      // real grant with a wrong secret, costs one KV read and goes to the
      // library, which refuses it.
      const hash = await sha256Hex(refresh)
      const grant = (await opts.kv.get(`grant:${owner.userId}:${owner.grantId}`, { type: 'json' })) as StoredGrant | null
      if (!grant) return lib.fetch(req, env, execOf(exec))
      if (hash !== grant.refreshTokenId && hash !== grant.previousRefreshTokenId) return (await reused(owner, hash)) ?? lib.fetch(req, env, execOf(exec))
      // A grant revoked elsewhere and written back from a stale cache.
      if (await risen(owner.userId, owner.grantId)) return grantRevoked()
      // A client the door blocks now, or took off its known list, gets no new tokens. The grant stays.
      const blocked = await grantRefused(grant)
      if (blocked) return blocked
      // One refresh per grant at a time: a second one at the same moment with
      // the same token waits and tries again.
      const holder = await refreshStore.lock(owner.grantId, TOKEN_LOCK_MS)
      if (!holder) {
        event({ type: 'refresh_contended', userId: owner.userId, grantId: owner.grantId })
        return json({ error: 'temporarily_unavailable', error_description: 'Another refresh of this grant is in progress; try again shortly' }, 503, { 'retry-after': '5' })
      }
      try {
        // A refresh token that was rotated away and comes back: someone holds
        // a copy. Revoke the whole grant, the client re-authorizes.
        const refused = await reused(owner, hash)
        if (refused) return refused
        // Marked before the library sees it, so the same token presented at
        // any later moment is a reuse, however long this call takes, even
        // past the lock. A 4xx means the library did not rotate it: the mark
        // goes. A 5xx or a throw keeps it, failing closed.
        await refreshStore.retire(owner.grantId, hash, owner, refreshTtl)
        const res = await lib.fetch(req, env, execOf(exec))
        if (res.ok) await keys.touch(grantUseKey(owner.grantId))
        else if (res.status >= 400 && res.status < 500) await refreshStore.forget(owner.grantId, hash)
        return res
      } finally {
        await refreshStore.unlock(owner.grantId, holder).catch(() => undefined)
      }
    }
    return lib.fetch(req, env, execOf(exec))
  }

  /**
   * Whether the library accepts this token request's client credentials,
   * asked without letting it act on the request: the same credentials go with
   * an RFC 7009 revocation of a token that names nothing, which the library
   * answers 200 once the client is authenticated, and otherwise with the error
   * the real request would get (it authenticates the client before anything
   * else). Every method works this way, a client assertion too: the check
   * spends its `jti` as the library would, and the kit then answers the
   * request itself rather than hand it on.
   */
  async function clientCheck(req: Request, form: Map<string, string>, exec?: { waitUntil(p: Promise<unknown>): void }): Promise<Response> {
    const body = new URLSearchParams()
    for (const k of CLIENT_AUTH_PARAMS) {
      const v = form.get(k)
      if (v !== undefined) body.set(k, v)
    }
    body.set('token', 'omazy-oauth-client-check')
    const headers = new Headers(req.headers)
    headers.delete('content-length')
    headers.set('content-type', 'application/x-www-form-urlencoded')
    return lib.fetch(new Request(req.url, { method: 'POST', headers, body: body.toString() }), env, execOf(exec))
  }

  /** The answer when a tombstone cannot be written: nothing was revoked, the client tries again. */
  const unrecorded = () => {
    event({ type: 'oauth_error', code: 'revocation_unrecorded', reason: 'tombstone_write_failed' })
    return json({ error: 'temporarily_unavailable', error_description: 'The revocation could not be recorded; try again' }, 503, { 'retry-after': '5' })
  }

  /**
   * A client's own RFC 7009 revocation. The library revokes the whole grant
   * for a refresh token (current or previous) the requesting client holds,
   * and only the one token for an access token. A revoked grant needs a
   * tombstone like any other, or a location whose KV cache still holds it
   * writes it back on the next refresh.
   *
   * For a refresh token of the grant, named by the grant's own client (read
   * by `tokenRequestClient`, as the library reads it), the kit does the
   * revocation itself: `clientCheck` has the library
   * authenticate the client, then `bury` writes the tombstone and revokes
   * the grant. The library would authenticate and revoke in one step, so a
   * tombstone written after it could fail with the grant already gone. This
   * way a failed write answers 503 with nothing revoked, for a public or a
   * confidential client alike, and the client's retry finishes the job.
   */
  async function revocation(req: Request, form: Map<string, string>, exec?: { waitUntil(p: Promise<unknown>): void }): Promise<Response> {
    const tok = form.get('token') ?? ''
    // The library reads a token as exactly `user:grant:secret`.
    const parts = tok.split(':')
    if (parts.length === 3 && parts[0] && parts[1]) {
      const grant = (await opts.kv.get(`grant:${parts[0]}:${parts[1]}`, { type: 'json' })) as StoredGrant | null
      const clientId = tokenRequestClient(req.headers.get('authorization'), form)
      const hash = grant && clientId && grant.clientId === clientId ? await sha256Hex(tok) : null
      if (grant && hash && (hash === grant.refreshTokenId || hash === grant.previousRefreshTokenId)) {
        const checked = await clientCheck(req, form, exec)
        if (checked.status !== 200) return checked
        try {
          await bury(parts[0], parts[1])
        } catch {
          return unrecorded()
        }
        return checked
      }
    }
    return lib.fetch(req, env, execOf(exec))
  }

  async function register(req: Request, exec?: { waitUntil(p: Promise<unknown>): void }): Promise<Response> {
    if (req.method === 'POST') {
      const ip = ipOf(req)
      if (!ip) return noAddressJson()
      const perIp = opts.registration?.perHourPerIp ?? 10
      const out =
        (await bump(opts.kv, 'register', ip.bucket, 3600)) > perIp
          ? ip.bucket
          : ip.wide && (await bump(opts.kv, 'register', ip.wide, 3600)) > (opts.registration?.perHourPer48 ?? perIp * 10)
            ? ip.wide
            : null
      if (out) {
        event({ type: 'registration_limited', ip: out })
        return json({ error: 'too_many_requests', error_description: 'Too many registrations; try again later' }, 429, { 'retry-after': '3600' })
      }
    }
    return lib.fetch(req, env, execOf(exec))
  }

  function resourceMetadata(door: D): Response {
    return json(
      {
        resource: resourceOf[door],
        authorization_servers: [issuer],
        bearer_methods_supported: ['header'],
        scopes_supported: [OAUTH_SCOPE],
        resource_name: `${opts.productName} (${opts.doorLabels?.[door] ?? door})`,
      },
      200,
      { 'access-control-allow-origin': '*', 'cache-control': 'public, max-age=300' },
    )
  }

  const metadataPaths = new Map<string, D>(doorNames.map((d) => [metadataUrlFor(resourceOf[d]), d]))

  async function live(grant: SeatGrant, door: D, req: Request): Promise<boolean> {
    if (grant.seat.tenant === null && !platformDoors.has(door)) return false
    if (!opts.checkSeat) return true
    try {
      return (await opts.checkSeat(grant, door, req)) === true
    } catch {
      return false
    }
  }

  async function resolveSeat(door: D, token: string, req: Request): Promise<SeatGrant | null> {
    if (!token || token.length > 1024 || !doorNames.includes(door)) return null
    if (keys.isKey(token, door)) {
      const r = await keys.resolve(token, door)
      if (!r || !(await live(r.grant, door, req))) return null
      await keys.touch(r.info.id)
      return r.grant
    }
    const parts = token.split(':')
    if (parts.length !== 3) return null
    const v = await lib.validateToken<GrantProps>(resourceOf[door], token, env)
    if (!v || v.audience !== resourceOf[door]) return null
    const p = v.props
    if (!p?.seat || !p.principal || p.seat.door !== door || p.principal.id !== v.userId) return null
    const grant: SeatGrant = { principal: p.principal, seat: p.seat }
    // An access token of a revoked grant, read from a stale cache or minted by a refresh that wrote the grant back.
    if (await risenOnCall(v.userId, parts[1]!)) return null
    // The client policy as it stands now; the grant record is read only when the lists alone cannot decide.
    const recorded = async () => ((await opts.kv.get(`grant:${v.userId}:${parts[1]!}`, { type: 'json' })) as StoredGrant | null)?.metadata
    if (!(await stillAllowed(door, v.clientId, recorded)).allowed) return null
    if (!(await live(grant, door, req))) return null
    await keys.touch(grantUseKey(parts[1]!))
    return grant
  }

  async function route(req: Request, exec?: { waitUntil(p: Promise<unknown>): void }): Promise<Response | null> {
    const url = new URL(req.url)
    const here = `${url.origin}${url.pathname}`
    const md = metadataPaths.get(`${here}${url.search}`) ?? metadataPaths.get(here)
    if (md) {
      if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: { 'access-control-allow-origin': '*', 'access-control-allow-methods': 'GET, OPTIONS' } })
      if (req.method !== 'GET' && req.method !== 'HEAD') return json({ error: 'method_not_allowed' }, 405, { allow: 'GET, HEAD, OPTIONS' })
      return resourceMetadata(md)
    }
    if (url.origin === new URL(issuer).origin && (url.pathname.startsWith('/.well-known/oauth-authorization-server') || url.pathname.startsWith('/.well-known/openid-configuration'))) {
      return lib.fetch(req, env, execOf(exec))
    }
    if (here === paths.authorize) {
      if (req.method === 'GET') return authorizeGet(req)
      if (req.method === 'POST') return authorizePost(req)
      return json({ error: 'method_not_allowed' }, 405, { allow: 'GET, POST' })
    }
    if (here === paths.callback) return req.method === 'GET' || req.method === 'POST' ? callback(req) : json({ error: 'method_not_allowed' }, 405, { allow: 'GET, POST' })
    if (here === paths.token) return token(req, exec)
    if (registration && here === paths.register) return register(req, exec)
    return null
  }

  return {
    callbackUrl: paths.callback,
    route,
    async fetch(req, _env, exec) {
      return (await route(req, exec)) ?? json({ error: 'not_found' }, 404)
    },
    door: (door) => ({ resolveSeat: (token, req) => resolveSeat(door, token, req), resourceMetadataUrl: metadataUrlFor(resourceOf[door]) }),
    resolveSeat,
    resourceMetadataUrl: (door) => metadataUrlFor(resourceOf[door]),
    async connectedApps(personId) {
      // The tombstone and last use of every grant, and the keys, read at once rather than one after another.
      const [rows, keyList] = await Promise.all([
        grantsOf(personId).then((grants) =>
          Promise.all(
            grants.map(async (g): Promise<ConnectedApp | null> => {
              const [gone, lastUsedAt] = await Promise.all([risen(personId, g.id), keys.lastUse(grantUseKey(g.id))])
              if (gone) return null
              const m = (g.metadata ?? {}) as Partial<GrantMeta>
              return {
                grantId: g.id,
                clientId: g.clientId,
                clientName: m.clientName ?? g.clientId,
                status: m.status ?? 'unverified',
                door: m.door ?? '',
                seatId: m.seatId ?? '',
                tenant: m.tenant ?? null,
                createdAt: g.createdAt * 1000,
                expiresAt: g.expiresAt ? g.expiresAt * 1000 : null,
                lastUsedAt,
              }
            }),
          ),
        ),
        keys.list(personId),
      ])
      return { apps: rows.filter((a): a is ConnectedApp => a !== null), keys: keyList }
    },
    async revokeApp(personId, grantId) {
      if (!(await grantsOf(personId)).some((g) => g.id === grantId)) return false
      await bury(personId, grantId)
      return true
    },
    keys,
    async personLostRole(personId, filter = {}) {
      let grants = 0
      for (const g of await grantsOf(personId)) {
        const m = (g.metadata ?? {}) as Partial<GrantMeta>
        if (filter.door && m.door !== filter.door) continue
        if (filter.tenant && m.tenant !== filter.tenant) continue
        await bury(personId, g.id)
        grants++
      }
      const n = await keys.revokeOwned(personId, { ...(filter.door ? { door: filter.door } : {}), ...(filter.tenant ? { tenant: filter.tenant } : {}) })
      return { grants, keys: n }
    },
    api: helpers,
  }
}

/** A Turnstile check against Cloudflare's siteverify, for `turnstile.verify`. */
export function turnstileVerifier(secret: string, fetcher: typeof fetch = fetch): (token: string, ip: string | null) => Promise<boolean> {
  return async (token, ip) => {
    const body = new FormData()
    body.set('secret', secret)
    body.set('response', token)
    if (ip) body.set('remoteip', ip)
    try {
      const r = await fetcher('https://challenges.cloudflare.com/turnstile/v0/siteverify', { method: 'POST', body })
      return ((await r.json()) as { success?: boolean }).success === true
    } catch {
      return false
    }
  }
}

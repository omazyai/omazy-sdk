// A notes product with an MCP door behind the oauth kit: claude.ai and other
// clients with a Client ID Metadata Document connect through OAuth, local
// clients through a personal key. Unverified clients are blocked and dynamic
// registration is off. The product's sign-in is faked at /sign-in, which
// signs in one demo person and, after one click, posts a one-time code back
// to the kit's callback.
// Grants live in the OAUTH_KV namespace; the rest is in memory, so this is
// for trying the kits. The issuer comes from configuration (ISSUER), never
// from the request's Host.
//
//   npx wrangler dev examples/oauth-worker.ts   (bind a KV namespace as OAUTH_KV, set ISSUER)

import { type Ctx, defineCapabilities, registry, schema } from '../src/capabilities/index'
import { createGuard, memoryGuardStore, memoryRateLimiter, memoryRequestLog, memorySwitches } from '../src/guard/index'
import { mcpServer } from '../src/mcp/index'
import { authorizationServer, type KvLike, type OAuthServer, signInCodes } from '../src/oauth/index'

type Door = 'org'
type Permission = 'notes.read'
type AppCtx = Ctx
const { capability } = defineCapabilities<AppCtx, Permission, Door>()

const notesList = capability({
  name: 'notes_list',
  audiences: ['org'],
  title: 'List notes',
  description: 'Lists the notes of the current branch, newest first, with their ids and titles. Not for searching inside a note: there is no search yet.',
  permission: 'notes.read',
  risk: 'R0',
  input: schema.object({}),
  version: 1,
  run: () => ({ rows: [{ id: 'n1', title: 'Call the plumber' }] }),
})
const reg = registry([notesList])

// The product's people and seats. A real product reads its tables.
const PEOPLE = { rina: { kind: 'member', id: 'rina', name: 'Rina' } }
const SEATS = { rina: { id: 'seat-rina', door: 'org' as const, tenant: 'branch-1' } }
const canRead = new Set(['rina'])

const guard = createGuard<AppCtx, Permission>({
  registry: reg,
  can: (ctx) => canRead.has(ctx.principal.id),
  secret: 'demo-secret-change-me-in-production-0123456789',
  store: memoryGuardStore(),
  policies: {},
  switches: memorySwitches(),
  rateLimit: memoryRateLimiter(),
  log: memoryRequestLog(),
})

interface Env {
  OAUTH_KV: KvLike
  /** The public origin, such as `https://mcp.notes.example`. Fixed in configuration. */
  ISSUER: string
  /** Optional: a Workers Rate Limiting binding for GET /authorize. */
  AUTHORIZE_LIMIT?: { limit(opts: { key: string }): Promise<{ success: boolean }> }
  /** Optional: a Workers Rate Limiting binding for the token endpoint. */
  TOKEN_LIMIT?: { limit(opts: { key: string }): Promise<{ success: boolean }> }
  /** Optional: the same for GET /authorize per IPv6 /48, with a higher limit (ten times is a fair start). */
  AUTHORIZE_LIMIT_48?: { limit(opts: { key: string }): Promise<{ success: boolean }> }
  /** Optional: the same for the token endpoint per IPv6 /48, with a higher limit. */
  TOKEN_LIMIT_48?: { limit(opts: { key: string }): Promise<{ success: boolean }> }
}

let built: { oauth: OAuthServer<Door>; door: ReturnType<typeof mcpServer>; codes: ReturnType<typeof signInCodes>; origin: string } | undefined

function build(env: Env) {
  const origin = new URL(env.ISSUER).origin
  if (built?.origin === origin) return built
  const codes = signInCodes(env.OAUTH_KV)
  const oauth = authorizationServer<Door>({
    issuer: origin,
    kv: env.OAUTH_KV,
    doors: { org: `${origin}/org` },
    // Every seat here belongs to a branch: no platform door.
    platformDoors: [],
    productName: 'Notes',
    signIn: { url: `${origin}/sign-in`, authenticate: (code, state) => codes.redeem(code, state) },
    chooseSeat: (person) => SEATS[person.id as keyof typeof SEATS] ?? null,
    checkSeat: (grant) => SEATS[grant.principal.id as keyof typeof SEATS]?.id === grant.seat.id,
    // Clients with a metadata document are verified by its domain; unverified clients stay blocked (the default).
    clients: { org: { others: 'allow', unverified: 'block' } },
    keys: { personal: { prefix: (d) => `notes_mcp_${d}_` } },
    rateLimit: {
      ...(env.AUTHORIZE_LIMIT ? { authorize: env.AUTHORIZE_LIMIT } : {}),
      ...(env.TOKEN_LIMIT ? { token: env.TOKEN_LIMIT } : {}),
      ...(env.AUTHORIZE_LIMIT_48 ? { authorizePer48: env.AUTHORIZE_LIMIT_48 } : {}),
      ...(env.TOKEN_LIMIT_48 ? { tokenPer48: env.TOKEN_LIMIT_48 } : {}),
    },
  })
  const door = mcpServer<AppCtx, Door>({ registry: reg, guard, door: 'org', ...oauth.door('org'), info: { name: 'notes-org', version: '1.0.0' } })
  built = { oauth, door, codes, origin }
  return built
}

export default {
  async fetch(request: Request, env: Env, exec: { waitUntil(p: Promise<unknown>): void }): Promise<Response> {
    if (!env.ISSUER) return new Response('ISSUER is not configured', { status: 500 })
    const { oauth, door, codes, origin } = build(env)
    // Requests are read against the configured issuer, whatever Host they came with
    // (a test harness or a proxy may reach the Worker under another address).
    const u = new URL(request.url)
    const req = u.origin === origin ? request : new Request(`${origin}${u.pathname}${u.search}`, request)
    const url = new URL(req.url)
    if (url.pathname === '/sign-in') {
      // The product's sign-in: here, Rina is always signed in. return_to must be
      // exactly the kit's callback, and the code is issued for this flow's state.
      // The page asks for one click and posts the code back: a link someone else
      // sent never finishes a flow by itself, and the code stays out of the
      // address bar, history and logs.
      const state = url.searchParams.get('state')
      if (url.searchParams.get('return_to') !== oauth.callbackUrl || !state) return new Response('bad sign-in request', { status: 400 })
      const code = await codes.issue(PEOPLE.rina, { state })
      const esc = (v: string) => v.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`)
      const html = `<!doctype html><meta charset="utf-8"><title>Connect an app</title>
<p>Signed in as ${esc(PEOPLE.rina.name)}. Connect the app that sent you here?</p>
<form method="post" action="${esc(oauth.callbackUrl)}">
<input type="hidden" name="state" value="${esc(state)}"><input type="hidden" name="code" value="${esc(code)}">
<button type="submit">Continue</button></form>`
      return new Response(html, {
        headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', 'content-security-policy': "default-src 'none'; form-action 'self'; frame-ancestors 'none'", 'x-frame-options': 'DENY' },
      })
    }
    return (await oauth.route(req, exec)) ?? door.fetch(req, env, exec)
  },
}

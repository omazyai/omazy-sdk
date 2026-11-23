// OAuth for MCP clients that connect by signing in (claude.ai, ChatGPT), on
// Cloudflare's Workers OAuth provider. OFF by default: OAUTH in
// wrangler.jsonc is "off" and the door takes personal keys only.
//
// Read the oauth kit page before you turn it on. Its security fixes still
// need a final review before a product opens a door with it, and your
// product must supply the sign-in: the stub at /sign-in signs in a demo
// person only under `wrangler dev`.

import { authorizationServer, durableObjectRefreshStore, type OAuthServer, signInCodes } from '@omazyai/sdk/oauth'
import type { Env } from './env'
import { keyOptions } from './keys'
import { DOOR, type Door } from './types'

export { OAuthRefreshLock } from '@omazyai/sdk/oauth'

/** The tenant a person signs in to. Replace with your own members table. */
const DEMO_TENANT = 'demo'

let built: { server: OAuthServer<Door>; origin: string } | undefined

export function oauthFor(env: Env): OAuthServer<Door> | null {
  if (env.OAUTH !== 'on' || !env.ISSUER) return null
  const origin = new URL(env.ISSUER).origin
  if (built?.origin === origin) return built.server
  const codes = signInCodes(env.KV)
  const server = authorizationServer<Door>({
    issuer: origin,
    kv: env.KV,
    productName: '%%title%%',
    doors: { [DOOR]: `${origin}/mcp` } as Record<Door, string>,
    platformDoors: [],
    signIn: { url: `${origin}/sign-in`, authenticate: (code, state) => codes.redeem(code, state) },
    chooseSeat: (person) => ({ id: `seat_${person.id}`, door: DOOR, tenant: DEMO_TENANT }),
    checkSeat: (grant) => grant.seat.tenant === DEMO_TENANT,
    // Clients with a metadata document are verified by its domain; unverified clients stay blocked.
    clients: { [DOOR]: { others: 'allow', unverified: 'block' } } as never,
    keys: keyOptions,
    refresh: { store: durableObjectRefreshStore(env.OAUTH_REFRESH) },
    rateLimit: { authorize: env.AUTHORIZE_LIMIT, token: env.TOKEN_LIMIT },
  })
  built = { server, origin }
  return server
}

/** The product's sign-in. A stub: under `wrangler dev` it signs in one demo person after a click; deployed, it refuses. */
export async function signInPage(req: Request, env: Env, oauth: OAuthServer<Door>): Promise<Response> {
  const url = new URL(req.url)
  const local = url.hostname === 'localhost' || url.hostname === '127.0.0.1'
  if (!local) return new Response('Connect your product sign-in in src/oauth.ts.', { status: 501 })
  const state = url.searchParams.get('state')
  if (url.searchParams.get('return_to') !== oauth.callbackUrl || !state) return new Response('bad sign-in request', { status: 400 })
  const code = await signInCodes(env.KV).issue({ kind: 'member', id: 'dev', name: 'Developer' }, { state })
  const esc = (v: string) => v.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`)
  const html = `<!doctype html><meta charset="utf-8"><title>Connect an app</title>
<p>Signed in as the demo developer. Connect the app that sent you here?</p>
<form method="post" action="${esc(oauth.callbackUrl)}">
<input type="hidden" name="state" value="${esc(state)}"><input type="hidden" name="code" value="${esc(code)}">
<button type="submit">Continue</button></form>`
  return new Response(html, {
    headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', 'content-security-policy': "default-src 'none'; form-action 'self'; frame-ancestors 'none'", 'x-frame-options': 'DENY' },
  })
}

// The oauth kit against the real library, on the in-memory KV. The library
// imports `cloudflare:workers` for a class the authorization server never
// uses, so it is stubbed here; workerd runs it for real in oauth.workerd.test.ts.

import { afterEach, beforeAll, describe, expect, mock, setSystemTime, test } from 'bun:test'

mock.module('cloudflare:workers', () => ({ WorkerEntrypoint: class {} }))

import type { Ctx, Principal, Seat } from '../src/capabilities/index'
import { defineCapabilities, registry, schema } from '../src/capabilities/index'
import { b64url, sha256Hex } from '../src/guard/crypto'
import { createGuard, memoryGuardStore, memoryRateLimiter, memoryRequestLog, memorySwitches } from '../src/guard/index'
import type { SeatGrant } from '../src/mcp/index'

type OAuthMod = typeof import('../src/oauth/index')
type McpMod = typeof import('../src/mcp/index')
let O: OAuthMod
let M: McpMod

beforeAll(async () => {
  O = await import('../src/oauth/index')
  M = await import('../src/mcp/index')
})
afterEach(() => setSystemTime())

const ISSUER = 'https://mcp.example.com'
const DOORS = { platform: `${ISSUER}/platform`, org: `${ISSUER}/org` }
type Door = keyof typeof DOORS
const REDIRECT = 'https://client.example/cb'
const EVIL = 'https://evil.example/cb'

// The product: people, their seats, their permissions. Mutable, as the database is.
type Perm = 'notes.read' | 'notes.write'
type AppCtx = Ctx
const people: Record<string, { principal: Principal; seats: Partial<Record<Door, Seat>>; perms: Set<Perm> }> = {}
function resetPeople() {
  for (const k of Object.keys(people)) delete people[k]
  people.rina = { principal: { kind: 'member', id: 'rina', name: 'Rina' }, seats: { org: { id: 'seat-rina-b1', door: 'org', tenant: 'branch-1' } }, perms: new Set(['notes.read', 'notes.write']) }
  people.imran = {
    principal: { kind: 'super_admin', id: 'imran' },
    seats: { platform: { id: 'seat-imran', door: 'platform', tenant: null }, org: { id: 'seat-imran-b1', door: 'org', tenant: 'branch-1' } },
    perms: new Set(['notes.read']),
  }
}

const { capability } = defineCapabilities<AppCtx, Perm, Door>()
const notesList = capability({
  name: 'notes_list',
  audiences: ['org'],
  title: 'List notes',
  description: 'Lists the notes of the current branch, newest first, with ids and titles. Not for searching inside a note.',
  permission: 'notes.read',
  risk: 'R0',
  input: schema.object({}),
  version: 1,
  run: () => ({ rows: [] }),
})
const reg = registry([notesList])

async function pkce() {
  const verifier = b64url(crypto.getRandomValues(new Uint8Array(32)))
  const challenge = b64url(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier))))
  return { verifier, challenge }
}

/** A browser: keeps cookies per name, sends them back. */
class Jar {
  cookies = new Map<string, string>()
  take(res: Response) {
    for (const c of res.headers.getSetCookie()) {
      const [pair] = c.split(';')
      const i = pair!.indexOf('=')
      const name = pair!.slice(0, i)
      const value = pair!.slice(i + 1)
      if (/max-age=0/i.test(c) || value === '') this.cookies.delete(name)
      else this.cookies.set(name, value)
    }
    return res
  }
  header() {
    return [...this.cookies].map(([k, v]) => `${k}=${v}`).join('; ')
  }
}

const unescape = (s: string) => s.replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)))

/**
 * The platform door's known list. A platform door needs one; a test that
 * connects a pre-registered client there adds the client's id with `knowAt`.
 */
const PLATFORM_KNOWN: string[] = []
const knowAt = (clientId: string) => PLATFORM_KNOWN.push(clientId)

function setup(extra: Partial<Parameters<OAuthMod['authorizationServer']>[0]> = {}) {
  resetPeople()
  PLATFORM_KNOWN.splice(0, PLATFORM_KNOWN.length, 'https://claude.example/oauth/client.json')
  const kv = O.memoryKv()
  const codes = O.signInCodes(kv)
  const events: any[] = []
  const oauth = O.authorizationServer<Door>({
    issuer: ISSUER,
    kv,
    doors: DOORS,
    productName: 'Notes',
    signIn: { url: 'https://app.example.com/mcp-sign-in', authenticate: (code, state) => codes.redeem(code, state) },
    chooseSeat: (person, door) => people[person.id]?.seats[door] ?? null,
    checkSeat: (grant, door) => people[grant.principal.id]?.seats[door]?.id === grant.seat.id || grant.principal.kind === 'service',
    keys: { personal: { prefix: (d) => `notes_mcp_${d}_` }, service: { prefix: (d) => `notes_svc_${d}_` } },
    onEvent: (e) => events.push(e),
    platformDoors: ['platform'],
    // The tests run in one isolate on the KV default; the consistent stores have their own tests.
    refresh: { acceptKvRace: true },
    ...extra,
    // Test clients are pre-registered and not on a list, so unverified: allowed at org unless a test says
    // otherwise. The platform door knows only the ids on PLATFORM_KNOWN unless a test sets its own policy.
    clients: { platform: { known: PLATFORM_KNOWN }, ...(extra.clients ?? { org: { unverified: 'allow' } }) },
  })
  return { kv, codes, oauth, events }
}

/** The options `setup` passes, for a test that builds a second server on the same KV. */
function baseOptions(s: ReturnType<typeof setup>): Parameters<OAuthMod['authorizationServer']>[0] {
  return {
    issuer: ISSUER,
    kv: s.kv,
    doors: DOORS,
    productName: 'Notes',
    signIn: { url: 'https://app.example.com/mcp-sign-in', authenticate: (code, state) => s.codes.redeem(code, state) },
    chooseSeat: (person, door) => people[person.id]?.seats[door as Door] ?? null,
    checkSeat: (grant, door) => people[grant.principal.id]?.seats[door as Door]?.id === grant.seat.id || grant.principal.kind === 'service',
    onEvent: (e) => s.events.push(e),
    platformDoors: ['platform'],
    refresh: { acceptKvRace: true },
  }
}

async function client(oauth: ReturnType<typeof setup>['oauth'], name = 'Test Client') {
  return oauth.api().createClient({ redirectUris: [REDIRECT], clientName: name, tokenEndpointAuthMethod: 'none' })
}

function authorizeUrl(clientId: string, challenge: string, extra: Record<string, string | null> = {}) {
  const u = new URL(`${ISSUER}/authorize`)
  const p: Record<string, string | null> = {
    response_type: 'code',
    client_id: clientId,
    redirect_uri: REDIRECT,
    state: 'st-1',
    code_challenge: challenge,
    code_challenge_method: 'S256',
    resource: DOORS.org,
    ...extra,
  }
  for (const [k, v] of Object.entries(p)) if (v !== null) u.searchParams.set(k, v)
  return u.toString()
}

const form = (data: Record<string, string>, cookie = '') =>
  ({ method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded', ...(cookie ? { cookie } : {}) }, body: new URLSearchParams(data).toString() }) as RequestInit

/** The whole browser flow, up to the code at the client's redirect URI. */
async function authorize(s: ReturnType<typeof setup>, clientId: string, opts: { door?: Door; person?: string; jar?: Jar } = {}) {
  const door = opts.door ?? 'org'
  const jar = opts.jar ?? new Jar()
  const { verifier, challenge } = await pkce()
  const page = jar.take(await s.oauth.fetch(new Request(authorizeUrl(clientId, challenge, { resource: DOORS[door] }))))
  expect(page.status).toBe(200)
  const html = await page.text()
  const handle = unescape(/name="handle" value="([^"]+)"/.exec(html)![1]!)
  const approve = jar.take(await s.oauth.fetch(new Request(`${ISSUER}/authorize`, form({ handle, decision: 'approve' }, jar.header()))))
  expect(approve.status).toBe(302)
  const signIn = new URL(approve.headers.get('location')!)
  expect(signIn.origin).toBe('https://app.example.com')
  expect(signIn.searchParams.get('return_to')).toBe(s.oauth.callbackUrl)
  const code = await s.codes.issue(people[opts.person ?? 'rina']!.principal, { state: signIn.searchParams.get('state')! })
  const cb = new URL(signIn.searchParams.get('return_to')!)
  cb.searchParams.set('state', signIn.searchParams.get('state')!)
  cb.searchParams.set('code', code)
  const back = jar.take(await s.oauth.fetch(new Request(cb, { headers: { cookie: jar.header() } })))
  expect(back.status).toBe(302)
  const to = new URL(back.headers.get('location')!)
  return { to, verifier, html, page, jar }
}

async function exchange(s: ReturnType<typeof setup>, clientId: string, code: string, verifier: string, door: Door = 'org') {
  const res = await s.oauth.fetch(
    new Request(`${ISSUER}/oauth/token`, form({ grant_type: 'authorization_code', code, redirect_uri: REDIRECT, client_id: clientId, code_verifier: verifier, resource: DOORS[door] })),
  )
  return { res, body: (await res.json()) as any }
}

const refresh = async (s: ReturnType<typeof setup>, clientId: string, token: string) => {
  const res = await s.oauth.fetch(new Request(`${ISSUER}/oauth/token`, form({ grant_type: 'refresh_token', refresh_token: token, client_id: clientId })))
  return { res, body: (await res.json()) as any }
}

async function connected(s: ReturnType<typeof setup>, door: Door = 'org', person = 'rina') {
  const c = await client(s.oauth)
  // A platform door takes only clients on its known list.
  if (door === 'platform') knowAt(c.clientId)
  const a = await authorize(s, c.clientId, { door, person })
  const t = await exchange(s, c.clientId, a.to.searchParams.get('code')!, a.verifier, door)
  expect(t.res.status).toBe(200)
  return { clientId: c.clientId, access: t.body.access_token as string, refresh: t.body.refresh_token as string, body: t.body }
}

const req = (token = '') => new Request(`${ISSUER}/org`, { headers: token ? { authorization: `Bearer ${token}` } : {} })

describe('oauth: discovery', () => {
  test('RFC 9728 metadata per door names the resource and the issuer', async () => {
    const s = setup()
    for (const door of ['platform', 'org'] as const) {
      const url = s.oauth.resourceMetadataUrl(door)
      expect(url).toBe(`${ISSUER}/.well-known/oauth-protected-resource/${door}`)
      const res = await s.oauth.fetch(new Request(url))
      expect(res.status).toBe(200)
      expect(res.headers.get('access-control-allow-origin')).toBe('*')
      const md = (await res.json()) as any
      expect(md.resource).toBe(DOORS[door])
      expect(md.authorization_servers).toEqual([ISSUER])
      expect(md.bearer_methods_supported).toEqual(['header'])
    }
  })

  test('RFC 8414 metadata: S256 only, code only, issuer in responses, no registration unless switched on', async () => {
    const s = setup()
    const md = (await (await s.oauth.fetch(new Request(`${ISSUER}/.well-known/oauth-authorization-server`))).json()) as any
    expect(md.issuer).toBe(ISSUER)
    expect(md.authorization_endpoint).toBe(`${ISSUER}/authorize`)
    expect(md.token_endpoint).toBe(`${ISSUER}/oauth/token`)
    expect(md.code_challenge_methods_supported).toEqual(['S256'])
    expect(md.response_types_supported).toEqual(['code'])
    expect(md.authorization_response_iss_parameter_supported).toBe(true)
    expect(md.registration_endpoint).toBeUndefined()
    expect((await s.oauth.fetch(new Request(`${ISSUER}/oauth/register`, { method: 'POST' }))).status).toBe(404)
    const on = setup({ registration: { enabled: true } })
    const md2 = (await (await on.oauth.fetch(new Request(`${ISSUER}/.well-known/oauth-authorization-server`))).json()) as any
    expect(md2.registration_endpoint).toBe(`${ISSUER}/oauth/register`)
  })

  test('a door without a token answers 401 with WWW-Authenticate resource_metadata', async () => {
    const s = setup()
    const door = M.mcpServer<AppCtx, Door>({ registry: reg, guard: guardFor(), door: 'org', ...s.oauth.door('org'), info: { name: 'notes', version: '1' } })
    const res = await door.fetch(req())
    expect(res.status).toBe(401)
    const h = res.headers.get('www-authenticate')!
    expect(h.startsWith('Bearer ')).toBe(true)
    expect(h).toContain(`resource_metadata="${ISSUER}/.well-known/oauth-protected-resource/org"`)
    expect(/^[\x20-\x7e]*$/.test(h)).toBe(true)
  })

  test('the kit answers only its own routes', async () => {
    const s = setup()
    expect(await s.oauth.route(new Request(`${ISSUER}/org`))).toBeNull()
    expect(await s.oauth.route(new Request(`${ISSUER}/somewhere`))).toBeNull()
  })
})

describe('oauth: the authorization request', () => {
  test('resource is required, even with a default the library would pick, and its absence is shown, never redirected', async () => {
    const s0 = setup()
    const c = await client(s0.oauth)
    const s = { ...s0, oauth: O.authorizationServer<Door>({ ...baseOptions(s0), doors: { org: DOORS.org } as never, platformDoors: [], clients: { org: { known: [c.clientId] } } }) }
    const { challenge } = await pkce()
    const res = await s.oauth.fetch(new Request(authorizeUrl(c.clientId, challenge, { resource: null })))
    expect(res.status).toBe(400)
    expect(res.headers.get('location')).toBeNull()
    expect(s0.events.some((e) => e.reason === 'resource_missing')).toBe(true)
  })

  test('after the client is validated, errors go back to a known client with state and iss', async () => {
    const s0 = setup()
    const c = await client(s0.oauth)
    const s = O.authorizationServer<Door>({ ...baseOptions(s0), clients: { platform: { known: PLATFORM_KNOWN }, org: { known: [c.clientId] } } })
    const { challenge } = await pkce()
    const res = await s.fetch(new Request(authorizeUrl(c.clientId, challenge, { code_challenge_method: 'plain' })))
    expect(res.status).toBe(302)
    const to = new URL(res.headers.get('location')!)
    expect(`${to.origin}${to.pathname}`).toBe(REDIRECT)
    expect(to.searchParams.get('error')).toBe('invalid_request')
    expect(to.searchParams.get('state')).toBe('st-1')
    expect(to.searchParams.get('iss')).toBe(ISSUER)
    // The library's own errors too (here an unsupported response type).
    const lib = await s.fetch(new Request(authorizeUrl(c.clientId, challenge, { response_type: 'token' })))
    expect(new URL(lib.headers.get('location')!).searchParams.get('error')).toBeTruthy()
  })

  test('two resources, or a resource that is not a door, are refused', async () => {
    const s = setup()
    const c = await client(s.oauth)
    const { challenge } = await pkce()
    const u = new URL(authorizeUrl(c.clientId, challenge))
    u.searchParams.append('resource', DOORS.platform)
    const two = await s.oauth.fetch(new Request(u))
    expect(two.status).toBe(400)
    expect(two.headers.get('location')).toBeNull()
    const other = await s.oauth.fetch(new Request(authorizeUrl(c.clientId, challenge, { resource: 'https://evil.example/org' })))
    expect(other.status).toBe(400)
    expect(other.headers.get('location')).toBeNull()
  })

  test('PKCE: no challenge and plain are refused; S256 passes', async () => {
    const s = setup()
    const c = await client(s.oauth)
    const { challenge } = await pkce()
    for (const extra of [{ code_challenge: null, code_challenge_method: null }, { code_challenge_method: 'plain' }, { code_challenge_method: null }]) {
      const res = await s.oauth.fetch(new Request(authorizeUrl(c.clientId, challenge, extra)))
      if (res.status === 302) expect(new URL(res.headers.get('location')!).searchParams.get('error')).toBe('invalid_request')
      else expect(res.status).toBe(400)
    }
    expect((await s.oauth.fetch(new Request(authorizeUrl(c.clientId, challenge)))).status).toBe(200)
  })

  test('PKCE also binds a confidential client', async () => {
    const s = setup()
    const c = await s.oauth.api().createClient({ redirectUris: [REDIRECT], clientName: 'Server App', tokenEndpointAuthMethod: 'client_secret_basic' })
    const { challenge } = await pkce()
    const res = await s.oauth.fetch(new Request(authorizeUrl(c.clientId, challenge, { code_challenge: null, code_challenge_method: null })))
    expect(res.status).toBe(400)
    expect(await res.text()).toContain('PKCE')
  })

  test('the code is useless without the verifier', async () => {
    const s = setup()
    const c = await client(s.oauth)
    const a = await authorize(s, c.clientId)
    const wrong = await exchange(s, c.clientId, a.to.searchParams.get('code')!, b64url(crypto.getRandomValues(new Uint8Array(32))))
    expect(wrong.res.status).toBe(400)
    expect(wrong.body.error).toBe('invalid_grant')
  })

  test('an unknown redirect URI is shown locally, never redirected to', async () => {
    const s = setup()
    const c = await client(s.oauth)
    const { challenge } = await pkce()
    const res = await s.oauth.fetch(new Request(authorizeUrl(c.clientId, challenge, { redirect_uri: 'https://evil.example/cb' })))
    expect(res.status).toBe(400)
    expect(res.headers.get('location')).toBeNull()
  })
})

describe('oauth: consent page', () => {
  test('cannot be framed, is not cached, escapes the client name, shows the redirect host and status', async () => {
    const s = setup()
    const c = await client(s.oauth, '<img src=x onerror=alert(1)>')
    const { challenge } = await pkce()
    const res = await s.oauth.fetch(new Request(authorizeUrl(c.clientId, challenge)))
    const csp = res.headers.get('content-security-policy')!
    expect(csp).toContain("frame-ancestors 'none'")
    expect(csp).toContain("default-src 'none'")
    expect(res.headers.get('x-frame-options')).toBe('DENY')
    expect(res.headers.get('cache-control')).toContain('no-store')
    const html = await res.text()
    expect(html).not.toContain('<img')
    expect(html).toContain('client.example')
    expect(html).toContain('Not verified')
    expect(html).not.toContain('<script')
  })

  test('CSRF: a post without the browser cookie, with a made-up handle or a used handle is refused', async () => {
    const s = setup()
    const c = await client(s.oauth)
    const { challenge } = await pkce()
    const jar = new Jar()
    const html = await jar.take(await s.oauth.fetch(new Request(authorizeUrl(c.clientId, challenge)))).text()
    const handle = unescape(/name="handle" value="([^"]+)"/.exec(html)![1]!)
    const forged = await s.oauth.fetch(new Request(`${ISSUER}/authorize`, form({ handle, decision: 'approve' })))
    expect(forged.status).toBe(400)
    expect(forged.headers.get('location')).toBeNull()
    const madeUp = await s.oauth.fetch(new Request(`${ISSUER}/authorize`, form({ handle: 'x'.repeat(43), decision: 'approve' }, jar.header())))
    expect(madeUp.status).toBe(400)
    const ok = await s.oauth.fetch(new Request(`${ISSUER}/authorize`, form({ handle, decision: 'approve' }, jar.header())))
    expect(ok.status).toBe(302)
    const again = await s.oauth.fetch(new Request(`${ISSUER}/authorize`, form({ handle, decision: 'approve' }, jar.header())))
    expect(again.status).toBe(400)
  })

  test('cancel goes back to the client with access_denied', async () => {
    const s = setup()
    const c = await client(s.oauth)
    const { challenge } = await pkce()
    const jar = new Jar()
    const html = await jar.take(await s.oauth.fetch(new Request(authorizeUrl(c.clientId, challenge)))).text()
    const handle = unescape(/name="handle" value="([^"]+)"/.exec(html)![1]!)
    const res = await s.oauth.fetch(new Request(`${ISSUER}/authorize`, form({ handle, decision: 'deny' }, jar.header())))
    const to = new URL(res.headers.get('location')!)
    expect(to.searchParams.get('error')).toBe('access_denied')
    expect(to.searchParams.get('state')).toBe('st-1')
  })

  test('Turnstile appears after repeated attempts and its token is checked', async () => {
    const seen: string[] = []
    const s = setup({ turnstile: { siteKey: 'site-1', after: 2, verify: (t) => (seen.push(t), t === 'good') } })
    const c = await client(s.oauth)
    const open = async () => {
      const jar = new Jar()
      const { challenge } = await pkce()
      const r = jar.take(await s.oauth.fetch(new Request(authorizeUrl(c.clientId, challenge), { headers: { 'cf-connecting-ip': '203.0.113.9' } })))
      const html = await r.text()
      return { jar, html, r, handle: unescape(/name="handle" value="([^"]+)"/.exec(html)![1]!) }
    }
    expect((await open()).html).not.toContain('cf-turnstile')
    await open()
    const third = await open()
    expect(third.html).toContain('data-sitekey="site-1"')
    expect(third.r.headers.get('content-security-policy')).toContain('https://challenges.cloudflare.com')
    const post = (token: string) =>
      new Request(`${ISSUER}/authorize`, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded', cookie: third.jar.header(), 'cf-connecting-ip': '203.0.113.9' },
        body: new URLSearchParams({ handle: third.handle, decision: 'approve', 'cf-turnstile-response': token }).toString(),
      })
    expect((await s.oauth.fetch(post('bad'))).status).toBe(400)
    expect(s.events.some((e) => e.type === 'turnstile_failed')).toBe(true)
    expect((await s.oauth.fetch(post('good'))).status).toBe(302)
    expect(seen).toEqual(['bad', 'good'])
  })
})

describe('oauth: client allow list per door', () => {
  test('unverified clients are blocked by default and allowed where the door says so', async () => {
    const s = setup({ clients: { org: { unverified: 'allow' } } })
    const c = await client(s.oauth)
    const { challenge } = await pkce()
    const plat = await s.oauth.fetch(new Request(authorizeUrl(c.clientId, challenge, { resource: DOORS.platform })))
    expect(plat.status).toBe(403)
    expect(plat.headers.get('location')).toBeNull()
    expect(s.events.some((e) => e.type === 'client_blocked' && e.door === 'platform')).toBe(true)
    expect((await s.oauth.fetch(new Request(authorizeUrl(c.clientId, challenge)))).status).toBe(200)
  })

  test('a known client passes a door that blocks others, and is shown as known', async () => {
    const s0 = setup()
    const known = await client(s0.oauth, 'Claude')
    const other = await client(s0.oauth, 'Someone')
    const s = { ...s0 }
    const policy = O.authorizationServer<Door>({
      issuer: ISSUER,
      kv: s0.kv,
      doors: DOORS,
      productName: 'Notes',
      signIn: { url: 'https://app.example.com/s', authenticate: () => null },
      chooseSeat: () => null,
      checkSeat: () => true,
      refresh: { acceptKvRace: true },
      platformDoors: ['platform'],
      clients: { platform: { known: [known.clientId], others: 'block', unverified: 'block' } },
    })
    const { challenge } = await pkce()
    const ok = await policy.fetch(new Request(authorizeUrl(known.clientId, challenge, { resource: DOORS.platform })))
    expect(ok.status).toBe(200)
    expect(await ok.text()).toContain('is an app Notes knows')
    const no = await policy.fetch(new Request(authorizeUrl(other.clientId, challenge, { resource: DOORS.platform })))
    expect(no.status).toBe(403)
    expect(s).toBeTruthy()
  })

  test('a client blocked while its consent page was open is refused at approval', async () => {
    const policy: Record<string, any> = { org: { unverified: 'allow' } }
    const s = setup({ clients: policy })
    const c = await client(s.oauth)
    const { challenge } = await pkce()
    const jar = new Jar()
    const html = await jar.take(await s.oauth.fetch(new Request(authorizeUrl(c.clientId, challenge)))).text()
    const handle = unescape(/name="handle" value="([^"]+)"/.exec(html)![1]!)
    policy.org.unverified = 'block'
    const res = await s.oauth.fetch(new Request(`${ISSUER}/authorize`, form({ handle, decision: 'approve' }, jar.header())))
    expect(res.status).toBe(403)
    expect(res.headers.get('location')).toBeNull()
  })

  // Review finding 4: blocked and untrusted clients had their redirect URI used for error redirects.
  test('a blocked metadata client never gets the browser sent to its own URL', async () => {
    const evilId = 'https://evil.example/client.json'
    const restore = cimd({ [evilId]: doc(evilId, 'https://evil.example/phish', 'x') })
    try {
      const s = setup({ clients: { platform: { known: ['https://claude.example/oauth/client.json'], others: 'block', unverified: 'block' } } })
      const { challenge } = await pkce()
      const base = { response_type: 'code', client_id: evilId, redirect_uri: 'https://evil.example/phish', code_challenge: challenge, code_challenge_method: 'S256' }
      const url = (p: Record<string, string>) => {
        const u = new URL(`${ISSUER}/authorize`)
        for (const [k, v] of Object.entries(p)) u.searchParams.set(k, v)
        return u.toString()
      }
      const blocked = await s.oauth.fetch(new Request(url({ ...base, resource: DOORS.platform })))
      expect(blocked.status).toBe(403)
      expect(blocked.headers.get('location')).toBeNull()
      const noResource = await s.oauth.fetch(new Request(url(base)))
      expect(noResource.status).toBe(400)
      expect(noResource.headers.get('location')).toBeNull()
      // The library's own error (an unsupported response type) is shown too.
      const libError = await s.oauth.fetch(new Request(url({ ...base, response_type: 'token', resource: DOORS.platform })))
      expect(libError.status).toBe(400)
      expect(libError.headers.get('location')).toBeNull()
    } finally {
      restore()
    }
  })

  test('a dynamically registered client, blocked or merely allowed, gets errors on the page', async () => {
    const s = setup({ registration: { enabled: true }, clients: { org: { unverified: 'allow' } } })
    const reg = await s.oauth.fetch(
      new Request(`${ISSUER}/oauth/register`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'cf-connecting-ip': '198.51.100.8' },
        body: JSON.stringify({ redirect_uris: ['https://evil.example/phish'], client_name: 'x', token_endpoint_auth_method: 'none' }),
      }),
    )
    const { client_id } = (await reg.json()) as any
    const { challenge } = await pkce()
    for (const [resource, extra, status] of [
      [DOORS.platform, {}, 403],
      [DOORS.org, { code_challenge_method: 'plain' }, 400],
      [DOORS.org, { response_type: 'token' }, 400],
    ] as const) {
      const res = await s.oauth.fetch(new Request(authorizeUrl(client_id, challenge, { redirect_uri: 'https://evil.example/phish', resource, ...extra })))
      expect(res.status).toBe(status)
      expect(res.headers.get('location')).toBeNull()
    }
  })

  test('dynamic registration is rate limited per address', async () => {
    const s = setup({ registration: { enabled: true, perHourPerIp: 2 }, clients: { org: { unverified: 'allow' } } })
    const reg = () =>
      s.oauth.fetch(
        new Request(`${ISSUER}/oauth/register`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', 'cf-connecting-ip': '198.51.100.7' },
          body: JSON.stringify({ redirect_uris: [REDIRECT], client_name: 'Legacy', token_endpoint_auth_method: 'none' }),
        }),
      )
    expect((await reg()).status).toBe(201)
    expect((await reg()).status).toBe(201)
    const third = await reg()
    expect(third.status).toBe(429)
    expect(s.events.some((e) => e.type === 'registration_limited')).toBe(true)
  })
})

/** Serves metadata documents in place of the network. `redirects` answers 302 to a fetch that refuses redirects, and the document to one that follows. */
function cimd(docs: Record<string, unknown>, opts: { seen?: { url: string; init: any }[]; redirects?: Set<string> } = {}) {
  const g = globalThis as any
  const realFetch = g.fetch
  g.Cloudflare = { compatibilityFlags: { global_fetch_strictly_public: true } }
  g.fetch = async (input: any, init?: any) => {
    const url = typeof input === 'string' ? input : input.url
    opts.seen?.push({ url, init })
    if (opts.redirects?.has(url) && init?.redirect === 'manual') return new Response(null, { status: 302, headers: { location: 'https://evil.example/doc.json' } })
    const doc = docs[url]
    return doc ? new Response(JSON.stringify(doc), { headers: { 'content-type': 'application/json' } }) : new Response('gone', { status: 404 })
  }
  return () => {
    g.fetch = realFetch
    delete g.Cloudflare
  }
}

const doc = (id: string, redirect: string, name = 'Claude') => ({ client_id: id, client_name: name, redirect_uris: [redirect], token_endpoint_auth_method: 'none' })

describe('oauth: Client ID Metadata Documents', () => {
  const CLAUDE = 'https://claude.example/oauth/client.json'
  const CLAUDE_CB = 'https://claude.example/api/callback'

  test('a door knows a metadata client by its exact URL; another document is verified by its domain, or blocked', async () => {
    const restore = cimd({ [CLAUDE]: doc(CLAUDE, CLAUDE_CB), 'https://stranger.example/client.json': doc('https://stranger.example/client.json', 'https://app.stranger.example/cb') })
    try {
      const s = setup({ clients: { org: { unverified: 'allow' }, platform: { known: [CLAUDE], others: 'block', unverified: 'block' } } })
      const { challenge } = await pkce()
      const known = await s.oauth.fetch(new Request(authorizeUrl(CLAUDE, challenge, { resource: DOORS.platform, redirect_uri: CLAUDE_CB })))
      expect(known.status).toBe(200)
      const html = await known.text()
      expect(html).toContain('is an app Notes knows')
      expect(html).toContain('claude.example')
      const stranger = await s.oauth.fetch(new Request(authorizeUrl('https://stranger.example/client.json', challenge, { resource: DOORS.platform, redirect_uri: 'https://app.stranger.example/cb' })))
      expect(stranger.headers.get('location') ? new URL(stranger.headers.get('location')!).searchParams.get('error') : String(stranger.status)).toMatch(/access_denied|403/)
      const atOrg = await s.oauth.fetch(new Request(authorizeUrl('https://stranger.example/client.json', challenge, { redirect_uri: 'https://app.stranger.example/cb' })))
      const orgHtml = await atOrg.text()
      expect(orgHtml).toContain('verified by its metadata document')
      expect(orgHtml).toContain('stranger.example')
    } finally {
      restore()
    }
  })

  // Review finding 3: `known` matched any document on a listed domain, whatever its redirect URIs.
  test('a document anywhere on a known domain is not known, and one that sends access elsewhere is not verified', async () => {
    const EVIL = 'https://evil.example/cb'
    const id = 'https://claude.example/any/path/the-attacker-controls.json'
    const seen: { url: string; init: any }[] = []
    const restore = cimd({ [id]: doc(id, EVIL), [CLAUDE]: doc(CLAUDE, CLAUDE_CB) }, { seen })
    try {
      const s = setup({ clients: { platform: { known: [CLAUDE], others: 'block', unverified: 'block' }, org: { knownDomains: ['claude.example'], unverified: 'block' } } })
      const { challenge } = await pkce()
      for (const door of ['platform', 'org'] as const) {
        const res = await s.oauth.fetch(new Request(authorizeUrl(id, challenge, { resource: DOORS[door], redirect_uri: EVIL })))
        expect(res.status).not.toBe(200)
        expect(res.headers.get('location') ? new URL(res.headers.get('location')!).searchParams.get('error') : 'page').toMatch(/access_denied|page/)
      }
      expect(s.events.filter((e) => e.type === 'client_blocked' && e.status === 'unverified')).toHaveLength(2)
      // Opted in by domain, a document whose redirect URIs stay on its host is known.
      const ok = await s.oauth.fetch(new Request(authorizeUrl(CLAUDE, challenge, { redirect_uri: CLAUDE_CB })))
      expect(ok.status).toBe(200)
      expect(await ok.text()).toContain('is an app Notes knows')
      // The kit fetched each document itself with redirects refused.
      expect(seen.filter((f) => f.url === id).some((f) => f.init?.redirect === 'manual')).toBe(true)
    } finally {
      restore()
    }
  })

  test('a metadata URL that redirects is refused, though the library would follow it', async () => {
    const id = 'https://claude.example/redirect?to=evil'
    const restore = cimd({ [id]: doc(id, CLAUDE_CB) }, { redirects: new Set([id]) })
    try {
      const s = setup({ clients: { org: { knownDomains: ['claude.example'] } } })
      const { challenge } = await pkce()
      const res = await s.oauth.fetch(new Request(authorizeUrl(id, challenge, { redirect_uri: CLAUDE_CB })))
      expect(res.status).toBe(400)
      expect(res.headers.get('location')).toBeNull()
      expect(await res.text()).toContain('could not be verified')
      expect(s.events.some((e) => e.type === 'client_metadata_refused' && e.reason === 'redirect')).toBe(true)
    } finally {
      restore()
    }
  })

  // Review finding 6: the library served a withdrawn document from its last-good copy for 24 hours.
  test('a withdrawn metadata document stops working at once', async () => {
    const id = 'https://client.example/meta.json'
    const docs: Record<string, unknown> = { [id]: doc(id, 'https://client.example/cb', 'C') }
    const restore = cimd(docs)
    try {
      const s = setup({ clients: { org: { others: 'allow' } } })
      const { challenge } = await pkce()
      const url = authorizeUrl(id, challenge, { redirect_uri: 'https://client.example/cb' })
      expect((await s.oauth.fetch(new Request(url))).status).toBe(200)
      delete docs[id]
      const after = await s.oauth.fetch(new Request(url))
      expect(after.status).toBe(400)
      expect(after.headers.get('location')).toBeNull()
      expect(s.kv.dump().some((k) => k.startsWith('cimd:'))).toBe(false)
      // A product may keep a short copy to ride out a client's outage.
      docs[id] = doc(id, 'https://client.example/cb', 'C')
      const kept = setup({ clients: { org: { others: 'allow' } }, clientMetadataFallback: { maxAgeSeconds: 600 } })
      expect((await kept.oauth.fetch(new Request(url))).status).toBe(200)
      delete docs[id]
      expect((await kept.oauth.fetch(new Request(url))).status).toBe(200)
      setSystemTime(new Date(Date.now() + 601_000))
      expect((await kept.oauth.fetch(new Request(url))).status).toBe(400)
      expect(() => setup({ clientMetadataFallback: { maxAgeSeconds: 86_400 } })).toThrow('60 to 3600')
    } finally {
      restore()
    }
  })

  test('a bare domain on a known list, or a domain list on a platform door, is refused at start', () => {
    expect(() => setup({ clients: { platform: { known: ['claude.ai'] } } })).toThrow('exact client id')
    expect(() => setup({ clients: { org: { known: ['https://claude.ai/'] } } })).toThrow('exact client id')
    expect(() => setup({ clients: { platform: { knownDomains: ['claude.ai'] } } })).toThrow('platform door')
    expect(() => setup({ clients: { org: { knownDomains: ['claude.ai'] } } })).not.toThrow()
    expect(() => setup({ platformDoors: [], clients: { platform: { knownDomains: ['claude.ai'] } } })).not.toThrow()
  })
})

describe('oauth: sign-in through the product', () => {
  test('the consent page sends the browser to the product, which returns a one-time code', async () => {
    const s = setup({ clients: { org: { unverified: 'allow' } } })
    const c = await client(s.oauth)
    const a = await authorize(s, c.clientId)
    expect(`${a.to.origin}${a.to.pathname}`).toBe(REDIRECT)
    expect(a.to.searchParams.get('state')).toBe('st-1')
    expect(a.to.searchParams.get('iss')).toBe(ISSUER)
    expect(a.to.searchParams.get('code')).toBeTruthy()
  })

  test('a code used twice, a missing code and a refused sign-in end with access_denied', async () => {
    const s = setup({ clients: { org: { unverified: 'allow' } } })
    const c = await client(s.oauth)
    const start = async () => {
      const jar = new Jar()
      const { challenge } = await pkce()
      const html = await jar.take(await s.oauth.fetch(new Request(authorizeUrl(c.clientId, challenge)))).text()
      const handle = unescape(/name="handle" value="([^"]+)"/.exec(html)![1]!)
      const signIn = new URL(jar.take(await s.oauth.fetch(new Request(`${ISSUER}/authorize`, form({ handle, decision: 'approve' }, jar.header())))).headers.get('location')!)
      return { jar, state: signIn.searchParams.get('state')! }
    }
    const a = await start()
    const code = await s.codes.issue(people.rina!.principal, { state: a.state })
    expect(await s.codes.redeem(code, a.state)).toEqual(people.rina!.principal)
    const used = await s.oauth.fetch(new Request(`${ISSUER}/oauth/callback?state=${a.state}&code=${code}`, { headers: { cookie: a.jar.header() } }))
    expect(new URL(used.headers.get('location')!).searchParams.get('error')).toBe('access_denied')
    const b = await start()
    const none = await s.oauth.fetch(new Request(`${ISSUER}/oauth/callback?state=${b.state}`, { headers: { cookie: b.jar.header() } }))
    expect(new URL(none.headers.get('location')!).searchParams.get('error')).toBe('access_denied')
    const d = await start()
    const refused = await s.oauth.fetch(new Request(`${ISSUER}/oauth/callback?state=${d.state}&error=access_denied`, { headers: { cookie: d.jar.header() } }))
    expect(new URL(refused.headers.get('location')!).searchParams.get('error')).toBe('access_denied')
  })

  test('the callback state is bound to the browser that consented', async () => {
    const s = setup({ clients: { org: { unverified: 'allow' } } })
    const c = await client(s.oauth)
    const jar = new Jar()
    const { challenge } = await pkce()
    const html = await jar.take(await s.oauth.fetch(new Request(authorizeUrl(c.clientId, challenge)))).text()
    const handle = unescape(/name="handle" value="([^"]+)"/.exec(html)![1]!)
    const signIn = new URL(jar.take(await s.oauth.fetch(new Request(`${ISSUER}/authorize`, form({ handle, decision: 'approve' }, jar.header())))).headers.get('location')!)
    const code = await s.codes.issue(people.rina!.principal, { state: signIn.searchParams.get('state')! })
    const other = await s.oauth.fetch(new Request(`${ISSUER}/oauth/callback?state=${signIn.searchParams.get('state')}&code=${code}`))
    expect(other.status).toBe(400)
    expect(other.headers.get('location')).toBeNull()
  })

  // Review finding 2: a code was tied only to the person, so a leaked one finished anyone's flow.
  test("a victim's leaked sign-in code cannot finish the attacker's own flow", async () => {
    const EVIL = 'https://evil.example/cb'
    const s = setup({ clients: { org: { unverified: 'allow' } } })
    const victimClient = await client(s.oauth)
    const attackerClient = await s.oauth.api().createClient({ redirectUris: [EVIL], clientName: 'Attacker', tokenEndpointAuthMethod: 'none' })
    const toSignIn = async (clientId: string, redirect: string) => {
      const jar = new Jar()
      const { challenge } = await pkce()
      const page = jar.take(await s.oauth.fetch(new Request(authorizeUrl(clientId, challenge, { redirect_uri: redirect }))))
      const handle = unescape(/name="handle" value="([^"]+)"/.exec(await page.text())![1]!)
      const approve = jar.take(await s.oauth.fetch(new Request(`${ISSUER}/authorize`, form({ handle, decision: 'approve' }, jar.header()))))
      return { jar, signIn: new URL(approve.headers.get('location')!) }
    }
    // The victim signs in; the product issues her a code for her flow's state. It leaks.
    const victim = await toSignIn(victimClient.clientId, REDIRECT)
    const victimCode = await s.codes.issue(people.rina!.principal, { state: victim.signIn.searchParams.get('state')! })
    // The attacker returns to the callback with his own state and cookie, and her code.
    const attacker = await toSignIn(attackerClient.clientId, EVIL)
    const cb = new URL(attacker.signIn.searchParams.get('return_to')!)
    cb.searchParams.set('state', attacker.signIn.searchParams.get('state')!)
    cb.searchParams.set('code', victimCode)
    const back = await s.oauth.fetch(new Request(cb, { headers: { cookie: attacker.jar.header() } }))
    const to = new URL(back.headers.get('location')!)
    expect(to.searchParams.get('error')).toBe('access_denied')
    expect(to.searchParams.get('code')).toBeNull()
    expect(s.events.some((e) => e.type === 'sign_in_failed' && e.reason === 'refused')).toBe(true)
    expect((await s.oauth.connectedApps('rina')).apps).toHaveLength(0)
    // The attempt spent the code: it does not work in the victim's own flow either.
    expect(await s.codes.redeem(victimCode, victim.signIn.searchParams.get('state')!)).toBeNull()
  })

  test('a sign-in code needs a state to be issued and the same state to be redeemed', async () => {
    const s = setup()
    await expect(s.codes.issue(people.rina!.principal, { state: '' })).rejects.toThrow('state')
    await expect(s.codes.issue(people.rina!.principal, undefined as never)).rejects.toThrow('state')
    const code = await s.codes.issue(people.rina!.principal, { state: 'flow-a' })
    expect(await s.codes.redeem(code, 'flow-b')).toBeNull()
    expect(await s.codes.redeem(code, 'flow-a')).toBeNull()
    const ok = await s.codes.issue(people.rina!.principal, { state: 'flow-a' })
    expect(await s.codes.redeem(ok, 'flow-a')).toEqual(people.rina!.principal)
    expect(s.kv.dump().some((k) => k.includes('flow-a'))).toBe(false)
  })

  test('a person with no seat at the door is refused', async () => {
    const s = setup()
    const c = await client(s.oauth)
    knowAt(c.clientId)
    const a = await authorize(s, c.clientId, { door: 'platform', person: 'rina' })
    expect(a.to.searchParams.get('error')).toBe('access_denied')
    expect(s.events.some((e) => e.type === 'sign_in_failed' && e.reason === 'no_seat')).toBe(true)
  })
})

describe('oauth: tokens', () => {
  test('access lasts one hour; the token names the door it was issued for', async () => {
    const s = setup({ clients: { org: { unverified: 'allow' } } })
    const t = await connected(s)
    expect(t.body.expires_in).toBe(3600)
    expect(t.body.resource).toBe(DOORS.org)
    expect(t.refresh).toBeTruthy()
    const g = await s.oauth.resolveSeat('org', t.access, req())
    expect(g?.seat).toEqual(people.rina!.seats.org!)
    expect(g?.principal.id).toBe('rina')
  })

  test('door binding: a token for one door is refused at the other', async () => {
    const s = setup()
    const org = await connected(s, 'org', 'imran')
    const plat = await connected(s, 'platform', 'imran')
    expect(await s.oauth.resolveSeat('platform', org.access, req())).toBeNull()
    expect(await s.oauth.resolveSeat('org', plat.access, req())).toBeNull()
    expect(await s.oauth.resolveSeat('platform', plat.access, req())).not.toBeNull()
    const door = M.mcpServer<AppCtx, Door>({ registry: reg, guard: guardFor(), door: 'org', ...s.oauth.door('org'), info: { name: 'notes', version: '1' } })
    const res = await door.fetch(req(plat.access))
    expect(res.status).toBe(401)
    expect(res.headers.get('www-authenticate')).toContain('invalid_token')
  })

  test('a refresh may not move the grant to another door', async () => {
    const s = setup({ clients: { org: { unverified: 'allow' } } })
    const t = await connected(s)
    const res = await s.oauth.fetch(new Request(`${ISSUER}/oauth/token`, form({ grant_type: 'refresh_token', refresh_token: t.refresh, client_id: t.clientId, resource: DOORS.platform })))
    expect(res.status).toBe(400)
    expect(((await res.json()) as any).error).toBe('invalid_target')
  })

  test('a refresh token is bound to its client', async () => {
    const s = setup({ clients: { org: { unverified: 'allow' } } })
    const t = await connected(s)
    const other = await client(s.oauth)
    const r = await refresh(s, other.clientId, t.refresh)
    expect(r.res.status).toBe(400)
    expect(r.body.error).toBe('invalid_grant')
  })

  test('refresh rotates on every use', async () => {
    const s = setup({ clients: { org: { unverified: 'allow' } } })
    const t = await connected(s)
    const r1 = await refresh(s, t.clientId, t.refresh)
    expect(r1.res.status).toBe(200)
    expect(r1.body.refresh_token).not.toBe(t.refresh)
    const r2 = await refresh(s, t.clientId, r1.body.refresh_token)
    expect(r2.res.status).toBe(200)
    expect(await s.oauth.resolveSeat('org', r2.body.access_token, req())).not.toBeNull()
  })

  test('reuse of a rotated refresh token revokes the whole family', async () => {
    const s = setup({ clients: { org: { unverified: 'allow' } } })
    const t = await connected(s)
    const r1 = await refresh(s, t.clientId, t.refresh)
    expect(r1.res.status).toBe(200)
    // The first token comes back: the library alone would still accept it once.
    const replay = await refresh(s, t.clientId, t.refresh)
    expect(replay.res.status).toBe(400)
    expect(replay.body.error).toBe('invalid_grant')
    expect(s.events.some((e) => e.type === 'refresh_reuse' && e.userId === 'rina')).toBe(true)
    // Every token of the family is dead: the new refresh token and both access tokens.
    expect((await refresh(s, t.clientId, r1.body.refresh_token)).res.status).toBe(400)
    expect(await s.oauth.resolveSeat('org', r1.body.access_token, req())).toBeNull()
    expect(await s.oauth.resolveSeat('org', t.access, req())).toBeNull()
    expect((await s.oauth.connectedApps('rina')).apps).toHaveLength(0)
  })

  // Review finding 1: the kit read the body only for a lower-case media type, the library for any case.
  test('a rotated refresh token replayed with a mixed-case Content-Type is still caught', async () => {
    const s = setup({ clients: { org: { unverified: 'allow' } } })
    const t = await connected(s)
    const r1 = await refresh(s, t.clientId, t.refresh)
    expect(r1.res.status).toBe(200)
    for (const type of ['Application/x-www-form-urlencoded', ' APPLICATION/X-WWW-FORM-URLENCODED ; charset=UTF-8']) {
      const replay = await s.oauth.fetch(
        new Request(`${ISSUER}/oauth/token`, {
          method: 'POST',
          headers: { 'content-type': type },
          body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token: t.refresh, client_id: t.clientId }).toString(),
        }),
      )
      expect(replay.status).toBe(400)
      expect(((await replay.json()) as any).error).toBe('invalid_grant')
    }
    expect(s.events.filter((e) => e.type === 'refresh_reuse')).toHaveLength(1)
    expect((await refresh(s, t.clientId, r1.body.refresh_token)).res.status).toBe(400)
    expect(await s.oauth.resolveSeat('org', r1.body.access_token, req())).toBeNull()
  })

  test('the token endpoint refuses repeated parameters and bodies the kit cannot read', async () => {
    const s = setup({ clients: { org: { unverified: 'allow' } } })
    const t = await connected(s)
    const r1 = await refresh(s, t.clientId, t.refresh)
    const post = (body: string, type = 'application/x-www-form-urlencoded') => s.oauth.fetch(new Request(`${ISSUER}/oauth/token`, { method: 'POST', headers: { 'content-type': type }, body }))
    // The retired token second: a parser that took the last value would hand it to the library unchecked.
    const twice = `grant_type=refresh_token&refresh_token=${encodeURIComponent(r1.body.refresh_token)}&refresh_token=${encodeURIComponent(t.refresh)}&client_id=${encodeURIComponent(t.clientId)}`
    const rep = await post(twice)
    expect(rep.status).toBe(400)
    expect(((await rep.json()) as any).error_description).toContain('repeated')
    const json = await post(JSON.stringify({ grant_type: 'refresh_token', refresh_token: t.refresh, client_id: t.clientId }), 'application/json')
    expect(json.status).toBe(400)
    const none = await s.oauth.fetch(new Request(`${ISSUER}/oauth/token`, { method: 'POST', body: `grant_type=refresh_token&refresh_token=${encodeURIComponent(t.refresh)}` }))
    expect(none.status).toBe(400)
    // Nothing was refreshed: the current token still works once.
    expect((await refresh(s, t.clientId, r1.body.refresh_token)).res.status).toBe(200)
  })

  // Re-review H1: workerd's formData() drops a stray %, so the kit read "R1%" while the library read R1.
  // The exploit itself needs workerd (oauth.workerd.test.ts); here the refusal is checked.
  test('a body with a malformed percent escape is refused before the reuse check or the library reads it', async () => {
    const s = setup({ clients: { org: { unverified: 'allow' } } })
    const t = await connected(s)
    const r1 = await refresh(s, t.clientId, t.refresh)
    expect(r1.res.status).toBe(200)
    const post = (body: string) => s.oauth.fetch(new Request(`${ISSUER}/oauth/token`, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body }))
    const rt = encodeURIComponent(t.refresh)
    const cid = encodeURIComponent(t.clientId)
    for (const body of [
      `grant_type=refresh_token&refresh_token=${rt}%&client_id=${cid}`,
      `grant_type=refresh_token%&refresh_token=${rt}&client_id=${cid}`,
      `grant_type=refresh_token&refresh_token=${rt}%2&client_id=${cid}`,
      `grant_type=refresh_token&refresh_token=${rt}&client_id=${cid}&x=%zz`,
    ]) {
      const r = await post(body)
      expect(r.status).toBe(400)
      expect(((await r.json()) as any).error_description).toContain('malformed percent escape')
    }
    // A well-formed escape is fine, and the real client keeps its grant.
    expect((await post(`grant_type=refresh_token&refresh_token=${encodeURIComponent(r1.body.refresh_token)}&client_id=${cid}&x=%41`)).status).toBe(200)
  })

  test('an access token expires after its hour', async () => {
    const s = setup({ clients: { org: { unverified: 'allow' } } })
    const t = await connected(s)
    setSystemTime(new Date(Date.now() + 3601_000))
    expect(await s.oauth.resolveSeat('org', t.access, req())).toBeNull()
  })

  test('lifetimes cannot be raised past 1 hour and 30 days', async () => {
    const s = setup({ clients: { org: { unverified: 'allow' } }, ttl: { accessSeconds: 86_400, refreshSeconds: 365 * 86_400 } })
    const t = await connected(s)
    expect(t.body.expires_in).toBe(3600)
    const apps = await s.oauth.connectedApps('rina')
    expect(apps.apps[0]!.expiresAt! - Date.now()).toBeLessThanOrEqual(30 * 86_400_000 + 5000)
  })
})

// Review finding 5: two refreshes at once with one token both passed, and nothing was revoked.
describe('oauth: refresh lock per grant', () => {
  async function race(s: ReturnType<typeof setup>) {
    const t = await connected(s)
    const [a, b] = await Promise.all([refresh(s, t.clientId, t.refresh), refresh(s, t.clientId, t.refresh)])
    const statuses = [a.res.status, b.res.status].sort()
    expect(statuses).toEqual([200, 503])
    const won = a.res.status === 200 ? a : b
    const lost = a.res.status === 200 ? b : a
    expect(lost.body.error).toBe('temporarily_unavailable')
    expect(lost.res.headers.get('retry-after')).toBeTruthy()
    expect(s.events.some((e) => e.type === 'refresh_contended')).toBe(true)
    // The loser's token comes back later: it is retired, and the grant goes.
    const again = await refresh(s, t.clientId, t.refresh)
    expect(again.res.status).toBe(400)
    expect(s.events.some((e) => e.type === 'refresh_reuse')).toBe(true)
    expect(await s.oauth.resolveSeat('org', won.body.access_token, req())).toBeNull()
    expect((await refresh(s, t.clientId, won.body.refresh_token)).res.status).toBe(400)
  }

  test('KV default: two refreshes at once in one isolate, one passes', async () => {
    await race(setup())
  })

  test('D1: two refreshes at once, one passes; the lock expires and is held by one holder', async () => {
    const { Database } = await import('bun:sqlite')
    const db = d1(new Database(':memory:'))
    await O.applyOAuthD1Migrations(db)
    await O.applyOAuthD1Migrations(db)
    const store = O.d1RefreshStore(db)
    await race(setup({ refresh: { store } }))
    const h = await store.lock('g1', 1000)
    expect(h).toBeTruthy()
    expect(await store.lock('g1', 1000)).toBeNull()
    await store.unlock('g1', 'someone-else')
    expect(await store.lock('g1', 1000)).toBeNull()
    await store.unlock('g1', h!)
    const h2 = await store.lock('g1', 1000)
    expect(h2).toBeTruthy()
    setSystemTime(new Date(Date.now() + 2000))
    expect(await store.lock('g1', 1000)).toBeTruthy()
    expect(await store.prune(Date.now() + 10_000)).toBeGreaterThan(0)
  })

  test('Durable Object: two refreshes at once, one passes; marks are kept per grant', async () => {
    const ns = fakeNamespace()
    const store = O.durableObjectRefreshStore(ns)
    await race(setup({ refresh: { store } }))
    const owner = { userId: 'rina', grantId: 'g2' }
    const hash = 'a'.repeat(64)
    await store.retire('g2', hash, owner, 60)
    expect(await store.retired('g2', hash)).toEqual(owner)
    expect(await store.retired('g3', hash)).toBeNull()
    setSystemTime(new Date(Date.now() + 61_000))
    expect(await store.retired('g2', hash)).toBeNull()
    await ns.alarmAll()
    // The exchanged code keeps its mark for the code's ten minutes.
    expect(ns.size()).toBe(2)
    setSystemTime(new Date(Date.now() + 600_000))
    await ns.alarmAll()
    // The race's reused token keeps its mark for the refresh lifetime, and the revoked grant its tombstone.
    expect(ns.size()).toBe(1)
    expect(ns.tombstones()).toBe(1)
    setSystemTime(new Date(Date.now() + 31 * 86_400_000 + 3_600_000))
    await ns.alarmAll()
    expect(ns.size()).toBe(0)
    expect(ns.tombstones()).toBe(0)
  })

  test('a platform door refuses the KV default unless the race is accepted', () => {
    expect(() => setup({ refresh: {} })).toThrow('consistent refresh store')
    expect(() => setup({ refresh: { acceptKvRace: true } })).not.toThrow()
    expect(() => setup({ refresh: {}, doors: { org: DOORS.org } as never, platformDoors: [] })).not.toThrow()
    expect(() => setup({ refresh: { store: O.durableObjectRefreshStore(fakeNamespace()) } })).not.toThrow()
  })
})

/** D1's API over bun:sqlite, enough for the refresh store. */
function d1(db: any): any {
  const stmt = (sql: string, params: unknown[] = []): any => ({
    bind: (...v: unknown[]) => stmt(sql, v),
    first: async () => db.query(sql).get(...params) ?? null,
    all: async () => ({ success: true, results: db.query(sql).all(...params) }),
    run: async () => ({ success: true, meta: { changes: db.query(sql).run(...params).changes } }),
  })
  return { prepare: (sql: string) => stmt(sql), batch: async () => [] }
}

/** A Durable Object namespace in memory: one OAuthRefreshLock per name, one request at a time per object, as the runtime runs them. */
function fakeNamespace() {
  const objects = new Map<string, { obj: InstanceType<OAuthMod['OAuthRefreshLock']>; data: Map<string, unknown>; queue: Promise<unknown> }>()
  const make = (name: string) => {
    const data = new Map<string, unknown>()
    let alarm: number | null = null
    const storage = {
      get: async (k: string) => structuredClone(data.get(k)) as any,
      put: async (k: string, v: unknown) => void data.set(k, structuredClone(v)),
      delete: async (k: string) => data.delete(k),
      list: async (o: { prefix?: string } = {}) => new Map([...data].filter(([k]) => k.startsWith(o.prefix ?? ''))) as any,
      getAlarm: async () => alarm,
      setAlarm: async (t: number) => void (alarm = t),
    }
    const entry = { obj: new O.OAuthRefreshLock({ storage }), data, queue: Promise.resolve() as Promise<unknown> }
    objects.set(name, entry)
    return entry
  }
  return {
    idFromName: (name: string) => name,
    get: (id: unknown) => ({
      fetch: (url: string, init?: RequestInit) => {
        const e = objects.get(id as string) ?? make(id as string)
        const run = e.queue.then(() => e.obj.fetch(new Request(url, init)))
        e.queue = run.catch(() => undefined)
        return run
      },
    }),
    alarmAll: async () => {
      for (const e of objects.values()) await e.obj.alarm()
    },
    size: () => [...objects.values()].reduce((n, e) => n + [...e.data.keys()].filter((k) => k.startsWith('rt:')).length, 0),
    tombstones: () => [...objects.values()].filter((e) => e.data.has('tombstone')).length,
  }
}

describe('oauth: live permissions', () => {
  test('a permission removed takes effect on the next call; a seat removed refuses the token', async () => {
    const s = setup({ clients: { org: { unverified: 'allow' } } })
    const t = await connected(s)
    const door = M.mcpServer<AppCtx, Door>({ registry: reg, guard: guardFor(), door: 'org', ...s.oauth.door('org'), info: { name: 'notes', version: '1' } })
    const call = async () =>
      (await (
        await door.fetch(
          new Request(`${ISSUER}/org`, {
            method: 'POST',
            headers: { authorization: `Bearer ${t.access}`, 'content-type': 'application/json', accept: 'application/json, text/event-stream', 'mcp-protocol-version': '2025-06-18' },
            body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'notes_list', arguments: {} } }),
          }),
        )
      ).json()) as any
    expect((await call()).result.isError).toBe(false)
    people.rina!.perms.delete('notes.read')
    const refused = await call()
    expect(refused.result.isError).toBe(true)
    people.rina!.perms.add('notes.read')
    expect((await call()).result.isError).toBe(false)
    delete people.rina!.seats.org
    const res = await door.fetch(new Request(`${ISSUER}/org`, { method: 'POST', headers: { authorization: `Bearer ${t.access}`, 'content-type': 'application/json' }, body: '{}' }))
    expect(res.status).toBe(401)
  })
})

describe('oauth: connected apps', () => {
  test('lists each grant with client, door, seat and last use, and revokes one', async () => {
    const s = setup({ clients: { org: { unverified: 'allow' } } })
    const t = await connected(s)
    await s.oauth.resolveSeat('org', t.access, req())
    const { apps } = await s.oauth.connectedApps('rina')
    expect(apps).toHaveLength(1)
    expect(apps[0]).toMatchObject({ clientId: t.clientId, clientName: 'Test Client', door: 'org', seatId: 'seat-rina-b1', tenant: 'branch-1', status: 'unverified' })
    expect(apps[0]!.lastUsedAt).toBeGreaterThan(0)
    expect(await s.oauth.revokeApp('imran', apps[0]!.grantId)).toBe(false)
    expect(await s.oauth.revokeApp('rina', apps[0]!.grantId)).toBe(true)
    expect(await s.oauth.resolveSeat('org', t.access, req())).toBeNull()
    expect((await refresh(s, t.clientId, t.refresh)).res.status).toBe(400)
  })

  test('connecting the same client again replaces the grant for that seat only', async () => {
    const s = setup({ clients: { org: { unverified: 'allow' } } })
    const c = await client(s.oauth)
    for (let i = 0; i < 2; i++) {
      const a = await authorize(s, c.clientId)
      expect((await exchange(s, c.clientId, a.to.searchParams.get('code')!, a.verifier)).res.status).toBe(200)
    }
    expect((await s.oauth.connectedApps('rina')).apps).toHaveLength(1)
    people.rina!.seats.org = { id: 'seat-rina-b2', door: 'org', tenant: 'branch-2' }
    const a = await authorize(s, c.clientId)
    expect((await exchange(s, c.clientId, a.to.searchParams.get('code')!, a.verifier)).res.status).toBe(200)
    expect((await s.oauth.connectedApps('rina')).apps.map((x) => x.tenant).sort()).toEqual(['branch-1', 'branch-2'])
  })
})

describe('oauth: keys', () => {
  test('a personal key is shown once, stored hashed, and resolves at its door only', async () => {
    const s = setup()
    const { key, info } = await s.oauth.keys.createPersonal({ principal: people.rina!.principal, seat: people.rina!.seats.org!, name: 'laptop' })
    expect(key.startsWith('notes_mcp_org_')).toBe(true)
    expect(info.maxTier).toBe('R2')
    expect(s.kv.dump().some((k) => k.includes(key))).toBe(false)
    expect(s.kv.dump()).toContain(`omazy-oauth:key:${await sha256Hex(key)}`)
    const g = await s.oauth.resolveSeat('org', key, req())
    expect(g).toMatchObject({ principal: { id: 'rina' }, seat: { id: 'seat-rina-b1' }, maxTier: 'R2' })
    expect(await s.oauth.resolveSeat('platform', key, req())).toBeNull()
    expect(await s.oauth.resolveSeat('org', `${key}x`, req())).toBeNull()
  })

  test('caps: personal at most 90 days and R2, service at most 365 days with a tool list and a tenant', async () => {
    const s = setup()
    const p = { principal: people.rina!.principal, seat: people.rina!.seats.org!, name: 'k' }
    await expect(s.oauth.keys.createPersonal({ ...p, days: 91 })).rejects.toThrow('at most 90 days')
    await expect(s.oauth.keys.createPersonal({ ...p, maxTier: 'R3' })).rejects.toThrow('at most R2')
    expect((await s.oauth.keys.createPersonal({ ...p, maxTier: 'R1' })).info.maxTier).toBe('R1')
    const svc = { owner: people.rina!.principal, tenant: 'branch-1', door: 'org' as const, name: 'zapier', tools: ['notes_list'] }
    await expect(s.oauth.keys.createService({ ...svc, days: 366 })).rejects.toThrow('at most 365 days')
    await expect(s.oauth.keys.createService({ ...svc, tools: [] })).rejects.toThrow('allow list')
    await expect(s.oauth.keys.createService({ ...svc, tenant: '' })).rejects.toThrow('one tenant')
    const capped = setup({ keys: { personal: { prefix: (d) => `notes_mcp_${d}_`, maxDays: 400, maxTier: 'R4' } } })
    await expect(capped.oauth.keys.createPersonal({ ...p, days: 91 })).rejects.toThrow('at most 90 days')
    await expect(capped.oauth.keys.createPersonal({ ...p, maxTier: 'R3' })).rejects.toThrow('at most R2')
  })

  test('a service key is a service principal in one tenant, limited to its tools', async () => {
    const s = setup()
    const { key, info } = await s.oauth.keys.createService({ owner: people.rina!.principal, tenant: 'branch-1', door: 'org', name: 'zapier', tools: ['notes_list'] })
    expect(key.startsWith('notes_svc_org_')).toBe(true)
    const g = (await s.oauth.resolveSeat('org', key, req())) as SeatGrant
    expect(g.principal).toEqual({ kind: 'service', id: info.id, name: 'zapier' })
    expect(g.seat).toEqual({ id: info.id, door: 'org', tenant: 'branch-1' })
    expect(g.tools).toEqual(['notes_list'])
    expect((await s.oauth.keys.listService('branch-1')).map((k) => k.id)).toEqual([info.id])
  })

  // Review finding 7: no tier cap by default, any door, and a misspelt cap that capped nothing.
  test('a service key is capped at R2 by default and refused at a platform door unless listed', async () => {
    const s = setup()
    const svc = { owner: people.rina!.principal, tenant: 'branch-1', name: 'x', tools: ['notes_list'] }
    await expect(s.oauth.keys.createService({ ...svc, door: 'platform' })).rejects.toThrow('platform door')
    const k = await s.oauth.keys.createService({ ...svc, door: 'org' })
    expect(k.info.maxTier).toBe('R2')
    expect(((await s.oauth.resolveSeat('org', k.key, req())) as SeatGrant).maxTier).toBe('R2')
    await expect(s.oauth.keys.createService({ ...svc, door: 'org', maxTier: 'R3' })).rejects.toThrow('at most R2')
    const listed = setup({ keys: { service: { prefix: (d) => `notes_svc_${d}_`, platformDoors: ['platform'], maxTier: 'R3' } } })
    const p = await listed.oauth.keys.createService({ ...svc, door: 'platform' })
    expect(p.info.maxTier).toBe('R3')
    expect(() => setup({ platformDoors: [], keys: { service: { prefix: (d) => `notes_svc_${d}_`, platformDoors: ['platform'] } } })).toThrow('not a platform door')
  })

  test('a misspelt tier in the key options throws at start', () => {
    expect(() => setup({ keys: { service: { prefix: (d) => `notes_svc_${d}_`, maxTier: 'r1' as never } } })).toThrow('not a tier')
    expect(() => setup({ keys: { personal: { prefix: (d) => `notes_mcp_${d}_`, maxTier: 'R9' as never } } })).toThrow('not a tier')
  })

  test('keys expire', async () => {
    const s = setup()
    const { key } = await s.oauth.keys.createPersonal({ principal: people.rina!.principal, seat: people.rina!.seats.org!, name: 'k', days: 1 })
    expect(await s.oauth.resolveSeat('org', key, req())).not.toBeNull()
    setSystemTime(new Date(Date.now() + 86_400_000 + 1000))
    expect(await s.oauth.resolveSeat('org', key, req())).toBeNull()
  })

  test('a person losing the role loses their grants and keys; a moved service key stays', async () => {
    const s = setup({ clients: { org: { unverified: 'allow' } } })
    const t = await connected(s)
    const pk = await s.oauth.keys.createPersonal({ principal: people.rina!.principal, seat: people.rina!.seats.org!, name: 'k' })
    const sk = await s.oauth.keys.createService({ owner: people.rina!.principal, tenant: 'branch-1', door: 'org', name: 'a', tools: ['notes_list'] })
    const kept = await s.oauth.keys.createService({ owner: people.rina!.principal, tenant: 'branch-1', door: 'org', name: 'b', tools: ['notes_list'] })
    expect(await s.oauth.keys.transferService('rina', kept.info.id, people.imran!.principal)).toBe(true)
    const out = await s.oauth.personLostRole('rina', { tenant: 'branch-1' })
    expect(out).toEqual({ grants: 1, keys: 2 })
    expect(await s.oauth.resolveSeat('org', t.access, req())).toBeNull()
    expect(await s.oauth.resolveSeat('org', pk.key, req())).toBeNull()
    expect(await s.oauth.resolveSeat('org', sk.key, req())).toBeNull()
    expect(await s.oauth.resolveSeat('org', kept.key, req())).not.toBeNull()
    expect((await s.oauth.connectedApps('imran')).keys.map((k) => k.id)).toEqual([kept.info.id])
  })

  test('a person can list and revoke their own keys only', async () => {
    const s = setup()
    const pk = await s.oauth.keys.createPersonal({ principal: people.rina!.principal, seat: people.rina!.seats.org!, name: 'laptop' })
    const listed = (await s.oauth.connectedApps('rina')).keys
    expect(listed.map((k) => k.name)).toEqual(['laptop'])
    expect(JSON.stringify(listed)).not.toContain(pk.key)
    expect(await s.oauth.keys.revoke('imran', pk.info.id)).toBe(false)
    expect(await s.oauth.keys.revoke('rina', pk.info.id)).toBe(true)
    expect(await s.oauth.resolveSeat('org', pk.key, req())).toBeNull()
  })

  test('overlapping prefixes are refused at start', () => {
    expect(() => setup({ keys: { personal: { prefix: () => 'notes_' }, service: { prefix: (d) => `notes_${d}_` } } })).toThrow('overlap')
  })
})

describe('oauth: hardening from the review', () => {
  test('every door needs checkSeat, a tenant door too (round 6)', () => {
    expect(() => setup({ checkSeat: undefined as never })).toThrow('checkSeat is required')
    expect(() => setup({ checkSeat: undefined as never, doors: { org: DOORS.org } as never, platformDoors: [] })).toThrow('checkSeat is required')
  })

  test('the last-use memory of an isolate is bounded', async () => {
    const keys = new O.Keys<Door>(O.memoryKv(), ['org', 'platform'], {})
    for (let i = 0; i < 10_050; i++) await keys.touch(`k${i}`)
    expect((keys as any).seen.size).toBe(10_000)
    expect((keys as any).seen.has('k0')).toBe(false)
    expect((keys as any).seen.has('k10049')).toBe(true)
  })

  test('a person id that starts like a key is refused at sign-in', async () => {
    const s = setup()
    people.mallory = { principal: { kind: 'member', id: 'notes_mcp_org_mallory' }, seats: { org: { id: 'seat-m', door: 'org', tenant: 'branch-1' } }, perms: new Set(['notes.read']) }
    const c = await client(s.oauth)
    const a = await authorize(s, c.clientId, { person: 'mallory' })
    expect(a.to.searchParams.get('error')).toBe('access_denied')
    expect(s.events.some((e) => e.type === 'sign_in_failed' && e.reason === 'bad_person')).toBe(true)
    // A token with a colon is never read as a key, whatever it starts with.
    expect(await s.oauth.resolveSeat('org', 'notes_mcp_org_x:abcdefghijklmnop:secret', req())).toBeNull()
  })

  test('GET /authorize is counted per address through the product\'s rate limiter', async () => {
    const counts = new Map<string, number>()
    const binding = { limit: async ({ key }: { key: string }) => ({ success: (counts.set(key, (counts.get(key) ?? 0) + 1).get(key) ?? 0) <= 2 }) }
    const s = setup({ rateLimit: { authorize: binding } })
    const c = await client(s.oauth)
    const { challenge } = await pkce()
    const open = (ip: string) => s.oauth.fetch(new Request(authorizeUrl(c.clientId, challenge), { headers: { 'cf-connecting-ip': ip } }))
    expect((await open('203.0.113.1')).status).toBe(200)
    expect((await open('203.0.113.1')).status).toBe(200)
    const before = s.kv.size()
    const third = await open('203.0.113.1')
    expect(third.status).toBe(429)
    expect(third.headers.get('retry-after')).toBe('60')
    expect(s.kv.size()).toBe(before)
    expect(s.events.some((e) => e.type === 'authorize_limited')).toBe(true)
    expect((await open('203.0.113.2')).status).toBe(200)
    expect([...counts.keys()]).toEqual(['authorize:203.0.113.1', 'authorize:203.0.113.2'])
  })
})

describe('oauth: configuration', () => {
  test('doors must be https and canonical', () => {
    expect(() => setup({ doors: { org: 'http://mcp.example.com/org' } as never })).toThrow('https')
    expect(() => setup({ doors: { org: 'https://MCP.example.com/org' } as never })).toThrow('canonical')
  })
})

function guardFor() {
  return createGuard<AppCtx, Perm>({
    registry: reg,
    can: (ctx, permission) => people[ctx.principal.id]?.perms.has(permission) ?? false,
    secret: 'test-secret-0123456789-0123456789-0123456789',
    store: memoryGuardStore(),
    policies: {},
    switches: memorySwitches(),
    rateLimit: memoryRateLimiter(),
    log: memoryRequestLog(),
  })
}

// Proofs from the re-review, ported. Each runs the reviewer's exploit and passes when it fails.
describe('oauth: re-review', () => {
  // M1 (B1): the platform door had no client policy, so any verified metadata client, named "Claude"
  // on a domain the attacker owns, got to consent and a super admin token.
  test('M1: a platform door needs a known list and blocks a look-alike metadata client', async () => {
    const id = 'https://client.example/claude.json'
    const restore = cimd({ [id]: doc(id, REDIRECT, 'Claude') })
    try {
      // No policy at the platform door: refused at start.
      expect(() => O.authorizationServer<Door>({ ...baseOptions(setup()), clients: { org: { unverified: 'block' } } })).toThrow('needs clients.platform.known')
      expect(() => setup({ clients: { platform: { known: [] } } })).toThrow('needs clients.platform.known')
      // With a known list, the look-alike is blocked on the kit's own page, never consented.
      const s = setup({ clients: { org: { unverified: 'block' } } })
      const { challenge } = await pkce()
      const res = await s.oauth.fetch(new Request(authorizeUrl(id, challenge, { resource: DOORS.platform })))
      expect(res.status).toBe(403)
      expect(await res.text()).not.toContain('verified by its metadata document')
      expect(s.events.some((e) => e.type === 'client_blocked' && e.door === 'platform' && e.status === 'verified')).toBe(true)
      // Opening the platform door to unlisted clients needs the loud flag.
      expect(() => setup({ registration: { enabled: true }, clients: { platform: { known: [id], unverified: 'allow', others: 'allow' } } })).toThrow('dangerouslyAllowUnlistedClients')
      expect(() => setup({ clients: { platform: { known: [id], others: 'allow' } } })).toThrow('dangerouslyAllowUnlistedClients')
      expect(() => setup({ clients: { platform: { others: 'allow', dangerouslyAllowUnlistedClients: true } } })).not.toThrow()
    } finally {
      restore()
    }
  })

  // L1 (B2): the strict rules followed the door's name. A door called "admin" with tenantless seats got
  // no checkSeat, the KV refresh race, a domain list and R4 service keys, with no warning.
  test('L1: platformDoors must be named; a tenantless seat is refused at any other door; service keys stop at R3', async () => {
    resetPeople()
    const kv = O.memoryKv()
    const codes = O.signInCodes(kv)
    const doors = { admin: `${ISSUER}/admin`, org: `${ISSUER}/org` }
    const adminSeat: Seat = { id: 'seat-imran-admin', door: 'admin' as never, tenant: null }
    const events: any[] = []
    const opts = (extra: Record<string, unknown>) =>
      ({
        issuer: ISSUER,
        kv,
        doors,
        productName: 'Notes',
        signIn: { url: 'https://app.example.com/mcp-sign-in', authenticate: (c: string, st: string) => codes.redeem(c, st) },
        chooseSeat: (_p: Principal, door: string) => (door === 'admin' ? adminSeat : null),
        checkSeat: () => true,
        clients: { admin: { knownDomains: ['claude.example'], unverified: 'allow' } },
        keys: { personal: { prefix: (d: string) => `notes_mcp_${d}_` }, service: { prefix: (d: string) => `notes_svc_${d}_`, maxTier: 'R4' } },
        onEvent: (e: unknown) => events.push(e),
        ...extra,
      }) as never
    // The door's name decides nothing: platformDoors must be given.
    expect(() => O.authorizationServer<'admin' | 'org'>(opts({}))).toThrow('platformDoors')
    // Named as a platform door, every strict rule applies, starting with the client policy and the R4 cap.
    expect(() => O.authorizationServer<'admin' | 'org'>(opts({ platformDoors: ['admin'] }))).toThrow('platform door')
    // R4 service keys need the opt-in.
    expect(() => O.authorizationServer<'admin' | 'org'>(opts({ platformDoors: [] }))).toThrow('allowR4')
    const keysR3 = { personal: { prefix: (d: string) => `notes_mcp_${d}_` }, service: { prefix: (d: string) => `notes_svc_${d}_`, maxTier: 'R3' } }
    expect(() => O.authorizationServer<'admin' | 'org'>(opts({ platformDoors: [], keys: { ...keysR3, service: { ...keysR3.service, maxTier: 'R4', allowR4: true } } }))).not.toThrow()
    // Not named a platform door: a tenantless seat is refused at sign-in and in a key.
    const oauth = O.authorizationServer<'admin' | 'org'>(opts({ platformDoors: [], keys: keysR3 }))
    await expect(oauth.keys.createPersonal({ principal: people.imran!.principal, seat: adminSeat, name: 'x' })).rejects.toThrow('needs a tenant')
    const c = await oauth.api().createClient({ redirectUris: [REDIRECT], clientName: 'C', tokenEndpointAuthMethod: 'none' })
    const jar = new Jar()
    const { challenge } = await pkce()
    const page = jar.take(await oauth.fetch(new Request(authorizeUrl(c.clientId, challenge, { resource: doors.admin }))))
    expect(page.status).toBe(200)
    const handle = unescape(/name="handle" value="([^"]+)"/.exec(await page.text())![1]!)
    const approve = jar.take(await oauth.fetch(new Request(`${ISSUER}/authorize`, form({ handle, decision: 'approve' }, jar.header()))))
    const signIn = new URL(approve.headers.get('location')!)
    const cb = new URL(oauth.callbackUrl)
    cb.searchParams.set('state', signIn.searchParams.get('state')!)
    cb.searchParams.set('code', await codes.issue(people.imran!.principal, { state: signIn.searchParams.get('state')! }))
    const back = await oauth.fetch(new Request(cb, { headers: { cookie: jar.header() } }))
    const to = new URL(back.headers.get('location')!)
    expect(to.searchParams.get('error')).toBe('access_denied')
    expect(to.searchParams.get('code')).toBeNull()
    expect(events.some((e) => e.type === 'sign_in_failed' && e.reason === 'tenantless_seat')).toBe(true)
  })

  // L2 (B4): the kit took the per-grant lock (a D1 or Durable Object write) before any check.
  test('L2: a made-up refresh token writes nothing to D1', async () => {
    const { Database } = await import('bun:sqlite')
    const raw = d1(new Database(':memory:'))
    await O.applyOAuthD1Migrations(raw)
    let writes = 0
    const counted = {
      prepare: (sql: string) => {
        const wrap = (st: any): any => ({
          bind: (...v: unknown[]) => wrap(st.bind(...v)),
          first: () => st.first(),
          all: () => st.all(),
          run: () => {
            if (/^\s*(INSERT|DELETE|UPDATE)/i.test(sql)) writes++
            return st.run()
          },
        })
        return wrap(raw.prepare(sql))
      },
      batch: raw.batch,
    }
    const s = setup({ refresh: { store: O.d1RefreshStore(counted as any) } })
    for (let i = 0; i < 50; i++) {
      const r = await s.oauth.fetch(new Request(`${ISSUER}/oauth/token`, form({ grant_type: 'refresh_token', refresh_token: `u${i}:g${i}:junk`, client_id: 'nobody' })))
      expect(r.status).toBe(401)
    }
    expect(writes).toBe(0)
  })

  test('L2: a made-up refresh token opens no Durable Object', async () => {
    const ns = fakeNamespace()
    let created = 0
    const counting = { idFromName: ns.idFromName, get: (id: unknown) => ((created += 1), ns.get(id)) }
    const s = setup({ refresh: { store: O.durableObjectRefreshStore(counting) } })
    for (let i = 0; i < 20; i++) await s.oauth.fetch(new Request(`${ISSUER}/oauth/token`, form({ grant_type: 'refresh_token', refresh_token: `u:${crypto.randomUUID()}:x`, client_id: 'nobody' })))
    expect(created).toBe(0)
  })

  test("L2: someone who knows a grant's id cannot hold its lock; the real client refreshes", async () => {
    const slow = 'https://attacker.example/slow.json'
    let release: (() => void) | null = null
    const restore = cimdHook(async (url) => {
      if (url === slow) {
        await new Promise<void>((r) => (release = r))
        return new Response('no', { status: 500 })
      }
      return undefined
    })
    try {
      const { Database } = await import('bun:sqlite')
      const db = d1(new Database(':memory:'))
      await O.applyOAuthD1Migrations(db)
      const s = setup({ refresh: { store: O.d1RefreshStore(db) } })
      const t = await connected(s)
      const [user, grant] = t.access.split(':')
      const hold = s.oauth.fetch(new Request(`${ISSUER}/oauth/token`, form({ grant_type: 'refresh_token', refresh_token: `${user}:${grant}:anything`, client_id: slow })))
      while (!release) await new Promise((r) => setTimeout(r, 1))
      const real = await refresh(s, t.clientId, t.refresh)
      expect(real.res.status).toBe(200)
      ;(release as unknown as () => void)()
      expect((await hold).status).toBe(401)
    } finally {
      restore()
    }
  })

  test('L2: the token endpoint is counted per address through the product\'s rate limiter', async () => {
    const counts = new Map<string, number>()
    const binding = { limit: async ({ key }: { key: string }) => ({ success: (counts.set(key, (counts.get(key) ?? 0) + 1).get(key) ?? 0) <= 2 }) }
    const s = setup({ rateLimit: { token: binding } })
    const post = (ip: string) =>
      s.oauth.fetch(new Request(`${ISSUER}/oauth/token`, { ...form({ grant_type: 'refresh_token', refresh_token: 'u:g:x', client_id: 'c' }), headers: { 'content-type': 'application/x-www-form-urlencoded', 'cf-connecting-ip': ip } }))
    expect((await post('203.0.113.1')).status).toBe(401)
    expect((await post('203.0.113.1')).status).toBe(401)
    const third = await post('203.0.113.1')
    expect(third.status).toBe(429)
    expect(third.headers.get('retry-after')).toBe('60')
    expect((await post('203.0.113.2')).status).toBe(401)
    expect(s.events.some((e) => e.type === 'token_limited' && e.ip === '203.0.113.1')).toBe(true)
  })

  // L3 (B3): the lock lapsed while the library waited on the client's metadata document, and the
  // token was marked only after the library answered, so a replay of the same token in between
  // passed too. The lock is 30 s now; a lock that lapses anyway still leaves the mark.
  test('L3: a replay while a slow refresh is still in the library revokes the grant', async () => {
    const id = 'https://client.example/oauth/client.json'
    let gate: (() => void) | null = null
    let entered = false
    let stall = false
    const restore = cimdHook(async (url) => {
      if (url !== id) return undefined
      if (gate === null && stall) {
        entered = true
        await new Promise<void>((r) => (gate = r))
      }
      return new Response(JSON.stringify({ ...doc(id, REDIRECT, 'C'), grant_types: ['authorization_code', 'refresh_token'] }), { headers: { 'content-type': 'application/json' } })
    })
    try {
      const { Database } = await import('bun:sqlite')
      const db = d1(new Database(':memory:'))
      await O.applyOAuthD1Migrations(db)
      const s = setup({ refresh: { store: O.d1RefreshStore(db) } })
      const a = await authorize(s, id)
      const t = await exchange(s, id, a.to.searchParams.get('code')!, a.verifier)
      expect(t.res.status).toBe(200)
      stall = true
      const first = refresh(s, id, t.body.refresh_token)
      while (!entered) await new Promise((r) => setTimeout(r, 1))
      stall = false
      setSystemTime(new Date(Date.now() + 31_000))
      const second = await refresh(s, id, t.body.refresh_token)
      expect(second.res.status).toBe(400)
      expect(second.body.error).toBe('invalid_grant')
      expect(s.events.some((e) => e.type === 'refresh_reuse')).toBe(true)
      ;(gate as unknown as () => void)()
      const one = await first
      expect(one.res.status).not.toBe(200)
      expect(await s.oauth.resolveSeat('org', t.body.access_token, req())).toBeNull()
    } finally {
      restore()
    }
  })

  test('L3: a refresh the library refuses leaves no mark, so the token still works', async () => {
    const s = setup()
    const t = await connected(s)
    // The right token with the wrong client: the library refuses it (4xx) without rotating.
    const wrong = await s.oauth.fetch(new Request(`${ISSUER}/oauth/token`, form({ grant_type: 'refresh_token', refresh_token: t.refresh, client_id: 'someone-else' })))
    expect(wrong.status).toBeGreaterThanOrEqual(400)
    expect(wrong.status).toBeLessThan(500)
    expect((await refresh(s, t.clientId, t.refresh)).res.status).toBe(200)
    expect(s.events.some((e) => e.type === 'refresh_reuse')).toBe(false)
  })

  // L4 (B5): the attacker pushes his own state through the victim's sign-in. Her browser lands on the
  // callback without his cookie and fails, but the code was left unspent, in her history and in logs.
  test('L4: a code that reaches a failing callback is spent, so it cannot finish the attacker\'s flow', async () => {
    const s = setup()
    const attackerClient = await s.oauth.api().createClient({ redirectUris: [EVIL], clientName: 'Attacker', tokenEndpointAuthMethod: 'none' })
    const jar = new Jar()
    const { challenge } = await pkce()
    const page = jar.take(
      await s.oauth.fetch(new Request(authorizeUrl(attackerClient.clientId, challenge, { redirect_uri: EVIL, state: 'x' }))),
    )
    const handle = unescape(/name="handle" value="([^"]+)"/.exec(await page.text())![1]!)
    const approve = jar.take(await s.oauth.fetch(new Request(`${ISSUER}/authorize`, form({ handle, decision: 'approve' }, jar.header()))))
    const attackerState = new URL(approve.headers.get('location')!).searchParams.get('state')!
    const victimCode = await s.codes.issue(people.rina!.principal, { state: attackerState })
    const cb = new URL(s.oauth.callbackUrl)
    cb.searchParams.set('state', attackerState)
    cb.searchParams.set('code', victimCode)
    expect((await s.oauth.fetch(new Request(cb))).status).toBe(400)
    // The attacker replays the URL from her history with his cookie: the code is gone.
    const back = await s.oauth.fetch(new Request(cb, { headers: { cookie: jar.header() } }))
    const to = new URL(back.headers.get('location')!)
    expect(to.searchParams.get('error')).toBe('access_denied')
    expect(to.searchParams.get('code')).toBeNull()
  })

  test('L4: the sign-in page may return the code by form POST', async () => {
    const s = setup()
    const c = await client(s.oauth)
    const jar = new Jar()
    const { verifier, challenge } = await pkce()
    const page = jar.take(await s.oauth.fetch(new Request(authorizeUrl(c.clientId, challenge))))
    const handle = unescape(/name="handle" value="([^"]+)"/.exec(await page.text())![1]!)
    const approve = jar.take(await s.oauth.fetch(new Request(`${ISSUER}/authorize`, form({ handle, decision: 'approve' }, jar.header()))))
    const state = new URL(approve.headers.get('location')!).searchParams.get('state')!
    const code = await s.codes.issue(people.rina!.principal, { state })
    const back = await s.oauth.fetch(new Request(s.oauth.callbackUrl, form({ state, code }, jar.header())))
    expect(back.status).toBe(302)
    const to = new URL(back.headers.get('location')!)
    const t = await exchange(s, c.clientId, to.searchParams.get('code')!, verifier)
    expect(t.res.status).toBe(200)
    expect((await s.oauth.fetch(new Request(s.oauth.callbackUrl, { method: 'PUT' }))).status).toBe(405)
  })

  // I1 (B6): the kit's check sent no User-Agent; the library sends its own. A server that redirects
  // only the library's requests passed the check, and the library used the document it was sent to.
  test("I1: a metadata URL that redirects only the library's User-Agent is refused", async () => {
    const id = 'https://claude.example/oauth/client.json'
    const legit = doc(id, 'https://claude.example/api/callback', 'Claude')
    const viaRedirect = { client_id: id, client_name: 'Claude (look-alike)', redirect_uris: ['http://127.0.0.1:9999/cb'], token_endpoint_auth_method: 'none' }
    const restore = cimdHook((url, init) => {
      if (url !== id) return undefined
      if (!new Headers(init.headers).get('user-agent')) return new Response(JSON.stringify(legit), { headers: { 'content-type': 'application/json' } })
      // To the library: a redirect, which it follows (redirect: 'manual' sees the 302 itself).
      if (init.redirect === 'manual') return new Response(null, { status: 302, headers: { location: 'https://evil.example/doc.json' } })
      return new Response(JSON.stringify(viaRedirect), { headers: { 'content-type': 'application/json' } })
    })
    try {
      const s = setup({ clients: { org: { knownDomains: ['claude.example'] } } })
      const { challenge } = await pkce()
      const res = await s.oauth.fetch(new Request(authorizeUrl(id, challenge, { redirect_uri: 'http://127.0.0.1:9999/cb' })))
      expect(res.status).toBe(400)
      expect(await res.text()).not.toContain('look-alike')
      expect(s.events.some((e) => e.type === 'client_metadata_refused' && e.reason === 'redirect')).toBe(true)
    } finally {
      restore()
    }
  })

  test('I1: a server that gives the library one document and the kit another is refused', async () => {
    const id = 'https://claude.example/oauth/client.json'
    const legit = doc(id, 'https://claude.example/api/callback', 'Claude')
    const other = { client_id: id, client_name: 'Claude (look-alike)', redirect_uris: ['http://127.0.0.1:9999/cb'], token_endpoint_auth_method: 'none' }
    let n = 0
    const restore = cimdHook((url) => {
      if (url !== id) return undefined
      // The first request (the library's) gets the look-alike, every later one the real document.
      return new Response(JSON.stringify(n++ === 0 ? other : legit), { headers: { 'content-type': 'application/json' } })
    })
    try {
      const s = setup({ clients: { org: { knownDomains: ['claude.example'] } } })
      const { challenge } = await pkce()
      const res = await s.oauth.fetch(new Request(authorizeUrl(id, challenge, { redirect_uri: 'http://127.0.0.1:9999/cb' })))
      expect(res.status).toBe(400)
      expect(s.events.some((e) => e.type === 'client_metadata_refused' && e.reason === 'mismatch')).toBe(true)
    } finally {
      restore()
    }
  })

  // I2 (B7): every request without cf-connecting-ip shared the bucket authorize:unknown, so one caller
  // behind a proxy or a service binding exhausted the limit for all of them.
  test('I2: a request without an address is refused where addresses are counted, never pooled', async () => {
    const counts = new Map<string, number>()
    const binding = { limit: async ({ key }: { key: string }) => ({ success: (counts.set(key, (counts.get(key) ?? 0) + 1).get(key) ?? 0) <= 2 }) }
    const s = setup({ rateLimit: { authorize: binding, token: binding }, registration: { enabled: true } })
    const c = await client(s.oauth)
    const { challenge } = await pkce()
    for (let i = 0; i < 3; i++) expect((await s.oauth.fetch(new Request(authorizeUrl(c.clientId, challenge)))).status).toBe(400)
    expect((await s.oauth.fetch(new Request(`${ISSUER}/oauth/token`, form({ grant_type: 'refresh_token', refresh_token: 'u:g:x', client_id: 'c' })))).status).toBe(400)
    const reg = await s.oauth.fetch(new Request(`${ISSUER}/oauth/register`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ redirect_uris: [REDIRECT], client_name: 'x', token_endpoint_auth_method: 'none' }) }))
    expect(reg.status).toBe(400)
    expect([...counts.keys()]).toEqual([])
    expect(s.events.filter((e) => e.type === 'request_refused' && e.reason === 'no_address')).toHaveLength(5)
    // With an address, each caller has its own bucket.
    const open = (ip: string) => s.oauth.fetch(new Request(authorizeUrl(c.clientId, challenge), { headers: { 'cf-connecting-ip': ip } }))
    expect((await open('203.0.113.5')).status).toBe(200)
    expect((await open('203.0.113.6')).status).toBe(200)
    // Without any limit or Turnstile configured, no address is needed.
    const plain = setup()
    const pc = await client(plain.oauth)
    expect((await plain.oauth.fetch(new Request(authorizeUrl(pc.clientId, challenge)))).status).toBe(200)
  })

  test('I2: a product behind its own front names the header that carries the address', async () => {
    const counts = new Map<string, number>()
    const binding = { limit: async ({ key }: { key: string }) => ({ success: (counts.set(key, (counts.get(key) ?? 0) + 1).get(key) ?? 0) <= 2 }) }
    const s = setup({ rateLimit: { authorize: binding }, clientIpHeader: 'x-real-ip', trustClientIpHeader: true })
    const c = await client(s.oauth)
    const { challenge } = await pkce()
    expect((await s.oauth.fetch(new Request(authorizeUrl(c.clientId, challenge), { headers: { 'cf-connecting-ip': '203.0.113.9' } }))).status).toBe(400)
    expect((await s.oauth.fetch(new Request(authorizeUrl(c.clientId, challenge), { headers: { 'x-real-ip': '10.0.0.7' } }))).status).toBe(200)
    expect([...counts.keys()]).toEqual(['authorize:10.0.0.7'])
    expect(() => setup({ clientIpHeader: 'x real ip' })).toThrow('clientIpHeader')
  })
})

/** Serves metadata documents through a handler, to stall or vary answers. */
function cimdHook(handler: (url: string, init: any) => Promise<Response | undefined> | Response | undefined) {
  const g = globalThis as any
  const realFetch = g.fetch
  g.Cloudflare = { compatibilityFlags: { global_fetch_strictly_public: true } }
  g.fetch = async (input: any, init?: any) => {
    const url = typeof input === 'string' ? input : input.url
    return (await handler(url, init ?? {})) ?? new Response('gone', { status: 404 })
  }
  return () => {
    g.fetch = realFetch
    delete g.Cloudflare
  }
}

// ---------------------------------------------------------------- final review (round 3)

/**
 * Cloudflare KV as documented: `list()` is eventually consistent, so a key
 * written in the last minute or so may be missing from a listing. Gets and
 * puts here are exact; only the listing lags, by `lagMs` from a key's first write.
 */
function laggingList(inner: ReturnType<typeof O.memoryKv>, lagMs = 60_000): ReturnType<typeof O.memoryKv> {
  const born = new Map<string, number>()
  return {
    ...inner,
    async put(k: string, v: string, o?: any) {
      if (!born.has(k)) born.set(k, Date.now())
      await inner.put(k, v, o)
    },
    async delete(k: string) {
      born.delete(k)
      await inner.delete(k)
    },
    async list(o?: any) {
      const r = await inner.list(o)
      return { ...r, keys: r.keys.filter((k) => Date.now() - (born.get(k.name) ?? 0) >= lagMs) }
    },
  }
}

/**
 * Cloudflare KV as two locations see it: one central store, and per location
 * a read cache that keeps what it read for 60 s (KV's default cacheTtl). A
 * location sees its own writes at once; another location sees them once its
 * cached copy expires. Concurrent writes: last write wins (a delete is a write).
 * The namespace's `list()` lags about 60 s in every location (`laggingList`).
 */
function kvLocations() {
  const central = laggingList(O.memoryKv())
  const view = () => {
    const cache = new Map<string, { raw: string | null; at: number }>()
    const raw = async (key: string): Promise<string | null> => {
      const c = cache.get(key)
      if (c && Date.now() - c.at < 60_000) return c.raw
      const v = (await central.get(key)) as string | null
      cache.set(key, { raw: v, at: Date.now() })
      return v
    }
    return {
      async get(key: string, options?: unknown) {
        const v = await raw(key)
        if (v === null) return null
        const type = typeof options === 'string' ? options : (options as { type?: string } | undefined)?.type
        return type === 'json' ? JSON.parse(v) : v
      },
      async put(key: string, value: string, options?: any) {
        await central.put(key, value, options)
        cache.set(key, { raw: value, at: Date.now() })
      },
      async delete(key: string) {
        await central.delete(key)
        cache.set(key, { raw: null, at: Date.now() })
      },
      list: (o?: any) => central.list(o),
    }
  }
  return { central, x: view(), y: view() }
}

async function d1Store() {
  const { Database } = await import('bun:sqlite')
  const db = d1(new Database(':memory:'))
  await O.applyOAuthD1Migrations(db)
  return O.d1RefreshStore(db)
}

/** Every KV record of one grant (the grant and its tokens), to write back as a stale location would. */
async function grantRecords(kv: ReturnType<typeof O.memoryKv>, userId: string, grantId: string) {
  const out: [string, string][] = []
  for (const k of (await kv.list({ prefix: `grant:${userId}:${grantId}` })).keys) out.push([k.name, (await kv.get(k.name)) as string])
  for (const k of (await kv.list({ prefix: `token:${userId}:${grantId}:` })).keys) out.push([k.name, (await kv.get(k.name)) as string])
  return async () => {
    for (const [k, v] of out) await kv.put(k, v)
  }
}

const grantOf = (token: string) => token.split(':')[1]!

describe('oauth: final review N1, a revoked grant stays revoked across locations', () => {
  const yServer = (s: ReturnType<typeof setup>, kv: ReturnType<typeof kvLocations>['y'], store: any) =>
    O.authorizationServer<Door>({ ...baseOptions(s), kv, refresh: { store }, clients: { platform: { known: PLATFORM_KNOWN }, org: { unverified: 'allow' } } })
  const refreshAt = async (srv: { fetch: (r: Request) => Promise<Response> }, clientId: string, token: string) => {
    const res = await srv.fetch(new Request(`${ISSUER}/oauth/token`, form({ grant_type: 'refresh_token', refresh_token: token, client_id: clientId })))
    return { res, body: (await res.json()) as any }
  }

  for (const kind of ['d1', 'durable object'] as const) {
    test(`${kind}: a thief caught by reuse detection cannot refresh in a location with a stale grant`, async () => {
      const kv = kvLocations()
      const store = kind === 'd1' ? await d1Store() : O.durableObjectRefreshStore(fakeNamespace())
      const s = setup({ kv: kv.x, refresh: { store } })
      const y = yServer(s, kv.y, store)
      const t = await connected(s)
      // The thief refreshes a copy of R1 first, in Y: R1 -> T2.
      const stolen = await refreshAt(y, t.clientId, t.refresh)
      expect(stolen.res.status).toBe(200)
      // The real client presents R1 in X: reuse, the grant is revoked.
      expect((await refresh(s, t.clientId, t.refresh)).res.status).toBe(400)
      expect(s.events.some((e) => e.type === 'refresh_reuse')).toBe(true)
      // Five seconds later the thief refreshes T2 in Y, which still has the grant cached.
      setSystemTime(new Date(Date.now() + 5_000))
      const back = await refreshAt(y, t.clientId, stolen.body.refresh_token)
      expect(back.res.status).toBe(400)
      expect(back.body.error).toBe('invalid_grant')
      // The access token Y minted from R1 stops resolving in Y too, though Y still has its record cached.
      expect(await y.resolveSeat('org', stolen.body.access_token, req())).toBeNull()
      // Two minutes on, every cache has expired: the grant is gone everywhere.
      setSystemTime(new Date(Date.now() + 120_000))
      expect(await kv.central.get(`grant:rina:${grantOf(t.refresh)}`)).toBeNull()
      expect((await s.oauth.connectedApps('rina')).apps).toHaveLength(0)
      // R1's mark lives out its TTL: it is still a reuse.
      expect((await refresh(s, t.clientId, t.refresh)).res.status).toBe(400)
    })
  }

  test('an app the person disconnected stays disconnected after a refresh in another location', async () => {
    const kv = kvLocations()
    const store = await d1Store()
    const s = setup({ kv: kv.x, refresh: { store } })
    const y = yServer(s, kv.y, store)
    const t = await connected(s)
    const r = await refreshAt(y, t.clientId, t.refresh)
    expect(r.res.status).toBe(200)
    const grantId = (await s.oauth.connectedApps('rina')).apps[0]!.grantId
    expect(await s.oauth.revokeApp('rina', grantId)).toBe(true)
    setSystemTime(new Date(Date.now() + 10_000))
    const again = await refreshAt(y, t.clientId, r.body.refresh_token)
    expect(again.res.status).toBe(400)
    expect(again.body.error).toBe('invalid_grant')
    expect(await y.resolveSeat('org', r.body.access_token, req())).toBeNull()
    setSystemTime(new Date(Date.now() + 120_000))
    expect((await s.oauth.connectedApps('rina')).apps).toHaveLength(0)
  })

  test('a grant and token written back after personLostRole are revoked again on their next use, and not listed', async () => {
    const store = await d1Store()
    const s = setup({ refresh: { store } })
    const t = await connected(s)
    const r = await refresh(s, t.clientId, t.refresh)
    expect(r.res.status).toBe(200)
    const restore = await grantRecords(s.kv, 'rina', grantOf(t.refresh))
    expect((await s.oauth.personLostRole('rina')).grants).toBe(1)
    // A refresh in another location read the grant before the revocation and wrote it back after.
    await restore()
    expect(await s.oauth.resolveSeat('org', r.body.access_token, req())).toBeNull()
    expect(await s.kv.get(`grant:rina:${grantOf(t.refresh)}`)).toBeNull()
    await restore()
    expect((await s.oauth.connectedApps('rina')).apps).toHaveLength(0)
    await restore()
    const again = await refresh(s, t.clientId, r.body.refresh_token)
    expect(again.res.status).toBe(400)
    expect(again.body.error).toBe('invalid_grant')
    expect(await s.kv.get(`grant:rina:${grantOf(t.refresh)}`)).toBeNull()
  })

  test('an authorization code for a revoked grant is refused though the grant came back', async () => {
    const store = await d1Store()
    const s = setup({ refresh: { store } })
    const c = await client(s.oauth)
    const a = await authorize(s, c.clientId)
    const code = a.to.searchParams.get('code')!
    const restore = await grantRecords(s.kv, 'rina', grantOf(code))
    expect((await s.oauth.personLostRole('rina')).grants).toBe(1)
    await restore()
    const x = await exchange(s, c.clientId, code, a.verifier)
    expect(x.res.status).toBe(400)
    expect(x.body.error).toBe('invalid_grant')
    expect(await s.kv.get(`grant:rina:${grantOf(code)}`)).toBeNull()
  })

  test('the stores keep a tombstone for its TTL', async () => {
    const owner = { userId: 'rina', grantId: 'g9' }
    const ns = fakeNamespace()
    for (const store of [await d1Store(), O.durableObjectRefreshStore(ns), O.kvRefreshStore(O.memoryKv())]) {
      expect(await store.tombstoned('g9')).toBeNull()
      await store.tombstone('g9', owner, 120)
      expect(await store.tombstoned('g9')).toEqual(owner)
      expect(await store.tombstoned('g8')).toBeNull()
    }
    setSystemTime(new Date(Date.now() + 121_000))
    expect(await O.durableObjectRefreshStore(ns).tombstoned('g9')).toBeNull()
    await ns.alarmAll()
    expect(ns.tombstones()).toBe(0)
  })
})

describe('oauth: final review N2, per-address limits', () => {
  const limiter = (max: number) => {
    const counts = new Map<string, number>()
    return { counts, binding: { limit: async ({ key }: { key: string }) => ({ success: (counts.set(key, (counts.get(key) ?? 0) + 1).get(key) ?? 0) <= max }) } }
  }

  test('one IPv6 /64 is one bucket for authorize and token', async () => {
    const a = limiter(2)
    const t = limiter(2)
    const s = setup({ rateLimit: { authorize: a.binding, token: t.binding } })
    const c = await client(s.oauth)
    const { challenge } = await pkce()
    const statuses: number[] = []
    const tokenStatuses: number[] = []
    for (let i = 1; i <= 10; i++) {
      const ip = `2001:db8:1:2::${i.toString(16)}`
      statuses.push((await s.oauth.fetch(new Request(authorizeUrl(c.clientId, challenge), { headers: { 'cf-connecting-ip': ip } }))).status)
      const tok = await s.oauth.fetch(
        new Request(`${ISSUER}/oauth/token`, { ...form({ grant_type: 'refresh_token', refresh_token: 'u:g:x', client_id: c.clientId }), headers: { 'content-type': 'application/x-www-form-urlencoded', 'cf-connecting-ip': ip } }),
      )
      tokenStatuses.push(tok.status)
    }
    expect(statuses.filter((x) => x === 429)).toHaveLength(8)
    expect(tokenStatuses.filter((x) => x === 429)).toHaveLength(8)
    expect([...a.counts.keys()]).toEqual(['authorize:2001:db8:1:2::/64'])
    expect([...t.counts.keys()]).toEqual(['token:2001:db8:1:2::/64'])
    // Another /64 is another bucket; written out in full or compressed, an address lands in the same one.
    expect((await s.oauth.fetch(new Request(authorizeUrl(c.clientId, challenge), { headers: { 'cf-connecting-ip': '2001:0DB8:0001:0003:0:0:0:1' } }))).status).toBe(200)
    expect(a.counts.has('authorize:2001:db8:1:3::/64')).toBe(true)
    // An IPv4-mapped address counts as the IPv4 address.
    await s.oauth.fetch(new Request(authorizeUrl(c.clientId, challenge), { headers: { 'cf-connecting-ip': '::ffff:203.0.113.4' } }))
    expect(a.counts.has('authorize:203.0.113.4')).toBe(true)
  })

  test('Turnstile appears for the same /64', async () => {
    const s = setup({ turnstile: { siteKey: 'k', verify: () => false, after: 1 } })
    const c = await client(s.oauth)
    const { challenge } = await pkce()
    const pages: string[] = []
    for (let i = 1; i <= 3; i++) pages.push(await (await s.oauth.fetch(new Request(authorizeUrl(c.clientId, challenge), { headers: { 'cf-connecting-ip': `2001:db8:1:2::${i}` } }))).text())
    expect(pages[0]).not.toContain('cf-turnstile')
    expect(pages[2]).toContain('cf-turnstile')
  })

  test('an address header value that is not an IP address is no address', async () => {
    const a = limiter(2)
    const s = setup({ rateLimit: { authorize: a.binding } })
    const c = await client(s.oauth)
    const { challenge } = await pkce()
    for (const v of ['anything-1', '203.0.113.1, 198.51.100.2', '1.2.3', '256.1.1.1', '2001:db8::1%eth0', '[2001:db8::1]', '0x7f.0.0.1']) {
      expect((await s.oauth.fetch(new Request(authorizeUrl(c.clientId, challenge), { headers: { 'cf-connecting-ip': v } }))).status).toBe(400)
    }
    expect(a.counts.size).toBe(0)
  })

  test('a header a caller can set is refused unless the product opts in, and its value must still be an address', async () => {
    for (const h of ['x-forwarded-for', 'X-Real-IP', 'forwarded', 'true-client-ip', 'x-client-ip']) expect(() => setup({ clientIpHeader: h })).toThrow('clientIpHeader')
    const a = limiter(2)
    const s = setup({ rateLimit: { authorize: a.binding }, clientIpHeader: 'x-forwarded-for', trustClientIpHeader: true })
    const c = await client(s.oauth)
    const { challenge } = await pkce()
    for (let i = 0; i < 5; i++) {
      expect((await s.oauth.fetch(new Request(authorizeUrl(c.clientId, challenge), { headers: { 'x-forwarded-for': `anything-${i}` } }))).status).toBe(400)
    }
    expect((await s.oauth.fetch(new Request(authorizeUrl(c.clientId, challenge), { headers: { 'x-forwarded-for': '203.0.113.7' } }))).status).toBe(200)
    expect([...a.counts.keys()]).toEqual(['authorize:203.0.113.7'])
  })
})

describe('oauth: final review N3, client policy holds after consent', () => {
  test('a client the door blocks later loses its refresh and access tokens', async () => {
    const s = setup({ clients: { org: { unverified: 'allow' } } })
    const t = await connected(s)
    const blocked = O.authorizationServer<Door>({ ...baseOptions(s), clients: { platform: { known: PLATFORM_KNOWN }, org: { unverified: 'block' } } })
    const { challenge } = await pkce()
    expect((await blocked.fetch(new Request(authorizeUrl(t.clientId, challenge)))).status).toBe(403)
    expect(await blocked.resolveSeat('org', t.access, req())).toBeNull()
    const r = await blocked.fetch(new Request(`${ISSUER}/oauth/token`, form({ grant_type: 'refresh_token', refresh_token: t.refresh, client_id: t.clientId })))
    expect(r.status).toBe(400)
    expect(((await r.json()) as any).error).toBe('invalid_grant')
    expect(s.events.some((e) => e.type === 'client_blocked' && e.clientId === t.clientId)).toBe(true)
    // The grant is not revoked: allowed again, the same tokens work.
    expect((await refresh(s, t.clientId, t.refresh)).res.status).toBe(200)
  })

  test('a client removed from a platform door known list stops at once', async () => {
    const s = setup()
    const t = await connected(s, 'platform', 'imran')
    expect(await s.oauth.resolveSeat('platform', t.access, req())).not.toBeNull()
    const removed = O.authorizationServer<Door>({ ...baseOptions(s), clients: { platform: { known: ['https://claude.example/oauth/client.json'] }, org: { unverified: 'allow' } } })
    expect(await removed.resolveSeat('platform', t.access, req())).toBeNull()
    const r = await removed.fetch(new Request(`${ISSUER}/oauth/token`, form({ grant_type: 'refresh_token', refresh_token: t.refresh, client_id: t.clientId })))
    expect(r.status).toBe(400)
  })

  test('an authorization code is refused when the client was blocked after consent', async () => {
    const s = setup({ clients: { org: { unverified: 'allow' } } })
    const c = await client(s.oauth)
    const a = await authorize(s, c.clientId)
    const blocked = O.authorizationServer<Door>({ ...baseOptions(s), clients: { platform: { known: PLATFORM_KNOWN }, org: { unverified: 'block' } } })
    const res = await blocked.fetch(
      new Request(`${ISSUER}/oauth/token`, form({ grant_type: 'authorization_code', code: a.to.searchParams.get('code')!, redirect_uri: REDIRECT, client_id: c.clientId, code_verifier: a.verifier, resource: DOORS.org })),
    )
    expect(res.status).toBe(400)
  })

  test('a metadata document client: verified stops when the door blocks others, known stops when taken off the list', async () => {
    const ID = 'https://stranger.example/client.json'
    const CB = 'https://app.stranger.example/cb'
    const restore = cimd({ [ID]: doc(ID, CB) })
    try {
      const connect = async (s: ReturnType<typeof setup>) => {
        const jar = new Jar()
        const { verifier, challenge } = await pkce()
        const page = jar.take(await s.oauth.fetch(new Request(authorizeUrl(ID, challenge, { redirect_uri: CB }))))
        expect(page.status).toBe(200)
        const handle = unescape(/name="handle" value="([^"]+)"/.exec(await page.text())![1]!)
        const approve = jar.take(await s.oauth.fetch(new Request(`${ISSUER}/authorize`, form({ handle, decision: 'approve' }, jar.header()))))
        const state = new URL(approve.headers.get('location')!).searchParams.get('state')!
        const cb = new URL(s.oauth.callbackUrl)
        cb.searchParams.set('state', state)
        cb.searchParams.set('code', await s.codes.issue(people.rina!.principal, { state }))
        const back = await s.oauth.fetch(new Request(cb, { headers: { cookie: jar.header() } }))
        const code = new URL(back.headers.get('location')!).searchParams.get('code')!
        const res = await s.oauth.fetch(new Request(`${ISSUER}/oauth/token`, form({ grant_type: 'authorization_code', code, redirect_uri: CB, client_id: ID, code_verifier: verifier, resource: DOORS.org })))
        expect(res.status).toBe(200)
        return (await res.json()) as any
      }
      const at = (s: ReturnType<typeof setup>, org: any) => O.authorizationServer<Door>({ ...baseOptions(s), clients: { platform: { known: PLATFORM_KNOWN }, org } })
      const refreshAt = async (srv: ReturnType<typeof at>, token: string) =>
        (await srv.fetch(new Request(`${ISSUER}/oauth/token`, form({ grant_type: 'refresh_token', refresh_token: token, client_id: ID })))).status

      // Verified at consent.
      const v = setup({ clients: { org: {} } })
      const tv = await connect(v)
      expect((await v.oauth.connectedApps('rina')).apps[0]!.status).toBe('verified')
      expect(await at(v, { others: 'block' }).resolveSeat('org', tv.access_token, req())).toBeNull()
      expect(await refreshAt(at(v, { others: 'block' }), tv.refresh_token)).toBe(400)
      expect(await at(v, { known: [ID], others: 'block' }).resolveSeat('org', tv.access_token, req())).not.toBeNull()

      // Known at consent, by its exact id.
      const k = setup({ clients: { org: { known: [ID], others: 'block' } } })
      const tk = await connect(k)
      expect((await k.oauth.connectedApps('rina')).apps[0]!.status).toBe('known')
      // Off the list, it is what its document makes it: verified. Allowed where others are, refused where they are not.
      expect(await at(k, {}).resolveSeat('org', tk.access_token, req())).not.toBeNull()
      expect(await at(k, { others: 'block' }).resolveSeat('org', tk.access_token, req())).toBeNull()
      expect(await refreshAt(at(k, { others: 'block' }), tk.refresh_token)).toBe(400)
      expect(await refreshAt(at(k, { known: [ID], others: 'block' }), tk.refresh_token)).toBe(200)
    } finally {
      restore()
    }
  })
})

// ---------------------------------------------------------------- review of the N1 to N3 fixes

const refreshVia = async (srv: { fetch: (r: Request) => Promise<Response> }, clientId: string, token: string) => {
  const res = await srv.fetch(new Request(`${ISSUER}/oauth/token`, form({ grant_type: 'refresh_token', refresh_token: token, client_id: clientId })))
  return { res, body: (await res.json()) as any }
}
const revokeVia = (srv: { fetch: (r: Request) => Promise<Response> }, data: Record<string, string>, headers: Record<string, string> = {}) =>
  srv.fetch(new Request(`${ISSUER}/oauth/token`, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded', ...headers }, body: new URLSearchParams(data).toString() }))

describe('oauth: N-fix review P1, a client revoking its own token (RFC 7009) tombstones the grant', () => {
  const yServer = (s: ReturnType<typeof setup>, kv: ReturnType<typeof kvLocations>['y'], store: any) =>
    O.authorizationServer<Door>({ ...baseOptions(s), kv, refresh: { store }, clients: { platform: { known: PLATFORM_KNOWN }, org: { unverified: 'allow' } } })

  test('a stale location cannot bring back a grant the client revoked at the token endpoint', async () => {
    const kv = kvLocations()
    const store = await d1Store()
    const s = setup({ kv: kv.x, refresh: { store } })
    const y = yServer(s, kv.y, store)
    const t = await connected(s)
    const grantId = grantOf(t.refresh)
    // A thief warms Y's cache: a wrong secret is enough to make Y read the grant.
    expect((await refreshVia(y, t.clientId, `rina:${grantId}:wrong`)).res.status).toBe(400)
    // The client revokes R1 at X, as RFC 7009 has it: a token and no grant type.
    const rev = await revokeVia(s.oauth, { token: t.refresh, token_type_hint: 'refresh_token', client_id: t.clientId })
    expect(rev.status).toBe(200)
    expect(await kv.central.get(`grant:rina:${grantId}`)).toBeNull()
    expect(await store.tombstoned(grantId)).toEqual({ userId: 'rina', grantId })
    // Ten seconds on, the thief's copy of R1 in Y, whose cache still holds the grant: refused.
    setSystemTime(new Date(Date.now() + 10_000))
    const back = await refreshVia(y, t.clientId, t.refresh)
    expect(back.res.status).toBe(400)
    expect(back.body.error).toBe('invalid_grant')
    // Every cache has expired: the grant is gone everywhere.
    setSystemTime(new Date(Date.now() + 120_000))
    expect(await kv.central.get(`grant:rina:${grantId}`)).toBeNull()
    expect(await s.oauth.resolveSeat('org', t.access, req())).toBeNull()
    expect((await s.oauth.connectedApps('rina')).apps).toHaveLength(0)
  })

  test('without a hint, and for the previous refresh token, the grant is tombstoned too', async () => {
    const store = await d1Store()
    const s = setup({ refresh: { store } })
    const t = await connected(s)
    const r2 = (await refresh(s, t.clientId, t.refresh)).body.refresh_token as string
    // R1 is the previous refresh token now; the library still revokes the grant for it.
    expect((await revokeVia(s.oauth, { token: t.refresh, client_id: t.clientId })).status).toBe(200)
    expect(await store.tombstoned(grantOf(r2))).not.toBeNull()
    expect((await refresh(s, t.clientId, r2)).res.status).toBe(400)
  })

  test('an access token revokes only itself: no tombstone, the grant keeps refreshing', async () => {
    const store = await d1Store()
    const s = setup({ refresh: { store } })
    const t = await connected(s)
    expect((await revokeVia(s.oauth, { token: t.access, client_id: t.clientId })).status).toBe(200)
    expect(await store.tombstoned(grantOf(t.refresh))).toBeNull()
    expect(await s.oauth.resolveSeat('org', t.access, req())).toBeNull()
    expect((await refresh(s, t.clientId, t.refresh)).res.status).toBe(200)
  })

  test('another client naming the token revokes nothing and writes no tombstone', async () => {
    const store = await d1Store()
    const s = setup({ refresh: { store } })
    const t = await connected(s)
    const other = await client(s.oauth, 'Other')
    expect((await revokeVia(s.oauth, { token: t.refresh, client_id: other.clientId })).status).toBe(200)
    expect(await store.tombstoned(grantOf(t.refresh))).toBeNull()
    expect((await refresh(s, t.clientId, t.refresh)).res.status).toBe(200)
  })

  test('a confidential client revoking with Basic credentials tombstones; a wrong secret does not', async () => {
    const store = await d1Store()
    const s = setup({ refresh: { store } })
    const c = await s.oauth.api().createClient({ redirectUris: [REDIRECT], clientName: 'Server App', tokenEndpointAuthMethod: 'client_secret_basic' })
    const a = await authorize(s, c.clientId)
    const basic = (secret: string) => ({ authorization: `Basic ${btoa(`${encodeURIComponent(c.clientId)}:${encodeURIComponent(secret)}`)}` })
    const ex = await s.oauth.fetch(
      new Request(`${ISSUER}/oauth/token`, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded', ...basic(c.clientSecret!) }, body: new URLSearchParams({ grant_type: 'authorization_code', code: a.to.searchParams.get('code')!, redirect_uri: REDIRECT, code_verifier: a.verifier, resource: DOORS.org }).toString() }),
    )
    expect(ex.status).toBe(200)
    const tok = (await ex.json()) as any
    const grantId = grantOf(tok.refresh_token)
    expect((await revokeVia(s.oauth, { token: tok.refresh_token }, basic('wrong'))).status).toBe(401)
    expect(await store.tombstoned(grantId)).toBeNull()
    expect((await revokeVia(s.oauth, { token: tok.refresh_token }, basic(c.clientSecret!))).status).toBe(200)
    expect(await store.tombstoned(grantId)).toEqual({ userId: 'rina', grantId })
  })

  test('fails closed: a tombstone that cannot be written answers 503, and the public client can try again', async () => {
    const inner = await d1Store()
    let broken = true
    const store = { ...inner, tombstone: async (g: string, o: any, ttl: number) => (broken ? Promise.reject(new Error('down')) : inner.tombstone(g, o, ttl)) }
    const s = setup({ refresh: { store } })
    const t = await connected(s)
    const grantId = grantOf(t.refresh)
    const first = await revokeVia(s.oauth, { token: t.refresh, client_id: t.clientId })
    expect(first.status).toBe(503)
    expect(((await first.json()) as any).error).toBe('temporarily_unavailable')
    expect(s.events.some((e) => e.type === 'oauth_error' && e.code === 'revocation_unrecorded')).toBe(true)
    // Nothing was revoked, so the retry finds the grant and finishes the job.
    expect(await s.kv.get(`grant:rina:${grantId}`)).not.toBeNull()
    broken = false
    expect((await revokeVia(s.oauth, { token: t.refresh, client_id: t.clientId })).status).toBe(200)
    expect(await inner.tombstoned(grantId)).not.toBeNull()
    expect(await s.kv.get(`grant:rina:${grantId}`)).toBeNull()
  })

  for (const kind of ['d1', 'durable object'] as const) {
    test(`${kind}: fails closed for a confidential client too: 503 with nothing revoked, the retry tombstones it`, async () => {
      const kv = kvLocations()
      const inner = kind === 'd1' ? await d1Store() : O.durableObjectRefreshStore(fakeNamespace())
      let broken = true
      const store = { ...inner, tombstone: async (g: string, o: any, ttl: number) => (broken ? Promise.reject(new Error('down')) : inner.tombstone(g, o, ttl)) }
      const s = setup({ kv: kv.x, refresh: { store } })
      const y = yServer(s, kv.y, store)
      const c = await s.oauth.api().createClient({ redirectUris: [REDIRECT], clientName: 'Server App', tokenEndpointAuthMethod: 'client_secret_post' })
      const secret = { client_id: c.clientId, client_secret: c.clientSecret! }
      const a = await authorize(s, c.clientId)
      const ex = await s.oauth.fetch(
        new Request(`${ISSUER}/oauth/token`, form({ grant_type: 'authorization_code', code: a.to.searchParams.get('code')!, redirect_uri: REDIRECT, code_verifier: a.verifier, resource: DOORS.org, ...secret })),
      )
      expect(ex.status).toBe(200)
      const tok = (await ex.json()) as any
      const grantId = grantOf(tok.refresh_token)
      const refreshY = (token: string) => y.fetch(new Request(`${ISSUER}/oauth/token`, form({ grant_type: 'refresh_token', refresh_token: token, ...secret })))
      // Y reads the grant into its cache.
      expect((await refreshY(`rina:${grantId}:wrong`)).status).toBe(400)
      // The store is down when the client revokes at X: 503, and the grant is still there for the retry.
      const first = await revokeVia(s.oauth, { token: tok.refresh_token, ...secret })
      expect(first.status).toBe(503)
      expect(s.events.some((e) => e.type === 'oauth_error' && e.code === 'revocation_unrecorded')).toBe(true)
      expect(await kv.central.get(`grant:rina:${grantId}`)).not.toBeNull()
      // A wrong secret writes nothing once the store is back.
      broken = false
      expect((await revokeVia(s.oauth, { token: tok.refresh_token, client_id: c.clientId, client_secret: 'wrong' })).status).toBe(401)
      expect(await inner.tombstoned(grantId)).toBeNull()
      // The retry revokes and tombstones.
      expect((await revokeVia(s.oauth, { token: tok.refresh_token, ...secret })).status).toBe(200)
      expect(await inner.tombstoned(grantId)).toEqual({ userId: 'rina', grantId })
      // Y, whose cache still holds the grant, refuses the refresh token ten seconds on.
      setSystemTime(new Date(Date.now() + 10_000))
      const back = await refreshY(tok.refresh_token)
      expect(back.status).toBe(400)
      setSystemTime(new Date(Date.now() + 120_000))
      expect(await kv.central.get(`grant:rina:${grantId}`)).toBeNull()
      expect((await s.oauth.connectedApps('rina')).apps).toHaveLength(0)
    })
  }
})

/** Connects a metadata document client through the whole browser flow, and returns its tokens. */
async function connectCimd(s: ReturnType<typeof setup>, id: string, cb: string) {
  const jar = new Jar()
  const { verifier, challenge } = await pkce()
  const page = jar.take(await s.oauth.fetch(new Request(authorizeUrl(id, challenge, { redirect_uri: cb }))))
  expect(page.status).toBe(200)
  const handle = unescape(/name="handle" value="([^"]+)"/.exec(await page.text())![1]!)
  const approve = jar.take(await s.oauth.fetch(new Request(`${ISSUER}/authorize`, form({ handle, decision: 'approve' }, jar.header()))))
  const state = new URL(approve.headers.get('location')!).searchParams.get('state')!
  const back = new URL(s.oauth.callbackUrl)
  back.searchParams.set('state', state)
  back.searchParams.set('code', await s.codes.issue(people.rina!.principal, { state }))
  const res = await s.oauth.fetch(new Request(back, { headers: { cookie: jar.header() } }))
  const code = new URL(res.headers.get('location')!).searchParams.get('code')!
  const tok = await s.oauth.fetch(new Request(`${ISSUER}/oauth/token`, form({ grant_type: 'authorization_code', code, redirect_uri: cb, client_id: id, code_verifier: verifier, resource: DOORS.org })))
  expect(tok.status).toBe(200)
  return (await tok.json()) as { access_token: string; refresh_token: string }
}

describe('oauth: N-fix review P2, a client known by id keeps no "known" from a listed host', () => {
  const ID = 'https://stranger.example/client.json'
  const at = (s: ReturnType<typeof setup>, org: any) => O.authorizationServer<Door>({ ...baseOptions(s), clients: { platform: { known: PLATFORM_KNOWN }, org } })

  test('delisted by id while its host stays in knownDomains, a client whose redirect URIs leave the host stops', async () => {
    const CB = 'https://elsewhere.example/cb'
    const restore = cimd({ [ID]: doc(ID, CB) })
    try {
      const s = setup({ clients: { org: { known: [ID], others: 'block' } } })
      const tok = await connectCimd(s, ID, CB)
      const now = at(s, { knownDomains: ['stranger.example'], others: 'block', unverified: 'block' })
      // A fresh consent under this policy is refused, and so is the old grant.
      expect((await now.fetch(new Request(authorizeUrl(ID, (await pkce()).challenge, { redirect_uri: CB })))).status).not.toBe(200)
      expect(await now.resolveSeat('org', tok.access_token, req())).toBeNull()
      expect((await refreshVia(now, ID, tok.refresh_token)).res.status).toBe(400)
      expect(s.events.some((e) => e.type === 'client_blocked' && e.clientId === ID && e.status === 'unverified')).toBe(true)
    } finally {
      restore()
    }
  })

  test('delisted by id, a client whose redirect URIs stay on its listed host is known by the host', async () => {
    const CB = 'https://app.stranger.example/cb'
    const restore = cimd({ [ID]: doc(ID, CB) })
    try {
      const s = setup({ clients: { org: { known: [ID], others: 'block' } } })
      const tok = await connectCimd(s, ID, CB)
      const now = at(s, { knownDomains: ['stranger.example'], others: 'block', unverified: 'block' })
      expect(await now.resolveSeat('org', tok.access_token, req())).not.toBeNull()
      expect((await refreshVia(now, ID, tok.refresh_token)).res.status).toBe(200)
    } finally {
      restore()
    }
  })

  test('known by its host at consent, it stays known while the host is listed, with no lookup', async () => {
    const CB = 'https://app.stranger.example/cb'
    const seen: { url: string; init: any }[] = []
    const restore = cimd({ [ID]: doc(ID, CB) }, { seen })
    try {
      const s = setup({ clients: { org: { knownDomains: ['stranger.example'], others: 'block' } } })
      const tok = await connectCimd(s, ID, CB)
      expect((await s.kv.get(`grant:rina:${grantOf(tok.refresh_token)}`, { type: 'json' }) as any).metadata.knownBy).toBe('domain')
      const now = at(s, { knownDomains: ['stranger.example'], others: 'block' })
      seen.length = 0
      expect(await now.resolveSeat('org', tok.access_token, req())).not.toBeNull()
      expect(seen.filter((x) => x.url === ID)).toHaveLength(0)
      // Its host taken off the list: it is what its document makes it, verified, and others are blocked.
      expect(await at(s, { others: 'block' }).resolveSeat('org', tok.access_token, req())).toBeNull()
    } finally {
      restore()
    }
  })

  test('a grant recorded known with no record of which list is looked up again', async () => {
    const CB = 'https://elsewhere.example/cb'
    const restore = cimd({ [ID]: doc(ID, CB) })
    try {
      const s = setup({ clients: { org: { known: [ID], others: 'block' } } })
      const tok = await connectCimd(s, ID, CB)
      // A grant written before the kit recorded the list.
      const key = `grant:rina:${grantOf(tok.refresh_token)}`
      const g = (await s.kv.get(key, { type: 'json' })) as any
      expect(g.metadata.knownBy).toBe('id')
      delete g.metadata.knownBy
      await s.kv.put(key, JSON.stringify(g))
      const now = at(s, { knownDomains: ['stranger.example'], others: 'block', unverified: 'block' })
      expect(await now.resolveSeat('org', tok.access_token, req())).toBeNull()
    } finally {
      restore()
    }
  })
})

describe('oauth: N-fix review P3, a delisted client is looked up once, not on every call', () => {
  const ID = 'https://stranger.example/client.json'
  const CB = 'https://app.stranger.example/cb'
  const at = (s: ReturnType<typeof setup>, org: any) => O.authorizationServer<Door>({ ...baseOptions(s), clients: { platform: { known: PLATFORM_KNOWN }, org } })

  test('twenty calls of a delisted metadata client fetch its document once per server', async () => {
    const seen: { url: string; init: any }[] = []
    const restore = cimd({ [ID]: doc(ID, CB) }, { seen })
    try {
      const s = setup({ clients: { org: { known: [ID] } } })
      const tok = await connectCimd(s, ID, CB)
      const now = at(s, {})
      seen.length = 0
      const fetches = () => seen.filter((x) => x.url === ID).length
      expect(await now.resolveSeat('org', tok.access_token, req())).not.toBeNull()
      // The first call looks the client up, with the kit's redirect check; the next nineteen use the answer.
      const first = fetches()
      expect(first).toBeGreaterThan(0)
      expect(first).toBeLessThanOrEqual(3)
      expect(seen.some((x) => x.url === ID && x.init?.redirect === 'manual')).toBe(true)
      for (let i = 0; i < 19; i++) expect(await now.resolveSeat('org', tok.access_token, req())).not.toBeNull()
      expect(fetches()).toBe(first)
      // Five minutes on it is read again.
      seen.length = 0
      setSystemTime(new Date(Date.now() + 301_000))
      await now.resolveSeat('org', tok.access_token, req())
      expect(seen.filter((x) => x.url === ID).length).toBeGreaterThan(0)
    } finally {
      restore()
    }
  })

  test('the lookup refuses a document that redirects, as consent does', async () => {
    const redirects = new Set<string>()
    const restore = cimd({ [ID]: doc(ID, CB) }, { redirects })
    try {
      const s = setup({ clients: { org: { known: [ID] } } })
      const tok = await connectCimd(s, ID, CB)
      redirects.add(ID)
      const now = at(s, {})
      expect(await now.resolveSeat('org', tok.access_token, req())).toBeNull()
      expect((await refreshVia(now, ID, tok.refresh_token)).res.status).toBe(400)
      expect(s.events.some((e) => e.type === 'client_metadata_refused' && e.clientId === ID && e.reason === 'redirect')).toBe(true)
    } finally {
      restore()
    }
  })
})

describe('oauth: N-fix review P4, the tombstone read on every call', () => {
  const counting = async () => {
    const inner = await d1Store()
    const c = { calls: 0, inFlight: 0, maxInFlight: 0 }
    const store = {
      ...inner,
      consistent: true,
      tombstoned: async (g: string) => {
        c.calls++
        c.inFlight++
        c.maxInFlight = Math.max(c.maxInFlight, c.inFlight)
        await new Promise((r) => setTimeout(r, 2))
        c.inFlight--
        return inner.tombstoned(g)
      },
    }
    return { store, c }
  }

  test('by default every resolveSeat reads the store: a revocation from anywhere bites on the next call', async () => {
    const { store, c } = await counting()
    const s = setup({ refresh: { store } })
    const t = await connected(s)
    c.calls = 0
    for (let i = 0; i < 50; i++) await s.oauth.resolveSeat('org', t.access, req())
    expect(c.calls).toBe(50)
  })

  test('tombstoneCacheSeconds remembers a grant with no tombstone for that long', async () => {
    const { store, c } = await counting()
    const s = setup({ refresh: { store, tombstoneCacheSeconds: 2 } })
    const t = await connected(s)
    c.calls = 0
    for (let i = 0; i < 50; i++) expect(await s.oauth.resolveSeat('org', t.access, req())).not.toBeNull()
    expect(c.calls).toBe(1)
    // Another server instance (another isolate) revokes: this one sees it once its memory runs out.
    const other = O.authorizationServer<Door>({ ...baseOptions(s), refresh: { store }, clients: { platform: { known: PLATFORM_KNOWN }, org: { unverified: 'allow' } } })
    expect(await other.revokeApp('rina', grantOf(t.refresh))).toBe(true)
    setSystemTime(new Date(Date.now() + 2_001))
    expect(await s.oauth.resolveSeat('org', t.access, req())).toBeNull()
  })

  test('a revocation by the same server instance applies at once, cache or not', async () => {
    const { store } = await counting()
    const s = setup({ refresh: { store, tombstoneCacheSeconds: 5 } })
    const t = await connected(s)
    const grantId = grantOf(t.refresh)
    expect(await s.oauth.resolveSeat('org', t.access, req())).not.toBeNull()
    const restore = await grantRecords(s.kv, 'rina', grantId)
    await s.oauth.revokeApp('rina', grantId)
    // Even with the grant's records written back, as a stale location would.
    await restore()
    expect(await s.oauth.resolveSeat('org', t.access, req())).toBeNull()
  })

  test('tombstoneCacheSeconds takes a whole number from 0 to 5', () => {
    for (const bad of [6, -1, 1.5, Number.NaN]) expect(() => setup({ refresh: { acceptKvRace: true, tombstoneCacheSeconds: bad } })).toThrow(/tombstoneCacheSeconds/)
    expect(() => setup({ refresh: { acceptKvRace: true, tombstoneCacheSeconds: 0 } })).not.toThrow()
  })

  test('connectedApps reads its grants at once, not one after another', async () => {
    const { store, c } = await counting()
    const s = setup({ refresh: { store } })
    for (let i = 0; i < 3; i++) {
      const cl = await client(s.oauth, `App ${i}`)
      const a = await authorize(s, cl.clientId)
      expect((await exchange(s, cl.clientId, a.to.searchParams.get('code')!, a.verifier)).res.status).toBe(200)
    }
    c.maxInFlight = 0
    const list = await s.oauth.connectedApps('rina')
    expect(list.apps).toHaveLength(3)
    expect(c.maxInFlight).toBe(3)
  })
})

describe('oauth: N-fix review P5, an IPv6 /48 and a 6to4 address count as one caller', () => {
  const tokenAt = (s: ReturnType<typeof setup>, ip: string) =>
    s.oauth.fetch(new Request(`${ISSUER}/oauth/token`, { ...form({ grant_type: 'refresh_token', refresh_token: 'u:g:x', client_id: 'c' }), headers: { 'content-type': 'application/x-www-form-urlencoded', 'cf-connecting-ip': ip } }))
  const limiter = (max: number) => {
    const counts = new Map<string, number>()
    return { counts, limit: async ({ key }: { key: string }) => ({ success: (counts.set(key, (counts.get(key) ?? 0) + 1).get(key) ?? 0) <= max }) }
  }

  test('one /48 spread over 200 /64s runs out of its /48 bucket', async () => {
    const narrow = limiter(2)
    const wide = limiter(20)
    const s = setup({ rateLimit: { token: narrow, tokenPer48: wide } })
    let limited = 0
    for (let i = 1; i <= 200; i++) if ((await tokenAt(s, `2001:db8:1:${i.toString(16)}::1`)).status === 429) limited++
    expect(limited).toBe(180)
    expect([...wide.counts.keys()]).toEqual(['token:2001:db8:1::/48'])
    expect(s.events.some((e) => e.type === 'token_limited' && e.ip === '2001:db8:1::/48')).toBe(true)
    // Another /48 has its own bucket.
    expect((await tokenAt(s, '2001:db8:2::1')).status).not.toBe(429)
  })

  test('the /64 limit still holds inside a /48 with room', async () => {
    const narrow = limiter(2)
    const s = setup({ rateLimit: { token: narrow, tokenPer48: limiter(1000) } })
    const statuses = []
    for (let i = 0; i < 4; i++) statuses.push((await tokenAt(s, `2001:db8:1:2::${i + 1}`)).status)
    expect(statuses.filter((x) => x === 429)).toHaveLength(2)
    expect(s.events.some((e) => e.type === 'token_limited' && e.ip === '2001:db8:1:2::/64')).toBe(true)
  })

  test('authorize counts the /48 too', async () => {
    const s = setup({ rateLimit: { authorize: limiter(100), authorizePer48: limiter(3) } })
    const statuses = []
    for (let i = 1; i <= 5; i++)
      statuses.push((await s.oauth.fetch(new Request(authorizeUrl('c', 'x'), { headers: { 'cf-connecting-ip': `2001:db8:7:${i}::1` } }))).status)
    expect(statuses.filter((x) => x === 429)).toHaveLength(2)
    expect(s.events.some((e) => e.type === 'authorize_limited' && e.ip === '2001:db8:7::/48')).toBe(true)
  })

  test('a 6to4 address counts as the IPv4 address it carries, whatever its /64', async () => {
    const narrow = limiter(2)
    const s = setup({ rateLimit: { token: narrow, tokenPer48: limiter(1000) } })
    const statuses = []
    for (const ip of ['2002:0102:0304:1::1', '2002:102:304:ffff::2', '1.2.3.4']) statuses.push((await tokenAt(s, ip)).status)
    expect(statuses[2]).toBe(429)
    expect([...narrow.counts.keys()]).toEqual(['token:1.2.3.4'])
  })

  test('registration counts the /48, ten times the per address limit by default', async () => {
    const s = setup({ registration: { enabled: true, perHourPerIp: 1 } })
    const reg = (ip: string) =>
      s.oauth.fetch(new Request(`${ISSUER}/oauth/register`, { method: 'POST', headers: { 'content-type': 'application/json', 'cf-connecting-ip': ip }, body: JSON.stringify({ redirect_uris: [REDIRECT], client_name: 'x', token_endpoint_auth_method: 'none' }) }))
    const statuses = []
    for (let i = 1; i <= 12; i++) statuses.push((await reg(`2001:db8:9:${i}::1`)).status)
    expect(statuses.filter((x) => x === 429)).toHaveLength(2)
    expect(s.events.some((e) => e.type === 'registration_limited' && e.ip === '2001:db8:9::/48')).toBe(true)
  })
})

// ---------------------------------------------------------------- authorization code replay (RFC 9700)

describe('oauth: a replayed authorization code tombstones its grant', () => {
  const yServer = (s: ReturnType<typeof setup>, kv: ReturnType<typeof kvLocations>['y'], store: any) =>
    O.authorizationServer<Door>({ ...baseOptions(s), kv, refresh: { store }, clients: { platform: { known: PLATFORM_KNOWN }, org: { unverified: 'allow' } } })
  const exchangeAt = async (srv: { fetch: (r: Request) => Promise<Response> }, data: Record<string, string>) => {
    const res = await srv.fetch(new Request(`${ISSUER}/oauth/token`, form({ grant_type: 'authorization_code', redirect_uri: REDIRECT, resource: DOORS.org, ...data })))
    return { res, body: (await res.json()) as any }
  }
  const storeOf = async (kind: 'd1' | 'durable object') => (kind === 'd1' ? await d1Store() : O.durableObjectRefreshStore(fakeNamespace()))

  for (const kind of ['d1', 'durable object'] as const) {
    test(`${kind}: a stale location cannot bring back a grant the library revoked for a replayed code`, async () => {
      const kv = kvLocations()
      const store = await storeOf(kind)
      const s = setup({ kv: kv.x, refresh: { store } })
      const y = yServer(s, kv.y, store)
      const c = await client(s.oauth)
      const a = await authorize(s, c.clientId)
      const code = a.to.searchParams.get('code')!
      const grantId = grantOf(code)
      const t = await exchangeAt(s.oauth, { code, client_id: c.clientId, code_verifier: a.verifier })
      expect(t.res.status).toBe(200)
      // Y reads the exchanged grant into its cache.
      expect((await refreshVia(y, c.clientId, `rina:${grantId}:wrong`)).res.status).toBe(400)
      // The code comes back at X: the grant is revoked, as RFC 9700 has it, and tombstoned.
      const replay = await exchangeAt(s.oauth, { code, client_id: c.clientId, code_verifier: a.verifier })
      expect(replay.res.status).toBe(400)
      expect(replay.body).toEqual({ error: 'invalid_grant', error_description: 'Authorization code already used' })
      expect(s.events.some((e) => e.type === 'code_reuse' && e.grantId === grantId)).toBe(true)
      expect(await store.tombstoned(grantId)).toEqual({ userId: 'rina', grantId })
      // Ten seconds on, the refresh token at Y, whose cache still holds the grant: refused, nothing written back.
      setSystemTime(new Date(Date.now() + 10_000))
      const back = await refreshVia(y, c.clientId, t.body.refresh_token)
      expect(back.res.status).toBe(400)
      expect(back.body.error).toBe('invalid_grant')
      setSystemTime(new Date(Date.now() + 120_000))
      expect(await kv.central.get(`grant:rina:${grantId}`)).toBeNull()
      expect(await s.oauth.resolveSeat('org', t.body.access_token, req())).toBeNull()
      expect((await s.oauth.connectedApps('rina')).apps).toHaveLength(0)
    })

    test(`${kind}: a code exchanged at X is not exchanged again at a location that cached it unused`, async () => {
      const kv = kvLocations()
      const store = await storeOf(kind)
      const s = setup({ kv: kv.x, refresh: { store } })
      const y = yServer(s, kv.y, store)
      const c = await client(s.oauth)
      const a = await authorize(s, c.clientId)
      const code = a.to.searchParams.get('code')!
      const grantId = grantOf(code)
      // Y reads the grant before the exchange: a wrong verifier, which the library refuses and which spends nothing.
      expect((await exchangeAt(y, { code, client_id: c.clientId, code_verifier: 'x'.repeat(43) })).res.status).toBe(400)
      const t = await exchangeAt(s.oauth, { code, client_id: c.clientId, code_verifier: a.verifier })
      expect(t.res.status).toBe(200)
      // Five seconds on, the same code at Y, whose cache still holds the grant with its code unused.
      setSystemTime(new Date(Date.now() + 5_000))
      const twice = await exchangeAt(y, { code, client_id: c.clientId, code_verifier: a.verifier })
      expect(twice.res.status).toBe(400)
      expect(twice.body.error).toBe('invalid_grant')
      expect(await store.tombstoned(grantId)).toEqual({ userId: 'rina', grantId })
      expect((await refreshVia(s.oauth, c.clientId, t.body.refresh_token)).res.status).toBe(400)
      expect(await s.oauth.resolveSeat('org', t.body.access_token, req())).toBeNull()
    })

    test(`${kind}: fails closed: a replay whose tombstone cannot be written answers 503 and revokes nothing`, async () => {
      const kv = kvLocations()
      const inner = await storeOf(kind)
      let broken = true
      const store = { ...inner, tombstone: async (g: string, o: any, ttl: number) => (broken ? Promise.reject(new Error('down')) : inner.tombstone(g, o, ttl)) }
      const s = setup({ kv: kv.x, refresh: { store } })
      const y = yServer(s, kv.y, store)
      const c = await client(s.oauth)
      const a = await authorize(s, c.clientId)
      const code = a.to.searchParams.get('code')!
      const grantId = grantOf(code)
      const t = await exchangeAt(s.oauth, { code, client_id: c.clientId, code_verifier: a.verifier })
      expect(t.res.status).toBe(200)
      expect((await refreshVia(y, c.clientId, `rina:${grantId}:wrong`)).res.status).toBe(400)
      const first = await exchangeAt(s.oauth, { code, client_id: c.clientId, code_verifier: a.verifier })
      expect(first.res.status).toBe(503)
      expect(first.body.error).toBe('temporarily_unavailable')
      expect(s.events.some((e) => e.type === 'oauth_error' && e.code === 'revocation_unrecorded')).toBe(true)
      expect(await kv.central.get(`grant:rina:${grantId}`)).not.toBeNull()
      // The store is back: the same replay revokes and tombstones, and Y refuses the refresh token.
      broken = false
      expect((await exchangeAt(s.oauth, { code, client_id: c.clientId, code_verifier: a.verifier })).res.status).toBe(400)
      expect(await inner.tombstoned(grantId)).toEqual({ userId: 'rina', grantId })
      setSystemTime(new Date(Date.now() + 10_000))
      expect((await refreshVia(y, c.clientId, t.body.refresh_token)).res.status).toBe(400)
      setSystemTime(new Date(Date.now() + 120_000))
      expect(await kv.central.get(`grant:rina:${grantId}`)).toBeNull()
    })

    test(`${kind}: only the grant's own client, authenticated, revokes it with a replayed code`, async () => {
      const kv = kvLocations()
      const store = await storeOf(kind)
      const s = setup({ kv: kv.x, refresh: { store } })
      const y = yServer(s, kv.y, store)
      const c = await s.oauth.api().createClient({ redirectUris: [REDIRECT], clientName: 'Server App', tokenEndpointAuthMethod: 'client_secret_post' })
      const other = await client(s.oauth, 'Other')
      const a = await authorize(s, c.clientId)
      const code = a.to.searchParams.get('code')!
      const grantId = grantOf(code)
      const secret = { client_id: c.clientId, client_secret: c.clientSecret! }
      const t = await exchangeAt(s.oauth, { code, code_verifier: a.verifier, ...secret })
      expect(t.res.status).toBe(200)
      const refreshY = (token: string) => y.fetch(new Request(`${ISSUER}/oauth/token`, form({ grant_type: 'refresh_token', refresh_token: token, ...secret })))
      expect((await refreshY(`rina:${grantId}:wrong`)).status).toBe(400)
      // Another client, and the right client with a wrong secret: the library's answer, nothing revoked.
      expect((await exchangeAt(s.oauth, { code, client_id: other.clientId, code_verifier: a.verifier })).res.status).toBe(400)
      expect((await exchangeAt(s.oauth, { code, code_verifier: a.verifier, client_id: c.clientId, client_secret: 'wrong' })).res.status).toBe(401)
      expect(await store.tombstoned(grantId)).toBeNull()
      expect(await kv.central.get(`grant:rina:${grantId}`)).not.toBeNull()
      // The client itself: revoked and tombstoned.
      expect((await exchangeAt(s.oauth, { code, code_verifier: a.verifier, ...secret })).res.status).toBe(400)
      expect(await store.tombstoned(grantId)).toEqual({ userId: 'rina', grantId })
      setSystemTime(new Date(Date.now() + 10_000))
      expect((await refreshY(t.body.refresh_token)).status).toBe(400)
      setSystemTime(new Date(Date.now() + 120_000))
      expect(await kv.central.get(`grant:rina:${grantId}`)).toBeNull()
    })
  }
})

// ---------------------------------------------------------------- round 5

/** A token request with headers of its own, such as an Authorization header the client sends with every call. */
const tokenWith = (srv: { fetch: (r: Request) => Promise<Response> }, data: Record<string, string>, headers: Record<string, string>) =>
  srv.fetch(new Request(`${ISSUER}/oauth/token`, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded', ...headers }, body: new URLSearchParams(data).toString() }))

describe('oauth: round 5 M1, a used code is never exchanged again, whatever the Authorization header', () => {
  const yServer = (s: ReturnType<typeof setup>, kv: ReturnType<typeof kvLocations>['y'], store: any) =>
    O.authorizationServer<Door>({ ...baseOptions(s), kv, refresh: { store }, clients: { platform: { known: PLATFORM_KNOWN }, org: { unverified: 'allow' } } })
  const codeBody = (code: string, data: Record<string, string>) => ({ grant_type: 'authorization_code', redirect_uri: REDIRECT, resource: DOORS.org, code, ...data })

  /** A code exchanged at X while Y still holds its grant, cached from before the exchange with the code unused. */
  async function exchangedAtX() {
    const kv = kvLocations()
    const store = await d1Store()
    const s = setup({ kv: kv.x, refresh: { store } })
    const y = yServer(s, kv.y, store)
    const c = await client(s.oauth)
    const a = await authorize(s, c.clientId)
    const code = a.to.searchParams.get('code')!
    // Y reads the grant: a wrong verifier, which the library refuses and which spends nothing.
    expect((await tokenWith(y, codeBody(code, { client_id: c.clientId, code_verifier: 'x'.repeat(43) }), {})).status).toBe(400)
    const t = await tokenWith(s.oauth, codeBody(code, { client_id: c.clientId, code_verifier: a.verifier }), {})
    expect(t.status).toBe(200)
    setSystemTime(new Date(Date.now() + 5_000))
    return { s, y, store, c, a, code, grantId: grantOf(code), tokens: (await t.json()) as any }
  }

  // The reviewer's proof (F2b): the kit read any Authorization header that was not Basic as naming no
  // client, so the replay went to the library at Y, whose cache held the code unused: a second token set.
  for (const authorization of ['Bearer x', 'DPoP proof', 'bearer\tx'])
    test(`the grant's own client replaying the code with "${authorization}" revokes the grant and gets no tokens`, async () => {
      const { s, y, store, c, a, code, grantId, tokens } = await exchangedAtX()
      const res = await tokenWith(y, codeBody(code, { client_id: c.clientId, code_verifier: a.verifier }), { authorization })
      const body = (await res.json()) as any
      expect(res.status).toBe(400)
      expect(body).toEqual({ error: 'invalid_grant', error_description: 'Authorization code already used' })
      expect(s.events.some((e) => e.type === 'code_reuse' && e.grantId === grantId)).toBe(true)
      expect(await store.tombstoned(grantId)).toEqual({ userId: 'rina', grantId })
      expect(await s.oauth.resolveSeat('org', tokens.access_token, req())).toBeNull()
    })

  // Once the kit's record says the code was used, the library is not asked: at Y it would exchange the code.
  for (const [name, data, headers] of [
    ['another client', { client_id: 'someone-else' }, {}],
    ['no client', {}, {}],
    ['Basic beside a client_id', { client_id: 'x' }, { authorization: `Basic ${btoa('x:y')}` }],
    ['Basic the library cannot read', {}, { authorization: 'Basic !!!' }],
  ] as const)
    test(`a used code from ${name} gets invalid_grant at a stale location, and nothing is revoked`, async () => {
      const { s, y, store, a, code, grantId, tokens } = await exchangedAtX()
      const res = await tokenWith(y, codeBody(code, { code_verifier: a.verifier, ...data }), headers)
      expect(res.status).toBe(400)
      expect(((await res.json()) as any).error).toBe('invalid_grant')
      expect(await store.tombstoned(grantId)).toBeNull()
      expect(s.events.some((e) => e.type === 'code_reuse')).toBe(false)
      expect(await s.oauth.resolveSeat('org', tokens.access_token, req())).not.toBeNull()
    })
})

describe('oauth: round 5 L1, a code holder without the verifier cannot turn the real exchange into a replay', () => {
  const codeBody = (code: string, data: Record<string, string>) => ({ grant_type: 'authorization_code', redirect_uri: REDIRECT, resource: DOORS.org, code, ...data })

  // The reviewer's proof (F1): the attacker named a client whose metadata document he serves slowly.
  // The kit locked the grant and recorded the code as used before the library looked at the client;
  // the 10 s lock lapsed while the library waited, and the victim's first exchange then counted as
  // a replay, which revoked her grant. Another client now holds no lock and leaves no record.
  for (const kind of ['public', 'confidential'] as const)
    test(`${kind}: another client's slow exchange leaves the victim's first exchange alone`, async () => {
      const EVIL_ID = 'https://evil.example/oauth/client.json'
      let gate: (() => void) | null = null
      let entered = false
      const restore = cimdHook(async (url) => {
        if (url !== EVIL_ID) return undefined
        entered = true
        await new Promise<void>((r) => (gate = r))
        return undefined // 404: the library refuses the attacker
      })
      try {
        const store = await d1Store()
        const s = setup({ refresh: { store } })
        const c =
          kind === 'public'
            ? await client(s.oauth)
            : await s.oauth.api().createClient({ redirectUris: [REDIRECT], clientName: 'Server App', tokenEndpointAuthMethod: 'client_secret_post' })
        const creds: Record<string, string> = kind === 'public' ? { client_id: c.clientId } : { client_id: c.clientId, client_secret: c.clientSecret! }
        const a = await authorize(s, c.clientId)
        const code = a.to.searchParams.get('code')!
        const grantId = grantOf(code)
        const attacker = tokenWith(s.oauth, codeBody(code, { client_id: EVIL_ID, code_verifier: 'x'.repeat(43) }), {})
        while (!entered) await new Promise((r) => setTimeout(r, 1))
        setSystemTime(new Date(Date.now() + 31_000))
        const legit = await tokenWith(s.oauth, codeBody(code, { code_verifier: a.verifier, ...creds }), {})
        ;(gate as unknown as () => void)()
        expect((await attacker).status).toBe(401)
        expect(legit.status).toBe(200)
        expect(await store.tombstoned(grantId)).toBeNull()
        expect(s.events.some((e) => e.type === 'code_reuse')).toBe(false)
        expect(await s.oauth.resolveSeat('org', ((await legit.json()) as any).access_token, req())).not.toBeNull()
      } finally {
        restore()
      }
    })

  // The grant's own client id with a wrong verifier is locked and recorded, as it must be. If the
  // library is slow past the lock, the real exchange finds that exchange pending: 503, not a replay.
  test('an exchange still pending when its lock lapsed makes the next one wait, and the code still works after', async () => {
    const id = 'https://client.example/oauth/client.json'
    let gate: (() => void) | null = null
    let entered = false
    let stall = false
    const restore = cimdHook(async (url) => {
      if (url !== id) return undefined
      if (gate === null && stall) {
        entered = true
        await new Promise<void>((r) => (gate = r))
      }
      return new Response(JSON.stringify({ ...doc(id, REDIRECT, 'C'), grant_types: ['authorization_code', 'refresh_token'] }), { headers: { 'content-type': 'application/json' } })
    })
    try {
      const store = await d1Store()
      const s = setup({ refresh: { store } })
      const a = await authorize(s, id)
      const code = a.to.searchParams.get('code')!
      const grantId = grantOf(code)
      stall = true
      const attacker = exchange(s, id, code, 'x'.repeat(43))
      while (!entered) await new Promise((r) => setTimeout(r, 1))
      stall = false
      // Inside the lock: contended.
      const early = await exchange(s, id, code, a.verifier)
      expect(early.res.status).toBe(503)
      // Past the lock: the attacker's exchange is still pending, so its outcome is unknown. Wait, never "replayed".
      setSystemTime(new Date(Date.now() + 31_000))
      const late = await exchange(s, id, code, a.verifier)
      expect(late.res.status).toBe(503)
      expect(late.body.error).toBe('temporarily_unavailable')
      expect(late.res.headers.get('retry-after')).toBe('5')
      ;(gate as unknown as () => void)()
      const att = await attacker
      expect(att.res.status).toBe(400)
      expect(att.body.error).toBe('invalid_grant')
      // The library refused the attacker without spending the code: the real exchange goes through.
      const real = await exchange(s, id, code, a.verifier)
      expect(real.res.status).toBe(200)
      expect(await store.tombstoned(grantId)).toBeNull()
      expect(s.events.some((e) => e.type === 'code_reuse')).toBe(false)
      // And the code is now used: presented again, it is a replay.
      const again = await exchange(s, id, code, a.verifier)
      expect(again.body).toEqual({ error: 'invalid_grant', error_description: 'Authorization code already used' })
      expect(await store.tombstoned(grantId)).toEqual({ userId: 'rina', grantId })
    } finally {
      restore()
    }
  })

  test('the pending record goes once the library answers, so nothing is left behind', async () => {
    const store = await d1Store()
    const pendingKeys: string[] = []
    const watched = {
      ...store,
      retire: async (g: string, h: string, o: any, ttl: number) => {
        if (o.userId !== 'rina') pendingKeys.push(h)
        return store.retire(g, h, o, ttl)
      },
    }
    const s = setup({ refresh: { store: watched } })
    const c = await client(s.oauth)
    const a = await authorize(s, c.clientId)
    const code = a.to.searchParams.get('code')!
    expect((await exchange(s, c.clientId, code, 'x'.repeat(43))).res.status).toBe(400)
    expect((await exchange(s, c.clientId, code, a.verifier)).res.status).toBe(200)
    expect(pendingKeys).toHaveLength(2)
    for (const k of pendingKeys) expect(await store.retired(grantOf(code), k)).toBeNull()
    expect(await store.retired(grantOf(code), await sha256Hex(code))).toEqual({ userId: 'rina', grantId: grantOf(code) })
  })
})

describe('oauth: round 5 L2, a client revoking its own token tombstones the grant whatever the Authorization header', () => {
  // The reviewer's proof (F2): a confidential client that sends its access token as a Bearer header on
  // every call revoked its refresh token with client_id and client_secret in the body. The kit read the
  // header as naming no client and handed the revocation to the library: no tombstone, and a location
  // whose cache still held the grant wrote it back on the next refresh.
  for (const authorization of ['Bearer', 'bearer', 'DPoP'])
    test(`a confidential client with a ${authorization} header: tombstoned, and a stale location cannot refresh`, async () => {
      const kv = kvLocations()
      const store = await d1Store()
      const s = setup({ kv: kv.x, refresh: { store } })
      const y = O.authorizationServer<Door>({ ...baseOptions(s), kv: kv.y, refresh: { store }, clients: { platform: { known: PLATFORM_KNOWN }, org: { unverified: 'allow' } } })
      const c = await s.oauth.api().createClient({ redirectUris: [REDIRECT], clientName: 'Server App', tokenEndpointAuthMethod: 'client_secret_post' })
      const secret = { client_id: c.clientId, client_secret: c.clientSecret! }
      const a = await authorize(s, c.clientId)
      const t = await tokenWith(s.oauth, { grant_type: 'authorization_code', redirect_uri: REDIRECT, resource: DOORS.org, code: a.to.searchParams.get('code')!, code_verifier: a.verifier, ...secret }, {})
      expect(t.status).toBe(200)
      const tokens = (await t.json()) as any
      const grantId = grantOf(tokens.refresh_token)
      const refreshY = (token: string) => tokenWith(y, { grant_type: 'refresh_token', refresh_token: token, ...secret }, {})
      expect((await refreshY(`rina:${grantId}:wrong`)).status).toBe(400) // Y caches the grant
      const rev = await revokeVia(s.oauth, { token: tokens.refresh_token, token_type_hint: 'refresh_token', ...secret }, { authorization: `${authorization} ${tokens.access_token}` })
      expect(rev.status).toBe(200)
      expect(await store.tombstoned(grantId)).toEqual({ userId: 'rina', grantId })
      setSystemTime(new Date(Date.now() + 10_000))
      expect((await refreshY(tokens.refresh_token)).status).toBe(400)
      setSystemTime(new Date(Date.now() + 120_000))
      expect(await kv.central.get(`grant:rina:${grantId}`)).toBeNull()
    })

  test('a wrong secret beside a Bearer header revokes nothing', async () => {
    const store = await d1Store()
    const s = setup({ refresh: { store } })
    const c = await s.oauth.api().createClient({ redirectUris: [REDIRECT], clientName: 'Server App', tokenEndpointAuthMethod: 'client_secret_post' })
    const a = await authorize(s, c.clientId)
    const t = (await (
      await tokenWith(s.oauth, { grant_type: 'authorization_code', redirect_uri: REDIRECT, resource: DOORS.org, code: a.to.searchParams.get('code')!, code_verifier: a.verifier, client_id: c.clientId, client_secret: c.clientSecret! }, {})
    ).json()) as any
    const rev = await revokeVia(s.oauth, { token: t.refresh_token, client_id: c.clientId, client_secret: 'wrong' }, { authorization: `Bearer ${t.access_token}` })
    expect(rev.status).toBe(401)
    expect(await store.tombstoned(grantOf(t.refresh_token))).toBeNull()
    expect(await s.oauth.resolveSeat('org', t.access_token, req())).not.toBeNull()
  })
})

// ---------------------------------------------------------------- round 6

// Proofs from the sixth review, ported. Each runs the reviewer's exploit and passes when it fails.

/** A tenant-only product (no platform door), the shape the example Worker has, on a consistent store. */
function tenantServer(kv: any, extra: Partial<Parameters<OAuthMod['authorizationServer']>[0]> = {}) {
  resetPeople()
  const codes = O.signInCodes(kv)
  const events: any[] = []
  const oauth = O.authorizationServer<'org'>({
    issuer: ISSUER,
    kv,
    doors: { org: DOORS.org },
    platformDoors: [],
    productName: 'Notes',
    signIn: { url: 'https://app.example.com/mcp-sign-in', authenticate: (code, state) => codes.redeem(code, state) },
    chooseSeat: (person) => people[person.id]?.seats.org ?? null,
    checkSeat: (g) => g.principal.kind === 'service' || people[g.principal.id]?.seats.org?.id === g.seat.id,
    keys: { personal: { prefix: (d) => `notes_mcp_${d}_` }, service: { prefix: (d) => `notes_svc_${d}_` } },
    clients: { org: { unverified: 'allow' } },
    refresh: { store: O.durableObjectRefreshStore(fakeNamespace()) },
    onEvent: (e) => events.push(e),
    ...extra,
  } as Parameters<OAuthMod['authorizationServer']>[0] as never)
  return { kv, codes, oauth: oauth as any, events }
}

describe('oauth: round 6 R6-1, revocation finds what KV list() has not shown yet', () => {
  test('a server without checkSeat does not start, at a tenant door either', () => {
    expect(() => tenantServer(O.memoryKv(), { checkSeat: undefined as never })).toThrow('checkSeat is required at every door')
  })

  test('personLostRole revokes a grant and a key made seconds before, with checkSeat still saying yes', async () => {
    const t0 = Date.now()
    setSystemTime(new Date(t0))
    // checkSeat that still says yes isolates the fix: only personLostRole can stop her here.
    const s = tenantServer(laggingList(O.memoryKv()), { checkSeat: () => true })
    const t = await connected(s as any)
    const pk = await s.oauth.keys.createPersonal({ principal: people.rina!.principal, seat: people.rina!.seats.org!, name: 'k' })
    setSystemTime(new Date(t0 + 10_000))
    // The listing shows neither yet; the index in the store has both.
    expect(await s.kv.list({ prefix: 'grant:rina:' }).then((r: any) => r.keys.length)).toBe(0)
    expect(await s.oauth.personLostRole('rina')).toEqual({ grants: 1, keys: 1 })
    expect(await s.oauth.resolveSeat('org', t.access, req())).toBeNull()
    expect(await s.oauth.resolveSeat('org', pk.key, req())).toBeNull()
    setSystemTime(new Date(t0 + 5 * 60_000))
    expect((await refresh(s as any, t.clientId, t.refresh)).res.status).toBe(400)
    setSystemTime(new Date(t0 + 20 * 86_400_000))
    expect((await refresh(s as any, t.clientId, t.refresh)).res.status).toBe(400)
    expect(await s.oauth.resolveSeat('org', pk.key, req())).toBeNull()
    expect(await s.oauth.connectedApps('rina')).toEqual({ apps: [], keys: [] })
  })

  test('revokeApp and connectedApps see a grant made seconds before', async () => {
    const t0 = Date.now()
    setSystemTime(new Date(t0))
    const s = tenantServer(laggingList(O.memoryKv()))
    const t = await connected(s as any)
    setSystemTime(new Date(t0 + 10_000))
    expect((await s.oauth.connectedApps('rina')).apps.map((a: any) => a.grantId)).toEqual([grantOf(t.refresh)])
    expect(await s.oauth.revokeApp('imran', grantOf(t.refresh))).toBe(false)
    expect(await s.oauth.revokeApp('rina', grantOf(t.refresh))).toBe(true)
    expect(await s.oauth.resolveSeat('org', t.access, req())).toBeNull()
    expect((await refresh(s as any, t.clientId, t.refresh)).res.status).toBe(400)
    expect((await s.oauth.connectedApps('rina')).apps).toEqual([])
  })

  test('the revocation mark refuses a grant and a key the index missed', async () => {
    const t0 = Date.now()
    setSystemTime(new Date(t0))
    // A store whose index lost everything: only the mark is left to act.
    const inner = O.durableObjectRefreshStore(fakeNamespace())
    const store = { ...inner, indexList: async () => [] }
    const s = tenantServer(laggingList(O.memoryKv()), { checkSeat: () => true, refresh: { store } })
    const t = await connected(s as any)
    const pk = await s.oauth.keys.createPersonal({ principal: people.rina!.principal, seat: people.rina!.seats.org!, name: 'k' })
    setSystemTime(new Date(t0 + 10_000))
    expect(await s.oauth.personLostRole('rina')).toEqual({ grants: 0, keys: 0 })
    expect(await s.oauth.resolveSeat('org', t.access, req())).toBeNull()
    expect(await s.oauth.resolveSeat('org', pk.key, req())).toBeNull()
    const r = await refresh(s as any, t.clientId, t.refresh)
    expect(r.res.status).toBe(400)
    expect(s.events.some((e) => e.type === 'grant_revoked' && e.reason === 'person_revoked')).toBe(true)
    expect(await inner.tombstoned(grantOf(t.refresh))).not.toBeNull()
    // A grant made after the mark is not covered.
    setSystemTime(new Date(t0 + 20_000))
    const again = await connected(s as any)
    expect(await s.oauth.resolveSeat('org', again.access, req())).not.toBeNull()
    expect((await refresh(s as any, again.clientId, again.refresh)).res.status).toBe(200)
  })

  test('a mark at one tenant leaves another tenant alone', async () => {
    const s = tenantServer(O.memoryKv(), { checkSeat: () => true })
    const t = await connected(s as any)
    await s.oauth.personLostRole('rina', { tenant: 'branch-2' })
    expect(await s.oauth.resolveSeat('org', t.access, req())).not.toBeNull()
    expect((await refresh(s as any, t.clientId, t.refresh)).res.status).toBe(200)
  })

  test('checkSeat runs on refresh: a seat that is gone revokes the grant', async () => {
    const t0 = Date.now()
    setSystemTime(new Date(t0))
    const s = tenantServer(laggingList(O.memoryKv()))
    const t = await connected(s as any)
    setSystemTime(new Date(t0 + 10_000))
    delete people.rina!.seats.org
    expect(await s.oauth.resolveSeat('org', t.access, req())).toBeNull()
    setSystemTime(new Date(t0 + 5 * 60_000))
    const r = await refresh(s as any, t.clientId, t.refresh)
    expect(r.res.status).toBe(400)
    expect(r.body.error).toBe('invalid_grant')
    expect(s.events.some((e) => e.type === 'grant_revoked' && e.reason === 'seat_gone')).toBe(true)
    expect((await s.oauth.connectedApps('rina')).apps).toHaveLength(0)
  })

  test('checkSeat runs on the code exchange too', async () => {
    const s = tenantServer(O.memoryKv())
    const c = await client(s.oauth)
    const a = await authorize(s as any, c.clientId)
    delete people.rina!.seats.org
    const t = await exchange(s as any, c.clientId, a.to.searchParams.get('code')!, a.verifier)
    expect(t.res.status).toBe(400)
    expect(t.body.error).toBe('invalid_grant')
  })

  test('a checkSeat that throws at refresh answers 503 and revokes nothing; the same refresh token works after', async () => {
    let down = false
    const s = tenantServer(O.memoryKv(), {
      checkSeat: (g) => {
        if (down) throw new Error('database down')
        return people[g.principal.id]?.seats.org?.id === g.seat.id
      },
    })
    const t = await connected(s as any)
    down = true
    const r = await refresh(s as any, t.clientId, t.refresh)
    expect(r.res.status).toBe(503)
    down = false
    const ok = await refresh(s as any, t.clientId, t.refresh)
    expect(ok.res.status).toBe(200)
    expect(await s.oauth.resolveSeat('org', ok.body.access_token, req())).not.toBeNull()
  })

  test('on D1: the index, the person revocation and prune', async () => {
    const t0 = Date.now()
    setSystemTime(new Date(t0))
    const store = (await d1Store()) as any
    const s = tenantServer(laggingList(O.memoryKv()), { checkSeat: () => true, refresh: { store } })
    const t = await connected(s as any)
    const pk = await s.oauth.keys.createPersonal({ principal: people.rina!.principal, seat: people.rina!.seats.org!, name: 'k' })
    expect((await store.indexList('person:rina')).map((e: any) => e.kind).sort()).toEqual(['grant', 'key'])
    setSystemTime(new Date(t0 + 10_000))
    expect(await s.oauth.personLostRole('rina', { door: 'org' })).toEqual({ grants: 1, keys: 1 })
    expect(await store.personRevocations('rina')).toEqual([{ before: t0 + 10_000, door: 'org', tenant: null }])
    // A later revocation for the same door and tenant keeps the later moment.
    await store.revokePerson('rina', { before: t0, door: 'org', tenant: null }, 60)
    expect((await store.personRevocations('rina'))[0].before).toBe(t0 + 10_000)
    expect(await s.oauth.resolveSeat('org', t.access, req())).toBeNull()
    expect(await s.oauth.resolveSeat('org', pk.key, req())).toBeNull()
    expect(await store.indexList('person:rina')).toEqual([])
    setSystemTime(new Date(t0 + 400 * 86_400_000))
    expect(await store.prune()).toBeGreaterThan(0)
    expect(await store.personRevocations('rina')).toEqual([])
  })

  test('the Durable Object drops expired index entries and revocations at its alarm', async () => {
    const t0 = Date.now()
    setSystemTime(new Date(t0))
    const ns = fakeNamespace()
    const store = O.durableObjectRefreshStore(ns)
    await store.indexPut('person:rina', { kind: 'grant', id: 'g1', door: 'org', tenant: 'branch-1', until: t0 + 60_000 })
    await store.revokePerson('rina', { before: t0, door: null, tenant: null }, 120)
    expect(await store.indexList('person:rina')).toHaveLength(1)
    setSystemTime(new Date(t0 + 200_000))
    expect(await store.indexList('person:rina')).toEqual([])
    expect(await store.personRevocations('rina')).toEqual([])
    await ns.alarmAll()
    const raw = await O.durableObjectRefreshStore(ns).indexList('person:rina')
    expect(raw).toEqual([])
  })

  test('a tenant door on the KV refresh store warns at start', () => {
    const seen: string[] = []
    const warn = console.warn
    console.warn = (m: string) => void seen.push(String(m))
    try {
      O.authorizationServer<'branch'>({
        issuer: ISSUER,
        kv: O.memoryKv(),
        doors: { branch: `${ISSUER}/branch` },
        platformDoors: [],
        productName: 'Notes',
        signIn: { url: 'https://app.example.com/mcp-sign-in', authenticate: () => null },
        chooseSeat: () => null,
        checkSeat: () => true,
      })
    } finally {
      console.warn = warn
    }
    expect(seen.some((m) => m.includes('tenant door branch uses the KV refresh store'))).toBe(true)
  })
})

describe('oauth: round 6 R6-2, a revoked key stays revoked in every location', () => {
  const twoLocations = () => {
    const kv = kvLocations()
    const store = O.durableObjectRefreshStore(fakeNamespace())
    const x = tenantServer(kv.x, { refresh: { store } })
    const y = tenantServer(kv.y, { refresh: { store } })
    return { kv, x, y, store }
  }

  test('a revoked personal key stops at once in another location', async () => {
    const { x, y } = twoLocations()
    const pk = await x.oauth.keys.createPersonal({ principal: people.rina!.principal, seat: people.rina!.seats.org!, name: 'leaked' })
    expect(await y.oauth.resolveSeat('org', pk.key, req())).not.toBeNull()
    expect(await x.oauth.keys.revoke('rina', pk.info.id)).toBe(true)
    expect(await x.oauth.resolveSeat('org', pk.key, req())).toBeNull()
    setSystemTime(new Date(Date.now() + 45_000))
    expect(await y.oauth.resolveSeat('org', pk.key, req())).toBeNull()
    expect(await y.oauth.keys.list('rina')).toEqual([])
  })

  test('transferService in a location with a stale cache refuses a revoked service key', async () => {
    const { kv, x, y } = twoLocations()
    const sk = await x.oauth.keys.createService({ owner: people.rina!.principal, tenant: 'branch-1', door: 'org', name: 'integration', tools: ['notes_list'] })
    expect((await y.oauth.keys.list('rina')).map((k: any) => k.id)).toEqual([sk.info.id])
    expect(await x.oauth.keys.revoke('rina', sk.info.id)).toBe(true)
    setSystemTime(new Date(Date.now() + 5_000))
    expect(await y.oauth.keys.transferService('rina', sk.info.id, people.imran!.principal)).toBe(false)
    setSystemTime(new Date(Date.now() + 120_000))
    expect(await kv.central.get(`omazy-oauth:key:${await sha256Hex(sk.key)}`)).toBeNull()
    expect(await x.oauth.resolveSeat('org', sk.key, req())).toBeNull()
    expect((await x.oauth.connectedApps('imran')).keys).toEqual([])
  })

  test('a key moved before its owner is revoked stays with the new owner', async () => {
    const s = tenantServer(laggingList(O.memoryKv()))
    const sk = await s.oauth.keys.createService({ owner: people.rina!.principal, tenant: 'branch-1', door: 'org', name: 'integration', tools: ['notes_list'] })
    setSystemTime(new Date(Date.now() + 1000))
    expect(await s.oauth.keys.transferService('rina', sk.info.id, people.imran!.principal)).toBe(true)
    setSystemTime(new Date(Date.now() + 1000))
    expect(await s.oauth.personLostRole('rina')).toEqual({ grants: 0, keys: 0 })
    expect(await s.oauth.resolveSeat('org', sk.key, req())).not.toBeNull()
    expect((await s.oauth.keys.list('imran')).map((k: any) => k.id)).toEqual([sk.info.id])
  })

  test('Keys on its own takes the store; without one the KV window stays, as documented', async () => {
    const kv = kvLocations()
    const store = O.durableObjectRefreshStore(fakeNamespace())
    const opts = { personal: { prefix: () => 'notes_mcp_org_' } }
    const seat = { id: 'seat-rina-b1', door: 'org', tenant: 'branch-1' }
    for (const withStore of [true, false]) {
      const x = new O.Keys<'org'>(kv.x as any, ['org'], opts, [], withStore ? store : undefined)
      const y = new O.Keys<'org'>(kv.y as any, ['org'], opts, [], withStore ? store : undefined)
      const pk = await x.createPersonal({ principal: { kind: 'member', id: 'rina' }, seat, name: 'k' })
      expect(await y.resolve(pk.key, 'org')).not.toBeNull()
      expect(await x.revoke('rina', pk.info.id)).toBe(true)
      expect(await y.resolve(pk.key, 'org')).toEqual(withStore ? null : expect.anything())
    }
  })
})

describe('oauth: round 6 R6-3, every numeric option is a whole number', () => {
  const bad = [Number.NaN, Number.POSITIVE_INFINITY, 1.5, 0, -1]
  test('NaN, Infinity, a fraction or zero throws at start', () => {
    for (const n of bad) {
      expect(() => tenantServer(O.memoryKv(), { keys: { personal: { prefix: (d) => `notes_mcp_${d}_`, maxDays: n } } })).toThrow('keys.personal.maxDays')
      expect(() => tenantServer(O.memoryKv(), { keys: { service: { prefix: (d) => `notes_svc_${d}_`, maxDays: n } } })).toThrow('keys.service.maxDays')
      expect(() => tenantServer(O.memoryKv(), { registration: { enabled: true, perHourPerIp: n } })).toThrow('registration.perHourPerIp')
      expect(() => tenantServer(O.memoryKv(), { registration: { enabled: true, perHourPer48: n } })).toThrow('registration.perHourPer48')
      expect(() => tenantServer(O.memoryKv(), { registration: { enabled: true, clientTtlDays: n } })).toThrow('registration.clientTtlDays')
      expect(() => tenantServer(O.memoryKv(), { turnstile: { siteKey: 'sk', verify: () => false, after: n } })).toThrow('turnstile.after')
      expect(() => tenantServer(O.memoryKv(), { ttl: { accessSeconds: n } })).toThrow('ttl.accessSeconds')
      expect(() => tenantServer(O.memoryKv(), { ttl: { refreshSeconds: n } })).toThrow('ttl.refreshSeconds')
      expect(() => O.signInCodes(O.memoryKv(), { ttlSeconds: n })).toThrow('ttlSeconds')
      expect(() => new O.Keys<'org'>(O.memoryKv(), ['org'], { personal: { prefix: () => 'a_b_', maxDays: n } })).toThrow('maxDays')
    }
    expect(() => tenantServer(O.memoryKv(), { ttl: { accessSeconds: 59 } })).toThrow('at least 60')
  })

  test('the proofs: a ten-year key, no registration limit, no Turnstile', async () => {
    expect(() => tenantServer(O.memoryKv(), { keys: { personal: { prefix: (d) => `notes_mcp_${d}_`, maxDays: Number(undefined) } } })).toThrow()
    expect(() => tenantServer(O.memoryKv(), { registration: { enabled: true, perHourPerIp: Number('') + Number.NaN } })).toThrow()
    expect(() => tenantServer(O.memoryKv(), { turnstile: { siteKey: 'sk', verify: () => false, after: Number.NaN } })).toThrow()
    // Whole numbers still work, and a key past the cap is still refused.
    const d = tenantServer(O.memoryKv(), { keys: { personal: { prefix: (x) => `notes_mcp_${x}_`, maxDays: 30 } } })
    await expect(d.oauth.keys.createPersonal({ principal: people.rina!.principal, seat: people.rina!.seats.org!, name: 'k', days: 3650 })).rejects.toThrow('at most 30')
  })
})

describe('oauth: round 6 R6-4, api() revokes through the tombstone', () => {
  test('a grant revoked through api() stays revoked in a stale location', async () => {
    const kv = kvLocations()
    const store = O.durableObjectRefreshStore(fakeNamespace())
    const x = tenantServer(kv.x, { refresh: { store } })
    const y = tenantServer(kv.y, { refresh: { store } })
    const t = await connected(x as any)
    const r1 = await refresh(y as any, t.clientId, t.refresh)
    expect(r1.res.status).toBe(200)
    await x.oauth.api().revokeGrant(grantOf(t.refresh), 'rina')
    setSystemTime(new Date(Date.now() + 5_000))
    expect((await refresh(y as any, t.clientId, r1.body.refresh_token)).res.status).toBe(400)
    setSystemTime(new Date(Date.now() + 120_000))
    expect(await kv.central.get(`grant:rina:${grantOf(t.refresh)}`)).toBeNull()
    expect(await store.tombstoned(grantOf(t.refresh))).not.toBeNull()
  })

  test('api().deleteClient buries every grant of the client, one made seconds ago too', async () => {
    const kv = kvLocations()
    const store = O.durableObjectRefreshStore(fakeNamespace())
    const x = tenantServer(kv.x, { refresh: { store } })
    const y = tenantServer(kv.y, { refresh: { store } })
    const c = await client(x.oauth)
    const a = await authorize(x as any, c.clientId)
    const t = await exchange(x as any, c.clientId, a.to.searchParams.get('code')!, a.verifier)
    expect(t.res.status).toBe(200)
    const r1 = await refresh(y as any, c.clientId, t.body.refresh_token)
    expect(r1.res.status).toBe(200)
    await x.oauth.api().deleteClient(c.clientId)
    expect(await store.tombstoned(grantOf(t.body.refresh_token))).not.toBeNull()
    expect(await y.oauth.resolveSeat('org', r1.body.access_token, req())).toBeNull()
    expect((await refresh(y as any, c.clientId, r1.body.refresh_token)).res.status).toBe(400)
    // Every other helper still works through the wrapper.
    expect(await x.oauth.api().lookupClient(c.clientId)).toBeNull()
  })
})

describe('oauth: round 6 notes', () => {
  test('signInCodes with the store: a code is single use across locations', async () => {
    const person = { kind: 'member', id: 'rina' } as Principal
    for (const withStore of [false, true]) {
      const kv = kvLocations()
      const store = O.durableObjectRefreshStore(fakeNamespace())
      const x = O.signInCodes(kv.x, withStore ? { store } : {})
      const y = O.signInCodes(kv.y, withStore ? { store } : {})
      const code = await x.issue(person, { state: 'st-1' })
      // Location Y has read the code record, so its cache holds it for a minute.
      expect(await kv.y.get(`omazy-oauth:signin:${await sha256Hex(code)}`)).not.toBeNull()
      expect(await x.redeem(code, 'st-1')).toEqual(person)
      // Without the store, Y redeems it a second time from its cache.
      expect(await y.redeem(code, 'st-1')).toEqual(withStore ? null : person)
    }
  })
})

// End to end under workerd: the oauth example Worker is bundled for the
// workerd conditions and served by Miniflare with a real KV namespace, then
// driven as an MCP client would: 401, discovery, a Client ID Metadata
// Document (served by Miniflare's outbound service), consent, sign-in, token,
// a tool call, refresh, and a replayed refresh token.
//
// esbuild and miniflare are devDependencies, so after `npm ci` this file runs
// in every `bun test`: some bugs (how workerd parses a form, for one) do not
// show under Bun. WORKERD_TOOLS=<folder> loads them from <folder>/node_modules
// instead. When neither loads (a checkout without its devDependencies) the
// file is skipped, unless OMAZY_REQUIRE_WORKERD=1, which the release check
// sets so the tests cannot silently stop running there. OMAZY_SKIP_WORKERD=1
// always skips.

import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { join } from 'node:path'

const BASE = 'https://mcp.example'
const CLIENT_ID = 'https://client.example/oauth/client.json'
const REDIRECT = 'http://127.0.0.1:33418/callback'

async function loadTools(): Promise<{ esbuild: any; Miniflare: any } | null> {
  const tools = process.env.WORKERD_TOOLS
/** Each test's limit: a few requests to a running workerd, slow under load. A real hang still fails. */
const REQUEST_TIMEOUT = 30_000
  try {
    if (tools) {
      const esbuild = await import(join(tools, 'node_modules/esbuild/lib/main.js'))
      const { Miniflare } = await import(join(tools, 'node_modules/miniflare/dist/src/index.js'))
      return { esbuild, Miniflare }
    }
    const esbuild = await import('esbuild')
    const { Miniflare } = await import('miniflare')
    return { esbuild, Miniflare }
  } catch (e) {
    if (process.env.OMAZY_REQUIRE_WORKERD === '1') throw new Error(`oauth.workerd.test: esbuild and miniflare are required (OMAZY_REQUIRE_WORKERD=1): ${String(e)}`)
    return null
  }
}

const loaded = process.env.OMAZY_SKIP_WORKERD === '1' ? null : await loadTools()
const run = loaded ? describe : describe.skip
/** Each test's limit: a few requests to a running workerd, slow under load. A real hang still fails. */
const REQUEST_TIMEOUT = 30_000

run('oauth: end to end under workerd', () => {
  let mf: { dispatchFetch(url: string, init?: RequestInit): Promise<Response>; dispose(): Promise<void> }
  let script = ''

  beforeAll(async () => {
    const { esbuild, Miniflare } = loaded!
    const out = await esbuild.build({
      entryPoints: [join(import.meta.dir, '../examples/oauth-worker.ts')],
      bundle: true,
      write: false,
      format: 'esm',
      minify: true,
      platform: 'neutral',
      conditions: ['workerd', 'worker', 'browser'],
      mainFields: ['module', 'main'],
      target: 'es2022',
      external: ['cloudflare:workers'],
    })
    script = out.outputFiles[0].text as string
    // The client's metadata document, wherever the Worker fetches it from.
    const outboundService = (req: Request) =>
      new URL(req.url).href === CLIENT_ID
        ? new Response(JSON.stringify({ client_id: CLIENT_ID, client_name: 'E2E', redirect_uris: [REDIRECT], token_endpoint_auth_method: 'none' }), { headers: { 'content-type': 'application/json' } })
        : new Response('not found', { status: 404 })
    mf = new Miniflare({
      modules: true,
      script,
      compatibilityDate: '2026-07-01',
      compatibilityFlags: ['global_fetch_strictly_public'],
      kvNamespaces: ['OAUTH_KV'],
      bindings: { ISSUER: BASE },
      outboundService,
    })
    // Wait for workerd to be up here, inside the start-up allowance, so a slow
    // start under load is not charged to the first test.
    await mf.ready
  }, 60_000)
  afterAll(async () => mf?.dispose())

  const cookies = new Map<string, string>()
  const go = async (url: string, init: RequestInit = {}) => {
    // A plain object: Miniflare under Bun drops a Bun Headers instance's entries.
    const headers: Record<string, string> = { ...((init.headers as Record<string, string>) ?? {}) }
    if (cookies.size) headers.cookie = [...cookies].map(([k, v]) => `${k}=${v}`).join('; ')
    // Under Bun the Worker sees Miniflare's own address; the example reads every request against ISSUER.
    const res = await mf.dispatchFetch(url, { ...init, headers, redirect: 'manual' })
    for (const c of res.headers.getSetCookie()) {
      const [pair] = c.split(';')
      const i = pair!.indexOf('=')
      if (/max-age=0/i.test(c)) cookies.delete(pair!.slice(0, i))
      else cookies.set(pair!.slice(0, i), pair!.slice(i + 1))
    }
    return res
  }
  const b64url = (b: Uint8Array) => btoa(String.fromCharCode(...b)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
  const form = (data: Record<string, string>) => ({ method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(data).toString() })
  const mcp = (token: string) =>
    go(`${BASE}/org`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', accept: 'application/json, text/event-stream', 'mcp-protocol-version': '2025-06-18' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'notes_list', arguments: {} } }),
    })

  /** The example's sign-in page, then one click: its form posts the code to the kit's callback. */
  async function signIn(url: string) {
    const page = await go(url)
    expect(page.status).toBe(200)
    const html = await page.text()
    const unesc = (v: string) => v.replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)))
    const action = unesc(/<form method="post" action="([^"]+)"/.exec(html)![1]!)
    const field = (name: string) => unesc(new RegExp(`name="${name}" value="([^"]+)"`).exec(html)![1]!)
    return go(action, form({ state: field('state'), code: field('code') }))
  }

  test('the bundle has no code generation', () => {
    expect(script.length).toBeGreaterThan(0)
    expect(script.includes('new Function(')).toBe(false)
  })

  test('a client connects from a 401 to a tool call, then a replayed refresh revokes it', async () => {
    const challenge401 = await go(`${BASE}/org`, { method: 'POST', body: '{}' })
    expect(challenge401.status).toBe(401)
    const prm = /resource_metadata="([^"]+)"/.exec(challenge401.headers.get('www-authenticate')!)![1]!
    const md = (await (await go(prm)).json()) as any
    expect(md.resource).toBe(`${BASE}/org`)
    const as = (await (await go(`${md.authorization_servers[0]}/.well-known/oauth-authorization-server`)).json()) as any
    expect(as.code_challenge_methods_supported).toEqual(['S256'])

    // Registration is off in the example; the client brings a metadata document instead.
    expect(as.registration_endpoint).toBeUndefined()
    const redirect = REDIRECT
    const reg = { client_id: CLIENT_ID }

    const verifier = b64url(crypto.getRandomValues(new Uint8Array(32)))
    const challenge = b64url(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier))))
    const auth = new URL(as.authorization_endpoint)
    for (const [k, v] of Object.entries({ response_type: 'code', client_id: reg.client_id, redirect_uri: redirect, state: 's', code_challenge: challenge, code_challenge_method: 'S256', resource: md.resource }))
      auth.searchParams.set(k, v)
    const page = await go(auth.toString())
    expect(page.status).toBe(200)
    expect(page.headers.get('content-security-policy')).toContain("frame-ancestors 'none'")
    const html = await page.clone().text()
    expect(html).toContain('verified by its metadata document')
    const handle = (/name="handle" value="([^"]+)"/.exec(await page.text())![1]!).replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)))
    const toSignIn = await go(as.authorization_endpoint, form({ handle, decision: 'approve' }))
    expect(toSignIn.status).toBe(302)
    const back = await signIn(toSignIn.headers.get('location')!)
    const toClient = new URL(back.headers.get('location')!)
    expect(toClient.searchParams.get('iss')).toBe(BASE)
    const code = toClient.searchParams.get('code')!

    const tok = (await (await go(as.token_endpoint, form({ grant_type: 'authorization_code', code, redirect_uri: redirect, client_id: reg.client_id, code_verifier: verifier, resource: md.resource }))).json()) as any
    expect(tok.expires_in).toBe(3600)
    const call = (await (await mcp(tok.access_token)).json()) as any
    expect(call.result.isError).toBe(false)

    const r1 = (await (await go(as.token_endpoint, form({ grant_type: 'refresh_token', refresh_token: tok.refresh_token, client_id: reg.client_id }))).json()) as any
    expect(r1.access_token).toBeTruthy()
    const replay = await go(as.token_endpoint, form({ grant_type: 'refresh_token', refresh_token: tok.refresh_token, client_id: reg.client_id }))
    expect(replay.status).toBe(400)
    expect((await mcp(r1.access_token)).status).toBe(401)
  }, REQUEST_TIMEOUT)

  /** A client connected through the whole flow, as the first test does. */
  async function connect() {
    const verifier = b64url(crypto.getRandomValues(new Uint8Array(32)))
    const challenge = b64url(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier))))
    const auth = new URL(`${BASE}/authorize`)
    for (const [k, v] of Object.entries({ response_type: 'code', client_id: CLIENT_ID, redirect_uri: REDIRECT, state: 's', code_challenge: challenge, code_challenge_method: 'S256', resource: `${BASE}/org` }))
      auth.searchParams.set(k, v)
    const page = await go(auth.toString())
    expect(page.status).toBe(200)
    const handle = (/name="handle" value="([^"]+)"/.exec(await page.text())![1]!).replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)))
    const toSignIn = await go(`${BASE}/authorize`, form({ handle, decision: 'approve' }))
    const back = await signIn(toSignIn.headers.get('location')!)
    const code = new URL(back.headers.get('location')!).searchParams.get('code')!
    return (await (await go(`${BASE}/oauth/token`, form({ grant_type: 'authorization_code', code, redirect_uri: REDIRECT, client_id: CLIENT_ID, code_verifier: verifier, resource: `${BASE}/org` }))).json()) as any
  }
  const raw = (body: string) => go(`${BASE}/oauth/token`, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body })

  // Re-review H1. workerd's formData() drops a % that starts no escape; the kit read the raw text, so it
  // checked "R1%" (never marked) or skipped the check for grant_type "refresh_token%", while the
  // library refreshed with R1. The attacker's replay passed and the real client was locked out.
  for (const [name, mangle] of [
    ['a trailing % on the refresh token', (rt: string) => `grant_type=refresh_token&refresh_token=${encodeURIComponent(rt)}%`],
    ['a trailing % on grant_type', (rt: string) => `grant_type=refresh_token%&refresh_token=${encodeURIComponent(rt)}`],
  ] as const)
    test(`a rotated refresh token replayed with ${name} is refused; the real client keeps its grant`, async () => {
      const tok = await connect()
      const r1 = (await (await go(`${BASE}/oauth/token`, form({ grant_type: 'refresh_token', refresh_token: tok.refresh_token, client_id: CLIENT_ID }))).json()) as any
      expect(r1.refresh_token).toBeTruthy()
      const replay = await raw(`${mangle(tok.refresh_token)}&client_id=${encodeURIComponent(CLIENT_ID)}`)
      expect(replay.status).toBe(400)
      expect(((await replay.json()) as any).error).toBe('invalid_request')
      const real = await go(`${BASE}/oauth/token`, form({ grant_type: 'refresh_token', refresh_token: r1.refresh_token, client_id: CLIENT_ID }))
      expect(real.status).toBe(200)
      // The plain replay is still caught, and revokes the family.
      expect((await raw(`grant_type=refresh_token&refresh_token=${encodeURIComponent(tok.refresh_token)}&client_id=${encodeURIComponent(CLIENT_ID)}`)).status).toBe(400)
      expect((await mcp(((await real.json()) as any).access_token)).status).toBe(401)
    }, REQUEST_TIMEOUT)

  // Round 5 L2 (the reviewer's F2 under workerd): a revocation with an Authorization header that is
  // not Basic went to the library with no tombstone, since the kit read the header as naming no client.
  test('a client revoking its refresh token with a Bearer header tombstones the grant', async () => {
    const kv = await (mf as unknown as { getKVNamespace(name: string): Promise<{ get(key: string): Promise<string | null> }> }).getKVNamespace('OAUTH_KV')
    const revoke = async (headers: Record<string, string>) => {
      const tok = await connect()
      const [user, grant] = tok.refresh_token.split(':')
      const res = await go(`${BASE}/oauth/token`, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded', ...headers },
        body: new URLSearchParams({ token: tok.refresh_token, token_type_hint: 'refresh_token', client_id: CLIENT_ID }).toString(),
      })
      return { status: res.status, tombstone: await kv.get(`omazy-oauth:gt:${grant}`), grant: await kv.get(`grant:${user}:${grant}`) }
    }
    for (const headers of [{}, { authorization: `Bearer anything` }, { authorization: 'bearer\tanything' }]) {
      const r = await revoke(headers)
      expect(r.status).toBe(200)
      expect(r.grant).toBeNull()
      expect(r.tombstone).not.toBeNull()
    }
  }, REQUEST_TIMEOUT)
})

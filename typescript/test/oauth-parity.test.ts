// The kit and the library must name the same client for every token request.
// Three bypasses came from the two reading a request differently (the body
// parser, then the Authorization header), so this runs a table of awkward
// requests through the kit's `tokenRequestClient` and through the library
// itself, under Bun and under workerd, and fails on any difference. Each row
// also says what both should name, so a change in either shows here.
//
// The workerd half bundles test/oauth-parity-worker.ts for Miniflare, as
// oauth.workerd.test.ts does: it runs after `npm ci`, skips without esbuild
// and miniflare unless OMAZY_REQUIRE_WORKERD=1, and OMAZY_SKIP_WORKERD=1
// skips it.

import { describe, expect, mock, test } from 'bun:test'
import { join } from 'node:path'

mock.module('cloudflare:workers', () => ({ WorkerEntrypoint: class {} }))

import type { ParityCase, ParityResult } from './oauth-parity-worker'

const q = (o: Record<string, string>) => new URLSearchParams(o).toString()
const code = { grant_type: 'authorization_code', code: 'rina:grant0000000001:secret', code_verifier: 'v'.repeat(43) }
const basic = (creds: string) => `Basic ${btoa(creds)}`
const b64url = (s: string) => btoa(String.fromCharCode(...new TextEncoder().encode(s))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
const jwt = (claims: unknown, sig = 'c2ln') => `${b64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }))}.${b64url(JSON.stringify(claims))}.${sig}`
const JWT_TYPE = 'urn:ietf:params:oauth:client-assertion-type:jwt-bearer'
const assertion = (a: string, extra: Record<string, string> = {}) => q({ ...code, client_assertion: a, client_assertion_type: JWT_TYPE, ...extra })

/** A request, and the client both should name: a string, null for none, or undefined where it rests on the runtime's `atob`. */
type Row = ParityCase & { want: string | null | undefined }

const A = 'client-a'
const B = 'client-b'
const C = 'client-c'

const ROWS: Row[] = [
  // Not Basic: ignored, the client comes from the body.
  { name: 'no Authorization header', body: q({ ...code, client_id: A }), want: A },
  { name: 'Bearer', authorization: 'Bearer some-token', body: q({ ...code, client_id: A }), want: A },
  { name: 'bearer in lower case', authorization: 'bearer some-token', body: q({ ...code, client_id: A }), want: A },
  { name: 'Bearer and a tab', authorization: 'Bearer\tsome-token', body: q({ ...code, client_id: A }), want: A },
  { name: 'Bearer alone', authorization: 'Bearer', body: q({ ...code, client_id: A }), want: A },
  { name: 'DPoP', authorization: 'DPoP proof', body: q({ ...code, client_id: A }), want: A },
  { name: 'Bearer carrying Basic credentials', authorization: `Bearer ${basic(`${B}:s`)}`, body: q({ ...code, client_id: A }), want: A },
  { name: 'Basicx, not Basic', authorization: `Basicx ${btoa(`${B}:s`)}`, body: q({ ...code, client_id: A }), want: A },
  { name: 'Basic followed by a comma', authorization: `Basic,${btoa(`${B}:s`)}`, body: q({ ...code, client_id: A }), want: A },
  { name: 'refresh with Bearer', authorization: 'Bearer x', body: q({ grant_type: 'refresh_token', refresh_token: 'u:g:s', client_id: A }), want: A },
  { name: 'revocation with Bearer', authorization: 'Bearer x', body: q({ token: 'u:g:s', client_id: A }), want: A },
  // Basic, however it is spelled and spaced.
  { name: 'Basic', authorization: basic(`${A}:s`), body: q(code), want: A },
  { name: 'Basic in mixed case', authorization: `bAsIc ${btoa(`${A}:s`)}`, body: q(code), want: A },
  { name: 'Basic in capitals', authorization: `BASIC ${btoa(`${A}:s`)}`, body: q(code), want: A },
  { name: 'Basic and two spaces', authorization: `Basic  ${btoa(`${A}:s`)}`, body: q(code), want: A },
  { name: 'Basic and a tab', authorization: `Basic\t${btoa(`${A}:s`)}`, body: q(code), want: A },
  { name: 'Basic, tabs and spaces', authorization: `Basic\t \t${btoa(`${A}:s`)}`, body: q(code), want: A },
  { name: 'Basic and trailing spaces', authorization: `Basic ${btoa(`${A}:s`)}   `, body: q(code), want: A },
  { name: 'Basic after leading spaces', authorization: `  Basic ${btoa(`${A}:s`)}`, body: q(code), want: A },
  { name: 'Basic, form-encoded user name', authorization: basic('client%20a+b:s'), body: q(code), want: 'client a b' },
  { name: 'Basic without padding', authorization: `Basic ${btoa('AB:s').replace(/=+$/, '')}`, body: q(code), want: undefined },
  // Basic the library refuses: no client.
  { name: 'Basic alone', authorization: 'Basic', body: q({ ...code, client_id: A }), want: null },
  { name: 'Basic and spaces only', authorization: 'Basic   ', body: q({ ...code, client_id: A }), want: null },
  { name: 'Basic with bad base64', authorization: 'Basic !!!not-base64', body: q(code), want: null },
  { name: 'Basic with bad base64 and a client_id', authorization: 'Basic !!!', body: q({ ...code, client_id: A }), want: null },
  { name: 'Basic then a second word', authorization: `Basic ${btoa(`${A}:s`)} extra`, body: q(code), want: null },
  { name: 'Basic without a colon', authorization: basic(A), body: q(code), want: null },
  { name: 'Basic with an empty user name', authorization: basic(':s'), body: q(code), want: null },
  { name: 'Basic with a bad escape in the user name', authorization: basic('a%ZZ:s'), body: q(code), want: null },
  { name: 'Basic with a bad escape in the secret', authorization: basic(`${A}:%ZZ`), body: q(code), want: null },
  { name: 'Basic and a client_id', authorization: basic(`${A}:s`), body: q({ ...code, client_id: A }), want: null },
  { name: 'Basic and another client_id', authorization: basic(`${A}:s`), body: q({ ...code, client_id: B }), want: null },
  { name: 'Basic and a client_secret', authorization: basic(`${A}:s`), body: q({ ...code, client_secret: 's' }), want: null },
  { name: 'Basic and a client assertion', authorization: basic(`${A}:s`), body: assertion(jwt({ iss: C })), want: null },
  { name: 'Basic and an empty client_id', authorization: basic(`${A}:s`), body: `${q(code)}&client_id=`, want: A },
  // The body.
  { name: 'client_id twice', body: `${q(code)}&client_id=${A}&client_id=${B}`, want: null },
  { name: 'client_id twice, same value', body: `${q(code)}&client_id=${A}&client_id=${A}`, want: null },
  { name: 'client_id twice with Bearer', authorization: 'Bearer x', body: `${q(code)}&client_id=${A}&client_id=${B}`, want: null },
  { name: 'client_id empty, then set', body: `${q(code)}&client_id=&client_id=${A}`, want: A },
  { name: 'client_id empty', body: `${q(code)}&client_id=`, want: null },
  { name: 'no client at all', body: q(code), want: null },
  { name: 'client_secret alone', body: q({ ...code, client_secret: 's' }), want: null },
  { name: 'client_id with an escaped plus', body: `${q(code)}&client_id=a%2Bb`, want: 'a+b' },
  { name: 'client_id with a plus', body: `${q(code)}&client_id=a+b`, want: 'a b' },
  // Client assertions: client_id, else the issuer, read without checking the signature.
  { name: 'assertion, issuer', body: assertion(jwt({ iss: C })), want: C },
  { name: 'assertion and client_id', body: assertion(jwt({ iss: C }), { client_id: A }), want: A },
  { name: 'assertion with Bearer', authorization: 'Bearer x', body: assertion(jwt({ iss: C })), want: C },
  { name: 'assertion, UTF-8 issuer needing padding', body: assertion(jwt({ iss: 'clïent-ü' })), want: 'clïent-ü' },
  { name: 'assertion without its type', body: q({ ...code, client_assertion: jwt({ iss: C }) }), want: null },
  { name: 'assertion type without the assertion', body: q({ ...code, client_assertion_type: JWT_TYPE, client_id: A }), want: null },
  { name: 'assertion and a client_secret', body: assertion(jwt({ iss: C }), { client_secret: 's' }), want: null },
  { name: 'assertion, issuer not a string', body: assertion(jwt({ iss: 7 })), want: null },
  { name: 'assertion, empty issuer', body: assertion(jwt({ iss: '' })), want: null },
  { name: 'assertion, claims an array', body: assertion(`${b64url('{}')}.${b64url('["x"]')}.c2ln`), want: null },
  { name: 'assertion in two parts', body: assertion(`${b64url('{}')}.${b64url(JSON.stringify({ iss: C }))}`), want: null },
  { name: 'assertion with a bad signature part', body: assertion(jwt({ iss: C }, '!!!')), want: null },
  { name: 'assertion over 16 KB', body: assertion(jwt({ iss: C, pad: 'x'.repeat(16 * 1024) })), want: null },
]

function check(results: ParityResult[]) {
  expect(results.map((r) => r.name)).toEqual(ROWS.map((r) => r.name))
  for (const [i, r] of results.entries()) {
    const row = ROWS[i]!
    // One line per row, so a failure names the request.
    expect({ name: r.name, kit: r.kit }).toEqual({ name: row.name, kit: r.library })
    expect(r.lookups).toBeLessThanOrEqual(1)
    if (row.want !== undefined) expect({ name: r.name, named: r.kit }).toEqual({ name: row.name, named: row.want })
  }
}

describe('oauth: the kit names the client the library names', () => {
  test('under Bun', async () => {
    const { parity } = await import('./oauth-parity-worker')
    check(await parity(ROWS))
  })
})

async function loadTools(): Promise<{ esbuild: any; Miniflare: any } | null> {
  try {
    const tools = process.env.WORKERD_TOOLS
    if (tools) {
      const esbuild = await import(join(tools, 'node_modules/esbuild/lib/main.js'))
      const { Miniflare } = await import(join(tools, 'node_modules/miniflare/dist/src/index.js'))
      return { esbuild, Miniflare }
    }
    const esbuild = await import('esbuild')
    const { Miniflare } = await import('miniflare')
    return { esbuild, Miniflare }
  } catch (e) {
    if (process.env.OMAZY_REQUIRE_WORKERD === '1') throw new Error(`oauth-parity.test: esbuild and miniflare are required (OMAZY_REQUIRE_WORKERD=1): ${String(e)}`)
    return null
  }
}

const loaded = process.env.OMAZY_SKIP_WORKERD === '1' ? null : await loadTools()
const run = loaded ? describe : describe.skip

run('oauth: the kit names the client the library names, under workerd', () => {
  test(
    'under workerd',
    async () => {
      const { esbuild, Miniflare } = loaded!
      const out = await esbuild.build({
        entryPoints: [join(import.meta.dir, 'oauth-parity-worker.ts')],
        bundle: true,
        write: false,
        format: 'esm',
        platform: 'neutral',
        conditions: ['workerd', 'worker', 'browser'],
        mainFields: ['module', 'main'],
        target: 'es2022',
        external: ['cloudflare:workers'],
      })
      const mf = new Miniflare({ modules: true, script: out.outputFiles[0].text, compatibilityDate: '2026-07-01', compatibilityFlags: ['global_fetch_strictly_public'] })
      try {
        await mf.ready
        const res = await mf.dispatchFetch('https://as.example/', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(ROWS.map(({ want: _, ...c }) => c)) })
        expect(res.status).toBe(200)
        check((await res.json()) as ParityResult[])
      } finally {
        await mf.dispose()
      }
    },
    60_000,
  )
})

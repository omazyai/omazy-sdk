// The differential check behind oauth-parity.test.ts: each request goes
// through the kit's reading of a token request (`tokenForm`, then
// `tokenRequestClient`) and through the library itself, and both answers come
// back. The library's answer is the client it looks up: with metadata
// documents off it reads every client from KV as `client:<id>`, so a KV that
// records those reads shows which client it named, or that it refused the
// request before naming one. Imported by the test under Bun, and bundled
// and served by Miniflare to run the same code under workerd.

import { OAuthAuthorizationServer } from '@cloudflare/workers-oauth-provider'
import { type KvLike, memoryKv } from '../src/oauth/kv'
import { tokenForm, tokenRequestClient } from '../src/oauth/token-request'

export interface ParityCase {
  name: string
  authorization?: string
  /** The raw application/x-www-form-urlencoded body. */
  body: string
}

export interface ParityResult {
  name: string
  /** The client the kit names; null when it names none or refuses the request. */
  kit: string | null
  /** The client the library looked up; null when it looked up none. */
  library: string | null
  /** How many clients the library looked up: never more than one. */
  lookups: number
}

const ISSUER = 'https://as.example'

export async function parity(cases: readonly ParityCase[]): Promise<ParityResult[]> {
  const out: ParityResult[] = []
  for (const c of cases) {
    const request = () =>
      new Request(`${ISSUER}/oauth/token`, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded', ...(c.authorization !== undefined ? { authorization: c.authorization } : {}) },
        body: c.body,
      })
    const req = request()
    const form = await tokenForm(req)
    const kit = form instanceof Response ? null : tokenRequestClient(req.headers.get('authorization'), form)

    const looked: string[] = []
    const kv = memoryKv()
    const recording: KvLike = {
      get: (key, options) => {
        if (key.startsWith('client:')) looked.push(key.slice('client:'.length))
        return kv.get(key, options)
      },
      put: (key, value, options) => kv.put(key, value, options),
      delete: (key) => kv.delete(key),
      list: (options) => kv.list(options),
    }
    const lib = new OAuthAuthorizationServer<{ OAUTH_KV: KvLike }>({
      issuer: ISSUER,
      resources: [`${ISSUER}/org`],
      authorizeEndpoint: `${ISSUER}/authorize`,
      tokenEndpoint: `${ISSUER}/oauth/token`,
      scopesSupported: ['mcp'],
      clientIdMetadataDocumentEnabled: false,
      // Refusals are the point here; the library would log each one.
      onError: () => {},
    })
    await lib.fetch(request(), { OAUTH_KV: recording }, { waitUntil() {}, passThroughOnException() {}, props: {} } as never)
    out.push({ name: c.name, kit, library: looked[0] ?? null, lookups: looked.length })
  }
  return out
}

export default {
  async fetch(req: Request): Promise<Response> {
    if (req.method !== 'POST') return new Response('POST a JSON list of cases', { status: 405 })
    return Response.json(await parity((await req.json()) as ParityCase[]))
  },
}

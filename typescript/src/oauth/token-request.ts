// How the kit reads a token endpoint request: its form and the client it
// names. Every decision the kit takes before handing a request to the
// library (is this the grant's own client, may it be locked, recorded or
// tombstoned) rests on reading the request the way the library reads it.
// Where the two readings differed, the library acted on a request the kit
// had judged as something else: the body parser first, then the
// Authorization header. So this file copies the library's code rather than
// approximating it. The library is pinned at 1.3.0 and exports none of it;
// the source lines are `parseTokenEndpointRequest`,
// `parseBasicAuthorizationHeader`, `decodeFormUrlEncodedComponent`,
// `readClientAssertionIssuer` and `parseIdJag` in its `dist/oauth-provider.js`.
// `oauth-parity.test.ts` runs a table of requests through this file and the
// library, under Bun and under workerd, and fails on any difference.

const json = (body: unknown, status: number) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', 'cache-control': 'no-store' } })

const tokenError = (description: string) => json({ error: 'invalid_request', error_description: description }, 400)

/** Parameters the library reads with empty values dropped (RFC 6749 client authentication). */
export const CLIENT_AUTH_PARAMS: ReadonlySet<string> = new Set(['client_id', 'client_secret', 'client_assertion', 'client_assertion_type'])

/** A `%` not followed by two hex digits. Parsers disagree on it (one keeps it, workerd drops it), so the kit refuses it. */
const STRAY_PERCENT = /%(?![0-9A-Fa-f]{2})/

/**
 * The token endpoint's form, read with the parser the library uses
 * (`request.formData()`) and folded the way it folds it: the media type split
 * on `;`, trimmed and lower-cased, empty client authentication values
 * dropped, and any parameter but `resource` present once. A body with a
 * malformed percent escape is refused before either reads it, and so is any
 * body the kit cannot read, so the library never sees a request the kit did
 * not check.
 */
export async function tokenForm(req: Request): Promise<Map<string, string> | Response> {
  const type = (req.headers.get('content-type') ?? '').split(';')[0]!.trim().toLowerCase()
  if (type !== 'application/x-www-form-urlencoded') return tokenError('Content-Type must be application/x-www-form-urlencoded')
  let fd: FormData
  try {
    if (STRAY_PERCENT.test(await req.clone().text())) return tokenError('Request body has a malformed percent escape')
    fd = await req.clone().formData()
  } catch {
    return tokenError('Request body must be valid application/x-www-form-urlencoded data')
  }
  const body = new Map<string, string>()
  for (const key of new Set(fd.keys())) {
    const all = fd.getAll(key).filter((v) => !CLIENT_AUTH_PARAMS.has(key) || v !== '')
    if (all.length === 0) continue
    if (key !== 'resource' && all.length > 1) return tokenError(`Request parameter "${key}" must not be repeated`)
    if (all.some((v) => typeof v !== 'string')) return tokenError('Request body must be valid application/x-www-form-urlencoded data')
    body.set(key, all[0] as string)
  }
  return body
}

/** The Authorization header as the library reads it for client authentication. */
export type BasicAuthorization = { kind: 'not-basic' } | { kind: 'malformed' } | { kind: 'credentials'; clientId: string; clientSecret: string }

/**
 * The library's `parseBasicAuthorizationHeader`, line for line. The scheme is
 * the text up to the first space or tab, compared without case. Any other
 * scheme (Bearer, Digest, anything) is not Basic and is ignored, and the
 * client is then read from the body.
 */
export function parseBasicAuthorization(header: string | null): BasicAuthorization {
  if (!header) return { kind: 'not-basic' }
  const schemeEnd = header.search(/[ \t]/)
  if ((schemeEnd === -1 ? header : header.slice(0, schemeEnd)).toLowerCase() !== 'basic') return { kind: 'not-basic' }
  if (schemeEnd === -1) return { kind: 'malformed' }
  const encoded = header.slice(schemeEnd).trim()
  if (!encoded || /[ \t]/.test(encoded)) return { kind: 'malformed' }
  try {
    const credentials = atob(encoded)
    const i = credentials.indexOf(':')
    if (i === -1) return { kind: 'malformed' }
    return { kind: 'credentials', clientId: formDecode(credentials.slice(0, i)), clientSecret: formDecode(credentials.slice(i + 1)) }
  } catch {
    return { kind: 'malformed' }
  }
}

/** The library's `decodeFormUrlEncodedComponent`. Throws on a malformed escape, which the caller reads as malformed. */
const formDecode = (v: string): string => decodeURIComponent(v.replace(/\+/g, ' '))

/** The library's limit on a client assertion (`CLIENT_ASSERTION_MAX_BYTES`), compared to its length in UTF-16 units as the library does. */
const CLIENT_ASSERTION_MAX = 16 * 1024

/** The library's `base64UrlToBytes`: padded, then `atob`. */
function base64UrlBytes(s: string): Uint8Array {
  const b64 = s.replace(/-/g, '+').replace(/_/g, '/')
  const bin = atob(b64.padEnd(b64.length + ((4 - (b64.length % 4)) % 4), '='))
  const out = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i)
  return out
}

/** The library's `parseJwtJsonPart`: UTF-8 JSON that is an object and not an array. */
function jwtPart(s: string): Record<string, unknown> {
  const v = JSON.parse(new TextDecoder().decode(base64UrlBytes(s))) as unknown
  if (typeof v !== 'object' || v === null || Array.isArray(v)) throw new Error('JWT part must be an object')
  return v as Record<string, unknown>
}

/**
 * The library's `readClientAssertionIssuer` over `parseIdJag`: the `iss` of
 * a well-formed three-part JWT within the size limit, without checking its
 * signature, or undefined.
 */
function assertionIssuer(assertion: string | undefined): string | undefined {
  if (typeof assertion !== 'string' || assertion.length === 0 || assertion.length > CLIENT_ASSERTION_MAX) return undefined
  const parts = assertion.split('.')
  if (parts.length !== 3 || parts.some((p) => p.length === 0)) return undefined
  let claims: Record<string, unknown>
  try {
    jwtPart(parts[0]!)
    claims = jwtPart(parts[1]!)
    base64UrlBytes(parts[2]!)
  } catch {
    return undefined
  }
  const iss = claims.iss
  return typeof iss === 'string' && iss.length > 0 ? iss : undefined
}

/**
 * The client a token request names, exactly as the library names it before
 * it looks the client up (`parseTokenEndpointRequest` in 1.3.0):
 *
 * - Basic credentials, when the Authorization header's scheme is Basic: the
 *   decoded user name. Basic beside any client parameter in the body, or
 *   Basic the library cannot decode, names no client (the library refuses it).
 * - Otherwise a client assertion, when `client_assertion` or
 *   `client_assertion_type` is sent: `client_id`, else the assertion's
 *   issuer. With `client_secret` beside it, or one of the pair missing, no
 *   client.
 * - Otherwise `client_id`.
 *
 * Null when the library would refuse the request before looking a client
 * up. `form` is what `tokenForm` read, which is what the library reads.
 * The kit has no other way to tell which client a token request is from.
 */
export function tokenRequestClient(authorization: string | null, form: ReadonlyMap<string, string>): string | null {
  const basic = parseBasicAuthorization(authorization)
  const sent = (k: string) => form.has(k)
  const assertion = sent('client_assertion') || sent('client_assertion_type')
  if (basic.kind !== 'not-basic') {
    if (sent('client_id') || sent('client_secret') || assertion) return null
    if (basic.kind === 'malformed') return null
    return basic.clientId || null
  }
  if (assertion) {
    if (sent('client_secret')) return null
    if (!sent('client_assertion') || !sent('client_assertion_type')) return null
    return form.get('client_id') || assertionIssuer(form.get('client_assertion')) || null
  }
  return form.get('client_id') || null
}

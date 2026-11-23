// One-time sign-in codes for the hand-off from the product's sign-in page to
// the authorization server. The product's sign-in issues a code for the
// person it signed in and for the `state` it was opened with, and sends the
// browser back with both; the authorization server redeems the code over the
// back channel in `authenticate`, with the state the callback carried. A code
// issued for one flow is refused in any other, so a leaked code cannot finish
// someone else's flow. A product whose sign-in runs elsewhere keeps its own
// codes and must bind them to the state the same way; this helper is for a
// product whose sign-in can reach the same KV namespace (or wraps it in an
// endpoint).

import type { Principal } from '../capabilities/capability.js'
import { b64url, sha256Hex } from '../guard/crypto.js'
import { KV_MIN_TTL, KV_PREFIX, type KvLike } from './kv.js'

export interface SignInCodes {
  /**
   * A code good once, for `ttlSeconds`, and only in the flow whose `state`
   * the sign-in page was opened with. Only hashes are stored.
   */
  issue(person: Principal, bind: { state: string }): Promise<string>
  /**
   * The person, once, when `state` is the one the code was issued for. A
   * second redeem, an unknown or expired code, or another flow's state gives
   * null. Any redeem spends the code.
   */
  redeem(code: string, state: string): Promise<Principal | null>
}

interface CodeRecord {
  person: Principal
  state: string
  expiresAt: number
}

const okState = (s: unknown): s is string => typeof s === 'string' && s.length > 0 && s.length <= 512

export function signInCodes(kv: KvLike, opts: { ttlSeconds?: number } = {}): SignInCodes {
  const ttl = Math.max(KV_MIN_TTL, opts.ttlSeconds ?? 120)
  const key = async (code: string) => `${KV_PREFIX}signin:${await sha256Hex(code)}`
  return {
    async issue(person, bind) {
      if (!okState(bind?.state)) throw new Error('oauth: a sign-in code is issued for the state the sign-in page was opened with')
      const code = b64url(crypto.getRandomValues(new Uint8Array(32)))
      const rec: CodeRecord = { person, state: await sha256Hex(bind.state), expiresAt: Date.now() + ttl * 1000 }
      await kv.put(await key(code), JSON.stringify(rec), { expirationTtl: ttl })
      return code
    },
    async redeem(code, state) {
      if (typeof code !== 'string' || code.length < 20 || code.length > 100 || !okState(state)) return null
      const k = await key(code)
      const rec = (await kv.get(k, { type: 'json' })) as CodeRecord | null
      if (!rec) return null
      // KV cannot make get-then-delete atomic. A racing second use would also
      // need this flow's state, which is bound to one browser by its cookie.
      await kv.delete(k)
      if (rec.expiresAt <= Date.now() || typeof rec.state !== 'string') return null
      return rec.state === (await sha256Hex(state)) ? rec.person : null
    },
  }
}

// Confirm tokens for R2. An HMAC over the seat, the tool, the hash of the
// canonical arguments, the target's state version and a nonce. The nonce is
// stored with a 10 minute expiry and taken on use, so a token works once.
//
// Over MCP the token goes back to the client, which can send it again: this
// protects against drift between the preview and the change, not against a
// model acting without a person. Nothing outward facing belongs at R2.

import { b64url, fromB64url, type Keyring, randomToken } from './crypto.js'
import type { GuardStore } from './types.js'

export const CONFIRM_TTL_MS = 10 * 60 * 1000

export interface ConfirmClaims {
  /** The seat id, or `principal:<id>` for a call without a seat. */
  seat: string
  tool: string
  argsHash: string
  stateVersion: string
  nonce: string
  /** Epoch ms. */
  expiresAt: number
}

export async function mintConfirmToken(
  keys: Keyring,
  store: GuardStore,
  claims: Omit<ConfirmClaims, 'nonce' | 'expiresAt'>,
  now: number,
  ttlMs = CONFIRM_TTL_MS,
): Promise<{ token: string; expiresAt: number }> {
  const full: ConfirmClaims = { ...claims, nonce: randomToken(16), expiresAt: now + ttlMs }
  await store.putNonce(full.nonce, full.expiresAt)
  const body = b64url(new TextEncoder().encode(JSON.stringify({ v: 1, s: full.seat, t: full.tool, a: full.argsHash, sv: full.stateVersion, n: full.nonce, e: full.expiresAt })))
  return { token: `${body}.${await keys.sign(body)}`, expiresAt: full.expiresAt }
}

export type ConfirmCheck = { ok: true; claims: ConfirmClaims } | { ok: false; code: 'confirm_bad' | 'confirm_expired' | 'confirm_mismatch' }

/**
 * Checks the signature, expiry and binding to this seat, tool and arguments.
 * Does not take the nonce: the caller does that once the state is checked.
 */
export async function readConfirmToken(
  keys: Keyring,
  token: string,
  expect: { seat: string; tool: string; argsHash: string },
  now: number,
): Promise<ConfirmCheck> {
  const [body, sig, extra] = token.split('.')
  if (!body || !sig || extra !== undefined || !(await keys.verify(body, sig))) return { ok: false, code: 'confirm_bad' }
  let p: { v?: number; s?: string; t?: string; a?: string; sv?: string; n?: string; e?: number }
  try {
    p = JSON.parse(new TextDecoder().decode(fromB64url(body)))
  } catch {
    return { ok: false, code: 'confirm_bad' }
  }
  if (p.v !== 1 || typeof p.n !== 'string' || typeof p.e !== 'number') return { ok: false, code: 'confirm_bad' }
  if (p.e <= now) return { ok: false, code: 'confirm_expired' }
  if (p.s !== expect.seat || p.t !== expect.tool || p.a !== expect.argsHash) return { ok: false, code: 'confirm_mismatch' }
  return { ok: true, claims: { seat: p.s, tool: p.t, argsHash: p.a, stateVersion: p.sv ?? '', nonce: p.n, expiresAt: p.e } }
}

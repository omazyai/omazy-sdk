// Canonical arguments, hashes, HMAC tokens and sealed arguments, on WebCrypto
// only. Keys are derived from the product's secret with HKDF, one per use, so
// a confirm token's key never seals arguments and the other way round.

const enc = new TextEncoder()
const dec = new TextDecoder()

/**
 * JSON with object keys sorted at every depth, so the same arguments always
 * hash the same. `undefined` fields are dropped, as JSON.stringify does.
 */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(sortKeys(value)) ?? 'null'
}

function sortKeys(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(sortKeys)
  if (v && typeof v === 'object' && (v as object).constructor === Object) {
    const out: Record<string, unknown> = {}
    for (const k of Object.keys(v).sort()) {
      const x = (v as Record<string, unknown>)[k]
      if (x !== undefined) out[k] = sortKeys(x)
    }
    return out
  }
  return v
}

const hex = (b: ArrayBuffer | Uint8Array): string => [...new Uint8Array(b)].map((x) => x.toString(16).padStart(2, '0')).join('')

export async function sha256Hex(s: string): Promise<string> {
  return hex(await crypto.subtle.digest('SHA-256', enc.encode(s)))
}

/** SHA-256 of the canonical JSON of `value`, hex. */
export const argsHash = (value: unknown): Promise<string> => sha256Hex(canonicalJson(value))

export function b64url(bytes: Uint8Array): string {
  let s = ''
  for (const b of bytes) s += String.fromCharCode(b)
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

export function fromB64url(s: string): Uint8Array<ArrayBuffer> {
  const b = atob(s.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (s.length % 4)) % 4))
  const out = new Uint8Array(new ArrayBuffer(b.length))
  for (let i = 0; i < b.length; i++) out[i] = b.charCodeAt(i)
  return out
}

/** A random id of `bytes` bytes, base64url. */
export function randomToken(bytes = 16): string {
  return b64url(crypto.getRandomValues(new Uint8Array(bytes)))
}

/** Compares in time that does not depend on where the strings differ. */
export function timingSafeEqual(a: string, b: string): boolean {
  const x = enc.encode(a)
  const y = enc.encode(b)
  let diff = x.length ^ y.length
  for (let i = 0; i < Math.max(x.length, y.length); i++) diff |= (x[i] ?? 0) ^ (y[i] ?? 0)
  return diff === 0
}

interface KeyPair {
  hmac: CryptoKey
  seal: CryptoKey
}

/** The guard's keys: the current secret first, then previous ones still accepted. */
export class Keyring {
  private keys: Promise<KeyPair[]>

  constructor(secret: string | { current: string; previous?: readonly string[] }) {
    const list = typeof secret === 'string' ? [secret] : [secret.current, ...(secret.previous ?? [])]
    for (const s of list) {
      if (typeof s !== 'string' || s.length < 32) throw new Error('guard secret must be at least 32 characters')
    }
    this.keys = Promise.all(list.map(derive))
  }

  async sign(payload: string): Promise<string> {
    const [k] = await this.keys
    return b64url(new Uint8Array(await crypto.subtle.sign('HMAC', k!.hmac, enc.encode(payload))))
  }

  /** True when any accepted key signed `payload` with `sig`. */
  async verify(payload: string, sig: string): Promise<boolean> {
    let raw: Uint8Array<ArrayBuffer>
    try {
      raw = fromB64url(sig)
    } catch {
      return false
    }
    for (const k of await this.keys) {
      if (await crypto.subtle.verify('HMAC', k.hmac, raw, enc.encode(payload))) return true
    }
    return false
  }

  /** AES-GCM, `aad` bound (the approval id), iv prepended, base64url. */
  async seal(plain: string, aad: string): Promise<string> {
    const [k] = await this.keys
    const iv = crypto.getRandomValues(new Uint8Array(12))
    const ct = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: enc.encode(aad) }, k!.seal, enc.encode(plain)))
    const out = new Uint8Array(iv.length + ct.length)
    out.set(iv)
    out.set(ct, iv.length)
    return b64url(out)
  }

  /** Opens with any accepted key. Throws when none opens it, or `aad` differs. */
  async unseal(sealed: string, aad: string): Promise<string> {
    const raw = fromB64url(sealed)
    const iv = raw.slice(0, 12)
    const ct = raw.slice(12)
    for (const k of await this.keys) {
      try {
        return dec.decode(await crypto.subtle.decrypt({ name: 'AES-GCM', iv, additionalData: enc.encode(aad) }, k.seal, ct))
      } catch {
        // try the next key
      }
    }
    throw new Error('sealed arguments do not open with any guard secret')
  }
}

async function derive(secret: string): Promise<KeyPair> {
  const base = await crypto.subtle.importKey('raw', enc.encode(secret), 'HKDF', false, ['deriveKey'])
  const params = (info: string) => ({ name: 'HKDF', hash: 'SHA-256', salt: enc.encode('omazy-guard'), info: enc.encode(info) })
  const hmac = await crypto.subtle.deriveKey(params('confirm-token'), base, { name: 'HMAC', hash: 'SHA-256', length: 256 }, false, ['sign', 'verify'])
  const seal = await crypto.subtle.deriveKey(params('sealed-arguments'), base, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt'])
  return { hmac, seal }
}

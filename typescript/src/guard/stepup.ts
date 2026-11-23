// Step-up: proof that a person, not a browser agent clicking in a signed-in
// session, made the decision. The kit owns the one-time code protocol
// (expiry, attempts, binding to one approval and one person); the product
// sends the code. A passkey check is the product's own StepUpVerifier.

import type { BaseCtx } from '../capabilities/capability.js'
import { sha256Hex, timingSafeEqual } from './crypto.js'
import type { ApprovalRow, GuardStore, StepUpBinding, StepUpProof, StepUpResult, StepUpVerifier } from './types.js'

export interface CodeStepUpOptions<C extends BaseCtx = BaseCtx> {
  store: GuardStore
  /** Sends `code` to the person on `channel` (their verified email or phone). */
  send: (ctx: C, channel: string, code: string, binding: StepUpBinding) => void | Promise<void>
  /** One code per channel; all are needed. Default `['email']`. Two channels for a super admin without a passkey. */
  channels?: readonly string[]
  /** The method name this proves. Default `code` for one channel, `two_channel` for more. */
  method?: string
  /** Default 10 minutes. */
  ttlMs?: number
  /** Wrong codes before the challenge is spent. Default 5. */
  maxAttempts?: number
  now?: () => number
}

export interface CodeStepUp<C extends BaseCtx = BaseCtx> extends StepUpVerifier<C> {
  /** Sends fresh codes to the decider for this approval. Earlier codes for it stop working. */
  start(ctx: C, approval: ApprovalRow): Promise<{ channels: readonly string[]; expiresAt: number }>
}

/** Six digits, uniform. */
export function sixDigits(): string {
  const buf = new Uint32Array(1)
  for (;;) {
    crypto.getRandomValues(buf)
    const v = buf[0]!
    if (v < 4_294_000_000) return String(v % 1_000_000).padStart(6, '0')
  }
}

export const bindingOf = (approval: ApprovalRow, person: string): StepUpBinding => ({ approvalId: approval.id, action: approval.action, argsHash: approval.argsHash, person })

const challengeId = (b: StepUpBinding, channel: string) => `${b.approvalId}:${b.person}:${channel}`
const codeHash = (b: StepUpBinding, channel: string, code: string) => sha256Hex(`${b.approvalId}|${b.argsHash}|${b.person}|${channel}|${code}`)

export function codeStepUp<C extends BaseCtx = BaseCtx>(o: CodeStepUpOptions<C>): CodeStepUp<C> {
  const channels = o.channels?.length ? [...o.channels] : ['email']
  const method = o.method ?? (channels.length > 1 ? 'two_channel' : 'code')
  const ttl = o.ttlMs ?? 10 * 60_000
  const max = o.maxAttempts ?? 5
  const now = o.now ?? Date.now
  return {
    methods: [method],
    async start(ctx, approval) {
      const b = bindingOf(approval, ctx.principal.id)
      const expiresAt = now() + ttl
      for (const ch of channels) {
        const code = sixDigits()
        await o.store.putChallenge({ id: challengeId(b, ch), approvalId: b.approvalId, person: b.person, channel: ch, codeHash: await codeHash(b, ch, code), expiresAt, attempts: 0 })
        await o.send(ctx, ch, code, b)
      }
      return { channels, expiresAt }
    },
    async verify(_ctx, proof: StepUpProof, b): Promise<StepUpResult> {
      if (proof.method !== method) return { ok: false, reason: `expected ${method}` }
      let good = true
      for (const ch of channels) {
        const id = challengeId(b, ch)
        const c = await o.store.getChallenge(id)
        if (!c || c.expiresAt <= now()) return { ok: false, reason: 'the code expired; ask for a new one' }
        if (c.attempts >= max) return { ok: false, reason: 'too many wrong codes; ask for a new one' }
        const given = proof.codes?.[ch]
        const match = typeof given === 'string' && timingSafeEqual(await codeHash(b, ch, given.trim()), c.codeHash)
        if (!match) {
          await o.store.bumpChallenge(id)
          good = false
        }
      }
      if (!good) return { ok: false, reason: channels.length > 1 ? 'a code is wrong' : 'the code is wrong' }
      for (const ch of channels) await o.store.deleteChallenge(challengeId(b, ch))
      return { ok: true, method }
    },
  }
}

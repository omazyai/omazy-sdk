// Approval policies as data. The product names its policies; a capability
// names one. The approver always comes from here, never from the caller.

import type { ApproverRule, PolicyRule } from './types.js'

/** `30m`, `24h`, `7d`, or milliseconds. */
export function durationMs(d: string | number): number {
  if (typeof d === 'number' && Number.isFinite(d) && d > 0) return d
  const m = typeof d === 'string' ? /^(\d+)\s*(s|m|h|d)$/.exec(d.trim()) : null
  if (!m) throw new Error(`not a duration: ${String(d)} (use 30m, 24h, 7d or milliseconds)`)
  const unit = { s: 1_000, m: 60_000, h: 3_600_000, d: 86_400_000 }[m[2] as 's' | 'm' | 'h' | 'd']
  return Number(m[1]) * unit
}

const list = (x: string | readonly string[] | undefined): readonly string[] => (x === undefined ? [] : typeof x === 'string' ? [x] : [...x])

export const approver = {
  /**
   * The request's author or an owner of the target record (from the guard's
   * `recordOwner` hook). With `role`, they must also hold one of those roles.
   * Joya's `tenant_self` and `tenant_owner_step_up`.
   */
  authorOrRecordOwner: (opts: { role?: string | readonly string[] } = {}): ApproverRule => {
    const roles = list(opts.role)
    return roles.length ? { kind: 'author_or_record_owner', roles } : { kind: 'author_or_record_owner' }
  },
  /** Anyone holding one of these roles (from the guard's `rolesOf` hook). */
  role: (roles: string | readonly string[]): ApproverRule => {
    const r = list(roles)
    if (!r.length) throw new Error('approver.role needs at least one role')
    return { kind: 'role', roles: r }
  },
  /** Every rule must hold. */
  all: (...rules: ApproverRule[]): ApproverRule => ({ kind: 'all', rules }),
}

export interface PolicyInput {
  approver: ApproverRule
  /** Accepted step-up methods, in the product's names: `code`, `two_channel`, `passkey`. */
  stepUp: string | readonly string[]
  /** `24h`, `1h`, or milliseconds. */
  expires: string | number
  /** The decider types the target (the tenant id). */
  typedTarget?: boolean
  /** Words for "who decides". */
  label?: string
}

function build(p: PolicyInput, fourEyes: boolean): PolicyRule {
  const stepUp = list(p.stepUp)
  if (!stepUp.length) throw new Error('a policy needs at least one step-up method: a click alone is not a decision')
  return Object.freeze({
    approver: p.approver,
    fourEyes,
    stepUp: Object.freeze([...stepUp]),
    expiresMs: durationMs(p.expires),
    typedTarget: p.typedTarget === true,
    ...(p.label ? { label: p.label } : {}),
  })
}

export const policies = {
  /**
   * One person decides, after step-up. The requester may be that person when
   * the approver rule allows it (author or record owner). Also the policy for
   * a single super admin: `approver.role('super_admin')` with a passkey and a
   * typed target.
   */
  single: (p: PolicyInput): PolicyRule => build(p, false),
  /** The decider must not be the requester. Platform payments. */
  fourEyes: (p: PolicyInput): PolicyRule => build(p, true),
}

/**
 * Joins a tenant's rule to the base so the result is never looser than
 * either: four eyes and typed target are or-ed, the expiry is the shorter,
 * the step-up methods are those both accept, and the decider must pass both
 * approver rules. A tenant rule that accepts no method the base accepts
 * leaves a policy nobody can pass; that is tighter, not looser.
 */
export function tighten(base: PolicyRule, extra: PolicyRule | null | undefined): PolicyRule {
  if (!extra) return base
  const stepUp = !base.stepUp.length ? extra.stepUp : !extra.stepUp.length ? base.stepUp : base.stepUp.filter((m) => extra.stepUp.includes(m))
  return Object.freeze({
    approver: { kind: 'all', rules: [base.approver, extra.approver] } as ApproverRule,
    fourEyes: base.fourEyes || extra.fourEyes,
    stepUp: Object.freeze([...stepUp]),
    expiresMs: Math.min(base.expiresMs, extra.expiresMs),
    typedTarget: base.typedTarget || extra.typedTarget,
    ...(extra.label ?? base.label ? { label: (extra.label ?? base.label) as string } : {}),
  })
}

/** "the requester or the record's owner, after step-up", for a pending approval. */
export function describePolicy(rule: PolicyRule): string {
  if (rule.label) return rule.label
  const who = describeRule(rule.approver)
  const eyes = rule.fourEyes ? ', other than the requester' : ''
  const step = rule.stepUp.length ? `, after ${rule.stepUp.join(' or ')} verification` : ''
  return `${who}${eyes}${step}`
}

function describeRule(r: ApproverRule): string {
  switch (r.kind) {
    case 'author_or_record_owner':
      return r.roles?.length ? `the requester or the record's owner, holding ${r.roles.join(' or ')}` : "the requester or the record's owner"
    case 'role':
      return `a person holding ${r.roles.join(' or ')}`
    case 'all':
      return r.rules.map(describeRule).join(' who is also ')
  }
}

export interface RuleFacts {
  deciderId: string
  requesterId: string
  /** Read only when a rule needs them. */
  roles: () => Promise<readonly string[]>
  owners: () => Promise<readonly string[]>
}

/** Whether the decider passes the approver rule. Four eyes is checked by the caller. */
export async function passesRule(r: ApproverRule, f: RuleFacts): Promise<boolean> {
  switch (r.kind) {
    case 'author_or_record_owner': {
      const mine = f.deciderId === f.requesterId || (await f.owners()).includes(f.deciderId)
      if (!mine) return false
      return !r.roles?.length || (await f.roles()).some((x) => r.roles!.includes(x))
    }
    case 'role':
      return (await f.roles()).some((x) => r.roles.includes(x))
    case 'all':
      for (const x of r.rules) if (!(await passesRule(x, f))) return false
      return r.rules.length > 0
  }
}

/** True when any part of the rule reads record owners. */
export function needsOwners(r: ApproverRule): boolean {
  return r.kind === 'author_or_record_owner' || (r.kind === 'all' && r.rules.some(needsOwners))
}

// The wire contract between `uiRoutes` on the product's server and the fetch
// clients in the browser. Plain data only: no sealed arguments, hashes,
// tokens or ids of other people beyond what a screen shows.

import type { Tier } from '../capabilities/tiers.js'

export interface PreviewData {
  summary: string
  before?: unknown
  after?: unknown
  [extra: string]: unknown
}

/** A consent card as the copilot streams it (`data-consent`). */
export interface ConsentCardData {
  kind: 'consent'
  id: string
  capability: string
  title: string
  tier: Tier
  preview: PreviewData
  input: unknown
  expiresAt: string
  status: 'waiting' | 'confirmed' | 'declined' | 'expired' | 'failed' | 'stale'
  result?: unknown
  message?: string
}

/** An approval card as the copilot streams it (`data-approval`). */
export interface ApprovalCardData {
  kind: 'approval'
  id: string
  capability: string
  title: string
  tier: Tier
  preview: PreviewData
  decider: string
  expiresAt: string
  reviewUrl?: string
  status: string
  /** Why it was refused or withdrawn, or the code it failed with. */
  message?: string
  updatedAt?: string
}

export type ActorStateName = 'start' | 'collect' | 'confirm' | 'pending_approval' | 'done' | 'handoff' | 'cancelled' | 'expired'

/** An actor's progress as the copilot streams it (`data-actor`, id = the session). */
export interface ActorData {
  session: string
  actor: string
  state: ActorStateName
  question?: { slot: string; kind: string; text: string; choices?: { id: string | number | boolean; label: string; detail?: string }[]; affirm?: boolean }
  card?: { id: string; title: string; summary: string; rows: { slot: string; label: string; value?: unknown; display: string; source?: string }[]; needs: 'confirm' | 'approval'; tier: Tier }
  approval?: { id: string; decider: string; expiresAt: string; reviewUrl?: string }
  handoff?: { prefill: Record<string, unknown>; pending: Record<string, unknown>; url?: string }
  /** What the actor said last, kept on the part by the panel after a card click. */
  note?: string
}

/** A memory the model suggested in a turn (`data-memory`). */
export interface MemorySuggestionData {
  id: string
  scope: 'person' | 'tenant'
  text: string
  status: 'proposed' | 'confirmed' | 'rejected'
}

/** What a consent or actor card click returns from the copilot's card routes. */
export type CardOutcomeData =
  | { outcome: 'confirmed'; card: ConsentCardData; result: unknown }
  | { outcome: 'declined' | 'expired' | 'stale' | 'failed' | 'already_settled'; card: ConsentCardData; message?: string }
  | { outcome: 'actor'; reply: { session: string; actor: string; state: ActorStateName; message: string; [k: string]: unknown } }
  | { outcome: 'not_found' | 'busy' }

// ---------------------------------------------------------------- approvals

export type ApprovalStatusName = 'waiting' | 'approved' | 'refused' | 'expired' | 'running' | 'executed' | 'failed' | 'stale' | 'withdrawn'

/** One approval as the inbox shows it. The arguments stay sealed on the server. */
export interface ApprovalItem {
  id: string
  /** The capability name. */
  action: string
  /** The capability's title, when the server knows it. */
  title: string
  tier: Tier
  status: ApprovalStatusName
  /** The preview stored with the request: what the decider approves. */
  preview: PreviewData
  policy: string
  /** Who decides, in words. */
  decider: string
  requester: { kind: string; id: string; name?: string }
  channel: string
  tenant: string | null
  createdAt: string
  expiresAt: string
  decidedAt: string | null
  decidedBy: { kind: string; id: string; name?: string } | null
  reason: string | null
  verification: string | null
  error: string | null
  reviewUrl?: string
  /** Whether this person may decide it now. */
  canDecide: boolean
  /** Why not, when they may not and it is still waiting. */
  why?: string
  needs: { stepUp: string[]; typedTarget: boolean; fourEyes: boolean }
}

export interface DecideBody {
  approve: boolean
  reason?: string
  typedTarget?: string
  /** The product's step-up proof, passed through untouched. */
  proof?: { method: string; [extra: string]: unknown }
}

export interface DecideResult {
  outcome: 'approved' | 'refused' | 'not_found' | 'expired' | 'already_decided' | 'not_allowed' | 'step_up_required' | 'step_up_failed' | 'reason_required' | 'typed_target_mismatch'
  approval?: ApprovalItem
  message?: string
  methods?: string[]
  /** On approve: what happened when it ran. */
  execution?: { outcome: string; message?: string }
}

// ---------------------------------------------------------------- connected apps

export interface AppItem {
  grantId: string
  clientId: string
  clientName: string
  status: 'known' | 'verified' | 'unverified'
  door: string
  tenant: string | null
  createdAt: number
  expiresAt: number | null
  lastUsedAt: number | null
}

export interface KeyItem {
  id: string
  kind: 'personal' | 'service'
  name: string
  door: string
  tenant: string | null
  createdAt: number
  expiresAt: number
  lastUsedAt: number | null
  maxTier?: Tier
  tools?: readonly string[]
}

export interface AppsData {
  apps: AppItem[]
  keys: KeyItem[]
}

// ---------------------------------------------------------------- memory

export interface MemoryItem {
  id: string
  scope: 'person' | 'tenant'
  text: string
  status: 'proposed' | 'confirmed' | 'rejected'
  /** The unit and run that suggested it: the source. */
  unit: string | null
  runId: string | null
  proposedAt: string
  decidedAt: string | null
  decidedBy: string | null
  lastUsedAt: string | null
}

export type MemoryDecision = { ok: true; item: MemoryItem } | { ok: false; reason: string }

// ---------------------------------------------------------------- standing grants

export interface GrantItem {
  id: string
  capability: string
  title: string
  grantedAt: string
  expiresAt: string
  dailyCap: number
  revokedAt: string | null
  /** Runs left today; null when the server did not count. */
  left: number | null
  active: boolean
}

export interface GrantsData {
  grants: GrantItem[]
  /** What a person may allow: R2 capabilities, and the limits. */
  options: { capabilities: { name: string; title: string }[]; maxDays: number; maxDailyCap: number }
}

export type SetGrantData = { ok: true; grant: GrantItem } | { ok: false; reason: string; message: string }

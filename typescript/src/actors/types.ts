// The shapes the actors kit works with: a session (the draft and where the
// conversation is), the slots in it, the question the clarifier asks, the
// card the confirmer shows, and what each turn returns to a surface.

import type { BaseCtx, Preview } from '../capabilities/capability.js'
import type { Tier } from '../capabilities/tiers.js'
import type { Image } from '../types.js'

/**
 * Where a session is. `start -> collect -> (extract, validate, clarify)* ->
 * confirm -> done`, or `confirm -> pending_approval -> done` for R3 and R4.
 * `handoff`, `cancelled` and `expired` end it from any open state.
 */
export type ActorState = 'start' | 'collect' | 'confirm' | 'pending_approval' | 'done' | 'handoff' | 'cancelled' | 'expired'

/** States a person can still move. */
export const OPEN_STATES: readonly ActorState[] = ['start', 'collect', 'confirm']
/** States that never change again. */
export const FINAL_STATES: readonly ActorState[] = ['done', 'handoff', 'cancelled', 'expired']

/** Where a value came from, shown on the confirm card. */
export type SlotSource = 'message' | 'attachment' | 'lookup' | 'person' | 'default' | 'derived' | 'prefill'

/**
 * One slot's state.
 *
 * - `empty`: nothing yet
 * - `filled`: a value that passed every check
 * - `doubtful`: a value read below the slot's threshold; asked, never used
 * - `choice`: a lookup found more than one record, or the message and an attachment disagree
 * - `not_found`: a lookup found nothing for the query
 * - `invalid`: a check refused the value; `issue` says why
 * - `waiting`: a query kept until the slots it depends on are filled
 */
export type SlotStatus = 'empty' | 'filled' | 'doubtful' | 'choice' | 'not_found' | 'invalid' | 'waiting'

export interface Choice {
  /** The value the slot takes when this is chosen: a record id for a lookup. */
  id: string | number | boolean
  /** What a person reads. */
  label: string
  /** More words, such as the record's city or the invoice's date. */
  detail?: string
}

export interface SlotState {
  status: SlotStatus
  /** The value the target gets. Set for `filled`; the candidate for `doubtful` and `invalid`. */
  value?: unknown
  /** How the value reads to a person (a lookup's label, a formatted amount). */
  display?: string
  /** What the person wrote, for a lookup slot: the name it was looked up by. */
  query?: string
  confidence?: number
  source?: SlotSource
  /** The words or the part of an attachment the value was read from. Untrusted text, shown as data. */
  evidence?: string
  /** The attachment id, when the value came from one. */
  attachment?: string
  /** For `invalid` and `not_found`: one sentence. */
  issue?: string
  choices?: Choice[]
  /** The turn that last changed it. */
  turn?: number
  /** The value's checks ran and passed; cleared when the value or a slot it depends on changes. */
  checked?: boolean
}

/** A reference to an attachment the session has seen. The bytes stay with the product. */
export interface AttachmentRef {
  id: string
  kind: string
  name?: string
  /** The product's storage key, such as an R2 key, for a slot like `proof_key`. */
  key?: string
  bytes?: number
}

/**
 * What a person sends with a reply. Text already read from a PDF or a
 * spreadsheet goes in `text`; a photo goes in `image` for a vision model.
 * Both are untrusted: they are fenced, and nothing in them can submit.
 */
export interface Attachment {
  /** Unique within the session. Default `att_<n>`. */
  id?: string
  /** MIME type, such as `image/jpeg`. Checked against the actor's `attachments.kinds`. */
  kind: string
  name?: string
  key?: string
  bytes?: number
  text?: string
  image?: Image
}

export interface ReplyInput {
  text?: string
  attachments?: readonly Attachment[]
  /** A click on a choice: deterministic, no model call. */
  choose?: { slot: string; id: Choice['id'] }
  /** A click on "yes" (true) or "no" (false) for the doubtful value being asked about. */
  affirm?: boolean
}

export type QuestionKind = 'missing' | 'doubtful' | 'choice' | 'not_found' | 'invalid' | 'conflict'

/** The one thing the clarifier asks next. */
export interface Question {
  slot: string
  kind: QuestionKind
  text: string
  choices?: Choice[]
  /** True when the person can answer yes or no (a doubtful value). */
  affirm?: boolean
}

export interface CardRow {
  slot: string
  label: string
  value: unknown
  display: string
  source: SlotSource
  evidence?: string
  attachment?: string
}

/** The confirmer's summary: every value and where it came from. */
export interface Card {
  /** Hash of the input and the session version. A confirm names it, so a stale card cannot be confirmed. */
  id: string
  title: string
  /** One sentence for the person. */
  summary: string
  rows: CardRow[]
  /** The target's input, exactly what the guard will get. */
  input: Record<string, unknown>
  tier: Tier
  /** `confirm` at R2, `approval` at R3 and R4. An actor's target is never below R2. */
  needs: 'confirm' | 'approval'
  /** The guard's preview, when it gave one (R2). */
  preview?: Preview
}

export interface Change {
  slot: string
  from: string
  to: string
}

export interface TurnRecord {
  n: number
  at: string
  channel: string
  kind: 'start' | 'reply' | 'choose' | 'affirm' | 'confirm' | 'handoff' | 'cancel' | 'expire' | 'approval'
  /** The run that recorded the model call and lookups of this turn. */
  run?: string
  /** Slots the extractor named, after the kit dropped the ones it may not fill. */
  slots?: string[]
  /** Slot names the extractor gave that the kit refused (unknown, derived or not extractable). */
  dropped?: string[]
  changes?: Change[]
  question?: { slot: string; kind: QuestionKind }
  state: ActorState
  note?: string
}

export interface ActorSession {
  id: string
  actor: string
  actorVersion: number
  target: string
  tenant: string | null
  person: string
  /** The surface of the last turn. A session resumes on any surface for the same person. */
  channel: string
  language: string
  state: ActorState
  /** Raised on every write; the store refuses a write from an older one. */
  version: number
  slots: Record<string, SlotState>
  asking: { slot: string; kind: QuestionKind } | null
  card: Card | null
  /** The guard's confirm token for the card, at R2. Never shown to a model. */
  confirmToken?: string
  approval?: { id: string; decider: string; expiresAt: string; reviewUrl?: string }
  result?: unknown
  /** Set when the session ended without a result: refused, expired approval, failed run. */
  outcome?: string
  attachments: AttachmentRef[]
  /** Every run this session made, oldest first, with its unit. */
  runs: { unit: string; run: string }[]
  turns: TurnRecord[]
  createdAt: string
  updatedAt: string
  /** When it expires if nobody touches it. */
  expiresAt: string
}

/** What every call on a session returns to the surface. */
export interface ActorReply {
  session: string
  actor: string
  state: ActorState
  /** What to say to the person now: the changes, then the question or the card. */
  message: string
  question?: Question
  card?: Card
  changes?: Change[]
  /** Things the person should know that are not questions, such as an attachment kind the actor does not read. */
  notes?: string[]
  approval?: ActorSession['approval']
  result?: unknown
  /** Set on `handoff` and in `status`: the form's pre-fill and its link. */
  handoff?: Handoff
  /** For a refusal from the guard or the runtime. */
  refusal?: { code: string; message: string }
}

export interface Handoff {
  /** The target's input so far: filled, default and derived values only. Never a doubtful one. */
  prefill: Record<string, unknown>
  /** Values read but not settled, so the form can show them as suggestions. */
  pending: Record<string, unknown>
  url?: string
}

/** Where sessions live. A write names the version it read; a stale write is refused. */
export interface SessionStore {
  get(id: string): Promise<ActorSession | null>
  /**
   * Writes the session when the stored version is `expect` (null: only when
   * there is none). Returns false when another writer got there first.
   */
  put(session: ActorSession, expect: number | null): Promise<boolean>
  /** Open sessions of one person for one actor, newest first. For resume from another surface. */
  open?(q: { tenant: string | null; person: string; actor?: string; limit?: number }): Promise<ActorSession[]>
}

/** The ctx type an actor runs with. */
export type ActorCtx = BaseCtx

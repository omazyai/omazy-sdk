// View models: what each screen shows, worked out from the data without any
// framework. The React components render these; a Preact or plain product
// can render them the same way.

import type { ChatMessage, ChatPart } from './chat.js'
import { formatNumber, type UiText } from './text.js'
import type {
  ActorData,
  ApprovalCardData,
  ApprovalItem,
  CardOutcomeData,
  ConsentCardData,
  GrantItem,
  MemoryItem,
  MemorySuggestionData,
} from './types.js'

// ---------------------------------------------------------------- values

/** A value as one line of text: strings as they are, objects as compact JSON. */
export function formatValue(text: Pick<UiText, 'none' | 'yes' | 'no' | 'locale'>, v: unknown): string {
  if (v === null || v === undefined || v === '') return text.none
  if (typeof v === 'boolean') return v ? text.yes : text.no
  if (typeof v === 'number') return formatNumber(text, v)
  if (typeof v === 'string') return v
  try {
    return JSON.stringify(v)
  } catch {
    return String(v)
  }
}

export interface DiffRow {
  /** The field name; empty when the before and after are single values. */
  field: string
  before: unknown
  after: unknown
  changed: boolean
  /** Only in the after: a new field. */
  added: boolean
  /** Only in the before: a removed field. */
  removed: boolean
}

const isRecord = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v)
const same = (a: unknown, b: unknown) => a === b || JSON.stringify(a) === JSON.stringify(b)

/** Rows for a before and after table. Objects compare field by field; changed rows first. */
export function diffRows(before: unknown, after: unknown): DiffRow[] {
  if (before === undefined && after === undefined) return []
  if (isRecord(before) || isRecord(after)) {
    const b = isRecord(before) ? before : {}
    const a = isRecord(after) ? after : {}
    const keys = [...new Set([...Object.keys(b), ...Object.keys(a)])]
    const rows = keys.map((field) => ({
      field,
      before: b[field],
      after: a[field],
      changed: !same(b[field], a[field]),
      added: !(field in b) && isRecord(before),
      removed: !(field in a) && isRecord(after),
    }))
    return [...rows.filter((r) => r.changed), ...rows.filter((r) => !r.changed)]
  }
  return [{ field: '', before, after, changed: !same(before, after), added: before === undefined, removed: after === undefined }]
}

// ---------------------------------------------------------------- time

export interface Expiry {
  expired: boolean
  /** Whole minutes left, at least 1 while not expired. */
  minutes: number
}

export function expiry(expiresAt: string | number | null | undefined, now: number = Date.now()): Expiry {
  if (expiresAt === null || expiresAt === undefined) return { expired: false, minutes: Infinity }
  const at = typeof expiresAt === 'number' ? expiresAt : Date.parse(expiresAt)
  if (Number.isNaN(at)) return { expired: false, minutes: Infinity }
  const left = at - now
  return left <= 0 ? { expired: true, minutes: 0 } : { expired: false, minutes: Math.max(1, Math.ceil(left / 60_000)) }
}

// ---------------------------------------------------------------- message parts

export type PartView =
  | { kind: 'text'; text: string; streaming: boolean }
  | { kind: 'consent'; id: string; card: ConsentCardData }
  | { kind: 'approval'; id: string; card: ApprovalCardData }
  | { kind: 'actor'; id: string; actor: ActorData }
  | { kind: 'memory'; id: string; memory: MemorySuggestionData }
  | { kind: 'tool'; name: string; state: string; output: unknown }
  | { kind: 'other'; type: string }

/** What kind of thing a message part is, for the renderer. */
export function partView(p: ChatPart): PartView {
  switch (p.type) {
    case 'text':
      return { kind: 'text', text: p.text ?? '', streaming: p.state === 'streaming' }
    case 'data-consent':
      return { kind: 'consent', id: p.id ?? (p.data as ConsentCardData).id, card: p.data as ConsentCardData }
    case 'data-approval':
      return { kind: 'approval', id: p.id ?? (p.data as ApprovalCardData).id, card: p.data as ApprovalCardData }
    case 'data-actor':
      return { kind: 'actor', id: p.id ?? (p.data as ActorData).session, actor: p.data as ActorData }
    case 'data-memory':
      return { kind: 'memory', id: p.id ?? (p.data as MemorySuggestionData).id, memory: p.data as MemorySuggestionData }
    case 'dynamic-tool':
      return { kind: 'tool', name: p.toolName ?? '', state: p.state ?? '', output: p.output }
    default:
      if (p.type.startsWith('tool-')) return { kind: 'tool', name: p.type.slice(5), state: p.state ?? '', output: p.output }
      return { kind: 'other', type: p.type }
  }
}

/** The messages with one data part (by type and id) replaced. Returns the same array when nothing matched. */
export function replaceDataPart(messages: ChatMessage[], type: string, id: string, data: unknown): ChatMessage[] {
  let hit = false
  const out = messages.map((m) => {
    const i = m.parts.findIndex((p) => p.type === type && (p.id ?? (p.data as { id?: string; session?: string } | undefined)?.id ?? (p.data as { session?: string } | undefined)?.session) === id)
    if (i < 0) return m
    hit = true
    const parts = [...m.parts]
    parts[i] = { ...parts[i]!, data }
    return { ...m, parts }
  })
  return hit ? out : messages
}

/** The last text of the last assistant message. */
export function lastAssistantText(messages: ChatMessage[]): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i]!
    if (m.role !== 'assistant') continue
    return m.parts
      .filter((p) => p.type === 'text')
      .map((p) => p.text ?? '')
      .join('')
  }
  return ''
}

// ---------------------------------------------------------------- consent cards

export interface ConsentView {
  id: string
  title: string
  summary: string
  rows: DiffRow[]
  /** The effective status: a waiting card past its expiry reads as expired. */
  status: ConsentCardData['status']
  expiry: Expiry
  /** Whether Confirm and Decline are offered. */
  canAct: boolean
  message?: string
}

export function consentView(card: ConsentCardData, now: number = Date.now()): ConsentView {
  const e = expiry(card.expiresAt, now)
  const status = card.status === 'waiting' && e.expired ? 'expired' : card.status
  return {
    id: card.id,
    title: card.title || card.capability,
    summary: card.preview?.summary ?? '',
    rows: diffRows(card.preview?.before, card.preview?.after),
    status,
    expiry: e,
    canAct: status === 'waiting',
    ...(card.message ? { message: card.message } : {}),
  }
}

/** The card's new data after a click, or the sentence to show when the card did not change. */
export function cardAfter(card: ConsentCardData, out: CardOutcomeData, text: Pick<UiText, 'cardNotFound' | 'cardBusy' | 'cardStatus'>): { card: ConsentCardData; note?: string } {
  switch (out.outcome) {
    case 'not_found':
      return { card, note: text.cardNotFound }
    case 'busy':
      return { card, note: text.cardBusy }
    case 'already_settled':
      return { card: out.card, note: text.cardStatus.already_settled }
    case 'actor':
      return { card }
    default:
      return { card: out.card }
  }
}

// ---------------------------------------------------------------- approvals

export interface ApprovalView {
  id: string
  title: string
  summary: string
  rows: DiffRow[]
  decider: string
  status: string
  expiry: Expiry
  reviewUrl?: string
  /** True while the status can still change. */
  live: boolean
}

/** An approval card, with the live row when one was fetched. */
export function approvalView(card: ApprovalCardData | ApprovalItem, live: ApprovalItem | null = null, now: number = Date.now()): ApprovalView {
  const status = live?.status ?? card.status
  const e = expiry(live?.expiresAt ?? card.expiresAt, now)
  const effective = status === 'waiting' && e.expired ? 'expired' : status
  const title = 'action' in card ? card.title || card.action : card.title || card.capability
  return {
    id: card.id,
    title,
    summary: card.preview?.summary ?? '',
    rows: diffRows(card.preview?.before, card.preview?.after),
    decider: live?.decider ?? card.decider,
    status: effective,
    expiry: e,
    ...((live?.reviewUrl ?? card.reviewUrl) ? { reviewUrl: live?.reviewUrl ?? card.reviewUrl } : {}),
    live: effective === 'waiting' || effective === 'approved' || effective === 'running',
  }
}

/** Who asked or decided, in words: the name when there is one, else the id. */
export const personName = (p: { id: string; name?: string } | null | undefined): string => (p ? p.name || p.id : '')

// ---------------------------------------------------------------- actors

export interface ActorView {
  session: string
  actor: string
  state: ActorData['state']
  question?: ActorData['question']
  rows: { label: string; display: string }[]
  /** Filled rows on the card, and how many it has. Null before there is a card. */
  progress: { filled: number; total: number } | null
  summary?: string
  /** The card id to confirm, when the actor waits for a click. */
  confirmCard?: string
  approval?: ActorData['approval']
  handoffUrl?: string
  final: boolean
  note?: string
}

const FINAL = new Set(['done', 'handoff', 'cancelled', 'expired'])

export function actorView(a: ActorData): ActorView {
  const rows = (a.card?.rows ?? []).map((r) => ({ label: r.label, display: r.display }))
  const filled = rows.filter((r) => r.display !== '').length
  return {
    session: a.session,
    actor: a.actor,
    state: a.state,
    ...(a.question ? { question: a.question } : {}),
    rows,
    progress: a.card ? { filled, total: rows.length } : null,
    ...(a.card?.summary ? { summary: a.card.summary } : {}),
    ...(a.state === 'confirm' && a.card?.needs === 'confirm' ? { confirmCard: a.card.id } : {}),
    ...(a.approval ? { approval: a.approval } : {}),
    ...(a.handoff?.url ? { handoffUrl: a.handoff.url } : {}),
    final: FINAL.has(a.state),
    ...(a.note ? { note: a.note } : {}),
  }
}

/** The `data-actor` part for an actor's reply to a card click: the same shape the copilot streams. */
export function actorDataOf(reply: Record<string, unknown> & { session: string; actor: string; state: ActorData['state']; message?: string }): ActorData {
  const card = reply.card as (ActorData['card'] & Record<string, unknown>) | undefined
  return {
    session: reply.session,
    actor: reply.actor,
    state: reply.state,
    ...(reply.question ? { question: reply.question as ActorData['question'] } : {}),
    ...(card ? { card: { id: card.id, title: card.title, summary: card.summary, rows: card.rows, needs: card.needs, tier: card.tier } } : {}),
    ...(reply.approval ? { approval: reply.approval as ActorData['approval'] } : {}),
    ...(reply.handoff ? { handoff: reply.handoff as ActorData['handoff'] } : {}),
    ...(reply.message ? { note: reply.message } : {}),
  }
}

// ---------------------------------------------------------------- memory and grants

export function memoryGroups(items: MemoryItem[]): { confirmed: MemoryItem[]; pending: MemoryItem[] } {
  return { confirmed: items.filter((m) => m.status === 'confirmed'), pending: items.filter((m) => m.status === 'proposed') }
}

/** The grants still in force: not revoked and not expired. */
export function activeGrants(grants: GrantItem[], now: number = Date.now()): GrantItem[] {
  return grants.filter((g) => !g.revokedAt && Date.parse(g.expiresAt) > now)
}

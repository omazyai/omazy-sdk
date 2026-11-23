// The cards a copilot turn shows: consent for an R2 change, approval for R3
// and R4, an actor's progress with its form link, and a suggested memory.
// Each is an article named by its heading; a click's outcome is spoken from
// a status line that takes the focus, so a keyboard or screen reader user
// hears what happened and stays on the card.

import { createElement as h, type ReactNode, useEffect, useId, useState } from 'react'
import { formatDate, formatNumber } from '../text.js'
import type { ActorData, ApprovalCardData, ApprovalItem, ConsentCardData, MemorySuggestionData } from '../types.js'
import { actorView, approvalView, consentView } from '../views.js'
import { cx, Diff, Heading, type HeadingLevel } from './bits.js'
import { useUi } from './context.js'
import { useFocusAfter, useNow } from './hooks.js'

type Act = () => Promise<string | void | undefined> | string | void | undefined

/** Runs a card action, keeps the button state, and focuses the status line after. */
function useCardAction() {
  const { text } = useUi()
  const [busy, setBusy] = useState<string | null>(null)
  const [note, setNote] = useState<{ text: string; error: boolean } | null>(null)
  const status = useFocusAfter<HTMLParagraphElement>()
  const run = async (which: string, fn: Act | undefined) => {
    if (!fn || busy) return
    setBusy(which)
    setNote(null)
    try {
      const n = await fn()
      if (n) setNote({ text: n, error: false })
    } catch (e) {
      setNote({ text: (e as Error)?.message || text.errorGeneric, error: true })
    } finally {
      setBusy(null)
      status.focus()
    }
  }
  return { busy, note, run, status }
}

const Note = (p: { note: { text: string; error: boolean } | null }) =>
  p.note ? h('p', { className: p.note.error ? 'omz-error' : 'omz-note', role: p.note.error ? 'alert' : undefined }, p.note.text) : null

// ---------------------------------------------------------------- consent

export interface ConsentCardProps {
  card: ConsentCardData
  /** The person's click. Resolve with a sentence to show it under the card. */
  onConfirm?: Act
  onDecline?: Act
  headingLevel?: HeadingLevel
  className?: string
}

export function ConsentCard(p: ConsentCardProps): ReactNode {
  const { text } = useUi()
  const now = useNow()
  const v = consentView(p.card, now)
  const id = useId()
  const a = useCardAction()
  return h(
    'article',
    { className: cx('omz-card omz-card--consent', p.className), 'data-status': v.status, 'aria-labelledby': `${id}t`, 'aria-describedby': `${id}s`, 'aria-busy': a.busy ? true : undefined },
    h('p', { className: 'omz-meta' }, text.consentTitle),
    h(Heading, { level: p.headingLevel ?? 3, id: `${id}t`, className: 'omz-card__title' }, v.title),
    h('p', { id: `${id}s`, className: 'omz-card__summary' }, v.summary),
    h(Diff, { rows: v.rows, text }),
    h('p', { ref: a.status.ref, tabIndex: -1, className: 'omz-status', 'data-status': v.status, role: 'status' }, text.cardStatus[v.status], v.message ? ` ${v.message}` : ''),
    v.canAct && Number.isFinite(v.expiry.minutes) ? h('p', { className: 'omz-meta' }, text.expiresIn(formatNumber(text, v.expiry.minutes))) : null,
    h(Note, { note: a.note }),
    v.canAct
      ? h(
          'div',
          { className: 'omz-card__actions' },
          h('button', { type: 'button', className: 'omz-btn omz-btn--primary', disabled: !!a.busy || !p.onConfirm, 'aria-describedby': `${id}s`, onClick: () => a.run('confirm', p.onConfirm) }, text.confirm),
          h('button', { type: 'button', className: 'omz-btn', disabled: !!a.busy || !p.onDecline, onClick: () => a.run('decline', p.onDecline) }, text.decline),
        )
      : null,
  )
}

// ---------------------------------------------------------------- approval

export interface ApprovalCardProps {
  card: ApprovalCardData | ApprovalItem
  /** How often to fetch the live status while it can change, in ms. Default 15000; 0 turns it off. Needs `uiRoutes`. */
  pollMs?: number
  headingLevel?: HeadingLevel
  className?: string
}

export function ApprovalCard(p: ApprovalCardProps): ReactNode {
  const { text, ui } = useUi()
  const now = useNow()
  const [live, setLive] = useState<ApprovalItem | null>(null)
  const pollMs = p.pollMs ?? 15_000
  const cardId = p.card.id
  useEffect(() => {
    if (!ui || !pollMs) return
    let stop = false
    let t: ReturnType<typeof setTimeout> | undefined
    const tick = async () => {
      let again = true
      try {
        const a = await ui.approvals.get(cardId)
        if (stop) return
        setLive(a)
        again = !!a && (a.status === 'waiting' || a.status === 'approved' || a.status === 'running')
      } catch {
        // Keep the last status; try again on the next tick.
      }
      if (!stop && again) t = setTimeout(tick, pollMs)
    }
    void tick()
    return () => {
      stop = true
      clearTimeout(t)
    }
  }, [ui, pollMs, cardId])
  const v = approvalView(p.card, live, now)
  const id = useId()
  const statusText = (text.approvalStatus as Record<string, string>)[v.status] ?? v.status
  const why = live?.reason ?? ('message' in p.card ? p.card.message : undefined)
  return h(
    'article',
    { className: cx('omz-card omz-card--approval', p.className), 'data-status': v.status, 'aria-labelledby': `${id}t`, 'aria-describedby': `${id}s` },
    h('p', { className: 'omz-meta' }, text.approvalTitle),
    h(Heading, { level: p.headingLevel ?? 3, id: `${id}t`, className: 'omz-card__title' }, v.title),
    h('p', { id: `${id}s`, className: 'omz-card__summary' }, v.summary),
    h(Diff, { rows: v.rows, text }),
    h('p', { className: 'omz-meta' }, text.whoDecides(v.decider)),
    v.status === 'waiting'
      ? h('p', { className: 'omz-meta' }, Number.isFinite(v.expiry.minutes) && v.expiry.minutes <= 120 ? text.expiresIn(formatNumber(text, v.expiry.minutes)) : text.expiresAt(formatDate(text, live?.expiresAt ?? p.card.expiresAt)))
      : null,
    h('p', { className: 'omz-status', 'data-status': v.status, role: 'status', 'aria-live': 'polite' }, statusText, why ? ` ${why}` : ''),
    v.reviewUrl && v.status === 'waiting' ? h('p', null, h('a', { href: v.reviewUrl, className: 'omz-link' }, text.openReview)) : null,
  )
}

// ---------------------------------------------------------------- actor

export interface ActorCardProps {
  actor: ActorData
  /** The actor's name for people. Default its id. */
  title?: string
  /** A choice or yes or no, sent as the person's next message. */
  onChoose?: (answer: string) => void
  onConfirm?: (cardId: string) => ReturnType<Act>
  onDecline?: (cardId: string) => ReturnType<Act>
  headingLevel?: HeadingLevel
  className?: string
}

export function ActorCard(p: ActorCardProps): ReactNode {
  const { text } = useUi()
  const v = actorView(p.actor)
  const id = useId()
  const a = useCardAction()
  const progress = v.progress && v.progress.total ? text.actorProgress(formatNumber(text, v.progress.filled), formatNumber(text, v.progress.total)) : null
  const choices = !v.final && v.question?.choices?.length ? v.question.choices : null
  return h(
    'article',
    { className: cx('omz-card omz-card--actor', p.className), 'data-status': v.state, 'aria-labelledby': `${id}t`, 'aria-busy': a.busy ? true : undefined },
    h(Heading, { level: p.headingLevel ?? 3, id: `${id}t`, className: 'omz-card__title' }, text.actorTitle(p.title ?? v.actor)),
    h('p', { ref: a.status.ref, tabIndex: -1, className: 'omz-status', 'data-status': v.state, role: 'status' }, text.actorState[v.state] ?? v.state),
    progress ? [h('progress', { key: 'p', value: v.progress!.filled, max: v.progress!.total, 'aria-label': progress }), h('p', { key: 'm', className: 'omz-meta' }, progress)] : null,
    v.note ? h('p', { className: 'omz-note' }, v.note) : null,
    v.question && !v.final ? h('p', { id: `${id}q` }, v.question.text) : null,
    choices && p.onChoose
      ? h(
          'div',
          { className: 'omz-card__actions', role: 'group', 'aria-labelledby': `${id}q` },
          choices.map((c) => h('button', { key: String(c.id), type: 'button', className: 'omz-btn', onClick: () => p.onChoose!(c.label), title: c.detail }, c.label)),
        )
      : null,
    !choices && v.question?.affirm && !v.final && p.onChoose
      ? h(
          'div',
          { className: 'omz-card__actions', role: 'group', 'aria-labelledby': `${id}q` },
          h('button', { type: 'button', className: 'omz-btn', onClick: () => p.onChoose!(text.yes) }, text.yes),
          h('button', { type: 'button', className: 'omz-btn', onClick: () => p.onChoose!(text.no) }, text.no),
        )
      : null,
    v.summary ? h('p', { className: 'omz-card__summary' }, v.summary) : null,
    v.rows.length ? h('dl', { className: 'omz-rows' }, v.rows.map((r, i) => [h('dt', { key: `t${i}` }, r.label), h('dd', { key: `d${i}` }, r.display || text.none)])) : null,
    h(Note, { note: a.note }),
    v.confirmCard
      ? h(
          'div',
          { className: 'omz-card__actions' },
          h('button', { type: 'button', className: 'omz-btn omz-btn--primary', disabled: !!a.busy || !p.onConfirm, onClick: () => a.run('confirm', () => p.onConfirm?.(v.confirmCard!)) }, text.confirm),
          h('button', { type: 'button', className: 'omz-btn', disabled: !!a.busy || !p.onDecline, onClick: () => a.run('decline', () => p.onDecline?.(v.confirmCard!)) }, text.decline),
        )
      : null,
    v.approval
      ? h(
          'p',
          { className: 'omz-meta' },
          text.whoDecides(v.approval.decider),
          v.approval.reviewUrl ? [' ', h('a', { key: 'r', href: v.approval.reviewUrl, className: 'omz-link' }, text.openReview)] : null,
        )
      : null,
    v.handoffUrl ? h('p', null, h('a', { href: v.handoffUrl, className: 'omz-btn omz-link' }, text.openForm)) : null,
  )
}

// ---------------------------------------------------------------- memory

export interface MemorySuggestionProps {
  memory: MemorySuggestionData
  onConfirm?: Act
  onReject?: Act
  className?: string
}

export function MemorySuggestion(p: MemorySuggestionProps): ReactNode {
  const { text } = useUi()
  const id = useId()
  const a = useCardAction()
  const m = p.memory
  const status = m.status === 'confirmed' ? text.memoryDecided.confirmed : m.status === 'rejected' ? text.memoryDecided.rejected : text.memorySuggested
  return h(
    'article',
    { className: cx('omz-card omz-card--memory', p.className), 'data-status': m.status, 'aria-labelledby': `${id}t` },
    h('p', { id: `${id}t`, className: 'omz-card__summary' }, m.text),
    h('p', { className: 'omz-meta' }, text.memoryScope[m.scope]),
    h('p', { ref: a.status.ref, tabIndex: -1, className: 'omz-status', 'data-status': m.status, role: 'status' }, status),
    h(Note, { note: a.note }),
    m.status === 'proposed' && (p.onConfirm || p.onReject)
      ? h(
          'div',
          { className: 'omz-card__actions' },
          p.onConfirm ? h('button', { type: 'button', className: 'omz-btn omz-btn--primary', disabled: !!a.busy, onClick: () => a.run('confirm', p.onConfirm) }, text.remember) : null,
          p.onReject ? h('button', { type: 'button', className: 'omz-btn', disabled: !!a.busy, onClick: () => a.run('reject', p.onReject) }, text.dontRemember) : null,
        )
      : null,
  )
}

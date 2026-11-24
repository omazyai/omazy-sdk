// The approvals inbox: a list, and a detail with the preview stored with the
// request. Approving runs the product's step-up first: the kit opens a slot
// the product fills (a passkey prompt, a code form) and passes the proof it
// gets back to the guard untouched. The kit never sees a passkey or a code.

import { createElement as h, type KeyboardEvent, type ReactNode, useEffect, useId, useState } from 'react'
import { formatDate, formatNumber } from '../text.js'
import type { ApprovalItem, CodeSent, DecideBody, DecideResult } from '../types.js'
import { approvalView, personName } from '../views.js'
import { cx, Diff, Heading, type HeadingLevel, listKeys, Loadable } from './bits.js'
import { useUi } from './context.js'
import { useFocusAfter, useNow, useResource } from './hooks.js'

export interface StepUpSlotProps {
  approval: ApprovalItem
  /** The methods the policy accepts, in the product's names (`code`, `passkey`). */
  methods: string[]
  /** Call with the proof the product's verifier reads. The kit sends it with the decision. */
  done(proof: { method: string; [extra: string]: unknown }): void
  /** Call when the person gives up; focus returns to Approve. */
  cancel(): void
}

/**
 * A ready step-up slot for the guard's `codeStepUp`: a button that asks
 * `uiRoutes` (with `approvals.codes`) to send the decider a code, then a field
 * for each channel the code went to. The kit only carries the code from the
 * field to the decide call; the product's `send` delivers it by email or SMS.
 *
 *     h(ApprovalsInbox, { stepUp: (s) => h(CodeStepUpForm, s) })
 */
export function CodeStepUpForm(p: StepUpSlotProps): ReactNode {
  const { text, ui } = useUi()
  const id = useId()
  const [sent, setSent] = useState<CodeSent | null>(null)
  const [codes, setCodes] = useState<Record<string, string>>({})
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const first = useFocusAfter<HTMLInputElement>()
  const send = async () => {
    if (!ui) return
    setBusy(true)
    setError(null)
    try {
      const r = await ui.approvals.sendCode(p.approval.id)
      setSent(r)
      setCodes({})
      first.focus()
    } catch (e) {
      setError((e as Error)?.message || text.errorGeneric)
    } finally {
      setBusy(false)
    }
  }
  const submit = (e: { preventDefault(): void }) => {
    e.preventDefault()
    if (!sent) return
    const given = Object.fromEntries(sent.channels.map((ch) => [ch, (codes[ch] ?? '').trim()]))
    if (Object.values(given).some((v) => !v)) {
      setError(text.codeRequired)
      first.focus()
      return
    }
    p.done({ method: sent.method, codes: given })
  }
  const cancel = h('button', { key: 'c', type: 'button', className: 'omz-btn', disabled: busy, onClick: p.cancel }, text.cancel)
  const err = error ? h('p', { key: 'e', className: 'omz-error', role: 'alert' }, error) : null
  if (!sent)
    return h('div', { className: 'omz-section' }, err, h('div', { className: 'omz-card__actions' }, h('button', { type: 'button', className: 'omz-btn omz-btn--primary', disabled: busy || !ui, onClick: () => void send() }, text.codeSend), cancel))
  const list = new Intl.ListFormat(text.locale, { type: 'conjunction' }).format(sent.channels)
  return h(
    'form',
    { className: 'omz-section', onSubmit: submit },
    h('p', { className: 'omz-note', role: 'status' }, text.codeSent(list)),
    err,
    sent.channels.map((ch, i) =>
      h(
        'label',
        { key: ch, className: 'omz-field' },
        h('span', null, text.codeLabel(sent.channels.length > 1 ? ch : null)),
        h('input', {
          ref: i === 0 ? first.ref : undefined,
          id: `${id}-${ch}`,
          value: codes[ch] ?? '',
          inputMode: 'numeric',
          autoComplete: 'one-time-code',
          spellCheck: false,
          'aria-required': true,
          disabled: busy,
          onChange: (e: { target: { value: string } }) => setCodes((c) => ({ ...c, [ch]: e.target.value })),
        }),
      ),
    ),
    h(
      'div',
      { className: 'omz-card__actions' },
      h('button', { type: 'submit', className: 'omz-btn omz-btn--primary', disabled: busy }, text.codeSubmit),
      h('button', { type: 'button', className: 'omz-btn', disabled: busy, onClick: () => void send() }, text.codeResend),
      cancel,
    ),
  )
}

export interface ApprovalDetailProps {
  approval: ApprovalItem
  /** The product's step-up. Without it an approval that needs one cannot be decided here. */
  stepUp?: (p: StepUpSlotProps) => ReactNode
  /** After a decision, with the server's answer. */
  onDecided?: (r: DecideResult) => void
  /** Escape or Back. */
  onBack?: () => void
  headingLevel?: HeadingLevel
  className?: string
}

export function ApprovalDetail(p: ApprovalDetailProps): ReactNode {
  const { text, ui } = useUi()
  const now = useNow()
  const a = p.approval
  const v = approvalView(a, a, now)
  const id = useId()
  const [mode, setMode] = useState<'view' | 'stepup' | 'refuse'>('view')
  const [typed, setTyped] = useState('')
  const [reason, setReason] = useState('')
  const [busy, setBusy] = useState(false)
  const [note, setNote] = useState<{ text: string; error: boolean } | null>(null)
  const heading = useFocusAfter<HTMLHeadingElement>()
  const status = useFocusAfter<HTMLParagraphElement>()
  const approveBtn = useFocusAfter<HTMLButtonElement>()
  const slot = useFocusAfter<HTMLDivElement>()
  const reasonBox = useFocusAfter<HTMLTextAreaElement>()
  // A new approval opens with its heading focused, so the reader starts at the top.
  useEffect(() => heading.focus(), [a.id])

  const decide = async (body: DecideBody) => {
    if (!ui) return
    setBusy(true)
    setNote(null)
    try {
      const r = await ui.approvals.decide(a.id, body)
      const said = (text.decideOutcome as Record<string, string>)[r.outcome]
      const ran = r.execution ? (r.execution.outcome === 'ok' ? text.ranOk : text.ranNot(r.execution.message ?? r.execution.outcome)) : ''
      const failed = !['approved', 'refused'].includes(r.outcome)
      setNote({ text: [said ?? r.message ?? r.outcome, r.message && said ? r.message : '', ran].filter(Boolean).join(' '), error: failed })
      setMode('view')
      p.onDecided?.(r)
    } catch (e) {
      setNote({ text: (e as Error)?.message || text.errorGeneric, error: true })
    } finally {
      setBusy(false)
      status.focus()
    }
  }
  const approve = () => {
    setNote(null)
    if (a.needs.typedTarget && !typed.trim()) {
      setNote({ text: text.typeTarget, error: true })
      return
    }
    if (a.needs.stepUp.length) {
      setMode('stepup')
      slot.focus()
      return
    }
    void decide({ approve: true, ...(a.needs.typedTarget ? { typedTarget: typed.trim() } : {}) })
  }
  const cancelStepUp = () => {
    setMode('view')
    approveBtn.focus()
  }
  const refuse = (e: { preventDefault(): void }) => {
    e.preventDefault()
    if (!reason.trim()) {
      setNote({ text: text.reasonRequired, error: true })
      reasonBox.focus()
      return
    }
    void decide({ approve: false, reason: reason.trim() })
  }
  const waiting = v.status === 'waiting'
  const statusText = (text.approvalStatus as Record<string, string>)[v.status] ?? v.status

  return h(
    'section',
    {
      className: cx('omz-section omz-inbox__detail', p.className),
      'aria-labelledby': `${id}t`,
      onKeyDown: (e: KeyboardEvent) => {
        if (e.key !== 'Escape' || e.defaultPrevented) return
        e.preventDefault()
        if (mode === 'stepup') cancelStepUp()
        else if (mode === 'refuse') {
          setMode('view')
          approveBtn.focus()
        } else p.onBack?.()
      },
    },
    h(Heading, { level: p.headingLevel ?? 3, id: `${id}t`, tabIndex: -1, headingRef: (el) => (heading.ref.current = el) }, v.title),
    h('p', { className: 'omz-card__summary' }, v.summary),
    h(Diff, { rows: v.rows, text }),
    h(
      'dl',
      { className: 'omz-rows' },
      h('dt', null, text.labelDecider),
      h('dd', null, h('span', { className: 'omz-badge' }, a.tier), ' ', v.decider),
      h('dt', null, text.labelAsked),
      h('dd', null, personName(a.requester), ', ', formatDate(text, a.createdAt)),
      waiting
        ? [
            h('dt', { key: 'et' }, text.labelExpires),
            h('dd', { key: 'ed' }, Number.isFinite(v.expiry.minutes) && v.expiry.minutes <= 120 ? text.expiresIn(formatNumber(text, v.expiry.minutes)) : formatDate(text, a.expiresAt)),
          ]
        : null,
      a.decidedBy ? [h('dt', { key: 'dt' }, text.labelDecided), h('dd', { key: 'dd' }, text.decidedAt(personName(a.decidedBy), formatDate(text, a.decidedAt)))] : null,
      a.reason ? [h('dt', { key: 'rt' }, text.reason), h('dd', { key: 'rd' }, a.reason)] : null,
    ),
    h('p', { ref: status.ref, tabIndex: -1, className: 'omz-status', 'data-status': v.status, role: 'status' }, statusText),
    note ? h('p', { className: note.error ? 'omz-error' : 'omz-note', role: note.error ? 'alert' : undefined }, note.text) : null,
    waiting && !a.canDecide ? h('p', { className: 'omz-note' }, a.why ?? text.cannotDecide) : null,
    waiting && a.canDecide && mode !== 'refuse' && a.needs.typedTarget
      ? h(
          'label',
          { className: 'omz-field' },
          h('span', null, text.typeTarget),
          h('input', { value: typed, autoComplete: 'off', spellCheck: false, disabled: busy || mode === 'stepup', onChange: (e: { target: { value: string } }) => setTyped(e.target.value) }),
        )
      : null,
    waiting && a.canDecide && mode === 'view'
      ? h(
          'div',
          { className: 'omz-card__actions' },
          h('button', { type: 'button', ref: approveBtn.ref, className: 'omz-btn omz-btn--primary', disabled: busy, onClick: approve }, text.approve),
          h(
            'button',
            {
              type: 'button',
              className: 'omz-btn omz-btn--danger',
              disabled: busy,
              onClick: () => {
                setNote(null)
                setMode('refuse')
                reasonBox.focus()
              },
            },
            text.refuse,
          ),
        )
      : null,
    waiting && a.canDecide && mode === 'refuse'
      ? h(
          'form',
          { className: 'omz-section', onSubmit: refuse },
          h('label', { className: 'omz-field' }, h('span', null, text.reason), h('textarea', { ref: reasonBox.ref, value: reason, rows: 3, 'aria-required': true, onChange: (e: { target: { value: string } }) => setReason(e.target.value) })),
          h(
            'div',
            { className: 'omz-card__actions' },
            h('button', { type: 'submit', className: 'omz-btn omz-btn--danger', disabled: busy }, text.refuse),
            h(
              'button',
              {
                type: 'button',
                className: 'omz-btn',
                disabled: busy,
                onClick: () => {
                  setMode('view')
                  approveBtn.focus()
                },
              },
              text.cancel,
            ),
          ),
        )
      : null,
    waiting && a.canDecide && mode === 'stepup'
      ? h(
          'div',
          { ref: slot.ref, tabIndex: -1, className: 'omz-stepup', role: 'group', 'aria-labelledby': `${id}su` },
          h('p', { id: `${id}su`, className: 'omz-card__title' }, text.stepUpTitle),
          p.stepUp
            ? p.stepUp({
                approval: a,
                methods: [...a.needs.stepUp],
                done: (proof) => void decide({ approve: true, proof, ...(a.needs.typedTarget ? { typedTarget: typed.trim() } : {}) }),
                cancel: cancelStepUp,
              })
            : [h('p', { key: 'm', className: 'omz-note' }, text.stepUpMissing), h('button', { key: 'c', type: 'button', className: 'omz-btn', onClick: cancelStepUp }, text.cancel)],
        )
      : null,
    v.reviewUrl ? h('p', null, h('a', { href: v.reviewUrl, className: 'omz-link' }, text.openReview)) : null,
    p.onBack ? h('p', null, h('button', { type: 'button', className: 'omz-btn', onClick: p.onBack }, text.back)) : null,
  )
}

export interface ApprovalsInboxProps {
  stepUp?: ApprovalDetailProps['stepUp']
  /** Which list opens first. Default `waiting`. */
  initial?: 'waiting' | 'all'
  /** How often the list reloads, in ms. Default 30000; 0 turns it off. */
  pollMs?: number
  headingLevel?: HeadingLevel
  onDecided?: (r: DecideResult) => void
  className?: string
}

export function ApprovalsInbox(p: ApprovalsInboxProps): ReactNode {
  const { text, ui } = useUi()
  const now = useNow()
  const id = useId()
  const [filter, setFilter] = useState<'waiting' | 'all'>(p.initial ?? 'waiting')
  const [open, setOpen] = useState<string | null>(null)
  const list = useResource(() => (ui ? ui.approvals.list({ status: filter }) : Promise.resolve([])), [ui, filter], { pollMs: p.pollMs ?? 30_000 })
  const level = p.headingLevel ?? 2
  const back = () => {
    const was = open
    setOpen(null)
    if (was) queueMicrotask(() => document.getElementById(`${id}-${was}`)?.focus())
  }
  return h(
    'section',
    { className: cx('omz omz-section', p.className), 'aria-labelledby': `${id}h` },
    h(Heading, { level, id: `${id}h` }, text.approvals),
    h(
      'div',
      { className: 'omz-card__actions', role: 'group', 'aria-label': text.approvals },
      (['waiting', 'all'] as const).map((f) =>
        h(
          'button',
          {
            key: f,
            type: 'button',
            className: 'omz-btn',
            'aria-pressed': filter === f,
            onClick: () => {
              setFilter(f)
              setOpen(null)
            },
          },
          f === 'waiting' ? text.approvalsWaiting : text.approvalsAll,
        ),
      ),
    ),
    h(Loadable<ApprovalItem[]>, {
      state: list,
      children: (items) => {
        const current = open ? items.find((x) => x.id === open) : undefined
        return h(
          'div',
          { className: 'omz-inbox' },
          items.length
            ? h(
                'ul',
                { className: 'omz-list', 'aria-label': text.approvals, onKeyDown: (e: KeyboardEvent<HTMLElement>) => listKeys(e) },
                items.map((a) => {
                  const v = approvalView(a, a, now)
                  return h(
                    'li',
                    { key: a.id },
                    h(
                      'button',
                      { id: `${id}-${a.id}`, type: 'button', 'data-omz-item': '', className: 'omz-inbox__pick', 'aria-current': open === a.id ? 'true' : undefined, onClick: () => setOpen(a.id) },
                      h('strong', null, v.title),
                      h('br'),
                      h('span', null, v.summary),
                      h('br'),
                      h('span', { className: 'omz-meta' }, text.requestedBy(personName(a.requester), formatDate(text, a.createdAt))),
                      ' ',
                      h('span', { className: 'omz-badge', 'data-status': v.status }, (text.approvalBadge as Record<string, string>)[v.status] ?? v.status),
                    ),
                  )
                }),
              )
            : h('p', { className: 'omz-note' }, text.noApprovals),
          current
            ? h(ApprovalDetail, {
                key: current.id,
                approval: current,
                ...(p.stepUp ? { stepUp: p.stepUp } : {}),
                headingLevel: (level + 1) as HeadingLevel,
                onBack: back,
                onDecided: (r) => {
                  if (r.approval) list.set((cur) => (cur ?? []).map((x) => (x.id === r.approval!.id ? r.approval! : x)))
                  p.onDecided?.(r)
                },
              })
            : null,
        )
      },
    }),
  )
}

// The copilot panel: the conversation, its cards, the error sentence and the
// composer. It runs on its own chat (`useCopilotChat`) or on one the product
// passes, such as `useChat` from `@ai-sdk/react` pointed at the copilot.

import { createElement as h, type FormEvent, type KeyboardEvent, type ReactNode, useEffect, useId, useRef, useState } from 'react'
import type { ChatLike, ChatMessage, ChatPart } from '../chat.js'
import type { ActorData, CardOutcomeData, ConsentCardData, MemorySuggestionData } from '../types.js'
import { actorDataOf, cardAfter, partView, replaceDataPart } from '../views.js'
import { cx } from './bits.js'
import { ActorCard, ApprovalCard, ConsentCard, MemorySuggestion } from './cards.js'
import { useUi } from './context.js'
import { useCopilotChat, useReducedMotion } from './hooks.js'

export interface CopilotPanelProps {
  /** The thread id: 1 to 64 letters, digits, - or _. */
  thread: string
  /** A chat to render instead of the panel's own, such as `useChat(...)` from `@ai-sdk/react`. */
  chat?: ChatLike
  /** The screen the person is on, sent with each message. The server rebuilds the context from it. */
  screen?: { name: string; id?: string | null } | null
  /** The panel's accessible name. Default "Copilot". */
  label?: string
  /** Names for actors, by id. */
  actorTitles?: Record<string, string>
  /** How often an approval card fetches its status, in ms. Default 15000; 0 turns it off. Events replace this when stream resume lands. */
  approvalPollMs?: number
  /** Render a part yourself; return undefined to use the default. */
  renderPart?: (part: ChatPart, message: ChatMessage) => ReactNode | undefined
  /** Every card click's outcome, after the panel updated the card. */
  onCardOutcome?: (out: CardOutcomeData) => void
  className?: string
}

export function CopilotPanel(p: CopilotPanelProps): ReactNode {
  const { text, copilot, ui } = useUi()
  const own = useCopilotChat({ thread: p.thread, body: () => (p.screen ? { screen: p.screen } : {}), loadHistory: !p.chat })
  const chat: ChatLike = p.chat ?? own
  const busy = chat.status === 'submitted' || chat.status === 'streaming'
  const reduced = useReducedMotion()
  const id = useId()
  const [draft, setDraft] = useState('')
  const log = useRef<HTMLDivElement | null>(null)
  const input = useRef<HTMLTextAreaElement | null>(null)

  // Follow the newest message, unless the person scrolled up to read.
  const last = chat.messages[chat.messages.length - 1]
  const lastSize = last ? last.parts.reduce((n, x) => n + (x.text?.length ?? 1), 0) : 0
  useEffect(() => {
    const el = log.current
    if (!el || typeof el.scrollTo !== 'function') return
    if (el.scrollHeight - el.scrollTop - el.clientHeight > 160) return
    el.scrollTo({ top: el.scrollHeight, behavior: reduced ? 'auto' : 'smooth' })
  }, [chat.messages.length, lastSize, reduced])

  const send = (e?: FormEvent) => {
    e?.preventDefault()
    const t = draft.trim()
    if (!t || busy) return
    setDraft('')
    void chat.sendMessage({ text: t })
    input.current?.focus()
  }
  const onKey = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    // Enter sends; Shift and Enter is a new line; Enter while an input method composes (Bangla, for one) is the composer's.
    if (e.key === 'Enter' && !e.shiftKey && !(e.nativeEvent as { isComposing?: boolean }).isComposing) send(e as unknown as FormEvent)
  }

  const consent = async (card: ConsentCardData, which: 'confirm' | 'decline') => {
    const out = await copilot[which](p.thread, card.id)
    const r = cardAfter(card, out, text)
    if (r.card !== card) chat.setMessages((m) => replaceDataPart(m, 'data-consent', card.id, r.card))
    p.onCardOutcome?.(out)
    return r.note
  }
  const actorCard = async (a: ActorData, cardId: string, which: 'confirm' | 'decline') => {
    const out = await copilot[which](p.thread, cardId)
    p.onCardOutcome?.(out)
    if (out.outcome === 'actor') {
      chat.setMessages((m) => replaceDataPart(m, 'data-actor', a.session, actorDataOf(out.reply)))
      return undefined
    }
    return out.outcome === 'busy' ? text.cardBusy : out.outcome === 'not_found' ? text.cardNotFound : undefined
  }
  const memory = (m: MemorySuggestionData, which: 'confirm' | 'reject') =>
    ui
      ? async () => {
          const r = await ui.memory[which](m.id)
          if (r.ok) chat.setMessages((all) => replaceDataPart(all, 'data-memory', m.id, { ...m, status: r.item.status }))
          else return text.loadFailed
          return undefined
        }
      : undefined

  const part = (x: ChatPart, m: ChatMessage, i: number): ReactNode => {
    const custom = p.renderPart?.(x, m)
    if (custom !== undefined) return custom
    const v = partView(x)
    switch (v.kind) {
      case 'text':
        return v.text ? h('p', { key: i, className: 'omz-text' }, v.text) : null
      case 'consent':
        return h(ConsentCard, { key: `c${v.id}`, card: v.card, onConfirm: () => consent(v.card, 'confirm'), onDecline: () => consent(v.card, 'decline') })
      case 'approval':
        return h(ApprovalCard, { key: `a${v.id}`, card: v.card, ...(p.approvalPollMs !== undefined ? { pollMs: p.approvalPollMs } : {}) })
      case 'actor':
        return h(ActorCard, {
          key: `s${v.id}`,
          actor: v.actor,
          ...(p.actorTitles?.[v.actor.actor] ? { title: p.actorTitles[v.actor.actor] } : {}),
          onChoose: (answer: string) => void chat.sendMessage({ text: answer }),
          onConfirm: (cardId: string) => actorCard(v.actor, cardId, 'confirm'),
          onDecline: (cardId: string) => actorCard(v.actor, cardId, 'decline'),
        })
      case 'memory':
        return h(MemorySuggestion, { key: `m${v.id}`, memory: v.memory, onConfirm: memory(v.memory, 'confirm'), onReject: memory(v.memory, 'reject') })
      default:
        return null
    }
  }

  const error = chat.error ? chat.error.message || text.errorGeneric : null
  return h(
    'section',
    { className: cx('omz omz-panel', p.className), 'aria-label': p.label ?? text.copilot },
    h(
      'div',
      { ref: log, className: 'omz-log', role: 'log', 'aria-label': text.conversation, 'aria-busy': busy || undefined, tabIndex: 0 },
      chat.messages.map((m) =>
        h(
          'div',
          { key: m.id, className: cx('omz-msg', `omz-msg--${m.role}`) },
          h('span', { className: 'omz-msg__who omz-sr' }, m.role === 'user' ? text.you : text.assistant),
          m.parts.map((x, i) => part(x, m, i)),
        ),
      ),
      chat.status === 'submitted' ? h('p', { className: 'omz-working', role: 'status' }, text.working) : null,
    ),
    error ? h('p', { className: 'omz-error', role: 'alert' }, error) : null,
    h(
      'form',
      { className: 'omz-composer', onSubmit: send },
      h('label', { htmlFor: `${id}in`, className: 'omz-sr' }, text.composerLabel),
      h('textarea', {
        id: `${id}in`,
        ref: input,
        className: 'omz-input',
        rows: 2,
        value: draft,
        placeholder: text.composerPlaceholder,
        'aria-describedby': `${id}hint`,
        onChange: (e: { target: { value: string } }) => setDraft(e.target.value),
        onKeyDown: onKey,
      }),
      h('p', { id: `${id}hint`, className: 'omz-sr' }, text.composerHint),
      busy && chat.stop
        ? h('button', { type: 'button', className: 'omz-btn', onClick: () => void chat.stop?.() }, text.stop)
        : h('button', { type: 'submit', className: 'omz-btn omz-btn--primary', disabled: busy || !draft.trim() }, text.send),
    ),
  )
}

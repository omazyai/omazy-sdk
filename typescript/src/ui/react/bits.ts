// Small pieces the screens share: class names, headings, the before and
// after table, a two-step destructive button, and loading states.

import { createElement as h, type KeyboardEvent, type ReactNode, useState } from 'react'
import type { ResourceState } from '../store.js'
import type { UiText } from '../text.js'
import { type DiffRow, formatValue } from '../views.js'
import { useUi } from './context.js'
import { useFocusAfter } from './hooks.js'

export const cx = (...names: (string | false | null | undefined)[]): string => names.filter(Boolean).join(' ')

export type HeadingLevel = 2 | 3 | 4 | 5

export function Heading(p: { level: HeadingLevel; id?: string; className?: string; children?: ReactNode; tabIndex?: number; headingRef?: (el: HTMLHeadingElement | null) => void }): ReactNode {
  return h(`h${p.level}`, { id: p.id, className: p.className, tabIndex: p.tabIndex, ref: p.headingRef }, p.children)
}

/** The preview's before and after. A single value is two lines; an object is a table, changed fields first. */
export function Diff(p: { rows: DiffRow[]; text: UiText }): ReactNode {
  const { rows, text } = p
  if (!rows.length) return null
  const v = (x: unknown) => formatValue(text, x)
  if (rows.length === 1 && rows[0]!.field === '') {
    const r = rows[0]!
    return h(
      'dl',
      { className: 'omz-rows omz-diff--single' },
      r.before !== undefined && [h('dt', { key: 'bt' }, text.before), h('dd', { key: 'bd' }, v(r.before))],
      r.after !== undefined && [h('dt', { key: 'at' }, text.after), h('dd', { key: 'ad' }, v(r.after))],
    )
  }
  return h(
    'table',
    { className: 'omz-diff' },
    h('caption', { className: 'omz-sr' }, text.details),
    h('thead', null, h('tr', null, h('th', { scope: 'col' }, text.field), h('th', { scope: 'col' }, text.before), h('th', { scope: 'col' }, text.after))),
    h(
      'tbody',
      null,
      rows.map((r) =>
        h(
          'tr',
          { key: r.field, 'data-changed': String(r.changed) },
          h('th', { scope: 'row' }, r.field),
          h('td', null, r.added ? text.none : v(r.before)),
          h('td', null, r.removed ? text.none : v(r.after)),
        ),
      ),
    ),
  )
}

/**
 * A button that asks once more before it acts: the first press shows the
 * question with Yes and Cancel, Escape or Cancel goes back.
 */
export function ConfirmAction(p: { label: string; ask: string; onConfirm: () => Promise<unknown> | unknown; danger?: boolean; describedBy?: string }): ReactNode {
  const { text } = useUi()
  const [open, setOpen] = useState(false)
  const [busy, setBusy] = useState(false)
  const yes = useFocusAfter<HTMLButtonElement>()
  const back = useFocusAfter<HTMLButtonElement>()
  const close = () => {
    setOpen(false)
    back.focus()
  }
  if (!open) {
    return h(
      'button',
      {
        type: 'button',
        ref: back.ref,
        className: cx('omz-btn', p.danger !== false && 'omz-btn--danger'),
        'aria-describedby': p.describedBy,
        onClick: () => {
          setOpen(true)
          yes.focus()
        },
      },
      p.label,
    )
  }
  return h(
    'span',
    {
      className: 'omz-confirm',
      role: 'group',
      'aria-label': p.ask,
      onKeyDown: (e: KeyboardEvent) => {
        if (e.key === 'Escape') {
          e.stopPropagation()
          close()
        }
      },
    },
    h('span', null, p.ask),
    h(
      'button',
      {
        type: 'button',
        ref: yes.ref,
        className: cx('omz-btn', p.danger !== false && 'omz-btn--danger'),
        disabled: busy,
        onClick: async () => {
          setBusy(true)
          try {
            await p.onConfirm()
          } finally {
            setBusy(false)
            setOpen(false)
          }
        },
      },
      text.yes,
    ),
    h('button', { type: 'button', className: 'omz-btn', disabled: busy, onClick: close }, text.cancel),
  )
}

/** Loading, a load error with a retry, or the content. */
export function Loadable<T>(p: { state: ResourceState<T> & { refresh(): Promise<void> }; children: (data: T) => ReactNode }): ReactNode {
  const { text } = useUi()
  const s = p.state
  if (s.data !== undefined) {
    return [
      s.status === 'error' ? h('p', { key: 'e', className: 'omz-error', role: 'alert' }, text.loadFailed, ' ', h('button', { type: 'button', className: 'omz-btn', onClick: () => void s.refresh() }, text.retry)) : null,
      h('div', { key: 'c' }, p.children(s.data)),
    ]
  }
  if (s.status === 'error') {
    return h('p', { className: 'omz-error', role: 'alert' }, s.error?.message || text.loadFailed, ' ', h('button', { type: 'button', className: 'omz-btn', onClick: () => void s.refresh() }, text.retry))
  }
  return h('p', { className: 'omz-note', role: 'status' }, text.loading)
}

/** Arrow keys, Home and End move focus between the buttons of a list. */
export function listKeys(e: KeyboardEvent<HTMLElement>, selector = 'button[data-omz-item]'): void {
  if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(e.key)) return
  const items = [...e.currentTarget.querySelectorAll<HTMLElement>(selector)]
  if (!items.length) return
  const at = items.indexOf(e.target as HTMLElement)
  const next = e.key === 'Home' ? 0 : e.key === 'End' ? items.length - 1 : e.key === 'ArrowDown' ? Math.min(items.length - 1, at + 1) : Math.max(0, at < 0 ? 0 : at - 1)
  e.preventDefault()
  items[next]!.focus()
}

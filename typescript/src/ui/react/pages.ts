// The settings screens: connected apps and keys, what the AI remembers, and
// standing grants. Each loads from `uiRoutes`, changes one row at a time,
// and says what happened in a status line.

import { createElement as h, type FormEvent, type ReactNode, useId, useState } from 'react'
import { formatDate, formatNumber } from '../text.js'
import type { AppsData, GrantsData, MemoryItem } from '../types.js'
import { activeGrants, memoryGroups } from '../views.js'
import { ConfirmAction, cx, Heading, type HeadingLevel, Loadable } from './bits.js'
import { useUi } from './context.js'
import { useNow, useResource } from './hooks.js'

interface PageProps {
  headingLevel?: HeadingLevel
  className?: string
}

/** The sentence after a change, spoken politely; errors are alerts. */
function useSay() {
  const [said, setSaid] = useState<{ text: string; error: boolean } | null>(null)
  const node = h('p', { className: said?.error ? 'omz-error' : 'omz-note', role: said?.error ? 'alert' : 'status' }, said?.text ?? '')
  return { node, say: (text: string, error = false) => setSaid({ text, error }) }
}

// ---------------------------------------------------------------- connected apps

export function ConnectedApps(p: PageProps): ReactNode {
  const { text, ui } = useUi()
  const id = useId()
  const data = useResource<AppsData>(() => (ui ? ui.apps.list() : Promise.resolve({ apps: [], keys: [] })), [ui])
  const { node, say } = useSay()
  const level = p.headingLevel ?? 2
  const sub = (level + 1) as HeadingLevel
  return h(
    'section',
    { className: cx('omz omz-section', p.className), 'aria-labelledby': `${id}h` },
    h(Heading, { level, id: `${id}h` }, text.connectedApps),
    node,
    h(Loadable<AppsData>, {
      state: data,
      children: (d) => [
        h(
          'section',
          { key: 'a', className: 'omz-section', 'aria-labelledby': `${id}a` },
          h(Heading, { level: sub, id: `${id}a` }, text.apps),
          d.apps.length
            ? h(
                'ul',
                { className: 'omz-list' },
                d.apps.map((a) =>
                  h(
                    'li',
                    { key: a.grantId, className: 'omz-item' },
                    h('div', { className: 'omz-item__row' }, h('strong', { id: `${id}-${a.grantId}` }, a.clientName), h('span', { className: 'omz-badge', 'data-status': a.status }, text.clientStatus[a.status])),
                    h(
                      'p',
                      { className: 'omz-meta' },
                      [a.door, a.tenant, text.connectedOn(formatDate(text, a.createdAt)), a.lastUsedAt ? text.lastUsed(formatDate(text, a.lastUsedAt)) : text.neverUsed, a.expiresAt ? text.expiresOn(formatDate(text, a.expiresAt)) : null]
                        .filter(Boolean)
                        .join(' · '),
                    ),
                    h(ConfirmAction, {
                      label: text.revoke,
                      ask: text.revokeAsk(a.clientName),
                      describedBy: `${id}-${a.grantId}`,
                      onConfirm: async () => {
                        if (!ui) return
                        try {
                          if (await ui.apps.revoke(a.grantId)) {
                            data.set((cur) => ({ ...(cur ?? d), apps: (cur ?? d).apps.filter((x) => x.grantId !== a.grantId) }))
                            say(text.revoked(a.clientName))
                          } else say(text.loadFailed, true)
                        } catch (e) {
                          say((e as Error).message || text.errorGeneric, true)
                        }
                      },
                    }),
                  ),
                ),
              )
            : h('p', { className: 'omz-note' }, text.noApps),
        ),
        h(
          'section',
          { key: 'k', className: 'omz-section', 'aria-labelledby': `${id}k` },
          h(Heading, { level: sub, id: `${id}k` }, text.keys),
          d.keys.length
            ? h(
                'ul',
                { className: 'omz-list' },
                d.keys.map((k) =>
                  h(
                    'li',
                    { key: k.id, className: 'omz-item' },
                    h('div', { className: 'omz-item__row' }, h('strong', { id: `${id}-${k.id}` }, k.name), h('span', { className: 'omz-badge' }, text.keyKind[k.kind])),
                    h(
                      'p',
                      { className: 'omz-meta' },
                      [k.door, k.tenant, k.maxTier, k.lastUsedAt ? text.lastUsed(formatDate(text, k.lastUsedAt)) : text.neverUsed, text.expiresOn(formatDate(text, k.expiresAt))].filter(Boolean).join(' · '),
                    ),
                    h(ConfirmAction, {
                      label: text.revoke,
                      ask: text.revokeAsk(k.name),
                      describedBy: `${id}-${k.id}`,
                      onConfirm: async () => {
                        if (!ui) return
                        try {
                          if (await ui.apps.revokeKey(k.id)) {
                            data.set((cur) => ({ ...(cur ?? d), keys: (cur ?? d).keys.filter((x) => x.id !== k.id) }))
                            say(text.revoked(k.name))
                          } else say(text.loadFailed, true)
                        } catch (e) {
                          say((e as Error).message || text.errorGeneric, true)
                        }
                      },
                    }),
                  ),
                ),
              )
            : h('p', { className: 'omz-note' }, text.noKeys),
        ),
      ],
    }),
  )
}

// ---------------------------------------------------------------- memory

export function MemoryPage(p: PageProps): ReactNode {
  const { text, ui } = useUi()
  const id = useId()
  const data = useResource<MemoryItem[]>(() => (ui ? ui.memory.list() : Promise.resolve([])), [ui])
  const { node, say } = useSay()
  const level = p.headingLevel ?? 2
  const sub = (level + 1) as HeadingLevel
  const replace = (item: MemoryItem) => data.set((cur) => (cur ?? []).map((x) => (x.id === item.id ? item : x)))
  const decide = async (m: MemoryItem, which: 'confirm' | 'reject') => {
    if (!ui) return
    try {
      const r = await ui.memory[which](m.id)
      if (r.ok) {
        replace(r.item)
        say(which === 'confirm' ? text.memoryDecided.confirmed : text.memoryDecided.rejected)
      } else say(text.loadFailed, true)
    } catch (e) {
      say((e as Error).message || text.errorGeneric, true)
    }
  }
  const source = (m: MemoryItem) =>
    [m.unit ? text.memorySource(m.unit, formatDate(text, m.proposedAt)) : formatDate(text, m.proposedAt), m.decidedBy ? text.memoryConfirmedBy(m.decidedBy, formatDate(text, m.decidedAt)) : null]
      .filter(Boolean)
      .join(' · ')
  return h(
    'section',
    { className: cx('omz omz-section', p.className), 'aria-labelledby': `${id}h` },
    h(Heading, { level, id: `${id}h` }, text.memoryTitle),
    node,
    h(Loadable<MemoryItem[]>, {
      state: data,
      children: (items) => {
        const g = memoryGroups(items)
        return [
          h(
            'section',
            { key: 'p', className: 'omz-section', 'aria-labelledby': `${id}p` },
            h(Heading, { level: sub, id: `${id}p` }, text.memoryPending),
            g.pending.length
              ? h(
                  'ul',
                  { className: 'omz-list' },
                  g.pending.map((m) =>
                    h(
                      'li',
                      { key: m.id, className: 'omz-item' },
                      h('p', { className: 'omz-card__summary', id: `${id}-${m.id}` }, m.text),
                      h('p', { className: 'omz-meta' }, text.memoryScope[m.scope], ' · ', source(m)),
                      h(
                        'div',
                        { className: 'omz-card__actions' },
                        h('button', { type: 'button', className: 'omz-btn omz-btn--primary', 'aria-describedby': `${id}-${m.id}`, onClick: () => void decide(m, 'confirm') }, text.remember),
                        h('button', { type: 'button', className: 'omz-btn', 'aria-describedby': `${id}-${m.id}`, onClick: () => void decide(m, 'reject') }, text.dontRemember),
                      ),
                    ),
                  ),
                )
              : h('p', { className: 'omz-note' }, text.noPending),
          ),
          h(
            'section',
            { key: 'c', className: 'omz-section', 'aria-labelledby': `${id}c` },
            h(Heading, { level: sub, id: `${id}c` }, text.memoryConfirmed),
            g.confirmed.length
              ? h(
                  'ul',
                  { className: 'omz-list' },
                  g.confirmed.map((m) =>
                    h(
                      'li',
                      { key: m.id, className: 'omz-item' },
                      h('p', { className: 'omz-card__summary', id: `${id}-${m.id}` }, m.text),
                      h('p', { className: 'omz-meta' }, text.memoryScope[m.scope], ' · ', source(m)),
                      h(ConfirmAction, {
                        label: text.forget,
                        ask: text.forgetAsk(m.text.length > 60 ? `${m.text.slice(0, 57)}...` : m.text),
                        describedBy: `${id}-${m.id}`,
                        onConfirm: async () => {
                          if (!ui) return
                          try {
                            if (await ui.memory.forget(m.id)) {
                              data.set((cur) => (cur ?? []).filter((x) => x.id !== m.id))
                              say(text.memoryDecided.forgotten)
                            } else say(text.loadFailed, true)
                          } catch (e) {
                            say((e as Error).message || text.errorGeneric, true)
                          }
                        },
                      }),
                    ),
                  ),
                )
              : h('p', { className: 'omz-note' }, text.noMemories),
          ),
        ]
      },
    }),
  )
}

// ---------------------------------------------------------------- standing grants

export function StandingGrants(p: PageProps): ReactNode {
  const { text, ui } = useUi()
  const now = useNow()
  const id = useId()
  const data = useResource<GrantsData>(() => (ui ? ui.grants.list() : Promise.resolve({ grants: [], options: { capabilities: [], maxDays: 90, maxDailyCap: 500 } })), [ui])
  const { node, say } = useSay()
  const [cap, setCap] = useState('')
  const [days, setDays] = useState('30')
  const [daily, setDaily] = useState('10')
  const [busy, setBusy] = useState(false)
  const level = p.headingLevel ?? 2
  return h(
    'section',
    { className: cx('omz omz-section', p.className), 'aria-labelledby': `${id}h`, 'aria-describedby': `${id}d` },
    h(Heading, { level, id: `${id}h` }, text.grantsTitle),
    h('p', { id: `${id}d`, className: 'omz-note' }, text.grantsHelp),
    node,
    h(Loadable<GrantsData>, {
      state: data,
      children: (d) => {
        const list = activeGrants(d.grants, now)
        const options = d.options.capabilities
        const chosen = cap || options[0]?.name || ''
        const submit = async (e: FormEvent) => {
          e.preventDefault()
          if (!ui || !chosen) return
          setBusy(true)
          try {
            const r = await ui.grants.set({ capability: chosen, days: Number(days), dailyCap: Number(daily) })
            if (r.ok) {
              await data.refresh()
              say(text.grantSaved(r.grant.title))
            } else say(r.message, true)
          } catch (err) {
            say((err as Error).message || text.errorGeneric, true)
          } finally {
            setBusy(false)
          }
        }
        return [
          list.length
            ? h(
                'ul',
                { key: 'l', className: 'omz-list' },
                list.map((g) =>
                  h(
                    'li',
                    { key: g.id, className: 'omz-item' },
                    h('strong', { id: `${id}-${g.id}` }, g.title),
                    h(
                      'p',
                      { className: 'omz-meta' },
                      [text.expiresOn(formatDate(text, g.expiresAt)), g.left !== null ? text.grantLeft(formatNumber(text, g.left), formatNumber(text, g.dailyCap)) : null].filter(Boolean).join(' · '),
                    ),
                    h(ConfirmAction, {
                      label: text.revoke,
                      ask: text.revokeAsk(g.title),
                      describedBy: `${id}-${g.id}`,
                      onConfirm: async () => {
                        if (!ui) return
                        try {
                          if (await ui.grants.revoke(g.id)) {
                            data.set((cur) => ({ ...(cur ?? d), grants: (cur ?? d).grants.filter((x) => x.id !== g.id) }))
                            say(text.revoked(g.title))
                          } else say(text.loadFailed, true)
                        } catch (e) {
                          say((e as Error).message || text.errorGeneric, true)
                        }
                      },
                    }),
                  ),
                ),
              )
            : h('p', { key: 'n', className: 'omz-note' }, text.noGrants),
          options.length
            ? h(
                'form',
                { key: 'f', className: 'omz-form', onSubmit: submit },
                h(
                  'label',
                  { className: 'omz-field' },
                  h('span', null, text.capability),
                  h(
                    'select',
                    { value: chosen, onChange: (e: { target: { value: string } }) => setCap(e.target.value) },
                    options.map((o) => h('option', { key: o.name, value: o.name }, o.title)),
                  ),
                ),
                h(
                  'label',
                  { className: 'omz-field' },
                  h('span', null, text.days),
                  h('input', { type: 'number', inputMode: 'numeric', min: 1, max: d.options.maxDays, required: true, value: days, onChange: (e: { target: { value: string } }) => setDays(e.target.value) }),
                ),
                h(
                  'label',
                  { className: 'omz-field' },
                  h('span', null, text.dailyCap),
                  h('input', { type: 'number', inputMode: 'numeric', min: 1, max: d.options.maxDailyCap, required: true, value: daily, onChange: (e: { target: { value: string } }) => setDaily(e.target.value) }),
                ),
                h('button', { type: 'submit', className: 'omz-btn omz-btn--primary', disabled: busy }, text.addGrant),
              )
            : null,
        ]
      },
    }),
  )
}

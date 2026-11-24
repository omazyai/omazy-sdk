// The React components in a light DOM (happy-dom): each renders its states,
// cards move focus to their outcome, and the keyboard works (Enter sends,
// Shift and Enter does not, arrows walk the inbox, Escape backs out of a
// step-up or a revoke). The data comes from uiRoutes over real kits and a
// scripted copilot.

import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { uiWriter } from '../src/copilot/index'
import type { ConsentCardData } from '../src/ui/index'
import { byText, openDom } from './ui-dom'
import { ctxOf, kit } from './ui-fixtures'

let dom: Awaited<ReturnType<typeof openDom>>
let ui: typeof import('../src/ui/react/index')
let h: typeof import('react').createElement

beforeAll(async () => {
  dom = await openDom()
  ui = await import('../src/ui/react/index')
  h = dom.React.createElement
})
afterAll(async () => dom?.close())

const card = (over: Partial<ConsentCardData> = {}): ConsentCardData => ({
  kind: 'consent',
  id: 'card_1',
  capability: 'brief_update',
  title: 'Update the brief',
  tier: 'R2',
  preview: { summary: 'Change the greeting to Hello.', before: { greeting: 'Hi' }, after: { greeting: 'Hello' } },
  input: { greeting: 'Hello' },
  expiresAt: new Date(Date.now() + 9 * 60_000).toISOString(),
  status: 'waiting',
  ...over,
})

describe('ui react: cards', () => {
  test('consent card: preview with before and after, the click, and focus on the outcome', async () => {
    let clicked = ''
    const el = await dom.render(h(ui.ConsentCard, { card: card(), onConfirm: async () => void (clicked = 'confirm'), onDecline: () => void (clicked = 'decline') }))
    const art = el.querySelector('article')!
    expect(art.getAttribute('data-status')).toBe('waiting')
    expect(document.getElementById(art.getAttribute('aria-labelledby')!)?.textContent).toBe('Update the brief')
    expect(el.querySelector('table caption')?.textContent).toBe('Details')
    expect([...el.querySelectorAll('tbody td')].map((td) => td.textContent)).toEqual(['Hi', 'Hello'])
    expect(el.textContent).toContain('Expires in 9 min')
    const buttons = [...el.querySelectorAll('button')]
    expect(buttons.map((b) => [b.textContent, b.getAttribute('type'), (b as HTMLButtonElement).disabled])).toEqual([
      ['Confirm', 'button', false],
      ['Decline', 'button', false],
    ])
    await dom.click(buttons[0])
    expect(clicked).toBe('confirm')
    expect(document.activeElement).toBe(el.querySelector('.omz-status'))
    expect(document.activeElement?.getAttribute('role')).toBe('status')
  })

  test('consent card: settled and expired cards have no buttons; a failed click shows an alert', async () => {
    const done = await dom.render(h(ui.ConsentCard, { card: card({ status: 'declined' }) }))
    expect(done.querySelectorAll('button')).toHaveLength(0)
    expect(done.querySelector('.omz-status')?.textContent).toBe('Declined. Nothing changed.')
    const old = await dom.render(h(ui.ConsentCard, { card: card({ expiresAt: new Date(Date.now() - 1000).toISOString() }) }))
    expect(old.querySelector('article')?.getAttribute('data-status')).toBe('expired')
    expect(old.querySelectorAll('button')).toHaveLength(0)
    const bad = await dom.render(
      h(ui.ConsentCard, {
        card: card(),
        onConfirm: async () => {
          throw new Error('The network is down.')
        },
        onDecline: () => {},
      }),
    )
    await dom.click(byText(bad, 'button', 'Confirm'))
    expect(bad.querySelector('[role="alert"]')?.textContent).toBe('The network is down.')
  })

  test('consent card in Bangla, with a word overridden', async () => {
    const el = await dom.render(h(ui.UiProvider, { locale: 'bn', text: { decline: 'বাদ দিন' } }, h(ui.ConsentCard, { card: card(), onConfirm: () => {}, onDecline: () => {} })))
    expect([...el.querySelectorAll('button')].map((b) => b.textContent)).toEqual(['নিশ্চিত করুন', 'বাদ দিন'])
    expect(el.textContent).toContain('এই পরিবর্তনটি নিশ্চিত করুন')
    // The expiry is counted in Bengali digits.
    const meta = [...el.querySelectorAll('.omz-meta')].map((m) => m.textContent ?? '').join(' ')
    expect(meta).toMatch(/[০-৯]/)
    expect(meta).not.toMatch(/[0-9]/)
  })

  test('approval card: decider, expiry, review link, and the live status from the inbox route', async () => {
    const k = kit()
    const out = await k.guard.call(ctxOf('rina', 'copilot'), 'note_share', { id: 3 })
    if (out.outcome !== 'pending_approval') throw new Error(out.outcome)
    const a = out.approval
    const data = { kind: 'approval' as const, id: a.id, capability: 'note_share', title: 'Share a note', tier: 'R3' as const, preview: a.preview, decider: a.decider, expiresAt: a.expiresAt, reviewUrl: a.reviewUrl, status: 'waiting' }
    const el = await dom.render(h(ui.UiProvider, { fetch: k.fetchFor(ctxOf('rina')) }, h(ui.ApprovalCard, { card: data, pollMs: 20 })))
    expect(el.textContent).toContain(`Decided by ${a.decider}`)
    expect(el.textContent).toContain('Waiting for a decision. Nothing has changed yet.')
    expect(el.querySelector('a')?.getAttribute('href')).toBe(`/approvals/${a.id}`)
    expect(el.querySelector('.omz-status')?.getAttribute('aria-live')).toBe('polite')
    await k.clientFor(ctxOf('owner')).approvals.decide(a.id, { approve: true, proof: { method: 'passkey', assertion: 'good' } })
    await dom.act(async () => void (await Bun.sleep(60)))
    await dom.flush()
    expect(el.querySelector('.omz-status')?.textContent).toBe('Approved and done.')
    expect(el.querySelector('a')).toBeNull()
  })

  test('approval card: a settled card from the thread shows its status and why, with no review link', async () => {
    const data = { kind: 'approval' as const, id: 'ap_9', capability: 'note_share', title: 'Share a note', tier: 'R3' as const, preview: { summary: 'Share note 9.' }, decider: 'an owner', expiresAt: new Date(Date.now() + 60_000).toISOString(), reviewUrl: '/approvals/ap_9', status: 'withdrawn', message: 'The batch was refused.' }
    const el = await dom.render(h(ui.UiProvider, { uiBase: null }, h(ui.ApprovalCard, { card: data })))
    expect(el.querySelector('article')?.getAttribute('data-status')).toBe('withdrawn')
    expect(el.querySelector('.omz-status')?.textContent).toBe('Withdrawn. Nothing changed. The batch was refused.')
    expect(el.querySelector('a')).toBeNull()
  })

  test('actor card: progress, choices sent as the next message, confirm, and the form link', async () => {
    const said: string[] = []
    let confirmed = ''
    const actor = {
      session: 's1',
      actor: 'visitor_invite',
      state: 'collect' as const,
      question: { slot: 'host', kind: 'choice', text: 'Who is the host?', choices: [{ id: 1, label: 'Hemi' }, { id: 2, label: 'Rafiq' }] },
      card: { id: 'k1', title: 'Invite', summary: 'Invite Rina at 3 pm.', rows: [{ slot: 'name', label: 'Name', display: 'Rina' }, { slot: 'host', label: 'Host', display: '' }], needs: 'confirm' as const, tier: 'R2' as const },
      handoff: { prefill: { name: 'Rina' }, pending: {}, url: '/visitors/new?name=Rina' },
    }
    const el = await dom.render(h(ui.ActorCard, { actor, title: 'Invite a visitor', onChoose: (t: string) => void said.push(t), onConfirm: async (id: string) => void (confirmed = id) }))
    expect(el.querySelector('h3')?.textContent).toBe('Invite a visitor')
    expect(el.querySelector('progress')?.getAttribute('aria-label')).toBe('1 of 2 filled')
    expect(el.querySelector('[role="group"]')?.getAttribute('aria-labelledby')).toBe(el.querySelector('p[id]')?.id)
    await dom.click(byText(el, 'button', 'Rafiq'))
    expect(said).toEqual(['Rafiq'])
    expect(byText(el, 'a', 'Continue in the form')?.getAttribute('href')).toBe('/visitors/new?name=Rina')
    expect(byText(el, 'button', 'Confirm')).toBeUndefined()
    const ready = await dom.render(h(ui.ActorCard, { actor: { ...actor, state: 'confirm', question: undefined }, onConfirm: async (id: string) => void (confirmed = id), onDecline: () => {} }))
    await dom.click(byText(ready, 'button', 'Confirm'))
    expect(confirmed).toBe('k1')
    expect(document.activeElement?.className).toContain('omz-status')
  })
})

describe('ui react: the copilot panel', () => {
  function copilotFetch(opts: { history?: unknown[]; reply?: (w: ReturnType<typeof uiWriter>, body: any) => void; outcome?: unknown }) {
    const calls: { url: string; body: any }[] = []
    const f = (async (url: string, init: RequestInit = {}) => {
      const body = init.body ? JSON.parse(String(init.body)) : null
      calls.push({ url, body })
      if (url.startsWith('/copilot/threads/')) return Response.json({ messages: opts.history ?? [], waiting: [], actor: null })
      if (url === '/copilot/chat') {
        const w = uiWriter(`m_${calls.length}`)
        queueMicrotask(() => {
          opts.reply?.(w, body)
          w.close()
        })
        return new Response(w.stream, { headers: { 'content-type': 'text/event-stream' } })
      }
      if (url.includes('/cards/')) return Response.json(opts.outcome ?? { outcome: 'not_found' }, { status: opts.outcome ? 200 : 404 })
      return new Response('no', { status: 404 })
    }) as unknown as typeof fetch
    return { f, calls }
  }

  test('loads the history, renders cards, sends on Enter (not Shift and Enter), and settles a card', async () => {
    const waiting = card()
    const { f, calls } = copilotFetch({
      history: [
        { id: 'u1', role: 'user', parts: [{ type: 'text', text: 'change the greeting' }] },
        { id: 'a1', role: 'assistant', parts: [{ type: 'text', text: 'A card is up.' }, { type: 'data-consent', id: 'card_1', data: waiting }] },
      ],
      reply: (w, body) => w.text(`You said: ${body.messages[0].parts[0].text}`),
      outcome: { outcome: 'confirmed', card: { ...waiting, status: 'confirmed' }, result: { ok: true } },
    })
    const el = await dom.render(h(ui.UiProvider, { fetch: f, uiBase: null }, h(ui.CopilotPanel, { thread: 'th1', screen: { name: 'brief' } })))
    const log = el.querySelector('[role="log"]')!
    expect(el.querySelector('section')?.getAttribute('aria-label')).toBe('Copilot')
    expect(log.getAttribute('aria-label')).toBe('Conversation')
    expect(log.textContent).toContain('A card is up.')
    expect(log.querySelector('article')?.getAttribute('data-status')).toBe('waiting')

    const box = el.querySelector('textarea')!
    expect(el.querySelector(`label[for="${box.id}"]`)?.textContent).toBe('Message')
    expect(document.getElementById(box.getAttribute('aria-describedby')!)?.textContent).toContain('Shift')
    await dom.type(box, 'hello')
    await dom.key(box, 'Enter', { shiftKey: true })
    expect(calls.filter((c) => c.url === '/copilot/chat')).toHaveLength(0)
    await dom.key(box, 'Enter')
    await dom.flush()
    const sent = calls.find((c) => c.url === '/copilot/chat')!
    expect(sent.body).toMatchObject({ id: 'th1', screen: { name: 'brief' }, messages: [{ role: 'user', parts: [{ text: 'hello' }] }] })
    expect(log.textContent).toContain('You said: hello')
    expect((box as HTMLTextAreaElement).value).toBe('')

    await dom.click(byText(el, 'button', 'Confirm'))
    expect(calls.at(-1)).toMatchObject({ url: '/copilot/cards/card_1/confirm', body: { thread: 'th1' } })
    expect(log.querySelector('article')?.getAttribute('data-status')).toBe('confirmed')
    expect(log.querySelector('article .omz-status')?.textContent).toBe('Done.')
  })

  test('an error chunk is one sentence in an alert; a gone card says so', async () => {
    const { f } = copilotFetch({ history: [{ id: 'a1', role: 'assistant', parts: [{ type: 'data-consent', id: 'card_1', data: card() }] }], reply: (w) => w.error('The copilot could not finish this answer. Nothing else was done.') })
    const el = await dom.render(h(ui.UiProvider, { fetch: f, uiBase: null }, h(ui.CopilotPanel, { thread: 'th2' })))
    await dom.type(el.querySelector('textarea')!, 'go')
    await dom.click(byText(el, 'button', 'Send'))
    await dom.flush()
    expect(el.querySelector('[role="alert"]')?.textContent).toBe('The copilot could not finish this answer. Nothing else was done.')
    await dom.click(byText(el, 'button', 'Confirm'))
    expect(el.querySelector('article .omz-note')?.textContent).toBe('This card is no longer on the thread.')
  })

  test('takes a chat from outside, such as useChat', async () => {
    const sent: string[] = []
    const chat = { messages: [{ id: 'a', role: 'assistant' as const, parts: [{ type: 'text', text: 'From useChat.' }] }], status: 'ready' as const, sendMessage: (m: { text: string }) => void sent.push(m.text), setMessages: () => {} }
    const el = await dom.render(h(ui.UiProvider, { fetch: (async () => new Response('no', { status: 500 })) as unknown as typeof fetch }, h(ui.CopilotPanel, { thread: 't', chat })))
    expect(el.textContent).toContain('From useChat.')
    await dom.type(el.querySelector('textarea')!, 'hi')
    await dom.key(el.querySelector('textarea')!, 'Enter')
    expect(sent).toEqual(['hi'])
  })
})

describe('ui react: settings screens', () => {
  test('approvals inbox: arrows walk the list, the detail takes focus, approve opens the step-up slot, Escape backs out, the proof decides', async () => {
    const k = kit()
    await k.guard.call(ctxOf('rina', 'copilot'), 'note_share', { id: 1 })
    await k.guard.call(ctxOf('rina', 'copilot'), 'note_share', { id: 2 })
    const el = await dom.render(
      h(
        ui.UiProvider,
        { fetch: k.fetchFor(ctxOf('owner')) },
        h(ui.ApprovalsInbox, {
          pollMs: 0,
          stepUp: (s: { methods: string[]; done(p: { method: string; assertion: string }): void; cancel(): void }) =>
            h('div', null, h('p', null, `Use ${s.methods.join(' or ')}`), h('button', { type: 'button', onClick: () => s.done({ method: 'passkey', assertion: 'good' }) }, 'Use my passkey')),
        }),
      ),
    )
    expect(el.querySelector('h2')?.textContent).toBe('Approvals')
    expect(byText(el, 'button', 'Waiting')?.getAttribute('aria-pressed')).toBe('true')
    const picks = [...el.querySelectorAll<HTMLButtonElement>('button[data-omz-item]')]
    expect(picks).toHaveLength(2)
    picks[0]!.focus()
    await dom.key(picks[0]!, 'ArrowDown')
    expect(document.activeElement).toBe(picks[1])
    await dom.key(picks[1]!, 'Home')
    expect(document.activeElement).toBe(picks[0])
    await dom.click(picks[0])
    expect(picks[0]!.getAttribute('aria-current')).toBe('true')
    const detail = el.querySelector('.omz-inbox__detail')!
    expect(document.activeElement).toBe(detail.querySelector('h3'))
    expect(detail.textContent).toMatch(/Share note [12]\./)

    await dom.click(byText(detail, 'button', 'Approve'))
    const slot = detail.querySelector('.omz-stepup')!
    expect(slot.getAttribute('role')).toBe('group')
    expect(document.activeElement).toBe(slot)
    expect(slot.textContent).toContain('Verify it is you')
    expect(slot.textContent).toContain('Use passkey')
    await dom.key(slot, 'Escape')
    expect(detail.querySelector('.omz-stepup')).toBeNull()
    expect(document.activeElement?.textContent).toBe('Approve')

    await dom.click(byText(detail, 'button', 'Approve'))
    await dom.click(byText(detail, 'button', 'Use my passkey'))
    await dom.flush()
    expect(detail.textContent).toContain('Approved. It ran.')
    expect(document.activeElement?.className).toContain('omz-status')
    expect(el.querySelector('.omz-badge[data-status="executed"]')?.textContent).toBe('Done')

    // Refusing needs a reason, and no step-up.
    await dom.click(el.querySelectorAll<HTMLButtonElement>('button[data-omz-item]')[1])
    const d2 = el.querySelector('.omz-inbox__detail')!
    await dom.click(byText(d2, 'button', 'Refuse'))
    expect(document.activeElement?.tagName).toBe('TEXTAREA')
    await dom.click(byText(d2, 'form button', 'Refuse'))
    expect(d2.querySelector('[role="alert"]')?.textContent).toBe('Give a reason for the refusal.')
    await dom.type(d2.querySelector('textarea')!, 'Not this one.')
    await dom.click(byText(d2, 'form button', 'Refuse'))
    expect(d2.textContent).toContain('Refused. Nothing changed.')
    // Escape on the detail goes back to the list item.
    await dom.key(d2, 'Escape')
    await dom.flush()
    expect(el.querySelector('.omz-inbox__detail')).toBeNull()
  })

  test('approvals inbox with CodeStepUpForm: send a code, an empty field is refused, the code approves', async () => {
    const k = kit({ codes: true })
    await k.guard.call(ctxOf('rina', 'copilot'), 'note_share', { id: 1 })
    const el = await dom.render(
      h(ui.UiProvider, { fetch: k.fetchFor(ctxOf('owner')) }, h(ui.ApprovalsInbox, { pollMs: 0, stepUp: (s: Parameters<typeof ui.CodeStepUpForm>[0]) => h(ui.CodeStepUpForm, s) })),
    )
    await dom.click(el.querySelector('button[data-omz-item]'))
    const detail = el.querySelector('.omz-inbox__detail')!
    await dom.click(byText(detail, 'button', 'Approve'))
    expect(k.sent).toEqual([])
    await dom.click(byText(detail, 'button', 'Send me a code'))
    await dom.flush()
    expect(k.sent).toHaveLength(1)
    expect(detail.textContent).toContain('We sent a code to your email.')
    const input = detail.querySelector<HTMLInputElement>('.omz-stepup input')!
    expect(input.getAttribute('autocomplete')).toBe('one-time-code')
    expect(document.activeElement).toBe(input)
    await dom.click(byText(detail, 'form button', 'Approve with this code'))
    expect(detail.querySelector('[role="alert"]')?.textContent).toBe('Type the code you received.')
    await dom.type(input, k.sent[0]!.code)
    await dom.click(byText(detail, 'form button', 'Approve with this code'))
    await dom.flush()
    expect(detail.textContent).toContain('Approved. It ran.')
    expect(el.querySelector('.omz-badge[data-status="executed"]')?.textContent).toBe('Done')
  })

  test('approvals inbox: someone who cannot decide sees why, and no buttons', async () => {
    const k = kit()
    await k.guard.call(ctxOf('rina', 'copilot'), 'note_share', { id: 1 })
    const el = await dom.render(h(ui.UiProvider, { fetch: k.fetchFor(ctxOf('rina')) }, h(ui.ApprovalsInbox, { pollMs: 0 })))
    await dom.click(el.querySelector('button[data-omz-item]'))
    const d = el.querySelector('.omz-inbox__detail')!
    expect(byText(d, 'button', 'Approve')).toBeUndefined()
    expect(d.querySelector('.omz-note')?.textContent).toMatch(/may decide this/)
  })

  test('connected apps: revoke asks once more; Escape cancels and returns focus', async () => {
    const k = kit()
    const el = await dom.render(h(ui.UiProvider, { fetch: k.fetchFor(ctxOf('rina')) }, h(ui.ConnectedApps, {})))
    expect([...el.querySelectorAll('h3')].map((x) => x.textContent)).toEqual(['Apps', 'Keys'])
    expect(el.textContent).toContain('Claude')
    expect(el.textContent).toContain('Known app')
    const revoke = el.querySelectorAll<HTMLButtonElement>('button')[0]!
    expect(document.getElementById(revoke.getAttribute('aria-describedby')!)?.textContent).toBe('Claude')
    await dom.click(revoke)
    const group = el.querySelector('.omz-confirm')!
    expect(group.getAttribute('aria-label')).toBe('Revoke Claude? It stops working at once.')
    expect(document.activeElement?.textContent).toBe('Yes')
    await dom.key(group, 'Escape')
    expect(el.querySelector('.omz-confirm')).toBeNull()
    expect(document.activeElement?.textContent).toBe('Revoke')
    await dom.click(el.querySelectorAll<HTMLButtonElement>('button')[0])
    await dom.click(byText(el, 'button', 'Yes'))
    expect(k.revoked).toEqual(['g1'])
    expect(el.querySelector('[role="status"]')?.textContent).toBe('Claude is revoked.')
    expect(el.textContent).toContain('No app is connected.')
  })

  test('memory page: pending with remember and do not remember; confirmed with source and forget', async () => {
    const k = kit()
    const rina = ctxOf('rina')
    await k.mem.propose(rina, { scope: 'person', text: 'Prefers Bangla summaries', unit: 'notes_copilot' })
    await k.mem.propose(rina, { scope: 'tenant', text: 'Finance contact is Rafiq' })
    const el = await dom.render(h(ui.UiProvider, { fetch: k.fetchFor(rina) }, h(ui.MemoryPage, {})))
    expect(el.querySelector('h2')?.textContent).toBe('What we remember')
    expect(el.textContent).toContain('Nothing is remembered.')
    const row = byText(el, 'li', /Prefers Bangla/)!
    expect(row.textContent).toContain('About you')
    expect(row.textContent).toContain('Suggested by notes_copilot')
    await dom.click(byText(row, 'button', 'Remember'))
    expect(el.querySelector('[role="status"]')?.textContent).toBe('Remembered.')
    await dom.click(byText(byText(el, 'li', /Finance contact/)!, 'button', 'Do not remember'))
    expect(el.textContent).toContain('No suggestions wait for you.')
    const kept = byText(el, 'li', /Prefers Bangla/)!
    expect(kept.textContent).toContain('Confirmed by rina')
    await dom.click(byText(kept, 'button', 'Forget'))
    await dom.click(byText(el, 'button', 'Yes'))
    expect(el.textContent).toContain('Nothing is remembered.')
    expect(await k.mem.list(rina, { status: 'confirmed' })).toEqual([])
  })

  test('standing grants: allow one R2 change, see what is left, revoke it', async () => {
    const k = kit()
    const el = await dom.render(h(ui.UiProvider, { fetch: k.fetchFor(ctxOf('rina')) }, h(ui.StandingGrants, {})))
    expect(el.textContent).toContain('The copilot asks you before every change.')
    expect([...el.querySelectorAll('option')].map((o) => o.textContent)).toEqual(['Add a note'])
    const [daysBox, capBox] = [...el.querySelectorAll('input')]
    expect(daysBox!.getAttribute('max')).toBe('90')
    await dom.type(daysBox!, '14')
    await dom.type(capBox!, '3')
    await dom.click(byText(el, 'button', 'Allow'))
    await dom.flush()
    expect(el.querySelector('[role="status"]')?.textContent).toBe('Add a note is allowed.')
    expect(el.querySelector('li')?.textContent).toContain('3 of 3 left today')
    await dom.click(byText(el.querySelector('li')!, 'button', 'Revoke'))
    await dom.click(byText(el, 'button', 'Yes'))
    expect(el.textContent).toContain('The copilot asks you before every change.')
  })
})

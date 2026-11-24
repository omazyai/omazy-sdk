// The ui kit's framework-free core: the chat reads exactly what the copilot's
// writer sends, the view models, the text map, and uiRoutes with the fetch
// clients against real guard, memory and grants kits.

import { describe, expect, test } from 'bun:test'
import { join } from 'node:path'
import { uiWriter } from '../src/copilot/index'
import { ctxOf, kit } from './ui-fixtures'
import {
  actorDataOf,
  actorView,
  approvalView,
  type ApprovalItem,
  cardAfter,
  type ChatMessage,
  consentView,
  createChat,
  createResource,
  diffRows,
  expiry,
  formatDate,
  formatNumber,
  formatValue,
  intlLocale,
  messageBuilder,
  partView,
  readSse,
  replaceDataPart,
  UI_CSS,
  uiText,
} from '../src/ui/index'

const sse = (w: ReturnType<typeof uiWriter>) => new Response(w.stream, { headers: { 'content-type': 'text/event-stream' } })

describe('ui: text', () => {
  test('English by default, Bangla on request, overrides merge record by record', () => {
    expect(uiText().confirm).toBe('Confirm')
    expect(uiText('bn').confirm).toBe('নিশ্চিত করুন')
    expect(uiText('bn').locale).toBe('bn-BD-u-nu-beng')
    expect(uiText('bn-BD').locale).toBe('bn-BD-u-nu-beng')
    expect(uiText('fr').confirm).toBe('Confirm')
    const t = uiText('en', { confirm: 'Yes, do it', cardStatus: { confirmed: 'All set.' } })
    expect(t.confirm).toBe('Yes, do it')
    expect(t.cardStatus.confirmed).toBe('All set.')
    expect(t.cardStatus.declined).toBe('Declined. Nothing changed.')
    // Every key of English is in Bangla, and no text uses a dash for punctuation.
    const en = uiText('en') as unknown as Record<string, unknown>
    const bn = uiText('bn') as unknown as Record<string, unknown>
    expect(Object.keys(bn).sort()).toEqual(Object.keys(en).sort())
    for (const v of [JSON.stringify(en), JSON.stringify(bn)]) expect(v).not.toMatch(/\u2014|\u2013/)
  })

  test('numbers and dates follow the locale', () => {
    expect(formatNumber(uiText('bn'), 12)).toBe('১২')
    expect(formatNumber(uiText('en'), 1200)).toBe('1,200')
    expect(formatDate(uiText('en'), null)).toBe('none')
    expect(formatDate(uiText('en'), '2026-11-24T10:00:00Z', { time: false })).toContain('2026')
  })

  test('Bangla always uses Bengali digits, under Bun too, where a plain bn-BD gives Latin ones', () => {
    const bn = uiText('bn')
    expect(formatNumber(bn, 1234.5)).toBe('১,২৩৪.৫')
    const day = formatDate(bn, '2026-11-24T10:05:00Z', { time: false })
    expect(day).toContain('২০২৬')
    expect(day).not.toMatch(/[0-9]/)
    expect(formatDate(bn, '2026-11-24T10:05:00Z')).not.toMatch(/[0-9]/)
    // A product that overrides the tag keeps Bengali digits.
    expect(formatNumber({ locale: 'bn-BD' }, 42)).toBe('৪২')
    expect(formatNumber({ locale: 'bn' }, 7)).toBe('৭')
    expect(intlLocale('bn-BD')).toBe('bn-BD-u-nu-beng')
    expect(intlLocale('bn-BD-u-ca-gregory')).toBe('bn-BD-u-ca-gregory-nu-beng')
    expect(intlLocale('bn-BD-u-nu-latn')).toBe('bn-BD-u-nu-latn')
    expect(intlLocale('en-US')).toBe('en-US')
    expect(intlLocale('bnx')).toBe('bnx')
  })
})

describe('ui: the chat reads the copilot stream', () => {
  test('the message built from the chunks is the message the server kept', async () => {
    const w = uiWriter('m_1')
    w.text('Hello ')
    w.text('Rina.')
    w.tool('call_1', 'notes_list', {}, { status: 'ok' })
    w.data('consent', { id: 'card_1', status: 'waiting' }, 'card_1')
    w.data('consent', { id: 'card_1', status: 'confirmed' }, 'card_1')
    w.data('memory', { id: 'mem_1', text: 'Prefers Bangla' }, 'mem_1')
    w.text('Done.')
    w.close()
    const b = messageBuilder({ id: 'x', role: 'assistant', parts: [] })
    for await (const c of readSse(w.stream)) b.apply(c)
    expect(b.message.id).toBe('m_1')
    const strip = (m: ChatMessage) => m.parts.map((p) => ({ ...p, state: p.type === 'text' ? 'done' : p.state }))
    expect(strip(b.message)).toEqual(strip(w.message as ChatMessage))
    expect(b.message.parts.filter((p) => p.type === 'data-consent')).toEqual([{ type: 'data-consent', id: 'card_1', data: { id: 'card_1', status: 'confirmed' } }])
  })

  test('frames split across reads, CRLF and a transient part', async () => {
    const enc = new TextEncoder()
    const text = 'data: {"type":"text-start","id":"a"}\r\n\r\ndata: {"type":"text-delta","id":"a","delta":"hi"}\n\ndata: {"type":"data-note","data":1,"transient":true}\n\ndata: [DONE]\n\n'
    const stream = new ReadableStream<Uint8Array>({
      start(c) {
        for (let i = 0; i < text.length; i += 7) c.enqueue(enc.encode(text.slice(i, i + 7)))
        c.close()
      },
    })
    const chunks = []
    for await (const c of readSse(stream)) chunks.push(c)
    expect(chunks.map((c) => c.type)).toEqual(['text-start', 'text-delta', 'data-note'])
    const b = messageBuilder({ id: 'x', role: 'assistant', parts: [] })
    expect(b.apply(chunks[2]!).transient).toEqual({ type: 'data-note', data: 1 })
  })

  test('createChat: statuses, the body it sends, and the reply', async () => {
    const sent: any[] = []
    let release!: () => void
    const gate = new Promise<void>((r) => (release = r))
    const chat = createChat({
      api: '/copilot/chat',
      id: 'th1',
      messages: [{ id: 'old', role: 'user', parts: [{ type: 'text', text: 'earlier' }] }],
      body: () => ({ screen: { name: 'notes' } }),
      fetch: (async (_url: string, init: RequestInit) => {
        sent.push(JSON.parse(String(init.body)))
        const w = uiWriter('m_2')
        void gate.then(() => {
          w.text('Added.')
          w.close()
        })
        return sse(w)
      }) as unknown as typeof fetch,
    })
    const seen: string[] = []
    chat.subscribe(() => seen.push(chat.getSnapshot().status))
    const p = chat.sendMessage({ text: '  add a note  ' })
    expect(chat.getSnapshot().status).toBe('submitted')
    release()
    await p
    expect(seen).toContain('streaming')
    expect(chat.getSnapshot().status).toBe('ready')
    // Only the new message is sent: the history is the server's.
    expect(sent[0]).toMatchObject({ id: 'th1', trigger: 'submit-message', screen: { name: 'notes' }, messages: [{ role: 'user', parts: [{ type: 'text', text: 'add a note' }] }] })
    expect(sent[0].messages).toHaveLength(1)
    const msgs = chat.getSnapshot().messages
    expect(msgs.map((m) => m.role)).toEqual(['user', 'user', 'assistant'])
    expect(msgs[2]!.parts).toEqual([{ type: 'text', text: 'Added.', state: 'done' }])
    // Empty text is not sent.
    await chat.sendMessage({ text: '   ' })
    expect(sent).toHaveLength(1)
  })

  test('createChat: an error chunk and an HTTP refusal both become the error sentence', async () => {
    const chat = createChat({
      api: '/c',
      id: 't',
      fetch: (async () => {
        const w = uiWriter('m')
        w.error('The AI spend limit is reached for now. Nothing more was done.')
        w.close('error')
        return sse(w)
      }) as unknown as typeof fetch,
    })
    await chat.sendMessage({ text: 'hi' })
    expect(chat.getSnapshot()).toMatchObject({ status: 'error', error: { message: 'The AI spend limit is reached for now. Nothing more was done.' } })
    chat.clearError()
    expect(chat.getSnapshot().status).toBe('ready')

    const busy = createChat({
      api: '/c',
      id: 't',
      fetch: (async () => Response.json({ error: { code: 'busy', message: 'This thread is answering another message.' } }, { status: 409 })) as unknown as typeof fetch,
    })
    await busy.sendMessage({ text: 'hi' })
    expect(busy.getSnapshot().error?.message).toBe('This thread is answering another message.')
  })

  test('stop aborts without an error', async () => {
    const chat = createChat({
      api: '/c',
      id: 't',
      fetch: ((_u: string, init: RequestInit) =>
        new Promise((_r, reject) => init.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError'))))) as unknown as typeof fetch,
    })
    const p = chat.sendMessage({ text: 'hi' })
    chat.stop()
    await p
    expect(chat.getSnapshot()).toMatchObject({ status: 'ready', error: undefined })
  })
})

describe('ui: view models', () => {
  const t = uiText('en')
  const card = {
    kind: 'consent' as const,
    id: 'card_1',
    capability: 'brief_update',
    title: 'Update the brief',
    tier: 'R2' as const,
    preview: { summary: 'Change the greeting.', before: { greeting: 'Hi', hours: '9-5' }, after: { greeting: 'Hello', hours: '9-5' } },
    input: {},
    expiresAt: new Date(Date.now() + 9.5 * 60_000).toISOString(),
    status: 'waiting' as const,
  }

  test('diffRows: changed fields first, added and removed marked; single values', () => {
    expect(diffRows({ a: 1, b: 2 }, { b: 3, c: 4 })).toEqual([
      { field: 'a', before: 1, after: undefined, changed: true, added: false, removed: true },
      { field: 'b', before: 2, after: 3, changed: true, added: false, removed: false },
      { field: 'c', before: undefined, after: 4, changed: true, added: true, removed: false },
    ])
    expect(diffRows('off', 'on')).toEqual([{ field: '', before: 'off', after: 'on', changed: true, added: false, removed: false }])
    expect(diffRows(undefined, undefined)).toEqual([])
    expect(formatValue(t, true)).toBe('Yes')
    expect(formatValue(t, null)).toBe('none')
    expect(formatValue(t, { a: 1 })).toBe('{"a":1}')
  })

  test('consentView: expiry, the effective status, and what a click returns', () => {
    const v = consentView(card)
    expect(v).toMatchObject({ title: 'Update the brief', status: 'waiting', canAct: true, expiry: { expired: false, minutes: 10 } })
    expect(v.rows[0]).toMatchObject({ field: 'greeting', changed: true })
    expect(consentView(card, Date.now() + 11 * 60_000)).toMatchObject({ status: 'expired', canAct: false })
    expect(expiry(null).minutes).toBe(Infinity)
    expect(cardAfter(card, { outcome: 'confirmed', card: { ...card, status: 'confirmed' }, result: {} }, t).card.status).toBe('confirmed')
    expect(cardAfter(card, { outcome: 'busy' }, t)).toEqual({ card, note: t.cardBusy })
    expect(cardAfter(card, { outcome: 'not_found' }, t).note).toBe(t.cardNotFound)
  })

  test('approvalView prefers the live row; actorView shows progress, the card to confirm and the form link', () => {
    const a = { kind: 'approval' as const, id: 'ap_1', capability: 'note_share', title: 'Share', tier: 'R3' as const, preview: { summary: 'Email it.' }, decider: 'an owner', expiresAt: new Date(Date.now() + 3_600_000).toISOString(), status: 'waiting' }
    expect(approvalView(a)).toMatchObject({ status: 'waiting', live: true, decider: 'an owner' })
    expect(approvalView(a, { status: 'executed', decider: 'Imran' } as ApprovalItem)).toMatchObject({ status: 'executed', live: false, decider: 'Imran' })
    expect(approvalView({ ...a, expiresAt: new Date(Date.now() - 1).toISOString() }).status).toBe('expired')

    const reply = {
      session: 's1',
      actor: 'visitor_invite',
      state: 'confirm' as const,
      message: 'Here is the card.',
      card: { id: 'k1', title: 'Invite', summary: 'Invite Rina at 3 pm.', rows: [{ slot: 'name', label: 'Name', display: 'Rina' }, { slot: 'phone', label: 'Phone', display: '' }], needs: 'confirm' as const, tier: 'R2' as const, input: { secret: 1 } },
      handoff: { prefill: { name: 'Rina' }, pending: {}, url: '/visitors/new?name=Rina' },
    }
    const d = actorDataOf(reply)
    expect(d.card).not.toHaveProperty('input')
    expect(actorView(d)).toMatchObject({ progress: { filled: 1, total: 2 }, confirmCard: 'k1', handoffUrl: '/visitors/new?name=Rina', final: false, note: 'Here is the card.' })
    expect(actorView({ ...d, state: 'done' })).toMatchObject({ final: true })
    expect(actorView({ ...d, state: 'done' }).confirmCard).toBeUndefined()
  })

  test('partView and replaceDataPart', () => {
    expect(partView({ type: 'text', text: 'a', state: 'streaming' })).toEqual({ kind: 'text', text: 'a', streaming: true })
    expect(partView({ type: 'data-consent', id: 'card_1', data: card }).kind).toBe('consent')
    expect(partView({ type: 'tool-notes_list', state: 'output-available', output: 1 })).toMatchObject({ kind: 'tool', name: 'notes_list' })
    expect(partView({ type: 'reasoning' }).kind).toBe('other')
    const msgs: ChatMessage[] = [{ id: 'm', role: 'assistant', parts: [{ type: 'text', text: 'x' }, { type: 'data-consent', id: 'card_1', data: card }] }]
    const next = replaceDataPart(msgs, 'data-consent', 'card_1', { ...card, status: 'declined' })
    expect((next[0]!.parts[1]!.data as typeof card).status).toBe('declined')
    expect(msgs[0]!.parts[1]!.data).toBe(card)
    expect(replaceDataPart(msgs, 'data-consent', 'nope', {})).toBe(msgs)
  })

  test('createResource loads on subscribe, keeps data on a failed reload, and set replaces', async () => {
    let n = 0
    let fail = false
    const r = createResource(async () => {
      if (fail) throw new Error('down')
      return ++n
    })
    expect(r.getSnapshot().status).toBe('loading')
    const off = r.subscribe(() => {})
    await Bun.sleep(1)
    expect(r.getSnapshot()).toMatchObject({ status: 'ready', data: 1 })
    fail = true
    await r.refresh()
    expect(r.getSnapshot()).toMatchObject({ status: 'error', data: 1, error: { message: 'down' } })
    r.set((x) => (x ?? 0) + 10)
    expect(r.getSnapshot()).toMatchObject({ status: 'ready', data: 11 })
    off()
  })

  test('the stylesheet themes through variables and respects reduced motion', () => {
    expect(UI_CSS).toContain('--omz-accent')
    expect(UI_CSS).toContain('prefers-reduced-motion: reduce')
    expect(UI_CSS).not.toMatch(/<script|url\(/)
  })
})

// ---------------------------------------------------------------- the entries

describe('ui: the browser entry carries no server code', () => {
  test('uiRoutes is only in @omazyai/sdk/ui/server, and a bundle of @omazyai/sdk/ui pulls in no guard, copilot or ai module', async () => {
    const browser = (await import('../src/ui/index')) as Record<string, unknown>
    const server = (await import('../src/ui/server')) as Record<string, unknown>
    expect(browser.uiRoutes).toBeUndefined()
    expect(typeof server.uiRoutes).toBe('function')
    const out = await Bun.build({ entrypoints: [join(import.meta.dir, '../src/ui/index.ts')], target: 'browser', format: 'esm' })
    expect(out.success).toBe(true)
    const js = await out.outputs[0]!.text()
    expect(js).toContain('createChat')
    for (const server of ['uiRoutes', 'describePolicy', 'MAX_GRANT_DAYS', 'src/guard/', 'src/copilot/', 'src/ai/']) expect(js).not.toContain(server)
  })
})

// ---------------------------------------------------------------- uiRoutes and uiClient against the kits

describe('ui: uiRoutes and uiClient over the kits', () => {
  test('approvals: listed to the requester and the decider only; approve needs the step-up proof; arguments never leave', async () => {
    const k = kit()
    const out = await k.guard.call(ctxOf('rina', 'copilot'), 'note_share', { id: 7 })
    expect(out.outcome).toBe('pending_approval')
    const owner = k.clientFor(ctxOf('owner'))
    const rina = k.clientFor(ctxOf('rina'))
    const stranger = k.clientFor(ctxOf('karim'))
    const other = k.clientFor(ctxOf('owner', 'console', 'tB'))

    const [item] = await owner.approvals.list()
    expect(item).toMatchObject({ action: 'note_share', title: 'Share a note', status: 'waiting', canDecide: true, needs: { stepUp: ['passkey'], typedTarget: false }, reviewUrl: `/approvals/${item!.id}` })
    expect(item!.preview).toEqual({ summary: 'Share note 7.', before: { shared: false }, after: { shared: true } })
    expect(JSON.stringify(item)).not.toMatch(/argsSealed|argsHash/)
    expect((await rina.approvals.list())[0]).toMatchObject({ canDecide: false })
    expect(await stranger.approvals.list()).toEqual([])
    expect(await other.approvals.list()).toEqual([])
    expect(await stranger.approvals.get(item!.id)).toBeNull()

    expect(await stranger.approvals.decide(item!.id, { approve: true })).toEqual({ outcome: 'not_found' })
    expect(await owner.approvals.decide(item!.id, { approve: true })).toMatchObject({ outcome: 'step_up_required', methods: ['passkey'] })
    expect(await owner.approvals.decide(item!.id, { approve: true, proof: { method: 'passkey', assertion: 'bad' } })).toMatchObject({ outcome: 'step_up_failed', message: 'The passkey did not match.' })
    expect(await owner.approvals.decide(item!.id, { approve: false })).toMatchObject({ outcome: 'reason_required' })
    const ok = await owner.approvals.decide(item!.id, { approve: true, proof: { method: 'passkey', assertion: 'good' } })
    expect(ok).toMatchObject({ outcome: 'approved', approval: { status: 'executed', decidedBy: { id: 'owner', name: 'Hemi' }, verification: 'passkey' }, execution: { outcome: 'ok' } })
    expect(await rina.approvals.get(item!.id)).toMatchObject({ status: 'executed' })
    expect(await owner.approvals.list()).toEqual([])
    expect((await owner.approvals.list({ status: 'all' })).map((a) => a.status)).toEqual(['executed'])
  })

  test('approvals: the decider asks for a step-up code, then approves with it; nobody else can ask', async () => {
    const k = kit({ codes: true })
    await k.guard.call(ctxOf('rina', 'copilot'), 'note_share', { id: 7 })
    const owner = k.clientFor(ctxOf('owner'))
    const [item] = await owner.approvals.list()
    expect(item!.needs.stepUp).toEqual(['code'])
    // The requester sees the request but may not decide it, so no code goes to her; a stranger finds nothing.
    await expect(k.clientFor(ctxOf('rina')).approvals.sendCode(item!.id)).rejects.toMatchObject({ status: 403 })
    await expect(k.clientFor(ctxOf('karim')).approvals.sendCode(item!.id)).rejects.toMatchObject({ status: 404 })
    expect(k.sent).toEqual([])
    const sent = await owner.approvals.sendCode(item!.id)
    expect(sent).toMatchObject({ channels: ['email'], method: 'code' })
    expect(Date.parse(sent.expiresAt)).toBeGreaterThan(Date.now())
    expect(k.sent).toEqual([{ person: 'owner', channel: 'email', code: expect.stringMatching(/^\d{6}$/), approval: item!.id }])
    const wrong = k.sent[0]!.code === '000000' ? '111111' : '000000'
    expect(await owner.approvals.decide(item!.id, { approve: true, proof: { method: 'code', codes: { email: wrong } } })).toMatchObject({ outcome: 'step_up_failed' })
    const ok = await owner.approvals.decide(item!.id, { approve: true, proof: { method: sent.method, codes: { email: k.sent[0]!.code } } })
    expect(ok).toMatchObject({ outcome: 'approved', approval: { status: 'executed', verification: 'code' } })
    // Decided: no more codes for it.
    await expect(owner.approvals.sendCode(item!.id)).rejects.toMatchObject({ status: 409 })
  })

  test('approvals: without codes the code route is not served', async () => {
    const k = kit()
    await k.guard.call(ctxOf('rina', 'copilot'), 'note_share', { id: 7 })
    const [item] = await k.clientFor(ctxOf('owner')).approvals.list()
    const req = new Request(`https://app.example/ui/approvals/${item!.id}/code`, { method: 'POST', body: '{}', headers: { 'content-type': 'application/json' } })
    expect(await k.routes.handle(req, ctxOf('owner'))).toBeNull()
  })

  test('a POST that is not JSON is refused; an unknown path falls through', async () => {
    const k = kit()
    const res = await k.routes.handle(new Request('https://app.example/ui/grants', { method: 'POST', body: 'capability=note_add', headers: { 'content-type': 'application/x-www-form-urlencoded' } }), ctxOf('rina'))
    expect(res?.status).toBe(415)
    expect(await k.routes.handle(new Request('https://app.example/other'), ctxOf('rina'))).toBeNull()
    expect(await k.routes.handle(new Request('https://app.example/ui/nothing'), ctxOf('rina'))).toBeNull()
  })

  test('connected apps: the seat and owner stay on the server; revoke an app and a key', async () => {
    const k = kit()
    const c = k.clientFor(ctxOf('rina'))
    const d = await c.apps.list()
    expect(d.apps[0]).not.toHaveProperty('seatId')
    expect(d.keys[0]).not.toHaveProperty('owner')
    expect(await c.apps.revoke('g1')).toBe(true)
    expect(await c.apps.revoke('nope')).toBe(false)
    expect(await c.apps.revokeKey('k1')).toBe(true)
    expect(k.revoked).toEqual(['g1', 'k1'])
  })

  test('memory: list with the source, confirm, reject and forget; only a person on the console decides', async () => {
    const k = kit()
    const rina = ctxOf('rina')
    const a = await k.mem.propose(rina, { scope: 'person', text: 'Prefers Bangla summaries', unit: 'notes_copilot', runId: 'run_1' })
    const b = await k.mem.propose(rina, { scope: 'person', text: 'Works Fridays' })
    const c = k.clientFor(rina)
    const list = await c.memory.list()
    expect(list.find((m) => m.id === a.id)).toMatchObject({ status: 'proposed', unit: 'notes_copilot', runId: 'run_1' })
    expect(list[0]).not.toHaveProperty('mentions')
    expect(await c.memory.confirm(a.id)).toMatchObject({ ok: true, item: { status: 'confirmed', decidedBy: 'rina' } })
    expect(await c.memory.confirm(a.id)).toEqual({ ok: false, reason: 'already_decided' })
    expect(await k.clientFor(ctxOf('rina', 'copilot')).memory.reject(b.id)).toEqual({ ok: false, reason: 'not_a_person' })
    expect(await c.memory.reject(b.id)).toMatchObject({ ok: true, item: { status: 'rejected' } })
    expect(await k.clientFor(ctxOf('karim')).memory.forget(a.id)).toBe(false)
    expect(await c.memory.forget(a.id)).toBe(true)
    expect((await c.memory.list()).map((m) => m.id)).toEqual([b.id])
  })

  test('standing grants: options are the R2 capabilities; set, list with what is left today, revoke; refusals come back as data', async () => {
    const k = kit()
    const c = k.clientFor(ctxOf('rina'))
    const empty = await c.grants.list()
    expect(empty.options).toEqual({ capabilities: [{ name: 'note_add', title: 'Add a note' }], maxDays: 90, maxDailyCap: 500 })
    const set = await c.grants.set({ capability: 'note_add', days: 30, dailyCap: 5 })
    expect(set).toMatchObject({ ok: true, grant: { capability: 'note_add', title: 'Add a note', dailyCap: 5, left: 5, active: true } })
    expect(await c.grants.set({ capability: 'note_share', days: 30, dailyCap: 5 })).toMatchObject({ ok: false, reason: 'not_r2' })
    expect(await c.grants.set({ capability: 'note_add', days: 365, dailyCap: 5 })).toMatchObject({ ok: false, reason: 'bad_days' })
    expect(await k.clientFor(ctxOf('rina', 'copilot')).grants.set({ capability: 'note_add', days: 1, dailyCap: 1 })).toMatchObject({ ok: false, reason: 'not_a_person' })
    const list = await c.grants.list()
    expect(list.grants).toHaveLength(1)
    expect(await c.grants.revoke(list.grants[0]!.id)).toBe(true)
    expect((await c.grants.list()).grants[0]).toMatchObject({ active: false, left: null })
  })
})

// One copilot turn on the fake Core API: the model asks to add a note, the
// person sees a consent card, and only their click adds it.

import { readUiChunks } from '@omazyai/sdk/copilot'
import { fakeCore, reply } from '@omazyai/sdk/testing'
import { describe, expect, test } from 'vitest'
import { harness } from './helpers'

describe('the copilot', () => {
  test('an R2 call becomes a card, and only the click runs it', async () => {
    const h = harness({ fake: fakeCore({ script: [reply.tool('note_add', { title: 'Call the plumber' }), reply.text('I put up a card for you to confirm.')] }) })
    const ctx = h.seat('rina', 'tenant_a', 'copilot')
    const turn = await h.app.copilot.turn(ctx, { thread: 'th1', text: 'Add a note to call the plumber' })
    if (!turn.ok) throw new Error(turn.message)
    const chunks = await readUiChunks(turn.stream)
    await turn.done
    const card = chunks.find((c) => c.type === 'data-consent') as { data: { id: string; capability: string } } | undefined
    expect(card?.data.capability).toBe('note_add')
    expect(await h.notes.count()).toBe(0)
    const out = await h.app.copilot.confirm(ctx, { thread: 'th1', card: card!.data.id })
    expect(out.outcome).toBe('confirmed')
    expect(await h.notes.count()).toBe(1)
  })
//#if actor

  test('hands the person to note_intake, from the same registry the door serves', async () => {
    const h = harness({ fake: fakeCore({ script: [reply.tool('actor_start', { actor: 'note_intake' })] }) })
    h.fake.on('note_intake', reply.json({ items: [{ slot: 'title', value: 'Call the plumber', confidence: 0.95, evidence: 'call the plumber', from: 'message' }] }))
    const ctx = h.seat('rina', 'tenant_a', 'copilot')
    const turn = await h.app.copilot.turn(ctx, { thread: 'th1', text: 'Add a note: call the plumber' })
    if (!turn.ok) throw new Error(turn.message)
    const chunks = await readUiChunks(turn.stream)
    await turn.done
    const actor = chunks.find((c) => c.type === 'data-actor') as { data: { state: string; card?: { id: string } } } | undefined
    expect(actor?.data.state).toBe('confirm')
    expect(await h.notes.count()).toBe(0)
    const out = await h.app.copilot.confirm(ctx, { thread: 'th1', card: actor!.data.card!.id })
    expect(out.outcome).toBe('actor')
    expect(await h.notes.count()).toBe(1)
  })
//#endif
})

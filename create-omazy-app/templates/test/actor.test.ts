// The note_intake actor: the model reads the person's words into the title
// slot, code shows the card, and only the person's confirm reaches note_add.

import { reply } from '@omazyai/sdk/testing'
import { describe, expect, test } from 'vitest'
import { harness } from './helpers'

describe('note_intake', () => {
  test('one message to a card; the note is added only on confirm', async () => {
    const h = harness()
    h.fake.on('note_intake', reply.json({ items: [{ slot: 'title', value: 'Call the plumber', confidence: 0.95, evidence: 'call the plumber', from: 'message' }] }))
    const ctx = h.seat()
    const r = await h.app.actors.start(ctx, 'note_intake', { text: 'Add a note: call the plumber' })
    expect(r.state).toBe('confirm')
    expect(r.card).toBeTruthy()
    expect(await h.notes.count()).toBe(0)
    const done = await h.app.actors.confirm(ctx, r.session, r.card!.id)
    expect(done.state).toBe('done')
    expect(await h.notes.count()).toBe(1)
  })
})

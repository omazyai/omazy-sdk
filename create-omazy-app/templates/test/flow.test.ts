// The note_followup workflow on the memory runner, which replays runs the way
// Cloudflare Workflows does. Starting it is an R2 change: the person confirms
// the card, then the workflow reads the note and adds the follow-up.

import { describe, expect, test } from 'vitest'
import { harness } from './helpers'

describe('note_followup', () => {
  test('runs once the person confirms the start, and adds the follow-up', async () => {
    const h = harness()
    const ctx = h.seat()
    const note = await h.notes.add('tenant_a', 'Call the plumber')
    const first = await h.app.guard.call(ctx, 'note_followup_start', { note_id: note.id })
    expect(first.outcome).toBe('confirm_required')
    if (first.outcome !== 'confirm_required') return
    const started = await h.app.guard.call(ctx, 'note_followup_start', { note_id: note.id }, { confirmToken: first.token })
    expect(started.outcome).toBe('ok')
    await h.runner().idle()
    expect(h.runner().status(`followup:${note.id}`)).toBe('ok')
    expect(h.notes.rows.map((r) => r.title)).toContain('Follow up: Call the plumber')
  })
})

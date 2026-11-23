// The note_title unit against its golden set, on the fake Core API. Set
// OMAZY_EVAL_LIVE=1 and OMAZY_TOKEN to run the same cases against the live API.

import { assertEval, evalCore, evalUnit, fakeCore, formatReport, includes, loadGoldenSet, reply, schemaValid } from '@omazyai/sdk/testing'
import { describe, expect, test } from 'vitest'
import { noteTitle } from '../src/ai'
import { harness } from './helpers'

describe('note_title', () => {
  test('passes its eval set at its threshold', async () => {
    const fake = fakeCore({})
    // The core the unit runs on: the fake, or the live API under OMAZY_EVAL_LIVE=1.
    const h = harness({ fake, core: evalCore({ fake }) })
    const report = await evalUnit(noteTitle, {
      cases: await loadGoldenSet(noteTitle),
      fake,
      run: (c) => h.app.ai.run(h.seat(), noteTitle, c.input as { text: string }, { save: false }),
      scorers: [schemaValid(), includes({ path: 'title' })],
    })
    console.log(formatReport(report))
    assertEval(report)
  })

  test('saves through note_add, so the note waits for the person to confirm', async () => {
    const h = harness()
    h.fake.on('note_title', reply.json({ title: 'Call the plumber' }))
    const r = await h.app.ai.run(h.seat(), noteTitle, { text: 'remember to call the plumber' })
    expect(r.outcome).toBe('ok')
    if (r.outcome !== 'ok') return
    expect(r.save?.outcome).toBe('confirm_required')
    expect(await h.notes.count()).toBe(0)
  })
})

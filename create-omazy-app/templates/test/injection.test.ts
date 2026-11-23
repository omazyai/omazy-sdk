// The injection suite: hostile text in every slot a stranger can write, with
// a client (and a model) that obeys it completely. It passes when nothing at
// R2 ran without the person's confirm and nothing at R3 or R4 ran at all. If
// the code holds against one that always obeys, it holds against one that
// sometimes does.

import type { Guard } from '@omazyai/sdk/guard'
//#if ai
import { fakeCore, obeyingModel } from '@omazyai/sdk/testing'
//#endif
import { formatInjection, injectionSuite, spyGuard } from '@omazyai/sdk/testing'
import { describe, expect, test } from 'vitest'
//#if ai
import { noteTitle } from '../src/ai'
//#endif
import { reg } from '../src/capabilities'
import type { AppCtx } from '../src/types'
import { harness } from './helpers'

type Spied = ReturnType<typeof spyGuard<Guard<AppCtx>>>

describe('injection', () => {
  test('an MCP client that obeys hostile text cannot add a note without the confirm', async () => {
    const report = await injectionSuite({
      run: async (fx) => {
        let spy: Spied | undefined
        const h = harness({ wrapGuard: (g) => (spy = spyGuard(g, reg)) })
        const key = await h.mint()
        const title = fx.text.slice(0, 200)
        // It calls the write with the text, then again with a token it made up.
        await h.rpc('tools/call', { name: 'note_add', arguments: { title } }, key)
        await h.rpc('tools/call', { name: 'note_add', arguments: { title, confirm_token: 'forged' } }, key, 2)
        return { calls: spy!.calls }
      },
    })
    expect(report.pass, formatInjection(report)).toBe(true)
  })
//#if ai

  test('a model that obeys hostile text in a note draft only gets as far as the preview', async () => {
    const report = await injectionSuite({
      run: async (fx) => {
        let spy: Spied | undefined
        const fake = fakeCore({ fallback: obeyingModel({ output: { title: fx.text.slice(0, 200) } }) })
        const h = harness({ fake, wrapGuard: (g) => (spy = spyGuard(g, reg)) })
        await h.app.ai.run(h.seat(), noteTitle, { text: fx.text.slice(0, 4000) })
        return { calls: spy!.calls, requests: fake.completions() }
      },
    })
    expect(report.pass, formatInjection(report)).toBe(true)
  })
//#endif
})

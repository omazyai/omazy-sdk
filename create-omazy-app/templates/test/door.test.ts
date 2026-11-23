// The MCP door end to end in process: a personal key lists the tools, reads,
// and adds a note only after the confirm. `npm run dev` serves the same door.

import { describe, expect, test } from 'vitest'
import { harness } from './helpers'

const call = (name: string, args: unknown, meta?: unknown) => ({ name, arguments: args, ...(meta ? { _meta: meta } : {}) })

describe('the MCP door', () => {
  test('lists the tools for a personal key', async () => {
    const h = harness()
    const key = await h.mint()
    const r = await h.rpc('tools/list', {}, key)
    expect(r.status).toBe(200)
    const names = r.body.result.tools.map((t: { name: string }) => t.name)
    expect(names).toContain('note_get')
    expect(names).toContain('note_add')
  })

  test('adds a note only after the person confirms the preview', async () => {
    const h = harness()
    const key = await h.mint()
    const first = await h.rpc('tools/call', call('note_add', { title: 'Call the plumber' }), key)
    const outcome = first.body.result._meta['ai.omazy/outcome']
    // The same names as guard.call: outcome, token, expiresAt, preview.
    expect(outcome.outcome).toBe('confirm_required')
    expect(await h.notes.count()).toBe(0)
    const second = await h.rpc('tools/call', call('note_add', { title: 'Call the plumber', confirm_token: outcome.token }), key, 2)
    expect(second.body.result.isError).toBe(false)
    const id = second.body.result.structuredContent.id
    const read = await h.rpc('tools/call', call('note_get', { id }), key, 3)
    expect(read.body.result.structuredContent.title).toBe('Call the plumber')
  })

  test('refuses a request without a key, and logs it', async () => {
    const h = harness()
    const r = await h.rpc('tools/list', {}, null)
    expect(r.status).toBe(401)
    expect(h.log.records.some((x) => x.outcome === 'refused_auth')).toBe(true)
  })

  test('a key for tenant A cannot read a note of tenant B', async () => {
    const h = harness()
    const theirs = await h.notes.add('tenant_b', 'Tenant B only')
    const key = await h.mint('rina', 'tenant_a')
    const r = await h.rpc('tools/call', call('note_get', { id: theirs.id }), key)
    expect(r.body.result.isError).toBe(true)
    expect(JSON.stringify(r.body)).not.toContain('Tenant B only')
  })

  test('is off by default in production until a switch turns it on', async () => {
    const h = harness({ doorDefault: 'off' })
    const key = await h.mint()
    expect((await h.rpc('tools/list', {}, key)).status).toBe(503)
    await h.switches.set({ key: 'door:app', scope: 'global', subject: null, on: true })
    expect((await h.rpc('tools/list', {}, key)).status).toBe(200)
  })
})

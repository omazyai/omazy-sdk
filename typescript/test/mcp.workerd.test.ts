// End to end under workerd: the example Worker is bundled with esbuild for the
// workerd conditions and served by Miniflare, then spoken to over HTTP as a
// 2025 client and as a 2026-07-28 client. Miniflare and esbuild are heavy, so
// they are not dev dependencies: point WORKERD_TOOLS at a folder whose
// node_modules holds both, or the test is skipped.
//
//   npm i --prefix /tmp/wt esbuild miniflare && WORKERD_TOOLS=/tmp/wt bun test test/mcp.workerd.test.ts

import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { join } from 'node:path'

const tools = process.env.WORKERD_TOOLS
/** Each test's limit: a few requests to a running workerd, slow under load. A real hang still fails. */
const REQUEST_TIMEOUT = 30_000
const run = tools ? describe : describe.skip

run('mcp: end to end under workerd', () => {
  let mf: { dispatchFetch(url: string, init?: RequestInit): Promise<Response>; dispose(): Promise<void> }
  let size = 0
  let script = ''

  beforeAll(async () => {
    const esbuild = await import(join(tools!, 'node_modules/esbuild/lib/main.js'))
    const { Miniflare } = await import(join(tools!, 'node_modules/miniflare/dist/src/index.js'))
    const out = await esbuild.build({
      entryPoints: [join(import.meta.dir, '../examples/mcp-worker.ts')],
      bundle: true,
      write: false,
      format: 'esm',
      minify: true,
      platform: 'neutral',
      conditions: ['workerd', 'worker', 'browser'],
      mainFields: ['module', 'main'],
      target: 'es2022',
    })
    script = out.outputFiles[0].text as string
    size = script.length
    mf = new Miniflare({ modules: true, script, compatibilityDate: '2026-07-01' })
    // Wait for workerd to be up here, inside the start-up allowance, so a slow
    // start under load is not charged to the first test.
    await mf.ready
  }, 60_000)
  afterAll(async () => mf?.dispose())

  const post = (body: unknown, headers: Record<string, string> = {}) =>
    mf.dispatchFetch('https://mcp.example/org', {
      method: 'POST',
      headers: { authorization: 'Bearer demo-org-key', 'content-type': 'application/json', accept: 'application/json, text/event-stream', ...headers },
      body: JSON.stringify(body),
    })

  test('the bundle has no code generation', () => {
    expect(size).toBeGreaterThan(0)
    expect(script.includes('new Function(')).toBe(false)
  })

  test('a 2025-06-18 client lists and calls', async () => {
    const init = (await (await post({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'e2e', version: '1' } } })).json()) as any
    expect(init.result.protocolVersion).toBe('2025-06-18')
    const list = (await (await post({ jsonrpc: '2.0', id: 2, method: 'tools/list' }, { 'mcp-protocol-version': '2025-06-18' })).json()) as any
    expect(list.result.tools.map((t: any) => t.name)).toContain('notes_list')
    const call = (await (await post({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'notes_list', arguments: {} } }, { 'mcp-protocol-version': '2025-06-18' })).json()) as any
    expect(call.result.isError).toBe(false)
  }, REQUEST_TIMEOUT)

  test('a 2026-07-28 client discovers, then a write asks to confirm', async () => {
    const meta = {
      'io.modelcontextprotocol/protocolVersion': '2026-07-28',
      'io.modelcontextprotocol/clientInfo': { name: 'e2e', version: '1' },
      'io.modelcontextprotocol/clientCapabilities': { elicitation: { form: {} } },
    }
    const h = (method: string, name?: string) => ({ 'mcp-protocol-version': '2026-07-28', 'mcp-method': method, ...(name ? { 'mcp-name': name } : {}) })
    const d = (await (await post({ jsonrpc: '2.0', id: 4, method: 'server/discover', params: { _meta: meta } }, h('server/discover'))).json()) as any
    expect(d.result.supportedVersions).toContain('2026-07-28')
    const args = { title: 'Call the plumber' }
    const first = (await (await post({ jsonrpc: '2.0', id: 5, method: 'tools/call', params: { name: 'note_add', arguments: args, _meta: meta } }, h('tools/call', 'note_add'))).json()) as any
    expect(first.result.resultType).toBe('input_required')
    const retry = (await (
      await post(
        {
          jsonrpc: '2.0',
          id: 6,
          method: 'tools/call',
          params: { name: 'note_add', arguments: args, _meta: meta, inputResponses: { confirm: { action: 'accept', content: { confirm: true } } }, requestState: first.result.requestState },
        },
        h('tools/call', 'note_add'),
      )
    ).json()) as any
    expect(retry.result.isError).toBe(false)
    expect(retry.result.structuredContent.title).toBe('Call the plumber')
  }, REQUEST_TIMEOUT)
})

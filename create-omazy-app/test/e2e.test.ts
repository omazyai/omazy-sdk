// End to end: each preset is written to a temporary folder, installed with
// npm against a built SDK tarball, typechecked and tested with its own suite.
// Then the minimal product is bundled and served by Miniflare, and answers
// tools/list and a tools/call with a personal key.
//
// It needs the network for npm, so it runs only when asked:
//
//   (cd ../typescript && npm run build && npm pack --pack-destination /tmp/sdk)
//   OMAZY_E2E_SDK=/tmp/sdk/omazyai-sdk-<version>.tgz bun test test/e2e.test.ts
//
// The Miniflare part also needs WORKERD_TOOLS, a folder whose node_modules
// holds esbuild and miniflare, as the SDK's workerd tests do:
//
//   npm i --prefix /tmp/wt esbuild miniflare
//   OMAZY_E2E_SDK=... WORKERD_TOOLS=/tmp/wt bun test test/e2e.test.ts

import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { plan, PRESETS, write } from '../src/generate.mjs'

const SDK = process.env.OMAZY_E2E_SDK
const TOOLS = process.env.WORKERD_TOOLS
const KEEP = process.env.OMAZY_E2E_KEEP === '1'
const run = SDK ? describe : describe.skip
const MINUTES = 60_000

const root = SDK ? mkdtempSync(join(tmpdir(), 'create-omazy-app-')) : ''
const dirs: Record<string, string> = {}

function sh(cwd: string, cmd: string, args: string[]): string {
  try {
    return execFileSync(cmd, args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, CI: '1', NO_COLOR: '1', FORCE_COLOR: '0' } })
  } catch (e) {
    const err = e as { stdout?: string; stderr?: string; message: string }
    throw new Error(`${cmd} ${args.join(' ')} failed in ${cwd}\n${err.stdout ?? ''}\n${err.stderr ?? ''}`)
  }
}

function make(preset: keyof typeof PRESETS): string {
  const dir = join(root, preset)
  const { files } = plan({ name: `smoke-${preset}`, kits: PRESETS[preset], sdk: `file:${SDK}` })
  write(dir, files)
  sh(dir, 'npm', ['install', '--no-audit', '--no-fund', '--loglevel=error'])
  dirs[preset] = dir
  return dir
}

afterAll(() => {
  if (root && !KEEP) rmSync(root, { recursive: true, force: true })
})

for (const preset of ['minimal', 'full'] as const) {
  run(`the ${preset} preset`, () => {
    test(
      'installs, typechecks and passes its own tests',
      () => {
        const dir = make(preset)
        sh(dir, 'npm', ['run', 'typecheck'])
        const out = sh(dir, 'npx', ['vitest', 'run', '--reporter=dot'])
        expect(out).toMatch(/Tests\s+\d+ passed/)
        expect(out).not.toMatch(/failed/)
        // The first run wrote the tier snapshot, for the product to commit.
        expect(readdirSync(dir)).toContain('catalog.snapshot.json')
      },
      6 * MINUTES,
    )
  })
}

const served = SDK && TOOLS ? describe : describe.skip

served('the minimal product under workerd', () => {
  type Mf = {
    dispatchFetch(url: string, init?: RequestInit): Promise<Response>
    getD1Database(name: string): Promise<{ prepare(sql: string): { run(): Promise<unknown> } }>
    getKVNamespace(name: string): Promise<unknown>
    dispose(): Promise<void>
  }
  let mf: Mf
  let off: Mf
  let key = ''

  beforeAll(async () => {
    const dir = dirs.minimal ?? make('minimal')
    const esbuild = await import(join(TOOLS!, 'node_modules/esbuild/lib/main.js'))
    const { Miniflare } = await import(join(TOOLS!, 'node_modules/miniflare/dist/src/index.js'))
    const out = await esbuild.build({
      entryPoints: [join(dir, 'src/index.ts')],
      absWorkingDir: dir,
      bundle: true,
      write: false,
      format: 'esm',
      platform: 'neutral',
      conditions: ['workerd', 'worker', 'browser'],
      mainFields: ['module', 'main'],
      target: 'es2022',
      external: ['cloudflare:*'],
    })
    const script = out.outputFiles[0].text as string
    const options = (door: string) => ({
      modules: true,
      script,
      compatibilityDate: '2026-07-01',
      d1Databases: ['DB'],
      kvNamespaces: ['KV'],
      bindings: { GUARD_SECRET: 'e2e-secret-e2e-secret-e2e-secret-0123', DOOR_DEFAULT: door },
    })
    mf = new Miniflare(options('on'))
    off = new Miniflare(options('off'))

    // The migrations, as `wrangler d1 migrations apply` would.
    for (const worker of [mf, off]) {
      const db = await worker.getD1Database('DB')
      for (const file of readdirSync(join(dir, 'migrations')).sort()) {
        const sql = readFileSync(join(dir, 'migrations', file), 'utf8').replace(/^\s*--.*$/gm, '')
        for (const stmt of sql.split(/;\s*(?:\n|$)/).map((s) => s.trim()).filter(Boolean)) await db.prepare(stmt).run()
      }
    }

    // A personal key, as `npm run key` mints it, into the Worker's own KV.
    const { Keys } = await import(join(dir, 'node_modules/@omazyai/sdk/dist/oauth/keys.js'))
    const cfg = JSON.parse(readFileSync(join(dir, 'src/keys.json'), 'utf8'))
    const keys = new Keys(await mf.getKVNamespace('KV'), [cfg.door], { personal: { prefix: () => cfg.prefix } })
    key = (await keys.createPersonal({ principal: { kind: 'member', id: 'rina' }, seat: { id: 'seat_rina', door: cfg.door, tenant: 'demo' }, name: 'e2e', days: 1 })).key
  }, 6 * MINUTES)

  afterAll(async () => {
    await mf?.dispose()
    await off?.dispose()
  })

  const rpc = async (worker: Mf, id: number, method: string, params?: unknown, bearer = key) => {
    const res = await worker.dispatchFetch('https://smoke.example/mcp', {
      method: 'POST',
      headers: {
        authorization: `Bearer ${bearer}`,
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
        'mcp-protocol-version': '2025-06-18',
      },
      body: JSON.stringify({ jsonrpc: '2.0', id, method, ...(params === undefined ? {} : { params }) }),
    })
    const text = await res.text()
    return { status: res.status, body: text ? JSON.parse(text) : null }
  }

  test('answers its health check', async () => {
    expect(await (await mf.dispatchFetch('https://smoke.example/health')).json()).toEqual({ ok: true })
  })

  test('initializes, lists the tools and calls one with a personal key', async () => {
    const init = await rpc(mf, 1, 'initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'e2e', version: '1' } })
    expect(init.body.result.serverInfo.name).toBe('smoke-minimal')
    const list = await rpc(mf, 2, 'tools/list')
    expect(list.body.result.tools.map((t: { name: string }) => t.name).sort()).toEqual(['note_add', 'note_get'])

    const first = await rpc(mf, 3, 'tools/call', { name: 'note_add', arguments: { title: 'Call the plumber' } })
    const pending = first.body.result._meta['ai.omazy/outcome']
    expect(pending.outcome).toBe('confirm_required')
    const added = await rpc(mf, 4, 'tools/call', { name: 'note_add', arguments: { title: 'Call the plumber', confirm_token: pending.token } })
    expect(added.body.result.isError).toBe(false)
    const got = await rpc(mf, 5, 'tools/call', { name: 'note_get', arguments: { id: added.body.result.structuredContent.id } })
    expect(got.body.result.structuredContent.title).toBe('Call the plumber')
  })

  test('refuses a made-up key', async () => {
    expect((await rpc(mf, 6, 'tools/list', undefined, 'not-a-key')).status).toBe(401)
  })

  test('starts with the door off when DOOR_DEFAULT is off', async () => {
    const r = await rpc(off, 7, 'tools/list')
    expect(r.status).toBe(503)
    expect(r.body.error).toBe('door_off')
  })
})

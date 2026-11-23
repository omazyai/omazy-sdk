// What the scaffolder writes, without installing anything.

import { describe, expect, test } from 'bun:test'
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { kitMigrations } from '../scripts/kit-migrations'
import { main } from '../src/cli.mjs'
import { KITS, nameProblem, ownVersion, plan, PRESETS, render, resolveKits, sdkTarballUrl, write } from '../src/generate.mjs'

const ACCOUNT = '0123456789abcdef0123456789abcdef'
// Built in two parts, so this file does not name the private repository itself.
const PRIVATE = new RegExp(`[\u2013\u2014]|&mdash;|omazy${'-'}cx|docs${'/'}rfc`)
const jsonc = (text: string) => JSON.parse(text.replace(/^\s*\/\/.*$/gm, ''))
const sdkVersion = () => JSON.parse(readFileSync(join(import.meta.dir, '../../typescript/package.json'), 'utf8')).version

describe('the template language', () => {
  test('keeps and drops whole lines by kit, with else and nesting', () => {
    const t = ['a', '//#if ai', 'b', '//#if copilot', 'c', '//#else', 'd', '//#endif', '//#endif', '//#if !ai', 'e', '//#endif', '%%name%%'].join('\n')
    expect(render(t, ['ai'], { name: 'x' })).toBe('a\nb\nd\nx')
    expect(render(t, ['ai', 'copilot'], { name: 'x' })).toBe('a\nb\nc\nx')
    expect(render(t, [], { name: 'x' })).toBe('a\ne\nx')
    expect(render('//#if ai || flow\nz\n//#endif', ['flow'], {})).toBe('z')
    expect(render('//#if ai && flow\nz\n//#endif', ['flow'], {})).toBe('')
  })

  test('refuses a broken template', () => {
    expect(() => render('//#if ai\n', [], {})).toThrow('without //#endif')
    expect(() => render('//#endif', [], {})).toThrow('without //#if')
    expect(() => render('//#if nope\n//#endif', [], {})).toThrow('unknown kit')
    expect(() => render('%%missing%%', [], {})).toThrow('no value')
  })
})

describe('choices', () => {
  test('names', () => {
    expect(nameProblem('my-product')).toBeNull()
    for (const bad of ['My-Product', 'a', '-x', 'x-', 'my--product', 'my_product', '9lives']) expect(nameProblem(bad)).not.toBeNull()
  })

  test('kits bring what they run on', () => {
    expect(resolveKits(['copilot'])).toEqual(['ai', 'copilot'])
    expect(resolveKits(['flow', 'oauth'])).toEqual(['ai', 'flow', 'oauth'])
    expect(resolveKits(PRESETS.full)).toEqual(KITS)
    expect(() => resolveKits(['nope'])).toThrow('unknown kit')
  })

  test('versioned with the SDK', () => {
    expect(ownVersion()).toBe(sdkVersion())
  })
})

describe('the minimal preset', () => {
  const { files } = plan({ name: 'my-product', kits: PRESETS.minimal, devSecret: 's' })

  test('has the base and nothing more', () => {
    const paths = Object.keys(files).sort()
    expect(paths).toContain('src/capabilities.ts')
    expect(paths).toContain('src/guard.ts')
    expect(paths).toContain('src/door.ts')
    expect(paths).toContain('test/catalog.test.ts')
    expect(paths).toContain('test/injection.test.ts')
    expect(paths).toContain('.gitignore')
    for (const p of ['src/ai.ts', 'src/actor.ts', 'src/flow.ts', 'src/copilot.ts', 'src/oauth.ts', 'src/page.ts']) expect(paths).not.toContain(p)
    expect(paths.filter((p) => p.startsWith('migrations/'))).toEqual(['migrations/0001_app.sql', 'migrations/0002_guard.sql'])
  })

  test('pins the SDK to its release tarball', () => {
    const pkg = JSON.parse(files['package.json']!)
    expect(pkg.dependencies['@omazyai/sdk']).toBe(sdkTarballUrl(ownVersion()))
    expect(pkg.dependencies['@modelcontextprotocol/server']).toBe('2.4.0')
    expect(Object.keys(pkg.scripts)).toEqual(expect.arrayContaining(['dev', 'test', 'deploy', 'migrate', 'key']))
    expect(pkg.dependencies.react).toBeUndefined()
  })

  test('binds D1 and KV, and no Durable Objects or Workflows', () => {
    const w = jsonc(files['wrangler.jsonc']!)
    expect(w.d1_databases[0]).toMatchObject({ binding: 'DB', migrations_dir: 'migrations' })
    expect(w.kv_namespaces[0].binding).toBe('KV')
    expect(w.durable_objects).toBeUndefined()
    expect(w.workflows).toBeUndefined()
    expect(w.vars.DOOR_DEFAULT).toBe('off')
    expect(files['.dev.vars']).toContain('DOOR_DEFAULT=on')
  })
})

describe('the full preset', () => {
  const { files } = plan({ name: 'my-product', kits: PRESETS.full, account: ACCOUNT, devSecret: 's' })

  test('has every kit', () => {
    for (const p of ['src/ai.ts', 'src/actor.ts', 'src/flow.ts', 'src/copilot.ts', 'src/oauth.ts', 'src/page.ts', 'evals/note-title.jsonl', 'test/ai.test.ts']) expect(files[p]).toBeDefined()
    expect(Object.keys(files).filter((p) => p.startsWith('migrations/'))).toEqual([
      'migrations/0001_app.sql',
      'migrations/0002_guard.sql',
      'migrations/0003_ai.sql',
      'migrations/0004_actors.sql',
      'migrations/0005_flows.sql',
      'migrations/0006_copilot.sql',
    ])
  })

  test('binds the Durable Objects, the Workflow, assets and rate limits the kits need', () => {
    const w = jsonc(files['wrangler.jsonc']!)
    expect(w.account_id).toBe(ACCOUNT)
    expect(w.durable_objects.bindings.map((b: { class_name: string }) => b.class_name)).toEqual(['CopilotThreads', 'OAuthRefreshLock'])
    expect(w.migrations[0].new_sqlite_classes).toEqual(['CopilotThreads', 'OAuthRefreshLock'])
    expect(w.workflows[0]).toMatchObject({ binding: 'NOTE_FOLLOWUP', class_name: 'NoteFollowup' })
    expect(w.compatibility_flags).toEqual(['global_fetch_strictly_public'])
    expect(w.ratelimits.map((r: { name: string }) => r.name)).toEqual(['AUTHORIZE_LIMIT', 'TOKEN_LIMIT'])
    expect(w.assets.binding).toBe('ASSETS')
    expect(w.vars.OAUTH).toBe('off')
  })

  test('the AI unit carries its eval set and threshold', () => {
    expect(files['src/ai.ts']).toContain("evals: { path: 'evals/note-title.jsonl', threshold: 0.9 }")
  })
})

describe('every combination', () => {
  const combos: string[][] = [[]]
  for (const k of KITS) for (const c of [...combos]) combos.push([...c, k])

  test('renders clean text', () => {
    for (const kits of combos) {
      const { files } = plan({ name: 'my-product', kits, devSecret: 's' })
      for (const [path, text] of Object.entries(files)) {
        expect(`${path}: ${/^\s*\/\/#/m.test(text)}`).toBe(`${path}: false`)
        expect(`${path}: ${text.includes('%%')}`).toBe(`${path}: false`)
        // No dashes the house style leaves out, and nothing that names the private repository.
        expect(`${path}: ${PRIVATE.test(text)}`).toBe(`${path}: false`)
      }
    }
  })
})

describe('migrations', () => {
  test('are the kits\' own SQL from this release (bun scripts/sync-migrations.ts)', () => {
    for (const [file, sql] of Object.entries(kitMigrations())) expect(readFileSync(join(import.meta.dir, '../templates/migrations', file), 'utf8')).toBe(sql)
  })
})

describe('the command', () => {
  test('writes a project from flags, with a local SDK', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'coa-'))
    const cwd = process.cwd()
    process.chdir(dir)
    try {
      const sdk = join(import.meta.dir, '../../typescript')
      expect(await main(['shop', '--preset', 'minimal', '--sdk', sdk, '--yes'])).toBe(0)
      const pkg = JSON.parse(readFileSync(join(dir, 'shop/package.json'), 'utf8'))
      expect(pkg.dependencies['@omazyai/sdk']).toBe(`file:${sdk}`)
      expect(await main(['shop', '--yes'])).toBe(1) // not empty
      expect(await main(['Bad Name', '--yes'])).toBe(2)
      expect(await main(['ok-name', '--kits', 'nope', '--yes'])).toBe(1)
      expect(await main(['ok-name', '--account', 'xyz', '--yes'])).toBe(2)
      expect(readdirSync(dir)).toEqual(['shop'])
    } finally {
      process.chdir(cwd)
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test('write refuses a folder that is not empty', () => {
    const dir = mkdtempSync(join(tmpdir(), 'coa-'))
    try {
      write(dir, { 'a.txt': 'a' })
      expect(() => write(dir, { 'b.txt': 'b' })).toThrow('not empty')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

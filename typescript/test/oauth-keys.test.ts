// @omazyai/sdk/oauth/keys loads without the OAuth provider. The source is
// copied to a directory with no node_modules, so the provider and
// `cloudflare:workers` are truly absent, and a plain bun process (no test
// runner, no stand-in) mints and resolves a key there. The full oauth entry
// is the control: in the same copy it must fail to load.

import { afterAll, describe, expect, test } from 'bun:test'
import { cpSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const dir = mkdtempSync(join(tmpdir(), 'omazy-oauth-keys-'))
cpSync(join(import.meta.dir, '../src'), join(dir, 'src'), { recursive: true })
afterAll(() => rmSync(dir, { recursive: true, force: true }))

function run(script: string) {
  const file = join(dir, `run-${crypto.randomUUID()}.ts`)
  writeFileSync(file, script)
  const r = Bun.spawnSync([process.execPath, file], { cwd: dir, env: { PATH: process.env.PATH ?? '' } })
  return { code: r.exitCode, out: r.stdout.toString(), err: r.stderr.toString() }
}

describe('oauth/keys entry', () => {
  test('mints and resolves a personal key with the provider absent, and prints nothing', () => {
    const r = run(`
      import { Keys, memoryKv, PERSONAL_TIER_CAP } from './src/oauth/keys.ts'
      const keys = new Keys(memoryKv(), ['platform'], { personal: { prefix: () => 'acme_mcp_platform_' } }, ['platform'])
      const { key, info } = await keys.createPersonal({
        principal: { kind: 'staff', id: 'rina' },
        seat: { id: 'seat-rina', door: 'platform', tenant: null },
        name: 'laptop',
        days: 30,
      })
      const found = await keys.resolve(key, 'platform')
      process.stdout.write(JSON.stringify({ prefixed: key.startsWith('acme_mcp_platform_'), id: info.id, tier: found?.grant.maxTier, cap: PERSONAL_TIER_CAP }))
    `)
    expect(r.err).toBe('')
    expect(r.code).toBe(0)
    const out = JSON.parse(r.out)
    expect(out.prefixed).toBe(true)
    expect(out.id).toMatch(/^pk_/)
    expect(out.tier).toBe('R2')
    expect(out.cap).toBe('R2')
  })

  test('control: the full oauth entry needs the provider', () => {
    const r = run(`import './src/oauth/index.ts'`)
    expect(r.code).not.toBe(0)
    expect(r.err).toContain('workers-oauth-provider')
  })
})

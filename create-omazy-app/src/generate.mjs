// Writes a new product from the templates. Pure apart from the file system:
// `plan()` gives the files as a map, `write()` puts them on disk. The CLI and
// the tests share both.

import { randomBytes } from 'node:crypto'
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
export const TEMPLATES = join(HERE, '..', 'templates')

/** The kits a product can choose beyond the base of capabilities, guard and mcp. */
export const KITS = ['ai', 'actor', 'flow', 'copilot', 'oauth']

export const PRESETS = {
  minimal: [],
  full: ['ai', 'actor', 'flow', 'copilot', 'oauth'],
}

/** What a kit needs before it. A copilot, an actor and a flow all run on the ai kit. */
const NEEDS = { actor: ['ai'], flow: ['ai'], copilot: ['ai'] }

/** The SDK version this scaffolder ships with: always the same as its own. */
export function ownVersion() {
  return JSON.parse(readFileSync(join(HERE, '..', 'package.json'), 'utf8')).version
}

/** The release tarball of the SDK at a version. */
export function sdkTarballUrl(version) {
  return `https://github.com/omazyai/omazy-sdk/releases/download/v${version}/omazyai-sdk-${version}.tgz`
}

const NAME = /^[a-z][a-z0-9-]{1,48}[a-z0-9]$/

/** Checks a project name: lowercase letters, digits and dashes, 3 to 50 characters. Returns a sentence, or null when it is fine. */
export function nameProblem(name) {
  if (typeof name !== 'string' || !NAME.test(name)) return 'A name is 3 to 50 lowercase letters, digits and dashes, starting with a letter.'
  if (name.includes('--')) return 'A name has no double dashes.'
  return null
}

/** Adds what each chosen kit needs and orders them. Throws on an unknown kit. */
export function resolveKits(kits) {
  const out = new Set()
  for (const k of kits) {
    if (!KITS.includes(k)) throw new Error(`unknown kit "${k}"; choose from ${KITS.join(', ')}`)
    out.add(k)
    for (const n of NEEDS[k] ?? []) out.add(n)
  }
  return KITS.filter((k) => out.has(k))
}

/** A Cloudflare account id is 32 hex characters. */
export function accountProblem(id) {
  if (id && !/^[0-9a-f]{32}$/.test(id)) return 'A Cloudflare account id is 32 hexadecimal characters (wrangler whoami lists yours).'
  return null
}

// ---------------------------------------------------------------- the template language

// Whole lines only. `//#if ai`, `//#if !oauth`, `//#if ai && copilot`,
// `//#if actor || flow`, `//#else`, `//#endif`; nesting is fine. A directive
// line never reaches the output, in any file type. `%%name%%` fills a value.

function truth(expr, kits) {
  return expr.split('||').some((any) =>
    any.split('&&').every((term) => {
      const t = term.trim()
      const neg = t.startsWith('!')
      const kit = neg ? t.slice(1).trim() : t
      if (!KITS.includes(kit)) throw new Error(`template: unknown kit "${kit}" in //#if`)
      return neg !== kits.includes(kit)
    }),
  )
}

export function render(text, kits, values, file = 'template') {
  const out = []
  const stack = []
  const on = () => stack.every((s) => s.on)
  const lines = text.split('\n')
  lines.forEach((line, i) => {
    const d = line.trim().match(/^\/\/#(if|else|endif)\b\s*(.*)$/)
    if (d) {
      if (d[1] === 'if') stack.push({ on: truth(d[2], kits), seenElse: false })
      else if (d[1] === 'else') {
        const top = stack.at(-1)
        if (!top || top.seenElse) throw new Error(`${file}:${i + 1}: //#else without //#if`)
        top.on = !top.on
        top.seenElse = true
      } else if (!stack.pop()) throw new Error(`${file}:${i + 1}: //#endif without //#if`)
      return
    }
    if (on()) out.push(line)
  })
  if (stack.length) throw new Error(`${file}: //#if without //#endif`)
  // A block left out can leave two blank lines; keep one.
  return out.join('\n').replace(/\n{3,}/g, '\n\n').replace(/%%([a-zA-Z]+)%%/g, (m, key) => {
    if (!(key in values)) throw new Error(`${file}: no value for ${m}`)
    return values[key]
  })
}

// ---------------------------------------------------------------- files

/** Which template files each kit brings. Everything else is in every product. */
const FILE_KITS = {
  'src/ai.ts': 'ai',
  'evals/note-title.jsonl': 'ai',
  'test/ai.test.ts': 'ai',
  'src/actor.ts': 'actor',
  'evals/note-intake.jsonl': 'actor',
  'test/actor.test.ts': 'actor',
  'src/flow.ts': 'flow',
  'test/flow.test.ts': 'flow',
  'src/copilot.ts': 'copilot',
  'src/page.ts': 'copilot',
  'test/copilot.test.ts': 'copilot',
  'public/.gitkeep': 'copilot',
  'tsconfig.page.json': 'copilot',
  'evals/notes-copilot.jsonl': 'copilot',
  'src/oauth.ts': 'oauth',
}

/** Template files whose published name differs (npm drops a `.gitignore` from a package). */
const RENAME = { gitignore: '.gitignore' }

/** The SQL each kit adds, in the order wrangler applies them. */
const MIGRATIONS = [
  { file: 'app.sql', kit: null },
  { file: 'guard.sql', kit: null },
  { file: 'ai.sql', kit: 'ai' },
  { file: 'actors.sql', kit: 'actor' },
  { file: 'flows.sql', kit: 'flow' },
  { file: 'copilot.sql', kit: 'copilot' },
]

function walk(dir) {
  const out = []
  for (const e of readdirSync(dir)) {
    const p = join(dir, e)
    if (statSync(p).isDirectory()) out.push(...walk(p))
    else out.push(p)
  }
  return out
}

const slugOf = (name) => name.replace(/-/g, '_')
const titleOf = (name) => name.split('-').map((w) => w[0].toUpperCase() + w.slice(1)).join(' ')

/**
 * The product's files, as `{ path: text }`.
 *
 * @param {{ name: string, kits?: string[], account?: string, sdk?: string, secret?: string, devSecret?: string }} o
 *   `sdk` is the dependency spec of `@omazyai/sdk`: by default the release
 *   tarball of this version; a path to a local `.tgz` or folder, or a URL, to
 *   test against another build.
 */
export function plan(o) {
  const bad = nameProblem(o.name) ?? accountProblem(o.account)
  if (bad) throw new Error(bad)
  const kits = resolveKits(o.kits ?? [])
  const version = ownVersion()
  const slug = slugOf(o.name)
  const values = {
    name: o.name,
    slug,
    title: titleOf(o.name),
    keyPrefix: `${slug.slice(0, 30)}_key_`,
    version,
  }
  const files = {}
  for (const path of walk(TEMPLATES)) {
    let rel = relative(TEMPLATES, path).split('\\').join('/')
    if (rel.startsWith('migrations/')) continue
    const kit = FILE_KITS[rel]
    if (kit && !kits.includes(kit)) continue
    rel = RENAME[rel] ?? rel
    files[rel] = render(readFileSync(path, 'utf8'), kits, values, rel)
  }
  let n = 0
  for (const m of MIGRATIONS) {
    if (m.kit && !kits.includes(m.kit)) continue
    n++
    files[`migrations/${String(n).padStart(4, '0')}_${m.file}`] = readFileSync(join(TEMPLATES, 'migrations', m.file), 'utf8')
  }
  files['package.json'] = packageJson(o, kits, version)
  files['wrangler.jsonc'] = wranglerConfig(o, kits)
  files['.dev.vars'] = devVars(kits, o.devSecret ?? randomBytes(32).toString('base64url'))
  return { files, kits, version }
}

/** Writes the plan into `dir`, which must not exist or be empty. */
export function write(dir, files) {
  if (existsSync(dir) && readdirSync(dir).length > 0) throw new Error(`${dir} is not empty`)
  for (const [rel, text] of Object.entries(files)) {
    const p = join(dir, rel)
    mkdirSync(dirname(p), { recursive: true })
    writeFileSync(p, text, rel.startsWith('scripts/') ? { mode: 0o755 } : undefined)
  }
}

// ---------------------------------------------------------------- generated files

function packageJson(o, kits, version) {
  const has = (k) => kits.includes(k)
  const dev = has('copilot') ? 'npm run build:page && wrangler dev' : 'wrangler dev'
  const pkg = {
    name: o.name,
    version: '0.1.0',
    private: true,
    type: 'module',
    scripts: {
      dev,
      test: 'vitest run',
      typecheck: has('copilot') ? 'tsc --noEmit && tsc --noEmit -p tsconfig.page.json' : 'tsc --noEmit',
      check: 'npm run typecheck && npm test',
      ...(has('copilot') ? { 'build:page': 'esbuild src/page.ts --bundle --format=esm --minify --outfile=public/app.js' } : {}),
      setup: 'node scripts/setup.mjs',
      migrate: 'wrangler d1 migrations apply DB --local',
      'migrate:remote': 'wrangler d1 migrations apply DB --remote',
      deploy: has('copilot') ? 'npm run build:page && wrangler deploy' : 'wrangler deploy',
      key: 'node scripts/key.mjs',
      door: 'node scripts/door.mjs',
    },
    dependencies: {
      '@omazyai/sdk': o.sdk ?? sdkTarballUrl(version),
      '@modelcontextprotocol/server': '2.4.0',
      ...(has('oauth') ? { '@cloudflare/workers-oauth-provider': '1.3.0' } : {}),
      ...(has('copilot') ? { react: '19.3.1', 'react-dom': '19.3.1' } : {}),
    },
    devDependencies: {
      '@cloudflare/workers-types': '5.20261110.1',
      ...(has('copilot') ? { '@types/react': '19.3.0', '@types/react-dom': '19.3.0', esbuild: '0.28.2' } : {}),
      typescript: '5.9.3',
      vitest: '4.0.18',
      wrangler: '4.160.1',
    },
    engines: { node: '>=20' },
  }
  return `${JSON.stringify(pkg, null, 2)}\n`
}

function wranglerConfig(o, kits) {
  const has = (k) => kits.includes(k)
  const durable = []
  if (has('copilot')) durable.push({ name: 'COPILOT_THREADS', class_name: 'CopilotThreads' })
  if (has('oauth')) durable.push({ name: 'OAUTH_REFRESH', class_name: 'OAuthRefreshLock' })
  const cfg = {
    $schema: 'node_modules/wrangler/config-schema.json',
    name: o.name,
    main: 'src/index.ts',
    compatibility_date: '2026-07-01',
    ...(has('oauth') ? { compatibility_flags: ['global_fetch_strictly_public'] } : {}),
    ...(o.account ? { account_id: o.account } : {}),
    workers_dev: true,
    d1_databases: [{ binding: 'DB', database_name: o.name, database_id: 'local', migrations_dir: 'migrations' }],
    kv_namespaces: [{ binding: 'KV', id: 'local' }],
    ...(durable.length
      ? {
          durable_objects: { bindings: durable },
          migrations: [{ tag: 'v1', new_sqlite_classes: durable.map((d) => d.class_name) }],
        }
      : {}),
    ...(has('flow') ? { workflows: [{ name: `${o.name}-note-followup`, binding: 'NOTE_FOLLOWUP', class_name: 'NoteFollowup' }] } : {}),
    ...(has('oauth')
      ? {
          ratelimits: [
            { name: 'AUTHORIZE_LIMIT', namespace_id: '1001', simple: { limit: 30, period: 60 } },
            { name: 'TOKEN_LIMIT', namespace_id: '1002', simple: { limit: 60, period: 60 } },
          ],
        }
      : {}),
    ...(has('copilot') ? { assets: { directory: './public', binding: 'ASSETS', run_worker_first: true } } : {}),
    vars: {
      DOOR_DEFAULT: 'off',
      ...(has('ai') ? { OMAZY_BASE_URL: 'https://mw.omazy.ai/api/v1/core' } : {}),
      ...(has('oauth') ? { OAUTH: 'off', ISSUER: '' } : {}),
    },
    observability: { enabled: true },
  }
  const head = [
    '// The Worker and its bindings. `npm run setup` creates the D1 database and',
    '// the KV namespace on your Cloudflare account and writes their ids here.',
    '// Secrets are not here: `npm run setup` sets GUARD_SECRET, and .dev.vars',
    '// holds the local ones.',
    '//',
    '// DOOR_DEFAULT is "off": the MCP door answers 503 in production until you turn',
    '// it on with `npm run door -- on --remote`. .dev.vars sets it "on" for',
    '// `wrangler dev`.',
  ]
  if (has('oauth')) {
    head.push('//', '// OAUTH is "off". Read the oauth kit page before you turn it on, and follow its', '// setup rules: platformDoors, known clients, checkSeat, a consistent refresh store.')
  }
  return `${head.join('\n')}\n${JSON.stringify(cfg, null, 2)}\n`
}

function devVars(kits, secret) {
  const lines = [
    '# Local values for `wrangler dev`. Never commit this file.',
    `GUARD_SECRET=${secret}`,
    'DOOR_DEFAULT=on',
    '# Approval codes print to this console. Only here: production sends them by mail or SMS.',
    'STEP_UP_LOG=1',
  ]
  if (kits.includes('ai')) lines.push('# A Core API token from your Omazy workspace (Settings, then API keys).', 'OMAZY_TOKEN=')
  if (kits.includes('oauth')) lines.push('OAUTH=off', 'ISSUER=http://localhost:8787')
  return `${lines.join('\n')}\n`
}

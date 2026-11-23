// The command line: questions when run in a terminal, flags otherwise.

import { existsSync } from 'node:fs'
import { resolve } from 'node:path'
import { createInterface } from 'node:readline/promises'
import { accountProblem, KITS, nameProblem, ownVersion, plan, PRESETS, resolveKits, write } from './generate.mjs'

const HELP = `Creates an AI product on the Omazy SDK kits: a Cloudflare Worker with
capabilities, the guard and an MCP door, ready to deploy.

  npm create omazy-app@latest my-product
  npm create omazy-app@latest my-product -- --preset full
  bun create omazy-app my-product
  pnpm create omazy-app my-product

Options:
  --preset minimal|full   minimal: capabilities, guard and mcp. full: every kit.
  --kits a,b              pick kits on top of the base: ${KITS.join(', ')}
                          (actor, flow and copilot bring ai)
  --account <id>          your Cloudflare account id (wrangler whoami)
  --sdk <path or url>     install @omazyai/sdk from a local build or another
                          tarball instead of this version's release
  --yes                   ask nothing; take the defaults
  --help, --version`

function parse(argv) {
  const o = { _: [] }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (!a.startsWith('--')) {
      o._.push(a)
      continue
    }
    const [k, inline] = a.slice(2).split('=', 2)
    if (['yes', 'help', 'version'].includes(k)) o[k] = true
    else {
      const v = inline ?? argv[++i]
      if (v === undefined) throw new Error(`--${k} needs a value`)
      o[k] = v
    }
  }
  return o
}

function packageManager() {
  const ua = process.env.npm_config_user_agent ?? ''
  if (ua.startsWith('bun')) return 'bun'
  if (ua.startsWith('pnpm')) return 'pnpm'
  if (ua.startsWith('yarn')) return 'yarn'
  return 'npm'
}

/** A local path becomes `file:` with an absolute path; a URL or a version stays as given. */
function sdkSpec(v) {
  if (!v) return undefined
  if (/^(https?:|file:|github:|git\+)/.test(v)) return v
  const p = resolve(v)
  if (!existsSync(p)) throw new Error(`--sdk ${v}: no such file or folder`)
  return `file:${p}`
}

export async function main(argv = process.argv.slice(2)) {
  let o
  try {
    o = parse(argv)
  } catch (e) {
    console.error(e.message)
    return 2
  }
  if (o.help) {
    console.log(HELP)
    return 0
  }
  if (o.version) {
    console.log(ownVersion())
    return 0
  }
  const known = new Set(['_', 'preset', 'kits', 'account', 'sdk', 'yes'])
  for (const k of Object.keys(o)) if (!known.has(k)) {
    console.error(`unknown option --${k}\n\n${HELP}`)
    return 2
  }

  const ask = !o.yes && process.stdin.isTTY && process.stdout.isTTY
  const rl = ask ? createInterface({ input: process.stdin, output: process.stdout }) : null
  try {
    let name = o._[0]
    while (rl && (!name || nameProblem(name))) {
      if (name) console.log(nameProblem(name))
      name = (await rl.question('Project name: ')).trim()
    }
    if (!name) {
      console.error('Give the project a name: npm create omazy-app@latest my-product')
      return 2
    }
    const bad = nameProblem(name)
    if (bad) {
      console.error(bad)
      return 2
    }

    let kits
    if (o.kits !== undefined) kits = o.kits.split(',').map((k) => k.trim()).filter(Boolean)
    else if (o.preset !== undefined) {
      if (!(o.preset in PRESETS)) {
        console.error(`--preset is minimal or full`)
        return 2
      }
      kits = PRESETS[o.preset]
    } else if (rl) {
      const p = (await rl.question('Kits: minimal (capabilities, guard, mcp), full, or custom? [minimal] ')).trim() || 'minimal'
      if (p === 'custom') {
        kits = []
        for (const k of KITS) {
          const note = k === 'oauth' ? ' (off by default; its fixes still need a final review)' : ''
          if (/^y/i.test((await rl.question(`  ${k}${note}? [y/N] `)).trim())) kits.push(k)
        }
      } else kits = PRESETS[p] ?? PRESETS.minimal
    } else kits = PRESETS.minimal
    kits = resolveKits(kits)

    let account = o.account
    if (account === undefined && rl) account = (await rl.question('Cloudflare account id (wrangler whoami; Enter to skip): ')).trim() || undefined
    const badAccount = accountProblem(account)
    if (badAccount) {
      console.error(badAccount)
      return 2
    }

    const dir = resolve(name)
    const { files } = plan({ name, kits, account, sdk: sdkSpec(o.sdk) })
    write(dir, files)
    const pm = packageManager()
    const run = pm === 'npm' ? 'npm run' : pm
    console.log(`
Created ${name} with capabilities, guard, mcp${kits.length ? `, ${kits.join(', ')}` : ''}.

  cd ${name}
  ${pm} install
  ${run} migrate
  ${run} key -- --person you --tenant demo
  ${run} dev

Then call the door at http://localhost:8787/mcp with the key as a bearer
token. README.md walks through it, and on to a deploy.`)
    return 0
  } catch (e) {
    console.error(e instanceof Error ? e.message : String(e))
    return 1
  } finally {
    rl?.close()
  }
}

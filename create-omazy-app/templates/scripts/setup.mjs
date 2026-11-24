#!/usr/bin/env node
// Puts the product on your Cloudflare account, once: builds the page, creates
// the D1 database and the KV namespace and writes their ids into
// wrangler.jsonc, applies the migrations, deploys, and sets GUARD_SECRET. Run
// it again safely: what exists is kept.
//
//   npm run setup

import { execFileSync } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { readFileSync, writeFileSync } from 'node:fs'
import { fail, wrangler } from './wrangler.mjs'

const CONFIG = new URL('../wrangler.jsonc', import.meta.url)

// The page first, so the deploy below ships the current one and a build
// error stops setup before anything is made on Cloudflare.
const scripts = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).scripts ?? {}
if (scripts['build:page']) {
  console.log('building the page')
  execFileSync('npm', ['run', '--silent', 'build:page'], { stdio: 'inherit' })
}

let text = readFileSync(CONFIG, 'utf8')
const name = text.match(/"name": "([^"]+)"/)?.[1] ?? fail('wrangler.jsonc has no name')

const jsonOut = (out) => JSON.parse(out.slice(out.search(/[[{]/)))

// D1
if (/"database_id": "local"/.test(text)) {
  let db = jsonOut(wrangler(['d1', 'list', '--json'])).find((d) => d.name === name)
  if (!db) {
    console.log(`creating the D1 database ${name}`)
    wrangler(['d1', 'create', name])
    db = jsonOut(wrangler(['d1', 'list', '--json'])).find((d) => d.name === name)
  }
  if (!db?.uuid) fail(`could not find the D1 database ${name} after creating it`)
  text = text.replace(/"database_id": "local"/, `"database_id": "${db.uuid}"`)
  writeFileSync(CONFIG, text)
}

// KV
if (/"binding": "KV",\s*"id": "local"/.test(text)) {
  const title = `${name}-kv`
  const find = () => jsonOut(wrangler(['kv', 'namespace', 'list'])).find((n) => n.title === title)
  let ns = find()
  if (!ns) {
    console.log(`creating the KV namespace ${title}`)
    wrangler(['kv', 'namespace', 'create', title])
    ns = find()
  }
  if (!ns?.id) fail(`could not find the KV namespace ${title} after creating it`)
  text = text.replace(/("binding": "KV",\s*"id": )"local"/, `$1"${ns.id}"`)
  writeFileSync(CONFIG, text)
}

console.log('applying the migrations')
wrangler(['d1', 'migrations', 'apply', 'DB', '--remote'])
console.log('deploying')
const out = wrangler(['deploy'])
const url = out.match(/https:\/\/\S+\.workers\.dev/)?.[0]

const secrets = jsonOut(wrangler(['secret', 'list', '--format', 'json'])).map((s) => s.name)
if (!secrets.includes('GUARD_SECRET')) {
  console.log('setting GUARD_SECRET')
  wrangler(['secret', 'put', 'GUARD_SECRET'], { input: randomBytes(32).toString('base64url') })
}

console.log(`
Deployed${url ? ` at ${url}` : ''}. The MCP door is off until you turn it on:

  npm run key -- --person you --tenant demo --remote
  npm run door -- on --remote
`)

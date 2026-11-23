#!/usr/bin/env node
// Mints a personal key: one person's seat in one tenant at the MCP door, at
// most R2 and 90 days. Prints the key once; only its SHA-256 is stored.
//
//   npm run key -- --person rina --tenant demo               for wrangler dev
//   npm run key -- --person rina --tenant demo --remote      for the deployed Worker
//   options: --name laptop  --days 30

import { readFileSync } from 'node:fs'
import { Keys } from '@omazyai/sdk/oauth/keys'
import { fail, flags, wrangler } from './wrangler.mjs'

const f = flags()
const person = f.person ?? 'me'
const tenant = f.tenant ?? 'demo'
const days = f.days ? Number(f.days) : 30
const where = f.remote ? '--remote' : '--local'
if (!/^[A-Za-z0-9._@-]{1,64}$/.test(person) || !/^[A-Za-z0-9._@-]{1,64}$/.test(tenant)) fail('--person and --tenant take letters, digits and . _ @ -')

const config = JSON.parse(readFileSync(new URL('../src/keys.json', import.meta.url), 'utf8'))

// The KV namespace through wrangler: a key needs only two writes.
const kv = {
  async put(key, value, opts) {
    wrangler(['kv', 'key', 'put', key, value, '--binding', 'KV', where, ...(opts?.expiration ? ['--expiration', String(opts.expiration)] : [])])
  },
  async get() {
    return null
  },
  async delete() {},
  async list() {
    return { keys: [], list_complete: true }
  },
}

const keys = new Keys(kv, [config.door], { personal: { prefix: () => config.prefix } })
const { key, info } = await keys.createPersonal({
  principal: { kind: 'member', id: person, name: person },
  seat: { id: `seat_${person}`, door: config.door, tenant },
  name: typeof f.name === 'string' ? f.name : 'personal key',
  days,
})
console.error(`A personal key for ${person} in ${tenant} at the ${config.door} door, ${where.slice(2)}, until ${new Date(info.expiresAt).toISOString().slice(0, 10)}. It is shown once:`)
console.log(key)

#!/usr/bin/env node
// Turns the MCP door on or off: a global kill switch row in D1. A deployed
// Worker starts with the door off (DOOR_DEFAULT "off"); turning it off again
// stops every request within a few seconds.
//
//   npm run door -- on --remote
//   npm run door -- off --remote --reason "Down for maintenance."

import { readFileSync } from 'node:fs'
import { fail, flags, wrangler } from './wrangler.mjs'

const f = flags()
const state = f._[0]
if (state !== 'on' && state !== 'off') fail('npm run door -- on|off [--remote] [--reason "..."]')
const { door } = JSON.parse(readFileSync(new URL('../src/keys.json', import.meta.url), 'utf8'))
const quote = (s) => `'${String(s).replace(/'/g, "''")}'`
const reason = typeof f.reason === 'string' ? quote(f.reason.slice(0, 200)) : 'NULL'
const sql =
  'INSERT INTO guard_switches (key, scope, subject, is_on, reason, updated_at, updated_by) ' +
  `VALUES (${quote(`door:${door}`)}, 'global', '', ${state === 'on' ? 1 : 0}, ${reason}, ${quote(new Date().toISOString())}, 'cli') ` +
  'ON CONFLICT (scope, subject, key) DO UPDATE SET is_on = excluded.is_on, reason = excluded.reason, updated_at = excluded.updated_at, updated_by = excluded.updated_by'
wrangler(['d1', 'execute', 'DB', f.remote ? '--remote' : '--local', '--command', sql])
console.log(`The ${door} door is ${state}${f.remote ? '' : ' (local)'}.`)

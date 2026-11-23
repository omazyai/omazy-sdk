// Small helpers the scripts share: run wrangler, read flags.

import { execFileSync } from 'node:child_process'

/** Runs wrangler from this project's node_modules and returns what it printed. */
export function wrangler(args, o = {}) {
  return execFileSync('npx', ['wrangler', ...args], { encoding: 'utf8', stdio: [o.input === undefined ? 'ignore' : 'pipe', 'pipe', 'inherit'], input: o.input })
}

/** `--name value` and `--flag` from the command line. */
export function flags(argv = process.argv.slice(2)) {
  const out = { _: [] }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (!a.startsWith('--')) {
      out._.push(a)
      continue
    }
    const key = a.slice(2)
    const next = argv[i + 1]
    if (next !== undefined && !next.startsWith('--')) {
      out[key] = next
      i++
    } else out[key] = true
  }
  return out
}

/** Prints a sentence and stops. */
export function fail(message) {
  console.error(message)
  process.exit(1)
}

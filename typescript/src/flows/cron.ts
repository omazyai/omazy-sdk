// Five-field cron (minute hour day-of-month month day-of-week): `*`, lists,
// ranges and steps. Day names, month names and `L`, `W`, `#` are not
// supported. Read in UTC, the way Cloudflare Cron Triggers read it, or in an
// IANA time zone through Intl, so "Sunday 09:00" can mean a tenant's Sunday
// 09:00. No dependency.
//
// Across a daylight saving change the fields are read as wall-clock time: a
// time in the hour that is skipped does not occur that day, and a time in the
// hour that repeats matches twice. An automation's default run key is the
// local minute, so the repeat finds its run and starts nothing.

const FIELDS: readonly [number, number][] = [
  [0, 59],
  [0, 23],
  [1, 31],
  [1, 12],
  [0, 7],
]

export class CronError extends Error {
  override readonly name = 'CronError'
}

function field(src: string, [min, max]: [number, number]): Set<number> {
  const out = new Set<number>()
  for (const part of src.split(',')) {
    const m = /^(\*|(\d+)(?:-(\d+))?)(?:\/(\d+))?$/.exec(part)
    if (!m) throw new CronError(`bad cron field: ${src}`)
    const step = m[4] ? Number(m[4]) : 1
    let lo = min
    let hi = max
    if (m[1] !== '*') {
      lo = Number(m[2])
      hi = m[3] !== undefined ? Number(m[3]) : m[4] ? max : lo
    }
    if (step < 1 || lo < min || hi > max || lo > hi) throw new CronError(`cron field out of range: ${src}`)
    for (let v = lo; v <= hi; v += step) out.add(v)
  }
  return out
}

/** Wall-clock time in a zone. `weekday` 0 is Sunday. */
export interface LocalTime {
  year: number
  month: number
  day: number
  hour: number
  minute: number
  weekday: number
}

const WEEKDAYS: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 }
const formats = new Map<string, Intl.DateTimeFormat>()

function formatFor(tz: string): Intl.DateTimeFormat {
  let f = formats.get(tz)
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', {
      timeZone: tz,
      hourCycle: 'h23',
      year: 'numeric',
      month: 'numeric',
      day: 'numeric',
      hour: 'numeric',
      minute: 'numeric',
      weekday: 'short',
    })
    formats.set(tz, f)
  }
  return f
}

/** True when the runtime knows the IANA zone, such as `Asia/Dhaka`. */
export function isTimeZone(tz: unknown): tz is string {
  if (typeof tz !== 'string' || !tz) return false
  try {
    formatFor(tz)
    return true
  } catch {
    return false
  }
}

/** The wall-clock time of `at` in `tz` (default UTC). Throws `CronError` for a zone the runtime does not know. */
export function localTime(at: number | Date, tz = 'UTC'): LocalTime {
  const d = new Date(typeof at === 'number' ? at : at.getTime())
  if (tz === 'UTC') {
    return { year: d.getUTCFullYear(), month: d.getUTCMonth() + 1, day: d.getUTCDate(), hour: d.getUTCHours(), minute: d.getUTCMinutes(), weekday: d.getUTCDay() }
  }
  if (!isTimeZone(tz)) throw new CronError(`unknown time zone: ${tz}`)
  const p: Record<string, string> = {}
  for (const part of formatFor(tz).formatToParts(d)) p[part.type] = part.value
  return {
    year: Number(p.year),
    month: Number(p.month),
    day: Number(p.day),
    // Some engines write midnight as 24 even with h23.
    hour: Number(p.hour) % 24,
    minute: Number(p.minute),
    weekday: WEEKDAYS[p.weekday ?? ''] ?? 0,
  }
}

const pad = (n: number, w = 2) => String(n).padStart(w, '0')

/** `2026-11-08T09:00`: the minute holding `at`, as wall-clock time in `tz`. */
export function localMinute(at: number | Date, tz = 'UTC'): string {
  const t = localTime(at, tz)
  return `${pad(t.year, 4)}-${pad(t.month)}-${pad(t.day)}T${pad(t.hour)}:${pad(t.minute)}`
}

export interface CronOptions {
  /** An IANA time zone, such as `Asia/Dhaka`. Default UTC. */
  tz?: string
}

export interface Cron {
  readonly expr: string
  /** The zone the fields are read in. */
  readonly tz: string
  /** True when the minute holding `at` matches, read in `tz` (default: the cron's own zone). */
  matches(at: number | Date, tz?: string): boolean
}

/** Parses a five-field cron. Throws `CronError` on anything else, and on a time zone the runtime does not know. */
export function cron(expr: string, opts: CronOptions = {}): Cron {
  const parts = expr.trim().split(/\s+/)
  if (parts.length !== 5) throw new CronError(`cron needs five fields, has ${parts.length}: ${expr}`)
  const zone = opts.tz ?? 'UTC'
  if (!isTimeZone(zone)) throw new CronError(`unknown time zone: ${zone}`)
  const sets = parts.map((p, i) => field(p, FIELDS[i]!))
  const [mi, ho, dom, mo, dow] = sets as [Set<number>, Set<number>, Set<number>, Set<number>, Set<number>]
  // 7 is Sunday too.
  if (dow.has(7)) dow.add(0)
  const domAny = parts[2] === '*'
  const dowAny = parts[4] === '*'
  return {
    expr,
    tz: zone,
    matches(at, tz) {
      const t = localTime(at, tz ?? zone)
      if (!mi.has(t.minute) || !ho.has(t.hour) || !mo.has(t.month)) return false
      const a = dom.has(t.day)
      const b = dow.has(t.weekday)
      // Standard cron: when both day fields are restricted, either may match.
      return domAny && dowAny ? true : domAny ? b : dowAny ? a : a || b
    },
  }
}

// Prompt templates live in the product's code as a map: template key, then
// version, then language. A run picks one by the unit's prompt reference and
// records the version and language it used, so a bad answer traces to the
// exact text. Nothing is fetched from a hosted prompt store.

import type { PromptSpec } from './manifest.js'

/** A template's text, or a function of the run's variables. `{{name}}` in a string is filled from them. */
export type Template = string | ((vars: Readonly<Record<string, unknown>>) => string)

/** `{ 'tasks/brief-from-site': { 2: { en: '...', bn: '...' } } }` */
export type PromptMap = Readonly<Record<string, Readonly<Record<number, Readonly<Record<string, Template>>>>>>

export interface RenderedPrompt {
  template: string
  version: number
  language: string
  text: string
}

export interface Prompts {
  /** Whether the map holds this template, version and language. */
  has(template: string, version: number, language: string): boolean
  /**
   * The text for a unit's prompt in `language`, or in the unit's first
   * language when it lists no such language. Throws when the map lacks it,
   * or when the text names a variable `vars` does not have.
   */
  render(ref: PromptSpec, vars?: Readonly<Record<string, unknown>>, language?: string): RenderedPrompt
  /** What the map lacks for a unit: one sentence per missing language. */
  problems(ref: PromptSpec): string[]
}

export class PromptError extends Error {
  override readonly name = 'PromptError'
}

const VAR = /\{\{\s*([a-zA-Z_][a-zA-Z0-9_.]*)\s*\}\}/g

function lookup(vars: Readonly<Record<string, unknown>>, path: string): unknown {
  let v: unknown = vars
  for (const k of path.split('.')) {
    if (v === null || typeof v !== 'object' || !Object.hasOwn(v, k)) return undefined
    v = (v as Record<string, unknown>)[k]
  }
  return v
}

/** Fills `{{name}}` from `vars`. A missing variable throws: a blank in a prompt is a bug, not a default. */
export function fill(text: string, vars: Readonly<Record<string, unknown>>, where = 'template'): string {
  return text.replace(VAR, (_, name: string) => {
    const v = lookup(vars, name)
    if (v === undefined || v === null) throw new PromptError(`${where} names {{${name}}}, which the run did not give`)
    return typeof v === 'string' ? v : typeof v === 'number' || typeof v === 'boolean' ? String(v) : JSON.stringify(v)
  })
}

export function promptTemplates(map: PromptMap): Prompts {
  const get = (template: string, version: number, language: string): Template | undefined => map[template]?.[version]?.[language]
  return {
    has: (t, v, l) => get(t, v, l) !== undefined,
    render(ref, vars = {}, language) {
      const lang = language && ref.languages.includes(language) ? language : ref.languages[0]!
      const t = get(ref.template, ref.version, lang)
      const where = `${ref.template} v${ref.version} (${lang})`
      if (t === undefined) throw new PromptError(`no prompt ${where}`)
      const text = typeof t === 'function' ? t(vars) : fill(t, vars, where)
      if (typeof text !== 'string') throw new PromptError(`${where} did not give text`)
      return { template: ref.template, version: ref.version, language: lang, text }
    },
    problems(ref) {
      return ref.languages.filter((l) => get(ref.template, ref.version, l) === undefined).map((l) => `no prompt ${ref.template} v${ref.version} (${l})`)
    },
  }
}

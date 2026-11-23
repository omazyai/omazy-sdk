// The AI units. Every model call belongs to a unit with a manifest: its role
// (never a model name), prompt version, context recipe, caps, the capability
// its output is saved through and its eval set. Runs and their capability
// calls are recorded in D1 (ai_runs, ai_effects). See the ai kit page.

//#if actor
import { EXTRACT_PROMPT } from '@omazyai/sdk/actors'
//#endif
import { promptTemplates, task } from '@omazyai/sdk/ai'
import { schema } from '@omazyai/sdk/capabilities'

/**
 * Reads what a person wrote and drafts a note title. The output is saved
 * through note_add, an R2 capability, so `ai.run` comes back with the guard's
 * preview and confirm token, and the note is added only when the person
 * confirms it (`ai.callInRun` with the token).
 */
export const noteTitle = task({
  id: 'note_title',
  version: 1,
  owner: '%%slug%%',
  model: { use: 'extract.fast', fallback: 'extract.strong', temperature: 0, maxOutputTokens: 200 },
  prompt: { template: 'tasks/note-title', version: 1, languages: ['en'] },
  // The person's text is untrusted: it goes into the fenced last turn, never the template.
  context: { layers: ['platform', 'unit'], budgetTokens: 4000, untrusted: ['text'] },
  memory: { read: [], write: [] },
  input: schema.object({ text: schema.text(4000) }),
  output: schema.object({ title: schema.text(200) }),
  target: 'note_add',
  tools: { allow: [], maxTier: 'R0' },
  evals: { path: 'evals/note-title.jsonl', threshold: 0.9 },
  caps: { perRunUsd: 0.01, perDayUsd: 1 },
})

export const PROMPTS = {
  'tasks/note-title': {
    1: { en: 'Write a title for the note the person sent: at most eight words, in their language, with no quotes.' },
  },
//#if actor
  'actors/note-intake': { 1: { en: EXTRACT_PROMPT } },
//#endif
//#if copilot
  'copilot/notes': {
    1: { en: 'You help the people of one account keep short notes. Read a note when asked, and offer to add one. Answer in a few sentences.' },
  },
//#endif
}

export const prompts = promptTemplates(PROMPTS)

/** The product's persona: the start of every prompt, the same for every call. */
export const PERSONA = 'You work inside %%title%%, a notes product. Never claim a change was made unless a tool result says so.'

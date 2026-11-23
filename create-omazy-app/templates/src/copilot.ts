// The copilot: a conversation with the people of an account, streamed to the
// page. Every call it proposes goes through the guard; an R2 call becomes a
// consent card that only the person's click runs. See the copilot kit page.

import { copilotUnit } from '@omazyai/sdk/ai'

export const notesCopilot = copilotUnit({
  id: 'notes_copilot',
  version: 1,
  owner: '%%slug%%',
  model: { use: 'converse' },
  prompt: { template: 'copilot/notes', version: 1, languages: ['en'] },
  context: { layers: ['platform', 'unit'], budgetTokens: 16_000, untrusted: ['message'] },
  memory: { read: ['working', 'conversation'], write: [] },
  tools: {
    allow: [
      'note_get',
      'note_add',
//#if flow
      'note_followup_start',
//#endif
    ],
    maxTier: 'R2',
  },
  evals: 'evals/notes-copilot.jsonl',
  caps: { perRunUsd: 0.05, perDayUsd: 5 },
})

/** The page: no inline script or style, nothing from another origin, no framing. */
export const PAGE_CSP = "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'"

export const PAGE = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>%%title%%</title>
<link rel="stylesheet" href="/ui.css">
<script type="module" src="/app.js"></script>
</head>
<body>
<div id="root"></div>
</body>
</html>`

export const PAGE_CSS = `
body { margin: 0; }
.app-page { font: 15px/1.5 system-ui, sans-serif; max-width: 44rem; margin: 2rem auto; padding: 0 1rem; display: grid; gap: 2rem; }
.app-page .omz-log { max-height: 60vh; }
.app-key { display: grid; gap: 0.5rem; }
`

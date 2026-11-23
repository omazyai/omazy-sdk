// The page of the copilot example: the ui kit's copilot panel, the standing
// grants section and the approvals inbox, in English or Bangla. Bundled to
// `/app.js` (see the top of copilot-worker.ts); it mounts itself on #root.
//
//   ?as=u_owner   act as the demo's owner, who decides approvals
//   ?lang=bn      Bangla
//
// Approving runs the owner's step-up in the inbox's `stepUp` slot. DEMO ONLY:
// in a development build the slot asks the Worker for a one-time code and
// shows it on the page (the Worker hands it over only with
// DEMO_STEP_UP_CODES=1). A production build drops that code path and says the
// demo sends no code; a product puts its passkey prompt or its own code form,
// which sends the code by email or SMS, in the slot. Refusing needs a reason
// and no step-up: it is the safe direction, like turning a switch off.

import { createElement as h, type ReactNode, useState } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { ApprovalsInbox, CopilotPanel, StandingGrants, type StepUpSlotProps, UiProvider } from '../src/ui/react/index'

export interface PageOptions {
  /** The thread id. Default one kept in localStorage. */
  thread?: string
  /** The demo person, sent as `x-demo-person`. */
  person?: string
  locale?: 'en' | 'bn'
  fetch?: typeof fetch
}

const NoStepUp = (s: StepUpSlotProps): ReactNode =>
  h('div', null, h('p', null, `This demo sends no ${s.methods.join(' or ')}. Refuse the request instead, or wire your step-up here.`), h('button', { type: 'button', className: 'omz-btn', onClick: s.cancel }, 'Close'))

/**
 * DEMO ONLY: never ship this. It shows the step-up code on the page so the
 * approve path can be tried without a mail sender. A real code form sends the
 * code to the decider's verified email or phone and only asks for it here.
 */
function DemoCodeStepUp(p: StepUpSlotProps & { fetch: typeof fetch; person?: string }): ReactNode {
  const [code, setCode] = useState<string | null>(null)
  const [typed, setTyped] = useState('')
  const [error, setError] = useState<string | null>(null)
  const ask = async () => {
    setError(null)
    try {
      const res = await p.fetch(`/demo/step-up/${encodeURIComponent(p.approval.id)}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...(p.person ? { 'x-demo-person': p.person } : {}) },
        body: '{}',
      })
      const body = (await res.json().catch(() => ({}))) as { code?: string; error?: { message?: string } }
      if (!res.ok || !body.code) throw new Error(body.error?.message ?? 'The Worker hands out demo codes only with DEMO_STEP_UP_CODES=1.')
      setCode(body.code)
    } catch (e) {
      setError((e as Error).message)
    }
  }
  return h(
    'div',
    { className: 'notes-demo-stepup' },
    h('p', { className: 'omz-note' }, h('strong', null, 'Demo only. '), 'A product sends this code by email or SMS and never shows it on the page.'),
    code
      ? h(
          'form',
          {
            onSubmit: (e: { preventDefault(): void }) => {
              e.preventDefault()
              p.done({ method: 'code', codes: { email: typed.trim() } })
            },
          },
          h('p', { className: 'notes-demo-code' }, 'Demo code: ', h('code', null, code)),
          h('label', { className: 'omz-field' }, h('span', null, 'Code'), h('input', { value: typed, inputMode: 'numeric', autoComplete: 'one-time-code', onChange: (e: { target: { value: string } }) => setTyped(e.target.value) })),
          h('div', { className: 'omz-card__actions' }, h('button', { type: 'submit', className: 'omz-btn omz-btn--primary' }, 'Verify and approve'), h('button', { type: 'button', className: 'omz-btn', onClick: p.cancel }, 'Cancel')),
        )
      : h('div', { className: 'omz-card__actions' }, h('button', { type: 'button', className: 'omz-btn omz-btn--primary', onClick: () => void ask() }, 'Get a demo code'), h('button', { type: 'button', className: 'omz-btn', onClick: p.cancel }, 'Cancel')),
    error ? h('p', { className: 'omz-error', role: 'alert' }, error) : null,
  )
}

// A production build (esbuild sets NODE_ENV to production when it minifies)
// drops DemoCodeStepUp and its strings from /app.js.
const demoStepUp = (o: PageOptions) =>
  process.env.NODE_ENV !== 'production' ? (s: StepUpSlotProps): ReactNode => h(DemoCodeStepUp, { ...s, fetch: o.fetch ?? ((u, i) => fetch(u, i)), ...(o.person ? { person: o.person } : {}) }) : NoStepUp

export function NotesPage(o: PageOptions & { thread: string }): ReactNode {
  return h(
    UiProvider,
    {
      locale: o.locale ?? 'en',
      ...(o.fetch ? { fetch: o.fetch } : {}),
      ...(o.person ? { headers: { 'x-demo-person': o.person } } : {}),
    },
    h(
      'main',
      { className: 'omz notes-page' },
      h('h1', null, o.locale === 'bn' ? 'নোট কোপাইলট' : 'Notes copilot'),
      h(CopilotPanel, { thread: o.thread, screen: { name: 'notes' }, className: 'notes-chat' }),
      h(StandingGrants, {}),
      h(ApprovalsInbox, { stepUp: demoStepUp(o) }),
    ),
  )
}

function threadId(): string {
  try {
    const t = localStorage.getItem('copilot-thread')
    if (t && /^[A-Za-z0-9_-]{1,64}$/.test(t)) return t
    const n = `t${crypto.randomUUID().replace(/-/g, '').slice(0, 12)}`
    localStorage.setItem('copilot-thread', n)
    return n
  } catch {
    return `t${crypto.randomUUID().replace(/-/g, '').slice(0, 12)}`
  }
}

export function mount(root: Element, o: PageOptions = {}): Root {
  const r = createRoot(root)
  r.render(h(NotesPage, { ...o, thread: o.thread ?? threadId() }))
  return r
}

// In the browser, as /app.js.
const root = typeof document !== 'undefined' ? document.getElementById('root') : null
if (root) {
  const q = new URLSearchParams(location.search)
  const person = q.get('as')?.replace(/[^a-z0-9_]/g, '')
  const lang = q.get('lang') === 'bn' ? 'bn' : 'en'
  document.documentElement.lang = lang
  mount(root, { locale: lang, ...(person ? { person } : {}) })
}

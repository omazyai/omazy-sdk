// The page at /: the ui kit's copilot panel, standing grants and approvals
// inbox. Bundled to public/app.js by `npm run build:page`.
//
// The page signs in with a personal key (`npm run key`), kept for the tab in
// sessionStorage and sent as a bearer token. Put your own sign-in here when
// the product has one.

import { ApprovalsInbox, CodeStepUpForm, CopilotPanel, StandingGrants, UiProvider } from '@omazyai/sdk/ui/react'
import { createElement as h, type ReactNode, useState } from 'react'
import { createRoot } from 'react-dom/client'

const KEY = 'app-key'
const read = (k: string) => {
  try {
    return sessionStorage.getItem(k)
  } catch {
    return null
  }
}

function threadId(): string {
  const t = read('app-thread')
  if (t && /^[A-Za-z0-9_-]{1,64}$/.test(t)) return t
  const n = `t${crypto.randomUUID().replace(/-/g, '').slice(0, 12)}`
  try {
    sessionStorage.setItem('app-thread', n)
  } catch {}
  return n
}

function SignIn(p: { onKey: (key: string) => void }): ReactNode {
  const [value, setValue] = useState('')
  return h(
    'form',
    {
      className: 'app-key',
      onSubmit: (e: { preventDefault(): void }) => {
        e.preventDefault()
        if (value.trim()) p.onKey(value.trim())
      },
    },
    h('label', { htmlFor: 'key' }, 'Your personal key (npm run key)'),
    h('input', { id: 'key', type: 'password', autoComplete: 'off', value, onChange: (e: { target: { value: string } }) => setValue(e.target.value) }),
    h('button', { type: 'submit', className: 'omz-btn' }, 'Sign in'),
  )
}

function Page(): ReactNode {
  const [key, setKey] = useState(read(KEY))
  const [thread] = useState(threadId)
  if (!key)
    return h('main', { className: 'omz app-page' }, h('h1', null, '%%title%%'), h(SignIn, {
      onKey: (k) => {
        try {
          sessionStorage.setItem(KEY, k)
        } catch {}
        setKey(k)
      },
    }))
  return h(
    UiProvider,
    { headers: { authorization: `Bearer ${key}` } },
    h(
      'main',
      { className: 'omz app-page' },
      h('h1', null, '%%title%%'),
      h(CopilotPanel, { thread, screen: { name: 'notes' } }),
      h(StandingGrants, {}),
      // An approval that asks for a code: send it, type it, approve.
      h(ApprovalsInbox, { stepUp: (s) => h(CodeStepUpForm, s) }),
    ),
  )
}

const root = typeof document !== 'undefined' ? document.getElementById('root') : null
if (root) createRoot(root).render(h(Page))

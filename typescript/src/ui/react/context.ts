// Where the components find their text, their fetch and their routes.
// Without a provider they use English, the global fetch, `/copilot` and `/ui`.

import { createContext, createElement as h, type ReactNode, useContext, useMemo } from 'react'
import { type CopilotClient, copilotClient, type UiClient, uiClient } from '../clients.js'
import { type UiLocale, type UiText, type UiTextOverrides, uiText } from '../text.js'

export interface UiConfig {
  /** `en` or `bn`. Default `en`. */
  locale?: UiLocale | string
  /** Any words to change, in the chosen locale. */
  text?: UiTextOverrides
  fetch?: typeof fetch
  headers?: Record<string, string> | (() => Record<string, string>)
  /** Where `copilot.handle` is mounted. Default `/copilot`. */
  copilotBase?: string
  /** Where `uiRoutes` is mounted. Default `/ui`. Null when the product does not mount it: approval cards then show no live status. */
  uiBase?: string | null
}

export interface UiContextValue {
  text: UiText
  copilot: CopilotClient
  ui: UiClient | null
  fetch?: typeof fetch
  headers?: UiConfig['headers']
}

const Ctx = createContext<UiContextValue | null>(null)

function build(c: UiConfig): UiContextValue {
  const http = { ...(c.fetch ? { fetch: c.fetch } : {}), ...(c.headers ? { headers: c.headers } : {}) }
  return {
    text: uiText(c.locale ?? 'en', c.text ?? {}),
    copilot: copilotClient({ base: c.copilotBase ?? '/copilot', ...http }),
    ui: c.uiBase === null ? null : uiClient({ base: c.uiBase ?? '/ui', ...http }),
    ...http,
  }
}

let fallback: UiContextValue | null = null

export function UiProvider(props: UiConfig & { children?: ReactNode }): ReactNode {
  const { children, locale, text, fetch, headers, copilotBase, uiBase } = props
  const value = useMemo(() => build({ locale, text, fetch, headers, copilotBase, uiBase }), [locale, text, fetch, headers, copilotBase, uiBase])
  return h(Ctx.Provider, { value }, children)
}

export function useUi(): UiContextValue {
  return useContext(Ctx) ?? (fallback ??= build({}))
}

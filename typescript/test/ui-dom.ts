// A light DOM for the React tests: a happy-dom window put on the globals for
// one test file, React and react-dom loaded after it (react-dom checks for a
// DOM when it loads), and helpers that type, press keys and click inside
// `act`. `close()` puts the globals back.

import { Window } from 'happy-dom'

const NAMES = [
  'window',
  'document',
  'navigator',
  'Node',
  'Element',
  'HTMLElement',
  'HTMLIFrameElement',
  'HTMLInputElement',
  'HTMLTextAreaElement',
  'HTMLSelectElement',
  'Event',
  'KeyboardEvent',
  'MouseEvent',
  'FocusEvent',
  'getComputedStyle',
  'matchMedia',
  'requestAnimationFrame',
  'cancelAnimationFrame',
] as const

export async function openDom() {
  const win = new Window({ url: 'https://app.example/' })
  const g = globalThis as Record<string, unknown>
  const saved = new Map<string, PropertyDescriptor | undefined>()
  for (const n of NAMES) {
    saved.set(n, Object.getOwnPropertyDescriptor(g, n))
    const v = n === 'window' ? win : (win as unknown as Record<string, unknown>)[n]
    Object.defineProperty(g, n, { value: typeof v === 'function' && /^[a-z]/.test(n) ? (v as (...a: unknown[]) => unknown).bind(win) : v, configurable: true, writable: true })
  }
  g.IS_REACT_ACT_ENVIRONMENT = true
  const React = await import('react')
  const { createRoot } = await import('react-dom/client')
  const act = React.act
  const roots: { unmount(): void }[] = []

  const flush = async (rounds = 6) => {
    await act(async () => {
      for (let i = 0; i < rounds; i++) await new Promise((r) => setTimeout(r, 0))
    })
  }

  return {
    win,
    React,
    act,
    flush,
    async render(node: unknown): Promise<HTMLElement> {
      const host = document.createElement('div')
      document.body.appendChild(host)
      const root = createRoot(host)
      roots.push(root)
      await act(async () => root.render(node as never))
      await flush()
      return host
    },
    /** Types into a controlled input or textarea the way React notices. */
    async type(el: Element, value: string) {
      const proto = el.tagName === 'TEXTAREA' ? win.HTMLTextAreaElement.prototype : el.tagName === 'SELECT' ? win.HTMLSelectElement.prototype : win.HTMLInputElement.prototype
      await act(async () => {
        Object.getOwnPropertyDescriptor(proto, 'value')!.set!.call(el, value)
        el.dispatchEvent(new win.Event(el.tagName === 'SELECT' ? 'change' : 'input', { bubbles: true }) as unknown as Event)
      })
    },
    async key(el: Element, key: string, init: { shiftKey?: boolean } = {}) {
      await act(async () => {
        el.dispatchEvent(new win.KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ...init }) as unknown as Event)
      })
      await flush()
    },
    async click(el: Element | null | undefined) {
      if (!el) throw new Error('nothing to click')
      await act(async () => (el as HTMLElement).click())
      await flush()
    },
    async close() {
      for (const r of roots) await act(async () => r.unmount())
      await win.happyDOM.close()
      for (const [n, d] of saved) {
        if (d) Object.defineProperty(g, n, d)
        else delete g[n]
      }
      delete g.IS_REACT_ACT_ENVIRONMENT
    },
  }
}

/** The element with this exact text among `selector`, or undefined. */
export const byText = (root: ParentNode, selector: string, text: string | RegExp): HTMLElement | undefined =>
  [...root.querySelectorAll<HTMLElement>(selector)].find((e) => (typeof text === 'string' ? e.textContent?.trim() === text : text.test(e.textContent ?? '')))

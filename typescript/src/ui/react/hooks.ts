// React bindings for the core's stores.

import { useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react'
import { type ChatLike, type ChatMessage, type ChatState, createChat } from '../chat.js'
import { createResource, type ResourceState } from '../store.js'
import { useUi } from './context.js'

/** Any store with `subscribe` and `getSnapshot`: a chat, a resource. */
export function useStore<S>(store: { subscribe(l: () => void): () => void; getSnapshot(): S }): S {
  return useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot)
}

/** Loads once per `deps` (and every `pollMs` while mounted). */
export function useResource<T>(load: () => Promise<T>, deps: readonly unknown[], opts: { pollMs?: number } = {}) {
  const loadRef = useRef(load)
  loadRef.current = load
  // biome-ignore lint/correctness/useExhaustiveDependencies: the caller names the deps
  const r = useMemo(() => createResource<T>(() => loadRef.current(), opts.pollMs ? { pollMs: opts.pollMs } : {}), [...deps, opts.pollMs])
  const s: ResourceState<T> = useStore(r)
  return { ...s, refresh: r.refresh, set: r.set }
}

/** The current time, updated every `ms` (default 30 s), for expiry lines. */
export function useNow(ms = 30_000): number {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), ms)
    return () => clearInterval(t)
  }, [ms])
  return now
}

/** True when the person asked the system for less motion. */
export function useReducedMotion(): boolean {
  const q = '(prefers-reduced-motion: reduce)'
  const [reduced, setReduced] = useState(() => typeof matchMedia === 'function' && matchMedia(q).matches)
  useEffect(() => {
    if (typeof matchMedia !== 'function') return
    const m = matchMedia(q)
    const on = () => setReduced(m.matches)
    m.addEventListener?.('change', on)
    return () => m.removeEventListener?.('change', on)
  }, [])
  return reduced
}

/** Moves focus to an element after the render that asked for it. */
export function useFocusAfter<T extends HTMLElement>() {
  const ref = useRef<T | null>(null)
  const want = useRef(false)
  const [tick, setTick] = useState(0)
  useLayoutEffect(() => {
    if (want.current && ref.current) {
      want.current = false
      ref.current.focus()
    }
  }, [tick])
  return {
    ref,
    focus: () => {
      want.current = true
      setTick((n) => n + 1)
    },
  }
}

export interface CopilotChatOptions {
  thread: string
  /** Messages to start from. Without them the thread's history is loaded from the copilot. */
  messages?: ChatMessage[]
  /** Extra body fields on each send, such as the screen. */
  body?: () => Record<string, unknown>
  /** Set false to skip loading the history. */
  loadHistory?: boolean
}

/**
 * A chat on the copilot's routes, with the same fields `useChat` returns.
 * Loads the thread's history first unless `messages` are given.
 */
export function useCopilotChat(o: CopilotChatOptions): ChatLike & { loading: boolean; clearError(): void } {
  const { copilot, fetch, headers } = useUi()
  const bodyRef = useRef(o.body)
  bodyRef.current = o.body
  const store = useMemo(
    () =>
      createChat({
        api: copilot.chatUrl,
        id: o.thread,
        messages: o.messages ?? [],
        ...(fetch ? { fetch } : {}),
        ...(headers ? { headers } : {}),
        body: () => bodyRef.current?.() ?? {},
      }),
    // A new chat only for a new thread or route.
    [copilot, o.thread],
  )
  const s: ChatState = useStore(store)
  const wantHistory = o.loadHistory !== false && !o.messages
  const [loading, setLoading] = useState(wantHistory)
  useEffect(() => {
    if (!wantHistory) return
    let live = true
    setLoading(true)
    copilot
      .history(o.thread)
      .then((h) => {
        if (live && !store.getSnapshot().messages.length) store.setMessages(h.messages)
      })
      .catch(() => {
        // An empty thread is a fine start; the first send will show any real error.
      })
      .finally(() => live && setLoading(false))
    return () => {
      live = false
    }
  }, [store, copilot, o.thread, wantHistory])
  return { ...s, loading, sendMessage: store.sendMessage, setMessages: store.setMessages, stop: store.stop, clearError: store.clearError }
}

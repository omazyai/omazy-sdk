// What capabilities reach at run time. buildApp sets each part once per
// isolate; a capability asks for it when it runs, so the registry can be
// defined at module scope before the stores exist.

//#if actor
import type { ActorRuntime } from '@omazyai/sdk/actors'
//#endif
//#if flow
import type { Flows } from '@omazyai/sdk/flows'
//#endif
import type { NotesStore } from './notes'
//#if actor || flow
import type { AppCtx } from './types'
//#endif

interface Parts {
  notes?: NotesStore
//#if actor
  actors?: ActorRuntime<AppCtx>
//#endif
//#if flow
  flows?: Flows<AppCtx>
//#endif
}

const held: Parts = {}

function need<T>(part: T | undefined, name: string): T {
  if (part === undefined) throw new Error(`${name} is not set: build the app first (src/app.ts)`)
  return part
}

export const live = {
  set(parts: Parts): void {
    Object.assign(held, parts)
  },
  notes: () => need(held.notes, 'the notes store'),
//#if actor
  actors: () => need(held.actors, 'the actor runtime'),
//#endif
//#if flow
  flows: () => need(held.flows, 'the flows'),
//#endif
}

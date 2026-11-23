// Every store the kits use, in memory, in one call: for a product's unit tests.

import { memorySessionStore } from '../actors/stores.js'
import { memoryMemoryStore } from '../ai/memory.js'
import { memoryRunStore } from '../ai/runs.js'
import { memoryGuardStore, memoryRequestLog } from '../guard/memory.js'
import { memoryRateLimiter } from '../guard/ratelimit.js'
import { memorySwitches } from '../guard/switches.js'

/** Fresh in-memory stores for the guard, the AI kit and the actors kit. */
export function memoryAdapters() {
  return {
    guardStore: memoryGuardStore(),
    requestLog: memoryRequestLog(),
    switches: memorySwitches(),
    rateLimiter: memoryRateLimiter(),
    runs: memoryRunStore(),
    memory: memoryMemoryStore(),
    sessions: memorySessionStore(),
  }
}

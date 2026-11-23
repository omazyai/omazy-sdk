// The Worker's bindings, as wrangler.jsonc declares them.

//#if actor || copilot
import type { DurableObjectNamespaceLike } from '@omazyai/sdk/actors'
//#endif
//#if flow
import type { WorkflowBindingLike } from '@omazyai/sdk/flows'
//#endif
import type { D1DatabaseLike } from '@omazyai/sdk/guard'
import type { KvLike } from '@omazyai/sdk/oauth/keys'

export interface Env {
  DB: D1DatabaseLike
  /** Personal keys (and, with OAuth on, grants and tokens). */
  KV: KvLike
  /** 32 characters or more: keys the guard's confirm tokens and sealed approvals. */
  GUARD_SECRET: string
  /** "off" (production) keeps the MCP door off until a switch turns it on. */
  DOOR_DEFAULT?: string
//#if ai
  /** A Core API token for the model calls. */
  OMAZY_TOKEN?: string
  OMAZY_BASE_URL?: string
//#endif
//#if flow
  NOTE_FOLLOWUP: WorkflowBindingLike
//#endif
//#if copilot
  COPILOT_THREADS: DurableObjectNamespaceLike
  ASSETS: { fetch(req: Request): Promise<Response> }
//#endif
//#if oauth
  OAUTH?: string
  ISSUER?: string
  OAUTH_REFRESH: DurableObjectNamespace
  AUTHORIZE_LIMIT: { limit(o: { key: string }): Promise<{ success: boolean }> }
  TOKEN_LIMIT: { limit(o: { key: string }): Promise<{ success: boolean }> }
//#endif
}

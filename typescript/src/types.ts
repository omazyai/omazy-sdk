export interface Usage {
  input_tokens: number
  output_tokens: number
  cached_input_tokens: number
  /**
   * What the call cost in millionths of a US dollar, priced from the rate
   * card the cost ledger uses; 0 for a reply from the response cache. Set on
   * `ai.complete`.
   */
  cost_micros?: number
}

/**
 * Labels kept in the cost ledger on every model call the request makes, and
 * reported by `usage.get({ group_by })`. `unit`, `unit_version`,
 * `prompt_version` and `run_id` (at most 128 bytes each), plus up to 8 keys of
 * your own (lower case, at most 40 characters, values at most 200 bytes).
 */
export type Metadata = {
  unit?: string
  unit_version?: string
  prompt_version?: string
  run_id?: string
} & Record<string, string | number | boolean>

export interface ToolCall {
  id: string
  name: string
  input: unknown
}

export interface ToolResult {
  call_id: string
  content: string
  is_error?: boolean
}

/**
 * An image on a user message: a public https URL the provider fetches, or the
 * bytes as standard base64 (no `data:` prefix) with their media type. At most
 * 8 on a message, 16 on a call, 5 MB each.
 */
export type Image =
  | { url: string }
  | { data: string; media_type: 'image/png' | 'image/jpeg' | 'image/gif' | 'image/webp' }

export interface Message {
  role: 'user' | 'assistant'
  /** Can be empty on a turn that carries images, tool calls or tool results. */
  content: string
  tool_calls?: ToolCall[]
  tool_results?: ToolResult[]
  /** Images for the model to read, on a user turn. The model must have `vision`. */
  images?: Image[]
}

/**
 * Asks for a JSON reply. `json_schema` holds it to `schema`; with `strict`
 * every object must be closed and every property required.
 */
export type ResponseFormat =
  | { type: 'text' }
  | { type: 'json_object' }
  | { type: 'json_schema'; json_schema: { name?: string; schema: Record<string, unknown>; strict?: boolean } }

/** `auto`, `any`, `none`, or one named tool the model must call. */
export type ToolChoice = 'auto' | 'any' | 'none' | { type: 'tool'; name: string }

export interface ToolDefinition {
  name: string
  description?: string
  input_schema: Record<string, unknown>
}

export interface CompleteRequest {
  /** App handle. Needed only when the workspace has more than one app. */
  app?: string
  system?: string
  messages: Message[]
  tools?: ToolDefinition[]
  tool_choice?: ToolChoice
  /**
   * A JSON reply, held to a schema with `json_schema`. The result's `text` is
   * the JSON and `output` the parsed value. A model that cannot is a 422
   * `MODEL_UNSUPPORTED`; see `ai.models()`.
   */
  response_format?: ResponseFormat
  /** A model id with its provider, such as openai/gpt-4o-mini, or a role: `role:extract.fast`. */
  model?: string
  profile?: string
  /** Labels for the cost ledger. */
  metadata?: Metadata
  max_tokens?: number
  temperature?: number
  /**
   * The gateway's response cache for this call. Leave it out for the
   * gateway's own setting; 0 never answers from the cache (send it on any
   * request that carries live data); 60 to 2592000 bounds, in seconds, how
   * long a stored reply may be served again.
   */
  cache_ttl?: number
}

export interface CompleteResult {
  text: string
  tool_calls?: ToolCall[]
  stop_reason: string
  model: string
  usage: Usage
  /** True when the reply came from the gateway's response cache: no model call, no cost, no AI turn. */
  cache_hit?: boolean
  /** The reply as JSON, checked against the schema, when the request set `response_format`. */
  output?: unknown
  /** The model role the request named; `model` is then the model that answered. */
  role?: string
}

/** POST /ai/embeddings. */
export interface EmbedRequest {
  /** One text, or up to 128. Each at most 8000 bytes. */
  input: string | string[]
  /** Left out, the deployment's embedding model (`ai.models()`, kind `embedding`). */
  model?: string
  app?: string
  metadata?: Metadata
}

export interface Embedding {
  /** The input's place in the request. */
  index: number
  embedding: number[]
}

export interface EmbedResult {
  model: string
  dimensions: number
  /** One per input, in the order of the inputs. */
  embeddings: Embedding[]
  usage: { input_tokens: number; estimated?: boolean; cost_micros: number }
}

export interface ModelCapabilities {
  /** Reads `images` on a message. */
  vision: boolean
  /** Takes `response_format` with a JSON Schema. */
  json_schema: boolean
  /** The provider enforces the schema itself; otherwise a forced tool does, and `tools` cannot be combined with it. */
  json_schema_native: boolean
  tools: boolean
  context_tokens?: number
  /** On an embedding model, its vector length. */
  dimensions?: number
}

export interface ModelInfo {
  /** What `model` takes on a call. */
  id: string
  label?: string
  vendor?: string
  kind: 'chat' | 'embedding'
  tier?: 'standard' | 'premium'
  source?: 'managed' | 'byo'
  default?: boolean
  capabilities: ModelCapabilities
}

/**
 * A spend cap on the install: a USD limit per UTC day or month over every
 * call (no label) or the calls whose metadata carries one label value. `*`
 * caps each value on its own.
 */
export interface BudgetSetRequest {
  label?: '' | 'unit' | 'unit_version' | 'prompt_version' | 'run_id'
  value?: string
  period: 'day' | 'month'
  limit_usd: number
}

export interface Budget {
  id: string
  label: string
  value: string
  period: 'day' | 'month'
  limit_micros: number
  limit_usd: number
  /** This period's spend under the cap; 0 on a cap on each value (`*`). */
  spent_micros: number
  spent_usd: number
  resets_at: string
  updated_at?: string
}

/** A model role as it resolves for this install. */
export interface RoleView {
  name: string
  /** Left out when the role is set nowhere and runs on the default model. */
  model?: string
  fallbacks: string[]
  /** Where the mapping comes from. */
  level?: 'install' | 'workspace' | 'account' | 'platform'
  /** One of the roles Omazy publishes; a published role set nowhere runs on the default model. */
  published: boolean
  purpose?: string
}

/** GET /ai/roles. */
export interface RoleList {
  /** The model a role set nowhere runs on. */
  default: string
  roles: RoleView[]
}

/** PUT /ai/roles/{name}. */
export interface RoleSetRequest {
  model: string
  /** Up to three, tried in order. */
  fallbacks?: string[]
  /** `install` (the default): this product only. `workspace`: every install of the workspace. */
  level?: 'install' | 'workspace'
}

export interface RoleDeleted {
  name: string
  level: string
  deleted: true
}

/** GET /ai/models. */
export interface ModelList {
  /** The model a completion runs on when it names none. */
  default: string
  models: ModelInfo[]
}

/**
 * One event of a streamed reply. R is what `done` carries: a completion's
 * result from `ai.stream`, a whole agent turn from `agent.stream`.
 */
export type StreamEvent<R = CompleteResult> = { type: 'delta'; text: string } | { type: 'done'; result: R }

/** How indexing of a document stands. */
export interface KnowledgeIndex {
  status: 'queued' | 'indexing' | 'ready' | 'failed'
  /** Why the last pass failed. Indexing is tried again on its own. */
  error?: string
  indexed_at: string | null
  chunks: number
  tokens: number
}

export type DocumentKind = 'text' | 'faq' | 'structured' | 'pricing' | 'catalog'

/** One document of the agent's knowledge base. */
export interface KnowledgeDocument {
  id: string
  kind: DocumentKind
  title: string
  source_url: string | null
  language: string
  is_active: boolean
  /** Left out of a list. */
  content?: string
  data?: Json
  index: KnowledgeIndex
  /** The knowledge version of the document's last index. */
  version: number
  created_at: string
  updated_at: string
}

export interface DocumentInput {
  /** App handle. Needed only when the workspace has more than one app. */
  app?: string
  title: string
  content?: string
  /** `text` when left out. */
  kind?: DocumentKind
  source_url?: string
  /** Structured fields, for the structured, pricing and catalog kinds. */
  data?: Json
  language?: string
  is_active?: boolean
}

/** Fields left out are kept. */
export type DocumentPatch = Partial<DocumentInput>

export interface DocumentPage {
  documents: KnowledgeDocument[]
  /** Empty on the last page. */
  next_cursor: string
  /** The agent's knowledge version now. */
  version: number
}

export interface ExportedDocument {
  id: string
  kind: DocumentKind
  title: string
  source_url: string | null
  language: string
  /** False for a document that was switched off: drop it from your copy. */
  is_active: boolean
  version: number
  updated_at: string
  /** The passages search uses, in order. */
  chunks: { ordinal: number; text: string; tokens: number; checksum: string }[]
}

export interface KnowledgeExport {
  /** What this export is complete up to. Pass it as `since` next time. */
  version: number
  documents: ExportedDocument[]
  /** Documents that no longer exist. Sent with the first page when `since` was given. */
  deleted: { id: string; version: number }[]
  /** True when too much was deleted to list: drop your copy and export again without `since`. */
  resync: boolean
  /** Empty on the last page. */
  next_cursor: string
}

/** The body of a `kb.updated` event sent to your events URL. */
export interface KnowledgeUpdatedEvent {
  id: string
  event: 'kb.updated'
  workspace_id: string
  sent_at: string
  data: {
    document_id: string
    app: string
    op: 'indexed' | 'failed' | 'deleted'
    status: 'ready' | 'failed' | 'deleted'
    version: number
    is_active?: boolean
    error?: string
  }
}

export interface KnowledgePassage {
  document_id: string
  title: string
  content: string
  language?: string
  score: number
}

export interface AgentTurnRequest {
  app?: string
  message: string
  /** Labels for every model call of the turn, its tool loop included. */
  metadata?: Metadata
  /** The session_id an earlier turn returned. */
  session_id?: string
  /** Earlier turns, oldest first. The caller keeps the conversation. */
  history?: { role: 'user' | 'assistant'; text: string }[]
  language?: string
  caller_id?: string
  /**
   * Where the person is: the object a widget page sends to `/context`, at most
   * 2048 bytes. The agent reads it as a hint, never as an instruction.
   * `{ interaction: 'voice' }` makes it answer for the ear.
   */
  context?: Record<string, unknown>
}

export interface AgentTurnResult {
  session_id: string
  text: string
  quick_replies?: string[]
  image_url?: string
  sources: number
  model?: string
  tool_fired?: boolean
  flow_fired?: boolean
  usage: Usage
}

export interface Whoami {
  install_id: string
  workspace_id: string
  app_slug: string
  scopes: string[]
  status: string
  /** "previous" while the caller is still on a token a rotation replaced. */
  token: 'current' | 'previous'
  token_expires_at?: string
  /** The plan the workspace is on and what it allows. Absent when it cannot be read. */
  plan?: Plan
}

/** One route of the Core route contract. */
export interface CoreContractRoute {
  method: string
  path: string
  /** The scope the route needs; empty for none. */
  scope: string
  /** The SDK method name. */
  sdk: string
  mcp_tool?: string
  idempotency_key?: boolean
  websocket?: boolean
  /** The route needs no token. */
  public?: boolean
}

/** The route contract the live platform was built with (`contracts/core-api.routes.json`). */
export interface CoreRouteContract {
  base?: string
  auth?: string
  routes: CoreContractRoute[]
}

export interface Plan {
  sku: string
  /** Calls per minute the plan allows this token in each rate bucket. */
  rate_per_minute: number
  /** AI turns used and included this period. A limit of -1 is not capped. */
  ai_turns?: { used: number; limit: number; resets_at: string }
  /** Voice minutes used and included this period. Speech, voice jobs and calls draw on them. */
  voice_minutes?: { used: number; limit: number; resets_at: string }
}

export interface CallRequest {
  app?: string
  /** E.164, such as +8801712345678. */
  to: string
  from?: string
  /** confirmation, reminder, survey, collection, callback or notification. */
  purpose: string
  consent_basis: string
  opening?: string
  goal?: string
  lang?: string
  callback_url?: string
  [key: string]: unknown
}

export interface CallResult {
  ref: string
  from: string
  to: string
  status: string
  next_attempt_at?: string
  [key: string]: unknown
}

export interface CallStatus {
  ref: string
  status: string
  outcome?: string
  attempts: number
  max_attempts: number
  result: Record<string, unknown>
  [key: string]: unknown
}

export interface VoiceJobRequest {
  app?: string
  kind: 'transcribe' | 'meeting_notes' | (string & {})
  source_url?: string
  source_call_id?: string
  lang?: string[]
  diarize?: boolean
  template?: string
  callback_url?: string
}

export type Json = Record<string, unknown>

/** A content block of a message. `{ type: 'text', markdown }` is the simplest. */
export type Block = { type: string; [key: string]: unknown }

// ---- The agent's settings ---------------------------------------------------

/** The binding the agent answers on. */
export interface AgentModel {
  /** The model, in the form the gateway takes it, such as `openai/gpt-4o`. */
  id: string
  /** Where the binding comes from. `app` when the agent has its own. */
  source: 'app' | 'workspace' | 'platform'
  overridden: boolean
  /** What the agent would answer on without its own binding. Only when `overridden`. */
  inherited_model?: string
  /** The cap on one reply. Null leaves the platform's own cap. */
  max_tokens: number | null
  /** Null leaves the model's default. */
  temperature: number | null
}

/** A model the workspace may set, on its plan. */
export interface AgentModelOption {
  id: string
  label: string
  vendor: string
  tier: string
  /** True when the model can call tools. */
  tools: boolean
  /** `managed` for the platform's provider, `byo` for the workspace's own. */
  source: string
}

export interface AgentLoop {
  /** The turn runs on the shared agent loop. */
  harness: boolean
  /** The reply is sent as it is written. */
  stream: boolean
  /** Personal data is masked in the reply. */
  redact: boolean
  /** remember and forget tools: a person can ask the agent to keep something about them, or drop it. */
  memory: boolean
  /** A create_file tool: the agent hands over a Word, Markdown, text or CSV file as a download. */
  files: boolean
  /** The switches this agent set. A switch that is not here follows the platform's default. */
  overrides: { harness?: boolean; stream?: boolean; redact?: boolean; memory?: boolean; files?: boolean }
}

export interface AgentSettings {
  app_id: string
  app: string
  model: AgentModel
  /** The models this workspace may set, on its plan. */
  models: AgentModelOption[]
  plan_tier?: string
  loop: AgentLoop
}

/**
 * A change to the agent's settings. A field left out is left as it is. `null`
 * puts a field back to what the agent inherits.
 */
export interface AgentSettingsUpdate {
  app?: string
  /**
   * One of `models` in the settings. A new model is tested with one call
   * before it is saved. `null` removes the agent's own binding: the model,
   * `max_tokens` and `temperature` go back to what it inherits.
   */
  model?: string | null
  /** 16 to 32000. Setting it on an agent that inherits its model pins the agent to the model it runs on now. */
  max_tokens?: number | null
  /** 0 to 2. */
  temperature?: number | null
  loop?: { harness?: boolean | null; stream?: boolean | null; redact?: boolean | null; memory?: boolean | null; files?: boolean | null }
}

// ---- The agent's MCP servers -------------------------------------------------

export type McpAuthType = 'none' | 'bearer' | 'header' | 'session_bearer'
export type McpWriteMode = 'open' | 'read_only' | 'confirm' | 'trusted'
/**
 * Who proves whose token a conversation carries on a `session_bearer` server:
 * `whoami` (the server's own whoami tool) or `host` (your backend, for a
 * server without whoami such as Notion's).
 */
export type McpSubjectCheck = 'whoami' | 'host'

/** One MCP tool server the agent may call. The credential is never part of it. */
export interface McpServer {
  id: string
  /** Unique within the app, ignoring case. The agent's tools are named `mcp_<name>__<tool>`. */
  name: string
  endpoint_url: string
  auth_type: McpAuthType
  /** The tools the agent may use. Empty means every tool the server lists. */
  allowed_tools: string[]
  is_active: boolean
  /** What the agent may do with a tool that changes data. */
  write_mode: McpWriteMode
  action_policy: Json
  subject_check: McpSubjectCheck
  /** Whether a credential is stored. */
  has_credentials: boolean
  created_at: string
  updated_at: string
}

export interface McpServerInput {
  app?: string
  name: string
  /** https, on a public host. */
  endpoint_url: string
  auth_type: McpAuthType
  /**
   * The bearer token for `bearer`, or `Header-Name: value` for `header`.
   * Stored encrypted and never returned. Not allowed with `none` or
   * `session_bearer`.
   */
  credentials?: string
  allowed_tools?: string[]
  is_active?: boolean
  /** Defaults to `confirm`: the visitor agrees on a card before a tool that changes data runs. */
  write_mode?: McpWriteMode
  action_policy?: Json
  /** Defaults to `whoami`. `host` only with `session_bearer`. */
  subject_check?: McpSubjectCheck
}

/** A change to an MCP server. A field left out is left as it is. */
export interface McpServerUpdate {
  app?: string
  name?: string
  endpoint_url?: string
  auth_type?: McpAuthType
  /** Replaces the stored credential. An empty string removes it. */
  credentials?: string
  /** Replaces the list. `[]` allows every tool. */
  allowed_tools?: string[]
  is_active?: boolean
  write_mode?: McpWriteMode
  action_policy?: Json
  subject_check?: McpSubjectCheck
}

// ---- The Enterprise API: one workspace per customer ------------------------

/** A scope of an account key. */
export type AccountScope = 'workspaces:manage' | 'installs:manage' | 'usage:read'

export interface EnterpriseAccount {
  account: {
    id: string
    slug: string
    name: string
    status: 'active' | 'suspended' | 'closed'
    home_workspace_id: string | null
    /** A missing limit means the account sets no cap. */
    limits: { managed_workspaces?: number; seats_per_workspace?: number }
    /** How many workspaces the account manages now. Closed ones are not counted. */
    managed_workspaces: number
    created_at: string
  }
  /** The key this request was made with. */
  key: {
    id: string
    name: string
    token_prefix: string
    scopes: AccountScope[]
    state: 'active' | 'expired' | 'revoked'
    expires_at: string | null
    last_used_at: string | null
    created_at: string
  }
}

export type ManagedWorkspaceStatus = 'active' | 'suspended' | 'closed'

/** The workspace of one of your customers. */
export interface ManagedWorkspace {
  id: string
  /** Your own id for the customer, as you sent it when the workspace was created. */
  external_id: string
  handle: string
  name: string
  status: ManagedWorkspaceStatus
  brand_color: string | null
  logo_url: string | null
  /** The plan the workspace runs on, "" when it has none. */
  plan: string
  /** The workspace's agent app, the one its install token speaks for. */
  app: { id: string; handle: string } | null
  created_at: string
  updated_at: string
}

/** The install of a managed workspace. Its token is the Core API token for that customer. */
export interface ManagedInstall {
  id: string
  slug: string
  scopes: string[]
  token_prefix: string
  expires_at: string | null
  /** When the token a rotation replaced stops working. Null when none is live. */
  previous_token_expires_at: string | null
}

export interface CreateWorkspaceRequest {
  /**
   * Your own id for the customer: 1 to 128 letters, digits and `. _ : -`. The
   * same id always names the same workspace, so this call is safe to repeat.
   */
  external_id: string
  name: string
  /** 3 to 32 of a-z, 0-9 and hyphen. Left out, one is made from the name. */
  handle?: string
  /** `#RRGGBB`. */
  brand_color?: string
  logo_url?: string
}

export interface CreateWorkspaceResult {
  /** False when the customer's workspace already existed. */
  created: boolean
  workspace: ManagedWorkspace
  /** Null when the key may not manage installs: the workspace was made without one. */
  install: ManagedInstall | null
  /**
   * The install token, a Core API token for this customer. It is here once,
   * on the call that minted it. Store it then. If it is lost, rotate.
   */
  token: string | null
}

export interface ListWorkspacesQuery {
  status?: ManagedWorkspaceStatus
  /** Return only the workspace of this customer, if there is one. */
  external_id?: string
  /** 1 to 200. Default 50. */
  limit?: number
  cursor?: string
}

export interface WorkspacePage {
  workspaces: ManagedWorkspace[]
  /** Pass as `cursor` for the next page. Absent on the last page. */
  next_cursor?: string
}

export interface UpdateWorkspaceRequest {
  name?: string
  brand_color?: string
  logo_url?: string
  /** `active` on a closed workspace reopens it. Close with `workspaces.close`. */
  status?: 'active' | 'suspended'
}

export interface RotateInstallRequest {
  /** How long the replaced token keeps working. Default 24, at most 168. 0 cuts it off at once. */
  overlap_hours?: number
  /** Life of the new token in days. Left out keeps the install's policy. 0 removes the expiry. */
  expires_in_days?: number
}

export interface RotateInstallResult {
  install: ManagedInstall
  /** The new install token. Shown once. */
  token: string
}

/**
 * What was used and what it cost over a span. The cost fields come from the
 * platform's cost ledger, the last four from the plan's counters; the two are
 * never added together.
 */
export interface UsageTotals {
  /** Calls to a model: completions, each model round of an agent turn, knowledge search embeddings. */
  model_calls: number
  /** Model calls answered from the gateway's response cache. Free, and counted in model_calls. */
  cache_hits: number
  /** Calls, model or speech, that failed. */
  errors: number
  input_tokens: number
  output_tokens: number
  cached_input_tokens: number
  /** Speech to text and text to speech sessions: one per request or stream. */
  speech_sessions: number
  /** Seconds of audio heard or spoken. */
  speech_seconds: number
  /**
   * The base cost of the calls, in millionths of a US dollar: vendor_cost_micros
   * plus fee_micros. Omazy sets it. Calls on the workspace's own provider key are
   * not in it. Add your own margin to this; keep no copy of vendor prices.
   */
  cost_micros: number
  cost_usd: number
  /** The vendors' published price for the calls, from Omazy's rate cards. */
  vendor_cost_micros: number
  /** The Omazy service fee on top of the vendor price. Speech carries it; model calls carry none. */
  fee_micros: number
  /** The part of cost_micros priced from an estimate. */
  estimated_cost_micros: number
  /** Calls with no price at all, not in cost_micros. */
  unpriced_calls: number
  /** Conversations started, as the plan counts them. */
  conversations: number
  ai_turns: number
  api_calls: number
  /** Voice minutes as the plan counts them: rounded up per session, one-minute floor. */
  voice_minutes: number
}

/** One UTC day of usage. */
export interface UsageDay extends UsageTotals {
  date: string
}

/** One workspace's usage over a range of UTC days, empty days included. */
export interface UsageReport extends UsageGroups {
  workspace_id: string
  from: string
  to: string
  totals: UsageTotals
  days: UsageDay[]
}

/** A range of UTC days as YYYY-MM-DD, both ends included, at most 90 days. */
export interface UsageRange {
  from?: string
  to?: string
}

/**
 * Split the ledger by a label: `unit`, `unit_version`, `prompt_version`,
 * `run_id`, `model`, `model_role`, or `tag.<key>` for a key of your own.
 * `unit` and `run_id` narrow the groups.
 */
export interface UsageGrouping {
  group_by?: 'unit' | 'unit_version' | 'prompt_version' | 'run_id' | 'model' | 'model_role' | `tag.${string}`
  unit?: string
  run_id?: string
}

/** One value of the label and the ledger's numbers under it; '' is the calls without it. */
export interface UsageGroup {
  value: string
  model_calls: number
  cache_hits: number
  errors: number
  input_tokens: number
  output_tokens: number
  cached_input_tokens: number
  speech_sessions: number
  speech_seconds: number
  cost_micros: number
  cost_usd: number
  vendor_cost_micros: number
  fee_micros: number
  estimated_cost_micros: number
  unpriced_calls: number
}

/** With `group_by`: the costliest 100 values over the range. */
export interface UsageGroups {
  group_by?: string
  unit?: string
  run_id?: string
  groups?: UsageGroup[]
}

/** A range of days and a page of the account's workspaces. */
export interface AccountUsageQuery extends UsageRange, UsageGrouping {
  status?: 'active' | 'suspended' | 'closed'
  external_id?: string
  cursor?: string
  limit?: number
}

/** One managed workspace's usage. */
export interface WorkspaceUsage {
  workspace: { id: string; external_id: string; handle: string; name: string; status: string }
  totals: UsageTotals
  days: UsageDay[]
}

/** GET /enterprise/usage: a page of workspaces, and the account's totals over all of them. */
export interface AccountUsage extends UsageGroups {
  from: string
  to: string
  totals: UsageTotals
  workspaces: WorkspaceUsage[]
  /** Pass as `cursor` for the next page; absent on the last. */
  next_cursor?: string
}

/** Options for `voice.transcribeStream`. */
export interface TranscriptionStreamOptions {
  /** The language to expect first, `en` or `bn`; the other is still heard. */
  language?: string
  /** Names and words to expect, such as staff names. At most 200 of at most 100 bytes. */
  terms?: string[]
  /** `auto` (WebM/Opus, Ogg or WAV, the default), `pcm_s16le`, `mulaw` or `alaw`. */
  audioFormat?: 'auto' | 'pcm_s16le' | 'mulaw' | 'alaw'
  /** Required for raw audio: 8000 to 48000. */
  sampleRate?: number
  /** 1 or 2 for raw audio; default 1. */
  numChannels?: number
  app?: string
  /** Called with every frame from Omazy, in order. */
  onEvent?: (event: TranscriptionEvent) => void
}

/** One utterance, ended by a pause or by `commit()`. */
export interface TranscriptFinal {
  type: 'final'
  text: string
  language: string
  /** True on the final that answers `commit()`; its text may be empty. */
  committed?: boolean
}

/** The answer to `end()`: every final of the session joined. */
export interface TranscriptionDone {
  type: 'done'
  text: string
  language: string
  /** The audio length the session is billed by. */
  audio_ms: number
  request_id?: string
}

export type TranscriptionEvent =
  | { type: 'ready'; request_id?: string }
  | { type: 'partial'; text: string; language: string }
  | TranscriptFinal
  | TranscriptionDone
  | { type: 'error'; code: string; message: string; request_id?: string }

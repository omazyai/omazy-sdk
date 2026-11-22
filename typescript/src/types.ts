export interface Usage {
  input_tokens: number
  output_tokens: number
  cached_input_tokens: number
}

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

export interface Message {
  role: 'user' | 'assistant'
  content: string
  tool_calls?: ToolCall[]
  tool_results?: ToolResult[]
}

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
  tool_choice?: 'auto' | 'any' | 'none'
  /** A model id with its provider, such as openai/gpt-4o-mini. */
  model?: string
  profile?: string
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
  /** What the calls cost, in millionths of a US dollar. Calls on the workspace's own provider key are not in it. */
  cost_micros: number
  cost_usd: number
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
export interface UsageReport {
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

/** A range of days and a page of the account's workspaces. */
export interface AccountUsageQuery extends UsageRange {
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
export interface AccountUsage {
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

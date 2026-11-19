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
}

export interface CompleteResult {
  text: string
  tool_calls?: ToolCall[]
  stop_reason: string
  model: string
  usage: Usage
}

export type StreamEvent = { type: 'delta'; text: string } | { type: 'done'; result: CompleteResult }

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
  kind: 'transcribe' | 'notes' | (string & {})
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

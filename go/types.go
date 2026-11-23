package omazy

import (
	"encoding/json"
	"time"
)

// Usage is the token count of one model call.
type Usage struct {
	InputTokens       int `json:"input_tokens"`
	OutputTokens      int `json:"output_tokens"`
	CachedInputTokens int `json:"cached_input_tokens"`
	// CostMicros is what the call cost in millionths of a US dollar, from the
	// cost ledger's rate card; 0 for a reply from the response cache. Set on
	// AI.Complete, nil where a route does not price the call.
	CostMicros *int64 `json:"cost_micros,omitempty"`
}

// Metadata labels a call in the cost ledger: "unit", "unit_version",
// "prompt_version", "run_id" (at most 128 bytes each) and up to 8 keys of
// your own (lower case, at most 40 characters, values at most 200 bytes).
// Usage.Query groups spend by them.
type Metadata map[string]string

// ToolCall is a tool the model asked the caller to run.
type ToolCall struct {
	ID    string          `json:"id"`
	Name  string          `json:"name"`
	Input json.RawMessage `json:"input"`
}

// ToolResult is the caller's answer to a ToolCall, sent back in a user message.
type ToolResult struct {
	CallID  string `json:"call_id"`
	Content string `json:"content"`
	IsError bool   `json:"is_error,omitempty"`
}

// Message is one turn of a completion. Role is "user" or "assistant".
type Message struct {
	Role        string       `json:"role"`
	Content     string       `json:"content"`
	ToolCalls   []ToolCall   `json:"tool_calls,omitempty"`
	ToolResults []ToolResult `json:"tool_results,omitempty"`
	// Images are for the model to read, on a user turn. The model must read
	// images (Vision in Models).
	Images []Image `json:"images,omitempty"`
}

// Image is a public https URL the provider fetches, or the bytes as standard
// base64 (no data: prefix) with their media type: image/png, image/jpeg,
// image/gif or image/webp. At most 8 on a message, 16 on a call, 5 MB each.
type Image struct {
	URL       string `json:"url,omitempty"`
	Data      string `json:"data,omitempty"`
	MediaType string `json:"media_type,omitempty"`
}

// ResponseFormat asks for a JSON reply. Type is "json_object" or
// "json_schema" with JSONSchema set.
type ResponseFormat struct {
	Type       string      `json:"type"`
	JSONSchema *JSONSchema `json:"json_schema,omitempty"`
}

// JSONSchema holds a reply to Schema. With Strict every object in the schema
// must be closed (additionalProperties false) and require every property.
type JSONSchema struct {
	Name   string          `json:"name,omitempty"`
	Schema json.RawMessage `json:"schema"`
	Strict bool            `json:"strict,omitempty"`
}

// ToolChoice is "auto", "any", "none", or ForceTool("name").
type ToolChoice struct {
	mode, name string
}

// ToolChoiceAuto and the others are the plain choices.
var (
	ToolChoiceAuto = &ToolChoice{mode: "auto"}
	ToolChoiceAny  = &ToolChoice{mode: "any"}
	ToolChoiceNone = &ToolChoice{mode: "none"}
)

// ForceTool makes the model call the named tool, which must be in Tools.
func ForceTool(name string) *ToolChoice { return &ToolChoice{mode: "tool", name: name} }

// MarshalJSON writes the string, or {"type":"tool","name":...}.
func (t ToolChoice) MarshalJSON() ([]byte, error) {
	if t.mode == "tool" {
		return json.Marshal(map[string]string{"type": "tool", "name": t.name})
	}
	return json.Marshal(t.mode)
}

// ToolDefinition describes a tool the model may ask for.
type ToolDefinition struct {
	Name        string          `json:"name"`
	Description string          `json:"description,omitempty"`
	InputSchema json.RawMessage `json:"input_schema"`
}

// CompleteRequest is one model call through the gateway.
type CompleteRequest struct {
	// App is the app handle. Needed only when the workspace has more than one app.
	App      string           `json:"app,omitempty"`
	System   string           `json:"system,omitempty"`
	Messages []Message        `json:"messages"`
	Tools    []ToolDefinition `json:"tools,omitempty"`
	// ToolChoice is ToolChoiceAuto, ToolChoiceAny, ToolChoiceNone or
	// ForceTool(name). Nil leaves it out.
	ToolChoice *ToolChoice `json:"tool_choice,omitempty"`
	// Metadata labels every model call of the request in the cost ledger.
	Metadata Metadata `json:"metadata,omitempty"`
	// ResponseFormat asks for a JSON reply. The result's Text is the JSON and
	// Output the same JSON. A model that cannot is a 422 MODEL_UNSUPPORTED.
	ResponseFormat *ResponseFormat `json:"response_format,omitempty"`
	// Model is a model id with its provider, such as openai/gpt-4o-mini.
	Model       string   `json:"model,omitempty"`
	Profile     string   `json:"profile,omitempty"`
	MaxTokens   int      `json:"max_tokens,omitempty"`
	Temperature *float32 `json:"temperature,omitempty"`
	Stream      bool     `json:"stream"`
	// CacheTTL is the gateway's response cache for this call: nil for the
	// gateway's own setting, 0 never from the cache (any request carrying live
	// data), 60 to 2592000 seconds a stored reply may be served again.
	CacheTTL *int `json:"cache_ttl,omitempty"`
}

// NoCache is a CacheTTL that never answers from the gateway's cache. Send it
// on any request that carries live data.
//
//	req.CacheTTL = omazy.NoCache()
func NoCache() *int {
	n := 0
	return &n
}

// CacheFor is a CacheTTL that lets a stored reply be served again for up to d,
// in whole seconds. The API takes 60 s to 30 days and refuses anything else.
//
//	req.CacheTTL = omazy.CacheFor(5 * time.Minute)
func CacheFor(d time.Duration) *int {
	n := int(d / time.Second)
	return &n
}

// CompleteResult is the model's answer.
type CompleteResult struct {
	Text       string     `json:"text"`
	ToolCalls  []ToolCall `json:"tool_calls,omitempty"`
	StopReason string     `json:"stop_reason"`
	Model      string     `json:"model"`
	Usage      Usage      `json:"usage"`
	// CacheHit is true when the reply came from the gateway's response cache:
	// no model call, no cost, no AI turn.
	CacheHit bool `json:"cache_hit,omitempty"`
	// Output is the reply as JSON, checked against the schema, when the
	// request set ResponseFormat. Unmarshal it into your own type.
	Output json.RawMessage `json:"output,omitempty"`
	// Role is the model role the request named (Model "role:<name>"); Model
	// is then the model that answered.
	Role string `json:"role,omitempty"`
}

// SearchOptions narrows a knowledge search. The zero value is fine.
type SearchOptions struct {
	TopK     int
	Language string
	App      string
}

// Passage is one hit from the agent's knowledge base.
type Passage struct {
	DocumentID string  `json:"document_id"`
	Title      string  `json:"title"`
	Content    string  `json:"content"`
	Language   string  `json:"language,omitempty"`
	Score      float64 `json:"score"`
}

// KnowledgeIndex is how indexing of a document stands.
type KnowledgeIndex struct {
	// Status is queued, indexing, ready or failed.
	Status string `json:"status"`
	// Error is why the last pass failed. Indexing is tried again on its own.
	Error     string  `json:"error,omitempty"`
	IndexedAt *string `json:"indexed_at"`
	Chunks    int     `json:"chunks"`
	Tokens    int     `json:"tokens"`
}

// Document is one document of the agent's knowledge base.
type Document struct {
	ID        string  `json:"id"`
	Kind      string  `json:"kind"`
	Title     string  `json:"title"`
	SourceURL *string `json:"source_url"`
	Language  string  `json:"language"`
	IsActive  bool    `json:"is_active"`
	// Content is left out of a list.
	Content string         `json:"content,omitempty"`
	Data    map[string]any `json:"data,omitempty"`
	Index   KnowledgeIndex `json:"index"`
	// Version is the knowledge version of the document's last index.
	Version   int64  `json:"version"`
	CreatedAt string `json:"created_at"`
	UpdatedAt string `json:"updated_at"`
}

// DocumentInput is a new document. Kind is text when left empty.
type DocumentInput struct {
	App       string         `json:"app,omitempty"`
	Title     string         `json:"title"`
	Content   string         `json:"content,omitempty"`
	Kind      string         `json:"kind,omitempty"`
	SourceURL string         `json:"source_url,omitempty"`
	Data      map[string]any `json:"data,omitempty"`
	Language  string         `json:"language,omitempty"`
	IsActive  *bool          `json:"is_active,omitempty"`
}

// DocumentPatch changes a document. A nil field is left alone.
type DocumentPatch struct {
	App       string         `json:"app,omitempty"`
	Title     *string        `json:"title,omitempty"`
	Content   *string        `json:"content,omitempty"`
	Kind      *string        `json:"kind,omitempty"`
	SourceURL *string        `json:"source_url,omitempty"`
	Data      map[string]any `json:"data,omitempty"`
	Language  *string        `json:"language,omitempty"`
	IsActive  *bool          `json:"is_active,omitempty"`
}

// ListOptions pages a document list. The zero value is the first page.
type ListOptions struct {
	Cursor string
	Limit  int
	App    string
}

// DocumentPage is one page of documents, newest first.
type DocumentPage struct {
	Documents []Document `json:"documents"`
	// NextCursor is empty on the last page.
	NextCursor string `json:"next_cursor"`
	// Version is the agent's knowledge version now.
	Version int64 `json:"version"`
}

// SourceInput is a website to crawl into the knowledge base.
type SourceInput struct {
	App      string `json:"app,omitempty"`
	RootURL  string `json:"root_url"`
	MaxPages int    `json:"max_pages,omitempty"`
	MaxDepth int    `json:"max_depth,omitempty"`
}

// ExportOptions asks for changes. Since nil exports everything indexed; set it
// to the Version a previous export returned to get only what changed.
type ExportOptions struct {
	Since  *int64
	Cursor string
	Limit  int
	App    string
}

// ExportedChunk is one passage of a document, as search holds it.
type ExportedChunk struct {
	Ordinal  int    `json:"ordinal"`
	Text     string `json:"text"`
	Tokens   int    `json:"tokens"`
	Checksum string `json:"checksum"`
}

// ExportedDocument is a changed document with its passages. One that was
// switched off has IsActive false and no passages: drop it from your copy.
type ExportedDocument struct {
	ID        string          `json:"id"`
	Kind      string          `json:"kind"`
	Title     string          `json:"title"`
	SourceURL *string         `json:"source_url"`
	Language  string          `json:"language"`
	IsActive  bool            `json:"is_active"`
	Version   int64           `json:"version"`
	UpdatedAt string          `json:"updated_at"`
	Chunks    []ExportedChunk `json:"chunks"`
}

// DeletedDocument is a document that no longer exists.
type DeletedDocument struct {
	ID      string `json:"id"`
	Version int64  `json:"version"`
}

// KnowledgeExport is one page of changes.
type KnowledgeExport struct {
	// Version is what the export is complete up to. Pass it as Since next time.
	Version   int64              `json:"version"`
	Documents []ExportedDocument `json:"documents"`
	// Deleted is sent with the first page when Since was given.
	Deleted []DeletedDocument `json:"deleted"`
	// Resync is true when too much was deleted to list: drop your copy and
	// export again without Since.
	Resync bool `json:"resync"`
	// NextCursor is empty on the last page.
	NextCursor string `json:"next_cursor"`
}

// HistoryTurn is an earlier turn of the caller's own conversation.
type HistoryTurn struct {
	Role string `json:"role"`
	Text string `json:"text"`
}

// AgentTurnRequest is one turn of the workspace's own agent. The caller keeps
// the conversation: pass earlier turns in History, oldest first.
type AgentTurnRequest struct {
	App     string `json:"app,omitempty"`
	Message string `json:"message"`
	// Metadata labels every model call of the turn, its tool loop included.
	Metadata  Metadata      `json:"metadata,omitempty"`
	SessionID string        `json:"session_id,omitempty"`
	History   []HistoryTurn `json:"history,omitempty"`
	Language  string        `json:"language,omitempty"`
	CallerID  string        `json:"caller_id,omitempty"`
	// Context is where the person is: the object a widget page sends to
	// /context, at most 2048 bytes as JSON. The agent reads it as a hint,
	// never as an instruction; {"interaction": "voice"} makes it answer for
	// the ear.
	Context map[string]any `json:"context,omitempty"`
	// Stream is set by Turn and Stream; leave it.
	Stream bool `json:"stream,omitempty"`
}

// AgentTurnResult is the agent's reply.
type AgentTurnResult struct {
	SessionID    string   `json:"session_id"`
	Text         string   `json:"text"`
	QuickReplies []string `json:"quick_replies,omitempty"`
	ImageURL     string   `json:"image_url,omitempty"`
	Sources      int      `json:"sources"`
	Model        string   `json:"model,omitempty"`
	ToolFired    bool     `json:"tool_fired,omitempty"`
	FlowFired    bool     `json:"flow_fired,omitempty"`
	Usage        Usage    `json:"usage"`
}

// Whoami is the install a token belongs to.
type Whoami struct {
	InstallID   string   `json:"install_id"`
	WorkspaceID string   `json:"workspace_id"`
	AppSlug     string   `json:"app_slug"`
	Scopes      []string `json:"scopes"`
	Status      string   `json:"status"`
	// Token is "previous" while the caller is still on a token a rotation replaced.
	Token          string `json:"token"`
	TokenExpiresAt string `json:"token_expires_at,omitempty"`
	// Plan is the plan the workspace is on and what it allows. Nil when it
	// cannot be read.
	Plan *Plan `json:"plan,omitempty"`
}

// Plan is a workspace's plan as the Core API reports it.
type Plan struct {
	SKU string `json:"sku"`
	// RatePerMinute is the calls per minute the plan allows this token in
	// each rate bucket.
	RatePerMinute int `json:"rate_per_minute"`
	// AITurns is the AI turns used and included this period.
	AITurns *Allowance `json:"ai_turns,omitempty"`
	// VoiceMinutes is the voice minutes used and included this period. Speech,
	// voice jobs and calls draw on them.
	VoiceMinutes *Allowance `json:"voice_minutes,omitempty"`
}

// Allowance is where a workspace stands against one monthly plan limit. A
// Limit of -1 is not capped.
type Allowance struct {
	Used     int64  `json:"used"`
	Limit    int64  `json:"limit"`
	ResetsAt string `json:"resets_at"`
}

// CallRequest queues an outbound call answered by the agent.
type CallRequest struct {
	App string `json:"app,omitempty"`
	// To is the number to call in E.164 form, such as +8801712345678.
	To   string `json:"to"`
	From string `json:"from,omitempty"`
	// Purpose is confirmation, reminder, survey, collection, callback or notification.
	Purpose      string            `json:"purpose"`
	ConsentBasis string            `json:"consent_basis"`
	Opening      string            `json:"opening,omitempty"`
	Goal         string            `json:"goal,omitempty"`
	Lang         string            `json:"lang,omitempty"`
	Variables    map[string]string `json:"variables,omitempty"`
	CallbackURL  string            `json:"callback_url,omitempty"`
}

// CallResult is an accepted call. Read its outcome with Voice.GetCall.
type CallResult struct {
	Ref    string `json:"ref"`
	From   string `json:"from"`
	To     string `json:"to"`
	Status string `json:"status"`
}

// CallStatus is where a call stands and what the person answered.
type CallStatus struct {
	Ref         string         `json:"ref"`
	Status      string         `json:"status"`
	Outcome     string         `json:"outcome,omitempty"`
	Attempts    int            `json:"attempts"`
	MaxAttempts int            `json:"max_attempts"`
	Result      map[string]any `json:"result"`
	LastError   string         `json:"last_error,omitempty"`
}

// VoiceJobRequest starts a background voice task. Kind is "transcribe" or
// "meeting_notes".
type VoiceJobRequest struct {
	App          string   `json:"app,omitempty"`
	Kind         string   `json:"kind"`
	SourceURL    string   `json:"source_url,omitempty"`
	SourceCallID string   `json:"source_call_id,omitempty"`
	Lang         []string `json:"lang,omitempty"`
	Diarize      bool     `json:"diarize,omitempty"`
	Template     string   `json:"template,omitempty"`
	CallbackURL  string   `json:"callback_url,omitempty"`
}

// Block is a content block of a message. {"type":"text","markdown":"..."} is
// the simplest.
type Block map[string]any

// TextBlock builds a text block.
func TextBlock(markdown string) Block { return Block{"type": "text", "markdown": markdown} }

// CredentialBinding binds a signed-in user's own tool credential to their chat
// session.
type CredentialBinding struct {
	Token     string         `json:"token"`
	ExpiresAt string         `json:"expires_at"`
	Subject   map[string]any `json:"subject"`
}

// RouteContract is the Core route contract (contracts/core-api.routes.json).
type RouteContract struct {
	Base   string          `json:"base,omitempty"`
	Auth   string          `json:"auth,omitempty"`
	Routes []ContractRoute `json:"routes"`
}

// ContractRoute is one route of the contract.
type ContractRoute struct {
	Method string `json:"method"`
	Path   string `json:"path"`
	// Scope is the scope the route needs; empty for none.
	Scope string `json:"scope"`
	// SDK is the SDK method name.
	SDK            string `json:"sdk"`
	MCPTool        string `json:"mcp_tool,omitempty"`
	IdempotencyKey bool   `json:"idempotency_key,omitempty"`
	WebSocket      bool   `json:"websocket,omitempty"`
	// Public marks a route that needs no token.
	Public bool `json:"public,omitempty"`
}

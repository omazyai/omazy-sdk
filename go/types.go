package omazy

import "encoding/json"

// Usage is the token count of one model call.
type Usage struct {
	InputTokens       int `json:"input_tokens"`
	OutputTokens      int `json:"output_tokens"`
	CachedInputTokens int `json:"cached_input_tokens"`
}

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
	// ToolChoice is "auto", "any" or "none".
	ToolChoice string `json:"tool_choice,omitempty"`
	// Model is a model id with its provider, such as openai/gpt-4o-mini.
	Model       string   `json:"model,omitempty"`
	Profile     string   `json:"profile,omitempty"`
	MaxTokens   int      `json:"max_tokens,omitempty"`
	Temperature *float32 `json:"temperature,omitempty"`
	Stream      bool     `json:"stream"`
}

// CompleteResult is the model's answer.
type CompleteResult struct {
	Text       string     `json:"text"`
	ToolCalls  []ToolCall `json:"tool_calls,omitempty"`
	StopReason string     `json:"stop_reason"`
	Model      string     `json:"model"`
	Usage      Usage      `json:"usage"`
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

// HistoryTurn is an earlier turn of the caller's own conversation.
type HistoryTurn struct {
	Role string `json:"role"`
	Text string `json:"text"`
}

// AgentTurnRequest is one turn of the workspace's own agent. The caller keeps
// the conversation: pass earlier turns in History, oldest first.
type AgentTurnRequest struct {
	App       string        `json:"app,omitempty"`
	Message   string        `json:"message"`
	SessionID string        `json:"session_id,omitempty"`
	History   []HistoryTurn `json:"history,omitempty"`
	Language  string        `json:"language,omitempty"`
	CallerID  string        `json:"caller_id,omitempty"`
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

// VoiceJobRequest starts a background voice task. Kind is "transcribe" or "notes".
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

package omazy

import "encoding/json"

// Nullable is a field of a change that is either a value or null. A change
// holds pointers to it: a nil pointer leaves the field out of the request.
type Nullable[T any] struct {
	Value T
	// Null sends null, which puts the setting back to what the agent
	// inherits.
	Null bool
}

// MarshalJSON writes the value, or null.
func (n Nullable[T]) MarshalJSON() ([]byte, error) {
	if n.Null {
		return []byte("null"), nil
	}
	return json.Marshal(n.Value)
}

// Set is a field of a change with a value.
func Set[T any](v T) *Nullable[T] { return &Nullable[T]{Value: v} }

// Clear is a field of a change that goes back to what the agent inherits.
func Clear[T any]() *Nullable[T] { return &Nullable[T]{Null: true} }

// AgentModel is the binding the agent answers on.
type AgentModel struct {
	// ID is the model, in the form the gateway takes it, such as
	// openai/gpt-4o.
	ID string `json:"id"`
	// Source says where the binding comes from: "app" when the agent has its
	// own, "workspace" or "platform" when it inherits one.
	Source     string `json:"source"`
	Overridden bool   `json:"overridden"`
	// InheritedModel is what the agent would answer on without its own
	// binding. Set only when Overridden.
	InheritedModel string `json:"inherited_model"`
	// MaxTokens caps one reply. Nil leaves the platform's own cap.
	MaxTokens *int `json:"max_tokens"`
	// Temperature of the model. Nil leaves the model's default.
	Temperature *float64 `json:"temperature"`
}

// AgentModelOption is a model the workspace may set, on its plan.
type AgentModelOption struct {
	ID     string `json:"id"`
	Label  string `json:"label"`
	Vendor string `json:"vendor"`
	Tier   string `json:"tier"`
	// Tools is true when the model can call tools.
	Tools bool `json:"tools"`
	// Source is "managed" for the platform's provider, "byo" for the
	// workspace's own.
	Source string `json:"source"`
}

// AgentLoop is what a turn of the agent does, and which of those the agent
// set for itself.
type AgentLoop struct {
	// Harness runs the turn on the shared agent loop.
	Harness bool `json:"harness"`
	// Stream sends the reply as it is written.
	Stream bool `json:"stream"`
	// Redact masks personal data in the reply.
	Redact bool `json:"redact"`
	// Memory gives the agent remember and forget tools: a person can ask it
	// to keep something about them, or drop it.
	Memory bool `json:"memory"`
	// Files gives the agent a create_file tool: it hands over a Word,
	// Markdown, text or CSV file as a download.
	Files bool `json:"files"`
	// Overrides holds the switches this agent set. A nil switch follows the
	// platform's default.
	Overrides struct {
		Harness *bool `json:"harness"`
		Stream  *bool `json:"stream"`
		Redact  *bool `json:"redact"`
		Memory  *bool `json:"memory"`
		Files   *bool `json:"files"`
	} `json:"overrides"`
}

// AgentSettings is how the agent runs.
type AgentSettings struct {
	AppID string     `json:"app_id"`
	App   string     `json:"app"`
	Model AgentModel `json:"model"`
	// Models are the ones this workspace may set, on its plan.
	Models   []AgentModelOption `json:"models"`
	PlanTier string             `json:"plan_tier"`
	Loop     AgentLoop          `json:"loop"`
}

// AgentLoopUpdate changes the loop switches. A nil switch is left as it is;
// Clear puts one back to the platform's default.
type AgentLoopUpdate struct {
	Harness *Nullable[bool] `json:"harness,omitempty"`
	Stream  *Nullable[bool] `json:"stream,omitempty"`
	Redact  *Nullable[bool] `json:"redact,omitempty"`
	Memory  *Nullable[bool] `json:"memory,omitempty"`
	Files   *Nullable[bool] `json:"files,omitempty"`
}

// AgentSettingsUpdate is a change to the agent's settings. A nil field is
// left as it is.
//
//	omazy.AgentSettingsUpdate{Model: omazy.Set("openai/gpt-4o"), MaxTokens: omazy.Set(1200)}
//	omazy.AgentSettingsUpdate{Model: omazy.Clear[string]()} // back to the inherited model
type AgentSettingsUpdate struct {
	App string `json:"app,omitempty"`
	// Model is one of Models in the settings. A new model is tested with one
	// call before it is saved. Clear removes the agent's own binding: the
	// model, MaxTokens and Temperature go back to what it inherits.
	Model *Nullable[string] `json:"model,omitempty"`
	// MaxTokens is 16 to 32000. Setting it on an agent that inherits its
	// model pins the agent to the model it runs on now.
	MaxTokens *Nullable[int] `json:"max_tokens,omitempty"`
	// Temperature is 0 to 2.
	Temperature *Nullable[float64] `json:"temperature,omitempty"`
	Loop        *AgentLoopUpdate   `json:"loop,omitempty"`
}

// MCPServer is one MCP tool server the agent may call. The credential is never
// part of it: HasCredentials says whether one is stored.
type MCPServer struct {
	ID string `json:"id"`
	// Name is unique within the app, ignoring case. The agent's tools are
	// named mcp_<name>__<tool>.
	Name        string `json:"name"`
	EndpointURL string `json:"endpoint_url"`
	// AuthType is none, bearer, header or session_bearer.
	AuthType string `json:"auth_type"`
	// AllowedTools are the tools the agent may use. Empty means every tool
	// the server lists.
	AllowedTools []string `json:"allowed_tools"`
	IsActive     bool     `json:"is_active"`
	// WriteMode is what the agent may do with a tool that changes data: open,
	// read_only, confirm or trusted.
	WriteMode    string          `json:"write_mode"`
	ActionPolicy json.RawMessage `json:"action_policy"`
	// SubjectCheck says who proves whose token a conversation carries on a
	// session_bearer server: whoami (the server's own whoami tool) or host
	// (your backend, for a server without whoami such as Notion's).
	SubjectCheck   string `json:"subject_check"`
	HasCredentials bool   `json:"has_credentials"`
	CreatedAt      string `json:"created_at"`
	UpdatedAt      string `json:"updated_at"`
}

// MCPServerInput connects a server.
type MCPServerInput struct {
	App  string `json:"app,omitempty"`
	Name string `json:"name"`
	// EndpointURL is https, on a public host.
	EndpointURL string `json:"endpoint_url"`
	AuthType    string `json:"auth_type"`
	// Credentials is the bearer token for bearer, or "Header-Name: value" for
	// header. Stored encrypted and never returned. Not allowed with none or
	// session_bearer.
	Credentials  string   `json:"credentials,omitempty"`
	AllowedTools []string `json:"allowed_tools,omitempty"`
	IsActive     *bool    `json:"is_active,omitempty"`
	// WriteMode defaults to confirm: the visitor agrees on a card before a
	// tool that changes data runs.
	WriteMode    string          `json:"write_mode,omitempty"`
	ActionPolicy json.RawMessage `json:"action_policy,omitempty"`
	// SubjectCheck defaults to whoami. host only with session_bearer.
	SubjectCheck string `json:"subject_check,omitempty"`
}

// MCPServerUpdate changes a server. A nil field is left as it is.
type MCPServerUpdate struct {
	App         string  `json:"app,omitempty"`
	Name        *string `json:"name,omitempty"`
	EndpointURL *string `json:"endpoint_url,omitempty"`
	AuthType    *string `json:"auth_type,omitempty"`
	// Credentials replaces the stored credential. A pointer to "" removes it.
	Credentials *string `json:"credentials,omitempty"`
	// AllowedTools replaces the list. A pointer to an empty slice allows
	// every tool.
	AllowedTools *[]string       `json:"allowed_tools,omitempty"`
	IsActive     *bool           `json:"is_active,omitempty"`
	WriteMode    *string         `json:"write_mode,omitempty"`
	ActionPolicy json.RawMessage `json:"action_policy,omitempty"`
	SubjectCheck *string         `json:"subject_check,omitempty"`
}

package omazy

import "context"

// EmbedRequest is POST /ai/embeddings: one text or up to 128, each at most
// 8000 bytes.
type EmbedRequest struct {
	Input []string `json:"input"`
	// Model left empty is the deployment's embedding model, the one Models
	// lists with Kind "embedding".
	Model    string   `json:"model,omitempty"`
	App      string   `json:"app,omitempty"`
	Metadata Metadata `json:"metadata,omitempty"`
}

// Embedding is one input's vector. Index is its place in the request.
type Embedding struct {
	Index     int       `json:"index"`
	Embedding []float32 `json:"embedding"`
}

// EmbedResult holds one vector per input, in the order of the inputs.
type EmbedResult struct {
	Model      string      `json:"model"`
	Dimensions int         `json:"dimensions"`
	Embeddings []Embedding `json:"embeddings"`
	Usage      struct {
		InputTokens int   `json:"input_tokens"`
		Estimated   bool  `json:"estimated,omitempty"`
		CostMicros  int64 `json:"cost_micros"`
	} `json:"usage"`
}

// ModelCapabilities says what a model can be asked for.
type ModelCapabilities struct {
	Vision     bool `json:"vision"`
	JSONSchema bool `json:"json_schema"`
	// JSONSchemaNative: the provider enforces the schema itself. Otherwise a
	// forced tool call does, and ResponseFormat cannot be combined with Tools.
	JSONSchemaNative bool `json:"json_schema_native"`
	Tools            bool `json:"tools"`
	ContextTokens    int  `json:"context_tokens,omitempty"`
	// Dimensions is an embedding model's vector length.
	Dimensions int `json:"dimensions,omitempty"`
}

// ModelInfo is one model the install may name.
type ModelInfo struct {
	ID           string            `json:"id"`
	Label        string            `json:"label,omitempty"`
	Vendor       string            `json:"vendor,omitempty"`
	Kind         string            `json:"kind"` // chat or embedding
	Tier         string            `json:"tier,omitempty"`
	Source       string            `json:"source,omitempty"`
	Default      bool              `json:"default,omitempty"`
	Capabilities ModelCapabilities `json:"capabilities"`
}

// ModelList is GET /ai/models. Default is the model a completion runs on
// when it names none.
type ModelList struct {
	Default string      `json:"default"`
	Models  []ModelInfo `json:"models"`
}

// Embed returns vectors for the inputs with the deployment's embedding
// model. Needs ai:complete.
func (s *AIService) Embed(ctx context.Context, req EmbedRequest) (*EmbedResult, error) {
	req.App = s.c.appOr(req.App)
	var out EmbedResult
	return &out, s.c.json(ctx, "ai.embed", call{body: req}, &out)
}

// Models lists the models this install may name and what each can do. app
// may be empty. Needs ai:complete.
func (s *AIService) Models(ctx context.Context, app string) (*ModelList, error) {
	var out ModelList
	return &out, s.c.json(ctx, "ai.models", call{query: map[string]string{"app": s.c.appOr(app)}}, &out)
}

// RoleView is a model role as it resolves for this install. Model is empty
// when the role is set nowhere and runs on the default model.
type RoleView struct {
	Name      string   `json:"name"`
	Model     string   `json:"model,omitempty"`
	Fallbacks []string `json:"fallbacks"`
	// Level is where the mapping comes from: install, workspace, account or
	// platform.
	Level     string `json:"level,omitempty"`
	Published bool   `json:"published"`
	Purpose   string `json:"purpose,omitempty"`
}

// RoleList is GET /ai/roles.
type RoleList struct {
	Default string     `json:"default"`
	Roles   []RoleView `json:"roles"`
}

// RoleSet maps a role. Level is "install" (the default) or "workspace".
type RoleSet struct {
	Model     string   `json:"model"`
	Fallbacks []string `json:"fallbacks,omitempty"`
	Level     string   `json:"level,omitempty"`
}

// Roles lists every model role this install can name and what it runs on.
// A call names one with Model "role:<name>". Needs ai:complete.
func (s *AIService) Roles(ctx context.Context, app string) (*RoleList, error) {
	var out RoleList
	return &out, s.c.json(ctx, "ai.roles.list", call{query: map[string]string{"app": s.c.appOr(app)}}, &out)
}

// SetRole maps a role to a model and up to three fallbacks, all on the
// workspace's plan. Needs ai:configure.
func (s *AIService) SetRole(ctx context.Context, name string, req RoleSet) (*RoleView, error) {
	var out RoleView
	return &out, s.c.json(ctx, "ai.roles.set", call{path: map[string]string{"name": name}, body: req}, &out)
}

// DeleteRole removes the install's ("install" or "") or the workspace's
// mapping of a role. Needs ai:configure.
func (s *AIService) DeleteRole(ctx context.Context, name, level string) error {
	return s.c.json(ctx, "ai.roles.delete", call{path: map[string]string{"name": name}, query: map[string]string{"level": level}}, nil)
}

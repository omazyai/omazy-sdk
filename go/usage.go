package omazy

import "context"

// UsageTotals is what was used and what it cost over a span. The cost fields
// come from the platform's cost ledger, the last four from the plan's
// counters; the two are never added together.
type UsageTotals struct {
	// ModelCalls are calls to a model: completions, each model round of an
	// agent turn, knowledge search embeddings. Speech is counted apart.
	ModelCalls uint64 `json:"model_calls"`
	// CacheHits are model calls answered from the gateway's response cache.
	// They cost nothing and are counted in ModelCalls.
	CacheHits         uint64 `json:"cache_hits"`
	Errors            uint64 `json:"errors"`
	InputTokens       uint64 `json:"input_tokens"`
	OutputTokens      uint64 `json:"output_tokens"`
	CachedInputTokens uint64 `json:"cached_input_tokens"`
	// SpeechSessions and SpeechSeconds are speech to text and text to speech.
	SpeechSessions uint64  `json:"speech_sessions"`
	SpeechSeconds  float64 `json:"speech_seconds"`
	// CostMicros is what the calls cost, in millionths of a US dollar. Calls
	// on the workspace's own provider key are not in it.
	CostMicros uint64  `json:"cost_micros"`
	CostUSD    float64 `json:"cost_usd"`
	// EstimatedCostMicros is the part of CostMicros priced from an estimate.
	EstimatedCostMicros uint64 `json:"estimated_cost_micros"`
	// UnpricedCalls had no price and are not in CostMicros.
	UnpricedCalls uint64 `json:"unpriced_calls"`
	// The plan's counters, as the plan counts them.
	Conversations int64 `json:"conversations"`
	AITurns       int64 `json:"ai_turns"`
	APICalls      int64 `json:"api_calls"`
	VoiceMinutes  int64 `json:"voice_minutes"`
}

// UsageDay is one UTC day of usage.
type UsageDay struct {
	Date string `json:"date"`
	UsageTotals
}

// UsageReport is one workspace's usage over a range of UTC days, every day of
// it included.
type UsageReport struct {
	WorkspaceID string      `json:"workspace_id"`
	From        string      `json:"from"`
	To          string      `json:"to"`
	Totals      UsageTotals `json:"totals"`
	Days        []UsageDay  `json:"days"`
	// GroupBy, Unit, RunID and Groups are set when the query named GroupBy.
	GroupBy string       `json:"group_by,omitempty"`
	Unit    string       `json:"unit,omitempty"`
	RunID   string       `json:"run_id,omitempty"`
	Groups  []UsageGroup `json:"groups,omitempty"`
}

// UsageService reads what the workspace used and what it cost.
type UsageService struct{ c *Client }

// Get returns the workspace's usage per UTC day from one YYYY-MM-DD to
// another, both included. Empty from and to give the last 30 days; a range
// covers at most 90. Needs usage:read.
// UsageQuery is a range and, optionally, a label to split the ledger by:
// GroupBy is "unit", "unit_version", "prompt_version", "run_id", "model",
// "model_role" or "tag.<key>"; Unit and RunID narrow the groups.
type UsageQuery struct {
	From, To    string
	GroupBy     string
	Unit, RunID string
}

// UsageGroup is one value of the label and the ledger's numbers under it.
// An empty Value holds the calls that carried no such label. The plan's
// counters carry no labels and are zero here.
type UsageGroup struct {
	Value string `json:"value"`
	UsageTotals
}

// Query is Get with a label to split by. The report's Groups are the
// costliest 100 values over the range. Needs usage:read.
func (s *UsageService) Query(ctx context.Context, q UsageQuery) (*UsageReport, error) {
	var out UsageReport
	return &out, s.c.json(ctx, "usage.get", call{query: map[string]string{
		"from": q.From, "to": q.To, "group_by": q.GroupBy, "unit": q.Unit, "run_id": q.RunID,
	}}, &out)
}

func (s *UsageService) Get(ctx context.Context, from, to string) (*UsageReport, error) {
	var out UsageReport
	return &out, s.c.json(ctx, "usage.get", call{query: map[string]string{"from": from, "to": to}}, &out)
}

package omazy

import (
	"encoding/json"
	"testing"
)

// response_format, a forced tool and images go out in the shape the API
// reads, and output comes back as JSON the caller unmarshals.
func TestStructuredOutputImagesAndForcedTool(t *testing.T) {
	f, c := newFake(t, ok(`{"text":"{\"title\":\"Hi\"}","stop_reason":"stop","model":"openai/gpt-4o-mini","usage":{},"output":{"title":"Hi"}}`))
	res, err := c.AI.Complete(ctx, CompleteRequest{
		Messages:   []Message{{Role: "user", Content: "read it", Images: []Image{{URL: "https://a.b/slip.png"}, {Data: "AAAA", MediaType: "image/png"}}}},
		Tools:      []ToolDefinition{{Name: "lookup", InputSchema: json.RawMessage(`{"type":"object"}`)}},
		ToolChoice: ForceTool("lookup"),
		ResponseFormat: &ResponseFormat{Type: "json_schema", JSONSchema: &JSONSchema{
			Name: "brief", Strict: true, Schema: json.RawMessage(`{"type":"object","properties":{"title":{"type":"string"}},"required":["title"],"additionalProperties":false}`),
		}},
	})
	if err != nil {
		t.Fatal(err)
	}
	var out struct{ Title string }
	if err := json.Unmarshal(res.Output, &out); err != nil || out.Title != "Hi" {
		t.Fatalf("output = %s %v", res.Output, err)
	}
	var sent map[string]any
	_ = json.Unmarshal([]byte(f.seen[0].body), &sent)
	tc, _ := sent["tool_choice"].(map[string]any)
	rf, _ := sent["response_format"].(map[string]any)
	imgs := sent["messages"].([]any)[0].(map[string]any)["images"].([]any)
	if tc["type"] != "tool" || tc["name"] != "lookup" || rf["type"] != "json_schema" || len(imgs) != 2 ||
		imgs[1].(map[string]any)["media_type"] != "image/png" {
		t.Fatalf("sent = %v", sent)
	}
	b, _ := json.Marshal(CompleteRequest{ToolChoice: ToolChoiceAny})
	var plain map[string]any
	_ = json.Unmarshal(b, &plain)
	if plain["tool_choice"] != "any" {
		t.Fatalf("plain choice = %s", b)
	}
	b, _ = json.Marshal(CompleteRequest{})
	unset := map[string]any{}
	_ = json.Unmarshal(b, &unset)
	if _, has := unset["tool_choice"]; has {
		t.Fatalf("unset choice was sent: %s", b)
	}
}

func TestEmbedAndModels(t *testing.T) {
	f, c := newFake(t,
		ok(`{"model":"@cf/baai/bge-m3","dimensions":2,"embeddings":[{"index":0,"embedding":[0.1,0.2]},{"index":1,"embedding":[0.3,0.4]}],"usage":{"input_tokens":4,"estimated":true}}`),
		ok(`{"default":"openai/gpt-4o","models":[{"id":"openai/gpt-4o","kind":"chat","default":true,"capabilities":{"vision":true,"json_schema":true,"json_schema_native":true,"tools":true,"context_tokens":128000}}]}`))
	res, err := c.AI.Embed(ctx, EmbedRequest{Input: []string{"a", "b"}})
	if err != nil || res.Dimensions != 2 || len(res.Embeddings) != 2 || res.Embeddings[1].Embedding[0] != 0.3 || !res.Usage.Estimated {
		t.Fatalf("embed: %+v %v", res, err)
	}
	if f.seen[0].method != "POST" || f.seen[0].path != "/core/ai/embeddings" || f.seen[0].body != `{"input":["a","b"]}` {
		t.Fatalf("sent %+v", f.seen[0])
	}
	list, err := c.AI.Models(ctx, "kiosk")
	if err != nil || list.Default != "openai/gpt-4o" || !list.Models[0].Capabilities.JSONSchemaNative || list.Models[0].Capabilities.ContextTokens != 128000 {
		t.Fatalf("models: %+v %v", list, err)
	}
	if f.seen[1].method != "GET" || f.seen[1].path != "/core/ai/models?app=kiosk" {
		t.Fatalf("sent %+v", f.seen[1])
	}
	if !retryable["ai.embed"] || !retryable["ai.models"] {
		t.Fatal("embeddings and the model list change nothing, so they are retried")
	}
}

func TestModelRoles(t *testing.T) {
	f, c := newFake(t, ok(`{"name":"extract.fast","model":"openai/gpt-4.1-mini","fallbacks":["openai/gpt-4o-mini"],"level":"workspace","published":true}`))
	if _, err := c.AI.Roles(ctx, ""); err != nil {
		t.Fatal(err)
	}
	v, err := c.AI.SetRole(ctx, "extract.fast", RoleSet{Model: "openai/gpt-4.1-mini", Fallbacks: []string{"openai/gpt-4o-mini"}, Level: "workspace"})
	if err != nil || v.Level != "workspace" || v.Fallbacks[0] != "openai/gpt-4o-mini" {
		t.Fatalf("set = %+v %v", v, err)
	}
	if err := c.AI.DeleteRole(ctx, "extract.fast", "workspace"); err != nil {
		t.Fatal(err)
	}
	got := []string{}
	for _, s := range f.seen {
		got = append(got, s.method+" "+s.path)
	}
	want := []string{"GET /core/ai/roles", "PUT /core/ai/roles/extract.fast", "DELETE /core/ai/roles/extract.fast?level=workspace"}
	for i := range want {
		if got[i] != want[i] {
			t.Fatalf("sent %v", got)
		}
	}
	if f.seen[1].body != `{"model":"openai/gpt-4.1-mini","fallbacks":["openai/gpt-4o-mini"],"level":"workspace"}` {
		t.Fatalf("body = %s", f.seen[1].body)
	}
}

func TestMetadataCostAndUsageGroups(t *testing.T) {
	f, c := newFake(t,
		ok(`{"text":"hi","stop_reason":"stop","model":"m","usage":{"input_tokens":1,"cost_micros":42}}`),
		ok(`{"workspace_id":"w","group_by":"run_id","groups":[{"value":"r1","cost_micros":500,"model_calls":2}]}`))
	res, err := c.AI.Complete(ctx, CompleteRequest{Messages: hi, Metadata: Metadata{"unit": "brief_draft", "run_id": "r1"}})
	if err != nil || res.Usage.CostMicros == nil || *res.Usage.CostMicros != 42 {
		t.Fatalf("complete: %+v %v", res, err)
	}
	var sent map[string]any
	_ = json.Unmarshal([]byte(f.seen[0].body), &sent)
	if m, _ := sent["metadata"].(map[string]any); m["unit"] != "brief_draft" {
		t.Fatalf("sent %v", sent)
	}
	rep, err := c.Usage.Query(ctx, UsageQuery{GroupBy: "run_id", Unit: "brief_draft"})
	if err != nil || rep.GroupBy != "run_id" || rep.Groups[0].Value != "r1" || rep.Groups[0].CostMicros != 500 {
		t.Fatalf("usage: %+v %v", rep, err)
	}
	if f.seen[1].path != "/core/usage?group_by=run_id&unit=brief_draft" {
		t.Fatalf("path %s", f.seen[1].path)
	}
}

func TestBudgets(t *testing.T) {
	f, c := newFake(t, ok(`{"id":"b1","label":"unit","value":"*","period":"day","limit_micros":5000000,"limit_usd":5,"spent_micros":0,"spent_usd":0,"resets_at":"2026-11-25T00:00:00Z"}`))
	b, err := c.Budgets.Set(ctx, BudgetSet{Label: "unit", Value: "*", Period: "day", LimitUSD: 5})
	if err != nil || b.LimitMicros != 5000000 {
		t.Fatalf("set = %+v %v", b, err)
	}
	c.Budgets.Delete(ctx, "b1")
	if f.seen[0].method != "PUT" || f.seen[0].path != "/core/budgets" || f.seen[1].path != "/core/budgets/b1" ||
		f.seen[0].body != `{"label":"unit","value":"*","period":"day","limit_usd":5}` {
		t.Fatalf("sent %+v", f.seen)
	}
}

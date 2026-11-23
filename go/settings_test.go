package omazy

import (
	"encoding/json"
	"errors"
	"strings"
	"testing"
	"time"
)

const settingsJSON = `{"app_id":"a1","app":"acme",` +
	`"model":{"id":"openai/gpt-4o","source":"app","overridden":true,"inherited_model":"openai/gpt-4o-mini","max_tokens":1200,"temperature":null},` +
	`"models":[{"id":"openai/gpt-4o","label":"GPT-4o","vendor":"openai","tier":"premium","tools":true,"source":"managed"}],` +
	`"loop":{"harness":true,"stream":true,"redact":false,"overrides":{"harness":true}}}`

func TestAgentSettingsAreRead(t *testing.T) {
	f, c := newFake(t, ok(settingsJSON))
	c.app = "acme"
	got, err := c.Agent.Settings(ctx, "")
	if err != nil {
		t.Fatal(err)
	}
	if got.Model.ID != "openai/gpt-4o" || !got.Model.Overridden || got.Model.InheritedModel != "openai/gpt-4o-mini" ||
		got.Model.MaxTokens == nil || *got.Model.MaxTokens != 1200 || got.Model.Temperature != nil {
		t.Fatalf("model: %+v", got.Model)
	}
	if len(got.Models) != 1 || !got.Models[0].Tools || got.App != "acme" {
		t.Fatalf("models: %+v", got.Models)
	}
	if !got.Loop.Harness || !got.Loop.Stream || got.Loop.Redact || got.Loop.Overrides.Harness == nil || got.Loop.Overrides.Stream != nil {
		t.Fatalf("loop: %+v", got.Loop)
	}
	if f.seen[0].method != "GET" || f.seen[0].path != "/core/agent/settings?app=acme" {
		t.Fatalf("request: %+v", f.seen[0])
	}
}

func TestASettingsChangeSendsNullAsNullAndLeavesOutWhatWasNotNamed(t *testing.T) {
	f, c := newFake(t, ok(settingsJSON))
	if _, err := c.Agent.UpdateSettings(ctx, AgentSettingsUpdate{
		Model: Set("openai/gpt-4o"), MaxTokens: Clear[int](),
		Loop: &AgentLoopUpdate{Stream: Set(false), Redact: Clear[bool]()},
	}); err != nil {
		t.Fatal(err)
	}
	if f.seen[0].method != "PATCH" || f.seen[0].path != "/core/agent/settings" {
		t.Fatalf("request: %+v", f.seen[0])
	}
	// Clear means "back to what the agent inherits"; a nil field means "leave it".
	if want := `{"model":"openai/gpt-4o","max_tokens":null,"loop":{"stream":false,"redact":null}}`; f.seen[0].body != want {
		t.Fatalf("body:\n got %s\nwant %s", f.seen[0].body, want)
	}
	_, _ = c.Agent.UpdateSettings(ctx, AgentSettingsUpdate{Model: Clear[string]()})
	if f.seen[1].body != `{"model":null}` {
		t.Fatalf("clearing the model: %s", f.seen[1].body)
	}
	// A zero temperature and a false switch are values.
	c.app = "acme"
	_, _ = c.Agent.UpdateSettings(ctx, AgentSettingsUpdate{Temperature: Set(0.0), Loop: &AgentLoopUpdate{Harness: Set(false)}})
	if want := `{"app":"acme","temperature":0,"loop":{"harness":false}}`; f.seen[2].body != want {
		t.Fatalf("zero and false:\n got %s\nwant %s", f.seen[2].body, want)
	}
}

func TestASettingsChangeIsSentAgainAfterAGatewayError(t *testing.T) {
	f, c := newFake(t, fail(503, "UPSTREAM_UNAVAILABLE", "try again"), ok(settingsJSON))
	if _, err := c.Agent.UpdateSettings(ctx, AgentSettingsUpdate{Loop: &AgentLoopUpdate{Harness: Set(true)}}); err != nil {
		t.Fatal(err)
	}
	if len(f.seen) != 2 || f.seen[0].body != f.seen[1].body {
		t.Fatalf("the same change twice: %+v", f.seen)
	}
}

func TestAModelThatCannotBeSetIsAnErrorWithItsCode(t *testing.T) {
	for status, code := range map[int]string{403: "MODEL_NOT_AVAILABLE", 422: "MODEL_NOT_SERVING"} {
		f, c := newFake(t, fail(status, code, "no"))
		_, err := c.Agent.UpdateSettings(ctx, AgentSettingsUpdate{Model: Set("openai/o3")})
		var apiErr *Error
		if !errors.As(err, &apiErr) || apiErr.Status != status || apiErr.Code != code || len(f.seen) != 1 {
			t.Fatalf("%d: %v, sent %d times", status, err, len(f.seen))
		}
	}
}

func TestCacheTTLHelpersSendSeconds(t *testing.T) {
	if got := NoCache(); got == nil || *got != 0 {
		t.Fatalf("NoCache: %v", got)
	}
	if got := CacheFor(5 * time.Minute); got == nil || *got != 300 {
		t.Fatalf("CacheFor: %v", got)
	}
	b, _ := json.Marshal(CompleteRequest{Messages: []Message{{Role: "user", Content: "hi"}}, CacheTTL: NoCache()})
	if !strings.Contains(string(b), `"cache_ttl":0`) {
		t.Fatalf("a zero TTL must be sent: %s", b)
	}
}

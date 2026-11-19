package omazy

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"sync"
	"testing"
	"time"
)

// hmac-sha256('s3cret', '{"a":1}') in hex, computed with openssl. The three
// SDKs test against the same vector.
const sigVector = "5910e62016ef5034272c926c27071992a465c2335cecf41851bda071577f4f6d"

type seen struct {
	method, path, auth, body string
}

// fakeAPI is a real HTTP server that answers from a queue and records what it
// was sent. The last answer repeats.
type fakeAPI struct {
	mu      sync.Mutex
	seen    []seen
	answers []func(w http.ResponseWriter, r *http.Request)
	srv     *httptest.Server
}

func newFake(t *testing.T, answers ...func(http.ResponseWriter, *http.Request)) (*fakeAPI, *Client) {
	t.Helper()
	f := &fakeAPI{answers: answers}
	f.srv = httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		b, _ := io.ReadAll(r.Body)
		f.mu.Lock()
		f.seen = append(f.seen, seen{r.Method, r.URL.RequestURI(), r.Header.Get("Authorization"), string(b)})
		a := f.answers[0]
		if len(f.answers) > 1 {
			f.answers = f.answers[1:]
		}
		f.mu.Unlock()
		a(w, r)
	}))
	t.Cleanup(f.srv.Close)
	c := New("cai_abc.def", WithBaseURL(f.srv.URL+"/core"))
	c.sleep = func(context.Context, time.Duration) error { return nil }
	return f, c
}

func ok(data string, headers ...string) func(http.ResponseWriter, *http.Request) {
	return func(w http.ResponseWriter, _ *http.Request) {
		for i := 0; i+1 < len(headers); i += 2 {
			w.Header().Set(headers[i], headers[i+1])
		}
		_, _ = io.WriteString(w, `{"success":true,"data":`+data+`}`)
	}
}

func fail(status int, code, msg string, headers ...string) func(http.ResponseWriter, *http.Request) {
	return func(w http.ResponseWriter, _ *http.Request) {
		for i := 0; i+1 < len(headers); i += 2 {
			w.Header().Set(headers[i], headers[i+1])
		}
		w.WriteHeader(status)
		_ = json.NewEncoder(w).Encode(map[string]any{"success": false, "error": map[string]string{"code": code, "message": msg}})
	}
}

func raw(body string) func(http.ResponseWriter, *http.Request) {
	return func(w http.ResponseWriter, _ *http.Request) { _, _ = io.WriteString(w, body) }
}

func sse(chunks ...string) func(http.ResponseWriter, *http.Request) {
	return func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "text/event-stream")
		for _, c := range chunks {
			_, _ = io.WriteString(w, c)
			w.(http.Flusher).Flush()
		}
	}
}

var ctx = context.Background()
var hi = []Message{{Role: "user", Content: "hi"}}

func TestRouteTableIsTheContract(t *testing.T) {
	// The contract sits beside the SDKs: one level up in the public
	// repository, two in the platform's own.
	b, err := os.ReadFile("../contracts/core-api.routes.json")
	if err != nil {
		b, err = os.ReadFile("../../contracts/core-api.routes.json")
	}
	if err != nil {
		t.Fatal(err)
	}
	var doc struct {
		Routes []struct{ Method, Path, SDK string }
	}
	if err := json.Unmarshal(b, &doc); err != nil {
		t.Fatal(err)
	}
	if len(doc.Routes) != len(routes) {
		t.Errorf("the contract has %d routes, the client %d", len(doc.Routes), len(routes))
	}
	for _, r := range doc.Routes {
		got, ok := routes[r.SDK]
		if !ok || got.method != r.Method || got.path != r.Path {
			t.Errorf("%s: client has %+v, the contract says %s %s", r.SDK, got, r.Method, r.Path)
		}
	}
}

func TestEveryRouteIsReachableThroughAClientMethod(t *testing.T) {
	f, c := newFake(t, func(w http.ResponseWriter, r *http.Request) {
		if strings.HasSuffix(r.URL.Path, "/mcp") {
			raw(`{"jsonrpc":"2.0","id":1,"result":{"tools":[]}}`)(w, r)
			return
		}
		ok(`{"passages":[]}`)(w, r)
	})
	c.Whoami(ctx)
	c.AI.Complete(ctx, CompleteRequest{Messages: hi})
	c.Knowledge.Search(ctx, "q", SearchOptions{})
	c.Agent.Turn(ctx, AgentTurnRequest{Message: "hi"})
	c.Voice.Speak(ctx, "hi", "", "")
	c.Voice.Transcribe(ctx, []byte{1, 2}, "", "")
	c.Voice.PlaceCall(ctx, CallRequest{To: "+8801712345678", Purpose: "reminder", ConsentBasis: "customer"})
	c.Voice.GetCall(ctx, "r1", "")
	c.Voice.CreateJob(ctx, VoiceJobRequest{Kind: "transcribe", SourceURL: "https://x.test/a.mp3"})
	c.Voice.GetJob(ctx, "j1", "")
	c.Customers.Get(ctx, "c1")
	c.Customers.Update(ctx, "c1", map[string]any{"tier": "gold"})
	c.Conversations.PostMessage(ctx, "s1", []Block{TextBlock("hi")})
	c.Channels.LinkedInPublish(ctx, "hi", "")
	c.Sessions.BindCredential(ctx, "s1", "erp", CredentialBinding{Token: "t", ExpiresAt: "2027-01-01T00:00:00Z"})
	c.Sessions.UnbindCredential(ctx, "s1", "erp")
	c.MCP.ListTools(ctx)

	used := map[string]bool{}
	for _, s := range f.seen {
		used[s.method+" "+strings.TrimPrefix(strings.SplitN(s.path, "?", 2)[0], "/core")] = true
	}
	for name, r := range routes {
		id := "c1"
		if strings.HasPrefix(name, "voice.jobs") {
			id = "j1"
		} else if strings.HasPrefix(name, "conv") {
			id = "s1"
		}
		p := strings.NewReplacer("{ref}", "r1", "{sid}", "s1", "{server}", "erp", "{id}", id).Replace(r.path)
		if !used[r.method+" "+p] {
			t.Errorf("%s (%s %s) was never called", name, r.method, p)
		}
	}
}

func TestNothingThatChangesTheWorldIsRetried(t *testing.T) {
	for _, name := range []string{"voice.calls.place", "conversations.post_message", "channels.linkedin_publish", "agent.turn", "customers.update", "voice.jobs.create", "mcp"} {
		if retryable[name] {
			t.Errorf("%s must not be retried", name)
		}
	}
}

func TestTokenEnvelopeAndDefaultApp(t *testing.T) {
	f, _ := newFake(t, ok(`{"text":"pong","stop_reason":"stop","model":"openai/gpt-4o","usage":{"input_tokens":3}}`))
	c := New("cai_abc.def", WithBaseURL(f.srv.URL+"/core"), WithApp("kiosk"))
	res, err := c.AI.Complete(ctx, CompleteRequest{Messages: hi})
	if err != nil || res.Text != "pong" || res.Usage.InputTokens != 3 {
		t.Fatalf("complete: %+v %v", res, err)
	}
	var sent map[string]any
	_ = json.Unmarshal([]byte(f.seen[0].body), &sent)
	if f.seen[0].auth != "Bearer cai_abc.def" || sent["app"] != "kiosk" || sent["stream"] != false {
		t.Errorf("sent auth=%q body=%v", f.seen[0].auth, sent)
	}
}

func TestPathArgumentsAreEscapedIntoOneSegment(t *testing.T) {
	f, c := newFake(t, ok(`{}`))
	c.Voice.GetCall(ctx, "a/../b", "kiosk")
	if got := f.seen[0].path; got != "/core/voice/calls/a%2F..%2Fb?app=kiosk" {
		t.Errorf("path = %s", got)
	}
}

func TestARefusalIsAnErrorWithCodeStatusAndRequestID(t *testing.T) {
	_, c := newFake(t, fail(403, "FORBIDDEN", "missing scope: ai:complete", "X-Request-Id", "req_1"))
	_, err := c.AI.Complete(ctx, CompleteRequest{Messages: hi})
	var e *Error
	if !errors.As(err, &e) || e.Status != 403 || e.Code != "FORBIDDEN" || e.Message != "missing scope: ai:complete" || e.RequestID != "req_1" {
		t.Errorf("error = %+v", err)
	}
}

func TestResponseHeadersAreReadIntoLast(t *testing.T) {
	_, c := newFake(t, ok(`{}`, "X-Request-Id", "req_9", "X-RateLimit-Limit", "600", "X-RateLimit-Remaining", "12", "X-RateLimit-Reset", "3", "X-Omazy-Token-Use", "previous", "X-Omazy-Token-Expires-At", "2026-12-01T00:00:00Z"))
	c.Whoami(ctx)
	want := ResponseInfo{RequestID: "req_9", RateLimit: 600, RateRemaining: 12, RateReset: 3 * time.Second, TokenExpiresAt: "2026-12-01T00:00:00Z", TokenIsPrevious: true}
	if got := c.Last(); got != want {
		t.Errorf("last = %+v, want %+v", got, want)
	}
}

func TestARateLimitedReadIsSentAgain(t *testing.T) {
	f, c := newFake(t, fail(429, "RATE_LIMIT_EXCEEDED", "slow down", "Retry-After", "2"), fail(503, "UPSTREAM_UNAVAILABLE", "busy"), ok(`{"passages":[{"title":"t"}]}`))
	var waits []time.Duration
	c.sleep = func(_ context.Context, d time.Duration) error { waits = append(waits, d); return nil }
	ps, err := c.Knowledge.Search(ctx, "q", SearchOptions{})
	if err != nil || len(ps) != 1 || len(f.seen) != 3 || waits[0] != 2*time.Second {
		t.Errorf("passages=%v err=%v requests=%d waits=%v", ps, err, len(f.seen), waits)
	}
}

func TestPlacingACallIsNeverSentTwice(t *testing.T) {
	f, c := newFake(t, fail(503, "UPSTREAM_UNAVAILABLE", "busy"))
	if _, err := c.Voice.PlaceCall(ctx, CallRequest{To: "+8801712345678", Purpose: "reminder", ConsentBasis: "customer"}); err == nil {
		t.Error("want an error")
	}
	if len(f.seen) != 1 {
		t.Errorf("requests = %d, want 1", len(f.seen))
	}
}

func TestAFullWindowIsHandedBackNotWaitedOut(t *testing.T) {
	f, c := newFake(t, fail(429, "RATE_LIMIT_EXCEEDED", "slow down", "Retry-After", "540"))
	_, err := c.Whoami(ctx)
	var e *Error
	if !errors.As(err, &e) || e.RetryAfter != 540*time.Second || len(f.seen) != 1 {
		t.Errorf("err=%+v requests=%d", err, len(f.seen))
	}
}

func TestABadRequestIsNotRetried(t *testing.T) {
	f, c := newFake(t, fail(400, "BAD_REQUEST", "messages is required"))
	c.AI.Complete(ctx, CompleteRequest{})
	if len(f.seen) != 1 {
		t.Errorf("requests = %d, want 1", len(f.seen))
	}
}

func TestNoServerIsANetworkErrorAfterRetries(t *testing.T) {
	c := New("cai_abc.def", WithBaseURL("http://127.0.0.1:9/core"), WithMaxRetries(1))
	slept := 0
	c.sleep = func(context.Context, time.Duration) error { slept++; return nil }
	_, err := c.Whoami(ctx)
	var e *Error
	if !errors.As(err, &e) || e.Status != 0 || e.Code != "NETWORK_ERROR" || slept != 1 {
		t.Errorf("err=%+v slept=%d", err, slept)
	}
}

func TestStreamPutsSplitFramesAndCharactersBackTogether(t *testing.T) {
	whole := "event: delta\ndata: {\"text\":\"নমস্কার\"}\n\nevent: delta\ndata: {\"text\":\" world\"}\n\nevent: done\ndata: {\"text\":\"নমস্কার world\",\"stop_reason\":\"stop\",\"model\":\"m\",\"usage\":{}}\n\n"
	f, c := newFake(t, sse(whole[:31], whole[31:70], whole[70:]))
	var deltas []string
	res, err := c.AI.Stream(ctx, CompleteRequest{Messages: hi}, func(s string) { deltas = append(deltas, s) })
	if err != nil || res.Text != "নমস্কার world" || strings.Join(deltas, "|") != "নমস্কার| world" {
		t.Errorf("res=%+v deltas=%v err=%v", res, deltas, err)
	}
	if !strings.Contains(f.seen[0].body, `"stream":true`) {
		t.Errorf("the request did not ask for a stream: %s", f.seen[0].body)
	}
}

func TestStreamErrors(t *testing.T) {
	_, c := newFake(t, sse("event: delta\ndata: {\"text\":\"a\"}\n\nevent: error\ndata: {\"message\":\"the workspace's AI budget is spent\"}\n\n"))
	_, err := c.AI.Stream(ctx, CompleteRequest{Messages: hi}, nil)
	var e *Error
	if !errors.As(err, &e) || e.Code != "STREAM_ERROR" || e.Message != "the workspace's AI budget is spent" {
		t.Errorf("an error frame: %+v", err)
	}
	_, c = newFake(t, sse("event: delta\ndata: {\"text\":\"half\"}\n\n"))
	if _, err = c.AI.Stream(ctx, CompleteRequest{Messages: hi}, nil); !errors.As(err, &e) || e.Code != "STREAM_ERROR" {
		t.Errorf("a stream that stops before done: %+v", err)
	}
}

func TestMCP(t *testing.T) {
	f, c := newFake(t,
		raw(`{"jsonrpc":"2.0","id":1,"result":{"tools":[{"name":"knowledge_search","inputSchema":{}}]}}`),
		raw(`{"jsonrpc":"2.0","id":2,"result":{"content":[{"type":"text","text":"{\"passages\":[]}"}],"structuredContent":{"passages":[]},"isError":false}}`),
		raw(`{"jsonrpc":"2.0","id":3,"result":{"content":[{"type":"text","text":"BAD_REQUEST: query is required"}],"isError":true}}`),
		raw(`{"jsonrpc":"2.0","id":4,"error":{"code":-32602,"message":"Unknown tool: nope"}}`),
	)
	tools, err := c.MCP.ListTools(ctx)
	if err != nil || len(tools) != 1 || tools[0].Name != "knowledge_search" {
		t.Fatalf("tools=%v err=%v", tools, err)
	}
	res, err := c.MCP.CallTool(ctx, "knowledge_search", map[string]any{"query": "hours"})
	if err != nil || res.IsError || res.Text != `{"passages":[]}` || res.Data["passages"] == nil {
		t.Errorf("call: %+v %v", res, err)
	}
	if f.seen[1].path != "/core/mcp" || !strings.Contains(f.seen[1].body, `"name":"knowledge_search"`) {
		t.Errorf("sent %s %s", f.seen[1].path, f.seen[1].body)
	}
	// A refusal is returned, not an error.
	if res, err = c.MCP.CallTool(ctx, "knowledge_search", nil); err != nil || !res.IsError {
		t.Errorf("refusal: %+v %v", res, err)
	}
	var e *Error
	if _, err = c.MCP.CallTool(ctx, "nope", nil); !errors.As(err, &e) || e.Code != "MCP_-32602" {
		t.Errorf("unknown tool: %+v", err)
	}
	if cfg := c.MCP.Config(); cfg.URL != f.srv.URL+"/core/mcp" || cfg.Headers["Authorization"] != "Bearer cai_abc.def" || cfg.Type != "http" {
		t.Errorf("config = %+v", cfg)
	}
}

func TestSignature(t *testing.T) {
	h := Sign("s3cret", []byte(`{"a":1}`))
	if h != "sha256="+sigVector {
		t.Fatalf("signature = %s", h)
	}
	if !VerifySignature("s3cret", []byte(`{"a":1}`), h) {
		t.Error("the signature should verify over the exact body")
	}
	for name, bad := range map[string]bool{
		"another body":   VerifySignature("s3cret", []byte(`{"a": 1}`), h),
		"another secret": VerifySignature("other", []byte(`{"a":1}`), h),
		"no header":      VerifySignature("s3cret", []byte(`{"a":1}`), ""),
		"no secret":      VerifySignature("", []byte(`{"a":1}`), h),
	} {
		if bad {
			t.Errorf("verified with %s", name)
		}
	}
}

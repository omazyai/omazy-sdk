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
	// key is the Idempotency-Key header.
	key string
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
		f.seen = append(f.seen, seen{r.Method, r.URL.RequestURI(), r.Header.Get("Authorization"), string(b), r.Header.Get("Idempotency-Key")})
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

// readContract reads the route contract. It sits beside the SDKs: one level
// up in the public repository, two in the platform's own.
func readContract(t *testing.T) []byte {
	t.Helper()
	b, err := os.ReadFile("../contracts/core-api.routes.json")
	if err != nil {
		b, err = os.ReadFile("../../contracts/core-api.routes.json")
	}
	if err != nil {
		t.Fatal(err)
	}
	return b
}

func TestRouteTableIsTheContract(t *testing.T) {
	b := readContract(t)
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
	c.Knowledge.ListDocuments(ctx, ListOptions{})
	c.Knowledge.CreateDocument(ctx, DocumentInput{Title: "t", Content: "c"})
	c.Knowledge.GetDocument(ctx, "c1", "")
	title := "t2"
	c.Knowledge.UpdateDocument(ctx, "c1", DocumentPatch{Title: &title})
	c.Knowledge.DeleteDocument(ctx, "c1", "")
	c.Knowledge.ImportFile(ctx, []byte{1, 2}, "a.pdf", "", "")
	c.Knowledge.ListSources(ctx, "")
	c.Knowledge.CreateSource(ctx, SourceInput{RootURL: "https://x.test"})
	c.Knowledge.CrawlSource(ctx, "c1", "")
	c.Knowledge.Export(ctx, ExportOptions{})
	c.Agent.Turn(ctx, AgentTurnRequest{Message: "hi"})
	c.Agent.Settings(ctx, "")
	c.Agent.UpdateSettings(ctx, AgentSettingsUpdate{Loop: &AgentLoopUpdate{Stream: Set(true)}})
	c.Agent.ListMCPServers(ctx, "")
	c.Agent.CreateMCPServer(ctx, MCPServerInput{Name: "a", EndpointURL: "https://a.test/mcp", AuthType: "none"})
	c.Agent.GetMCPServer(ctx, "c1", "")
	c.Agent.UpdateMCPServer(ctx, "c1", MCPServerUpdate{})
	c.Agent.DeleteMCPServer(ctx, "c1", "")
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
	c.Usage.Get(ctx, "", "")
	c.MCP.ListTools(ctx)

	used := map[string]bool{}
	for _, s := range f.seen {
		used[s.method+" "+strings.TrimPrefix(strings.SplitN(s.path, "?", 2)[0], "/core")] = true
	}
	for name, r := range routes {
		if websocket[name] {
			continue // opened on a real socket in stt_test.go
		}
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
	for _, name := range []string{"voice.calls.place", "conversations.post_message", "channels.linkedin_publish", "agent.turn", "customers.update", "voice.jobs.create", "mcp",
		"knowledge.documents.create", "knowledge.documents.update", "knowledge.documents.delete", "knowledge.import_file", "knowledge.sources.create", "knowledge.sources.crawl"} {
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

func TestAgentTurnStreamsAndEndsWithTheWholeTurn(t *testing.T) {
	f, c := newFake(t, sse("event: delta\ndata: {\"text\":\"Good \"}\n\nevent: delta\ndata: {\"text\":\"morning.\"}\n\nevent: done\ndata: {\"session_id\":\"s1\",\"text\":\"Good morning.\",\"sources\":0,\"usage\":{}}\n\n"))
	var deltas []string
	res, err := c.Agent.Stream(ctx, AgentTurnRequest{Message: "hello", Context: map[string]any{"interaction": "voice"}}, func(s string) { deltas = append(deltas, s) })
	if err != nil || res.Text != "Good morning." || res.SessionID != "s1" || strings.Join(deltas, "|") != "Good |morning." {
		t.Errorf("res=%+v deltas=%v err=%v", res, deltas, err)
	}
	if f.seen[0].path != "/core/agent/turn" || !strings.Contains(f.seen[0].body, `"stream":true`) || !strings.Contains(f.seen[0].body, `"context":{"interaction":"voice"}`) {
		t.Errorf("sent %s %s", f.seen[0].path, f.seen[0].body)
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

func TestADocumentIsCreatedInTheDefaultAppWithItsIndexStatus(t *testing.T) {
	f, c := newFake(t, ok(`{"id":"01A","title":"Hours","index":{"status":"queued","indexed_at":null,"chunks":0,"tokens":0},"version":0}`))
	c.app = "desk"
	doc, err := c.Knowledge.CreateDocument(ctx, DocumentInput{Title: "Hours", Content: "9 to 5"})
	if err != nil || doc.ID != "01A" || doc.Index.Status != "queued" || doc.Index.IndexedAt != nil {
		t.Fatalf("doc = %+v, err = %v", doc, err)
	}
	if got := f.seen[0]; got.method != "POST" || got.path != "/core/knowledge/documents" || got.body != `{"app":"desk","title":"Hours","content":"9 to 5"}` {
		t.Fatalf("sent %+v", got)
	}
}

func TestAPatchSendsOnlyTheFieldsGiven(t *testing.T) {
	f, c := newFake(t, ok(`{"id":"01A","is_active":false}`))
	off := false
	if _, err := c.Knowledge.UpdateDocument(ctx, "01A", DocumentPatch{IsActive: &off}); err != nil {
		t.Fatal(err)
	}
	if got := f.seen[0]; got.method != "PATCH" || got.path != "/core/knowledge/documents/01A" || got.body != `{"is_active":false}` {
		t.Fatalf("sent %+v", got)
	}
}

func TestAFileIsSentAsTheRawBodyWithItsName(t *testing.T) {
	f, c := newFake(t, ok(`{"id":"01F"}`))
	if _, err := c.Knowledge.ImportFile(ctx, []byte("%PDF-1.7"), "hand book.pdf", "application/pdf", ""); err != nil {
		t.Fatal(err)
	}
	if got := f.seen[0]; got.path != "/core/knowledge/import?filename=hand+book.pdf" || got.body != "%PDF-1.7" {
		t.Fatalf("sent %+v", got)
	}
}

func TestAnExportSendsSinceEvenWhenItIsZero(t *testing.T) {
	f, c := newFake(t, ok(`{"version":12,"documents":[{"id":"01A","is_active":true,"version":9,"chunks":[{"ordinal":0,"text":"p","tokens":1,"checksum":"c"}]}],"deleted":[{"id":"01B","version":11}],"resync":false,"next_cursor":""}`))
	ex, err := c.Knowledge.Export(ctx, ExportOptions{})
	if err != nil || ex.Version != 12 || len(ex.Documents) != 1 || ex.Documents[0].Chunks[0].Text != "p" || ex.Deleted[0].ID != "01B" {
		t.Fatalf("export = %+v, err = %v", ex, err)
	}
	if f.seen[0].path != "/core/knowledge/export" {
		t.Fatalf("a full export sent %s", f.seen[0].path)
	}
	zero := int64(0)
	if _, err := c.Knowledge.Export(ctx, ExportOptions{Since: &zero, Cursor: "12.4.01A", Limit: 20}); err != nil {
		t.Fatal(err)
	}
	if got := f.seen[1].path; got != "/core/knowledge/export?cursor=12.4.01A&limit=20&since=0" {
		t.Fatalf("sent %s", got)
	}
}

func TestAKnowledgeWriteIsNeverSentTwiceAndAReadIs(t *testing.T) {
	f, c := newFake(t, fail(503, "UPSTREAM_UNAVAILABLE", "try later"))
	if err := c.Knowledge.DeleteDocument(ctx, "01A", ""); err == nil {
		t.Fatal("a refused delete returned no error")
	}
	if len(f.seen) != 1 {
		t.Fatalf("the delete was sent %d times", len(f.seen))
	}
	f, c = newFake(t, fail(429, "RATE_LIMITED", "slow down", "Retry-After", "1"), ok(`{"documents":[],"next_cursor":"","version":3}`))
	page, err := c.Knowledge.ListDocuments(ctx, ListOptions{Limit: 10})
	if err != nil || page.Version != 3 || len(f.seen) != 2 {
		t.Fatalf("page = %+v, err = %v, sent %d times", page, err, len(f.seen))
	}
}

var aCall = CallRequest{To: "+8801712345678", Purpose: "reminder", ConsentBasis: "customer"}

func TestTheRoutesThatTakeAKeyAreTheOnesTheContractMarks(t *testing.T) {
	var contract struct {
		Routes []struct {
			SDK            string `json:"sdk"`
			IdempotencyKey bool   `json:"idempotency_key"`
		} `json:"routes"`
	}
	if err := json.Unmarshal(readContract(t), &contract); err != nil {
		t.Fatal(err)
	}
	for _, r := range contract.Routes {
		if idempotent[r.SDK] != r.IdempotencyKey {
			t.Errorf("%s takes an idempotency key: %v; the contract says %v", r.SDK, idempotent[r.SDK], r.IdempotencyKey)
		}
		if idempotent[r.SDK] && retryable[r.SDK] {
			t.Errorf("%s is both retried freely and keyed", r.SDK)
		}
	}
}

func TestACallPlacedWithAKeyIsSentAgainWithTheSameKey(t *testing.T) {
	f, c := newFake(t, fail(503, "UPSTREAM_UNAVAILABLE", "busy"), ok(`{"ref":"r1"}`, "Idempotent-Replayed", "true"))
	res, err := c.Voice.PlaceCall(WithIdempotencyKey(ctx, "visit-77"), aCall)
	if err != nil || res.Ref != "r1" {
		t.Fatalf("res=%+v err=%v", res, err)
	}
	if len(f.seen) != 2 || f.seen[0].key != "visit-77" || f.seen[1].key != "visit-77" {
		t.Errorf("requests = %+v", f.seen)
	}
	if !c.Last().Replayed {
		t.Error("the replay was not reported")
	}
}

func TestARepeatWhileTheFirstStillRunsWaitsAndAsksAgain(t *testing.T) {
	f, c := newFake(t, fail(409, "IDEMPOTENCY_IN_PROGRESS", "still running", "Retry-After", "2"), ok(`{"text":"hi"}`))
	var waits []time.Duration
	c.sleep = func(_ context.Context, d time.Duration) error { waits = append(waits, d); return nil }
	res, err := c.Agent.Turn(WithIdempotencyKey(ctx, "turn-1"), AgentTurnRequest{Message: "hi"})
	if err != nil || res.Text != "hi" || len(f.seen) != 2 || len(waits) != 1 || waits[0] != 2*time.Second {
		t.Errorf("res=%+v err=%v requests=%d waits=%v", res, err, len(f.seen), waits)
	}
}

func TestAKeyUsedWithAnotherRequestIsReportedNotRetried(t *testing.T) {
	f, c := newFake(t, fail(422, "IDEMPOTENCY_KEY_REUSED", "used with a different request"))
	_, err := c.Voice.PlaceCall(WithIdempotencyKey(ctx, "visit-77"), aCall)
	var apiErr *Error
	if !errors.As(err, &apiErr) || apiErr.Status != 422 || apiErr.Code != "IDEMPOTENCY_KEY_REUSED" || len(f.seen) != 1 {
		t.Errorf("err=%v requests=%d", err, len(f.seen))
	}
}

// A key on the context of a read, or of a write that takes none, is not sent.
func TestAKeyIsOnlySentWhereTheRouteTakesOne(t *testing.T) {
	f, c := newFake(t, ok(`{}`))
	keyed := WithIdempotencyKey(ctx, "k1")
	_, _ = c.Whoami(keyed)
	_, _ = c.Customers.Update(keyed, "c1", map[string]any{"tier": "gold"})
	_, _ = c.Conversations.PostMessage(ctx, "s1", []Block{{"type": "text", "markdown": "hi"}})
	for _, s := range f.seen {
		if s.key != "" {
			t.Errorf("%s %s carried a key", s.method, s.path)
		}
	}

	f.seen = nil
	_, _ = c.Knowledge.CreateDocument(keyed, DocumentInput{Title: "t", Content: "c"})
	_, _ = c.Knowledge.ImportFile(keyed, []byte{1}, "a.pdf", "application/pdf", "")
	_, _ = c.Knowledge.CreateSource(keyed, SourceInput{RootURL: "https://x.test"})
	_ = c.Knowledge.CrawlSource(keyed, "c1", "")
	_, _ = c.Agent.Turn(keyed, AgentTurnRequest{Message: "hi"})
	_, _ = c.Agent.CreateMCPServer(keyed, MCPServerInput{Name: "a", EndpointURL: "https://a.test/mcp", AuthType: "none"})
	_, _ = c.Voice.PlaceCall(keyed, aCall)
	_, _ = c.Voice.CreateJob(keyed, VoiceJobRequest{Kind: "transcribe", SourceURL: "https://x.test/a.mp3"})
	_, _ = c.Conversations.PostMessage(keyed, "s1", []Block{{"type": "text", "markdown": "hi"}})
	_, _ = c.Channels.LinkedInPublish(keyed, "hi", "")
	if len(f.seen) != len(idempotent) {
		t.Fatalf("requests = %d, want %d", len(f.seen), len(idempotent))
	}
	for _, s := range f.seen {
		if s.key != "k1" {
			t.Errorf("%s %s did not carry the key", s.method, s.path)
		}
	}
}

func TestAVoiceJobNamesItsAppInTheQuery(t *testing.T) {
	f, c := newFake(t, ok(`{"id":"j1"}`))
	c.app = "nordwell"
	if _, err := c.Voice.CreateJob(ctx, VoiceJobRequest{Kind: "transcribe", SourceURL: "https://x.test/a.mp3"}); err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(f.seen[0].path, "app=nordwell") || strings.Contains(f.seen[0].body, "app") {
		t.Errorf("path=%s body=%s", f.seen[0].path, f.seen[0].body)
	}
}

// Package omazy is a client for the Omazy Core API and its MCP server: models,
// knowledge, your agent, speech and calls from your own backend, with one
// scoped token and spend recorded against your workspace.
//
//	c := omazy.New(os.Getenv("OMAZY_CORE_TOKEN"))
//	res, err := c.AI.Complete(ctx, omazy.CompleteRequest{
//		Messages: []omazy.Message{{Role: "user", Content: "Hello"}},
//	})
//
// Standard library only.
package omazy

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"math/rand"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"sync"
	"time"
)

const (
	// DefaultBaseURL is the production Core API.
	DefaultBaseURL = "https://mw.omazy.ai/api/v1/core"
	// Version of this client.
	Version = "0.5.2"
)

// Error is a refusal or failure from the Core API. Branch on Code, log Message.
type Error struct {
	// Status is the HTTP status, or 0 when no response arrived.
	Status int
	// Code is a stable machine code, such as BAD_REQUEST or RATE_LIMIT_EXCEEDED.
	Code    string
	Message string
	// RequestID is the X-Request-Id of the response. Quote it when reporting a failure.
	RequestID string
	// RetryAfter is how long the API asked the caller to wait, when it said.
	RetryAfter time.Duration
}

func (e *Error) Error() string { return fmt.Sprintf("omazy: %s (%d): %s", e.Code, e.Status, e.Message) }

// ResponseInfo is what the API said about limits and the token on a response.
type ResponseInfo struct {
	RequestID string
	// RateLimit, RateRemaining and RateReset are set on rate-limited routes.
	RateLimit     int
	RateRemaining int
	RateReset     time.Duration
	// TokenExpiresAt is set when the token has a deadline (RFC 3339).
	TokenExpiresAt string
	// TokenIsPrevious is true while the caller is still on a token a rotation replaced.
	TokenIsPrevious bool
	// Replayed is true when the answer is the remembered answer of an earlier
	// request with the same idempotency key.
	Replayed bool
}

// Client calls the Core API. Create one with New and reuse it.
type Client struct {
	token      string
	base       string
	app        string
	maxRetries int
	http       *http.Client
	sleep      func(context.Context, time.Duration) error

	mu   sync.Mutex
	last ResponseInfo

	AI            *AIService
	Knowledge     *KnowledgeService
	Agent         *AgentService
	Voice         *VoiceService
	Customers     *CustomersService
	Conversations *ConversationsService
	Channels      *ChannelsService
	Sessions      *SessionsService
	Usage         *UsageService
	Budgets       *BudgetService
	MCP           *MCPService
}

// Option configures a Client.
type Option func(*Client)

// WithBaseURL points the client at another deployment.
func WithBaseURL(u string) Option { return func(c *Client) { c.base = strings.TrimRight(u, "/") } }

// WithApp sets the default app handle, for a workspace with more than one app.
func WithApp(handle string) Option { return func(c *Client) { c.app = handle } }

// WithHTTPClient replaces the HTTP client. The default gives up after 130 s,
// just above the API's own limit.
func WithHTTPClient(h *http.Client) Option { return func(c *Client) { c.http = h } }

// WithMaxRetries sets how often a request is sent again after a 429, 502, 503,
// 504 or a dropped connection, on routes that are safe to repeat. Default 2.
func WithMaxRetries(n int) Option { return func(c *Client) { c.maxRetries = n } }

// New builds a client for an install token, cai_<prefix>.<secret>. Keep the
// token on a server.
func New(token string, opts ...Option) *Client {
	c := &Client{
		token: token, base: DefaultBaseURL, maxRetries: 2,
		http: &http.Client{Timeout: 130 * time.Second},
		sleep: func(ctx context.Context, d time.Duration) error {
			t := time.NewTimer(d)
			defer t.Stop()
			select {
			case <-ctx.Done():
				return ctx.Err()
			case <-t.C:
				return nil
			}
		},
	}
	for _, o := range opts {
		o(c)
	}
	c.AI, c.Knowledge, c.Agent = &AIService{c}, &KnowledgeService{c}, &AgentService{c}
	c.Voice, c.Customers, c.Conversations = &VoiceService{c}, &CustomersService{c}, &ConversationsService{c}
	c.Channels, c.Sessions, c.MCP = &ChannelsService{c}, &SessionsService{c}, &MCPService{c: c}
	c.Usage = &UsageService{c}
	c.Budgets = &BudgetService{c}
	return c
}

// Last returns the headers of the most recent response of this client,
// whichever call it answered. When goroutines share the client, another call's
// response can replace them between your call and your read: use
// WithResponseInfo for the headers of one call.
func (c *Client) Last() ResponseInfo {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.last
}

// Whoami returns the workspace this token belongs to, its scopes and its
// deadline. Needs no scope.
func (c *Client) Whoami(ctx context.Context) (*Whoami, error) {
	var out Whoami
	return &out, c.json(ctx, "whoami", call{}, &out)
}

// Contract returns the route contract the live platform was built with. The
// platform answers it without a token.
func (c *Client) Contract(ctx context.Context) (*RouteContract, error) {
	var out RouteContract
	return &out, c.json(ctx, "contract", call{}, &out)
}

// ContractOpenAPI returns the live platform's OpenAPI document, as JSON.
func (c *Client) ContractOpenAPI(ctx context.Context) (json.RawMessage, error) {
	var out json.RawMessage
	return out, c.json(ctx, "contract", call{query: map[string]string{"format": "openapi"}}, &out)
}

type responseInfoKey struct{}

// WithResponseInfo returns a context that has a call made with it write its
// response headers into dst: the request id, the rate limit, the token's
// deadline and whether the answer was a replay. dst belongs to that call
// alone, so other goroutines sharing the client never change it. It is
// written on a refusal too. Last still follows every response.
//
//	var info omazy.ResponseInfo
//	res, err := c.AI.Complete(omazy.WithResponseInfo(ctx, &info), req)
//	log.Println(info.RequestID, info.RateRemaining)
func WithResponseInfo(ctx context.Context, dst *ResponseInfo) context.Context {
	return context.WithValue(ctx, responseInfoKey{}, dst)
}

type idempotencyKey struct{}

// WithIdempotencyKey names the request made with the returned context, so it
// can be sent again safely. It applies to the calls that change something:
// PlaceCall, PostMessage, LinkedInPublish, Turn, CreateJob, CreateDocument,
// ImportFile, CreateSource and CrawlSource. The platform runs a request with a
// key once; a repeat with the same key gets the first answer back, so the
// client retries it like a read. Use a new key for each new request and the
// same key when you send one again.
//
//	ctx := omazy.WithIdempotencyKey(ctx, orderID)
//	res, err := c.Voice.PlaceCall(ctx, req)
func WithIdempotencyKey(ctx context.Context, key string) context.Context {
	return context.WithValue(ctx, idempotencyKey{}, key)
}

// call is the variable part of a request.
type call struct {
	path    map[string]string
	query   map[string]string
	body    any    // JSON
	raw     []byte // sent as is
	headers map[string]string
	noRetry bool
}

func (c *Client) appOr(app string) string {
	if app != "" {
		return app
	}
	return c.app
}

// json sends a request and decodes the data of its {success, data} envelope.
func (c *Client) json(ctx context.Context, name string, in call, out any) error {
	res, err := c.send(ctx, name, in)
	if err != nil {
		return err
	}
	defer res.Body.Close()
	var env struct {
		Data json.RawMessage `json:"data"`
	}
	if err := json.NewDecoder(res.Body).Decode(&env); err != nil {
		return &Error{Status: res.StatusCode, Code: "BAD_RESPONSE", Message: "the response was not JSON: " + err.Error(), RequestID: res.Header.Get("X-Request-Id")}
	}
	if out == nil || len(env.Data) == 0 {
		return nil
	}
	return json.Unmarshal(env.Data, out)
}

// send sends a request with retries. It returns a 2xx response, whose body the
// caller closes, or an *Error.
func (c *Client) send(ctx context.Context, name string, in call) (*http.Response, error) {
	r, ok := routes[name]
	if !ok {
		return nil, fmt.Errorf("omazy: unknown route %q", name)
	}
	// A key makes a request that changes something safe to send again.
	key, _ := ctx.Value(idempotencyKey{}).(string)
	if !idempotent[name] {
		key = ""
	}
	attempts := 0
	if (retryable[name] || key != "") && !in.noRetry {
		attempts = c.maxRetries
	}
	return c.do(ctx, r, in, attempts, key, "the Core API")
}

// do sends one request to a route with retries. key, when set, is sent as
// Idempotency-Key. api names the API in a network error.
func (c *Client) do(ctx context.Context, r route, in call, attempts int, key, api string) (*http.Response, error) {
	if c.token == "" {
		return nil, errors.New("omazy: token is required")
	}
	keyed := key != ""
	path := r.path
	for k, v := range in.path {
		path = strings.ReplaceAll(path, "{"+k+"}", url.PathEscape(v))
	}
	q := url.Values{}
	for k, v := range in.query {
		if v != "" {
			q.Set(k, v)
		}
	}
	target := c.base + path
	if len(q) > 0 {
		target += "?" + q.Encode()
	}
	payload := in.raw
	if in.body != nil {
		b, err := json.Marshal(in.body)
		if err != nil {
			return nil, err
		}
		payload = b
	}
	for attempt := 0; ; attempt++ {
		var body io.Reader
		if payload != nil {
			body = bytes.NewReader(payload)
		}
		req, err := http.NewRequestWithContext(ctx, r.method, target, body)
		if err != nil {
			return nil, err
		}
		req.Header.Set("Authorization", "Bearer "+c.token)
		req.Header.Set("User-Agent", "omazy-sdk-go/"+Version)
		if in.body != nil {
			req.Header.Set("Content-Type", "application/json")
		}
		for k, v := range in.headers {
			req.Header.Set(k, v)
		}
		if keyed {
			req.Header.Set("Idempotency-Key", key)
		}
		res, err := c.http.Do(req)
		if err != nil {
			if ctx.Err() != nil {
				return nil, ctx.Err()
			}
			if attempt < attempts {
				if err := c.sleep(ctx, backoff(attempt)); err != nil {
					return nil, err
				}
				continue
			}
			return nil, &Error{Code: "NETWORK_ERROR", Message: "no response from " + api + ": " + err.Error()}
		}
		info := readInfo(res.Header)
		c.mu.Lock()
		c.last = info
		c.mu.Unlock()
		if dst, ok := ctx.Value(responseInfoKey{}).(*ResponseInfo); ok && dst != nil {
			*dst = info
		}
		if res.StatusCode >= 200 && res.StatusCode < 300 {
			return res, nil
		}
		apiErr := readError(res, info.RequestID)
		res.Body.Close()
		transient := res.StatusCode == 429 || res.StatusCode == 502 || res.StatusCode == 503 || res.StatusCode == 504 ||
			// The first request with this key is still running: wait and ask again.
			(keyed && res.StatusCode == 409 && apiErr.Code == "IDEMPOTENCY_IN_PROGRESS")
		// A long Retry-After means the window is full. Waiting it out here
		// would hide a stalled caller, so hand that back.
		if transient && attempt < attempts && apiErr.RetryAfter <= 30*time.Second {
			wait := apiErr.RetryAfter
			if wait == 0 {
				wait = backoff(attempt)
			}
			if err := c.sleep(ctx, wait); err != nil {
				return nil, err
			}
			continue
		}
		return nil, apiErr
	}
}

func backoff(attempt int) time.Duration {
	d := 500 * time.Millisecond << attempt
	if d > 8*time.Second {
		d = 8 * time.Second
	}
	return time.Duration(float64(d) * (0.5 + rand.Float64()/2))
}

func readInfo(h http.Header) ResponseInfo {
	n := func(k string) int { v, _ := strconv.Atoi(h.Get(k)); return v }
	return ResponseInfo{
		RequestID:       h.Get("X-Request-Id"),
		RateLimit:       n("X-RateLimit-Limit"),
		RateRemaining:   n("X-RateLimit-Remaining"),
		RateReset:       time.Duration(n("X-RateLimit-Reset")) * time.Second,
		TokenExpiresAt:  h.Get("X-Omazy-Token-Expires-At"),
		TokenIsPrevious: h.Get("X-Omazy-Token-Use") == "previous",
		Replayed:        h.Get("Idempotent-Replayed") == "true",
	}
}

func readError(res *http.Response, requestID string) *Error {
	e := &Error{Status: res.StatusCode, Code: "HTTP_" + strconv.Itoa(res.StatusCode), RequestID: requestID}
	if s, err := strconv.Atoi(res.Header.Get("Retry-After")); err == nil && s > 0 {
		e.RetryAfter = time.Duration(s) * time.Second
	}
	raw, _ := io.ReadAll(io.LimitReader(res.Body, 64<<10))
	var env struct {
		Error json.RawMessage `json:"error"`
	}
	var detail struct {
		Code    string `json:"code"`
		Message string `json:"message"`
	}
	var text string
	switch {
	case json.Unmarshal(raw, &env) == nil && json.Unmarshal(env.Error, &detail) == nil && detail.Message != "":
		if detail.Code != "" {
			e.Code = detail.Code
		}
		e.Message = detail.Message
	case json.Unmarshal(env.Error, &text) == nil && text != "":
		e.Message = text
	default:
		e.Message = strings.TrimSpace(string(raw))
		if len(e.Message) > 300 {
			e.Message = e.Message[:300]
		}
		if e.Message == "" {
			e.Message = http.StatusText(res.StatusCode)
		}
	}
	return e
}

// AIService is the model gateway.
type AIService struct{ c *Client }

// Complete runs one model call through the gateway. Needs ai:complete.
func (s *AIService) Complete(ctx context.Context, req CompleteRequest) (*CompleteResult, error) {
	req.Stream, req.App = false, s.c.appOr(req.App)
	var out CompleteResult
	return &out, s.c.json(ctx, "ai.complete", call{body: req}, &out)
}

// Stream runs the same call as a stream. onDelta is called with each piece of
// text as it arrives; the full result is returned at the end. It returns an
// *Error if the stream reports one or ends before it is done. A stream is not
// retried.
func (s *AIService) Stream(ctx context.Context, req CompleteRequest, onDelta func(text string)) (*CompleteResult, error) {
	req.Stream, req.App = true, s.c.appOr(req.App)
	var out CompleteResult
	if err := s.c.streamEvents(ctx, "ai.complete", req, onDelta, &out); err != nil {
		return nil, err
	}
	return &out, nil
}

// streamEvents reads a streamed route's server-sent events: onDelta for each
// delta frame, then the done frame into out, or the error frame as an *Error.
func (c *Client) streamEvents(ctx context.Context, route string, body any, onDelta func(text string), out any) error {
	res, err := c.send(ctx, route, call{body: body, headers: map[string]string{"Accept": "text/event-stream"}, noRetry: true})
	if err != nil {
		return err
	}
	defer res.Body.Close()
	// This response's own id: Last may already belong to another call.
	requestID := res.Header.Get("X-Request-Id")
	fail := func(code, msg string) *Error {
		return &Error{Status: res.StatusCode, Code: code, Message: msg, RequestID: requestID}
	}
	done := false
	err = readSSE(res.Body, func(event, data string) (bool, error) {
		switch event {
		case "delta":
			var d struct {
				Text string `json:"text"`
			}
			if err := json.Unmarshal([]byte(data), &d); err != nil {
				return false, fail("STREAM_ERROR", "a delta frame was not JSON")
			}
			if onDelta != nil {
				onDelta(d.Text)
			}
		case "done":
			if err := json.Unmarshal([]byte(data), out); err != nil {
				return false, fail("STREAM_ERROR", "the done frame was not JSON")
			}
			done = true
			return true, nil
		case "error":
			var e struct {
				Code    string `json:"code"`
				Message string `json:"message"`
			}
			_ = json.Unmarshal([]byte(data), &e)
			if e.Code == "" {
				e.Code = "STREAM_ERROR"
			}
			if e.Message == "" {
				e.Message = "the stream failed"
			}
			return false, fail(e.Code, e.Message)
		}
		return false, nil
	})
	if err != nil {
		if ctx.Err() != nil {
			return ctx.Err()
		}
		var apiErr *Error
		if errors.As(err, &apiErr) {
			return apiErr
		}
		return fail("STREAM_ERROR", "the stream broke: "+err.Error())
	}
	if !done {
		return fail("STREAM_ERROR", "the stream ended before it was done")
	}
	return nil
}

// readSSE reads a server-sent event stream, calling fn for each frame until it
// reports done, returns an error, or the stream ends.
func readSSE(r io.Reader, fn func(event, data string) (done bool, err error)) error {
	sc := bufio.NewScanner(r)
	sc.Buffer(make([]byte, 0, 64<<10), 8<<20)
	event, data := "message", []string(nil)
	flush := func() (bool, error) {
		if len(data) == 0 {
			event = "message"
			return false, nil
		}
		done, err := fn(event, strings.Join(data, "\n"))
		event, data = "message", nil
		return done, err
	}
	for sc.Scan() {
		line := strings.TrimRight(sc.Text(), "\r")
		switch {
		case line == "":
			if done, err := flush(); done || err != nil {
				return err
			}
		case strings.HasPrefix(line, "event:"):
			event = strings.TrimSpace(line[6:])
		case strings.HasPrefix(line, "data:"):
			data = append(data, strings.TrimPrefix(line[5:], " "))
		}
	}
	if err := sc.Err(); err != nil {
		return err
	}
	_, err := flush()
	return err
}

// KnowledgeService searches the agent's knowledge base, and reads and writes
// what is in it.
type KnowledgeService struct{ c *Client }

// Search returns the best matching passages. Needs kb:search.
func (s *KnowledgeService) Search(ctx context.Context, query string, opts SearchOptions) ([]Passage, error) {
	body := map[string]any{"query": query}
	if opts.TopK > 0 {
		body["top_k"] = opts.TopK
	}
	if opts.Language != "" {
		body["language"] = opts.Language
	}
	if app := s.c.appOr(opts.App); app != "" {
		body["app"] = app
	}
	var out struct {
		Passages []Passage `json:"passages"`
	}
	return out.Passages, s.c.json(ctx, "knowledge.search", call{body: body}, &out)
}

func itoa(n int) string {
	if n <= 0 {
		return ""
	}
	return strconv.Itoa(n)
}

// ListDocuments returns one page of the knowledge base, newest first, without
// content. Needs kb:read.
func (s *KnowledgeService) ListDocuments(ctx context.Context, opts ListOptions) (*DocumentPage, error) {
	var out DocumentPage
	return &out, s.c.json(ctx, "knowledge.documents.list", call{
		query: map[string]string{"cursor": opts.Cursor, "limit": itoa(opts.Limit), "app": s.c.appOr(opts.App)},
	}, &out)
}

// GetDocument reads one document with its content and how its indexing stands.
// Needs kb:read.
func (s *KnowledgeService) GetDocument(ctx context.Context, id, app string) (*Document, error) {
	var out Document
	return &out, s.c.json(ctx, "knowledge.documents.get", call{path: map[string]string{"id": id}, query: map[string]string{"app": s.c.appOr(app)}}, &out)
}

// CreateDocument adds a document. It is indexed in the background: read it
// again, or wait for kb.updated, to see Index.Status reach ready. Sending a
// document that already exists in every field returns the existing one. Never
// retried by the client. Needs kb:write.
func (s *KnowledgeService) CreateDocument(ctx context.Context, in DocumentInput) (*Document, error) {
	in.App = s.c.appOr(in.App)
	var out Document
	return &out, s.c.json(ctx, "knowledge.documents.create", call{body: in}, &out)
}

// UpdateDocument changes the fields given and indexes the document again.
// The same change sent twice leaves the same document, so the client retries
// it like a read. Needs kb:write.
func (s *KnowledgeService) UpdateDocument(ctx context.Context, id string, patch DocumentPatch) (*Document, error) {
	patch.App = s.c.appOr(patch.App)
	var out Document
	return &out, s.c.json(ctx, "knowledge.documents.update", call{path: map[string]string{"id": id}, body: patch}, &out)
}

// DeleteDocument deletes a document. The agent stops using it. Retried like a
// read: when a retry answers NOT_FOUND, an earlier attempt deleted it. Needs
// kb:write.
func (s *KnowledgeService) DeleteDocument(ctx context.Context, id, app string) error {
	return s.c.json(ctx, "knowledge.documents.delete", call{path: map[string]string{"id": id}, query: map[string]string{"app": s.c.appOr(app)}}, nil)
}

// ImportFile turns a file into a document: PDF, spreadsheet, image or text, at
// most 20 MB. contentType may be empty. Needs kb:write.
func (s *KnowledgeService) ImportFile(ctx context.Context, file []byte, filename, contentType, app string) (*Document, error) {
	if contentType == "" {
		contentType = "application/octet-stream"
	}
	var out Document
	return &out, s.c.json(ctx, "knowledge.import_file", call{
		raw:     file,
		query:   map[string]string{"filename": filename, "app": s.c.appOr(app)},
		headers: map[string]string{"Content-Type": contentType},
	}, &out)
}

// ListSources returns the websites the knowledge base is crawled from. Needs
// kb:read.
func (s *KnowledgeService) ListSources(ctx context.Context, app string) ([]map[string]any, error) {
	var out struct {
		Sources []map[string]any `json:"sources"`
	}
	return out.Sources, s.c.json(ctx, "knowledge.sources.list", call{query: map[string]string{"app": s.c.appOr(app)}}, &out)
}

// CreateSource adds a website and starts crawling it. Each page becomes a
// document. Needs kb:write.
func (s *KnowledgeService) CreateSource(ctx context.Context, in SourceInput) (map[string]any, error) {
	in.App = s.c.appOr(in.App)
	var out map[string]any
	return out, s.c.json(ctx, "knowledge.sources.create", call{body: in}, &out)
}

// CrawlSource crawls a source again. Needs kb:write.
func (s *KnowledgeService) CrawlSource(ctx context.Context, id, app string) error {
	return s.c.json(ctx, "knowledge.sources.crawl", call{path: map[string]string{"id": id}, query: map[string]string{"app": s.c.appOr(app)}}, nil)
}

// Export returns what changed in the knowledge base after opts.Since, with the
// passages search uses, for keeping your own copy. Follow NextCursor until it
// is empty, then keep Version for the next call. Needs kb:read.
func (s *KnowledgeService) Export(ctx context.Context, opts ExportOptions) (*KnowledgeExport, error) {
	q := map[string]string{"cursor": opts.Cursor, "limit": itoa(opts.Limit), "app": s.c.appOr(opts.App)}
	if opts.Since != nil {
		q["since"] = strconv.FormatInt(*opts.Since, 10)
	}
	var out KnowledgeExport
	return &out, s.c.json(ctx, "knowledge.export", call{query: q}, &out)
}

// AgentService runs the workspace's own agent.
type AgentService struct{ c *Client }

// Turn runs one turn. Needs agent:run. Never retried: a turn may fire a tool.
func (s *AgentService) Turn(ctx context.Context, req AgentTurnRequest) (*AgentTurnResult, error) {
	req.Stream, req.App = false, s.c.appOr(req.App)
	var out AgentTurnResult
	return &out, s.c.json(ctx, "agent.turn", call{body: req}, &out)
}

// Stream runs the same turn as a stream. onDelta is called with each piece of
// the reply as it is written, with the agent's reply markup held back; the
// whole turn is returned at the end, and its text is the one to keep. When
// the agent's settings turn streaming off or redaction on, onDelta is not
// called. It returns an *Error if the stream reports one or ends before it is
// done. A stream is not retried, and an idempotency key does not replay it.
// Needs agent:run.
func (s *AgentService) Stream(ctx context.Context, req AgentTurnRequest, onDelta func(text string)) (*AgentTurnResult, error) {
	req.Stream, req.App = true, s.c.appOr(req.App)
	var out AgentTurnResult
	if err := s.c.streamEvents(ctx, "agent.turn", req, onDelta, &out); err != nil {
		return nil, err
	}
	return &out, nil
}

// Settings returns how the agent runs: its model with the reply cap and
// temperature, the models the plan allows, and the loop switches. app may be
// empty. Needs agent:configure.
func (s *AgentService) Settings(ctx context.Context, app string) (*AgentSettings, error) {
	var out AgentSettings
	return &out, s.c.json(ctx, "agent.settings.get", call{query: map[string]string{"app": s.c.appOr(app)}}, &out)
}

// UpdateSettings changes the model, the reply cap, the temperature or the
// loop switches, and returns the settings after the change. A field left nil
// is left as it is; Clear puts one back to what the agent inherits.
//
// A new model is tested with one real call before it is saved, so allow up to
// 90 seconds. A model off the plan is MODEL_NOT_AVAILABLE; one that did not
// answer is MODEL_NOT_SERVING, and nothing changes. The same change sent
// twice leaves the same settings. Needs agent:configure.
func (s *AgentService) UpdateSettings(ctx context.Context, req AgentSettingsUpdate) (*AgentSettings, error) {
	req.App = s.c.appOr(req.App)
	var out AgentSettings
	return &out, s.c.json(ctx, "agent.settings.update", call{body: req}, &out)
}

// ListMCPServers returns the MCP tool servers the agent may call, newest
// first. A credential is never returned. app may be empty. Needs agent:tools.
//
// These are the servers Omazy's agent calls. c.MCP is the other direction:
// Omazy as an MCP server for your own agent.
func (s *AgentService) ListMCPServers(ctx context.Context, app string) ([]MCPServer, error) {
	var out []MCPServer
	if err := s.c.json(ctx, "agent.mcp_servers.list", call{query: map[string]string{"app": s.c.appOr(app)}}, &out); err != nil {
		return nil, err
	}
	if out == nil {
		out = []MCPServer{} // an agent with no servers
	}
	return out, nil
}

// GetMCPServer returns one of the agent's MCP servers. Needs agent:tools.
func (s *AgentService) GetMCPServer(ctx context.Context, id, app string) (*MCPServer, error) {
	var out MCPServer
	return &out, s.c.json(ctx, "agent.mcp_servers.get", call{path: map[string]string{"id": id}, query: map[string]string{"app": s.c.appOr(app)}}, &out)
}

// CreateMCPServer connects a server. Its tools reach the model from the
// agent's next turn as mcp_<name>__<tool>. The name is unique within the app:
// a second server with it is 409 CONFLICT. The endpoint must be https on a
// public host. Retried only with WithIdempotencyKey. Needs agent:tools.
func (s *AgentService) CreateMCPServer(ctx context.Context, req MCPServerInput) (*MCPServer, error) {
	req.App = s.c.appOr(req.App)
	var out MCPServer
	return &out, s.c.json(ctx, "agent.mcp_servers.create", call{body: req}, &out)
}

// UpdateMCPServer changes a server. A nil field is left as it is. A pointer
// to "" in Credentials removes the stored credential. Needs agent:tools.
func (s *AgentService) UpdateMCPServer(ctx context.Context, id string, req MCPServerUpdate) (*MCPServer, error) {
	req.App = s.c.appOr(req.App)
	var out MCPServer
	return &out, s.c.json(ctx, "agent.mcp_servers.update", call{path: map[string]string{"id": id}, body: req}, &out)
}

// DeleteMCPServer removes a server and its stored credential. Retried like a
// read: when a retry answers NOT_FOUND, an earlier attempt removed it.
func (s *AgentService) DeleteMCPServer(ctx context.Context, id, app string) error {
	return s.c.json(ctx, "agent.mcp_servers.delete", call{path: map[string]string{"id": id}, query: map[string]string{"app": s.c.appOr(app)}}, nil)
}

// VoiceService is speech in both directions, outbound calls and voice tasks.
type VoiceService struct{ c *Client }

// Speak turns text into WAV audio in the agent's voice and reports the language
// spoken. Needs voice:speech.
func (s *VoiceService) Speak(ctx context.Context, text, lang, app string) (wav []byte, spoken string, err error) {
	body := map[string]any{"text": text}
	if lang != "" {
		body["lang"] = lang
	}
	if a := s.c.appOr(app); a != "" {
		body["app"] = a
	}
	res, err := s.c.send(ctx, "voice.speak", call{body: body})
	if err != nil {
		return nil, "", err
	}
	defer res.Body.Close()
	wav, err = io.ReadAll(res.Body)
	return wav, res.Header.Get("X-Omazy-Speech-Lang"), err
}

// Transcribe turns a recording (at most 8 MB) into text. terms are names and
// words to expect, so they come back spelled right. Needs voice:speech.
func (s *VoiceService) Transcribe(ctx context.Context, audio []byte, lang, app string, terms ...string) (text, heard string, err error) {
	var out struct {
		Text     string `json:"text"`
		Language string `json:"language"`
	}
	err = s.c.json(ctx, "voice.transcribe", call{
		raw:     audio,
		query:   map[string]string{"lang": lang, "app": s.c.appOr(app), "terms": joinTerms(terms)},
		headers: map[string]string{"Content-Type": "application/octet-stream"},
	}, &out)
	return out.Text, out.Language, err
}

// PlaceCall queues an outbound call answered by the agent. Needs voice:calls.
// Never retried.
func (s *VoiceService) PlaceCall(ctx context.Context, req CallRequest) (*CallResult, error) {
	req.App = s.c.appOr(req.App)
	var out CallResult
	return &out, s.c.json(ctx, "voice.calls.place", call{body: req}, &out)
}

// GetCall reads where a call stands and what the person answered.
func (s *VoiceService) GetCall(ctx context.Context, ref, app string) (*CallStatus, error) {
	var out CallStatus
	return &out, s.c.json(ctx, "voice.calls.get", call{path: map[string]string{"ref": ref}, query: map[string]string{"app": s.c.appOr(app)}}, &out)
}

// CreateJob starts a background voice task. Needs voice:tasks.
func (s *VoiceService) CreateJob(ctx context.Context, req VoiceJobRequest) (map[string]any, error) {
	// This route reads the app from the query string.
	app := s.c.appOr(req.App)
	req.App = ""
	var out map[string]any
	return out, s.c.json(ctx, "voice.jobs.create", call{body: req, query: map[string]string{"app": app}}, &out)
}

// GetJob reads a voice task and, when it is done, its transcript or notes.
func (s *VoiceService) GetJob(ctx context.Context, id, app string) (map[string]any, error) {
	var out map[string]any
	return out, s.c.json(ctx, "voice.jobs.get", call{path: map[string]string{"id": id}, query: map[string]string{"app": s.c.appOr(app)}}, &out)
}

// CustomersService reads and updates the workspace's customers.
type CustomersService struct{ c *Client }

// Get reads one customer by id. Needs core:read.
func (s *CustomersService) Get(ctx context.Context, id string) (map[string]any, error) {
	var out map[string]any
	return out, s.c.json(ctx, "customers.get", call{path: map[string]string{"id": id}}, &out)
}

// Update merges keys into a customer's custom fields. Needs memory:write.
func (s *CustomersService) Update(ctx context.Context, id string, customFields map[string]any) (map[string]any, error) {
	var out map[string]any
	return out, s.c.json(ctx, "customers.update", call{path: map[string]string{"id": id}, body: map[string]any{"custom_fields": customFields}}, &out)
}

// ConversationsService posts into conversations.
type ConversationsService struct{ c *Client }

// PostMessage posts 1 to 12 blocks into an existing conversation as the app.
// Needs core:write. Never retried.
func (s *ConversationsService) PostMessage(ctx context.Context, id string, blocks []Block) (map[string]any, error) {
	var out map[string]any
	return out, s.c.json(ctx, "conversations.post_message", call{path: map[string]string{"id": id}, body: map[string]any{"blocks": blocks}}, &out)
}

// ChannelsService publishes to connected page channels.
type ChannelsService struct{ c *Client }

// LinkedInPublish publishes a post to the connected LinkedIn page. Needs
// channels:publish. Never retried.
func (s *ChannelsService) LinkedInPublish(ctx context.Context, text, app string) (map[string]any, error) {
	body := map[string]any{"text": text}
	if a := s.c.appOr(app); a != "" {
		body["app"] = a
	}
	var out map[string]any
	return out, s.c.json(ctx, "channels.linkedin_publish", call{body: body}, &out)
}

// SessionsService binds a signed-in user's own tool credential to their chat
// session, so the agent calls the product's tools as that user.
type SessionsService struct{ c *Client }

// BindCredential needs sessions:credentials.
func (s *SessionsService) BindCredential(ctx context.Context, sessionID, server string, b CredentialBinding) (map[string]any, error) {
	var out map[string]any
	return out, s.c.json(ctx, "sessions.bind_credential", call{path: map[string]string{"sid": sessionID, "server": server}, body: b}, &out)
}

// UnbindCredential removes the binding.
func (s *SessionsService) UnbindCredential(ctx context.Context, sessionID, server string) error {
	return s.c.json(ctx, "sessions.unbind_credential", call{path: map[string]string{"sid": sessionID, "server": server}}, nil)
}

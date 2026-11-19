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
	Version = "0.1.0"
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
	return c
}

// Last returns the headers of the most recent response.
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
		return &Error{Status: res.StatusCode, Code: "BAD_RESPONSE", Message: "the response was not JSON: " + err.Error(), RequestID: c.Last().RequestID}
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
	if c.token == "" {
		return nil, errors.New("omazy: token is required")
	}
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
	attempts := 0
	if retryable[name] && !in.noRetry {
		attempts = c.maxRetries
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
			return nil, &Error{Code: "NETWORK_ERROR", Message: "no response from the Core API: " + err.Error()}
		}
		info := readInfo(res.Header)
		c.mu.Lock()
		c.last = info
		c.mu.Unlock()
		if res.StatusCode >= 200 && res.StatusCode < 300 {
			return res, nil
		}
		apiErr := readError(res, info.RequestID)
		res.Body.Close()
		transient := res.StatusCode == 429 || res.StatusCode == 502 || res.StatusCode == 503 || res.StatusCode == 504
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
	res, err := s.c.send(ctx, "ai.complete", call{body: req, headers: map[string]string{"Accept": "text/event-stream"}, noRetry: true})
	if err != nil {
		return nil, err
	}
	defer res.Body.Close()
	requestID := s.c.Last().RequestID
	fail := func(code, msg string) *Error {
		return &Error{Status: res.StatusCode, Code: code, Message: msg, RequestID: requestID}
	}
	var out *CompleteResult
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
			out = &CompleteResult{}
			if err := json.Unmarshal([]byte(data), out); err != nil {
				return false, fail("STREAM_ERROR", "the done frame was not JSON")
			}
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
			return nil, ctx.Err()
		}
		var apiErr *Error
		if errors.As(err, &apiErr) {
			return nil, apiErr
		}
		return nil, fail("STREAM_ERROR", "the stream broke: "+err.Error())
	}
	if out == nil {
		return nil, fail("STREAM_ERROR", "the stream ended before it was done")
	}
	return out, nil
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

// KnowledgeService searches the agent's knowledge base.
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

// AgentService runs the workspace's own agent.
type AgentService struct{ c *Client }

// Turn runs one turn. Needs agent:run. Never retried: a turn may fire a tool.
func (s *AgentService) Turn(ctx context.Context, req AgentTurnRequest) (*AgentTurnResult, error) {
	req.App = s.c.appOr(req.App)
	var out AgentTurnResult
	return &out, s.c.json(ctx, "agent.turn", call{body: req}, &out)
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

// Transcribe turns a recording (at most 8 MB) into text. Needs voice:speech.
func (s *VoiceService) Transcribe(ctx context.Context, audio []byte, lang, app string) (text, heard string, err error) {
	var out struct {
		Text     string `json:"text"`
		Language string `json:"language"`
	}
	err = s.c.json(ctx, "voice.transcribe", call{
		raw:     audio,
		query:   map[string]string{"lang": lang, "app": s.c.appOr(app)},
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
	req.App = s.c.appOr(req.App)
	var out map[string]any
	return out, s.c.json(ctx, "voice.jobs.create", call{body: req}, &out)
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

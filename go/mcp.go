package omazy

import (
	"context"
	"encoding/json"
	"strconv"
	"strings"
	"sync/atomic"
)

// MCPService is the Core API's MCP server (POST /mcp), for a caller that would
// sooner speak the Model Context Protocol than REST. The tools are the Core
// verbs this token's scopes allow, and a call spends the same limits its route
// does. To hand the server to an MCP client of your own, use Config.
type MCPService struct {
	c  *Client
	id atomic.Int64
}

// MCPConfig is what an MCP client needs to connect over Streamable HTTP.
type MCPConfig struct {
	Type    string            `json:"type"`
	URL     string            `json:"url"`
	Headers map[string]string `json:"headers"`
}

// Config returns the URL and headers an MCP client needs to connect.
func (s *MCPService) Config() MCPConfig {
	return MCPConfig{Type: "http", URL: s.c.base + routes["mcp"].path, Headers: map[string]string{"Authorization": "Bearer " + s.c.token}}
}

// MCPTool is one tool the server offers this token.
type MCPTool struct {
	Name        string          `json:"name"`
	Title       string          `json:"title,omitempty"`
	Description string          `json:"description,omitempty"`
	InputSchema json.RawMessage `json:"inputSchema"`
	Annotations map[string]any  `json:"annotations,omitempty"`
}

// MCPToolResult is a tool's answer.
type MCPToolResult struct {
	// Text is the answer as text (JSON for most tools).
	Text string
	// Data is the same answer as an object, when the tool returned one.
	Data map[string]any
	// IsError is true when the tool refused or failed. Text then says why.
	IsError bool
}

func (s *MCPService) rpc(ctx context.Context, method string, params, out any) error {
	msg := map[string]any{"jsonrpc": "2.0", "id": s.id.Add(1), "method": method}
	if params != nil {
		msg["params"] = params
	}
	res, err := s.c.send(ctx, "mcp", call{body: msg})
	if err != nil {
		return err
	}
	defer res.Body.Close()
	var env struct {
		Result json.RawMessage `json:"result"`
		Error  *struct {
			Code    int    `json:"code"`
			Message string `json:"message"`
		} `json:"error"`
	}
	if err := json.NewDecoder(res.Body).Decode(&env); err != nil {
		return &Error{Status: res.StatusCode, Code: "MCP_BAD_RESPONSE", Message: "the server did not answer with JSON-RPC"}
	}
	if env.Error != nil {
		return &Error{Status: res.StatusCode, Code: "MCP_" + strconv.Itoa(env.Error.Code), Message: env.Error.Message}
	}
	if len(env.Result) == 0 {
		return &Error{Status: res.StatusCode, Code: "MCP_BAD_RESPONSE", Message: "the server did not answer with a JSON-RPC result"}
	}
	if out == nil {
		return nil
	}
	return json.Unmarshal(env.Result, out)
}

// Initialize returns the server's name, version and instructions.
func (s *MCPService) Initialize(ctx context.Context) (map[string]any, error) {
	var out map[string]any
	return out, s.rpc(ctx, "initialize", map[string]any{
		"protocolVersion": "2025-06-18", "capabilities": map[string]any{},
		"clientInfo": map[string]any{"name": "omazy-go", "version": Version},
	}, &out)
}

// ListTools returns the tools this token may call.
func (s *MCPService) ListTools(ctx context.Context) ([]MCPTool, error) {
	var out struct {
		Tools []MCPTool `json:"tools"`
	}
	return out.Tools, s.rpc(ctx, "tools/list", nil, &out)
}

// CallTool calls a tool. A refusal (a bad argument, a spent budget, a rate
// limit) is returned with IsError set, as the protocol does, and is not an
// error. An unknown tool is an *Error.
func (s *MCPService) CallTool(ctx context.Context, name string, args map[string]any) (*MCPToolResult, error) {
	if args == nil {
		args = map[string]any{}
	}
	var r struct {
		Content []struct {
			Text string `json:"text"`
		} `json:"content"`
		StructuredContent map[string]any `json:"structuredContent"`
		IsError           bool           `json:"isError"`
	}
	if err := s.rpc(ctx, "tools/call", map[string]any{"name": name, "arguments": args}, &r); err != nil {
		return nil, err
	}
	var b strings.Builder
	for _, c := range r.Content {
		b.WriteString(c.Text)
	}
	return &MCPToolResult{Text: b.String(), Data: r.StructuredContent, IsError: r.IsError}, nil
}

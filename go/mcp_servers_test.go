package omazy

import (
	"errors"
	"testing"
)

const serverJSON = `{"id":"s1","name":"front-desk","endpoint_url":"https://tools.test/mcp","auth_type":"bearer",` +
	`"allowed_tools":[],"is_active":true,"write_mode":"confirm","action_policy":{},"has_credentials":true}`

func TestCreateMCPServerSendsTheCredentialOnce(t *testing.T) {
	f, c := newFake(t, ok(serverJSON))
	c.app = "acme"
	made, err := c.Agent.CreateMCPServer(WithIdempotencyKey(ctx, "tenant-42-front-desk"), MCPServerInput{
		Name: "front-desk", EndpointURL: "https://tools.test/mcp", AuthType: "bearer", Credentials: "s3cret", AllowedTools: []string{"lookup"},
	})
	if err != nil {
		t.Fatal(err)
	}
	if !made.HasCredentials || made.Name != "front-desk" || made.WriteMode != "confirm" || string(made.ActionPolicy) != "{}" {
		t.Fatalf("server: %+v", made)
	}
	s := f.seen[0]
	if s.method != "POST" || s.path != "/core/agent/mcp-servers" || s.key != "tenant-42-front-desk" {
		t.Fatalf("request: %+v", s)
	}
	// Fields that were not given are left out.
	if want := `{"app":"acme","name":"front-desk","endpoint_url":"https://tools.test/mcp","auth_type":"bearer","credentials":"s3cret","allowed_tools":["lookup"]}`; s.body != want {
		t.Fatalf("body:\n got %s\nwant %s", s.body, want)
	}
}

func TestACreateIsSentAgainOnlyWithAKey(t *testing.T) {
	in := MCPServerInput{Name: "a", EndpointURL: "https://a.test/mcp", AuthType: "none"}
	f, c := newFake(t, fail(503, "UPSTREAM_UNAVAILABLE", "try again"), ok(serverJSON))
	if _, err := c.Agent.CreateMCPServer(ctx, in); err == nil || len(f.seen) != 1 {
		t.Fatalf("without a key: %v, sent %d times", err, len(f.seen))
	}
	f, c = newFake(t, fail(503, "UPSTREAM_UNAVAILABLE", "try again"), ok(serverJSON))
	if _, err := c.Agent.CreateMCPServer(WithIdempotencyKey(ctx, "k1"), in); err != nil || len(f.seen) != 2 || f.seen[1].key != "k1" {
		t.Fatalf("with a key: %v, sent %d times", err, len(f.seen))
	}
}

func TestMCPServerReadsAndDeleteNameTheAppInTheQuery(t *testing.T) {
	f, c := newFake(t, ok("["+serverJSON+"]"), ok(serverJSON), ok(`{"id":"s1","deleted":true}`))
	c.app = "acme"
	rows, err := c.Agent.ListMCPServers(ctx, "")
	if err != nil || len(rows) != 1 || rows[0].Name != "front-desk" {
		t.Fatalf("list: %+v %v", rows, err)
	}
	if _, err := c.Agent.GetMCPServer(ctx, "s 1", ""); err != nil {
		t.Fatal(err)
	}
	if err := c.Agent.DeleteMCPServer(ctx, "s1", ""); err != nil {
		t.Fatal(err)
	}
	if f.seen[0].path != "/core/agent/mcp-servers?app=acme" || f.seen[1].path != "/core/agent/mcp-servers/s%201?app=acme" ||
		f.seen[2].method != "DELETE" || f.seen[2].path != "/core/agent/mcp-servers/s1?app=acme" {
		t.Fatalf("requests: %+v", f.seen)
	}
	// An agent with no servers is an empty slice, not nil.
	_, c = newFake(t, ok("null"))
	if rows, err := c.Agent.ListMCPServers(ctx, ""); err != nil || rows == nil || len(rows) != 0 {
		t.Fatalf("no servers: %#v %v", rows, err)
	}
}

func TestUpdateMCPServerSendsOnlyWhatChanges(t *testing.T) {
	f, c := newFake(t, ok(serverJSON))
	empty, none, off := "", []string{}, false
	if _, err := c.Agent.UpdateMCPServer(ctx, "s1", MCPServerUpdate{Credentials: &empty, AllowedTools: &none, IsActive: &off}); err != nil {
		t.Fatal(err)
	}
	// An empty credential removes the stored one, an empty list allows every tool.
	if f.seen[0].method != "PATCH" || f.seen[0].body != `{"credentials":"","allowed_tools":[],"is_active":false}` {
		t.Fatalf("request: %+v", f.seen[0])
	}
}

func TestAChangeToAnMCPServerAndARemovalAreSentAgain(t *testing.T) {
	on := true
	f, c := newFake(t, fail(503, "UPSTREAM_UNAVAILABLE", "try again"), ok(serverJSON))
	if _, err := c.Agent.UpdateMCPServer(ctx, "s1", MCPServerUpdate{IsActive: &on}); err != nil || len(f.seen) != 2 {
		t.Fatalf("a change: %v, sent %d times", err, len(f.seen))
	}
	f, c = newFake(t, fail(503, "UPSTREAM_UNAVAILABLE", "try again"), ok(`{"id":"s1","deleted":true}`))
	if err := c.Agent.DeleteMCPServer(ctx, "s1", ""); err != nil || len(f.seen) != 2 {
		t.Fatalf("a removal: %v, sent %d times", err, len(f.seen))
	}
	// The first removal went through but its answer was lost: the retry is told NOT_FOUND.
	f, c = newFake(t, fail(502, "BAD_GATEWAY", "lost"), fail(404, "NOT_FOUND", "MCP server not found"))
	var apiErr *Error
	if err := c.Agent.DeleteMCPServer(ctx, "s1", ""); !errors.As(err, &apiErr) || apiErr.Code != "NOT_FOUND" || len(f.seen) != 2 {
		t.Fatalf("a lost removal: %v, sent %d times", err, len(f.seen))
	}
}

func TestAnMCPServerNameTheAppUsesIsAConflict(t *testing.T) {
	_, c := newFake(t, fail(409, "CONFLICT", "this app already has an MCP server named front-desk"))
	_, err := c.Agent.CreateMCPServer(ctx, MCPServerInput{Name: "front-desk", EndpointURL: "https://a.test/mcp", AuthType: "none"})
	var apiErr *Error
	if !errors.As(err, &apiErr) || apiErr.Status != 409 || apiErr.Code != "CONFLICT" {
		t.Fatalf("error: %v", err)
	}
}

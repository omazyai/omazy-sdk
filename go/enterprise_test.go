package omazy

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"os"
	"strings"
	"testing"
	"time"
)

func newEnterpriseFake(t *testing.T, answers ...func(http.ResponseWriter, *http.Request)) (*fakeAPI, *EnterpriseClient) {
	t.Helper()
	f, _ := newFake(t, answers...)
	e := NewEnterprise("eak_abc.def", WithBaseURL(f.srv.URL+"/enterprise"))
	e.c.sleep = func(context.Context, time.Duration) error { return nil }
	return f, e
}

func readEnterpriseContract(t *testing.T) []struct {
	Method, Path, SDK string
	Repeatable        bool
} {
	t.Helper()
	b, err := os.ReadFile("../contracts/enterprise-api.routes.json")
	if err != nil {
		b, err = os.ReadFile("../../contracts/enterprise-api.routes.json")
	}
	if err != nil {
		t.Fatal(err)
	}
	var doc struct {
		Routes []struct {
			Method, Path, SDK string
			Repeatable        bool
		}
	}
	if err := json.Unmarshal(b, &doc); err != nil {
		t.Fatal(err)
	}
	return doc.Routes
}

const workspaceJSON = `{"id":"w1","external_id":"cust-1","handle":"acme","name":"Acme","status":"active","plan":"enterprise_sovereign","app":{"id":"a1","handle":"acme"}}`

func page(next string, ids ...string) func(http.ResponseWriter, *http.Request) {
	return func(w http.ResponseWriter, _ *http.Request) {
		rows := make([]string, len(ids))
		for i, id := range ids {
			rows[i] = strings.Replace(workspaceJSON, `"id":"w1"`, `"id":"`+id+`"`, 1)
		}
		body := `{"success":true,"data":[` + strings.Join(rows, ",") + `]`
		if next != "" {
			body += `,"meta":{"next_cursor":"` + next + `"}`
		}
		_, _ = io.WriteString(w, body+"}")
	}
}

func TestEnterpriseRouteTableIsTheContract(t *testing.T) {
	contract := readEnterpriseContract(t)
	if len(contract) != len(enterpriseRoutes) {
		t.Errorf("the contract has %d routes, the client %d", len(contract), len(enterpriseRoutes))
	}
	repeatable := 0
	for _, r := range contract {
		got, ok := enterpriseRoutes[r.SDK]
		if !ok || got.method != r.Method || got.path != r.Path {
			t.Errorf("%s: client has %+v, contract says %s %s", r.SDK, got, r.Method, r.Path)
		}
		if enterpriseRepeatable[r.SDK] != r.Repeatable {
			t.Errorf("%s: repeatable in the client is %v, in the contract %v", r.SDK, enterpriseRepeatable[r.SDK], r.Repeatable)
		}
		if r.Repeatable {
			repeatable++
		}
	}
	if repeatable != len(enterpriseRepeatable) {
		t.Errorf("the client marks %d routes repeatable, the contract %d", len(enterpriseRepeatable), repeatable)
	}
}

func TestEveryEnterpriseRouteIsReachableThroughAMethod(t *testing.T) {
	f, e := newEnterpriseFake(t, ok(`{}`))
	name := "Acme Ltd"
	_, _ = e.Account(ctx)
	_, _ = e.ListWorkspaces(ctx, ListWorkspacesQuery{})
	_, _ = e.CreateWorkspace(ctx, CreateWorkspaceRequest{ExternalID: "cust-1", Name: "Acme"})
	_, _ = e.GetWorkspace(ctx, "w1")
	_, _ = e.UpdateWorkspace(ctx, "w1", UpdateWorkspaceRequest{Name: &name})
	_, _ = e.CloseWorkspace(ctx, "w1")
	_, _ = e.RotateInstall(ctx, "w1", RotateInstallRequest{})
	_, _ = e.Usage(ctx, AccountUsageQuery{})
	used := map[string]bool{}
	for _, s := range f.seen {
		p := strings.Replace(strings.TrimPrefix(strings.SplitN(s.path, "?", 2)[0], "/enterprise"), "/w1", "/{id}", 1)
		used[s.method+" "+p] = true
	}
	for name, r := range enterpriseRoutes {
		if !used[r.method+" "+r.path] {
			t.Errorf("no method reaches %s (%s %s)", name, r.method, r.path)
		}
	}
}

func TestCreateWorkspaceSendsTheAccountKeyAndTheBody(t *testing.T) {
	f, e := newEnterpriseFake(t, ok(`{"created":true,"workspace":`+workspaceJSON+`,"install":{"id":"i1","slug":"joya","scopes":["kb:read"],"token_prefix":"cai_x"},"token":"cai_x.y"}`,
		"X-Request-Id", "req_1", "X-Omazy-Token-Expires-At", "2027-01-01T00:00:00Z"))
	made, err := e.CreateWorkspace(ctx, CreateWorkspaceRequest{ExternalID: "cust-1", Name: "Acme", BrandColor: "#0A3D62"})
	if err != nil {
		t.Fatal(err)
	}
	if !made.Created || made.Token != "cai_x.y" || made.Install == nil || made.Install.Slug != "joya" ||
		made.Workspace.App == nil || made.Workspace.App.Handle != "acme" || made.Workspace.Plan != "enterprise_sovereign" {
		t.Fatalf("result: %+v", made)
	}
	s := f.seen[0]
	if s.method != "POST" || s.path != "/enterprise/workspaces" || s.auth != "Bearer eak_abc.def" {
		t.Fatalf("request: %+v", s)
	}
	if s.body != `{"external_id":"cust-1","name":"Acme","brand_color":"#0A3D62"}` {
		t.Fatalf("fields that were not given are left out: %s", s.body)
	}
	if last := e.Last(); last.RequestID != "req_1" || last.TokenExpiresAt != "2027-01-01T00:00:00Z" {
		t.Fatalf("last: %+v", last)
	}
}

func TestARepeatedCreateHasNoTokenAndNoInstallIsNil(t *testing.T) {
	_, e := newEnterpriseFake(t, ok(`{"created":false,"workspace":`+workspaceJSON+`,"install":null,"token":null}`))
	made, err := e.CreateWorkspace(ctx, CreateWorkspaceRequest{ExternalID: "cust-1", Name: "Acme"})
	if err != nil || made.Created || made.Token != "" || made.Install != nil || made.Workspace.ID != "w1" {
		t.Fatalf("result: %+v %v", made, err)
	}
}

func TestCreateIsSentAgainAfterAFailureAndRotateIsNot(t *testing.T) {
	f, e := newEnterpriseFake(t, fail(503, "UPSTREAM_UNAVAILABLE", "try again"), fail(502, "BAD_GATEWAY", "try again"),
		ok(`{"created":false,"workspace":`+workspaceJSON+`}`))
	if _, err := e.CreateWorkspace(ctx, CreateWorkspaceRequest{ExternalID: "cust-1", Name: "Acme"}); err != nil {
		t.Fatal(err)
	}
	if len(f.seen) != 3 || f.seen[0].body != f.seen[2].body {
		t.Fatalf("create should be sent three times with the same body: %+v", f.seen)
	}

	f, e = newEnterpriseFake(t, fail(503, "UPSTREAM_UNAVAILABLE", "try again"), ok(`{"install":{},"token":"cai_n.new"}`))
	var apiErr *Error
	if _, err := e.RotateInstall(ctx, "w1", RotateInstallRequest{}); !errors.As(err, &apiErr) || apiErr.Status != 503 {
		t.Fatalf("rotate: %v", err)
	}
	if len(f.seen) != 1 {
		t.Fatalf("a rotation was sent %d times", len(f.seen))
	}
}

func TestListReadsAPageAndAllWalksEveryPage(t *testing.T) {
	f, e := newEnterpriseFake(t, page("c1", "w3", "w2"), page("", "w1"))
	var got []string
	if err := e.AllWorkspaces(ctx, ListWorkspacesQuery{Status: WorkspaceActive, Limit: 2}, func(w ManagedWorkspace) bool {
		got = append(got, w.ID)
		return true
	}); err != nil {
		t.Fatal(err)
	}
	if strings.Join(got, ",") != "w3,w2,w1" {
		t.Fatalf("workspaces: %v", got)
	}
	if f.seen[0].path != "/enterprise/workspaces?limit=2&status=active" || f.seen[1].path != "/enterprise/workspaces?cursor=c1&limit=2&status=active" {
		t.Fatalf("requests: %s then %s", f.seen[0].path, f.seen[1].path)
	}

	// Stopping early asks for no further page.
	f, e = newEnterpriseFake(t, page("c1", "w3", "w2"), page("", "w1"))
	_ = e.AllWorkspaces(ctx, ListWorkspacesQuery{}, func(ManagedWorkspace) bool { return false })
	if len(f.seen) != 1 {
		t.Fatalf("after fn returned false: %d requests", len(f.seen))
	}

	f, e = newEnterpriseFake(t, page("", "w9"))
	first, err := e.ListWorkspaces(ctx, ListWorkspacesQuery{})
	if err != nil || len(first.Workspaces) != 1 || first.NextCursor != "" || f.seen[0].path != "/enterprise/workspaces" {
		t.Fatalf("one page: %+v %v %s", first, err, f.seen[0].path)
	}
}

func TestFindWorkspaceByExternalID(t *testing.T) {
	f, e := newEnterpriseFake(t, page("", "w1"))
	w, err := e.FindWorkspaceByExternalID(ctx, "cust-1")
	if err != nil || w == nil || w.ID != "w1" || f.seen[0].path != "/enterprise/workspaces?external_id=cust-1" {
		t.Fatalf("found: %+v %v %s", w, err, f.seen[0].path)
	}
	_, e = newEnterpriseFake(t, page(""))
	if w, err := e.FindWorkspaceByExternalID(ctx, "nobody"); err != nil || w != nil {
		t.Fatalf("nobody: %+v %v", w, err)
	}
}

func TestSuspendResumeAndRotateSendWhatTheAPIReads(t *testing.T) {
	f, e := newEnterpriseFake(t, ok(workspaceJSON))
	zero, ninety := 0, 90
	_, _ = e.SuspendWorkspace(ctx, "w 1")
	_, _ = e.ResumeWorkspace(ctx, "w1")
	_, _ = e.RotateInstall(ctx, "w1", RotateInstallRequest{OverlapHours: &zero, ExpiresInDays: &ninety})
	_, _ = e.RotateInstall(ctx, "w1", RotateInstallRequest{})
	s := f.seen
	if s[0].method != "PATCH" || s[0].path != "/enterprise/workspaces/w%201" || s[0].body != `{"status":"suspended"}` {
		t.Fatalf("suspend: %+v", s[0])
	}
	if s[1].body != `{"status":"active"}` {
		t.Fatalf("resume: %+v", s[1])
	}
	// A zero is a value, not a missing field: it cuts the old token off.
	if s[2].path != "/enterprise/workspaces/w1/install/rotate" || s[2].body != `{"overlap_hours":0,"expires_in_days":90}` {
		t.Fatalf("rotate: %+v", s[2])
	}
	if s[3].body != `{}` {
		t.Fatalf("rotate with defaults: %+v", s[3])
	}
}

func TestAnEnterpriseRefusalCarriesTheCode(t *testing.T) {
	_, e := newEnterpriseFake(t, fail(409, "WORKSPACE_LIMIT_REACHED", "the account has reached its limit of managed workspaces", "X-Request-Id", "req_9"))
	_, err := e.CreateWorkspace(ctx, CreateWorkspaceRequest{ExternalID: "c", Name: "n"})
	var apiErr *Error
	if !errors.As(err, &apiErr) || apiErr.Status != 409 || apiErr.Code != "WORKSPACE_LIMIT_REACHED" || apiErr.RequestID != "req_9" {
		t.Fatalf("error: %v", err)
	}
}

func TestCoreGivesACoreClientForOneCustomerOnTheSameDeployment(t *testing.T) {
	f, e := newEnterpriseFake(t, ok(`{"passages":[]}`))
	tenant := e.Core("cai_tenant.secret")
	if _, err := tenant.Whoami(ctx); err != nil {
		t.Fatal(err)
	}
	if f.seen[0].path != "/core/whoami" || f.seen[0].auth != "Bearer cai_tenant.secret" {
		t.Fatalf("request: %+v", f.seen[0])
	}
	if _, err := e.Core("cai_tenant.secret", WithApp("desk")).Knowledge.Search(ctx, "hours", SearchOptions{}); err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(f.seen[1].body, `"app":"desk"`) {
		t.Fatalf("the default app of the customer's client: %s", f.seen[1].body)
	}
	// The account key is never sent to the Core API.
	for _, s := range f.seen {
		if strings.Contains(s.auth, "eak_") {
			t.Fatalf("the account key reached the Core API: %+v", s)
		}
	}
	// Away from a base that ends in /enterprise, the Core client uses production.
	if got := NewEnterprise("eak_a.b", WithBaseURL("https://proxy.test/omazy")).Core("cai_a.b").base; got != DefaultBaseURL {
		t.Fatalf("core base: %s", got)
	}
	if got := NewEnterprise("eak_a.b").Core("cai_a.b").base; got != DefaultBaseURL {
		t.Fatalf("default core base: %s", got)
	}
}

func TestAnEnterpriseClientWithoutAKeyRefuses(t *testing.T) {
	if _, err := NewEnterprise("").Account(ctx); err == nil || !strings.Contains(err.Error(), "token is required") {
		t.Fatalf("error: %v", err)
	}
}

func TestAccountUsage(t *testing.T) {
	f, e := newEnterpriseFake(t, func(w http.ResponseWriter, _ *http.Request) {
		_, _ = io.WriteString(w, `{"success":true,"data":{"from":"2026-11-21","to":"2026-11-23","totals":{"model_calls":9},"workspaces":[]},"meta":{"next_cursor":"c2"}}`)
	})
	got, err := e.Usage(ctx, AccountUsageQuery{From: "2026-11-21", To: "2026-11-23", Limit: 2})
	if err != nil {
		t.Fatal(err)
	}
	if got.Totals.ModelCalls != 9 || got.NextCursor != "c2" || got.From != "2026-11-21" {
		t.Fatalf("usage: %+v", got)
	}
	if f.seen[0].path != "/enterprise/usage?from=2026-11-21&limit=2&to=2026-11-23" {
		t.Fatalf("request: %+v", f.seen[0])
	}
}

package omazy

import (
	"context"
	"encoding/json"
	"net/http"
	"strconv"
	"strings"
)

// DefaultEnterpriseBaseURL is the production Enterprise API.
const DefaultEnterpriseBaseURL = "https://mw.omazy.ai/api/v1/enterprise"

// enterpriseRoutes is every Enterprise API route this client covers, keyed by
// the name the contract gives it (contracts/enterprise-api.routes.json). The
// tests hold the table to the contract.
var enterpriseRoutes = map[string]route{
	"account":                   {"GET", "/account"},
	"workspaces.list":           {"GET", "/workspaces"},
	"workspaces.create":         {"POST", "/workspaces"},
	"workspaces.get":            {"GET", "/workspaces/{id}"},
	"workspaces.update":         {"PATCH", "/workspaces/{id}"},
	"workspaces.close":          {"DELETE", "/workspaces/{id}"},
	"workspaces.rotate_install": {"POST", "/workspaces/{id}/install/rotate"},
	"usage":                     {"GET", "/usage"},
}

// enterpriseRepeatable is the routes the client sends again after a 429, a
// gateway error or a dropped connection. Creating a workspace is one of them:
// ExternalID names the customer, so a second request finds the workspace the
// first one made. Rotating a token is not: each run replaces the token before
// it.
var enterpriseRepeatable = map[string]bool{
	"account":           true,
	"workspaces.list":   true,
	"workspaces.create": true,
	"workspaces.get":    true,
	"workspaces.update": true,
	"workspaces.close":  true,
	"usage":             true,
}

// Account scopes.
const (
	ScopeWorkspacesManage = "workspaces:manage"
	ScopeInstallsManage   = "installs:manage"
	ScopeUsageRead        = "usage:read"
)

// Managed workspace statuses.
const (
	WorkspaceActive    = "active"
	WorkspaceSuspended = "suspended"
	WorkspaceClosed    = "closed"
)

// EnterpriseAccount is the account behind a key, and the key.
type EnterpriseAccount struct {
	Account struct {
		ID              string  `json:"id"`
		Slug            string  `json:"slug"`
		Name            string  `json:"name"`
		Status          string  `json:"status"`
		HomeWorkspaceID *string `json:"home_workspace_id"`
		// Limits the account sets. Zero means no cap from the account.
		Limits struct {
			ManagedWorkspaces int `json:"managed_workspaces"`
			SeatsPerWorkspace int `json:"seats_per_workspace"`
		} `json:"limits"`
		// ManagedWorkspaces is how many workspaces the account manages now.
		// Closed ones are not counted.
		ManagedWorkspaces int    `json:"managed_workspaces"`
		CreatedAt         string `json:"created_at"`
	} `json:"account"`
	// Key is the key the request was made with.
	Key struct {
		ID          string   `json:"id"`
		Name        string   `json:"name"`
		TokenPrefix string   `json:"token_prefix"`
		Scopes      []string `json:"scopes"`
		State       string   `json:"state"`
		ExpiresAt   *string  `json:"expires_at"`
		LastUsedAt  *string  `json:"last_used_at"`
		CreatedAt   string   `json:"created_at"`
	} `json:"key"`
}

// ManagedWorkspace is the workspace of one of your customers.
type ManagedWorkspace struct {
	ID string `json:"id"`
	// ExternalID is your own id for the customer.
	ExternalID string  `json:"external_id"`
	Handle     string  `json:"handle"`
	Name       string  `json:"name"`
	Status     string  `json:"status"`
	BrandColor *string `json:"brand_color"`
	LogoURL    *string `json:"logo_url"`
	// Plan the workspace runs on, "" when it has none.
	Plan string `json:"plan"`
	// App is the workspace's agent app, the one its install token speaks for.
	App *struct {
		ID     string `json:"id"`
		Handle string `json:"handle"`
	} `json:"app"`
	CreatedAt string `json:"created_at"`
	UpdatedAt string `json:"updated_at"`
}

// ManagedInstall is the install of a managed workspace. Its token is the Core
// API token for that customer.
type ManagedInstall struct {
	ID          string   `json:"id"`
	Slug        string   `json:"slug"`
	Scopes      []string `json:"scopes"`
	TokenPrefix string   `json:"token_prefix"`
	ExpiresAt   *string  `json:"expires_at"`
	// PreviousTokenExpiresAt is when the token a rotation replaced stops
	// working. Nil when none is live.
	PreviousTokenExpiresAt *string `json:"previous_token_expires_at"`
}

// CreateWorkspaceRequest describes the workspace of one customer.
type CreateWorkspaceRequest struct {
	// ExternalID is your own id for the customer: 1 to 128 letters, digits
	// and . _ : -. The same id always names the same workspace, so the call is
	// safe to repeat.
	ExternalID string `json:"external_id"`
	Name       string `json:"name"`
	// Handle is 3 to 32 of a-z, 0-9 and hyphen. Left empty, one is made from
	// the name.
	Handle string `json:"handle,omitempty"`
	// BrandColor is #RRGGBB.
	BrandColor string `json:"brand_color,omitempty"`
	LogoURL    string `json:"logo_url,omitempty"`
}

// CreateWorkspaceResult is the answer to CreateWorkspace.
type CreateWorkspaceResult struct {
	// Created is false when the customer's workspace already existed.
	Created   bool             `json:"created"`
	Workspace ManagedWorkspace `json:"workspace"`
	// Install is nil when the key may not manage installs: the workspace was
	// made without one.
	Install *ManagedInstall `json:"install"`
	// Token is the install token, a Core API token for this customer. It is
	// set once, on the call that minted it. Store it then. If it is lost,
	// rotate.
	Token string `json:"token"`
}

// ListWorkspacesQuery filters and pages the account's workspaces.
type ListWorkspacesQuery struct {
	// Status is active, suspended or closed. Empty is all.
	Status string
	// ExternalID returns only the workspace of this customer, if any.
	ExternalID string
	// Limit is 1 to 200. Zero takes the default of 50.
	Limit  int
	Cursor string
}

// WorkspacePage is one page of workspaces, newest first.
type WorkspacePage struct {
	Workspaces []ManagedWorkspace
	// NextCursor goes into the next query. Empty on the last page.
	NextCursor string
}

// UpdateWorkspaceRequest changes a workspace. A nil field is left as it is.
type UpdateWorkspaceRequest struct {
	Name       *string `json:"name,omitempty"`
	BrandColor *string `json:"brand_color,omitempty"`
	LogoURL    *string `json:"logo_url,omitempty"`
	// Status is active or suspended. Active on a closed workspace reopens it.
	// Close with CloseWorkspace.
	Status *string `json:"status,omitempty"`
}

// RotateInstallRequest describes a rotation. A nil field takes the default.
type RotateInstallRequest struct {
	// OverlapHours is how long the replaced token keeps working. Default 24,
	// at most 168. Zero cuts it off at once.
	OverlapHours *int `json:"overlap_hours,omitempty"`
	// ExpiresInDays is the life of the new token. Nil keeps the install's
	// policy. Zero removes the expiry.
	ExpiresInDays *int `json:"expires_in_days,omitempty"`
}

// RotateInstallResult is the answer to RotateInstall.
type RotateInstallResult struct {
	Install ManagedInstall `json:"install"`
	// Token is the new install token. Shown once.
	Token string `json:"token"`
}

// EnterpriseClient calls the Enterprise API, for a product that runs one
// workspace per customer. An account key creates and runs the workspaces. It
// never calls a model: each workspace has its own install token for the Core
// API, and Core gives you the client for it.
//
//	account := omazy.NewEnterprise(os.Getenv("OMAZY_ACCOUNT_KEY"))
//	made, err := account.CreateWorkspace(ctx, omazy.CreateWorkspaceRequest{ExternalID: "cust_42", Name: "Acme Bank"})
//	if made.Token != "" { /* store it: it is shown once */ }
//	acme := account.Core(tokenFor("cust_42"))
type EnterpriseClient struct {
	c        *Client
	coreBase string
	coreHTTP *http.Client
}

// NewEnterprise builds a client for an account key, eak_<prefix>.<secret>.
// Keep the key on a server. WithBaseURL, WithHTTPClient and WithMaxRetries
// apply; WithApp has no meaning here.
func NewEnterprise(token string, opts ...Option) *EnterpriseClient {
	c := New(token, append([]Option{WithBaseURL(DefaultEnterpriseBaseURL)}, opts...)...)
	e := &EnterpriseClient{c: c, coreBase: DefaultBaseURL, coreHTTP: c.http}
	// The Core API of the same deployment: .../enterprise becomes .../core.
	if strings.HasSuffix(c.base, "/enterprise") {
		e.coreBase = strings.TrimSuffix(c.base, "/enterprise") + "/core"
	}
	return e
}

// Last returns the headers of the most recent response.
func (e *EnterpriseClient) Last() ResponseInfo { return e.c.Last() }

// Core returns a Core API client for one customer, from that customer's
// install token. It talks to the same deployment as this client.
func (e *EnterpriseClient) Core(installToken string, opts ...Option) *Client {
	c := New(installToken, append([]Option{WithBaseURL(e.coreBase), WithHTTPClient(e.coreHTTP), WithMaxRetries(e.c.maxRetries)}, opts...)...)
	c.sleep = e.c.sleep
	return c
}

func (e *EnterpriseClient) send(ctx context.Context, name string, in call) (*http.Response, error) {
	attempts := 0
	if enterpriseRepeatable[name] {
		attempts = e.c.maxRetries
	}
	return e.c.do(ctx, enterpriseRoutes[name], in, attempts, "", "the Enterprise API")
}

func (e *EnterpriseClient) json(ctx context.Context, name string, in call, out any, meta any) error {
	res, err := e.send(ctx, name, in)
	if err != nil {
		return err
	}
	defer res.Body.Close()
	var env struct {
		Data json.RawMessage `json:"data"`
		Meta json.RawMessage `json:"meta"`
	}
	if err := json.NewDecoder(res.Body).Decode(&env); err != nil {
		return &Error{Status: res.StatusCode, Code: "BAD_RESPONSE", Message: "the response was not JSON: " + err.Error(), RequestID: e.Last().RequestID}
	}
	if meta != nil && len(env.Meta) > 0 {
		if err := json.Unmarshal(env.Meta, meta); err != nil {
			return err
		}
	}
	if out == nil || len(env.Data) == 0 {
		return nil
	}
	return json.Unmarshal(env.Data, out)
}

// Account returns the account behind the key, its limits, how many workspaces
// it manages, and the key. Needs no scope.
func (e *EnterpriseClient) Account(ctx context.Context) (*EnterpriseAccount, error) {
	var out EnterpriseAccount
	return &out, e.json(ctx, "account", call{}, &out, nil)
}

// CreateWorkspace creates the workspace of a customer, with its agent, its
// plan and its install. It is safe to repeat: the same ExternalID returns the
// same workspace, with Created false and no token. Needs workspaces:manage;
// the install is minted when the key also holds installs:manage.
func (e *EnterpriseClient) CreateWorkspace(ctx context.Context, req CreateWorkspaceRequest) (*CreateWorkspaceResult, error) {
	var out CreateWorkspaceResult
	return &out, e.json(ctx, "workspaces.create", call{body: req}, &out, nil)
}

// ListWorkspaces returns one page of the account's workspaces, newest first.
// Needs workspaces:manage.
func (e *EnterpriseClient) ListWorkspaces(ctx context.Context, q ListWorkspacesQuery) (*WorkspacePage, error) {
	query := map[string]string{"status": q.Status, "external_id": q.ExternalID, "cursor": q.Cursor}
	if q.Limit > 0 {
		query["limit"] = strconv.Itoa(q.Limit)
	}
	var meta struct {
		NextCursor string `json:"next_cursor"`
	}
	page := &WorkspacePage{Workspaces: []ManagedWorkspace{}}
	if err := e.json(ctx, "workspaces.list", call{query: query}, &page.Workspaces, &meta); err != nil {
		return nil, err
	}
	page.NextCursor = meta.NextCursor
	return page, nil
}

// AccountUsageQuery is a range of UTC days, YYYY-MM-DD, both included, and a
// page of the account's workspaces as ListWorkspaces pages them.
type AccountUsageQuery struct {
	From, To   string
	Status     string
	ExternalID string
	Cursor     string
	Limit      int
}

// WorkspaceUsage is one managed workspace's usage.
type WorkspaceUsage struct {
	Workspace struct {
		ID         string `json:"id"`
		ExternalID string `json:"external_id"`
		Handle     string `json:"handle"`
		Name       string `json:"name"`
		Status     string `json:"status"`
	} `json:"workspace"`
	Totals UsageTotals `json:"totals"`
	Days   []UsageDay  `json:"days"`
}

// AccountUsage is one page of the account's workspaces with their usage, and
// the account's totals over all of them.
type AccountUsage struct {
	From       string           `json:"from"`
	To         string           `json:"to"`
	Totals     UsageTotals      `json:"totals"`
	Workspaces []WorkspaceUsage `json:"workspaces"`
	// NextCursor is the Cursor of the next page, empty on the last.
	NextCursor string `json:"-"`
}

// Usage returns usage and cost per UTC day of one page of the account's
// workspaces, with the account's totals over every workspace. Empty From and
// To give the last 30 days; a range covers at most 90. Needs usage:read.
func (e *EnterpriseClient) Usage(ctx context.Context, q AccountUsageQuery) (*AccountUsage, error) {
	query := map[string]string{"from": q.From, "to": q.To, "status": q.Status, "external_id": q.ExternalID, "cursor": q.Cursor}
	if q.Limit > 0 {
		query["limit"] = strconv.Itoa(q.Limit)
	}
	var meta struct {
		NextCursor string `json:"next_cursor"`
	}
	out := &AccountUsage{}
	if err := e.json(ctx, "usage", call{query: query}, out, &meta); err != nil {
		return nil, err
	}
	out.NextCursor = meta.NextCursor
	return out, nil
}

// AllWorkspaces calls fn with every workspace of the account, page by page,
// until fn returns false. Status and Limit of q apply.
func (e *EnterpriseClient) AllWorkspaces(ctx context.Context, q ListWorkspacesQuery, fn func(ManagedWorkspace) bool) error {
	q.ExternalID, q.Cursor = "", ""
	for {
		page, err := e.ListWorkspaces(ctx, q)
		if err != nil {
			return err
		}
		for _, w := range page.Workspaces {
			if !fn(w) {
				return nil
			}
		}
		if page.NextCursor == "" {
			return nil
		}
		q.Cursor = page.NextCursor
	}
}

// GetWorkspace returns one workspace by its id. Needs workspaces:manage.
func (e *EnterpriseClient) GetWorkspace(ctx context.Context, id string) (*ManagedWorkspace, error) {
	var out ManagedWorkspace
	return &out, e.json(ctx, "workspaces.get", call{path: map[string]string{"id": id}}, &out, nil)
}

// FindWorkspaceByExternalID returns the workspace of a customer by your own id
// for them, or nil when there is none.
func (e *EnterpriseClient) FindWorkspaceByExternalID(ctx context.Context, externalID string) (*ManagedWorkspace, error) {
	page, err := e.ListWorkspaces(ctx, ListWorkspacesQuery{ExternalID: externalID})
	if err != nil || len(page.Workspaces) == 0 {
		return nil, err
	}
	return &page.Workspaces[0], nil
}

// UpdateWorkspace renames, rebrands, suspends or resumes a workspace. Needs
// workspaces:manage.
func (e *EnterpriseClient) UpdateWorkspace(ctx context.Context, id string, req UpdateWorkspaceRequest) (*ManagedWorkspace, error) {
	var out ManagedWorkspace
	return &out, e.json(ctx, "workspaces.update", call{path: map[string]string{"id": id}, body: req}, &out, nil)
}

// SuspendWorkspace stops serving a workspace. Its Core calls are refused
// within about 30 seconds; a call in progress finishes.
func (e *EnterpriseClient) SuspendWorkspace(ctx context.Context, id string) (*ManagedWorkspace, error) {
	s := WorkspaceSuspended
	return e.UpdateWorkspace(ctx, id, UpdateWorkspaceRequest{Status: &s})
}

// ResumeWorkspace serves a suspended workspace again, or reopens a closed one.
func (e *EnterpriseClient) ResumeWorkspace(ctx context.Context, id string) (*ManagedWorkspace, error) {
	s := WorkspaceActive
	return e.UpdateWorkspace(ctx, id, UpdateWorkspaceRequest{Status: &s})
}

// CloseWorkspace closes a workspace. Nothing is erased, and ResumeWorkspace
// reopens it. Needs workspaces:manage.
func (e *EnterpriseClient) CloseWorkspace(ctx context.Context, id string) (*ManagedWorkspace, error) {
	var out ManagedWorkspace
	return &out, e.json(ctx, "workspaces.close", call{path: map[string]string{"id": id}}, &out, nil)
}

// RotateInstall mints a new install token for the workspace. The old one
// keeps working for the overlap. A workspace with no install gets one. The
// client never sends this twice: each run replaces the token before it. Needs
// installs:manage.
func (e *EnterpriseClient) RotateInstall(ctx context.Context, id string, req RotateInstallRequest) (*RotateInstallResult, error) {
	var out RotateInstallResult
	return &out, e.json(ctx, "workspaces.rotate_install", call{path: map[string]string{"id": id}, body: req}, &out, nil)
}

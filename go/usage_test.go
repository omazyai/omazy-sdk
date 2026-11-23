package omazy

import "testing"

func TestUsageIsRead(t *testing.T) {
	day := `"model_calls":2,"cache_hits":1,"errors":0,"input_tokens":10,"output_tokens":2,"cached_input_tokens":4,` +
		`"speech_sessions":0,"speech_seconds":0,"cost_micros":1500,"cost_usd":0.0015,"estimated_cost_micros":0,` +
		`"unpriced_calls":0,"conversations":1,"ai_turns":2,"api_calls":3,"voice_minutes":0`
	f, c := newFake(t, ok(`{"workspace_id":"w1","from":"2026-11-22","to":"2026-11-22","totals":{`+day+`},"days":[{"date":"2026-11-22",`+day+`}]}`))
	got, err := c.Usage.Get(ctx, "2026-11-22", "2026-11-22")
	if err != nil {
		t.Fatal(err)
	}
	if got.Totals.CostMicros != 1500 || len(got.Days) != 1 || got.Days[0].Date != "2026-11-22" || got.Days[0].CacheHits != 1 {
		t.Fatalf("report: %+v", got)
	}
	if f.seen[0].method != "GET" || f.seen[0].path != "/core/usage?from=2026-11-22&to=2026-11-22" {
		t.Fatalf("request: %+v", f.seen[0])
	}
	if _, err := c.Usage.Get(ctx, "", ""); err != nil || f.seen[1].path != "/core/usage" {
		t.Fatalf("default range: %v %+v", err, f.seen[1])
	}
}

func TestContractIsRead(t *testing.T) {
	f, c := newFake(t, ok(`{"base":"/api/v1/core","routes":[{"method":"GET","path":"/contract","scope":"","sdk":"contract","public":true}]}`))
	got, err := c.Contract(ctx)
	if err != nil || len(got.Routes) != 1 || !got.Routes[0].Public || got.Routes[0].SDK != "contract" {
		t.Fatalf("contract: %v %+v", err, got)
	}
	if _, err := c.ContractOpenAPI(ctx); err != nil || f.seen[0].path != "/core/contract" || f.seen[1].path != "/core/contract?format=openapi" {
		t.Fatalf("requests: %v %+v", err, f.seen)
	}
}

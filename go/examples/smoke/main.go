// A live check against a real deployment. Reads OMAZY_CORE_TOKEN (and
// OMAZY_BASE_URL, if set). Spends a few tokens. Run: go run ./examples/smoke
package main

import (
	"context"
	"errors"
	"fmt"
	"os"
	"strings"
	"time"

	omazy "github.com/omazyai/omazy-sdk/go"
)

func main() {
	var opts []omazy.Option
	if u := os.Getenv("OMAZY_BASE_URL"); u != "" {
		opts = append(opts, omazy.WithBaseURL(u))
	}
	c := omazy.New(os.Getenv("OMAZY_CORE_TOKEN"), opts...)
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Minute)
	defer cancel()
	must := func(err error) {
		if err != nil {
			fmt.Println("FAILED:", err)
			os.Exit(1)
		}
	}

	me, err := c.Whoami(ctx)
	must(err)
	fmt.Println("whoami      ", me.AppSlug, len(me.Scopes), "scopes, token", me.Token, "| request", c.Last().RequestID)

	msg := func(s string) []omazy.Message { return []omazy.Message{{Role: "user", Content: s}} }
	done, err := c.AI.Complete(ctx, omazy.CompleteRequest{Messages: msg("Reply with the single word: pong"), MaxTokens: 8})
	must(err)
	fmt.Printf("complete     %q %s | remaining %d\n", done.Text, done.Model, c.Last().RateRemaining)

	var streamed strings.Builder
	deltas := 0
	res, err := c.AI.Stream(ctx, omazy.CompleteRequest{Messages: msg("Count from 1 to 5."), MaxTokens: 30}, func(s string) {
		streamed.WriteString(s)
		deltas++
	})
	must(err)
	fmt.Printf("stream       %q %d deltas, done matches: %v\n", streamed.String(), deltas, res.Text == streamed.String())

	passages, err := c.Knowledge.Search(ctx, "What does the company do?", omazy.SearchOptions{TopK: 2})
	must(err)
	first := ""
	if len(passages) > 0 {
		first = passages[0].Title
	}
	fmt.Println("knowledge   ", len(passages), "passages, first:", first)

	tools, err := c.MCP.ListTools(ctx)
	must(err)
	names := make([]string, 0, len(tools))
	for _, t := range tools {
		names = append(names, t.Name)
	}
	fmt.Println("mcp tools   ", strings.Join(names, ", "))
	via, err := c.MCP.CallTool(ctx, "knowledge_search", map[string]any{"query": "What does the company do?", "top_k": 1})
	must(err)
	n := 0
	if ps, ok := via.Data["passages"].([]any); ok {
		n = len(ps)
	}
	fmt.Println("mcp call    ", "isError", via.IsError, "| passages", n)

	_, err = c.Customers.Get(ctx, "00000000-0000-0000-0000-000000000000")
	var e *omazy.Error
	if errors.As(err, &e) {
		fmt.Println("refusal     ", e.Status, e.Code, "|", e.Message)
	}
}

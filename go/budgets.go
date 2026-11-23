package omazy

import "context"

// BudgetService holds spend caps on this install. A completion, an embedding
// or an agent turn past a cap that covers it is refused with 402
// BUDGET_EXCEEDED before any model runs.
type BudgetService struct{ c *Client }

// BudgetSet adds a cap or changes one. Period is "day" or "month" (UTC).
// Label is "unit", "unit_version", "prompt_version" or "run_id", or empty for
// every call; Value is its value, or "*" to cap each value on its own.
type BudgetSet struct {
	Label    string  `json:"label,omitempty"`
	Value    string  `json:"value,omitempty"`
	Period   string  `json:"period"`
	LimitUSD float64 `json:"limit_usd"`
}

// Budget is a cap with this period's spend.
type Budget struct {
	ID          string  `json:"id"`
	Label       string  `json:"label"`
	Value       string  `json:"value"`
	Period      string  `json:"period"`
	LimitMicros int64   `json:"limit_micros"`
	LimitUSD    float64 `json:"limit_usd"`
	SpentMicros int64   `json:"spent_micros"`
	SpentUSD    float64 `json:"spent_usd"`
	ResetsAt    string  `json:"resets_at"`
	UpdatedAt   string  `json:"updated_at,omitempty"`
}

// List returns the install's caps. Needs usage:read.
func (s *BudgetService) List(ctx context.Context) ([]Budget, error) {
	var out struct {
		Budgets []Budget `json:"budgets"`
	}
	return out.Budgets, s.c.json(ctx, "budgets.list", call{}, &out)
}

// Set adds a cap, or changes the limit of the one with the same label, value
// and period. Needs ai:configure.
func (s *BudgetService) Set(ctx context.Context, req BudgetSet) (*Budget, error) {
	var out Budget
	return &out, s.c.json(ctx, "budgets.set", call{body: req}, &out)
}

// Delete removes a cap. Needs ai:configure.
func (s *BudgetService) Delete(ctx context.Context, id string) error {
	return s.c.json(ctx, "budgets.delete", call{path: map[string]string{"id": id}}, nil)
}

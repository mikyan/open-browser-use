package managedbrowser

import (
	"context"
	"encoding/json"
	"testing"
	"time"
)

type inputBudgetDeadline struct {
	operation string
	remaining time.Duration
}

// Observe the context without replacing the actual controller or its socket.
type inputBudgetObservedController struct {
	*UserController
	deadlines chan inputBudgetDeadline
}

func (c inputBudgetObservedController) Command(ctx context.Context, data json.RawMessage) (json.RawMessage, error) {
	var request struct{ Operation string }
	_ = json.Unmarshal(data, &request)
	if request.Operation == "humanInput" || request.Operation == "humanDialogRespond" {
		end, _ := ctx.Deadline()
		c.deadlines <- inputBudgetDeadline{request.Operation, time.Until(end)}
	}
	return c.UserController.Command(ctx, data)
}

func TestManagedHumanBudgetCannotChangeWithinOriginalLease(t *testing.T) {
	for _, initial := range []uint64{0, 1} {
		f := newUserFixture(t, nil, false)
		c := f.open()
		state := func(version, generation, sequence uint64) json.RawMessage {
			value := humanFixtureState(f)
			value["eventSequence"] = sequence
			human := value["human"].(map[string]any)
			human["generation"] = generation
			if version != 0 {
				human["inputBudgetVersion"] = version
			}
			data, _ := json.Marshal(value)
			return data
		}
		validate := func(data json.RawMessage) error {
			c.mu.Lock()
			defer c.mu.Unlock()
			return c.validateStatusLocked(data)
		}
		if err := validate(state(initial, 1, 10)); err != nil {
			t.Fatal(err)
		}
		if err := validate(state(initial, 1, 11)); err != nil {
			t.Fatal("same native contract rejected", err)
		}
		if err := validate(state(1-initial, 1, 12)); err == nil {
			t.Fatal("same generation capability changed")
		}
		if err := validate(state(2, 1, 12)); err == nil {
			t.Fatal("unknown native budget accepted")
		}
		if err := validate(state(1-initial, 2, 13)); err == nil {
			t.Fatal("new generation changed original lease capability")
		}
		if err := validate(state(initial, 2, 13)); err != nil {
			t.Fatal("new generation rejected", err)
		}
		if err := validate(state(initial, 1, 10)); err != nil {
			t.Fatal("late original status should be ignored", err)
		}
		c.mu.Lock()
		latest := *c.humanStatus
		c.mu.Unlock()
		if latest.Generation != 2 || latest.InputBudgetVersion != initial {
			t.Fatal("late status changed successor budget")
		}
	}
}

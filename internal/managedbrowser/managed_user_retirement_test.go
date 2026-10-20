package managedbrowser

import (
	"context"
	"encoding/json"
	"errors"
	"testing"
	"time"

	"github.com/ifuryst/open-browser-use/internal/managedprotocol"
)

func TestManagedHumanRetirementSettlesOriginalCall(t *testing.T) {
	for _, outcome := range []string{"receipt", "failure", "deadline", "disconnect"} {
		t.Run(outcome, func(t *testing.T) {
			held := make(chan userTestRequest, 1)
			f := newUserFixture(t, func(f *userFixture, req userTestRequest) bool {
				if req.Operation == "humanBegin" {
					f.evaluated(req, map[string]any{"status": humanFixtureState(f)})
					return true
				}
				if req.Operation == "humanInput" {
					held <- req
					return true
				}
				return false
			}, false)
			c := f.open()
			if _, err := c.Command(context.Background(), json.RawMessage(`{"operation":"humanBegin","tabId":7}`)); err != nil {
				t.Fatal(err)
			}
			budget := time.Second
			if outcome == "deadline" {
				budget = 80 * time.Millisecond
			}
			deadline, finish := context.WithTimeout(context.Background(), budget)
			defer finish()
			ctx, retire := context.WithCancelCause(deadline)
			defer retire(nil)
			done := make(chan userReply, 1)
			go func() { data, err := c.Command(ctx, humanFixtureRequest()); done <- userReply{data: data, err: err} }()
			input := userWait(t, held)
			if outcome == "disconnect" {
				retire(context.Canceled)
			} else {
				retire(managedprotocol.ErrHumanLeaseRetired)
			}
			if outcome == "deadline" || outcome == "disconnect" {
				reply := userWait(t, done)
				expected := context.DeadlineExceeded
				if outcome == "disconnect" {
					expected = context.Canceled
				}
				if !errors.Is(reply.err, expected) {
					t.Fatalf("lost original cancellation/deadline: %v", reply.err)
				}
				c.mu.Lock()
				pending := len(c.commands)
				c.mu.Unlock()
				if pending != 1 {
					t.Fatal("pending native call was forgotten")
				}
				f.rejected(input, "OBU_HUMAN_STALE")
				return
			}
			// A later original response remains authoritative, even after release.
			if outcome == "failure" {
				f.rejected(input, "OBU_HUMAN_UNCONFIRMED")
				if reply := userWait(t, done); reply.err == nil {
					t.Fatal("native failure became success")
				}
			} else {
				state := humanFixtureState(f)
				state["human"], state["selectedTabId"] = nil, nil
				state["humanCleanup"] = map[string]any{"leaseId": "original-lease", "cleanupConfirmed": true}
				f.evaluated(input, map[string]any{"status": state, "inputReceipt": map[string]any{"leaseId": "original-lease", "generation": 1, "sequence": 1, "acknowledged": true}})
				reply := userWait(t, done)
				if reply.err != nil {
					t.Fatal(reply.err)
				}
				fields, _ := userObject(reply.data)
				receipt, err := managedprotocol.ParseInputReceipt(fields["inputReceipt"])
				if err != nil || receipt == nil || receipt.LeaseID != "original-lease" || receipt.Generation != 1 || receipt.Sequence != 1 {
					t.Fatal("lost original input receipt")
				}
			}
			f.mu.Lock()
			defer f.mu.Unlock()
			count := 0
			for _, request := range f.requests {
				if request.Operation == "humanInput" {
					count++
				}
			}
			if count != 1 {
				t.Fatalf("input was replayed: %d calls", count)
			}
		})
	}
}

func TestManagedHumanRetirementBeforeSubmissionSendsNothing(t *testing.T) {
	f := newUserFixture(t, nil, false)
	c := f.open()
	ctx, retire := context.WithCancelCause(context.Background())
	retire(managedprotocol.ErrHumanLeaseRetired)
	if _, err := c.Command(ctx, humanFixtureRequest()); err == nil {
		t.Fatal("retired input submitted")
	}
	f.mu.Lock()
	defer f.mu.Unlock()
	for _, request := range f.requests {
		if request.Operation == "humanInput" {
			t.Fatal("retired input sent to browser")
		}
	}
}

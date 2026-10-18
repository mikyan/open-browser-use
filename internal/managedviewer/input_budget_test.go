package managedviewer

import (
	"context"
	"encoding/json"
	"fmt"
	"sync"
	"testing"
	"time"
)

func budgetTestState(data json.RawMessage, version uint64) json.RawMessage {
	f, _ := object(data)
	state, _ := object(f["status"])
	if human, err := object(state["human"]); err == nil {
		if version != 0 {
			human["inputBudgetVersion"] = jsonBytes(version)
		}
		state["human"] = jsonBytes(human)
	}
	f["status"] = jsonBytes(state)
	return jsonBytes(f)
}

func TestHumanInputBudgetOnlyChangesOriginalInputTransportDeadline(t *testing.T) {
	for _, version := range []uint64{0, 1} {
		t.Run(fmt.Sprint(version), func(t *testing.T) {
			b := humanTestBackend()
			base := b.command
			release := make(chan struct{})
			var once sync.Once
			type deadline struct {
				operation string
				remaining time.Duration
			}
			observed := make(chan deadline, 8)
			b.command = func(ctx context.Context, data json.RawMessage) (json.RawMessage, error) {
				op := humanTestOperation(data)
				if op == "humanInput" || op == "status" || op == "humanEnd" {
					end, ok := ctx.Deadline()
					if !ok {
						t.Error("backend call lacks its transport deadline")
					}
					observed <- deadline{op, time.Until(end)}
				}
				if op == "humanInput" {
					<-release
				}
				value, err := base(ctx, data)
				return budgetTestState(value, version), err
			}
			s := startTest(t, b, nil)
			t.Cleanup(func() { once.Do(func() { close(release) }) })
			c := humanTestBegin(t, b, s)
			send(t, c, humanTestInput(2, 1))
			humanTestCall(t, b, "humanInput")
			got := <-observed
			want := 30 * time.Second
			if version == 1 {
				want = 335 * time.Second
			}
			if got.operation != "humanInput" || got.remaining > want || got.remaining < want-time.Second {
				t.Fatalf("original input deadline %v, want %v", got, want)
			}
			// A status command can proceed while the actual original input is
			// still pending. Its ordinary timeout must not inherit modal time.
			send(t, c, `{"id":3,"operation":"status"}`)
			humanTestCall(t, b, "status")
			humanTestSuccess(t, c, 3)
			got = <-observed
			if got.operation != "status" || got.remaining > 30*time.Second || got.remaining < 29*time.Second {
				t.Fatalf("status inherited input wait: %v", got)
			}
			once.Do(func() { close(release) })
			humanTestSuccess(t, c, 2)
			send(t, c, `{"id":4,"operation":"humanEnd","leaseId":"`+humanTestLease+`"}`)
			humanTestCall(t, b, "humanEnd")
			humanTestSuccess(t, c, 4)
			got = <-observed
			if got.operation != "humanEnd" || got.remaining > 30*time.Second || got.remaining < 29*time.Second {
				t.Fatalf("End inherited input wait: %v", got)
			}
		})
	}
}

func TestHumanInputBudgetCannotChangeWithinAdmittedGeneration(t *testing.T) {
	for _, initial := range []uint64{0, 1} {
		t.Run(fmt.Sprint(initial), func(t *testing.T) {
			b := humanTestBackend()
			base := b.command
			b.command = func(ctx context.Context, data json.RawMessage) (json.RawMessage, error) {
				value, err := base(ctx, data)
				return budgetTestState(value, initial), err
			}
			s := startTest(t, b, nil)
			c := humanTestBegin(t, b, s)
			changed := budgetTestState(humanTestState(true, 3), 1-initial)
			publishGeneration(b, changed)
			for {
				if string(readMessage(t, c)["type"]) == `"state"` {
					break
				}
			}
			send(t, c, humanTestInput(2, 1))
			humanTestError(t, c, 2, "HUMAN_STALE")
			select {
			case call := <-b.calls:
				t.Fatalf("changed generation admitted native input: %s", call)
			default:
			}
		})
	}
}

func TestHumanInputBudgetRejectsCallerOverrideAndInvalidProjection(t *testing.T) {
	for _, field := range []string{`"inputBudgetVersion":1`, `"timeoutMs":335000`} {
		if _, err := parseCommand([]byte(`{"id":1,"operation":"humanInput","leaseId":"a","generation":1,"sequence":1,"input":{"type":"text","text":"x"},` + field + `}`)); err == nil {
			t.Fatal("untrusted caller selected timeout")
		}
	}
	if _, err := publicState(budgetTestState(humanTestState(true, 0), 2)); err == nil {
		t.Fatal("unknown input budget projected")
	}
	if _, err := publicState(budgetTestState(humanTestState(true, 0), 1)); err != nil {
		t.Fatal(err)
	}
}

func TestHumanBeginBudgetCannotDisagreeWithEarlierNativeStatus(t *testing.T) {
	for _, replyVersion := range []uint64{0, 1} {
		t.Run(fmt.Sprint(replyVersion), func(t *testing.T) {
			b := humanTestBackend()
			base := b.command
			release := make(chan struct{})
			var once sync.Once
			b.command = func(ctx context.Context, data json.RawMessage) (json.RawMessage, error) {
				if humanTestOperation(data) == "humanBegin" {
					<-release
					return budgetTestState(humanTestState(true, 0), replyVersion), nil
				}
				return base(ctx, data)
			}
			s := startTest(t, b, nil)
			t.Cleanup(func() { once.Do(func() { close(release) }) })
			c := authenticate(t, s)
			send(t, c, `{"id":1,"operation":"humanBegin","tabId":1}`)
			humanTestCall(t, b, "humanBegin")
			publishGeneration(b, budgetTestState(humanTestState(true, 3), 1-replyVersion))
			for {
				if string(readMessage(t, c)["type"]) == `"state"` {
					break
				}
			}
			once.Do(func() { close(release) })
			humanTestError(t, c, 1, "OPERATION_UNCONFIRMED")
			humanTestCall(t, b, "select")
		})
	}
}

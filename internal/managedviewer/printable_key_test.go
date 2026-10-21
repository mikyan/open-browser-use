package managedviewer

import (
	"context"
	"encoding/json"
	"fmt"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
)

func printableTestState(data json.RawMessage, version uint64) json.RawMessage {
	f, _ := object(data)
	state, _ := object(f["status"])
	if h, err := object(state["human"]); err == nil {
		if version != 0 {
			h["printableKeyVersion"] = jsonBytes(version)
		} else {
			delete(h, "printableKeyVersion")
		}
		state["human"] = jsonBytes(h)
	}
	f["status"] = jsonBytes(state)
	return jsonBytes(f)
}
func TestHumanPrintableKeyCannotChangeWithinAdmittedGeneration(t *testing.T) {
	for _, initial := range []uint64{0, 1} {
		t.Run(fmt.Sprint(initial), func(t *testing.T) {
			b := humanTestBackend()
			base := b.command
			b.command = func(ctx context.Context, data json.RawMessage) (json.RawMessage, error) {
				value, err := base(ctx, data)
				return printableTestState(value, initial), err
			}
			s := startTest(t, b, nil)
			c := humanTestBegin(t, b, s)
			changed := printableTestState(humanTestState(true, 3), 1-initial)
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

func TestHumanPrintableKeyRejectsCallerOverrideAndInvalidProjection(t *testing.T) {
	for _, field := range []string{`"printableKeyVersion":1`, `"timeoutMs":335000`} {
		if _, err := parseCommand([]byte(`{"id":1,"operation":"humanInput","leaseId":"a","generation":1,"sequence":1,"input":{"type":"text","text":"x"},` + field + `}`)); err == nil {
			t.Fatal("untrusted caller selected capability or timeout")
		}
	}
	if _, err := publicState(printableTestState(humanTestState(true, 0), 2)); err == nil {
		t.Fatal("unknown printable capability projected")
	}
	if _, err := publicState(printableTestState(humanTestState(true, 0), 1)); err != nil {
		t.Fatal(err)
	}
}

func TestHumanBeginPrintableKeyCannotDisagreeWithEarlierNativeStatus(t *testing.T) {
	for _, replyVersion := range []uint64{0, 1} {
		t.Run(fmt.Sprint(replyVersion), func(t *testing.T) {
			b := humanTestBackend()
			base := b.command
			release := make(chan struct{})
			var once sync.Once
			b.command = func(ctx context.Context, data json.RawMessage) (json.RawMessage, error) {
				if humanTestOperation(data) == "humanBegin" {
					<-release
					return printableTestState(humanTestState(true, 0), replyVersion), nil
				}
				return base(ctx, data)
			}
			s := startTest(t, b, nil)
			t.Cleanup(func() { once.Do(func() { close(release) }) })
			c := authenticate(t, s)
			send(t, c, `{"id":1,"operation":"humanBegin","tabId":1}`)
			humanTestCall(t, b, "humanBegin")
			publishGeneration(b, printableTestState(humanTestState(true, 3), 1-replyVersion))
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

func printableTestInput(id, sequence uint64) string {
	return fmt.Sprintf(`{"id":%d,"operation":"humanInput","leaseId":%q,"generation":1,"sequence":%d,"input":{"type":"key","action":"down","key":"a","code":"KeyA","windowsVirtualKeyCode":65,"text":"a"}}`, id, humanTestLease, sequence)
}

func TestHumanPrintableKeyAdmissionNeedsNativeCapability(t *testing.T) {
	for _, version := range []uint64{0, 1} {
		t.Run(fmt.Sprint(version), func(t *testing.T) {
			b := humanTestBackend()
			base := b.command
			b.command = func(ctx context.Context, data json.RawMessage) (json.RawMessage, error) {
				value, err := base(ctx, data)
				return printableTestState(value, version), err
			}
			s := startTest(t, b, nil)
			c := humanTestBegin(t, b, s)
			send(t, c, humanTestInput(2, 1))
			humanTestSuccess(t, c, 2)
			humanTestCall(t, b, "humanInput")
			send(t, c, printableTestInput(3, 2))
			if version == 0 {
				humanTestError(t, c, 3, "HUMAN_STALE")
				select {
				case call := <-b.calls:
					t.Fatalf("unadvertised printable key reached backend: %s", call)
				default:
				}
			} else {
				result := humanTestSuccess(t, c, 3)
				call := humanTestCall(t, b, "humanInput")
				if !strings.Contains(string(call), `"text":"a"`) || !strings.Contains(string(result), `"sequence":2`) {
					t.Fatal("printable text or exact native receipt lost")
				}
				send(t, c, printableTestInput(4, 2))
				humanTestError(t, c, 4, "HUMAN_STALE")
				send(t, c, printableTestInput(5, 3))
				humanTestSuccess(t, c, 5)
				humanTestCall(t, b, "humanInput")
			}
		})
	}
}

func TestHumanPrintableKeyEndCancelsQueuedWithoutReplay(t *testing.T) {
	b := humanTestBackend()
	base := b.command
	gate, entered := make(chan struct{}), make(chan struct{})
	var once sync.Once
	var inputs atomic.Int32
	b.command = func(ctx context.Context, data json.RawMessage) (json.RawMessage, error) {
		switch humanTestOperation(data) {
		case "humanInput":
			inputs.Add(1)
			if strings.Contains(string(data), `"text":"a"`) {
				<-gate
			}
		case "humanEnd":
			close(entered)
			<-gate
		}
		value, err := base(ctx, data)
		return printableTestState(value, 1), err
	}
	s := startTest(t, b, nil)
	t.Cleanup(func() { once.Do(func() { close(gate) }) })
	c := humanTestBegin(t, b, s)
	send(t, c, humanTestInput(2, 1))
	humanTestSuccess(t, c, 2)
	humanTestCall(t, b, "humanInput")
	send(t, c, printableTestInput(3, 2))
	humanTestCall(t, b, "humanInput")
	send(t, c, printableTestInput(4, 3))
	send(t, c, fmt.Sprintf(`{"id":5,"operation":"humanEnd","leaseId":%q}`, humanTestLease))
	humanTestSignal(t, entered, "End waited behind pending printable key")
	humanTestCall(t, b, "humanEnd")
	if inputs.Load() != 2 {
		t.Fatal("queued printable key dispatched before original ACK")
	}
	once.Do(func() { close(gate) })
	humanTestSuccess(t, c, 5)
	send(t, c, printableTestInput(6, 4))
	humanTestError(t, c, 6, "HUMAN_STALE")
	if inputs.Load() != 2 {
		t.Fatal("printable key replayed after End")
	}
}

func TestHumanPrintableKeyCapabilityFixedAcrossPreparingAndNavigation(t *testing.T) {
	for _, initial := range []uint64{0, 1} {
		for _, generation := range []uint64{0, 1} {
			t.Run(fmt.Sprintf("%d/%d", initial, generation), func(t *testing.T) {
				b := humanTestBackend()
				base := b.command
				b.command = func(ctx context.Context, data json.RawMessage) (json.RawMessage, error) {
					if humanTestOperation(data) == "humanBegin" {
						return printableTestState(preparingTestState("preparing", generation, 1, ""), initial), nil
					}
					return base(ctx, data)
				}
				s := startTest(t, b, nil)
				c := authenticate(t, s)
				send(t, c, `{"id":1,"operation":"humanBegin","tabId":1}`)
				humanTestCall(t, b, "humanBegin")
				humanTestSuccess(t, c, 1)
				publishGeneration(b, printableTestState(preparingTestState("navigating", generation+1, 5, ""), 1-initial))
				for string(readMessage(t, c)["type"]) != `"state"` {
				}
				send(t, c, humanTestInput(2, 1))
				humanTestError(t, c, 2, "HUMAN_STALE")
				// Matching old capability must not restore an already revoked lease.
				publishGeneration(b, printableTestState(preparingTestState("active", generation+1, 6, ""), initial))
				for string(readMessage(t, c)["type"]) != `"state"` {
				}
				send(t, c, humanTestInput(3, 1))
				humanTestError(t, c, 3, "HUMAN_STALE")
			})
		}
	}
}

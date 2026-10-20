package managedviewer

import (
	"context"
	"encoding/json"
	"fmt"
	"strings"
	"sync"
	"sync/atomic"
	"testing"

	"github.com/ifuryst/open-browser-use/internal/managedprotocol"
)

func pointerCountTestState(data json.RawMessage, version uint64) json.RawMessage {
	f, _ := object(data)
	state, _ := object(f["status"])
	if h, err := object(state["human"]); err == nil {
		if version != 0 {
			h["pointerClickCountVersion"] = jsonBytes(version)
		} else {
			delete(h, "pointerClickCountVersion")
		}
		state["human"] = jsonBytes(h)
	}
	f["status"] = jsonBytes(state)
	return jsonBytes(f)
}
func TestHumanPointerClickCountCannotChangeWithinAdmittedGeneration(t *testing.T) {
	for _, initial := range []uint64{0, 1} {
		t.Run(fmt.Sprint(initial), func(t *testing.T) {
			b := humanTestBackend()
			base := b.command
			b.command = func(ctx context.Context, data json.RawMessage) (json.RawMessage, error) {
				value, err := base(ctx, data)
				return pointerCountTestState(value, initial), err
			}
			s := startTest(t, b, nil)
			c := humanTestBegin(t, b, s)
			changed := pointerCountTestState(humanTestState(true, 3), 1-initial)
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

func TestHumanPointerClickCountRejectsCallerOverrideAndInvalidProjection(t *testing.T) {
	for _, field := range []string{`"pointerClickCountVersion":1`, `"timeoutMs":335000`} {
		if _, err := parseCommand([]byte(`{"id":1,"operation":"humanInput","leaseId":"a","generation":1,"sequence":1,"input":{"type":"text","text":"x"},` + field + `}`)); err == nil {
			t.Fatal("untrusted caller selected capability or timeout")
		}
	}
	if _, err := publicState(pointerCountTestState(humanTestState(true, 0), 2)); err == nil {
		t.Fatal("unknown pointer count capability projected")
	}
	if _, err := publicState(pointerCountTestState(humanTestState(true, 0), 1)); err != nil {
		t.Fatal(err)
	}
}

func TestHumanBeginPointerClickCountCannotDisagreeWithEarlierNativeStatus(t *testing.T) {
	for _, replyVersion := range []uint64{0, 1} {
		t.Run(fmt.Sprint(replyVersion), func(t *testing.T) {
			b := humanTestBackend()
			base := b.command
			release := make(chan struct{})
			var once sync.Once
			b.command = func(ctx context.Context, data json.RawMessage) (json.RawMessage, error) {
				if humanTestOperation(data) == "humanBegin" {
					<-release
					return pointerCountTestState(humanTestState(true, 0), replyVersion), nil
				}
				return base(ctx, data)
			}
			s := startTest(t, b, nil)
			t.Cleanup(func() { once.Do(func() { close(release) }) })
			c := authenticate(t, s)
			send(t, c, `{"id":1,"operation":"humanBegin","tabId":1}`)
			humanTestCall(t, b, "humanBegin")
			publishGeneration(b, pointerCountTestState(humanTestState(true, 3), 1-replyVersion))
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

func pointerCountTestInput(id, sequence uint64) string {
	return fmt.Sprintf(`{"id":%d,"operation":"humanInput","leaseId":%q,"generation":1,"sequence":%d,"input":{"type":"pointer","action":"down","x":10,"y":20,"button":"left","clickCount":2}}`, id, humanTestLease, sequence)
}

func TestHumanPointerClickCountAdmissionNeedsNativeCapability(t *testing.T) {
	for _, version := range []uint64{0, 1} {
		t.Run(fmt.Sprint(version), func(t *testing.T) {
			b := humanTestBackend()
			base := b.command
			b.command = func(ctx context.Context, data json.RawMessage) (json.RawMessage, error) {
				value, err := base(ctx, data)
				return pointerCountTestState(value, version), err
			}
			s := startTest(t, b, nil)
			c := humanTestBegin(t, b, s)
			send(t, c, humanTestInput(2, 1))
			humanTestSuccess(t, c, 2)
			humanTestCall(t, b, "humanInput")
			send(t, c, pointerCountTestInput(3, 2))
			if version == 0 {
				humanTestError(t, c, 3, "HUMAN_STALE")
				select {
				case call := <-b.calls:
					t.Fatalf("unadvertised repeat reached backend: %s", call)
				default:
				}
			} else {
				result := humanTestSuccess(t, c, 3)
				call := humanTestCall(t, b, "humanInput")
				if !strings.Contains(string(call), `"clickCount":2`) || !strings.Contains(string(result), `"sequence":2`) {
					t.Fatal("repeat or exact native receipt lost")
				}
				send(t, c, pointerCountTestInput(4, 2))
				humanTestError(t, c, 4, "HUMAN_STALE")
				send(t, c, pointerCountTestInput(5, 3))
				humanTestSuccess(t, c, 5)
				humanTestCall(t, b, "humanInput")
			}
		})
	}
}

func TestHumanPointerClickCountEndCancelsQueuedWithoutReplay(t *testing.T) {
	b := humanTestBackend()
	base := b.command
	gate, entered := make(chan struct{}), make(chan struct{})
	var once sync.Once
	var inputs atomic.Int32
	b.command = func(ctx context.Context, data json.RawMessage) (json.RawMessage, error) {
		switch humanTestOperation(data) {
		case "humanInput":
			inputs.Add(1)
			if strings.Contains(string(data), `"clickCount":2`) {
				<-gate
			}
		case "humanEnd":
			close(entered)
			<-gate
		}
		value, err := base(ctx, data)
		return pointerCountTestState(value, 1), err
	}
	s := startTest(t, b, nil)
	t.Cleanup(func() { once.Do(func() { close(gate) }) })
	c := humanTestBegin(t, b, s)
	send(t, c, humanTestInput(2, 1))
	humanTestSuccess(t, c, 2)
	humanTestCall(t, b, "humanInput")
	send(t, c, pointerCountTestInput(3, 2))
	humanTestCall(t, b, "humanInput")
	send(t, c, pointerCountTestInput(4, 3))
	send(t, c, fmt.Sprintf(`{"id":5,"operation":"humanEnd","leaseId":%q}`, humanTestLease))
	humanTestSignal(t, entered, "End waited behind pending counted pointer")
	humanTestCall(t, b, "humanEnd")
	if inputs.Load() != 2 {
		t.Fatal("queued pointer dispatched before original ACK")
	}
	once.Do(func() { close(gate) })
	humanTestSuccess(t, c, 5)
	send(t, c, pointerCountTestInput(6, 4))
	humanTestError(t, c, 6, "HUMAN_STALE")
	if inputs.Load() != 2 {
		t.Fatal("pointer replayed after End")
	}
}

func TestHumanPointerClickCountCapabilityFixedAcrossPreparingAndNavigation(t *testing.T) {
	for _, initial := range []uint64{0, 1} {
		for _, generation := range []uint64{0, 1} {
			t.Run(fmt.Sprintf("%d/%d", initial, generation), func(t *testing.T) {
				b := humanTestBackend()
				base := b.command
				b.command = func(ctx context.Context, data json.RawMessage) (json.RawMessage, error) {
					if humanTestOperation(data) == "humanBegin" {
						return pointerCountTestState(preparingTestState("preparing", generation, 1, ""), initial), nil
					}
					return base(ctx, data)
				}
				s := startTest(t, b, nil)
				c := authenticate(t, s)
				send(t, c, `{"id":1,"operation":"humanBegin","tabId":1}`)
				humanTestCall(t, b, "humanBegin")
				humanTestSuccess(t, c, 1)
				publishGeneration(b, pointerCountTestState(preparingTestState("navigating", generation+1, 5, ""), 1-initial))
				for string(readMessage(t, c)["type"]) != `"state"` {
				}
				send(t, c, humanTestInput(2, 1))
				humanTestError(t, c, 2, "HUMAN_STALE")
				// Matching old capability must not restore an already revoked lease.
				publishGeneration(b, pointerCountTestState(preparingTestState("active", generation+1, 6, ""), initial))
				for string(readMessage(t, c)["type"]) != `"state"` {
				}
				send(t, c, humanTestInput(3, 1))
				humanTestError(t, c, 3, "HUMAN_STALE")
			})
		}
	}
}

func TestHumanPointerClickCountPreparingBeginInterleavingKeepsOriginalCapability(t *testing.T) {
	for _, version := range []uint64{0, 1} {
		for _, changed := range []bool{false, true} {
			t.Run(fmt.Sprintf("%d/%v", version, changed), func(t *testing.T) {
				c := &connection{ctx: context.Background(), inputs: make(chan command, 4), frames: make(chan json.RawMessage, 1)}
				req := command{operation: "humanBegin", payload: json.RawMessage(`{"operation":"humanBegin","tabId":1}`)}
				if !c.admitBegin(&req) {
					t.Fatal("begin rejected")
				}
				defer c.humanCancel()
				early, err := publicState(pointerCountTestState(preparingTestState("preparing", 0, 3, ""), version))
				if err != nil {
					t.Fatal(err)
				}
				if err = c.observeHumanState(early); err != nil {
					t.Fatal(err)
				}
				replyVersion := version
				if changed {
					replyVersion = 1 - version
				}
				reply, err := publicState(pointerCountTestState(preparingTestState("active", 1, 2, ""), replyVersion))
				if err != nil {
					t.Fatal(err)
				}
				err = c.acceptHumanResult(req, reply)
				if changed {
					if err == nil {
						t.Fatal("Begin changed the capability first announced in preparing")
					}
					return
				}
				if err != nil {
					t.Fatal(err)
				}
				// Subsequent generation changes keep both native capabilities, not just geometry.
				c.controlMu.Lock()
				pending := c.applyHumanStateLocked(&managedprotocol.HumanState{State: "navigating", LeaseID: humanTestLease, TabID: 1, Generation: 2, InputBudgetVersion: 1, PointerClickCountVersion: 1 - version})
				revoked := c.humanRevoked
				c.controlMu.Unlock()
				if !revoked || len(pending) != 0 || c.humanCtx.Err() == nil {
					t.Fatal("successor generation did not revoke its changed contract")
				}
			})
		}
	}
}

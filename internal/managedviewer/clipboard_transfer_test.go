package managedviewer

import (
	"context"
	"encoding/json"
	"fmt"
	"github.com/ifuryst/open-browser-use/internal/managedprotocol"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
)

func clipboardTestState(data json.RawMessage, version uint64) json.RawMessage {
	f, _ := object(data)
	state, _ := object(f["status"])
	if h, err := object(state["human"]); err == nil {
		if version != 0 {
			h["clipboardTransferVersion"] = jsonBytes(version)
		} else {
			delete(h, "clipboardTransferVersion")
		}
		state["human"] = jsonBytes(h)
	}
	f["status"] = jsonBytes(state)
	return jsonBytes(f)
}
func TestHumanClipboardTransferCannotChangeWithinAdmittedGeneration(t *testing.T) {
	for _, initial := range []uint64{0, 1} {
		t.Run(fmt.Sprint(initial), func(t *testing.T) {
			b := humanTestBackend()
			base := b.command
			b.command = func(ctx context.Context, data json.RawMessage) (json.RawMessage, error) {
				value, err := base(ctx, data)
				return clipboardTestState(clipboardTestResult(data, value), initial), err
			}
			s := startTest(t, b, nil)
			c := humanTestBegin(t, b, s)
			changed := clipboardTestState(humanTestState(true, 3), 1-initial)
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

func TestHumanClipboardTransferRejectsCallerOverrideAndInvalidProjection(t *testing.T) {
	for _, field := range []string{`"clipboardTransferVersion":1`, `"timeoutMs":335000`} {
		if _, err := parseCommand([]byte(`{"id":1,"operation":"humanInput","leaseId":"a","generation":1,"sequence":1,"input":{"type":"text","text":"x"},` + field + `}`)); err == nil {
			t.Fatal("untrusted caller selected capability or timeout")
		}
	}
	if _, err := publicState(clipboardTestState(humanTestState(true, 0), 2)); err == nil {
		t.Fatal("unknown repeat capability projected")
	}
	if _, err := publicState(clipboardTestState(humanTestState(true, 0), 1)); err != nil {
		t.Fatal(err)
	}
}

func TestHumanBeginClipboardTransferCannotDisagreeWithEarlierNativeStatus(t *testing.T) {
	for _, replyVersion := range []uint64{0, 1} {
		t.Run(fmt.Sprint(replyVersion), func(t *testing.T) {
			b := humanTestBackend()
			base := b.command
			release := make(chan struct{})
			var once sync.Once
			b.command = func(ctx context.Context, data json.RawMessage) (json.RawMessage, error) {
				if humanTestOperation(data) == "humanBegin" {
					<-release
					return clipboardTestState(humanTestState(true, 0), replyVersion), nil
				}
				return base(ctx, data)
			}
			s := startTest(t, b, nil)
			t.Cleanup(func() { once.Do(func() { close(release) }) })
			c := authenticate(t, s)
			send(t, c, `{"id":1,"operation":"humanBegin","tabId":1}`)
			humanTestCall(t, b, "humanBegin")
			publishGeneration(b, clipboardTestState(humanTestState(true, 3), 1-replyVersion))
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

func clipboardTestInput(id, sequence uint64) string {
	return fmt.Sprintf(`{"id":%d,"operation":"humanInput","leaseId":%q,"generation":1,"sequence":%d,"input":{"type":"key","action":"down","key":"c","code":"KeyC","windowsVirtualKeyCode":67,"modifiers":2,"clipboardTransfer":"copy"}}`, id, humanTestLease, sequence)
}

func TestHumanClipboardTransferAdmissionNeedsNativeCapability(t *testing.T) {
	for _, version := range []uint64{0, 1} {
		t.Run(fmt.Sprint(version), func(t *testing.T) {
			b := humanTestBackend()
			base := b.command
			b.command = func(ctx context.Context, data json.RawMessage) (json.RawMessage, error) {
				value, err := base(ctx, data)
				return clipboardTestState(clipboardTestResult(data, value), version), err
			}
			s := startTest(t, b, nil)
			c := humanTestBegin(t, b, s)
			send(t, c, humanTestInput(2, 1))
			humanTestSuccess(t, c, 2)
			humanTestCall(t, b, "humanInput")
			send(t, c, clipboardTestInput(3, 2))
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
				if !strings.Contains(string(call), `"clipboardTransfer":"copy"`) || !strings.Contains(string(result), `"sequence":2`) {
					t.Fatal("repeat or exact native receipt lost")
				}
				send(t, c, clipboardTestInput(4, 2))
				humanTestError(t, c, 4, "HUMAN_STALE")
				send(t, c, clipboardTestInput(5, 3))
				humanTestSuccess(t, c, 5)
				humanTestCall(t, b, "humanInput")
			}
		})
	}
}

func TestHumanClipboardTransferEndCancelsQueuedWithoutReplay(t *testing.T) {
	b := humanTestBackend()
	base := b.command
	gate, entered := make(chan struct{}), make(chan struct{})
	var once sync.Once
	var inputs atomic.Int32
	b.command = func(ctx context.Context, data json.RawMessage) (json.RawMessage, error) {
		switch humanTestOperation(data) {
		case "humanInput":
			inputs.Add(1)
			if strings.Contains(string(data), `"clipboardTransfer":"copy"`) {
				<-gate
			}
		case "humanEnd":
			close(entered)
			<-gate
		}
		value, err := base(ctx, data)
		return clipboardTestState(clipboardTestResult(data, value), 1), err
	}
	s := startTest(t, b, nil)
	t.Cleanup(func() { once.Do(func() { close(gate) }) })
	c := humanTestBegin(t, b, s)
	send(t, c, humanTestInput(2, 1))
	humanTestSuccess(t, c, 2)
	humanTestCall(t, b, "humanInput")
	send(t, c, clipboardTestInput(3, 2))
	humanTestCall(t, b, "humanInput")
	send(t, c, clipboardTestInput(4, 3))
	send(t, c, fmt.Sprintf(`{"id":5,"operation":"humanEnd","leaseId":%q}`, humanTestLease))
	humanTestSignal(t, entered, "End waited behind pending repeat")
	humanTestCall(t, b, "humanEnd")
	if inputs.Load() != 2 {
		t.Fatal("queued repeat dispatched before original ACK")
	}
	once.Do(func() { close(gate) })
	humanTestSuccess(t, c, 5)
	send(t, c, clipboardTestInput(6, 4))
	humanTestError(t, c, 6, "HUMAN_STALE")
	if inputs.Load() != 2 {
		t.Fatal("repeat replayed after End")
	}
}

func TestHumanClipboardTransferCapabilityFixedAcrossPreparingAndNavigation(t *testing.T) {
	for _, initial := range []uint64{0, 1} {
		for _, generation := range []uint64{0, 1} {
			t.Run(fmt.Sprintf("%d/%d", initial, generation), func(t *testing.T) {
				b := humanTestBackend()
				base := b.command
				b.command = func(ctx context.Context, data json.RawMessage) (json.RawMessage, error) {
					if humanTestOperation(data) == "humanBegin" {
						return clipboardTestState(preparingTestState("preparing", generation, 1, ""), initial), nil
					}
					return base(ctx, data)
				}
				s := startTest(t, b, nil)
				c := authenticate(t, s)
				send(t, c, `{"id":1,"operation":"humanBegin","tabId":1}`)
				humanTestCall(t, b, "humanBegin")
				humanTestSuccess(t, c, 1)
				publishGeneration(b, clipboardTestState(preparingTestState("navigating", generation+1, 5, ""), 1-initial))
				for string(readMessage(t, c)["type"]) != `"state"` {
				}
				send(t, c, humanTestInput(2, 1))
				humanTestError(t, c, 2, "HUMAN_STALE")
				// Matching old capability must not restore an already revoked lease.
				publishGeneration(b, clipboardTestState(preparingTestState("active", generation+1, 6, ""), initial))
				for string(readMessage(t, c)["type"]) != `"state"` {
				}
				send(t, c, humanTestInput(3, 1))
				humanTestError(t, c, 3, "HUMAN_STALE")
			})
		}
	}
}

func TestHumanClipboardTransferPreparingBeginInterleavingKeepsOriginalCapability(t *testing.T) {
	for _, version := range []uint64{0, 1} {
		for _, changed := range []bool{false, true} {
			t.Run(fmt.Sprintf("%d/%v", version, changed), func(t *testing.T) {
				c := &connection{ctx: context.Background(), inputs: make(chan command, 4), frames: make(chan json.RawMessage, 1)}
				req := command{operation: "humanBegin", payload: json.RawMessage(`{"operation":"humanBegin","tabId":1}`)}
				if !c.admitBegin(&req) {
					t.Fatal("begin rejected")
				}
				defer c.humanCancel()
				early, err := publicState(clipboardTestState(preparingTestState("preparing", 0, 3, ""), version))
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
				reply, err := publicState(clipboardTestState(preparingTestState("active", 1, 2, ""), replyVersion))
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
				next, parseErr := managedprotocol.ParseHumanState(jsonBytes(map[string]any{"state": "navigating", "leaseId": humanTestLease, "tabId": 1, "generation": 2, "viewport": nil, "inputBudgetVersion": 1, "clipboardTransferVersion": 1 - version}))
				if 1-version == 0 {
					next, parseErr = managedprotocol.ParseHumanState(jsonBytes(map[string]any{"state": "navigating", "leaseId": humanTestLease, "tabId": 1, "generation": 2, "viewport": nil, "inputBudgetVersion": 1}))
				}
				if parseErr != nil {
					t.Fatal(parseErr)
				}
				pending := c.applyHumanStateLocked(next)
				revoked := c.humanRevoked
				c.controlMu.Unlock()
				if !revoked || len(pending) != 0 || c.humanCtx.Err() == nil {
					t.Fatal("successor generation did not revoke its changed contract")
				}
			})
		}
	}
}

// Only the original explicitly requested transfer receives a simulated result.
func clipboardTestResult(request, result json.RawMessage) json.RawMessage {
	f, _ := object(request)
	input, _ := object(f["input"])
	if input["clipboardTransfer"] == nil {
		return result
	}
	envelope, _ := object(result)
	receipt, err := object(envelope["inputReceipt"])
	if err != nil {
		return result
	}
	receipt["clipboardTransfer"] = jsonBytes(map[string]any{"operation": "copy", "status": "unchanged"})
	envelope["inputReceipt"] = jsonBytes(receipt)
	return jsonBytes(envelope)
}

func TestHumanClipboardTransferNativeACKSurvivesTransferOutcome(t *testing.T) {
	outcomes := []string{
		`{"operation":"copy","status":"ready","text":""}`,
		`{"operation":"copy","status":"ready","text":"中文\n🧭"}`,
		`{"operation":"copy","status":"unchanged"}`,
	}
	for _, code := range []string{"UNSUPPORTED", "DENIED", "BUSY", "CANCELLED", "TIMEOUT", "CHANGED", "LIMIT", "READ_FAILED"} {
		outcomes = append(outcomes, fmt.Sprintf(`{"operation":"copy","status":"failed","code":%q}`, code))
	}
	for i, outcome := range outcomes {
		t.Run(fmt.Sprint(i), func(t *testing.T) {
			b := humanTestBackend()
			base := b.command
			b.command = func(ctx context.Context, data json.RawMessage) (json.RawMessage, error) {
				result, err := base(ctx, data)
				result = clipboardTestState(result, 1)
				if strings.Contains(string(data), `"clipboardTransfer":"copy"`) {
					f, _ := object(result)
					receipt, _ := object(f["inputReceipt"])
					receipt["clipboardTransfer"] = json.RawMessage(outcome)
					f["inputReceipt"] = jsonBytes(receipt)
					result = jsonBytes(f)
				}
				return result, err
			}
			c := humanTestBegin(t, b, startTest(t, b, nil))
			send(t, c, clipboardTestInput(2, 1))
			value := humanTestSuccess(t, c, 2)
			humanTestCall(t, b, "humanInput")
			fields, _ := object(value)
			receipt, _ := object(fields["inputReceipt"])
			got, _ := object(receipt["clipboardTransfer"])
			want, _ := object([]byte(outcome))
			if string(receipt["acknowledged"]) != "true" || string(receipt["sequence"]) != "1" || string(jsonBytes(got)) != string(jsonBytes(want)) {
				t.Fatal("original ACK or exact clipboard outcome was lost")
			}
			// Even CANCELLED/TIMEOUT describes the transfer, not an unconfirmed
			// native key. Its original ordinary keyUp must still be admitted.
			up := strings.Replace(clipboardTestInput(3, 2), `"action":"down"`, `"action":"up"`, 1)
			up = strings.Replace(up, `,"clipboardTransfer":"copy"`, "", 1)
			send(t, c, up)
			value = humanTestSuccess(t, c, 3)
			call := humanTestCall(t, b, "humanInput")
			fields, _ = object(value)
			receipt, _ = object(fields["inputReceipt"])
			if receipt["clipboardTransfer"] != nil || !strings.Contains(string(call), `"action":"up"`) {
				t.Fatal("ordinary release acquired a transfer result")
			}
		})
	}
}

func TestHumanClipboardTransferMismatchedReceiptRevokesLane(t *testing.T) {
	for _, outcome := range []string{
		``, `null`, `{"operation":"cut","status":"unchanged"}`,
		`{"operation":"copy","status":"ready","text":"\uD800"}`,
		`{"operation":"copy","status":"failed","code":"untrusted native error"}`,
	} {
		t.Run(outcome, func(t *testing.T) {
			b := humanTestBackend()
			base := b.command
			b.command = func(ctx context.Context, data json.RawMessage) (json.RawMessage, error) {
				value, err := base(ctx, data)
				if humanTestOperation(data) == "humanInput" && outcome != "" {
					f, _ := object(value)
					receipt, _ := object(f["inputReceipt"])
					receipt["clipboardTransfer"] = json.RawMessage(outcome)
					f["inputReceipt"] = jsonBytes(receipt)
					value = jsonBytes(f)
				}
				return clipboardTestState(value, 1), err
			}
			c := humanTestBegin(t, b, startTest(t, b, nil))
			send(t, c, clipboardTestInput(2, 1))
			humanTestCall(t, b, "humanInput")
			humanTestError(t, c, 2, "OPERATION_UNCONFIRMED")
			humanTestCall(t, b, "select")
			send(t, c, clipboardTestInput(3, 2))
			humanTestError(t, c, 3, "HUMAN_STALE")
			select {
			case <-b.calls:
				t.Fatal("invalid clipboard receipt allowed another native key")
			default:
			}
		})
	}
}

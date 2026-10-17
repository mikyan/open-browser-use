package managedbrowser

import (
	"context"
	"encoding/json"
	"errors"
	"strings"
	"testing"
	"time"
)

func humanFixtureState(f *userFixture) map[string]any {
	state := f.status()
	state["automation"] = map[string]any{"state": "paused", "inputBlocked": true, "revision": 1, "cleanupComplete": true}
	state["cleanupPending"] = 0
	state["selectedTabId"] = 7
	state["human"] = map[string]any{"state": "active", "leaseId": "original-lease", "tabId": 7, "generation": 1, "viewport": map[string]any{"width": 800, "height": 600}, "lastInputSequence": 0}
	return state
}

func humanFixtureRequest() json.RawMessage {
	return json.RawMessage(`{"operation":"humanInput","leaseId":"original-lease","generation":1,"sequence":1,"input":{"type":"pointer","action":"down","x":10,"y":10,"button":"left"}}`)
}

func TestManagedHumanOriginalInputReceiptRequired(t *testing.T) {
	for _, mismatch := range []string{"none", "missing", "lease", "generation", "sequence", "unacknowledged"} {
		t.Run(mismatch, func(t *testing.T) {
			f := newUserFixture(t, func(f *userFixture, req userTestRequest) bool {
				if req.Operation != "humanInput" {
					return false
				}
				receipt := map[string]any{"leaseId": "original-lease", "generation": 1, "sequence": 1, "acknowledged": true}
				switch mismatch {
				case "lease":
					receipt["leaseId"] = "successor"
				case "generation":
					receipt["generation"] = 2
				case "sequence":
					receipt["sequence"] = 2
				case "unacknowledged":
					receipt["acknowledged"] = false
				}
				result := map[string]any{"status": humanFixtureState(f)}
				if mismatch != "missing" {
					result["inputReceipt"] = receipt
				}
				f.evaluated(req, result)
				return true
			}, false)
			c := f.open()
			_, err := c.Command(context.Background(), humanFixtureRequest())
			if (err == nil) != (mismatch == "none") {
				t.Fatalf("receipt %s accepted=%t err=%v", mismatch, err == nil, err)
			}
		})
	}
}

func TestManagedHumanWorkerDeathIsNotHeldInputCleanup(t *testing.T) {
	held := make(chan userTestRequest, 2)
	f := newUserFixture(t, func(f *userFixture, req userTestRequest) bool {
		if req.Operation == "humanBegin" {
			f.evaluated(req, map[string]any{"status": humanFixtureState(f)})
			return true
		}
		if req.Operation == "humanInput" || req.Operation == "disconnect" {
			held <- req
			return true
		}
		return false
	}, false)
	c := f.open()
	if _, err := c.Command(context.Background(), json.RawMessage(`{"operation":"humanBegin","tabId":7}`)); err != nil {
		t.Fatal(err)
	}
	inputDone := make(chan error, 1)
	go func() { _, err := c.Command(context.Background(), humanFixtureRequest()); inputDone <- err }()
	input := userWait(t, held)
	// Native down may already have happened. Its missing reply cannot be
	// replaced by the service worker disappearing while the renderer survives.
	f.write(map[string]any{"method": "Target.targetDestroyed", "params": map[string]any{"targetId": "owned-worker"}})
	userWait(t, c.Done())
	ctx, cancel := context.WithTimeout(context.Background(), 60*time.Millisecond)
	if err := c.Close(ctx); err == nil {
		cancel()
		t.Fatal("worker death claimed human cleanup")
	}
	cancel()
	select {
	case <-c.cleanupDone:
		t.Fatal("human cleanup finished before owned browser exit")
	default:
	}
	if _, err := c.Command(context.Background(), json.RawMessage(`{"operation":"select","tabId":null}`)); err == nil {
		t.Fatal("unknown held input cleanup allowed reuse")
	}
	// Completing the original call alone also does not release the held down.
	f.evaluated(input, map[string]any{"status": humanFixtureState(f), "inputReceipt": map[string]any{"leaseId": "original-lease", "generation": 1, "sequence": 1, "acknowledged": true}})
	userWait(t, inputDone)
	select {
	case <-c.cleanupDone:
		t.Fatal("input receipt mistaken for release")
	default:
	}
	f.ownerOnce.Do(func() { close(f.owner) })
	ctx, cancel = context.WithTimeout(context.Background(), time.Second)
	defer cancel()
	if err := c.Close(ctx); err != nil {
		t.Fatal(err)
	}
	result, err := c.Command(ctx, json.RawMessage(`{"operation":"select","tabId":null}`))
	if err != nil || !strings.Contains(string(result), `"cleanupProof":"session-terminated"`) {
		t.Fatalf("missing owned exit proof %s %v", result, err)
	}
}

func TestManagedHumanCanceledCallerStillJoinsOriginalInput(t *testing.T) {
	held := make(chan userTestRequest, 2)
	f := newUserFixture(t, func(f *userFixture, req userTestRequest) bool {
		if req.Operation == "humanBegin" {
			f.evaluated(req, map[string]any{"status": humanFixtureState(f)})
			return true
		}
		if req.Operation == "humanInput" || req.Operation == "disconnect" {
			held <- req
			return true
		}
		return false
	}, false)
	c := f.open()
	_, err := c.Command(context.Background(), json.RawMessage(`{"operation":"humanBegin","tabId":7}`))
	if err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithCancel(context.Background())
	inputDone := make(chan error, 1)
	go func() { _, err := c.Command(ctx, humanFixtureRequest()); inputDone <- err }()
	input := userWait(t, held)
	cancel()
	if !errors.Is(userWait(t, inputDone), context.Canceled) {
		t.Fatal("caller cancellation lost")
	}
	closeDone := make(chan error, 1)
	go func() { closeDone <- c.Close(context.Background()) }()
	disconnect := userWait(t, held)
	state := f.status()
	state["connected"], state["selectedTabId"], state["cleanupPending"], state["human"] = false, nil, 0, nil
	state["humanCleanup"] = map[string]any{"leaseId": "original-lease", "cleanupConfirmed": true}
	f.evaluated(disconnect, map[string]any{"disconnected": true, "status": state})
	select {
	case err := <-closeDone:
		t.Fatalf("forgot original input: %v", err)
	case <-time.After(20 * time.Millisecond):
	}
	f.rejected(input, "OBU_HUMAN_STALE")
	if err := userWait(t, closeDone); err != nil {
		t.Fatal(err)
	}
}

func TestManagedUserFIFOSubmissionSkipsCanceledBeginAndMarshalFailure(t *testing.T) {
	seen := make(chan userTestRequest, 8)
	f := newUserFixture(t, func(f *userFixture, req userTestRequest) bool {
		if req.Operation == "status" || req.Operation == "humanBegin" || req.Operation == "humanEnd" {
			seen <- req
			f.evaluated(req, map[string]any{"status": f.status()})
			return true
		}
		return false
	}, false)
	c := f.open()
	// Occupy the existing socket write gate, then register a definite order.
	c.cdp.writeGate <- struct{}{}
	start := func(ctx context.Context, operation string) *userCall {
		call, err := c.cdp.start(ctx, "worker-session", "Runtime.evaluate", map[string]any{"expression": "globalThis.__obuManagedUser.request({\"operation\":\"" + operation + "\"})", "uniqueContextId": "original-context", "awaitPromise": true, "returnByValue": true})
		if err != nil {
			t.Fatal(err)
		}
		return call
	}
	first := start(context.Background(), "status")
	beginCtx, cancel := context.WithCancel(context.Background())
	begin := start(beginCtx, "humanBegin")
	bad, err := c.cdp.start(context.Background(), "worker-session", "Runtime.evaluate", map[string]any{"notJSON": func() {}})
	if err != nil {
		t.Fatal(err)
	}
	end := start(context.Background(), "humanEnd")
	cancel()
	select {
	case <-bad.done:
		t.Fatal("marshal failure released its predecessor barrier early")
	default:
	}
	<-c.cdp.writeGate
	if req := userWait(t, seen); req.Operation != "status" {
		t.Fatalf("cleanup overtook original write: %s", req.Operation)
	}
	if req := userWait(t, seen); req.Operation != "humanEnd" {
		t.Fatalf("canceled Begin was submitted: %s", req.Operation)
	}
	ctx, finish := context.WithTimeout(context.Background(), time.Second)
	defer finish()
	if _, err := first.wait(ctx); err != nil {
		t.Fatal(err)
	}
	if _, err := begin.wait(ctx); !errors.Is(err, context.Canceled) {
		t.Fatalf("canceled Begin receipt %v", err)
	}
	if _, err := bad.wait(ctx); err == nil {
		t.Fatal("marshal failure lost")
	}
	if _, err := end.wait(ctx); err != nil {
		t.Fatal(err)
	}
}

func TestManagedUserKnownHumanErrorDoesNotMatchDiagnosticSubstring(t *testing.T) {
	for _, description := range []string{"Error: OBU_HUMAN_STALE: original lease expired", "Error: private detail contains OBU_HUMAN_STALE: misleading", "Error: OBU_HUMAN_STALE_EXTRA: not the known code"} {
		data, _ := json.Marshal(map[string]any{"result": map[string]any{"description": description}, "exceptionDetails": map[string]any{"text": "Uncaught"}})
		_, err := bridgeValue(data)
		var rejected *userBridgeError
		if !errors.As(err, &rejected) {
			t.Fatal("missing bounded error")
		}
		if (rejected.code == "OBU_HUMAN_STALE") != (description == "Error: OBU_HUMAN_STALE: original lease expired") {
			t.Fatalf("diagnostic classified as exact known code: %s", description)
		}
	}
}

func TestManagedHumanLateCleanupCannotClearSuccessorBeginRisk(t *testing.T) {
	for _, operation := range []string{"pause", "select", "humanEnd"} {
		t.Run(operation, func(t *testing.T) {
			held := make(chan userTestRequest, 1)
			f := newUserFixture(t, func(f *userFixture, req userTestRequest) bool {
				if req.Operation == operation {
					held <- req
					return true
				}
				if req.Operation == "humanBegin" {
					f.evaluated(req, map[string]any{"status": humanFixtureState(f)})
					return true
				}
				return false
			}, false)
			c := f.open()
			cleanup := map[string]any{"operation": operation}
			if operation == "select" {
				cleanup["tabId"] = nil
			}
			if operation == "humanEnd" {
				cleanup["leaseId"] = "retired-lease"
			}
			encoded, _ := json.Marshal(cleanup)
			result := make(chan error, 1)
			go func() { _, err := c.Command(context.Background(), encoded); result <- err }()
			old := userWait(t, held)
			if _, err := c.Command(context.Background(), json.RawMessage(`{"operation":"humanBegin","tabId":7}`)); err != nil {
				t.Fatal(err)
			}
			state := f.status()
			state["selectedTabId"], state["cleanupPending"], state["human"] = nil, 0, nil
			state["humanCleanup"] = map[string]any{"leaseId": "retired-lease", "cleanupConfirmed": true}
			f.evaluated(old, map[string]any{"status": state})
			if err := userWait(t, result); err != nil {
				t.Fatal(err)
			}
			c.mu.Lock()
			risk := c.humanRisk
			c.mu.Unlock()
			if !risk {
				t.Fatal("older cleanup reply cleared the successor Begin's risk")
			}
		})
	}
}

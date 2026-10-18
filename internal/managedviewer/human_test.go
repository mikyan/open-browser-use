package managedviewer

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"reflect"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/coder/websocket"
)

// These tests use the real loopback HTTP/WebSocket server and an explicitly
// simulated backend. A simulated receipt is not browser/native acceptance.
const humanTestLease = "original-human-lease"

func humanTestState(active bool, sequence uint64) json.RawMessage {
	state := map[string]any{
		"connected": true, "workerBootId": "worker-a", "eventSequence": sequence + 2,
		"cleanupPending": 0, "selectedTabId": nil, "tabs": []any{}, "human": nil,
		"automation": map[string]any{"state": "paused", "inputBlocked": true, "revision": 8, "cleanupComplete": true},
	}
	if active {
		state["selectedTabId"] = 1
		state["tabs"] = []any{map[string]any{"id": 1, "title": "Synthetic", "url": "https://fixture.invalid/"}}
		state["human"] = map[string]any{"state": "active", "leaseId": humanTestLease, "tabId": 1, "generation": 1, "viewport": map[string]any{"width": 640, "height": 480}, "lastInputSequence": sequence}
	} else {
		state["eventSequence"] = 100
		state["humanCleanup"] = map[string]any{"leaseId": humanTestLease, "cleanupConfirmed": true}
	}
	return jsonBytes(map[string]any{"status": state})
}

func humanTestInputResult(data json.RawMessage) json.RawMessage {
	f, _ := object(data)
	var sequence uint64
	_ = json.Unmarshal(f["sequence"], &sequence)
	result, _ := object(humanTestState(true, sequence))
	result["inputReceipt"] = jsonBytes(map[string]any{"leaseId": humanTestLease, "generation": 1, "sequence": sequence, "acknowledged": true})
	return jsonBytes(result)
}

func humanTestOperation(data json.RawMessage) string {
	var value struct{ Operation string }
	_ = json.Unmarshal(data, &value)
	return value.Operation
}

func humanTestBackend() *testBackend {
	b := newBackend()
	b.command = func(_ context.Context, data json.RawMessage) (json.RawMessage, error) {
		switch humanTestOperation(data) {
		case "humanBegin", "status":
			return humanTestState(true, 0), nil
		case "humanInput":
			return humanTestInputResult(data), nil
		default:
			return humanTestState(false, 0), nil
		}
	}
	return b
}

func humanTestReply(t *testing.T, c *websocket.Conn, id uint64) map[string]json.RawMessage {
	t.Helper()
	for {
		m := readMessage(t, c)
		if string(m["type"]) == `"response"` && string(m["id"]) == fmt.Sprint(id) {
			return m
		}
	}
}

func humanTestSuccess(t *testing.T, c *websocket.Conn, id uint64) json.RawMessage {
	t.Helper()
	m := humanTestReply(t, c, id)
	if m["error"] != nil || m["result"] == nil {
		t.Fatalf("unconfirmed response %d: %s", id, jsonBytes(m))
	}
	return m["result"]
}

func humanTestError(t *testing.T, c *websocket.Conn, id uint64, code string) {
	t.Helper()
	m := humanTestReply(t, c, id)
	var detail struct{ Code string }
	_ = json.Unmarshal(m["error"], &detail)
	if detail.Code != code || m["result"] != nil {
		t.Fatalf("response %d should be %s: %s", id, code, jsonBytes(m))
	}
}

func humanTestCall(t *testing.T, b *testBackend, operation string) json.RawMessage {
	t.Helper()
	call := waitCall(t, b)
	if humanTestOperation(call) != operation {
		t.Fatalf("expected %s, got %s", operation, call)
	}
	return call
}

func humanTestBegin(t *testing.T, b *testBackend, s *Server) *websocket.Conn {
	t.Helper()
	c := authenticate(t, s)
	send(t, c, `{"id":1,"operation":"humanBegin","tabId":1}`)
	humanTestCall(t, b, "humanBegin")
	humanTestSuccess(t, c, 1)
	humanTestFrame(t, b, c, humanTestLease, 1, 3)
	return c
}

func humanTestFrame(t *testing.T, b *testBackend, c *websocket.Conn, lease string, generation, eventSequence uint64) {
	t.Helper()
	b.events <- jsonBytes(map[string]any{"type": "frame", "sequence": eventSequence, "frameSequence": 1, "tabId": 1, "streamId": fmt.Sprintf("%s-%d", lease, generation), "mimeType": "image/png", "data": "aW1hZ2U=", "controlMode": "human", "humanLeaseId": lease, "generation": generation})
	for {
		message := readMessage(t, c)
		if string(message["type"]) == `"state"` {
			continue
		}
		if string(message["type"]) != `"frame"` || string(message["generation"]) != fmt.Sprint(generation) || string(message["humanLeaseId"]) != string(jsonBytes(lease)) {
			t.Fatalf("expected original frame: %s", jsonBytes(message))
		}
		break
	}
}

func humanTestInput(id, sequence uint64) string {
	return fmt.Sprintf(`{"id":%d,"operation":"humanInput","leaseId":%q,"generation":1,"sequence":%d,"input":{"type":"key","action":"down","key":"Shift","code":"ShiftLeft","windowsVirtualKeyCode":16}}`, id, humanTestLease, sequence)
}

func humanTestSignal(t *testing.T, signal <-chan struct{}, message string) {
	t.Helper()
	select {
	case <-signal:
	case <-time.After(3 * time.Second):
		t.Fatal(message)
	}
}

func TestHumanWebSocketOrdersInputsAndRejectsStaleAuthority(t *testing.T) {
	b := humanTestBackend()
	base := b.command
	release := make(chan struct{})
	var releaseOnce sync.Once
	b.command = func(ctx context.Context, data json.RawMessage) (json.RawMessage, error) {
		if humanTestOperation(data) == "humanInput" && strings.Contains(string(data), `"sequence":1`) {
			<-release // Original receipt deliberately outlives caller cancellation.
		}
		return base(ctx, data)
	}
	s := startTest(t, b, nil)
	t.Cleanup(func() { releaseOnce.Do(func() { close(release) }) })
	c := humanTestBegin(t, b, s)
	send(t, c, humanTestInput(2, 1))
	humanTestCall(t, b, "humanInput")
	send(t, c, humanTestInput(3, 2))
	// A status round trip is a reader barrier: input 2 has already been admitted.
	send(t, c, `{"id":4,"operation":"status"}`)
	humanTestCall(t, b, "status")
	humanTestSuccess(t, c, 4)
	select {
	case call := <-b.calls:
		t.Fatalf("second input overtook the original native receipt: %s", call)
	default:
	}
	releaseOnce.Do(func() { close(release) })
	humanTestSuccess(t, c, 2)
	second := humanTestCall(t, b, "humanInput")
	if !strings.Contains(string(second), `"sequence":2`) {
		t.Fatalf("wrong second input: %s", second)
	}
	humanTestSuccess(t, c, 3)
	for i, bad := range []string{
		humanTestInput(5, 4), // gap
		humanTestInput(6, 2), // replay
		strings.Replace(humanTestInput(7, 3), humanTestLease, "other-lease", 1),
		strings.Replace(humanTestInput(8, 3), `"generation":1`, `"generation":2`, 1),
	} {
		send(t, c, bad)
		humanTestError(t, c, uint64(5+i), "HUMAN_STALE")
	}
	send(t, c, `{"id":9,"operation":"resume","expectedRevision":8,"expectedWorkerBootId":"worker-a"}`)
	humanTestError(t, c, 9, "HUMAN_BUSY")
	select {
	case call := <-b.calls:
		t.Fatalf("stale input or Resume reached backend: %s", call)
	default:
	}
}

func TestHumanEndReleasesBeforeWaitingForOriginalInput(t *testing.T) {
	b := humanTestBackend()
	base := b.command
	inputDone, endEntered := make(chan struct{}), make(chan struct{})
	var releaseOnce sync.Once
	var inputCount atomic.Int32
	b.command = func(ctx context.Context, data json.RawMessage) (json.RawMessage, error) {
		switch humanTestOperation(data) {
		case "humanInput":
			inputCount.Add(1)
			<-inputDone
		case "humanEnd":
			close(endEntered)
			<-inputDone // Backend close joins the actual input before its receipt.
		}
		return base(ctx, data)
	}
	s := startTest(t, b, nil)
	t.Cleanup(func() { releaseOnce.Do(func() { close(inputDone) }) })
	c := humanTestBegin(t, b, s)
	send(t, c, humanTestInput(2, 1))
	humanTestCall(t, b, "humanInput")
	send(t, c, humanTestInput(3, 2))
	send(t, c, fmt.Sprintf(`{"id":4,"operation":"humanEnd","leaseId":%q}`, humanTestLease))
	humanTestSignal(t, endEntered, "End blocked behind original input")
	humanTestCall(t, b, "humanEnd")
	if inputCount.Load() != 1 {
		t.Fatal("queued input escaped End revocation")
	}
	releaseOnce.Do(func() { close(inputDone) })
	ended := humanTestSuccess(t, c, 4)
	if !strings.Contains(string(ended), `"cleanupConfirmed":true`) || !strings.Contains(string(ended), `"human":null`) {
		t.Fatalf("End lacked original cleanup: %s", ended)
	}
	send(t, c, humanTestInput(5, 3))
	humanTestError(t, c, 5, "HUMAN_STALE")
	if inputCount.Load() != 1 {
		t.Fatal("input replayed after End")
	}
}

func TestHumanDisconnectWaitReadyJoinsCleanupAndOriginalInput(t *testing.T) {
	b := humanTestBackend()
	base := b.command
	inputDone, cleanupDone, cleanupEntered := make(chan struct{}), make(chan struct{}), make(chan struct{})
	var inputOnce, cleanupOnce, enteredOnce sync.Once
	b.command = func(ctx context.Context, data json.RawMessage) (json.RawMessage, error) {
		switch humanTestOperation(data) {
		case "humanInput":
			<-inputDone
		case "select":
			enteredOnce.Do(func() { close(cleanupEntered) })
			<-cleanupDone
		}
		return base(ctx, data)
	}
	s := startTest(t, b, nil)
	t.Cleanup(func() { inputOnce.Do(func() { close(inputDone) }); cleanupOnce.Do(func() { close(cleanupDone) }) })
	c := humanTestBegin(t, b, s)
	send(t, c, humanTestInput(2, 1))
	humanTestCall(t, b, "humanInput")
	_ = c.CloseNow()
	humanTestSignal(t, cleanupEntered, "disconnect waited for held input before revoking it")
	humanTestCall(t, b, "select")
	oldURL := s.URL()
	assertBlocked := func() {
		t.Helper()
		ctx, cancel := context.WithTimeout(context.Background(), 20*time.Millisecond)
		defer cancel()
		if err := s.WaitReady(ctx); !errors.Is(err, context.DeadlineExceeded) {
			t.Fatalf("WaitReady claimed cleanup early: %v", err)
		}
		if _, err := s.IssueURL(); err == nil || s.URL() != oldURL {
			t.Fatal("pending cleanup minted a replacement ticket")
		}
	}
	assertBlocked()
	cleanupOnce.Do(func() { close(cleanupDone) })
	assertBlocked() // Even a cleanup receipt cannot discard an original caller.
	inputOnce.Do(func() { close(inputDone) })
	ctx, cancel := context.WithTimeout(context.Background(), time.Second)
	defer cancel()
	if err := s.WaitReady(ctx); err != nil {
		t.Fatal(err)
	}
	if s.URL() != oldURL {
		t.Fatal("WaitReady itself issued a ticket")
	}
	fresh, err := s.IssueURL()
	if err != nil || fresh == oldURL {
		t.Fatalf("no fresh ticket after real cleanup: %v", err)
	}
	reconnected := dialViewer(t, s, fresh)
	if string(readMessage(t, reconnected)["type"]) != `"authenticated"` {
		t.Fatal("fresh connection failed")
	}
	send(t, reconnected, humanTestInput(1, 2))
	humanTestError(t, reconnected, 1, "HUMAN_STALE")
}

func TestHumanInputRequiresExactOriginalReceiptBeforeNextDispatch(t *testing.T) {
	for _, wrong := range []string{"lease", "generation", "sequence", "acknowledged", "missing"} {
		t.Run(wrong, func(t *testing.T) {
			b := humanTestBackend()
			base := b.command
			release := make(chan struct{})
			var once sync.Once
			var inputs atomic.Int32
			b.command = func(ctx context.Context, data json.RawMessage) (json.RawMessage, error) {
				if humanTestOperation(data) != "humanInput" {
					return base(ctx, data)
				}
				inputs.Add(1)
				<-release
				f, _ := object(humanTestInputResult(data))
				receipt, _ := object(f["inputReceipt"])
				switch wrong {
				case "lease":
					receipt["leaseId"] = jsonBytes("successor")
				case "generation":
					receipt["generation"] = jsonBytes(2)
				case "sequence":
					receipt["sequence"] = jsonBytes(2)
				case "acknowledged":
					receipt["acknowledged"] = jsonBytes(false)
				}
				f["inputReceipt"] = jsonBytes(receipt)
				if wrong == "missing" {
					delete(f, "inputReceipt")
				}
				return jsonBytes(f), nil
			}
			s := startTest(t, b, nil)
			t.Cleanup(func() { once.Do(func() { close(release) }) })
			c := humanTestBegin(t, b, s)
			send(t, c, humanTestInput(2, 1))
			humanTestCall(t, b, "humanInput")
			send(t, c, humanTestInput(3, 2))
			send(t, c, `{"id":4,"operation":"status"}`)
			humanTestCall(t, b, "status")
			humanTestSuccess(t, c, 4)
			once.Do(func() { close(release) })
			humanTestError(t, c, 2, "OPERATION_UNCONFIRMED")
			humanTestCall(t, b, "select")
			if inputs.Load() != 1 {
				t.Fatal("wrong receipt advanced the input lane")
			}
		})
	}
}

func TestHumanDisconnectUnconfirmedCleanupCannotReissue(t *testing.T) {
	for _, wrong := range []string{"missing", "successor", "pending", "still-active", "worker-terminated"} {
		t.Run(wrong, func(t *testing.T) {
			b := humanTestBackend()
			base := b.command
			b.command = func(ctx context.Context, data json.RawMessage) (json.RawMessage, error) {
				if humanTestOperation(data) != "select" {
					return base(ctx, data)
				}
				if wrong == "worker-terminated" {
					return json.RawMessage(`{"cleanupConfirmed":true,"cleanupProof":"worker-terminated"}`), nil
				}
				f, _ := object(humanTestState(false, 0))
				state, _ := object(f["status"])
				switch wrong {
				case "missing":
					delete(state, "humanCleanup")
				case "successor":
					state["humanCleanup"] = json.RawMessage(`{"leaseId":"successor","cleanupConfirmed":true}`)
				case "pending":
					state["cleanupPending"] = jsonBytes(1)
				case "still-active":
					active, _ := object(humanTestState(true, 0))
					activeState, _ := object(active["status"])
					state["human"] = activeState["human"]
				}
				f["status"] = jsonBytes(state)
				return jsonBytes(f), nil
			}
			s, err := Start(Config{RunID: "unconfirmed-human", Backend: b, Stop: func(context.Context) error { return nil }})
			if err != nil {
				t.Fatal(err)
			}
			t.Cleanup(func() {
				ctx, cancel := context.WithTimeout(context.Background(), time.Second)
				defer cancel()
				_ = s.Close(ctx)
			})
			c := humanTestBegin(t, b, s)
			_ = c.CloseNow()
			waitNoActive(t, s)
			if err := s.WaitReady(context.Background()); err == nil {
				t.Fatal("unconfirmed original human cleanup allowed WaitReady")
			}
			if _, err := s.IssueURL(); err == nil {
				t.Fatal("unconfirmed original human cleanup issued a ticket")
			}
			ctx, cancel := context.WithTimeout(context.Background(), time.Second)
			defer cancel()
			if err := s.Close(ctx); err == nil {
				t.Fatal("cleanup failure disappeared at Close")
			}
		})
	}
}

func TestHumanOnlyOriginalSessionTerminationSubstitutesForRelease(t *testing.T) {
	b := humanTestBackend()
	base := b.command
	b.command = func(ctx context.Context, data json.RawMessage) (json.RawMessage, error) {
		if humanTestOperation(data) == "select" {
			return json.RawMessage(`{"cleanupConfirmed":true,"cleanupProof":"session-terminated"}`), nil
		}
		return base(ctx, data)
	}
	s := startTest(t, b, nil)
	c := humanTestBegin(t, b, s)
	_ = c.CloseNow()
	ctx, cancel := context.WithTimeout(context.Background(), time.Second)
	defer cancel()
	if err := s.WaitReady(ctx); err != nil {
		t.Fatal(err)
	}
	if _, err := s.IssueURL(); err != nil {
		t.Fatal(err)
	}
}

func TestHumanWireRejectsOversizedAndDuplicateTypedCommands(t *testing.T) {
	for name, bad := range map[string]string{
		"oversized":             strings.Repeat(" ", 32<<10) + humanTestInput(2, 1),
		"duplicate-id":          strings.Replace(humanTestInput(2, 1), `"id":2`, `"id":2,"id":3`, 1),
		"duplicate-generation":  strings.Replace(humanTestInput(2, 1), `"generation":1`, `"generation":1,"generation":2`, 1),
		"duplicate-input-field": strings.Replace(humanTestInput(2, 1), `"key":"Shift"`, `"key":"Shift","key":"Control"`, 1),
		"unknown-input":         strings.Replace(humanTestInput(2, 1), `"type":"key"`, `"type":"evaluate"`, 1),
		"repeated-command-id":   humanTestInput(1, 1),
	} {
		t.Run(name, func(t *testing.T) {
			b := humanTestBackend()
			s := startTest(t, b, nil)
			c := humanTestBegin(t, b, s)
			ctx, cancel := context.WithTimeout(context.Background(), time.Second)
			defer cancel()
			_ = c.Write(ctx, websocket.MessageText, []byte(bad))
			if _, _, err := c.Read(ctx); err == nil {
				t.Fatal("invalid typed command kept its connection")
			}
			humanTestCall(t, b, "select")
			waitNoActive(t, s)
			select {
			case call := <-b.calls:
				t.Fatalf("invalid input dispatched: %s", call)
			default:
			}
		})
	}
}

func TestHumanCanonicalBridgeFixtureProjectsFiveResponses(t *testing.T) {
	data, err := os.ReadFile("testdata/bridge-fixture.json")
	if err != nil {
		t.Fatal(err)
	}
	var fixture map[string]json.RawMessage
	if err := json.Unmarshal(data, &fixture); err != nil {
		t.Fatal(err)
	}
	for _, name := range []string{"humanBegin", "humanStatus", "humanInput", "humanEnd", "humanResume"} {
		t.Run(name, func(t *testing.T) {
			projected, err := publicState(fixture[name])
			if err != nil {
				t.Fatal(err)
			}
			f, _ := object(projected)
			for _, private := range []string{"channelId", "runId", "extensionId", "portId", "targetId", "documentId", "lastInputSequence"} {
				if strings.Contains(string(projected), `"`+private+`"`) {
					t.Fatalf("private %s leaked: %s", private, projected)
				}
			}
			if name == "humanInput" && f["inputReceipt"] == nil || name == "humanEnd" && f["humanCleanup"] == nil {
				t.Fatalf("original receipt was omitted: %s", projected)
			}
			if name == "humanBegin" && (!strings.Contains(string(f["human"]), `"generation":0`) || !strings.Contains(string(f["human"]), `"viewport":null`)) {
				t.Fatal("fixture must exercise first-frame readiness")
			}
		})
	}
}

func TestHumanPausedEarlyFrameSurvivesBeginAndLatestGeometryWins(t *testing.T) {
	b := humanTestBackend()
	base := b.command
	beginDone := make(chan struct{})
	var once sync.Once
	b.command = func(ctx context.Context, data json.RawMessage) (json.RawMessage, error) {
		if humanTestOperation(data) != "humanBegin" {
			return base(ctx, data)
		}
		<-beginDone
		f, _ := object(humanTestState(true, 0))
		state, _ := object(f["status"])
		human, _ := object(state["human"])
		human["generation"] = jsonBytes(0)
		state["human"] = jsonBytes(human)
		f["status"] = jsonBytes(state)
		return jsonBytes(f), nil
	}
	s := startTest(t, b, nil)
	t.Cleanup(func() { once.Do(func() { close(beginDone) }) })
	c := authenticate(t, s)
	send(t, c, `{"id":1,"operation":"humanBegin","tabId":1}`)
	humanTestCall(t, b, "humanBegin")
	// Pause may publish before the backend Begin returns a handle. Its null
	// human field must not retire the first frame already in transit.
	f, _ := object(humanTestState(false, 0))
	state, _ := object(f["status"])
	state["eventSequence"] = jsonBytes(3)
	delete(state, "humanCleanup")
	b.events <- jsonBytes(map[string]any{"type": "status", "sequence": 3, "status": state})
	m := readMessage(t, c)
	if string(m["type"]) != `"state"` || string(m["retiredSequence"]) != "0" {
		t.Fatalf("pending Begin wrongly retired paused snapshot: %s", jsonBytes(m))
	}
	// Every new generation is published before its first frame, even while
	// the original generation-zero Begin reply is still pending.
	f, _ = object(humanTestState(true, 0))
	state, _ = object(f["status"])
	state["eventSequence"] = jsonBytes(4)
	b.events <- jsonBytes(map[string]any{"type": "status", "sequence": 4, "status": state})
	if string(readMessage(t, c)["type"]) != `"state"` {
		t.Fatal("missing generation status")
	}
	b.events <- json.RawMessage(`{"type":"frame","sequence":5,"frameSequence":1,"tabId":1,"streamId":"original-human-stream","mimeType":"image/png","data":"aW1hZ2U=","controlMode":"human","humanLeaseId":"original-human-lease","generation":1,"targetId":"PRIVATE_TARGET"}`)
	m = readMessage(t, c)
	if string(m["type"]) != `"frame"` || string(m["controlMode"]) != `"human"` || string(m["generation"]) != "1" || m["targetId"] != nil || string(m["retiredSequence"]) != "0" {
		t.Fatalf("early paused human frame lost identity: %s", jsonBytes(m))
	}
	// The state corresponding to that frame can arrive before the original
	// generation-zero Begin response. Input uses the newer original geometry.
	f, _ = object(humanTestState(true, 0))
	state, _ = object(f["status"])
	state["eventSequence"] = jsonBytes(6)
	b.events <- jsonBytes(map[string]any{"type": "status", "sequence": 6, "status": state})
	if string(readMessage(t, c)["type"]) != `"state"` {
		t.Fatal("missing first-frame state")
	}
	once.Do(func() { close(beginDone) })
	humanTestSuccess(t, c, 1)
	send(t, c, humanTestInput(2, 1))
	humanTestCall(t, b, "humanInput")
	humanTestSuccess(t, c, 2)
}

type humanTestStaleError struct{}

func (humanTestStaleError) Error() string         { return "private native target and channel details" }
func (humanTestStaleError) UserErrorCode() string { return "OBU_HUMAN_STALE" }

func TestHumanBackendStaleErrorIsPreciseAndDoesNotLeak(t *testing.T) {
	b := humanTestBackend()
	base := b.command
	b.command = func(ctx context.Context, data json.RawMessage) (json.RawMessage, error) {
		if humanTestOperation(data) == "humanInput" {
			return nil, humanTestStaleError{}
		}
		return base(ctx, data)
	}
	s := startTest(t, b, nil)
	c := humanTestBegin(t, b, s)
	send(t, c, humanTestInput(2, 1))
	humanTestCall(t, b, "humanInput")
	m := humanTestReply(t, c, 2)
	if !strings.Contains(string(m["error"]), `"code":"HUMAN_STALE"`) || strings.Contains(string(jsonBytes(m)), "private native") {
		t.Fatalf("stale result lost code or leaked internals: %s", jsonBytes(m))
	}
	humanTestCall(t, b, "select")
}

func TestHumanPublicProjectionRejectsContradictoryAuthority(t *testing.T) {
	for _, bad := range []string{"running", "negative-generation", "active-without-viewport", "false-cleanup", "false-input-receipt"} {
		t.Run(bad, func(t *testing.T) {
			f, _ := object(humanTestState(true, 0))
			state, _ := object(f["status"])
			human, _ := object(state["human"])
			switch bad {
			case "running":
				state["automation"] = json.RawMessage(`{"state":"running","inputBlocked":false,"revision":8,"cleanupComplete":false}`)
			case "negative-generation":
				human["generation"] = jsonBytes(-1)
			case "active-without-viewport":
				human["viewport"] = jsonBytes(nil)
			case "false-cleanup":
				state["humanCleanup"] = json.RawMessage(`{"leaseId":"original-human-lease","cleanupConfirmed":false}`)
			case "false-input-receipt":
				f["inputReceipt"] = json.RawMessage(`{"leaseId":"original-human-lease","generation":1,"sequence":1,"acknowledged":false}`)
			}
			state["human"] = jsonBytes(human)
			f["status"] = jsonBytes(state)
			if result, err := publicState(jsonBytes(f)); err == nil {
				t.Fatalf("contradictory human authority projected: %s", result)
			}
		})
	}
	for _, bad := range []string{
		`"controlMode":"human","humanLeaseId":"original","generation":0`,
		`"controlMode":"observe","humanLeaseId":"original","generation":1`,
		`"humanLeaseId":"original","generation":1`,
	} {
		event := `{"type":"frame","sequence":4,"frameSequence":1,"tabId":1,"streamId":"s","mimeType":"image/png","data":"aW1hZ2U=",` + bad + `}`
		if _, result, err := publicEvent([]byte(event)); err == nil {
			t.Fatalf("invalid frame identity projected: %s", result)
		}
	}
}

func TestHumanPublicFixtureEqualsActualGoProjection(t *testing.T) {
	bridgeBytes, err := os.ReadFile("testdata/bridge-fixture.json")
	if err != nil {
		t.Fatal(err)
	}
	publicBytes, err := os.ReadFile("testdata/public-human-fixture.json")
	if err != nil {
		t.Fatal(err)
	}
	var bridge map[string]json.RawMessage
	var expected map[string]any
	if json.Unmarshal(bridgeBytes, &bridge) != nil || json.Unmarshal(publicBytes, &expected) != nil {
		t.Fatal("invalid shared UI protocol fixture")
	}
	actual := map[string]any{}
	for _, name := range []string{"open", "select", "humanBegin", "humanStatus", "humanInput", "humanEnd", "humanResume"} {
		data, err := publicState(bridge[name])
		if err != nil {
			t.Fatalf("%s: %v", name, err)
		}
		var value any
		_ = json.Unmarshal(data, &value)
		actual[name] = value
	}
	var events []json.RawMessage
	_ = json.Unmarshal(bridge["events"], &events)
	for _, event := range events {
		f, _ := object(event)
		if string(f["type"]) != `"frame"` || string(f["controlMode"]) != `"human"` {
			continue
		}
		_, public, err := publicEvent(event)
		if err != nil {
			t.Fatal(err)
		}
		var value any
		_ = json.Unmarshal(public, &value)
		actual["humanFrame"] = value
		break
	}
	if updatePublicFixture(t, "testdata/public-human-fixture.json", actual) {
		expected = actual
	}
	if !reflect.DeepEqual(actual, expected) {
		t.Fatalf("UI public fixture drifted from real Go projection:\nactual %s\nexpected %s", jsonBytes(actual), jsonBytes(expected))
	}
}

func TestHumanLateFailureCannotRevokeSuccessorLease(t *testing.T) {
	for _, original := range []string{"humanInput", "humanBegin"} {
		t.Run(original, func(t *testing.T) {
			b := humanTestBackend()
			base := b.command
			oldDone := make(chan struct{})
			var once sync.Once
			var begins atomic.Int32
			b.command = func(ctx context.Context, data json.RawMessage) (json.RawMessage, error) {
				op := humanTestOperation(data)
				if op == "humanBegin" {
					n := begins.Add(1)
					if original == "humanBegin" && n == 1 {
						<-oldDone
						return nil, errors.New("old Begin failed after release")
					}
					if n > 1 {
						return json.RawMessage(strings.ReplaceAll(strings.ReplaceAll(string(humanTestState(true, 0)), humanTestLease, "successor-lease"), `"eventSequence":2`, `"eventSequence":101`)), nil
					}
				}
				if op == "humanInput" && strings.Contains(string(data), humanTestLease) {
					<-oldDone
					return nil, errors.New("old native input failed after release")
				}
				result, err := base(ctx, data)
				if begins.Load() > 1 {
					result = json.RawMessage(strings.ReplaceAll(strings.ReplaceAll(string(result), humanTestLease, "successor-lease"), `"eventSequence":3`, `"eventSequence":102`))
				}
				return result, err
			}
			s := startTest(t, b, nil)
			t.Cleanup(func() { once.Do(func() { close(oldDone) }) })
			c := authenticate(t, s)
			send(t, c, `{"id":1,"operation":"humanBegin","tabId":1}`)
			humanTestCall(t, b, "humanBegin")
			oldID := uint64(1)
			if original == "humanInput" {
				humanTestSuccess(t, c, 1)
				humanTestFrame(t, b, c, humanTestLease, 1, 3)
				send(t, c, humanTestInput(2, 1))
				humanTestCall(t, b, "humanInput")
				oldID = 2
			}
			// A pending Begin has not issued a lease, so unsubscribe is its
			// release barrier. An established input uses explicit original End.
			if original == "humanBegin" {
				send(t, c, `{"id":3,"operation":"select","tabId":null}`)
				humanTestCall(t, b, "select")
			} else {
				send(t, c, fmt.Sprintf(`{"id":3,"operation":"humanEnd","leaseId":%q}`, humanTestLease))
				humanTestCall(t, b, "humanEnd")
			}
			humanTestSuccess(t, c, 3)
			send(t, c, `{"id":4,"operation":"humanBegin","tabId":1}`)
			humanTestCall(t, b, "humanBegin")
			humanTestSuccess(t, c, 4)
			once.Do(func() { close(oldDone) })
			humanTestError(t, c, oldID, "OPERATION_UNCONFIRMED")
			humanTestFrame(t, b, c, "successor-lease", 1, 103)
			send(t, c, strings.Replace(humanTestInput(5, 1), humanTestLease, "successor-lease", 1))
			humanTestCall(t, b, "humanInput") // No old select:null may intervene.
			humanTestSuccess(t, c, 5)
		})
	}
}

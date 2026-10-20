package managedbrowser

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/coder/websocket"
)

type userTestRequest struct {
	ID        uint64          `json:"id"`
	SessionID string          `json:"sessionId"`
	Method    string          `json:"method"`
	Params    json.RawMessage `json:"params"`
	Operation string
	Arguments map[string]json.RawMessage
}

func TestManagedUserLifecycleDiagnosticsAreFixedCodesOnly(t *testing.T) {
	known := []string{
		"OBU_MANAGED_JOURNAL_UNCONFIRMED",
		"OBU_MANAGED_WORKER_RECOVERY_REQUIRED", "OBU_MANAGED_WORKER_UNAVAILABLE",
		"OBU_MANAGED_NATIVE_CHANGED", "OBU_MANAGED_NATIVE_PAUSE_INCOMPLETE", "OBU_MANAGED_NATIVE_RECOVERY_REQUIRED",
		"OBU_NATIVE_RECOVERY_PENDING", "OBU_NATIVE_RECOVERY_FAILED", "OBU_NATIVE_CONNECTION_LOST",
		"OBU_MANAGED_RESULT_UNAVAILABLE", "OBU_MANAGED_RESULT_STALE", "OBU_MANAGED_RESULT_CAPACITY",
		"OBU_BROWSER_LIFETIME_INVALID", "OBU_INPUT_RELEASE_UNCONFIRMED", "OBU_INPUT_RISK_LIMIT",
	}
	check := func(description, expected string) {
		t.Helper()
		data, _ := json.Marshal(map[string]any{
			"result":           map[string]any{"description": description},
			"exceptionDetails": map[string]any{"text": "private-key", "exception": map[string]any{"description": "private stack and expression"}},
		})
		value, err := bridgeValue(data)
		var rejected *userBridgeError
		if value != nil || !errors.As(err, &rejected) || rejected.UserErrorCode() != expected || err.Error() != "managed user bridge rejected request: "+expected {
			t.Fatalf("diagnostic did not retain only its fixed code: %v", err)
		}
	}
	for _, code := range known {
		t.Run(code, func(t *testing.T) {
			check("Error: "+code+": private-key\n    at private-stack", code)
			check(code+": private-key", code)
			check("Error: "+code+"_PRIVATE_KEY: private diagnostic", "UNKNOWN")
			check("Error: "+code+" : private diagnostic", "UNKNOWN")
			check("Error: "+code+"\n: private diagnostic", "UNKNOWN")
			check("Error: private diagnostic contains "+code+": misleading", "UNKNOWN")
			check("Error: "+code, "UNKNOWN")
		})
	}
	for _, code := range []string{"OBU_MANAGED_JOURNAL_PRIVATE_KEY", "OBU_MANAGED_WORKER_PRIVATE_KEY", "OBU_NATIVE_PRIVATE_KEY", "OBU_PRIVATE_KEY"} {
		check("Error: "+code+": private diagnostic", "UNKNOWN")
	}
}

func TestManagedUserInitialOpenRetainsFixedJournalFailure(t *testing.T) {
	f := newUserFixture(t, func(f *userFixture, req userTestRequest) bool {
		if req.Operation != "open" {
			return false
		}
		if req.Arguments["recovery"] != nil {
			t.Error("initial open unexpectedly sent replacement recovery")
		}
		f.rejected(req, "OBU_MANAGED_JOURNAL_UNCONFIRMED")
		return true
	}, false)
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()
	identity := f.identity
	identity.ChannelID = ""
	var retained *UserController
	controller, err := openUserControllerRetained(ctx, f.endpoint(), identity, f.owner, nil, func(c *UserController) { retained = c })
	var rejected *userBridgeError
	if controller != nil || retained == nil || !errors.As(err, &rejected) || rejected.UserErrorCode() != "OBU_MANAGED_JOURNAL_UNCONFIRMED" || strings.Contains(err.Error(), "private") {
		t.Fatalf("initial open lost its bounded journal diagnostic: %v", err)
	}
	f.ownerOnce.Do(func() { close(f.owner) })
	if retained != nil {
		if err := retained.Close(ctx); err != nil {
			t.Fatal(err)
		}
	}
}

type userFixture struct {
	t          *testing.T
	server     *httptest.Server
	conn       *websocket.Conn
	ready      chan struct{}
	owner      chan struct{}
	ownerOnce  sync.Once
	mu         sync.Mutex
	requests   []userTestRequest
	identity   managedUserIdentity
	contextUID string
	contextID  int64
	targetID   string
	sequence   uint64
	selected   any
	revision   uint64
	paused     bool
	intercept  func(*userFixture, userTestRequest) bool
	duplicate  bool
}

func newUserFixture(t *testing.T, intercept func(*userFixture, userTestRequest) bool, duplicate bool) *userFixture {
	t.Helper()
	f := &userFixture{t: t, ready: make(chan struct{}), owner: make(chan struct{}), intercept: intercept, duplicate: duplicate,
		identity:   managedUserIdentity{Version: 1, RunID: strings.Repeat("a", 32), ExtensionID: strings.Repeat("b", 32), ExtensionInstanceID: "installation", WorkerBootID: "worker-boot", PortID: "native-port", ChannelID: "channel-id"},
		contextUID: "original-context", contextID: 7, targetID: "owned-worker"}
	f.server = httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		conn, err := websocket.Accept(w, r, nil)
		if err != nil {
			return
		}
		defer conn.CloseNow()
		conn.SetReadLimit(userReadLimit)
		f.conn = conn
		close(f.ready)
		for {
			_, data, err := conn.Read(context.Background())
			if err != nil {
				return
			}
			var req userTestRequest
			if json.Unmarshal(data, &req) != nil {
				return
			}
			if req.Method == "Runtime.evaluate" {
				var p struct {
					Expression                  string
					UniqueContextID             string `json:"uniqueContextId"`
					AwaitPromise, ReturnByValue bool
				}
				_ = json.Unmarshal(req.Params, &p)
				if p.UniqueContextID != f.contextUID || !p.AwaitPromise || !p.ReturnByValue {
					t.Errorf("unfenced evaluation: %s", req.Params)
					return
				}
				for _, method := range []string{"open", "request"} {
					prefix := "globalThis.__obuManagedUser." + method + "("
					if strings.HasPrefix(p.Expression, prefix) && strings.HasSuffix(p.Expression, ")") {
						_ = json.Unmarshal([]byte(strings.TrimSuffix(strings.TrimPrefix(p.Expression, prefix), ")")), &req.Arguments)
						req.Operation = method
						break
					}
				}
				if req.Operation == "request" {
					_ = json.Unmarshal(req.Arguments["operation"], &req.Operation)
				}
				if req.Operation == "" {
					t.Error("arbitrary evaluation submitted")
					return
				}
			}
			f.mu.Lock()
			f.requests = append(f.requests, req)
			f.mu.Unlock()
			if f.intercept != nil && f.intercept(f, req) {
				continue
			}
			f.respond(req)
		}
	}))
	t.Cleanup(func() {
		f.ownerOnce.Do(func() { close(f.owner) })
		select {
		case <-f.ready:
			_ = f.conn.CloseNow()
		default:
		}
		f.server.Close()
	})
	return f
}

func (f *userFixture) endpoint() string {
	return strings.Replace(f.server.URL, "http:", "ws:", 1) + "/devtools/browser/original"
}
func (f *userFixture) write(value any) {
	f.t.Helper()
	data, _ := json.Marshal(value)
	ctx, cancel := context.WithTimeout(context.Background(), time.Second)
	defer cancel()
	_ = f.conn.Write(ctx, websocket.MessageText, data)
}
func (f *userFixture) reply(req userTestRequest, result any) {
	value := map[string]any{"id": req.ID, "result": result}
	if req.SessionID != "" {
		value["sessionId"] = req.SessionID
	}
	f.write(value)
}
func (f *userFixture) evaluated(req userTestRequest, value any) {
	f.reply(req, map[string]any{"result": map[string]any{"type": "object", "value": value}})
}
func (f *userFixture) rejected(req userTestRequest, code string) {
	f.reply(req, map[string]any{"result": map[string]any{"type": "object", "description": "Error: " + code + ": private diagnostic"}, "exceptionDetails": map[string]any{"text": "Uncaught (in promise)"}})
}
func (f *userFixture) status() map[string]any {
	f.mu.Lock()
	defer f.mu.Unlock()
	encoded, _ := json.Marshal(f.identity)
	result := map[string]any{}
	_ = json.Unmarshal(encoded, &result)
	state := "running"
	if f.paused {
		state = "paused"
	}
	result["connected"], result["selectedTabId"], result["eventSequence"] = true, f.selected, f.sequence
	result["automation"] = map[string]any{"state": state, "inputBlocked": f.paused, "revision": f.revision, "cleanupComplete": f.paused}
	result["tabs"] = []any{map[string]any{"id": 7, "title": "Owned", "url": "https://fixture.invalid/"}}
	result["stream"] = map[string]any{"state": "idle", "streamId": nil}
	result["cleanupPending"], result["human"], result["view"] = 0, nil, nil
	return result
}
func (f *userFixture) emit(kind string, extra map[string]any) uint64 {
	f.mu.Lock()
	f.sequence++
	sequence := f.sequence
	identity := f.identity
	f.mu.Unlock()
	data, _ := json.Marshal(identity)
	value := map[string]any{}
	_ = json.Unmarshal(data, &value)
	value["type"], value["sequence"] = kind, sequence
	for k, v := range extra {
		value[k] = v
	}
	if kind == "status" {
		value["status"] = f.status()
	}
	payload, _ := json.Marshal(value)
	f.write(map[string]any{"method": "Runtime.bindingCalled", "sessionId": "worker-session", "params": map[string]any{"name": userBindingName, "executionContextId": f.contextID, "payload": string(payload)}})
	return sequence
}
func (f *userFixture) frame(stream string, sequence uint64, body []byte) uint64 {
	return f.emit("frame", map[string]any{"tabId": 7, "streamId": stream, "frameSequence": sequence, "mimeType": "image/png", "data": base64.StdEncoding.EncodeToString(body), "metadata": map[string]any{"deviceWidth": 1, "deviceHeight": 1}})
}
func (f *userFixture) respond(req userTestRequest) {
	switch req.Method {
	case "Browser.getVersion":
		f.reply(req, map[string]any{"protocolVersion": "1.3", "product": "Chrome/156.0.8078.12", "revision": "@634b046faf2137b83af71c87baf362b533af9104", "userAgent": "fixture only", "jsVersion": "fixture only"})
	case "Target.getTargets":
		targets := []any{map[string]any{"targetId": "page-must-not-attach", "type": "page", "url": "https://fixture.invalid"}, map[string]any{"targetId": "foreign-worker", "type": "service_worker", "url": "chrome-extension://foreign/background.js"}, map[string]any{"targetId": f.targetID, "type": "service_worker", "url": "chrome-extension://" + f.identity.ExtensionID + "/background.js"}}
		if f.duplicate {
			targets = append(targets, map[string]any{"targetId": "duplicate-worker", "type": "service_worker", "url": "chrome-extension://" + f.identity.ExtensionID + "/background.js"})
		}
		f.reply(req, map[string]any{"targetInfos": targets})
	case "Target.attachToTarget":
		var p struct {
			TargetID string `json:"targetId"`
			Flatten  bool
		}
		_ = json.Unmarshal(req.Params, &p)
		if p.TargetID != f.targetID || !p.Flatten {
			f.t.Errorf("foreign attach %s", req.Params)
		}
		f.reply(req, map[string]any{"sessionId": "worker-session"})
	case "Runtime.enable":
		f.write(map[string]any{"method": "Runtime.executionContextCreated", "sessionId": "worker-session", "params": map[string]any{"context": map[string]any{"id": f.contextID, "uniqueId": f.contextUID, "origin": "chrome-extension://" + f.identity.ExtensionID}}})
		f.reply(req, map[string]any{})
	case "Runtime.addBinding":
		var p struct {
			Name               string
			ExecutionContextID int64 `json:"executionContextId"`
		}
		_ = json.Unmarshal(req.Params, &p)
		if p.Name != userBindingName || p.ExecutionContextID != f.contextID {
			f.t.Errorf("unscoped binding %s", req.Params)
		}
		f.reply(req, map[string]any{})
	case "Runtime.evaluate":
		switch req.Operation {
		case "open":
			data, _ := json.Marshal(f.identity)
			value := map[string]any{}
			_ = json.Unmarshal(data, &value)
			value["status"] = f.status()
			value["recoveryState"] = map[string]any{"version": 1, "browserIncarnation": "original-browser-incarnation", "journalId": "original-journal", "workerEpoch": 1}
			f.evaluated(req, value)
		case "status":
			f.evaluated(req, map[string]any{"status": f.status()})
		case "select":
			var tab any
			_ = json.Unmarshal(req.Arguments["tabId"], &tab)
			f.mu.Lock()
			old := f.selected
			f.selected = tab
			f.mu.Unlock()
			if old != nil {
				f.emit("clear", map[string]any{"reason": "selection changed"})
			}
			f.emit("status", nil)
			f.evaluated(req, map[string]any{"status": f.status()})
		case "pause":
			f.mu.Lock()
			f.paused = true
			f.revision++
			f.selected = nil
			f.mu.Unlock()
			f.emit("clear", map[string]any{"reason": "paused"})
			f.emit("status", nil)
			f.evaluated(req, map[string]any{"status": f.status()})
		case "resume":
			f.mu.Lock()
			f.paused = false
			f.revision++
			f.mu.Unlock()
			f.emit("status", nil)
			f.evaluated(req, map[string]any{"status": f.status()})
		case "heartbeat":
			f.emit("status", nil)
			f.evaluated(req, map[string]any{"status": f.status()})
		case "ack":
			var sequence uint64
			_ = json.Unmarshal(req.Arguments["sequence"], &sequence)
			f.evaluated(req, map[string]any{"acknowledged": sequence, "workerBootId": f.identity.WorkerBootID})
		case "retire":
			f.emit("closed", map[string]any{"reason": "manager disconnected"})
			state := f.status()
			state["connected"], state["selectedTabId"] = false, nil
			f.evaluated(req, map[string]any{"disconnected": true, "status": state})
		default:
			f.t.Errorf("unsupported bridge operation %s", req.Operation)
		}
	default:
		f.reply(req, map[string]any{})
	}
}
func (f *userFixture) open() *UserController {
	f.t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), time.Second)
	defer cancel()
	identity := f.identity
	identity.ChannelID = ""
	c, err := openUserController(ctx, f.endpoint(), identity, f.owner)
	if err != nil {
		f.t.Fatal(err)
	}
	f.t.Cleanup(func() {
		f.ownerOnce.Do(func() { close(f.owner) })
		ctx, cancel := context.WithTimeout(context.Background(), time.Second)
		defer cancel()
		if err := c.Close(ctx); err != nil {
			f.t.Errorf("fixture cleanup: %v", err)
		}
	})
	return c
}
func userWait[T any](t *testing.T, ch <-chan T) T {
	t.Helper()
	select {
	case value := <-ch:
		return value
	case <-time.After(2 * time.Second):
		t.Fatal("timed out waiting for fixture")
		var zero T
		return zero
	}
}

func TestManagedUserWorkerBindingAndTypedControl(t *testing.T) {
	f := newUserFixture(t, nil, false)
	c := f.open()
	result, err := c.Command(context.Background(), json.RawMessage(`{"operation":"status"}`))
	if err != nil {
		t.Fatal(err)
	}
	if bytesContains(result, c.channelKey) {
		t.Fatal("private key in public result")
	}
	for _, payload := range []string{`{"operation":"evaluate"}`, `{"operation":"status","channelKey":"x"}`, `{"operation":"select"}`, `{"operation":"pause","operation":"resume"}`, `{"operation":"select","tabId":-1}`, `{"operation":"resume","expectedRevision":0}`, `{"operation":"resume","expectedRevision":null,"expectedWorkerBootId":"worker-boot"}`, `{"operation":"resume","expectedRevision":0,"expectedWorkerBootId":"successor-worker"}`, `{"operation":"heartbeat"}`} {
		if _, err := c.Command(context.Background(), json.RawMessage(payload)); err == nil {
			t.Fatalf("accepted %s", payload)
		}
	}
	f.mu.Lock()
	requests := append([]userTestRequest(nil), f.requests...)
	f.mu.Unlock()
	attached := 0
	for _, req := range requests {
		if req.Method == "Target.attachToTarget" {
			attached++
		}
		if req.Operation != "" && req.Operation != "open" && req.Operation != "status" {
			t.Fatalf("invalid command reached worker: %s", req.Operation)
		}
	}
	if attached != 1 {
		t.Fatalf("attachments: %d", attached)
	}
	ctx, cancel := context.WithTimeout(context.Background(), time.Second)
	defer cancel()
	if err := c.Close(ctx); err != nil {
		t.Fatal(err)
	}
	if _, err := c.Command(context.Background(), json.RawMessage(`{"operation":"select","tabId":null}`)); err != nil {
		t.Fatalf("original cleanup receipt unavailable: %v", err)
	}
	select {
	case <-c.cdp.readerDone:
	default:
		t.Fatal("reader not joined")
	}
}
func bytesContains(data []byte, value string) bool { return strings.Contains(string(data), value) }

func TestManagedUserMultiplexedRepliesAndCallerCancellation(t *testing.T) {
	held := make(chan userTestRequest, 2)
	f := newUserFixture(t, func(f *userFixture, r userTestRequest) bool {
		if r.Operation == "status" {
			held <- r
			return true
		}
		return false
	}, false)
	c := f.open()
	ctx, cancel := context.WithCancel(context.Background())
	firstResult := make(chan error, 1)
	go func() { _, err := c.Command(ctx, json.RawMessage(`{"operation":"status"}`)); firstResult <- err }()
	first := userWait(t, held)
	secondResult := make(chan error, 1)
	go func() {
		_, err := c.Command(context.Background(), json.RawMessage(`{"operation":"status"}`))
		secondResult <- err
	}()
	second := userWait(t, held)
	cancel()
	if !errors.Is(userWait(t, firstResult), context.Canceled) {
		t.Fatal("caller cancellation lost")
	}
	c.cdp.mu.Lock()
	_, pending := c.cdp.pending[first.ID]
	c.cdp.mu.Unlock()
	if !pending {
		t.Fatal("original pending call discarded")
	}
	f.evaluated(second, map[string]any{"status": f.status()})
	if err := userWait(t, secondResult); err != nil {
		t.Fatal(err)
	}
	f.evaluated(first, map[string]any{"status": f.status()})
	ctxClose, finish := context.WithTimeout(context.Background(), time.Second)
	defer finish()
	if err := c.Close(ctxClose); err != nil {
		t.Fatal(err)
	}
}

func TestManagedUserFrameLatestSlotAndNativeIndependentACK(t *testing.T) {
	acks := make(chan userTestRequest, 8)
	f := newUserFixture(t, func(f *userFixture, r userTestRequest) bool {
		if r.Operation == "ack" {
			acks <- r
		}
		return false
	}, false)
	c := f.open()
	f.frame("stream-one", 1, []byte("first"))
	userWait(t, acks)
	f.frame("stream-one", 2, []byte("second"))
	userWait(t, acks)
	f.frame("stream-one", 3, make([]byte, 4<<20))
	userWait(t, acks)
	event := userWait(t, c.Events())
	var value struct {
		FrameSequence uint64
		Data          string
	}
	if json.Unmarshal(event, &value) != nil || value.FrameSequence != 3 {
		t.Fatalf("not latest frame: %s", event[:min(len(event), 100)])
	}
	if len(value.Data) < 5<<20 {
		t.Fatal("4 MiB frame was not delivered")
	}
}

func TestManagedUserClearRetiresQueuedFrameAndOnlyKnownStaleACK(t *testing.T) {
	acks := make(chan userTestRequest, 1)
	f := newUserFixture(t, func(f *userFixture, r userTestRequest) bool {
		if r.Operation == "ack" {
			acks <- r
			return true
		}
		return false
	}, false)
	c := f.open()
	f.frame("retired-stream", 1, []byte("frame"))
	ack := userWait(t, acks)
	f.emit("clear", map[string]any{"reason": "selection changed"})
	// A frame already entering delivery may precede the clear. The invariant is
	// that no retired frame can follow the actual clear delivered to the UI.
	for {
		event := userWait(t, c.Events())
		var value struct{ Type string }
		_ = json.Unmarshal(event, &value)
		if value.Type == "clear" {
			break
		}
		if value.Type != "frame" {
			t.Fatalf("unexpected event %s", event)
		}
	}
	f.rejected(ack, "OBU_MANAGED_USER_ACK")
	ctx, cancel := context.WithTimeout(context.Background(), time.Second)
	defer cancel()
	if _, err := c.Command(ctx, json.RawMessage(`{"operation":"status"}`)); err != nil {
		t.Fatal(err)
	}
	select {
	case <-c.Done():
		t.Fatal("known retired ACK killed channel")
	default:
	}
	select {
	case event := <-c.Events():
		t.Fatalf("retired event after clear: %s", event)
	default:
	}
}

func TestManagedUserFrameAndWorkerEpochViolationsRevoke(t *testing.T) {
	for _, kind := range []string{"boot", "session", "context", "duplicate-frame", "unsafe-frame", "retired-stream"} {
		t.Run(kind, func(t *testing.T) {
			f := newUserFixture(t, nil, false)
			c := f.open()
			switch kind {
			case "boot":
				f.emit("frame", map[string]any{"workerBootId": "successor", "tabId": 7, "streamId": "s", "frameSequence": 1, "mimeType": "image/png", "data": "YQ=="})
			case "session":
				f.write(map[string]any{"sessionId": "page-session", "method": "Runtime.bindingCalled", "params": map[string]any{}})
			case "context":
				f.write(map[string]any{"sessionId": "worker-session", "method": "Runtime.executionContextCreated", "params": map[string]any{"context": map[string]any{"id": 7, "uniqueId": "successor-context"}}})
			case "duplicate-frame":
				f.frame("s", 1, []byte("a"))
				f.frame("s", 1, []byte("b"))
			case "unsafe-frame":
				f.frame("s", 1<<53, []byte("a"))
			case "retired-stream":
				f.frame("s", 1, []byte("a"))
				f.emit("clear", nil)
				f.frame("s", 2, []byte("b"))
			}
			userWait(t, c.Done())
			if _, err := c.Command(context.Background(), json.RawMessage(`{"operation":"pause"}`)); err == nil {
				t.Fatal("closed control accepted input")
			}
		})
	}
}

func TestManagedUserCloseWaitsOriginalDisconnectAndPendingSelect(t *testing.T) {
	held := make(chan userTestRequest, 2)
	f := newUserFixture(t, func(f *userFixture, r userTestRequest) bool {
		if r.Operation == "select" || r.Operation == "retire" {
			held <- r
			return true
		}
		return false
	}, false)
	c := f.open()
	callCtx, cancel := context.WithCancel(context.Background())
	result := make(chan error, 1)
	go func() {
		_, err := c.Command(callCtx, json.RawMessage(`{"operation":"select","tabId":7}`))
		result <- err
	}()
	selected := userWait(t, held)
	cancel()
	if !errors.Is(userWait(t, result), context.Canceled) {
		t.Fatal("lost caller deadline")
	}
	ctx, finish := context.WithTimeout(context.Background(), 30*time.Millisecond)
	defer finish()
	if err := c.Close(ctx); !errors.Is(err, context.DeadlineExceeded) {
		t.Fatalf("cleanup prematurely finished: %v", err)
	}
	disconnect := userWait(t, held)
	state := f.status()
	state["connected"], state["selectedTabId"] = false, nil
	f.evaluated(disconnect, map[string]any{"disconnected": true, "status": state})
	ctx2, finish2 := context.WithTimeout(context.Background(), 30*time.Millisecond)
	defer finish2()
	if err := c.Close(ctx2); !errors.Is(err, context.DeadlineExceeded) {
		t.Fatalf("original select receipt ignored: %v", err)
	}
	f.rejected(selected, "OBU_MANAGED_USER_CLOSED")
	ctx3, finish3 := context.WithTimeout(context.Background(), time.Second)
	defer finish3()
	if err := c.Close(ctx3); err != nil {
		t.Fatal(err)
	}
	if _, err := c.Command(context.Background(), json.RawMessage(`{"operation":"select","tabId":null}`)); err != nil {
		t.Fatal(err)
	}
}

func TestManagedUserSocketLossIsNotWorkerTermination(t *testing.T) {
	f := newUserFixture(t, nil, false)
	c := f.open()
	_ = f.conn.CloseNow()
	userWait(t, c.Done())
	ctx, cancel := context.WithTimeout(context.Background(), time.Second)
	defer cancel()
	if err := c.Close(ctx); err == nil {
		t.Fatal("socket loss claimed native cleanup")
	}
	if _, err := c.Command(context.Background(), json.RawMessage(`{"operation":"select","tabId":null}`)); err == nil {
		t.Fatal("unknown cleanup returned success")
	}
	f.ownerOnce.Do(func() { close(f.owner) })
	if err := c.Close(ctx); err != nil {
		t.Fatal(err)
	}
	result, err := c.Command(context.Background(), json.RawMessage(`{"operation":"select","tabId":null}`))
	if err != nil || !strings.Contains(string(result), "worker-terminated") {
		t.Fatalf("missing original termination proof %s %v", result, err)
	}
}

func TestManagedUserWorkerDestroyedAndLeaseClosed(t *testing.T) {
	for _, kind := range []string{"destroyed", "lease-closed"} {
		t.Run(kind, func(t *testing.T) {
			f := newUserFixture(t, nil, false)
			c := f.open()
			if kind == "destroyed" {
				f.write(map[string]any{"method": "Target.targetDestroyed", "params": map[string]any{"targetId": "owned-worker"}})
			} else {
				f.emit("closed", map[string]any{"reason": "lease expired"})
			}
			userWait(t, c.Done())
			ctx, cancel := context.WithTimeout(context.Background(), time.Second)
			defer cancel()
			if err := c.Close(ctx); err != nil {
				t.Fatal(err)
			}
		})
	}
}

func TestManagedUserAmbiguousWorkerNeverAttaches(t *testing.T) {
	f := newUserFixture(t, nil, true)
	ctx, cancel := context.WithTimeout(context.Background(), time.Second)
	defer cancel()
	identity := f.identity
	identity.ChannelID = ""
	if c, err := openUserController(ctx, f.endpoint(), identity, f.owner); err == nil || c != nil {
		t.Fatal("ambiguous worker accepted")
	}
	f.mu.Lock()
	defer f.mu.Unlock()
	for _, req := range f.requests {
		if req.Method == "Target.attachToTarget" || req.Method == "Runtime.evaluate" {
			t.Fatal("ambiguous discovery gained authority")
		}
	}
}

func TestManagedUserWrongResponseSessionAndPendingBound(t *testing.T) {
	held := make(chan userTestRequest, 32)
	f := newUserFixture(t, func(f *userFixture, r userTestRequest) bool {
		if r.Operation == "status" {
			held <- r
			return true
		}
		return false
	}, false)
	c := f.open()
	var calls []*userCall
	for range userPendingLimit {
		call, err := c.cdp.start(context.Background(), "worker-session", "Runtime.evaluate", map[string]any{"expression": "globalThis.__obuManagedUser.request({\"operation\":\"status\"})", "uniqueContextId": "original-context", "awaitPromise": true, "returnByValue": true})
		if err != nil {
			t.Fatal(err)
		}
		calls = append(calls, call)
	}
	if _, err := c.cdp.start(context.Background(), "worker-session", "Runtime.evaluate", map[string]any{}); err == nil {
		t.Fatal("unbounded pending calls")
	}
	first := userWait(t, held)
	f.write(map[string]any{"id": first.ID, "sessionId": "foreign-session", "result": map[string]any{}})
	userWait(t, c.Done())
	for _, call := range calls {
		ctx, cancel := context.WithTimeout(context.Background(), time.Second)
		_, err := call.wait(ctx)
		cancel()
		if err == nil {
			t.Fatal("wrong-session reply accepted")
		}
	}
}

func TestManagedUserCloseJoinsPrivateReceiptAfterCallerTimeout(t *testing.T) {
	for _, operation := range []string{"heartbeat", "ack"} {
		t.Run(operation, func(t *testing.T) {
			held := make(chan userTestRequest, 1)
			f := newUserFixture(t, func(f *userFixture, req userTestRequest) bool {
				if req.Operation == operation {
					held <- req
					return true
				}
				return false
			}, false)
			c := f.open()
			ctx, cancel := context.WithCancel(context.Background())
			finished := make(chan error, 1)
			go func() { _, err := c.privateRequest(ctx, operation, map[string]any{"sequence": 1}); finished <- err }()
			original := userWait(t, held)
			cancel()
			if !errors.Is(userWait(t, finished), context.Canceled) {
				t.Fatal("private caller cancellation lost")
			}
			closeCtx, finish := context.WithTimeout(context.Background(), 30*time.Millisecond)
			defer finish()
			if err := c.Close(closeCtx); !errors.Is(err, context.DeadlineExceeded) {
				t.Fatalf("private actual receipt dropped: %v", err)
			}
			if operation == "heartbeat" {
				f.evaluated(original, map[string]any{"status": f.status()})
			} else {
				f.evaluated(original, map[string]any{"acknowledged": 1, "workerBootId": f.identity.WorkerBootID})
			}
			closeCtx2, finish2 := context.WithTimeout(context.Background(), time.Second)
			defer finish2()
			if err := c.Close(closeCtx2); err != nil {
				t.Fatal(err)
			}
		})
	}
}

func TestManagedUserConcurrentUnsubscribeWaitsOriginalClose(t *testing.T) {
	held := make(chan userTestRequest, 1)
	f := newUserFixture(t, func(f *userFixture, req userTestRequest) bool {
		if req.Operation == "retire" {
			held <- req
			return true
		}
		return false
	}, false)
	c := f.open()
	closed, unsubscribed := make(chan error, 1), make(chan error, 1)
	go func() { closed <- c.Close(context.Background()) }()
	disconnect := userWait(t, held)
	go func() {
		_, err := c.Command(context.Background(), json.RawMessage(`{"operation":"select","tabId":null}`))
		unsubscribed <- err
	}()
	select {
	case err := <-unsubscribed:
		t.Fatalf("unsubscribe did not join actual cleanup: %v", err)
	case <-time.After(20 * time.Millisecond):
	}
	state := f.status()
	state["connected"], state["selectedTabId"] = false, nil
	f.evaluated(disconnect, map[string]any{"disconnected": true, "status": state})
	if err := userWait(t, closed); err != nil {
		t.Fatal(err)
	}
	if err := userWait(t, unsubscribed); err != nil {
		t.Fatal(err)
	}
}

func TestManagedUserHeartbeatRunsWithoutAViewer(t *testing.T) {
	heartbeat := make(chan userTestRequest, 1)
	f := newUserFixture(t, func(f *userFixture, req userTestRequest) bool {
		if req.Operation == "heartbeat" {
			heartbeat <- req
		}
		return false
	}, false)
	c := f.open()
	select {
	case <-heartbeat:
	case <-time.After(4 * time.Second):
		t.Fatal("3-second heartbeat did not run")
	}
	ctx, cancel := context.WithTimeout(context.Background(), time.Second)
	defer cancel()
	if err := c.Close(ctx); err != nil {
		t.Fatal(err)
	}
}

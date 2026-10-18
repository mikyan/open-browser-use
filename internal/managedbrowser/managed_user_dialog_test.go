package managedbrowser

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/url"
	"strings"
	"testing"
	"time"

	"github.com/coder/websocket"
	"github.com/ifuryst/open-browser-use/internal/managedviewer"
)

func fixtureDialogState(f *userFixture, id string, sequence uint64) map[string]any {
	state := humanFixtureState(f)
	state["eventSequence"] = sequence
	state["pendingDialog"] = nil
	if id != "" {
		state["pendingDialog"] = map[string]any{"leaseId": "original-lease", "generation": 1, "dialogId": id, "type": "prompt", "message": "Synthetic prompt", "defaultPrompt": ""}
	}
	return state
}

func fixtureDialogRequest(id string) json.RawMessage {
	return json.RawMessage(fmt.Sprintf(`{"operation":"humanDialogRespond","leaseId":"original-lease","generation":1,"dialogId":%q,"accept":true,"promptText":"中文😀"}`, id))
}

func fixtureDialogResult(req userTestRequest, state map[string]any) map[string]any {
	return map[string]any{"status": state, "dialogReceipt": map[string]any{"leaseId": req.Arguments["leaseId"], "generation": req.Arguments["generation"], "dialogId": req.Arguments["dialogId"], "acknowledged": true}}
}

func TestManagedDialogOriginalReceiptRequiredAndOnceOnly(t *testing.T) {
	for _, wrong := range []string{"none", "missing", "leaseId", "generation", "dialogId", "acknowledged", "native-error"} {
		t.Run(wrong, func(t *testing.T) {
			calls := 0
			f := newUserFixture(t, func(f *userFixture, req userTestRequest) bool {
				if req.Operation == "humanBegin" {
					f.evaluated(req, map[string]any{"status": fixtureDialogState(f, "original", 1)})
					return true
				}
				if req.Operation != "humanDialogRespond" {
					return false
				}
				calls++
				if wrong == "native-error" {
					f.rejected(req, "OBU_HUMAN_DIALOG_UNCONFIRMED")
					return true
				}
				result := fixtureDialogResult(req, fixtureDialogState(f, "successor", 2))
				receipt := result["dialogReceipt"].(map[string]any)
				switch wrong {
				case "missing":
					delete(result, "dialogReceipt")
				case "leaseId", "dialogId":
					receipt[wrong] = "foreign"
				case "generation":
					receipt[wrong] = 2
				case "acknowledged":
					receipt[wrong] = false
				}
				f.evaluated(req, result)
				return true
			}, false)
			c := f.open()
			if _, err := c.Command(context.Background(), json.RawMessage(`{"operation":"humanBegin","tabId":7}`)); err != nil {
				t.Fatal(err)
			}
			if wrong == "none" {
				for _, mutation := range []struct{ old, next string }{{"original-lease", "foreign"}, {`"generation":1`, `"generation":2`}, {`"dialogId":"original"`, `"dialogId":"foreign"`}, {`"promptText":"中文😀"`, `"promptText":"\ud800"`}} {
					raw := strings.Replace(string(fixtureDialogRequest("original")), mutation.old, mutation.next, 1)
					if _, err := c.Command(context.Background(), json.RawMessage(raw)); err == nil {
						t.Fatal("foreign or malformed decision admitted")
					}
				}
				if calls != 0 {
					t.Fatal("invalid decision reached original native channel")
				}
			}
			_, err := c.Command(context.Background(), fixtureDialogRequest("original"))
			if (err == nil) != (wrong == "none") {
				t.Fatalf("receipt accepted=%t: %v", err == nil, err)
			}
			_, err = c.Command(context.Background(), fixtureDialogRequest("original"))
			var rejected *userBridgeError
			if !errors.As(err, &rejected) || rejected.code != "OBU_HUMAN_DIALOG_STALE" || calls != 1 {
				t.Fatalf("decision replayed: calls=%d err=%v", calls, err)
			}
			c.mu.Lock()
			risk := c.humanRisk
			c.mu.Unlock()
			if !risk {
				t.Fatal("dialog ACK cleared human input risk")
			}
		})
	}
}

func TestManagedDialogCanceledCallerCloseStillJoinsActualNativeResponse(t *testing.T) {
	held := make(chan userTestRequest, 4)
	f := newUserFixture(t, func(f *userFixture, req userTestRequest) bool {
		if req.Operation == "humanBegin" {
			f.evaluated(req, map[string]any{"status": fixtureDialogState(f, "original", 1)})
			return true
		}
		if req.Operation == "humanInput" || req.Operation == "humanDialogRespond" || req.Operation == "retire" {
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
	ctx, cancel := context.WithCancel(context.Background())
	dialogDone := make(chan error, 1)
	go func() { _, err := c.Command(ctx, fixtureDialogRequest("original")); dialogDone <- err }()
	dialog := userWait(t, held)
	if dialog.Operation != "humanDialogRespond" {
		t.Fatal("dialog blocked behind input")
	}
	cancel()
	if !errors.Is(userWait(t, dialogDone), context.Canceled) {
		t.Fatal("caller cancellation lost")
	}
	closed := make(chan error, 1)
	go func() { closed <- c.Close(context.Background()) }()
	retire := userWait(t, held)
	if retire.Operation != "retire" {
		t.Fatal("cleanup blocked behind original calls")
	}
	state := f.status()
	state["connected"], state["selectedTabId"], state["human"] = false, nil, nil
	state["humanCleanup"] = map[string]any{"leaseId": "original-lease", "cleanupConfirmed": true}
	f.evaluated(retire, map[string]any{"disconnected": true, "status": state})
	f.rejected(input, "OBU_HUMAN_STALE")
	_ = userWait(t, inputDone)
	select {
	case err := <-closed:
		t.Fatalf("Close forgot actual response: %v", err)
	case <-time.After(20 * time.Millisecond):
	}
	f.evaluated(dialog, fixtureDialogResult(dialog, fixtureDialogState(f, "", 2)))
	if err := userWait(t, closed); err != nil {
		t.Fatal(err)
	}
}

// Real viewer HTTP/WS -> real UserController -> mocked native worker socket.
// Only native ACKs are simulated; neither transport is replaced by a fake.
func TestManagedDialogViewerAndControllerBypassInputAndRetainNewDialog(t *testing.T) {
	held := make(chan userTestRequest, 8)
	f := newUserFixture(t, func(f *userFixture, req userTestRequest) bool {
		switch req.Operation {
		case "humanBegin":
			f.evaluated(req, map[string]any{"status": fixtureDialogState(f, "", 0)})
			return true
		case "humanInput", "humanDialogRespond":
			held <- req
			return true
		case "select":
			state := f.status()
			state["humanCleanup"] = map[string]any{"leaseId": "original-lease", "cleanupConfirmed": true}
			f.evaluated(req, map[string]any{"status": state})
			return true
		}
		return false
	}, false)
	c := f.open()
	s, err := managedviewer.Start(managedviewer.Config{RunID: f.identity.RunID, Backend: c, Stop: func(context.Context) error { return nil }})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		ctx, cancel := context.WithTimeout(context.Background(), time.Second)
		defer cancel()
		if err := s.Close(ctx); err != nil {
			t.Error(err)
		}
	})
	u, _ := url.Parse(s.URL())
	fragment, _ := url.ParseQuery(u.Fragment)
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	ws, _, err := websocket.Dial(ctx, "ws://"+u.Host+"/ws", &websocket.DialOptions{HTTPHeader: http.Header{"Origin": {u.Scheme + "://" + u.Host}}})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = ws.CloseNow() })
	write := func(value any) {
		t.Helper()
		raw, _ := json.Marshal(value)
		if err := ws.Write(ctx, websocket.MessageText, raw); err != nil {
			t.Fatal(err)
		}
	}
	read := func(kind string, id int) map[string]json.RawMessage {
		t.Helper()
		for {
			_, raw, err := ws.Read(ctx)
			if err != nil {
				t.Fatal(err)
			}
			var value map[string]json.RawMessage
			_ = json.Unmarshal(raw, &value)
			if string(value["type"]) == `"`+kind+`"` && (id == 0 || string(value["id"]) == fmt.Sprint(id)) {
				return value
			}
		}
	}
	success := func(id int) {
		t.Helper()
		value := read("response", id)
		if value["error"] != nil {
			t.Fatalf("response %d: %s", id, value["error"])
		}
	}
	write(map[string]any{"type": "authenticate", "token": fragment.Get("ticket")})
	read("authenticated", 0)
	write(map[string]any{"id": 1, "operation": "humanBegin", "tabId": 7})
	success(1)
	f.emit("frame", map[string]any{"tabId": 7, "streamId": "human-original", "frameSequence": 1, "mimeType": "image/png", "data": "aW1hZ2U=", "controlMode": "human", "humanLeaseId": "original-lease", "generation": 1})
	read("frame", 0)
	write(map[string]any{"id": 2, "operation": "humanInput", "leaseId": "original-lease", "generation": 1, "sequence": 1, "input": map[string]any{"type": "pointer", "action": "move", "x": 10, "y": 10}})
	input := userWait(t, held)
	publish := func(id string, sequence uint64) {
		t.Helper()
		f.mu.Lock()
		f.sequence = sequence
		f.mu.Unlock()
		state := fixtureDialogState(f, id, sequence)
		identity, _ := json.Marshal(f.identity)
		var event map[string]any
		_ = json.Unmarshal(identity, &event)
		event["type"], event["sequence"], event["status"] = "status", sequence, state
		payload, _ := json.Marshal(event)
		f.write(map[string]any{"method": "Runtime.bindingCalled", "sessionId": "worker-session", "params": map[string]any{"name": userBindingName, "executionContextId": f.contextID, "payload": string(payload)}})
		for {
			value := read("state", 0)
			if strings.Contains(string(value["pendingDialog"]), `"dialogId":"`+id+`"`) {
				return
			}
		}
	}
	decision := func(id int, dialog string) {
		t.Helper()
		var request map[string]any
		_ = json.Unmarshal(fixtureDialogRequest(dialog), &request)
		request["id"] = id
		write(request)
	}
	publish("first", 2)
	decision(3, "first")
	first := userWait(t, held)
	if first.Operation != "humanDialogRespond" {
		t.Fatal("response did not bypass input")
	}
	publish("second", 3)
	decision(4, "second")
	second := userWait(t, held)
	if second.Operation != "humanDialogRespond" {
		t.Fatal("new dialog blocked behind old native ACK")
	}
	f.evaluated(first, fixtureDialogResult(first, fixtureDialogState(f, "first", 2)))
	success(3)
	c.mu.Lock()
	current, risk := c.pendingDialog, c.humanRisk
	c.mu.Unlock()
	if current == nil || current.DialogID != "second" || !risk {
		t.Fatal("old ACK changed newer dialog or cleared risk")
	}
	f.evaluated(second, fixtureDialogResult(second, fixtureDialogState(f, "", 4)))
	success(4)
	f.evaluated(input, map[string]any{"status": fixtureDialogState(f, "", 4), "inputReceipt": map[string]any{"leaseId": "original-lease", "generation": 1, "sequence": 1, "acknowledged": true}})
	success(2)
}

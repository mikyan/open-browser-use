package managedbrowser

import (
	"context"
	"encoding/json"
	"testing"
)

func userViewState(f *userFixture, generation uint64, phase string) map[string]any {
	state := f.status()
	state["selectedTabId"] = 7
	state["human"] = nil
	state["tabs"] = []any{map[string]any{"id": 7, "title": "Result", "url": "https://fixture.invalid/result", "kind": "result", "deliveryId": "delivery-original", "watchable": true, "takeover": true}}
	var viewport any = map[string]any{"width": 640, "height": 480}
	if phase == "navigating" {
		viewport = nil
	}
	state["view"] = map[string]any{"state": phase, "leaseId": "view-original", "tabId": 7, "generation": generation, "viewport": viewport, "lastInputSequence": 0}
	return state
}

func userViewEvent(f *userFixture, generation uint64, phase string) {
	f.mu.Lock()
	f.sequence++
	sequence, identity := f.sequence, f.identity
	f.mu.Unlock()
	data, _ := json.Marshal(identity)
	value := map[string]any{}
	_ = json.Unmarshal(data, &value)
	value["type"], value["sequence"], value["status"] = "status", sequence, userViewState(f, generation, phase)
	payload, _ := json.Marshal(value)
	f.write(map[string]any{"method": "Runtime.bindingCalled", "sessionId": "worker-session", "params": map[string]any{"name": userBindingName, "executionContextId": 7, "payload": string(payload)}})
}

func userViewFrame(f *userFixture, generation uint64, stream string) {
	f.emit("frame", map[string]any{"tabId": 7, "streamId": stream, "frameSequence": 1, "mimeType": "image/png", "data": "YQ==", "controlMode": "user-view", "viewLeaseId": "view-original", "generation": generation})
}

func TestManagedResultViewRequiresOriginalActiveGenerationAndRetiresOldCredit(t *testing.T) {
	acks := make(chan userTestRequest, 4)
	f := newUserFixture(t, func(f *userFixture, r userTestRequest) bool {
		if r.Operation == "ack" {
			acks <- r
			return true
		}
		return false
	}, false)
	c := f.open()
	userViewEvent(f, 1, "active")
	userWait(t, c.Events())
	userViewFrame(f, 1, "view-1")
	old := userWait(t, acks)
	userViewEvent(f, 2, "navigating")
	for {
		event := userWait(t, c.Events())
		var e struct {
			Type   string
			Status struct{ View struct{ Generation uint64 } }
		}
		_ = json.Unmarshal(event, &e)
		if e.Type == "status" && e.Status.View.Generation == 2 {
			break
		}
	}
	f.rejected(old, "OBU_MANAGED_USER_ACK")
	userViewFrame(f, 1, "view-1") // Original retired frame is harmless and never re-ACKed.
	userViewEvent(f, 2, "active")
	userViewFrame(f, 2, "view-2")
	ack := userWait(t, acks)
	var seq uint64
	_ = json.Unmarshal(ack.Arguments["sequence"], &seq)
	f.evaluated(ack, map[string]any{"acknowledged": seq, "workerBootId": f.identity.WorkerBootID})
	for {
		event := userWait(t, c.Events())
		var e struct {
			Type        string
			Generation  uint64
			ControlMode string
		}
		_ = json.Unmarshal(event, &e)
		if e.Type == "frame" {
			if e.Generation != 2 || e.ControlMode != "user-view" {
				t.Fatalf("old view restored: %s", event)
			}
			break
		}
	}
	c.mu.Lock()
	risk := c.humanRisk
	c.mu.Unlock()
	if risk {
		t.Fatal("read-only view acquired native input risk")
	}
	select {
	case <-c.Done():
		t.Fatal("retired view ACK killed channel")
	default:
	}
}

func TestManagedResultFutureFrameAndMixedStateFailClosed(t *testing.T) {
	for _, mode := range []string{"unannounced", "navigating", "human-conflict"} {
		t.Run(mode, func(t *testing.T) {
			f := newUserFixture(t, nil, false)
			c := f.open()
			if mode == "human-conflict" {
				state := userViewState(f, 1, "active")
				state["human"] = state["view"]
				c.mu.Lock()
				err := c.validateStatusLocked(jsonForTest(state))
				c.mu.Unlock()
				if err == nil {
					t.Fatal("mixed input/view state accepted")
				}
				return
			}
			phase := "active"
			generation := uint64(2)
			if mode == "navigating" {
				phase = "navigating"
				generation = 1
			}
			userViewEvent(f, 1, phase)
			userWait(t, c.Events())
			userViewFrame(f, generation, "unannounced")
			userWait(t, c.Done())
		})
	}
}

func jsonForTest(value any) json.RawMessage { data, _ := json.Marshal(value); return data }

func TestManagedResultDeliveryIdentityIsTypedAndUnchanged(t *testing.T) {
	seen := make(chan userTestRequest, 2)
	f := newUserFixture(t, func(f *userFixture, r userTestRequest) bool {
		if r.Operation == "select" && string(r.Arguments["tabId"]) != "null" {
			seen <- r
			f.evaluated(r, map[string]any{"status": userViewState(f, 1, "active")})
			return true
		}
		return false
	}, false)
	c := f.open()
	if _, err := c.Command(context.Background(), json.RawMessage(`{"operation":"select","tabId":7,"deliveryId":"delivery-original"}`)); err != nil {
		t.Fatal(err)
	}
	r := userWait(t, seen)
	if string(r.Arguments["deliveryId"]) != `"delivery-original"` {
		t.Fatal("delivery changed before worker")
	}
	for _, bad := range []string{`{"operation":"select","tabId":null,"deliveryId":"old"}`, `{"operation":"select","tabId":7,"deliveryId":null}`, `{"operation":"humanBegin","tabId":7,"deliveryId":""}`, `{"operation":"humanInput","deliveryId":"old","leaseId":"view-original","generation":1,"sequence":1,"input":{"type":"text","text":"x"}}`} {
		if _, err := c.Command(context.Background(), json.RawMessage(bad)); err == nil {
			t.Fatalf("invalid command dispatched: %s", bad)
		}
	}
}

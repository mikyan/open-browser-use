package managedviewer

import (
	"context"
	"encoding/json"
	"fmt"
	"os"
	"reflect"
	"strings"
	"sync"
	"testing"
	"time"
)

// Real loopback HTTP/WebSocket tests with explicitly simulated native results.
// Actual browser cleanup and frame decoding are separate acceptance evidence.
func resultTestState(sequence uint64, generation uint64, phase string) json.RawMessage {
	state := map[string]any{"connected": true, "workerBootId": "worker-a", "eventSequence": sequence, "cleanupPending": 0,
		"automation":    map[string]any{"state": "paused", "inputBlocked": true, "revision": 8, "cleanupComplete": true},
		"tabs":          []any{map[string]any{"id": 1, "title": "Result", "url": "https://fixture.invalid/result", "kind": "result", "deliveryId": "delivery-original", "watchable": true, "takeover": true}},
		"selectedTabId": nil, "human": nil, "view": nil}
	if phase != "" {
		var viewport any = map[string]any{"width": 640, "height": 480}
		if phase == "navigating" {
			viewport = nil
		}
		state["selectedTabId"] = 1
		state["view"] = map[string]any{"state": phase, "leaseId": "view-original", "tabId": 1, "generation": generation, "viewport": viewport, "lastInputSequence": 0}
	}
	return jsonBytes(map[string]any{"status": state})
}

func resultTestEvent(sequence, generation uint64, phase string) json.RawMessage {
	f, _ := object(resultTestState(sequence, generation, phase))
	f["type"] = jsonBytes("status")
	f["sequence"] = jsonBytes(sequence)
	return jsonBytes(f)
}

func resultTestFrame(sequence, generation uint64) json.RawMessage {
	return jsonBytes(map[string]any{"type": "frame", "sequence": sequence, "frameSequence": 1, "tabId": 1, "streamId": fmt.Sprintf("view-%d", generation), "controlMode": "user-view", "viewLeaseId": "view-original", "generation": generation, "mimeType": "image/png", "data": "aW1hZ2U="})
}

func TestResultWebSocketViewWhilePausedNeverOpensInputLaneOrBlocksResume(t *testing.T) {
	b := newBackend()
	b.command = func(_ context.Context, data json.RawMessage) (json.RawMessage, error) {
		if humanTestOperation(data) == "select" && !bytesNullTab(data) {
			return resultTestState(1, 1, "active"), nil
		}
		return resultTestState(5, 0, ""), nil
	}
	s := startTest(t, b, nil)
	c := authenticate(t, s)
	send(t, c, `{"id":1,"operation":"select","tabId":1,"deliveryId":"delivery-original"}`)
	call := humanTestCall(t, b, "select")
	if !strings.Contains(string(call), `"deliveryId":"delivery-original"`) {
		t.Fatal("original delivery omitted")
	}
	humanTestSuccess(t, c, 1)
	b.events <- resultTestFrame(2, 1)
	frame := readMessage(t, c)
	if string(frame["type"]) != `"frame"` || string(frame["viewLeaseId"]) != `"view-original"` || string(frame["controlMode"]) != `"user-view"` {
		t.Fatalf("paused result frame lost: %s", jsonBytes(frame))
	}
	send(t, c, `{"id":2,"operation":"humanInput","leaseId":"view-original","generation":1,"sequence":1,"input":{"type":"text","text":"must not dispatch"}}`)
	humanTestError(t, c, 2, "HUMAN_STALE")
	send(t, c, `{"id":3,"operation":"resume","expectedRevision":8,"expectedWorkerBootId":"worker-a"}`)
	humanTestCall(t, b, "resume")
	humanTestSuccess(t, c, 3)
	select {
	case call := <-b.calls:
		t.Fatalf("view admitted native input: %s", call)
	default:
	}
}

func TestResultWebSocketGenerationRetiresOldFramesAndPreservesAnnouncement(t *testing.T) {
	b := newBackend()
	b.command = func(_ context.Context, data json.RawMessage) (json.RawMessage, error) {
		if bytesNullTab(data) {
			return resultTestState(10, 0, ""), nil
		}
		return resultTestState(1, 1, "active"), nil
	}
	s := startTest(t, b, nil)
	c := authenticate(t, s)
	send(t, c, `{"id":1,"operation":"select","tabId":1,"deliveryId":"delivery-original"}`)
	humanTestCall(t, b, "select")
	humanTestSuccess(t, c, 1)
	b.events <- resultTestEvent(2, 2, "navigating")
	m := readMessage(t, c)
	if string(m["retiredSequence"]) != "2" {
		t.Fatalf("missing navigation retirement: %s", jsonBytes(m))
	}
	b.events <- resultTestFrame(3, 1) // Obsolete and unannounced-future frames must not reach HTML.
	b.events <- resultTestFrame(4, 3)
	b.events <- resultTestEvent(5, 2, "active")
	m = readMessage(t, c)
	if string(m["type"]) != `"state"` {
		t.Fatalf("stale/future frame escaped: %s", jsonBytes(m))
	}
	b.events <- resultTestFrame(6, 2)
	m = readMessage(t, c)
	if string(m["type"]) != `"frame"` || string(m["generation"]) != "2" || string(m["retiredSequence"]) != "2" {
		t.Fatalf("wrong successor: %s", jsonBytes(m))
	}
}

func TestResultDisconnectWaitsForOriginalViewCleanupEvenAfterClear(t *testing.T) {
	b := newBackend()
	release := make(chan struct{})
	var once sync.Once
	b.command = func(_ context.Context, data json.RawMessage) (json.RawMessage, error) {
		if bytesNullTab(data) {
			<-release
			return resultTestState(10, 0, ""), nil
		}
		return resultTestState(1, 1, "active"), nil
	}
	s := startTest(t, b, nil)
	t.Cleanup(func() { once.Do(func() { close(release) }) })
	c := authenticate(t, s)
	send(t, c, `{"id":1,"operation":"select","tabId":1,"deliveryId":"delivery-original"}`)
	humanTestCall(t, b, "select")
	humanTestSuccess(t, c, 1)
	b.events <- jsonBytes(map[string]any{"type": "clear", "sequence": 2})
	readMessage(t, c)
	_ = c.CloseNow()
	humanTestCall(t, b, "select")
	ctx, cancel := context.WithTimeout(context.Background(), 40*time.Millisecond)
	defer cancel()
	if err := s.WaitReady(ctx); err == nil {
		t.Fatal("disconnect claimed native cleanup before original receipt")
	}
	if _, err := s.IssueURL(); err == nil {
		t.Fatal("issued successor ticket before cleanup")
	}
	once.Do(func() { close(release) })
	ctx2, cancel2 := context.WithTimeout(context.Background(), time.Second)
	defer cancel2()
	if err := s.WaitReady(ctx2); err != nil {
		t.Fatal(err)
	}
	if _, err := s.IssueURL(); err != nil {
		t.Fatal(err)
	}
}

func TestResultCleanupClearIsNotActualCompletion(t *testing.T) {
	c := &connection{frames: make(chan json.RawMessage, 1)}
	state, _ := publicState(resultTestState(1, 1, "active"))
	c.observeHumanState(state)
	c.observeHumanState(jsonBytes(map[string]any{"type": "clear", "eventSequence": 2}))
	bad, _ := object(resultTestState(3, 0, ""))
	inner, _ := object(bad["status"])
	delete(inner, "cleanupPending")
	bad["status"] = jsonBytes(inner)
	if c.confirmCleanup(jsonBytes(bad)) == nil {
		t.Fatal("Clear erased original view cleanup obligation")
	}
	if c.confirmCleanup(resultTestState(4, 0, "")) != nil {
		t.Fatal("actual unselection receipt rejected")
	}
}

func TestResultWebSocketUsesActualBridgeFixtureForRepeatedPausedTakeover(t *testing.T) {
	data, err := os.ReadFile("testdata/result-bridge-fixture.json")
	if err != nil {
		t.Fatal(err)
	}
	var fixture map[string]json.RawMessage
	_ = json.Unmarshal(data, &fixture)
	var events []json.RawMessage
	_ = json.Unmarshal(fixture["events"], &events)
	b := newBackend()
	var mu sync.Mutex
	begin, selection := 0, 0
	b.command = func(_ context.Context, data json.RawMessage) (json.RawMessage, error) {
		mu.Lock()
		defer mu.Unlock()
		switch humanTestOperation(data) {
		case "select":
			if bytesNullTab(data) {
				return fixture["secondHumanEnd"], nil
			}
			selection++
			if selection == 1 {
				return fixture["viewPausedStatus"], nil
			}
			return fixture["viewAfterHumanStatus"], nil
		case "humanBegin":
			begin++
			if begin == 1 {
				return fixture["humanBegin"], nil
			}
			return fixture["secondHumanBegin"], nil
		case "humanInput":
			return fixture["humanInput"], nil
		case "humanEnd":
			if begin == 1 {
				return fixture["humanEnd"], nil
			}
			return fixture["secondHumanEnd"], nil
		default:
			return nil, fmt.Errorf("unexpected simulated operation")
		}
	}
	s := startTest(t, b, nil)
	c := authenticate(t, s)
	exchange := func(id int, operation, fields string) json.RawMessage {
		send(t, c, fmt.Sprintf(`{"id":%d,"operation":%q%s}`, id, operation, fields))
		call := humanTestCall(t, b, operation)
		if operation == "select" || operation == "humanBegin" {
			if !strings.Contains(string(call), `"deliveryId":"fixture-delivery-original"`) {
				t.Fatal("delivery identity omitted")
			}
		}
		return humanTestSuccess(t, c, uint64(id))
	}
	forwardFrame := func(result json.RawMessage) {
		f, _ := object(result)
		var state struct {
			Human *struct {
				LeaseID string `json:"leaseId"`
			}
			View *struct {
				LeaseID string `json:"leaseId"`
			}
		}
		_ = json.Unmarshal(f["status"], &state)
		lease := ""
		if state.Human != nil {
			lease = state.Human.LeaseID
		} else {
			lease = state.View.LeaseID
		}
		for _, event := range events {
			f, _ := object(event)
			if string(f["type"]) != `"frame"` {
				continue
			}
			if string(f["humanLeaseId"]) == string(jsonBytes(lease)) || string(f["viewLeaseId"]) == string(jsonBytes(lease)) {
				b.events <- event
				m := readMessage(t, c)
				if string(m["type"]) != `"frame"` {
					t.Fatalf("missing original frame: %s", jsonBytes(m))
				}
				return
			}
		}
		t.Fatal("fixture missing frame")
	}
	selectionFields := `,"tabId":7,"deliveryId":"fixture-delivery-original"`
	exchange(1, "select", selectionFields)
	forwardFrame(fixture["viewPausedStatus"])
	exchange(2, "humanBegin", selectionFields)
	forwardFrame(fixture["humanBegin"])
	beginFields, _ := object(fixture["humanBegin"])
	state, _ := object(beginFields["status"])
	human, _ := object(state["human"])
	var lease string
	_ = json.Unmarshal(human["leaseId"], &lease)
	exchange(3, "humanInput", fmt.Sprintf(`,"leaseId":%q,"generation":1,"sequence":1,"input":{"type":"text","text":"x"}`, lease))
	exchange(4, "humanEnd", fmt.Sprintf(`,"leaseId":%q`, lease))
	exchange(5, "select", selectionFields)
	forwardFrame(fixture["viewAfterHumanStatus"])
	exchange(6, "humanBegin", selectionFields)
	forwardFrame(fixture["secondHumanBegin"])
	beginFields, _ = object(fixture["secondHumanBegin"])
	state, _ = object(beginFields["status"])
	human, _ = object(state["human"])
	_ = json.Unmarshal(human["leaseId"], &lease)
	exchange(7, "humanEnd", fmt.Sprintf(`,"leaseId":%q`, lease))
}

func resultFixturePublic(t *testing.T) map[string]any {
	t.Helper()
	data, err := os.ReadFile("testdata/result-bridge-fixture.json")
	if err != nil {
		t.Fatal(err)
	}
	var bridge map[string]json.RawMessage
	if json.Unmarshal(data, &bridge) != nil {
		t.Fatal("invalid result fixture")
	}
	actual := map[string]any{}
	for _, name := range []string{"open", "viewRunning", "viewRunningStatus", "pause", "viewPaused", "viewPausedStatus", "humanBegin", "humanInput", "humanEnd", "viewAfterHuman", "viewAfterHumanStatus", "secondHumanBegin", "secondHumanEnd"} {
		data, err := publicState(bridge[name])
		if err != nil {
			t.Fatalf("%s: %v", name, err)
		}
		var value any
		_ = json.Unmarshal(data, &value)
		actual[name] = value
	}
	for _, name := range []string{"viewNavigation", "humanNavigation"} {
		var entries map[string]json.RawMessage
		_ = json.Unmarshal(bridge[name], &entries)
		states := map[string]any{}
		for key, raw := range entries {
			data, err := publicState(raw)
			if err != nil {
				t.Fatal(err)
			}
			var value any
			_ = json.Unmarshal(data, &value)
			states[key] = value
		}
		actual[name] = states
	}
	var events []json.RawMessage
	_ = json.Unmarshal(bridge["events"], &events)
	projected := []any{}
	for _, event := range events {
		_, data, err := publicEvent(event)
		if err != nil {
			t.Fatal(err)
		}
		var value any
		_ = json.Unmarshal(data, &value)
		projected = append(projected, value)
	}
	actual["events"] = projected
	return actual
}

func TestResultPublicFixtureEqualsActualGoProjection(t *testing.T) {
	actual := resultFixturePublic(t)
	data, err := os.ReadFile("testdata/public-result-fixture.json")
	if err != nil {
		t.Fatal(err)
	}
	var expected any
	_ = json.Unmarshal(data, &expected)
	if !reflect.DeepEqual(actual, expected) {
		t.Fatal("result public golden differs from actual Go projection")
	}
	encoded := string(jsonBytes(actual))
	for _, private := range []string{"channelId", "portId", "runId", "extensionId", "lastInputSequence", "targetId"} {
		if strings.Contains(encoded, `"`+private+`"`) {
			t.Fatalf("private field leaked: %s", private)
		}
	}
}

func TestResultProjectionRejectsMixedLeasesAndFalseDelivery(t *testing.T) {
	for _, mutate := range []func(map[string]json.RawMessage){
		func(s map[string]json.RawMessage) { s["human"] = s["view"] },
		func(s map[string]json.RawMessage) { s["selectedTabId"] = jsonBytes(2) },
		func(s map[string]json.RawMessage) {
			s["tabs"] = jsonBytes([]any{map[string]any{"id": 1, "title": "Task", "url": "about:blank"}})
		},
		func(s map[string]json.RawMessage) {
			v, _ := object(s["view"])
			v["lastInputSequence"] = jsonBytes(1)
			s["view"] = jsonBytes(v)
		},
	} {
		f, _ := object(resultTestState(1, 1, "active"))
		state, _ := object(f["status"])
		mutate(state)
		f["status"] = jsonBytes(state)
		if _, err := publicState(jsonBytes(f)); err == nil {
			t.Fatal("malformed result authority projected")
		}
	}
}

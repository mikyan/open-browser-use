package managedviewer

import (
	"context"
	"encoding/json"
	"testing"
)

func pageSelectionTestState(sequence uint64, receipt bool) json.RawMessage {
	outer, _ := object(humanTestState(false, 0))
	state, _ := object(outer["status"])
	state["pageSelectionVersion"] = jsonBytes(1)
	state["eventSequence"] = jsonBytes(sequence)
	state["tabs"] = jsonBytes([]any{map[string]any{"id": 2, "title": "Child", "url": "https://fixture.invalid/child", "kind": "browser", "pageSelectionId": "original-choice", "watchable": true, "takeover": true, "privateTarget": "not-public"}})
	if receipt {
		outer["pageSelectionReceipt"] = jsonBytes(map[string]any{"tabId": 2, "pageSelectionId": "original-choice", "deliveryId": "real-delivery", "retained": true})
		state["tabs"] = jsonBytes([]any{map[string]any{"id": 2, "title": "Child", "url": "https://fixture.invalid/child", "kind": "result", "deliveryId": "real-delivery", "watchable": true, "takeover": true}})
		state["selectedTabId"] = jsonBytes(2)
	}
	outer["status"] = jsonBytes(state)
	return jsonBytes(outer)
}

func TestPageSelectionPublicProjectionAndPin(t *testing.T) {
	raw := pageSelectionTestState(10, false)
	public, err := publicState(raw)
	if err != nil {
		t.Fatal(err)
	}
	f, _ := object(public)
	if string(f["pageSelectionVersion"]) != "1" {
		t.Fatal("channel capability lost")
	}
	var tabs []map[string]any
	_ = json.Unmarshal(f["tabs"], &tabs)
	if tabs[0]["pageSelectionId"] != "original-choice" || tabs[0]["privateTarget"] != nil {
		t.Fatal("page choice projection changed authority")
	}
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	c := &connection{ctx: ctx, cancel: cancel}
	if err := c.observeHumanState(public); err != nil {
		t.Fatal(err)
	}
	f["eventSequence"] = jsonBytes(9)
	delete(f, "pageSelectionVersion")
	if err := c.observeHumanState(jsonBytes(f)); err != nil || ctx.Err() != nil {
		t.Fatal("old state changed channel capability", err)
	}
	f["eventSequence"] = jsonBytes(11)
	if err := c.observeHumanState(jsonBytes(f)); err == nil || ctx.Err() == nil {
		t.Fatal("changed capability kept original channel alive")
	}
	outer, _ := object(raw)
	state, _ := object(outer["status"])
	delete(state, "pageSelectionVersion")
	outer["status"] = jsonBytes(state)
	if _, err := publicState(jsonBytes(outer)); err == nil {
		t.Fatal("browser directory accepted without channel capability")
	}
}

func TestPageSelectionWebSocketPreservesOriginalReceipt(t *testing.T) {
	for _, mismatch := range []bool{false, true} {
		t.Run(map[bool]string{false: "original", true: "foreign"}[mismatch], func(t *testing.T) {
			b := newBackend()
			b.command = func(_ context.Context, data json.RawMessage) (json.RawMessage, error) {
				if humanTestOperation(data) == "select" && !bytesNullTab(data) {
					value, _ := object(pageSelectionTestState(11, true))
					if mismatch {
						r, _ := object(value["pageSelectionReceipt"])
						r["pageSelectionId"] = jsonBytes("other")
						value["pageSelectionReceipt"] = jsonBytes(r)
					}
					return jsonBytes(value), nil
				}
				return pageSelectionTestState(10, false), nil
			}
			s := startTest(t, b, nil)
			ws := authenticate(t, s)
			send(t, ws, `{"id":1,"operation":"status"}`)
			humanTestSuccess(t, ws, 1)
			send(t, ws, `{"id":2,"operation":"select","tabId":2,"pageSelectionId":"original-choice"}`)
			if mismatch {
				humanTestError(t, ws, 2, "OPERATION_UNCONFIRMED")
			} else {
				result := humanTestSuccess(t, ws, 2)
				f, _ := object(result)
				if f["pageSelectionReceipt"] == nil {
					t.Fatal("exact receipt not returned")
				}
			}
		})
	}
}

func TestPageSelectionEndReleasesAdmissionBeforePublishingReceipt(t *testing.T) {
	b := humanTestBackend()
	s := &Server{config: Config{Backend: b}}
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	c := &connection{ctx: ctx, cancel: cancel, replies: make(chan outbound, 1), releases: make(chan struct{}, 1), humanLease: humanTestLease, humanClaimed: true, inputs: make(chan command, 1)}
	c.releases <- struct{}{}
	released := false
	r := command{id: 1, operation: "humanEnd", payload: jsonBytes(map[string]any{"operation": "humanEnd", "leaseId": humanTestLease}), releaseDone: func() {
		if len(c.replies) != 0 {
			t.Error("original End receipt published before admission cleanup")
		}
		<-c.releases
		released = true
	}}
	s.command(c, r)
	if !released || len(c.releases) != 0 {
		t.Fatal("confirmed End still holds the next page's admission")
	}
	if len(c.replies) != 1 {
		t.Fatal("original End response not published")
	}
	response := <-c.replies
	fields, _ := object(response.data)
	if fields["error"] != nil {
		t.Fatal(string(response.data))
	}
}

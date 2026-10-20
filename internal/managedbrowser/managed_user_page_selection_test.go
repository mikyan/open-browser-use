package managedbrowser

import (
	"context"
	"encoding/json"
	"sync/atomic"
	"testing"
)

func pageChoiceStatus(f *userFixture, sequence uint64) map[string]any {
	state := f.status()
	state["pageSelectionVersion"] = 1
	state["eventSequence"] = sequence
	return state
}

func pageChoiceOpen(f *userFixture, req userTestRequest) {
	data, _ := json.Marshal(f.identity)
	value := map[string]any{}
	_ = json.Unmarshal(data, &value)
	value["status"] = pageChoiceStatus(f, 1)
	value["recoveryState"] = map[string]any{"version": 1, "browserIncarnation": "original-browser-incarnation", "journalId": "original-journal", "workerEpoch": 1}
	f.evaluated(req, value)
}

func TestManagedPageSelectionCapabilityPinsChannelAfterSequenceGate(t *testing.T) {
	for _, enabled := range []bool{false, true} {
		f := newUserFixture(t, func(f *userFixture, req userTestRequest) bool {
			if enabled && req.Operation == "open" {
				pageChoiceOpen(f, req)
				return true
			}
			return false
		}, false)
		c := f.open()
		state := f.status()
		state["eventSequence"] = 10
		if enabled {
			state["pageSelectionVersion"] = 1
		}
		validate := func() error {
			data, _ := json.Marshal(state)
			c.mu.Lock()
			defer c.mu.Unlock()
			return c.validateStatusLocked(data)
		}
		if err := validate(); err != nil {
			t.Fatal(err)
		}
		if enabled {
			delete(state, "pageSelectionVersion")
		} else {
			state["pageSelectionVersion"] = 1
		}
		state["eventSequence"] = 9
		if err := validate(); err != nil {
			t.Fatal("late state must not change original channel capability", err)
		}
		state["eventSequence"] = 11
		if err := validate(); err == nil {
			t.Fatal("current channel capability changed")
		}
	}
}

func TestManagedPageSelectionRequiresOriginalReceiptAndCapability(t *testing.T) {
	for _, fault := range []string{"none", "legacy", "missing", "tab", "choice", "unsolicited"} {
		t.Run(fault, func(t *testing.T) {
			var calls atomic.Int32
			f := newUserFixture(t, func(f *userFixture, req userTestRequest) bool {
				if fault != "legacy" && req.Operation == "open" {
					pageChoiceOpen(f, req)
					return true
				}
				if req.Operation != "select" || string(req.Arguments["tabId"]) == "null" {
					return false
				}
				calls.Add(1)
				r := map[string]any{"tabId": 7, "pageSelectionId": "choice", "deliveryId": "real-delivery", "retained": true}
				if fault == "tab" {
					r["tabId"] = 8
				}
				if fault == "choice" {
					r["pageSelectionId"] = "other"
				}
				value := map[string]any{"status": pageChoiceStatus(f, 2)}
				if fault != "missing" {
					value["pageSelectionReceipt"] = r
				}
				f.evaluated(req, value)
				return true
			}, false)
			c := f.open()
			request := json.RawMessage(`{"operation":"select","tabId":7,"pageSelectionId":"choice"}`)
			if fault == "unsolicited" {
				request = json.RawMessage(`{"operation":"select","tabId":7}`)
			}
			result, err := c.Command(context.Background(), request)
			if fault == "none" {
				if err != nil {
					t.Fatal(err)
				}
				var data map[string]json.RawMessage
				_ = json.Unmarshal(result, &data)
				if data["pageSelectionReceipt"] == nil {
					t.Fatal("original durable receipt lost")
				}
			} else if err == nil {
				t.Fatal("invalid choice accepted")
			}
			if fault == "legacy" && calls.Load() != 0 {
				t.Fatal("legacy channel dispatched choice")
			}
		})
	}
}

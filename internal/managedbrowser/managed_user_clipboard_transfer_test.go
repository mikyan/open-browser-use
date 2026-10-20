package managedbrowser

import (
	"context"
	"encoding/json"
	"sync/atomic"
	"testing"
)

func TestManagedHumanClipboardTransferCannotChangeWithinOriginalLease(t *testing.T) {
	for _, initial := range []uint64{0, 1} {
		f := newUserFixture(t, nil, false)
		c := f.open()
		state := func(version, generation, sequence uint64) json.RawMessage {
			value := humanFixtureState(f)
			value["eventSequence"] = sequence
			human := value["human"].(map[string]any)
			human["generation"] = generation
			if version != 0 {
				human["clipboardTransferVersion"] = version
			}
			data, _ := json.Marshal(value)
			return data
		}
		validate := func(data json.RawMessage) error {
			c.mu.Lock()
			defer c.mu.Unlock()
			return c.validateStatusLocked(data)
		}
		if err := validate(state(initial, 1, 10)); err != nil {
			t.Fatal(err)
		}
		if err := validate(state(initial, 1, 11)); err != nil {
			t.Fatal("same native contract rejected", err)
		}
		if err := validate(state(1-initial, 1, 12)); err == nil {
			t.Fatal("same generation capability changed")
		}
		if err := validate(state(2, 1, 12)); err == nil {
			t.Fatal("unknown native budget accepted")
		}
		if err := validate(state(1-initial, 2, 13)); err == nil {
			t.Fatal("new generation changed original lease capability")
		}
		if err := validate(state(initial, 2, 13)); err != nil {
			t.Fatal("new generation rejected", err)
		}
		if err := validate(state(initial, 1, 10)); err != nil {
			t.Fatal("late original status should be ignored", err)
		}
		c.mu.Lock()
		latest := *c.humanStatus
		c.mu.Unlock()
		if latest.Generation != 2 || func() bool {
			raw, _ := json.Marshal(latest)
			var fields map[string]json.RawMessage
			_ = json.Unmarshal(raw, &fields)
			if initial == 0 {
				return fields["clipboardTransferVersion"] != nil
			}
			return string(fields["clipboardTransferVersion"]) != "1"
		}() {
			t.Fatal("late status changed successor budget")
		}
	}
}

func TestManagedHumanClipboardTransferRequiresCurrentNativeLease(t *testing.T) {
	for _, name := range []string{"active", "legacy", "none", "preparing", "navigating", "released", "wrong-lease", "wrong-generation", "cleared", "cleared-stale", "disconnected"} {
		t.Run(name, func(t *testing.T) {
			var calls atomic.Int32
			f := newUserFixture(t, func(f *userFixture, req userTestRequest) bool {
				if req.Operation != "humanInput" {
					return false
				}
				calls.Add(1)
				state := humanFixtureState(f)
				state["eventSequence"] = 50
				state["human"].(map[string]any)["clipboardTransferVersion"] = 1
				f.evaluated(req, map[string]any{"status": state, "inputReceipt": map[string]any{"leaseId": "original-lease", "generation": 1, "sequence": 1, "acknowledged": true, "clipboardTransfer": map[string]any{"operation": "copy", "status": "unchanged"}}})
				return true
			}, false)
			c := f.open()
			state := humanFixtureState(f)
			state["eventSequence"] = 10
			h := state["human"].(map[string]any)
			h["clipboardTransferVersion"] = 1
			switch name {
			case "disconnected":
				state["connected"] = false
			case "legacy":
				delete(h, "clipboardTransferVersion")
			case "none":
				state["human"] = nil
			case "preparing", "navigating":
				h["state"] = name
				h["viewport"] = nil
			case "released":
				h["state"] = "released"
			case "wrong-lease":
				h["leaseId"] = "another-lease"
			case "wrong-generation":
				h["generation"] = 2
			}
			raw, _ := json.Marshal(state)
			c.mu.Lock()
			err := c.validateStatusLocked(raw)
			c.mu.Unlock()
			if err != nil {
				t.Fatal(err)
			}
			if name == "cleared" || name == "cleared-stale" {
				state["human"] = nil
				state["eventSequence"] = 11
				raw, _ = json.Marshal(state)
				c.mu.Lock()
				err = c.validateStatusLocked(raw)
				c.mu.Unlock()
				if err != nil {
					t.Fatal(err)
				}
			}
			if name == "cleared-stale" {
				state["human"], state["eventSequence"] = h, 10
				raw, _ = json.Marshal(state)
				c.mu.Lock()
				err = c.validateStatusLocked(raw)
				c.mu.Unlock()
				if err != nil {
					t.Fatal(err)
				}
			}
			_, err = c.Command(context.Background(), json.RawMessage(`{"operation":"humanInput","leaseId":"original-lease","generation":1,"sequence":1,"input":{"type":"key","action":"down","key":"c","code":"KeyC","windowsVirtualKeyCode":67,"modifiers":2,"clipboardTransfer":"copy"}}`))
			if name == "active" {
				if err != nil || calls.Load() != 1 {
					t.Fatalf("exact native capability failed: %v, %d calls", err, calls.Load())
				}
			} else if err == nil || calls.Load() != 0 {
				t.Fatalf("unowned repeat submitted: %s %v %d", name, err, calls.Load())
			}
		})
	}
}

func TestManagedHumanClipboardTransferOriginalReceiptCannotBeInvented(t *testing.T) {
	for _, mismatch := range []string{"none", "missing", "lease", "generation", "sequence", "acknowledged"} {
		t.Run(mismatch, func(t *testing.T) {
			f := newUserFixture(t, func(f *userFixture, req userTestRequest) bool {
				state := humanFixtureState(f)
				state["human"].(map[string]any)["clipboardTransferVersion"] = 1
				if req.Operation == "humanBegin" {
					f.evaluated(req, map[string]any{"status": state})
					return true
				}
				if req.Operation != "humanInput" {
					return false
				}
				receipt := map[string]any{"leaseId": "original-lease", "generation": 1, "sequence": 1, "acknowledged": true, "clipboardTransfer": map[string]any{"operation": "copy", "status": "unchanged"}}
				switch mismatch {
				case "lease":
					receipt["leaseId"] = "other"
				case "generation":
					receipt["generation"] = 2
				case "sequence":
					receipt["sequence"] = 2
				case "acknowledged":
					receipt["acknowledged"] = false
				}
				result := map[string]any{"status": state}
				if mismatch != "missing" {
					result["inputReceipt"] = receipt
				}
				f.evaluated(req, result)
				return true
			}, false)
			c := f.open()
			if _, err := c.Command(context.Background(), json.RawMessage(`{"operation":"humanBegin","tabId":7}`)); err != nil {
				t.Fatal(err)
			}
			_, err := c.Command(context.Background(), json.RawMessage(`{"operation":"humanInput","leaseId":"original-lease","generation":1,"sequence":1,"input":{"type":"key","action":"down","key":"c","code":"KeyC","windowsVirtualKeyCode":67,"modifiers":2,"clipboardTransfer":"copy"}}`))
			if (err == nil) != (mismatch == "none") {
				t.Fatalf("receipt %s: %v", mismatch, err)
			}
		})
	}
}

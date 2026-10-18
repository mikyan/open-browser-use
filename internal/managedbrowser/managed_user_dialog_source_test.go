package managedbrowser

import (
	"context"
	"encoding/json"
	"testing"
)

func TestManagedDialogSourcePinnedAcrossStatusAndLateReply(t *testing.T) {
	for _, initial := range []string{"", "https://child.test"} {
		t.Run(initial, func(t *testing.T) {
			f := newUserFixture(t, nil, false)
			c := f.open()
			state := func(id, origin string, sequence uint64) json.RawMessage {
				value := fixtureDialogState(f, id, sequence)
				if id != "" && origin != "" {
					value["pendingDialog"].(map[string]any)["source"] = map[string]string{"origin": origin, "frame": "child"}
				}
				raw, _ := json.Marshal(value)
				return raw
			}
			c.mu.Lock()
			defer c.mu.Unlock()
			if err := c.validateStatusLocked(state("first", initial, 10)); err != nil {
				t.Fatal(err)
			}
			if err := c.validateStatusLocked(state("first", initial, 11)); err != nil {
				t.Fatal(err)
			}
			other := "https://changed.test"
			if err := c.validateStatusLocked(state("first", other, 9)); err != nil {
				t.Fatalf("old status was not ignored: %v", err)
			}
			if err := c.validateStatusLocked(state("first", other, 12)); err == nil {
				t.Fatal("same tuple changed source")
			}
			if err := c.validateStatusLocked(state("", "", 13)); err != nil {
				t.Fatal(err)
			}
			if err := c.validateStatusLocked(state("first", other, 14)); err == nil {
				t.Fatal("null gap erased original source binding")
			}
			if err := c.validateStatusLocked(state("successor", other, 15)); err != nil {
				t.Fatalf("new tuple could not have its own source: %v", err)
			}
			if err := c.validateStatusLocked(state("first", initial, 11)); err != nil {
				t.Fatal(err)
			}
			if c.pendingDialog == nil || c.pendingDialog.DialogID != "successor" {
				t.Fatal("late original reply replaced successor")
			}
		})
	}
}

func TestManagedDialogSourceWireKeepsOriginalReceiptAndClaim(t *testing.T) {
	var decisions int
	state := func(f *userFixture, id string, sequence uint64) map[string]any {
		v := fixtureDialogState(f, id, sequence)
		if id != "" {
			v["pendingDialog"].(map[string]any)["source"] = map[string]string{"origin": "https://child.test", "frame": "child"}
		}
		return v
	}
	f := newUserFixture(t, func(f *userFixture, r userTestRequest) bool {
		if r.Operation == "humanBegin" {
			f.evaluated(r, map[string]any{"status": state(f, "original", 5)})
			return true
		}
		if r.Operation != "humanDialogRespond" {
			return false
		}
		decisions++
		if r.Arguments["source"] != nil {
			t.Error("display source crossed decision boundary")
		}
		f.evaluated(r, fixtureDialogResult(r, state(f, "", 6)))
		return true
	}, false)
	c := f.open()
	result, err := c.Command(context.Background(), json.RawMessage(`{"operation":"humanBegin","tabId":7}`))
	if err != nil {
		t.Fatal(err)
	}
	var reply struct {
		Status struct {
			PendingDialog struct {
				Source map[string]string `json:"source"`
			} `json:"pendingDialog"`
		} `json:"status"`
	}
	if json.Unmarshal(result, &reply) != nil || reply.Status.PendingDialog.Source["origin"] != "https://child.test" {
		t.Fatal("original source lost at worker-to-Go boundary")
	}
	if _, err = c.Command(context.Background(), fixtureDialogRequest("original")); err != nil {
		t.Fatal(err)
	}
	if _, err = c.Command(context.Background(), fixtureDialogRequest("original")); err == nil || decisions != 1 {
		t.Fatal("source change reset one-shot claim")
	}
}

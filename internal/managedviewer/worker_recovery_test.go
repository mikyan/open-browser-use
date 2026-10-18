package managedviewer

import (
	"encoding/json"
	"os"
	"strings"
	"testing"
)

// This consumes actual JS bridge output. Its backend simulates persistence and
// native cleanup, so these assertions prove the public protocol, not recovery.
func TestWorkerRecoveryBridgeExposesFreshResultButNotPrivateJournal(t *testing.T) {
	data, err := os.ReadFile("testdata/worker-recovery-fixture.json")
	if err != nil {
		t.Fatal(err)
	}
	var fixture map[string]json.RawMessage
	if err := json.Unmarshal(data, &fixture); err != nil {
		t.Fatal(err)
	}
	opened, err := object(fixture["recoveredOpen"])
	if err != nil || opened["recoveryState"] == nil || opened["workerRecovery"] == nil {
		t.Fatal("fixture must exercise actual private recovery metadata")
	}
	for _, key := range []string{"recoveredOpen", "status"} {
		public, err := publicState(fixture[key])
		if err != nil {
			t.Fatalf("%s: %v", key, err)
		}
		for _, private := range []string{"recoveryState", "workerRecovery", "browserIncarnation", "journalId", "workerEpoch", "retiredViews", "targetId", "nonce", "channelId", "portId", "runId"} {
			if strings.Contains(string(public), `"`+private+`"`) {
				t.Fatalf("%s leaked %s", key, private)
			}
		}
		var state struct {
			Status struct {
				State        string
				InputBlocked bool
			}
			SelectedTabID *int
			Human, View   json.RawMessage
			Tabs          []struct{ Kind, DeliveryID string }
		}
		if json.Unmarshal(public, &state) != nil || state.Status.State != "paused" || !state.Status.InputBlocked ||
			state.SelectedTabID != nil || string(state.Human) != "null" || string(state.View) != "null" || len(state.Tabs) != 1 ||
			state.Tabs[0].Kind != "result" || state.Tabs[0].DeliveryID != "delivery-replacement" {
			t.Fatalf("recovered viewer inherited old control or lost the fresh result: %s", public)
		}
	}
	if _, err := publicState(fixture["disconnect"]); err == nil {
		t.Fatal("retired replacement channel still authorized public state")
	}
}

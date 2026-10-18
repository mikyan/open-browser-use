package managedbrowser

import (
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"testing"
	"time"

	"github.com/ifuryst/open-browser-use/internal/managedprotocol"
)

// These are actual production-bridge results with a simulated backend, carried
// through the real controller WebSocket. They are not browser acceptance.
func TestManagedRetirementCloseRequiresExactOriginalCleanup(t *testing.T) {
	data, err := os.ReadFile(filepath.Join("..", "managedviewer", "testdata", "native-retire-fixture.json"))
	if err != nil {
		t.Fatal(err)
	}
	var fixture struct {
		Disconnect            json.RawMessage
		FirstEnd, SecondBegin struct{ Status json.RawMessage }
	}
	if err := json.Unmarshal(data, &fixture); err != nil {
		t.Fatal(err)
	}
	first, _ := userObject(fixture.FirstEnd.Status)
	second, _ := userObject(fixture.SecondBegin.Status)
	for _, mutation := range []string{"valid", "running", "selected", "pending", "human", "view", "old-lease", "no-human", "no-view", "no-stream-id", "live-stream", "pending-dialog"} {
		t.Run(mutation, func(t *testing.T) {
			response, _ := userObject(fixture.Disconnect)
			state, _ := userObject(response["status"])
			switch mutation {
			case "running":
				state["automation"] = json.RawMessage(`{"state":"running","inputBlocked":false,"cleanupComplete":false,"revision":3}`)
			case "selected":
				state["selectedTabId"] = json.RawMessage(`7`)
			case "pending":
				state["cleanupPending"] = json.RawMessage(`1`)
			case "pending-dialog":
				state["pendingDialog"] = json.RawMessage(`{"leaseId":"unreleased","generation":1,"dialogId":"original","type":"alert","message":"still open"}`)
			case "human":
				state["human"] = second["human"]
			case "view":
				state["view"] = second["human"]
			case "old-lease":
				state["humanCleanup"] = first["humanCleanup"]
			case "no-human":
				delete(state, "human")
			case "no-view":
				delete(state, "view")
			case "no-stream-id":
				state["stream"] = json.RawMessage(`{"state":"idle"}`)
			case "live-stream":
				state["stream"] = json.RawMessage(`{"state":"idle","streamId":"live"}`)
			}
			response["status"], _ = json.Marshal(state)
			f := newUserFixture(t, func(f *userFixture, r userTestRequest) bool {
				if r.Operation != "retire" {
					return false
				}
				f.evaluated(r, response)
				return true
			}, false)
			if err := json.Unmarshal(fixture.SecondBegin.Status, &f.identity); err != nil {
				t.Fatal(err)
			}
			identity := f.identity
			identity.ChannelID = ""
			ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
			defer cancel()
			c, err := openUserController(ctx, f.endpoint(), identity, f.owner)
			if err != nil {
				t.Fatal(err)
			}
			c.mu.Lock()
			c.humanRisk = true
			c.humanStatus, err = managedprotocol.ParseHumanState(second["human"])
			originalLease := c.humanStatus.LeaseID
			c.mu.Unlock()
			if err != nil {
				t.Fatal(err)
			}
			valid := mutation == "valid" || mutation == "running"
			err = c.Close(ctx)
			if valid {
				if err != nil {
					t.Fatal(err)
				}
				if _, err := c.recoveryCleanup(); err != nil {
					t.Fatal(err)
				}
				return
			}
			if err == nil {
				t.Fatal("incomplete retirement reported successful Close")
			}
			select {
			case <-c.cleanupDone:
				t.Fatal("cleanup completed before original owner exit")
			default:
			}
			c.mu.Lock()
			preserved := c.humanStatus != nil && c.humanStatus.LeaseID == originalLease
			c.mu.Unlock()
			if !preserved {
				t.Error("rejected receipt replaced original human risk identity")
			}
			if _, err := c.recoveryCleanup(); err == nil {
				t.Error("incomplete retirement permitted recovery")
			}
			f.ownerOnce.Do(func() { close(f.owner) })
			userWait(t, c.cleanupDone)
			if err := c.Close(ctx); err != nil {
				t.Fatal(err)
			}
			if _, err := c.recoveryCleanup(); err == nil {
				t.Fatal("owner termination substituted for original bridge recovery receipt")
			}
			c.mu.Lock()
			var proof struct{ CleanupProof string }
			_ = json.Unmarshal(c.cleanupReceipt, &proof)
			c.mu.Unlock()
			if proof.CleanupProof != "session-terminated" {
				t.Fatalf("wrong terminal proof %q", proof.CleanupProof)
			}
		})
	}
}

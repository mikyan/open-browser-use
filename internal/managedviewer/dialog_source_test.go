package managedviewer

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"github.com/ifuryst/open-browser-use/internal/managedprotocol"
	"testing"
)

func viewerSourceState(t *testing.T, id, origin string, sequence uint64) json.RawMessage {
	t.Helper()
	f, _ := object(dialogState(id, sequence))
	s, _ := object(f["status"])
	if id != "" && origin != "" {
		d, _ := object(s["pendingDialog"])
		d["source"] = jsonBytes(map[string]string{"origin": origin, "frame": "child"})
		s["pendingDialog"] = jsonBytes(d)
	}
	f["status"] = jsonBytes(s)
	public, err := publicState(jsonBytes(f))
	if err != nil {
		t.Fatal(err)
	}
	return public
}

func TestViewerDialogSourceClaimAndSuccessorIsolation(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	c := &connection{ctx: ctx, humanCtx: ctx, humanClaimed: true, humanLease: humanTestLease, humanTabID: 1, inputs: make(chan command, 8)}
	observe := func(id, origin string, seq uint64) error {
		return c.acceptHumanResult(command{operation: "status"}, viewerSourceState(t, id, origin, seq))
	}
	if err := observe("first", "https://first.test", 10); err != nil {
		t.Fatal(err)
	}
	raw := json.RawMessage(dialogRequest(1, "first"))
	fields, _ := object(raw)
	delete(fields, "id")
	request := command{operation: "humanDialogRespond", payload: jsonBytes(fields)}
	if code := c.admitDialog(&request); code != "" {
		t.Fatal(code)
	}
	if err := observe("first", "https://first.test", 11); err != nil {
		t.Fatal(err)
	}
	if code := c.admitDialog(&request); code != "HUMAN_DIALOG_STALE" {
		t.Fatal("repeat status restored claim")
	}
	if err := observe("", "", 12); err != nil {
		t.Fatal(err)
	}
	if err := observe("first", "", 13); err == nil {
		t.Fatal("source removal across null gap accepted")
	}
	if err := observe("next", "https://next.test", 14); err != nil {
		t.Fatal(err)
	}
	if err := observe("first", "https://first.test", 11); err != nil {
		t.Fatal(err)
	}
	if c.pendingDialog.DialogID != "next" || c.pendingDialog.Source.Origin != "https://next.test" {
		t.Fatal("late reply overwrote next dialog")
	}
	original := c.pendingDialog.DialogIdentity
	copy := *c.pendingDialog
	copy.Source.Origin = "https://mutated.test"
	if c.dialogClaims[original].Source.Origin != "https://next.test" {
		t.Fatal("value copy mutated pinned source")
	}
	// The existing bounded identity map includes pending, not-yet-claimed
	// dialogs; reaching capacity must not prevent the last admitted decision.
	for len(c.dialogClaims) < 1024 {
		id := managedprotocol.DialogIdentity{LeaseID: humanTestLease, Generation: 1, DialogID: fmt.Sprint(len(c.dialogClaims))}
		c.dialogClaims[id] = managedprotocol.DialogClaim{}
	}
	if err := observe("overflow", "https://overflow.test", 15); err == nil {
		t.Fatal("identity capacity silently evicted source pins")
	}
	fields["dialogId"] = jsonBytes("next")
	request.payload = jsonBytes(fields)
	if code := c.admitDialog(&request); code != "" {
		t.Fatalf("capacity blocked already admitted decision: %s", code)
	}
}

func TestViewerDialogSourceProjectionAndPin(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	c := &connection{ctx: ctx, humanCtx: ctx, humanClaimed: true, humanLease: humanTestLease, humanTabID: 1, inputs: make(chan command, 8)}
	first := viewerSourceState(t, "first", "https://child.test", 10)
	if err := c.acceptHumanResult(command{operation: "status"}, first); err != nil {
		t.Fatal(err)
	}
	if err := c.acceptHumanResult(command{operation: "status"}, viewerSourceState(t, "first", "https://changed.test", 9)); err != nil {
		t.Fatalf("late state rejected instead of ignored: %v", err)
	}
	if err := c.acceptHumanResult(command{operation: "status"}, viewerSourceState(t, "first", "https://changed.test", 11)); err == nil {
		t.Fatal("viewer accepted changed source for original tuple")
	}
}

func TestViewerDialogSourceMissingIsPinned(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	c := &connection{ctx: ctx, humanCtx: ctx, humanClaimed: true, humanLease: humanTestLease, humanTabID: 1, inputs: make(chan command, 8)}
	if err := c.acceptHumanResult(command{operation: "status"}, viewerSourceState(t, "first", "", 10)); err != nil {
		t.Fatal(err)
	}
	if err := c.acceptHumanResult(command{operation: "status"}, viewerSourceState(t, "first", "https://later.test", 11)); err == nil {
		t.Fatal("legacy source silently upgraded")
	}
}

func TestViewerDialogSourceErrorKeepsOriginalCleanupEpoch(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	c := &connection{ctx: ctx, humanCtx: ctx, humanEpoch: 7, humanClaimed: true, humanLease: humanTestLease, humanTabID: 1, inputs: make(chan command, 8)}
	if err := c.observeHumanState(viewerSourceState(t, "first", "https://first.test", 10)); err != nil {
		t.Fatal(err)
	}
	err := c.observeHumanState(viewerSourceState(t, "first", "https://changed.test", 11))
	var original *dialogSourceStateError
	if !errors.As(err, &original) || original.epoch != 7 {
		t.Fatal("source error lost original admission")
	}
	c.humanEpoch = 8 // A later Begin may win after validation, before cleanup.
	s := &Server{}
	s.releaseFailedHuman(c, original.epoch)
	if c.humanRevoked || c.humanEpoch != 8 {
		t.Fatal("old source error revoked successor admission")
	}
}

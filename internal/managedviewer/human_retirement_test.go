package managedviewer

import (
	"context"
	"encoding/json"
	"errors"
	"sync"
	"testing"

	"github.com/ifuryst/open-browser-use/internal/managedprotocol"
)

func TestHumanRetirementEndCancelsQueueButPreservesSubmittedReceipt(t *testing.T) {
	b := humanTestBackend()
	base := b.command
	release := make(chan struct{})
	cancelled := make(chan error, 1)
	var once sync.Once
	b.command = func(ctx context.Context, data json.RawMessage) (json.RawMessage, error) {
		if humanTestOperation(data) != "humanInput" {
			return base(ctx, data)
		}
		<-ctx.Done()
		cancelled <- context.Cause(ctx)
		<-release
		return generationReceipt(data, humanTestState(false, 0)), nil
	}
	s := startTest(t, b, nil)
	t.Cleanup(func() { once.Do(func() { close(release) }) })
	c := humanTestBegin(t, b, s)
	send(t, c, generationInput(2, 1, 1))
	humanTestCall(t, b, "humanInput")
	send(t, c, generationInput(3, 1, 2))
	send(t, c, `{"id":4,"operation":"status"}`)
	humanTestCall(t, b, "status")
	humanTestSuccess(t, c, 4)
	send(t, c, `{"id":5,"operation":"humanEnd","leaseId":"original-human-lease"}`)
	humanTestError(t, c, 3, "HUMAN_STALE")
	if cause := <-cancelled; !errors.Is(cause, managedprotocol.ErrHumanLeaseRetired) {
		t.Fatalf("lost typed release: %v", cause)
	}
	humanTestCall(t, b, "humanEnd")
	humanTestSuccess(t, c, 5)
	once.Do(func() { close(release) })
	humanTestSuccess(t, c, 2)
	send(t, c, generationInput(6, 1, 3))
	humanTestError(t, c, 6, "HUMAN_STALE")
	select {
	case call := <-b.calls:
		t.Fatalf("retired input replayed: %s", call)
	default:
	}
}

func TestHumanRetirementDisconnectAndFailureKeepOrdinaryCancellation(t *testing.T) {
	for _, parentGone := range []bool{false, true} {
		ctx, cancel := context.WithCancel(context.Background())
		humanCtx, humanCancel := context.WithCancel(ctx)
		inputCtx, inputCancel := context.WithCancelCause(humanCtx)
		c := &connection{ctx: ctx, humanCtx: humanCtx, humanCancel: humanCancel, inputCtx: inputCtx, inputCancel: inputCancel, inputs: make(chan command, 1)}
		if parentGone {
			cancel()
			c.revokeHumanForRelease()
		} else {
			c.revokeHuman()
		}
		if !errors.Is(context.Cause(inputCtx), context.Canceled) {
			t.Fatalf("disconnect/failure was treated as explicit release: %v", context.Cause(inputCtx))
		}
		cancel()
	}
}

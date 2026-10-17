package managedviewer

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"sync"
	"testing"

	"github.com/coder/websocket"
	"github.com/ifuryst/open-browser-use/internal/managedprotocol"
)

func generationState(generation, eventSequence uint64, kind string) json.RawMessage {
	f, _ := object(humanTestState(true, 0))
	state, _ := object(f["status"])
	human, _ := object(state["human"])
	human["generation"], human["state"] = jsonBytes(generation), jsonBytes(kind)
	if kind == "navigating" {
		human["viewport"] = jsonBytes(nil)
	}
	state["human"], state["eventSequence"] = jsonBytes(human), jsonBytes(eventSequence)
	f["status"] = jsonBytes(state)
	return jsonBytes(f)
}

func generationInput(id, generation, sequence uint64) string {
	return fmt.Sprintf(`{"id":%d,"operation":"humanInput","leaseId":%q,"generation":%d,"sequence":%d,"input":{"type":"pointer","action":"move","x":10,"y":10}}`, id, humanTestLease, generation, sequence)
}

func generationReceipt(request, state json.RawMessage) json.RawMessage {
	f, _ := object(state)
	input, _ := object(request)
	f["inputReceipt"] = jsonBytes(map[string]any{"leaseId": input["leaseId"], "generation": input["generation"], "sequence": input["sequence"], "acknowledged": true})
	return jsonBytes(f)
}

func publishGeneration(b *testBackend, state json.RawMessage) {
	f, _ := object(state)
	s, _ := object(f["status"])
	b.events <- jsonBytes(map[string]any{"type": "status", "sequence": s["eventSequence"], "status": s})
}

func generationReadState(t *testing.T, c *websocket.Conn, generation uint64) {
	t.Helper()
	for {
		m := readMessage(t, c)
		var human managedprotocol.HumanState
		_ = json.Unmarshal(m["human"], &human)
		if string(m["type"]) == `"state"` && human.Generation == generation {
			return
		}
		if string(m["type"]) == `"clear"` {
			t.Fatal("navigation emitted whole-lease Clear")
		}
	}
}

func TestHumanGenerationRetiresQueueButJoinsOriginalReceipt(t *testing.T) {
	b := humanTestBackend()
	base := b.command
	release := make(chan struct{})
	cancelled := make(chan error, 1)
	var once sync.Once
	b.command = func(ctx context.Context, data json.RawMessage) (json.RawMessage, error) {
		if humanTestOperation(data) != "humanInput" {
			return base(ctx, data)
		}
		f, _ := object(data)
		if string(f["generation"]) == "1" {
			<-ctx.Done()
			cancelled <- context.Cause(ctx)
			<-release // Same submitted native call, never a fabricated cancellation ACK.
			return generationReceipt(data, generationState(1, 2, "active")), nil
		}
		return generationReceipt(data, generationState(3, 11, "active")), nil
	}
	s := startTest(t, b, nil)
	t.Cleanup(func() { once.Do(func() { close(release) }) })
	c := humanTestBegin(t, b, s)
	send(t, c, generationInput(2, 1, 1))
	humanTestCall(t, b, "humanInput")
	send(t, c, generationInput(3, 1, 2))
	// A reader barrier proves input 2 was queued before navigation.
	send(t, c, `{"id":4,"operation":"status"}`)
	humanTestCall(t, b, "status")
	humanTestSuccess(t, c, 4)
	publishGeneration(b, generationState(3, 10, "navigating"))
	humanTestError(t, c, 3, "HUMAN_GENERATION_STALE")
	if cause := <-cancelled; !errors.Is(cause, managedprotocol.ErrHumanGenerationRetired) {
		t.Fatalf("wrong cancellation: %v", cause)
	}
	publishGeneration(b, generationState(3, 11, "active"))
	generationReadState(t, c, 3)
	send(t, c, generationInput(5, 3, 1))
	humanTestError(t, c, 5, "HUMAN_STALE") // Status is not an actual frame.
	humanTestFrame(t, b, c, humanTestLease, 3, 12)
	send(t, c, generationInput(6, 3, 1))
	send(t, c, `{"id":7,"operation":"status"}`)
	humanTestCall(t, b, "status")
	humanTestSuccess(t, c, 7)
	select {
	case call := <-b.calls:
		t.Fatalf("new input overtook original receipt: %s", call)
	default:
	}
	once.Do(func() { close(release) })
	humanTestSuccess(t, c, 2)
	call := humanTestCall(t, b, "humanInput")
	if f, _ := object(call); string(f["generation"]) != "3" || string(f["sequence"]) != "1" {
		t.Fatalf("old input replayed: %s", call)
	}
	humanTestSuccess(t, c, 6)
	send(t, c, generationInput(8, 1, 3))
	humanTestError(t, c, 8, "HUMAN_GENERATION_STALE")
	send(t, c, `{"id":9,"operation":"resume","expectedRevision":8,"expectedWorkerBootId":"worker-a"}`)
	humanTestError(t, c, 9, "HUMAN_BUSY")
}

type generationStaleError struct{}

func (generationStaleError) Error() string         { return "secret diagnostic" }
func (generationStaleError) UserErrorCode() string { return "OBU_HUMAN_GENERATION_STALE" }

func TestHumanGenerationKnownUnsentDoesNotEndLeaseUnknownDoes(t *testing.T) {
	for _, known := range []bool{true, false} {
		t.Run(fmt.Sprint(known), func(t *testing.T) {
			b := humanTestBackend()
			base := b.command
			b.command = func(ctx context.Context, data json.RawMessage) (json.RawMessage, error) {
				if humanTestOperation(data) == "humanInput" {
					if known {
						return nil, generationStaleError{}
					}
					return nil, context.Canceled // No evidence whether native input happened.
				}
				return base(ctx, data)
			}
			s := startTest(t, b, nil)
			c := humanTestBegin(t, b, s)
			send(t, c, generationInput(2, 1, 1))
			humanTestCall(t, b, "humanInput")
			if !known {
				humanTestError(t, c, 2, "OPERATION_UNCONFIRMED")
				humanTestCall(t, b, "select")
				return
			}
			humanTestError(t, c, 2, "HUMAN_GENERATION_STALE")
			// Even a late active snapshot cannot reactivate the retired g1.
			publishGeneration(b, generationState(1, 8, "active"))
			generationReadState(t, c, 1)
			send(t, c, generationInput(3, 1, 2))
			humanTestError(t, c, 3, "HUMAN_GENERATION_STALE")
			select {
			case call := <-b.calls:
				t.Fatalf("known unsubmitted input ended lease: %s", call)
			default:
			}
			publishGeneration(b, generationState(5, 10, "active")) // Coalesced redirects.
			generationReadState(t, c, 5)
			humanTestFrame(t, b, c, humanTestLease, 5, 11)
			send(t, c, generationInput(4, 5, 1))
			humanTestCall(t, b, "humanInput")
			humanTestError(t, c, 4, "HUMAN_GENERATION_STALE")
		})
	}
}

func TestHumanGenerationOldFrameAndStatusCannotRestoreInput(t *testing.T) {
	b := humanTestBackend()
	s := startTest(t, b, nil)
	c := humanTestBegin(t, b, s)
	publishGeneration(b, generationState(4, 10, "navigating"))
	generationReadState(t, c, 4)
	// Inject an old generation with a newer transport sequence to ensure the
	// generation fence works independently of display ordering.
	b.events <- jsonBytes(map[string]any{"type": "frame", "sequence": 11, "frameSequence": 2, "tabId": 1, "streamId": "old", "mimeType": "image/png", "data": "aW1hZ2U=", "controlMode": "human", "humanLeaseId": humanTestLease, "generation": 1})
	publishGeneration(b, generationState(1, 12, "active"))
	generationReadState(t, c, 1)
	send(t, c, generationInput(2, 1, 1))
	humanTestError(t, c, 2, "HUMAN_GENERATION_STALE")
	send(t, c, generationInput(3, 4, 1))
	humanTestError(t, c, 3, "HUMAN_STALE")
	select {
	case call := <-b.calls:
		t.Fatalf("stale data restored authority: %s", call)
	default:
	}
}

func TestHumanGenerationUnknownOriginalFailureStillReleasesWholeLease(t *testing.T) {
	b := humanTestBackend()
	base := b.command
	release := make(chan struct{})
	var once sync.Once
	b.command = func(ctx context.Context, data json.RawMessage) (json.RawMessage, error) {
		if humanTestOperation(data) == "humanInput" {
			<-release
			return nil, errors.New("original native result remains unknown")
		}
		return base(ctx, data)
	}
	s := startTest(t, b, nil)
	t.Cleanup(func() { once.Do(func() { close(release) }) })
	c := humanTestBegin(t, b, s)
	send(t, c, generationInput(2, 1, 1))
	humanTestCall(t, b, "humanInput")
	publishGeneration(b, generationState(3, 10, "active"))
	generationReadState(t, c, 3)
	humanTestFrame(t, b, c, humanTestLease, 3, 11)
	send(t, c, generationInput(3, 3, 1))
	send(t, c, `{"id":4,"operation":"status"}`)
	humanTestCall(t, b, "status")
	humanTestSuccess(t, c, 4)
	once.Do(func() { close(release) })
	humanTestError(t, c, 2, "OPERATION_UNCONFIRMED")
	humanTestCall(t, b, "select")
	select {
	case call := <-b.calls:
		t.Fatalf("unknown native outcome allowed successor input: %s", call)
	default:
	}
}

func TestHumanGenerationLateBeginPreservesAlreadyQueuedMatchingFrame(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	c := &connection{ctx: ctx, cancel: cancel, frames: make(chan json.RawMessage, 1), inputs: make(chan command, 1), releases: make(chan struct{}, 1)}
	request, err := parseCommand([]byte(`{"id":1,"operation":"humanBegin","tabId":1}`))
	if err != nil || !c.admitBegin(&request) {
		t.Fatal("Begin admission failed", err)
	}
	state, err := publicState(generationState(1, 2, "active"))
	if err != nil {
		t.Fatal(err)
	}
	c.observeHumanState(state)
	frame := jsonBytes(map[string]any{"type": "frame", "controlMode": "human", "humanLeaseId": humanTestLease, "generation": 1, "tabId": 1, "eventSequence": 3})
	if !c.observeHumanFrame(frame) {
		t.Fatal("matching early frame rejected")
	}
	c.frames <- frame // Deliberately no writer yet: exactly one static first frame.
	if err := c.acceptHumanResult(request, state); err != nil {
		t.Fatal(err)
	}
	select {
	case original := <-c.frames:
		if string(original) != string(frame) {
			t.Fatal("original matching frame was replaced")
		}
	default:
		t.Fatal("late Begin reply discarded the only matching first frame")
	}
}

func TestHumanGenerationRetirementDoesNotReplayTakenFrameOrKeepOldFrame(t *testing.T) {
	for _, taken := range []bool{true, false} {
		t.Run(fmt.Sprint(taken), func(t *testing.T) {
			ctx, cancel := context.WithCancel(context.Background())
			defer cancel()
			c := &connection{ctx: ctx, cancel: cancel, frames: make(chan json.RawMessage, 1), inputs: make(chan command, 1), releases: make(chan struct{}, 1)}
			request, _ := parseCommand([]byte(`{"id":1,"operation":"humanBegin","tabId":1}`))
			if !c.admitBegin(&request) {
				t.Fatal("Begin admission failed")
			}
			state, _ := publicState(generationState(1, 2, "active"))
			c.observeHumanState(state)
			frame := jsonBytes(map[string]any{"type": "frame", "controlMode": "human", "humanLeaseId": humanTestLease, "generation": 1, "tabId": 1, "eventSequence": 3})
			if !c.observeHumanFrame(frame) {
				t.Fatal("matching frame rejected")
			}
			c.frames <- frame
			if taken {
				<-c.frames
			} // The writer already owns this exact item.
			if err := c.acceptHumanResult(request, state); err != nil {
				t.Fatal(err)
			}
			if !taken {
				newState, _ := publicState(generationState(3, 10, "navigating"))
				c.observeHumanState(newState)
			}
			select {
			case queued := <-c.frames:
				t.Fatalf("taken frame replayed or old frame retained: %s", queued)
			default:
			}
		})
	}
}

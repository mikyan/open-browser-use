package managedbrowser

import (
	"context"
	"encoding/json"
	"errors"
	"testing"
	"time"

	"github.com/ifuryst/open-browser-use/internal/managedprotocol"
)

func userGenerationState(f *userFixture, generation uint64, kind string) map[string]any {
	state := humanFixtureState(f)
	human := state["human"].(map[string]any)
	human["generation"], human["state"] = generation, kind
	if kind == "navigating" {
		human["viewport"] = nil
	}
	return state
}

func userGenerationEvent(f *userFixture, generation uint64, kind string) uint64 {
	f.mu.Lock()
	f.sequence++
	sequence, identity := f.sequence, f.identity
	f.mu.Unlock()
	data, _ := json.Marshal(identity)
	value := map[string]any{}
	_ = json.Unmarshal(data, &value)
	value["type"], value["sequence"], value["status"] = "status", sequence, userGenerationState(f, generation, kind)
	payload, _ := json.Marshal(value)
	f.write(map[string]any{"method": "Runtime.bindingCalled", "sessionId": "worker-session", "params": map[string]any{"name": userBindingName, "executionContextId": 7, "payload": string(payload)}})
	return sequence
}

func userGenerationFrame(f *userFixture, generation uint64, stream string) uint64 {
	return f.emit("frame", map[string]any{"tabId": 7, "streamId": stream, "frameSequence": 1, "mimeType": "image/png", "data": "YQ==", "controlMode": "human", "humanLeaseId": "original-lease", "generation": generation})
}

func TestManagedHumanGenerationCancellationSettlesSameSubmittedCall(t *testing.T) {
	for _, expire := range []bool{false, true} {
		t.Run(map[bool]string{false: "original-receipt", true: "original-deadline"}[expire], func(t *testing.T) {
			held := make(chan userTestRequest, 1)
			f := newUserFixture(t, func(f *userFixture, req userTestRequest) bool {
				if req.Operation == "humanBegin" {
					f.evaluated(req, map[string]any{"status": humanFixtureState(f)})
					return true
				}
				if req.Operation == "humanInput" {
					held <- req
					return true
				}
				return false
			}, false)
			c := f.open()
			if _, err := c.Command(context.Background(), json.RawMessage(`{"operation":"humanBegin","tabId":7}`)); err != nil {
				t.Fatal(err)
			}
			budget := time.Second
			if expire {
				budget = 80 * time.Millisecond
			}
			deadline, finish := context.WithTimeout(context.Background(), budget)
			defer finish()
			ctx, cancel := context.WithCancelCause(deadline)
			defer cancel(nil)
			done := make(chan userReply, 1)
			go func() { data, err := c.Command(ctx, humanFixtureRequest()); done <- userReply{data: data, err: err} }()
			input := userWait(t, held)
			cancel(managedprotocol.ErrHumanGenerationRetired)
			userGenerationEvent(f, 4, "navigating")
			userWait(t, c.Events()) // Actual new generation has reached the controller.
			select {
			case reply := <-done:
				t.Fatalf("submission cancel invented native result: %v", reply.err)
			default:
			}
			if expire {
				reply := userWait(t, done)
				if !errors.Is(reply.err, context.DeadlineExceeded) {
					t.Fatalf("original deadline lost: %v", reply.err)
				}
				c.mu.Lock()
				pending := len(c.commands)
				c.mu.Unlock()
				if pending != 1 {
					t.Fatal("original native call was forgotten at caller deadline")
				}
				f.rejected(input, "OBU_HUMAN_GENERATION_STALE")
				return
			}
			f.evaluated(input, map[string]any{"status": userGenerationState(f, 4, "navigating"), "inputReceipt": map[string]any{"leaseId": "original-lease", "generation": 1, "sequence": 1, "acknowledged": true}})
			reply := userWait(t, done)
			if reply.err != nil {
				t.Fatal(reply.err)
			}
			fields, _ := userObject(reply.data)
			receipt, _ := managedprotocol.ParseInputReceipt(fields["inputReceipt"])
			if receipt == nil || receipt.Generation != 1 || receipt.Sequence != 1 {
				t.Fatal("receipt was rewritten for successor document")
			}
			c.mu.Lock()
			risk, generation := c.humanRisk, c.humanStatus.Generation
			c.mu.Unlock()
			if !risk || generation != 4 {
				t.Fatal("navigation cleared held-input risk or revived old status")
			}
		})
	}
}

func TestManagedHumanGenerationCanceledBeforeWriteIsPreciselyUnsubmitted(t *testing.T) {
	f := newUserFixture(t, nil, false)
	c := f.open()
	c.cdp.writeGate <- struct{}{}
	ctx, cancel := context.WithCancelCause(context.Background())
	call, err := c.cdp.start(ctx, "worker-session", "Runtime.evaluate", map[string]any{"expression": `globalThis.__obuManagedUser.request({"operation":"humanInput"})`, "uniqueContextId": "original-context", "awaitPromise": true, "returnByValue": true})
	if err != nil {
		t.Fatal(err)
	}
	cancel(managedprotocol.ErrHumanGenerationRetired)
	deadline, finish := context.WithTimeout(context.Background(), time.Second)
	defer finish()
	_, err = call.wait(deadline)
	var coded *userBridgeError
	if !errors.As(err, &coded) || coded.code != "OBU_HUMAN_GENERATION_STALE" {
		t.Fatalf("missing definite non-submission: %v", err)
	}
	<-c.cdp.writeGate
	if _, err := c.Command(deadline, json.RawMessage(`{"operation":"status"}`)); err != nil {
		t.Fatal(err)
	}
	f.mu.Lock()
	defer f.mu.Unlock()
	for _, request := range f.requests {
		if request.Operation == "humanInput" {
			t.Fatal("retired generation was submitted")
		}
	}
}

func TestManagedHumanGenerationRetiresStreamWithoutWholeLeaseClear(t *testing.T) {
	acks := make(chan userTestRequest, 4)
	f := newUserFixture(t, func(f *userFixture, req userTestRequest) bool {
		if req.Operation == "ack" {
			acks <- req
			return true
		}
		return false
	}, false)
	c := f.open()
	userGenerationEvent(f, 1, "active")
	userWait(t, c.Events())
	userGenerationFrame(f, 1, "g1")
	oldACK := userWait(t, acks)
	userGenerationEvent(f, 4, "navigating")
	for {
		event := userWait(t, c.Events())
		var value struct {
			Type   string
			Status struct{ Human managedprotocol.HumanState }
		}
		_ = json.Unmarshal(event, &value)
		if value.Type == "clear" {
			t.Fatal("navigation ended whole lease")
		}
		if value.Type == "status" && value.Status.Human.Generation == 4 {
			break
		}
	}
	// An already-original ACK may finish after its old stream is retired.
	f.rejected(oldACK, "OBU_MANAGED_USER_ACK")
	// An obsolete same-lease frame must not restore old authority or poison the
	// live connection even if it arrives with a later transport event sequence.
	userGenerationFrame(f, 1, "g1")
	userGenerationEvent(f, 4, "active")
	userGenerationFrame(f, 4, "g4")
	newACK := userWait(t, acks)
	var acknowledged uint64
	_ = json.Unmarshal(newACK.Arguments["sequence"], &acknowledged)
	f.evaluated(newACK, map[string]any{"acknowledged": acknowledged, "workerBootId": f.identity.WorkerBootID})
	for {
		event := userWait(t, c.Events())
		var value struct {
			Type       string
			Generation uint64
			StreamID   string
		}
		_ = json.Unmarshal(event, &value)
		if value.Type == "clear" {
			t.Fatal("navigation emitted Clear")
		}
		if value.Type == "frame" {
			if value.Generation != 4 || value.StreamID != "g4" {
				t.Fatalf("retired frame restored: %s", event)
			}
			break
		}
	}
	select {
	case <-c.Done():
		t.Fatal("known retired ACK/frame killed original channel")
	default:
	}
}

func TestManagedHumanGenerationFutureFrameRequiresOriginalStatus(t *testing.T) {
	f := newUserFixture(t, nil, false)
	c := f.open()
	userGenerationEvent(f, 1, "active")
	userWait(t, c.Events())
	userGenerationFrame(f, 2, "unannounced")
	userWait(t, c.Done())
}

func TestManagedHumanGenerationAnnouncementSurvivesStatusCoalescing(t *testing.T) {
	acks := make(chan userTestRequest, 2)
	f := newUserFixture(t, func(f *userFixture, req userTestRequest) bool {
		if req.Operation == "ack" {
			acks <- req
		}
		return false
	}, false)
	c := f.open()
	// Do not consume Events until all three original worker events have been
	// read. A latest-state queue must not put the first frame before its g.
	userGenerationEvent(f, 3, "navigating")
	userGenerationFrame(f, 3, "g3")
	userWait(t, acks)
	userGenerationEvent(f, 3, "active")
	if _, err := c.Command(context.Background(), json.RawMessage(`{"operation":"status"}`)); err != nil {
		t.Fatal(err)
	}
	first := userWait(t, c.Events())
	var value struct {
		Type   string
		Status struct{ Human managedprotocol.HumanState }
	}
	_ = json.Unmarshal(first, &value)
	if value.Type != "status" || value.Status.Human.Generation != 3 {
		t.Fatalf("first frame preceded generation announcement: %s", first)
	}
	for {
		event := userWait(t, c.Events())
		var frame struct {
			Type       string
			Generation uint64
		}
		_ = json.Unmarshal(event, &frame)
		if frame.Type == "frame" {
			if frame.Generation != 3 {
				t.Fatal("wrong frame generation")
			}
			break
		}
	}
}

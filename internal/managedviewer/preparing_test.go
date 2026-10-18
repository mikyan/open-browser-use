package managedviewer

import (
	"context"
	"encoding/json"
	"fmt"
	"strings"
	"sync"
	"testing"
)

func preparingTestState(state string, generation, sequence uint64, dialog string) json.RawMessage {
	f, _ := object(dialogState(dialog, sequence))
	s, _ := object(f["status"])
	h, _ := object(s["human"])
	h["state"], h["generation"], h["inputBudgetVersion"] = jsonBytes(state), jsonBytes(generation), jsonBytes(1)
	if state != "active" {
		h["viewport"] = jsonBytes(nil)
	}
	s["human"] = jsonBytes(h)
	if dialog != "" {
		d, _ := object(s["pendingDialog"])
		d["generation"] = jsonBytes(generation)
		s["pendingDialog"] = jsonBytes(d)
	}
	f["status"] = jsonBytes(s)
	return jsonBytes(f)
}

func TestPreparingBeginAdmitsEndWithoutInputGeometry(t *testing.T) {
	for _, generation := range []uint64{0, 1} {
		t.Run(fmt.Sprint(generation), func(t *testing.T) {
			b := humanTestBackend()
			base := b.command
			b.command = func(ctx context.Context, data json.RawMessage) (json.RawMessage, error) {
				if humanTestOperation(data) == "humanBegin" {
					return preparingTestState("preparing", generation, 3, ""), nil
				}
				return base(ctx, data)
			}
			s := startTest(t, b, nil)
			c := authenticate(t, s)
			send(t, c, `{"id":1,"operation":"humanBegin","tabId":1}`)
			humanTestCall(t, b, "humanBegin")
			humanTestSuccess(t, c, 1)
			send(t, c, humanTestInput(2, 1))
			humanTestError(t, c, 2, "HUMAN_STALE")
			send(t, c, fmt.Sprintf(`{"id":3,"operation":"humanEnd","leaseId":%q}`, humanTestLease))
			humanTestCall(t, b, "humanEnd")
			humanTestSuccess(t, c, 3)
		})
	}
}

func TestPreparingAndNavigatingDialogsNeedOriginalBeginReceipt(t *testing.T) {
	for _, state := range []string{"preparing", "navigating"} {
		t.Run(state, func(t *testing.T) {
			b := humanTestBackend()
			base := b.command
			gate := make(chan struct{})
			var once sync.Once
			b.command = func(ctx context.Context, data json.RawMessage) (json.RawMessage, error) {
				switch humanTestOperation(data) {
				case "humanBegin":
					<-gate
					return preparingTestState(state, 1, 3, "original"), nil
				case "humanDialogRespond":
					return dialogReply(data, preparingTestState(state, 1, 5, "")), nil
				}
				return base(ctx, data)
			}
			s := startTest(t, b, nil)
			t.Cleanup(func() { once.Do(func() { close(gate) }) })
			c := authenticate(t, s)
			send(t, c, `{"id":1,"operation":"humanBegin","tabId":1}`)
			humanTestCall(t, b, "humanBegin")
			publishGeneration(b, preparingTestState(state, 1, 4, "original"))
			for string(readMessage(t, c)["type"]) != `"state"` {
			}
			send(t, c, dialogRequest(2, "original"))
			humanTestError(t, c, 2, "HUMAN_DIALOG_STALE")
			send(t, c, fmt.Sprintf(`{"id":3,"operation":"humanEnd","leaseId":%q}`, humanTestLease))
			humanTestError(t, c, 3, "HUMAN_STALE")
			once.Do(func() { close(gate) })
			humanTestSuccess(t, c, 1)
			send(t, c, dialogRequest(4, "original"))
			humanTestCall(t, b, "humanDialogRespond")
			humanTestSuccess(t, c, 4)
			send(t, c, humanTestInput(5, 1))
			humanTestError(t, c, 5, "HUMAN_STALE")
		})
	}
}

func TestPreparingSameGenerationFirstViewportStillRequiresOriginalNativeFrame(t *testing.T) {
	b := humanTestBackend()
	base := b.command
	b.command = func(ctx context.Context, data json.RawMessage) (json.RawMessage, error) {
		if humanTestOperation(data) == "humanBegin" {
			return preparingTestState("preparing", 1, 3, ""), nil
		}
		return base(ctx, data)
	}
	s := startTest(t, b, nil)
	c := authenticate(t, s)
	send(t, c, `{"id":1,"operation":"humanBegin","tabId":1}`)
	humanTestCall(t, b, "humanBegin")
	humanTestSuccess(t, c, 1)
	active := preparingTestState("active", 1, 4, "")
	publishGeneration(b, active)
	for string(readMessage(t, c)["type"]) != `"state"` {
	}
	send(t, c, humanTestInput(2, 1))
	humanTestError(t, c, 2, "HUMAN_STALE")
	humanTestFrame(t, b, c, humanTestLease, 1, 5)
	send(t, c, humanTestInput(3, 1))
	humanTestCall(t, b, "humanInput")
	humanTestSuccess(t, c, 3)
}

func TestPreparingLateBeginKeepsLatestProvedDialogGeneration(t *testing.T) {
	b := humanTestBackend()
	base := b.command
	gate := make(chan struct{})
	var once sync.Once
	b.command = func(ctx context.Context, data json.RawMessage) (json.RawMessage, error) {
		switch humanTestOperation(data) {
		case "humanBegin":
			<-gate
			return preparingTestState("preparing", 0, 3, ""), nil
		case "humanDialogRespond":
			return dialogReply(data, preparingTestState("navigating", 2, 6, "")), nil
		}
		return base(ctx, data)
	}
	s := startTest(t, b, nil)
	t.Cleanup(func() { once.Do(func() { close(gate) }) })
	c := authenticate(t, s)
	send(t, c, `{"id":1,"operation":"humanBegin","tabId":1}`)
	humanTestCall(t, b, "humanBegin")
	publishGeneration(b, preparingTestState("navigating", 2, 5, "new-document"))
	for string(readMessage(t, c)["type"]) != `"state"` {
	}
	once.Do(func() { close(gate) })
	humanTestSuccess(t, c, 1)
	send(t, c, strings.Replace(dialogRequest(2, "new-document"), `"generation":1`, `"generation":2`, 1))
	humanTestCall(t, b, "humanDialogRespond")
	humanTestSuccess(t, c, 2)
	send(t, c, humanTestInput(3, 1))
	humanTestError(t, c, 3, "HUMAN_GENERATION_STALE")
}

func TestNavigatingDialogBypassesOriginalUnsettledInputAndStillRequiresItsOwnReceipt(t *testing.T) {
	b := humanTestBackend()
	base := b.command
	release := make(chan struct{})
	var once sync.Once
	b.command = func(ctx context.Context, data json.RawMessage) (json.RawMessage, error) {
		switch humanTestOperation(data) {
		case "humanBegin":
			return preparingTestState("active", 1, 2, ""), nil
		case "humanInput":
			<-release // Deliberately retain the original call across generation cancellation.
			result, _ := object(preparingTestState("navigating", 2, 8, ""))
			result["inputReceipt"] = jsonBytes(map[string]any{"leaseId": humanTestLease, "generation": 1, "sequence": 1, "acknowledged": true})
			return jsonBytes(result), nil
		case "humanDialogRespond":
			return dialogReply(data, preparingTestState("navigating", 2, 7, "")), nil
		}
		return base(ctx, data)
	}
	s := startTest(t, b, nil)
	t.Cleanup(func() { once.Do(func() { close(release) }) })
	c := humanTestBegin(t, b, s)
	send(t, c, humanTestInput(2, 1))
	humanTestCall(t, b, "humanInput")
	publishGeneration(b, preparingTestState("navigating", 2, 6, "navigation-dialog"))
	for string(readMessage(t, c)["type"]) != `"state"` {
	}
	send(t, c, strings.Replace(dialogRequest(3, "navigation-dialog"), `"generation":1`, `"generation":2`, 1))
	humanTestCall(t, b, "humanDialogRespond")
	reply := humanTestSuccess(t, c, 3)
	f, _ := object(reply)
	if f["inputReceipt"] != nil || f["dialogReceipt"] == nil {
		t.Fatal("dialog response borrowed the outstanding input receipt")
	}
	once.Do(func() { close(release) })
	humanTestSuccess(t, c, 2)
}

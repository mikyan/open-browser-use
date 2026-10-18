package managedviewer

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/coder/websocket"
)

func dialogState(id string, sequence uint64) json.RawMessage {
	f, _ := object(humanTestState(true, 0))
	state, _ := object(f["status"])
	state["eventSequence"], state["pendingDialog"] = jsonBytes(sequence), jsonBytes(nil)
	if id != "" {
		state["pendingDialog"] = jsonBytes(map[string]any{"leaseId": humanTestLease, "generation": 1, "dialogId": id, "type": "prompt", "message": "Synthetic prompt", "defaultPrompt": ""})
	}
	f["status"] = jsonBytes(state)
	return jsonBytes(f)
}

func dialogRequest(id uint64, dialog string) string {
	return fmt.Sprintf(`{"id":%d,"operation":"humanDialogRespond","leaseId":%q,"generation":1,"dialogId":%q,"accept":true,"promptText":""}`, id, humanTestLease, dialog)
}

func dialogReply(request, state json.RawMessage) json.RawMessage {
	f, _ := object(state)
	requestFields, _ := object(request)
	f["dialogReceipt"] = jsonBytes(map[string]any{"leaseId": requestFields["leaseId"], "generation": requestFields["generation"], "dialogId": requestFields["dialogId"], "acknowledged": true})
	return jsonBytes(f)
}

func publishDialog(t *testing.T, b *testBackend, c *websocket.Conn, id string, sequence uint64) {
	t.Helper()
	publishGeneration(b, dialogState(id, sequence))
	for {
		value := readMessage(t, c)
		if string(value["type"]) == `"state"` && strings.Contains(string(value["pendingDialog"]), `"dialogId":"`+id+`"`) {
			return
		}
	}
}

func TestHumanDialogRejectsForeignAndDuplicateWithoutNativeDispatch(t *testing.T) {
	b := humanTestBackend()
	base := b.command
	release := make(chan struct{})
	var once sync.Once
	var count atomic.Int32
	b.command = func(ctx context.Context, data json.RawMessage) (json.RawMessage, error) {
		if humanTestOperation(data) == "humanDialogRespond" {
			count.Add(1)
			<-release
			return dialogReply(data, dialogState("", 10)), nil
		}
		return base(ctx, data)
	}
	s := startTest(t, b, nil)
	t.Cleanup(func() { once.Do(func() { close(release) }) })
	c := humanTestBegin(t, b, s)
	publishDialog(t, b, c, "first", 5)
	for i, replace := range []struct{ old, new string }{{humanTestLease, "foreign"}, {`"generation":1`, `"generation":2`}, {`"dialogId":"first"`, `"dialogId":"other"`}} {
		id := uint64(i + 2)
		send(t, c, strings.Replace(dialogRequest(id, "first"), replace.old, replace.new, 1))
		humanTestError(t, c, id, "HUMAN_DIALOG_STALE")
	}
	if count.Load() != 0 {
		t.Fatal("foreign decision reached backend")
	}
	send(t, c, dialogRequest(5, "first"))
	humanTestCall(t, b, "humanDialogRespond")
	send(t, c, dialogRequest(6, "first"))
	humanTestError(t, c, 6, "HUMAN_DIALOG_STALE")
	if count.Load() != 1 {
		t.Fatal("duplicate native decision")
	}
	once.Do(func() { close(release) })
	humanTestSuccess(t, c, 5)
}

type dialogTestError string

func (e dialogTestError) Error() string         { return "private native diagnostic" }
func (e dialogTestError) UserErrorCode() string { return string(e) }

func TestHumanDialogKnownUnsentVersusUnknownNativeFailure(t *testing.T) {
	for _, code := range []string{"OBU_HUMAN_DIALOG_STALE", "OBU_HUMAN_DIALOG_INVALID", "OBU_HUMAN_DIALOG_UNCONFIRMED", "OBU_HUMAN_DIALOG_STALE_EXTRA"} {
		t.Run(code, func(t *testing.T) {
			b := humanTestBackend()
			base := b.command
			b.command = func(ctx context.Context, data json.RawMessage) (json.RawMessage, error) {
				if humanTestOperation(data) == "humanDialogRespond" {
					return nil, dialogTestError(code)
				}
				return base(ctx, data)
			}
			s := startTest(t, b, nil)
			c := humanTestBegin(t, b, s)
			publishDialog(t, b, c, "first", 5)
			send(t, c, dialogRequest(2, "first"))
			humanTestCall(t, b, "humanDialogRespond")
			expected := strings.TrimPrefix(code, "OBU_")
			known := code == "OBU_HUMAN_DIALOG_STALE" || code == "OBU_HUMAN_DIALOG_INVALID"
			if !known {
				expected = "OPERATION_UNCONFIRMED"
			}
			humanTestError(t, c, 2, expected)
			if !known {
				humanTestCall(t, b, "select")
				send(t, c, dialogRequest(3, "first"))
				humanTestError(t, c, 3, "HUMAN_DIALOG_STALE")
			} else {
				publishDialog(t, b, c, "second", 6)
				send(t, c, dialogRequest(3, "second"))
				humanTestCall(t, b, "humanDialogRespond")
				humanTestError(t, c, 3, expected)
			}
		})
	}
}

func TestHumanDialogMismatchedReceiptReleasesOriginalLease(t *testing.T) {
	for _, wrong := range []string{"missing", "leaseId", "generation", "dialogId", "acknowledged"} {
		t.Run(wrong, func(t *testing.T) {
			b := humanTestBackend()
			base := b.command
			b.command = func(ctx context.Context, data json.RawMessage) (json.RawMessage, error) {
				if humanTestOperation(data) != "humanDialogRespond" {
					return base(ctx, data)
				}
				f, _ := object(dialogReply(data, dialogState("", 7)))
				receipt, _ := object(f["dialogReceipt"])
				switch wrong {
				case "missing":
					delete(f, "dialogReceipt")
				case "generation":
					receipt[wrong] = jsonBytes(2)
				case "acknowledged":
					receipt[wrong] = jsonBytes(false)
				default:
					receipt[wrong] = jsonBytes("foreign")
				}
				if wrong != "missing" {
					f["dialogReceipt"] = jsonBytes(receipt)
				}
				return jsonBytes(f), nil
			}
			s := startTest(t, b, nil)
			c := humanTestBegin(t, b, s)
			publishDialog(t, b, c, "first", 5)
			send(t, c, dialogRequest(2, "first"))
			humanTestCall(t, b, "humanDialogRespond")
			humanTestError(t, c, 2, "OPERATION_UNCONFIRMED")
			humanTestCall(t, b, "select")
		})
	}
}

func TestHumanDialogDisconnectStartsCleanupBeforeJoiningResponse(t *testing.T) {
	b := humanTestBackend()
	base := b.command
	release, cleanup := make(chan struct{}), make(chan struct{})
	var once, cleanOnce sync.Once
	b.command = func(ctx context.Context, data json.RawMessage) (json.RawMessage, error) {
		switch humanTestOperation(data) {
		case "humanDialogRespond":
			<-release
			return dialogReply(data, dialogState("", 8)), nil
		case "select":
			cleanOnce.Do(func() { close(cleanup) })
			return humanTestState(false, 0), nil
		}
		return base(ctx, data)
	}
	s := startTest(t, b, nil)
	t.Cleanup(func() { once.Do(func() { close(release) }) })
	c := humanTestBegin(t, b, s)
	publishDialog(t, b, c, "first", 5)
	send(t, c, dialogRequest(2, "first"))
	humanTestCall(t, b, "humanDialogRespond")
	_ = c.CloseNow()
	humanTestSignal(t, cleanup, "disconnect waited for dialog before starting cleanup")
	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Millisecond)
	defer cancel()
	if err := s.WaitReady(ctx); !errors.Is(err, context.DeadlineExceeded) {
		t.Fatalf("forgot original dialog caller: %v", err)
	}
	once.Do(func() { close(release) })
	ctx2, cancel2 := context.WithTimeout(context.Background(), time.Second)
	defer cancel2()
	if err := s.WaitReady(ctx2); err != nil {
		t.Fatal(err)
	}
}

func TestHumanDialogProjectionRejectsForeignReadonlyAndUnknownFields(t *testing.T) {
	for _, kind := range []string{"foreign", "readonly", "starting", "unknown"} {
		t.Run(kind, func(t *testing.T) {
			f, _ := object(dialogState("first", 5))
			state, _ := object(f["status"])
			dialog, _ := object(state["pendingDialog"])
			switch kind {
			case "foreign":
				dialog["leaseId"] = jsonBytes("foreign")
			case "readonly":
				state["human"] = jsonBytes(nil)
			case "starting":
				h, _ := object(state["human"])
				h["state"], h["viewport"] = jsonBytes("starting"), jsonBytes(nil)
				state["human"] = jsonBytes(h)
			case "unknown":
				dialog["nativeTarget"] = jsonBytes("secret")
			}
			state["pendingDialog"] = jsonBytes(dialog)
			f["status"] = jsonBytes(state)
			if _, err := publicState(jsonBytes(f)); err == nil {
				t.Fatal("invalid display authority accepted")
			}
		})
	}
}

func TestHumanDialogBoundedWorkCannotBlockSupervisorStop(t *testing.T) {
	b := humanTestBackend()
	base := b.command
	release, stopped := make(chan struct{}), make(chan struct{})
	var once sync.Once
	b.command = func(ctx context.Context, data json.RawMessage) (json.RawMessage, error) {
		if humanTestOperation(data) == "humanDialogRespond" {
			<-release
			return dialogReply(data, dialogState("", 20)), nil
		}
		return base(ctx, data)
	}
	s := startTest(t, b, func(context.Context) error { close(stopped); return nil })
	t.Cleanup(func() { once.Do(func() { close(release) }) })
	c := humanTestBegin(t, b, s)
	for i := uint64(0); i < 4; i++ {
		dialog := fmt.Sprintf("original-%d", i)
		publishDialog(t, b, c, dialog, i+5)
		send(t, c, dialogRequest(i+2, dialog))
		humanTestCall(t, b, "humanDialogRespond")
	}
	send(t, c, `{"id":6,"operation":"status"}`)
	humanTestError(t, c, 6, "BUSY")
	send(t, c, `{"id":7,"operation":"stop"}`)
	humanTestSignal(t, stopped, "Stop queued behind dialog native ACKs")
	humanTestSuccess(t, c, 7)
	once.Do(func() { close(release) })
}

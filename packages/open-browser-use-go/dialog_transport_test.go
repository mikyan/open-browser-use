package obu

import (
	"encoding/json"
	"net"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/ifuryst/open-browser-use/internal/wire"
)

func dialogInfo() Params {
	return Params{"metadata": Params{"turnLifecycleVersion": 1, "dialogVersion": 1}}
}

func TestDialogDelayedArmKeepsOriginalTabAndCancellationScope(t *testing.T) {
	armed, release := make(chan struct{}), make(chan struct{})
	path, cleanup := dialogPeer(t, func(conn net.Conn, r map[string]any) bool {
		p := r["params"].(map[string]any)
		switch r["method"] {
		case "armDialog":
			if p["tabId"] != float64(9) {
				t.Error(p)
			}
			close(armed)
			<-release
			writeResponse(t, conn, r["id"], Params{"dialogId": "original", "remainingMs": 25})
			return true
		case "cancelDialog":
			if p["tabId"] != float64(9) || p["control_epoch"] != float64(7) || p["turn_id"] != "first" || len(p) != 5 {
				t.Error("cancel changed original", p)
			}
			writeResponse(t, conn, r["id"], Params{})
			return true
		}
		return false
	})
	defer cleanup()
	c := NewClient(Options{SocketPath: path, TurnID: "first"})
	defer c.Close()
	tab := NewBrowser(c).Tab(9)
	done := make(chan *DialogWait, 1)
	failure := make(chan error, 1)
	go func() { wait, err := tab.ExpectDialog(DialogDecision{Type: "alert"}); done <- wait; failure <- err }()
	<-armed
	tab.ID = 99
	close(release)
	wait := <-done
	if err := <-failure; err != nil {
		t.Fatal(err)
	}
	time.Sleep(35 * time.Millisecond)
	if _, err := wait.Result(); err == nil {
		t.Fatal("expired result accepted")
	}
	if err := wait.Cancel(); err != nil {
		t.Fatal(err)
	}
}

func TestDialogMalformedResponseUnicodeRejectedBeforeReplacement(t *testing.T) {
	path, cleanup := dialogPeer(t, func(conn net.Conn, r map[string]any) bool {
		if r["method"] != "collectDialog" {
			return false
		}
		raw := []byte(`{"jsonrpc":"2.0","id":3,"result":{"type":"confirm","message":"\ud800","defaultValue":"","accepted":false}}`)
		if err := wire.WriteJSON(conn, json.RawMessage(raw)); err != nil {
			t.Error(err)
		}
		return true
	})
	defer cleanup()
	c := NewClient(Options{SocketPath: path})
	defer c.Close()
	if _, err := c.CollectDialog(Params{"tabId": 9, "dialogId": "d"}); err == nil || !strings.Contains(err.Error(), "UTF-8") {
		t.Fatal(err)
	}
}
func dialogPeer(t *testing.T, handler func(net.Conn, map[string]any) bool) (string, func()) {
	return startSDKServer(t, func(conn net.Conn) {
		for {
			var r map[string]any
			if wire.ReadJSON(conn, &r) != nil {
				return
			}
			if handler != nil && handler(conn, r) {
				continue
			}
			var result any
			switch r["method"] {
			case "getInfo":
				result = dialogInfo()
			case "getControlState":
				result = testControlState(7, "next")
			default:
				t.Errorf("unexpected request %v", r["method"])
				result = Params{}
			}
			writeResponse(t, conn, r["id"], result)
		}
	})
}

func TestDialogTypedOriginalScopeDecisionAndConsumedResult(t *testing.T) {
	var calls atomic.Int32
	message, text := "literal --accept=false, 界\n", " reply \n"
	path, cleanup := dialogPeer(t, func(conn net.Conn, r map[string]any) bool {
		p := r["params"].(map[string]any)
		switch r["method"] {
		case "armDialog":
			calls.Add(1)
			if p["message"] != message || p["promptText"] != text || p["accept"] != true || p["tabId"] != float64(9) {
				t.Error(p)
			}
			writeResponse(t, conn, r["id"], Params{"dialogId": "original", "remainingMs": 1000})
			return true
		case "collectDialog", "cancelDialog":
			calls.Add(1)
			if len(p) != 5 || p["session_id"] != "owner" || p["turn_id"] != "first" || p["control_epoch"] != float64(7) || p["tabId"] != float64(9) || p["dialogId"] != "original" {
				t.Error("scope or fields changed", p)
			}
			var result any = Params{}
			if r["method"] == "collectDialog" {
				result = Params{"type": "prompt", "message": message, "defaultValue": "seed", "accepted": true, "promptText": text}
			}
			writeResponse(t, conn, r["id"], result)
			return true
		}
		return false
	})
	defer cleanup()
	c := NewClient(Options{SocketPath: path, SessionID: "owner", TurnID: "first"})
	defer c.Close()
	tab := NewBrowser(c).Tab(9)
	wait, err := tab.Playwright.ExpectDialog(DialogDecision{Type: "prompt", Accept: true, Message: &message, PromptText: &text})
	if err != nil {
		t.Fatal(err)
	}
	tab.ID = 99
	result, err := wait.Result()
	if err != nil {
		t.Fatal(err)
	}
	if result.PromptText == nil || *result.PromptText != text || result.DefaultValue != "seed" {
		t.Fatal(result)
	}
	if _, err = wait.Result(); err == nil {
		t.Fatal("consumed result accepted")
	}
	if err = wait.Cancel(); err != nil {
		t.Fatal(err)
	}
	if calls.Load() != 3 {
		t.Fatal(calls.Load())
	}
}

func TestDialogInvalidInputsFailBeforeConnecting(t *testing.T) {
	base := Params{"tabId": 9, "type": "confirm", "accept": false}
	for _, change := range []Params{{"accept": nil}, {"accept": "false"}, {"type": "unknown"}, {"message": nil}, {"message": strings.Repeat("界", 2731)}, {"message": string([]byte{0xff})}, {"promptText": ""}, {"timeoutMs": nil}, {"timeoutMs": 1.5}, {"timeoutMs": 120001}, {"extra": true}, {"tabId": -1}} {
		p := Params{}
		for k, v := range base {
			p[k] = v
		}
		for k, v := range change {
			p[k] = v
		}
		c := NewClient(Options{SocketPath: "must-not-connect"})
		if _, err := c.ArmDialog(p); err == nil || (!strings.Contains(err.Error(), "invalid dialog")) {
			t.Errorf("input %v: %v", change, err)
		}
	}
	for _, method := range []string{"collectDialog", "cancelDialog"} {
		c := NewClient(Options{SocketPath: "must-not-connect"})
		if _, err := c.Request(method, Params{"tabId": 9, "dialogId": "d", "accept": false}); err == nil || !strings.Contains(err.Error(), "invalid dialog") {
			t.Fatal(err)
		}
	}
	for _, duration := range []time.Duration{-1, time.Nanosecond, 121 * time.Second} {
		c := NewClient(Options{})
		if _, err := NewBrowser(c).Tab(9).ExpectDialog(DialogDecision{Type: "alert"}, DialogWaitOptions{Timeout: duration}); err == nil {
			t.Fatal(duration)
		}
	}
}

func TestDialogStrictRepliesAndDecisionEcho(t *testing.T) {
	for _, result := range []any{nil, Params{}, Params{"type": "prompt", "message": "m", "defaultValue": "", "accepted": true}, Params{"type": "confirm", "message": "m", "defaultValue": "", "accepted": false, "promptText": ""}, Params{"type": "confirm", "message": "m", "defaultValue": "", "accepted": "false"}} {
		path, cleanup := dialogPeer(t, func(conn net.Conn, r map[string]any) bool {
			if r["method"] != "collectDialog" {
				return false
			}
			writeResponse(t, conn, r["id"], result)
			return true
		})
		c := NewClient(Options{SocketPath: path})
		if _, err := c.CollectDialog(Params{"tabId": 9, "dialogId": "d"}); err == nil {
			t.Error("bad result accepted", result)
		}
		c.Close()
		cleanup()
	}
	for _, result := range []any{Params{"dialogId": "d", "remainingMs": 100001}, Params{"dialogId": "d", "remainingMs": 0}, Params{"dialogId": "d", "remainingMs": 1, "extra": true}} {
		path, cleanup := dialogPeer(t, func(conn net.Conn, r map[string]any) bool {
			if r["method"] != "armDialog" {
				return false
			}
			writeResponse(t, conn, r["id"], result)
			return true
		})
		c := NewClient(Options{SocketPath: path})
		if _, err := c.ArmDialog(Params{"tabId": 9, "type": "alert", "accept": true}); err == nil {
			t.Error("bad ready accepted", result)
		}
		c.Close()
		cleanup()
	}
	path, cleanup := dialogPeer(t, func(conn net.Conn, r map[string]any) bool {
		switch r["method"] {
		case "armDialog":
			writeResponse(t, conn, r["id"], Params{"dialogId": "d", "remainingMs": 1000})
			return true
		case "collectDialog":
			writeResponse(t, conn, r["id"], Params{"type": "confirm", "message": "other", "defaultValue": "", "accepted": false})
			return true
		}
		return false
	})
	defer cleanup()
	c := NewClient(Options{SocketPath: path})
	defer c.Close()
	wait, err := NewBrowser(c).Tab(9).ExpectDialog(DialogDecision{Type: "confirm", Accept: true})
	if err != nil {
		t.Fatal(err)
	}
	if _, err = wait.Result(); err == nil || !strings.Contains(err.Error(), "original decision") {
		t.Fatal(err)
	}
}

func TestDialogDeadlineAndNoReconnectAfterLostReply(t *testing.T) {
	for _, stage := range []string{"getInfo", "armDialog", "collectDialog"} {
		t.Run(stage, func(t *testing.T) {
			var calls atomic.Int32
			path, cleanup := dialogPeer(t, func(conn net.Conn, r map[string]any) bool {
				method := r["method"].(string)
				if method == stage {
					time.Sleep(80 * time.Millisecond)
				}
				var result any
				switch method {
				case "getInfo":
					result = dialogInfo()
				case "armDialog":
					calls.Add(1)
					result = Params{"dialogId": "d", "remainingMs": 20}
				case "collectDialog":
					calls.Add(1)
					result = Params{"type": "alert", "message": "m", "defaultValue": "", "accepted": true}
				default:
					return false
				}
				_ = wire.WriteJSON(conn, map[string]any{"jsonrpc": "2.0", "id": r["id"], "result": result})
				return true
			})
			defer cleanup()
			c := NewClient(Options{SocketPath: path})
			defer c.Close()
			started := time.Now()
			wait, err := NewBrowser(c).Tab(9).ExpectDialog(DialogDecision{Type: "alert", Accept: true}, DialogWaitOptions{Timeout: 50 * time.Millisecond})
			if stage == "collectDialog" && err == nil {
				_, err = wait.Result()
			}
			if err == nil {
				t.Fatal("expired dialog accepted")
			}
			if time.Since(started) > 300*time.Millisecond {
				t.Fatal("deadline renewed")
			}
			if _, err = c.GetInfo(); err == nil {
				t.Fatal("lost original connection was reused")
			}
			if calls.Load() > 2 {
				t.Fatal("replayed", calls.Load())
			}
		})
	}
}

func TestDialogMetadataResetAndEmptyPromptResult(t *testing.T) {
	c := NewClient(Options{})
	if err := c.observeControlSupport(map[string]any{"metadata": map[string]any{"dialogVersion": float64(1)}}); err != nil {
		t.Fatal(err)
	}
	if c.dialogVersion != float64(1) {
		t.Fatal("missing version")
	}
	if err := c.observeControlSupport(map[string]any{"metadata": map[string]any{}}); err != nil {
		t.Fatal(err)
	}
	if c.dialogVersion != nil {
		t.Fatal("stale version retained")
	}
	good := map[string]any{"type": "prompt", "message": "", "defaultValue": "", "accepted": true, "promptText": ""}
	if err := ValidateDialogResult("collectDialog", good, 0); err != nil {
		t.Fatal(err)
	}
}

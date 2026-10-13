package main

import (
	"encoding/json"
	"fmt"
	"io"
	"reflect"
	"strings"
	"testing"
	"time"
)

func TestDialogStandaloneCommandsKeepExplicitOriginalScope(t *testing.T) {
	peer, options := startDialogPeer(t, 1, nil)
	for _, epoch := range []bool{false, true} {
		for _, step := range []struct {
			name string
			args []string
		}{{"arm-dialog", []string{"--type=prompt", "--accept=true", "--prompt-text=--accept=false,\n界"}}, {"collect-dialog", []string{"--dialog-id=original"}}, {"cancel-dialog", []string{"--dialog-id=original"}}} {
			cmd := newRootCommand()
			cmd.SetOut(io.Discard)
			cmd.SetErr(io.Discard)
			args := append([]string{step.name, "--socket", options.socketPath, "--session-id=owner", "--turn-id=original-turn", "--tab-id=9"}, step.args...)
			if epoch {
				args = append(args, "--control-epoch=37")
			}
			cmd.SetArgs(args)
			if err := cmd.Execute(); err != nil {
				t.Fatal(step.name, err)
			}
		}
	}
	calls := dialogCalls(peer)
	if len(calls) != 6 {
		t.Fatal(calls)
	}
	for i, r := range calls {
		p := r["params"].(map[string]any)
		if p["session_id"] != "owner" || p["turn_id"] != "original-turn" || p["control_epoch"] == nil {
			t.Fatal(p)
		}
		if i >= 3 && p["control_epoch"] != float64(37) {
			t.Fatal("epoch rebound", p)
		}
	}
	cmd := newRootCommand()
	cmd.SetOut(io.Discard)
	cmd.SetErr(io.Discard)
	cmd.SetArgs([]string{"arm-dialog", "--tab-id=9", "--type=confirm", "--accept=false"})
	if err := cmd.Execute(); err == nil || !strings.Contains(err.Error(), "--turn-id") {
		t.Fatal("implicit turn accepted", err)
	}
}

func startDialogPeer(t *testing.T, version any, override func(*mcpTestPeer, map[string]any) bool) (*mcpTestEndpoint, socketOptions) {
	peer := startMCPEndpoint(t, mcpEndpointDirectory(t), "", "dialog", func(peer *mcpTestPeer, r map[string]any) bool {
		if override != nil && override(peer, r) {
			return true
		}
		p, _ := r["params"].(map[string]any)
		var result any
		switch r["method"] {
		case "getInfo":
			metadata := map[string]any{"turnLifecycleVersion": 1}
			if version != nil {
				metadata["dialogVersion"] = version
			}
			result = map[string]any{"metadata": metadata}
		case "armDialog":
			result = map[string]any{"dialogId": "original", "remainingMs": p["timeoutMs"]}
		case "collectDialog":
			result = map[string]any{"type": "prompt", "message": "literal", "defaultValue": "seed", "accepted": true, "promptText": "--accept=false,\n界"}
		case "cancelDialog":
			result = map[string]any{}
		default:
			return false
		}
		_ = peer.write(map[string]any{"jsonrpc": "2.0", "id": r["id"], "result": result})
		return true
	})
	return peer, socketOptions{socketPath: peer.path, timeout: 3 * time.Second, sessionID: "owner", control: newCLIControl("owner", "first")}
}
func dialogCalls(peer *mcpTestEndpoint) []map[string]any {
	records, _ := peer.snapshot()
	var calls []map[string]any
	for _, r := range records {
		if cliDialogMethod(fmt.Sprint(r.message["method"])) {
			calls = append(calls, r.message)
		}
	}
	return calls
}

func TestDialogCLICapabilityAndStrictRawValidation(t *testing.T) {
	for _, version := range []any{nil, 0, 2, "1", true} {
		for _, manual := range []bool{false, true} {
			for _, method := range []string{"armDialog", "collectDialog", "cancelDialog"} {
				peer, options := startDialogPeer(t, version, nil)
				p := map[string]any{"tabId": 9}
				if method == "armDialog" {
					p["type"], p["accept"] = "confirm", false
				} else {
					p["dialogId"] = "original"
				}
				if manual {
					p["session_id"], p["turn_id"], p["control_epoch"] = "fixed", "fixed-turn", 7
				}
				if _, err := invokeWithOptions(options, method, p); err == nil || !strings.Contains(err.Error(), "OBU_DIALOG_UNSUPPORTED") {
					t.Fatalf("%v/%v/%s: %v", version, manual, method, err)
				}
				if len(dialogCalls(peer)) != 0 {
					t.Fatal("unsupported request sent")
				}
			}
		}
	}
	for _, p := range []map[string]any{{"tabId": 9, "type": "confirm"}, {"tabId": 9, "type": "confirm", "accept": "false"}, {"tabId": 9, "type": "confirm", "accept": false, "message": nil}, {"tabId": 9, "type": "confirm", "accept": false, "message": string([]byte{0xff})}, {"tabId": 9, "type": "confirm", "accept": false, "promptText": ""}} {
		if _, err := invokeWithOptions(socketOptions{timeout: time.Second}, "armDialog", p); err == nil || !strings.Contains(err.Error(), "invalid dialog") {
			t.Fatal(p, err)
		}
	}
}

func TestDialogCLICommandsRequireExplicitDecisionAndPreserveLiteralText(t *testing.T) {
	text := "--accept=false, false null {\"a\":1}\n界"
	method, p, err := buildDialogCommand("arm-dialog", []string{"--tab-id", "9", "--type", "prompt", "--accept=true", "--message=", "--prompt-text=" + text, "--timeout-ms", "1500"})
	if err != nil {
		t.Fatal(err)
	}
	if method != "armDialog" || p["message"] != "" || p["promptText"] != text || p["accept"] != true {
		t.Fatal(method, p)
	}
	for _, args := range [][]string{{"--tab-id=9", "--type=confirm"}, {"--tab-id=9", "--type=confirm", "--accept"}, {"--tab-id=9", "--type=confirm", "--accept=null"}, {"--tab-id=9", "--type=confirm", "--accept=false", "--prompt-text="}, {"--tab-id=9", "--type=confirm", "--accept=false", "extra"}, {"--tab-id=9", "--type=alert", "--accept=true", "--timeout-ms=0"}} {
		if _, _, err := buildDialogCommand("arm-dialog", args); err == nil {
			t.Fatal("invalid command accepted", args)
		}
	}
	for _, name := range []string{"collect-dialog", "cancel-dialog"} {
		_, p, err := buildDialogCommand(name, []string{"--tab-id=9", "--dialog-id=--accept=false"})
		if err != nil {
			t.Fatal(err)
		}
		if !reflect.DeepEqual(p, map[string]any{"tabId": float64(9), "dialogId": "--accept=false"}) {
			t.Fatal(p)
		}
		if _, _, err := buildDialogCommand(name, []string{"--tab-id=9", "--dialog-id=d", "--timeout-ms=1000"}); err == nil {
			t.Fatal("arm field leaked")
		}
	}
	for _, name := range []string{"arm-dialog", "collect-dialog", "cancel-dialog"} {
		cmd, _, err := newRootCommand().Find([]string{name})
		if err != nil || cmd.Name() != name {
			t.Fatal("not registered", name, err)
		}
	}
}

func TestDialogMCPNamedToolsRoundTripWithoutArgvParsing(t *testing.T) {
	peer, options := startDialogPeer(t, 1, nil)
	server := newMCPServer(options)
	defer server.shutdownBrowser()
	literal := "--accept=false,\n界"
	for _, step := range []struct {
		name string
		args map[string]any
	}{{"arm_dialog", map[string]any{"tab_id": float64(9), "type": "prompt", "accept": true, "message": "literal", "prompt_text": literal, "timeout_ms": float64(1500)}}, {"collect_dialog", map[string]any{"tab_id": float64(9), "dialog_id": "original"}}, {"cancel_dialog", map[string]any{"tab_id": float64(9), "dialog_id": "original"}}} {
		raw, _ := json.Marshal(map[string]any{"name": step.name, "arguments": step.args})
		result, err := server.callTool(raw)
		if err != nil || result["isError"] == true {
			t.Fatal(step.name, result, err)
		}
	}
	calls := dialogCalls(peer)
	if len(calls) != 3 {
		t.Fatal(calls)
	}
	first := calls[0]["params"].(map[string]any)
	if first["promptText"] != literal || first["accept"] != true || first["message"] != "literal" {
		t.Fatal(first)
	}
	for _, call := range calls[1:] {
		p := call["params"].(map[string]any)
		if len(p) != 5 || p["dialogId"] != "original" || p["control_epoch"] != first["control_epoch"] || p["turn_id"] != first["turn_id"] {
			t.Fatal(p)
		}
	}
	for _, raw := range []string{`{"name":"arm_dialog","arguments":{"tab_id":9,"type":"prompt","accept":true,"prompt_text":"\ud800"}}`, `{"name":"call","arguments":{"method":"armDialog","params":{"tabId":9,"type":"prompt","accept":true,"message":"\udfff"}}}`} {
		result, err := server.callTool(json.RawMessage(raw))
		if err == nil && result["isError"] != true {
			t.Fatal("malformed Unicode accepted", result)
		}
	}
	if len(dialogCalls(peer)) != 3 {
		t.Fatal("invalid tool sent a native decision")
	}
}

func TestDialogCLIStrictResultsAndOriginalArmBudget(t *testing.T) {
	for _, result := range []any{map[string]any{}, map[string]any{"dialogId": "d", "remainingMs": 0}, map[string]any{"dialogId": "d", "remainingMs": 100001}} {
		_, options := startDialogPeer(t, 1, func(peer *mcpTestPeer, r map[string]any) bool {
			if r["method"] != "armDialog" {
				return false
			}
			_ = peer.write(map[string]any{"jsonrpc": "2.0", "id": r["id"], "result": result})
			return true
		})
		if _, err := invokeWithOptions(options, "armDialog", map[string]any{"tabId": 9, "type": "alert", "accept": false}); err == nil {
			t.Fatal("invalid ready accepted", result)
		}
	}
	peer, options := startDialogPeer(t, 1, func(peer *mcpTestPeer, r map[string]any) bool {
		if r["method"] != "getInfo" {
			return false
		}
		time.Sleep(80 * time.Millisecond)
		_ = peer.write(map[string]any{"jsonrpc": "2.0", "id": r["id"], "result": map[string]any{"metadata": map[string]any{"turnLifecycleVersion": 1, "dialogVersion": 1}}})
		return true
	})
	started := time.Now()
	if _, err := invokeWithOptions(options, "armDialog", map[string]any{"tabId": 9, "type": "alert", "accept": false, "timeoutMs": 30}); err == nil {
		t.Fatal("expired bootstrap accepted")
	}
	if time.Since(started) > 300*time.Millisecond {
		t.Fatal("original budget renewed")
	}
	if len(dialogCalls(peer)) != 0 {
		t.Fatal("late arm sent")
	}
}

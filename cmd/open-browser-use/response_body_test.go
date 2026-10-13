package main

import (
	"encoding/json"
	"fmt"
	"io"
	"strings"
	"testing"
	"time"
)

const responseBodyCapture = "--capture-id=false,[]界"

func cliBodyParams() map[string]any {
	return map[string]any{"tabId": 9, "action": "responseBody", "args": map[string]any{"captureId": responseBodyCapture, "requestId": "request-7"}, "timeoutMs": 1000}
}
func cliBodyEnvelope() map[string]any {
	return map[string]any{"value": map[string]any{"captureId": responseBodyCapture, "requestId": "request-7", "encoding": "base64", "data": "AP8NCg==", "byteLength": 4}, "engine": map[string]any{"name": "playwright-crx", "version": "1", "playwrightVersion": "1", "capabilities": map[string]any{"responseBody": 1}}}
}
func startResponseBodyPeer(t *testing.T, version any, override func(*mcpTestPeer, map[string]any) bool) (*mcpTestEndpoint, socketOptions) {
	peer := startMCPEndpoint(t, mcpEndpointDirectory(t), "", "response-body", func(peer *mcpTestPeer, r map[string]any) bool {
		if override != nil && override(peer, r) {
			return true
		}
		var result any
		switch r["method"] {
		case "getInfo":
			result = map[string]any{"metadata": map[string]any{"turnLifecycleVersion": 1, "responseBodyVersion": version}}
		case "browserAction":
			result = cliBodyEnvelope()
		default:
			return false
		}
		_ = peer.write(map[string]any{"jsonrpc": "2.0", "id": r["id"], "result": result})
		return true
	})
	return peer, socketOptions{socketPath: peer.path, timeout: 3 * time.Second, sessionID: "owner", control: newCLIControl("owner", "original-turn")}
}
func responseBodyCalls(peer *mcpTestEndpoint) []map[string]any {
	rows, _ := peer.snapshot()
	calls := []map[string]any{}
	for _, row := range rows {
		p, _ := row.message["params"].(map[string]any)
		if cliResponseBody(fmt.Sprint(row.message["method"]), p) {
			calls = append(calls, row.message)
		}
	}
	return calls
}
func TestResponseBodyStandaloneAndPlanKeepLiteralsAndOriginalScope(t *testing.T) {
	peer, options := startResponseBodyPeer(t, 1, nil)
	for _, manual := range []bool{false, true} {
		cmd := newRootCommand()
		cmd.SetOut(io.Discard)
		cmd.SetErr(io.Discard)
		args := []string{"response-body", "--socket", options.socketPath, "--session-id=owner", "--turn-id=original-turn", "--tab-id=9", "--capture-id=" + responseBodyCapture, "--request-id=request-7", "--max-bytes=32", "--timeout-ms=1000"}
		if manual {
			args = append(args, "--control-epoch=37")
		}
		cmd.SetArgs(args)
		if err := cmd.Execute(); err != nil {
			t.Fatal(err)
		}
	}
	calls := responseBodyCalls(peer)
	if len(calls) != 2 {
		t.Fatal(calls)
	}
	for i, call := range calls {
		p := call["params"].(map[string]any)
		a := p["args"].(map[string]any)
		if p["session_id"] != "owner" || p["turn_id"] != "original-turn" || p["control_epoch"] == nil || a["captureId"] != responseBodyCapture || a["maxBytes"] != float64(32) || p["locator"] != nil {
			t.Fatal(p)
		}
		if i == 1 && p["control_epoch"] != float64(37) {
			t.Fatal(p)
		}
	}
	method, p, err := buildResponseBodyCommand([]string{"--tab-id=9", "--capture-id=" + responseBodyCapture, "--request-id=request-7"})
	if err != nil || method != "browserAction" || p["args"].(map[string]any)["captureId"] != responseBodyCapture {
		t.Fatal(p, err)
	}
	cmd := newRootCommand()
	cmd.SetOut(io.Discard)
	cmd.SetErr(io.Discard)
	cmd.SetArgs([]string{"response-body", "--tab-id=9", "--capture-id=c", "--request-id=r"})
	if err := cmd.Execute(); err == nil || !strings.Contains(err.Error(), "--turn-id") {
		t.Fatal(err)
	}
	for _, args := range [][]string{{"--tab-id=9", "--capture-id=c", "--request-id=r", "--max-bytes=0"}, {"--tab-id=9", "--capture-id=c", "--request-id=r", "--url=x"}, {"--tab-id=9", "--capture-id=c"}} {
		if _, _, err := buildResponseBodyCommand(args); err == nil {
			t.Fatal(args)
		}
	}
}
func TestResponseBodyNamedMCPRoundTripAndRawUnicodeGuard(t *testing.T) {
	found := false
	for _, tool := range mcpTools() {
		if tool.Name == "response_body" {
			found = true
		}
	}
	if !found {
		t.Fatal("missing response_body")
	}
	peer, options := startResponseBodyPeer(t, 1, nil)
	server := newMCPServer(options)
	defer server.shutdownBrowser()
	originalScope := server.runner.options.control.snapshot()
	raw, _ := json.Marshal(map[string]any{"name": "response_body", "arguments": map[string]any{"tab_id": 9, "capture_id": responseBodyCapture, "request_id": "request-7", "max_bytes": 32, "timeout_ms": 1000}})
	result, err := server.callTool(raw)
	if err != nil || result["isError"] == true {
		t.Fatal(result, err)
	}
	calls := responseBodyCalls(peer)
	if len(calls) != 1 {
		t.Fatal(calls)
	}
	p := calls[0]["params"].(map[string]any)
	if p["args"].(map[string]any)["captureId"] != responseBodyCapture || p["turn_id"] != originalScope.turn || p["session_id"] != originalScope.session {
		t.Fatal(p)
	}
	for _, raw := range []string{`{"name":"response_body","arguments":{"tab_id":9,"capture_id":"c","request_id":"r","max_bytes":null}}`, `{"name":"response_body","arguments":{"tab_id":9,"capture_id":"\ud800","request_id":"r"}}`, `{"name":"call","arguments":{"method":"browserAction","params":{"tabId":9,"action":"responseBody","args":{"captureId":"c","requestId":"\ud800"}}}}`, `{"name":"response_body","arguments":{"tab_id":9,"capture_id":"c","request_id":"r","url":"x"}}`} {
		result, err := server.callTool(json.RawMessage(raw))
		if err == nil && result["isError"] != true {
			t.Fatal("invalid tool accepted", result)
		}
	}
	if len(responseBodyCalls(peer)) != 1 {
		t.Fatal("invalid input sent body request")
	}
}
func TestResponseBodyCLIAndMCPRejectUnsupportedAndMalformedReplies(t *testing.T) {
	for _, version := range []any{nil, true, 2} {
		for _, manual := range []bool{false, true} {
			peer, options := startResponseBodyPeer(t, version, nil)
			p := cliBodyParams()
			if manual {
				p["control_epoch"] = 7
			}
			if _, err := invokeWithOptions(options, "browserAction", p); err == nil || !strings.Contains(err.Error(), "UNSUPPORTED") {
				t.Fatal(version, manual, err)
			}
			if len(responseBodyCalls(peer)) != 0 {
				t.Fatal("unsupported body sent")
			}
		}
	}
	for _, mcp := range []bool{false, true} {
		peer, options := startResponseBodyPeer(t, 1, func(peer *mcpTestPeer, r map[string]any) bool {
			if r["method"] != "browserAction" {
				return false
			}
			bad := cliBodyEnvelope()
			bad["value"].(map[string]any)["data"] = "AP8NCx=="
			_ = peer.write(map[string]any{"jsonrpc": "2.0", "id": r["id"], "result": bad})
			return true
		})
		if mcp {
			server := newMCPServer(options)
			_, err := server.runResponseBodyTool(map[string]any{"tab_id": 9, "capture_id": responseBodyCapture, "request_id": "request-7"})
			server.shutdownBrowser()
			if err == nil || !strings.Contains(err.Error(), "FAILED") {
				t.Fatal(err)
			}
		} else {
			if _, err := invokeWithOptions(options, "browserAction", cliBodyParams()); err == nil || !strings.Contains(err.Error(), "FAILED") {
				t.Fatal(err)
			}
		}
		if len(responseBodyCalls(peer)) != 1 {
			t.Fatal("malformed reply replayed")
		}
	}
}
func TestResponseBodyCLIDiscoveryDoesNotRenewDeadline(t *testing.T) {
	peer, options := startResponseBodyPeer(t, 1, func(peer *mcpTestPeer, r map[string]any) bool {
		if r["method"] != "getInfo" {
			return false
		}
		time.Sleep(80 * time.Millisecond)
		_ = peer.write(map[string]any{"jsonrpc": "2.0", "id": r["id"], "result": map[string]any{"metadata": map[string]any{"responseBodyVersion": 1}}})
		return true
	})
	p := cliBodyParams()
	p["timeoutMs"], p["control_epoch"] = 10, 7
	if _, err := invokeWithOptions(options, "browserAction", p); err == nil {
		t.Fatal("late request accepted")
	}
	if len(responseBodyCalls(peer)) != 0 {
		t.Fatal("expired request sent")
	}
}

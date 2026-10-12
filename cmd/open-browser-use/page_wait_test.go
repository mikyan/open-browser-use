package main

import (
	"encoding/json"
	"fmt"
	"reflect"
	"strings"
	"sync/atomic"
	"testing"
	"time"
)

// Use real platform IPC and the same framed call path as the CLI/MCP tools.
// The peer deliberately accepts the same source ID for all requests, so only
// the client boundary can reject malformed replies or expired registrations.
func startCLIPageWaitPeer(t *testing.T, version any, override func(*mcpTestPeer, map[string]any) bool) (*mcpTestEndpoint, socketOptions) {
	t.Helper()
	peer := startMCPEndpoint(t, mcpEndpointDirectory(t), "", "page-wait", func(peer *mcpTestPeer, request map[string]any) bool {
		if override != nil && override(peer, request) {
			return true
		}
		params, _ := request["params"].(map[string]any)
		var result any
		switch request["method"] {
		case "getInfo":
			metadata := map[string]any{"turnLifecycleVersion": 1}
			if version != nil {
				metadata["pageWaitVersion"] = version
			}
			result = map[string]any{"metadata": metadata}
		case "armPageWait":
			result = map[string]any{"waiterId": "original-page-wait", "remainingMs": params["timeoutMs"]}
		case "collectPageWait":
			result = map[string]any{"tabId": 42}
		case "cancelPageWait":
			result = map[string]any{}
		default:
			return false
		}
		_ = peer.write(map[string]any{"jsonrpc": "2.0", "id": request["id"], "result": result})
		return true
	})
	return peer, socketOptions{socketPath: peer.path, timeout: 3 * time.Second, sessionID: "original-owner", control: newCLIControl("original-owner", "original-turn")}
}

func pageWaitCalls(peer *mcpTestEndpoint) []map[string]any {
	requests, _ := peer.snapshot()
	var calls []map[string]any
	for _, request := range requests {
		if cliPageWaitMethod(request.message["method"].(string)) {
			calls = append(calls, request.message)
		}
	}
	return calls
}

func TestCLIPageWaitCapabilityMustBeExplicit(t *testing.T) {
	for _, version := range []any{nil, 0, 2, "1", true} {
		for _, manual := range []bool{false, true} {
			for _, method := range []string{"armPageWait", "collectPageWait", "cancelPageWait"} {
				t.Run(fmt.Sprintf("%v/manual=%v/%s", version, manual, method), func(t *testing.T) {
					peer, options := startCLIPageWaitPeer(t, version, nil)
					params := map[string]any{"tabId": 1}
					if method != "armPageWait" {
						params["waiterId"] = "original-page-wait"
					}
					if manual {
						params["control_epoch"], params["session_id"], params["turn_id"] = 7, "original-owner", "original-turn"
					}
					if _, err := invokeWithOptions(options, method, params); err == nil || !strings.Contains(err.Error(), "OBU_PAGE_WAIT_UNSUPPORTED") {
						t.Fatalf("missing capability was not rejected: %v", err)
					}
					if len(pageWaitCalls(peer)) != 0 {
						t.Fatal("unsupported page operation was sent")
					}
				})
			}
		}
	}
}

func TestCLIPageWaitRawScopeAndStrictReplies(t *testing.T) {
	peer, options := startCLIPageWaitPeer(t, 1, nil)
	params := map[string]any{"tabId": 1, "session_id": "fixed-owner", "turn_id": "fixed-turn", "control_epoch": 7}
	ready, err := invokeWithOptions(options, "armPageWait", params)
	if err != nil {
		t.Fatal(err)
	}
	ack := ready["result"].(map[string]any)
	if len(ack) != 2 || ack["waiterId"] != "original-page-wait" || ack["remainingMs"].(float64) <= 0 {
		t.Fatal(ready)
	}
	params["waiterId"] = ack["waiterId"]
	for _, method := range []string{"collectPageWait", "cancelPageWait"} {
		response, err := invokeWithOptions(options, method, params)
		if err != nil {
			t.Fatal(err)
		}
		want := map[string]any{}
		if method == "collectPageWait" {
			want["tabId"] = float64(42)
		}
		if !reflect.DeepEqual(response["result"], want) {
			t.Fatal(response)
		}
	}
	calls := pageWaitCalls(peer)
	if len(calls) != 3 {
		t.Fatal(calls)
	}
	for _, call := range calls {
		wire := call["params"].(map[string]any)
		if wire["tabId"] != float64(1) || wire["session_id"] != "fixed-owner" || wire["turn_id"] != "fixed-turn" || wire["control_epoch"] != float64(7) {
			t.Fatal("scope was rebound", wire)
		}
		if call["method"] != "armPageWait" && wire["timeoutMs"] != nil {
			t.Fatal("collect/cancel renewed the original wait", wire)
		}
	}
}

func TestCLIPageWaitMalformedParamsOpenNoConnection(t *testing.T) {
	peer, options := startCLIPageWaitPeer(t, 1, nil)
	cases := []struct {
		method string
		params map[string]any
	}{
		{"armPageWait", map[string]any{}},
		{"armPageWait", map[string]any{"tabId": -1}},
		{"armPageWait", map[string]any{"tabId": "1"}},
		{"armPageWait", map[string]any{"tabId": 1.5}},
		{"armPageWait", map[string]any{"tabId": 9007199254740992.0}},
		{"armPageWait", map[string]any{"tabId": 1, "timeoutMs": nil}},
		{"armPageWait", map[string]any{"tabId": 1, "timeoutMs": 0}},
		{"armPageWait", map[string]any{"tabId": 1, "timeoutMs": 120001}},
		{"armPageWait", map[string]any{"tabId": 1, "timeoutMs": 1.5}},
		{"armPageWait", map[string]any{"tabId": 1, "url": "https://same.example/"}},
		{"armPageWait", map[string]any{"tabId": 1, "session_id": ""}},
		{"armPageWait", map[string]any{"tabId": 1, "turn_id": strings.Repeat("界", 1366)}},
		{"armPageWait", map[string]any{"tabId": 1, "control_epoch": 0}},
		{"armPageWait", map[string]any{"tabId": 1, "control_epoch": "7"}},
		{"collectPageWait", map[string]any{"tabId": 1, "waiterId": "w", "timeoutMs": 1000}},
		{"collectPageWait", map[string]any{"tabId": 1, "waiterId": strings.Repeat("w", 129)}},
		{"cancelPageWait", map[string]any{"tabId": 1, "waiterId": ""}},
	}
	for _, tc := range cases {
		if _, err := invokeWithOptions(options, tc.method, tc.params); err == nil {
			t.Fatalf("accepted %s %#v", tc.method, tc.params)
		}
	}
	requests, peers := peer.snapshot()
	if len(requests) != 0 || len(peers) != 0 {
		t.Fatal("invalid input touched native transport", requests, len(peers))
	}
}

func TestCLIPageWaitRejectsMalformedNativeAcknowledgementsWithoutReplay(t *testing.T) {
	cases := []struct {
		method string
		result any
	}{
		{"armPageWait", nil}, {"armPageWait", "ready"},
		{"armPageWait", map[string]any{"waiterId": "", "remainingMs": 1}},
		{"armPageWait", map[string]any{"waiterId": "w", "remainingMs": 0}},
		{"armPageWait", map[string]any{"waiterId": "w", "remainingMs": "1"}},
		{"armPageWait", map[string]any{"waiterId": "w", "remainingMs": 100001}},
		{"armPageWait", map[string]any{"waiterId": "w", "remainingMs": 1, "tabId": 42}},
		{"collectPageWait", map[string]any{}},
		{"collectPageWait", map[string]any{"tabId": -1}},
		{"collectPageWait", map[string]any{"tabId": "42"}},
		{"collectPageWait", map[string]any{"tabId": 42.5}},
		{"collectPageWait", map[string]any{"tabId": 1}},
		{"collectPageWait", map[string]any{"tabId": 42, "url": "guessed"}},
		{"cancelPageWait", nil}, {"cancelPageWait", []any{}},
		{"cancelPageWait", map[string]any{"cancelled": true}},
	}
	for index, tc := range cases {
		t.Run(fmt.Sprintf("%s/%d", tc.method, index), func(t *testing.T) {
			peer, options := startCLIPageWaitPeer(t, 1, func(peer *mcpTestPeer, request map[string]any) bool {
				if request["method"] != tc.method {
					return false
				}
				_ = peer.write(map[string]any{"jsonrpc": "2.0", "id": request["id"], "result": tc.result})
				return true
			})
			params := map[string]any{"tabId": 1}
			if tc.method != "armPageWait" {
				params["waiterId"] = "w"
			}
			if _, err := invokeWithOptions(options, tc.method, params); err == nil || !strings.Contains(err.Error(), "invalid page wait") {
				t.Fatalf("bad acknowledgement accepted: %v", err)
			}
			if len(pageWaitCalls(peer)) != 1 {
				t.Fatal("invalid acknowledgement replayed the operation", pageWaitCalls(peer))
			}
		})
	}
}

func TestCLIPageWaitRequiresPositiveNegotiatedEpoch(t *testing.T) {
	peer, options := startCLIPageWaitPeer(t, 1, func(peer *mcpTestPeer, request map[string]any) bool {
		if request["method"] != "getControlState" {
			return false
		}
		_ = peer.write(map[string]any{"jsonrpc": "2.0", "id": request["id"], "result": map[string]any{"controlEpoch": 0, "nextTurnId": "next", "closing": false, "lifecycleVersion": 1}})
		return true
	})
	if _, err := invokeWithOptions(options, "armPageWait", map[string]any{"tabId": 1}); err == nil || !strings.Contains(err.Error(), "positive control_epoch") {
		t.Fatal(err)
	}
	if len(pageWaitCalls(peer)) != 0 {
		t.Fatal("zero epoch registration was sent")
	}
}

func TestCLIPageWaitOriginalBudgetIncludesNegotiationAndQueue(t *testing.T) {
	t.Run("capability latency reduces actual registration budget", func(t *testing.T) {
		peer, options := startCLIPageWaitPeer(t, 1, func(_ *mcpTestPeer, request map[string]any) bool {
			if request["method"] == "getInfo" {
				time.Sleep(60 * time.Millisecond)
			}
			return false
		})
		response, err := invokeWithOptions(options, "armPageWait", map[string]any{"tabId": 1, "timeoutMs": 1000})
		if err != nil {
			t.Fatal(err)
		}
		calls := pageWaitCalls(peer)
		sent := calls[0]["params"].(map[string]any)["timeoutMs"].(float64)
		remaining := response["result"].(map[string]any)["remainingMs"].(float64)
		if len(calls) != 1 || sent > 950 || sent <= 0 || remaining > sent || remaining <= 0 {
			t.Fatal("negotiation renewed original budget", sent, remaining)
		}
	})
	t.Run("expired queued submission opens no connection", func(t *testing.T) {
		peer, options := startCLIPageWaitPeer(t, 1, nil)
		submitted := options.control.snapshot()
		submitted.deadline = time.Now().Add(options.timeout - 2*time.Second)
		if _, err := options.control.invoke(options, "armPageWait", map[string]any{"tabId": 1, "timeoutMs": 100}, &submitted); err == nil {
			t.Fatal("expired queued arm succeeded")
		}
		requests, peers := peer.snapshot()
		if len(requests) != 0 || len(peers) != 0 {
			t.Fatal("expired registration opened transport")
		}
	})
	t.Run("late capability does not send a control or arm request", func(t *testing.T) {
		peer, options := startCLIPageWaitPeer(t, 1, func(_ *mcpTestPeer, request map[string]any) bool {
			if request["method"] == "getInfo" {
				time.Sleep(120 * time.Millisecond)
			}
			return false
		})
		if _, err := invokeWithOptions(options, "armPageWait", map[string]any{"tabId": 1, "timeoutMs": 30}); err == nil {
			t.Fatal("late capability succeeded")
		}
		peer.stop() // Wait for the real delayed response; do not infer cancellation.
		requests, _ := peer.snapshot()
		if len(requests) != 1 || requests[0].message["method"] != "getInfo" {
			t.Fatal("negotiation continued past the original deadline", requests)
		}
	})
}

func TestMCPPageWaitReadyThenOneTriggerAndCollect(t *testing.T) {
	var armed, triggered atomic.Bool
	peer, options := startCLIPageWaitPeer(t, 1, func(peer *mcpTestPeer, request map[string]any) bool {
		switch request["method"] {
		case "armPageWait":
			armed.Store(true)
		case "browserAction":
			if !armed.Load() || !triggered.CompareAndSwap(false, true) {
				_ = peer.write(map[string]any{"jsonrpc": "2.0", "id": request["id"], "error": map[string]any{"code": -1, "message": "trigger before ready or replayed"}})
				return true
			}
		case "collectPageWait":
			if !triggered.Load() {
				_ = peer.write(map[string]any{"jsonrpc": "2.0", "id": request["id"], "error": map[string]any{"code": -1, "message": "collect before original trigger"}})
				return true
			}
		}
		return false
	})
	client := startMCPStdio(t, options)
	ready := requireMCPToolSuccess(t, client.tool("call", mcpRawCall("armPageWait", map[string]any{"tabId": 1, "timeoutMs": 1500})))
	waiter := ready["result"].(map[string]any)["waiterId"]
	requireMCPToolSuccess(t, client.tool("call", mcpRawCall("browserAction", map[string]any{"tabId": 1, "action": "click", "selector": "#open-child", "timeoutMs": 1000})))
	collected := requireMCPToolSuccess(t, client.tool("call", mcpRawCall("collectPageWait", map[string]any{"tabId": 1, "waiterId": waiter})))
	if !reflect.DeepEqual(collected["result"], map[string]any{"tabId": float64(42)}) {
		t.Fatal(collected)
	}
	requireMCPToolSuccess(t, client.tool("call", mcpRawCall("cancelPageWait", map[string]any{"tabId": 1, "waiterId": waiter})))
	client.close()
	requests, peers := peer.snapshot()
	var methods []string
	var waiterTurn string
	for _, request := range requests {
		methods = append(methods, request.message["method"].(string))
		if cliPageWaitMethod(request.message["method"].(string)) {
			params := request.message["params"].(map[string]any)
			if waiterTurn == "" {
				waiterTurn, _ = params["turn_id"].(string)
			}
			if waiterTurn == "" || params["session_id"] != "original-owner" || params["turn_id"] != waiterTurn || params["control_epoch"] != float64(7) {
				t.Fatal("MCP waiter scope changed", params)
			}
		}
	}
	if len(peers) != 1 || !reflect.DeepEqual(methods, []string{"getInfo", "getControlState", "armPageWait", "browserAction", "collectPageWait", "cancelPageWait"}) {
		t.Fatal("ready ordering/connection/replay changed", len(peers), methods)
	}
}

func TestCLIPageWaitBusinessFailurePreservesOriginalResponse(t *testing.T) {
	peer, options := startCLIPageWaitPeer(t, 1, func(peer *mcpTestPeer, request map[string]any) bool {
		if request["method"] != "collectPageWait" {
			return false
		}
		_ = peer.write(map[string]any{"jsonrpc": "2.0", "id": request["id"], "error": map[string]any{"code": -32000, "message": "OBU_PAGE_WAIT_EXPIRED: original source navigated"}})
		return true
	})
	response, err := invokeWithOptions(options, "collectPageWait", map[string]any{"tabId": 1, "waiterId": "original-page-wait"})
	if err != nil {
		t.Fatal(err)
	}
	if !reflect.DeepEqual(response["error"], map[string]any{"code": float64(-32000), "message": "OBU_PAGE_WAIT_EXPIRED: original source navigated"}) || len(pageWaitCalls(peer)) != 1 {
		t.Fatal("original business error was replaced or retried", response)
	}
}

func TestMCPPageWaitMalformedReadyIsReportedAsToolError(t *testing.T) {
	peer, options := startCLIPageWaitPeer(t, 1, func(peer *mcpTestPeer, request map[string]any) bool {
		if request["method"] != "armPageWait" {
			return false
		}
		_ = peer.write(map[string]any{"jsonrpc": "2.0", "id": request["id"], "result": map[string]any{"waiterId": "w", "remainingMs": 1, "unexpected": true}})
		return true
	})
	client := startMCPStdio(t, options)
	response := client.tool("call", mcpRawCall("armPageWait", map[string]any{"tabId": 1}))
	encoded, _ := json.Marshal(response)
	result, _ := response["result"].(map[string]any)
	if result["isError"] != true || !strings.Contains(string(encoded), "invalid page wait ready acknowledgement") {
		t.Fatal("malformed readiness escaped the public tool", string(encoded))
	}
	client.close()
	if len(pageWaitCalls(peer)) != 1 {
		t.Fatal("malformed readiness was replayed")
	}
}

func TestMCPPageWaitLostReadyIsNotReplayed(t *testing.T) {
	peer, options := startCLIPageWaitPeer(t, 1, func(peer *mcpTestPeer, request map[string]any) bool {
		if request["method"] != "armPageWait" {
			return false
		}
		_ = peer.Close() // Native registration may have happened; its ACK is unknown.
		return true
	})
	client := startMCPStdio(t, options)
	requireMCPDisconnected(t, client.tool("call", mcpRawCall("armPageWait", map[string]any{"tabId": 1, "timeoutMs": 1000})))
	requireMCPDisconnected(t, client.tool("call", mcpRawCall("collectPageWait", map[string]any{"tabId": 1, "waiterId": "original-page-wait"})))
	client.close()
	_, peers := peer.snapshot()
	if len(pageWaitCalls(peer)) != 1 || len(peers) != 1 {
		t.Fatal("unknown readiness acknowledgement was replayed or reconnected")
	}
}

func TestMCPPageWaitLateReadyFailsWithoutTriggerOrReplay(t *testing.T) {
	peer, options := startCLIPageWaitPeer(t, 1, func(peer *mcpTestPeer, request map[string]any) bool {
		if request["method"] != "armPageWait" {
			return false
		}
		time.Sleep(100 * time.Millisecond)
		_ = peer.write(map[string]any{"jsonrpc": "2.0", "id": request["id"], "result": map[string]any{"waiterId": "late-wait", "remainingMs": 1}})
		return true
	})
	client := startMCPStdio(t, options)
	response := client.tool("call", mcpRawCall("armPageWait", map[string]any{"tabId": 1, "timeoutMs": 30}))
	encoded, _ := json.Marshal(response)
	if !strings.Contains(string(encoded), "timed out") {
		t.Fatal("late readiness was accepted", string(encoded))
	}
	// A subsequent explicit cancellation uses the same real connection; the old
	// ready response must not become its ACK or cause a second registration.
	requireMCPToolSuccess(t, client.tool("call", mcpRawCall("cancelPageWait", map[string]any{"tabId": 1, "waiterId": "late-wait"})))
	client.close()
	calls := pageWaitCalls(peer)
	if len(calls) != 2 || calls[0]["method"] != "armPageWait" || calls[1]["method"] != "cancelPageWait" {
		t.Fatal("late acknowledgement changed request sequence", calls)
	}
}

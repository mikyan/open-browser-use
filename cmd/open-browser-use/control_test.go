package main

import (
	"encoding/json"
	"fmt"
	"net"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/ifuryst/open-browser-use/internal/transport"
	"github.com/ifuryst/open-browser-use/internal/wire"
)

func readLegacyCLIRequest(conn net.Conn, request *map[string]any) error {
	if err := wire.ReadJSON(conn, request); err != nil {
		return err
	}
	if (*request)["id"] == "cli-control-info" {
		if err := wire.WriteJSON(conn, map[string]any{"jsonrpc": "2.0", "id": (*request)["id"], "result": map[string]any{}}); err != nil {
			return err
		}
		return wire.ReadJSON(conn, request)
	}
	return nil
}

type controlFixture struct {
	mu                     sync.Mutex
	calls                  []map[string]any
	epoch                  int64
	loseEnd                bool
	delayInfo              time.Duration
	withoutNetworkWait     bool
	withoutNavigationWait  bool
	withoutDirectDownloads bool
	withoutMediaDownloads  bool
}

func (fixture *controlFixture) methods() []string {
	fixture.mu.Lock()
	defer fixture.mu.Unlock()
	out := []string{}
	for _, call := range fixture.calls {
		out = append(out, call["method"].(string))
	}
	return out
}
func (fixture *controlFixture) start(t *testing.T) socketOptions {
	t.Helper()
	socketDir, err := os.MkdirTemp(socketTestTempRoot(), "obu-ctl-")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = os.RemoveAll(socketDir) })
	// Windows pipe names do not include socketDir. Reuse its random basename
	// instead of a clock value that can repeat in fast sequential fixtures.
	endpoint := transport.NewEndpoint(socketDir, "control-"+filepath.Base(socketDir))
	listener, err := transport.Listen(endpoint)
	if err != nil {
		t.Fatal(err)
	}
	var workers sync.WaitGroup
	workers.Add(1)
	go func() {
		defer workers.Done()
		for {
			conn, err := listener.Accept()
			if err != nil {
				return
			}
			workers.Add(1)
			go func() {
				defer workers.Done()
				defer conn.Close()
				_ = conn.SetDeadline(time.Now().Add(5 * time.Second))
				for {
					var call map[string]any
					if wire.ReadJSON(conn, &call) != nil {
						return
					}
					fixture.mu.Lock()
					fixture.calls = append(fixture.calls, call)
					method := call["method"].(string)
					params := call["params"].(map[string]any)
					result := any(params)
					var failure any
					state := func() map[string]any {
						return map[string]any{"controlEpoch": fixture.epoch, "nextTurnId": fmt.Sprintf("next-%d", fixture.epoch), "closing": false, "lifecycleVersion": 1}
					}
					switch method {
					case "getInfo":
						result = map[string]any{"metadata": map[string]any{"turnLifecycleVersion": 1}}
						if !fixture.withoutNetworkWait {
							result.(map[string]any)["metadata"].(map[string]any)["networkWaitVersion"] = 1
						}
						if !fixture.withoutNavigationWait {
							result.(map[string]any)["metadata"].(map[string]any)["navigationWaitVersion"] = 1
						}
						if !fixture.withoutMediaDownloads {
							result.(map[string]any)["metadata"].(map[string]any)["mediaDownloadsVersion"] = 1
						}
						if !fixture.withoutDirectDownloads {
							result.(map[string]any)["metadata"].(map[string]any)["directDownloadsVersion"] = 1
						}
					case "getControlState":
						result = state()
					default:
						if params["control_epoch"] != float64(fixture.epoch) {
							failure = map[string]any{"code": -32000, "message": "OBU_STALE_CONTROL_EPOCH: old submission"}
						} else if method == "turnEnded" || method == "finalizeTabs" {
							fixture.epoch++
							result = state()
							result.(map[string]any)["endedTurnId"] = params["turn_id"]
						}
					}
					lose := fixture.loseEnd && method == "turnEnded"
					delay := fixture.delayInfo
					fixture.mu.Unlock()
					if method == "getInfo" {
						time.Sleep(delay)
					}
					if lose {
						continue
					}
					response := map[string]any{"jsonrpc": "2.0", "id": call["id"], "result": result}
					if failure != nil {
						delete(response, "result")
						response["error"] = failure
					}
					if wire.WriteJSON(conn, response) != nil {
						return
					}
				}
			}()
		}
	}()
	t.Cleanup(func() { _ = listener.Close(); workers.Wait() })
	return socketOptions{socketPath: endpoint, timeout: time.Second, sessionID: "fixture", control: newCLIControl("fixture", "first")}
}

func TestCLIControlLifecycleAndSubmittedEpoch(t *testing.T) {
	f := &controlFixture{epoch: 10}
	options := f.start(t)
	if _, err := invokeWithOptions(options, "createTab", nil); err != nil {
		t.Fatal(err)
	}
	old := options.control.snapshot()
	if _, err := invokeWithOptions(options, "turnEnded", nil); err != nil {
		t.Fatal(err)
	}
	if options.control.snapshot().epoch != 11 || options.control.snapshot().turn != "next-11" {
		t.Fatal(options.control.snapshot())
	}
	if _, err := options.control.invoke(options, "createTab", nil, &old); err == nil || !strings.Contains(err.Error(), "OBU_STALE_CONTROL_EPOCH") {
		t.Fatalf("old submission accepted: %v", err)
	}
	response, err := invokeWithOptions(options, "createTab", nil)
	if err != nil {
		t.Fatal(err)
	}
	if response["result"].(map[string]any)["control_epoch"] != float64(11) {
		t.Fatal(response)
	}
	if _, err := invokeWithOptions(options, "finalizeTabs", map[string]any{"keep": []any{}}); err != nil {
		t.Fatal(err)
	}
	if got := strings.Join(f.methods(), ","); got != "getInfo,getControlState,createTab,turnEnded,createTab,finalizeTabs" {
		t.Fatal(got)
	}
}

func TestCLIControlLostEndRequiresExplicitRecovery(t *testing.T) {
	f := &controlFixture{epoch: 20, loseEnd: true}
	options := f.start(t)
	options.timeout = 60 * time.Millisecond
	if _, err := invokeWithOptions(options, "createTab", nil); err != nil {
		t.Fatal(err)
	}
	if _, err := invokeWithOptions(options, "turnEnded", nil); err == nil {
		t.Fatal("end should time out")
	}
	if options.control.snapshot().epoch != 20 {
		t.Fatal("timed out end changed epoch")
	}
	response, err := invokeWithOptions(options, "createTab", nil)
	if err != nil {
		t.Fatal(err)
	}
	if response["error"] == nil {
		t.Fatal("stale request accepted")
	}
	if _, err := options.control.begin(options, nil); err != nil {
		t.Fatal(err)
	}
	response, err = invokeWithOptions(options, "createTab", nil)
	if err != nil || response["error"] != nil {
		t.Fatalf("explicit recovery: %v %v", response, err)
	}
	if strings.Count(strings.Join(f.methods(), ","), "turnEnded") != 1 {
		t.Fatal("end replayed")
	}
}

func TestCLIControlDeadlineIncludesHandshake(t *testing.T) {
	for _, method := range []string{"browserAction", "waitForFileChooser", "waitForDownload", "armNetworkWait", "armNavigationWait", "downloadURL", "downloadMedia", "downloadPath", "cancelDownload"} {
		t.Run(method, func(t *testing.T) {
			for _, timeout := range []time.Duration{1500 * time.Millisecond, 1050 * time.Millisecond} {
				t.Run(timeout.String(), func(t *testing.T) {
					f := &controlFixture{epoch: 30, delayInfo: 80 * time.Millisecond}
					options := f.start(t)
					options.timeout = timeout
					response, err := invokeWithOptions(options, method, map[string]any{"tabId": 1, "action": "click", "timeoutMs": 10_000})
					if timeout < 1100*time.Millisecond {
						if err == nil || strings.Contains(strings.Join(f.methods(), ","), method) {
							t.Fatalf("expired action sent: %v", err)
						}
						return
					}
					if err != nil {
						t.Fatal(err)
					}
					budget := response["result"].(map[string]any)["timeoutMs"].(float64)
					if budget <= 0 || budget > 430 {
						t.Fatalf("unbounded budget %v", budget)
					}
				})
			}
		})
	}
}

func TestCLIWaitBudgetsValidateAndDefault(t *testing.T) {
	for _, method := range []string{"waitForFileChooser", "waitForDownload", "armNetworkWait", "armNavigationWait", "downloadURL", "downloadMedia", "downloadPath", "cancelDownload"} {
		for _, invalid := range []any{nil, float64(0), float64(-1), 1.5, float64(120001), "1000"} {
			if err := boundCLIActionDeadline(method, map[string]any{"timeoutMs": invalid}, time.Now().Add(20*time.Second)); err == nil {
				t.Fatalf("accepted %s timeout %v", method, invalid)
			}
		}
		params := map[string]any{}
		if err := boundCLIActionDeadline(method, params, time.Now().Add(20*time.Second)); err != nil || params["timeoutMs"] != float64(10000) {
			t.Fatalf("%s default: %v %v", method, params, err)
		}
	}
}

func TestCLIShortOperationBudgetIsNotExtendedByLongDefault(t *testing.T) {
	for _, method := range []string{"browserAction", "waitForFileChooser", "waitForDownload", "armNetworkWait", "armNavigationWait", "downloadURL", "downloadMedia", "downloadPath", "cancelDownload"} {
		t.Run(method, func(t *testing.T) {
			f := &controlFixture{epoch: 34, delayInfo: 250 * time.Millisecond}
			options := f.start(t)
			options.timeout = 10 * time.Second
			if _, err := invokeWithOptions(options, method, map[string]any{"timeoutMs": 100}); err == nil || !strings.Contains(err.Error(), "timed out before") {
				t.Fatalf("short operation accepted: %v", err)
			}
			if strings.Contains(strings.Join(f.methods(), ","), method) {
				t.Fatal("operation sent after its budget expired")
			}
		})
	}
}

func TestMCPQueuedOperationBudgetStartsAtSubmission(t *testing.T) {
	for _, method := range []string{"waitForDownload", "armNetworkWait", "armNavigationWait", "downloadURL", "downloadMedia", "downloadPath", "cancelDownload"} {
		f := &controlFixture{epoch: 34}
		options := f.start(t)
		options.timeout = 10 * time.Second
		submitted := options.control.snapshot()
		submitted.deadline = time.Now().Add(8 * time.Second) // submitted two seconds ago
		if _, err := options.control.invoke(options, method, map[string]any{"timeoutMs": 100}, &submitted); err == nil || !strings.Contains(err.Error(), "timed out") {
			t.Fatalf("queued operation accepted: %v", err)
		}
		if len(f.methods()) != 0 {
			t.Fatal("expired queued operation connected or sent work")
		}
	}
}

func TestCLIDirectDownloadsCapabilityAndFixedRawBinding(t *testing.T) {
	for _, method := range []string{"downloadURL", "cancelDownload"} {
		for _, manual := range []bool{false, true} {
			f := &controlFixture{epoch: 36, withoutDirectDownloads: true}
			options := f.start(t)
			options.timeout = 5 * time.Second
			params := map[string]any{"tabId": 1, "url": "https://fixture.test/file", "downloadId": "owned"}
			if manual {
				params["control_epoch"], params["session_id"], params["turn_id"] = 36, "fixture", "fixed"
			}
			if _, err := invokeWithOptions(options, method, params); err == nil || !strings.Contains(err.Error(), "OBU_DIRECT_DOWNLOADS_UNSUPPORTED") {
				t.Fatalf("unsupported %s reached extension: %v", method, err)
			}
			for _, sent := range f.methods() {
				if sent == method {
					t.Fatal("unsupported download operation was sent")
				}
			}
		}
	}
	f := &controlFixture{epoch: 37}
	options := f.start(t)
	options.timeout = 5 * time.Second
	params := map[string]any{"downloadId": "owned", "control_epoch": 37, "session_id": "fixture", "turn_id": "original", "timeoutMs": 1000}
	for _, method := range []string{"downloadPath", "cancelDownload"} {
		response, err := invokeWithOptions(options, method, params)
		if err != nil {
			t.Fatal(err)
		}
		result := response["result"].(map[string]any)
		if result["turn_id"] != "original" || result["control_epoch"] != float64(37) || result["downloadId"] != "owned" {
			t.Fatal("download handle binding changed", result)
		}
		if budget, ok := result["timeoutMs"].(float64); !ok || budget <= 0 || budget > 1000 {
			t.Fatal("download request budget changed", result)
		}
	}
}

func TestCLIMediaDownloadCapability(t *testing.T) {
	for _, manual := range []bool{false, true} {
		for _, unsupported := range []bool{false, true} {
			f := &controlFixture{epoch: 36, withoutMediaDownloads: unsupported}
			options := f.start(t)
			options.timeout = 5 * time.Second
			params := map[string]any{"tabId": 1, "locator": []any{map[string]any{"kind": "css", "selector": "img"}}, "timeoutMs": 1000}
			if manual {
				params["control_epoch"], params["session_id"], params["turn_id"] = 36, "fixture", "fixed"
			}
			response, err := invokeWithOptions(options, "downloadMedia", params)
			if unsupported {
				if err == nil || !strings.Contains(err.Error(), "OBU_MEDIA_DOWNLOADS_UNSUPPORTED") {
					t.Fatalf("unsupported media: %v", err)
				}
				for _, sent := range f.methods() {
					if sent == "downloadMedia" {
						t.Fatal("unsupported media was sent")
					}
				}
			} else {
				if err != nil {
					t.Fatal(err)
				}
				result := response["result"].(map[string]any)
				if result["control_epoch"] != float64(36) || result["timeoutMs"].(float64) > 1000 {
					t.Fatal(result)
				}
			}
		}
	}
}

func TestCLINetworkWaitCapabilityAndFixedRawBinding(t *testing.T) {
	for _, manual := range []bool{false, true} {
		f := &controlFixture{epoch: 36, withoutNetworkWait: true}
		options := f.start(t)
		options.timeout = 5 * time.Second
		params := map[string]any{"tabId": 1, "event": "request", "match": map[string]any{"url": "https://fixture.test"}}
		if manual {
			params["control_epoch"], params["session_id"], params["turn_id"] = 36, "fixture", "fixed"
		}
		if _, err := invokeWithOptions(options, "armNetworkWait", params); err == nil || !strings.Contains(err.Error(), "OBU_NETWORK_WAIT_UNSUPPORTED") {
			t.Fatalf("unsupported extension accepted network wait: %v", err)
		}
		for _, method := range f.methods() {
			if cliNetworkWaitMethod(method) {
				t.Fatal("unsupported network RPC reached extension")
			}
		}
	}
	f := &controlFixture{epoch: 37}
	options := f.start(t)
	options.timeout = 5 * time.Second
	params := map[string]any{"tabId": 1, "waiterId": "ready-wait", "control_epoch": 37, "session_id": "fixture", "turn_id": "original-turn"}
	for _, method := range []string{"collectNetworkWait", "cancelNetworkWait"} {
		response, err := invokeWithOptions(options, method, params)
		if err != nil {
			t.Fatal(err)
		}
		result := response["result"].(map[string]any)
		if result["turn_id"] != "original-turn" || result["control_epoch"] != float64(37) {
			t.Fatal(result)
		}
		if _, exists := result["timeoutMs"]; exists {
			t.Fatal("collect/cancel reset the network deadline")
		}
	}
}

func TestCLIQueuedRequestExpiresWithoutWaitingForTransportRelease(t *testing.T) {
	f := &controlFixture{epoch: 35}
	options := f.start(t)
	options.timeout = 30 * time.Millisecond
	options.control.gate <- struct{}{}
	defer func() { <-options.control.gate }()
	started := time.Now()
	if _, err := invokeWithOptions(options, "createTab", nil); err == nil || !strings.Contains(err.Error(), "timed out") {
		t.Fatalf("queued request did not time out: %v", err)
	}
	if time.Since(started) > 500*time.Millisecond || len(f.methods()) != 0 {
		t.Fatal("queued request waited for the transport or sent work after expiry")
	}
}

func TestMCPBatchEndDoesNotRebindQueuedTool(t *testing.T) {
	f := &controlFixture{epoch: 40}
	options := f.start(t)
	server := newMCPServer(options)
	if _, err := server.invoke("createTab", nil); err != nil {
		t.Fatal(err)
	}
	responses := server.handleLine([]byte(`[{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"turn_ended"}},{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"tabs"}}]`))
	encoded, _ := json.Marshal(responses)
	if !strings.Contains(string(encoded), "OBU_STALE_CONTROL_EPOCH") {
		t.Fatal(string(encoded))
	}
	if strings.Contains(strings.Join(f.methods(), ","), "getTabs") {
		t.Fatal("old queued MCP call sent")
	}
	if _, err := server.invoke("getTabs", nil); err != nil {
		t.Fatal(err)
	}
}

func TestMCPAlreadyReadLinesKeepTheirSubmissionEpoch(t *testing.T) {
	f := &controlFixture{epoch: 45, delayInfo: 80 * time.Millisecond}
	options := f.start(t)
	server := newMCPServer(options)
	input := strings.Join([]string{
		`{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"tabs"}}`,
		`{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"turn_ended"}}`,
		`{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"tabs"}}`,
	}, "\n")
	var output strings.Builder
	if err := server.serve(strings.NewReader(input), &output); err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(output.String(), "OBU_STALE_CONTROL_EPOCH") {
		t.Fatal(output.String())
	}
	if strings.Count(strings.Join(f.methods(), ","), "getTabs") != 1 {
		t.Fatal("queued request silently rebound", f.methods())
	}
	if _, err := server.invoke("getTabs", nil); err != nil {
		t.Fatal("fresh submission", err)
	}
}

func TestCLIExplicitEpochDoesNotChangeManagedState(t *testing.T) {
	f := &controlFixture{epoch: 50}
	options := f.start(t)
	if _, err := invokeWithOptions(options, "createTab", nil); err != nil {
		t.Fatal(err)
	}
	if _, err := invokeWithOptions(options, "createTab", map[string]any{"session_id": "other"}); err == nil {
		t.Fatal("borrowed epoch for another session")
	}
	response, err := invokeWithOptions(options, "turnEnded", map[string]any{"session_id": "other", "turn_id": "manual", "control_epoch": 50})
	if err != nil || response["error"] != nil {
		t.Fatalf("%v %v", response, err)
	}
	if options.control.snapshot().epoch != 50 {
		t.Fatal("manual token changed managed state")
	}
}

func TestCLINavigationWaitCapabilityAndFixedRawBinding(t *testing.T) {
	for _, manual := range []bool{false, true} {
		f := &controlFixture{epoch: 36, withoutNavigationWait: true}
		options := f.start(t)
		options.timeout = 5 * time.Second
		params := map[string]any{"tabId": 1, "event": "url", "url": "https://fixture.test"}
		if manual {
			params["control_epoch"], params["session_id"], params["turn_id"] = 36, "fixture", "fixed"
		}
		if _, err := invokeWithOptions(options, "armNavigationWait", params); err == nil || !strings.Contains(err.Error(), "OBU_NAVIGATION_WAIT_UNSUPPORTED") {
			t.Fatalf("unsupported extension accepted network wait: %v", err)
		}
		for _, method := range f.methods() {
			if cliNavigationWaitMethod(method) {
				t.Fatal("unsupported network RPC reached extension")
			}
		}
	}
	f := &controlFixture{epoch: 37}
	options := f.start(t)
	options.timeout = 5 * time.Second
	params := map[string]any{"tabId": 1, "waiterId": "ready-wait", "control_epoch": 37, "session_id": "fixture", "turn_id": "original-turn"}
	for _, method := range []string{"collectNavigationWait", "cancelNavigationWait"} {
		response, err := invokeWithOptions(options, method, params)
		if err != nil {
			t.Fatal(err)
		}
		result := response["result"].(map[string]any)
		if result["turn_id"] != "original-turn" || result["control_epoch"] != float64(37) {
			t.Fatal(result)
		}
		if _, exists := result["timeoutMs"]; exists {
			t.Fatal("collect/cancel reset the network deadline")
		}
	}
}

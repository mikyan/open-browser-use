package obu

import (
	"net"
	"strings"
	"testing"
	"time"

	"github.com/ifuryst/open-browser-use/internal/wire"
)

func legacyControlHandshake(t *testing.T, conn net.Conn) {
	t.Helper()
	request := readRequest(t, conn)
	if request["method"] != "getInfo" {
		t.Fatalf("expected lifecycle capability negotiation, got %#v", request)
	}
	writeResponse(t, conn, request["id"], Params{"metadata": Params{}})
}
func testControlState(epoch int, turn string) Params {
	return Params{"lifecycleVersion": 1, "controlEpoch": epoch, "nextTurnId": turn}
}

func TestControlEpochEndAndExplicitRecovery(t *testing.T) {
	path, cleanup := startSDKServer(t, func(conn net.Conn) {
		for _, step := range []struct {
			method  string
			epoch   float64
			turn    string
			result  any
			failure string
		}{
			{"getInfo", 0, "initial", Params{"metadata": Params{"turnLifecycleVersion": 1}}, ""},
			{"getControlState", 0, "initial", testControlState(7, "next"), ""},
			{"createTab", 7, "initial", Params{"id": 1}, ""},
			{"turnEnded", 7, "initial", testControlState(8, "next"), ""},
			{"createTab", 8, "next", nil, "Stale control epoch"},
			{"getControlState", 0, "next", testControlState(20, "recovered"), ""},
			{"createTab", 20, "recovered", Params{"id": 2}, ""},
		} {
			request := readRequest(t, conn)
			params := request["params"].(map[string]any)
			if request["method"] != step.method || params["turn_id"] != step.turn {
				t.Errorf("incorrect lifecycle request: %#v", request)
			}
			if step.epoch != 0 && params["control_epoch"] != step.epoch {
				t.Errorf("incorrect epoch: %#v", params)
			}
			if step.failure != "" {
				if err := wire.WriteJSON(conn, Params{"id": request["id"], "error": Params{"message": step.failure}}); err != nil {
					t.Fatal(err)
				}
			} else {
				writeResponse(t, conn, request["id"], step.result)
			}
		}
	})
	defer cleanup()
	client := NewClient(Options{SocketPath: path, TurnID: "initial", Timeout: time.Second})
	defer client.Close()
	if _, err := client.CreateTab(); err != nil {
		t.Fatal(err)
	}
	if _, err := client.TurnEnded(); err != nil {
		t.Fatal(err)
	}
	if _, err := client.CreateTab(); err == nil || !strings.Contains(err.Error(), "Stale control epoch") {
		t.Fatalf("expected stale rejection: %v", err)
	}
	if client.control.epoch != 8 {
		t.Fatal("error changed control state")
	}
	if _, err := client.BeginTurn(); err != nil {
		t.Fatal(err)
	}
	if _, err := client.CreateTab(); err != nil {
		t.Fatal(err)
	}
}

func TestClosingControlStatePreventsInput(t *testing.T) {
	path, cleanup := startSDKServer(t, func(conn net.Conn) {
		request := readRequest(t, conn)
		writeResponse(t, conn, request["id"], Params{"metadata": Params{"turnLifecycleVersion": 1}})
		request = readRequest(t, conn)
		state := testControlState(4, "next")
		state["closing"] = true
		writeResponse(t, conn, request["id"], state)
	})
	defer cleanup()
	client := NewClient(Options{SocketPath: path, Timeout: time.Second})
	defer client.Close()
	if _, err := client.CreateTab(); err == nil || !strings.Contains(err.Error(), "still closing") {
		t.Fatalf("expected closing rejection: %v", err)
	}
	if client.control.epoch != 0 {
		t.Fatal("closing bootstrap installed an epoch")
	}
}

func TestQueuedRequestExpiresWithoutWaitingForPreviousRequest(t *testing.T) {
	entered := make(chan struct{})
	path, cleanup := startSDKServer(t, func(conn net.Conn) {
		request := readRequest(t, conn)
		close(entered)
		time.Sleep(150 * time.Millisecond)
		writeResponse(t, conn, request["id"], Params{"metadata": Params{}})
	})
	defer cleanup()
	client := NewClient(Options{SocketPath: path, Timeout: time.Second})
	defer client.Close()
	first := make(chan error, 1)
	go func() { _, err := client.GetInfo(); first <- err }()
	<-entered
	started := time.Now()
	if _, err := client.requestWithTimeout("getInfo", nil, 20*time.Millisecond); err == nil {
		t.Fatal("queued request did not expire")
	}
	if elapsed := time.Since(started); elapsed > 100*time.Millisecond {
		t.Fatalf("queue deadline returned too late: %v", elapsed)
	}
	if err := <-first; err != nil {
		t.Fatalf("expired queue entry affected predecessor: %v", err)
	}
}

func TestActionBudgetShrinksAfterControlDiscovery(t *testing.T) {
	path, cleanup := startSDKServer(t, func(conn net.Conn) {
		request := readRequest(t, conn)
		time.Sleep(80 * time.Millisecond)
		writeResponse(t, conn, request["id"], Params{"metadata": Params{}})
		request = readRequest(t, conn)
		params := request["params"].(map[string]any)
		timeout, ok := params["timeoutMs"].(float64)
		if !ok || timeout <= 0 || timeout > 430 {
			t.Errorf("discovery did not consume action deadline: %#v", params)
		}
		writeResponse(t, conn, request["id"], Params{"value": nil, "engine": Params{"name": "playwright-crx", "version": "0.15.0", "playwrightVersion": "1.53.0"}})
	})
	defer cleanup()
	client := NewClient(Options{SocketPath: path, Timeout: 10 * time.Second})
	defer client.Close()
	if _, err := client.BrowserAction(7, "click", BrowserActionOptions{Locator: []Params{{"kind": "css", "selector": "button"}}, Timeout: 500 * time.Millisecond}); err != nil {
		t.Fatal(err)
	}
}

func TestControlDiscoveryCannotRetargetQueuedCallerArguments(t *testing.T) {
	selector := Params{"kind": "css", "selector": "#observed"}
	path, cleanup := startSDKServer(t, func(conn net.Conn) {
		request := readRequest(t, conn)
		// Receiving discovery proves the public invocation has captured args.
		selector["selector"] = "#unexpected"
		writeResponse(t, conn, request["id"], Params{"metadata": Params{}})
		request = readRequest(t, conn)
		steps := request["params"].(map[string]any)["locator"].([]any)
		if steps[0].(map[string]any)["selector"] != "#observed" {
			t.Errorf("caller mutation retargeted input: %#v", steps)
		}
		writeResponse(t, conn, request["id"], Params{"value": nil, "engine": Params{"name": "playwright-crx", "version": "0.15.0", "playwrightVersion": "1.53.0"}})
	})
	defer cleanup()
	client := NewClient(Options{SocketPath: path, Timeout: time.Second})
	defer client.Close()
	if _, err := client.BrowserAction(7, "click", BrowserActionOptions{Locator: []Params{selector}}); err != nil {
		t.Fatal(err)
	}
}

func TestEventWaitBudgetShrinksAfterDiscovery(t *testing.T) {
	for _, method := range []string{"waitForFileChooser", "waitForDownload"} {
		t.Run(method, func(t *testing.T) {
			path, cleanup := startSDKServer(t, func(conn net.Conn) {
				request := readRequest(t, conn)
				time.Sleep(80 * time.Millisecond)
				writeResponse(t, conn, request["id"], Params{"metadata": Params{}})
				request = readRequest(t, conn)
				params := request["params"].(map[string]any)
				timeout, ok := params["timeoutMs"].(float64)
				if request["method"] != method || !ok || timeout <= 0 || timeout > 430 {
					t.Errorf("discovery did not consume event deadline: %#v", request)
				}
				writeResponse(t, conn, request["id"], Params{"id": "owned-event"})
			})
			defer cleanup()
			client := NewClient(Options{SocketPath: path, Timeout: 10 * time.Second})
			defer client.Close()
			helper := client.WaitForFileChooser
			if method == "waitForDownload" {
				helper = client.WaitForDownload
			}
			if _, err := helper(7, 500); err != nil {
				t.Fatal(err)
			}
			for _, invalid := range []int{-1, 120001} {
				if _, err := helper(7, invalid); err == nil {
					t.Fatalf("invalid timeout accepted: %d", invalid)
				}
			}
		})
	}
}

func TestRawNavigationKeepsEpochAndWaitsForNewLoader(t *testing.T) {
	path, cleanup := startSDKServer(t, func(conn net.Conn) {
		request := readRequest(t, conn)
		writeResponse(t, conn, request["id"], Params{"metadata": Params{"turnLifecycleVersion": 1}})
		request = readRequest(t, conn)
		writeResponse(t, conn, request["id"], testControlState(7, "next"))
		for _, step := range []struct {
			method string
			result any
		}{
			{"attach", Params{}},
			{"Page.enable", Params{}},
			{"Page.navigate", Params{"frameId": "main", "loaderId": "new"}},
			{"Page.getFrameTree", Params{"frameTree": Params{"frame": Params{"loaderId": "old"}}}},
			{"Page.getFrameTree", Params{"frameTree": Params{"frame": Params{"loaderId": "new"}}}},
			{"Runtime.evaluate", Params{"result": Params{"value": Params{"readyState": "complete"}}}},
			{"Page.getFrameTree", Params{"frameTree": Params{"frame": Params{"loaderId": "new"}}}},
		} {
			request = readRequest(t, conn)
			params := request["params"].(map[string]any)
			method := params["method"]
			if request["method"] == "attach" {
				method = "attach"
			}
			if method != step.method || params["control_epoch"] != float64(7) || params["turn_id"] != "initial" {
				t.Fatalf("unexpected scoped navigation step: %#v", request)
			}
			writeResponse(t, conn, request["id"], step.result)
		}
	})
	defer cleanup()
	client := NewClient(Options{SocketPath: path, TurnID: "initial"})
	defer client.Close()
	if _, err := NewCDP(client).Navigate(7, "https://example.test", GotoOptions{}); err != nil {
		t.Fatal(err)
	}
}

func TestShortOperationExpiresDuringDiscoveryWithDefaultClientBudget(t *testing.T) {
	for _, method := range []string{"browserAction", "waitForFileChooser", "waitForDownload", "newTab"} {
		t.Run(method, func(t *testing.T) {
			path, cleanup := startSDKServer(t, func(conn net.Conn) {
				request := readRequest(t, conn)
				time.Sleep(250 * time.Millisecond)
				writeResponse(t, conn, request["id"], Params{"metadata": Params{}})
			})
			defer cleanup()
			client := NewClient(Options{SocketPath: path})
			defer client.Close()
			var err error
			if method == "newTab" {
				_, err = NewBrowser(client).NewTab(GotoOptions{URL: "https://example.test", Timeout: 100 * time.Millisecond})
			} else {
				_, err = client.Request(method, Params{"tabId": 7, "action": "click", "timeoutMs": 100})
			}
			if err == nil || !strings.Contains(err.Error(), "request was not sent") {
				t.Fatalf("expired operation was sent: %v", err)
			}
		})
	}
}

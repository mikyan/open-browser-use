package obu

import (
	"net"
	"strings"
	"testing"
	"time"

	"github.com/ifuryst/open-browser-use/internal/wire"
)

func navigationInfo() Params {
	return Params{"metadata": Params{"turnLifecycleVersion": 1, "navigationWaitVersion": 1}}
}
func TestNavigationWaitSequentialAndOriginalEpoch(t *testing.T) {
	done := make(chan struct{})
	path, cleanup := startSDKServer(t, func(conn net.Conn) {
		defer close(done)
		methods := []string{"getInfo", "getControlState", "armNavigationWait", "browserAction", "collectNavigationWait", "collectNavigationWait", "cancelNavigationWait", "getControlState", "collectNavigationWait"}
		for index, method := range methods {
			request := readRequest(t, conn)
			params := request["params"].(map[string]any)
			if request["method"] != method {
				t.Errorf("method=%v want=%s", request["method"], method)
			}
			if index >= 2 && method != "getControlState" && (params["turn_id"] != "initial" || params["control_epoch"] != float64(7)) {
				t.Errorf("binding changed: %#v", params)
			}
			var response any = Params{}
			switch method {
			case "getInfo":
				response = navigationInfo()
			case "getControlState":
				if index == 1 {
					response = testControlState(7, "next")
				} else {
					response = testControlState(8, "next")
				}
			case "armNavigationWait":
				if params["event"] != "url" || params["url"] != "**/next" || params["waitUntil"] != "commit" {
					t.Errorf("navigation options changed: %#v", params)
				}

				if budget := params["timeoutMs"].(float64); budget <= 0 || budget > 1000 {
					t.Errorf("budget=%v", budget)
				}
				response = Params{"waiterId": "w", "remainingMs": 10}
			case "browserAction":
				response = Params{"value": nil, "engine": Params{"name": "playwright-crx", "version": "0.15.0", "playwrightVersion": "1.53.0"}}
			case "collectNavigationWait":
				if _, ok := params["timeoutMs"]; ok {
					t.Error("collect must not restart navigation deadline")
				}
				response = Params{}
			}
			if index == len(methods)-1 {
				if err := wire.WriteJSON(conn, Params{"id": request["id"], "error": Params{"message": "OBU_STALE_CONTROL_EPOCH"}}); err != nil {
					t.Error(err)
				}
			} else {
				writeResponse(t, conn, request["id"], response)
			}
		}
	})
	defer cleanup()
	client := NewClient(Options{SocketPath: path, TurnID: "initial"})
	defer client.Close()
	tab := NewBrowser(client).Tab(9)
	wait, err := tab.Playwright.ExpectURL("**/next", NavigationWaitOptions{Timeout: time.Second, WaitUntil: "commit"})
	if err != nil {
		t.Fatal(err)
	}
	if err := tab.GetByRole("button", RoleOptions{Name: "Save"}).Click(); err != nil {
		t.Fatal(err)
	}
	time.Sleep(15 * time.Millisecond)
	for i := 0; i < 2; i++ {
		if err := wait.Result(); err != nil {
			t.Fatal(err)
		}
	}
	if err := wait.Cancel(); err != nil {
		t.Fatal(err)
	}
	if _, err := client.BeginTurn(); err != nil {
		t.Fatal(err)
	}
	if err := wait.Result(); err == nil || !strings.Contains(err.Error(), "OBU_STALE_CONTROL_EPOCH") {
		t.Fatalf("stale handle: %v", err)
	}
	<-done
}

func TestNavigationWaitShortBudgetIncludesDiscovery(t *testing.T) {
	for _, raw := range []bool{false, true} {
		path, cleanup := startSDKServer(t, func(conn net.Conn) {
			request := readRequest(t, conn)
			time.Sleep(250 * time.Millisecond)
			writeResponse(t, conn, request["id"], navigationInfo())
			request = readRequest(t, conn)
			if request["method"] != "getControlState" {
				t.Errorf("unexpected request %#v", request)
			}
			writeResponse(t, conn, request["id"], testControlState(7, "next"))
			_ = conn.SetReadDeadline(time.Now().Add(time.Second))
			var extra map[string]any
			if err := wire.ReadJSON(conn, &extra); err == nil {
				t.Errorf("expired arm sent: %#v", extra)
			}
		})
		client := NewClient(Options{SocketPath: path, Timeout: 10 * time.Second})
		var err error
		if raw {
			_, err = client.Request("armNavigationWait", Params{"tabId": 9, "event": "url", "url": "x", "timeoutMs": 100})
		} else {
			_, err = NewBrowser(client).Tab(9).ExpectURL("x", NavigationWaitOptions{Timeout: 100 * time.Millisecond})
		}
		if err == nil || !strings.Contains(err.Error(), "deadline") {
			t.Fatalf("expected original deadline: %v", err)
		}
		client.Close()
		cleanup()
	}
}

func TestNavigationWaitInvalidAndUnsupported(t *testing.T) {
	tab := NewBrowser(NewClient(Options{SocketPath: "unused"})).Tab(9)
	for _, url := range []string{"", strings.Repeat("🙂", 1025)} {
		if _, err := tab.ExpectURL(url); err == nil {
			t.Error("invalid URL accepted")
		}
	}
	for _, option := range []NavigationWaitOptions{{State: "load"}, {WaitUntil: "idle"}, {Timeout: -1}, {Timeout: time.Microsecond}, {Timeout: 121 * time.Second}} {
		if _, err := tab.ExpectURL("x", option); err == nil {
			t.Error("invalid URL options accepted")
		}
	}
	for _, option := range []NavigationWaitOptions{{State: "commit"}, {WaitUntil: "load"}} {
		if _, err := tab.ExpectLoadState(option); err == nil {
			t.Error("invalid load options accepted")
		}
	}
	path, cleanup := startSDKServer(t, func(conn net.Conn) { legacyControlHandshake(t, conn) })
	defer cleanup()
	client := NewClient(Options{SocketPath: path})
	defer client.Close()
	if _, err := NewBrowser(client).Tab(9).ExpectURL("x"); err == nil || !strings.Contains(err.Error(), "OBU_NAVIGATION_WAIT_UNSUPPORTED") {
		t.Fatalf("unsupported: %v", err)
	}
}

func TestNavigationLoadStateAndStrictResult(t *testing.T) {
	path, cleanup := startSDKServer(t, func(conn net.Conn) {
		request := readRequest(t, conn)
		writeResponse(t, conn, request["id"], navigationInfo())
		request = readRequest(t, conn)
		writeResponse(t, conn, request["id"], testControlState(7, "next"))
		request = readRequest(t, conn)
		params := request["params"].(map[string]any)
		if params["event"] != "loadstate" || params["state"] != "networkidle" || params["url"] != nil || params["waitUntil"] != nil {
			t.Errorf("unexpected load options: %#v", params)
		}
		writeResponse(t, conn, request["id"], Params{"waiterId": "load", "remainingMs": 1000})
		for _, value := range []any{nil, []any{}, Params{"value": nil}} {
			request = readRequest(t, conn)
			writeResponse(t, conn, request["id"], value)
		}
	})
	defer cleanup()
	client := NewClient(Options{SocketPath: path})
	defer client.Close()
	wait, err := NewBrowser(client).Tab(9).Playwright.ExpectLoadState(NavigationWaitOptions{State: "networkidle"})
	if err != nil {
		t.Fatal(err)
	}
	for i := 0; i < 3; i++ {
		if err := wait.Result(); err == nil {
			t.Fatal("malformed acknowledgement accepted")
		}
	}
}

func TestNavigationWaitQueueConsumesArmBudget(t *testing.T) {
	blocked := make(chan struct{})
	path, cleanup := startSDKServer(t, func(conn net.Conn) {
		request := readRequest(t, conn)
		writeResponse(t, conn, request["id"], navigationInfo())
		request = readRequest(t, conn)
		writeResponse(t, conn, request["id"], testControlState(7, "next"))
		request = readRequest(t, conn)
		if request["method"] != "getTabs" {
			t.Errorf("unexpected predecessor: %#v", request)
		}
		close(blocked)
		time.Sleep(250 * time.Millisecond)
		writeResponse(t, conn, request["id"], []any{})
		_ = conn.SetReadDeadline(time.Now().Add(time.Second))
		var extra map[string]any
		if err := wire.ReadJSON(conn, &extra); err == nil {
			t.Errorf("expired queued arm sent: %#v", extra)
		}
	})
	defer cleanup()
	client := NewClient(Options{SocketPath: path})
	defer client.Close()
	predecessor := make(chan error, 1)
	go func() { _, err := client.GetTabs(); predecessor <- err }()
	<-blocked
	_, err := NewBrowser(client).Tab(9).ExpectURL("x", NavigationWaitOptions{Timeout: 100 * time.Millisecond})
	if err == nil || !strings.Contains(err.Error(), "deadline") {
		t.Fatalf("queued arm exceeded its budget: %v", err)
	}
	if err := <-predecessor; err != nil {
		t.Fatalf("predecessor was cancelled: %v", err)
	}
}

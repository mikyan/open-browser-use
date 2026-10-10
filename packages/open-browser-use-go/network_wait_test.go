package obu

import (
	"net"
	"strings"
	"testing"
	"time"

	"github.com/ifuryst/open-browser-use/internal/wire"
)

func networkInfo() Params {
	return Params{"metadata": Params{"turnLifecycleVersion": 1, "networkWaitVersion": 1}}
}
func validNetworkResult() map[string]any {
	return map[string]any{"event": "response", "requestId": "request-1", "url": "http://fixture.test/api", "method": "pOsT", "resourceType": "fetch", "status": float64(503), "statusText": "Unavailable"}
}

func TestNetworkWaitSequentialAndOriginalEpoch(t *testing.T) {
	done := make(chan struct{})
	path, cleanup := startSDKServer(t, func(conn net.Conn) {
		defer close(done)
		methods := []string{"getInfo", "getControlState", "armNetworkWait", "browserAction", "collectNetworkWait", "collectNetworkWait", "cancelNetworkWait", "getControlState", "collectNetworkWait"}
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
				response = networkInfo()
			case "getControlState":
				if index == 1 {
					response = testControlState(7, "next")
				} else {
					response = testControlState(8, "next")
				}
			case "armNetworkWait":
				match := params["match"].(map[string]any)
				if match["method"] != "pOsT" || match["status"] != float64(503) {
					t.Errorf("match changed: %#v", match)
				}
				if budget := params["timeoutMs"].(float64); budget <= 0 || budget > 1000 {
					t.Errorf("budget=%v", budget)
				}
				response = Params{"waiterId": "w", "remainingMs": 10}
			case "browserAction":
				response = Params{"value": nil, "engine": Params{"name": "playwright-crx", "version": "0.15.0", "playwrightVersion": "1.53.0"}}
			case "collectNetworkWait":
				if _, ok := params["timeoutMs"]; ok {
					t.Error("collect must not restart network deadline")
				}
				response = validNetworkResult()
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
	wait, err := tab.Playwright.ExpectResponse(NetworkWaitMatch{URL: "http://fixture.test/api", Method: "pOsT", Status: 503}, NetworkWaitOptions{Timeout: time.Second})
	if err != nil {
		t.Fatal(err)
	}
	if err := tab.GetByRole("button", RoleOptions{Name: "Save"}).Click(); err != nil {
		t.Fatal(err)
	}
	time.Sleep(15 * time.Millisecond)
	for i := 0; i < 2; i++ {
		result, err := wait.Result()
		if err != nil || result.Status != 503 || result.Method != "pOsT" {
			t.Fatalf("result=%#v err=%v", result, err)
		}
	}
	if err := wait.Cancel(); err != nil {
		t.Fatal(err)
	}
	if _, err := client.BeginTurn(); err != nil {
		t.Fatal(err)
	}
	if _, err := wait.Result(); err == nil || !strings.Contains(err.Error(), "OBU_STALE_CONTROL_EPOCH") {
		t.Fatalf("stale handle: %v", err)
	}
	<-done
}

func TestNetworkWaitShortBudgetIncludesDiscovery(t *testing.T) {
	for _, raw := range []bool{false, true} {
		path, cleanup := startSDKServer(t, func(conn net.Conn) {
			request := readRequest(t, conn)
			time.Sleep(250 * time.Millisecond)
			writeResponse(t, conn, request["id"], networkInfo())
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
			_, err = client.Request("armNetworkWait", Params{"tabId": 9, "event": "request", "match": Params{"url": "x"}, "timeoutMs": 100})
		} else {
			_, err = NewBrowser(client).Tab(9).ExpectRequest(NetworkWaitMatch{URL: "x"}, NetworkWaitOptions{Timeout: 100 * time.Millisecond})
		}
		if err == nil || !strings.Contains(err.Error(), "deadline") {
			t.Fatalf("expected original deadline: %v", err)
		}
		client.Close()
		cleanup()
	}
}

func TestNetworkWaitInvalidAndUnsupported(t *testing.T) {
	tab := NewBrowser(NewClient(Options{SocketPath: "unused"})).Tab(9)
	for _, match := range []NetworkWaitMatch{{}, {URL: strings.Repeat("🙂", 1025)}, {URL: "x", Method: strings.Repeat("é", 65)}, {URL: "x", Status: 200}, {URL: "x", URLMatch: "regex"}} {
		if _, err := tab.ExpectRequest(match); err == nil {
			t.Errorf("invalid accepted %#v", match)
		}
	}
	for _, timeout := range []time.Duration{-1, time.Microsecond, 120*time.Second + time.Millisecond} {
		if _, err := tab.ExpectRequest(NetworkWaitMatch{URL: "x"}, NetworkWaitOptions{Timeout: timeout}); err == nil {
			t.Error("invalid timeout accepted")
		}
	}
	path, cleanup := startSDKServer(t, func(conn net.Conn) { legacyControlHandshake(t, conn) })
	defer cleanup()
	client := NewClient(Options{SocketPath: path})
	defer client.Close()
	if _, err := NewBrowser(client).Tab(9).ExpectResponse(NetworkWaitMatch{URL: "x"}); err == nil || !strings.Contains(err.Error(), "OBU_NETWORK_WAIT_UNSUPPORTED") {
		t.Fatalf("unsupported: %v", err)
	}
}

func TestNetworkWaitStrictResult(t *testing.T) {
	for _, mutation := range []Params{{"event": "request"}, {"status": true}, {"status": float64(99)}, {"status": nil}, {"url": strings.Repeat("界", 1366)}, {"truncated": 1}, {"headers": Params{}}, {"redirectedFrom": ""}} {
		value := validNetworkResult()
		for key, v := range mutation {
			value[key] = v
		}
		if _, err := parseNetworkResult(value, "response"); err == nil {
			t.Errorf("invalid result accepted: %#v", mutation)
		}
	}
	if _, err := parseNetworkResult(validNetworkResult(), "response"); err != nil {
		t.Fatal(err)
	}
}

func TestNetworkWaitQueueConsumesArmBudget(t *testing.T) {
	blocked := make(chan struct{})
	path, cleanup := startSDKServer(t, func(conn net.Conn) {
		request := readRequest(t, conn)
		writeResponse(t, conn, request["id"], networkInfo())
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
	_, err := NewBrowser(client).Tab(9).ExpectRequest(NetworkWaitMatch{URL: "x"}, NetworkWaitOptions{Timeout: 100 * time.Millisecond})
	if err == nil || !strings.Contains(err.Error(), "deadline") {
		t.Fatalf("queued arm exceeded its budget: %v", err)
	}
	if err := <-predecessor; err != nil {
		t.Fatalf("predecessor was cancelled: %v", err)
	}
}

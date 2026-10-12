package obu

import (
	"errors"
	"net"
	"os"
	"strings"
	"testing"
	"time"

	"github.com/ifuryst/open-browser-use/internal/wire"
)

func TestPageWaitChildRetainsScopeAndRejectsEveryPathAfterBeginTurn(t *testing.T) {
	path, cleanup := startSDKServer(t, func(conn net.Conn) {
		pageWaitHandshake(t, conn)
		for _, method := range []string{"armPageWait", "collectPageWait", "browserAction", "attach", "executeCdp", "getControlState", "cancelPageWait"} {
			r := readRequest(t, conn)
			if r["method"] != method {
				t.Errorf("want %s got %v", method, r)
			}
			p := r["params"].(map[string]any)
			var result any = Params{}
			switch method {
			case "armPageWait":
				result = Params{"waiterId": "w", "remainingMs": 1000}
			case "collectPageWait":
				result = Params{"tabId": 12}
			case "getControlState":
				result = testControlState(8, "new-turn")
			case "browserAction", "attach", "executeCdp":
				if p["control_epoch"] != float64(7) || p["turn_id"] != "initial" {
					t.Errorf("scope changed: %v", p)
				}
				if _, exists := p["waiterId"]; exists {
					t.Errorf("observer leaked: %v", p)
				}
				if method == "browserAction" {
					result = Params{"value": nil, "engine": Params{"name": "playwright-crx", "version": "0.15.0", "playwrightVersion": "1.53.0"}}
				}
				if method == "executeCdp" {
					result = Params{"result": Params{"value": "original"}}
				}
			case "cancelPageWait":
				if p["control_epoch"] != float64(7) || p["tabId"] != float64(9) || p["waiterId"] != "w" {
					t.Errorf("cleanup rebound: %v", p)
				}
			}
			writeResponse(t, conn, r["id"], result)
		}
	})
	defer cleanup()
	c := NewClient(Options{SocketPath: path, TurnID: "initial"})
	defer c.Close()
	w, err := NewBrowser(c).Tab(9).Playwright.ExpectPage()
	if err != nil {
		t.Fatal(err)
	}
	child, err := w.Result()
	if err != nil {
		t.Fatal(err)
	}
	if child.ID != 12 {
		t.Fatal(child.ID)
	}
	locator := child.Locator("#once")
	if err = locator.Click(); err != nil {
		t.Fatal(err)
	}
	if _, err = child.Evaluate("location.href"); err != nil {
		t.Fatal(err)
	}
	if _, err = c.BeginTurn(); err != nil {
		t.Fatal(err)
	}
	for _, action := range []func() error{
		func() error { return locator.Click() }, func() error { _, e := child.Evaluate("location.href"); return e },
		func() error { _, e := child.Close(); return e }, func() error { _, e := child.ExpectPage(); return e },
		func() error { _, e := child.Browser.Client.GetTabs(); return e }, func() error { _, e := child.Browser.Client.BeginTurn(); return e },
	} {
		if e := action(); e == nil || !strings.Contains(e.Error(), "OBU_STALE_CONTROL_EPOCH") {
			t.Fatalf("stale child accepted: %v", e)
		}
	}
	if err = w.Cancel(); err != nil {
		t.Fatal(err)
	}
}

func TestPageWaitOriginalDeadlineIncludesBootstrapAndCollect(t *testing.T) {
	for _, stage := range []string{"getInfo", "armPageWait", "collectPageWait"} {
		t.Run(stage, func(t *testing.T) {
			path, cleanup := startSDKServer(t, func(conn net.Conn) {
				for {
					var r map[string]any
					if wire.ReadJSON(conn, &r) != nil {
						return
					}
					method := r["method"].(string)
					if method == stage {
						time.Sleep(80 * time.Millisecond)
					}
					var result any
					switch method {
					case "getInfo":
						result = pageWaitInfo()
					case "getControlState":
						result = testControlState(7, "next")
					case "armPageWait":
						result = Params{"waiterId": "w", "remainingMs": 20}
					case "collectPageWait":
						result = Params{"tabId": 12}
					default:
						t.Errorf("unexpected %s", method)
						return
					}
					if wire.WriteJSON(conn, Params{"id": r["id"], "result": result}) != nil {
						return
					}
					if method == stage {
						var extra any
						if wire.ReadJSON(conn, &extra) == nil {
							t.Errorf("late work replayed: %v", extra)
						}
						return
					}
				}
			})
			defer cleanup()
			c := NewClient(Options{SocketPath: path})
			defer c.Close()
			w, err := NewBrowser(c).Tab(9).ExpectPage(PageWaitOptions{Timeout: 50 * time.Millisecond})
			if stage == "collectPageWait" {
				if err != nil {
					t.Fatal(err)
				}
				_, err = w.Result()
			}
			if err == nil {
				t.Fatal("expired operation succeeded")
			}
		})
	}
}

func pageWaitInfo() Params {
	return Params{"metadata": Params{"turnLifecycleVersion": 1, "pageWaitVersion": 1, "directDownloadsVersion": 1}}
}

func pageWaitHandshake(t *testing.T, conn net.Conn) {
	t.Helper()
	r := readRequest(t, conn)
	if r["method"] != "getInfo" {
		t.Errorf("discovery: %v", r)
	}
	writeResponse(t, conn, r["id"], pageWaitInfo())
	r = readRequest(t, conn)
	if r["method"] != "getControlState" {
		t.Errorf("control: %v", r)
	}
	writeResponse(t, conn, r["id"], testControlState(7, "next"))
}

func TestPageWaitExpirySurvivesQueueAndStillAllowsCleanup(t *testing.T) {
	blocked, release := make(chan struct{}), make(chan struct{})
	path, cleanup := startSDKServer(t, func(conn net.Conn) {
		pageWaitHandshake(t, conn)
		r := readRequest(t, conn)
		writeResponse(t, conn, r["id"], Params{"waiterId": "w", "remainingMs": 50})
		r = readRequest(t, conn)
		if r["method"] != "getTabs" {
			t.Errorf("predecessor %v", r)
		}
		close(blocked)
		<-release
		writeResponse(t, conn, r["id"], []any{})
		r = readRequest(t, conn)
		if r["method"] != "cancelPageWait" {
			t.Errorf("expired collect sent %v", r)
		}
		writeResponse(t, conn, r["id"], Params{})
	})
	defer cleanup()
	c := NewClient(Options{SocketPath: path})
	defer c.Close()
	w, err := NewBrowser(c).Tab(9).ExpectPage()
	if err != nil {
		t.Fatal(err)
	}
	predecessor := make(chan error, 1)
	go func() { _, e := c.GetTabs(); predecessor <- e }()
	<-blocked
	result := make(chan error, 1)
	go func() { _, e := w.Result(); result <- e }()
	// Hold the request gate past the original deadline, but within the reply margin.
	<-time.After(time.Until(w.deadline) + 20*time.Millisecond)
	close(release)
	if err = <-predecessor; err != nil {
		t.Fatal(err)
	}
	if err = <-result; !errors.Is(err, os.ErrDeadlineExceeded) {
		t.Fatalf("expired result: %v", err)
	}
	if err = w.Cancel(); err != nil {
		t.Fatalf("expiry prevented cleanup: %v", err)
	}
}

func TestPageWaitValidationAndUnsupported(t *testing.T) {
	tab := NewBrowser(NewClient(Options{SocketPath: "unused"})).Tab(9)
	for _, timeout := range []time.Duration{-1, time.Microsecond, 121 * time.Second} {
		if _, err := tab.ExpectPage(PageWaitOptions{Timeout: timeout}); err == nil {
			t.Error("invalid timeout accepted")
		}
	}
	if _, err := tab.ExpectPage(PageWaitOptions{}, PageWaitOptions{}); err == nil {
		t.Error("multiple options accepted")
	}
	for _, manual := range []bool{false, true} {
		path, cleanup := startSDKServer(t, func(conn net.Conn) {
			r := readRequest(t, conn)
			writeResponse(t, conn, r["id"], Params{})
			var extra any
			if wire.ReadJSON(conn, &extra) == nil {
				t.Errorf("unsupported request sent %v", extra)
			}
		})
		c := NewClient(Options{SocketPath: path})
		p := Params{"tabId": 9}
		if manual {
			p["control_epoch"] = 7
		}
		_, err := c.Request("armPageWait", p)
		if err == nil || !strings.Contains(err.Error(), "OBU_PAGE_WAIT_UNSUPPORTED") {
			t.Errorf("capability: %v", err)
		}
		c.Close()
		cleanup()
	}
}

func TestPageWaitStrictWireResults(t *testing.T) {
	for _, tc := range []struct {
		method string
		value  any
	}{
		{"armPageWait", Params{"waiterId": "w", "remainingMs": 1000}}, // exceeds actual sent budget
		{"armPageWait", Params{"waiterId": "", "remainingMs": 1}},
		{"armPageWait", Params{"waiterId": "w", "remainingMs": 0}},
		{"armPageWait", Params{"waiterId": "w", "remainingMs": 1, "extra": true}},
		{"collectPageWait", Params{"tabId": true}},
		{"collectPageWait", Params{"tabId": -1}},
		{"collectPageWait", Params{"tabId": 12, "extra": true}},
		{"cancelPageWait", nil},
		{"cancelPageWait", Params{"ok": true}},
	} {
		path, cleanup := startSDKServer(t, func(conn net.Conn) {
			pageWaitHandshake(t, conn)
			r := readRequest(t, conn)
			writeResponse(t, conn, r["id"], tc.value)
		})
		c := NewClient(Options{SocketPath: path})
		p := Params{"tabId": 9, "waiterId": "w"}
		if tc.method == "armPageWait" {
			delete(p, "waiterId")
			p["timeoutMs"] = 100
		}
		if _, err := c.Request(tc.method, p); err == nil {
			t.Errorf("%s accepted %v", tc.method, tc.value)
		}
		c.Close()
		cleanup()
	}
}

func TestPageWaitCancelledObserverCannotCollect(t *testing.T) {
	path, cleanup := startSDKServer(t, func(conn net.Conn) {
		pageWaitHandshake(t, conn)
		r := readRequest(t, conn)
		writeResponse(t, conn, r["id"], Params{"waiterId": "w", "remainingMs": 1000})
		for range 2 {
			r = readRequest(t, conn)
			if r["method"] != "cancelPageWait" {
				t.Errorf("observer cancellation sent transfer operation: %v", r)
			}
			writeResponse(t, conn, r["id"], Params{})
		}
	})
	defer cleanup()
	c := NewClient(Options{SocketPath: path})
	defer c.Close()
	w, err := NewBrowser(c).Tab(9).ExpectPage()
	if err != nil {
		t.Fatal(err)
	}
	if err = w.Cancel(); err != nil {
		t.Fatal(err)
	}
	if _, err = w.Result(); err == nil || !strings.Contains(err.Error(), "cancelled") {
		t.Fatalf("cancelled observer collected: %v", err)
	}
	if err = w.Cancel(); err != nil {
		t.Fatal("cleanup retry failed", err)
	}
}

func TestPageWaitRejectsInvalidParametersBeforeDiscovery(t *testing.T) {
	c := NewClient(Options{SocketPath: "must-not-connect"})
	defer c.Close()
	for _, tc := range []struct {
		method string
		params Params
	}{
		{"armPageWait", Params{"tabId": -1}},
		{"armPageWait", Params{"tabId": 1.5}},
		{"armPageWait", Params{"tabId": 1, "timeoutMs": nil}},
		{"armPageWait", Params{"tabId": 1, "filename": "unexpected"}},
		{"armPageWait", Params{"tabId": 1, "session_id": ""}},
		{"armPageWait", Params{"tabId": 1, "turn_id": strings.Repeat("x", 4097)}},
		{"armPageWait", Params{"tabId": 1, "control_epoch": 0}},
		{"collectPageWait", Params{"tabId": 1, "waiterId": "w", "timeoutMs": 1}},
		{"cancelPageWait", Params{"tabId": 1, "waiterId": ""}},
		{"cancelPageWait", Params{"tabId": 1, "waiterId": strings.Repeat("x", 129)}},
	} {
		if _, err := c.Request(tc.method, tc.params); err == nil || !strings.Contains(err.Error(), "invalid page wait parameters") {
			t.Errorf("%s attempted discovery for invalid params %v: %v", tc.method, tc.params, err)
		}
	}
	if _, err := NewBrowser(c).Tab(-1).ExpectPage(); err == nil || !strings.Contains(err.Error(), "invalid page wait parameters") {
		t.Errorf("typed invalid tab attempted discovery: %v", err)
	}
}

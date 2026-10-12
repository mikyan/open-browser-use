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

func downloadWaitInfo() Params {
	return Params{"metadata": Params{"turnLifecycleVersion": 1, "downloadWaitVersion": 1, "directDownloadsVersion": 1}}
}

func TestDownloadWaitRequirePathArmBooleanOnly(t *testing.T) {
	for _, requirePath := range []bool{true, false} {
		if err := ValidateDownloadWaitParams("armDownloadWait", Params{"tabId": float64(9), "requirePath": requirePath}); err != nil {
			t.Fatal(err)
		}
	}
	for _, requirePath := range []any{nil, float64(0), float64(1), "true", Params{}, []any{}} {
		if err := ValidateDownloadWaitParams("armDownloadWait", Params{"tabId": float64(9), "requirePath": requirePath}); err == nil {
			t.Fatalf("accepted non-boolean requirePath: %v", requirePath)
		}
	}
	for _, method := range []string{"collectDownloadWait", "cancelDownloadWait"} {
		for _, requirePath := range []bool{true, false} {
			if err := ValidateDownloadWaitParams(method, Params{"tabId": float64(9), "waiterId": "w", "requirePath": requirePath}); err == nil {
				t.Fatalf("%s accepted requirePath", method)
			}
		}
	}
}

func TestDownloadWaitRequirePathTypedWireAndHandleIsolation(t *testing.T) {
	for _, playwright := range []bool{false, true} {
		path, cleanup := startSDKServer(t, func(conn net.Conn) {
			r := readRequest(t, conn)
			info := downloadWaitInfo()
			info["metadata"].(Params)["downloadWaitPathVersion"] = 1
			writeResponse(t, conn, r["id"], info)
			r = readRequest(t, conn)
			writeResponse(t, conn, r["id"], testControlState(7, "next"))
			for _, method := range []string{"armDownloadWait", "collectDownloadWait", "cancelDownloadWait"} {
				r = readRequest(t, conn)
				if r["method"] != method {
					t.Errorf("wrong method: %v", r)
				}
				p := r["params"].(map[string]any)
				var result any = Params{}
				if method == "armDownloadWait" {
					if p["requirePath"] != true || p["timeoutMs"].(float64) <= 0 || p["timeoutMs"].(float64) > 1000 {
						t.Errorf("lost path/timeout contract: %v", p)
					}
					result = Params{"waiterId": "w", "remainingMs": 500}
				} else {
					if _, leaked := p["requirePath"]; leaked {
						t.Error("requirePath leaked into handle")
					}
					if len(p) != 5 || p["waiterId"] != "w" || p["turn_id"] != "initial" || p["control_epoch"] != float64(7) {
						t.Errorf("handle rebound: %v", p)
					}
					if method == "collectDownloadWait" {
						result = Params{"downloadId": "page-guid"}
					}
				}
				writeResponse(t, conn, r["id"], result)
			}
		})
		c := NewClient(Options{SocketPath: path, TurnID: "initial"})
		tab := NewBrowser(c).Tab(9)
		options := DownloadWaitOptions{Timeout: time.Second, RequirePath: true}
		var wait *DownloadWait
		var err error
		if playwright {
			wait, err = tab.Playwright.ExpectDownload(options)
		} else {
			wait, err = tab.ExpectDownload(options)
		}
		if err != nil {
			_ = c.Close()
			cleanup()
			t.Fatal(err)
		}
		if download, err := wait.Result(); err != nil || download.DownloadID != "page-guid" {
			t.Fatalf("collect: %v %v", download, err)
		}
		if err := wait.Cancel(); err != nil {
			t.Fatal(err)
		}
		_ = c.Close()
		cleanup()
	}
}

func TestDownloadWaitRequirePathCapabilityIsStrictAndReobserved(t *testing.T) {
	for _, version := range []any{nil, true, "1", 2} {
		path, cleanup := startSDKServer(t, func(conn net.Conn) {
			r := readRequest(t, conn)
			info := downloadWaitInfo()
			info["metadata"].(Params)["downloadWaitPathVersion"] = version
			writeResponse(t, conn, r["id"], info)
			r = readRequest(t, conn)
			writeResponse(t, conn, r["id"], testControlState(7, "next"))
		})
		c := NewClient(Options{SocketPath: path})
		_, err := NewBrowser(c).Tab(9).ExpectDownload(DownloadWaitOptions{RequirePath: true})
		if err == nil || !strings.Contains(err.Error(), "OBU_DOWNLOAD_WAIT_PATH_UNSUPPORTED") {
			t.Fatalf("accepted %v capability: %v", version, err)
		}
		_ = c.Close()
		cleanup()
	}
	path, cleanup := startSDKServer(t, func(conn net.Conn) {
		for _, method := range []string{"getInfo", "getControlState", "armDownloadWait", "getInfo", "armDownloadWait"} {
			r := readRequest(t, conn)
			if r["method"] != method {
				t.Errorf("wrong method %v", r)
			}
			var result any = Params{"waiterId": "w", "remainingMs": 100}
			if method == "getInfo" {
				result = downloadWaitInfo()
			}
			if method == "getControlState" {
				result = testControlState(7, "next")
			}
			if method == "armDownloadWait" && r["params"].(map[string]any)["requirePath"] != false {
				t.Error("false contract changed")
			}
			writeResponse(t, conn, r["id"], result)
		}
	})
	defer cleanup()
	c := NewClient(Options{SocketPath: path})
	defer c.Close()
	if _, err := c.Request("armDownloadWait", Params{"tabId": 9, "requirePath": false}); err != nil {
		t.Fatal(err)
	}
	if err := c.observeControlSupport(map[string]any{"metadata": map[string]any{"turnLifecycleVersion": float64(1), "downloadWaitVersion": float64(1), "downloadWaitPathVersion": float64(1)}}); err != nil {
		t.Fatal(err)
	}
	if _, err := c.Request("getInfo", nil); err != nil {
		t.Fatal(err)
	}
	if _, err := c.Request("armDownloadWait", Params{"tabId": 9, "requirePath": true}); err == nil || !strings.Contains(err.Error(), "PATH_UNSUPPORTED") {
		t.Fatal(err)
	}
	if _, err := c.Request("armDownloadWait", Params{"tabId": 9, "requirePath": false}); err != nil {
		t.Fatal(err)
	}
}

func downloadWaitHandshake(t *testing.T, conn net.Conn) {
	t.Helper()
	r := readRequest(t, conn)
	if r["method"] != "getInfo" {
		t.Errorf("discovery: %v", r)
	}
	writeResponse(t, conn, r["id"], downloadWaitInfo())
	r = readRequest(t, conn)
	if r["method"] != "getControlState" {
		t.Errorf("control: %v", r)
	}
	writeResponse(t, conn, r["id"], testControlState(7, "next"))
}

func TestDownloadWaitSingleCollectAndOriginalScope(t *testing.T) {
	collecting, release, done := make(chan struct{}), make(chan struct{}), make(chan struct{})
	path, cleanup := startSDKServer(t, func(conn net.Conn) {
		defer close(done)
		downloadWaitHandshake(t, conn)
		for _, method := range []string{"armDownloadWait", "getControlState", "collectDownloadWait", "cancelDownloadWait"} {
			r := readRequest(t, conn)
			if r["method"] != method {
				t.Errorf("want %s got %v", method, r)
			}
			p := r["params"].(map[string]any)
			var result any = Params{}
			switch method {
			case "armDownloadWait":
				result = Params{"waiterId": "original-waiter", "remainingMs": 1000}
			case "getControlState":
				result = testControlState(8, "next-turn")
			case "collectDownloadWait":
				close(collecting)
				<-release
				result = Params{"downloadId": "native-download"}
			}
			if method == "collectDownloadWait" || method == "cancelDownloadWait" {
				if p["control_epoch"] != float64(7) || p["turn_id"] != "original-turn" || p["session_id"] != "original-session" || p["waiterId"] != "original-waiter" || p["tabId"] != float64(9) {
					t.Errorf("retargeted handle: %v", p)
				}
				if _, ok := p["timeoutMs"]; ok {
					t.Error("collect/cancel renewed wait")
				}
			}
			writeResponse(t, conn, r["id"], result)
		}
	})
	defer cleanup()
	c := NewClient(Options{SocketPath: path, SessionID: "original-session", TurnID: "original-turn"})
	defer c.Close()
	w, err := NewBrowser(c).Tab(9).Playwright.ExpectDownload(DownloadWaitOptions{Timeout: 2 * time.Second})
	if err != nil {
		t.Fatal(err)
	}
	w.WaiterID = "mutated"
	w.RemainingMS = 120000
	if _, err = c.BeginTurn(); err != nil {
		t.Fatal(err)
	}
	first := make(chan error, 1)
	go func() {
		value, e := w.Result()
		if e == nil && (value.DownloadID != "native-download") {
			e = net.ErrClosed
		}
		first <- e
	}()
	<-collecting
	if _, err = w.Result(); err == nil || !strings.Contains(err.Error(), "already") {
		t.Errorf("concurrent collect accepted: %v", err)
	}
	close(release)
	if err = <-first; err != nil {
		t.Fatal(err)
	}
	if _, err = w.Result(); err == nil {
		t.Fatal("second consumption accepted")
	}
	if err = w.Cancel(); err != nil {
		t.Fatal(err)
	}
	<-done
}

func TestDownloadWaitExpirySurvivesQueueAndStillAllowsCleanup(t *testing.T) {
	blocked, release := make(chan struct{}), make(chan struct{})
	path, cleanup := startSDKServer(t, func(conn net.Conn) {
		downloadWaitHandshake(t, conn)
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
		if r["method"] != "cancelDownloadWait" {
			t.Errorf("expired collect sent %v", r)
		}
		writeResponse(t, conn, r["id"], Params{})
	})
	defer cleanup()
	c := NewClient(Options{SocketPath: path})
	defer c.Close()
	w, err := NewBrowser(c).Tab(9).ExpectDownload()
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

func TestDownloadWaitBootstrapConsumesBudget(t *testing.T) {
	for _, raw := range []bool{false, true} {
		path, cleanup := startSDKServer(t, func(conn net.Conn) {
			r := readRequest(t, conn)
			time.Sleep(120 * time.Millisecond)
			writeResponse(t, conn, r["id"], downloadWaitInfo())
			r = readRequest(t, conn)
			writeResponse(t, conn, r["id"], testControlState(7, "next"))
			var extra any
			if wire.ReadJSON(conn, &extra) == nil {
				t.Errorf("expired arm sent: %v", extra)
			}
		})
		c := NewClient(Options{SocketPath: path})
		var err error
		if raw {
			_, err = c.Request("armDownloadWait", Params{"tabId": 9, "timeoutMs": 50})
		} else {
			_, err = NewBrowser(c).Tab(9).ExpectDownload(DownloadWaitOptions{Timeout: 50 * time.Millisecond})
		}
		if err == nil || !strings.Contains(err.Error(), "deadline") {
			t.Errorf("bootstrap renewed budget: %v", err)
		}
		c.Close()
		cleanup()
	}
}

func TestDownloadWaitDelayedAcknowledgementCannotAuthorizeTrigger(t *testing.T) {
	path, cleanup := startSDKServer(t, func(conn net.Conn) {
		downloadWaitHandshake(t, conn)
		r := readRequest(t, conn)
		// The browser could have produced this ACK in time but it arrived late.
		time.Sleep(120 * time.Millisecond)
		writeResponse(t, conn, r["id"], Params{"waiterId": "w", "remainingMs": 1})
	})
	defer cleanup()
	c := NewClient(Options{SocketPath: path})
	defer c.Close()
	w, err := NewBrowser(c).Tab(9).ExpectDownload(DownloadWaitOptions{Timeout: 50 * time.Millisecond})
	if w != nil || !errors.Is(err, os.ErrDeadlineExceeded) {
		t.Fatalf("late ACK authorized a trigger: wait=%v error=%v", w, err)
	}
}

func TestDownloadWaitValidationAndUnsupported(t *testing.T) {
	tab := NewBrowser(NewClient(Options{SocketPath: "unused"})).Tab(9)
	for _, timeout := range []time.Duration{-1, time.Microsecond, 121 * time.Second} {
		if _, err := tab.ExpectDownload(DownloadWaitOptions{Timeout: timeout}); err == nil {
			t.Error("invalid timeout accepted")
		}
	}
	if _, err := tab.ExpectDownload(DownloadWaitOptions{}, DownloadWaitOptions{}); err == nil {
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
		_, err := c.Request("armDownloadWait", p)
		if err == nil || !strings.Contains(err.Error(), "OBU_DOWNLOAD_WAIT_UNSUPPORTED") {
			t.Errorf("capability: %v", err)
		}
		c.Close()
		cleanup()
	}
}

func TestDownloadWaitStrictWireResults(t *testing.T) {
	for _, tc := range []struct {
		method string
		value  any
	}{
		{"armDownloadWait", Params{"waiterId": "w", "remainingMs": 1000}}, // exceeds actual sent budget
		{"armDownloadWait", Params{"waiterId": "", "remainingMs": 1}},
		{"armDownloadWait", Params{"waiterId": "w", "remainingMs": 0}},
		{"armDownloadWait", Params{"waiterId": "w", "remainingMs": 1, "extra": true}},
		{"collectDownloadWait", Params{"downloadId": true}},
		{"collectDownloadWait", Params{"downloadId": ""}},
		{"collectDownloadWait", Params{"downloadId": "c", "extra": true}},
		{"cancelDownloadWait", nil},
		{"cancelDownloadWait", Params{"ok": true}},
	} {
		path, cleanup := startSDKServer(t, func(conn net.Conn) {
			downloadWaitHandshake(t, conn)
			r := readRequest(t, conn)
			writeResponse(t, conn, r["id"], tc.value)
		})
		c := NewClient(Options{SocketPath: path})
		p := Params{"tabId": 9, "waiterId": "w"}
		if tc.method == "armDownloadWait" {
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

func TestDownloadWaitResultRetainsTransferScopeWithoutObserverFields(t *testing.T) {
	done := make(chan struct{})
	path, cleanup := startSDKServer(t, func(conn net.Conn) {
		defer close(done)
		downloadWaitHandshake(t, conn)
		for _, method := range []string{"armDownloadWait", "getControlState", "collectDownloadWait", "downloadPath", "cancelDownload", "cancelDownloadWait"} {
			r := readRequest(t, conn)
			if r["method"] != method {
				t.Errorf("expected %s, got %v", method, r)
			}
			p := r["params"].(map[string]any)
			switch method {
			case "armDownloadWait":
				writeResponse(t, conn, r["id"], Params{"waiterId": "w", "remainingMs": 2000})
			case "getControlState":
				writeResponse(t, conn, r["id"], testControlState(8, "new-turn"))
			case "collectDownloadWait":
				writeResponse(t, conn, r["id"], Params{"downloadId": "original-native-guid"})
			case "cancelDownloadWait":
				if p["waiterId"] != "w" || p["control_epoch"] != float64(7) {
					t.Errorf("observer cleanup retargeted: %v", p)
				}
				writeResponse(t, conn, r["id"], Params{})
			default:
				if p["downloadId"] != "original-native-guid" || p["tabId"] != float64(9) || p["control_epoch"] != float64(7) || p["session_id"] != "original" || p["turn_id"] != "old-turn" {
					t.Errorf("transfer retargeted: %v", p)
				}
				if _, ok := p["waiterId"]; ok {
					t.Errorf("waiter identity leaked to transfer: %v", p)
				}
				message := "OBU_DOWNLOAD_PATH_UNAVAILABLE"
				if method == "cancelDownload" {
					message = "OBU_DOWNLOAD_CANCEL_UNSUPPORTED"
				}
				if err := wire.WriteJSON(conn, Params{"jsonrpc": "2.0", "id": r["id"], "error": Params{"code": -32000, "message": message}}); err != nil {
					t.Error(err)
				}
			}
		}
	})
	defer cleanup()
	c := NewClient(Options{SocketPath: path, SessionID: "original", TurnID: "old-turn"})
	defer c.Close()
	w, err := NewBrowser(c).Tab(9).ExpectDownload(DownloadWaitOptions{Timeout: 3 * time.Second})
	if err != nil {
		t.Fatal(err)
	}
	if _, err = c.BeginTurn(); err != nil {
		t.Fatal(err)
	}
	d, err := w.Result()
	if err != nil {
		t.Fatal(err)
	}
	d.DownloadID = "mutated-public-field"
	if _, err = d.Path(); err == nil || !strings.Contains(err.Error(), "OBU_DOWNLOAD_PATH_UNAVAILABLE") {
		t.Fatalf("page path boundary hidden: %v", err)
	}
	if err = d.Cancel(); err == nil || !strings.Contains(err.Error(), "OBU_DOWNLOAD_CANCEL_UNSUPPORTED") {
		t.Fatalf("page transfer cancellation boundary hidden: %v", err)
	}
	if err = w.Cancel(); err != nil {
		t.Fatal(err)
	}
	<-done
}

func TestDownloadWaitCancelledObserverCannotCollect(t *testing.T) {
	path, cleanup := startSDKServer(t, func(conn net.Conn) {
		downloadWaitHandshake(t, conn)
		r := readRequest(t, conn)
		writeResponse(t, conn, r["id"], Params{"waiterId": "w", "remainingMs": 1000})
		for range 2 {
			r = readRequest(t, conn)
			if r["method"] != "cancelDownloadWait" {
				t.Errorf("observer cancellation sent transfer operation: %v", r)
			}
			writeResponse(t, conn, r["id"], Params{})
		}
	})
	defer cleanup()
	c := NewClient(Options{SocketPath: path})
	defer c.Close()
	w, err := NewBrowser(c).Tab(9).ExpectDownload()
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

func TestDownloadWaitRejectsInvalidParametersBeforeDiscovery(t *testing.T) {
	c := NewClient(Options{SocketPath: "must-not-connect"})
	defer c.Close()
	for _, tc := range []struct {
		method string
		params Params
	}{
		{"armDownloadWait", Params{"tabId": -1}},
		{"armDownloadWait", Params{"tabId": 1.5}},
		{"armDownloadWait", Params{"tabId": 1, "timeoutMs": nil}},
		{"armDownloadWait", Params{"tabId": 1, "filename": "unexpected"}},
		{"armDownloadWait", Params{"tabId": 1, "session_id": ""}},
		{"armDownloadWait", Params{"tabId": 1, "turn_id": strings.Repeat("x", 4097)}},
		{"armDownloadWait", Params{"tabId": 1, "control_epoch": 0}},
		{"collectDownloadWait", Params{"tabId": 1, "waiterId": "w", "timeoutMs": 1}},
		{"cancelDownloadWait", Params{"tabId": 1, "waiterId": ""}},
		{"cancelDownloadWait", Params{"tabId": 1, "waiterId": strings.Repeat("x", 129)}},
	} {
		if _, err := c.Request(tc.method, tc.params); err == nil || !strings.Contains(err.Error(), "invalid download wait parameters") {
			t.Errorf("%s attempted discovery for invalid params %v: %v", tc.method, tc.params, err)
		}
	}
	if _, err := NewBrowser(c).Tab(-1).ExpectDownload(); err == nil || !strings.Contains(err.Error(), "invalid download wait parameters") {
		t.Errorf("typed invalid tab attempted discovery: %v", err)
	}
}

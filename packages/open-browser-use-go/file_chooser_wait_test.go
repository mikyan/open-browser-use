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

func chooserInfo() Params {
	return Params{"metadata": Params{"turnLifecycleVersion": 1, "fileChooserWaitVersion": 1}}
}

func chooserHandshake(t *testing.T, conn net.Conn) {
	t.Helper()
	r := readRequest(t, conn)
	if r["method"] != "getInfo" {
		t.Errorf("discovery: %v", r)
	}
	writeResponse(t, conn, r["id"], chooserInfo())
	r = readRequest(t, conn)
	if r["method"] != "getControlState" {
		t.Errorf("control: %v", r)
	}
	writeResponse(t, conn, r["id"], testControlState(7, "next"))
}

func TestFileChooserWaitSingleCollectAndOriginalScope(t *testing.T) {
	collecting, release, done := make(chan struct{}), make(chan struct{}), make(chan struct{})
	path, cleanup := startSDKServer(t, func(conn net.Conn) {
		defer close(done)
		chooserHandshake(t, conn)
		for _, method := range []string{"armFileChooserWait", "getControlState", "collectFileChooserWait", "cancelFileChooserWait"} {
			r := readRequest(t, conn)
			if r["method"] != method {
				t.Errorf("want %s got %v", method, r)
			}
			p := r["params"].(map[string]any)
			var result any = Params{}
			switch method {
			case "armFileChooserWait":
				result = Params{"waiterId": "original-waiter", "remainingMs": 1000}
			case "getControlState":
				result = testControlState(8, "next-turn")
			case "collectFileChooserWait":
				close(collecting)
				<-release
				result = Params{"fileChooserId": "native-chooser", "isMultiple": true}
			}
			if method == "collectFileChooserWait" || method == "cancelFileChooserWait" {
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
	w, err := NewBrowser(c).Tab(9).Playwright.ExpectFileChooser(FileChooserWaitOptions{Timeout: 2 * time.Second})
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
		if e == nil && (value.FileChooserID != "native-chooser" || !value.IsMultiple) {
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

func TestFileChooserWaitExpirySurvivesQueueAndStillAllowsCleanup(t *testing.T) {
	blocked, release := make(chan struct{}), make(chan struct{})
	path, cleanup := startSDKServer(t, func(conn net.Conn) {
		chooserHandshake(t, conn)
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
		if r["method"] != "cancelFileChooserWait" {
			t.Errorf("expired collect sent %v", r)
		}
		writeResponse(t, conn, r["id"], Params{})
	})
	defer cleanup()
	c := NewClient(Options{SocketPath: path})
	defer c.Close()
	w, err := NewBrowser(c).Tab(9).ExpectFileChooser()
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

func TestFileChooserWaitBootstrapConsumesBudget(t *testing.T) {
	for _, raw := range []bool{false, true} {
		path, cleanup := startSDKServer(t, func(conn net.Conn) {
			r := readRequest(t, conn)
			time.Sleep(120 * time.Millisecond)
			writeResponse(t, conn, r["id"], chooserInfo())
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
			_, err = c.Request("armFileChooserWait", Params{"tabId": 9, "timeoutMs": 50})
		} else {
			_, err = NewBrowser(c).Tab(9).ExpectFileChooser(FileChooserWaitOptions{Timeout: 50 * time.Millisecond})
		}
		if err == nil || !strings.Contains(err.Error(), "deadline") {
			t.Errorf("bootstrap renewed budget: %v", err)
		}
		c.Close()
		cleanup()
	}
}

func TestFileChooserWaitDelayedAcknowledgementCannotAuthorizeTrigger(t *testing.T) {
	path, cleanup := startSDKServer(t, func(conn net.Conn) {
		chooserHandshake(t, conn)
		r := readRequest(t, conn)
		// The browser could have produced this ACK in time but it arrived late.
		time.Sleep(120 * time.Millisecond)
		writeResponse(t, conn, r["id"], Params{"waiterId": "w", "remainingMs": 1})
	})
	defer cleanup()
	c := NewClient(Options{SocketPath: path})
	defer c.Close()
	w, err := NewBrowser(c).Tab(9).ExpectFileChooser(FileChooserWaitOptions{Timeout: 50 * time.Millisecond})
	if w != nil || !errors.Is(err, os.ErrDeadlineExceeded) {
		t.Fatalf("late ACK authorized a trigger: wait=%v error=%v", w, err)
	}
}

func TestFileChooserWaitValidationAndUnsupported(t *testing.T) {
	tab := NewBrowser(NewClient(Options{SocketPath: "unused"})).Tab(9)
	for _, timeout := range []time.Duration{-1, time.Microsecond, 121 * time.Second} {
		if _, err := tab.ExpectFileChooser(FileChooserWaitOptions{Timeout: timeout}); err == nil {
			t.Error("invalid timeout accepted")
		}
	}
	if _, err := tab.ExpectFileChooser(FileChooserWaitOptions{}, FileChooserWaitOptions{}); err == nil {
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
		_, err := c.Request("armFileChooserWait", p)
		if err == nil || !strings.Contains(err.Error(), "OBU_FILE_CHOOSER_WAIT_UNSUPPORTED") {
			t.Errorf("capability: %v", err)
		}
		c.Close()
		cleanup()
	}
}

func TestFileChooserWaitStrictWireResults(t *testing.T) {
	for _, tc := range []struct {
		method string
		value  any
	}{
		{"armFileChooserWait", Params{"waiterId": "w", "remainingMs": 1000}}, // exceeds actual sent budget
		{"armFileChooserWait", Params{"waiterId": "", "remainingMs": 1}},
		{"armFileChooserWait", Params{"waiterId": "w", "remainingMs": 0}},
		{"armFileChooserWait", Params{"waiterId": "w", "remainingMs": 1, "extra": true}},
		{"collectFileChooserWait", Params{"fileChooserId": "c", "isMultiple": "true"}},
		{"collectFileChooserWait", Params{"fileChooserId": "", "isMultiple": false}},
		{"collectFileChooserWait", Params{"fileChooserId": "c", "isMultiple": false, "extra": true}},
		{"cancelFileChooserWait", nil},
		{"cancelFileChooserWait", Params{"ok": true}},
	} {
		path, cleanup := startSDKServer(t, func(conn net.Conn) {
			chooserHandshake(t, conn)
			r := readRequest(t, conn)
			writeResponse(t, conn, r["id"], tc.value)
		})
		c := NewClient(Options{SocketPath: path})
		p := Params{"tabId": 9, "waiterId": "w"}
		if tc.method == "armFileChooserWait" {
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

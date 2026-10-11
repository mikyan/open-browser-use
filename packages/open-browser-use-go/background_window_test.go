package obu

import (
	"fmt"
	"net"
	"reflect"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/ifuryst/open-browser-use/internal/wire"
)

type backgroundWindowFixture struct {
	mu         sync.Mutex
	calls      []map[string]any
	version    any
	delay      time.Duration
	failCreate bool
}

func (f *backgroundWindowFixture) client(t *testing.T) *Client {
	t.Helper()
	path, cleanup := startSDKServer(t, func(conn net.Conn) {
		_ = conn.SetDeadline(time.Now().Add(5 * time.Second))
		for {
			call := readRequest(t, conn)
			if call == nil {
				return
			}
			f.mu.Lock()
			f.calls = append(f.calls, call)
			version, delay, failCreate := f.version, f.delay, f.failCreate
			f.mu.Unlock()
			var result any = Params{}
			switch call["method"] {
			case "getInfo":
				time.Sleep(delay)
				result = Params{"metadata": Params{"turnLifecycleVersion": 1, "backgroundWindowVersion": version}}
			case "getControlState":
				result = Params{"lifecycleVersion": 1, "controlEpoch": 7, "nextTurnId": "next", "closing": false}
			case "createTab":
				result = Params{"id": 12}
			case "browserAction":
				result = Params{"value": nil, "engine": Params{"name": "playwright-crx", "version": "0.15.0", "playwrightVersion": "1.53.0"}}
			}
			response := Params{"jsonrpc": "2.0", "id": call["id"], "result": result}
			if failCreate && call["method"] == "createTab" {
				delete(response, "result")
				response["error"] = Params{"code": -32000, "message": "creation failed"}
			}
			if wire.WriteJSON(conn, response) != nil {
				return
			}
		}
	})
	t.Cleanup(cleanup)
	c := NewClient(Options{SocketPath: path, SessionID: "background-test", TurnID: "initial", Timeout: time.Second})
	t.Cleanup(func() { _ = c.Close() })
	return c
}

func (f *backgroundWindowFixture) snapshot() []map[string]any {
	f.mu.Lock()
	defer f.mu.Unlock()
	return append([]map[string]any(nil), f.calls...)
}

func TestBackgroundWindowLegacyCreationPreservesWire(t *testing.T) {
	f := &backgroundWindowFixture{version: 1}
	c := f.client(t)
	if _, err := c.CreateTab(); err != nil {
		t.Fatal(err)
	}
	if _, err := c.CreateTabWithOptions(CreateTabOptions{}); err != nil {
		t.Fatal(err)
	}
	if _, err := NewBrowser(c).NewTab(); err != nil {
		t.Fatal(err)
	}
	if _, err := NewBrowser(c).NewTabWithOptions(NewTabOptions{}); err != nil {
		t.Fatal(err)
	}
	methods := []any{}
	for _, call := range f.snapshot() {
		methods = append(methods, call["method"])
		if call["method"] == "createTab" {
			params := call["params"].(map[string]any)
			if _, exists := params["backgroundWindow"]; exists {
				t.Fatalf("default changed wire: %#v", params)
			}
			if params["turn_id"] != "initial" || params["control_epoch"] != float64(7) {
				t.Fatalf("scope changed: %#v", params)
			}
		}
	}
	if !reflect.DeepEqual(methods, []any{"getInfo", "getControlState", "createTab", "createTab", "createTab", "createTab"}) {
		t.Fatalf("calls: %v", methods)
	}
}

func TestBackgroundWindowTrueUsesFreshCapabilityAndOriginalNavigationScope(t *testing.T) {
	f := &backgroundWindowFixture{version: 1}
	c := f.client(t)
	if _, err := c.CreateTabWithOptions(CreateTabOptions{BackgroundWindow: true}); err != nil {
		t.Fatal(err)
	}
	if _, err := NewBrowser(c).NewTabWithOptions(NewTabOptions{URL: "https://fixture.test", BackgroundWindow: true}); err != nil {
		t.Fatal(err)
	}
	f.mu.Lock()
	f.version = nil
	f.mu.Unlock()
	if _, err := c.CreateTabWithOptions(CreateTabOptions{BackgroundWindow: true}); err == nil || !strings.Contains(err.Error(), "OBU_BACKGROUND_WINDOW_UNSUPPORTED") {
		t.Fatalf("downgrade: %v", err)
	}
	methods := []any{}
	for _, call := range f.snapshot() {
		methods = append(methods, call["method"])
		params := call["params"].(map[string]any)
		if call["method"] == "createTab" || call["method"] == "browserAction" {
			if params["turn_id"] != "initial" || params["control_epoch"] != float64(7) {
				t.Fatalf("scope: %#v", params)
			}
			if call["method"] == "createTab" && params["backgroundWindow"] != true {
				t.Fatalf("missing flag: %#v", params)
			}
			if call["method"] == "browserAction" {
				if _, ok := params["backgroundWindow"]; ok {
					t.Fatal("creation option leaked to navigation")
				}
			}
		}
	}
	if !reflect.DeepEqual(methods, []any{"getInfo", "getControlState", "getInfo", "createTab", "getInfo", "createTab", "browserAction", "getInfo"}) {
		t.Fatalf("calls: %v", methods)
	}
}

func TestBackgroundWindowBadCapabilityWithExplicitScope(t *testing.T) {
	for _, version := range []any{nil, 0, 2, true, "1", Params{}} {
		t.Run(fmt.Sprint(version), func(t *testing.T) {
			f := &backgroundWindowFixture{version: version}
			c := f.client(t)
			_, err := c.Request("createTab", Params{"backgroundWindow": true, "control_epoch": 7})
			if err == nil || !strings.Contains(err.Error(), "OBU_BACKGROUND_WINDOW_UNSUPPORTED") {
				t.Fatalf("got %v", err)
			}
			calls := f.snapshot()
			if len(calls) != 1 || calls[0]["method"] != "getInfo" {
				t.Fatalf("unexpected calls %#v", calls)
			}
		})
	}
}

func TestBackgroundWindowInvalidRawParamsDoNotConnect(t *testing.T) {
	c := NewClient(Options{SocketPath: "unused"})
	for _, value := range []any{nil, 0, 1, "true", []any{}, Params{}} {
		if _, err := c.Request("createTab", Params{"backgroundWindow": value}); err == nil || !strings.Contains(err.Error(), "must be a boolean") {
			t.Fatalf("%#v: %v", value, err)
		}
	}
}

func TestBackgroundWindowCapabilityUsesOriginalDeadline(t *testing.T) {
	f := &backgroundWindowFixture{version: 1, delay: 80 * time.Millisecond}
	c := f.client(t)
	_, err := c.requestWithTimeout("createTab", Params{"backgroundWindow": true, "control_epoch": 7}, 20*time.Millisecond)
	if err == nil {
		t.Fatal("held capability exceeded original deadline")
	}
	_ = c.Close()
	time.Sleep(100 * time.Millisecond)
	calls := f.snapshot()
	if len(calls) != 1 || calls[0]["method"] != "getInfo" {
		t.Fatalf("late capability created tab: %#v", calls)
	}
}

func TestBackgroundWindowCreationErrorDoesNotReplayOrNavigate(t *testing.T) {
	f := &backgroundWindowFixture{version: 1, failCreate: true}
	c := f.client(t)
	_, err := NewBrowser(c).NewTabWithOptions(NewTabOptions{URL: "https://fixture.test", BackgroundWindow: true})
	if err == nil || !strings.Contains(err.Error(), "creation failed") {
		t.Fatalf("got %v", err)
	}
	created := 0
	for _, call := range f.snapshot() {
		if call["method"] == "createTab" {
			created++
		}
		if call["method"] == "browserAction" {
			t.Fatal("navigated after failed creation")
		}
	}
	if created != 1 {
		t.Fatalf("create count %d", created)
	}
}

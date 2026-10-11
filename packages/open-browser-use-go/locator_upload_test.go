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

type uploadFixture struct {
	mu         sync.Mutex
	calls      []Params
	version    any
	delay      time.Duration
	failUpload bool
}

func (f *uploadFixture) client(t *testing.T) *Client {
	t.Helper()
	path, cleanup := startSDKServer(t, func(conn net.Conn) {
		_ = conn.SetDeadline(time.Now().Add(3 * time.Second))
		for {
			call := readRequest(t, conn)
			if call == nil {
				return
			}
			f.mu.Lock()
			f.calls = append(f.calls, call)
			f.mu.Unlock()
			params := call["params"].(map[string]any)
			var result any
			switch call["method"] {
			case "getInfo":
				result = Params{"metadata": Params{"turnLifecycleVersion": 1}}
			case "getControlState":
				result = Params{"lifecycleVersion": 1, "controlEpoch": 7, "nextTurnId": "next", "closing": false}
			case "browserAction":
				if params["action"] == "engineInfo" {
					time.Sleep(f.delay)
				}
				result = Params{"value": nil, "engine": Params{"name": "playwright-crx", "version": "1", "playwrightVersion": "1", "capabilities": Params{"locatorFileUpload": f.version}}}
			}
			response := Params{"id": call["id"], "result": result}
			if params["action"] == "setInputFiles" && f.failUpload {
				delete(response, "result")
				response["error"] = Params{"message": "original upload failure", "code": -32000}
			}
			if wire.WriteJSON(conn, response) != nil {
				return
			}
		}
	})
	t.Cleanup(cleanup)
	c := NewClient(Options{SocketPath: path, SessionID: "upload-test", TurnID: "initial", Timeout: 2 * time.Second})
	t.Cleanup(func() { _ = c.Close() })
	return c
}
func (f *uploadFixture) snapshot() []Params {
	f.mu.Lock()
	defer f.mu.Unlock()
	return append([]Params(nil), f.calls...)
}

func TestLocatorUploadFrameRefClearAndOriginalScope(t *testing.T) {
	f := &uploadFixture{version: 1}
	c := f.client(t)
	tab := NewBrowser(c).Tab(12)
	files := []string{"/tmp/中文.txt", `C:\folder\file.bin`, `\\server\share\directory`}
	if err := tab.FrameLocator("iframe").GetByLabel("Files").SetInputFiles(files, BrowserActionOptions{Timeout: 500 * time.Millisecond}); err != nil {
		t.Fatal(err)
	}
	if err := tab.GetByRef("capture-1", "e1").SetInputFiles(nil); err != nil {
		t.Fatal(err)
	}
	actions := []Params{}
	for _, call := range f.snapshot() {
		if call["method"] == "browserAction" {
			actions = append(actions, call["params"].(map[string]any))
		}
	}
	if len(actions) != 4 {
		t.Fatalf("actions %#v", actions)
	}
	for i, p := range actions {
		expected := "engineInfo"
		if i%2 == 1 {
			expected = "setInputFiles"
		}
		if p["action"] != expected || p["tabId"] != float64(12) || p["turn_id"] != "initial" || p["control_epoch"] != float64(7) {
			t.Fatalf("scope/action %#v", p)
		}
		if i%2 == 0 {
			if _, ok := p["locator"]; ok {
				t.Fatal("preflight locator leaked")
			}
		}
	}
	got := actions[1]["args"].(map[string]any)["files"]
	if !reflect.DeepEqual(got, []any{files[0], files[1], files[2]}) {
		t.Fatalf("files %#v", got)
	}
	if !reflect.DeepEqual(actions[3]["args"], map[string]any{"files": []any{}}) {
		t.Fatalf("nil not cleared %#v", actions[3])
	}
	want := []any{map[string]any{"kind": "frame", "selector": "iframe"}, map[string]any{"kind": "label", "value": "Files"}}
	if !reflect.DeepEqual(actions[1]["locator"], want) {
		t.Fatalf("chain %#v", actions[1]["locator"])
	}
}

func TestLocatorUploadInvalidBeforeIPC(t *testing.T) {
	c := NewClient(Options{SocketPath: "unused"})
	locator := NewBrowser(c).Tab(12).Locator("input")
	oversized := make([]string, 1025)
	for i := range oversized {
		oversized[i] = "/a"
	}
	total := make([]string, 65)
	for i := range total {
		total[i] = "/" + strings.Repeat("a", 131071)
	}
	for _, files := range [][]string{{""}, {"relative"}, {"C:relative"}, {`\rooted`}, {`\\server`}, {"/a\x00b"}, {"/\xff"}, {"/" + strings.Repeat("界", 43691)}, oversized, total} {
		if err := locator.SetInputFiles(files); err == nil {
			t.Fatal("invalid files accepted")
		}
	}
	for _, files := range []any{nil, "/a", []any{1}, []string{"/\xff"}} {
		_, err := c.Request("browserAction", Params{"tabId": 12, "action": "setInputFiles", "args": Params{"files": files}})
		if err == nil || strings.Contains(err.Error(), "connect") {
			t.Fatalf("prewire validation: %v", err)
		}
	}
	if err := locator.SetInputFiles([]string{}, BrowserActionOptions{Args: Params{"force": true}}); err == nil {
		t.Fatal("unknown args accepted")
	}
	if c.conn != nil {
		t.Fatal("invalid request connected")
	}
}

func TestLocatorUploadUnsupportedBeforeSetter(t *testing.T) {
	for _, version := range []any{nil, 0, 2, true, "1"} {
		t.Run(fmt.Sprint(version), func(t *testing.T) {
			f := &uploadFixture{version: version}
			c := f.client(t)
			_, err := c.Request("browserAction", Params{"control_epoch": 7, "tabId": 12, "action": "setInputFiles", "args": Params{"files": []string{}}})
			if err == nil || !strings.Contains(err.Error(), "OBU_LOCATOR_FILE_UPLOAD_UNSUPPORTED") {
				t.Fatalf("got %v", err)
			}
			calls := f.snapshot()
			if len(calls) != 1 || calls[0]["params"].(map[string]any)["action"] != "engineInfo" {
				t.Fatalf("calls %#v", calls)
			}
		})
	}
}

func TestLocatorUploadCapabilityConsumesOriginalDeadline(t *testing.T) {
	f := &uploadFixture{version: 1, delay: 60 * time.Millisecond}
	c := f.client(t)
	err := NewBrowser(c).Tab(12).Locator("input").SetInputFiles([]string{"/tmp/a"}, BrowserActionOptions{Timeout: 20 * time.Millisecond})
	if err == nil {
		t.Fatal("expected original deadline")
	}
	for _, call := range f.snapshot() {
		if call["params"].(map[string]any)["action"] == "setInputFiles" {
			t.Fatal("late setter was sent")
		}
	}
}

func TestLocatorUploadNativeFailureNeverReplays(t *testing.T) {
	f := &uploadFixture{version: 1, failUpload: true}
	c := f.client(t)
	err := NewBrowser(c).Tab(12).Locator("input").SetInputFiles([]string{"/tmp/a"})
	if err == nil || !strings.Contains(err.Error(), "original upload failure") {
		t.Fatalf("got %v", err)
	}
	count := 0
	for _, call := range f.snapshot() {
		if call["params"].(map[string]any)["action"] == "setInputFiles" {
			count++
		}
	}
	if count != 1 {
		t.Fatalf("setter count %d", count)
	}
}

func TestLocatorUploadQueuedDeadlineDoesNotSendPreflightOrSetter(t *testing.T) {
	entered, release := make(chan struct{}), make(chan struct{})
	path, cleanup := startSDKServer(t, func(conn net.Conn) {
		request := readRequest(t, conn)
		if request == nil {
			return
		}
		if request["method"] != "ping" {
			t.Errorf("unexpected first request %#v", request)
		}
		close(entered)
		<-release
		if wire.WriteJSON(conn, Params{"id": request["id"], "result": Params{}}) != nil {
			return
		}
		_ = conn.SetReadDeadline(time.Now().Add(100 * time.Millisecond))
		var next map[string]any
		if wire.ReadJSON(conn, &next) == nil {
			t.Errorf("queued expired work reached transport %#v", next)
		}
	})
	defer cleanup()
	c := NewClient(Options{SocketPath: path, Timeout: 3 * time.Second})
	defer c.Close()
	first := make(chan error, 1)
	go func() { _, err := c.Request("ping", nil); first <- err }()
	<-entered
	err := NewBrowser(c).Tab(12).Locator("input").SetInputFiles([]string{"/tmp/a"}, BrowserActionOptions{Timeout: 20 * time.Millisecond})
	// The shared request gate includes the one-second response allowance, but it
	// never starts a browser action after the original action deadline.
	close(release)
	if err == nil {
		t.Fatal("queued upload unexpectedly succeeded")
	}
	if firstErr := <-first; firstErr != nil {
		t.Fatal(firstErr)
	}
}

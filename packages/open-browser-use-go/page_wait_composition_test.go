package obu

import (
	"net"
	"strings"
	"testing"
	"time"

	"github.com/ifuryst/open-browser-use/internal/wire"
)

// Exercise the public typed APIs through their actual JSON transport. In
// particular, never replace the Tab returned by PageWait.Result with Browser.Tab.
func TestCreatedPageDownloadKeepsOriginalScopeThroughPath(t *testing.T) {
	const epoch = 9007199254740991 // Largest exactly representable protocol epoch.
	path, cleanup := createdPageCompositionServer(t, epoch, []string{
		"cancelPageWait", "armDownloadWait", "browserAction", "collectDownloadWait",
		"downloadPath", "cancelDownloadWait", "getControlState",
	})
	defer cleanup()
	c := NewClient(Options{SocketPath: path, SessionID: "task", TurnID: "initial"})
	defer c.Close()
	pageWait, err := NewBrowser(c).Tab(9).ExpectPage()
	if err != nil {
		t.Fatal(err)
	}
	child, err := pageWait.Result()
	if err != nil {
		t.Fatal(err)
	}
	if err := pageWait.Cancel(); err != nil {
		t.Fatal(err)
	}
	wait, err := child.ExpectDownload(DownloadWaitOptions{RequirePath: true})
	if err != nil {
		t.Fatal(err)
	}
	if err := child.Locator("#download").Click(); err != nil {
		t.Fatal(err)
	}
	download, err := wait.Result()
	if err != nil {
		t.Fatal(err)
	}
	if got, err := download.Path(); err != nil || got != `C:\Downloads\original.json` {
		t.Fatalf("original download path: %q, %v", got, err)
	}
	if err := wait.Cancel(); err != nil {
		t.Fatal(err)
	}
	if _, err := c.BeginTurn(); err != nil {
		t.Fatal(err)
	}
	for _, action := range []func() error{
		func() error { _, err := child.ExpectDownload(); return err },
		func() error { _, err := download.Path(); return err },
		func() error { return child.Locator("#download").Click() },
	} {
		if err := action(); err == nil || !strings.Contains(err.Error(), "OBU_STALE_CONTROL_EPOCH") {
			t.Fatalf("old child authority survived BeginTurn: %v", err)
		}
	}
}

func TestCreatedPageOtherTypedHandlesKeepOriginalScope(t *testing.T) {
	for _, tc := range []struct {
		name    string
		methods []string
		run     func(*Tab) error
	}{
		{"download", []string{"waitForDownload", "downloadPath"}, func(child *Tab) error {
			download, err := child.WaitForDownload()
			if err != nil {
				return err
			}
			_, err = download.Path()
			return err
		}},
		{"file-chooser", []string{"armFileChooserWait", "cancelFileChooserWait"}, func(child *Tab) error {
			wait, err := child.ExpectFileChooser()
			if err != nil {
				return err
			}
			return wait.Cancel()
		}},
		{"navigation", []string{"armNavigationWait", "cancelNavigationWait"}, func(child *Tab) error {
			wait, err := child.ExpectLoadState()
			if err != nil {
				return err
			}
			return wait.Cancel()
		}},
		{"network", []string{"armNetworkWait", "cancelNetworkWait"}, func(child *Tab) error {
			wait, err := child.ExpectRequest(NetworkWaitMatch{URL: "https://fixture.test/file"})
			if err != nil {
				return err
			}
			return wait.Cancel()
		}},
	} {
		t.Run(tc.name, func(t *testing.T) {
			path, cleanup := createdPageCompositionServer(t, 7, tc.methods)
			defer cleanup()
			c := NewClient(Options{SocketPath: path, SessionID: "task", TurnID: "initial"})
			defer c.Close()
			wait, err := NewBrowser(c).Tab(9).ExpectPage()
			if err != nil {
				t.Fatal(err)
			}
			child, err := wait.Result()
			if err != nil {
				t.Fatal(err)
			}
			if err := tc.run(child); err != nil {
				t.Fatal(err)
			}
		})
	}
}

func createdPageCompositionServer(t *testing.T, epoch int, methods []string) (string, func()) {
	t.Helper()
	return startSDKServer(t, func(conn net.Conn) {
		methods = append([]string{"getInfo", "getControlState", "armPageWait", "collectPageWait"}, methods...)
		for index, method := range methods {
			r := readRequest(t, conn)
			if r == nil { // The client reports its original error and closes on failure.
				return
			}
			if r["method"] != method {
				t.Errorf("want %s, got %v", method, r)
				return
			}
			p := r["params"].(map[string]any)
			if p["session_id"] != "task" || p["turn_id"] != "initial" {
				t.Errorf("scope changed: %v", p)
			}
			if index >= 2 && method != "getControlState" {
				if p["control_epoch"] != float64(epoch) {
					t.Errorf("epoch changed: %v", p)
				}
				expectedTab := float64(12)
				if strings.Contains(method, "PageWait") {
					expectedTab = 9
				}
				// The legacy transfer handle carries its download ID, not a tab ID.
				if method != "downloadPath" && p["tabId"] != expectedTab {
					t.Errorf("tab changed: %v", p)
				}
			}
			var result any = Params{}
			switch method {
			case "getInfo":
				result = Params{"metadata": Params{"turnLifecycleVersion": 1, "pageWaitVersion": 1,
					"downloadWaitVersion": 1, "downloadWaitPathVersion": 1, "directDownloadsVersion": 1,
					"fileChooserWaitVersion": 1, "navigationWaitVersion": 1, "networkWaitVersion": 1}}
			case "getControlState":
				// A new generation invalidates the child even when epoch/turn are equal.
				result = testControlState(epoch, "initial")
			case "armPageWait", "armDownloadWait", "armFileChooserWait", "armNavigationWait", "armNetworkWait":
				if method == "armDownloadWait" && p["requirePath"] != true {
					t.Errorf("path readiness was dropped: %v", p)
				}
				result = Params{"waiterId": method, "remainingMs": 5000}
			case "collectPageWait":
				result = Params{"tabId": 12}
			case "browserAction":
				if p["action"] != "click" {
					t.Errorf("unexpected trigger: %v", p)
				}
				result = Params{"value": nil, "engine": Params{"name": "playwright-crx", "version": "0.15.0", "playwrightVersion": "1.53.0"}}
			case "collectDownloadWait", "waitForDownload":
				result = Params{"downloadId": "original-guid"}
			case "downloadPath":
				if p["downloadId"] != "original-guid" || p["waiterId"] != nil {
					t.Errorf("observer identity leaked into transfer: %v", p)
				}
				result = Params{"path": `C:\Downloads\original.json`}
			}
			writeResponse(t, conn, r["id"], result)
		}
		_ = conn.SetReadDeadline(time.Now().Add(time.Second))
		var extra any
		if wire.ReadJSON(conn, &extra) == nil {
			t.Errorf("unexpected discovery, replay or stale request: %v", extra)
		}
	})
}

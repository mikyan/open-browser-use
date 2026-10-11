package obu

import (
	"encoding/json"
	"errors"
	"net"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/ifuryst/open-browser-use/internal/host"
	"github.com/ifuryst/open-browser-use/internal/transport"
	"github.com/ifuryst/open-browser-use/internal/wire"
)

// These servers use the real platform transport (named pipes on Windows), not
// net.Pipe or a substituted dialer. They intentionally accept identical numeric
// epochs and tab IDs: an independent server rejection must not hide a reconnect.
type identityServer struct {
	name     string
	listener net.Listener
	mu       sync.Mutex
	closed   bool
	conns    []net.Conn
	requests []Params
	wg       sync.WaitGroup
	stopOnce sync.Once
	hook     func(net.Conn, Params) bool
}

func identityEndpoint(t *testing.T) (string, string) {
	t.Helper()
	dir, err := os.MkdirTemp(socketTestTempRoot(), "obu-identity-")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = os.RemoveAll(dir) })
	return transport.NewEndpoint(dir, filepath.Base(dir)), dir
}

func startIdentityServer(t *testing.T, path, name string, hook func(net.Conn, Params) bool) *identityServer {
	t.Helper()
	listener, err := transport.Listen(path)
	if err != nil {
		t.Fatal(err)
	}
	s := &identityServer{name: name, listener: listener, hook: hook}
	s.wg.Add(1)
	go func() {
		defer s.wg.Done()
		for {
			conn, err := listener.Accept()
			if err != nil {
				return
			}
			s.mu.Lock()
			if s.closed {
				s.mu.Unlock()
				_ = conn.Close()
				return
			}
			s.conns = append(s.conns, conn)
			s.wg.Add(1)
			s.mu.Unlock()
			go s.serve(conn)
		}
	}()
	t.Cleanup(s.stop)
	return s
}

func (s *identityServer) serve(conn net.Conn) {
	defer s.wg.Done()
	defer conn.Close()
	for {
		var request Params
		if err := wire.ReadJSON(conn, &request); err != nil {
			return
		}
		s.mu.Lock()
		s.requests = append(s.requests, request)
		s.mu.Unlock()
		if s.hook != nil && s.hook(conn, request) {
			return
		}
		if request["method"] == "unacknowledgedAction" {
			return // The request arrived; its outcome is deliberately unknown.
		}
		result := any(Params{})
		switch request["method"] {
		case "getInfo":
			result = Params{"browser": s.name, "metadata": Params{
				"turnLifecycleVersion": 1, "networkWaitVersion": 1,
				"navigationWaitVersion": 1, "downloadWaitVersion": 1,
				"fileChooserWaitVersion": 1, "directDownloadsVersion": 1,
			}}
		case "getControlState":
			result = Params{"lifecycleVersion": 1, "controlEpoch": 1, "nextTurnId": "same-turn"}
		case "createTab":
			result = Params{"id": 7}
		case "getTabs":
			result = Params{"browser": s.name}
		case "browserAction":
			result = Params{"value": nil, "engine": Params{"name": "playwright-crx", "version": "0.15.0", "playwrightVersion": "1.53.0"}}
		case "armNetworkWait", "armNavigationWait", "armDownloadWait", "armFileChooserWait":
			result = Params{"waiterId": "same-wait", "remainingMs": 2000}
		case "downloadURL":
			result = Params{"downloadId": "same-download"}
		case "downloadPath":
			result = Params{"path": "test-download"}
		case "cancelDownload":
			result = Params{"cancelled": true}
		}
		response := Params{"jsonrpc": "2.0", "id": request["id"], "result": result}
		if request["method"] == "businessFailure" {
			response = Params{"jsonrpc": "2.0", "id": request["id"], "error": Params{"message": "OBU_CONTROL_STALE: test business rejection"}}
		}
		if err := wire.WriteJSON(conn, response); err != nil {
			return
		}
	}
}

func (s *identityServer) stop() {
	s.stopOnce.Do(func() {
		s.mu.Lock()
		s.closed = true
		_ = s.listener.Close()
		for _, conn := range s.conns {
			_ = conn.Close()
		}
		s.mu.Unlock()
		s.wg.Wait()
	})
}

func (s *identityServer) snapshot() ([]Params, int) {
	s.mu.Lock()
	defer s.mu.Unlock()
	return append([]Params(nil), s.requests...), len(s.conns)
}

func logIdentityRequests(t *testing.T, s *identityServer) {
	t.Helper()
	requests, connections := s.snapshot()
	encoded, err := json.Marshal(Params{"endpoint": s.name, "connections": connections, "requests": requests})
	if err != nil {
		t.Fatal(err)
	}
	t.Log(string(encoded))
}

func requireIdentityDisconnected(t *testing.T, operation string, err error) {
	t.Helper()
	if err == nil || !strings.Contains(err.Error(), "OBU_SDK_BROWSER_DISCONNECTED") || !strings.Contains(err.Error(), "new client") {
		t.Errorf("%s must require a new client, got %v", operation, err)
	}
}

func identityClient(t *testing.T, options Options) *Client {
	t.Helper()
	options.SessionID, options.TurnID, options.Timeout = "same-session", "same-turn", 2*time.Second
	c := NewClient(options)
	t.Cleanup(func() { _ = c.Close() })
	return c
}

func TestClientConnectionIdentityActiveSwitchNativeTransport(t *testing.T) {
	pathA, dir := identityEndpoint(t)
	pathB, _ := identityEndpoint(t)
	a := startIdentityServer(t, pathA, "A", nil)
	b := startIdentityServer(t, pathB, "B", nil)
	if err := host.WriteActiveSocketRecord(dir, pathA); err != nil {
		t.Fatal(err)
	}
	c := identityClient(t, Options{SocketDir: dir})
	tab, err := NewBrowser(c).NewTab()
	if err != nil {
		t.Fatal(err)
	}
	locator := tab.Locator("#original")
	network, err := tab.ExpectRequest(NetworkWaitMatch{URL: "https://test.invalid/"})
	if err != nil {
		t.Fatal(err)
	}
	navigation, err := tab.ExpectLoadState()
	if err != nil {
		t.Fatal(err)
	}
	downloadWait, err := tab.ExpectDownload()
	if err != nil {
		t.Fatal(err)
	}
	chooser, err := tab.ExpectFileChooser()
	if err != nil {
		t.Fatal(err)
	}
	download, err := tab.DownloadURL("https://test.invalid/file")
	if err != nil {
		t.Fatal(err)
	}
	if err := host.WriteActiveSocketRecord(dir, pathB); err != nil {
		t.Fatal(err)
	}
	// An active-record change alone must not disturb the original live connection.
	if value, err := c.GetTabs(); err != nil || value.(map[string]any)["browser"] != "A" {
		t.Fatalf("healthy client migrated: value=%v error=%v", value, err)
	}
	if _, err := c.Request("unacknowledgedAction", Params{"marker": "one-send"}); err == nil || strings.Contains(err.Error(), "OBU_SDK_BROWSER_DISCONNECTED") {
		t.Fatalf("first lost response must retain its original transport error: %v", err)
	}
	calls := []struct {
		name string
		call func() error
	}{
		{"client", func() error { _, err := c.GetTabs(); return err }},
		{"tab", func() error { _, err := tab.Goto("https://test.invalid/next"); return err }},
		{"locator", func() error { return locator.Click() }},
		{"network result", func() error { _, err := network.Result(); return err }},
		{"network cancel", func() error { return network.Cancel() }},
		{"navigation result", func() error { return navigation.Result() }},
		{"download wait result", func() error { _, err := downloadWait.Result(); return err }},
		{"download wait cancel", downloadWait.Cancel},
		{"file chooser result", func() error { _, err := chooser.Result(); return err }},
		{"file chooser cancel", chooser.Cancel},
		{"download path", func() error { _, err := download.Path(); return err }},
		{"download cancel", func() error { return download.Cancel() }},
		{"manual epoch", func() error {
			_, err := c.Request("browserAction", Params{"tabId": 7, "action": "click", "control_epoch": 1})
			return err
		}},
		{"BeginTurn", func() error { _, err := c.BeginTurn(); return err }},
		{"Connect", c.Connect},
	}
	for _, call := range calls {
		requireIdentityDisconnected(t, call.name, call.call())
	}
	logIdentityRequests(t, a)
	logIdentityRequests(t, b)
	if requests, connections := b.snapshot(); len(requests) != 0 || connections != 0 {
		t.Errorf("old client opened B: connections=%d requests=%v", connections, requests)
	}
	requests, _ := a.snapshot()
	unknown := 0
	for _, request := range requests {
		if request["method"] == "unacknowledgedAction" {
			unknown++
		}
	}
	if unknown != 1 {
		t.Fatalf("unknown operation was sent %d times", unknown)
	}
	// Explicit recovery is a new instance even when the caller chooses equal IDs.
	fresh := identityClient(t, Options{SocketDir: dir})
	if _, err := NewBrowser(fresh).NewTab(); err != nil {
		t.Fatalf("new client could not use selected browser B: %v", err)
	}
	requests, _ = b.snapshot()
	if len(requests) < 3 || requests[len(requests)-3]["method"] != "getInfo" || requests[len(requests)-2]["method"] != "getControlState" || requests[len(requests)-1]["method"] != "createTab" {
		t.Fatalf("new client did not negotiate B: %v", requests)
	}
}

func TestClientConnectionIdentitySamePathReplacementNativeTransport(t *testing.T) {
	for _, reason := range []string{"EOF", "Close"} {
		t.Run(reason, func(t *testing.T) {
			path, _ := identityEndpoint(t)
			a := startIdentityServer(t, path, "A", nil)
			c := identityClient(t, Options{SocketPath: path})
			if _, err := c.GetTabs(); err != nil {
				t.Fatal(err)
			}
			if reason == "Close" {
				if err := c.Close(); err != nil {
					t.Fatal(err)
				}
			} else if _, err := c.Request("unacknowledgedAction", nil); err == nil {
				t.Fatal("expected unknown acknowledgement")
			}
			a.stop()
			b := startIdentityServer(t, path, "replacement-B", nil)
			_, err := c.GetTabs()
			requireIdentityDisconnected(t, "same-path request", err)
			requireIdentityDisconnected(t, "same-path Connect", c.Connect())
			logIdentityRequests(t, b)
			if requests, connections := b.snapshot(); len(requests) != 0 || connections != 0 {
				t.Errorf("same path is not the same connection: connections=%d requests=%v", connections, requests)
			}
			fresh := identityClient(t, Options{SocketPath: path})
			if _, err := fresh.GetTabs(); err != nil {
				t.Fatalf("explicit new client failed: %v", err)
			}
		})
	}
}

func TestClientConnectionIdentityFirstDialFailureCanRetry(t *testing.T) {
	path, dir := identityEndpoint(t)
	c := identityClient(t, Options{SocketDir: dir})
	if err := c.Connect(); err == nil {
		t.Fatal("missing discovery must fail")
	}
	if err := host.WriteActiveSocketRecord(dir, path); err != nil {
		t.Fatal(err)
	}
	if err := c.Connect(); err == nil {
		t.Fatal("missing endpoint must fail")
	}
	startIdentityServer(t, path, "now-available", nil)
	if _, err := c.GetTabs(); err != nil {
		t.Fatalf("no successful connection was lost; retry must work: %v", err)
	}
}

func TestClientConnectionIdentityCloseBeforeFirstDialIsTerminal(t *testing.T) {
	path, _ := identityEndpoint(t)
	c := identityClient(t, Options{SocketPath: path})
	if err := c.Close(); err != nil {
		t.Fatal(err)
	}
	s := startIdentityServer(t, path, "must-not-connect", nil)
	requireIdentityDisconnected(t, "Connect after unused Close", c.Connect())
	_, err := c.GetInfo()
	requireIdentityDisconnected(t, "request after unused Close", err)
	_, err = c.BeginTurn()
	requireIdentityDisconnected(t, "BeginTurn after unused Close", err)
	if _, connections := s.snapshot(); connections != 0 {
		t.Errorf("explicitly closed client connected %d times", connections)
	}
}

func TestClientConnectionIdentityHealthyBusinessErrorKeepsConnection(t *testing.T) {
	path, _ := identityEndpoint(t)
	s := startIdentityServer(t, path, "healthy", nil)
	c := identityClient(t, Options{SocketPath: path})
	if _, err := c.Request("businessFailure", nil); err == nil || !strings.Contains(err.Error(), "OBU_CONTROL_STALE") {
		t.Fatalf("expected business error: %v", err)
	}
	if _, err := c.BeginTurn(); err != nil {
		t.Fatalf("a valid business response must leave BeginTurn usable: %v", err)
	}
	if _, err := c.GetTabs(); err != nil {
		t.Fatal(err)
	}
	if _, connections := s.snapshot(); connections != 1 {
		t.Errorf("business error reconnected: %d connections", connections)
	}
}

func TestClientConnectionIdentityQueuedRequestKeepsDeadline(t *testing.T) {
	path, _ := identityEndpoint(t)
	entered, release := make(chan struct{}), make(chan struct{})
	s := startIdentityServer(t, path, "queued", func(_ net.Conn, request Params) bool {
		if request["method"] != "blockedUnknown" {
			return false
		}
		close(entered)
		<-release
		return true
	})
	c := identityClient(t, Options{SocketPath: path})
	first := make(chan error, 1)
	go func() { _, err := c.Request("blockedUnknown", nil); first <- err }()
	<-entered
	_, err := c.requestWithTimeout("getTabs", nil, 20*time.Millisecond)
	if !errors.Is(err, os.ErrDeadlineExceeded) {
		t.Errorf("queued request lost original deadline: %v", err)
	}
	close(release)
	if err := <-first; err == nil || strings.Contains(err.Error(), "OBU_SDK_BROWSER_DISCONNECTED") {
		t.Fatalf("first request must retain transport failure: %v", err)
	}
	_, err = c.GetTabs()
	requireIdentityDisconnected(t, "queued client after failure", err)
	requests, connections := s.snapshot()
	if len(requests) != 3 || connections != 1 {
		t.Errorf("queued/terminal work reached wire: connections=%d requests=%v", connections, requests)
	}
}

func TestClientConnectionIdentityMalformedResponseIsTerminal(t *testing.T) {
	for _, mode := range []string{"invalid-json", "wrong-id", "partial-frame"} {
		t.Run(mode, func(t *testing.T) {
			path, _ := identityEndpoint(t)
			s := startIdentityServer(t, path, mode, func(conn net.Conn, request Params) bool {
				switch mode {
				case "invalid-json":
					_ = wire.WriteFrame(conn, []byte("{"))
				case "wrong-id":
					_ = wire.WriteJSON(conn, Params{"id": 999, "result": Params{}})
				case "partial-frame":
					_, _ = conn.Write([]byte{50, 0})
				}
				return true
			})
			c := identityClient(t, Options{SocketPath: path})
			if _, err := c.GetInfo(); err == nil || errors.Is(err, ErrBrowserDisconnected) {
				t.Fatalf("first corrupt response error must be preserved: %v", err)
			}
			_, err := c.GetInfo()
			requireIdentityDisconnected(t, "request after corrupt frame", err)
			if requests, connections := s.snapshot(); len(requests) != 1 || connections != 1 {
				t.Errorf("corrupt stream reconnected or replayed: connections=%d requests=%v", connections, requests)
			}
		})
	}
}

func TestClientConnectionIdentitySuccessfulDialBindsBeforeFirstResponse(t *testing.T) {
	pathA, dir := identityEndpoint(t)
	pathB, _ := identityEndpoint(t)
	a := startIdentityServer(t, pathA, "A", nil)
	b := startIdentityServer(t, pathB, "B", nil)
	if err := host.WriteActiveSocketRecord(dir, pathA); err != nil {
		t.Fatal(err)
	}
	c := identityClient(t, Options{SocketDir: dir})
	if err := c.Connect(); err != nil {
		t.Fatal(err)
	}
	a.stop()
	if err := host.WriteActiveSocketRecord(dir, pathB); err != nil {
		t.Fatal(err)
	}
	if _, err := c.GetInfo(); err == nil || errors.Is(err, ErrBrowserDisconnected) {
		t.Fatalf("first connection failure must be original error: %v", err)
	}
	requireIdentityDisconnected(t, "Connect after first response failed", c.Connect())
	_, err := c.GetInfo()
	requireIdentityDisconnected(t, "request after first response failed", err)
	if requests, connections := b.snapshot(); len(requests) != 0 || connections != 0 {
		t.Errorf("successful Dial was not bound: connections=%d requests=%v", connections, requests)
	}
}

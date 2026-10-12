package browserdownloads

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/coder/websocket"
)

var testIdentity = Identity{"nonce-original-port", strings.Repeat("a", 32), "extension-instance", "worker-boot", "port-original"}

type nativeRequest struct {
	ID      int64          `json:"id"`
	Method  string         `json:"method"`
	Session string         `json:"sessionId,omitempty"`
	Params  map[string]any `json:"params"`
}

// The test peer uses actual HTTP/WebSocket framing and independent reads/writes.
// Hooks control native ordering, without replacing the production transport.
type browserPeer struct {
	t         *testing.T
	server    *httptest.Server
	mu        sync.Mutex
	conn      *websocket.Conn
	requests  []nativeRequest
	connected chan struct{}
	done      chan struct{}
	hook      func(*browserPeer, nativeRequest) bool
	identity  Identity
	contextID string
}

func newPeer(t *testing.T, contextID string, hook func(*browserPeer, nativeRequest) bool) *browserPeer {
	return newPeerWithHandshake(t, contextID, hook, nil)
}

func newPeerWithHandshake(t *testing.T, contextID string, hook func(*browserPeer, nativeRequest) bool, beforeUpgrade func(http.ResponseWriter, *http.Request) bool) *browserPeer {
	return newPeerWithListener(t, contextID, hook, beforeUpgrade, nil)
}

func newPeerWithListener(t *testing.T, contextID string, hook func(*browserPeer, nativeRequest) bool, beforeUpgrade func(http.ResponseWriter, *http.Request) bool, listener net.Listener) *browserPeer {
	t.Helper()
	p := &browserPeer{t: t, contextID: contextID, identity: testIdentity, connected: make(chan struct{}), done: make(chan struct{}), hook: hook}
	p.server = httptest.NewUnstartedServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if beforeUpgrade != nil && !beforeUpgrade(w, r) {
			return
		}
		conn, err := websocket.Accept(w, r, nil)
		if err != nil {
			return
		}
		defer close(p.done)
		defer conn.CloseNow()
		p.mu.Lock()
		p.conn = conn
		p.mu.Unlock()
		close(p.connected)
		for {
			kind, data, err := conn.Read(context.Background())
			if err != nil {
				return
			}
			var request nativeRequest
			if kind != websocket.MessageText || json.Unmarshal(data, &request) != nil {
				t.Error("bad client frame")
				return
			}
			p.mu.Lock()
			p.requests = append(p.requests, request)
			p.mu.Unlock()
			if hook != nil && hook(p, request) {
				continue
			}
			switch request.Method {
			case "Target.getTargets":
				p.respond(request, map[string]any{"targetInfos": []any{map[string]any{"targetId": "worker-target", "type": "service_worker", "url": "chrome-extension://" + p.identity.ExtensionID + "/background.js", "browserContextId": contextID}}})
			case "Target.attachToTarget":
				p.respond(request, map[string]any{"sessionId": "worker-session"})
			case "Runtime.evaluate":
				if request.Params["expression"] != "globalThis.__obuNativeDownloadBinding" || request.Params["returnByValue"] != true || request.Session != "worker-session" {
					t.Error("unexpected challenge evaluation")
				}
				p.respond(request, map[string]any{"result": map[string]any{"type": "object", "value": p.identity}})
			case "Target.detachFromTarget":
				p.respond(request, map[string]any{})
			case "Browser.setDownloadBehavior", "Browser.cancelDownload":
				if contextID != "" && request.Params["browserContextId"] != contextID {
					t.Error("wrong browser context")
				}
				if contextID == "" && request.Params["browserContextId"] != nil {
					t.Error("unexpected context override")
				}
				p.respond(request, map[string]any{})
			case "Target.getTargetInfo":
				p.respond(request, map[string]any{"targetInfo": map[string]any{"targetId": request.Params["targetId"], "type": "page", "browserContextId": contextID}})
			default:
				t.Errorf("unexpected command: %s", request.Method)
			}
		}
	}))
	if listener != nil {
		_ = p.server.Listener.Close()
		p.server.Listener = listener
	}
	p.server.Start()
	t.Cleanup(func() {
		p.mu.Lock()
		c := p.conn
		p.mu.Unlock()
		if c != nil {
			_ = c.CloseNow()
		}
		p.server.Close()
		if c != nil {
			select {
			case <-p.done:
			case <-time.After(2 * time.Second):
				t.Error("peer reader leaked")
			}
		}
	})
	return p
}

func (p *browserPeer) url() string {
	return "ws" + strings.TrimPrefix(p.server.URL, "http") + "/devtools/browser/test-browser"
}
func (p *browserPeer) write(value any) {
	p.t.Helper()
	data, err := json.Marshal(value)
	if err != nil {
		p.t.Fatal(err)
	}
	p.raw(websocket.MessageText, data)
}
func (p *browserPeer) raw(kind websocket.MessageType, data []byte) {
	p.t.Helper()
	p.mu.Lock()
	c := p.conn
	p.mu.Unlock()
	ctx, cancel := context.WithTimeout(context.Background(), time.Second)
	defer cancel()
	if err := c.Write(ctx, kind, data); err != nil {
		p.t.Errorf("peer write: %v", err)
	}
}
func (p *browserPeer) respond(r nativeRequest, value any) {
	p.write(map[string]any{"id": r.ID, "sessionId": r.Session, "result": value})
}
func (p *browserPeer) event(method string, params any) {
	p.write(map[string]any{"method": method, "params": params})
}
func (p *browserPeer) begin(c Claim) {
	p.event("Browser.downloadWillBegin", map[string]any{"guid": c.GUID, "frameId": c.FrameID, "url": "https://same.example/report", "suggestedFilename": "same.bin"})
}
func (p *browserPeer) progress(c Claim, state, file string) {
	p.event("Browser.downloadProgress", map[string]any{"guid": c.GUID, "state": state, "filePath": file})
}
func (p *browserPeer) snapshot() []nativeRequest {
	p.mu.Lock()
	defer p.mu.Unlock()
	return append([]nativeRequest(nil), p.requests...)
}

func newManager(t *testing.T, p *browserPeer) *Manager {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()
	m, err := Dial(ctx, p.url(), testIdentity)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = m.Close() })
	return m
}
func claim(guid string) Claim {
	return Claim{GUID: guid, FrameID: "frame-" + guid, RootTargetID: "root-target", SessionID: "owner", TurnID: "turn", ControlEpoch: 1, TabID: 1, ClaimID: "claim-" + guid}
}
func mustClaim(t *testing.T, m *Manager, c Claim) {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), time.Second)
	defer cancel()
	if err := m.Claim(ctx, c); err != nil {
		t.Fatal(err)
	}
}
func wantError(t *testing.T, err error, part string) {
	t.Helper()
	if err == nil || !strings.Contains(err.Error(), part) {
		t.Fatalf("want %q, got %v", part, err)
	}
}
func done(t *testing.T, ch <-chan struct{}) {
	t.Helper()
	select {
	case <-ch:
	case <-time.After(2 * time.Second):
		t.Fatal("completion deadline")
	}
}
func fileBytes(t *testing.T) string {
	t.Helper()
	p := filepath.Join(t.TempDir(), "same.bin")
	if err := os.WriteFile(p, []byte{0, 255, 13, 10, 195, 40}, 0600); err != nil {
		t.Fatal(err)
	}
	return p
}

func TestValidateURL(t *testing.T) {
	for _, url := range []string{"ws://127.0.0.1:9222/devtools/browser/id", "wss://[::1]:443/devtools/browser/id"} {
		if err := ValidateURL(url); err != nil {
			t.Error(err)
		}
	}
	for _, url := range []string{"http://127.0.0.1:9222/devtools/browser/id", "ws://localhost:9222/devtools/browser/id", "ws://example.com:9222/devtools/browser/id", "ws://192.168.1.1:9222/devtools/browser/id", "ws://127.0.0.1/devtools/browser/id", "ws://127.0.0.1:0/devtools/browser/id", "ws://127.0.0.1:9222/devtools/page/id", "ws://127.0.0.1:9222/devtools/browser/", "ws://u:p@127.0.0.1:9222/devtools/browser/id", "ws://127.0.0.1:9222/devtools/browser/id?", "ws://127.0.0.1:9222/devtools/browser/id#", "ws://127.0.0.1:9222/devtools/browser/a%2fb"} {
		if ValidateURL(url) == nil {
			t.Errorf("accepted %s", url)
		}
	}
}

func TestIdentityChallengeBeforeCapabilityAndSetupContextIndependent(t *testing.T) {
	for _, contextID := range []string{"", "private-context"} {
		t.Run(contextID, func(t *testing.T) {
			p := newPeer(t, contextID, nil)
			ctx, cancel := context.WithCancel(context.Background())
			m, err := Dial(ctx, p.url(), testIdentity)
			cancel()
			if err != nil {
				t.Fatal(err)
			}
			defer m.Close()
			var methods []string
			for _, r := range p.snapshot() {
				methods = append(methods, r.Method)
			}
			if !reflect.DeepEqual(methods, []string{"Target.getTargets", "Target.attachToTarget", "Runtime.evaluate", "Target.detachFromTarget", "Browser.setDownloadBehavior"}) {
				t.Fatal(methods)
			}
			c := claim("original")
			p.begin(c)
			p.progress(c, "completed", fileBytes(t))
			mustClaim(t, m, c)
			if _, err = m.Path(context.Background(), c); err != nil {
				t.Fatal(err)
			}
			if m.Generation() == "" {
				t.Fatal("missing generation")
			}
			if err = m.Close(); err != nil {
				t.Fatal(err)
			}
			done(t, m.Done())
			done(t, p.done)
			wantError(t, m.Claim(context.Background(), c), "DISCONNECTED")
			_, err = m.Path(context.Background(), c)
			wantError(t, err, "DISCONNECTED")
		})
	}
}

func TestWrongIdentityNeverChangesBehavior(t *testing.T) {
	for _, field := range []string{"nonce", "extensionInstanceId", "workerBootId", "portId"} {
		t.Run(field, func(t *testing.T) {
			p := newPeer(t, "", func(p *browserPeer, r nativeRequest) bool {
				if r.Method != "Runtime.evaluate" {
					return false
				}
				v := map[string]any{"nonce": testIdentity.Nonce, "extensionId": testIdentity.ExtensionID, "extensionInstanceId": testIdentity.ExtensionInstanceID, "workerBootId": testIdentity.WorkerBootID, "portId": testIdentity.PortID}
				v[field] = "wrong"
				p.respond(r, map[string]any{"result": map[string]any{"type": "object", "value": v}})
				return true
			})
			_, err := Dial(context.Background(), p.url(), testIdentity)
			wantError(t, err, "IDENTITY")
			done(t, p.done)
			for _, r := range p.snapshot() {
				if r.Method == "Browser.setDownloadBehavior" {
					t.Fatal("unverified Browser was configured")
				}
			}
		})
	}
}

func TestReadyWaitsForActualBehaviorACK(t *testing.T) {
	reached := make(chan nativeRequest, 1)
	p := newPeer(t, "", func(p *browserPeer, r nativeRequest) bool {
		if r.Method == "Browser.setDownloadBehavior" && r.Params["eventsEnabled"] == true {
			reached <- r
			return true
		}
		return false
	})
	result := make(chan *Manager, 1)
	errs := make(chan error, 1)
	go func() { m, err := Dial(context.Background(), p.url(), testIdentity); result <- m; errs <- err }()
	r := <-reached
	select {
	case <-result:
		t.Fatal("ready without ACK")
	default:
	}
	p.respond(r, map[string]any{})
	m := <-result
	if err := <-errs; err != nil {
		t.Fatal(err)
	}
	defer m.Close()
}

func TestExactClaimScopeAndOriginalPath(t *testing.T) {
	p := newPeer(t, "context", nil)
	m := newManager(t, p)
	a := claim("a")
	b := claim("b")
	b.SessionID = "other-owner"
	b.TabID = 2
	pa, pb := fileBytes(t), fileBytes(t)
	p.begin(a)
	p.begin(b)
	p.progress(b, "completed", pb)
	p.progress(a, "completed", pa)
	_, err := m.Path(context.Background(), a)
	wantError(t, err, "CLAIM")
	mustClaim(t, m, a)
	mustClaim(t, m, b)
	for _, c := range []Claim{a, b} {
		got, err := m.Path(context.Background(), c)
		if err != nil {
			t.Fatal(err)
		}
		want := pa
		if c == b {
			want = pb
		}
		if got != want {
			t.Fatalf("wrong original path: %s", got)
		}
	}
	for _, mutate := range []func(*Claim){func(c *Claim) { c.SessionID = "foreign" }, func(c *Claim) { c.TurnID = "other" }, func(c *Claim) { c.ControlEpoch++ }, func(c *Claim) { c.TabID++ }, func(c *Claim) { c.ClaimID = "other" }, func(c *Claim) { c.FrameID = "other" }, func(c *Claim) { c.RootTargetID = "other" }} {
		foreign := a
		mutate(&foreign)
		_, err = m.Path(context.Background(), foreign)
		wantError(t, err, "CLAIM")
		wantError(t, m.Cancel(context.Background(), foreign), "CLAIM")
		wantError(t, m.Claim(context.Background(), foreign), "CLAIM")
	}
	if err = m.Cancel(context.Background(), a); err != nil {
		t.Fatal(err)
	}
	if _, err = os.Stat(pa); err != nil {
		t.Fatal("cancel deleted original file", err)
	}
	m.Release(a)
	_, err = m.Path(context.Background(), a)
	wantError(t, err, "CLAIM")
	wantError(t, m.Claim(context.Background(), a), "CLAIM")
}

func TestClaimBeforeEventsAndPathWaitsForCompleted(t *testing.T) {
	called := make(chan nativeRequest, 1)
	p := newPeer(t, "", func(p *browserPeer, r nativeRequest) bool {
		if r.Method == "Target.getTargetInfo" {
			called <- r
		}
		return false
	})
	m := newManager(t, p)
	c := claim("later")
	claimDone := make(chan error, 1)
	go func() { claimDone <- m.Claim(context.Background(), c) }()
	<-called
	p.begin(c)
	if err := <-claimDone; err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 50*time.Millisecond)
	defer cancel()
	_, err := m.Path(ctx, c)
	if !errors.Is(err, context.DeadlineExceeded) {
		t.Fatal(err)
	}
	if m.Err() != nil {
		t.Fatal("local path timeout damaged connection", m.Err())
	}
	f := fileBytes(t)
	p.progress(c, "completed", f)
	got, err := m.Path(context.Background(), c)
	if err != nil || got != f {
		t.Fatal(got, err)
	}
}

func TestReleaseDuringRootValidationAndBeforeClaim(t *testing.T) {
	for _, early := range []bool{false, true} {
		t.Run(fmt.Sprint(early), func(t *testing.T) {
			called := make(chan nativeRequest, 1)
			p := newPeer(t, "", func(p *browserPeer, r nativeRequest) bool {
				if r.Method == "Target.getTargetInfo" {
					called <- r
					return true
				}
				return false
			})
			m := newManager(t, p)
			c := claim("released")
			p.begin(c)
			if early {
				m.Release(c)
				wantError(t, m.Claim(context.Background(), c), "CLAIM")
				return
			}
			result := make(chan error, 1)
			go func() { result <- m.Claim(context.Background(), c) }()
			r := <-called
			m.Release(c)
			p.respond(r, map[string]any{"targetInfo": map[string]any{"targetId": c.RootTargetID, "type": "page", "browserContextId": ""}})
			wantError(t, <-result, "CLAIM")
			_, err := m.Path(context.Background(), c)
			wantError(t, err, "CLAIM")
		})
	}
}

func TestPathMissingCanceledAndNonregular(t *testing.T) {
	for _, kind := range []string{"no-path", "relative", "missing", "directory", "canceled"} {
		t.Run(kind, func(t *testing.T) {
			p := newPeer(t, "", nil)
			m := newManager(t, p)
			c := claim(kind)
			p.begin(c)
			mustClaim(t, m, c)
			state := "completed"
			path := ""
			switch kind {
			case "relative":
				path = "not-absolute.bin"
			case "missing":
				path = filepath.Join(t.TempDir(), "gone.bin")
			case "directory":
				path = t.TempDir()
			case "canceled":
				state = "canceled"
			}
			p.progress(c, state, path)
			_, err := m.Path(context.Background(), c)
			if err == nil {
				t.Fatal("unsupported path reported success")
			}
			if m.Err() != nil {
				t.Fatal("file-level failure damaged native connection", m.Err())
			}
		})
	}
}

func TestCancelRequiresNativeACK(t *testing.T) {
	called := make(chan nativeRequest, 1)
	p := newPeer(t, "", func(p *browserPeer, r nativeRequest) bool {
		if r.Method == "Browser.cancelDownload" {
			called <- r
			return true
		}
		return false
	})
	m := newManager(t, p)
	c := claim("cancel")
	p.begin(c)
	mustClaim(t, m, c)
	result := make(chan error, 1)
	go func() { result <- m.Cancel(context.Background(), c) }()
	r := <-called
	select {
	case <-result:
		t.Fatal("cancel succeeded without ACK")
	default:
	}
	p.progress(c, "canceled", "")
	p.respond(r, map[string]any{})
	if err := <-result; err != nil {
		t.Fatal(err)
	}
	_, err := m.Path(context.Background(), c)
	wantError(t, err, "CANCELED")
}

func TestProtocolFailuresAreTerminalAndNeverReconnect(t *testing.T) {
	for _, kind := range []string{"unknown-ack", "duplicate-ack", "wrong-session", "binary", "bad-json", "duplicate-id", "download-child-session", "duplicate-begin", "late-after-terminal"} {
		t.Run(kind, func(t *testing.T) {
			p := newPeer(t, "", nil)
			m := newManager(t, p)
			c := claim("terminal")
			p.begin(c)
			mustClaim(t, m, c)
			switch kind {
			case "unknown-ack":
				p.write(map[string]any{"id": 9999, "result": map[string]any{}})
			case "duplicate-ack":
				r := p.snapshot()[0]
				p.respond(r, map[string]any{})
			case "wrong-session":
				p.write(map[string]any{"id": 9999, "sessionId": "other", "result": map[string]any{}})
			case "binary":
				p.raw(websocket.MessageBinary, []byte("{}"))
			case "bad-json":
				p.raw(websocket.MessageText, []byte("{"))
			case "duplicate-id":
				p.raw(websocket.MessageText, []byte(`{"id":1,"id":2,"result":{}}`))
			case "download-child-session":
				p.write(map[string]any{"method": "Browser.downloadProgress", "sessionId": "child", "params": map[string]any{"guid": c.GUID, "state": "completed"}})
			case "duplicate-begin":
				p.begin(c)
			case "late-after-terminal":
				p.progress(c, "completed", fileBytes(t))
				p.progress(c, "inProgress", "")
			}
			done(t, m.Done())
			done(t, p.done)
			wantError(t, m.Err(), "PROTOCOL")
			before := len(p.snapshot())
			_, err := m.Path(context.Background(), c)
			if err == nil {
				t.Fatal("closed manager returned a path")
			}
			_ = m.Claim(context.Background(), c)
			_ = m.Cancel(context.Background(), c)
			if len(p.snapshot()) != before {
				t.Fatal("terminal manager submitted another request")
			}
		})
	}
}

func TestCloseUnblocksPendingWaitsAndActualReader(t *testing.T) {
	p := newPeer(t, "", nil)
	m := newManager(t, p)
	c := claim("pending")
	p.begin(c)
	mustClaim(t, m, c)
	result := make(chan error, 1)
	go func() { _, err := m.Path(context.Background(), c); result <- err }()
	if err := m.Close(); err != nil {
		t.Fatal(err)
	}
	wantError(t, <-result, "DISCONNECTED")
	done(t, m.Done())
	done(t, m.transport.readerDone)
	done(t, p.done)
	last := p.snapshot()[len(p.snapshot())-1]
	if last.Method != "Browser.setDownloadBehavior" || last.Params["eventsEnabled"] != false {
		t.Fatal("missing reset", last)
	}
}

func TestCommandDeadlineAndEOFRetireConnection(t *testing.T) {
	for _, mode := range []string{"timeout", "eof"} {
		t.Run(mode, func(t *testing.T) {
			p := newPeer(t, "", func(p *browserPeer, r nativeRequest) bool {
				if r.Method != "Target.getTargetInfo" {
					return false
				}
				if mode == "eof" {
					_ = p.conn.CloseNow()
				}
				return true
			})
			m := newManager(t, p)
			c := claim("deadline")
			p.begin(c)
			ctx, cancel := context.WithTimeout(context.Background(), 50*time.Millisecond)
			defer cancel()
			if err := m.Claim(ctx, c); err == nil {
				t.Fatal("missing failure")
			}
			done(t, m.Done())
			done(t, m.transport.readerDone)
			done(t, p.done)
			m.transport.mu.Lock()
			pending := len(m.transport.pending)
			m.transport.mu.Unlock()
			if pending != 0 {
				t.Fatal("pending requests leaked", pending)
			}
		})
	}
}

func TestRecordCapacityExpiryAndProgressCannotRecreate(t *testing.T) {
	p := newPeer(t, "", nil)
	m := newManager(t, p)
	for i := 0; i < recordLimit+20; i++ {
		p.begin(claim(fmt.Sprint(i)))
	}
	// A subsequent ACK fences the peer's earlier event writes through the reader.
	var targets any
	if err := m.transport.call(context.Background(), "Target.getTargets", "", map[string]any{}, &targets); err != nil {
		t.Fatal(err)
	}
	m.mu.Lock()
	if len(m.records) != recordLimit {
		t.Fatal(len(m.records))
	}
	for _, r := range m.records {
		r.created = time.Now().Add(-2 * unclaimedTTL)
	}
	m.mu.Unlock()
	c := claim("expired-progress")
	p.progress(c, "completed", fileBytes(t))
	if err := m.transport.call(context.Background(), "Target.getTargets", "", map[string]any{}, nil); err != nil {
		t.Fatal(err)
	}
	m.mu.Lock()
	count := len(m.records)
	m.mu.Unlock()
	if count != 0 {
		t.Fatal("expired/progress-only evidence retained", count)
	}
}

func TestLocalPreflightAndCDPErrorsKeepHealthyConnection(t *testing.T) {
	p := newPeer(t, "", func(p *browserPeer, r nativeRequest) bool {
		if r.Method == "Browser.cancelDownload" {
			p.write(map[string]any{"id": r.ID, "error": map[string]any{"code": -32000, "message": "already completed"}})
			return true
		}
		return false
	})
	m := newManager(t, p)
	c := claim("completed")
	p.begin(c)
	mustClaim(t, m, c)
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	if err := m.transport.call(ctx, "Target.getTargets", "", map[string]any{}, nil); !errors.Is(err, context.Canceled) {
		t.Fatal(err)
	}
	if err := m.transport.call(context.Background(), "Target.getTargets", "", map[string]any{"invalid": make(chan int)}, nil); err == nil {
		t.Fatal("encoding succeeded")
	}
	wantError(t, m.Cancel(context.Background(), c), "already completed")
	if m.Err() != nil {
		t.Fatal(m.Err())
	}
	if err := m.transport.call(context.Background(), "Target.getTargets", "", map[string]any{}, nil); err != nil {
		t.Fatal(err)
	}
}

func TestWrongRootAndFrameNeverAdmitPath(t *testing.T) {
	for _, mode := range []string{"target", "type", "context", "frame"} {
		t.Run(mode, func(t *testing.T) {
			p := newPeer(t, "verified-context", func(p *browserPeer, r nativeRequest) bool {
				if r.Method != "Target.getTargetInfo" || mode == "frame" {
					return false
				}
				info := map[string]any{"targetId": r.Params["targetId"], "type": "page", "browserContextId": "verified-context"}
				switch mode {
				case "target":
					info["targetId"] = "other"
				case "type":
					info["type"] = "service_worker"
				case "context":
					info["browserContextId"] = "other-context"
				}
				p.respond(r, map[string]any{"targetInfo": info})
				return true
			})
			m := newManager(t, p)
			c := claim("wrong")
			native := c
			if mode == "frame" {
				native.FrameID = "different-frame"
			}
			p.begin(native)
			p.progress(native, "completed", fileBytes(t))
			wantError(t, m.Claim(context.Background(), c), "CLAIM")
			_, err := m.Path(context.Background(), c)
			wantError(t, err, "CLAIM")
		})
	}
}

func TestFailedOrMissingSetupACKNeverReturnsManager(t *testing.T) {
	for _, method := range []string{"Target.attachToTarget", "Target.detachFromTarget", "Browser.setDownloadBehavior"} {
		t.Run(method, func(t *testing.T) {
			p := newPeer(t, "", func(p *browserPeer, r nativeRequest) bool { return r.Method == method })
			ctx, cancel := context.WithTimeout(context.Background(), 50*time.Millisecond)
			defer cancel()
			m, err := Dial(ctx, p.url(), testIdentity)
			if err == nil || m != nil {
				t.Fatal("setup did not fail", m, err)
			}
			done(t, p.done)
			if method != "Browser.setDownloadBehavior" {
				for _, r := range p.snapshot() {
					if r.Method == "Browser.setDownloadBehavior" {
						t.Fatal("configured without verified detached worker")
					}
				}
			}
		})
	}
}

func TestWrongSessionForPendingCommandRetiresConnection(t *testing.T) {
	p := newPeer(t, "", func(p *browserPeer, r nativeRequest) bool {
		if r.Method != "Target.getTargetInfo" {
			return false
		}
		p.write(map[string]any{"id": r.ID, "sessionId": "different-session", "result": map[string]any{}})
		return true
	})
	m := newManager(t, p)
	c := claim("session")
	p.begin(c)
	wantError(t, m.Claim(context.Background(), c), "PROTOCOL")
	done(t, m.Done())
	done(t, p.done)
}

func TestCloseUnblocksInFlightCancelAndWaitForBegin(t *testing.T) {
	for _, operation := range []string{"cancel", "claim"} {
		t.Run(operation, func(t *testing.T) {
			nativeCancel := make(chan struct{})
			p := newPeer(t, "", func(p *browserPeer, r nativeRequest) bool {
				if r.Method == "Browser.cancelDownload" {
					close(nativeCancel)
					return true
				}
				return false
			})
			m := newManager(t, p)
			c := claim("closing")
			result := make(chan error, 1)
			if operation == "cancel" {
				p.begin(c)
				mustClaim(t, m, c)
				go func() { result <- m.Cancel(context.Background(), c) }()
				done(t, nativeCancel)
			} else {
				go func() { result <- m.Claim(context.Background(), c) }()
			}
			if err := m.Close(); err != nil {
				t.Fatal(err)
			}
			wantError(t, <-result, "DISCONNECTED")
			done(t, m.Done())
			done(t, m.transport.readerDone)
			done(t, p.done)
		})
	}
}

func TestReleaseUnblocksPathAndDoesNotCancelNativeDownload(t *testing.T) {
	p := newPeer(t, "", nil)
	m := newManager(t, p)
	c := claim("released-path")
	p.begin(c)
	mustClaim(t, m, c)
	result := make(chan error, 1)
	go func() { _, err := m.Path(context.Background(), c); result <- err }()
	m.Release(c)
	wantError(t, <-result, "CLAIM")
	for _, r := range p.snapshot() {
		if r.Method == "Browser.cancelDownload" {
			t.Fatal("Release canceled the actual transfer")
		}
	}
}

func TestClaimWaitDeadlineDoesNotDamageNativeTransport(t *testing.T) {
	p := newPeer(t, "", nil)
	m := newManager(t, p)
	c := claim("never-begins")
	ctx, cancel := context.WithTimeout(context.Background(), 50*time.Millisecond)
	defer cancel()
	if err := m.Claim(ctx, c); !errors.Is(err, context.DeadlineExceeded) {
		t.Fatal(err)
	}
	if m.Err() != nil {
		t.Fatal(m.Err())
	}
	p.begin(c)
	p.progress(c, "completed", fileBytes(t))
	_, err := m.Path(context.Background(), c)
	wantError(t, err, "CLAIM")
}

func TestRedirectIsRejectedAndProxyEnvironmentIsNotUsed(t *testing.T) {
	var mu sync.Mutex
	requests := 0
	proxy := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		mu.Lock()
		requests++
		mu.Unlock()
		w.WriteHeader(http.StatusBadGateway)
	}))
	defer proxy.Close()
	t.Setenv("HTTP_PROXY", proxy.URL)
	t.Setenv("HTTPS_PROXY", proxy.URL)
	t.Setenv("NO_PROXY", "")
	p := newPeer(t, "", nil)
	m := newManager(t, p)
	if err := m.Close(); err != nil {
		t.Fatal(err)
	}
	redirect := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		http.Redirect(w, r, proxy.URL+"/devtools/browser/redirect", http.StatusTemporaryRedirect)
	}))
	defer redirect.Close()
	_, err := Dial(context.Background(), "ws"+strings.TrimPrefix(redirect.URL, "http")+"/devtools/browser/original", testIdentity)
	if err == nil {
		t.Fatal("redirect accepted")
	}
	mu.Lock()
	count := requests
	mu.Unlock()
	if count != 0 {
		t.Fatal("used proxy or followed redirect", count)
	}
}

func TestClaimedRecordCapacityDoesNotEvictActiveOwners(t *testing.T) {
	p := newPeer(t, "", nil)
	m := newManager(t, p)
	for i := 0; i < recordLimit; i++ {
		c := claim(fmt.Sprint(i))
		p.begin(c)
		mustClaim(t, m, c)
	}
	wantError(t, m.Claim(context.Background(), claim("overflow")), "LIMIT")
	m.Release(claim("0"))
	c := claim("new-after-release")
	p.begin(c)
	mustClaim(t, m, c)
	m.mu.Lock()
	count := len(m.records)
	m.mu.Unlock()
	if count != recordLimit {
		t.Fatal(count)
	}
}

func TestReleaseSurvivesNativeCacheChurnFullOwnersAndExpiry(t *testing.T) {
	for _, mode := range []string{"event-churn", "all-owners-active", "expired-cache"} {
		t.Run(mode, func(t *testing.T) {
			p := newPeer(t, "", nil)
			m := newManager(t, p)
			c := claim("released-before-host-claim")
			if mode == "all-owners-active" {
				for i := 0; i < recordLimit; i++ {
					owner := claim(fmt.Sprintf("owner-%d", i))
					p.begin(owner)
					mustClaim(t, m, owner)
				}
			}
			m.Release(c)
			switch mode {
			case "event-churn":
				for i := 0; i < recordLimit; i++ {
					p.begin(claim(fmt.Sprintf("unclaimed-%d", i)))
				}
			case "all-owners-active":
				// A release received while all slots were active must still be
				// remembered after another owner subsequently frees a slot.
				m.Release(claim("owner-0"))
			case "expired-cache":
				m.mu.Lock()
				for _, r := range m.records {
					r.created = time.Now().Add(-2 * unclaimedTTL)
				}
				m.mu.Unlock()
			}
			// The original native begin can arrive after the private release.
			// A following ACK fences all event writes before testing admission.
			p.begin(c)
			p.progress(c, "completed", fileBytes(t))
			if err := m.transport.call(context.Background(), "Target.getTargets", "", map[string]any{}, nil); err != nil {
				t.Fatal(err)
			}
			before := len(p.snapshot())
			wantError(t, m.Claim(context.Background(), c), "CLAIM")
			changedID := c
			changedID.ClaimID = "different-claim-id"
			wantError(t, m.Claim(context.Background(), changedID), "CLAIM")
			_, err := m.Path(context.Background(), c)
			wantError(t, err, "CLAIM")
			wantError(t, m.Cancel(context.Background(), c), "CLAIM")
			if len(p.snapshot()) != before || m.Err() != nil {
				t.Fatal("revoked GUID submitted a command or damaged the healthy connection", m.Err())
			}
		})
	}
}

func TestForeignReleaseCannotRevokeActiveOriginalClaim(t *testing.T) {
	p := newPeer(t, "", nil)
	m := newManager(t, p)
	c := claim("original-owner")
	f := fileBytes(t)
	p.begin(c)
	p.progress(c, "completed", f)
	mustClaim(t, m, c)
	for _, mutate := range []func(*Claim){func(c *Claim) { c.SessionID = "foreign" }, func(c *Claim) { c.TurnID = "foreign" }, func(c *Claim) { c.ControlEpoch++ }, func(c *Claim) { c.TabID++ }, func(c *Claim) { c.ClaimID = "foreign" }, func(c *Claim) { c.FrameID = "foreign" }, func(c *Claim) { c.RootTargetID = "foreign" }} {
		foreign := c
		mutate(&foreign)
		m.Release(foreign)
		got, err := m.Path(context.Background(), c)
		if err != nil || got != f {
			t.Fatal("foreign release affected the original owner", got, err)
		}
	}
}

func TestRevocationCapacityTerminatesOriginalConnectionOnce(t *testing.T) {
	p := newPeer(t, "", nil)
	m := newManager(t, p)
	active := claim("active-owner")
	p.begin(active)
	mustClaim(t, m, active)
	for i := 0; i < 4096; i++ {
		m.Release(claim(fmt.Sprintf("revoked-%d", i)))
	}
	// Neither an idempotent release nor a foreign release consumes a slot.
	m.Release(claim("revoked-0"))
	foreign := active
	foreign.ClaimID = "foreign"
	m.Release(foreign)
	if m.Err() != nil {
		t.Fatal("ledger limit retired the binding before a new revocation", m.Err())
	}
	before := len(p.snapshot())
	m.Release(claim("revoked-overflow"))
	done(t, m.Done())
	done(t, m.transport.readerDone)
	done(t, p.done)
	first := m.Err()
	wantError(t, first, "LIMIT")
	for i := 0; i < 3; i++ {
		m.Release(claim(fmt.Sprintf("after-terminal-%d", i)))
		wantError(t, m.Claim(context.Background(), active), "LIMIT")
		wantError(t, m.Close(), "LIMIT")
		if m.Err() != first {
			t.Fatal("replaced the original terminal cause")
		}
	}
	if len(p.snapshot()) != before {
		t.Fatal("terminal manager submitted more native commands")
	}
}

// A context may expose its deadline before its cancellation notification is
// observed. Keep notification absent here to exercise the wall-clock checks.
type deadlineOnlyContext struct {
	context.Context
	deadline time.Time
}

func (c deadlineOnlyContext) Deadline() (time.Time, bool) { return c.deadline, true }

func afterDeadline(deadline time.Time) {
	if remaining := time.Until(deadline); remaining > 0 {
		timer := time.NewTimer(remaining)
		<-timer.C
	}
}

type deadlineDecode struct{ deadline time.Time }

func (d *deadlineDecode) UnmarshalJSON([]byte) error {
	afterDeadline(d.deadline)
	return nil
}

type deadlineEncode struct{ deadline time.Time }

func (d deadlineEncode) MarshalJSON() ([]byte, error) {
	afterDeadline(d.deadline)
	return []byte("{}"), nil
}

func TestTransportPreflightHonorsDeadlineBeforeNotification(t *testing.T) {
	p := newPeer(t, "", nil)
	m := newManager(t, p)
	for _, duringEncode := range []bool{false, true} {
		deadline := time.Now().Add(-time.Second)
		var params any = map[string]any{}
		if duringEncode {
			deadline = time.Now().Add(20 * time.Millisecond)
			params = deadlineEncode{deadline}
		}
		ctx := deadlineOnlyContext{context.Background(), deadline}
		before := len(p.snapshot())
		if err := m.call(ctx, "Target.getTargets", "", params, nil); !errors.Is(err, context.DeadlineExceeded) {
			t.Fatal(err)
		}
		if len(p.snapshot()) != before || m.Err() != nil {
			t.Fatal("expired local budget submitted a command or retired the connection", m.Err())
		}
	}
}

func TestLateSetupACKNeverReturnsSuccessAndCleanupRequiresVerifiedIdentity(t *testing.T) {
	for _, method := range []string{"Target.getTargets", "Target.attachToTarget", "Runtime.evaluate", "Target.detachFromTarget", "Browser.setDownloadBehavior"} {
		t.Run(method, func(t *testing.T) {
			deadline := time.Now().Add(60 * time.Millisecond)
			p := newPeer(t, "context", func(p *browserPeer, r nativeRequest) bool {
				if r.Method != method || (method == "Browser.setDownloadBehavior" && r.Params["eventsEnabled"] != true) {
					return false
				}
				afterDeadline(deadline)
				var result any = map[string]any{}
				switch method {
				case "Target.getTargets":
					result = map[string]any{"targetInfos": []any{map[string]any{"targetId": "worker-target", "type": "service_worker", "url": "chrome-extension://" + p.identity.ExtensionID + "/background.js", "browserContextId": "context"}}}
				case "Target.attachToTarget":
					result = map[string]any{"sessionId": "worker-session"}
				case "Runtime.evaluate":
					result = map[string]any{"result": map[string]any{"type": "object", "value": p.identity}}
				}
				p.respond(r, result)
				return true
			})
			ctx := deadlineOnlyContext{context.Background(), deadline}
			m, err := Dial(ctx, p.url(), testIdentity)
			var late *lateAcknowledgementError
			if m != nil || !errors.Is(err, context.DeadlineExceeded) {
				t.Fatal("accepted or misclassified a late acknowledged setup", m, err)
			}
			// Detach intentionally has its own bounded cleanup context. Its ACK
			// can satisfy cleanup after setup expires, but enable must not start.
			if method != "Target.detachFromTarget" && !errors.As(err, &late) {
				t.Fatal("did not preserve the known late-ACK outcome", err)
			}
			done(t, p.done)
			var configured []bool
			for _, r := range p.snapshot() {
				if r.Method == "Browser.setDownloadBehavior" {
					configured = append(configured, r.Params["eventsEnabled"].(bool))
				}
			}
			if method == "Browser.setDownloadBehavior" {
				if !reflect.DeepEqual(configured, []bool{true, false}) {
					t.Fatal("late enable ACK did not receive original-connection reset ACK", configured)
				}
			} else if len(configured) != 0 {
				t.Fatal("unverified or incomplete challenge changed Browser configuration", configured)
			}
		})
	}
}

func TestLateTypedDecodeRetiresWithKnownACKAndReset(t *testing.T) {
	p := newPeer(t, "context", nil)
	m := newManager(t, p)
	deadline := time.Now().Add(20 * time.Millisecond)
	ctx := deadlineOnlyContext{context.Background(), deadline}
	err := m.call(ctx, "Target.getTargets", "", map[string]any{}, &deadlineDecode{deadline})
	var late *lateAcknowledgementError
	if !errors.As(err, &late) || !errors.Is(err, context.DeadlineExceeded) {
		t.Fatal("typed decoding crossed the budget and returned success", err)
	}
	done(t, m.Done())
	done(t, m.transport.readerDone)
	done(t, p.done)
	last := p.snapshot()[len(p.snapshot())-1]
	if last.Method != "Browser.setDownloadBehavior" || last.Params["eventsEnabled"] != false {
		t.Fatal("missing reset acknowledgement", last)
	}
}

package host

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"io"
	"net"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/ifuryst/open-browser-use/internal/browserdownloads"
	"github.com/ifuryst/open-browser-use/internal/transport"
	"github.com/ifuryst/open-browser-use/internal/wire"
)

type bindingFakeManager struct {
	mu                  sync.Mutex
	done, closed        chan struct{}
	stopOnce, closeOnce sync.Once
	generation          string
	calls               []string
	claims              []browserdownloads.Claim
	op                  func(context.Context, string, browserdownloads.Claim) error
	closing             chan struct{}
	closeGate           <-chan struct{}
}

func newBindingFake(generation string) *bindingFakeManager {
	return &bindingFakeManager{done: make(chan struct{}), closed: make(chan struct{}), generation: generation}
}
func (m *bindingFakeManager) Generation() string    { return m.generation }
func (m *bindingFakeManager) Done() <-chan struct{} { return m.done }
func (m *bindingFakeManager) Err() error            { return errors.New("native Browser EOF") }
func (m *bindingFakeManager) stop()                 { m.stopOnce.Do(func() { close(m.done) }) }
func (m *bindingFakeManager) call(ctx context.Context, operation string, claim browserdownloads.Claim) error {
	m.mu.Lock()
	m.calls = append(m.calls, operation)
	m.claims = append(m.claims, claim)
	m.mu.Unlock()
	if m.op != nil {
		return m.op(ctx, operation, claim)
	}
	return ctx.Err()
}
func (m *bindingFakeManager) Claim(ctx context.Context, c browserdownloads.Claim) error {
	return m.call(ctx, "claim", c)
}
func (m *bindingFakeManager) Path(ctx context.Context, c browserdownloads.Claim) (string, error) {
	return filepath.Join("native", "original.bin"), m.call(ctx, "path", c)
}
func (m *bindingFakeManager) Cancel(ctx context.Context, c browserdownloads.Claim) error {
	return m.call(ctx, "cancel", c)
}
func (m *bindingFakeManager) Release(c browserdownloads.Claim) {
	_ = m.call(context.Background(), "release", c)
}
func (m *bindingFakeManager) Close() error {
	m.closeOnce.Do(func() {
		m.stop()
		if m.closing != nil {
			close(m.closing)
		}
		if m.closeGate != nil {
			<-m.closeGate
		}
		close(m.closed)
	})
	return nil
}
func (m *bindingFakeManager) snapshot() ([]string, []browserdownloads.Claim) {
	m.mu.Lock()
	defer m.mu.Unlock()
	return append([]string(nil), m.calls...), append([]browserdownloads.Claim(nil), m.claims...)
}

type bindingFixture struct {
	relay    *Relay
	native   net.Conn
	events   chan map[string]any
	endpoint string
	sendMu   sync.Mutex
}

func newBindingFixture(t *testing.T, dial func(context.Context, string, browserdownloads.Identity) (pageDownloadManager, error), wrap func(io.Writer) io.Writer) *bindingFixture {
	t.Helper()
	hostInput, extensionOutput := net.Pipe()
	extensionInput, hostOutput := net.Pipe()
	var output io.Writer = hostOutput
	if wrap != nil {
		output = wrap(output)
	}
	dir := shortSocketDir(t)
	endpoint := transport.NewEndpoint(dir, filepath.Base(dir))
	r := NewRelay(Config{SocketDir: dir, SocketPath: endpoint}, hostInput, output)
	r.browserBinding.dial = dial
	f := &bindingFixture{relay: r, native: extensionOutput, events: make(chan map[string]any, 512), endpoint: endpoint}
	ctx, cancel := context.WithCancel(context.Background())
	ended := make(chan error, 1)
	go func() { ended <- r.Serve(ctx) }()
	readerDone := make(chan struct{})
	go func() {
		defer close(readerDone)
		for {
			var message map[string]any
			if wire.ReadJSON(extensionInput, &message) != nil {
				return
			}
			f.events <- message
		}
	}()
	waitForSocket(t, endpoint)
	t.Cleanup(func() {
		cancel()
		_ = extensionOutput.Close()
		_ = extensionInput.Close()
		_ = hostInput.Close()
		_ = hostOutput.Close()
		select {
		case <-ended:
		case <-time.After(3 * time.Second):
			t.Error("relay failed to close")
		}
		select {
		case <-readerDone:
		case <-time.After(time.Second):
			t.Error("native reader failed to close")
		}
	})
	return f
}
func (f *bindingFixture) client(t *testing.T) net.Conn {
	t.Helper()
	c, err := transport.DialTimeout(f.endpoint, time.Second)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = c.Close() })
	_ = c.SetDeadline(time.Now().Add(5 * time.Second))
	return c
}
func (f *bindingFixture) send(t *testing.T, params map[string]any) {
	t.Helper()
	params["version"] = 1
	f.sendMu.Lock()
	defer f.sendMu.Unlock()
	if err := wire.WriteJSON(f.native, map[string]any{"jsonrpc": "2.0", "method": pageDownloadsMethod, "params": params}); err != nil {
		t.Fatal(err)
	}
}
func (f *bindingFixture) next(t *testing.T, kind string) map[string]any {
	t.Helper()
	select {
	case message := <-f.events:
		if message["method"] != pageDownloadsMethod {
			t.Fatalf("unexpected native command: %v", message)
		}
		params := message["params"].(map[string]any)
		if params["type"] != kind {
			t.Fatalf("wanted %s, got %v", kind, params)
		}
		return params
	case <-time.After(3 * time.Second):
		t.Fatalf("no native %s", kind)
		return nil
	}
}
func (f *bindingFixture) answer(t *testing.T, challenge map[string]any) {
	f.send(t, map[string]any{"type": "response", "requestId": challenge["requestId"], "nonce": challenge["nonce"], "result": browserdownloads.Identity{Nonce: challenge["nonce"].(string), ExtensionID: strings.Repeat("a", 32), ExtensionInstanceID: "instance-original", WorkerBootID: "worker-original", PortID: "port-original"}})
}
func bindingRequest(id string, timeout int) map[string]any {
	return map[string]any{"jsonrpc": "2.0", "id": id, "method": "host.bindBrowser", "params": map[string]any{"cdpURL": "ws://127.0.0.1:9222/devtools/browser/original", "exclusive": true, "timeoutMs": timeout}}
}
func bindingWrite(t *testing.T, c net.Conn, message any) {
	t.Helper()
	if err := wire.WriteJSON(c, message); err != nil {
		t.Fatal(err)
	}
}
func bindingRead(t *testing.T, c net.Conn) map[string]any {
	t.Helper()
	var result map[string]any
	if err := wire.ReadJSON(c, &result); err != nil {
		t.Fatal(err)
	}
	return result
}
func bindingWait(t *testing.T, done <-chan struct{}, name string) {
	t.Helper()
	select {
	case <-done:
	case <-time.After(3 * time.Second):
		t.Fatalf("timed out: %s", name)
	}
}
func (f *bindingFixture) bind(t *testing.T, c net.Conn) map[string]any {
	bindingWrite(t, c, bindingRequest("bind", 2000))
	f.answer(t, f.next(t, "challenge"))
	ready := f.next(t, "ready")
	response := bindingRead(t, c)
	if ready["available"] != true || response["error"] != nil {
		t.Fatalf("binding failed: %v %v", ready, response)
	}
	return ready
}
func bindingClaim() browserdownloads.Claim {
	return browserdownloads.Claim{GUID: "original-guid", FrameID: "native-frame", RootTargetID: "root-target", SessionID: "session", TurnID: "turn", ControlEpoch: 7, TabID: 12, ClaimID: "claim-original"}
}
func (f *bindingFixture) operation(t *testing.T, ready map[string]any, id, operation string) {
	f.send(t, map[string]any{"type": "request", "requestId": id, "nonce": ready["nonce"], "generation": ready["generation"], "operation": operation, "payload": bindingClaim(), "timeoutMs": 1000})
}

func TestBrowserBindingPrivateOperationsAndCommittedClientEOF(t *testing.T) {
	m := newBindingFake("generation-one")
	f := newBindingFixture(t, func(_ context.Context, url string, identity browserdownloads.Identity) (pageDownloadManager, error) {
		if identity.PortID != "port-original" || !strings.Contains(url, "/browser/original") {
			t.Error("identity or URL changed")
		}
		return m, nil
	}, nil)
	c := f.client(t)
	observer := f.client(t)
	ready := f.bind(t, c)
	_ = c.Close()
	for _, operation := range []string{"claim", "path", "cancel", "release"} {
		f.operation(t, ready, operation, operation)
		reply := f.next(t, "reply")
		if reply["requestId"] != operation || reply["error"] != nil {
			t.Fatal(reply)
		}
	}
	calls, claims := m.snapshot()
	if strings.Join(calls, ",") != "claim,path,cancel,release" || len(claims) != 4 || claims[0] != bindingClaim() {
		t.Fatalf("scope or operations changed: %v %v", calls, claims)
	}
	select {
	case <-m.closed:
		t.Fatal("CLI exit closed committed Manager")
	default:
	}
	_ = observer.SetReadDeadline(time.Now().Add(35 * time.Millisecond))
	var leaked map[string]any
	if err := wire.ReadJSON(observer, &leaked); err == nil {
		t.Fatalf("private native payload leaked: %v", leaked)
	}
	_ = observer.SetDeadline(time.Now().Add(time.Second))
	bindingWrite(t, observer, map[string]any{"jsonrpc": "2.0", "id": "ordinary", "method": "getInfo"})
	message := <-f.events
	if message["method"] != "getInfo" {
		t.Fatal(message)
	}
	if err := wire.WriteJSON(f.native, map[string]any{"jsonrpc": "2.0", "id": message["id"], "result": map[string]any{"ordinary": true}}); err != nil {
		t.Fatal(err)
	}
	if bindingRead(t, observer)["id"] != "ordinary" {
		t.Fatal("ordinary routing broke")
	}
}

func TestBrowserBindingRejectsInvalidLocalRequestsAndPrivateSpoof(t *testing.T) {
	called := false
	f := newBindingFixture(t, func(context.Context, string, browserdownloads.Identity) (pageDownloadManager, error) {
		called = true
		return nil, errors.New("unexpected")
	}, nil)
	c := f.client(t)
	for _, edit := range []func(map[string]any){
		func(m map[string]any) { m["method"] = "host.unknown" }, func(m map[string]any) { delete(m, "id") }, func(m map[string]any) { m["id"] = nil },
		func(m map[string]any) { m["params"].(map[string]any)["exclusive"] = false }, func(m map[string]any) { m["params"].(map[string]any)["timeoutMs"] = 0 },
		func(m map[string]any) {
			m["params"].(map[string]any)["cdpURL"] = "ws://example.com:9222/devtools/browser/id"
		},
		func(m map[string]any) { m["params"].(map[string]any)["session_id"] = "forged" }, func(m map[string]any) { m["method"] = pageDownloadsMethod },
	} {
		message := bindingRequest("invalid", 1000)
		edit(message)
		bindingWrite(t, c, message)
		if bindingRead(t, c)["error"] == nil {
			t.Fatal("invalid request accepted")
		}
	}
	if called {
		t.Fatal("invalid input reached Browser dial")
	}
	select {
	case message := <-f.events:
		t.Fatalf("invalid request reached native port: %v", message)
	default:
	}
}

func TestBrowserBindingClientEOFCancelsSetupAndClosesLateManager(t *testing.T) {
	m := newBindingFake("late")
	dialed, canceled, release := make(chan struct{}), make(chan struct{}), make(chan struct{})
	f := newBindingFixture(t, func(ctx context.Context, _ string, _ browserdownloads.Identity) (pageDownloadManager, error) {
		close(dialed)
		<-ctx.Done()
		close(canceled)
		<-release
		return m, nil
	}, nil)
	c := f.client(t)
	bindingWrite(t, c, bindingRequest("bind", 2000))
	f.answer(t, f.next(t, "challenge"))
	bindingWait(t, dialed, "dial started")
	_ = c.Close()
	bindingWait(t, canceled, "setup cancellation")
	close(release)
	bindingWait(t, m.closed, "late Manager cleanup")
	ready := f.next(t, "ready")
	if ready["available"] != false {
		t.Fatal("late setup revived capability", ready)
	}
}

type bindingHeldWriter struct {
	io.Writer
	entered, release chan struct{}
	once             sync.Once
}

// A deadline can pass before its cancellation timer is scheduled. Keep Done
// open and Err nil during that interval so the write-result branch is selected
// deterministically; callers must still enforce the original wall-clock bound.
type bindingDelayedDeadlineContext struct {
	context.Context
	deadline time.Time
	notified <-chan struct{}
}

func (c bindingDelayedDeadlineContext) Deadline() (time.Time, bool) { return c.deadline, true }
func (c bindingDelayedDeadlineContext) Done() <-chan struct{}       { return c.notified }
func (c bindingDelayedDeadlineContext) Err() error {
	select {
	case <-c.notified:
		return context.DeadlineExceeded
	default:
		return nil
	}
}

type bindingWriterFunc func([]byte) (int, error)

func (f bindingWriterFunc) Write(p []byte) (int, error) { return f(p) }

func TestBrowserBindingCompletedNativeWriteRechecksOriginalDeadline(t *testing.T) {
	for _, writeFails := range []bool{false, true} {
		t.Run(fmt.Sprintf("writeFailure=%t", writeFails), func(t *testing.T) {
			notified := make(chan struct{})
			defer close(notified)
			ctx := bindingDelayedDeadlineContext{Context: context.Background(), deadline: time.Now().Add(100 * time.Millisecond), notified: notified}
			writeFailure := errors.New("original native write failure")
			var received bytes.Buffer
			r := NewRelay(Config{}, strings.NewReader(""), bindingWriterFunc(func(p []byte) (int, error) {
				<-time.After(time.Until(ctx.deadline))
				if writeFails {
					return 0, writeFailure
				}
				return received.Write(p)
			}))
			written := make(chan struct{})
			err := r.browserBinding.sendTracked(ctx, map[string]any{"type": "ready", "available": true}, nil, written)
			bindingWait(t, written, "actual write receipt")
			if writeFails {
				if !errors.Is(err, writeFailure) {
					t.Fatalf("native write error was lost: %v", err)
				}
				return
			}
			var message map[string]any
			if readErr := wire.ReadJSON(&received, &message); readErr != nil {
				t.Fatalf("ready was not actually written: %v", readErr)
			}
			if message["method"] != pageDownloadsMethod || message["params"].(map[string]any)["available"] != true || received.Len() != 0 {
				t.Fatalf("unexpected actual native frame: %v", message)
			}
			if !errors.Is(err, context.DeadlineExceeded) {
				t.Fatalf("completed native write bypassed its original deadline: %v", err)
			}
		})
	}
}

func TestBrowserBindingQueuedNativeWriteCannotOutliveOriginalDeadline(t *testing.T) {
	notified := make(chan struct{})
	defer close(notified)
	ctx := bindingDelayedDeadlineContext{Context: context.Background(), deadline: time.Now().Add(100 * time.Millisecond), notified: notified}
	var received bytes.Buffer
	r := NewRelay(Config{}, strings.NewReader(""), &received)
	r.writeMu.Lock()
	written := make(chan struct{})
	ended := make(chan error, 1)
	go func() {
		ended <- r.browserBinding.sendTracked(ctx, map[string]any{"type": "ready", "available": true}, nil, written)
	}()
	<-time.After(time.Until(ctx.deadline))
	r.writeMu.Unlock()
	var err error
	select {
	case err = <-ended:
	case <-time.After(3 * time.Second):
		t.Fatal("expired queued write did not terminate")
	}
	bindingWait(t, written, "queued write terminates without invoking native")
	if received.Len() != 0 || !errors.Is(err, context.DeadlineExceeded) {
		t.Fatalf("queued write exceeded its deadline: error=%v nativeBytes=%d", err, received.Len())
	}
}

func (w *bindingHeldWriter) Write(p []byte) (int, error) {
	if bytes.Contains(p, []byte(`"available":true`)) {
		w.once.Do(func() { close(w.entered); <-w.release })
	}
	return w.Writer.Write(p)
}
func TestBrowserBindingClientEOFAfterCommitDoesNotCancelReady(t *testing.T) {
	m := newBindingFake("committed")
	held := &bindingHeldWriter{entered: make(chan struct{}), release: make(chan struct{})}
	f := newBindingFixture(t, func(context.Context, string, browserdownloads.Identity) (pageDownloadManager, error) { return m, nil }, func(w io.Writer) io.Writer { held.Writer = w; return held })
	c := f.client(t)
	bindingWrite(t, c, bindingRequest("bind", 2000))
	f.answer(t, f.next(t, "challenge"))
	bindingWait(t, held.entered, "ready write entered")
	_ = c.Close()
	close(held.release)
	ready := f.next(t, "ready")
	if ready["available"] != true {
		t.Fatal(ready)
	}
	f.operation(t, ready, "after-close", "path")
	if f.next(t, "reply")["error"] != nil {
		t.Fatal("postcommit path failed")
	}
	select {
	case <-m.closed:
		t.Fatal("postcommit CLI EOF closed binding")
	default:
	}
}

func TestBrowserBindingTimedOutNativeReadyWritesRevocationAfterActualCompletion(t *testing.T) {
	m := newBindingFake("late-ready")
	held := &bindingHeldWriter{entered: make(chan struct{}), release: make(chan struct{})}
	f := newBindingFixture(t, func(context.Context, string, browserdownloads.Identity) (pageDownloadManager, error) { return m, nil }, func(w io.Writer) io.Writer { held.Writer = w; return held })
	c := f.client(t)
	bindingWrite(t, c, bindingRequest("expires-ready", 100))
	f.answer(t, f.next(t, "challenge"))
	bindingWait(t, held.entered, "actual ready write entered")
	response := bindingRead(t, c)
	if response["error"] == nil {
		t.Fatal("ready timeout claimed success")
	}
	bindingWait(t, m.closed, "manager closed before unknown native write finishes")
	bindingWrite(t, c, bindingRequest("replacement", 1000))
	if bindingRead(t, c)["error"] == nil {
		t.Fatal("replacement passed pending native write")
	}
	close(held.release)
	late := f.next(t, "ready")
	revoked := f.next(t, "ready")
	if late["available"] != true || revoked["available"] != false || late["nonce"] != revoked["nonce"] || late["generation"] != revoked["generation"] {
		t.Fatalf("late ready not followed by exact revocation: %v %v", late, revoked)
	}
}

func TestBrowserBindingCanceledLateSetupKeepsSlotUntilActualClose(t *testing.T) {
	m := newBindingFake("late-cleanup")
	gate := make(chan struct{})
	m.closing = make(chan struct{})
	m.closeGate = gate
	dialed := make(chan struct{})
	f := newBindingFixture(t, func(ctx context.Context, _ string, _ browserdownloads.Identity) (pageDownloadManager, error) {
		close(dialed)
		<-ctx.Done()
		return m, nil
	}, nil)
	c := f.client(t)
	bindingWrite(t, c, bindingRequest("first", 1000))
	f.answer(t, f.next(t, "challenge"))
	bindingWait(t, dialed, "setup entered")
	_ = c.Close()
	bindingWait(t, m.closing, "late setup cleanup")
	other := f.client(t)
	bindingWrite(t, other, bindingRequest("replacement", 1000))
	if bindingRead(t, other)["error"] == nil {
		t.Fatal("new binding raced old late setup cleanup")
	}
	close(gate)
	bindingWait(t, m.closed, "cleanup actually completed")
	if f.next(t, "ready")["available"] != false {
		t.Fatal("late setup did not remain unavailable")
	}
}

func TestBrowserBindingChallengeNonceAndConcurrentAttempt(t *testing.T) {
	m := newBindingFake("fresh")
	f := newBindingFixture(t, func(context.Context, string, browserdownloads.Identity) (pageDownloadManager, error) { return m, nil }, nil)
	first, second := f.client(t), f.client(t)
	bindingWrite(t, first, bindingRequest("first", 2000))
	challenge := f.next(t, "challenge")
	bindingWrite(t, second, bindingRequest("second", 2000))
	if failure := bindingRead(t, second)["error"]; failure == nil || !strings.Contains(fmt.Sprint(failure), "BUSY") {
		t.Fatal(failure)
	}
	fake := map[string]any{}
	for k, v := range challenge {
		fake[k] = v
	}
	fake["nonce"] = "wrong-nonce"
	f.answer(t, fake)
	f.answer(t, challenge)
	ready := f.next(t, "ready")
	if ready["available"] != true || bindingRead(t, first)["error"] != nil {
		t.Fatal("correct challenge not admitted")
	}
	bindingWrite(t, second, bindingRequest("replace", 2000))
	if failure := bindingRead(t, second)["error"]; failure == nil {
		t.Fatal("replaced live binding")
	}
}

func TestBrowserBindingBrowserEOFWaitsForCleanupBeforeRebind(t *testing.T) {
	gate := make(chan struct{})
	first := newBindingFake("first")
	first.closing = make(chan struct{})
	first.closeGate = gate
	second := newBindingFake("second")
	calls := 0
	f := newBindingFixture(t, func(context.Context, string, browserdownloads.Identity) (pageDownloadManager, error) {
		calls++
		if calls == 1 {
			return first, nil
		}
		return second, nil
	}, nil)
	c := f.client(t)
	oldReady := f.bind(t, c)
	first.stop()
	bindingWait(t, first.closing, "old cleanup entered")
	bindingWrite(t, c, bindingRequest("during-cleanup", 2000))
	if bindingRead(t, c)["error"] == nil {
		t.Fatal("rebind raced old reset")
	}
	close(gate)
	if ready := f.next(t, "ready"); ready["available"] != false || ready["generation"] != "first" {
		t.Fatal(ready)
	}
	// The previous ready:false write completes before the watcher clears its
	// binding; wait for that local transition rather than guessing a sleep.
	deadline := time.Now().Add(time.Second)
	for {
		f.relay.browserBinding.mu.Lock()
		cleared := f.relay.browserBinding.current == nil
		f.relay.browserBinding.mu.Unlock()
		if cleared {
			break
		}
		if time.Now().After(deadline) {
			t.Fatal("old binding not cleared")
		}
		time.Sleep(time.Millisecond)
	}
	newReady := f.bind(t, c)
	if oldReady["nonce"] == newReady["nonce"] || oldReady["generation"] == newReady["generation"] {
		t.Fatal("binding identity reused")
	}
	f.operation(t, oldReady, "stale", "claim")
	f.operation(t, newReady, "fresh", "claim")
	if reply := f.next(t, "reply"); reply["requestId"] != "fresh" {
		t.Fatal(reply)
	}
	got, _ := second.snapshot()
	if len(got) != 1 {
		t.Fatalf("old claim reached new Browser: %v", got)
	}
}

func TestBrowserBindingNativeEOFCancelsPendingPathAndClosesManager(t *testing.T) {
	m := newBindingFake("native-loss")
	entered, canceled := make(chan struct{}), make(chan struct{})
	m.op = func(ctx context.Context, op string, _ browserdownloads.Claim) error {
		if op == "path" {
			close(entered)
			<-ctx.Done()
			close(canceled)
			return ctx.Err()
		}
		return nil
	}
	f := newBindingFixture(t, func(context.Context, string, browserdownloads.Identity) (pageDownloadManager, error) { return m, nil }, nil)
	ready := f.bind(t, f.client(t))
	f.operation(t, ready, "pending", "path")
	bindingWait(t, entered, "pending path")
	_ = f.native.Close()
	bindingWait(t, canceled, "pending path canceled")
	bindingWait(t, m.closed, "native EOF Manager close")
}

func TestBrowserBindingDuplicateAndCapacityDoNotReplayOrBlockNativeReader(t *testing.T) {
	m := newBindingFake("bounded")
	entered := make(chan struct{}, maxPageDownloadPending)
	m.op = func(ctx context.Context, op string, _ browserdownloads.Claim) error {
		if op == "path" {
			entered <- struct{}{}
			<-ctx.Done()
			return ctx.Err()
		}
		return nil
	}
	f := newBindingFixture(t, func(context.Context, string, browserdownloads.Identity) (pageDownloadManager, error) { return m, nil }, nil)
	ready := f.bind(t, f.client(t))
	for i := 0; i < maxPageDownloadPending; i++ {
		f.operation(t, ready, fmt.Sprint(i), "path")
		bindingWait(t, entered, "path accepted")
	}
	f.operation(t, ready, "0", "path")
	f.operation(t, ready, "overflow", "path")
	reply := f.next(t, "reply")
	if reply["requestId"] != "overflow" || !strings.Contains(fmt.Sprint(reply["error"]), "CAPACITY") {
		t.Fatal(reply)
	}
	// Reader remains free to receive a scoped ordinary notification while all
	// private operations are pending. Its lack of subscribers is intentional.
	if err := wire.WriteJSON(f.native, map[string]any{"jsonrpc": "2.0", "method": "heartbeat", "params": map[string]any{}}); err != nil {
		t.Fatal(err)
	}
	got, _ := m.snapshot()
	if len(got) != maxPageDownloadPending {
		t.Fatalf("private operation replayed: %d", len(got))
	}
	f.relay.browserBinding.close()
}

func TestBrowserBindingExpiredQueuedChallengeNeverWritesLater(t *testing.T) {
	f := newBindingFixture(t, func(context.Context, string, browserdownloads.Identity) (pageDownloadManager, error) {
		t.Error("unexpected dial")
		return nil, errors.New("unexpected")
	}, nil)
	c := f.client(t)
	f.relay.writeMu.Lock()
	bindingWrite(t, c, bindingRequest("expires", 35))
	response := bindingRead(t, c)
	f.relay.writeMu.Unlock()
	if response["error"] == nil {
		t.Fatal("queued expired challenge accepted")
	}
	bindingWrite(t, c, map[string]any{"jsonrpc": "2.0", "id": "barrier", "method": "getInfo"})
	select {
	case got := <-f.events:
		if got["method"] != "getInfo" {
			t.Fatal("expired challenge wrote after its deadline", got)
		}
	case <-time.After(time.Second):
		t.Fatal("writer did not drain")
	}
}

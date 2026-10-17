package managedviewer

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/url"
	"os"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/coder/websocket"
)

var goodState = json.RawMessage(`{"status":{"connected":true,"eventSequence":0,"cleanupPending":0,"automation":{"state":"running","inputBlocked":false,"revision":7,"cleanupComplete":false},"workerBootId":"worker-a","selectedTabId":null,"tabs":[{"id":1,"title":"A page","url":"https://example.test"}]}}`)

type testBackend struct {
	events  chan json.RawMessage
	done    chan struct{}
	calls   chan json.RawMessage
	command func(context.Context, json.RawMessage) (json.RawMessage, error)
}

func newBackend() *testBackend {
	return &testBackend{events: make(chan json.RawMessage, 128), done: make(chan struct{}), calls: make(chan json.RawMessage, 128)}
}
func (b *testBackend) Events() <-chan json.RawMessage { return b.events }
func (b *testBackend) Done() <-chan struct{}          { return b.done }
func (b *testBackend) Command(ctx context.Context, data json.RawMessage) (json.RawMessage, error) {
	b.calls <- append(json.RawMessage(nil), data...)
	if b.command != nil {
		return b.command(ctx, data)
	}
	return goodState, nil
}

func startTest(t *testing.T, b *testBackend, stop func(context.Context) error) *Server {
	t.Helper()
	if stop == nil {
		stop = func(context.Context) error { return nil }
	}
	s, err := Start(Config{RunID: "test-run", Backend: b, Stop: stop})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		if err := s.Close(ctx); err != nil {
			t.Error(err)
		}
	})
	return s
}

func dialViewer(t *testing.T, s *Server, ticketURL string) *websocket.Conn {
	t.Helper()
	u, err := url.Parse(ticketURL)
	if err != nil {
		t.Fatal(err)
	}
	fragment, _ := url.ParseQuery(u.Fragment)
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()
	c, _, err := websocket.Dial(ctx, "ws://"+u.Host+"/ws", &websocket.DialOptions{HTTPHeader: http.Header{"Origin": {s.origin}}})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = c.CloseNow() })
	if err := c.Write(ctx, websocket.MessageText, jsonBytes(map[string]any{"type": "authenticate", "token": fragment.Get("ticket")})); err != nil {
		t.Fatal(err)
	}
	return c
}

func readMessage(t *testing.T, c *websocket.Conn) map[string]json.RawMessage {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()
	_, data, err := c.Read(ctx)
	if err != nil {
		t.Fatal(err)
	}
	var result map[string]json.RawMessage
	if json.Unmarshal(data, &result) != nil {
		t.Fatalf("bad JSON: %s", data)
	}
	return result
}

func authenticate(t *testing.T, s *Server) *websocket.Conn {
	t.Helper()
	c := dialViewer(t, s, s.URL())
	m := readMessage(t, c)
	if string(m["type"]) != `"authenticated"` {
		t.Fatalf("unexpected reply: %v", m)
	}
	return c
}

func send(t *testing.T, c *websocket.Conn, data string) {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()
	if err := c.Write(ctx, websocket.MessageText, []byte(data)); err != nil {
		t.Fatal(err)
	}
}

func waitCall(t *testing.T, b *testBackend) json.RawMessage {
	t.Helper()
	select {
	case call := <-b.calls:
		return call
	case <-time.After(3 * time.Second):
		t.Fatal("missing backend call")
		return nil
	}
}

func waitNoActive(t *testing.T, s *Server) {
	t.Helper()
	deadline := time.Now().Add(3 * time.Second)
	for time.Now().Before(deadline) {
		s.mu.Lock()
		empty := s.active == nil
		s.mu.Unlock()
		if empty {
			return
		}
		time.Sleep(time.Millisecond)
	}
	t.Fatal("original viewer cleanup did not finish")
}

func TestShellHasNoCapabilityAndEnforcesHost(t *testing.T) {
	s := startTest(t, newBackend(), nil)
	response, err := http.Get(s.origin + "/")
	if err != nil {
		t.Fatal(err)
	}
	body, _ := io.ReadAll(response.Body)
	response.Body.Close()
	if response.StatusCode != 200 || strings.Contains(string(body), strings.Split(s.URL(), "#")[1]) {
		t.Fatal("shell exposed ticket or failed")
	}
	for key, value := range map[string]string{"Cache-Control": "no-store", "Referrer-Policy": "no-referrer", "X-Frame-Options": "DENY", "X-Content-Type-Options": "nosniff"} {
		if response.Header.Get(key) != value {
			t.Errorf("%s missing", key)
		}
	}
	if !strings.Contains(response.Header.Get("Content-Security-Policy"), "frame-ancestors 'none'") || response.Header.Get("Access-Control-Allow-Origin") != "" {
		t.Fatal("unsafe origin headers")
	}
	for _, path := range []string{"/?ticket=secret", "/ws?token=secret", "/../viewer.js"} {
		r, e := http.Get(s.origin + path)
		if e != nil {
			t.Fatal(e)
		}
		r.Body.Close()
		if r.StatusCode == 200 {
			t.Fatalf("unexpected public path: %s", path)
		}
	}
	req, _ := http.NewRequest("GET", s.origin+"/", nil)
	req.Host = "attacker.test"
	r, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	r.Body.Close()
	if r.StatusCode != 403 {
		t.Fatal("rebound Host accepted")
	}
}

func TestWebSocketRequiresExactOrigin(t *testing.T) {
	s := startTest(t, newBackend(), nil)
	for _, origin := range []string{"", "null", "https://evil.test", strings.Replace(s.origin, "127.0.0.1", "localhost", 1)} {
		ctx, cancel := context.WithTimeout(context.Background(), time.Second)
		c, r, err := websocket.Dial(ctx, strings.Replace(s.origin, "http:", "ws:", 1)+"/ws", &websocket.DialOptions{HTTPHeader: http.Header{"Origin": {origin}}})
		cancel()
		if c != nil {
			c.CloseNow()
		}
		if err == nil || r == nil || r.StatusCode != 403 {
			t.Errorf("origin accepted: %q", origin)
		}
	}
	authenticate(t, s)
}

func TestTicketsRotateExpireAndAreSingleUse(t *testing.T) {
	s := startTest(t, newBackend(), nil)
	old := s.URL()
	fresh, err := s.IssueURL()
	if err != nil || fresh == old {
		t.Fatal("ticket not rotated")
	}
	c := dialViewer(t, s, old)
	ctx, cancel := context.WithTimeout(context.Background(), time.Second)
	_, _, err = c.Read(ctx)
	cancel()
	if err == nil {
		t.Fatal("old ticket accepted")
	}
	c = authenticate(t, s)
	if _, err := s.IssueURL(); err == nil {
		t.Fatal("active viewer replaced")
	}
	_ = c.CloseNow()
	waitNoActive(t, s)
	replay := dialViewer(t, s, fresh)
	ctx, cancel = context.WithTimeout(context.Background(), time.Second)
	_, _, err = replay.Read(ctx)
	cancel()
	if err == nil {
		t.Fatal("consumed ticket replayed")
	}
	if _, err := s.IssueURL(); err != nil {
		t.Fatal(err)
	}
	s.mu.Lock()
	s.expires = time.Now().Add(-time.Second)
	s.mu.Unlock()
	expired := dialViewer(t, s, s.URL())
	ctx, cancel = context.WithTimeout(context.Background(), time.Second)
	_, _, err = expired.Read(ctx)
	cancel()
	if err == nil {
		t.Fatal("expired ticket accepted")
	}
}

func TestTypedCommandsAndPublicProjection(t *testing.T) {
	b := newBackend()
	b.command = func(_ context.Context, _ json.RawMessage) (json.RawMessage, error) {
		return json.RawMessage(`{"status":{"connected":true,"eventSequence":0,"cleanupPending":0,"automation":{"state":"paused","inputBlocked":true,"revision":8,"cleanupComplete":true,"secret":"hidden"},"workerBootId":"worker-a","tabs":[],"selectedTabId":null,"channelId":"SECRET","socketPath":"PRIVATE"}}`), nil
	}
	s := startTest(t, b, nil)
	c := authenticate(t, s)
	send(t, c, `{"id":1,"operation":"resume","expectedRevision":8,"expectedWorkerBootId":"worker-a"}`)
	call := waitCall(t, b)
	if strings.Contains(string(call), `"id"`) || !strings.Contains(string(call), `"expectedRevision":8`) {
		t.Fatalf("wrong backend call: %s", call)
	}
	m := readMessage(t, c)
	all := string(jsonBytes(m))
	if string(m["id"]) != "1" || strings.Contains(all, "SECRET") || strings.Contains(all, "PRIVATE") || strings.Contains(all, "hidden") {
		t.Fatalf("private backend data leaked: %s", all)
	}
}

func TestInvalidOrRepeatedCommandsNeverDispatch(t *testing.T) {
	for _, bad := range []string{
		`{"id":1,"operation":"status","token":"x"}`,
		`{"id":1,"operation":"status","operation":"pause"}`,
		`{"id":1,"operation":"evaluate","expression":"1"}`,
		`{"id":1,"operation":"resume","expectedRevision":1}`,
		`{"id":1,"operation":"select"}`,
		`{"id":1,"operation":"select","tabId":-1}`,
		`{"id":1,"operation":"status"} {}`,
	} {
		t.Run(bad, func(t *testing.T) {
			b := newBackend()
			s := startTest(t, b, nil)
			c := authenticate(t, s)
			send(t, c, bad)
			ctx, cancel := context.WithTimeout(context.Background(), time.Second)
			_, _, err := c.Read(ctx)
			cancel()
			if err == nil {
				t.Fatal("bad request kept connection")
			}
			call := waitCall(t, b)
			if !strings.Contains(string(call), `"tabId":null`) {
				t.Fatalf("invalid operation dispatched: %s", call)
			}
		})
	}
	b := newBackend()
	s := startTest(t, b, nil)
	c := authenticate(t, s)
	send(t, c, `{"id":2,"operation":"pause"}`)
	waitCall(t, b)
	readMessage(t, c)
	send(t, c, `{"id":2,"operation":"pause"}`)
	call := waitCall(t, b)
	if !strings.Contains(string(call), `"tabId":null`) {
		t.Fatalf("replay dispatched: %s", call)
	}
}

func TestStopSurvivesBackendLossAndUsesSupervisor(t *testing.T) {
	b := newBackend()
	var count atomic.Int32
	s := startTest(t, b, func(context.Context) error { count.Add(1); return nil })
	c := authenticate(t, s)
	close(b.done)
	send(t, c, `{"id":1,"operation":"stop"}`)
	for {
		m := readMessage(t, c)
		if string(m["type"]) == `"response"` {
			if !strings.Contains(string(m["result"]), `"stopped":true`) {
				t.Fatalf("stop not acknowledged: %v", m)
			}
			break
		}
	}
	if count.Load() != 1 {
		t.Fatal("stop did not use supervisor")
	}
	select {
	case <-s.Done():
		t.Fatal("backend loss closed viewer stop endpoint")
	default:
	}
}

func TestStopDoesNotWaitForHungStatus(t *testing.T) {
	b := newBackend()
	entered := make(chan struct{})
	release := make(chan struct{})
	var once sync.Once
	b.command = func(ctx context.Context, data json.RawMessage) (json.RawMessage, error) {
		if strings.Contains(string(data), `"status"`) {
			once.Do(func() { close(entered) })
			<-release
		}
		return goodState, nil
	}
	stopped := make(chan struct{})
	s := startTest(t, b, func(context.Context) error { close(stopped); return nil })
	c := authenticate(t, s)
	send(t, c, `{"id":1,"operation":"status"}`)
	<-entered
	send(t, c, `{"id":2,"operation":"stop"}`)
	select {
	case <-stopped:
	case <-time.After(time.Second):
		close(release)
		t.Fatal("stop blocked behind status")
	}
	close(release)
}

func TestDisconnectWaitsForOriginalUnsubscribe(t *testing.T) {
	b := newBackend()
	entered := make(chan struct{})
	release := make(chan struct{})
	var once sync.Once
	b.command = func(_ context.Context, data json.RawMessage) (json.RawMessage, error) {
		if strings.Contains(string(data), `"tabId":null`) {
			once.Do(func() { close(entered) })
			<-release
		}
		return goodState, nil
	}
	s := startTest(t, b, nil)
	c := authenticate(t, s)
	c.CloseNow()
	<-entered
	if _, err := s.IssueURL(); err == nil {
		close(release)
		t.Fatal("new viewer admitted before old capture released")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Millisecond)
	defer cancel()
	if err := s.Close(ctx); !errors.Is(err, context.DeadlineExceeded) {
		close(release)
		t.Fatalf("Close forgot original cleanup: %v", err)
	}
	select {
	case <-s.Done():
		close(release)
		t.Fatal("Done before cleanup")
	default:
	}
	close(release)
	select {
	case <-s.Done():
	case <-time.After(time.Second):
		t.Fatal("cleanup never completed")
	}
}

func TestLatestFrameDoesNotBlockControlOrExposePrivateIdentity(t *testing.T) {
	b := newBackend()
	s := startTest(t, b, nil)
	c := authenticate(t, s)
	b.events <- json.RawMessage(`{"type":"frame","data":"aW1hZ2U=","mimeType":"image/png","tabId":1,"streamId":"s","sequence":9,"frameSequence":1,"metadata":{"deviceWidth":20,"private":"secret"},"channelId":"SECRET","portId":"PRIVATE"}`)
	m := readMessage(t, c)
	all := string(jsonBytes(m))
	if string(m["type"]) != `"frame"` || strings.Contains(all, "SECRET") || strings.Contains(all, "PRIVATE") || strings.Contains(all, "secret") {
		t.Fatalf("bad public frame: %s", all)
	}
	queue := make(chan json.RawMessage, 1)
	for i := 0; i < 10000; i++ {
		latest(queue, jsonBytes(i))
	}
	if len(queue) != 1 || string(<-queue) != "9999" {
		t.Fatal("latest frame queue grew or retained stale image")
	}
	send(t, c, `{"id":1,"operation":"pause"}`)
	call := waitCall(t, b)
	if !strings.Contains(string(call), `"pause"`) {
		t.Fatal("pause did not dispatch")
	}
	readMessage(t, c)
}

func TestBackendErrorsDoNotLeakSecrets(t *testing.T) {
	b := newBackend()
	b.command = func(_ context.Context, data json.RawMessage) (json.RawMessage, error) {
		if strings.Contains(string(data), `"tabId":null`) {
			return goodState, nil
		}
		return nil, errors.New("secret-token; C:\\Users\\private; evaluate(nonce)")
	}
	s := startTest(t, b, nil)
	c := authenticate(t, s)
	send(t, c, `{"id":1,"operation":"pause"}`)
	m := readMessage(t, c)
	if m["error"] == nil || strings.Contains(string(jsonBytes(m)), "secret-token") {
		t.Fatal("backend error leaked")
	}
}

func TestUnsubscribeFailureRetainsAdmissionBarrier(t *testing.T) {
	b := newBackend()
	b.command = func(context.Context, json.RawMessage) (json.RawMessage, error) {
		return nil, errors.New("native cleanup failed")
	}
	s, err := Start(Config{RunID: "cleanup-failure", Backend: b, Stop: func(context.Context) error { return nil }})
	if err != nil {
		t.Fatal(err)
	}
	c := authenticate(t, s)
	c.CloseNow()
	waitNoActive(t, s)
	if _, err := s.IssueURL(); err == nil {
		t.Error("new viewer admitted after failed cleanup")
	}
	ctx, cancel := context.WithTimeout(context.Background(), time.Second)
	defer cancel()
	if err := s.Close(ctx); err == nil {
		t.Error("cleanup failure disappeared")
	}
}

func TestStopReplyWaitsForActualWrite(t *testing.T) {
	b := newBackend()
	entered := make(chan struct{})
	release := make(chan struct{})
	s := startTest(t, b, func(context.Context) error { close(entered); <-release; return nil })
	if err := s.WaitStopReply(context.Background()); err != nil {
		t.Fatal(err)
	}
	c := authenticate(t, s)
	send(t, c, `{"id":1,"operation":"stop"}`)
	<-entered
	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Millisecond)
	if err := s.WaitStopReply(ctx); !errors.Is(err, context.DeadlineExceeded) {
		t.Fatalf("early stop delivery: %v", err)
	}
	cancel()
	close(release)
	m := readMessage(t, c)
	if !strings.Contains(string(m["result"]), `"stopped":true`) {
		t.Fatal("stop result missing")
	}
	ctx, cancel = context.WithTimeout(context.Background(), time.Second)
	defer cancel()
	if err := s.WaitStopReply(ctx); err != nil {
		t.Fatal(err)
	}
}

func TestLostStopReplyIsNotSuccessfulDelivery(t *testing.T) {
	b := newBackend()
	entered := make(chan struct{})
	release := make(chan struct{})
	s := startTest(t, b, func(context.Context) error { close(entered); <-release; return nil })
	c := authenticate(t, s)
	send(t, c, `{"id":1,"operation":"stop"}`)
	<-entered
	c.CloseNow()
	// Observe the original reader's cancellation before the supervisor finishes.
	s.mu.Lock()
	original := s.active
	s.mu.Unlock()
	select {
	case <-original.ctx.Done():
	case <-time.After(time.Second):
		t.Fatal("disconnect not observed")
	}
	close(release)
	ctx, cancel := context.WithTimeout(context.Background(), time.Second)
	defer cancel()
	if err := s.WaitStopReply(ctx); err == nil {
		t.Fatal("lost stop reply reported as delivered")
	}
}

func TestActualManagedBridgeFixtureProjectsOnlyPublicSchema(t *testing.T) {
	data, err := os.ReadFile("testdata/bridge-fixture.json")
	if err != nil {
		t.Fatal(err)
	}
	var fixture map[string]json.RawMessage
	if json.Unmarshal(data, &fixture) != nil {
		t.Fatal("bad fixture")
	}
	for _, name := range []string{"open", "select", "status", "pause", "resume"} {
		result, err := publicState(fixture[name])
		if err != nil {
			t.Fatalf("actual bridge %s: %v", name, err)
		}
		for _, private := range []string{"channelId", "runId", "extensionId", "extensionInstanceId", "portId", "expiresAt", "leaseMs"} {
			if strings.Contains(string(result), `"`+private+`"`) {
				t.Fatalf("%s leaked %s", name, private)
			}
		}
	}
	if _, err := publicState(fixture["disconnect"]); err == nil {
		t.Fatal("disconnected bridge authorized")
	}
	var events []json.RawMessage
	if json.Unmarshal(fixture["events"], &events) != nil {
		t.Fatal("bad events")
	}
	counts := map[string]int{}
	for _, event := range events {
		_, public, err := publicEvent(event)
		if err != nil {
			t.Fatalf("actual bridge event: %v: %s", err, event)
		}
		var value map[string]json.RawMessage
		_ = json.Unmarshal(public, &value)
		counts[string(value["type"])]++
		if value["channelId"] != nil || value["portId"] != nil || value["runId"] != nil {
			t.Fatal("private event identity leaked")
		}
	}
	for _, kind := range []string{`"state"`, `"frame"`, `"clear"`, `"unavailable"`} {
		if counts[kind] == 0 {
			t.Errorf("fixture missing %s", kind)
		}
	}
	if _, err := publicState([]byte(`{"status":{"state":"running","revision":0,"inputBlocked":false,"cleanupComplete":false},"workerBootId":"worker"}`)); err == nil {
		t.Fatal("ambiguous alternate input schema accepted")
	}
}

func TestCoalescedStateAndLateRepliesCarryOriginalRetirement(t *testing.T) {
	c := &connection{frames: make(chan json.RawMessage, 1)}
	c.frames <- json.RawMessage(`{"type":"frame","eventSequence":4}`)
	c.displayData(json.RawMessage(`{"type":"clear","eventSequence":5}`))
	if len(c.frames) != 0 {
		t.Fatal("retired queued frame survived Clear")
	}
	for _, snapshot := range []uint64{7, 4} {
		data := c.displayData(jsonBytes(map[string]any{"type": "state", "eventSequence": snapshot, "selectedTabId": 1, "status": map[string]any{"state": "running"}}))
		var fields map[string]json.RawMessage
		_ = json.Unmarshal(data, &fields)
		if string(fields["retiredSequence"]) != "5" {
			t.Fatalf("retirement lost after state coalescing/reply race: %s", data)
		}
	}
}

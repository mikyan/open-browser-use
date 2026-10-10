package host

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"log/slog"
	"net"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/ifuryst/open-browser-use/internal/transport"
	"github.com/ifuryst/open-browser-use/internal/wire"
)

type observingListener struct {
	net.Listener
	accepted chan *observedWriteConn
}

func (l *observingListener) Accept() (net.Conn, error) {
	conn, err := l.Listener.Accept()
	if err != nil {
		return nil, err
	}
	observed := observeWrites(conn, 1<<20)
	l.accepted <- observed
	return observed, nil
}

func TestRelaySlowLocalClientCannotBlockAnotherSession(t *testing.T) {
	// Use the production platform transport: named pipes on Windows, Unix
	// sockets elsewhere. The idle peer really stops reading, not a fake Write.
	socketDir := shortSocketDir(t)
	endpoint := transport.NewEndpoint(socketDir, filepath.Base(socketDir))
	listener, err := transport.Listen(endpoint)
	if err != nil {
		t.Fatal(err)
	}
	observedListener := &observingListener{listener, make(chan *observedWriteConn, 2)}
	hostReader, extensionWriter := net.Pipe()
	extensionReader, hostWriter := net.Pipe()
	relay := NewRelay(Config{Logger: slog.New(slog.NewTextHandler(io.Discard, nil))}, hostReader, hostWriter)
	relay.listener = observedListener
	// Three ~1 MiB notifications suffice; no 128 MiB flood or 10 second wait.
	relay.clientWriteLimits = clientWriteLimits{frames: 3, bytes: 4 << 20, timeout: 10 * time.Second}
	ctx, cancel := context.WithCancel(context.Background())
	acceptDone, extensionDone := make(chan error, 1), make(chan error, 1)
	go func() { acceptDone <- relay.acceptLoop(ctx) }()
	go func() { extensionDone <- relay.readExtensionLoop() }()
	t.Cleanup(func() {
		cancel()
		_ = listener.Close()
		_ = extensionWriter.Close()
		_ = extensionReader.Close()
		_ = hostReader.Close()
		_ = hostWriter.Close()
		relay.closeClients()
		for _, done := range []<-chan error{acceptDone, extensionDone} {
			select {
			case <-done:
			case <-time.After(3 * time.Second):
				t.Error("relay loop did not stop")
			}
		}
	})
	_ = extensionWriter.SetWriteDeadline(time.Now().Add(5 * time.Second))
	_ = extensionReader.SetReadDeadline(time.Now().Add(5 * time.Second))

	connect := func(session string, id int) (net.Conn, *clientConn, *observedWriteConn, string) {
		t.Helper()
		peer, err := transport.DialTimeout(endpoint, time.Second)
		if err != nil {
			t.Fatal(err)
		}
		t.Cleanup(func() { _ = peer.Close() })
		_ = peer.SetDeadline(time.Now().Add(5 * time.Second))
		if err := wire.WriteJSON(peer, map[string]any{"jsonrpc": "2.0", "id": id, "method": "ping", "params": map[string]any{"session_id": session}}); err != nil {
			t.Fatal(err)
		}
		var request struct{ ID string }
		if err := wire.ReadJSON(extensionReader, &request); err != nil {
			t.Fatal(err)
		}
		relay.mu.Lock()
		client := relay.pending[request.ID].client
		relay.mu.Unlock()
		if client == nil {
			t.Fatal("forwarded request has no pending client")
		}
		return peer, client, <-observedListener.accepted, request.ID
	}
	_, slow, slowWrite, slowID := connect("idle-session", 1)
	fastPeer, fast, _, fastID := connect("active-session", 2)
	notification, err := json.Marshal(map[string]any{"jsonrpc": "2.0", "method": "onCDPEvent", "params": map[string]any{"session_id": "idle-session", "data": strings.Repeat("x", 1<<20)}})
	if err != nil {
		t.Fatal(err)
	}
	if err := wire.WriteFrame(extensionWriter, notification); err != nil {
		t.Fatal(err)
	}
	awaitWriterSignal(t, slowWrite.started, "actual local write never started")
	floodDone := make(chan error, 1)
	go func() {
		for index := 0; index < 4; index++ {
			if err := wire.WriteFrame(extensionWriter, notification); err != nil {
				floodDone <- err
				return
			}
		}
		floodDone <- nil
	}()
	select {
	case err := <-floodDone:
		if err != nil {
			t.Fatal(err)
		}
	case <-time.After(3 * time.Second):
		t.Fatal("idle local client blocked the shared extension reader")
	}
	awaitWriterSignal(t, slow.writerDone, "overloaded local writer did not exit")
	if err := <-slowWrite.result; err == nil {
		t.Fatal("fixture did not exercise an interrupted real blocked transport write")
	}
	relay.mu.Lock()
	_, slowPending := relay.pending[slowID]
	_, fastPending := relay.pending[fastID]
	_, slowConnected := relay.clients[slow.id]
	relay.mu.Unlock()
	if slowPending || slowConnected || !fastPending {
		t.Fatalf("incorrect overload cleanup: slowPending=%v slowConnected=%v fastPending=%v", slowPending, slowConnected, fastPending)
	}
	// A late result for the closed peer must not become the next peer's result.
	for _, id := range []string{slowID, fastID} {
		if err := wire.WriteJSON(extensionWriter, map[string]any{"jsonrpc": "2.0", "id": id, "result": "responsive"}); err != nil {
			t.Fatal(err)
		}
	}
	var response struct {
		ID     int
		Result string
	}
	if err := wire.ReadJSON(fastPeer, &response); err != nil || response.ID != 2 || response.Result != "responsive" {
		t.Fatalf("fast client did not receive its response: %+v %v", response, err)
	}
	// Shutdown must join writers even when a prior overflow removed one from
	// the clients map; no blocked writer is left holding its frame allocation.
	shutdownDone := make(chan struct{})
	go func() { relay.closeClients(); close(shutdownDone) }()
	awaitWriterSignal(t, shutdownDone, "relay shutdown left a writer running")
	awaitWriterSignal(t, fast.writerDone, "fast writer did not stop on relay shutdown")
	if err := fast.write([]byte("late")); !errors.Is(err, net.ErrClosed) {
		t.Fatal("shutdown client accepted data", err)
	}
}

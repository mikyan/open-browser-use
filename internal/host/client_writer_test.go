package host

import (
	"crypto/sha256"
	"errors"
	"io"
	"net"
	"sync"
	"testing"
	"time"

	"github.com/ifuryst/open-browser-use/internal/wire"
)

type observedWriteConn struct {
	net.Conn
	minimum int
	started chan struct{}
	result  chan error
	once    sync.Once
}

func observeWrites(conn net.Conn, minimum int) *observedWriteConn {
	return &observedWriteConn{Conn: conn, minimum: minimum, started: make(chan struct{}), result: make(chan error, 1)}
}

func (c *observedWriteConn) Write(payload []byte) (int, error) {
	observed := false
	if len(payload) >= c.minimum {
		c.once.Do(func() { observed = true; close(c.started) })
	}
	n, err := c.Conn.Write(payload)
	if observed {
		c.result <- err
	}
	return n, err
}

func awaitWriterSignal(t *testing.T, signal <-chan struct{}, description string) {
	t.Helper()
	select {
	case <-signal:
	case <-time.After(3 * time.Second):
		t.Fatal(description)
	}
}

func TestClientQueueLimitsIncludeInFlightFrameAndHeader(t *testing.T) {
	for _, test := range []struct {
		name   string
		frames int
		bytes  int
	}{
		{name: "frame count", frames: 2, bytes: 1024},
		{name: "byte count", frames: 10, bytes: 2 * (8 + wire.HeaderBytes)},
	} {
		t.Run(test.name, func(t *testing.T) {
			server, peer := net.Pipe()
			defer peer.Close()
			observed := observeWrites(server, 1)
			closed := make(chan error, 2)
			client := newClientConn(1, observed, clientWriteLimits{test.frames, test.bytes, time.Second}, func(_ *clientConn, err error) { closed <- err })
			defer client.close(nil)
			go client.writeLoop()
			payload := []byte("12345678")
			if err := client.write(payload); err != nil {
				t.Fatal(err)
			}
			awaitWriterSignal(t, observed.started, "writer did not start")
			if err := client.write(payload); err != nil {
				t.Fatal(err)
			}
			client.mu.Lock()
			frames, bytes := client.queuedFrames, client.queuedBytes
			client.mu.Unlock()
			if frames != 2 || bytes != 2*(len(payload)+wire.HeaderBytes) {
				t.Fatalf("in-flight frame was excluded: frames=%d bytes=%d", frames, bytes)
			}
			if err := client.write(payload); !errors.Is(err, errClientBackpressure) {
				t.Fatalf("overflow should close the connection, got %v", err)
			}
			awaitWriterSignal(t, client.writerDone, "overflow left writer blocked")
			if err := <-closed; !errors.Is(err, errClientBackpressure) {
				t.Fatal(err)
			}
			client.close(nil)
			select {
			case <-closed:
				t.Fatal("close callback ran twice")
			default:
			}
			client.mu.Lock()
			defer client.mu.Unlock()
			if len(client.queue) != 0 || client.queuedBytes != 0 || client.queuedFrames != 0 {
				t.Fatal("closed client retained its queue")
			}
		})
	}
}

func TestClientWriteDeadlineAndCloseStopWriter(t *testing.T) {
	for _, explicitClose := range []bool{false, true} {
		name := "deadline"
		if explicitClose {
			name = "close"
		}
		t.Run(name, func(t *testing.T) {
			server, peer := net.Pipe()
			defer peer.Close()
			observed := observeWrites(server, 1)
			closed := make(chan error, 1)
			client := newClientConn(1, observed, clientWriteLimits{10, 1024, 50 * time.Millisecond}, func(_ *clientConn, err error) { closed <- err })
			defer client.close(nil)
			go client.writeLoop()
			if err := client.write([]byte("blocked")); err != nil {
				t.Fatal(err)
			}
			awaitWriterSignal(t, observed.started, "writer did not start")
			if explicitClose {
				client.close(nil)
			}
			awaitWriterSignal(t, client.writerDone, "writer did not stop")
			err := <-closed
			if !explicitClose {
				var timeout net.Error
				if !errors.As(err, &timeout) || !timeout.Timeout() {
					t.Fatalf("expected a write timeout, got %v", err)
				}
			}
			if err := client.write([]byte("late")); !errors.Is(err, net.ErrClosed) {
				t.Fatalf("closed writer accepted data: %v", err)
			}
		})
	}
}

func TestClientDefaultQueuePreservesTwoMaximumFrames(t *testing.T) {
	server, peer := net.Pipe()
	defer peer.Close()
	observed := observeWrites(server, 1)
	client := newClientConn(1, observed, defaultClientWriteLimits, nil)
	defer client.close(nil)
	go client.writeLoop()
	payload := make([]byte, wire.DefaultMaxFrame)
	payload[0], payload[len(payload)-1] = 1, 2
	want := sha256.Sum256(payload)
	if err := client.write(payload); err != nil {
		t.Fatal(err)
	}
	awaitWriterSignal(t, observed.started, "writer did not start")
	// Reuse the same immutable allocation: the queue must not copy large frames.
	if err := client.write(payload); err != nil {
		t.Fatalf("valid maximum-size response did not fit behind in-flight frame: %v", err)
	}
	_ = peer.SetReadDeadline(time.Now().Add(10 * time.Second))
	for index := 0; index < 2; index++ {
		var header [wire.HeaderBytes]byte
		if _, err := io.ReadFull(peer, header[:]); err != nil {
			t.Fatal(err)
		}
		length := wire.NativeEndian().Uint32(header[:])
		if length != wire.DefaultMaxFrame {
			t.Fatalf("frame %d has length %d", index, length)
		}
		digest := sha256.New()
		if _, err := io.CopyN(digest, peer, int64(length)); err != nil {
			t.Fatal(err)
		}
		if got := digest.Sum(nil); string(got) != string(want[:]) {
			t.Fatal("frame data changed in transit")
		}
	}
	client.close(nil)
	awaitWriterSignal(t, client.writerDone, "close left writer running")
}

func TestResponseQueueOverflowDoesNotRemoveAnotherClientsPending(t *testing.T) {
	relay := NewRelay(Config{}, nil, nil)
	server, peer := net.Pipe()
	defer peer.Close()
	observed := observeWrites(server, 1)
	slow := newClientConn(1, observed, clientWriteLimits{1, 1024, time.Second}, relay.removeClient)
	defer slow.close(nil)
	go slow.writeLoop()
	otherServer, otherPeer := net.Pipe()
	defer otherPeer.Close()
	fast := newClientConn(2, otherServer, defaultClientWriteLimits, relay.removeClient)
	defer fast.close(nil)
	go fast.writeLoop()
	relay.clients[1], relay.clients[2] = slow, fast
	relay.pending["slow-response"] = pendingRequest{slow, 1}
	relay.pending["slow-other"] = pendingRequest{slow, 2}
	relay.pending["fast"] = pendingRequest{fast, 3}
	if err := slow.write([]byte("occupied")); err != nil {
		t.Fatal(err)
	}
	awaitWriterSignal(t, observed.started, "writer did not start")
	if err := relay.dispatchExtensionPayload([]byte(`{"jsonrpc":"2.0","id":"slow-response","result":true}`)); !errors.Is(err, errClientBackpressure) {
		t.Fatal("response should close overloaded recipient", err)
	}
	awaitWriterSignal(t, slow.writerDone, "overloaded writer did not exit")
	relay.mu.Lock()
	_, fastPending := relay.pending["fast"]
	pendingCount, clientCount := len(relay.pending), len(relay.clients)
	relay.mu.Unlock()
	if !fastPending || pendingCount != 1 || clientCount != 1 {
		t.Fatalf("overflow corrupted other client: pending=%d clients=%d", pendingCount, clientCount)
	}
	if err := relay.dispatchExtensionPayload([]byte(`{"jsonrpc":"2.0","id":"fast","result":true}`)); err != nil {
		t.Fatal(err)
	}
	_ = otherPeer.SetReadDeadline(time.Now().Add(time.Second))
	var response struct{ ID int }
	if err := wire.ReadJSON(otherPeer, &response); err != nil || response.ID != 3 {
		t.Fatalf("other response lost: %+v %v", response, err)
	}
	fast.close(nil)
	awaitWriterSignal(t, fast.writerDone, "fast writer did not exit")
}

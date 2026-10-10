package host

import (
	"encoding/json"
	"errors"
	"net"
	"sync"
	"time"

	"github.com/ifuryst/open-browser-use/internal/wire"
)

var errClientBackpressure = errors.New("OBU_CLIENT_BACKPRESSURE: client stopped consuming messages; connection closed")

type clientWriteLimits struct {
	frames  int
	bytes   int
	timeout time.Duration
}

var defaultClientWriteLimits = clientWriteLimits{
	frames: 1024,
	// Two maximum-size wire frames, including their length headers. A valid
	// 64 MiB screenshot response must fit even while another frame is writing.
	bytes:   2 * (wire.DefaultMaxFrame + wire.HeaderBytes),
	timeout: 10 * time.Second,
}

type clientConn struct {
	id       int64
	conn     net.Conn
	sessions map[string]struct{} // guarded by Relay.mu; routing labels, not credentials

	mu           sync.Mutex
	queue        [][]byte
	queuedBytes  int // includes the frame currently being written
	queuedFrames int // includes the frame currently being written
	closed       bool
	closeOnce    sync.Once
	wake         chan struct{}
	done         chan struct{}
	writerDone   chan struct{}
	limits       clientWriteLimits
	onClose      func(*clientConn, error)
}

func newClientConn(id int64, conn net.Conn, limits clientWriteLimits, onClose func(*clientConn, error)) *clientConn {
	return &clientConn{id: id, conn: conn, limits: limits, onClose: onClose,
		wake: make(chan struct{}, 1), done: make(chan struct{}), writerDone: make(chan struct{})}
}

// write only queues immutable payloads. It never waits for a socket write, so
// one client cannot stall the shared extension reader or another client's RPC.
func (c *clientConn) write(payload []byte) error {
	size := len(payload) + wire.HeaderBytes
	c.mu.Lock()
	if c.closed {
		c.mu.Unlock()
		return net.ErrClosed
	}
	if len(payload) > wire.DefaultMaxFrame || c.queuedFrames >= c.limits.frames || size > c.limits.bytes-c.queuedBytes {
		c.mu.Unlock()
		c.close(errClientBackpressure)
		return errClientBackpressure
	}
	c.queue = append(c.queue, payload)
	c.queuedBytes += size
	c.queuedFrames++
	c.mu.Unlock()
	select {
	case c.wake <- struct{}{}:
	default:
	}
	return nil
}

func (c *clientConn) writeJSON(value any) error {
	payload, err := json.Marshal(value)
	if err != nil {
		return err
	}
	return c.write(payload)
}

func (c *clientConn) writeLoop() {
	defer close(c.writerDone)
	for {
		c.mu.Lock()
		if c.closed {
			c.mu.Unlock()
			return
		}
		if len(c.queue) == 0 {
			c.mu.Unlock()
			select {
			case <-c.wake:
			case <-c.done:
			}
			continue
		}
		payload := c.queue[0]
		c.queue[0] = nil
		c.queue = c.queue[1:]
		c.mu.Unlock()

		err := c.conn.SetWriteDeadline(time.Now().Add(c.limits.timeout))
		if err == nil {
			err = wire.WriteFrame(c.conn, payload)
		}
		if err != nil {
			c.close(err)
			return
		}
		c.mu.Lock()
		if c.closed {
			c.mu.Unlock()
			return
		}
		c.queuedBytes -= len(payload) + wire.HeaderBytes
		c.queuedFrames--
		c.mu.Unlock()
	}
}

func (c *clientConn) close(reason error) {
	c.closeOnce.Do(func() {
		c.mu.Lock()
		c.closed = true
		c.queue = nil
		c.queuedBytes = 0
		c.queuedFrames = 0
		c.mu.Unlock()
		// Closing the connection interrupts an in-flight write/read immediately.
		_ = c.conn.Close()
		close(c.done)
		if c.onClose != nil {
			c.onClose(c, reason)
		}
	})
}

package managedbrowser

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"sync"
	"time"

	"github.com/coder/websocket"
)

const userReadLimit = 8 << 20
const userPendingLimit = 16

type userReply struct {
	data json.RawMessage
	err  error
}

// A caller deadline stops waiting, not the original command. One receipt stays
// in pending until that exact reply or the original connection actually ends.
type userCall struct {
	done    chan struct{}
	reply   userReply
	session string
}

func (c *userCall) wait(ctx context.Context) (json.RawMessage, error) {
	select {
	case <-c.done:
		return c.reply.data, c.reply.err
	default:
	}
	select {
	case <-c.done:
		return c.reply.data, c.reply.err
	case <-ctx.Done():
		return nil, ctx.Err()
	}
}

type userCDP struct {
	conn       *websocket.Conn
	mu         sync.Mutex
	next       uint64
	pending    map[uint64]*userCall
	err        error
	done       chan struct{}
	readerDone chan struct{}
	writeGate  chan struct{}
	lastWrite  <-chan struct{}
	writers    sync.WaitGroup
	event      func(string, string, json.RawMessage) error
}

func newUserCDP(conn *websocket.Conn, event func(string, string, json.RawMessage) error) *userCDP {
	conn.SetReadLimit(userReadLimit)
	c := &userCDP{conn: conn, pending: make(map[uint64]*userCall), done: make(chan struct{}), readerDone: make(chan struct{}), writeGate: make(chan struct{}, 1), event: event}
	go c.read()
	return c
}

func (c *userCDP) fail(err error) {
	if err == nil {
		err = errors.New("managed user CDP connection closed")
	}
	c.mu.Lock()
	if c.err != nil {
		c.mu.Unlock()
		return
	}
	c.err = err
	for id, call := range c.pending {
		delete(c.pending, id)
		call.reply.err = err
		close(call.done)
	}
	close(c.done)
	c.mu.Unlock()
	_ = c.conn.CloseNow()
}

func (c *userCDP) start(ctx context.Context, session, method string, params any) (*userCall, error) {
	if err := contextError(ctx); err != nil {
		return nil, err
	}
	c.mu.Lock()
	if c.err != nil {
		err := c.err
		c.mu.Unlock()
		return nil, err
	}
	if len(c.pending) >= userPendingLimit || c.next >= 1<<53-1 {
		c.mu.Unlock()
		return nil, errors.New("managed user pending command capacity exhausted")
	}
	c.next++
	id := c.next
	call := &userCall{done: make(chan struct{}), session: session}
	c.pending[id] = call
	previousWrite := c.lastWrite
	written := make(chan struct{})
	c.lastWrite = written
	c.writers.Add(1)
	c.mu.Unlock()
	message := map[string]any{"id": id, "method": method, "params": params}
	if session != "" {
		message["sessionId"] = session
	}
	data, err := json.Marshal(message)
	go func() {
		defer c.writers.Done()
		defer close(written)
		// Preserve submission order, not reply order. In particular a cleanup
		// must not overtake an older Begin which could otherwise start afterward.
		if previousWrite != nil {
			select {
			case <-previousWrite:
			case <-c.done:
				return
			}
		}
		if err != nil {
			c.settle(id, userReply{err: err})
			return
		}
		select {
		case c.writeGate <- struct{}{}:
		case <-ctx.Done():
			c.settle(id, userReply{err: ctx.Err()})
			return
		case <-c.done:
			return
		}
		defer func() { <-c.writeGate }()
		if err := contextError(ctx); err != nil {
			c.settle(id, userReply{err: err})
			return
		}
		// Once submission starts, preserve its actual outcome independently of
		// the HTTP caller. A bounded socket write still retires a broken link.
		writeCtx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer cancel()
		if err := c.conn.Write(writeCtx, websocket.MessageText, data); err != nil {
			c.fail(errors.New("managed user CDP write failed"))
		}
	}()
	return call, nil
}

func (c *userCDP) settle(id uint64, result userReply) {
	c.mu.Lock()
	defer c.mu.Unlock()
	if call := c.pending[id]; call != nil {
		delete(c.pending, id)
		call.reply = result
		close(call.done)
	}
}

func (c *userCDP) call(ctx context.Context, session, method string, params, result any) error {
	call, err := c.start(ctx, session, method, params)
	if err != nil {
		return err
	}
	data, err := call.wait(ctx)
	if err != nil || result == nil {
		return err
	}
	return json.Unmarshal(data, result)
}

func (c *userCDP) read() {
	defer close(c.readerDone)
	for {
		kind, data, err := c.conn.Read(context.Background())
		if err != nil {
			c.fail(errors.New("managed user original CDP connection ended"))
			return
		}
		var message struct {
			ID        uint64          `json:"id"`
			SessionID string          `json:"sessionId"`
			Method    string          `json:"method"`
			Params    json.RawMessage `json:"params"`
			Result    json.RawMessage `json:"result"`
			Error     json.RawMessage `json:"error"`
		}
		if kind != websocket.MessageText || json.Unmarshal(data, &message) != nil {
			c.fail(errors.New("invalid managed user CDP message"))
			return
		}
		if message.ID == 0 {
			if message.Method == "" || c.event(message.SessionID, message.Method, message.Params) != nil {
				c.fail(errors.New("managed user CDP event identity or protocol mismatch"))
				return
			}
			continue
		}
		c.mu.Lock()
		call := c.pending[message.ID]
		if call == nil || message.SessionID != call.session {
			c.mu.Unlock()
			c.fail(errors.New("managed user CDP response identity mismatch"))
			return
		}
		c.mu.Unlock()
		result := userReply{data: message.Result}
		if len(message.Error) != 0 {
			var detail struct{ Code int }
			_ = json.Unmarshal(message.Error, &detail)
			// Do not echo native messages or expressions containing private keys.
			result.err = fmt.Errorf("managed user CDP command rejected (%d)", detail.Code)
		} else if len(message.Result) == 0 {
			c.fail(errors.New("managed user CDP response missing result"))
			return
		}
		c.settle(message.ID, result)
	}
}

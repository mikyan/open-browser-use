package main

import (
	"encoding/json"
	"errors"
	"fmt"
	"net"
	"sync"
	"time"

	"github.com/ifuryst/open-browser-use/internal/wire"
)

// A stdio server owns one actual connection, not a rediscoverable address or a
// profile UUID (which can be copied). The control gate serializes acquisition.
type mcpBrowserConnection struct {
	mu     sync.Mutex
	peer   *mcpBoundConn
	closed bool
}

func (binding *mcpBrowserConnection) acquire(options socketOptions, deadline time.Time) (net.Conn, error) {
	binding.mu.Lock()
	defer binding.mu.Unlock()
	if binding.closed {
		return nil, mcpDisconnected(net.ErrClosed)
	}
	if binding.peer == nil {
		if time.Until(deadline) <= 0 {
			return nil, errors.New("request timed out before connecting")
		}
		conn, err := dialBrowserSocketForProfile(options.socketPath, options.socketDir, options.browser, options.profile, time.Until(deadline))
		if err != nil {
			// No connection was selected. A later, explicit request may discover
			// a browser that was not available when this request was submitted.
			return nil, err
		}
		binding.peer = newMCPBoundConn(conn)
	}
	if err := binding.peer.SetDeadline(deadline); err != nil {
		return nil, err
	}
	return binding.peer, nil
}

func (binding *mcpBrowserConnection) close() {
	binding.mu.Lock()
	binding.closed = true
	peer := binding.peer
	binding.mu.Unlock()
	if peer != nil {
		peer.fail(net.ErrClosed)
		<-peer.readerDone
	}
}

func mcpDisconnected(cause error) error {
	return fmt.Errorf("OBU_MCP_BROWSER_DISCONNECTED: the bound browser connection is closed; restart the MCP server to select a browser again (actions are not replayed): %w", cause)
}

type mcpPendingResponse struct {
	id       string
	response chan json.RawMessage
}

// The reader remains active between tools and after a response-wait timeout.
// Only one framed response is retained; unsolicited notifications and stale
// replies are discarded, as MCP does not expose a browser notification stream.
type mcpBoundConn struct {
	net.Conn
	mu         sync.Mutex
	deadline   time.Time
	serial     uint64
	pending    *mcpPendingResponse
	failure    error
	done       chan struct{}
	readerDone chan struct{}
}

func newMCPBoundConn(conn net.Conn) *mcpBoundConn {
	peer := &mcpBoundConn{Conn: conn, done: make(chan struct{}), readerDone: make(chan struct{})}
	go peer.readLoop()
	return peer
}

// Per-request control leases must not close the server's connection or install
// a read deadline that can interrupt the shared reader halfway through a frame.
func (peer *mcpBoundConn) Close() error { return nil }
func (peer *mcpBoundConn) SetDeadline(deadline time.Time) error {
	peer.mu.Lock()
	defer peer.mu.Unlock()
	if peer.failure != nil {
		return peer.failure
	}
	peer.deadline = deadline
	return nil
}

func (peer *mcpBoundConn) fail(cause error) {
	peer.mu.Lock()
	if peer.failure != nil {
		peer.mu.Unlock()
		return
	}
	peer.failure = mcpDisconnected(cause)
	close(peer.done)
	peer.mu.Unlock()
	_ = peer.Conn.Close()
}

func (peer *mcpBoundConn) readLoop() {
	defer close(peer.readerDone)
	for {
		payload, err := wire.ReadFrame(peer.Conn, wire.DefaultMaxFrame)
		if err != nil {
			peer.fail(err)
			return
		}
		id, notification, err := mcpResponseIdentity(payload)
		if err != nil {
			peer.fail(err)
			return
		}
		if notification {
			continue
		}
		peer.mu.Lock()
		if pending := peer.pending; pending != nil && pending.id == id {
			pending.response <- json.RawMessage(payload)
			peer.pending = nil
		}
		peer.mu.Unlock()
	}
}

func mcpResponseIdentity(payload []byte) (string, bool, error) {
	invalid := errors.New("invalid JSON-RPC frame from browser host")
	var envelope map[string]json.RawMessage
	if json.Unmarshal(payload, &envelope) != nil || envelope == nil {
		return "", false, invalid
	}
	var version string
	if json.Unmarshal(envelope["jsonrpc"], &version) != nil || version != "2.0" {
		return "", false, invalid
	}
	_, hasID := envelope["id"]
	_, hasResult := envelope["result"]
	_, hasError := envelope["error"]
	if rawMethod, hasMethod := envelope["method"]; hasMethod {
		var method string
		if hasID || hasResult || hasError || json.Unmarshal(rawMethod, &method) != nil || method == "" {
			return "", false, invalid
		}
		return "", true, nil
	}
	var id string
	if !hasID || hasResult == hasError || json.Unmarshal(envelope["id"], &id) != nil || id == "" {
		return "", false, invalid
	}
	if hasError {
		var value struct {
			Code    *int64  `json:"code"`
			Message *string `json:"message"`
		}
		if json.Unmarshal(envelope["error"], &value) != nil || value.Code == nil || value.Message == nil {
			return "", false, invalid
		}
	}
	return id, false, nil
}

func (peer *mcpBoundConn) request(originalID, method string, params map[string]any) (map[string]any, error) {
	peer.mu.Lock()
	if peer.failure != nil {
		err := peer.failure
		peer.mu.Unlock()
		return nil, err
	}
	deadline := peer.deadline
	if time.Until(deadline) <= 0 {
		peer.mu.Unlock()
		return nil, errors.New("request timed out before sending")
	}
	if peer.pending != nil {
		peer.mu.Unlock()
		return nil, errors.New("concurrent request on serialized MCP browser connection")
	}
	peer.serial++
	pending := &mcpPendingResponse{id: fmt.Sprintf("mcp-browser-%d", peer.serial), response: make(chan json.RawMessage, 1)}
	peer.pending = pending
	peer.mu.Unlock()
	defer func() {
		peer.mu.Lock()
		if peer.pending == pending {
			peer.pending = nil
		}
		peer.mu.Unlock()
	}()

	// Encoding fails before touching the stream. A partial write, in contrast,
	// leaves an unknown operation and an unusable frame boundary: close it.
	payload, err := json.Marshal(map[string]any{"jsonrpc": "2.0", "id": pending.id, "method": method, "params": params})
	if err != nil {
		return nil, err
	}
	if len(payload) > wire.DefaultMaxFrame {
		return nil, wire.ErrFrameTooLarge
	}
	if time.Until(deadline) <= 0 {
		return nil, errors.New("request timed out before sending")
	}
	if err = peer.Conn.SetWriteDeadline(deadline); err == nil {
		err = wire.WriteFrame(peer.Conn, payload)
	}
	if err != nil {
		peer.fail(err)
		return nil, mcpDisconnected(err)
	}
	if err := peer.Conn.SetWriteDeadline(time.Time{}); err != nil {
		// The reader may have delivered an entire response immediately before
		// EOF closed the connection. Keep that response available below.
		peer.fail(err)
	}

	timer := time.NewTimer(time.Until(deadline))
	defer timer.Stop()
	var response json.RawMessage
	select {
	case response = <-pending.response:
	case <-timer.C:
		return nil, errors.New("MCP browser response timed out; operation outcome is unknown and was not replayed")
	case <-peer.done:
		// A valid response can precede EOF in the same read-loop timeslice.
		select {
		case response = <-pending.response:
		default:
			peer.mu.Lock()
			err := peer.failure
			peer.mu.Unlock()
			return nil, err
		}
	}
	if !time.Now().Before(deadline) {
		return nil, errors.New("MCP browser response timed out; operation outcome is unknown and was not replayed")
	}
	if cliClipboardMethod(method) || cliDialogMethod(method) || cliResponseBody(method, params) {
		if err := validateClipboardJSONUnicode(response); err != nil {
			return nil, err
		}
	}
	var result map[string]any
	if err := json.Unmarshal(response, &result); err != nil {
		return nil, err
	}
	result["id"] = originalID
	return result, nil
}

func dialCLIControl(options socketOptions, deadline time.Time) (net.Conn, error) {
	if options.mcpConnection != nil {
		return options.mcpConnection.acquire(options, deadline)
	}
	if time.Until(deadline) <= 0 {
		return nil, errors.New("request timed out before connecting")
	}
	return dialBrowserSocketForProfile(options.socketPath, options.socketDir, options.browser, options.profile, time.Until(deadline))
}

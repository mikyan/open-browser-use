package browserdownloads

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"sync"
	"time"
	"unicode/utf8"

	"github.com/coder/websocket"
)

const commandTimeout = 10 * time.Second

// DialOptions permits a discovered port file's address-family fallback only.
// Explicit endpoints keep their original single-address behavior.
type DialOptions struct {
	LoopbackFallback bool
}

func ValidateDialOptions(endpoint string, options DialOptions) error {
	if err := ValidateURL(endpoint); err != nil {
		return err
	}
	if options.LoopbackFallback {
		u, _ := url.Parse(endpoint)
		if u.Scheme != "ws" || u.Hostname() != "127.0.0.1" {
			return failure("URL", "discovered loopback fallback requires ws://127.0.0.1 and the original Browser endpoint")
		}
	}
	return nil
}

func failure(code, message string) error {
	return fmt.Errorf("OBU_NATIVE_DOWNLOAD_%s: %s", code, message)
}

// ValidateURL accepts an explicit local Browser endpoint, never discovery or DNS.
func ValidateURL(raw string) error {
	u, err := url.Parse(raw)
	if err != nil || u == nil {
		return failure("URL", "an explicit loopback Browser WebSocket URL is required")
	}
	ip := net.ParseIP(u.Hostname())
	port, portErr := strconv.Atoi(u.Port())
	const prefix = "/devtools/browser/"
	if (u.Scheme != "ws" && u.Scheme != "wss") || ip == nil || !ip.IsLoopback() ||
		portErr != nil || port < 1 || port > 65535 || u.User != nil || u.RawQuery != "" || u.ForceQuery ||
		u.Fragment != "" || strings.Contains(raw, "#") || u.RawFragment != "" || u.RawPath != "" || u.Opaque != "" ||
		!strings.HasPrefix(u.Path, prefix) || !validText(strings.TrimPrefix(u.Path, prefix), 256) ||
		strings.Contains(strings.TrimPrefix(u.Path, prefix), "/") {
		return failure("URL", "use a literal loopback IP and exact /devtools/browser/<id> endpoint without credentials, query or fragment")
	}
	return nil
}

func validText(value string, limit int) bool {
	if len(value) == 0 || len(value) > limit || !utf8.ValidString(value) {
		return false
	}
	for _, r := range value {
		if r <= 32 || r == 127 {
			return false
		}
	}
	return true
}

type reply struct {
	result json.RawMessage
	err    error
}

// A received ACK has a known native outcome, even when the caller's budget
// expired before it could be accepted. The Manager can reset its verified
// configuration on this same connection before retiring it.
type lateAcknowledgementError struct{ cause error }

func (e *lateAcknowledgementError) Error() string {
	return "OBU_NATIVE_DOWNLOAD_DEADLINE: Browser acknowledgement arrived after the caller budget: " + e.cause.Error()
}
func (e *lateAcknowledgementError) Unwrap() error { return e.cause }

func contextError(ctx context.Context) error {
	if err := ctx.Err(); err != nil {
		return err
	}
	if deadline, ok := ctx.Deadline(); ok && !time.Now().Before(deadline) {
		return context.DeadlineExceeded
	}
	return nil
}

type pendingCommand struct {
	session string
	result  chan reply
}

// One reader owns native arrival order. A submitted command with an uncertain
// outcome retires this connection; it is never replayed on another socket.
type transport struct {
	conn       *websocket.Conn
	mu         sync.Mutex
	next       int64
	pending    map[int64]pendingCommand
	err        error
	done       chan struct{}
	readerDone chan struct{}
	event      func(string, json.RawMessage) error
	onTerminal func()
}

func dialTransport(ctx context.Context, endpoint string, event func(string, json.RawMessage) error, onTerminal func()) (*transport, error) {
	return dialTransportWithOptions(ctx, endpoint, event, onTerminal, DialOptions{})
}

func dialTransportWithOptions(ctx context.Context, endpoint string, event func(string, json.RawMessage) error, onTerminal func(), options DialOptions) (*transport, error) {
	if err := ValidateDialOptions(endpoint, options); err != nil {
		return nil, err
	}
	if err := contextError(ctx); err != nil {
		return nil, err
	}
	dial := (&net.Dialer{}).DialContext
	if options.LoopbackFallback {
		u, _ := url.Parse(endpoint)
		nativeDial := dial
		dial = func(dialCtx context.Context, network, address string) (net.Conn, error) {
			if network != "tcp" || address != u.Host {
				return nil, failure("URL", "discovered Browser dial changed its original endpoint")
			}
			// net/http detaches DialContext from the request deadline for pooled
			// connections. This one-attempt transport must retain setup's budget.
			bounded, cancel := context.WithCancel(ctx)
			stop := context.AfterFunc(dialCtx, cancel)
			defer stop()
			defer cancel()
			return dialDiscoveredLoopback(bounded, address, nativeDial)
		}
	}
	httpTransport := &http.Transport{Proxy: nil, DialContext: dial, TLSHandshakeTimeout: commandTimeout}
	client := &http.Client{Transport: httpTransport, CheckRedirect: func(*http.Request, []*http.Request) error {
		return failure("URL", "Browser endpoint redirects are forbidden")
	}}
	conn, _, err := websocket.Dial(ctx, endpoint, &websocket.DialOptions{HTTPClient: client, CompressionMode: websocket.CompressionDisabled})
	httpTransport.CloseIdleConnections()
	if err != nil {
		return nil, err
	}
	// A completed HTTP handshake is not permission to use an expired setup.
	// Check before publishing the transport or starting its independent reader.
	if err := contextError(ctx); err != nil {
		_ = conn.CloseNow()
		return nil, err
	}
	conn.SetReadLimit(1 << 20)
	t := &transport{conn: conn, pending: make(map[int64]pendingCommand), done: make(chan struct{}), readerDone: make(chan struct{}), event: event, onTerminal: onTerminal}
	go t.readLoop()
	return t, nil
}

// No HTTP bytes have been sent at this boundary. Only an exact TCP refusal
// permits the other loopback family, at the same port and original deadline.
// Once TCP succeeds, approval/Upgrade/CDP/identity failures are terminal.
func dialDiscoveredLoopback(ctx context.Context, address string, dial func(context.Context, string, string) (net.Conn, error)) (net.Conn, error) {
	if err := contextError(ctx); err != nil {
		return nil, err
	}
	conn, firstErr := dial(ctx, "tcp4", address)
	if err := contextError(ctx); err != nil {
		if conn != nil {
			_ = conn.Close()
		}
		return nil, err
	}
	if firstErr == nil {
		return conn, nil
	}
	var op *net.OpError
	if !errors.As(firstErr, &op) || op.Op != "dial" || !errors.Is(firstErr, connectionRefused) {
		return nil, firstErr
	}
	host, port, err := net.SplitHostPort(address)
	if err != nil || host != "127.0.0.1" {
		return nil, failure("URL", "discovered Browser fallback changed its original IPv4 address")
	}
	conn, err = dial(ctx, "tcp6", net.JoinHostPort("::1", port))
	if expired := contextError(ctx); expired != nil {
		if conn != nil {
			_ = conn.Close()
		}
		return nil, expired
	}
	if err != nil {
		return nil, fmt.Errorf("IPv4 loopback refused (%v); same-port IPv6 loopback failed: %w", firstErr, err)
	}
	return conn, nil
}

func (t *transport) terminal(err error) {
	t.mu.Lock()
	if t.err != nil {
		t.mu.Unlock()
		return
	}
	t.err = err
	close(t.done)
	for id, command := range t.pending {
		command.result <- reply{err: err}
		delete(t.pending, id)
	}
	t.mu.Unlock()
	if t.onTerminal != nil {
		t.onTerminal()
	}
	_ = t.conn.CloseNow()
}

func (t *transport) error() error {
	t.mu.Lock()
	defer t.mu.Unlock()
	return t.err
}

func (t *transport) readLoop() {
	defer close(t.readerDone)
	for {
		kind, data, err := t.conn.Read(context.Background())
		if err != nil {
			t.terminal(failure("DISCONNECTED", "original Browser connection ended: "+err.Error()))
			return
		}
		if kind != websocket.MessageText || !utf8.Valid(data) {
			t.terminal(failure("PROTOCOL", "Browser messages must be UTF-8 JSON text"))
			return
		}
		if err := t.receive(data); err != nil {
			t.terminal(err)
			return
		}
	}
}

func (t *transport) receive(data []byte) error {
	envelope, parseErr := decodeObject(data)
	if parseErr != nil {
		return failure("PROTOCOL", "invalid Browser JSON object")
	}
	if rawID, response := envelope["id"]; response {
		var id int64
		var session string
		result, hasResult := envelope["result"]
		rawError, hasError := envelope["error"]
		if json.Unmarshal(rawID, &id) != nil || id < 1 || hasResult == hasError || envelope["method"] != nil ||
			(envelope["sessionId"] != nil && json.Unmarshal(envelope["sessionId"], &session) != nil) {
			return failure("PROTOCOL", "malformed Browser acknowledgement")
		}
		var responseError error
		if hasError {
			var native struct {
				Code    *int   `json:"code"`
				Message string `json:"message"`
			}
			if json.Unmarshal(rawError, &native) != nil || native.Code == nil || native.Message == "" {
				return failure("PROTOCOL", "malformed Browser error")
			}
			responseError = failure("CDP", native.Message)
		} else {
			var object map[string]json.RawMessage
			if json.Unmarshal(result, &object) != nil || object == nil {
				return failure("PROTOCOL", "Browser result must be an object")
			}
		}
		t.mu.Lock()
		command, found := t.pending[id]
		if !found || command.session != session {
			t.mu.Unlock()
			return failure("PROTOCOL", "unknown, duplicate or wrong-session Browser acknowledgement")
		}
		delete(t.pending, id)
		command.result <- reply{result: result, err: responseError}
		t.mu.Unlock()
		return nil
	}
	var method, session string
	if json.Unmarshal(envelope["method"], &method) != nil || method == "" || envelope["result"] != nil || envelope["error"] != nil ||
		(envelope["sessionId"] != nil && json.Unmarshal(envelope["sessionId"], &session) != nil) {
		return failure("PROTOCOL", "malformed Browser event")
	}
	if strings.HasPrefix(method, "Browser.download") && session != "" {
		return failure("PROTOCOL", "download event did not originate from the Browser root")
	}
	if t.event != nil {
		return t.event(method, envelope["params"])
	}
	return nil
}

func (t *transport) call(ctx context.Context, method, session string, params any, output any) error {
	if err := contextError(ctx); err != nil {
		return err
	}
	encoded, err := json.Marshal(params)
	if err != nil {
		return err
	}
	ctx, cancel := context.WithTimeout(ctx, commandTimeout)
	defer cancel()
	t.mu.Lock()
	if err := contextError(ctx); err != nil {
		t.mu.Unlock()
		return err
	}
	if t.err != nil {
		err := t.err
		t.mu.Unlock()
		return err
	}
	if len(t.pending) >= 128 {
		t.mu.Unlock()
		return failure("LIMIT", "too many pending Browser commands")
	}
	t.next++
	id := t.next
	command := pendingCommand{session: session, result: make(chan reply, 1)}
	t.pending[id] = command
	t.mu.Unlock()
	message, _ := json.Marshal(struct {
		ID        int64           `json:"id"`
		Method    string          `json:"method"`
		SessionID string          `json:"sessionId,omitempty"`
		Params    json.RawMessage `json:"params"`
	}{id, method, session, encoded})
	if err := t.conn.Write(ctx, websocket.MessageText, message); err != nil {
		t.terminal(failure("DISCONNECTED", "Browser command write failed: "+err.Error()))
		return err
	}
	accept := func(response reply) error {
		if err := contextError(ctx); err != nil {
			return &lateAcknowledgementError{cause: err}
		}
		if response.err != nil {
			return response.err
		}
		if output != nil {
			if err := json.Unmarshal(response.result, output); err != nil {
				t.terminal(failure("PROTOCOL", "invalid typed Browser result"))
				return err
			}
		}
		if err := contextError(ctx); err != nil {
			return &lateAcknowledgementError{cause: err}
		}
		return nil
	}
	select {
	case response := <-command.result:
		return accept(response)
	case <-ctx.Done():
		// When both are ready, do not mislabel an already received ACK as an
		// unknown outcome merely because select picked the deadline first.
		select {
		case response := <-command.result:
			return accept(response)
		default:
		}
		t.terminal(failure("DISCONNECTED", "Browser command acknowledgement deadline ended; no retry"))
		return ctx.Err()
	}
}

func (t *transport) close() {
	t.terminal(failure("DISCONNECTED", "original Browser connection was closed"))
	<-t.readerDone
}

func decodeObject(data []byte) (map[string]json.RawMessage, error) {
	d := json.NewDecoder(strings.NewReader(string(data)))
	start, err := d.Token()
	if err != nil || start != json.Delim('{') {
		return nil, failure("PROTOCOL", "expected a JSON object")
	}
	object := make(map[string]json.RawMessage)
	for d.More() {
		key, err := d.Token()
		if err != nil {
			return nil, err
		}
		name, ok := key.(string)
		if !ok {
			return nil, failure("PROTOCOL", "invalid object key")
		}
		if _, duplicate := object[name]; duplicate {
			return nil, failure("PROTOCOL", "duplicate object field")
		}
		var value json.RawMessage
		if err := d.Decode(&value); err != nil {
			return nil, err
		}
		object[name] = value
	}
	if _, err := d.Token(); err != nil {
		return nil, err
	}
	if _, err := d.Token(); err != io.EOF {
		return nil, failure("PROTOCOL", "extra JSON content")
	}
	return object, nil
}

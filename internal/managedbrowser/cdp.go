package managedbrowser

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net"
	"net/http"
	"strconv"
	"strings"
	"time"

	"github.com/coder/websocket"
	"github.com/ifuryst/open-browser-use/internal/browserdownloads"
	"github.com/ifuryst/open-browser-use/internal/transport"
	"github.com/ifuryst/open-browser-use/internal/wire"
)

// This supervisor connection only verifies the launched browser and closes it.
// Website operations continue through the extension's normal native transport.
type browserConnection struct {
	conn *websocket.Conn
	gate chan struct{}
	next int64
}

func contextError(ctx context.Context) error {
	if err := ctx.Err(); err != nil {
		return err
	}
	if deadline, ok := ctx.Deadline(); ok && !time.Now().Before(deadline) {
		return context.DeadlineExceeded
	}
	return nil
}

func browserEndpoint(data []byte) (string, error) {
	lines := strings.Split(strings.TrimSpace(string(data)), "\n")
	if len(data) > 4096 || len(lines) != 2 {
		return "", errors.New("invalid private DevToolsActivePort record")
	}
	port, err := strconv.Atoi(strings.TrimSpace(lines[0]))
	if err != nil || port < 1 || port > 65535 {
		return "", errors.New("invalid private DevTools port")
	}
	endpoint := fmt.Sprintf("ws://127.0.0.1:%d%s", port, strings.TrimSpace(lines[1]))
	if err := browserdownloads.ValidateURL(endpoint); err != nil {
		return "", err
	}
	return endpoint, nil
}

func connectBrowser(ctx context.Context, endpoint string) (*browserConnection, error) {
	if err := contextError(ctx); err != nil {
		return nil, err
	}
	if err := browserdownloads.ValidateURL(endpoint); err != nil {
		return nil, err
	}
	tr := &http.Transport{Proxy: nil, DialContext: (&net.Dialer{}).DialContext}
	client := &http.Client{Transport: tr, CheckRedirect: func(*http.Request, []*http.Request) error { return errors.New("managed Browser endpoint redirected") }}
	conn, _, err := websocket.Dial(ctx, endpoint, &websocket.DialOptions{HTTPClient: client, CompressionMode: websocket.CompressionDisabled})
	tr.CloseIdleConnections()
	if err != nil {
		return nil, err
	}
	if err := contextError(ctx); err != nil {
		conn.CloseNow()
		return nil, err
	}
	conn.SetReadLimit(1 << 20)
	return &browserConnection{conn: conn, gate: make(chan struct{}, 1)}, nil
}

func (c *browserConnection) call(ctx context.Context, method string, params any, result any) error {
	ctx, cancel := context.WithTimeout(ctx, 10*time.Second)
	defer cancel()
	select {
	case c.gate <- struct{}{}:
	case <-ctx.Done():
		return ctx.Err()
	}
	defer func() { <-c.gate }()
	if err := contextError(ctx); err != nil {
		return err
	}
	c.next++
	id := c.next
	payload, err := json.Marshal(map[string]any{"id": id, "method": method, "params": params})
	if err != nil {
		return err
	}
	if err := c.conn.Write(ctx, websocket.MessageText, payload); err != nil {
		return err
	}
	for {
		kind, payload, err := c.conn.Read(ctx)
		if err != nil {
			return err
		}
		if kind != websocket.MessageText {
			return errors.New("managed Browser sent a non-text frame")
		}
		var reply struct {
			ID     int64           `json:"id"`
			Result json.RawMessage `json:"result"`
			Error  json.RawMessage `json:"error"`
		}
		if err := json.Unmarshal(payload, &reply); err != nil {
			return err
		}
		if reply.ID == 0 {
			continue
		}
		if reply.ID != id {
			return errors.New("managed Browser response identity mismatch")
		}
		if len(reply.Error) != 0 {
			return fmt.Errorf("managed Browser %s: %s", method, reply.Error)
		}
		if len(reply.Result) == 0 {
			return errors.New("managed Browser response has no result")
		}
		if err := contextError(ctx); err != nil {
			return err
		}
		if result == nil {
			return nil
		}
		return json.Unmarshal(reply.Result, result)
	}
}

func (c *browserConnection) close() error { return c.conn.CloseNow() }

// Every call dials only the exact private descriptor. A failure is never a
// reason to fall back to active.json in the caller's normal TEMP directory.
func nativeCall(ctx context.Context, endpoint, method string, params any, output any) error {
	if err := contextError(ctx); err != nil {
		return err
	}
	deadline, ok := ctx.Deadline()
	if !ok {
		return errors.New("managed native call requires a deadline")
	}
	if !transport.IsNamedPipe(endpoint) {
		return errors.New("managed native endpoint must be a named pipe")
	}
	conn, err := transport.DialTimeout(endpoint, time.Until(deadline))
	if err != nil {
		return err
	}
	defer conn.Close()
	stop := context.AfterFunc(ctx, func() { conn.Close() })
	defer stop()
	if err := conn.SetDeadline(deadline); err != nil {
		return err
	}
	if err := contextError(ctx); err != nil {
		return err
	}
	id, err := randomID()
	if err != nil {
		return err
	}
	if err := wire.WriteJSON(conn, map[string]any{"jsonrpc": "2.0", "id": id, "method": method, "params": params}); err != nil {
		return err
	}
	for {
		payload, err := wire.ReadFrame(conn, 1<<20)
		if err != nil {
			return err
		}
		var reply struct {
			JSONRPC string          `json:"jsonrpc"`
			ID      string          `json:"id"`
			Method  string          `json:"method"`
			Result  json.RawMessage `json:"result"`
			Error   json.RawMessage `json:"error"`
		}
		if err := json.Unmarshal(payload, &reply); err != nil {
			return err
		}
		if reply.ID == "" && reply.Method != "" {
			continue
		}
		if reply.ID != id || reply.JSONRPC != "2.0" {
			return errors.New("managed native response identity mismatch")
		}
		if len(reply.Error) != 0 {
			return fmt.Errorf("managed native %s: %s", method, reply.Error)
		}
		if len(reply.Result) == 0 {
			return errors.New("managed native response has no result")
		}
		if err := contextError(ctx); err != nil {
			return err
		}
		return json.Unmarshal(reply.Result, output)
	}
}

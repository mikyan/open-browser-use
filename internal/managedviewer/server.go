// Package managedviewer serves an explicitly authorized, local-only viewer.
// It does not expose browser input, task RPC, or a general CDP proxy.
package managedviewer

import (
	"context"
	"crypto/rand"
	"crypto/sha256"
	"crypto/subtle"
	"embed"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"net"
	"net/http"
	"sync"
	"time"

	"github.com/coder/websocket"
)

//go:embed ui/index.html ui/viewer.js ui/viewer.css
var assets embed.FS

type Backend interface {
	Command(context.Context, json.RawMessage) (json.RawMessage, error)
	Events() <-chan json.RawMessage
	Done() <-chan struct{}
}

type Config struct {
	RunID   string
	Backend Backend
	Stop    func(context.Context) error
}

const ticketLifetime = 10 * time.Minute

type Server struct {
	config     Config
	http       *http.Server
	listen     net.Listener
	origin     string
	ctx        context.Context
	cancel     context.CancelFunc
	done       chan struct{}
	wg         sync.WaitGroup
	mu         sync.Mutex
	closed     bool
	active     *connection
	url        string
	ticket     [32]byte
	expires    time.Time
	used       bool
	admission  chan struct{}
	closeOnce  sync.Once
	closeErr   error
	cleanupErr error
	stopReply  *delivery
}

type connection struct {
	ws              *websocket.Conn
	ctx             context.Context
	cancel          context.CancelFunc
	replies         chan outbound
	state           chan json.RawMessage
	frames          chan json.RawMessage
	work            chan struct{}
	workers         sync.WaitGroup
	stopReply       *delivery
	sequenceMu      sync.Mutex
	retiredSequence uint64
}

type outbound struct {
	data     json.RawMessage
	delivery *delivery
}

type delivery struct {
	done chan struct{}
	once sync.Once
	err  error
}

func (d *delivery) finish(err error) {
	if d != nil {
		d.once.Do(func() { d.err = err; close(d.done) })
	}
}

func Start(config Config) (*Server, error) {
	if config.RunID == "" || len(config.RunID) > 256 || config.Backend == nil || config.Stop == nil {
		return nil, errors.New("managed viewer requires a run, backend and stop handler")
	}
	listener, err := net.Listen("tcp4", "127.0.0.1:0")
	if err != nil {
		return nil, err
	}
	ctx, cancel := context.WithCancel(context.Background())
	s := &Server{config: config, listen: listener, origin: "http://" + listener.Addr().String(), ctx: ctx, cancel: cancel, done: make(chan struct{}), admission: make(chan struct{}, 4)}
	if _, err := s.IssueURL(); err != nil {
		cancel()
		_ = listener.Close()
		return nil, err
	}
	s.http = &http.Server{Handler: http.HandlerFunc(s.serve), ReadHeaderTimeout: 3 * time.Second, ReadTimeout: 5 * time.Second, IdleTimeout: 15 * time.Second, MaxHeaderBytes: 8192}
	s.wg.Add(2)
	go func() { defer s.wg.Done(); _ = s.http.Serve(listener) }()
	go func() { defer s.wg.Done(); s.events() }()
	return s, nil
}

// URL contains a one-use capability and must only be shown to the local human.
// Never place it in Info, status, lifecycle records, logs, or a task RPC result.
func (s *Server) URL() string {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.url
}

// IssueURL revokes any unused ticket. An existing viewer must disconnect before
// another human can obtain a new ticket; a task cannot silently take it over.
func (s *Server) IssueURL() (string, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.closed {
		return "", errors.New("managed viewer is closed")
	}
	if s.cleanupErr != nil {
		return "", errors.New("previous viewer rendering cleanup is unconfirmed")
	}
	if s.active != nil {
		return "", errors.New("a managed viewer is already connected")
	}
	secret := make([]byte, 32)
	if _, err := rand.Read(secret); err != nil {
		return "", err
	}
	token := base64.RawURLEncoding.EncodeToString(secret)
	s.ticket = sha256.Sum256([]byte(token))
	s.expires, s.used = time.Now().Add(ticketLifetime), false
	s.url = s.origin + "/#ticket=" + token
	return s.url, nil
}

func (s *Server) Done() <-chan struct{} { return s.done }

// WaitStopReply is a narrow shutdown handoff: after the supervisor completes
// Stop, wait for its original reply's actual WebSocket write before Close.
// A successful write is not a claim that the browser rendered the message.
// No user Stop means there is nothing to await. It never invokes Stop itself.
func (s *Server) WaitStopReply(ctx context.Context) error {
	s.mu.Lock()
	receipt := s.stopReply
	s.mu.Unlock()
	if receipt == nil {
		return nil
	}
	select {
	case <-receipt.done:
		return receipt.err
	case <-ctx.Done():
		return ctx.Err()
	}
}

// Close revokes admission immediately and waits for the actual HTTP/WS readers,
// writers, backend calls and unsubscribe receipt. A caller deadline only bounds
// its wait; cleanup continues and Done closes after those resources settle.
func (s *Server) Close(ctx context.Context) error {
	s.closeOnce.Do(func() {
		s.mu.Lock()
		s.closed, s.used, s.url = true, true, ""
		s.cancel()
		if s.active != nil {
			s.active.cancel()
			_ = s.active.ws.CloseNow()
		}
		s.mu.Unlock()
		go func() {
			httpErr := s.http.Close()
			s.wg.Wait()
			s.mu.Lock()
			s.closeErr = errors.Join(httpErr, s.cleanupErr)
			s.mu.Unlock()
			close(s.done)
		}()
	})
	select {
	case <-s.done:
		return s.closeErr
	case <-ctx.Done():
		return ctx.Err()
	}
}

func (s *Server) serve(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Cache-Control", "no-store")
	w.Header().Set("Referrer-Policy", "no-referrer")
	w.Header().Set("X-Content-Type-Options", "nosniff")
	w.Header().Set("X-Frame-Options", "DENY")
	w.Header().Set("Content-Security-Policy", "default-src 'none'; script-src 'self'; style-src 'self'; img-src blob:; connect-src 'self' ws://"+s.listen.Addr().String()+"; frame-ancestors 'none'; base-uri 'none'; form-action 'none'; object-src 'none'")
	w.Header().Set("Permissions-Policy", "camera=(), microphone=(), geolocation=()")
	if r.Host != s.listen.Addr().String() || r.URL.RawQuery != "" {
		http.Error(w, "Forbidden", http.StatusForbidden)
		return
	}
	if r.Method != http.MethodGet {
		http.Error(w, "Method not allowed", http.StatusMethodNotAllowed)
		return
	}
	if r.URL.Path == "/ws" {
		// WebSocket does not get CORS protection. Require the exact browser Origin,
		// including for non-browser clients; missing/null origins are rejected.
		if r.Header.Get("Origin") != s.origin || len(r.Header.Values("Origin")) != 1 {
			http.Error(w, "Forbidden", http.StatusForbidden)
			return
		}
		s.serveWS(w, r)
		return
	}
	name, kind := "", ""
	switch r.URL.Path {
	case "/":
		name, kind = "ui/index.html", "text/html; charset=utf-8"
	case "/viewer.js":
		name, kind = "ui/viewer.js", "text/javascript; charset=utf-8"
	case "/viewer.css":
		name, kind = "ui/viewer.css", "text/css; charset=utf-8"
	default:
		http.NotFound(w, r)
		return
	}
	data, err := assets.ReadFile(name)
	if err != nil {
		http.Error(w, "Unavailable", http.StatusInternalServerError)
		return
	}
	w.Header().Set("Content-Type", kind)
	_, _ = w.Write(data)
}

func (s *Server) serveWS(w http.ResponseWriter, r *http.Request) {
	select {
	case s.admission <- struct{}{}:
		defer func() { <-s.admission }()
	default:
		http.Error(w, "Busy", http.StatusTooManyRequests)
		return
	}
	s.mu.Lock()
	if s.closed {
		s.mu.Unlock()
		http.Error(w, "Closed", http.StatusServiceUnavailable)
		return
	}
	s.wg.Add(1)
	s.mu.Unlock()
	defer s.wg.Done()
	ws, err := websocket.Accept(w, r, &websocket.AcceptOptions{CompressionMode: websocket.CompressionDisabled})
	if err != nil {
		return
	}
	defer ws.CloseNow()
	ws.SetReadLimit(8192)
	ctx, cancel := context.WithCancel(s.ctx)
	defer cancel()
	authCtx, authCancel := context.WithTimeout(ctx, 2*time.Second)
	kind, payload, err := ws.Read(authCtx)
	authCancel()
	if err != nil || kind != websocket.MessageText {
		return
	}
	f, err := object(payload)
	var token, authType string
	if err != nil || len(f) != 2 || json.Unmarshal(f["type"], &authType) != nil || authType != "authenticate" || json.Unmarshal(f["token"], &token) != nil || len(token) != 43 {
		return
	}
	digest := sha256.Sum256([]byte(token))
	c := &connection{ws: ws, ctx: ctx, cancel: cancel, replies: make(chan outbound, 16), state: make(chan json.RawMessage, 1), frames: make(chan json.RawMessage, 1), work: make(chan struct{}, 4)}
	s.mu.Lock()
	if s.closed || s.active != nil || s.used || !time.Now().Before(s.expires) || subtle.ConstantTimeCompare(digest[:], s.ticket[:]) != 1 {
		s.mu.Unlock()
		return
	}
	s.used, s.active = true, c
	s.mu.Unlock()
	defer func() {
		cancel()
		_ = ws.CloseNow()
		c.workers.Wait()
		c.stopReply.finish(errors.New("viewer connection closed before Stop reply delivery was confirmed"))
		// A disconnected viewer relinquishes only its rendering subscription.
		// It never pauses/resumes the agent or closes the browser implicitly.
		cleanup, finish := context.WithTimeout(context.Background(), 30*time.Second)
		_, cleanupErr := s.config.Backend.Command(cleanup, json.RawMessage(`{"operation":"select","tabId":null}`))
		finish()
		s.mu.Lock()
		if cleanupErr != nil {
			s.cleanupErr = errors.New("viewer rendering cleanup was not confirmed")
		}
		if s.active == c {
			s.active = nil
		}
		s.mu.Unlock()
	}()
	c.reply(jsonBytes(map[string]any{"type": "authenticated"}))
	c.workers.Add(1)
	go func() { defer c.workers.Done(); c.write() }()
	var lastID uint64
	stopRequested := false
	for {
		kind, payload, err := ws.Read(ctx)
		if err != nil || kind != websocket.MessageText {
			return
		}
		request, err := parseCommand(payload)
		if err != nil || request.id <= lastID {
			return // No invalid/duplicate command can reach the backend.
		}
		lastID = request.id
		if request.operation == "stop" {
			if stopRequested {
				c.failure(request.id, "STOP_PENDING", "停止请求正在处理中。")
				continue
			}
			stopRequested = true
			c.stopReply = &delivery{done: make(chan struct{})}
			s.mu.Lock()
			s.stopReply = c.stopReply
			s.mu.Unlock()
		} else {
			select {
			case c.work <- struct{}{}:
			default:
				c.failure(request.id, "BUSY", "正在处理其他操作，请稍后刷新状态。")
				continue
			}
		}
		c.workers.Add(1)
		go func(request command) {
			defer c.workers.Done()
			if request.operation != "stop" {
				defer func() { <-c.work }()
			}
			s.command(c, request)
		}(request)
	}
}

func (s *Server) command(c *connection, request command) {
	budget := 30 * time.Second
	if request.operation == "stop" {
		budget = 50 * time.Second
	}
	ctx, cancel := context.WithTimeout(c.ctx, budget)
	defer cancel()
	if request.operation == "stop" {
		// Stop is the supervisor's user operation, even after the worker dies.
		if err := s.config.Stop(ctx); err != nil {
			c.enqueue(jsonBytes(map[string]any{"type": "response", "id": request.id, "error": map[string]any{"code": "STOP_UNCONFIRMED", "message": "尚未确认会话已停止。请检查会话状态。"}}), c.stopReply)
			return
		}
		c.enqueue(jsonBytes(map[string]any{"type": "response", "id": request.id, "result": map[string]any{"stopped": true}}), c.stopReply)
		return
	}
	select {
	case <-s.config.Backend.Done():
		c.failure(request.id, "BACKEND_UNAVAILABLE", "浏览器控制连接已断开；仍可停止会话。")
		return
	default:
	}
	result, err := s.config.Backend.Command(ctx, request.payload)
	if err == nil {
		result, err = publicState(result)
	}
	if err != nil {
		c.failure(request.id, "OPERATION_UNCONFIRMED", "未能确认操作结果。请刷新状态，勿自动重试操作。")
		return
	}
	result = c.displayData(result)
	c.reply(jsonBytes(map[string]any{"type": "response", "id": request.id, "result": result}))
}

// A coalesced status must carry prior retirement even if the standalone Clear
// event was replaced. The sequence is display ordering, never new authority.
func (c *connection) displayData(data json.RawMessage) json.RawMessage {
	var fields map[string]json.RawMessage
	_ = json.Unmarshal(data, &fields)
	var kind string
	_ = json.Unmarshal(fields["type"], &kind)
	var sequence uint64
	_ = json.Unmarshal(fields["eventSequence"], &sequence)
	retire := kind == "clear" || kind == "unavailable"
	if fields["status"] != nil {
		var status struct {
			State string `json:"state"`
		}
		_ = json.Unmarshal(fields["status"], &status)
		retire = status.State != "running" || string(fields["selectedTabId"]) == "null"
	}
	c.sequenceMu.Lock()
	defer c.sequenceMu.Unlock()
	if retire && sequence > c.retiredSequence {
		c.retiredSequence = sequence
		select {
		case <-c.frames:
		default:
		}
	}
	fields["retiredSequence"] = jsonBytes(c.retiredSequence)
	return jsonBytes(fields)
}

func (c *connection) failure(id uint64, code, message string) {
	c.reply(jsonBytes(map[string]any{"type": "response", "id": id, "error": map[string]any{"code": code, "message": message}}))
}

func (c *connection) reply(data json.RawMessage) {
	c.enqueue(data, nil)
}

func (c *connection) enqueue(data json.RawMessage, receipt *delivery) {
	if c.ctx.Err() != nil {
		receipt.finish(errors.New("viewer connection closed before reply write"))
		return
	}
	select {
	case c.replies <- outbound{data: data, delivery: receipt}:
	case <-c.ctx.Done():
		receipt.finish(errors.New("viewer connection closed before reply write"))
	default:
		receipt.finish(errors.New("viewer control reply queue is full"))
		c.cancel() // Never discard a control result and leave the UI believing it.
		_ = c.ws.CloseNow()
	}
}

func latest(queue chan json.RawMessage, data json.RawMessage) {
	select {
	case queue <- data:
	default:
		select {
		case <-queue:
		default:
		}
		select {
		case queue <- data:
		default:
		}
	}
}

func (c *connection) write() {
	defer c.cancel()
	defer c.ws.CloseNow()
	for {
		var item outbound
		// Pending control receipts take priority over replaceable images.
		select {
		case item = <-c.replies:
		default:
			select {
			case <-c.ctx.Done():
				return
			case item = <-c.replies:
			case item.data = <-c.state:
			case item.data = <-c.frames:
			}
		}
		ctx, cancel := context.WithTimeout(c.ctx, 2*time.Second)
		err := c.ws.Write(ctx, websocket.MessageText, item.data)
		cancel()
		if err != nil {
			item.delivery.finish(errors.New("viewer reply write failed"))
		} else {
			item.delivery.finish(nil)
		}
		if err != nil {
			return
		}
	}
}

func (s *Server) events() {
	for {
		select {
		case <-s.ctx.Done():
			return
		case <-s.config.Backend.Done():
			s.unavailable()
			return
		case data, ok := <-s.config.Backend.Events():
			if !ok {
				s.unavailable()
				return
			}
			kind, public, err := publicEvent(data)
			if err != nil {
				continue
			}
			s.mu.Lock()
			if c := s.active; c != nil {
				public = c.displayData(public)
				if kind == "frame" {
					latest(c.frames, public)
				} else {
					latest(c.state, public)
				}
			}
			s.mu.Unlock()
		}
	}
}

func (s *Server) unavailable() {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.active != nil {
		latest(s.active.state, jsonBytes(map[string]any{"type": "unavailable", "message": "浏览器控制连接已断开；仍可停止会话。"}))
	}
}

func (s *Server) String() string { return fmt.Sprintf("managed viewer (%s)", s.config.RunID) }

package host

import (
	"context"
	"crypto/rand"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"net"
	"os"
	"path/filepath"
	"runtime"
	"strconv"
	"sync"
	"sync/atomic"
	"time"

	"github.com/ifuryst/open-browser-use/internal/transport"
	"github.com/ifuryst/open-browser-use/internal/wire"
)

const NativeHostName = "com.ifuryst.open_browser_use.extension"
const maxClientSessions = 128
const maxClientSessionBytes = 1024

var DefaultSocketDir = defaultSocketDir()

type Config struct {
	SocketDir  string
	SocketPath string
	Logger     *slog.Logger
}

type Relay struct {
	config Config
	logger *slog.Logger

	stdin  io.Reader
	stdout io.Writer

	listener net.Listener

	mu                sync.Mutex
	clients           map[int64]*clientConn
	pending           map[string]pendingRequest
	nextID            atomic.Int64
	nextReqID         atomic.Int64
	writeMu           sync.Mutex
	nativeChunks      atomic.Bool
	nativeQueuedBytes atomic.Int64
	closing           bool
	writers           sync.WaitGroup
	clientWriteLimits clientWriteLimits
	browserBinding    *browserBinding
}

type pendingRequest struct {
	client     *clientConn
	originalID any
}

type ActiveSocketRecord struct {
	SocketPath string    `json:"socketPath"`
	PID        int       `json:"pid"`
	StartedAt  time.Time `json:"startedAt"`
}

func NewRelay(config Config, stdin io.Reader, stdout io.Writer) *Relay {
	logger := config.Logger
	if logger == nil {
		logger = slog.New(slog.NewTextHandler(os.Stderr, nil))
	}
	r := &Relay{
		config:            config,
		logger:            logger,
		stdin:             stdin,
		stdout:            stdout,
		clients:           make(map[int64]*clientConn),
		pending:           make(map[string]pendingRequest),
		clientWriteLimits: defaultClientWriteLimits,
	}
	r.browserBinding = newBrowserBinding(r)
	return r
}

func (r *Relay) SocketPath() string {
	if r.config.SocketPath != "" {
		return r.config.SocketPath
	}
	return transport.NewEndpoint(socketDir(r.config.SocketDir), randomID())
}

func (r *Relay) Serve(ctx context.Context) error {
	ctx, cancel := context.WithCancel(ctx)
	defer cancel()
	socketPath := r.SocketPath()
	if !transport.IsNamedPipe(socketPath) {
		if err := os.MkdirAll(filepath.Dir(socketPath), 0o700); err != nil {
			return err
		}
	}
	listener, err := transport.Listen(socketPath)
	if err != nil {
		return fmt.Errorf("listen local endpoint %q (path length %d): %w", socketPath, len(socketPath), err)
	}
	r.listener = listener
	if err := WriteEndpointRecord(r.config.SocketDir, socketPath); err != nil {
		_ = listener.Close()
		return err
	}
	if err := WriteActiveSocketRecord(r.config.SocketDir, socketPath); err != nil {
		_ = listener.Close()
		_ = RemoveEndpointRecord(r.config.SocketDir, socketPath)
		return err
	}
	r.logger.Info("open-browser-use native host listening", "socket", socketPath)

	errCh := make(chan error, 2)
	go func() { errCh <- r.acceptLoop(ctx) }()
	go func() { errCh <- r.readExtensionLoop() }()
	go func() {
		<-ctx.Done()
		_ = listener.Close()
		r.closeClients()
	}()

	err = <-errCh
	_ = listener.Close()
	_ = transport.RemoveEndpoint(socketPath)
	_ = RemoveEndpointRecord(r.config.SocketDir, socketPath)
	_ = RemoveActiveSocketRecord(r.config.SocketDir, socketPath)
	r.closeClients()
	if errors.Is(err, net.ErrClosed) || errors.Is(err, io.EOF) || errors.Is(err, context.Canceled) {
		return nil
	}
	return err
}

func (r *Relay) acceptLoop(ctx context.Context) error {
	for {
		conn, err := r.listener.Accept()
		if err != nil {
			if ctx.Err() != nil {
				return ctx.Err()
			}
			return err
		}
		id := r.nextID.Add(1)
		client := newClientConn(id, conn, r.clientWriteLimits, r.removeClient)
		r.mu.Lock()
		if r.closing {
			r.mu.Unlock()
			client.close(nil)
			return net.ErrClosed
		}
		r.clients[id] = client
		r.writers.Add(1)
		r.mu.Unlock()
		go func() { defer r.writers.Done(); client.writeLoop() }()
		go r.readClientLoop(client)
	}
}

func (r *Relay) readClientLoop(client *clientConn) {
	defer client.close(nil)

	for {
		payload, err := wire.ReadFrame(client.conn, wire.DefaultMaxFrame)
		if err != nil {
			return
		}
		receivedAt := time.Now()
		if r.browserBinding.handleClient(client, payload, receivedAt) {
			continue
		}
		forwarded, hostID, originalID, err := r.rewriteClientRequest(payload)
		if err != nil {
			r.writeClientError(client, originalID, err)
			continue
		}
		if hostID != "" {
			if err := r.bindRequestSession(client, payload); err != nil {
				r.writeClientError(client, originalID, err)
				continue
			}
			r.mu.Lock()
			if r.clients[client.id] != client {
				r.mu.Unlock()
				return
			}
			r.pending[hostID] = pendingRequest{client: client, originalID: originalID}
			r.mu.Unlock()
		}
		if err := r.writeExtension(forwarded, hostID, receivedAt); err != nil {
			respond := hostID == ""
			if hostID != "" {
				r.mu.Lock()
				if pending, exists := r.pending[hostID]; exists && pending.client == client {
					delete(r.pending, hostID)
					respond = true
				}
				r.mu.Unlock()
			}
			// The receiver can report an assembly timeout while stdout is still
			// writing. Only the side that consumes pending may finish this RPC.
			if respond {
				r.writeClientError(client, originalID, err)
			}
		}
	}
}

func (r *Relay) readExtensionLoop() error {
	for {
		payload, err := wire.ReadFrame(r.stdin, wire.DefaultMaxFrame)
		if err != nil {
			return err
		}
		if err := r.dispatchExtensionPayload(payload); err != nil {
			r.logger.Warn("failed to dispatch extension payload", "error", err)
		}
	}
}

func (r *Relay) rewriteClientRequest(payload []byte) ([]byte, string, any, error) {
	var message map[string]any
	if err := json.Unmarshal(payload, &message); err != nil {
		return nil, "", nil, err
	}
	id, hasID := message["id"]
	if method, _ := message["method"].(string); isNativeTransportMethod(method) {
		return nil, "", id, errNativeTransportReserved
	}
	if !hasID {
		return payload, "", nil, nil
	}
	hostID := "obu:" + strconv.FormatInt(r.nextReqID.Add(1), 10)
	message["id"] = hostID
	forwarded, err := json.Marshal(message)
	return forwarded, hostID, id, err
}

func (r *Relay) dispatchExtensionPayload(payload []byte) error {
	var message map[string]any
	if err := json.Unmarshal(payload, &message); err != nil {
		return err
	}
	if r.browserBinding.consume(message) {
		return nil
	}
	if r.consumeNativeTransportMessage(message) {
		return nil
	}
	id, hasID := message["id"].(string)
	if hasID {
		r.mu.Lock()
		pending, ok := r.pending[id]
		if ok {
			delete(r.pending, id)
		}
		r.mu.Unlock()
		if ok {
			message["id"] = pending.originalID
			rewritten, err := json.Marshal(message)
			if err != nil {
				return err
			}
			return pending.client.write(rewritten)
		}
	}
	// Responses belong only to the client whose request ID we rewrote. A timed
	// out/disconnected client may have gone away before its response arrives;
	// broadcasting that response would corrupt every other client's RPC stream.
	if _, isResponse := message["id"]; isResponse {
		return nil
	}
	method, ok := message["method"].(string)
	if !ok || method == "" {
		return nil
	}
	params, _ := message["params"].(map[string]any)
	if value, scoped := params["session_id"]; scoped {
		session, valid := value.(string)
		if valid && session != "" {
			r.broadcast(payload, session)
		}
		return nil
	}
	// Only this existing notification is global. In particular, older unscoped
	// CDP/download messages must not disclose tab data to unrelated clients.
	if method == "heartbeat" {
		if _, scoped := params["tabId"]; scoped {
			return nil
		}
		if _, scoped := params["source"]; scoped {
			return nil
		}
		r.broadcast(payload, "")
	}
	return nil
}

func (r *Relay) bindRequestSession(client *clientConn, payload []byte) error {
	var request struct {
		JSONRPC string `json:"jsonrpc"`
		Method  string `json:"method"`
		ID      any    `json:"id"`
		Params  struct {
			Session string `json:"session_id"`
		} `json:"params"`
	}
	if json.Unmarshal(payload, &request) != nil || request.JSONRPC != "2.0" || request.Method == "" || request.Params.Session == "" {
		return nil
	}
	switch request.ID.(type) {
	case string, float64:
	default:
		return nil
	}
	if len(request.Params.Session) > maxClientSessionBytes {
		return fmt.Errorf("OBU_SESSION_SUBSCRIPTION_LIMIT: session_id exceeds %d bytes", maxClientSessionBytes)
	}
	r.mu.Lock()
	defer r.mu.Unlock()
	if _, exists := client.sessions[request.Params.Session]; exists {
		return nil
	}
	if len(client.sessions) >= maxClientSessions {
		return fmt.Errorf("OBU_SESSION_SUBSCRIPTION_LIMIT: one connection supports at most %d explicit sessions; open a separate connection", maxClientSessions)
	}
	if client.sessions == nil {
		client.sessions = make(map[string]struct{})
	}
	client.sessions[request.Params.Session] = struct{}{}
	return nil
}

func (r *Relay) writeClientError(client *clientConn, id any, err error) {
	if id == nil {
		id = nil
	}
	_ = client.writeJSON(map[string]any{
		"jsonrpc": "2.0",
		"id":      id,
		"error": map[string]any{
			"code":    -32000,
			"message": err.Error(),
		},
	})
}

func (r *Relay) broadcast(payload []byte, session string) {
	r.mu.Lock()
	clients := make([]*clientConn, 0, len(r.clients))
	for _, client := range r.clients {
		if session != "" {
			if _, subscribed := client.sessions[session]; !subscribed {
				continue
			}
		}
		clients = append(clients, client)
	}
	r.mu.Unlock()
	for _, client := range clients {
		_ = client.write(payload)
	}
}

func (r *Relay) closeClients() {
	r.mu.Lock()
	r.closing = true
	clients := make([]*clientConn, 0, len(r.clients))
	for _, client := range r.clients {
		clients = append(clients, client)
	}
	r.clients = make(map[int64]*clientConn)
	r.pending = make(map[string]pendingRequest)
	r.mu.Unlock()
	for _, client := range clients {
		client.close(nil)
	}
	r.browserBinding.close()
	r.writers.Wait()
}

func (r *Relay) removeClient(client *clientConn, reason error) {
	r.mu.Lock()
	if r.clients[client.id] == client {
		delete(r.clients, client.id)
	}
	for id, pending := range r.pending {
		if pending.client == client {
			delete(r.pending, id)
		}
	}
	r.mu.Unlock()
	if reason != nil {
		r.logger.Warn("closed browser client", "client", client.id, "error", reason)
	}
}

func socketDir(configured string) string {
	if configured != "" {
		return configured
	}
	return DefaultSocketDir
}

func defaultSocketDir() string {
	if runtime.GOOS == "windows" {
		return filepath.Join(os.TempDir(), "open-browser-use")
	}
	return "/tmp/open-browser-use"
}

func ActiveSocketRecordPath(configuredDir string) string {
	return filepath.Join(socketDir(configuredDir), "active.json")
}

func WriteActiveSocketRecord(configuredDir string, socketPath string) error {
	record := ActiveSocketRecord{
		SocketPath: socketPath,
		PID:        os.Getpid(),
		StartedAt:  time.Now().UTC(),
	}
	return SaveActiveSocketRecord(configuredDir, record)
}

// SaveActiveSocketRecord atomically replaces discovery state. Callers repairing
// a registry can preserve an unknown PID instead of assigning their own PID.
func SaveActiveSocketRecord(configuredDir string, record ActiveSocketRecord) error {
	return writeSocketRecord(ActiveSocketRecordPath(configuredDir), record)
}

func ReadActiveSocketRecord(configuredDir string) (ActiveSocketRecord, error) {
	payload, err := os.ReadFile(ActiveSocketRecordPath(configuredDir))
	if err != nil {
		return ActiveSocketRecord{}, err
	}
	var record ActiveSocketRecord
	if err := json.Unmarshal(payload, &record); err != nil {
		return ActiveSocketRecord{}, err
	}
	if record.SocketPath == "" {
		return ActiveSocketRecord{}, errors.New("active socket record has empty socketPath")
	}
	return record, nil
}

func RemoveActiveSocketRecord(configuredDir string, socketPath string) error {
	record, err := ReadActiveSocketRecord(configuredDir)
	if err != nil {
		if errors.Is(err, os.ErrNotExist) {
			return nil
		}
		return err
	}
	if record.SocketPath != socketPath {
		return nil
	}
	return os.Remove(ActiveSocketRecordPath(configuredDir))
}

func randomID() string {
	var bytes [16]byte
	if _, err := rand.Read(bytes[:]); err != nil {
		return fmt.Sprintf("%d-%d", os.Getpid(), time.Now().UnixNano())
	}
	bytes[6] = (bytes[6] & 0x0f) | 0x40
	bytes[8] = (bytes[8] & 0x3f) | 0x80
	return fmt.Sprintf(
		"%08x-%04x-%04x-%04x-%012x",
		bytes[0:4],
		bytes[4:6],
		bytes[6:8],
		bytes[8:10],
		bytes[10:16],
	)
}

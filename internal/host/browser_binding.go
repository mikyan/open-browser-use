package host

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"math"
	"strings"
	"sync"
	"time"

	"github.com/ifuryst/open-browser-use/internal/browserdownloads"
)

const pageDownloadsMethod = "obu.native.pageDownloads"
const maxPageDownloadRequests = 4096
const maxPageDownloadPending = 32

type pageDownloadManager interface {
	Generation() string
	Done() <-chan struct{}
	Err() error
	Claim(context.Context, browserdownloads.Claim) error
	Path(context.Context, browserdownloads.Claim) (string, error)
	Cancel(context.Context, browserdownloads.Claim) error
	Release(browserdownloads.Claim)
	Close() error
}

type browserBindAttempt struct {
	ctx              context.Context
	cancel           context.CancelFunc
	requestID, nonce string
	identity         chan browserdownloads.Identity
	answered         bool
	committed        bool
	clientDone       <-chan struct{}
}

type boundBrowser struct {
	manager           pageDownloadManager
	nonce, generation string
	ctx               context.Context
	cancel            context.CancelFunc
	seen              map[string]struct{}
	pending           int
}

// One native port owns this state. Neither SDK session labels nor an endpoint
// path can replace this identity. Network work never holds mu.
type browserBinding struct {
	relay      *Relay
	mu         sync.Mutex
	closed     bool
	done       chan struct{}
	closeDone  chan struct{}
	attempt    *browserBindAttempt
	current    *boundBrowser
	writes     chan struct{}
	rejections chan struct{}
	dial       func(context.Context, string, browserdownloads.Identity) (pageDownloadManager, error)
}

func newBrowserBinding(r *Relay) *browserBinding {
	return &browserBinding{relay: r, done: make(chan struct{}), closeDone: make(chan struct{}), writes: make(chan struct{}, maxPageDownloadPending), rejections: make(chan struct{}, 8),
		dial: func(ctx context.Context, url string, identity browserdownloads.Identity) (pageDownloadManager, error) {
			return browserdownloads.Dial(ctx, url, identity)
		}}
}

func bindingError(code, message string) error {
	return fmt.Errorf("OBU_BROWSER_BIND_%s: %s", code, message)
}
func bindingContextError(ctx context.Context) error {
	if err := ctx.Err(); err != nil {
		return err
	}
	// Timer delivery can lag the actual deadline. Native writes must not gain
	// time merely because cancellation has not yet been scheduled.
	if deadline, ok := ctx.Deadline(); ok && !time.Now().Before(deadline) {
		return context.DeadlineExceeded
	}
	return nil
}
func privateFailureMessage(err error) string {
	message := strings.ReplaceAll(err.Error(), "\x00", "\ufffd")
	if len(message) > 4000 {
		message = strings.ToValidUTF8(message[:4000], "\ufffd") + "..."
	}
	return message
}
func boundedText(value string) bool {
	return value != "" && len(value) <= 256 && !strings.ContainsAny(value, "\x00\r\n")
}
func strictDecode(value any, output any) error {
	data, err := json.Marshal(value)
	if err != nil {
		return err
	}
	decoder := json.NewDecoder(bytes.NewReader(data))
	decoder.DisallowUnknownFields()
	return decoder.Decode(output)
}
func validHostID(id any) bool {
	switch v := id.(type) {
	case string:
		return boundedText(v)
	case float64:
		return !math.IsNaN(v) && !math.IsInf(v, 0) && math.Trunc(v) == v && math.Abs(v) <= 9007199254740991
	default:
		return false
	}
}

func (b *browserBinding) handleClient(client *clientConn, payload []byte, receivedAt time.Time) bool {
	// Avoid decoding/copying ordinary large SDK payloads a second time.
	var header struct {
		Method string `json:"method"`
	}
	if json.Unmarshal(payload, &header) != nil || !strings.HasPrefix(header.Method, "host.") {
		return false
	}
	var message map[string]any
	_ = json.Unmarshal(payload, &message)
	method := header.Method
	reject := func(err error) { b.relay.writeClientError(client, message["id"], err) }
	if method != "host.bindBrowser" {
		reject(bindingError("METHOD", "unknown local host method"))
		return true
	}
	if len(message) != 4 || message["jsonrpc"] != "2.0" || !validHostID(message["id"]) {
		reject(bindingError("INVALID", "binding requires a JSON-RPC request with an ID"))
		return true
	}
	var params struct {
		CDPURL    string `json:"cdpURL"`
		Exclusive bool   `json:"exclusive"`
		TimeoutMS int64  `json:"timeoutMs"`
	}
	if strictDecode(message["params"], &params) != nil || !params.Exclusive || params.TimeoutMS < 1 || params.TimeoutMS > 120000 {
		reject(bindingError("INVALID", "require cdpURL, exclusive:true and timeoutMs from 1 to 120000"))
		return true
	}
	if err := browserdownloads.ValidateURL(params.CDPURL); err != nil {
		reject(err)
		return true
	}
	ctx, cancel := context.WithDeadline(context.Background(), receivedAt.Add(time.Duration(params.TimeoutMS)*time.Millisecond))
	attempt := &browserBindAttempt{ctx: ctx, cancel: cancel, requestID: randomID(), nonce: randomID() + randomID(), identity: make(chan browserdownloads.Identity, 1), clientDone: client.done}
	b.mu.Lock()
	var err error
	switch {
	case b.closed:
		err = bindingError("DISCONNECTED", "native port has closed")
	case b.attempt != nil:
		err = bindingError("BUSY", "a binding attempt is already pending")
	case b.current != nil:
		err = bindingError("ALREADY_BOUND", "the original Browser connection is still bound or closing")
	default:
		b.attempt = attempt
	}
	b.mu.Unlock()
	if err != nil {
		cancel()
		reject(err)
		return true
	}
	go func() {
		select {
		case <-client.done:
			b.mu.Lock()
			if !attempt.committed {
				cancel()
			}
			b.mu.Unlock()
		case <-ctx.Done():
		}
	}()
	go func() {
		result, err := b.bind(attempt, params.CDPURL)
		cancel()
		b.mu.Lock()
		if b.attempt == attempt {
			b.attempt = nil
		}
		b.mu.Unlock()
		if err != nil {
			reject(err)
			return
		}
		_ = client.writeJSON(map[string]any{"jsonrpc": "2.0", "id": message["id"], "result": result})
	}()
	return true
}

func (b *browserBinding) bind(a *browserBindAttempt, url string) (map[string]any, error) {
	if err := b.send(a.ctx, map[string]any{"type": "challenge", "requestId": a.requestID, "nonce": a.nonce}, nil); err != nil {
		return nil, err
	}
	var identity browserdownloads.Identity
	select {
	case identity = <-a.identity:
	case <-a.ctx.Done():
		return nil, a.ctx.Err()
	case <-b.done:
		return nil, bindingError("DISCONNECTED", "native port closed during challenge")
	}
	if identity.Nonce != a.nonce || !boundedText(identity.ExtensionID) || !boundedText(identity.ExtensionInstanceID) || !boundedText(identity.WorkerBootID) || !boundedText(identity.PortID) {
		return nil, bindingError("IDENTITY", "extension challenge returned an invalid identity")
	}
	manager, err := b.dial(a.ctx, url, identity)
	if err != nil {
		return nil, err
	}
	ctx, cancel := context.WithCancel(context.Background())
	bound := &boundBrowser{manager: manager, nonce: a.nonce, generation: manager.Generation(), ctx: ctx, cancel: cancel, seen: make(map[string]struct{})}
	b.mu.Lock()
	select {
	case <-a.clientDone:
		err = bindingError("DISCONNECTED", "binding client closed before commit")
	default:
	}
	select {
	case <-manager.Done():
		err = bindingError("DISCONNECTED", "Browser closed before commit")
	default:
	}
	if b.closed || b.attempt != a || bindingContextError(a.ctx) != nil {
		err = bindingError("DISCONNECTED", "binding was canceled before commit")
	}
	if !boundedText(bound.generation) {
		err = bindingError("IDENTITY", "Browser binding has no generation")
	}
	// A late setup result also occupies the slot until Close actually finishes;
	// its default reset must not run against a replacement Manager.
	if !b.closed && b.attempt == a {
		b.current = bound
	}
	if err == nil {
		a.committed = true
	}
	b.mu.Unlock()
	var readyWritten chan struct{}
	if err == nil {
		// Ownership has moved to Relay. CLI EOF no longer cancels this binding,
		// but publishing readiness still uses the original setup deadline.
		deadline, _ := a.ctx.Deadline()
		readyCtx, readyCancel := context.WithDeadline(bound.ctx, deadline)
		readyWritten = make(chan struct{})
		err = b.sendTracked(readyCtx, map[string]any{"type": "ready", "nonce": bound.nonce, "generation": bound.generation, "available": true}, func() error { return b.check(bound) }, readyWritten)
		readyCancel()
	}
	if err != nil {
		cancel()
		go b.retire(bound, err, readyWritten)
		return nil, err
	}
	go b.watch(bound)
	return map[string]any{"bound": true, "generation": bound.generation, "extensionId": identity.ExtensionID, "extensionInstanceId": identity.ExtensionInstanceID, "workerBootId": identity.WorkerBootID, "portId": identity.PortID, "exclusive": true, "behavior": "default"}, nil
}

func (b *browserBinding) check(bound *boundBrowser) error {
	b.mu.Lock()
	defer b.mu.Unlock()
	if b.closed || b.current != bound {
		return bindingError("DISCONNECTED", "original Browser binding is unavailable")
	}
	select {
	case <-bound.manager.Done():
		return bindingError("DISCONNECTED", "original Browser connection closed")
	default:
		return nil
	}
}

func (b *browserBinding) watch(bound *boundBrowser) {
	select {
	case <-bound.manager.Done():
	case <-b.done:
		return
	}
	bound.cancel()
	// Keep the old binding occupied until its cleanup finishes: a late default
	// reset must never disable the replacement observer.
	err := bound.manager.Err()
	if err == nil {
		err = bindingError("DISCONNECTED", "original Browser connection closed")
	}
	b.retire(bound, err, nil)
}

func (b *browserBinding) retire(bound *boundBrowser, err error, readyWritten <-chan struct{}) {
	bound.cancel()
	if cleanupError := bound.manager.Close(); cleanupError != nil {
		err = fmt.Errorf("%v; Browser cleanup: %w", err, cleanupError)
		b.relay.logger.Warn("Browser binding cleanup failed", "error", cleanupError)
	}
	if readyWritten != nil {
		// A native write already entered may finish after its caller's timeout.
		// Send revocation only after that actual write; otherwise late ready:true
		// could resurrect capability after the cleanup notification expired.
		select {
		case <-readyWritten:
		case <-b.done:
			return
		}
	}
	b.unavailable(bound, err)
	b.mu.Lock()
	if b.current == bound {
		b.current = nil
	}
	b.mu.Unlock()
}

func (b *browserBinding) unavailable(bound *boundBrowser, failure error) {
	ctx, cancel := context.WithTimeout(context.Background(), time.Second)
	defer cancel()
	_ = b.send(ctx, map[string]any{"type": "ready", "nonce": bound.nonce, "generation": bound.generation, "available": false, "reason": privateFailureMessage(failure)}, nil)
}

func (b *browserBinding) close() {
	b.mu.Lock()
	if b.closed {
		b.mu.Unlock()
		<-b.closeDone
		return
	}
	b.closed = true
	close(b.done)
	if b.attempt != nil {
		b.attempt.cancel()
	}
	bound := b.current
	b.current = nil
	b.mu.Unlock()
	defer close(b.closeDone)
	if bound != nil {
		bound.cancel()
		if err := bound.manager.Close(); err != nil {
			b.relay.logger.Warn("Browser binding shutdown failed", "error", err)
		}
	}
}

// Native stdout shares the existing write lock. The bounded slot is held until
// the actual write returns; an expired caller never queues an unbounded writer.
// Recheck its deadline after acquiring the lock, before any bytes are sent.
func (b *browserBinding) send(ctx context.Context, params map[string]any, validate func() error) error {
	return b.sendTracked(ctx, params, validate, nil)
}

func (b *browserBinding) sendTracked(ctx context.Context, params map[string]any, validate func() error, written chan struct{}) error {
	launched := false
	defer func() {
		if !launched && written != nil {
			close(written)
		}
	}()
	if err := bindingContextError(ctx); err != nil {
		return err
	}
	params["version"] = 1
	data, err := json.Marshal(map[string]any{"jsonrpc": "2.0", "method": pageDownloadsMethod, "params": params})
	if err != nil {
		return err
	}
	select {
	case b.writes <- struct{}{}:
	case <-ctx.Done():
		return ctx.Err()
	case <-b.done:
		return bindingError("DISCONNECTED", "native port closed")
	}
	result := make(chan error, 1)
	launched = true
	go func() {
		if written != nil {
			defer close(written)
		}
		defer func() { <-b.writes }()
		b.relay.writeMu.Lock()
		defer b.relay.writeMu.Unlock()
		if err := bindingContextError(ctx); err != nil {
			result <- err
			return
		}
		select {
		case <-b.done:
			result <- bindingError("DISCONNECTED", "native port closed")
			return
		default:
		}
		if validate != nil {
			if err := validate(); err != nil {
				result <- err
				return
			}
		}
		result <- b.relay.writeNativeFrameLocked(data)
	}()
	select {
	case err := <-result:
		if err != nil {
			return err
		}
		return bindingContextError(ctx)
	case <-ctx.Done():
		return ctx.Err()
	case <-b.done:
		return bindingError("DISCONNECTED", "native port closed")
	}
}

func (b *browserBinding) consume(message map[string]any) bool {
	if message["method"] != pageDownloadsMethod {
		return false
	}
	params, ok := message["params"].(map[string]any)
	if !ok || len(message) != 3 || message["jsonrpc"] != "2.0" || params["version"] != float64(1) {
		return true
	}
	switch params["type"] {
	case "response":
		var response struct {
			Version   int                       `json:"version"`
			Type      string                    `json:"type"`
			RequestID string                    `json:"requestId"`
			Nonce     string                    `json:"nonce"`
			Result    browserdownloads.Identity `json:"result"`
		}
		if strictDecode(params, &response) != nil {
			return true
		}
		b.mu.Lock()
		a := b.attempt
		if a != nil && !a.answered && bindingContextError(a.ctx) == nil && response.RequestID == a.requestID && response.Nonce == a.nonce {
			a.answered = true
			a.identity <- response.Result
		}
		b.mu.Unlock()
	case "request":
		b.request(params)
	}
	return true
}

type pageDownloadRequest struct {
	Version    int                    `json:"version"`
	Type       string                 `json:"type"`
	RequestID  string                 `json:"requestId"`
	Nonce      string                 `json:"nonce"`
	Generation string                 `json:"generation"`
	Operation  string                 `json:"operation"`
	Payload    browserdownloads.Claim `json:"payload"`
	TimeoutMS  int64                  `json:"timeoutMs"`
}

func (b *browserBinding) request(params map[string]any) {
	var request pageDownloadRequest
	if strictDecode(params, &request) != nil || !boundedText(request.RequestID) || request.TimeoutMS < 1 || request.TimeoutMS > 120000 {
		return
	}
	if request.Operation != "claim" && request.Operation != "path" && request.Operation != "cancel" && request.Operation != "release" {
		return
	}
	b.mu.Lock()
	bound := b.current
	if b.closed || bound == nil || bound.nonce != request.Nonce || bound.generation != request.Generation {
		b.mu.Unlock()
		return
	}
	_, duplicate := bound.seen[request.RequestID]
	if duplicate {
		b.mu.Unlock()
		return
	} // Never issue a second reply for an in-flight ID.
	capacity := len(bound.seen) >= maxPageDownloadRequests || bound.pending >= maxPageDownloadPending
	if len(bound.seen) < maxPageDownloadRequests {
		bound.seen[request.RequestID] = struct{}{}
	}
	if capacity {
		b.mu.Unlock()
		// A full registry must not block the shared native reader while writing
		// an error. Excess rejection work is dropped, never queued unboundedly.
		select {
		case b.rejections <- struct{}{}:
			go func() {
				defer func() { <-b.rejections }()
				b.reply(bound, request, nil, bindingError("CAPACITY", "private request capacity exceeded"))
			}()
		default:
		}
		return
	}
	bound.pending++
	ctx, cancel := context.WithTimeout(bound.ctx, time.Duration(request.TimeoutMS)*time.Millisecond)
	b.mu.Unlock()
	go func() {
		defer func() { cancel(); b.mu.Lock(); bound.pending--; b.mu.Unlock() }()
		var result any = map[string]any{}
		err := b.check(bound)
		if err == nil {
			err = bindingContextError(ctx)
		}
		if err == nil {
			switch request.Operation {
			case "claim":
				err = bound.manager.Claim(ctx, request.Payload)
			case "path":
				var value string
				value, err = bound.manager.Path(ctx, request.Payload)
				result = map[string]any{"path": value}
			case "cancel":
				err = bound.manager.Cancel(ctx, request.Payload)
				result = map[string]any{"cancelled": true}
			case "release":
				bound.manager.Release(request.Payload)
			}
		}
		if err == nil {
			err = bindingContextError(ctx)
		}
		b.reply(bound, request, result, err)
	}()
}

func (b *browserBinding) reply(bound *boundBrowser, request pageDownloadRequest, result any, failure error) {
	params := map[string]any{"type": "reply", "requestId": request.RequestID, "nonce": request.Nonce, "generation": request.Generation}
	if failure != nil {
		params["error"] = map[string]any{"message": privateFailureMessage(failure)}
	} else {
		params["result"] = result
	}
	ctx, cancel := context.WithTimeout(context.Background(), time.Second)
	defer cancel()
	_ = b.send(ctx, params, func() error { return b.check(bound) })
}

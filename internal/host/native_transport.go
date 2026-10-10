package host

import (
	"encoding/base64"
	"encoding/json"
	"errors"
	"math"
	"strings"
	"time"

	"github.com/ifuryst/open-browser-use/internal/wire"
)

const (
	maxNativeFrameBytes  = 1024 * 1024
	nativeChunkBytes     = 512 * 1024
	maxNativeQueuedBytes = 128 * 1024 * 1024
	defaultNativeBudget  = 10 * time.Second
)

var (
	errNativeMessageTooLarge       = errors.New("OBU_NATIVE_MESSAGE_TOO_LARGE: request exceeds native transport capacity or chunking is unavailable")
	errNativeTransportTimeout      = errors.New("OBU_NATIVE_TRANSPORT_TIMEOUT: request expired before native transport commit")
	errNativeTransportReserved     = errors.New("OBU_NATIVE_TRANSPORT_RESERVED: private native transport methods cannot be submitted by clients")
	errNativeTransportBudget       = errors.New("OBU_NATIVE_TRANSPORT_INVALID_TIMEOUT: timeoutMs must be a finite number from 1 to 120000")
	errNativeTransportBackpressure = errors.New("OBU_NATIVE_TRANSPORT_BACKPRESSURE: large native requests exceed the queued payload capacity")
)

func isNativeTransportMethod(method string) bool {
	return strings.HasPrefix(method, "obu.native.")
}

// This capability belongs to this native port, not to a session or an SDK.
// Older hosts ignore the notification; older extensions never send it.
func (r *Relay) consumeNativeTransportMessage(message map[string]any) bool {
	method, _ := message["method"].(string)
	if !isNativeTransportMethod(method) {
		return false
	}
	_, hasID := message["id"]
	params, _ := message["params"].(map[string]any)
	if method == "obu.native.hello" && !hasID && message["jsonrpc"] == "2.0" && params["version"] == float64(1) {
		r.nativeChunks.Store(true)
	}
	return true
}

func nativeRequestBudget(payload []byte) (time.Duration, error) {
	var request struct {
		Params map[string]json.RawMessage `json:"params"`
	}
	if json.Unmarshal(payload, &request) != nil {
		return 0, errNativeTransportBudget
	}
	raw, exists := request.Params["timeoutMs"]
	if !exists {
		return defaultNativeBudget, nil
	}
	var milliseconds float64
	if json.Unmarshal(raw, &milliseconds) != nil || milliseconds < 1 || milliseconds > 120000 || math.IsNaN(milliseconds) || math.IsInf(milliseconds, 0) {
		return 0, errNativeTransportBudget
	}
	return time.Duration(milliseconds * float64(time.Millisecond)), nil
}

// The deadline starts when the host has received the complete local IPC frame.
// This does not recover time already spent in the SDK or in the inbound stream.
// Holding writeMu across start/chunks/commit gives each port one assembler.
func (r *Relay) writeExtension(payload []byte, hostID string, receivedAt time.Time) error {
	if len(payload) > wire.DefaultMaxFrame {
		return errNativeMessageTooLarge
	}
	if len(payload) <= maxNativeFrameBytes {
		r.writeMu.Lock()
		defer r.writeMu.Unlock()
		return r.writeNativeFrameLocked(payload)
	}
	if hostID == "" || !r.nativeChunks.Load() {
		return errNativeMessageTooLarge
	}
	budget, err := nativeRequestBudget(payload)
	if err != nil {
		return err
	}
	if !r.reserveNativePayload(int64(len(payload))) {
		return errNativeTransportBackpressure
	}
	defer r.nativeQueuedBytes.Add(-int64(len(payload)))
	deadline := receivedAt.Add(budget)
	r.writeMu.Lock()
	defer r.writeMu.Unlock()
	remaining := func() int64 { return time.Until(deadline).Milliseconds() }
	remainingMs := remaining()
	if remainingMs < 1 {
		return errNativeTransportTimeout
	}
	chunks := (len(payload) + nativeChunkBytes - 1) / nativeChunkBytes
	if err := r.writeNativeControlLocked("start", map[string]any{
		"id": hostID, "totalBytes": len(payload), "totalChunks": chunks, "timeoutMs": remainingMs,
		"deadlineUnixMs": deadline.UnixMilli(),
	}); err != nil {
		return err
	}
	abortExpired := func() error {
		// A timeout abandons assembly. An I/O failure may have left a partial
		// physical frame, so callers never append an abort after a write error.
		_ = r.writeNativeControlLocked("abort", map[string]any{"id": hostID})
		return errNativeTransportTimeout
	}
	for index, offset := 0, 0; offset < len(payload); index, offset = index+1, offset+nativeChunkBytes {
		if remaining() < 1 {
			return abortExpired()
		}
		end := min(offset+nativeChunkBytes, len(payload))
		encoded, err := json.Marshal(map[string]any{
			"jsonrpc": "2.0", "method": "obu.native.chunk", "params": map[string]any{
				"id": hostID, "index": index, "data": base64.StdEncoding.EncodeToString(payload[offset:end]),
			},
		})
		if err != nil {
			return err
		}
		if remaining() < 1 {
			return abortExpired()
		}
		if err := r.writeNativeFrameLocked(encoded); err != nil {
			return err
		}
	}
	remainingMs = remaining()
	if remainingMs < 1 {
		return abortExpired()
	}
	return r.writeNativeControlLocked("commit", map[string]any{"id": hostID, "remainingMs": remainingMs})
}

// This accounts only for admitted, serialized large payloads waiting for or
// holding writeMu. It is not a bound on inbound IPC buffers, JSON rewriting,
// base64 scratch allocations, or the host's total heap.
func (r *Relay) reserveNativePayload(size int64) bool {
	for {
		used := r.nativeQueuedBytes.Load()
		if size < 1 || size > maxNativeQueuedBytes-used {
			return false
		}
		if r.nativeQueuedBytes.CompareAndSwap(used, used+size) {
			return true
		}
	}
}

func (r *Relay) writeNativeControlLocked(kind string, params map[string]any) error {
	payload, err := json.Marshal(map[string]any{"jsonrpc": "2.0", "method": "obu.native." + kind, "params": params})
	if err != nil {
		return err
	}
	return r.writeNativeFrameLocked(payload)
}

// Every actual host->Chrome frame, including private envelopes, passes here.
// The four-byte native framing header is not part of Chrome's payload limit.
func (r *Relay) writeNativeFrameLocked(payload []byte) error {
	if len(payload) > maxNativeFrameBytes {
		return errNativeMessageTooLarge
	}
	return wire.WriteFrame(r.stdout, payload)
}

package host

import (
	"bytes"
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"io"
	"net"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/ifuryst/open-browser-use/internal/transport"
	"github.com/ifuryst/open-browser-use/internal/wire"
)

func nativeTestPayload(t *testing.T, size int, timeout any) []byte {
	t.Helper()
	params := map[string]any{"text": ""}
	if timeout != nil {
		params["timeoutMs"] = timeout
	}
	request := map[string]any{"jsonrpc": "2.0", "id": "obu:1", "method": "executeCdp", "params": params}
	empty, err := json.Marshal(request)
	if err != nil || len(empty) > size {
		t.Fatal("invalid payload fixture", err)
	}
	params["text"] = strings.Repeat("x", size-len(empty))
	payload, err := json.Marshal(request)
	if err != nil || len(payload) != size {
		t.Fatal("payload fixture size mismatch", err)
	}
	return payload
}

func nativeTestFrames(t *testing.T, buffer *bytes.Buffer) []map[string]any {
	t.Helper()
	var frames []map[string]any
	for buffer.Len() > 0 {
		payload, err := wire.ReadFrame(buffer, maxNativeFrameBytes)
		if err != nil {
			t.Fatal(err)
		}
		var frame map[string]any
		if err := json.Unmarshal(payload, &frame); err != nil {
			t.Fatal(err)
		}
		frames = append(frames, frame)
	}
	return frames
}

func nativeTestAssemble(t *testing.T, frames []map[string]any) []byte {
	t.Helper()
	if len(frames) < 3 || frames[0]["method"] != "obu.native.start" || frames[len(frames)-1]["method"] != "obu.native.commit" {
		t.Fatal("incomplete native transfer")
	}
	start := frames[0]["params"].(map[string]any)
	if int(start["totalChunks"].(float64)) != len(frames)-2 || start["timeoutMs"].(float64) < 1 || start["deadlineUnixMs"].(float64) < 1 {
		t.Fatal("invalid start envelope")
	}
	var restored []byte
	for index, frame := range frames[1 : len(frames)-1] {
		params := frame["params"].(map[string]any)
		if frame["method"] != "obu.native.chunk" || params["id"] != start["id"] || params["index"] != float64(index) {
			t.Fatal("interleaved or out-of-order transfer")
		}
		chunk, err := base64.StdEncoding.Strict().DecodeString(params["data"].(string))
		if err != nil || len(chunk) > nativeChunkBytes || len(chunk) == 0 {
			t.Fatal("invalid chunk", err)
		}
		restored = append(restored, chunk...)
	}
	commit := frames[len(frames)-1]["params"].(map[string]any)
	if len(restored) != int(start["totalBytes"].(float64)) || commit["id"] != start["id"] || commit["remainingMs"].(float64) < 1 || commit["remainingMs"].(float64) > start["timeoutMs"].(float64) {
		t.Fatal("invalid commit envelope")
	}
	return restored
}

func TestNativeTransportExactPhysicalBoundary(t *testing.T) {
	for _, size := range []int{maxNativeFrameBytes - 1, maxNativeFrameBytes} {
		payload := nativeTestPayload(t, size, nil)
		var output bytes.Buffer
		relay := NewRelay(Config{}, nil, &output)
		if err := relay.writeExtension(payload, "obu:1", time.Now()); err != nil {
			t.Fatal(err)
		}
		got, err := wire.ReadFrame(&output, maxNativeFrameBytes)
		if err != nil || !bytes.Equal(got, payload) || output.Len() != 0 {
			t.Fatal("a legacy-sized request was changed", err)
		}
	}
	var output bytes.Buffer
	relay := NewRelay(Config{}, nil, &output)
	if err := relay.writeNativeFrameLocked(make([]byte, maxNativeFrameBytes+1)); !errors.Is(err, errNativeMessageTooLarge) || output.Len() != 0 {
		t.Fatal("physical frame guard wrote an oversized header", err)
	}
}

func TestNativeTransportChunksPreserveUTF8AndEscapedJSON(t *testing.T) {
	// Multibyte text crosses a raw-byte chunk boundary. Decoding each individual
	// chunk as UTF-8 would corrupt this otherwise valid JSON document.
	raw, err := json.Marshal(map[string]any{"jsonrpc": "2.0", "id": "obu:1", "method": "executeCdp", "params": map[string]any{"expression": strings.Repeat("中🙂<&\n", 150000)}})
	if err != nil {
		t.Fatal(err)
	}
	var output bytes.Buffer
	relay := NewRelay(Config{}, nil, &output)
	relay.nativeChunks.Store(true)
	receivedAt := time.Now()
	if err := relay.writeExtension(raw, "obu:1", receivedAt); err != nil {
		t.Fatal(err)
	}
	frames := nativeTestFrames(t, &output)
	if got := nativeTestAssemble(t, frames); !bytes.Equal(got, raw) {
		t.Fatal("native chunks changed the request bytes")
	}
	if frames[0]["params"].(map[string]any)["deadlineUnixMs"] != float64(receivedAt.Add(defaultNativeBudget).UnixMilli()) {
		t.Fatal("wire wall deadline did not preserve the original host admission time")
	}
	if relay.nativeQueuedBytes.Load() != 0 {
		t.Fatal("successful transfer retained its payload reservation")
	}
}

func TestNativeTransportGuardsAfterRemappingAndHTMLEscaping(t *testing.T) {
	var output bytes.Buffer
	relay := NewRelay(Config{}, nil, &output)
	relay.nativeChunks.Store(true)
	for _, count := range []int{maxNativeFrameBytes / 6, wire.DefaultMaxFrame/6 + 1} {
		// SDK JSON can contain literal '<'; Go remarshal expands each to six
		// bytes. Capacity must be checked after that actual wire transformation.
		raw := []byte(`{"jsonrpc":"2.0","id":1,"method":"executeCdp","params":{"text":"` + strings.Repeat("<", count) + `"}}`)
		forwarded, id, _, err := relay.rewriteClientRequest(raw)
		if err != nil {
			t.Fatal(err)
		}
		err = relay.writeExtension(forwarded, id, time.Now())
		if count == maxNativeFrameBytes/6 {
			if err != nil || len(forwarded) <= maxNativeFrameBytes {
				t.Fatal("fixture did not cross the native limit", err)
			}
			if !bytes.Equal(nativeTestAssemble(t, nativeTestFrames(t, &output)), forwarded) {
				t.Fatal("escaped request changed")
			}
		} else if !errors.Is(err, errNativeMessageTooLarge) || output.Len() != 0 {
			t.Fatal("oversized logical request reached native transport", err)
		}
	}
}

func TestNativeTransportHelloIsPrivateAndVersioned(t *testing.T) {
	relay := NewRelay(Config{}, nil, io.Discard)
	for _, payload := range []string{
		`{"jsonrpc":"2.0","method":"obu.native.hello","params":{"version":2}}`,
		`{"jsonrpc":"2.0","method":"obu.native.hello","params":{"version":"1"}}`,
		`{"jsonrpc":"2.0","id":1,"method":"obu.native.hello","params":{"version":1}}`,
		`{"jsonrpc":"2.0","method":"obu.native.chunk","params":{"version":1}}`,
	} {
		if err := relay.dispatchExtensionPayload([]byte(payload)); err != nil || relay.nativeChunks.Load() {
			t.Fatal("invalid hello enabled native chunking", err)
		}
	}
	if err := relay.dispatchExtensionPayload([]byte(`{"jsonrpc":"2.0","method":"obu.native.hello","params":{"version":1}}`)); err != nil || !relay.nativeChunks.Load() {
		t.Fatal("v1 hello did not enable native chunking", err)
	}
	for _, method := range []string{"obu.native.hello", "obu.native.start", "obu.native.chunk", "obu.native.commit", "obu.native.abort", "obu.native.future"} {
		for _, id := range []string{`,"id":17`, ""} {
			_, _, original, err := relay.rewriteClientRequest([]byte(`{"jsonrpc":"2.0","method":"` + method + `"` + id + `,"params":{"version":1}}`))
			if !errors.Is(err, errNativeTransportReserved) || (id != "" && original != float64(17)) {
				t.Fatal("client forged private native transport", method, err)
			}
		}
	}
}

type nativeObservingWriter struct {
	bytes.Buffer
	afterChunk func()
	failChunk  bool
}

func (w *nativeObservingWriter) Write(payload []byte) (int, error) {
	isChunk := bytes.Contains(payload, []byte(`"method":"obu.native.chunk"`))
	if isChunk && w.failChunk {
		return 0, io.ErrClosedPipe
	}
	n, err := w.Buffer.Write(payload)
	if isChunk && w.afterChunk != nil {
		w.afterChunk()
	}
	return n, err
}

func TestNativeTransportExpiresWithoutCommit(t *testing.T) {
	output := &nativeObservingWriter{afterChunk: func() { time.Sleep(250 * time.Millisecond) }}
	relay := NewRelay(Config{}, nil, output)
	relay.nativeChunks.Store(true)
	payload := nativeTestPayload(t, maxNativeFrameBytes+1, 200)
	if err := relay.writeExtension(payload, "obu:1", time.Now()); !errors.Is(err, errNativeTransportTimeout) {
		t.Fatal("slow transfer did not expire", err)
	}
	frames := nativeTestFrames(t, &output.Buffer)
	if len(frames) != 3 || frames[0]["method"] != "obu.native.start" || frames[1]["method"] != "obu.native.chunk" || frames[2]["method"] != "obu.native.abort" {
		t.Fatal("expired transfer was committed or not aborted")
	}
	if relay.nativeQueuedBytes.Load() != 0 {
		t.Fatal("expired transfer retained its payload reservation")
	}
}

func TestNativeTransportQueuedTimeConsumesOriginalBudget(t *testing.T) {
	var output bytes.Buffer
	relay := NewRelay(Config{}, nil, &output)
	relay.nativeChunks.Store(true)
	payload := nativeTestPayload(t, maxNativeFrameBytes+1, 20)
	relay.writeMu.Lock()
	result := make(chan error, 1)
	started := time.Now()
	go func() { result <- relay.writeExtension(payload, "obu:1", started) }()
	time.Sleep(35 * time.Millisecond)
	relay.writeMu.Unlock()
	if err := <-result; !errors.Is(err, errNativeTransportTimeout) || output.Len() != 0 {
		t.Fatal("expired queued request started a fresh transfer", err)
	}
	if relay.nativeQueuedBytes.Load() != 0 {
		t.Fatal("expired queued transfer retained its payload reservation")
	}
}

func TestNativeTransportFailedWriteCannotCommitOrAppendAbort(t *testing.T) {
	output := &nativeObservingWriter{failChunk: true}
	relay := NewRelay(Config{}, nil, output)
	relay.nativeChunks.Store(true)
	if err := relay.writeExtension(nativeTestPayload(t, maxNativeFrameBytes+1, nil), "obu:1", time.Now()); !errors.Is(err, io.ErrClosedPipe) {
		t.Fatal("write failure was suppressed", err)
	}
	if bytes.Contains(output.Bytes(), []byte("obu.native.commit")) || bytes.Contains(output.Bytes(), []byte("obu.native.abort")) {
		t.Fatal("control envelope was appended after an incomplete physical frame")
	}
	if relay.nativeQueuedBytes.Load() != 0 {
		t.Fatal("failed transfer retained its payload reservation")
	}
}

func TestNativeTransportConcurrentCapacityIncludesQueuedPayloads(t *testing.T) {
	var output bytes.Buffer
	relay := NewRelay(Config{}, nil, &output)
	relay.nativeChunks.Store(true)
	payload := nativeTestPayload(t, maxNativeFrameBytes+1, nil)
	// Reserve the unused portion without allocating 126 MiB of filler. The two
	// actual concurrent requests must together consume the remaining capacity.
	base := int64(maxNativeQueuedBytes - 2*len(payload))
	if !relay.reserveNativePayload(base) {
		t.Fatal("initial capacity reservation failed")
	}
	relay.writeMu.Lock()
	results := make(chan error, 2)
	for range 2 {
		go func() { results <- relay.writeExtension(payload, "obu:1", time.Now()) }()
	}
	deadline := time.Now().Add(time.Second)
	for relay.nativeQueuedBytes.Load() != maxNativeQueuedBytes {
		if time.Now().After(deadline) {
			relay.writeMu.Unlock()
			t.Fatal("queued requests did not reserve capacity")
		}
		time.Sleep(time.Millisecond)
	}
	if err := relay.writeExtension(payload, "obu:3", time.Now()); !errors.Is(err, errNativeTransportBackpressure) {
		relay.writeMu.Unlock()
		t.Fatal("overflow request entered the write queue", err)
	}
	relay.writeMu.Unlock()
	for range 2 {
		if err := <-results; err != nil {
			t.Fatal(err)
		}
	}
	if relay.nativeQueuedBytes.Load() != base {
		t.Fatal("completed requests did not return capacity")
	}
	relay.nativeQueuedBytes.Add(-base)
	if err := relay.writeExtension(payload, "obu:4", time.Now()); err != nil || relay.nativeQueuedBytes.Load() != 0 {
		t.Fatal("released capacity was not reusable", err)
	}
}

func TestNativeTransportLargeNotificationAndInvalidBudgetAreRejected(t *testing.T) {
	var output bytes.Buffer
	relay := NewRelay(Config{}, nil, &output)
	relay.nativeChunks.Store(true)
	if err := relay.writeExtension(nativeTestPayload(t, maxNativeFrameBytes+1, nil), "", time.Now()); !errors.Is(err, errNativeMessageTooLarge) || output.Len() != 0 {
		t.Fatal("large notification was admitted", err)
	}
	for _, value := range []string{"null", "0", "-1", "120001", `"20"`, "true"} {
		if _, err := nativeRequestBudget([]byte(`{"params":{"timeoutMs":` + value + `}}`)); !errors.Is(err, errNativeTransportBudget) {
			t.Fatal("invalid budget accepted", value, err)
		}
	}
	if budget, err := nativeRequestBudget([]byte(`{"params":{"timeoutMs":1.5}}`)); err != nil || budget != 1500*time.Microsecond {
		t.Fatal("valid fractional action budget was changed", budget, err)
	}
}

func nativeRelayFixture(t *testing.T) (*Relay, net.Conn, net.Conn, func() net.Conn) {
	t.Helper()
	nativeReader, stdout := net.Pipe()
	stdin, nativeWriter := net.Pipe()
	dir := shortSocketDir(t)
	endpoint := transport.NewEndpoint(dir, filepath.Base(dir))
	relay := NewRelay(Config{SocketDir: dir, SocketPath: endpoint}, stdin, stdout)
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan error, 1)
	go func() { done <- relay.Serve(ctx) }()
	waitForSocket(t, endpoint)
	t.Cleanup(func() {
		cancel()
		_ = nativeReader.Close()
		_ = nativeWriter.Close()
		_ = stdin.Close()
		_ = stdout.Close()
		select {
		case err := <-done:
			if err != nil && !errors.Is(err, net.ErrClosed) && !errors.Is(err, io.ErrClosedPipe) {
				t.Error(err)
			}
		case <-time.After(time.Second):
			t.Error("relay did not stop")
		}
	})
	_ = nativeReader.SetDeadline(time.Now().Add(10 * time.Second))
	_ = nativeWriter.SetDeadline(time.Now().Add(10 * time.Second))
	return relay, nativeReader, nativeWriter, func() net.Conn {
		client, err := transport.DialTimeout(endpoint, time.Second)
		if err != nil {
			t.Fatal(err)
		}
		_ = client.SetDeadline(time.Now().Add(10 * time.Second))
		t.Cleanup(func() { _ = client.Close() })
		return client
	}
}

func TestRelayUnnegotiatedOversizeAndPrivateRequestsKeepConnectionAlive(t *testing.T) {
	relay, nativeReader, nativeWriter, dial := nativeRelayFixture(t)
	client := dial()
	for _, request := range []map[string]any{
		{"jsonrpc": "2.0", "id": 1, "method": "executeCdp", "params": map[string]any{"text": strings.Repeat("a", maxNativeFrameBytes)}},
		{"jsonrpc": "2.0", "id": 2, "method": "obu.native.hello", "params": map[string]any{"version": 1}},
	} {
		if err := wire.WriteJSON(client, request); err != nil {
			t.Fatal(err)
		}
		var response map[string]any
		if err := wire.ReadJSON(client, &response); err != nil {
			t.Fatal(err)
		}
		if response["id"] != float64(request["id"].(int)) || response["error"] == nil || relay.nativeChunks.Load() {
			t.Fatal("request was not rejected locally")
		}
		code := "OBU_NATIVE_MESSAGE_TOO_LARGE"
		if request["id"] == 2 {
			code = "OBU_NATIVE_TRANSPORT_RESERVED"
		}
		failure := response["error"].(map[string]any)["message"].(string)
		if !strings.HasPrefix(failure, code) || len(failure) > 256 {
			t.Fatal("rejection was not a bounded transport error")
		}
	}
	if err := wire.WriteJSON(client, map[string]any{"jsonrpc": "2.0", "id": 3, "method": "ping"}); err != nil {
		t.Fatal(err)
	}
	var forwarded map[string]any
	if err := wire.ReadJSON(nativeReader, &forwarded); err != nil || forwarded["method"] != "ping" {
		t.Fatal("oversize/private request leaked to native port", err)
	}
	if err := wire.WriteJSON(nativeWriter, map[string]any{"jsonrpc": "2.0", "id": forwarded["id"], "result": map[string]any{"alive": true}}); err != nil {
		t.Fatal(err)
	}
	var response map[string]any
	if err := wire.ReadJSON(client, &response); err != nil || response["id"] != float64(3) || response["error"] != nil {
		t.Fatal("connection did not survive rejection", err)
	}
}

func TestRelayNativeBackpressurePreservesSharedConnectionAndSmallRequests(t *testing.T) {
	relay, nativeReader, nativeWriter, dial := nativeRelayFixture(t)
	client := dial()
	relay.nativeChunks.Store(true)
	if !relay.reserveNativePayload(maxNativeQueuedBytes) {
		t.Fatal("unable to fill admission capacity")
	}
	defer relay.nativeQueuedBytes.Add(-maxNativeQueuedBytes)
	if err := wire.WriteJSON(client, map[string]any{"jsonrpc": "2.0", "id": 1, "method": "executeCdp", "params": map[string]any{"text": strings.Repeat("x", maxNativeFrameBytes)}}); err != nil {
		t.Fatal(err)
	}
	var response map[string]any
	if err := wire.ReadJSON(client, &response); err != nil {
		t.Fatal(err)
	}
	if response["id"] != float64(1) || response["error"] == nil || !strings.HasPrefix(response["error"].(map[string]any)["message"].(string), "OBU_NATIVE_TRANSPORT_BACKPRESSURE") {
		t.Fatal("large request was not rejected by admission capacity")
	}
	// Keep the large-message quota full: small traffic is independently usable.
	if err := wire.WriteJSON(client, map[string]any{"jsonrpc": "2.0", "id": 2, "method": "ping"}); err != nil {
		t.Fatal(err)
	}
	var forwarded map[string]any
	if err := wire.ReadJSON(nativeReader, &forwarded); err != nil || forwarded["method"] != "ping" {
		t.Fatal("backpressured request leaked or small traffic was blocked", err)
	}
	if err := wire.WriteJSON(nativeWriter, map[string]any{"jsonrpc": "2.0", "id": forwarded["id"], "result": map[string]any{"alive": true}}); err != nil {
		t.Fatal(err)
	}
	response = nil
	if err := wire.ReadJSON(client, &response); err != nil || response["id"] != float64(2) || response["error"] != nil {
		t.Fatal("small request failed after native admission rejection", err)
	}
}

func TestRelayChunksMultipleClientsWithoutMixingIDs(t *testing.T) {
	relay, nativeReader, nativeWriter, dial := nativeRelayFixture(t)
	clients := []net.Conn{dial(), dial()}
	if err := wire.WriteJSON(nativeWriter, map[string]any{"jsonrpc": "2.0", "method": "obu.native.hello", "params": map[string]any{"version": 1}}); err != nil {
		t.Fatal(err)
	}
	deadline := time.Now().Add(time.Second)
	for !relay.nativeChunks.Load() {
		if time.Now().After(deadline) {
			t.Fatal("hello was not consumed")
		}
		time.Sleep(time.Millisecond)
	}
	var writes sync.WaitGroup
	for index, client := range clients {
		writes.Add(1)
		go func(index int, client net.Conn) {
			defer writes.Done()
			if err := wire.WriteJSON(client, map[string]any{"jsonrpc": "2.0", "id": 7, "method": "executeCdp", "params": map[string]any{"owner": index, "text": strings.Repeat("x", maxNativeFrameBytes)}}); err != nil {
				t.Error(err)
			}
		}(index, client)
	}
	seen := make(map[string]bool)
	for range clients {
		var frames []map[string]any
		for {
			payload, err := wire.ReadFrame(nativeReader, maxNativeFrameBytes)
			if err != nil {
				t.Fatal(err)
			}
			var frame map[string]any
			if err := json.Unmarshal(payload, &frame); err != nil {
				t.Fatal(err)
			}
			frames = append(frames, frame)
			if frame["method"] == "obu.native.commit" {
				break
			}
		}
		var request map[string]any
		if err := json.Unmarshal(nativeTestAssemble(t, frames), &request); err != nil {
			t.Fatal(err)
		}
		id := request["id"].(string)
		if seen[id] {
			t.Fatal("client request IDs collided")
		}
		seen[id] = true
		if err := wire.WriteJSON(nativeWriter, map[string]any{"jsonrpc": "2.0", "id": id, "result": request["params"].(map[string]any)["owner"]}); err != nil {
			t.Fatal(err)
		}
	}
	writes.Wait()
	for index, client := range clients {
		var response map[string]any
		if err := wire.ReadJSON(client, &response); err != nil || response["id"] != float64(7) || response["result"] != float64(index) {
			t.Fatal("chunk response routed to the wrong client or hello leaked", err)
		}
	}
}

func TestRelayEarlyAssemblyErrorAndLaterWriteTimeoutRespondOnlyOnce(t *testing.T) {
	relay, nativeReader, nativeWriter, dial := nativeRelayFixture(t)
	client := dial()
	relay.nativeChunks.Store(true)
	if err := wire.WriteJSON(client, map[string]any{
		"jsonrpc": "2.0", "id": 1, "method": "executeCdp",
		"params": map[string]any{"timeoutMs": 1000, "text": strings.Repeat("x", maxNativeFrameBytes)},
	}); err != nil {
		t.Fatal(err)
	}
	var start map[string]any
	if err := wire.ReadJSON(nativeReader, &start); err != nil || start["method"] != "obu.native.start" {
		t.Fatal("missing native assembly start", err)
	}
	params := start["params"].(map[string]any)
	hostID := params["id"]
	// Leave the next native frame unread. The real net.Pipe writer is blocked,
	// while the independent extension reader consumes this early error.
	if err := wire.WriteJSON(nativeWriter, map[string]any{
		"jsonrpc": "2.0", "id": hostID,
		"error": map[string]any{"code": -32000, "message": "OBU_NATIVE_TRANSPORT_TIMEOUT: receiver assembly expired"},
	}); err != nil {
		t.Fatal(err)
	}
	var response map[string]any
	if err := wire.ReadJSON(client, &response); err != nil || response["id"] != float64(1) || response["error"] == nil {
		t.Fatal("early receiver error was not delivered", err)
	}
	relay.mu.Lock()
	_, pending := relay.pending[hostID.(string)]
	relay.mu.Unlock()
	if pending {
		t.Fatal("receiver error did not consume pending")
	}
	untilExpired := time.Until(time.UnixMilli(int64(params["deadlineUnixMs"].(float64)))) + 5*time.Millisecond
	if untilExpired > 0 {
		time.Sleep(untilExpired)
	}
	// Drain the in-flight chunk and timeout abort. The sender must then return
	// its own timeout without publishing another error for original request 1.
	for {
		var frame map[string]any
		if err := wire.ReadJSON(nativeReader, &frame); err != nil {
			t.Fatal(err)
		}
		if frame["method"] == "obu.native.commit" {
			t.Fatal("expired assembly was committed")
		}
		if frame["method"] == "obu.native.abort" {
			break
		}
	}
	if err := wire.WriteJSON(client, map[string]any{"jsonrpc": "2.0", "id": 2, "method": "ping"}); err != nil {
		t.Fatal(err)
	}
	var ping map[string]any
	if err := wire.ReadJSON(nativeReader, &ping); err != nil || ping["method"] != "ping" {
		t.Fatal("subsequent request did not reach native port", err)
	}
	if err := wire.WriteJSON(nativeWriter, map[string]any{"jsonrpc": "2.0", "id": ping["id"], "result": map[string]any{"alive": true}}); err != nil {
		t.Fatal(err)
	}
	response = nil
	if err := wire.ReadJSON(client, &response); err != nil || response["id"] != float64(2) || response["error"] != nil {
		t.Fatal("duplicate timeout poisoned the next response", err)
	}
}

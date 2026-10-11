package main

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"log/slog"
	"net"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/ifuryst/open-browser-use/internal/host"
	"github.com/ifuryst/open-browser-use/internal/transport"
	"github.com/ifuryst/open-browser-use/internal/wire"
)

// These fixtures exercise the public MCP stdio interface against real local
// transport connections. Both endpoints deliberately use the same tab and epoch:
// an accidentally rerouted action would succeed, rather than being hidden by a
// second endpoint's scope rejection.
type mcpObservedRequest struct {
	connection int
	message    map[string]any
}

type mcpTestPeer struct {
	net.Conn
	id      int
	writeMu sync.Mutex
}

func (peer *mcpTestPeer) write(value any) error {
	peer.writeMu.Lock()
	defer peer.writeMu.Unlock()
	return wire.WriteJSON(peer.Conn, value)
}

type mcpTestEndpoint struct {
	mu       sync.Mutex
	listener net.Listener
	path     string
	dir      string
	instance string
	epoch    int
	peers    []*mcpTestPeer
	requests []mcpObservedRequest
	workers  sync.WaitGroup
	accepted chan struct{}
	stopOnce sync.Once
	handle   func(*mcpTestPeer, map[string]any) bool
}

func mcpEndpointDirectory(t *testing.T) string {
	t.Helper()
	dir, err := os.MkdirTemp(socketTestTempRoot(), "obu-mcp-bind-")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = os.RemoveAll(dir) })
	return dir
}

func startMCPEndpoint(t *testing.T, dir, endpoint, instance string, handler func(*mcpTestPeer, map[string]any) bool) *mcpTestEndpoint {
	t.Helper()
	if endpoint == "" {
		endpoint = transport.NewEndpoint(dir, filepath.Base(dir)+"-"+instance)
	}
	listener, err := transport.Listen(endpoint)
	if err != nil {
		t.Fatal(err)
	}
	fixture := &mcpTestEndpoint{listener: listener, path: endpoint, dir: dir, instance: instance, epoch: 7, handle: handler, accepted: make(chan struct{})}
	fixture.workers.Add(1)
	go func() {
		defer fixture.workers.Done()
		defer close(fixture.accepted)
		for {
			conn, err := listener.Accept()
			if err != nil {
				return
			}
			fixture.mu.Lock()
			peer := &mcpTestPeer{Conn: conn, id: len(fixture.peers) + 1}
			fixture.peers = append(fixture.peers, peer)
			fixture.workers.Add(1)
			fixture.mu.Unlock()
			go func() {
				defer fixture.workers.Done()
				defer conn.Close()
				fixture.servePeer(peer)
			}()
		}
	}()
	t.Cleanup(fixture.stop)
	if err := host.WriteEndpointRecord(dir, endpoint); err != nil {
		t.Fatal(err)
	}
	return fixture
}

func (fixture *mcpTestEndpoint) servePeer(peer *mcpTestPeer) {
	for {
		var request map[string]any
		if wire.ReadJSON(peer, &request) != nil {
			return
		}
		fixture.mu.Lock()
		fixture.requests = append(fixture.requests, mcpObservedRequest{peer.id, request})
		fixture.mu.Unlock()
		if fixture.handle != nil && fixture.handle(peer, request) {
			continue
		}
		if peer.write(fixture.response(request)) != nil {
			return
		}
	}
}

func (fixture *mcpTestEndpoint) response(request map[string]any) map[string]any {
	fixture.mu.Lock()
	defer fixture.mu.Unlock()
	params, _ := request["params"].(map[string]any)
	var result any = map[string]any{"instance": fixture.instance, "params": params}
	switch request["method"] {
	case "getInfo":
		result = map[string]any{"metadata": map[string]any{"extensionInstanceId": fixture.instance, "turnLifecycleVersion": 1}}
	case "getControlState":
		result = map[string]any{"controlEpoch": fixture.epoch, "nextTurnId": fmt.Sprintf("next-%d", fixture.epoch), "closing": false, "lifecycleVersion": 1}
	case "createTab":
		result = map[string]any{"id": 42, "instance": fixture.instance}
	case "turnEnded", "finalizeTabs":
		fixture.epoch++
		result = map[string]any{"controlEpoch": fixture.epoch, "nextTurnId": fmt.Sprintf("next-%d", fixture.epoch), "endedTurnId": params["turn_id"], "lifecycleVersion": 1}
	}
	return map[string]any{"jsonrpc": "2.0", "id": request["id"], "result": result}
}

func (fixture *mcpTestEndpoint) snapshot() ([]mcpObservedRequest, []*mcpTestPeer) {
	fixture.mu.Lock()
	defer fixture.mu.Unlock()
	return append([]mcpObservedRequest(nil), fixture.requests...), append([]*mcpTestPeer(nil), fixture.peers...)
}

func (fixture *mcpTestEndpoint) stop() {
	fixture.stopOnce.Do(func() {
		_ = fixture.listener.Close()
		<-fixture.accepted
		// Accept has stopped before the snapshot, so an accepted connection cannot
		// escape cleanup between the snapshot and the worker wait.
		fixture.mu.Lock()
		for _, peer := range fixture.peers {
			_ = peer.Close()
		}
		fixture.mu.Unlock()
		fixture.workers.Wait()
		_ = host.RemoveEndpointRecord(fixture.dir, fixture.path)
		_ = transport.RemoveEndpoint(fixture.path)
	})
}

type mcpStdioClient struct {
	t         *testing.T
	input     *io.PipeWriter
	output    *io.PipeReader
	responses chan map[string]any
	done      chan error
	readDone  chan struct{}
	closed    bool
	nextID    int
}

func startMCPStdio(t *testing.T, options socketOptions) *mcpStdioClient {
	t.Helper()
	input, stdin := io.Pipe()
	stdout, output := io.Pipe()
	client := &mcpStdioClient{t: t, input: stdin, output: stdout, responses: make(chan map[string]any, 32), done: make(chan error, 1), readDone: make(chan struct{})}
	go func() {
		defer close(client.readDone)
		scanner := bufio.NewScanner(stdout)
		for scanner.Scan() {
			var response map[string]any
			if json.Unmarshal(scanner.Bytes(), &response) != nil {
				return
			}
			client.responses <- response
		}
	}()
	go func() {
		defer input.Close()
		defer output.Close()
		client.done <- newMCPServer(options).serve(input, output)
	}()
	t.Cleanup(client.close)
	return client
}

func (client *mcpStdioClient) close() {
	if client.closed {
		return
	}
	client.closed = true
	_ = client.input.Close()
	select {
	case err := <-client.done:
		if err != nil {
			client.t.Errorf("MCP stdio shutdown: %v", err)
		}
	case <-time.After(3 * time.Second):
		client.t.Error("MCP stdio did not finish after EOF")
	}
	_ = client.output.Close()
	select {
	case <-client.readDone:
	case <-time.After(time.Second):
		client.t.Error("MCP output reader did not drain")
	}
}

func (client *mcpStdioClient) send(method string, params any) int {
	client.t.Helper()
	client.nextID++
	if err := json.NewEncoder(client.input).Encode(map[string]any{"jsonrpc": "2.0", "id": client.nextID, "method": method, "params": params}); err != nil {
		client.t.Fatal(err)
	}
	return client.nextID
}

func (client *mcpStdioClient) receive(id int) map[string]any {
	client.t.Helper()
	select {
	case response := <-client.responses:
		if response["id"] != float64(id) {
			client.t.Fatalf("MCP response ID mismatch: want %d, got %#v", id, response)
		}
		return response
	case <-time.After(4 * time.Second):
		client.t.Fatal("MCP test response exceeded its independent test bound")
		return nil
	}
}

func (client *mcpStdioClient) tool(name string, arguments map[string]any) map[string]any {
	return client.receive(client.send("tools/call", map[string]any{"name": name, "arguments": arguments}))
}

func requireMCPToolSuccess(t *testing.T, response map[string]any) map[string]any {
	t.Helper()
	result, ok := response["result"].(map[string]any)
	if !ok || result["isError"] != false || response["error"] != nil {
		t.Fatalf("unexpected MCP tool failure: %#v", response)
	}
	structured, _ := result["structuredContent"].(map[string]any)
	if structured["error"] != nil {
		t.Fatalf("browser rejected tool: %#v", response)
	}
	return structured
}

func requireMCPDisconnected(t *testing.T, response map[string]any) {
	t.Helper()
	encoded, _ := json.Marshal(response)
	result, _ := response["result"].(map[string]any)
	if result["isError"] != true || !bytes.Contains(encoded, []byte("OBU_MCP_BROWSER_DISCONNECTED")) {
		t.Fatalf("expected sticky disconnect, got %s", encoded)
	}
}

func mcpRawCall(method string, params map[string]any) map[string]any {
	return map[string]any{"method": method, "params": params}
}

func setMCPActive(t *testing.T, dir, endpoint string) {
	t.Helper()
	if err := host.WriteActiveSocketRecord(dir, endpoint); err != nil {
		t.Fatal(err)
	}
}

func TestMCPConnectionStaysOnSelectedInstanceAcrossRegistryAndTools(t *testing.T) {
	for _, selector := range []string{"active", "profile", "socket"} {
		t.Run(selector, func(t *testing.T) {
			dir := mcpEndpointDirectory(t)
			a := startMCPEndpoint(t, dir, "", "instance-a", nil)
			b := startMCPEndpoint(t, dir, "", "instance-b", nil)
			setMCPActive(t, dir, a.path)
			options := socketOptions{socketDir: dir, timeout: time.Second, sessionID: "same-session"}
			if selector == "profile" {
				options.profile = "instance-a"
				setMCPActive(t, dir, b.path)
			}
			if selector == "socket" {
				options.socketPath = a.path
				setMCPActive(t, dir, b.path)
			}
			client := startMCPStdio(t, options)
			client.receive(client.send("initialize", map[string]any{}))
			if requests, _ := a.snapshot(); len(requests) != 0 {
				t.Fatal("initialize unexpectedly discovered a browser")
			}
			requireMCPToolSuccess(t, client.tool("open_tab", map[string]any{"url": "https://fixture.invalid/a"}))
			setMCPActive(t, dir, b.path)
			// The implicit currentTabId and multi-RPC cdp helper must stay on A.
			requireMCPToolSuccess(t, client.tool("cdp", map[string]any{"method": "Runtime.evaluate", "params": map[string]any{"expression": "42"}}))
			requireMCPToolSuccess(t, client.tool("begin_turn", nil))
			requireMCPToolSuccess(t, client.tool("call", mcpRawCall("getTabs", nil)))
			requests, peers := a.snapshot()
			if len(peers) != 1 {
				t.Fatalf("MCP reconnected to selected endpoint %d times", len(peers))
			}
			methods := []string{}
			for _, request := range requests {
				if request.connection != peers[0].id {
					t.Fatal("request left original connection")
				}
				methods = append(methods, request.message["method"].(string))
			}
			if !strings.Contains(strings.Join(methods, ","), "createTab,attach,executeCdp,attach,executeCdp") {
				t.Fatalf("expected actual compound tool calls: %v", methods)
			}
			other, _ := b.snapshot()
			for _, request := range other {
				if request.message["method"] != "getInfo" {
					t.Fatalf("old session executed on B: %#v", request)
				}
			}
		})
	}
}

func TestMCPConnectionDisconnectNeverSelectsReplacementAtSamePath(t *testing.T) {
	dir := mcpEndpointDirectory(t)
	a := startMCPEndpoint(t, dir, "", "instance-a", nil)
	setMCPActive(t, dir, a.path)
	client := startMCPStdio(t, socketOptions{socketDir: dir, timeout: time.Second})
	requireMCPToolSuccess(t, client.tool("open_tab", nil))
	a.stop()
	// A copied profile can report the same UUID. The live connection, not that
	// metadata string or this reusable endpoint address, is the binding.
	b := startMCPEndpoint(t, dir, a.path, "instance-a", nil)
	setMCPActive(t, dir, b.path)
	for _, tool := range []struct {
		name string
		args map[string]any
	}{{"cdp", map[string]any{"method": "Runtime.evaluate"}}, {"begin_turn", nil}, {"call", mcpRawCall("executeCdp", map[string]any{"target": map[string]any{"tabId": 42}, "method": "Runtime.evaluate", "session_id": "same-session", "turn_id": "same-turn", "control_epoch": 7})}} {
		requireMCPDisconnected(t, client.tool(tool.name, tool.args))
	}
	if requests, peers := b.snapshot(); len(requests) != 0 || len(peers) != 0 {
		t.Fatalf("disconnected MCP dialed replacement B: %d connections, %#v", len(peers), requests)
	}
	fresh := startMCPStdio(t, socketOptions{socketPath: b.path, timeout: time.Second})
	requireMCPToolSuccess(t, fresh.tool("open_tab", nil))
	requests, _ := b.snapshot()
	if requests[len(requests)-1].message["method"] != "createTab" {
		t.Fatal("fresh explicit MCP did not reach B")
	}
}

func TestMCPConnectionPartialLateResponseDoesNotCorruptNextRequest(t *testing.T) {
	for _, splitAt := range []int{2, 9} {
		t.Run(fmt.Sprintf("split-%d", splitAt), func(t *testing.T) {
			dir := mcpEndpointDirectory(t)
			release := make(chan struct{})
			fragmentSent := make(chan struct{})
			var releaseOnce sync.Once
			a := startMCPEndpoint(t, dir, "", "instance-a", func(peer *mcpTestPeer, request map[string]any) bool {
				if request["method"] != "delayedFixtureResponse" {
					return false
				}
				var frame bytes.Buffer
				_ = wire.WriteJSON(&frame, map[string]any{"jsonrpc": "2.0", "id": request["id"], "result": map[string]any{"late": true}})
				peer.writeMu.Lock()
				defer peer.writeMu.Unlock()
				_, _ = peer.Write(frame.Bytes()[:splitAt])
				close(fragmentSent)
				<-release
				_, _ = peer.Write(frame.Bytes()[splitAt:])
				return true
			})
			// Release a held fixture writer before endpoint cleanup waits for it.
			t.Cleanup(func() { releaseOnce.Do(func() { close(release) }) })
			client := startMCPStdio(t, socketOptions{socketPath: a.path, timeout: 100 * time.Millisecond})
			requireMCPToolSuccess(t, client.tool("call", mcpRawCall("getTabs", nil)))
			id := client.send("tools/call", map[string]any{"name": "call", "arguments": mcpRawCall("delayedFixtureResponse", nil)})
			select {
			case <-fragmentSent:
			case <-time.After(time.Second):
				t.Fatal("host never began the fragmented response")
			}
			response := client.receive(id)
			if result, _ := response["result"].(map[string]any); result["isError"] != true {
				t.Fatalf("incomplete response should time out: %#v", response)
			}
			next := client.send("tools/call", map[string]any{"name": "call", "arguments": mcpRawCall("getTabs", map[string]any{"afterTimeout": true})})
			releaseOnce.Do(func() { close(release) })
			result := requireMCPToolSuccess(t, client.receive(next))["result"].(map[string]any)
			if result["params"].(map[string]any)["afterTimeout"] != true || result["late"] != nil {
				t.Fatalf("late response polluted subsequent request: %#v", result)
			}
			requireMCPToolSuccess(t, client.tool("begin_turn", nil))
			requireMCPToolSuccess(t, client.tool("call", mcpRawCall("getTabs", nil)))
			requests, peers := a.snapshot()
			if len(peers) != 1 {
				t.Fatalf("response timeout caused reconnect: %d", len(peers))
			}
			ids := map[any]bool{}
			for _, request := range requests {
				id := request.message["id"]
				if ids[id] {
					t.Fatalf("wire request ID reused after timeout: %v", id)
				}
				ids[id] = true
			}
		})
	}
}

func TestMCPConnectionBadFrameIsPermanentAndDoesNotReplay(t *testing.T) {
	dir := mcpEndpointDirectory(t)
	a := startMCPEndpoint(t, dir, "", "instance-a", func(peer *mcpTestPeer, request map[string]any) bool {
		if request["method"] != "brokenFixtureFrame" {
			return false
		}
		peer.writeMu.Lock()
		defer peer.writeMu.Unlock()
		_ = wire.WriteFrame(peer, []byte(`{"jsonrpc":`))
		return true
	})
	client := startMCPStdio(t, socketOptions{socketPath: a.path, timeout: time.Second})
	requireMCPDisconnected(t, client.tool("call", mcpRawCall("brokenFixtureFrame", nil)))
	requireMCPDisconnected(t, client.tool("call", mcpRawCall("getTabs", nil)))
	requests, peers := a.snapshot()
	if len(peers) != 1 || requests[len(requests)-1].message["method"] != "brokenFixtureFrame" {
		t.Fatalf("malformed frame led to a new connection or later action: %#v", requests)
	}
}

func TestMCPConnectionFailedDiscoveryCanLaterBind(t *testing.T) {
	dir := mcpEndpointDirectory(t)
	client := startMCPStdio(t, socketOptions{socketDir: dir, timeout: time.Second})
	response := client.tool("tabs", nil)
	if result, _ := response["result"].(map[string]any); result["isError"] != true {
		t.Fatalf("empty discovery unexpectedly succeeded: %#v", response)
	}
	a := startMCPEndpoint(t, dir, "", "instance-a", nil)
	setMCPActive(t, dir, a.path)
	requireMCPToolSuccess(t, client.tool("tabs", nil))
}

func TestMCPConnectionDrainsIdleTransportWithoutAnotherRequest(t *testing.T) {
	dir := mcpEndpointDirectory(t)
	a := startMCPEndpoint(t, dir, "", "instance-a", nil)
	client := startMCPStdio(t, socketOptions{socketPath: a.path, timeout: time.Second})
	requireMCPToolSuccess(t, client.tool("tabs", nil))
	_, peers := a.snapshot()
	if len(peers) != 1 {
		t.Fatal("expected one selected connection")
	}
	written := make(chan error, 1)
	go func() {
		for index := 0; index < 384; index++ {
			if err := peers[0].write(map[string]any{"jsonrpc": "2.0", "method": "heartbeat", "params": map[string]any{"sequence": index, "fixtureData": strings.Repeat("x", 4096)}}); err != nil {
				written <- err
				return
			}
		}
		written <- nil
	}()
	// Waiting for the actual socket writer, rather than the relay enqueue, proves
	// that the idle reader is alive without a new tool waking it up.
	select {
	case err := <-written:
		if err != nil {
			t.Fatal(err)
		}
	case <-time.After(3 * time.Second):
		t.Fatal("native socket could not drain while MCP was idle")
	}
	requireMCPToolSuccess(t, client.tool("tabs", nil))
	_, peers = a.snapshot()
	if len(peers) != 1 {
		t.Fatal("idle reader was replaced by a second connection")
	}
}

func TestMCPConnectionWriteTimeoutPermanentlyClosesPartialFrame(t *testing.T) {
	dir := mcpEndpointDirectory(t)
	release := make(chan struct{})
	var releaseOnce sync.Once
	a := startMCPEndpoint(t, dir, "", "instance-a", func(peer *mcpTestPeer, request map[string]any) bool {
		if request["method"] != "holdFixtureReader" {
			return false
		}
		_ = peer.write(map[string]any{"jsonrpc": "2.0", "id": request["id"], "result": map[string]any{}})
		<-release
		return true
	})
	t.Cleanup(func() { releaseOnce.Do(func() { close(release) }) })
	client := startMCPStdio(t, socketOptions{socketPath: a.path, timeout: 500 * time.Millisecond})
	requireMCPToolSuccess(t, client.tool("call", mcpRawCall("holdFixtureReader", nil)))
	// The receiver is known to be held. This exceeds the native socket buffer
	// without exceeding the MCP input or native frame limits.
	requireMCPDisconnected(t, client.tool("call", mcpRawCall("executeCdp", map[string]any{"target": map[string]any{"tabId": 42}, "method": "Runtime.evaluate", "commandParams": map[string]any{"expression": strings.Repeat("x", 4*1024*1024)}})))
	requireMCPDisconnected(t, client.tool("begin_turn", nil))
	requireMCPDisconnected(t, client.tool("tabs", nil))
	releaseOnce.Do(func() { close(release) })
	requests, peers := a.snapshot()
	if len(peers) != 1 || requests[len(requests)-1].message["method"] != "holdFixtureReader" {
		t.Fatalf("partial frame was replayed or a new connection opened: %#v", requests)
	}
}

func TestMCPConnectionLostEndResponseRecoversEpochOnSameConnection(t *testing.T) {
	dir := mcpEndpointDirectory(t)
	var fixture *mcpTestEndpoint
	fixtureReady := make(chan struct{})
	fixture = startMCPEndpoint(t, dir, "", "instance-a", func(peer *mcpTestPeer, request map[string]any) bool {
		if request["method"] == "turnEnded" {
			<-fixtureReady
			fixture.response(request) // Apply the end, deliberately lose only its ACK.
			return true
		}
		return false
	})
	close(fixtureReady)
	client := startMCPStdio(t, socketOptions{socketPath: fixture.path, timeout: 100 * time.Millisecond})
	requireMCPToolSuccess(t, client.tool("tabs", nil))
	response := client.tool("turn_ended", nil)
	if result, _ := response["result"].(map[string]any); result["isError"] != true {
		t.Fatalf("lost end acknowledgement did not time out: %#v", response)
	}
	requireMCPToolSuccess(t, client.tool("begin_turn", nil))
	requireMCPToolSuccess(t, client.tool("tabs", nil))
	requests, peers := fixture.snapshot()
	ends := 0
	for _, request := range requests {
		if request.message["method"] == "turnEnded" {
			ends++
		}
	}
	last := requests[len(requests)-1].message["params"].(map[string]any)
	first := requests[2].message["params"].(map[string]any)
	if len(peers) != 1 || ends != 1 || last["control_epoch"] != float64(8) || last["turn_id"] == first["turn_id"] {
		t.Fatalf("recovery reconnected, replayed end, or kept old scope: connections=%d ends=%d first=%v last=%v", len(peers), ends, first, last)
	}
}

func TestMCPConnectionIdleReaderDrainsRealHostNotifications(t *testing.T) {
	dir := mcpEndpointDirectory(t)
	endpoint := transport.NewEndpoint(dir, filepath.Base(dir)+"-relay")
	parent, extension := net.Pipe()
	ctx, cancel := context.WithCancel(context.Background())
	relay := host.NewRelay(host.Config{SocketDir: dir, SocketPath: endpoint, Logger: slog.New(slog.NewTextHandler(io.Discard, nil))}, parent, parent)
	relayDone := make(chan error, 1)
	go func() { relayDone <- relay.Serve(ctx) }()
	fixture := &mcpTestEndpoint{instance: "real-relay", epoch: 7}
	peer := &mcpTestPeer{Conn: extension, id: 1}
	extensionDone := make(chan struct{})
	go func() { defer close(extensionDone); fixture.servePeer(peer) }()
	t.Cleanup(func() {
		cancel()
		_ = parent.Close()
		_ = extension.Close()
		select {
		case <-relayDone:
		case <-time.After(time.Second):
			t.Error("real relay did not stop")
		}
		select {
		case <-extensionDone:
		case <-time.After(time.Second):
			t.Error("extension fixture did not stop")
		}
	})
	deadline := time.Now().Add(time.Second)
	for {
		if active, err := host.ReadActiveSocketRecord(dir); err == nil && active.SocketPath == endpoint {
			break
		}
		if time.Now().After(deadline) {
			t.Fatal("real relay did not publish its endpoint")
		}
		time.Sleep(time.Millisecond)
	}
	client := startMCPStdio(t, socketOptions{socketDir: dir, timeout: time.Second, sessionID: "idle-reader"})
	requireMCPToolSuccess(t, client.tool("tabs", nil))
	written := make(chan error, 1)
	go func() {
		// More than a local pipe's buffer, while no MCP request is in flight.
		for index := 0; index < 384; index++ {
			if err := peer.write(map[string]any{"jsonrpc": "2.0", "method": "cdpEvent", "params": map[string]any{"session_id": "idle-reader", "sequence": index, "fixtureData": strings.Repeat("x", 4096)}}); err != nil {
				written <- err
				return
			}
		}
		written <- nil
	}()
	select {
	case err := <-written:
		if err != nil {
			t.Fatal(err)
		}
	case <-time.After(3 * time.Second):
		t.Fatal("idle notifications blocked native host")
	}
	requireMCPToolSuccess(t, client.tool("tabs", nil))
	requests, _ := fixture.snapshot()
	getTabs := 0
	for _, request := range requests {
		if request.message["method"] == "getTabs" {
			getTabs++
		}
	}
	if getTabs != 2 {
		t.Fatalf("original and post-idle calls did not both reach real relay: %d", getTabs)
	}
}

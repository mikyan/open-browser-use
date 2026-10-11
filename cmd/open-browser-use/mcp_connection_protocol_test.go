package main

import (
	"encoding/json"
	"errors"
	"net"
	"strings"
	"testing"
	"time"

	"github.com/ifuryst/open-browser-use/internal/wire"
)

// Force the ordering that is otherwise dependent on goroutine scheduling:
// complete write -> matching response -> EOF -> clear-write-deadline failure.
// Only the last deadline operation is controlled; all frames use net.Pipe.
type mcpProtocolClearAfterEOFConn struct {
	net.Conn
	readerDone <-chan struct{}
	cleared    bool
}

func (conn *mcpProtocolClearAfterEOFConn) SetWriteDeadline(deadline time.Time) error {
	if !deadline.IsZero() {
		return conn.Conn.SetWriteDeadline(deadline)
	}
	select {
	case <-conn.readerDone:
		conn.cleared = true
		return net.ErrClosed
	case <-time.After(3 * time.Second):
		return errors.New("test reader did not reach EOF before clearing write deadline")
	}
}

func newMCPProtocolPipe(t *testing.T, wrap func(net.Conn) net.Conn) (*mcpBoundConn, net.Conn) {
	t.Helper()
	client, server := net.Pipe()
	var connection net.Conn = client
	if wrap != nil {
		connection = wrap(client)
	}
	peer := newMCPBoundConn(connection)
	if err := server.SetDeadline(time.Now().Add(5 * time.Second)); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		_ = server.Close()
		peer.fail(net.ErrClosed)
		select {
		case <-peer.readerDone:
		case <-time.After(time.Second):
			t.Error("protocol test reader did not exit after closing its real connection")
		}
	})
	return peer, server
}

func runMCPProtocolHost(t *testing.T, server net.Conn, serve func() error) func() {
	t.Helper()
	done := make(chan struct{})
	var hostError error
	go func() {
		defer close(done)
		hostError = serve()
	}()
	wait := func() {
		t.Helper()
		select {
		case <-done:
			if hostError != nil {
				t.Errorf("protocol fixture: %v", hostError)
			}
		case <-time.After(3 * time.Second):
			t.Error("protocol fixture did not finish")
		}
	}
	t.Cleanup(func() { _ = server.Close(); wait() })
	return wait
}

func TestMCPProtocolCompleteResponseSurvivesEOFBeforeDeadlineReset(t *testing.T) {
	var wrapped *mcpProtocolClearAfterEOFConn
	peer, server := newMCPProtocolPipe(t, func(conn net.Conn) net.Conn {
		wrapped = &mcpProtocolClearAfterEOFConn{Conn: conn}
		return wrapped
	})
	wrapped.readerDone = peer.readerDone
	wait := runMCPProtocolHost(t, server, func() error {
		var request map[string]any
		if err := wire.ReadJSON(server, &request); err != nil {
			return err
		}
		if err := wire.WriteJSON(server, map[string]any{"jsonrpc": "2.0", "id": request["id"], "result": map[string]any{"acknowledged": true}}); err != nil {
			return err
		}
		return server.Close()
	})
	if err := peer.SetDeadline(time.Now().Add(2 * time.Second)); err != nil {
		t.Fatal(err)
	}
	response, err := peer.request("caller-original-id", "fixtureMutation", nil)
	if err != nil {
		t.Fatalf("complete response preceding EOF was lost: %v", err)
	}
	result, _ := response["result"].(map[string]any)
	if !wrapped.cleared || response["id"] != "caller-original-id" || result["acknowledged"] != true {
		t.Fatalf("wrong response or test ordering: cleared=%v response=%#v", wrapped.cleared, response)
	}
	if err := peer.SetDeadline(time.Now().Add(time.Second)); err == nil || !strings.Contains(err.Error(), "OBU_MCP_BROWSER_DISCONNECTED") {
		t.Fatalf("EOF did not leave a sticky binding failure: %v", err)
	}
	if _, err := peer.request("later-id", "fixtureMutation", nil); err == nil || !strings.Contains(err.Error(), "OBU_MCP_BROWSER_DISCONNECTED") {
		t.Fatalf("later request reused a closed binding: %v", err)
	}
	wait()
}

func TestMCPProtocolMalformedEnvelopeTerminatesBinding(t *testing.T) {
	for _, test := range []struct {
		name     string
		template string
	}{
		{"missing-result-and-error", `{"jsonrpc":"2.0","id":$ID}`},
		{"both-result-and-error", `{"jsonrpc":"2.0","id":$ID,"result":{},"error":{"code":-32000,"message":"failure"}}`},
		{"missing-version", `{"id":$ID,"result":{}}`},
		{"wrong-version", `{"jsonrpc":"1.0","id":$ID,"result":{}}`},
		{"missing-id", `{"jsonrpc":"2.0","result":{}}`},
		{"null-id", `{"jsonrpc":"2.0","id":null,"result":{}}`},
		{"numeric-id", `{"jsonrpc":"2.0","id":1,"result":{}}`},
		{"matched-id-with-method", `{"jsonrpc":"2.0","id":$ID,"method":"heartbeat"}`},
		{"empty-notification-method", `{"jsonrpc":"2.0","method":""}`},
		{"null-error", `{"jsonrpc":"2.0","id":$ID,"error":null}`},
		{"non-object-error", `{"jsonrpc":"2.0","id":$ID,"error":"failure"}`},
		{"error-missing-code", `{"jsonrpc":"2.0","id":$ID,"error":{"message":"failure"}}`},
		{"error-fractional-code", `{"jsonrpc":"2.0","id":$ID,"error":{"code":-32000.5,"message":"failure"}}`},
		{"error-missing-message", `{"jsonrpc":"2.0","id":$ID,"error":{"code":-32000}}`},
		{"error-invalid-message", `{"jsonrpc":"2.0","id":$ID,"error":{"code":-32000,"message":false}}`},
		{"non-object-frame", `[]`},
	} {
		t.Run(test.name, func(t *testing.T) {
			peer, server := newMCPProtocolPipe(t, nil)
			wait := runMCPProtocolHost(t, server, func() error {
				var request map[string]any
				if err := wire.ReadJSON(server, &request); err != nil {
					return err
				}
				id, err := json.Marshal(request["id"])
				if err != nil {
					return err
				}
				return wire.WriteFrame(server, []byte(strings.ReplaceAll(test.template, "$ID", string(id))))
			})
			if err := peer.SetDeadline(time.Now().Add(2 * time.Second)); err != nil {
				t.Fatal(err)
			}
			response, err := peer.request("caller-id", "fixtureMutation", nil)
			if err == nil || !strings.Contains(err.Error(), "invalid JSON-RPC frame") || !strings.Contains(err.Error(), "OBU_MCP_BROWSER_DISCONNECTED") || response != nil {
				t.Fatalf("malformed envelope was not a terminal protocol error: response=%#v error=%v", response, err)
			}
			if err := peer.SetDeadline(time.Now().Add(time.Second)); err == nil || !strings.Contains(err.Error(), "OBU_MCP_BROWSER_DISCONNECTED") {
				t.Fatalf("malformed envelope did not remain sticky: %v", err)
			}
			if _, err := peer.request("next-id", "fixtureMutation", nil); err == nil || !strings.Contains(err.Error(), "OBU_MCP_BROWSER_DISCONNECTED") {
				t.Fatalf("request was allowed after malformed envelope: %v", err)
			}
			wait()
		})
	}
}

func TestMCPProtocolHeartbeatLateResponseAndApplicationErrorKeepConnection(t *testing.T) {
	peer, server := newMCPProtocolPipe(t, nil)
	wait := runMCPProtocolHost(t, server, func() error {
		var late, current map[string]any
		if err := wire.ReadJSON(server, &late); err != nil {
			return err
		}
		// A second request cannot be issued until the first response wait ends.
		// Reading it is the barrier; no sleep guesses when to send the late ACK.
		if err := wire.ReadJSON(server, &current); err != nil {
			return err
		}
		if late["id"] == current["id"] {
			return errors.New("wire ID reused after timeout")
		}
		for _, message := range []map[string]any{
			{"jsonrpc": "2.0", "method": "heartbeat", "params": map[string]any{"sequence": 1}},
			{"jsonrpc": "2.0", "id": late["id"], "result": map[string]any{"late": true}},
			{"jsonrpc": "2.0", "id": current["id"], "result": map[string]any{"current": true}},
		} {
			if err := wire.WriteJSON(server, message); err != nil {
				return err
			}
		}
		for index := 0; index < 2; index++ {
			var request map[string]any
			if err := wire.ReadJSON(server, &request); err != nil {
				return err
			}
			response := map[string]any{"jsonrpc": "2.0", "id": request["id"]}
			if index == 0 {
				response["error"] = map[string]any{"code": -32000, "message": "fixture application rejection", "data": map[string]any{"retryable": false}}
			} else {
				response["result"] = nil // A JSON-RPC null result is legitimate.
			}
			if err := wire.WriteJSON(server, response); err != nil {
				return err
			}
		}
		return nil
	})
	if err := peer.SetDeadline(time.Now().Add(200 * time.Millisecond)); err != nil {
		t.Fatal(err)
	}
	if _, err := peer.request("same-caller-id", "delayedFixtureMutation", nil); err == nil || !strings.Contains(err.Error(), "response timed out") {
		t.Fatalf("first response should time out without closing the connection: %v", err)
	}
	if err := peer.SetDeadline(time.Now().Add(2 * time.Second)); err != nil {
		t.Fatalf("response timeout closed the connection: %v", err)
	}
	response, err := peer.request("same-caller-id", "currentFixtureMutation", nil)
	if err != nil {
		t.Fatal(err)
	}
	result, _ := response["result"].(map[string]any)
	if response["id"] != "same-caller-id" || result["current"] != true || result["late"] != nil {
		t.Fatalf("notification or late response replaced current result: %#v", response)
	}
	response, err = peer.request("application-error-id", "rejectedFixtureMutation", nil)
	if err != nil {
		t.Fatalf("valid application error poisoned protocol: %v", err)
	}
	failure, _ := response["error"].(map[string]any)
	if response["id"] != "application-error-id" || failure["code"] != float64(-32000) || failure["message"] != "fixture application rejection" {
		t.Fatalf("application error was not preserved: %#v", response)
	}
	response, err = peer.request("after-error-id", "readFixtureState", nil)
	if err != nil {
		t.Fatal(err)
	}
	value, present := response["result"]
	if !present || value != nil || response["id"] != "after-error-id" {
		t.Fatalf("valid null result was not preserved: %#v", response)
	}
	wait()
}

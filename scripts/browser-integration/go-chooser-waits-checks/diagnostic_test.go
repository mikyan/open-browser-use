package main

import (
	"encoding/json"
	"fmt"
	"io"
	"reflect"
	"strings"
	"testing"
	"time"
)

type lineWriter chan []byte

func (writer lineWriter) Write(value []byte) (int, error) {
	writer <- append([]byte(nil), value...)
	return len(value), nil
}

func protocolFixture(t *testing.T) (*diagnosticProtocol, *io.PipeWriter, lineWriter) {
	t.Helper()
	reader, writer := io.Pipe()
	output := make(lineWriter, 8)
	protocol := newDiagnosticProtocol(reader, output)
	t.Cleanup(func() { protocol.close(); _ = reader.Close(); _ = writer.Close() })
	return protocol, writer, output
}

func TestDiagnosticACKStrictSchemaAndIdentity(t *testing.T) {
	if err := validateACK([]byte("{\"type\":\"ack\",\"version\":1,\"id\":1,\"ok\":true}\n"), 1); err != nil {
		t.Fatal(err)
	}
	for _, value := range []string{
		`{"type":"ack","version":1,"id":2,"ok":true}`, `{"type":"ack","version":1,"id":1,"ok":null}`,
		`{"type":"ack","version":1,"id":1,"ok":"true"}`, `{"type":"ack","version":1,"id":1,"ok":true,"error":"extra"}`,
		`{"type":"ack","version":1,"id":1,"ok":true,"extra":1}`, `{"type":"ack","version":1,"id":1,"id":1,"ok":true}`,
		`{"type":"ack","version":1,"id":1.0,"ok":true}`, `{"type":"ack","version":2,"id":1,"ok":true}`,
		`{"type":"result","version":1,"id":1,"ok":true}`, `{"type":"ack","version":1,"id":1,"ok":false}`,
		`{"type":"ack","version":1,"id":1,"ok":false,"error":null}`, `{"type":"ack","version":1,"id":1,"ok":false,"error":1}`,
		`[]`, `null`, `{"type":"ack","version":1,"id":1,"ok":true} {}`,
	} {
		if err := validateACK([]byte(value+"\n"), 1); err == nil {
			t.Fatalf("accepted %s", value)
		}
	}
	err := validateACK([]byte("{\"type\":\"ack\",\"version\":1,\"id\":1,\"ok\":false,\"error\":\"original node failure\"}\n"), 1)
	if err == nil || !strings.Contains(err.Error(), "original node failure") {
		t.Fatal(err)
	}
}

func TestDiagnosticHooksAwaitACKAndExposeOnlyIdentity(t *testing.T) {
	protocol, writer, output := protocolFixture(t)
	if !reflect.DeepEqual(protocol.timeouts, map[string]time.Duration{"start": 6 * time.Second, "failure": 5 * time.Second, "finish": 4 * time.Second}) {
		t.Fatal(protocol.timeouts)
	}
	item := map[string]any{"key": "fixture", "variant": "root", "tabId": 42, "originalError": "must not leak into wire identity", "waits": []any{1}}
	for index, kind := range []string{"start", "failure", "finish"} {
		done := make(chan error, 1)
		go func() { done <- protocol.hook(kind, item) }()
		var message map[string]any
		if err := json.Unmarshal(<-output, &message); err != nil {
			t.Fatal(err)
		}
		expected := map[string]any{"type": "hook", "version": float64(1), "id": float64(index + 1), "kind": kind, "item": map[string]any{"key": "fixture", "variant": "root", "tabId": float64(42)}}
		if !reflect.DeepEqual(message, expected) {
			t.Fatalf("wire changed: %#v", message)
		}
		select {
		case err := <-done:
			t.Fatalf("continued before ACK: %v", err)
		default:
		}
		if _, err := fmt.Fprintf(writer, "{\"type\":\"ack\",\"version\":1,\"id\":%d,\"ok\":true}\n", index+1); err != nil {
			t.Fatal(err)
		}
		if err := <-done; err != nil {
			t.Fatal(err)
		}
	}
}

func TestDiagnosticRejectedStartStillAllowsFinish(t *testing.T) {
	protocol, writer, output := protocolFixture(t)
	item := map[string]any{"key": "fixture", "variant": "root", "tabId": 42}
	done := make(chan error, 1)
	go func() { done <- protocol.hook("start", item) }()
	<-output
	_, _ = io.WriteString(writer, "{\"type\":\"ack\",\"version\":1,\"id\":1,\"ok\":false,\"error\":\"install failed\"}\n")
	if err := <-done; err == nil || !strings.Contains(err.Error(), "install failed") {
		t.Fatal(err)
	}
	go func() { done <- protocol.hook("finish", item) }()
	var message map[string]any
	_ = json.Unmarshal(<-output, &message)
	if message["id"] != float64(2) || message["kind"] != "finish" {
		t.Fatal(message)
	}
	_, _ = io.WriteString(writer, "{\"type\":\"ack\",\"version\":1,\"id\":2,\"ok\":true}\n")
	if err := <-done; err != nil {
		t.Fatal(err)
	}
}

func TestDiagnosticTimeoutDoesNotResendAndLateACKCannotAuthorizeFinish(t *testing.T) {
	protocol, writer, output := protocolFixture(t)
	protocol.timeouts["start"] = 20 * time.Millisecond
	item := map[string]any{"key": "fixture", "variant": "root", "tabId": 42}
	done := make(chan error, 1)
	go func() { done <- protocol.hook("start", item) }()
	<-output
	if err := <-done; err == nil || !strings.Contains(err.Error(), "timed out") {
		t.Fatal(err)
	}
	select {
	case line := <-output:
		t.Fatalf("resent hook: %s", line)
	default:
	}
	go func() { done <- protocol.hook("finish", item) }()
	<-output
	_, _ = io.WriteString(writer, "{\"type\":\"ack\",\"version\":1,\"id\":1,\"ok\":true}\n")
	if err := <-done; err == nil || !strings.Contains(err.Error(), "mismatch") {
		t.Fatal(err)
	}
}

func TestDiagnosticACKBoundedLinesAndTruncatedEOF(t *testing.T) {
	for _, line := range []string{strings.Repeat("x", maximumACKLine+2), "{\"type\":\"ack\",\"version\":1,\"id\":1,\"ok\":true}"} {
		protocol, writer, output := protocolFixture(t)
		done := make(chan error, 1)
		go func() { done <- protocol.hook("start", map[string]any{"tabId": 42}) }()
		<-output
		go func() { _, _ = io.WriteString(writer, line); _ = writer.Close() }()
		select {
		case err := <-done:
			if err == nil {
				t.Fatal("accepted oversized/truncated ACK")
			}
		case <-time.After(time.Second):
			t.Fatal("ACK reader did not reject bounded failure")
		}
	}
	valid := "{\"type\":\"ack\",\"version\":1,\"id\":1,\"ok\":true}"
	if err := validateACK([]byte(strings.Repeat(" ", maximumACKLine-len(valid))+valid+"\n"), 1); err != nil {
		t.Fatal(err)
	}
}

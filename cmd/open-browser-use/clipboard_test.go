package main

import (
	"bytes"
	"encoding/json"
	"net"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/ifuryst/open-browser-use/internal/transport"
	"github.com/ifuryst/open-browser-use/internal/wire"
)

type clipboardFixture struct {
	mu          sync.Mutex
	calls       []map[string]any
	unsupported bool
	delayInfo   time.Duration
	result      map[string]any
}

func (f *clipboardFixture) start(t *testing.T) socketOptions {
	t.Helper()
	directory, err := os.MkdirTemp(socketTestTempRoot(), "obu-clip-")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = os.RemoveAll(directory) })
	endpoint := transport.NewEndpoint(directory, filepath.Base(directory))
	listener, err := transport.Listen(endpoint)
	if err != nil {
		t.Fatal(err)
	}
	var workers sync.WaitGroup
	workers.Add(1)
	go func() {
		defer workers.Done()
		for {
			conn, err := listener.Accept()
			if err != nil {
				return
			}
			workers.Add(1)
			go func(conn net.Conn) {
				defer workers.Done()
				defer conn.Close()
				_ = conn.SetDeadline(time.Now().Add(5 * time.Second))
				for {
					var call map[string]any
					if wire.ReadJSON(conn, &call) != nil {
						return
					}
					f.mu.Lock()
					f.calls = append(f.calls, call)
					f.mu.Unlock()
					result := map[string]any{}
					switch call["method"] {
					case "getInfo":
						time.Sleep(f.delayInfo)
						metadata := map[string]any{"turnLifecycleVersion": 1}
						if !f.unsupported {
							metadata["clipboardVersion"] = 1
						}
						result = map[string]any{"metadata": metadata}
					case "getControlState":
						result = map[string]any{"controlEpoch": 7, "nextTurnId": "next", "closing": false, "lifecycleVersion": 1}
					case "readClipboardText":
						result = f.result
						if result == nil {
							result = map[string]any{"text": "剪贴板 fixture"}
						}
					case "readClipboard":
						result = f.result
						if result == nil {
							result = map[string]any{"items": []any{map[string]any{"entries": []any{map[string]any{"mime_type": "text/plain", "text": "剪贴板 fixture"}}}}}
						}
					}
					if wire.WriteJSON(conn, map[string]any{"jsonrpc": "2.0", "id": call["id"], "result": result}) != nil {
						return
					}
				}
			}(conn)
		}
	}()
	t.Cleanup(func() { _ = listener.Close(); workers.Wait() })
	return socketOptions{socketPath: endpoint, timeout: 3 * time.Second, sessionID: "clipboard-test", control: newCLIControl("clipboard-test", "first")}
}

func (f *clipboardFixture) operations() []map[string]any {
	f.mu.Lock()
	defer f.mu.Unlock()
	var result []map[string]any
	for _, call := range f.calls {
		if method, ok := call["method"].(string); ok && cliClipboardMethod(method) {
			result = append(result, call)
		}
	}
	return result
}

func TestClipboardCLIReadRichPublishesSingleEnvelopeWithoutOverwrite(t *testing.T) {
	f := &clipboardFixture{}
	options := f.start(t)
	target := filepath.Join(t.TempDir(), "clipboard.json")
	command := newClipboardCommand()
	var output bytes.Buffer
	command.SetOut(&output)
	command.SetArgs([]string{"read", "--socket", options.socketPath, "--tab-id", "123", "--output", target})
	if err := command.Execute(); err != nil {
		t.Fatal(err)
	}
	data, err := os.ReadFile(target)
	if err != nil || !bytes.Contains(data, []byte("剪贴板 fixture")) {
		t.Fatalf("file result %q: %v", data, err)
	}
	var metadata map[string]any
	if err := json.Unmarshal(output.Bytes(), &metadata); err != nil {
		t.Fatal(err)
	}
	if len(metadata) != 4 || metadata["byteLength"] != float64(len(data)) || bytes.Contains(output.Bytes(), []byte("fixture")) {
		t.Fatalf("bad metadata %s", output.Bytes())
	}
	if _, err := clipboardToFile(options, nil, map[string]any{"tabId": float64(123)}, target); err == nil {
		t.Fatal("overwrote existing clipboard file")
	}
	if len(f.operations()) != 1 {
		t.Fatal("existing path reached clipboard")
	}
}

func TestClipboardCLICapabilityIncludesManualEpoch(t *testing.T) {
	for _, manual := range []bool{false, true} {
		f := &clipboardFixture{unsupported: true}
		options := f.start(t)
		params := map[string]any{"tabId": float64(123)}
		if manual {
			params["control_epoch"] = float64(7)
		}
		_, err := options.control.invoke(options, "readClipboardText", params, nil)
		if err == nil || !strings.Contains(err.Error(), "clipboardVersion") || len(f.operations()) != 0 {
			t.Fatalf("manual=%v calls=%v error=%v", manual, f.operations(), err)
		}
	}
}

func TestClipboardCLIBootstrapConsumesOriginalDeadline(t *testing.T) {
	f := &clipboardFixture{delayInfo: 150 * time.Millisecond}
	options := f.start(t)
	_, err := options.control.invoke(options, "writeClipboardText", map[string]any{"tabId": float64(123), "text": "never written", "timeoutMs": float64(50)}, nil)
	if err == nil || len(f.operations()) != 0 {
		t.Fatalf("expired write sent: %v %v", err, f.operations())
	}
}

func TestClipboardCLIRejectsMalformedAndOversizedBeforePublishing(t *testing.T) {
	for _, result := range []map[string]any{
		{"items": nil},
		{"items": []any{map[string]any{"entries": []any{map[string]any{"mime_type": "text/plain", "text": "太大"}}}}},
		{"items": []any{map[string]any{"entries": []any{map[string]any{"mime_type": "image/png", "base64": "eA=="}}}}},
	} {
		f := &clipboardFixture{result: result}
		options := f.start(t)
		directory := t.TempDir()
		_, err := clipboardToFile(options, nil, map[string]any{"tabId": float64(123), "maxBytes": float64(2)}, filepath.Join(directory, "bad.json"))
		if err == nil {
			t.Fatal("invalid result accepted")
		}
		assertNoExportFiles(t, directory)
	}
}

func TestClipboardCLIEmptyTextAndNoOpItems(t *testing.T) {
	for _, mode := range []string{"write-text", "write"} {
		f := &clipboardFixture{}
		options := f.start(t)
		command := newClipboardCommand()
		args := []string{mode, "--socket", options.socketPath, "--tab-id", "123"}
		if mode == "write-text" {
			args = append(args, "--text", "")
		} else {
			input := filepath.Join(t.TempDir(), "empty.json")
			if err := os.WriteFile(input, []byte(`{"items":[]}`), 0600); err != nil {
				t.Fatal(err)
			}
			args = append(args, "--input", input)
		}
		command.SetArgs(args)
		command.SetOut(&bytes.Buffer{})
		if err := command.Execute(); err != nil {
			t.Fatal(err)
		}
		if len(f.operations()) != 1 {
			t.Fatal("expected one explicit operation")
		}
	}
}

func TestClipboardMCPTextAppearsOnlyOnce(t *testing.T) {
	f := &clipboardFixture{}
	options := f.start(t)
	server := &mcpServer{runner: newActionRunner(options)}
	request, _ := json.Marshal(map[string]any{"name": "read_clipboard_text", "arguments": map[string]any{"tab_id": 123}})
	result, err := server.callTool(request)
	if err != nil {
		t.Fatal(err)
	}
	encoded, _ := json.Marshal(result)
	if bytes.Count(encoded, []byte("剪贴板 fixture")) != 1 || bytes.Contains(encoded, []byte("structuredContent")) {
		t.Fatalf("duplicated body: %s", encoded)
	}
}

func TestClipboardInputRejectsExtraEnvelopeAndTrailingJSON(t *testing.T) {
	for _, input := range []string{`{"items":[],"text":"unexpected"}`, `{"items":[]} {}`, `null`, `{"text":"wrong"}`} {
		file := filepath.Join(t.TempDir(), "input.json")
		if err := os.WriteFile(file, []byte(input), 0600); err != nil {
			t.Fatal(err)
		}
		if _, err := readClipboardFile(file); err == nil {
			t.Fatalf("accepted %s", input)
		}
	}
}

func TestClipboardJSONUnicodeDoesNotSilentlyReplaceInput(t *testing.T) {
	for _, value := range []string{`{"text":"\ud800"}`, `{"text":"\udfff"}`, `{"text":"\ud800x"}`, "{\"text\":\"\xff\"}"} {
		if err := validateClipboardJSONUnicode([]byte(value)); err == nil {
			t.Fatalf("accepted malformed Unicode %q", value)
		}
	}
	for _, value := range []string{`{"text":"\ud83d\ude00"}`, `{"text":"\\ud800"}`, `{"text":"中文\\\""}`} {
		if err := validateClipboardJSONUnicode([]byte(value)); err != nil {
			t.Fatalf("rejected valid Unicode %q: %v", value, err)
		}
	}
	command := newCallCommand()
	command.SetArgs([]string{"--method", "writeClipboardText", "--params", `{"tabId":123,"text":"\ud800"}`})
	if err := command.Execute(); err == nil || !strings.Contains(err.Error(), "Unicode") {
		t.Fatalf("invalid generic call reached transport: %v", err)
	}
}

func TestClipboardCLIRejectsInvalidUTF8BeforeCopyOrTransport(t *testing.T) {
	options := socketOptions{timeout: time.Second}
	_, err := newCLIControl("utf8", "first").invoke(options, "writeClipboardText", map[string]any{"tabId": 123, "text": string([]byte{0xff})}, nil)
	if err == nil || !strings.Contains(err.Error(), "Unicode") {
		t.Fatalf("invalid input reached connection: %v", err)
	}
}

func TestClipboardCLIRejectsRawResponseLoneSurrogates(t *testing.T) {
	for _, raw := range []json.RawMessage{json.RawMessage(`{"id":"x","result":{"text":"\ud800"}}`), json.RawMessage(`{"id":"x","result":{"text":"\udfff"}}`)} {
		reader, writer := net.Pipe()
		done := make(chan struct{})
		go func() { defer close(done); defer writer.Close(); _ = wire.WriteJSON(writer, raw) }()
		_, err := readResponseForID(reader, "x", true)
		reader.Close()
		<-done
		if err == nil || !strings.Contains(err.Error(), "Unicode") {
			t.Fatalf("invalid response decoded: %v", err)
		}
	}
}

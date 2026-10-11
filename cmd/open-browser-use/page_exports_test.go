package main

import (
	"bytes"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"net"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/ifuryst/open-browser-use/internal/transport"
	"github.com/ifuryst/open-browser-use/internal/wire"
)

var exportTestBytes = []byte("%PDF-1.7\nsynthetic test bytes\n%%EOF\n")

type exportFixture struct {
	mu          sync.Mutex
	calls       []map[string]any
	unsupported bool
	delayInfo   time.Duration
	result      func(map[string]any) map[string]any
	failure     string
}

func exportResult(_ map[string]any) map[string]any {
	return map[string]any{"format": "pdf", "mimeType": "application/pdf", "encoding": "base64", "data": base64.StdEncoding.EncodeToString(exportTestBytes), "byteLength": len(exportTestBytes)}
}

func (f *exportFixture) start(t *testing.T) socketOptions {
	t.Helper()
	directory, err := os.MkdirTemp(socketTestTempRoot(), "obu-exp-")
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
					var result any
					failure := ""
					switch call["method"] {
					case "getInfo":
						time.Sleep(f.delayInfo)
						metadata := map[string]any{"turnLifecycleVersion": 1}
						if !f.unsupported {
							metadata["pageExportVersion"] = 1
						}
						result = map[string]any{"metadata": metadata}
					case "getControlState":
						result = map[string]any{"controlEpoch": 7, "nextTurnId": "next", "closing": false, "lifecycleVersion": 1}
					case "exportPage":
						makeResult := f.result
						if makeResult == nil {
							makeResult = exportResult
						}
						result = makeResult(call["params"].(map[string]any))
						failure = f.failure
					default:
						result = map[string]any{}
					}
					response := map[string]any{"jsonrpc": "2.0", "id": call["id"], "result": result}
					if failure != "" {
						delete(response, "result")
						response["error"] = map[string]any{"code": -32000, "message": failure}
					}
					if wire.WriteJSON(conn, response) != nil {
						return
					}
				}
			}(conn)
		}
	}()
	t.Cleanup(func() { _ = listener.Close(); workers.Wait() })
	return socketOptions{socketPath: endpoint, timeout: 3 * time.Second, sessionID: "export-test", control: newCLIControl("export-test", "first")}
}

func (f *exportFixture) exportCalls() []map[string]any {
	f.mu.Lock()
	defer f.mu.Unlock()
	var calls []map[string]any
	for _, call := range f.calls {
		if call["method"] == "exportPage" {
			calls = append(calls, call)
		}
	}
	return calls
}

func exportParams() map[string]any { return map[string]any{"tabId": float64(123), "format": "pdf"} }

func assertNoExportFiles(t *testing.T, directory string) {
	t.Helper()
	files, err := os.ReadDir(directory)
	if err != nil {
		t.Fatal(err)
	}
	if len(files) != 0 {
		t.Fatalf("unexpected files after rejected export: %v", files)
	}
}

func TestExportPageCommandPublishesValidatedBytesAndSmallMetadata(t *testing.T) {
	f := &exportFixture{}
	options := f.start(t)
	target := filepath.Join(t.TempDir(), "page.pdf")
	command := newExportPageCommand()
	var output bytes.Buffer
	command.SetOut(&output)
	command.SetArgs([]string{"--socket", options.socketPath, "--session-id", "export-test", "--tab-id", "123", "--format", "pdf", "--output", target, "--pdf-options", `{"printBackground":false,"marginTop":0}`})
	if err := command.Execute(); err != nil {
		t.Fatal(err)
	}
	actual, err := os.ReadFile(target)
	if err != nil || !bytes.Equal(actual, exportTestBytes) {
		t.Fatalf("file %q: %v", actual, err)
	}
	var result map[string]any
	if err := json.Unmarshal(output.Bytes(), &result); err != nil {
		t.Fatal(err)
	}
	if len(result) != 4 || result["path"] != target || result["format"] != "pdf" || result["byteLength"] != float64(len(exportTestBytes)) {
		t.Fatalf("unexpected metadata %#v", result)
	}
	calls := f.exportCalls()
	if len(calls) != 1 {
		t.Fatalf("export count %d", len(calls))
	}
	params := calls[0]["params"].(map[string]any)
	pdf := params["pdf"].(map[string]any)
	if pdf["printBackground"] != false || pdf["marginTop"] != float64(0) || params["control_epoch"] != float64(7) {
		t.Fatalf("wire params %#v", params)
	}
	if runtime.GOOS != "windows" {
		info, _ := os.Stat(target)
		if info.Mode().Perm() != 0600 {
			t.Fatalf("permissions %o", info.Mode().Perm())
		}
	}
}

func TestExportPageRejectsInvalidResultWithoutWriting(t *testing.T) {
	changes := map[string]func(map[string]any){
		"unknown-field":        func(r map[string]any) { r["extra"] = true },
		"wrong-format":         func(r map[string]any) { r["format"] = "mhtml" },
		"wrong-mime":           func(r map[string]any) { r["mimeType"] = "text/html" },
		"wrong-encoding":       func(r map[string]any) { r["encoding"] = "base64url" },
		"length-mismatch":      func(r map[string]any) { r["byteLength"] = 1 },
		"fractional-length":    func(r map[string]any) { r["byteLength"] = 1.5 },
		"empty-data":           func(r map[string]any) { r["byteLength"] = 0; r["data"] = "" },
		"noncanonical-padding": func(r map[string]any) { r["byteLength"] = 1; r["data"] = "YR==" },
		"embedded-newline":     func(r map[string]any) { r["data"] = r["data"].(string) + "\n" },
		"over-budget":          func(r map[string]any) { r["byteLength"] = 16777217 },
	}
	for name, change := range changes {
		t.Run(name, func(t *testing.T) {
			f := &exportFixture{result: func(p map[string]any) map[string]any { r := exportResult(p); change(r); return r }}
			options := f.start(t)
			directory := t.TempDir()
			if _, err := exportPageToFile(options, nil, exportParams(), filepath.Join(directory, "page.pdf")); err == nil {
				t.Fatal("invalid response accepted")
			}
			assertNoExportFiles(t, directory)
		})
	}
}

func TestExportPageRejectsInvalidParamsBeforeConnecting(t *testing.T) {
	cases := []map[string]any{
		{"tabId": float64(1), "format": "PDF"}, {"tabId": float64(0), "format": "pdf"},
		{"tabId": float64(1), "format": "pdf", "maxBytes": nil}, {"tabId": float64(1), "format": "pdf", "maxBytes": float64(0)},
		{"tabId": float64(1), "format": "pdf", "timeoutMs": nil}, {"tabId": float64(1), "format": "pdf", "timeoutMs": 1.5},
		{"tabId": float64(1), "format": "pdf", "pdf": nil}, {"tabId": float64(1), "format": "mhtml", "pdf": map[string]any{}},
		{"tabId": float64(1), "format": "pdf", "pdf": map[string]any{"headerTemplate": "secret"}},
		{"tabId": float64(1), "format": "pdf", "pdf": map[string]any{"Landscape": true}},
		{"tabId": float64(1), "format": "pdf", "pdf": map[string]any{"landscape": nil}},
		{"tabId": float64(1), "format": "pdf", "pdf": map[string]any{"scale": 3}},
		{"tabId": float64(1), "format": "pdf", "outputPath": "ignored"},
	}
	for index, params := range cases {
		t.Run(fmt.Sprint(index), func(t *testing.T) {
			f := &exportFixture{}
			options := f.start(t)
			if _, err := invokeWithOptions(options, "exportPage", params); err == nil {
				t.Fatal("invalid parameters accepted")
			}
			f.mu.Lock()
			defer f.mu.Unlock()
			if len(f.calls) != 0 {
				t.Fatalf("invalid call connected: %v", f.calls)
			}
		})
	}
}

func TestExportPageExistingTargetRejectsBeforeRPC(t *testing.T) {
	f := &exportFixture{}
	options := f.start(t)
	directory := t.TempDir()
	target := filepath.Join(directory, "page.pdf")
	if err := os.WriteFile(target, []byte("original"), 0600); err != nil {
		t.Fatal(err)
	}
	if _, err := exportPageToFile(options, nil, exportParams(), target); err == nil || !strings.Contains(err.Error(), "already exists") {
		t.Fatalf("expected existing target error, got %v", err)
	}
	data, _ := os.ReadFile(target)
	if string(data) != "original" {
		t.Fatal("original overwritten")
	}
	f.mu.Lock()
	defer f.mu.Unlock()
	if len(f.calls) != 0 {
		t.Fatal("unnecessary browser request before output rejection")
	}
}

func TestExportPublishConcurrentNoOverwriteAndNoTemporaryFiles(t *testing.T) {
	directory := t.TempDir()
	target := filepath.Join(directory, "page.pdf")
	var workers sync.WaitGroup
	results := make(chan error, 16)
	for i := 0; i < 16; i++ {
		workers.Add(1)
		go func() {
			defer workers.Done()
			results <- publishPageExport(target, exportTestBytes, time.Now().Add(3*time.Second), os.Link)
		}()
	}
	workers.Wait()
	close(results)
	success := 0
	for err := range results {
		if err == nil {
			success++
		}
	}
	if success != 1 {
		t.Fatalf("expected one atomic winner, got %d", success)
	}
	data, _ := os.ReadFile(target)
	if !bytes.Equal(data, exportTestBytes) {
		t.Fatal("winning file incomplete")
	}
	files, _ := os.ReadDir(directory)
	if len(files) != 1 || files[0].Name() != "page.pdf" {
		t.Fatalf("temporary files retained: %v", files)
	}
}

func TestExportPublishUnsupportedLinksAndExpiredDeadlineDoNotFallBack(t *testing.T) {
	directory := t.TempDir()
	target := filepath.Join(directory, "page.pdf")
	calls := 0
	link := func(_, _ string) error { calls++; return errors.New("filesystem does not support hard links") }
	if err := publishPageExport(target, exportTestBytes, time.Now().Add(time.Second), link); err == nil || !strings.Contains(err.Error(), "hard links required") {
		t.Fatalf("missing explicit failure %v", err)
	}
	if calls != 1 {
		t.Fatalf("link calls %d", calls)
	}
	assertNoExportFiles(t, directory)
	if err := publishPageExport(target, exportTestBytes, time.Now().Add(-time.Second), link); err == nil {
		t.Fatal("expired write succeeded")
	}
	if calls != 1 {
		t.Fatal("expired write reached publication")
	}
	assertNoExportFiles(t, directory)
}

func TestExportCapabilityIncludesManualScope(t *testing.T) {
	for _, manual := range []bool{false, true} {
		t.Run(fmt.Sprint(manual), func(t *testing.T) {
			f := &exportFixture{unsupported: true}
			options := f.start(t)
			params := exportParams()
			if manual {
				params["session_id"] = "other"
				params["turn_id"] = "old"
				params["control_epoch"] = float64(7)
			}
			if _, err := invokeWithOptions(options, "exportPage", params); err == nil || !strings.Contains(err.Error(), "OBU_PAGE_EXPORT_UNSUPPORTED") {
				t.Fatalf("capability error: %v", err)
			}
			if len(f.exportCalls()) != 0 {
				t.Fatal("unsupported export sent")
			}
		})
	}
}

func TestExportManualMetadataAndRemainingBudget(t *testing.T) {
	f := &exportFixture{delayInfo: 100 * time.Millisecond}
	options := f.start(t)
	params := exportParams()
	params["session_id"] = "other"
	params["turn_id"] = "captured"
	params["control_epoch"] = float64(7)
	params["timeoutMs"] = float64(1500)
	if _, err := invokeWithOptions(options, "exportPage", params); err != nil {
		t.Fatal(err)
	}
	actual := f.exportCalls()[0]["params"].(map[string]any)
	if actual["session_id"] != "other" || actual["turn_id"] != "captured" || actual["control_epoch"] != float64(7) {
		t.Fatalf("scope changed: %v", actual)
	}
	if budget := actual["timeoutMs"].(float64); budget < 1 || budget > 1400 {
		t.Fatalf("discovery was not charged to budget: %v", budget)
	}
	if options.control.snapshot().version != -1 {
		t.Fatal("manual scope updated shared lifecycle")
	}
}

func TestExportShortDeadlineDoesNotStartAfterDiscovery(t *testing.T) {
	f := &exportFixture{delayInfo: 250 * time.Millisecond}
	options := f.start(t)
	options.timeout = 10 * time.Second
	params := exportParams()
	params["timeoutMs"] = float64(100)
	directory := t.TempDir()
	if _, err := exportPageToFile(options, nil, params, filepath.Join(directory, "page.pdf")); err == nil || !strings.Contains(err.Error(), "timed out") {
		t.Fatalf("wanted timeout, got %v", err)
	}
	if len(f.exportCalls()) != 0 {
		t.Fatal("short export started after deadline")
	}
	assertNoExportFiles(t, directory)
}

func TestMCPExportSmallResultAndBrowserError(t *testing.T) {
	for _, failure := range []string{"", "OBU_PAGE_EXPORT_TOO_LARGE"} {
		t.Run(failure, func(t *testing.T) {
			f := &exportFixture{failure: failure}
			options := f.start(t)
			server := newMCPServer(options)
			t.Cleanup(server.shutdownBrowser)
			directory := t.TempDir()
			target := filepath.Join(directory, "page.pdf")
			request, _ := json.Marshal(map[string]any{"name": "export_page", "arguments": map[string]any{"tab_id": 123, "format": "pdf", "output_path": target}})
			result, err := server.callTool(request)
			if err != nil {
				t.Fatal(err)
			}
			if failure != "" {
				if result["isError"] != true {
					t.Fatalf("RPC failure not MCP isError: %v", result)
				}
				assertNoExportFiles(t, directory)
				return
			}
			metadata, ok := result["structuredContent"].(map[string]any)
			if !ok || len(metadata) != 4 || metadata["path"] != target || result["isError"] != false {
				t.Fatalf("wrong MCP output %v", result)
			}
			if _, exists := metadata["data"]; exists {
				t.Fatal("MCP echoed export base64")
			}
		})
	}
}

func TestMCPExportQueueTimeUsesOriginalSubmission(t *testing.T) {
	f := &exportFixture{delayInfo: 250 * time.Millisecond}
	options := f.start(t)
	options.timeout = 10 * time.Second
	server := newMCPServer(options)
	directory := t.TempDir()
	batch := []any{
		map[string]any{"jsonrpc": "2.0", "id": 1, "method": "tools/call", "params": map[string]any{"name": "info", "arguments": map[string]any{}}},
		map[string]any{"jsonrpc": "2.0", "id": 2, "method": "tools/call", "params": map[string]any{"name": "export_page", "arguments": map[string]any{"tab_id": 123, "format": "pdf", "output_path": filepath.Join(directory, "page.pdf"), "timeout_ms": 100}}},
	}
	input, _ := json.Marshal(batch)
	var output bytes.Buffer
	if err := server.serve(bytes.NewReader(append(input, '\n')), &output); err != nil {
		t.Fatal(err)
	}
	responses := decodeMCPResponses(t, output.Bytes())
	if len(responses) != 2 || responses[1]["result"].(map[string]any)["isError"] != true {
		t.Fatalf("missing queued timeout %v", responses)
	}
	if len(f.exportCalls()) != 0 {
		t.Fatal("queued export received a fresh deadline")
	}
	assertNoExportFiles(t, directory)
}

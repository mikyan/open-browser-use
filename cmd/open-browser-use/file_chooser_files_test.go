package main

import (
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"reflect"
	"strings"
	"testing"
	"time"
)

func chooserSelectionCalls(f *controlFixture) []map[string]any {
	f.mu.Lock()
	defer f.mu.Unlock()
	var calls []map[string]any
	for _, call := range f.calls {
		if call["method"] == "setFileChooserFiles" {
			calls = append(calls, call)
		}
	}
	return calls
}

func runChooserCobra(options socketOptions, args []string) error {
	command := newRootCommand()
	command.SetOut(io.Discard)
	command.SetErr(io.Discard)
	command.SetArgs(append([]string{"set-file-chooser-files", "--socket", options.socketPath,
		"--session-id", options.sessionID, "--timeout", options.timeout.String()}, args...))
	return command.Execute()
}

func TestSetFileChooserFilesExplicitClearWire(t *testing.T) {
	for _, mode := range []string{"cobra", "action-plan", "mcp-stdio"} {
		t.Run(mode, func(t *testing.T) {
			f := &controlFixture{epoch: 37}
			options := f.start(t)
			switch mode {
			case "cobra":
				if err := runChooserCobra(options, []string{"--file-chooser-id", "original-chooser", "--clear"}); err != nil {
					t.Fatal(err)
				}
			case "action-plan":
				if _, err := newActionRunner(options).run("set-file-chooser-files original-chooser --clear"); err != nil {
					t.Fatal(err)
				}
			case "mcp-stdio":
				server := newMCPServer(options)
				var output bytes.Buffer
				input := `{"jsonrpc":"2.0","id":"clear","method":"tools/call","params":{"name":"set_file_chooser_files","arguments":{"file_chooser_id":"original-chooser","files":[]}}}` + "\n"
				if err := server.serve(strings.NewReader(input), &output); err != nil {
					t.Fatal(err)
				}
				responses := decodeMCPResponses(t, output.Bytes())
				if len(responses) != 1 || responses[0]["result"].(map[string]any)["isError"] != false {
					t.Fatalf("explicit empty list failed: %s", output.String())
				}
			}
			calls := chooserSelectionCalls(f)
			if len(calls) != 1 {
				t.Fatalf("selection requests = %d, want one", len(calls))
			}
			params := calls[0]["params"].(map[string]any)
			if files, ok := params["files"].([]any); !ok || len(files) != 0 {
				t.Fatalf("explicit clear must send an array, not null/omission: %#v", params["files"])
			}
			if params["fileChooserId"] != "original-chooser" || params["session_id"] != "fixture" || params["control_epoch"] != float64(37) || params["turn_id"] == "" {
				t.Fatalf("changed original scope: %#v", params)
			}
			if _, ok := params["clear"]; ok {
				t.Fatal("CLI-only clear flag leaked onto the wire")
			}
		})
	}
}

func TestSetFileChooserFilesPreservesFileForms(t *testing.T) {
	for _, tc := range []struct {
		name, mode string
		args       []string
		files      []any
	}{
		{"repeated-flags", "cobra", []string{"--file-chooser-id", "chooser", "--file", "first.txt", "--file", "second.txt"}, []any{"first.txt", "second.txt"}},
		{"csv-flags", "cobra", []string{"--file-chooser-id", "chooser", "--file", "first.txt,second.txt"}, []any{"first.txt", "second.txt"}},
		{"false-is-not-clear", "cobra", []string{"--file-chooser-id", "chooser", "--clear=false", "--file", "first.txt"}, []any{"first.txt"}},
		{"positional", "runner", []string{"chooser", "first file.txt", "second.txt"}, []any{"first file.txt", "second.txt"}},
		{"flag-id-positional", "runner", []string{"--file-chooser-id", "chooser", "first,not-split.txt", "second.txt"}, []any{"first,not-split.txt", "second.txt"}},
		{"runner-repeated-flags", "runner", []string{"chooser", "--file", "first.txt", "--file", "second.txt"}, []any{"first.txt", "second.txt"}},
		{"literal-clear-file", "runner", []string{"chooser", "--", "--clear"}, []any{"--clear"}},
		{"literal-flag-like-id", "runner", []string{"--", "--clear", "file.txt"}, []any{"file.txt"}},
	} {
		t.Run(tc.name, func(t *testing.T) {
			f := &controlFixture{epoch: 37}
			options := f.start(t)
			var err error
			if tc.mode == "cobra" {
				err = runChooserCobra(options, tc.args)
			} else {
				_, _, err = newActionRunner(options).runSetFileChooserFilesAction(tc.args)
			}
			if err != nil {
				t.Fatal(err)
			}
			calls := chooserSelectionCalls(f)
			if len(calls) != 1 || !reflect.DeepEqual(calls[0]["params"].(map[string]any)["files"], tc.files) {
				t.Fatalf("original file order/form changed: %#v", calls)
			}
		})
	}
}

func TestSetFileChooserFilesRejectsImplicitOrConflictingClearBeforeConnecting(t *testing.T) {
	for _, tc := range []struct {
		mode string
		args []string
	}{
		{"cobra", []string{"--file-chooser-id", "chooser"}},
		{"cobra", []string{"--file-chooser-id", "chooser", "--clear=false"}},
		{"cobra", []string{"--file-chooser-id", "chooser", "--clear", "--file", "file.txt"}},
		{"cobra", []string{"--file-chooser-id", "chooser", "--clear", "--file="}},
		{"cobra", []string{"--clear"}},
		{"cobra", []string{"--file-chooser-id", "chooser", "--clear=maybe"}},
		{"runner", []string{"chooser"}},
		{"runner", []string{"chooser", "--clear=false"}},
		{"runner", []string{"chooser", "--clear", "file.txt"}},
		{"runner", []string{"chooser", "--clear", "--file", "file.txt"}},
		{"runner", []string{"chooser", "--clear", "--file="}},
		{"runner", []string{"--clear"}},
		{"runner", []string{"chooser", "--clear=maybe"}},
		{"runner", []string{"chooser", "--unknown", "file.txt"}},
		{"runner", []string{"chooser", "first.txt", "--file", "second.txt"}},
		{"runner", []string{"chooser", "--file", "first.txt", "second.txt"}},
		{"runner", []string{"--file-chooser-id", "chooser", "first.txt", "--file", "second.txt"}},
	} {
		t.Run(fmt.Sprint(tc.mode, tc.args), func(t *testing.T) {
			f := &controlFixture{epoch: 37}
			options := f.start(t)
			var err error
			if tc.mode == "cobra" {
				err = runChooserCobra(options, tc.args)
			} else {
				_, _, err = newActionRunner(options).runSetFileChooserFilesAction(tc.args)
			}
			if err == nil {
				t.Fatal("ambiguous selection was accepted")
			}
			if got := f.methods(); len(got) != 0 {
				t.Fatalf("invalid selection connected: %v", got)
			}
		})
	}
}

func TestSetFileChooserFilesMCPRequiresExplicitArrayAndPreservesLiteralPaths(t *testing.T) {
	f := &controlFixture{epoch: 37}
	server := newMCPServer(f.start(t))
	defer server.shutdownBrowser()
	for _, input := range []string{
		`{"file_chooser_id":"chooser"}`, `{"file_chooser_id":"chooser","files":null}`,
		`{"file_chooser_id":"chooser","files":"[]"}`, `{"file_chooser_id":"chooser","files":false}`,
		`{"file_chooser_id":"chooser","files":[""]}`, `{"file_chooser_id":"chooser","files":[null]}`,
		`{"file_chooser_id":"chooser","files":[1]}`, `{"files":[]}`,
	} {
		var args map[string]any
		if err := json.Unmarshal([]byte(input), &args); err != nil {
			t.Fatal(err)
		}
		if _, err := server.runTool("set_file_chooser_files", args); err == nil {
			t.Fatalf("invalid MCP selection accepted: %s", input)
		}
	}
	if len(f.methods()) != 0 {
		t.Fatal("invalid MCP args performed browser I/O")
	}
	args := map[string]any{"file_chooser_id": "--clear", "files": []any{"--file-chooser-id", "--clear", "a,b.txt", "file with spaces.txt"}}
	if _, err := server.runTool("set_file_chooser_files", args); err != nil {
		t.Fatal(err)
	}
	calls := chooserSelectionCalls(f)
	if len(calls) != 1 || calls[0]["params"].(map[string]any)["fileChooserId"] != args["file_chooser_id"] || !reflect.DeepEqual(calls[0]["params"].(map[string]any)["files"], args["files"]) {
		t.Fatalf("MCP data was reinterpreted as CLI options: %#v", calls)
	}
}

func TestSetFileChooserFilesMCPSchemaAllowsEmptyButStillRequiresFiles(t *testing.T) {
	for _, tool := range mcpTools() {
		if tool.Name != "set_file_chooser_files" {
			continue
		}
		files := tool.InputSchema["properties"].(map[string]any)["files"].(map[string]any)
		if minimum, exists := files["minItems"]; exists && minimum != 0 {
			t.Fatalf("schema still rejects explicit clear: %#v", files)
		}
		if !reflect.DeepEqual(tool.InputSchema["required"], []string{"file_chooser_id", "files"}) {
			t.Fatalf("files became optional: %#v", tool.InputSchema)
		}
		return
	}
	t.Fatal("chooser tool is missing")
}

func TestSetFileChooserFilesClearKeepsOriginalDeadlineAndDoesNotRetryStaleScope(t *testing.T) {
	f := &controlFixture{epoch: 37, delayInfo: 80 * time.Millisecond}
	options := f.start(t)
	options.timeout = 20 * time.Millisecond
	runner := newActionRunner(options)
	if _, _, err := runner.runSetFileChooserFilesAction([]string{"chooser", "--clear"}); err == nil || !strings.Contains(err.Error(), "timeout") {
		t.Fatalf("original transport deadline was not retained: %v", err)
	}
	if len(chooserSelectionCalls(f)) != 0 {
		t.Fatal("expired admission dispatched clear")
	}
	g := &controlFixture{epoch: 37}
	server := newMCPServer(g.start(t))
	defer server.shutdownBrowser()
	args := map[string]any{"file_chooser_id": "chooser", "files": []any{}}
	if _, err := server.runTool("set_file_chooser_files", args); err != nil {
		t.Fatal(err)
	}
	g.mu.Lock()
	g.epoch++
	g.mu.Unlock()
	response, err := server.runTool("set_file_chooser_files", args)
	if err != nil {
		t.Fatal(err)
	}
	if failure, ok := response.(map[string]any)["error"].(map[string]any); !ok || !strings.Contains(failure["message"].(string), "OBU_STALE_CONTROL_EPOCH") {
		t.Fatalf("native stale-scope error was lost: %#v", response)
	}
	if got := len(chooserSelectionCalls(g)); got != 2 {
		t.Fatalf("expected one request per explicit call, got %d", got)
	}
}

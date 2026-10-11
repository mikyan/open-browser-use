package main

import (
	"fmt"
	"net"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/ifuryst/open-browser-use/internal/transport"
	"github.com/ifuryst/open-browser-use/internal/wire"
)

type backgroundCLIWire struct {
	mu         sync.Mutex
	calls      []map[string]any
	version    any
	delay      time.Duration
	failCreate bool
}

func (f *backgroundCLIWire) start(t *testing.T) socketOptions {
	t.Helper()
	dir, err := os.MkdirTemp(socketTestTempRoot(), "obu-bg-cli-")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = os.RemoveAll(dir) })
	endpoint := transport.NewEndpoint(dir, filepath.Base(dir))
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
					version, delay, failCreate := f.version, f.delay, f.failCreate
					f.mu.Unlock()
					var result any = map[string]any{}
					switch call["method"] {
					case "getInfo":
						time.Sleep(delay)
						result = map[string]any{"metadata": map[string]any{"turnLifecycleVersion": 1, "backgroundWindowVersion": version}}
					case "getControlState":
						result = map[string]any{"lifecycleVersion": 1, "controlEpoch": 7, "nextTurnId": "next", "closing": false}
					case "createTab":
						result = map[string]any{"id": 12}
					}
					response := map[string]any{"jsonrpc": "2.0", "id": call["id"], "result": result}
					if failCreate && call["method"] == "createTab" {
						delete(response, "result")
						response["error"] = map[string]any{"code": -32000, "message": "creation failed"}
					}
					if wire.WriteJSON(conn, response) != nil {
						return
					}
				}
			}(conn)
		}
	}()
	t.Cleanup(func() { _ = listener.Close(); workers.Wait() })
	return socketOptions{socketPath: endpoint, timeout: time.Second, sessionID: "fixture", control: newCLIControl("fixture", "initial")}
}

func (f *backgroundCLIWire) snapshot() []map[string]any {
	f.mu.Lock()
	defer f.mu.Unlock()
	return append([]map[string]any(nil), f.calls...)
}

func TestBackgroundWindowCLIFlagAndMCPWire(t *testing.T) {
	for _, mode := range []string{"cobra", "runner", "mcp"} {
		t.Run(mode, func(t *testing.T) {
			f := &backgroundCLIWire{version: 1}
			options := f.start(t)
			switch mode {
			case "cobra":
				cmd := newOpenTabCommand()
				cmd.SetArgs([]string{"--socket", options.socketPath, "--background-window", "--url", "https://fixture.test"})
				if err := cmd.Execute(); err != nil {
					t.Fatal(err)
				}
			case "runner":
				_, _, err := newActionRunner(options).runOpenTabAction([]string{"--background-window", "https://fixture.test"})
				if err != nil {
					t.Fatal(err)
				}
			case "mcp":
				server := newMCPServer(options)
				defer server.shutdownBrowser()
				if _, err := server.runOpenTabTool(map[string]any{"background_window": true, "url": "https://fixture.test"}); err != nil {
					t.Fatal(err)
				}
			}
			creates, navigations, capability := 0, 0, 0
			var createScope map[string]any
			for _, call := range f.snapshot() {
				params := call["params"].(map[string]any)
				if call["method"] == "getInfo" {
					capability++
				}
				if call["method"] == "createTab" {
					creates++
					createScope = params
					if params["backgroundWindow"] != true || params["control_epoch"] != float64(7) {
						t.Fatalf("create %#v", params)
					}
				}
				if call["method"] == "executeCdp" {
					navigations++
					if params["method"] != "Page.navigate" || params["commandParams"].(map[string]any)["url"] != "https://fixture.test" {
						t.Fatalf("navigate %#v", params)
					}
					if _, exists := params["backgroundWindow"]; exists {
						t.Fatal("creation flag leaked")
					}
					for _, key := range []string{"session_id", "turn_id", "control_epoch"} {
						if params[key] != createScope[key] {
							t.Fatalf("changed %s", key)
						}
					}
				}
			}
			if creates != 1 || navigations != 1 || capability != 2 {
				t.Fatalf("create=%d navigate=%d info=%d", creates, navigations, capability)
			}
		})
	}
}

func TestBackgroundWindowDefaultAndFalsePreserveCLIMCPWire(t *testing.T) {
	f := &backgroundCLIWire{version: nil}
	options := f.start(t)
	server := newMCPServer(options)
	defer server.shutdownBrowser()
	for _, args := range []map[string]any{{}, {"background_window": false}} {
		if _, err := server.runOpenTabTool(args); err != nil {
			t.Fatal(err)
		}
	}
	methods := []any{}
	for _, call := range f.snapshot() {
		methods = append(methods, call["method"])
		if call["method"] == "createTab" {
			if _, exists := call["params"].(map[string]any)["backgroundWindow"]; exists {
				t.Fatal("false changed legacy wire")
			}
		}
	}
	if !reflect.DeepEqual(methods, []any{"getInfo", "getControlState", "createTab", "createTab"}) {
		t.Fatalf("calls %v", methods)
	}
	for _, args := range [][]string{nil, {"--background-window=false"}} {
		value, cleaned, err := backgroundWindowArg(args)
		if err != nil || value || len(cleaned) != 0 {
			t.Fatalf("false flag: %v %v %v", value, cleaned, err)
		}
	}
}

func TestBackgroundWindowMCPRefreshesCapabilityOnSameConnection(t *testing.T) {
	f := &backgroundCLIWire{version: 1}
	server := newMCPServer(f.start(t))
	defer server.shutdownBrowser()
	if _, err := server.runOpenTabTool(map[string]any{"background_window": true}); err != nil {
		t.Fatal(err)
	}
	f.mu.Lock()
	f.version = nil
	f.mu.Unlock()
	if _, err := server.runOpenTabTool(map[string]any{"background_window": true}); err == nil || !strings.Contains(err.Error(), "OBU_BACKGROUND_WINDOW_UNSUPPORTED") {
		t.Fatalf("downgrade: %v", err)
	}
	count := 0
	for _, call := range f.snapshot() {
		if call["method"] == "createTab" {
			count++
		}
	}
	if count != 1 {
		t.Fatalf("created %d times", count)
	}
}

func TestBackgroundWindowCLIRejectsBadCapabilityEvenExplicitEpoch(t *testing.T) {
	for _, version := range []any{nil, 0, 2, true, "1", map[string]any{}} {
		t.Run(fmt.Sprint(version), func(t *testing.T) {
			f := &backgroundCLIWire{version: version}
			options := f.start(t)
			_, err := invokeWithOptions(options, "createTab", map[string]any{"backgroundWindow": true, "control_epoch": 7})
			if err == nil || !strings.Contains(err.Error(), "OBU_BACKGROUND_WINDOW_UNSUPPORTED") {
				t.Fatalf("got %v", err)
			}
			calls := f.snapshot()
			if len(calls) != 1 || calls[0]["method"] != "getInfo" {
				t.Fatalf("calls %#v", calls)
			}
		})
	}
}

func TestBackgroundWindowInvalidCLIAndMCPOptionsDoNotConnect(t *testing.T) {
	options := socketOptions{socketPath: "unused", timeout: time.Second, control: newCLIControl("fixture", "initial")}
	server := newMCPServer(options)
	defer server.shutdownBrowser()
	for _, value := range []any{nil, 0, 1, "true", []any{}, map[string]any{}} {
		if _, err := server.runOpenTabTool(map[string]any{"background_window": value}); err == nil || !strings.Contains(err.Error(), "must be a boolean") {
			t.Fatalf("MCP %#v: %v", value, err)
		}
		if _, err := invokeWithOptions(options, "createTab", map[string]any{"backgroundWindow": value}); err == nil || !strings.Contains(err.Error(), "must be a boolean") {
			t.Fatalf("raw %#v: %v", value, err)
		}
	}
	if _, _, err := backgroundWindowArg([]string{"--background-window=maybe"}); err == nil {
		t.Fatal("invalid flag accepted")
	}
	cmd := newOpenTabCommand()
	cmd.SetArgs([]string{"--background-window=maybe"})
	if err := cmd.Execute(); err == nil {
		t.Fatal("Cobra accepted invalid bool")
	}
	for _, tool := range mcpTools() {
		if tool.Name == "open_tab" {
			property := tool.InputSchema["properties"].(map[string]any)["background_window"].(map[string]any)
			if property["type"] != "boolean" {
				t.Fatalf("schema %#v", property)
			}
			return
		}
	}
	t.Fatal("open_tab schema missing")
}

func TestBackgroundWindowCLICapabilityTimeoutDoesNotCreate(t *testing.T) {
	f := &backgroundCLIWire{version: 1, delay: 80 * time.Millisecond}
	options := f.start(t)
	options.timeout = 20 * time.Millisecond
	if _, err := invokeWithOptions(options, "createTab", map[string]any{"backgroundWindow": true, "control_epoch": 7}); err == nil {
		t.Fatal("expected timeout")
	}
	time.Sleep(100 * time.Millisecond)
	calls := f.snapshot()
	if len(calls) != 1 || calls[0]["method"] != "getInfo" {
		t.Fatalf("late create %#v", calls)
	}
}

func TestBackgroundWindowCLIMCPNativeFailureNeverReplays(t *testing.T) {
	for _, mode := range []string{"cobra", "runner", "mcp"} {
		t.Run(mode, func(t *testing.T) {
			f := &backgroundCLIWire{version: 1, failCreate: true}
			options := f.start(t)
			var err error
			switch mode {
			case "cobra":
				cmd := newOpenTabCommand()
				cmd.SetArgs([]string{"--socket", options.socketPath, "--background-window", "--url", "https://fixture.test"})
				err = cmd.Execute()
			case "runner":
				_, _, err = newActionRunner(options).runOpenTabAction([]string{"--background-window", "https://fixture.test"})
			case "mcp":
				server := newMCPServer(options)
				defer server.shutdownBrowser()
				_, err = server.runOpenTabTool(map[string]any{"background_window": true, "url": "https://fixture.test"})
			}
			if err == nil || !strings.Contains(err.Error(), "creation failed") {
				t.Fatalf("got %v", err)
			}
			creates := 0
			for _, call := range f.snapshot() {
				if call["method"] == "createTab" {
					creates++
				}
				if call["method"] == "attach" || call["method"] == "executeCdp" {
					t.Fatal("action after failed creation")
				}
			}
			if creates != 1 {
				t.Fatalf("create count %d", creates)
			}
		})
	}
}

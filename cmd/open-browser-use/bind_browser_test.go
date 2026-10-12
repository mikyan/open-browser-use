package main

import (
	"bytes"
	"encoding/json"
	"errors"
	"net"
	"strings"
	"testing"
	"time"

	"github.com/ifuryst/open-browser-use/internal/wire"
)

const bindingTestURL = "ws://127.0.0.1:9222/devtools/browser/exact"

func runBindCLI(args ...string) (string, error) {
	command := newRootCommand()
	var output bytes.Buffer
	command.SetOut(&output)
	command.SetErr(&output)
	command.SetArgs(append([]string{"bind-browser"}, args...))
	err := command.Execute()
	return output.String(), err
}
func bindCLIResult() map[string]any {
	return map[string]any{"bound": true, "generation": "generation", "extensionId": strings.Repeat("a", 32), "extensionInstanceId": "instance", "workerBootId": "worker", "portId": "port", "exclusive": true, "behavior": "default"}
}

func TestBindBrowserCLIValidatesBeforeAnyDial(t *testing.T) {
	previous := dialLocalEndpoint
	defer func() { dialLocalEndpoint = previous }()
	calls := 0
	dialLocalEndpoint = func(string, time.Duration) (net.Conn, error) { calls++; return nil, errors.New("must not dial") }
	for _, args := range [][]string{
		{}, {"--socket", "exact", "--cdp-url", bindingTestURL}, {"--socket", "exact", "--cdp-url", bindingTestURL, "--exclusive=false"},
		{"--socket", " exact ", "--cdp-url", bindingTestURL, "--exclusive"}, {"--socket", "exact", "--cdp-url", "ws://example.com:9222/devtools/browser/id", "--exclusive"},
		{"--socket", "exact", "--cdp-url", "ws://127.0.0.1:9222/devtools/page/id", "--exclusive"}, {"--socket", "exact", "--cdp-url", bindingTestURL, "--exclusive", "--timeout", "0s"},
		{"--socket", "exact", "--cdp-url", bindingTestURL, "--exclusive", "--timeout", "121s"}, {"--socket", "exact", "--cdp-url", bindingTestURL, "--exclusive", "--profile", "Default"},
	} {
		if _, err := runBindCLI(args...); err == nil {
			t.Fatalf("invalid arguments accepted: %v", args)
		}
	}
	if calls != 0 {
		t.Fatalf("invalid arguments dialed %d endpoints", calls)
	}
}

func TestBindBrowserCLIExactEndpointSingleRequestAndClose(t *testing.T) {
	previous := dialLocalEndpoint
	defer func() { dialLocalEndpoint = previous }()
	client, server := net.Pipe()
	defer server.Close()
	calls := 0
	dialLocalEndpoint = func(endpoint string, timeout time.Duration) (net.Conn, error) {
		calls++
		if endpoint != "exact-endpoint" || timeout <= 0 || timeout > time.Second {
			t.Errorf("dial changed endpoint/budget: %q %v", endpoint, timeout)
		}
		return client, nil
	}
	request := make(chan map[string]any, 1)
	finished := make(chan error, 1)
	go func() {
		_ = server.SetDeadline(time.Now().Add(2 * time.Second))
		var message map[string]any
		if err := wire.ReadJSON(server, &message); err != nil {
			finished <- err
			return
		}
		request <- message
		_ = wire.WriteJSON(server, map[string]any{"jsonrpc": "2.0", "method": "heartbeat", "params": map[string]any{}})
		_ = wire.WriteJSON(server, map[string]any{"jsonrpc": "2.0", "id": message["id"], "result": bindCLIResult()})
		var second map[string]any
		err := wire.ReadJSON(server, &second)
		if err == nil {
			err = errors.New("unexpected second CLI request")
		}
		finished <- err
	}()
	output, err := runBindCLI("--socket", "exact-endpoint", "--cdp-url", bindingTestURL, "--exclusive", "--timeout", "1s")
	if err != nil {
		t.Fatal(err)
	}
	message := <-request
	if message["method"] != "host.bindBrowser" {
		t.Fatal(message)
	}
	params := message["params"].(map[string]any)
	if len(params) != 3 || params["exclusive"] != true || params["cdpURL"] != bindingTestURL || params["timeoutMs"].(float64) > 1000 {
		t.Fatal(params)
	}
	if calls != 1 {
		t.Fatal("CLI retried or discovered")
	}
	var response map[string]any
	if json.Unmarshal([]byte(output), &response) != nil || response["result"].(map[string]any)["bound"] != true {
		t.Fatal(output)
	}
	if err := <-finished; err == nil || err.Error() != "EOF" {
		t.Fatalf("CLI did not close original transport: %v", err)
	}
}

func TestBindBrowserCLIErrorsAreNotReportedAsSuccessfulBinding(t *testing.T) {
	previous := dialLocalEndpoint
	defer func() { dialLocalEndpoint = previous }()
	for _, value := range []map[string]any{{"error": map[string]any{"message": "original rejection"}}, {"result": map[string]any{}}, {"result": map[string]any{"bound": true, "exclusive": true, "behavior": "default"}}} {
		client, server := net.Pipe()
		dialLocalEndpoint = func(string, time.Duration) (net.Conn, error) { return client, nil }
		done := make(chan struct{})
		go func() {
			defer close(done)
			defer server.Close()
			var request map[string]any
			if wire.ReadJSON(server, &request) != nil {
				return
			}
			response := map[string]any{"jsonrpc": "2.0", "id": request["id"]}
			for key, item := range value {
				response[key] = item
			}
			_ = wire.WriteJSON(server, response)
		}()
		output, err := runBindCLI("--socket", "exact", "--cdp-url", bindingTestURL, "--exclusive")
		<-done
		if err == nil || strings.Contains(output, `"bound": true`) {
			t.Fatalf("false CLI success: %s %v", output, err)
		}
	}
}

func TestBindBrowserCLIDialFailureDoesNotDiscoverOrRetry(t *testing.T) {
	previous := dialLocalEndpoint
	defer func() { dialLocalEndpoint = previous }()
	calls := 0
	dialLocalEndpoint = func(endpoint string, _ time.Duration) (net.Conn, error) {
		calls++
		if endpoint != "explicit" {
			t.Error(endpoint)
		}
		return nil, errors.New("exact endpoint absent")
	}
	_, err := runBindCLI("--socket", "explicit", "--cdp-url", bindingTestURL, "--exclusive")
	if err == nil || !strings.Contains(err.Error(), "exact endpoint absent") || calls != 1 {
		t.Fatalf("unexpected retry/failure: %d %v", calls, err)
	}
}

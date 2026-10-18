// JSONL adapter for the managed workflow's public typed Go SDK calls.
// It never discovers another endpoint, recreates a child, or replays input.
package main

import (
	"bufio"
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"net/url"
	"os"
	"path"
	"regexp"
	"runtime"
	"strings"
	"time"

	obu "github.com/ifuryst/open-browser-use/packages/open-browser-use-go"
)

const (
	requestLimit  = 64 * 1024
	responseLimit = 512 * 1024
	requestCount  = 48
)

type request struct {
	ID   int64
	Op   string
	Args json.RawMessage
}

type protocolError struct{ message string }

func (e *protocolError) Error() string { return e.message }
func invalid(message string) error     { return &protocolError{message: message} }

// Reject duplicate keys as well as missing/unknown fields. Every request has
// one interpretation before it can reach the SDK.
func fields(raw []byte, names ...string) (map[string]json.RawMessage, error) {
	decoder := json.NewDecoder(bytes.NewReader(raw))
	start, err := decoder.Token()
	if err != nil || start != json.Delim('{') {
		return nil, invalid("expected an argument object")
	}
	values := map[string]json.RawMessage{}
	for decoder.More() {
		token, err := decoder.Token()
		if err != nil {
			return nil, invalid("invalid object key")
		}
		name, ok := token.(string)
		if !ok {
			return nil, invalid("invalid object key")
		}
		if _, exists := values[name]; exists {
			return nil, invalid("duplicate object field: " + name)
		}
		var value json.RawMessage
		if err := decoder.Decode(&value); err != nil {
			return nil, invalid("invalid object value")
		}
		if bytes.Equal(bytes.TrimSpace(value), []byte("null")) {
			return nil, invalid("null field: " + name)
		}
		values[name] = value
	}
	if token, err := decoder.Token(); err != nil || token != json.Delim('}') {
		return nil, invalid("unterminated object")
	}
	var extra any
	if decoder.Decode(&extra) != io.EOF {
		return nil, invalid("trailing JSON data")
	}
	if len(values) != len(names) {
		return nil, invalid("unexpected argument fields")
	}
	for _, name := range names {
		if _, exists := values[name]; !exists {
			return nil, invalid("missing field: " + name)
		}
	}
	return values, nil
}

func integer(raw json.RawMessage, label string, maximum int64) (int64, error) {
	var value int64
	if json.Unmarshal(raw, &value) != nil || value < 1 || value > maximum {
		return 0, invalid("invalid " + label)
	}
	return value, nil
}

func stringValue(raw json.RawMessage, label string, maximum int) (string, error) {
	var value string
	if json.Unmarshal(raw, &value) != nil || value == "" || len(value) > maximum || strings.ContainsRune(value, 0) {
		return "", invalid("invalid " + label)
	}
	return value, nil
}

// Keep the caller on the explicitly supplied local transport. path.IsAbs uses
// Unix syntax even when the platform-rule tests are running on Windows.
func validateEndpoint(socket, platform string) error {
	if platform == "windows" {
		const prefix = `\\.\pipe\`
		if !strings.HasPrefix(socket, prefix) || len(socket) == len(prefix) {
			return invalid("an explicit Windows named pipe is required")
		}
	} else if !path.IsAbs(socket) {
		return invalid("an explicit absolute Unix socket path is required")
	}
	return nil
}

func duration(raw json.RawMessage) (time.Duration, error) {
	value, err := integer(raw, "timeoutMs", 120000)
	return time.Duration(value) * time.Millisecond, err
}

func decodeRequest(raw []byte) (request, error) {
	var result request
	values, err := fields(raw, "id", "op", "args")
	if err != nil {
		return result, err
	}
	result.ID, err = integer(values["id"], "request id", 9007199254740991)
	if err != nil {
		return result, err
	}
	result.Op, err = stringValue(values["op"], "operation", 40)
	result.Args = values["args"]
	return result, err
}

type caller interface {
	Call(string, json.RawMessage) (any, error)
	Close() error
}

func response(id int64, value any, failure error) ([]byte, error) {
	result := map[string]any{"id": id, "ok": failure == nil}
	if failure == nil {
		result["result"] = value
	} else {
		message := failure.Error()
		if len(message) > 4096 {
			message = message[:4096] + " [truncated]"
		}
		result["error"] = map[string]any{"message": message, "type": fmt.Sprintf("%T", failure)}
	}
	encoded, err := json.Marshal(result)
	if err != nil {
		return nil, err
	}
	if len(encoded)+1 > responseLimit {
		return nil, invalid("response exceeds 512 KiB")
	}
	return append(encoded, '\n'), nil
}

func serve(input io.Reader, output io.Writer, backend caller) (exitCode int) {
	defer func() {
		if err := backend.Close(); err != nil {
			exitCode = 1
			encoded, _ := response(0, nil, err)
			_, _ = output.Write(encoded)
		}
	}()
	scanner := bufio.NewScanner(input)
	scanner.Buffer(make([]byte, 4096), requestLimit+2)
	count := int64(0)
	failed := false
	for scanner.Scan() {
		count++
		raw := scanner.Bytes()
		command, err := decodeRequest(raw)
		if len(raw) > requestLimit {
			err = invalid("request exceeds 64 KiB")
		}
		if count > requestCount {
			err = invalid("request limit exceeded")
		}
		if err == nil && command.ID != count {
			err = invalid("request ids must start at 1 and increase by one")
		}
		if err == nil && failed && command.Op != "cancelPage" && command.Op != "cancelDownload" && command.Op != "close" {
			err = invalid("helper already failed; only original waiter cancellation and close remain available")
		}
		var result any
		if err == nil {
			result, err = backend.Call(command.Op, command.Args)
		}
		if err != nil {
			failed = true
		}
		encoded, encodeErr := response(command.ID, result, err)
		if encodeErr != nil {
			failed = true
			encoded, _ = response(command.ID, nil, encodeErr)
		}
		if n, writeErr := output.Write(encoded); writeErr != nil || n != len(encoded) {
			return 1
		}
		if command.Op == "close" || count > requestCount {
			break
		}
	}
	if err := scanner.Err(); err != nil {
		failed = true
		encoded, _ := response(0, nil, invalid("JSONL input read failed or exceeded 64 KiB"))
		_, _ = output.Write(encoded)
	}
	if failed {
		return 1
	}
	return 0
}

type sdkCaller struct {
	browser      *obu.Browser
	tabs         map[int]*obu.Tab
	pageWait     *obu.PageWait
	downloadWait *obu.DownloadWait
	download     *obu.Download
	closed       bool
	connected    bool
}

func (s *sdkCaller) Close() error {
	if s.closed {
		return nil
	}
	s.closed = true
	if s.browser != nil {
		return s.browser.Close()
	}
	return nil
}

func (s *sdkCaller) tab(raw json.RawMessage) (*obu.Tab, error) {
	id, err := integer(raw, "tabId", 2147483647)
	if err != nil {
		return nil, err
	}
	tab := s.tabs[int(id)]
	if tab == nil {
		return nil, invalid("tab was not created or collected by this caller")
	}
	return tab, nil
}

func (s *sdkCaller) Call(operation string, raw json.RawMessage) (any, error) {
	if operation == "close" {
		if _, err := fields(raw); err != nil {
			return nil, err
		}
		return nil, s.Close()
	}
	if s.closed {
		return nil, invalid("caller is closed")
	}
	if operation == "connect" {
		if s.connected || s.browser != nil {
			return nil, invalid("connect cannot be repeated")
		}
		args, err := fields(raw, "socketPath", "sessionId", "timeoutMs")
		if err != nil {
			return nil, err
		}
		socket, err := stringValue(args["socketPath"], "socketPath", 4096)
		if err != nil {
			return nil, err
		}
		if err := validateEndpoint(socket, runtime.GOOS); err != nil {
			return nil, err
		}
		session, err := stringValue(args["sessionId"], "sessionId", 128)
		if err != nil {
			return nil, err
		}
		if !regexp.MustCompile(`^[a-z][a-z0-9-]{0,127}$`).MatchString(session) {
			return nil, invalid("invalid fixture sessionId")
		}
		timeout, err := duration(args["timeoutMs"])
		if err != nil {
			return nil, err
		}
		s.browser = obu.NewBrowser(obu.NewClient(obu.Options{SocketPath: socket, SessionID: session, Timeout: timeout}))
		s.tabs = map[int]*obu.Tab{}
		if err := s.browser.Connect(); err != nil {
			return nil, err
		}
		state, err := s.browser.Client.BeginTurn()
		if err == nil {
			s.connected = true
		}
		return state, err
	}
	if !s.connected {
		return nil, invalid("connect must succeed before this operation")
	}
	switch operation {
	case "create":
		if _, err := fields(raw); err != nil {
			return nil, err
		}
		if len(s.tabs) != 0 {
			return nil, invalid("the source page is created only once")
		}
		tab, err := s.browser.NewTabWithOptions(obu.NewTabOptions{BackgroundWindow: true})
		if err != nil {
			return nil, err
		}
		s.tabs[tab.ID] = tab
		return map[string]any{"tabId": tab.ID}, nil
	case "goto":
		args, err := fields(raw, "tabId", "url", "timeoutMs")
		if err != nil {
			return nil, err
		}
		tab, err := s.tab(args["tabId"])
		if err != nil {
			return nil, err
		}
		target, err := stringValue(args["url"], "url", 8192)
		if err != nil {
			return nil, err
		}
		parsed, err := url.Parse(target)
		if err != nil || parsed.Scheme != "http" || parsed.Hostname() != "127.0.0.1" || parsed.Port() == "" || parsed.User != nil {
			return nil, invalid("only the loopback fixture URL is accepted")
		}
		timeout, err := duration(args["timeoutMs"])
		if err != nil {
			return nil, err
		}
		return tab.Goto(target, obu.GotoOptions{WaitUntil: obu.LoadStateDOMContentLoaded, Timeout: timeout})
	case "expectPage", "expectDownload":
		args, err := fields(raw, "tabId", "timeoutMs")
		if err != nil {
			return nil, err
		}
		tab, err := s.tab(args["tabId"])
		if err != nil {
			return nil, err
		}
		timeout, err := duration(args["timeoutMs"])
		if err != nil {
			return nil, err
		}
		if operation == "expectPage" {
			if s.pageWait != nil {
				return nil, invalid("the original page waiter is already retained")
			}
			s.pageWait, err = tab.ExpectPage(obu.PageWaitOptions{Timeout: timeout})
			if err != nil {
				return nil, err
			}
			return map[string]any{"waiterId": s.pageWait.WaiterID, "remainingMs": s.pageWait.RemainingMS}, nil
		}
		if s.downloadWait != nil {
			return nil, invalid("the original download waiter is already retained")
		}
		s.downloadWait, err = tab.ExpectDownload(obu.DownloadWaitOptions{Timeout: timeout, RequirePath: true})
		if err != nil {
			return nil, err
		}
		return map[string]any{"waiterId": s.downloadWait.WaiterID, "remainingMs": s.downloadWait.RemainingMS}, nil
	case "collectPage":
		if _, err := fields(raw); err != nil {
			return nil, err
		}
		if s.pageWait == nil {
			return nil, invalid("no original page waiter")
		}
		child, err := s.pageWait.Result()
		if err != nil {
			return nil, err
		}
		if s.tabs[child.ID] != nil {
			return nil, invalid("collected page is not a new child")
		}
		// Keep this exact scope-bound child, never browser.Tab(child.ID).
		s.tabs[child.ID] = child
		return map[string]any{"tabId": child.ID}, nil
	case "cancelPage":
		if _, err := fields(raw); err != nil {
			return nil, err
		}
		if s.pageWait == nil {
			return nil, nil
		}
		err := s.pageWait.Cancel()
		if err == nil {
			s.pageWait = nil
		}
		return nil, err
	case "collectDownload":
		if _, err := fields(raw); err != nil {
			return nil, err
		}
		if s.downloadWait == nil {
			return nil, invalid("no original download waiter")
		}
		download, err := s.downloadWait.Result()
		if err != nil {
			return nil, err
		}
		s.download = download
		return map[string]any{"downloadId": download.DownloadID}, nil
	case "downloadPath":
		args, err := fields(raw, "timeoutMs")
		if err != nil {
			return nil, err
		}
		timeout, err := duration(args["timeoutMs"])
		if err != nil {
			return nil, err
		}
		if s.download == nil {
			return nil, invalid("no original collected download")
		}
		return s.download.Path(obu.DownloadOptions{Timeout: timeout})
	case "cancelDownload":
		if _, err := fields(raw); err != nil {
			return nil, err
		}
		if s.downloadWait == nil {
			return nil, nil
		}
		// Cancel the observer, not the actual download transfer.
		err := s.downloadWait.Cancel()
		if err == nil {
			s.downloadWait = nil
		}
		return nil, err
	case "snapshot":
		args, err := fields(raw, "tabId")
		if err != nil {
			return nil, err
		}
		tab, err := s.tab(args["tabId"])
		if err != nil {
			return nil, err
		}
		return tab.DOMSnapshot()
	case "click", "text", "fill", "waitVisible":
		names := []string{"tabId", "timeoutMs", "selector"}
		if operation == "click" {
			names[2] = "name"
		}
		if operation == "fill" {
			names = append(names, "value")
		}
		args, err := fields(raw, names...)
		if err != nil {
			return nil, err
		}
		tab, err := s.tab(args["tabId"])
		if err != nil {
			return nil, err
		}
		timeout, err := duration(args["timeoutMs"])
		if err != nil {
			return nil, err
		}
		key := "selector"
		if operation == "click" {
			key = "name"
		}
		selector, err := stringValue(args[key], key, 4096)
		if err != nil {
			return nil, err
		}
		options := obu.BrowserActionOptions{Timeout: timeout}
		if operation == "click" {
			return nil, tab.GetByRole("button", obu.RoleOptions{Name: selector, Exact: true}).Click(options)
		}
		locator := tab.Locator(selector)
		switch operation {
		case "text":
			return locator.TextContent(options)
		case "waitVisible":
			return nil, locator.WaitFor("visible", options)
		case "fill":
			value, err := stringValue(args["value"], "value", 16384)
			if err != nil {
				return nil, err
			}
			return nil, locator.Fill(value, options)
		}
	case "tabs":
		if _, err := fields(raw); err != nil {
			return nil, err
		}
		return s.browser.Client.GetTabs()
	case "finalize":
		args, err := fields(raw, "keep")
		if err != nil {
			return nil, err
		}
		var entries []json.RawMessage
		if json.Unmarshal(args["keep"], &entries) != nil || len(entries) != 1 {
			return nil, invalid("keep exactly the original result page")
		}
		entry, err := fields(entries[0], "tabId", "status")
		if err != nil {
			return nil, err
		}
		tab, err := s.tab(entry["tabId"])
		if err != nil {
			return nil, err
		}
		status, err := stringValue(entry["status"], "status", 32)
		if err != nil {
			return nil, err
		}
		if status != "deliverable" {
			return nil, invalid("result must be a deliverable")
		}
		return s.browser.Client.FinalizeTabs([]obu.Params{{"tabId": tab.ID, "status": status}})
	}
	return nil, invalid("unsupported helper operation")
}

func main() { os.Exit(serve(os.Stdin, os.Stdout, &sdkCaller{})) }

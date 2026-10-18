package main

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"reflect"
	"runtime"
	"strings"
	"testing"
)

type fakeCaller struct {
	calls    []string
	closed   bool
	call     func(string) (any, error)
	closeErr error
}

func (f *fakeCaller) Call(op string, _ json.RawMessage) (any, error) {
	f.calls = append(f.calls, op)
	if op == "close" {
		return nil, f.Close()
	}
	if f.call != nil {
		return f.call(op)
	}
	return map[string]any{"original": op}, nil
}
func (f *fakeCaller) Close() error {
	if f.closed {
		return nil
	}
	f.closed = true
	return f.closeErr
}

func line(id int, operation string) string {
	return fmt.Sprintf("{\"id\":%d,\"op\":%q,\"args\":{}}\n", id, operation)
}

func responses(t *testing.T, output *bytes.Buffer) []map[string]any {
	t.Helper()
	var result []map[string]any
	decoder := json.NewDecoder(output)
	for {
		var value map[string]any
		err := decoder.Decode(&value)
		if err == io.EOF {
			return result
		}
		if err != nil {
			t.Fatal(err)
		}
		result = append(result, value)
	}
}

func TestFailureBlocksReplayButPreservesCleanupAndExit(t *testing.T) {
	original := errors.New("original SDK click outcome is unknown")
	backend := &fakeCaller{call: func(op string) (any, error) {
		if op == "click" {
			return nil, original
		}
		return nil, nil
	}}
	input := line(1, "click") + line(2, "click") + line(3, "finalize") + line(4, "cancelPage") + line(5, "cancelDownload") + line(6, "close")
	var output bytes.Buffer
	if code := serve(strings.NewReader(input), &output, backend); code != 1 {
		t.Fatalf("exit %d", code)
	}
	if !reflect.DeepEqual(backend.calls, []string{"click", "cancelPage", "cancelDownload", "close"}) {
		t.Fatal(backend.calls)
	}
	values := responses(t, &output)
	if len(values) != 6 || values[0]["error"].(map[string]any)["message"] != original.Error() {
		t.Fatal(values)
	}
	for _, index := range []int{0, 1, 2} {
		if values[index]["ok"] != false {
			t.Fatal(values[index])
		}
	}
	for _, index := range []int{3, 4, 5} {
		if values[index]["ok"] != true || values[index]["result"] != nil {
			t.Fatal(values[index])
		}
	}
	if !backend.closed {
		t.Fatal("transport not closed")
	}
}

func TestStrictRequestsRejectAmbiguousJSONBeforeSDK(t *testing.T) {
	for _, input := range []string{
		`{"id":1,"id":2,"op":"click","args":{}}`,
		`{"id":1,"op":"click","args":{},"extra":1}`,
		`{"id":1.0,"op":"click","args":{}}`,
		`{"id":0,"op":"click","args":{}}`,
		`{"id":1,"op":"click","args":null}`,
		`{"id":1,"op":"click","args":{}} {}`,
		`{"id":2,"op":"click","args":{}}`,
	} {
		t.Run(input, func(t *testing.T) {
			backend := &fakeCaller{}
			var output bytes.Buffer
			if serve(strings.NewReader(input+"\n"), &output, backend) != 1 || len(backend.calls) != 0 {
				t.Fatal("invalid request reached SDK", backend.calls)
			}
			if values := responses(t, &output); len(values) != 1 || values[0]["ok"] != false {
				t.Fatal(values)
			}
		})
	}
}

func TestRequestLimitNeverDispatchesExtraInput(t *testing.T) {
	var input strings.Builder
	for id := 1; id <= requestCount+1; id++ {
		input.WriteString(line(id, "tabs"))
	}
	backend := &fakeCaller{}
	var output bytes.Buffer
	if serve(strings.NewReader(input.String()), &output, backend) != 1 || len(backend.calls) != requestCount {
		t.Fatal(len(backend.calls))
	}
	values := responses(t, &output)
	if len(values) != requestCount+1 || values[len(values)-1]["ok"] != false {
		t.Fatal("missing limit failure")
	}
}

func TestOversizedInputAndOutputFailWithoutReplay(t *testing.T) {
	t.Run("input", func(t *testing.T) {
		backend := &fakeCaller{}
		var output bytes.Buffer
		input := `{"id":1,"op":"click","args":{"value":"` + strings.Repeat("a", requestLimit) + `"}}` + "\n"
		if serve(strings.NewReader(input), &output, backend) != 1 || len(backend.calls) != 0 {
			t.Fatal("oversized request dispatched")
		}
		if output.Len() > responseLimit {
			t.Fatal("unbounded error")
		}
	})
	t.Run("output", func(t *testing.T) {
		backend := &fakeCaller{call: func(string) (any, error) { return strings.Repeat("x", responseLimit), nil }}
		var output bytes.Buffer
		if serve(strings.NewReader(line(1, "snapshot")+line(2, "click")), &output, backend) != 1 {
			t.Fatal("oversized response accepted")
		}
		if !reflect.DeepEqual(backend.calls, []string{"snapshot"}) {
			t.Fatal("new work after output failure", backend.calls)
		}
		values := responses(t, &output)
		if len(values) != 2 || values[0]["ok"] != false || values[1]["ok"] != false {
			t.Fatal(values)
		}
	})
}

func TestEOFAndCloseTransportOutcomes(t *testing.T) {
	for _, test := range []struct {
		name, input string
		closeErr    error
		code, calls int
	}{
		{"eof", line(1, "tabs"), nil, 0, 1},
		{"close", line(1, "close") + line(2, "click"), nil, 0, 1},
		{"failed-close", line(1, "close"), errors.New("original close failure"), 1, 1},
		{"failed-eof-close", line(1, "tabs"), errors.New("original close failure"), 1, 1},
	} {
		t.Run(test.name, func(t *testing.T) {
			backend := &fakeCaller{closeErr: test.closeErr}
			var output bytes.Buffer
			if code := serve(strings.NewReader(test.input), &output, backend); code != test.code || !backend.closed || len(backend.calls) != test.calls {
				t.Fatal(code, backend)
			}
			if test.closeErr != nil {
				values := responses(t, &output)
				last := values[len(values)-1]
				if last["ok"] != false || last["error"].(map[string]any)["message"] != test.closeErr.Error() {
					t.Fatal("original transport-close error was not preserved", values)
				}
			}
		})
	}
}

func TestSDKValidationCannotDiscoverFallback(t *testing.T) {
	endpoint := `\\.\pipe\fixture`
	if runtime.GOOS != "windows" {
		endpoint = "/tmp/fixture.sock"
	}
	encodedEndpoint, err := json.Marshal(endpoint)
	if err != nil {
		t.Fatal(err)
	}
	for _, input := range []string{
		`{"socketPath":"","sessionId":"task","timeoutMs":15000}`,
		`{"socketPath":"C:/ordinary.sock","sessionId":"task","timeoutMs":15000}`,
		fmt.Sprintf(`{"socketPath":%s,"sessionId":"task","timeoutMs":0}`, encodedEndpoint),
		fmt.Sprintf(`{"socketPath":%s,"sessionId":"task","timeoutMs":15000,"socketDir":"fallback"}`, encodedEndpoint),
	} {
		backend := &sdkCaller{}
		if _, err := backend.Call("connect", json.RawMessage(input)); err == nil || backend.browser != nil {
			t.Fatal("invalid endpoint reached SDK", input)
		}
	}
}

func TestExplicitEndpointRulesForBothPlatforms(t *testing.T) {
	for _, tc := range []struct {
		socket string
		win    bool
		unix   bool
	}{
		{`\\.\pipe\fixture`, true, false},
		{`\\.\pipe\`, false, false},
		{`\\server\pipe\fixture`, false, false},
		{`C:\fixture.sock`, false, false},
		{"C:/fixture.sock", false, false},
		{"/tmp/fixture.sock", false, true},
		{"/private/var/run/fixture.sock", false, true},
		{"fixture.sock", false, false},
		{"./fixture.sock", false, false},
		{"../fixture.sock", false, false},
		{"~/fixture.sock", false, false},
		{"unix:///tmp/fixture.sock", false, false},
		{"", false, false},
	} {
		for _, platform := range []string{"windows", "linux", "darwin"} {
			t.Run(platform+"/"+tc.socket, func(t *testing.T) {
				want := tc.unix
				if platform == "windows" {
					want = tc.win
				}
				if got := validateEndpoint(tc.socket, platform) == nil; got != want {
					t.Fatalf("endpoint accepted = %v, want %v", got, want)
				}
			})
		}
	}
}

func TestUnknownTabAndDuplicateArgumentRejected(t *testing.T) {
	backend := &sdkCaller{connected: true}
	if _, err := backend.Call("snapshot", json.RawMessage(`{"tabId":7}`)); err == nil {
		t.Fatal("unknown tab accepted")
	}
	if _, err := backend.Call("fill", json.RawMessage(`{"tabId":7,"selector":"#x","value":"a","value":"b","timeoutMs":1000}`)); err == nil {
		t.Fatal("duplicate input accepted")
	}
}

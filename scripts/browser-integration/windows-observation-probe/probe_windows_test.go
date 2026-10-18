//go:build windows

package main

import (
	"bytes"
	"encoding/json"
	"errors"
	"io"
	"os"
	"reflect"
	"regexp"
	"runtime"
	"strings"
	"testing"
	"unsafe"

	"golang.org/x/sys/windows"
)

type fakePlatform struct {
	t                                     *testing.T
	queue                                 chan message
	hook, timer                           uintptr
	postReady, killOK, unhookOK, cursorOK bool
	nextResult                            int32
	callback                              func(uintptr, uint32)
	beforeSample                          func()
	samples                               int
	calls                                 []string
	thread                                uint32
}

func platformFixture(t *testing.T) *fakePlatform {
	return &fakePlatform{t: t, queue: make(chan message, 8), hook: 101, timer: 202, postReady: true, killOK: true, unhookOK: true, cursorOK: true, nextResult: 1}
}
func (f *fakePlatform) call(name string) {
	if f.thread == 0 {
		f.thread = windows.GetCurrentThreadId()
	}
	if f.thread != windows.GetCurrentThreadId() {
		f.t.Errorf("%s escaped original native thread", name)
	}
	f.calls = append(f.calls, name)
}
func (f *fakePlatform) createQueue() { f.call("queue") }
func (f *fakePlatform) installHook(callback func(uintptr, uint32)) uintptr {
	f.call("hook")
	f.callback = callback
	callback(303, 7)
	return f.hook
}
func (f *fakePlatform) startTimer(_ uint) uintptr { f.call("timer"); return f.timer }
func (f *fakePlatform) post(kind uint32) bool {
	if kind == wmReady && !f.postReady {
		return false
	}
	f.queue <- message{Message: kind}
	return true
}
func (f *fakePlatform) next() (message, int32) {
	f.call("next")
	if f.nextResult != 1 {
		return message{}, f.nextResult
	}
	return <-f.queue, 1
}
func (f *fakePlatform) identify(hwnd uintptr) foreground {
	pid := uint32(909)
	if hwnd == 0 {
		pid = 0
	}
	return foreground{HWND: "303", PID: &pid}
}
func (f *fakePlatform) foreground() foreground { return f.identify(303) }
func (f *fakePlatform) cursor() (point, bool) {
	f.samples++
	if f.samples == 2 && f.beforeSample != nil {
		f.beforeSample()
	}
	return point{-10, 20}, f.cursorOK
}
func (f *fakePlatform) stopTimer(timer uintptr) bool {
	f.call("kill")
	if timer != 202 {
		f.t.Errorf("wrong original timer %d", timer)
	}
	return f.killOK
}
func (f *fakePlatform) removeHook(hook uintptr) bool {
	f.call("unhook")
	if hook != 101 {
		f.t.Errorf("wrong original hook %d", hook)
	}
	return f.unhookOK
}

func parseRecords(t *testing.T, output *bytes.Buffer) []map[string]any {
	t.Helper()
	var result []map[string]any
	decoder := json.NewDecoder(output)
	for {
		var value map[string]any
		err := decoder.Decode(&value)
		if errors.Is(err, io.EOF) {
			break
		}
		if err != nil {
			t.Fatal(err)
		}
		result = append(result, value)
	}
	return result
}
func errorsIn(records []map[string]any) []string {
	var result []string
	for _, r := range records {
		if r["type"] == "error" {
			result = append(result, r["code"].(string))
		}
	}
	return result
}

func TestStopCommandBoundaries(t *testing.T) {
	for _, tc := range []struct{ input, reason, code string }{
		{`{"operation":"stop"}` + "\n", "stop", ""}, {"", "eof", ""},
		{`{"operation":"stop","operation":"stop"}`, "invalid-command", "INVALID_COMMAND"},
		{`{"operation":"stop","extra":1}`, "invalid-command", "INVALID_COMMAND"},
		{`{"operation":"start"}`, "invalid-command", "INVALID_COMMAND"},
		{`{"operation":null}`, "invalid-command", "INVALID_COMMAND"},
		{`{"operation":"stop"} {}`, "invalid-command", "INVALID_COMMAND"},
		{`[]`, "invalid-command", "INVALID_COMMAND"}, {"\n", "invalid-command", "INVALID_COMMAND"},
		{strings.Repeat("x", 2048), "stdin-error", "STDIN_FAILED"},
	} {
		t.Run(tc.reason+tc.input[:min(len(tc.input), 25)], func(t *testing.T) {
			got := readStop(strings.NewReader(tc.input))
			if got.reason != tc.reason || got.failure != tc.code {
				t.Fatalf("got %+v", got)
			}
		})
	}
}

func TestCLIArgumentsAcceptActualRunnerUUIDAndRejectMalformedOptions(t *testing.T) {
	const id = "aabbccdd-1234-5678-9012-112233445566"
	for _, interval := range []string{"25", "50", "1000"} {
		run, sample, ok := parseOptions([]string{"--run-id", id, "--sample-ms", interval})
		if !ok || run != id || sample < 25 || sample > 1000 {
			t.Fatalf("actual runner options rejected: %q %d %v", run, sample, ok)
		}
	}
	for _, args := range [][]string{
		{}, {"--run-id", "aabbccdd-1234-5678-112233445566"},
		{"--run-id", id, "--sample-ms", "24"}, {"--run-id", id, "--sample-ms", "1001"},
		{"--run-id", id, "--sample-ms", "-1"}, {"--run-id", id, "--unknown"}, {"--run-id", id, "extra"},
	} {
		if _, _, ok := parseOptions(args); ok {
			t.Fatalf("invalid options accepted: %v", args)
		}
	}
}

func TestNativeReadyThenSamplesEventsAndOriginalCleanup(t *testing.T) {
	runtime.LockOSThread()
	defer runtime.UnlockOSThread()
	f := platformFixture(t)
	input, writer := io.Pipe()
	defer writer.Close()
	// The input reader cannot stop us before the first actual timer sample.
	f.queue <- message{Message: wmReady}
	f.queue <- message{Message: wmTimer, WParam: 202}
	f.beforeSample = func() { f.callback(303, 0xffffffff); _, _ = writer.Write([]byte("{\"operation\":\"stop\"}\n")) }
	// postReady is redundant with the queued message; consume it without adding
	// another ready by using a wrapper with the same thread-safe stop delivery.
	p := &readyAlreadyQueued{fakePlatform: f}
	var output bytes.Buffer
	if code := observe(p, input, &output, "test-run", 77, 50); code != 0 {
		t.Fatalf("exit %d: %s", code, output.String())
	}
	r := parseRecords(t, &output)
	if len(r) != 4 || r[0]["type"] != "ready" || r[1]["type"] != "foreground" || r[2]["type"] != "sample" || r[3]["type"] != "stopped" {
		t.Fatalf("record order %+v", r)
	}
	if r[0]["preReadyEvents"] != float64(1) || r[3]["complete"] != true || r[3]["samples"] != float64(1) || r[3]["foregroundEvents"] != float64(1) {
		t.Fatalf("wrong receipts %+v", r)
	}
	if !reflect.DeepEqual(f.calls[len(f.calls)-2:], []string{"kill", "unhook"}) {
		t.Fatal(f.calls)
	}
	for i, row := range r {
		if row["sequence"] != float64(i+1) || row["observerPID"] != float64(77) {
			t.Fatal(row)
		}
	}
}

type readyAlreadyQueued struct{ *fakePlatform }

func (f *readyAlreadyQueued) post(kind uint32) bool {
	if kind == wmReady {
		return true
	}
	return f.fakePlatform.post(kind)
}

func TestNativeFailuresAlwaysReleaseOwnedResources(t *testing.T) {
	for _, tc := range []struct {
		name    string
		change  func(*fakePlatform)
		codes   []string
		cleanup []string
	}{
		{"hook", func(f *fakePlatform) { f.hook = 0 }, []string{"HOOK_INSTALL_FAILED"}, nil},
		{"timer", func(f *fakePlatform) { f.timer = 0 }, []string{"TIMER_INSTALL_FAILED"}, []string{"unhook"}},
		{"ready-post", func(f *fakePlatform) { f.postReady = false }, []string{"READY_POST_FAILED"}, []string{"kill", "unhook"}},
		{"message-error", func(f *fakePlatform) { f.nextResult = -1 }, []string{"MESSAGE_LOOP_FAILED"}, []string{"kill", "unhook"}},
		{"quit", func(f *fakePlatform) { f.nextResult = 0 }, []string{"UNEXPECTED_QUIT"}, []string{"kill", "unhook"}},
		{"initial-sample", func(f *fakePlatform) { f.cursorOK = false }, []string{"CURSOR_SAMPLE_FAILED"}, []string{"kill", "unhook"}},
		{"failure-and-both-cleanups", func(f *fakePlatform) { f.cursorOK = false; f.killOK = false; f.unhookOK = false }, []string{"CURSOR_SAMPLE_FAILED", "TIMER_CLEANUP_FAILED", "HOOK_CLEANUP_FAILED"}, []string{"kill", "unhook"}},
	} {
		t.Run(tc.name, func(t *testing.T) {
			runtime.LockOSThread()
			defer runtime.UnlockOSThread()
			f := platformFixture(t)
			tc.change(f)
			var out bytes.Buffer
			if code := observe(f, io.NopCloser(strings.NewReader("")), &out, "test-run", 77, 50); code != 1 {
				t.Fatalf("failure exited %d", code)
			}
			rows := parseRecords(t, &out)
			if !reflect.DeepEqual(errorsIn(rows), tc.codes) {
				t.Fatalf("wrong failures %+v", rows)
			}
			for _, row := range rows {
				if row["type"] == "ready" || row["complete"] == true {
					t.Fatal("false readiness/cleanup", row)
				}
			}
			var cleaned []string
			for _, c := range f.calls {
				if c == "kill" || c == "unhook" {
					cleaned = append(cleaned, c)
				}
			}
			if !reflect.DeepEqual(cleaned, tc.cleanup) {
				t.Fatal(f.calls)
			}
		})
	}
}

type failedWriter struct{}

func (failedWriter) Write([]byte) (int, error) { return 0, errors.New("closed sink") }
func TestFailedOutputCannotSkipNativeCleanup(t *testing.T) {
	runtime.LockOSThread()
	defer runtime.UnlockOSThread()
	f := platformFixture(t)
	if observe(f, io.NopCloser(strings.NewReader("")), failedWriter{}, "test-run", 77, 50) != 1 {
		t.Fatal("output failure passed")
	}
	if !reflect.DeepEqual(f.calls[len(f.calls)-2:], []string{"kill", "unhook"}) {
		t.Fatal(f.calls)
	}
}

func TestPostReadyStopAndCleanupFailures(t *testing.T) {
	for _, tc := range []struct {
		name, input      string
		killOK, unhookOK bool
		wantExit         int
		codes            []string
	}{
		{"explicit-stop", "{\"operation\":\"stop\"}\n", true, true, 0, nil},
		{"stdin-eof", "", true, true, 0, nil},
		{"invalid-command", "{\"operation\":\"resume\"}\n", true, true, 1, []string{"INVALID_COMMAND"}},
		{"cleanup-failures", "{\"operation\":\"stop\"}\n", false, false, 1, []string{"TIMER_CLEANUP_FAILED", "HOOK_CLEANUP_FAILED"}},
	} {
		t.Run(tc.name, func(t *testing.T) {
			runtime.LockOSThread()
			defer runtime.UnlockOSThread()
			f := platformFixture(t)
			f.killOK, f.unhookOK = tc.killOK, tc.unhookOK
			var out bytes.Buffer
			if exit := observe(f, io.NopCloser(strings.NewReader(tc.input)), &out, "test-run", 77, 50); exit != tc.wantExit {
				t.Fatalf("exit %d", exit)
			}
			rows := parseRecords(t, &out)
			if rows[0]["type"] != "ready" || rows[len(rows)-1]["type"] != "stopped" {
				t.Fatal(rows)
			}
			if !reflect.DeepEqual(errorsIn(rows), tc.codes) {
				t.Fatal(rows)
			}
			last := rows[len(rows)-1]
			if last["complete"] != (tc.wantExit == 0) || last["hookRemoved"] != tc.unhookOK || last["timerKilled"] != tc.killOK {
				t.Fatal(last)
			}
		})
	}
}

func TestPostReadySampleFailureJoinsBlockedReaderAndReleasesHook(t *testing.T) {
	runtime.LockOSThread()
	defer runtime.UnlockOSThread()
	f := platformFixture(t)
	input, writer := io.Pipe()
	defer writer.Close()
	f.queue <- message{Message: wmReady}
	f.queue <- message{Message: wmTimer, WParam: 202}
	f.beforeSample = func() { f.cursorOK = false }
	var out bytes.Buffer
	if observe(&readyAlreadyQueued{f}, input, &out, "test-run", 77, 50) != 1 {
		t.Fatal("sample failure passed")
	}
	rows := parseRecords(t, &out)
	if !reflect.DeepEqual(errorsIn(rows), []string{"CURSOR_SAMPLE_FAILED"}) || rows[len(rows)-1]["complete"] != false {
		t.Fatal(rows)
	}
	if !reflect.DeepEqual(f.calls[len(f.calls)-2:], []string{"kill", "unhook"}) {
		t.Fatal(f.calls)
	}
}

func TestNativeSurfaceAndWindowsMessageLayout(t *testing.T) {
	data, err := os.ReadFile("main_windows.go")
	if err != nil {
		t.Fatal(err)
	}
	var names []string
	for _, m := range regexp.MustCompile(`NewProc\("([^"]+)"\)`).FindAllStringSubmatch(string(data), -1) {
		names = append(names, m[1])
	}
	want := []string{"GetForegroundWindow", "GetWindowThreadProcessId", "GetCursorPos", "SetWinEventHook", "UnhookWinEvent", "PeekMessageW", "GetMessageW", "PostThreadMessageW", "SetTimer", "KillTimer"}
	if !reflect.DeepEqual(names, want) {
		t.Fatalf("unexpected native capability surface: %v", names)
	}
	if runtime.GOARCH == "amd64" && unsafe.Sizeof(message{}) != 48 {
		t.Fatalf("wrong Win64 MSG layout %d", unsafe.Sizeof(message{}))
	}
	if !strings.Contains(string(data), "setHook.Call(foregroundEvent, foregroundEvent, 0, p.callback, 0, 0, 0)") {
		t.Fatal("hook widened beyond exact foreground events")
	}
}

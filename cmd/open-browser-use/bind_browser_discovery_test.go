package main

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/ifuryst/open-browser-use/internal/transport"
	"github.com/ifuryst/open-browser-use/internal/wire"
)

func executeBindContext(ctx context.Context, args ...string) (string, string, error) {
	command := newRootCommand()
	var output, diagnostic bytes.Buffer
	command.SetOut(&output)
	command.SetErr(&diagnostic)
	command.SetArgs(append([]string{"bind-browser"}, args...))
	err := command.ExecuteContext(ctx)
	return output.String(), diagnostic.String(), err
}

func TestBindPortFileStrictTwoLineFormat(t *testing.T) {
	for _, value := range []string{"9222\n/devtools/browser/exact", "9222\n/devtools/browser/exact\n", "9222\r\n/devtools/browser/exact", "9222\r\n/devtools/browser/exact\r\n"} {
		if got, err := parseBindPortFile([]byte(value)); err != nil || got != bindingTestURL {
			t.Fatalf("valid original port file rejected: %q, %q %v", value, got, err)
		}
	}
	for _, value := range []string{"", "0\n/devtools/browser/exact", "65536\n/devtools/browser/exact", "09222\n/devtools/browser/exact", "+9222\n/devtools/browser/exact",
		"9222 \n/devtools/browser/exact", " 9222\n/devtools/browser/exact", "9222\r/devtools/browser/exact", "9222\n/devtools/browser/exact\n\n",
		"9222\n/devtools/browser/exact\nthird", "9222\n/devtools/page/exact", "9222\nws://127.0.0.1:9222/devtools/browser/exact", "9222\n/devtools/browser/",
		"9222\n/devtools/browser/exact?query=1", "9222\n/devtools/browser/exact#fragment", "9222\n/devtools/browser/exact/other", "9222\n/devtools/browser/exact%2Fother",
		"9222\n/devtools/browser/exact\x00", "9222\n/devtools/browser/exact\r", "9222\n/devtools/browser/" + strings.Repeat("x", 257), strings.Repeat("x", 4097)} {
		if _, err := parseBindPortFile([]byte(value)); err == nil {
			t.Errorf("invalid file accepted: %q", value)
		}
	}
}

func TestBindBrowserAutoRejectsInvalidArgumentsBeforeReadingOrDialing(t *testing.T) {
	previousRead, previousDial := readBindPortFile, dialLocalEndpoint
	t.Cleanup(func() { readBindPortFile, dialLocalEndpoint = previousRead, previousDial })
	var reads, dials atomic.Int32
	readBindPortFile = func(context.Context, string) (string, error) { reads.Add(1); return "", errors.New("must not read") }
	dialLocalEndpoint = func(string, time.Duration) (net.Conn, error) { dials.Add(1); return nil, errors.New("must not dial") }
	base := []string{"--socket", "exact", "--exclusive"}
	for _, flags := range [][]string{
		{"--auto-connect"}, {"--auto-connect", "--browser", "chrome-beta"}, {"--auto-connect", "--browser", "brave"}, {"--auto-connect", "--browser", "Chrome"},
		{"--auto-connect", "--browser", "chrome", "--cdp-url", bindingTestURL}, {"--auto-connect", "--browser", "chrome", "--cdp-url="},
		{"--cdp-url", bindingTestURL, "--browser", "chrome"}, {"--cdp-url", bindingTestURL, "--user-data-dir", t.TempDir()},
		{"--auto-connect=false", "--browser", "edge"}, {"--auto-connect", "--browser", "edge", "--user-data-dir", "relative"},
		{"--auto-connect", "--browser", "edge", "--user-data-dir="}, {"--auto-connect", "--browser", "edge", "--timeout", "121s"},
		{"--auto-connect", "--browser", "edge", "--timeout", "0s"}, {"--auto-connect", "--browser", "edge", "--exclusive=false"},
	} {
		if _, _, err := executeBindContext(context.Background(), append(append([]string{}, base...), flags...)...); err == nil {
			t.Errorf("invalid CLI flags accepted: %v", flags)
		}
	}
	if runtime.GOOS == "windows" {
		for _, root := range []string{`\\server\share\profile`, `\\?\C:\profile`, `\\.\pipe\profile`, `//server/share/profile`} {
			if _, _, err := executeBindContext(context.Background(), append(append([]string{}, base...), "--auto-connect", "--browser", "chrome", "--user-data-dir", root)...); err == nil {
				t.Errorf("network/device root accepted: %q", root)
			}
		}
	}
	if reads.Load() != 0 || dials.Load() != 0 {
		t.Fatalf("invalid flags touched discovery or IPC: reads=%d dials=%d", reads.Load(), dials.Load())
	}
}

func writeBindPortFile(t *testing.T, root, text string) string {
	t.Helper()
	if err := os.MkdirAll(root, 0700); err != nil {
		t.Fatal(err)
	}
	path := filepath.Join(root, "DevToolsActivePort")
	if err := os.WriteFile(path, []byte(text), 0600); err != nil {
		t.Fatal(err)
	}
	return path
}

func TestBindBrowserAutoPublicCLIUsesOnlySelectedRootAndNativeEndpoint(t *testing.T) {
	isolatedBrowserHome(t)
	for _, test := range []struct {
		browser string
		custom  bool
	}{{"chrome", false}, {"edge", false}, {"edge", true}} {
		t.Run(fmt.Sprintf("%s/custom-%v", test.browser, test.custom), func(t *testing.T) {
			root, err := bindBrowserRoot(test.browser, "", false)
			if err != nil {
				t.Fatal(err)
			}
			if test.custom {
				root = t.TempDir()
			}
			writeBindPortFile(t, root, "9222\r\n/devtools/browser/exact\r\n")
			// These unrelated files must never be considered endpoint/profile input.
			if err := os.WriteFile(filepath.Join(root, "Preferences"), []byte("invalid profile JSON"), 0600); err != nil {
				t.Fatal(err)
			}
			endpoint := filepath.Join(socketTestTempRoot(), fmt.Sprintf("obu-bind-%d.sock", time.Now().UnixNano()))
			if runtime.GOOS == "windows" {
				endpoint = fmt.Sprintf(`\\.\pipe\obu-bind-%d`, time.Now().UnixNano())
			}
			listener, err := transport.Listen(endpoint)
			if err != nil {
				t.Fatal(err)
			}
			t.Cleanup(func() { _ = listener.Close(); _ = transport.RemoveEndpoint(endpoint) })
			completed := make(chan error, 1)
			go func() {
				conn, err := listener.Accept()
				if err != nil {
					completed <- err
					return
				}
				defer conn.Close()
				_ = conn.SetDeadline(time.Now().Add(3 * time.Second))
				var request map[string]any
				if err := wire.ReadJSON(conn, &request); err != nil {
					completed <- err
					return
				}
				params, ok := request["params"].(map[string]any)
				budget, budgetOK := params["timeoutMs"].(float64)
				if !ok || !budgetOK || request["method"] != "host.bindBrowser" || len(params) != 3 || params["cdpURL"] != bindingTestURL || params["exclusive"] != true || budget < 58000 || budget > 60000 {
					completed <- fmt.Errorf("wrong bind request/scope/budget: %v", request)
					return
				}
				encoded, _ := json.Marshal(params)
				t.Logf("actual original native IPC request params=%s", encoded)
				if err := wire.WriteJSON(conn, map[string]any{"jsonrpc": "2.0", "id": request["id"], "result": bindCLIResult()}); err != nil {
					completed <- err
					return
				}
				var extra map[string]any
				if err := wire.ReadJSON(conn, &extra); !errors.Is(err, io.EOF) {
					completed <- fmt.Errorf("CLI replayed or failed to close: %v %v", extra, err)
					return
				}
				completed <- nil
			}()
			args := []string{"--socket", endpoint, "--auto-connect", "--browser", test.browser, "--exclusive"}
			if test.custom {
				args = append(args, "--user-data-dir", root)
			}
			started := time.Now()
			stdout, stderr, err := executeBindContext(context.Background(), args...)
			elapsed := time.Since(started)
			if err != nil {
				t.Fatal(err)
			}
			if !strings.Contains(stderr, "Allow the remote debugging connection in "+test.browser) {
				t.Fatal("missing stderr approval guidance", stderr)
			}
			var response map[string]any
			if json.Unmarshal([]byte(stdout), &response) != nil || response["result"].(map[string]any)["bound"] != true {
				t.Fatal("stdout is not the original JSON acknowledgement", stdout)
			}
			select {
			case err := <-completed:
				if err != nil {
					t.Fatal(err)
				}
			case <-time.After(4 * time.Second):
				t.Fatal("original CLI IPC connection did not close")
			}
			t.Logf("actual public CLI binding duration=%v; original connection EOF confirmed", elapsed)
		})
	}
}

func TestBindBrowserAutoBadPortFileNeverFallsBackOrDials(t *testing.T) {
	isolatedBrowserHome(t)
	validOther, _ := bindBrowserRoot("chrome", "", false)
	writeBindPortFile(t, validOther, "9222\n/devtools/browser/must-not-discover")
	previous := dialLocalEndpoint
	t.Cleanup(func() { dialLocalEndpoint = previous })
	var calls atomic.Int32
	dialLocalEndpoint = func(string, time.Duration) (net.Conn, error) { calls.Add(1); return nil, errors.New("must not dial") }
	for _, kind := range []string{"missing", "directory", "oversize", "malformed", "symlink"} {
		t.Run(kind, func(t *testing.T) {
			root := t.TempDir()
			path := filepath.Join(root, "DevToolsActivePort")
			switch kind {
			case "directory":
				if err := os.Mkdir(path, 0700); err != nil {
					t.Fatal(err)
				}
			case "oversize":
				writeBindPortFile(t, root, strings.Repeat("x", bindPortFileLimit+1))
			case "malformed":
				writeBindPortFile(t, root, "9222\n/devtools/page/not-browser")
			case "symlink":
				if err := os.Symlink(filepath.Join(validOther, "DevToolsActivePort"), path); err != nil {
					t.Skipf("symlink creation unavailable: %v", err)
				}
			}
			stdout, _, err := executeBindContext(context.Background(), "--socket", "must-not-dial", "--exclusive", "--auto-connect", "--browser", "edge", "--user-data-dir", root)
			if err == nil || stdout != "" {
				t.Fatalf("invalid original file accepted: %q %v", stdout, err)
			}
		})
	}
	if calls.Load() != 0 {
		t.Fatal("bad original file discovered another profile or dialed", calls.Load())
	}
}

func TestBindBrowserCancelledSlowDiscoveryHasOneReaderAndNoLateDial(t *testing.T) {
	previousRead, previousDial := readBindPortFile, dialLocalEndpoint
	t.Cleanup(func() { readBindPortFile, dialLocalEndpoint = previousRead, previousDial })
	entered, release := make(chan struct{}), make(chan struct{})
	var once sync.Once
	t.Cleanup(func() { once.Do(func() { close(release) }) })
	var reads, dials atomic.Int32
	readBindPortFile = func(context.Context, string) (string, error) {
		reads.Add(1)
		close(entered)
		<-release
		return bindingTestURL, nil
	}
	dialLocalEndpoint = func(string, time.Duration) (net.Conn, error) { dials.Add(1); return nil, errors.New("must not dial") }
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	done := make(chan error, 1)
	root := t.TempDir()
	go func() {
		_, _, err := executeBindContext(ctx, "--socket", "must-not-dial", "--exclusive", "--auto-connect", "--browser", "edge", "--user-data-dir", root)
		done <- err
	}()
	<-entered
	cancel()
	select {
	case err := <-done:
		if !errors.Is(err, context.Canceled) {
			t.Fatal(err)
		}
	case <-time.After(time.Second):
		t.Fatal("filesystem wait ignored cancellation")
	}
	if _, err := discoverBindBrowser(context.Background(), root); err == nil || !strings.Contains(err.Error(), "still busy") {
		t.Fatal("started an unbounded second reader", err)
	}
	once.Do(func() { close(release) })
	end := time.Now().Add(time.Second)
	for len(bindPortFileReader) != 0 && time.Now().Before(end) {
		time.Sleep(time.Millisecond)
	}
	if len(bindPortFileReader) != 0 || reads.Load() != 1 || dials.Load() != 0 {
		t.Fatalf("late discovery leaked/replayed: readers=%d reads=%d dials=%d", len(bindPortFileReader), reads.Load(), dials.Load())
	}
}

func TestBindBrowserDiscoverySharesOriginalBudgetAndRejectsLateResult(t *testing.T) {
	previousRead, previousDial := readBindPortFile, dialLocalEndpoint
	t.Cleanup(func() { readBindPortFile, dialLocalEndpoint = previousRead, previousDial })
	root := t.TempDir()
	readBindPortFile = func(ctx context.Context, path string) (string, error) {
		deadline, _ := ctx.Deadline()
		if path != filepath.Join(root, "DevToolsActivePort") || time.Until(deadline) > 300*time.Millisecond {
			t.Error("discovery changed path or reset budget")
		}
		time.Sleep(80 * time.Millisecond)
		return bindingTestURL, nil
	}
	var dialBudget time.Duration
	dialLocalEndpoint = func(_ string, timeout time.Duration) (net.Conn, error) {
		dialBudget = timeout
		return nil, errors.New("original dial failure")
	}
	_, _, err := executeBindContext(context.Background(), "--socket", "exact", "--exclusive", "--auto-connect", "--browser", "edge", "--user-data-dir", root, "--timeout", "300ms")
	if err == nil || !strings.Contains(err.Error(), "original dial failure") || dialBudget <= 0 || dialBudget > 240*time.Millisecond {
		t.Fatalf("discovery did not consume original budget: %v %v", dialBudget, err)
	}
	readBindPortFile = func(ctx context.Context, _ string) (string, error) { <-ctx.Done(); return bindingTestURL, nil }
	dialBudget = 0
	stdout, _, err := executeBindContext(context.Background(), "--socket", "exact", "--exclusive", "--auto-connect", "--browser", "edge", "--user-data-dir", root, "--timeout", "20ms")
	if !errors.Is(err, context.DeadlineExceeded) || stdout != "" || dialBudget != 0 {
		t.Fatalf("late discovery was submitted: %q %v %v", stdout, dialBudget, err)
	}
	end := time.Now().Add(time.Second)
	for len(bindPortFileReader) != 0 && time.Now().Before(end) {
		time.Sleep(time.Millisecond)
	}
}

func TestBindBrowserCancellationClosesOriginalIPC(t *testing.T) {
	previous := dialLocalEndpoint
	t.Cleanup(func() { dialLocalEndpoint = previous })
	client, server := net.Pipe()
	defer server.Close()
	dialLocalEndpoint = func(string, time.Duration) (net.Conn, error) { return client, nil }
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	done := make(chan error, 1)
	go func() {
		output, _, err := executeBindContext(ctx, "--socket", "exact", "--exclusive", "--cdp-url", bindingTestURL)
		if output != "" {
			done <- errors.New("cancelled binding printed success")
			return
		}
		done <- err
	}()
	_ = server.SetDeadline(time.Now().Add(2 * time.Second))
	var request map[string]any
	if err := wire.ReadJSON(server, &request); err != nil {
		t.Fatal(err)
	}
	cancel()
	select {
	case err := <-done:
		if !errors.Is(err, context.Canceled) {
			t.Fatal(err)
		}
	case <-time.After(time.Second):
		t.Fatal("IPC ignored context cancellation")
	}
	if err := wire.ReadJSON(server, &request); !errors.Is(err, io.EOF) {
		t.Fatal("original IPC remained open", err)
	}
}

func TestBindBrowserManualKeepsTenSecondDefault(t *testing.T) {
	previous := dialLocalEndpoint
	t.Cleanup(func() { dialLocalEndpoint = previous })
	var budget time.Duration
	dialLocalEndpoint = func(_ string, timeout time.Duration) (net.Conn, error) {
		budget = timeout
		return nil, errors.New("original dial failure")
	}
	stdout, stderr, err := executeBindContext(context.Background(), "--socket", "exact", "--exclusive", "--cdp-url", bindingTestURL)
	if err == nil || !strings.Contains(err.Error(), "original dial failure") || stdout != "" || stderr != "" || budget <= 9*time.Second || budget > 10*time.Second {
		t.Fatalf("manual defaults changed: budget=%v out=%q errout=%q err=%v", budget, stdout, stderr, err)
	}
}

func TestBindBrowserCancelledDialClosesLateConnectionWithoutSubmitting(t *testing.T) {
	previous := dialLocalEndpoint
	t.Cleanup(func() { dialLocalEndpoint = previous })
	client, server := net.Pipe()
	defer server.Close()
	defer client.Close()
	entered, release := make(chan struct{}), make(chan struct{})
	var once sync.Once
	defer once.Do(func() { close(release) })
	dialLocalEndpoint = func(string, time.Duration) (net.Conn, error) { close(entered); <-release; return client, nil }
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	done := make(chan error, 1)
	go func() {
		_, _, err := executeBindContext(ctx, "--socket", "exact", "--exclusive", "--cdp-url", bindingTestURL)
		done <- err
	}()
	<-entered
	cancel()
	select {
	case err := <-done:
		if !errors.Is(err, context.Canceled) {
			t.Fatal(err)
		}
	case <-time.After(time.Second):
		t.Fatal("exact IPC dial ignored cancellation")
	}
	once.Do(func() { close(release) })
	_ = server.SetDeadline(time.Now().Add(time.Second))
	var request map[string]any
	if err := wire.ReadJSON(server, &request); !errors.Is(err, io.EOF) {
		t.Fatal("late connection was submitted or left open", request, err)
	}
}

type bindDeadlineOnlyContext struct {
	context.Context
	deadline time.Time
}

func (c bindDeadlineOnlyContext) Deadline() (time.Time, bool) { return c.deadline, true }

type bindIgnoringDeadlineConn struct{ net.Conn }

func (c bindIgnoringDeadlineConn) SetDeadline(time.Time) error { return nil }

func TestBindBrowserLateAcknowledgementCannotPrintSuccess(t *testing.T) {
	previous := dialLocalEndpoint
	t.Cleanup(func() { dialLocalEndpoint = previous })
	client, server := net.Pipe()
	defer server.Close()
	dialLocalEndpoint = func(string, time.Duration) (net.Conn, error) { return bindIgnoringDeadlineConn{client}, nil }
	deadline := time.Now().Add(100 * time.Millisecond)
	ctx := bindDeadlineOnlyContext{context.Background(), deadline}
	done := make(chan error, 1)
	go func() {
		_ = server.SetDeadline(time.Now().Add(2 * time.Second))
		var request map[string]any
		if err := wire.ReadJSON(server, &request); err != nil {
			done <- err
			return
		}
		time.Sleep(max(0, time.Until(deadline)) + 10*time.Millisecond)
		if err := wire.WriteJSON(server, map[string]any{"jsonrpc": "2.0", "id": request["id"], "result": bindCLIResult()}); err != nil {
			done <- err
			return
		}
		if err := wire.ReadJSON(server, &request); !errors.Is(err, io.EOF) {
			done <- fmt.Errorf("late ACK kept original connection open: %v", err)
			return
		}
		done <- nil
	}()
	stdout, _, err := executeBindContext(ctx, "--socket", "exact", "--exclusive", "--cdp-url", bindingTestURL)
	if !errors.Is(err, context.DeadlineExceeded) || stdout != "" {
		t.Fatalf("late success escaped original deadline: %q %v", stdout, err)
	}
	if err := <-done; err != nil {
		t.Fatal(err)
	}
}

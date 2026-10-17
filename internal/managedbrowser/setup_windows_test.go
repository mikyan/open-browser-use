//go:build windows

package managedbrowser

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net"
	"net/http"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/coder/websocket"
	"golang.org/x/sys/windows"
)

const setupHelperEnvironment = "OBU_MANAGED_SETUP_TEST_HELPER"

// This helper is the test executable with a small CDP-shaped local server. It
// tests the real process/Job/session lifecycle, not Chromium or login behavior.
func init() {
	if mode := os.Getenv(setupHelperEnvironment); mode != "" && len(os.Args) > 1 && os.Args[1] == "--enable-automation" {
		os.Exit(runSetupHelper(mode))
	}
}

func runSetupHelper(mode string) int {
	var profile string
	for _, arg := range os.Args[1:] {
		if strings.HasPrefix(arg, "--user-data-dir=") {
			profile = strings.TrimPrefix(arg, "--user-data-dir=")
		}
	}
	if profile == "" {
		return 91
	}
	runDir, err := os.Getwd()
	if err != nil {
		return 92
	}
	write := func(name string, value any) {
		data, _ := json.Marshal(value)
		if os.WriteFile(filepath.Join(runDir, name), data, 0600) != nil {
			os.Exit(93)
		}
	}
	var startup windows.StartupInfo
	if windows.GetStartupInfo(&startup) != nil {
		return 94
	}
	write("helper-startup.json", map[string]any{"flags": startup.Flags, "showWindow": startup.ShowWindow, "temp": os.Getenv("TEMP"), "userProfile": os.Getenv("USERPROFILE"), "pid": os.Getpid()})
	fmt.Fprintln(os.Stderr, "test-only-login-query-secret=must-not-be-recorded")
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		return 95
	}
	defer listener.Close()
	var mu sync.Mutex
	var methods []string
	exit := make(chan struct{})
	var exitOnce sync.Once
	server := &http.Server{Handler: http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/devtools/browser/setup-helper" {
			http.NotFound(w, r)
			return
		}
		conn, err := websocket.Accept(w, r, nil)
		if err != nil {
			return
		}
		defer conn.CloseNow()
		for {
			_, data, err := conn.Read(context.Background())
			if err != nil {
				return
			}
			var request struct {
				ID     int64  `json:"id"`
				Method string `json:"method"`
			}
			if json.Unmarshal(data, &request) != nil {
				return
			}
			mu.Lock()
			methods = append(methods, request.Method)
			write("helper-methods.json", methods)
			mu.Unlock()
			var result any
			switch request.Method {
			case "Browser.getVersion":
				product := "Chrome/helper"
				if mode == "bad-identity" {
					product = "Other/helper"
				}
				result = map[string]any{"product": product, "protocolVersion": "1.3", "revision": "helper"}
			case "Browser.getBrowserCommandLine":
				result = map[string]any{"arguments": os.Args}
			case "Browser.close":
				result = map[string]any{}
			default:
				os.Exit(96)
			}
			response, _ := json.Marshal(map[string]any{"id": request.ID, "result": result})
			if conn.Write(context.Background(), websocket.MessageText, response) != nil {
				return
			}
			if request.Method == "Browser.close" {
				write("helper-close-ack.json", true)
				if mode != "gated" {
					exitOnce.Do(func() { close(exit) })
				}
			}
		}
	})}
	go server.Serve(listener)
	defer server.Close()
	port := listener.Addr().(*net.TCPAddr).Port
	if os.WriteFile(filepath.Join(profile, "DevToolsActivePort"), []byte(strconv.Itoa(port)+"\n/devtools/browser/setup-helper\n"), 0600) != nil {
		return 97
	}
	deadline := time.NewTimer(30 * time.Second)
	defer deadline.Stop()
	tick := time.NewTicker(10 * time.Millisecond)
	defer tick.Stop()
	for {
		select {
		case <-exit:
			return 0
		case <-deadline.C:
			return 98
		case <-tick.C:
			if _, err := os.Stat(filepath.Join(runDir, "helper-release")); err == nil {
				if mode == "natural-nonzero" {
					return 9
				}
				return 0
			}
		}
	}
}

func setupTestConfig(t *testing.T, mode string) SetupConfig {
	t.Helper()
	t.Setenv(setupHelperEnvironment, mode)
	self, err := os.Executable()
	if err != nil {
		t.Fatal(err)
	}
	return SetupConfig{Root: filepath.Join(t.TempDir(), "managed"), Name: "setup-test", BrowserPath: self, StartupTimeout: 3 * time.Second}
}

func startSetupTest(t *testing.T, config SetupConfig) *Session {
	t.Helper()
	s, err := StartSetup(context.Background(), config)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
		defer cancel()
		_ = s.Close(ctx)
	})
	return s
}

func readSetupLifecycle(t *testing.T, s *Session) lifecycle {
	t.Helper()
	var record lifecycle
	data, err := os.ReadFile(filepath.Join(s.info.RunDir, "lifecycle.json"))
	if err != nil || json.Unmarshal(data, &record) != nil {
		t.Fatalf("lifecycle: %v %s", err, data)
	}
	return record
}

func assertSetupClosed(t *testing.T, s *Session, natural bool) {
	t.Helper()
	record := readSetupLifecycle(t, s)
	var job struct {
		ActiveProcesses *uint32 `json:"activeProcesses"`
	}
	if record.JobEmpty != nil {
		_ = json.Unmarshal(record.JobEmpty.Result, &job)
	}
	if record.State != "closed" || record.Forced || record.BrowserExit == nil || record.BrowserExit.Code == nil || *record.BrowserExit.Code != 0 || record.JobEmpty == nil || job.ActiveProcesses == nil || *job.ActiveProcesses != 0 {
		t.Fatalf("missing real cleanup receipts: %+v", record)
	}
	if record.NativeDescriptor != nil || record.NativeExit != nil || record.RegistrationCleanup != nil || record.EndpointCleanup != nil || len(record.Binding) != 0 {
		t.Fatal("setup invented a task lifecycle")
	}
	if natural {
		if record.BrowserClose != nil || record.CloseReason != "browser-exited" {
			t.Fatalf("natural close invented command: %+v", record)
		}
	} else if record.BrowserClose == nil || record.BrowserClose.Error != "" || string(record.BrowserClose.Result) != "{}" || record.CloseReason != "requested" {
		t.Fatalf("explicit close missing ACK: %+v", record)
	}
}

func TestSetupOwnsProfileWithoutTaskEndpointAndUsesVisibleStartup(t *testing.T) {
	config := setupTestConfig(t, "close")
	s := startSetupTest(t, config)
	info := s.Info()
	if info.Mode != "setup" || info.SocketPath != "" || info.NativeHostName != "" || info.NativePID != 0 || info.ExtensionID != "" || s.registration != nil || s.endpointDir != "" {
		t.Fatalf("setup published task identity: %+v", info)
	}
	if _, err := s.OpenUserController(context.Background()); err == nil {
		t.Fatal("setup exposed viewer controller")
	}
	var startup struct {
		Flags             uint32
		ShowWindow        uint16
		Temp, UserProfile string
		PID               int
	}
	awaitPlatformJSON(t, filepath.Join(info.RunDir, "helper-startup.json"), &startup)
	if startup.ShowWindow != windows.SW_SHOWNORMAL || startup.Flags&windows.STARTF_USESHOWWINDOW == 0 || startup.PID != info.BrowserPID {
		t.Fatalf("startup visibility: %+v", startup)
	}
	if startup.Temp != filepath.Join(info.RunDir, "temp") || startup.UserProfile != filepath.Join(info.RunDir, "user") {
		t.Fatalf("setup lost private environment: %+v", startup)
	}
	for _, name := range []string{"extension", "native-host.exe", "native-host.json", "browser.log", "chrome.log", "temp/open-browser-use"} {
		if _, err := os.Stat(filepath.Join(info.RunDir, filepath.FromSlash(name))); !os.IsNotExist(err) {
			t.Fatalf("unexpected setup artifact %s: %v", name, err)
		}
	}
	if _, err := StartSetup(context.Background(), config); err == nil || !strings.Contains(err.Error(), "profile is unavailable") {
		t.Fatalf("second setup did not reject original lock: %v", err)
	}
	if _, err := Start(context.Background(), Config{Root: config.Root, Name: config.Name, BrowserPath: config.BrowserPath, HostPath: config.BrowserPath, ExtensionDir: t.TempDir()}); err == nil || !strings.Contains(err.Error(), "profile is unavailable") {
		t.Fatalf("run did not reject setup lock: %v", err)
	}
	marker := filepath.Join(info.ProfileDir, "test-persistent-profile-data")
	if err := os.WriteFile(marker, []byte("preserve"), 0600); err != nil {
		t.Fatal(err)
	}
	if err := s.Close(context.Background()); err != nil {
		t.Fatal(err)
	}
	assertSetupClosed(t, s, false)
	next := startSetupTest(t, config)
	if next.info.ProfileDir != info.ProfileDir || next.info.RunID == info.RunID {
		t.Fatal("setup did not reuse profile with fresh run")
	}
	if data, err := os.ReadFile(marker); err != nil || string(data) != "preserve" {
		t.Fatalf("profile not preserved: %q %v", data, err)
	}
	if err := next.Close(context.Background()); err != nil {
		t.Fatal(err)
	}
}

func TestSetupNaturalExitDoesNotSendBrowserClose(t *testing.T) {
	for _, mode := range []string{"natural", "natural-nonzero"} {
		t.Run(mode, func(t *testing.T) {
			s := startSetupTest(t, setupTestConfig(t, mode))
			releasePlatformHelper(t, s.info.RunDir, "helper-release")
			select {
			case <-s.Done():
			case <-time.After(5 * time.Second):
				t.Fatal("natural exit did not settle")
			}
			err := s.Close(context.Background())
			if mode == "natural" {
				if err != nil {
					t.Fatal(err)
				}
				assertSetupClosed(t, s, true)
			} else {
				if err == nil {
					t.Fatal("nonzero natural exit was hidden")
				}
				record := readSetupLifecycle(t, s)
				if record.BrowserExit == nil || record.BrowserExit.Code == nil || *record.BrowserExit.Code != 9 || record.Forced || record.BrowserClose != nil {
					t.Fatalf("nonzero exit lost: %+v", record)
				}
			}
			var methods []string
			awaitPlatformJSON(t, filepath.Join(s.info.RunDir, "helper-methods.json"), &methods)
			if strings.Contains(strings.Join(methods, ","), "Browser.close") {
				t.Fatal("sent close after original process exited")
			}
		})
	}
}

func TestSetupCloseDeadlineKeepsOriginalProfileLock(t *testing.T) {
	config := setupTestConfig(t, "gated")
	s := startSetupTest(t, config)
	ctx, cancel := context.WithTimeout(context.Background(), 100*time.Millisecond)
	defer cancel()
	if err := s.Close(ctx); !errors.Is(err, context.DeadlineExceeded) {
		t.Fatalf("got %v", err)
	}
	var ack bool
	awaitPlatformJSON(t, filepath.Join(s.info.RunDir, "helper-close-ack.json"), &ack)
	if !ack {
		t.Fatal("original close not acknowledged")
	}
	if lock, err := platformLock(filepath.Join(config.Root, config.Name)); err == nil {
		lock.Close()
		t.Fatal("released live profile on caller deadline")
	}
	select {
	case <-s.Done():
		t.Fatal("marked live process cleaned")
	default:
	}
	releasePlatformHelper(t, s.info.RunDir, "helper-release")
	if err := s.Close(context.Background()); err != nil {
		t.Fatal(err)
	}
	assertSetupClosed(t, s, false)
	lock, err := platformLock(filepath.Join(config.Root, config.Name))
	if err != nil {
		t.Fatal("profile not released after original exit", err)
	}
	if err := lock.Close(); err != nil {
		t.Fatal(err)
	}
}

func TestSetupRejectsUnexpectedBrowserIdentityAndCleansOriginal(t *testing.T) {
	config := setupTestConfig(t, "bad-identity")
	if s, err := StartSetup(context.Background(), config); err == nil || s != nil {
		t.Fatalf("accepted invalid identity: %v", err)
	}
	lock, err := platformLock(filepath.Join(config.Root, config.Name))
	if err != nil {
		t.Fatal("failed startup retained lock", err)
	}
	defer lock.Close()
	entries, err := os.ReadDir(filepath.Join(config.Root, config.Name, "runs"))
	if err != nil || len(entries) != 1 {
		t.Fatalf("run record %v %v", entries, err)
	}
	s := &Session{info: Info{RunDir: filepath.Join(config.Root, config.Name, "runs", entries[0].Name())}}
	record := readSetupLifecycle(t, s)
	if record.State != "closed" || record.Error == "" || record.Forced || record.BrowserExit == nil || record.JobEmpty == nil || record.NativeDescriptor != nil {
		t.Fatalf("failed startup receipt: %+v", record)
	}
}

func TestSetupArgumentsExcludeTaskAndPrivateBrowsingModes(t *testing.T) {
	args := setupBrowserArguments("owned-profile")
	if err := validateBrowserArguments(args, args); err != nil {
		t.Fatal(err)
	}
	if err := validateSetupArguments(args); err != nil {
		t.Fatal(err)
	}
	for _, forbidden := range []string{"--headless=new", "--load-extension=old", "--disable-extensions-except=old", "--app=https://example.invalid", "--app-id=old", "--incognito", "--guest", "--profile-directory=Other", "--enable-logging", "--log-file=capture", "--log-net-log=capture"} {
		if err := validateSetupArguments(append(append([]string{}, args...), forbidden)); err == nil {
			t.Fatalf("accepted %s", forbidden)
		}
	}
	if strings.Contains(strings.Join(args, " "), "--enable-logging") || args[len(args)-1] != "about:blank" {
		t.Fatal("setup added website or diagnostic logging")
	}
	if !strings.Contains(strings.Join(args, " "), "--disable-field-trial-config ") {
		t.Fatal("setup dropped the validated Chromium startup policy")
	}
}

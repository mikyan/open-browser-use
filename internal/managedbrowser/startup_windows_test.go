//go:build windows

package managedbrowser

import (
	"context"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/ifuryst/open-browser-use/internal/host"
	"golang.org/x/sys/windows"
)

const publishedBrowserEndpoint = "9222\n/devtools/browser/original-publication\n"

// This is a real Windows exclusive file handle, not a browser. The test covers
// the same CreateFile sharing violation seen during Chromium publication.
func exclusiveEndpoint(t *testing.T) (string, func()) {
	t.Helper()
	path := filepath.Join(t.TempDir(), "DevToolsActivePort")
	name, err := windows.UTF16PtrFromString(path)
	if err != nil {
		t.Fatal(err)
	}
	handle, err := windows.CreateFile(name, windows.GENERIC_READ|windows.GENERIC_WRITE, 0, nil, windows.CREATE_NEW, windows.FILE_ATTRIBUTE_NORMAL, 0)
	if err != nil {
		t.Fatal(err)
	}
	var once sync.Once
	release := func() { once.Do(func() { _ = windows.CloseHandle(handle) }) }
	t.Cleanup(release)
	var written uint32
	if err := windows.WriteFile(handle, []byte(publishedBrowserEndpoint), &written, nil); err != nil || int(written) != len(publishedBrowserEndpoint) {
		t.Fatalf("exclusive publication write: %d %v", written, err)
	}
	if _, err := readSmallFile(path, 4096); !platformSharingViolation(err) {
		t.Fatalf("expected actual wrapped Windows sharing violation: %v", err)
	}
	return path, release
}

func startupOnlySession() *Session {
	return &Session{browserDone: make(chan struct{}), nativeDone: make(chan struct{})}
}

func TestPrivateBrowserPublicationWaitsOriginalExclusiveFile(t *testing.T) {
	path, release := exclusiveEndpoint(t)
	s := startupOnlySession()
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()
	type result struct {
		endpoint string
		err      error
	}
	finished := make(chan result, 1)
	go func() { endpoint, err := s.waitBrowserEndpoint(ctx, path); finished <- result{endpoint, err} }()
	select {
	case got := <-finished:
		t.Fatalf("exclusive publication ended startup: %+v", got)
	case <-time.After(50 * time.Millisecond):
	}
	release()
	select {
	case got := <-finished:
		if got.err != nil || got.endpoint != "ws://127.0.0.1:9222/devtools/browser/original-publication" {
			t.Fatalf("original publication: %+v", got)
		}
	case <-ctx.Done():
		t.Fatal("original startup did not observe released publication")
	}
}

func TestPrivateBrowserBusyPublicationDoesNotExtendDeadline(t *testing.T) {
	path, release := exclusiveEndpoint(t)
	s := startupOnlySession()
	ctx, cancel := context.WithTimeout(context.Background(), 70*time.Millisecond)
	defer cancel()
	if endpoint, err := s.waitBrowserEndpoint(ctx, path); endpoint != "" || !errors.Is(err, context.DeadlineExceeded) {
		t.Fatalf("busy publication replaced original deadline: %q %v", endpoint, err)
	}
	release()
	// Publishing after the original deadline cannot turn that attempt ready.
	if endpoint, err := s.waitBrowserEndpoint(ctx, path); endpoint != "" || !errors.Is(err, context.DeadlineExceeded) {
		t.Fatalf("late publication accepted: %q %v", endpoint, err)
	}
}

func TestPrivateBrowserPublicationStopsForOriginalProcessExit(t *testing.T) {
	path, _ := exclusiveEndpoint(t)
	s := startupOnlySession()
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()
	finished := make(chan error, 1)
	go func() { _, err := s.waitBrowserEndpoint(ctx, path); finished <- err }()
	s.browserExit = processReceipt(1, nil, errors.New("original helper exited"))
	close(s.browserDone)
	select {
	case err := <-finished:
		if err == nil || !strings.Contains(err.Error(), "browser exited during startup") {
			t.Fatalf("ignored original process exit: %v", err)
		}
	case <-ctx.Done():
		t.Fatal("waited for a publication after original process exit")
	}
}

func TestPrivateBrowserPublicationRejectsNonPublicationErrors(t *testing.T) {
	for _, err := range []error{nil, windows.ERROR_ACCESS_DENIED, windows.ERROR_LOCK_VIOLATION, os.ErrPermission, errors.New("being used by another process")} {
		if platformSharingViolation(err) {
			t.Fatalf("classified unrelated failure as transient: %v", err)
		}
	}
	for _, content := range []string{"9222\n/devtools/page/foreign", "9222\n/devtools/browser/exact\nextra", strings.Repeat("x", 4097)} {
		path := filepath.Join(t.TempDir(), "DevToolsActivePort")
		if err := os.WriteFile(path, []byte(content), 0600); err != nil {
			t.Fatal(err)
		}
		ctx, cancel := context.WithTimeout(context.Background(), time.Second)
		endpoint, err := startupOnlySession().waitBrowserEndpoint(ctx, path)
		cancel()
		if endpoint != "" || err == nil || errors.Is(err, context.DeadlineExceeded) {
			t.Fatalf("invalid complete publication was retried: %q %v", endpoint, err)
		}
	}
}

func TestEndpointCleanupRetainsUnconfirmedOriginalIdentity(t *testing.T) {
	for _, identity := range []string{"unconfirmed", "pid-only", "foreign", "changed-start", "matching"} {
		t.Run(identity, func(t *testing.T) {
			dir := t.TempDir()
			data := []byte(`{"socketPath":"\\\\.\\pipe\\original-private-host","pid":123,"startedAt":"2026-10-17T01:00:00Z"}`)
			path := filepath.Join(dir, "active.json")
			if err := os.WriteFile(path, data, 0600); err != nil {
				t.Fatal(err)
			}
			s := &Session{endpointDir: dir}
			if identity != "unconfirmed" {
				s.info.NativePID, s.info.SocketPath = 123, `\\.\pipe\original-private-host`
			}
			if identity == "foreign" {
				s.info.NativePID++
			}
			if identity != "unconfirmed" && identity != "pid-only" {
				var descriptor host.ActiveSocketRecord
				if err := json.Unmarshal(data, &descriptor); err != nil {
					t.Fatal(err)
				}
				descriptor.PID = s.info.NativePID
				if identity == "changed-start" {
					descriptor.StartedAt = descriptor.StartedAt.Add(time.Second)
				}
				s.nativeConnections = []*nativeConnection{{record: nativeConnectionRecord{Descriptor: descriptor}}}
			}
			err := s.cleanEndpointRecords()
			if identity == "matching" {
				if err != nil {
					t.Fatal(err)
				}
				if _, err := os.Stat(path); !errors.Is(err, os.ErrNotExist) {
					t.Fatalf("matching record retained: %v", err)
				}
				return
			}
			if err == nil || (identity == "unconfirmed" || identity == "pid-only") && !strings.Contains(err.Error(), "cannot confirm the original endpoint identity") || (identity == "foreign" || identity == "changed-start") && !strings.Contains(err.Error(), "foreign endpoint") {
				t.Fatalf("incorrect cleanup diagnosis: %v", err)
			}
			if actual, readErr := os.ReadFile(path); readErr != nil || string(actual) != string(data) {
				t.Fatalf("unconfirmed record was altered: %v", readErr)
			}
		})
	}
}

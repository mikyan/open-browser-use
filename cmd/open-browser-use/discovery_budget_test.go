package main

import (
	"errors"
	"net"
	"os"
	"path/filepath"
	"testing"
	"time"

	"github.com/ifuryst/open-browser-use/internal/host"
	"github.com/ifuryst/open-browser-use/internal/wire"
)

func TestDiscoveryCandidatesShareOneBudget(t *testing.T) {
	for _, mode := range []string{"scan", "profile", "active-fallback", "cleanup"} {
		t.Run(mode, func(t *testing.T) {
			directory := t.TempDir()
			candidates := []socketCandidate{}
			for _, name := range []string{"a.sock", "b.sock"} {
				endpoint := filepath.Join(directory, name)
				if err := os.WriteFile(endpoint, nil, 0600); err != nil {
					t.Fatal(err)
				}
				candidates = append(candidates, socketCandidate{path: endpoint})
			}
			if err := host.WriteActiveSocketRecord(directory, candidates[0].path); err != nil {
				t.Fatal(err)
			}
			original := dialLocalEndpoint
			t.Cleanup(func() { dialLocalEndpoint = original })
			calls := 0
			dialLocalEndpoint = func(_ string, timeout time.Duration) (net.Conn, error) {
				calls++
				if timeout <= 0 || timeout > 30*time.Millisecond {
					t.Errorf("invalid remaining budget %v", timeout)
				}
				time.Sleep(timeout + time.Millisecond)
				return nil, os.ErrDeadlineExceeded
			}
			var err error
			switch mode {
			case "scan":
				_, err = scanSocketDir(directory, "", 30*time.Millisecond)
			case "profile":
				_, _, _, err = pickSocketForProfile(directory, "chrome", "Default", 30*time.Millisecond)
			case "active-fallback":
				_, err = dialBrowserSocket("", directory, 30*time.Millisecond)
			case "cleanup":
				cleanupStaleSocketCandidates(directory, candidates, "", 30*time.Millisecond)
			}
			if mode != "cleanup" && err == nil {
				t.Fatal("expired discovery unexpectedly succeeded")
			}
			if calls != 1 {
				t.Fatalf("discovery issued %d dials; the next candidate must not get a fresh budget", calls)
			}
		})
	}
}

func TestExpiredProfileDialCannotSendVerification(t *testing.T) {
	client, server := net.Pipe()
	t.Cleanup(func() { _ = client.Close(); _ = server.Close() })
	original := dialLocalEndpoint
	t.Cleanup(func() { dialLocalEndpoint = original })
	dialLocalEndpoint = func(_ string, timeout time.Duration) (net.Conn, error) {
		time.Sleep(timeout + time.Millisecond)
		return client, nil
	}
	requests := make(chan error, 1)
	go func() {
		var request any
		err := wire.ReadJSON(server, &request)
		if err == nil {
			err = errors.New("verification request sent after discovery budget expired")
		}
		requests <- err
	}()
	if conn, err := dialBrowserSocketForProfile("fixture", "", "chrome", "Default", 20*time.Millisecond); err == nil || conn != nil {
		t.Fatalf("expired profile selection returned a connection: %v", err)
	}
	select {
	case err := <-requests:
		if err == nil || err.Error() != "EOF" {
			t.Fatalf("expected closed stream without verification bytes, got %v", err)
		}
	case <-time.After(time.Second):
		t.Fatal("expired discovery leaked its connection")
	}
}

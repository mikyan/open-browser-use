package main

import (
	"fmt"
	"net"
	"os"
	"path/filepath"
	"testing"
	"time"

	"github.com/ifuryst/open-browser-use/internal/host"
)

func TestDiscoveryIncludesPipeRecordsAndLegacySockets(t *testing.T) {
	dir := t.TempDir()
	pipe := `\\.\pipe\open-browser-use-discovery`
	if err := host.WriteEndpointRecord(dir, pipe); err != nil {
		t.Fatal(err)
	}
	legacy := filepath.Join(dir, "legacy.sock")
	if err := os.WriteFile(legacy, nil, 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dir, "bad.endpoint.json"), []byte(`{}`), 0o600); err != nil {
		t.Fatal(err)
	}
	candidates, err := listSocketCandidates(dir)
	if err != nil || len(candidates) != 2 {
		t.Fatalf("unexpected candidates %#v %v", candidates, err)
	}
	found := map[string]bool{}
	for _, candidate := range candidates {
		found[candidate.path] = true
	}
	if !found[pipe] || !found[legacy] {
		t.Fatalf("missing endpoint %#v", found)
	}
}

func TestDiscoveryPreservesEndpointsOnTemporaryDialFailures(t *testing.T) {
	for _, failure := range []error{os.ErrPermission, os.ErrDeadlineExceeded} {
		for _, pipe := range []bool{false, true} {
			t.Run(fmt.Sprintf("pipe=%v/%v", pipe, failure), func(t *testing.T) {
				dir := t.TempDir()
				path := filepath.Join(dir, "live.sock")
				recordPath := path
				if pipe {
					path = `\\.\pipe\open-browser-use-temporarily-unavailable`
					recordPath = host.EndpointRecordPath(dir, path)
					if err := host.WriteEndpointRecord(dir, path); err != nil {
						t.Fatal(err)
					}
				} else if err := os.WriteFile(path, nil, 0o600); err != nil {
					t.Fatal(err)
				}
				if err := host.WriteActiveSocketRecord(dir, path); err != nil {
					t.Fatal(err)
				}
				previousDial := dialLocalEndpoint
				dialCount := 0
				dialLocalEndpoint = func(string, time.Duration) (net.Conn, error) {
					dialCount++
					return nil, &net.OpError{Op: "dial", Net: "local", Err: failure}
				}
				t.Cleanup(func() { dialLocalEndpoint = previousDial })
				if conn, err := dialBrowserSocket("", dir, time.Second); err == nil {
					conn.Close()
					t.Fatal("expected failed connection")
				}
				if dialCount == 0 {
					t.Fatal("active discovery did not probe the endpoint")
				}
				dialCount = 0
				if _, err := scanSocketDir(dir, "", time.Second); err == nil {
					t.Fatal("scan should fail")
				}
				if dialCount == 0 {
					t.Fatal("directory discovery did not probe the endpoint")
				}
				dialCount = 0
				if _, _, _, err := pickSocketForProfile(dir, "", "", time.Second); err == nil {
					t.Fatal("profile scan should fail")
				}
				if dialCount == 0 {
					t.Fatal("profile discovery did not probe the endpoint")
				}
				dialCount = 0
				cleanupStaleSocketCandidates(dir, []socketCandidate{{path: path}}, "", time.Second)
				if dialCount == 0 {
					t.Fatal("stale cleanup did not probe the endpoint")
				}
				if _, err := os.Stat(recordPath); err != nil {
					t.Fatalf("removed live endpoint after temporary error: %v", err)
				}
				if record, err := host.ReadActiveSocketRecord(dir); err != nil || record.SocketPath != path {
					t.Fatalf("removed active record: %#v %v", record, err)
				}
			})
		}
	}
}

func TestDiscoveryRemovesOnlyMissingPipeRecord(t *testing.T) {
	dir := t.TempDir()
	missing, live := `\\.\pipe\open-browser-use-missing`, `\\.\pipe\open-browser-use-busy`
	for _, path := range []string{missing, live} {
		if err := host.WriteEndpointRecord(dir, path); err != nil {
			t.Fatal(err)
		}
	}
	previousDial := dialLocalEndpoint
	probed := map[string]bool{}
	dialLocalEndpoint = func(path string, _ time.Duration) (net.Conn, error) {
		probed[path] = true
		if path == missing {
			return nil, os.ErrNotExist
		}
		return nil, os.ErrPermission
	}
	defer func() { dialLocalEndpoint = previousDial }()
	_, _ = scanSocketDir(dir, "", time.Second)
	if !probed[missing] || !probed[live] {
		t.Fatalf("expected both endpoints to be probed: %v", probed)
	}
	if _, err := os.Stat(host.EndpointRecordPath(dir, missing)); !os.IsNotExist(err) {
		t.Fatalf("stale descriptor remained: %v", err)
	}
	if _, err := os.Stat(host.EndpointRecordPath(dir, live)); err != nil {
		t.Fatalf("live descriptor removed: %v", err)
	}
}

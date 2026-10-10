package transport

import (
	"fmt"
	"io"
	"net"
	"os"
	"path/filepath"
	"runtime"
	"testing"
	"time"
)

func TestLocalEndpointRoundTripAndDeadline(t *testing.T) {
	base := ""
	if runtime.GOOS != "windows" {
		base = "/tmp"
	}
	dir, err := os.MkdirTemp(base, "obu-ipc-")
	if err != nil {
		t.Fatal(err)
	}
	defer os.RemoveAll(dir)
	path := NewEndpoint(dir, filepath.Base(dir))
	listener, err := Listen(path)
	if err != nil {
		t.Fatal(err)
	}
	defer listener.Close()
	done := make(chan error, 1)
	go func() {
		conn, err := listener.Accept()
		if err != nil {
			done <- err
			return
		}
		defer conn.Close()
		payload := make([]byte, 5)
		if _, err := io.ReadFull(conn, payload); err != nil {
			done <- err
			return
		}
		_, err = conn.Write(payload)
		done <- err
		// Keep the connection open until the client's read deadline expires.
		_, _ = conn.Read(make([]byte, 1))
	}()
	conn, err := DialTimeout(path, time.Second)
	if err != nil {
		t.Fatal(err)
	}
	defer conn.Close()
	if _, err := conn.Write([]byte("hello")); err != nil {
		t.Fatal(err)
	}
	result := make([]byte, 5)
	if _, err := io.ReadFull(conn, result); err != nil {
		t.Fatal(err)
	}
	if string(result) != "hello" {
		t.Fatalf("unexpected reply %q", result)
	}
	if err := <-done; err != nil {
		t.Fatal(err)
	}
	if err := conn.SetReadDeadline(time.Now().Add(20 * time.Millisecond)); err != nil {
		t.Fatal(err)
	}
	_, err = conn.Read(make([]byte, 1))
	if networkError, ok := err.(net.Error); !ok || !networkError.Timeout() {
		t.Fatalf("expected deadline error, got %v", err)
	}
	if IsStale(err) {
		t.Fatal("deadline must not mark a live endpoint stale")
	}
}

func TestStaleClassificationIsConservative(t *testing.T) {
	for _, err := range []error{os.ErrPermission, os.ErrDeadlineExceeded, fmt.Errorf("wrapped: %w", os.ErrPermission)} {
		if IsStale(err) {
			t.Fatalf("temporary error marked stale: %v", err)
		}
	}
	if !IsStale(fmt.Errorf("wrapped: %w", os.ErrNotExist)) {
		t.Fatal("missing endpoint should be stale")
	}
}

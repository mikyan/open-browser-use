//go:build windows

package transport

import (
	"errors"
	"fmt"
	"io"
	"net"
	"os"
	"testing"
	"time"
)

func awaitPipeResult(t *testing.T, label string, result <-chan error) error {
	t.Helper()
	timer := time.NewTimer(3 * time.Second)
	defer timer.Stop()
	select {
	case err := <-result:
		return err
	case <-timer.C:
		t.Fatalf("%s did not actually return", label)
		return nil
	}
}

func closePipeAsync(listener net.Listener) <-chan error {
	done := make(chan error, 1)
	go func() { done <- listener.Close() }()
	return done
}

func TestNamedPipeCloseUnblocksAcceptAndReleasesEndpoint(t *testing.T) {
	// Exercise the real API in different schedules. This is bounded stress,
	// not a deterministic reproduction of go-winio issue #85's native race.
	for iteration := range 64 {
		path := NewEndpoint("", fmt.Sprintf("close-%d-%d-%d", os.Getpid(), time.Now().UnixNano(), iteration))
		listener, err := Listen(path)
		if err != nil {
			t.Fatal(err)
		}
		acceptStarted := make(chan struct{})
		acceptDone := make(chan error, 1)
		go func() {
			close(acceptStarted)
			for {
				conn, err := listener.Accept()
				if err != nil {
					acceptDone <- err
					return
				}
				_ = conn.Close()
			}
		}()
		<-acceptStarted

		// Half the schedules have no client, as in the invalid-parameter CLI
		// fixture. Others race Close against an immediate client disconnect.
		var dialDone chan error
		if iteration%2 != 0 {
			dialDone = make(chan error, 1)
			go func() {
				conn, err := DialTimeout(path, 100*time.Millisecond)
				if err == nil {
					err = conn.Close()
				}
				dialDone <- err
			}()
		}
		// A second Close could rescue the old lost-signal defect. Include
		// single-close cases without any cleanup retry, as well as concurrent
		// closers, each with and without an immediately disconnecting client.
		closeCount := 1
		if iteration%4 >= 2 {
			closeCount = 8
		}
		closed := make([]<-chan error, closeCount)
		for index := range closed {
			closed[index] = closePipeAsync(listener)
		}
		for _, done := range closed {
			if err := awaitPipeResult(t, fmt.Sprintf("listener Close (iteration %d, callers %d)", iteration, closeCount), done); err != nil {
				t.Fatal(err)
			}
		}
		if err := awaitPipeResult(t, "pending Accept", acceptDone); !errors.Is(err, net.ErrClosed) {
			t.Fatalf("Accept after Close: %v", err)
		}
		if dialDone != nil {
			// Either connection or dial failure is valid during closure, but the
			// client goroutine must actually finish before this case ends.
			_ = awaitPipeResult(t, "racing dial", dialDone)
		}
		if conn, err := listener.Accept(); !errors.Is(err, net.ErrClosed) || conn != nil {
			if conn != nil {
				_ = conn.Close()
			}
			t.Fatalf("closed listener accepted: conn=%v err=%v", conn, err)
		}
		replacement, err := Listen(path)
		if err != nil {
			t.Fatalf("Close retained the original endpoint: %v", err)
		}
		if err := awaitPipeResult(t, "replacement Close", closePipeAsync(replacement)); err != nil {
			t.Fatal(err)
		}
	}
}

func TestNamedPipeListenerClosePreservesAcceptedConnection(t *testing.T) {
	path := NewEndpoint("", fmt.Sprintf("close-live-%d-%d", os.Getpid(), time.Now().UnixNano()))
	listener, err := Listen(path)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		if err := awaitPipeResult(t, "listener cleanup", closePipeAsync(listener)); err != nil {
			t.Error(err)
		}
	})
	type acceptResult struct {
		conn net.Conn
		err  error
	}
	accepted := make(chan acceptResult, 1)
	go func() { conn, err := listener.Accept(); accepted <- acceptResult{conn, err} }()
	client, err := DialTimeout(path, time.Second)
	if err != nil {
		t.Fatal(err)
	}
	defer client.Close()
	var server net.Conn
	select {
	case result := <-accepted:
		if result.err != nil {
			t.Fatal(result.err)
		}
		server = result.conn
	case <-time.After(3 * time.Second):
		t.Fatal("initial Accept did not return")
	}
	defer server.Close()
	if err := awaitPipeResult(t, "listener Close with a live connection", closePipeAsync(listener)); err != nil {
		t.Fatal(err)
	}
	for _, conn := range []net.Conn{client, server} {
		if err := conn.SetDeadline(time.Now().Add(time.Second)); err != nil {
			t.Fatal(err)
		}
	}
	serverDone := make(chan error, 1)
	go func() {
		buffer := make([]byte, 5)
		_, err := io.ReadFull(server, buffer)
		if err == nil {
			_, err = server.Write(buffer)
		}
		serverDone <- err
	}()
	if _, err := client.Write([]byte("alive")); err != nil {
		t.Fatal(err)
	}
	buffer := make([]byte, 5)
	if _, err := io.ReadFull(client, buffer); err != nil || string(buffer) != "alive" {
		t.Fatalf("accepted connection changed after listener Close: %q, %v", buffer, err)
	}
	if err := awaitPipeResult(t, "existing connection reply", serverDone); err != nil {
		t.Fatal(err)
	}
}

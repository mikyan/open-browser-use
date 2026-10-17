package main

import (
	"context"
	"errors"
	"io"
	"net"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
	"time"

	"github.com/ifuryst/open-browser-use/internal/managedbrowser"
	"github.com/ifuryst/open-browser-use/internal/transport"
	"github.com/ifuryst/open-browser-use/internal/wire"
)

func TestManagedViewerTicketRequiresSameLiveRunAndExplicitRequest(t *testing.T) {
	const ticketURL = "http://127.0.0.1:54321/#ticket=abcdefghijklmnopqrstuvwxyz0123456789ABCDEFG"
	for _, runID := range []string{"retired", "current"} {
		t.Run(runID, func(t *testing.T) {
			client, server := net.Pipe()
			defer client.Close()
			s := newManagedSupervisor(nil, managedbrowser.Info{Name: "fixture", RunID: "current"})
			issued := make(chan struct{}, 1)
			s.issueViewerURL = func() (string, error) { issued <- struct{}{}; return ticketURL, nil }
			done := make(chan struct{})
			go func() { s.handle(server); server.Close(); close(done) }()
			_ = client.SetDeadline(time.Now().Add(time.Second))
			if err := wire.WriteJSON(client, managedMessage{Operation: "status"}); err != nil {
				t.Fatal(err)
			}
			status, err := readManagedMessage(client)
			if err != nil || status.State != "ready" || status.ViewerURL != "" {
				t.Fatalf("status leaked or failed: %+v %v", status, err)
			}
			select {
			case <-issued:
				t.Fatal("status created a user capability")
			default:
			}
			if err := wire.WriteJSON(client, managedMessage{Operation: "view", RunID: runID}); err != nil {
				t.Fatal(err)
			}
			response, err := readManagedMessage(client)
			if err != nil {
				t.Fatal(err)
			}
			<-done
			if runID != "current" {
				if response.Error == "" || response.ViewerURL != "" || len(issued) != 0 {
					t.Fatalf("retired run obtained a capability: %+v", response)
				}
			} else if response.State != "viewer" || response.RunID != runID || response.ViewerURL != ticketURL || len(issued) != 1 {
				t.Fatalf("explicit view missing exact original result: %+v", response)
			}
			select {
			case <-s.stop:
				t.Fatal("view stopped the session")
			default:
			}
		})
	}
}

func TestManagedViewWaitsForOriginalViewerCleanupBeforeIssuingOnce(t *testing.T) {
	for _, failCleanup := range []bool{false, true} {
		t.Run(fmtCleanup(func() error {
			if failCleanup {
				return errors.New("unknown")
			}
			return nil
		}()), func(t *testing.T) {
			client, server := net.Pipe()
			defer client.Close()
			s := newManagedSupervisor(nil, managedbrowser.Info{Name: "fixture", RunID: "current"})
			entered, release := make(chan struct{}), make(chan struct{})
			issued := make(chan struct{}, 1)
			s.waitViewerReady = func(ctx context.Context) error {
				close(entered)
				select {
				case <-release:
					if failCleanup {
						return errors.New("original human release unconfirmed")
					}
					return nil
				case <-ctx.Done():
					return ctx.Err()
				}
			}
			s.issueViewerURL = func() (string, error) { issued <- struct{}{}; return "http://127.0.0.1:1234/#ticket=private", nil }
			done := make(chan struct{})
			go func() { s.handle(server); server.Close(); close(done) }()
			client.SetDeadline(time.Now().Add(3 * time.Second))
			if err := wire.WriteJSON(client, managedMessage{Operation: "status"}); err != nil {
				t.Fatal(err)
			}
			if _, err := readManagedMessage(client); err != nil {
				t.Fatal(err)
			}
			if err := wire.WriteJSON(client, managedMessage{Operation: "view", RunID: "current"}); err != nil {
				t.Fatal(err)
			}
			<-entered
			select {
			case <-issued:
				t.Fatal("ticket issued before actual cleanup")
			default:
			}
			close(release)
			result, err := readManagedMessage(client)
			if err != nil {
				t.Fatal(err)
			}
			<-done
			if failCleanup {
				if result.Error == "" || result.ViewerURL != "" || len(issued) != 0 {
					t.Fatalf("unknown cleanup issued ticket: %+v", result)
				}
			} else if result.State != "viewer" || len(issued) != 1 {
				t.Fatalf("original view did not issue exactly once: %+v", result)
			}
		})
	}
}

func TestManagedViewWaitingForCleanupIsCanceledBySessionStop(t *testing.T) {
	client, server := net.Pipe()
	defer client.Close()
	s := newManagedSupervisor(nil, managedbrowser.Info{Name: "fixture", RunID: "current"})
	entered := make(chan struct{})
	s.waitViewerReady = func(ctx context.Context) error { close(entered); <-ctx.Done(); return ctx.Err() }
	s.issueViewerURL = func() (string, error) { t.Error("Stop permitted a new ticket"); return "", nil }
	done := make(chan struct{})
	go func() { s.handle(server); server.Close(); close(done) }()
	client.SetDeadline(time.Now().Add(3 * time.Second))
	_ = wire.WriteJSON(client, managedMessage{Operation: "status"})
	if _, err := readManagedMessage(client); err != nil {
		t.Fatal(err)
	}
	_ = wire.WriteJSON(client, managedMessage{Operation: "view", RunID: "current"})
	<-entered
	close(s.stop)
	result, err := readManagedMessage(client)
	if err != nil || result.Error == "" || result.ViewerURL != "" {
		t.Fatalf("stop failed to cancel waiting view: %+v %v", result, err)
	}
	<-done
}

func TestManagedViewerStopWaitsForCleanupDespiteCallerDeadline(t *testing.T) {
	s := newManagedSupervisor(nil, managedbrowser.Info{RunID: "current"})
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	if err := s.requestStop(ctx); !errors.Is(err, context.Canceled) {
		t.Fatalf("caller cancellation was concealed: %v", err)
	}
	select {
	case <-s.stop:
	default:
		t.Fatal("original stop was not admitted")
	}
	select {
	case <-s.finished:
		t.Fatal("caller deadline completed real shutdown")
	default:
	}
	result := make(chan error, 1)
	go func() { result <- s.requestStop(context.Background()) }()
	select {
	case <-result:
		t.Fatal("second observer did not wait for original cleanup")
	default:
	}
	s.err = errors.New("original process cleanup failed")
	close(s.finished)
	if err := <-result; err != s.err {
		t.Fatalf("original cleanup error replaced: %v", err)
	}
}

func TestManagedViewUsesLiveSupervisorAndRefusesNonlocalURL(t *testing.T) {
	if runtime.GOOS != "windows" {
		t.Skip("Windows managed transport")
	}
	for _, location := range []string{
		"http://127.0.0.1:54321/#ticket=" + strings.Repeat("A", 43),
		"https://example.invalid/#ticket=" + strings.Repeat("A", 43),
	} {
		root := t.TempDir()
		address, err := managedControlAddress(root, "fixture")
		if err != nil {
			t.Fatal(err)
		}
		listener, err := transport.Listen(address)
		if err != nil {
			t.Fatal(err)
		}
		s := newManagedSupervisor(listener, managedbrowser.Info{Name: "fixture", RunID: "unique", SocketPath: transport.NewEndpoint("", "fixture-unique")})
		s.issueViewerURL = func() (string, error) { return location, nil }
		s.serve()
		response, err := managedUserRequest(root, "fixture", "view", time.Second)
		s.stopOnce.Do(func() { close(s.stop) })
		s.finish(nil)
		if strings.HasPrefix(location, "http://127.0.0.1:") {
			if err != nil || response.ViewerURL != location || response.RunID != "unique" {
				t.Fatalf("local viewer failed: %+v %v", response, err)
			}
		} else if err == nil {
			t.Fatal("nonlocal URL accepted as the private viewer")
		}
	}
}

func TestManagedStopWaitsForOriginalCleanup(t *testing.T) {
	for _, cleanupErr := range []error{nil, errors.New("native exit unconfirmed")} {
		t.Run(fmtCleanup(cleanupErr), func(t *testing.T) {
			client, server := net.Pipe()
			defer client.Close()
			s := newManagedSupervisor(nil, managedbrowser.Info{Name: "fixture", RunID: "original"})
			done := make(chan struct{})
			go func() { s.handle(server); server.Close(); close(done) }()
			client.SetDeadline(time.Now().Add(3 * time.Second))
			if err := wire.WriteJSON(client, managedMessage{Operation: "status"}); err != nil {
				t.Fatal(err)
			}
			ready, err := readManagedMessage(client)
			if err != nil || ready.State != "ready" || ready.RunID != "original" {
				t.Fatalf("ready=%+v error=%v", ready, err)
			}
			if err := wire.WriteJSON(client, managedMessage{Operation: "stop", RunID: ready.RunID}); err != nil {
				t.Fatal(err)
			}
			select {
			case <-s.stop:
			case <-time.After(time.Second):
				t.Fatal("stop not requested")
			}
			select {
			case <-done:
				t.Fatal("stop completed before actual cleanup")
			default:
			}
			s.err = cleanupErr
			close(s.finished)
			response, err := readManagedMessage(client)
			if err != nil {
				t.Fatal(err)
			}
			if response.RunID != "original" {
				t.Fatalf("changed run: %+v", response)
			}
			if cleanupErr == nil && (response.State != "stopped" || response.Error != "") {
				t.Fatalf("response=%+v", response)
			}
			if cleanupErr != nil && (response.State != "cleanup-failed" || response.Error != cleanupErr.Error()) {
				t.Fatalf("cleanup failure concealed: %+v", response)
			}
			<-done
		})
	}
}

func fmtCleanup(err error) string {
	if err != nil {
		return "failed-cleanup"
	}
	return "confirmed-cleanup"
}

func TestManagedStopRejectsWrongGenerationAndTaskRPC(t *testing.T) {
	for _, request := range []managedMessage{{Operation: "stop", RunID: "old-run"}, {Operation: "pause", RunID: "current"}} {
		client, server := net.Pipe()
		s := newManagedSupervisor(nil, managedbrowser.Info{Name: "fixture", RunID: "current"})
		done := make(chan struct{})
		go func() { s.handle(server); server.Close(); close(done) }()
		client.SetDeadline(time.Now().Add(time.Second))
		if err := wire.WriteJSON(client, managedMessage{Operation: "status"}); err != nil {
			t.Fatal(err)
		}
		if _, err := readManagedMessage(client); err != nil {
			t.Fatal(err)
		}
		if err := wire.WriteJSON(client, request); err != nil {
			t.Fatal(err)
		}
		response, err := readManagedMessage(client)
		if err != nil || response.Error == "" {
			t.Fatalf("wrong command accepted: %+v %v", response, err)
		}
		<-done
		select {
		case <-s.stop:
			t.Fatal("invalid request stopped the browser")
		default:
		}
		client.Close()
	}
}

func TestManagedSupervisorBoundsFrameBeforeAllocation(t *testing.T) {
	client, server := net.Pipe()
	s := newManagedSupervisor(nil, managedbrowser.Info{RunID: "current"})
	go func() { s.handle(server); server.Close() }()
	defer client.Close()
	client.SetDeadline(time.Now().Add(time.Second))
	header := make([]byte, 4)
	wire.NativeEndian().PutUint32(header, 64<<20)
	if _, err := client.Write(header); err != nil {
		t.Fatal(err)
	}
	var one [1]byte
	if _, err := client.Read(one[:]); err != io.EOF {
		t.Fatalf("oversized frame not rejected: %v", err)
	}
}

func TestManagedSelectorDoesNotFallbackWhenSupervisorMissing(t *testing.T) {
	if runtime.GOOS != "windows" {
		t.Skip("Windows managed transport")
	}
	root := t.TempDir()
	conn, err := dialBrowserSocketForOptions(socketOptions{managedName: "missing", managedRoot: root}, 50*time.Millisecond)
	if conn != nil || err == nil || !strings.Contains(err.Error(), "supervisor") {
		t.Fatalf("missing managed run fell back: %v %v", conn, err)
	}
	for _, options := range []socketOptions{
		{managedName: "fixture", managedRoot: root, socketPath: "another"},
		{managedName: "fixture", managedRoot: root, browser: "edge"},
		{managedName: "fixture", managedRoot: root, profile: "Default"},
		{managedName: "fixture", managedRoot: root, socketDir: filepath.Join(root, "global")},
	} {
		if conn, err := dialBrowserSocketForOptions(options, time.Second); conn != nil || err == nil {
			t.Fatalf("mixed selector accepted: %+v", options)
		}
	}
}

func TestManagedRequestUsesLiveSupervisorAndExactStop(t *testing.T) {
	if runtime.GOOS != "windows" {
		t.Skip("Windows managed transport")
	}
	root := t.TempDir()
	address, err := managedControlAddress(root, "fixture")
	if err != nil {
		t.Fatal(err)
	}
	listener, err := transport.Listen(address)
	if err != nil {
		t.Fatal(err)
	}
	s := newManagedSupervisor(listener, managedbrowser.Info{Name: "fixture", RunID: "unique", SocketPath: transport.NewEndpoint("", "fixture-unique")})
	s.serve()
	response, err := managedRequest(root, "fixture", false, time.Second)
	if err != nil || response.Info == nil || response.Info.SocketPath != s.info.SocketPath {
		t.Fatalf("status=%+v error=%v", response, err)
	}
	closed := make(chan struct{})
	go func() { <-s.stop; s.finish(nil); close(closed) }()
	response, err = managedRequest(root, "fixture", true, 3*time.Second)
	if err != nil || response.State != "stopped" || response.RunID != "unique" {
		t.Fatalf("stop=%+v error=%v", response, err)
	}
	<-closed
	if _, err := managedRequest(root, "fixture", false, 50*time.Millisecond); err == nil {
		t.Fatal("stopped supervisor remained reachable")
	}
}

func TestManagedFlagsRejectMixedSelection(t *testing.T) {
	for _, selector := range []string{"--socket", "--socket-dir", "--browser", "--profile"} {
		cmd := newRootCommand()
		cmd.SetOut(io.Discard)
		cmd.SetErr(io.Discard)
		cmd.SetArgs([]string{"info", "--managed", "fixture", selector, "other"})
		if err := cmd.Execute(); err == nil || !strings.Contains(err.Error(), "none of the others") {
			t.Fatalf("selector %s not rejected: %v", selector, err)
		}
	}
}

func TestExplicitEmptyManagedNeverUsesOrdinaryDiscovery(t *testing.T) {
	for _, command := range []string{"info", "mcp"} {
		for _, args := range [][]string{{command, "--managed="}, {command, "--managed-root", defaultManagedRoot()}} {
			cmd := newRootCommand()
			cmd.SetIn(strings.NewReader(""))
			cmd.SetOut(io.Discard)
			cmd.SetErr(io.Discard)
			cmd.SetArgs(args)
			if err := cmd.Execute(); err == nil || !(strings.Contains(err.Error(), "managed name") || strings.Contains(err.Error(), "requires --managed")) {
				t.Fatalf("managed selection did not reject before ordinary discovery: %v: %v", args, err)
			}
		}
	}
}

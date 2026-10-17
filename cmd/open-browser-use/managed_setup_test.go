package main

import (
	"errors"
	"net"
	"runtime"
	"strings"
	"testing"
	"time"

	"github.com/ifuryst/open-browser-use/internal/managedbrowser"
	"github.com/ifuryst/open-browser-use/internal/transport"
	"github.com/ifuryst/open-browser-use/internal/wire"
)

func TestSetupSupervisorHasNoViewerAndStopWaitsForOriginalCleanup(t *testing.T) {
	client, server := net.Pipe()
	defer client.Close()
	s := newManagedSupervisor(nil, managedbrowser.Info{Mode: "setup", Name: "fixture", RunID: "original", BrowserPID: 42})
	issued := false
	s.issueViewerURL = func() (string, error) { issued = true; return "must-not-be-issued", nil }
	done := make(chan struct{})
	go func() { s.handle(server); server.Close(); close(done) }()
	_ = client.SetDeadline(time.Now().Add(time.Second))
	if err := wire.WriteJSON(client, managedMessage{Operation: "status"}); err != nil {
		t.Fatal(err)
	}
	status, err := readManagedMessage(client)
	if err != nil || status.State != "setup" || status.Info == nil || status.Info.Mode != "setup" || status.Info.SocketPath != "" || status.ViewerURL != "" {
		t.Fatalf("setup exposed task access: %+v %v", status, err)
	}
	if err := wire.WriteJSON(client, managedMessage{Operation: "view", RunID: status.RunID}); err != nil {
		t.Fatal(err)
	}
	response, err := readManagedMessage(client)
	<-done
	if err != nil || response.Error == "" || response.ViewerURL != "" || issued {
		t.Fatalf("setup issued a viewer: %+v %v", response, err)
	}

	client2, server2 := net.Pipe()
	defer client2.Close()
	done2 := make(chan struct{})
	go func() { s.handle(server2); server2.Close(); close(done2) }()
	_ = client2.SetDeadline(time.Now().Add(2 * time.Second))
	if err := wire.WriteJSON(client2, managedMessage{Operation: "status"}); err != nil {
		t.Fatal(err)
	}
	if _, err := readManagedMessage(client2); err != nil {
		t.Fatal(err)
	}
	if err := wire.WriteJSON(client2, managedMessage{Operation: "stop", RunID: "original"}); err != nil {
		t.Fatal(err)
	}
	select {
	case <-s.stop:
	case <-time.After(time.Second):
		t.Fatal("setup stop was not admitted")
	}
	select {
	case <-done2:
		t.Fatal("setup stop acknowledged before cleanup")
	default:
	}
	s.err = errors.New("original setup tree not confirmed empty")
	close(s.finished)
	response, err = readManagedMessage(client2)
	<-done2
	if err != nil || response.State != "cleanup-failed" || response.Error != s.err.Error() {
		t.Fatalf("setup cleanup result concealed: %+v %v", response, err)
	}
}

func TestSetupStatusCannotBeSelectedAsATaskEndpoint(t *testing.T) {
	if runtime.GOOS != "windows" {
		t.Skip("Windows managed transport")
	}
	for _, corrupted := range []bool{false, true} {
		t.Run(map[bool]string{false: "setup", true: "unexpected-task-endpoint"}[corrupted], func(t *testing.T) {
			root := t.TempDir()
			address, err := managedControlAddress(root, "fixture")
			if err != nil {
				t.Fatal(err)
			}
			listener, err := transport.Listen(address)
			if err != nil {
				t.Fatal(err)
			}
			info := managedbrowser.Info{Mode: "setup", Name: "fixture", RunID: "original", BrowserPID: 42}
			if corrupted {
				info.SocketPath = transport.NewEndpoint("", "must-not-dial")
			}
			s := newManagedSupervisor(listener, info)
			s.serve()
			defer func() { s.stopOnce.Do(func() { close(s.stop) }); s.finish(nil) }()
			status, err := managedUserRequest(root, "fixture", "status", time.Second)
			if corrupted {
				if err == nil || !strings.Contains(err.Error(), "invalid browser identity or task endpoint") {
					t.Fatalf("setup task endpoint accepted: %+v %v", status, err)
				}
				return
			}
			if err != nil || status.State != "setup" {
				t.Fatalf("setup status failed: %+v %v", status, err)
			}
			_, err = managedUserRequest(root, "fixture", "view", time.Second)
			if err == nil || !strings.Contains(err.Error(), "manual login") {
				t.Fatalf("setup viewer accepted: %v", err)
			}
			conn, err := dialBrowserSocketForOptions(socketOptions{managedName: "fixture", managedRoot: root}, time.Second)
			if conn != nil {
				conn.Close()
				t.Fatal("setup acquired a task connection")
			}
			if err == nil || !strings.Contains(err.Error(), "manual login setup") {
				t.Fatalf("setup fell through to task discovery: %v", err)
			}
		})
	}
}

package main

import (
	"context"
	"errors"
	"net"
	"runtime"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/ifuryst/open-browser-use/internal/managedbrowser"
	"github.com/ifuryst/open-browser-use/internal/transport"
	"github.com/ifuryst/open-browser-use/internal/wire"
)

func TestManagedDegradedSessionRetainsManagementButNotTaskOrImplicitView(t *testing.T) {
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
	info := managedbrowser.Info{Name: "fixture", RunID: "same-run", BrowserPID: 123}
	s := newManagedSupervisor(listener, info)
	s.statusSnapshot = func() managedMessage {
		return managedMessage{State: "degraded", RunID: info.RunID, Info: &info, NativeEpoch: 1}
	}
	var recoveries atomic.Int32
	s.recoverViewer = func(context.Context) (managedMessage, error) {
		recoveries.Add(1)
		next := info
		next.SocketPath = transport.NewEndpoint("", "fixture-replacement")
		return managedMessage{State: "recovered", RunID: info.RunID, Info: &next, NativeEpoch: 2,
			ViewerURL: "http://127.0.0.1:54321/#ticket=" + strings.Repeat("A", 43)}, nil
	}
	s.serve()
	t.Cleanup(func() { s.stopOnce.Do(func() { close(s.stop) }); s.finish(nil) })
	status, err := managedUserRequest(root, "fixture", "status", time.Second)
	if err != nil || status.State != "degraded" || status.Info.SocketPath != "" || recoveries.Load() != 0 {
		t.Fatalf("degraded status lost management or granted authority: %+v %v", status, err)
	}
	if _, err := managedUserRequest(root, "fixture", "view", time.Second); err == nil || recoveries.Load() != 0 {
		t.Fatal("view implicitly recovered an unavailable connection")
	}
	if _, err := dialBrowserSocketForOptions(socketOptions{managedName: "fixture", managedRoot: root}, time.Second); err == nil || !strings.Contains(err.Error(), "unavailable") {
		t.Fatalf("degraded task discovery was not rejected: %v", err)
	}
	recovered, err := managedUserRequest(root, "fixture", "recover", time.Second)
	if err != nil || recovered.State != "recovered" || recovered.NativeEpoch != 2 || recoveries.Load() != 1 {
		t.Fatalf("explicit recovery did not return its new generation: %+v %v", recovered, err)
	}
}

func TestManagedRecoveryRequiresSameLiveRunAndStopCancelsBeforePublication(t *testing.T) {
	for _, matching := range []bool{false, true} {
		t.Run(map[bool]string{false: "retired-run", true: "stop-during-recovery"}[matching], func(t *testing.T) {
			client, peer := net.Pipe()
			defer client.Close()
			s := newManagedSupervisor(nil, managedbrowser.Info{Name: "fixture", RunID: "current"})
			entered := make(chan struct{})
			s.recoverViewer = func(ctx context.Context) (managedMessage, error) {
				close(entered)
				<-ctx.Done()
				return managedMessage{}, ctx.Err()
			}
			finished := make(chan struct{})
			go func() { s.handle(peer); peer.Close(); close(finished) }()
			client.SetDeadline(time.Now().Add(3 * time.Second))
			if err := wire.WriteJSON(client, managedMessage{Operation: "status"}); err != nil {
				t.Fatal(err)
			}
			if _, err := readManagedMessage(client); err != nil {
				t.Fatal(err)
			}
			id := "retired"
			if matching {
				id = "current"
			}
			if err := wire.WriteJSON(client, managedMessage{Operation: "recover", RunID: id}); err != nil {
				t.Fatal(err)
			}
			if matching {
				select {
				case <-entered:
				case <-time.After(time.Second):
					t.Fatal("recovery was not admitted")
				}
				close(s.stop)
			}
			response, err := readManagedMessage(client)
			if err != nil || response.Error == "" || response.ViewerURL != "" || response.Info != nil {
				t.Fatalf("invalid or canceled recovery published a capability: %+v %v", response, err)
			}
			<-finished
			if !matching {
				select {
				case <-entered:
					t.Fatal("retired run reached recovery")
				default:
				}
			}
		})
	}
}

func TestManagedRecoverClientRejectsUnchangedGeneration(t *testing.T) {
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
	info := managedbrowser.Info{Name: "fixture", RunID: "original", SocketPath: transport.NewEndpoint("", "fixture-original")}
	s := newManagedSupervisor(listener, info)
	s.statusSnapshot = func() managedMessage {
		return managedMessage{State: "ready", RunID: info.RunID, Info: &info, NativeEpoch: 3}
	}
	s.recoverViewer = func(context.Context) (managedMessage, error) {
		return managedMessage{State: "recovered", RunID: info.RunID, Info: &info, NativeEpoch: 3,
			ViewerURL: "http://127.0.0.1:54321/#ticket=" + strings.Repeat("A", 43)}, nil
	}
	s.serve()
	t.Cleanup(func() { s.stopOnce.Do(func() { close(s.stop) }); s.finish(nil) })
	_, err = managedUserRequest(root, "fixture", "recover", time.Second)
	if err == nil || errors.Is(err, context.DeadlineExceeded) || !strings.Contains(err.Error(), "new Native generation") {
		t.Fatalf("unchanged generation accepted as recovery: %v", err)
	}
}

package obu

import (
	"errors"
	"net"
	"testing"
	"time"

	"github.com/ifuryst/open-browser-use/internal/wire"
)

func TestRequestTimeoutDiscardsPartialFrameAndRequiresNewClient(t *testing.T) {
	path, cleanup := startSDKServer(t, func(conn net.Conn) {
		readRequest(t, conn)
		_, _ = conn.Write([]byte{50, 0})
		time.Sleep(80 * time.Millisecond)
	})
	defer cleanup()
	client := NewClient(Options{SocketPath: path, Timeout: 25 * time.Millisecond})
	defer client.Close()
	if _, err := client.GetInfo(); err == nil || errors.Is(err, ErrBrowserDisconnected) {
		t.Fatalf("expected original partial frame timeout, got %v", err)
	}
	if client.conn != nil {
		t.Fatal("timed out stream must be discarded")
	}
	fresh, closeFresh := startSDKServer(t, func(conn net.Conn) {
		request := readRequest(t, conn)
		writeResponse(t, conn, request["id"], "fresh")
	})
	defer closeFresh()
	client.options.SocketPath = fresh
	client.options.Timeout = time.Second
	if _, err := client.GetInfo(); !errors.Is(err, ErrBrowserDisconnected) {
		t.Fatalf("changing endpoint must not revive an old client: %v", err)
	}
	replacement := NewClient(Options{SocketPath: fresh, Timeout: time.Second})
	defer replacement.Close()
	result, err := replacement.GetInfo()
	if err != nil || result != "fresh" {
		t.Fatalf("explicit new client failed: %v, %v", result, err)
	}
}

func TestNotificationsDoNotExtendRequestDeadline(t *testing.T) {
	path, cleanup := startSDKServer(t, func(conn net.Conn) {
		readRequest(t, conn)
		for i := 0; i < 100; i++ {
			if err := wire.WriteJSON(conn, Params{"method": "progress", "params": Params{}}); err != nil {
				return
			}
			time.Sleep(5 * time.Millisecond)
		}
	})
	defer cleanup()
	client := NewClient(Options{SocketPath: path, Timeout: 40 * time.Millisecond})
	defer client.Close()
	started := time.Now()
	if _, err := client.GetInfo(); err == nil {
		t.Fatal("expected timeout despite incoming notifications")
	}
	if time.Since(started) > 300*time.Millisecond {
		t.Fatal("notifications extended request deadline")
	}
}

func TestBrowserActionPreservesEngineAndExtendsTransportBudget(t *testing.T) {
	path, cleanup := startSDKServer(t, func(conn net.Conn) {
		legacyControlHandshake(t, conn)
		request := readRequest(t, conn)
		params := request["params"].(map[string]any)
		timeout, _ := params["timeoutMs"].(float64)
		if request["method"] != "browserAction" || timeout <= 0 || timeout > 200 || params["action"] != "fill" {
			t.Errorf("unexpected request: %#v", request)
		}
		time.Sleep(60 * time.Millisecond)
		writeResponse(t, conn, request["id"], Params{"value": nil, "engine": Params{
			"name": "playwright-crx", "version": "0.15.0", "playwrightVersion": "1.53.0",
		}})
	})
	defer cleanup()
	client := NewClient(Options{SocketPath: path, Timeout: 20 * time.Millisecond})
	defer client.Close()
	response, err := client.BrowserAction(42, "fill", BrowserActionOptions{
		Locator: []Params{{"kind": "label", "value": "Email"}},
		Args:    Params{"value": "reader@example.test"},
		Timeout: 200 * time.Millisecond,
	})
	if err != nil || response.Engine["playwrightVersion"] != "1.53.0" || response.Value != nil {
		t.Fatalf("unexpected browser action result: %#v, %v", response, err)
	}
}

func TestNotificationHandlerCanUnsubscribeWhileRequestIsReading(t *testing.T) {
	path, cleanup := startSDKServer(t, func(conn net.Conn) {
		request := readRequest(t, conn)
		for i := 0; i < 2; i++ {
			if err := wire.WriteJSON(conn, Params{"method": "progress"}); err != nil {
				t.Error(err)
				return
			}
		}
		writeResponse(t, conn, request["id"], "done")
	})
	defer cleanup()
	client := NewClient(Options{SocketPath: path, Timeout: time.Second})
	if err := client.Connect(); err != nil {
		t.Fatal(err)
	}
	// Close the connection directly so a mutex-deadlock regression cannot also
	// deadlock test cleanup through Client.Close.
	defer client.conn.Close()
	count := 0
	var remove func()
	remove = client.OnNotification(func(Notification) { count++; remove() })
	done := make(chan error, 1)
	go func() { _, err := client.GetInfo(); done <- err }()
	select {
	case err := <-done:
		if err != nil || count != 1 {
			t.Fatalf("notification unsubscribe failed: count=%d, err=%v", count, err)
		}
	case <-time.After(2 * time.Second):
		// Avoid hanging deferred Close if a regression holds the request lock.
		t.Error("notification callback deadlocked while removing itself")
		return
	}
}

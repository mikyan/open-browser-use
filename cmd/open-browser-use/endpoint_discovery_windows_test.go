//go:build windows

package main

import (
	"fmt"
	"net"
	"os"
	"testing"
	"time"

	"github.com/ifuryst/open-browser-use/internal/host"
	"github.com/ifuryst/open-browser-use/internal/transport"
	"github.com/ifuryst/open-browser-use/internal/wire"
)

func startDiscoveryPipe(t *testing.T, dir, instance string) string {
	t.Helper()
	path := transport.NewEndpoint(dir, fmt.Sprintf("discovery-%d-%d-%s", os.Getpid(), time.Now().UnixNano(), instance))
	listener, err := transport.Listen(path)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { listener.Close(); host.RemoveEndpointRecord(dir, path) })
	if err := host.WriteEndpointRecord(dir, path); err != nil {
		t.Fatal(err)
	}
	go func() {
		for {
			conn, err := listener.Accept()
			if err != nil {
				return
			}
			go func(conn net.Conn) {
				defer conn.Close()
				for {
					var request map[string]any
					if wire.ReadJSON(conn, &request) != nil {
						return
					}
					if wire.WriteJSON(conn, map[string]any{"jsonrpc": "2.0", "id": request["id"], "result": map[string]any{"metadata": map[string]any{"extensionInstanceId": instance}}}) != nil {
						return
					}
				}
			}(conn)
		}
	}()
	return path
}

func TestNamedPipeMultiInstanceRoutingAndRegistryRecovery(t *testing.T) {
	dir := t.TempDir()
	first := startDiscoveryPipe(t, dir, "first")
	second := startDiscoveryPipe(t, dir, "second")
	if err := host.WriteActiveSocketRecord(dir, second); err != nil {
		t.Fatal(err)
	}
	conn, info, _, err := pickSocketForProfile(dir, "", "first", time.Second)
	if err != nil {
		t.Fatal(err)
	}
	conn.Close()
	if info.SocketPath != first {
		t.Fatalf("routed to wrong instance: %#v", info)
	}
	if err := host.RemoveActiveSocketRecord(dir, first); err != nil {
		t.Fatal(err)
	}
	conn, err = dialBrowserSocket("", dir, time.Second)
	if err != nil {
		t.Fatal(err)
	}
	conn.Close()
	active, err := host.ReadActiveSocketRecord(dir)
	if err != nil || (active.SocketPath != first && active.SocketPath != second) {
		t.Fatalf("registry was not repaired: %#v %v", active, err)
	}
	for _, path := range []string{first, second} {
		if _, err := host.ReadEndpointRecord(host.EndpointRecordPath(dir, path)); err != nil {
			t.Fatalf("live host disappeared: %v", err)
		}
	}
	// Explicit selectors must still be verified when a pipe was pinned.
	if conn, err := dialBrowserSocketForProfile(second, dir, "", "first", time.Second); err == nil {
		conn.Close()
		t.Fatal("pinned wrong instance must fail")
	}
}

package host

import (
	"net"
	"testing"
	"time"
)

func TestLateAndUnknownResponsesAreNeverBroadcast(t *testing.T) {
	relay := NewRelay(Config{}, nil, nil)
	server, client := net.Pipe()
	defer server.Close()
	defer client.Close()
	relay.clients[1] = &clientConn{id: 1, conn: server}
	for _, payload := range []string{
		`{"jsonrpc":"2.0","id":"obu:disconnected","result":{"private":"old-client"}}`,
		`{"jsonrpc":"2.0","id":17,"result":{}}`,
		`{"jsonrpc":"2.0","id":null,"error":{"message":"orphan"}}`,
	} {
		done := make(chan error, 1)
		go func() { done <- relay.dispatchExtensionPayload([]byte(payload)) }()
		select {
		case err := <-done:
			if err != nil {
				t.Fatal(err)
			}
		case <-time.After(time.Second):
			t.Fatal("unmatched response attempted a broadcast to unrelated client")
		}
	}
}

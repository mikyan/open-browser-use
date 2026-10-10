package host

import (
	"encoding/json"
	"fmt"
	"strings"
	"testing"
)

func TestSessionSubscriptionRequiresValidExplicitRequestAndIsBounded(t *testing.T) {
	relay := NewRelay(Config{}, nil, nil)
	client := &clientConn{}
	for _, payload := range []string{
		`not json`, `null`, `{"jsonrpc":"2.0","id":1,"method":"ping","params":{"session_id":42}}`,
		`{"jsonrpc":"2.0","id":1,"method":"ping","params":{"session_id":""}}`,
		`{"jsonrpc":"2.0","method":"ping","params":{"session_id":"notification"}}`,
		`{"id":1,"method":"ping","params":{"session_id":"no-version"}}`,
		`{"jsonrpc":"2.0","id":1,"params":{"session_id":"no-method"}}`,
	} {
		if err := relay.bindRequestSession(client, []byte(payload)); err != nil {
			t.Fatal(err)
		}
	}
	if len(client.sessions) != 0 {
		t.Fatal("invalid request subscribed", client.sessions)
	}
	request := func(session string) []byte {
		bytes, _ := json.Marshal(map[string]any{"jsonrpc": "2.0", "id": 1, "method": "ping", "params": map[string]any{"session_id": session}})
		return bytes
	}
	for index := 0; index < maxClientSessions; index++ {
		if err := relay.bindRequestSession(client, request(fmt.Sprintf("session-%d", index))); err != nil {
			t.Fatal(err)
		}
	}
	if err := relay.bindRequestSession(client, request("session-0")); err != nil {
		t.Fatal("same session must be reusable", err)
	}
	if err := relay.bindRequestSession(client, request("overflow")); err == nil || !strings.Contains(err.Error(), "OBU_SESSION_SUBSCRIPTION_LIMIT") {
		t.Fatal("unbounded subscriptions", err)
	}
	if len(client.sessions) != maxClientSessions {
		t.Fatal(len(client.sessions))
	}
	if err := relay.bindRequestSession(&clientConn{}, request(strings.Repeat("x", maxClientSessionBytes+1))); err == nil {
		t.Fatal("unbounded session label length")
	}
}

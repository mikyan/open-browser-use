package managedbrowser

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/coder/websocket"
)

func TestPrivateBrowserEndpointRejectsForeignOrMalformedRecords(t *testing.T) {
	for _, value := range []string{"", "9222", "0\n/devtools/browser/a", "9222\nhttps://outside.test/", "9222\n/devtools/page/a", "9222\n/devtools/browser/a?token=leak", "9222\n/devtools/browser/a\nignored", "9222\n/devtools/browser/a/b"} {
		if endpoint, err := browserEndpoint([]byte(value)); err == nil {
			t.Fatalf("accepted %q => %s", value, endpoint)
		}
	}
	got, err := browserEndpoint([]byte("9222\r\n/devtools/browser/unique-id\r\n"))
	if err != nil || got != "ws://127.0.0.1:9222/devtools/browser/unique-id" {
		t.Fatalf("%q %v", got, err)
	}
}

func TestBrowserConnectionPreservesResponseIdentityAndOriginalDeadline(t *testing.T) {
	for _, kind := range []string{"ack", "wrong-id", "no-response"} {
		t.Run(kind, func(t *testing.T) {
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				conn, err := websocket.Accept(w, r, nil)
				if err != nil {
					return
				}
				defer conn.CloseNow()
				ctx, cancel := context.WithTimeout(context.Background(), time.Second)
				defer cancel()
				_, data, err := conn.Read(ctx)
				if err != nil {
					return
				}
				var request struct {
					ID int64 `json:"id"`
				}
				if json.Unmarshal(data, &request) != nil {
					return
				}
				if kind == "no-response" {
					_, _, _ = conn.Read(ctx)
					return
				}
				if kind == "wrong-id" {
					request.ID++
				}
				_ = conn.Write(ctx, websocket.MessageText, []byte(`{"method":"Target.changed","params":{}}`))
				payload, _ := json.Marshal(map[string]any{"id": request.ID, "result": map[string]any{"product": "Chrome/test"}})
				_ = conn.Write(ctx, websocket.MessageText, payload)
				_, _, _ = conn.Read(ctx)
			}))
			defer server.Close()
			ctx, cancel := context.WithTimeout(context.Background(), 150*time.Millisecond)
			defer cancel()
			conn, err := connectBrowser(ctx, strings.Replace(server.URL, "http:", "ws:", 1)+"/devtools/browser/exact")
			if err != nil {
				t.Fatal(err)
			}
			defer conn.close()
			var result map[string]any
			err = conn.call(ctx, "Browser.getVersion", map[string]any{}, &result)
			if kind == "ack" && (err != nil || result["product"] != "Chrome/test") {
				t.Fatalf("ack %v %v", result, err)
			}
			if kind != "ack" && err == nil {
				t.Fatalf("accepted %s", kind)
			}
			if kind == "no-response" && !errors.Is(err, context.DeadlineExceeded) {
				t.Fatalf("deadline replaced: %v", err)
			}
		})
	}
}

func TestExpiredContextCannotSendBrowserCommand(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	// No connection is available: a canceled call must reject before it could
	// touch a live browser, not write then discover that its timer expired.
	conn := &browserConnection{gate: make(chan struct{}, 1)}
	if err := conn.call(ctx, "Browser.close", map[string]any{}, nil); !errors.Is(err, context.Canceled) {
		t.Fatal(err)
	}
}

func TestBrowserArgumentsRejectProfileSwapAndSandboxBypass(t *testing.T) {
	wanted := browserArguments("private-profile", "staged-extension", "private-log")
	if err := validateBrowserArguments(wanted, wanted); err != nil {
		t.Fatal(err)
	}
	for _, extra := range []string{"--user-data-dir=normal-profile", "--no-sandbox", "--no-sandbox=true", "--remote-debugging-port=9222"} {
		if err := validateBrowserArguments(append(append([]string{}, wanted...), extra), wanted); err == nil {
			t.Fatalf("accepted %s", extra)
		}
	}
}

func TestBindingRequiresSameExtensionInstance(t *testing.T) {
	info := Info{ExtensionID: "expected-extension", ExtensionInstanceID: "expected-instance"}
	base := map[string]any{"bound": true, "exclusive": true, "behavior": "default", "extensionId": info.ExtensionID, "extensionInstanceId": info.ExtensionInstanceID, "generation": "generation", "workerBootId": "worker", "portId": "port"}
	data, _ := json.Marshal(base)
	if err := validateBinding(data, info); err != nil {
		t.Fatal(err)
	}
	for _, field := range []string{"bound", "exclusive", "behavior", "extensionId", "extensionInstanceId", "generation", "workerBootId", "portId"} {
		value := base[field]
		delete(base, field)
		data, _ := json.Marshal(base)
		if err := validateBinding(data, info); err == nil {
			t.Fatalf("accepted missing %s", field)
		}
		base[field] = value
	}
	base["extensionInstanceId"] = "different-instance"
	data, _ = json.Marshal(base)
	if err := validateBinding(data, info); err == nil {
		t.Fatal("accepted different real native port instance")
	}
}

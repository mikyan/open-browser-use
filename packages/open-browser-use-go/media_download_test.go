package obu

import (
	"fmt"
	"net"
	"strings"
	"testing"
	"time"

	"github.com/ifuryst/open-browser-use/internal/wire"
)

func TestMediaDownloadCapabilityAndManualScope(t *testing.T) {
	for _, manual := range []bool{false, true} {
		for _, version := range []any{false, true, 0, 2, "1", nil} {
			t.Run(fmt.Sprintf("manual-%v-version-%v", manual, version), func(t *testing.T) {
				path, cleanup := startSDKServer(t, func(conn net.Conn) {
					req := readRequest(t, conn)
					if req["method"] != "getInfo" {
						t.Errorf("expected negotiation: %v", req)
					}
					writeResponse(t, conn, req["id"], Params{"metadata": Params{"turnLifecycleVersion": 1, "mediaDownloadsVersion": version}})
					if !manual {
						req = readRequest(t, conn)
						if req["method"] != "getControlState" {
							t.Errorf("expected bootstrap: %v", req)
						}
						writeResponse(t, conn, req["id"], testControlState(7, "next"))
					}
					req = readRequest(t, conn)
					if req["method"] != "ping" {
						t.Errorf("unsupported media must not be sent/replayed: %v", req)
					}
					writeResponse(t, conn, req["id"], Params{})
				})
				defer cleanup()
				client := NewClient(Options{SocketPath: path, TurnID: "initial"})
				defer client.Close()
				var err error
				if manual {
					_, err = client.Request("downloadMedia", Params{"tabId": 9, "locator": []Params{{"kind": "css", "selector": "img"}}, "session_id": "manual", "turn_id": "manual-turn", "control_epoch": 19})
				} else {
					_, err = NewBrowser(client).Tab(9).Locator("img").DownloadMedia()
				}
				if err == nil || !strings.Contains(err.Error(), "OBU_MEDIA_DOWNLOADS_UNSUPPORTED") {
					t.Fatalf("capability accepted: %v", err)
				}
				if _, err = client.Request("ping", nil); err != nil {
					t.Fatal(err)
				}
			})
		}
	}
}

func TestMediaDownloadInvalidOptionsBeforeConnection(t *testing.T) {
	client := NewClient(Options{SocketPath: "unused"})
	defer client.Close()
	locator := NewBrowser(client).Tab(9).Locator("img")
	for _, filename := range []string{"../x", "CON.png", "a\\b", "a.", "a ", "a\x00", strings.Repeat("🙂", 64)} {
		if _, err := locator.DownloadMedia(MediaDownloadOptions{Filename: filename}); err == nil || !strings.Contains(err.Error(), "filename") {
			t.Errorf("filename=%q: %v", filename, err)
		}
	}
	for _, timeout := range []time.Duration{-1, time.Microsecond, 121 * time.Second} {
		if _, err := locator.DownloadMedia(MediaDownloadOptions{Timeout: timeout}); err == nil || !strings.Contains(err.Error(), "timeout") {
			t.Errorf("timeout=%v: %v", timeout, err)
		}
	}
	if _, err := locator.DownloadMedia(MediaDownloadOptions{}, MediaDownloadOptions{}); err == nil {
		t.Error("multiple options accepted")
	}
	if _, err := (&Locator{Tab: NewBrowser(client).Tab(9)}).DownloadMedia(); err == nil || !strings.Contains(err.Error(), "nonempty locator") {
		t.Errorf("empty locator accepted: %v", err)
	}
}

func TestMediaDownloadManualCapabilityOneKeepsCallerScope(t *testing.T) {
	path, cleanup := startSDKServer(t, func(conn net.Conn) {
		req := readRequest(t, conn)
		if req["method"] != "getInfo" {
			t.Errorf("missing capability negotiation: %v", req)
		}
		writeResponse(t, conn, req["id"], Params{"metadata": Params{"turnLifecycleVersion": 1, "mediaDownloadsVersion": 1}})
		req = readRequest(t, conn)
		params := req["params"].(map[string]any)
		if req["method"] != "downloadMedia" || params["session_id"] != "manual" || params["turn_id"] != "manual-turn" || params["control_epoch"] != float64(19) {
			t.Errorf("manual scope changed: %v", req)
		}
		if _, ok := params["url"]; ok {
			t.Error("caller injected URL")
		}
		writeResponse(t, conn, req["id"], Params{"downloadId": "media"})
	})
	defer cleanup()
	client := NewClient(Options{SocketPath: path, TurnID: "initial"})
	defer client.Close()
	_, err := client.Request("downloadMedia", Params{"tabId": 9, "locator": []Params{{"kind": "css", "selector": "img"}}, "session_id": "manual", "turn_id": "manual-turn", "control_epoch": 19})
	if err != nil {
		t.Fatal(err)
	}
	if client.control.epoch != 0 || client.control.turnID != "initial" {
		t.Errorf("manual action rebound client: %v", client.control)
	}
}

func TestMediaDownloadOriginalShortDeadline(t *testing.T) {
	for _, raw := range []bool{false, true} {
		t.Run(fmt.Sprint(raw), func(t *testing.T) {
			path, cleanup := startSDKServer(t, func(conn net.Conn) {
				req := readRequest(t, conn)
				time.Sleep(250 * time.Millisecond)
				writeResponse(t, conn, req["id"], directDownloadInfo())
				req = readRequest(t, conn)
				if req["method"] != "getControlState" {
					t.Errorf("unexpected: %v", req)
				}
				writeResponse(t, conn, req["id"], testControlState(7, "next"))
				req = readRequest(t, conn)
				if req["method"] != "ping" {
					t.Errorf("expired download was sent: %v", req)
				}
				writeResponse(t, conn, req["id"], Params{})
			})
			defer cleanup()
			client := NewClient(Options{SocketPath: path, Timeout: 10 * time.Second})
			defer client.Close()
			var err error
			if raw {
				_, err = client.Request("downloadMedia", Params{"tabId": 9, "locator": []Params{{"kind": "css", "selector": "img"}}, "timeoutMs": 100})
			} else {
				_, err = NewBrowser(client).Tab(9).Locator("img").DownloadMedia(MediaDownloadOptions{Timeout: 100 * time.Millisecond})
			}
			if err == nil || !strings.Contains(err.Error(), "deadline") {
				t.Fatalf("deadline=%v", err)
			}
			if _, err = client.Request("ping", nil); err != nil {
				t.Fatal(err)
			}
		})
	}
}

func TestMediaDownloadSingleRPCNoReplayAndOriginalScope(t *testing.T) {
	for _, message := range []string{"OBU_DOWNLOAD_TIMEOUT", "OBU_STALE_CONTROL_EPOCH", "OBU_MEDIA_SOURCE_UNSUPPORTED"} {
		t.Run(message, func(t *testing.T) {
			path, cleanup := startSDKServer(t, func(conn net.Conn) {
				req := readRequest(t, conn)
				writeResponse(t, conn, req["id"], directDownloadInfo())
				req = readRequest(t, conn)
				writeResponse(t, conn, req["id"], testControlState(7, "next"))
				req = readRequest(t, conn)
				if req["method"] != "downloadMedia" {
					t.Errorf("not one media RPC: %v", req)
				}
				params := req["params"].(map[string]any)
				if params["session_id"] != "media-test" || params["turn_id"] != "initial" || params["control_epoch"] != float64(7) {
					t.Errorf("scope drift: %v", params)
				}
				if _, ok := params["url"]; ok {
					t.Error("caller injected URL")
				}
				steps := params["locator"].([]any)
				if len(steps) != 2 || steps[0].(map[string]any)["kind"] != "frame" || steps[1].(map[string]any)["selector"] != "img" {
					t.Errorf("locator=%v", steps)
				}
				if err := wire.WriteJSON(conn, Params{"id": req["id"], "error": Params{"message": message}}); err != nil {
					t.Error(err)
				}
				req = readRequest(t, conn)
				if req["method"] != "ping" {
					t.Errorf("media replayed/refreshed: %v", req)
				}
				writeResponse(t, conn, req["id"], Params{})
			})
			defer cleanup()
			client := NewClient(Options{SocketPath: path, SessionID: "media-test", TurnID: "initial"})
			defer client.Close()
			_, err := NewBrowser(client).Tab(9).FrameLocator("#child").Locator("img").DownloadMedia(MediaDownloadOptions{Timeout: time.Second})
			if err == nil || !strings.Contains(err.Error(), message) {
				t.Fatalf("error=%v", err)
			}
			if client.control.epoch != 7 || client.control.turnID != "initial" {
				t.Errorf("error rebound client: %v", client.control)
			}
			if _, err = client.Request("ping", nil); err != nil {
				t.Fatal(err)
			}
		})
	}
}

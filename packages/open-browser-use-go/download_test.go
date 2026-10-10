package obu

import (
	"net"
	"strings"
	"testing"
	"time"

	"github.com/ifuryst/open-browser-use/internal/wire"
)

func directDownloadInfo() Params {
	return Params{"metadata": Params{"turnLifecycleVersion": 1, "directDownloadsVersion": 1}}
}

func TestDownloadPathRetryCancellationAndScope(t *testing.T) {
	for _, source := range []string{"downloadURL", "waitForDownload"} {
		t.Run(source, func(t *testing.T) {
			done := make(chan struct{})
			path, cleanup := startSDKServer(t, func(conn net.Conn) {
				defer close(done)
				methods := []string{"getInfo", "getControlState", source, "downloadPath", "downloadPath", "cancelDownload", "getControlState", "downloadPath", "cancelDownload"}
				for index, method := range methods {
					req := readRequest(t, conn)
					if req["method"] != method {
						t.Errorf("method=%v want=%s", req["method"], method)
					}
					params := req["params"].(map[string]any)
					if index >= 2 && method != "getControlState" {
						if params["turn_id"] != "initial" || params["control_epoch"] != float64(7) {
							t.Errorf("scope drift: %#v", params)
						}
						if budget, ok := params["timeoutMs"].(float64); !ok || budget <= 0 || budget > 1000 {
							t.Errorf("budget=%v", params["timeoutMs"])
						}
					}
					var value any = Params{}
					switch method {
					case "getInfo":
						value = directDownloadInfo()
					case "getControlState":
						if index == 1 {
							value = testControlState(7, "next")
						} else {
							value = testControlState(8, "next")
						}
					case "downloadURL":
						if params["url"] != "https://fixture.test/file" || params["filename"] != "报告.csv" {
							t.Errorf("start options=%#v", params)
						}
						value = Params{"downloadId": "opaque"}
					case "waitForDownload":
						value = Params{"downloadId": "opaque"}
					case "downloadPath":
						value = Params{"path": `C:\Downloads\报告.csv`}
					case "cancelDownload":
						value = Params{"cancelled": true}
					}
					message := ""
					if index == 3 {
						message = "OBU_DOWNLOAD_TIMEOUT"
					}
					if index >= 7 {
						message = "OBU_STALE_CONTROL_EPOCH"
					}
					if message != "" {
						if err := wire.WriteJSON(conn, Params{"id": req["id"], "error": Params{"message": message}}); err != nil {
							t.Error(err)
						}
					} else {
						writeResponse(t, conn, req["id"], value)
					}
				}
			})
			defer cleanup()
			client := NewClient(Options{SocketPath: path, TurnID: "initial"})
			defer client.Close()
			tab := NewBrowser(client).Tab(9)
			var item *Download
			var err error
			if source == "downloadURL" {
				item, err = tab.DownloadURL("https://fixture.test/file", DownloadURLOptions{Filename: "报告.csv", Timeout: time.Second})
			} else {
				item, err = tab.WaitForDownload(DownloadOptions{Timeout: time.Second})
			}
			if err != nil {
				t.Fatal(err)
			}
			if item.DownloadID != "opaque" {
				t.Fatal(item.DownloadID)
			}
			if _, err = item.Path(DownloadOptions{Timeout: time.Second}); err == nil || !strings.Contains(err.Error(), "OBU_DOWNLOAD_TIMEOUT") {
				t.Fatalf("path timeout: %v", err)
			}
			if actual, err := item.Path(DownloadOptions{Timeout: time.Second}); err != nil || actual != `C:\Downloads\报告.csv` {
				t.Fatalf("path=%s err=%v", actual, err)
			}
			if err := item.Cancel(DownloadOptions{Timeout: time.Second}); err != nil {
				t.Fatal(err)
			}
			if _, err := client.BeginTurn(); err != nil {
				t.Fatal(err)
			}
			if _, err := item.Path(DownloadOptions{Timeout: time.Second}); err == nil || !strings.Contains(err.Error(), "OBU_STALE_CONTROL_EPOCH") {
				t.Fatalf("old path=%v", err)
			}
			if err := item.Cancel(DownloadOptions{Timeout: time.Second}); err == nil || !strings.Contains(err.Error(), "OBU_STALE_CONTROL_EPOCH") {
				t.Fatalf("old cancel=%v", err)
			}
			<-done
		})
	}
}

func TestDownloadShortBudgetIncludesDiscovery(t *testing.T) {
	for _, raw := range []bool{false, true} {
		path, cleanup := startSDKServer(t, func(conn net.Conn) {
			req := readRequest(t, conn)
			time.Sleep(250 * time.Millisecond)
			writeResponse(t, conn, req["id"], directDownloadInfo())
			req = readRequest(t, conn)
			if req["method"] != "getControlState" {
				t.Errorf("unexpected: %#v", req)
			}
			writeResponse(t, conn, req["id"], testControlState(7, "next"))
			_ = conn.SetReadDeadline(time.Now().Add(time.Second))
			var extra map[string]any
			if err := wire.ReadJSON(conn, &extra); err == nil {
				t.Errorf("expired start sent: %#v", extra)
			}
		})
		client := NewClient(Options{SocketPath: path, Timeout: 10 * time.Second})
		var err error
		if raw {
			_, err = client.Request("downloadURL", Params{"tabId": 9, "url": "https://fixture.test/", "timeoutMs": 100})
		} else {
			_, err = NewBrowser(client).Tab(9).DownloadURL("https://fixture.test/", DownloadURLOptions{Timeout: 100 * time.Millisecond})
		}
		if err == nil || !strings.Contains(err.Error(), "deadline") {
			t.Fatalf("deadline=%v", err)
		}
		client.Close()
		cleanup()
	}
}

func TestDownloadValidationAndUnsupportedVersion(t *testing.T) {
	tab := NewBrowser(NewClient(Options{SocketPath: "unused"})).Tab(9)
	for _, url := range []string{"", "file:///tmp/a", "data:text/plain,a", "https://user:pass@fixture.test/", "https://fixture.test/\n", "https://fixture.test/" + strings.Repeat("🙂", 2048)} {
		if _, err := tab.DownloadURL(url); err == nil {
			t.Errorf("invalid URL accepted: %q", url)
		}
	}
	for _, name := range []string{"..", "../a", "CON.txt", "a/b", `a\b`, "a.", "a ", "a\x00", strings.Repeat("🙂", 64)} {
		if _, err := tab.DownloadURL("https://fixture.test/", DownloadURLOptions{Filename: name}); err == nil {
			t.Errorf("invalid filename accepted: %q", name)
		}
	}
	for _, timeout := range []time.Duration{-1, time.Microsecond, 121 * time.Second} {
		if _, err := tab.DownloadURL("https://fixture.test/", DownloadURLOptions{Timeout: timeout}); err == nil {
			t.Error("invalid timeout accepted")
		}
	}
	path, cleanup := startSDKServer(t, func(conn net.Conn) { legacyControlHandshake(t, conn) })
	defer cleanup()
	client := NewClient(Options{SocketPath: path})
	defer client.Close()
	if _, err := NewBrowser(client).Tab(9).DownloadURL("https://fixture.test/"); err == nil || !strings.Contains(err.Error(), "OBU_DIRECT_DOWNLOADS_UNSUPPORTED") {
		t.Fatalf("unsupported=%v", err)
	}
}

func TestDownloadRejectsMalformedAcknowledgements(t *testing.T) {
	for _, method := range []string{"downloadURL", "downloadPath", "cancelDownload"} {
		t.Run(method, func(t *testing.T) {
			path, cleanup := startSDKServer(t, func(conn net.Conn) {
				req := readRequest(t, conn)
				writeResponse(t, conn, req["id"], directDownloadInfo())
				req = readRequest(t, conn)
				writeResponse(t, conn, req["id"], testControlState(7, "next"))
				req = readRequest(t, conn)
				if method == "downloadURL" {
					writeResponse(t, conn, req["id"], Params{"downloadId": "d", "path": "untrusted"})
					return
				}
				writeResponse(t, conn, req["id"], Params{"downloadId": "d"})
				req = readRequest(t, conn)
				if method == "downloadPath" {
					writeResponse(t, conn, req["id"], Params{"path": ""})
				} else {
					writeResponse(t, conn, req["id"], Params{"cancelled": 1})
				}
			})
			defer cleanup()
			client := NewClient(Options{SocketPath: path})
			defer client.Close()
			item, err := NewBrowser(client).Tab(9).DownloadURL("https://fixture.test/")
			if method == "downloadURL" {
				if err == nil {
					t.Fatal("malformed start accepted")
				}
				return
			}
			if err != nil {
				t.Fatal(err)
			}
			if method == "downloadPath" {
				_, err = item.Path()
			} else {
				err = item.Cancel()
			}
			if err == nil || !strings.Contains(err.Error(), "acknowledgement") {
				t.Fatalf("malformed response accepted: %v", err)
			}
		})
	}
}

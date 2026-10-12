package main

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
	"time"

	"github.com/ifuryst/open-browser-use/internal/transport"
	"github.com/ifuryst/open-browser-use/internal/wire"
)

func TestTypedOriginalDownloadUsesExactNativeScopeAndSingleTrigger(t *testing.T) {
	for _, variant := range []string{"root", "oopif", "dynamic-oopif"} {
		for _, kind := range []string{"post", "blob"} {
			t.Run(variant+"/"+kind, func(t *testing.T) { exerciseNativeHelper(t, variant, kind, "") })
		}
	}
}

func TestOriginalDownloadStopsOnChangedEpochAndPreservesClickCleanupErrors(t *testing.T) {
	for _, mode := range []string{"changed-epoch", "click-and-cleanup-fail", "gate-timeout", "gate-token", "gate-add-late"} {
		t.Run(mode, func(t *testing.T) {
			variant := "root"
			if strings.HasPrefix(mode, "gate-") {
				variant = "dynamic-oopif"
			}
			exerciseNativeHelper(t, variant, "post", mode)
		})
	}
}

func exerciseNativeHelper(t *testing.T, variant, kind, mode string) {
	t.Helper()
	temporary, err := repositoryTmp()
	if err != nil {
		t.Fatal(err)
	}
	gateDirectory, err := os.MkdirTemp(temporary, "original-go-gate-")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = os.RemoveAll(gateDirectory) })
	gate := readyGate{filepath.Join(gateDirectory, "ready.json"), filepath.Join(gateDirectory, "release"), "original-gate-token"}
	helperDone, gateDone := make(chan struct{}), make(chan error, 1)
	go func() {
		end := time.Now().Add(3 * time.Second)
		for time.Now().Before(end) {
			select {
			case <-helperDone:
				gateDone <- nil
				return
			default:
			}
			data, err := os.ReadFile(gate.ReadyPath)
			var ready map[string]any
			if err != nil || json.Unmarshal(data, &ready) != nil {
				time.Sleep(2 * time.Millisecond)
				continue
			}
			if ready["token"] != gate.Token || ready["waiterId"] != "original-waiter" || ready["tabId"] != float64(9) {
				gateDone <- fmt.Errorf("invalid published ready record: %v", ready)
				return
			}
			if mode == "gate-timeout" {
				gateDone <- nil
				return
			}
			token := gate.Token
			if mode == "gate-token" {
				token = "unknown-token"
			}
			pending := filepath.Join(gateDirectory, "release.tmp")
			if err := os.WriteFile(pending, []byte(token), 0600); err != nil {
				gateDone <- err
				return
			}
			gateDone <- os.Rename(pending, gate.ReleasePath)
			return
		}
		gateDone <- fmt.Errorf("helper never published readiness")
	}()
	endpoint := filepath.Join(os.TempDir(), fmt.Sprintf("obu-original-%d.sock", time.Now().UnixNano()))
	if runtime.GOOS == "windows" {
		endpoint = fmt.Sprintf(`\\.\pipe\obu-original-%d`, time.Now().UnixNano())
	}
	listener, err := transport.Listen(endpoint)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = listener.Close(); _ = transport.RemoveEndpoint(endpoint) })
	header := map[string]string{"key": "original-key", "kind": kind, "owner": "original-owner", "nonce": "01234567-89ab-4cde-8fab-0123456789ab"}
	content, _ := json.Marshal(header)
	content = append(content, []byte{'\n', 0, 255, 195, 40}...)
	digest := sha256.Sum256(content)
	path := filepath.Join(t.TempDir(), "original.bin")
	if err := os.WriteFile(path, content, 0600); err != nil {
		t.Fatal(err)
	}
	finished := make(chan error, 1)
	var methods, actions []string
	go func() {
		conn, err := listener.Accept()
		if err != nil {
			finished <- err
			return
		}
		defer conn.Close()
		_ = conn.SetDeadline(time.Now().Add(10 * time.Second))
		controls, clicks, adds := 0, 0, 0
		for {
			data, err := wire.ReadFrame(conn, 1<<20)
			if err != nil {
				finished <- nil // The helper's actual Close ends this connection.
				return
			}
			var request map[string]any
			if err := json.Unmarshal(data, &request); err != nil {
				finished <- err
				return
			}
			method := request["method"].(string)
			params := request["params"].(map[string]any)
			methods = append(methods, method)
			if params["session_id"] != "owner-session" || params["turn_id"] != "original-turn" ||
				(method != "getInfo" && method != "getControlState" && params["control_epoch"] != float64(7)) {
				finished <- fmt.Errorf("request scope changed: %v", request)
				return
			}
			var result any = map[string]any{}
			failure := ""
			switch method {
			case "getInfo":
				result = map[string]any{"metadata": map[string]any{"turnLifecycleVersion": 1, "downloadWaitVersion": 1, "downloadWaitPathVersion": 1, "directDownloadsVersion": 1}}
			case "getControlState":
				controls++
				epoch := 7
				if mode == "changed-epoch" && controls == 3 {
					epoch++
				}
				result = map[string]any{"lifecycleVersion": 1, "controlEpoch": epoch, "closing": false, "nextTurnId": "must-not-adopt"}
			case "armDownloadWait":
				if params["requirePath"] != true {
					t.Errorf("original-file helper did not require path readiness: %#v", params)
				}
				remaining := 14000
				if mode == "gate-timeout" {
					remaining = 100
				} else if mode == "gate-add-late" {
					remaining = 500
				}
				result = map[string]any{"waiterId": "original-waiter", "remainingMs": remaining}
			case "collectDownloadWait":
				result = map[string]any{"downloadId": "original-native-guid"}
			case "downloadPath":
				if params["downloadId"] != "original-native-guid" || params["tabId"] != float64(9) {
					finished <- fmt.Errorf("download scope changed: %v", params)
					return
				}
				result = map[string]any{"path": path}
			case "cancelDownloadWait":
				if mode == "click-and-cleanup-fail" {
					failure = "cleanup original failure"
				}
			case "browserAction":
				action := params["action"].(string)
				steps := params["locator"].([]any)
				last := steps[len(steps)-1].(map[string]any)
				var value any
				if action == "click" {
					token, err := os.ReadFile(gate.ReleasePath)
					if err != nil || string(token) != gate.Token {
						finished <- fmt.Errorf("input preceded shared ready barrier")
						return
					}
					name := last["name"].(string)
					actions = append(actions, name)
					if name == "Add download frame" {
						adds++
						if mode == "gate-add-late" {
							timeout, ok := params["timeoutMs"].(float64)
							if !ok || timeout <= 0 || timeout > 500 {
								finished <- fmt.Errorf("Add timeout exceeds original wait remainder: %v", params["timeoutMs"])
								return
							}
							time.Sleep(600 * time.Millisecond)
						}
					} else if name == "Download original report" {
						clicks++
						if mode == "click-and-cleanup-fail" {
							failure = "click original failure"
						}
					} else {
						failure = "unexpected input target"
					}
				} else if action == "textContent" && last["selector"] == "#state" {
					leaf := variant == "root" || steps[0].(map[string]any)["kind"] == "frame"
					page := map[string]any{"key": "original-key", "kind": kind, "owner": "original-owner", "documentToken": "document-original", "expectedSHA": hex.EncodeToString(digest[:]), "clicks": []any{}, "frameAdds": []any{}}
					if leaf && clicks > 0 {
						click := map[string]any{"trusted": true, "buttonCount": clicks, "documentToken": "document-original"}
						if kind == "blob" {
							click["revoked"], click["blobURL"], page["blobURL"] = true, "blob:original", "blob:original"
						}
						page["clicks"] = []any{click}
					}
					if !leaf && adds > 0 {
						page["frameAdds"] = []any{map[string]any{"trusted": true}}
					}
					encoded, _ := json.Marshal(page)
					value = string(encoded)
				} else {
					failure = "unexpected browser action"
				}
				result = map[string]any{"value": value, "engine": map[string]any{"name": "playwright-crx", "version": "0.15.0", "playwrightVersion": "1.53.0"}}
			default:
				failure = "unexpected method " + method
			}
			response := map[string]any{"id": request["id"], "result": result}
			if failure != "" {
				delete(response, "result")
				response["error"] = map[string]any{"message": failure}
			}
			if err := wire.WriteJSON(conn, response); err != nil {
				finished <- err
				return
			}
		}
	}()
	raw, _ := json.Marshal(input{endpoint, "owner-session", "original-turn", 7, 9, variant, "original-key", kind, gate})
	detail := run(raw)
	close(helperDone)
	if err := <-gateDone; err != nil {
		t.Fatal(err)
	}
	select {
	case err := <-finished:
		if err != nil {
			t.Fatal(err)
		}
	case <-time.After(2 * time.Second):
		t.Fatal("helper did not close the original native connection")
	}
	if mode == "" {
		if detail["ok"] != true || detail["productPath"] != path || detail["file"].(map[string]any)["sha256"] != hex.EncodeToString(digest[:]) {
			t.Fatalf("typed helper: %#v", detail)
		}
	} else {
		if detail["ok"] != false {
			t.Fatalf("failure was accepted: %#v", detail)
		}
		failure := detail["error"].(map[string]any)
		if mode == "changed-epoch" && (failure["stage"] != "scopeAfter" || len(actions) != 0 || strings.Contains(strings.Join(methods, ","), "armDownloadWait")) {
			t.Fatalf("changed epoch was used: %#v %v", detail, methods)
		}
		if mode == "click-and-cleanup-fail" && (failure["message"] != "click original failure" || detail["waitCleanup"].(map[string]any)["ok"] != false) {
			t.Fatalf("lost primary error: %#v", detail)
		}
		if strings.HasPrefix(mode, "gate-") {
			wantStage := "gate"
			if mode == "gate-add-late" {
				wantStage = "addFrame"
				if !strings.Contains(failure["message"].(string), "original download wait deadline expired") {
					t.Fatalf("late Add ACK did not reach original deadline guard: %#v", detail)
				}
			}
			stages := detail["stages"].([]map[string]any)
			last := stages[len(stages)-1]
			if failure["stage"] != wantStage || detail["waitCleanup"].(map[string]any)["ok"] != true ||
				strings.Contains(strings.Join(methods, ","), "collectDownloadWait") || strings.Contains(strings.Join(methods, ","), "downloadPath") ||
				detail["triggerAt"] != nil || last["name"] != "close" || last["ok"] != true {
				t.Fatalf("gate failure submitted input or lost cleanup: %#v %v", detail, methods)
			}
		}
	}
	wants := 1
	if mode == "gate-add-late" {
		wants = 1
		if len(actions) != 1 || actions[0] != "Add download frame" {
			t.Fatal("late Add ACK triggered a download", actions)
		}
	} else if mode == "changed-epoch" || strings.HasPrefix(mode, "gate-") {
		wants = 0
	} else if variant == "dynamic-oopif" {
		wants = 2
	}
	if len(actions) != wants {
		t.Fatal("trigger replay or unexpected input", actions)
	}
	controlCount := 0
	for _, method := range methods {
		if method == "getControlState" {
			controlCount++
		}
	}
	if controlCount != 3 {
		t.Fatal("unexpected turn renewal or scope handshake", methods)
	}
}

func TestOriginalFileRejectsNonregularOversizeAndMalformedHeaders(t *testing.T) {
	for _, content := range [][]byte{nil, []byte("not-json\n"), []byte(`{"key":"x","kind":"post","owner":"y","nonce":"wrong"}` + "\n"), make([]byte, fileLimit+1)} {
		path := filepath.Join(t.TempDir(), "bad.bin")
		if err := os.WriteFile(path, content, 0600); err != nil {
			t.Fatal(err)
		}
		if _, err := readOriginalFile(path); err == nil {
			t.Fatal("accepted invalid original file")
		}
	}
	if _, err := readOriginalFile(t.TempDir()); err == nil {
		t.Fatal("accepted a directory")
	}
}

func TestMissingOrNullTabIDDoesNotConnect(t *testing.T) {
	for _, extra := range []string{"", `,"tabId":null`} {
		raw := []byte(`{"socketPath":"must-not-connect","sessionId":"s","turnId":"t","controlEpoch":1,"variant":"root","key":"k","kind":"post","readyGate":{"readyPath":"/unused","releasePath":"/unused-release","token":"token"}` + extra + `}`)
		detail := run(raw)
		if detail["ok"] != false || detail["error"].(map[string]any)["stage"] != "input" || len(detail["stages"].([]map[string]any)) != 1 {
			t.Fatalf("invalid tab ID reached connection setup: %#v", detail)
		}
	}
}

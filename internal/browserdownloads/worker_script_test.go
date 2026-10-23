package browserdownloads

import (
	"context"
	"strings"
	"testing"
	"time"
)

func TestWorkerScriptMustBeOneExactKnownEntry(t *testing.T) {
	endpoint := "ws://127.0.0.1:9222/devtools/browser/original"
	for _, script := range []string{"", "background.js", "managed-worker-" + strings.Repeat("a", 32) + ".js"} {
		if err := ValidateDialOptions(endpoint, DialOptions{WorkerScript: script}); err != nil {
			t.Fatalf("valid worker entry %q: %v", script, err)
		}
	}
	for _, script := range []string{"worker.js", "../background.js", "/background.js", "background.js?run=1", "background.js#1", "chrome-extension://foreign/background.js", "managed-worker-" + strings.Repeat("a", 31) + ".js", "managed-worker-" + strings.Repeat("A", 32) + ".js", "managed-worker-" + strings.Repeat("g", 32) + ".js", "managed-worker-" + strings.Repeat("a", 32) + ".js/extra"} {
		wantError(t, ValidateDialOptions(endpoint, DialOptions{WorkerScript: script}), "IDENTITY")
	}
}

func TestWorkerScriptSelectionRetainsOriginalFiveFieldChallenge(t *testing.T) {
	managed := "managed-worker-" + strings.Repeat("a", 32) + ".js"
	for _, kind := range []string{"default", "ordinary-explicit", "managed", "wrong-run", "foreign-origin", "duplicate", "wrong-nonce", "extra-challenge-field"} {
		t.Run(kind, func(t *testing.T) {
			script, presented := managed, managed
			if kind == "default" || kind == "ordinary-explicit" {
				script, presented = "background.js", "background.js"
			}
			if kind == "default" {
				script = ""
			}
			if kind == "wrong-run" {
				presented = "managed-worker-" + strings.Repeat("b", 32) + ".js"
			}
			p := newPeer(t, "", func(p *browserPeer, req nativeRequest) bool {
				if req.Method == "Target.getTargets" {
					origin := p.identity.ExtensionID
					if kind == "foreign-origin" {
						origin = strings.Repeat("b", 32)
					}
					target := map[string]any{"targetId": "worker-target", "type": "service_worker", "url": "chrome-extension://" + origin + "/" + presented}
					targets := []any{target, map[string]any{"targetId": "wrong-type", "type": "page", "url": target["url"]}}
					if kind == "managed" {
						targets = append(targets, map[string]any{"targetId": "old-worker", "type": "service_worker", "url": "chrome-extension://" + origin + "/background.js"})
					}
					if kind == "duplicate" {
						targets = append(targets, target)
					}
					p.respond(req, map[string]any{"targetInfos": targets})
					return true
				}
				if req.Method == "Runtime.evaluate" && (kind == "wrong-nonce" || kind == "extra-challenge-field") {
					proof := map[string]any{"nonce": p.identity.Nonce, "extensionId": p.identity.ExtensionID, "extensionInstanceId": p.identity.ExtensionInstanceID, "workerBootId": p.identity.WorkerBootID, "portId": p.identity.PortID}
					if kind == "wrong-nonce" {
						proof["nonce"] = "foreign-port-nonce"
					} else {
						proof["workerScript"] = script
					}
					p.respond(req, map[string]any{"result": map[string]any{"type": "object", "value": proof}})
					return true
				}
				return false
			})
			ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
			defer cancel()
			manager, err := DialWithOptions(ctx, p.url(), testIdentity, DialOptions{WorkerScript: script})
			accepted := kind == "default" || kind == "ordinary-explicit" || kind == "managed"
			if accepted {
				if err != nil {
					t.Fatal(err)
				}
				if err := manager.Close(); err != nil {
					t.Fatal(err)
				}
			} else {
				wantError(t, err, "IDENTITY")
				if manager != nil {
					t.Fatal("failed identity published a manager")
				}
			}
			for _, req := range p.snapshot() {
				if !accepted && req.Method == "Browser.setDownloadBehavior" {
					t.Fatal("failed identity configured Browser")
				}
				if req.Method == "Target.attachToTarget" && req.Params["targetId"] != "worker-target" {
					t.Fatal("attached an unrelated worker")
				}
				if (kind == "wrong-run" || kind == "foreign-origin" || kind == "duplicate") && req.Method == "Target.attachToTarget" {
					t.Fatal("ambiguous or wrong worker was attached")
				}
			}
		})
	}
}

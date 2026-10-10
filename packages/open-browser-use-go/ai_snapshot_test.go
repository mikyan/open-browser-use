package obu

import (
	"encoding/json"
	"net"
	"reflect"
	"strings"
	"testing"
	"time"

	"github.com/ifuryst/open-browser-use/internal/wire"
)

func validAICapture() Params {
	snapshot := "- button \"Save 中文 [ref=e999]\" [ref=e1]\n- button \"Child\" [ref=f1e2]"
	return Params{"captureId": "capture", "snapshot": snapshot, "refs": []string{"e1", "f1e2"},
		"stats": Params{"bytes": len(snapshot), "nodes": 4, "refs": 2, "frames": 2}, "complete": true}
}

func TestAISnapshotWireLimitsRefActionsAndNoReplay(t *testing.T) {
	var actions []string
	done := make(chan struct{})
	path, cleanup := startSDKServer(t, func(conn net.Conn) {
		defer close(done)
		legacyControlHandshake(t, conn)
		for _, expected := range []string{"snapshotAI", "snapshotAI", "innerText", "dragTo", "screenshot", "snapshot", "click"} {
			request := readRequest(t, conn)
			params := request["params"].(map[string]any)
			actions = append(actions, params["action"].(string))
			if request["method"] != "browserAction" || params["action"] != expected {
				t.Errorf("unexpected route: %#v", request)
			}
			value := any(nil)
			switch expected {
			case "snapshotAI":
				value = validAICapture()
				if len(actions) == 1 {
					want := Params{"maxBytes": float64(1024), "maxNodes": float64(20), "maxRefs": float64(10), "maxFrames": float64(3), "maxDepth": float64(12)}
					if !reflect.DeepEqual(params["args"], map[string]any(want)) {
						t.Errorf("limits not preserved: %#v", params)
					}
					if budget := params["timeoutMs"].(float64); budget <= 0 || budget > 3000 {
						t.Errorf("invalid remaining timeout: %v", budget)
					}
				}
			case "innerText":
				value = "Child"
			case "screenshot":
				value = Params{"base64": "AA==", "mimeType": "image/png"}
			case "snapshot":
				value = "- button \"Child\""
			}
			if expected != "snapshotAI" {
				steps := params["locator"]
				if expected == "dragTo" {
					steps = params["args"].(map[string]any)["target"]
				}
				want := []any{map[string]any{"kind": "ref", "captureId": "capture", "ref": "f1e2"}}
				if !reflect.DeepEqual(steps, want) {
					t.Errorf("ref changed: %#v", steps)
				}
			}
			if expected == "click" {
				if err := wire.WriteJSON(conn, Params{"id": request["id"], "error": Params{"message": "OBU_CAPTURE_EXPIRED"}}); err != nil {
					t.Error(err)
				}
			} else {
				writeResponse(t, conn, request["id"], Params{"value": value, "engine": Params{"name": "playwright-crx", "version": "0.15.0", "playwrightVersion": "1.53.0", "capabilities": Params{"snapshotAI": 1, "captureRefs": 1}}})
			}
		}
	})
	defer cleanup()
	browser := NewBrowser(NewClient(Options{SocketPath: path, Timeout: time.Second}))
	defer browser.Close()
	tab := browser.Tab(42)
	result, err := tab.SnapshotAI(AISnapshotOptions{MaxBytes: 1024, MaxNodes: 20, MaxRefs: 10, MaxFrames: 3, MaxDepth: 12, Timeout: 3 * time.Second})
	if err != nil {
		t.Fatal(err)
	}
	if !reflect.DeepEqual(result.Refs, []string{"e1", "f1e2"}) {
		t.Fatalf("refs extracted from page text: %#v", result)
	}
	if _, err := tab.Playwright.SnapshotAI(); err != nil {
		t.Fatal(err)
	}
	ref := tab.Playwright.GetByRef(result.CaptureID, "f1e2")
	if text, err := ref.InnerText(time.Second); err != nil || text != "Child" {
		t.Fatalf("text=%q error=%v", text, err)
	}
	if err := tab.Locator("#source").DragTo(ref); err != nil {
		t.Fatal(err)
	}
	if screenshot, err := ref.Screenshot(); err != nil || screenshot.MimeType != "image/png" {
		t.Fatalf("screenshot=%#v error=%v", screenshot, err)
	}
	if snapshot, err := ref.ARIASnapshot(); err != nil || snapshot != "- button \"Child\"" {
		t.Fatalf("snapshot=%q error=%v", snapshot, err)
	}
	if err := ref.Click(); err == nil || !strings.Contains(err.Error(), "OBU_CAPTURE_EXPIRED") {
		t.Fatalf("missing original expiry: %v", err)
	}
	<-done
	if len(actions) != 7 {
		t.Fatalf("unexpected recapture or replay: %#v", actions)
	}
}

func TestAISnapshotRejectsMalformedMetadataAndLowerBudgetViolations(t *testing.T) {
	_, limits, _ := aiCaptureLimits(AISnapshotOptions{})
	for name, change := range map[string]func(map[string]any){
		"incomplete":      func(v map[string]any) { v["complete"] = false },
		"missingComplete": func(v map[string]any) { delete(v, "complete") },
		"numericComplete": func(v map[string]any) { v["complete"] = 1 },
		"emptyCapture":    func(v map[string]any) { v["captureId"] = "" },
		"longCapture":     func(v map[string]any) { v["captureId"] = strings.Repeat("x", 129) },
		"duplicateRefs":   func(v map[string]any) { v["refs"] = []string{"e1", "e1"} },
		"newlineRef":      func(v map[string]any) { v["refs"] = []string{"e1\n", "f1e2"} },
		"nullRefs":        func(v map[string]any) { v["refs"] = nil },
		"wrongRefs":       func(v map[string]any) { v["stats"].(map[string]any)["refs"] = 3 },
		"wrongBytes":      func(v map[string]any) { v["stats"].(map[string]any)["bytes"] = 1 },
		"missingBytes":    func(v map[string]any) { delete(v["stats"].(map[string]any), "bytes") },
		"fraction":        func(v map[string]any) { v["stats"].(map[string]any)["nodes"] = 1.5 },
		"zeroFrames":      func(v map[string]any) { v["stats"].(map[string]any)["frames"] = 0 },
		"unknownStats":    func(v map[string]any) { v["stats"].(map[string]any)["extra"] = 1 },
		"unknownField":    func(v map[string]any) { v["extra"] = true },
		"wrongFieldCase":  func(v map[string]any) { v["CaptureId"] = v["captureId"]; delete(v, "captureId") },
		"wrongCounterCase": func(v map[string]any) {
			stats := v["stats"].(map[string]any)
			stats["Bytes"] = stats["bytes"]
			delete(stats, "bytes")
		},
	} {
		t.Run(name, func(t *testing.T) {
			encoded, _ := json.Marshal(validAICapture())
			var value map[string]any
			_ = json.Unmarshal(encoded, &value)
			change(value)
			if _, err := decodeAISnapshot(value, limits); err == nil {
				t.Fatal("invalid snapshot accepted")
			}
		})
	}
	for _, option := range []AISnapshotOptions{{MaxBytes: 1}, {MaxNodes: 1}, {MaxRefs: 1}, {MaxFrames: 1}} {
		_, limits, _ := aiCaptureLimits(option)
		if _, err := decodeAISnapshot(validAICapture(), limits); err == nil {
			t.Fatal("server exceeded requested limit")
		}
	}
}

func TestAIRefBuildersRejectAllChainingAndInvalidLimitsBeforeWire(t *testing.T) {
	tab := NewBrowser(NewClient(Options{SocketPath: "unused"})).Tab(7)
	ref := tab.GetByRef("capture", "e1")
	for _, derived := range []*Locator{ref.Locator("div"), ref.FrameLocator("iframe"), ref.GetByRole("button"), ref.GetByText("x"), ref.GetByLabel("x"), ref.GetByPlaceholder("x"), ref.GetByAltText("x"), ref.GetByTitle("x"), ref.GetByTestID("x"), ref.First(), ref.Last(), ref.Nth(0), ref.Filter(FilterOptions{HasText: "x"})} {
		if err := derived.Click(); err == nil || !strings.Contains(err.Error(), "cannot be chained") {
			t.Fatalf("invalid chain reached transport: %v", err)
		}
		if err := tab.Locator("#source").DragTo(derived); err == nil || !strings.Contains(err.Error(), "cannot be chained") {
			t.Fatalf("invalid drag target reached transport: %v", err)
		}
	}
	for _, token := range []string{"e0", "f0e1", "e1\n", "aria-ref=e1", "e1 >> button", "e" + strings.Repeat("1", 64)} {
		if err := tab.GetByRef("capture", token).Click(); err == nil || !strings.Contains(err.Error(), "native snapshot") {
			t.Fatalf("bad ref accepted: %q %v", token, err)
		}
	}
	for _, capture := range []string{"", strings.Repeat("x", 129)} {
		if err := tab.GetByRef(capture, "e1").Click(); err == nil || !strings.Contains(err.Error(), "captureId") {
			t.Fatalf("bad capture accepted: %v", err)
		}
	}
	for _, option := range []AISnapshotOptions{{MaxBytes: -1}, {MaxBytes: 262145}, {MaxNodes: 5001}, {MaxRefs: 2001}, {MaxFrames: 33}, {MaxDepth: 65}} {
		if _, err := tab.SnapshotAI(option); err == nil || !strings.Contains(err.Error(), "positive integer") {
			t.Fatalf("invalid limit reached transport: %v", err)
		}
	}
	if len(ref.locatorSteps()) != 1 || ref.err != nil {
		t.Fatal("failed derivation mutated original ref")
	}
}

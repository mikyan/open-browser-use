// Opt-in geometry fixture through public typed Go SDK methods. No oracle/HTTP.
package main

import (
	"encoding/json"
	"fmt"
	"os"
	"strconv"
	"time"

	obu "github.com/ifuryst/open-browser-use/packages/open-browser-use-go"
)

func main() {
	if len(os.Args) != 5 {
		panic("usage: geometry endpoint fixtureURL outputPath startupDPR")
	}
	if os.Args[4] != "1" && os.Args[4] != "1.5" && os.Args[4] != "2" {
		panic("Expected startup DPR 1, 1.5 or 2")
	}
	expectedDPR, _ := strconv.ParseFloat(os.Args[4], 64)
	detail := map[string]any{"kind": "go", "expectedDPR": expectedDPR, "phases": []any{}, "trace": []any{}}
	key := fmt.Sprintf("geometry-go-%d", time.Now().UnixNano())
	detail["key"] = key
	var browser *obu.Browser
	finalizeAttempted := false
	trace := func(operation string, args any, call func() (any, error)) any {
		record := map[string]any{"index": len(detail["trace"].([]any)), "kind": "go", "operation": operation, "args": args, "requestedAt": time.Now().UnixMilli()}
		detail["trace"] = append(detail["trace"].([]any), record)
		value, err := call()
		if err != nil {
			record["error"] = err.Error()
			panic(err)
		}
		record["completedAt"] = time.Now().UnixMilli()
		return value
	}
	func() {
		defer func() {
			if failure := recover(); failure != nil {
				detail["error"] = fmt.Sprint(failure)
			}
		}()
		var err error
		browser, err = obu.ConnectOpenBrowserUse(obu.Options{SocketPath: os.Args[1], SessionID: key, Timeout: 15 * time.Second})
		if err != nil {
			panic(err)
		}
		control := trace("beginTurn", obu.Params{}, browser.Client.BeginTurn)
		encoded, err := json.Marshal(control)
		if err != nil {
			panic(err)
		}
		var state map[string]any
		if err = json.Unmarshal(encoded, &state); err != nil {
			panic(err)
		}
		detail["scope"] = map[string]any{"session_id": key, "turn_id": state["nextTurnId"], "control_epoch": state["controlEpoch"]}
		tab := trace("newTab", obu.Params{}, func() (any, error) { return browser.NewTab() }).(*obu.Tab)
		detail["tabId"] = tab.ID
		url := os.Args[2] + "snapshot-geometry?key=" + key
		trace("goto", obu.Params{"url": url}, func() (any, error) { return tab.Goto(url) })
		for phase := range 3 {
			item := map[string]any{"phase": phase, "dpr": expectedDPR}
			detail["phases"] = append(detail["phases"].([]any), item)
			expression := fmt.Sprintf("__snapshotGeometry.configure(%d)", phase)
			item["before"] = trace("evaluate", obu.Params{"expression": expression}, func() (any, error) { return tab.Evaluate(expression, true) })
			if phase == 0 {
				item["defaultCapture"] = trace("snapshotAI", obu.Params{}, func() (any, error) { return tab.SnapshotAI(obu.AISnapshotOptions{}) })
				item["falseCapture"] = trace("snapshotAI", obu.Params{"boxes": false}, func() (any, error) {
					result, err := browser.Client.BrowserAction(tab.ID, "snapshotAI", obu.BrowserActionOptions{Args: obu.Params{"boxes": false}})
					return result.Value, err
				})
			}
			item["capture"] = trace("snapshotAI", obu.Params{"boxes": true}, func() (any, error) { return tab.SnapshotAI(obu.AISnapshotOptions{Boxes: true}) })
			item["after"] = trace("evaluate", obu.Params{"expression": "__snapshotGeometry.read()"}, func() (any, error) { return tab.Evaluate("__snapshotGeometry.read()", true) })
			item["screenshot"] = trace("screenshot", obu.Params{}, func() (any, error) {
				value, err := tab.Screenshot()
				return screenshotEvidence(value), err
			})
		}
		finalizeAttempted = true
		detail["finalizeResult"] = trace("finalizeTabs", obu.Params{"keep": []any{}}, func() (any, error) { return browser.Client.FinalizeTabs([]obu.Params{}) })
	}()
	if browser != nil {
		if !finalizeAttempted {
			result, err := browser.Client.FinalizeTabs([]obu.Params{})
			if err != nil {
				detail["cleanupError"] = err.Error()
			} else {
				detail["cleanupResult"] = result
			}
		}
		browser.Close()
	}
	bytes, err := json.MarshalIndent(detail, "", "  ")
	if err != nil {
		panic(err)
	}
	file, err := os.OpenFile(os.Args[3], os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0600)
	if err != nil {
		panic(err)
	}
	if _, err = file.Write(bytes); err != nil {
		file.Close()
		panic(err)
	}
	if err = file.Close(); err != nil {
		panic(err)
	}
	fmt.Printf("{\"output\":%q}\n", os.Args[3])
	if detail["error"] != nil {
		os.Exit(1)
	}
}

// The SDK's public Go value has no JSON tags. Normalize only this fixture's
// persisted artifact; do not change the SDK or infer an absent native response.
func screenshotEvidence(value obu.Screenshot) map[string]string {
	return map[string]string{"base64": value.Base64, "mimeType": value.MimeType}
}

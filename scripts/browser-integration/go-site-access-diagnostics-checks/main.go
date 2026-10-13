// One typed workflow. The parent independently verifies original HTTP/native evidence.
package main

import (
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"time"

	obu "github.com/ifuryst/open-browser-use/packages/open-browser-use-go"
)

type config struct {
	TabID int `json:"tabId"`
	Scope struct {
		SessionID    string `json:"session_id"`
		TurnID       string `json:"turn_id"`
		ControlEpoch int64  `json:"control_epoch"`
	} `json:"scope"`
	Layout string `json:"layout"`
	Key    string `json:"key"`
	APIURL string `json:"apiURL"`
	Value  string `json:"value"`
}

func run(endpoint string, c config, detail map[string]any) (err error) {
	detail["scope"], detail["tabId"] = c.Scope, c.TabID
	browser, err := obu.ConnectOpenBrowserUse(obu.Options{SocketPath: endpoint, SessionID: c.Scope.SessionID, TurnID: c.Scope.TurnID, Timeout: 15 * time.Second})
	if err != nil {
		return err
	}
	defer func() { err = errors.Join(err, browser.Close()) }()
	state, err := browser.Client.Request("getControlState", obu.Params{})
	if err != nil {
		return err
	}
	control, ok := state.(map[string]any)
	if !ok || control["controlEpoch"] != float64(c.Scope.ControlEpoch) || control["closing"] == true {
		return errors.New("original diagnostics caller scope changed")
	}
	tab := browser.Tab(c.TabID)
	initial, err := tab.Diagnostics(obu.DiagnosticsOptions{Limit: 200, Timeout: 5 * time.Second})
	if err != nil {
		return err
	}
	detail["initial"] = initial
	locator := func(selector string) *obu.Locator {
		if c.Layout == "root" {
			return tab.Locator(selector)
		}
		return tab.FrameLocator("#diagnostics-frame").Locator(selector)
	}
	if c.Layout == "dynamic-oopif" {
		if err = tab.Locator("#add-diagnostics-frame").Click(); err != nil {
			return err
		}
	}
	if err = locator("#note").Fill(c.Value); err != nil {
		return err
	}
	if err = locator("#save").Click(); err != nil {
		return err
	}
	if err = locator(fmt.Sprintf("#receipt:has-text(%q)", "Saved "+c.Key)).WaitFor("visible", obu.BrowserActionOptions{Timeout: 5 * time.Second}); err != nil {
		return err
	}
	receipt, err := locator("#receipt").TextContent()
	if err != nil {
		return err
	}
	if receipt == nil {
		return errors.New("original receipt missing")
	}
	detail["receipt"] = *receipt
	deadline := time.Now().Add(5 * time.Second)
	snapshots := []obu.DiagnosticsSnapshot{}
	var capture obu.DiagnosticsSnapshot
	var responses []map[string]any
	for {
		remaining := time.Until(deadline).Truncate(time.Millisecond)
		if remaining < time.Millisecond {
			remaining = time.Millisecond
		}
		capture, err = tab.Diagnostics(obu.DiagnosticsOptions{After: &initial.Cursor, Limit: 200, Timeout: remaining})
		if err != nil {
			return err
		}
		snapshots = append(snapshots, capture)
		detail["snapshots"] = snapshots
		logs, faults := 0, 0
		responses = nil
		for _, entry := range capture.Entries {
			if entry["kind"] == "console" && entry["text"] == "Original diagnostics console "+c.Key {
				logs++
			}
			if entry["kind"] == "pageerror" && entry["message"] == "Original diagnostics error "+c.Key {
				faults++
			}
			if entry["kind"] == "response" && entry["url"] == c.APIURL && entry["method"] == "POST" && entry["status"] == float64(201) {
				responses = append(responses, entry)
			}
		}
		finished := false
		if len(responses) > 0 {
			for _, entry := range capture.Entries {
				if entry["kind"] == "requestfinished" && entry["requestId"] == responses[0]["requestId"] {
					finished = true
				}
			}
		}
		if logs > 0 && faults > 0 && len(responses) > 0 && finished {
			if len(responses) != 1 {
				return errors.New("ambiguous original response")
			}
			detail["capture"] = capture
			break
		}
		if !time.Now().Before(deadline) || len(snapshots) >= 64 {
			return errors.New("original diagnostics events did not arrive within their read deadline")
		}
		time.Sleep(25 * time.Millisecond)
	}
	requestID, ok := responses[0]["requestId"].(string)
	if !ok || requestID == "" {
		return errors.New("original response ID missing")
	}
	reference := obu.ResponseBodyRef{CaptureID: capture.CaptureID, RequestID: requestID}
	detail["reference"] = reference
	body, err := tab.ResponseBody(reference, obu.ResponseBodyOptions{MaxBytes: 65536, Timeout: 10 * time.Second})
	if err != nil {
		return err
	}
	detail["body"] = body
	bytes, err := base64.StdEncoding.Strict().DecodeString(body.Data)
	if err != nil {
		return err
	}
	var decoded map[string]any
	if err = json.Unmarshal(bytes, &decoded); err != nil {
		return err
	}
	detail["decoded"] = decoded
	return nil
}

func main() {
	if len(os.Args) != 4 {
		panic("usage: diagnostics-checks endpoint config output")
	}
	detail := map[string]any{}
	data, err := os.ReadFile(os.Args[2])
	var c config
	if err == nil {
		err = json.Unmarshal(data, &c)
	}
	if err == nil {
		err = run(os.Args[1], c, detail)
	}
	if err != nil {
		detail["error"] = err.Error()
	}
	encoded, encodeErr := json.Marshal(detail)
	if encodeErr != nil {
		panic(encodeErr)
	}
	file, fileErr := os.OpenFile(os.Args[3], os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0600)
	if fileErr != nil {
		panic(fileErr)
	}
	if _, fileErr = file.Write(append(encoded, '\n')); fileErr != nil {
		panic(fileErr)
	}
	if fileErr = file.Close(); fileErr != nil {
		panic(fileErr)
	}
	fmt.Println(string(encoded))
	if err != nil {
		os.Exit(1)
	}
}

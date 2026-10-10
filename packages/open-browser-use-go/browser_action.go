package obu

import (
	"encoding/json"
	"errors"
	"time"
)

type DiagnosticsCursor struct {
	CaptureID string `json:"captureId"`
	Sequence  int64  `json:"sequence"`
}

type DiagnosticsOptions struct {
	After   *DiagnosticsCursor
	Limit   int
	Timeout time.Duration
}

type DiagnosticsSnapshot struct {
	CaptureID string            `json:"captureId"`
	StartedAt string            `json:"startedAt"`
	Entries   []map[string]any  `json:"entries"`
	Cursor    DiagnosticsCursor `json:"cursor"`
	Dropped   int64             `json:"dropped"`
}

// Diagnostics reads bounded console/error/network history from this attachment.
// Cursors expire on detach or owner changes. Request headers/bodies are omitted.
func (t *Tab) Diagnostics(options ...DiagnosticsOptions) (DiagnosticsSnapshot, error) {
	option := DiagnosticsOptions{}
	if len(options) > 0 {
		option = options[0]
	}
	args := Params{}
	if option.After != nil {
		args["after"] = *option.After
	}
	if option.Limit != 0 {
		args["limit"] = option.Limit
	}
	value, err := t.Action("diagnostics", BrowserActionOptions{Args: args, Timeout: option.Timeout})
	if err != nil {
		return DiagnosticsSnapshot{}, err
	}
	encoded, err := json.Marshal(value)
	if err != nil {
		return DiagnosticsSnapshot{}, err
	}
	var snapshot DiagnosticsSnapshot
	if err := json.Unmarshal(encoded, &snapshot); err != nil {
		return DiagnosticsSnapshot{}, err
	}
	if snapshot.CaptureID == "" || snapshot.Cursor.CaptureID != snapshot.CaptureID || snapshot.Entries == nil {
		return DiagnosticsSnapshot{}, errors.New("invalid diagnostics response")
	}
	return snapshot, nil
}

// BrowserActionOptions describes the extension's finite Playwright protocol.
// Locator steps and Args are validated by the extension before execution.
type BrowserActionOptions struct {
	Locator []Params
	Args    Params
	Timeout time.Duration
}

type BrowserActionResult struct {
	Value  any
	Engine map[string]any
}

// BrowserAction preserves engine metadata and does not replay failed input.
func (c *Client) BrowserAction(tabID int, action string, options BrowserActionOptions) (BrowserActionResult, error) {
	timeout := options.Timeout
	if timeout == 0 {
		timeout = DefaultTimeout
	}
	if timeout < time.Millisecond || timeout > 120*time.Second {
		return BrowserActionResult{}, errors.New("browser action timeout must be between 1ms and 120s")
	}
	params := Params{"tabId": tabID, "action": action, "timeoutMs": timeout.Milliseconds()}
	if options.Locator != nil {
		params["locator"] = options.Locator
	}
	if options.Args != nil {
		params["args"] = options.Args
	}
	budget := timeout + time.Second
	response, err := c.requestWithTimeout("browserAction", params, budget)
	if err != nil {
		return BrowserActionResult{}, err
	}
	return decodeBrowserActionResult(response)
}

func decodeBrowserActionResult(response any) (BrowserActionResult, error) {
	envelope, ok := response.(map[string]any)
	if !ok {
		return BrowserActionResult{}, errors.New("browserAction response must be an envelope")
	}
	value, exists := envelope["value"]
	engine, engineOK := envelope["engine"].(map[string]any)
	if !exists || !engineOK {
		return BrowserActionResult{}, errors.New("browserAction response needs value and engine metadata")
	}
	for _, key := range []string{"name", "version", "playwrightVersion"} {
		if _, ok := engine[key].(string); !ok {
			return BrowserActionResult{}, errors.New("browserAction engine metadata is invalid")
		}
	}
	return BrowserActionResult{Value: value, Engine: engine}, nil
}

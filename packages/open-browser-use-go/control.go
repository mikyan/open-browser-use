package obu

import (
	"errors"
	"fmt"
	"os"
	"time"
)

type clientControlState struct {
	version    int // -1 unknown, 0 legacy, 1 epoch lifecycle
	epoch      int64
	turnID     string
	generation uint64
}

// Waiting for another synchronous request consumes this request's deadline.
// A regular mutex would only notice expiry after the previous request finished.
type requestLock struct{ gate chan struct{} }

func (m *requestLock) Lock()   { m.gate <- struct{}{} }
func (m *requestLock) Unlock() { <-m.gate }
func (m *requestLock) lockUntil(deadline time.Time) error {
	remaining := time.Until(deadline)
	if remaining <= 0 {
		return os.ErrDeadlineExceeded
	}
	timer := time.NewTimer(remaining)
	defer timer.Stop()
	select {
	case m.gate <- struct{}{}:
		return nil
	case <-timer.C:
		return os.ErrDeadlineExceeded
	}
}

func controlDiscoveryMethod(method string) bool {
	return method == "getInfo" || method == "ping" || method == "getControlState"
}

func (c *Client) observeControlSupport(info any) error {
	version := 0
	var pageWaitVersion, downloadWaitVersion, fileChooserVersion, networkVersion, navigationVersion, directDownloadsVersion, mediaDownloadsVersion, pageExportVersion, clipboardVersion any
	if object, ok := info.(map[string]any); ok {
		if metadata, ok := object["metadata"].(map[string]any); ok {
			directDownloadsVersion = metadata["directDownloadsVersion"]
			mediaDownloadsVersion = metadata["mediaDownloadsVersion"]
			pageExportVersion = metadata["pageExportVersion"]
			clipboardVersion = metadata["clipboardVersion"]
			networkVersion = metadata["networkWaitVersion"]
			navigationVersion = metadata["navigationWaitVersion"]
			pageWaitVersion = metadata["pageWaitVersion"]
			downloadWaitVersion = metadata["downloadWaitVersion"]
			fileChooserVersion = metadata["fileChooserWaitVersion"]
			if advertised, exists := metadata["turnLifecycleVersion"]; exists {
				if advertised != float64(1) {
					return fmt.Errorf("unsupported turn lifecycle version %v; update the SDK", advertised)
				}
				version = 1
			}
		}
	}
	c.controlMu.Lock()
	defer c.controlMu.Unlock()
	c.directDownloadsKnown, c.directDownloadsVersion = true, directDownloadsVersion
	c.mediaDownloadsKnown, c.mediaDownloadsVersion = true, mediaDownloadsVersion
	c.pageExportKnown, c.pageExportVersion = true, pageExportVersion
	c.clipboardKnown, c.clipboardVersion = true, clipboardVersion
	c.networkWaitKnown, c.networkWaitVersion = true, networkVersion
	c.navigationWaitKnown, c.navigationWaitVersion = true, navigationVersion
	c.pageWaitKnown, c.pageWaitVersion = true, pageWaitVersion
	c.downloadWaitKnown, c.downloadWaitVersion = true, downloadWaitVersion
	c.fileChooserWaitKnown, c.fileChooserWaitVersion = true, fileChooserVersion
	if c.control.version != 1 {
		c.control.version = version
	}
	return nil
}

func validateControlState(value any) (int64, string, error) {
	state, ok := value.(map[string]any)
	if !ok || state["lifecycleVersion"] != float64(1) {
		return 0, "", errors.New("invalid turn lifecycle response")
	}
	epoch, eOK := state["controlEpoch"].(float64)
	turnID, tOK := state["nextTurnId"].(string)
	if !eOK || epoch < 1 || epoch > 9007199254740991 || epoch != float64(int64(epoch)) || !tOK || turnID == "" {
		return 0, "", errors.New("invalid control epoch or next turn ID")
	}
	closing, hasClosing := state["closing"]
	if hasClosing {
		if _, ok := closing.(bool); !ok {
			return 0, "", errors.New("invalid closing state in turn lifecycle response")
		}
	}
	if closing == true {
		return 0, "", errors.New("previous turn is still closing; explicitly begin a turn after cleanup")
	}
	return int64(epoch), turnID, nil
}

// BeginTurn explicitly recovers the latest session epoch and a new turn ID.
// It never replays an earlier request. Call it after inspecting a stale-epoch
// error or an uncertain end result before submitting new work.
func (c *Client) BeginTurn() (any, error) {
	if c.scopeParent != nil {
		return nil, errors.New("OBU_STALE_CONTROL_EPOCH: begin a turn on the original client, then create new handles")
	}
	deadline := time.Now().Add(c.options.Timeout)
	if err := c.mu.lockUntil(deadline); err != nil {
		return nil, err
	}
	defer c.mu.Unlock()
	c.controlMu.Lock()
	turnID := c.control.turnID
	c.controlMu.Unlock()
	result, err := c.requestLocked("getControlState", Params{"session_id": c.options.SessionID, "turn_id": turnID}, deadline)
	if err != nil {
		return nil, err
	}
	epoch, nextTurnID, err := validateControlState(result)
	if err != nil {
		return nil, err
	}
	c.controlMu.Lock()
	c.control = clientControlState{version: 1, epoch: epoch, turnID: nextTurnID, generation: c.control.generation + 1}
	c.controlMu.Unlock()
	return result, nil
}

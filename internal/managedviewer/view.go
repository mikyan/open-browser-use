package managedviewer

import (
	"encoding/json"

	"github.com/ifuryst/open-browser-use/internal/managedprotocol"
)

// Viewing has its own generation fence and never marks a human input lane as
// claimed. A read-only lease must not grant input or permanently block Resume.
func (c *connection) observeViewState(data json.RawMessage) {
	var value struct {
		View          *managedprotocol.HumanState `json:"view"`
		EventSequence uint64                      `json:"eventSequence"`
		Status        struct {
			State           string
			CleanupComplete bool
		} `json:"status"`
	}
	if json.Unmarshal(data, &value) != nil {
		return
	}
	c.controlMu.Lock()
	defer c.controlMu.Unlock()
	if value.EventSequence < c.viewStateSequence {
		return
	}
	previous, next := c.view, value.View
	if previous != nil && next != nil && previous.LeaseID == next.LeaseID && next.Generation < previous.Generation {
		return
	}
	changed := previous == nil && next != nil || previous != nil && (next == nil || previous.LeaseID != next.LeaseID || previous.Generation != next.Generation)
	if changed || next != nil && next.State != "active" {
		if value.EventSequence > c.viewRetiredSequence {
			c.viewRetiredSequence = value.EventSequence
		}
		select {
		case <-c.frames:
		default:
		}
	}
	c.view, c.viewStateSequence = next, value.EventSequence
	if next != nil {
		c.viewRisk = true
	}
	c.viewAllowed = value.Status.State == "running" || value.Status.State == "paused" && value.Status.CleanupComplete
}

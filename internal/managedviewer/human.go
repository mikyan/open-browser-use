package managedviewer

import (
	"context"
	"encoding/json"
	"errors"
	"time"

	"github.com/ifuryst/open-browser-use/internal/managedprotocol"
)

// Only these typed backend categories may add public diagnostics. Never infer
// a reason from Error() text, and never expose native descriptions or stacks.
func humanFailureReason(operation string, err error) string {
	if operation != "humanBegin" && operation != "humanInput" {
		return ""
	}
	var coded interface{ UserErrorCode() string }
	if !errors.As(err, &coded) {
		return ""
	}
	switch code := coded.UserErrorCode(); code {
	case "OBU_HUMAN_GEOMETRY", "OBU_HUMAN_INVALID", "OBU_HUMAN_BUSY", "OBU_HUMAN_UNAVAILABLE",
		"OBU_MANAGED_USER_HUMAN_GEOMETRY", "OBU_MANAGED_USER_HUMAN_INVALID", "OBU_MANAGED_USER_HUMAN_BUSY", "OBU_MANAGED_USER_HUMAN_UNAVAILABLE":
		return code
	}
	return ""
}

func bytesNullTab(data json.RawMessage) bool {
	var f map[string]json.RawMessage
	return json.Unmarshal(data, &f) == nil && string(f["tabId"]) == "null"
}

func (c *connection) admitBegin(request *command) bool {
	c.controlMu.Lock()
	defer c.controlMu.Unlock()
	if c.humanClaimed || len(c.releases) != 0 || c.ctx.Err() != nil {
		return false
	}
	c.humanEpoch++
	c.humanClaimed, c.humanStarting, c.humanRevoked = true, true, false
	c.humanLease, c.humanGeneration, c.humanSequence = "", 0, 0
	c.humanCandidate = nil
	c.humanCtx, c.humanCancel = context.WithCancel(c.ctx)
	request.ctx, request.epoch = c.humanCtx, c.humanEpoch
	return true
}

func (c *connection) admitInput(request command) bool {
	var input struct {
		LeaseID    string `json:"leaseId"`
		Generation uint64
		Sequence   uint64
	}
	_ = json.Unmarshal(request.payload, &input)
	c.controlMu.Lock()
	if !c.humanClaimed || c.humanStarting || c.humanRevoked || c.humanLease != input.LeaseID || c.humanGeneration != input.Generation || c.humanSequence+1 != input.Sequence || c.ctx.Err() != nil {
		c.controlMu.Unlock()
		return false
	}
	request.ctx, request.epoch = c.humanCtx, c.humanEpoch
	select {
	case c.inputs <- request:
		c.humanSequence = input.Sequence
		c.controlMu.Unlock()
		return true
	default:
		c.controlMu.Unlock()
		// Losing an up event would strand an original down. End this connection
		// and run its original cleanup rather than silently dropping input.
		c.revokeHuman()
		c.cancel()
		_ = c.ws.CloseNow()
		return false
	}
}

func (c *connection) revokeHuman() {
	c.controlMu.Lock()
	pending := c.revokeHumanLocked()
	c.controlMu.Unlock()
	c.rejectRevokedInputs(pending)
}

func (c *connection) revokeHumanLocked() []command {
	c.humanRevoked = true
	c.humanEpoch++
	if c.humanCancel != nil {
		c.humanCancel()
	}
	var pending []command
	for {
		select {
		case request := <-c.inputs:
			pending = append(pending, request)
		default:
			return pending
		}
	}
}

func (c *connection) rejectRevokedInputs(pending []command) {
	for _, request := range pending {
		c.failure(request.id, "HUMAN_STALE", "人工输入已撤销，未发送的操作不会重放。")
	}
}

func (s *Server) inputLane(c *connection) {
	for {
		select {
		case <-c.ctx.Done():
			return
		case request := <-c.inputs:
			c.controlMu.Lock()
			current := !c.humanRevoked && request.epoch == c.humanEpoch
			c.controlMu.Unlock()
			if !current {
				c.failure(request.id, "HUMAN_STALE", "人工输入已撤销，未发送的操作不会重放。")
				continue
			}
			// Command returns success only for this exact native input receipt.
			// A timeout/error revokes the lane, so it never releases the next input.
			s.command(c, request)
		}
	}
}

func (c *connection) acceptHumanResult(request command, result json.RawMessage) error {
	f, err := object(result)
	if err != nil {
		return err
	}
	if request.operation == "humanInput" {
		receipt, err := managedprotocol.ParseInputReceipt(f["inputReceipt"])
		fields, _ := object(request.payload)
		if err != nil || !managedprotocol.MatchInputReceipt(fields, receipt) {
			return errors.New("original human input receipt mismatch")
		}
	}
	if request.operation == "humanEnd" {
		cleanup, err := managedprotocol.ParseHumanCleanup(f["humanCleanup"])
		var fields struct {
			LeaseID string `json:"leaseId"`
		}
		_ = json.Unmarshal(request.payload, &fields)
		if err != nil || cleanup == nil || cleanup.LeaseID != fields.LeaseID {
			return errors.New("original human cleanup receipt mismatch")
		}
	}
	if request.operation == "humanBegin" {
		human, err := managedprotocol.ParseHumanState(f["human"])
		var fields struct {
			TabID uint64 `json:"tabId"`
		}
		_ = json.Unmarshal(request.payload, &fields)
		if err != nil || human == nil || human.State != "active" || human.TabID != fields.TabID {
			return errors.New("original human begin receipt mismatch")
		}
		c.controlMu.Lock()
		if request.epoch != c.humanEpoch || c.humanRevoked {
			c.controlMu.Unlock()
			return errors.New("human begin was revoked")
		}
		c.humanStarting = false
		c.humanLease, c.humanGeneration = human.LeaseID, human.Generation
		if latest := c.humanCandidate; latest != nil && latest.LeaseID == human.LeaseID {
			if latest.State != "active" {
				c.controlMu.Unlock()
				return errors.New("human begin already released")
			}
			if latest.Generation > c.humanGeneration {
				c.humanGeneration = latest.Generation
			}
		}
		c.controlMu.Unlock()
	}
	c.observeHumanState(result)
	if request.operation == "pause" || request.operation == "select" && bytesNullTab(request.payload) {
		// A successful explicit unsubscribe/pause is also a cleanup barrier for
		// a Begin revoked before it could issue a lease. A mere status is not.
		var clean bool
		_ = json.Unmarshal(f["viewerCleanupComplete"], &clean)
		if clean && string(f["human"]) == "null" {
			c.controlMu.Lock()
			if c.humanLease == "" {
				c.humanClaimed, c.humanStarting = false, false
			}
			c.controlMu.Unlock()
		}
	}
	return nil
}

func (c *connection) observeHumanState(data json.RawMessage) {
	var value struct {
		Human         *managedprotocol.HumanState   `json:"human"`
		Cleanup       *managedprotocol.HumanCleanup `json:"humanCleanup"`
		EventSequence uint64                        `json:"eventSequence"`
	}
	if json.Unmarshal(data, &value) != nil {
		return
	}
	c.controlMu.Lock()
	if value.EventSequence < c.humanStateSequence {
		c.controlMu.Unlock()
		return
	}
	c.humanStateSequence = value.EventSequence
	if c.humanStarting && value.Human != nil {
		c.humanCandidate = value.Human
	}
	if value.Cleanup != nil && value.Cleanup.CleanupConfirmed && value.Cleanup.LeaseID == c.humanLease && (value.Human == nil || value.Human.State == "released") {
		c.humanClaimed, c.humanStarting = false, false
	}
	if value.Human != nil && value.Human.LeaseID == c.humanLease && !c.humanRevoked {
		if value.Human.State == "active" && (value.Human.Generation == c.humanGeneration || c.humanGeneration == 0 && value.Human.Generation == 1) {
			c.humanGeneration = value.Human.Generation
		} else {
			c.humanRevoked = true
			if c.humanCancel != nil {
				c.humanCancel()
			}
		}
	}
	c.controlMu.Unlock()
}

// Failed current human commands may leave held input. Cleanup is independent
// of their caller and starts before waiting for those original calls to settle.
func (s *Server) releaseFailedHuman(c *connection, epoch uint64) {
	c.controlMu.Lock()
	if c.ctx.Err() != nil || epoch != c.humanEpoch {
		c.controlMu.Unlock()
		return
	}
	// A late failure belongs only to its original admission. Reserve cleanup
	// before unlocking so a cleanup status cannot admit a successor Begin
	// before this original unsubscribe is submitted and actually settled.
	pending := c.revokeHumanLocked()
	acquired := false
	select {
	case c.releases <- struct{}{}:
		acquired = true
	default:
	}
	c.controlMu.Unlock()
	c.rejectRevokedInputs(pending)
	if !acquired {
		// The existing explicit release owns the same original cleanup.
		return
	}
	c.workers.Add(1)
	go func() {
		defer c.workers.Done()
		defer func() { <-c.releases }()
		ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
		defer cancel()
		result, err := s.config.Backend.Command(ctx, json.RawMessage(`{"operation":"select","tabId":null}`))
		if err == nil {
			err = c.confirmCleanup(result)
		}
		if err == nil {
			result, err = publicState(result)
		}
		if err == nil {
			err = c.acceptHumanResult(command{operation: "select", payload: json.RawMessage(`{"operation":"select","tabId":null}`)}, result)
		}
		if err != nil {
			s.mu.Lock()
			s.cleanupErr = errors.New("original human cleanup is unconfirmed")
			s.mu.Unlock()
		} else {
			latest(c.state, c.displayData(appendStateType(result)))
		}
	}()
}

func appendStateType(data json.RawMessage) json.RawMessage {
	f, _ := object(data)
	f["type"] = jsonBytes("state")
	return jsonBytes(f)
}

func (c *connection) confirmCleanup(data json.RawMessage) error {
	f, err := object(data)
	if err != nil {
		return err
	}
	// Only the original owned browser exit can substitute for an unavailable
	// human release receipt. A service worker exiting does not release keys in
	// a still-live renderer.
	if string(f["cleanupConfirmed"]) == "true" && string(f["cleanupProof"]) == `"session-terminated"` {
		return nil
	}
	state, err := object(f["status"])
	if err != nil || string(state["selectedTabId"]) != "null" {
		return errors.New("cleanup lacks original unselection")
	}
	c.controlMu.Lock()
	lease := c.humanLease
	human := c.humanClaimed
	c.controlMu.Unlock()
	if human || lease != "" {
		receipt, err := managedprotocol.ParseHumanCleanup(state["humanCleanup"])
		if err != nil || lease != "" && (receipt == nil || receipt.LeaseID != lease) || state["human"] != nil && string(state["human"]) != "null" {
			return errors.New("original human cleanup is unconfirmed")
		}
		var count *uint64
		if json.Unmarshal(state["cleanupPending"], &count) != nil || count == nil || *count != 0 || state["cleanupError"] != nil {
			return errors.New("original human cleanup is pending")
		}
	}
	return nil
}

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
	c.humanRetiredGeneration = 0
	c.humanActive = false
	c.humanBudgetVersion, c.humanBudgetKnown = 0, false
	c.humanKeyRepeatVersion = 0
	c.humanFrameLease, c.humanFrameGeneration, c.humanFrameTabID = "", 0, 0
	c.inputCtx, c.inputCancel = nil, nil
	var fields struct {
		TabID uint64 `json:"tabId"`
	}
	_ = json.Unmarshal(request.payload, &fields)
	c.humanTabID = fields.TabID
	c.humanCandidate = nil
	c.pendingDialog = nil
	c.dialogClaims = make(map[managedprotocol.DialogIdentity]managedprotocol.DialogClaim)
	c.humanCtx, c.humanCancel = context.WithCancel(c.ctx)
	request.ctx, request.epoch = c.humanCtx, c.humanEpoch
	return true
}

func (c *connection) admitInput(request command) string {
	var input struct {
		LeaseID    string `json:"leaseId"`
		Generation uint64
		Sequence   uint64
		Input      struct {
			Repeat bool `json:"repeat"`
		}
	}
	_ = json.Unmarshal(request.payload, &input)
	c.controlMu.Lock()
	if c.humanClaimed && !c.humanRevoked && c.humanLease == input.LeaseID && (input.Generation < c.humanGeneration || input.Generation <= c.humanRetiredGeneration) {
		c.controlMu.Unlock()
		return "HUMAN_GENERATION_STALE"
	}
	if !c.humanClaimed || c.humanStarting || c.humanRevoked || !c.humanActive || c.humanLease != input.LeaseID || c.humanGeneration != input.Generation || c.humanSequence+1 != input.Sequence || c.ctx.Err() != nil || c.inputCtx == nil || c.humanFrameLease != input.LeaseID || c.humanFrameGeneration != input.Generation || c.humanFrameTabID != c.humanTabID {
		c.controlMu.Unlock()
		return "HUMAN_STALE"
	}
	if input.Input.Repeat && c.humanKeyRepeatVersion != 1 {
		c.controlMu.Unlock()
		return "HUMAN_STALE"
	}
	request.ctx, request.epoch, request.generation = c.inputCtx, c.humanEpoch, c.humanGeneration
	request.inputBudgetVersion = c.humanBudgetVersion
	select {
	case c.inputs <- request:
		c.humanSequence = input.Sequence
		c.controlMu.Unlock()
		return ""
	default:
		c.controlMu.Unlock()
		// Losing an up event would strand an original down. End this connection
		// and run its original cleanup rather than silently dropping input.
		c.revokeHuman()
		c.cancel()
		_ = c.ws.CloseNow()
		return "HUMAN_STALE"
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
	c.humanActive = false
	c.pendingDialog = nil
	c.humanEpoch++
	if c.humanCancel != nil {
		c.humanCancel()
	}
	return c.drainInputsLocked()
}

func (c *connection) drainInputsLocked() []command {
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

func (c *connection) rejectGenerationInputs(pending []command) {
	for _, request := range pending {
		c.failure(request.id, "HUMAN_GENERATION_STALE", "原页面代次已结束，未发送的输入不会重放。")
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
			generationCurrent := request.generation == c.humanGeneration
			c.controlMu.Unlock()
			if !current {
				c.failure(request.id, "HUMAN_STALE", "人工输入已撤销，未发送的操作不会重放。")
				continue
			}
			if !generationCurrent {
				c.rejectGenerationInputs([]command{request})
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
	if request.operation == "humanDialogRespond" {
		receipt, err := managedprotocol.ParseDialogReceipt(f["dialogReceipt"])
		fields, _ := object(request.payload)
		if err != nil || !managedprotocol.MatchDialogReceipt(fields, receipt) {
			return errors.New("original human dialog receipt mismatch")
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
		if err != nil || human == nil || human.State != "active" && human.State != "preparing" && human.State != "navigating" || human.TabID != fields.TabID {
			return errors.New("original human begin receipt mismatch")
		}
		c.controlMu.Lock()
		if request.epoch != c.humanEpoch || c.humanRevoked {
			c.controlMu.Unlock()
			return errors.New("human begin was revoked")
		}
		c.humanStarting = false
		c.humanLease = human.LeaseID
		if latest := c.humanCandidate; latest != nil && latest.LeaseID == human.LeaseID {
			if latest.InputBudgetVersion != human.InputBudgetVersion || latest.KeyRepeatVersion != human.KeyRepeatVersion {
				c.controlMu.Unlock()
				return errors.New("human begin capabilities differ from its original status")
			}
			if latest.State != "active" && latest.State != "preparing" && latest.State != "navigating" {
				c.controlMu.Unlock()
				return errors.New("human begin already released")
			}
			if latest.Generation >= human.Generation {
				human = latest
			}
		}
		pending := c.applyHumanStateLocked(human)
		c.controlMu.Unlock()
		c.rejectGenerationInputs(pending)
	}
	if err := c.observeHumanState(result); err != nil {
		return err
	}
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

func (c *connection) observeHumanState(data json.RawMessage) error {
	var value struct {
		Human         *managedprotocol.HumanState    `json:"human"`
		Cleanup       *managedprotocol.HumanCleanup  `json:"humanCleanup"`
		EventSequence uint64                         `json:"eventSequence"`
		PendingDialog *managedprotocol.PendingDialog `json:"pendingDialog"`
	}
	if json.Unmarshal(data, &value) != nil {
		return errors.New("invalid human display state")
	}
	c.controlMu.Lock()
	if value.EventSequence < c.humanStateSequence {
		c.controlMu.Unlock()
		return nil
	}
	if value.Human != nil && value.Human.LeaseID == c.humanLease && value.Human.Generation < c.humanGeneration {
		c.controlMu.Unlock()
		return nil
	}
	if dialog := value.PendingDialog; dialog != nil {
		original, seen := c.dialogClaims[dialog.DialogIdentity]
		if seen && original.Source != dialog.Source || !seen && len(c.dialogClaims) >= 1024 {
			err := &dialogSourceStateError{epoch: c.humanEpoch}
			c.controlMu.Unlock()
			return err
		}
		if c.dialogClaims == nil {
			c.dialogClaims = make(map[managedprotocol.DialogIdentity]managedprotocol.DialogClaim)
		}
		if !seen {
			c.dialogClaims[dialog.DialogIdentity] = managedprotocol.DialogClaim{Source: dialog.Source}
		}
	}
	c.humanStateSequence = value.EventSequence
	var pending []command
	if c.humanStarting && value.Human != nil {
		if value.Human.TabID == c.humanTabID && (c.humanCandidate == nil || value.Human.LeaseID == c.humanCandidate.LeaseID && value.Human.Generation >= c.humanCandidate.Generation) {
			if c.humanCandidate != nil && (c.humanCandidate.InputBudgetVersion != value.Human.InputBudgetVersion || c.humanCandidate.KeyRepeatVersion != value.Human.KeyRepeatVersion) {
				pending = c.revokeHumanLocked()
			} else {
				c.humanCandidate = value.Human
			}
		}
	}
	if value.Cleanup != nil && value.Cleanup.CleanupConfirmed && value.Cleanup.LeaseID == c.humanLease && (value.Human == nil || value.Human.State == "released") {
		c.humanClaimed, c.humanStarting = false, false
	}
	if value.Human != nil && value.Human.LeaseID == c.humanLease && value.Human.TabID == c.humanTabID && !c.humanRevoked {
		pending = c.applyHumanStateLocked(value.Human)
	}
	c.pendingDialog = nil
	if !c.humanRevoked && value.Human != nil && (value.Human.State == "active" || value.Human.State == "preparing" || value.Human.State == "navigating") && value.Human.Generation > 0 && value.Human.TabID == c.humanTabID &&
		(value.Human.LeaseID == c.humanLease || c.humanStarting) {
		c.pendingDialog = value.PendingDialog
	}
	revoked := c.humanRevoked
	c.controlMu.Unlock()
	c.observeViewState(data)
	if revoked {
		c.rejectRevokedInputs(pending)
	} else {
		c.rejectGenerationInputs(pending)
	}
	return nil
}

// A generation is retired without retiring its lease. Its queued inputs are
// never replayed, and an already-submitted input still owns the single lane
// until the original adapter settles it. Only whole-lease cleanup clears risk.
func (c *connection) applyHumanStateLocked(human *managedprotocol.HumanState) []command {
	if human.Generation < c.humanGeneration {
		return nil
	}
	if c.humanBudgetKnown && (human.InputBudgetVersion != c.humanBudgetVersion || human.KeyRepeatVersion != c.humanKeyRepeatVersion) {
		// A coalesced state may update display, but cannot upgrade an admitted
		// input's deadline or silently downgrade its original native contract.
		return c.revokeHumanLocked()
	}
	if human.State != "active" && human.State != "preparing" && human.State != "navigating" {
		return c.revokeHumanLocked()
	}
	var pending []command
	if human.Generation > c.humanGeneration {
		if c.inputCancel != nil {
			c.inputCancel(managedprotocol.ErrHumanGenerationRetired)
		}
		pending = c.drainInputsLocked()
		c.humanGeneration, c.humanSequence = human.Generation, 0
		c.inputCtx, c.inputCancel = context.WithCancelCause(c.humanCtx)
		// A response can arrive after the new frame. Preserve only a frame
		// already carrying this exact generation, never a retired one.
		if c.humanFrameGeneration != human.Generation || c.humanFrameLease != human.LeaseID || c.humanFrameTabID != human.TabID {
			c.humanFrameLease, c.humanFrameGeneration, c.humanFrameTabID = "", 0, 0
			select {
			case <-c.frames:
			default:
			}
		}
	}
	c.humanBudgetVersion, c.humanBudgetKnown = human.InputBudgetVersion, true
	c.humanKeyRepeatVersion = human.KeyRepeatVersion
	c.humanActive = human.State == "active" && human.Generation > c.humanRetiredGeneration && human.Viewport != nil
	return pending
}

func (c *connection) retireInputGeneration(request command) {
	c.controlMu.Lock()
	var pending []command
	if !c.humanRevoked && request.epoch == c.humanEpoch && request.generation == c.humanGeneration {
		c.humanRetiredGeneration = request.generation
		c.humanActive = false
		if c.inputCancel != nil {
			c.inputCancel(managedprotocol.ErrHumanGenerationRetired)
		}
		pending = c.drainInputsLocked()
	}
	c.controlMu.Unlock()
	c.rejectGenerationInputs(pending)
}

// A trusted active status is not evidence that a frame has actually arrived.
// Frames may precede their Begin reply, but never the bridge's status for g.
func (c *connection) observeHumanFrame(data json.RawMessage) bool {
	var frame struct {
		ControlMode string `json:"controlMode"`
		LeaseID     string `json:"humanLeaseId"`
		ViewLeaseID string `json:"viewLeaseId"`
		Generation  uint64 `json:"generation"`
		TabID       uint64 `json:"tabId"`
	}
	if json.Unmarshal(data, &frame) != nil {
		return false
	}
	if frame.ControlMode == "user-view" {
		c.controlMu.Lock()
		defer c.controlMu.Unlock()
		view := c.view
		return !c.humanClaimed && c.viewAllowed && view != nil && view.State == "active" && view.LeaseID == frame.ViewLeaseID && view.TabID == frame.TabID && view.Generation == frame.Generation && frame.Generation > 0
	}
	if frame.ControlMode != "human" {
		return true
	}
	c.controlMu.Lock()
	defer c.controlMu.Unlock()
	if !c.humanClaimed || c.humanRevoked || frame.TabID != c.humanTabID {
		return false
	}
	lease, generation := c.humanLease, c.humanGeneration
	if c.humanStarting && c.humanCandidate != nil {
		lease, generation = c.humanCandidate.LeaseID, c.humanCandidate.Generation
	}
	if frame.LeaseID != lease || frame.Generation != generation || generation == 0 {
		return false
	}
	c.humanFrameLease, c.humanFrameGeneration, c.humanFrameTabID = frame.LeaseID, frame.Generation, frame.TabID
	return true
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
	if err != nil || string(state["selectedTabId"]) != "null" || state["view"] != nil && string(state["view"]) != "null" {
		return errors.New("cleanup lacks original unselection")
	}
	c.controlMu.Lock()
	lease := c.humanLease
	human := c.humanClaimed
	view := c.viewRisk
	c.controlMu.Unlock()
	if human || lease != "" {
		receipt, err := managedprotocol.ParseHumanCleanup(state["humanCleanup"])
		if err != nil || lease != "" && (receipt == nil || receipt.LeaseID != lease) || state["human"] != nil && string(state["human"]) != "null" {
			return errors.New("original human cleanup is unconfirmed")
		}
	}
	if human || lease != "" || view {
		var count *uint64
		if json.Unmarshal(state["cleanupPending"], &count) != nil || count == nil || *count != 0 || state["cleanupError"] != nil {
			return errors.New("original viewer cleanup is pending")
		}
	}
	return nil
}

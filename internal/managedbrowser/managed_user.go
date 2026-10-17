package managedbrowser

import (
	"bytes"
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"sync"
	"time"

	"github.com/ifuryst/open-browser-use/internal/managedprotocol"
)

const userBindingName = "__obuManagedViewerEvent"

type managedUserIdentity struct {
	Version             int    `json:"version"`
	RunID               string `json:"runId"`
	ExtensionID         string `json:"extensionId"`
	ExtensionInstanceID string `json:"extensionInstanceId"`
	WorkerBootID        string `json:"workerBootId"`
	PortID              string `json:"portId"`
	ChannelID           string `json:"channelId,omitempty"`
}

// UserController permits bounded explicit human input, never general CDP. Done signals
// unavailable user control, separately from Close's original cleanup receipt.
type UserController struct {
	cdp                  *userCDP
	identity             managedUserIdentity
	channelKey           string
	ownerDone            <-chan struct{}
	mu                   sync.Mutex
	targetID             string
	sessionID            string
	contextID            int64
	contextUID           string
	contextReady         chan struct{}
	openCall             *userCall
	openAttempt          bool
	opened               bool
	closing              bool
	controlErr           error
	done                 chan struct{}
	closeOnce            sync.Once
	workerGone           chan struct{}
	workerOnce           sync.Once
	cleanupDone          chan struct{}
	cleanupFailed        chan struct{}
	failureOnce          sync.Once
	cleanupErr           error
	cleanupReceipt       json.RawMessage
	commands             map[*userCall]bool
	workers              sync.WaitGroup
	events               chan json.RawMessage
	wake                 chan struct{}
	states               []json.RawMessage
	latestFrame          json.RawMessage
	lastSequence         uint64
	lastFrameSequence    uint64
	lastBrokerSequence   uint64
	frameTabID           uint64
	retiredFrameSequence uint64
	streamID             string
	frameMode            string
	frameLease           string
	frameGeneration      uint64
	retiredStreams       map[string]bool
	acks                 chan uint64
	heartbeatEvery       time.Duration
	humanRisk            bool
	humanRiskGeneration  uint64
	humanStatus          *managedprotocol.HumanState
	humanStatusSequence  uint64
	viewStatus           *managedprotocol.HumanState
	viewStatusSequence   uint64
}

// OpenUserController binds once to this run's already authenticated worker.
// Neither failure nor worker replacement permits discovery on another root.
func (s *Session) OpenUserController(ctx context.Context) (*UserController, error) {
	s.userMu.Lock()
	defer s.userMu.Unlock()
	if s.info.Mode == "setup" {
		return nil, errors.New("managed setup has no task or viewer controller")
	}
	if s.userOpened || s.userRootURL == "" {
		return nil, errors.New("managed user controller was already opened or session is not ready")
	}
	if err := s.checkStartup(ctx); err != nil {
		return nil, err
	}
	select {
	case <-s.done:
		return nil, errors.New("managed session is closed")
	default:
	}
	if err := validateBinding(s.record.Binding, s.info); err != nil {
		return nil, err
	}
	var identity managedUserIdentity
	if err := json.Unmarshal(s.record.Binding, &identity); err != nil {
		return nil, err
	}
	identity.Version, identity.RunID = 1, s.info.RunID
	s.userOpened = true
	return openUserController(ctx, s.userRootURL, identity, s.done)
}

func openUserController(ctx context.Context, root string, identity managedUserIdentity, ownerDone <-chan struct{}) (_ *UserController, err error) {
	key, err := randomID()
	if err != nil {
		return nil, err
	}
	connection, err := connectBrowser(ctx, root)
	if err != nil {
		return nil, err
	}
	c := &UserController{identity: identity, channelKey: key, ownerDone: ownerDone, contextReady: make(chan struct{}), done: make(chan struct{}), workerGone: make(chan struct{}),
		cleanupDone: make(chan struct{}), cleanupFailed: make(chan struct{}), commands: make(map[*userCall]bool), events: make(chan json.RawMessage), wake: make(chan struct{}, 1),
		acks: make(chan uint64, 2), retiredStreams: make(map[string]bool), heartbeatEvery: 3 * time.Second}
	c.workers.Add(1)
	c.cdp = newUserCDP(connection.conn, c.handleEvent)
	go c.deliverEvents()
	go func() {
		select {
		case <-ownerDone:
			c.markWorkerGone()
		case <-c.cdp.done:
			c.unavailable(errors.New("managed user original connection ended"))
		case <-c.cleanupDone:
		}
	}()
	// A socket ending does not end the original worker. Continue watching the
	// owned Job receipt even after the connection monitor has returned.
	go func() {
		select {
		case <-ownerDone:
			c.markWorkerGone()
		case <-c.cleanupDone:
		}
	}()
	defer func() {
		if err != nil {
			c.unavailable(err)
		}
	}()
	if err = c.cdp.call(ctx, "", "Target.setDiscoverTargets", map[string]any{"discover": true}, nil); err != nil {
		return nil, err
	}
	var targets struct {
		TargetInfos []struct{ TargetID, Type, URL string } `json:"targetInfos"`
	}
	if err = c.cdp.call(ctx, "", "Target.getTargets", map[string]any{}, &targets); err != nil {
		return nil, err
	}
	url := "chrome-extension://" + identity.ExtensionID + "/background.js"
	var targetID string
	for _, target := range targets.TargetInfos {
		if target.Type == "service_worker" && target.URL == url {
			if targetID != "" || target.TargetID == "" {
				return nil, errors.New("managed user worker target is not unique")
			}
			targetID = target.TargetID
		}
	}
	if targetID == "" {
		return nil, errors.New("managed user exact worker target is unavailable")
	}
	c.mu.Lock()
	c.targetID = targetID
	c.mu.Unlock()
	var attached struct {
		SessionID string `json:"sessionId"`
	}
	if err = c.cdp.call(ctx, "", "Target.attachToTarget", map[string]any{"targetId": targetID, "flatten": true}, &attached); err != nil {
		return nil, err
	}
	if attached.SessionID == "" {
		return nil, errors.New("managed user worker session is missing")
	}
	c.mu.Lock()
	c.sessionID = attached.SessionID
	c.mu.Unlock()
	if err = c.cdp.call(ctx, attached.SessionID, "Runtime.enable", map[string]any{}, nil); err != nil {
		return nil, err
	}
	select {
	case <-c.contextReady:
	case <-c.done:
		return nil, errors.New("managed user worker ended during setup")
	case <-ctx.Done():
		return nil, ctx.Err()
	}
	c.mu.Lock()
	contextID := c.contextID
	c.mu.Unlock()
	if err = c.cdp.call(ctx, attached.SessionID, "Runtime.addBinding", map[string]any{"name": userBindingName, "executionContextId": contextID}, nil); err != nil {
		return nil, err
	}
	params := map[string]any{"version": 1, "runId": identity.RunID, "extensionId": identity.ExtensionID, "extensionInstanceId": identity.ExtensionInstanceID, "workerBootId": identity.WorkerBootID, "portId": identity.PortID, "channelKey": key}
	c.mu.Lock()
	c.openAttempt = true
	c.openCall, err = c.evaluateLocked(ctx, "open", params)
	call := c.openCall
	c.mu.Unlock()
	if err != nil {
		return nil, err
	}
	data, err := call.wait(ctx)
	if err != nil {
		return nil, err
	}
	if err = c.acceptOpen(data); err != nil {
		return nil, err
	}
	c.mu.Lock()
	if c.closing {
		c.mu.Unlock()
		return nil, errors.New("managed user channel ended during open")
	}
	c.workers.Add(2)
	go c.heartbeat()
	go c.acknowledgeFrames()
	c.mu.Unlock()
	return c, nil
}

func (c *UserController) Events() <-chan json.RawMessage { return c.events }
func (c *UserController) Done() <-chan struct{}          { return c.done }

func (c *UserController) evaluateLocked(ctx context.Context, method string, params any) (*userCall, error) {
	args, err := json.Marshal(params)
	if err != nil {
		return nil, err
	}
	return c.cdp.start(ctx, c.sessionID, "Runtime.evaluate", map[string]any{
		"expression": "globalThis.__obuManagedUser." + method + "(" + string(args) + ")", "awaitPromise": true, "returnByValue": true, "uniqueContextId": c.contextUID})
}

type userBridgeError struct{ code string }

func (e *userBridgeError) Error() string         { return "managed user bridge rejected request: " + e.code }
func (e *userBridgeError) UserErrorCode() string { return e.code }

func bridgeValue(data json.RawMessage) (json.RawMessage, error) {
	var result struct {
		Result struct {
			Type        string
			Value       json.RawMessage
			Description string
		} `json:"result"`
		Exception json.RawMessage `json:"exceptionDetails"`
	}
	if json.Unmarshal(data, &result) != nil {
		return nil, errors.New("invalid managed user evaluation result")
	}
	if len(result.Exception) != 0 {
		// Preserve a bounded known error code, never a stack, expression, key or
		// browser-supplied arbitrary message in logs or public HTTP errors.
		code := "UNKNOWN"
		description := strings.TrimPrefix(result.Result.Description, "Error: ")
		for _, prefix := range []string{"OBU_MANAGED_USER_", "OBU_HUMAN_", "OBU_CONTROL_", "OBU_AUTOMATION_"} {
			if strings.HasPrefix(description, prefix) {
				candidate := description
				end := 0
				for end < len(candidate) && end < 96 && (candidate[end] == '_' || candidate[end] >= 'A' && candidate[end] <= 'Z') {
					end++
				}
				if end < len(candidate) && candidate[end] == ':' {
					code = candidate[:end]
				}
				break
			}
		}
		return nil, &userBridgeError{code: code}
	}
	if result.Result.Type != "object" || len(result.Result.Value) == 0 || result.Result.Value[0] != '{' {
		return nil, errors.New("managed user bridge returned no JSON object")
	}
	return result.Result.Value, nil
}

func (c *UserController) matches(actual managedUserIdentity, channel bool) bool {
	expected := c.identity
	return actual.Version == 1 && actual.RunID == expected.RunID && actual.ExtensionID == expected.ExtensionID && actual.ExtensionInstanceID == expected.ExtensionInstanceID &&
		actual.WorkerBootID == expected.WorkerBootID && actual.PortID == expected.PortID && (!channel || actual.ChannelID == expected.ChannelID && actual.ChannelID != "")
}

func (c *UserController) acceptOpen(data json.RawMessage) error {
	value, err := bridgeValue(data)
	if err != nil {
		return err
	}
	var result struct {
		managedUserIdentity
		Status json.RawMessage `json:"status"`
	}
	if json.Unmarshal(value, &result) != nil {
		return errors.New("invalid managed user open result")
	}
	c.mu.Lock()
	defer c.mu.Unlock()
	if !c.matches(result.managedUserIdentity, false) || result.ChannelID == "" || len(result.ChannelID) > 256 {
		return errors.New("managed user open identity mismatch")
	}
	if c.opened && c.identity.ChannelID != result.ChannelID {
		return errors.New("managed user channel changed")
	}
	c.identity.ChannelID = result.ChannelID
	if err := c.validateStatusLocked(result.Status); err != nil {
		return err
	}
	c.opened = true
	return nil
}

func (c *UserController) validateStatusLocked(data json.RawMessage) error {
	f, err := userObject(data)
	if err != nil {
		return err
	}
	human, err := managedprotocol.ParseHumanState(f["human"])
	if err != nil {
		return err
	}
	view, err := managedprotocol.ParseViewState(f["view"])
	if err != nil || human != nil && view != nil {
		return errors.New("managed user view and human state conflict")
	}
	if _, err := managedprotocol.ParseHumanCleanup(f["humanCleanup"]); err != nil {
		return err
	}
	var value struct {
		managedUserIdentity
		EventSequence *uint64 `json:"eventSequence"`
		Connected     *bool   `json:"connected"`
	}
	if len(data) > 4<<20 || json.Unmarshal(data, &value) != nil || !c.matches(value.managedUserIdentity, true) || value.EventSequence == nil || *value.EventSequence > 1<<53-1 || value.Connected == nil {
		return errors.New("managed user status identity mismatch")
	}
	if *value.EventSequence >= c.viewStatusSequence {
		previous := c.viewStatus
		if previous != nil && view != nil && previous.LeaseID == view.LeaseID && view.Generation < previous.Generation {
			return nil
		}
		if previous != nil && (view == nil || previous.LeaseID != view.LeaseID || view.Generation > previous.Generation || view.State != "active") ||
			view != nil && c.streamID != "" && c.frameMode != "user-view" {
			if err := c.retireStreamLocked(); err != nil {
				return err
			}
		}
		c.viewStatus, c.viewStatusSequence = view, *value.EventSequence
		if view != nil {
			c.humanStatus, c.humanStatusSequence = nil, *value.EventSequence
		}
	}
	if human != nil && *value.EventSequence >= c.humanStatusSequence {
		previous := c.humanStatus
		// Late replies may carry an original input receipt and an older status.
		// The receipt remains useful, but the snapshot cannot restore a stream.
		if previous != nil && previous.LeaseID == human.LeaseID && human.Generation < previous.Generation {
			return nil
		}
		if previous != nil && (previous.LeaseID != human.LeaseID || human.Generation > previous.Generation) {
			if err := c.retireStreamLocked(); err != nil {
				return err
			}
		}
		c.humanStatus, c.humanStatusSequence = human, *value.EventSequence
	}
	return nil
}

func (c *UserController) retireStreamLocked() error {
	if c.streamID != "" {
		if len(c.retiredStreams) >= 1024 {
			return errors.New("managed user stream retirement capacity exhausted")
		}
		c.retiredStreams[c.streamID] = true
	}
	c.streamID = ""
	c.frameMode, c.frameLease, c.frameGeneration = "", "", 0
	c.lastBrokerSequence, c.frameTabID = 0, 0
	c.retiredFrameSequence = c.lastFrameSequence
	c.latestFrame = nil
	return nil
}

func userObject(data []byte) (map[string]json.RawMessage, error) {
	return managedprotocol.Object(data)
}

func userCommand(data json.RawMessage) (map[string]json.RawMessage, string, bool, error) {
	if len(data) > 32<<10 {
		return nil, "", false, errors.New("managed user command too large")
	}
	f, err := userObject(data)
	if err != nil {
		return nil, "", false, err
	}
	var operation string
	if json.Unmarshal(f["operation"], &operation) != nil {
		return nil, "", false, errors.New("missing managed user operation")
	}
	allowed := map[string]bool{"operation": true}
	unselect := false
	switch operation {
	case "status", "pause":
	case "select":
		allowed["tabId"] = true
		unselect = bytes.Equal(f["tabId"], []byte("null"))
		if f["deliveryId"] != nil {
			allowed["deliveryId"] = true
		}
		if err := managedprotocol.ValidateSelection(f); err != nil {
			return nil, "", false, err
		}
	case "resume":
		allowed["expectedRevision"], allowed["expectedWorkerBootId"] = true, true
		var revision uint64
		var boot string
		if bytes.Equal(f["expectedRevision"], []byte("null")) || json.Unmarshal(f["expectedRevision"], &revision) != nil || revision > 1<<53-1 || json.Unmarshal(f["expectedWorkerBootId"], &boot) != nil || boot == "" || len(boot) > 256 {
			return nil, "", false, errors.New("invalid managed user resume identity")
		}
	case "humanBegin", "humanInput", "humanEnd":
		if err := managedprotocol.ValidateHuman(operation, f); err != nil {
			return nil, "", false, err
		}
		for _, name := range managedprotocol.HumanFields(operation) {
			allowed[name] = true
		}
		if operation == "humanBegin" && f["deliveryId"] != nil {
			allowed["deliveryId"] = true
		}
	default:
		return nil, "", false, errors.New("unsupported managed user operation")
	}
	if len(f) != len(allowed) {
		return nil, "", false, errors.New("unexpected or missing managed user command fields")
	}
	for key := range f {
		if !allowed[key] {
			return nil, "", false, errors.New("unexpected managed user command field")
		}
	}
	return f, operation, unselect, nil
}

func (c *UserController) Command(ctx context.Context, data json.RawMessage) (json.RawMessage, error) {
	f, operation, unselect, err := userCommand(data)
	if err != nil {
		return nil, err
	}
	if err := userSubmissionError(ctx); err != nil {
		return nil, err
	}
	c.mu.Lock()
	if c.closing {
		receipt := append(json.RawMessage(nil), c.cleanupReceipt...)
		c.mu.Unlock()
		if unselect && len(receipt) != 0 {
			return receipt, nil
		}
		if unselect {
			if err := c.Close(ctx); err != nil {
				return nil, err
			}
			c.mu.Lock()
			receipt = append(json.RawMessage(nil), c.cleanupReceipt...)
			c.mu.Unlock()
			return receipt, nil
		}
		return nil, errors.New("managed user controller closed; original cleanup is not confirmed")
	}
	if operation == "resume" {
		var boot string
		_ = json.Unmarshal(f["expectedWorkerBootId"], &boot)
		if boot != c.identity.WorkerBootID {
			c.mu.Unlock()
			return nil, errors.New("managed user Resume worker identity changed")
		}
	}
	key, _ := json.Marshal(c.channelKey)
	f["channelKey"] = key
	call, err := c.evaluateLocked(ctx, "request", f)
	if err == nil {
		if operation == "humanBegin" {
			c.humanRisk = true
			c.humanRiskGeneration++
		}
		c.trackCallLocked(call)
	}
	riskGeneration := c.humanRiskGeneration
	c.mu.Unlock()
	if err != nil {
		return nil, err
	}
	result, err := call.wait(ctx)
	if err != nil && operation == "humanInput" && errors.Is(context.Cause(ctx), managedprotocol.ErrHumanGenerationRetired) {
		// A navigation cancels the submission context, not its original native
		// receipt. Continue the same wait under the original deadline. No retry
		// or new deadline is introduced, and the HTTP input lane stays occupied.
		original := context.WithoutCancel(ctx)
		cancel := func() {}
		if deadline, ok := ctx.Deadline(); ok {
			original, cancel = context.WithDeadline(original, deadline)
		}
		result, err = call.wait(original)
		cancel()
	}
	if err != nil {
		return nil, err
	}
	value, err := bridgeValue(result)
	if err != nil {
		return nil, err
	}
	responseFields, err := userObject(value)
	if err != nil {
		return nil, err
	}
	if operation == "humanInput" {
		receipt, err := managedprotocol.ParseInputReceipt(responseFields["inputReceipt"])
		if err != nil || !managedprotocol.MatchInputReceipt(f, receipt) {
			return nil, errors.New("managed original human input receipt mismatch")
		}
	}
	var response struct {
		Status json.RawMessage `json:"status"`
	}
	if json.Unmarshal(value, &response) != nil {
		return nil, errors.New("invalid managed user command response")
	}
	c.mu.Lock()
	err = c.validateStatusLocked(response.Status)
	if err == nil && riskGeneration == c.humanRiskGeneration && (unselect || operation == "humanEnd" || operation == "pause") {
		fields, parseErr := userObject(response.Status)
		var selected *uint64
		var pending *uint64
		if parseErr == nil && json.Unmarshal(fields["selectedTabId"], &selected) == nil && selected == nil && json.Unmarshal(fields["cleanupPending"], &pending) == nil && pending != nil && *pending == 0 && fields["cleanupError"] == nil && (fields["human"] == nil || string(fields["human"]) == "null") && (fields["view"] == nil || string(fields["view"]) == "null") {
			c.humanRisk = false // Only a real cleanup operation, never a status snapshot.
		}
	}
	c.mu.Unlock()
	if err != nil {
		c.unavailable(err)
		return nil, err
	}
	return value, nil
}

func (c *UserController) trackCallLocked(call *userCall) {
	c.commands[call] = true
	c.workers.Add(1)
	go func() { defer c.workers.Done(); <-call.done; c.mu.Lock(); delete(c.commands, call); c.mu.Unlock() }()
}

func (c *UserController) privateRequest(ctx context.Context, operation string, extra map[string]any) (json.RawMessage, error) {
	c.mu.Lock()
	if c.closing && operation != "disconnect" {
		c.mu.Unlock()
		return nil, errors.New("managed user channel is closing")
	}
	params := map[string]any{"operation": operation, "channelKey": c.channelKey}
	for key, value := range extra {
		params[key] = value
	}
	call, err := c.evaluateLocked(ctx, "request", params)
	if err == nil && operation != "disconnect" {
		c.trackCallLocked(call)
	}
	c.mu.Unlock()
	if err != nil {
		return nil, err
	}
	data, err := call.wait(ctx)
	if err != nil {
		return nil, err
	}
	return bridgeValue(data)
}

func (c *UserController) heartbeat() {
	defer c.workers.Done()
	ticker := time.NewTicker(c.heartbeatEvery)
	defer ticker.Stop()
	for {
		select {
		case <-c.done:
			return
		case <-ticker.C:
		}
		ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
		value, err := c.privateRequest(ctx, "heartbeat", nil)
		cancel()
		if err == nil {
			var response struct {
				Status json.RawMessage `json:"status"`
			}
			if json.Unmarshal(value, &response) != nil {
				err = errors.New("invalid managed heartbeat")
			} else {
				c.mu.Lock()
				err = c.validateStatusLocked(response.Status)
				c.mu.Unlock()
			}
		}
		if err != nil {
			c.unavailable(err)
			return
		}
	}
}

func (c *UserController) acknowledgeFrames() {
	defer c.workers.Done()
	for {
		var sequence uint64
		select {
		case <-c.done:
			return
		case sequence = <-c.acks:
		}
		ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
		value, err := c.privateRequest(ctx, "ack", map[string]any{"sequence": sequence})
		cancel()
		if err != nil {
			var rejected *userBridgeError
			c.mu.Lock()
			retired := sequence <= c.retiredFrameSequence
			c.mu.Unlock()
			if retired && errors.As(err, &rejected) && rejected.code == "OBU_MANAGED_USER_ACK" {
				continue
			}
			c.unavailable(err)
			return
		}
		var reply struct {
			Acknowledged uint64
			WorkerBootID string `json:"workerBootId"`
		}
		if json.Unmarshal(value, &reply) != nil || reply.Acknowledged != sequence || reply.WorkerBootID != c.identity.WorkerBootID {
			c.unavailable(errors.New("managed user frame acknowledgement mismatch"))
			return
		}
	}
}

func (c *UserController) unavailable(err error) {
	c.mu.Lock()
	if !c.closing {
		c.closing = true
		c.controlErr = err
		close(c.done)
	}
	c.mu.Unlock()
	c.closeOnce.Do(func() { go c.shutdownUser() })
}

func (c *UserController) markWorkerGone() {
	c.workerOnce.Do(func() { close(c.workerGone) })
	c.unavailable(errors.New("original managed worker terminated"))
}

func (c *UserController) cleanupFailure(err error) {
	c.mu.Lock()
	c.cleanupErr = err
	c.mu.Unlock()
	c.failureOnce.Do(func() { close(c.cleanupFailed) })
}

func (c *UserController) Close(ctx context.Context) error {
	ownerExited := false
	select {
	case <-c.ownerDone:
		ownerExited = true
		c.markWorkerGone()
	default:
	}
	c.unavailable(errors.New("managed user controller closing"))
	select {
	case <-c.cleanupDone:
		return nil
	default:
	}
	select {
	case <-c.workerGone:
		var failure <-chan struct{}
		if !ownerExited {
			failure = c.cleanupFailed
			select {
			case <-c.cleanupFailed:
				c.mu.Lock()
				err := c.cleanupErr
				c.mu.Unlock()
				return err
			default:
			}
		}
		select {
		case <-c.cleanupDone:
			return nil
		case <-failure:
			c.mu.Lock()
			err := c.cleanupErr
			c.mu.Unlock()
			return err
		case <-ctx.Done():
			return ctx.Err()
		}
	default:
	}
	select {
	case <-c.cleanupDone:
		return nil
	case <-c.cleanupFailed:
		c.mu.Lock()
		err := c.cleanupErr
		c.mu.Unlock()
		return err
	case <-ctx.Done():
		return ctx.Err()
	}
}

func (c *UserController) shutdownUser() {
	c.mu.Lock()
	openCall, attempted, session := c.openCall, c.openAttempt, c.sessionID
	humanRisk := c.humanRisk
	commands := make([]*userCall, 0, len(c.commands))
	for call := range c.commands {
		commands = append(commands, call)
	}
	c.mu.Unlock()
	proof := "bridge-disconnect"
	var terminated <-chan struct{} = c.workerGone
	terminationProof := "worker-terminated"
	var unsafeWorkerGone <-chan struct{}
	if humanRisk {
		terminated, terminationProof, unsafeWorkerGone = c.ownerDone, "session-terminated", c.workerGone
	}
	waitOwnedExit := func() {
		c.cleanupFailure(errors.New("original worker ended before human cleanup was confirmed; waiting for owned browser exit"))
		<-c.ownerDone
	}
	var receipt json.RawMessage
	var cleanupErr error
	if attempted && openCall != nil {
		select {
		case <-openCall.done:
			if openCall.reply.err != nil {
				cleanupErr = openCall.reply.err
			} else {
				cleanupErr = c.acceptOpen(openCall.reply.data)
			}
		case <-terminated:
			proof = terminationProof
		case <-unsafeWorkerGone:
			waitOwnedExit()
			proof = terminationProof
		}
	}
	if proof == "bridge-disconnect" && cleanupErr == nil && attempted {
		result := make(chan userReply, 1)
		c.workers.Add(1)
		go func() {
			defer c.workers.Done()
			data, err := c.privateRequest(context.Background(), "disconnect", nil)
			result <- userReply{data: data, err: err}
		}()
		select {
		case reply := <-result:
			cleanupErr = reply.err
			receipt = reply.data
			if cleanupErr == nil {
				var response struct {
					Disconnected bool
					Status       json.RawMessage `json:"status"`
				}
				if json.Unmarshal(receipt, &response) != nil || !response.Disconnected {
					cleanupErr = errors.New("managed user disconnect lacks a cleanup receipt")
				} else {
					c.mu.Lock()
					cleanupErr = c.validateStatusLocked(response.Status)
					c.mu.Unlock()
				}
			}
		case <-terminated:
			proof = terminationProof
		case <-unsafeWorkerGone:
			waitOwnedExit()
			proof = terminationProof
		}
	}
	if cleanupErr != nil {
		c.cleanupFailure(fmt.Errorf("managed user cleanup unconfirmed: %w", cleanupErr))
		<-terminated
		proof = terminationProof
	}
	if proof == "bridge-disconnect" {
		for _, call := range commands {
			select {
			case <-call.done:
			case <-terminated:
				proof = terminationProof
			case <-unsafeWorkerGone:
				waitOwnedExit()
				proof = terminationProof
			}
		}
	}
	if proof == "bridge-disconnect" && session != "" {
		ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
		err := c.cdp.call(ctx, "", "Target.detachFromTarget", map[string]any{"sessionId": session}, nil)
		cancel()
		if err != nil {
			c.cleanupFailure(errors.New("managed user worker detach unconfirmed"))
			<-terminated
			proof = terminationProof
		}
	}
	c.cdp.fail(errors.New("managed user cleanup finished"))
	<-c.cdp.readerDone
	c.cdp.writers.Wait()
	c.workers.Wait()
	if len(receipt) == 0 || proof != "bridge-disconnect" {
		receipt, _ = json.Marshal(map[string]any{"cleanupConfirmed": true, "cleanupProof": proof, "status": map[string]any{"connected": false, "selectedTabId": nil}})
	}
	c.mu.Lock()
	c.cleanupReceipt = receipt
	c.mu.Unlock()
	close(c.cleanupDone)
}

func (c *UserController) handleEvent(session, method string, params json.RawMessage) error {
	c.mu.Lock()
	targetID, workerSession := c.targetID, c.sessionID
	c.mu.Unlock()
	if session == "" {
		switch method {
		case "Target.targetDestroyed":
			var event struct {
				TargetID string `json:"targetId"`
			}
			if json.Unmarshal(params, &event) != nil {
				return errors.New("invalid worker destruction")
			}
			if targetID != "" && event.TargetID == targetID {
				c.markWorkerGone()
			}
		case "Target.detachedFromTarget":
			var event struct {
				SessionID string `json:"sessionId"`
			}
			if json.Unmarshal(params, &event) != nil {
				return errors.New("invalid worker detach")
			}
			if workerSession != "" && event.SessionID == workerSession {
				c.unavailable(errors.New("original worker debugger session detached"))
			}
		}
		return nil
	}
	if session != workerSession || session == "" {
		return errors.New("foreign managed worker event session")
	}
	switch method {
	case "Runtime.executionContextCreated":
		var event struct {
			Context struct {
				ID       int64
				UniqueID string `json:"uniqueId"`
			}
		}
		if json.Unmarshal(params, &event) != nil || event.Context.ID <= 0 || event.Context.UniqueID == "" {
			return errors.New("invalid worker execution context")
		}
		c.mu.Lock()
		if c.contextID == 0 {
			c.contextID, c.contextUID = event.Context.ID, event.Context.UniqueID
			close(c.contextReady)
		} else if c.contextID != event.Context.ID || c.contextUID != event.Context.UniqueID {
			c.mu.Unlock()
			c.unavailable(errors.New("original worker execution context changed"))
			return nil
		}
		c.mu.Unlock()
	case "Runtime.executionContextDestroyed", "Runtime.executionContextsCleared":
		c.unavailable(errors.New("original worker execution context ended"))
	case "Runtime.bindingCalled":
		var event struct {
			Name, Payload      string
			ExecutionContextID int64 `json:"executionContextId"`
		}
		if json.Unmarshal(params, &event) != nil {
			return errors.New("invalid managed worker binding event")
		}
		c.mu.Lock()
		contextID := c.contextID
		c.mu.Unlock()
		if event.Name != userBindingName {
			return nil
		}
		if event.ExecutionContextID != contextID {
			return errors.New("managed worker binding context changed")
		}
		return c.receiveBridgeEvent(json.RawMessage(event.Payload))
	}
	return nil
}

func (c *UserController) receiveBridgeEvent(data json.RawMessage) error {
	fields, parseErr := userObject(data)
	if parseErr != nil {
		return parseErr
	}
	var event struct {
		managedUserIdentity
		Type          string
		Sequence      uint64
		TabID         uint64 `json:"tabId"`
		StreamID      string `json:"streamId"`
		FrameSequence uint64 `json:"frameSequence"`
		MIMEType      string `json:"mimeType"`
		Data          string
		Status        json.RawMessage
		ControlMode   string `json:"controlMode"`
		HumanLeaseID  string `json:"humanLeaseId"`
		ViewLeaseID   string `json:"viewLeaseId"`
		Generation    uint64 `json:"generation"`
	}
	if len(data) > userReadLimit || json.Unmarshal(data, &event) != nil {
		return errors.New("invalid managed user event")
	}
	c.mu.Lock()
	if !c.opened || !c.matches(event.managedUserIdentity, true) || event.Sequence == 0 || event.Sequence > 1<<53-1 || event.Sequence <= c.lastSequence {
		c.mu.Unlock()
		return errors.New("managed user event identity or sequence mismatch")
	}
	c.lastSequence = event.Sequence
	if c.closing && event.Type != "closed" {
		c.mu.Unlock()
		return nil
	}
	switch event.Type {
	case "frame":
		if _, _, _, err := managedprotocol.ParseFrameIdentity(fields); err != nil {
			c.mu.Unlock()
			return err
		}
		if event.TabID == 0 || event.TabID > 1<<53-1 || event.StreamID == "" || len(event.StreamID) > 256 || event.FrameSequence == 0 || event.FrameSequence > 1<<53-1 || event.MIMEType != "image/png" || len(event.Data) > 4*((4<<20+2)/3) {
			c.mu.Unlock()
			return errors.New("invalid managed user frame")
		}
		decoded, err := base64.StdEncoding.DecodeString(event.Data)
		if err != nil || len(decoded) == 0 || len(decoded) > 4<<20 {
			c.mu.Unlock()
			return errors.New("invalid managed user frame bytes")
		}
		if event.ControlMode == "human" {
			human := c.humanStatus
			if human != nil && human.LeaseID == event.HumanLeaseID && human.TabID == event.TabID && event.Generation < human.Generation {
				// This original old frame can never regain display authority. The
				// bridge owns its retired native credit; do not create another ACK.
				c.mu.Unlock()
				return nil
			}
			if human == nil || human.LeaseID != event.HumanLeaseID || human.TabID != event.TabID || human.Generation != event.Generation || human.State != "active" && human.State != "navigating" {
				c.mu.Unlock()
				return errors.New("managed human frame lacks its generation status")
			}
		}
		if event.ControlMode == "user-view" {
			view := c.viewStatus
			if view != nil && view.LeaseID == event.ViewLeaseID && view.TabID == event.TabID && event.Generation < view.Generation {
				c.mu.Unlock()
				return nil
			}
			if view == nil || view.LeaseID != event.ViewLeaseID || view.TabID != event.TabID || view.Generation != event.Generation || view.State != "active" {
				c.mu.Unlock()
				return errors.New("managed user-view frame lacks its active generation status")
			}
		}
		if event.FrameSequence <= c.lastBrokerSequence || c.retiredStreams[event.StreamID] {
			c.mu.Unlock()
			return errors.New("managed user frame was retired or repeated")
		}
		if c.streamID != "" && (c.streamID != event.StreamID || c.frameTabID != event.TabID) {
			c.mu.Unlock()
			return errors.New("managed user stream changed without retirement")
		}
		lease := event.HumanLeaseID
		if event.ControlMode == "user-view" {
			lease = event.ViewLeaseID
		}
		if c.streamID != "" && (c.frameMode != event.ControlMode || c.frameLease != lease || c.frameGeneration != event.Generation) {
			c.mu.Unlock()
			return errors.New("managed human stream identity changed without retirement")
		}
		c.frameMode, c.frameLease, c.frameGeneration = event.ControlMode, lease, event.Generation
		c.streamID, c.lastFrameSequence = event.StreamID, event.Sequence
		c.lastBrokerSequence, c.frameTabID = event.FrameSequence, event.TabID
		c.latestFrame = append(json.RawMessage(nil), data...)
		select {
		case c.acks <- event.Sequence:
		default:
			c.mu.Unlock()
			return errors.New("managed user frame ACK capacity exhausted")
		}
	case "clear", "error":
		if err := c.retireStreamLocked(); err != nil {
			c.mu.Unlock()
			return err
		}
		c.states = append(c.states, append(json.RawMessage(nil), data...))
	case "status":
		if err := c.validateStatusLocked(event.Status); err != nil {
			c.mu.Unlock()
			return err
		}
		// Consecutive status updates can replace each other; clear events remain
		// ordered so a retired frame is never left visible by a slow consumer.
		if len(c.states) > 0 {
			var last struct {
				Type     string
				Sequence uint64
			}
			_ = json.Unmarshal(c.states[len(c.states)-1], &last)
			// Preserve the generation announcement on the other side of an
			// undelivered frame. Otherwise coalescing navigating -> active could
			// make that first frame precede every status advertising its g.
			crossesFrame := c.latestFrame != nil && last.Sequence < c.lastFrameSequence && event.Sequence > c.lastFrameSequence
			if last.Type == "status" && !crossesFrame {
				c.states = c.states[:len(c.states)-1]
			}
		}
		c.states = append(c.states, append(json.RawMessage(nil), data...))
	case "closed":
		c.latestFrame = nil
		c.mu.Unlock()
		c.unavailable(errors.New("managed user channel expired or disconnected"))
		return nil
	default:
		c.mu.Unlock()
		return errors.New("unsupported managed user event")
	}
	if len(c.states) > 16 {
		c.mu.Unlock()
		return errors.New("managed user control event capacity exhausted")
	}
	c.mu.Unlock()
	select {
	case c.wake <- struct{}{}:
	default:
	}
	return nil
}

func (c *UserController) deliverEvents() {
	defer c.workers.Done()
	defer close(c.events)
	for {
		c.mu.Lock()
		var data json.RawMessage
		data = c.latestFrame
		if len(c.states) > 0 {
			var first struct{ Sequence uint64 }
			_ = json.Unmarshal(c.states[0], &first)
			if data == nil || first.Sequence < c.lastFrameSequence {
				data = c.states[0]
			}
		}
		c.mu.Unlock()
		if data == nil {
			select {
			case <-c.done:
				return
			case <-c.wake:
			}
			continue
		}
		select {
		case <-c.done:
			return
		case <-c.wake:
			continue
		case c.events <- data:
			c.mu.Lock()
			if len(c.states) > 0 && bytes.Equal(c.states[0], data) {
				c.states = c.states[1:]
			} else if bytes.Equal(c.latestFrame, data) {
				c.latestFrame = nil
			}
			c.mu.Unlock()
		}
	}
}

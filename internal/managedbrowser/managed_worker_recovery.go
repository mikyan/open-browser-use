package managedbrowser

import (
	"encoding/json"
	"errors"
	"strings"
	"time"
)

type managedRecoveryState struct {
	Version            int    `json:"version"`
	BrowserIncarnation string `json:"browserIncarnation"`
	JournalID          string `json:"journalId"`
	WorkerEpoch        uint64 `json:"workerEpoch"`
}

type managedWorkerRecoveryRequest struct {
	Kind                 string `json:"kind"`
	PreviousWorkerBootID string `json:"previousWorkerBootId"`
	BrowserIncarnation   string `json:"browserIncarnation"`
	ExpectedJournalID    string `json:"expectedJournalId"`
	ExpectedWorkerEpoch  uint64 `json:"expectedWorkerEpoch"`
	Nonce                string `json:"nonce"`
}

type managedWorkerAdmission struct {
	Original    managedWorkerIdentity
	State       managedRecoveryState
	Replacement *managedWorkerRecoveryRequest
	ViewLeaseID string
}

type managedRetiredView struct {
	LeaseID            string `json:"leaseId"`
	TargetID           string `json:"targetId"`
	Outcome            string `json:"outcome"`
	StopAcknowledged   bool   `json:"stopAcknowledged"`
	DetachAcknowledged bool   `json:"detachAcknowledged"`
}

type managedWorkerRecoveryReceipt struct {
	Kind                 string               `json:"kind"`
	Nonce                string               `json:"nonce"`
	PreviousWorkerBootID string               `json:"previousWorkerBootId"`
	WorkerBootID         string               `json:"workerBootId"`
	BrowserIncarnation   string               `json:"browserIncarnation"`
	JournalID            string               `json:"journalId"`
	FromWorkerEpoch      uint64               `json:"fromWorkerEpoch"`
	ToWorkerEpoch        uint64               `json:"toWorkerEpoch"`
	InputRiskClear       bool                 `json:"inputRiskClear"`
	Paused               bool                 `json:"paused"`
	RetiredViews         []managedRetiredView `json:"retiredViews"`
}

func workerRecordFields(data json.RawMessage, names ...string) error {
	fields, err := userObject(data)
	if err != nil || len(fields) != len(names) {
		return errors.New("invalid managed worker recovery record")
	}
	for _, name := range names {
		if fields[name] == nil || string(fields[name]) == "null" {
			return errors.New("incomplete managed worker recovery record")
		}
	}
	return nil
}

func workerRecordText(value string) bool {
	return value != "" && len(value) <= 256 && strings.IndexFunc(value, func(r rune) bool { return r < 32 || r == 127 }) < 0
}

func parseManagedRecoveryState(data json.RawMessage) (managedRecoveryState, error) {
	var state managedRecoveryState
	err := workerRecordFields(data, "version", "browserIncarnation", "journalId", "workerEpoch")
	if err != nil || json.Unmarshal(data, &state) != nil || state.Version != 1 ||
		!workerRecordText(state.BrowserIncarnation) || !workerRecordText(state.JournalID) || state.WorkerEpoch == 0 || state.WorkerEpoch > 1<<53-1 {
		return state, errors.New("invalid managed worker recovery journal identity")
	}
	return state, nil
}

func (c *UserController) validateRecoveryOpenLocked(rawState, rawReceipt, status json.RawMessage) (managedRecoveryState, error) {
	state, err := parseManagedRecoveryState(rawState)
	if err != nil {
		return state, err
	}
	if c.opened && state != c.recoveryState {
		return state, errors.New("managed worker journal changed during original open")
	}
	expected := c.workerAdmission
	if expected == nil || expected.Replacement == nil {
		if len(rawReceipt) != 0 || expected != nil && state != expected.State {
			return state, errors.New("same-worker recovery journal changed")
		}
		return state, nil
	}
	request := expected.Replacement
	if state.BrowserIncarnation != expected.State.BrowserIncarnation || state.JournalID != expected.State.JournalID ||
		expected.State.WorkerEpoch >= 1<<53-1 || state.WorkerEpoch != expected.State.WorkerEpoch+1 {
		return state, errors.New("replacement worker journal identity or epoch changed")
	}
	if err := workerRecordFields(rawReceipt, "kind", "nonce", "previousWorkerBootId", "workerBootId", "browserIncarnation", "journalId", "fromWorkerEpoch", "toWorkerEpoch", "inputRiskClear", "paused", "retiredViews"); err != nil {
		return state, err
	}
	var receipt managedWorkerRecoveryReceipt
	if json.Unmarshal(rawReceipt, &receipt) != nil || receipt.Kind != "worker-replacement" || receipt.Nonce != request.Nonce ||
		receipt.PreviousWorkerBootID != expected.Original.WorkerBootID || receipt.WorkerBootID != c.identity.WorkerBootID ||
		receipt.WorkerBootID == receipt.PreviousWorkerBootID || receipt.BrowserIncarnation != state.BrowserIncarnation ||
		receipt.JournalID != state.JournalID || receipt.FromWorkerEpoch != expected.State.WorkerEpoch || receipt.ToWorkerEpoch != state.WorkerEpoch ||
		!receipt.InputRiskClear || !receipt.Paused || receipt.RetiredViews == nil || len(receipt.RetiredViews) > 64 {
		return state, errors.New("replacement worker resource recovery is not confirmed")
	}
	var fields map[string]json.RawMessage
	var views []json.RawMessage
	_ = json.Unmarshal(rawReceipt, &fields)
	_ = json.Unmarshal(fields["retiredViews"], &views)
	seen := make(map[string]bool)
	for i, view := range receipt.RetiredViews {
		if workerRecordFields(views[i], "leaseId", "targetId", "outcome", "stopAcknowledged", "detachAcknowledged") != nil ||
			!workerRecordText(view.LeaseID) || !workerRecordText(view.TargetID) || seen[view.LeaseID] ||
			view.Outcome != "stopped-and-detached" || !view.StopAcknowledged || !view.DetachAcknowledged {
			return state, errors.New("original read-only view lacks actual stop and detach receipts")
		}
		seen[view.LeaseID] = true
	}
	if expected.ViewLeaseID != "" && !seen[expected.ViewLeaseID] {
		return state, errors.New("original active read-only view retirement is missing")
	}
	wrapped, _ := json.Marshal(map[string]json.RawMessage{"status": status})
	if err := recoveryPaused(wrapped); err != nil {
		return state, err
	}
	return state, nil
}

// This is evidence that the original JavaScript execution ended. It says
// nothing about extension debugger attachments, streams or renderer input.
// Neither a socket close nor detach nor owned Browser exit creates this record.
type managedExecutionEnd struct {
	At           time.Time `json:"at"`
	Method       string    `json:"method"`
	TargetID     string    `json:"targetId"`
	SessionID    string    `json:"sessionId"`
	ContextID    int64     `json:"contextId"`
	ContextUID   string    `json:"contextUniqueId"`
	WorkerBootID string    `json:"workerBootId"`
}

func (c *UserController) recordExecutionEnd(method string) {
	c.mu.Lock()
	var created *managedExecutionEnd
	if c.executionEnd == nil && c.targetID != "" && c.sessionID != "" && c.contextID > 0 && c.contextUID != "" && c.identity.WorkerBootID != "" {
		c.executionEnd = &managedExecutionEnd{At: time.Now().UTC(), Method: method, TargetID: c.targetID,
			SessionID: c.sessionID, ContextID: c.contextID, ContextUID: c.contextUID, WorkerBootID: c.identity.WorkerBootID}
		copy := *c.executionEnd
		created = &copy
	}
	hook := c.executionEndHook
	c.mu.Unlock()
	if created != nil && hook != nil {
		hook(*created)
	}
}

func (c *UserController) acceptExecutionEnd(method string, data json.RawMessage) error {
	fields, err := userObject(data)
	if err != nil {
		return errors.New("invalid worker destruction")
	}
	if method == "Runtime.executionContextDestroyed" {
		var value struct {
			ID  int64   `json:"executionContextId"`
			UID *string `json:"executionContextUniqueId"`
		}
		if json.Unmarshal(data, &value) != nil || value.ID <= 0 || fields["executionContextId"] == nil ||
			(fields["executionContextUniqueId"] != nil && (value.UID == nil || *value.UID == "")) {
			return errors.New("invalid worker destruction")
		}
		c.mu.Lock()
		matched := value.ID == c.contextID && (value.UID == nil || *value.UID == c.contextUID)
		c.mu.Unlock()
		if !matched {
			return nil
		}
	} else if method != "Runtime.executionContextsCleared" || len(fields) != 0 {
		return errors.New("invalid worker destruction")
	}
	c.recordExecutionEnd(method)
	c.markWorkerGone()
	return nil
}

type managedRecoveryWitness struct {
	Kind         string               `json:"kind"`
	Retirement   json.RawMessage      `json:"retirement,omitempty"`
	ExecutionEnd *managedExecutionEnd `json:"executionEnd,omitempty"`
}

func (c *UserController) recoveryWitness() (managedRecoveryWitness, error) {
	select {
	case <-c.cleanupDone:
	default:
		return managedRecoveryWitness{}, errors.New("original user transport cleanup has not actually finished")
	}
	c.mu.Lock()
	defer c.mu.Unlock()
	retirementErr := c.validateRetirementLocked(c.cleanupReceipt)
	if retirementErr == nil && c.executionEnd == nil {
		return managedRecoveryWitness{Kind: "bridge-retired", Retirement: append(json.RawMessage(nil), c.cleanupReceipt...)}, nil
	}
	if c.humanRisk && retirementErr != nil {
		return managedRecoveryWitness{}, errors.New("original human input cleanup remains unknown; Stop this run")
	}
	if c.executionEnd == nil {
		return managedRecoveryWitness{}, errors.New("original worker execution end is not confirmed")
	}
	select {
	case <-c.ownerDone:
		return managedRecoveryWitness{}, errors.New("original owned Browser already exited")
	default:
	}
	var receipt struct{ CleanupProof string }
	if retirementErr != nil && (json.Unmarshal(c.cleanupReceipt, &receipt) != nil || receipt.CleanupProof != "worker-execution-ended") {
		return managedRecoveryWitness{}, errors.New("original execution transport is not retired")
	}
	proof := *c.executionEnd
	witness := managedRecoveryWitness{Kind: "worker-execution-ended", ExecutionEnd: &proof}
	if retirementErr == nil {
		witness.Retirement = append(json.RawMessage(nil), c.cleanupReceipt...)
	}
	return witness, nil
}

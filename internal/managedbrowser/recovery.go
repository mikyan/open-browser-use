package managedbrowser

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"time"

	"github.com/ifuryst/open-browser-use/internal/host"
	"github.com/ifuryst/open-browser-use/internal/managedprotocol"
	"github.com/ifuryst/open-browser-use/internal/transport"
)

const nativeConnectionLimit = 32

// RecoveryStatus concerns user control, separately from the owned Browser's
// lifetime. Only ready publishes a task endpoint through Info.
type RecoveryStatus struct {
	State string `json:"state"`
	Epoch uint64 `json:"epoch"`
	Error string `json:"error,omitempty"`
}

type managedNativeHandle interface {
	Wait(context.Context) error
	ExitCode() (uint32, error)
	CreationTime() uint64
	Close() error
}

type ownedBrowserProcess interface {
	PID() int
	Wait() error
	ExitCode() (uint32, error)
	NativeHost(int, string) (*platformNativeProcess, error)
	WaitTree(context.Context) error
	Terminate() error
	Close() error
}

type nativeConnectionRecord struct {
	Epoch             uint64                  `json:"epoch"`
	Descriptor        host.ActiveSocketRecord `json:"descriptor"`
	CreationTime      uint64                  `json:"creationTime"`
	Binding           json.RawMessage         `json:"binding,omitempty"`
	Exit              *exitReceipt            `json:"exit,omitempty"`
	ExitConfirmed     bool                    `json:"exitConfirmed"`
	ControllerCleanup *acknowledgement        `json:"controllerCleanup,omitempty"`
	ExecutionEnd      *managedExecutionEnd    `json:"executionEnd,omitempty"`
	WorkerRecovery    *acknowledgement        `json:"workerRecovery,omitempty"`
	Worker            *managedWorkerIdentity  `json:"worker,omitempty"`
	RecoveryState     *managedRecoveryState   `json:"recoveryState,omitempty"`
	Error             string                  `json:"error,omitempty"`
}

type nativeConnection struct {
	handle         managedNativeHandle
	done           chan struct{}
	record         nativeConnectionRecord
	controller     *UserController
	exitBeforeStop bool
}

// The unexported seam keeps process/transport ownership in this module. Tests
// can delay an original receipt without launching or replacing a browser.
type nativeRecoveryHooks struct {
	read func() (host.ActiveSocketRecord, error)
	hold func(int) (managedNativeHandle, error)
	call func(context.Context, string, string, any, any) error
	open func(context.Context, string, managedUserIdentity, <-chan struct{}, *managedWorkerAdmission, func(*UserController)) (*UserController, error)
}

func (s *Session) RecoveryStatus() RecoveryStatus {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.recovery
}

func (s *Session) Changes() <-chan struct{} { return s.changes }

func (s *Session) notifyLocked() {
	select {
	case s.changes <- struct{}{}:
	default:
	}
}

func (s *Session) waitNative(connection *nativeConnection) {
	waitErr := connection.handle.Wait(context.Background())
	code, codeErr := connection.handle.ExitCode()
	exit := processReceipt(code, codeErr, waitErr)
	s.mu.Lock()
	connection.record.Exit = &exit
	connection.record.ExitConfirmed = nativeExitConfirmed(code, codeErr, waitErr)
	if connection == s.currentNative {
		s.nativeExit = exit
	}
	close(connection.done)
	s.mu.Unlock()
}

func nativeExitConfirmed(code uint32, codeErr, waitErr error) bool {
	if codeErr != nil {
		return false
	}
	if waitErr == nil {
		return true
	}
	// Only this platform's exact nonzero-exit result proves an original Wait.
	// A joined/wrapped unknown error must not be hidden by errors.As.
	exit, ok := waitErr.(*platformExitError)
	return ok && exit != nil && code != 0 && exit.Code == code
}

func (s *Session) observeNative(connection *nativeConnection) {
	<-connection.done
	s.mu.Lock()
	if connection != s.currentNative || s.recovery.State != "ready" {
		s.mu.Unlock()
		return
	}
	s.recovery.State, s.recovery.Error = "degraded", "original native host exited; explicit recovery or Stop is required"
	s.record.State = "degraded"
	controller := s.userCurrent
	if err := s.saveLocked(); err != nil {
		s.recovery.Error = "native loss lifecycle could not be saved"
		s.recoveryUnconfirmed = true
	}
	s.notifyLocked()
	s.mu.Unlock()
	if controller != nil {
		controller.unavailable(errors.New("original managed native host exited"))
	}
}

func (s *Session) retainController(controller *UserController) {
	controller.mu.Lock()
	controller.executionEndHook = func(proof managedExecutionEnd) { s.recordControllerExecutionEnd(controller, proof) }
	controller.mu.Unlock()
	s.mu.Lock()
	s.controllers = append(s.controllers, controller)
	s.mu.Unlock()
}

func (s *Session) recordControllerExecutionEnd(controller *UserController, proof managedExecutionEnd) {
	s.mu.Lock()
	defer s.mu.Unlock()
	for _, connection := range s.nativeConnections {
		if connection.controller == controller {
			copy := proof
			connection.record.ExecutionEnd = &copy
			if s.recovery.State != "closing" && s.recovery.State != "closed" {
				if err := s.saveLocked(); err != nil {
					s.recoveryUnconfirmed = true
					s.recovery.Error = "worker execution end lifecycle could not be saved"
				}
			}
			s.notifyLocked()
			return
		}
	}
}

func (s *Session) observeController(controller *UserController) {
	<-controller.Done()
	controller.mu.Lock()
	var ended *managedExecutionEnd
	if controller.executionEnd != nil {
		copy := *controller.executionEnd
		ended = &copy
	}
	controller.mu.Unlock()
	s.mu.Lock()
	defer s.mu.Unlock()
	if controller != s.userCurrent || s.recovery.State != "ready" {
		return
	}
	s.recovery.State, s.recovery.Error = "degraded", "original worker control ended; explicit recovery or Stop is required"
	s.record.State = "degraded"
	if s.currentNative != nil {
		s.currentNative.record.ExecutionEnd = ended
	}
	if err := s.saveLocked(); err != nil {
		s.recovery.Error = "worker loss lifecycle could not be saved"
		s.recoveryUnconfirmed = true
	}
	s.notifyLocked()
}

func (s *Session) recoveryOperations() nativeRecoveryHooks {
	if s.recoveryHooks != nil {
		return *s.recoveryHooks
	}
	return nativeRecoveryHooks{
		read: func() (host.ActiveSocketRecord, error) {
			var descriptor host.ActiveSocketRecord
			data, err := readSmallFile(filepath.Join(s.endpointDir, "active.json"), 4096)
			if err == nil {
				err = json.Unmarshal(data, &descriptor)
			}
			return descriptor, err
		},
		hold: func(pid int) (managedNativeHandle, error) { return s.process.NativeHost(pid, s.nativeExecutable) },
		call: nativeCall,
		open: openUserControllerRetained,
	}
}

func (s *Session) recoveryAlive(ctx context.Context) error {
	if err := contextError(ctx); err != nil {
		return err
	}
	select {
	case <-s.browserDone:
		return errors.New("original managed Browser exited during recovery")
	default:
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.recovery.State != "recovering" {
		return errors.New("managed recovery was retired by Stop")
	}
	return nil
}

// Recover changes only the native/user connection epoch. It never launches a
// browser, changes profile, discovers another Browser root, or replays input.
// Failed submitted attempts remain owned until Stop; their outcome is not
// replaced by a caller cancellation or a second binding attempt.
func (s *Session) Recover(parent context.Context, previous *UserController) (next *UserController, err error) {
	ctx, cancel := context.WithTimeout(parent, 45*time.Second)
	defer cancel()
	s.mu.Lock()
	if err := contextError(ctx); err != nil {
		s.mu.Unlock()
		return nil, err
	}
	if s.info.Mode == "setup" || s.recovery.State != "degraded" || previous == nil || previous != s.userCurrent || s.currentNative == nil {
		s.mu.Unlock()
		return nil, errors.New("recovery requires the original degraded managed controller")
	}
	if s.recoveryUnconfirmed || len(s.nativeConnections) >= nativeConnectionLimit || len(s.controllers) >= nativeConnectionLimit {
		s.mu.Unlock()
		return nil, errors.New("managed recovery is unconfirmed or its capacity is exhausted; Stop this run")
	}
	old := s.currentNative
	info, root := s.info, s.userRootURL
	finished := make(chan struct{})
	s.recovery.State, s.recovery.Error = "recovering", ""
	s.recoveryCancel, s.recoveryDone = cancel, finished
	s.record.State = "recovering"
	s.notifyLocked()
	s.mu.Unlock()
	var candidate *nativeConnection
	var prepared *UserController
	defer func() {
		s.mu.Lock()
		if err != nil {
			if candidate != nil {
				candidate.record.Error = err.Error()
				s.recoveryUnconfirmed = true
			}
			if s.recovery.State != "closing" && s.recovery.State != "closed" {
				s.recovery.State, s.recovery.Error = "degraded", err.Error()
				s.record.State = "degraded"
			}
		}
		s.recoveryCancel = nil
		if saveErr := s.saveLocked(); saveErr != nil {
			err = errors.Join(err, saveErr)
			s.recoveryUnconfirmed = true
			if s.recovery.State == "ready" {
				s.recovery.State, s.recovery.Error, s.record.State = "degraded", "recovery lifecycle could not be saved", "degraded"
			}
		}
		s.notifyLocked()
		close(finished)
		s.mu.Unlock()
		if err != nil {
			if prepared != nil {
				prepared.unavailable(errors.New("managed replacement user controller was not committed"))
			}
			next = nil
		}
	}()
	if err = s.recoveryAlive(ctx); err != nil {
		return nil, err
	}
	select {
	case <-old.done:
	case <-ctx.Done():
		return nil, ctx.Err()
	}
	if !old.record.ExitConfirmed || old.record.Exit == nil || old.record.Exit.Code == nil {
		return nil, errors.New("original native process exit is not confirmed")
	}
	worker := previous.workerIdentity()
	if err = previous.Close(ctx); err != nil {
		return nil, fmt.Errorf("original user cleanup is not confirmed: %w", err)
	}
	witness, err := previous.recoveryWitness()
	if err != nil {
		return nil, err
	}
	s.mu.Lock()
	previous.mu.Lock()
	cleanup := append(json.RawMessage(nil), previous.cleanupReceipt...)
	state := previous.recoveryState
	viewLease := ""
	if previous.viewStatus != nil && previous.viewStatus.State != "released" {
		viewLease = previous.viewStatus.LeaseID
	}
	previous.mu.Unlock()
	old.record.ControllerCleanup = receipt(cleanup, nil)
	old.record.ExecutionEnd = witness.ExecutionEnd
	s.mu.Unlock()
	ops := s.recoveryOperations()
	var descriptor host.ActiveSocketRecord
	for {
		if err = s.recoveryAlive(ctx); err != nil {
			return nil, err
		}
		descriptor, err = ops.read()
		if err == nil {
			if descriptor.SocketPath == old.record.Descriptor.SocketPath && descriptor.PID == old.record.Descriptor.PID {
				// The original host can leave its descriptor until its EOF cleanup.
			} else {
				if !transport.IsNamedPipe(descriptor.SocketPath) || descriptor.PID <= 0 || descriptor.StartedAt.IsZero() {
					return nil, errors.New("invalid replacement native endpoint descriptor")
				}
				break
			}
		} else if !errors.Is(err, os.ErrNotExist) && !platformSharingViolation(err) {
			return nil, err
		}
		timer := time.NewTimer(25 * time.Millisecond)
		select {
		case <-timer.C:
		case <-ctx.Done():
			timer.Stop()
			return nil, ctx.Err()
		}
	}
	candidate, err = s.retainNativeCandidate(descriptor, ops)
	if err != nil {
		return nil, err
	}
	if candidate.record.CreationTime <= old.record.CreationTime || descriptor.SocketPath == old.record.Descriptor.SocketPath {
		return nil, errors.New("replacement native process or endpoint did not change")
	}
	select {
	case <-candidate.done:
		return nil, errors.New("replacement native process already exited")
	default:
	}
	var backend struct {
		Type     string `json:"type"`
		Metadata struct {
			ExtensionID         string `json:"extensionId"`
			ExtensionInstanceID string `json:"extensionInstanceId"`
			NativeHostName      string `json:"nativeHostName"`
		} `json:"metadata"`
	}
	if err = ops.call(ctx, descriptor.SocketPath, "getInfo", map[string]any{}, &backend); err != nil {
		return nil, err
	}
	if backend.Type != "extension" || backend.Metadata.ExtensionID != info.ExtensionID || backend.Metadata.ExtensionInstanceID != info.ExtensionInstanceID || backend.Metadata.NativeHostName != info.NativeHostName {
		return nil, errors.New("replacement native endpoint changed the original extension identity")
	}
	deadline, _ := ctx.Deadline()
	var binding json.RawMessage
	if err = ops.call(ctx, descriptor.SocketPath, "host.bindBrowser", map[string]any{"cdpURL": root, "exclusive": true, "timeoutMs": time.Until(deadline).Milliseconds()}, &binding); err != nil {
		return nil, err
	}
	s.mu.Lock()
	candidate.record.Binding = append(json.RawMessage(nil), binding...)
	s.mu.Unlock()
	if err = validateBinding(binding, info); err != nil {
		return nil, err
	}
	var identity managedUserIdentity
	if err = json.Unmarshal(binding, &identity); err != nil {
		return nil, err
	}
	if identity.PortID == previous.identity.PortID {
		return nil, errors.New("managed recovery requires a new native Port")
	}
	admission := &managedWorkerAdmission{Original: worker, State: state, ViewLeaseID: viewLease}
	if witness.Kind == "worker-execution-ended" {
		if identity.WorkerBootID == worker.WorkerBootID {
			return nil, errors.New("replacement worker boot identity did not change")
		}
		nonce, nonceErr := randomID()
		if nonceErr != nil {
			return nil, nonceErr
		}
		admission.Replacement = &managedWorkerRecoveryRequest{Kind: "worker-replacement", PreviousWorkerBootID: worker.WorkerBootID,
			BrowserIncarnation: state.BrowserIncarnation, ExpectedJournalID: state.JournalID, ExpectedWorkerEpoch: state.WorkerEpoch, Nonce: nonce}
	} else if identity.WorkerBootID != worker.WorkerBootID {
		return nil, errors.New("managed recovery worker changed without original execution end evidence")
	}
	var oldBinding, newBinding struct{ Generation string }
	if json.Unmarshal(old.record.Binding, &oldBinding) != nil || json.Unmarshal(binding, &newBinding) != nil || oldBinding.Generation == "" || oldBinding.Generation == newBinding.Generation {
		return nil, errors.New("replacement Browser binding generation did not change")
	}
	identity.Version, identity.RunID = 1, info.RunID
	if err = s.recoveryAlive(ctx); err != nil {
		return nil, err
	}
	prepared, err = ops.open(ctx, root, identity, s.ownerTerminated, admission, func(controller *UserController) {
		s.retainController(controller)
		s.mu.Lock()
		candidate.controller = controller
		s.mu.Unlock()
	})
	if err != nil {
		return nil, err
	}
	status, err := prepared.Command(ctx, json.RawMessage(`{"operation":"status"}`))
	if err != nil {
		return nil, err
	}
	if err = recoveryPaused(status); err != nil {
		return nil, err
	}
	if admission.Replacement != nil {
		prepared.mu.Lock()
		workerReceipt := append(json.RawMessage(nil), prepared.workerRecovery...)
		prepared.mu.Unlock()
		s.mu.Lock()
		candidate.record.WorkerRecovery = receipt(workerReceipt, nil)
		s.mu.Unlock()
	}
	observed, err := ops.read()
	if err != nil || observed != descriptor {
		return nil, errors.New("replacement native descriptor changed before commit")
	}
	preparedWorker := prepared.workerIdentity()
	prepared.mu.Lock()
	preparedState := prepared.recoveryState
	prepared.mu.Unlock()
	s.mu.Lock()
	candidate.record.Worker, candidate.record.RecoveryState = &preparedWorker, &preparedState
	s.mu.Unlock()
	s.mu.Lock()
	defer s.mu.Unlock()
	if err = contextError(ctx); err != nil || s.recovery.State != "recovering" {
		return nil, errors.New("managed recovery was canceled before commit")
	}
	select {
	case <-candidate.done:
		return nil, errors.New("replacement native host exited before commit")
	case <-s.browserDone:
		return nil, errors.New("original Browser exited before recovery commit")
	case <-prepared.Done():
		return nil, errors.New("replacement user controller ended before commit")
	default:
	}
	s.currentNative, s.native, s.nativeDone = candidate, candidate.handle, candidate.done
	s.userCurrent = prepared
	s.info.NativePID, s.info.SocketPath = descriptor.PID, descriptor.SocketPath
	s.record.NativeDescriptor, s.record.NativeCreationTime, s.record.Binding = &candidate.record.Descriptor, candidate.record.CreationTime, binding
	s.record.NativeExit = nil
	s.record.Info = s.info
	s.recovery = RecoveryStatus{State: "ready", Epoch: candidate.record.Epoch}
	s.record.State = "ready"
	go s.observeNative(candidate)
	go s.observeController(prepared)
	return prepared, nil
}

func recoveryPaused(value json.RawMessage) error {
	return recoveryState(value, true)
}

func recoveryState(value json.RawMessage, connected bool) error {
	var response struct {
		Status struct {
			Connected   bool    `json:"connected"`
			Selected    *uint64 `json:"selectedTabId"`
			Pending     *uint64 `json:"cleanupPending"`
			Human, View json.RawMessage
			Automation  struct {
				State                         string
				InputBlocked, CleanupComplete bool
			}
		} `json:"status"`
	}
	if json.Unmarshal(value, &response) != nil || response.Status.Connected != connected || response.Status.Selected != nil || response.Status.Pending == nil || *response.Status.Pending != 0 || connected && (response.Status.Automation.State != "paused" || !response.Status.Automation.InputBlocked || !response.Status.Automation.CleanupComplete) || (len(response.Status.Human) != 0 && string(response.Status.Human) != "null") || (len(response.Status.View) != 0 && string(response.Status.View) != "null") {
		return errors.New("replacement user control has not confirmed paused and clean state")
	}
	fields, err := userObject(value)
	if err != nil {
		return err
	}
	state, err := userObject(fields["status"])
	if err != nil || state["connected"] == nil || state["selectedTabId"] == nil || (state["cleanupError"] != nil && string(state["cleanupError"]) != "null") {
		return errors.New("recovery state lacks an exact clean receipt")
	}
	return nil
}

func (c *UserController) recoveryCleanup() (json.RawMessage, error) {
	select {
	case <-c.cleanupDone:
	default:
		return nil, errors.New("original user cleanup has not actually finished")
	}
	c.mu.Lock()
	defer c.mu.Unlock()
	if err := c.validateRetirementLocked(c.cleanupReceipt); err != nil {
		return nil, err
	}
	return append(json.RawMessage(nil), c.cleanupReceipt...), nil
}

// Close is a whole-channel cleanup boundary for both HTTP retirement and
// native recovery. A valid identity alone is not a release acknowledgement.
func (c *UserController) validateRetirementLocked(receipt json.RawMessage) error {
	var result struct {
		Disconnected bool
		CleanupProof string
		Status       json.RawMessage
	}
	if json.Unmarshal(receipt, &result) != nil || !result.Disconnected || result.CleanupProof != "" {
		return errors.New("retirement requires original worker cleanup, not worker or Browser termination")
	}
	if err := recoveryState(receipt, false); err != nil {
		return err
	}
	fields, err := userObject(result.Status)
	if err != nil || string(fields["human"]) != "null" || string(fields["view"]) != "null" {
		return errors.New("original user resources lack explicit null retirement")
	}
	stream, err := userObject(fields["stream"])
	if err != nil || string(stream["state"]) != `"idle"` || string(stream["streamId"]) != "null" {
		return errors.New("original viewer stream was not retired")
	}
	if c.humanRisk && c.humanStatus != nil {
		cleanup, err := managedprotocol.ParseHumanCleanup(fields["humanCleanup"])
		if err != nil || cleanup == nil || cleanup.LeaseID != c.humanStatus.LeaseID || !cleanup.CleanupConfirmed {
			return errors.New("original human lease release receipt is missing")
		}
	}
	// validateStatusLocked can update tracked view/human state. It must run
	// only after cleanup is checked against the original risk identity.
	return c.validateStatusLocked(result.Status)
}

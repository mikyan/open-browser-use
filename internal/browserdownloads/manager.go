// Package browserdownloads binds original Page claims to one verified native
// Browser connection. It never discovers files by URL, filename or directory.
package browserdownloads

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"path/filepath"
	"strings"
	"sync"
	"time"
)

type Identity struct {
	Nonce               string `json:"nonce"`
	ExtensionID         string `json:"extensionId"`
	ExtensionInstanceID string `json:"extensionInstanceId"`
	WorkerBootID        string `json:"workerBootId"`
	PortID              string `json:"portId"`
}

// Claim is admitted only through the original extension's private native port.
// ClaimID identifies that Page record and attachment, not just a public GUID.
type Claim struct {
	GUID         string `json:"guid"`
	FrameID      string `json:"frameId"`
	RootTargetID string `json:"rootTargetId"`
	SessionID    string `json:"session_id"`
	TurnID       string `json:"turn_id"`
	ControlEpoch int64  `json:"control_epoch"`
	TabID        int64  `json:"tabId"`
	ClaimID      string `json:"claimId"`
}

type downloadRecord struct {
	created   time.Time
	frame     string
	state     string
	path      string
	claim     *Claim
	confirmed bool
	revoked   bool
}

const recordLimit = 128
const revocationLimit = 4096
const unclaimedTTL = time.Minute
const maximumSetupTimeout = 120 * time.Second

// A Browser may hold the HTTP Upgrade response while its user approves this
// exact connection. An explicit caller deadline covers that wait and all setup
// commands together; it is never restarted after the handshake. Direct callers
// without a deadline retain the original ten-second default.
func setupContext(ctx context.Context) (context.Context, context.CancelFunc) {
	limit := commandTimeout
	if _, bounded := ctx.Deadline(); bounded {
		limit = maximumSetupTimeout
	}
	return context.WithTimeout(ctx, limit)
}

type Manager struct {
	transport  *transport
	generation string
	contextID  string
	mu         sync.Mutex
	records    map[string]*downloadRecord
	// GUID revocations live for the whole generation, independently of the
	// expiring native event cache. Exhaustion retires the binding, never a tombstone.
	revocations            map[string]struct{}
	changed                chan struct{}
	ready                  bool
	configurationAttempted bool
	closing                bool
	closeOnce              sync.Once
	closeErr               error
}

// Dial's context bounds setup only. A successful Manager lives until Close or
// its original transport fails; canceling the setup caller does not retire it.
func Dial(ctx context.Context, endpoint string, identity Identity) (*Manager, error) {
	if err := ValidateURL(endpoint); err != nil {
		return nil, err
	}
	if err := validateIdentity(identity); err != nil {
		return nil, err
	}
	setup, cancel := setupContext(ctx)
	defer cancel()
	var random [16]byte
	if _, err := rand.Read(random[:]); err != nil {
		return nil, err
	}
	m := &Manager{generation: hex.EncodeToString(random[:]), records: make(map[string]*downloadRecord), revocations: make(map[string]struct{}), changed: make(chan struct{})}
	t, err := dialTransport(setup, endpoint, m.event, m.invalidate)
	if err != nil {
		return nil, err
	}
	m.transport = t
	ok := false
	defer func() {
		if !ok {
			t.close()
		}
	}()
	if err := m.verifyWorker(setup, identity); err != nil {
		return nil, err
	}
	m.mu.Lock()
	m.configurationAttempted = true
	m.mu.Unlock()
	// Capability is not usable until this actual Browser acknowledgement arrives.
	if err := m.call(setup, "Browser.setDownloadBehavior", "", m.contextParams(map[string]any{"behavior": "default", "eventsEnabled": true}), nil); err != nil {
		return nil, err
	}
	if err := contextError(setup); err != nil {
		_ = m.Close()
		return nil, &lateAcknowledgementError{cause: err}
	}
	m.mu.Lock()
	m.ready = true
	m.mu.Unlock()
	if err := t.error(); err != nil {
		return nil, err
	}
	ok = true
	return m, nil
}

func validateIdentity(identity Identity) error {
	if len(identity.ExtensionID) != 32 || strings.Trim(identity.ExtensionID, "abcdefghijklmnop") != "" ||
		!validText(identity.Nonce, 256) || !validText(identity.ExtensionInstanceID, 256) ||
		!validText(identity.WorkerBootID, 256) || !validText(identity.PortID, 256) {
		return failure("IDENTITY", "a complete extension, worker and native port challenge is required")
	}
	return nil
}

func (m *Manager) verifyWorker(ctx context.Context, identity Identity) error {
	var targets struct {
		Targets []struct {
			ID      string `json:"targetId"`
			Type    string `json:"type"`
			URL     string `json:"url"`
			Context string `json:"browserContextId"`
		} `json:"targetInfos"`
	}
	if err := m.call(ctx, "Target.getTargets", "", map[string]any{}, &targets); err != nil {
		return err
	}
	worker := ""
	for _, target := range targets.Targets {
		if target.Type == "service_worker" && target.URL == "chrome-extension://"+identity.ExtensionID+"/background.js" {
			if worker != "" {
				return failure("IDENTITY", "more than one matching extension worker")
			}
			worker, m.contextID = target.ID, target.Context
		}
	}
	if !validText(worker, 256) {
		return failure("IDENTITY", "the exact extension worker is absent from this Browser")
	}
	var attachment struct {
		Session string `json:"sessionId"`
	}
	if err := m.call(ctx, "Target.attachToTarget", "", map[string]any{"targetId": worker, "flatten": true}, &attachment); err != nil {
		return err
	}
	if !validText(attachment.Session, 256) {
		return failure("IDENTITY", "worker attachment has no native session")
	}
	var evaluated struct {
		Result struct {
			Type  string          `json:"type"`
			Value json.RawMessage `json:"value"`
		} `json:"result"`
		Exception json.RawMessage `json:"exceptionDetails"`
	}
	err := m.call(ctx, "Runtime.evaluate", attachment.Session, map[string]any{
		"expression": "globalThis.__obuNativeDownloadBinding", "returnByValue": true, "silent": true,
	}, &evaluated)
	if err == nil {
		var value Identity
		fields, parseErr := decodeObject(evaluated.Result.Value)
		keysMatch := len(fields) == 5
		for _, key := range []string{"nonce", "extensionId", "extensionInstanceId", "workerBootId", "portId"} {
			if _, ok := fields[key]; !ok {
				keysMatch = false
			}
		}
		if evaluated.Result.Type != "object" || len(evaluated.Exception) != 0 || parseErr != nil || !keysMatch || json.Unmarshal(evaluated.Result.Value, &value) != nil || value != identity {
			err = failure("IDENTITY", "native port challenge does not match this Browser's extension worker")
		}
	}
	cleanup, cancel := context.WithTimeout(context.Background(), time.Second)
	defer cancel()
	detachErr := m.call(cleanup, "Target.detachFromTarget", "", map[string]any{"sessionId": attachment.Session}, nil)
	if err != nil {
		return err
	}
	return detachErr
}

func (m *Manager) Generation() string    { return m.generation }
func (m *Manager) Done() <-chan struct{} { return m.transport.done }
func (m *Manager) Err() error            { return m.transport.error() }

func (m *Manager) call(ctx context.Context, method, session string, params, output any) error {
	err := m.transport.call(ctx, method, session, params, output)
	var late *lateAcknowledgementError
	if errors.As(err, &late) {
		// Close gates reset on completed identity verification and an entered
		// configuration phase. Early challenge failures can only close the socket.
		_ = m.Close()
	}
	return err
}

func (m *Manager) contextParams(params map[string]any) map[string]any {
	if m.contextID != "" {
		params["browserContextId"] = m.contextID
	}
	return params
}

func validateClaim(c Claim) error {
	if !validText(c.GUID, 256) || !validText(c.FrameID, 256) || !validText(c.RootTargetID, 256) || !validText(c.ClaimID, 256) ||
		len(c.SessionID) == 0 || len(c.SessionID) > 4096 || len(c.TurnID) == 0 || len(c.TurnID) > 4096 ||
		c.ControlEpoch < 1 || c.ControlEpoch > 9007199254740991 || c.TabID < 0 || c.TabID > 9007199254740991 {
		return failure("CLAIM", "invalid original Page claim")
	}
	return nil
}

func (m *Manager) liveLocked() error {
	if err := m.transport.error(); err != nil {
		return err
	}
	if !m.ready || m.closing {
		return failure("DISCONNECTED", "original Browser download binding is not available")
	}
	return nil
}

func (m *Manager) signalLocked() { close(m.changed); m.changed = make(chan struct{}) }

func (m *Manager) invalidate() {
	m.mu.Lock()
	defer m.mu.Unlock()
	m.closing = true
	m.ready = false
	m.records = make(map[string]*downloadRecord)
	m.revocations = nil
	m.signalLocked()
}

func (m *Manager) pruneLocked() {
	now := time.Now()
	for guid, record := range m.records {
		if (record.claim == nil || record.revoked) && now.Sub(record.created) >= unclaimedTTL {
			delete(m.records, guid)
		}
	}
}

// makeRoomLocked may forget only unclaimed evidence. An evicted GUID cannot be
// reconstructed from later progress, paths, filenames or another connection.
func (m *Manager) makeRoomLocked() bool {
	m.pruneLocked()
	if len(m.records) < recordLimit {
		return true
	}
	oldest := ""
	var at time.Time
	for guid, record := range m.records {
		if (record.claim == nil || record.revoked) && (oldest == "" || record.created.Before(at)) {
			oldest, at = guid, record.created
		}
	}
	if oldest == "" {
		return false
	}
	delete(m.records, oldest)
	return true
}

func (m *Manager) Claim(ctx context.Context, c Claim) error {
	if err := validateClaim(c); err != nil {
		return err
	}
	ctx, cancel := context.WithTimeout(ctx, commandTimeout)
	defer cancel()
	if err := ctx.Err(); err != nil {
		return err
	}
	m.mu.Lock()
	if err := m.liveLocked(); err != nil {
		m.mu.Unlock()
		return err
	}
	if _, revoked := m.revocations[c.GUID]; revoked {
		m.mu.Unlock()
		return failure("CLAIM", "original Page GUID was permanently released from this Browser binding")
	}
	m.pruneLocked()
	r := m.records[c.GUID]
	if r == nil {
		if !m.makeRoomLocked() {
			m.mu.Unlock()
			return failure("LIMIT", "native download claim capacity reached")
		}
		r = &downloadRecord{created: time.Now()}
		m.records[c.GUID] = r
	}
	if r.revoked || (r.claim != nil && *r.claim != c) {
		m.mu.Unlock()
		return failure("CLAIM", "GUID is already bound to a different or revoked Page claim")
	}
	r.claim = &c
	m.signalLocked()
	m.mu.Unlock()
	var info struct {
		Target struct {
			ID      string `json:"targetId"`
			Type    string `json:"type"`
			Context string `json:"browserContextId"`
		} `json:"targetInfo"`
	}
	if err := m.call(ctx, "Target.getTargetInfo", "", map[string]any{"targetId": c.RootTargetID}, &info); err != nil {
		m.Release(c)
		return err
	}
	if info.Target.ID != c.RootTargetID || info.Target.Type != "page" || info.Target.Context != m.contextID {
		m.Release(c)
		return failure("CLAIM", "claimed root is not a Page in the verified Browser context")
	}
	for {
		if err := ctx.Err(); err != nil {
			m.Release(c)
			return err
		}
		m.mu.Lock()
		if err := m.liveLocked(); err != nil {
			m.mu.Unlock()
			return err
		}
		if m.records[c.GUID] != r || r.revoked || r.claim == nil || *r.claim != c {
			m.mu.Unlock()
			return failure("CLAIM", "original Page claim was released")
		}
		if r.frame != "" {
			if r.frame != c.FrameID {
				m.mu.Unlock()
				m.Release(c)
				return failure("CLAIM", "original Page frame does not match native GUID")
			}
			r.confirmed = true
			m.mu.Unlock()
			return nil
		}
		changed := m.changed
		m.mu.Unlock()
		select {
		case <-changed:
		case <-m.Done():
			return m.Err()
		case <-ctx.Done():
			m.Release(c)
			return ctx.Err()
		}
	}
}

func (m *Manager) lookupLocked(c Claim) (*downloadRecord, error) {
	if err := m.liveLocked(); err != nil {
		return nil, err
	}
	r := m.records[c.GUID]
	if r == nil || r.claim == nil || *r.claim != c || !r.confirmed || r.revoked {
		return nil, failure("CLAIM", "unknown, unowned or released original Page download")
	}
	return r, nil
}

func (m *Manager) Path(ctx context.Context, c Claim) (string, error) {
	if err := validateClaim(c); err != nil {
		return "", err
	}
	ctx, cancel := context.WithTimeout(ctx, 120*time.Second)
	defer cancel()
	for {
		if err := ctx.Err(); err != nil {
			return "", err
		}
		m.mu.Lock()
		r, err := m.lookupLocked(c)
		if err != nil {
			m.mu.Unlock()
			return "", err
		}
		if r.state == "canceled" {
			m.mu.Unlock()
			return "", failure("CANCELED", "original download was canceled")
		}
		if r.state == "completed" {
			filePath := r.path
			m.mu.Unlock()
			if !filepath.IsAbs(filePath) || len(filePath) > 32768 || strings.ContainsAny(filePath, "\x00\r\n") {
				return "", failure("PATH_UNAVAILABLE", "completed native event has no usable absolute filePath")
			}
			if err := readableFile(filePath); err != nil {
				return "", failure("FILE_UNAVAILABLE", err.Error())
			}
			m.mu.Lock()
			_, err = m.lookupLocked(c)
			m.mu.Unlock()
			if err != nil {
				return "", err
			}
			if err := ctx.Err(); err != nil {
				return "", err
			}
			return filePath, nil
		}
		changed := m.changed
		m.mu.Unlock()
		select {
		case <-changed:
		case <-m.Done():
			return "", m.Err()
		case <-ctx.Done():
			return "", ctx.Err()
		}
	}
}

func (m *Manager) Cancel(ctx context.Context, c Claim) error {
	if err := validateClaim(c); err != nil {
		return err
	}
	m.mu.Lock()
	_, err := m.lookupLocked(c)
	m.mu.Unlock()
	if err != nil {
		return err
	}
	if err := m.call(ctx, "Browser.cancelDownload", "", m.contextParams(map[string]any{"guid": c.GUID}), nil); err != nil {
		return err
	}
	m.mu.Lock()
	_, err = m.lookupLocked(c)
	m.mu.Unlock()
	return err
}

// Release revokes access, not the browser's actual download or filesystem file.
func (m *Manager) Release(c Claim) {
	if validateClaim(c) != nil {
		return
	}
	m.mu.Lock()
	if m.closing {
		m.mu.Unlock()
		return
	}
	r := m.records[c.GUID]
	if r != nil && r.claim != nil && *r.claim != c {
		m.mu.Unlock()
		return
	}
	if _, revoked := m.revocations[c.GUID]; !revoked {
		if len(m.revocations) >= revocationLimit {
			// Block admission under the manager lock, then retire the transport
			// outside it: the terminal callback also acquires this lock.
			m.closing = true
			m.ready = false
			m.signalLocked()
			m.mu.Unlock()
			m.transport.terminal(failure("LIMIT", "revocation ledger capacity reached; original Browser binding retired"))
			return
		}
		m.revocations[c.GUID] = struct{}{}
	}
	if r != nil {
		r.claim = &c
		r.revoked = true
		r.path = ""
		r.created = time.Now()
	}
	m.signalLocked()
	m.mu.Unlock()
}

func (m *Manager) Close() error {
	m.closeOnce.Do(func() {
		m.mu.Lock()
		m.closing = true
		m.ready = false
		m.records = make(map[string]*downloadRecord)
		m.revocations = nil
		reset := m.configurationAttempted
		m.signalLocked()
		m.mu.Unlock()
		ctx, cancel := context.WithTimeout(context.Background(), time.Second)
		defer cancel()
		if reset {
			m.closeErr = m.transport.call(ctx, "Browser.setDownloadBehavior", "", m.contextParams(map[string]any{"behavior": "default", "eventsEnabled": false}), nil)
		}
		m.transport.close()
	})
	return m.closeErr
}

func (m *Manager) event(method string, data json.RawMessage) error {
	if method != "Browser.downloadWillBegin" && method != "Browser.downloadProgress" {
		return nil
	}
	var event struct {
		GUID  string `json:"guid"`
		Frame string `json:"frameId"`
		State string `json:"state"`
		Path  string `json:"filePath"`
	}
	if json.Unmarshal(data, &event) != nil || !validText(event.GUID, 256) {
		return failure("PROTOCOL", "malformed native download event")
	}
	m.mu.Lock()
	defer m.mu.Unlock()
	if m.closing {
		return nil
	}
	if _, revoked := m.revocations[event.GUID]; revoked {
		return nil
	}
	m.pruneLocked()
	r := m.records[event.GUID]
	if method == "Browser.downloadWillBegin" {
		if !validText(event.Frame, 256) {
			return failure("PROTOCOL", "native download begin has no frame")
		}
		if r == nil {
			if !m.makeRoomLocked() {
				return nil
			}
			r = &downloadRecord{created: time.Now()}
			m.records[event.GUID] = r
		}
		if r.revoked {
			return nil
		}
		if r.frame != "" {
			return failure("PROTOCOL", "duplicate native download GUID")
		}
		r.frame = event.Frame
	} else {
		if event.State != "inProgress" && event.State != "completed" && event.State != "canceled" {
			return failure("PROTOCOL", "unknown native download state")
		}
		// Progress alone never recreates an evicted/historical native begin.
		if r == nil || r.frame == "" || r.revoked {
			return nil
		}
		if r.state == "completed" || r.state == "canceled" {
			return failure("PROTOCOL", "native download progressed after its terminal event")
		}
		r.state = event.State
		if event.State == "completed" {
			if len(event.Path) > 32768 {
				return failure("PROTOCOL", "native download path exceeds the record limit")
			}
			r.path = event.Path
		}
	}
	m.signalLocked()
	return nil
}

package managedbrowser

import (
	"context"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/ifuryst/open-browser-use/internal/host"
	"github.com/ifuryst/open-browser-use/internal/managedprotocol"
)

type recoveryNative struct {
	done    chan struct{}
	once    sync.Once
	created uint64
	code    uint32
	waitErr error
	codeErr error
}

func (p *recoveryNative) Wait(ctx context.Context) error {
	select {
	case <-p.done:
		return p.waitErr
	case <-ctx.Done():
		return ctx.Err()
	}
}
func (p *recoveryNative) ExitCode() (uint32, error) {
	select {
	case <-p.done:
		return p.code, p.codeErr
	default:
		return 0, errors.New("original process is live")
	}
}

func TestManagedRecoveryKnownFaultExitRemainsRecoverable(t *testing.T) {
	f := newRecoveryFixture(t)
	old := f.s.currentNative
	old.done = make(chan struct{})
	old.handle.(*recoveryNative).waitErr = &platformExitError{Code: 1}
	f.s.waitNative(old)
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()
	if _, err := f.s.Recover(ctx, f.previous); err != nil {
		t.Fatal(err)
	}
	if old.record.Exit == nil || old.record.Exit.Error == "" || *old.record.Exit.Code != 1 {
		t.Fatal("original nonzero Wait result was erased")
	}
	root := &recoveryBrowser{entered: make(chan struct{}), gate: make(chan struct{}), exited: func() {
		f.handle.exit()
		f.s.browserExit = exitReceipt{At: time.Now().UTC(), Code: new(uint32)}
		close(f.s.browserDone)
	}}
	close(root.gate)
	f.s.process = root
	if err := f.s.Close(ctx); err != nil {
		t.Fatalf("historical confirmed fault poisoned final normal Stop: %v", err)
	}
	data, err := os.ReadFile(filepath.Join(f.s.info.RunDir, "lifecycle.json"))
	if err != nil {
		t.Fatal(err)
	}
	var record lifecycle
	if err := json.Unmarshal(data, &record); err != nil {
		t.Fatal(err)
	}
	if len(record.NativeConnections) != 2 || !record.NativeConnections[0].ExitConfirmed || record.NativeConnections[0].Exit.Error == "" || !record.NativeConnections[1].ExitConfirmed || *record.NativeConnections[1].Exit.Code != 0 || record.NativeConnections[1].ControllerCleanup == nil {
		t.Fatal("final lifecycle lost per-epoch exit and cleanup provenance")
	}
}

func TestManagedNativeExitConfirmationPreservesUnknownWaitFailures(t *testing.T) {
	unknown := errors.New("original handle wait failed")
	for _, test := range []struct {
		name             string
		code             uint32
		waitErr, codeErr error
		confirmed        bool
	}{
		{name: "normal", confirmed: true},
		{name: "known fault", code: 9, waitErr: &platformExitError{Code: 9}, confirmed: true},
		{name: "different exit", code: 9, waitErr: &platformExitError{Code: 8}},
		{name: "unknown wait", code: 9, waitErr: unknown},
		{name: "unknown joined", code: 9, waitErr: errors.Join(&platformExitError{Code: 9}, unknown)},
		{name: "unknown exit read", code: 9, waitErr: &platformExitError{Code: 9}, codeErr: unknown},
		{name: "zero is not nonzero fault", waitErr: &platformExitError{}},
	} {
		t.Run(test.name, func(t *testing.T) {
			handle := &recoveryNative{done: make(chan struct{}), code: test.code, waitErr: test.waitErr, codeErr: test.codeErr}
			handle.exit()
			connection := &nativeConnection{handle: handle, done: make(chan struct{})}
			s := &Session{currentNative: connection}
			s.waitNative(connection)
			if connection.record.ExitConfirmed != test.confirmed {
				t.Fatalf("wrong confirmation: %+v", connection.record)
			}
			if (test.waitErr != nil || test.codeErr != nil) && connection.record.Exit.Error == "" {
				t.Fatal("original process error erased")
			}
			if test.codeErr != nil && connection.record.Exit.Code != nil {
				t.Fatal("failed exit-code read invented a code")
			}
		})
	}
}
func (p *recoveryNative) CreationTime() uint64 { return p.created }
func (p *recoveryNative) Close() error         { return nil }
func (p *recoveryNative) exit()                { p.once.Do(func() { close(p.done) }) }

type recoveryFixture struct {
	s          *Session
	old, next  *userFixture
	previous   *UserController
	handle     *recoveryNative
	descriptor host.ActiveSocketRecord
	bindCalls  int
}

func newRecoveryFixture(t *testing.T, configure ...func(*recoveryFixture)) *recoveryFixture {
	t.Helper()
	f := &recoveryFixture{old: newUserFixture(t, nil, false), next: newUserFixture(t, nil, false)}
	f.next.identity.PortID = "replacement-port"
	f.next.paused = true
	for _, setup := range configure {
		setup(f)
	}
	info := Info{Name: "recovery", RunID: f.old.identity.RunID, RunDir: t.TempDir(), BrowserPID: 10, NativePID: 11, SocketPath: `\\.\pipe\original-native`, ExtensionID: f.old.identity.ExtensionID, ExtensionInstanceID: f.old.identity.ExtensionInstanceID, NativeHostName: "original-native-host"}
	f.s = &Session{info: info, done: make(chan struct{}), browserDone: make(chan struct{}), ownerTerminated: make(chan struct{}), changes: make(chan struct{}, 1), userRootURL: f.old.endpoint(), recovery: RecoveryStatus{State: "degraded", Epoch: 1}, record: lifecycle{Version: 1, State: "degraded", Info: info}}
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()
	identity := f.old.identity
	identity.ChannelID = ""
	var err error
	f.previous, err = openUserControllerRetained(ctx, f.old.endpoint(), identity, f.s.ownerTerminated, nil, f.s.retainController)
	if err != nil {
		t.Fatal(err)
	}
	f.s.userCurrent = f.previous
	oldHandle := &recoveryNative{done: make(chan struct{}), created: 100, code: 1}
	oldHandle.exit()
	code := uint32(1)
	old := &nativeConnection{handle: oldHandle, done: make(chan struct{}), record: nativeConnectionRecord{Epoch: 1, Descriptor: host.ActiveSocketRecord{PID: 11, SocketPath: info.SocketPath, StartedAt: time.Now().UTC()}, CreationTime: 100, Exit: &exitReceipt{At: time.Now().UTC(), Code: &code}}}
	old.record.Binding = json.RawMessage(`{"generation":"original-generation"}`)
	old.record.ExitConfirmed = true
	old.controller = f.previous
	close(old.done)
	f.s.nativeConnections = []*nativeConnection{old}
	f.s.currentNative = old
	f.handle = &recoveryNative{done: make(chan struct{}), created: 200}
	f.descriptor = host.ActiveSocketRecord{PID: 12, SocketPath: `\\.\pipe\replacement-native`, StartedAt: time.Now().UTC()}
	f.s.recoveryHooks = &nativeRecoveryHooks{
		read: func() (host.ActiveSocketRecord, error) { return f.descriptor, nil },
		hold: func(pid int) (managedNativeHandle, error) {
			if pid != 12 {
				t.Errorf("wrong candidate PID %d", pid)
			}
			return f.handle, nil
		},
		call: func(ctx context.Context, endpoint, method string, params, output any) error {
			if endpoint != f.descriptor.SocketPath {
				t.Errorf("wrong native endpoint %s", endpoint)
			}
			var value any
			if method == "getInfo" {
				value = map[string]any{"type": "extension", "metadata": map[string]any{"extensionId": info.ExtensionID, "extensionInstanceId": info.ExtensionInstanceID, "nativeHostName": info.NativeHostName}}
			} else if method == "host.bindBrowser" {
				f.bindCalls++
				p := params.(map[string]any)
				if p["cdpURL"] != f.s.userRootURL || p["exclusive"] != true {
					t.Errorf("original root was not preserved: %v", p)
				}
				value = map[string]any{"bound": true, "exclusive": true, "behavior": "default", "generation": "replacement-generation", "extensionId": info.ExtensionID, "extensionInstanceId": info.ExtensionInstanceID, "workerBootId": f.next.identity.WorkerBootID, "portId": f.next.identity.PortID}
			} else {
				return errors.New("unexpected native method")
			}
			data, _ := json.Marshal(value)
			return json.Unmarshal(data, output)
		},
		open: func(ctx context.Context, root string, id managedUserIdentity, owner <-chan struct{}, expected *managedWorkerAdmission, retain func(*UserController)) (*UserController, error) {
			if root != f.s.userRootURL {
				t.Errorf("changed root %s", root)
			}
			return openUserControllerRetained(ctx, f.next.endpoint(), id, owner, expected, retain)
		},
	}
	t.Cleanup(func() {
		if f.s.nativeObservationCancel != nil {
			f.s.nativeObservationCancel()
			<-f.s.nativeObservationDone
		}
		f.handle.exit()
		f.s.ownerOnce.Do(func() { close(f.s.ownerTerminated) })
		for _, controller := range f.s.controllers {
			ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
			if err := controller.Close(ctx); err != nil {
				t.Errorf("retained controller cleanup: %v", err)
			}
			cancel()
		}
		for _, connection := range f.s.nativeConnections {
			select {
			case <-connection.done:
			case <-time.After(time.Second):
				t.Error("native waiter not joined")
			}
		}
	})
	return f
}

func TestManagedRecoveryKeepsBrowserAndRetiresRunningOldSnapshot(t *testing.T) {
	f := newRecoveryFixture(t)
	if f.s.Info().SocketPath != "" {
		t.Fatal("degraded session exposed endpoint")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()
	next, err := f.s.Recover(ctx, f.previous)
	if err != nil {
		t.Fatal(err)
	}
	if next == nil || next == f.previous || f.s.Info().BrowserPID != 10 || f.s.Info().RunID != f.old.identity.RunID || f.s.Info().SocketPath != f.descriptor.SocketPath || f.s.RecoveryStatus() != (RecoveryStatus{State: "ready", Epoch: 2}) {
		t.Fatal("recovery changed browser or failed to publish new epoch")
	}
	if f.bindCalls != 1 || len(f.s.nativeConnections) != 2 || len(f.s.controllers) != 2 {
		t.Fatal("binding was replayed or owned resources lost")
	}
	if _, err := f.previous.Command(ctx, json.RawMessage(`{"operation":"status"}`)); err == nil {
		t.Fatal("old controller remained usable")
	}
	data, err := os.ReadFile(filepath.Join(f.s.info.RunDir, "lifecycle.json"))
	if err != nil {
		t.Fatal(err)
	}
	var value lifecycle
	if json.Unmarshal(data, &value) != nil || len(value.NativeConnections) != 2 || value.NativeConnections[0].Exit == nil || *value.NativeConnections[0].Exit.Code != 1 || value.NativeConnections[0].ControllerCleanup == nil {
		t.Fatalf("old exit/cleanup evidence lost: %s", data)
	}
	f.old.mu.Lock()
	requests := append([]userTestRequest(nil), f.old.requests...)
	f.old.mu.Unlock()
	for _, request := range requests {
		if request.Operation == "retire" {
			for _, name := range []string{"channelKey", "channelId", "version", "runId", "extensionId", "extensionInstanceId", "workerBootId", "portId"} {
				if request.Arguments[name] == nil {
					t.Fatalf("retire omitted %s", name)
				}
			}
			return
		}
	}
	t.Fatal("no exact original retirement command")
}

func TestManagedRecoveryRejectsChangedWorkerAndRetainsFailedController(t *testing.T) {
	for _, changed := range []string{"boot", "context", "target", "not-paused", "descriptor"} {
		t.Run(changed, func(t *testing.T) {
			f := newRecoveryFixture(t)
			switch changed {
			case "boot":
				f.next.identity.WorkerBootID = "replacement-worker"
			case "context":
				f.next.intercept = func(f *userFixture, r userTestRequest) bool {
					if r.Method != "Runtime.enable" {
						return false
					}
					f.write(map[string]any{"method": "Runtime.executionContextCreated", "sessionId": "worker-session", "params": map[string]any{"context": map[string]any{"id": 7, "uniqueId": "new-context"}}})
					f.reply(r, map[string]any{})
					return true
				}
			case "target":
				f.next.intercept = func(f *userFixture, r userTestRequest) bool {
					if r.Method != "Target.getTargets" {
						return false
					}
					f.reply(r, map[string]any{"targetInfos": []any{map[string]any{"targetId": "replacement-worker-target", "type": "service_worker", "url": "chrome-extension://" + f.identity.ExtensionID + "/background.js"}}})
					return true
				}
			case "not-paused":
				f.next.paused = false
			case "descriptor":
				reads := 0
				original := f.s.recoveryHooks.read
				f.s.recoveryHooks.read = func() (host.ActiveSocketRecord, error) {
					d, e := original()
					reads++
					if reads > 1 {
						d.PID++
					}
					return d, e
				}
			}
			ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
			defer cancel()
			if next, err := f.s.Recover(ctx, f.previous); err == nil || next != nil {
				t.Fatal("changed identity or unpaused state recovered")
			}
			if f.s.Info().SocketPath != "" || f.s.RecoveryStatus().State != "degraded" || len(f.s.nativeConnections) != 2 || f.bindCalls != 1 {
				t.Fatal("failed candidate was lost or published")
			}
			if changed != "boot" && len(f.s.controllers) != 2 {
				t.Fatal("failed Open controller was not retained")
			}
			if _, err := f.s.Recover(ctx, f.previous); err == nil || f.bindCalls != 1 {
				t.Fatal("uncertain candidate binding was retried")
			}
		})
	}
}

func TestManagedRecoveryOriginalCleanupRequiredBeforeNativeBinding(t *testing.T) {
	for _, kind := range []string{"pending", "wrong-identity", "human-lease", "worker-exit", "unknown-native-exit"} {
		t.Run(kind, func(t *testing.T) {
			f := newRecoveryFixture(t)
			held := make(chan userTestRequest, 1)
			f.old.intercept = func(f *userFixture, r userTestRequest) bool {
				if r.Operation != "retire" {
					return false
				}
				if kind == "pending" {
					held <- r
					return true
				}
				state := f.status()
				state["connected"] = false
				if kind == "wrong-identity" {
					state["portId"] = "foreign"
				}
				if kind == "human-lease" {
					state["humanCleanup"] = map[string]any{"leaseId": "older-human", "cleanupConfirmed": true}
				}
				f.evaluated(r, map[string]any{"disconnected": true, "status": state})
				return true
			}
			if kind == "human-lease" {
				f.previous.mu.Lock()
				f.previous.humanRisk = true
				f.previous.humanStatus = &managedprotocol.HumanState{LeaseID: "original-human", State: "active", Generation: 1}
				f.previous.mu.Unlock()
			}
			if kind == "worker-exit" {
				f.previous.markWorkerGone()
			}
			if kind == "unknown-native-exit" {
				f.s.currentNative.record.Exit.Code = nil
			}
			ctx, cancel := context.WithTimeout(context.Background(), 100*time.Millisecond)
			defer cancel()
			if _, err := f.s.Recover(ctx, f.previous); err == nil {
				t.Fatal("unconfirmed original cleanup allowed recovery")
			}
			if f.bindCalls != 0 || len(f.s.nativeConnections) != 1 || f.s.Info().SocketPath != "" {
				t.Fatal("replacement was admitted before original cleanup")
			}
			if kind == "pending" {
				request := userWait(t, held)
				state := f.old.status()
				state["connected"] = false
				f.old.evaluated(request, map[string]any{"disconnected": true, "status": state})
			}
		})
	}
}

func TestManagedRecoveryStopCancelsPendingObservation(t *testing.T) {
	f := newRecoveryFixture(t)
	observed := make(chan struct{}, 1)
	f.s.recoveryHooks.read = func() (host.ActiveSocketRecord, error) {
		select {
		case observed <- struct{}{}:
		default:
		}
		return host.ActiveSocketRecord{}, os.ErrNotExist
	}
	result := make(chan error, 1)
	go func() { _, err := f.s.Recover(context.Background(), f.previous); result <- err }()
	userWait(t, observed)
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()
	if err := f.s.Close(ctx); err != nil {
		t.Fatal(err)
	}
	if err := userWait(t, result); err == nil {
		t.Fatal("Stop did not cancel original recovery")
	}
	if f.s.RecoveryStatus().State != "closed" || f.bindCalls != 0 {
		t.Fatal("recovery published after Stop")
	}
}

func TestManagedNativeLossDegradesWithoutEndingBrowser(t *testing.T) {
	f := newRecoveryFixture(t)
	f.s.recovery.State = "ready"
	go f.s.observeNative(f.s.currentNative)
	userWait(t, f.s.Changes())
	if f.s.RecoveryStatus().State != "degraded" || f.s.Info().SocketPath != "" {
		t.Fatal("native loss did not fence task endpoint")
	}
	select {
	case <-f.s.Done():
		t.Fatal("native loss ended owned Browser")
	default:
	}
	if f.s.record.NativeConnections[0].Exit == nil {
		t.Fatal("original native exit not saved")
	}
}

func TestManagedRecoveryConsumesActualBridgeRetirementFixture(t *testing.T) {
	data, err := os.ReadFile(filepath.Join("..", "managedviewer", "testdata", "native-retire-fixture.json"))
	if err != nil {
		t.Fatal(err)
	}
	var fixture struct {
		Disconnect  json.RawMessage
		SecondBegin struct{ Status json.RawMessage }
		Recovered   json.RawMessage
	}
	if err := json.Unmarshal(data, &fixture); err != nil {
		t.Fatal(err)
	}
	var identity managedUserIdentity
	if err := json.Unmarshal(fixture.SecondBegin.Status, &identity); err != nil {
		t.Fatal(err)
	}
	c := &UserController{identity: identity, cleanupDone: make(chan struct{}), cleanupReceipt: fixture.Disconnect, humanRisk: true, retiredStreams: map[string]bool{}}
	fields, _ := userObject(fixture.SecondBegin.Status)
	c.humanStatus, err = managedprotocol.ParseHumanState(fields["human"])
	if err != nil {
		t.Fatal(err)
	}
	close(c.cleanupDone)
	if _, err := c.recoveryCleanup(); err != nil {
		t.Fatal(err)
	}
	if err := recoveryPaused(fixture.Recovered); err != nil {
		t.Fatal(err)
	}
	c.cleanupReceipt = json.RawMessage(strings.Replace(string(fixture.Disconnect), `"disconnect-human-2"`, `"disconnect-human-1"`, 1))
	if _, err := c.recoveryCleanup(); err == nil {
		t.Fatal("stale first-lease cleanup accepted for second lease")
	}
}

type recoveryBrowser struct {
	entered chan struct{}
	gate    chan struct{}
	once    sync.Once
	exited  func()
}

func (p *recoveryBrowser) PID() int                  { return 10 }
func (p *recoveryBrowser) Wait() error               { return nil }
func (p *recoveryBrowser) ExitCode() (uint32, error) { return 0, nil }
func (p *recoveryBrowser) NativeHost(int, string) (*platformNativeProcess, error) {
	return nil, errors.New("not used by recovery seam")
}
func (p *recoveryBrowser) WaitTree(ctx context.Context) error {
	p.once.Do(func() { close(p.entered) })
	select {
	case <-p.gate:
		p.exited()
		return nil
	case <-ctx.Done():
		return ctx.Err()
	}
}
func (p *recoveryBrowser) Terminate() error {
	return errors.New("test must not replace original Job receipt with force")
}
func (p *recoveryBrowser) Close() error { return nil }

func TestManagedRecoveryStopJoinsHeldRiskOnlyAfterOriginalJobExit(t *testing.T) {
	f := newRecoveryFixture(t)
	f.previous.mu.Lock()
	f.previous.humanRisk = true
	f.previous.mu.Unlock()
	f.previous.markWorkerGone()
	ctx, cancel := context.WithTimeout(context.Background(), 100*time.Millisecond)
	if err := f.previous.Close(ctx); err == nil {
		t.Fatal("worker exit claimed held input cleanup")
	}
	cancel()
	root := &recoveryBrowser{entered: make(chan struct{}), gate: make(chan struct{}), exited: func() { f.s.browserExit = exitReceipt{At: time.Now().UTC(), Code: new(uint32)}; close(f.s.browserDone) }}
	f.s.process = root
	closed := make(chan error, 1)
	go func() { closed <- f.s.Close(context.Background()) }()
	userWait(t, root.entered)
	select {
	case <-f.s.ownerTerminated:
		t.Fatal("Stop request fabricated owned exit")
	case <-f.previous.cleanupDone:
		t.Fatal("held risk was cleared while original Job remained")
	default:
	}
	close(root.gate)
	if err := userWait(t, closed); err != nil {
		t.Fatalf("historical native fault poisoned completed Stop: %v", err)
	}
	select {
	case <-f.previous.cleanupDone:
	default:
		t.Fatal("final Stop did not join controller")
	}
	data, err := os.ReadFile(filepath.Join(f.s.info.RunDir, "lifecycle.json"))
	if err != nil {
		t.Fatal(err)
	}
	var result lifecycle
	if err := json.Unmarshal(data, &result); err != nil {
		t.Fatal(err)
	}
	var proof struct{ CleanupProof string }
	if result.NativeConnections[0].ControllerCleanup != nil {
		_ = json.Unmarshal(result.NativeConnections[0].ControllerCleanup.Result, &proof)
	}
	if result.JobEmpty == nil || result.State != "closed" || result.NativeConnections[0].ControllerCleanup == nil || proof.CleanupProof != "session-terminated" {
		t.Fatalf("original termination proof lost: %s", data)
	}
	if result.NativeConnections[0].Exit == nil || *result.NativeConnections[0].Exit.Code != 1 || !result.NativeConnections[0].ExitConfirmed {
		t.Fatal("historical native fault was erased")
	}
}

func TestManagedRecoveryStopJoinsUncommittedOpen(t *testing.T) {
	f := newRecoveryFixture(t)
	held := make(chan userTestRequest, 1)
	f.next.intercept = func(f *userFixture, r userTestRequest) bool {
		if r.Operation == "open" {
			held <- r
			return true
		}
		return false
	}
	recovered := make(chan error, 1)
	go func() { _, err := f.s.Recover(context.Background(), f.previous); recovered <- err }()
	userWait(t, held)
	if len(f.s.controllers) != 2 {
		t.Fatal("pending open was not retained")
	}
	root := &recoveryBrowser{entered: make(chan struct{}), gate: make(chan struct{}), exited: func() {
		f.handle.exit()
		f.s.browserExit = exitReceipt{At: time.Now().UTC(), Code: new(uint32)}
		close(f.s.browserDone)
	}}
	f.s.process = root
	closed := make(chan error, 1)
	go func() { closed <- f.s.Close(context.Background()) }()
	if err := userWait(t, recovered); err == nil {
		t.Fatal("Stop published unacknowledged Open")
	}
	userWait(t, root.entered)
	select {
	case <-f.s.controllers[1].cleanupDone:
		t.Fatal("uncommitted open cleanup invented before owned exit")
	default:
	}
	close(root.gate)
	userWait(t, closed)
	select {
	case <-f.s.controllers[1].cleanupDone:
	default:
		t.Fatal("failed open was not joined by Stop")
	}
	if f.s.RecoveryStatus().State != "closed" || f.s.Info().SocketPath != "" {
		t.Fatal("late open restored readiness")
	}
}

func TestManagedRecoveryCapacityAndHistoricalEndpointOwnership(t *testing.T) {
	t.Run("capacity", func(t *testing.T) {
		f := newRecoveryFixture(t)
		for len(f.s.nativeConnections) < nativeConnectionLimit {
			f.s.nativeConnections = append(f.s.nativeConnections, f.s.currentNative)
		}
		if _, err := f.s.Recover(context.Background(), f.previous); err == nil || f.bindCalls != 0 {
			t.Fatal("capacity limit did not fail closed")
		}
	})
	t.Run("historical records", func(t *testing.T) {
		dir := t.TempDir()
		first := host.ActiveSocketRecord{PID: 21, SocketPath: `\\.\pipe\first`, StartedAt: time.Now().UTC()}
		second := host.ActiveSocketRecord{PID: 22, SocketPath: `\\.\pipe\second`, StartedAt: time.Now().UTC()}
		s := &Session{endpointDir: dir, nativeConnections: []*nativeConnection{{record: nativeConnectionRecord{Descriptor: first}}, {record: nativeConnectionRecord{Descriptor: second}}}}
		for i, record := range []host.ActiveSocketRecord{first, second} {
			name := []string{"old.endpoint.json", "active.json"}[i]
			if err := writeJSONFile(filepath.Join(dir, name), record); err != nil {
				t.Fatal(err)
			}
		}
		if err := s.cleanEndpointRecords(); err != nil {
			t.Fatal(err)
		}
		foreign := first
		foreign.PID++
		if err := writeJSONFile(filepath.Join(dir, "active.json"), foreign); err != nil {
			t.Fatal(err)
		}
		if err := s.cleanEndpointRecords(); err == nil {
			t.Fatal("unknown record was adopted")
		}
		if _, err := os.Stat(filepath.Join(dir, "active.json")); err != nil {
			t.Fatal("unknown record removed")
		}
	})
}

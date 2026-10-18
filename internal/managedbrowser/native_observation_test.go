package managedbrowser

import (
	"context"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"sync/atomic"
	"testing"
	"time"
)

func awaitNativeObservation(t *testing.T, f *recoveryFixture, observed <-chan struct{}) {
	t.Helper()
	userWait(t, observed)
	// The notification is from hold while nativeMu is held. Acquiring it now
	// joins the original registration, not an assumed timer/poll completion.
	f.s.nativeMu.Lock()
	f.s.nativeMu.Unlock()
}

func TestManagedNativeObserverAndRecoverRetainOneOriginalHandle(t *testing.T) {
	f := newRecoveryFixture(t)
	entered, release := make(chan struct{}), make(chan struct{})
	var holds atomic.Int32
	f.s.recoveryHooks.hold = func(int) (managedNativeHandle, error) {
		if holds.Add(1) == 1 {
			close(entered)
		}
		<-release
		return f.handle, nil
	}
	f.s.startNativeObservation()
	userWait(t, entered)
	recovered := make(chan error, 1)
	go func() { _, err := f.s.Recover(context.Background(), f.previous); recovered <- err }()
	userWait(t, f.previous.cleanupDone)
	close(release)
	if err := userWait(t, recovered); err != nil {
		t.Fatal(err)
	}
	if holds.Load() != 1 || len(f.s.nativeConnections) != 2 || f.s.currentNative.handle != f.handle || f.bindCalls != 1 {
		t.Fatal("passive observation and explicit recovery duplicated the original handle or binding")
	}
}

func TestManagedNativeObserverOwnsReplacementWithoutAuthorizingHeldInput(t *testing.T) {
	f := newRecoveryFixture(t)
	f.previous.mu.Lock()
	f.previous.humanRisk = true
	f.previous.mu.Unlock()
	f.previous.markWorkerGone()
	observed := make(chan struct{}, 1)
	f.s.recoveryHooks.hold = func(int) (managedNativeHandle, error) {
		observed <- struct{}{}
		return f.handle, nil
	}
	f.s.startNativeObservation()
	awaitNativeObservation(t, f, observed)
	ctx, cancel := context.WithTimeout(context.Background(), 100*time.Millisecond)
	if _, err := f.s.Recover(ctx, f.previous); err == nil {
		t.Fatal("held-input risk admitted recovery")
	}
	cancel()
	if f.bindCalls != 0 || len(f.s.controllers) != 1 || f.s.Info().SocketPath != "" || len(f.s.nativeConnections) != 2 || f.s.nativeConnections[1].controller != nil || len(f.s.nativeConnections[1].record.Binding) != 0 {
		t.Fatal("cleanup ownership granted a task, binding, or user channel")
	}
	f.s.endpointDir = t.TempDir()
	for _, name := range []string{"active.json", "replacement.endpoint.json"} {
		if err := writeJSONFile(filepath.Join(f.s.endpointDir, name), f.descriptor); err != nil {
			t.Fatal(err)
		}
	}
	root := &recoveryBrowser{entered: make(chan struct{}), gate: make(chan struct{}), exited: func() {
		f.handle.exit()
		f.s.browserExit = exitReceipt{At: time.Now().UTC(), Code: new(uint32)}
		close(f.s.browserDone)
	}}
	f.s.process = root
	closed := make(chan error, 1)
	go func() { closed <- f.s.Close(context.Background()) }()
	userWait(t, root.entered)
	select {
	case <-f.s.nativeObservationDone:
		t.Fatal("observer stopped while the original Job was still live")
	case <-f.previous.cleanupDone:
		t.Fatal("held-input cleanup invented before original Job exit")
	default:
	}
	close(root.gate)
	if err := userWait(t, closed); err != nil {
		t.Fatalf("owned unbound replacement prevented normal Stop: %v", err)
	}
	userWait(t, f.s.nativeObservationDone)
	entries, err := os.ReadDir(f.s.endpointDir)
	if err != nil || len(entries) != 0 {
		t.Fatalf("exact held endpoint records were not cleaned: %v", err)
	}
	data, err := os.ReadFile(filepath.Join(f.s.info.RunDir, "lifecycle.json"))
	if err != nil {
		t.Fatal(err)
	}
	var saved lifecycle
	if json.Unmarshal(data, &saved) != nil || len(saved.NativeConnections) != 2 || !saved.NativeConnections[1].ExitConfirmed || saved.NativeConnections[1].CreationTime != 200 || saved.NativeConnections[1].Exit == nil || *saved.NativeConnections[1].Exit.Code != 0 || saved.JobEmpty == nil || saved.Forced {
		t.Fatal("normal Stop lost the unbound replacement's actual handle/exit provenance")
	}
	if saved.NativeConnections[0].Exit == nil || *saved.NativeConnections[0].Exit.Code != 1 || saved.NativeConnections[1].ControllerCleanup != nil || len(saved.NativeConnections[1].Binding) != 0 {
		t.Fatal("cleanup rewrote historical fault or invented unbound controller authority")
	}
}

func TestManagedNativeStopJoinsAnObservationAlreadyHoldingTheProcess(t *testing.T) {
	f := newRecoveryFixture(t)
	entered, release := make(chan struct{}), make(chan struct{})
	f.s.recoveryHooks.hold = func(int) (managedNativeHandle, error) {
		close(entered)
		<-release
		return f.handle, nil
	}
	f.s.startNativeObservation()
	userWait(t, entered)
	root := &recoveryBrowser{entered: make(chan struct{}), gate: make(chan struct{}), exited: func() {
		f.handle.exit()
		f.s.browserExit = exitReceipt{At: time.Now().UTC(), Code: new(uint32)}
		close(f.s.browserDone)
	}}
	f.s.process = root
	f.s.beginClose()
	select {
	case <-root.entered:
		t.Fatal("Stop overtook an unsettled original handle observation")
	case <-f.s.Done():
		t.Fatal("Stop completed with an unsettled original handle observation")
	default:
	}
	close(release)
	userWait(t, root.entered)
	close(root.gate)
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()
	if err := f.s.Close(ctx); err != nil {
		t.Fatal(err)
	}
	userWait(t, f.s.nativeObservationDone)
	if len(f.s.nativeConnections) != 2 || !f.s.nativeConnections[1].record.ExitConfirmed || f.bindCalls != 0 || len(f.s.controllers) != 1 {
		t.Fatal("Stop lost a concurrently observed Native or granted authority")
	}
}

type closedObservationNative struct {
	*recoveryNative
	closed atomic.Int32
}

func (p *closedObservationNative) Close() error { p.closed.Add(1); return nil }

func TestManagedNativeObservationRejectsUnknownAndChangedIdentities(t *testing.T) {
	for _, kind := range []string{"invalid-path", "invalid-time", "foreign-job", "wrong-executable", "already-exited", "older-creation", "equal-creation", "changed-descriptor", "terminated"} {
		t.Run(kind, func(t *testing.T) {
			f := newRecoveryFixture(t)
			candidate := f.descriptor
			var holds int
			handle := &closedObservationNative{recoveryNative: f.handle}
			f.s.recoveryHooks.hold = func(int) (managedNativeHandle, error) {
				holds++
				if kind == "foreign-job" || kind == "wrong-executable" || kind == "already-exited" {
					return nil, errors.New(kind)
				}
				return handle, nil
			}
			switch kind {
			case "invalid-path":
				candidate.SocketPath = "unknown.sock"
			case "invalid-time":
				candidate.StartedAt = time.Time{}
			case "older-creation":
				handle.created = 99
			case "equal-creation":
				handle.created = 100
			case "changed-descriptor":
				candidate = f.s.currentNative.record.Descriptor
				candidate.StartedAt = candidate.StartedAt.Add(time.Second)
			case "terminated":
				f.s.ownerOnce.Do(func() { close(f.s.ownerTerminated) })
			}
			if retained, err := f.s.retainNativeCandidate(candidate, *f.s.recoveryHooks); err == nil || retained != nil {
				t.Fatal("unknown Native identity was retained")
			}
			if len(f.s.nativeConnections) != 1 || f.bindCalls != 0 {
				t.Fatal("rejected candidate became owned or authorized")
			}
			if (kind == "older-creation" || kind == "equal-creation") && (holds != 1 || handle.closed.Load() != 1) {
				t.Fatal("rejected held identity leaked its handle")
			}
			f.s.endpointDir = t.TempDir()
			path := filepath.Join(f.s.endpointDir, "active.json")
			if err := writeJSONFile(path, candidate); err != nil {
				t.Fatal(err)
			}
			before, _ := os.ReadFile(path)
			if err := f.s.cleanEndpointRecords(); err == nil {
				t.Fatal("unknown descriptor was deleted without original held identity")
			}
			after, err := os.ReadFile(path)
			if err != nil || string(before) != string(after) {
				t.Fatal("rejected descriptor was changed")
			}
		})
	}
}

func TestManagedNativeStopReportsNewFaultInUnboundObservedHost(t *testing.T) {
	f := newRecoveryFixture(t)
	if err := f.s.observeNativeCandidate(); err != nil {
		t.Fatal(err)
	}
	root := &recoveryBrowser{entered: make(chan struct{}), gate: make(chan struct{}), exited: func() {
		f.handle.code = 9
		f.handle.waitErr = &platformExitError{Code: 9}
		f.handle.exit()
		f.s.browserExit = exitReceipt{At: time.Now().UTC(), Code: new(uint32)}
		close(f.s.browserDone)
	}}
	close(root.gate)
	f.s.process = root
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()
	if err := f.s.Close(ctx); err == nil || !strings.Contains(err.Error(), "native connection 2 exited during Stop with code 9") {
		t.Fatalf("new shutdown fault was hidden: %v", err)
	}
}

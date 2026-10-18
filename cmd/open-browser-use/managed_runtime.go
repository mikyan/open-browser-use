package main

import (
	"context"
	"errors"
	"sync"
	"time"

	"github.com/ifuryst/open-browser-use/internal/managedbrowser"
	"github.com/ifuryst/open-browser-use/internal/managedviewer"
)

// managedRuntime publishes one complete controller/viewer generation. The
// Session owns browser/native processes; this module owns HTTP generations.
// A prepared replacement is never exposed while old HTTP cleanup is pending.
type managedRuntime struct {
	session       *managedbrowser.Session
	supervisor    *managedSupervisor
	mu            sync.Mutex
	controller    *managedbrowser.UserController
	viewer        *managedviewer.Server
	viewers       []*managedviewer.Server
	recovering    bool
	recoverDone   chan struct{}
	recoverCancel context.CancelFunc
	stopped       bool
	unpublished   bool
}

func newManagedRuntime(session *managedbrowser.Session, controller *managedbrowser.UserController, supervisor *managedSupervisor) (*managedRuntime, error) {
	viewer, err := managedviewer.Start(managedviewer.Config{RunID: session.Info().RunID, Backend: controller, Stop: supervisor.requestStop})
	if err != nil {
		return nil, err
	}
	r := &managedRuntime{session: session, supervisor: supervisor, controller: controller, viewer: viewer, viewers: []*managedviewer.Server{viewer}}
	supervisor.statusSnapshot = r.status
	supervisor.issueViewerURL = r.issueURL
	supervisor.waitViewerReady = r.waitViewerReady
	supervisor.recoverViewer = r.recover
	return r, nil
}

func (r *managedRuntime) status() managedMessage {
	r.mu.Lock()
	defer r.mu.Unlock()
	return r.statusLocked()
}

func (r *managedRuntime) statusLocked() managedMessage {
	status, info := r.session.RecoveryStatus(), r.session.Info()
	state := status.State
	if r.stopped {
		state = "stopping"
	} else if r.recovering {
		state = "recovering"
	} else if r.unpublished {
		state = "degraded"
	}
	if state == "ready" {
		select {
		case <-r.controller.Done():
			state = "degraded"
		default:
		}
	}
	response := managedMessage{State: state, RunID: info.RunID, Info: &info, NativeEpoch: status.Epoch}
	if state != "ready" {
		info.SocketPath = ""
		response.NextStep = "The task connection is unavailable. Use managed recover to verify and reconnect the original session, or managed stop. Unknown input or unconfirmed cleanup prevents recovery. Recovery does not replay actions or resume the Agent."
	}
	return response
}

func (r *managedRuntime) readyViewer() (*managedviewer.Server, error) {
	r.mu.Lock()
	defer r.mu.Unlock()
	if r.statusLocked().State != "ready" {
		return nil, errors.New("managed connection is unavailable; explicitly recover it before requesting a viewer")
	}
	return r.viewer, nil
}

func (r *managedRuntime) waitViewerReady(ctx context.Context) error {
	viewer, err := r.readyViewer()
	if err != nil {
		return err
	}
	return viewer.WaitReady(ctx)
}

func (r *managedRuntime) issueURL() (string, error) {
	r.mu.Lock()
	defer r.mu.Unlock()
	if r.statusLocked().State != "ready" {
		return "", errors.New("managed connection is no longer ready")
	}
	return r.viewer.IssueURL()
}

func (r *managedRuntime) recover(parent context.Context) (managedMessage, error) {
	r.mu.Lock()
	if r.stopped || r.recovering || r.unpublished {
		r.mu.Unlock()
		return managedMessage{}, errors.New("managed recovery is already pending, unavailable, or stopping")
	}
	if r.session.RecoveryStatus().State != "degraded" {
		r.mu.Unlock()
		return managedMessage{}, errors.New("managed recovery requires an unavailable original connection")
	}
	ctx, cancel := context.WithCancel(parent)
	r.recovering, r.recoverCancel = true, cancel
	r.recoverDone = make(chan struct{})
	done, previous, previousViewer := r.recoverDone, r.controller, r.viewer
	r.mu.Unlock()
	defer func() {
		cancel()
		r.mu.Lock()
		r.recovering, r.recoverCancel = false, nil
		close(done)
		r.mu.Unlock()
	}()
	// Retire the original controller and HTTP transport before preparing another.
	// A verified worker execution end can retire that transport without proving
	// its page attachment was released. Session.Recover separately waits for the
	// original journal's native stop/detach receipts before a new viewer is exposed.
	if err := previous.Close(ctx); err != nil {
		return managedMessage{}, err
	}
	if err := previousViewer.Close(ctx); err != nil {
		return managedMessage{}, err
	}
	controller, err := r.session.Recover(ctx, previous)
	if err != nil {
		return managedMessage{}, err
	}
	r.mu.Lock()
	r.controller, r.unpublished = controller, true
	r.mu.Unlock()
	viewer, err := managedviewer.Start(managedviewer.Config{RunID: r.session.Info().RunID, Backend: controller, Stop: r.supervisor.requestStop})
	if err != nil {
		return managedMessage{}, err // Session retains the prepared controller.
	}
	r.mu.Lock()
	defer r.mu.Unlock()
	r.viewers = append(r.viewers, viewer) // Retain even an unpublished generation.
	if ctx.Err() != nil || r.stopped || r.session.RecoveryStatus().State != "ready" {
		return managedMessage{}, errors.New("managed recovery ended before viewer publication; stop the session")
	}
	select {
	case <-controller.Done():
		return managedMessage{}, errors.New("replacement controller ended before viewer publication")
	default:
	}
	r.viewer, r.unpublished = viewer, false
	info := r.session.Info()
	return managedMessage{State: "recovered", RunID: info.RunID, Info: &info, NativeEpoch: r.session.RecoveryStatus().Epoch,
		ViewerURL: viewer.URL(), NextStep: "Open the new viewer. The original pages remain available and the Agent remains paused."}, nil
}

func (r *managedRuntime) close() error {
	r.mu.Lock()
	r.stopped = true
	if r.recoverCancel != nil {
		r.recoverCancel()
	}
	controller, recovering := r.controller, r.recoverDone
	r.mu.Unlock()
	err := closeManagedRuntime(r.session, controller)
	if recovering != nil {
		select {
		case <-recovering:
		case <-time.After(5 * time.Second):
			err = errors.Join(err, errors.New("original managed recovery has not settled"))
		}
	}
	return err
}

func (r *managedRuntime) closeViewers() error {
	r.mu.Lock()
	viewers := append([]*managedviewer.Server(nil), r.viewers...)
	r.mu.Unlock()
	var failures []error
	for _, viewer := range viewers {
		replyCtx, replyCancel := context.WithTimeout(context.Background(), 3*time.Second)
		failures = append(failures, viewer.WaitStopReply(replyCtx))
		replyCancel()
		viewerCtx, viewerCancel := context.WithTimeout(context.Background(), 5*time.Second)
		failures = append(failures, viewer.Close(viewerCtx))
		viewerCancel()
	}
	return errors.Join(failures...)
}

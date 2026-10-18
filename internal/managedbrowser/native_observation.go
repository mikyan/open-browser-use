package managedbrowser

import (
	"context"
	"errors"
	"time"

	"github.com/ifuryst/open-browser-use/internal/host"
	"github.com/ifuryst/open-browser-use/internal/transport"
)

// Observation gives only cleanup ownership. It never binds a Browser, opens a
// worker channel, removes input risk, or authorizes a task endpoint.
func (s *Session) startNativeObservation() {
	s.mu.Lock()
	if s.nativeObservationDone != nil {
		s.mu.Unlock()
		return
	}
	ctx, cancel := context.WithCancel(context.Background())
	s.nativeObservationCancel, s.nativeObservationDone = cancel, make(chan struct{})
	done, first := s.nativeObservationDone, s.currentNative
	s.mu.Unlock()
	go func() {
		defer close(done)
		select {
		case <-first.done:
		case <-ctx.Done():
			return
		}
		ticker := time.NewTicker(25 * time.Millisecond)
		defer ticker.Stop()
		for {
			select {
			case <-ctx.Done():
				return
			default:
			}
			// Publication may be incomplete or a process may already be gone.
			// Such a record stays unowned: final cleanup must reject it, not
			// convert this polling attempt into proof of a historical process.
			_ = s.observeNativeCandidate()
			select {
			case <-ctx.Done():
				return
			case <-ticker.C:
			}
		}
	}()
}

func (s *Session) observeNativeCandidate() error {
	ops := s.recoveryOperations()
	descriptor, err := ops.read()
	if err != nil {
		return err
	}
	_, err = s.retainNativeCandidate(descriptor, ops)
	return err
}

// Recover and the passive observer share one original handle for an exact
// descriptor. A refused or already-exited unknown process is never adopted.
func (s *Session) retainNativeCandidate(descriptor host.ActiveSocketRecord, ops nativeRecoveryHooks) (*nativeConnection, error) {
	if !transport.IsNamedPipe(descriptor.SocketPath) || descriptor.PID <= 0 || descriptor.StartedAt.IsZero() {
		return nil, errors.New("invalid observed native endpoint descriptor")
	}
	s.nativeMu.Lock()
	defer s.nativeMu.Unlock()
	s.mu.Lock()
	for _, connection := range s.nativeConnections {
		if connection.record.Descriptor == descriptor {
			s.mu.Unlock()
			return connection, nil
		}
		if connection.record.Descriptor.SocketPath == descriptor.SocketPath {
			s.mu.Unlock()
			return nil, errors.New("observed native endpoint changed its original identity")
		}
	}
	if len(s.nativeConnections) == 0 || len(s.nativeConnections) >= nativeConnectionLimit {
		s.mu.Unlock()
		return nil, errors.New("native observation capacity is unavailable; Stop this run")
	}
	firstCreation := s.nativeConnections[0].record.CreationTime
	s.mu.Unlock()
	select {
	case <-s.ownerTerminated:
		return nil, errors.New("original owned Browser already exited")
	default:
	}
	// Production NativeHost holds the actual process handle after checking the
	// exact executable, original Job membership and creation time.
	handle, err := ops.hold(descriptor.PID)
	if err != nil {
		return nil, err
	}
	if handle.CreationTime() <= firstCreation {
		return nil, errors.Join(errors.New("observed native process predates original native identity"), handle.Close())
	}
	connection := &nativeConnection{handle: handle, done: make(chan struct{})}
	s.mu.Lock()
	connection.record = nativeConnectionRecord{Epoch: uint64(len(s.nativeConnections) + 1), Descriptor: descriptor, CreationTime: handle.CreationTime()}
	s.nativeConnections = append(s.nativeConnections, connection)
	s.mu.Unlock()
	go s.waitNative(connection)
	return connection, nil
}

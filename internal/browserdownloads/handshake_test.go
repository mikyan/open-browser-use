package browserdownloads

import (
	"context"
	"errors"
	"net/http"
	"reflect"
	"sync/atomic"
	"testing"
	"time"
)

func TestApprovalHandshakeUsesOriginalCallerBudgetBeyondTenSeconds(t *testing.T) {
	t.Parallel()
	var attempts atomic.Int32
	p := newPeerWithHandshake(t, "approval-context", nil, func(_ http.ResponseWriter, r *http.Request) bool {
		attempts.Add(1)
		// Real HTTP Upgrade delay, intentionally longer than the unchanged
		// production ten-second CDP command limit. No fake clock or constant.
		timer := time.NewTimer(11 * time.Second)
		defer timer.Stop()
		select {
		case <-timer.C:
			return true
		case <-r.Context().Done():
			return false
		}
	})
	ctx, cancel := context.WithTimeout(context.Background(), 25*time.Second)
	defer cancel()
	started := time.Now()
	m, err := Dial(ctx, p.url(), testIdentity)
	elapsed := time.Since(started)
	if err != nil {
		t.Fatalf("single approval handshake after %v: %v", elapsed, err)
	}
	defer m.Close()
	if elapsed < 11*time.Second || attempts.Load() != 1 {
		t.Fatalf("handshake was not the original delayed connection: elapsed=%v attempts=%d", elapsed, attempts.Load())
	}
	var methods []string
	for _, request := range p.snapshot() {
		methods = append(methods, request.Method)
	}
	want := []string{"Target.getTargets", "Target.attachToTarget", "Runtime.evaluate", "Target.detachFromTarget", "Browser.setDownloadBehavior"}
	if !reflect.DeepEqual(methods, want) {
		t.Fatalf("identity must precede configuration: %v", methods)
	}
	cancel() // Successful setup does not give the caller ownership of the reader.
	if err := m.transport.call(context.Background(), "Target.getTargets", "", map[string]any{}, nil); err != nil {
		t.Fatal(err)
	}
	t.Logf("actual single HTTP/WebSocket handshake and identity setup elapsed %v", elapsed)
}

func TestApprovalSetupBudgetPolicy(t *testing.T) {
	for _, tc := range []struct {
		name   string
		budget time.Duration
		limit  time.Duration
	}{
		{"no-deadline", 0, 10 * time.Second},
		{"shorter-caller", time.Second, time.Second},
		{"approval-caller", 60 * time.Second, 60 * time.Second},
		{"maximum", 180 * time.Second, 120 * time.Second},
	} {
		t.Run(tc.name, func(t *testing.T) {
			caller, callerCancel := context.WithCancel(context.Background())
			defer callerCancel()
			if tc.budget > 0 {
				var cancel context.CancelFunc
				caller, cancel = context.WithTimeout(caller, tc.budget)
				defer cancel()
			}
			before := time.Now()
			setup, cancel := setupContext(caller)
			defer cancel()
			deadline, present := setup.Deadline()
			if !present {
				t.Fatal("unbounded setup")
			}
			if tc.budget > 0 && tc.budget <= 120*time.Second {
				original, _ := caller.Deadline()
				if !deadline.Equal(original) {
					t.Fatal("caller deadline was replaced", deadline, original)
				}
			} else if deadline.Before(before.Add(tc.limit)) || deadline.After(time.Now().Add(tc.limit)) {
				t.Fatal("wrong finite default/cap", deadline, tc.limit)
			}
			cancel()
			if caller.Err() != nil {
				t.Fatal("setup cancellation escaped to its caller")
			}
		})
	}
}

func TestApprovalRejectionAndCancellationNeverSendNativeCommands(t *testing.T) {
	for _, mode := range []string{"403", "deadline", "cancel", "already-canceled", "expired-before-notification"} {
		t.Run(mode, func(t *testing.T) {
			var attempts atomic.Int32
			entered := make(chan struct{})
			left := make(chan struct{})
			p := newPeerWithHandshake(t, "", nil, func(w http.ResponseWriter, r *http.Request) bool {
				attempts.Add(1)
				close(entered)
				defer close(left)
				if mode == "403" {
					http.Error(w, "original user denied approval", http.StatusForbidden)
					return false
				}
				<-r.Context().Done()
				return false
			})
			ctx, cancel := context.WithTimeout(context.Background(), 150*time.Millisecond)
			defer cancel()
			var expected error
			switch mode {
			case "cancel":
				expected = context.Canceled
				go func() { <-entered; cancel() }()
			case "already-canceled":
				expected = context.Canceled
				cancel()
			case "expired-before-notification":
				expected = context.DeadlineExceeded
				ctx = deadlineOnlyContext{context.Background(), time.Now().Add(-time.Second)}
			case "deadline":
				expected = context.DeadlineExceeded
			}
			m, err := Dial(ctx, p.url(), testIdentity)
			if m != nil || err == nil {
				t.Fatal("unsuccessful approval became usable", m, err)
			}
			if expected != nil && !errors.Is(err, expected) {
				t.Fatalf("original error lost: %v", err)
			}
			if mode == "403" {
				wantError(t, err, "403")
			}
			if mode == "already-canceled" || mode == "expired-before-notification" {
				if attempts.Load() != 0 {
					t.Fatal("expired setup attempted HTTP")
				}
			} else {
				done(t, left)
				if attempts.Load() != 1 {
					t.Fatal("approval was retried", attempts.Load())
				}
			}
			if len(p.snapshot()) != 0 {
				t.Fatal("failed approval sent native commands")
			}
		})
	}
}

func TestLateApprovalHandshakeClosesBeforePublishingTransport(t *testing.T) {
	deadline := time.Now().Add(40 * time.Millisecond)
	var attempts atomic.Int32
	p := newPeerWithHandshake(t, "", nil, func(_ http.ResponseWriter, _ *http.Request) bool {
		attempts.Add(1)
		afterDeadline(deadline.Add(20 * time.Millisecond))
		return true
	})
	// The deadline is observable while its cancellation notification is delayed.
	// This forces a real successful HTTP Upgrade to return after the deadline.
	ctx := deadlineOnlyContext{context.Background(), deadline}
	transport, err := dialTransport(ctx, p.url(), nil, nil)
	if transport != nil {
		transport.close()
		t.Fatal("late socket was published")
	}
	if !errors.Is(err, context.DeadlineExceeded) {
		t.Fatal(err)
	}
	done(t, p.connected)
	done(t, p.done)
	if attempts.Load() != 1 || len(p.snapshot()) != 0 {
		t.Fatal("late connection retried or sent native commands")
	}
}

func TestApprovalDoesNotRestartOriginalSetupDeadline(t *testing.T) {
	p := newPeerWithHandshake(t, "", func(_ *browserPeer, request nativeRequest) bool {
		return request.Method == "Target.getTargets" // Withhold the actual ACK.
	}, func(_ http.ResponseWriter, r *http.Request) bool {
		timer := time.NewTimer(150 * time.Millisecond)
		defer timer.Stop()
		select {
		case <-timer.C:
			return true
		case <-r.Context().Done():
			return false
		}
	})
	ctx, cancel := context.WithTimeout(context.Background(), 400*time.Millisecond)
	defer cancel()
	started := time.Now()
	m, err := Dial(ctx, p.url(), testIdentity)
	elapsed := time.Since(started)
	if m != nil || !errors.Is(err, context.DeadlineExceeded) {
		t.Fatal(m, err)
	}
	if elapsed < 350*time.Millisecond || elapsed >= 525*time.Millisecond {
		t.Fatalf("setup budget restarted: %v", elapsed)
	}
	done(t, p.done)
	requests := p.snapshot()
	if len(requests) != 1 || requests[0].Method != "Target.getTargets" {
		t.Fatal("expired identity sent further commands", requests)
	}
}

func TestApprovalDoesNotExtendIndividualCDPCommandLimit(t *testing.T) {
	t.Parallel()
	var hold atomic.Bool
	p := newPeer(t, "", func(_ *browserPeer, request nativeRequest) bool {
		return hold.Load() && request.Method == "Target.getTargets"
	})
	m := newManager(t, p)
	hold.Store(true)
	ctx, cancel := context.WithTimeout(context.Background(), 25*time.Second)
	defer cancel()
	before, started := len(p.snapshot()), time.Now()
	err := m.call(ctx, "Target.getTargets", "", map[string]any{}, nil)
	elapsed := time.Since(started)
	if !errors.Is(err, context.DeadlineExceeded) || elapsed < 10*time.Second || elapsed >= 15*time.Second {
		t.Fatalf("native command lost ten-second cap: %v, %v", elapsed, err)
	}
	done(t, m.Done())
	done(t, p.done)
	wantError(t, m.call(context.Background(), "Target.getTargets", "", map[string]any{}, nil), "DISCONNECTED")
	if len(p.snapshot()) != before+1 {
		t.Fatal("uncertain command was replayed")
	}
	t.Logf("actual original CDP ACK timeout elapsed %v; connection terminal", elapsed)
}

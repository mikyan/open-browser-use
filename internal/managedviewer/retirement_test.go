package managedviewer

import (
	"context"
	"encoding/json"
	"errors"
	"sync"
	"testing"
	"time"
)

type retiringTestBackend struct {
	*testBackend
	retire func(context.Context) error
}

func (b *retiringTestBackend) Close(ctx context.Context) error { return b.retire(ctx) }

func TestViewerRetirementWaitsForWholeOriginalChannelAfterNativeLoss(t *testing.T) {
	for _, confirmed := range []bool{true, false} {
		t.Run(map[bool]string{true: "confirmed", false: "unknown"}[confirmed], func(t *testing.T) {
			b := &retiringTestBackend{testBackend: newBackend()}
			entered, release := make(chan struct{}), make(chan struct{})
			var once sync.Once
			b.retire = func(ctx context.Context) error {
				once.Do(func() { close(entered) })
				select {
				case <-release:
					if !confirmed {
						return errors.New("original held-input release unconfirmed")
					}
					return nil
				case <-ctx.Done():
					return ctx.Err()
				}
			}
			b.command = func(context.Context, json.RawMessage) (json.RawMessage, error) {
				select {
				case <-b.done:
					return nil, errors.New("old native proof revoked")
				default:
					return goodState, nil
				}
			}
			s, err := Start(Config{RunID: "original", Backend: b, Stop: func(context.Context) error { return nil }})
			if err != nil {
				t.Fatal(err)
			}
			ws := dialViewer(t, s, s.URL())
			readMessage(t, ws)
			close(b.done)
			_ = ws.CloseNow()
			select {
			case <-entered:
			case <-time.After(time.Second):
				t.Fatal("whole-channel retirement was not joined")
			}
			short, cancel := context.WithTimeout(context.Background(), 20*time.Millisecond)
			if err := s.Close(short); !errors.Is(err, context.DeadlineExceeded) {
				t.Fatalf("pending original release was concealed: %v", err)
			}
			cancel()
			close(release)
			ctx, finish := context.WithTimeout(context.Background(), time.Second)
			err = s.Close(ctx)
			finish()
			if confirmed && err != nil {
				t.Fatalf("confirmed retirement rejected: %v", err)
			}
			if !confirmed && err == nil {
				t.Fatal("unknown original release accepted")
			}
		})
	}
}

func TestViewerDoesNotRetireLiveBackendToConcealUnconfirmedUnsubscribe(t *testing.T) {
	b := &retiringTestBackend{testBackend: newBackend()}
	b.retire = func(context.Context) error { t.Error("ordinary viewer failure retired a live backend"); return nil }
	b.command = func(context.Context, json.RawMessage) (json.RawMessage, error) {
		return nil, errors.New("original unsubscribe unconfirmed")
	}
	s, err := Start(Config{RunID: "original", Backend: b, Stop: func(context.Context) error { return nil }})
	if err != nil {
		t.Fatal(err)
	}
	ws := dialViewer(t, s, s.URL())
	readMessage(t, ws)
	_ = ws.CloseNow()
	ctx, cancel := context.WithTimeout(context.Background(), time.Second)
	defer cancel()
	if err := s.Close(ctx); err == nil {
		t.Fatal("unknown unsubscribe was accepted")
	}
}

func TestViewerCloseSettlesEarlierUnsubscribeFailureOnlyWithOriginalRetirement(t *testing.T) {
	for _, confirmed := range []bool{true, false} {
		t.Run(map[bool]string{true: "confirmed", false: "unknown"}[confirmed], func(t *testing.T) {
			b := &retiringTestBackend{testBackend: newBackend()}
			entered, release := make(chan struct{}), make(chan struct{})
			b.retire = func(ctx context.Context) error {
				close(entered)
				select {
				case <-release:
					if !confirmed {
						return errors.New("original retirement unknown")
					}
					return nil
				case <-ctx.Done():
					return ctx.Err()
				}
			}
			b.command = func(context.Context, json.RawMessage) (json.RawMessage, error) {
				return nil, errors.New("unsubscribe failed before native exit notification")
			}
			s, err := Start(Config{RunID: "original", Backend: b, Stop: func(context.Context) error { return nil }})
			if err != nil {
				t.Fatal(err)
			}
			ws := dialViewer(t, s, s.URL())
			readMessage(t, ws)
			_ = ws.CloseNow()
			waitNoActive(t, s)
			if _, err := s.IssueURL(); err == nil {
				t.Fatal("unknown unsubscribe allowed another viewer")
			}
			close(b.done)
			short, cancel := context.WithTimeout(context.Background(), 20*time.Millisecond)
			err = s.Close(short)
			cancel()
			if !errors.Is(err, context.DeadlineExceeded) {
				t.Fatalf("Close did not wait for the later original retirement: %v", err)
			}
			select {
			case <-entered:
			default:
				t.Fatal("original retirement was not joined")
			}
			close(release)
			ctx, finish := context.WithTimeout(context.Background(), time.Second)
			err = s.Close(ctx)
			finish()
			if confirmed != (err == nil) {
				t.Fatalf("retirement confirmation=%v, Close=%v", confirmed, err)
			}
			s.mu.Lock()
			originalError := s.cleanupErr
			s.mu.Unlock()
			if originalError == nil {
				t.Fatal("original failure evidence was discarded")
			}
		})
	}
}

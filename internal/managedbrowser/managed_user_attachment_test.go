package managedbrowser

import (
	"context"
	"encoding/json"
	"errors"
	"strings"
	"testing"
	"time"
)

// Keep the caller from consuming the original attach result at all. The reader
// must publish that result before dispatching the immediately following event.
// No sleep or goroutine scheduling assumption chooses the interleaving.
func TestManagedUserAttachmentReceiptPrecedesFollowingEvent(t *testing.T) {
	f := newUserFixture(t, func(f *userFixture, r userTestRequest) bool {
		if r.Method != "Target.attachToTarget" {
			return false
		}
		f.reply(r, map[string]any{"sessionId": "worker-session"})
		f.write(map[string]any{"sessionId": "worker-session", "method": "Inspector.workerScriptLoaded", "params": map[string]any{}})
		return true
	}, false)
	ctx, cancel := context.WithTimeout(context.Background(), time.Second)
	defer cancel()
	connection, err := connectBrowser(ctx, f.endpoint())
	if err != nil {
		t.Fatal(err)
	}
	c := &UserController{targetID: "owned-worker"}
	observed := make(chan error, 1)
	c.cdp = newUserCDP(connection.conn, func(session, method string, params json.RawMessage) error {
		err := c.handleEvent(session, method, params)
		observed <- err
		return err
	})
	t.Cleanup(func() { c.cdp.fail(errors.New("test finished")); <-c.cdp.readerDone; c.cdp.writers.Wait() })
	call, err := c.startWorkerAttachment(ctx, "owned-worker")
	if err != nil {
		t.Fatal(err)
	}
	if err := userWait(t, observed); err != nil {
		t.Fatalf("original attach reply did not publish identity before its following event: %v", err)
	}
	if _, err := call.wait(ctx); err != nil {
		t.Fatal(err)
	}
	c.mu.Lock()
	session := c.sessionID
	c.mu.Unlock()
	if session != "worker-session" {
		t.Fatal("original attachment was not retained")
	}
}

func attachmentController(t *testing.T, f *userFixture) *UserController {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), time.Second)
	defer cancel()
	connection, err := connectBrowser(ctx, f.endpoint())
	if err != nil {
		t.Fatal(err)
	}
	c := &UserController{targetID: "owned-worker", ownerDone: f.owner, done: make(chan struct{}), workerGone: make(chan struct{}),
		cleanupDone: make(chan struct{}), cleanupFailed: make(chan struct{}), commands: make(map[*userCall]bool)}
	c.cdp = newUserCDP(connection.conn, c.handleEvent)
	t.Cleanup(func() {
		f.ownerOnce.Do(func() { close(f.owner) })
		c.markWorkerGone()
		ctx, cancel := context.WithTimeout(context.Background(), time.Second)
		defer cancel()
		if err := c.Close(ctx); err != nil {
			t.Errorf("original attachment cleanup: %v", err)
		}
	})
	return c
}

func TestManagedUserAttachmentLateReplyRequiresOriginalDetach(t *testing.T) {
	attaches, detaches := make(chan userTestRequest, 1), make(chan userTestRequest, 1)
	f := newUserFixture(t, func(_ *userFixture, r userTestRequest) bool {
		switch r.Method {
		case "Target.attachToTarget":
			attaches <- r
		case "Target.detachFromTarget":
			detaches <- r
		default:
			return false
		}
		return true
	}, false)
	c := attachmentController(t, f)
	ctx, cancel := context.WithCancel(context.Background())
	call, err := c.startWorkerAttachment(ctx, c.targetID)
	if err != nil {
		t.Fatal(err)
	}
	attach := userWait(t, attaches) // The original command was actually submitted.
	cancel()
	if _, err := call.wait(ctx); !errors.Is(err, context.Canceled) {
		t.Fatalf("caller cancellation lost: %v", err)
	}
	c.unavailable(errors.New("test startup cancelled"))
	select {
	case <-call.done:
		t.Fatal("caller cancellation settled the original attachment")
	case <-c.cleanupDone:
		t.Fatal("cleanup finished without the original attachment outcome")
	default:
	}
	f.reply(attach, map[string]any{"sessionId": "worker-session"})
	detach := userWait(t, detaches)
	var params struct {
		SessionID string `json:"sessionId"`
	}
	if json.Unmarshal(detach.Params, &params) != nil || params.SessionID != "worker-session" || detach.SessionID != "" {
		t.Fatal("cleanup did not detach the exact original late session")
	}
	select {
	case <-c.cleanupDone:
		t.Fatal("cleanup finished before the original detach acknowledgement")
	default:
	}
	f.reply(detach, map[string]any{})
	closeCtx, closeCancel := context.WithTimeout(context.Background(), time.Second)
	defer closeCancel()
	if err := c.Close(closeCtx); err != nil {
		t.Fatal(err)
	}
	f.mu.Lock()
	defer f.mu.Unlock()
	if len(f.requests) != 2 {
		t.Fatalf("late attachment was replayed or used after cancellation: %+v", f.requests)
	}
}

func TestManagedUserAttachmentInvalidOriginalReplyNeverPublishes(t *testing.T) {
	for name, result := range map[string]string{
		"missing": `{}`, "empty": `{"sessionId":""}`, "wrong-type": `{"sessionId":7}`,
		"duplicate": `{"sessionId":"one","sessionId":"two"}`, "extra": `{"sessionId":"worker-session","private":"secret"}`,
		"control": `{"sessionId":"worker\nsession"}`,
	} {
		t.Run(name, func(t *testing.T) {
			f := newUserFixture(t, func(f *userFixture, r userTestRequest) bool {
				if r.Method != "Target.attachToTarget" {
					return false
				}
				f.reply(r, json.RawMessage(result))
				return true
			}, false)
			c := attachmentController(t, f)
			ctx, cancel := context.WithTimeout(context.Background(), time.Second)
			defer cancel()
			call, err := c.startWorkerAttachment(ctx, c.targetID)
			if err != nil {
				t.Fatal(err)
			}
			if _, err := call.wait(ctx); err == nil || err.Error() != "managed user worker session is missing" {
				t.Fatalf("malformed original reply accepted or leaked: %v", err)
			}
			c.mu.Lock()
			session := c.sessionID
			c.mu.Unlock()
			if session != "" {
				t.Fatal("malformed reply published session authority")
			}
			if _, err := c.startWorkerAttachment(ctx, c.targetID); err == nil {
				t.Fatal("attachment was retried")
			}
		})
	}
}

func TestManagedUserAttachmentForeignSessionStillRejected(t *testing.T) {
	for _, outer := range []bool{false, true} {
		name := "event"
		if outer {
			name = "reply"
		}
		t.Run(name, func(t *testing.T) {
			f := newUserFixture(t, func(f *userFixture, r userTestRequest) bool {
				if r.Method != "Target.attachToTarget" {
					return false
				}
				if outer {
					f.write(map[string]any{"id": r.ID, "sessionId": "foreign-secret-session", "result": map[string]any{"sessionId": "worker-session"}})
				} else {
					f.reply(r, map[string]any{"sessionId": "worker-session"})
					f.write(map[string]any{"sessionId": "foreign-secret-session", "method": "Inspector.workerScriptLoaded", "params": map[string]any{"secret": "private-value"}})
				}
				return true
			}, false)
			c := attachmentController(t, f)
			ctx, cancel := context.WithTimeout(context.Background(), time.Second)
			defer cancel()
			call, err := c.startWorkerAttachment(ctx, c.targetID)
			if err != nil {
				t.Fatal(err)
			}
			userWait(t, c.cdp.done)
			c.cdp.mu.Lock()
			failure := c.cdp.err
			c.cdp.mu.Unlock()
			if failure == nil {
				t.Fatal("foreign identity accepted")
			}
			if strings.Contains(failure.Error(), "secret") || strings.Contains(failure.Error(), "private-value") {
				t.Fatalf("private event leaked: %v", failure)
			}
			c.mu.Lock()
			session := c.sessionID
			c.mu.Unlock()
			if outer {
				if session != "" {
					t.Fatal("foreign outer reply granted authority")
				}
				if _, err := call.wait(ctx); err == nil {
					t.Fatal("foreign reply succeeded")
				}
			} else {
				var diagnostic *userEventError
				if !errors.As(failure, &diagnostic) || diagnostic.kind != "foreign-session" || diagnostic.method != "Inspector.workerScriptLoaded" || diagnostic.stage != "attached" || !diagnostic.expectedSession {
					t.Fatalf("safe event stage not preserved: %v", failure)
				}
				if session != "worker-session" {
					t.Fatal("foreign event replaced original identity")
				}
			}
		})
	}
}

func TestManagedUserAttachmentReceivedReplySurvivesConcurrentFailure(t *testing.T) {
	f := newUserFixture(t, nil, false)
	c := attachmentController(t, f)
	entered, release := make(chan struct{}), make(chan struct{})
	defer close(release)
	ctx, cancel := context.WithTimeout(context.Background(), time.Second)
	defer cancel()
	call, err := c.cdp.startReceipt(ctx, "", "Target.attachToTarget", map[string]any{"targetId": "owned-worker", "flatten": true}, func(data json.RawMessage) error {
		// All controller admissions take this lock before transport.mu.
		c.mu.Lock()
		if !c.cdp.mu.TryLock() {
			c.mu.Unlock()
			return errors.New("receipt holds transport lock")
		}
		c.cdp.mu.Unlock()
		c.mu.Unlock()
		close(entered)
		<-release
		return c.acceptWorkerAttachment(data)
	})
	if err != nil {
		t.Fatal(err)
	}
	userWait(t, entered)
	c.cdp.fail(errors.New("concurrent connection failure"))
	select {
	case <-call.done:
		t.Fatal("connection failure replaced the already received reply")
	case <-c.cdp.readerDone:
		t.Fatal("reader exited before original receipt acceptance")
	default:
	}
	// Unblock once, while also keeping early test failures from leaking the reader.
	release <- struct{}{}
	data, err := call.wait(ctx)
	if err != nil || string(data) != `{"sessionId":"worker-session"}` {
		t.Fatalf("original receipt lost: %s %v", data, err)
	}
	userWait(t, c.cdp.readerDone)
}

func TestManagedUserEventDiagnosticsAreBoundedAndPrivate(t *testing.T) {
	for _, method := range []string{"Runtime.bindingCalled", "Secret.private-token-method"} {
		t.Run(method, func(t *testing.T) {
			f := newUserFixture(t, nil, false)
			ctx, cancel := context.WithTimeout(context.Background(), time.Second)
			defer cancel()
			connection, err := connectBrowser(ctx, f.endpoint())
			if err != nil {
				t.Fatal(err)
			}
			cdp := newUserCDP(connection.conn, func(string, string, json.RawMessage) error { return errors.New("private-token-parser-error") })
			t.Cleanup(func() { cdp.fail(errors.New("test finished")); <-cdp.readerDone; cdp.writers.Wait() })
			userWait(t, f.ready)
			f.write(map[string]any{"method": method, "params": map[string]any{"channelKey": "private-token-payload"}})
			userWait(t, cdp.done)
			cdp.mu.Lock()
			failure := cdp.err
			cdp.mu.Unlock()
			var safe *userEventError
			if !errors.As(failure, &safe) || safe.kind != "unclassified" || safe.method != userEventMethod(method) || safe.stage != "unknown" || safe.expectedSession {
				t.Fatalf("unexpected diagnostic: %v", failure)
			}
			if strings.Contains(failure.Error(), "private-token") || strings.Contains(failure.Error(), "channelKey") || len(failure.Error()) > 220 {
				t.Fatalf("unbounded or private diagnostic: %v", failure)
			}
		})
	}
}

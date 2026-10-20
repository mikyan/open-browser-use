package managedbrowser

import (
	"context"
	"encoding/json"
	"strings"
	"testing"
	"time"
)

func TestManagedUserBrowserVersionComesFromOriginalRootAndBindsWorkerOpen(t *testing.T) {
	f := newUserFixture(t, nil, false)
	c := f.open()
	f.mu.Lock()
	requests := append([]userTestRequest(nil), f.requests...)
	f.mu.Unlock()
	versions, opens := 0, 0
	for _, request := range requests {
		if request.Method == "Browser.getVersion" {
			versions++
			if request.SessionID != "" || string(request.Params) != "{}" {
				t.Fatalf("version read is not the original root request: %+v", request)
			}
		}
		if request.Operation == "open" {
			opens++
			var version map[string]string
			if err := json.Unmarshal(request.Arguments["browserVersion"], &version); err != nil {
				t.Fatalf("missing original root version in worker open: %v", err)
			}
			if len(version) != 2 || version["product"] != "Chrome/156.0.8078.12" || version["revision"] != "@634b046faf2137b83af71c87baf362b533af9104" {
				t.Fatalf("version projection adopted unrelated fields: %v", version)
			}
			if versions != 1 || request.SessionID != "worker-session" ||
				string(request.Arguments["portId"]) != `"native-port"` ||
				string(request.Arguments["workerBootId"]) != `"worker-boot"` ||
				string(request.Arguments["extensionInstanceId"]) != `"installation"` {
				t.Fatal("root result was not bound to the original worker/port open")
			}
		}
	}
	if versions != 1 || opens != 1 || c.sessionID != "worker-session" {
		t.Fatalf("wanted one original root version read and worker open, got %d/%d", versions, opens)
	}
}

func TestManagedUserBrowserVersionFailureCannotOpenWorker(t *testing.T) {
	cases := map[string]json.RawMessage{
		"missing":       json.RawMessage(`{}`),
		"null":          json.RawMessage(`null`),
		"array":         json.RawMessage(`[]`),
		"product-null":  json.RawMessage(`{"product":null,"revision":"@original"}`),
		"revision-type": json.RawMessage(`{"product":"Chrome/156","revision":12}`),
		"empty":         json.RawMessage(`{"product":"","revision":"@original"}`),
		"control":       json.RawMessage(`{"product":"Chrome/156\nprivate","revision":"@original"}`),
		"space":         json.RawMessage(`{"product":"Chrome/156","revision":"@original "}`),
		"unicode":       json.RawMessage(`{"product":"Chrome/版本","revision":"@original"}`),
		"surrogate":     json.RawMessage(`{"product":"Chrome/156","revision":"\ud800"}`),
		"duplicate":     json.RawMessage(`{"product":"Chrome/156","revision":"@first","revision":"@second"}`),
		"over-bound":    json.RawMessage(`{"product":"` + strings.Repeat("x", 257) + `","revision":"@original"}`),
		"native-error":  nil,
	}
	for name, value := range cases {
		t.Run(name, func(t *testing.T) {
			f := newUserFixture(t, func(f *userFixture, request userTestRequest) bool {
				if request.Method != "Browser.getVersion" {
					return false
				}
				if value == nil {
					f.write(map[string]any{"id": request.ID, "error": map[string]any{"code": -32601, "message": "private native failure"}})
				} else {
					f.reply(request, value)
				}
				return true
			}, false)
			ctx, cancel := context.WithTimeout(context.Background(), time.Second)
			defer cancel()
			identity := f.identity
			identity.ChannelID = ""
			var retained *UserController
			c, err := openUserControllerRetained(ctx, f.endpoint(), identity, f.owner, nil, func(c *UserController) { retained = c })
			if retained != nil {
				defer func() {
					closeCtx, closeCancel := context.WithTimeout(context.Background(), time.Second)
					defer closeCancel()
					if err := retained.Close(closeCtx); err != nil {
						t.Errorf("original failure cleanup: %v", err)
					}
				}()
			}
			if c != nil || err == nil || retained == nil {
				t.Fatalf("invalid version opened worker: controller=%v error=%v retained=%v", c != nil, err, retained != nil)
			}
			f.mu.Lock()
			defer f.mu.Unlock()
			for _, request := range f.requests {
				if request.Method == "Target.attachToTarget" || request.Operation == "open" {
					t.Fatalf("version failure continued worker admission: %s", request.Method)
				}
			}
		})
	}
}

func TestManagedUserBrowserVersionCancelledReadCannotAdoptLateResult(t *testing.T) {
	entered := make(chan userTestRequest, 1)
	f := newUserFixture(t, func(_ *userFixture, request userTestRequest) bool {
		if request.Method != "Browser.getVersion" {
			return false
		}
		entered <- request
		return true
	}, false)
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	identity := f.identity
	identity.ChannelID = ""
	var retained *UserController
	finished := make(chan error, 1)
	go func() {
		_, err := openUserControllerRetained(ctx, f.endpoint(), identity, f.owner, nil, func(c *UserController) { retained = c })
		finished <- err
	}()
	select {
	case request := <-entered:
		if request.SessionID != "" {
			t.Fatal("version read attached to a session")
		}
		cancel()
		if err := userWait(t, finished); err == nil {
			t.Fatal("cancelled root version read opened the worker")
		}
		closeCtx, closeCancel := context.WithTimeout(context.Background(), time.Second)
		defer closeCancel()
		if retained == nil || retained.Close(closeCtx) != nil {
			t.Fatal("cancelled root read did not settle original controller cleanup")
		}
		// Transport settlement is not permission to use a late original value.
		f.reply(request, map[string]any{"product": "Chrome/156.0.8078.12", "revision": "@634b046faf2137b83af71c87baf362b533af9104"})
		f.mu.Lock()
		defer f.mu.Unlock()
		for _, request := range f.requests {
			if request.Method == "Target.attachToTarget" || request.Operation == "open" {
				t.Fatal("late root reply was used to reopen worker admission")
			}
		}
	case <-time.After(time.Second):
		cancel()
		userWait(t, finished)
		if retained != nil {
			closeCtx, closeCancel := context.WithTimeout(context.Background(), time.Second)
			defer closeCancel()
			_ = retained.Close(closeCtx)
		}
		t.Fatal("original root Browser.getVersion was never requested")
	}
}

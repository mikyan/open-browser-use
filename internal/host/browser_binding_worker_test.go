package host

import (
	"context"
	"encoding/json"
	"fmt"
	"strings"
	"testing"

	"github.com/ifuryst/open-browser-use/internal/browserdownloads"
)

func TestBrowserBindingWorkerScriptStrictPrivateOption(t *testing.T) {
	for _, value := range []any{nil, false, 1, []any{}, map[string]any{}, "", "worker.js", "../background.js", "background.js?run=1", "managed-worker-" + strings.Repeat("A", 32) + ".js"} {
		t.Run(fmt.Sprintf("invalid-%T-%v", value, value), func(t *testing.T) {
			f := newBindingFixture(t, nil, nil)
			f.relay.browserBinding.dial = func(context.Context, string, browserdownloads.Identity, browserdownloads.DialOptions) (pageDownloadManager, error) {
				t.Fatal("invalid worker entry reached Browser dial")
				return nil, nil
			}
			client := f.client(t)
			request := bindingRequest("invalid-worker", 1000)
			request["params"].(map[string]any)["workerScript"] = value
			bindingWrite(t, client, request)
			if response := bindingRead(t, client); response["error"] == nil {
				t.Fatal("invalid worker entry accepted", response)
			}
			select {
			case event := <-f.events:
				t.Fatal("invalid worker entry issued native challenge", event)
			default:
			}
		})
	}
	for _, script := range []string{"", "background.js", "managed-worker-" + strings.Repeat("a", 32) + ".js"} {
		t.Run("valid-"+script, func(t *testing.T) {
			f := newBindingFixture(t, nil, nil)
			calls := 0
			f.relay.browserBinding.dial = func(_ context.Context, endpoint string, identity browserdownloads.Identity, options browserdownloads.DialOptions) (pageDownloadManager, error) {
				calls++
				if endpoint != "ws://127.0.0.1:9222/devtools/browser/original" || options.WorkerScript != script || identity.PortID != "port-original" {
					t.Error("worker selection replaced original endpoint or identity", endpoint, options, identity)
				}
				data, _ := json.Marshal(identity)
				var fields map[string]any
				_ = json.Unmarshal(data, &fields)
				if len(fields) != 5 {
					t.Fatal("worker selection changed the five-field challenge", fields)
				}
				return newBindingFake("same-generation"), nil
			}
			client := f.client(t)
			request := bindingRequest("valid-worker", 1000)
			if script != "" {
				request["params"].(map[string]any)["workerScript"] = script
			}
			bindingWrite(t, client, request)
			f.answer(t, f.next(t, "challenge"))
			ready := f.next(t, "ready")
			if response := bindingRead(t, client); response["error"] != nil || ready["available"] != true || calls != 1 {
				t.Fatal(response, ready, calls)
			}
		})
	}
}

package obu

import (
	"net"
	"reflect"
	"testing"
	"time"
)

func TestSemanticLocatorsPreserveSiblingScopesAndOptions(t *testing.T) {
	path, cleanup := startSDKServer(t, func(conn net.Conn) {
		legacyControlHandshake(t, conn)
		for _, expected := range []struct {
			action string
			steps  []any
			args   map[string]any
			value  any
		}{
			{"fill", []any{Params{"kind": "frame", "selector": "#account"}, Params{"kind": "label", "value": "Name", "exact": true}}, Params{"value": "Go 中文", "force": false}, nil},
			{"innerText", []any{Params{"kind": "frame", "selector": "#account"}, Params{"kind": "css", "selector": "section"}, Params{"kind": "filter", "hasText": "Ready"}, Params{"kind": "role", "role": "button", "name": "Continue", "exact": true}, Params{"kind": "nth", "index": float64(1)}}, nil, "Continue"},
			{"count", []any{Params{"kind": "frame", "selector": "#account"}, Params{"kind": "css", "selector": "section"}}, nil, float64(3)},
		} {
			request := readRequest(t, conn)
			params := request["params"].(map[string]any)
			if request["method"] != "browserAction" || params["action"] != expected.action {
				t.Errorf("wrong engine route: %#v", request)
			}
			// Decode expected maps through the same JSON types as the wire.
			want := make([]any, len(expected.steps))
			for i, step := range expected.steps {
				want[i] = map[string]any(step.(Params))
			}
			if !reflect.DeepEqual(params["locator"], want) {
				t.Errorf("locator changed: got %#v want %#v", params["locator"], want)
			}
			if expected.args != nil && !reflect.DeepEqual(params["args"], expected.args) {
				t.Errorf("action args: %#v", params["args"])
			}
			writeResponse(t, conn, request["id"], Params{"value": expected.value, "engine": Params{"name": "playwright-crx", "version": "0.15.0", "playwrightVersion": "1.53.0"}})
		}
	})
	defer cleanup()
	browser := NewBrowser(NewClient(Options{SocketPath: path, Timeout: time.Second}))
	defer browser.Close()
	frame := browser.Tab(42).Playwright.FrameLocator("#account")
	sections := frame.Locator("section")
	args := Params{"value": "must not override supplied value", "force": false}
	if err := frame.GetByLabel("Name", TextOptions{Exact: true}).Fill("Go 中文", BrowserActionOptions{Args: args}); err != nil {
		t.Fatal(err)
	}
	if args["value"] != "must not override supplied value" {
		t.Fatal("action mutated caller options")
	}
	button := sections.Filter(FilterOptions{HasText: "Ready"}).GetByRole("button", RoleOptions{Name: "Continue", Exact: true}).Nth(1)
	if text, err := button.InnerText(time.Second); err != nil || text != "Continue" {
		t.Fatalf("text=%q error=%v", text, err)
	}
	if count, err := sections.Count(); err != nil || count != 3 {
		t.Fatalf("count=%d error=%v", count, err)
	}
}

func TestLocatorResultTypesDoNotHideProtocolErrors(t *testing.T) {
	if value, err := actionNullableString(nil, nil); err != nil || value != nil {
		t.Fatal("null attributes must be preserved")
	}
	if _, err := actionString(float64(1), nil); err == nil {
		t.Fatal("invalid text result accepted")
	}
	if _, err := actionBool("false", nil); err == nil {
		t.Fatal("invalid boolean result accepted")
	}
	if _, err := actionStrings([]any{"ok", false}, nil); err == nil {
		t.Fatal("invalid array member accepted")
	}
	if _, err := actionScreenshot(Params{"base64": 7, "mimeType": "image/png"}, nil); err == nil {
		t.Fatal("invalid image accepted")
	}
}

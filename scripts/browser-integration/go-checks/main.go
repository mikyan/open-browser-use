// Runs only against the synthetic fixture served by the browser integration
// harness. The browser itself is operated through the public Go SDK.
package main

import (
	"bytes"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"image/png"
	"os"
	"runtime"
	"strings"
	"time"

	obu "github.com/ifuryst/open-browser-use/packages/open-browser-use-go"
)

func must[T any](value T, err error) T {
	if err != nil {
		panic(err)
	}
	return value
}
func require(ok bool, message string) {
	if !ok {
		panic(message)
	}
}
func action(err error) {
	if err != nil {
		panic(err)
	}
}

func main() {
	if len(os.Args) != 3 {
		panic("usage: go-checks endpoint fixtureURL")
	}
	browser := must(obu.ConnectOpenBrowserUse(obu.Options{SocketPath: os.Args[1], SessionID: "go-browser-integration", TurnID: "acceptance", Timeout: 15 * time.Second}))
	defer browser.Close()
	checks := []string{}
	tab := must(browser.NewTab(obu.GotoOptions{URL: os.Args[2]}))
	action(tab.GetByRole("button", obu.RoleOptions{Name: "ARIA named action", Exact: true}).Click())
	require(must(tab.Locator("#role-result").InnerText(time.Second)) == "clicked", "semantic click did not reach the page")
	require(strings.Contains(must(tab.DOMSnapshot()), `button "ARIA named action"`), "snapshot lacks accessible name")
	checks = append(checks, "role-name-and-snapshot")
	err := tab.GetByRole("button", obu.RoleOptions{Name: "Duplicate", Exact: true}).Click(obu.BrowserActionOptions{Timeout: 400 * time.Millisecond})
	require(err != nil && strings.Contains(err.Error(), "strict mode violation"), "duplicate locator must fail strictness")
	checks = append(checks, "strictness")
	field := tab.GetByLabel("Controlled name")
	action(field.Fill("Go 中文"))
	require(must(field.InputValue()) == "Go 中文", "controlled input value mismatch")
	require(must(tab.Locator("#controlled-result").InnerText(time.Second)) == "Go 中文", "React controlled state mismatch")
	editor := tab.Playwright.GetByRole("textbox", obu.RoleOptions{Name: "Rich editor"})
	action(editor.Fill("Go rich text"))
	require(must(editor.InnerText(time.Second)) == "Go rich text", "contenteditable state mismatch")
	checks = append(checks, "controlled-and-contenteditable")
	action(tab.GetByRole("button", obu.RoleOptions{Name: "Shadow action"}).Click())
	require(must(tab.Locator("#shadow-result").InnerText(time.Second)) == "clicked", "shadow click mismatch")
	for _, selector := range []string{"#same-frame", "#cross-frame"} {
		frame := tab.FrameLocator(selector)
		action(frame.GetByLabel("Frame field").Fill("Go frame 中文"))
		action(frame.GetByRole("button", obu.RoleOptions{Name: "Frame action"}).Click())
		require(must(frame.GetByLabel("Frame field").InputValue()) == "Go frame 中文", selector+" input mismatch")
		require(must(frame.Locator("#frame-result").InnerText(time.Second)) == "clicked", selector+" click mismatch")
	}
	checks = append(checks, "shadow-and-frames")
	shot := must(tab.Screenshot())
	require(shot.MimeType == "image/png", "screenshot MIME type mismatch")
	pixels := must(png.Decode(bytes.NewReader(must(base64.StdEncoding.DecodeString(shot.Base64)))))
	require(pixels.Bounds().Dx() > 0 && pixels.Bounds().Dy() > 0, "empty screenshot")
	checks = append(checks, "screenshot")
	require(must(tab.Title()) == "OBU SDK fixture", "raw CDP title mismatch")
	action(tab.GetByRole("button", obu.RoleOptions{Name: "Engine action", Exact: true}).Click())
	require(must(tab.Locator("#engine-result").InnerText(time.Second)) == "1", "raw CDP and engine did not coexist")
	checks = append(checks, "raw-cdp-engine-coexistence")
	navigation := os.Args[2] + "?go-navigation=1"
	must(tab.Goto(navigation))
	action(tab.WaitForURL(navigation))
	info := must(browser.Client.BrowserAction(tab.ID, "engineInfo", obu.BrowserActionOptions{}))
	require(info.Engine["name"] == "playwright-crx", "engine metadata mismatch")
	checks = append(checks, "navigation-and-metadata")
	must(browser.CDP.Navigate(tab.ID, os.Args[2]+"?go-raw-navigation=1", obu.GotoOptions{}))
	require(must(tab.URL()) == os.Args[2]+"?go-raw-navigation=1", "raw navigation URL mismatch")
	checks = append(checks, "scoped-raw-navigation")
	must(tab.Goto(os.Args[2] + "actions/a"))
	must(tab.Goto(os.Args[2] + "actions/b"))
	must(tab.GoBack())
	require(must(tab.URL()) == os.Args[2]+"actions/a", "history back URL mismatch")
	require(must(tab.Locator("h1").InnerText(time.Second)) == "/actions/a", "history back page mismatch")
	must(tab.GoForward())
	require(must(tab.URL()) == os.Args[2]+"actions/b", "history forward URL mismatch")
	visit := must(tab.Locator("#visit").InnerText(time.Second))
	must(tab.Reload())
	require(must(tab.Locator("#visit").InnerText(time.Second)) != visit, "reload reused old response")
	checks = append(checks, "history-and-reload")
	field = tab.GetByLabel("Type here")
	action(field.Focus())
	require(must(tab.Evaluate("document.activeElement.id")) == "field", "focus mismatch")
	action(field.PressSequentially("Go1", obu.BrowserActionOptions{Args: obu.Params{"delay": 3}}))
	require(must(field.InputValue()) == "Go1", "sequential typing mismatch")
	require(must(tab.Evaluate("events.filter(e=>e.type==='keydown'&&e.id==='field'&&e.trusted).length")) == float64(3), "typing missing trusted keys")
	action(tab.Locator("#bottom").ScrollIntoViewIfNeeded())
	require(must(tab.Evaluate("document.querySelector('#bottom').getBoundingClientRect().bottom<=innerHeight")) == true, "scroll did not reveal element")
	action(tab.Locator("#source").ScrollIntoViewIfNeeded())
	action(tab.Locator("#source").DragTo(tab.Locator("#drop")))
	require(must(tab.Locator("#result").InnerText(time.Second)) == "real drag", "HTML drag data missing")
	require(must(tab.Evaluate("events.some(e=>e.type==='drop'&&e.id==='drop'&&e.trusted)")) == true, "drop was not trusted")
	box := must(tab.Locator("#pointer").Action("boundingBox", obu.BrowserActionOptions{})).(map[string]any)
	x, y := box["x"].(float64), box["y"].(float64)
	action(tab.Mouse.Move(x+10, y+10))
	action(tab.Mouse.Down())
	action(tab.Mouse.Move(x+65, y+50, obu.BrowserActionOptions{Args: obu.Params{"steps": 4}}))
	action(tab.Mouse.Up())
	require(must(tab.Evaluate("pointer.dataset.dragging")) == "no", "pointer still dragging")
	require(must(tab.Locator("#pointer-result").InnerText(time.Second)) != "", "pointer drag did not move")
	checks = append(checks, "trusted-keys-scroll-html-drop-and-pointer-drag")
	must(tab.Evaluate("console.log('Go diagnostics 中文')"))
	diagnostics := must(tab.Diagnostics(obu.DiagnosticsOptions{Limit: 200}))
	found := false
	for _, entry := range diagnostics.Entries {
		found = found || entry["kind"] == "console" && entry["text"] == "Go diagnostics 中文"
	}
	require(found, "console diagnostic not captured")
	next := must(tab.Diagnostics(obu.DiagnosticsOptions{After: &diagnostics.Cursor}))
	require(len(next.Entries) == 0, "diagnostic cursor repeated entries")
	must(browser.Client.TurnEnded())
	_, err = tab.Diagnostics(obu.DiagnosticsOptions{After: &diagnostics.Cursor})
	require(err != nil && strings.Contains(err.Error(), "OBU_DIAGNOSTICS_EXPIRED"), "diagnostic cursor survived detach")
	for _, entry := range must(tab.Diagnostics()).Entries {
		require(entry["text"] != "Go diagnostics 中文", "diagnostics leaked previous turn")
	}
	checks = append(checks, "diagnostics-pagination-and-turn-isolation")
	must(browser.Client.FinalizeTabs(nil))
	checks = append(checks, "finalize")
	result := must(json.Marshal(map[string]any{"passed": true, "goVersion": runtime.Version(), "checks": checks}))
	fmt.Println(string(result))
}

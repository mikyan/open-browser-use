// Runs only against the synthetic fixture served by the browser integration
// harness. The browser itself is operated through the public Go SDK.
package main

import (
	"bytes"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"image/png"
	"os"
	"path/filepath"
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

// This parser is limited to a known unique label in the synthetic fixture. The
// extension's structured native-ref allowlist remains the authority.
func fixtureRef(capture obu.AISnapshot, label string) string {
	lines := []string{}
	for _, line := range strings.Split(capture.Snapshot, "\n") {
		if strings.Contains(line, `button "`+label+`"`) {
			lines = append(lines, line)
		}
	}
	require(len(lines) == 1, "fixture button line is not unique")
	_, suffix, found := strings.Cut(lines[0], "[ref=")
	require(found, "fixture line has no native ref")
	ref, _, found := strings.Cut(suffix, "]")
	require(found && !strings.Contains(suffix, "[ref="), "fixture line has ambiguous native refs")
	allowed := false
	for _, emitted := range capture.Refs {
		allowed = allowed || emitted == ref
	}
	require(allowed, "fixture ref absent from structured allowlist")
	return ref
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
	must(tab.Evaluate("document.querySelector('#role-result').textContent='';globalThis.__integrationRootEvents=[]"))
	capture := must(tab.SnapshotAI(obu.AISnapshotOptions{}))
	require(capture.Complete && capture.Stats.Bytes == len(capture.Snapshot), "invalid bounded AI snapshot")
	referenced := tab.GetByRef(capture.CaptureID, fixtureRef(capture, "ARIA named action"))
	require(must(referenced.InnerText(time.Second)) == "Icon", "native ref read addressed the wrong element")
	action(referenced.Click())
	require(must(tab.Locator("#role-result").InnerText(time.Second)) == "clicked", "native ref click did not reach the page")
	require(must(tab.Evaluate("__integrationRootEvents.some(event=>event.event==='click'&&event.trusted)")) == true, "native ref click was not trusted")
	checks = append(checks, "bounded-ai-snapshot-ref-read-and-trusted-click")
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
	// Arm returns ready before the sequential click; no goroutine is needed to
	// establish ordering on the synchronous client's RPC connection.
	network := must(browser.NewTab())
	must(browser.CDP.Navigate(network.ID, os.Args[2]+"network-waits?key=go-network&mode=normal&status=201&method=POST", obu.GotoOptions{}))
	networkURL := os.Args[2] + "network-waits/api?key=go-network&mode=normal&status=201"
	request := must(network.ExpectRequest(obu.NetworkWaitMatch{URL: networkURL, Method: "POST"}, obu.NetworkWaitOptions{Timeout: 5 * time.Second}))
	response := must(network.ExpectResponse(obu.NetworkWaitMatch{URL: networkURL, Method: "POST", Status: 201}, obu.NetworkWaitOptions{Timeout: 5 * time.Second}))
	action(network.GetByRole("button", obu.RoleOptions{Name: "Send main network request", Exact: true}).Click())
	sent, received := must(request.Result()), must(response.Result())
	require(sent.Event == "request" && received.Event == "response", "network event kinds mismatch")
	require(sent.RequestID == received.RequestID, "request and response identity mismatch")
	require(received.URL == networkURL && received.Method == "POST" && received.Status == 201, "network response metadata mismatch")
	require(received.ResourceType == "fetch" && strings.Contains(received.FrameURL, "go-network"), "network frame metadata mismatch")
	require(must(response.Result()) == received, "repeated collect changed its result")
	require(must(network.Evaluate("networkClicks.length===1&&networkClicks[0].trusted")) == true, "network click was not exactly one trusted event")
	networkCounts := must(network.Evaluate("fetch('/network-waits/stats?key=go-network').then(response=>response.json())", true))
	require(len(networkCounts.(map[string]any)["requests"].([]any)) == 1, "network trigger was replayed")
	action(request.Cancel())
	action(response.Cancel())
	checks = append(checks, "network-wait-cold-ready-trusted-click-and-single-request")
	navigationTab := must(browser.NewTab())
	must(browser.CDP.Navigate(navigationTab.ID, os.Args[2]+"navigation-waits?key=go-navigation-ready&mode=document", obu.GotoOptions{}))
	navigationURL := os.Args[2] + "navigation-waits/target?key=go-navigation-ready"
	navigationWait := must(navigationTab.ExpectURL(navigationURL, obu.NavigationWaitOptions{WaitUntil: "load", Timeout: 5 * time.Second}))
	action(navigationTab.GetByRole("button", obu.RoleOptions{Name: "Navigate fixture", Exact: true}).Click())
	action(navigationWait.Result())
	action(navigationWait.Result())
	require(must(navigationTab.URL()) == navigationURL, "navigation wait returned for another URL")
	navigationClicks := must(navigationTab.Evaluate("navigationClicks"))
	require(must(navigationTab.Evaluate("navigationClicks.length===1&&navigationClicks[0].trusted")) == true, "navigation click was not exactly one trusted event")
	navigationCounts := must(navigationTab.Evaluate("fetch('/navigation-waits/stats?key=go-navigation-ready').then(response=>response.json())", true))
	require(navigationCounts.(map[string]any)["targets"] == float64(1), "navigation trigger was replayed")
	action(navigationWait.Cancel())
	loaded := must(navigationTab.ExpectLoadState(obu.NavigationWaitOptions{State: "load", Timeout: time.Second}))
	action(loaded.Result())
	action(loaded.Cancel())
	checks = append(checks, "navigation-wait-cold-ready-trusted-click-single-document-and-cached-load")
	direct := must(browser.NewTab())
	must(direct.Goto(os.Args[2] + "direct-downloads/page"))
	require(must(direct.Evaluate("document.cookie.includes('obu_direct_download_fixture')")) == false, "HttpOnly fixture cookie is exposed")
	download := must(direct.DownloadURL(os.Args[2]+"direct-downloads/file?key=go-direct&mode=fast", obu.DownloadURLOptions{Filename: "go-direct.txt", Timeout: 5 * time.Second}))
	downloadedPath := must(download.Path(obu.DownloadOptions{Timeout: 5 * time.Second}))
	downloadRoot := must(filepath.EvalSymlinks(os.Getenv("OBU_TEST_DOWNLOAD_ROOT")))
	resolvedDownload := must(filepath.EvalSymlinks(downloadedPath))
	relativeDownload := must(filepath.Rel(downloadRoot, resolvedDownload))
	require(relativeDownload != "." && relativeDownload != ".." && !strings.HasPrefix(relativeDownload, ".."+string(filepath.Separator)) && !filepath.IsAbs(relativeDownload), "Download path escaped isolated fixture directory")
	downloadedBytes := must(os.ReadFile(resolvedDownload))
	downloadedHash := fmt.Sprintf("%x", sha256.Sum256(downloadedBytes))
	downloadStats := must(direct.Evaluate("fetch('/direct-downloads/stats?key=go-direct').then(response=>response.json())", true)).(map[string]any)
	downloadRequests := downloadStats["requests"].([]any)
	require(len(downloadRequests) == 1, "direct download was replayed")
	downloadRequest := downloadRequests[0].(map[string]any)
	require(downloadRequest["method"] == "GET" && downloadRequest["cookie"] == true, "direct download omitted HttpOnly cookie or changed method")
	require(downloadRequest["sha256"] == downloadedHash && downloadRequest["bytes"] == float64(len(downloadedBytes)) && downloadRequest["payload"] == string(downloadedBytes), "direct download path did not contain exact response bytes")
	pendingDownload := must(direct.DownloadURL(os.Args[2]+"direct-downloads/file?key=go-direct-cancel&mode=slow", obu.DownloadURLOptions{Timeout: 5 * time.Second}))
	_, err = pendingDownload.Path(obu.DownloadOptions{Timeout: 150 * time.Millisecond})
	require(err != nil && strings.Contains(err.Error(), "OBU_DOWNLOAD_TIMEOUT"), "pending path did not time out")
	action(pendingDownload.Cancel(obu.DownloadOptions{Timeout: 5 * time.Second}))
	downloadCancel := must(direct.Evaluate(`(async()=>{
		const deadline=performance.now()+5000;
		for(;;){
			const stats=await fetch('/direct-downloads/stats?key=go-direct-cancel').then(response=>response.json());
			if(stats.requests.length===1&&stats.requests[0].closed)return stats;
			if(performance.now()>=deadline)throw new Error('Canceled native download did not close before finalize');
			await new Promise(resolve=>setTimeout(resolve,10));
		}
	})()`, true)).(map[string]any)
	cancelRequests := downloadCancel["requests"].([]any)
	require(len(cancelRequests) == 1, "native cancellation request count changed")
	cancelRequest := cancelRequests[0].(map[string]any)
	require(cancelRequest["closed"] == true && cancelRequest["finished"] == false, "native cancellation did not close unfinished response before finalize")
	_, err = pendingDownload.Path(obu.DownloadOptions{Timeout: 500 * time.Millisecond})
	require(err != nil && strings.Contains(err.Error(), "OBU_DOWNLOAD_EXPIRED"), "cancelled download retained a path handle")
	checks = append(checks, "direct-download-http-only-cookie-exact-file-hash-path-timeout-and-cancel")
	must(browser.Client.FinalizeTabs(nil))
	checks = append(checks, "finalize")
	result := must(json.Marshal(map[string]any{"passed": true, "goVersion": runtime.Version(), "checks": checks, "networkWait": received, "networkServer": networkCounts, "navigationWait": map[string]any{"url": navigationURL, "clicks": navigationClicks, "server": navigationCounts}, "directDownload": map[string]any{"path": resolvedDownload, "bytes": len(downloadedBytes), "sha256": downloadedHash, "cancelBeforeFinalize": downloadCancel}}))
	fmt.Println(string(result))
}

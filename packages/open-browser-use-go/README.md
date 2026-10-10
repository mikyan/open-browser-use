# Open Browser Use Go SDK

Go client for controlling a real Chrome profile through Open Browser Use. The
package keeps the low-level JSON-RPC/CDP surface available and also provides
higher-level browser/tab helpers for common agent workflows.

## Installation

```sh
go get github.com/ifuryst/open-browser-use/packages/open-browser-use-go
```

The SDK expects the `open-browser-use` CLI and Chrome extension to already be
installed and connected:

```sh
open-browser-use ping
open-browser-use info
```

## Usage

```go
package main

import (
	"fmt"
	"log"
	"time"

	obu "github.com/ifuryst/open-browser-use/packages/open-browser-use-go"
)

func main() {
	browser, err := obu.ConnectActive(obu.Options{
		SessionID: "go-sdk-example",
		Timeout:   20 * time.Second,
	})
	if err != nil {
		log.Fatal(err)
	}
	defer browser.Close()

	defer browser.Client.FinalizeTabs(nil)

	if _, err := browser.Client.NameSession("Go SDK example - OBU"); err != nil {
		log.Fatal(err)
	}

	tab, err := browser.NewTab()
	if err != nil {
		log.Fatal(err)
	}

	if _, err := tab.Goto("https://example.com", obu.GotoOptions{
		WaitUntil: obu.LoadStateDOMContentLoaded,
		Timeout:   15 * time.Second,
	}); err != nil {
		log.Fatal(err)
	}

	title, err := tab.Title()
	if err != nil {
		log.Fatal(err)
	}
	fmt.Println(title)
}
```

Use `Client.Request(method, params)` when you need a public Browser Use
JSON-RPC call, or `Client.ExecuteCDP` / `Browser.CDP.Call` for raw CDP commands.

## Playwright actions

The development extension uses its genuine Playwright engine for tab navigation,
semantic snapshots and immutable locators. For example, after inspecting a
snapshot of an owned tab:

```go
snapshot, err := tab.DOMSnapshot()
name := tab.GetByLabel("Name", obu.TextOptions{Exact: true})
err = name.Fill("Ada")
err = tab.GetByRole("button", obu.RoleOptions{Name: "Continue", Exact: true}).Click()
frameName := tab.FrameLocator("#account").GetByLabel("Name")
value, err := frameName.InputValue()
```

Locators support CSS, role/name, text, label, placeholder, alt text, title and
test ID, plus frame, filter, first/last and nth chains. Actions include click,
double-click, hover, fill, key press, checkbox, selection, waiting, text/state
reads, ARIA snapshots and screenshots. Multiple matches fail strictness instead
of choosing the first match. Action options accept a bounded `Timeout` and an
`Args` map with the finite options documented in the protocol.
`Tab.GoBack`, `GoForward`, `Reload`, locator `Focus`, `PressSequentially`,
`ScrollIntoViewIfNeeded`, `DragTo` and `Tab.Mouse.Down`/`Up` expose richer input.
An absent drag target fails before pressing; cancelling after input was sent
releases held buttons and may emit `pointerup`/click, without rolling back effects.

`Tab.Diagnostics(DiagnosticsOptions{Limit: 100})` reads console, page error and
network summaries recorded since the first engine action on this attachment.
Pass the returned `Cursor` as `After` for the next page. The result includes a
capture ID and cumulative dropped count; detach invalidates its cursor and
history. Headers, bodies and activity before attachment are not recorded.

Use `Client.BrowserAction` to inspect the returned engine metadata or call any
action from the protocol directly:

```go
result, err := browser.Client.BrowserAction(tab.ID, "click", obu.BrowserActionOptions{
    Locator: []obu.Params{{"kind": "role", "role": "button", "name": "Continue", "exact": true}},
    Timeout: 15 * time.Second,
})
```

The result has `Value` and `Engine` fields. `snapshot` returns a semantic ARIA
snapshot; `screenshot` returns a value with `base64` and `mimeType`. The serialized
locator/action contract is documented in `docs/references/browser-action-protocol.md`.
`Tab.Goto`, `WaitForLoadState`, `DOMSnapshot` and `Locator.InnerText` now use
engine semantics. `Tab.Evaluate`, `Title`, `URL`, `Close` and explicit `CDP`
helpers retain their raw CDP surface. `Tab.Screenshot` and locator screenshots
return `Screenshot{Base64, MimeType}`; no local file is written automatically.

`Tab.SnapshotAI` and `Tab.Playwright.SnapshotAI` return a complete recursive
frame observation as `AISnapshot`:

```go
capture, err := tab.SnapshotAI(obu.AISnapshotOptions{MaxBytes: 65536, Timeout: 10 * time.Second})
if err != nil { return err }
fmt.Println(capture.Snapshot, capture.Stats)
// Choose a reference listed in capture.Refs after reading the observation.
target := tab.GetByRef(capture.CaptureID, chosenRef)
if err := target.Click(); err != nil { return err }
```

The result has `CaptureID`, `Snapshot`, `Refs`, `Stats` (`Bytes`, `Nodes`, `Refs`,
`Frames`) and `Complete`. Responses must be complete and pass strict UTF-8 byte,
unique-ref and count validation against the requested budgets. No reference is
extracted from page text. `AISnapshotOptions` allows lower positive `MaxBytes`
(262144), `MaxNodes` (5000), `MaxRefs` (2000), `MaxFrames` (32 including the root)
and `MaxDepth` (64); these are also the default hard ceilings. Zero-valued fields
omit an option. Limit or child-capture failures return errors, not partial
success. Engine metadata advertises `capabilities: {snapshotAI: 1, captureRefs: 1}`
and `snapshotLimits`; unsupported engines do not fall back to ordinary snapshots.

`GetByRef` is available on `Tab` and `TabPlaywright`. It returns a singleton
locator for the original connected Element and supports ordinary actions, reads,
screenshots and same-tab drag targets. Deriving CSS, semantic, frame, ordinal or
filter chains from it records a builder error; the next action fails locally
before transport. Invalid capture IDs or ref tokens behave the same way. A
renamed node remains the same Element; the SDK does not locate a replacement by
text. Any new ordinary/AI snapshot, frame lifecycle event, attachment/owner/epoch
change, pause or restart expires the capture. `ARIASnapshot` on a ref uses it and
invalidates the capture for subsequent calls. Expired refs never trigger an
automatic recapture or replay. `DOMSnapshot` retains its existing scoped behavior.

Windows uses the host's local named pipe and Unix platforms use AF_UNIX. Read
`socketPath` from `active.json`, or use `ConnectActive`. Upgrade the host and SDK
together. A request deadline covers fragmented reads and notifications; timeout
or invalid framing closes the connection. A later explicit request reconnects,
without silently replaying the failed browser operation.

Notification callbacks run synchronously in the request loop. They may register
or remove handlers, including removing themselves; use a separate client for a
nested browser request from a callback.

## Turn lifecycle

The first protected request discovers the extension's lifecycle version. Current
extensions provide a persistent control epoch; the client includes it in each
request and advances to the returned epoch/turn only after successful `TurnEnded`
or `FinalizeTabs`. Already submitted work keeps its original turn. A queued call
from an ended turn fails, and waiting for the connection consumes its deadline.

After inspecting a stale-epoch error or an uncertain end result, call
`browser.Client.BeginTurn()` explicitly before submitting new work. The SDK never
silently refreshes control state or replays browser input. Extensions without the
capability flag retain legacy behavior. Use one client per session.

Discovery, connection and input share the same deadline. Before sending a browser
action, the SDK reduces its engine timeout to fit the remaining budget with one
second reserved for cancellation and the response. An exhausted budget fails
before sending input.

`Browser.NewTab` with a URL and the raw CDP navigation/loading helpers hold one
request gate, original deadline and captured control binding across all stages.
Raw navigation matches its loader ID before accepting document readiness.

`WaitForFileChooser` and `WaitForDownload` take integer milliseconds from 1 to
120000; zero chooses 10000 ms. Their transport budget includes one second for
the response. A blocking waiter and its trigger need separate clients with the
same session. Download IDs are task-scoped opaque GUIDs; `DownloadPath` reports
`OBU_DOWNLOAD_PATH_UNAVAILABLE` because the extension API cannot reliably map
those GUIDs to local paths. Upload file paths remain supported.

# Open Browser Use Go SDK

Locator composition uses the same client and tab ID and retains native strict
matching:

```go
visible := true
chosen := tab.GetByRole("listitem").Filter(obu.FilterOptions{
    Has: tab.GetByText("Research", obu.TextOptions{Exact: true}),
    HasNot: tab.GetByText("Unavailable"), Visible: &visible,
}).And(tab.Locator(".eligible"))
err := chosen.GetByRole("button", obu.RoleOptions{Name: "Choose"}).Click()
either := tab.GetByRole("button", obu.RoleOptions{Name: "Save"}).Or(
    tab.GetByRole("button", obu.RoleOptions{Name: "Continue"}))
_ = either // If both match, an action still fails native strictness.
values, err := tab.GetByLabel("Materials").SelectOption(
    []any{"Manual", obu.Params{"value": "sticker"}})
_, _ = values, err
```

`Has`/`HasNot` are relative to each candidate element; supply a root builder or
the exact same frame prefix as the outer locator, which the SDK removes.
`And`/`Or` require equal frame prefixes. Nested operands cannot enter frames or
contain capture refs, and ref locators cannot be composed. `Visible` is a
`*bool`, so false differs from omission. Trees are deeply copied and bounded to
32 steps per chain, depth 8, and 128 total steps per action including a drag
target. Invalid builders return their error on the next action. Select strings
match value or label; descriptors accept only `value`, `label`, and nonnegative
`index`.

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

## Network request and response waits

Arm a listener, trigger the action, then call `Result`. The ready acknowledgement
installs the listener before the trigger, including on a cold engine. This
sequence uses the synchronous client without goroutines; collecting a pending
wait first would occupy the channel needed by the trigger. Both `Tab` and
`Tab.Playwright` expose the helpers.

```go
pending, err := tab.ExpectResponse(obu.NetworkWaitMatch{
    URL: "https://your-test-site.example/api/save", Method: "POST", Status: 200,
}, obu.NetworkWaitOptions{Timeout: 5 * time.Second})
if err != nil { return err }
if err = tab.GetByRole("button", obu.RoleOptions{Name: "Save", Exact: true}).Click(); err != nil {
    _ = pending.Cancel() // Preserve the original action error.
    return err
}
response, err := pending.Result()
if err != nil { _ = pending.Cancel(); return err }
fmt.Println(response.RequestID, response.Status)
```

`ExpectRequest` uses the same match without `Status`. Empty `URLMatch` defaults
to exact matching; `"contains"` selects a literal substring. URL is nonempty
and at most 4096 UTF-8 bytes. Optional method preserves case and is at most
128 bytes; empty means omitted. `Status` is response-only, 100–599, with zero
meaning omitted. There are no predicates or regex matches.

`NetworkWaitOptions.Timeout` must be a whole number of milliseconds from 1 to
120,000; zero selects the default. Arm defaults to 10 seconds, including
discovery, negotiation, connection and queue time. `Result` defaults to a
separate 120-second read budget, plus one second of RPC response allowance;
it never renews the network deadline. Retained terminal results/errors can be
collected repeatedly during the backend's 30-second TTL. `Cancel` removes the
record and defaults to a 10-second read/cleanup budget plus the same allowance.

The handle retains arm's submitted session, turn and epoch. Pause, end, detach,
ownership changes and restart invalidate it; `BeginTurn` never rebinds it, and
the SDK never re-arms or replays input. The extension must advertise
`getInfo.metadata.networkWaitVersion == 1`; older versions fail explicitly.
`NetworkWaitResult` contains bounded metadata, optional redirect linkage and
`Truncated`, not headers or bodies. Response means headers arrived, not that
the body completed; HTTP failures can match, network failures can time out.

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

`tab.SnapshotAI(obu.AISnapshotOptions{Boxes: true})` adds a non-nil
`capture.Geometry` (`*AISnapshotGeometry`). It contains `CoordinateSpace` equal
to `"frame-viewport-css"`, `Frames` and `Boxes`. Each `AISnapshotFrame` contains
`ID`, `ParentID`, `OwnerRef` and `Viewport` (`Width`, `Height`, `ScrollX`, `ScrollY`,
`DevicePixelRatio`). Root parent/owner pointers are nil; child frames name their
parent's iframe ref. Sparse `f1`–`f32` slots preserve native frame identity.
Each ref has one `AISnapshotRefBox{Ref, FrameID, Box}`; `AISnapshotBox` contains
`X`, `Y`, `Width`, `Height`.

Bounds are unclipped axis-aligned CSS viewport coordinates in the identified
frame, including transforms within that document. They are not projected through
ancestor iframe transforms into top-page coordinates, divided by DPR or clipped
to visible content. Negative positions and zero dimensions are valid. Layout
can change while a ref still identifies the original Element; these observations
do not guarantee clickability or its current position. YAML annotations use
`[box=x,y,width,height]`, and `MaxBytes` counts the full annotated UTF-8 YAML.
Only structured native metadata supplies refs and geometry. All frame reads
share the original action deadline; this is not an atomic multi-document layout
snapshot. `Boxes: false` omits the option and preserves the old shape/ nil geometry.
The SDK rejects malformed, missing or unsolicited geometry. Engine capability
`snapshotBoxes: 1` advertises support; unsupported requests fail without retrying
or falling back.

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
same session, but goroutine scheduling does not establish readiness. For uploads,
use `ExpectFileChooser` below before triggering the action. Download IDs are
task-scoped opaque GUIDs; `DownloadPath` reports
`OBU_DOWNLOAD_PATH_UNAVAILABLE` because the extension API cannot reliably map
those GUIDs to local paths. Upload file paths remain supported.

## Ready file chooser waits

`Tab.ExpectFileChooser` (also `Tab.Playwright.ExpectFileChooser`) returns only
when native interception is ready. Trigger the page action after that return,
then call `Result()` once to obtain `FileChooserResult{FileChooserID, IsMultiple}`.
The trigger may use this client or another connection with the same original
session, turn and epoch.

```go
func upload(tab *obu.Tab, files []string) error {
    pending, err := tab.ExpectFileChooser(obu.FileChooserWaitOptions{Timeout: 10 * time.Second})
    if err != nil { return err }
    defer func() { _ = pending.Cancel() }()
    if err := tab.GetByRole("button", obu.RoleOptions{Name: "Choose file", Exact: true}).Click(); err != nil {
        return err
    }
    chooser, err := pending.Result()
    if err != nil { return err }
    _, err = tab.Browser.Client.SetFileChooserFiles(chooser.FileChooserID, files)
    return err
}
```

Requires `metadata.fileChooserWaitVersion == 1`; unsupported extensions fail
explicitly. `Timeout` defaults to 10 seconds and accepts whole milliseconds
from 1 through 120000. Discovery, queue, attachment, triggering and collection
share the original deadline. `Result` accepts no timeout override, rejects
concurrent or repeated successful collection, and checks expiry before sending.
`WaiterID` and `RemainingMS` are informational; changing them cannot retarget or
extend the handle. End, Pause, navigation, ownership loss and detach invalidate it.

`Cancel()` retains the original scope even after `BeginTurn` and may be called
after expiry to retry cleanup. It has a separate 10-second transport budget,
without renewing the wait. It does not close a user dialog or undo an upload.
One pending or not-yet-cleaned wait per tab and 128 globally are allowed; failed
native cleanup retains capacity until actual cleanup succeeds.

## Ready navigation waits

`Tab.ExpectURL` and `Tab.ExpectLoadState` also exist on `Tab.Playwright`. They
return a ready `*NavigationWait`, so a synchronous client can trigger before
calling `Result` without goroutines or a second connection.

```go
func continueToNext(tab *obu.Tab) error {
    pending, err := tab.ExpectURL("**/complete", obu.NavigationWaitOptions{
        WaitUntil: "load", Timeout: 5 * time.Second,
    })
    if err != nil { return err }
    defer func() { _ = pending.Cancel() }()
    if err := tab.GetByRole("button", obu.RoleOptions{Name: "Continue", Exact: true}).Click(); err != nil {
        return err
    }
    return pending.Result()
}
```

`NavigationWaitOptions.WaitUntil` is URL-only: `load` (default),
`domcontentloaded`, `networkidle`, or `commit`. For load state use
`ExpectLoadState(NavigationWaitOptions{State: "domcontentloaded"})`; `State`
excludes `commit` and defaults to `load`. Current URL/load state may already
satisfy an observer during arming; a load-state observer alone does not identify
a future navigation. Native Playwright URL globs are accepted, capped at 4096
UTF-8 bytes. Existing `WaitForURL` remains available.

Requires extension `metadata.navigationWaitVersion == 1`; no fallback or input
replay occurs. `Timeout` zero defaults to 10 seconds for arming; nonzero values
must be whole milliseconds from 1 through 120000. The original budget covers
discovery, queue and attachment with one second added for transport. The handle
keeps its exact session/turn/epoch through `BeginTurn` and reconnects.

`Result(options ...NavigationWaitOptions) error` and `Cancel(...) error` accept
only `Timeout`, defaulting to 120 and 10 seconds respectively. These read budgets
cannot renew the observer deadline. Terminal outcomes remain for 30 seconds;
calling `Cancel` releases capacity. Pause, end, detach, ownership loss and worker
restart invalidate the handle. Do not hold this client's request gate in `Result`
while expecting another goroutine to trigger navigation through the same client.

### Page download readiness

`Tab.ExpectDownload` and `Tab.Playwright.ExpectDownload` return a `*DownloadWait`
after the browser listener is ready. A synchronous caller can trigger the page
action and then collect its download without starting a background goroutine:

```go
pending, err := tab.ExpectDownload(obu.DownloadWaitOptions{Timeout: 10 * time.Second})
if err != nil { return err }
defer pending.Cancel() // Retire the observer; this never cancels a file transfer.
if err = tab.GetByRole("button", obu.RoleOptions{Name: "Export"}).Click(); err != nil {
    return err
}
download, err := pending.Result()
if err != nil { return err }
fmt.Println(download.DownloadID)
```

The extension must advertise `downloadWaitVersion: 1`. Zero timeout selects 10
seconds; positive timeouts must be whole milliseconds from 1ms to 120s. The
original deadline includes discovery, queueing, readiness, the triggering action
and collection; neither navigation nor `Result` renews it. Public `WaiterID` and
`RemainingMS` are informational. A second connection may trigger after arm has
returned, provided it uses the same original session, turn and control epoch.

The first native download event is consumed once. Concurrent collection is
rejected immediately; a successfully cancelled observer cannot collect. `Cancel`
remains available after expiry with a separate 10-second cleanup response budget.
It only retires observation and an undelivered result; an actual browser download
may continue. A collected `*Download` retains its original scope, even if the
client starts a new turn. Page GUID `Path` and transfer `Cancel` still report the
documented unavailable/unsupported errors: readiness does not supply a guessed
path, initiate a substitute GET or cancel someone else's download.

### Active URL downloads

`Locator.DownloadMedia(MediaDownloadOptions{Filename: "image.png"})` downloads an
exact image, video, audio element or Canvas and returns the same `Download`.
It requires `mediaDownloadsVersion: 1`, preserves the original scope and uses
one deadline for source resolution and native start. HTTP(S) `currentSrc` starts
a new GET; data and same-origin Blob content is read in the original frame, and
Canvas produces PNG. Embedded content is limited to 8 MiB and Canvas to
16,777,216 pixels. MSE, live streams, `srcObject`, DRM, tainted Canvas and
restricted website mode remain unsupported. See the
[media contract](../../docs/references/media-downloads.md).

`Tab.DownloadURL` explicitly starts an HTTP(S) GET when the extension advertises
`directDownloadsVersion: 1`. The optional filename is a portable single basename
(up to 255 UTF-8 bytes), not a directory. Chrome uses `saveAs: false` and
`uniquify`; POST, custom headers, URL credentials and overwrite are not exposed.
Browser preferences or enterprise policy may still require confirmation UI.

```go
download, err := tab.DownloadURL("https://example.test/report.csv",
    obu.DownloadURLOptions{Filename: "report.csv", Timeout: 10 * time.Second})
if err != nil { return err }
path, err := download.Path(obu.DownloadOptions{Timeout: 30 * time.Second})
if err != nil { return err }
_ = path // Completed browser path; read/copy the file explicitly if needed.
// To explicitly stop an active download instead:
// err = download.Cancel(obu.DownloadOptions{Timeout: 10 * time.Second})
```

The typed `Download` exposes `DownloadID`; `Path` returns `(string, error)` and
`Cancel` returns `error`. The SDK does not verify file bytes. Zero `Timeout` uses
10 seconds; nonzero timeouts must be whole milliseconds from 1ms to 120s. Setup
consumes that original budget, with one second reserved for the response. A path
timeout leaves the download running; explicitly retry that same handle or cancel
it. A start timeout can mean the download already began; no automatic GET replay
occurs.

Handles retain their original session, turn and epoch. End, pause or lost
ownership may invalidate a handle; `BeginTurn` does not rebind it.
`Tab.WaitForDownload(...DownloadOptions)` gives the same bound handle for observed
page downloads, whose GUID path/cancel remains unsupported. That observer does
not promise cross-connection readiness. Existing Client methods retain raw JSON
and current-invocation scope semantics; use the typed handle for later operations,
or provide the original scope explicitly through `Request`.

### PDF and MHTML page exports

`Tab.ExportPage(format, ...ExportPageOptions)`, `ExportPDF` and `ExportMHTML`
return `(PageExport, error)` when the extension advertises `pageExportVersion: 1`.
`PageExport` contains `Format`, `MimeType`, `Encoding` (`"base64"`), `Data` and
`ByteLength`. No local file is written automatically.

```go
background := true
zeroMargin := 0.0
exported, err := tab.ExportPDF(obu.ExportPageOptions{
    MaxBytes: 8 * 1024 * 1024, Timeout: 30 * time.Second,
    PDF: &obu.PDFOptions{PrintBackground: &background, MarginTop: &zeroMargin},
})
if err != nil { return err }
content, err := base64.StdEncoding.DecodeString(exported.Data)
if err != nil { return err }
_ = content // Save explicitly if needed.
```

Zero `MaxBytes` selects 16 MiB; positive values cannot exceed 16 MiB. Zero
`Timeout` selects 10 seconds; nonzero values must be whole milliseconds from
1ms to 120s. The same deadline covers request queueing, connection, discovery
and browser setup, with one additional second for the reply. The request keeps
its submitted control scope and is never replayed after a failure.

Only PDF accepts `PDF *PDFOptions`. Its optional pointer fields preserve explicit
false/zero values: boolean `Landscape`, `PrintBackground`, `PreferCSSPageSize`,
`GenerateTaggedPDF`, `GenerateDocumentOutline`; `Scale` from 0.1 to 2;
`PaperWidth`/`PaperHeight` in inches greater than 0 and at most 200;
`MarginTop`/`MarginBottom`/`MarginLeft`/`MarginRight` from 0 to 200 inches; and
`PageRanges` of at most 1024 ASCII digits, commas, hyphens and spaces. Nil values
use browser defaults. `ExportPageParams` exposes this validation for finite RPC
callers; `ValidatePageExport` checks a JSON-decoded response's five fields,
matching format/MIME, canonical Base64 and decoded size against the caller cap.
Native export may still fail for unsupported pages, browser conditions or an
expired control scope.

### Clipboard

`tab.Clipboard().ReadText(...)` returns `(string, error)`; `Read(...)` returns
`([]ClipboardItem, error)`. `WriteText(text, ...)` and `Write(items, ...)` return
`error`. Client methods retain wire-envelope results. All four require
`metadata.clipboardVersion == 1`, including explicit-epoch requests.
`ClipboardOptions{MaxBytes, Timeout}` uses zero for defaults: 16 MiB and 10 seconds.
Nonzero timeout must be whole milliseconds from 1ms through 120s. At most one
options value is accepted. `ClipboardEntry.Text` and `.Base64` are pointers to
distinguish an empty string from an absent representation.

```go
text, err := tab.Clipboard().ReadText(obu.ClipboardOptions{
    MaxBytes: 65536, Timeout: 5 * time.Second,
})
if err != nil { return err }
err = tab.Clipboard().WriteText(text)
```

`ClipboardParams` validates finite RPC options and copies payloads;
`ValidateClipboardResult` returns the validated wire envelope. The SDK also
rejects malformed UTF-8 and unpaired surrogate escapes before Go's JSON decoder
can replace them silently.

Only `text/plain` and `text/html` strings and canonical Base64 `image/png` are
supported. Rich values preserve wire keys `entries`, `mime_type`, `text` or
`base64`, and optional `presentation_style` (`unspecified`, `inline`, `attachment`).
There is at most one item with 1–3 unique representations. `write([])` is a
no-op, not a clipboard clear; an empty text string is valid. Reads return only
these three supported representations, and an empty clipboard may return `[]`.
Unknown fields, duplicate MIME types and mixed text/Base64 payloads are rejected.

The byte cap counts actual UTF-8 text and decoded PNG bytes in aggregate, defaults
to 16 MiB and cannot exceed 16 MiB. Normalized JSON bodies also have a 48 MiB
limit, including the Go host’s HTML escaping; excess encoded data rejects with
OBU_CLIPBOARD_LIMIT before a write is submitted. PNG preflight checks signature, IHDR and a
16,777,216-pixel limit; it is not a complete image decoder. The trusted browser
adapter must finish decoding. Results are validated again before returning.
HTML may be sanitized and PNG re-encoded by the browser, so byte-for-byte
round trips are not promised. The host's separate 64 MiB JSON limit also applies.

These operations access the system's shared clipboard, not a per-tab clipboard.
They are disabled by restricted website policies. Each invocation retains its
original session/turn/epoch; discovery and queueing consume its total deadline,
with one extra second for the reply. Writes are never automatically retried.
A timeout or Pause cannot guarantee reversal of a write already submitted to the
native clipboard. No clipboard contents are saved to disk by these helpers.

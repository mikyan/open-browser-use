# File transfers and scoped browser events

File chooser and download waits default to 10000 ms and accept integer deadlines
from 1 through 120000 ms. Their setup and event wait share that budget. Register
the wait before triggering the corresponding page action. The SDK transport must
allow the browser deadline plus response time; it must not silently replay a
timed-out upload or download trigger.

## File chooser

When current page evidence identifies the actual file input, use the formal
[locator `setInputFiles` action](locator-file-upload.md), including for hidden
inputs. It shares the same exact-node submission registry and directory/clear
semantics below, without opening a chooser. Keep the chooser flow for page
workflows where an authorized click exposes the input through a chooser event.

`waitForFileChooser({tabId})` establishes the same Playwright CRX attachment used
by browser actions, then enables native chooser interception. A following
same-session action waits for that setup acknowledgement before input. This makes
the public `Promise.all([waitForFileChooser(...), locator.click()])` pattern work
without a caller sleep or a cold raw-to-engine migration tearing down the wait.
Authorization does not wait on its own setup barrier.

The resulting opaque chooser ID records the actual tab, control epoch,
attachment, child debugger session, frame ID, and backend node ID. Root and known
OOPIF sessions are intercepted; newly attached child frames join an active wait.
`setFileChooserFiles` rechecks ownership and routes the original node ID to its
original native session. Navigation, child detachment, or loss of tab control
invalidates the chooser. A stale wait cannot disable a successor attachment's
interception. Chooser IDs and concurrent waits are bounded at 128.

Nonempty `files` are passed to CDP `DOM.setFileInputFiles`. An explicit empty list
clears the selected input: the extension resolves that exact native node and sets
its `value` to the empty string, then dispatches application `input` and `change`
notifications. Those notifications are programmatic, not trusted user input.
Chrome's native empty file list alone behaves like cancelling selection and can
retain previously selected files, so it is not used to claim a successful clear.

A delivered chooser permits one submission. The backend claims it before any
native preparation or write can yield; a concurrent call fails with
`OBU_FILE_CHOOSER_CONSUMED`, or an unknown-chooser error if it has already retired.
Invalid arguments rejected before that claim may be corrected. Once claimed,
failure does not restore the chooser: a lost or rejected native response cannot
prove that selection had no side effects. The caller must inspect the page and
explicitly open a new chooser when appropriate; the backend never retries it.

Before writing, document invalidation prevents use of the old node. After a
successful native write, an input/change handler may legitimately navigate or
remove its iframe. That alone does not turn the completed submission into a
failure. Success still requires the original live control scope, attachment,
unrevoked admission and actual tab ownership. Pause, turn end or ownership loss
while awaiting the response prevents a success reply, but does not undo a write
already sent. Remote-object cleanup for clearing targets only the original
surviving attachment and child session.

### Directory selection

`getInfo.metadata.fileChooserDirectoryVersion === 1` advertises completion-aware
directory setting. For a `webkitdirectory` input, pass exactly one absolute
directory path. Multiple paths are rejected even when the input has `multiple`:
Chromium otherwise enumerates only the first path. `files: []` still means the
explicit clear described above; it is different from selecting an empty directory.

The native [Chromium 156 file-input implementation](https://raw.githubusercontent.com/chromium/chromium/156.0.8078.4/third_party/blink/renderer/core/html/forms/file_input_type.cc)
starts directory enumeration separately from the
[CDP acknowledgement](https://raw.githubusercontent.com/chromium/chromium/156.0.8078.4/third_party/blink/renderer/core/inspector/inspector_dom_agent.cc).
The backend therefore requires both that acknowledgement and a trusted `input`
completion on the original file input, observed in a named isolated world.
Synthetic events, `cancel`, unavailable execution contexts and timeouts cannot
satisfy completion. A success means the browser has populated that input's
`FileList`; it does not mean the website has finished uploading the files to its
server. Relative paths are Chromium's `webkitRelativePath`, including the chosen
directory basename. Empty subdirectories do not create files, and the browser's
own filesystem filtering still applies.

The setter has its own optional `timeoutMs`, integer 1–120000, default 10000.
It starts when the setter is admitted and includes preparation, native setting
and completion; it never renews the earlier chooser wait. CLI/MCP can include it
in `setFileChooserFiles` parameters. An SDK transport must allow that deadline
plus reply time. Timing out does not abort an enumeration already sent.

JS accepts `client.setFileChooserFiles(id, paths, timeoutMs)`, Python accepts
`client.set_file_chooser_files(id, paths, timeout_ms=...)`, and Go adds
`client.SetFileChooserFilesWithTimeout(id, paths, timeoutMs)` (zero selects 10000).
Calls that omit this new SDK option retain their prior wire and transport budget;
explicit options allow another 1000 ms for the response without renewing the
backend deadline. Go's original two-argument method remains unchanged.

Each exact input has a reservation shared by directory setting, ordinary file
setting and clear. A renderer-side WeakMap guard survives loss of the extension
worker or debugger attachment while the original document survives. Unknown
directory work keeps its guard until a trusted terminal event, preventing a late
selection from being mistaken for the next submission. A busy input is explicitly
rejected; no upload is automatically replayed. Navigation replaces the original
document rather than transferring its node or completion to a new page.

The completion event has no CDP operation ID. Concurrent manual selection on
that same input is not distinguishable from the agent's selection. A page that
prevents the original completion listener from running can produce an explicit
timeout even if its FileList changed. These boundaries do not authorize an ACK-only
success or a fabricated selection event.

**Current browser limitation:** fixed Chromium 156
[rejects directory enumeration](https://raw.githubusercontent.com/chromium/chromium/156.0.8078.4/content/browser/web_contents/web_contents_impl.cc)
when the WebContents is hidden or is not its window's selected tab. The new
completion handling reports the resulting cancel honestly; it does not make
directory selection work in the normal inactive task tab, activate that tab,
or move it into another window. For a task that needs directory selection,
explicitly create its page with `browser.newTab({backgroundWindow: true})`
before navigating. This [background-window route](background-windows.md)
creates a separate normal window with its own selected tab, without focusing it.
Minimizing that window or selecting another tab can still cause cancellation.
Ordinary files do not use this browser enumeration path. The directory capability
version advertises the completion contract; `backgroundWindowVersion` separately
advertises the creation route. Neither removes Chromium's visibility restriction.

### Explicit readiness across connections

`getInfo.metadata.fileChooserWaitVersion === 1` advertises these three methods:

| Method | Extra parameters alongside the original control scope and `tabId` | Result |
| --- | --- | --- |
| `armFileChooserWait` | Optional `timeoutMs`, integer 1–120000, default 10000 | `{waiterId, remainingMs}` |
| `collectFileChooserWait` | `waiterId` | `{fileChooserId, isMultiple}` |
| `cancelFileChooserWait` | `waiterId` | `{}` |

All calls retain `session_id`, `turn_id`, positive `control_epoch` and `tabId`.
Unknown options are rejected. Arm acknowledges only after root and all known
OOPIF interception has succeeded, the listener is installed and the original
scope is rechecked. Another connection can then click immediately under that
same scope. Newly attached OOPIFs join interception, and actions wait for their
actual readiness too. Existing `waitForFileChooser` shares the same registry
and remains available for the same-connection concurrent JS pattern.

JS `tab.expectFileChooser({timeoutMs})`, Python
`tab.expect_file_chooser(timeout_ms=...)` and Go
`tab.ExpectFileChooser(FileChooserWaitOptions{Timeout: ...})` return a handle
with `result`/`Result` and `cancel`/`Cancel`. Each also exists under `playwright`.
CLI and MCP use their generic `call` entry point with these RPCs. Keep the full
scope and waiter ID from the arm operation when using independent processes;
do not begin a new turn between arm and collect. File setting remains the
existing `setFileChooserFiles` operation with its own live ownership checks.

The initial deadline includes client discovery/queueing, attachment, readiness,
the triggering action, event validation and collection. Collect takes no new
`timeoutMs`; an SDK checks the fixed local deadline again after its queue and
connection. The extra one-second transport response margin cannot authorize
an expired collect. `remainingMs` is informational, not a renewable budget.
Only one collect may consume the first matched native event. Cancel revokes an
uncollected chooser; an already delivered chooser keeps its normal lifecycle.

Unknown or foreign cancel handles have no effect and reveal no state. Normal
control admission still applies: an invalid epoch or unowned tab is rejected
regardless of whether the supplied handle exists. Cancelling
a known handle after its wait expires can retry cleanup, using the original
scope and a separate transport budget of at most 10 seconds. This does not renew
the wait. Actual pending or failed native interception cleanup retains the record
and its capacity. There is one outstanding or uncleaned waiter per tab, with a
global limit of 128 shared by both APIs. A successor cannot be disabled by old
cleanup. Navigation, attachment/child loss, transfer, end, Pause and worker/host
replacement invalidate original handles. Neither timeout nor cancellation
replays a click, uploads files or closes the user's native dialog.

## Page-triggered downloads

`waitForDownload({tabId})` observes native `Page.downloadWillBegin` from the owned
tab after registration. Its opaque `downloadId` is that event's GUID. Progress
must have the same GUID and native source. Records carry the session, epoch, and
attachment; end/detach cancels waiters and retires their records. Progress is
revalidated against live tab membership before notification; regrouping invalidates
old transfer state even while its debugger attachment still exists. A later wait does
not return an old cached download. At most 128 records and 128 waits are retained;
completed records may be evicted, and full active capacity fails explicitly.

### Explicit page download readiness

`getInfo.metadata.downloadWaitVersion === 1` advertises an explicit observer:

| Method | Extra parameters alongside original scope and `tabId` | Result |
| --- | --- | --- |
| `armDownloadWait` | Optional integer `timeoutMs`, 1–120000, default 10000 | `{waiterId, remainingMs}` |
| `collectDownloadWait` | `waiterId` | `{downloadId}` |
| `cancelDownloadWait` | `waiterId` | `{}` |

All requests retain `session_id`, `turn_id`, positive `control_epoch` and `tabId`;
unknown fields are rejected. Arm reserves capacity before bootstrap, establishes
the same CRX attachment used by actions, enables Page events on the root and
known child sessions, and rechecks scope before acknowledging readiness. A
second connection may trigger immediately after that acknowledgement using the
same original scope. New child sessions join the setup barrier. The legacy
`waitForDownload` uses the same observer and preserves its `{downloadId}` result.

JS `tab.expectDownload`, Python `tab.expect_download` and Go `Tab.ExpectDownload`
also exist under `playwright`. Their wait handle's `result`/`Result` returns the
existing `Download` object bound to the original control scope. CLI/MCP use the
three generic `call` methods. One outstanding or uncleaned observer per tab and
128 in total are shared by old and new APIs. Each waiter is consumed at most
once; concurrent collection is an explicit conflict. The first native event
claims its candidate synchronously, before asynchronous ownership validation,
so a later event with faster validation cannot win instead.

Discovery, queues, attachment, setup, triggering, event validation and collection
share the original deadline. Collect accepts no new timeout; SDKs recheck the
original deadline after queueing and connection. The reply margin cannot
authorize an expired request. Legal page navigation or redirects retain this
tab/attachment observer without extending its deadline. A download GUID is not
a DOM node: a proven candidate is not discarded solely because its document or
child frame subsequently disappears. New events from a detached child are not
accepted. Tab attachment loss, ownership transfer, end, Pause and worker/host
replacement invalidate the original observer and its uncollected result.

`cancelDownloadWait` cancels **observation only**. It revokes an undelivered
result but does not stop a started browser transfer, remove a file, replay a click
or initiate a substitute GET. A delivered download retains its existing
lifecycle. Cancel remains available after expiry with the original scope and a
separate cleanup response budget of at most 10 seconds. Unknown/foreign handles
have no effect; normal tab/epoch admission applies regardless of handle existence.
Pending native setup remains accounted for until it actually settles, and shared
engine Page events are never disabled just to cancel an observer.

This readiness protocol does not provide a GUID-to-path mechanism or transfer
cancellation for page-triggered downloads. Those distinct limitations follow.

The global [`chrome.downloads` API](https://developer.chrome.com/docs/extensions/reference/api/downloads)
exposes numeric IDs and file paths but no corresponding native GUID or source tab
identity. The tested extension debugger exposes the tab-scoped Page events but
rejects `Browser.setDownloadBehavior`. The implementation therefore does not
join those sources by URL, timing, filename, or guessed numeric ID. Simultaneous
downloads of the same URL in different sessions remain distinct.

`downloadPath` first verifies the GUID's ownership, then returns the explicit
`OBU_DOWNLOAD_PATH_UNAVAILABLE` error. A foreign or unknown GUID is rejected.
It does not return a plausible path, a successful `null`, or another tab's file.
The parameter remains available in SDKs for compatibility; reliable local path
delivery still needs a browser-supported, provable GUID-to-path mechanism.

Reading the profile's History database is not a supported alternative. A live
Windows Chromium 156 probe using normal read-only SQLite locking failed every
attempt with a locked database; completion also does not guarantee a committed
history row. The extension does not bypass locks, copy a changing database, or
use the CRX engine's synthetic download-directory path.

## Explicit URL downloads

`getInfo.metadata.directDownloadsVersion=1` advertises `downloadURL` and
`cancelDownload`. This is a separate GET operation, suitable when the caller has
an authorized, directly downloadable HTTP(S) URL. It does not capture a previous
page click, reproduce a POST, or resolve a Page GUID. Browser cookies accompany
the new request; callers must account for expiring or single-use URLs.

| Method | Request, in addition to the original control scope | Result |
| --- | --- | --- |
| `downloadURL` | `tabId`, `url`, optional `filename`, `timeoutMs` | `{downloadId}` |
| `downloadPath` | `downloadId`, `timeoutMs` | `{path}` after completion |
| `cancelDownload` | `downloadId`, `timeoutMs` | `{cancelled:true}` |

The original `session_id`, `turn_id`, positive `control_epoch`, tab and attachment
remain bound to each opaque handle. Only the numeric ID returned by that exact
`chrome.downloads.download` invocation is queried or cancelled. Identical URLs,
filenames and simultaneous user downloads cannot acquire its ownership. The
public handle is not a numeric browser ID, and it is not an authentication secret.
At most 128 direct records are retained. Completion does not automatically retire
them; cancel or control cleanup releases records, and full capacity fails explicitly.

Inputs are finite: HTTP(S) URL at most 8192 UTF-8 bytes, without credentials or
control characters, and an optional single portable basename of at most 255
UTF-8 bytes. Native options are fixed to `saveAs:false` and
`conflictAction:uniquify`. There is no overwrite, open/show, custom-header, POST,
or accept-danger option. Browser preferences, enterprise policy or target-path
failures may still require confirmation UI; this is not a universal no-UI promise.

The start call and each subsequent call have their own 1–120000 ms deadline,
defaulting to 10000 ms. A start timeout prevents a late ID from being published
and attempts cancellation of that exact download once native creation resolves.
Failed cleanup remains tracked for retry and cannot count as successful Pause. A **path**
timeout only stops observing; retry `path` on the same handle or explicitly
cancel it. Neither transport nor SDK replays a timed-out GET. Completion before
the start acknowledgement is recovered by querying the returned numeric ID.
Chrome may wait for headers and enough initial response bytes for MIME sniffing
before supplying that ID. While the native start remains unresolved, cancellation
cannot yet address it; end may keep waiting and Pause may fail its cleanup deadline.

`downloadPath` returns Chrome's recorded absolute filename after successful,
safe completion. Interrupted, blocked, missing or invalid records fail explicitly.
The filename is metadata, not a file-content check: Chrome's `exists` field can
lag actual deletion, and another process can modify a completed file. Read bytes
through the caller's local file facilities when content verification is needed.

Live-worker end, Pause, detach and ownership loss invalidate handles and attempt
to cancel the extension's pending direct downloads. Actual late native creation/cleanup
must remain tracked until it settles; a response timeout is not proof of cleanup.
Cancellation does not delete an already completed file or undo received bytes.
Worker replacement loses these in-memory bindings and rejects old handles, but
cannot guarantee cancellation of a browser transfer whose ID was lost. Page-owned
downloads and the page's other network activity can continue after Pause.

The official [downloads API](https://developer.chrome.com/docs/extensions/reference/api/downloads)
defines ID, path and existence metadata. Browser confirmation behavior also
depends on Chromium's [download target selection](https://github.com/chromium/chromium/blob/main/chrome/browser/download/download_target_determiner.cc).

## Notification scope

`onDownloadChange` and `onCDPEvent` include top-level `session_id`, `turn_id`,
`control_epoch`, and `tabId`. Raw CDP events retain their original nested
`{source, method, params}`. The backend only attaches metadata for a current native
attachment whose session still owns the tab's Chrome group. Initialization events
without proven ownership are not forwarded. The native host must route scoped
events only to clients explicitly associated with that session; an extension
metadata check alone is not cross-client isolation.

Opening a socket and registering a local `onNotification` callback do not
associate that connection with a host session. A separate notification monitor
must first await a public scoped request such as `getTabs()` before another
connection triggers a download. Notifications are live events, not a history
query; subscribing later does not recover an earlier completion.

If a user regroups a still-attached tab and another session legitimately acquires
it, `attach` or `browserAction` releases the exact previous Page before creating a
new one. Raw CDP requires an explicit new `attach` in that case. This prevents
retained transfer/diagnostic state from crossing the owner boundary.

## Verification and remaining scope

`node --test apps/chrome-extension/transfers.test.mjs` covers identical-URL
cross-session downloads, stale history, chooser routing/clearing, end/detach,
navigation, cleanup identity, setup ordering, and attachment ownership transfer.
An isolated headed fixture verified actual UTF-8 file bytes in root and OOPIF
inputs, an empty file list after clearing, distinct simultaneous download GUIDs,
downloaded fixture bytes, explicit path errors, and an unchanged foreground tab.
The formal SDK/native-host fixture also exercises the public concurrent chooser
pattern as the first engine action, with root and OOPIF uploads and clearing.
The current direct-download slice passed eight focused cases and all 47 full
Windows Chromium 156 cases (`run-1D7lpX` and `run-toIMbt`). JS/Python/Go/CLI/MCP
read the actual returned file, compare UTF-8 bytes and SHA-256 with the server,
and prove cancellation before finalization. Same-URL tasks receive distinct files;
an unowned native download remains in progress after rejected path/cancel calls.
Late native IDs, path-timeout retry, end/detach/transfer, and real Pause are covered.
The fixture sends a 4096-byte prefix and gates one suffix byte, preserving native
MIME sniffing while proving that a cancelled response was still incomplete.
The explicit readiness protocol passed the focused `run-bE4e26` **9/9** and full
headed `run-3OY97j` **83/83**. JS/Python/Go/CLI/MCP each use two independent
connections with the same scope across cold root, existing OOPIF and OOPIF
created after arm. Their 30 original upload/clear POST bodies retain actual
UTF-8/binary bytes, sizes and SHA-256. Lifecycle cases cover original expiry,
duplicate arm, conflicting collects, foreign scope, navigation, ownership loss,
cancel before collection and real Pause/worker replacement. The original
concurrent JS pattern remains in the suite. Native events and separate renderer
process IDs establish OOPIF coverage; success is not inferred from RPC replies.

Failed `run-cAgqZx` exposed browser timer receiver binding; `run-16fvkO` and the
smaller `run-Yzz3ni` exposed a new OOPIF committing before its parent-side swap.
Both defects have regression tests and the failed evidence remains unchanged.
The successful run still uses the documented loopback native Port adapter,
not OS native registration. Scope evidence combines retained caller scope and
frozen caller code, not a complete wire transcript; some negative cases retain
the assertion kind. Focus coverage runs from observer readiness to the final
snapshot. This slice does not establish Codex upload parity or complete P10.

Page download readiness passed the final Go 1.26.9 focused `run-lMFHcB`
**9/9** and full headed `run-k3mDiy` **89/89**. All five entry points use two
independent connections with cold root, existing OOPIF and OOPIF created after
arm. Evidence retains actual Page GUID/source, scoped completion notifications
and separate renderer processes. The five entry-point and lifecycle fixtures
produce 24 original responses and files (98,376 bytes), including 22 collected
GUIDs. Cancelling an uncollected observer lets its actual transfer finish before
a new trigger; the subsequent wait returns a distinct GUID. Fixed expiry,
legal navigation, concurrent collection, foreign scope, ownership loss and
Pause/worker replacement are also covered.

The first focused `run-c0ip6L` **7/9** exposed an unassociated notification
monitor; a public read-only `getTabs` acknowledgement now precedes triggers,
without backfilling events or weakening the notification requirement. The first
full `run-Ni9Djz` **87/89** failed both popup cases because the root window was
inactive and was ultimately recorded as minimized. Its ledger contains no
unexpected focus events, but lacks initial window state, so the cause remains
unknown. Final runs retain read-only initial/final window snapshots and keep the
same focus rules; their initial root windows were normal and focused. All failed
evidence is retained. The final host also uses the upstream Windows pipe-close
fix described in [local IPC transport](local-ipc-transport.md).

File evidence compares original response bytes and server nonces with a private
test directory delta. It does not add a public Page GUID-to-path mapping or
actual transfer cancellation. The native Port adapter and observer coverage
limits above still apply; full P10 and Codex parity are not established.

Text and rich clipboard helpers now have a separate [contract and isolated
acceptance](clipboard.md). A fresh browser profile does not isolate the operating
system clipboard, so this headed suite does not read or overwrite it. PDF/MHTML
exports also have their own [contract and native acceptance](page-exports.md).
Exact image-locator HTTP(S) downloads have a separate [media contract](media-downloads.md).
Directory upload, page-triggered download paths, broader media and specialized document
exports, browser policy/prompt behavior, and direct locator upload still need
broader product and end-to-end coverage; these slices do not claim complete P10
parity.

Later default `run-k5giEj` retained a JS dynamic-OOPIF download timeout: the
file endpoint saw no request and the passive download trace saw no event. Its
original record lacks click acknowledgements and failure DOM evidence, so the
cause remains unknown. The opt-in download diagnostic described in the runner
README adds bounded native input/setup timing and original call phases, plus
one original-scope DOM pass on failure. `run-avWmSX` completed the three layouts
and raw-navigation control; the earlier fault did not recur. This instrumentation
is not a production fix, and its failure DOM branch has not yet observed that
real fault. The original action limits and fixture HTML remain unchanged.

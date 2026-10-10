# File transfers and scoped browser events

File chooser and download waits default to 10000 ms and accept integer deadlines
from 1 through 120000 ms. Their setup and event wait share that budget. Register
the wait before triggering the corresponding page action. The SDK transport must
allow the browser deadline plus response time; it must not silently replay a
timed-out upload or download trigger.

## File chooser

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

## Page-triggered downloads

`waitForDownload({tabId})` observes native `Page.downloadWillBegin` from the owned
tab after registration. Its opaque `downloadId` is that event's GUID. Progress
must have the same GUID and native source. Records carry the session, epoch, and
attachment; end/detach cancels waiters and retires their records. Progress is
revalidated against live tab membership before notification; regrouping invalidates
old transfer state even while its debugger attachment still exists. A later wait does
not return an old cached download. At most 128 records and 128 waits are retained;
completed records may be evicted, and full active capacity fails explicitly.

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
Separate Python/Go clients or separate transport connections do not yet have a
ready/arm handshake: starting a waiting thread or goroutine does not prove its
request reaches the extension before another connection clicks. Cross-connection
ordering remains unverified and needs an explicit readiness protocol or direct
locator upload before that pattern can be considered reliable.

Text and rich clipboard helpers now have a separate [contract and isolated
acceptance](clipboard.md). A fresh browser profile does not isolate the operating
system clipboard, so this headed suite does not read or overwrite it. PDF/MHTML
exports also have their own [contract and native acceptance](page-exports.md).
Directory upload, page-triggered download paths, media and specialized document
exports, browser policy/prompt behavior, and direct locator upload still need
broader product and end-to-end coverage; these slices do not claim complete P10
parity.

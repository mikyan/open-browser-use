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

## Download attribution and the path limitation

`waitForDownload({tabId})` observes native `Page.downloadWillBegin` from the owned
tab after registration. Its opaque `downloadId` is that event's GUID. Progress
must have the same GUID and native source. Records carry the session, epoch, and
attachment; end/detach cancels waiters and retires their records. A later wait does
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
Separate Python/Go clients or separate transport connections do not yet have a
ready/arm handshake: starting a waiting thread or goroutine does not prove its
request reaches the extension before another connection clicks. Cross-connection
ordering remains unverified and needs an explicit readiness protocol or direct
locator upload before that pattern can be considered reliable.

Text and rich clipboard helpers remain a separate audit. A fresh browser profile
does not isolate the operating system clipboard, so these tests do not read or
overwrite the user's clipboard. Directory upload, download cancellation/failure
matrices, exported media/documents, and direct locator upload still need broader
product and end-to-end coverage; this slice does not claim complete P10 parity.

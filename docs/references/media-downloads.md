# Media downloads

`getInfo.metadata.mediaDownloadsVersion=1` advertises `downloadMedia`. The initial
implementation resolves one exact HTML `<img>` and starts a new HTTP(S) GET from
the browser's selected `currentSrc`. It returns the same scoped `Download` used
by [explicit URL downloads](file-transfers.md): `path()` waits for the exact
native ID's completed file and `cancel()` cancels that ID.

```js
const download = await tab.getByAltText("Product photo").downloadMedia({
  filename: "photo.png", timeoutMs: 10000
});
const filename = await download.path();
```

Python uses `locator.download_media(filename="photo.png", timeout_ms=10000)`;
Go uses `locator.DownloadMedia(obu.MediaDownloadOptions{Filename: "photo.png"})`.
CLI `call` and MCP's `call` tool accept the same single RPC:

```json
{
  "method": "downloadMedia",
  "params": {
    "session_id": "task", "turn_id": "original-turn", "control_epoch": 1,
    "tabId": 7, "locator": [{"kind": "css", "selector": "img.product"}],
    "filename": "photo.png", "timeoutMs": 10000
  }
}
```

The locator is the existing finite descriptor, including frame, open shadow,
strict matching and capture references. There is no descendant-media guess,
scroll, click, hidden anchor, `src` fallback, or arbitrary page expression.
Missing elements use the pinned native locator polling loop within the original
deadline; once an element is selected, changes invalidate that source rather
than selecting a replacement. Empty sources, non-image elements, credentials in
URLs, data/blob URLs and non-HTTP(S) URLs fail explicitly in this first slice.
The method is unavailable under restricted website-access policy.

## Source and lifecycle

Source reads use the actual selected Frame's utility world and native
`HTMLImageElement.currentSrc` getter. The native selector query and first getter
run in one renderer call; a private handle retains the exact element and
Document. A final read checks connection, document/context, frame, capture and
selected URL. Page-world prototype and instance getter overrides do not supply
the URL. Custom/main-world selector engines are rejected on this route.

The unresolved source reserves shared download capacity before any await. The
single 1–120000 ms budget (default 10000) covers admission, attachment, action
queue, locator resolution, source checks and native download start. Three SDKs
and CLI/MCP include discovery and connection in their original request budget,
and preserve the original session, turn and epoch in the resulting handle.

Source work and exact native handle release are tracked through their actual
settlement, even after the caller's deadline expires. Source cleanup must finish
before detaching its original browser attachment. A failed exact-handle release
retains capacity and fails cleanup; explicit cleanup retries that handle without
repeating source resolution or GET. A late native download ID is cancelled by
that ID and is never returned as a new successful handle.

Each native source call captures its original tab, child session and execution
context before sending. A matching native context-destruction event, real tab
removal or `target_closed` confirms that context's objects no longer exist;
local Playwright cancellation and ordinary debugger detachment do not. These
leases survive late responses and failed releases, and are removed only after
the actual call settles and every returned object is released or proven gone.
Reused numeric context IDs receive a new lease. No active leases means no
lifetime listeners or retained context history.

Navigation, document changes, ownership loss, end and Pause invalidate bound
media operations. A worker restart loses the in-memory handles; as with explicit
URL downloads it cannot guarantee cancelling a browser transfer whose ID was
lost. A completed file is not deleted by cancellation.

## What the result represents

The URL is an authorized source snapshot. The final renderer read and the later
Chrome download are different process operations, so they are not atomic. The
new GET may return different bytes from the already displayed image. It does not
reproduce a POST, application Authorization headers, Referer or partitioned
authentication context; browser download cookies alone do not establish those
equivalences. Native download preferences and policy can still require UI.

Blob/data bytes in their original frame, Canvas encoding, video/audio progressive
resources and content returns remain separate unfinished portions of P10. MSE,
live streams, DRM and tainted canvases are not represented as successful image
downloads. This slice does not claim full media or Browser Use parity.

## Local acceptance

The same frozen production build passed all eight media cases in both pinned
Headless and headed Chromium: five public callers, capture references,
source mutation/turn end, and document-navigation cleanup. The Headless run
`run-FDmPto` passed 9/9 including the mandatory raw-navigation prerequisite.
The headed run `run-XLWzut` remains **8/9 overall** because that prerequisite's
known first-frame timeout persists. This is not a complete Browser Use suite or
a repair for [headed startup](headed-browser-startup.md).

Each run retained 17 files independently decoded as the expected two-pixel PNG,
17 exact download GETs, five frame/shadow reference sources and two separately
owned same-URL downloads. Stale/foreign references and handles fail. The
continuous observer retained zero tab activation and window-focus events during
the measured actions, with the sentinel unchanged; process startup and teardown
fall outside that interval.

Lifecycle tests deliberately hold delivery **after** a real native source call
has settled. They verify that a source change, node replacement and turn end
release the original object, and that navigation provides matching native
context-destruction evidence before a late object is discarded. Turn end waits
for held delivery; none of those cases starts a download GET. Exact-tab native
navigation and a fixed scripting read are test-only mutations/observations,
declared in the run's source identity. They do not claim an unresolved native
command or replace production source resolution.

The earlier `run-cAYlXr` remains failed at 6/9: removing an image from `picture`
caused a renderer fallback-image request, a deliberately held source prevented
a queued test navigation, and observing via the SDK after end reattached and
enabled focus emulation. The fixtures now retain that exact renderer request,
navigate independently of the held queue and read evidence without reattaching.
No failed historical result was converted to a pass. Full local CI also passed;
the packaged build matches both final browser runs and contains no test hooks.

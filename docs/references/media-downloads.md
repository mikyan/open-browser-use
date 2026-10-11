# Media downloads

`getInfo.metadata.mediaDownloadsVersion=1` advertises `downloadMedia`. It resolves
one exact HTML `<img>`, `<video>`, `<audio>` or `<canvas>`. HTTP(S) media starts a
new GET from the browser's selected `currentSrc`; data and same-origin Blob
sources are read in their original frame, and Canvas produces a PNG snapshot.
It returns the same scoped `Download` used
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
than selecting a replacement. Empty sources, other element types, credentials in
URLs and unsupported schemes fail explicitly. There is no playback, media
seeking, stream recording, MSE assembly or DRM decryption. `srcObject` providers
are unsupported. A revoked Blob, cross-origin Blob, tainted or zero-sized Canvas,
wrong embedded MIME type or oversized source also fails explicitly.
The method is unavailable under restricted website-access policy.

## Source and lifecycle

Source reads use the actual selected Frame's utility world and native
`HTMLImageElement.currentSrc` / `HTMLMediaElement.currentSrc` getters. The native
selector query and first getter
run in one renderer call; a private handle retains the exact element and
Document. A final read checks connection, document/context, frame, capture and
selected URL or Canvas dimensions. Page-world prototype and instance getter overrides do not supply
the URL. Custom/main-world selector engines are rejected on this route.

The unresolved source reserves shared download capacity before any await. The
single 1–120000 ms budget (default 10000) covers admission, attachment, action
queue, locator resolution, source checks and native download start. Three SDKs
and CLI/MCP include discovery and connection in their original request budget,
and preserve the original session, turn and epoch in the resulting handle.

Embedded bytes have an 8 MiB limit; Canvas has a 16,777,216-pixel limit and uses
native `toBlob("image/png")`. Each unresolved source reserves 8 MiB of a shared
64 MiB source budget before any asynchronous work. HTTP sources release this
reservation after actual source cleanup; embedded sources retain it until the
native download creation settles. Caller timeout does not release active work's
capacity. This byte budget bounds payload work, not total JS heap overhead.

The byte reader checks both declared length and the actual streamed total;
oversized content is never returned as a truncated success. Encoded content
leaves the renderer in chunks of at most 262,143 decoded bytes (349,524 base64
characters), with exact offset/length and canonical base64 checks. The private sink validates the complete byte
length/MIME/base64 again and passes an extension-created data URL to the native
download API. This does not open an anchor, activate a tab or create an offscreen
document. Public `downloadURL` continues to accept only HTTP(S).

Source work and exact native handle release are tracked through their actual
settlement, even after the caller's deadline expires. Source cleanup must finish
before detaching its original browser attachment. A failed exact-handle release
retains capacity and fails cleanup; explicit cleanup retries that handle without
repeating source resolution or GET. A late native download ID is cancelled by
that ID and is never returned as a new successful handle.

Cancellation invokes only a fixed private function on the exact retained
binding. That binding aborts its own fetch/reader. The adapter joins the actual
cancel command and source cleanup before releasing handles. Canvas encoding has
no abort API: cancellation prevents publication but still waits for the actual
callback or original context's destruction. Neither an outer timeout nor
Playwright's cancellation race is evidence of native completion.

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

The embedded-byte path returns the finite selected Blob/data contents. Canvas
PNG represents the native bitmap at encoding time, not the DOM or a screenshot.
It cannot atomically prevent an application from changing same-sized Canvas
pixels during later operations. HTTP video/audio uses the same new-GET caveats
as HTTP images; it does not reconstruct playback, a playlist or a stream.
Content-return APIs, arbitrary-size media, further platform tests and broader
P10 coverage remain unfinished. This slice does not claim full Browser Use parity.

## Original-frame Blob access

The pinned CRX utility world requests universal origin access. Consequently this
adapter does **not** offer general HTTP content fetch or claim ordinary page
CORS equivalence. Blob URLs must match the selected document's non-opaque
origin, and native fetch runs in that exact frame. The pinned Chromium code
binds Blob URL resolution through the frame's `BlobURLStore` and its storage key;
the world security-origin grant does not replace that frame binding. Browser
storage-access and policy exceptions still apply; this is not an additional
network firewall.

The relevant pinned implementation is Chromium
`f842f52ef39fd97b449eb27cff414bf05a98ddce`:

- [Request Blob resolution](https://github.com/chromium/chromium/blob/f842f52ef39fd97b449eb27cff414bf05a98ddce/third_party/blink/renderer/core/fetch/request.cc#L393)
  resolves via the execution context's public URL manager.
- [PublicURLManager](https://github.com/chromium/chromium/blob/f842f52ef39fd97b449eb27cff414bf05a98ddce/third_party/blink/renderer/core/fileapi/public_url_manager.cc#L58)
  obtains the frame's associated Blob URL store.
- [RenderFrameHost binding](https://github.com/chromium/chromium/blob/f842f52ef39fd97b449eb27cff414bf05a98ddce/content/browser/renderer_host/render_frame_host_impl.cc#L12394)
  supplies the frame's storage key and committed origin.
- [BlobURLStore partition check](https://github.com/chromium/chromium/blob/f842f52ef39fd97b449eb27cff414bf05a98ddce/storage/browser/blob/blob_url_store_impl.cc#L135)
  checks that key and browser policy when resolving a Blob loader factory.
- [Native data-URL download test](https://github.com/chromium/chromium/blob/f842f52ef39fd97b449eb27cff414bf05a98ddce/chrome/browser/extensions/api/downloads/downloads_api_browsertest.cc#L2616)
  covers download creation, completion and file contents.

## Finite-media acceptance

The final controlled-config Windows Chromium 156 headed run `run-XnREpF`
passed **70/70**, preserving all earlier 63 cases and adding seven media cases.
Full CI passed **807** extension/script/harness tests (703 + 52 + 52), JS **93**,
Python **63**, Go packages and the remaining workspace checks. The dedicated
media run `run-L7XsRk` passed **16/16** before the diagnostic fix; the intervening
full `run-WMOIim` remains **69/70** because late native historical console replay
entered a new diagnostics capture. It was fixed and revalidated, not relabelled.

An independent audit decoded all 36 retained media files: the original 17 PNGs
and 19 additional files across five public callers. It checked PNG CRC/pixels,
PCM WAV contents, WebM VP8 frames, Canvas pixels and two exact 8 MiB files,
including their trailing bytes. Twelve negative cases covered the supported
browser's actual ClearKey mediaKeys, inaccessible Blob, taint, live and size
limits. A separate same-origin/different-top-level-partition Blob attempt failed
in both ordinary native fetch and the original-frame media read.

Four source-cancellation cases hold real fetch or reader work pending, with
turn end or deadline. The actual abort, reader unlock, renderer settlement and
exact original-object release precede the observed native Port end ACK; no
download starts. The gate and passive RPC observer are declared test hooks,
absent from production. Native Canvas encoding is not claimed to be abortable.

The full run's continuous observer retained six initial tab activations from
explicit test-window creation and four focus events from two intentional action
popup openings. Each has an exact allowance; the sentinel stayed unchanged and
no additional foreground event occurred. This is not a zero-event claim or
proof of native popup initial-focus suppression. The host and production build
hashes were checked; the local Port adapter does not verify installed launcher
recovery. Broader P10/P11 and platform gaps remain in the capability matrix.

## Historical HTTP-image acceptance

The earlier HTTP-image-only build passed all eight media cases in both pinned
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

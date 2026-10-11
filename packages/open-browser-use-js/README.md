# Open Browser Use JavaScript SDK

JavaScript/TypeScript client for controlling a real Chrome profile through
Open Browser Use. The SDK keeps the low-level JSON-RPC/CDP surface available and
also provides semantic locators, frame locators, screenshots, and input through
the extension's Playwright engine.

## Prerequisites

Locator composition uses the same tab and client, including separately created
handles for that tab ID:

```js
const cards = tab.getByRole("listitem");
const selected = cards.filter({
  has: tab.getByText("Research", { exact: true }),
  hasNot: tab.getByText("Unavailable"), visible: true,
}).and(tab.locator(".eligible"));
await selected.getByRole("button", { name: "Choose" }).click();
const either = tab.getByRole("button", { name: "Save" })
  .or(tab.getByRole("button", { name: "Continue" }));
await either.filter({ visible: true }).click();
await tab.getByLabel("Materials").selectOption(["Manual", { value: "sticker" }]);
```

`has`/`hasNot` operands are relative to each candidate element. Supply a root
builder or a builder with exactly the same frame prefix as the outer locator;
the SDK removes that common prefix. `and`/`or` require matching frame prefixes.
Nested operands cannot enter frames or use capture refs. Ref locators cannot be
composed. A chain has at most 32 steps, a tree depth of 8, and an action at most
128 total steps (including a drag target). Trees are copied and frozen.
`or` preserves native strictness when both branches match; it does not pick a
winner. `visible: false` is supported. Select strings match value or label;
mixed descriptors accept only `value`, `label`, and nonnegative `index`.

- The `open-browser-use` CLI and Chrome extension are installed and connected.
- `open-browser-use ping` returns `"pong"`.
- The matching native host and extension include the `browserAction` engine.
- The native host has written `active.json` under `/tmp/open-browser-use` on
  macOS/Linux or `%TEMP%\open-browser-use` on Windows. Windows uses local named
  pipes; restart an older host which still exposes an AF_UNIX socket.

```sh
open-browser-use ping
open-browser-use info
```

## Installation

```sh
npm install open-browser-use-sdk
```

## High-Level Browser API

Use `connectOpenBrowserUse` when you want a Playwright-like flow in a normal
Node runtime.

```js
import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { connectOpenBrowserUse } from "open-browser-use-sdk";

const registryPath = process.platform === "win32"
  ? join(tmpdir(), "open-browser-use", "active.json")
  : "/tmp/open-browser-use/active.json";
const registry = JSON.parse(await readFile(registryPath, "utf8"));

const browser = await connectOpenBrowserUse({
  socketPath: registry.socketPath,
  sessionId: "github-issue-scan",
  turnId: `turn-${Date.now()}`,
  timeoutMs: 20000,
});

let tab;

try {
  await browser.client.nameSession("GitHub issue scan - OBU");

  tab = await browser.newTab();

  await tab.goto("https://github.com/iFurySt/open-browser-use/issues", {
    waitUntil: "domcontentloaded",
    timeoutMs: 15000,
  });

  await tab.playwright.waitForLoadState({
    state: "domcontentloaded",
    timeoutMs: 15000,
  });

  const snapshot = await tab.playwright.domSnapshot();
  const relevant = snapshot
    .split("\n")
    .filter((line) =>
      /Open|Closed|Issues|issue|No results|open-browser-use|Pull requests|Starred/.test(line)
    );

  console.log(relevant.slice(0, 160).join("\n"));
} finally {
  await browser.client.finalizeTabs([]);
  browser.close();
}
```

The same tab helpers are available without the `playwright` alias:

```js
await tab.goto(url, { waitUntil: "load", timeoutMs: 15000 });
await tab.waitForLoadState({ state: "domcontentloaded", timeoutMs: 15000 });
const text = await tab.domSnapshot();
const value = await tab.evaluate("document.title");
```

## Network request and response waits

Register the listener first, trigger the action, then collect its result. The
ready acknowledgement means the listener is installed on the same engine Page
used by the action; the pending listener does not occupy the tab's action queue.
These helpers are available on both `tab` and `tab.playwright`.

```js
const pending = await tab.expectResponse({
  url: "https://your-test-site.example/api/save", method: "POST", status: 200,
}, { timeoutMs: 5000 });
try {
  await tab.getByRole("button", { name: "Save", exact: true }).click();
  const response = await pending.result();
  console.log(response.requestId, response.status);
} catch (error) {
  await pending.cancel().catch(() => {});
  throw error;
}
```

`expectRequest` uses the same match object without `status`. URL matching is
`exact` by default; set `urlMatch: "contains"` for a literal substring. URL is
nonempty and at most 4096 UTF-8 bytes; optional `method` is nonempty and at most
128 bytes, with case preserved. Only response waits accept integer status
100–599. Predicates, regular expressions and unknown fields are rejected.

The arm timeout defaults to 10,000 ms, accepts integers 1–120,000, and includes
negotiation, connection and queue time. `result({ timeoutMs })` has a separate
read budget (default 120,000 ms); each RPC reserves one additional second for
its response. Reading never extends the original network deadline. Matched
results and terminal errors remain available for the backend's 30-second TTL;
repeated `result()` reads that retained state. `cancel()` releases the record.

Handles preserve the session, turn and epoch submitted by arm. Ending control,
pause, detach, ownership change or restart invalidates them; `beginTurn()` does
not rebind an old handle. Errors never trigger automatic re-arm, recapture or
input replay. The extension must advertise `getInfo.metadata.networkWaitVersion`
as `1`; older extensions fail explicitly, with no diagnostics-cache fallback.
Results contain bounded request/response metadata, optional redirect linkage
and a `truncated` flag, never headers or bodies. A response means headers arrived,
not that its body finished; HTTP errors can match, network failures can time out.

## Semantic Locators and Input

High-level actions execute in the extension's Playwright engine. `domSnapshot()`
returns an accessibility-oriented YAML snapshot containing roles and names.
`locator.ariaSnapshot({ timeoutMs })` returns the same format for the selected
element, or for the selected frame's body when called on a frame locator.
Locators use Playwright's strict matching, visibility/actionability checks, and
waiting behavior. Locator chains are immutable, so one base locator can safely
be reused for several operations.

```js
const form = tab.getByRole("form", { name: "Profile" });
await form.getByLabel("Display name").fill("Ada");
await form.getByRole("checkbox", { name: "Notifications" }).setChecked(true);
await form.getByRole("button", { name: "Save", exact: true }).click({ timeoutMs: 15000 });
await tab.getByRole("status").waitFor({ state: "visible" });
console.log(await tab.getByRole("status").innerText());

const frameButton = tab.frameLocator("iframe#settings").getByRole("button", { name: "Apply" });
await frameButton.click();

const rows = tab.locator(".result").filter({ hasText: "Published" });
console.log(await rows.count(), await rows.allInnerTexts());
await rows.nth(0).click();

const screenshot = await tab.screenshot({ fullPage: true, type: "png" });
const imageBytes = Buffer.from(screenshot.base64, "base64");
console.log(screenshot.mimeType, imageBytes.length);

await tab.mouse.move(120, 80);
await tab.mouse.wheel(0, 400);
await tab.keyboard.press("Control+A");
await tab.keyboard.insertText("Hello");
```

The same locators are available through `tab.playwright`. Supported builders are
`locator`, `frameLocator`, `getByRole`, `getByText`, `getByLabel`,
`getByPlaceholder`, `getByAltText`, `getByTitle`, and `getByTestId`, followed by
`first`, `last`, `nth`, or `filter({ hasText, hasNotText })`. Text/role names in
this JSON protocol are strings. JavaScript functions and RegExp objects are not
serialized as locators.

Actions include click/double-click/hover, fill/press, checkbox/select controls,
waits, text/value/attribute reads, visibility/enabled/checked state, bounding
boxes, bulk text reads, and element screenshots. `fullPage` and `clip` are only
accepted by page screenshots; locator screenshots reject these options, including
`fullPage: false`. `tab.waitForURL` supports URL
patterns understood by Playwright. Raw `tab.evaluate` and `browser.cdp` remain
available for CDP work.

`await tab.engineInfo()` reports the engine and bundled Playwright versions.
The low-level `client.browserAction(tabId, action, { locator, args, timeoutMs })`
returns `{ value, engine }` and validates that the extension supports the engine.
High-level methods return the action value. There is no silent text-only
snapshot fallback when the extension is outdated.

`tab.snapshotAI()` (also `tab.playwright.snapshotAI()`) returns a complete
observation including frame subtrees:

```js
const capture = await tab.snapshotAI({ maxBytes: 65536, timeoutMs: 10000 });
console.log(capture.snapshot, capture.stats);
// Choose a reference actually listed in capture.refs after reading the snapshot.
const target = tab.getByRef(capture.captureId, chosenRef);
await target.click();
```

The result is `{ captureId, snapshot, refs, stats: { bytes, nodes, refs, frames },
complete: true }`. References come from structured native metadata, never from
scanning page text. The SDK rejects incomplete/malformed responses and checks
UTF-8 bytes, unique references, counts and requested limits. Optional positive
integer limits are `maxBytes` (262144), `maxNodes` (5000), `maxRefs` (2000),
`maxFrames` (32 including the root) and `maxDepth` (64); parentheses give the
default and maximum. Exceeding a limit fails instead of truncating the capture.
`engineInfo()` advertises `capabilities.snapshotAI === 1`, `captureRefs === 1`
and `snapshotLimits`; the bundled Playwright version alone is not a capability
test. An outdated extension fails explicitly; there is no fallback.

Set `boxes: true` to include capture-time geometry:

```js
const capture = await tab.snapshotAI({ boxes: true });
console.log(capture.geometry.frames, capture.geometry.boxes);
```

The additional `geometry` has `coordinateSpace: "frame-viewport-css"`, `frames`
and `boxes`. Each frame records `id`, `parentId`, `ownerRef` and its `viewport`
(`width`, `height`, `scrollX`, `scrollY`, `devicePixelRatio`). The root has null
parent/owner; other frames point to their parent's iframe ref. Each ref has one
`{ref, frameId, box: {x, y, width, height}}` entry. Sparse `f1`–`f32` slots retain
native frame identity. These are unclipped axis-aligned bounds in that frame's
own CSS viewport, including transforms within its document. They are not
projected through ancestor iframe transforms into top-page coordinates, divided
by DPR, or clipped to visibility. Offscreen coordinates may be negative and
zero-sized boxes are valid. Bounds are observations, not a clickability or
current-position guarantee; layout can change without changing the ref.

The YAML also includes `[box=x,y,width,height]` annotations; `maxBytes` counts
the complete annotated UTF-8 YAML. Structured metadata alone supplies refs and
geometry. Capturing all frames shares the original action deadline and is not
an atomic multi-document layout snapshot. `boxes` omitted/false keeps the old
response shape. The SDK rejects missing, unsolicited or malformed geometry;
an engine advertising `capabilities.snapshotBoxes === 1` supports this option.
Unsupported requests fail explicitly without retry or fallback. Geometry types
are exported as `OpenBrowserUseAISnapshotGeometry`, `OpenBrowserUseAISnapshotFrame`
and `OpenBrowserUseAISnapshotBox`.

`getByRef(captureId, ref)` creates a singleton locator for the original connected
Element. It supports ordinary actions, reads and element screenshots, including
use as a same-tab drag target, but rejects `locator`, `frameLocator`, `getBy*`,
`filter`, `first`, `last` and `nth` derivation. A renamed Element remains the same
Element; a removed node is not replaced by another element with matching text.
Captures expire on any new ordinary/AI snapshot, frame lifecycle change,
attachment/owner/epoch change, pause or restart. Calling a ref's `ariaSnapshot()`
uses that ref and then invalidates the capture for subsequent calls. The SDK
never recaptures or replays after expiry. `domSnapshot()` keeps its existing
scoped ARIA behavior; use `snapshotAI()` for recursive frame observations.

Action `timeoutMs` must be between 1 and 120000. It is sent separately from
Playwright arguments, and the outer IPC deadline allows the requested action
budget plus a one-second response margin. Engine actions and event waits default
to 10000 ms; a longer client-level default does not extend a shorter operation.
Connection and handshake time consume that operation's budget. A client is bound
to its first successful transport connection. After EOF, transport failure, or
`close()`, later calls fail with `OBU_SDK_BROWSER_DISCONNECTED`; neither `connect()`
nor `beginTurn()` reopens it. Create a new client and new tab/locator/wait handles,
explicitly begin a new turn, and inspect page state before deciding whether an
uncertain mutation should be repeated. No request is replayed automatically.
An unsuccessful first connection attempt may be retried unless `close()` was
called. A response timeout on a still-healthy JS socket keeps that same socket;
local validation failures and received RPC errors also preserve the connection.

## Console, errors, and network diagnostics

`tab.diagnostics()` reads bounded snapshots of real page console, page-error,
request, response, request-finished, and request-failed events, including frames.
Capture begins on engine attachment; it does not reconstruct earlier events.

```js
const before = await tab.diagnostics();
await tab.getByRole("button", { name: "Load results" }).click();
const after = await tab.diagnostics({ after: before.cursor, limit: 100 });
console.log(after.entries, after.dropped);
```

The recorder retains at most 500 entries / 1 MiB, truncates long text, and reports
discarded records in `dropped`. Pages are limited to 1–200 entries. Network events
include request identities and redirect links, but omit headers and bodies.
A cursor belongs to one capture: detach, turn end, or ownership change expires it
with `OBU_DIAGNOSTICS_EXPIRED`. Start a fresh snapshot explicitly after recovery;
the SDK does not silently restart or replay an expired query.

## Multi-Tab Workflows

The extension queues engine actions within each tab. Different tabs can execute
concurrently and share backend and transport resources. Await each operation
when its full timeout budget is needed; requests queued for the same tab consume
their deadline while waiting.

```js
const targets = [
  ["repo", "https://github.com/iFurySt/open-browser-use"],
  ["issues", "https://github.com/iFurySt/open-browser-use/issues"],
  ["pulls", "https://github.com/iFurySt/open-browser-use/pulls"],
];

const results = [];
for (const [kind, url] of targets) {
  const tab = await browser.newTab();
  await tab.goto(url, { waitUntil: "load", timeoutMs: 25000 });
  results.push({ kind, tabId: tab.id, text: await tab.domSnapshot() });
}
```

## Low-Level Client API

Use `OpenBrowserUseClient` when you need direct Browser Use JSON-RPC methods or
raw CDP commands.

```js
import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { OpenBrowserUseClient } from "open-browser-use-sdk";

const registryPath = process.platform === "win32"
  ? join(tmpdir(), "open-browser-use", "active.json")
  : "/tmp/open-browser-use/active.json";
const { socketPath } = JSON.parse(await readFile(registryPath, "utf8"));

const client = new OpenBrowserUseClient({
  socketPath,
  sessionId: "raw-cdp-example",
});

try {
  await client.connect();
  await client.nameSession("Raw CDP example - OBU");

  const tab = await client.createTab();
  await client.attach(tab.id);
  await client.executeCdp(tab.id, "Page.navigate", {
    url: "https://example.com",
  });

  const title = await client.executeCdp(tab.id, "Runtime.evaluate", {
    expression: "document.title",
    returnByValue: true,
  });

  console.log(title.result.value);
} finally {
  await client.finalizeTabs([]);
  client.close();
}
```

The unrestricted escape hatch is `request(method, params)`:

```js
await client.request("executeCdp", {
  target: { tabId: 123 },
  method: "Runtime.evaluate",
  commandParams: {
    expression: "document.body.innerText",
    returnByValue: true,
  },
});
```

## Notifications

The JS SDK can subscribe to JSON-RPC notifications from the native socket. This
is useful for downloads and CDP events.

CDP/download notifications include `session_id`, `turn_id`, `control_epoch`, and
`tabId` in their top-level params. The host routes them only to connections that
explicitly requested that session; heartbeat remains global. A connection may
request up to 128 sessions (1024 UTF-8 bytes per ID). Session IDs are routing
labels, not authentication credentials. Older unscoped tab events are dropped.

```js
const unsubscribe = client.onNotification((event) => {
  if (event.method === "onDownloadChange") {
    console.log("download", event.params);
  }
  if (event.method === "onCDPEvent") {
    console.log("cdp", event.params);
  }
});

// Later:
unsubscribe();
```

## Common Methods

- Browser/session: `getInfo`, `nameSession`, `turnEnded`
- Tabs: `createTab`, `getTabs`, `getUserTabs`, `claimUserTab`, `finalizeTabs`
- CDP: `attach`, `detach`, `executeCdp`, `request`
- Input: `moveMouse`
- Engine navigation: `tab.goto`, `goBack`, `goForward`, `reload`
- Engine input: locator `focus`, `pressSequentially`, `scrollIntoViewIfNeeded`,
  `dragTo`; `tab.mouse.down` and `up` support manual drag sequences. Drag targets
  must belong to the same tab and client.
- File chooser: `tab.expectFileChooser`, `waitForFileChooser`, `setFileChooserFiles`
- Downloads: `waitForDownload`, `downloadPath`
- Diagnostics: `tab.diagnostics`
- Clipboard: `readClipboardText`, `writeClipboardText`, `readClipboard`,
  `writeClipboard`

File chooser and download waits use a default 10000 ms, accept integers from 1
through 120000, and reserve one second for the reply. Handshake/queue time is
deducted before the wait is sent. `setFileChooserFiles` accepts local upload
paths for an owned chooser; an empty array clears it. Download events cannot
prove a local filesystem path, so `downloadPath` fails explicitly with
`OBU_DOWNLOAD_PATH_UNAVAILABLE` instead of guessing one.
Drag input is not transactional: cancelling after a delivered mouse-down can
produce normal pointer-up/click handlers while releasing the held button. The
SDK neither rolls those effects back nor repeats the operation.

## Ready file chooser waits

Arm the listener and await its ready acknowledgement before triggering the
upload button. The helper is available on `tab` and `tab.playwright`:

```ts
const pending = await tab.expectFileChooser({ timeoutMs: 5000 });
try {
  await tab.getByRole("button", { name: "Upload", exact: true }).click();
  const chooser = await pending.result();
  await browser.client.setFileChooserFiles(chooser.fileChooserId, ["/path/to/report.pdf"]);
} catch (error) {
  await pending.cancel().catch(() => {}); // Preserve the action/result error.
  throw error;
}
```

`OpenBrowserUseFileChooserWait`, `OpenBrowserUseFileChooserWaitOptions` and
`OpenBrowserUseFileChooserWaitResult` are exported. The handle exposes
`waiterId` and the acknowledged `remainingMs`; `result()` returns only
`{ fileChooserId, isMultiple }`. It consumes the result once; a second
concurrent `result()` fails immediately. The chooser ID is passed to the
existing `setFileChooserFiles` API, including an empty array to clear files.

The default timeout is 10,000 ms, with integer values from 1 to 120,000.
Connection, bootstrap and preparation consume the original budget. `result()`
has no new timeout option: it refuses to send after that deadline and allows
at most one extra second to read a reply already requested. `cancel()` can
still clean up an expired wait, using a separate maximum 10-second transport
budget without extending the wait. Both methods retain the original session,
turn, control epoch, tab and waiter ID. They never begin a new turn, re-arm or
replay the click. Pause, ownership changes and restart errors propagate.

All three RPCs (`armFileChooserWait`, `collectFileChooserWait`,
`cancelFileChooserWait`) require `getInfo.metadata.fileChooserWaitVersion === 1`.
Unsupported extensions fail explicitly. `client.waitForFileChooser` remains
available for existing callers; it does not provide the ready handshake.

## Turn lifecycle

The first protected request negotiates `getInfo.metadata.turnLifecycleVersion`.
Version 1 explicitly bootstraps `getControlState` once and binds subsequent
requests to a control epoch. Only `ping`, `getInfo`, and `getControlState` bypass
this handshake; tab and history reads are protected too. Extensions without
the metadata flag continue using the legacy protocol.

Successful `turnEnded()` and `finalizeTabs()` advance both `client.turnId` and
`client.controlEpoch`. Requests already submitted retain their original binding
and are rejected when that turn ends. The SDK never replays an action after a
stale epoch, extension restart, or lost end acknowledgement. When the original
transport is still connected, resume explicitly:

```js
await client.beginTurn(); // refreshControlState() is an alias
await client.createTab(); // newly submitted work uses the new binding
```

`getControlState()` only queries the extension; it does not update the client's
binding. Use a separate client for another session. Low-level callers may supply
an explicit `control_epoch` with custom session/turn metadata, but those requests
do not update the client's managed lifecycle state.

Connection, bootstrap, and queue time consume the original request deadline.
Immediately before sending a `browserAction`, its engine timeout is capped to
the remaining transport budget minus one second for the response. If no action
budget remains, the SDK fails without sending it.

`newTab({url})` and the legacy CDP navigation/load helpers bind all their RPC
stages to one original turn, epoch, and deadline. If control changes between
stages, the remaining work is rejected. Raw CDP calls check attachment each time
because engine cancellation can detach the debugger; sent CDP commands are
never retried automatically. Raw navigation checks the returned document loader
before and after reading readiness, so a previous document's load event cannot
finish the new navigation. Only unfinished readiness is polled; RPC errors are
reported immediately.

If the extension worker restarts while the native host/socket survives, call
`beginTurn()` explicitly to recover its new epoch. If the native host itself
restarts or the transport is lost, read the selected endpoint from `active.json`
and construct a new client, even if the endpoint string is unchanged. Recreate
browser-bound handles and explicitly begin a new turn; the old client stays
disconnected, including requests with manually supplied epoch metadata. Notification
subscriptions are rebuilt by that new client's explicit requests.

## Cleanup

Always finish browser work by finalizing tabs and closing the socket:

```js
try {
  // Browser work here.
} finally {
  await browser.client.finalizeTabs([]);
  browser.close();
}
```

Use `finalizeTabs([])` unless the user explicitly needs a tab left open. To keep
a tab, pass a keep item such as:

```js
await browser.client.finalizeTabs([{ tabId: tab.id, status: "handoff" }]);
```

## Notes

- The browser is the user's real Chrome profile. Do not inspect unrelated data.
- The SDK does not include Codex-specific site policy or approval prompts; add
  policy in your own runtime if needed.
- The bundled engine uses Playwright CRX 0.15.0 / Playwright 1.53.0 with the finite
  `snapshotAI` / capture-ref adapter described above. It does not expose newer
  Playwright snapshot boxes, closed shadow-root access, or incognito engine
  attachment; `engineInfo()` reports supported capabilities and limitations.
- If connection fails, run `open-browser-use ping` and `open-browser-use info`.
- If there is no active socket, open Chrome with the extension enabled or rerun
  setup according to the Open Browser Use installation guide.

## Ready navigation waits

`tab.expectURL(url, options)` and `tab.expectLoadState(options)` return a ready
observer; both also exist on `tab.playwright`. Await readiness, trigger the
action, then collect. URL strings use native Playwright glob matching (at most
4096 UTF-8 bytes); functions and RegExp objects are not accepted.

```js
const pending = await tab.expectURL("**/complete", { waitUntil: "load", timeoutMs: 5000 });
try {
  await tab.getByRole("button", { name: "Continue", exact: true }).click();
  await pending.result();
} finally {
  await pending.cancel().catch(() => {});
}
```

`expectLoadState({state: "domcontentloaded", timeoutMs: 5000})` observes the current
document's load state. An already satisfied URL/load state may complete during
arming; use a destination URL when waiting for an action's navigation. URL
`waitUntil` accepts `load` (default), `domcontentloaded`, `networkidle`, or `commit`;
load-state `state` excludes `commit`. Existing `waitForURL` remains available.

The extension must advertise `getInfo.metadata.navigationWaitVersion === 1`;
unsupported versions fail explicitly. Arm defaults to 10 seconds, accepts integer
1–120000 ms, and includes discovery, queueing and cold attachment. The SDK reserves
one additional second for transport. Handles retain their original session, turn
and epoch: neither reconnect nor `beginTurn` rebinds or replays them.

`result({timeoutMs})` returns void and has an independent read budget (default
120 seconds); `cancel({timeoutMs})` defaults to 10 seconds. Neither resets the
observer deadline. Terminal results are retained for 30 seconds; cancel releases
capacity when finished. Pause, end, detach, ownership loss or worker restart
invalidates the handle. A load-state observer is not a response-body wait.

### Active URL downloads

`locator.downloadMedia({filename?, timeoutMs?})` downloads one exact HTML image,
video, audio element or Canvas and returns the same `Download`. It requires
`mediaDownloadsVersion: 1`; source resolution, queueing and native start share
one deadline. HTTP(S) `currentSrc` starts a new GET, which may differ from the
previously displayed bytes. Data and same-origin Blob sources are read in their
original frame; Canvas produces PNG. Embedded content is limited to 8 MiB and
Canvas to 16,777,216 pixels. Frame and open-shadow locators are supported. Page
getter overrides do not supply the source. MSE, live streams, `srcObject`, DRM,
tainted Canvas and restricted website mode are unsupported. See the
[media contract](../../docs/references/media-downloads.md) for source and cleanup
limits.

`tab.downloadURL` explicitly starts an HTTP(S) GET in Chrome; it requires
`getInfo().metadata.directDownloadsVersion === 1`. It accepts an optional portable
basename (up to 255 UTF-8 bytes), never an output directory. Chrome uses
`saveAs: false` and `conflictAction: "uniquify"`. POST, custom headers, credentials
in the URL, save dialogs and overwriting files are not options.
Browser preferences or enterprise policy may still require confirmation UI.

```ts
const download = await tab.downloadURL("https://example.test/report.csv", {
  filename: "report.csv", timeoutMs: 10_000,
});
const path = await download.path({ timeoutMs: 30_000 });
// Or explicitly stop an active download:
// await download.cancel({ timeoutMs: 10_000 });
```

The handle exposes `downloadId`; `path()` returns the browser's completed path
as a string and `cancel()` returns void. The SDK does not read or validate the
file's bytes. Each operation defaults to 10 seconds, accepts integer milliseconds
from 1 to 120000, and includes connection/discovery in that budget plus one second
for the response. A path timeout leaves the download running: explicitly retry
`path()` on the same handle or cancel it. A start timeout can mean Chrome already
started the download; the SDK never retries the GET automatically.

Handles retain the original session, turn and control epoch. Ending a turn,
pausing, or losing ownership may invalidate them; beginning a new turn does not
rebind an old handle. `tab.waitForDownload({ timeoutMs })` also returns a bound
handle for an observed page download, but its GUID-based path/cancel operations
remain unsupported. This observer has no cross-connection readiness guarantee.
The legacy Client methods still return raw JSON using the current invocation's
scope; use typed Tab handles when retaining a download across calls, or supply
original scope explicitly with `request`.

For a page-triggered download, first await `tab.expectDownload({ timeoutMs })`
(also available as `tab.playwright.expectDownload`). It requires
`metadata.downloadWaitVersion === 1` and returns an `OpenBrowserUseDownloadWait`
only after the observer is ready, so an immediate download from the next click
can be retained before `result()` runs:

```ts
const pending = await tab.expectDownload({ timeoutMs: 10_000 });
await tab.getByRole("button", { name: "Download report" }).click();
const download = await pending.result();
console.log(download.downloadId);
// If the triggering workflow is abandoned: await pending.cancel();
```

The wait exposes `waiterId` and the ready acknowledgement's `remainingMs`.
The timeout defaults to 10000 integer milliseconds (1..120000), covering
connection, capability discovery, setup, the trigger and collection under one
original deadline. `remainingMs` is a snapshot, not a new timeout. The one-second
reply allowance cannot authorize a collect request after that deadline.
`result()` returns the existing `OpenBrowserUseDownload`, permanently bound to
the original session/turn/epoch/tab. A pending concurrent result is rejected;
successful collection or cancellation consumes the wait locally. Failures are
never automatically replayed or rebound to a new turn.

`pending.cancel()` cancels only the observer, even after its deadline, with an
independent ten-second cleanup budget. It can be retried on the exact same wait;
it neither cancels the actual browser download nor blocks page network activity.
The resulting page GUID still raises `OBU_DOWNLOAD_PATH_UNAVAILABLE` from
`download.path()` and `OBU_DOWNLOAD_CANCEL_UNSUPPORTED` from `download.cancel()`.
There is no guessed local path or fallback GET: `downloadURL()` starts a separate
explicit request and cannot substitute for a page-triggered or POST download.
The legacy `waitForDownload` API remains available without a ready handshake.

### PDF and MHTML page exports

`tab.exportPage("pdf" | "mhtml", options)`, `tab.exportPDF(options)` and
`tab.exportMHTML(options)` require `getInfo().metadata.pageExportVersion === 1`.
They return `{format, mimeType, encoding: "base64", data, byteLength}` and do not
write a local file. PDF uses `application/pdf`; MHTML uses `multipart/related`.

```ts
const exported = await tab.exportPDF({
  maxBytes: 8 * 1024 * 1024, timeoutMs: 30_000,
  pdf: { printBackground: true, preferCSSPageSize: true, marginTop: 0 },
});
const bytes = Buffer.from(exported.data, "base64");
const archive = await tab.exportMHTML({ timeoutMs: 30_000 });
```

`maxBytes` is a positive integer, defaults to 16 MiB, and cannot exceed 16 MiB.
`timeoutMs` defaults to 10000 and accepts integer values from 1 to 120000.
Connection, capability discovery and browser setup consume the original budget;
the transport reserves one additional second for its reply. The request retains
its submitted session/turn/epoch and is never replayed after failure.

Only PDF accepts `pdf`: boolean `landscape`, `printBackground`,
`preferCSSPageSize`, `generateTaggedPDF`, `generateDocumentOutline`; `scale`
from 0.1 to 2; `paperWidth`/`paperHeight` in inches greater than 0 and at most
200; `marginTop`/`marginBottom`/`marginLeft`/`marginRight` from 0 to 200 inches;
and `pageRanges` of at most 1024 ASCII digits, commas, hyphens and spaces.
Omitted values use browser defaults. Unknown options are rejected. The SDK
verifies the exact response fields, format/MIME, canonical Base64 and decoded
length against the requested cap before returning. Native export may still fail
for unsupported pages, browser conditions or an expired control scope.

### Clipboard

`tab.clipboard.readText(options)` returns a string; `read(options)` returns
`OpenBrowserUseClipboardItem[]`. `writeText(text, options)` and `write(items,
options)` return `Promise<void>`. The four existing Client methods still return
wire envelopes (`{text}`, `{items}`, or `{}`). Every method requires
`metadata.clipboardVersion === 1`, including explicit control-epoch calls.
Options are `{maxBytes?, timeoutMs?}`; timeout defaults to 10000 and accepts
integer milliseconds from 1 to 120000.

```ts
const text = await tab.clipboard.readText({ maxBytes: 65536, timeoutMs: 5000 });
await tab.clipboard.write([{ entries: [
  { mime_type: "text/plain", text: "Report" },
  { mime_type: "text/html", text: "<b>Report</b>" },
] }]);
```

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

## Upload through a locator

```js
await tab.getByLabel("Files").setInputFiles(["/absolute/path/report.pdf"], { timeoutMs: 10000 });
await tab.getByLabel("Files").setInputFiles([]); // clear
```

The locator identifies the file input directly, including frame and capture-ref
locators. Supply files, one directory for a directory input, or an empty list to
clear. Paths must be absolute (POSIX, Windows drive, or UNC); the SDK neither
resolves relative paths nor reads the filesystem. Lists are copied and limited
to 1024 paths, 131072 UTF-8 bytes per path, and 8 MiB total. Empty paths, NUL,
and malformed Unicode are rejected before IPC.

Every upload checks `engine.capabilities.locatorFileUpload === 1` in the same
captured tab/control scope and original action deadline. Unsupported extensions
fail explicitly; there is no chooser fallback, replay, or new turn. The timeout
covers capability negotiation and the upload together, with the existing one
second transport response allowance. Native directory-selection restrictions
still apply; this API does not activate an existing tab or window.

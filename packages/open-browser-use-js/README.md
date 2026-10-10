# Open Browser Use JavaScript SDK

JavaScript/TypeScript client for controlling a real Chrome profile through
Open Browser Use. The SDK keeps the low-level JSON-RPC/CDP surface available and
also provides semantic locators, frame locators, screenshots, and input through
the extension's Playwright engine.

## Prerequisites

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
Connection and handshake time consume that operation's budget. A transport error does not replay an
operation: a later explicit request may reconnect, while the caller decides
whether a previous mutation needs checking.

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
- File chooser: `waitForFileChooser`, `setFileChooserFiles`
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

## Turn lifecycle

The first protected request negotiates `getInfo.metadata.turnLifecycleVersion`.
Version 1 explicitly bootstraps `getControlState` once and binds subsequent
requests to a control epoch. Only `ping`, `getInfo`, and `getControlState` bypass
this handshake; tab and history reads are protected too. Extensions without
the metadata flag continue using the legacy protocol.

Successful `turnEnded()` and `finalizeTabs()` advance both `client.turnId` and
`client.controlEpoch`. Requests already submitted retain their original binding
and are rejected when that turn ends. The SDK never replays an action after a
stale epoch, extension restart, or lost end acknowledgement. To resume explicitly:

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
restarts, read the new endpoint from `active.json` and construct a new client;
the SDK does not silently change its configured endpoint. Notification
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

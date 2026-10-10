# Browser action protocol v1

The extension executes these actions through Playwright CRX 0.15.0, which embeds
Playwright 1.53.0. CLI, MCP and language SDKs use the same `browserAction` RPC;
they do not implement their own selectors, accessibility names or actionability.

```json
{
  "session_id": "example-task",
  "turn_id": "turn-1",
  "tabId": 123,
  "action": "fill",
  "locator": [{"kind": "label", "value": "Name", "exact": true}],
  "args": {"value": "Ada"},
  "timeoutMs": 10000
}
```

The result is `{ "value": <JSON value>, "engine": <engine metadata> }`. An action
without a return value returns `null`. `snapshot` returns Playwright's YAML ARIA
snapshot string; it is not `innerText`. `screenshot` returns
`{ "base64": "...", "mimeType": "image/png" }` (or `image/jpeg`). Bulk reads
return arrays without flattening. Errors use the existing JSON-RPC error envelope;
invalid arguments, unsupported actions and Playwright strictness/timeout errors
are failures, never successful empty results. `engineInfo` returns metadata without
loading or attaching the engine. Metadata includes the embedded Playwright version
and limitations; it does not claim parity with current Playwright or Codex.

## Locator descriptors

`locator` is an ordered array (at most 32 steps), not executable code:

| kind | Fields | Actual Playwright method |
| --- | --- | --- |
| `css` | `selector` | `locator(selector)` |
| `role` | `role`, optional `name`, `exact` | `getByRole` |
| `text`, `label`, `placeholder`, `altText`, `title` | `value`, optional `exact` | Corresponding `getBy*` |
| `testId` | `value` | `getByTestId` |
| `frame` | `selector` | `frameLocator(selector)` |
| `nth` | nonnegative integer `index` | `nth(index)` |
| `first`, `last` | none | `first()`, `last()` |
| `filter` | optional string `hasText`, `hasNotText` | `filter(...)` |

Ordinal/filter steps require an earlier element locator. Frame steps retain
Playwright frame semantics, including OOPIF routing. Open shadow DOM is handled
by Playwright; closed shadow roots are unsupported. Regular expressions and
executable callbacks are not part of v1. Element actions require a locator;
snapshot defaults to `body`, or a selected frame's body. Screenshot without a
locator captures the page.

## Actions

All arguments are in `args`; unknown keys are rejected before attachment.
`timeoutMs` is a top-level deadline, defaults to 10000, and must be between 1 and
120000. Zero does not mean an unbounded operation.

| Actions | Arguments |
| --- | --- |
| `engineInfo`, `snapshot` | none |
| `diagnostics` | optional `after`: `{captureId, sequence}`, `limit`: integer 1–200 (default 100); no locator |
| `click`, `dblclick`, `hover` | Appropriate Playwright `button`, `delay`, `modifiers`, `position`, `force`; `click` also supports `clickCount` |
| `fill` | string `value`, optional `force` |
| `press` | string `key`, optional `delay` |
| `pressSequentially` | string `text`, optional `delay` between real key events |
| `focus`, `scrollIntoViewIfNeeded` | none |
| `dragTo` | required `target` locator descriptor array, optional `force`, `sourcePosition`, `targetPosition` |
| `check`, `uncheck`, `setChecked` | optional `force`, `position`; `setChecked` requires boolean `checked` |
| `selectOption` | `values`: string, `{value}`, `{label}`, `{index}`, or array; optional `force` |
| `waitFor` | optional `state`: attached/detached/visible/hidden |
| `count`, `innerText`, `textContent`, `inputValue`, `isVisible`, `isEnabled`, `isChecked`, `boundingBox`, `allTextContents`, `allInnerTexts` | none |
| `getAttribute` | string `name` |
| `screenshot` | optional `type`: png/jpeg, `quality`, `fullPage`, `omitBackground`, `clip` |
| `goto`, `waitForURL` | string `url`, optional `waitUntil` |
| `goBack`, `goForward`, `reload` | optional `waitUntil` |
| `waitForLoadState` | optional `state`: load/domcontentloaded/networkidle |
| `mouse.move` | `x`, `y`, optional `steps` |
| `mouse.click` | `x`, `y`, optional `button`, `clickCount`, `delay` |
| `mouse.wheel` | `deltaX`, `deltaY` |
| `mouse.down`, `mouse.up` | optional `button`, `clickCount` |
| `keyboard.press` | `key`, optional `delay` |
| `keyboard.type` | `text`, optional `delay` |
| `keyboard.insertText` | `text` |

Navigation actions return `{ "url": "<actual page URL>", "status": <number or null> }`.
History navigation with no available entry returns the unchanged URL and `null`
status. A navigation restored from browser history may also have no new response.

`dragTo.args.target` uses the same finite descriptor format as `locator`, must
end in an element, and resolves on the same tab. It cannot select another tab or
carry executable code. Before invoking Playwright's `dragTo` once, the engine
uses Playwright's `waitFor({state: "visible"})` on the destination, including when
`force` is requested. This avoids pressing the source for an already missing or
hidden destination. Both waits share the original deadline; ownership is checked
again before dragging. The page can still change after this preflight.

The engine serializes actions per tab and revalidates ownership before execution.
The monotonic deadline includes time spent in the queue and in attachment;
expiration in the queue does not cancel the action ahead of it. An attachment
that finishes after expiry is cleaned up before any successor can attach.
Ending tab control invalidates queued operations and detaches the Playwright Page,
so pending auto-waits are cancelled. Its deadline detaches before reporting expiry,
including mouse/keyboard methods that lack native timeout options. Transport
timeouts must leave enough time for the requested deadline and cancellation.
An input already delivered to the browser cannot be undone and is never replayed.
Teardown cancels Playwright first and then makes a bounded attempt to release
observed pressed buttons, keys, and native dragging before detaching the debugger.
Buttons are released at their last known position to preserve native pointer-up
and pointer-capture behavior.
This is input cleanup, not transaction rollback: a delivered `mousedown` and its
release can trigger trusted `mouseup`, `click`, or drag handlers, and their page
effects cannot be reversed. A mid-drag failure may therefore leave observable
page changes. Callers using low-level `mouse.down`/`mouse.up` must not interpret a
timeout or end-turn acknowledgement as proof that no interaction occurred.

## Diagnostic snapshots

`diagnostics` returns bounded records from real Playwright Page events:

```json
{
  "captureId": "opaque-capture-id",
  "startedAt": "2026-01-01T00:00:00.000Z",
  "entries": [
    {"sequence": 1, "timestamp": "2026-01-01T00:00:00.000Z", "kind": "console", "type": "log", "text": "ready", "location": {"url": "https://example.test/", "lineNumber": 0, "columnNumber": 0}}
  ],
  "cursor": {"captureId": "opaque-capture-id", "sequence": 1},
  "dropped": 0
}
```

Every entry includes `sequence`, `timestamp`, and `kind`. Console entries contain
Playwright's `type`, `text`, and `location`; object arguments are not evaluated or
expanded, and their Playwright handles are released after recording the text.
`pageerror` entries contain `name`, `message`, and `stack`. Network kinds
are `request`, `response`, `requestfinished`, and `requestfailed`, with a stable
capture-local `requestId`, `url`, `method`, `resourceType`, and optional `frameUrl`.
Redirected requests include `redirectedFrom`; responses include `status` and
`statusText`; failed requests include `failure`. HTTP error statuses are responses,
not transport failures. Headers, bodies, routing, and interception are outside
this interface. Timestamps are collector observation times, not HAR timings.

Capture starts before the first authorized `browserAction` on an attachment,
including before that action navigates or clicks. It is not historical retrieval
of requests or messages emitted before capture started. A raw-CDP-only attachment
does not start this recorder. Records cover the Page and its frames, including
out-of-process frames, without subscribing to unrelated browser tabs.

The ring retains at most 500 entries and 1 MiB of serialized entry data. Text and
stack fields are limited to 8192 UTF-8 bytes, URLs to 4096, status text to 1024,
and type/name/method fields to 128; shortened entries have `truncated: true`.
`dropped` counts records evicted by either capacity bound or skipped on collector
errors. Request identity uses weak references, so removed entries do not retain
requests indefinitely. Retention is not lossless.

Pass the returned cursor as `after` for the next page. Its sequence must be a
nonnegative safe integer; a cursor ahead of the capture is rejected. Pagination
advances through returned records and exposes buffer loss through `dropped`.
Snapshots do not clear the buffer. Detach, ownership/epoch transfer, or worker
restart discards the capture; an old `captureId` fails with
`OBU_DIAGNOSTICS_EXPIRED` rather than silently reading another capture. Ended
sessions cannot query a former owner's records. A capture ID is an identity
token, not authorization; ordinary tab ownership and control checks still apply.

Event-triggered network waits and streaming diagnostic subscriptions remain
unimplemented. In particular, this snapshot action must not be described as
`waitForRequest` or `waitForResponse`; a correct waiter cannot hold the same action
queue needed by its triggering click.

## Build and adapter boundaries

Run `pnpm install --frozen-lockfile` then `pnpm build:chrome-extension`. Load the
generated `dist/chrome-extension-unpacked/`, not the source directory. Packaging
builds this same artifact. Only production files and the pinned upstream ESM
modules are copied; no generated multi-megabyte library is committed.

The build verifies the pinned upstream chunk's SHA-256 and each modified source
shape before applying explicit transport adapters to CRX. It
notifies after successful CRX pointer commands, and cannot fail or change the
command. This does not replace `chrome.debugger.sendCommand` globally or intercept
the backend's raw CDP/screenshot implementation. Included LICENSE, NOTICE and
MODIFICATIONS.txt preserve attribution and document the modifications.

On late attachment, `chrome.debugger` can return a parent `Page.getFrameTree`
without already-loaded out-of-process iframes. Playwright then receives a child
target without its corresponding frame and cannot initialize that child. The
frame adapter reads that attached child's native frame tree and delivers only
the missing `Page.frameAttached` before forwarding the original target event.
It validates the tab, session, target and parent identities, never infers parents
from URLs, never reloads the page, and does not replay known frames. Detachment
and top-level navigation invalidate pending repairs. Playwright still performs
child initialization, execution-context management and debugger resumption.

On a native `BackForwardCacheRestore` navigation, the frame adapter re-enables
`Page.setLifecycleEventsEnabled` on that owned session after forwarding the
navigation. Chromium reports the restored document's actual lifecycle milestones;
the adapter does not invent load events, reload the page, or disable BFCache.
This prevents the embedded Playwright version from waiting for fresh load events
that a restored document will not emit.

`browser-runtime.js` statically imports the vendor ESM: MV3 service workers do not
support dynamic `import()`. The dispatcher itself takes an injected runtime for
unit testing. The backend supplies `authorize`, `onBeforeAttach`, `onAttached`, `onDetached`, `onCommand`, `isInternalEvent`, and `aroundAction`
hooks. A known raw attachment is migrated before Playwright attaches; unrelated
debuggers are not adopted. Attachment must use shared focus initialization and ownership state;
detach must explicitly clear it. Browser-initiated detach invalidates engine
state through `forget(tabId)`. `aroundAction` holds a shared rendering lease for
screenshots, scrolling, dragging, and pointer actions (`click`, `dblclick`,
`hover`, checkbox actions, and `mouse.*`). This lets background OOPIF compositor surfaces commit before
native hit testing, including newly created or navigated frames. Reads, fill,
selection and keyboard operations do not take this lease. The wrapper invokes
the original Playwright operation exactly once and preserves screenshot
crop/element/full-page semantics. The request-wide deadline and ownership checks
also cover waiting for the lease; cancellation and errors release it. Input observation forwards active session/turn
metadata to existing visual feedback. Tabs are created through OBU's background
creation path before attaching; the engine never calls `attachAll` or creates
tabs. Incognito is explicitly unsupported until CRX startup can be limited to
owned tabs. Version 1.53 lacks later AI snapshot refs/boxes and newer cancellation
interfaces; these remain parity work, not completed capability claims.

Internal rendering-lease `Page.screencastFrame` events are acknowledged only by
the backend. Its synchronous `isInternalEvent` predicate suppresses those events
inside the CRX transport, preventing duplicate acknowledgements by Playwright.
It does not replace global Chrome event delivery or suppress caller-owned
screencasts; all other protocol events still reach Playwright.

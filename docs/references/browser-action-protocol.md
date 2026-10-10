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
| `ref` | `captureId`, `ref`; singleton only | Native `aria-ref` locator after current capture validation |

Ordinal/filter steps require an earlier element locator. Frame steps retain
Playwright frame semantics, including OOPIF routing. Open shadow DOM is handled
by Playwright; closed shadow roots are unsupported. Regular expressions and
executable callbacks are not part of v1. Element actions require a locator;
snapshot defaults to `body`, or a selected frame's body. Screenshot without a
locator captures the page. `fullPage` and `clip` are page-only options and are
rejected for every element/frame locator screenshot, including explicit
`fullPage: false`; unsupported options are never silently ignored.

Element/frame screenshots reveal each iframe owner from the outside in before
the final Playwright screenshot. Offscreen child renderers can suspend animation
frames, leaving the element's stability wait unable to finish before its normal
scroll step. The preparatory scrolls use strict Playwright locators within the
same rendering lease and remaining request budget; ownership and cancellation
are checked between steps. Page screenshots without frame steps are unchanged.

Production CRX does not automatically attach a newly created popup from its
`tabs.onCreated` listener. Every Page must first pass the backend's ownership and
admission checks; flat OOPIF child-session discovery is retained. A child already
in the task group can use the ordinary tab API; an unowned child requires an
explicit claim. Claim uses the existing task-group model and can move a popup
tab into the task window. Native `target=_blank` and `window.open` can still
activate their new tab/window. Popup activation and the observed first-click
timeout after moving a separate popup are unresolved; this change only removes
the unauthorized automatic attachment, not those lifecycle limitations.

## Bounded recursive observations

`snapshotAI` expands visible ARIA iframe subtrees, including owned OOPIFs and
nested frames, using the same native Playwright accessibility implementation.
It is an OBU contract, not the later Playwright snapshot API. Discover it through
`engineInfo.capabilities.snapshotAI === 1` and `captureRefs === 1`; protocol v1
and the embedded engine versions are unchanged.

```json
{"tabId":123,"action":"snapshotAI","args":{"maxBytes":262144,"maxNodes":5000,"maxRefs":2000,"maxFrames":32,"maxDepth":64},"timeoutMs":10000}
```

Each optional limit is a positive integer no greater than the value shown;
omitting it selects that maximum. The limits apply to the whole observation,
not independently to each iframe. Frames include the main frame; live frame
slots are bounded too. Bytes count the final UTF-8 YAML, including indentation.
Nodes/depth bound native traversal, including frame descent. These checks do
not sandbox the browser's CPU or allocations inside accessible-name computation.

The result `value` is:

```json
{"captureId":"opaque-id","snapshot":"- button \"Continue\" [ref=e1]","refs":["e1"],"stats":{"bytes":28,"nodes":2,"refs":1,"frames":1},"complete":true}
```

The counts above illustrate the shape; returned counts are computed from the
actual observation. The `refs` list comes from the native renderer's emitted
element records, never from matching page text against a token pattern. A label
containing `[ref=e999]` cannot register that ref. Internal Frame objects are not
returned. A resource limit throws `OBU_SNAPSHOT_LIMIT`; missing children or an
inconsistent tree fail explicitly, including `OBU_SNAPSHOT_INCOMPLETE`, expiry,
or deadline errors. No successful partial or silently truncated tree is returned.

Use a ref printed in the current snapshot and present in its `refs` list:

```json
{"tabId":123,"action":"click","locator":[{"kind":"ref","captureId":"opaque-id","ref":"e1"}],"timeoutMs":10000}
```

The ref descriptor must be the only locator step. It supports the ordinary
element actions/reads, screenshots and drag targets, but no further chaining.
The SDK entry points are `snapshotAI`/`getByRef` (JS), `snapshot_ai`/`get_by_ref`
(Python), and `SnapshotAI`/`GetByRef` (Go), on both tab and Playwright facades.

Only one capture per Page attachment remains valid. Any new AI or ordinary ARIA
snapshot invalidates the old capture before generation, even if generation
fails. Frame attachment, detachment or navigation, Page close, ownership/epoch
change, detach, Pause and worker restart invalidate it too. A frame event during
generation prevents publication. The observation is not an atomic DOM snapshot
across documents. Unknown refs raise `OBU_REF_NOT_IN_CAPTURE`; old IDs raise
`OBU_CAPTURE_EXPIRED`. No automatic recapture, replacement-node selection or
input replay takes place.

A ref identifies an Element, not a frozen label. Renaming that same connected
node need not invalidate it; a removed node no longer matches. A ref click that
itself triggers navigation can finish normally, while later uses of its capture
fail. A scoped ARIA snapshot through a valid ref may run once and expires the
capture for subsequent operations. Screenshots resolve the captured Frame's real
ancestors and scroll their owners outside-in under the ordinary shared deadline,
rendering lease and cancellation checks.

The public CSS/frame selector path rejects the native `aria-ref` selector engine,
including composite/nested forms, with `OBU_REF_SELECTOR_REQUIRES_CAPTURE`. It
uses the pinned native selector parser so ordinary CSS attributes/text containing
the same characters are unaffected. Use the explicit `ref` descriptor instead.
Arbitrary CDP remains powerful; capture IDs are not authentication credentials
or a site security boundary.

## Actions

All arguments are in `args`; unknown keys are rejected before attachment.
`timeoutMs` is a top-level deadline, defaults to 10000, and must be between 1 and
120000. Zero does not mean an unbounded operation.

| Actions | Arguments |
| --- | --- |
| `engineInfo`, `snapshot` | none |
| `snapshotAI` | optional positive integer `maxBytes`, `maxNodes`, `maxRefs`, `maxFrames`, `maxDepth`; no locator |
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
Consequently, start a `waitForURL` after the action that triggers navigation;
putting a waiting call first in a concurrent pair can block the triggering action
behind it. An already reached URL is checked by Playwright, including SPA state.
The monotonic deadline includes time spent in the queue and in attachment;
expiration in the queue does not cancel the action ahead of it. An attachment
that finishes after expiry is cleaned up before any successor can attach.
Ending tab control invalidates queued operations and detaches the Playwright Page,
so pending auto-waits are cancelled. Its deadline detaches before reporting expiry,
including mouse/keyboard methods that lack native timeout options. Transport
timeouts must leave enough time for the requested deadline and cancellation.
An input already delivered to the browser cannot be undone and is never replayed.
Teardown cancels Playwright first and then makes a bounded attempt to drain
native sends and release pressed buttons, keys, touches, and native dragging
before detaching the debugger. Raw CDP and Playwright share one tracker keyed by
the original attachment and root/child session. Input intent is recorded before
the native send; an RPC timeout is not evidence that a `down` never arrived.
Successful `up` completion clears only its matching press. Release uses the
original target and last coordinates, including for out-of-process frames.
Cleanup failure retains the original native attachment and unconfirmed input
for an explicit cleanup retry; an empty later detach must not report success.
Closing the original tab and confirming its removal is the recovery boundary
when native input can no longer be released. Detaching a debugger by itself
does not release captured pointers in Chromium.
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

Diagnostics remains a snapshot API. For a future request or response, use the
independent network wait RPCs below; they do not scan this recorder's history.
Streaming diagnostic subscriptions are not implemented.

## Network request and response waits

Support is advertised by `getInfo.metadata.networkWaitVersion === 1`, independently
of `browserActionProtocolVersion` and `engineInfo`. These are separate RPC methods,
not `browserAction` actions. SDKs and CLI/MCP reject an older extension with
`OBU_NETWORK_WAIT_UNSUPPORTED`; they never substitute diagnostics polling.

Use this order: **arm and await ready → trigger the page action → collect**.
Arm briefly uses the tab's action queue to authorize, attach the shared Playwright
Page and register its listener. The ready acknowledgement proves registration is
complete. The pending listener and collect do not hold that action queue, but a
blocking Python/Go/CLI/MCP collect can occupy the channel needed to send a trigger.
Do not collect first. Cancel the handle when abandoning the operation.

All three methods require the original `session_id`, `turn_id`, `control_epoch`
and `tabId`. The two IDs are nonempty strings of at most 4096 UTF-8 bytes;
`control_epoch` is a positive safe integer and `tabId` a nonnegative safe integer.
SDK handles retain arm's submitted scope even if an end succeeds before its ACK.

| Method | Additional params | Result |
| --- | --- | --- |
| `armNetworkWait` | `event`: `request` or `response`; `match`; optional `timeoutMs` | `{waiterId, remainingMs}` after listener registration |
| `collectNetworkWait` | `waiterId` | First matching event's bounded metadata, or the saved terminal error |
| `cancelNetworkWait` | `waiterId` | `{}`; releases the record without changing the page |

`waiterId` is an opaque nonempty string of at most 128 UTF-8 bytes. `remainingMs`
is the positive remaining arm budget at acknowledgement, rounded up to whole
milliseconds; it is not a fresh timeout. Match fields are:

| Field | Constraint |
| --- | --- |
| `url` | Required nonempty string, at most 4096 UTF-8 bytes |
| `urlMatch` | Optional `exact` (default) or literal `contains` |
| `method` | Optional nonempty string, at most 128 UTF-8 bytes; exact, case-preserving match |
| `status` | Optional integer 100–599; response waits only |

Unknown fields, callbacks and regex conditions are rejected. Matching uses the
full native values before display truncation. Only events delivered after
registration qualify. A request that began earlier can have a qualifying response
after registration. A response means headers/status arrived, not body completion;
HTTP error statuses can match, while a connection failure may never emit response.

The collect result is a plain object, without the `{value, engine}` envelope:

```json
{"event":"response","requestId":"request-1","url":"https://example.test/api/save","method":"POST","resourceType":"fetch","frameUrl":"https://example.test/","status":201,"statusText":"Created"}
```

Required fields are `event`, `requestId`, `url`, `method` and `resourceType`;
response results also require `status`. Optional fields are `frameUrl`,
`redirectedFrom`, `statusText` (response only) and `truncated`. Native response
records supply `statusText`, including the empty string. IDs are attachment-local
and at most 128 bytes. URL/frame URL fields are at most 4096 bytes, method/resource
type 128, status text 1024, and the whole serialized result 16 KiB. Truncation sets
`truncated:true`. Headers, cookies, post data and bodies are not returned.

Arm's `timeoutMs` defaults to 10000 and accepts integers 1–120000. Discovery,
negotiation, connection, client/backend queues and cold attachment consume the
original budget. SDK wrappers reserve an additional 1000 ms for the RPC response;
raw requests and CLI/MCP use the smaller of their transport budget and this
operation budget plus that reserve. The final wire timeout is reduced after
setup; no arm is sent when less than 1 ms of operation time remains.

The first matching candidate must arrive before the original deadline. Its
ownership validation has a separate bounded 10-second budget; a later candidate
cannot replace it. Collect also revalidates ownership before and after waiting,
with bounded 10-second checks. These checks can delay delivery beyond the network
deadline but cannot extend the event matching window. SDK `result` has an
independent read timeout, default 120000 ms; cancel defaults to 10000 ms. Both
accept 1–120000 ms and add the same 1000 ms RPC reserve. A shorter read timeout
does not renew, replay or automatically cancel the backend waiter.

Matched, timed-out and failed records remain readable for 30 seconds from
settlement, including after the original arm deadline; repeated collect returns
the retained result/error. Cancel removes the record immediately and is idempotent
for an unknown handle after ordinary control/ownership checks. Reserved, pending
and retained records all count toward limits of 16 per tab, 32 per session and
128 globally. New arms fail instead of evicting valid records.

Errors use the ordinary JSON-RPC error envelope. Stable network prefixes are
`OBU_NETWORK_WAIT_TIMEOUT`, `OBU_NETWORK_WAIT_EXPIRED`, `OBU_NETWORK_WAIT_LIMIT`,
`OBU_NETWORK_WAIT_FAILED` and the client capability error
`OBU_NETWORK_WAIT_UNSUPPORTED`. Ordinary Pause, stale-epoch and ownership failures
can precede these. Invalid or foreign handles cannot expose another owner's data.
End/finalize, Pause, detach, tab closure, group/window ownership changes and worker
restart invalidate pending and retained waits. Waiters are not persisted; an
ordinary navigation within the same authorized Page attachment can still be the
event's trigger. Session IDs and waiter IDs are routing identities, not credentials.

JS exposes `tab.expectRequest/expectResponse(match, options)` and
`handle.result()/cancel()`. Python uses `expect_request/expect_response`;
Go uses `ExpectRequest/ExpectResponse` and `Result/Cancel`. The Playwright facades
expose the same helpers. BeginTurn does not rebind an old handle, and no failure
automatically re-arms or replays input. See [network wait workflows and acceptance
criteria](network-waits-design.md) for SDK, CLI and MCP examples.

## Build and adapter boundaries

Run `pnpm install --frozen-lockfile` then `pnpm build:chrome-extension`. Load the
generated `dist/chrome-extension-unpacked/`, not the source directory. Packaging
builds this same artifact. Only production files and the pinned upstream ESM
modules are copied; no generated multi-megabyte library is committed.

The build verifies the pinned upstream chunk's SHA-256 and each modified source
shape before applying explicit transport adapters to CRX. Its pointer feedback
observer runs after successful commands and cannot fail or change them.
Separate scoped input hooks track native sends and release for both CRX and the
backend's raw CDP route; they can refuse input while release is in progress.
This does not replace `chrome.debugger.sendCommand` globally. Included LICENSE, NOTICE and
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
unit testing. The backend supplies `authorize`, `onBeforeAttach`, `onAttached`, `onDetached`, `onCommand`, `isInternalEvent`, `inputHooks`, and `aroundAction`
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
interfaces. OBU adapts the pinned native ARIA implementation for the bounded
capture contract documented here; it does not claim support for a newer Playwright API.

The internal `controlSnapshot()` returns copied tab IDs and pending attachment,
release, and action promises for global pause cleanup after the backend fences
new requests. It is not a new wire RPC. Standalone tests that omit `inputHooks`
retain the older CRX-only observation helper; production always uses the shared
tracker. Failed cleanup must not clear backend ownership or its original token.
CRX application detach captures the original target object before awaiting Page
initialization or highlight cleanup. The transport checks this identity before
removing mappings, and `inputHooks.prepareRelease(tabId)` binds its
`release/isCurrent/detach` callbacks to the original backend attachment token.
A late cleanup cannot release or detach a replacement attachment.
Production uses that transport cancellation synchronously, before optional
Playwright recorder/highlight teardown. OBU exposes neither UI API, and waiting
for its teardown first would let existing locator scripts continue. Every new
CRX native command, including Runtime/DOM commands, checks both the global gate
and attachment release state. Cleanup uses a separate native path. This prevents
new commands after cancellation; it cannot undo scripts already sent to a page.

Explicit native detach completion is its Promise, not an assumed `onDetach`
event. The [Chrome debugger API](https://developer.chrome.com/docs/extensions/reference/api/debugger#event-onDetach)
documents that event for browser-terminated connections. An isolated Edge 153
probe observed no event after explicit detach, successfully reattached and
executed a native command, and received `target_closed` when the tab was then
closed. Browser-initiated notifications still invalidate engine state; callers
must not bypass the backend and expect explicit native detach to send one.

Internal rendering-lease `Page.screencastFrame` events are acknowledged only by
the backend. Its synchronous `isInternalEvent` predicate suppresses those events
inside the CRX transport, preventing duplicate acknowledgements by Playwright.
It does not replace global Chrome event delivery or suppress caller-owned
screencasts; all other protocol events still reach Playwright.

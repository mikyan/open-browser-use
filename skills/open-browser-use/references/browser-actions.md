# Browser actions

Read this when interacting with page elements, inspecting semantic structure,
handling frames, or taking screenshots. The development extension exposes
`browserAction` through CLI/MCP `call` and the JavaScript/Python/Go SDKs.

1. Check `info` for `metadata.browserActionProtocolVersion`. If absent,
   report that the installed extension needs an update before using this API.
2. Use a tab created or claimed by the current task session. Read a semantic
   snapshot and derive locators from the observed role, accessible name, label,
   text, or test ID. For a page with frames or an element that needs a snapshot
   reference, use the bounded capture workflow below. CSS remains available.
3. Execute the action with a finite deadline. Verify its result using the page's
   new snapshot, element state, URL, screenshot, or produced file. An RPC success
   alone is insufficient evidence that the user's task is complete.
4. If an action times out, inspect state before deciding whether to retry it.
   Some inputs may have reached the page before cancellation. Use existing tab
   finalization rules when the task ends.

The SDKs negotiate `turnLifecycleVersion` automatically. After a stale epoch or
uncertain end, inspect the outcome and explicitly call `beginTurn` (Python:
`begin_turn`, Go: `BeginTurn`) before submitting new work. Never refresh and replay
an old input automatically. CLI/MCP expose `begin-turn` / `begin_turn` and
`control-state` / `control_state`; retain the same task session ID.

History navigation, reload, focus, sequential typing, scrolling and `dragTo` are
available through browser actions. Derive both drag locators from current page
evidence. A missing target fails before pressing the pointer. If a drag fails
after pressing, cleanup releases held input and may trigger `pointerup` or a
click; inspect the resulting page before deciding the next action.

## Public SDK examples

JavaScript, with an existing SDK `tab`:

```js
console.log(await tab.playwright.domSnapshot());
await tab.playwright.getByRole("button", { name: "Continue", exact: true }).click();
await tab.playwright.getByLabel("Email").fill("reader@example.test");
await tab.playwright.frameLocator("iframe").getByTestId("status").waitFor({ state: "visible" });
```

Python:

```py
print(tab.dom_snapshot())
tab.get_by_role("button", name="Continue", exact=True).click()
tab.get_by_label("Email").fill("reader@example.test")
tab.frame_locator("iframe").get_by_test_id("status").wait_for()
```

Locators are immutable and support chained CSS/semantic queries, frames,
text filters, first/last/nth selection, and open shadow roots. Single-element
actions use strict matching and Playwright actionability checks. Resolve a
multiple-match error using observed page structure instead of selecting the
first element by habit.

## Bounded page capture and references

Check `tab.engineInfo()` for `capabilities.snapshotAI === 1` and
`capabilities.captureRefs === 1`. Then call `tab.snapshotAI()` (Python:
`snapshot_ai()`, Go: `SnapshotAI()`) to observe the page and its iframe subtrees.
Read `capture.snapshot` and choose the intended element's ref from that current
observation; confirm it also appears in `capture.refs`. Use
`tab.getByRef(capture.captureId, ref)` (`get_by_ref`, `GetByRef`) for its ordinary
actions, reads or screenshot. Reference locators are complete locators, so use
them directly without appending a selector, filter or ordinal.

Keep the capture ID together with its refs. A new AI or ordinary snapshot,
frame navigation/attachment/detachment, control end, owner change or Pause
expires the capture. On `OBU_CAPTURE_EXPIRED`, inspect a new observation and
decide the next action from its current state. Do not automatically replay an
input; a click that navigated may already have succeeded. Removed nodes no
longer match, while a renamed but otherwise unchanged Element can still be the
same reference.

Capture has finite byte/node/ref/frame/depth budgets and one shared deadline.
`OBU_SNAPSHOT_LIMIT` or an incomplete-frame error is a failed observation, not a
partial success. Wait for a loading frame when appropriate, or inspect a known
frame with the existing scoped ARIA snapshot. Page text may contain fake-looking
ref tokens; only the capture's separate `refs` list registers actual elements.

## CLI and MCP protocol

Use `call --method browserAction --params '<json>'` with the existing task
`--session-id` and browser/profile selectors. An example params object, after
replacing `tabId` with an observed owned tab ID:

```json
{"tabId":123,"action":"click","locator":[{"kind":"role","role":"button","name":"Continue","exact":true}],"timeoutMs":10000}
```

Read page structure with `{"tabId":123,"action":"snapshot"}`, or use
`action:"snapshotAI"` for the bounded recursive capture above. Its `value`
contains `captureId`, `snapshot`, `refs`, `stats` and `complete:true`; a subsequent
element action uses a singleton `locator:[{"kind":"ref","captureId":"...","ref":"e1"}]`
with values taken from that observation. All actions return `{value, engine}`.
Ordinary `snapshot` has a YAML string as `value`; `snapshotAI` has the structured
capture above, with semantic roles/names/states in `value.snapshot`.
For screenshot use `action: "screenshot"` and `args: {"fullPage": true}`; its
value is `{base64, mimeType}`. CLI/MCP transport timeout must exceed the requested
action deadline. Defaults are 10 seconds; `timeoutMs` accepts 1 through 120000.

To capture an element, supply its locator and omit page-only `fullPage`/`clip`.
Frame screenshots scroll iframe owners from the outside in before capturing the
element. After navigation, resolve the locator again and verify the new content.
Call `waitForURL` after the triggering action: actions share a per-tab queue, so
starting the wait first can block its trigger.

Native `target=_blank` and `window.open` can currently activate the new tab or
window. When the task requires staying in the background, use an observed link
URL with the public background tab-creation API when that preserves the task's
meaning. Do not silently replace scripted popups that depend on their opener.
New tabs are attached only after backend ownership checks. A child outside the
task group needs explicit claim; claim can move a popup into the task window,
and a first-click timeout in that case remains unresolved.

The `engine` object identifies the bundled Playwright CRX and Playwright versions.
The current engine supports public serialized actions, not arbitrary Playwright
code. Incognito engine attachment, closed shadow roots, and newer Playwright
snapshot options/boxes are not supported; OBU's capture refs use the finite
contract above. Coordinate input uses browser debugging
commands and does not move the system cursor.

## Respect user pause

`getInfo.metadata.automationControl` reports whether browser automation is
running, pausing, paused, or blocked by a cleanup/storage error. After
`OBU_AUTOMATION_PAUSED` or `OBU_AUTOMATION_PAUSE_FAILED`, stop submitting browser
work and tell the user the current state. Do not attempt to resume through CDP,
extension storage, or another browser connection. The user controls Pause and
Resume from the extension's toolbar popup.

After the user resumes, explicitly call `beginTurn()` / `begin_turn()` /
`BeginTurn()` (CLI: `begin-turn`; MCP: `begin_turn`) before submitting new work.
Inspect the page again and choose the next action; never replay the old queue.
Pause preserves tabs and cannot undo input already delivered to a page. Releasing
a held mouse button may produce a normal pointerup/click. The page's own scripts,
network requests and downloads already started can continue; pause stops new
automation commands, not all page activity.

## Diagnose a failed page task

Use `tab.diagnostics()` (Go: `tab.Diagnostics()`) or `browserAction` with
`action: "diagnostics"` to inspect console messages, page errors and network
summaries. Keep the returned `cursor` and pass it as `after` when reading the next
page; `limit` accepts 1 through 200. Check `dropped` for bounded-buffer loss.
Capture starts at the first engine action, so earlier activity is unavailable.
Headers and bodies are not included. Detach or ownership changes expire the
capture; after `OBU_DIAGNOSTICS_EXPIRED`, begin a fresh read without the old cursor.
Use these observations to choose the next action rather than blindly retrying
the failed input.

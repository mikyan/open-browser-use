# Browser actions

Read this when interacting with page elements, inspecting semantic structure,
handling frames, or taking screenshots. The development extension exposes
`browserAction` through CLI/MCP `call` and the JavaScript/Python/Go SDKs.

1. Check `info` for `metadata.browserActionProtocolVersion`. If absent,
   report that the installed extension needs an update before using this API.
2. Use a tab created or claimed by the current task session. Read a semantic
   snapshot and derive locators from the observed role, accessible name, label,
   text, or test ID. CSS remains available when those are insufficient.
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

## CLI and MCP protocol

Use `call --method browserAction --params '<json>'` with the existing task
`--session-id` and browser/profile selectors. An example params object, after
replacing `tabId` with an observed owned tab ID:

```json
{"tabId":123,"action":"click","locator":[{"kind":"role","role":"button","name":"Continue","exact":true}],"timeoutMs":10000}
```

Read page structure with `{"tabId":123,"action":"snapshot"}`. The result is
`{value, engine}`; snapshot `value` is YAML containing semantic roles/names/states.
For screenshot use `action: "screenshot"` and `args: {"fullPage": true}`; its
value is `{base64, mimeType}`. CLI/MCP transport timeout must exceed the requested
action deadline. Defaults are 10 seconds; `timeoutMs` accepts 1 through 120000.

The `engine` object identifies the bundled Playwright CRX and Playwright versions.
The current engine supports public serialized actions, not arbitrary Playwright
code. Incognito engine attachment, closed shadow roots, and newer Playwright AI
snapshot refs/boxes are not supported. Coordinate input uses browser debugging
commands and does not move the system cursor.

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

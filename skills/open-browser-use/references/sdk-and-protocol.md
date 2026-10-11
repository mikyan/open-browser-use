# Open Browser Use SDK And Protocol

Read this reference when the task requires multi-step automation, integration into another agent runtime, or direct Browser Use style JSON-RPC calls.

## Connection Model

The Chrome extension starts the native host through Chrome Native Messaging. The native host exposes a local socket and writes the active socket registry so the CLI and SDKs can discover it.

Default route:

```text
agent runtime
  -> open-browser-use CLI, MCP server, or SDK
  -> active Open Browser Use socket
  -> native messaging host
  -> Chrome extension
  -> Chrome tabs / debugger / history / downloads
```

Pass an explicit socket only when the runtime provides one:

```sh
open-browser-use ping --socket /tmp/open-browser-use/example.sock
```

For SDKs, create a client with `socketPath` / `socket_path` / `SocketPath`.
Read that value from the native host's `active.json`: it is a local named pipe
on Windows and a Unix socket on macOS/Linux. Keep host and SDK versions together;
Windows SDKs cannot connect to the old host's AF_UNIX `.sock` endpoint.
For locators and page interaction, read [browser-actions.md](browser-actions.md).

## Browser Session Scope

Use a unique browser session id for each agent task or conversation. Prefer a
stable session/conversation id from the surrounding runtime when it exists;
otherwise create a short unique id such as `obu-<task-slug>-<timestamp>`.

Pass that same id through every CLI command, MCP server, or SDK client used for
the task. Do not rely on the CLI fallback `obu-cli` in agent workflows; it is a
manual convenience fallback and can reuse stale Chrome tab groups from unrelated
tasks.

Install the SDK package from the package registry for your runtime:

```sh
npm install open-browser-use-sdk
pip install open-browser-use-sdk
go get github.com/ifuryst/open-browser-use/packages/open-browser-use-go
```

The Python distribution is named `open-browser-use-sdk`, while the import module
is `open_browser_use`. Go code usually imports the package as `obu`.

## JavaScript SDK Pattern

Use the high-level browser helper for common multi-step flows:

```ts
import { connectOpenBrowserUse } from "open-browser-use-sdk";

const browser = await connectOpenBrowserUse({
  socketPath: "/tmp/open-browser-use/example.sock",
  sessionId: "obu-docs-scan-20260510",
});

try {
  await browser.client.nameSession("Task - OBU");
  const tab = await browser.newTab();
  await tab.goto("https://example.com", { waitUntil: "domcontentloaded" });
  const text = await tab.playwright.domSnapshot();
  console.log(text.slice(0, 4000));
} finally {
  await browser.client.finalizeTabs([]);
  browser.close();
}
```

Use the low-level client when you need direct Browser Use JSON-RPC/CDP calls:

```ts
import { OpenBrowserUseClient } from "open-browser-use-sdk";

const client = new OpenBrowserUseClient({
  socketPath: "/tmp/open-browser-use/example.sock",
  sessionId: "obu-docs-scan-20260510",
});

await client.connect();
await client.nameSession("Task - OBU");
const tab = await client.createTab() as { id: number };
await client.executeCdp(tab.id, "Page.navigate", { url: "https://example.com" });
await client.finalizeTabs([]);
client.close();
```

The JavaScript SDK supports notification handlers:

```ts
const unsubscribe = client.onNotification((event) => {
  if (event.method === "onDownloadChange") {
    console.log(event.params);
  }
});
```

## Python SDK Pattern

```py
import json
from pathlib import Path

from open_browser_use import connect_open_browser_use

registry = json.loads(Path("/tmp/open-browser-use/active.json").read_text())
browser = connect_open_browser_use(
    socket_path=registry["socketPath"],
    session_id="obu-issue-scan-20260510",
)

try:
    browser.client.name_session("Issue scan - OBU")
    tab = browser.new_tab()
    tab.goto("https://github.com/iFurySt/open-codex-computer-use/issues", wait_until="domcontentloaded")
    tab.playwright.wait_for_load_state(state="domcontentloaded", timeout=15)
    tab.playwright.wait_for_timeout(1500)

    text = tab.playwright.locator("body").inner_text(timeout_ms=10000)
    result = {
        "title": tab.title(),
        "url": tab.url(),
        "text": text[:4000],
    }
    print(result)
finally:
    browser.client.finalize_tabs([])
    browser.close()
```

Use the low-level client when you need raw JSON-RPC/CDP calls:

```py
from open_browser_use import OpenBrowserUseClient

client = OpenBrowserUseClient(
    socket_path="/tmp/open-browser-use/example.sock",
    session_id="obu-docs-scan-20260510",
)

client.name_session("Task - OBU")
tab = client.create_tab()
client.execute_cdp(tab["id"], "Page.navigate", {"url": "https://example.com"})
client.finalize_tabs([])
client.close()
```

## Go SDK Pattern

```go
package main

import (
	"fmt"
	"log"
	"time"

	obu "github.com/ifuryst/open-browser-use/packages/open-browser-use-go"
)

func main() {
	browser, err := obu.ConnectActive(obu.Options{
		SessionID: "obu-issue-scan-20260510",
		Timeout:   20 * time.Second,
	})
	if err != nil {
		log.Fatal(err)
	}
	defer browser.Close()
	defer browser.Client.FinalizeTabs(nil)

	if _, err := browser.Client.NameSession("Issue scan - OBU"); err != nil {
		log.Fatal(err)
	}
	tab, err := browser.NewTab()
	if err != nil {
		log.Fatal(err)
	}
	if _, err := tab.Goto("https://example.com", obu.GotoOptions{
		WaitUntil: obu.LoadStateDOMContentLoaded,
		Timeout:   15 * time.Second,
	}); err != nil {
		log.Fatal(err)
	}
	title, err := tab.Title()
	if err != nil {
		log.Fatal(err)
	}
	fmt.Println(title)
}
```

Use the low-level client when you need raw JSON-RPC/CDP calls:

```go
client := obu.NewClient(obu.Options{
	SocketPath: "/tmp/open-browser-use/example.sock",
	SessionID:  "obu-docs-scan-20260510",
})
defer client.Close()

tab, err := client.CreateTab()
if err != nil {
	log.Fatal(err)
}
tabID := int(tab.(map[string]any)["id"].(float64))
if _, err := client.ExecuteCDP(tabID, "Page.navigate", obu.Params{"url": "https://example.com"}); err != nil {
	log.Fatal(err)
}
_, _ = client.FinalizeTabs(nil)
```

## Core Methods

Common Browser Use JSON-RPC methods:

- `ping`
- `getInfo`
- `createTab`
- `getTabs`
- `getUserTabs`
- `getUserHistory`
- `claimUserTab`
- `finalizeTabs`
- `nameSession`
- `attach`
- `detach`
- `executeCdp`
- `webmcp_list_tools`
- `webmcp_invoke_tool`
- `moveMouse`
- `waitForFileChooser`
- `setFileChooserFiles`
- `waitForDownload`
- `downloadURL`
- `downloadPath`
- `cancelDownload`
- `armNetworkWait`
- `collectNetworkWait`
- `cancelNetworkWait`
- `readClipboardText`
- `writeClipboardText`
- `readClipboard`
- `writeClipboard`
- `turnEnded`

CLI unrestricted call:

```sh
open-browser-use call --session-id "$OBU_SESSION_ID" --method getInfo --params '{}'
open-browser-use call --session-id "$OBU_SESSION_ID" --method executeCdp --params '{"target":{"tabId":123},"method":"Runtime.evaluate","commandParams":{"expression":"document.title"}}'
```

### History search

Use `queries` to cover several search terms in one `getUserHistory` request
instead of calling once per term. The existing `query` input still works
for a single term:

```sh
open-browser-use call \
  --session-id "$OBU_SESSION_ID" \
  --method getUserHistory \
  --params '{"queries":["design guide","api reference"],"limit":20}'
```

Results keep the `{ url, title?, dateVisited }` shape, are ordered by newest
visit with one entry per URL, and `limit` applies to the merged list.
Without `from`, the search covers all retained history. Invalid inputs fail
before Chrome is queried. The dedicated `history` CLI/MCP command takes a
single `query`; use `call` or an SDK history wrapper for multiple terms.

### WebMCP page tools

The Chrome route can discover and invoke tools registered by the current
top-level page through `document.modelContext`. If the browser does not expose
that API natively, the MAIN-world content script installs a small compatible
shim at `document_start` so page code can still call `registerTool`. Check
`getInfo` first. The tab capability list contains `{"id":"webmcp",...}` only
when the extension WebMCP gate and content-script registration are active.

The target tab must already belong to the current Open Browser Use session.
Create it with `open-tab`, or list user tabs and claim the chosen tab first.

List the current tool snapshot:

```sh
open-browser-use call \
  --session-id "$OBU_SESSION_ID" \
  --method webmcp_list_tools \
  --params '{"tabId":123}'
```

The result has this shape:

```json
{
  "tools": [
    {
      "name": "book_table",
      "registration_id": "opaque-snapshot-id",
      "title": "Book table",
      "description": "Book a table.",
      "input_schema": {
        "type": "object"
      },
      "annotations": {
        "readOnlyHint": false,
        "untrustedContentHint": true
      },
      "origin": "https://example.com",
      "pageUrl": "https://example.com/reservations"
    }
  ]
}
```

Invoke a tool from that exact snapshot:

```sh
open-browser-use call \
  --session-id "$OBU_SESSION_ID" \
  --method webmcp_invoke_tool \
  --params '{"tabId":123,"tool_name":"book_table","registration_id":"opaque-snapshot-id","input":{"partySize":4},"timeout_ms":10000}'
```

The response is `{"result":<json-value>}`. Treat `registration_id` as opaque.
List tools again after a `toolchange`, navigation, or stale-registration error.
Running `webmcp_list_tools` creates a new snapshot and invalidates IDs from the
previous snapshot.

The command names and result field names follow the WebMCP page tool
specification. Open Browser Use keeps its existing transport envelope with
integer Chrome `tabId`, `session_id`, and `turn_id`. It does not add a second
`browser_id` routing layer.

CLI action plan:

```sh
export OBU_SESSION_ID="obu-docs-scan-$(date +%Y%m%d%H%M%S)"
open-browser-use run --session-id "$OBU_SESSION_ID" -c '
name-session "Docs scan - OBU"
open-tab https://docs.browser-use.com
wait-load domcontentloaded
page-info
finalize-tabs []
'
```

The action plan format is intentionally small: one action per line, comments
with `#`, shell-like quotes, shared session/turn, and a default tab set by
`open-tab` or `claim-tab`. Supported actions include `ping`, `info`, `tabs`,
`user-tabs`, `history`, `name-session`, `open-tab`, `claim-tab`, `navigate`,
`wait-load`, `page-info`, `cdp`, `move-mouse`, `wait-file-chooser`,
`set-file-chooser-files`, `finalize-tabs`, `turn-ended`, `begin-turn`,
`control-state`, and `call`.

## MCP Server

Use the stdio MCP server when the surrounding runtime supports local MCP tools:

```toml
[mcp_servers.open_browser_use]
command = "obu"
args = ["mcp", "--session-id", "obu-<task-or-conversation-id>"]
```

`obu mcp` speaks newline-delimited JSON-RPC on stdin/stdout. It handles
`initialize`, `ping`, `tools/list`, and `tools/call`, and exposes tools that
mirror the CLI action surface:

- `ping`, `info`, `tabs`, `user_tabs`, `history`
- `open_tab`, `claim_tab`, `navigate`, `wait_load`, `page_info`
- `cdp`, `move_mouse`, `wait_file_chooser`, `set_file_chooser_files`
- `name_session`, `finalize_tabs`, `turn_ended`, `begin_turn`, `control_state`, `call`, `run_action_plan`

Pass `--socket` or `--socket-dir` in the MCP `args` only when the runtime needs
an explicit Open Browser Use socket. Otherwise the server uses the same socket
discovery as the CLI. Pass a fresh `--session-id` for each agent task or
conversation.

SDK request escape hatch:

```ts
await browser.client.request("executeCdp", {
  target: { tabId: 123 },
  method: "Runtime.evaluate",
  commandParams: { expression: "document.title" },
});
```

```py
browser.client.request("executeCdp", {
    "target": {"tabId": 123},
    "method": "Runtime.evaluate",
    "commandParams": {"expression": "document.title"},
})
```

```go
_, err := browser.Client.Request("executeCdp", obu.Params{
	"target":        obu.Params{"tabId": 123},
	"method":        "Runtime.evaluate",
	"commandParams": obu.Params{"expression": "document.title"},
})
```

## User Tab Claiming

1. List open user tabs with `open-browser-use user-tabs --session-id "$OBU_SESSION_ID"` or SDK `getUserTabs`.
2. Select the tab from returned data using visible evidence: title, URL, recency, and group.
3. Claim it with `open-browser-use claim-tab --session-id "$OBU_SESSION_ID" --tab-id <id>` or SDK `claimUserTab` / `claim_user_tab` / `ClaimUserTab`.
4. Use the returned controllable tab for later commands.

For a tab in an independent popup, check `metadata.auxiliaryTabsVersion === 1`.
Claim preserves that popup window and keeps membership across worker restart,
turn end, and Pause. A full browser restart requires a fresh explicit claim.
Concurrent foreign claims and claims during unconfirmed cleanup fail. If claim
times out, inspect state before retrying: pending native storage remains tracked,
and end can remain `closing` until it settles.

Never invent or reuse stale tab ids.

## Tab Cleanup

Before ending browser work, finalize exactly once for the active session:

```sh
open-browser-use finalize-tabs --session-id "$OBU_SESSION_ID" --keep '[]'
```

Omit tabs by default. Keep a tab only when the user needs that live page after
the turn. Use `status: "deliverable"` for a user-facing output or requested
open page. Use `status: "handoff"` only when the task is still in progress and
the user or a later turn should continue from the current task group, such as a
page waiting for login, approval, payment, CAPTCHA, or other user input.

Independent auxiliary popups are the exception: use `handoff` whenever their
membership should be retained. `deliverable` is rejected before ending control
because grouping would move the popup. Omitting a popup releases its ownership
without closing or moving the window.

Treat finalization as the last Open Browser Use browser action of the turn. If
more browser work is needed, do it before finalizing, then finalize once with
the final tab disposition.

## Navigation waits

Check `getInfo.metadata.navigationWaitVersion === 1`. Use an owned tab, a URL
derived from the task/page and an observed trigger:

```js
const pending = await tab.expectURL(destinationURL, { timeoutMs: 5000 });
try {
  await tab.getByRole("button", { name: "Continue", exact: true }).click();
  await pending.result();
  console.log(await tab.domSnapshot());
} finally {
  await pending.cancel().catch(() => {});
}
```

Python uses `tab.expect_url(destination_url, wait_until="load", timeout_ms=5000)`
then synchronous trigger, `pending.result()` and `pending.cancel()`. Go uses
`tab.ExpectURL(destinationURL, obu.NavigationWaitOptions{WaitUntil: "load",
Timeout: 5 * time.Second})`, then trigger, `Result()` and `Cancel()` with normal
error checks. Load-state forms are `expectLoadState({state:"load",timeoutMs:5000})`,
`expect_load_state(state="load", timeout_ms=5000)` and
`ExpectLoadState(obu.NavigationWaitOptions{State:"load", Timeout:5*time.Second})`.
The Playwright facades expose the same helpers.

URL waits use native exact/glob strings, at most 4096 UTF-8 bytes. `waitUntil`
accepts `commit`, `domcontentloaded`, `load` or `networkidle`; load-state `state`
accepts the last three. Both default to `load`. Matching the current URL or a
cached load state may finish immediately, so neither promises the next navigation.
No executable predicates or serialized regular expressions are accepted.

| RPC through CLI/MCP `call` | Extra fields besides fixed scope and `tabId` | Success |
| --- | --- | --- |
| `armNavigationWait` | `event:"url"`, `url`, `waitUntil?`, `timeoutMs?`; or `event:"loadstate"`, `state?`, `timeoutMs?` | `{waiterId, remainingMs}` after native readiness |
| `collectNavigationWait` | `waiterId` | `{}`; SDK handle result returns void/None/error |
| `cancelNavigationWait` | `waiterId` | `{}` |

Keep arm's exact `session_id`, `turn_id`, positive `control_epoch` and `tabId`
for collect/cancel. The timeout is 1–120000 integer milliseconds, default 10000,
including discovery, negotiation and setup. Collect never extends the observer's
deadline. Terminal results/errors remain for 30 seconds; cancel releases them.
Limits include pending and terminal records: 16/tab, 32/session and 128 total.
End, Pause, detach, ownership changes and worker restart invalidate old handles.
New turns do not revive them. Cancel a failed trigger's handle without masking
the original error; never re-arm and replay automatically. Direct blocking URL
and load waits remain available but are completion calls, not ready ACKs.

## Network event waits

Use this sequence for a request/response caused by a page action: **await ready,
trigger, collect, cancel**. Check `getInfo.metadata.networkWaitVersion === 1`;
older extensions fail with `OBU_NETWORK_WAIT_UNSUPPORTED`. Do not replace a
missing capability with diagnostics polling or a guessed sleep.

With an owned `tab`, a URL derived from the page/task, and an observed Save button:

```js
const pending = await tab.expectResponse(
  { url: apiURL, method: "POST", status: 200 }, { timeoutMs: 5000 });
try {
  await tab.getByRole("button", { name: "Save", exact: true }).click();
  const response = await pending.result();
  console.log(response.requestId, response.status);
} finally {
  await pending.cancel().catch(() => {});
}
```

Python's equivalent is `tab.expect_response(match, timeout_ms=5000)`, followed
by the synchronous trigger and `pending.result()` / `pending.cancel()`.
Go uses `tab.ExpectResponse(obu.NetworkWaitMatch{URL: apiURL, Method: "POST",
Status: 200}, obu.NetworkWaitOptions{Timeout: 5 * time.Second})`, followed by
the trigger and `pending.Result()` / `pending.Cancel()` with normal error checks.
Request variants are `expectRequest`, `expect_request` and `ExpectRequest`.
All methods are also on the Playwright facade. Preserve the trigger's error when
best-effort cancellation fails; do not report cleanup failure as successful work.

Match `url` is required and nonempty, at most 4096 UTF-8 bytes. `urlMatch` is
`exact` by default or literal `contains`; optional `method` is nonempty, at most
128 bytes, and matched without changing case. Only response waits accept `status`,
an integer 100–599. There are no regexes or executable predicates; unknown fields
are rejected. Go uses `URLMatch`, `Method` and `Status`, with empty/zero optional
values omitted. Matching uses complete native values before display truncation.

Results include `event`, `requestId`, `url`, `method`, `resourceType`, optional
`frameUrl` and `redirectedFrom`, and response `status`/`statusText`. They contain
no headers, cookies or bodies, and are limited to 16 KiB with `truncated:true`
when shortened. Verify the fields and page state required by the task. HTTP error
statuses are still responses; a broken connection may never produce one.

Arm defaults to 10000 ms and accepts integer 1–120000 ms, including connection,
negotiation and queue time. SDK result reads default to an independent 120000 ms
budget; cancel defaults to 10000 ms. Both accept the same range and add one second
of RPC response allowance. Reading never renews the original network deadline.
Matched results and terminal errors remain readable for 30 seconds after
settlement; cancel frees them immediately. Capacity is bounded at 16 per tab,
32 per session and 128 globally, including reserved and retained records.

For CLI/MCP, the same workflow uses independent RPCs through `call`:

| Method | Params in addition to original scope and `tabId` | Success |
| --- | --- | --- |
| `armNetworkWait` | `event: "request"` or `"response"`, `match`, optional `timeoutMs` | `{waiterId, remainingMs}`: listener ready |
| `collectNetworkWait` | `waiterId` | Matched metadata, without a browserAction `{value, engine}` wrapper |
| `cancelNetworkWait` | `waiterId` | `{}` |

Read `control-state` / `control_state` once and retain its `controlEpoch` and
`nextTurnId` with your task session ID. Explicitly pass these as `control_epoch`,
`turn_id`, `session_id` to every step when using separate CLI processes. For MCP,
use the `call` tool with `arguments: {method, params}` and await each ready reply
before triggering. Check RPC errors and MCP `isError` as well as nested backend
errors; the tool's `structuredContent.result` holds a successful backend result.
Set a finite CLI/MCP `--timeout` long enough for the intended read; it is a total
transport budget. Do not put `timeoutMs` in collect/cancel params. A default
10-second transport timeout can end a longer read early.

The handle always belongs to arm's original session, turn, epoch and attachment.
Do not fetch a newer epoch or begin a new turn to read an old handle. Pause,
control end, detach, tab close, group/window ownership changes and restart
invalidate both pending and retained records. Ordinary navigation on the same
authorized Page attachment can still trigger the wait. `OBU_NETWORK_WAIT_EXPIRED`
means the handle is unavailable; `OBU_NETWORK_WAIT_TIMEOUT` means its original
event deadline expired; `OBU_NETWORK_WAIT_LIMIT` means capacity is full;
`OBU_NETWORK_WAIT_FAILED` indicates a bounded processing/ownership-check failure.
Stale-control and Pause errors may occur first. Inspect the current page and
decide fresh work explicitly; never automatically re-arm or replay the trigger.

The pending listener does not hold the tab's action queue, but collecting first
can occupy a synchronous client or MCP channel and prevent its trigger. The
ready-first APIs for file choosers and page downloads use their own capability
versions and handles, described below.

## File Chooser Pattern

1. Start waiting with `wait-file-chooser --tab-id <id>` or SDK `waitForFileChooser` / `wait_for_file_chooser` / `WaitForFileChooser`.
2. Trigger the file picker in the page, usually through a click driven by CDP or a higher-level automation layer.
3. Set absolute file paths:

```sh
open-browser-use set-file-chooser-files --file-chooser-id <id> --file /absolute/path/file.txt
```

Use repeated `--file` values or comma-separated paths for multiple files.

Register the waiter before triggering input. In JavaScript, start both without
waiting for the chooser result before the click:

```js
const [chooser] = await Promise.all([
  browser.client.waitForFileChooser(tab.id, 10000),
  tab.getByLabel("Upload", { exact: true }).click(),
]);
await browser.client.setFileChooserFiles(chooser.fileChooserId, [absoluteFilePath]);
```

Use the actual observed file-input label and a user-authorized local file. The
extension synchronizes interception setup with the click and retains OOPIF
chooser ownership. An empty files array clears the selected input. Python and Go
waiters are blocking: use a separate client with the same session for the trigger,
and keep their control epoch current. Ending or detaching invalidates old chooser
handles and cancels outstanding waits.

For sequential clients or triggers on another connection, check
`getInfo.metadata.fileChooserWaitVersion === 1` and use the ready handle:

```js
const wait = await tab.expectFileChooser({ timeoutMs: 10000 });
try {
  await tab.getByLabel("Upload", { exact: true }).click();
  const chooser = await wait.result();
  await browser.client.setFileChooserFiles(chooser.fileChooserId, [absoluteFilePath]);
} finally {
  await wait.cancel();
}
```

Python exposes `tab.expect_file_chooser(timeout_ms=10000)`, followed by
`result()` and `cancel()`; Go exposes `tab.ExpectFileChooser`, `Result` and
`Cancel`. CLI/MCP generic calls use `armFileChooserWait`,
`collectFileChooserWait` and `cancelFileChooserWait` with the same tab, session,
turn, control epoch and waiter ID. Arm acknowledges native interception before
the click; collect uses the original deadline. A new thread, process or sleep is
not a readiness signal. Each delivered chooser permits one submission; after an
uncertain failure, inspect the page before explicitly deciding any new upload.

### Directory uploads and background windows

For a page's observed `webkitdirectory` input, check
`getInfo.metadata.fileChooserDirectoryVersion === 1`. Pass exactly one absolute
directory path. The setter waits for native selection completion on the original
input; its success means the `FileList` is populated, so still verify the website's
upload result. `[]` explicitly clears the input; choosing an empty directory is a
different operation. An optional setter timeout is 1–120000 ms, default 10000.

Chromium cancels directory enumeration for an inactive or hidden page. For a new
directory-upload task, check `backgroundWindowVersion === 1` and create its page
with `browser.newTab({backgroundWindow: true, url})` before navigating or filling
the workflow. CLI uses `open-tab --background-window --url <url>`; MCP `open_tab`
uses `background_window: true`; Python uses `new_tab(..., background_window=True)`.
Go offers `NewTabWithOptions` and `CreateTabWithOptions` with `BackgroundWindow`.
This creates a visible, unfocused window with its own selected tab. It keeps the
system mouse and the user's current window unchanged. Use an existing page only
when its original state is suitable; preserve it if recreating the workflow would
lose unsaved state. Never move or activate an existing page automatically to
work around a cancellation.

Keep the task window unminimized. Finalize the same session: omitted agent pages
close, while other tabs later added to that window survive. A cancellation or
timeout does not authorize replay; directory enumeration can outlive the caller.

### Page-triggered download waits

Download waits similarly register before the trigger and return an opaque
task-scoped GUID. Do not infer a local path or reuse another task's download ID.
The extension reports `OBU_DOWNLOAD_PATH_UNAVAILABLE` for Page GUID path lookup.
This limitation does not prevent uploading known local files.
With `downloadWaitVersion === 1`, `expectDownload` / `expect_download` /
`ExpectDownload` offer the same arm, trigger, result and cancel sequence.

## Direct Downloads

When the user authorizes downloading a known HTTP(S) resource with GET, check
`getInfo.metadata.directDownloadsVersion === 1` and use `tab.downloadURL(url,
{filename, timeoutMs})`. It returns a handle whose `path({timeoutMs})` waits for
completion and whose `cancel({timeoutMs})` cancels that exact download. `filename`
is optional and must be a single basename. The browser selects a unique filename
in its configured Downloads directory; the API does not accept an absolute path.

This makes a new request using browser cookies. It is suitable for a directly
downloadable URL, not a replacement for an already-triggered page download, a
POST form, a blob URL, or an expiring single-use link. The extension requests
`saveAs:false` but browser settings or policy may still show confirmation UI.
The returned path is browser metadata; read the file separately to verify bytes.

CLI `call` and MCP `call` use the same protocol:

1. `downloadURL` with `tabId`, `url`, optional `filename`, and `timeoutMs` returns
   `{downloadId}` after binding the native API's exact ID.
2. `downloadPath` with that `downloadId` and `timeoutMs` returns `{path}` once
   complete. A path timeout stops waiting; it does not restart or cancel the GET.
3. `cancelDownload` with that `downloadId` and `timeoutMs` returns `{cancelled:true}`
   after the native cancellation call. Cancellation does not delete a finished file.

Keep the original `session_id`, `turn_id`, and positive `control_epoch` across
these calls. SDK handles retain them. Ending, detaching, transferring ownership,
Pause, or worker replacement invalidates the handle; begin-turn does not revive
it. Live-worker cleanup attempts to cancel explicitly initiated pending downloads;
failed cancellation remains tracked and must be retried before Pause can succeed.
A worker restart can lose their in-memory IDs; do not assume it stopped
the browser's transfer. Page-triggered downloads still use the separate GUID flow.

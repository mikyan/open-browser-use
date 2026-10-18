# Managed Browser Sessions

Read this before browser commands when the user or runtime specifies a managed
session, or asks to create an isolated one. Managed sessions currently require
Windows 10 or newer. They run a dedicated headless Chromium with its own profile
and a local viewer; they do not use the ordinary connected-profile registry.
Ordinary company Edge installation follows [installation.md](installation.md)
and does not require this workflow.

Use the executable, extension, and SDKs from the same compatible build. Check the
installed `VERSION.txt` and `managed --help`. The published
`preview-20261018-853ea92` includes explicit recovery after an extension worker
replacement while the original browser remains alive, as well as Native
reconnection in a surviving worker. The older `preview-20261017-6588984` supports
only the latter. Recovery requires confirmed original identities and cleanup;
this guide does not extend the tested browser, input, or platform scope.

## Establish the exact session

1. Keep the name/root provided by the user or runtime. If creating a session is
   already authorized, choose a task-appropriate name and a dedicated absolute
   data root. A name starts with a lowercase letter and contains 1–48 lowercase
   letters, digits, or hyphens; Windows device names are unavailable. Keep the
   data root separate from the installation and use a reasonably short path.
   If root was omitted, the default is `%APPDATA%\OpenBrowserUse\managed`.

   Example PowerShell variables used below:

   ```powershell
   $obuExe = 'D:\Tools\OpenBrowserUse\open-browser-use.exe'
   $managedName = 'work'
   $managedRoot = 'D:\BrowserData\OBU'
   $taskSession = 'obu-task-' + [guid]::NewGuid().ToString('N')
   ```

2. Inspect an existing session with `managed status`. A `ready` response must
   identify the expected `info.name`, matching `runId` / `info.runId`, and a
   nonempty `info.socketPath`.
   `setup` is for manual login, not Agent connections. `degraded` requires the
   recovery procedure below; `recovering` is not ready. An unreachable supervisor
   is not permission to create a replacement run or change browser targets.

   ```powershell
   & $obuExe managed status --name $managedName --root $managedRoot
   ```

3. To start an authorized new session, first ensure its browser is installed.
   `managed browser status` only checks the local cache. If browser installation
   is needed and within the task's authorization, `managed browser install`
   explicitly downloads and verifies the recommended browser. `run` never
   downloads a browser or falls back to a daily browser.

   ```powershell
   & $obuExe managed browser status
   # If installation is needed:
   & $obuExe managed browser install
   # Keep this foreground process running in its own terminal:
   & $obuExe managed run --name $managedName --root $managedRoot
   ```

   An explicit compatible Chromium can be selected with `--browser-path`;
   `--extension-dir` defaults to `extension` beside the EXE. If a custom
   `--browser-cache` is used, pass the same path to install, status, and run.
   Proceed only after the real `state: "ready"` response, then read status in
   another terminal. Keep the supervisor alive for the entire task.

   If manual login preparation is needed, use `managed setup --name ... --root ...`
   with the same dedicated profile before `run`. Setup opens a visible browser
   without the task extension or Agent endpoint. Finish login and close the whole
   setup browser, waiting for its process to exit before run. Setup/run cannot
   share the profile concurrently. Do not copy login data from a daily profile.

The managed name/root selects a persistent dedicated profile. `runId` identifies
one live run; the task `sessionId` identifies Agent tab ownership; a turn and its
control epoch identify current control. Keep these identities distinct. Reuse
one task session ID across the five entry points for the same task, not across
unrelated tasks.

## Connect through the five entry points

CLI and MCP resolve a live managed session by name/root. The selectors do not
start, restart, recover, or resume it. `--managed` is mutually exclusive with
`--browser`, `--profile`, `--socket`, and `--socket-dir`; `--managed-root` requires
`--managed`.

### CLI

Include the same managed selectors and task session on every browser command:

```powershell
& $obuExe info --managed $managedName --managed-root $managedRoot --session-id $taskSession
& $obuExe name-session --managed $managedName --managed-root $managedRoot --session-id $taskSession --name 'Task - OBU'
& $obuExe user-tabs --managed $managedName --managed-root $managedRoot --session-id $taskSession
```

Use these selectors on `run`, `claim-tab`, page actions, and `finalize-tabs` too.
Management commands instead use `managed <operation> --name ... --root ...`.

### MCP

Pin the server at startup, substituting the selected name/root and task session:

```toml
[mcp_servers.open_browser_use_managed]
command = 'D:\Tools\OpenBrowserUse\open-browser-use.exe'
args = ["mcp", "--managed", "work", "--managed-root", 'D:\BrowserData\OBU', "--session-id", "obu-<task-id>"]
```

Browser tools such as `user_tabs`, `claim_tab`, `run_action_plan`, and
`finalize_tabs` inherit this routing. Do not pass routing selectors as per-tool
arguments. Lifecycle commands such as `managed recover` use the CLI, not an
invented MCP tool.

### JavaScript SDK

The SDKs have no managed-name resolver. Parse the current successful
`managed status` response in the runtime and validate its ready state and expected
session identity before extracting `info.socketPath`. This exact Windows named
pipe is the only endpoint for the SDK examples below. Do not read `active.json`
or use an ordinary-profile fallback. `taskSession` denotes the chosen task ID.

```ts
import { connectOpenBrowserUse } from "open-browser-use-sdk";

const browser = await connectOpenBrowserUse({
  socketPath: status.info.socketPath,
  sessionId: taskSession,
});
```

### Python SDK

Here `status` is the same parsed, validated status response and `task_session`
is the task ID:

```py
from open_browser_use import connect_open_browser_use

browser = connect_open_browser_use(
    socket_path=status["info"]["socketPath"],
    session_id=task_session,
)
```

### Go SDK

Here `socketPath` is extracted from that validated `info.socketPath`, and
`taskSession` is the task ID. Handle the returned error before using the browser:

```go
import obu "github.com/ifuryst/open-browser-use/packages/open-browser-use-go"

browser, err := obu.ConnectOpenBrowserUse(obu.Options{
    SocketPath: socketPath,
    SessionID:  taskSession,
})
```

For all three SDKs, use the explicit connection methods above instead of active
socket discovery. Read [browser-actions.md](browser-actions.md) for page work and
[sdk-and-protocol.md](sdk-and-protocol.md) for typed waiters, downloads, uploads,
dialogs, and finalization; keep the managed endpoint when adapting its ordinary
profile examples.

## Work on original pages and deliver the result

1. List current user tabs, then claim the observed matching page, including an
   earlier deliverable. Create a page only when the task needs one and no matching
   original page exists. Name the task group and use observed element locators.
2. Before an action that opens a child page or starts a download, arm the typed
   waiter on the original tab, trigger the action once, collect the original
   result, and cancel the waiter when finished. Inspect page content before
   submitting forms. Keep actual receipts and original download bytes; a timeout
   is an unknown outcome, not a reason to submit or download again.
3. Finalize the task's tabs with CLI `finalize-tabs`, MCP `finalize_tabs`, JS
   `browser.client.finalizeTabs`, Python `browser.client.finalize_tabs`, or Go
   `browser.Client.FinalizeTabs`. Keep only live pages needed by the user, with
   `status: "deliverable"` for results or `"handoff"` for unfinished work.
   Check the actual finalization response before reporting delivery.

Finalization releases task control and closes unkept task tabs. It does not close
the managed browser. The viewer can show a finalized original page as a delivered
result, including while the Agent is paused. The user may explicitly operate
that result page without resuming the Agent. Read-only viewing itself grants no
input control. A later authorized Agent task lists and reclaims the live result
page; it does not reopen its old URL or replay its submission.

## View, pause, and start new work

```powershell
& $obuExe managed view --name $managedName --root $managedRoot
```

`view` returns a fresh local, one-use viewer link for a healthy session. Opening
it is a user action; keep the full credential-bearing URL local and out of task
logs, prompts, and websites. One viewer connection is supported at a time.
Issuing another link waits for prior viewer cleanup. Viewing does not use the
system mouse, and stopping the frame subscription does not pause Agent work.

Pause revokes the old task control and waits for cleanup. Human takeover also
pauses the Agent; completing takeover leaves it paused. Wait for an actual cleanup
acknowledgement, and let the user explicitly select Resume/Continue before new
Agent actions. `ready` reports connection availability, not permission to bypass
Pause. Neither `managed view` nor a new task client resumes the Agent.

After Resume, start a new turn and obtain fresh page handles from current tabs:

| Entry point | Explicit new-turn operation |
| --- | --- |
| CLI | `begin-turn` with the same managed selectors and task session |
| MCP | `begin_turn` |
| JavaScript | `await browser.client.beginTurn()` |
| Python | `browser.client.begin_turn()` |
| Go | `browser.Client.BeginTurn()` |

Only newly submitted work belongs to the new turn. Old page waiters, scoped child
handles, queued actions, and uncertain inputs are not revived. A new-turn call
does not reconnect a lost transport; use the recovery procedure in that case.

## Recover explicitly after a connection loss

1. Stop issuing browser actions and read `managed status` for the same name/root.
   Preserve unknown outcomes. `managed view` cannot repair a degraded connection.
2. Within the user's existing authorization to restore this session, explicitly run:

   ```powershell
   & $obuExe managed recover --name $managedName --root $managedRoot
   ```

3. Require a successful `recovered` response for the original `runId`, then read
   status again. Recovery must preserve the original browser and pages; success
   publishes a new Native connection and a new private viewer link. The Agent
   remains paused. Discard the old endpoint binding, viewer link, and page handles.
   Restart a disconnected MCP server with the same name/root, or create a new SDK
   client using the current status endpoint. Explicit Resume and a new turn are
   still required before Agent page operations.
4. If recovery is rejected because cleanup or an input outcome is unknown, keep
   the failure visible. Never manufacture success by reopening a URL, relaunching
   the browser, resubmitting a form, replaying input, or synthesizing key releases.
   Use Stop when ending the session is within the user's intended scope.

Apply the build boundary at the top of this reference: a worker replacement in
6588984 cannot be recovered by treating a new worker as the old one. Worker
replacement recovery in 853ea92 still rejects uncertain held input. Neither a
timeout nor a disconnected viewer proves that input was released.

## Stop the whole session

Save or export needed results first. Stop closes all pages in the dedicated
browser, including finalized deliverables; it is different from Pause, ending
human takeover, or finalizing task tabs.

```powershell
& $obuExe managed stop --name $managedName --root $managedRoot
```

The foreground run can also be stopped with Ctrl+C. Report shutdown success only
after the original session's successful Stop/cleanup result. A timeout or lost
connection leaves the outcome unknown. Terminating the owned browser after an
unknown held input proves session termination, not a keyup or mouseup release.

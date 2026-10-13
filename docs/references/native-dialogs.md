# Native JavaScript dialog decisions

Status: implemented through all five public entry points. Ordinary alert,
confirm and prompt decisions passed isolated Chromium background workflows.
Beforeunload background acceptance failed and remains an explicit limitation;
this is not completed cross-browser or full Browser Use parity.

## Contract

Prepare one decision before triggering the page:

1. Await `expectDialog` / `expect_dialog` / `ExpectDialog`, or `armDialog`.
2. Trigger the original page action once.
3. Collect the decision result and verify the page's business outcome separately.
4. Cancel the handle in `finally` / deferred cleanup, including after a trigger
   failure. Preserve the original error if cancellation also fails.

One decision may be live per tab. Readiness confirms that the original Page's
dialog subscription was acknowledged; merely adding an event listener is not
readiness. Setup and native response share the original monotonic deadline.
Typed handles also keep their original result deadline, connection and control
scope. A collect request does not extend the decision's lifetime. The trigger
has its own action timeout; an expired decision is not permission to repeat it.

The decision requires `type` (`alert`, `confirm`, `prompt` or `beforeunload`) and
boolean `accept`. An optional `message` matches exactly, without a glob or regular
expression. Omission matches any message of the selected type; `""` matches only
an empty message. `promptText` is allowed only for `type:"prompt", accept:true`.
An accepted prompt with omitted `promptText` replies with the empty string, not
the dialog's default value. Explicit empty text is valid; null is invalid.
Message, prompt text and returned default value are well-formed Unicode strings
of at most 8192 UTF-8 bytes.

The first matching dialog after readiness consumes the decision. Dialogs before
readiness, nonmatching dialogs and dialogs without an armed decision retain the
pinned runtime's default: accept `beforeunload`, dismiss the other types. The
listener cannot leave a nonmatching native dialog blocked indefinitely.

Success requires acknowledgement of the original native
`Page.handleJavaScriptDialog` command. It does not prove that a business POST or
navigation succeeded. In particular, dismissing `beforeunload` means staying on
the page: the decision can succeed while the attempted navigation reports that
it was cancelled. Do not change the decision to make that navigation succeed.

## JavaScript

Assume `tab` is a managed Tab on the current client. The Page must have a Rename
button that opens the stated native prompt.

```js
const pending = await tab.expectDialog(
  { type: "prompt", message: "New report name", accept: true, promptText: "Q4 report" },
  { timeoutMs: 10000 },
);
let primaryError;
try {
  await tab.getByRole("button", { name: "Rename", exact: true }).click();
  const result = await pending.result();
  console.log(result.accepted, result.promptText);
  // Read the original page's resulting state before continuing the task.
} catch (error) {
  primaryError = error;
  throw error;
} finally {
  try { await pending.cancel(); }
  catch (cleanupError) {
    if (primaryError) throw new AggregateError([primaryError, cleanupError]);
    throw cleanupError;
  }
}
```

`tab.playwright.expectDialog(...)` is also available. The client-level methods
are `client.armDialog(tabId, decision, options)`,
`client.collectDialog(tabId, dialogId)` and
`client.cancelDialog(tabId, dialogId)`. Prefer the typed handle when it must keep
the original scope across later client changes. These convenience methods use
the current client scope; a raw `client.request(...)` workflow must retain and
submit the original scope explicitly rather than adopting a later turn.

## Python

The decision dictionary uses the wire key `promptText`; the timeout keyword is
`timeout_ms`. The same method is available under `tab.playwright`.

```python
import sys

pending = tab.expect_dialog(
    {"type": "prompt", "message": "New report name",
     "accept": True, "promptText": "Q4 report"},
    timeout_ms=10_000,
)
try:
    tab.get_by_role("button", name="Rename", exact=True).click()
    result = pending.result()
    print(result["accepted"], result["promptText"])
finally:
    primary_error = sys.exc_info()[1]
    try:
        pending.cancel()
    except Exception as cleanup_error:
        if primary_error is not None:
            raise primary_error from cleanup_error
        raise
```

Client-level methods are `arm_dialog(tab_id, decision, timeout_ms=...)`,
`collect_dialog(tab_id, dialog_id)` and `cancel_dialog(tab_id, dialog_id)`.
They use the current client scope; use the typed handle or explicitly scoped raw
`client.request(...)` calls when retaining an original decision.

## Go

The following helper uses an existing `*obu.Tab`. Import `errors`, `time`, and
`obu "github.com/ifuryst/open-browser-use/packages/open-browser-use-go"`.

```go
func renameReport(tab *obu.Tab) (result *obu.DialogResult, err error) {
    message, reply := "New report name", "Q4 report"
    pending, err := tab.ExpectDialog(obu.DialogDecision{
        Type: "prompt", Accept: true, Message: &message, PromptText: &reply,
    }, obu.DialogWaitOptions{Timeout: 10 * time.Second})
    if err != nil {
        return nil, err
    }
    defer func() { err = errors.Join(err, pending.Cancel()) }()
    if err = tab.GetByRole("button", obu.RoleOptions{
        Name: "Rename", Exact: true,
    }).Click(); err != nil {
        return nil, err
    }
    return pending.Result()
}
```

`tab.Playwright.ExpectDialog` has the same signature. `Message` and `PromptText`
are `*string`, preserving omitted versus explicitly empty text. A zero options
timeout selects 10 seconds; other durations must be whole milliseconds from
1 to 120000. The handle exposes `DialogID` and `RemainingMS`. Raw client methods
are `ArmDialog(params)`, `CollectDialog(params)` and `CancelDialog(params)`;
their `obu.Params` use the wire fields below.

## Standalone CLI

Each CLI invocation starts its own client. All three dialog commands must use
the original session, turn, tab and epoch, and the same browser endpoint.
`--turn-id` is required for standalone commands. `--control-epoch` is optional
for initial negotiation, but pass the known original epoch for a workflow that
already owns the tab. Never substitute a newly recovered epoch for an old
dialog handle. `--accept=true` or `--accept=false` must be explicit.

This PowerShell example assumes `$Endpoint`, `$Session`, `$Turn`, `$Epoch` and
`$TabId` were captured from the owning client before arming. They are not IDs to
guess. The wrapper checks both the process exit code and the RPC error envelope.

```powershell
function Invoke-ObuResult([string[]]$CliArgs) {
    $json = & open-browser-use @CliArgs
    if ($LASTEXITCODE -ne 0) { throw "open-browser-use exited $LASTEXITCODE" }
    $reply = $json | ConvertFrom-Json
    if ($null -ne $reply.error) { throw $reply.error.message }
    return $reply.result
}
$scopeArgs = @("--socket", $Endpoint, "--session-id", $Session,
    "--turn-id", $Turn, "--control-epoch", "$Epoch", "--tab-id", "$TabId")
$ready = Invoke-ObuResult (@("arm-dialog") + $scopeArgs + @(
    "--type", "prompt", "--accept=true", "--message", "New report name",
    "--prompt-text", "Q4 report", "--timeout-ms", "10000"))
$handleArgs = $scopeArgs + @("--dialog-id", $ready.dialogId)
$primaryError = $null
try {
    $trigger = @{
        session_id = $Session; turn_id = $Turn; control_epoch = $Epoch
        tabId = $TabId; action = "click"; args = @{}; timeoutMs = 5000
        locator = @(@{ kind = "role"; role = "button"; name = "Rename"; exact = $true })
    } | ConvertTo-Json -Depth 8 -Compress
    Invoke-ObuResult @("call", "--socket", $Endpoint,
        "--method", "browserAction", "--params", $trigger) | Out-Null
    $result = Invoke-ObuResult (@("collect-dialog") + $handleArgs)
} catch {
    $primaryError = $_
    throw
} finally {
    try { Invoke-ObuResult (@("cancel-dialog") + $handleArgs) | Out-Null }
    catch {
        if ($null -ne $primaryError) { Write-Error -ErrorRecord $_ -ErrorAction Continue }
        else { throw }
    }
}
```

Messages and prompt replies remain literal strings; they are not CSV, JSON or
another command-line parse. `collect-dialog` and `cancel-dialog` do not accept
decision fields or `--timeout-ms`. An action plan can use the same command names
within its existing runner scope without supplying `--turn-id` again.

## MCP

Run one MCP server for the workflow and use its existing session and managed tab.
Invoke these tools sequentially, waiting for each response. Do not start a
blocking collect before issuing the trigger. These are `tools/call` parameter
objects, not a batch request. Replace `123` and `returned-dialog-id` with the
original values.

```json
{"name":"arm_dialog","arguments":{"tab_id":123,"type":"prompt","accept":true,"message":"New report name","prompt_text":"Q4 report","timeout_ms":10000}}
```

After the ready result, trigger once on the same server:

```json
{"name":"call","arguments":{"method":"browserAction","params":{"tabId":123,"action":"click","locator":[{"kind":"role","role":"button","name":"Rename","exact":true}],"args":{},"timeoutMs":5000}}}
```

Then collect, and issue cancellation as the orchestration's `finally` step even
if the trigger or collect fails:

```json
{"name":"collect_dialog","arguments":{"tab_id":123,"dialog_id":"returned-dialog-id"}}
```

```json
{"name":"cancel_dialog","arguments":{"tab_id":123,"dialog_id":"returned-dialog-id"}}
```

Named MCP fields use `prompt_text`, `timeout_ms` and `dialog_id`; they are forwarded
as structured data, not reparsed as CLI arguments. The generic `call` tool can
also invoke the wire methods with an explicit original scope. Do not restart the
MCP server to continue an old handle on a different browser connection.

## Wire and failure boundaries

`getInfo.metadata.dialogVersion === 1` is required. An older or unadvertised
extension fails explicitly instead of silently falling back to another API.
Every wire method requires original `session_id`, `turn_id`, positive safe integer
`control_epoch` and nonnegative safe integer `tabId`.

| Method | Additional fields | Success |
| --- | --- | --- |
| `armDialog` | `type`, `accept`, optional `message`, `promptText`, `timeoutMs` | `{dialogId, remainingMs}` after acknowledged registration |
| `collectDialog` | `dialogId` | `{type, message, defaultValue, accepted, promptText?}` after confirmed native response |
| `cancelDialog` | `dialogId` | `{}` after original observer cleanup |

Timeout defaults to 10000 ms and accepts integers from 1 to 120000. Unknown
fields, nonboolean decisions, malformed Unicode and invalid field combinations
are rejected. `promptText` appears in the result only for an accepted prompt,
including `""` when no reply text was supplied. `collect` and `cancel` cannot
change the stored decision or introduce a new timeout.

Cancel, timeout, end, Pause, ownership change and attachment loss withdraw the
old decision's authority. If it expires before native dispatch, only the pinned
default may settle that same still-open original dialog; the requested decision
still fails. An already submitted command cannot be recalled. A lost reply or
failed native response does not establish that the browser did nothing, and
neither the page trigger nor dialog response is automatically replayed.

Cleanup tracks the actual native command separately from a client/channel
promise that may fail earlier. Pending work remains part of the control release
barrier; cleanup errors stay visible. Cancellation does not roll back effects of
an accepted confirmation or restore a page that already navigated.

The API is unavailable while website restrictions are enabled, pending a
separately verified origin boundary. It handles native JavaScript dialogs, not
HTML modal components, browser permission prompts, authentication dialogs or OS
file dialogs. It does not add an OS mouse action, replace page JavaScript, or
promise to suppress browser-native focus behavior. Beforeunload availability
also depends on the browser's native activation/navigation rules.

## Known background gap

`beforeunload` decisions remain available, but they do not have an accepted
interruption-free background guarantee. In `run-5tMxBX`, the original
`beforeunload` dismissal received its native acknowledgement, and all four
lifecycle groups completed their business checks. The run still exited with
code 1: the browser activated the original task tab without a permitted focus
transition. A successful decision result does not make that background workflow
pass.

The pinned Chromium source at
`f842f52ef39fd97b449eb27cff414bf05a98ddce` explains this route:
[`TabModalDialogManager` routes beforeunload to an app-modal dialog](https://chromium.googlesource.com/chromium/src/+/f842f52ef39fd97b449eb27cff414bf05a98ddce/components/javascript_dialogs/tab_modal_dialog_manager.cc#221),
and [`CreateViewsJavaScriptDialog` unconditionally calls `ActivateContents`](https://chromium.googlesource.com/chromium/src/+/f842f52ef39fd97b449eb27cff414bf05a98ddce/chrome/browser/ui/views/chrome_javascript_app_modal_view_factory_views.cc#99).
Sending `Page.handleJavaScriptDialog` cannot guarantee that it precedes this
native UI activation. The implementation does not restore focus after it has
been taken or replay the page action to conceal the transition.

The default lifecycle test covers cancellation, expiry and end. To reproduce the
separate beforeunload diagnostic with the existing isolated browser and native
host configuration, run:

```powershell
$env:OBU_TEST_DIALOG_BEFOREUNLOAD = "1"
$env:OBU_TEST_CASES = "^lifecycle-native-dialog-decisions$"
try {
    node scripts/browser-integration/run.mjs
} finally {
    Remove-Item Env:OBU_TEST_DIALOG_BEFOREUNLOAD -ErrorAction SilentlyContinue
    Remove-Item Env:OBU_TEST_CASES -ErrorAction SilentlyContinue
}
```

This opt-in diagnostic retains the original strict focus gate and is expected
to fail on the observed activation path. It is not counted as a passing default
test or granted a focus allowance.

## Verification

The accepted ordinary workflow covers all five entry points across root,
existing OOPIF and dynamically created OOPIF documents. Each layout verifies
accept/dismiss, exact Unicode prompt text, an unmatched default before the
matching decision, and an unarmed default. Original HTTP body bytes, trusted
triggers, original document tokens and actual native response ACKs are checked
together. Child dialogs may arrive through the root CDP source; frameId is
joined to the original attachment event and current target identity.

- Focused `l9jFNY`: 7/7, actual exit 0; 90 explicit decisions, 123 total native
  responses and 108 POSTs/24939 bytes including lifecycle defaults. The 24378ms
  observer history has zero activation, window-focus events or allowances.
- Full `uZgxYp`: 138/138, actual exit 0; the previous 132 case names/order remain.
  Its 377930ms focus ledger passes with only the original 12 activation/four
  control-window focus allowances. No dialog scenario receives an allowance.
- After the full run, only the harness's evidence recording was strengthened:
  save the decoded original helper stdout and verify exact child target IDs
  disappear along with root tabs/targets. Final focused `oYbXyC`: 7/7, actual
  exit 0; 24535ms zero activation/focus/allowances. The production and helper
  sources are identical to the full regression; its older harness is retained.
- Extension/script/integration unit sweep: 2907 pass/one existing Windows
  symlink skip. Final affected fixture/runner tests: 18/18. Go full tests:
  820 test/subtests pass/27 existing platform or permission skips; vet passes.
  JS SDK: 162 pass/four existing real-host skips; Python: 129 pass/one existing
  integration skip. All these commands exit 0.

These runs use an isolated loopback native-host adapter. They do not replace
ordinary Edge installation/authorization acceptance or resolve beforeunload's
native UI activation. Existing preview ZIPs remain unchanged.

Implementation, evidence and remaining boundaries are tracked in the
[execution plan](../exec-plans/active/2026-10-13-native-dialog-decisions.md).
Related contracts: [control lifecycle](control-lifecycle.md),
[SDK connection identity](sdk-connection-identity.md), and
[navigation waits](navigation-waits.md).

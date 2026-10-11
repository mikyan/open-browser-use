# Browser integration acceptance

Use the Go version pinned by `go.mod` (currently 1.26.9) for the host and every
Go caller. Check `go version` before the build commands below; a previously
installed local toolchain may be older than the repository requirement.

## Real Windows native launcher lifecycle

`native-lifecycle.mjs` tests the browser's actual `connectNative` launcher with
an isolated profile and a unique temporary native-host registration. It covers
host termination with held input and a pending action, native Port EOF during
an actual extension reload, and reload while globally paused. The normal
adapter suite below remains a separate regression requirement.

Build the current host and set explicit browser paths before invoking it:

```powershell
go build -o .tmp/native-lifecycle-host.exe ./cmd/open-browser-use
$env:OBU_TEST_HOST_BINARY = (Resolve-Path .tmp/native-lifecycle-host.exe).Path
$env:OBU_TEST_NATIVE_BROWSER = 'chrome'
$env:OBU_TEST_CHROMIUM_BINARY = 'C:/path/to/chrome.exe'
$env:OBU_TEST_NATIVE_MODE = 'acceptance' # default when unset
node scripts/browser-integration/native-lifecycle.mjs
```

For a separate idle startup control, keep those same binary paths and browser
policy and select the diagnostic mode:

```powershell
$env:OBU_TEST_NATIVE_MODE = 'idle-diagnostic'
node scripts/browser-integration/native-lifecycle.mjs
```

After the same installation and observer setup, this mode observes at least
10 seconds without SDK calls, browser actions, host termination or reload.
It samples the continuous focus ledger, window/sentinel metadata, read-only
worker connection status and full extension-manager inventory about once a
second. Unexpected focus events remain recorded and fail the unchanged focus
check, but do not shorten the diagnostic interval. The original native host's
live executable, process creation identity and browser ancestry are checked at
the end. Setup still includes the existing read-only SDK `getInfo` readiness
check; observation adds no SDK calls.

`idle-diagnostic.json` and `results.json` report collection separately from
acceptance: `mode` is explicit, `records`/`expectedCases` are empty and
`passed` is always false. `diagnostic.complete: true` and exit code 0 mean the
full interval and final read-only evidence were collected, the original host
remained connected, inventory stayed isolated and normal cleanup succeeded.
They do not mean the focus check passed: inspect `focus.finalValidation` and
the raw events. Incomplete collection, setup, inventory, identity or cleanup
failure produces `diagnostic.complete: false` and exit code 1. Unknown mode
values are rejected before any setup. Return to `acceptance` to run all three
lifecycle cases; idle evidence cannot replace them.

The browser must expose `Extensions.loadUnpacked` and the extension-manager
developer-mode UI. Setup uses that UI and one CDP bootstrap followed by ordinary
manager reload, before the measured action interval. It never edits protected
profile preferences. `edge` selects Edge registration and the Edge settings
URL. Edge setup uses the observed visible developer-mode switch and checks both
its UI state and the native configuration; the Chromium UI has its own path.
For the controlled testing build, the default field-trial policy remains
`disabled`; this is recorded and is not a production browser setting change.

Both browsers use `--disable-sync` and `--disable-background-networking` in the
private test process. The initial background settings page remains open for
read-only `developerPrivate.getExtensionsInfo` inventory before/after setup,
each case and before teardown. Disabled and terminated entries are included;
only fixture IDs and explicitly reported `COMPONENT` entries are allowed. The
API normally hides components, themes and non-unpacked hosted apps, so this is
an inventory of everything exposed by that API, not all installed browser data.
It records only ID/location/state/type, never account details or other extension
contents. Any unexpected entry fails the run. Artifact construction also records
focus, windows and the sentinel around each step without granting new allowances.

Only the staged worker's unique native-host constant, public unpacked key and
passive lifecycle listener differ from production. `connectNative` itself is
unchanged. The independent companion observer survives extension reload and
retains every activation/focus event; only explicit real Pause/Resume popup
openings may receive exact focus allowances. Setup and final teardown are
outside the measured interval.

Before terminating a native host, the runner verifies its executable, creation
time and live ancestry under the private browser, then retains the exact process
handle. For reload it watches the old process handle, requires exit code zero,
checks the old pipe is unavailable and that the relay removed its descriptors.
Forced termination may leave stale descriptors and is recorded separately.
New PID, endpoint, native worker identities, original document contents, trusted
input release and server-side action witnesses are retained in the report.
The late action target must appear with at least one second of its original
deadline remaining. Observation continues through that original deadline plus
250 ms, checking the same document and server-side witnesses for late effects.
Host-only recovery requires an
explicit new turn; reload also requires explicitly claiming the old task tab.

Results and screenshots remain in `.tmp/browser-integration/native-lifecycle-*`.
Cleanup verifies observed browser processes and test host processes exited,
then removes only the random registration leaf if its ownership and value
inventory are unchanged. It never removes the parent registration directory
or changes a user's installed extension. Failed cases and cleanup failures
remain failed; a subsequent run creates a separate evidence directory.

This suite does not certify signed extension updates, whole-browser restart,
packed-extension alarm wakeup timing, other operating systems, or all browser
brands. Deterministic scheduling tests separately reproduce the packed alarm's
30-second minimum and heartbeat replacement race.

### Recorded acceptance and remaining Edge focus issue

Final Chrome 156 run `native-lifecycle-dnAdTC` passed **3/3** with the final
isolation/inventory policy. Earlier `native-lifecycle-wG1S3Q` and the strengthened
deadline run `native-lifecycle-ZC9V9W` also passed 3/3 and retain their own source
hashes. Main adapter regression `run-aZyBs1` passed **77/77** separately. A complete
CI passed 849 Node tests (726 extension, 53 scripts, 70 harness), JS98, Python67
and all Go packages; the final harness suite, including three subsequent tests,
passed **73/73**. These counts are not a single repeated full CI run.

Edge 153 remains unaccepted for this lifecycle suite. Setup failures
`native-lifecycle-d2Ruot` / `olzCVL` identified a different developer-mode UI;
`FkC1n3` showed native configuration alone did not update the displayed switch.
Using the actual switch fixed setup. `nBszxt` passed host recovery but failed on
an unexplained focus loss before reload; its private profile also unexpectedly
synced unrelated store extensions. The final isolation policy eliminated those
extra inventory entries in `native-lifecycle-R7MPzo`, but that run still failed
host recovery's focus check: its own browser window received an unexplained
focus event. The host recovery action completed, but the whole case stays failed;
neither reload case ran. Its browser/native processes and random registration
were cleaned. The cause remains unresolved; no event has been waived, and the
earlier sync confound does not explain the clean-profile failure.

The clean-profile browser log records its developer-mode bubble being shown at
the exact millisecond of that focus event, 457 ms after the original host exited
and about 4.6 seconds before the replacement started. This is timing correlation,
not observed UI causation. Next diagnosis should retain the identical policy,
observer and inventory but observe an idle post-install interval without SDK
actions, host termination or reload. Such a control is diagnostic only; it must
not erase this failure or count as lifecycle acceptance.

The explicit idle control is now implemented. With the same frozen source and
startup policy, Edge `native-lifecycle-XlNQ9o` collected **10,002 ms / 11 samples**;
Chrome `native-lifecycle-K2qRSM` collected **10,015 ms / 11 samples**. Both have zero
acceptance cases and server witnesses, an unchanged host throughout observation,
isolated inventory and completed process/registration cleanup. Setup itself
still has two host generations because of the ordinary manager reload. Both
diagnostics completed with exit 0 and `passed:false`, as required.

Edge recorded one focus event at 10:51:47.148 local time; its developer-mode
bubble log followed at 10:51:47.149. Its focus validation remains **failed**.
Chrome recorded no activation or focus events. Thus the Edge phenomenon can
occur without SDK work, host termination or reload in the observation interval;
those recovery actions are not necessary to reproduce it. The bubble's actual
UI was not inspected, and timing correlation still does not prove causation.
There is no new startup delay, suppression flag or focus exemption in acceptance.
The [official Edge notice](https://support.microsoft.com/en-us/edge/developer-mode-extension-notification)
states that Stable cannot disable this notification; it does not document a
readiness API.

The final harness unit suite passed **75/75**. The unchanged default acceptance
path was separately rerun on Chrome as `native-lifecycle-0B1hfL`, **3/3**, to check
that adding diagnostic result semantics did not bypass or break the real cases.
The earlier Edge lifecycle failure remains unresolved; the idle control does not
replace its required recovery acceptance.

## Real Windows browser installation and discovery

`native-browser-installation.mjs` is a separate opt-in runner for real, signed
Windows Brave, Opera and Vivaldi executables. It checks the actual browser
identity, profile catalogue, native launcher and one JS SDK background task.
An executable renamed to another brand is rejected. This runner has no case
filter or idle-diagnostic mode and does not replace the adapter or lifecycle
suites.

With workspace and harness dependencies installed, build the current JS SDK
and host, then select a matching browser executable:

```powershell
pnpm --dir packages/open-browser-use-js build
go build -o .tmp/native-installation-host.exe ./cmd/open-browser-use
$env:OBU_TEST_HOST_BINARY = (Resolve-Path .tmp/native-installation-host.exe).Path
$env:OBU_TEST_NATIVE_BROWSER = 'brave'
$env:OBU_TEST_CHROMIUM_BINARY = 'C:/path/to/brave.exe'
$env:OBU_TEST_FIELD_TRIAL_CONFIG = 'browser-default'
node scripts/browser-integration/native-browser-installation.mjs
```

For separate runs, set `OBU_TEST_NATIVE_BROWSER` to `opera` with the actual
Opera executable, or `vivaldi` with the actual Vivaldi executable. Both the
launcher and browser process identities are checked. The field-trial setting
is recorded: `browser-default` leaves that testing configuration unchanged;
`disabled` (the default when unset) adds `--disable-field-trial-config` to the
private process. Neither value grants focus exemptions.

Each run creates fresh profiles under private `HOME`, `USERPROFILE`,
`LOCALAPPDATA`, `APPDATA` and temporary directories. It uses the brand's normal
catalogue layout, verifies the profile path displayed by its About page, and
does not copy user profiles or inject instance IDs. Setup records the actual
extension-manager controls and checks rendered/native developer-mode agreement
before `Extensions.loadUnpacked`. It does not edit protected preferences.

Vivaldi diagnostic pages use the observed vendor UI's `chrome.tabs.create`
path with `active:false`; direct CDP target creation failed during setup in
recorded runs. The fixture records the vendor identity, native tab reply and
unique new target association. Only the temporary observer HTML is exposed
to that exact vendor extension ID before loading; production extension
permissions and the observer's passive event collection stay unchanged.
Opera's About identity is read from its observed Shadow DOM profile field,
separately from the installation and cache paths.

The CLI exports a manifest with `install-manifest --browser <brand> --output`.
The fixture changes its host name and creates an ownership-fenced random leaf
under `HKCU\Software\Google\Chrome\NativeMessagingHosts`, testing the real
shared namespace. The production fixed leaf in both registry views is only
read and compared before/after. In default acceptance mode, only the staged
extension's native-host name and public unpacked key change; its `connectNative`
remains untouched. This
does not exercise installation into the fixed production leaf or a store
installation. See [namespace and registration scope](../../docs/references/chromium-browser-installation.md).

Evidence includes signed executable hashes, the real browser/native PIDs,
installed and connected profile discovery, positive selectors and rejection
of wrong browser/profile selectors. The SDK task fills and submits a unique
note, checks original trusted input/click events and the server receipt,
verifies screenshot pixels, and finalizes its tab. An independent continuous
focus ledger permits no activation or focus events during the measured task;
setup and teardown are outside that interval. The runner does not measure OS
pointer position or simultaneous human mouse use.

For an explicit native API diagnostic, additionally set
`OBU_TEST_NATIVE_DIAGNOSTICS=1`. Unset, empty or `0` retains default acceptance;
other values are rejected. The diagnostic prepends an observer only to the
isolated staged worker. It records single invocations of `tabs.create`,
`tabs.group`, `tabGroups.get/update` and `debugger.attach/detach/sendCommand`,
plus selected passive tab, group and debugger events. Original arguments,
receiver, return Promise and errors are preserved. It does not retry actions,
activate tabs or substitute input. Serialization and Promise observation can
affect scheduling and unhandled-rejection reporting, so this is not a
timing-neutral run of the production artifact.

Snapshots are taken after the existing verified native handshake, at task
termination and before browser close. A visible service-worker target alone
does not prove its module body has executed. The observer retains earlier
startup records; delayed initial collection does not reset them. Raw `/task`
requests are also retained in `task-requests.json`, separately from original
POST receipts. Trace retention is bounded to 4,096 records, 16,384 characters
per record and 4 Mi characters overall. Payload truncation is marked; omitted
values remain unknown. Missing records, overflow, worker replacement or
observer errors prevent complete collection. Pending commands have unknown
outcomes even when the trace itself is complete.

Diagnostic results have `mode: "native-api-diagnostic"` and **always** have
`passed: false`. Exit zero and `diagnosticCompleted: true` mean the task was
reached, trace collection was continuous and native/browser cleanup completed;
they do not mean the task succeeded. Original task and focus failures remain
in the report. A setup failure before the native host starts cannot meet that
complete-native-run condition. Remove the variable for subsequent acceptance.

For the separate Vivaldi pre-attach experiment, set
`OBU_TEST_VIVALDI_READINESS=1` with `OBU_TEST_NATIVE_BROWSER=vivaldi`.
Unset, empty or `0` preserves the default path; other values, other brands,
or combining it with native API diagnostics are rejected. Only the vendor-created
installation manager and observer use this gate. Before their first target
connection, native `tabs.get` must report the original inactive tab/window,
committed exact URL and `complete` status, with the same uniquely associated CDP
target. Creation, identity, successful incomplete-state sampling, connection and
document evaluation share one absolute 25-second deadline. Read errors are
terminal; no target is recreated, activated, replaced or reconnected. About and
the production SDK task retain their original paths, and no API prelude is staged.

`diagnostic-pages.json` retains bounded first/last samples and any overflow.
After failure, a separate single read of the original tab and target metadata
has at most 2.5 seconds; it cannot alter the original error or success budget.
`mode: "vivaldi-readiness-diagnostic"` always has `passed: false`. Exit zero and
`diagnosticCompleted: true` require both gates to complete, the task to be reached,
no HTTP ledger overflow and strict cleanup. Task/focus failures remain visible;
this result is not browser acceptance or proof of a Vivaldi root cause.

For the separate single-input experiment, set `OBU_TEST_VIVALDI_INPUT=1` with
the actual Vivaldi binary. Unset, empty or `0` disables it. Other values, other
brands, or enabling `OBU_TEST_NATIVE_DIAGNOSTICS`, `OBU_TEST_VIVALDI_READINESS`
or `OBU_TEST_NATIVE_OWNERSHIP` at the same time are rejected. This mode internally
uses the existing readiness gate and the unmodified native API observer. The
original SDK fill and click each run once; no activation, prefill, replacement
input or replay is added. `Runtime.callFunctionOn` results and `Input.insertText`
arguments/settlement remain in the original native trace, including exact debuggee
identity. Long unrelated Runtime bodies may be truncated; critical Input
parameters must be retained completely for complete collection.

The fixture adds passive focus, blur, selection, beforeinput, input, change and
composition listeners. `input-diagnostic.json` contains snapshots before and
after fill through the existing reads, then one final public read after the
receipt, before its assertions. If execution fails earlier, teardown attempts
that final read only if it has not already been attempted and fill was reached.
It never retries a failed read. Records bind nonce, document and original input
node identities, event target, DOM focus, value/selection and event metadata.
Each event reserves capacity for its later microtask record; 256 records is the
limit. Capture-phase `defaultPrevented` is not final. The later observation only
claims final cancellation when dispatch has ended; otherwise it remains unknown.
Observation can affect scheduling, and DOM focus does not identify the actual
focused render widget.

The actual first HTML response is saved with its hash without an extra GET or
new response-blocking disk write. The original POST schema and trusted event
assertions remain unchanged. `mode: "vivaldi-input-diagnostic"` always has
`passed: false`; complete collection requires both setup gates, continuous native
and same-document DOM evidence, the single original GET/POST, original action
counts and strict cleanup. Wrong text/target or unsuccessful input remains
diagnostic evidence, not a collection failure when fully recorded. Missing,
truncated critical data, overflow or persistence errors make collection incomplete.

`OBU_TEST_VIVALDI_TASK_READY=1` selects the separate task initial-commit experiment.
It is exclusive with all four switches above and only accepts an actual Vivaldi
binary. It internally retains the INPUT experiment, adding one stage after the
original public `newTab` ACK and before the original `goto`. Its separate absolute
5-second budget is additional diagnostic time, not time inherited from `newTab`
or an extension of `goto`. No navigation timeout option is changed.

`task-readiness.json` binds the original task scope/tab/window and saves at most
80 samples. The existing independent observer reads `chrome.tabs.get`; the
already connected worker reads `chrome.debugger.getTargets`, without adding
observer permissions or attaching to the task. Readiness requires the same
inactive tab, committed `about:blank`, complete status, no pending URL, and one
unattached page target with that exact numeric tab ID. The opaque target ID is
fixed when first seen; later replacement or disappearance terminates the gate.
Only successful incomplete state may repeat. API failures are not retried;
dimensions, discarded and frozen fields are observations, not extra conditions.
The original `goto` is sent once only after the gate completes within budget,
including its final evidence save. No activation, creation or navigation is
replayed. `mode: "vivaldi-task-readiness-diagnostic"` always has `passed: false`;
diagnostic completion also requires the existing input evidence and strict
cleanup. A ready gate or a later successful task alone does not establish the
cause of Vivaldi's earlier initialization failures.

`OBU_TEST_VIVALDI_KEY_INPUT=1` selects a separate keyboard experiment for the
actual Vivaldi browser and is exclusive with all five explicit modes above.
It keeps TASK_READY/INPUT setup, session/turn/newTab, the original nonce/text and
`getByLabel("Delivery note")` locator. Before execution, its single input action
is selected as `pressSequentially(note)`. It never calls fill first, performs an
extra focus/click, retries, or falls back. The original single submit click and
POST/receipt checks remain. Snapshot phases are `before-key-input`,
`after-key-input`, and `final`.

Only this variant adds passive keydown/keypress/keyup and explicitly raises the
DOM record cap to 1,024; old INPUT retains its original events and 256 limit.
The shared serialized observer source has changed, so old INPUT fixture HTML
is not byte-identical to the prior baseline. Default non-diagnostic fixture
HTML remains unchanged. Overflow and unknown cancellation keep their original
meaning. The raw native wrapper is unchanged and records actual
`Input.dispatchKeyEvent` parameters, targets and settlement; no expected command
is filled in when one is missing.

`results.json` has `keyInputDiagnostic`, also saved as `keyInput` inside
`input-diagnostic.json`. Actual command count/order, sent-text/key comparisons,
task target matches and any `Input.insertText` call are separate observations.
`mode: "vivaldi-key-input-diagnostic"` always has `passed: false`. Complete
collection does not require correct text or successful editing; the selected
experiment additionally needs observed key dispatch and no insertText. Original
`task.passed` still requires the receipt, focus and finalization checks. A native
dispatch ACK alone does not prove a DOM event arrived or edited the input.

`OBU_TEST_VIVALDI_POINTER_FOCUS=1` selects one separate experiment on actual
Vivaldi and is exclusive with the six explicit flags above. It reuses
TASK_READY/INPUT setup and the same session, turn, tab, nonce and text. Its sole
action difference is one preselected `getByLabel("Delivery note").click()`
before the original single `fill(note)` and single Submit click. There is no
tab activation, explicit focus call, replacement input, retry or fallback.
The task logs this additional call as `pointerFocusClick`, separately from the
original Submit `click`. One public click does not imply one native mouse
sequence; the actual move/press/release calls and their outcomes remain recorded.

The five snapshots are `before-pointer-click`, `after-pointer-click`,
`before-fill`, `after-fill` and `final`. This variant adds only passive
pointerdown/pointerup/mousedown/mouseup/click listeners, with the original
256-record bound. They record actual target identity, trusted status, buttons,
coordinates, original input value/selection, and the same bounded later
cancellation observation. The previous INPUT and KEY_INPUT event sets/caps are
unchanged. Shared serialized diagnostic source changes are declared; default
non-diagnostic HTML remains byte-identical.

`results.json` has `pointerFocusDiagnostic`, also saved as `pointerFocus` in
`input-diagnostic.json`. It separates raw native pointer/Submit time windows,
mouse counts/order/targets, pointer delivery to the original node, empty-value
preconditions and the original fill result. Time-window matches and command
ACKs do not prove immediate DOM delivery. Consecutive mouse commands can start
before the preceding ACK; their actual ordering is evidence, not a serial-ACK
requirement. `mode: "vivaldi-pointer-focus-diagnostic"` always has `passed:
false`; complete collection and the observed experiment do not imply successful
editing. The unchanged `task.passed` still requires the receipt, focus and
finalization checks. Any effect belongs to the whole input click, including
movement; this experiment does not isolate mousedown or prove widget routing.

The recorded `HrDsGN` key experiment sent 78 correct native commands with ACKs,
but received no DOM key/input event and submitted an empty note. The later
independent `ttYgKb` pointer experiment delivered trusted events to the original
input, then the unchanged fill produced trusted input/change and the correct
single POST. Its screenshot, finalization and actual tab removal passed; the
1,068 ms focus ledger recorded no activation or window-focus event. This is a
successful explicit click-then-fill task, not a production fill fix or a causal
proof about mousedown alone. Default Brave `TKisEN`, with all diagnostic flags
unset, passed the original task and independent audit. Production code and the
host/ZIP artifacts were unchanged. See the [input diagnostic record](../../docs/references/vivaldi-input-diagnostic.md)
for the preserved failures and scope limits.

Set `OBU_TEST_NATIVE_OWNERSHIP=1` to add the public multi-page ownership workflow
after the unchanged standard task. This option independently records real task
GETs; it does not require native API diagnostics. It opens A and B, submits both,
rejects a foreign session's claims, hands off A while closing B, explicitly begins
a new turn and reclaims A, then submits A again. Finally it creates C, delivers C
and omits A. Native observations must prove that A and B closed and only inactive,
detached C remains. A fresh post-delivery turn must list no owned tabs and reject
a read of C as unowned; merely rejecting the old epoch is insufficient.

Evidence preserves three new GETs and four new POST bodies in exact order,
including both submissions of A, in addition to the standard task's original
POST. Every mutation uses the public JS SDK. Native observers only inspect
tabs, debugger targets and the continuous focus ledger, with no new allowance.
Requested ownership acceptance must also pass for the run to pass. A failed or
unknown finalization is never replayed during teardown; the fixture closes its
own isolated browser. Unset, empty or `0` preserves the standard-only workflow.

Artifacts remain in `.tmp/browser-integration/native-installation-<brand>-*`.
Passing requires browser/native process exit evidence, removal of the task
tab and debugger attachment, clean private endpoint descriptors, and removal
of only the owned random registration leaf. Identified external descendants
are recorded and left untouched; uncertain process ownership blocks cleanup.
Failed runs remain failed, including setup and cleanup failures. A separate
post-run cleanup record or later successful run does not revise their result.
This section defines the procedure, not a claim that any brand has passed.

## Adapter regression suite

This optional acceptance suite runs **public SDKs → real Go native host →
production extension → real Chromium pages**. It creates an isolated browser
profile and local test pages; it does not install an extension in a user's
profile, read user browsing data, or change the native-host registry.

The staged extension is produced by `buildChromeExtension`. Its transport
adaptation replaces `chrome.runtime.connectNative` with a Port-compatible local
WebSocket adapter, with the matching local CSP permission. A separate test-only
extension document records native activation/focus events throughout the run,
including worker restarts; it is absent from production packages. The adapter bridges
the real host's native-message stdin/stdout frames. SDK connections still use
the host's actual Windows named pipe or Unix socket. This proves the SDK,
framing, relay, extension dispatch, engine, and page behavior; it does **not**
prove browser native-host registration or installed-extension discovery. The
production extension is not modified and does not open a WebSocket service.

The adapter enforces Chrome's directional physical frame limits: 1 MiB from
host to extension and 64 MiB in reverse. `js-native-large-requests` submits
concurrent multi-megabyte Unicode/HTML requests, checks page-computed hashes and
exactly one execution, and verifies subsequent small calls on the same host.
`nativeFrameStats` records frame sizes and private start/chunk/commit counts
without retaining request bodies. These adapter checks are complemented by
the separate [real native-message runner](native-message-checks.md), which uses
isolated Windows profiles and temporary native-host registration.

The worker-restart case keeps this test adapter's Go host process alive. It
verifies extension epoch recovery over the same client connections. It does not
claim automatic discovery/reconnection when a real native-host process exits;
that requires reading its new endpoint and creating a new SDK client.

The runner launches headed Chromium directly. Playwright locates the downloaded
browser executable and supplies the static YAML parser used by snapshot checks.
A small raw CDP connection inspects the
extension service worker and the test observer; there is no Playwright page/context connection or
foreground activation. A sentinel tab remains active in its original window,
and every tab activation and window-focus event is retained. Auxiliary popup
fixtures use `chrome.windows.create({type:'popup',focused:false})`: Chrome may
emit one activation for that new window's sole tab. The runner permits only that
exact event index and sequence actually recorded across that creation call in
`allowedPopupActivations`. No observed event means no allowance for a later
activation; even the sentinel has no reactivation exemption. Claim,
input, cleanup and recovery must not change the focused window. The final Pause
test intentionally opens the user's toolbar control with `chrome.action.openPopup`.
Only across that exact call, with a live matching `POPUP` context, it permits
either no focus event or precisely `[sentinelWindowId, -1]`, the sequence observed
on the tested Chromium build. `allowedWindowFocusEvents` binds each allowed
event to its original index, reason, checkpoint times and popup context;
`pause-focus-trace.json` preserves the surrounding native window states. Every
other focus event fails, including during subsequent popup close or auxiliary
cleanup. No raw events are erased, and the original sentinel tab stays active.

The observer has one stable document identity and a local delivery sequence;
these are not Chrome-wide event IDs. It retains duplicate events, rejects
overflow and history truncation, and does not hand logs between replacement
workers. The initial worker and observer setup snapshots are saved separately
and must both be quiet. This is an initialization check, not proof of complete
coverage before observer readiness or during process startup. All tested agent
actions begin after readiness. The final saved snapshot is validated again,
including on failed cases; a lost observer or an unexpected late event fails
the run. Teardown after that checkpoint is outside the measured action interval.
The pure event-ledger unit tests run in ordinary CI without browser dependencies.

The acceptance runner explicitly disables Chromium's **testing field-trial
configuration** with `--disable-field-trial-config`, matching Playwright's
normal launcher for the same executable. It does not inherit Playwright's
background/occlusion flags. This matters because an unbranded Chromium build
otherwise loads experiments from `fieldtrial_testing_config.json`: the pinned
build's toolbar experiment includes a 100-second renderer commit delay and a
12,000-frame surface deadline. This is a controlled test baseline, not a
production extension workaround or proof about all user experiment settings.
Set `OBU_TEST_FIELD_TRIAL_CONFIG=browser-default` to reproduce the previous
unmodified launch policy; the default is `disabled`, and other values fail
before launch. `browser-startup.json` records the selected policy, exact spawn
arguments, binary hash and `windowsHide`; it is separate from focus evidence.
See the [startup trace and experiment evidence](../../docs/references/headed-browser-startup.md).

On this controlled baseline, `run-Uq8Fkj` passed the three directed input/image
cases and `run-NJ72u2` passed all **61 headed cases**, including the Go client
and eight media cases. The continuous observer passed final validation: five
exact sole-tab popup activations and four focus events from the two intentional
control-popup openings were recorded and attributed. Ordinary page actions had
no additional foreground events. Earlier browser-default failures remain
failed evidence; this result is not cross-platform or all-configuration parity.

`js-user-site-access-popup` also uses the actual action popup and the same exact
focus ledger. It verifies allow/block settings, cancellation of a waiting click,
stale epochs, explicit resume, permitted semantic actions and PNG output, a
denied origin, mixed cross-origin frames, redirect revocation, blank bootstrap,
forged setters and persisted settings across a worker restart. It restores all
websites through the popup before cleanup. Raw events are preserved for both
intentional popup opens; no page actions receive a focus exception. Policy
semantics and limitations are in [website access settings](../../docs/references/site-access-policy.md).

The page-export cases call the public JS, Python, Go, CLI and MCP APIs and retain
`page-export-{js,python,go,cli,mcp}.{pdf,mhtml}` with byte lengths and SHA-256
digests. They verify PDF signatures and final markers, MHTML resource/frame
parts, cross-session denial, bounded-output failure and recovery, and CLI/MCP
no-overwrite publication with small metadata responses. The website-policy case
also retains an allowed PDF and rejects mixed-origin PDF and restricted MHTML.
Native errors fail these tests; no print dialog or headless fallback is used.

`js-page-exports-lifecycle` deliberately holds the resolution of a **real**
`Page.printToPDF` Promise after Chrome creates its stream. It verifies that
session end rejects the result, waits for the native operation, and closes the
exact late stream without reading it. This is a deterministic fault injection,
not a claim that normal Chrome printing exhibits that delay. The worker hook is
restored before later tests. Ordinary successful exports use unmodified native
commands. Render retained PDFs with Poppler and inspect their page images;
parse MHTML with a MIME parser to check decoded Chinese/frame content. PDF font
maps may extract visually similar Unicode radicals despite correct rendering;
the test does not rewrite exported bytes.

Select the affected public callers and policy check with
`OBU_TEST_CASES='page-exports|python-public-sdk|go-public-sdk|user-site-access'`
(eight cases including the mandatory raw prerequisite when Go is configured).

## Prerequisites and invocation

Use a desktop session with Node.js 22+, Python 3.10+, the repository's Go
toolchain, and installed workspace dependencies. This directory deliberately
has its own frozen npm dependencies and is not required by the ordinary unit
test suite. From the repository root:

```sh
pnpm install --frozen-lockfile
pnpm --dir packages/open-browser-use-js build
npm ci --prefix scripts/browser-integration
npx --prefix scripts/browser-integration playwright install chromium
go build -o .tmp/open-browser-use ./cmd/open-browser-use
OBU_TEST_HOST_BINARY="$PWD/.tmp/open-browser-use" node scripts/browser-integration/run.mjs
```

In PowerShell, build the `.exe` and set the environment variable before running:

```powershell
go build -o .tmp/open-browser-use.exe ./cmd/open-browser-use
$env:OBU_TEST_HOST_BINARY = (Resolve-Path .tmp/open-browser-use.exe).Path
node scripts/browser-integration/run.mjs
```

To include the Go SDK caller, compile the included acceptance client and set
`OBU_TEST_GO_CLIENT_BINARY` before running the same suite:

```powershell
go build -o .tmp/go-browser-checks.exe ./scripts/browser-integration/go-checks
$env:OBU_TEST_GO_CLIENT_BINARY = (Resolve-Path .tmp/go-browser-checks.exe).Path
```

Optional variables:

- `OBU_TEST_CHROMIUM_BINARY`: an explicit Chromium executable supporting
  unpacked extension loading (otherwise the pinned Playwright download).
- `OBU_TEST_PYTHON`: Python executable (otherwise `python`).
- `OBU_TEST_GO_CLIENT_BINARY`: optional built Go SDK acceptance client; it receives
  the endpoint and fixture URL as two arguments and returns a JSON result with
  `passed: true`. Its executable digest and result are recorded alongside the
  other callers.
- `OBU_TEST_GO_RESEARCH_BINARY`: executable built from
  `./scripts/browser-integration/go-research-workflow-checks`; required when the
  selected cases include the Go research workflow. See the build commands below.
- `OBU_TEST_CASES`: optional regular expression selecting test names for a focused
  debugging run. The initial raw navigation/engine attachment always runs. Omit
  this variable for the complete acceptance suite.
- `OBU_TEST_BACKGROUND_PARALLEL=1`: enable the additional headed long-idle case.
  Select `OBU_TEST_CASES=background-parallel` to run it with the mandatory raw
  navigation prerequisite. It keeps two pages untouched for at least 310 seconds
  while other owners submit data and capture screenshots concurrently. This
  opt-in case is excluded from the default 104-case suite; no shorter wait counts
  as acceptance. The recorded `run-ttHLU9` passed **2/2** with a 310.088-second
  command-free interval, 172 original POSTs and 182 decoded PNGs. Native stream
  overlap, actual cleanup and zero focus/activation events were independently
  checked. See [the evidence contract and limits](../../docs/references/background-parallel-workflow.md).

The isolated test browser uses `--no-sandbox` because some Windows automation
environments cannot initialize Chromium's sandbox. It serves only generated
local fixture pages. This is a test-runner setting, not a recommended user
browser setting. A headed browser is required; Linux CI needs a desktop or
virtual display. The suite does not use disabled background-throttling flags.

## What it checks

The suite currently contains 104 cases with all Go helper binaries, including
fifteen shared research workflows across five public entrypoints and three
layouts. Latest headed `run-NDr4vF` passed **104/104** on the controlled testing-config
baseline with the opt-in long case disabled. Previous `run-WWWaGP` also passed
**104/104**; research-focused `run-AOpN3n` passed **16/16**, including the mandatory
native-navigation prerequisite. The earlier shared-form run `run-6SwxDM`
passed **77/77**; form-focused `run-j4jsMy` passed **8/8**.
The preceding finite-media headed `run-XnREpF` passed **70/70**; its
independent file, native-diagnostic, continuous-focus and final ZIP audits passed.
The preceding `run-WMOIim` remains **69/70** with a diagnostics isolation failure,
fixed by the new native Page event timestamp boundary. The historical
complete headed run, `run-obwspc`, passed 29/53; background first-frame waits
failed. The continuous-observer revision's three affected headed cases in
`run-8j69VK` still failed, with the final raw event ledger retained and checked.
The isolated Headless run `run-IajAnU` passed four selected cases, including
three real worker restarts in the same observer lifetime, with two exact
auxiliary-window initial tab activations and no focus events. That focused
result is not a headed, system-clipboard or complete-suite pass. The 15 pure
ledger/deadline tests pass without launching a browser.

Diagnostics acceptance retains `diagnostics-evidence.json`, including a passive
native console/exception/Log observer. After real detach/reattach and ownership
transfer it waits for actual native historical replay, verifies the original
timestamps, then checks fresh root/OOPIF console and page errors and successor
events in the new public capture. It never changes or fabricates native events;
the fixed CRX handler tests separately exercise deterministic late replay.
The production timestamp boundary assumes a stable system clock. Clock jumps
between native wall time and the worker's timeOrigin/monotonic offset remain
outside this acceptance, as do broader P11 debugging capabilities.

The earlier isolated Windows Chromium 156 run
`.tmp/browser-integration/run-xMoFkk/results.json` passed all 48 cases, including
the optional Go caller, large native requests, direct downloads, auxiliary popups and navigation waits. Its raw activation/focus
events and narrowly scoped ledgers remain in the evidence. This does not verify
native `window.open` focus suppression or full browser/extension restart.

Direct downloads passed all eight focused cases in `run-1D7lpX` before the full
run. Four new cases and the expanded Python, Go and Pause cases verify file bytes,
exact ownership, timeout, late-ID cancellation, and cancellation before cleanup.
That historical suite contained 48 cases with Go, or 47 without it. The separate Windows Edge
`native-u7vkkz` run passed both real native-port cases; see
[native-message acceptance](native-message-checks.md).

Navigation acceptance retains bounded stage and native request traces. The gated
page consumes the complete body of its counting fetch as well as its held fetch;
both exact request IDs must emit `Network.loadingFinished` before idle success.
An earlier failed diagnostic run proved that an unread counting response remained
unfinished in Chromium. The fixture was corrected; native idle semantics and
deadlines were not changed. Failure evidence captures state before finally opens
the remaining gates, so cleanup cannot look like successful lifecycle progress.

- JS, Python, and the optional Go caller's semantic role/name locators, YAML snapshots and duplicate-match
  strictness.
- JS locator `ariaSnapshot()` in the main document and an OOPIF. Element
  screenshots reject page-only `clip`/`fullPage` options before the same locator
  goes on to produce a valid screenshot.
- Bounded `snapshotAI()` captures and real `getByRef()` clicks in the root,
  open shadow DOM, same-origin, OOPIF and nested frames. The fixture inserts an
  earlier sibling iframe, then reorders live iframe documents with `moveBefore`,
  and checks each clicked document's actual counter to catch ref aliasing. It
  repeats capture 20 times and replaces an iframe eight times while keeping
  `maxFrames:6` and six live frames, checking public refs without reading private
  engine slot state. It
  checks offscreen nested-ref PNG dimensions against Playwright's enclosing
  document clip and DPR, and saves both the ref image and a public semantic
  locator control image. Actual bounding boxes, root scroll offsets and clips
  are recorded; fractional iframe origins can make the integer clip larger than
  the CSS element size.
  `moveBefore` must be available; this acceptance case does not silently replace
  it with document-destroying `appendChild` or claim coverage on older browsers.
  An iframe's fallback text and actual child button must both appear under its
  parsed YAML collection; malformed inline fallback output must fail parsing.
- AI capture expiry after a new capture, ordinary locator `ariaSnapshot`, root
  or child navigation, iframe owner replacement, turn end, and ownership
  transfer. Page text that resembles a ref cannot register a permitted ref.
  Raw native refs in root/frame/composite/nested selectors cannot bypass the
  capture contract; an ordinary CSS attribute value containing `aria-ref=e1`
  remains queryable. A renamed node retains its identity, a replacement node
  does not inherit the old ref, and a ref-scoped ARIA snapshot succeeds once
  before expiring that capture.
  Each size/depth/frame/ref limit rejects explicitly; missing root or child
  bodies fail within their deadline, and ending control cancels an outstanding
  capture. These three `js-ai-snapshot-*` cases can be selected with
  `OBU_TEST_CASES=ai-snapshot`; their JSON evidence and fixture source digest are
  included in the run artifacts. Snapshot-text parsing in the test selects only
  a fixed unique fixture label; production ref authorization is not regex-based.
- Waiting for an overlay, real React controlled inputs, contenteditable,
  open shadow DOM, same-origin frames, and an actual out-of-process iframe.
- Raw CDP navigation before engine attachment, and raw CDP/engine coexistence.
- CLI `call --method browserAction` and MCP `initialize` / `tools/call` through
  the real executable, with actual page mutations and engine metadata checks.
  CLI, MCP, Python, and the optional Go caller each take their own bounded AI
  snapshot, read a capture-scoped ref, and click it with a trusted page event;
  they do not consume a capture manufactured by the JS test caller.
- Agent cursor presence and background screenshot PNG validity, viewport/crop/
  full-page dimensions, and image changes after a visible DOM mutation.
- Navigation/load waits, returned engine version metadata, finalize cleanup and
  prompt cancellation of an in-flight action.
- Control epochs across turn end: accepted action cancellation, rejection of old
  submissions, no implicit refresh after an external end, and explicit recovery.
- The exact test extension service worker is stopped and restarted through a
  background extension popup. Pre-restart tokens are rejected, explicit SDK
  recovery resumes the original owned tab, and activation events are observed
  continuously across the worker replacement.
- Back/forward/reload, trusted sequential key events, scrolling, HTML drag/drop,
  manual pointer drag, and release of held buttons on timeout or turn end.
- Public concurrent file-chooser wait plus locator click from a cold engine,
  actual uploaded file bytes in the main document and OOPIF, and clearing files.
- Ready-first file chooser waits through JS, synchronous Python/Go, CLI `call`
  and MCP `tools/call`: connection A receives the arm acknowledgement, then an
  independent connection B immediately clicks using the same session/turn/epoch.
  Each entry point covers cold root and OOPIF pages plus an OOPIF created by a
  trusted click after arm. Upload and clear require separate chooser IDs, native
  frame attachment evidence and two exact HTTP POSTs. Clicks and nonempty upload
  changes are trusted; the existing programmatic clear remains untrusted.
  The Node server retains raw POST bytes, decodes real File bytes and checks size/SHA-256 independently
  of the caller's rendered receipt. JS negatives cover original deadline,
  cancellation, foreign scope/cancel, duplicate arm, concurrent collect, an
  uncollected native chooser event, navigation and moved ownership. The existing real
  Pause/Resume scenario also retains a pending chooser collect and checks its
  invalidation without adding any focus allowance. These are test requirements;
  a new run's actual results determine acceptance.
  Build the typed Go checker with
  `go build -o .tmp/go-chooser-waits-client.exe ./scripts/browser-integration/go-chooser-waits-checks`
  and set `OBU_TEST_GO_CHOOSER_BINARY` to that executable. A focused selection
  is `OBU_TEST_CASES='file-chooser|user-global-pause-popup'`; keep the normal fresh
  host/SDK builds and browser settings. No new focus allowance is introduced.
  `chooser-{js,cli,mcp,python,go}.json`
  retain the ready/click/collect timeline and server receipts;
  `chooser-js-lifecycle.json` and `pause-control.json` retain negative outcomes.
  Each JS ready variant also retains a bounded, tab-filtered native frame/target/
  chooser event trace with its original payloads and ready/click/collect timing,
  including failed variants. This passive listener changes no event or result.
- Two independent sessions receive only their own scoped CDP notifications.
- Concurrent same-URL downloads have distinct GUIDs and scoped notifications,
  produce the fixture bytes, reject foreign IDs, report unsupported local path
  lookup, and do not satisfy a fresh wait with an earlier download.
- Explicit `downloadURL` / `download_url` / `DownloadURL` requests through JS,
  synchronous Python, optional Go, CLI `call` and MCP `tools/call` use HTTP GET
  with a real HttpOnly cookie. Two JS sessions request the same URL and basename;
  each returned path must remain inside the isolated download directory, name a
  different file, and contain one exact server response verified by bytes and
  SHA-256. Public opaque handles reject foreign sessions and unrelated native
  numeric download IDs. The unrelated download is created directly by the test
  worker, without an owning task RPC; this does not simulate a human click.
  Server gates verify slow completion, path timeout followed by successful retry,
  explicit cancellation, and cancellation of a late native ID after the start
  deadline. The body gate sends a 4096-byte prefix and retains a nonzero suffix;
  the original one-byte prefix stalled Chromium's native MIME sniffing before
  a download ID existed. `prefixBytes`, `suffixBytes` and `sentPrefixBytes` are
  retained as server witnesses. Native start can wait for response headers and
  sniffed bytes: a rejected start deadline does not cancel its unresolved native
  promise, and cleanup must cancel the exact ID if it arrives later. Timeouts
  were not increased to accommodate that fixture correction.
  Ending a turn, detaching, transferring ownership and the real Pause
  control invalidate owned direct downloads and stop their HTTP streams. Resume
  must not issue another request. Native Page-GUID downloads retain the separate
  unsupported-path behavior above; this suite never queries browser history.
  Paths and per-file hashes stay in ignored run artifacts. The isolated browser
  has `download.prompt_for_download=false`; passing here does not promise that
  other preferences, enterprise policies or extensions cannot display download
  UI. Files are neither opened nor shown. Select this coverage with
  `OBU_TEST_CASES='direct-downloads|python-public-sdk|go-public-sdk|user-global-pause'`
  (eight cases including the mandatory raw prerequisite when Go is configured).
- Console/page-error/network diagnostics from the main document and OOPIF,
  redirect identities, cursor pagination, bounded overflow, UTF-8 truncation,
  and capture expiry after ending a turn or transferring ownership.
- Network wait ready handles through JS, synchronous Python, optional Go, CLI
  `call`, and MCP `tools/call`: create a blank tab, navigate with the public raw
  CDP helper, arm before the first engine click, then collect. Each entry point
  checks a trusted click and an independent server counter of exactly one
  request. CLI processes carry the same explicit session, turn and control
  epoch through all three RPCs; creating another CLI process must not silently
  change the waiter's binding.
  The three `js-network-waits-*` cases also cover cold main/OOPIF request and
  response listeners, exact/contains URL and method/status matching, 503s,
  redirects with request identity, failed connections, historical rejection,
  cancellation, repeated collect, and matched results read after their original
  deadline. Server gates prove response completion at headers before the body
  finishes, and a response can match when its request began before registration.
  The connection-failure fixture separately records its one trusted click,
  one page `fetch` invocation and all server attempts: Chromium can retry the
  POST when the socket closes without response bytes. Only that failure case
  permits multiple transport attempts; the normal five-entry-point requests
  retain the exact-one server assertion. Its response wait must still time out.
  Same-URL sessions cannot exchange waiter IDs; end, detach, owner transfer and
  tab closure invalidate old waits. Sixteen retained terminal records still
  consume a tab's capacity; cancellation permits another arm.
  The existing worker-restart case rejects pre-restart waiters even after an
  explicit new turn. The final Pause case cancels a pending network collect
  before restart, then verifies Resume does not replay the trigger. The fixture
  source digest and `network-server.json` counters are saved even on failure.
  Short discovery/attach deadline injection, per-session/global capacity and
  the 30-second terminal TTL use deterministic unit tests; this headed suite
  does not claim to exercise those timings or quotas.
- Navigation waits through all five entry points: JS, synchronous Python,
  optional Go, CLI `call` and MCP `tools/call`. A cold public raw navigation is
  followed by an acknowledged `expectURL`/`armNavigationWait`, one trusted
  click, and collection of the void result. An independent HTTP counter must
  show exactly one destination document request; CLI calls retain one explicit
  session, turn and epoch. Python and Go establish listener readiness without
  threads or a second connection.
  `js-navigation-waits-direct-and-ready` also checks cold direct
  `Promise.all([waitForURL(...), click(...)])`, SPA/history URL changes, native
  glob matching, a transient intermediate URL, redirects, repeated collect,
  and rejection of a historical intermediate URL. Current-URL and cached
  load-state waits complete immediately: `expectLoadState` observes the current
  document and is not a promise to wait for the next navigation.
  `js-navigation-waits-load-states` uses separate HTTP script, image and fetch
  gates to hold DOMContentLoaded, load and networkidle. A direct state wait must
  not block a concurrent trusted click; the server releases each lifecycle gate
  explicitly, without sleeps for listener readiness.
  `js-navigation-waits-lifecycle` verifies that a URL timeout does not detach a
  concurrently waiting click, and checks cancel, end, explicit detach, ownership
  transfer and tab closure. Existing worker-restart and Pause cases invalidate
  pending navigation handles as well as network handles. Native observer
  cleanup, queue/attach deadline injection, capacity and terminal TTL are covered
  separately by deterministic tests.
  The fixture digest, `navigation-waits-*.json` witnesses and
  `navigation-server.json` counters are retained. Select the five new cases and
  both synchronous SDK callers with
  `OBU_TEST_CASES='navigation-waits|python-public-sdk|go-public-sdk'` (eight cases
  including the mandatory raw prerequisite when Go is configured). Add
  `|control-worker-restart|user-global-pause` for ten cases including recovery.
- The sentinel tab stays active throughout every successful action and failure.
- Element screenshots reveal offscreen same-origin, OOPIF and nested iframe
  owners, including after frame navigation and a cross-origin-to-same-origin
  replacement. The fixture checks exact PNG dimensions, waits for replacement
  content and compares changed pixels; images are retained for visual review.
- A real `tabs.onCreated` background child is left unattached until explicit
  backend claim, then supports snapshot/read/click and normal end-turn cleanup.
  Another session cannot use it. This fixture uses extension tab creation with
  `active:false`; renderer `window.open`/`target=_blank` activation remains a
  separate known gap.
- `js-auxiliary-popup-rendering` and `js-auxiliary-popup-lifecycle` require
  `getInfo.metadata.auxiliaryTabsVersion=1`. They claim real unfocused popup
  windows and check that ownership preserves the original window and group-less
  state. The first engine operation is a single click with its original 10-second
  deadline, followed by a screenshot, real OOPIF input and a network wait.
  Foreign session/tab-target access, concurrent claims, deliverable rejection,
  handoff retention, omission without closing the user's window, external
  movement and closed-window invalidation are checked through public APIs.
  These tests do not claim to repair Chromium rendering after an external
  cross-window move; the normal popup claim avoids that move entirely.
  The existing worker-restart and global-Pause cases also retain and reclaim an
  auxiliary popup, verify old control is rejected, and click only after explicit
  recovery. This is a worker-restart check, not a full browser or extension
  restart check. Clearing `storage.session` is modeled separately in unit tests.
  Select the four affected cases with
  `OBU_TEST_CASES='auxiliary-popup|control-worker-restart|user-global-pause'`;
  the required raw-navigation case makes this a five-case directed run. The
  complete suite contains 53 cases with the optional Go caller, or 52 without it.
  The popup is independently created with `windows.create({focused:false})`,
  not by a page's `window.open`. Initial native popup activation remains
  unsupported as a no-interruption guarantee and is not counted as passing.
  Storage-delay/failure and end/Pause races use deterministic unit tests rather
  than injected faults in this native suite. The claim response is bounded at
  10 seconds, but Chrome's underlying writes remain tracked; a never-settling
  write can keep the existing turn-end drain pending. Pause instead fails closed
  within its cleanup budget. See [popup ownership](../../docs/references/popup-ownership-design.md).
- The final global-pause case opens the real browser action popup, pauses two
  sessions, checks held pointer/key release (including native pointer capture
  remaining after raw `dragCancel`) and blocked high/low-level CDP admission,
  restarts the worker while paused, and requires explicit new turns after Resume. It saves Running/Paused
  popup screenshots. Claim, attachment, engine navigation and raw navigation to
  this extension's own control pages must be rejected, including a control page
  manually moved into an agent's group. Pause invalidates all session epochs, so
  this case runs last.

The pause authorization check uses real runtime messages from the action popup,
an ordinary `popup.html` tab, and a fixture content script. In the tested Chromium
156 build, ordinary extension-tab senders include `tab` and `documentId`; real
action-popup senders include neither. `runtime.getContexts` separately identifies
the live `POPUP` context. The worker therefore verifies the extension ID, exact
popup URL, absence of `sender.tab`, and a matching live popup context. Context
presence is an additional check, not a unique sender/document binding when the
browser omits the sender document ID. These tests do not assert results on an
untested minimum browser version.

The runner leaves the browser window at its default size and validates screenshot
dimensions against the actual viewport. In the tested Chromium 156 build, forcing
`--window-size=1280,1000` made `action.openPopup()` hang even in a standalone
extension probe with no SDK or engine actions. That launch option is omitted.

Results, screenshots, the YAML snapshot, and diagnostic logs remain in the
printed `.tmp/browser-integration/run-*/` directory. Results include the Git HEAD,
dirty status, and SHA-256 digests of the production/staged extension, host and
Go caller executables, JS build, Python SDK, and acceptance scripts used for the
run. Executables and SDKs are copied into the run directory before execution,
so a concurrent rebuild cannot change the tested artifacts. The short temporary IPC
directory is validated and removed at exit. Browser windows and the host created
by this run are closed. A nonzero exit means at least one acceptance check failed.

## Ready-first file chooser acceptance

Focused run `run-bE4e26` passed **9/9**; full regression `run-3OY97j` passed
**83/83**. Both independent audits passed with no findings, retained under
`.tmp/chooser-ready/run-{bE4e26,3OY97j}-audit.json`. The original concurrent
chooser case remains in both selections.

JS, synchronous Python/Go, CLI and MCP each used independent connections with
the same session/turn/epoch for root, existing OOPIF and post-arm dynamic OOPIF
pages. Their upload/clear pairs produced **30 raw POSTs**, plus **6 lifecycle
POSTs**. Audits recomputed file sizes and hashes from retained bodies, checked
document identity and native OOPIF process/session evidence, and distinguished
trusted clicks/nonempty changes from the existing untrusted programmatic clear.
Negative evidence covers duplicate arm, concurrent collect conflict, foreign
scope/cancel, original deadlines, navigation, moved ownership, uncollected-event
cancellation and real Pause. The cancelled chooser's unchanged document was
observed beyond its original deadline; only explicitly armed new waits uploaded.

Earlier failures remain recorded: `run-cAgqZx` **1/9** exposed the browser timer
receiver binding; `run-16fvkO` **4/9** and diagnostic `run-Yzz3ni` **1/2** exposed
a dynamic child's initial commit arriving before its parent's frame swap and
being treated as document replacement. Both defects were fixed with regression
tests. The final successes do not overwrite those runs.

No chooser-specific focus allowance was added. The focused observer recorded
one activation/two focus events, and the full observer six/four; all matched
existing exact fixture-window and explicit-popup attributions. Coverage runs
from observer readiness through its final snapshot, excluding browser startup
and teardown. These runs use the documented loopback `connectNative` adapter,
so they do not establish OS native-registration behavior. Scope evidence is the
retained per-caller binding and frozen caller source, not a complete raw JSON-RPC
transcript; some rejection checks retain their assertion kind rather than the
full rejected response. Cleanup auditing checks retained host exits, not a fresh
OS process inventory. This accepts the tested chooser-ready workflow, not full
P10 or Codex capability parity.

## Ready-first page download acceptance

Build the regular host and SDK artifacts as above, then build the separate typed
Go caller and select the new cases, the retained legacy case, and real Pause:

```powershell
$env:GOTOOLCHAIN = 'local'
$env:GOPATH = "$PWD/.tmp/toolchain/gopath"
$env:GOCACHE = "$PWD/.tmp/toolchain/gocache"
go build -o .tmp/go-download-waits-checks.exe ./scripts/browser-integration/go-download-waits-checks
$env:OBU_TEST_GO_DOWNLOAD_WAIT_BINARY = "$PWD/.tmp/go-download-waits-checks.exe"
$env:OBU_TEST_CASES = 'page-download-ready|public-downloads-session-isolation|global-pause'
node scripts/browser-integration/run.mjs
```

The five `*-page-download-ready-two-connections` cases use JavaScript,
synchronous Python/Go, CLI and MCP. Each uses independent connections under one
session/turn/epoch: arm acknowledgement, immediate trusted page link click from
the other connection, then collect. Each covers a cold root, an existing OOPIF,
and an OOPIF added after acknowledgement. CLI/MCP use the public generic RPCs;
the three SDK callers use the typed wait and existing download handle. These
are page-triggered native downloads; `downloadURL` is never the trigger.

`download-ready-*.json` retains bounded passive original native Page download
events, collected GUIDs, scoped notifications, real child attachment evidence,
trusted DOM click witnesses and complete server response bytes/hashes. The
isolated directory's new completed files must match those response bytes,
including each server-generated nonce. All responses deliberately suggest the
same filename. This filesystem witness is a harness read, **not a public
GUID-to-path mapping**. Public Page GUID path remains explicitly unavailable;
URLs, timing and filenames are not used to infer product download ownership.
The original `js-public-downloads-session-isolation` case remains unchanged.

Failed focused run `run-c0ip6L` remains retained at **7/9**: Python and Go each
produced three native GUIDs and three exact files, but their separate JS monitor
had never sent a scoped request, so the host correctly withheld its scoped
notifications. A local `onNotification` callback alone does not associate an IPC
connection with a session. The harness now awaits public read-only `getTabs`
bootstrap on that monitor before any caller starts; its scope and acknowledgement
are retained as `monitorAssociation`. Notification requirements remain unchanged,
and no missing events are backfilled. This is a harness correction, not a product
download fix or a replacement for a fresh browser run.

The lifecycle case checks the first of two native starts before collect,
concurrent collect conflict, duplicate arm, foreign scope/cancel/source,
historical events, original timeout across navigation, legal navigation under
the original scope, end/old epoch and moved ownership with explicit new claim.
A held real response suffix proves cancelling an uncollected observer does not
cancel its transfer: the old transfer completes while a successor observes,
and only a new click can supply that successor's distinct GUID. Real Pause also
invalidates a pending page download observer without replay after Resume.

No download-specific focus allowance is added. The existing continuous observer
and documented loopback native-message adapter boundaries still apply. Caller
scope and frozen-source evidence is not a complete wire transcript. This does
not establish Page GUID path/transfer-cancel support or full Codex/P10 parity.

Final Go 1.26.9 acceptance passed `run-lMFHcB` **9/9** and `run-k3mDiy`
**89/89**, independently audited against a pre-run source/binary snapshot.
Each run retains 24 original responses and matching actual files (98,376 bytes),
22 collected GUIDs, scoped completion and native OOPIF provenance. Full CI
passed 906 Node tests (771 extension, 53 scripts, 82 harness), JS 115, Python 82
and every Go package, with no skips. The host uses go-winio 0.6.3's official
close fix; the old 601-second Go failure, earlier binaries and toolchain remain
retained. See [IPC transport](../../docs/references/local-ipc-transport.md).

Earlier full `run-Ni9Djz` **87/89** failed both popup cases with an inactive
root window, ultimately recorded as minimized. Its full ledger has six allowed
fixture activations and zero focus events; it lacks initial window state and
does not establish a cause. The runner now saves raw `focus-initial-state.json`
and `focus-final-state.json`, also in `results.focusLedger`, containing window
state/focus, active tabs, sampling timestamps and the complete observer ledger.
These are asynchronous read-only snapshots, not atomic OS foreground evidence.
No focus/unminimize call or allowance was added. Both final runs began with a
normal focused root window; this does not explain away the earlier failure.
The full final observer covers 129,574 ms with six fixture activations and four
intentional popup focus events, all precisely attributed under the prior rules.
It excludes browser startup and teardown. Host SIGTERM belongs to the explicit
restart test; the successor exits normally. Historical failures remain failures,
including the separate Edge native-launcher focus gap.

## Isolated clipboard acceptance

The default headed suite never reads or writes the system clipboard. Clipboard
checks require `OBU_TEST_MEMORY_CLIPBOARD=1` and the exact Windows Chromium
binary audited in `memory-clipboard.mjs`. Before any clipboard call the runner
checks the executable SHA-256, native version/revision and actual Headless
command line. A new profile alone is not a clipboard isolation boundary.

Set `OBU_TEST_CASES='clipboard'`, `OBU_TEST_HOST_BINARY` to the freshly built CLI
and `OBU_TEST_GO_CLIPBOARD_BINARY` to the separately built
`./scripts/browser-integration/go-clipboard-checks` executable. Python must be
available on PATH. The five public callers use their copied SDKs/executables,
synthetic Unicode text, HTML and a two-pixel PNG. Results retain the guard,
source hashes and native clipboard artifacts for independent pixel inspection.
Windows text newline conversion and browser HTML/PNG rewriting are expected;
the test does not require byte-identical PNG encoding.

The lifecycle fixture holds the production broker's final asynchronous scope
validation after preparation, ends the turn, and checks that cancellation
prevents native commit while turn end waits for cleanup. This is explicit
fault injection through a backend reference added only to the staged test build;
it does not mock native clipboard APIs or grant authorization. The reference is
recorded in `sourceIdentity.testHooks` and absent from production packages.
Preparation and ownership errors must leave the seeded
clipboard unchanged. Tab activation and window focus ledgers remain checked.

The memory mode also runs `js-clipboard-worker-restart`: a real worker stop/start
interrupts a prepared write. The old caller must fail, an explicit new turn must
read the seeded content, and recovery must close the original offscreen document
without replaying the write. Together with the mandatory raw navigation case,
the clipboard selection contains eight cases. Committed native promise hangs
and marker-storage failures use separate deterministic tests.

These checks establish behavior against Chromium's in-memory clipboard, not
headed OS clipboard behavior or desktop focus. The temporary process currently
uses `--no-sandbox`; no daily browser profile, installed extension or native
clipboard is touched. See the [contract and limitations](../../docs/references/clipboard.md).

## Image source downloads

The media fixture exercises `locator.downloadMedia` through JS, Python, Go,
CLI and MCP. It downloads the exact image's selected HTTP(S) source using the
production utility-world adapter, then checks the file bytes against a synthetic
two-pixel red/green PNG. `picture`/`srcset`, semantic locators, open shadow roots,
same-origin, OOPIF and nested frames are covered. Main-world prototype and
instance getters return a poison URL; neither those getters nor input events
may run. Unsupported elements/sources, strictness and foreign ownership must
fail without a download GET.

Build the current host and the separate Go caller, then set
`OBU_TEST_HOST_BINARY` and `OBU_TEST_GO_MEDIA_BINARY` to their executables:

```sh
go build -o .tmp/media-host ./cmd/open-browser-use
go build -o .tmp/go-media-checks ./scripts/browser-integration/go-media-checks
OBU_TEST_HOST_BINARY=.tmp/media-host \
OBU_TEST_GO_MEDIA_BINARY=.tmp/go-media-checks \
OBU_TEST_CASES='^(js|python|go|cli|mcp)-media-downloads$' \
node scripts/browser-integration/run.mjs
```

On Windows, use `.exe` outputs and the equivalent PowerShell environment
assignments. Python must be available on PATH. The runner supplies each caller
with the endpoint, fixture URL, exclusive output path and this run's download
directory. The Python/Go helpers do not launch a browser or inspect a real user
profile. They retain file bytes, SHA-256 and base64 evidence, then cancel the
download handle and finalize their independent sessions.

`media-js.json`, `media-{python,go,cli,mcp}.json`, the copied callers and
`media-download-server.json` retain source hosts, GET counts, cookie presence,
files and source/binary hashes. Cross-frame cookies are observed separately:
downloads have no tab/frame parameter, and this test does not prove partitioned
authentication or inspect browser third-party cookie settings.

The phase result `run-yzlAP6` passed six cases, including mandatory raw
navigation, using the pinned Headless guard enabled by
`OBU_TEST_MEMORY_CLIPBOARD=1`. Ten PNGs and all recorded hashes were independently
checked; the continuous observer recorded no activation or window-focus event.
That guard name comes from clipboard isolation; this media selection performs
no clipboard operation. This is not headed acceptance or a fix for P09.
The final selection `OBU_TEST_CASES='media-downloads'` also runs reference,
lifecycle and navigation checks. With the context-lease fix, `run-FDmPto` passed
9/9 under that guard; the same production, SDK, host and fixture hashes ran
headed in `run-XLWzut`: all eight media cases passed, while mandatory raw
navigation timed out, so the run remains 8/9. Each run retains seventeen PNGs
with verified red/green pixels and seventeen explicit download GETs. The
continuous observer recorded no activation or focus event in either run.

References cover root/shadow/same-origin/OOPIF/nested images, stale/removed refs,
foreign handles and separate files/IDs for the same URL in two sessions. The
lifecycle fixture deliberately holds delivery of an already settled native
capture result, changes its source/node, ends the turn, or navigates the exact
tab. It requires either one completed release of the original object or native
destruction of that object's exact context, and no extra download GET. This is
explicit delivery fault injection, not evidence of an unresolved native call.
The failed process run `run-cAYlXr` remains 6/9. Its fixture interference was
corrected by distinguishing one renderer fallback load, avoiding a navigation
queued behind its own held source, and observing the page without SDK
reattachment after turn end. No failed record was rewritten as passing.

Complete local CI passed with 663 extension/script tests, 93 JS tests, 63 Python
tests, Go packages and the other workspace checks. These results do not repair
the headed startup compositor or establish complete Browser Use parity.
Those runs covered the historical HTTP-image slice. The broader current
[media contract](../../docs/references/media-downloads.md) also supports finite
audio/video, data/Blob content and Canvas PNG.

### Embedded media and cancellation

`OBU_TEST_CASES='media-(downloads|breadth|read-cancellation)'` includes the old
eight image cases, six additional breadth cases, one cancellation case and the
mandatory raw-navigation prerequisite. The new fixtures generate a PCM WAV,
retain a tiny deterministic VP8 WebM, and encode red/green Canvas pixels. Native
`decode` / `loadedmetadata` / `loadeddata` readiness is checked before downloads;
files are checked byte-for-byte, including two complete 8 MiB PNG files with
explicit zero padding. Actual OOPIF, nested frame, shadow, getter/fetch/Canvas
overrides and normal-fetch versus media-fetch Blob partition access are covered.
Python uses a Blob WAV, CLI a data WebM, and Go/MCP Canvas PNG, alongside their
unchanged historical HTTP PNG cases. Rebuild the Go media helper for its
`OBU_TEST_MEDIA_VARIANT=breadth` branch.

Negative cases retain errors and verify no new file or download GET: empty
elements, zero/oversized/tainted Canvas, revoked or oversized Blob/data, MSE,
`srcObject` and real attached ClearKey `MediaKeys` when available. Availability
and browser partition policy are recorded; a policy-permitted Blob access is
not described as proof of a blocked boundary.

`media-content-lifecycle-fixture.mjs` replaces only the selected fixture's
utility-world Blob fetch with a controlled AbortSignal gate. Two cases leave
the renderer's fetch Promise pending; two return a native `ReadableStream`
whose reader stays pending. Each is cancelled by turn end or the original
deadline. These are explicit renderer fault injections, not a production hook
or a claim of a naturally stalled network. The actual native call remains
pending until cancellation; the fixture checks abort, stream lock release,
native settlement and exact source object release. A synchronous observer in
the staged native Port adapter records cleanup state before the end response
is emitted. End acknowledgement must follow exact cleanup, with no native
download, input event or getter trap. The four cases restore the utility hook
before detachment and do not reattach merely to read the result.

`run-L7XsRk` passed all **16/16** headed cases. Independent validation decoded
or parsed 36 actual media files, checked both 8 MiB boundaries, 12 negative
cases including available native ClearKey, all four cancellation paths and the
same-origin/cross-partition rejection. Its continuous observer recorded no
activation or focus event. Complete-suite evidence is recorded separately in
the [media reference](../../docs/references/media-downloads.md).

## Ownership and host recovery

Select `OBU_TEST_CASES='js-owned-tab-revocation|js-native-host-restart'` for the
ownership/disconnection checks (mandatory raw navigation also runs). The
synthetic pages retain trusted pointer/key events and a target which appears
only after revocation. The fixture checks three actual Chrome tab operations:
ungroup, transfer into a foreign task group, and move to an unfocused normal
window. It verifies cancellation, release of pointer capture and Shift,
debugger detachment, and explicit reclamation. Observation uses fixed scripting
reads on the exact fixture document and does not reattach through the SDK.

The host case terminates the real frozen host executable and waits for its PID
to exit before closing that generation's WebSocket Port adapter. A new host
gets a new PID and endpoint; the extension reconnects using its normal alarm.
No queued old native frame or response is replayed. The same browser, worker,
profile and continuous focus observer remain alive. The fixture explicitly
connects and begins a new turn, and verifies the old epoch cannot act.

`recovery-tab-ownership.json`, `recovery-native-host.json`, source hashes and
`results.json.nativeHostGenerations` retain the evidence, including failed
cleanup. A new window's sole-tab creation activation is attributed to that
exact creation interval; the later tab move gets no activation/focus exception.
This is not a full browser restart, extension reload, or installed native-host
launcher test. Run the entire suite after lifecycle changes because existing
worker, transfer, Pause and policy recovery must remain compatible.

Final `run-PeM3FT` passed 63/63 on the controlled headed baseline, with matching
production/SDK/host/harness hashes. The continuous ledger contains five popup
and one normal fixture window's sole-tab creation activations, plus four focus
events from two deliberate action-popup opens. No other foreground event was
allowed. Earlier full `run-ssmjWr` remains 12/63: normal target closure exposed
a late CRX detach failure which incorrectly triggered global Pause. The focused
failure `run-4NEQV8` and original release-error witness are retained. Successful
cleanup now requires the original attachment's native destruction evidence;
error text alone is never treated as proof.

After the browser-lifetime and explicit-claim orphan recovery changes below,
the final unchanged 63-case suite also passed as `run-hlPRVD`. Its production
hashes match the separate four-case restart run. The original focus accounting
remains six exact sole-tab creation activations and four focus events from two
intentional popup opens; there are no additional foreground events.

## Same-profile browser restart and extension reload acceptance

`browser-restart.mjs` is a separate, opt-in headed runner. After installing the
dependencies above, build the current JS SDK and native host, then run it from
the repository root:

```powershell
pnpm --dir packages/open-browser-use-js build
go build -o .tmp/open-browser-use.exe ./cmd/open-browser-use
$env:OBU_TEST_HOST_BINARY = (Resolve-Path .tmp/open-browser-use.exe).Path
node scripts/browser-integration/browser-restart.mjs
```

On Unix, use an executable without `.exe` and set `OBU_TEST_HOST_BINARY` with
the shell's environment syntax. `OBU_TEST_CHROMIUM_BINARY` and
`OBU_TEST_FIELD_TRIAL_CONFIG` have the same meanings as above. This runner is
always headed, runs all eight cases, and does not use `OBU_TEST_CASES` or the
memory-clipboard switch. `browser-restart-w5chI9` passed **8/8**, including
final process cleanup and all six generations' focus validation. The earlier
`browser-restart-ShnPfH` **4/4** result applies only to the original four cases.

The runner creates one private profile and passes `--restore-last-session` in
every generation. It does not seed or modify protected preferences.
Chromium's pinned [startup implementation](https://github.com/chromium/chromium/blob/f842f52ef39fd97b449eb27cff414bf05a98ddce/chrome/browser/ui/startup/startup_browser_creator.cc#L808-L865)
recognizes that switch and requests the last session for an existing profile;
the first launch of a new profile has no session to restore. Six successive
browser processes use that same profile, executable and argument list. Every
transition calls `Browser.close`, waits for actual process exit, and starts a new
browser. Forced teardown is recorded as a failure. This tests explicit session
restoration under that command-line policy; it does not promise that all browser/profile
configurations restore tabs or groups. No user's profile or settings are read
or changed.

Before coverage starts, the first generation enables developer mode using the
actual `chrome://extensions` toggle and verifies the browser's profile state.
`Extensions.loadUnpacked` bootstraps the product and independent observer, then
the extension manager's normal `developerPrivate.reload` loads each as an
ordinary persistent unpacked installation. Product bootstrap waits for the
original install dispatch and hello; normal reload waits for old-worker removal,
replacement Port and native update dispatch. A registry entry marked enabled
alone is insufficient. Later generations must find both installations already
enabled; no installation or reload command is sent on their behalf.

The private browser uses `--enable-unsafe-extension-debugging` for this declared
setup and read-only installation inspection. It never uses `--load-extension`.
Chromium deliberately [removes CDP-only installation records at profile startup](https://github.com/chromium/chromium/blob/f842f52ef39fd97b449eb27cff414bf05a98ddce/extensions/browser/extension_prefs.cc#L2383),
so merely repeating CDP installation would not test persisted startup. The
[normal reload path](https://github.com/chromium/chromium/blob/f842f52ef39fd97b449eb27cff414bf05a98ddce/chrome/browser/extensions/chrome_extension_registrar_delegate.cc)
uses a new ordinary unpacked installer. The final retained profile records
location 4 and creation flags 38 for both test extensions; subsequent real
process launches deliver native `onStartup`, without reinstalling or emitting
synthetic events. Setup is outside the recorded background-action interval.

The initial `browser-restart-ucmbPs` run remains **0/4**. Its manually seeded
`session.restore_on_startup` preference was absent from the retained profile,
and each replacement browser initially contained only a new tab, so the first
two cases timed out waiting for real restored pages. Pause persisted, causing
the remaining cases to fail before their actions began. The runner now requests
restoration explicitly; it never recreates missing fixture pages to pass the
restoration assertion. The failed run remains separate from the final result.

The next `browser-restart-yH1Qzu` remains **0/4**: tabs/groups restored, but the
test tried to read a deliverable whose status was still `unloaded`. The stricter
readiness run `browser-restart-kTnp4S` remains **1/4**: the unpaused case passed;
in the paused case the task document loaded, but its deliverable stayed
`unloaded` through the 30-second wait. Later cases were blocked by that retained
Pause. The runner now requires an actual loaded HTTP task document for DOM and
no-replay assertions, while preserving an unloaded deliverable through exact
tab/group identity and unchanged server mutation witnesses. It never activates
or reloads the deliverable to manufacture a readable DOM, and metadata-only
evidence does not claim that its document loaded or stayed byte-identical.

`browser-restart-kmDdeo` remains **2/4**: both whole-browser cases passed. The
session-state-loss case encountered an already-attached debugger during
explicit recovery. The held-input case proved unchanged capture, blocked
admission and the original tab's native removal, but Chrome rejected opening a
second popup for an inactive window. Its continuous ledger contains no new
activation/focus event during removal; all earlier focus events came from the
recorded intentional popup openings. The runner now retains the first real
Failed popup through Retry and Resume, without focusing a window or relaxing
the event allowance. Final `browser-restart-ShnPfH` passed both explicit recovery
after session-state loss and this retained-popup sequence.

1. `browser-restart-unpaused`: retain named task and deliverable groups, submit
   a waiting action, then replace the browser process. Old active and idle
   epochs must fail. Restored pages must not become owned solely through stored
   numeric tab/group IDs; only explicit claim permits a new trusted action.
   A late-appearing target and server witness check that the old action was not
   replayed in the loaded task document. Deliverable preservation compares its
   tab ID, URL, window, group identity/title/color and server mutation witnesses,
   allowing Chrome to keep it unloaded. Observed ID intersections are retained without claiming that a
   particular run forces Chrome to reuse IDs.
2. `browser-restart-paused`: pause through the real action popup, replace the
   browser again, and require Pause to remain effective. Create, claim, input
   and raw CDP must stay blocked until explicit Resume, begin-turn and claim.
3. `same-browser-session-state-loss`: clear the private extension's actual
   `storage.session` and stop/start its real worker. The browser PID and browser
   CDP identity remain unchanged. Old ownership and epochs must not recover
   implicitly. This is deliberate session-state loss, **not** extension reload
   or a substitute for either whole-browser restart above.
4. `worker-input-state-loss`: send public raw mouse-down and Shift key-down to
   a synthetic page and require trusted events plus pointer capture. Replace
   only the worker, retaining the same session marker. Fixed page reads must
   show that the original document still holds capture while the new worker
   reports Failed, blocked input and incomplete cleanup. Only closing that
   original tab, with an independently recorded native `tabs.onRemoved` event,
   permits the real popup's Retry pause to complete. Resume and explicit
   begin-turn must then allow a new trusted action. An empty replacement
   tracker is never accepted as evidence that native input was released.
   Failed, retried Paused and resumed Running screenshots must come from the
   same live popup context/document and CDP target. Before each capture, the
   actual rendered label and enabled button must match Failed / Retry pause,
   Paused / Resume control, or Running / Pause all agents; a backend status
   reply alone is insufficient. Only the initial popup open
   has a focus allowance; blocked actions, original-tab removal, Retry, Resume,
   popup close and the new task action must add no focus or activation event.
5. `extension-reload-unpaused`: start a real pending native locator with a finite
   deadline, invoke `runtime.reload()` exactly once and require native destruction
   and creation events, a new worker/context/boot/Port/session marker, and the
   same browser, installed instance and independent observer. Reveal the target
   before the original deadline. The old request must fail, produce no late click
   or server mutation, and never appear in the replacement Port's RPC metadata.
   Original task and deliverable documents/data remain unchanged; explicit new
   turns and claim are required for subsequent trusted input.
6. `extension-reload-paused`: actual reload must preserve Pause. Begin-turn,
   create, claim, fill and raw CDP remain blocked, with unchanged original DOM
   and server witnesses. Retain one real post-reload popup through the status
   check and explicit Resume; reopening a popup is not a reason to focus a window.
7. `extension-reload-held-unwitnessed`: a trusted held pointer and Shift remain
   on the same document across actual reload. The durable risk and Failed state
   survive rejected actions and real Retry pause. Even native removal of the
   original tab cannot retire its old-incarnation record. Two actual profile
   restarts are required: the first stamps the previously unwitnessed risk and
   remains blocked; the second's different native startup witness retires it.
8. `extension-reload-held-witnessed`: admit held input after a witnessed startup,
   reload and repeat the same blocked-input/removal checks. One subsequent real
   profile startup retires this already-witnessed old risk. In both held cases,
   recovery remains blocked in Failed or completed Paused until explicit Resume,
   then requires a new turn and trusted action. If initialization already finished
   Pause, a redundant Retry is unnecessary. The same final popup is retained
   through its remaining recovery steps; no compensating input is injected.

In the earlier four-case run, both restored deliverables were initially `unloaded`; their
preservation evidence is tab/group metadata and unchanged server mutation
witnesses, not loaded-document content. The task documents were loaded and
explicit claim enabled one trusted action each; the old epochs and unclaimed
actions were rejected. The fourth case retained one popup context, document and
CDP target across the real Failed / Retry pause, Paused / Resume control and
Running / Pause all agents UI snapshots. Its original held-input tab had an
exact native removal event before successful Retry; the subsequent new turn
produced a trusted action.

Each browser generation has its own independent focus observer and validated
final snapshot. The observer now belongs to a separate test extension with only
the `tabs` permission; worker replacement and OBU reload retain that same
observer target, extension identity and append-only event history. Whole
browser exits necessarily leave recorded gaps between observers: their logs
are not stitched into an uninterrupted zero-focus claim. Only exact events
around intentional action-popup openings receive the existing narrow allowance;
ordinary task actions receive none. Initial sentinel setup and final teardown
are outside the recorded action interval. Final `browser-restart-ShnPfH` records
zero tab activations and eight focus events, all attributed to four intentional
action-popup openings. It records no additional event after the fourth case's
initial popup opening; it is not a zero-focus claim across browser restarts.

The runner copies the host and JS SDK, builds into its own temporary extension
directory, and records production hashes before staging the native Port adapter
and independent observer. The host is real; native-host registration and the
browser's installed host launcher remain outside this adapter test. No test
observer, fixture or adapter is copied into the production extension source or
default distribution directory. Artifacts under
`.tmp/browser-integration/browser-restart-*` include `results.json`, per-case
details, `browser-N.json`, `focus-N.json`, popup PNGs, process/host identities,
restart gaps and source hashes. All eight distinct cases and final cleanup/focus
checks must pass for a zero exit status. Reload failures also retain available
Target/Port/focus evidence. The adapter retains its native-host process across
extension reload, so the old pending request uses its actual finite deadline;
this does not certify browser native-port EOF settlement. Signed-package update,
disable/re-enable, crash/forced termination and direct browser exit with held
input still present remain separate cases. In the two new held-input tests the
original tab is closed before profile restart, but its unresolved journal must
still survive until qualified startup evidence. Native host registration and
installed-host launch remain outside this staged Port adapter boundary.

The expanded suite retains its unsuccessful runs. `browser-restart-9gmJt7`
was **4/8**: command-line install became ordinary unpacked on reload and was
disabled because developer mode was off (native reason `1 << 24`).
`browser-restart-j31iqu` was **5/8**: reload and paused admission checks worked,
but reopening the post-reload popup was rejected for an inactive window.
`browser-restart-TIhZUP` was **6/8**: repeated command-line installation generated
install events, not the startup witnesses needed for recovery. The folder-drop
setup probe `browser-restart-bbnMFd` failed before any case; CDP drag delivery
did not establish the native UI drop state needed by the extension installer.
`browser-restart-XJtixZ` was **0/8**: bootstrap reload raced initial installation
dispatch; its first action timed out and later cases could not proceed. Final
`browser-restart-w5chI9` **8/8** uses explicit bootstrap readiness and persistent
profile loading. No failed run is rewritten, no synthetic startup clears the
journal, and no foreground workaround or extra focus allowance makes a case pass.

## Native first-frame diagnosis

`node scripts/browser-integration/rendering-probe.mjs` runs the minimal native
extension independently of the SDK, host and production extension. It uses the
pinned Playwright executable, a fresh profile and generated loopback pages.
The default `startup-and-secondary` mode compares inactive targets in the
startup window and a subsequently created unfocused normal window. The other
explicit modes are `no-startup-window`, `popup-then-normal` and `app-startup`.
The app mode tests the original synthetic app page itself before the normal
window; that first result is an active-page control, not inactive-tab acceptance.

Each stage requires a real screencast frame and completed ACK before sending
one trusted synthetic-page click and capturing a PNG. It records native promise
settlement separately from observation timeouts, viewport/scroll state, raw
activation/focus events, browser/source hashes and cleanup. A missing first
frame produces a nonzero exit and is never replaced by rAF success or replayed
input. Artifacts remain under `.tmp/browser-integration/rendering-*`.

`--startup-trace` (only with `startup-and-secondary`) starts tracing before
browser creation and retains the raw Perfetto stream, exact revision, config
and source hashes, stage clock markers and bounded stream cleanup. Its Windows
helper takes read-only root-process HWND snapshots; these are not a continuous
OS foreground log. The probe preserves native promises after observation
deadlines and retains partial or unexpected trace bytes as failed evidence.
Offline decoding must verify startup coverage and typed scheduler fields;
successful tracing setup alone never proves either.

The probe defaults to the browser's own field-trial policy, independently of the
acceptance runner. Add `--disable-field-trial-config` with `--startup-trace` for
the controlled baseline. The alternative `--disable-initial-surface-sync`
reproduces the narrower command-line experiment; Chromium can skip an entire
testing study when any of its features is overridden, so it is **not** an
isolated single-feature experiment. The two comparison flags cannot be combined.

The probe closes only its private browser. Root-process exit, actual native
command settlement and trace-stream cleanup are reported separately;
descendant processes are not inventoried. These diagnostics do not repair
production rendering. See the [retained failures and source analysis](../../docs/references/headed-browser-startup.md).

## Shared multi-step form workflows

`form-workflow-fixture.mjs` serves three deterministic layout variants of the
same synthetic request. All data stays on the loopback fixture. It includes
duplicate names, hidden/retired decoys, `has`/`hasNot`/`visible`/`and`/`or`, native
single and multi-select controls, idempotent checks, Chinese/emoji, open shadow
DOM, same-origin and cross-origin frame saves, and one final submission.
The server validates the exact payload and requires both frame saves before it
issues a visible receipt. Evidence retains all three POSTs and page-observed
input events; those observations are not server-authenticated hardware events.

Build `./scripts/browser-integration/go-form-workflow-checks` and set
`OBU_TEST_GO_FORM_BINARY` to that executable. Select `OBU_TEST_CASES='form-workflow'`
with the normal host environment. Seven cases cover JS variants 1/2/3 and
Python, Go, CLI and MCP variant 1. CLI/MCP actions and receipt screenshots go
through their actual public `browserAction` transport, using descriptors from
the JS public Locator builders; connection, tab setup, navigation wait and
cleanup still use the SDK and are explicitly recorded. Each run stores receipt,
server ledger, action trace, source hashes and five JS/CLI/MCP receipt PNGs.
Python/Go failures retain stderr and server records even if no caller artifact
was emitted. The standard native-navigation/focus observer checks still run.

For an independent browser comparison, start
`node scripts/browser-integration/form-workflow-server.mjs` in an interactive
terminal. Use its printed URL with `/form-task/<fresh-key>?variant=1` (or 2/3),
follow the visible task, read the receipt and follow its evidence link. Enter
`stop` after closing the test tab. The server writes ready/source identity,
server evidence and a shutdown record below `.tmp/browser-integration`.
It never drives the comparison browser. Keep failed method attempts and any
fallbacks separate from exact final task success; browser/profile versions and
different API overhead do not support a speed or overall parity claim.

## Shared multi-page research workflows

`research-workflow-fixture.mjs` serves a procurement review task with three
suppliers, fresh amounts and source revisions for each task, expired-summary
decoys, and three document layouts. Current quotations appear in the root page
or a same-origin frame; delivery and warranty terms appear in an existing or
dynamically added cross-origin frame. The visible brief provides the constraints.
Each caller reads the current sources, computes totals and every disqualifying
condition, fills a comparison report with six exact source links, submits once,
reads the receipt and retains the report while closing its other four tabs.

All five entrypoints run all three layouts: JS, Python and Go use their typed
SDKs, while CLI and MCP use their own public transport for control acquisition,
tab creation, reading, input, screenshots and finalization. CLI/MCP do not borrow
the JS SDK for setup or cleanup. The drivers share the visible task contract;
they do not read the server's private oracle, fetch source pages directly, or
submit outside the page's ordinary form controls.

After the normal prerequisites, build the research Go caller with the pinned Go
toolchain and select the focused cases:

```powershell
go build -o .tmp/go-research-workflow-checks.exe ./scripts/browser-integration/go-research-workflow-checks
$env:OBU_TEST_GO_RESEARCH_BINARY = (Resolve-Path .tmp/go-research-workflow-checks.exe).Path
$env:OBU_TEST_CASES = 'research-workflow'
node scripts/browser-integration/run.mjs
```

Keep `OBU_TEST_HOST_BINARY` set as described above. This selection runs fifteen
research cases plus the mandatory native-navigation prerequisite. For the full
suite, configure the other Go helper binaries documented here and remove
`OBU_TEST_CASES`. The recorded focused `run-AOpN3n` passed **16/16** and full
`run-WWWaGP` passed **104/104** on Windows Chromium 156.

Each run retains caller observations and calculations, original server GETs and
POST bytes, receipts, fifteen report PNGs and source identities. The independent
server oracle verifies the submitted facts, all exclusion reasons and the lowest
compliant total. A passive native tab observer verifies 75 creations, 60 removals
and 15 inactive retained reports; pre-existing URLs, windows, groups and pinned
states must remain unchanged. The continuous focus ledger receives no new
allowances for these tasks. The focused run recorded no activation or window-focus
events during its measured interval. Full-suite allowances remain limited to the
existing fixture-window and explicit control-popup events, not research actions.

For an independent browser comparison, start the material server in an
interactive terminal:

```sh
node scripts/browser-integration/research-workflow-server.mjs
```

Open its printed URL with `/research-task/<fresh-key>?variant=1` (or 2/3), follow
the visible brief, and keep the completed report while closing the research
pages. Enter `stop` in the server terminal when finished. The server closes its
connections, flushes evidence and writes `closed.json` before exiting.
In an automated exec session, start the server with writable stdin or a PTY and
keep stdin open so that `stop` can be delivered; forced process termination is
not a graceful server shutdown. Its `ready.json`, private `server-evidence.json`
and shutdown record live under a new
`.tmp/browser-integration/research-comparison-*` directory. Private scoring data
is for post-run auditing only and is not a browser route or solver input. The
server never controls the comparison browser.

This is a scripted, finite task benchmark, not proof of arbitrary model research
quality, speed, OS focus behavior in another browser, or complete Codex parity.
The main suite still uses the declared Native Port adapter; it does not replace
the separate real native-launcher tests. Preserve failures and fallback paths in
an independent comparison. See [shared research workflow](../../docs/references/shared-research-workflow.md)
for the task contract, evidence and comparison boundaries.

# Browser integration acceptance

## Hover delivery and recovery

The ordinary suite includes `js-hover-delivery` and `js-hover-native-pause`.
Select both with `OBU_TEST_CASES=^(js-hover-delivery|js-hover-native-pause)$`
and the normal host/browser prerequisites below; the raw-navigation control also
runs. `hover-delivery.json`, `hover-native-pause.json` and their server artifacts
retain original native input/ACK, frame/document, page event and POST evidence.

Seven public locator-hover scenarios cover root, same-origin, OOPIF and transformed
OOPIF with first/all moves deliberately dropped by a synthetic-ACK gate. Each
success must have exactly one native target move and original POST, including a
disabled target, target movement/removal and a covering menu. The covering menu
must also initialize once from its normal trusted compatibility `mousemove`.
No synthetic DOM events or child direct input are used. All-drop cases require
the original 5000ms backend wire timeout, no business input and no extra Input
commands hidden by the inner mouse-only gate.

The optional NativeHostBridge observer timestamps exact request/response metadata
in the same Node process as the caller, synchronously before forwarding. Budget
deductions and caller settlement are checked there, while worker input/held-ACK
sequence remains separate. IDs, scope, budget and errors must agree across both
observers. Cross-process wall clocks cannot prove sub-millisecond causal order.

The separate Pause case holds publication of one actual successful move ACK;
it does not suppress that move. Original deadline errors must reach the wire
while publication remains held. Pause must spend its unchanged 10-second cleanup
budget and fail with the actual cleanup-timeout cause; premature Resume stays
blocked. Release, explicit Retry Pause/Resume, old-scope denial and exact tab/target
cleanup follow without replay. The 30-second gate watchdog is always failure.
Teardown keeps inner and outer errors, and writes server evidence before the main
detail. Final results and actual exit remain authoritative if persistence fails.

The gate and staged backend reference are private test instrumentation, not natural
compositor-failure, native-host installation or popup-UI acceptance. No additional
focus allowance is added. See [hover contract and results](../../docs/references/hover-delivery.md).

## Screenshot native completion

The ordinary suite includes `js-screenshot-native-drain`. To select it with
the existing stream regression, set `OBU_TEST_CASES` to
`^(js-screenshot-native-drain|js-screencast-concurrency)$` and run
`node scripts/browser-integration/run.mjs` with the normal host/browser
prerequisites below. The mandatory raw-navigation control also runs.

The fixture holds delivery of an actual successful `Page.captureScreenshot`
result after Chromium has generated its PNG. It checks the original wire timeout,
real production rendering queue/drain identity, successor stream order, and the
unchanged 10-second Pause budget. External streams explicitly queue stop then
start; Pause must reject both without replay. After release, Retry Pause/Resume
must finish cleanup, reject old scope and allow a fresh turn.

Five scenarios cover raw internal/external streams with successor/Pause and a
high-level internal screenshot with Pause. `screenshot-native-drain.json` and
seven PNGs retain original results and subsequent frame pixels. The 30-second
delivery watchdog is always failure. The test-only gate and staged backend
reference do not enter production builds. This is neither naturally slow raster
acceptance nor new native-host installation/popup UI coverage; see
[completion contract and results](../../docs/references/screenshot-completion.md).

## Native created-page provenance

For real native-host termination with a surviving worker, use the separate
`OBU_TEST_NATIVE_MODE=created-page-host-loss` mode of `native-lifecycle.mjs`
[described below](#created-page-host-loss-mode). It is not a `run.mjs` mode.

`OBU_TEST_CREATED_PAGES=worker-restart` uses the same prerequisites and three
natural unowned root children: collected/attached, matched/undelivered, and
collected then publicly ended/idle. It replaces the real service worker target,
keeps the same host and endpoint, tests all old scopes before explicit new turns,
and verifies original documents, durable authority removal and usable sources.
A persistent extension-page storage observer follows the original claims through
quarantine and deletion. Its events are delivery evidence, not storage Promise
ACKs. Worker-native and RPC streams are retained separately before and after
replacement; startup recovery is outside those native observers.

Run `node scripts/browser-integration/run.mjs` with this mode set. Results stay
in `created-page-unowned.json`, including `workerRestart`, both worker streams,
the continuous storage chain and actual cleanup. The original 20s action budget
is followed by a separate 30s restart/observation budget. Checks surround helper
calls; internal restart RPC waits retain their own bounds and are not cancelled.
`MIrY1h` verifies all three lifecycle paths but exits 1 because original child
creation changes window focus. Focus errors are retained while observing
recovery, then fail the unchanged final gate. Failure cleanup has no new focus
or successor-activation allowance. This is neither host-loss acceptance nor a
passed background-window scene. See [worker recovery](../../docs/references/created-page-waits.md#created-page-worker-recovery).

`OBU_TEST_CREATED_PAGES=unowned` uses public `newTab({backgroundWindow:true})`
sources and natural Control-click children. Two independent owners exercise
root, existing OOPIF and future OOPIF. One owner collects and submits a child
form before finalization; the other cancels after matching but before collection,
checks expired collection and denied attachment, then re-arms and cancels to
verify the source reverse lock was released. Both paths retain the native child
and revoke its auxiliary ownership, storage record and debugger attachment.
The fixture removes these exact retained pages only after verifying that result.

The current real-browser result is **failed**: `n7WyEq` (and earlier `ozpg7l`,
`7GbZtP`) stops in the root group because natural Control-click activates the
background source windows. Both root children were genuinely unowned before
adoption; the final run additionally verifies matched cancellation and authority
release after failure cleanup. It does not pass normal finalization, OOPIF or
the complete six-case matrix. See [evidence and focus diagnosis](../../docs/references/created-page-waits.md#unowned-adoption-and-background-window-focus-failure).

This mode uses the usual host/browser prerequisites and does not need the Go
five-entry helper. Run `node scripts/browser-integration/run.mjs` with the mode
set. `created-page-unowned.json` retains the original adoption/storage/native RPC
acknowledgements, source documents, lifecycle checks and cleanup; the shared
server and focus artifacts remain authoritative. The staged backend reference
and bounded passive wrappers are never added to the production extension.
`created-page-native-control.mjs` records original debugger command parameters,
selected tab/window control calls, their original Promise settlements and native
creation/activation/focus events in one sequence. It issues no native queries or
focus restoration; Runtime arguments can contain fixture script text. Both
business outcomes run before the first strict finalization focus assertion. An
assertion failure still stops the matrix; actual finalization in `finally` may
be observed under a separate 20s budget without changing that failed result.
Underlying SDK/worker RPCs retain their own 20s bounds; expiration prevents the
next observation, not an already-dispatched native operation. The wire observer
remains active through failed-run cleanup so those ACKs are separately visible.
Wrappers return the original promises without gates, synthetic child creation,
ungrouping, explicit claim or input replay. They can affect scheduling and do not
establish atomic native-event/document binding. Exact background-window initial
tab and natural successor activations use the existing focus-accounting rules;
there is no window-focus allowance or restoration. Worker restart, cancellation
during unresolved adoption, other callers' lifecycle paths and ordinary popup
focus remain separate coverage requirements.

`OBU_TEST_CREATED_PAGES=ready` runs the public JavaScript `expectPage` workflow:
two concurrent owners, root/existing OOPIF/future OOPIF, one original Control-click
per source, the returned typed child and one business POST. A separate passive
native observer verifies its identity. Dynamic frames are inserted after the
ready ACK. It does not use `claimUserTab` or synthesize child tabs.

`OBU_TEST_CREATED_PAGES=five-entry` runs JS, Python, Go, CLI and MCP as five
independent owners across the same three layouts: 15 same-URL native children.
Each group waits for all five ready ACKs, then all five prepared source reads
and independent original native frame/OOPIF observations, before releasing the
original clicks. The original 20s workflow budget covers both gates, preparation,
collection and useful child submission. Cancellation and process closure have
separate bounded cleanup; they cannot replay the business action.

Build `scripts/browser-integration/go-created-page-checks/` and set
`OBU_TEST_GO_CREATED_PAGE_BINARY` to that matching executable. Set
`OBU_TEST_PYTHON` when the Python executable is not on PATH. The runner snapshots
the typed SDKs, callers and Go binary. Python/Go stdin contains only original
scope/source tab, fixture key/owner/variant and required `readyGate` and
`preparedGate` objects. Each gate uses fresh local `readyPath`, `releasePath`
and `token`; the four files must be distinct. Gate files are atomically published
without replacement. Callers never receive an expected child ID, URL or nonce.

`created-page-five-entry.json`, per-caller evidence and `created-page-server.json`
retain native source events, parsed Native RPC request/response JSON, original
HTML/POST bytes, stage budgets and actual child-process closure. The wire hook
is passive and bounded; its generation label is checked against the real host
PID/endpoint/generation separately. It is not raw transport-byte capture.
Source document observations surround the trigger; native child frame IDs are
observed after business completion. Neither is atomic event/document identity.

`created-page-five-entry.test.mjs`, `created-page-callers.test.mjs`,
`created-page-wire.test.mjs` and `test_created_page_callers.py` cover barrier
failure, malformed/expired acknowledgements, original deadlines, empty-state
readiness and cleanup. Their fake-browser IPC tests do not replace the browser
matrix. Unowned-child first admission and lifecycle negatives remain separate.

`OBU_TEST_CREATED_PAGES=popup-source` is a separate routing diagnostic. It uses
the existing raw-navigation prerequisite and `js-created-page-popup-source`.
An actual unfocused popup fixture is claimed through public `claimUserTab`;
root, existing OOPIF and newly inserted OOPIF sources then use the original
trusted Control-click and public `expectPage` result. No child is pre-created,
explicitly claimed, moved or substituted. The fixture requires one normal window
already focused, and binds the child to its actual native birth window.

`created-page-popup-source.json` and `created-page-server.json` retain source
and child documents, native creation/adoption/input acknowledgements, the original
20-second workflow budgets, business receipt bytes, foreign-owner denials and exact
cleanup. The unchanged ledger permits only the existing exact sole-tab popup
creation event, never window focus. Production `backgroundWindow:true` still
creates a normal window; this mode does not change that API. A successful route
is conditional evidence with the loopback Native Port adapter, not general
activation suppression, ordinary native popup behavior or another browser's
acceptance. This mode finalizes without a keep list and must preserve user-origin
pages while revoking authority before fixture cleanup. Explicit delivery is
covered by the separate mode below; the historical `wLjyi9` build rejected it.
Creation/claim/navigation are preparation; formal finalization uses its SDK
budget, and retirement checks have a separate 20-second budget. Run `wLjyi9`
passes 2/2, actual exit 0: three original business POSTs/589 bytes, three existing
popup-creation activation allowances, zero window focus, and 20 cleanup steps.
See the [verified scope](../../docs/references/created-page-waits.md#popup-source-routing-feasibility).

`OBU_TEST_CREATED_PAGES=popup-delivery` uses the same three original layouts and
adds public in-place delivery. Before installing the native-control observer it
creates one explicit agent work tab per task. Each task submits its original
child POST, then calls `finalizeTabs` with the source and child as deliverables.
The witness requires actual work-tab closure, original source/child positions
and documents, removed auxiliary authority/debugger attachments, acknowledged
native-storage delivery markers, and old/new/foreign scope denial. Exact fixture
closure must prune both memory and stored markers. The runner writes
`created-page-popup-delivery.json`; it does not add focus allowances or change
the ordinary suite's case names/order. The same conditional popup-source focus
and Native Port adapter limitations apply.

`OBU_TEST_CREATED_PAGES=provenance` remains a separate headed feasibility mode for
the [created-page readiness plan](../../docs/exec-plans/active/2026-10-12-created-page-waits.md).
It selects only the existing raw-navigation control and
`js-created-page-provenance`. Other opt-in modes and `OBU_TEST_CASES` must be
unset; invalid combinations fail before filesystem setup or browser launch.

```powershell
$env:OBU_TEST_HOST_BINARY = '<matching built host>'
$env:OBU_TEST_CREATED_PAGES = 'provenance'
node scripts/browser-integration/run.mjs
```

Two independent JS owners open the same child URL from root, existing OOPIF and
newly inserted OOPIF links using one original Control-click. A bounded passive
worker observer retains the original `onCreatedNavigationTarget` events. The
source tab/frame and returned child ID provide the relationship; URL, tab order
and wall-clock proximity are not used to select a child. Source document reads
before and after the action are recorded separately: the native creation event
does not contain a source document ID or prove action causality.

The test then uses the existing explicit `claimUserTab` and performs one useful
submission on each child. Original server HTML, document nonce and POST bytes
are preserved in `created-page-provenance.json` and `created-page-server.json`.
Native group inheritance is observed without ungrouping to manufacture a
pre-claim denial. This is not a product `expectPage`/arm/collect API acceptance.

The existing continuous focus ledger admits no new activation/focus allowances.
No synthetic child creation or focus restoration replaces native link behavior.
Test cleanup identifies exact child IDs, removes the precise passive listener,
and records `Browser.close` acknowledgement and actual process close in
`created-page-browser-close.json`. Only the isolated test profile is used;
normal `window.open`, other operating systems and more lifecycle cases remain
separate requirements. The public ready workflows above use separate modes.

## Original page download transport proof

`OBU_TEST_ORIGINAL_DOWNLOADS=product` exercises the production `bind-browser`
CLI and JS SDK paths with a newly built matching host. It binds only the test's
exact isolated Browser endpoint, waits for the CLI's actual exit, and verifies
18 original POST/Blob files, foreign GUID rejection, missing-file failure and
two held-transfer cancel/revocation cases. It does not create a second Browser
download observer. This mode is not the full regression suite.

For the five public entry points, build
`go build -o <go-caller> ./scripts/browser-integration/go-original-download-checks`,
set `OBU_TEST_GO_ORIGINAL_DOWNLOAD_BINARY=<go-caller>` and
`OBU_TEST_ORIGINAL_DOWNLOADS=five-entry`, and run the same runner with the matching
host. `OBU_TEST_PYTHON` optionally selects the Python executable. This separate
headed mode requests 30 original files: JS/CLI/MCP/Python/Go × root/OOPIF/dynamic
OOPIF × POST/Blob. Every group waits for all five original arm acknowledgements
before releasing any click. Typed callers exchange bounded ready/release files
in the isolated run directory; CLI/MCP use an awaited callback. The barrier
retains each original wait deadline, observes external-process failure and
checks readiness/release/trigger ordering in the recorded evidence. Each caller
then performs its own single click, collects
the GUID, requests the original path and reads its bytes. Parent-side JS creates
and navigates the fixture tabs, then independently verifies original file bytes,
Page source and ownership; it does not perform the other callers' download steps.
Typed Python/Go callers verify the original epoch before and after their SDK's
normal handshake. CLI/MCP pass the original scope explicitly.

`original-caller-*.json` preserves request/response or typed stages, file bytes,
errors, cleanup and actual child-process close. A timed-out child is terminated
and its close is observed before the caller returns; no trigger is replayed.
The test retains the original missing-file/foreign-GUID checks, both held-transfer
lifecycle cases and the mandatory raw-navigation control. It adds no focus
allowance and does not validate ordinary extension-only installation.
Foreign path/cancel rejection is checked by the parent JS owner clients;
held-transfer lifecycle cases also use JS. They are not independent negative
tests through all five entry points. The earlier `2O6wkV` run proved 30 original
files/5200 bytes, but its callers did not all arm before the first trigger, so
it is retained only as positive delivery evidence.

Final `Fb9uuB` passes 2/2, actual exit 0: 30 files/5200 bytes, all six groups
ready before release/trigger, with 14000 ms of zero activation/focus events and
no allowances. `EKpLO0` is an earlier passing checkpoint before the final
CLI/MCP action-budget correction. The final host's ordinary unbound suite
`U32iKd` passes 125/125 with its existing case order and focus allowances.
Final harness checks pass Node 673, Python 8 and Go 15 including subtests;
these process/unit tests do not replace the browser runs.

`OBU_TEST_ORIGINAL_DOWNLOADS=auto-connect` runs the same five-entry checks using
`bind-browser --auto-connect --browser chrome --user-data-dir <isolated-root>`.
No `--cdp-url` is supplied to the CLI; it must read the real browser-written
`DevToolsActivePort`. The exact Native Host endpoint and `--exclusive` remain
required. Binding uses a 60-second original budget and a 65-second external
process guard that observes actual close before returning. The raw CLI args,
stdout, stderr, exit and close are retained in `bindingProcess`.

This still uses the runner's isolated launch-flag Chromium and independent
observer. It tests production discovery, identity and file delivery, not
normal-start browser permission UI, default user-data discovery or Edge runtime.
The mandatory raw-navigation control, all-ready barrier, byte/source checks,
held-transfer cases and zero additional focus allowances are unchanged.
Final `h9Udpf` passes 2/2, actual exit 0, with 30 files/5200 bytes and 12853 ms
of zero activation/focus. `bindingCapabilities` preserves the actual before/after
`getInfo` responses. Earlier `YRvEbg` and manual-URL `ZwGUxs` pass but predate that
evidence capture. Browser-first teardown retains its original host shutdown
warning; it is outside focus coverage and does not prove the reset ACK.

Set `OBU_TEST_ORIGINAL_DOWNLOADS=default` or `allowAndName`, plus the usual
`OBU_TEST_HOST_BINARY` and optional `OBU_TEST_CHROMIUM_BINARY`, then run
`node scripts/browser-integration/run.mjs`. Do not combine this mode with other
test selection/diagnostic flags. It runs one native-download proof plus the
mandatory raw-navigation control in a fresh headed profile. It is not full
product acceptance and does not implement the public `downloadPath` fallback.

`original-download-proof.json` preserves actual Browser wire/ACK/close evidence,
Page events, three-owner notifications, one-use POST/Blob witnesses, 18 exact
native event paths and original file bytes. Cases cover root, OOPIF and dynamic
OOPIF with colliding URLs/filenames. Only the private profile's download settings
are changed; cleanup confirms the default/events-disabled ACK and socket close.
No file is selected through directory differences, URL/name matching or a new GET.
See [the verified scope and remaining work](../../docs/references/original-page-download-delivery.md).

For manual tool comparisons, run
`node scripts/browser-integration/original-download-server.mjs --output <new-directory>`.
The loopback-only server prints four fresh IAB/Edge POST/Blob cases. Use their
actual URLs and click once per case. Input `stop` on stdin saves the final HTTP
ledger and shuts down. Existing output directories are rejected. Unit checks:
`node --test scripts/browser-integration/original-download-fixture.test.mjs scripts/browser-integration/original-download-observer.test.mjs`.

## Original download isolation and connection loss

Set `OBU_TEST_ORIGINAL_DOWNLOADS=negative` with the existing built host and
Chromium prerequisites to run the JS negative lifecycle case and raw-navigation
control. This mode does not require the Go five-entry caller. It uses a fresh
isolated profile with debugging launch flags, not an existing user profile or
the ordinary browser authorization dialog.

Five original POST responses share one URL and filename. A separate CDP actor
clicks one exact harness-created, unowned background tab; its original Page GUID
must join the original Browser event, while both public clients reject path and
cancel and no private claim/native cancellation occurs. Another response ends
after its original 4096-byte prefix, retaining the browser's actual terminal
state without interpreting it as an intentional user cancellation.

A bounded, single-connection WebSocket relay captures complete original data
messages and their forwarding/close records. It cuts only the Browser download
connection after observing an actual in-flight private path request. The native
host, Native Port, SDK and ordinary page operation must remain healthy. Old
completed and pending handles must fail before and after a second explicit CLI
binding; only a newly armed original download may return a path. The replacement
binding uses a new relay and nonce/generation, never an automatic retry.

`original-download-negative.json` retains both binding subprocesses, capabilities,
private/Page/Browser observations, original HTTP and file bytes, ownership,
notifications and cleanup. `original-download-negative-server.json` records final
HTTP teardown. The independent unowned actor requires a real small screencast
frame and its ACK before its sole input sequence; it then stops capture and
disables renderer focus emulation without activating the tab/window.

This mode also captures `original-download-negative-netlog.json` and requires
Browser.close ACK plus actual process exit before parsing the complete JSON.
The final `js-original-download-network-provenance` gate checks five original
POSTs and the interrupted download's one rejected GET against exact NetLog
source IDs and the pinned Chromium Download Manager resume annotation. Renderer
Network events alone cannot attribute this no-renderer request. Unknown origin,
missing records, extra requests or replacement delivery fail; the original
failed runs remain preserved. The gate writes
`original-download-negative-network-provenance.json`. Existing continuous focus
checks gain no allowance. This is JS
negative acceptance with controlled transport loss, not five-entry negative
coverage, naturally occurring network loss or authorization UI acceptance.

## Transformed element bounds and screenshots

`OBU_TEST_CASES=bounding-geometry` selects the mandatory raw-navigation control
and `js-bounding-geometry`. Seven scenes cover root/same-renderer transforms,
scaled and rotated OOPIFs, nested local roots, child-document navigation, and
negative/offscreen/zero/hidden bounds. Eight screenshots are saved alongside
`bounding-geometry.json` and `bounding-geometry-server.json`.

Independent CSS corner and pixel witnesses establish expected root bounds;
production mapping functions are not the oracle. Checks bind the original
document/node to native target/session records, compare actual screenshot clips
and PNG bytes, decode pixels and verify exact task-tab/target cleanup. Native
`getTargets.type` need not equal the `attachedToTarget` type; exact target IDs,
URLs and iframe session records are joined instead. All scenes retain evidence
after a failure. No Input or activation/focus allowance is added, and the prior
120 cases keep their relative order. See
[bounds contract and failures](../../docs/references/transformed-element-bounds.md).

## Transformed element positions

`OBU_TEST_CASES=element-position` selects the mandatory raw-navigation control
and `js-element-position-geometry`. Eight fresh pages cover a scaled canvas,
rotated border-box, same-process frame, dynamic OOPIF, CSS zoom, finite
perspective, hover-time transform and first-click transform. Input comes from
the public SDK; original root Input calls/ACKs, original-document trusted events,
independent non-interactive CSS hotspot witnesses and original POST bytes are
saved in `element-position.json` and `element-position-server.json`.

The expected point is not derived with the production projection code. Native
root press/release coordinates and actual pointer delivery have separate checks:
the former must match the independent CSS projection; OOPIF event conversion
has an explicit physical-pixel quantization budget. The original hotspot, node,
click count and POST checks remain mandatory. The first strict OOPIF precision
failure is retained separately; see
[element-position geometry](../../docs/references/element-position-geometry.md).
The test adds no activation/focus allowance, closes all eight owned tabs/targets,
and retains all previous 119 cases in their original relative order.

## Direct locator uploads

Build `./scripts/browser-integration/go-direct-locator-upload-checks` with the
current Go SDK and set `OBU_TEST_GO_LOCATOR_UPLOAD_BINARY` to its executable.
`OBU_TEST_CASES=direct-locator` selects five ordinary entry-point cases and one
JS directory case, plus the mandatory raw-navigation control. The ordinary
cases each create fresh root, same-origin and dynamically inserted cross-process
fixtures, assign files to a hidden input, verify original file bytes and a unique
HTTP receipt, then clear that same input. Root cases reject ambiguous/non-file
locators and malformed paths without file mutation. The directory case uses the
public `backgroundWindow` API and the existing exact own-window activation ledger.

The bounded native observer preserves command arguments, receivers and original
promises. Typed Python/Go callers acknowledge observer setup after creating each
tab and before navigation; this preparation may affect scheduling and does not
extend any upload's original 10-second deadline. The parent performs observation
and independent assertions only. Clear must follow native write acknowledgement
and target the same original backend node. Synthetic clear events are distinguished
from trusted nonempty-upload events; no chooser or pointer input is expected.
Each caller's result, native evidence and server bytes are retained in
`direct-locator-*.json`, with original errors separate from cleanup failures.
The existing 112 cases retain their relative order.

## Screencast concurrency

The ordinary `js-screencast-concurrency` case uses two independent public SDK
connections in one task scope. An exact-tab test hook holds delivery of the first
actual native screenshot result while the second connection requests raw
`Page.stopScreencast` and `Page.startScreencast`. The original native screenshot
has already settled; its result, command arguments and frame events are not
replaced. Other native calls retain their original promises. The hook and source
file hashes are recorded in `sourceIdentity` and the hook is restored afterward.

A same-client public read barrier and a 300ms controlled overlap window keep
both requests observable before releasing the screenshot ACK. Neither request
receipt nor elapsed time proves queue admission or native execution. The case
independently requires actual internal-stop, external-stop and external-start
ordering, two real screenshot results, native frames with public acknowledgements,
and nonce/sequence pixels from the resulting PNGs. It changes the page through
public CDP to verify that the external stream continues after the second capture.
No activation or focus allowance is added. `screencast-concurrency.json` and four
PNG files retain the evidence, with original errors and cleanup failures separate.

This is controlled ACK timing acceptance, not a natural reproduction or performance
measurement. An older implementation whose requests do not reach native execution
inside the overlap window might not reproduce the race; deterministic production
unit regressions supply that negative evidence. The original 109 cases retain
their relative order. For a focused run select
`OBU_TEST_CASES=^js-screencast-concurrency$`; the mandatory raw-navigation control
is also included. On every exit the helper releases its gate, drains the original
public requests, stops/finalizes its own task, removes the listeners, and restores
the exact hook. Missing settlement, failed cleanup or incomplete native evidence
cannot count as a pass.

Use the Go version pinned by `go.mod` (currently 1.26.9) for the host and every
Go caller. Check `go version` before the build commands below; a previously
installed local toolchain may be older than the repository requirement.

## Chooser failure evidence

Default JS chooser-ready, single-submission and directory-upload failures retain a bounded
`failureObservation` before waiter cancellation when the operation fails. Default
Go failures add it after reading the original child partial result, after the
child has attempted cancellation and closed its connections, but before parent
finalization. Successful paths add no observation calls, listeners or wrappers;
the existing chooser HTML, actions and 10-second/5-second deadlines are unchanged.
The existing opt-in diagnostic collectors keep their own observation path.

This post-failure read has one separate 3-second budget. Native tab/frame metadata
must match the exact loopback fixture URL/key/variant before a fixed read-only
`chrome.scripting.executeScript` targets those native document IDs. It records
the page's existing click/change/frame-add evidence, document token, visibility,
and current geometry. Directory fixtures use their own exact routes and existing
`directoryEvidence`, including the input token and bounded native event summaries;
the observer does not read file bytes. No input, navigation, focus change, new attachment or retry
is sent. Errors and missing/replaced documents stay in the observation and cannot
turn the case into a pass or replace its original error. Document IDs prove only
continuity from the metadata read to the later DOM read; without an earlier token
they do not establish the click-time document, layout, hit-test surface or dialog
state. Evidence collection success is separate from browser operation success.
These JS (including the background-directory case) and Go/Python parent blocks attempt each existing finalization/close
once, then save the artifact with any `cleanupErrors`. Cleanup or persistence
errors still fail an otherwise successful case and cannot replace an earlier
business error; persistence failures are also retained in the run log.

The Go chooser caller now saves partial results on failure, including each
variant and round before its first operation. Arm, add-frame, click, collect,
file submission, receipt and cancellation have separate start/return/error
records. The original operation error survives cancellation, diagnostic and
connection-close failures. Both ordinary and diagnostic runs write the JSON
artifact before returning a nonzero exit code; the parent retains that artifact.
The original 10-second chooser, default Go click and 15-second transport limits
are unchanged. Build the entire `./scripts/browser-integration/go-chooser-waits-checks`
package, including its diagnostic support file, rather than `main.go` alone.

With the normal prerequisites and a freshly built `OBU_TEST_GO_CHOOSER_BINARY`,
set `OBU_TEST_GO_CHOOSER_DIAGNOSTIC=1` and run `node scripts/browser-integration/run.mjs`.
This exclusive mode selects the Go ready case and mandatory raw-navigation
control. It rejects other selection modes and the private child switch
`OBU_GO_CHOOSER_DIAGNOSTIC`. Unset the public flag for normal acceptance.

The parent and Go child exchange bounded JSONL acknowledgements: install the
exact-tab native recorder after Navigate and before arm; on the first business
failure capture native trace, tab/window/frame metadata and focus within one
3-second budget before remaining cleanup; restore after cancellation. An operation
failure is observed before Cancel, while a cancel-only failure is observed after
that failed cancellation. No new SDK scope,
attachment, click, task DOM read or focus allowance is introduced. The recorder
preserves native arguments, receiver and returned promises, but recording and
the pre-arm handshake can affect timing. A unique setup nonce guards late
installation and cleanup; missing identity, overflow, pending commands or
cleanup failure or missing/mismatched caller artifact remain incomplete evidence.
The parent waits for the child
process `close`, retaining actual exit and bounded stdout/stderr.

`chooser-go-caller.json` contains the original call phases and partial result.
`chooser-go.json` adds the child protocol, native records and original server
evidence. `go-chooser-diagnostic.json` and `results.json.goChooserDiagnostic`
report task success separately from collection completeness, with
`acceptancePassed: false`. Collection covers native commands and browser
metadata only; it does not prove click-time DOM state or explain a historical
failure merely because a later run passed. The default path installs no native
command probe and uses the original ordinary JSON stdout format.

## Chooser single-submission acceptance

The default `js-file-chooser-single-submission` case uses two independent JS
connections with the same control scope. On root, existing OOPIF and dynamically
created OOPIF inputs, both connections submit the same delivered chooser before
awaiting either response. Exactly one succeeds and the other must report a
consumed/unknown chooser. Both subsequently repeat the ID and must be rejected.
This runs for file selection and explicit clearing, retaining the original
10-second chooser and 5-second click limits. Original HTTP bodies, file bytes,
document tokens, trusted clicks, native change and programmatic clear counts
must show exactly one upload and one clear per layout. Read-only native target
and document observations are made through the original scope; no command probe
or scheduling gate is installed. Evidence is `chooser-submission.json`. It does
not test directory completion or replace the controlled late-ACK unit cases.

To run the new case alongside the existing five-entry chooser cases, set
`OBU_TEST_CASES='file-chooser|file-transfer'` using the normal prerequisites.
The mandatory raw-navigation control remains included. The additional case
changes the default count from 104 to 105; historical results below retain their
actual case counts and outcomes.

## Opt-in page download diagnostic

`OBU_TEST_DOWNLOAD_DIAGNOSTIC=1` selects only the original JS page-download
ready case and the mandatory raw-navigation control. It rejects all other
case-selection and diagnostic modes, including MCP binding and geometry DPR.
Build the normal host and SDK, then run the usual runner with this flag set;
unset it to return to the current 105 cases (the original 104 plus the chooser
single-submission case above).

The original HTML, single clicks and 10-second download/5-second click limits
remain unchanged. This mode records the original arm, add-frame, click, collect,
verify and cancel call phases, so an acknowledged click and a later download
timeout are distinguishable. A cancellation error is kept separately from the
original operation error in all modes. Default mode has no diagnostic command
probe, phase array or failure DOM reads.

The shared bounded native recorder observes commands for the exact fixture tab:
Input methods, Page enable/disable and Runtime resume, plus frame/target and
download events. It preserves the native receiver, arguments, Promise and
errors; side-chain recording can affect timing. On the first operation failure,
before cancellation, one total 3-second read-only pass captures window/focus
metadata and the root and uniquely observed child document through the original
control scope. It includes the fixture's click record, href, element geometry
and hit testing. A root native point is never projected into a child viewport;
a child center hit is explicitly a later observation. No extra click, wait for
readiness, debugger attachment, focus change or action replay is introduced.

`download-ready-js.json` stores the phase and diagnostic evidence alongside the
original download/server data. `download-diagnostic.json` and
`results.json.downloadDiagnostic` distinguish `originalTaskPassed` from
`collectionComplete`; `acceptancePassed` is always false. Missing cases,
truncation, unsettled commands, lost worker identity, failed reads or cleanup
errors cannot count as complete collection. A successful diagnostic does not
establish the cause of an earlier failure or replace the default regression.

Recorded `run-avWmSX` passed both selected cases with terminal exit 0. Independent
review matched 78 continuous native records, 29 commands and acknowledgements,
12 Input calls, three GUIDs and three actual files (12,297 bytes) to the original
server requests. The dynamic child's enable acknowledgements preceded its
download input. Its 3,784 ms focus observation had no events or allowances.
The earlier timeout did not recur; the failure-only DOM branch remains untested
against that actual fault, and `acceptancePassed` remains false.

The following default `run-Ve7nKv` retained terminal exit 1: 87 of the original
104 cases passed, 17 failed and the final focus ledger failed separately. All
five download callers and the download lifecycle case passed before the later
unexplained focus event. The user confirmed manual window activity at that
event's time; this is an externally disturbed run, not a clean focus comparison.
The failed records remain unchanged and do not establish their complete cause.

## Opt-in MCP connection binding acceptance

`OBU_TEST_MCP_BINDING=1` selects exactly the mandatory
`js-raw-navigation-before-engine` case and `mcp-connection-binding`. Build the
current host and JS SDK and satisfy the normal browser prerequisites below:

```powershell
$env:OBU_TEST_MCP_BINDING = '1'
node scripts/browser-integration/run.mjs
```

This mode rejects `OBU_TEST_CASES` and the chooser diagnostic, snapshot geometry
(including its DPR setting), background-parallel and memory-clipboard settings.
Unset the flag to restore the default 105-case selection. It adds no
focus exemption or production worker probe.

The first persistent MCP child discovers the isolated native host through
`--socket-dir`, without `--socket`, begins a turn, creates a task tab and performs
a real button click that generates a nonce-bound HTTP POST. The existing
`NativeHostBridge` then terminates that actual host process and waits for the
extension to reconnect to a new host PID and endpoint. The same old MCP process
must return `OBU_MCP_BROWSER_DISCONNECTED` for both its next browser action and
`begin_turn`; a scope error, process death or protocol error does not qualify.
A newly started MCP process explicitly begins a new scope and completes a
second real click/POST. The old process is checked again after that success.
Only two POSTs are allowed, so the original action cannot be silently replayed.
The fresh scope finalizes both created tabs, and independent native tab/target
queries confirm their removal before both MCP children close through stdin EOF.

`mcp-connection-binding.json` retains each child PID, original stdio request and
response lines, stdout/stderr, captured scopes, host restart identities, error
envelopes and tab-removal observations. `mcp-binding-server.json` stores actual
GET identities and raw POST bytes/hashes. `results.json.mcpBinding` reports this
separate acceptance result, alongside the original continuous focus ledger and
host generations. Stdout/stderr, request counts and fixture bodies have finite
limits; incomplete evidence or child cleanup fails the case. The suite retains
the existing loopback WebSocket adapter for the extension native port, so this
does not establish OS native-messaging launcher or separate browser-instance
selector coverage. The independent Go transport tests cover live A/B selection
with deliberately equal tab IDs and epochs.

Recorded Windows Chromium 156 run `run-ykbo3D` passed both cases with terminal
exit 0. Independent review verified the original MCP stdin/stdout, two POSTs,
three disconnected-tool errors from the same old process, explicit fresh scope,
tab/target cleanup and both MCP exit codes. Its continuous 5,999 ms focus ledger
had no events or allowances. The following default `run-k5giEj` exited 1 with
103/104 cases passing: the JS dynamic-OOPIF page-download wait reached its
original deadline without a file request or download event. Other download
callers and all MCP research tasks passed. Preserve that failure; the targeted
binding result does not make the default regression successful.

## Ordinary chooser failure records

CLI/MCP and Python callers retain partial variants and rounds even when a
request fails. Local stage timestamps distinguish arming, adding the iframe,
click submission and acknowledgement, collecting, setting files and cancellation.
Cleanup errors remain separate from the first business error. Python writes the
same partial JSON to stdout and its exclusive result file before exiting 1.
These annotations retain the original successful browser requests, parameters,
order and deadlines; no readiness request or input retry is added.

The parent records child process `close`, separately from `exit` and a requested
kill. Its CLI/MCP/Python/ordinary Go failure observation runs only after confirmed
close and before task finalization. Before any browser read, it checks the exact
caller/session, ordered root/static/dynamic prefix, unique original tab IDs and
one terminal failed variant. Missing or mismatched artifacts, unknown close and
connection-close-only failures after successful variants are incomplete evidence
and cause no read. It then uses the existing exact current document-ID checks and
one 3-second budget. This is post-failure state, not proof of the click-time
document or native pointer delivery; successful cases do not read failure DOM.

## Opt-in chooser ready diagnostic

`OBU_TEST_CHOOSER_DIAGNOSTIC=pointer-all-context` keeps the same fixed 13-case
context listed below. It records passive pointer/mouse events for submission,
JS ready, CLI, MCP, Python and Go on exactly their 18 chooser keys, plus the three
fresh keys registered by the positive background-window directory checker.
Default HTML and earlier diagnostic HTML remain unchanged. The new chooser
ledger is non-enumerable so the existing submission success reads do not return
it; the fixed failure reader accesses it explicitly. No successful browser call,
input retry, command wrapper or timeout extension is added.

The aggregate reads seven case artifacts and reports coverage per case.
Directory-world, inactive-directory, mixed-finalize, lifecycle, public-concurrent
and raw-navigation retain their original behavior and are explicitly
`uninstrumented`; their failure cannot count as complete pointer evidence.
Successful covered cases have `collectionComplete: null` because no failure
read occurred. A failed case requires exact original tab/key/variant and complete
current document evidence; external callers additionally require actual process
close. A complete observation never turns the original failure into a pass.
The aggregate always has `acceptancePassed: false`, and missing/invalid artifacts,
selection changes or incomplete failed-case evidence keep the process failing.
Fixture listeners can affect scheduling; these are post-failure observations,
not proof of native input dispatch or click-time document identity.

Recorded run `OBaCi6` retained 12/13 original tasks and exited 1. Python's first
dynamic-OOPIF upload click returned after 97 ms, then collect timed out after
9,772 ms. After cancellation and confirmed child-process close, the 7 ms bounded
observation found a complete 14-event root ledger: the Add button's sequence,
followed by move/down/up/click targeting the parent `IFRAME#upload-frame`.
The current child document had a complete empty pointer ledger and no click,
change or uploaded files. Native document IDs bind this later read, not the
click-time document; no native-command correlation or router cause is inferred.
Collection is complete while business and acceptance remain false. All 18
existing successful submission CDP reads omitted the non-enumerable ledger.
The following ordinary `XXyxbu` run passed 13/13 with diagnostic mode disabled;
it does not cancel this failure or establish a production input fix.

`OBU_TEST_CHOOSER_DIAGNOSTIC=1` runs only the existing
`js-file-chooser-ready-two-connections` and mandatory
`js-raw-navigation-before-engine` cases. It is exclusive with `OBU_TEST_CASES`,
geometry, background-parallel and memory-clipboard settings. Build the normal
host and JS SDK first, then run with the usual `OBU_TEST_HOST_BINARY` and browser
prerequisites below:

```powershell
$env:OBU_TEST_CHOOSER_DIAGNOSTIC = '1'
node scripts/browser-integration/run.mjs
```

For fixture-only event recording, set the same variable to `pointer-only`.
It selects the same two cases and the same opt-in pointer HTML, but does not
install the extra native-command wrapper or run its pre-arm handshake. The
ordinary case's existing passive native event trace remains. On failure it uses
the default exact-document-ID observation, within its one separate 3-second
budget, to read the bounded pointer ledger; it adds no success-path reads or
input retries. This still changes fixture HTML and may affect timing.
Its result mode is `chooser-pointer-only-diagnostic`, with
`nativeCommandProbeInstalled: false` and `acceptancePassed: false`.
A successful task that needed no failure read has `collectionComplete: null`,
meaning unverified pointer evidence. Missing or incomplete evidence after a
failed task is `false`; complete failure evidence is `true` while the original
task remains failed. Neither mode changes the normal suite's HTML.

Set `OBU_TEST_CHOOSER_DIAGNOSTIC=pointer-context` to retain the original
`run-JwX2Bc` context, in this fixed order:

```text
js-file-chooser-directory-world-reconnect
js-file-chooser-directory-inactive-rejection
js-file-chooser-directory-background-window
js-background-window-mixed-finalize
js-file-chooser-single-submission
js-file-chooser-ready-two-connections
js-file-chooser-ready-lifecycle
cli-file-chooser-ready-two-connections
mcp-file-chooser-ready-two-connections
python-file-chooser-ready-two-connections
go-file-chooser-ready-two-connections
js-file-chooser-public-concurrent
js-raw-navigation-before-engine
```

This selection needs the usual Python and built Go chooser caller prerequisites,
including `OBU_TEST_GO_CHOOSER_BINARY`. Do not set `OBU_TEST_CASES`.
Only `js-chooser-root`, `js-chooser-oopif` and `js-chooser-dynamic-oopif` fixture
keys receive pointer HTML; all other fixture pages retain their default bytes.
Only JS ready reads that ledger after failure. Lifecycle and the other callers
receive no additional probe, handshake or pre-arm read. Original actions,
timeouts, cleanup and focus checks remain in force. The recorder still changes
the three target pages and may affect timing, so this is diagnostic evidence,
not ordinary acceptance or an explanation of the earlier failure.

The summary mode is `chooser-pointer-context-diagnostic`, always with
`acceptancePassed: false`. `caseSelectionComplete` requires all 13 exact names
in order; missing, extra or reordered records force exit failure.
`originalTaskPassed` describes JS ready, while `allOriginalTasksPassed` covers
the whole selection. Any case failure still exits 1 even when pointer evidence
is complete. The existing `null`/`false`/`true` collection meanings apply: a
successful target has no pointer read, missing or incomplete failure evidence
is false, and complete failure evidence never turns its task into a success.
The old `1` and `pointer-only` modes continue to select only their two cases.

`OBU_TEST_CHOOSER_DIAGNOSTIC=pointer-go-context` keeps the same fixed 13-case
selection, but records pointer HTML only for `go-chooser-root`,
`go-chooser-oopif` and `go-chooser-dynamic-oopif`. All JS and other caller pages
keep their default HTML. Go's arguments, environment construction, actions,
waiter cancellation and connection close are unchanged; no native diagnostic
hook or JSONL handshake is enabled. Success adds no API or pointer read.
After an original Go process failure, the parent uses its existing exact
document-ID observer with the same 3-second budget, after Go cancellation and
connection close but before parent finalization. This observes the later
document and can itself be incomplete; it cannot prove click-time state.

Its summary mode is `chooser-pointer-go-context-diagnostic`, with evidence in
`chooser-go.json` and `originalTaskPassed` referring to Go. Successful artifacts
have top-level variants; failed artifacts retain the original `callerResult`
and the parent's separate `failureObservation`. Summary code creates a
read-only view only when that observation's tab ID, key and variant match the
unique failed Go variant. It does not rewrite either artifact. Missing,
unreadable, mismatched or incomplete evidence cannot report complete; a
successful Go target without a read remains `null`. Selection integrity,
`allOriginalTasksPassed`, exit failure for any original case failure and
`acceptancePassed: false` retain the context-mode meanings above. Existing
`1`, `pointer-only` and JS `pointer-context` behavior is unchanged.

The two-connection actions, 10-second waiter deadline, upload bytes and
historical-event rejection remain unchanged. The default root/static-OOPIF/
dynamic-OOPIF HTML remains byte-identical and does not install this probe.
Only the opt-in fixture HTML records bounded passive capture listeners for
pointer and mouse events in each root/child document. The records retain actual
event types, trust flags, targets, original-node identity, client coordinates,
buttons, document token and timestamps; they neither synthesize input nor
prevent event delivery. They are read only by the existing failure observation,
with no additional success-path DOM calls or upload fields. Recording can affect
timing, and timestamps from different documents/native processes do not prove
a strict causal order. Empty event logs are valid evidence; missing, overflowed
or erroneous logs cannot be called complete. A successful diagnostic does not
claim that its unread pointer logs were inspected.
The `chooserEvidence.pointerEvidence` ledger caps each document at 256 records
and 65,536 serialized characters, with individual strings capped at 128
characters. Truncation is explicitly incomplete. Each diagnostic retains
`pointerEvidenceExpected`, `pointerObservationRequested` and
`pointerObservationComplete`; the last remains `null` on success without a read.
In native-command mode (`1`), only the selected tab's original `Input.*`, chooser interception, `Page.enable`,
`Page.disable` and `Runtime.runIfWaitingForDebugger` calls are observed, along
with the seven existing frame/target/chooser event methods. Commands and events
share a worker sequence and worker identity; the 1,024-record/1-Mi-character
trace marks dropped/truncated payloads and pending or unobservable settlements
as incomplete. The wrapper preserves the receiver, arguments, returned Promise
and thrown/rejected values. Serialization and Promise side chains can affect
scheduling and rejection reporting, so this is not a timing-neutral control.

In native-command mode (`1`), on the first original failure in a variant, before its original cancellation
and finalization, a single diagnostic pass records the native windows, current
window, exact tab, frames and the continuous focus ledger. It then attempts
one read-only `Runtime.evaluate` per root and uniquely observed child session,
through public `executeCdp` with the original session/turn/epoch. This has a
separate total 3-second budget covering the trace, native metadata, focus and
DOM reads, with deadline checks before delayed worker APIs and injected DOM
reads execute. It does not revive the expired waiter,
attach a debugger, replay input, dismiss a dialog or change focus. Rejection
under revoked scope is retained. These reads delay cleanup and observe the
later DOM, not the click-time state. Root hit testing uses the recorded native
press point; a child center hit is only a labeled current-state observation,
never a guessed projection of root coordinates. Window metadata alone cannot
identify an OS file dialog or attribute focus changes to a person.

`chooser-js.json` retains the original task error, server bytes, passive trace
and each variant's additional `diagnostic` evidence, including failed reads and
cleanup errors. `chooser-diagnostic.json` and `results.json.chooserDiagnostic`
separate `originalTaskPassed` from `collectionComplete` (both a complete native
trace and, on failure, the required DOM/metadata observations); each variant
also retains `traceComplete` and `observationComplete`. `acceptancePassed`
is always false. Exit failure preserves any original test failure or incomplete
trace. Even a successful diagnostic is not a new acceptance run. Existing
continuous focus checks receive no new exemptions.

With this pointer recorder, `run-Cq7i08` completed **2/2, exit 0**. All three
chooser variants had complete native traces but no failure read; pointer
observation remained unrequested and unverified. It did not reproduce or explain
the preceding ordinary `run-JwX2Bc` failures, whose three post-failure document
reads found no child click. The recorder and late-execution deadline guards
passed the 1,380-test Node suite; this is no production input fix.

The reduced `pointer-only` run `run-S5wSpZ` passed **2/2, exit 0**, with six
real POSTs and 97 file-content bytes checked. It made no failure read, so pointer
evidence remained unrequested and unverified. That slice passed 1,388 Node tests.
The subsequent `pointer-context` slice passed 1,391 Node tests and 57 independent
focused checks, preserving all 12 default/previous-opt-in HTML byte comparisons.
Three bounded runs on the same frozen source were `run-yLC7OT` **13/13, exit 0**,
`run-NuEbdZ` **12/13, exit 1**, and `run-HakXg4` **13/13, exit 0**. In the middle
run, Go's first dynamic-OOPIF collect timed out after the click returned, without
a chooser result or setter. Its existing six-millisecond post-failure observation
found a trusted root frame-add but no child click/change; Go's fixture did not
contain the pointer recorder. JS ready passed all three runs without a pointer
read. The middle run correctly retained `allOriginalTasksPassed: false` and
terminal exit 1, while target pointer collection stayed `null`. These diagnostics
neither explain the input loss nor replace the ordinary regression failures.
Independent review matched 114 current source hashes in each run and across
the three runs. Each retained only the five existing background-window fixture
activation allowances, zero window-focus events and exact task-tab cleanup.
Each directory case verified 13 POSTs, 30 file payloads and 408 actual bytes.
The failed Go case had only its earlier root/static-OOPIF four POSTs and 62 file
bytes; its dynamic variant produced no POST. Host exit 0 is recorded separately
from the middle parent runner's genuine exit 1.

Recorded diagnostic `run-Yh4Yz7` completed with terminal exit 0 and both original
cases passing. Independent review checked 69 acknowledged native commands,
six chooser events and six actual upload/clear POSTs, with no foreground event
in the 2,691 ms observation interval. The dynamic child's interception ACK
preceded its upload click. The earlier `run-7YcNf9` timeout was not reproduced;
there was no production fix, and the failure-only DOM branch was not exercised
in that real run. The diagnostic remains `acceptancePassed: false`.

The following default run, `run-ZzBRWH`, cleared the diagnostic flag and passed
the unchanged 104-case set with terminal exit 0 and independent artifact review.
Its worker and results contained no diagnostic probe. The continuous 194,500 ms
focus record retained the original six auxiliary-window activations and four
explicit settings-popup focus events, with no added background allowance.
This successful regression preserves the earlier failure and does not establish
its cause. Startup and teardown remain outside the focus observation interval.

## Opt-in snapshot geometry acceptance

The default suite contains 105 cases. `OBU_TEST_SNAPSHOT_GEOMETRY=1` selects a
separate ten-case run: five geometry callers (JS, Python, Go, CLI and MCP),
geometry limits/expiry/deadline, the three existing AI snapshot lifecycle,
native-reference and cancellation cases, and the mandatory raw-navigation case.
Do not set `OBU_TEST_CASES` for this complete selection. This mode cannot be
combined with background-parallel or memory-clipboard modes.
`OBU_TEST_GEOMETRY_DPR` is mandatory in this mode and accepts exactly `1`, `1.5`
or `2`; outside this mode it is rejected. Each value starts a separate browser
with `--force-device-scale-factor`. Run the three instances sequentially for
complete scale coverage; no dynamic device-metrics override is used.

After building the host and satisfying the normal runner prerequisites below,
build the additional public Go SDK caller with the pinned toolchain:

```powershell
go build -o .tmp/go-snapshot-geometry-checks.exe ./scripts/browser-integration/go-snapshot-geometry-checks
$env:OBU_TEST_GO_GEOMETRY_BINARY = (Resolve-Path .tmp/go-snapshot-geometry-checks.exe).Path
$env:OBU_TEST_SNAPSHOT_GEOMETRY = '1'
Remove-Item Env:OBU_TEST_CASES -ErrorAction SilentlyContinue
foreach ($geometryScale in @('1', '1.5', '2')) {
    $env:OBU_TEST_GEOMETRY_DPR = $geometryScale
    node scripts/browser-integration/run.mjs
    if ($LASTEXITCODE -ne 0) { throw "Geometry acceptance failed at DPR $geometryScale" }
}
```

Every caller creates and finalizes its own task through its selected entrypoint.
The five-document fixture contains root and open-shadow controls, same-origin
and real cross-origin frames, and a nested cross-origin boundary. Each browser's
three phases cover initial layout, root/child scrolling, then scaled and rotated
iframe owners, all at the fixed startup DPR. Root scrolling is 36/160 CSS pixels
and child scrolling is 12/72, avoiding device-pixel rounding at these scales.
No particular viewport dimensions are assumed. Snapshot capture preserves the before/after
document identities, scroll values and DOM rectangles. An independent DOM oracle
reads each document's `getBoundingClientRect()` and viewport through bounded,
nonce-bound parent/child messages. It does not use locator `boundingBox()` or
convert child coordinates to root coordinates.

`boxes:true` observations must retain every native reference, one structured box
per reference, matching inline coordinates, and a parent-first frame tree. The
oracle uses a separate 1e-6 CSS-unit tolerance and saves the actual maximum
deviation. The root's labeled, fixed color marker is also a native snapshot ref:
its returned box determines all sixteen exact PNG pixel samples. Each phase
saves the original PNG, nonce and phase code. Pixel rounding follows the observed
DPR; child boxes are checked in their own frame viewport and do not claim a
global screenshot projection under parent transforms. Default and explicit
`boxes:false` retain the old five-field result. The JS caller additionally reads
root/same/cross/nested-child elements using refs from a geometry capture.

Artifacts include `snapshot-geometry-<entry>-caller.json` (original public calls
and responses), `snapshot-geometry-<entry>.json` (independent comparisons and
tab-removal evidence), fifteen PNGs per run (45 across the three scales),
`snapshot-geometry-server.json` (actual GET
identities), and the limits record. The runner requires observed OOPIF targets,
finalized task-tab removal, and the unchanged continuous focus ledger without
new activation allowances. This finite fixture verifies frame-local geometry
under static layouts, not cross-frame atomicity, arbitrary dynamic layouts,
or parent-transform projection. See the
[snapshot geometry contract](../../docs/references/snapshot-geometry.md).

## Real Windows native launcher lifecycle

`native-lifecycle.mjs` tests the browser's actual `connectNative` launcher with
an isolated profile and a unique temporary native-host registration. Its default
`acceptance` mode covers host termination with held input and a pending action,
native Port EOF during an actual extension reload, and reload while globally
paused. The normal adapter suite below remains a separate regression requirement.

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

The default acceptance and idle modes change only the staged worker's unique
native-host constant, public unpacked key and passive lifecycle listener.
The created-page mode additionally exposes a staged backend reference for
bounded original adoption/cleanup observation; production sources do not gain
that reference. `connectNative` itself is unchanged in every mode. The independent
companion observer survives extension reload and retains every activation/focus
event. The original acceptance cases permit only exact explicit Pause/Resume
popup focus allowances. The created-page mode adds no window-focus allowance;
its source creation has the existing exact sole-tab activation allowance.
Setup and final browser teardown are outside the measured interval; created-page
fixture cleanup remains inside it.

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

### Created-page host loss mode

Keep the same matching host/browser prerequisites above and select this separate
one-case mode; the default three acceptance cases remain unchanged:

```powershell
$env:OBU_TEST_NATIVE_MODE = 'created-page-host-loss'
node scripts/browser-integration/native-lifecycle.mjs
```

The runner creates one public background-window source and opens its original
natural Control-click child. It observes the actual first unowned admission and
matched, undelivered waiter, then kills only the identity-checked private native
host. The worker stays alive. Passive wrappers retain original call arguments,
Promise outcomes, exact claim identity and cleanup, without manufacturing a
child, returning replacement promises, replaying input or restoring focus.
The original 20-second deadline is not reset. Cleanup must be observed while
that deadline remains live, before waiting for the replacement endpoint and
opening a fresh SDK connection; this is not a claim that cleanup precedes the
transport's independent automatic reconnect.

The old SDK/epoch must reject; fresh explicit control must retain a usable source
and deny the cancelled child. Native frame/document IDs and both pages' original
window/group/pinned identities are checked again after recovery and source
re-arm/cancel. No child DOM read, attachment or input is performed. The server
must retain exactly one child and no business POST. Fixture tabs are removed
only after these observations, with exact ID/URL checks and absence verification.

This mode keeps the existing isolated profile, full extension inventories,
random ownership-fenced HKCU registration and exact process teardown rules. The
HTTP fixture binds loopback directly in the dynamic/private port range through
`listenFixture`; browser port restrictions are not disabled. Its only additional
staging exception is the backend reference described above. Evidence goes to
`native-created-page-loss-detail.json`, `native-created-page-host-loss.json`,
`created-page-server.json` and `results.json` in the unique native-lifecycle run
directory.

Run `native-lifecycle-9QWc6h` verifies this normal-cleanup lifecycle sub-check with
18,558 ms remaining at the original cleanup acknowledgement, but **exits 1**:
one business focus event and cleanup's two focus events/one successor activation
fail the unchanged global gate. Only source creation's original activation is
allowed. The 82 native calls include 76 fulfilled and six rejected outcomes;
all eleven cleanup entries and process/registration teardown complete. The forced
old-host descriptor remains in the private artifact directory. Do not interpret
`lifecycleVerified:true` as overall acceptance or as real-browser validation of
the separately unit-tested failed-cleanup retry fix. See
[native host-loss evidence](../../docs/references/created-page-waits.md#created-page-native-host-loss).

### Created-page cleanup fault mode

With the same Windows native-launcher prerequisites, run one explicitly selected
scenario per isolated browser. Both selectors are required; they are rejected
in other modes before a profile or registry entry is created:

```powershell
$env:OBU_TEST_NATIVE_MODE = 'created-page-cleanup'
$env:OBU_TEST_NATIVE_CHANGE = 'source-navigation' # or 'child-close'
$env:OBU_TEST_NATIVE_RECOVERY = 'session-bootstrap' # or 'retry-pause'
node scripts/browser-integration/native-lifecycle.mjs
```

The original natural Control-click child remains matched and undelivered. A
private worker wrapper targets only deletion of its exact auxiliary claim via
`chrome.storage.session.set`, appends an over-quota test value and returns the
original native Promise. Chrome must reject the write and leave both the old
claim and absence of the test key observable. This is deliberate argument fault
injection, not a spontaneous storage or disk failure. Other writes remain intact.

After real source navigation or child closure, public turnEnded/Pause must fail
and repeated explicit recovery must remain fenced while the fault is enabled.
Disabling it then permits SDK beginTurn or the original real popup's Retry pause
and Resume control buttons. Popup clicks use its DOM event handler, not the OS
mouse or a hardware-trust claim. Host/worker identity, original waiter deadline,
original page documents/positions, stale-scope denial, fresh-source usability,
zero input/adoption replay and exact cleanup are checked. Child closure must
stay closed; navigation must retain the original child document.

The diagnostic popup opens in the one already-focused exact private source or
sentinel window, without changing focus. Original popup context/document,
button state and the remaining original recovery deadline are checked in the
same evaluation before each DOM click; replacement or delayed lookup rejects.
An earlier native focus failure may be retained while gathering recovery
evidence; it still fails the final acceptance gate.

`native-created-page-cleanup-detail.json`, `cleanup-popup.json` (when used),
`created-page-server.json` and `results.json` retain the evidence. The unchanged
focus gate determines overall acceptance; `recoveryVerified:true` alone cannot
make a run pass. No focus restoration or additional business-event allowance is
introduced, and original failures remain in the continuous observer.

The four recorded combinations `CxXan4`, `jEHwoF`, `DxTviV` and `itXMS9` each
verify recovery with three native quota rejections and one successful deletion,
but all retain **actual exit 1** due to strict focus/activation failures. Initial
failed attempts remain preserved. See [native quota recovery evidence](../../docs/references/created-page-waits.md#native-quota-failure-recovery)
for identities, deadlines, cleanup, test scope and remaining requirements.

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

`OBU_TEST_VIVALDI_DOM_FOCUS=1` selects a separate actual-Vivaldi experiment,
exclusive with every other explicit native diagnostic/ownership flag. It uses
the unchanged INPUT fixture, passive observer and manager/observer readiness
setup, but does **not** enable the extra TASK_READY gate. After the original
goto, one public SDK/CDP chain reads the document, queries `#note`, verifies its
node description, then calls `DOM.focus` once. All four calls share one 5-second
absolute budget; failure or a late result stops the chain. The original single
fill and Submit follow only on completion. There is no extra pointer/key action,
activation, value assignment, blur, fallback or replay. DOM.focus can cause
ordinary page focus and scrolling; its ACK does not prove input delivery.

The separate `domFocusDiagnostic.before` record uses the same passive document
observation as the existing task. The original three INPUT snapshots remain
`before-fill`, `after-fill`, `final`; no observer or fixture event set changes.
`domFocusDiagnostic` is also saved under `input-diagnostic.json`'s `domFocus`.
Native command identities, params, outcomes and ordering are checked separately
from original-node continuity, initially empty/unfocused preconditions and real
trusted input/POST results. An already focused input is not blurred to manufacture
that precondition. CDP node IDs and observer WeakMap node IDs are separate
namespaces. Object member ordering is not semantic identity. Native command
ordering uses the same worker's sequence numbers; local await order and total
deadline are checked independently. Cross-process timestamps remain observations,
with no assumed clock equality or added tolerance.
`mode: "vivaldi-dom-focus-diagnostic"` always has `passed: false`;
complete collection and an observed experiment do not mean the task passed.

`OBU_TEST_VIVALDI_HOVER_FOCUS=1` selects an exclusive actual-Vivaldi experiment.
After the original goto, it calls the original input locator's public `hover()`
once, then keeps the original single fill, Submit and their existing deadlines.
It enables INPUT diagnostics and setup readiness, but no TASK_READY, DOM.focus,
force override, extra click/key, activation or fallback. A single public hover
may send more than one native command through engine actionability handling;
all actual calls are retained, and an unexpected sequence is not counted as the
selected single-move experiment.

The fixture HTML and INPUT passive event set stay unchanged. A separate
`hoverFocusDiagnostic.before` records `before-hover`; `after` refers to the
original `before-fill` observation. Only this mode additionally reads the input's
`:hover` state and bounding rectangle. Those values describe observed behavior,
not collection or experiment success conditions. Original document/node continuity,
native target/parameters/ACKs and same-worker sequence establish the experiment;
trusted input events and the actual POST establish the task result. The observer
does not capture hover DOM events or prove the browser's internal widget routing.

`hoverFocusDiagnostic` is also stored under `input-diagnostic.json`'s `hoverFocus`.
`mode: "vivaldi-hover-focus-diagnostic"` always has `passed: false`. Even a
successful explicit hover→fill workflow does not authorize silently adding hover
to production fill: hover can scroll and trigger CSS or page event handlers.

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
  opt-in case is excluded from the default 105-case suite; no shorter wait counts
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

The suite currently contains 105 cases with all Go helper binaries, including
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

## Directory upload completion

The default suite includes directory completion and background-window ownership
cases. After setting the usual host/browser prerequisites, select them with:

```powershell
$env:OBU_TEST_CASES = 'directory|background-window'
node scripts/browser-integration/run.mjs
```

`js-file-chooser-directory-background-window` uses the public JS client through
two connections with the same control scope, and creates each task page using
`browser.newTab({backgroundWindow:true})`. Root, existing OOPIF and dynamically added OOPIF inputs select a
real directory tree twice, then an empty directory twice. The tree includes
Chinese names, two identical basenames in different subdirectories, binary data,
a zero-byte file and an empty subdirectory. Root also checks clear and explicitly
rejects a missing directory, a regular file passed as a directory, and multiple
directory paths. Missing capability support fails the case rather than skipping it.

`js-file-chooser-directory-inactive-rejection` retains the ordinary inactive-tab
route as an explicit negative case on the fixed Chromium build. It requires a
native trusted cancel, a rejected setter and no successful input/change or file
POST, both on return and after finalization. This records the native limitation;
it does not rewrite the earlier failing positive run as a successful upload.

`js-file-chooser-directory-world-reconnect` checks the original isolated-world
guard across a real detach/attach. Its test admission has not sent any file
mutation; it proves guard persistence, not interrupted directory completion or
worker-restart recovery.

A page capture listener, registered before the agent's listener, synchronously
POSTs short FileList metadata on `input`, `change` and `cancel`. Its server replies
immediately without waiting for the SDK. The setter's first resolution
continuation snapshots that server memory, before polling or another browser
request: each successful directory round must already have one trusted input
witness for the exact original node/document. Later asynchronous POSTs contain
the actual File bytes; the checker validates hashes and all relative paths.
Explicit clear has programmatic events, and cancel alone never proves selection.

`directory-upload.json` and `directory-inactive.json` retain per-stage evidence;
`directory-upload-server.json` retains original request bodies and receipts
associated by exact fixture key. Public window creation is checked against
before/after native inventories. Only that exact new window's sole-tab activation
is recorded as a creation allowance; window focus has no new allowance and the
original sentinel remains selected. Finalize must remove each agent tab and its
now-empty window. No native completion events are simulated.

`js-background-window-mixed-finalize` verifies that a grouped tab created before
and another created after the background window retain their original group and
session ownership. A later unclaimed test page in the background window survives
finalization of all three agent pages. Its natural selection after the active
agent page closes is recorded separately by exact tab/window IDs and the finalize
interval; it is not a creation or window-focus exemption. The fixture then closes
only its own extra tab and verifies final native inventory. Evidence is in
`background-window-mixed.json`. These cases cover the tested Chromium build,
not all browsers or filesystems, and do not establish Codex-wide parity.

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

## Transformed iframe pointer actions

The default suite includes `js-pointer-transformed-frames`; use
`OBU_TEST_CASES=pointer-transformed` with the same runner prerequisites for a
focused run. Seven fresh pages exercise same-process scale, rotated OOPIF,
nested mixed frames, synchronous hover cover, hover translation, first-click
cover during a counted action, and a rotated 12×12 target with explicit position.

The existing transparent native input probe records original sends and actual
settlements without suppressing, fabricating or replaying input. Page ledgers
retain trusted target and ancestor events, exact native document identities,
visible counters, original business POST bytes and synchronous mutation receipts.
The existing continuous focus ledger grants no new allowance. Runner finalization
checks disappearance of every task tab and its fixture debugger targets.

`pointer-transformed-frames.json` and `pointer-transformed-server.json` preserve
every attempted scenario, including partial failures. The helper's optional
`caseNames` is diagnostic only and marks `fullCoverage:false`; the default runner
always requests all seven. Original six-page variants remain byte-for-byte
comparable to the old-production baseline. These cases do not establish general
3D/pinch-zoom support or production native-launcher behavior; see
[transformed iframe input](../../docs/references/transformed-frame-input.md).

## Drag delivery and commitment

The default suite includes `js-drag-commit` after the existing extended-input
case. Select `OBU_TEST_CASES=drag-commit` with the same runner prerequisites for
the ten-scene focused run. Each scene calls public SDK `dragTo` once, without
caller preparation input, activated task tabs or new focus allowances.

The controls exercise root HTML drag, transformed OOPIF HTML drag and pointer
capture. Dynamic scenes move the source during its first trusted hover, replace
the destination during source down, cover it during dragenter, or cover it during
the second dragover emitted inside native drop. Three additional root scenes
use explicit source/target positions and an independent 12×12 padding-local
hotspot. Individual 180-degree rotation and changed left/top borders in the
second dragover must not commit the old point, even if the target node and its
border AABB stay the same. A browser-rendered zero-size marker and authored plane
arithmetic independently establish the requested point; actual positive root
drop and native requested coordinates must agree within .025 CSS px per axis.
This tolerance is not a statement about OOPIF event quantization. The original
seven scene HTML documents remain byte-identical. Source and destination are in
the same document in these scenes; this is not a cross-document drag benchmark.

`drag-commit.json` and `drag-commit-server.json` retain original frame/document
identities, native invocation/ACK records, guard installation/cancel/release
identities, trusted DOM event ledgers and exact POST bytes. The first passive
window observer may see an event that a later production guard stops before the
business handler. Preserve both observations: seeing a captured drop alone does
not prove application submission. The frozen `64a45eb` implementation does not reach the
second-dragover mutation; that missing premise is not an old misdelivery proof.

Every scene is attempted even after an earlier failure. Pending native input
prevents task DOM inspection, and finalization checks exact task tab and fixture
target removal. Evidence covers the current process and these scenes; it does
not establish worker-loss recovery or atomic layout/input. See
[drag delivery](../../docs/references/drag-delivery.md) for the retained failures
and the implementation's completion boundary.

## SDK connection identity

The default suite adds `js-sdk-connection-identity`,
`python-sdk-connection-identity` and `go-sdk-connection-identity` after drag.
Each aggregate runs EOF and explicit-close scenes with its public SDK in a
separate process. Set `OBU_TEST_CASES=sdk-connection` for these three aggregates
and the existing raw-navigation sentinel. Build the new Go caller with:

```sh
go build -o /tmp/go-sdk-connection-checks ./scripts/browser-integration/go-sdk-connection-checks
export OBU_TEST_GO_CONNECTION_BINARY=/tmp/go-sdk-connection-checks
```

On Windows use an `.exe` output and set the equivalent PowerShell environment
variable. The other existing host/browser/Go prerequisites still apply. JS uses
the frozen SDK dist; Python uses the frozen package with `OBU_TEST_PYTHON` when
provided. The runner copies the caller files/binary and records their hashes.
The Go binary must be built from the tested sources; its hash alone cannot prove
that relationship.

A local byte relay forwards unchanged frames to the real Go host and extension.
After reading the original document, the parent cuts the original connection or
acknowledges the child's explicit close. Four old entry points must reject without
opening another connection or producing a business submission. Only after those
checks does the parent allow an explicit new client and turn to perform one
trusted click. The old locator must remain unusable after successful recovery.

`sdk-connection-{js,python,go}.json` retains raw request frames, both relay-end
close times, caller stdout/stderr and actual exit/close, original document state,
exact POST bytes and tab/target cleanup. `sdk-connection-server.json` also keeps
wrong or duplicate submissions, so they cannot disappear from acceptance.
The test leaves backend epoch, ownership and focus allowances unchanged. It
proves recovery against the same real browser backend; native IPC tests cover
same-path replacement and active-discovery changes across endpoints separately.
See [connection contract and evidence](../../docs/references/sdk-connection-identity.md).

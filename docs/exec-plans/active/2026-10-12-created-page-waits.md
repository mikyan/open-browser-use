# Created page readiness and task continuation

## Goal

Advance P08/P12/P15 of the full Browser Use parity objective: an Agent prepares
for a page opened by its controlled source page, triggers the original action
once, receives the corresponding child page, and continues work there without
searching all user tabs or guessing by URL. Preserve the existing no-OS-mouse,
no-selected-user-tab-change, ownership, cancellation and explicit recovery rules.
No Pi adapter or PR; keep published preview archives unchanged.

The previous download-isolation slice is committed as `06ca074`, with its
original browser 3/3 and Node 79/79 evidence. Installation instructions do not
establish any new Browser Use capability. This plan is an additional slice;
it does not close the active original-file plan or the full P01–P15 objective.

## Boundary before this slice

The production CRX patch disables implicit opener attachment. `getTabs` returns
owned pages; a caller can explicitly `claimUserTab`, but there is no scoped
arm/collect/cancel created-page wait or typed `expectPage` interface. The earlier
child authorization fixture creates its tab using `chrome.tabs.create`, so it
cannot prove browser-created page provenance or an end-to-end page-triggered
continuation workflow. Renderer `window.open` can still activate the foreground.

Chrome's [onCreatedNavigationTarget event](https://developer.chrome.com/docs/extensions/reference/api/webNavigation#event-onCreatedNavigationTarget)
provides source tab, source frame, source process and new tab IDs. It does not
provide a source document ID. Frame IDs survive navigation; Chrome also warns
that webNavigation timestamps cannot be directly compared to the extension's
wall clock. These fields establish a native relationship, not proof that one
particular action caused the event. Capture and validate the actual source
document and handle source navigation explicitly; do not invent a document ID
or claim an atomic source-document relationship from a later snapshot.

## Work and acceptance

- [x] First verify the native route on unchanged production: two tasks opening
  the same child URL from root, existing OOPIF and newly inserted OOPIF. Use one
  trusted Control-click per source. Record original native creation events,
  source frame/document observations, child document bytes/nonce, one follow-up
  business POST and exact tab cleanup. A passive fixture observer followed by
  explicit public claim is feasibility evidence, not the missing product API.
- [x] Introduce bounded scoped ready/collect/cancel registration. Readiness
  means the listener and original source authority are established before the
  trigger can run. Keep one original timeout, finite retention, deterministic
  overlap policy, first matching native child and explicit stale-handle errors.
- [x] Implement adoption of only the exact native child within original source/turn authority;
  validate site policy and competing ownership, and retain its native window.
  Do not infer ownership from URL, filename, tab order, window focus or timing.
  Interrupted adoption must not leave an unauthorized debugger attachment or
  delete a user-controlled page. Inherited group membership has real JS evidence;
  first admission of an unowned native child still needs browser acceptance.
- [x] Expose the workflow through JS/Python/Go SDKs, CLI and MCP with capability
  negotiation and original-scope returned Tab handles.
- [x] Complete five-entry browser acceptance: each caller performs ready, one
  trigger, collection and a useful action on the returned page. Windows isolated
  `AGsTeb` passes 2/2, actual exit 0, with 15 exact children and 15 original POSTs
  across JS/Python/Go/CLI/MCP and root/existing/future OOPIF. Unowned first
  admission and lifecycle negatives remain separate unchecked requirements.
- [ ] Verify same-URL concurrent tasks, unrelated children, source/frame
  navigation, closed/moved child, cancellation, timeout, paused/ended turns,
  worker/host loss and late completion. No replayed click or automatic recovery.
- [ ] Run real browser checks with continuous focus accounting and independent
  source/receipt review, appropriate unit suites and existing regression checks.
  Record failures as failures; do not compensate with focus restoration or
  call a narrow launch-flag run normal-user-profile or cross-platform coverage.

## Production contract

`tab.expectPage` observes the first eligible native created-target event
from the original controlled tab, including its frames. It must not promise
that the adjacent click uniquely caused that event. Allow one waiter per source
tab to make overlap deterministic. Pin the root document at readiness and use
a dedicated webNavigation frame/document ledger even under unrestricted site
policy; the existing site-policy navigation callback returns early in that
mode. Future frames may join under that same root, but navigation of an already
admitted source frame invalidates its eligibility and any associated candidate.
The event's process/frame fields and subsequent document verification retain
their separate evidence meanings.

Use the original deadline through candidate validation and adoption. Do not
copy navigation waits' extra selected-result validation budget into this path.
Reuse auxiliary ownership reservations and live validation without using the
about:blank creation checker or moving a new page to another native window.
Cancellation retires the observer/unfinished authorization; it does not close
an already opened page. Real lifecycle acceptance remains open beyond the
implemented deterministic registry and backend tests.

## Related unresolved risk

Drag guard recovery remains open. The guard's Symbol registry belongs to a
per-Page utility world, so a new attachment cannot be assumed to see its old
entry. The held-input journal should still block new actions after worker loss.
Whether the old trusted-drop listener actually survives that lifecycle and
affects later user input requires a separate real-browser counterexample.
Neither a timeout nor renaming the registry proves old native input cancelled.

## Feasibility outcome

`FjJons` passed both selected browser cases, actual exit 0: six original native
children, six distinct server document nonces and six unique follow-up POSTs
totaling 1,160 bytes. All six already inherited the owner group before explicit
claim, so unowned-child adoption remains unproven. All six native opener fields
pointed to the sentinel, while webNavigation reported the real task source;
the implementation must not substitute opener metadata for the native event.
The 3,454 ms focus interval
has zero activation/focus events and no allowances. Exact twelve-tab cleanup,
listener removal, original Browser.close acknowledgement and browser/host
actual exit 0 are retained. Focused Node tests pass 16/16.

The earlier `8SGEVN` failed before any HTTP request on browser-restricted port
6697. The shared fixture listener now binds a dynamic/private loopback port
before startup, with bounded bind-conflict retries and no browser policy
override. That failure and an initial listener-test assertion failure remain
unchanged. See [the native evidence reference](../../references/created-page-waits.md).
Production API implementation follows below; this plan and the full goal remain active.

## Production implementation checkpoint

The three wire methods use `getInfo.metadata.pageWaitVersion = 1`. A dedicated
bounded frame ledger is active even when site policy is unrestricted. The
registry uses one monotonic deadline and tracks actual unresolved setup/adoption
promises separately from cancellation races. Exact native child adoption never
moves or attaches the child. New ungrouped membership uses auxiliary storage v4
`created-page`, preserving a grouped source; all such persisted records are
quarantined after worker restart before recovery cleanup.

The JS, Python and Go SDKs return typed Tabs pinned to the original connection,
session, turn, epoch and local control revision. CLI/MCP negotiate and validate
the same wire contract. Full SDK tests are JS 153, Python 118, Go 204, all pass
without skips; Go vet passes. The CLI package has 347 pass/24 existing platform
or permission skips. Extension/build/fixture tests pass 1109/1109.

Two cleanup defects found during integration are fixed with preserved failures:
consumption must not be followed by another old-record validity check, and
auxiliary rollback must await the actual detach phase rather than an aggregate
that contains its own rollback. Native detach hooks also no longer launch an
untracked extra download cancellation after explicit attempts failed. Exact
failure/retry ACK tests cover those paths. Browser evidence is summarized in
[the reference](../../references/created-page-waits.md).

The final registry snapshot excludes unbound source reservations and unadmitted candidate IDs from global
detach authority while retaining actual pending work and exact invalidation.
A gated regression failed before the fix and the focused suite passes 31/31.
Final isolated JS run `T7Nh7G` passes 2/2 with six native children, six POSTs
totaling 1,160 bytes and a 3,360 ms interval without focus events or allowances.
The earlier `8oY0FF` and its source-specific audit remain preserved.

## Five-entry acceptance checkpoint

The matrix now runs five independent callers across root, existing OOPIF and
future OOPIF. Each publishes readiness before the first gate; after dynamic
frame insertion, a second prepared gate lets the passive observer record
original frame/document/OOPIF evidence before any Control-click. All caller
stages use one original 20s budget. Atomic no-replace file gates serve Python/Go;
JS/CLI/MCP callbacks enforce the same barriers and deadline.

`AGsTeb` returned 15 native children and 15 unique POSTs totaling 2,933 bytes.
The independent parsed native bridge ledger contains 429 original requests and
429 matching ACKs, including 15 arm/collect/cancel chains. Actual sequence order
proves every group was ready before its first input and every original source
state read finished before its first trigger. All 15 children inherited their
source group; this does not prove first admission of an unowned child.
The 7,888 ms action interval has zero activation/focus events or allowances;
sentinel selection is unchanged, but its viewport height changed 1222 to 1165.
Thirty exact fixture tabs, both passive observers, browser and host were cleaned
up. Original Browser.close ACK and actual browser/host exit 0 are recorded.

Focused Node suites pass 106/106 without skips; typed IPC has nine test methods
covering 32 Windows named-pipe scenarios. The Go helper was rebuilt from its
current inputs; host/production/SDK code and the published preview archives are
unchanged. The ordinary 125-case suite was not repeated for this test-only
slice. The six-child JS artifacts remain separate. Full evidence and limits are
in [the reference](../../references/created-page-waits.md).

Real lifecycle work includes unrelated/competing children, source/frame
navigation, candidate close/move, cancellation and late completion, pause and
turn changes, worker/host loss, and genuine first admission of an unowned native
child. SDK stale-handle unit tests do not replace those browser checks.

For the next unowned-child check, use the existing public
`newTab({backgroundWindow:true})` source rather than inventing an `ungrouped`
option (the current create API does not support it). The source has explicit
background-window auxiliary authority. Whether its natural Control-click child
is ungrouped must be observed in the real browser. A staged-only synchronous
observer can retain adoption entry, the original `tabs.get` acknowledgement,
empty auxiliary ownership before reservation, and the exact created-page
reservation/commit/storage acknowledgements. It must return original promises,
never gate adoption or mutate the child to manufacture a successful path.
Native onCreated is an additional witness only when its actual sequence is
before reservation. Reuse the existing exact unfocused-window creation recorder;
the sole initial tab can produce an allowed activation and must not be reported
as a zero-event interval.

Prioritize cancellation after native matching but before collection (retire
authority and preserve the child), finalize after collection (release the
user-origin child without closing it), and worker restart (persisted
created-page authority is quarantined and a new client cannot inherit it).
These are concrete next browser checks, not completed source-review evidence.

## Unowned admission checkpoint: focus failure retained

`OBU_TEST_CREATED_PAGES=unowned` is implemented with original auxiliary/storage,
native control and parsed RPC observers. `ozpg7l`, `7GbZtP` and final `n7WyEq`
all return actual exit 1: natural Control-click creates two inactive ungrouped
children but activates their background source windows. The same-worker native
trace places focus after mouse release dispatch and before adoption, without a
captured explicit activation command. Both v2 focus events precede the release
ACK; one v3 event follows it, so this ACK ordering is not invariant. Version-matched
Chromium source has a show-window path for this navigation; no extension-level
repair preserving the original trusted child has been established.

Final `n7WyEq` adds positive first-adoption, matched-cancellation and failed-run
cleanup retirement evidence for two root children. It preserves the original
focus assertion, does not start the OOPIF layouts, and does not mark either item
successful. Cancellation proves expired collection, denied attachment and
source rearm; actual cleanup proves empty durable/current authority and denied
fresh-turn access while retaining original child documents. The 80 request/ACK
pairs and 188 original native calls are retained; repeated detach rejections
remain errors in the trace. Focused Node checks are 111/111. The existing preview
and production code remain unchanged; the full six-case and lifecycle gates
stay open. See [the evidence reference](../../references/created-page-waits.md#unowned-adoption-and-background-window-focus-failure).

Next work must address the native window activation constraint without focus
restoration or manufactured children, while extending the other lifecycle
negatives. `Target.createTarget` background/focus options concern explicit
creation, not later native children. A separate headless backend would be a
different deployment/session boundary and cannot substitute for existing-profile
background-window behavior. Do not rerun the same failed scene merely to seek
a green result.

## Worker restart recovery checkpoint

Exercise three genuinely unowned root children separately: one remains
matched and undelivered, one is collected and actually attached, and one is
collected then ended through public turnEnded before
the real extension worker is stopped and started. Retain pre-stop native
documents, durable `created-page` records and original scope. After restart,
test old requests/handles before explicitly refreshing control, then verify
fresh access still cannot inherit the children while the original committed
background-window sources remain available. A stale-epoch error alone is
insufficient: inspect current/durable ownership, native debugger state and
original child documents before fixture cleanup.

The existing background-window focus failure remains part of this run's
overall result. Do not restore focus, approve its events or represent a
successful authority sub-check as no-focus acceptance. Group-inherited children
are not substitutes: that membership is intentionally recoverable and would
exercise a different ownership contract. Preserve the original pre-restart
observations and separate worker/Port generations; do not concatenate their
sequence numbers into one invented stream.

The real `MIrY1h` run completes this lifecycle sub-check: all three original
claims pass committed → quarantine → removal in a persistent storage observer,
old authority fails before explicit new turns, original documents remain, and
fresh sources support read/rearm/cancel while children remain unowned. Host and
endpoint are unchanged, so this is worker replacement, not host loss. Actual
exit remains 1 due to native window focus and failed-run cleanup activation;
no new event allowance is added. Fifteen cleanup steps and browser/host exits
complete. Full native calls during startup are outside the two worker observers.

The probe exposed a production idle/orphan recovery gap. Recovery now moves
idle created-page quarantines through the closing barrier and retires claims
whose idle ledger was evicted. Explicit bootstrap retries failed exact cleanup
before creating new control. Old source yields 4/11 and fixed source 11/11 on
the same deterministic cases; all JavaScript suites pass 2206/2206. Focus and
remaining lifecycle gates stay open. Ordinary regression `EIJz4r` passes all
125 cases in their previous order, actual exit 0, with only the existing twelve
activation and four control-popup focus allowances over 242172 ms. This does
not replace the failed opt-in scene. See the [recovery evidence](../../references/created-page-waits.md#created-page-worker-recovery).

## Native host disconnect work

The previous checkpoint is verified progress (production fix, real worker
replacement, ordinary 125-case regression and pushed commit `619bf9f`). The next
scene uses the browser's real Native Messaging launcher rather than the test
WebSocket Port adapter. Keep the worker target/context alive, match one natural
unowned root child without collecting it, then terminate the exact private host
after verifying executable, process creation time and browser ancestry.

Observe the original wait's connection-lost error and exact admission cleanup
while its original deadline is still live, before waiting for automatic host
reconnection. A delayed observation after the original timeout is insufficient.
Retain source/child documents, old endpoint unavailability and the replacement
host identity. Explicit fresh control must not inherit the cancelled child;
the source must remain usable. Existing native popup focus failures still fail
the overall scene, and no replacement child or compensating focus is permitted.

Source audit found a separate reproducible failure: a settled failed page-wait
cleanup can leave native recovery repeatedly draining the same rejected Promise
even after the obstruction is removed. Backend counterexamples precede a minimal
explicit-bootstrap retry. Only failed, settled cleanup may retry under the
already-established native recovery fence; no adoption, input or in-flight
cleanup is restarted. Delivered committed pages have a different host-loss
contract from worker replacement and are not silently reclassified by this fix.

The real Native Messaging run `9QWc6h` now verifies this matched-undelivered
checkpoint with the same worker target/context/boot and a different host PID
and named pipe. Original cleanup completes with 18558 ms still remaining;
old scope and socket access fail, fresh source read/rearm/cancel succeeds, and
the child remains unowned. Both original documents and source/child native
window/group/pinned fields are retained. This is normal successful cleanup,
not a real-browser injection of the settled failure/retry case. That fix has
seven backend tests: old source passes three and fails four, fixed source
passes seven. All JavaScript suites pass 2226/2226 without skips/cancellations.

Overall `9QWc6h` remains actual exit 1: one business focus, two cleanup focus
events and one child-successor activation are not newly allowed. Eleven helper
cleanup steps pass, the browser exits 0, exact private browser/host processes
are absent and the owned temporary registry leaf is removed. The force-killed
host's stale descriptor is retained in the private fixture directory; do not
claim an empty descriptor inventory or a successful no-focus scene.

The subsequent complete ordinary regression `h6a5W4` passes 125/125, actual exit
0, with the same names/order and existing twelve activation/four control-popup
focus allowances. It checks the production fix without substituting for the
failed native created-page scene. Full focus/layout and lifecycle requirements
remain open; published preview archives are unchanged.

## Explicit recovery after page events

The host-loss checkpoint is committed as `f3672b7` with its original native
failure and ordinary 125-case pass retained. The next backend counterexamples
reproduce a separate user-visible recovery trap: source navigation or child
closure invalidates a matched waiter, transient storage failure prevents exact
claim retirement, then ending the turn or pausing invalidates the old scope.
After storage recovers, both same-session bootstrap and Retry Pause still drain
the old rejection; the old handle can no longer request cancellation. All four
original combinations failed on the `f3672b7` source.

Retry only settled failed cleanup in an explicit recovery entry. Same-session
bootstrap must stay under the closing/ending-session fence and cannot retry a
foreign task's cleanup. Pause must block input synchronously before starting
global retries and capture their new drain. Internal automatic pause signals
must not authorize retries. Preserve concurrent `closing:true` responses and
in-flight cleanup sharing, and keep failure blocking if the new attempt fails.
Tests must retain native page state, admission count and no-input/no-adoption
replay evidence. Run relevant unit suites and the unchanged full ordinary
browser matrix after the production source freezes; browser storage-failure
injection is a separate unverified boundary until actually exercised.

The final twelve backend cases yield 2 passes/10 failures with the prior two
production files and pass with the fix. Focused regressions pass 137/137 and
all JavaScript suites pass 2238/2238 without skips/cancellations. Source review
also narrows the focus investigation: createTarget's ShowInactive is local to
its creation navigation, and focus emulation or preparation userGesture flags
cannot override the later native navigation decision. No new focus experiment
or passing browser result is inferred from this review.

The later ordinary full regression `B5TASC` passes 125/125 with actual exit 0.
Case names/order match `h6a5W4`; 242,478 ms continuous observer coverage and
sixty original snapshots preserve exactly the existing twelve activation/four
control-popup focus allowances. The original sentinel remains active, source
and staged builds match, and exact private process inventories are empty after
teardown. This uses the loopback Native Port adapter and does not establish
real-browser storage-failure recovery. Published preview archives are unchanged.

The isolated native launcher now verifies all four recovery combinations:
`CxXan4`/`jEHwoF` use session bootstrap after navigation/closure, and
`DxTviV`/`itXMS9` use real-popup Retry pause and Resume control. A private worker
wrapper adds an oversized test value only to exact-claim deletion through
`chrome.storage.session.set` and returns the original native Promise. Each run
retains three native quota rejections and one subsequent successful deletion.
This is deliberate argument fault injection, not spontaneous storage failure.
Original deadlines, same live host/worker identity, quarantined claim retention,
absent test key, old-authority denial and fresh-source usability all hold.

Recovery is verified in 4/4, but all four runners retain actual exit 1 because
of original native focus/activation failures. The popup uses the already-focused
exact private window and original DOM handlers, without focus restoration or
new business allowances. All 13/14 cleanup steps, browser exit 0 and exact
process/endpoint/registration absence are independently checked. Final focused
Node tests pass 146/146, including replacement-popup and delayed-context
counterexamples for the same-evaluation click guard. Earlier popup runs
`DEc8wj`/`Sg0Coj` are retained with their prior document-check gap.
Initial collect-expectation failure `jegs7C` and inactive
popup failure `yg1DL6` remain preserved, not counted as complete recovery.
Production and preview bytes are unchanged; prior full Node/ordinary browser
runs were not repeated for this harness-only change. See the
[native recovery evidence](../../references/created-page-waits.md#native-quota-failure-recovery).

Next, keep the no-focus failure visible while extending the original unowned
child workflow across layouts and lifecycle transitions. Before any native
focus experiment, establish that it preserves the original trusted page action,
actual source relationship and child identity; substituting another tab or
restoring focus after activation does not satisfy the product requirement.

## Relevant implementation

- `apps/chrome-extension/background.js`, `auxiliary-tab-ownership.js`
- Existing navigation/download readiness registries and SDK scope lifetimes
- `scripts/browser-integration/run.mjs`, new created-page fixture/proof modules
- `docs/product-specs/browser-use-parity.md`

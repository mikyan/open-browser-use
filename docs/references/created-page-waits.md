# Created pages: readiness and native provenance

An Agent needs to prepare for a page opened by its current task, trigger the
original action once, and continue on the corresponding child. Production
now adds scoped `armPageWait`, `collectPageWait` and `cancelPageWait` alongside
explicit creation and `claimUserTab`. The implementation and earlier native
feasibility evidence are recorded separately below; the
[implementation plan](../exec-plans/active/2026-10-12-created-page-waits.md) remains active.

## Public contract

`getInfo.metadata.pageWaitVersion === 1` is required. JavaScript exposes
`tab.expectPage({timeoutMs})`, Python `tab.expect_page(timeout_ms=...)`, and Go
`tab.ExpectPage(...)`. Their result method returns a normal typed Tab bound to
the original connection, session, turn and epoch. Changing the parent control
scope invalidates that returned handle; it cannot silently rebind to a new turn.

```js
const pending = await tab.expectPage({ timeoutMs: 10000 });
try {
  await tab.getByRole("link", { name: "Open report" }).click({ modifiers: ["Control"] });
  const report = await pending.result();
  await report.getByRole("button", { name: "Export" }).click();
} finally {
  await pending.cancel();
}
```

CLI and MCP use their existing `call` interface with these same wire methods:

| Method | Fields in addition to session/turn/control epoch | Result |
| --- | --- | --- |
| `armPageWait` | Source `tabId`, optional `timeoutMs` | `{waiterId, remainingMs}` |
| `collectPageWait` | Original source `tabId`, `waiterId` | `{tabId}` of the exact child |
| `cancelPageWait` | Original source `tabId`, `waiterId` | `{}` after actual cleanup |

Timeout defaults to 10 seconds and accepts integral 1–120000 ms. One waiter per
source makes overlap deterministic; global and per-session capacity are bounded.
The original monotonic deadline covers readiness, candidate validation, adoption
and collection. There is no additional selected-result grace period. A failed
or unknown reply never causes automatic trigger replay.

Readiness pins the root document using a dedicated versioned webNavigation
frame ledger, independent of website-restriction mode. The first eligible native
created-target event is locked before asynchronous validation. Frames created
after readiness may join the original root. Navigation of an admitted frame
excludes it and its descendants; root navigation invalidates the wait. Live frame
snapshots are checked again before adoption and collection. The native event does
not carry an atomic source-document identity or prove unique click causality.

Adoption checks site policy, original source authority, exact child window and
competing ownership. Inherited task-group membership stays in place. An ungrouped
child receives a distinct `created-page` auxiliary record, so a grouped source
is not switched into ungrouped compatibility mode. No child is moved, activated
or attached by adoption. Cancellation revokes only this wait's new admission;
it does not close a child or revoke a pre-existing owner. Native popup creation
itself can still activate the foreground; this API does not prevent that.

Cancellation tracks actual pending native/storage work. Failed cleanup retains
its reverse lock; another explicit `cancelPageWait` may retry only a cleanup
attempt that actually settled and failed, never an in-flight operation or the
original adoption. Auxiliary storage version 4 reads older versions and saves
the new kind. After worker restart all persisted `created-page` records are
quarantined for exact cleanup, including previously delivered pages, rather than
reconstructing authorization from child IDs. Idle sessions enter the existing
closing barrier when they retain such a quarantine. Created-page claims whose
idle control record was evicted are also retired without recreating that record;
failed cleanup retains quarantine and explicit same-session bootstrap retries
it before creating new control. Original background-window source claims remain
recoverable. Real root-worker and host-disconnect evidence is below; the wider
lifecycle matrix remains open.

Host disconnect in a surviving worker has a different contract from worker
replacement. It invalidates an undelivered waiter and releases that wait's new
child admission. A previously delivered child's committed membership survives,
but its old control epoch and attachment do not. If undelivered cleanup settles
with an error, ordinary work remains fenced; explicit control bootstrap retries
that failed cleanup before admitting a new turn. Repeated disconnect signals
and overlapping bootstraps do not duplicate an in-flight cleanup or replay
adoption or input.

The same explicit retry is available after navigation/closure cleanup failed
and a subsequent end operation left the session closing: bootstrap retries
only that session's settled failed records under its existing recovery fence.
Explicit Pause/Retry retries all settled failed records after blocking input,
before capturing their cancellation drains. Automatic pause signals do not
authorize retries. Pending cleanup is shared; repeated failures keep control
blocked, and concurrent bootstrap retains its existing `closing:true` response.

The global pause snapshot lists only source tabs bound to verified control,
not unvalidated reservations or candidate IDs awaiting admission. Only the
auxiliary registry contributes admitted child ownership.
Candidate IDs still participate in exact invalidation and the barrier still
tracks actual setup/adoption work. Pending attachments have their own backend
control records; excluding unowned IDs does not discard these barriers.

## Native relationship

Chrome's [created-navigation-target event](https://developer.chrome.com/docs/extensions/reference/api/webNavigation#event-onCreatedNavigationTarget)
reports source tab/frame/process and destination tab IDs. It has no source
document ID or action token. A source frame ID can survive navigation, and
native event timestamps must not be directly compared with extension wall
time. Subsequent document reads are evidence of the document observed then,
not an atomic document identity attached to the original event.

The public contract is the first eligible native child observed after
readiness within the original controlled source/root-document lifetime. It
does not promise unique click causality. Future frames need explicit bounded
admission beneath the same root; navigation, replacement, cancellation and
scope invalidation must not silently select a replacement candidate.

## Production readiness evidence

Feature-commit run `T7Nh7G` in isolated Windows Chromium completed
**2/2, actual exit 0**, including
the public JS `expectPage` workflow. Two tasks each used root, existing OOPIF
and future OOPIF sources to create six identical-URL native children. The
future frame was inserted after ready. Each returned typed Tab completed one
original trusted business submission: six POSTs totaling **1,160 bytes** with
six distinct original child-document nonces. There is no explicit claim in
this mode; an independent native observer joins the returned IDs to original
source tab/frame events. All six children inherited the task group, so this
does not establish first-time unowned-child adoption.

The **3,360 ms** action interval recorded zero tab activation, window focus
events or allowances. Twenty-four cleanup entries succeeded, including six
wait cancellations, two finalizations, exact twelve-tab absence and listener
removal. Original Browser.close returned `{}` and the child actually exited 0.
The fixture uses the existing test Native Port adapter and an isolated profile;
it does not establish normal-profile installation or whole-OS focus behavior.

Extension/build/fixture tests pass **1109/1109**. Complete SDK suites pass JS
153, Python 118 and Go 204 with no skips, plus Go vet. CLI/MCP package tests have
347 passes and 24 existing platform/permission skips. The host was freshly
built from the current frozen Go inputs; the three published preview archives
remain unchanged. The default 125-case browser baseline was not rerun for that
feature commit; the later shared-Pause regression is recorded below.

The preceding successful `8oY0FF` (2/2, 3,450 ms without recorded focus events)
is retained as evidence for its earlier source. A subsequent gated-candidate
regression failed against that registry because it included an unadmitted child
in the global detach set. A second backend reproduction showed that an unbound
source reservation could also issue detach for an unowned tab during Pause.
The final bound-source-only fix passes 31 focused tests and a public Pause
regression that drains actual setup without touching that unowned tab.
`T7Nh7G` and the 1109-test suite above use that final implementation. Earlier
`4CJEGW` and `OuXNJi` successful runs and audits retain their own source identity.
The final JS harness also retains its pre-arm 20-second budget through dynamic
frame preparation, trigger and business receipt, with no reset at trigger time.

Typed Python/Go acceptance callers and their ready/release gates are prepared.
Their five test methods cover 16 fake-browser IPC scenarios plus three input
type negatives; Go build/vet pass. These are not real page acceptance, and the
five-entry runner and CLI/MCP caller integration remain open.

After the shared Pause authority fix, isolated regression `BQyEWc` again
completed **2/2, actual exit 0**, with six original children, six unique POSTs
(1,160 bytes) and a **3,561 ms** interval with no recorded activation/focus
events or allowances. All six children still inherited their source group.
Independent review verifies the eight changed production files, full original
budgets, exact cleanup and browser/host terminal receipts; this does not extend
the proof to unowned adoption or the other four callers. The shared authority
regressions and their evidence limits are described in
[control lifecycle](control-lifecycle.md#user-pause-and-resume).

The shared fix also passes the ordinary headed **125/125** suite `eRYJ16`,
actual exit 0, using the current eight Go caller binaries and unchanged fresh
host. Its **243,654 ms** focus interval has the existing twelve activation and
four control-popup focus allowances, with no additions; it is not a zero-focus
claim. This baseline does not include the opt-in created-page five-entry matrix.

Preserved failures include the first cleanup regression (110/111), its exact
focused reproduction, and a hung auxiliary-release lifecycle test that was
terminated after confirming its real process remained live. Fixes separate
actual native cleanup from waiter rollback and prevent native-detach callbacks
from retrying a failed download cancellation outside the tracked barrier.
Subsequent exact lifecycle and full extension tests pass; no sleeps or relaxed
assertions were used to turn the failures green.

## Five-entry browser acceptance

Windows isolated Chromium `AGsTeb` passes **2/2, actual exit 0**: raw navigation
and the opt-in five-entry ready workflow. JS, Python, Go, CLI and MCP each
complete root, existing OOPIF and future OOPIF, for **15 same-URL native children
and 15 unique business POSTs totaling 2,933 bytes**. The current product APIs are
used throughout. No caller receives a guessed child ID/nonce or explicitly
claims, synthesizes or replays a child-opening action.

Two barriers per group enforce all-five readiness before dynamic Add and all-five
source preparation before Control-click. The caller's original 20s monotonic
budget covers both gates, returned child and useful submission; cleanup has a
separate bounded allowance. Empty fixture state is retryable; malformed nonempty
state and actual RPC failures terminate without input replay. Python/Go gate
files use complete, closed temporary files and atomic no-replace publication.

The passive native event observer independently joins source/frame to returned
child. The passive native adapter hook retains **429 requests and 429 matching
ACKs**, with original scope and 15 exact arm/collect/cancel chains. Across each
five-member group, actual sequence numbers establish all ready ACKs before the
first Add/trigger and all source state ACKs before the first trigger. Original
HTML nonces, trusted DOM click records and POST request/response bytes provide
separate identity and business evidence. These are parsed RPC JSON records,
not raw transport frames. The hook's generation label is separately checked
against the original host PID, endpoint and bridge generation.

All 15 children have the original source group. This is inherited ownership,
not a successful real test of first unowned-child admission. Source native
frame/document observations surround the trigger; child native frames are read
after business completion. Neither replaces atomic event/document identity.
Foreign-owner denial remains covered by the earlier six-child JS workflow;
this matrix does not repeat that negative test.

The **7,888 ms** action interval has zero activation/focus events and zero
allowances. Sentinel tab/window identity and selection remain unchanged; its
viewport height changes from 1222 to 1165, so geometry is not claimed unchanged.
Thirty exact fixture tabs are absent after cleanup, both passive observers are
removed/restored, and all 60 external caller processes actually close (51 CLI,
three MCP, three Python and three Go). Browser.close
returns `{}`, followed by actual browser and host exit 0. Startup/teardown and
whole-OS focus are outside the action ledger; the established isolated Native
Port adapter is used, not an installed normal-user-profile connection.

Focused Node suites total **106/106**, zero skips/cancellations; typed caller IPC
has **nine methods covering 32 real Windows named-pipe scenarios** against a fake
browser. Real CLI/MCP executables additionally exercise public parsing over that
IPC. Go helper vet/build pass, with current source and binary manifests. Production
extension/host/SDK inputs and the published preview archives are unchanged;
the prior ordinary 125-case baseline is not rerun for this harness-only change.

An independent raw-artifact audit passes 1,877 checks without importing the
production verifier. It also confirms all 15 native opener IDs differ from the
actual source IDs; opener metadata is not used for the relationship. The final
audit retains its earlier script KeyError and schema-assumption failures (gate
field placement, zero-based HTTP sequence, source-frame versus all-document
lists, additional cleanup fields and staged production paths). Those corrections
use the original records; no browser evidence or success condition is rewritten.

## Unowned adoption and background-window focus failure

The opt-in `unowned` mode uses the public `newTab({backgroundWindow:true})`
source, without ungrouping, synthesizing a child or explicitly claiming it.
The two root children in `ozpg7l`, `7GbZtP` and `n7WyEq` had no auxiliary owner
or reservation at adoption entry, and the original native tab ACK had group
`-1`. Original reserve, storage-write and commit acknowledgements establish
first adoption under the source's session/turn/epoch. Both child tabs stayed
inactive in their original windows at admission.

**All three runs fail, actual exit 1.** The source windows gain focus during
the original Control-click, before adoption starts. Each run completes only
the root group, with two natural child GETs and one unique business POST of
197 bytes (143-byte response). Existing/future OOPIF and the full six-case
matrix are not reached. The successful five-entry grouped-source matrix above
does not establish that a separate background window will remain unfocused.

The second run adds a bounded, staged-only observer around original Chrome
control calls. Its 405 rows contain 195 calls, including 176 CDP commands, and
15 native events. For both original mouse releases, the child-created event,
window-focus event and created-navigation event occur after dispatch and before
the original command ACK. No `Page.bringToFront`, `Target.activateTarget`,
`windows.update` or `tabs.update` occurs in that observer's captured calls.
The final run has 391 rows / 188 calls (169 CDP), with 177 fulfilled and 11
rejected calls. Its collected-child release ACK precedes child creation/focus;
the cancelled-child release ACK follows them. Both focus changes are after
the original release dispatch and before adoption, but ACK-relative order is
not stable across runs. The rejections are explicit already-
detached debugger errors. Do not describe all native commands as successful.
CRX preparation still sends `Runtime.callFunctionOn` with `userGesture:true`,
and focus emulation is enabled. Absence of an explicit activation call does not
prove absence of outside input or identify a native call stack.

The installed Chromium version is 156.0.8078.4. Its
[OpenURLFromTab](https://raw.githubusercontent.com/chromium/chromium/156.0.8078.4/chrome/browser/ui/browser_web_contents_delegate/browser_web_contents_delegate.cc)
selects the show-window action for a user gesture, including background-tab
navigation. The [navigation window shower](https://raw.githubusercontent.com/chromium/chromium/156.0.8078.4/chrome/browser/ui/navigator/browser_navigator.cc)
then calls Show, and a visible [BrowserView](https://raw.githubusercontent.com/chromium/chromium/156.0.8078.4/chrome/browser/ui/views/frame/browser_view.cc)
activates its widget. This version-matched source chain explains the observed
timing, but remains an inference rather than an instrumented native stack.
Adoption happens too late to prevent it. Restoring focus, substituting a
`tabs.create` child, or adding an allowance would not fix this requirement.

Further API/source review found no applicable persistent activation suppression
in the inspected interfaces. Chrome's [Target handler](https://github.com/chromium/chromium/blob/156.0.8078.4/chrome/browser/devtools/protocol/target_handler.cc#L52)
sets ShowInactive for its own explicit creation; later native navigation builds
new NavigateParams. [Focus emulation](https://github.com/chromium/chromium/blob/156.0.8078.4/content/browser/devtools/protocol/emulation_handler.cc#L1042)
changes renderer focus/rendering behavior, not that navigation decision.
[Input.dispatchMouseEvent](https://raw.githubusercontent.com/ChromeDevTools/devtools-protocol/master/pdl/domains/Input.pdl)
has no userGesture/noActivate parameter, and the [native press handler](https://github.com/chromium/chromium/blob/156.0.8078.4/third_party/blink/renderer/core/input/event_handler.cc#L930)
grants interaction activation independently of preparation Runtime calls.
Removing a preparation call's userGesture flag therefore has no established
fix mechanism. Expiring the gesture is not a general solution either: the
[popup blocker](https://github.com/chromium/chromium/blob/156.0.8078.4/components/blocked_content/popup_blocker.cc)
also checks background-tab navigation without a gesture.

The saved Codex 1.1.4 extension source (`formatted/background.js`, lines
1388–1420 under `codex-chrome-extension-1.1.4`) similarly creates inactive tabs
in an existing focused normal window, falling back to an unfocused window.
That historical implementation is not current-product background-window
acceptance evidence. This source review adds no browser pass or native stack
trace, and the focus requirement stays open.

In final run `n7WyEq`, both root business branches execute before the unchanged
strict finalization focus assertion. The cancellation branch is freshly observed
as matched, valid, undelivered and with about 19.4 seconds remaining. Cancel
removes its auxiliary entry, reverse owner and stored record without closing or
attaching the child; old collection fails, attachment is denied, a repeated
cancel succeeds, and an explicit new wait can be armed and cancelled. The
collected child's delivered-wait cancellation leaves its ownership unchanged.

The focus assertion then fails. Failure cleanup performs actual formal
finalization, and separately verifies both original child documents remain,
sources close, auxiliary entry/owner/storage disappear, debugger attachments
are absent, and explicit fresh turns enumerate no pages and cannot attach the
old children. These are observations after failed-run cleanup, not successful
normal finalization or overall acceptance. The original wire ledger retains
80 requests and 80 responses, including cleanup. No browser action is sent to
the cancelled child. Its nonce is never read, so the remaining child GET is
not claimed as an independently nonce-joined identity proof.

All 21 cleanup actions complete; four exact fixture tabs and two windows are
absent, observers are restored, and browser/host actually exit 0 after the
original Browser.close ACK. The focus ledger retains three business focus
changes, two cleanup focus changes and four activations; only the two initial
source-tab activations have existing allowances. Zero focus allowances are
added. Final focused Node tests pass 111/111, without skips or cancellations.
Production extension, host, SDK and published preview archives are unchanged;
the ordinary 125-case suite is not repeated for this test-only slice.

Independent failed-run audits check 884, 1,324 and finally 1,502 conditions
against the three original artifact sets; their successful audits explicitly
retain the browser failures. The final audit records 59 original Runtime calls
with user gestures. Its first draft incorrectly reused v2's release-ACK order;
that failed draft is retained, and the corrected report follows v3's original
sequence rather than changing the run. Full acceptance still requires the
unreached layouts, normal finalization and remaining lifecycle failures.

## Created-page worker recovery

The production recovery path previously handled active/closing control records
only. A delivered child could survive public turn end or handoff with an idle
record, then remain quarantined indefinitely after worker replacement. Idle
ledger eviction could leave the same quarantine without any control record.
Eleven deterministic backend cases run against the old production source yield
four passes and seven failures; the fixed source passes all eleven. Native
cleanup and storage-removal failures stay fenced and can be explicitly retried.
Existing blocked-input and foreign-owner protections remain in place; the
foreign-owner fixture does not certify a real third-party debugger session.

`OBU_TEST_CREATED_PAGES=worker-restart` checks three natural unowned root children:
one collected and attached, one matched but undelivered, and one collected then
ended through public `turnEnded()`. Isolated Chromium `MIrY1h` replaces the real
worker target while retaining the same host process, endpoint and generation.
The persistent extension-page storage observer records all three original claims
changing committed → quarantined → removed. These are original `onChanged`
deliveries, not the original `storage.set()` Promise acknowledgements.

All three original source and child documents survive. Old-scope requests are
tested before any explicit new turn; collection reports EXPIRED and cancel/
attachment report STALE. The idle typed handle was already invalidated by turn
end and is not separate evidence of worker loss. Fresh turns retain only the
original sources, reject child attachment, and can read/rearm/cancel on those
sources. No child input or business POST is sent. Two collected-child nonces are
joined to original server HTML bytes; the undelivered child's nonce is not read.

Pre/post-worker RPC streams remain separate, with 71/71 and 52/52 request/reply
pairs. Their 213 and 63 native calls include six and nine rejected settlements;
they are not all successful calls. Native observers are stopped before restart and reinstalled after worker
reconnection; they do not cover every native call during startup recovery.
Storage and focus observation remain continuous. The original 20-second action
budget is not renewed. A separate 30-second restart/observation budget checks
before and after helper calls; internal restart waits retain their own bounds,
so this is not a strict per-RPC launch cutoff or native cancellation guarantee.

The lifecycle sub-check passes, but the run has actual exit 1. Five business
focus events from native child creation remain failures; failure cleanup adds
three child-successor activations and two focus events without new allowances.
All fifteen cleanup steps succeed, six fixture tabs and three source windows
are absent, observer listeners are removed, and browser/host actually exit 0.
This does not establish host-loss recovery, covered separately below, or close
background-window focus, OOPIF or full lifecycle acceptance. All relevant
JavaScript suites pass 2206/2206 with no skips or cancellations. Published
preview archives are unchanged.

The independent audit checks 545 conditions against the original artifacts and
retains that failed overall result. Ordinary regression `EIJz4r` separately
passes **125/125, actual exit 0**, preserving the previous names and order.
Its 242172 ms observer interval has only the existing twelve activation and four
control-popup focus allowances. The selected sentinel identity remains the same;
its height changes from 1222 to 1165. The eight Go helpers and native host are
reused only after checking their build inputs and binary hashes; the production
extension is freshly staged from this fix. This ordinary pass cannot replace
the failed opt-in background-window scene or certify orphan/failure-retry paths
in a real browser.

## Created-page native host loss

A settled failed page-wait cleanup previously left native recovery repeatedly
draining the same rejected Promise, even after the original obstruction was
removed. Explicit bootstrap now establishes the native recovery fence, restarts
only settled failed page cleanup, and joins its actual drain before allowing
new control. Seven backend cases using simulated Chrome callbacks yield three
passes and four failures against the old source, then seven passes with the fix.
They cover native detach and storage deletion failures, repeated failures and
overlapping bootstrap calls. These are deterministic failure-retry evidence,
not real native-process termination.

`OBU_TEST_NATIVE_MODE=created-page-host-loss` uses the separate real Native
Messaging runner. Isolated Chromium `native-lifecycle-9QWc6h` matches one natural
Control-click child of a public background-window source, leaves it undelivered,
then terminates the exact private browser-launched host. The runner verifies
the host executable and browser ancestry, then rechecks creation identity while
holding the actual process handle. No WebSocket Native Port adapter is used.

The same browser, worker target/context, worker boot and browser incarnation
survive; the replacement host has a different PID and named pipe. Passive
observation sees the original `OBU_NATIVE_CONNECTION_LOST` invalidation and
exact child admission cleanup with **18,558 ms remaining** on its original
20-second budget. This evidence is collected before the harness observes the
replacement endpoint or opens its fresh SDK connection. The transport reconnects
automatically: that observation order does not prove cleanup preceded the actual
native reconnect. The old SDK rejects use and its old endpoint is unavailable.

Before explicit bootstrap, old-scope attachment and cancellation return STALE;
collection retains CONNECTION_LOST. The fresh scope enumerates the original
source, rejects child attachment, and can read, re-arm and cancel on the source.
Both original document IDs/URLs and their native window/group/pinned positions
remain intact. The child auxiliary entry, owner and persisted record are absent,
with no debugger attachment. No child attachment, Runtime command, input or POST
is sent. The undelivered child's document nonce is not read, so its single server
GET is not claimed as a nonce-joined document proof.

The lifecycle sub-check is true, but **the complete run fails, actual exit 1**.
Its ledger retains one business window-focus event, two cleanup window-focus
events and one cleanup child-successor activation. Only the original source-tab
creation activation has an existing allowance; no new focus or successor
allowance is added. All 82 observed native calls remain visible: 76 fulfill and
six reject. They are not an all-successful native command stream.

All eleven cleanup entries succeed. Exact fixture tabs and their window are
absent, passive observers are restored, the browser exits 0, observed private
browser/host processes are gone, and the ownership-fenced registration leaf is
removed. Forced termination leaves the old host descriptor in the private
artifact directory; this is not a claim that all descriptors were removed.
The detailed record is `native-created-page-loss-detail.json`, alongside
`native-created-page-host-loss.json`, `created-page-server.json` and `results.json`
in the run directory; the launch log's recorded exit is also 1.

All relevant Node suites pass **2226/2226**, with no skips or cancellations.
The real scene exercises successful cleanup after actual host loss; it does not
establish real-browser failure-retry, delivered-child recovery, other layouts or
full lifecycle acceptance. Separately, the fixed production source passes the
complete ordinary suite `h6a5W4`: **125/125, actual exit 0**, with the same case
names/order as `EIJz4r` and only the existing twelve activation and four control
popup focus allowances over 237041 ms of continuous observer coverage. The
selected sentinel retains its identity and selection;
its height changes from 1222 to 1165. This ordinary pass does not replace the
failed native created-page scene. The published preview archives remain unchanged.

Independent artifact audits retain the native scene's failed overall result
and the ordinary run's pass. The ordinary run's complete extension bytes and
reused host/helper inputs and build metadata match the frozen checkpoint.
Its replacement host exits 0 and the exact private profile/executable process
inventory is empty. The ordinary runner has no separate Chromium graceful-close
acknowledgement/exit-code artifact; process absence is not that stronger claim.

## Explicit recovery after navigation or child closure

When automatic page invalidation failed to delete its new child admission,
ending the session or pausing made the old cancellation handle unusable. Even
after the storage fault disappeared, a new turn or Retry Pause drained the
same rejected cleanup Promise indefinitely. The new explicit recovery paths
retry that settled failure before capturing their new drain, retaining the
session or global input fence described above.

Twelve backend cases run the actual production registries with simulated Chrome
events and transient storage rejection. The same final cases yield **2 passes
and 10 failures** on the prior production source. The fixed focused suite passes
**137/137**, and all JavaScript suites pass **2238/2238** without skips or
cancellations. Coverage includes source navigation, child closure, foreign-session
isolation, original/retried pending cleanup, repeated failure, automatic recovery
without retry, retained child state and absence of adoption/input replay. This
does not by itself establish real-browser storage-failure recovery or fix native
popup focus. The targeted native recovery evidence below has a separate scope.

The frozen production fix also passes the complete ordinary browser regression
`B5TASC`: **125/125, actual exit 0**, with the same case names/order as `h6a5W4`.
Its 242,478 ms continuous observer retains the original twelve activation and
four control-popup focus allowances; sixty snapshots preserve the final event
history and the sentinel remains active in its original window. Source/staged
extension and reused binaries match their manifests, and exact private process
inventories are empty after teardown. This run uses the existing loopback
Native Port adapter; it does not inject storage faults or replace the failed
native created-page focus scenes. Published preview archives are unchanged.

### Native quota-failure recovery

The real Windows Chromium 156 native launcher now exercises each combination
in its own isolated browser, using the production fix from `2097b3d` unchanged:

| Run | Original page event | Public recovery | Recovery verified | Runner exit |
| --- | --- | --- | --- | --- |
| `CxXan4` | Source navigation | Same-session beginTurn | Yes | 1 |
| `jEHwoF` | Child closure | Same-session beginTurn | Yes | 1 |
| `DxTviV` | Source navigation | Retry pause, then Resume control | Yes | 1 |
| `itXMS9` | Child closure | Retry pause, then Resume control | Yes | 1 |

Claim removal rewrites an auxiliary snapshot through `chrome.storage.session.set`.
A private worker wrapper matches the exact original waiter, claim and incarnation,
adds a random test value of `QUOTA_BYTES + 1024`, invokes the saved native method
and returns its original Promise. Each scene records three actual native quota
rejections, then exactly one successful unpadded deletion after disabling the
fault. The failed writes preserve the quarantined claim and never persist the
test key. This is deliberate argument fault injection, not a naturally occurring
storage or disk failure; unrelated writes and production sources are unchanged.

The original natural Control-click child remains matched and undelivered.
The first settled failure is observed with 19.028–19.080 seconds remaining on
its original 20-second deadline. Public ending/Pause and an explicit retry both
fail while the fault remains enabled. Recovery then uses a separate bounded
30-second transition budget without extending the original waiter. The same
live host PID, process creation time, browser ancestry, endpoint, worker and
observer identities hold before and after recovery. Old getTabs/cancel authority
is rejected; collect retains its original source-changed/expired error instead
of acquiring a new scope. A fresh turn can read the source and arm/cancel a new
wait, while the original child gains no authority. Navigation preserves that
child's original document; a closed child remains absent. There is no child
attachment/input or adoption replay.

The pause scenes use one real popup document throughout: Failed → Failed →
Paused → Running, with matching DOM state and saved screenshots. Each button's
original context/document identity, label, action, enabled state and recovery
deadline are checked inside the same browser evaluation before calling its DOM
click handler. Delayed lookup or a replacement popup rejects before clicking.
This is not physical
mouse input. The popup opens only in the already-focused exact private source
or sentinel window; the test does not restore focus. Original unwanted events
remain in the strict focus ledger, with zero additional focus allowances.

All four runners still exit **1** because native opening and cleanup change
window focus or tab activation. Recovery success is not no-focus acceptance.
All 13/14 helper cleanup steps complete, each browser exits 0, and exact private
host/browser processes, native endpoint descriptors and temporary registrations
are absent after teardown. Independent artifact audits verify these recovery,
identity, action and cleanup records while retaining the overall failures.
The final focused Node suite passes **146/146**, with no skips or cancellations.
The previous full Node 2238 and ordinary browser 125 results were not rerun for
this harness-only slice. Production inputs and published preview archives are
unchanged; broader layouts, platforms and no-focus behavior remain open.

Two initial attempts remain failures: `jegs7C` stopped because its test wrongly
required stale/expired instead of the retained source-changed collect error;
`yg1DL6` could not open the popup in an inactive sentinel window and did not
complete formal finalization. Their artifacts are preserved separately from
the corrected runs. The latter's exact fixture/process/registration cleanup
still completed; it does not count as recovered lifecycle evidence.

The earlier popup runs `DEc8wj`/`Sg0Coj` also verified recovery, but their driver
checked document identity before button polling and after clicking, leaving a
possible replacement between those checks. The final two runs above add the
same-evaluation identity check, tested against replaced/missing/ambiguous
contexts, delayed lookup and changed button/document state. Earlier artifacts
are retained with that narrower evidence boundary.

## Earlier native feasibility evidence

Windows isolated Chromium run `FjJons` completed **2/2, actual exit 0**: the
existing raw-navigation control and the new provenance workflow. Two JS owners
each opened one identical child URL from a root page, an existing OOPIF and a
newly inserted OOPIF. Both sources were prepared before either original
Control-click in each pair. There were six native creation events, six distinct
child document nonces and six unique business POSTs totaling **1,160 bytes**.

The test joins original source tab/frame IDs to native destination IDs, then
uses the existing explicit public claim and acts on that exact child. Original
server HTML, source/child document observations, trusted click records and
original request/response bytes remain in the artifacts. Foreign-owner access
is rejected in each case. All six children already inherited their source
task's native group before explicit claim; this is not first-time adoption of
unowned pages. In this run all six native `openerTabId` fields pointed to the
selected sentinel, while each webNavigation `sourceTabId` correctly identified
the actual background task source. The opener field therefore cannot replace
the original created-target event as the relationship evidence.

The continuous **3,454 ms** action interval recorded zero tab activations,
window-focus events or allowances. This excludes browser startup and teardown
and is not a whole-OS focus claim. Twelve exact fixture tabs are absent after
cleanup, and the original listener reports `hasListener=false`. Browser.close
returned its original acknowledgement, the browser child actually closed with
exit 0, and the native host also exited 0. The fixture uses the established
test Native Port adapter, not normal-user-profile installation.

Focused Node checks pass **16/16** with zero skip/cancellation. They include
real HTTP fixtures and binding a real occupied port; browser evidence supplies
the actual source relationship and trusted actions. Production host/extension/
SDK inputs are unchanged, the reused host matches its prior 61-input build
manifest, and the three published preview archives retain their checksums.
The ordinary 125-case browser suite was not rerun for this test-only slice.
The helper checks its original remaining action budget before and after each
operation. Existing `claimUserTab` still has a separate server-side timeout;
the client-side check is not proof of native cancellation or of the future
public waiter's end-to-end deadline contract.

## Preserved failures and environment correction

First run `8SGEVN` completed with actual exit 1: both cases failed with
`ERR_UNSAFE_PORT` before any fixture HTTP request or source click. The operating
system had assigned port 6697 to the HTTP server. Its empty server ledger and
normal browser close remain available; no business result from that run is
treated as successful.

The shared integration HTTP listener now reserves a loopback port directly in
the dynamic/private range 49152–65535. Binding retries are limited to sixteen
address-in-use or permission failures before browser startup. Other failures
propagate. This avoids the fixed restricted service ports in the
[pinned Chromium source](https://github.com/chromium/chromium/blob/f842f52ef39fd97b449eb27cff414bf05a98ddce/net/base/port_util.cc)
without disabling browser port policy. Additional field-trial or enterprise
restrictions can still reject a chosen endpoint. The initial listener test's
incorrect zero-listener assertion failed because Node installs its own HTTP
listening handler; the corrected test compares with a normal successful bind.

## Remaining work

Complete the unowned-child layout/focus matrix and extend overlapping/unrelated creation,
source/frame navigation, child movement/
closure, cancellation, deadline, pause and worker/host-loss browser cases beyond
the deterministic unit coverage. Ordinary window.open foreground
behavior, other browsers/platforms, drag guard recovery, and the complete
P01–P15 objective remain open. This successful provenance proof does not close
those requirements.

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
reconstructing authorization from child IDs. Real worker/host-loss acceptance
remains part of the open plan.

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

Complete unowned-child adoption and extend overlapping/unrelated creation,
source/frame navigation, child movement/
closure, cancellation, deadline, pause and worker/host-loss browser cases beyond
the deterministic unit coverage. Ordinary window.open foreground
behavior, other browsers/platforms, drag guard recovery, and the complete
P01–P15 objective remain open. This successful provenance proof does not close
those requirements.

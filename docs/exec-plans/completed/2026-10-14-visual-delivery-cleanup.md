# Visual delivery settlement and final hide

- Status: completed (slice only; broader parity goal remains active)
- Parent: [Browser Use parity](../active/2026-10-10-browser-use-parity.md), P12/P13.
- Baseline: `e52ab0c`, clean worktree and fork verified; previous goal turn is
  progress (implemented original iframe outlines, full 176/176, committed/pushed).

## Outcome

End, Pause and explicit control release must not report completed visual cleanup
while an original visible message can still arrive. A successor task must not
inherit old cursor, outline or ring publication. Preserve background operation,
original business actions and native input deadlines.

The previous [feedback slice](../completed/2026-10-14-iframe-target-feedback.md)
records an existing gap: a 250 ms display timeout does not cancel the actual
Chrome message, and deleting its queue does not await settlement. Same-turn
sequence protection and exact document routing do not establish same-document
cross-turn cancellation. No spontaneous Chrome reordering has been observed.

## Evidence and implementation sequence

1. Preserve original-production deterministic counterexamples before production
   edits. Audit native pointer feedback, manual cursor, visible/hidden state,
   injection, bootstrap and all release paths rather than fixing one sender.
2. Retain isolated real-browser evidence using controlled API-boundary delays.
   A gate before the original API invocation is not a native in-flight message;
   an after-ACK gate retains a real response but delays its delivery to the
   backend. Label both precisely and keep their original invocation/response,
   document, action and unique business POST. Neither proves spontaneous native
   transport reordering. Preserve old-source failure artifacts unchanged.
3. Implement the smallest lifecycle owner for actual visual promises and any
   producer still capable of dispatching. Revoke old publication synchronously,
   join original settlement, then hide only the original document and verify its
   actual response. A rejected send is not proof of hidden state; exact document
   destruction may supply distinct lifecycle evidence.
4. Cover Pause, end, explicit detach, action-failure cleanup, navigation/closure,
   successor ownership and actual failed/pending cleanup. Automatic action
   failure cannot wait for optional visual work and extend its original input
   deadline. Retain any visual barrier separately and enforce it before later
   visible feedback within its optional display budget; native attach/input do
   not await this barrier. Repeated cleanup must
   share pending work; retries may target only settled failed cleanup.
5. Run the affected Node groups, original visual browser regressions and full
   default browser suite against frozen source. Independently verify original
   messages, business state, visible state, scope/document identity, source/build
   identity, focus accounting and actual process termination. Update references,
   capability matrix, quality, history and this plan, then push the user fork.

## Constraints and limits

- No input replay, OS pointer/focus manipulation, new focus exemptions or daily
  browser profile. Only root launches isolated browser acceptance.
- Visual records confer no extra tab/detach permission. Hidden cleanup targets
  the original document and must not hide a successor task's feedback.
- Explicit cleanup can fail within its existing budget while original work
  remains tracked. A timeout is not actual cancellation or successful cleanup.
- Avoid an unrelated multi-epoch protocol. If worker replacement leaves a
  distinct unproved transport boundary, retain it explicitly and gather its
  native evidence instead of claiming the whole lifecycle is solved.
- Ordinary Edge manual authorization is deferred at the user's request; do not
  ask again in this slice. Existing preview archives remain unchanged. No PR or
  Pi-specific adapter. The complete parity goal remains active.

## Ownership

Engine collaborator owns the production delivery abstraction/backend and its
counterexamples after the preserved red gate. Fixture collaborator owns the new
isolated browser workflow and fixture tests. Independent auditor reviews the
contract and retained evidence. Root owns plan, runner integration, browser
launches, final documentation, commit and fork push.

## Retained counterexamples

Old production `e52ab0c` has eleven deterministic backend counterexamples
(`backend-red-v3`: actual exit 1, all eleven behavioral assertions fail, no
source drift). Real isolated controlled run `WuXaol` also closes with exit 1
and no drift. The original navigation and global Pause workflows pass; the
new lifecycle workflow records all three original transactions and cleanups.
End and detach return success before the held delivery settles, then the
original same-document cursor/outline become visible again; detach also shows
the delayed click ring. Pause reports cleanupComplete while the original
fulfilled API response is still held at the controlled delivery boundary.
Each original form submits once and all three exact tabs/targets are removed.
The first aggregate oracle reports the missing retained-promise registry;
independent raw observations establish the behavioral failures separately.
These controlled faults are not naturally observed Chrome transport reordering.

## Navigation boundary found during implementation

A task can publish feedback on a document and subsequently navigate. Requiring
a final hide response from every old document would make ordinary End fail
after navigation, including newTab's original blank document. Absence from
getAllFrames does not prove destruction, since BFCache documents are excluded.
The existing renderer hides on pagehide, but a later message could revive it.

The implementation therefore needs a private receiver token carried through the
existing PING handshake. Pagehide must revoke the original token synchronously,
hide its renderer, and report that exact token from the original native sender
document. Only a matching hide receipt, after original API work settles, can
replace the final direct hide acknowledgement. Restoration admits a new token
while remaining hidden; old publications and old cleanup cannot affect it.
This is scoped to visual receiver lifetime, not a new public control epoch.
Lost receipts remain unconfirmed. Navigation coverage is required before the
slice can be accepted; the same-document controlled red alone is insufficient.

## Implementation progress

The private delivery registry, receiver token retirement and explicit actual
cleanup barriers are implemented. Worker startup adds owned-document cleanup
without injection; an existing real restart workflow now checks the original
visible receiver becomes hidden before fresh control. A stale End admission is
validated before visual revocation; its retained failing regression now passes.

Real goto/back exposed pinned CRX dropping restored local-child contexts that
arrive before the BFCache root event. The adapter now validates a native frame
tree against original attachment/graph/loader identity, restores missing local
children and their still-live original context payloads, then requests native
lifecycle milestones. No Runtime restart, input replay or reload is used.
Two deterministic old-adapter failures and three actual locator-timeout runs
remain preserved. A fourth run passes the locator but exposes getAllFrames
omitting the restored child; native tree identity now supplies the independent
child oracle, while the exact root document remains the visual destination.

Focused `sCNVtX` 4/4 actual exit 0 has independent byte/pixel/message/focus/exit
verification. Related `ji5L4r` 20/21 retains a filter dependency failure: global
Pause leaves the shared client stale, and its existing explicit-resume
navigation case was omitted. The filter now includes that original case.
This focused stage preceded the final acceptance below.

Related `1ZP1zE` exposes a distinct unresolved cleanup timeout: the four original
counted-pointer workflows complete their business checks, but finalizeTabs
reaches its 20-second client deadline. A later global Pause also fails; downstream
cases are correctly blocked. This is not the earlier filter dependency failure.
The next run adds bounded passive visual message/native navigation recording
and read-only registry snapshots around that existing finalize call. Original
deadlines, input and cleanup responses remain unchanged. Do not accept the slice
or push a claimed-complete fix until this path is understood.

Diagnostic `IAiP48` reproduces the timeout and identifies exactly one pending
HIDDEN_STATE. Its original document/token already has an accepted native
pagehide receipt; all visible sends settled. Chromium retains the pure hide's
reply while the document is cached. The cleanup contract now distinguishes a
pure hide obligation from actual transport settlement: exact retirement/removal
may complete only that hide obligation, while the original Promise remains
retained and capacity-counted until settlement. Previously captured Pause
snapshots share the same evidence race, avoiding a stale-array deadlock. No
timeout or fake ACK is accepted; visible/PING/injection work still drains.
A deterministic failing regression is retained and the updated module/backend
31/31 pass. A separate retired PING reinjection counterexample is also fixed.
Related `gSCbYP` 22/22 actual exit 0 and Node v5 3599 pass / one existing
Windows symlink privilege skip complete with no source/runtime drift. Independent
raw-message/PNG/business/focus/process audit passes: 96,451 ms contains only the
original two auxiliary activations and two control-popup focus allowances.
Its counted navigation retires the receiver before any final hide is sent, so
it does not reproduce the delayed-hide ordering; the original `IAiP48` trace
and deterministic failing/passing regression retain that distinct race.
This related stage preceded the final acceptance below.

Full candidate `RNUG3p` completes with actual exit 1 (149/178), unchanged source,
and a new site-access worker-recovery failure. Its earlier counted navigation
does reproduce the retained-hide ordering successfully: final cleanup completes
using the exact pagehide receipt while the original hide Promise stays tracked;
after tab closure that original Promise rejects, without a fabricated ACK.

Site diagnostic `1RdokV` records three original fulfilled-undefined PINGs from
documents with other extension listeners. Current receivers now set an immutable
isolated-world marker before listener/renderer setup and retain it across
pagehide. Empty PING recovery reads only the exact original document's own
property descriptor; only one matching root result strictly proving absence is
accepted. Reads remain tracked through actual settlement, including rejection;
other bad replies and present/unknown markers remain failed cleanup. No receiver
files or visible authority are introduced. Legacy upgrade receivers remain
outside the claim. Old-source deterministic empty-reply failures are retained.

Focused `5nIvMm` passes 2/2 with actual exit 0 and no source drift. Passive
original Promise observations record three empty PINGs, matching actual absence
reads and one live receiver's exact hidden ACK. Pending is zero, no overflow,
observer restored. Full v2 later closes with actual exit 1, 177/178, no source
drift and no remaining exact isolated process. All site-access cases pass; its
only failure is the screenshot oracle described below.

Final review finds a receiver-state capacity gap: repeated rejected INJECT calls
can add unknown states to one owner without hitting the token-acceptance limit.
Two retained deterministic failures show both the 129th original dispatch and
incorrect rejection of the 128th already-reserved state when its token arrives.
Admission must reserve capacity before dispatch and distinguish existing members
from new states; unknown states and original Promise obligations must be kept.

Full v2 also retains a screenshot-fixture clock failure. Its actual SDK caller
receives the exact original worker timeout through `#handleMessage`, but worker
and Node wall timestamps differ by 1 ms. Neither SDK nor screenshot source
changed from the previous baseline. The oracle must use original reply identity
and origin instead of cross-process wall-clock order, retaining SDK-local-timeout
counterexamples and all original budgets. No timing tolerance is acceptable.
The corrected oracle checks the exact caller error and first original SDK reply
handler stack frame; a timer-first stack with a deeper handler is still rejected.
The SDK and all original budgets are unchanged. Capacity admission is fixed
before dispatch and the 128th reserved state can accept its token. Targeted
50/50 and Node v7 3615 pass / one existing Windows symlink skip pass without
source drift. Full v3 later passes as the intermediate baseline recorded below.

A final state-transition review finds a separate bootstrap self-merge gap:
observeBootstrap may already assign the pending injection's original state its
token. acceptToken then finds that same object and incorrectly deletes it as
though it were a duplicate. A deterministic retained failure proves loss of
the exact receiver's retirement identity before the next visible send. Only a
distinct duplicate state should be merged/deleted. Do not attribute this pending
correction to full v3 or accept the slice before it is verified.

The same review identifies failed recovery preparation surviving an exact
tabRemoved event. Two retained counterexamples cover already-rejected and still
pending inspection. The correction must join actual pending work first, allow
only exact removal to waive the now-irrelevant inspection failure, and remove
only the original backend recovery item after successful cleanup. A replaced
item or another tab must remain intact. Stale inventory whose removal event
predates recovery registration remains a conservative failure boundary; this
slice does not invent destruction from a lookup error or empty inventory.

Both final state corrections are implemented. Three module counterexamples
cover self-merge retirement identity and settled/pending removed-tab recovery;
the backend metadata counterexample separately fails before its correction.
Two backend tests retain the original pending read and protect replacement and
foreign recovery items. All 147 affected checks pass. Full v3 `RjTx3p` had
already passed 178/178 with actual exit 0 and no source drift before these last
corrections; independent visual/frame/core/counting and screenshot reviews pass,
including 533,944 ms with only the original 12 activation / 4 control-focus
allowances and exact process absence. It is an intermediate baseline, not
evidence for the later state corrections. Final frozen-source validation is recorded below.

## Final acceptance

Final frozen-source run `HZSmT4` passes 178/178 with actual exit 0 and no
source/runtime drift; the original 176 cases retain their names and order.
Independent checks verify the controlled three POSTs / 7,080 bytes, six original
documents and six PNGs, original token-bound hidden ACKs, native BFCache local
frame identity, worker recovery, and original iframe feedback across six layouts.
The latter retains six POSTs / 14,185 bytes and thirteen original documents.
The focus interval is 527,274 ms with only the existing 12 activation / four
control-popup focus allowances and no event inside controlled visual scenes.
Original host exit and exact isolated-process absence are confirmed.

Final Node v8 passes 3620 checks with one existing Windows file-symlink privilege
skip. Original screenshot reply provenance, five screenshot scenarios and seven
native PNGs are independently checked. Capacity, bootstrap self-merge and
registered-tab removal counterexamples pass without deleting original pending
work. Old candidate failures and preview ZIP hashes remain retained.
This full run has no calls in the explicit recovery observer interval; the separate focused 5nIvMm trace supplies the three actual empty-PING/absence-read proofs.
Counted navigation also reproduces cleanup completion while the original pure-hide Promise stays tracked.

Ordinary Edge remains deferred. Arbitrary cross-worker transport, legacy upgrade
receivers, removal before recovery registration, OOPIF BFCache, raw leaf feedback,
fullscreen and the broader parity goal remain open. This slice does not complete
the capability matrix and does not change existing preview packages.

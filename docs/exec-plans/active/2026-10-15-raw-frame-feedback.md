# Raw coordinate feedback inside frames

Status: active. Parent: [Browser Use parity](2026-10-10-browser-use-parity.md).

## Goal and scope

Show the leaf element beneath a public coordinate mouse action inside same-origin,
cross-origin, nested, dynamically created and transformed frames. Preserve the
original input, background operation and existing locator feedback. Raw input has
no locator-selected element: its outline is a read-only hit-test snapshot, not proof
of the element that received an earlier input event.

## Constraints and risks

- No input replay, additional focus permission, OS input, daily browser profile or
  manual Edge authorization. No PR; push completed work to the existing fork.
- Optional reads must not delay input or block position/click-ring delivery. Retain
  actual pending operations through End, Pause and detach; late results cannot
  publish into another document, frame route, attachment, scope or sequence.
- Root-only hit testing finds an iframe rather than its cross-process descendant.
  Native integer hit tests and frame-local coordinates must not be mistaken for
  exact fractional root coordinates. Reuse verified frame projection where possible.
- Unknown or invalid geometry must not claim an ancestor as the intended leaf.
  Caller-supplied CDP metadata cannot grant visual authority.

## Plan and validation

1. Preserve actual current-source failures using the existing six-layout original
   form/PNG oracle with JS mouse and public CDP input, independently authored input
   points, exact documents and original trusted POSTs.
2. Implement bounded passive leaf discovery and projection with original ownership
   checks; deterministic tests cover stale routes, native failures, capacity and
   pending cleanup. Do not treat a fake native response as real browser proof.
3. Run the focused real-browser workflow and affected regressions; independently
   review original PNG/native/business records, focus observations and process exit.
4. Update capability boundaries/history and push only after appropriate validation.

## Progress

- [x] Confirmed current raw feedback uses only root-document hit testing.
- [x] Actual old-source failure captured: `R1aiOp`, actual exit 1, unchanged
  sources. Both coordinate modes completed all six original submissions and
  native checks; all twelve outlines selected ancestor frames. No activation or
  focus event occurred in the 13,643 ms observation. Original cleanup completed.
- [x] Warm and cold production routes, durable private ownership and bounded
  latest-position scheduling implemented; deterministic checks pass.
- [x] Six-layout cold visual/input/resource workflow passes on final source,
  with independent review of original evidence (`JVWwm9`).
- [x] Real worker/fault recovery and final default regression independently
  reviewed and delivered for this integration increment.
- [ ] World/context cardinality, navigation/document replacement and broader
  native-event coexistence verified.
- [x] Documentation and fork delivery prepared for the validated integration
  increment; the broader lifecycle plan remains active.

Fullscreen remains a separate unverified candidate. Its active-tab requirement
must not be bypassed or turned into a new focus exemption for this work.

### Warm increment

- Initial frozen run `QOGMzJ` passes 3/3, including the mandatory raw navigation
  case. Independent verification covers twelve original leaf PNGs/POSTs,
  65 actual original-route object release ACKs, 26 document observations and
  End hidden after 572/578 ms. Its 14,795 ms focus interval has no events or
  allowances. This normal run alone does not prove failure-path deadlines.
- Independent allocation/release stalls reproduced the new optional cleanup
  extending an original 30 ms input request beyond 100 ms and replacing its
  immediate native error. Two-phase caller/full cleanup now preserves original
  errors and required key release, while full cleanup fences successor control.
  A preceding diagnostic cleanup failure retains the fence until explicit
  recovery, including while original optional work remains pending.
- Final deterministic groups: 3666 pass, one existing Windows symlink privilege
  skip; actual process exits are 0 and captured source/runtime hashes unchanged.
- Final default regression `xS4ddv` passes 180/180, actual exit 0, unchanged
  source/runtime hashes, and the old 178 case names/order retained. Independent
  audits verify eighteen original PNGs/POSTs (42,559 bytes), 65 original raw
  object release ACKs and 39 unchanged document observations. End stays hidden
  after 569/568/567 ms; original tabs/targets are removed. Its 533,948 ms focus
  interval retains only the original twelve activation/four control-popup
  focus allowances. Original keyboard/pointer/drag and screenshot records pass.
- This warm increment was delivered to the fork as `20b0014`. The cold implementation,
  its broader layout/lifecycle verification and therefore the overall plan
  remain unfinished; the cold failure is outside the passing default count.

## Decisions and retained failures

- `VZh8hm` preserves the first twelve original PNGs and POSTs. Its JS mouse
  native oracle incorrectly required a down ACK before invoking up. The pinned
  zero-delay raw Mouse.click invokes move/down/up and then joins Promise.all;
  public direct CDP and guarded locator clicks retain their sequential contracts.
  The corrected oracle still requires ordered original invocations and exactly
  one successful ACK after each invocation. It does not change production input.
- The existing Page can supply shared fractional hit testing and verified frame
  projection. A cold raw-CDP attachment must remain separately covered: creating
  a Playwright Page during optional feedback would migrate the attachment, enable
  extra protocol domains and reject previously usable raw incognito tabs. Do not
  use that shortcut. Warm-page support does not complete this plan; cold routing,
  remote-object cleanup and real-browser evidence remain required.

## Cold design: separate native reader in development

The warm Page reader and its caller-deadline repair are a deliverable increment.
Cold public `executeCdp` remains required by this active plan. The recorded cold
run `uGRF8J` exits 1 without source drift; its same-process, OOPIF and nested
submissions still outline ancestors. It is not evidence for a working cold reader.
Preserve raw attach behavior, including its current incognito allowance. Optional
feedback must not create a Playwright Page, migrate/re-attach the root debugger,
enable auto-attach, or revive a retired scope.

### Rejected shortcut and native facts

- Do not use `DOM.getDocument` as an invisible bootstrap. It implicitly enables
  DOM events. A compensating `DOM.disable` could disable the caller's own state.
  `DOM.describeNode` accepts a native object/backend ID without enabling DOM;
  `DOM.resolveNode` accepts an explicit context and object group. The integer
  coordinates of `DOM.getNodeForLocation` do not prove a fractional hit. See the
  [official DOM protocol](https://raw.githubusercontent.com/ChromeDevTools/devtools-protocol/master/pdl/domains/DOM.pdl).
- A fixed `Runtime.callFunctionOn` declaration in the default world still uses
  page-controlled DOM prototypes/getters. A pure replacement can return the wrong
  node even with `throwOnSideEffect`; it is not trustworthy leaf evidence. The
  candidate must use a separately established isolated realm and fixed code,
  with no user gesture or asynchronous page promise.
- The test binary's file metadata identifies Chromium `156.0.8078.4`; no browser
  was launched for this design audit. In its
  [Page agent](https://github.com/chromium/chromium/blob/156.0.8078.4/third_party/blink/renderer/core/inspector/inspector_page_agent.cc#L746),
  `getFrameTree` does not enable Page and only recurses into local frames; remote
  children may be absent. `createIsolatedWorld` works for a committed local frame
  without enabling Page, but rejects a provisional frame when Page is disabled.
  Reject that read rather than enabling a domain to rescue it.
- A fixed world name really is reused among live inspector worlds by
  [DOMWrapperWorld](https://github.com/chromium/chromium/blob/156.0.8078.4/third_party/blink/renderer/platform/bindings/dom_wrapper_world.cc#L102).
  This is not a private namespace per CDP session. Use one reserved stable name,
  never a new name per point; the name alone grants no document or session
  authority. Each frame caches its world proxy, and navigation/close/swap clear
  contexts through
  [WindowProxyManager](https://github.com/chromium/chromium/blob/156.0.8078.4/third_party/blink/renderer/bindings/core/v8/window_proxy_manager.cc#L19).
  There is no CDP destroy-isolated-world pair. Group release and temporary-session
  detach must not be described as world destruction. Reuse, frame replacement,
  BFCache and repeated debugger attachments still need native lifecycle evidence.

### Smallest candidate interface

Keep a backend-owned adapter with the same passive contract as the warm reader:
`captureNativeRawRead({ rootTarget, attachment, authority, x, y })` returns
`{ check, read, cleanup, decode }`. Capture the original request scope and reserve
capacity synchronously; `read` must remain outside the input/click-ring wait.
Do not require a Page, load the runtime, or call `withPage`/`attach`.

The candidate sequence is a native frame-tree snapshot, one named isolated world
for the exact committed local frame, a fractional fixed hit test, native node
description/box model, and shared frame-plane projection. Record original frame
and parent IDs, loader, native document/root-node evidence, realm, root attachment
and each exact session route. Check these after every await and before publishing.
Frame URLs, array position and numeric context IDs alone are insufficient.
`document.open`, document-element replacement, context-ID reuse and BFCache must
have an explicit identity strategy before this sequence is accepted.

Same-process descent keeps the native session while selecting the child's
isolated context. For a remote child, the parent's native iframe description and
`DOM.getFrameOwner` must agree on the same backend node. The original explicit
`Target.attachToTarget` proposal was rejected by the native audit below. The
candidate instead obtains an independent debugger client for that exact target,
then requires its child `Page.getFrameTree` to prove the frame and original parent.
Frame/target identity comes from native replies, never a URL. Nested routes retain
their original parent chain. No borrowed caller client may be detached.

This needs a private target registry and an adapter to the existing lifecycle.
Independent target events must not enter public child ownership, invalidate an
unrelated root document, arm unrelated observers or reach the CRX public route.
The adapter must preserve caller auto-attach events for the same frame, root
domain subscriptions and the caller's `Target.setAutoAttach` configuration.
This event integration remains unimplemented and requires native verification.

### Native permission gate and alternative under investigation

The pinned Chromium 156 source rules out the proposed `Target.attachToTarget`
route for this ordinary unpacked extension. The debugger client's
[trust predicate](https://github.com/chromium/chromium/blob/156.0.8078.4/chrome/browser/extensions/api/debugger/debugger_api.cc#L259)
is specific to the Perfetto extension. An untrusted renderer client gets
[auto-attach-only Target access](https://github.com/chromium/chromium/blob/156.0.8078.4/content/browser/devtools/render_frame_devtools_agent_host.cc#L422),
and [explicit attachment returns Not allowed](https://github.com/chromium/chromium/blob/156.0.8078.4/content/browser/devtools/protocol/target_handler.cc#L1119).
The new opt-in native diagnostic must preserve that actual reply; doubles alone
cannot validate the route.

An independent `chrome.debugger.attach({targetId})` is a different native API.
The diagnostic may try it only for the exact OOPIF ID obtained from the original
parent node, while retaining the original root attachment. This is not yet a
production design: the independent client outlives root detach, has no opaque
connection token in its void attach ACK, and may survive worker replacement.
Only a successful attach owns its cleanup; an Already attached error cannot
grant a borrowed client. Pending/failed cleanup must fence that exact target,
and a stale target-only detach event cannot prove a successor's destruction.
Existing tab-claim recovery intentionally does not sweep unknown target clients.
Private-client recovery needs a separate same-browser ledger before integration.

Frozen native diagnostic `KXt3Td` now confirms this distinction: the original
`Target.attachToTarget` returns `Not allowed`; independent exact-target attach,
child frame/parent verification and actual detach succeed while the raw root
attachment remains unchanged. Its 85 native calls all settle, 23 tracked handles
and six groups are released, and normal/exception handles in three proof groups
become uncallable after the original group ACK. Four document-element native
frame IDs and repeated named-world context reuse are observed. The diagnostic
and mandatory old raw-navigation case pass (actual exit 0, no source drift).
The 745 ms ready-to-end focus interval has no events or allowances; exact test
processes exit. Independent review also confirms the moved geometry factory and
staged vendor are unchanged from the warm increment. This diagnostic has no
preflight, recovery, auto-attach coexistence or production lease proof.

The new `browser-native-pointer-feedback.js` implements a separately testable
reader; it is not yet wired into the backend or copied into production packages.
A retained deterministic counterexample shows that the first fixed-world reader
can select another real node after hit-testing methods change. Native frame ID
and box containment do not reject that case. The current candidate uses a
module-stable random realm identity and an immutable closure over the original
DOM methods/getters. Both retained poisoning cases now preserve the original
leaf; all 38 reader tests pass. Arbitrary JavaScript-intrinsic tampering is outside
this proof, and worker replacement may create another named world.
A privileged raw-CDP caller racing the first bootstrap has equivalent debugger
authority; do not claim this closure is an isolation boundary against it or
silently change the public CDP admission contract to pretend otherwise.

The diagnostic reads stable named worlds, captures original Document and root
handles, and checks the root element's native frame ID. Chromium's
[DOM inspector supplies this frame ID for a document element](https://github.com/chromium/chromium/blob/156.0.8078.4/third_party/blink/renderer/core/inspector/inspector_dom_agent.cc#L2387).
Numeric context IDs and URLs cannot substitute for it. A fixed wrapper retains
both Document and documentElement: `document.open` may keep the former while
replacing the latter. Missing native evidence rejects feedback.

Each read owns a unique object group per original native session, and tracks
actual allocation replies, including exceptions, before checking revoked visual
authority. Drain actual sends, release only those groups, then detach only owned
temporary sessions using original native ACKs. A late allocation cannot occur
after an already-declared final group release. Failed group/session release stays
observable and blocks replacement until explicit retry or exact native destruction
proof. The [Runtime protocol](https://raw.githubusercontent.com/ChromeDevTools/devtools-protocol/master/pdl/js_protocol.pdl)
allows grouped resolution/call results; validate exceptional-object membership and
per-session group behavior rather than assuming every handle is covered. Reuse
the two-phase caller/full barrier: required input cleanup gates the input result,
while optional resources still gate final detach and successors.

### Candidate verification and integration boundary

The original reader run `6Yz3DZ` is retained with actual exit 1 and no source drift:
same-process geometry passes, while five remote layouts stop before attach with
native `No target`. Native `getTargets` must first materialize the exact target;
the subsequent original no-client query still has to return the exact
`Debugger is not attached` error. URL, `attached` flags and `No target` cannot grant
new read admission.

Frozen `5pTnPP` then passes six native rectangles and the mandatory old raw
navigation case (actual runner exit 0, unchanged sources/runtimes). Independent
authored CSS and original owner/leaf quads agree for same-process, OOPIF, dynamic,
nested, scaled and rotated frames. Its 198 original native calls settle; 39 opaque
objects belong to 12 groups with actual release ACKs, and six independent targets
have exact discovery/no-client/attach/detach chains. Thirteen original document
and business snapshots remain unchanged. Only the dynamic fixture's original
Add click occurs; there is no leaf input, form POST or cold visual PNG proof.
The 1,479 ms focus interval has zero events/allowances. The host has original
exit 0 and exact processes are absent; this mode retains no separate Chrome exit
receipt. The registry source captured in this run was not imported by the probe.

`browser-private-targets.js` separately passes 27 deterministic cases. Its trusted
fresh witness names the original browser incarnation, durable intent precedes
actual attach, and exact targets stay fenced through actual work and failed
cleanup. Missing/unknown ledgers do not authorize sweeping clients. An original
owned client can retire only its cleanup obligations after actual sends drain and
a new exact native query proves absence; the outcome records that evidence, not
invented group/detach ACKs. After group-first cleanup failure, explicitly retry
the registry before retrying `PassivePointerReads`; ordinary cleanup never replays
the failed attempt. Real worker recovery and event coexistence remain unverified.

All three current deterministic Node groups close with actual exit 0: 3744 pass,
one existing Windows symlink privilege skip, no source/runtime drift. The shared
geometry factory and generated vendor bytes match the delivered warm version.
These checks do not replace production integration or the original six-layout
visual/POST workflow. Existing preview packages remain unchanged.

### Evidence required before choosing this adapter

- No-Page cold same-process, dynamic OOPIF, nested and transformed fixtures must
  prove original trusted input/POSTs, native leaf PNGs, original frame/document
  identity, unchanged raw attach semantics, and no added activation/focus.
- Repeated points must show stable world/context cardinality in unchanged
  documents. Native navigation, `document.open`, BFCache, frame removal and
  debugger re-attachment must reject obsolete identities without creating worlds
  per read. Source inspection above is not that runtime proof.
- Held attach/evaluate/group-release/detach ACKs and explicit failed-cleanup
  retries must retain real pending work, keep caller deadlines and original
  errors, reject successor raw admission, and never replay input or release a
  borrowed session. Native events must prove root domain subscriptions and
  unrelated observers were preserved.
- Prototype poisoning in the page world, same-name realm collision, swapped
  parent routes, and colliding auto-attach events must either remain correct or
  reject feedback. Unknown geometry cannot be reported as an ancestor leaf.

These unresolved identity/event/lifetime requirements remain separate acceptance
boundaries. Passing the warm reader does not close the cold boundary or the
parent Browser Use goal.

### Production integration

The native route and durable store now connect to the production backend and
build. A real install/update witness initializes only a never-initialized store;
known same-browser records recover cleanup only. Optional unknown state preserves
ordinary input. Global drains join actual private work, explicit recovery resets
only settled failures, and stored numeric tab IDs never authorize root detach.

A retained deterministic red case found that public claim could install a cold
reset gate while an old-token allocation still needed exact-root cleanup. The
shared pointer admission guard now runs before that gate and during its identity
checks. The identical regression passes after the fix. A production backend
suite also covers original input errors/deadlines and tokenless detach retry.

Verification next: the original six-layout cold PNG/POST workflow, followed by
held group delivery, rejected detach delivery and real worker replacement. The
last scenario must preserve unresolved input-risk blocking. These are separate
from native failure claims; controlled ACK delivery remains explicitly labeled.
No input replay, engine-state reset or new focus allowance is permitted.

The first integrated run `HruAYH` is retained with actual exit 1 and no source
drift. Six original trusted submissions total 17,463 bytes; all original business
checks pass. Three layouts show the correct outline, while same-process, OOPIF
and nested hover have no rectangle. Earlier optional reads occupy both candidate
slots, so the latest hover never starts its native read. This requires bounded
latest-position scheduling, not input replay or a test-side delay. End remains
hidden for 566 ms across 13 original documents; no focus/activation events or
allowances occur.

The initial resource oracle also incorrectly treated the existing root
navigation's fixed by-value readiness read as a private allocation. The corrected
oracle accepts only that exact command, original navigation interval and a
handle-free value reply. Offline rechecking the six original traces passes the
native checks; the original run remains failed and its three missing outlines
are unchanged. A new browser run is required after the scheduler fix.

Cold-only latest scheduling then passes real run `21NiBa`: all six original
layouts now show their leaf outlines, with original PNGs and submissions. The
original mandatory navigation case also passes. This is not yet the final full
regression: independent review found a mixed cold/warm queue wake-up seam that
must be fixed without changing warm read admission.

The first native lifecycle run `Vaod2E` retains actual exit 1. Held group delivery
and rejected detach delivery both complete their explicit original public retry
and durable cleanup. Worker-owned intent also cleans correctly, but the test
incorrectly requires an input-risk pause after only an acknowledged mouse move.
The actual input tracker has already cleared that risk, so explicit beginTurn
succeeds. Preserve this record; add a real held-button precondition and original
durable-risk evidence before asserting recovery remains blocked. Do not change
the production pause rules to satisfy an invalid test assumption.

The next lifecycle run `mjZpUm` also retains actual exit 1, before worker restart.
Its actual risk mark call 7 / ACK 10 precedes the original down call 11 / ACK 14;
the stored risk and held-left tracker agree. The oracle incorrectly compared
JSON property order across storage write/read. Exact deep structural comparison
repairs both risk and recovered-intent checks without relaxing fields, unique
write counts or native ACK order. Two retained old-source regressions fail;
the final fixture passes 18/18 deterministic checks.

Final mixed-scheduler run `JVWwm9` passes 2/2, actual exit 0, without source/runtime
drift. Independent original-record review verifies six PNGs and six POSTs,
48 trusted business events, 13 original documents, 1,073 native calls, 183 opaque
handles, 56 released groups and 27 independent attach/detach pairs. The six roots
each attach once without engine creation/migration. End remains hidden after
568 ms; the 8,009 ms focus ledger has zero events/allowances. Host and runner
exit 0 and exact test processes are absent, without a separate Chrome exit receipt.

All three final Node groups close with actual exit 0: extension 1,793, scripts
330 and integration 1,714 pass, with one existing Windows symlink privilege skip
(3,837 total passing tests after the response-body close observation repair).
There is no source/runtime drift. Existing Go inputs and binaries were hash-checked
and reused; this is not a new Go build or an ordinary-install acceptance.

Default regression `6L9esM` retains actual exit 1: 179/180 pass, with the sole
failure in MCP response-body cleanup. All twelve original body reads across
three layouts match their native response ACKs and server bytes. Immediately
after three single public `Page.close` calls, the last dynamic tab remains in
`tabs.query`, while its target inventory is empty. The old fixture restored its
native probe before close, so it has no close-ACK/removal-event timing evidence;
do not infer final tab absence or the exact failure timing from this record.

The pinned [Chromium 156 implementation](https://github.com/chromium/chromium/blob/156.0.8078.4/content/browser/devtools/protocol/page_handler.cc#L715)
dispatches before-unload and returns success without awaiting tab removal.
The fixture must observe bounded completion after the original single close,
recording exact native close ACKs, removal events and both tab/target absence.
It must not repeat close, swallow query errors, extend body-read deadlines or
turn the old failed run into a pass. This cleanup-observation repair is separate
from the cold production route.

### Final integrated acceptance

The repaired fixture passes 58 deterministic checks and real `SN2lmN` 7/7,
actual exit 0. Independent review joins 60 original body reads and 15 original
close/ACK/removal triples; all six entry cleanups finish at their first observed
inventory. This is not a new native reproduction of the old timing gap.

Final default run `ZXPe7X` passes 180/180, actual exit 0 with no source/runtime
drift. Its case names/order exactly match `xS4ddv`. Independent review verifies
18 original frame PNGs/POSTs (42,559 bytes), 65 raw-object release ACKs,
33 input scenes with 179 Input calls/212 native calls and 26 original POSTs
(180,342 bytes), nine End sequences, eleven drag guard cleanups, five screenshot
drain/deadline scenes and seven independently decoded screenshot PNGs. Original
retirement and late rejected hide delivery remain distinct from a hide ACK.
The 574,481 ms formal focus ledger retains only the original twelve activation
and four control-popup allowances, matched by exact target and interval.
The first host is intentionally terminated by its original restart test; the
second exits 0. All original connections close and exact test processes are absent.

Final Node groups pass 3,837 tests with one existing Windows privilege skip.
The cold and lifecycle runs retain their original source snapshots: only the two
response-body fixture files changed afterwards. Production bytes, pinned runtimes
and hash-verified reused Go binaries match across these runs. Existing preview
archives remain unchanged. No PR, input replay, system mouse action or new focus
allowance was introduced. World/context cardinality, navigation/document
replacement, native-event coexistence, ordinary Edge and the parent matrix remain
open; this increment does not complete the broader plan or goal.

### Worker lifetime follow-up

The integration increment was packaged and published as Windows preview
`preview-20261015-8f090f2`; the uploaded artifacts were downloaded and verified.
This delivery does not close the remaining lifecycle acceptance above.

The next concrete candidate is isolated-world growth across service-worker
replacement. The current module generates a new world name and immutable kernel
identity on every import. Named worlds are reused within one module lifetime,
but releaseObjectGroup and independent-client detach do not destroy a live
document's world. Repeated worker replacement can therefore leave older worlds
behind while new reads choose new names. Source inspection identifies the risk;
an unchanged-production native reproduction must establish its actual behavior.

1. Keep one original document alive through repeated public cold-coordinate
   actions and two real worker replacements. Record native world/context IDs,
   document identity, actual input and existing caller Runtime events. Preserve
   the old-source result, original process outcome and unchanged focus rules.
2. If confirmed, persist one private reader identity independently of resource
   ownership. Reuse it only after actual storage confirmation, fail optional
   reads closed on unknown/corrupt/changed identity, and retain all existing
   root/private-client cleanup and input-risk rules. Identity must never grant
   debugger attachment or document authority.
3. Verify the same original scenario after the fix, then exercise original
   frame geometry, cleanup and worker-recovery regressions. Navigation,
   document replacement and broader native-event coexistence remain explicit
   acceptance items until their own original native evidence is available.

Old-production run `7OWtNq` retains actual exit 1 without source drift. The original
root document survives three real worker generations; native Runtime enumeration
shows one, two, then three passive worlds, with the same original default-context
unique ID. Three original PNGs, one trusted submission, 554 ms of End hiding and
empty exact tab/target cleanup are retained. Its first failing assertion is an
oracle mistake: the new worker's explicit claim first probes the original root
and receives the expected not-attached native error before attaching. The oracle
must recognize only that exact recovery probe; it must not waive native feedback
failures or turn the retained run into a pass. A new old-production run will then
reach the separate world-cardinality assertion before production changes begin.

The candidate identity module uses one IndexedDB upgrade transaction to create
both schema and random seed. Later workers read the same record and never repair
missing/corrupt rows. Capture remains unavailable through request success until
the verification transaction completes. Version change or abnormal connection
close revokes future reads, without revoking original resource-cleanup leases.
An explicit kernel ABI covers the captured DOM/geometry closure: each persisted
identity and ABI uses one named world per live frame. Entire-database deletion
by a privileged peer is outside the persistence guarantee. The 23 deterministic
IndexedDB tests are component evidence, not native worker-death acceptance.

Old-production rerun `EuhlIy` reaches the intended cardinality failure (`2 !== 1`)
with actual exit 1 and no source/runtime drift. Independent review confirms
native worlds 1/2/3 on the unchanged root document/default context, 203 settled
native calls, 11 released groups, three original screenshots and one trusted
submission. End remains hidden for 555 ms; exact tabs/targets and processes are
absent. The continuous 6,380 ms focus ledger has zero events and zero allowances.
The v2 oracle permits only the exact not-attached probe before a new worker's
explicit claim; both old failed runs remain unchanged. This evidence, completed
in the preceding goal turn, authorizes wiring the persistent identity candidate.

The identity is now wired into the backend, route, reader and production build.
It is not awaited by input or control startup. Realm revocation is composed only
with the original read/publication check; root-group and private-client cleanup
retain their original leases. The captured closure has explicit ABI `1`.
Independent review finds no blocker and checks late private attach/allocation
after an actual fake-IDB close: original input completes, groups and private
detach wait for their actual replies, and the root stays attached.

Fixed run `e6vgkl` passes 2/2, actual exit 0 without source/runtime drift.
Independent native-record review verifies worlds 1/1/1 with the same world name,
context ID and unique ID across three workers, while original root/default
context/document/loader remain unchanged. All 205 native calls settle; eleven
groups cover 33 original handles. Thirteen Input calls, three original PNGs and
one 2,454-byte trusted POST match original native/server evidence. End stays hidden
559 ms, exact inventories/processes are empty, host exits 0 and all connections
close. The continuous 6,689 ms focus ledger has zero events and zero allowances.
The new fixture adds only bounded optional-realm readiness observation before
each generation's inputs; each succeeds on its first read. This is not a raw
IndexedDB event transcript or a production input wait.

Node groups pass 3,881 tests with one existing Windows symlink privilege skip
(extension 1,824, scripts 330, integration 1,727). Their processes actually exit
0 and source/runtime/dependency hashes remain unchanged. Cold six-layout
`4UhUBJ` and private lifecycle `fCGIFC` both pass 2/2, actual exit 0. Independent
review verifies six native PNGs, six original POSTs (17,463 bytes), thirteen
documents, 983 calls/45 Input calls, 51 group-release ACKs covering 165 handles
and 25 exact child attach/detach pairs. End remains hidden for 581 ms. Lifecycle
review verifies all original 126 calls, durable risk ACK before the single down,
no replacement Input/attach/root detach, rejected old begin/finalize and risk
clearance only after the original tab closes. Focus intervals of 7,104/3,944 ms
have zero events or new allowances; hosts/runners exit 0 and exact processes are
absent. Source/build/runtime identities match across both runs.

Final default run `SfCCYW` passes 180/180, actual exit 0 and no source/runtime
drift. Its original case names and order exactly match `ZXPe7X`. Independent
review verifies 54 production files shared with the world/cold/lifecycle runs,
18 original frame PNGs and submissions (42,559 bytes), 65 original object-release
ACKs, 33 input scenes with 179 Input/212 native calls and 26 POSTs (179,931 bytes),
seven screenshot PNGs, 60 response-body reads and fifteen close/removed pairs.
The 540,693 ms formal focus interval has only the original twelve activation and
four control-popup allowances, matched to exact target, sequence and interval.
The original host-restart test intentionally terminates generation one; generation
two exits 0, all seven connections close and exact test processes are absent.
Node inputs additionally pin package/lock and all 120 fake-IDB package files;
browser inputs and 15 reused Go binaries remain hash-matched. This does not claim
a new Go build, ordinary-install Edge acceptance or full capability parity.

The next independent native boundary is same-document root replacement after a
cold read. Existing immutable-kernel code reacquires Document/root on each
capture and rejects an old wrapper when its root changes; deterministic tests
cover rejection during a read. Existing real DOM-rebuild acceptance uses warm
locators, so it does not prove the next cold read sees the new original node.
Reuse the same realm/default context/loader, let one trusted application click
replace documentElement, then move to a new button with different position and
size. Preserve native node identity, old-node disconnection, two PNGs, one trusted
submission, End, original group cleanup and the unchanged focus ledger. First
establish actual behavior; do not label this a production defect in advance.
Full navigation, BFCache and replacing an already-read OOPIF are separate later
boundaries, not covered by compatible worker reuse on an unchanged root.

### Same-document root replacement acceptance

The preceding goal turn completed and pushed `dc95b36`, including the actual
old/fixed native records and final default regression; it is progress, not a
wait or completion of the broader goal. The worktree was clean when beginning
this boundary. Production is kept at that verified source while the original
behavior is established.

The new isolated `OBU_TEST_COLD_ROOT_REBUILD=1` mode retains the existing raw
navigation precondition and shared passive native observer. The application
performs one documentElement replacement in response to a single trusted raw
click. The replacement button has different geometry. Independent default-context
node reads use clearly named fixture object groups and original release ACKs;
they are observations, not production authority, and add observable round trips.
Production hit/root IDs must agree with these original nodes. Visual waits and
pixel assertions cannot skip screenshots, the single business submission or End
cleanup on failure. Existing focus rules, native input sequence and time budgets
remain intact. This first run is an acceptance investigation, not a presumed bug.

Independent fixture review found the shared End helper rejected a missing initial
layer before sending End. The new mode therefore defers that visibility failure,
waits for the original End acknowledgement and attempts hidden-state observation,
then preserves the original failure. An initial document-read failure also sends
End once while retaining its original error; secondary End/hide errors remain
diagnostic evidence. The adapter saves this evidence even when the helper throws.
Default-mode ordering is unchanged. Eight independent VM checks of the actual
helper/adapter pass, including held ACKs and double failures; their simulated
clock is not native hidden-duration evidence. Three invalid new-mode invocations
also exit before runner setup, with their expected configuration errors.

First native run `R58uno` retains actual exit 1. Both original PNGs, changed
root/button identities and the single trusted submission pass independent
review, but the oracle incorrectly requires every detach to succeed. The first
End detach succeeds; five later finalization detach calls return the exact
same-tab not-attached error. Their original errors remain in the record.
Only this proven post-End absence may be classified separately, with prior
successful detach, no pending resources or later attachment/input, and empty
final inventories; other failed calls must still fail acceptance.

The actual End helper now has ten tracked deterministic regression checks.
They additionally preserve the original visibility failure when End itself
rejects and retain that secondary error as evidence. Healthy-state End errors
remain failures. These checks use simulated native promises and clocks, not
browser timing evidence. No production code has changed in this increment.

The exact absence classifier additionally requires the original End request and
acknowledgement plus matching helper evidence. Eleven fixture checks pass;
the first-failure and missing-ACK regression failures remain separate records.
Fresh native `0l1om9` passes 2/2, actual exit 0; related `fi8VZ5` passes 22/22,
actual exit 0. Both close records have no source/runtime drift. The three Node
groups pass 3,902 tests with one existing Windows symlink-privilege skip
(1,824 extension, 330 scripts, 1,748 integration). Original v1 remains failed.

Independent `0l1om9` review joins all 175 native calls: 170 successful ACKs and
five preserved exact absence rejections. Twelve groups/33 handles release
before the original successful detach; twelve original inputs, two native PNGs,
one 4,520-byte POST and eleven trusted events match. End remains hidden 556 ms;
the 4,453 ms focus interval has zero events/allowances. Host exit, both connection
closures and exact original process absence are observed; the concurrently
running related suite is excluded from that process claim. All 54 production
files match `SfCCYW`; this increment does not require another full 180-case run.

Final related-suite review confirms the same 22 names/order as the prior full
run's original selection. Six original frame PNGs/POSTs (14,185 bytes), thirteen
End documents and selected input/visual workflows pass. Its 94,055 ms focus
interval preserves only the original two popup activations/two Pause-control
focus allowances, matched to exact targets and intervals. The intentional host
restart retains generation one's termination; generation two exits 0, all four
connections close and exact processes are absent. No additional cases or focus
exceptions were introduced. Documentation and repository checks pass; this
closes the root-replacement acceptance increment, not the active parity goal.

The next independent boundary is a cold read followed by one same-tab,
same-origin full A-to-B navigation. Existing cold-layout tests navigate only
before the first read; existing visual-navigation tests already use the warm
engine. Production has document-revision invalidation, final loader/node checks
and exact-document visual delivery, but these are not native acceptance of this
transition. Require a new native Document, loader and context unique ID, the
same world name and one world for B, different B geometry, two original PNGs,
one B submission, resource release and unchanged focus rules. Do not require
numeric context or frame IDs to change. Establish behavior before alleging a
production bug. Navigation during a held read, BFCache, child replacement and
worker replacement remain separate boundaries. Published archives are unchanged.

### Cold same-tab navigation acceptance

The preceding goal turn completed and pushed `2439204`; current HEAD and the
clean worktree confirm that root-replacement acceptance is progress. The broader
parity objective remains active. This turn follows the planned full-navigation
boundary without presuming a production defect or replacing the wider goal.

The separate `OBU_TEST_COLD_NAVIGATION=1` mode retains the original raw-navigation
precondition and existing passive native observer. One cold attachment navigates
to A, completes its original move/PNG and native resource cleanup, then uses one
public raw navigation to same-origin B. Native document, loader and context
unique IDs must distinguish B; numeric IDs need not change. B uses different
button geometry. Independent native node reads, original screenshots, one
trusted B submission, End and unchanged focus/cleanup checks establish the
actual transition. Existing production code is unchanged while establishing
the first behavior. Held-read navigation and BFCache are separate future checks.

Read-only review found an oracle defect in the shared Runtime event reducer:
an old destroyed event carrying both a unique ID and a reused numeric ID could
remove a successor. Supplied unique IDs now select only their exact context;
numeric fallback is retained only when the unique field is absent, and malformed
supplied identities fail explicitly. Original event records are never rewritten.
The old reducer fails the new deterministic late-event case (12 pass/1 fail);
the corrected shared fixture has 14 passing checks. Root-replacement, End and
new runner-configuration checks bring this targeted group to 38/38. This is a
test-oracle fix, not evidence of an observed native event reordering or a
production bug. Existing world/root native modes will cover the shared helper
on the final source. Context retirement describes the current CDP live set,
not physical destruction of an old page's heap or a BFCache claim.

The pinned [V8 protocol definition](https://github.com/v8/v8/blob/b976f35da8356fcf4e5e176d1d810ba6a6f05718/include/js_protocol.pdl)
distinguishes the deprecated numeric destruction ID from the unique context ID.
The reducer regression uses a controlled event sequence; native navigation
evidence will determine which events actually occur in the selected browser.

The B checkpoint before its first input also records whether any old A effect
is visibly inherited. A hidden pre-existing renderer is allowed; connection
or target presence alone is not a visibility test. This checkpoint and the
later native PNG have separate roles, without claiming continuous observation
of every intermediate navigation frame.

Final same-source native runs `Ri2zjD` (navigation), `6jh6nS` (compatible worker
world lifetime) and `BFDPU7` (same-document root replacement) each pass their two
cases with actual exit 0. All three wrapper records confirm no source/runtime
drift. Node groups pass 1,824 extension, 330 scripts and 1,765 integration checks,
with one existing Windows symlink-privilege skip. Independent visual/business
review joins both original navigation PNGs (18,039/17,986 bytes), the B pre-input
hidden checkpoint and one 2,671-byte B POST with eight trusted events to nine
original native Input calls. Production remains unchanged from full `SfCCYW`.

The user's latest request is to produce another usable package. Finish this
acceptance increment, commit/push only to the existing fork branch, and create a
new Windows preview from the clean commit. Keep the earlier release intact and
include normal company-computer installation and in-place update instructions.
This package includes the persistent-world production fix since the prior
preview; it does not close the broader parity goal. Further native held-read
navigation, BFCache, child replacement and ordinary Edge acceptance remain open.

Final native review joins 143 original calls/settlements (138 successful ACKs,
five preserved exact post-detach absences), nine groups/25 handles, the original
navigation clear/commit sequence and the unchanged attachment. End is hidden
565 ms; 3,706 ms has zero focus events/allowances. The original host exits 0 and
both connections close. Related world/root identity checks, original Node TAPs,
source/build identities and all three exact process inventories also pass.

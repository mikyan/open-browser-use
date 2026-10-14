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
- [ ] Implementation and deterministic checks complete.
- [ ] Real-browser verification and independent review complete.
- [ ] Documentation and fork delivery complete.

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

These unresolved identity/event/lifetime requirements make the adapter a separate
implementation step. Passing the warm reader does not close the cold boundary or
the parent Browser Use goal.

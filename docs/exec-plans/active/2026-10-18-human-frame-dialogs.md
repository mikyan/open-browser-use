# Managed human dialogs from original child documents

Status: active. The preceding goal turn made concrete progress at `95e7b29`:
bounded native-dialog waiting, exact input ownership and delayed-timer response
checks are committed and pushed. Full Browser Use parity remains unproven.
The user subsequently requested a new package. That request takes priority:
release the verified committed `95e7b29` snapshot, excluding this unfinished
child-dialog implementation. That package is now published and verified, with
release documentation committed at `ddf5ff4`. This was concrete progress in
the previous goal turn. The parity goal and this plan remain active; this turn
resumes child-dialog development. The latest user request asks for another
package; after the verified continuation below, build that package from its
committed source. No PR is requested.

## Checkpoint for the requested package

All eight implementation/build WIP files are frozen. Focused checks pass
269/269, syntax and diff checks pass; the original record is
`human-child-dialog-wip-20261018/results.json` (SHA256
`d6d25e52e564280fcdb12b173606f7877ffad1a4bd278c50d6e313e43d939105`).
The four new fixture/runner files are also frozen with 18/18 focused checks
and syntax checks passing. Neither a baseline diagnostic nor new child-frame
browser acceptance has run. These checks do not authorize publication of WIP.

That checkpoint is preserved as history. The continuation below completed
independent review, stronger lifecycle/dispatch counterexamples, baseline
diagnosis and real stable HTTP child/nested acceptance. Inherited documents,
dynamic children and remote-frame continuation remain open; the overall goal
has not been narrowed to these passing cases.

## Verified continuation and remaining work

- Baseline `mfd-w8ou97` completed five steps with actual exit 0. Root answered;
  same/nested/OOPIF native prompts were cancelled without a human answer.
  Diagnostic completion is explicitly not feature success. Report SHA256:
  `2b24ab08333c8577dd2278b866d9ab50eabbf8fce8da43413a93524c0a49978d`.
- Independent review found a P1 after the controller's last dialog drain:
  an Opening during focus-reset/detach could bypass the ambiguity barrier.
  Original failing controller tests are preserved. Final cleanup now checks
  again before detach, terminates attachment event admission at its actual
  ACK, then joins/checks all original dialog responsibilities before clearing
  risk. The ACK does not settle an in-flight native response. Independent
  focus/detach counterexamples and 289 focused checks pass. Review SHA256:
  `54ae296bcd131af379419e73322a22709927a97ecfbf8ea6947e4334c3863bb2`.
- Final build `mhf-build-msot91ik` passes all 2576 Node checks without skips;
  Go source is byte-unchanged, reusing the prior full test/vet chain. It freezes
  405 production inputs and 75 extension files. Manifest SHA256:
  `257266d66aed401d577b7e143dadde9cbac76b209dc06b25d1ae9d5f64de8fb7`.
- Acceptance `mfd-sH1gAh` completes five steps with actual exit 0. Root/same/
  nested original prompts answer Unicode, with independent native Closed,
  dialog/input receipts and one POST per original page. OOPIF has a real
  native opening and a different process, but lacks a current remote witness
  and is cancelled; its pointer-up remains explicitly unconfirmed. This is
  not Chromium suppression. Report SHA256:
  `55cab24af2b5ae71a042b29f4341aade7ec602aedc7d29b3342e2bebba85c8fa`.
- All four original human cleanups, formal Stop and resource cleanup succeed.
  The run records 31 original process identities, 882 unchanged acceptance
  inputs, 20 observed frames (12 saved), and seven viewer PNGs. Retained end
  screenshots are not proof of the final receipt pixels or continuous frames.
- Remaining native coverage: inherited blank/srcdoc, dynamic frame creation
  (including context arriving during preparation), child alert/confirm,
  cross-origin/OOPIF current context and root-routed modal ownership, plus the
  initial/navigation design below. The historical SDK OOPIF session is already
  detached before human takeover and cannot authorize current dialog handling.
- Visual inspection also finds a stale releasing banner after confirmed End.
  This is recorded separately for a receipt-bound UI fix; original cleanup is
  confirmed. The requested package must describe this remaining UI issue and
  include only the verified committed implementation.

Independent post-run audits confirm 386 event/context/receipt checks and all
405 build inputs, 882 acceptance inputs, 75 extension files and 26 SDK files.
All 19 saved PNGs decode; 31 original process identities and private resources
are gone. Event audit SHA256 is
`1c181ae9d911a9ef4b1e0c7cd168705ed6bd1b57bc1cf1db3e830753aa42ea8f`;
lifecycle audit SHA256 is
`06c5aa6f3a942927372b15b7258e7a4eabb7004b197313c5f336b23c80571e1f`.
The event projection does not include every navigation event or raw enable
command ACK; it supports the recorded source/tuple associations, not a claim
that unrecorded events could never have occurred.

## Problem and intended behavior

An active, verified human page already freezes its native frame tree, but dialog
capture accepts only the root entry. A same-origin embedded form can therefore
open a legitimate prompt and immediately lose human control. Child documents
must retain their own native identity; matching a URL or the top-level target
alone is not sufficient.

Allow supported native dialogs from verified stable child documents through
the original attachment and the same typed viewer response lane. Preserve
independent original input and dialog receipts, actual pending work, bounded
waiting, cancellation and held-input cleanup. Never synthesize a second click
or reopen a page to make the task succeed.

## Provenance and scope

- Bind the original lease/epoch, native local-frame tree and specific emitter
  frame/loader/URL. The tree alone does not establish effective origin or include
  every OOPIF. Bind the original live default execution context, native unique
  ID and actual context origin; URL-derived origin is not authority.
- Navigation, replacement, missing/duplicate frame identity, foreign attachment
  and policy changes cannot authorize a child answer. A response uses the same
  original native channel; no broad session acceptance or second Page attach.
- Closed events must be associated with the original native opening using the
  information actually supplied by the pinned browser. A foreign or ambiguous
  close cannot silently settle another dialog or restore input authority.
  A later Opening while the original remains unclosed makes native object
  association ambiguous: prevent any new old-record dispatch or cancellation,
  retain already dispatched work, and keep cleanup unconfirmed until original
  target destruction. The unscoped native dialog command cannot be attributed
  to a guessed old object.
- First diagnose root, same-origin child, nested child and cross-site OOPIF
  behavior in the current frozen runtime. Cross-origin browser restrictions
  have changed historically; neither their existence nor their absence is
  assumed from an old announcement. Keep native suppression distinct from a
  product refusal and a successful human response. Do not change browser flags
  or implement page-script substitute prompts to manufacture support.
- The first implementation targets active generations with an already verified
  frame tree. Pre-Begin, initial preparation and navigation dialogs require
  separating document authority from rendering readiness across extension,
  bridge, Go and UI; they remain explicit work, not silently treated as solved.

## Validation and ownership

The extension owner implements provenance and deterministic lifecycle
counterexamples. A separate reviewer inspects original-event and pending-work
ownership. The fixture owner adds independent frame-dialog fixture/runner
files; existing six-dialog and long-wait runners remain byte-unchanged. Root
owns integration, public UI/protocol changes if required, documentation and
verified commit/push to the fork.

The baseline runtime is the immutable `mdb-final-bgwg8ysj` internal build. Its
403 source snapshots, rather than its older base-commit field alone, identify
the implementation. New production gets a separate frozen build and run.
Every original diagnostic, failure and later acceptance remains intact.

Use four original SDK-delivered pages with one real viewer click each. Record
root/emitter native frame and browser document identities, actual process
evidence for the OOPIF, original tokens and unique POSTs from the actual emitter.
Observe native opening/Closed and typed requests/receipts independently; no
task-page execution while a modal is open. Preserve original supervisor/Job,
process identities, registry/pipe/endpoint cleanup and all saved screenshots.
No personal profile, OS mouse/keyboard use, focus restoration, URL reopening,
business replay or deferred ordinary-company-Edge setup is needed.

## Completion boundary

This slice is complete only after the supported child flow works through the
formal viewer with preserved original provenance and cleanup, and unsupported
browser behavior is distinguished by evidence. It does not close P01–P15 or
prove full Browser Use parity. First-frame/navigation dialogs, beforeunload,
ordinary company Edge and existing platform/lifecycle gaps remain open.

## Follow-on document readiness design

Read-only inspection finds three independent barriers for initial/navigation
dialogs: control requires an active epoch, the bridge installs its handle only
after Begin and first-frame preparation, and Go/UI reject a starting dialog.
Recovery also joins an old pending input before creating the new epoch; a new
document modal may itself block that original ACK. This is a potential cycle,
not yet a recorded real-browser failure.

The follow-on design should give the original attachment a document-authority
object distinct from rendering readiness, seeded by native root/frame/loader
observations and browser document/policy checks. A two-stage Begin may return a
restricted preparing handle after Pause/risk/attachment ownership is established;
only an independently proved dialog and End are then available. Page input must
still wait for actual old input/rendering cleanup and a matching new native frame.
Neither Opening URL/frameId alone nor an old screenshot proves a new document.

The current 5-second rendering and 10-second navigation limits must share a
bounded ordinary/modal preparation budget rather than restart on status. If a
new document's modal blocks an old generation's dispatched input, associate it
only through the same attachment/lease, unique original pending operation and
proved navigation lineage; continue its original cumulative allowance and old
receipt tuple. A new document must not create fresh input time. This requires
extension/bridge/protocol/UI changes and separate real acceptance; it is not
included merely by allowing child frames in the present active-generation path.

## Design findings

- First baseline diagnostic `mfd-fkihsa` has actual exit 1 and is retained.
  The original root prompt was answered with Unicode; the same-origin child
  emitted a native Opening then Closed(false) three milliseconds later and
  posted exactly one null result. Its original pointer-up was explicitly
  unconfirmed. The harness then prematurely accepted the preceding root
  lease's cleanup receipt while viewer cleanup was still false. Correct the
  wait to require the exact current lease and complete original cleanup;
  do not change product assertions or replay this case. Formal Stop, all 31
  observed original process identities, registrations, pipes and endpoints
  were confirmed cleaned; no cleanup error or forced fallback occurred.

- Baseline source audit `mhf-baseline-source-e818t8wg` passes with actual exit 0:
  all 403 original snapshot byte hashes and Git clean-filter object IDs match
  `95e7b29e3c079506445c52d3db192561adca6ced`; all 74 runtime extension files and
  the EXE match the immutable build manifest. Raw CRLF snapshot equality is
  checked separately from filtered Git LF blobs. Report SHA256:
  `78daddb0553f46f7947326f4f704e3a41397b653619cc7b01d8f4e0a1183c31e`.
- Fixed Chromium 156 revision `634b046faf2137b83af71c87baf362b533af9104`
  constructs `Page.Frame.securityOrigin` from the loader URL and omits remote
  frames from the local frame tree. It cannot prove a sandbox's effective origin
  or an inherited blank/srcdoc origin. The existing original-download path
  already uses native default execution contexts for this distinction; the new
  human-control path must preserve the same distinction. See the pinned
  [Chromium implementation](https://chromium.googlesource.com/chromium/src/+/634b046faf2137b83af71c87baf362b533af9104/third_party/blink/renderer/core/inspector/inspector_page_agent.cc).
- The original lifecycle listener must precede actual Page.enable and
  Runtime.enable ACKs, which in turn precede the preparation proof. Freeze the
  native tree and one live default context per ancestor in a stable event
  revision window, then recheck before publication and response. A Created event
  has no loader ID; frameId equality cannot rebind an old context after document
  replacement. Destroyed/cleared/replaced identities remain retired, with
  bounded storage and no resurrection from repeated native events.
- Historical fixed-runtime results include frameId in every inspected native
  Closed event (six original dialogs and two long-wait dialogs). New tests must
  still reject missing or foreign identity rather than relying on that sample.

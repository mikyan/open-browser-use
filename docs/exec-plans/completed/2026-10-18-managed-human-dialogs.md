# Managed human JavaScript dialogs

Status: complete for this bounded dialog slice. Previous goal turn: progress
(five public entrypoint workflows accepted and Go created-page scope fixed at
`32507a3`). Overall Browser Use parity remains unproven and its goal is active;
this continuation does not produce another release.

## Goal and boundary

Let a person operating the original managed page respond to `alert`, `confirm`
and `prompt` from the viewer. Display website text as text, keep the original
lease and dialog identity, and return success only after the original native
response acknowledgement. A response must not wait behind the triggering input.

This slice begins after an active human lease and its first decoded frame. It
does not claim beforeunload, pre-existing/begin-time or navigation-onload dialogs,
OS dialogs, ordinary company Edge acceptance, or general parity. A view lease
has no response authority. No personal profiles, OS input, focus restoration,
URL reopening, input replay or business retry. No package or PR is requested by
this automatic continuation; the user's package request is already fulfilled by
`preview-20261018-853ea92`.

## Approach

1. Preserve a real old-runtime diagnostic using the frozen internal `5d42f7a`
   candidate, a single trusted prompt click, the real viewer, and passive worker
   dialog events. Record actual ACK behavior and formal Stop cleanup separately
   from whether the missing UI is confirmed. Do not repair the diagnostic.
2. Give each original native dialog a bounded identity owned by the original
   managed attachment. Project persistent `pendingDialog` state. Add a typed
   `humanDialogRespond` operation with lease/generation/dialog identity, decision
   and optional prompt text; return an independent native `dialogReceipt`.
3. Keep input seriality unchanged. Dialog responses bypass that lane. Multiple
   native dialog instances may overlap in acknowledgement timing; each is claimed
   once, and an old acknowledgement cannot decide or retire its successor.
4. Revoke user response permission before cleanup. Cancel an undecided original
   supported dialog before joining blocked input; join already dispatched native
   responses without sending again. Native failure remains unconfirmed cleanup.
5. Render a plain-text dialog card in the viewer with accept/cancel and Unicode
   prompt input. Block ordinary inputs while the dialog is pending. Keep Stop
   available; do not resume the Agent or clear human-risk markers on a reply.
6. Verify schema rejection, pending-input concurrency, late ACK, replacement,
   duplicate/stale/foreign identities and cleanup using focused tests, then run
   real alert/confirm accept+cancel/prompt Unicode+cancel on original documents.

## Ownership and evidence

- Root: plan, viewer UI, integration review, documentation and final commit.
- Extension agent: native dialog module, managed attachment/bridge and tests.
- Native agent: Go schema/controller/viewer transport and tests.
- Fixture agent: deterministic original HTTP fixture, tests and frozen-runtime
  diagnostic runner. Original failures and execution receipts are retained.

Source revisions, executable/extension hashes, original native events, viewer
messages, screenshots, single POST receipt and formal lifecycle cleanup belong
in the real-run report. Mocks, diagnostics and native acceptance stay distinct.
No release claim follows from an internal candidate build.

## Progress

- Read-only architecture audit found no dialog event/response support on the
  independent human attachment. Three input lanes wait for original ACKs.
- The deterministic fixture's nine tests passed. The old-runtime diagnostic,
  implementation and final native acceptance are complete as separate records.
- Frozen old runtime `md-Yruwtj` confirms a native prompt with no viewer dialog
  state/UI. Its formal Stop and supervisor return exit 1 (`context deadline
  exceeded`); original Browser/Native exit 0, Job empty and private resources
  cleared. Preserve this failure. The diagnostic clicked Refresh during the
  modal; old textarea blur issued humanEnd before the input error, so the error
  cannot be attributed to an unsolicited native rejection or natural timeout.
  The subsequent 12-second observation occurred after End. The original failure
  is preserved rather than relabelled as successful cleanup.
- Keep the existing 30-second original input confirmation deadline in this
  slice and show it in the card. Supporting long human deliberation requires a
  separate bounded modal budget, not unbounded inputs or resetting deadlines.
- Viewer decision tests cover pending input, successor dialogs before old ACK,
  exact receipt, definite unsent rejection, Unicode bounds and revocation.
  Held pointer/key release remains queued behind the original input ACK and
  dialog closure; window-capture keyup observes the real release even when the
  page textarea has been disabled. No new page keydown is admitted there.

## Verification and retained failures

- Internal build `md-build-1xttk03a`: Go full tests and vet passed, as did 2495
  extension/build/UI tests. Its 398 source inputs and original logs are frozen.
  Final build `md-build-0l684nsq` verifies only two UI files changed, passes all
  64 focused UI tests and rebuilds the embedded viewer. Native EXE SHA256 is
  `dbbc065db04462c0f91b2c10cc59fbaeaf86ebcacc1f9d8d9676baab756cb96c`.
- First new-runtime attempt `mhd-T6Gu7W` passed five normal answers but failed
  before the second page's business click: the precreated page had not been
  finalized as a deliverable and lost task ownership at Pause. Its actual exit
  1 and successful cleanup remain recorded. Only fixture setup changed before
  the next run; the production binary and extension did not change.
- Formal run `mhd-ozO6fy` used Windows CfT 156.0.8078.12 and two original pages
  finalized by the public SDK. Six native dialog pairs passed: alert, confirm
  accept/cancel, Unicode prompt accept, prompt cancel, and an unanswered prompt
  cancelled by End. Five normal cases have 15 original input receipts and five
  independent dialog receipts. End has two successful input receipts and one
  pointer-up caller returning OPERATION_UNCONFIRMED after explicit revocation;
  that last reply is not a successful input receipt. Each original document
  produced exactly one POST, with no URL reopening or business replay.
- Both original humanCleanup receipts confirm release. Formal Stop, supervisor,
  Browser, Native and viewer exit 0; Job is empty and forced=false. All 26
  original process identities, original pipes and private registrations are
  absent, and the endpoint directory is empty. Source snapshots (869 files) and
  the 73 built extension files remained byte-identical through the real run.
- The immutable formal result is `.tmp/browser-integration/mhd-ozO6fy/results.json`,
  SHA256 `a727d7dab13a992ba975bb49a8486b3d51576f373c1e1b53b30e854ab79367d5`.
- Post-run harness hardening adds exact native root/frame and event pairing,
  actual outgoing decision timing and original cleanup-lease assertions.
  Sixteen fixture/runner tests pass. Offline rechecking the original result
  passes all six pairs and 18 original inputs, with actual decision sends at
  176/158/158/180/176/159 ms. These assertions did not execute in the earlier
  browser run: that run's frozen runner was `4be129ac...`; the current runner
  is `4d99ab9c...`. Both versions and the offline report are retained.
- Independent native-event/receipt audit
  `.tmp/md-new-audit-20261018/mhd-ozO6fy-audit.json` passes all 289 checks;
  SHA256 `bb6d663ad92b6ae5267f9565217a83dc0ebda6fb4e033d8206fffcf04a677d6d`.
  It checks exact original source/root frame, six paired events, actual request
  times, all original input sequences, both unique POST bodies and native return
  values. Receipts are the product's original protocol receipts, not an
  independent capture of the outgoing CDP command stream.
- Independent lifecycle/source/image audit
  `.tmp/md-new-lifecycle-audit-20261018/audit.json` passes all 73 checks;
  SHA256 `e0f1cf7dbccf709c9610dadffd7773ebd28a78265a578e7c6732da67870c188f`.
  All 21 saved PNGs decode and were inspected. Only 13 of 24 native frames were
  saved; the other 11 are not visually verified. Post-End screenshots retain the
  prior image, so receipt visibility is proven by the original document/POST,
  not by those frozen images. Exact FILETIME is preserved from raw lifecycle
  JSON rather than its rounded JavaScript-number copy. This run does not add
  OS foreground or cursor-observation evidence.
- Documentation skeleton and repository hygiene checks pass; all 262 local
  Markdown links across the ten changed documents resolve. Final source hashes
  still match all 398 final-build inputs, Go formatting is clean, and the diff
  has no whitespace errors.

## Remaining scope

The original 30-second input/35-second viewer deadline remains. A separate
bounded human-deliberation budget, pre-Begin/first-frame/navigation/child-frame
dialogs and beforeunload remain open. Company Edge manual acceptance is still
deferred. Full P01–P15 parity is not claimed. See
[the feature reference](../../references/managed-human-dialogs.md) and
[the debt tracker](../tech-debt-tracker.md). This commit is source only; the
published `preview-20261018-853ea92` package remains unchanged.

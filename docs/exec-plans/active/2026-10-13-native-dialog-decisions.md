# Native JavaScript dialog decisions

## Objective and scope

Continue the full Browser Use parity objective with explicit native alert,
confirm, prompt and beforeunload handling. The current pinned CRX defaults to
dismissing the first three and accepting beforeunload; no public OBU API lets an
Agent choose a different result. This prevents ordinary confirmation and prompt
workflows. This is an observed OBU gap, not a claim about undocumented Codex APIs.

The previous goal turn made progress: chooser convenience clearing was verified
and pushed as `ec36c9a`, with archive `bd82b97`. The worktree was clean at the
start of this slice. P01–P15 remains active; ordinary Edge manual acceptance is
deferred. Preserve delivered ZIPs and do not create a PR. Only root launches
isolated browser tests; never operate the system mouse or daily browser profile.

## Contract to implement

- Explicit one-shot arm → trigger once → collect, plus cancellation. The arm
  declares dialog type, optional exact message, accept/dismiss and optional
  prompt text. It returns ready only after a real Page listener is registered.
- One live decision per tab. Scope includes the original session, turn, epoch
  and native attachment; a new owner or attachment cannot inherit it.
- Registration and native decision share the original monotonic deadline.
  Dialog callbacks do not wait behind the triggering action's queue. Confirmed
  native response is required for success; errors/timeouts never replay it.
- A nonmatching dialog keeps the pinned upstream default. With no armed
  decision, existing default behavior stays intact. Ending/cancelling removes
  the listener and prevents a later dialog from using the old decision.
- Pending native responses remain observable for cleanup. A command already
  sent cannot be undone; do not misreport cancellation as rollback or a lost ACK
  as proof that the browser did nothing.
- Support the public JS/Python/Go SDKs and CLI/MCP; restrict the new method in
  restricted-site mode until its document-origin boundary is separately proven.

## Milestones

1. [x] Confirm the missing public surface and pinned default behavior.
2. [x] Implement the extension protocol and lifecycle tests, retaining red evidence.
3. [x] Add typed public SDK and CLI/MCP entry points with transport tests.
4. [x] Verify ordinary dialog decisions, original business results, lifecycle and focus; retain beforeunload's failed background acceptance separately.
5. [ ] Independent review, relevant regression checks, usage/history, commit/push.

## Evidence and design notes

- The pinned `playwright-crx@0.15.0` server dialog path closes an unhandled dialog;
  its close implementation accepts beforeunload and dismisses other types.
  Client fallback agrees. Page/context subscriptions suppress that fallback, so
  filtering must explicitly settle nonmatching dialogs with the original default.
- Normal-source popup focus remains unresolved. Prior controlled diagnostics
  exclude focus emulation, createTarget ShowInactive, removing userGesture and
  moving the tab as general repairs. Do not repackage conditional popup results
  or add focus allowances to claim that gap is fixed.
- Keep native subscriptions and response settlement tied to the original Page;
  review the pinned registration ACK path before choosing a ready boundary.

## Implementation evidence

- Actual baseline failures are retained for both Backend and Go/CLI, followed by
  23 new registry/backend tests and 111 related backend regressions passing.
- JS and Python each added eight focused tests. Their full suites passed with
  the pre-existing real-host integration skips. Go SDK/CLI related suites and
  vet passed; the complete Go suite also exited zero.
- The initial extension/script/integration unit sweep exited zero with 2907
  passes and one existing Windows symlink skip. The native event proof checker
  is being added separately before real-browser validation.
- Ten Windows binaries (host and nine typed fixture helpers) were built from
  the frozen Go inputs, with actual exit zero and no source drift.
- Lifecycle review added exact native Promise draining, including upstream
  default responses, retention after unconfirmed cleanup, idempotent retired
  cancellation, and original Page terminal evidence during subscription cleanup.
  New child frames retain a pending policy; top-document replacement revokes it.

## Actual browser findings

- First run `5tMxBX` exits 1. All root and existing-OOPIF business decisions
  work, but the fixture incorrectly expects chrome.debugger.getTargets() to
  expose iframe/tabId. Original target records show type `other`; native
  Target.attachedToTarget supplies iframe identity. Dialog events use the root
  source and carry the original child's frameId. Verification now joins these
  original identities rather than requiring an invented source shape.
- The same run proves beforeunload dismissal and unchanged original document,
  but the native UI activates its task tab. Chromium's pinned app-modal factory
  explicitly calls ActivateContents. No focus allowance or restoration is added.
  This is a real unresolved P12 gap, recorded in the debt tracker; the explicit
  OBU_TEST_DIALOG_BEFOREUNLOAD=1 diagnostic retains the failing focus gate.
- Default lifecycle covers cancellation, expiry and turn end. These scenarios
  and ordinary alert/confirm/prompt are the accepted background scope of this
  slice, not an assertion that all four native types are interruption-free.
- Corrected JS run `ltkQhr` exits 0, 2/2 cases, 24 dialogs and 21 original POSTs.
  Final focused five-entry run `l9jFNY` exits 0, 7/7 cases, no source drift.
  Complete regression `uZgxYp` passes 138/138 with actual exit 0 and no source
  drift; 377930ms focus coverage retains only original 12 activation/four control
  focus allowances. A subsequent harness-only enhancement retains helper stdout
  text and verifies original child target IDs disappear; `oYbXyC` passes 7/7,
  actual exit 0, 24535ms zero focus/activation/allowances. Production and helper
  sources are unchanged between these runs. Independent final audit passes all
  native transactions, receipts, original helper stdout, 16 task tabs/ten child
  target removals, and both runs' original focus histories. Full regression's
  132 previous case names/order and allowance causes are preserved.

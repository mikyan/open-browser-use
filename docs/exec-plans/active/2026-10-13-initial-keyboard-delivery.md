# Initial locator key delivery

## Goal

Resolve the missing initial End keydown observed in the real browser regression,
preserving background operation and one explicit original press. A successful
diagnostic rerun alone is not a fix or proof that the original problem is gone.

## Baseline evidence

At clean `082b2bb`, full run `bDKdec` is 137/138, actual exit 1. The first
`root-keyboard-invalid` scenario returns from setup `locator.press("End")`, but
the original document only records its trusted keyup. The missing down remains
absent after the invalid-key observation period and in the final POST. Subsequent
explicit `a` input and submission work. Setup precedes native probe installation,
so this run cannot prove whether down was sent/ACKed or where it was routed.
Runtime, engine, input adapter and fixture match a previous successful full run.

## Approach and constraints

1. Install the existing bounded native probe before navigation, with a separate
   setup phase for the original request/response and down/up native completion.
   Add a passive head recorder for key/focus ordering and the original bottom
   listener-install marker. Preserve the bottom listener's installation position
   and strict event assertions; the early recorder cannot substitute for them.
2. Predeclare a keyboard-only run and a run including its immediate screenshot/
   screencast predecessors. Each retains the original cases, one setup End per
   case, deadlines and strict event assertions. No implicit click, input replay,
   focus restore, startup flag change, new focus allowance or daily-profile edit.
   Both runs also capture bounded browser-native `input` tracing, with original
   stream bytes, completion/loss checks and explicit cleanup. This distinguishes
   Blink's `Input Suppressed` path from an assumed focus or listener explanation.
3. Inspect actual evidence alongside the pinned focus/input implementation; make
   a production change only when its mechanism addresses the observed gap.
4. Validate the resulting behavior and affected workflows, preserve failures,
   update documents/history and push scoped changes to the user fork. No PR.

The diagnostic avoids new readiness reads/waits between navigation and the
original first End. The extra head script can nevertheless alter parser timing;
it is not a production remedy or evidence that an unobserved intermittent failure
is fixed. If the missing event does not recur, retain the original failure and
the specific unresolved routing/ACK/listener-install distinction.

## Progress

- [x] Revalidate clean worktree, current failure, active objective and constraints.
- [x] Inspect pinned paths: native ACK can succeed for an unqueued/suppressed
  key; Blink defer-main-frame/commit suppression is a concrete candidate. The
  SDK's load+loader check makes ordinary inline-listener late installation a
  weak hypothesis. Neither is established as the original run's cause.
- [x] Record setup-native and passive original-page evidence with regression tests.
- [x] Run the two predeclared isolated diagnostic contexts and analyze results.
- [x] Implement and verify a mechanism-supported delivery fix, or retain concrete
  unresolved evidence and next diagnostic if the cause is not yet established.
- [x] Synchronize debt, quality, history and the main parity plan; push diagnostics.
- [ ] Resolve the original missing-down failure with mechanism-supported evidence.

## 2026-10-14 diagnostic checkpoint

The fixture and trace helper pass 64/64 focused tests, actual exit 0. A negative
orchestrator test proves that a missing original End down still permits the
original unique business POST and receipt before failing strictly. A complete
head ledger cannot repair an incomplete original bottom ledger. Trace checks
require original start/end clock markers, no reported loss, bounded reads and
one acknowledged original stream close; unknown start outcomes remain explicit.

The two predeclared runs completed with unchanged source/runtime inputs:

- Keyboard-only `UplYfR`: 2/2, actual exit 0; nine original POSTs, 100,836 bytes.
- Screenshot-context `5eI49Q`: 5/5, actual exit 0; nine original POSTs, 100,985 bytes.

Each contains nine unique setup End presses, 18 setup native key commands plus
32 business/cleanup commands, and complete original down/up DOM evidence.
Both traces contain the two native clock markers, 50 keyboard-forward events
and zero `Input Suppressed` events. Their original streams contain 1,099,467 and
1,091,793 bytes respectively, without native data loss. Native focus coverage
is 19,923ms and 65,518ms, with zero activation, focus change or allowances.

Neither run reproduces `bDKdec`; no production input behavior changes here.
The original failure and this plan stay open. The immediate screenshot prefix
alone did not reproduce it under instrumentation, but that does not rule out
timing effects or the omitted longer full-suite prefix. Enable this diagnostic
on the next independently required full regression. If it recurs, correlate
the original setup native commands, head/bottom order and native input flow
before deciding whether a rendering lease or focus-routing change is justified.
Do not repeat the suite solely to obtain a green result or replay failed input.

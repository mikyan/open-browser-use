# Screenshot completion and rendering ownership

## Goal and scope

Advance P09/P13 of the full Browser Use parity objective. A caller timeout
must not release a rendering lease or complete Pause while its actual screenshot
operation is still unresolved. Keep the existing caller deadline, original
attachment identity and once-only capture. Do not change the published preview.

The preceding company-install answer delivered guidance, not capability progress.
Current clean production checkpoint is `a896b2f`. Version-pinned Chromium source
excludes minimizing an ordinary background window as an activation fix; that
requirement stays open. A separate real pinned-bundle VM experiment also exposed
hover returning success when every native move is suppressed. Hover remains a
subsequent product slice, not a completed requirement.

## Reproduction and design

The current `withRenderingLease` wraps the actual operation in a deadline race.
When `Page.captureScreenshot` remains pending beyond that deadline, both the
per-tab queue and global drain can disappear. A following stream command runs,
and Pause can report cleanup complete before the original operation settles.
This has been reproduced in the existing backend VM with a controlled native
Promise; it is not evidence of a naturally slow Chromium screenshot.

- Track actual operation settlement independently of caller timeout/cancellation.
- Serialize same-attachment rendering through settlement and native stream cleanup.
- Preserve global drains when detach removes the old per-tab queue; a confirmed
  successor attachment must not inherit authority from the old operation.
- Keep the original error and deadline; do not replay screenshots, add input,
  activate windows or change existing focus allowances.

Independent source review exposed the same issue one layer deeper: the pinned
Playwright ProgressController races its operation against abort. Thus awaiting
the engine's `run()` alone does not follow an actual native screenshot. Record
the original `Page.captureScreenshot` Promise at dispatch through the existing
CRX native hook, keyed by its original attachment. It must not queue behind its
own rendering lease. The lease retains its original native captures through
settlement, even after the engine wrapper fails; global Pause also sees them.
Track raw captures through the same mechanism. Do not turn this into a general
unbounded queue for every CDP read or replay a timed-out engine operation.

## Verification

1. Regressions fail against the unchanged production source and cover internal
   and caller-owned streams, late resolve/reject, Pause and attachment replacement.
2. Exercise a real screenshot whose original native ACK is held by an explicit
   test-only gate. Verify the caller times out, subsequent rendering stays behind
   that original operation, and cleanup cannot falsely finish. Record the exact
   gate boundary; delayed ACK delivery is not a pending browser raster operation.
3. Run the affected rendering/stream tests and ordinary browser regression with
   the existing case order and focus accounting. Inspect actual exits and cleanup.
4. Update behavior references, history and parity status with verified scope;
   commit and push to the authorized fork without a PR.

## Progress

- [x] Current source and previous checkpoint revalidated.
- [x] Deterministic pending-native counterexample reproduced.
- [x] Production fix and regression tests.
- [x] Real-browser deadline/lease acceptance and ordinary regression.
- [x] Independent review and documentation; delivery uses the commit containing
  this completed plan on the authorized fork, without a PR.

The full P01–P15 goal remains active. This slice cannot establish complete parity.

The first broad related check exposed a compatibility error in the candidate:
awaiting every ordinary operation indefinitely prevented cancellation when no
native screenshot existed. The final implementation preserves the ordinary
cancellation race and separately joins registered native captures. Focused
77/77 and related 268/268 pass; full extension tests pass 1121/1121. Five raw
counterexamples fail against the original production source. Two real-engine/
pinned-Progress counterexamples fail against the intermediate candidate that
only awaited the action wrapper; they were not run against the original source.

First real run `wP9GER` is 2/3 runner cases, actual exit 1. Internal successor
and Pause scenarios pass; the external successor scenario wrongly starts an
already-running stream and receives the native already-active error. The fixture
was corrected with explicit queued stop/start, preserving deadlines, ordering
requirements, original PNG and the failed run. No production change was indicated
by that fixture error.

Corrected focused `kSmNJ7` passes 3/3 runner cases, actual exit 0, with all five
raw/high-level subscenarios. Final Node suites pass 2467/2467 (1121 extension,
184 build, 1162 integration), with zero skips/cancellations. No source change
between focused acceptance and the ordinary full regression. This uses the
isolated Native Port adapter and backend Pause API, not installation/popup UI.

Full ordinary `kuWd2o` passes 126/126, actual runner exit 0. The original 125
names/order are unchanged after removing this one new case. Its 282,457ms focus
ledger contains only the original 12 activation/four control-popup focus
allowances. Source and artifact manifests match; the old preview hashes remain
unchanged. The focused run's independent review decodes seven PNGs and verifies
five exact tab/target cleanups. Detailed limits and retained failures are in
`docs/references/screenshot-completion.md`; full parity remains active.

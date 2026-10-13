## [2026-10-13 23:46] | Task: Explicit retry after a failed website-policy save

### User Query

Continue Browser Use development while manual Edge installation/authorization
acceptance is unavailable. Preserve background operation, the user fork and
delivered preview packages; do not open a PR.

### Changes and intent

- Add a live-popup-only retry of the exact canonical failed policy candidate.
  Only an actual settled storage rejection grants retry authority. New attempts
  retain pause/drain and revision checks; stale or duplicate requests cannot write.
- Clearly display Not saved, preserve drafts until explicit review, and expose
  Retry save and keep paused. Successful retry never resumes/replays agent work.
  Refresh automation status after every settled Apply/Retry attempt, including
  failure, so a failed save does not leave the previous Running display stale.
- Keep startup read/corrupt-state and unresolved-write recovery out of this
  endpoint. Ordinary SET cannot replace a failed candidate before explicit retry.
- Extend the existing real action-popup fixture with a targeted native quota
  rejection, durable readback, paused/old-epoch checks and an original-page POST.
  The fault changes one native argument and retains the original Promise; it is
  controlled failure injection, not a claim of a spontaneous Chrome failure.

### Verification

- Baseline policy/backend: 24 existing pass and six new failures, actual exit 1.
  Final policy/backend 32/32 and related tests 107/107 pass. Popup regression
  failures, stale-error correction and settled-status refresh red cases retained;
  final popup/control tests 34/34 pass. Four fault-adapter tests preserve exact
  Promise/receiver and detect incomplete native settlement.
- Complete extension/script Node suite: 2,939 pass, one existing Windows symlink
  skip, actual exit 0. Go and SDK implementation are unchanged; real integration
  reuses ten previously built host/helper binaries with verified source hashes.
- First native `v3jDaV`: 2/2 actual exit 0; screenshot review found delayed
  automation status refresh on failure. Corrected `Y4Qq0W`: 2/2 actual exit 0,
  unchanged source/runtime inputs. Durable revision stays 1 after the native
  quota error at candidate 2, then exact candidate saves at revision 3. Control
  remains paused; explicit Resume/new-turn produces one trusted 65-byte POST.
  Zero tab activations; only the existing two action-popup control-focus events.
- Complete `bDKdec`: **137/138, actual exit 1**. Website retry passes, all original
  test names/order remain and source/runtime inputs do not drift. Strict focus
  validation retains only the previous 12 activation/four control-focus events.
  The first keyboard setup `locator.press("End")` lacks page keydown through its
  final POST. It precedes native probe installation, so this evidence cannot say
  whether down was sent/acknowledged or routed elsewhere. Its runtime, engine,
  input adapter and fixture match the prior successful full run. Preserve the
  failure and investigate before claiming the full suite passes.
- Independent artifact audit confirms 524 source files, 13 runtime identities
  and 45 staged-extension files match. Focus coverage is 4,539ms for the final
  focused run and 365,563ms for the full run; the full audit explicitly records
  `suitePassed:false`. Both new-policy native workflows pass.
- Original preview ZIP hashes are unchanged. No daily-profile changes, OS mouse,
  new focus allowance or PR. Overall Browser Use parity remains active.

### Main files

`site-access-policy.js`, backend trusted-message wiring, popup controller/UI,
their adjacent regression tests, `site-access-save-retry.mjs`, the private native
quota fault adapter and existing real site-access fixture. References, capability
matrix, quality score and debt tracker distinguish scoped recovery from remaining
startup/unknown-write and keyboard gaps.

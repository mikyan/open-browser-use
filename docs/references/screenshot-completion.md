# Screenshot deadlines and actual native completion

A screenshot timeout ends the caller's wait. It does not establish that Chromium
has finished the original native operation. Raw root `Page.captureScreenshot`
and the public engine screenshot route retain the original rendering lease until
their registered native captures settle, including late native rejection.

## Ownership and cancellation

The CRX send hook records the original attachment and active lease before an
asynchronous site-access check. Immediately before native dispatch it rechecks
that lease's authority and deadline. A late permission result cannot send an
expired screenshot. There must be an active rendering lease; a missing lease
does not silently authorize a screenshot.

Playwright's pinned ProgressController races its task against abort. Waiting for
that task's public wrapper alone would therefore lose native completion. The
backend records the actual capture Promise independently in the original lease
and global cleanup drain. Capture is not queued behind its own lease. When the
wrapper finishes or is cancelled, the lease stops accepting new captures and
joins its registered captures before stopping its internal stream and releasing
the queue. The original caller error/deadline remains bounded; no screenshot is
repeated. Ordinary actions without a pending native capture still cancel promptly.

A confirmed debugger detach allows a new attachment to use an independent queue.
It does not discard the old native completion record. Late old completion cannot
delete the successor's queue or stop its stream. Pause remains blocked/incomplete
if its original cleanup budget expires with native completion unresolved. After
actual settlement, explicit Retry Pause and Resume can restore control; old
scopes stay revoked and a new turn is required.

This does not claim to track every CDP command. Child-session raw CDP commands
retain their existing route outside the root rendering lease. Worker loss and
every browser/platform combination require their own acceptance evidence.

## Verification and limits

Five raw backend counterexamples reproduce missing drains in the old source.
Two real-engine/pinned-Progress counterexamples fail against the intermediate
wrapper-only candidate, not a separately tested original source. Tests exercise
raw root screenshots, the real action engine with pinned ProgressController, delayed
native fulfillment/rejection, restricted-site checks, attachment replacement,
ordinary-action cancellation, and bounded Pause failure/retry.

The browser fixture holds delivery of the first **actual fulfilled** native
capture result. Chromium has already produced the PNG. The fixture neither
fabricates that result nor establishes a naturally slow raster operation. It
checks the original PNG pixels, actual wire timeout before later actions, exact
production queue identity, stream ordering and Pause's unchanged 10-second
budget. Its gate watchdog is a test failure, never successful cleanup.

Candidate `wH1kmv` later exposed a fixture-clock error in the third raw/external
scenario. The caller receives the original worker timeout through the SDK's
`#handleMessage`, with the exact same error text, after about 1005 ms of its
unchanged 3000 ms transport budget. The worker wall timestamp is nevertheless
1 ms greater than Node's settled timestamp. Comparing those two independent
wall clocks cannot establish whether the SDK locally timed out first. The
failed assertion and raw artifacts remain retained. The corrected oracle
requires the same request's unique reply, exact caller error text and first
stack frame from the pinned SDK's original response handler. Local timer errors,
including a timer-first stack with a deeper handler frame, remain rejected.
Both timestamps stay in the diagnostic record. No timestamp tolerance or
longer deadline is introduced, and the SDK is unchanged.

The first run `wP9GER` fails overall (2/3 runner cases, actual exit 1). Its two
internal-stream scenarios pass. The third scenario incorrectly tries to start
an already-running external stream and receives Chromium's original rejection.
The corrected fixture explicitly queues the external stop and then start;
neither may dispatch before original capture delivery, and the stop ACK must
precede the start. The first failure is retained.

The corrected focused run `kSmNJ7` passes 3/3 runner cases with actual exit 0.
Its screenshot case contains five scenarios: raw/internal and raw/external,
each with a successor stream or Pause, plus high-level/internal with Pause.
It does not test a high-level/external screenshot. Five original native PNGs
and two subsequent stream frames are retained with nonce/sequence pixel checks.
Late native rejection is covered by backend tests; this browser gate holds
successful capture results only.

Independent decoding verifies the seven saved PNGs, including all nonce/sequence
sample cells. The five original PNGs total 85,066 bytes; 44 selected native
commands all settle successfully. Three Pause attempts fail with their unchanged
10,000ms cleanup budget, then three explicit Retry/Resume paths succeed with
old scopes denied. All five fixture tabs/targets are absent after finalization.
The focus ledger covers 39,291ms with no activation/focus events or allowances.
The selected sentinel stays in its original window, but its viewport height
changes from 1222 to 1165; this is not an unchanged-window-size claim.

The subsequent ordinary run `kuWd2o` passes 126/126 with actual runner exit 0.
Removing only the new screenshot case leaves exactly the preceding `ZUgidL`
125-case names and order. Its 282,457ms focus coverage contains only the existing
12 existing permitted tab activations and four control-popup focus events, with no new
allowance. The first host is deliberately terminated by the existing host-restart
case; the replacement host records EOF exit 0. Neither run establishes all
P01–P15 requirements or broader platform acceptance. The full run's sentinel
retains its tab/window/URL while viewport height changes from 1222 to 1192.

This runner uses a loopback WebSocket replacement for the Native Port. It does
not verify a fresh `connectNative` installation. Pause, Retry Pause and Resume
call the real backend methods through a staged-only reference; this is not a
new popup UI acceptance. The ordinary runner kills its test browser during
teardown, so runner exit 0 and recorded host EOF exit 0 must not be described
as a graceful browser exit 0.

The final Node suites pass 2467/2467: extension 1121, build 184 and integration
1162, all with actual exit 0 and no skips/cancellations. Focused rendering/Pause
77 and related 268 are subsets, not extra tests to add to that total. Host and
Go helper source inputs and binaries, plus SDK/runtime inputs, are hash-checked
against their preceding manifests and reused; they were not rebuilt for this
extension-only production change. The published preview ZIPs are unchanged.

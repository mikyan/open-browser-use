# Hover delivery confirmation

## Goal

Advance P06/P13 of the full Browser Use parity objective. Public locator hover
must not report success merely because native movement was acknowledged when
the original target received no pointer movement. Preserve hover's normal
behavior on disabled targets, menus and nodes changed by the hover itself.
The full P01–P15 objective remains active; no PR or published preview update.

Previous checkpoint `42df22f` is clean and pushed to the authorized fork. The
preceding goal turn made production progress on native screenshot completion,
with full 126/126 acceptance; it did not complete parity.

## Evidence and design

The saved deterministic probe under `.tmp/hover-delivery/` executes the actual
currently patched pinned CRX `_hover` in the existing Node VM fixture. Dropping
the first/all page move events while resolving the mock transport ACK still
returns `done`; assertion mode exits 1. This is not a natural Chromium/Viz or
real-browser reproduction. Baseline script/log/exit/invocation are retained.

- Add dedicated hover delivery, keeping the original root native route, target,
  utility context, attachment, total deadline and retry cadence.
- Await original native move ACK and require an event-time trusted primary mouse
  pointermove on the original composed target and local hit. Do not reuse click's
  post-move enabled/stability/geometry checks: hover itself may change those.
- After a positive receipt, do not issue another movement. Missing receipts may
  retry only after actual settlement and within the original deadline.
- Use a private attachment input ticket. Add atomic hover admission: idle input
  receives a ticket; only confirmed pre-held keys/buttons retain the legacy path.
  Unknown, in-flight, durability-pending, releasing or guarded input must not
  reach that fallback. Preserve force/trial semantics explicitly.
- Restore per-attempt modifier baseline and preserve original errors. Deadline,
  scope, context or attachment loss cannot authorize late native dispatch.
- DOM events have no native request ID; trusted event-time observation is not
  authentication of its source or proof of atomic future rendering behavior.

## Verification

1. Native-bundle and tracker regressions fail on the baseline and cover missing
   delivery, held ACK, explicit modifiers, foreign input, cancellation, legacy
   force/trial/pre-held behavior and legitimate hover side effects.
2. Browser fixture: root, same-origin, OOPIF and transformed OOPIF; controlled
   first/all dropped moves, original target state changes, one real business
   receipt, no buttons/clicks and exact cleanup. Synthetic ACK drops remain
   explicitly labelled controlled negatives, not natural failure claims.
3. Independently hold publication of an actual successful native move ACK and
   verify original deadline/Pause behavior without new focus allowances.
4. Run affected suites and unchanged ordinary browser baseline, adding separate
   hover cases while preserving all original 126 names/order. Inspect raw page,
   wire, native, focus, artifact and actual-process evidence; retain failed runs.
5. Update architecture/contracts/matrix/history with verified bounds, commit and
   push to the fork. Keep full parity and unresolved platform work active.

## Work division

Root owns tracker admission/backend hooks, runner wiring, browser execution and
delivery. Engine agent owns pinned patch and receipt tests. Fixture agent owns
new independent browser fixture/tests. Independent reviewer audits design and
evidence. Only root launches browsers; no daily profile or OS mouse control.

## Progress

- [x] Revalidate clean checkpoint and saved deterministic counterexample.
- [x] Production implementation and regressions.
- [x] Focused real-browser acceptance and full regression.
- [x] Independent evidence review and documentation.
- [x] Prepare the reviewed changes for delivery to the authorized fork.

## Implementation checkpoint

The previous goal development turn made progress: production hover/admission
changes and counterexamples changed the authoritative worktree and verification
basis. The subsequent installation-guidance turn was read-only, not development
progress. This continuation revalidated HEAD, dirty sources, actual suite exit
records and frozen fixture hashes before continuing; no browser process was
assumed live from an old log.

Production extension tests passed 1146/1146 and build/patch tests 202/202,
actual exit 0, with no skip/cancellation. Related admission 105 and native-bundle
115 tests are subsets, not additional tests. The first integration suite passed
1188/1188 before the review changes below; it is not final-current evidence.

Independent fixture review required exact-scope native wire errors for all-drop
timeouts, measured original Pause cleanup time and failure cause, exact modifier
masks, and all-Input evidence rather than inferring absent keys from a mouse-only
recorder. These were added before first browser execution. Root also fixed
shared runner teardown evidence: outer finalize/close errors no longer replace
inner cleanup errors, and a known operation/cleanup failure clears `passed`
before saving. Both hover cases save auxiliary server evidence before their main
detail, so a failed secondary write cannot leave a successful main artifact.
Persistence failures remain authoritative in final results/logs; this generic
helper cannot recall arbitrary data already written by a failing save callback.
The affected 67 observation tests pass.

Further pinned-bundle inspection found a genuine semantic gap in the first hover
candidate: a delivered `pointermove` could open a covering menu, after which the
old interceptor blocked the compatibility `mousemove`. The public call returned
success but the document's menu initialization handler ran zero times. A VM
counterexample uses the actual pinned hover/interceptor with simulated DOM/native
events; it is not browser evidence. A narrowly scoped candidate lets that later
mousemove propagate only for hover with a ready receipt and without trial event
blocking; click interception stays intact. The final browser cover-menu case
also verifies exactly one natural initialization.

## Browser checkpoints

- Focused `2mzRnT`: 8/8, actual exit 0. Six original POST bodies/6704 bytes,
  six actual native moves, thirty synthetic ACK drops and four Shift key commands.
  The covering menu initializes exactly once. Original drop-all calls fail with
  exact-scope wire errors; the actual ACK-held case waits 10012ms before Pause
  cleanup fails, then explicit release/Retry/Resume succeeds. Eight exact tabs and
  targets are gone. Focus coverage 43671ms has no activation/focus/allowances.
  Independent review checked raw bytes/nonces/frame processes, 354 source hashes,
  44 staged files and SDK hashes. Original host EOF exit 0; browser graceful exit
  is not recorded. Sentinel viewport height change is retained.
- First full `3Ui8x6`: 127/128, actual exit 1. All original 126 names/order pass;
  only the new Pause fixture fails because it assumes wire timeout equals the
  caller's literal 1000ms. Actual caller start is one millisecond before wire
  arrival, and SDK `#sendRequest` legitimately deducts that preparation time,
  forwarding 999ms. This failure is retained, not relabelled as success. Focus
  coverage 288227ms passes with the existing 12 activation/four control-popup
  allowances only. Cleanup of the failed fixture still succeeds.
- The fixture correction validates the conservative interval
  `max(1, B - (wireAt - callerStartedAt)) <= wireBudget <= B`, with positive
  integer budget and wire arrival before the original deadline. This rejects
  budget expansion, unexplained shortening and expired sends without inventing
  IPC timing tolerance. It cannot separate SDK preparation from transport time;
  original same-scope backend errors and caller/Pause timing checks remain.
  Production budgets and input code do not change for this correction.
- `JMRbPW`, the second focused run, is 7/8 with actual exit 1. Its only failure
  compares Chromium's response timestamp with Node's caller-settlement timestamp;
  they differ by one millisecond in the opposite order despite the identical
  backend error arriving through SDK `#handleMessage`. It cleaned up successfully.
  No millisecond tolerance is added. Instead, an optional NativeHostBridge observer
  records exact requests/responses in the caller's Node clock before forwarding;
  budget and response/caller timing use that domain. Worker evidence still proves
  actual input/held-ACK sequence and is cross-checked by message ID, scope, budget
  and error. Earlier artifacts without relay evidence are not retroactively passed
  by this stronger oracle. The bridge's eight tests check forwarding order,
  unchanged payloads, disconnected-port exclusion and observation failure.

## Final acceptance

- Final focused `TTV0uq`: 8/8, actual exit 0. The final Node relay oracle verifies
  exact request/scope/budget/backend errors and the final stopped trace. Six
  original POSTs/6704 bytes, six actual moves, thirty controlled ACK drops, four
  Shift commands and eight exact tab/target removals pass. Pause fails in 10015ms
  while actual ACK publication is held; explicit recovery succeeds. Focus is
  continuously observed for 43538ms with zero activation/focus/allowances.
- Final full `Ghqqmo`: 128/128, actual exit 0, on the same frozen 354-source
  checkpoint. The prior 126 names/order remain intact. Its hover cases have
  twenty-nine controlled ACK drops, six actual moves/POSTs totaling 6704 bytes,
  four Shift commands, eight exact removals and a 10006ms Pause failure followed
  by successful recovery. No late relay duplicate/overflow is hidden by an early
  snapshot. Focus spans 302099ms with only the original twelve task-window
  activation/four control-popup allowances. Sentinel selection persists while
  its height changes; no claim of stable viewport or other-app foreground state.
- Final suites: extension 1146, build 204, integration 1202, total 2552/2552;
  actual exit 0, no skip/cancel. Staged extension, source, SDK and reused host/
  helper/runtime hashes match. Full deliberately terminates its first host;
  the replacement ends normally with EOF exit 0. Exact private browser/profile
  and host matches are absent afterward, not a graceful-browser-exit claim.
- Published preview ZIP hashes remain unchanged. Contracts, architecture,
  acceptance matrix, quality notes, history and release notes now describe this
  completed implementation and its bounds. The complete P01–P15 goal remains open.

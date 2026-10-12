# Locator hover delivery

## Contract

Ordinary locator hover on idle input requires both the original native move ACK
and an event-time receipt in the original element's utility-world interceptor.
The receipt accepts a trusted primary mouse `pointermove` with no held buttons,
the original composed target and a local hit at its actual fractional position.
It does not compare that position numerically with an approximate frame point.

Unlike a click's preparation, hover is complete when that movement arrives. It
does not require enabled state, and the event may legitimately disable, move or
remove its target, or open a menu that covers it. The hover-specific receipt
retains that event-time result instead of repeating click's post-move geometry,
enabled/stable and local-hit checks. An already delivered hover is not repeated
because the later upstream mousemove interceptor sees the menu. Click's existing
pre-press receipt and subsequent checks remain unchanged.

Once a guarded hover has its event-time receipt, the same move's compatibility
`mousemove` propagates normally even if the pointer handler just opened a covering
menu. Otherwise a public success could hide missing menu initialization. This
exception is hover-only and does not disable trial blocking or click interception.

Missing delivery can retry after the preceding native move settles, using the
original actionability cadence and total deadline. The native route remains the
root mouse route, including OOPIF and transformed frames. There is no coordinate
jitter, direct child input, wheel flush or renewed action deadline. Preparation
movement itself can have page effects; retries are not pure reads.

## Input ownership and recovery

The original attachment, progress and utility context are checked before native
movement and after its ACK/receipt read. A private process-local ticket is shared
with raw CDP input accounting; foreign input invalidates it. Per-attempt modifier
baselines are restored while authority remains live. If actual native input
rejects, the original attachment retains that error until explicit release
completes; ordinary dispatch cannot assume a failed modifier change never arrived.

Hover admission distinguishes confirmed pre-held keys/buttons from unconfirmed
input intent. Each held identity is marked confirmed only after its own native
ACK. A previous key ACK cannot confirm a newer intent with the same key name.
In-flight native work, durable writes, errors, active guards, cleanup resources,
drag state and touch state cannot enter the pre-held compatibility path.
Known pre-dispatch guard rejection retains its original error, and an unsent
key/button intent is still not a confirmed hold.

Force/trial and confirmed pre-held input retain their upstream hover behavior;
they do not gain this new delivery guarantee. Idle guarded movement avoids the
unneeded drag-interception path. Unknown actual outcomes are retained by the
existing journal, attachment replacement and release barriers. A positively
destroyed original attachment cannot poison its successor with a late error.

The original interceptor stop remains upstream best effort: its evaluation can
fail while the public operation succeeds. The claim is native move ACK plus
target receipt, not confirmed stop ACK. Listener/ticket cleanup compares original
identities, so old cleanup does not remove a successor's listener or admission.

DOM events do not contain native request IDs. Trusted target receipts are
readiness evidence, not authentication of the input source; a user-generated
event during the same observation window cannot be categorically excluded.

## Verification

The baseline deterministic probe executes the actual patched pinned CRX hover
method, resolving mock transport ACKs while dropping page move events. It returns
`done` for missing-first and missing-all delivery, and assertion mode exits 1.
Three production patch regressions also fail before the fix, including an actual
pending Promise with cancellation. These are controlled VM counterexamples,
not natural Chromium/Viz failures.

The intermediate candidate also returned success while blocking a covering menu's
compatibility mousemove initialization. Two actual pinned-bundle VM regressions
failed against that candidate (202/204 build tests), then passed with the dedicated
hover exception (204/204). Extension tests passed 1146/1146 and final integration
helper tests 1202/1202: 2552 total, actual exit 0, no skip/cancellation. Related
subsets and earlier fixture versions are not counted again.

### Focused browser evidence

Windows Chromium 156.0.8078.4 run `TTV0uq` passed all eight selected runner cases,
actual exit 0. `js-hover-delivery` contains seven scenarios, with a separate
`js-hover-native-pause`. Existing raw navigation, mouse/keyboard, ordinary/counting/
transformed pointer and drag controls also passed.

| Scenario | Deliberately dropped moves | Actual native moves | Original POSTs | Result |
| --- | --- | --- | --- | --- |
| Root, explicit Shift | 1 | 1 | 1 | Both attempts restore their modifier baseline |
| Same-origin frame, disabled target | 1 | 1 | 1 | Disabled hover opens its menu |
| OOPIF, covering menu | 1 | 1 | 1 | One trusted compatibility move initializes the menu |
| Transformed OOPIF, target moves | 1 | 1 | 1 | Target movement does not replay delivered hover |
| Root, target removes itself | 0 | 1 | 1 | Removal does not replay delivered hover |
| Root, all delivery dropped | 13 | 0 | 0 | Original 5000ms call fails in 5017ms |
| OOPIF, all delivery dropped | 13 | 0 | 0 | Original 5000ms call fails in 5009ms |
| Root, actual ACK publication held | 0 | 1 | 1 | Deadline fails, Pause blocks, explicit recovery succeeds |

Six original POST bodies total 6704 bytes, independently decoded and hashed with
their original document/node nonces. Native frame/process IDs establish same-origin
co-location and real OOPIF separation; twelve distinct document nonces were read.
Thirty-six selected mouse commands comprise thirty synthetic ACKs and six actual
native moves, plus four actual Shift key commands. No mouse button input occurs.
All-drop cases also retain the exact original-scope backend wire error and an
independent all-Input observer; SDK-only timeout or a mouse-only recorder cannot
satisfy the checks.

The held case observes actual native move success before delaying Promise
publication. SDK preparation reduces the requested 1000ms to 999ms; the original
backend timeout returns to the caller in 1516ms, not a claim of precisely 1000ms
wall-clock response. Actual Pause waits 10015ms and fails with
`OBU_AUTOMATION_CLEANUP_TIMEOUT` while the original
publication remains held. Premature Resume fails; release drains the single move,
Retry Pause/Resume succeeds and the old scope stays stale. All eight exact tabs
and debugger targets are absent after cleanup, with zero cleanup errors.

The focus ledger spans 43538ms with no tab activation, window focus event or
allowance. The sentinel stays active; its viewport height changes from 1222 to
1165 and is retained in the evidence rather than described as unchanged geometry.
Ordinary browser teardown kills the test process and does not prove graceful
browser exit.

### Timing evidence and retained failures

The final fixture uses a bounded exact-scope observer in the same Node process as
the caller, synchronously before the NativeHostBridge forwards each message.
Worker/native evidence still checks actual input, held-ACK sequence and document
effects. Both observers must agree on request ID, scope, budget and error, and the
caller must receive that exact backend error. SDK-only timeouts do not qualify.
The final stopped relay trace is rechecked after recovery, so an earlier good
snapshot cannot hide a later duplicate response or overflow.

For requested budget `B` and Node-observed elapsed time `e` before the original
request reaches the relay, the wire budget must be a positive integer in
`[max(1, B-e), B]`, with `0 <= e < B`. This conservative interval accounts for
preparation/transport without claiming the private SDK send instant or adding an
IPC allowance. Response/caller timing uses only Node timestamps; worker timestamps
are retained separately and are not compared as sub-millisecond causal evidence.

Earlier focused `2mzRnT` passed 8/8, actual exit 0, before this stronger observation.
First full `3Ui8x6` remains 127/128, actual exit 1: its new Pause fixture incorrectly
required wire budget exactly 1000ms despite legitimate SDK reduction to 999ms.
All original 126 tests pass in their original order. The next focused `JMRbPW`
remains 7/8, actual exit 1, because it compares Chromium and Node wall clocks;
the response and caller timestamps differ by one millisecond in the opposite
order. Their exact error messages match and cleanup succeeds. Neither failed run
is relabelled by replaying its old artifacts, which lack the final Node relay.

### Full browser regression

Final full run `Ghqqmo` passed 128/128, actual exit 0. Removing only the two
new hover runner cases leaves all 126 previous names in exactly their original
order. Its hover cases independently retain six original POSTs/6704 bytes, six
actual moves, four Shift commands, twelve document nonces and eight exact
tab/target removals. This run has twenty-nine synthetic ACK drops (twelve in
root all-drop and thirteen in OOPIF all-drop), not the focused run's thirty.
The held case uses a 1000ms wire budget, returns the exact backend error to the
caller in 1524ms, and Pause fails after 10006ms while publication is still held.
Explicit recovery and the final stopped relay trace both pass.

The full focus ledger spans 302099ms and retains only the existing twelve
task-window activation and four control-popup focus allowances. No hover
allowance was added. The original sentinel stays selected; its viewport height
changes from 1222 to 1203. The host restart case deliberately terminates the
first host; its successor ends through normal EOF with exit 0. Exact private
profile/host process matches are absent after completion. This is not evidence
of graceful browser shutdown or foreground state in other applications.

### Scope and remaining work

The fixture deliberately separates dropped sends with synthetic ACKs from held
publication of an already fulfilled native ACK. These are controlled faults,
not natural compositor failures or naturally pending native dispatch. The ordinary
runner's loopback Native Port adapter and direct backend Pause checks do not
replace native installation or popup UI acceptance. The extension is rebuilt
privately; unchanged host, Go helpers and SDK/runtime binaries are hash-verified
and reused, not claimed rebuilt. The focused and full runs use the same frozen
354-source checkpoint, with staged extension and SDK hashes independently checked.

Force/trial and confirmed pre-held input keep legacy behavior; other browser brands,
native worker/host interruption with a held hover, wider CSS/DPR cases and full
P01–P15 parity remain open. Published preview ZIPs remain unchanged.

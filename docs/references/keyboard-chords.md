# Keyboard press validation and failure handling

This P06 change rejects invalid chords before input and retires uncertain
partially executed input on its original attachment.

## Contract

The pinned Playwright CRX keyboard parser validates every token before the first
native key command. Locator press also validates before focusing its target.
`OBU_KEYBOARD_PRESS_INVALID` includes the original invalid-key description and
does not release the attachment or change previously held input.
`OBU_KEYBOARD_PRESS_REJECTED` likewise denotes refusal before press starts,
including unavailable original-action admission. Classification uses the
wrapper's first keyboard code, so a key name or nested cause containing another
error-code string cannot turn an invalid request into attachment cleanup.

Valid syntax, platform aliases, literal `+`, repeat behavior and the original
successful press down/up order retain the pinned runtime's semantics. This is
not a new promise that a successful chord preserves every previously held key:
keys included in the chord retain their existing release behavior.

Once execution begins changing keyboard state, an uncertain outcome is a
separate `OBU_KEYBOARD_PRESS_UNCONFIRMED` failure. The engine releases input on
the original attachment and returns the failure. It does not replay the chord,
guess that rejected native input had no effect, or silently turn it into text.
Release includes pre-existing input on that attachment; it cannot reconstruct
an unknown previous physical state. Cleanup failure remains blocking.

## Lifetime and scope

Production press uses a private input ticket that captures the original action,
attachment and deadline. Confirmed pre-held keys or buttons can be admitted;
pending, unknown, foreign guarded input and unfinished cleanup cannot. Each
native command rechecks the ticket after asynchronous policy/storage work.

Actual native completion stays in the shared input tracker. Caller timeout is
not cancellation of an already submitted native command. Late completion may
allow cleanup of the original input but cannot authorize more chord input or
release a successor attachment. The same guard covers the press calls made by
typing; fill's Delete reuses its existing fill ticket.

Validation is separate from delivery. This change does not add a DOM receipt to
every keyboard command, prove business persistence from an ACK, or roll back
page side effects from a key that was already delivered.

## Verification

The baseline reproduction runs the actual pinned Keyboard/RawKeyboard classes
with the production engine and shared tracker in a VM. Invalid
`Control+DefinitelyNotAKey` leaves Control held; a subsequent `a` has native
modifier mask 2 and empty text. A zero-modifier expectation fails before the fix.
This is a runtime unit reproduction, not browser acceptance.

Browser coverage uses public keyboard and locator entry points, root and
real out-of-process frames, exact native commands, original DOM events and
business POST bytes. Invalid input must have no native key commands, followed
by an explicitly requested valid action that works on the original document.
Raw-CDP held input is labelled separately from Playwright's internal held state.

Controlled partial failures retain a real first key-down ACK before rejecting
its delivery to the runtime. These verify cleanup after an uncertain outcome;
they are not a natural browser failure or native installation test. Existing
focus and cleanup gates remain unchanged.

Run `node scripts/browser-integration/run.mjs` with the standard browser/host
prerequisites; `OBU_TEST_CASES=^js-keyboard-chord$` selects the new entry plus the
mandatory raw-navigation control. Original evidence is retained in
`keyboard-chord.json`, `keyboard-chord-server.json` and the existing focus ledger.

## Acceptance results

The original pinned-runtime defect and the error-code-in-key cleanup defect each
have retained actual-exit-1 regressions. Final build tests passed 265/265;
extension tests 1233/1233; integration scripts 1376 pass and one existing Windows
symlink skip. All processes exited 0 with no failed or cancelled tests. The new
25 pinned-runtime tests compare legal native sequences on win32 and darwin and
exercise four native failure positions, deadline, late ACK, journaling,
pre-held keys, inherited fill tickets and pointer modifier compatibility.
Platform simulation is not macOS browser acceptance.

Focused real Chromium run `l3BraN` passed 9/9 entries, actual exit 0, with unchanged
source/runtime hashes. The keyboard entry contains nine scenarios: root/OOPIF ×
keyboard/locator invalid calls, two literal-plus workflows, raw-held Shift, and
two controlled partial failures. Five invalid phases produced zero native input
and unchanged original document evidence. Two partial failures preserve the
actual first Control ACK, controlled rejection, original keyup ACK, error reply,
and detached original target before explicit recovery. Failure observation
extends 250ms beyond the original 2000ms action deadline without chord replay.

All nine workflows subsequently submitted exactly once: nine original POSTs,
36074 bytes, with original document/node identity, exact values and byte hashes.
The phase probes contain 32 actual key commands, including the cleanup/recovery
and separately labelled raw-held input. Nine exact tabs/targets were closed and
the probe removed. The 74999ms focus ledger has no activation, window focus or
allowance; the original host ended with EOF exit 0. The focused run also passed
existing fill, hover/Pause, pointer, counted-pointer, drag and raw-navigation
regressions. These results do not complete the full P01–P15 capability matrix.

Complete Chromium run `BGZwxy` passed 130/130 entries, actual exit 0. The previous
129 entries retain their names and order. The same nine keyboard scenarios
again produced nine exact POSTs/36074 bytes and 32 native key commands, with
unchanged source/runtime hashes and complete original-tab/target cleanup.
Its 350576ms focus ledger contains only the existing 12 explicitly attributed
tab activations and four control-window focus events; no new allowance was
added. The native-host restart test intentionally terminates its original host;
the exact successor exits 0, and all native connections close. These controlled
loopback runs do not replace ordinary native installation or broader platform
acceptance. Delivered preview packages are unchanged.

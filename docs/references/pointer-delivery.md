# Pointer delivery before a locator click

This patch addresses evidence from the Windows dynamic OOPIF chooser failure
`OBaCi6`: the parent document received a complete move/down/up/click sequence on
its iframe element, while the child document's bounded pointer ledger was empty.
Those ledgers were read after failure and do not identify the precise native
request or the hit-test data that Chromium used at click time.

## Preparation and commitment

Production ordinary single locator clicks without force, trial or modifiers
prepare a move receipt in the original element's utility-world interceptor.
This receipt is separate from Playwright's existing press interception result:
accepting a move must not disable hit checks for later button events.

The original root-route move must settle and the original target must receive a
trusted mouse `pointermove` in the current observation window before buttons are
sent. Its composed path must include the original retargeted node, and a local
hit test at its actual fractional client coordinates must still hit that node.
The same progress deadline, actionability, frame/context identity and ancestor
checks remain in effect. A missing receipt can repeat preparation at the native
actionability retry cadence only before any button was submitted and after the
previous move settled. These moves can cause hover effects; they are not pure
reads. There is no wheel flush, coordinate jitter, child direct route, renewed
timeout, or replay of a submitted click.

The action commits immediately before invoking down. Down and up are awaited
sequentially on this path. A native error or an explicit hit-interception failure
after commitment is terminal, rather than re-entering the locator retry loop.
The engine releases uncertain held input through the original attachment tracker.
Normal navigation retains the upstream completion handling when the old utility
context disappears; this is not an assertion of a final application receipt.

## Input ownership and limits

The shared raw-CDP/CRX input tracker issues an attachment-specific private ticket.
It refuses to start over held, in-flight, or unconfirmed input. An intervening
untagged native Input command invalidates it. The ticket is carried by an
in-process WeakMap, never by wire parameters or a page-visible token. The original
deadline and authority are checked again immediately before the native send,
after any transfer, site-access or journal wait. Closing a ticket does not erase
an outstanding native operation or release a successor's ticket.

DOM events contain no CDP request ID. `isTrusted`, the original target and an
observation window are readiness evidence, not authentication of the input
source. A user's mouse event on that target during the window cannot be ruled
out, even at a different position within the target. A move receipt also
does not reserve Chromium's routing for the later press. The existing ancestor
hit-test shortcut for transformed frames is unchanged; retaining root routing
does not prove every transformed ancestor was checked.

Forced/trial/modifier/multiple clicks and raw mouse, drag and touch operations
retain their prior behavior in this slice. They remain part of the broader
parity objective. This patch does not assert complete input reliability or
overall Codex parity. The previously published preview ZIP is unchanged.

## Coordinate boundary

Do not compare the move event numerically with Playwright's `framePoint` using
a fixed pixel tolerance. The pinned CRX derives that point from bounding boxes
and integer-parsed iframe border/padding; Chromium converts native coordinates
through its frame layout. These are different calculations. In diagnostic run
`9FyKTv`, an actual trusted move on the intended OOPIF button reported (306,19)
while the predicted point was (306.28,20.33). A same-origin form button similarly
reported (49,146) against (50.663328,147.240813). The former ±1 comparison rejected
all attempts before the final geometry check.

Chromium 156's [MouseEvent getters](https://raw.githubusercontent.com/chromium/chromium/156.0.8078.4/third_party/blink/renderer/core/events/mouse_event.h)
floor client coordinates, while [PointerEvent getters](https://raw.githubusercontent.com/chromium/chromium/156.0.8078.4/third_party/blink/renderer/core/events/pointer_event.h)
retain fractional move coordinates. Its [native coordinate conversion](https://raw.githubusercontent.com/chromium/chromium/156.0.8078.4/third_party/blink/renderer/core/events/mouse_event.cc)
uses the frame layout and zoom. The receipt therefore checks the actual local
pointer position and target without inventing a cross-frame numerical identity.
The root dispatch point and upstream ancestor hit tests are retained. A second
upstream frame check must still return the same `framePoint` as before the move;
this guards observed geometry changes, not precision equivalence with the event.
When that point is available, the final receipt also rechecks its local hit,
alongside the actual received point. A hover-created overlay covering only the
predicted press position must not pass merely because the earlier move hit.

This is a deliberate target-readiness contract. It cannot establish that an
event came from a particular CDP command or that later input will use the same
route. The old ±1 rule could not establish those properties either.

## Validation

Deterministic native-bundle and tracker tests cover readiness ordering, current
attempt identity, delayed native replies, late authority checks, foreign input
and once-only button commitment. A controlled browser fixture discards the first
move with an explicitly synthetic ACK, then verifies a real child move before
one down/up and one business POST. Dropping every move must send no buttons.
This models a missing receipt and is not a reproduction of Chromium's natural
Viz failure. Ordinary chooser and navigation regressions remain required.

The first candidate's full run `hb2m29` failed 11 frame/form cases (100/111).
Stage-only receipt diagnostics `9FyKTv` then exposed the coordinate rejection
above. Those failures are retained. After correcting the target-readiness
contract, ordinary affected cases `Zth7Xv` passed 14/14 and the full unchanged
111-case sequence `FjHwEx` passed 111/111. Node tests passed 1544/1544. Controlled
success also requires a trusted mouse pointermove with zero held buttons before
press, and a real down ACK before up invocation. The all-moves-dropped case must
exhaust its original five-second budget with no buttons or business POST.

A deterministic planned-point-only overlay test leaves the deadline live until
the actual retry occurs. An in-memory negative control bypassing the final
receipt status sends buttons and is detected, so a timeout cannot masquerade as
proof of the pre-press gate. These are bounded acceptance results, not proof of
natural Viz routing recovery or complete Browser Use parity.

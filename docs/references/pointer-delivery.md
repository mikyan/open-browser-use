# Pointer delivery before a locator click

This patch addresses evidence from the Windows dynamic OOPIF chooser failure
`OBaCi6`: the parent document received a complete move/down/up/click sequence on
its iframe element, while the child document's bounded pointer ledger was empty.
Those ledgers were read after failure and do not identify the precise native
request or the hit-test data that Chromium used at click time.

## Preparation and commitment

Production locator clicks, counted clicks and double clicks without force or
trial prepare a move receipt in the original element's utility-world interceptor.
Explicit modifiers are supported when no input was already held at admission.
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

The action commits immediately before invoking the first down. Every down and up
is awaited sequentially, with `clickCount` increasing from one through the
requested count. The requested delay remains between down/up and between pairs;
all waits use the original deadline. A native error or an explicit hit-interception failure
after commitment is terminal, rather than re-entering the locator retry loop.
The engine releases uncertain held input through the original attachment tracker.
Normal navigation after the final up retains the upstream completion handling
when the old utility context disappears; this is not an assertion of a final
application receipt. Double click retains its upstream disabled navigation wait.

Before each later down, the ancestor hit check is repeated at the original root
point, and its resulting frame-local point is compared by the original receipt.
This rejects an observed iframe translation or ancestor cover as well as a
removed node or lost local hit. These are additional reads, without another
move, scroll or locator resolution. The upstream transformed-frame shortcut
still cannot prove all transformed ancestors. An already observed pending navigation in
the target frame or an ancestor is also terminal. These checks cannot predict
future native navigation messages or atomically lock the DOM until dispatch.
Once any down was submitted, no preparation or button sequence is retried.

Each attempt snapshots its modifier baseline before setting keys. Optional
private arguments carry the same ticket through Keyboard and native keydown/up.
A `finally` restores that baseline even when preparation returns for retry or
modifier setup partially fails. If the deadline, context or authority is lost,
ordinary key dispatch is blocked and the engine uses its existing attachment
cleanup. An action error remains primary if restoration also fails. An unknown
native keyup remains held in the tracker until actual release is confirmed.

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

Forced/trial clicks, clicks starting with already-held modifiers, and raw mouse,
hover, drag and touch operations
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

Counted-click coverage adds an independent runner case while preserving the old
three scenarios and their seven rendered HTML documents byte-for-byte. Four
fresh pages exercise root double click, same-origin triple click with Shift,
OOPIF double click with Shift after a deliberately dropped first move, and a
first-click top navigation with the public 150ms delay. Native records require
every previous button ACK before the next invocation; each modifier interval
contains exactly one preparation move, with buttons only in the final interval.
Deleting an intermediate restore/setup pair is a rejected negative control.

Focused run `vulf6j` passed all three runner cases. Its four new scenarios
delivered respectively 2/3/2/1 click events and 1/1/1/0 double-click events, with
one original POST each and matching visible counters on the non-navigation
pages. The navigation changed the native root document and returned a terminal
pointer-context error after only the first button pair; the destination received
no second click. The controlled OOPIF case had two separate Shift intervals,
one suppressed move and one real move. The 8,860ms observer interval recorded no
activation or window-focus events. Node tests passed 1569/1569, without skips.
These observations are bounded to the isolated Windows Chromium test profile;
the native host uses the harness's declared loopback bridge, not the installed
browser launcher. They do not establish atomic DOM/navigation checks, arbitrary
modifier combinations, broader platforms or complete input parity.

The first full counted run `NNr3Bp` was 111/112, with all prior 111 cases passing.
Its new navigation check read the old loading tab/document just after the server
received the destination request. Only move/down1/up1 were sent and acknowledged,
and the action rejected the observed pending navigation in 347ms. A server GET
is not document commitment; the old run does not prove eventual success or
failure. The fixture must observe the actual destination URL, new active native
document and completed load within the original action's remaining five-second
budget, retaining the native probe and never resubmitting input.

The final observation helper checks the same deadline in the worker before and
after each native read. A late result after the outer timeout cannot append a
sample or report commitment; a read already dispatched is not claimed cancelled.
Its 28 deterministic fixture tests include held reads and late worker entry.

Review also found a separate production gap: the first click could translate
the iframe while the original local receipt remained ready. Three actual pinned
bundle negative controls on the old counted candidate failed to reject ancestor
cover, changed framePoint and frame disconnection. The later-down ancestor check
described above fixes these cases; tests also cover the third pair and revocation,
deadline or context loss while that check waits. Final delivery/transport tests
passed 50/50, independent delivery/transport/tracker tests 75/75 and the full Node
suite 1581/1581. These deterministic checks do not establish universal transformed
frame coverage or atomicity between observation and the native send.

Final frozen focused run `uLGdWq` passed 3/3 and full run `WLM6bV` passed 112/112,
both with confirmed process exit zero. The prior 111 names and relative order
were preserved. Independent audits checked all 27 native Input invocations and
their acknowledgements, the four unique POST bodies (19,723 bytes in the full
run), trusted events and visible counters. The navigation case confirmed a new
active root document and completed load 350ms after action start, within the
original 5,000ms budget; no later button pair or destination click occurred.

The focused observer recorded no activation or focus events in 8,283ms. Full
coverage lasted 212,803ms and contained only the original 11 activation and four
control-popup focus allowances. Sentinel identity and selection were unchanged,
but its viewport height changed from 1222 to 1202. The four task tabs were absent
from the final inventory; there was no final debugger-target inventory to make
a separate target-release assertion. The expected host restart ended with the
new host exiting zero. All 50 production members were independently reconstructed,
and staged differences were limited to the declared native adapter, CSP and
observer. These are isolated-profile results; installed-browser and overall parity
limits above remain open.

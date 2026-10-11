# Drag delivery and commitment

## Confirmed old behavior

The frozen `64a45eb` production run `WUVqsn` returned success for all seven
public `dragTo` calls. Independent native and original-document observations
show two real errors:

- Moving the source on the first trusted hover left the old point over a trap.
  Native down sequence 3 at (125,110) reached that trap and emitted an incorrect
  3710-byte business POST. A second native down, sequence 11 at (285,110), reached
  the original source, with no release between the two downs. The action still
  returned success. This is a committed retry, not only a coordinate mismatch.
- Replacing the destination during the original source down caused the later
  locator resolution to choose the replacement node. That node received a
  trusted drop and submitted an incorrect 6405-byte POST; the action succeeded.

The initial-cover scene submitted native drop and returned success, but the
browser emitted no business drop or POST. It proves missing rejection of the
changed target, not an incorrect application submission. The late-cover scene
requires a second dragover: old production emits only one, so that mutation did
not occur. Its correct 4767-byte POST is not a bug counterexample. The root HTML,
transformed OOPIF HTML and captured-pointer controls pass. Raw POST bytes and
hashes, original document IDs, trusted events, and exact native invocation/ACKs
remain available separately from the producer's 3/7 pass flags. The entire
2587 ms focus coverage has zero activation/focus events or allowances.

## Internal geometry counterexamples

The intermediate seven-scene candidate passed its focused run `Uo9fdU`, but
those scenes used implicit destination centers. New explicit-position scenes
retain the original seven scenes and nine HTML documents byte-for-byte and add an independent
12×12 padding-local hotspot, a browser-rendered zero-size marker and authored
plane arithmetic. Source and destination positions are (24,20) and (40,30).

Frozen intermediate production `7ZpaaO` passed the unchanged seven controls
and the explicit-position positive control. Both late-geometry cases still
returned success and made an incorrect business submission at root (474,244):

- Individual CSS `rotate:180deg` in native drop's second dragover leaves the
  170×110 border AABB and computed `transform:none` unchanged. The correct marker
  moves to (556,286); the actual local point is (122,72). The wrong POST is 10242 B.
- Left/top border widths changing from 4 to 24 px keep the same border AABB but
  move the padding origin. The correct marker is (494,264); actual local position
  is (20,10). The wrong POST is 10238 B.

Both preserve the original node and document. Thus node identity and an AABB
alone cannot establish the intended internal drop location. The two failures
remain recorded independently of the original frozen `64a45eb` baseline.

## Implementation

Ordinary drag operations bind both original locator handles before pressing.
The source reuses the trusted-move receipt with original context, frame,
ancestor hit tests and full element geometry. Only preparation before the first
down may repeat. A submitted down permanently commits the operation: errors
must not re-resolve either node or replay the gesture.

The destination is checked again after native dragenter/dragover. The native
drop command itself emits another dragover before drop; remote prechecks cannot
run inside that command. Original-document utility guards therefore check the
node, its local ancestor geometry and hit location at DOM drop delivery.
Earlier page capture listeners may already observe the event. This is not an
atomic lock or rollback of arbitrary page event handlers.

The local geometry fingerprint includes resolved individual transforms,
transform origin/box, borders, padding, box dimensions, perspective/motion-path
inputs and local ancestor/viewport scrolling. It detects the same-AABB hotspot
counterexamples above. Paint-only color and shadow changes do not invalidate it.
This is a finite set of observable layout inputs, not a cross-frame atomic
layout snapshot or a proof of all CSS and viewport combinations.

One private attachment ticket accompanies mouse and DragManager Input calls,
including interception setup and drag events. Pointer capture may legitimately
route moves and release to the source. It must not be treated as failed merely
because the destination has no click-style move receipt. Force/trial and
pre-held Playwright modifiers or mouse buttons keep the inherited branch;
they are not covered by the new ordinary-action guarantees. Other tracked held
or unconfirmed input is rejected by admission, rather than silently joining an
existing gesture.

## Cancellation and cleanup

CRX interception can bypass Chromium's native DragController, so a successful
`Input.cancelDragging` alone does not prove the intercepted HTML drag was
cancelled. Cleanup sends an explicit dragCancel for recorded intercepted drag
state, waits for its native ACK, and then performs existing native/capture and
raw-button release. An unknown completion retains the original state. A release
can invoke page behavior; failed drag does not imply zero side effects.

Guard cleanup is registered on the original attachment before allocation.
Guard allocation currently occurs after the source down, under the existing
durable held-input journal. Actual late allocations remain owned, and failed
or timed-out cancellation/release retains the resource for cleanup retry.
The fixed context-bound cleanup lease works after normal commands are revoked;
it does not resolve a replacement target. Actual native input must settle before
the corresponding drop guards are removed. RPC timeout is not physical native
cancellation. The ordinary resource cleanup is bounded to 500 ms; attachment
release shares its original remaining cleanup budget.

The normal 500 ms resource budget begins after actual drop/up acknowledgement;
it is distinct from the input action's original deadline. Each cleanup attempt
checks its fixed deadline and original attachment before a new native command.
A late cancellation ACK may establish cancellation, but does not grant time for
the next release. Confirmed cancellation is retained separately from confirmed
object disposal. Exceptional remote objects and late guard-read results remain
owned until their release is acknowledged or the original native context is
known to be gone. The actual tracker, media bridge and backend lease were tested
together for late true/exception cancellation results and an exceptional object
release whose ACK arrives after the budget. Explicit retry preserves each
already-confirmed operation rather than replaying it.

After native recovery and a newly admitted ticket, the next guard in the same
utility context retires the old registry entry. A late old cancellation cannot
delete the successor's entry. This has deterministic coverage; actual worker
loss while a drop guard is held still requires separate browser verification.
A retained guard may affect manual drops before recovery. A deadline alone is
not proof that an already-sent drop can no longer arrive, so it is not used as
an automatic guard-removal signal.

## Verification status

The old browser baseline and deterministic tracker counterexamples are proven.
The first candidate `ecV9Op` failed publicly: all four positive actions completed
their correct business submission, but the Frame adapter returned the internal
string `done` to a dispatcher requiring the original void result. The three
negative scenarios rejected with no business submission. All failures and raw
events remain retained. The return contract, cleanup replay and delayed native
resource ownership have since been repaired. Intermediate full run `ls3hTL`
remained 121/122 because the old extended-input assertion accepted only timeout
after the original target was hidden during source down. That check now requires
the exact terminal delivery error, one trusted source down, no drop and zero
held buttons on a subsequent move; missing-target timeout remains unchanged.

Final focused run `rxSklf` passed 2/2 aggregates and all ten scenes. Its transparent
probe records 110 native calls, each with a unique successful ACK: 77 Input and 33 lifecycle calls
for eleven original guard objects. Twelve original documents and HTML bodies,
five correct business POSTs totaling 28630 B and five rejected scenes without
business submission were independently checked. Native internal drop events
observed before the production guard remain in the evidence. The 4328 ms focus
window has no activation, focus event or allowance; all ten task tabs and twelve
fixture URLs disappear on finalization. Node tests pass 1788/1788, with no skip
or cancellation.

Final full run `I0B25O` passed 122/122 with actual process exit 0; the original 121
names retain their relative order. Its ten scenes have the same native/guard and
document counts, five correct POSTs totaling 28633 B, and five rejected scenes
with no business submission. All native ACKs, original POST bytes and exact tab
cleanup were independently checked. The 237777 ms focus ledger contains only
the existing twelve activation and four control-popup focus events, with no new
allowance; the sentinel remains selected in the same window (height 1222→1165).

The 51 production and 53 staged members were independently reconstructed and
verified. After this run, only the generated MODIFICATIONS sentence describing
pre-held input was narrowed to the actual branch conditions above. The final
ordinary package retains the other fifty members byte-for-byte; runtime code did
not change, and the full run is attributed to its original source hashes. The
old published preview ZIPs retain their prior checksums. Go/SDK suites were not
rerun: the 49 existing Go source inputs and eight reused binaries were checked
against their existing build manifest. Full Codex parity remains incomplete. See the
[completed slice plan](../exec-plans/completed/2026-10-12-drag-commit.md),
[pointer contract](pointer-delivery.md), and
[integration runner](../../scripts/browser-integration/README.md).

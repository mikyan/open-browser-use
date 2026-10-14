# Visual delivery cleanup

This slice addresses optional visual messages that outlive their display
timeout. It does not change native pointer input or give visual records tab
ownership. The [execution plan](../exec-plans/completed/2026-10-14-visual-delivery-cleanup.md)
tracks acceptance; the full [parity matrix](../product-specs/browser-use-parity.md)
remains open.

## Why actual delivery matters

A 250 ms Promise race only stops waiting for a cursor update. The original
Chrome call can still complete. Removing a queue or returning from detach does
not establish that its visible messages have stopped. The previous same-turn
sequence watermark prevents stale rectangles from replacing newer feedback
within a turn, but cannot by itself fence later delivery across turns.

`VisualDeliveries` retains the original API Promise together with the original
session, turn, control epoch, tab, document and receiver identity. Cleanup
synchronously revokes producers, joins original operations, and then requires
the original receiver's hidden acknowledgement. The final hide does not inject
a content script or borrow the current page's identity. A rejected or malformed
response remains failed cleanup. Concurrent cleanup calls share pending work;
only explicit recovery can retry an already settled failure.

Each owner may retain at most 128 receiver states, including unknown states
created by failed injection. This is not a count of distinct document IDs.
Capacity is reserved before an original injection/visible call dispatches;
accepting a token for an already-reserved state does not consume another slot.
Actual native pending operations have their own capacity. Failed injection
states are retained until their owner's cleanup, not discarded to free space.
When bootstrap already assigned an injected state's token, accepting that same
state preserves its membership and exact retirement identity. Only distinct
duplicate states are merged. Exact tab removal clears a registered recovery
failure after actual pending work settles, then retires only the backend item
captured at that event; replacement and other-tab items remain untouched.

End, explicit detach and Pause include this work in their existing cleanup
barriers. Pause may reach its deadline and report cleanup failure while the
original Promise remains tracked. Automatic native action failure starts
visual retirement without waiting for it; a subsequent optional display waits
for the old hide within its own display budget. The original native input
deadline is not extended.

## Document navigation and receiver tokens

Each content receiver has a private random token returned by the existing PING
handshake. CURSOR, POINTER_EVENT, TARGET_RECT and CURSOR_STATE must carry that
token. An unknown or retired token cannot show feedback or hide a newer
receiver. This token is internal to visual delivery and adds no public SDK
control epoch.

On pagehide the receiver synchronously revokes its token, hides and destroys its
owned renderer, and reports the retired token. The backend accepts that report
only for a known token and the native sender's original tab/document identity.
After original API operations settle, that receipt can prove the original
receiver is hidden without requiring the old document to remain addressable.
It does not prove document destruction. In particular, disappearance from
getAllFrames is insufficient because it excludes BFCache documents.

On pageshow a restored document receives a new token and stays hidden until new
authorized feedback arrives. Old bootstrap replies, visible messages and
hidden cleanup messages cannot affect that new receiver. Bootstrap responses
also require the original document, token and still-active control scope.

An injection call still participates in actual settlement, even if it rejects
or its caller times out. An unknown receiver's initial bootstrap is hidden;
injection alone does not authorize visible feedback. Cleanup never injects a
replacement script or obtains a successor token as a substitute for the old
one. Missing retirement receipts remain unconfirmed when visible work existed.
Exact tab removal can waive the hide requirement, but cannot pretend a pending
API Promise has settled.

A real counted-click navigation exposed a necessary distinction for the final
pure hide itself. Runs `1ZP1zE` and `IAiP48` time out during finalization; the
latter records one outstanding HIDDEN_STATE sent before the exact pagehide
receipt. All visible messages have settled and the original token is already
retired, but Chromium holds that old hide's reply while its document is cached.
Waiting for that reply prevents finalization from closing the tab.

Only a pure final hide may complete its visual cleanup obligation through that
matching retirement receipt or exact tab removal. Its original Chrome Promise
stays in the actual pending registry and continues to count against capacity
until it really settles. The separate cleanup promise races actual settlement
with exact retirement evidence; both close and previously captured Pause
snapshots wait for this same proof. It is not a timeout, fabricated ACK or
transport cancellation. A restored receiver uses a fresh token, so an eventual
old hide cannot change it. Visible sends, PING, injection and recovery reads
still require actual settlement. A precise retired-receiver PING response also
stops optional display instead of triggering reinjection.

## Cached local frames and worker recovery

The real goto/back workflow exposed a separate existing adapter gap. Chromium
reports the restored local child's Runtime contexts before its root BFCache
navigation, without new child attachment events. Pinned Playwright CRX removes
the previous children and discards contexts for unknown frames. Re-enabling
lifecycle alone therefore lets goBack finish while the next iframe locator
times out. The original three failed runs remain retained.

The frame adapter now retains current native context payloads per CDP session,
removing them on actual clear/destroy or detach. After BFCache navigation, a
native Page.getFrameTree read must still match the original attachment object,
frame graph revision and root loader. Only missing local descendants are
restored to Playwright, parent first, followed by those children's still-live
original context payloads. Real lifecycle reporting is enabled last. No
navigation, input, load event or Runtime restart is fabricated. A stale or
failed tree cannot authorize a replacement frame. This does not establish
OOPIF BFCache restoration coverage.

The extension's getAllFrames inventory omitted a restored local child in the
retained native test. The navigation oracle therefore identifies the visual
receiver by its exact root documentId, and independently checks the native
root/child tree and original loaders. Public child locator wait and hover still
must succeed; missing extension inventory is not treated as child destruction.

After worker replacement, persisted non-idle sessions enter cleanup-only
recovery. Strict owned-tab enumeration, original document lookup and exact
receiver PING precede a token-bound hidden acknowledgement. Recovery never
injects a renderer or grants visible authority. Actual pending lookup, PING and
hide remain in the cleanup barrier; failed work is retained for an explicit
retry. A known absent receiver requires no hide. The real restart test verifies
the exact original document becomes hidden before a new turn begins. Arbitrary
messages still in transport across replacement workers remain a separate
unproved boundary.

The full candidate `RNUG3p` (149/178, actual exit 1) exposed empty PING replies
from documents with the WebMCP listener but no cursor receiver. The separate
diagnostic `1RdokV` preserves three original fulfilled-undefined replies; this
is not an explicit missing-channel rejection. Empty replies alone cannot prove
the absence of a visual receiver.

The cursor script now installs an immutable own-property marker in its private
isolated world before any listener or renderer. It retains that marker across
pagehide. Only a null/undefined recovery PING triggers a read of this property
descriptor in the exact original document. Recovery accepts absence only from
one actual result with matching documentId, frameId zero and result strictly
true. A present marker, missing/malformed result, changed document or rejected
read remains failed cleanup. The actual RECOVERY_PRESENCE Promise participates
in the same barrier. This reads a property; it does not inject receiver files
or create visible authority. The contract is for the current marker-bearing
version and does not establish recovery of legacy receivers after an upgrade.
Exact removal can clear a registered recovery's inspection failure only after
its original calls settle. Removal that predates registration while a stale
tab inventory is in flight remains a conservative failure boundary; an ordinary
lookup error or empty inventory is not accepted as proof of destruction.

Focused `5nIvMm` passes both original navigation and site-access workflows with
actual exit 0 and no source drift. Passive original API records retain three
empty PING replies and three exact-document reads confirming marker absence.
The fourth document has a live receiver and supplies its exact token-bound
hidden ACK. All recorded calls settle and the observer restores without
overflow. This includes real worker replacement and the original policy flow.

## Retained old-source evidence

Production `e52ab0c` fails eleven deterministic backend counterexamples. The
original test source and actual process exit 1 are preserved before production
edits. The late-injection test establishes premature cleanup/repeated injection;
it does not establish that a real bootstrap became visible. With the new
receiver handshake, its relevant requirements are actual injection settlement,
one injection and no post-close visible publication.

Real isolated run `WuXaol` closes with exit 1 and unchanged sources. Navigation
and the original global Pause workflow pass. All three controlled visual cases
finish their original business transactions and cleanup:

- End returns success before the selected call enters Chrome; releasing that
  original call revives the same document's cursor and outline.
- Detach and a successor attach return success before the selected pointer
  feedback enters Chrome; its original delayed call creates a click ring.
- Pause reports cleanupComplete in 12 ms while a wrapper still holds delivery
  of an already fulfilled native response. This case demonstrates premature
  completion, not late drawing by Chrome.

These gates are deliberately different: before-send has not yet invoked the
original API, while after-ACK retains the original fulfilled response. Neither
is evidence of spontaneous Chrome transport reordering.

Independent audit verifies three unique trusted POSTs totaling 7,080 bytes,
six original documents and six original/recovery PNGs. Native screenshot bytes,
cursor/outline pixels and single press/release acknowledgements agree with the
original records. The 13,077 ms focus interval contains only the existing one
auxiliary-window activation and two Pause-popup focus allowances. The original
host exits normally and exact isolated processes are absent. Old artifacts are
preserved unchanged.

## Focused acceptance and remaining boundaries

The new browser workflow checks held original delivery, cleanup failure rather
than false success, successor admission, the exact final hide acknowledgement,
continued hidden state and explicit fresh-turn recovery without replaying the
original submission. A separate real goto/back/End workflow observes original
pagehide receipts and document/token identities. It claims BFCache restoration
only when both the native document identity and pageshow.persisted prove it.

Focused run `sCNVtX` passes 4/4 with actual exit 0 and no source/runtime drift.
Independent raw-artifact checks verify three trusted POSTs / 7,080 bytes, six
original documents, six native PNGs, original receiver tokens, final exact hide
acknowledgements and continued hidden state. The 24,684 ms focus interval has
only the original one auxiliary-window activation and two control-popup focus
allowances. The navigation workflow restores the original root and local child
loaders from BFCache, uses a fresh visual token and ends hidden without any
business POST. Exact isolated processes are absent after normal host exit.

Candidate navigation runs `C9KOaE`, `yMRVhZ` and `KuVhmM` preserve the real
post-BFCache locator timeout; `uwT6n5` proves the locator repair but fails the
old extension-child-inventory assumption. The related filter's first run
`ji5L4r` also omits the existing navigation case that explicitly resumes the
main client after global Pause; it records stale-client rejection, not a
successful full regression. No original failure is overwritten.

The focused stage preceded the complete acceptance recorded below. Ordinary
Edge remains deferred at the user's request. Cross-worker transport, raw-coordinate
leaf highlighting, fullscreen and the wider matrix remain separate boundaries.

Related `gSCbYP` passes all 22 cases with actual exit 0 and unchanged sources.
Independent message/PNG/business/focus/process checks pass; its 96,451 ms
interval has only the original two auxiliary activations and two control-popup
focus allowances. The counted navigation retires the receiver before any
final hide send, so that particular successful run does not reproduce the
delayed-hide ordering. The original `IAiP48` trace independently confirms the
one retained hide before/after failed finalize, while the deterministic
regression verifies the corrected retirement race, including a previously
captured Pause snapshot. Historical Node v5 passes 3599 checks with one existing
Windows file-symlink privilege skip.

Although the first full candidate `RNUG3p` fails later at site-access recovery,
its counted navigation independently verifies the previously retained hide
race: original hide call 315 precedes exact pagehide receipt 322. Before
finalize, the hide cleanup obligation is complete while its actual Promise
remains tracked. Finalize succeeds; the original Promise then rejects at 330
after tab closure. No ACK is synthesized. That passing subcase does not turn
the candidate's 149/178 result into complete acceptance.

Candidate `wH1kmv` completes with actual exit 1 (177/178), with no source drift
or remaining exact isolated process. All new lifecycle and site-access cases
pass. Its only failure is the separately documented
[screenshot oracle's independent wall clocks](screenshot-completion.md);
that candidate remains a failed full run. Receiver-capacity counterexamples
also remain retained. The capacity and oracle changes are verified by later frozen-source runs,
rather than being attributed to that candidate.

## Final acceptance

Final frozen-source run `HZSmT4` passes 178/178 with actual exit 0 and no
source/runtime drift; the original 176 cases retain their names and order.
Independent checks verify the controlled three POSTs / 7,080 bytes, six original
documents and six PNGs, original token-bound hidden ACKs, native BFCache local
frame identity, worker recovery, and original iframe feedback across six layouts.
The latter retains six POSTs / 14,185 bytes and thirteen original documents.
The focus interval is 527,274 ms with only the existing 12 activation / four
control-popup focus allowances and no event inside controlled visual scenes.
Original host exit and exact isolated-process absence are confirmed.

Final Node v8 passes 3620 checks with one existing Windows file-symlink privilege
skip. Original screenshot reply provenance, five screenshot scenarios and seven
native PNGs are independently checked. Capacity, bootstrap self-merge and
registered-tab removal counterexamples pass without deleting original pending
work. Old candidate failures and preview ZIP hashes remain retained.
This full run has no calls in the explicit recovery observer interval; the separate focused 5nIvMm trace supplies the three actual empty-PING/absence-read proofs.
Counted navigation also reproduces cleanup completion while the original pure-hide Promise stays tracked.

Ordinary Edge remains deferred. Arbitrary cross-worker transport, legacy upgrade
receivers, removal before recovery registration, OOPIF BFCache, raw leaf feedback,
fullscreen and the broader parity goal remain open. This slice does not complete
the capability matrix and does not change existing preview packages.

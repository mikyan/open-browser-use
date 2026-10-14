# Original element feedback inside frames

This work addresses the target outline shown when a locator operates inside an
iframe. The original root-document hit-test identifies the containing iframe,
so a successful click can still show the wrong target outline. The intended
outline is the original element's border bounding rectangle in root viewport
CSS pixels, consistent with [element bounds](transformed-element-bounds.md).

Implementation decisions and acceptance are recorded in the
[completed execution plan](../exec-plans/completed/2026-10-14-iframe-target-feedback.md).

## Implementation

The pinned runtime adapter carries a private target from the original locator
geometry through Mouse/RawMouse and the native transport. Default positioning
starts an optional `DOM.getBoxModel` for that original object; explicit position
reuses the border from its existing BoxModel read. The adapter retains the
original renderer maps and validates the same frame tree before publication.
WeakMap/Symbol metadata is never serialized as a CDP parameter, and the public
raw CDP entry does not accept caller-provided feedback authority.

`browser-pointer-feedback.js` retains actual optional reads independently of
input readiness, bounded to sixteen globally and two per attachment. Native
delivery captures the original scope and feedback sequence before the command;
only a successful original ACK admits its display job. Already accepted jobs
keep their order so that a queued press still produces its ring before release.
Old ACKs cannot enter after newer ones. Geometry completion is separately
bounded and requires the latest sequence; it cannot delay the position/ring
queue or replace a newer target.

Every native feedback message names the original root Chrome `documentId`.
The content renderer binds a late rectangle to its current cursor, renderer,
session, turn and sequence. Scroll, resize, hiding or renderer retirement revoke
that receiver. Cached state can restore a position but cannot restore invalidated
exact geometry. Lower or repeated native cursor sequences in the same turn are
ignored. No public SDK method or protocol field is added.

## Geometry and ownership contract

- Use the original locator handle, native objectId, frame/context/session and
  ancestor projection. Do not resolve the selector again after the action.
- Project all four native border corners before taking the root AABB. A local
  bounding rectangle, clipped clickable polygon or padding quad is not a
  substitute for that border. Native content quads can aggregate children for
  inline or `display:contents` elements.
- Keep the actual input coordinates, original action deadline, native delivery
  guards and background behavior. Optional visual work does not replay input,
  activate a tab/window, restore foreground state or block input readiness.
- A visual result belongs to one original action, attachment, document and
  feedback sequence. Equal coordinates do not establish equal identity.
  Publication rejects stale scope, document or attachment evidence; the renderer
  also rejects late rectangle patches and lower cursor sequences in the same
  turn. The already-dispatched cross-turn transport boundary is described below.
- The border is an original-node snapshot when the native BoxModel read executes.
  It does not continuously follow layout changes or prove that the node remains
  connected after a same-document application mutation. Normal handle disposal
  does not invalidate an already captured snapshot; no successor is resolved.
  Projection uses the ancestor maps captured by the original action, not an
  atomic layout snapshot across frames or a fresh transform measurement.
- A known locator with unconfirmed geometry hides its outline. Raw coordinate
  input retains its existing root-document hit-test fallback; this work does
  not claim that raw input has exact cross-origin leaf hit-test evidence.
- Visual timeout and actual native read settlement are distinct. Cleanup must
  retain the original pending read without granting authority over a replacement
  attachment. Existing top-layer, root zoom, rebuilding and print behavior must
  remain intact.
- A BoxModel read acquires no new native resource handle. Automatic action-failure
  detach preserves its existing required-resource/input cleanup and does not wait
  for this optional read. The pending actual Promise stays tracked until it
  settles; Pause, original-session end and explicit detach of the original
  attachment drain it. A late reply from the retired attachment can
  neither publish feedback nor release a successor attachment.

## Original failure

Old production `dc70e99` with the new independent fixture produced `CIf8Ox`:
the mandatory raw-navigation check passed and the frame-feedback check failed,
with actual process exit 1 and unchanged captured sources/runtimes.

All six original workflows succeeded: same-origin, existing cross-origin,
dynamic cross-origin, nested cross-origin, nonuniform scale, and rotated frame
plus rotated button. Each retained its original screenshot and unique trusted
form submission. The original native screenshot ACK bytes and input delivery
passed; all six outlines identified the outer iframe instead of the button.
This is a visual defect, not a failed click or a replayed business operation.

The fixture independently derives expected border corners from authored CSS
planes and passive original-page markers. It checks the button's four outline
edges and excludes extra ancestor-frame outlines. Click rings use passive DOM
geometry associated with the original trusted click; this is not ring pixel
proof. The same original thirteen documents were checked after turn end and
again 572 ms after hiding, with unchanged business state and geometry. Exact
test tabs and child targets were removed.

## Verified correction

The first candidate preserved six successful workflows and six correct leaf
outlines, but failed its nested click-ring check. A newer release ACK had
discarded an already accepted press job. That original failure remains retained;
the correction preserves accepted queue order without relaxing the ring oracle.

Final focused run `k2sWDv` passes 2/2 with actual exit 0. Independent decoding of
all six original native PNGs verifies every expected leaf edge and zero extra
ancestor edges. All six original click rings are present. Six unique trusted
POSTs total 14,185 bytes, with thirteen original document identities and native
ACKs verified. End cleanup remains hidden after 576 ms with unchanged business
state and geometry; all six tabs and six child targets are removed. The 13,056 ms
focus interval has zero activation, focus changes or allowances. Original host
EOF/exit 0 and an independent exact-process inventory confirm cleanup.

Current Node groups pass 3536 tests with one existing Windows file-symlink
privilege skip, all three processes closing with exit 0 and unchanged sources.
Directed counterexamples exercise the full pinned runtime patch chain, original
BoxModel identity, capacity and actual read settlement, action-failure cleanup,
pre-send scope capture, stale ACKs, exact root document routing, accepted ring
order, renderer retirement, cached-state invalidation and same-turn sequence
ordering. Legacy standalone observers retain success-ACK notification and consume
asynchronous rejections without changing native command results.

Related regression `za8xMZ` passes 17/17 with zero activation/focus changes over
77,139 ms. Complete `rkN0eF` passes 176/176 with actual exit 0, preserving the old
175 names/order. Its original six-layout evidence passes again, including a
570 ms end/hide check. The full 536,859 ms observer interval retains only the
existing twelve activation and four control-focus allowances. Source/runtime/
staging/build identity, original keyboard/chooser/download evidence, host
terminal records and exact process cleanup pass independent audit. Existing
preview archives are unchanged; this is not a new packaged release.

## Remaining scope

The six-layout browser task uses the public JavaScript SDK. It does not by
itself prove five-entry coverage, arbitrary raw-coordinate leaf feedback,
fullscreen, native browser UI, ordinary Edge installation, or complete Browser
Use parity. The [capability matrix](../product-specs/browser-use-parity.md)
remains open.

The existing visual transport has a separate, unclosed lifecycle boundary:
its 250 ms display timeout does not cancel an original `tabs.sendMessage`.
Ending a turn removes its queue but does not await that message's actual
settlement. A hypothetical old CURSOR delivered after a new turn in the same
document is not fenced by this slice's same-turn watermark. No native browser
reordering was observed in these runs; this is a source-level protocol gap,
not a reproduced regression. Document-targeted routing prevents delivery to a
replacement document, but cannot establish cancellation within the same one.
Follow-up should first retain a distinct protocol counterexample, then consider
an actual-message settlement barrier and final hide ordering, preserving input
deadlines and explicit cleanup failure semantics. Full lifecycle parity stays
open until that work is proved.

## Native message routing

Checking the old document immediately before `tabs.sendMessage` does not bind
an unspecified destination to that document. Chromium selects the current main
frame when its browser process opens an untargeted channel; an explicit
`documentId` selects the corresponding original frame host. This is a source
level race boundary, not evidence that Chromium retargets an already bound port.
See the [Chrome tabs API](https://developer.chrome.com/docs/extensions/reference/api/tabs#method-sendMessage)
and the pinned [Chromium message service](https://raw.githubusercontent.com/chromium/chromium/refs/tags/156.0.8078.4/extensions/browser/api/messaging/message_service.cc).
Each one-time send uses its own message channel; see the pinned
[one-time message handler](https://raw.githubusercontent.com/chromium/chromium/refs/tags/156.0.8078.4/extensions/renderer/api/messaging/one_time_message_handler.cc).
This source observation does not itself prove actual cross-channel reordering.

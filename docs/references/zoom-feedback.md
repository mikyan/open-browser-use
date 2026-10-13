# Agent feedback on CSS-zoomed pages

The cursor renderer uses viewport CSS coordinates, matching its original input
messages and the target's `getBoundingClientRect()`. Root CSS zoom also scales
the extension's descendant feedback layer. Applying the same viewport numbers
as local CSS lengths without compensation scales the visible feedback twice.

On each actual visible feedback update, the owned host cancels only its root
ancestor's effective CSS zoom. The host is a direct child of `html`, so body or
business-subtree zoom must not be inverted. Target hit testing, cursor movement
models, native input coordinates and original page styles remain unchanged.
The cursor, target outline and click effects share this corrected rendering
tree. It keeps its existing Shadow DOM, manual popover and print exclusion.

The renderer reads `document.documentElement.currentCSSZoom`; when unavailable
or invalid, it reads that root's computed zoom. A failed or invalid measurement
falls back to one. It never derives compensation from the already compensated
host or from a closed popover. Repeated messages do not alternate scale, and
animation frames do not add zoom measurement or polling. A later actual update
rechecks a changed root zoom. Hiding/destroying feedback does not reopen it.

This is CSS zoom support, not a change to browser zoom, device pixel ratio,
native input, fullscreen or pinch-zoom behavior. A page changing zoom after the
last feedback message is not guaranteed continuously refreshed while idle.

## Verification contract

The isolated public-SDK case `js-zoom-feedback` uses three original HTML pages:
root 1.5, root 0.75, and body-only 1.5. The first page also changes to 0.75 through
its own trusted button handler, retaining its document and original controls.
Each of the four stages fills and submits its original form exactly once.

The fixture retains original HTTP bytes, unique document/node tokens, trusted
input/click/submit records and receipts. It waits for renderer model arrival,
not the visible cursor center, so a misplaced baseline still records its actual
PNG and business submission. PNG checks require a cursor at the original button
center and blue pixels on all four outline edges inside a grayscale panel.
Original DOM rectangles independently check cursor/outline alignment.

A passive page observer retains each transient ring's native DOM rectangle and
model point. The unique new ring is joined to the original trusted click and
document; it is not selected by nearest timestamp. This proves transient ring
geometry, not screenshot pixels throughout its animation. Hover/screenshot must
preserve input focus and selection. Turn end must hide the owned layer, cursor
and rings without changing original business state; cleanup uses exact tab IDs.
The existing foreground event ledger and allowances are unchanged.

## Evidence

Unchanged-production `Ku2blX` completed with actual exit 1, preserving four
successful original POSTs and four PNGs. All three root-zoom scenes misplaced
cursor, target and ring geometry; their original cursor-center pixel counts were
zero. The body-only control passed. Source/runtime hashes did not change.
The original module run had 19 passing tests and six new zoom failures.

Fixed-production `pm3Zkp` passes 2/2, actual exit 0 and no source/runtime drift.
All four original submissions and PNGs pass, including the same-document scale
change and unchanged body-only control. Four POSTs total 9,545 bytes. Turn end
preserves the original business state while hiding all three owned layers,
cursors and ring sets. The 3,382 ms observer interval has zero activation/focus
events and zero allowances; startup/teardown are outside that interval.

The three Node groups pass 3,151 tests with one pre-existing Windows file-symlink
permission skip, actual exits zero and no source/runtime drift. The first
module-green run's new test incorrectly expected no existing animation timer;
that fixture failure is retained. Its corrected assertion checks only the
existing animation fallback timers and rejects additional zoom polling.
Complete default regression `AMMJED` passes 149/149, actual exit 0, preserving
all previous `O0mB6k` 148 case names/order and adding only `js-zoom-feedback`.
Source/runtime hashes remain unchanged. Its 428,874 ms observer interval contains
only the original twelve exact sole-tab activations and four control-popup focus
allowances; no allowance is added. This full suite is not a zero-focus claim.
Its four original zoom POSTs total 9,609 bytes, with all original PNG/geometry
and turn-end checks passing. Existing top-layer and both PDF exclusion cases
also pass. The host-restart test intentionally terminates the first host; its
successor exits normally with EOF code zero.
Ordinary installed Edge, other platforms and complete capability parity remain
separate, unfinished requirements.

## Primary references

- [CSS Viewport: zoom](https://drafts.csswg.org/css-viewport/#zoom-property):
  effective zoom multiplies flat-tree ancestor zoom; client rectangles include
  its scaling.
- [CSSOM View: currentCSSZoom](https://drafts.csswg.org/cssom-view/#dom-element-currentcsszoom):
  effective CSS zoom reporting, including the no-CSS-box fallback.
- [Top-layer styling](https://drafts.csswg.org/css-position-4/#top-layer-styling):
  presentation placement is distinct from input and document ownership.

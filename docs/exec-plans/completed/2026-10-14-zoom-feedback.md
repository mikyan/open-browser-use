# Feedback coordinates on CSS-zoomed pages

## Goal and scope

Keep the visible agent cursor, target outline and click rings aligned with the
original viewport input coordinates when a page applies CSS zoom. This advances
P12 of the ongoing Browser Use parity objective; it does not close the full
matrix, fullscreen, native popup focus, pinch zoom or ordinary Edge acceptance.

The current overlay writes viewport positions into CSS lengths below the page
root. CSS zoom can scale those lengths again. Establish a real-browser
counterexample before changing the renderer; preserve the original input route,
document, controls, focus and selection. Do not compensate by changing the
website, input coordinates, browser zoom or foreground window.

## Steps

- [x] Read current repository rules, product matrix and overlay implementation.
- [x] Build an original form fixture with enlarged, reduced and dynamically
  changed root CSS zoom; record original DOM geometry, screenshots and POSTs.
- [x] Run unchanged production through the public SDK and preserve failures.
- [x] Fix only owned feedback geometry and add focused regression checks.
- [x] Verify real pixels, original trusted input/POSTs, turn-end cleanup and
  the existing strict foreground observer; run appropriate related regression.
- [x] Independently review evidence and synchronize documentation for delivery
  through the existing fork; no PR or replacement preview package.

## Verification and risks

Only the root agent launches private browser profiles. Existing observer event
rules remain unchanged; no daily profile or operating-system mouse is used.
Render geometry and PNG pixels must agree, not just internal style values.
Each form action occurs once; a failed action is not replayed to get a pass.
Dynamic zoom must retain the original document and controls. Verify actual
process completion and source/runtime hashes. Preserve old preview archives.

Effective zoom, CSS lengths and viewport geometry have different units. Consult
[CSS Viewport zoom](https://drafts.csswg.org/css-viewport/#zoom-property) and
[CSSOM currentCSSZoom](https://drafts.csswg.org/cssom-view/#dom-element-currentcsszoom).
Top-layer placement and Shadow DOM must continue to avoid application event
interference. A missing browser feature must not turn optional feedback into an
input failure. Counterexamples or limits stay recorded explicitly.

## Progress

2026-10-14: previous goal turn made verified progress (commit `3ec19d4` is on the
fork and the worktree was clean). Manual ordinary Edge setup remains deferred by
the user. Native new-page focus still has no verified suppression seam; this
slice addresses a separate concrete visible-coordinate candidate, not a reduced
definition of overall parity.

Unchanged-production `Ku2blX` completed with actual exit 1 and no source/runtime
drift. Four original submissions succeeded, while all three root CSS zoom
stages misplaced the cursor, outline and original ring rectangles; the body-only
control passed. All four original PNGs and POSTs were retained. Module checks on
the same production source had 19 passes and six new zoom failures. These are
product counterexamples, not an inference from a mock alone.

Fixed `pm3Zkp` passes 2/2, actual exit 0, no source/runtime drift. Independent
PNG/POST/geometry reconstruction confirms four successful original submissions
(9,545 bytes), all original cursor/outline pixels and ring centers, unchanged
hover focus/selection and clean turn-end state. Its 3,382 ms observer interval
contains no activation/focus events or allowances. The three Node groups pass
3,151 tests with one pre-existing Windows file-symlink permission skip; all
actual exits are zero with frozen sources. Complete `AMMJED` passes 149/149,
actual exit 0 with no source/runtime drift, preserving the old 148 names/order.
Its 428,874 ms observer interval retains only the original twelve sole-tab
activation and four control-popup focus allowances. Four zoom POSTs total
9,609 bytes; original PNG/geometry/turn-end and top-layer/PDF regression pass.
The full parity plan remains active; this completes only the CSS zoom slice.

# Agent feedback over HTML dialogs and popovers

The owned cursor, target outline and click rings share a non-interactive manual
popover inside an open shadow root. Actual feedback raises this layer above
HTML modal dialogs and popovers opened since the previous action. Animation
frames, scrolling and resizing do not repeatedly raise it.

The host remains `aria-hidden`; neither host nor layer has autofocus, tabindex,
or delegated focus. The layer and backdrop do not intercept pointer input.
The owned host also compensates root CSS zoom on actual feedback updates;
see [zoom geometry and its evidence](zoom-feedback.md).
Same-document root replacement retires disconnected feedback and recovers on
the next visible update; [renderer lifetime](dom-rebuild-feedback.md) describes
ownership, old callbacks and the page-node collision boundary.
Native toggle events stay inside the shadow tree, so document/window capture
listeners do not receive agent popover events. Page elements and their layers
are never moved, closed or reopened to display feedback.

Hiding feedback clears its effects and closes the owned popover. Page teardown
removes the entire host. The existing host print rule also excludes its shadow
content from PDF layout. If the native popover API is unavailable, ordinary
fixed feedback remains available, without a guarantee of top-layer visibility.
Presentation is best effort: native presentation failures do not change or
retry browser input. A native hide exception hides pixels but does not prove
that top-layer membership ended; the next feedback message can retry it.

## Acceptance

`OBU_TEST_CASES=^js-top-layer-feedback$` uses the regular isolated browser
runner plus mandatory raw navigation. Original public hover/click/fill input
opens an outer modal, a nested modal, and simultaneous manual/auto popovers.
Screenshots must contain cursor pixels at the original button center and blue
outline pixels at its edges, inside an opaque grayscale business panel.
Each original form submits exactly once; retained POST bytes, document/node
identities and trusted input/click/submit events are checked independently.

Hover and capture preserve original input focus and selection. The page records
business layer transitions and rejects unknown opening toggle events, checking
that agent feedback stays isolated. Turn end must leave zero open agent layers,
zero rings and a hidden cursor while preserving the original focus, selection,
input and toggle ledgers. Cleanup removes exact fixture tabs without opening a
new SDK turn. Failure evidence is retained before cleanup; inputs are not
replayed to obtain a passing result.

Unchanged-production `FYfrul` (actual exit 1) succeeds at all three original
submissions but has zero cursor/outline pixels in every screenshot. Fixed
`kVaOVU` passes 2/2 and related `gTjanh` passes 9/9, both actual exit 0 with
unchanged source/runtime hashes. The latter includes ordinary and strict-CSP
PDF exclusion plus existing pointer/export/lifecycle cases. The earlier
`U29MYN` receipt failure belongs to an incorrect fixture URL base and is retained
separately, not counted as a product counterexample.

The focused and related observer intervals are 3,428 ms and 14,003 ms, each with
zero activation/focus events and zero allowances. Independent reconstruction
checks all original POST/PNG hashes, both original business ledgers at turn end,
and four PDFs/eight rendered pages with zero cursor images or colored leakage.
The complete Node CI groups pass 3,092 tests with one pre-existing Windows
file-symlink permission skip. No source edits occur during these runs.

Complete browser regression `7uoTMN` passes 147/147, actual exit 0, preserving
the previous 144 case names/order plus this case and the two PDF exclusions.
The 424,958 ms observer interval contains only the original 12 activation and
four control-window focus allowances, with no additional allowance or event.
This full run is not a zero-focus-event claim. Source/runtime hashes remain
unchanged through the actual runner process close.

These checks cover HTML dialogs and popovers in an isolated Chromium profile.
They do not establish fullscreen, native browser UI, ordinary installed Edge,
or complete Browser Use parity. The focus observer excludes startup/teardown;
its recorded interval and allowances must accompany any focus claim.

## Primary design references

- [CSS top-layer styling](https://drafts.csswg.org/css-position-4/#top-layer-styling)
- [HTML popover behavior](https://html.spec.whatwg.org/multipage/popover.html#the-popover-attribute)
- [Chromium ToggleEvent construction](https://chromium.googlesource.com/chromium/src/+/f842f52ef39fd97b449eb27cff414bf05a98ddce/third_party/blink/renderer/core/events/toggle_event.cc#27)
- [Chromium shadow event boundary](https://chromium.googlesource.com/chromium/src/+/f842f52ef39fd97b449eb27cff414bf05a98ddce/third_party/blink/renderer/core/dom/events/event_path.cc#64)

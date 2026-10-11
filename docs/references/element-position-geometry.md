# Explicit position on transformed elements

`position` uses CSS coordinates measured from the element's padding-box origin.
The single-box HTML path maps that local point through the element's native
padding quad and then through the actual Chromium renderer local-root mapping.
Scaling a canvas must scale its requested internal point as well as its bounds.

The old AABB-origin addition could report a successful click on the correct
canvas while selecting the wrong internal location. A target hit receipt alone
cannot detect that mistake, because both positions may belong to the same node.

## Native geometry and lifetime

The pinned CDP `DOM.getBoxModel` supplies four padding corners. Resolved CSS
dimensions define their untransformed plane: content-box width/height plus
padding, or border-box width/height minus borders. Fractional CSS dimensions
are retained; integer native model sizes, clientWidth and offsetWidth are not
used as substitutes. Native quads already contain transforms and zoom inside
their own renderer, so only the renderer-boundary map is composed afterward.

The initial hit check recalculates the requested position and uses the pinned
pointer rounding rule to compare it with the proposed root point. The leaf
plane and dimensions join the original geometry fingerprint. Normal click
preparation repeats these checks after hover and before later counted presses;
a pre-press change may reprepare, while a change after the first press is
terminal. Neither case replays a committed click. Existing context, original
node, action deadline, native ticket and parent-frame checks still apply.

These are sequential geometry reads, not an atomic layout snapshot. The new
leaf reads are only performed when a position is supplied. SVG, non-replaced
inline, fragmented or unresolved CSS boxes retain the inherited local AABB
position convention; they do not acquire a guessed padding-plane projection.
Those cases and broader transform/input combinations remain parity work.
Hover and drag reuse the initial position projection and hit check; this change
does not give them the click path's post-hover or post-commit transaction checks.

OOPIF DOM geometry is not a promise of identical compositor input coordinates.
The fixed Chromium build rounds embedded-frame paint offsets to physical pixels;
layout and event conversion add their own finite precision. The production
adapter does not guess a fixture-specific rounding correction or send extra
buttons to calibrate it. Precise root projection and actual business-target
delivery are verified separately, with the observed native residual reported.

## Verification

The isolated raw probe confirmed fractional padding dimensions, content/border
box sizing, zoom and finite perspective quads. It also showed why tests cannot
blindly use MouseEvent offsets: PointerEvent offsets include CSS zoom, while
click offsets are rounded. This probe is not production acceptance.

The production fixture uses independent browser-laid-out hotspot witnesses,
trusted events from the original node, native Input calls and original HTTP
POST bytes. Root, same-process and dynamically created OOPIF cases retain
native document identities and the unchanged continuous focus observer.
Run `OBU_TEST_CASES=element-position` with the ordinary integration prerequisites.
The old production run `rj4xe2` failed all eight scenes, with nine original POSTs
at wrong positions. The first candidate `fRwtGy` passed six under an initial
0.025-CSS-pixel child-event threshold. Both OOPIF scenes delivered the correct
hotspot, but their child coordinates differed by approximately 0.10–0.17 CSS
pixels even though native root sends matched the independently projected center
within 0.005 CSS pixels. That original failure is retained.

Raw root-CDP input without the extension reproduced the discrepancy. Three
different frame origins at native DPR 1 matched the paint-offset rounding
prediction within 0.013 CSS pixels. The subsequent DPR 1.5 raw case did not
produce a pointerdown and is not counted as passing evidence. A separate
emulated-DPR probe is not evidence for three physical display configurations.

The final fixture therefore verifies two different quantities: native root
press/release positions remain within 0.025 CSS pixels of the independent CSS
projection; OOPIF trusted pointer coordinates, projected back to root, must be
within one physical pixel per axis of that actual send, with both per-axis and
Euclidean residuals retained. For this fixed parent-frame matrix, the checker
also derives a tighter budget from a half-physical-pixel paint-origin rounding,
the projected 1/64 layout-unit quantization and the independent projection's
reference tolerance. This is a bounded fixture assertion, not a universal
Chromium guarantee for arbitrary transforms, nesting or display settings.
Root/same-process precision checks and every
original-node, 12×12 hotspot and unique POST assertion remain. This does not
claim identical subpixel OOPIF DOM coordinates.

Final Windows Chromium 156 acceptance, with actual terminal exit 0:

| Run | Result | New-scene original evidence | Continuous focus |
| --- | --- | --- | --- |
| `gQRNO2` focused | 2/2 aggregate cases; all 8 scenes | 25 native Input calls, 8 unique correct POSTs / 83,724 bytes; 11 documents and 11 HTML responses | 3,150 ms; zero activation/focus events or allowances |
| `DF0lUQ` full | 120/120; previous 119 names and relative order retained | 25 native Input calls, 8 unique correct POSTs / 83,571 bytes; 11 documents and 11 HTML responses | 227,112 ms; only the existing 12 exact activation and 4 control-popup focus allowances |

Independent raw-event and original-byte checks confirmed the original node,
trusted down/up, successful native ACKs, correct hotspot and exact click counts.
Hover mutation re-prepared the point; the first-click mutation prevented the
second press without replay. All eight owned tabs and every exact fixture target
URL disappeared after finalization. No focus allowance was added. The full-run
sentinel retained its identity and selection, but its height changed from 1222
to 1187; this is not evidence of an unchanged viewport.

Both final runs had a maximum per-axis (L-infinity) native-root projection residual of 0.010545 CSS
pixels. The OOPIF per-axis local-event residual remained as large as 0.173981 CSS pixels;
its maximum per-axis projected root residual was 0.256823 physical pixels at actual
DPR 1.5, within this fixture's tighter per-axis bounds (about 0.5534 physical
pixels). Its maximum Euclidean root residual was approximately 0.287571 physical
pixels. The bounds are not substituted for the hotspot or unique-POST checks.

Node tests passed 1699/1699 with no skipped or cancelled tests. Independent
in-memory reconstruction checked all 51 production members and all 53 staged
members, including the disclosed harness-only differences. The normal extension
ZIP matches the production build. The three old preview ZIPs still match their
existing checksum file; no release asset was replaced. Go source and eight
reused integration binaries were matched to their existing build manifest;
Go/SDK suites were not rerun for this JavaScript-only change.

## Sources

- [Playwright Locator position contract](https://playwright.dev/docs/api/class-locator#locator-click-option-position)
- [CDP DOM box model](https://chromedevtools.github.io/devtools-protocol/tot/DOM/#type-BoxModel)
- [Chromium 156 paint-offset rounding](https://raw.githubusercontent.com/chromium/chromium/156.0.8078.4/third_party/blink/renderer/core/paint/paint_property_tree_builder.cc)
- [Chromium 156 embedded-frame paint](https://raw.githubusercontent.com/chromium/chromium/156.0.8078.4/third_party/blink/renderer/core/paint/embedded_content_painter.cc)
- [Frame geometry and its evidence boundaries](transformed-frame-input.md)

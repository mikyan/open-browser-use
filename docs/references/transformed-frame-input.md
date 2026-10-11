# Transformed iframe input

Locator pointer preparation maps target coordinates through actual Chromium
renderer boundaries. It no longer treats a transformed iframe as a reason to
skip every ancestor hit test. The patch is pinned to the existing CRX build and
does not introduce a new public API or an alternate native input route.

## Coordinate contract

`DOM.getContentQuads` and `DOM.getBoxModel` report coordinates in the renderer's
local-root viewport. Same-process frame transforms are already included there;
cross-process frame transforms must be composed. URL origin is not a substitute
for the actual CRPage session/frame identity.

Each frame owner is resolved from `DOM.getFrameOwner` and retained in its original
parent utility context. Its native content quad and resolved CSS content width
and height define an invertible plane projection. Border-box dimensions subtract
the actual fractional borders and padding. Rounded child `innerWidth` is used
for viewport clipping, not for normalizing the content plane. An isolated raw
geometry probe observed CSS width 400.5 versus child innerWidth 401; parent or
iframe zoom 1.25 changed the child DPR but left child quad CSS coordinates intact.

Default target fragments are first clipped in their source local-root plane,
then projected and clipped against all ancestor content/viewport polygons.
This ordering prevents an offscreen target crossing a perspective horizon from
folding into a plausible visible polygon. Zero-area fragments do not discard
later visible fragments, and small source fragments remain eligible when an
ancestor scale makes their root area exceed the existing clickable threshold.

The root point is inverse-projected into each parent document. Its original
iframe element must pass that document's normal `expectHitTarget` check; being
inside a geometric quad alone never proves an unobstructed hit. The final local
point is also checked by the existing target interceptor and move receipt.

Explicit `position` retains the target's local padding-origin convention and
projects that point through its frame. This does not fix the older AABB convention
for a target element's own transform or fragmented inline/SVG padding planes.

## Lifetime and commitment

Every asynchronous geometry read checks the same action progress, original
frame/context/session chain and observed pending navigation. The fingerprint
contains stable frame/session/context identities, parent identities, viewport,
owner backend node, native content quad and fractional plane dimensions. It
does not contain fresh remote object IDs from temporary handle adoption.

The normal click gate records the initial fingerprint and requires an identical
one after hover and before every later counted press. Missing geometry fails
closed. A pre-press change may restart preparation under the original deadline;
once a down has been submitted, a changed fingerprint is terminal and no button
sequence is replayed. This also detects transforms around an otherwise unchanged
local point. Root routing, input tickets and modifier restoration remain in force.

These are sequential observations, not an atomic layout snapshot or reservation
of future browser hit-test routing. Temporary owner handles use the fixed
Playwright `dispose()` contract: local disposal and best-effort native release,
without a confirmed native release ACK or a durable cleanup lease.

## Evidence and limits

The old production candidate `SDqvcJ` completed with exit 1. All three broad
positive targets were clicked, but three adversarial pages proved real misdelivery:
hover cover received the first button pair, hover translation sent it to the
parent wrapper, and first-click cover received the second pair. Native ACKs and
trusted parent DOM events agree. Large targets had concealed the OOPIF coordinate
error; the old rotated target received local (108.448,72.656), away from its center
(143.25,97.5). The subsequently added narrow target was not run on that old build.

Final candidate focused run `WmZggR` passed both runner cases with actual exit 0,
including all seven fresh-page scenarios: same-process scale, rotated OOPIF,
nested mixed frames, hover cover, hover translation, counted-click cover and a
12×12 rotated target using explicit position. Cover sent zero buttons; translation
reprepared then posted once; counted cover stopped after the first pair. The
continuous focus observer recorded zero activation/window-focus events.

Full regression `t0MP0c` passed **119/119** with confirmed process exit 0;
the Node suite passed **1673/1673**, with no skips or cancellations. The full
run retains the previous 118 cases and records the new fixture and build/patch
source digests that were not yet included in the focused run's manifest.
Independent audits checked 20 native Input sends, six original POST bodies
(24,256 bytes), 16 original documents/HTML responses and every previous case's
name/order. A separate fixture CSS calculation put all seven final root points
within 0.011 CSS pixels; it does not substitute for the actual trusted event checks.
The 226,850ms full focus ledger retained the previous 12 activation and four control
window-focus allowances, with none added for this feature. The sentinel identity
and selection remained unchanged; its height changed 1222→1165. All seven task
tabs/targets disappeared, and the expected host restart ended with the successor
host exiting 0. These measurements do not claim unchanged window geometry.

Deterministic tests cover finite convex perspective maps, invalid/degenerate
geometry, fractional sizing, reflection, clipping and lifecycle failures. The
seven real scenarios do not prove general 3D transforms, pinch zoom, all browsers,
all input paths or complete Codex parity. Installed-profile lifecycle limitations
remain separate, and the previously published preview archive is unchanged.

Run the focused browser acceptance with `OBU_TEST_CASES=pointer-transformed`
and the normal integration runner prerequisites. Raw Input/DOM records, original
HTTP bytes, exact document identities, cleanup inventory and source digests are
retained in the unique run directory. See the integration README for setup.

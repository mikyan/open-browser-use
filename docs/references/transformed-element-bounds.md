# Transformed element bounds and screenshots

## Contract and implementation

Formal locator `boundingBox` returns a root-viewport CSS bounding rectangle.
The old CRX path first enclosed the renderer-local border quad, then added the
iframe owner's bounding-box origin. A scaled or rotated renderer boundary loses
information in that operation; element screenshots inherited the wrong crop.

The private frame geometry adapter now projects all four native
`DOM.getBoxModel.border` vertices through the actual renderer-local-root maps,
then encloses the resulting root points. Native quads already include ancestors
in the same renderer, so those transforms are not applied twice. Bounds are not
viewport-clipped: negative coordinates, offscreen elements and zero width/height
remain valid. Same-renderer collapsed geometry does not require an inverse map.
These are bounding-box semantics. Element screenshots retain the upstream
rejection of absent layout or zero width/height; they do not return `null` or a
zero-sized PNG.

The bounds-only snapshot still checks the original frame, parent, context,
session and native owner. Known native errors saying that a target or owner has
no layout return `null`, after the original route/deadline postcheck. Unknown
native failures, changed routes and invalid projection planes remain errors.
The hidden-parent fixture verifies a live OOPIF child and the exact root owner
whose native box-model request reports absent layout.

The pinned private locator/client/channel/dispatcher chain forwards the
locator's remaining timeout into a real `ProgressController`. Exhausted finite
remaining time (including zero or negative values) cannot become the native
zero-means-unlimited setting. An explicitly unlimited timeout remains unlimited.
Element screenshots pass their existing progress object into the same geometry
path. Internal server callers without progress retain the original delegate;
formal public locator calls and element screenshots use the new path. No public
Browser Use wire schema or SDK API changed.

Geometry reads remain sequential rather than an atomic layout snapshot. Deadline
and cancellation checks prevent late results from continuing the operation;
they do not physically cancel a CDP request already sent. Temporary owner
handles retain upstream best-effort disposal, not a durable native release ACK.

## Projection limits

Collapsed or otherwise unrecoverable planes at an actual renderer boundary,
and quads crossing or lying behind the supported projective horizon, still fail
explicitly. This is a limitation of the mapping domain, not a claim that the
native element has no layout. Same-renderer zero/degenerate bounds remain
supported. Broader perspective, pinch zoom and native DPR combinations are not
proved by the affine browser fixtures. Snapshot `boxes` keep their separate
frame-local coordinate contract; this change does not silently make them global.

## Independent acceptance

`OBU_TEST_CASES=bounding-geometry` selects the mandatory raw-navigation control
and `js-bounding-geometry`. Seven scenes contain eight screenshot phases:
root, same-renderer transforms, scaled OOPIF, rotated OOPIF with a transformed
leaf, nested renderer local roots, child-document navigation, and root bounds.
The last scene covers negative/offscreen, zero width/height, hidden target and
hidden OOPIF owner without taking an invalid zero-sized screenshot.

An independent CSS proof plane and corner/inside/border markers establish the
expected geometry. The fixture checks original document/node/process identity,
the exact native target/session association, native screenshot clip, original
PNG ACK bytes versus public result, decoded pixels and final owned-tab cleanup.
The independent audit additionally checks PNG CRCs and seven border witnesses;
it does not use the production projection helper as an oracle. There are no
Input calls or additional activation/focus allowances in the new fixture.

| Run | Result | Evidence and qualification |
| --- | --- | --- |
| `6khFx1` old production | exit1; 3/7 scenes, 3/8 screenshot phases pass | All five transformed OOPIF phases have wrong bounds/crops; maximum per-axis bbox error 95.886446 CSS pixels. Eight PNGs remain saved. Interior markers alone miss four bad crops; independent border witnesses establish the lost content. |
| `9QZ5oF` first candidate | exit1; 3/7 scenes | Bounds and native clip passed before the fixture rejected `getTargets.type=other`. The same exact target ID has an `attachedToTarget` iframe session. The checker was corrected to join native IDs/URLs/session records; coordinate/pixel tolerances were not relaxed. Original failure remains a failure. |
| `yXtuCJ` final focused | exit0; 2/2 aggregate, 7/7 scenes, 8/8 phases | 222 native calls with ACK, zero Input; 15 original documents/HTML requests, eight PNGs totaling 118442 bytes, max per-axis bbox error 0.004898049 CSS pixels. Native clips, original bytes and all pixel witnesses pass. 3704 ms focus coverage has zero events/allowances; all seven task tabs and 15 associated URLs are cleaned up. |
| `iRrKtt` final full | exit0; 121/121 aggregate, 7/7 new scenes, 8/8 phases | Prior 120 names/order are unchanged. The new case records 223 native calls with unique ACKs, zero Input, 15 original documents/HTML requests and the same eight PNGs/118442 bytes. Independent geometry, native clips, PNG CRCs and ten pixel witnesses pass. Owned tabs and targets are removed. |

The full run's 237085 ms continuous focus ledger contains only the existing
12 exact activation allowances and four user-control-popup focus allowances;
their counts/reasons match the preceding full run. The new case adds none and
has no events during its bounded interval. Sentinel identity and selection
remain unchanged, while viewport height changes from 1222 to 1190; unchanged
dimensions are not claimed. The old host receives the intentional recovery
test SIGTERM, and its replacement exits with code zero. Full-run source
reconstruction matches all 51 production and 53 staged files; focused and full
production members are byte-identical.

The baseline freezes the previous `296a3ce` production files, independently
matching all 51 bytestrings to the preceding accepted runtime. Four static JS
files use checkout CRLF while Git blobs use LF; normalized source agrees, and
the actual frozen runtime bytes are verified. The pre-checker-fix fixture was
reconstructed with two exact reverse hunks and matched its original hash; it
was not a pre-existing snapshot. Both distinctions are retained in the local
provenance evidence.

Final Node tests pass **1723/1723**, zero skipped/cancelled. This includes 38
frame-geometry tests and 11 new fixture tests; they are not additional counts.
Private timeout/schema/dispatcher paths, known no-layout, route/deadline
failures, native cancellation and screenshot progress have deterministic tests.
The previous 49 Go build inputs and eight reused binaries match their existing
build manifest; Go/SDK suites were not rerun for this patch.

The normal extension ZIP has 51 production files matching the unpacked output
and source reconstruction. The staged browser test has 53 files with only the
documented transport/focus/release observer test hooks. The three published
preview ZIPs remain unchanged against their existing local checksums; this
does not claim a new remote-release audit or a startup snapshot.

See the [integration invocation](../../scripts/browser-integration/README.md),
[frame input geometry](transformed-frame-input.md),
[element positions](element-position-geometry.md), and
[snapshot geometry](snapshot-geometry.md). Full parity remains open.

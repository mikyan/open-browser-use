# Real element feedback inside frames

- Status: complete for this slice; overall parity remains active
- Started: 2026-10-14
- Parent: [Browser Use parity](../active/2026-10-10-browser-use-parity.md), P07/P12/P15.

## Outcome

Make the visible target outline identify the actual element being operated on
inside frames, while preserving the original pointer position, click rings,
native input and background behavior. At baseline, `content-cursor.js` deliberately
hit-tests only the top document and outlines an iframe as a whole. Its unit
test fixes this behavior, so successful cross-frame actions do not yet prove
the user's requested element feedback.

The baseline is clean `dc70e99`, with full browser acceptance 175/175 and current
Node groups 3478 pass/one existing Windows skip. The previous goal turn made
verified implementation progress and pushed the allowed-site Blob download
change. This work returns to the original visible-feedback requirement; it
does not replace the full parity objective or ordinary Edge acceptance.

## Constraints and design work

- Reuse the original engine target, frame/context/session and proven projection
  where possible. Re-resolving a selector after input cannot identify the old
  target after a replacement or navigation.
- Existing frame geometry maps native renderer-local-root coordinates to the
  root viewport. Do not add iframe offsets twice or substitute fixture geometry
  for production geometry. Preserve transforms, nested frames and dynamic
  attachment handling rather than accepting only easy same-origin cases.
- Visual feedback must not alter native input, retry a click, extend its original
  budget, activate a tab/window or restore foreground state. Missing/expired
  visual evidence cannot be presented as a confirmed leaf target.
- Keep exact attachment, document, scope and sequence identity through any
  asynchronous feedback path. A retired frame/turn cannot draw late feedback;
  pending native reads must retain their actual resource settlement semantics.
- Audit all relevant pointer entry paths, including raw root-coordinate input,
  and state the evidence available to each. Do not silently equate a locator
  target hint with native hit-test evidence for unrelated input.
- Existing top-layer visibility, zoom compensation, root rebuilding, hiding,
  printing and owned-node boundaries remain required.

Fullscreen is separately unverified. Its shared top-layer mechanism does not
yet establish a general renderer defect; adding focus allowances to force a
fullscreen test would not meet the user's background requirement.

## Ownership and acceptance

The engine collaborator investigates and implements the original-target
feedback channel and deterministic counterexamples. The fixture collaborator
owns the independent original-page/PNG evidence. Root owns integration, real
isolated browser launches, frozen old-source and candidate records, documentation
and fork delivery. An independent auditor checks provenance and behavior.

1. Confirm a real old-source visual failure while the original public action
   succeeds; retain its original document/node, native input, screenshot and
   business submission. No production change before that baseline is captured.
2. Exercise same-origin, cross-origin, dynamic, nested and transformed frame
   targets. Independent CSS/native witnesses and PNG pixels must identify the
   original button rather than its containing iframe. Cursor/ring positions and
   original trusted submission remain independently checked.
3. Verify navigation/document replacement, stale scope/attachment, late replies and end
   cleanup. Existing public entry points retain their input behavior; no new
   focus permission or implicit retry is allowed.
4. Run meaningful affected checks, prior feedback regressions and the complete
   browser suite. Audit original artifacts and actual process closes, update
   contract/capability/history records, and push the authorized fork branch
   without a PR. Full parity remains open until its entire matrix is proved.

## Progress

- Source review confirms the iframe-wide outline and its explicit regression
  expectation. The existing native frame-geometry adapter offers original
  target/context/session projection; its exact reuse and feedback lifetime
  interface are under review before implementation.
- Keep the existing root-viewport border AABB and rectangle renderer. Native
  `getContentQuads` is not a universal original-element border proof (inline
  and `display:contents` can aggregate child quads); a clipped clickable polygon
  or padding quad cannot silently replace this contract. Explicit position can
  reuse its existing BoxModel border, while default locator preparation starts
  a read for its exact original objectId and reuses the original frame maps.
- The optional read must not block input or the native input idle gate. Its
  actual native Promise remains associated with the original attachment until
  cleanup, independently of visual timeout. Feedback carries frozen original
  action identity and a distinct sequence even when coordinates are unchanged.
  Cursor/rings can publish first; a later rectangle cannot overwrite newer
  feedback. Raw coordinate actions retain the existing root hit-test fallback;
  an unresolved locator hint hides its outline instead of claiming a leaf.
- Old-source renderer tests retain two new failures (39 total: 37 pass, 2 fail,
  actual exit 1) with unchanged production. Root has wired a six-layout browser
  fixture and original-document end/hide checks.
- Real old-source `CIf8Ox` retained six successful original transactions and six
  screenshot/native proofs, with all six outlines incorrectly identifying the
  ancestor iframe. Actual exit 1, captured source/runtime changes empty; thirteen
  original documents remained unchanged across end/hide and the 572 ms followup.
  Production implementation was authorized only after this run actually closed.
- The rectangle is a snapshot of the original node when its native BoxModel
  read executes. It does not continuously track movement or prove that a node
  remains connected after a same-document application mutation. Re-resolving a
  successor would be false evidence; retaining nodes or adding mutation observers
  is outside this slice. Document replacement and scope/attachment/feedback
  invalidation remain strict publication fences.
- Keep optional BoxModel reads out of the CRX automatic action-failure detach
  barrier: they acquire no native resource handle and must not prolong a later
  action's failure/deadline. Required resource and input release semantics stay
  unchanged. The actual read Promise remains tracked after automatic detach;
  Pause, turn end and explicit detach drain it, and an old result has no authority
  over a replacement attachment. This distinction avoids a new cross-layer
  deadline protocol solely for optional visual feedback.
- First candidate `fvib30` retained six successful original business/native
  proofs and six correct leaf-outline PNGs with no ancestor outlines. It still
  failed (actual exit 1, no source/runtime drift): the nested case lost its click
  ring when the release ACK superseded an already accepted press feedback job.
  Keep this failure and the unchanged ring oracle. The correction preserves
  accepted queue order, rejects genuinely late old ACKs at admission and rejects
  lower-sequence cursor delivery at the renderer; late rectangle patches retain
  their stricter latest-sequence check.
- Node CI v1 closed with scripts 305 pass and integration 1627 pass/one existing
  Windows symlink skip. Extension had 1594 pass/one failure: its keyboard metadata
  test expected the old two-field private scope. The explicit original
  `control_epoch` expectation was added without exposing admission closures or
  weakening the deadline check. Final verification must follow the ring fix.
- Final frozen candidate `k2sWDv` passes 2/2, actual exit 0. Independent original
  PNG/native/POST audit confirms all six outlines and rings, six unique trusted
  POSTs/14,185 bytes and thirteen documents. End/hide remains correct after
  576 ms; 13,056 ms has zero activation/focus/allowances. Exact tabs, targets and
  native host process cleanup are verified. Related regression `za8xMZ` passes
  17/17 actual exit 0. Node CI v2 passes 3536 with one existing Windows symlink
  privilege skip; all source/runtime snapshots remain unchanged. Full browser
  regression is running against this same source freeze.
- Final source review identified an existing cross-turn transport boundary:
  the visual timeout does not cancel an already-sent `tabs.sendMessage`, and
  clearing the queue does not join that actual Promise. Same-document delivery
  after a later turn is not covered by same-turn sequence checks. No real native
  reordering was observed; this predates the slice. Preserve it in the reference
  and debt tracker rather than claiming universal post-send cancellation. A
  follow-up needs an independent protocol counterexample and actual-delivery/
  final-hide cleanup design; the overall parity goal remains active.

## Final verification

Complete browser run `rkN0eF` passes 176/176 with actual exit 0 and no captured
source/runtime changes. The old 175 names and order are intact, with the new
six-layout task added. Independent audit re-decodes its original six native
PNGs, verifies six click rings, six unique original POSTs/14,185 bytes, thirteen
documents, native ACKs and exact tab/target cleanup. End remains hidden after
570 ms. The 536,859 ms observer interval contains only the original twelve
activation and four control-focus allowances, with no new exemptions.

Core regression evidence includes nine original keyboard POSTs/101,055 bytes,
all original End keydown/keyup pairs, fifty ForwardKey trace events with zero
suppression, two original clock markers and a closed trace handle. Restricted
chooser five-entry coverage retains thirty original POSTs/12,337 bytes with
original upload/clear ACKs. Original unbound downloads retain twenty-four GUIDs,
HTTP responses and physical files totaling 98,376 bytes. Historical PDFs were
not independently re-rendered in this audit.

All 591 captured sources, eighteen runtimes, forty-eight staged files and fifteen
Go binaries with 144 unchanged build inputs match their recorded identities.
The intentionally restarted original host and normally closed successor have
their actual terminal records; an independent exact-run process query is empty.
Three earlier preview archives retain their original hashes.

Documentation skeleton, repository hygiene, action pinning, changed Markdown
links and whitespace checks pass. Node CI v2 remains 3536 pass/one existing
Windows symlink-privilege skip. No Go/SDK rebuild or cross-platform run is claimed
for unchanged code. Original red and intermediate failures remain retained.

The implemented locator-outline slice is complete. Raw-coordinate leaf evidence,
fullscreen, the existing cross-turn message delivery boundary, ordinary Edge
manual authorization and the complete capability matrix remain open.

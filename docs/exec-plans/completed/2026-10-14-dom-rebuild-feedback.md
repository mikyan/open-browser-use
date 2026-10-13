# Recover agent feedback after same-document DOM replacement

- Status: complete (this renderer slice only; parent goal remains active)
- Started: 2026-10-14
- Parent: [Browser Use parity](../active/2026-10-10-browser-use-parity.md), P12.

## Problem and outcome

The cached cursor renderer is reused without checking that its owned host and
layer remain connected. A page that rebuilds its root children in the same
document can detach them; later feedback still updates detached nodes and may
report arrival. Verify this with original browser evidence before changing the
renderer, then restore visible feedback on the next authorized feedback update.

## Contract

- Preserve native input, viewport coordinates, top-layer/zoom/print behavior,
  ownership and existing turn/revision fences. Never replay input, move the OS
  mouse, restore focus or add a focus allowance.
- Recover only the extension's owned renderer after disconnection; retire old
  animation frames, rings and timers. Do not reconstruct page-owned DOM or
  attach a polling observer that repeatedly fights application updates.
- Hidden/end/pagehide and stale asynchronous state must not recreate visible
  feedback. Detached animation callbacks must not report successful arrival.
- Body-only replacement should preserve a still-connected renderer. Frame and
  shadow boundaries retain the existing local-document contract.
- Preserve old preview ZIPs. No PR; verified changes may be pushed to the
  authorized fork branch.

## Ownership and verification

- Root: plan, runner integration, frozen-source real red/green browser runs,
  original artifacts, documentation, final review and commit/push. Root alone
  launches isolated browsers, never a daily profile.
- Renderer collaborator: deterministic original-source red tests, then bounded
  renderer repair after the real red source has been captured. Own only
  content-cursor.js and its test.
- Fixture collaborator: separate real DOM-rebuild fixture and tests. Retain
  original page/document/node identities, one trusted trigger/POST, screenshots
  and click/outline/cursor evidence; no input replay or focus exception.
- Audit collaborator: independent lifecycle review and original evidence audit.
- First capture the old renderer failure on a real same-document application
  rebuild. Then test affected modules and focused/related browser workflows,
  including top layers, root zoom, print exclusion and end cleanup. Expand
  testing only for changed shared behavior or unresolved concerns. Full parity
  remains open; ordinary Edge consent is deferred by the user.

## Progress

- Previous slice e797d6f is authoritative progress: clean worktree, restricted
  native dialogs implemented, Node 3251 pass/one existing skip and complete
  BNmZJb 156/156 actual exit 0. The full parity goal remains active.
- Initial code read confirms ensureCursorRenderer returns any cached renderer,
  while top-layer visibility skips a disconnected layer and the animation can
  still report arrival. The original real reproduction is recorded below.
- Original-source module tests retain actual exit 1: 35 tests, 28 pass and seven
  failures. They distinguish detached/moved ownership, stale animation arrival,
  visible recovery, press-only recovery and a temporarily absent root, while
  retaining body-only, hidden/end/pagehide and stale-bootstrap controls.
- Real unchanged-production `bxYaz2` exits 1 with no source/runtime drift. All
  three original submissions succeed (12,842 raw POST bytes). Both root rebuild
  screenshots have zero cursor and outline pixels and retain the detached old
  renderer model; the body-only control retains its connected renderer and
  correct feedback. All three stages, original tokens and cleanup are retained;
  root-children and body-only screenshots were visually inspected.
- The repair retires disconnected/moved ownership and recovers only on a valid
  visible update or accepted press. Hidden/end/teardown do not allocate a
  successor, stale callbacks cannot touch it, and a same-ID application
  replacement is preserved instead of adopted or cleared. A temporarily absent
  document root is acknowledged without creating application DOM.
- Final renderer tests pass 37/37, fixture tests 7/7. All Node groups pass 3270
  with one existing Windows symlink privilege skip, actual exits 0 and no
  source/runtime drift. The existing eleven Go artifacts are reused only after
  all 141 build inputs and binary hashes match; no Go/SDK source changes.
- Green `RttFgP` passes 2/2, actual exit 0. Independent original PNG decoding
  verifies all three cursor/outline results, original ring geometry, 13,147 raw
  POST bytes and document/window/node identities. End remains hidden after
  567ms, with unchanged business state; 4574ms has no focus/activation. Host
  exit and exact-run process cleanup are confirmed.
- Related `ppBrxc` passes 11/11, actual exit 0. Its 13,129 original POST bytes,
  three visual results and 561ms hidden-end observation are independently
  verified. The 23,080ms ledger has only the existing two sole-popup activations
  and two control-popup focus events.
- Full `uLJcAS` passes 157/157, actual exit 0. The previous 156 names/order
  remain intact. Independent review confirms three original PNGs, 13,039
  original POST bytes, owned renderer identities and hidden feedback after
  574ms. The 460,718ms focus ledger has only the original 12 activation/four
  control-focus permissions. All 561 source and 14 runtime identities, 141
  build inputs, eleven binaries and 46 staged extension files match. The old
  host exits for the intentional restart; its successor exits 0 after EOF,
  and the exact-run process inventory is empty.
- Documentation, repository hygiene, action pinning and diff checks pass.
  Existing preview ZIP hashes are unchanged. Ordinary Edge consent is still
  deferred; full parity and broader P12 acceptance remain open.

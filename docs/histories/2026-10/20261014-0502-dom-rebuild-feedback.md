## [2026-10-14 05:02] | Task: Restore feedback after application DOM rebuilds

### Execution context

- Agent: Codex `/root`, with renderer, fixture and independent audit collaborators.
- Runtime: Windows; isolated Chromium, real extension worker and native host.

### User request

Continue Browser Use development while ordinary Edge authorization is deferred.
Keep background operation and visible cursor/click/target feedback, use the
authorized fork, preserve existing packages and create no PR.

### Changes and intent

- Replace unconditional cached-renderer reuse with original host, direct root,
  shadow, layer and cursor ownership checks. The next visible update or valid
  press retires an invalid instance and creates a new owned layer. Body-only
  rebuilds preserve an existing connected renderer.
- Retire old frames, rings and timers without replaying input. Detached or late
  callbacks cannot report arrival or retire their successor. Keep the original
  state-revision check for delayed bootstrap responses.
- Hidden, end and pagehide states do not allocate a host. An absent document
  root does not cause application HTML to be created. A same-ID page replacement
  stays untouched; visual recovery waits for a subsequent valid update after
  the conflict disappears.
- Preserve top-layer isolation, root zoom compensation and print exclusion.
  Add no focus allowance, polling observer or OS-pointer control.
- Add one real browser case containing three application rebuilds. Original
  references distinguish document/window and old/new business/feedback nodes;
  screenshots and exact trusted form receipts independently test visibility
  and successful input. End is observed again after the click-ring lifetime.

### Verification

- Original-source module run: 35 tests, 28 pass/seven fail, actual exit 1.
  Final renderer 37/37 and fixture 7/7 pass with actual exit 0.
- Original real `bxYaz2` exits 1: all three original POSTs succeed (12,842 bytes),
  while both root-rebuild PNGs contain zero cursor/outline pixels and retain a
  detached model. Body-only feedback remains visible. Independent PNG/byte
  audit, original source identity, 3039ms zero-focus ledger and cleanup pass.
- Fixed `RttFgP`: 2/2, actual exit 0; all three original images/geometry and
  13,147 POST bytes pass independent review. Root rebuilds replace only owned
  layers; body-only retains its original layer. After end, both the initial
  hidden check and the later 567ms observation preserve zero open layers/rings,
  cursor opacity zero and unchanged business state. Its 4574ms ledger has no
  activation or window-focus events.
- Related `ppBrxc`: 11/11, actual exit 0. Three receipts total 13,129 bytes,
  hidden feedback remains stable after 561ms, and the 23,080ms focus history
  contains only the existing two sole-popup activations/two control-focus
  events. Top-layer, zoom, ordinary/strict-CSP PDF and other original checks pass.
- Node groups: 3270 pass, one existing Windows symlink privilege skip, actual
  exits 0 and no source/runtime drift. Eleven previously verified Go binaries
  are reused with all 141 build inputs and binary hashes unchanged. No Go/SDK
  production or fixture helper changes are needed for this renderer slice.
- Full `uLJcAS`: 157/157, actual exit 0, preserving the original 156 case names
  and order. Independent PNG/byte/identity review confirms all three rebuild
  stages, 13,039 original POST bytes and stable hidden state after 574ms.
  The 460,718ms focus ledger has only the original 12 activation/four
  control-focus permissions. All source/runtime/build identities and staged
  files match; both native host generations exit as expected and the exact-run
  process inventory is empty.
- Documentation, repository hygiene, action pinning and diff checks pass.
  Existing preview ZIP hashes remain unchanged; no PR is created.

### Boundaries

Recovery happens on the next effective feedback update, not continuously while
the application mutates DOM. Ring geometry is passive transient evidence;
only the cursor/outline claim uses original screenshot pixels. Same-ID page
collisions temporarily suppress visual feedback rather than modifying the
application. Ordinary installed-browser consent, native UI, fullscreen and
the wider parity matrix remain open.

### Main files

- `apps/chrome-extension/content-cursor.js` and its lifecycle tests.
- `scripts/browser-integration/dom-rebuild-feedback-fixture.mjs`, its tests,
  runner wiring and integration guide.
- Renderer lifetime/reference index, architecture, quality, capability matrix
  and execution plans.

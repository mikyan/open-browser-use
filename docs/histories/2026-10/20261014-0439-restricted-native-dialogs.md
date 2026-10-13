## [2026-10-14 04:39] | Task: Support native dialogs on allowed websites

### Execution context

- Agent: Codex `/root`, with backend, module and integration collaborators.
- Runtime: Windows; isolated Chromium fixture, real extension worker and native host.

### User request

Continue Browser Use development while ordinary Edge manual authorization is
deferred. Preserve existing preview packages, use the authorized fork, and
create no PR.

### Changes and intent

- Permit arm, collect and cancel for native dialogs under website restrictions.
  Keep the original policy generation/revision, allowed live frame tree and
  original browser-issued emitter URL/frame/document proof. Navigation, frame
  removal, policy replacement or attachment loss cannot authorize a successor.
- Collect rechecks the original record and synchronous authority after actual
  cleanup settles. Cancellation still validates ownership but can drain a wait
  without reinspecting a revoked site. Preserve actual native ACKs and stock
  defaults for the same still-open dialog; never replay input.
- Fix an observed allowed-frame permission race: a valid frame tree may change
  while Chrome answers its independent reads. Reinspect only a fully allowed
  snapshot inside the original 1000ms deadline, at most eight reads. Denied or
  malformed trees, policy changes and real revocation fail immediately. A late
  read cannot publish proof or clear revocation after the deadline.
- Reuse the existing five-entry native-dialog workflow under real popup-saved
  restrictions. Add denied-frame and policy-change boundaries, exact cleanup,
  durable policy restoration and passive native evidence. The observer is
  reinstalled after the existing readiness gate on a real worker restart.
- Add optional bounded permission diagnostics, off by default, preserving the
  original native calls and Promises. Use the existing safe-port fixture helper
  for the original-download HTTP negative test without weakening its oracle.

### Verification

- Module 20/20, backend 32/32 and permission backend 55/55. Retained original
  failures cover unavailable restricted arm and permission-read races. Tests
  include actual pending ACK, original-policy identity, native frame lifetime,
  successor records, post-cleanup revocation and timeout/late-read fences.
- Node groups: 3251 pass, one existing Windows file-symlink privilege skip,
  actual exits 0 and no source/runtime drift. After the final test-only worker
  observer ordering correction, affected fixtures pass 38/38. All eleven Go
  binaries are rebuilt from 141 frozen inputs; production Go/SDK sources do
  not change in this slice.
- Focused `cin0qm`: 10/10, actual exit 0. Independent audit checks 15 layouts,
  90 explicit decisions, 120 original native responses and 105 original POSTs
  totaling 26,592 bytes. The 37,425ms observer interval has zero activation and
  only two existing control-popup focus events. Exact source/runtime/build
  identity and native-host exit 0 are confirmed; exact-run processes are zero.
- Complete `BNmZJb`: 156/156, actual exit 0, retaining the previous 150 case
  names and order. Independent review confirms the same original dialog/POST
  evidence and strict denied boundaries. The 466,299ms observer interval has
  only the existing 12 exact activations and four control-popup focus events.
  Source/runtime/build identity, intentional old-host restart, successor EOF
  and exit 0, and zero exact-run remaining processes are verified.
- Preserve earlier actual failures: `MC3toy` (4/10, wrong running-state oracle),
  `N34ygI` (4/10, allowed-frame admission and missing restarted observer), and
  `wqb9w1` (3/10, observer installed before Chrome bindings became ready).
  Passive diagnostic `LmLRV9` (4/5) retains all 2330 records, without overflow,
  observer errors or pending calls, and proves allowed child commit alone
  caused the previous permission revocation. The original methods are restored.
- Retain the Node v2 HTTP `fetch failed` result. Its port/cause was not retained,
  so safe-port reuse removes a known risk without claiming to prove that
  failure's cause. Related HTTP fixture checks pass 11/11.

### Evidence limits and remaining work

Ordinary alert/confirm/prompt are verified; beforeunload can still activate
native UI and remains a background limitation. Policy save confirmation,
durable readback, actual Pause and explicit Resume are verified, without an
independent count of every native storage.set. Tests use an isolated loopback
native adapter and do not replace ordinary Edge installation/consent or the
remaining parity matrix. No new focus permission or OS-mouse control is added.
Documentation, hygiene, action-pinning and diff checks pass. Existing preview
ZIP hashes are unchanged. This slice is complete; the parent goal stays active.

### Main files

- `apps/chrome-extension/background.js`, `browser-dialogs.js` and their tests.
- `scripts/browser-integration/site-access-dialog-fixture.mjs`, passive frame
  observer, optional permission diagnostics, tests and runner wiring.
- Existing native-dialog caller/evidence helpers and safe HTTP fixture listener.
- Dialog/site-policy references, integration guide, architecture, quality,
  capability matrix and execution plans.

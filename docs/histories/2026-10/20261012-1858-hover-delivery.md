## 2026-10-12 18:58 | Task: Confirm locator hover delivery and preserve menu events

### Execution Context

- Agent: Codex, with independent production and acceptance review.
- Runtime: Windows, Node 24.14.1, isolated Chromium 156.0.8078.4.

### User Query

Continue until Browser Use capability matches Codex, retaining background operation,
the existing skill and fork. No PR or replacement of published preview packages.

### Changes

- Add a hover-specific event-time receipt under the original native route,
  attachment, context and deadline. Missing delivery retries only after actual
  move completion; delivered hover is not replayed because its handler changes
  the node or opens a covering menu. Disabled elements retain hover support.
- Preserve the compatibility mousemove after successful guarded hover, so a
  menu's normal initialization runs. Click and trial interception remain intact.
- Distinguish confirmed pre-held input from pending/unknown key or button intent.
  Only the former retains legacy hover behavior. Actual native input failure
  stays on the original attachment until explicit release; late old-attachment
  failure cannot poison its confirmed successor.
- Preserve per-attempt modifier restoration and original failures. Add independent
  native-bundle, tracker and backend regressions and eight real-browser scenarios.
- Preserve inner/outer teardown errors and write auxiliary evidence before the
  main case artifact. Actual exit and final results remain authoritative if a
  persistence callback fails; arbitrary writes are not treated as transactional.

### Design Intent

A successful native ACK does not prove that the original page target received
movement. Hover also differs from click preparation: its own handlers can
legitimately cover or remove the target, so post-hover click readiness would
reject successful behavior or replay it. The target receipt and compatibility
event handling address both defects while preserving original scope and budget.

### Verification

- Original pinned hover incorrectly succeeds when simulated target events are
  absent; three actual pinned-bundle regressions fail against that baseline.
  An intermediate candidate's two menu initialization regressions also fail:
  202/204 build tests before the final hover-only exception, then 204/204 after it.
  These are VM counterexamples with simulated events, not natural browser failures.
- Focused `2mzRnT`: 8/8 runner cases, actual exit 0. Six original POSTs/6704 bytes,
  six actual moves and four Shift key commands; all-drop scenarios have no business
  receipt, cover-menu initialization occurs once. Original-scope wire timeout,
  10012ms Pause failure, explicit recovery and eight exact tab/target removals pass.
  Thirty synthetic ACKs are deliberate fault injection, not real native dispatch.
- Focus ledger: 43671ms, zero activation/focus/allowances. The sentinel remains
  active but its viewport height changes. Original host EOF exit 0 is confirmed;
  the ordinary runner does not record graceful browser process exit.
- First full `3Ui8x6`: 127/128, actual exit 1. All original 126 names/order pass.
  The new fixture incorrectly requires wire budget 1000ms when SDK preparation
  legally reduces it to 999ms. The original failure is retained; the corrected
  oracle validates a conservative interval from caller start to wire arrival,
  without changing any production budget or inventing IPC tolerance. Focus passes
  over 288227ms with the existing twelve activation/four control-popup allowances.
- Final focused `TTV0uq`: 8/8, actual exit 0, using the final Node relay oracle.
  Six original POSTs/6704 bytes, 10015ms Pause failure followed by recovery,
  eight exact tab/target removals and 43538ms with zero focus/activation/allowances.
- Final full `Ghqqmo`: 128/128, actual exit 0. All original 126 names/order are
  preserved. The hover scenarios retain six POSTs/6704 bytes, six actual moves,
  twenty-nine synthetic ACK drops, four Shift commands and eight exact removals.
  Pause fails after 10006ms while actual ACK publication remains held; explicit
  recovery and final stopped relay validation succeed. Continuous focus evidence
  covers 302099ms, with only the existing twelve task activation/four control-popup
  allowances. Sentinel height changes are retained, not called unchanged geometry.
- Final Node suites: extension 1146/1146, build 204/204, integration 1202/1202;
  total 2552, all actual exit 0, no skip/cancel. Focused/full source checkpoints,
  staged extensions, SDK and host/runtime hashes match. Full intentionally
  terminates its first host for restart acceptance; the successor's normal EOF
  exits 0. No exact private browser/profile or host process remains afterward.

The second focused run `JMRbPW` retains a separate 7/8, actual exit 1: comparing
worker and Node timestamps rejects a one-millisecond clock-domain difference.
The remedy is same-process relay evidence before native forwarding, not a timing
tolerance. Worker/native sequences remain independently checked by exact scope,
request ID, budget and error, while caller comparisons use the Node observer.
Earlier artifacts without this evidence are not relabelled as a current pass.

Only private extensions are rebuilt; unchanged host, Go helpers and SDK/runtime
artifacts are hash-verified and reused. Published preview packages stay unchanged.
The controlled drop/actual-ACK-publication gates and staged backend Pause do not
prove natural compositor faults, native installation, popup UI, other browser
brands or full P01–P15 completion. Force/trial and confirmed pre-held input retain
their earlier semantics. The whole parity objective remains active.

### Key Files

- `apps/chrome-extension/browser-input-adapter.js` and hover admission tests
- `apps/chrome-extension/background.js` and backend hook tests
- `scripts/patch-pointer-delivery.mjs` and pinned-bundle tests
- `scripts/browser-integration/hover-delivery-fixture.mjs` and its tests
- `scripts/browser-integration/chooser-failure-observation.mjs`
- `docs/references/hover-delivery.md`

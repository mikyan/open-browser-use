## 2026-10-12 18:21 | Task: Preserve native screenshot completion after caller timeout

### Execution Context

- Agent: Codex, with independent backend and acceptance reviews.
- Runtime: Windows, Node 24.14.1, isolated Chromium 156.0.8078.4.

### User Query

Continue development until Browser Use capability matches Codex; retain the
fork, background operation and existing feedback. No PR or preview replacement.

### Changes

- Register actual raw-root and CRX `Page.captureScreenshot` completion under the
  original rendering lease. Recheck that lease immediately before native send,
  including after asynchronous site policy checks.
- Preserve bounded caller timeout/abort, while the original attachment queue and
  global Pause drain retain pending native captures. Late completion cannot
  remove a successor attachment's queue or stop its stream. No capture is replayed.
- Preserve prompt cancellation for ordinary actions with no pending native
  screenshot. A first candidate's ordinary-cancellation regression was corrected.
- Add a real-browser ACK-delivery fixture for raw internal/external streams with
  successor/Pause, and high-level internal screenshots with Pause. Original PNGs,
  wire deadlines, stop/start order, old scope rejection and exact cleanup are checked.
- Document the contract, acceptance boundaries and remaining parity requirements.
  A separate pinned-source note excludes minimization alone as a demonstrated
  workaround for native popup activation; it adds no browser acceptance claim.

### Design Intent

Playwright's public progress Promise can reject before its actual native capture.
Waiting only for that wrapper let later rendering run and Pause finish too early.
Native completion must remain independently owned without extending the caller's
deadline or replaying work.

### Verification

- Five raw counterexamples fail against original production. Two CRX/pinned
  Progress counterexamples fail against the intermediate wrapper-only candidate.
- Final Node suites: 2467/2467 (1121 extension, 184 build, 1162 integration),
  actual exit 0, no skip/cancellation. Focused/related subsets are not added again.
- First browser run `wP9GER`: 2/3, actual exit 1. The fixture incorrectly restarted
  an already-active external stream. Its failure remains; corrected cases queue
  explicit stop/start behind the capture, without changing production or deadlines.
- Corrected `kSmNJ7`: 3/3 runner cases and five screenshot scenarios, actual exit 0.
  Seven PNGs independently decoded; 44 selected native calls fulfilled; three
  original 10-second Pause failures followed by successful explicit Retry/Resume.
  Five exact tabs/targets removed; 39,291ms with zero activation/focus allowances.
- Full `kuWd2o`: 126/126, actual exit 0. Original 125 names/order preserved;
  282,457ms with only the existing 12 activation/four control-popup focus allowances.
- Current extension is rebuilt privately for each run. Unchanged host, eight Go
  helpers and SDK/runtime inputs are hash-verified and reused. Preview ZIP hashes
  remain unchanged. Ordinary browser teardown does not record a graceful close code.

The browser gate holds delivery of an already-generated PNG; it does not prove
a natural raster stall. The loopback Native Port adapter and direct backend Pause
calls do not replace native installation or popup UI acceptance. High-level
external streams, child raw CDP, worker loss and broader platforms need separate
evidence. Full P01–P15 and hover delivery confirmation remain open.

### Key Files

- `apps/chrome-extension/background.js`
- `apps/chrome-extension/background-rendering.test.mjs`
- `scripts/browser-integration/screenshot-drain-fixture.mjs` and its tests
- `scripts/browser-integration/run.mjs`
- `docs/references/screenshot-completion.md`

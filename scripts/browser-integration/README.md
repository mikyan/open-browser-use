# Browser integration acceptance

This optional acceptance suite runs **public SDKs → real Go native host →
production extension → real Chromium pages**. It creates an isolated browser
profile and local test pages; it does not install an extension in a user's
profile, read user browsing data, or change the native-host registry.

The staged extension is produced by `buildChromeExtension`. Its only test
adaptation replaces `chrome.runtime.connectNative` with a Port-compatible local
WebSocket adapter, with the matching local CSP permission. The adapter bridges
the real host's native-message stdin/stdout frames. SDK connections still use
the host's actual Windows named pipe or Unix socket. This proves the SDK,
framing, relay, extension dispatch, engine, and page behavior; it does **not**
prove browser native-host registration or installed-extension discovery. The
production extension is not modified and does not open a WebSocket service.

The worker-restart case keeps this test adapter's Go host process alive. It
verifies extension epoch recovery over the same client connections. It does not
claim automatic discovery/reconnection when a real native-host process exits;
that requires reading its new endpoint and creating a new SDK client.

The runner launches headed Chromium directly. Playwright is used only to locate
the downloaded browser executable. A small raw CDP connection inspects the
extension service worker; there is no Playwright page/context connection or
foreground activation. A sentinel tab remains active, and the suite checks both
the current active tab and every activation event to catch transient focus
stealing.

## Prerequisites and invocation

Use a desktop session with Node.js 22+, Python 3.10+, the repository's Go
toolchain, and installed workspace dependencies. This directory deliberately
has its own frozen npm dependencies and is not required by the ordinary unit
test suite. From the repository root:

```sh
pnpm install --frozen-lockfile
pnpm --dir packages/open-browser-use-js build
npm ci --prefix scripts/browser-integration
npx --prefix scripts/browser-integration playwright install chromium
go build -o .tmp/open-browser-use ./cmd/open-browser-use
OBU_TEST_HOST_BINARY="$PWD/.tmp/open-browser-use" node scripts/browser-integration/run.mjs
```

In PowerShell, build the `.exe` and set the environment variable before running:

```powershell
go build -o .tmp/open-browser-use.exe ./cmd/open-browser-use
$env:OBU_TEST_HOST_BINARY = (Resolve-Path .tmp/open-browser-use.exe).Path
node scripts/browser-integration/run.mjs
```

To include the Go SDK caller, compile the included acceptance client and set
`OBU_TEST_GO_CLIENT_BINARY` before running the same suite:

```powershell
go build -o .tmp/go-browser-checks.exe ./scripts/browser-integration/go-checks
$env:OBU_TEST_GO_CLIENT_BINARY = (Resolve-Path .tmp/go-browser-checks.exe).Path
```

Optional variables:

- `OBU_TEST_CHROMIUM_BINARY`: an explicit Chromium executable supporting
  unpacked extension loading (otherwise the pinned Playwright download).
- `OBU_TEST_PYTHON`: Python executable (otherwise `python`).
- `OBU_TEST_GO_CLIENT_BINARY`: optional built Go SDK acceptance client; it receives
  the endpoint and fixture URL as two arguments and returns a JSON result with
  `passed: true`. Its executable digest and result are recorded alongside the
  other callers.
- `OBU_TEST_CASES`: optional regular expression selecting test names for a focused
  debugging run. The initial raw navigation/engine attachment always runs. Omit
  this variable for the complete acceptance suite.

The isolated test browser uses `--no-sandbox` because some Windows automation
environments cannot initialize Chromium's sandbox. It serves only generated
local fixture pages. This is a test-runner setting, not a recommended user
browser setting. A headed browser is required; Linux CI needs a desktop or
virtual display. The suite does not use disabled background-throttling flags.

## What it checks

- JS, Python, and the optional Go caller's semantic role/name locators, YAML snapshots and duplicate-match
  strictness.
- Waiting for an overlay, real React controlled inputs, contenteditable,
  open shadow DOM, same-origin frames, and an actual out-of-process iframe.
- Raw CDP navigation before engine attachment, and raw CDP/engine coexistence.
- CLI `call --method browserAction` and MCP `initialize` / `tools/call` through
  the real executable, with actual page mutations and engine metadata checks.
- Agent cursor presence and background screenshot PNG validity, viewport/crop/
  full-page dimensions, and image changes after a visible DOM mutation.
- Navigation/load waits, returned engine version metadata, finalize cleanup and
  prompt cancellation of an in-flight action.
- Control epochs across turn end: accepted action cancellation, rejection of old
  submissions, no implicit refresh after an external end, and explicit recovery.
- The exact test extension service worker is stopped and restarted through a
  background extension popup. Pre-restart tokens are rejected, explicit SDK
  recovery resumes the original owned tab, and activation events are observed
  continuously across the worker replacement.
- Back/forward/reload, trusted sequential key events, scrolling, HTML drag/drop,
  manual pointer drag, and release of held buttons on timeout or turn end.
- Public concurrent file-chooser wait plus locator click from a cold engine,
  actual uploaded file bytes in the main document and OOPIF, and clearing files.
- Two independent sessions receive only their own scoped CDP notifications.
- Concurrent same-URL downloads have distinct GUIDs and scoped notifications,
  produce the fixture bytes, reject foreign IDs, report unsupported local path
  lookup, and do not satisfy a fresh wait with an earlier download.
- Console/page-error/network diagnostics from the main document and OOPIF,
  redirect identities, cursor pagination, bounded overflow, UTF-8 truncation,
  and capture expiry after ending a turn or transferring ownership.
- The sentinel tab stays active throughout every successful action and failure.
- Element screenshots reveal offscreen same-origin, OOPIF and nested iframe
  owners, including after frame navigation and a cross-origin-to-same-origin
  replacement. The fixture checks exact PNG dimensions, waits for replacement
  content and compares changed pixels; images are retained for visual review.
- A real `tabs.onCreated` background child is left unattached until explicit
  backend claim, then supports snapshot/read/click and normal end-turn cleanup.
  Another session cannot use it. This fixture uses extension tab creation with
  `active:false`; renderer `window.open`/`target=_blank` activation and the first
  rendering lease after moving an independent popup remain separate known gaps.
- The final global-pause case opens the real browser action popup, pauses two
  sessions, checks held pointer/key release (including native pointer capture
  remaining after raw `dragCancel`) and blocked high/low-level CDP admission,
  restarts the worker while paused, and requires explicit new turns after Resume. It saves Running/Paused
  popup screenshots. Claim, attachment, engine navigation and raw navigation to
  this extension's own control pages must be rejected, including a control page
  manually moved into an agent's group. Pause invalidates all session epochs, so
  this case runs last.

The pause authorization check uses real runtime messages from the action popup,
an ordinary `popup.html` tab, and a fixture content script. In the tested Chromium
156 build, ordinary extension-tab senders include `tab` and `documentId`; real
action-popup senders include neither. `runtime.getContexts` separately identifies
the live `POPUP` context. The worker therefore verifies the extension ID, exact
popup URL, absence of `sender.tab`, and a matching live popup context. Context
presence is an additional check, not a unique sender/document binding when the
browser omits the sender document ID. These tests do not assert results on an
untested minimum browser version.

The runner leaves the browser window at its default size and validates screenshot
dimensions against the actual viewport. In the tested Chromium 156 build, forcing
`--window-size=1280,1000` made `action.openPopup()` hang even in a standalone
extension probe with no SDK or engine actions. That launch option is omitted.

Results, screenshots, the YAML snapshot, and diagnostic logs remain in the
printed `.tmp/browser-integration/run-*/` directory. Results include the Git HEAD,
dirty status, and SHA-256 digests of the production/staged extension, host and
Go caller executables, JS build, Python SDK, and acceptance scripts used for the
run. Executables and SDKs are copied into the run directory before execution,
so a concurrent rebuild cannot change the tested artifacts. The short temporary IPC
directory is validated and removed at exit. Browser windows and the host created
by this run are closed. A nonzero exit means at least one acceptance check failed.

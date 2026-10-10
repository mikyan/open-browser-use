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

The adapter enforces Chrome's directional physical frame limits: 1 MiB from
host to extension and 64 MiB in reverse. `js-native-large-requests` submits
concurrent multi-megabyte Unicode/HTML requests, checks page-computed hashes and
exactly one execution, and verifies subsequent small calls on the same host.
`nativeFrameStats` records frame sizes and private start/chunk/commit counts
without retaining request bodies. These adapter checks are complemented by
the separate [real native-message runner](native-message-checks.md), which uses
isolated Windows profiles and temporary native-host registration.

The worker-restart case keeps this test adapter's Go host process alive. It
verifies extension epoch recovery over the same client connections. It does not
claim automatic discovery/reconnection when a real native-host process exits;
that requires reading its new endpoint and creating a new SDK client.

The runner launches headed Chromium directly. Playwright locates the downloaded
browser executable and supplies the static YAML parser used by snapshot checks.
A small raw CDP connection inspects the
extension service worker; there is no Playwright page/context connection or
foreground activation. A sentinel tab remains active in its original window,
and every tab activation and window-focus event is retained. Auxiliary popup
fixtures use `chrome.windows.create({type:'popup',focused:false})`: Chrome may
emit one activation for that new window's sole tab. The runner permits only that
exact tab/window pair once and records it in `allowedPopupActivations`. Claim,
input, cleanup and recovery must not change the focused window. The final Pause
test intentionally opens the user's toolbar control with `chrome.action.openPopup`.
Only across that exact call, with a live matching `POPUP` context, it permits
either no focus event or precisely `[sentinelWindowId, -1]`, the sequence observed
on the tested Chromium build. `allowedWindowFocusEvents` binds each allowed
event to its original index, reason, checkpoint times and popup context;
`pause-focus-trace.json` preserves the surrounding native window states. Every
other focus event fails, including during subsequent popup close or auxiliary
cleanup. No raw events are erased, and the original sentinel tab stays active.

`js-user-site-access-popup` also uses the actual action popup and the same exact
focus ledger. It verifies allow/block settings, cancellation of a waiting click,
stale epochs, explicit resume, permitted semantic actions and PNG output, a
denied origin, mixed cross-origin frames, redirect revocation, blank bootstrap,
forged setters and persisted settings across a worker restart. It restores all
websites through the popup before cleanup. Raw events are preserved for both
intentional popup opens; no page actions receive a focus exception. Policy
semantics and limitations are in [website access settings](../../docs/references/site-access-policy.md).

The page-export cases call the public JS, Python, Go, CLI and MCP APIs and retain
`page-export-{js,python,go,cli,mcp}.{pdf,mhtml}` with byte lengths and SHA-256
digests. They verify PDF signatures and final markers, MHTML resource/frame
parts, cross-session denial, bounded-output failure and recovery, and CLI/MCP
no-overwrite publication with small metadata responses. The website-policy case
also retains an allowed PDF and rejects mixed-origin PDF and restricted MHTML.
Native errors fail these tests; no print dialog or headless fallback is used.

`js-page-exports-lifecycle` deliberately holds the resolution of a **real**
`Page.printToPDF` Promise after Chrome creates its stream. It verifies that
session end rejects the result, waits for the native operation, and closes the
exact late stream without reading it. This is a deterministic fault injection,
not a claim that normal Chrome printing exhibits that delay. The worker hook is
restored before later tests. Ordinary successful exports use unmodified native
commands. Render retained PDFs with Poppler and inspect their page images;
parse MHTML with a MIME parser to check decoded Chinese/frame content. PDF font
maps may extract visually similar Unicode radicals despite correct rendering;
the test does not rewrite exported bytes.

Select the affected public callers and policy check with
`OBU_TEST_CASES='page-exports|python-public-sdk|go-public-sdk|user-site-access'`
(eight cases including the mandatory raw prerequisite when Go is configured).

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

The fresh isolated Windows Chromium 156 run
`.tmp/browser-integration/run-xMoFkk/results.json` passed all 48 cases, including
the optional Go caller, large native requests, direct downloads, auxiliary popups and navigation waits. Its raw activation/focus
events and narrowly scoped ledgers remain in the evidence. This does not verify
native `window.open` focus suppression or full browser/extension restart.

Direct downloads passed all eight focused cases in `run-1D7lpX` before the full
run. Four new cases and the expanded Python, Go and Pause cases verify file bytes,
exact ownership, timeout, late-ID cancellation, and cancellation before cleanup.
The suite contains 48 cases with Go, or 47 without it. The separate Windows Edge
`native-u7vkkz` run passed both real native-port cases; see
[native-message acceptance](native-message-checks.md).

Navigation acceptance retains bounded stage and native request traces. The gated
page consumes the complete body of its counting fetch as well as its held fetch;
both exact request IDs must emit `Network.loadingFinished` before idle success.
An earlier failed diagnostic run proved that an unread counting response remained
unfinished in Chromium. The fixture was corrected; native idle semantics and
deadlines were not changed. Failure evidence captures state before finally opens
the remaining gates, so cleanup cannot look like successful lifecycle progress.

- JS, Python, and the optional Go caller's semantic role/name locators, YAML snapshots and duplicate-match
  strictness.
- JS locator `ariaSnapshot()` in the main document and an OOPIF. Element
  screenshots reject page-only `clip`/`fullPage` options before the same locator
  goes on to produce a valid screenshot.
- Bounded `snapshotAI()` captures and real `getByRef()` clicks in the root,
  open shadow DOM, same-origin, OOPIF and nested frames. The fixture inserts an
  earlier sibling iframe, then reorders live iframe documents with `moveBefore`,
  and checks each clicked document's actual counter to catch ref aliasing. It
  repeats capture 20 times and replaces an iframe eight times while keeping
  `maxFrames:6` and six live frames, checking public refs without reading private
  engine slot state. It
  checks offscreen nested-ref PNG dimensions against Playwright's enclosing
  document clip and DPR, and saves both the ref image and a public semantic
  locator control image. Actual bounding boxes, root scroll offsets and clips
  are recorded; fractional iframe origins can make the integer clip larger than
  the CSS element size.
  `moveBefore` must be available; this acceptance case does not silently replace
  it with document-destroying `appendChild` or claim coverage on older browsers.
  An iframe's fallback text and actual child button must both appear under its
  parsed YAML collection; malformed inline fallback output must fail parsing.
- AI capture expiry after a new capture, ordinary locator `ariaSnapshot`, root
  or child navigation, iframe owner replacement, turn end, and ownership
  transfer. Page text that resembles a ref cannot register a permitted ref.
  Raw native refs in root/frame/composite/nested selectors cannot bypass the
  capture contract; an ordinary CSS attribute value containing `aria-ref=e1`
  remains queryable. A renamed node retains its identity, a replacement node
  does not inherit the old ref, and a ref-scoped ARIA snapshot succeeds once
  before expiring that capture.
  Each size/depth/frame/ref limit rejects explicitly; missing root or child
  bodies fail within their deadline, and ending control cancels an outstanding
  capture. These three `js-ai-snapshot-*` cases can be selected with
  `OBU_TEST_CASES=ai-snapshot`; their JSON evidence and fixture source digest are
  included in the run artifacts. Snapshot-text parsing in the test selects only
  a fixed unique fixture label; production ref authorization is not regex-based.
- Waiting for an overlay, real React controlled inputs, contenteditable,
  open shadow DOM, same-origin frames, and an actual out-of-process iframe.
- Raw CDP navigation before engine attachment, and raw CDP/engine coexistence.
- CLI `call --method browserAction` and MCP `initialize` / `tools/call` through
  the real executable, with actual page mutations and engine metadata checks.
  CLI, MCP, Python, and the optional Go caller each take their own bounded AI
  snapshot, read a capture-scoped ref, and click it with a trusted page event;
  they do not consume a capture manufactured by the JS test caller.
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
- Explicit `downloadURL` / `download_url` / `DownloadURL` requests through JS,
  synchronous Python, optional Go, CLI `call` and MCP `tools/call` use HTTP GET
  with a real HttpOnly cookie. Two JS sessions request the same URL and basename;
  each returned path must remain inside the isolated download directory, name a
  different file, and contain one exact server response verified by bytes and
  SHA-256. Public opaque handles reject foreign sessions and unrelated native
  numeric download IDs. The unrelated download is created directly by the test
  worker, without an owning task RPC; this does not simulate a human click.
  Server gates verify slow completion, path timeout followed by successful retry,
  explicit cancellation, and cancellation of a late native ID after the start
  deadline. The body gate sends a 4096-byte prefix and retains a nonzero suffix;
  the original one-byte prefix stalled Chromium's native MIME sniffing before
  a download ID existed. `prefixBytes`, `suffixBytes` and `sentPrefixBytes` are
  retained as server witnesses. Native start can wait for response headers and
  sniffed bytes: a rejected start deadline does not cancel its unresolved native
  promise, and cleanup must cancel the exact ID if it arrives later. Timeouts
  were not increased to accommodate that fixture correction.
  Ending a turn, detaching, transferring ownership and the real Pause
  control invalidate owned direct downloads and stop their HTTP streams. Resume
  must not issue another request. Native Page-GUID downloads retain the separate
  unsupported-path behavior above; this suite never queries browser history.
  Paths and per-file hashes stay in ignored run artifacts. The isolated browser
  has `download.prompt_for_download=false`; passing here does not promise that
  other preferences, enterprise policies or extensions cannot display download
  UI. Files are neither opened nor shown. Select this coverage with
  `OBU_TEST_CASES='direct-downloads|python-public-sdk|go-public-sdk|user-global-pause'`
  (eight cases including the mandatory raw prerequisite when Go is configured).
- Console/page-error/network diagnostics from the main document and OOPIF,
  redirect identities, cursor pagination, bounded overflow, UTF-8 truncation,
  and capture expiry after ending a turn or transferring ownership.
- Network wait ready handles through JS, synchronous Python, optional Go, CLI
  `call`, and MCP `tools/call`: create a blank tab, navigate with the public raw
  CDP helper, arm before the first engine click, then collect. Each entry point
  checks a trusted click and an independent server counter of exactly one
  request. CLI processes carry the same explicit session, turn and control
  epoch through all three RPCs; creating another CLI process must not silently
  change the waiter's binding.
  The three `js-network-waits-*` cases also cover cold main/OOPIF request and
  response listeners, exact/contains URL and method/status matching, 503s,
  redirects with request identity, failed connections, historical rejection,
  cancellation, repeated collect, and matched results read after their original
  deadline. Server gates prove response completion at headers before the body
  finishes, and a response can match when its request began before registration.
  The connection-failure fixture separately records its one trusted click,
  one page `fetch` invocation and all server attempts: Chromium can retry the
  POST when the socket closes without response bytes. Only that failure case
  permits multiple transport attempts; the normal five-entry-point requests
  retain the exact-one server assertion. Its response wait must still time out.
  Same-URL sessions cannot exchange waiter IDs; end, detach, owner transfer and
  tab closure invalidate old waits. Sixteen retained terminal records still
  consume a tab's capacity; cancellation permits another arm.
  The existing worker-restart case rejects pre-restart waiters even after an
  explicit new turn. The final Pause case cancels a pending network collect
  before restart, then verifies Resume does not replay the trigger. The fixture
  source digest and `network-server.json` counters are saved even on failure.
  Short discovery/attach deadline injection, per-session/global capacity and
  the 30-second terminal TTL use deterministic unit tests; this headed suite
  does not claim to exercise those timings or quotas.
- Navigation waits through all five entry points: JS, synchronous Python,
  optional Go, CLI `call` and MCP `tools/call`. A cold public raw navigation is
  followed by an acknowledged `expectURL`/`armNavigationWait`, one trusted
  click, and collection of the void result. An independent HTTP counter must
  show exactly one destination document request; CLI calls retain one explicit
  session, turn and epoch. Python and Go establish listener readiness without
  threads or a second connection.
  `js-navigation-waits-direct-and-ready` also checks cold direct
  `Promise.all([waitForURL(...), click(...)])`, SPA/history URL changes, native
  glob matching, a transient intermediate URL, redirects, repeated collect,
  and rejection of a historical intermediate URL. Current-URL and cached
  load-state waits complete immediately: `expectLoadState` observes the current
  document and is not a promise to wait for the next navigation.
  `js-navigation-waits-load-states` uses separate HTTP script, image and fetch
  gates to hold DOMContentLoaded, load and networkidle. A direct state wait must
  not block a concurrent trusted click; the server releases each lifecycle gate
  explicitly, without sleeps for listener readiness.
  `js-navigation-waits-lifecycle` verifies that a URL timeout does not detach a
  concurrently waiting click, and checks cancel, end, explicit detach, ownership
  transfer and tab closure. Existing worker-restart and Pause cases invalidate
  pending navigation handles as well as network handles. Native observer
  cleanup, queue/attach deadline injection, capacity and terminal TTL are covered
  separately by deterministic tests.
  The fixture digest, `navigation-waits-*.json` witnesses and
  `navigation-server.json` counters are retained. Select the five new cases and
  both synchronous SDK callers with
  `OBU_TEST_CASES='navigation-waits|python-public-sdk|go-public-sdk'` (eight cases
  including the mandatory raw prerequisite when Go is configured). Add
  `|control-worker-restart|user-global-pause` for ten cases including recovery.
- The sentinel tab stays active throughout every successful action and failure.
- Element screenshots reveal offscreen same-origin, OOPIF and nested iframe
  owners, including after frame navigation and a cross-origin-to-same-origin
  replacement. The fixture checks exact PNG dimensions, waits for replacement
  content and compares changed pixels; images are retained for visual review.
- A real `tabs.onCreated` background child is left unattached until explicit
  backend claim, then supports snapshot/read/click and normal end-turn cleanup.
  Another session cannot use it. This fixture uses extension tab creation with
  `active:false`; renderer `window.open`/`target=_blank` activation remains a
  separate known gap.
- `js-auxiliary-popup-rendering` and `js-auxiliary-popup-lifecycle` require
  `getInfo.metadata.auxiliaryTabsVersion=1`. They claim real unfocused popup
  windows and check that ownership preserves the original window and group-less
  state. The first engine operation is a single click with its original 10-second
  deadline, followed by a screenshot, real OOPIF input and a network wait.
  Foreign session/tab-target access, concurrent claims, deliverable rejection,
  handoff retention, omission without closing the user's window, external
  movement and closed-window invalidation are checked through public APIs.
  These tests do not claim to repair Chromium rendering after an external
  cross-window move; the normal popup claim avoids that move entirely.
  The existing worker-restart and global-Pause cases also retain and reclaim an
  auxiliary popup, verify old control is rejected, and click only after explicit
  recovery. This is a worker-restart check, not a full browser or extension
  restart check. Clearing `storage.session` is modeled separately in unit tests.
  Select the four affected cases with
  `OBU_TEST_CASES='auxiliary-popup|control-worker-restart|user-global-pause'`;
  the required raw-navigation case makes this a five-case directed run. The
  complete suite contains 53 cases with the optional Go caller, or 52 without it.
  The popup is independently created with `windows.create({focused:false})`,
  not by a page's `window.open`. Initial native popup activation remains
  unsupported as a no-interruption guarantee and is not counted as passing.
  Storage-delay/failure and end/Pause races use deterministic unit tests rather
  than injected faults in this native suite. The claim response is bounded at
  10 seconds, but Chrome's underlying writes remain tracked; a never-settling
  write can keep the existing turn-end drain pending. Pause instead fails closed
  within its cleanup budget. See [popup ownership](../../docs/references/popup-ownership-design.md).
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

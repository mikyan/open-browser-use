# Browser integration acceptance

This optional acceptance suite runs **public SDKs → real Go native host →
production extension → real Chromium pages**. It creates an isolated browser
profile and local test pages; it does not install an extension in a user's
profile, read user browsing data, or change the native-host registry.

The staged extension is produced by `buildChromeExtension`. Its transport
adaptation replaces `chrome.runtime.connectNative` with a Port-compatible local
WebSocket adapter, with the matching local CSP permission. A separate test-only
extension document records native activation/focus events throughout the run,
including worker restarts; it is absent from production packages. The adapter bridges
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
extension service worker and the test observer; there is no Playwright page/context connection or
foreground activation. A sentinel tab remains active in its original window,
and every tab activation and window-focus event is retained. Auxiliary popup
fixtures use `chrome.windows.create({type:'popup',focused:false})`: Chrome may
emit one activation for that new window's sole tab. The runner permits only that
exact event index and sequence actually recorded across that creation call in
`allowedPopupActivations`. No observed event means no allowance for a later
activation; even the sentinel has no reactivation exemption. Claim,
input, cleanup and recovery must not change the focused window. The final Pause
test intentionally opens the user's toolbar control with `chrome.action.openPopup`.
Only across that exact call, with a live matching `POPUP` context, it permits
either no focus event or precisely `[sentinelWindowId, -1]`, the sequence observed
on the tested Chromium build. `allowedWindowFocusEvents` binds each allowed
event to its original index, reason, checkpoint times and popup context;
`pause-focus-trace.json` preserves the surrounding native window states. Every
other focus event fails, including during subsequent popup close or auxiliary
cleanup. No raw events are erased, and the original sentinel tab stays active.

The observer has one stable document identity and a local delivery sequence;
these are not Chrome-wide event IDs. It retains duplicate events, rejects
overflow and history truncation, and does not hand logs between replacement
workers. The initial worker and observer setup snapshots are saved separately
and must both be quiet. This is an initialization check, not proof of complete
coverage before observer readiness or during process startup. All tested agent
actions begin after readiness. The final saved snapshot is validated again,
including on failed cases; a lost observer or an unexpected late event fails
the run. Teardown after that checkpoint is outside the measured action interval.
The pure event-ledger unit tests run in ordinary CI without browser dependencies.

The acceptance runner explicitly disables Chromium's **testing field-trial
configuration** with `--disable-field-trial-config`, matching Playwright's
normal launcher for the same executable. It does not inherit Playwright's
background/occlusion flags. This matters because an unbranded Chromium build
otherwise loads experiments from `fieldtrial_testing_config.json`: the pinned
build's toolbar experiment includes a 100-second renderer commit delay and a
12,000-frame surface deadline. This is a controlled test baseline, not a
production extension workaround or proof about all user experiment settings.
Set `OBU_TEST_FIELD_TRIAL_CONFIG=browser-default` to reproduce the previous
unmodified launch policy; the default is `disabled`, and other values fail
before launch. `browser-startup.json` records the selected policy, exact spawn
arguments, binary hash and `windowsHide`; it is separate from focus evidence.
See the [startup trace and experiment evidence](../../docs/references/headed-browser-startup.md).

On this controlled baseline, `run-Uq8Fkj` passed the three directed input/image
cases and `run-NJ72u2` passed all **61 headed cases**, including the Go client
and eight media cases. The continuous observer passed final validation: five
exact sole-tab popup activations and four focus events from the two intentional
control-popup openings were recorded and attributed. Ordinary page actions had
no additional foreground events. Earlier browser-default failures remain
failed evidence; this result is not cross-platform or all-configuration parity.

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

The suite currently contains 53 cases with the optional Go caller. The latest
complete headed run, `run-obwspc`, passed 29/53; background first-frame waits
failed. The continuous-observer revision's three affected headed cases in
`run-8j69VK` still failed, with the final raw event ledger retained and checked.
The isolated Headless run `run-IajAnU` passed four selected cases, including
three real worker restarts in the same observer lifetime, with two exact
auxiliary-window initial tab activations and no focus events. That focused
result is not a headed, system-clipboard or complete-suite pass. The 15 pure
ledger/deadline tests pass without launching a browser.

The earlier isolated Windows Chromium 156 run
`.tmp/browser-integration/run-xMoFkk/results.json` passed all 48 cases, including
the optional Go caller, large native requests, direct downloads, auxiliary popups and navigation waits. Its raw activation/focus
events and narrowly scoped ledgers remain in the evidence. This does not verify
native `window.open` focus suppression or full browser/extension restart.

Direct downloads passed all eight focused cases in `run-1D7lpX` before the full
run. Four new cases and the expanded Python, Go and Pause cases verify file bytes,
exact ownership, timeout, late-ID cancellation, and cancellation before cleanup.
That historical suite contained 48 cases with Go, or 47 without it. The separate Windows Edge
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

## Isolated clipboard acceptance

The default headed suite never reads or writes the system clipboard. Clipboard
checks require `OBU_TEST_MEMORY_CLIPBOARD=1` and the exact Windows Chromium
binary audited in `memory-clipboard.mjs`. Before any clipboard call the runner
checks the executable SHA-256, native version/revision and actual Headless
command line. A new profile alone is not a clipboard isolation boundary.

Set `OBU_TEST_CASES='clipboard'`, `OBU_TEST_HOST_BINARY` to the freshly built CLI
and `OBU_TEST_GO_CLIPBOARD_BINARY` to the separately built
`./scripts/browser-integration/go-clipboard-checks` executable. Python must be
available on PATH. The five public callers use their copied SDKs/executables,
synthetic Unicode text, HTML and a two-pixel PNG. Results retain the guard,
source hashes and native clipboard artifacts for independent pixel inspection.
Windows text newline conversion and browser HTML/PNG rewriting are expected;
the test does not require byte-identical PNG encoding.

The lifecycle fixture holds the production broker's final asynchronous scope
validation after preparation, ends the turn, and checks that cancellation
prevents native commit while turn end waits for cleanup. This is explicit
fault injection through a backend reference added only to the staged test build;
it does not mock native clipboard APIs or grant authorization. The reference is
recorded in `sourceIdentity.testHooks` and absent from production packages.
Preparation and ownership errors must leave the seeded
clipboard unchanged. Tab activation and window focus ledgers remain checked.

The memory mode also runs `js-clipboard-worker-restart`: a real worker stop/start
interrupts a prepared write. The old caller must fail, an explicit new turn must
read the seeded content, and recovery must close the original offscreen document
without replaying the write. Together with the mandatory raw navigation case,
the clipboard selection contains eight cases. Committed native promise hangs
and marker-storage failures use separate deterministic tests.

These checks establish behavior against Chromium's in-memory clipboard, not
headed OS clipboard behavior or desktop focus. The temporary process currently
uses `--no-sandbox`; no daily browser profile, installed extension or native
clipboard is touched. See the [contract and limitations](../../docs/references/clipboard.md).

## Image source downloads

The media fixture exercises `locator.downloadMedia` through JS, Python, Go,
CLI and MCP. It downloads the exact image's selected HTTP(S) source using the
production utility-world adapter, then checks the file bytes against a synthetic
two-pixel red/green PNG. `picture`/`srcset`, semantic locators, open shadow roots,
same-origin, OOPIF and nested frames are covered. Main-world prototype and
instance getters return a poison URL; neither those getters nor input events
may run. Unsupported elements/sources, strictness and foreign ownership must
fail without a download GET.

Build the current host and the separate Go caller, then set
`OBU_TEST_HOST_BINARY` and `OBU_TEST_GO_MEDIA_BINARY` to their executables:

```sh
go build -o .tmp/media-host ./cmd/open-browser-use
go build -o .tmp/go-media-checks ./scripts/browser-integration/go-media-checks
OBU_TEST_HOST_BINARY=.tmp/media-host \
OBU_TEST_GO_MEDIA_BINARY=.tmp/go-media-checks \
OBU_TEST_CASES='^(js|python|go|cli|mcp)-media-downloads$' \
node scripts/browser-integration/run.mjs
```

On Windows, use `.exe` outputs and the equivalent PowerShell environment
assignments. Python must be available on PATH. The runner supplies each caller
with the endpoint, fixture URL, exclusive output path and this run's download
directory. The Python/Go helpers do not launch a browser or inspect a real user
profile. They retain file bytes, SHA-256 and base64 evidence, then cancel the
download handle and finalize their independent sessions.

`media-js.json`, `media-{python,go,cli,mcp}.json`, the copied callers and
`media-download-server.json` retain source hosts, GET counts, cookie presence,
files and source/binary hashes. Cross-frame cookies are observed separately:
downloads have no tab/frame parameter, and this test does not prove partitioned
authentication or inspect browser third-party cookie settings.

The phase result `run-yzlAP6` passed six cases, including mandatory raw
navigation, using the pinned Headless guard enabled by
`OBU_TEST_MEMORY_CLIPBOARD=1`. Ten PNGs and all recorded hashes were independently
checked; the continuous observer recorded no activation or window-focus event.
That guard name comes from clipboard isolation; this media selection performs
no clipboard operation. This is not headed acceptance or a fix for P09.
The final selection `OBU_TEST_CASES='media-downloads'` also runs reference,
lifecycle and navigation checks. With the context-lease fix, `run-FDmPto` passed
9/9 under that guard; the same production, SDK, host and fixture hashes ran
headed in `run-XLWzut`: all eight media cases passed, while mandatory raw
navigation timed out, so the run remains 8/9. Each run retains seventeen PNGs
with verified red/green pixels and seventeen explicit download GETs. The
continuous observer recorded no activation or focus event in either run.

References cover root/shadow/same-origin/OOPIF/nested images, stale/removed refs,
foreign handles and separate files/IDs for the same URL in two sessions. The
lifecycle fixture deliberately holds delivery of an already settled native
capture result, changes its source/node, ends the turn, or navigates the exact
tab. It requires either one completed release of the original object or native
destruction of that object's exact context, and no extra download GET. This is
explicit delivery fault injection, not evidence of an unresolved native call.
The failed process run `run-cAYlXr` remains 6/9. Its fixture interference was
corrected by distinguishing one renderer fallback load, avoiding a navigation
queued behind its own held source, and observing the page without SDK
reattachment after turn end. No failed record was rewritten as passing.

Complete local CI passed with 663 extension/script tests, 93 JS tests, 63 Python
tests, Go packages and the other workspace checks. These results do not repair
the headed startup compositor or establish complete Browser Use parity.
See the [media contract](../../docs/references/media-downloads.md) for unsupported
video/audio, blob/data and Canvas sources.

## Ownership and host recovery

Select `OBU_TEST_CASES='js-owned-tab-revocation|js-native-host-restart'` for the
ownership/disconnection checks (mandatory raw navigation also runs). The
synthetic pages retain trusted pointer/key events and a target which appears
only after revocation. The fixture checks three actual Chrome tab operations:
ungroup, transfer into a foreign task group, and move to an unfocused normal
window. It verifies cancellation, release of pointer capture and Shift,
debugger detachment, and explicit reclamation. Observation uses fixed scripting
reads on the exact fixture document and does not reattach through the SDK.

The host case terminates the real frozen host executable and waits for its PID
to exit before closing that generation's WebSocket Port adapter. A new host
gets a new PID and endpoint; the extension reconnects using its normal alarm.
No queued old native frame or response is replayed. The same browser, worker,
profile and continuous focus observer remain alive. The fixture explicitly
connects and begins a new turn, and verifies the old epoch cannot act.

`recovery-tab-ownership.json`, `recovery-native-host.json`, source hashes and
`results.json.nativeHostGenerations` retain the evidence, including failed
cleanup. A new window's sole-tab creation activation is attributed to that
exact creation interval; the later tab move gets no activation/focus exception.
This is not a full browser restart, extension reload, or installed native-host
launcher test. Run the entire suite after lifecycle changes because existing
worker, transfer, Pause and policy recovery must remain compatible.

Final `run-PeM3FT` passed 63/63 on the controlled headed baseline, with matching
production/SDK/host/harness hashes. The continuous ledger contains five popup
and one normal fixture window's sole-tab creation activations, plus four focus
events from two deliberate action-popup opens. No other foreground event was
allowed. Earlier full `run-ssmjWr` remains 12/63: normal target closure exposed
a late CRX detach failure which incorrectly triggered global Pause. The focused
failure `run-4NEQV8` and original release-error witness are retained. Successful
cleanup now requires the original attachment's native destruction evidence;
error text alone is never treated as proof.

## Native first-frame diagnosis

`node scripts/browser-integration/rendering-probe.mjs` runs the minimal native
extension independently of the SDK, host and production extension. It uses the
pinned Playwright executable, a fresh profile and generated loopback pages.
The default `startup-and-secondary` mode compares inactive targets in the
startup window and a subsequently created unfocused normal window. The other
explicit modes are `no-startup-window`, `popup-then-normal` and `app-startup`.
The app mode tests the original synthetic app page itself before the normal
window; that first result is an active-page control, not inactive-tab acceptance.

Each stage requires a real screencast frame and completed ACK before sending
one trusted synthetic-page click and capturing a PNG. It records native promise
settlement separately from observation timeouts, viewport/scroll state, raw
activation/focus events, browser/source hashes and cleanup. A missing first
frame produces a nonzero exit and is never replaced by rAF success or replayed
input. Artifacts remain under `.tmp/browser-integration/rendering-*`.

`--startup-trace` (only with `startup-and-secondary`) starts tracing before
browser creation and retains the raw Perfetto stream, exact revision, config
and source hashes, stage clock markers and bounded stream cleanup. Its Windows
helper takes read-only root-process HWND snapshots; these are not a continuous
OS foreground log. The probe preserves native promises after observation
deadlines and retains partial or unexpected trace bytes as failed evidence.
Offline decoding must verify startup coverage and typed scheduler fields;
successful tracing setup alone never proves either.

The probe defaults to the browser's own field-trial policy, independently of the
acceptance runner. Add `--disable-field-trial-config` with `--startup-trace` for
the controlled baseline. The alternative `--disable-initial-surface-sync`
reproduces the narrower command-line experiment; Chromium can skip an entire
testing study when any of its features is overridden, so it is **not** an
isolated single-feature experiment. The two comparison flags cannot be combined.

The probe closes only its private browser. Root-process exit, actual native
command settlement and trace-stream cleanup are reported separately;
descendant processes are not inventoried. These diagnostics do not repair
production rendering. See the [retained failures and source analysis](../../docs/references/headed-browser-startup.md).

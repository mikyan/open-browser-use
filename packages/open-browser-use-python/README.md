# Open Browser Use Python SDK

Python client for controlling a real Chrome profile through Open Browser Use.
The package distribution is `open-browser-use-sdk`; the import module remains
`open_browser_use`.

## Installation

```sh
pip install open-browser-use-sdk
```

The SDK expects the `open-browser-use` CLI and Chrome extension to already be
installed and connected:

```sh
open-browser-use ping
open-browser-use info
```

## Usage

```py
import json
import os
import tempfile
from pathlib import Path

from open_browser_use import connect_open_browser_use

runtime_dir = Path(tempfile.gettempdir()) if os.name == "nt" else Path("/tmp")
registry = json.loads((runtime_dir / "open-browser-use" / "active.json").read_text())

browser = connect_open_browser_use(
    socket_path=registry["socketPath"],
    session_id="python-sdk-example",
)

try:
    browser.client.name_session("Python SDK example - OBU")
    tab = browser.new_tab()
    tab.goto("https://example.com", wait_until="domcontentloaded")
    print(tab.title())
finally:
    browser.client.finalize_tabs([])
    browser.close()
```

Use `OpenBrowserUseClient` directly when you need raw Browser Use JSON-RPC or
CDP methods.

## Locators and browser actions

The development extension bundles a real Playwright engine. Update the host,
extension, and SDK together before using these helpers:

```py
tab = browser.new_tab("https://your-test-site.example/form")
tab.get_by_label("Email").fill("reader@example.test")
tab.get_by_role("button", name="Continue", exact=True).click()
tab.frame_locator("iframe").get_by_test_id("status").wait_for()
print(tab.dom_snapshot())  # Semantic ARIA snapshot, rather than plain innerText.
print(tab.playwright.engine_info)  # Actual bundled engine versions.
image = tab.screenshot(full_page=True, timeout_ms=30000)  # {base64, mimeType}
```

Locators support CSS, role/name, text, label, placeholder, alt text, title, test
ID, frames, `filter(has_text=...)`, `nth()`, `.first`, and `.last`. Locator chains
are immutable. Actions use Playwright's strict matching and actionability checks,
including controlled form inputs and open shadow roots. Coordinate input is
available through `tab.mouse` and `tab.keyboard`; it does not move the OS cursor.
Use `go_back`, `go_forward`, `reload`, locator `focus`, `press_sequentially`,
`scroll_into_view_if_needed` and `drag_to` for history and richer input. Dragging
resolves the target before pressing. Cancelling after input was sent releases
held buttons and can trigger `pointerup`/click; it cannot undo page effects.

`tab.diagnostics(limit=100, after=previous["cursor"])` returns bounded console,
page error and network summaries from the current engine attachment. Omit
`after` on the first call. The result includes `captureId`, `entries`, `cursor`
and cumulative `dropped`; old cursors expire after detach. Capture starts before
the first engine action and does not include earlier activity, headers or bodies.

`client.browser_action(...)` returns the protocol's `{value, engine}` envelope;
`tab.action(...)` and locator helpers return its `value`. Action deadlines default
to 10 seconds and accept `timeout_ms` from 1 to 120000. The transport budget allows
the engine to report its own timeout. No failed mutation is automatically replayed.
The bundled engine version and remaining capability gaps are documented in
`docs/product-specs/browser-use-parity.md`; this is not a claim of full parity.

`tab.snapshot_ai()` and `tab.playwright.snapshot_ai()` return complete recursive
frame observations. `AISnapshot` / `AISnapshotStats` are exported TypedDicts;
the runtime result is a dictionary:

```python
capture = tab.snapshot_ai(max_bytes=65536, timeout_ms=10000)
print(capture["snapshot"], capture["stats"])
# Choose a ref listed in capture["refs"] after reading the observation.
target = tab.get_by_ref(capture["captureId"], chosen_ref)
target.click()
```

The result has `captureId`, `snapshot`, `refs`, `stats` (`bytes`, `nodes`, `refs`,
`frames`) and `complete: True`. The SDK checks completeness, unique structured
refs, UTF-8 bytes, counts and requested limits; it never extracts refs from page
text. Optional positive integer budgets are `max_bytes` (262144), `max_nodes`
(5000), `max_refs` (2000), `max_frames` (32 including root) and `max_depth` (64).
Those are also the defaults and hard ceilings; `None` omits an option. Limit or
child-capture failures are explicit, without a partial successful snapshot.
Engine metadata advertises `capabilities: {snapshotAI: 1, captureRefs: 1}` and
`snapshotLimits`; an unsupported extension fails without falling back.

`get_by_ref` is also available through `tab.playwright`. Its singleton locator
supports normal actions, reads, screenshots and same-tab drag targets, but cannot
be chained with selectors, `get_by_*`, frame/ordinal builders or filters. It
addresses the original connected Element, not a replacement found by text.
Every new ordinary/AI snapshot and frame lifecycle event invalidates the capture,
as do attachment, owner or epoch changes, pause and restart. A ref's
`aria_snapshot()` uses the ref and invalidates its capture afterward. Expired
refs are never recaptured or replayed automatically. `dom_snapshot()` retains
its existing scoped ARIA behavior.

## Local transport

Use the `socketPath` published by the host rather than constructing an endpoint.
Windows uses a local `\\.\pipe\...` named pipe; macOS/Linux use Unix sockets.
The Windows implementation needs no extra Python packages and supports bounded
overlapped I/O. An old Windows host publishing a `.sock` path must be updated.

`timeout` bounds the entire synchronous request, including fragmented responses
and notifications. Timeout, EOF, or invalid framing closes that connection. A
subsequent explicit request reconnects; the caller must check page state before
deciding whether to repeat a mutation. Use separate clients for concurrent Python
request streams. Frames larger than the host's 64 MiB limit are rejected.

Run unit checks with `python -m unittest`. To also exercise the real Go host,
set `OBU_TEST_HOST_BINARY` to a freshly built host executable before running them.
## Turn lifecycle

The first protected request discovers the extension's lifecycle version. On a
current extension, the client obtains a persistent control epoch and includes it
in each request. Successful `turn_ended()` and `finalize_tabs()` install the next
epoch and turn ID. Requests from an ended epoch are rejected by the extension,
including after worker restart; the SDK never refreshes and replays them.

After inspecting a stale-epoch error or an uncertain end result, call
`browser.client.begin_turn()` explicitly before submitting new work. This reads
current control state; it does not replay any operation. Older extensions without
the capability flag retain legacy behavior. Use separate clients for separate
sessions. This synchronous client is not safe for simultaneous requests from
multiple threads or nested requests from notification handlers.

Capability discovery, connection and input share the request deadline. The SDK
reduces the engine's action timeout by elapsed discovery time and reserves one
second for cancellation and the response. If no action budget remains, it fails
before sending browser input.

`new_tab(url)`, raw `cdp.call` and raw navigation/loading helpers also share their
original binding and deadline across all internal stages. Raw navigation checks
the returned loader identity so an old complete document cannot satisfy the new
load. An error does not switch these helpers to a new epoch or replay a stage.

File chooser/download waits default to 10000 ms, accept integer `timeout_ms`
from 1 to 120000 and reserve one second for the response. Use separate clients
with the same session for a synchronous waiter and its trigger. Download IDs are
opaque GUIDs scoped to the originating task; never infer a local filename from
them. `download_path` reports `OBU_DOWNLOAD_PATH_UNAVAILABLE` because the browser
does not expose a reliable GUID-to-local-path mapping through this extension API.

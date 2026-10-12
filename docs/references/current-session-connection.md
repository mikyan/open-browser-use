# Connecting to an existing browser session

The development CLI can discover the Browser WebSocket of a selected Chrome or
Edge Stable instance. This is an optional connection for original Page download
paths; ordinary extension use does not require it. It is not included in the
published `preview-20261011-593a4ba` package.

## User flow

The browser must already be running with remote debugging explicitly enabled by
the user. Chrome documents its [current-session flow for Chrome 144+](https://developer.chrome.com/docs/devtools/agents/use-cases/auto-connect);
Microsoft documents [Edge's current-instance opt-in](https://learn.microsoft.com/en-us/microsoft-edge/web-platform/devtools-mcp-server#auto-connect-to-a-running-edge-instance).
Follow that browser's inspect-page instructions and approve its connection
prompt if shown. The CLI does not change this setting or approve permission UI.

Select the exact Native Host endpoint from `open-browser-use profiles --connected
--json`, and bind it to the chosen browser:

```text
open-browser-use bind-browser --socket <exact-host-endpoint> --auto-connect --browser edge --exclusive
```

Use `--browser chrome` for Chrome Stable. An explicit absolute local
`--user-data-dir <root>` selects a custom user-data root; this is the directory
containing `DevToolsActivePort`, not its `Default` profile subdirectory. Without
it, discovery uses the selected browser's existing platform catalogue root.
Only `chrome` and `edge` are accepted here. `--cdp-url` remains available for an
explicit endpoint and cannot be combined with `--auto-connect`. Browser and
user-data flags require auto-connect. No browser is launched or selected by
recency, and there is no fallback to another root or port.

`--exclusive` authorizes this connection to set CDP download behavior to
`default` and enable events. It must not compete with another controller's
download override. This changes CDP context state, not user download preferences;
see [original ownership and cleanup](original-page-download-delivery.md).

For a subsequent task that needs the actual file, prepare the page's download
with `requirePath: true` and wait for its ready acknowledgement before triggering
the export. The readiness check uses the original binding; a prior available
capability response alone does not cover disconnection during preparation.
This option and its SDK spellings are documented with
[original-file readiness](original-page-download-delivery.md#required-file-path-readiness).

## Discovery, identity and deadlines

Discovery reads only the selected root's `DevToolsActivePort`: an ordinary file
of at most 4096 bytes, with a valid port and `/devtools/browser/<id>` on exactly
two lines. CRLF and one trailing newline are accepted. Symlink leaves,
nonregular files, changed file identity/size, extra lines and malformed endpoints
are rejected. Explicit Windows UNC/device roots are rejected. Parent-directory
links and filesystem mounts are not an authentication boundary.

The port file locates a candidate; it does not prove browser identity. The host
still requires the original Native Port's random nonce and exact extension,
installation instance, worker boot and port identity before configuring downloads.
Multiple matching workers remain ambiguous and are rejected. Discovery performs
no HTTP `/json/version` probe, port scan, History read or filename matching.

One original deadline covers discovery, local IPC, browser approval, identity
and setup. Auto-connect defaults to 60 seconds; explicit URL mode retains
10 seconds. `--timeout` accepts 1 ms through 120 seconds. The Browser handshake
uses the remaining total budget; each subsequent CDP command still has a maximum
of 10 seconds. Ordinary setup commands are capped by that same deadline; existing
identity-detach and retirement cleanup have separate bounded one-second budgets
and cannot resume setup. Approval does not restart the clock.
Denial, expiration and disconnect are terminal for that attempt, with no retry.
The permission hint goes to stderr; stdout remains the original JSON result.

Discovery admits at most one file-reader worker per process. The caller returns
on cancellation even if a kernel file read is still blocked; that worker owns
the handle until it actually returns. This is a bound on pending work, not a
promise to forcibly cancel filesystem I/O. No late result can submit a binding.

## Verification boundary

Native HTTP/WebSocket tests cover an actual 11-second Upgrade response, denial,
cancellation and a late successful handshake. The old ten-second setup rejected
the same delayed response; the new implementation succeeds. An unacknowledged
CDP command still becomes terminal after ten seconds. These are native peer
tests, not browser permission-dialog acceptance.

The integration runner's `OBU_TEST_ORIGINAL_DOWNLOADS=auto-connect` uses a fresh
isolated launch-flag Chromium. It passes a root directory, not a CDP URL, to the
production CLI and retains the original five-entry download assertions. This
does not verify normal-start permission UI, default-root runtime selection,
Edge approval or multi-profile combinations. Actual browser authorization can
activate its window; authorization and subsequent background tasks must be
measured separately. The complete Browser Use parity goal remains open.

On Windows, final `h9Udpf` passed both selected cases with actual exit 0: five
entry points delivered 30 original files/5200 bytes across six all-ready groups.
It records the before/after capability responses, exact binding generation,
worker identity, CLI args and actual process close. The continuous 12853 ms
task interval had zero activation/focus events and no allowances. Earlier
`YRvEbg` also passed, but did not preserve those two capability responses.
Manual URL compatibility `ZwGUxs` passed 2/2 with 18 files/3120 bytes and 9381 ms
of zero focus/activation; its source checkpoint also predates that evidence-only
addition. These are isolated Chromium runs with the Native Port loopback adapter.

Both modes preserve the JS foreign-GUID, missing-file and held-transfer checks;
they do not provide all-five-entry negative coverage or unowned user-download
acceptance. The runner closes the browser before the host during teardown, so
the retained host shutdown warning cannot prove a download-reset ACK. That
teardown is outside the focus interval and is not reported as an error-free
native cleanup sequence. Host exit 0 is recorded separately.

Windows Go tests pass 654 with 27 platform/permission skips (plus eight packages
without tests); focused Node checks pass 68 with no skips. Native peer tests
pass 84. CLI tests pass 287 with 24 skips; final selected binding tests pass
21 with one Windows symlink-permission skip. Linux WSL executes the binding
tests with real Unix sockets, FIFO and symlink cases: 23 pass, no skips.
Linux amd64 and macOS arm64 CLI test binaries cross-compile; this does not claim
macOS runtime or either platform's browser approval coverage. Vet passes.
The unchanged 125-case unbound browser baseline was not rerun for this bound
connection slice. The 61 build inputs and ten binaries are frozen together;
published preview ZIPs remain unchanged.

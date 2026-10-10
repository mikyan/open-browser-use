# Clipboard

## Protocol

`getInfo.metadata.clipboardVersion === 1` identifies the bounded clipboard
protocol. The four existing RPC names and snake_case rich fields are preserved.
Every call requires the current session/turn/epoch and an owned HTTP(S) `tabId`.
The tab authorizes the task: a desktop clipboard is still shared with other
sessions and applications. Website allow/block modes reject these operations.

| Method | Payload | Result |
| --- | --- | --- |
| `readClipboardText` | — | `{text}` |
| `writeClipboardText` | `text` (empty allowed) | `{}` |
| `readClipboard` | — | `{items}` |
| `writeClipboard` | `items` | `{}` |

`timeoutMs` defaults to 10000 (1–120000). `maxBytes` defaults to and cannot
exceed 16777216, counted across decoded UTF-8 text and PNG bytes. Requests and
results reject malformed Unicode, unknown fields, duplicate MIME types, dual
payloads, noncanonical base64 and oversized content instead of truncating it.
The extension and SDK helpers cap normalized request/result JSON at 48 MiB, including
the host's HTML and Unicode escaping expansion. Highly escaped text can reach
this wire limit before the decoded 16 MiB limit; it fails with
`OBU_CLIPBOARD_LIMIT`. Neither cap bounds native clipboard or temporary
serialization memory.

Rich `items` has at most one item with one to three unique `entries`:
`{mime_type:"text/plain",text}`, `{mime_type:"text/html",text}`, and
`{mime_type:"image/png",base64}`. Optional `presentation_style` is `unspecified`,
`inline` or `attachment`. Empty rich writes are scoped no-ops, not clipboard
clears. Reads fetch only the three supported representations. PNG has at most
16777216 pixels and is decoded by the trusted browser document before writing;
SDK structural checks are not a full image decoder. Browsers may sanitize HTML
and re-encode PNG; Windows can normalize text newlines to CRLF. Fidelity
concerns content and pixels, not exact HTML, newline or PNG byte identity.

## Execution and lifecycle

`BrowserClipboard` allows one global operation. Admission, preparation, native
execution and result validation share the original deadline. Timed-out work
retains capacity until its actual Promise settles; concurrent calls fail busy.
No clipboard bodies are stored or logged.

Packaged offscreen code owns the native clipboard API. A private runtime Port
is bound to extension ID, exact URL, document ID, live `OFFSCREEN_DOCUMENT`
context and per-document nonce. Chromium may omit the Port sender's document
ID: the broker obtains it from the unique live context, then proves the hello
nonce against the exact tabless native target before trusting the channel.
Native debugger target identity must match
before applying focus emulation to that hidden document. No user tab, visible
helper window or system mouse is activated. Page JavaScript and broadcast
runtime messages do not carry clipboard contents; HTML is never inserted into
the broker DOM.

Preparation and commit are separate. After asynchronous preparation the worker
rechecks ownership and deadline immediately before commit; the broker checks
generation and deadline again before the native call. Navigation, lost ownership,
end, detach and Pause invalidate old results. A submitted native write may still
finish after cancellation: it is neither rolled back nor automatically retried.
End and Pause wait for actual settlement.

A persistent session marker contains only operation/owner identity. Worker
recovery drains the same live document without replaying a write. Missing or
unverifiable original state leaves cleanup unconfirmed and blocks new clipboard
work. Explicit Retry Pause can reconcile the original document; creating a new
document cannot establish that an earlier native write was cancelled.

## Public callers

JS exposes `tab.clipboard.readText/writeText/read/write`; Python uses
`read_text/write_text/read/write`; Go uses `tab.Clipboard()`. Client methods
retain their wire envelopes. Capability checks include manual epochs and the
deadline includes negotiation and queue time.

```sh
open-browser-use clipboard read-text --tab-id 123
open-browser-use clipboard write-text --tab-id 123 --text 'Example'
open-browser-use clipboard read --tab-id 123 --output clipboard.json
open-browser-use clipboard write --tab-id 123 --input clipboard.json
```

Rich files contain the `{items}` envelope. Output directories must exist;
atomic publication never overwrites and requires hard-link support. MCP offers
`read_clipboard_text`, `write_clipboard_text`, `read_clipboard` (`output_path`)
and `write_clipboard` (`input_path`). Text reads appear once in MCP text content;
rich reads return file metadata. Generic `call` retains its raw envelope with
the same validation and capability gate.

## Acceptance boundary

Initial native feasibility passed on Windows Chromium 156.0.8078.4 using its
headless in-memory clipboard: text/HTML/PNG, extension-owned debugger attachment,
focus emulation, untouched page interception traps, and empty tab/window event
ledgers. Unfocused Async Clipboard correctly failed. No page permission grant,
user gesture or special debugger flag was used.

The isolation guard is based on the exact upstream revision's
[headless startup](https://chromium.googlesource.com/chromium/src/+/f842f52ef39fd97b449eb27cff414bf05a98ddce/chrome/browser/headless/chrome_browser_main_extra_parts_headless.cc)
and [platform-independent clipboard](https://chromium.googlesource.com/chromium/src/+/f842f52ef39fd97b449eb27cff414bf05a98ddce/components/headless/clipboard/headless_clipboard.cc).
The runner requires an explicit environment switch, pinned executable hash,
native version/revision and actual `--headless=new` command line before a
clipboard call. A browser profile alone does not isolate a desktop clipboard.
The temporary test process needs `--no-sandbox` in this environment.

The public-entry and lifecycle suite passed 8/8 on that pinned build. JS,
Python, Go, CLI and MCP round-tripped Unicode/plain text, HTML and PNG; an
independent decoder verified the PNG's two RGBA pixels. Empty rich writes and
rejected writes left contents unchanged, foreign ownership was rejected, and
CLI/MCP output metadata and no-overwrite behavior were checked against files.

The lifecycle case deliberately holds final scope validation after preparation:
turn end cancels the caller, waits for cleanup, and prevents commit. A real
service-worker stop/start during another prepared write preserved the seeded
clipboard, rejected old control and did not replay the write. The old caller
timed out; recovery did not fabricate a success response. A separately created
unfocused auxiliary window produced its own tab-activation event; there were
no window-focus changes or clipboard-caused tab activations.

Deterministic tests cover pending committed native operations, preparation and
storage delays, unknown recovery, failed marker reads, Pause retries and
competing/forged private channels. These are injected failures, not claims of
reproducing every native browser failure. The ordinary headed regression suite
is evaluated separately and never calls clipboard APIs.

These results do not establish sandbox compatibility, headed OS clipboard
behavior, other platforms or full Browser Use parity. The user's daily clipboard
and installed browser profile were not read or modified.

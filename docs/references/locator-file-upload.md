# Locator file uploads

The development `browserAction` protocol supports `setInputFiles` on an exact
file-input locator, including hidden inputs. It uses the same browser-side file
submission registry as file choosers. No click, chooser dialog, scrolling or
foreground activation is part of this action.

## Public contract

The engine advertises `capabilities.locatorFileUpload: 1`. JavaScript, Python and
Go helpers check that capability within the original scope and action budget.
An older extension fails explicitly; there is no fallback to clicking the page.
CLI/MCP can use the existing `browserAction` call:

```json
{
  "tabId": 123,
  "action": "setInputFiles",
  "locator": [{"kind": "css", "selector": "input[type=file][name=attachments]"}],
  "args": {"files": ["C:\\Work\\report.pdf"]},
  "timeoutMs": 10000
}
```

Choose the locator and paths from the authorized task and current page evidence.
Paths refer to the browser machine. The SDK does not read files or resolve paths
against the caller's working directory. Accepted absolute forms are POSIX `/`,
Windows drive paths and UNC server/share paths. The array contains at most 1024
paths, each nonempty and without NUL or malformed Unicode. Each path is at most
131072 UTF-8 bytes and their combined UTF-8 size is at most 8 MiB.

```js
await tab.playwright.locator('input[type=file][name=attachments]')
  .setInputFiles([absolutePath], { timeoutMs: 10000 });
await tab.playwright.locator('input[type=file][name=attachments]')
  .setInputFiles([]); // Explicitly clear this input.
```

Python uses `locator.set_input_files(paths, timeout_ms=10000)`; Go uses
`locator.SetInputFiles(paths, BrowserActionOptions{Timeout: ...})`.
Go's nil slice is normalized to an empty array. JavaScript and Python require
an array/list rather than null. Multiple paths require a `multiple` input.
The locator must resolve strictly to a connected HTML file input. Visibility
is not required; matching a label element or an arbitrary upload button does
not authorize selecting a different element.

## Completion and lifetime

`timeoutMs` is an integer from 1 to 120000, defaulting to 10000. The original
action deadline includes capability negotiation, queuing, locator
resolution and submission. Once selected, the original node, frame, context,
attachment and control scope remain fixed. A replacement node is not selected
as a retry after submission. The chooser and locator entry points share the
same-node reservation; a pending or unknown native submission prevents another
submission through these APIs. Arbitrary page scripts and authorized raw CDP
are not made transactional by this reservation.

Ordinary files complete after the original native write acknowledgement. Empty
arrays use the existing clear behavior, which emits synthetic `input` and
`change` events. A single path on a `webkitdirectory` input uses the existing
directory flow: native acknowledgement plus a trusted completion event on the
original input. Native cancellation is an error. A successful file change may
navigate; it must retain the original action's authority to count as success.
Verify the site's actual upload or submission separately from the API reply.

Directories retain Chromium's visibility restrictions. For a new directory
workflow use the explicit `backgroundWindow` option described in
[file transfers](file-transfers.md); the locator helper does not move or activate
an existing page to work around cancellation. Files can be assigned to a hidden
input without making that input visible.

Pause, control end, ownership loss, attachment changes and expiry prevent late
ordinary submission. A timeout is not proof that an already submitted mutation
did nothing. Inspect the resulting page before deciding on a new upload; the
SDK and extension do not replay it automatically.

The existing legacy control protocol remains valid when the wire epoch is
omitted: admission captures the current ledger epoch synchronously and keeps
that original scope. It does not adopt a successor turn. Unconfirmed utility
handle releases retain their original engine entry and cleanup callback;
reattachment stays blocked until cleanup succeeds. A cleanup failure is reported
even if the file write itself has already completed.

## Verification

The final isolated headed Chromium 156 run `tQEVZJ` passed 118/118 cases, preserving
the original 112 cases and their relative order. Five public entry points each
passed root, same-origin and dynamic cross-process hidden-input workflows; one
additional JS root-directory workflow used the public background-window path.
Independent audits checked 16 unique file POST bodies (17909 bytes), 50 file
instances (563 bytes), the original node's 16 native writes and clears, zero
pointer commands or chooser events, and exact task-page/target cleanup. Two
additional directory metadata witnesses prove trusted upload completion and
synthetic clear before their API replies; they are not file-upload submissions.

The 223212 ms focus ledger contained the original 11 allowed activations and
four deliberate control-popup focus events, plus the new directory window's
exact sole-tab activation. User sentinel identity and selection remained stable;
viewport height changed from 1222 to 1165. The run uses a disclosed loopback
native-messaging adapter and bounded native observers; it is not evidence of
uninstrumented timing, installed-profile recovery, every directory/frame
combination or a current Codex comparison.

Final Node tests passed 1642/1642; JS SDK 134 and Python SDK 99 passed. Go package
tests passed, with 26 existing platform-specific skips. The active
[parity plan](../exec-plans/active/2026-10-10-browser-use-parity.md) retains earlier
failed candidates and the remaining P01–P15 requirements.

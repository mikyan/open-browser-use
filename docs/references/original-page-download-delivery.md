# Original page downloads: verified transport, pending product integration

The extension's public `downloadPath` still rejects Page GUIDs with
`OBU_DOWNLOAD_PATH_UNAVAILABLE`. This reference records a feasible native
transport, not a new release capability. `expectDownload().result()` returns
after the matching original begin event is admitted; completion and readable
file delivery are separate requirements.

## Current Codex comparison

On 2026-10-12, the same local fixture was exercised once per case through the
current documented Codex browser tools. The download wait was called before a
single semantic button click; its returned handle's `path()` supplied the only
filesystem location subsequently read.

| Backend / root case | Tool outcome | Original bytes |
| --- | --- | --- |
| In-app browser, one-use POST | Path returned | 152 bytes, full bytes/nonce/SHA256 match |
| In-app browser, immediately revoked Blob | Path returned | 152 bytes, full bytes/nonce/SHA256 match |
| Edge extension, one-use POST | Path returned | 153 bytes, full bytes/nonce/SHA256 match |
| Edge extension, immediately revoked Blob | Download wait timed out after 10000 ms | No path returned; file outcome unproven |

All four DOM witnesses recorded exactly one trusted click in the original
document. Both Blob URLs were synchronously revoked after the anchor click.
The fixture recorded four page GETs, two unique POSTs, and no replacement GET.
POST HTML exposed its token and expected hash but not the original payload.
The timeout was retained without another click or request. It does not prove
that Edge failed to save a file or that Codex generally cannot deliver Blobs.

This comparison covers root pages only. It provides no concurrent-owner,
native-GUID, OOPIF, or focus-isolation evidence for Codex. The official
[browser documentation](https://learn.chatgpt.com/docs/browser) describes download
location preferences; it does not establish GUID ownership or these specific
POST/Blob results. Those results come from the actual tool calls and local
byte checks. Persisted tool output is a transcription of the CUA result, with
independently captured HTTP and file-byte witnesses.

## Native Browser connection proof

The opt-in integration runner opens a real Browser root WebSocket in its own
fresh temporary profile. Before configuration it checks the exact
`DevToolsActivePort` port/path, browser endpoint, extension worker target and
extension ID. Task target IDs and actual cross-process child attachments are
then checked in that same Browser connection. This is not the CRX transport;
normal extension debugger access alone still lacks the Browser domain.

Two separate headed Windows Chromium runs completed:

| Download behavior | Run | Cases | Files | Original bytes |
| --- | --- | --- | --- | --- |
| `default`, events enabled | `uK4EVu` | 2/2, actual exit 0 | 18 | 3120 |
| `allowAndName`, private download directory | `0CgnzY` | 2/2, actual exit 0 | 18 | 3210 |

Each run includes the mandatory raw-navigation control and one proof comprising
three independent owners × three layouts × two download kinds. The layouts are
root, OOPIF and dynamically added OOPIF; arm precedes dynamic frame creation.
Each group triggers three downloads concurrently. All POSTs use `/report`, all
suggested filenames are `report.bin`, and response bytes/nonces remain distinct.
The third owner is another task, not an unowned user download.

For every file, the proof joins the SDK's admitted download ID to one original
Page begin and one Browser begin with exactly the same GUID and frame ID. It
also checks the original tab, renderer attachment, session, turn and epoch.
Only the completed Browser event's `filePath` is opened, using one file handle;
complete bytes and SHA256 are compared with the original response/Blob, and
the downloaded file's first JSON line is parsed to verify its nonce and owner.
Directory enumeration, URL/name/time matching and synthetic CRX paths never
select a file. In `allowAndName`, the basename is checked against the GUID only
after the event path has been received.

Each run records nine one-use POSTs, zero replacement GETs and nine Blob
downloads without a file network request. Notifications for all 18 GUIDs are
validated against their owning connection, including a final complete pass.
Other owners' public path requests are rejected. The public owner's path still
returns `OBU_DOWNLOAD_PATH_UNAVAILABLE`; harness access does not change it.

Raw Browser commands, acknowledgements and events retain their original bytes,
hashes, order and times. Both runs confirm the actual configuration ACK, reset
to `default` with events disabled, and socket close. Eighteen waiters and three
owners are cleaned up; primary operation errors and cleanup errors remain
separate. Continuous focus coverage is 7817 and 7494 ms respectively, with zero
activation/focus events and no added allowances. Startup and teardown are
outside that coverage. These are download-specific runs, not a rerun of the
entire 125-case product suite.

The fixture and observer have 24 passing Node tests without skips/cancellations.
The host binary matches the previous build's 50 production inputs. Production
extension, SDK and host sources are unchanged, as are the published preview
archives. Raw local evidence is retained under the two integration run IDs and
the original-download baseline directory; independent audits check the raw
frames, file bytes, request counts, ownership, focus and cleanup.

## Product work still required

The [Browser protocol](https://chromedevtools.github.io/devtools-protocol/tot/Browser/)
allows a completed event to omit `filePath`, and does not guarantee that the
file still exists. The proof rejects missing paths and never infers one.
`Browser.setDownloadBehavior` changes context state even with `default`; the
proof's configuration is confined to its own isolated profile. It does not
authorize changing a user's existing browser configuration.

The next implementation must bind a native Browser connection to the actual
extension instance and admit file access only after the extension has validated
the original Page GUID and control scope. Global Browser events must not become
a global agent file-discovery API. Disconnect, replacement, revoked scope,
unknown acknowledgement, cancellation, missing files and dangerous/failed
downloads need product-level handling across SDK, CLI and MCP.

An ordinary extension installation without a verified Browser root transport
must continue reporting that the capability is unavailable. An explicitly
authorized current-browser connection and a host-created profile have different
installation, login and permission properties; a successful isolated transport
does not complete existing-profile support or the full Browser Use parity goal.

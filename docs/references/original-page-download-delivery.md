# Original page downloads through a verified Browser connection

The development branch can deliver an original Page download through an
explicitly bound Browser root connection. Ordinary extension-only installs and
the published preview still reject Page GUID paths with
`OBU_DOWNLOAD_PATH_UNAVAILABLE`. `expectDownload().result()` returns
after the matching original begin event is admitted; completion and readable
file delivery are separate requirements.

## Explicit binding and original ownership

The caller must select the exact native host endpoint and an authorized
loopback Browser connection. Explicit URL mode does not discover an endpoint:

```text
open-browser-use bind-browser --socket <exact-host-endpoint> --cdp-url <authorized-browser-websocket> --exclusive
```

The optional [current-session discovery mode](current-session-connection.md)
reads a selected Chrome/Edge root's `DevToolsActivePort`. It does not launch a
browser, enable debugging, approve its prompt or substitute for identity checks.

`--exclusive` acknowledges exclusive control over that context's CDP download
behavior. The host sets `default` with events enabled; it does not edit browser
preferences. CDP offers no read-back of another controller's previous override,
so do not bind a context whose download behavior another controller manages.
Only literal loopback IP endpoints with `/devtools/browser/<id>` are accepted;
DNS, proxy discovery, redirects and page endpoints are rejected.

The actual Native Port receives a random challenge. The extension publishes
nonce, extension ID, installation instance ID, worker boot ID and port ID in
its worker. The host verifies that exact identity over the supplied Browser
connection before enabling events. `getInfo.metadata.pageDownloads.available`
becomes true only after the native configuration acknowledgement. The committed
connection belongs to the host, so the binding CLI can exit. A new connection
requires a new explicit binding; old records never migrate to it.

Arm captures this port/generation and the original root target. Only an admitted
Page begin can claim its GUID/frame plus original session/turn/epoch/tab and
unique claim ID. The host joins that exact GUID to its Browser begin and completed
event, never by URL, filename, numeric download ID or directory changes. Path
delivery requires the event's absolute `filePath` to name a readable regular file,
then checks the original scope again. The returned path is not an immutable file
snapshot: another application may still move or change it after validation.

`Download.cancel()` sends `Browser.cancelDownload` for that same confirmed claim
and requires its real ACK. Canceling a wait, closing a tab or releasing a claim
only revokes observation/access; it does not cancel the transfer. Missing paths,
missing files and canceled downloads return errors. Browser disconnect, unknown
command ACK or a submitted command whose outcome is uncertain terminates that
binding, without replay. Normal Close acknowledges default/events-disabled before
closing; an enable ACK lost with the connection cannot promise a reset ACK.

Host state holds at most 128 event records, with a one-minute unclaimed evidence
TTL; it never evicts an active claim to make a new one. A separate, non-evicting
ledger retains up to 4096 revoked GUIDs for the whole connection generation.
Exhaustion terminates the binding; event churn and TTL cannot revive an old claim.
A mismatched scope cannot revoke an active claim. The private bridge allows
32 concurrent operations and 4096 request IDs per binding. The extension bounds
pending operations to 128 and challenges to 4096 per port. These limits fail
explicitly; they do not broaden ownership or replay work.

## Product integration evidence

Final five-entry run `Fb9uuB` passed 2/2 with actual exit 0. JS, CLI, MCP,
Python and Go each delivered six original files across root/OOPIF/dynamic OOPIF
and POST/Blob: 30 distinct files, 5200 bytes. Each of the six groups records all
five arm acknowledgements before release and every trigger after release.
Callers obtain and read their own public path; parent-side JS independently
checks the original bytes, SHA256, nonce, Page GUID/source and owner notifications.
The fixture records 15 one-use POSTs, 15 immediately revoked Blobs and no
replacement GET. The 14000 ms continuous focus interval contains no activation
or focus events and uses no allowances.

Readiness is bounded by the original waiter deadline. Each subsequent click
uses the remaining monotonic budget, including after dynamic frame creation.
Typed-process or MCP exit while waiting rejects the shared barrier; cleanup
waits for actual child close and does not start a replacement process. Review
also caught Python's copied-helper path resolution and fixed it before this
run. Focused harness tests pass Node 673/673, Python 8/8 and Go 15/15 including
subtests, without skips. These unit/process checks are separate from browser
acceptance. The earlier `2O6wkV` proves positive delivery only, because its five
waiters were not simultaneously ready; `EKpLO0` passed after the barrier fix but
precedes the final CLI/MCP action-budget correction. Both records are retained.

Foreign GUID path/cancel rejection and the two held-transfer lifecycle cases
still run through the parent JS clients; they are not negative tests through
all five external interfaces. Native Port transport uses the existing isolated
loopback adapter. These results do not prove unowned user-download handling,
real Browser-root disconnection during delivery or ordinary profile setup.

The final production host source also passed the ordinary unbound full suite
`U32iKd`: 125/125, actual exit 0, with unchanged case names/order. Its 238890 ms
focus interval contains only the existing 12 activation and four control-popup
focus allowances. This is a separate full-suite run, not a claim that every
case ran with Browser downloads bound. The v3 build records 58 Go/module inputs
and ten binaries. Production extension/host/SDK sources remain at `6300413`;
the new binary includes different VCS build metadata from pre-commit `M8DwSY`,
so it is not described as byte-identical to that earlier host. Published preview
ZIPs remain unchanged.

Final repaired Windows Chromium run `M8DwSY` passed 2/2 with actual exit 0.
Its freshly built host includes the non-evicting revocation ledger and both
wall-clock deadline fixes. The complete build manifest covers 57 production
inputs and nine binaries. The same 18 original-file checks and two held-download
lifecycle cases below passed through the production binding. This focused run
does not substitute for other browsers, unowned downloads or five-entry coverage.
Its 8274 ms focus interval has zero activation/focus events and no allowances.
Independent audit checks all 18 byte sequences, original Page source/owner and
20 task-tab cleanup records against the final host and build manifest.

Independent review closed both findings: late successful native writes must
recheck the deadline, and queued claims must remain revoked after cache churn.
Real WebSocket unit tests also check that late pre-identity ACKs produce no
Browser configuration writes; a late enable ACK resets only the verified original
connection. Windows native-module tests pass 69/69 and Linux 70/70 without skips;
the full Windows Go suite passes 607 tests/subtests, with 26 platform skips.
Final Node tests pass 1837/1837 without skips or cancellations.

The unbound 125-case browser suite `bi7ASp` passed with actual exit 0 at the earlier
product checkpoint, before those final bound-connection fixes. Its continuous
focus interval is 224026 ms, with exactly the existing 12 activation and four
control-popup focus allowances. It is evidence for the ordinary extension path
at that checkpoint, not a full-suite run of the final repaired host.

Windows Chromium run `TYsHFS` completed 2/2 with actual exit 0: the original
download case and raw-navigation control. The real CLI bound the production Go
host and exited; the extension remained ready. No separate harness Browser
download observer enabled events or supplied file paths. The Native Port uses
the integration suite's loopback adapter, while host/extension request handling
is production code.

Eighteen public JS SDK paths yielded 3120 original bytes across three owners,
root/OOPIF/dynamic OOPIF, one-use POSTs and immediately revoked Blobs. All bytes,
SHA256 values, nonce analysis, original Page GUID/source and notifications matched.
Foreign GUID path/cancel calls and an exact missing-file check were rejected.
Two additional held HTTP downloads proved bounded pending-path timeout, actual
cancel with an incomplete server response, and tab-close revocation while the
original response subsequently finished. Neither case replayed its trigger.
Continuous focus coverage was 7650 ms, with zero activation/focus events and no
allowances; startup/teardown remain outside coverage.

The preceding `51yhd4` failed only because the lifecycle assertion did not accept
the existing `not part of browser session` rejection. Its 18 byte checks and
actual cancellation succeeded. That failure is retained; the assertion now
recognizes the real ownership error without accepting successful path delivery.

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

## Remaining product acceptance

The [Browser protocol](https://chromedevtools.github.io/devtools-protocol/tot/Browser/)
allows a completed event to omit `filePath`, and does not guarantee that the
file still exists. The proof rejects missing paths and never infers one.
`Browser.setDownloadBehavior` changes context state even with `default`; the
proof's configuration is confined to its own isolated profile. It does not
authorize changing a user's existing browser configuration.

Binding, original claims, path/cancel and invalidation now have production code
and focused five-entry positive acceptance above. An unowned user-download
comparison, real Browser connection loss during
delivery, dangerous/failed downloads and current-user-profile authorization still
need acceptance. Windows and Linux native WebSocket unit tests do not substitute
for those browser workflows or macOS/other browser coverage.

An ordinary extension installation without a verified Browser root transport
must continue reporting that the capability is unavailable. An explicitly
authorized current-browser connection and a host-created profile have different
installation, login and permission properties; a successful isolated transport
does not complete existing-profile support or the full Browser Use parity goal.

## Existing-profile installation research

The public [downloads API](https://developer.chrome.com/docs/extensions/reference/api/downloads)
exposes numeric download IDs and filenames, but no Page GUID or source-tab key.
The [extension debugger's allowed domains](https://developer.chrome.com/docs/extensions/reference/api/debugger#restricted-domains)
exclude Browser. Matching the next global download by URL, filename or time
would therefore weaken the existing ownership contract.

Chromium's [Page handler](https://github.com/chromium/chromium/blob/main/content/browser/devtools/protocol/page_handler.cc)
and [download history writer](https://github.com/chromium/chromium/blob/main/chrome/browser/download/download_history.cc)
do use the same DownloadItem GUID. This makes History an exact-key candidate,
but not an implemented live path source: the [database defaults](https://github.com/chromium/chromium/blob/main/sql/database.h)
use exclusive locking, [History writes](https://github.com/chromium/chromium/blob/main/components/history/core/browser/history_backend.cc)
can be asynchronous, and transient/off-the-record downloads
need not be persisted. The existing instance-ID profile scan also does not
authenticate a live Native Port's database. No live History fallback, database
copy, lock bypass or user-browser shutdown was added.

Chrome documents an [explicit current-session connection flow](https://developer.chrome.com/blog/chrome-devtools-mcp-debug-your-browser-session)
for Chrome 144+: enable remote debugging in the inspect page and approve the
connection prompt. This is a candidate for reusing an existing signed-in
profile, with additional authorization steps. Microsoft also documents an
[Edge current-instance opt-in](https://learn.microsoft.com/en-us/microsoft-edge/web-platform/devtools-mcp-server#auto-connect-to-a-running-edge-instance)
through `edge://inspect`, followed by auto-connect using that Edge user-data
directory's `DevToolsActivePort`. These are supported upstream connection flows,
not our product's runtime acceptance. Current-profile connection, permission,
download permissions and focus still need testing in each browser.

# Native messaging request transport

Chrome accepts at most **1 MiB per host → extension JSON message**; the reverse
direction accepts 64 MiB. The native-endian four-byte header contains the UTF-8
payload length, not a character count. See the [Chrome protocol documentation](https://developer.chrome.com/docs/extensions/develop/concepts/native-messaging#native-messaging-protocol).
Local SDK IPC accepts up to 64 MiB, which alone does not prove that a request can
cross the browser's native messaging port.

The relay and extension provide private, negotiated fragmentation for large
requests. Public SDK, CLI, MCP and browser method signatures are unchanged.
This is transport framing, not another browser action or an authentication
mechanism. Existing scope, epoch, ownership, user Pause and method checks still
apply to the reconstructed request.

Local development delivery includes the matching extension package and native
host executable; both must be updated to enable negotiated fragmentation. The
host binary at `dist/native-host/open-browser-use.exe` is the same tested Windows
executable, not an npm/GitHub release. Existing installed user profiles are not
updated by building or packaging the repository.

## Negotiation and compatibility

On each actual native port connection the extension sends:

```json
{"jsonrpc":"2.0","method":"obu.native.hello","params":{"version":1}}
```

The new relay consumes this notification only from the extension side and does
not broadcast it. Clients cannot submit any `obu.native.*` method. Older hosts
ignore the unknown notification; their original size limitation still applies.
An extension update alone cannot fix an older host's output framing.

The optional original-download binding uses another private notification,
`obu.native.pageDownloads`, consumed before the fragment receiver. Its v1
challenge/response/ready/request/reply envelopes use private request IDs and
nonce/generation fields, never an SDK pending ID. It is also rejected from local
SDK callers. The public local-only `host.bindBrowser` request stays in the relay
and does not enter the extension RPC namespace. See [original downloads](original-page-download-delivery.md).

Requests at or below 1 MiB after host ID rewriting keep ordinary framing. Larger
requests require the hello, a remapped request ID and at most 64 MiB of serialized
JSON. Without negotiation, or above this logical limit, the host replies with
`OBU_NATIVE_MESSAGE_TOO_LARGE` to that request and keeps the native connection.
Oversized notifications are rejected rather than transmitted. All physical
host output frames, including the private envelopes, enforce the 1 MiB limit.
JSON escaping and ID rewriting can increase the original IPC payload size.

## Assembly and dispatch

The host holds its output lock across one complete sequence of private
JSON-RPC notifications. Parameters are:

| Method | Parameters |
| --- | --- |
| `obu.native.start` | `id`, `totalBytes`, `totalChunks`, `timeoutMs`, `deadlineUnixMs` |
| `obu.native.chunk` | `id`, zero-based `index`, canonical base64 `data` |
| `obu.native.commit` | `id`, `remainingMs` |
| `obu.native.abort` | `id` |

Each chunk encodes at most 512 KiB of the serialized request's bytes. The final
chunk can be shorter. A port owns at most one assembler with at most 64 MiB of
payload storage; JSON decoding also needs temporary string/object memory. The
host admits at most 128 MiB of rewritten large-request payloads waiting for or
holding its output lock; excess requests receive `OBU_NATIVE_TRANSPORT_BACKPRESSURE`.
That quota excludes inbound IPC buffers and temporary JSON rewriting allocations,
so it is not a bound on the host's total memory use.
Sequence, byte count, chunk count, parameter shape, UTF-8, JSON object and
remapped ID must match. No browser action is dispatched at start or during
chunks. Only a valid, complete commit enters the normal JSON-RPC peer once.

Malformed or conflicting frames clear assembly and return bounded errors without
echoing payload data. Disconnect and close discard incomplete data. Each
callback checks its actual port identity, so late callbacks from an old port
cannot clear a replacement assembler or dispatch old work. RPC handlers also
retain the original port's reply closure: a late result or error cannot enter
a new native host's reused request-ID namespace. The relay removes pending IDs
atomically so an early receiver error and later transport timeout do not send
duplicate responses. The transport does
not retry requests or resume partial assemblies.

## Time and cancellation limits

For fragmented requests, the host starts its budget when it receives the full
local IPC frame. A valid explicit top-level `params.timeoutMs` supplies the
budget; absence uses a 10-second assembly budget. The host counts JSON rewriting,
output-lock waiting, encoding and writes, and never intentionally sends a commit
after that budget. The start frame carries the original absolute Unix deadline
on the same computer; delayed delivery cannot start a fresh budget. The receiver
also tracks elapsed monotonic time and uses the stricter remaining budget before
dispatch, including decoding time, then reduces a valid explicit action timeout.

This does not create a unified deadline for time already spent writing the
SDK → host frame. An absent action timeout retains that method's existing
default after assembly. A blocked native stdout write cannot be claimed to have
stopped merely because its deadline passed; the receiver still rejects an
expired partial transfer. Once a complete request was dispatched, ordinary
browser cancellation semantics apply. Closing a client socket is not an undo
operation, and callers must not blindly retry side effects after a timeout.

## Reconnecting the native host

Port loss immediately fences existing browser work and discards incomplete
native-message assembly. Reconnecting establishes a new transport only; it does
not resend requests or restore an old control epoch. A surviving worker releases
its original input attachments, and a caller explicitly begins a new turn before
continuing. Extension reload also changes the browser session incarnation, so
previous tab ownership must be explicitly claimed again.

The transport keeps one pending retry instead of scheduling another whenever a
disconnected heartbeat tries to send. A live worker attempts a connection after
a best-effort five-second timer; a repeating 30-second browser alarm supplies a
wakeup if that worker or timer disappears. These are scheduling intervals, not
guaranteed connection deadlines. Alarm writes are ordered so a delayed clear for
an old successful connection cannot erase a newer disconnect's fallback.

This matters for distributed extensions: Chrome clamps packed-extension alarms
to at least 30 seconds, while unpacked extensions are exempt. Creating the same
alarm again replaces its schedule, so the previous six-second alarm could be
postponed repeatedly by the 30-second heartbeat. See the official
[Chrome alarms API](https://developer.chrome.com/docs/extensions/reference/api/alarms#create).
The native launcher and Port lifetime are described in
[Chrome native messaging](https://developer.chrome.com/docs/extensions/develop/concepts/native-messaging).

## Verification

The regular browser harness enforces the actual 1 MiB host frame ceiling and
checks concurrent large Unicode/HTML requests, SHA-256, execution counts and
subsequent small requests. It still uses a test native-port adapter.

`scripts/browser-integration/native-message-checks.mjs` separately uses real
Windows browser registration and `connectNative`, isolated profiles and
temporary environment directories. It creates only a unique temporary host key
and removes that key after checking its original absence and current identity.
It compares two large requests' actual page results, verifies the same native
host/endpoint remains usable, records foreground events, and checks that a
host rejects large input when a legacy extension has not negotiated chunking,
without losing the connection. Run evidence
and scope are recorded separately from mock/unit tests.

Windows Edge real native run `native-u7vkkz` passed both modern and legacy cases.
Two modern page witnesses contain 2,097,173 and 2,097,174 UTF-8 bytes, exact
independent SHA-256 values and one execution each. Both cases retained the same
native host and endpoint through subsequent small calls; tab/window event ledgers
were empty, temporary registration keys were removed and test processes exited.
The full Windows Chromium 156 run `run-xMoFkk` passed 48/48 cases. Its two large
requests each contained 2,520,000 decoded bytes, used 22 chunks in total, and the
largest observed physical frame was 699,142 bytes. These are scoped evidence,
not proof of full browser/platform or Codex feature parity.

`scripts/browser-integration/native-lifecycle.mjs` adds actual Windows browser
launcher recovery. It terminates an identity-checked native host, then separately
reloads the extension in running and paused states. Reload requires the original
host process to exit with code zero, its pipe to become unreachable, and its
endpoint descriptors to disappear. A new endpoint never authorizes replay:
the original request fails, a late target remains untouched through the original
deadline plus 250 ms, and only an explicit new turn (plus claim after reload)
can perform new work. Pause remains in force until the retained real popup
resumes it. The runner records process identities, independent focus events,
page/server witnesses and source hashes; see its
[scope and invocation](../../scripts/browser-integration/README.md#real-windows-native-launcher-lifecycle).
These unpacked runs do not certify signed updates or packed-alarm wakeup timing.

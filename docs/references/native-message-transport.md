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

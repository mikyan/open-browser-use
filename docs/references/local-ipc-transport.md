# Local IPC transport

The CLI, native host, and SDKs use the same native-endian 4-byte length-prefixed
JSON-RPC frames on both transports:

- macOS/Linux: Unix domain sockets, with owner-only socket permissions.
- Windows: byte-mode named pipes named `\\.\pipe\open-browser-use-<uuid>`.
  The protected pipe ACL grants access only to the host process user's SID.
  Remote pipe clients are rejected. No TCP listener or authentication token is
  introduced.

The Windows host uses `github.com/Microsoft/go-winio` pinned to `v0.6.2` (Go 1.21
minimum), compatible with this repository's Go 1.25.10 toolchain. Node's
`net.createConnection(path)` can connect directly to these pipe paths. Python
clients need the SDK's Windows pipe transport; Windows Python's socket module
does not provide `AF_UNIX`.

## Discovery and compatibility

`active.json` retains its `socketPath`, `pid`, and `startedAt` fields. On Windows,
`socketPath` now contains the actual named pipe path; applications which read the
registry and pass its `socketPath` to the SDK keep the same calling convention.
The registry is written atomically.

Each named pipe also has an independent `<endpoint-hash>.endpoint.json` record in
the discovery directory, containing the same fields. The hash is the first 16
bytes of SHA-256 of the pipe path, encoded as lowercase hexadecimal. Record
readers reject malformed records, oversized records, nonlocal pipe paths,
symlinks, and filenames that do not match the recorded endpoint. Independent
records allow discovery to recover if `active.json` is absent or stale, and keep
multiple browser profiles discoverable.

Unix `.sock` discovery remains unchanged. Go CLI and Go SDK clients also accept
explicit legacy Windows AF_UNIX paths; the new Windows default is a named pipe.
Restart an older native host before using a Windows JS/Python SDK, because a
Windows AF_UNIX endpoint cannot be used by those standard runtime transports.

Discovery deletes endpoints only after a definite missing/refused connection.
Permission errors, busy pipes, and timeouts preserve the endpoint and active
registry. Profile selectors still verify the chosen endpoint using `getInfo`;
the transport does not alter tab ownership or browser selection.

## Verification

- `go test ./internal/transport ./internal/host ./packages/open-browser-use-go ./cmd/open-browser-use`
  covers frames over real local IPC, read deadlines, Windows pipe ACLs,
  independent records, multi-instance routing, registry recovery, and
  preservation after temporary connection failures.
- `go run ./scripts/windows-host-smoke <path-to-open-browser-use.exe>` uses a
  fresh isolated discovery directory. It never removes the user's active host
  directory or requires browser profile access.
- With `OBU_TEST_HOST_BINARY` set to a built host, the JS and Python test suites
  also exercise their actual local transport through the Go relay, including
  response routing after reconnects.
- The optional [browser integration acceptance harness](../../scripts/browser-integration/README.md)
  connects the real host and SDK transports to a production extension build in
  an isolated Chromium profile. It separately records native-port adapter
  boundaries, source hashes, page results, and active-tab invariants.

The native messaging wire format is unchanged. Installing/reloading the browser
extension, native messaging registry setup, and browser profile discovery are
separate from this transport layer.

## Notification routing

CDP and download notifications carry a top-level `params.session_id` along with
their turn, epoch, and tab metadata. The host forwards scoped notifications only
to sockets that have explicitly sent a valid JSON-RPC request for that session.
One socket may request multiple sessions, supporting low-level manual metadata.
This is **routing isolation, not authentication**: session IDs are caller-chosen
labels, not credentials. Local endpoint permissions remain the access boundary.

Each socket can subscribe to at most 128 distinct session IDs, each no longer
than 1024 UTF-8 bytes. An overflowing request returns
`OBU_SESSION_SUBSCRIPTION_LIMIT` without reaching the extension. Invalid requests
and non-string or empty session IDs do not create subscriptions. Subscriptions
are discarded when the socket closes.

An extension worker restart does not clear subscriptions if the same host and
client socket survive. Epoch validity remains the extension's responsibility.
A native-host process restart creates a new endpoint and empty subscriptions:
read the current registry and create a new SDK connection. Fixed-endpoint SDK
clients do not silently switch to another endpoint or replay an operation.

Only the existing unscoped `heartbeat` notification is global. Unknown unscoped
notifications, unscoped CDP/download events from older extensions, and malformed
session metadata are dropped instead of broadcast. Reload the matching extension
to receive session-scoped events with the updated host.

## Slow-client isolation

Each client has one FIFO writer. The shared extension reader queues responses
and notifications without waiting for that client's pipe/socket to drain. This
also covers synchronous Python and Go clients that stop reading between requests.

The queue permits at most 1024 frames and `2 × (64 MiB + 4 bytes)` in total,
including the frame currently being written and each frame's length header.
The existing 64 MiB payload limit is unchanged: a maximum-size response can fit
behind another maximum-size frame. Queued payloads are immutable and shared
without copying each broadcast payload for every recipient.

Each frame write has a 10 second deadline. Exceeding either queue limit closes
that client with an `OBU_CLIENT_BACKPRESSURE` host log entry; a write failure or
deadline also closes the connection. The host discards that client's pending
requests and queued frames, and interrupts its in-flight write. Other clients'
requests and writers continue independently. A failed response is never replaced
with a success or silently replayed: the caller observes a disconnected/failed
connection and must establish a new connection before submitting new work.
An already delivered browser operation may still have executed.

Host shutdown closes every client and waits for the writer goroutines to exit.
`go test ./internal/host` covers queue and deadline cleanup, full-size frames,
and two actual local connections where an idle reader cannot block another
session's response. Tests use smaller injected queue limits rather than waiting
for the production memory or time limits.

## Primary references

- [Node IPC support](https://nodejs.org/api/net.html#ipc-support)
- [go-winio v0.6.2 pipe implementation](https://github.com/microsoft/go-winio/blob/v0.6.2/pipe.go)
- [go-winio v0.6.2 module requirements](https://github.com/microsoft/go-winio/blob/v0.6.2/go.mod)

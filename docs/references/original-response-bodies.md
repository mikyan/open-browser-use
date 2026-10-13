# Original response bodies

`getInfo.metadata.responseBodyVersion: 1` and the returned engine capability
`responseBody: 1` advertise reading the body of an already observed response.
The operation does not send another HTTP request. It preserves original POST
responses, including binary and empty bodies, and responses with error statuses.

## Public interfaces

Take both identifiers from a `response` entry and its enclosing diagnostics
capture. They are opaque: do not construct them from counters or native CDP IDs.
Diagnostics use a separate namespace from network-wait results; those results
cannot be passed as body references.

```js
const capture = await tab.diagnostics();
const response = capture.entries.find(entry => entry.kind === "response");
const body = await tab.responseBody({
  captureId: capture.captureId, requestId: response.requestId
}, { maxBytes: 1024 * 1024, timeoutMs: 10000 });
const bytes = Buffer.from(body.data, "base64");
```

Select the intended response by its URL, method and other observed metadata;
the first response above is only a minimal example. An application can capture
diagnostics before its explicit trigger and select the new response afterward.

- Python: `tab.response_body(capture_id=..., request_id=..., max_bytes=...,
  timeout_ms=...)`.
- Go: `tab.ResponseBody(obu.ResponseBodyRef{CaptureID: ..., RequestID: ...},
  obu.ResponseBodyOptions{MaxBytes: ..., Timeout: 10 * time.Second})`.
- CLI: `obu response-body --tab-id ... --capture-id ... --request-id ...
  --turn-id ... --control-epoch ... --max-bytes 1048576 --timeout-ms 10000`.
  Supply the original session with `--session-id`; standalone CLI requires the
  original turn. The plan command uses its existing control scope.
- MCP: `response_body` with `tab_id`, `capture_id`, `request_id`, optional
  `max_bytes` and `timeout_ms`, under the server's existing scope.

The raw action is `browserAction`, `action: "responseBody"`, no locator, and
`args: {captureId, requestId, maxBytes?}`. SDK facades return
`{captureId, requestId, encoding: "base64", data, byteLength}`. CLI/MCP retain
the RPC result envelope containing `value` and engine metadata. Facades validate
the capability, reference identity, canonical base64 and exact decoded length.

## Lifetime and concurrency

The existing Page and capture must belong to the caller's original control
scope. Reading a stale reference never attaches a new Page. Diagnostics keep
bounded metadata and original Response objects, not cached body copies. An
evicted record, detached capture, ended turn, Pause or replaced native session
revokes the read. In unrestricted mode, normal navigation alone does not clear
diagnostics history; Chromium may nevertheless discard the old native body
buffer. Restricted captures additionally require the original request document
and policy to remain valid. A same-URL replacement cannot inherit an old body
reference, and collecting diagnostics removes invalid retained entries.

Reading waits for the original response to finish. It waits for earlier page
work without extending the action queue, so another explicit action can release
a response that is waiting on the page. Asynchronous authorization is awaited;
capture, deadline and original native identity are checked again immediately
before sending and before returning the body.

This is an engine concurrency guarantee. Synchronous callers and serialized
CLI/MCP connections may need a separate connection in the same original scope
to perform the explicit releasing action while a body read waits. The real
gated-response test uses concurrent JS requests; the five-entry matrix changes
the body reader, with JS owning the trigger and cleanup.

Each explicit read issues at most one `Network.getResponseBody` against the
original request's final native session, including OOPIF session migration.
The pinned upstream `Response.body()` fallback to `Network.loadNetworkResource`
is deliberately bypassed. There is no automatic request retry, URL refetch or
body cache. A repeated explicit read may issue another original native command.
Actual redirect hops fail; nonredirect 300/304 responses use Chromium's original
body result. Failed transfers cannot be mistaken for successful empty responses.

The engine admits up to eight outstanding reads, at most two per tab. A timed
out caller does not release reservations for still pending authorization,
preparation or native work. Global cleanup waits for actual settlement. Such
reservations do not independently grant authority to detach a tab.

## Limits and errors

The default limit is 1 MiB, maximum 8 MiB, measured in returned decoded bytes.
Empty bodies are valid. Chrome supplies a decoded representation, which can
differ from compressed bytes on the wire. This limit does not bound Chrome's
native allocation: the native API returns the whole body atomically.

`OBU_RESPONSE_BODY_INVALID`, `EXPIRED`, `TIMEOUT`, `TOO_LARGE`, `UNAVAILABLE`,
`FAILED` and `CAPACITY` distinguish invalid input, lost identity, deadline,
size, discarded native content, transfer/validation failure and outstanding
work. SDK capability negotiation can return `OBU_RESPONSE_BODY_UNSUPPORTED`.
Website-restricted mode uses the same API and body limits. The original native
request, document, ancestors, loader, redirect chain and policy identity must
remain authorized before dispatch and after the actual read. Complete active
document-tree checks still apply. Unknown provenance or a retired document can
reject the read even when the current page URL is allowed. No response URL is
retrieved again to repair that rejection.

No interception, response modification or streaming/SSE body API is implied.
Ordinary installed Edge acceptance and overall Browser Use parity remain open.

## Verification

Restricted-website run `gapwcs` passes 8/8, actual exit 0. Five public entries
cover fifteen layouts; nine additional cases cover redirects, failed transfers,
same-URL replacement, denied sources/children and policy revocation. The original
ledgers retain 22 POSTs/17,316 bytes and seventeen native body reads: sixteen
return the original bytes, while one actual native ACK is held until its caller
times out. Pause stays incomplete until that same operation settles. Independent
review verifies original event/context/document identity, bounded exclusions,
policy restoration and exact cleanup. The 24,354ms focus ledger has zero tab
activation and only the two existing settings-popup focus allowances. Node
tests pass 3363 with one existing Windows symlink-privilege skip. Unproven worker
and Log provenance stays excluded; this does not complete ordinary Edge or the
broader capability comparison.

Complete restricted-diagnostics regression `Q6zSPw` passes 169/169, actual exit
0, preserving the prior 163 names and relative order. The same original business
and response bytes, no-refetch checks, source/runtime/build identities and exact
cleanup pass independent review. Its 502,193ms focus ledger uses only the existing
twelve activation/four control-focus allowances. The deliberate host restart is
accounted for separately; the final host exits normally and no run process remains.

Final isolated Chromium run `dx9EXR` passes 7/7 with actual exit 0. Fifteen
layouts perform 60 public body reads, matching 3,579 original response bytes,
including 15 empty bodies. Five lifecycle cases add response gating, repeated
explicit reads, same-URL identity, redirect/failed transfer, stale references
and delayed native ACK/Pause. All 68 native body commands retain original
request/session identities; task-tab probes observe no
`Network.loadNetworkResource` or `Fetch.enable` and HTTP ledgers observe no refetch.

The 33,147ms continuous focus ledger contains no tab activation, window focus
or allowances. All original task tabs/targets and probes are cleaned up; 37
caller processes and the native host have actual successful terminal records.
The standard runner does not separately retain a browser graceful-exit ACK;
exact-run process absence is checked independently. The first fixture failures
and their corrections are preserved in the
[history](../histories/2026-10/20261014-0059-original-response-bodies.md).

Full regression `tRDnRM` passes 144/144, actual exit 0, preserving all previous
138 case names and their relative order. Production extension hashes match the
focused run and the source/runtime inputs remain unchanged throughout. Its
419,725ms focus ledger uses only the existing 12 activation/four control-window
allowances. The original host is deliberately terminated by the restart case;
its successor exits successfully. This is isolated adapter acceptance, not
ordinary installed Edge acceptance.

# Read original captured response bodies

## Goal and baseline

Advance P11/P01 by exposing original browser response bodies through diagnostics
identities and the formal JS, Python, Go, CLI and MCP entry points. The preceding
goal turn made progress: committed diagnostics and two bounded real-browser
experiments, without claiming the unresolved initial-key failure was fixed.
Current clean baseline is `a3f47fe`.

Diagnostics currently expose metadata only. Pinned Playwright CRX's public
Response.body can fall back from an empty getResponseBody result to a fresh
credentialed Network.loadNetworkResource request. That path cannot implement
reading an original POST response. Preserve a deterministic baseline failure
and bypass the fallback through the pinned original Response/Request objects.

## Contract

- `browserAction` action `responseBody`, no locator, arguments
  `{captureId, requestId, maxBytes?}`. IDs refer only to the current diagnostics
  capture's retained response entry, never a network-wait request number.
- Return `{captureId, requestId, encoding:"base64", data, byteLength}`. Default
  decoded output limit is 1 MiB, maximum 8 MiB; empty bodies are valid. This is
  Chrome's returned body representation, not necessarily compressed wire bytes
  and not a cap on Chrome's native allocation.
- Await the original response's terminal event outside the per-tab action
  queue, so an explicit later page action can finish a gated response. Bind the
  original entry after preceding page work without extending its queue; never attach a new Page for a
  stale body reference. Scope, capture and native identity are checked before
  native send and return. OOPIF terminal session migration must be respected.
- Each explicit read issues at most one original Network.getResponseBody. No
  fetch/loadNetworkResource fallback, hidden replay or body cache. Old redirect
  hops, failed transfers, evicted records/native buffers and replaced sessions
  fail explicitly. Normal navigation does not erase existing diagnostic history.
- Entry eviction/disposal, end/Pause/detach and the original deadline revoke
  pending delivery. Actual native work remains counted until it settles even
  if its caller has stopped waiting. Bound outstanding reservations to eight
  per engine and two per tab, including queued preparation and late native work.
- Website-restricted mode rejects this cross-origin data channel. Advertise
  responseBodyVersion 1 and engine capability responseBody 1; preserve existing
  network-wait and browser-action protocol versions.

## Ownership and verification

Root owns engine/backend/build wiring and tests, runner integration and docs.
Backend agent owns diagnostics references, decoding/deadline helper and pinned
native bridge with tests. SDK agent owns three facades and CLI/MCP entry points.
Fixture agent owns an isolated original-response HTTP fixture and callers.
Only root launches browsers; all tests use isolated profiles and preserve the
existing focus policy. No PR or replacement of delivered preview packages.

Unit/pinned-runtime checks must show the old fallback, original ID/session
selection, redirects/failures/empty and binary data, strict encoding/limits,
record eviction, queue concurrency, scope revocation and late native settlement.
Real acceptance covers five formal body-reading entry points in root, OOPIF and
dynamic OOPIF, exact original HTTP bytes, no extra fetch, header/body gating,
redirect identity, limits, failed transport and cancellation. Native calls and
server requests provide independent evidence. If a production change justifies
a complete regression, enable the previous initial-key input trace in that run.

## Progress

- [x] Revalidate baseline and identify the native fallback and response identities.
- [x] Implement and review native capture, queue-independent reads and lifecycle.
- [x] Expose and validate formal SDK/CLI/MCP interfaces.
- [x] Run focused real-browser acceptance and affected regression checks.
- [x] Synchronize capability matrix, references and history for the user fork.

Overall Browser Use parity and ordinary Edge manual acceptance remain open.

Initial focused real run `CGYSPX` is retained with actual exit 1 and unchanged
source/runtime inputs. All five root body-reader cases passed; existing OOPIF
admission failed because the fixture assumed Chrome debugger target types were
the CDP types. The Pause edge retained the real pending ACK and failed cleanup,
but its expected error name was incorrect. Its recovery also exposed placement
before the runner's mandatory raw-navigation case. These are fixture corrections:
preserve original child attachment/process evidence, the established Pause error
contract, and place the new cases immediately before the existing explicit
shared-navigation recovery. Do not weaken production behavior or add a retry.

Final `dx9EXR` 7/7 and full `tRDnRM` 144/144 both have actual exit 0 and
unchanged source/runtime inputs. The full run preserves all old 138 names and
order. Independent focused body and full keyboard audits pass. Focus is zero
events/allowances for the focused 33,147ms; full 419,725ms retains only existing
12 activation/four control-window allowances. This response-body slice is
complete; initial-key diagnosis, ordinary installation and overall parity stay open.

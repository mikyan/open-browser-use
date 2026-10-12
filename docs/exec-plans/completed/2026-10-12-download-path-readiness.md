# Prepare original-file delivery before a download trigger

## Goal and current evidence

Advance P10/P13/P15 of the full Browser Use parity goal: an Agent exporting a
one-time POST response or revoked Blob must learn that original-file delivery
is unavailable before it clicks. The full objective remains unchanged and open.
The previous goal turn made progress: hover delivery was independently verified
(Node2552/2552, full browser128/128) and pushed as `937a7d6`. This turn rechecked
the clean worktree and current production sources before selecting this gap.

Current `armDownloadWait` captures an optional native context only when the
Browser binding is available. Missing binding still returns an observation-ready
acknowledgement; `path()` later rejects after the one-time action has happened.
An earlier `getInfo` cannot guarantee the binding survives preparation. Existing
Codex original-file evidence and our bound five-entry path evidence establish
the required end-to-end behavior; observation-only waiting is still a legitimate
separate use of the existing API.

## Contract and constraints

- Add optional `requirePath: true` to original-page download preparation across
  JavaScript, Python, Go, CLI and MCP. Missing/false retains the existing observer.
- Negotiate `downloadWaitPathVersion: 1`; older peers must reject the required
  mode before a trigger rather than silently discarding the requirement.
- Bind readiness to the original Native Port client, Browser generation and root
  target, under the original total deadline. Missing/replaced/lost identity while
  preparing cannot return ready; later loss invalidates the required waiter.
- Ready proves preparation at that instant, not future download success or an
  atomic click/download transaction. Actual path comes from the original native
  GUID completion; no replacement GET, filename/directory inference, retry click
  or rebind of a stale handle.
- Preserve scope, site policy, cancellation, Page enable cleanup and multi-frame
  behavior. No automatic Browser opt-in, user-profile change, new focus allowance,
  OS mouse movement, Pi integration, PR or published preview replacement.

## Work division

Backend agent owns extension admission/registry/metadata and production tests.
SDK agent owns three SDKs plus CLI/MCP validation/compatibility tests. Root owns
integration fixtures, all browser launches, documentation, build provenance and
delivery. Independent reviewer checks design and final evidence read-only.

## Verification and delivery

- [x] Preserve production baseline failures for missing/changed native binding.
- [x] Implement protocol/SDK/backend checks with original-budget and lifecycle tests.
- [x] Verify real-browser required preparation fails without triggering a POST
  when unbound, disconnected after discovery, or disconnected during preparation.
- [x] Verify bound five-entry original POST/Blob files through root, existing and
  dynamic OOPIF pages; inspect original bytes, path, scope and native GUID.
- [x] Verify loss after ready rejects the old waiter without trigger replay;
  explicit rebind may prepare only a new waiter.
- [x] Run affected suites and the unchanged complete browser baseline, inspect
  cleanup/focus/source evidence, update agent guidance and contracts. Delivery
  targets only the authorized fork. Keep normal-start approval and broader platforms
  explicitly open until independently proven.

## Progress

Completed the required preparation contract across the extension, three SDKs
and CLI/MCP. Frozen-source Node suites pass 2605/2605; JS158/Python122 include
real-host runs, Go SDK111/CLI137 top-level tests pass with 24 existing CLI skips.
Go vet passes. Final manifests cover 355 sources, 124 Go/module inputs and ten
new host/helper binaries. Legacy wait rejects the new field rather than implying
readiness; typed false remains compatible with old peers.

Final `99xibC` passes 3/3, actual exit 0: four required readiness scenarios have
zero business triggers, original-host continuity, exact RPC responses and cleanup.
Old negative transfer cases and the unchanged exact-two-relay NetLog gate pass.
Final five-entry `2WEsDf` passes 2/2: thirty original files/5200 bytes, six all-ready
groups, original path/GUID/bytes/scope evidence. One original file is deliberately
removed by the missing-file rejection case. Specialized focus intervals of
4007ms and 13350ms have zero events or allowances.

Complete `9YXWxm` passes 128/128, actual exit 0, with every previous `Ghqqmo` name
in the same order. Its 303905ms focus coverage contains only the original twelve
task-window activation and four control-popup focus allowances. No new allowance
was added; final snapshot validation passes.

The first unit suite's restricted-port failure and browser `KMGg88` 2/3 exit 1
remain preserved. The former now directly reserves an existing safe private-port
listener; the latter mixed the new four relay records with the old two and now
assigns groups at creation, cleans all relays and checks final evidence equality.
No production timeout or acceptance gate was weakened.

The successful native ACK publication gate and controlled real relay closure are
test interventions. They do not verify ordinary-start authorization, native
installation or wider platforms. Ready cannot guarantee a future independent
click or file completion. Published preview packages remain unchanged; the full
P01–P15 goal remains active. Next priority is ordinary-start Edge authorization
through real Native Messaging and an original export-to-analysis workflow.

# Native file choosers on allowed websites

The development extension supports its existing file chooser APIs in both
website allow-list and block-list modes. Direct locator uploads already have
their own origin and node checks; this adds the workflow where a page's upload
control opens the original native chooser. Public method names, typed SDK
helpers, readiness versions and file/clear semantics remain unchanged.

Use `tab.expectFileChooser()` before clicking the identified upload control,
then collect its result and pass the authorized browser-machine paths to
`setFileChooserFiles`. Each chooser permits one submission. Clearing requires
a newly opened chooser and an explicit empty file list. See
[file transfers](file-transfers.md) for SDK forms and directory restrictions.

## Source and lifetime

The wait fixes the current policy generation and revision. The original native
event fixes the attachment, debugger session, frame, backend node and document
identity before any asynchronous inspection. A frame-tree read uses that exact
native target and must still belong to the same document revision when it
returns. Allowed current URLs cannot substitute for a retired document.

The source and its native ancestors must be proven allowed, together with the
complete current document tree. A local blank/srcdoc frame can inherit a proven
ancestor; an opaque root without that evidence is refused. Unknown emitters,
denied children, detached sessions and same-URL document replacement cannot
produce an authorized chooser.

Readiness waits for actual interception acknowledgements. Collection waits for
actual interception cleanup and checks the original authority again. File
submission verifies the original node and document immediately before dispatch.
A successful native write may legitimately navigate through the page's change
handler; its completion still requires the original policy, owner, control scope
and an allowed current tree. No input is replayed or redirected to a new node.

Cancellation performs no new content read. It can clean up the original owned
wait after website revocation, but cannot disable a successor attachment's
interception. The original control epoch remains required.

## Actual upload cleanup

The shared file-input registry keeps actual native operations after a caller
times out. Pause, session end and detach join those original operations and
their cleanup instead of treating the timeout as completed browser work.
An unresolved write cannot authorize a new submission or a completed cleanup
report. The same drain also covers direct locator uploads.

Timeout and cancellation cannot undo bytes already assigned to an input or
submitted by the page. Verify the site's actual receipt before deciding to
upload again. Directory enumeration still has the browser visibility and
completion limits documented in [file transfers](file-transfers.md).

## Verification and comparison

Acceptance is tracked in the [execution plan](../exec-plans/completed/2026-10-14-restricted-file-chooser.md).
The retained old-source real run rejects the first allowed-page arm before any
business input. Its independent audit checks zero POSTs, original policy
restoration, source/build identity and exact cleanup. Deterministic old-source
tests also reproduce Pause reporting completion while a timed-out original
native file write is still pending.

The final isolated Chromium 156 focused run `btlfEb` passes 8/8, actual exit 0.
Five public entries cover three layouts, plus six lifecycle boundaries. Independent
review verifies 31 original POSTs (12779 bytes), fifteen original uploads and
fifteen explicit clears, and one extra original upload with delayed ACK delivery.
Original file hashes, native nodes/sessions, document identity, clear-object
resolution, policy restoration and exact cleanup all match. The 34925ms ledger
has zero activation and only the existing two deliberate settings-popup focus
permissions. A loopback native-messaging adapter and disclosed observers are
used; this does not prove ordinary installed-browser behavior.

The full `mAKsEd` run passes 175/175 with actual exit 0, preserving the previous
169 case names and order. Independent review again verifies all 31 original
chooser POSTs and bytes, source/runtime/build identity and exact cleanup. Its
529321ms observer coverage uses only the existing twelve activation and four
control-popup focus permissions. Current Node group totals are 3400 pass and
one existing Windows symlink-privilege skip. Existing preview ZIPs are unchanged.

The delayed case retains the actual successful native write and delays its
acknowledgement delivery. The original ten-second Pause cleanup deadline fails
while the ACK remains held and the policy is unchanged. The popup helper's UI
wait later times out; that UI timeout is not described as a backend reply.
After releasing the original ACK and observing actual operations reach zero,
one explicit Apply advances the policy once, followed by Resume and an explicit
new agent turn.

A current Codex IAB check uses the same synthetic chooser fixture through its
documented browser API. One root upload delivers the expected 27 bytes; an empty
`setFiles([])` call is explicitly rejected. An existing cross-origin frame's
chooser wait times out after its original click. These are single observed
outcomes, not claims about every Codex browser or retry success. A dynamic-frame
attempt is excluded because its wait expired between tool calls before the
upload click. There is no independent Codex native focus ledger, latency parity
claim or complete file-workflow comparison. Owned tabs and the local fixture
server are closed normally.

Restricted downloads, clipboard and other unproven data channels remain outside
this change. Ordinary Edge manual authorization and the complete Browser Use
parity goal remain open.

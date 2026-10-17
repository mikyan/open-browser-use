## [2026-10-16 03:50] | Task: Verify isolated headless native feasibility

### Execution context

- Agent: Codex, with separate implementation and audit contexts.
- Exact model ID is not exposed by the execution tools.
- Runtime: Windows, Node.js 24.14.1, pinned Chromium 156.0.8078.4.

### User request and intent

Continue improving browser capabilities and visible AI operations without
occupying the user's mouse. Investigate an explicitly separate managed session
without redefining ordinary-profile background behavior or creating a PR.

### Changes

- Add one independent developer runner using the production extension,
  real `connectNative`, current Go host and formal JS SDK. Keep profiles,
  temporary registration and cleanup scoped to that attempt.
- Reuse the existing browser startup policy and exact native process/EOF
  observers. Record complete read-only extension inventories and original
  source hashes; do not disable sandbox or alter product code.
- Document execution and evidence limits in the integration README.

### Validation and boundary

Preserve `jBbcen` (browser startup code 3) and `XUd0ts` (harness read before
descriptor publication), both with zero business actions and original runner
snapshots. Separate A/B/C core-startup diagnostics isolated the existing
testing-config policy as a relevant condition, without identifying a specific
failing experiment. No business action was replayed to replace either outcome.

`Z8Bgff` passed all five steps with actual outer exit 0 using the default
disabled testing-config policy and no `--no-sandbox`. Its connection step took
1,980 ms; this is an observed duration, not a global 20-second startup guarantee.
Worker discovery and status have separate waits. Original form/child POSTs were
112/192 bytes, and the 758×369 PNG was visually checked. Turn end rejected the
old child handle and detached the three task tabs. Browser and exact-handle
native EOF exits were both 0; all 17 observed owned processes exited, endpoint
records were empty and the unique registration was removed. Syntax and diff
checks passed; production code remained unchanged.

The separate stopped-state audit passed 122 evidence checks with actual exit 0,
including PNG decoding, native ancestry/retained-handle exit and exact process
identity cleanup. Relevant existing helper tests passed 23 checks; final docs
and repository hygiene checks passed. These checks do not repeat the historical
full production browser suite. The published dfb9e6b package remains unchanged.

This does not deliver a user managed-session launcher, prove OS foreground
behavior, resolve ordinary-profile popup focus, or test `finalizeTabs`. Internal
activation events remain diagnostic evidence. Live viewing, trusted user
controls and login/installation flows remain in the active session plan.

### Main files

- `scripts/browser-integration/managed-headless-check.mjs`
- `scripts/browser-integration/README.md`
- `docs/exec-plans/active/2026-10-16-managed-browser-session.md`

### 2026-10-17: Implement the experimental Windows launcher

The user requested a fresh usable package while the broader capability goal
remains active. Add `managed run/status/stop` and exact CLI/MCP `--managed`
selection, using a foreground supervisor and a separate persistent profile.
`internal/managedbrowser` owns the OS lock, private extension/host staging,
unique current-user registration, atomic Job membership and original native
process handles. Startup has one budget; cleanup preserves the lock until the
owned process tree actually exits. The ordinary extension configuration remains
`null`; the private staged copy carries only its versioned random native name.

The first production-entry attempt `managed-launcher-xgfAuQ` completed three
steps with actual runner exit 0. CLI/MCP selected the original endpoint, a
same-name collision created no extra run, and the SDK's original Control-click
opened the original child with exactly one 192-byte POST. The 758×369 PNG showed
the AI pointer and target feedback; turn end rejected the old handle. Original
Browser.close returned `{}`, browser/native exits were both 0, Job membership
reached zero, original processes exited, and native registration/endpoint cleanup
completed without forced termination. The result SHA-256 is
`8c398e632daa1db8d4e627a8b36ac80ddb6905ec85d89a1a94f1cac7a22ed790`.

Go tests across the module, 1,829 extension tests and 25 builder tests passed.
Stopped-state independent auditing passed 37 evidence checks with actual exit 0,
including 15 distinct original process identities, both registry views, endpoint
cleanup and decoded PNG pixels. The old-handle rejection is evidenced by the
runner assertion, not a separately retained raw error. Audit SHA-256:
`8271414aba4e013c7c82fc837e424ad854dd03150279e0a360a0f9897eebddbd`.
The requested `preview-20261017-dde4d40` package was rebuilt from the clean
`dde4d40ad7ad691897c9b88aec62a66b3a095df4` commit and published to the fork.
Offline CLI/MCP checks passed. Independent extraction verified 94 bundle files,
67 extension files and 6 Skill files; all four uploaded assets were downloaded
and matched local hashes before publication. Full ZIP SHA-256:
`ce924e01b94008e739787bfdbb346247e503fe545f058f6d500a29f5b9e73687`.
Package audit SHA-256:
`94780b91e0db64ab31af7a7511425f5c537c9c3b25227ecee63ad823b44fa750`.
An initial auditor parsing error requiring a semicolon in a Go const declaration
was corrected; its failure record was retained and the same archives passed.
No PR was created. This does not validate normal installed Edge, the company computer,
OS foreground behavior, native download files, profile login/restart or a full
task matrix. Viewer, trusted pause/resume and login handoff remain unfinished.

New reference documentation gives ordinary-install-first guidance and explicit
Windows run/status/stop, CLI and MCP examples. Architecture, security,
reliability, quality and release notes distinguish this experimental launcher
from the existing ordinary browser installation and from full parity.

### 2026-10-17: Rebuild the requested current preview

The user asked whether development had finished and requested another package.
The overall goal remains incomplete. Publish `preview-20261017-f2d3421` from
an isolated clean checkout of `f2d3421c0803b8309d34c2c580d3357be9f7c244`;
all 432 selected production Git objects match dde4d40. This is a fresh build
with the same runtime features, excluding the uncommitted viewer/control work.
The source comparison uses committed objects because checkout line endings
differ; the initial workspace-byte assertion and missing isolated builder
dependency were retained as preparation failures, then corrected before build.

Offline CLI checks and MCP initialization/listing passed with 30 tools. The
independent audit actually exited 0 and verified 94 bundle files, 67 extension
files and 6 Skill files, with no development viewer surface in the archives.
Its 5,652 mechanical checks are artifact checks, not new browser test cases.
All three ZIP files and SHA256SUMS were downloaded from the draft and matched
local hashes before publication to the fork. Full ZIP SHA-256:
`848c788a28430522249a62a46d0edf7b4db8925f0c8f44d5ce86ae7e105e6dc9`.
Audit SHA-256:
`a9ec8b304fcadf3aeb11d917f1bc66c02ce7c3abcd9a858b22e51e334764a534`.
No PR, browser installation, registry mutation or fresh webpage task was
performed for this delivery. Historical browser results remain historical;
viewer integration and ordinary Edge/company-computer acceptance remain open.

[Download the preview](https://github.com/mikyan/open-browser-use/releases/tag/preview-20261017-f2d3421).

### 2026-10-17: Add managed live viewing and trusted user controls

The user again requested a fresh package. Add `managed view`, a loopback HTTP/WS
viewer and an exact-worker user controller separate from task RPC. The viewer
shares the original native rendering stream, displays the existing AI feedback,
and exposes Pause/Resume/Stop. One-use tickets, bounded frame queues, lease and
worker/context identities constrain the connection. Resume uses revision checks
and requires fresh task handles; it never replays input or restarts viewing.
Stop waits for original cleanup and writes its reply before closing the server.
Oversized native frames revoke viewing and settle original ACK/stop without
cancelling an existing business screenshot. Delayed status observations cannot
overwrite completed control transitions.

The first real viewer attempt `managed-viewer-5xVYLn` passed all four stages with
actual runner exit 0. It retained 38 native PNGs, real DOM command/response IDs,
one original child document, two single fills, rejected old handles across Pause
and Resume, and one POST after explicit new-turn reacquisition. Original browser
and native exits were 0, Job membership reached zero, and original processes,
registration and endpoints were cleaned without forcing. Source/build inventories
did not change. Root visually inspected the streaming, paused and stopped viewer
screenshots, confirming the AI cursor, blue target outline and clear status UI.
Result SHA-256:
`4ced0acb55a4e2d21f4d834baa051f381d65270fb2345f0fc37d1f9dd752f585`.
Go module tests/vet, 1,873 extension tests, 25 builder tests and 20 UI/runner helper
tests passed. The real acceptance executable predates the final clean commit;
the requested release will rebuild separately and retain that distinction.

Stopped-state auditing actually exited 0 with 19 checks. It independently decoded
all 38 native frames and seven screenshots, verified the original 190-byte POST,
seven DOM command/reply pairs, old-handle errors, 15 managed and 10 viewer process
identities, and current registry/pipe/endpoint/HTTP cleanup. Audit SHA-256:
`81ba4fc00134c5064c324e300d957a9462d9fb0c6c676116709a4a9f9c1eb379`.
The first audit's three false assumptions were retained and corrected: render
generation can stay constant within a stream, the null config has comments, and
CIM creation timestamps have microsecond precision while original handle FILETIME
retains 100 ns precision. No original browser evidence or production code changed.

This is limited Windows/Chromium validation. Login handoff, ordinary Edge/company
installation, OS foreground observation, cross-platform managed sessions and
the full capability/task matrix remain open. No PR is requested or created.

The requested package is published on the fork as
[preview-20261017-41577de](https://github.com/mikyan/open-browser-use/releases/tag/preview-20261017-41577de),
from clean commit `41577de23774ecab7155a00567f8d19dc709583b`. The accepted source
snapshot's 33 Git objects match its parent runtime commit; the final commit only
corrects viewer toggle instructions. Offline CLI/MCP passed with 30 tools.
Independent artifact auditing passed 5,312 mechanical checks across 96 bundle,
69 extension and 6 Skill members; all four uploaded assets were downloaded and
matched original hashes before publication. Full ZIP is 10,184,779 bytes, SHA-256
`94353a396fb144082ec736f54335c6b30c5f409a47e9cae4f4492277f982d7a5`.
Package audit SHA-256:
`f801197c8c99ed393a31e8d16f4a3a4c5133df8fc6a5b21c3b050580525a72d5`.

An initial assembly failed before ZIP creation because the token scanner matched
concatenated Go HTTP standard-library literals. That failure is retained; a
fixed-candidate hash, exact binary context and verified Go source provenance
constrain the documented exception. Other credential and personal-path scans
remain active. The corrected build used a separate clean checkout, preserving
the failed directory. No install, PR or additional browser replay was performed.

### 2026-10-17: Explicit login preparation before managed tasks

The user asked again whether development was complete and requested a fresh
package. Full Browser Use parity remains open. Add Windows `managed setup` to
open a visible dedicated profile at about:blank for manual login, then require
normal closure before an explicit `managed run` with the same browser/name/root.
Both modes share the owned profile lock and original Job/process lifecycle.
Setup stages no task extension or native host, publishes no task endpoint/viewer,
rejects CLI/MCP task selection and discards browser output instead of logging
manual login details. Natural exit preserves actual browser/Job receipts without
fabricating Browser.close; explicit stop still waits for that original ACK.

Original synthetic acceptance `managed-setup-QyXNkx` passed five stages, actual
exit 0. A CDP test actor submitted one local login on the original visible setup
page; after browser exit, the public SDK used the same persistent HttpOnly cookie
and localStorage in a new run and submitted one authenticated receipt. A separate
profile received 401 and closed naturally, without replaying login. Both lock
directions, CLI/MCP/view refusal and absent task endpoints were checked. The
three original browser exits were 0, Job counts reached 0, and 9/13/10 original
process identities disappeared without force. Read-only native window observation
confirmed visible setup windows and no windows after exit. Root inspected both
post-login/receipt screenshots; no real account or system mouse was used.
Result SHA-256:
`daadcaeb558f43b3fc9ad0f55a7fc32696ff748060347b524c5fb155a13fad37`.

Same-production-source viewer regression `managed-viewer-cOCeeU` passed four
stages with actual exit 0, 38 native frames, one original 190-byte POST and actual
normal cleanup. The existing independent stopped-state auditor passed 19 checks,
including 45 decoded PNGs and all original process identities. Root visually
confirmed the live AI pointer/blue outline. Audit SHA-256:
`40f7aba5177ef0da6a53c5105a1991a64d53425644a1a8f33811cc0bc001a0cf`.
Go module tests/vet and 15 final integration-helper tests passed. Unchanged
extension-suite results remain historical rather than new runs.

Two zero-business failures remain failed. Viewer `ocDaKN` hit EBUSY while reading
the newly published private port file; its independent viewer required forced
cleanup and lacked a complete original process inventory. The helper now observes
that same process/file within its original startup budget, rejecting unrelated
errors and process death. Setup `XjPnhh` incorrectly rejected all extension targets;
the corrected assertion derives this project's exact public identities, records
other targets as unclassified and retains separate launch/endpoint/file checks.
Neither correction changed production behavior or replayed submitted business.

The new package will be rebuilt from a clean commit and checked separately from
the pre-commit acceptance EXE. Persistent synthetic state is the validated scope;
SSO/MFA, hardware keys, live same-document human takeover, ordinary company Edge,
OS foreground behavior, cross-platform managed sessions and full parity remain
open. Existing installation remains unchanged; no PR is requested or created.

The requested clean-source package is now published as
[preview-20261017-b3fd56a](https://github.com/mikyan/open-browser-use/releases/tag/preview-20261017-b3fd56a),
from `b3fd56a03928b08758b26aada9eec0c59766cb27`. The two acceptance snapshots'
69 Git objects match that commit. Setup's separate stopped-state review passed
10 checks with actual exit 0; report SHA-256:
`6a462d67bcb05e875723c61050ac84510fb9ccd7edc969b8845e874a3d44d6da`.
Sensitive POST bodies are represented by original server hashes/byte counts,
not retained raw bytes, so that review cannot independently recompute them.

The release EXE was rebuilt from a clean isolated checkout. Offline CLI/MCP
passed with 30 tools and explicit setup help checks. Independent ZIP auditing
passed 5,322 artifact checks across 96 bundle, 69 extension and 6 Skill files.
All four uploaded assets were downloaded and matched before publication. Full
ZIP: 10,194,974 bytes, SHA-256
`236c1d51abff1be473b8c1aa44250532fab1cee83d235d8ff5c30916c8d2c048`.
Artifact audit SHA-256:
`3c8cffebfe4be4b6721577c4deeca3e87761b19cab8d10bf181843445ab48b53`.
The local delivery's 100 files match the isolated source output. No browser
replay, installation or PR was performed during packaging; prior packages and
failed evidence remain intact. These results do not complete the active goal.

### 2026-10-17: Requested verified-source package refresh

The user again asked whether development had finished and requested a new package.
Full parity remains open. Human takeover was still uncommitted and lacked complete
cross-layer and real-browser acceptance, so all such work was preserved outside
the release. Build only committed source `2547e6e4622bdda5c820b58e7c50f3df9968f465`
in a fresh isolated clean checkout. Read-only comparison found 793 application,
SDK, dependency and build/test script Git objects identical to the previously
verified b3fd56a release; only three documentation files differed. This refresh
adds no runtime feature, and its notes explicitly distinguish retained historical
browser evidence from the new packaging checks.

The host and production extension were rebuilt, and offline CLI/help/MCP checks
passed with 30 tools. Independent ZIP auditing passed 5,324 mechanical assertions
across 96 bundle, 69 extension and 6 Skill members, including 451 selected source
inputs. These are artifact checks, not 5,324 browser tests. All four uploaded assets
were downloaded and matched before publication; the local delivery's 100 files
also matched the isolated output. Published on the fork as
[preview-20261017-2547e6e](https://github.com/mikyan/open-browser-use/releases/tag/preview-20261017-2547e6e).
Full ZIP is 10,194,880 bytes, SHA-256:
`145dc0bf1a8e67d4fd0830cc65b82cc04e3635e146ce1a816d6cc12e405d852b`.
Audit report SHA-256:
`0563cba1d0ddb0ec664178e9eab11b89a77d8b1758ec740f64417ee8c17dd689`.

The first preparation used an already occupied scratch name. The existing
prepare script refused the existing result, and the new bootstrap's exclusive
write also failed on the old script; both actual exit-1 outcomes were retained.
No prior package was overwritten. A new unique directory then completed the
preparation and delivery. No browser workflow, installation, registry update or
PR was performed for this refresh. Ordinary company Edge and the remaining
capability matrix are still unverified; the active development goal is not done.

### 2026-10-17: Same-document human control development

The development branch adds a separate typed human-control lease after the
original task has actually paused. It retains the original tab/document, tracks
native held input and rendering cleanup, and exposes no general CDP proxy in the
viewer. The shared Go protocol projects public lease/frame/receipt fields;
bounded input lanes wait for actual acknowledgements. End and disconnect revoke
queued input before joining cleanup. Resume remains explicit and requires a new
task control epoch. Worker termination alone cannot prove release in a live
renderer; the original owned browser exit is a separate terminal proof.

Three original browser attempts failed and remain preserved. EO2bNJ encountered
a Windows sharing violation while the original DevToolsActivePort was being
published, before any fixture request. Its forced browser exit and unverified
native endpoint cleanup remain failures. Startup now observes only this exact
temporary sharing error within the original deadline; it does not replace the
endpoint or restart the browser. wrP0ID completed nonbusiness Begin/frame/End and
Resume, then failed an incorrect harness assertion about ordinary Tab wrappers.
Those wrappers use the client's explicitly renewed turn; the corrected harness
instead sends the original captured session/turn/control-epoch fields. Neither
attempt submitted business input.

XLQ6VS created and filled the original unsubmitted Agent form, but human Begin
failed at its first frame, before accepted human input or POST. Normal final
Browser.close, browser/native/supervisor/viewer exit 0 and Job cleanup do not turn
that failed attempt into a pass. Separate zero-input geometry diagnostic cEDK4O
measured short-page client/frame 778×446 and long/RTL client 763×446 versus frame
778×446, all at scale/zoom 1. Native screenshots include scrollbars whereas CDP
client dimensions exclude them. The diagnostic completed actual normal cleanup;
it is not human-control acceptance.

The correction separates the first frame's full CSS surface from private client
geometry, leaves the public viewport null until that frame, and rejects geometry
changes before native input. The harness targets the visible intersection of an
element and the full surface without altering fixture layout or adding scrolls.
UI review also reproduced late old Begin errors and old input timeouts ending a
successor lease. Per-admission handling now retires all old callbacks; 37 UI tests
pass, including interleaved success/error/timeout cases and independent Stop.
The complete extension suite passed 1,959 tests, and the Go module/vet/build passed
with unchanged captured sources.

The next original attempt tQeuXy still failed with actual exit 1. Its long-page
Begin and human frame succeeded; pointer move and down received exact original
receipts, then up returned an unconfirmed operation. No POST occurred. The report
does not contain the underlying cause or prove whether that original native up
was sent. A cleanup release is not the missing up receipt. The original report
hash is `d79b00159c5e69141dec46a7873867e04191e574e7ee62b9d0864db1137bad9e`.
An exact allowlist of existing typed errors is now optionally projected as
`reasonCode`, without raw exception text, stack, input or credentials. Unknown
errors retain the generic response and original cleanup behavior. The harness
also records original client/scroll dimensions and bounded read-only state after
a failure; these additions cannot reconstruct missing historical observations.
Full same-document acceptance and the shared viewer regression remain pending.
The published 2547e6e package excludes all this development work.

The separate no-form U0ZXS7 diagnostic completed three pointer receipts and
normal End/stop. Extra layout and DOM reads between gestures affect timing;
this is not the original business acceptance. IDDtlj still failed at pointer up
with exit 1 and no reasonCode or POST. Its new original observations show client
height 369→354 and scroll width 743→829 while business rectangles stayed fixed.
The event-log text is a plausible overflow source, not a proven historical cause.
Only the synthetic log now wraps unbroken text; production geometry rejection
and input receipt requirements remain unchanged.

JYEQfy then confirmed 23 original human input receipts, including ASCII, Unicode,
Shift-held text and one trusted confirmation click. Its subsequent viewer wheel
produced no outgoing input; the UI remained active with sequence/acknowledged 23
and pending 0. The original page dimensions stayed fixed and no POST occurred.
Actual exit 1 remains a failure, before held-input disconnect, Resume or final
submission. Browser.close, browser/native exit 0 and Job cleanup were recorded,
but the supervisor exited 1 with viewer rendering cleanup unconfirmed. Those
browser-exit records do not replace the missing viewer cleanup acknowledgement.
The original report hash is
`7b004282bcdc780e4a6186129d9405544475da582504029ead65c42c2ac2a664`.
Wheel hit testing and the independent cleanup boundary remain under diagnosis;
the already published package is unchanged.

A bounded two-profile host diagnostic, 9Qk3Sm, completed actual exit 0 without
extensions, host, form or POST. With the same static image and coordinates, the
default CDP context emulated 1280×1000 while its native window remained 780×580:
wheel reached a DIV, not the image handler, and scrolled the viewing document.
An explicit viewport context had matching native dimensions; its one wheel
reached the image handler and was prevented without scrolling the viewer.
Both actual Browser.close receipts and process exits were confirmed. The runner
now uses an explicit viewer context and records/asserts native window dimensions;
production wheel handling is unchanged. This diagnostic does not prove the full
human workflow. Its result hash is
`177af01f46af7001eaa7a4a231309893eaa7f4cbd94ffd47844ab68754467c6e`.

The cleanup path separately returned a stale active-human snapshot after actual
bridge revoke. Go cached that response and HTTP correctly rejected it as proof
of releasing the current lease. Disconnect now builds its response from settled
resources and the actual final automation status. It cannot confirm a rejected
or unresolved native release; a close Promise alone is insufficient without the
original handle's released state. Cross-layer and real-browser verification are
still pending at this point.

After those corrections, the original `6U55vc` workflow completed all six stages
with actual exit 0. Thirty exact input receipts include pointer, key, committed
ASCII/Unicode and two wheel inputs. The original unsaved document survived human
control; closing its viewer socket with Shift and left mouse held produced actual
releases in that document. A new viewer confirmed the original lease cleanup,
explicit Resume and a new task turn rejected obsolete authority and completed
exactly one 299-byte POST from the same document. UI Stop and original browser,
native host, supervisor and independent viewer exits were all confirmed without
forced termination. Source and build inputs remained frozen. The report hash is
`6454f2397a11e4f332dbaaa4a2775573a4fbe9a151d8a8a56264d49725a2a749`.

The same frozen runtime passed the ordinary viewer regression `q5L0so`, four
stages with actual exit 0, twelve native frames, AI cursor/element feedback,
one original submission, Pause/new-turn Resume/Stop and normal cleanup. Its
report hash is `b22dac7bce5f818b896f9e8fada0c484feb515601f585aef893cd831c67350cf`.
Original human and viewer screenshots were inspected. Final validation includes
1,966 extension tests, 37 UI tests, ten runner/fixture tests and full Go tests/vet.
The new cross-layer fixture executes the real bridge and proves current-lease
cleanup acceptance plus five stale/unknown-receipt rejections. The initial UI
36/37 result from the old canonical golden was retained; generating the actual
new bridge output resolved it without altering UI behavior.

This completes only the fixed Windows Chromium synthetic same-document slice.
Real IME, SSO/MFA, navigation handoff, native dialogs, touch/zoom, ordinary company
Edge, other platforms and independent OS foreground behavior remain unverified.
The overall parity goal stays active; the published 2547e6e package is unchanged
and does not contain this human-control work.

Both stopped-state independent audits completed actual exit 0 without rerunning
either browser workflow. Human audit
`541b11728fed90e35271afc54e05382059f0902f1404b01a3d49b8c8d374b7bf`
confirmed frozen inputs, 30 input acknowledgements, exact document/lease cleanup,
original POST/response bytes, full decoding of 35 PNGs and original process
receipts. Viewer audit
`11f08984f80ab903c71369a6c84ad07edb8aa1ab03021e6d0285267d50c74ac6`
confirmed the separate four-stage workflow and all 19 PNGs. Current absence of
the original 29/26 process identities, registration, pipes and endpoints was
recorded only as additional evidence, not as a substitute for original cleanup.

## Requested Windows package including same-document human control

The user asked whether development had finished and requested another package.
The overall parity goal remains open. This delivery uses the verified runtime
from `9ac3a04`, updates the installation guide for its limited managed-viewer
human control, and rebuilds from a clean committed checkout. Navigation
continuation is design work only and is excluded. The original browser results
and six earlier failed attempts remain historical evidence; packaging does not
rerun or replace them. Publication will follow independent artifact and offline
CLI/MCP checks, with uploaded assets downloaded again for hash comparison.

Published [preview-20261017-93f54a1](https://github.com/mikyan/open-browser-use/releases/tag/preview-20261017-93f54a1)
from clean source `93f54a16473dceb3f8f6e19e5f21eab643861562`. The production
Git objects match 9ac3a04; 158 Go and 157 extension/builder test inputs match
their original passing evidence. A fresh Go 1.26.9 Windows amd64 CGO=0 trimpath
build and fresh 70-file extension build succeeded. Offline CLI/MCP exposes 30
tools; independent artifact audit passed 5,388 checks with 97/70/6 archive
members. Audit SHA-256:
`3be624ab5b0d1122b5e474c0f4ba8c55ce2c152452d8fc5ef33d2ebcf8f76eb8`.
All four uploaded assets were downloaded and matched their local hashes before
publication; the local delivery copy matched all 101 files. No browser business
workflow, installation or browser registry changes were performed in packaging.

Full ZIP: 10,258,927 bytes, SHA-256
`f6665725fcdec8121dbf45b362e75cd420295569f91bf44e31fdebfe8b95b8f4`.
Release executable SHA-256:
`183c83ec75975bdcbe4dc8fabeb3ae86634e59735532a76e9e920b6fee694f97`.
The package contains limited same-document control, not the proposed continuous
navigation design. The overall parity goal remains active.

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

## Continuous human navigation within the original lease

Continued the active Browser Use parity goal after the requested package was
delivered. One human lease now survives root redirects, child navigation and
same-document SPA routes on its original tab/target. Each generation owns its
input sequence, held-input tracker and rendering cleanup. Navigation retires
unsent inputs without replay; a submitted input retains its original receipt
and deadline. Unknown native completion still revokes the whole lease. End,
Pause, Stop and disconnect cannot be bypassed by recovery.

New readiness requires verified current document/site/ownership, a native
TimeTicks capture barrier and a matching frame actually decoded by the viewer.
CDP provides no conditional documentId input parameter, so this does not retract
already submitted actions or promise atomic cross-document input. UI metadata
comes from the current verified candidate; old title/address is cleared during
navigation. The 93f54a1 release is unchanged and excludes this new functionality.

Cross-layer regressions cover a retired generation's original in-flight ACK,
unknown input failure, old queues/frames/timeouts, coalesced state before a frame,
late Begin preserving its already queued first frame, and navigation during the
completion of status publication. The latter two had explicit original failing
tests before their fixes. Go all-package tests/vet/build passed; final extension
tests passed 1,995 cases and viewer UI 47. The canonical bridge/public projection
fixtures were regenerated through actual implementations rather than invented
wire results. Five metadata regressions also failed before the fix and passed
afterward.

A zero-business native clock diagnostic passed three static/redirect/SPA frame
observations and normal shutdown. First production navigation run `yI1c1P`
completed six stages, but visual inspection found the old A title/address on B.
The report and screenshots remain unchanged. After that display fix, `fRIjwN`
completed six stages with actual exit 0: one Begin/lease/target, 47 exact input
receipts across four used generations, one 302, one child navigation, one SPA
route and one final 483-byte POST. Three real viewer DOM metadata checks match
the original current page. Original Browser.close, browser/native/supervisor/
viewer exits, Job empty and registration/endpoint cleanup all succeeded without
forced termination. Report SHA-256:
`69fe80235ebebb1dc2a843d3a0c23b620b4e607ed8a6e6f86124bd7589e1b6f6`.
Independent audit fully decoded 53 native PNGs and 6 viewer screenshots; audit
SHA-256 `518c45d465f5942e4aa1487a16942252bd8667d3e4c1ecd7ce9913f1d5d40311`.
An earlier auditor failure from JavaScript Number rounding of native FILETIME
is preserved. Only that integer's IEEE-754 projection is compared specially;
the original Go JSON remains exact authority and is now bound by raw bytes/hash.

An additional same-document regression, `paPWuq`, failed before any webpage
request: the test's PID-only descendant walk attached old system processes to a
reused browser child PID. Actual test processes all exited 0 and the owned Job
emptied, but the incorrect disappearance list timed out. No unrelated process
was terminated, and this failed report remains intact. Four managed runners now
share a read-only helper checking full seven-digit UTC creation times on every
edge; a synthetic reuse counterexample failed before the fix and 27 related
tests passed afterward. This inventory is observation, never kill authority.

With the corrected harness and unchanged production runtime, `w1KteZ` completed
six stages with actual exit 0: 30 exact input receipts, trusted original Shift
and mouse release after socket disconnect, explicit Resume/new turn, same
document and one 299-byte POST. All original process exits and cleanup succeeded
without force. Report SHA-256:
`b70b2f128a1cbe0f7e52d422d40eff39fe1170ae5db03bded45919641fabb865`.
Independent audit passed and fully decoded 32 native PNGs plus 5 viewer
screenshots. It confirmed no compensating release on the disconnected socket
and runtime extension/EXE/SDK identity with the navigation run. Audit SHA-256:
`1568fcce7beefeeaeb5f70e6eb585b3090107d4ea5ea36be1ad8fc3e884e0cf2`.
The legacy same-document runner has no lifecycleSource field; its audit instead
hashes the original Go lifecycle bytes independently and only projects the
nativeCreationTime integer for comparison with the JavaScript observation.
These outcomes do not establish real held-input navigation, OOPIF-local input,
real SSO/MFA, complete IME, ordinary company Edge or cross-platform parity.
No PR or new package is created by this continuation.

## Original delivered results remain available to the user

The user requested another package. Before that build, complete the current
result-page continuation slice: only a successful formal finalize publishes a
bounded worker-local delivery identity for its original tab/target/document.
The private viewer can watch or explicitly take over a result while running or
cleanly paused, without renewing stale task authority. End leaves the Agent
paused and permits viewing or taking over the same result again. View and human
leases share native capture/cleanup but have immutable separate modes; view
offers no input interface, focus emulation, input tracker or implicit Pause.
Delivery IDs, generations and actual state-before-frame ordering survive the
bridge, Go controller, HTTP projection and UI. Legal task admission waits for
actual view cleanup; rejected stale task calls cannot remove user access.

Review corrections cover finalize publication under its ending fence, navigation
during multi-page finalization, late old-generation validation and status reads,
and pending Resume versus new selections. Read-only rendering permits bounded
zoom/resize without inheriting human-input geometry assumptions. The builder
includes the new registry module. Go all-package tests/vet/build, 2,053 extension
tests, 54 UI tests and 41 build/helper tests passed. Actual bridge-generated
wire fixtures passed their canonical check; simulated backend tests remain
distinct from native browser acceptance.

First native attempt `managed-result-vaiv5h` failed after A had been delivered
and redirected to B: the harness expected the old option label without the new
delivered-result prefix. Preserve the failed report, SHA-256
`77a933f248dc731a21439d688724d3cd713ea3d123a124854cabb99d080ba77d`.
Only the exact UI assertion changed. With unchanged production runtime,
`managed-result-VGrDlV` completed six stages with actual exit 0: original
finalize, running/paused read-only views, 50 exact native input receipts through
302/child/SPA, one 483-byte POST, two Begin/End pairs and a second takeover of
the same B document/draft/receipt without Resume or task reclaim. Original
Browser.close, process exits, Job emptiness and endpoint/registration cleanup
succeeded without forced termination. Report SHA-256:
`a132925e39d5f827342289a6eb93a04166ce4aff5c437389e9220198d83af177`.
The read-only phase preserved the observed page input events and draft; it did
not actively attempt input into the read-only view. Ordinary viewer regression
`o6PuJl` passed four stages with actual exit 0 on the same runtime; report SHA:
`b57bb329bf79d62b59f07c4160f8cbfa06394320ee5e98f3fed9853c8435cd11`.

Result authority is not restored across worker replacement. Stop still closes
the managed browser; visible result-window retention, real SSO/MFA/IME, company
Edge installation and cross-platform parity remain open. The requested package
requires a separate clean build and artifact verification; no PR is created.

The independent result audit passed 868 original-evidence checks and fully
decoded 37 native PNGs plus 7 screenshots. Audit SHA-256:
`7d29246e7edc110d1648dfd865118b17f813824581412944d22e453dc13181c3`.
The ordinary viewer audit passed 8 groups and decoded 38 native PNGs plus 7
screenshots; SHA-256
`d7b0ac2217bb424a27c2dea9e96661a2b2ba2c5ea39aabbf5824cac638662771`.
The first result auditor used the wrong original authority field name; the
first viewer audit's additional short TCP probe timed out. Both failed auditor
records remain unchanged. Corrected auditing and one bounded read-only probe
passed without altering or rerunning browser business.

Published the requested `preview-20261017-d0605b1` from clean commit
`d0605b1e9f34d9e695d3147e8cf59cdcef59b994`. Offline CLI/MCP 30 tools,
5,442 independent artifact checks, 98/71/6 bundle/extension/Skill members,
four-asset download roundtrip and a 102-file local copy all passed. Artifact
audit SHA-256:
`984c0fa5f36812a7f82d87049271667e7d34a095fd8d6f99175fece0639950d2`.
Full ZIP SHA-256:
`c4132c5022cae9d84efb8b6bfe81d920618bacd63e4dbc75baa1c541d4fa4fe3`.
Initial GitHub draft creation returned an already-existing asset error after
uploading three files. Exact target/digests were checked, only the missing full
ZIP was uploaded without replacing assets, and all four were downloaded and
verified before publication. The release executable was rebuilt separately with
clean VCS metadata and trimpath, not relabelled the browser-tested executable.
No PR was created. The broader capability goal remains active.

## Managed original download acceptance and startup identity ordering

Added a formal managed download runner and a separate bounded proof module.
The intended workflow uses eight original transfers: root/existing OOPIF/new
OOPIF POST and Blob files, an actual in-flight cancel, and observation-only
cancel followed by completion. It retains the real Native binding, public
receipts, passive Page events, original documents, global HTTP journals and
full returned-path bytes. Only seven fully verified files are individually
removed; the default download directory is independently read, never configured
by the test or scanned for filenames. Negative checks reject forged completion,
fixture-caused cancellation, unassigned requests and replay.

First native attempt `managed-download-IGwZHd` failed before any download with
the original generic managed-user CDP event rejection. Its report SHA-256 is
`a0285d20aaec06451e66bd3928c1409b4252fb5003085e1b433c265fce31b34a`.
The automatic binding succeeded; original Browser.close, browser/native exit
0, Job=0 and registration/endpoint cleanup completed without forced termination.
The runner's later Stop against the already-ended supervisor returned failure
and remains recorded. Supplemental stopped-state observation found no remaining
original resource. No original CDP event payload was captured, so this result
does not identify the precise event or establish its root cause.

Inspection found a separate definite scheduling window: the CDP reader can
process an event immediately after the original attach reply, before the caller
has published the returned session identity. An equivalent helper extraction
and deterministic scripted-WebSocket test reproduce that refusal without sleeps
or browser retries. The original successful attach receipt now publishes its
session synchronously in reader order, outside the transport lock. Cleanup
retains that exact receipt across caller cancellation and waits for the actual
detach acknowledgement. Foreign/malformed replies still grant no authority;
fixed-category diagnostics expose no native payload or arbitrary error text.
The deterministic old-behavior test failed, then passed with the fix. Late
reply, malformed reply, foreign session, lock ordering and diagnostic privacy
tests passed. Full Go tests, vet and build passed with 168 unchanged source
inputs. Validated executable SHA-256:
`baada6198055a65f75dd6934e1533ad41233642decdc5908a7f34a31d79d32fd`.

Two subsequent native attempts exposed separate harness assumptions. In
`managed-download-CGCzdj`, the real new executable reached ready, but the runner
parsed only the first line of pretty-printed JSON; no download was attempted.
Report SHA-256:
`2ef0bf0926e8e38122cee9e817c8d61bcd41635bc584dbdcb16ae625c4de0bb8`.
The complete-object parser now handles stdout chunking. Its first privacy test
also caught assertion formatting that included trailing input; fixed boolean
assertions passed the same test without disclosing the supplied value.

`managed-download-a1GGbR` passed root POST/Blob and read the original OOPIF POST
file, then failed a root-frame-tree membership assumption: this Chromium's root
tree omitted the separate child process. Its actual Page GUID, original child
attachment and session agreed. Report SHA-256:
`3fe9fa475eee7845b6fe54d3c40b938df9130da617258a1f3ba26501c7eddc36`.
The runner also incorrectly expected `stopped: true`; the actual CLI replied
with the exact run ID and `state: stopped`. Both failed attempts preserved
normal Browser.close, browser/native exit 0, Job=0 and original resource
cleanup. Their failed reports remain unchanged; none counts as successful
download acceptance.

The final harness reads the original OOPIF session's frame tree before its
single click and compares native target, attachment, parent, URL and document
evidence. Optional native `parentId` may be absent, but an observed value must
match; the original attachment's parent link is always required. The fixed
ready/Stop parser tests passed 4/4. Final proof/fixture/file checks passed 36
with one existing Windows symlink-permission skip; the proof's nine tests passed.

`managed-download-LWwtqG` then passed all five stages with actual outer exit 0.
Eight original attempts produced seven complete files (17,524 bytes) and one
actual canceled held response. Sixteen foreign scope path/cancel requests were
rejected. The complete 17-request journal contained 12 GETs and five POSTs,
with no unassigned request or replay. Actual cancel acknowledgement, Page
`canceled` and unfinished HTTP close all preceded Stop and fixture teardown;
canceling only the waiter left the other original response open, and releasing
that same response completed the same GUID. Seven files were removed only
after rechecking their original identity and exact bytes. Browser.close,
browser/native/supervisor exit 0, Job=0 and registration/endpoint cleanup all
completed without forced termination. Original report SHA-256:
`34100f88ecd6090eaa7dae4677e15d4355c9a8a8ce894e1f8b03bee8c66171c3`.

Stopped-state independent auditing passed 2,959 checks across six sections,
including 533 frozen source files, 71 runtime extension files, 26 SDK files,
168 validated host source files and exact original Go uint64 lifecycle bytes.
Audit SHA-256:
`9e45a4671a1b5e9d9d3d87d3519fb61681368a8f3fb84b3b9aba1b30b6c90708`.
Its first attempt failed because it expected generation in the worker's private
binding proof; the actual generation lives in the host binding and public
client metadata. The corrected audit compares those original fields directly,
without substituting the nonce. Preserve the failed audit SHA-256
`09218bd1dd1dc8cccb27cb870a0858613b2deca1884bd70c261cf0d57287204a`.
No browser business was rerun for auditing. The three files from the earlier
failed OOPIF run were separately identity/byte-verified and precisely removed;
its original failed report was not changed or upgraded.

The accepted Go startup fix remains newer than published package d0605b1.
Unchanged extension/SDK files were reused; existing result/viewer browser
workflows and the extension's full suite were not rerun for this host change.
Ordinary company Edge, broader platform/recovery behavior and complete Codex
parity remain open. No additional package or PR was created in this slice.

## Explicit browser provisioning and requested Windows refresh (2026-10-17)

The user asked whether development had finished and requested another package.
Full parity remains open. This slice removes the requirement to manually find
a compatible managed browser: `managed browser install/status` uses fixed CfT
win64 155.0.8059.84 and a compiled official URL/archive digest. Installation
checks bounded ZIP paths, full file bytes and an exclusive native cache lock
before same-volume publication. Existing damaged or unknown trees are retained.
`run/setup` select the installed cache offline; explicit browser paths win.
`run` defaults only to the extension beside the executable. No ordinary profile
discovery, automatic update or browser restart recovery was added.

Windows directory-replacement testing caught lazy file-ID acquisition in Go's
Lstat FileInfo: a later SameFile could inspect the replacement pathname. The
fix captures identity from the original open handle's File.Stat before download;
the original failing case now rejects and preserves the replacement directory.
Runtime tests recorded 60 passes, zero failures/skips with the optional original
archive check enabled. CLI focused tests and full Go test/vet/build also passed.
The original failed test log remains preserved.

The initial origin-download helper incorrectly inspected only the first of two
x-goog-hash headers and reported failure after downloading complete bytes. That
failed report was retained; supplemental exact-origin metadata, local MD5/SHA256
and all ZIP CRCs verified the unchanged file. This is a local pin, not a Google
signature. The independent ZIP inventory contains 305 files, 455,706,289 bytes.
The first production-install harness invocation stopped before any install due
to case-sensitive environment lookup; it was corrected and its failure recorded.

The validated production EXE then completed actual download/install, offline
status and repeated install with only System32 on PATH. All 305 installed files
matched the independent original ZIP inventory. Install report SHA256:
`3c1450129454f9a64aaa327841162e528e506737d5590b444b901a556a95f183`.
Go validation report SHA256:
`b0406be840eefac5805a00613bcaa93336f66966f2a687c19a7b8fee60e03963`.

`managed-viewer-7dxhON` passed four original stages with actual outer exit 0.
It launched from a fresh cwd using only browser-cache selection and EXE-adjacent
extension defaults, with automatic Native binding. The original child submitted
once; 38 native PNGs, real DOM Pause/Resume/Stop and original browser/native/
supervisor exit 0 completed without forced cleanup. Raw lifecycle bytes preserve
the original native creation-time uint64. Report SHA256:
`49e7a990b183f020be97748abd2974e0d9b9ca97c14ab6d22b3f00211b4af2e1`.
The real browser used the validated precommit EXE; the requested release will
rebuild from the clean source separately. Visible setup, real login, ordinary
company Edge and worker recovery were not exercised in this slice. No PR.

### Runtime dictionaries and final repeated-use acceptance

Stopped-state auditing of 7dxhON exposed a real repeated-use bug: Chromium wrote
`Dictionaries/en-US-10-2.bdic` next to its executable. All original 305 files
matched, but production status then exited 1 for an unknown directory. The first
failed audit (SHA256 `02610d55151c384ffb43b422c0134de9652a6f1d786e2b4dddb6391ac7e45034`)
and actual status failure were retained. No dictionary was deleted to turn it green.

The final runtime accepts only bounded direct locale-version.bdic entries in that
exact directory, requiring regular single-link files and a BDic header. Links,
nested directories, unexpected names and programs remain rejected. Limits are
64 files, 32 MiB each and 128 MiB total. Original manifest entries always retain
exact digest checks, including any dictionary originally present in an archive.
These runtime data are not authenticated official ZIP members. Final package
tests recorded 75 passes, zero skips/failures; full Go test/vet/build passed again.

A fresh production installation and four-stage `managed-viewer-1wBVEd` both
exited 0 with the final source. The original child submitted once, 40 native
frames arrived, and original browser/native/supervisor exit plus cleanup completed
normally. After shutdown, production status and install reuse both succeeded with
network proxies pointing at a closed loopback port and System32-only PATH. The
independent stopped-state audit passed all 10 sections and fully decoded 47 PNGs.
Root visually confirmed the original cursor and target highlight. No browser
business was replayed by the auditor, and previous failed reports remain unchanged.

Final browser report SHA256:
`c8fb411b33ed72c43e5ed5073db4bebc9dc15db4a24c6b7cd3ec9bc4808597f7`.
Final audit SHA256:
`d254239f9b09e8aba486200a6ce7b077c9e6743e955d5dc2bbcd4f33abcc1eb5`.
Post-run cache report SHA256:
`b2ec8889de029f30a6b7c61590683b3bb3714e38c8ad1bdf93169246c8f9e9e5`.
The requested release uses this final source; it does not promote the earlier
incomplete cache-reuse result or claim visible setup and login were retested.

### Published Windows package

Published `preview-20261017-81cfdae` from clean commit
`81cfdae2442e816c5e97e2c09a9ae96ee325f515` to the user's fork, without a PR.
The release EXE is a separate Go 1.26.9 Windows amd64 trimpath build. Offline
CLI/MCP initialization and 30 tools passed; independent artifact auditing passed
5,488 checks with full/extension/skill inventories of 98/71/6 files. All four
uploaded assets were downloaded again and matched before publication. The
local 102-file delivery copy also matched. No browser business was rerun for
release packaging. The source-binding check records Git CRLF-to-LF clean-filter
canonicalization for two pre-existing text files; their accepted raw hashes and
committed blob hashes are both retained, with no other source difference.

Full ZIP: 10,381,832 bytes, SHA256
`991b661e6a953da15559f5284910e70f2e19385444c7d7e243c2e9fb327f01a1`.
Artifact audit SHA256:
`250ee29a261daa73ce0e230a64601894b8291e96675ff2c128fcf8e27f410874`.
Release: https://github.com/mikyan/open-browser-use/releases/tag/preview-20261017-81cfdae
The package includes the normal company-PC installation guide and optional
install-then-run managed commands. Browser binaries are downloaded explicitly
on first use, not included in the ZIP. Full parity remains open.


### 2026-10-17: Recover one Native connection in the original live worker

Add explicit `managed recover` while preserving the original Browser/profile,
worker target/context/boot identity and delivered result pages. Session retains
all Native process handles, bindings, exit receipts and controller cleanup across
at most 32 generations. Native loss degrades management without closing the
Browser. Recovery retires the original controller and HTTP viewer, verifies a
new Native process/Port and the same worker, then publishes a fresh paused viewer.
Stop cancels and joins recovery and all retained resources; failed preparations
remain owned. Old task/view access cannot implicitly reconnect or resume input.
The extension has a bounded exact-identity cleanup-only retirement operation.

Cross-layer tests caught two cleanup issues: real nonzero Windows process exits
must preserve their original error while being distinguished from unknown wait
failures; whole-controller Close must verify explicit null/idle fields and the
original human cleanup before accepting a receipt. An independent review also
found that an earlier viewer unsubscribe error could permanently block later
confirmed retirement. Its red/green regression now requires the same unavailable
backend's actual full cleanup after all HTTP/WS workers finish, retaining the
historical error. Live backends and unknown cleanup are not accepted as proof.

The first real attempt LPY0ZE completed its only POST/finalize but failed result
viewing before Native fault injection. Fixed official Chromium sources and an
independent zero-business CfT 155 capture proved that version lacks native
`monotonicTimestamp`; its wall-clock timestamp is not a substitute. Preserve the
capture barrier and return `OBU_HUMAN_CAPTURE_UNSUPPORTED` with an actionable
viewer message. Pin CfT win64 156.0.8078.12 instead, with original ZIP SHA256
`3afa11a86d390f83dc108c218a8fde04d68f2a9c4fd4cd010db0f2cde4837e5c`.
Explicit installation supports coexistence with the verified former 155 pin,
without modifying it or selecting it as the default. Unknown/changed files and
real directory junctions still fail closed. Runtime/CLI tests and vet passed.

The production EXE performed the real network installation, offline status and
reuse into an independently copied historical cache. The independent audit
confirmed all 309 old files and dictionaries unchanged, and all 305 new original
files (460,072,969 bytes) identical to the official ZIP/manifest. Runtime-generated
dictionaries were recorded separately. Upgrade audit SHA256:
`7efa62b360a01d9f85918c93a3149cb39b50112fcee5dde2c7dcff5cdb7c92fa`.
Full Go test/vet/build passed with unchanged source; validation SHA256:
`a073adb3772e7adccf9fb582bb6774caec0464405b0f7d533f0f6d4d61c992a5`.
The extension's complete 2,065-test recovery baseline passed; the subsequently
changed human-control module passed all 70 tests. The runner helpers passed 9.

Keep 4J5sp6 (test read private cleanupPending from the public result) and htYjeo
(test expected a Playwright socket event after closing its observed target) as
failed attempts. Both completed the original baseline result and human End with
normal shutdown; neither reached fault/recovery. Fix only those harness contracts:
use the strict public cleanup projection and the existing formal managed-view
reader/worker/cleanup barrier. Do not manufacture a socket event or replay inputs.

Final A6UPE3 completed all six stages with actual outer exit 0. One original POST,
15 exact human input receipts, 17 native frames, two Begin/End pairs and no Resume
were recorded. One exact retained Native handle was terminated; its confirmed
exit 4294967295 and original error remain in lifecycle evidence. Explicit recovery
created one new Native generation while retaining Browser/worker/context/target/
document/draft/receipt. The old unused ticket failed on old and new listeners.
The fresh paused viewer edited only the original result note and local review.
Native generation two, Browser, supervisor and viewer exited 0; Job, registration,
endpoints and original processes were cleaned. Root visually checked the recovered
result and Unicode note. Post-run cache status/reuse passed again with closed-port
proxies and System32-only PATH. Browser report SHA256:
`0c1b90c272f9bc92a75c5758728ac0b54edbb951eb2b4e7d7212ba5be79cc74a`.

Independent stopped-state auditing passed nine groups with actual exit 0,
covering five original lifecycle byte copies, exact uint64 process times, both
Native cleanup receipts, all 20 fully decoded PNGs and 30 original process
identities. Both registry views, both pipes and endpoint records were cleared.
Audit SHA256: `421267e9d1ba316adff641a629c74325c875d4511d5cb577017215f0c8e35e2b`.

This slice does not verify true worker replacement, browser restart, in-flight
input recovery, real accounts/IME/SSO/MFA, ordinary company Edge or other platforms.
It does not create a PR or another package; the published 81cfdae package is
unchanged and does not contain these fixes. The full parity goal remains open.

### 2026-10-17: Requested a4e6b0c Windows package refresh

The user requested another usable package. Published [preview-20261017-a4e6b0c](https://github.com/mikyan/open-browser-use/releases/tag/preview-20261017-a4e6b0c)
from clean source commit `a4e6b0cb5142d7e34c94c2857e4420ce28804a61`. The package includes the
fixed CfT 156.0.8078.12 recommendation, verified old-cache coexistence, and explicit
same-worker Native recovery. True worker replacement remains unimplemented.
The source was rebuilt separately for release; no browser business flow, browser
installation, profile mutation or PR was performed during this packaging round.
Original A6UPE3 acceptance and prior failed attempts remain separate evidence.

Offline CLI/MCP exposed 30 tools. The independent artifact audit completed
5,510 checks against 499 matched source inputs. Bundle/extension/Skill contain
98/71/6 files. All 4 uploaded assets were downloaded and matched the original
hashes; the local delivery copy matched all 102 files. These counts describe
artifact checks and do not add browser acceptance attempts.

Release executable SHA-256: `0db5e597ed164bc356d348245eccfcfe93eac2d393a47a9d6879bc213b5de0b7`.
Independent package audit SHA-256: `4bf6d55f5313d3c932d2910870369897a123f456563f1bcb7d2e92890bc4482d`.
Offline report SHA-256: `440bcef7df40f77f2124bc1f0efb6fe799b746f88d0187a0c4b1d8b05bbbd8cf`.
Upload roundtrip report SHA-256: `eb66506b34bfe0b4dd2409db1468581cb01e6e3466a1e2f59af2f80a0d304a68`.
Published release receipt SHA-256: `4e5e0a2472bb39285966f681e6094b69f862c385bd421e93bf99505572cb9a50`.
Local copy report SHA-256: `59a911bf114e35437b67a56825657f92dafbb40bcdcdf6046aca79bb7783d614`.

- `open-browser-use-windows-x64-preview-20261017-a4e6b0c.zip`: 10,436,765 bytes; SHA-256 `3d57c22d08869a5919ec4fe9edb05367023e08fa7ffea5b6355b7ddbce85283c`.
- `open-browser-use-extension-preview-20261017-a4e6b0c.zip`: 1,418,211 bytes; SHA-256 `86ce4e50861613009d739d848475a59bed0cc48f008647a1eaa02d74842ec6ab`.
- `open-browser-use-skill-preview-20261017-a4e6b0c.zip`: 28,048 bytes; SHA-256 `5d17b8e42c860f38cc9d9c7c964b0ab83016c2b3ab5d98e75e2715c4927a9fdb`.
- `SHA256SUMS`: 367 bytes; SHA-256 `2a43fce2d09615739b0afcfe74ad73d523e249583ba789c4d0259ad142c6abdc`.

The browser is downloaded only by explicit `managed browser install` and is not
bundled. Existing 155 users must run that command after updating the program;
run/setup do not silently upgrade. The package retains the normal company-PC
installation guide. Full parity, company Edge, true worker/browser restart,
unconfirmed input recovery and real login/IME/SSO/MFA remain open.

### 2026-10-17: Requested 6588984 Windows package refresh

The user asked whether development had finished and requested a fresh package.
Published [preview-20261017-6588984](https://github.com/mikyan/open-browser-use/releases/tag/preview-20261017-6588984) from clean commit `65889844f5266f2e2702f5ee9726ab9105ec2c1f`.
Runtime behavior is unchanged from a4e6b0c: all 558 accepted source inputs have
identical Git blob identities; the intervening commit changes nine documentation
files only. Ongoing worker-replacement implementation remains in the worktree
and is excluded from this release. Full capability parity remains open.

The EXE and extension were rebuilt in an isolated clean checkout. Offline CLI/MCP
exposed 30 tools; independent artifact auditing passed 5,507 checks.
The full bundle, extension and Skill contain 98, 71 and 6 files. All four uploaded
assets were downloaded and matched their original hashes; all 102 local delivery
files matched. The only managed-guide publication transformation updates its
release introduction, with repository-relative links bound to the source commit.
No browser business, installation, registration change or PR was performed.
Earlier acceptance and failed runs remain historical evidence.

- Full ZIP: `open-browser-use-windows-x64-preview-20261017-6588984.zip` (10,435,599 bytes), SHA-256 `9a29b535f081bfffe871ad597fba3e0b29d04374cd75f1cfe1a8c54ca8e8746b`.
- Release EXE SHA-256: `2e379d017c5499e71fd8dd61c6047b2b348718519717c6f760ef21a774f204d0`.
- Independent audit SHA-256: `3604acf230afad22714625b7b38b8832dcac2dd99e8eaa88984febbf2f622ddf`.
- Upload roundtrip report SHA-256: `452edac193b268537a451a7be4bd2cf12b4aedf86b2a37e68aeead75d70718a1`.

The first preparation attempt encountered an existing scratch report and refused
its exclusive write; no previous report was overwritten. A new isolated directory
was used for the completed preparation and release. Ordinary company installation
instructions remain in README-先看这里.md. True worker replacement and the broader
unverified boundaries documented for a4e6b0c remain incomplete.

### 2026-10-18: Explicit recovery after original worker execution ends

Continue the existing parity goal without another package or PR. Add a private
IndexedDB result journal, transactional epoch checks and durable view obligations.
The replacement starts blocked, verifies the original journal through the trusted
Go controller, waits for original view stop/detach and revalidates current exact
page identity before issuing new delivery permissions. Old task/human/viewer
capabilities stay retired; no URL or business input is replayed. Known durable
revocations remain revoked. Uncommitted events and complete movement history
across forced worker termination are not claimed recoverable.

Go distinguishes original execution termination from Native exit, transport
retirement and actual page cleanup. A passive Native observer retains cleanup
ownership only for exact processes in the original Job; it does not bind or open
tasks when original human risk prevents recovery. Normal Stop waits for the Job,
all retained Native processes and the original controller. Only the exact temporary
owned-exit wait is superseded when both final Session and controller cleanup
succeed; other errors and timeouts remain failures.

Preserved failures led to specific fixes: an IndexedDB schema error before abort
handlers were installed left a transaction pending; a long test profile path
prevented Chromium's LevelDB manifest creation; the first replacement harness
incorrectly required manual Start although Chrome restarted automatically; and
the initial held-input run retained the pre-exit wait error after successful Stop.
A separate deterministic review exposed a late-frame admission window during
durable view retirement. The fix seals frame admission after actual detach,
drains already accepted ACKs, then commits retirement. The old-source regression
failed before the fix; 111 related tests passed afterward. No real browser
ordering equivalent to that controlled late-frame test is claimed observed.

Final frozen v3 Go test/vet/build and all 2,075 extension tests passed with stable
source hashes. The first extension validation driver failed printing Unicode
after its test subprocess exited 0; it did not reach build or save a complete
manifest. That log remains, and a corrected driver completed a new validation
with persisted before/after hashes and a fresh extension build. Existing UI 54,
three canonical bridge fixtures and harness helper 12 checks remain separate
evidence; mocked backend/storage/native fixture ACKs are not browser acceptance.

Two independent fixed-CfT scenarios each completed six stages with actual exit 0:

- `mwr-r-esLC1h` retains the original Browser/profile/page and one 173-byte business
  POST while an active result view survives an actual worker replacement. New
  execution/Native identity, explicit recovery, paused fresh permissions, rejected
  old permissions and nine human input receipts passed without resubmission.
  Eleven native frames plus three viewer screenshots were retained. Independent
  audit passed 12 groups, decoded all 14 PNGs and confirmed 32 original process
  identities gone plus private registration/pipe/endpoint cleanup. One incidental
  favicon GET is recorded separately.
- `mwr-h-Fv7gx8` has zero business POSTs and three native input receipts establishing
  Shift/pointer down. Four original-document observations stay unchanged, recovery
  is rejected, and formal Stop/supervisor now exit 0. The final session-terminated
  receipt confirms original Job destruction, not synthetic keyup/mouseup or a new
  recovery permission. Input observations end before the original page is destroyed.
  Independent audit passed eight groups, decoded all four PNGs and confirmed
  31 deduplicated original process identities gone with private resources cleared.

Raw lifecycle JSON preserves exact Native FILETIME values. Real acceptance checks
typed production recovery receipts and original attached-to-detached target reads;
it is not an independent command-packet capture. Placement assertions check current
window/group/pinned state and do not retain every after-snapshot or prove tab index
and complete history. Both final runs used Chrome's automatic restart path; the
explicit-Start branch has helper coverage, not a separate real run in this slice.

- Positive report SHA-256: `bf69cd50c50e8ec5d6ca047e9646507cbf9b58ec0bbb68eca962f1eb6b47804d`.
- Held-input report SHA-256: `16e229ce3de9cf5099ea9dc503065226006919dbc434ffe7de14af95ff17555c`.
- Positive audit SHA-256: `65db2dd170e28277b6f98217c77c3fa1803cd60a4742ad14dcbb09aa5e6ebec0`.
- Held-input audit SHA-256: `ee490e5b4dcae80b052d984195c61ef71f939958e8b29ee666295cb122de2024`.
- Go validation SHA-256: `ef04f2207a27fd1e1e89aec569fa31ef7af277b179d41bd17f863085896f43c6`.
- Extension validation SHA-256: `57cab99fd064fd026ad137071f9e7a01810a21531ba8a9791b0c413736169b53`.

Implementation lives in the managed journal/results/backend/bridge modules,
`internal/managedbrowser`, `internal/managedviewer`, the managed CLI and the new
worker recovery runner. Architecture, reference, quality, specification and active
plans now distinguish this source-only capability from the unchanged 6588984
package. Browser-process restart, retained windows after Stop, company Edge,
real login/IME/SSO/MFA and complete parity remain open.

### 2026-10-18: Requested 853ea92 Windows package

用户再次明确要求打包，已从干净提交 `853ea9211b15ccdebe84dd3fe0df955853b80a0b` 发布 [preview-20261018-853ea92](https://github.com/mikyan/open-browser-use/releases/tag/preview-20261018-853ea92)，首次将已验证的 worker 替换恢复放入 Windows 包。
离线 CLI/MCP 30 工具、独立制品 8,437 项检查、4 个资产回下载及 103 个本地文件校验通过。
完整包/扩展/Skill 分别为 99/72/6 文件。本轮未重跑网页业务；发布 EXE 单独重建，原始功能验收和失败证据保留。
下一轮 workflow/OS 观测脚本及 Skill 草稿未纳入本包；完整能力对齐仍未结束。

- Source commit: `853ea9211b15ccdebe84dd3fe0df955853b80a0b`.
- Full ZIP: `open-browser-use-windows-x64-preview-20261018-853ea92.zip`, 10,480,112 bytes; SHA-256 `6f5a92f78398debedfd8d7442893291cc72560b77abd1b833de8ab493efbbef3`.
- Release EXE SHA-256: `243d84e2a7ee972605baed53949cfc0df08640d8c957fea5ea7526ee874a11dd`.
- Independent artifact audit SHA-256: `ab7dc08263809cdda45badaf290b00c053b29d62cbd3d3154129b781cadd9967`.
- Upload roundtrip SHA-256: `3f2d0e6a2ed21f4fd1895a9675e1e0aa7c5132adba47ba1148b9408fc76ca217`.

All production bytes came from the isolated clean source commit. Installation
wrappers and licenses retain the previously audited layout; managed guide changes
are recorded as exact publication edits with source-bound links. No installation,
registry mutation, personal browser access or PR was performed for this release.
Original worker positive/held-input acceptance, independent audits and historical
failures remain distinct from this package build and offline validation.

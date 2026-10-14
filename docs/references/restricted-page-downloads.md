# Original Blob downloads on allowed websites

This is the development implementation contract for original Page downloads
under website allow-list or block-list settings. Isolated browser acceptance
and preserved failures are recorded in the [execution plan](../exec-plans/completed/2026-10-14-restricted-page-downloads.md).
It does not change the published preview or establish ordinary installed-browser
authorization.

The supported download is triggered by the proven allowed original document,
with a non-opaque Blob URL whose origin equals that document's native security
origin. Root documents, existing frames and newly attached frames use
the same source rules. A current allowed URL alone is insufficient evidence.
The original browser download is retained even when the page immediately
revokes its Blob URL; the product does not fetch that URL again.

This proves the original download emitter, not the Blob's creating document or
the source of its contents. A same-origin document or worker can share a Blob
URL with the triggering page. Website settings do not track data flowing into
Blob contents and are not a page network firewall.

HTTP/POST Page downloads remain unsupported in restricted mode. Page and
Browser download events identify a GUID, frame, final URL and suggested filename,
but do not establish the original Network request and redirect ancestry. The
implementation does not infer that relationship from URL, filename or timing.
This limitation does not remove existing unrestricted HTTP/POST support.

## Public workflow and binding

Public API shapes are unchanged. Arm `tab.expectDownload({requirePath: true})`
before the page action, perform that action once, collect the result, then call
the returned download's `path()`. Python and Go use their existing typed
download waits. CLI/MCP retain the existing `armDownloadWait`,
`collectDownloadWait`, `cancelDownloadWait`, `downloadPath` and `cancelDownload`
operations. Preparation and collection share the original wait deadline;
`requirePath` readiness does not guarantee later file completion.

Actual file paths still require an explicitly authorized, verified Browser root
binding. The original Native Port, Browser generation and page target are fixed
during preparation. Missing or replaced bindings fail; an explicit new binding
does not revive an old handle. Ordinary extension-only access does not gain
the Browser domain or a guessed path. See [original file delivery](original-page-download-delivery.md)
and [current-session connection](current-session-connection.md).

The host joins the admitted Page GUID to that same GUID's Browser events.
Only the original completed event's `filePath` can supply the returned path,
after the existing regular-file and scope checks. There is no directory scan,
History fallback, filename match, replacement GET or input replay. Another local
application may change a file after validation; a path is not an immutable copy.

## Source admission and navigation

Preparation fixes the policy generation/revision, task scope, attachment and
original frame documents. A new child must obtain its own original preparation
evidence; it cannot refresh an earlier prepared source into a replacement
document. The first eligible native download event fixes the candidate GUID,
emitter frame and native session before asynchronous source inspection.

A frame created after arming may initially expose an empty native document.
Its original frame-attachment event, parent route and parent/root document
tokens permit only that new frame's first commit to complete preparation, within
the original deadline. The first navigation event and native tree must agree.
Existing frames and a second commit cannot refresh their original proof, and
download arrival or collection cannot manufacture missing preparation evidence.
Cancellation ends a purely internal commit wait; any native read already sent
must still actually settle before cleanup completes.

Admission verifies the original source and ancestor identity, native loader and
original default Runtime context (route, frame, numeric ID, unique ID and actual
origin), and the complete currently allowed document tree. An allowed
new document cannot stand in for the original one, including when the URL is
unchanged. Opaque sandbox origins, unknown emitters, denied children and a source
that changes while a native frame-tree response is pending are refused. A Blob
origin string alone does not prove its creator's authority.

`Page.Frame.securityOrigin` cannot establish an actual non-opaque document:
Chromium derives it from the [loader URL](https://github.com/chromium/chromium/blob/156.0.8078.4/third_party/blink/renderer/core/inspector/inspector_page_agent.cc#L1452).
The default Runtime context instead receives the window's
[actual security origin](https://github.com/chromium/chromium/blob/156.0.8078.4/third_party/blink/renderer/bindings/core/v8/local_window_proxy.cc#L294),
and emits it with the original [default/frame metadata](https://github.com/chromium/chromium/blob/156.0.8078.4/third_party/blink/renderer/core/inspector/main_thread_debugger.cc#L130).
Existing native Runtime events supply this proof; the product neither reads
page-controlled `globalThis.origin` nor creates an isolated world for authority.
Context destruction, clearing, replacement or attachment retirement invalidates
an unadmitted candidate. An isolated context cannot stand in for the default one.

There are two different navigation lifetimes:

- Before source admission, document replacement invalidates that candidate.
  A late native response cannot use the new document to authorize it.
- Once source admission has established the original GUID as an authorized
  artifact, a later legitimate navigation within allowed websites need not
  invalidate the file. Path/cancel still require the original policy, owner,
  control scope and Native Port binding, plus an allowed current document tree.
  They do not reassign the artifact to the new document.

Policy changes and retired control epochs cannot revive old handles. Saving
website settings pauses agents; later Resume and a new turn are explicit and
do not replay the download action. [Website access settings](site-access-policy.md)
remain document-access control rather than a network firewall: rejecting agent
metadata does not prove that the browser did not already create a file.

## Cancellation and actual cleanup

Canceling a wait only cancels observation. It may drain the exact owned wait
after website revocation without reading the denied page, while still requiring
the original owner and control epoch. It must not alter a successor attachment.
Closing a tab or releasing a private claim also does not cancel the browser's
transfer or delete a completed file.

`Download.cancel()` is a separate operation against the confirmed original GUID.
It follows the existing real Browser command/ACK contract; an ACK is not a claim
that already written bytes were erased. No new cancellation semantics or download
replay are introduced for restricted mode.

The extension retains the actual private claim/path/cancel/release operation
after its caller deadline. Pause, session cleanup and attachment release join
those original settlements. Release follows outstanding work on the same claim;
a caller timeout cannot allow a late claim to reappear after cleanup. Failed
cleanup keeps control fenced, and explicit recovery cannot borrow a new Port's
authority for an old operation. These cleanup rules also protect unrestricted
original Page downloads.

## Verification status and limits

The old-source real run `OjHQpm` retains the first permitted root-page arm's
`OBU_SITE_ACCESS_UNSUPPORTED` before any business click, download event or file.
Production Browser binding and policy restoration succeeded. The aggregate
remains failed; a separate raw-navigation control used a scope retired by the
settings workflow. Its harness repair is not a repair or replay of the original
download attempt.

The candidate fixture uses five public entries across root, existing OOPIF and
dynamic OOPIF layouts. Each action creates one original Blob and immediately
revokes its URL. The oracle independently joins document/frame/source, private
claim/path replies, original Page/Browser GUIDs, returned path and actual file
bytes. Boundary cases cover cancellation, admitted-artifact navigation,
unadmitted source replacement, opaque and HTTP/POST rejection, denied children,
policy revocation and actual release cleanup. Final candidate `Y00W3K` passes
both top-level cases with actual exit 0 and unchanged source/runtime identities:
fifteen positive original files and ten boundary workflows. The HTTP case keeps
the original click and collection errors independently; both report explicit
website-access denial. A denied native download may still create a browser
file, so zero public claim/path/notification is checked separately from bytes.

The opaque child using its parent's shared non-opaque Blob is blocked by
Chromium before any native download event. Its original timeout, unchanged
file inventory and zero native/public transfers accompany one exact original
browser rejection line. A hashed stderr prefix is saved during the run; the
final teardown log retains that prefix. This proves browser rejection in this
case, not product misadmission on the pre-context source. Native-event backend
counterexamples establish the separate missing-context authorization defect.

Earlier failed aggregates remain preserved: initial dynamic-child preparation,
collect-after-retirement, a missing HTTP collection outcome and reading the
browser log before teardown. The fixes retain original inputs/deadlines and
distinguish product errors from fixture failures. Current Node groups total
3478 pass and one existing Windows symlink privilege skip. One supplemental
old HTTP fixture test had an unexplained `ECONNRESET`; its original failure is
retained, and the final affected integration group passes 1616 plus that skip.

Unrestricted regression `NnimoV` passes 2/2 with thirty original files/5200
bytes and all six groups ready before their triggers. The negative/provenance
run `2gHGdI` passes 3/3: original binding, ownership, disconnect and explicit
recovery boundaries remain intact. Its five POSTs and one browser-originated
resume GET returning 405 are retained separately; this is not a zero-GET claim.
Independent review verifies exact file evidence, source/build identities,
process closes and zero activation/focus events in both observation intervals.

The unchanged default browser case set passes 175/175 in `8zKuaa`, actual
exit 0, with source/runtime identities unchanged. It remains separate from
the explicitly bound restricted and unrestricted original-file workflows.
All prior 175 names and their order remain intact. The 533980ms observer
interval contains only the original twelve activation and four control-popup
focus permissions, with no new exemption. Nine keyboard scenarios retain
their original trusted End down/up and actual native acknowledgements.
The original host is terminated by the intentional restart, its successor
closes all connections and exits 0, and exact-run process inspection is empty.

Two controlled delivery gates are explicit diagnostics. One retains a successful
original `Page.getFrameTree` response while a real same-URL navigation occurs.
The other retains an actual private release reply, matched by original operation,
request ID, nonce and generation, until the original ten-second Pause cleanup
budget fails. It then invokes the original receiver with the original message.
The host has already acknowledged that work; this is delayed delivery, not a
naturally unfinished host command. An independent watchdog is a test failure,
never an extended action deadline or successful cleanup witness.

The bound-browser acceptance mode uses a private profile, the existing loopback
Native Port adapter and a transparent Browser message relay. The ordinary full
suite remains unbound and is a separate regression check. Neither mode proves
ordinary Edge authorization, dangerous-download handling, a general HTTP/POST
provenance solution, cross-platform behavior or complete Codex capability parity.

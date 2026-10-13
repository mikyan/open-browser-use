# Website access settings

The toolbar popup offers **All websites** (the compatible default), **Only
listed origins**, and **Block listed origins**. Entries are exact HTTP(S)
origins: scheme, host and port. `https://example.test` does not include HTTP,
subdomains or another port. IDN, case and default ports are canonicalized;
credentials, paths other than `/`, queries, fragments and wildcards are rejected.
At most 100 entries are accepted. An empty allow list permits no HTTP(S) site.

Choose **Apply and pause agents** to save. This immediately fences input, uses
the existing native-control cleanup, retires old epochs, then persists the new
settings. It leaves automation paused. Resume in the popup and explicitly begin
a new agent turn; saving or resuming never replays earlier work. A failed cleanup
does not install new settings. An unconfirmed/failed settings write blocks access
and cannot be treated as a successful save. An unresolved native storage call
still has the existing unknown-write limitation, rather than an invented rollback.
After the actual storage write rejects, the popup offers **Review unsaved
settings** and **Retry save and keep paused**. The displayed candidate is labeled
**Not saved**. Retry saves exactly that candidate at the next revision; it cannot
submit a different draft. Existing drafts are preserved until explicit review.
A newly opened popup can display the failed candidate directly for review.
Both successful and failed save attempts refresh the automation status display.

Only a settled write failure enables retry. A pending write, observer timeout,
failed startup read or corrupt persisted state cannot grant retry authority.
Concurrent changes remain busy until the actual operation settles; a late success
does not resume agents. Stale or repeated retry requests cannot write again.
Startup reads use the separate, read-only recovery action described below.
Reloading the extension reads its durable settings and restores the control
startup checks; it does not prove the outcome of an unresolved write.

Only the live extension action popup can change settings. Content scripts,
ordinary tabs displaying popup.html and public RPC method names cannot use the
setter, retry, read-recovery or invalid-replacement endpoint. The sender must have the extension ID and exact popup URL, no tab sender,
and a matching live `POPUP` context; if Chrome supplies a document ID it must
match too. Tested Chromium popup senders may omit that optional ID. Storage is
restricted to trusted extension contexts. Saves advance the durable revision;
trusted saves and retries also require the current worker-local generation, so
stale drafts cannot overwrite a newer confirmed revision or a replacement in a
new generation. The generation is not persisted in the v1 record. Startup and failed
reads are closed until the state is known, not implicitly allow-all.

## Startup read recovery

If the initial settings read fails, the popup shows **Unavailable** and a
**Saved settings not loaded** placeholder. It does not display the unconfirmed
initial all-websites value as saved settings. After the original read has
settled, choose **Read settings again and keep paused** to make one new attempt.
**Check saved settings** and periodic status refreshes only query cached status;
they never issue another storage read or recover automatically.

The trusted popup sends `RECOVER_SITE_ACCESS_POLICY` with only the observed
`expectedRecoveryId`. A failed read has an opaque ID identifying that attempt;
starting its replacement consumes the ID, and another actual failure receives
a new ID. Status exposes the following read states separately from failed-write
`retryable` candidates:

| State | Meaning | Recovery action |
| --- | --- | --- |
| `recovery: {state: "pending"}` | Original access setup or read is still unresolved | No ID, no retry |
| `recovery: {state: "read-error", id}` | The actual read path rejected or returned an invalid response envelope | One explicit reread of the current failure |
| `recovery: {state: "invalid", id}` | The read completed with an invalid saved record | Explicit reread or reviewed replacement |
| `ready: true`, no `recovery` | A valid saved record or confirmed absence was read | Ordinary review and editing |

The backend withholds recovery IDs while another policy transition is active or
core control startup is unavailable. A caller timeout does not settle a native
operation or create retry authority. GET does not rotate IDs. Startup failures
in other control stores are not bypassed by this policy-specific recovery.
The input startup barrier and the read-recovery barrier are separate: requests
waiting for startup can reject and release their reservations while the actual
Pause drains. Recovery IDs remain hidden until that Pause settles. This avoids
a circular wait without omitting any real in-flight work from cleanup.

Each recovery first uses the existing global Pause: fence input, drain original
native work and retire old control epochs. Only confirmed cleanup permits the
read. If trusted storage-access setup itself previously rejected, the explicit
recovery may prepare it again; unresolved setup remains a single operation.
The Pause and read share the original bounded transition deadline. An observer
timeout leaves the actual operation tracked and blocks another transition until
it settles. A late read result never resumes agents or replays their work.
This deadline bounds the caller's wait. Once access setup for the read attempt
has begun, its late success can still continue that attempt's single storage
read under the same token, without a new budget. A Pause that finishes after
the deadline does not begin the read at all.

A successful read preserves the stored policy and its revision without writing
the policy key. The popup reports that settings were reloaded, not saved, and
agents remain paused. Resume and a new agent turn are still explicit actions.
Confirmed absence (`stored: false`) uses the compatible fresh-start default:
all websites at revision zero, labeled **Default** with **No saved settings**.
It does not create a saved record. Invalid or unreadable data is never converted
to that default.

The reread action does not delete, reset or replace corrupt data. A successful
read rotates the runtime generation and may establish a lower revision after an
external repair or confirmed removal. Worker construction also creates a new
generation. Status responses preserve request ordering, and revision ordering
applies within a generation. Dirty drafts are preserved; changed generation,
revision or policy contents requires review before a later save. These checks
do not provide an atomic compare-and-swap against external storage changes.

A failed or lost recovery reply requires checking current status before another
attempt. There is no automatic resend. A current settled failure may then offer
its observed ID again; a completed read or an unresolved operation grants no
new recovery action.

## Replacing a corrupt record

After a completed read confirms a corrupt saved record, choose **Choose
replacement settings**. This opens a separate local draft with no mode selected.
Choose the desired mode and exact origins, review the displayed permission
effect, then choose **Replace and keep paused**. Cancel restores the ordinary
draft; starting replacement never copies an unknown value or silently selects
All websites. Unreadable storage, pending operations and independent control
startup failure cannot authorize this action.

The trusted popup sends `REPLACE_INVALID_SITE_ACCESS_POLICY` with the explicit
policy and the observed `expectedRecoveryId`. Reread and replacement share one
single-use failure ID. Replacement pauses and drains control, rotates the runtime
generation, and saves a v1 record at revision one. The original deadline is checked
immediately before native storage dispatch. A late dispatched write stays tracked
until real settlement; it cannot be canceled, replayed or treated as saved early.
A real rejection exposes only the frozen candidate for explicit review and retry.
Success leaves agents paused and old task epochs invalid.

Ordinary `SET_SITE_ACCESS_POLICY` and `RETRY_SITE_ACCESS_POLICY` require both
`expectedGeneration` and `expectedRevision`. The worker checks generation before
Pause and checks the pair again in the storage queue. A lost popup reply requires
a fresh status check; it never triggers another replacement or Resume. The v1
durable format remains exactly version, revision, mode and origins, allowing a
new worker to read it while issuing a fresh generation to its own popup.

## Restricted document control

In either restricted mode:

- Top-level current/pending URLs and **every active frame** must be allowed.
  One denied iframe blocks the entire tab, including page screenshots and root
  snapshots. `webNavigation.getAllFrames` inspects same-process and cross-process
  documents independently of the locator-selected frame.
- Frame trees are bounded to 1,000 entries and must contain one valid root,
  unique IDs, complete acyclic parent chains, active lifecycle and no error.
  Unknown, inaccessible, `data:`, `blob:` and other opaque documents are refused.
  Exact child `about:blank`/`about:srcdoc` follow their validated parent as a
  policy rule; this does not claim a browser security-origin proof for sandboxed
  frames. Top-level blank documents can only bootstrap navigation, never supply
  reads, screenshots or input. An arbitrary blank popup cannot be claimed.
- Navigation events revoke control on a denied destination and cancel engine
  waits, transfer state and the debugger attachment. Explicit `goto` destinations
  are checked before dispatch. Each CRX native command and returned browser action
  rechecks document permission; a generation/revision/navigation proof prevents a stale
  asynchronous inspection from authorizing the next command.
- If an allowed frame commits during an otherwise valid inspection, only the
  read-only tab/frame snapshot is repeated, at most eight times within the same
  original 1,000ms deadline. Policy changes, real revocation and invalid or denied
  snapshots are never retried. Late reads cannot publish a proof or clear revoked
  control after timeout. Input is not replayed. Recovery of already-revoked control
  still requires one stable snapshot.
- Existing semantic locators, snapshots, screenshots and navigation browser
  actions remain available. The native selector parser rejects custom engines,
  React/Vue object traversal and unknown internal control commands; ordinary
  text/CSS/XPath literals keep their native meaning. Capture refs retain their
  existing lifetime checks.
- Native dialog decisions check the complete frame tree and the original
  browser-issued emitter URL/frame identity. Policy generation and revision
  remain fixed throughout the wait; selected document authority is checked at
  native dispatch and after actual cleanup before returning content. Opaque
  or unproven inherited emitters fail closed. Cancellation can drain its exact
  owned subscription without a new site inspection. See [native dialogs](native-dialogs.md).
- Arbitrary public CDP, clipboard, WebMCP, network waits/diagnostics, file choosers,
  direct downloads, the standalone cursor command and their result channels are unavailable. Raw CDP event
  notifications are suppressed. These channels can refer to origins outside the
  live document tree and have not been certified for this restricted mode.
- PDF page export uses the same complete-frame permission checks before native
  commands and final delivery. MHTML export is rejected because its captured
  resources can extend beyond those document origins. See [page exports](page-exports.md).
- Tab listings and history omit disallowed origins. Session cleanup can still
  release owned resources. Policy changes never activate, move or close tabs.

Call the public `browserAction` interface (or a SDK's Playwright facade) for the
supported operations. A convenience SDK method implemented with raw CDP, such as
`evaluate`, is intentionally rejected with `OBU_SITE_ACCESS_UNSUPPORTED`.
`getInfo.metadata.siteAccess` reports version, mode, readiness and restrictions.
Neither a client nor a page can relax the policy through a browser RPC.

## Limits and verification

This is **agent document-access control**, not a website network firewall or a
sandbox for hostile local clients. Links, redirects and back/forward may load a
denied site before navigation events revoke automation. Existing requests,
service workers, websockets, page scripts and already-delivered input are not
rolled back. Allowed pages can themselves display or copy data fetched from
another origin; this feature does not classify the provenance of that data.
Browser event delivery and the native command are not an atomic renderer
transaction. The extension's ordinary content components and granted browser
permissions are not removed by choosing a mode.

The frame, persistence, popup and backend tests cover malformed state, stale
revisions, denied/OOPIF trees, origin confusion, forged setters and policy changes
during input. The real-browser fixture uses an isolated profile and controlled
origins with the production extension, public SDK calls and an actual action
popup; its evidence is recorded in the active parity plan and acceptance results.
It does not replace all browser/platform installation or full Codex comparisons.

The save-retry fixture also targets one private-profile `storage.local.set` with
an oversized test argument. It preserves the original native Promise and verifies
the browser's quota rejection and unchanged durable value. Disabling this
controlled fault and clicking Retry must produce a second, successful native
write of the same candidate, with a new revision and paused control. Explicit
Resume/new-turn then submits exactly one trusted action from the original page.
This is controlled native failure injection, not evidence of a spontaneous quota
failure. Pending/late-settlement races are separately covered by deterministic
backend tests, not claimed as native failures.

Startup recovery has deterministic policy, popup and backend coverage for
settled read failures, corrupt data, pending operations, stale IDs and replies,
core-startup admission, Pause failure, confirmed absence and preservation of
drafts. The dedicated isolated-browser fixture lets the original
native storage read fulfill, retain that actual result, then reject one derived
startup delivery. It checks explicit popup recovery, unchanged durable policy,
paused control and a subsequent original-page action only after explicit
Resume/new-turn. This is a controlled delivery failure, **not** a native storage
rejection or evidence of a naturally occurring browser failure. Focused
`yU2VGw` passes 2/2 with actual exit 0 and unchanged source/runtime hashes.
The original read and its retry preserve the same restrictive revision, with
zero policy writes; the original form submits once after explicit Resume and
a new epoch. The two observed focus events belong to the intentional action
popup opening under the existing exact-context matcher; page input receives
no focus exception. Final Node checks pass 3,137 tests with one existing Windows
file-symlink privilege skip. Related `GT3npA` passes 8/8 with actual exit 0;
it borrows the already-open policy popup and includes all five screenshot-drain
variants. The earlier `8Fe9ev` complete run retains 146/148 and actual exit 1:
the high-level screenshot wire budget was legitimately 999 ms, and Chromium
refused a third popup opening in an inactive window. Correct only the remaining
budget oracle and popup reuse; do not change screenshot execution or restore
window focus. Final complete `O0mB6k` passes 148/148, actual exit 0 and no source
or runtime drift, preserving the previous 147 case names and order. Its
430,422 ms focus interval contains only the original 12 exact sole-tab
activations and four intentional control-popup focus events; the borrowed
recovery popup adds none. Ordinary installation and full capability parity
remain separate acceptance work.

Invalid replacement has separate native evidence: focused `cnAeAG` passes 4/4
with actual exit 0 and unchanged source/runtime hashes. The fixture writes an
explicitly malformed private-profile record and restarts the worker. A transparent
observer retains the original successful native read, one replacement write and
its actual ACK without changing arguments or Promises. The borrowed popup starts
with no selected mode, chooses a restrictive allow list, persists exact v1, rejects
the old failure ID and remains paused. Explicit Resume/new-turn then makes one
trusted original form POST, retaining document/node identity and raw receipt
bytes. This is controlled corrupt-data setup, not a claim of spontaneous browser
corruption. Policy/GUI/backend tests also cover unknown reads, core startup,
late Pause/write settlement, deadline before dispatch, generation ABA and ordinary
draft preservation. Node checks pass 3,187 with one existing Windows symlink
privilege skip. Complete `k3A9Lo` passes 150/150 with actual exit 0 and no
source/runtime drift, retaining the previous 149 case names and order. The
444,495 ms observer interval retains only the existing 12 exact activations and
four control-popup focus allowances. Ordinary installation and overall parity
remain separate acceptance work.

Restricted native-dialog acceptance is recorded in the
[dialog contract](native-dialogs.md#verification) and
[completed plan](../exec-plans/completed/2026-10-14-restricted-native-dialogs.md).
Focused `cin0qm` passes 10/10 and complete `BNmZJb` passes 156/156 with actual
exit 0, unchanged source/runtime identities and no new focus allowance. The
real allowed-child commit race is retained as a failing passive diagnostic;
its fix is bounded read-only reinspection, never input replay. Actual policy
confirmation/readback and Pause/Resume are checked, without a separate
storage.set call-count observer. Ordinary installed-browser acceptance remains
open, and beforeunload's native activation is not resolved by this slice.

Primary API references checked for this implementation:

- [Chrome webNavigation](https://developer.chrome.com/docs/extensions/reference/api/webNavigation): frame inventory, document lifecycle and navigation ordering.
- [Chrome debugger](https://developer.chrome.com/docs/extensions/reference/api/debugger): target sessions and debugger capabilities; host permissions alone are not this policy.
- [Chrome storage](https://developer.chrome.com/docs/extensions/reference/api/storage#method-StorageArea-setAccessLevel): trusted-context storage access.

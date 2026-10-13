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
setter, retry or read-recovery endpoint. The sender must have the extension ID and exact popup URL, no tab sender,
and a matching live `POPUP` context; if Chrome supplies a document ID it must
match too. Tested Chromium popup senders may omit that optional ID. Storage is
restricted to trusted extension contexts. Saves advance the durable revision;
stale drafts cannot overwrite a newer confirmed revision. Startup and failed
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
| `recovery: {state: "read-error", id}` | The actual read path rejected | One explicit reread of the current failure |
| `recovery: {state: "invalid", id}` | The read completed but the stored value is invalid | Reread only; no reset or replacement |
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

Corrupt records remain blocked unless an external repair makes a later explicit
read valid. This action does not delete, reset or replace corrupt data, and it
does not provide an external-storage compare-and-swap or policy-generation
repair protocol. An explicit successful recovery, or a subsequent fresh status
check confirming its lost reply, may establish a lower read revision after a
worker change, external repair or confirmed removal. Ordinary GET replies
retain their revision and request-order checks. Dirty popup drafts are preserved;
a changed revision or policy contents requires review before a later save.

A failed or lost recovery reply requires checking current status before another
attempt. There is no automatic resend. A current settled failure may then offer
its observed ID again; a completed read or an unresolved operation grants no
new recovery action.

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
  rechecks document permission; a revision/navigation proof prevents a stale
  asynchronous inspection from authorizing the next command.
- Existing semantic locators, snapshots, screenshots and navigation browser
  actions remain available. The native selector parser rejects custom engines,
  React/Vue object traversal and unknown internal control commands; ordinary
  text/CSS/XPath literals keep their native meaning. Capture refs retain their
  existing lifetime checks.
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

Primary API references checked for this implementation:

- [Chrome webNavigation](https://developer.chrome.com/docs/extensions/reference/api/webNavigation): frame inventory, document lifecycle and navigation ordering.
- [Chrome debugger](https://developer.chrome.com/docs/extensions/reference/api/debugger): target sessions and debugger capabilities; host permissions alone are not this policy.
- [Chrome storage](https://developer.chrome.com/docs/extensions/reference/api/storage#method-StorageArea-setAccessLevel): trusted-context storage access.

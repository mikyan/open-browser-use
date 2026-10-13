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
Startup/corrupt-state recovery still needs separate work. Reloading the extension
restores its last durable settings and paused state, which must be reviewed before
resuming; it does not prove the outcome of an unresolved write.

Only the live extension action popup can change settings. Content scripts,
ordinary tabs displaying popup.html and public RPC method names cannot use the
setter or retry endpoint. The sender must have the extension ID and exact popup URL, no tab sender,
and a matching live `POPUP` context; if Chrome supplies a document ID it must
match too. Tested Chromium popup senders may omit that optional ID. Storage is
restricted to trusted extension contexts. Settings have a durable monotonic
revision; stale drafts cannot overwrite a newer confirmed revision. Startup and
failed reads are closed until the state is known, not implicitly allow-all.

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

Primary API references checked for this implementation:

- [Chrome webNavigation](https://developer.chrome.com/docs/extensions/reference/api/webNavigation): frame inventory, document lifecycle and navigation ordering.
- [Chrome debugger](https://developer.chrome.com/docs/extensions/reference/api/debugger): target sessions and debugger capabilities; host permissions alone are not this policy.
- [Chrome storage](https://developer.chrome.com/docs/extensions/reference/api/storage#method-StorageArea-setAccessLevel): trusted-context storage access.

# Popup ownership and cross-window rendering

Status: observed defect and proposed design, 2026-10-11. The production backend
does **not** implement auxiliary tab ownership described below. This investigation
does not change the current claim protocol, rendering lease, timeout, or SDK.

## What is established

Production disables Playwright CRX's implicit popup attachment. An unclaimed
popup therefore cannot acquire a Page, debugger attachment, or input token merely
because its `openerTabId` names an attached tab. Normal explicit attachment and
owned OOPIF child-session discovery remain available.

There is a separate rendering failure. A native
`window.open(url, '', 'popup,width=500,height=400')` creates a separate popup
window. Current `claimUserTab` adds its tab to the session's existing Chrome tab
group. In the tested Chromium build this moves the tab into the group's normal
window and closes the original popup window. After that move, DOM reads work,
but the shared rendering lease receives no first screencast frame and a public
Playwright click times out at its original 10-second deadline.

The same page is operable before the cross-window move. Preserving its window
also works when that window is unfocused. This is evidence for avoiding the
move, not evidence that an extra rendering command repairs it. The precise
Chromium compositor defect has not been identified.

**Native popup creation still activates its new tab/window. That requirement is
unresolved.** Preserving a popup's original window fixes neither that initial
activation nor the general `target=_blank` foreground behavior. Switching focus
back afterward would not establish that the Agent never interrupted the user.

## Reproduction and observations

Experiments used fresh isolated headed Chromium 156 profiles on Windows, local
fixtures, the public JS SDK, the real Go host, and the built extension. Browser
inspection used a raw worker CDP connection, not Playwright browser pages. No
OS mouse/keyboard input, tab activation, background-throttling disable flags,
synthetic screencast frames, or focus-restoration workaround was used. Native
popup activation was recorded rather than hidden. Temporary host connections
used the integration harness's test-only native-message adapter; these runs did
not register or modify a user's native host. Test processes and windows were
closed in harness cleanup.

The ignored local evidence files below are investigation artifacts, not required
repository inputs. A harness `PASS` in these observational runs only means that
the trace was collected: the `click.ok` field records the actual action outcome.

| Experiment | Actual result | Local evidence under `.tmp/browser-integration/` |
| --- | --- | --- |
| Production claim moves native popup into the normal task window | All CRX initialization completes; `Page.startScreencast` succeeds; no frame arrives before the 10 s click deadline | `run-eQAeKo/trace-early.json`, `trace-final.json` |
| Concurrent native `Page.captureScreenshot`, normal surface capture | Capture itself remains pending until timeout detaches the target; no image or click | `run-zt8bBz/recovery-capture.json` |
| Native surface capture with an explicit viewport clip | Same failure; no frame or click | `run-ixb9gB/recovery-capture-clip.json` |
| Keep the live stream but omit only the initial frame wait in a staged test build | Playwright advances to `Runtime.callFunctionOn`, then stalls before input; click still times out | `run-L5KKfy/recovery-skip.json` |
| `Page.setWebLifecycleState({state:'active'})` | Command succeeds; no frame or click | `run-YYk8GO/recovery-lifecycle.json` |
| Set device metrics to the original dimensions, or perturb width by one CSS pixel | Neither restores a frame; overrides are cleared afterward | `run-cjG6Fo/recovery-metrics.json`, `run-VCtc6z/recovery-metrics-resize.json` |
| Start focus emulation and screencast before moving | No frame had arrived before the immediate move, so this alone does not establish a successful prewarm; later click fails | `run-FXWxmd/recovery-prewarm.json` |
| Test-only explicit auxiliary claim preserves the native popup window | Public click succeeds in 94 ms, two real screencast frames, DOM result changes | `run-WQMnu4/recovery-preserve.json` |
| Same preservation first, then the production group move | First public click succeeds in 98 ms; after moving that same already-rendered page, the next click times out in 10 s with zero frames | `run-Trbjke/recovery-warm-and-move.json` |
| Create an independent test popup with `focused:false`, explicitly claim without moving it | Public click succeeds in 169 ms, three real frames and trusted pointer/click events; original normal window remains focused, popup remains unfocused | `run-JTq5Oy/recovery-preserve-background.json` |

The last three runs modify only a staged copy of `claimUserTab` and
`getSessionTabs`: an explicit claim records a temporary auxiliary membership
instead of grouping that tab. Public action admission, epoch checks, attachment
hooks, input tracking, and the complete rendering lease still run. This small
POC is not a production ownership implementation and does not test its races or
persistence.

For the final background-window control, `windows.onFocusChanged` remains empty.
Chrome emits a tab-activation event for the sole tab in the newly created popup
window; the existing normal-window sentinel is never switched. That distinction
must remain visible in future tests. Debugger UI can change the available page
viewport; preserving the window does not promise pixel-identical inner height.

After the failing move, the normal window is already focused, the sentinel is
active, and the child tab is inactive, not discarded or frozen. Focus emulation
makes the document report visible and focused, yet its animation-frame counter
advances only about three to four times over the whole 10-second failure. Thus
checking `visibilityState` or `document.hasFocus()` is insufficient proof that
the rendering surface is usable. The failed metric/lifecycle/capture attempts
should not be promoted into production retries.

## Smallest complete ownership change

Keep ordinary task tabs in their current Chrome group. When an explicit
`claimUserTab` targets a tab in a separate `window.type === 'popup'`, preserve its
window and record an auxiliary owner instead of moving it. No new implicit
ownership may be inferred from URL, opener, timing, or `tabs.onCreated`. The
existing public claim method is sufficient; normal-window claims retain their
existing behavior.

Put this membership rule behind one ownership-store interface rather than
adding popup exceptions to each command. A record needs only an opaque claim
identity, session ID, tab ID, original window ID, `origin:'user'`, and pending or
committed phase. Explicitly claimed popups are user-origin tabs even if an Agent
caused the page to open them; that avoids inventing permission to close them.
Keep a reverse tab-to-owner index, reject conflicting owners, and cap the
collection before accepting a claim. A proposed initial bound is 256 auxiliary
tabs across all sessions, with no silent eviction of a live claim.

Use `chrome.storage.session` with trusted-context access for these extra tab
identities. It survives service-worker suspension but is cleared by extension
reload/update/disable and full browser restart. Requiring a new explicit claim
after those boundaries is safer than reviving a bare tab ID in `storage.local`;
Chrome can reuse IDs across browser sessions. This is a proposed persistence
choice, not an already tested recovery guarantee. [Chrome storage reference](https://developer.chrome.com/docs/extensions/reference/api/storage#property-session)

### Listing and command admission

- `getTabs` unions the current task-group members with committed auxiliary tabs,
  deduplicates by tab ID, and retains the existing logical-active semantics.
  Listing must not move tabs, focus windows, or implicitly attach a Page.
- `requireSessionTab` consumes that same authoritative result. It revalidates
  the live tab, its pending/current URL, and own-extension protection before
  permitting an action. Raw target normalization, downloads, chooser state,
  cursor updates, and scoped notifications must use the same owner resolution.
- `claimUserTab` checks both normal-group ownership and the auxiliary reverse
  index. A different session cannot take an auxiliary tab merely because its
  native `groupId` is `-1`. Concurrent claims for the same tab serialize across
  sessions; only one can commit. Same-session repeat claims are idempotent.
- A missing primary task group must not erase otherwise valid auxiliary
  ownership. Similarly, a transient Chrome inventory failure is not evidence
  that a tab was closed; strict release must fail closed.
- If the user moves an auxiliary tab to another window or another task group,
  quarantine its claim before another command can attach. Cancel and release
  the old exact attachment, then require a fresh explicit claim. Do not drag it
  back or silently let the old session override a foreign group. The same-session
  primary-group migration can later be optimized after this conservative rule
  has real regression coverage.

### Claim atomicity, end, and Pause

Reuse the existing session mutation/admission tracker and add a per-tab claim
reservation. Register the pending claim before its first asynchronous operation;
Pause and session end must see it even before there is a debugger attachment.
Capture the submitting epoch and global control revision. Check both after every
Chrome/storage await and immediately before publishing membership or attaching.

A pending record cannot authorize a command. Persist a pending reservation,
revalidate the live target and control state, then publish the owner at one
synchronous commit point. Track the following committed-state write as part of
that same mutation; other operations on this tab wait for its durable result.
On failure, remove only the exact claim identity, never a successor's record.
Unresolved pending records recovered after worker restart cannot grant control.
Persistence failure must remain visible and block the affected claim rather
than returning a usable tab.

If Pause/end wins before that commit point, the claim is cancelled. If claim
commits first, Pause/end includes it in cancellation and release even if its
response has not yet reached the caller. Pause blocks admission synchronously,
retires the old epoch, and drains pending claims plus actual native input and
attachment work within the existing bounded cleanup budget. A late claim write
cannot reopen the gate, start attachment, publish an old cursor, or make an old
request succeed. Preserve the existing fail-closed storage/cleanup limitations
in [control lifecycle](control-lifecycle.md); this design does not make Chrome
operations and storage transactional.

Auxiliary membership and active control are separate. `turnEnded` releases Page,
raw input, streams, waiters, diagnostics, and cursor activity for the union of
group and auxiliary tabs. It retains committed membership for a later explicit
`beginTurn`, just as the current task group is retained. Pause retains membership
but invalidates control. Resume never replays a pending claim or action.

`releaseSessionControl` must include committed and pending auxiliary claims as
well as its existing attachment/engine/input inventories. It must not depend on
the popup still appearing in a Chrome group. A failing cleanup retains the old
claim/attachment identity for retry; it must not erase ownership and permit a
new session to attach over uncertain held input.

### Finalization and closed windows

For an auxiliary user-origin tab omitted from `finalizeTabs.keep`, detach and
release membership while leaving the tab and its window open. `handoff` keeps
the original window and membership, with active control ended. Do not call
`tabs.ungroup` or `tabs.move` for a group-less auxiliary tab.

The initial implementation should reject `status:'deliverable'` for an auxiliary
popup during validation, before ending the epoch or mutating any tabs, with a
clear instruction to use `handoff`. Current deliverable grouping cannot preserve
that window's native popup semantics. A later window-preserving deliverable
representation needs its own contract; silently moving it would reintroduce the
observed defect. Ordinary grouped deliverables remain unchanged.

`tabs.onRemoved` removes only the matching claim and confirms destruction to
the existing input/attachment cleanup. Closing the whole popup window must do
the same for every claimed tab. Test close-during-claim and close-during-attach;
an awaited write must not resurrect the closed tab. A window removal event alone
must not delete a newer record for a tab that has been moved elsewhere. Live
lookup and exact record identity decide cleanup.

After a worker restart, load the auxiliary store before membership admission;
revalidate live tab/window identity and finish existing epoch recovery before
new control. After full browser or extension restart, the empty session store
means old auxiliary IDs grant no ownership. Preserve the existing persistent
Pause intent and unresolved-input recovery rules independently of this store.

## Required acceptance before implementation is called complete

Use the ordinary production build and public SDKs, with a separate sentinel and
real worker/native observations. Cover native popup read/click/screenshot before
and after explicit claim without changing window ID, and an already unfocused
popup. Record native popup's initial foreground activation as a known failure;
do not relabel that case as a no-focus success.

Also cover two-session concurrent claim; foreign tab and target-ID denial;
normal owned OOPIF behavior; claim racing Pause/end, storage delay/failure, and
tab/window closure; successful release with no late attachment; worker restart
versus full browser/extension restart; handoff and release finalization; explicit
deliverable rejection without partial mutation; and no stale ownership after
external movement. Supply deadlines throughout and do not repeat a timed-out
click. The test-only in-memory membership POC above establishes none of these
lifecycle guarantees by itself.

The separate serial-queue issue with `Promise.all([waitForURL(...), click()])`
also remains open: a wait submitted first occupies the tab queue and prevents
its trigger from running. Fixing auxiliary ownership must not be described as
fixing navigation wait registration or native popup foreground behavior.

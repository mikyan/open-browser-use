# Popup ownership and cross-window rendering

Status: auxiliary ownership is implemented and has passed the scoped native
acceptance below, 2026-10-11. A fresh isolated Windows Chromium 156 run completed
all 38 formal cases, including the Go caller. The earlier investigation remains
separate evidence of the rendering defect. Native page-created popup focus and
full browser/extension restart are still outside the verified boundary. The
existing public `claimUserTab` API is retained;
`getInfo.metadata.auxiliaryTabsVersion` advertises version 1.

## What is established

Production disables Playwright CRX's implicit popup attachment. An unclaimed
popup therefore cannot acquire a Page, debugger attachment, or input token merely
because its `openerTabId` names an attached tab. Normal explicit attachment and
owned OOPIF child-session discovery remain available.

There is a separate rendering failure. A native
`window.open(url, '', 'popup,width=500,height=400')` creates a separate popup
window. Before auxiliary ownership, `claimUserTab` added its tab to the session's
existing Chrome tab group. In the tested Chromium build this moved the tab into
the group's normal window and closed the original popup window. After that move,
DOM reads worked, but the shared rendering lease received no first screencast
frame and a public Playwright click timed out at its original 10-second deadline.

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
| Previous production claim moves native popup into the normal task window | All CRX initialization completes; `Page.startScreencast` succeeds; no frame arrives before the 10 s click deadline | `run-eQAeKo/trace-early.json`, `trace-final.json` |
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

## Implemented ownership boundary

Ordinary task tabs remain in their Chrome group. When explicit `claimUserTab`
targets a group-less tab in `window.type === 'popup'`, the backend records an
auxiliary owner and preserves that window. It does not infer ownership from URL,
opener, timing or `tabs.onCreated`. Normal-window claims retain the group-based
path. This feature neither creates a popup nor changes native `window.open`.

`apps/chrome-extension/auxiliary-tab-ownership.js` owns the reverse tab index,
per-tab serialization and durable state. A record contains opaque `claimId`,
session/turn, tab ID, original window ID, admitted epoch/control revision,
`origin:'user'`, and its phase. Reserved, pending and quarantined records cannot
authorize a command. Explicitly claimed popups remain user-origin even when
an Agent caused the page to open them; omission from finalization never grants
permission to close them. The limit is 256 records across all sessions, including
temporary normal-tab reservations and failed claims awaiting cleanup. Live
ownership is never silently evicted to make room.

The injected storage area is `chrome.storage.session`; initialization explicitly
sets `TRUSTED_CONTEXTS` access. Key `OPEN_BROWSER_USE_AUXILIARY_TABS` holds a
versioned record list, separate from the ordinary session store and control
ledger. Session storage survives service-worker suspension but is cleared by
extension reload/update/disable and full browser restart. Requiring a new explicit claim
after those boundaries is safer than reviving a bare tab ID in `storage.local`;
Chrome can reuse IDs across browser sessions. Unit tests model an empty session
store at this boundary; full native browser/extension restart is not yet an
acceptance claim. [Chrome storage reference](https://developer.chrome.com/docs/extensions/reference/api/storage#property-session)

### Listing and command admission

- `getTabs` unions the current task-group members with committed auxiliary tabs,
  deduplicates by tab ID, and retains the existing logical-active semantics.
  Listing does not move tabs, focus windows, or implicitly attach a Page.
- `requireSessionTab` consumes that same authoritative result. It revalidates
  the live tab, its pending/current URL, and own-extension protection before
  permitting an action. Raw target normalization, downloads, chooser state,
  cursor updates, and scoped notifications use the same owner resolution.
- `claimUserTab` checks both normal-group ownership and the auxiliary reverse
  index. A different session cannot take an auxiliary tab merely because its
  native `groupId` is `-1`. A competing pending claim is rejected immediately;
  commits and removals for one tab serialize. A same-session repeat of durable
  committed ownership is idempotent and revalidates the live target.
- A missing primary task group does not erase otherwise valid auxiliary
  ownership. Similarly, a transient Chrome inventory failure is not evidence
  that a tab was closed. Strict release fails on uncertain inventory; ordinary
  listing can omit temporarily unavailable tabs without deleting their records.
- If the user moves an auxiliary tab to another window or another task group,
  the group/detach event and live tab validation quarantine its claim. Cleanup
  releases the old attachment before deleting that exact ownership identity;
  a fresh explicit claim is required afterward. The tab is not moved back, and
  a foreign task group cannot override an unresolved old cleanup lock. Rendering
  recovery after an external cross-window move is outside this implementation.

### Claim atomicity, end, and Pause

Every `claimUserTab` reserves its tab before `controlReady` or the first await,
including normal-window claims. After ordinary admission, the backend captures
the actual ledger epoch and global control revision, so legacy requests are
still supported without bypassing the later checks. Claim stages recheck the
reservation and control binding after Chrome/storage awaits. Session mutation
and global cleanup snapshots include these reservations before any attachment.
The normal-window path drops its transient reservation without persisting
auxiliary membership.

For a popup, the store persists `pending`, revalidates its live tab/window/group
and control state, then changes phase at one synchronous commit point. Membership
is exposed by `owner`/`list` only after the following `committed` write succeeds.
Other operations on that tab wait for the corresponding queue/write. A failure
quarantines the exact identity; only successful cleanup and durable removal free
the reverse lock. Quarantine is itself persisted, including when removal has not
started. Cleanup can release native input while that storage write is pending,
but deletion cannot overtake it. Recovered pending records are dropped, recovered
quarantine stays blocked, and malformed/unreadable storage fails closed.

If Pause/end wins before that commit point, the claim is cancelled. If claim
commits first, Pause/end includes it in cancellation and release even if its
response has not yet reached the caller. Pause blocks admission synchronously,
retires the old epoch, and includes pending claims plus actual native input and
attachment work in its existing bounded cleanup budget. A late claim write
cannot reopen the gate, start attachment, publish an old cursor, or make an old
request succeed. Preserve the existing fail-closed storage/cleanup limitations
in [control lifecycle](control-lifecycle.md); this design does not make Chrome
operations and storage transactional.

The claim RPC has a 10-second response timeout. It does not cancel a native
storage promise: the real write and mutation stay tracked, and a pending claim
is revoked before it could publish a late result. If storage never settles,
Pause reaches its bounded failure response and remains blocked. The existing
`turnEnded`/finalization mutation drain has no independent timeout and can remain
pending on that write; it finishes only after the underlying operation settles.
This implementation does not claim bounded turn-end completion or cancellation
of Chrome storage operations.

Auxiliary membership and active control are separate. `turnEnded` releases Page,
raw input, streams, waiters, diagnostics, and cursor activity for the union of
group and auxiliary tabs. It retains committed membership for a later explicit
`beginTurn`, just as the current task group is retained. Pause retains membership
but invalidates control. Resume never replays a pending claim or action.

`releaseSessionControl` includes committed/pending popup records and matching
attachment owners even without a primary group. A transient normal-tab
reservation that has not passed ownership validation does not authorize
detaching a foreign session's attachment. Failed cleanup retains the original
claim/attachment identity for retry; it cannot hand uncertain held input to a
successor owner.

### Finalization and closed windows

For an auxiliary user-origin tab omitted from `finalizeTabs.keep`, the backend
detaches and releases membership while leaving the tab/window open. `handoff`
keeps the original window and membership with active control ended. These
dispositions do not ungroup or move a group-less auxiliary tab.

The implementation rejects `status:'deliverable'` for an auxiliary
popup during validation, before ending the epoch or mutating any tabs, with a
clear instruction to use `handoff`. Current deliverable grouping cannot preserve
that window's native popup semantics. A later window-preserving deliverable
representation needs its own contract; silently moving it would reintroduce the
observed defect. Ordinary grouped deliverables remain unchanged.

`tabs.onRemoved`, including its events when the whole popup window closes,
retires the matching claim and confirms target destruction to input/attachment
cleanup. `onReplaced` retires the removed tab; live lookup also handles a confirmed
missing tab. There is no blanket window-ID deletion of newer records. A delayed
claim/attachment or cleanup must still match the original record identity.

Worker startup waits for the auxiliary store before admission and performs the
existing epoch recovery; subsequent membership reads validate live tab/window
identity. An empty session store grants no auxiliary ownership from IDs left in
local session state. Persistent Pause intent and unresolved-input recovery remain
separate from auxiliary membership.

## Acceptance scope and current native evidence

The current store/backend unit suites exercise concurrent claims, storage
failure/delay, claim racing end/Pause/closure, identity-fenced removal, foreign
attachment protection, quarantine/recovery and finalization. These deterministic
tests do not establish native rendering or focus behavior.

The formal harness now contains `js-auxiliary-popup-rendering` and
`js-auxiliary-popup-lifecycle`, plus auxiliary membership checks in worker-restart
and global-Pause cases. It creates independent real popup windows with
`chrome.windows.create({type:'popup',focused:false})`. The first post-claim engine
action is one trusted click with a 10-second deadline, followed by a screenshot,
OOPIF input and a network wait. It also checks foreign tab/target denial,
concurrent claims, handoff/omission/deliverable handling, external movement,
closure and preservation of window identity.

The fresh headed Windows Chromium 156 run
`.tmp/browser-integration/run-hpWHwC/results.json` records **38/38 passed**,
including both auxiliary cases and the worker-restart/global-Pause extensions.
Its first claimed-popup click completed in 98 ms and produced exactly one trusted
click. The saved `auxiliary-popup.png` is 759 × 495 pixels, matching its recorded
506 × 330 CSS viewport at DPR 1.5; the original group-less popup window stayed
unfocused. The same case passed native OOPIF input, scoped network waiting and
foreign target denial. Concurrent claims had one winner and one explicit
`OBU_AUXILIARY_CLAIM_CONFLICT`. Handoff, release without closing, external-move
revocation and closed-window cleanup passed through public APIs.

That run retained all five auxiliary sole-tab creation activations with their
exact tab/window identities and reasons in `allowedPopupActivations`. The raw
focus list was `[1951251390, -1]`; `allowedWindowFocusEvents` binds only indices
0 and 1 to the intentional control-popup opening with timestamps, a reason and
the observed `POPUP` context. There were no unaccounted focus events, the original
sentinel remained active, and worker restart added no activation or focus events.
The Pause case released held pointer/Shift input, rejected old control and
network wait handles, retained auxiliary membership across worker replacement,
and required explicit recovery before another trusted popup click. It did not
replay the network trigger. These results verify the specified unfocused-window
ownership path, not initial focus suppression for a web page's native popup.

Every native activation remains in the evidence. Only the new popup's exact
tab/window pair may emit its single creation activation; later activations are
not permitted. The sentinel must stay active, and automation must not change
window focus through claims, actions, cleanup or worker replacement.

The final Pause case intentionally opens the extension's real control UI with
`chrome.action.openPopup`. In the diagnostic run
`.tmp/browser-integration/run-H1wa7J/pause-focus-trace.json`, raw focus events
were empty immediately before that call, then became exactly
`[originalSentinelWindowId, -1]` with a live `POPUP` context. They did not grow
during the actual Pause, worker restart, Resume, auxiliary click or closure.
This is evidence about the intentional test UI opening, not an automation-focus
exception. The acceptance contract retains the raw events and permits only this
UI-open sequence through an explicit event-index ledger with a recorded reason.
It does not allow these window IDs globally, discard earlier events or excuse
later focus changes. That earlier diagnostic run is not itself a full-suite pass;
the subsequent complete result is recorded above.

The suite neither creates a passing renderer `window.open` case nor claims
native initial-focus suppression. Full browser/extension restart remains a
separate acceptance task. See the [harness contract](../../scripts/browser-integration/README.md).

The separate serial-queue issue with `Promise.all([waitForURL(...), click()])`
also remains open: a wait submitted first occupies the tab queue and prevents
its trigger from running. Fixing auxiliary ownership must not be described as
fixing navigation wait registration or native popup foreground behavior.

## Initial activation: read-only research, 2026-10-11

This review found no public extension/CDP interception contract that preserves
an unchanged trusted click, native popup/opener semantics and zero initial
activation together. It examined **current Chromium main and tip-of-tree CDP**;
these findings are not new browser tests or a claim about every version. The
Chromium 156 observations above remain the measured baseline. Chromium's
[window-show path](https://raw.githubusercontent.com/chromium/chromium/main/chrome/browser/ui/navigator/browser_navigator.cc)
explicitly focuses/activates user-gesture popups. The
[Page.windowOpen event](https://raw.githubusercontent.com/ChromeDevTools/devtools-protocol/master/pdl/domains/Page.pdl)
has no blocking reply or focus override. `Target.createTarget` background/focus
options govern its own new target, not an intercepted native popup; debugger
auto-attach provides an execution pause, not a disposition override
([Target protocol](https://raw.githubusercontent.com/ChromeDevTools/devtools-protocol/master/pdl/domains/Target.pdl)).
Pinned CRX 0.15.0 additionally translates createTarget to extension tab creation
and ignores browser-level auto-attach; production already disables its later
`tabs.onCreated` implicit attachment. Restoring focus afterward cannot meet the
no-interruption requirement.

`windows.create({focused:false})` is useful for independently created windows,
but `setSelfAsOpener` refers to the extension API caller and is rejected from a
service worker; `tabs.openerTabId` sets same-window tab-model ancestry rather
than recreating the original synchronous WindowProxy return
([Windows API](https://developer.chrome.com/docs/extensions/reference/api/windows),
[implementation](https://raw.githubusercontent.com/chromium/chromium/main/chrome/browser/extensions/api/tabs/tabs_api.cc)).
The `window.open` feature string `background` is not a general solution:
[Chromium checks the opener's extension background permission](https://raw.githubusercontent.com/chromium/chromium/main/chrome/browser/chrome_content_browser_client.cc)
and rejects ordinary web content. A limited candidate is native Ctrl/Meta-click:
[Blink's navigation policy](https://raw.githubusercontent.com/chromium/chromium/main/third_party/blink/renderer/core/loader/navigation_policy.cc)
can select a background tab, including for a synchronous scripted window open.
This changes observable modifiers and may change a popup into a tab; it must not
silently replace an ordinary click. The current public locator click already
accepts `Control`, `Meta` and `ControlOrMeta`, so investigation needs no new helper.

| Candidate experiment, not yet run in this review | Required observations and limit |
| --- | --- |
| Native modified click on an observed `target=_blank` link | Record trusted event/modifiers, one trigger, sentinel activation and window focus; compare default noopener with explicit `rel=opener`. At most a deliberate background-link operation. |
| Same modified click with synchronous `window.open` | Check returned WindowProxy, actual opener, bidirectional postMessage, child window type and focus events. A background tab is not proof of preserved popup shape. |
| Microtask and timer variants of that handler | Determine whether the native input disposition survives; do not generalize a synchronous success to deferred page code. |
| Auto-attach with waiting-for-debugger as a negative control | Record activation before and after resume. Pausing JavaScript or eventually restoring the sentinel does not prove absence of initial activation. |

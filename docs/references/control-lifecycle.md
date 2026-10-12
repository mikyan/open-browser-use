# Browser control lifecycle v1

`getInfo.metadata.turnLifecycleVersion === 1` advertises the optional control
epoch protocol. `ping`, `getInfo`, and `getControlState` are the only bootstrap
methods. Every other session operation still requires `session_id` and `turn_id`.
Those IDs are nonempty strings of at most 256 characters.

## Negotiation and normal completion

Call `getControlState({session_id})` before the first protected request. It returns
`{controlEpoch, closing, nextTurnId, lifecycleVersion: 1}`. Send the positive safe
integer as `control_epoch` on each request. Capture the epoch and turn ID when
submitting a request, including requests that later wait in a client queue.
`getControlState` explicitly creates persistent session control state; it is not
a read-only inventory operation.

`turnEnded` and `finalizeTabs` return
`{controlEpoch, nextTurnId, endedTurnId, lifecycleVersion: 1}` after successful
release. The returned epoch and turn ID start the next cycle, including tab
creation, naming, and reattachment. `finalizeTabs` retains its existing `keep`
dispositions; the response adds lifecycle state to its previous void result.
Invalid `keep` entries or an initial tab inventory failure do not end the cycle.

An end request retires the entire current session epoch, including requests with
different turn IDs already admitted in that epoch. A client must never refresh
an epoch and replay an expired action automatically. After a stale-epoch or
uncertain end error, explicit `beginTurn`/`getControlState` recovery is required.
This uses the original connection only while it remains alive. Transport loss
or explicit close ends the SDK client; create a new client and new handles before
beginning a new turn. See [SDK connection identity](sdk-connection-identity.md).
Clients connecting to a server without the metadata flag retain legacy behavior.

## Release and recovery ordering

The extension durably marks the epoch as closing before releasing browser
control. While closing, new requests fail. It cancels Playwright waits, drains
already accepted finite tab creation/grouping/attachment operations, then checks
release again before applying final tab dispositions. Successful release clears
logical active control even when a handoff tab remains grouped. Delayed accepted
operations cannot restore an attachment after the end response.

A debugger or tab inventory error leaves the session closing and retains the
ownership record. A later explicit `getControlState` can retry release; it never
replays finalization dispositions. Parallel bootstrap calls cannot admit a new
cycle while that retry is running. A disposition failure after successful
release is returned as an error; recovery also does not repeat that disposition.

An active epoch is persisted before any request using it is admitted, including
concurrent requests. A storage failure blocks admission. On worker restart,
active epochs receive a new epoch and enter closing; already closing records
remain fenced. Recovery releases control and clears logical activity without
replaying page actions or closing retained tabs. Failed cleanup stays closing.

The epoch protects admission and cancellable engine work, not transactional
rollback. Input already delivered, page JavaScript already scheduled by raw CDP,
and completed external effects cannot be undone. File chooser/download wait
cancellation and attribution are described in [file transfers](file-transfers.md);
clipboard helpers remain separately audited. Release includes retained native
attachments as well as session inventory. Tab movement events synchronously
retire the old attachment and start cleanup; a subsequent explicit claim waits
for that release before reusing the tab.

## Bounded state and legacy callers

The persistent ledger holds at most 64 session records. New epochs come from one
monotonic global counter and are never reset or reused. Bootstrap can evict only
idle records. If all records are active or closing, bootstrap reports capacity
exhaustion until a session releases control. An unknown or evicted explicit epoch
is always stale; it never implicitly creates a session.

Legacy requests that omit `control_epoch` are supported with a bounded ledger of
256 observed turn IDs per session. Ending a session retires every observed ID,
including the end request's ID. Reaching the per-session limit permanently
requires epoch mode for that session. The first session-record eviction also
persists a global prohibition on creating new legacy records, so an evicted
legacy ID cannot silently become valid again. Existing compatible legacy records
remain usable within their bounds.

A never-observed legacy turn ID cannot reveal whether it is a delayed old request
or an intentional new cycle. Strict rejection of that case requires negotiated
epochs. Removing finalized tab state does not remove the control ledger.

## User Pause and Resume

The action popup sends `GET_AUTOMATION_CONTROL_STATUS`, `PAUSE_AUTOMATION`, and
`RESUME_AUTOMATION` extension messages. Resume includes `expectedRevision` from
the displayed status; a stale revision fails instead of replaying a transition.
The status is `{state, inputBlocked, revision, cleanupComplete, error?, inputRecovery?}`, where
`state` is `running`, `pausing`, `paused`, or `error`. The UI labels `error` as
Failed and permits Retry pause, never Resume, until cleanup succeeds.

Pause derives tab cleanup authority from verified control records, not from
the tab IDs submitted in queued requests. A readiness or data-operation
reservation is not permission to detach its source. Network, navigation,
chooser, download and created-page waits, direct downloads, page exports and
clipboard helpers only contribute sources after their control scope is bound.
Chooser setup maps and outstanding export/clipboard operations cannot add
unbound IDs back to the detach set. Real pending attachments remain covered by
the engine, input and attachment registries.

Filtering these tab IDs does not remove the corresponding pending promises.
Pause still invalidates reservations and waits for actual work and cleanup;
an early cancellation reply is not evidence that native work has finished.

The 2026-10-12 authority regression covers seven public entry points at both
synchronous reservation and a held original ownership-query response. Before
the fix, all fourteen cases issued a native detach call for an unowned tab with
no prior attach. After the fix all fourteen pass, preserving that tab and
waiting for the held response before Pause completes. These are production
backend calls against Chrome test doubles, not evidence of harm in a real
profile. Existing bound-source and native-ACK assertions remain in the module
tests. Extension/build/fixture checks pass 1123/1123. The first full run's one
failure was an obsolete unbound-ID expectation; its deadline, capacity and
no-late-attach checks were preserved while updating the authority assertion.

Isolated Chromium regression `eRYJ16` passes the ordinary **125/125** cases,
actual runner exit 0. The **243,654 ms** continuous focus record retains only
the existing twelve activation and four control-popup focus allowances. New
page readiness separately passes `BQyEWc` (2/2, six original children and six
business POSTs, 3,561 ms without recorded focus changes). The full run uses
eight freshly built Go callers and the same verified native host; published
preview archives are unchanged. Normal-profile installation, other platforms
and new-page lifecycle/five-entry acceptance are not established by these runs.
The ordinary suite ends with a browser kill request, not a captured Browser.close
acknowledgement. A subsequent exact-profile process inventory finds no remaining
browser process; the separate readiness run has the explicit close receipt.
The full suite intentionally terminates its first host for the restart test;
the replacement host exits 0.

`inputRecovery` is optional guidance derived from the currently recovered input
risks. It is also included in `getInfo.metadata.automationControl`. It contains
only one of these shapes, with no tab IDs, page details, input values or journal
identifiers:

| Shape | Popup guidance |
| --- | --- |
| `{action: "close-controlled-pages"}` | Save work, close the pages that were being controlled, then choose Retry pause to check whether control has been released. This applies only when every recovered risk belongs to the current extension-loaded session. |
| `{action: "restart-browser", restartMayNeedRepeat: boolean}` | Save work, fully quit this browser, including background processes, then reopen the same profile with the extension enabled and check the control status. Closing tabs or reloading the extension alone is insufficient. A true `restartMayNeedRepeat` warns that an additional full restart may be needed because prior startup evidence is missing. |

These are recovery instructions, not permissions or evidence of completed
cleanup. The field is omitted as soon as no recovered input risk remains,
even if Failed and its earlier error text persist. In that state the popup
offers the ordinary Retry pause step, without continuing to prescribe browser
restarts. Depending on startup event timing, initialization can finish cleanup
and show Paused directly; a further Retry is then unnecessary. Neither path
enters Running automatically. The user must choose Resume control, and the
Agent must explicitly begin a new turn before submitting new work.

Pause immediately blocks admission, cancels queued engine work and rendering
leases, and hides pointer feedback. It persists the pause intent and outstanding
tab IDs before acknowledging cleanup. It invalidates every session epoch,
including idle bootstrap records, and permanently requires negotiated epochs
for all legacy callers. `getControlState` also fails while paused; only `ping`
and `getInfo` remain usable bootstrap RPCs. Resume does not create work, replay
requests, or restore attachments. An Agent must explicitly begin a new turn.

Cleanup shares raw CDP and CRX input state by exact attachment token and native
child session. It waits for native input completion even if the caller already
received an RPC timeout, then releases tracked pointer buttons, keys, touch,
and drag state on the original target. A native debugger detach by itself is
not proof that renderer-held input was released. Failed release retains the
original native attachment for retry; the old request cannot resume input.
Pointer/capture queues are cancelled even if that attachment must be retained.
Every new CRX protocol command, including Runtime-based form mutations, checks
the pause gate and attachment release state. Production teardown closes the
Playwright Page before asynchronous native release instead of waiting for
optional recorder/highlight cleanup. Native cleanup uses its separate direct
send path so blocked automation can still release input.

In an isolated Chromium 156 fixture, raw `dragCancel` retained pointer capture
after a pressed mouse button. It therefore clears drag state but keeps the
button tracked until native `mouseReleased` completes. The corrected Pause
produced trusted `pointerup`/`lostpointercapture` events and cleared capture;
the foreground sentinel stayed unchanged. A normal native release may also
produce a click. Cleanup does not claim to undo application event handlers.

Pause and Resume each have a 10-second deadline starting at message admission,
including time queued behind an earlier transition. Pause immediately clears
the cleanup-complete flag. Its budget also covers storage, pending attachments,
native inputs, and accepted requests. Initial status queries bound their storage
read by the same budget; a stuck read reports Failed and blocks admission, and
a late stored Running value cannot reopen it. Failure or timeout
keeps admission blocked and cleanup unconfirmed. Retry checks the original
pending work instead of treating an empty tracker as successful release. A
successful Pause durably records completion. If persistence fails, the current
worker stays blocked and reports failure; it cannot promise persistence across
a restart until a write actually succeeds.

A timed-out Resume cannot unlock admission when its write eventually completes.
The worker serializes a `paused: true` repair after any already-submitted
`paused: false` write. Until that repair succeeds, a crash can observe the false
write without the later true value; an uncertain Resume followed by a failed
Pause does not establish durable pause across restart. The UI reports failure
and the current worker remains blocked throughout that interval.

On worker restart, a saved paused state remains blocked. Native input now has a
durable attachment-risk journal even before Pause is requested; losing the
in-memory tracker cannot certify release. Legacy pending tab IDs migrate as
unknown risks and never authorize cleanup on a replacement browser's same-number
tab. Original-tab removal within the same incarnation is positive evidence;
cross-incarnation recovery uses profile-start witnesses and may need a later
startup when old provenance was initially unknown. The extension never closes,
moves, groups, or activates tabs as part of Pause. An already-issued disposition
can finish, but later steps are fenced. See [browser lifetime](browser-lifetime.md)
for persistence ordering, delayed startup and incomplete evidence.

Mutation messages require the exact extension ID and popup URL, no sender tab,
and a matching live `POPUP` context from `runtime.getContexts`. A sender document
ID, when supplied, must match. Chrome 156's real action-popup sender omitted that
field; ordinary extension-tab senders included it and a tab. The native RPC
allowlist exposes no Pause/Resume setter. This is a user control boundary, not
authentication against malicious same-account programs or arbitrary extension
code. Page JavaScript timers and other effects already delivered cannot be
rolled back by Pause.

The product also refuses control of its own `chrome-extension://<id>/` pages:
claim and session-tab authorization inspect both `url` and `pendingUrl`, and
explicit `goto`, raw `Page.navigate`, and `Target.createTarget` destinations are
checked. Matching parses the protocol and hostname, including URLs with query
or fragment, instead of comparing a prefix or opaque URL origin. A native Edge
probe proved that the debugger API itself permits attaching to the extension's
ordinary popup tab, so the product cannot rely on Chrome to enforce this guard.

Raw `Target.attachToTarget`, `Target.attachToBrowserTarget`, and
`Target.sendMessageToTarget` are rejected. These can select or tunnel commands
to targets outside the already authorized tab. Use `Target.setAutoAttach` and
the returned flat child `sessionId` relative to the owned tab instead. Other
raw `Target.*` commands carrying a `targetId` must prove that it is the same tab
root; an unprovable iframe/worker target is rejected. The engine's internal CRX
transport is separate from this raw entry point. These compatibility limits
close known direct paths; they are not a general website policy or sandbox for
arbitrary raw CDP/page programs.

Native detach completion, rather than an assumed `onDetach` callback, is the
explicit release boundary. In isolated Edge 153, explicit detach resolved in
6 ms and produced no `onDetach` in the following 1.5-second observation window;
closing the tab produced `target_closed` as a positive control. This agrees with
[Chrome's documented onDetach event](https://developer.chrome.com/docs/extensions/reference/api/debugger#event-onDetach),
which describes browser-initiated termination. Cleanup captures the native
attachment token before asynchronous CRX teardown so an old release cannot
release input or detach a successor. No sleep or nonexistent event barrier is
used to claim completion.

## Errors and verification

Lifecycle errors use the existing JSON-RPC `-32000` envelope and stable prefixes:

| Prefix | Meaning |
| --- | --- |
| `OBU_STALE_CONTROL_EPOCH` | Missing record or a retired explicit epoch |
| `OBU_TURN_ENDED` | An observed legacy turn ID has ended |
| `OBU_CONTROL_ENDING` | Release/recovery is still running |
| `OBU_CONTROL_BOOTSTRAP_REQUIRED` | This legacy request requires epoch mode |
| `OBU_CONTROL_CAPACITY` | All bounded session records are in use |
| `OBU_CONTROL_RELEASE_FAILED` | At least one debugger release failed |
| `OBU_CONTROL_STATE_INVALID` | Persisted state is invalid; epochs are not reset |
| `OBU_CONTROL_EPOCH_EXHAUSTED` | The global safe-integer counter cannot advance |
| `OBU_AUTOMATION_PAUSED` | User control blocks requests, including epoch bootstrap |
| `OBU_AUTOMATION_PAUSE_FAILED` | Pause cleanup is unconfirmed and admission stays blocked |
| `OBU_AUTOMATION_CLEANUP_TIMEOUT` | Pause's total cleanup deadline expired |
| `OBU_INPUT_RELEASE_UNCONFIRMED` | Native held input or restart cleanup is unresolved |
| `OBU_AUTOMATION_PAUSE_INCOMPLETE` | Resume requires a successful cleanup first |
| `OBU_CONTROL_REVISION_CONFLICT` | The popup attempted Resume using an old revision |
| `OBU_CONTROL_FORBIDDEN` | The sender is not a current action popup |
| `OBU_EXTENSION_UI_PROTECTED` | Automation attempted to control this extension's own UI |
| `OBU_CDP_TARGET_UNOWNED` | A raw command selects or tunnels to an unproven target |

Original storage and Chrome inventory errors are preserved. Public RPC dispatch
uses an explicit allowlist; internal lifecycle helpers and inherited object
methods are not callable through the wire protocol.

Run `node --test apps/chrome-extension/control-lifecycle.test.mjs`. The regressions
cover delayed attach/create, parallel durability barriers, failed persistence,
bounded eviction, legacy tombstones, release failures, closing restart, and
recovery without disposition replay. An isolated headed Chromium fixture also
verified cancellation, successor name/create/attach, and actual service-worker
stop/start: old epochs failed, a new epoch attached, and the foreground sentinel
tab remained active throughout. Extension reload and browser/host process restart
are separate deployment scenarios, not implied by that worker-restart check.

## Task-tab movement and native host disconnection

A task tab leaving its group, moving to another window, or being replaced
retires its current attachment. The event fences native sends and queued engine
work synchronously, before asynchronous resource cleanup. It then drains media,
exports and clipboard work, releases held input on the original attachment, and
detaches. Cleanup does not move or activate the tab. A group update preserving
the current task membership does not retire it. An explicit later claim waits
for the original release; a failed release keeps the old attachment blocked.
Closing a tab can race with an already-started CRX detach. A native
`tabs.onRemoved` or debugger `target_closed` event marks the original attachment
token destroyed; only that evidence can turn its late detach error into
completed cleanup. An error message saying the tab is absent is insufficient.

The native Port lifetime has its own recovery gate. Disconnection closes
admission and cancels accepted work before a replacement connection is tried.
It durably invalidates control epochs, releases attachments and clears active
session state without changing the user's Pause setting. Replies from the old
Port are never sent to the replacement host's request-ID namespace. Reconnection
does not replay browser actions: SDK callers must create a new client and new
handles, then explicitly begin a new turn. Same-browser task membership remains
available after this cleanup.

`OBU_NATIVE_RECOVERY_PENDING` means actual cleanup is still running;
`OBU_NATIVE_RECOVERY_FAILED` leaves admission blocked and permits an explicit
begin-turn attempt to retry cleanup. `OBU_TAB_CONTROL_REVOKED` rejects work using
a retired tab attachment. These errors use the existing JSON-RPC envelope.
A deadline is not proof that a native operation stopped. Already executed page
JavaScript cannot be rolled back.

The isolated acceptance runner includes `js-owned-tab-revocation` and
`js-native-host-restart`. It observes a real pending locator before removing
group membership, transferring to a different group or moving to another
unfocused normal window. After revocation it inserts the formerly absent
target and checks that the old action does not click it. Trusted pointer/key
release events, pointer capture, debugger state and explicit reclamation are
checked separately. The host case kills the real host process, awaits its exit,
closes that process's loopback Port adapter, and launches a new PID and endpoint
while preserving the browser, worker and continuous focus observer. It checks
old epoch rejection and explicit recovery. This is actual process replacement
through a declared test adapter, not native-host registration/launcher recovery.
The staged build also observes original release failures synchronously before
Pause can clear them, and retains them on failed cases. That hook changes no
production cleanup result and is excluded from the distributable extension.

Full browser restart remains separate from the host case. Chrome only guarantees
numeric tab IDs within a
[browser session](https://developer.chrome.com/docs/extensions/reference/api/tabs#property-Tab-id).
Task groups, deliverables, active tabs, origins and auxiliary claims now share
an extension-loaded incarnation. A mismatch revokes these bindings before any
browser mutation and retires idle as well as active epochs. Restored pages must
be explicitly claimed; same-title groups do not acquire ownership. The separate
input journal and startup-witness transaction prevent missing session storage
from being interpreted as input release. Verification and remaining deployment
boundaries are documented in [browser lifetime](browser-lifetime.md).

`node --test apps/chrome-extension/pause-control.test.mjs` additionally covers
durable pause, idle-epoch invalidation, startup/end/bootstrap races, stale
Resume, late native input, failed release retry, bounded stuck cleanup, pending
restart state, rendering cancellation, and exact attachment release tokens.
The final native Edge 153 fixture `held-pause-final-9iHGCP` uses the real Go
native host and JS SDK. The actual action popup pauses held pointer/Shift input
and cancels a pending locator. A test-only native mouse-release failure leaves
control blocked and displays Failed; removing that fault and clicking Retry
pause releases the same attachment. Running, Paused, Failed, and successful
retry screenshots were inspected. No active-tab event occurred, and the
temporary host registration was removed. Stored source hashes match the final
production backend, engine, input tracker, popup controller, and CRX bundle.

Separate native fixtures reproduce dragCancel retaining pointer capture and
the old asynchronous-highlight teardown allowing a date fill after Pause. The
fixed versions release capture and keep the newly appeared date input empty.
Those fixtures inject controlled scheduling/failures for reproducibility; they
do not claim that a page's already-running JavaScript can be rolled back.

The full headed acceptance suite passed 26/26 twice on identical production
artifacts (`run-qjsIiJ`, `run-uTXspB`). Both runs recorded no active-tab events;
normal Pause completed in 110 ms each. They include real popup sender checks,
direct paused RPC rejection, dragCancel input release, persisted Pause across
worker replacement, stale Resume rejection, and explicit new turns after Resume.

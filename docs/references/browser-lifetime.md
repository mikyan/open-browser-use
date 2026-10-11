# Browser lifetime and recovered input

The extension binds browser IDs to a random incarnation in `storage.session`.
This identifies an extension-loaded session, not a browser process. Chrome
clears this area on browser restart and extension reload, update, or disable.
A service-worker restart alone preserves it. See the
[Chrome storage contract](https://developer.chrome.com/docs/extensions/reference/api/storage#storage-areas).

## Ownership before recovery

Every stored task group, active tab, tab origin, deliverable group/window mapping
and auxiliary claim belongs to one incarnation. A missing or mismatched marker
discards the numeric bindings before browser mutations or control admission.
Unversioned bindings are migration data, not current ownership. Session names
may survive; a matching title or URL never restores authority over a page.

Restored tabs remain available for explicit claim. Recovery does not close,
move, activate or rename them. Deliveries reuse only a group recorded for the
current incarnation and exact window; unrelated same-title groups are untouched.
Both idle and active old control epochs are retired on incarnation change.
The global epoch counter remains durable and monotonic. New work requires an
explicit turn; the SDK does not replay an old request.

A worker can lose its attachment map while Chrome retains this extension's
debugger client. Explicit claim of a current tab can recover that orphan only
after the unknown-input gate is clear. A read-only `Target.getTargetInfo` command
must succeed through this extension's debugger session before its exact opaque
target is detached. Current tracked attachments are not reset. The per-tab
recovery barrier and control checks cover the intervening asynchronous work;
failure to detach is not accepted as cleanup success.

Chrome's debugger implementation looks up the client by both target and
extension ID for `sendCommand` and `detach`. This does not grant the successor
worker permission to detach another extension or ordinary DevTools client. See
the pinned [client lookup and detach implementation](https://chromium.googlesource.com/chromium/src/+/f842f52ef39fd97b449eb27cff414bf05a98ddce/chrome/browser/extensions/api/debugger/debugger_api.cc#1031).

## Durable input risk

Before native `Input.*` execution, the shared raw/CRX tracker durably records an
opaque risk ID for the exact attachment and its tab/incarnation. The journal
does not contain key text, coordinates or page content. After the storage wait,
the original attachment and current control scope are checked again before
the native send. A late write cannot reopen a paused or ended operation.

The risk is removed only after actual native completion and no remaining held
input, successful cleanup, or positive destruction of the original tab. Writes
and clears share one ordered queue. They remain part of teardown even if an RPC
or cleanup deadline has already expired. Old callbacks cannot clear a successor
attachment's risk. Persistence failure blocks automation.

A replacement worker cannot reconstruct held keys/buttons from an empty Map.
Recovered risks therefore block input and expose unconfirmed cleanup. A native
`tabs.onRemoved` event for the same incarnation can retire the original tab's
risk. Across incarnations, the same numeric ID is unrelated. Neither an absent
`storage.session` marker nor an absent entry in `debugger.getTargets()` or
`tabs.query()` proves that the original renderer/input has been destroyed.

## Profile-start witnesses

`runtime.onStartup` is a positive profile-start signal, but its initial dispatch
can be delayed. An extension may have performed work and reloaded before that
event is created. Consequently a first callback cannot simply clear all records
from the previous extension incarnation.

The lifetime coordinator instead records a startup witness. Input admitted after
a witnessed startup carries that witness; input without one remains explicitly
unwitnessed. When a new incarnation receives a native startup event, a frozen
old risk may retire only if it already carries a different startup witness.
An unwitnessed risk is first stamped and remains unresolved. Current-incarnation
risks are never cleared by startup. This can require a later actual profile
restart for legacy or initially unwitnessed input; it does not auto-resume work.

The startup transaction persists its witness intent in session storage before
updating the journal, then marks it consumed. A replacement worker resumes that
same transaction. A risk stamped with the same witness is never treated as an
older risk during replay. Ordinary worker starts and duplicate callbacks cannot
create new evidence. The popup still requires successful cleanup, explicit
Resume and a new turn after recovered uncertainty has blocked automation.

This relies on Chrome's native event, not a callable RPC or test notification.
The pinned Chromium implementation creates startup background hosts once per
profile process manager; worker event acknowledgements do not replay a dispatched
event, and extension unload drops pending events for its old activation:

- [ProcessManager startup guard](https://chromium.googlesource.com/chromium/src/+/f842f52ef39fd97b449eb27cff414bf05a98ddce/extensions/browser/process_manager.cc#356)
- [Worker task queue activation/deactivation](https://chromium.googlesource.com/chromium/src/+/f842f52ef39fd97b449eb27cff414bf05a98ddce/extensions/browser/service_worker/service_worker_task_queue.cc#626)
- [Stopped-worker event acknowledgement cleanup](https://chromium.googlesource.com/chromium/src/+/f842f52ef39fd97b449eb27cff414bf05a98ddce/extensions/browser/event_router.cc#1928)

If startup delivery is unavailable, storage fails, or provenance is insufficient,
cleanup remains unconfirmed. A browser-version string, native-host PID change,
timeout or command error does not substitute for this proof. A native-host-only
restart retains the browser incarnation and uses the separate exact-attachment
cleanup described in [control lifecycle](control-lifecycle.md).

## Recovery guidance after worker loss or extension reload

The popup uses the optional `inputRecovery` status field described in
[control lifecycle](control-lifecycle.md#user-pause-and-resume). Its instructions
come from the current recovered-risk set, not from parsing an old failure
message. Reading the guidance does not change the journal or permit input.

When all recovered risks still belong to the current extension-loaded session,
the popup asks the user to save work and close the pages that were being
controlled, then choose Retry pause to check the result. Only a confirmed removal
of an original risk page can retire that page's record; closing unrelated pages
or merely retrying is not proof of release.

After extension reload, update, or loss of the session marker, risks from the
previous session require a different path. The popup asks the user to fully quit
the browser, including background processes, and reopen the same profile with
the extension enabled. Closing the old tab after reload does not establish its
old identity in the new session, and another extension reload is not a browser
startup. If a risk has no startup witness, the first qualifying startup stamps
it without clearing it; another actual profile startup is needed before that
record can retire. The popup indicates that an additional full restart may be
necessary rather than promising that one restart always resolves recovery.

Once positive startup evidence retires the recovered risks, the restart guidance
disappears immediately. If control still shows Failed, the user can choose Retry
pause. If initialization has already completed cleanup and shows Paused, no
extra retry is required. Startup may complete Pause, but never switches the
control to Running: explicit Resume and a new Agent turn remain necessary.
Storage failures or unavailable startup events can still leave cleanup
unconfirmed. No recovery instruction automatically closes pages, restarts the
browser, clears storage, or replays an operation.

## Verification boundary

Production-class regressions force reused tab/group/window IDs, delayed storage,
late startup, worker replacement, journal failures and control changes while
input persistence is pending. Browser acceptance uses the isolated runner
`scripts/browser-integration/browser-restart.mjs`, an actual browser process exit
and relaunch with the same synthetic profile, and separate worker/state-loss
cases. It uses the declared native Port adapter and does not certify native-host
installation or launcher recovery.

Final `browser-restart-ShnPfH` passed all four cases: unpaused and paused actual
process replacement, same-browser session-state loss, and same-incarnation
worker loss with trusted held pointer/Shift input. The last case retains one
real popup document through Failed, exact original-tab removal, Retry pause,
Paused, Resume and Running, then requires an explicit new turn and trusted
action. The restored task documents are inspected; lazy deliverables use exact
tab/group metadata, rejected unclaimed input and unchanged server mutation
witnesses, not a claim of preserved loaded DOM. Earlier failures remain in the
[runner's evidence record](../../scripts/browser-integration/README.md).

The runner's expanded acceptance structure has eight distinct cases:

| Case | Evidence required |
| --- | --- |
| `browser-restart-unpaused` | Actual same-profile browser replacement; old ownership and epochs revoked; retained pages require explicit claim. |
| `browser-restart-paused` | Actual browser replacement preserves the user's Pause; no automatic Resume or action replay. |
| `same-browser-session-state-loss` | Same browser, explicit session-storage loss and worker replacement; this is not extension reload. |
| `worker-input-state-loss` | Same-session worker loss retains unknown held input; confirmed original-tab removal permits cleanup, followed by explicit Resume and new work. |
| `extension-reload-unpaused` | A real unpacked `runtime.reload()` replaces the worker and session marker without replacing the browser; an already-pending action must not execute later, and retained pages require explicit claim. |
| `extension-reload-paused` | A real reload preserves Pause and rejects old control scope; page state and server witnesses remain unchanged until explicit new work. |
| `extension-reload-held-unwitnessed` | Real held input survives reload as unknown; tab removal does not clear the old-session risk. The first qualifying actual profile startup stamps it, and a later startup can retire it without resuming automation. |
| `extension-reload-held-witnessed` | Input already carrying a prior native startup witness remains blocked after reload; a subsequent actual profile startup can retire that old risk, still requiring explicit Resume. |

This table defines the acceptance requirements, not a result for an unrecorded
run. The reload cases record the old and new worker/context identities, changed
session marker, unchanged browser identity, raw native lifecycle events, page
and server witnesses, and the current recovery guidance. An unpacked reload
reports `onInstalled` with reason `update`; that is not evidence of installing
a signed package or a newer version. The declared native Port adapter can retain
its host across reload, so these cases do not certify real native-port EOF,
host registration, or launcher recovery.

An independent test-only companion extension owns the continuous focus observer
through OBU reload; it does not control the task pages. Whole-browser replacement
still destroys that observer, so each browser process has a separate segment and
the process-restart gaps remain explicit. The segments are not an uninterrupted
zero-focus trace. The earlier four-case result above does not by itself prove
the added reload/witness cases, all update orderings, or other browser versions.

`browser-restart-w5chI9` subsequently passed **8/8**. Both held-input branches
retained their exact risk after reload and original-tab removal; the unwitnessed
branch needed two actual startup events, while the witnessed branch needed one.
All six browser generations exited. The continuous companion observed zero tab
activations and 22 focus events, precisely attributed to 11 intentional popup
openings; five whole-process coverage gaps remain explicit. Twenty popup PNGs
were checked, including the changing recovery instructions. The runner's setup
and retained failed attempts are documented in its README; it uses a persistent
private-profile installation and never synthesizes startup evidence.

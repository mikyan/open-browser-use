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

Each browser process has its own focus observer. The process-restart gap is
explicit; these segments are not an uninterrupted zero-focus trace. Passing a
clean restart does not prove uncertain-input startup recovery or all extension
reload/update orderings. Those require their own recorded cases.

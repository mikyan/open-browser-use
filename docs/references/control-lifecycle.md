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
clipboard helpers remain separately audited. Release currently discovers tabs from the session's Chrome
group; an attachment manually moved outside that group is not yet tracked by a
automatic cleanup listener. A subsequent legitimate session attachment releases
the previous attachment before reusing that tab.

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

# Navigation waits

Status: implemented locally. Windows Chromium 156 focused acceptance passed
10/10 (`run-o6Oc7z`); the full public-entrypoint suite passed 43/43 (`run-9ZuGbE`).
This is one capability slice, not completion of the full Codex parity matrix.

## Behavior

`waitForURL` and `waitForLoadState` retain the pinned Playwright semantics. A URL
string uses native exact/glob matching. A matching current URL or an already
reached load state may complete immediately. Neither method promises to wait for
the next navigation. URL waits accept `commit`, `domcontentloaded`, `load` and
`networkidle`; load-state waits accept the last three. Defaults remain `load`.
Redirects, same-document navigation, navigation failures, crash and close remain
native Playwright behavior. The adapter neither polls page JavaScript nor invents
lifecycle events. `networkidle` is a native lifecycle condition, not proof that an
application has finished all useful work.

The old `browserAction` methods now reserve a navigation observer before their
first await. Only the short registration step occupies the action queue. A later
same-session/turn/tab action, raw CDP call or explicit attachment captures earlier
setup promises and waits for readiness; later waits do not block an earlier
trigger. This closes the cold-admission race in `Promise.all([waitForURL(...),
click()])`. The blocking method remains a completion API, not a ready ACK.

Sequential clients use a separate ready handle:

1. Await `expectURL` or `expectLoadState` to confirm native listener readiness.
2. Trigger the observed page action once.
3. Await the handle's `result` and verify the resulting page.
4. Cancel the handle when finished or after a trigger failure. Preserve the
   trigger's original error if cleanup also fails.

Python, Go, CLI and MCP can follow these steps without starting a blocking collect
on their single request reader before issuing the trigger. Direct waits remain
useful for external navigation or a condition already expected to be true.

## Wire contract

`getInfo.metadata.navigationWaitVersion === 1` advertises explicit handles. Older
extensions fail capability negotiation; there is no silent fallback to polling
or retrying the trigger. All three RPCs require the exact original `session_id`,
`turn_id`, positive safe integer `control_epoch` and nonnegative integer `tabId`.

| RPC | Extra parameters | Success |
| --- | --- | --- |
| `armNavigationWait` | `event:"url"`, `url`, `waitUntil?`, `timeoutMs?`; or `event:"loadstate"`, `state?`, `timeoutMs?` | `{waiterId, remainingMs}` after registration or native immediate success |
| `collectNavigationWait` | `waiterId` | `{}` after native success and scope validation |
| `cancelNavigationWait` | `waiterId` | `{}`, releases that observer and record |

Unknown fields and fields for the wrong event are rejected. URL patterns are
nonempty strings of at most 4096 UTF-8 bytes; executable predicates and serialized
regular expressions are unsupported. Timeout defaults to 10 seconds, with an
integer range of 1–120000 ms. The deadline starts before worker recovery,
authorization, attachment and queueing. Arm must finish before that deadline;
collect cannot renew it. Scope validation after a timely native result has its
own bounded 10-second budget. Terminal records remain for 30 seconds, including
repeatable success/errors, and count toward capacity until cancellation/expiry.
Limits are 16 per tab, 32 per session and 128 globally, including reservations.

Typed handles capture the metadata actually submitted by arm. Changing a client's
turn later cannot rebind an old handle. `result` returns void/None/error; callers
inspect the page separately rather than treating a returned URL as proof of a
particular document identity. An unknown or foreign cancellation cannot cancel a
different record. A wrong-scope collect fails explicitly.

The legacy direct browserAction path can still omit an epoch where the existing
control ledger permits that turn; the observer binds to the real admitted epoch
before it becomes usable. Explicit handle RPCs require a positive epoch.

## Ownership and cancellation

`browser-navigation-waits.js` owns fixed scope, limits, deadlines, completion
validation and retention. The pinned runtime bridge returns `ready`, actual
native `result`, and `cancel(error)`. A private options symbol binds cancellation
to the exact native Waiter. Readiness fires only after its first navigation/load
listener is installed, or after native immediate success. Cancellation rejects
the native failure race so it disposes listeners and timers; merely disposing a
Waiter would leave its event promise unresolved. A delayed API wrapper checks
cancellation before it can register anything. Build guards reject unexpected
upstream shapes, and the modified upstream remains pinned by digest.

Timeout/cancel of a registered observer does not detach the Page or release a
different action's input. An isolated warm setup timeout likewise preserves the
existing attachment. A newly started cold attachment still needs identity-fenced
cleanup if setup expires. The real native result stays tracked until cancellation
settles, so Pause cannot report success by hiding an unresolved native operation.

End/Pause, ownership movement, explicit detach, tab closure and worker replacement
invalidate handles. Pause/Resume and explicit new turns do not replay a trigger.
Cold raw-to-engine migration preserves unbound reservations while expiring waits
bound to the old Page. This is control routing, not application authentication or
website policy; session IDs remain routing identifiers.

## Evidence requirements

Unit tests must cover native registration/cancellation, delayed setup, immediate
success, all lifecycle options, exact scope, quotas, TTL and late operations.
Backend tests must prove cold wait-before-trigger ordering, independent action
deadlines, warm timeout isolation and lifecycle fencing. The headed acceptance
suite must exercise JS/Python/Go/CLI/MCP ready handles, existing direct waits,
trusted single triggers, fast/SPA/redirect navigation, actual load state and
Pause/restart. All existing activation/focus ledgers and visual-feedback checks
remain mandatory. Current results belong in the execution plan and capability
matrix, with their tested runtime and artifact identities.

The verified slice has 361 passing extension/build tests, 66 JS SDK tests,
39 Python SDK tests and passing Go packages. SDK verification includes the real
Go host; the browser suite uses the documented isolated native-message adapter.
The full run retains trusted single-trigger evidence, server counters, exact
Network.loadingFinished IDs and independent lifecycle gates. An initial fixture
failure left a counting fetch body unread; native trace showed that request
never finished. Consuming its body fixed the fixture without changing native
idle semantics, increasing a timeout or weakening an assertion. Cold direct
wait/click and ready handles passed through all five entrypoints. Worker restart
and Pause expire old handles without replay; this does not prove full host or
browser process recovery, native popup focus suppression or other platforms.

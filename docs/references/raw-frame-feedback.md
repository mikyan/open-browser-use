# Coordinate target feedback inside frames

Coordinate mouse input can now show the element beneath its point inside an
already initialized Playwright Page. The public JS mouse API and direct root
CDP mouse input share this optional read. The original locator-selected target
continues to use its own [element feedback](frame-target-feedback.md).

This is a read-time hit-test snapshot. It does not prove which element received
an earlier input or continuously track subsequent layout changes. A cold raw
CDP attachment, before any Page exists, still has the root-document fallback.
The [active plan](../exec-plans/active/2026-10-15-raw-frame-feedback.md) remains
open for that route and for complete Browser Use parity.

## Read and ownership

The private runtime adapter starts a fractional `elementFromPoint` in the
original frame's existing utility context. It descends open shadow roots and
then verified iframe owners. It projects all four native border corners through
the actual renderer boundaries, rather than translating a frame-local AABB.
Same-origin, OOPIF, nested, dynamic, scaled and rotated frames use the same
geometry primitives as the locator adapter. Unknown frames, contexts, owners
or planes produce no rectangle, rather than claiming an ancestor as the leaf.

No Page, isolated world or engine attachment is created by this optional warm
read. The ready-Page cache is bound to the original promise and generation.
Every asynchronous step checks its original Page, attachment, frame, document,
parent, context and native route. A private candidate travels with a mouse
click's existing move/down/up sequence; public CDP parameters cannot supply
this authority. Pinned zero-delay click retains its original overlapping native
invocations and ACKs. No input is replayed or delayed to obtain geometry.

The existing registry bounds pending work to sixteen globally and two per
attachment. Each allocated remote object, including an exceptional or late
result, is owned before post-read validation. Cleanup uses only its original
native lease. Successful release ACKs are not repeated; failed release retains
the object and blocks admission until explicit cleanup succeeds. A native
context-destruction event is evidence that its objects are gone; replacing a
local Page or attachment is not.

## Caller completion and cleanup

Optional feedback must not extend an input's error or deadline. Action failure
starts the original attachment's full detach barrier, while the caller waits
only for its existing required cleanup, including held keys/buttons and other
required resources. The same captured lease signals that required completion;
full detach additionally waits for actual raw allocations and object releases.
Normal commands and successor attachment cannot pass the outstanding barrier.
End, Pause and explicit detach continue to wait for full cleanup.
The existing required-resource cleanup may itself remain pending; this change
removes only the new optional visual work from caller completion.

This separation does not cancel the original native read or claim that its
resource has been released. It preserves the original input error, avoids
turning a quick native rejection into a later timeout, and retains the original
attachment until cleanup is confirmed. Pure locator BoxModel reads acquire no
new handles and retain their prior cleanup contract.

## Retained evidence

Old-source run `R1aiOp` completed twelve unique original submissions and native
input checks across the two coordinate modes, while all twelve outlines framed
an ancestor iframe. The corrected native oracle allows the pinned JS mouse
click's overlapping ACKs, while still requiring ordered original invocations
and one actual successful ACK per invocation. Its earlier stricter failure
`VZh8hm` is retained.

Initial warm candidate `QOGMzJ` passes all twelve layouts and the mandatory raw
navigation case, with actual process exit 0 and unchanged source/runtime
identities. Independent CSS-plane and PNG analysis verifies every leaf border
and excludes extra ancestor borders. Twelve original trusted POSTs total 28,374
bytes. All 65 raw hit-test objects have unique original-route release ACKs.
The original 26 document observations remain hidden after 572/578 ms at End;
exact test tabs and child targets are removed. The 14,795 ms observer interval
has no activation, focus changes or allowances. Click-ring evidence is passive
DOM geometry, not a claim that transient rings appear in the PNGs.

That normal run does not prove failure-path timing. An independent deterministic
counterexample held either allocation or release: a 30 ms mouse request was
still pending at 100 ms, and its original immediate native error became a
timeout. This prompted the two-phase cleanup above; focused failure/timeout
regressions and final verification are recorded with the active plan.

Cold run `uGRF8J` preserves three successful original submissions (8,625 bytes),
three original native PNGs and seven unchanged documents, but all three target
outlines are still wrong. Its observer confirms the engine remains absent and
the original raw attachment is not migrated. Actual exit is 1; the 5,528 ms
focus interval contains no events or allowances. End remains hidden after
571 ms and exact tabs/targets are gone. This failure is not waived by the warm
result. Run it explicitly with `OBU_TEST_RAW_COLD_FEEDBACK=1` and
`OBU_TEST_CASES=^js-cold-cdp-frame-target-feedback$` in the integration runner.

## Remaining scope

Cold raw routing, fullscreen feedback, ordinary Edge installation and broader
cross-worker delivery remain open. Warm browser evidence uses the public JS
SDK and direct CDP entry; it does not establish independent five-entry visual
coverage, arbitrary CSS geometry, or parity of the entire product. Existing
preview archives are unchanged.

## Final warm increment verification

Final frozen run `xS4ddv` passes the default 180/180 browser cases with actual
exit 0, no source/runtime drift, and the preceding 178 case names/order retained.
The cold opt-in failure above is deliberately a separate unresolved case, not
part of this passing default count.

Independent original-record checks cover eighteen locator/mouse/CDP layouts,
eighteen native PNGs, eighteen unique trusted POSTs totaling 42,559 bytes and
39 original document observations. The two coordinate modes allocate 65 observed
hit-test objects, each released with one exact original-route ACK. End remains
hidden after 569/568/567 ms with unchanged business state and geometry; exact
test tabs and observed child targets are gone. The 533,948 ms focus interval
retains only the existing twelve activation and four control-popup focus
allowances. This is not a claim that the whole suite has zero focus events.

All three deterministic Node groups close with exit 0: 3666 pass and one
existing Windows file-symlink privilege skip. Targeted cases cover held optional
allocation/release, original error identity, the original running timeout,
required key release, rejected successor admission, pre-transport cleanup
failure and explicit recovery. Real-browser normal flows do not substitute for
those controlled timing counterexamples.

Independent input review verifies 33 original keyboard/pointer/drag scenarios:
179 native Input calls and 33 guard Runtime calls each settle once, and their
input parameters/order match the preceding full baseline. Twenty-six original
POSTs total 180,098 bytes. Seven original keyboard failures retain their actual
worker error replies. Five screenshot scenarios each retain one original native
capture and their 1000 ms request budget; seven PNGs total 196,735 bytes and
112 encoded image regions match. The counted-navigation scene retires its
receiver before final hide in this run; it does not re-prove the separate
delayed-hide race. No new input replay or focus allowance was introduced.

## Cold native reader candidate

The foundation increment below preceded production integration; its native
diagnostics alone did not enable the reader in the production backend.
The shared geometry factory moved to `browser-frame-geometry.js` without changing
its function body or generated warm vendor bytes. `browser-native-pointer-feedback.js`
keeps original frame/loader, document element and owner evidence while reading
fractional coordinates through native CDP. It creates no Playwright Page and
enables no protocol domain. Each original route owns a unique object group;
actual allocation and group-release replies remain part of cleanup.

A backend/module-stable random world name and an immutable kernel capture DOM
methods/getters before subsequent reads. Retained deterministic red/green cases
show the old fixed-world reader accepted a different real node, while the new
kernel preserves the original hit after DOM method/getter changes. This is not
an isolation boundary against an equally privileged CDP peer racing the first
bootstrap, or against arbitrary JavaScript-intrinsic tampering. Worker changes
can create another named world; group release does not destroy isolated worlds.

Native capability diagnostic `KXt3Td` confirms that this ordinary extension's
`Target.attachToTarget` returns `Not allowed`. An independent exact-target
`chrome.debugger.attach` can read an OOPIF and detach without migrating the root.
Original normal and exception handles become uncallable after group release.
This observation alone does not prove safe production recovery.

The first reader run `6Yz3DZ` is retained with actual exit 1 and unchanged sources.
Its same-process rectangle matches the original leaf, but five remote layouts
stop before attachment: their DevTools targets have not yet been materialized.
The corrected diagnostic calls native `getTargets` and requires the unique ID
from the original frame owner, then still requires the exact original no-client
response. Neither URL matching nor the inventory's `attached` flag grants ownership.
An unchanged `No target` response remains a rejection.

Frozen diagnostic `5pTnPP` then passes six native rectangles and the mandatory
raw-navigation case, actual exit 0 with no source drift. Same-process, OOPIF,
dynamic, nested, scaled and rotated layouts match independently authored CSS
geometry. All original document/business snapshots remain unchanged. This is a
staged-module read test: it does not inject its result into the visual renderer,
submit the leaf form or establish cold PNG correctness. The production raw
feedback and existing preview archives were unchanged at that foundation stage.

Independent original-record review accounts for 198 settled native calls,
39 opaque objects in 12 released groups, six exact independent attach/detach
chains and 13 unchanged documents. The only fixture input is the dynamic frame's
original Add click. The 1,479 ms focus interval has no events or allowances.
Runner and host have actual exit 0; exact test processes are absent. This mode
has no independent Chrome exit receipt. Its 465 saved source copies and 144
additional Go/build input hashes are verified separately. That foundation's three
Node groups pass 3744 tests with one existing Windows symlink privilege skip;
all original process exits are 0 and source/runtime hashes remain unchanged.

In that foundation, `browser-private-targets.js` was a separately tested allocator
candidate. It reserves each exact target, persists intent before
native attachment, and retains actual work through group/detach/storage failure.
Startup recovery requires a known same-browser ledger; a missing key is not a
fresh-browser witness. A trusted fresh witness must name its original browser
incarnation. A cleanup-only exact absence query can retire an already owned
client after actual sends drain; its result records native absence rather than
inventing a group-release or detach ACK. Group-first failure requires explicit
registry retry before `PassivePointerReads` cleanup retry. Its 27 deterministic
tests include failed group retry and delayed stale fresh witnesses; these do not
prove native worker recovery. Integration with the existing lifecycle, native recovery
fault tests, private-world lifecycle and the full cold visual workflow remain
required by the [active plan](../exec-plans/active/2026-10-15-raw-frame-feedback.md).

## Production cold route integration

The backend now connects `browser-native-pointer-route.js` to optional raw
pointer feedback when no warm Page reader is available. The original root
attachment and input commands remain unchanged. The route first proves its
opaque root identity, then uses the native reader and exact private frame
leases. Actual reads, object groups, independent detach and durable clears remain
in cleanup; original input success, failure and deadline do not await those
optional operations.

`browser-private-target-store.js` initializes only after a real install/update
event and successful marker/empty-ledger writes. A missing or corrupt ownership
record is unknown, not permission to scan or detach clients. Known same-browser
records recover cleanup only; stored numeric tab IDs never authorize root
detach. A validated empty old-browser ledger may rebind after its actual write;
nonempty old-browser records remain unavailable. Privileged deletion of both
keys combined with an old native installation event is outside this witness
contract.

Global Pause joins actual private cleanup. Settled failures require explicit
recovery; ordinary drains do not replay them. Public detach retries the original
groups and leases, including when external root detach already removed the
current attachment token. Successor attach and explicit claim remain fenced by
that old resource. Original opaque-root absence can retire cleanup after actual
work drains and exclusion is rechecked, but cannot invent a release ACK or
authorize new reads.

Cold reads use one active route and one latest queued position per original
attachment. New positions replace only the unstarted candidate; they never replay
input or cancel a native send already in flight. Successful cleanup wakes that
queue even when the preceding read used the warm route. Failed cleanup cancels
the queued candidate and preserves the original fence until explicit recovery.
The cold scheduler counts active and queued candidates against its global bound;
the existing warm admission policy remains unchanged.

When private ownership is unavailable, ordinary input retains its old behavior
and feedback may use the root hit test. That branch does not establish leaf
support. Worker recovery must retain independent unresolved input-risk blocking;
private-target cleanup never clears it or replays input. Real visual/lifecycle
verification for this integration is recorded separately from the earlier
diagnostics above. Preview archives remain unchanged.

### Integrated native acceptance

Final-source cold run `JVWwm9` passes both opt-in cases with actual exit 0 and
unchanged source/runtime hashes. Six original PNGs match their native screenshot
replies byte for byte. Independent CSS and original node/owner quads agree with
the projected leaf bounding boxes; all four outline edges pass for same-process,
cross-process, dynamic, nested, scaled
and rotated frames; ancestor edges are not highlighted. Six original form POSTs
and their 48 trusted business events match, across 13 unchanged documents.
The audit joins all 1,073 original native calls, 183 opaque handles, 56 released
groups and 27 independent attach/detach pairs. Each root attaches once without
engine creation or migration. End hides all documents immediately and after
568 ms. The 8,009 ms focus ledger has no events or allowances; host and runner
exit 0, with no exact test process remaining. There is no separate Chrome exit
receipt. This supersedes the cold visual gap for these six fixtures, not the
broader world-lifetime and event-coexistence requirements.

The first integrated run `HruAYH` remains failed: three layouts lacked an outline
because old optional reads filled both slots. The old navigation readiness read
also exposed an overly broad resource oracle. Only its exact command, original
navigation interval and handle-free value result are exempt from allocation
group checks. Cold-only scheduler run `21NiBa` passed, but an independent mixed
warm/cold regression required the queue wake-up fix before `JVWwm9`.

Native lifecycle mode runs the mandatory navigation case followed by three
scenes: held group delivery, rejected detach delivery and actual worker
replacement while an original mouse button is held. Invoke it with
`OBU_TEST_COLD_PRIVATE_TARGETS=1` and
`OBU_TEST_CASES=^js-cold-private-target-lifecycle$`; it is exclusive of the other
diagnostic modes. Native ACKs and controlled delivery failures are recorded
separately. Original failed runs remain evidence: `Vaod2E` incorrectly assumed
a completed mouse move left held input, and `mjZpUm` compared serialized key
order instead of exact storage structure. Neither failure justified changing
production input-risk rules, weakening ACK order or replaying input.

Final-source lifecycle run `WbyEaV` passes both cases with actual exit 0 and no
source/runtime drift. Independent review joins all 126 native calls across the
three scenes and the replacement worker. The held risk's actual storage ACK
precedes the single original mouse-down. Recovery leaves that risk blocked;
both old begin/finalize requests are rejected, and the replacement issues no
Input command. Only closing the exact original test tab clears its remaining
same-browser risk. Private intent recovery queries and detaches the exact owned
child, then waits for the durable clear ACK; all three final inventories are
empty. Focus events/extra allowances and exact test process remnants are zero;
host and runner exit 0. Stop/start is evidenced by the original runner, distinct
worker targets and new native connections, not an independent protocol transcript.
Controlled delivery failures are not claims of naturally occurring native errors.

### Default-suite close observation

Default run `6L9esM` remains 179/180 with actual exit 1. Its sole failure is an
immediate response-body cleanup tab query after the last original `Page.close`;
the twelve original MCP body reads and native/server bytes pass independent
review, but the snapshot still contains that dynamic tab. The old fixture has
no close-ACK/removal-event ledger, so that record cannot prove how soon the tab
actually disappeared. All other input/frame/screenshot checks, exact original
focus allowances and final process cleanup remain separately verified.

The pinned [Chromium 156 close implementation](https://github.com/chromium/chromium/blob/156.0.8078.4/content/browser/devtools/protocol/page_handler.cc#L715)
returns after dispatching before-unload. The response-body fixture now preserves
each original native close Promise and records its ACK plus exact `tabs.onRemoved`
events. After all original single close calls return, a five-second read-only
observation budget requires both exact tab and target inventories to be empty.
Query errors fail immediately; pending operations and the last snapshot survive
timeout. Initial inventory and final diagnostic reads have separate bounded
budgets; this is not a five-second bound on the public close calls themselves.
No force-close, repeated input, body-read deadline change or production-code
change is involved. The two fixture files have 58 passing deterministic checks;
fresh real run `SN2lmN` passes all seven selected cases with actual exit 0.
Independent review verifies 60 body reads, 15 original close/ACK/removal triples
and both exact final inventories. Its 34,691 ms focus interval has zero events
or allowances. Each entry completes on its first observation in this run; the
delayed-observation branch has deterministic coverage, not a new native delay
reproduction. The original `6L9esM` timing gap remains unexplained.
The cold/lifecycle runs above retain their original source snapshots; only these
two unrelated response-body fixture files changed afterwards.

Final default run `ZXPe7X` passes 180/180 with actual exit 0 and unchanged
source/runtime hashes. Independent original-record review verifies 18 frame
PNGs/POSTs (42,559 bytes), 65 raw-object release ACKs, the original input and
screenshot workflows, and the new close observations. Its 574,481 ms focus
interval preserves only the original twelve activation/four control-popup
allowances, each matched to its exact target and interval. The original host
restart terminates generation one; generation two exits 0, all connections close
and exact test processes are absent. Final Node groups pass 3,837 tests with one
existing Windows symlink privilege skip. World/context lifetime, broader native
event coexistence and ordinary installed Edge remain separate open boundaries.

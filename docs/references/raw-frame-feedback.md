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

### Compatible worker realm reuse

The old module selected new random world/kernel names on every worker import.
Old-production runs `7OWtNq` and `EuhlIy` preserve the same root document through
two actual worker replacements and observe one, two, then three native passive
worlds. Both retain actual exit 1; the first also exposed an oracle mistake
around the expected not-attached probe before a replacement worker's explicit
claim. The corrected oracle in the second run reaches the cardinality failure.
Neither record is rewritten as a pass.

`browser-pointer-realm.js` initializes an installation identity in IndexedDB.
One upgrade transaction creates both the schema and seed; later workers perform
only a read. A successful request does not publish identity: the verifying
transaction must complete with the exact schema and one valid record. Missing,
corrupt, blocked or failed storage disables optional cold reads without repairing
or rotating the seed. Normal control startup and native input never await this
optional readiness.

The immutable injected DOM closure, including `readOwnerPlane`, has an explicit
`NATIVE_POINTER_KERNEL_ABI`. Compatible workers use the same world/kernel/token
names. Incompatible closure changes must bump this ABI; the guarantee is one
named world per identity/ABI/live frame, not one across all historical ABIs.
Worlds already created by an older random-name implementation are not removed
by this change; the fix bounds subsequent compatible-worker reuse.
The reader accepts an explicit copied identity and has no random fallback.
Identity grants no root, child, document or input authority.

Version change or abnormal database close revokes new reads and publication.
The original root groups and private clients retain independent cleanup leases;
late allocation replies and actual release/detach acknowledgements still settle
before cleanup completes. Entire-database deletion or arbitrary same-origin
writes by a privileged peer are outside the persistence contract. Closing a
database connection or releasing object groups does not destroy existing worlds.

The root-lifetime fixture keeps three generations in one original page, with
caller-owned Runtime events, six original moves, three native PNGs, a single
trusted form submission, End hiding and exact cleanup. Each new implementation
generation observes optional realm readiness within the existing bounded test
budget before input; legacy source is explicitly labelled `legacy-module`.
This fixture precondition does not add waiting to production input. It covers
compatible worker replacement on a live root document; navigation, root/document
replacement, child-world reuse and broader native-event coexistence remain
separate acceptance items.

The dedicated runner mode is `OBU_TEST_COLD_WORLD_LIFETIME=1`, with optional
case selection fixed to `OBU_TEST_CASES=^js-cold-world-lifetime$`. It also retains
the original raw-navigation precondition and cannot combine with other diagnostic
modes. Fixed run `e6vgkl` passes 2/2, actual exit 0: independent review confirms
one original world name/context ID/unique ID across three workers, three native
PNGs, thirteen original inputs, one trusted POST and complete resource cleanup.
Its continuous 6,689 ms focus interval has no events or allowances. Cold layouts
`4UhUBJ` and private lifecycle `fCGIFC` also pass 2/2 and independent review on the
same production source. They preserve six original frame PNGs/submissions and
the existing held-input recovery barrier respectively; neither substitutes for
the world-cardinality evidence. Node groups pass 3,881 tests plus one existing
Windows symlink-privilege skip.

Final default `SfCCYW` passes the unchanged 180-case sequence with actual exit 0
and no source/runtime drift. Independent review verifies original frame PNGs,
inputs, submissions, body reads and cleanup receipts on the same 54 production
files. The 540,693 ms focus ledger preserves only the original twelve activation
and four control-popup allowances, each matched to its exact target and interval.
The intentional host restart retains its first-generation termination; the second
exits 0, seven connections close and exact test processes are absent. This closes
the compatible-worker increment, not the remaining native lifetime boundaries
or broader parity goal. Existing published preview archives are unchanged.

### Same-document root replacement

`OBU_TEST_COLD_ROOT_REBUILD=1` runs the raw-navigation precondition followed by
`js-cold-root-rebuild`; optional case selection must be exactly that second
name. The fixture keeps the native Document, loader, default context and passive
realm alive while one trusted application click replaces documentElement. The
new button has different position and size. Separate default-context reads
identify both original roots/buttons; their explicit fixture groups add observed
round trips and are released through their original native acknowledgements.
Production node IDs must agree with those observations. Two original PNGs and
one final trusted submission check the visible result and preserved input flow.

First run `R58uno` remains an actual exit-1 failure: its screenshots and business
flow pass independent review, but the oracle rejects five repeated finalization
detaches after the original End detach has succeeded. The revised oracle keeps
every rejected native receipt as `ok:false`. It separately classifies only the
exact same-tab not-attached error after that successful detach acknowledgement,
with End request/ACK evidence, no pending resources or subsequent attachment/input,
and empty final inventories. No failed read or first detach is waived.

Visual observation failures cannot skip the original screenshot attempts,
business submission or End. The shared End helper's opt-in deferred assertion
path sends End once even if the initial visibility/read check fails, retains
that original failure, and records secondary End/hide errors. Existing default
ordering is unchanged. Ten tracked deterministic checks cover these failure
combinations and held replies; eleven fixture checks cover original identities,
native receipts, business bytes and exact absence classification. Simulated
clock checks do not establish native hidden duration.

This increment changes acceptance code only. It establishes the next cold read
after same-document root replacement; it does not establish continuous DOM
tracking, navigation, BFCache, an already-read child replacement or a root
replacement while the original native read is still pending.

Fresh `0l1om9` passes 2/2 with actual exit 0 and no source/runtime drift.
Independent review joins 175 original calls/settlements (170 successful ACKs
and five preserved absence rejections), twelve released groups/33 handles,
twelve inputs, two native PNGs and one 4,520-byte POST with eleven trusted DOM
events. Root/button IDs change while Document, loader and both native contexts
remain the same. End stays hidden for 556 ms; the 4,453 ms focus interval has
zero events and zero allowances. The host exits 0, both connections close and
the exact run's processes are absent. A concurrently running related suite is
explicitly excluded from this run's process-absence claim.

Related `fi8VZ5` passes the original 22 selected cases with actual exit 0; Node
groups pass 3,902 tests with one existing Windows symlink-privilege skip. All
54 production files match the earlier full `SfCCYW` 180/180 baseline. That full
suite was not rerun for this acceptance-only change. Published preview archives
are unchanged.

Independent related-suite review confirms that its names/order exactly match
the previous 180 cases filtered by the original selection plus mandatory raw
navigation. Six original frame PNGs/POSTs (14,185 bytes), all thirteen End
documents, and the selected input/visual workflows pass. Across those workflows,
80 native inputs and 21 original POSTs (64,164 bytes) are checked; sixteen PNGs
are inspected, six also joined to recorded native screenshot ACK bytes. Controlled
synthetic replies remain separate. Unselected keyboard-chord, drag and screenshot
drain cases are not counted. The 94,055 ms focus interval retains only the original
two popup activations/two Pause-control focus allowances, each matched to its
target, sequence and interval. Intentional host restart retains generation one's
termination; generation two exits 0, all four connections close and exact test
processes are absent. No broader capability-parity conclusion follows.

### Cold same-tab full navigation

The separate `OBU_TEST_COLD_NAVIGATION=1` mode retains the mandatory raw-navigation
case and one cold attachment across an A-to-B same-origin full navigation. A's
first read and original resource releases finish before navigation. B has a new
native Document, loader and default/passive context unique IDs, the same named
world, and exactly one current passive context. Numeric context/frame/node IDs
are not required to change. Different authored button geometry is joined to the
original production node and box reads.

`Ri2zjD` passes 2/2 with actual exit 0 and no source/runtime drift. Independent
review checks both original screenshot replies and PNGs (18,039/17,986 bytes),
the B checkpoint before its first input with no visible inherited A feedback,
and the unique B POST (2,671 bytes, eight trusted DOM events). Nine original
Input calls match the workflow without replay. The checkpoint is an observation
before B input, not continuous observation of every navigation frame.

The shared test context reducer now prefers the supplied unique destruction ID
over a potentially reused numeric ID. A deterministic late-old-event regression
fails with the former reducer; malformed supplied unique IDs fail explicitly,
and legacy numeric fallback remains only for an absent field. Original native
event records are unchanged. This fixes an acceptance oracle, not a demonstrated
production defect or native event-reordering claim.

On the same final sources, world-lifetime `6jh6nS` and root-replacement `BFDPU7`
each pass 2/2 with actual exit 0; Node groups pass 3,919 with one existing Windows
symlink-privilege skip. Production code still matches the previous full `SfCCYW`
180/180 baseline; that full suite was not rerun for this acceptance-only change.
Navigation while an original read is pending, BFCache, child replacement and the
complete parity matrix remain open. The user requested a fresh Windows preview
containing the already validated persistent-world production fix and current
acceptance coverage; release assets carry their own build/source manifest.

Native review matches 143 original calls/settlements: 138 successful ACKs and
five preserved exact post-detach absence errors. Nine groups/25 handles receive
their original release ACKs. A drain precedes B's one native navigation; the
actual context-clear and frame-commit events establish the new live context set.
End stays hidden 565 ms; the 3,706 ms focus interval has zero events/allowances.
The original host exits 0, both connections close and exact run processes are
absent. Related world/root runs retain their original identity assertions and
zero-focus rules; all 54 production files match the full production baseline.

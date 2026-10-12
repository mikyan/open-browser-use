# Created page readiness and task continuation

## Goal

Advance P08/P12/P15 of the full Browser Use parity objective: an Agent prepares
for a page opened by its controlled source page, triggers the original action
once, receives the corresponding child page, and continues work there without
searching all user tabs or guessing by URL. Preserve the existing no-OS-mouse,
no-selected-user-tab-change, ownership, cancellation and explicit recovery rules.
No Pi adapter or PR; keep published preview archives unchanged.

The previous download-isolation slice is committed as `06ca074`, with its
original browser 3/3 and Node 79/79 evidence. Installation instructions do not
establish any new Browser Use capability. This plan is an additional slice;
it does not close the active original-file plan or the full P01–P15 objective.

## Boundary before this slice

The production CRX patch disables implicit opener attachment. `getTabs` returns
owned pages; a caller can explicitly `claimUserTab`, but there is no scoped
arm/collect/cancel created-page wait or typed `expectPage` interface. The earlier
child authorization fixture creates its tab using `chrome.tabs.create`, so it
cannot prove browser-created page provenance or an end-to-end page-triggered
continuation workflow. Renderer `window.open` can still activate the foreground.

Chrome's [onCreatedNavigationTarget event](https://developer.chrome.com/docs/extensions/reference/api/webNavigation#event-onCreatedNavigationTarget)
provides source tab, source frame, source process and new tab IDs. It does not
provide a source document ID. Frame IDs survive navigation; Chrome also warns
that webNavigation timestamps cannot be directly compared to the extension's
wall clock. These fields establish a native relationship, not proof that one
particular action caused the event. Capture and validate the actual source
document and handle source navigation explicitly; do not invent a document ID
or claim an atomic source-document relationship from a later snapshot.

## Work and acceptance

- [x] First verify the native route on unchanged production: two tasks opening
  the same child URL from root, existing OOPIF and newly inserted OOPIF. Use one
  trusted Control-click per source. Record original native creation events,
  source frame/document observations, child document bytes/nonce, one follow-up
  business POST and exact tab cleanup. A passive fixture observer followed by
  explicit public claim is feasibility evidence, not the missing product API.
- [x] Introduce bounded scoped ready/collect/cancel registration. Readiness
  means the listener and original source authority are established before the
  trigger can run. Keep one original timeout, finite retention, deterministic
  overlap policy, first matching native child and explicit stale-handle errors.
- [x] Implement adoption of only the exact native child within original source/turn authority;
  validate site policy and competing ownership, and retain its native window.
  Do not infer ownership from URL, filename, tab order, window focus or timing.
  Interrupted adoption must not leave an unauthorized debugger attachment or
  delete a user-controlled page. Inherited group membership has real JS evidence;
  first admission of an unowned native child still needs browser acceptance.
- [x] Expose the workflow through JS/Python/Go SDKs, CLI and MCP with capability
  negotiation and original-scope returned Tab handles.
- [x] Complete five-entry browser acceptance: each caller performs ready, one
  trigger, collection and a useful action on the returned page. Windows isolated
  `AGsTeb` passes 2/2, actual exit 0, with 15 exact children and 15 original POSTs
  across JS/Python/Go/CLI/MCP and root/existing/future OOPIF. Unowned first
  admission and lifecycle negatives remain separate unchecked requirements.
- [ ] Verify same-URL concurrent tasks, unrelated children, source/frame
  navigation, closed/moved child, cancellation, timeout, paused/ended turns,
  worker/host loss and late completion. No replayed click or automatic recovery.
- [ ] Run real browser checks with continuous focus accounting and independent
  source/receipt review, appropriate unit suites and existing regression checks.
  Record failures as failures; do not compensate with focus restoration or
  call a narrow launch-flag run normal-user-profile or cross-platform coverage.

## Production contract

`tab.expectPage` observes the first eligible native created-target event
from the original controlled tab, including its frames. It must not promise
that the adjacent click uniquely caused that event. Allow one waiter per source
tab to make overlap deterministic. Pin the root document at readiness and use
a dedicated webNavigation frame/document ledger even under unrestricted site
policy; the existing site-policy navigation callback returns early in that
mode. Future frames may join under that same root, but navigation of an already
admitted source frame invalidates its eligibility and any associated candidate.
The event's process/frame fields and subsequent document verification retain
their separate evidence meanings.

Use the original deadline through candidate validation and adoption. Do not
copy navigation waits' extra selected-result validation budget into this path.
Reuse auxiliary ownership reservations and live validation without using the
about:blank creation checker or moving a new page to another native window.
Cancellation retires the observer/unfinished authorization; it does not close
an already opened page. Real lifecycle acceptance remains open beyond the
implemented deterministic registry and backend tests.

## Related unresolved risk

Drag guard recovery remains open. The guard's Symbol registry belongs to a
per-Page utility world, so a new attachment cannot be assumed to see its old
entry. The held-input journal should still block new actions after worker loss.
Whether the old trusted-drop listener actually survives that lifecycle and
affects later user input requires a separate real-browser counterexample.
Neither a timeout nor renaming the registry proves old native input cancelled.

## Feasibility outcome

`FjJons` passed both selected browser cases, actual exit 0: six original native
children, six distinct server document nonces and six unique follow-up POSTs
totaling 1,160 bytes. All six already inherited the owner group before explicit
claim, so unowned-child adoption remains unproven. All six native opener fields
pointed to the sentinel, while webNavigation reported the real task source;
the implementation must not substitute opener metadata for the native event.
The 3,454 ms focus interval
has zero activation/focus events and no allowances. Exact twelve-tab cleanup,
listener removal, original Browser.close acknowledgement and browser/host
actual exit 0 are retained. Focused Node tests pass 16/16.

The earlier `8SGEVN` failed before any HTTP request on browser-restricted port
6697. The shared fixture listener now binds a dynamic/private loopback port
before startup, with bounded bind-conflict retries and no browser policy
override. That failure and an initial listener-test assertion failure remain
unchanged. See [the native evidence reference](../../references/created-page-waits.md).
Production API implementation follows below; this plan and the full goal remain active.

## Production implementation checkpoint

The three wire methods use `getInfo.metadata.pageWaitVersion = 1`. A dedicated
bounded frame ledger is active even when site policy is unrestricted. The
registry uses one monotonic deadline and tracks actual unresolved setup/adoption
promises separately from cancellation races. Exact native child adoption never
moves or attaches the child. New ungrouped membership uses auxiliary storage v4
`created-page`, preserving a grouped source; all such persisted records are
quarantined after worker restart before recovery cleanup.

The JS, Python and Go SDKs return typed Tabs pinned to the original connection,
session, turn, epoch and local control revision. CLI/MCP negotiate and validate
the same wire contract. Full SDK tests are JS 153, Python 118, Go 204, all pass
without skips; Go vet passes. The CLI package has 347 pass/24 existing platform
or permission skips. Extension/build/fixture tests pass 1109/1109.

Two cleanup defects found during integration are fixed with preserved failures:
consumption must not be followed by another old-record validity check, and
auxiliary rollback must await the actual detach phase rather than an aggregate
that contains its own rollback. Native detach hooks also no longer launch an
untracked extra download cancellation after explicit attempts failed. Exact
failure/retry ACK tests cover those paths. Browser evidence is summarized in
[the reference](../../references/created-page-waits.md).

The final registry snapshot excludes unbound source reservations and unadmitted candidate IDs from global
detach authority while retaining actual pending work and exact invalidation.
A gated regression failed before the fix and the focused suite passes 31/31.
Final isolated JS run `T7Nh7G` passes 2/2 with six native children, six POSTs
totaling 1,160 bytes and a 3,360 ms interval without focus events or allowances.
The earlier `8oY0FF` and its source-specific audit remain preserved.

## Five-entry acceptance checkpoint

The matrix now runs five independent callers across root, existing OOPIF and
future OOPIF. Each publishes readiness before the first gate; after dynamic
frame insertion, a second prepared gate lets the passive observer record
original frame/document/OOPIF evidence before any Control-click. All caller
stages use one original 20s budget. Atomic no-replace file gates serve Python/Go;
JS/CLI/MCP callbacks enforce the same barriers and deadline.

`AGsTeb` returned 15 native children and 15 unique POSTs totaling 2,933 bytes.
The independent parsed native bridge ledger contains 429 original requests and
429 matching ACKs, including 15 arm/collect/cancel chains. Actual sequence order
proves every group was ready before its first input and every original source
state read finished before its first trigger. All 15 children inherited their
source group; this does not prove first admission of an unowned child.
The 7,888 ms action interval has zero activation/focus events or allowances;
sentinel selection is unchanged, but its viewport height changed 1222 to 1165.
Thirty exact fixture tabs, both passive observers, browser and host were cleaned
up. Original Browser.close ACK and actual browser/host exit 0 are recorded.

Focused Node suites pass 106/106 without skips; typed IPC has nine test methods
covering 32 Windows named-pipe scenarios. The Go helper was rebuilt from its
current inputs; host/production/SDK code and the published preview archives are
unchanged. The ordinary 125-case suite was not repeated for this test-only
slice. The six-child JS artifacts remain separate. Full evidence and limits are
in [the reference](../../references/created-page-waits.md).

Real lifecycle work includes unrelated/competing children, source/frame
navigation, candidate close/move, cancellation and late completion, pause and
turn changes, worker/host loss, and genuine first admission of an unowned native
child. SDK stale-handle unit tests do not replace those browser checks.

For the next unowned-child check, use the existing public
`newTab({backgroundWindow:true})` source rather than inventing an `ungrouped`
option (the current create API does not support it). The source has explicit
background-window auxiliary authority. Whether its natural Control-click child
is ungrouped must be observed in the real browser. A staged-only synchronous
observer can retain adoption entry, the original `tabs.get` acknowledgement,
empty auxiliary ownership before reservation, and the exact created-page
reservation/commit/storage acknowledgements. It must return original promises,
never gate adoption or mutate the child to manufacture a successful path.
Native onCreated is an additional witness only when its actual sequence is
before reservation. Reuse the existing exact unfocused-window creation recorder;
the sole initial tab can produce an allowed activation and must not be reported
as a zero-event interval.

Prioritize cancellation after native matching but before collection (retire
authority and preserve the child), finalize after collection (release the
user-origin child without closing it), and worker restart (persisted
created-page authority is quarantined and a new client cannot inherit it).
These are concrete next browser checks, not completed source-review evidence.

## Relevant implementation

- `apps/chrome-extension/background.js`, `auxiliary-tab-ownership.js`
- Existing navigation/download readiness registries and SDK scope lifetimes
- `scripts/browser-integration/run.mjs`, new created-page fixture/proof modules
- `docs/product-specs/browser-use-parity.md`

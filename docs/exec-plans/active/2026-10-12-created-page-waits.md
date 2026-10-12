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

## Existing boundary

The production CRX patch disables implicit opener attachment. `getTabs` returns
owned pages; a caller can explicitly `claimUserTab`, but there is no scoped
arm/collect/cancel created-page wait or typed `expectPage` interface. The current
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
- [ ] Introduce bounded scoped ready/collect/cancel registration. Readiness
  means the listener and original source authority are established before the
  trigger can run. Keep one original timeout, finite retention, deterministic
  overlap policy, first matching native child and explicit stale-handle errors.
- [ ] Adopt only the exact native child within original source/turn authority;
  validate site policy and competing ownership, and retain its native window.
  Do not infer ownership from URL, filename, tab order, window focus or timing.
  Interrupted adoption must not leave an unauthorized debugger attachment or
  delete a user-controlled page.
- [ ] Expose the same workflow through JS/Python/Go SDKs, CLI and MCP with
  capability negotiation. Each caller performs ready, one trigger, collection
  and a useful action on the returned page.
- [ ] Verify same-URL concurrent tasks, unrelated children, source/frame
  navigation, closed/moved child, cancellation, timeout, paused/ended turns,
  worker/host loss and late completion. No replayed click or automatic recovery.
- [ ] Run real browser checks with continuous focus accounting and independent
  source/receipt review, appropriate unit suites and existing regression checks.
  Record failures as failures; do not compensate with focus restoration or
  call a narrow launch-flag run normal-user-profile or cross-platform coverage.

## Proposed production contract

`tab.expectPage` should observe the first eligible native created-target event
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
an already opened page. These are design constraints awaiting implementation
and real lifecycle tests, not statements of current product behavior.

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
Production API implementation is the next step; this plan and the full goal
remain active.

## Relevant implementation

- `apps/chrome-extension/background.js`, `auxiliary-tab-ownership.js`
- Existing navigation/download readiness registries and SDK scope lifetimes
- `scripts/browser-integration/run.mjs`, new created-page fixture/proof modules
- `docs/product-specs/browser-use-parity.md`

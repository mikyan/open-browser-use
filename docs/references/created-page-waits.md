# Created pages: native provenance and pending public readiness

An Agent needs to prepare for a page opened by its current task, trigger the
original action once, and continue on the corresponding child. Production
currently has explicit creation and `claimUserTab`, but no public created-page
ready/collect/cancel interface. This reference records the first native route
verification; the [implementation plan](../exec-plans/active/2026-10-12-created-page-waits.md)
remains active.

## Native relationship

Chrome's [created-navigation-target event](https://developer.chrome.com/docs/extensions/reference/api/webNavigation#event-onCreatedNavigationTarget)
reports source tab/frame/process and destination tab IDs. It has no source
document ID or action token. A source frame ID can survive navigation, and
native event timestamps must not be directly compared with extension wall
time. Subsequent document reads are evidence of the document observed then,
not an atomic document identity attached to the original event.

The intended public contract is the first eligible native child observed after
readiness within the original controlled source/root-document lifetime. It
does not promise unique click causality. Future frames need explicit bounded
admission beneath the same root; navigation, replacement, cancellation and
scope invalidation must not silently select a replacement candidate. Public
adoption and cancellation semantics have not yet been implemented or tested.

## Real browser evidence

Windows isolated Chromium run `FjJons` completed **2/2, actual exit 0**: the
existing raw-navigation control and the new provenance workflow. Two JS owners
each opened one identical child URL from a root page, an existing OOPIF and a
newly inserted OOPIF. Both sources were prepared before either original
Control-click in each pair. There were six native creation events, six distinct
child document nonces and six unique business POSTs totaling **1,160 bytes**.

The test joins original source tab/frame IDs to native destination IDs, then
uses the existing explicit public claim and acts on that exact child. Original
server HTML, source/child document observations, trusted click records and
original request/response bytes remain in the artifacts. Foreign-owner access
is rejected in each case. All six children already inherited their source
task's native group before explicit claim; this is not first-time adoption of
unowned pages. In this run all six native `openerTabId` fields pointed to the
selected sentinel, while each webNavigation `sourceTabId` correctly identified
the actual background task source. The opener field therefore cannot replace
the original created-target event as the relationship evidence.

The continuous **3,454 ms** action interval recorded zero tab activations,
window-focus events or allowances. This excludes browser startup and teardown
and is not a whole-OS focus claim. Twelve exact fixture tabs are absent after
cleanup, and the original listener reports `hasListener=false`. Browser.close
returned its original acknowledgement, the browser child actually closed with
exit 0, and the native host also exited 0. The fixture uses the established
test Native Port adapter, not normal-user-profile installation.

Focused Node checks pass **16/16** with zero skip/cancellation. They include
real HTTP fixtures and binding a real occupied port; browser evidence supplies
the actual source relationship and trusted actions. Production host/extension/
SDK inputs are unchanged, the reused host matches its prior 61-input build
manifest, and the three published preview archives retain their checksums.
The ordinary 125-case browser suite was not rerun for this test-only slice.
The helper checks its original remaining action budget before and after each
operation. Existing `claimUserTab` still has a separate server-side timeout;
the client-side check is not proof of native cancellation or of the future
public waiter's end-to-end deadline contract.

## Preserved failures and environment correction

First run `8SGEVN` completed with actual exit 1: both cases failed with
`ERR_UNSAFE_PORT` before any fixture HTTP request or source click. The operating
system had assigned port 6697 to the HTTP server. Its empty server ledger and
normal browser close remain available; no business result from that run is
treated as successful.

The shared integration HTTP listener now reserves a loopback port directly in
the dynamic/private range 49152–65535. Binding retries are limited to sixteen
address-in-use or permission failures before browser startup. Other failures
propagate. This avoids the fixed restricted service ports in the
[pinned Chromium source](https://github.com/chromium/chromium/blob/f842f52ef39fd97b449eb27cff414bf05a98ddce/net/base/port_util.cc)
without disabling browser port policy. Additional field-trial or enterprise
restrictions can still reject a chosen endpoint. The initial listener test's
incorrect zero-listener assertion failed because Node installs its own HTTP
listening handler; the corrected test compares with a normal successful bind.

## Remaining work

Implement the public waiter and in-place child authorization, then verify the
same workflow through JS, Python, Go, CLI and MCP. Add overlapping/unrelated
creation, source/frame navigation, child movement/closure, cancellation,
deadline, pause and worker/host-loss cases. Ordinary window.open foreground
behavior, other browsers/platforms, drag guard recovery, and the complete
P01–P15 objective remain open. This successful provenance proof does not close
those requirements.

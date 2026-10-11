# Codex observation baseline

Initial baseline: a limited read-only observation on 2026-10-11, not a complete task or
performance comparison. The selected surface was **Codex In-app Browser** through
its documented CUA API. This does not establish the behavior of the separate
Codex browser extension, any other browser, or an unpublished internal API.

## Controlled fixture

A loopback HTTP server served a root document and `/child`. Each document had
one heading, one labelled text input, one button and one empty output element:

```html
<h1>Root comparison</h1>
<label>Name<input id="name"></label>
<button onclick="document.querySelector('#result').textContent=document.querySelector('#name').value">Save</button>
<output id="result"></output>
```

The root document, loaded from `127.0.0.1`, also embedded `/child` and
`http://localhost:PORT/child`, with iframe titles `Same origin` and `Cross origin`.
The child heading was `Child comparison`; it had no further frames. `PORT` was
the same dynamically assigned port for both hostnames. The fixture contained
only synthetic data and no external requests. The tab was created hidden and
closed after observation; no form input was performed.

## Observed results

`tab.playwright.domSnapshot()` included the root controls followed by **both**
iframe bodies. Each child included its heading, `textbox "Name"`, `button "Save"`
and `status`. Thus one read returned three textboxes and three buttons. The YAML
contained no AI ref tokens and did not include the iframe titles in its iframe
lines.

The initial CUA accessibility state also expanded both iframe documents. That
representation included the iframe titles, a separate `AXWebArea` per document
and numeric element indices. Those indices belong to that CUA observation; they
are not evidence of a public `getByRef` or `snapshotAI` Playwright method.

The API documentation returned for this selected browser explicitly describes
expanded iframe body content for `domSnapshot()`. It exposes semantic locators
and `frameLocator`, but did not list a Playwright `snapshotAI` or `getByRef`
method. This is an observation of this surface, not a claim that such concepts
cannot exist elsewhere in Codex.

## Implications for Open Browser Use

The public `snapshot` action continues to use a native Playwright ARIA snapshot
for the selected element or frame body. JS `ariaSnapshot()`, Python
`aria_snapshot()` and Go `ARIASnapshot()` allow explicitly scoped observation.
This is useful but does not deliver automatic recursive frame expansion.

OBU now implements a separate `snapshotAI` action with bounded recursive frame
observations and `getByRef` SDK locators bound to a returned `captureId`. The
engine retains real Playwright element/frame identities, accepts only emitted
refs and invalidates captures on new snapshots and control/frame lifecycle
changes. Existing `domSnapshot`/scoped ARIA behavior is unchanged. See the
[implementation and evidence](ai-snapshot-design.md) and
[public contract](browser-action-protocol.md).

These are OBU's own finite APIs. The recursive observation addresses the specific
gap demonstrated by this fixture, but neither the API name nor its ref format
was observed in Codex's inspected Playwright surface. OBU's integrated browser
acceptance is recorded in the implementation reference. It is separate from
this read-only Codex baseline and cannot turn this check into a matched input or
performance comparison.

No latency comparison, input task, popup behavior, browser extension parity or
P15 completion follows from this small read-only check.

## Matched form task through the Edge extension

A later 2026-10-11 comparison used the actual Codex Edge extension's documented
Playwright API, in one agent-created tab. The shared
`scripts/browser-integration/form-workflow-fixture.mjs` had SHA-256
`ff39ce320aa4d9137adad5f5355f52c484cf651fb37b8870159e1f4ad8662238`.
The three layout variants changed card/field order and the final button label
while retaining the same synthetic task and expected values. The server log
reports reduced `Edg/153.0.0.0` and `Chrome/153.0.0.0` user-agent versions;
these are not exact browser patch versions. No real account data was entered.

All three final receipts contained the exact expected values, with two accepted
frame saves before one accepted final submission. The visible receipt and
evidence pages were read through public locators. An independent audit of
`form-comparison-aVBKEz` confirmed three successful POSTs per task, untouched
decoys/billing fields, and normal server shutdown. The shared `checkFormReceipt`
function passed 3/3. This is final task success, not identical action success:

| Attempt on each variant | Observed result and completion route |
| --- | --- |
| `has` / `hasNot` / `visible` / `and` on duplicate cards | Three candidates narrowed to one; correct card selected |
| Single-select string matching the option label | Timed out; explicit `{label}` succeeded |
| Mixed string / index descriptor multi-select | Timed out; all-descriptor selection succeeded |
| Same-frame `and` | Filled the intended input successfully |
| Cross-origin frame `and` | No matches; the simple frame-scoped locator succeeded |
| Cross-origin frame button click | Reported a `div` intercepting the click; trusted `Enter` on the same button saved successfully |
| `or` final-button locator | Submitted the expected single request |

The cross-origin click failure was retried once on variant 1 after a screenshot
showed an unobscured button, with the same result. Its cause was not established.
Variant 3 also returned a detached-command error after the name fill; a fresh
DOM read showed the correct value, so the operation was not repeated. Read-only
DOM evaluation inspected control values; no script wrote fields or submitted
the form directly. Failed method attempts and ordinary UI fallbacks are part of
the result, not discarded trials.

The shared receipt checker requires trusted frame clicks but does not require
frame pointerdown. Keyboard activation produces such a trusted click, so its
3/3 result is accurate. A separate stricter pointer check found no cross-frame
pointerdown in any of the three runs: pointer conformance was 0/3, while final
task completion remained 3/3. This distinction prevents overstating the
comparison. No independent OS-focus observer ran on the Codex side, and the
existing profile had other extensions; no OS-focus or extension-conflict cause
is inferred. Different browser versions, profiles and API overhead also prevent
a fair speed claim or an overall product-parity conclusion.

An earlier attempt, `form-comparison-duuVDS`, stopped before any POST because
the fixture driver used an exact label whose text included nested options.
Both implementations' drivers were corrected to accessible combobox/listbox
roles before the three-variant comparison. Its old source hash and failure
remain recorded; this was a test-selector defect, not a product capability gap.
Raw local ledgers and `.tmp/form-comparison-audit.json` retain the evidence.

The OBU side used the same fixture hash through JS variants 1/2/3 and Python,
Go, CLI and MCP variant 1. Focused `run-j4jsMy` passed 8/8 including the mandatory
navigation case; final `run-6SwxDM` passed 77/77 with all seven form tasks. Each
task produced exactly two frame-save POSTs and one final submission with the
expected values. No fallback form actions were needed; CLI/MCP each recorded
28 actual `browserAction` calls. Independent audit checked receipt PNGs and
raw server records against the public-entry outputs. The full-run focus ledger
attributed six initial-tab activations to explicit test window creation and four
focus events to two explicit control-panel popup opens; the original sentinel
remained unchanged. This is not a whole-run zero-focus-event claim. That observer
coverage belongs to OBU's controlled Chromium test environment and cannot be
retroactively assigned to the Codex Edge runs.

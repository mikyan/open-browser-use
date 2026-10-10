# Codex observation baseline

Status: a limited read-only observation on 2026-10-11, not a complete task or
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

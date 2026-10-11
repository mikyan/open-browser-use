# Shared research workflow

The shared task compares three synthetic USB-C dock suppliers and submits a
procurement review. It makes no purchases and sends no data outside the local
fixture. The brief specifies quantity, budget, power, network, warranty and
delivery constraints. Each run generates fresh source revisions and amounts;
the correct recommendation exists only in the server's private scoring code.

The task requires reading current quotations and separate terms, ignoring
expired summaries, calculating order totals, identifying every disqualifying
condition, and citing the exact source URLs and revisions. Three layouts vary
document/frame placement and include cross-origin and dynamically added frames.
The final report contains a comparison table, source links and a recommendation.
Clients submit through ordinary form controls, read the resulting receipt, and
keep the report while closing their research pages.

## Execution and evidence

`scripts/browser-integration/research-workflow-fixture.mjs` serves the documents
and scores submissions. Its private records are unavailable through browser
routes. Driver implementations must not import the scoring module, fetch the
fixture directly, or post a report outside the page UI. The visible task and
source fields are the only inputs to their comparison.

JS, Python and Go use public typed SDKs. CLI and MCP use their own public
transport for the whole lifecycle, including acquiring control, creating tabs,
reading pages, filling the report and finalizing. They do not borrow an SDK for
setup or cleanup. Driver outputs retain observations, calculations, receipts,
API steps and intended tab disposition. These scripted drivers test browser
workflow support, not a model's ability to plan arbitrary research.

The runner separately checks the original server requests and submission against
the private oracle. A passive listener in the independent observer records real
tab creation/removal; final browser metadata must show exactly the retained
inactive report, closed research tabs and all pre-existing tabs preserved, with
their URLs, windows, groups and pinned state unchanged.
The existing continuous focus ledger remains mandatory, without new allowances.
Screenshots document report appearance but do not replace data or lifecycle
checks. Summary prose is length-checked by the fixture and separately read in
the retained artifacts; the machine score does not certify writing quality.
Partial artifacts and failed runs remain available.

## Codex comparison boundary

OpenAI's [May 4–8 browser workflow example](https://learn.chatgpt.com/docs/whats-new)
describes collecting and comparing information across background tabs with source
citations. The [May 21 changelog](https://learn.chatgpt.com/docs/changelog) also
describes structured extraction with a read-only JavaScript sandbox. These are
task-level baselines, not a specification for particular RPC names or identical
implementation. Both pages were checked on 2026-10-11.

A matched Codex run must use the same fixture and visible brief through the
currently documented browser tools. Record actual failures and fallback paths.
Different browser versions, profiles and tool overhead prohibit a general speed
comparison. OBU's isolated focus observer cannot establish Codex's OS focus
behavior. Success on this finite task does not complete P15 or the full parity
matrix; open-ended research, repetition and other platforms remain separate.

## Recorded OBU acceptance

Focused Windows Chromium 156 run `run-AOpN3n` passed **16/16**, including all
fifteen research tasks (five entrypoints, three layouts) and the mandatory native
navigation check. The independent audit checked ninety current-source GET records,
fifteen original single-submission POSTs, the private answers and all receipts.
Native lifecycle evidence showed seventy-five created tabs, sixty removed
research/brief tabs and fifteen inactive retained reports. The continuous focus
ledger contained zero activation or window-focus events during measured coverage.
This excludes browser startup and teardown, and uses the documented test-only
Native Port adapter rather than another OS native-launcher installation.

The audit froze runtime sources, seven Go binaries and the original extension
ZIP before execution, preserving historical failure records. No production
runtime changes were needed for the focused task. Three report screenshots were
visually inspected, and all forty-five rows were independently recomputed from
the recorded raw supplier facts. The report uses supplier letters in summaries
and Chinese names in table rows; the recommendation heading identifies the name.

The full `run-WWWaGP` regression then passed **104/104**, including the same
fifteen research cases and all previous eighty-nine cases. Its independent
audit again checked ninety source URLs, fifteen original POSTs and the exact
75-created / 60-closed / 15-retained tab disposition. The research cases caused
no activation events. The whole-suite ledger contained six initial-tab
activations from explicit fixture-window creation and four focus events from
existing control-panel scenarios, all individually attributed; no new allowance
was added. The focused zero-event claim must not be applied to the full suite.

CI passed 920 Node tests (771 extension, 53 scripts, 96 browser harness), 115 JS
SDK tests, 82 Python tests and all Go packages, without skips. Final targeted
checks covered the last Go caller edit and fourteen new Node tests before the
real runs. Documentation was updated after the frozen-source audits. Production
code and the prior accepted ZIP were unchanged: 1,255,479 bytes / 47 files,
SHA-256 `cef6706a1cf69717835f168c4e96bd1f20146f0dfc610e9b28b58434a2c5a0c8`.

## Recorded Codex acceptance

On 2026-10-11 the connected Codex Edge extension completed the three layouts
against the same fixture, with fresh amounts/revisions per task. Fixture SHA-256
was `e8e382c489cc752a5ea610a75b1176ea7d8feb79fa32defdda77d60a7c412e0f`;
the server hash was
`746e0161af88a245107fa1957868ebd865faba8ece980913d0ae822a0a2fd6f7`.
Evidence is retained under local run `research-comparison-vkEbLm`.

The agent read the brief and supplier links, created three source tabs, extracted
visible definition-list fields and original source links with read-only DOM
evaluation, computed comparisons outside the page, and filled ordinary controls.
Variant 3 required clicking each supplier's expand button before reading the
new cross-origin terms frame. Each task saved once, read its visible receipt,
marked the report as a deliverable and closed its brief and three source tabs.
The final tab listing contained exactly the three report pages among this
fixture's tabs. A screenshot of the third report was visually checked in the
browser tool output.

| Layout | Recommendation | Total | Ineligible supplier |
| --- | --- | --- | --- |
| 1 | 晨星设备 | 6156 | None |
| 2 | 海岬配件 | 6366 | 北杉科技: 65W PD |
| 3 | 北杉科技 | 5991 | 海岬配件: 12-month warranty |

All three visible receipts and nine comparison rows were recorded before
post-hoc server scoring. An independent audit then recomputed all nine rows from
the server's raw documents and matched the recorded DOM facts, original POSTs,
receipts and private oracle. Eighteen exact source URLs/revisions each had one
GET before submission; each task recorded one save click and one form submit.
The audit also checked fixture/server hashes against the pre-run baseline and
confirmed persisted server evidence was unchanged after forced cleanup.
Browser method failures and fallback actions were both
zero for this task. A later evidence-export expression had one JavaScript syntax
error before executing; its corrected export is retained separately from browser
action results. The existing Edge profile included other extensions and its
exact patch version was not measured. Codex tab disposition has tool acknowledgments
and a final listing, not OBU's independent native lifecycle/focus ledger. No
complete initial user-tab inventory was captured on that side, so it cannot
independently prove all pre-existing tabs were unchanged. No Codex inactive-tab,
OS-focus, process-isolation or performance claim follows.

The comparison server persisted evidence after requests. Its launch did not keep
stdin writable, so the documented `stop` command could not be delivered. After
verifying the exact process identity it was force-stopped (exit 1); `cleanup.json`
records this and no normal `closed.json` exists. This is a teardown limitation,
not a successful graceful-shutdown test. The retained report tabs show the saved
DOM, but local links cannot reload after the server stops. Future interactive
runs need writable stdin/PTY. This result extends finite multi-tab research
coverage; broader P15 and the overall parity goal remain open.

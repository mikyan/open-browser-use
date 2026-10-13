# Page exports

`exportPage` exports the current HTTP(S) page owned by the calling session. It
does not navigate, activate a tab/window, open a print dialog, or use the OS
pointer. Callers negotiate `getInfo.metadata.pageExportVersion === 1`, including
calls with an explicit control epoch. Unsupported native browser operations
return their error; there is no headless-browser fallback.

## Wire contract

The request contains `session_id`, `turn_id`, `control_epoch`, `tabId`, `format`
(`pdf` or `mhtml`), optional `maxBytes`, optional `timeoutMs`, and optional `pdf`.
Unknown options are rejected. The default and hard byte limit are 16 MiB; a
caller may lower it. The default timeout is 10 seconds, with integer values from
1 through 120,000 ms. SDK capability/control bootstrap, CLI/MCP queuing,
extension admission, native capture, stream reads and close share the original
operation deadline. Exports are not retried automatically.

The response has exactly five fields:

```json
{"format":"pdf","mimeType":"application/pdf","encoding":"base64","data":"...","byteLength":12345}
```

MHTML uses `mimeType: "multipart/related"`. `byteLength` counts decoded bytes,
not base64 characters. SDKs validate format, MIME, canonical base64 and exact
length before returning; they do not write a file implicitly. No native stream
handle, browser temporary path or reusable export handle is public.

PDF options use these CDP spellings:

| Options | Accepted values |
| --- | --- |
| `landscape`, `printBackground`, `preferCSSPageSize`, `generateTaggedPDF`, `generateDocumentOutline` | Boolean |
| `scale` | Finite number, 0.1–2 |
| `paperWidth`, `paperHeight` | Finite inches, greater than 0 and at most 200 |
| `marginTop`, `marginBottom`, `marginLeft`, `marginRight` | Finite inches, 0–200 |
| `pageRanges` | At most 1,024 digits, spaces, commas and hyphens |

Omitted print options retain browser defaults. Native validation still rejects
invalid combinations, such as margins that leave no printable area. MHTML
rejects `pdf` options. Arbitrary header/footer HTML, URLs, output paths and
transfer-mode overrides are not part of the browser RPC.

## Public callers

```javascript
const pdf = await tab.exportPDF({ pdf: { printBackground: true, preferCSSPageSize: true } });
const archive = await tab.exportMHTML({ maxBytes: 4 * 1024 * 1024 });
// Generic equivalent: tab.exportPage("pdf", options).
```

```python
pdf = tab.export_pdf(pdf={"printBackground": True, "preferCSSPageSize": True})
archive = tab.export_mhtml(max_bytes=4 * 1024 * 1024)
# Generic equivalent: tab.export_page("pdf", ...).
```

```go
pdf, err := tab.ExportPDF(obu.ExportPageOptions{Timeout: 10 * time.Second})
archive, err := tab.ExportMHTML()
// Generic equivalent: tab.ExportPage("pdf", options).
```

CLI `export-page --tab-id ID --format pdf --output report.pdf` and MCP
`export_page` require an explicit output path. They verify the whole response,
write a temporary file in the destination directory, sync and close it, then
atomically link it to a new destination. Existing files are never overwritten,
including when another caller creates the same path concurrently. Filesystems
without hard-link support return an error. The response is small metadata
(`path`, `format`, `mimeType`, `byteLength`), not duplicate base64 content.

## Lifetime and website access

At most four export records exist globally, with one per tab. Pending native
work and failed cleanup continue to consume that capacity. Each result is bound
to the original control epoch, tab ownership, debugger attachment and document
revision. Root/child navigation, frame attach/detach, document replacement,
moving a tab, ending its session or global Pause reject stale work.

PDF uses `Page.printToPDF` with `ReturnAsStream`, reads in 64 KiB chunks, checks
decoded sizes before appending, and closes the exact stream before success.
Timeout rejects the caller promptly but does not pretend the native operation
stopped. A late print result is closed without reading. Controlled detach waits
for actual native work and stream cleanup. Failed close retains a retryable
cleanup record; it cannot report a successful release. A browser/API that never
settles can keep cleanup unconfirmed.

If an external debugger detach destroys access to a still-open stream, cleanup
cannot safely target a replacement attachment. The failed record remains;
reattaching does not prove that the old stream closed. Worker restart loses the
in-memory handle and likewise is not proof of native temporary-storage cleanup.

Website restrictions permit PDF after checking the complete live frame tree
before native commands and before delivering a result. MHTML is unavailable in
restricted mode because it includes external resources beyond the checked
document origins. These checks do not stop the page's own network activity or
undo a native command already sent.

## Fidelity and limits

Agent cursor, click rings and target outlines are excluded from print layout by
a print-only rule owned by the feedback root. Screen feedback remains enabled.
Printing may resize the document and clear the old target rectangle; a later
hover computes a fresh outline. This does not remove feedback markup from
MHTML, which retains the browser's page serialization.

The unchanged production baseline `run-vNvX0d` reproduced the leak: both PDF
variants contained two image resources; with backgrounds enabled, each page
also contained 21,992 colored feedback pixels. The initial fixture failure
`run-MDNXm6` remains recorded separately (extra pagination and an incorrect
expectation that a pre-resize outline must persist).

After the scoped CSS fix, `run-4A9CWZ` passed 3/3 and related regression
`run-h0x9xz` passed 8/8, both actual exit 0. Ordinary and strict-CSP pages each
produced two PDFs, with backgrounds enabled/disabled: all eight rendered pages
had zero image resources and zero colored pixels, correct page geometry and
original business text. Screen captures retained feedback before printing and
after a separate subsequent hover. The strict-CSP page also proved its own
unapproved inline style was blocked. The 10,369 ms regression observer interval
had zero activation/window-focus events or allowances; startup/teardown are
outside that interval. Cursor/pointer module tests passed 26/26 and the PDF
oracle passed five tests. This focused regression does not replace the complete
parity matrix or ordinary installed-browser acceptance. Commands and artifact
checks are documented in the [integration guide](../../scripts/browser-integration/README.md#agent-feedback-during-pdf-export).

MHTML captures the browser's serialized page, resources and frames; it is not a
guarantee that interactive applications will work offline. Chrome returns its
snapshot as one string, so the returned artifact limit is not a browser heap or
native capture memory limit. PDF uses print layout and can differ from screen
layout. Font mappings can also affect text extraction: the headed Chromium
probe rendered Chinese correctly while some characters extracted as visually
similar Unicode radicals. Export bytes are preserved, not rewritten to hide
this limitation.

Headed Chromium 156 acceptance `run-BfrpnY` passed all 53 cases, including all
five public callers' actual PDF/MHTML artifacts, byte caps, foreign ownership,
file no-overwrite and restricted PDF checks. PDFs were parsed and rendered;
MHTML had four MIME parts with exact decoded Chinese main/iframe text. A
separately labelled test holds delivery of a real native print result to prove
late-stream close without reading after turn end. This is fault injection, not
a measurement of normal native latency. Export caused no foreground events;
the original sentinel remained active. See the active parity plan for the full
evidence and remaining platform/complete-task comparison gaps.

Native references: [Page protocol](https://chromedevtools.github.io/devtools-protocol/tot/Page/),
[IO protocol](https://chromedevtools.github.io/devtools-protocol/tot/IO/), and
[Chrome debugger API](https://developer.chrome.com/docs/extensions/reference/api/debugger).

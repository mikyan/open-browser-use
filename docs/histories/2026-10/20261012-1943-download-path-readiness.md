## 2026-10-12 19:43 | Task: Require original-file readiness before export

### Execution Context

- Agent: Codex with separate backend, SDK and acceptance contributors.
- Runtime: Windows, Node 24.14.1 and isolated Chromium acceptance.

### User Query

Continue development until Browser Use capability matches Codex. Keep the
existing project and skill, background operation and fork; no PR or replacement
of published preview packages.

### Changes and intent

- Add required original-file preparation to page download waits, negotiated by
  `downloadWaitPathVersion: 1`. A missing binding is reported before ready, so
  an Agent can avoid consuming a one-time export whose file cannot be delivered.
- Capture original Native Port/generation and page target. Preparation and final
  child-source checks share the original deadline. Binding loss retires required
  waits; a replacement serves only new requests. Ordinary observation is retained.
- Add strict boolean options and capability checks to three SDKs and CLI/MCP.
  Typed false is omitted on the wire for old-peer compatibility; explicit raw
  flags belong only to the new arm protocol. Go's options struct adds a field,
  so external positional literals must become keyed literals.
- Update file-oriented agent guidance and the existing five-entry POST/Blob
  acceptance to require a path. Add real Browser connection-loss scenarios with
  no business input, exact wire errors and a separately labelled successful
  Page.enable ACK publication gate.

Readiness is a preparation result, not a transaction with an independent click
or a promise of future download completion. No automatic authorization, retry
click, replacement GET or inferred filesystem path is introduced.

### Verification

Final Node suites pass extension1181/build204/integration1220, 2605 total without
skips. Related SDK tests pass JS158 and Python122 including separately executed
real-host cases; Go SDK111 and CLI/MCP137 top-level tests pass, with 24 pre-existing
CLI platform/permission skips. Shared original-download helper tests pass Node40,
Python8 and Go15 including subtests. Go vet passes. Fifteen SDK files, including
tracked JS distribution output, match the frozen manifest; the final runtime
records 355 sources and 124 Go/module inputs for ten newly built binaries.

Required-readiness run `99xibC` passes 3/3 with actual exit 0. Four original pages
exercise absent/cached-lost/preparing-lost/ready-lost bindings, reject the old
waiter after rebind and permit only a new one. There are zero business inputs,
POSTs or downloads from these pages. All cleanup and the unchanged original
transfer/NetLog checks pass, with 4007ms of zero activation/focus/allowances.
The held ACK had already completed natively; controlled publication and real
relay closure do not establish naturally occurring failures.

Five-entry `2WEsDf` passes 2/2 with actual exit 0: thirty original files/5200 bytes
across five callers, three frame layouts and POST/Blob, preserving six all-ready
barriers. File bytes, Page GUID/source and caller scope are checked independently.
Its 13350ms focus interval has zero activation/focus events and no allowances.
The existing missing-file case deliberately deletes one delivered original file.

Two harness failures are retained. Integration units first pass 1218/1219 because
port-zero allocation selected a Fetch-restricted port; existing safe-listener
reuse repairs automatic endpoints and preserves explicit-port errors. Browser
`KMGg88` remains 2/3, actual exit 1, because four new relay records entered the
old exact-two NetLog collection. Creation-time grouping, all-relay cleanup and
final snapshot equality fix the evidence routing without weakening that gate.

Retained red-run evidence records two candidate defects found and fixed:
returning ready after root identity changed while a new child's Page.enable ACK
was pending, and accepting a replacement root during attachment preparation.
Both red runs exit 1; the corrected implementation verifies the original target
after all current child setup settles. Initial missing-option/capability red
tests are feature regressions, not natural browser failures.

Final full `9YXWxm` passes 128/128, actual exit 0, with all prior `Ghqqmo` names
and order unchanged. Its 303905ms focus ledger uses only the original twelve
task-window activation and four control-popup focus allowances. This full run
uses ordinary observation; it does not replace the separate bound-file tests.

### Key files

- Extension `background.js` and `browser-download-waits.js`
- Three SDK download-wait options and CLI control negotiation
- `scripts/browser-integration/required-download-readiness.mjs`
- Original-download callers and independent file proof
- `docs/references/original-page-download-delivery.md`
- Skill download workflow in `references/sdk-and-protocol.md`

The whole P01–P15 objective and ordinary-start Browser authorization remain open.

## 2026-10-14 01:34 | Keep agent feedback out of PDF exports

### Execution context

- Agent: root with isolated read-only/restricted-file subagent tasks.
- Runtime: Codex desktop, Windows; model identifier not asserted.

### User request

Continue improving Browser Use toward parity while the user cannot perform
manual Edge installation/authorization. Push work to the existing fork; no PR.

### Changes and intent

The actual unchanged-browser baseline printed the agent cursor and colored
feedback into a business report. Add a print-only exclusion scoped to the
owned feedback root; screen behavior and original native export remain intact.
Add a retained-artifact regression for ordinary/strict-CSP documents, including
PDF parsing/raster checks and subsequent screen feedback. Preserve the initial
fixture failure separately from the confirmed product counterexample.

### Validation

Cursor/pointer tests 26/26; PDF oracle tests 5/5. Baseline `vNvX0d` fails with
actual exit 1; fixed `4A9CWZ` 3/3 and related `h0x9xz` 8/8 pass with actual
exit 0. Four PDFs/eight pages in each fixed run preserve original report text
and have no cursor images/colored feedback; the regression's 10,369 ms focus
interval has no activation, window-focus event or allowance. No full-suite or
ordinary installation claim. Old preview archives remain unchanged.

### Key files

- `apps/chrome-extension/content-cursor.js` and adjacent tests.
- `scripts/browser-integration/cursor-print-fixture.mjs`, PDF oracle and tests.
- `scripts/browser-integration/run.mjs` and integration guide.
- `docs/references/page-exports.md` and the completed execution plan.

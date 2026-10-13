# Keep agent feedback out of printed reports

Status: complete for this slice; overall browser parity remains active.

The ongoing parity work includes preserving visible agent feedback during real
browser tasks. A report exported after input must contain business content,
without the agent cursor or target outline appearing in its printed pages.

The isolated public SDK/native-host fixture fills and submits a two-page
achromatic report, hovers its button and retains two PDFs and screen captures.
The oracle requires original business text and geometry, renders exact PDF
bytes, rejects colored pixels and detects image resources (including grayscale
cursor assets). A strict-CSP variant proves page inline styles without its
nonce are rejected while the extension's scoped print exclusion works.

- Initial `run-MDNXm6` failed on fixture pagination and an incorrect expectation
  that a target outline survive the existing resize invalidation. Preserve this
  failure. The corrected fixture records the surviving cursor immediately after
  printing, then requires a separate fresh hover to create the next outline.
- Baseline `run-vNvX0d`, actual exit 1: two image resources in both PDFs;
  backgrounds-enabled PDF has 21,992 colored pixels on each of two pages.
- Production change: five lines in `createCursorParts` create a print-only style
  owned by the feedback root. No input, native print, focus or page CSS changes.
- `run-4A9CWZ` 3/3 and related `run-h0x9xz` 8/8, actual exit 0: four PDFs/eight
  pages per run are clean and complete; screen feedback survives. Final related
  run includes existing public JS/CLI/MCP exports, lifecycle cleanup and pointer
  feedback; 10,369 ms observer interval has zero focus/activation/allowances.
- Module tests 26/26 and PDF oracle tests 5/5 pass. Source/runtime hashes were
  frozen per run. The original preview archives were not rebuilt.

The existing native Port test adapter remains explicit; these runs are not
ordinary installed-browser acceptance. MHTML retains serialized feedback
markup. The whole suite was not rerun for this CSS-only production change.
Website-policy startup recovery and top-layer feedback visibility remain
separate follow-up candidates; complete P01–P15 parity is not established.

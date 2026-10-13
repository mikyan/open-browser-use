# CLI/MCP file chooser clearing

## Goal and boundaries

Continue the complete Browser Use parity objective by closing the P10 gap where
the backend and SDKs can clear a file input but CLI/MCP convenience entry points
reject an empty selection. The full P01–P15 objective and P12 background focus
issues remain open. Ordinary Edge manual acceptance is deferred at user request.

An explicit clear must submit `files: []` for the original intercepted chooser.
Omitting file arguments remains an error. Clearing is the existing exact-node
operation with programmatic input/change notifications, not native chooser
cancellation or a new trusted-input guarantee. Existing scope, deadline,
single-submission and no-replay behavior remain in force.

Only root launches isolated browser tests; no system mouse, daily profile or
installation changes. Preserve delivered preview packages; no PR. Commit and
push the verified change to the user fork.

## Milestones

1. [x] Confirm the current worktree and actual convenience-entry validation gap.
2. [x] Retain failing tests, add CLI explicit `--clear` and MCP explicit `files: []`.
3. [x] Verify real CLI/MCP upload then clear in root, OOPIF and dynamic OOPIF.
4. [x] Run appropriate regressions, independently audit original evidence.
5. [ ] Update usage/history, commit, push and archive this slice.

## Decisions and progress

- 2026-10-13: Previous goal turn made progress: keyboard validation and cleanup
  were implemented, fully verified and pushed; current clean HEAD is `171d18a`.
- Both the Cobra command and action-plan runner reject zero paths; MCP has
  `minItems: 1` plus a nonempty array validator. Existing browser CLI/MCP chooser
  tests use generic `call`, so they cannot prove the convenience tools work.
- Backend agent owns Go CLI/MCP and tests. Fixture agent adds two convenience
  scenarios reusing the original upload/clear workflow; root wires the runner,
  builds the exact binary and validates browser/process/focus evidence. A third
  agent reviews parsing and input semantics independently.
- Keep all original 130 browser entries. New convenience entries must invoke
  named CLI commands/MCP tools and verify actual FileList plus original POST
  bytes. No raw setter fallback or new focus allowance.
- Go red tests exit 1 on original validation and MCP path reinterpretation.
  Final six top-level groups/28 subcases, entire CLI package and vet pass.
  Independent review caught mixed positional/flag path reordering; the parser
  now rejects that ambiguity before I/O. Full Go tests: 803 test/subtest passes,
  27 existing Windows platform/permission skips, exit 0 and source hashes stable.
- First browser run `en3ccC` exits 1, 3/5: both new workflows reach upload/clear
  receipts, then the new helper incorrectly compares the SDK's pre-bootstrap
  null epoch with its admitted epoch. The final FileList read has not run in
  this failed attempt. Preserve it; the helper now checks the first actual
  admitted scope and every subsequent variant/owner, with no added browser call.
- Final integration-script tests: 1383 pass/one existing Windows symlink skip,
  exit 0, no failure/cancellation or source drift. Focused `IlKHn0` passes 5/5,
  actual exit 0. Six convenience workflows produce 12 exact POSTs/4954 bytes,
  including 194 original file bytes; all six original documents have empty
  FileLists. Six tabs/four child targets are absent after explicit finalization.
  10938ms has zero activation/focus/allowances; original host EOF exit 0.
  Production is frozen.
- First full `Fg2gSR` exits 1, 128/132: four shared main-SDK operations reject
  its stale epoch. Both new convenience entries pass. Independent read-only
  decoding of the private profile's original control ledger proves the cause:
  Pause leaves main epoch 479 idle; at 64 records, directory session 553 evicts
  it; the later CLI bootstrap recreates that session at 563. Early main-client
  `beginTurn` did not reserve an active slot. The runner now records the known
  Pause boundary and explicitly resumes immediately before the first shared
  page goto, with no caught failure, action replay, capacity change or new focus
  allowance. This is a fixture lifecycle correction, not a production fix.
  The failed full run's 356729ms focus ledger still passes the original limits.
- Final full `7LDGsE` passes 132/132, actual exit 0. Original 130 names/order
  retained; all four previously stale shared-client cases now pass. Explicit
  resume is recorded before the original navigation, with no replay. Twelve
  convenience POSTs/4954 bytes, 194 file bytes and all six original empty
  FileLists/closed tabs plus four closed child targets pass root audit again.
  Source/runtime hashes are stable; 362296ms contains only the original
  12 attributed activations/four control-window focus events. Native host
  intentionally restarts in its existing case; exact successor exits 0 and
  all connections close. Final integration scripts remain 1383 pass/one skip,
  actual exit 0 after the runner correction. Independent final review passes:
  459 source/runtime/manifest/build identities, original receipts and file bytes,
  exact cleanup and focus attribution match. No private test process remains.
  The ordinary runner does not separately record Chromium's actual exit code;
  verified wrapper/host exit codes do not imply a Chromium exit-code claim.

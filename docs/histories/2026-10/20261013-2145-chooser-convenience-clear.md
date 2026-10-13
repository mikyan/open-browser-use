## [2026-10-13 21:45] | Task: Clear file selections through CLI and MCP

### Execution Context

- Agent: Codex `/root`, with Go implementation, browser-fixture and independent reviews.
- Runtime: Windows, Go 1.26.9, Node 24.14.1, isolated Chromium 156.

### User Query

Continue toward complete Browser Use parity while preserving background use.
Defer unavailable manual Edge acceptance, keep the existing packages, and push
the user fork without opening a PR.

### Changes Overview

- Expose explicit CLI/action-plan `--clear`, mutually exclusive with supplied
  file paths. Missing files remain an error rather than an implicit clear.
- Accept explicit MCP `files: []`, require the field and reject null. Pass the
  structured chooser ID and paths directly without parsing them as CLI options.
- Reuse the backend's exact-node, single-submission clear contract and existing
  ownership/deadline handling; no new extension operation or automatic retry.
- Add named CLI/MCP convenience upload/clear scenarios alongside the retained
  generic-call tests, covering root, OOPIF and dynamically created OOPIF inputs.
- Update the file-transfer reference and Agent usage examples.

### Design Intent

The previous backend could clear a selected input while the convenience entry
points rejected all empty lists. Generic-call browser tests hid that mismatch.
Explicit syntax distinguishes clearing from accidentally omitted arguments.
MCP parameters remain data even when their text resembles command-line options.

### Verification

- Original Go regressions fail with actual exit 1. Final six groups/28 subcases,
  CLI package and vet pass. Full Go tests pass 803 test/subtests with 27 existing
  Windows platform/permission skips, actual exit 0 and unchanged sources.
- Final integration scripts: 1383 pass/one existing Windows symlink skip,
  actual exit 0, no failures/cancellations or source drift.
- Focused Chromium `IlKHn0`: 5/5, actual exit 0; six named convenience workflows,
  12 original POSTs/4954 bytes including 194 file bytes, all six exact documents
  have empty FileLists after clear. Six tabs/four child targets are absent after
  finalization. 10938ms zero activation/focus/allowances; original host EOF exit 0.
- First run `en3ccC` remains an actual-exit-1 result: the helper compared an
  initial null epoch against the admitted scope after lazy bootstrap, before its
  final FileList read. That assertion is fixed and tested without adding browser
  calls; the failed run is not counted as completed acceptance.
- First full `Fg2gSR` exits 1, 128/132. Four shared-client operations use an epoch
  evicted after Pause at the existing 64-session idle-record limit. Original
  private-profile ledger history independently proves eviction of epoch 479 on
  creation of session 553, followed by CLI recreation at 563. The runner defers
  its explicit post-Pause resume until the next shared page operation; it never
  catches/replays a rejected action or weakens capacity protection. The failed
  run and its passing 356729ms focus ledger remain preserved.
- Final full `7LDGsE`: 132/132, actual exit 0, original 130 names/order retained.
  The four stale cases pass after explicit resume before shared navigation.
  The same six convenience workflows again verify 12 POSTs/4954 bytes, 194 file
  bytes, empty original FileLists and exact tab/target cleanup. Source/runtime
  hashes stay unchanged. The 362296ms focus ledger uses only the original
  12 activation/four control-window focus allowances. Intentional host restart
  retains exact original/successor identity; successor exits 0, connections close.
- Independent final review passes 459 source/runtime/manifest/build identities,
  original receipts and file bytes, exact cleanup and focus attribution. No
  private test process remains. Chromium's separate actual exit code is not
  recorded by the ordinary runner and is not claimed.
- Delivered preview ZIP hashes remain unchanged. Documentation, repository
  hygiene, Action pinning and diff checks passed.

### Boundaries

Clear retains programmatic input/change notifications. It does not claim a
trusted user event, undo a submitted upload, or replace ordinary native
installation acceptance. Full P01–P15 parity and P12 focus issues remain open.

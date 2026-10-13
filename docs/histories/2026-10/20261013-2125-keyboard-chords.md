## [2026-10-13 21:25] | Task: Validate complete keyboard chords before input

### Execution Context

- Agent: Codex `/root`, with runtime, backend and independent fixture reviews.
- Runtime: Windows, Node 24.14.1, isolated Chromium 156.

### User Query

Continue development until Browser Use capability matches Codex, maintaining
background operation without taking the system mouse. Push the user fork without
a PR and preserve the delivered packages. Defer unavailable manual Edge testing.

### Changes Overview

- Validate every chord token using the actual pinned parser and key description
  lookup before any native key. Locator press validates before focusing.
- Preserve legal plus syntax, aliases, repeats and successful pre-held-key
  semantics. Invalid keys have no native input and do not release prior state.
- Give production press a private original-action/attachment/deadline admission.
  Confirmed held input remains usable; unknown or pending input cannot start a
  chord. Recheck after asynchronous native admission and each actual ACK.
- Classify partial execution as unconfirmed and clean up only the original
  attachment. Protect successor attachments and retain pending native completion.
  Fill Delete inherits its existing ticket; type's existing press branch shares
  the protection. No keys are replayed or guessed.
- Prevent error-code text embedded in an invalid key or nested cause from
  triggering the wrong cleanup path.
- Add nine browser scenarios with original DOM/native evidence, exact POST
  bytes, bounded negative observation and unchanged focus/cleanup gates.

### Design Intent

The original implementation discovers an invalid final key after already pressing
earlier tokens. A held Control can then convert ordinary typing into a shortcut.
Complete preflight validation prevents that partial action. Native failure after
execution starts remains uncertain, so the existing attachment cleanup is used
instead of assuming a rejected command had no effect or reconstructing old state.

### Verification

- Preserved actual-exit-1 regressions for original modifier leakage and nested
  error-code misclassification. Final build tests 265/265, extension 1233/1233,
  integration scripts 1376 pass/1 existing Windows symlink skip, actual exit 0.
- Focused Chromium `l3BraN`: 9/9 entries, including nine keyboard scenarios;
  five invalid phases with zero native input and two controlled partial failures
  with real ACK, original cleanup and explicit successful recovery. Nine exact
  original POSTs/36074 bytes; 32 probed native key commands.
- Original nine tabs/targets cleaned; 74999ms zero activation/focus/allowances;
  original host EOF exit 0, sources/runtimes unchanged. The same run includes
  existing fill, hover/Pause, pointer, counted pointer, drag and navigation checks.
- Full Chromium `BGZwxy`: 130/130, actual exit 0, original 129 names/order
  retained and source/runtime hashes unchanged. The nine keyboard cases again
  passed with exact POSTs, native commands and complete tab/target cleanup.
  The 350576ms focus ledger uses only the existing 12 tab activation and four
  control-window focus allowances. The intentional host restart retains exact
  original/successor identity; the successor exits 0 and all connections close.
  See the [keyboard contract](../../references/keyboard-chords.md).
- Independent full-run review verified source/staged/runtime identities, exact
  request/native/DOM/POST evidence, unchanged focus allowances and process cleanup.
  Documentation, repository hygiene, Action pinning and diff checks passed.

### Files Modified

- `scripts/patch-keyboard-press.mjs`, tests and extension build wiring.
- Native input tracker, engine action admission and backend hooks with tests.
- `scripts/browser-integration/keyboard-chord-fixture.mjs`, tests and runner.
- Keyboard reference, architecture, capability matrix, READMEs and execution plan.

### Boundaries

Cleanup after partial execution releases existing input on the original
attachment too; it cannot restore an unknown pre-action state or undo page
effects. Controlled post-ACK rejection is not a natural native failure or an
installation test. Platform simulation is not macOS browser acceptance.
P12 focus behavior, ordinary Edge manual acceptance and full P01–P15 parity
remain open. The three delivered preview ZIP hashes are unchanged.

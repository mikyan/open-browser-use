## [2026-10-14 00:16] | Task: Preserve first-key native and page delivery evidence

### User Query

Continue Browser Use development while manual ordinary Edge acceptance is
unavailable. Keep background operation, the user fork and existing preview
packages; do not open a PR.

### Changes and intent

- Move the existing keyboard probe before the original navigation and record a
  separate setup phase for the one original End press. Preserve its five-second
  budget and original navigation/read/input order without a new pre-End wait.
- Add bounded passive head key/focus evidence and the original bottom listener
  installation marker. Preserve original strict down/up and business assertions;
  head evidence cannot replace an absent original event. Setup diagnostics do
  not suppress the original POST when a DOM event is missing.
- Add optional browser-native input tracing. Retain original stream bytes,
  exact start/end clock markers, no-loss metadata, bounded reads and one stream
  close. Preserve failures and partial bytes; an unacknowledged start remains
  unconfirmed. The runner preserves metadata even when its separate save fails.
- Keep production input behavior unchanged. The previous full-run failure
  remains unresolved; successful instrumented runs are diagnostic evidence only.

### Verification and limits

- Fixture 21/21 and trace helper 43/43; combined 64/64, actual exit 0. Negative
  tests retain missing-down failure after the unique original POST, setup error
  cleanup, strict native ordering, loss, missing markers, partial streams,
  bounded reads and failed close/save. The helper's first unit attempt retained
  one test-data failure where too-small chunks reached the read-count limit
  before the byte limit; only that test's chunk size changed.
- Predeclared keyboard-only `UplYfR`: 2/2, actual exit 0. Screenshot-prefix
  `5eI49Q`: 5/5, actual exit 0. Both retain mandatory raw-navigation control,
  unchanged source/runtime inputs, nine original End down/up pairs and nine
  unique original POSTs (100,836 / 100,985 bytes).
- Each run records 18 setup plus 32 business/cleanup key commands and native
  settlements. Both original traces contain two unique ordered markers, 50
  keyboard-forward events and zero `Input Suppressed` events, no native data
  loss, complete EOF and an acknowledged close. Event counts alone do not map
  browser-wide events to a document. Raw trace IDs may exceed safe JavaScript
  integer precision; the audit does not join them through rounded JSON Numbers.
- Strict focus ledgers cover 19,923ms / 65,518ms with zero activation, window
  focus or allowances. Original probes and exact tabs/targets are cleaned up.
  No matching isolated test processes remain.
- `bDKdec` still stands as 137/138, actual exit 1, with missing initial End
  keydown through its final POST. The two new contexts did not reproduce it;
  instrumentation may affect timing. Enable the diagnostic on the next
  independently required full regression rather than repeat until green.

### Main files

The keyboard chord fixture and tests, new keyboard input trace helper and tests,
integration runner, keyboard reference, active diagnosis/parity plans, quality
score and debt tracker. Ordinary Edge acceptance and overall parity remain
open; delivered preview packages are unchanged.

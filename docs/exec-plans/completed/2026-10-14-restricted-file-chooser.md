# Native file chooser on allowed websites

- Status: complete (this slice only; parent parity remains active)
- Started: 2026-10-14
- Completed: 2026-10-14
- Parent: [Browser Use parity](../active/2026-10-10-browser-use-parity.md), P10/P14/P15.

## Outcome and scope

Allow the existing native file chooser API on permitted websites. Direct
locator uploads already work in restricted modes; the missing workflow is an
allowed page opening its original file input through a user-facing button.
Keep the existing public APIs and unrestricted behavior. Downloads are a
separate capability and are not silently enabled by this change.

## Contract

- Fix original attachment, frame, document, backend node and policy identity
  before asynchronous validation. A replacement document cannot inherit an old
  chooser, including a same-URL reload.
- Deliver only the original native chooser after complete allowed-tree checks.
  Revalidate before file submission and after native and cleanup ACKs. Never
  retry an input operation or substitute a new node.
- Cancellation retains original ownership and performs actual cleanup after
  permission revocation. Late completion must not affect a successor attachment.
- Preserve deadlines, readiness ACKs, one-shot consumption and native file byte
  semantics. No OS pointer, focus restoration, input replay or new focus exception.
- Only root runs isolated browsers. Ordinary Edge manual authorization remains
  deferred at the user's request. Preserve preview ZIPs; no PR.

## Work and acceptance

1. Engine collaborator owns production and backend regressions; fixture
   collaborator owns separate fixtures and typed public callers. Root owns
   runner/build wiring, real browser runs and documentation. Independent review
   checks both design and retained run evidence.
2. Preserve deterministic and real old-source failures before production edits.
3. Exercise JS, Python, Go, CLI and MCP on root, existing OOPIF and dynamic OOPIF
   pages. Native chooser selection and clear must reach the original server with
   exact bytes and original node/document identity.
4. Cover denied frames, replaced documents, policy revocation and delayed ACKs;
   retain original failures and actual process exit codes.
5. Run relevant suites and full browser regression for shared backend changes.
   Update capability documentation and history, then commit and push to fork.

## Progress

- Baseline: clean local/fork `88ad04d`; last complete browser run 169/169,
  Node 3363 pass/one existing Windows skip. The parent parity goal stays open.
- Read-only inspection confirms chooser operations remain explicitly rejected
  in restricted modes while locator uploads are implemented.
- Old-source real `pJfIwM` retains 2/3, actual exit 1: first arm rejects with
  `OBU_SITE_ACCESS_UNSUPPORTED`, before any chooser or upload. Independent audit
  verifies original production against `88ad04d`, zero POSTs, policy restoration,
  exact cleanup and a 5093ms ledger with zero activation/original two popup focus
  permissions. All source/runtime/build identities are unchanged during the run.
- Old-source backend tests retain 1 pass/11 failures, actual exit 1. Besides
  restricted API rejection, they expose a real all-mode drain gap: the caller
  times out while its original native write remains pending, but Pause succeeds.
  Actual registry operations must be joined before reporting cleanup complete.
- Fourteen Go artifacts build successfully with unchanged inputs. Production
  implementation is frozen after 263 related tests pass. An additional original
  red test proves the engine release hook also needed to drain the same native
  write; the fix joins its original attachment before releasing the page.
- First real candidate `xhbkjb` retains 7/8, actual exit 1. All five public
  callers complete all fifteen upload/clear layouts. The boundary oracle wrongly
  requires the recovery's new turn ID to equal the old one. It also incorrectly
  treats the popup helper's UI timeout as a backend response. Corrections are
  confined to fixture expectations: the original backend cleanup-timeout error,
  held ACK, unchanged runtime/durable policy and unique original upload remain
  mandatory. Production is unchanged.
- Full Node groups pass 3398 with one existing Windows symlink-privilege skip,
  actual exit 0 and no source/runtime changes. Corrected fixture tests pass
  35/35; its entire affected integration group passes 1598/one existing skip,
  actual exit 0. Unchanged extension/script groups remain 1509/293 pass, giving
  current group totals of 3400 pass/one skip without pretending all three groups
  were rerun after the fixture-only correction.
- Final focused `btlfEb` passes 8/8, actual exit 0, unchanged identities. The
  independent audit verifies fifteen layouts and six boundaries: 31 original
  POSTs/12779 bytes, fifteen native writes, fifteen clears and one additional
  original write with ACK delivery held. The original ten-second Pause deadline
  fails with the ACK still held and runtime/durable policy unchanged; after
  release, actual operations reach zero before explicit Apply/new turn recovery.
  Its 34925ms ledger has zero activation and only the original two popup-focus
  permissions. Exact task cleanup and native host EOF/0 are verified.
- Complete browser run `mAKsEd` passes 175/175, actual exit 0. Independent review
  verifies all prior `Q6zSPw` 169 names/order and unchanged 581 source files,
  17 runtime identities, 47 staged files and fourteen builds from 144 inputs.
  Fifteen chooser layouts and six boundaries retain 31 original POSTs/12779 bytes,
  485 file bytes, fifteen native writes and fifteen explicit clears, plus the
  extra original late write. Original policy and exact owned resources are restored.
  The observer-to-final ledger spans 529321ms (worker-ready spans 529319ms),
  retaining only the original twelve activation and four control-popup focus
  permissions. The original host exits via the intentional restart's SIGTERM;
  its successor exits normally with EOF/0, and exact-run process inspection is empty.
- Current Codex IAB comparison used the same chooser fixture through documented
  APIs: root upload produced the expected 27 file bytes; explicit empty selection
  was rejected and the existing cross-origin chooser wait timed out. The dynamic
  case is excluded because its wait expired between tool calls before the upload
  click. There is no Codex native focus ledger or repeated-run claim. All owned
  tabs closed and the fixture server stopped normally with actual exit 0.

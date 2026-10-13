# Explicit replacement of invalid website access settings

- Status: complete
- Started: 2026-10-14
- Parent: [Browser Use parity](../active/2026-10-10-browser-use-parity.md), P14.

## Problem and outcome

A successfully read but corrupt website access record blocks automation. The existing explicit reread can observe an external repair, but normal Save waits on the rejected startup promise and cannot repair the record. Add a trusted popup flow that lets the user explicitly choose replacement permissions, persist them, and remain paused.

## Contract and scope

- Only a fulfilled storage read containing an invalid policy record grants replacement authority. Read failures, invalid response envelopes, pending reads, unrelated startup failure and pending writes do not.
- Reuse the current invalid recovery ID for the mutually exclusive reread/replacement actions; consume it before asynchronous work can admit another write. The popup starts a separate draft with no selected mode, shows its permission effect, and requires an explicit Replace and keep paused action.
- Preserve persisted v1 compatibility. Add a worker-local policy generation UUID to status, trusted popup SET/RETRY messages and document proofs. Pair generation with revision and recheck both before mutation. Rotate generation on worker construction, successful reread and invalid replacement; never treat a low revision in a new generation as an older response.
- Pause and drain browser control before replacement. Check the original deadline immediately before an actual storage mutation. Keep an already dispatched write reserved until its real settlement even when the observer times out. Real rejection grants only frozen-candidate retry; no replay or automatic Resume.
- Ordinary dirty drafts are preserved independently. Unknown permissions never display as All. A missing reply requires a fresh status check, not resubmission.

## Ownership and verification

- Root owns background integration, execution evidence, documentation, isolated browser launches and commits.
- Delegated policy/store and popup changes use disjoint files. A fixture agent extends the existing real-popup integration without another focus allowance.
- Unit coverage: corrupt vs unreadable storage; single-use ID; generation/revision ABA; pending/late/rejected writes; deadline before dispatch; exact failed-candidate retry; stale popup polls/proofs; default selection and draft preservation.
- Real browser: actual malformed storage and worker restart, original popup UI selection/save, persisted readback and Pause, old-scope rejection, explicit Resume/new turn and one original form submission. Retain raw records and actual process exit. No daily profile, OS mouse, input replay or focus restoration.
- Run relevant Node groups and focused isolated browser cases, then full integration if justified by the shared policy admission change. Audit source/runtime identity, actual process exits and original focus ledger.
- Keep existing preview packages intact, no PR, and push a reviewed commit to the authorized fork.

## Progress and remaining work

- Prior slice completed: CSS zoom feedback fix `4c2684f`, 149/149 full integration, 3151 Node passes plus one existing Windows permission skip; classified as verified progress.
- Implementation complete: explicit independent popup replacement, worker-local generation plus revision, same invalid ID for mutually exclusive reread/replacement, synchronous pre-dispatch deadline and actual-settlement gating. Independent review caught and fixed ordinary-draft loss on successful replacement.
- Original module counterexamples retained; final policy 29/29, backend 39/39, popup/control 61/61. Full Node groups 3187 pass/1 existing Windows symlink skip, actual exits 0, no drift.
- Focused `cnAeAG` 4/4 actual exit 0: original native get/set ACK, durable v1, paused/old-scope rejection and unique 1047-byte trusted form POST. Independent visual/identity/lifecycle review passed; screenshot viewport clips the complete Replace button label, while normal scrolling and its actual save action remain verified.
- Complete `k3A9Lo` 150/150 actual exit 0: prior 149 names/order retained, 444495ms observation under only the original 12 activation/4 control-focus allowances, source/runtime hashes unchanged.
- Independent full audit v2 passes: original native replacement, startup read and save-retry evidence, 553 source hashes, unchanged build inputs/runtimes and actual host cleanup. Preserve v1 auditor failure: it incorrectly compared a flattened focus projection to the nested record; corrected only the auditor, without rerunning or changing browser behavior. Documentation/hygiene/action-pinning/diff checks pass.
- Existing preview ZIP hashes unchanged. No PR.
- Ordinary Edge human authorization remains deferred at the user's request. This slice does not establish overall Codex parity or close unrelated focus/new-page/initial-keyboard gaps.

## [2026-10-14 03:55] | Task: Recover invalid website access settings from the popup

### Execution context

- Agent: Codex `/root`, with policy, popup and integration collaborators.
- Runtime: Windows; isolated Chromium fixture, real extension worker and native host.

### User request

Continue Browser Use development while ordinary Edge manual authorization is
deferred. Preserve existing packages, use the authorized fork, and create no PR.

### Changes and intent

- Add an explicit corrupt-record replacement flow to the live action popup.
  Its independent draft has no default mode, describes the selected permission
  effect, and keeps ordinary unsaved drafts separate. Success remains paused.
- Only a completed read of an invalid saved record grants a single-use recovery
  ID. Read errors, pending calls and other control startup failures cannot grant
  replacement authority. Reread and replacement consume the same observed ID.
- Keep the durable v1 record unchanged. Pair a worker-local generation with
  revision in saves, exact-candidate retries and document proofs, preventing
  old popup messages and proofs from authorizing a new policy generation.
- Preserve real Pause/drain and storage settlement. Check the original deadline
  immediately before dispatch; a timeout does not permit replay or Resume.
  Only an actual rejected write grants frozen-candidate retry.
- Add deterministic boundary coverage and an isolated browser workflow using
  the existing popup, actual corrupt storage, worker restart, original native
  Promises and one original form submission after explicit Resume/new turn.

### Verification

- Policy 29/29, backend 39/39 and popup/control 61/61. Retain original missing
  replacement counterexamples and the success-path dirty-draft regression.
- Node groups: 3187 pass, one existing Windows file-symlink privilege skip,
  zero failures, actual exit 0 and no source/runtime drift.
- Focused `cnAeAG`: 4/4, actual exit 0. Independent review confirms one native
  policy read and one replacement write/ACK, exact durable v1, stale-ID and
  old-epoch rejection, and one 1047-byte trusted POST from the original document
  and node. Its 13298 ms observer interval has no activation and only the two
  existing control-popup focus events. Process/connection cleanup is confirmed.
- Complete `k3A9Lo`: 150/150, actual exit 0, preserving the previous 149 case
  names and order. The 444495 ms observer interval retains only the original
  12 exact activations and four control-popup focus allowances; no source or
  runtime drift. Independent audit confirms native policy workflow artifacts,
  build/source/runtime identity and actual host cleanup. Documentation, hygiene,
  action pinning and diff checks all pass.

### Evidence limits and remaining work

The fixture deliberately creates corrupt data; it does not claim spontaneous
browser corruption. The reviewed screenshot shows the selected permissions and
effect clearly, but the main button's complete label lies below its viewport;
the popup remains scrollable and the original action/save are verified separately.
Runtime generation is not an external-storage atomic CAS. Ordinary Edge consent,
unresolved persistent writes across worker loss and the remaining parity matrix
stay open. Existing preview ZIPs remain unchanged.

### Main files

- `apps/chrome-extension/site-access-policy.js` and `background.js`.
- `apps/chrome-extension/popup-site-access.js`, popup markup and wiring.
- Their policy, backend and popup tests.
- `scripts/browser-integration/site-access-invalid-fixture.mjs`, its tests and
  shared-popup runner wiring.
- Website-policy reference, architecture, capability matrix and execution plans.

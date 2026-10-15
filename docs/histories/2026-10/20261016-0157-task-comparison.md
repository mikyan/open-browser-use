## [2026-10-16 01:57] | Task: Run a fixed complete-task comparison

### Execution context

- Agent: Codex, with separate preparation and independent solver contexts.
- Exact model ID and reasoning setting are not exposed by the execution tools.
- Runtime: Windows, Node.js 24.14.1.

### User request

Continue improving Open Browser Use toward the requested browser capabilities,
without a Pi adapter or upstream PR. The requested Windows preview was already
published from `e83c6d8`.

### Changes and intent

- Fix a six-task, two-side, two-round protocol before measuring task completion.
  Preserve all first outcomes and keep cleanup and interference separate.
- Add an opt-in paired research server: same-round public facts match while
  task keys and submission ledgers remain independent. Default random material
  generation is unchanged; the optional nonce source validates its input.
- Add a thin upload/diagnostics server using the original business fixtures,
  visible common instructions, generated public upload files and local private
  evidence. Shutdown records actual server closure.
- Keep preparation/oracle access out of the two fresh solver contexts. This
  increment changes acceptance infrastructure only, not product behavior.

### Validation and boundary

Research tests passed 7/7, including an actual paired child server and independent
submissions. Upload/diagnostics server tests passed 2/2, including exact fixture
content and real process shutdown. No formal comparison attempts had started at the preparation commit. The
completed comparison and original results are now recorded below and in the
completed execution plan. Ordinary installed Edge authorization and native OS
foreground measurement remain outside this comparison.

### Main files

- `scripts/browser-integration/research-workflow-{fixture,server}.mjs` and tests
- `scripts/browser-integration/parity-transfer-diagnostics-server.mjs` and tests
- `docs/exec-plans/completed/2026-10-16-task-comparison.md`
- `scripts/browser-integration/README.md`

### Completed comparison

OBU 12 项：1 blocked-environment、1 failed、10 success；Codex 12 项：1 blocked-environment、9 success、2 unsupported。

All 24 original attempts are retained, including two environment blocks, the
first OBU research cleanup failure and two narrow Codex hidden-input limits.
The generic bridge was repaired only for later scheduled attempts; production
code remained identical to the published preview. Download bytes, diagnostic
origins, original submissions and tab end states were independently joined
to final server ledgers after normal shutdown. Actual browser/host/controller
and seven server exits are retained. Codex closed only its two report pages.

The result index records original evidence hashes, separate business/cleanup
timing and unknown model-call/thinking metrics. Two rounds do not establish
performance or full capability parity. No unchanged release was repackaged;
no upstream PR was created. Focused preparation tests remain 7/7 plus 2/2;
the existing production regression was not unnecessarily rerun.

See `docs/references/paired-task-comparison.md` and its sanitized JSON index.
Documentation skeleton, changed-plan relative links, staged JSON SHA and
`git diff --check` passed. The overall parity plan remains active; only the
fixed 24-attempt execution plan moved to completed.

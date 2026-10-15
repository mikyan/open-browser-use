## [2026-10-16 01:57] | Task: Prepare a fixed complete-task comparison

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
content and real process shutdown. No formal comparison attempts had started at
this preparation commit; results will be recorded in the execution plan after
the fixed sequence runs. Ordinary installed Edge authorization and native OS
foreground measurement remain outside this comparison.

### Main files

- `scripts/browser-integration/research-workflow-{fixture,server}.mjs` and tests
- `scripts/browser-integration/parity-transfer-diagnostics-server.mjs` and tests
- `docs/exec-plans/active/2026-10-16-task-comparison.md`
- `scripts/browser-integration/README.md`

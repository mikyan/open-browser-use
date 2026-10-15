## [2026-10-16 03:50] | Task: Verify isolated headless native feasibility

### Execution context

- Agent: Codex, with separate implementation and audit contexts.
- Exact model ID is not exposed by the execution tools.
- Runtime: Windows, Node.js 24.14.1, pinned Chromium 156.0.8078.4.

### User request and intent

Continue improving browser capabilities and visible AI operations without
occupying the user's mouse. Investigate an explicitly separate managed session
without redefining ordinary-profile background behavior or creating a PR.

### Changes

- Add one independent developer runner using the production extension,
  real `connectNative`, current Go host and formal JS SDK. Keep profiles,
  temporary registration and cleanup scoped to that attempt.
- Reuse the existing browser startup policy and exact native process/EOF
  observers. Record complete read-only extension inventories and original
  source hashes; do not disable sandbox or alter product code.
- Document execution and evidence limits in the integration README.

### Validation and boundary

Preserve `jBbcen` (browser startup code 3) and `XUd0ts` (harness read before
descriptor publication), both with zero business actions and original runner
snapshots. Separate A/B/C core-startup diagnostics isolated the existing
testing-config policy as a relevant condition, without identifying a specific
failing experiment. No business action was replayed to replace either outcome.

`Z8Bgff` passed all five steps with actual outer exit 0 using the default
disabled testing-config policy and no `--no-sandbox`. Its connection step took
1,980 ms; this is an observed duration, not a global 20-second startup guarantee.
Worker discovery and status have separate waits. Original form/child POSTs were
112/192 bytes, and the 758×369 PNG was visually checked. Turn end rejected the
old child handle and detached the three task tabs. Browser and exact-handle
native EOF exits were both 0; all 17 observed owned processes exited, endpoint
records were empty and the unique registration was removed. Syntax and diff
checks passed; production code remained unchanged.

The separate stopped-state audit passed 122 evidence checks with actual exit 0,
including PNG decoding, native ancestry/retained-handle exit and exact process
identity cleanup. Relevant existing helper tests passed 23 checks; final docs
and repository hygiene checks passed. These checks do not repeat the historical
full production browser suite. The published dfb9e6b package remains unchanged.

This does not deliver a user managed-session launcher, prove OS foreground
behavior, resolve ordinary-profile popup focus, or test `finalizeTabs`. Internal
activation events remain diagnostic evidence. Live viewing, trusted user
controls and login/installation flows remain in the active session plan.

### Main files

- `scripts/browser-integration/managed-headless-check.mjs`
- `scripts/browser-integration/README.md`
- `docs/exec-plans/active/2026-10-16-managed-browser-session.md`

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

### 2026-10-17: Implement the experimental Windows launcher

The user requested a fresh usable package while the broader capability goal
remains active. Add `managed run/status/stop` and exact CLI/MCP `--managed`
selection, using a foreground supervisor and a separate persistent profile.
`internal/managedbrowser` owns the OS lock, private extension/host staging,
unique current-user registration, atomic Job membership and original native
process handles. Startup has one budget; cleanup preserves the lock until the
owned process tree actually exits. The ordinary extension configuration remains
`null`; the private staged copy carries only its versioned random native name.

The first production-entry attempt `managed-launcher-xgfAuQ` completed three
steps with actual runner exit 0. CLI/MCP selected the original endpoint, a
same-name collision created no extra run, and the SDK's original Control-click
opened the original child with exactly one 192-byte POST. The 758×369 PNG showed
the AI pointer and target feedback; turn end rejected the old handle. Original
Browser.close returned `{}`, browser/native exits were both 0, Job membership
reached zero, original processes exited, and native registration/endpoint cleanup
completed without forced termination. The result SHA-256 is
`8c398e632daa1db8d4e627a8b36ac80ddb6905ec85d89a1a94f1cac7a22ed790`.

Go tests across the module, 1,829 extension tests and 25 builder tests passed.
Stopped-state independent auditing passed 37 evidence checks with actual exit 0,
including 15 distinct original process identities, both registry views, endpoint
cleanup and decoded PNG pixels. The old-handle rejection is evidenced by the
runner assertion, not a separately retained raw error. Audit SHA-256:
`8271414aba4e013c7c82fc837e424ad854dd03150279e0a360a0f9897eebddbd`.
The requested `preview-20261017-dde4d40` package was rebuilt from the clean
`dde4d40ad7ad691897c9b88aec62a66b3a095df4` commit and published to the fork.
Offline CLI/MCP checks passed. Independent extraction verified 94 bundle files,
67 extension files and 6 Skill files; all four uploaded assets were downloaded
and matched local hashes before publication. Full ZIP SHA-256:
`ce924e01b94008e739787bfdbb346247e503fe545f058f6d500a29f5b9e73687`.
Package audit SHA-256:
`94780b91e0db64ab31af7a7511425f5c537c9c3b25227ecee63ad823b44fa750`.
An initial auditor parsing error requiring a semicolon in a Go const declaration
was corrected; its failure record was retained and the same archives passed.
No PR was created. This does not validate normal installed Edge, the company computer,
OS foreground behavior, native download files, profile login/restart or a full
task matrix. Viewer, trusted pause/resume and login handoff remain unfinished.

New reference documentation gives ordinary-install-first guidance and explicit
Windows run/status/stop, CLI and MCP examples. Architecture, security,
reliability, quality and release notes distinguish this experimental launcher
from the existing ordinary browser installation and from full parity.

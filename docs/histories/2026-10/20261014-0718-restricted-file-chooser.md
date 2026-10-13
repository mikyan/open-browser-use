# Allowed-site native file chooser and actual upload cleanup

The user requested continued Browser Use parity development, keeping the
upstream-based project and existing skill, without a PR or pointer interference.
Ordinary Edge manual authorization remains deferred at the user's request.

The development extension now permits native file chooser workflows on allowed
websites through the existing public APIs. Original native event, document,
attachment, node and policy identity remain fixed across source validation,
interception cleanup and file submission. A changed document cannot inherit an
old chooser; cancellation can release its original wait after website revocation.

The shared file-input registry now retains and drains real native operations
after a caller timeout. Pause, session end, backend detach and the engine release
hook all wait for the original attachment's file work. This also fixes the
direct-locator upload cleanup path. No input or file write is replayed.

Changes are concentrated in the extension backend, chooser registry, shared
file-input registry, backend regressions and a reusable five-entry browser
fixture. Documentation covers the contract, remaining channels and a limited
current Codex IAB comparison. The old-source failures and first candidate's
fixture assertion failures are retained; successful API replies alone do not
stand in for original file bytes or actual cleanup.

Focused acceptance passes 8/8 and full browser regression passes 175/175 with
actual exit 0, retaining the previous 169 cases in order. Independent review
checks both runs' 31 original POSTs and 12779 bytes, original source identity,
unchanged focus permissions and exact cleanup. Current Node group totals are
3400 pass and one existing Windows skip. Validation and remaining limitations
are recorded in the
[execution plan](../../exec-plans/completed/2026-10-14-restricted-file-chooser.md).
The full Browser Use parity goal and ordinary installed-browser acceptance
remain open. Existing preview installers are preserved.

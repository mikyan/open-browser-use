# Go created-page scope and managed-session guidance

The user requested continued Browser Use improvements and a fresh Windows
package, without a pull request. Five-entrypoint workflow development uncovered
a Go SDK defect when preparing a download on the actual child returned by
`PageWait.Result`.

The shared scoped-request boundary now restores a validated control epoch's
internal integer representation after JSON parameter freezing. Download,
chooser, navigation and network typed APIs keep the original child, transport
and captured scope. No automatic reconnection, child reconstruction or input
replay was added. New tests exercise the public typed methods through real
IPC/JSON, including maximum safe epoch and rejection of old handles after a
new turn. The original failing checks remain recorded.

The existing Skill now branches explicitly between ordinary profiles and
isolated managed sessions, documents all five connection entrypoints and
viewer/recovery/Stop behavior, and respects authorization already given by the
user. It does not add a Pi-specific adapter.

Go SDK, all-package tests and vet passed. The unchanged five-entrypoint mock
workflow suite passed 18 checks, and the Python helper passed five. Skill
links, examples, package members and offline help were checked. Actual browser
workflow acceptance and the requested new package are recorded separately;
these checks do not establish full Codex parity or company Edge acceptance.

Primary files: `packages/open-browser-use-go/client.go`,
`page_wait_composition_test.go`, `skills/open-browser-use/SKILL.md` and
`skills/open-browser-use/references/managed-session.md`.

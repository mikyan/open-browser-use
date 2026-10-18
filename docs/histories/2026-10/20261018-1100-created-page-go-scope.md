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
workflow acceptance is recorded separately. The user's package request was
already fulfilled by `853ea92`; this slice's candidate is internal and is not
another requested release.

These checks do not establish full Codex parity or company Edge acceptance.

The subsequent real managed workflow `mwf-6nmDto` passed nine stages with
actual exit 0 using the internal candidate's exact executable and extension.
All five entrypoints produced their own child, single POST, original file and
retained result; the viewer and formal Stop were observed. Independent audit
passed 1,978 checks and decoded 62 images. The read-only observer recorded
318 equal cursor samples, zero foreground events and successful native cleanup;
these observations do not prove continuous cursor immobility or general
foreground behavior. The original candidate, helper build and workflow records
are hash-bound and preserved. No new GitHub release or user package was created.

Final CI portability fixes remove the local Python path, explicitly build the
JS SDK and Go helper before their tests, register missing Go coverage as a
visible skip, and run Python helper tests in CI. The acceptance-only Go helper
keeps an explicit local pipe on Windows and accepts an explicit absolute Unix
socket on other platforms. Go helper tests/vet/build and 18+5+31 focused checks
passed without skips, with Bash syntax checks. These later harness checks do
not relabel the original browser run or claim a Linux runtime acceptance.

Primary files: `packages/open-browser-use-go/client.go`,
`page_wait_composition_test.go`, `skills/open-browser-use/SKILL.md` and
`skills/open-browser-use/references/managed-session.md`.

# Managed workflow acceptance through five entrypoints

`scripts/browser-integration/managed-workflow-check.mjs` runs five distinct
transactions through JS, Python, Go, CLI and MCP. The first three use the typed
SDKs; the latter two select the named managed session through the formal CLI.
Each transaction creates a source page, acquires its actual child using a
prepared waiter, reads instructions, fills three fields, submits once, obtains
the original browser download, and finalizes only the child as its result.

The local fixture rejects duplicate source/child loads, submissions and report
requests. Diagnostic reads observe original document IDs, trusted events and
native target identity. They do not open, repair, resubmit or download a page.
The actual managed viewer observes task frames and each retained result. UI
screenshots are nearby observations; the separately saved native PNG bytes bind
to their own stream, sequence, capture timestamp and result lease.

## Running the acceptance

Use Windows, the repository Node dependencies, Python and Go 1.26.9. Set
`OBU_TEST_GO_BINARY` to the absolute Go executable, then run:

```powershell
node scripts/browser-integration/build-managed-workflow-helpers.mjs
```

This writes a fresh helper build report with source hashes before/after tests
and builds, actual process exits, and both executable hashes. Set the following
absolute paths before running `node scripts/browser-integration/managed-workflow-check.mjs`:

| Variable | Input |
| --- | --- |
| `OBU_TEST_RELEASE_BUNDLE` | Clean-source Windows bundle directory |
| `OBU_TEST_RELEASE_BUILD_REPORT` | Its successful offline build report |
| `OBU_TEST_RELEASE_AUDIT` | Independent successful artifact audit |
| `OBU_TEST_CHROMIUM_BINARY` | Pinned CfT 156.0.8078.12 executable |
| `OBU_TEST_HELPER_BUILD_REPORT` | Newly created helper `results.json` |
| `OBU_TEST_OBSERVER_BINARY` | That report's observer executable |
| `OBU_TEST_GO_WORKFLOW_HELPER` | That report's Go workflow executable |
| `OBU_TEST_PYTHON` | Python executable for the typed SDK helper |

Do not edit frozen source or executables during an attempt. Every invocation
uses a fresh short private run directory and retains its own `results.json`,
raw lifecycle records, original reports, viewer frames and OS observations.
An attempt stops on its first failed workflow. A later run does not replace
the first result. Formal Stop and cleanup are part of acceptance.

## Observation limits

The acceptance-only Windows helper uses read-only foreground hooks and cursor
samples. It starts before the managed browser and stops after the original
browser and viewer have exited. The report distinguishes hook events from
sampled cursor positions, records sample gaps and actual helper cleanup, and
retains failures. It neither moves the pointer nor restores focus.

Equal sampled cursor positions do not prove continuous immobility. Foreground
PID matches are candidates within the recorded process set, not proof of
process incarnation or who caused input. The test does not inspect personal
profiles, accounts or window titles. Original report files are removed only
after their exact bytes and identity are rechecked; artifact copies remain.

This is deterministic local acceptance, not a model solver, speed comparison,
ordinary company Edge installation test or proof of complete Codex parity.
Real SSO/IME, browser restart and the broader task/platform matrix remain open.

## Recorded Windows acceptance

`mwf-6nmDto` completed all nine stages with actual runner exit 0 on
2026-10-18. It used the internal clean-source `5d42f7a` candidate EXE and
extension with fixed CfT 156.0.8078.12. This candidate was not uploaded or
published; the current user download remains `preview-20261018-853ea92`.

The five entrypoints produced 20 original HTTP requests, exactly five POSTs,
five acquired children and five original report files totaling 1,112 bytes.
Each original document, target, submission, file and finalized result remained
bound to its task. All five result deliveries were viewed after finalization.
The viewer recorded 164 frames and retained 37 native PNGs plus 25 nearby UI
screenshots. All 62 retained images passed CRC/IEND checks and full decoding.
Root visual inspection additionally confirmed the filled JS form and final Go
result in the actual viewer.

The observer recorded 318 position samples (including readiness), zero
foreground events and identical cursor coordinates at those samples. The
maximum sample gap was 77,955 microseconds. No recorded foreground PID matched
the observed original browser process set. These facts cover this local run,
not every cursor instant, all possible foreground events or input causation.
Formal Stop, original supervisor/Browser/Native/viewer exit 0, empty Job and
private resources, and observer hook/timer removal plus actual close 0 were
confirmed. A fresh independent audit found all 30 observed original process
identities absent and registry/pipe/endpoint resources clear.

Independent workflow audit passed 1,978 checks. Separate candidate artifact
audit passed 9,301 checks with 100 bundle, 72 extension and seven Skill files.
These counts describe their own checks; artifact checks are not additional
browser tasks. The original failing Go composition test and the observer's
pre-readiness parameter failure remain preserved.

| Evidence | SHA-256 |
| --- | --- |
| Original workflow `results.json` | `db41d65cb05fe923c4930383c76fe2e9c776f37544bc7974e40abb65eb29f43a` |
| Exact candidate EXE | `19d83c813c28c8791716311cc9f00e89372c487eb1ec1ae72409d5d6377fcc8e` |
| Helper build report | `4cffd90c6c361b4c14a9efec3f3be8448123eaf2f45be5af1fa7b2a33596f459` |
| Original OS JSONL | `876fe094598bedeb147535c56e933e5fd2cdbbd4a1f136e958b396405322a9b9` |
| Independent workflow audit | `7f78a253b2a9e631b87517a9518a7a3bb45334ff101af2657ea94e93b379d048` |
| Outer execution audit | `5cfbcaf908d353adb31728f09137785c9143d954f3e6fe865164b2e93212fe2b` |

Full P01–P15 parity remains open. The next managed-viewer gap is native
alert/confirm/prompt observation and human response; source inspection alone
does not establish a particular real dialog failure mode.

After this run, CI wiring and test-helper portability were corrected: Python
selection is explicit or platform-default, the Go helper and JS SDK are built
before their tests, and the helper accepts only the supplied local transport
(Windows named pipe or absolute Unix socket path on other platforms). Those
changes have separate checks; the preserved Windows run above used its original
helper binary and snapshot, not the later build. No Linux browser/IPC acceptance
is inferred from platform-rule unit tests on Windows.

Final targeted checks passed 18 caller/fixture tests, five Python helper tests,
31 Windows-observation tests, Go helper tests/vet/build and Bash syntax, with
no skips in that configured run. Its separate report SHA-256 is
`2daab47a0acfbbc54059740e7a637cac3e7c19da982f8cf4591371930e58f91b`.

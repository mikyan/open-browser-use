## [2026-10-14 06:04] | Task: Allow network waits on permitted websites

### Execution context

- Agent: Codex `/root`, with engine, fixture and independent audit collaborators.
- Runtime: Windows; isolated Chromium, real extension worker and native host.

### User request

Continue Browser Use development while ordinary Edge authorization is deferred.
Preserve background operation, use the authorized fork, keep existing packages
and create no PR. The broader capability-parity goal remains active.

### Changes and intent

- Allow arm, collect and cancel network waits under website restrictions. A
  pinned-runtime bridge captures the initial native request event and weakly
  associates its original Page, frame, document, loader and redirect authority
  with the exact server Request. A new same-URL document cannot inherit it.
- Select the first candidate synchronously, keep the original policy and
  deadline, and revalidate original authority before delivery. Legitimate
  navigation may commit its original loader; allowed document-tree changes
  refresh only that tree snapshot. Unknown worker sources fail closed.
- Await actual PageDispatcher subscription acknowledgements for ready and
  cleanup. Serialize changes on the original Page/event and account for actual
  cleanup after handle deletion or caller timeout. Repeated cancellation joins
  the same cleanup; it does not reread newly denied content.
- Place existing fresh-blank readiness before restricted first-goto document
  inspection, only for the exact fresh creation marker and within the original
  scope/deadline. Unknown pages and empty frame snapshots remain rejected.
- Add five-entry real-browser coverage and thirteen boundaries. Preserve raw
  request bytes, original documents/targets and trusted input; never replay a
  failed action. Separate evidence reads from finalization and preserve CLI
  failure streams without masking the original error.
- Update architecture, security, permission/network contracts, capability and
  quality records. Complete this slice's plan while retaining the parent goal.

### Verification

- Original-source unit/backend red: 22 pass/five fail, actual exit 1. Real old
  source rejects allowed-page arm before any business POST. Both are retained.
- First implementation retains its real 3/8 preparation failure. The later
  passive diagnostic remains failed because its bounded trace overflowed and
  its old no-response oracle required an unobserved native cancellation event.
  No failed run is relabeled. The exact native invalid field in the original
  preparation failure is unknown; the fresh-blank fix has a separate controlled
  backend red with six failures.
- Final related coverage: 281/281; fixture: 15/15. Node groups: 3,319 pass and
  one existing Windows symlink-permission skip, actual exit 0. All twelve Go
  builds exit 0 with unchanged inputs.
- Fixed focused run: 8/8, actual exit 0. JS, CLI, MCP, Python and Go each cover
  root, existing OOPIF and dynamic OOPIF: fifteen POSTs/11,842 bytes. Thirteen
  boundaries add nine POSTs/7,919 bytes. One original request has no response:
  server closure before headers, no native response/completion, new document
  commit and original three-second timeout are verified, not native cancel.
- Full regression: 163/163, actual exit 0; prior 157 names retain relative
  order. Its 476,719ms focus history uses only the original twelve activation
  and four control-focus permissions. All original build/runtime identities,
  existing host restart, final EOF exit 0 and process cleanup are audited.
- After full completion, two runner-only failure-handling adjustments pass
  existing cleanup/fixture tests 82/82 and final focused 8/8, actual exit 0.
  Final focused evidence retains 24 POSTs/19,761 bytes and 20,993ms with zero
  activation and only two original popup-focus permissions. Full acceptance
  belongs to its preserved runner; the final runner is verified by this focused
  run. Production, SDKs and build inputs did not change between those runs.
- Both final independent audits find no blocker. Exact original child targets,
  public caller processes and native host are closed. Existing preview ZIPs
  remain unchanged.

### Limits

Ordinary Edge consent and installation acceptance remain deferred. Broader
worker, inherited/opaque frame and platform combinations are not all verified.
Website permission constrains returned data, not page network traffic. The
pre-existing generic subprocess timeout still does not guarantee terminal-close
and stream capture. This slice does not close the parent parity goal.

### Main files

- `apps/chrome-extension/background.js` and `browser-network-waits.js`
- `scripts/patch-network-wait-proof.mjs` and `build-chrome-extension.mjs`
- `scripts/browser-integration/run.mjs`, `site-access-network-fixture.mjs`
  and the Python/Go public callers
- [Completed plan](../../exec-plans/completed/2026-10-14-restricted-network-waits.md)
- [Network wait contract](../../references/network-waits-design.md)

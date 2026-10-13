## [2026-10-13 23:00] | Task: Explicit native JavaScript dialog decisions

### Execution Context

- Agent: Codex `/root`, with extension, SDK/CLI and independent evidence reviews.
- Runtime: Windows, Go 1.26.9, Node 24.14.1, isolated Chromium 156.

### User Query

Continue Browser Use parity development while manual Edge acceptance is
unavailable. Preserve background operation, the existing preview packages, and
the user fork; do not open a PR.

### Changes Overview

- Add one-shot native dialog preparation, collection and cancellation, exposed
  through JavaScript, Python, Go, CLI and MCP with `dialogVersion:1` negotiation.
- Require acknowledged registration and a confirmed original native response.
  Retain original scope, attachment, connection and deadline. Cleanup tracks
  real Chrome promises even if the higher-level channel rejects earlier.
- Preserve default handling of unmatched dialogs; retain pending policies when
  child frames appear, and revoke them on top-document replacement or control
  end. Keep unconfirmed cleanup visible without retrying a response.
- Add real root, OOPIF and dynamic-OOPIF fixtures with original HTTP receipts,
  bounded native event/command observations, typed helper processes, and strict
  independent joins between frame identity, decisions, native ACKs and results.
- Document the public APIs and the separate unresolved beforeunload background
  limitation; update the existing skill's usage instructions.

### Design Intent

The pinned engine automatically dismisses ordinary native confirmations and
prompts. Explicit decisions make these workflows usable without replacing page
JavaScript. Readiness precedes the single page trigger, and response completion
is separate from the page's business outcome. A command already submitted cannot
be undone or safely repeated merely because an acknowledgement was lost.

### Verification

- Original backend and Go/CLI red cases are retained. New extension tests pass
  23/23 and related regressions 111/111. Go full tests: 820 test/subtests pass,
  27 existing platform/permission skips, actual exit 0; affected-package vet passes.
- JS full suite: 162 pass/four existing real-host skips. Python: 129 pass/one
  existing integration skip. Initial full Node extension/script/integration
  sweep: 2907 pass/one existing Windows symlink skip. Final affected fixture,
  native-evidence and runner tests: 18/18, actual exit 0.
- Ten host/Go-helper binaries build successfully from unchanged source inputs.
- First real run `5tMxBX` exits 1. Its fixture wrongly assumes iframe targets
  expose type `iframe` and tabId through chrome.debugger.getTargets(). Original
  observations show type `other`; verification now joins the native attachment
  event, current target ID and dialog frameId. The original failure is retained.
- The same run confirms beforeunload dismissal and preservation of the original
  document, but Chromium activates the task tab while creating native UI. The
  strict focus gate fails. Native response success is not a background pass.
- Corrected JS-only run `ltkQhr`: 2/2, 24 native decisions/defaults, 21 POSTs,
  actual exit 0. Its 4136ms ledger has zero activation/focus/allowances.
- Final focused five-entry run `l9jFNY`: 7/7, actual exit 0, 90 explicit decisions
  plus unmatched/unarmed defaults and lifecycle checks: 123 native responses,
  108 original POSTs/24939 bytes. The 24378ms ledger has zero activation/focus
  and no allowances. Source/runtime inputs are unchanged.
- Full `uZgxYp`: 138/138, actual exit 0, source/runtime inputs unchanged. The
  377930ms ledger uses only the previous 12 activation/four control-window focus
  allowances. No dialog case has a focus allowance.
- After full regression, harness-only evidence recording adds captured helper
  stdout text and explicit child-target cleanup IDs. Final focused `oYbXyC`:
  7/7, actual exit 0, 24535ms zero activation/focus/allowances. Production and
  typed helper inputs remain identical; the earlier full harness is retained.
- Independent review recomputes all six native proofs, exact decisions and
  receipts, 54 separate CLI processes, named MCP calls, helper stdout bytes and
  original source identities. Final cleanup verifies all 16 task tabs and ten
  original OOPIF target IDs absent. The complete run preserves all 132 prior
  names/order and exact existing focus allowance causes; both evidence versions
  are distinguished, with identical production/SDK/runtime identities.
- Preview ZIP hashes are unchanged. Documentation, repository hygiene, Action
  pinning and diff checks pass.

### Boundaries

Beforeunload's native UI activation remains an unresolved P12 gap, with pinned
Chromium source references and an explicit diagnostic that keeps the original
failing focus gate. Default background acceptance covers alert, confirm, prompt,
and cancellation/expiry/end behavior. This slice does not complete P01–P15,
ordinary Edge installation acceptance, or cross-browser parity. No preview ZIP
is rebuilt. See [native dialogs](../../references/native-dialogs.md).

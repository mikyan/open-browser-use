# Diagnostics and original response bodies on allowed websites

- Status: complete
- Started: 2026-10-14
- Parent: [Browser Use parity](../active/2026-10-10-browser-use-parity.md), P11/P14/P15.

## Problem and outcome

Allowed pages can now wait for original network metadata, but restricted modes
still reject the existing diagnostics and response-body APIs. An Agent cannot
inspect an allowed application's console/error evidence or read an original
POST result that is absent from its DOM. Restore that workflow through the
existing public APIs, without granting access to other documents or origins.

## Contract

- Preserve diagnostic pagination, bounded retention, all existing event kinds,
  public schemas, original response identity, body limits and deadlines.
- Bind network entries to the initial native request and original document,
  ancestor, loader, redirect and attachment proof. Bind console and exception
  entries to their original native execution context and document, not their
  stack/source URL or a later live frame lookup.
- Unknown worker/log/opaque provenance must not expose metadata. Report actual
  exclusions through existing bounded diagnostics accounting and document the
  supported evidence. Do not replace the ordinary API with a network-only view.
- Recheck fixed policy identity and original source before returning retained
  entries or bytes. A same-URL new document cannot inherit old authority. Keep
  complete allowed-tree validation and original owner/turn/epoch fences.
- Read only the original retained Response using the original native promise.
  Never refetch a URL, replay input or pick a later request as a substitute.
  Cancellation and Pause/end retain actual native cleanup until settlement.
- Preserve current unrestricted behavior and no-foreground-interference rules.
  Root alone runs isolated test browsers. Ordinary Edge consent stays deferred;
  existing preview ZIPs remain unchanged and no PR is created.

## Work and acceptance

1. Engine collaborator designs original-event proof and preserves deterministic
   old-source failures. Production changes wait for root's original browser
   red capture; new tests may be added first.
2. Fixture collaborator owns separate allowed-site diagnostics fixtures and
   typed public callers. Root owns build wiring, runner, all real browser runs,
   evidence, documentation and commit/push.
3. Five public entry points each observe, trigger once, read original logs and
   response bytes across root, existing OOPIF and dynamic OOPIF. Verify server
   bytes, original native events, original documents and exact cleanup.
4. Add denied/changed-source, redirect, policy-revocation, old-document and
   in-flight cancellation boundaries without weakening existing policy.
5. Independent audit verifies provenance, original failures, actual process
   exits and artifact/build identities. Run relevant suites and full regression
   if shared runtime/permission paths change.

## Progress

- Previous turn is verified progress: `195ee0d` is clean local/fork HEAD.
  Restricted network waits passed full 163/163 and final-runner focused 8/8;
  Node 3319 pass/one existing Windows skip. Those results do not complete the
  parent capability goal.
- Current source has explicit diagnostics/responseBody rejection in backend,
  plus a second restricted-body guard in the action engine. The existing
  native request proof and single-read response bridge are relevant foundations.
- Console/error client values have different runtime identity paths from
  Request objects. Their original native context proof is being designed and
  independently reviewed before removing any rejection.
- Old-source module/backend evidence now retains 74 tests: 65 pass/nine fail,
  actual exit 1, no source drift. Besides allowed API rejection and per-entry
  provenance, it exposes missing subscription readiness and a final snapshot
  proof fence. The old pinned bridge run separately has one pass/five failures;
  the unconnected candidate provenance bridge passes six checks.
- Five-entry positive fixtures pass eight unit checks. Thirteen Go artifacts
  build with actual exit 0 and unchanged inputs. Real old-source `QJiP8w`
  retains **2/3, actual exit 1**: mandatory raw navigation and the existing
  settings popup pass, then allowed-page diagnostics rejects with
  `OBU_SITE_ACCESS_UNSUPPORTED` before any business input. The original run
  closes without source/runtime drift; production edits begin only afterward.
- Shared Page/event subscription coordination is part of the fix. Five actual
  PageDispatcher ACKs cover console/request/response/finished/failed; pageerror
  has no subscription bit. Scope checks must also cover the backend's final
  asynchronous allowed-tree read after the engine returns a diagnostic value.
- Independent old-browser audit verifies the retained production build against
  the original baseline, the expected first-call rejection, zero business POSTs,
  policy restoration and exact task cleanup. Its 5,159ms focus ledger has zero
  activation and only the existing two popup-focus permissions. This is not a
  claim that the body-only probe records every native input command.
- The final fixture unit suite passes 14/14, actual exit 0 and unchanged inputs.
  Nine boundary cases cover allowed/denied redirects, failed original transfer,
  same-URL replacement, policy revocation, a held original native body ACK, and
  existing/future denied children. Python/Go callers remain identical to the
  thirteen successful Go build manifest inputs. Real green acceptance is pending.
- Static review found that a rejected subscription cleanup after `forget` could
  be absent from Pause's failure checks. The production fix must retain and
  explicitly retry the original Page cleanup without granting authority to
  detach a successor tab. Dedicated engine/backend regression is in progress.
- The cleanup review is resolved: original Page releases report real failures;
  automatic paths join without retrying, and explicit cleanup can retry a
  settled failure. Detach rechecks its original owner/token after waiting, so
  a late ACK cannot detach a successor. Final targeted tests pass 283/283.
- Real focused `gapwcs` passes 8/8, actual exit 0, no source/runtime drift.
  Independent artifact review and complete browser regression are in progress.
  The first full Node pass found one older network test mock lacking the new
  diagnostic source reader; only that mock was corrected to reject unproven
  sources explicitly. Its sixteen tests pass without changing production code.
- Final Node groups pass 3363 with one existing Windows symlink-privilege skip,
  actual exit 0 and no source/runtime changes. Focused independent review verifies
  fifteen layouts and nine boundaries, 22 original POSTs/17316 bytes, seventeen
  original native body reads and sixteen returned bodies. One held original ACK
  correctly times out; Pause retains that actual pending work. The 24354ms focus
  ledger has zero activation and only the existing two popup-focus permissions.
- Complete `Q6zSPw` passes 169/169, actual exit 0. Removing the six new cases
  preserves every previous `EiU6cQ` case and its relative order. Independent review
  confirms the same original workflows, no URL refetch, unchanged production,
  runtime and build identities, and exact task cleanup. Its 502193ms focus ledger
  uses only the original twelve activation/four control-focus permissions. The
  original host is intentionally terminated by the restart case; its successor
  exits normally with EOF/0, and no exact-run process remains.
- Repository hygiene, document links and action pinning pass. Existing preview
  ZIP hashes are unchanged. This slice is complete; ordinary Edge consent,
  broader source/browser coverage and the parent parity goal remain open.

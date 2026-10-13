# Request and response waits on allowed websites

- Status: complete (this slice only; parent parity remains active)
- Started: 2026-10-14
- Completed: 2026-10-14
- Parent: [Browser Use parity](../active/2026-10-10-browser-use-parity.md), P11/P14.

## Problem and outcome

The existing ready-first request/response API works through five public entry
points, but website-restricted modes reject arm, collect and cancel even when
the page is allowed. Restore the submit-and-confirm workflow without exposing
network metadata from documents or origins outside the selected policy.

## Contract

- Keep the existing public API, original event deadlines, finite metadata,
  first-candidate selection and exact session/turn/epoch/tab/attachment scope.
- Bind selected metadata to the original native Request and emitter document,
  including policy generation/revision, frame and relevant redirect origins.
  A current frame URL cannot stand in for the original request's authority.
- Revalidate the original authority before delivering retained results. No
  later candidate, replayed input, refetch, inferred request identity or policy
  widening may repair a rejected observation. Unproven worker/opaque sources
  must not expose metadata; document any unsupported case explicitly.
- Cancellation releases an exact owned wait after permission revocation;
  cleanup must not require reading a newly denied document. Preserve Pause,
  control-end, detach and restart invalidation and actual in-flight accounting.
- Website settings constrain Agent-visible document/data access. This change
  is not a firewall for the page's own network traffic.
- Use isolated profiles only, no OS pointer or focus restoration, input replay
  or new focus exceptions. Preserve old preview ZIPs; no PR. Ordinary Edge
  manual consent remains deferred by the user.

## Work and ownership

1. Root verifies authoritative state, integrates the new acceptance cases,
   captures the unchanged-production real failure, and owns all browser runs,
   artifacts, documentation and final commit/push.
2. Engine collaborator designs original-request/document proof and captures
   deterministic old-source failures before production edits. Root explicitly
   releases production edits after the real red snapshot is retained.
3. Fixture collaborator adds separate HTTP/evidence fixtures and public-entry
   callers with tests. It does not change the central runner or launch browsers.
4. Audit collaborator independently checks proof boundaries, original browser
   artifacts, byte ledgers, source/build/runtime identity and process cleanup.

## Acceptance

- Old production rejects ready registration on an allowed page. Preserve that
  original failure and prove no business trigger was replayed or submitted.
- Five public entry points use ready ACKs, one original trusted submission and
  original request/response metadata, across root, existing cross-origin frame
  and dynamically created frame layouts. Verify the original server bytes and
  page result, rather than treating an API response alone as success.
- Exercise matching order, error responses and redirects; denied origins,
  document/policy changes and unproven emitters must not leak retained metadata.
  Exercise cancellation and existing Pause/end/attachment cleanup boundaries.
- Run affected unit/backend tests, related real workflows, and full regression
  when the shared permission/runtime path changes. Preserve original case
  order, existing focus allowances, original failures and artifact identity.

## Progress

- Previous turn is verified progress: commit `1930c08` is local/fork HEAD with
  clean worktree. DOM-rebuild feedback passed full `uLJcAS` 157/157, Node 3270
  pass/one existing Windows symlink skip and independent evidence review.
- At the start of this slice, all three network-wait RPCs were in the restricted
  denylist. The registry checked transfer scope, while metadata read
  Request URL, live frame URL and redirect identity without original document
  authority. Removing the denylist alone would not meet the required boundary.
- Production and acceptance design entered independent review. Overall
  parity remains active; this plan does not redefine its completion rule.
- Original-source module/backend run records 27 tests, 22 pass/five fail,
  actual exit 1 and unchanged source identity. Besides restricted registration
  and cancellation, these expose missing original-candidate proof and missing
  registration/removal acknowledgement. The latter is the pinned server-local
  PageDispatcher event filter acknowledgement, not a CDP Network.enable ACK.
- The pinned server Request does not retain the originating document of a
  fetch. A build-time WeakMap bridge will capture the original native event
  before requestStarted dispatch, including frame/loader/document identities.
  Navigation may carry that same loader from pending to current; ordinary
  fetches must retain their original document even across same-URL reloads.
  Five-entry acceptance wiring borrows the existing settings popup and does
  not add an activation/focus exception.
- Real old-source `ttzGtE` records the original failure: mandatory raw navigation
  and the existing website-settings case pass; the allowed-page network arm
  fails with `OBU_SITE_ACCESS_UNSUPPORTED`. The sole original root page has no
  business POST, and its exact tabs/targets are removed. Wrapper exit is 1
  with no source/runtime drift; all twelve Go artifacts built with exit 0 and
  unchanged inputs. Production edits proceed only after that real run closes.
- Independent review confirms that real red's unchanged original document,
  empty input/completion/native-network ledgers, zero POSTs and restored policy.
  Its 5463ms focus ledger contains no activation and only the original two
  settings-popup focus permissions. The native host exits 0 after EOF, exact-run
  process inventory is empty, and original staged/build/runtime hashes match.
- Production proof must be captured at the initial native request event, not
  a potentially delayed Request constructor (interception/Service Worker paths
  can delay construction). Document tokens must be retained weakly through the
  original attachment identity so closed tabs cannot accumulate in a live map.
- Frozen production passes 207 targeted tests. A separate backend red exposed
  cached live-tree proof rejecting legitimate navigation commits; only that
  snapshot may now refresh, while original request/policy authority remains
  fixed and cleanup still precedes the final synchronous check. Fixture tests
  pass 15/15; all Node groups pass 3310 with one existing Windows symlink skip,
  actual exits 0 and unchanged input/runtime hashes.
- First real implementation run `ZrtRLt` is retained as **3/8, actual exit 1**.
  The JS root/existing/dynamic OOPIF workflows pass with three original POSTs.
  Subsequent callers and boundary setup fail at new-page document inspection,
  before any fixture GET, network arm or input. This is not a network-wait
  success for those callers. The ordinary site-settings workflow and policy
  restoration complete. A passive, opt-in native permission trace is being
  added to distinguish blank-document startup from an actual denied document.
  No permission result, browser input or original failed record is rewritten.
- The failed run also exposed an acceptance cleanup field mismatch: child IDs
  must come from the original frame observer before finalization. The runner
  now retains those exact IDs and checks their absence after the original
  owner finalize; it does not infer child cleanup from an empty wrong field.
- Independent `ZrtRLt` audit verifies the failed outcome, three JS POSTs/2354
  bytes, 8742ms focus coverage with zero activation and only two existing popup
  permissions, restored policy, host EOF exit 0 and no exact-run processes.
- Opt-in diagnostic `fQh2Cu` remains a failure: actual exit 1, no input/runtime
  drift. All fifteen caller layouts retain successful original business
  evidence, but the bounded permission trace overflows (4096 retained, 17176
  dropped). Its first records do not reproduce the earlier generic refusal.
  Boundary navigation succeeds; the held-fetch case reaches its original
  timeout with a server-closed response before headers and no native response,
  but no native `loadingFailed` event. The oracle's mandatory cancellation-event
  assertion therefore fails. Neither failure is relabeled as full acceptance.
- Code inspection and controlled snapshots expose a separate concrete order
  gap: restricted first `goto` performs complete site inspection before the
  existing fresh-blank readiness gate. A scoped, deadline-bounded readiness
  step is being moved before that inspection, without relaxing frame policy
  or replaying input. The earlier run's exact native invalid field is unknown.
- The scoped fresh-blank fix is now frozen: formal old-source backend run has
  67 pass/six fail; final related coverage passes 281/281, actual exit 0 with
  no source drift. Complete blank with empty frames and unknown pages remain
  refused. Final Node groups pass 3319, with the same one Windows symlink skip.
- Ordinary, untraced `mYijy5` passes **8/8, actual exit 0**, no source/runtime
  drift. Five entries cover fifteen layouts and 15 original POSTs/11842 bytes;
  thirteen boundary cases add nine POSTs/7919 bytes. One is precisely a
  server-closed request with no response, not an observed native cancellation
  or a permissions rejection. The original request/document/redirect checks,
  one legitimate document GET and exact cleanup are retained independently.
  Focus covers 22970ms with zero activation and only the original two settings
  popup permissions. Native host EOF exit 0 and exact-run process absence are
  confirmed.
- Complete regression `EiU6cQ` passes **163/163, actual exit 0**, with the old
  157 case names in their original relative order. The restricted network
  workflows retain 24 POSTs/19761 bytes, including one precisely unresponded
  request. Its 476719ms focus ledger contains only the original twelve
  activation and four control-focus permissions. All source/runtime/build
  identities match the invocation; the original native-host restart and final
  EOF exit 0 are independently verified, with no exact-run process remaining.
- After that actual full close, the runner alone separates child-target
  evidence, finalize and tab-cleanup checks so an evidence-read failure cannot
  prevent finalization. CLI nonzero/invalid-JSON failures preserve original
  stdout/stderr bytes and hashes without masking the original error. Existing
  cleanup-failure and fixture tests pass 82/82. The pre-existing generic
  subprocess timeout still does not guarantee terminal-close/stream capture;
  this slice does not claim otherwise.
- Final runner `5SV1It` passes **8/8, actual exit 0**, unchanged source/runtime
  identity, 24 POSTs/19761 bytes, and 20993ms with zero activation and only the
  original two popup-focus permissions. Host EOF exit 0 and exact-run process
  absence are independently verified. The full run belongs to its retained
  runner SHA `d45e89231c647697668aad4b2646c917717ff373c30beee3bb975b9b096a7057`;
  only the subsequent runner differs, and the final focused run verifies it.
  Production, SDKs, stage, fifteen runtimes, 142 build inputs and twelve Go
  builds remain identical. Both independent final audits report no blocker.
- This slice is complete. Ordinary Edge consent, broader worker/browser
  combinations and the parent capability comparison remain open. Existing
  preview ZIPs are unchanged; no PR is created.

# Explicit retry of a failed website-policy save

## Goal and scope

Let a user review and retry the exact website-access candidate after its original
storage write has actually rejected. Use the live toolbar popup, preserve the
pause/drain and revision checks, and keep agents paused after success.

Includes the policy store, trusted popup handler, popup UI, regression tests and
an isolated real-browser native quota rejection followed by explicit recovery.
Does not infer the result of an unresolved write, recover failed startup reads,
reset corrupt settings, automatically resume/replay work, or change restricted
data-channel rules. Those limitations remain in the parity matrix.

## Evidence and design

At baseline `10c972d`, `SiteAccessPolicy.replace` can retry after a settled failure
with a fresh revision, but the popup rejects every `ready:false` status and GET
only returns cached state. Removing a transient fault therefore leaves the user
without a retry path. Reloading the extension was the only exposed recovery.

Only an actual failed persistent write can expose `retryable:true`. The candidate
retains its canonical mode, origins and failed revision; it is never labeled as
saved. `RETRY_SITE_ACCESS_POLICY {expectedRevision}` is admitted only for the live
action popup and retries that exact candidate. A pending native write remains
busy; stale requests cannot write. A reopened popup can review the candidate.

## Risks and validation

- Distinguish a failed candidate from confirmed durable settings and preserve
  unsaved drafts when another popup changes the candidate.
- Check revision again in the serialized store; a stale request or deferred
  response cannot authorize new input or overwrite newer settings.
- Observe the original native storage Promise. Real-browser fault injection only
  adds an oversized test argument to the matching private-profile storage call;
  do not synthesize a rejection or delay and claim it was native behavior.
- Verify real durable readback, paused status, old-epoch rejection, explicit
  Resume/new-turn and a single trusted business submission after recovery.
- Keep all existing browser focus assertions and allowances. Reuse the existing
  website-settings action popup rather than introducing another focus allowance.

## Progress

- [x] Read current implementation and reproduce the UI dead end.
- [x] Agree on exact-candidate, explicit-retry scope; delegate backend and popup.
- [x] Preserve regression failures and implement the trusted retry path.
- [x] Review races/admission; run targeted and complete affected tests.
- [x] Run real-browser controlled native failure/recovery and existing suite.
- [x] Synchronize references, matrix, debt and history; prepare fork commit.

## Decisions

- 2026-10-13: Do not reinterpret a startup read failure as a failed save. Startup
  recovery involves `controlReady` and trusted-storage initialization and needs
  separate evidence. Pending writes cannot be made retryable by a UI timeout.
- 2026-10-13: The first native run passed but screenshot review found stale
  Running text after a failed save. Added a settled-attempt callback to refresh
  actual automation status on success/failure/lost reply. Final focused run
  `Y4Qq0W` passes 2/2 with paused UI, native quota rejection/ACK and original
  65-byte business POST. Complete regression used these frozen sources.
- 2026-10-13: Complete extension/script Node suite: 2,939 pass, one existing
  Windows symlink skip, actual exit 0; no new skip or failure.
- 2026-10-13: Full `bDKdec`: 137/138, actual exit 1, no source/runtime drift.
  The website-settings case passes. An existing keyboard case lacks its initial
  End keydown even in the final original POST; its setup precedes native probe
  installation. Keep that failure and diagnose it next. Do not rerun merely to
  obtain green or change its strict assertion. All 138 names/order are retained;
  focus validation uses only the prior 12 activation/four control-focus allowances.
  This scoped retry implementation is complete; the overall parity goal is not.
- Independent focused/full artifact reviews confirm the native proof and source
  identities. Full audit explicitly reports `suitePassed:false`; it does not
  convert the existing keyboard failure into a pass for this implementation.

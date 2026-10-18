# Bounded human dialog deliberation

Status: completed for this bounded slice. Native managed human dialogs from
`a943536` now allow bounded deliberation without losing their original input.
Full Browser Use parity remains unproven and the overall development goal stays
active. This continuation does not publish a package or open a PR.

## Problem and intended behavior

Before this slice, the viewer gave every input 30 seconds at the server and 35 seconds in
the UI. A native modal can hold the original input acknowledgement while the
person reads or edits its response. The prior six-dialog acceptance answered in
under a second and does not prove usable deliberation time.

Give each verified supported native dialog at most five minutes. An already
dispatched original input keeps its 30 seconds of ordinary work time and may
exclude at most 300 seconds of native modal time in total. Successive dialogs
share that input's remaining modal allowance. This is bounded waiting, not a
fresh deadline for each state update or retry.

## Design and invariants

- The original extension attachment owns a monotonic clock driven by verified
  opening/Closed events. Coalesced viewer states and wall-clock timestamps never
  grant extra time. Unsupported, foreign, duplicate or unverified events cannot
  pause a budget.
- Only the already-dispatched input in that original epoch can pause. An input
  still in preparation is not its trigger and must not be sent later merely
  because the person closed a modal. Final native admission remains fenced.
- `epoch.inputPending` and all native tracking retain the actual work Promise.
  A caller timeout does not settle native work, remove capacity or prove cleanup.
  Expiry synchronously revokes the lease, then rejects the caller and starts
  original cleanup. End/Stop remain independent and cancel an unanswered dialog
  before joining blocked work; an already dispatched answer is never replayed.
- Human state advertises optional `inputBudgetVersion: 1`; view state cannot.
  Legacy state without this capability keeps the 30/35-second limits. Only an
  admitted input with the exact current lease/generation and capability receives
  outer Go/UI waits of 335/340 seconds. Dialog answers, End, cleanup, heartbeat
  and Stop keep their existing independent deadlines.
- The UI states the five-minute cap and shared per-operation allowance. It does
  not manufacture a countdown from delayed status delivery or reset timers when
  a successor modal appears. It still requires separate input/dialog receipts.

## Work and validation

- Extension agent owns native clocks, integration, production build list and
  deterministic tests, including delayed actual ACK and pre-dispatch fences.
- Native agent owns strict capability parsing/projection, admission-time outer
  deadline selection, legacy rejection cases and actual-controller tests.
- Root owns viewer UI, integration review, documentation and commit/push.
- Fixture agent owns a separate finite budget acceptance runner. The previous
  six-case runner and its actual five-second decision assertions remain intact.

First preserve a frozen old-candidate natural-timeout diagnostic without Refresh,
blur, End or an answer. If native input has already ACKed, record that fact rather
than fabricating a blocked input. Then freeze the new build and run two original
delivered pages: one prompt held beyond 40 seconds before a Unicode answer; one
unanswered prompt reaching the real 300-second cap. Verify exact original events,
receipts, unique POSTs, paused state and original cleanup/Stop/process identities.
No shortened production test budget, URL reopening, business replay, personal
profile, OS input or focus restoration. Preserve every failed attempt.

## Progress

- The frozen prior candidate naturally reproduces the usability gap in
  `mdb-0gtchS`: the original pointer-up request returns OPERATION_UNCONFIRMED
  after exactly 30000 ms, with no human Refresh, End or answer after opening.
  The UI's automatic End follows that error. Original native Closed is false,
  the document returns null and produces one POST. The diagnostic runner exits
  0 for evidence collection; `featurePassed` is false. Formal Stop and all
  processes exit normally, Job is empty, 26 original identities are gone.
- Original report SHA256:
  `255034828983ec1b63df5f13268db27f36820ef00cd0e2b703a360b27a6e0ebf`.
  The prior EXE/73 extension files/398 source snapshots are immutable; current
  development code is not misrepresented as that old runtime.
- The old passive event listener measures opening to Closed as 29997 ms because
  it records after production handling. Before any new acceptance run, define
  its real-cap observation window as 299750–305000 ms, with an explicit 250 ms
  observer-order tolerance. This does not shorten the production 300000 ms
  limit; deterministic monotonic-clock tests enforce that exact boundary.
  Real evidence claims approximately 300 seconds, not an independently
  measured internal timer start. The positive case still requires at least
  40000 ms of observed active, unanswered pending input before a decision.
- Production is frozen after cross-review. Extension focused tests pass 286/286
  with eight syntax checks. Full internal build `mdb-build-pqoqbc_y` passes Go
  full tests/vet and 2516 Node tests (zero skips), and builds the EXE plus 74
  extension files from 403 unchanged source inputs. EXE SHA256:
  `55eb1a28f3e07abf0799b8a659b66864bbd8792b21bc0bcdbe491ffd85885885`;
  build report SHA256:
  `77c6778219ccf764f5aa97e86814ea7008a33feb8d40d5ddc2958111bd8778c7`.
  Legacy bridge fixture remains capability-free; the result fixture is generated
  by the actual bridge and Go projection with the new capability. Both are checked.
- The frozen runner's 21 fixture/helper tests pass; the old six-case runner and
  its five-second decision assertions are byte-unchanged. Real `mdb-r5BfFQ`
  completes all five steps with actual exit 0 and `featurePassed: true`.
  Its Unicode answer is actually sent 40775 ms after the original opening;
  native Closed follows at 40776 ms. Three original input receipts and an
  independent dialog receipt are verified. The unanswered second prompt closes
  with false/empty input at 300004 ms. Its original pointer-up returns
  OPERATION_UNCONFIRMED, never a fabricated successful input receipt. Both
  original documents keep their tokens and each produces exactly one trusted
  click and one POST; no answer, Refresh or manual End is sent during the cap.
- Both original humanCleanup confirmations and paused state are verified.
  Formal Stop, supervisor, Browser, Native and viewer exit 0; Job is empty and
  `forced` is false. All 28 original process identities are gone, private
  registrations in both views, two original pipes and the endpoint are cleared.
  The run records no cleanup errors or live children. All 876 source snapshots,
  403 build inputs and 74 extension files remain unchanged during the run.
  Original report SHA256:
  `ec052a62847b0dba9532706a7f19b8acccf3b4697d8411223e696a56f7f90e43`.
- Independent original-event/request/receipt/source audit passes 821 checks;
  report SHA256:
  `eedd0a018fae011be1b1ff330201dffd8c63b17befa833e4b52bb76e53c8f3cc`.
  Independent lifecycle/source/image audit passes 56 checks; report SHA256:
  `e4cf90954c1e4f76d001872a8e2742329b49307674d2ed330e07e3500d0f7f93`.
  The latter rechecks original process absence and decodes/views all 14 PNGs:
  all nine received native frames plus five viewer screenshots. Raw native
  uint64 FILETIME is preserved as exact decimal text; a rounded JSON numeric
  copy is not the authoritative identity. ACK and Closed are independently
  checked without assuming their order.
- The 40-second viewer screenshot has been visually inspected: original Unicode
  text, active decision controls and the five-minute/shared-budget explanation
  render correctly. The still image below the modal is not fresh-page evidence.
  The cap-end screenshot explicitly retains a 301-second-old ready page and
  cannot prove the final cancellation receipt pixels. Saved frames do not
  establish continuous visual coverage or OS focus/cursor behavior.
- Postrun, only the budget runner and its test are hardened to record a complete
  sample read interval and re-read the original Closed/input state after UI
  awaits. Only a wholly pre-boundary, still-open observation must remain held.
  Actual native close bounds stay [299750, 305000) ms and the outgoing positive
  answer must still be at least 40000 ms. The focused tests pass 23/23, including
  crossing-boundary, genuinely early closure and absent legacy interval cases.
  The original run used runner SHA256
  `c8b4150ba3db6220a8064d0ec03c9559009f71434f715141f8d2eb33a4cc4167`;
  current runner SHA256 is
  `aef82ebc601f481a9283df00f3f3bf32bba4c027ab3d7200bd276f3effc0111f`.
  At this stage, offline recheck confirms all original snapshots and both
  original reports unchanged, with exactly two current harness differences and
  no production difference. Its report SHA256 is
  `f2332876c9cbee02067381a0d99b7f9f2fbb22dfae2ccb36ddeb48c38e3d4d98`.
  The 338 legacy samples lack `completedAt`; no timestamps are invented, and
  these new interval assertions have not been exercised in a real browser run.
- Final code inspection identifies one further boundary: a late timer could
  allow a second dialog's answer after the original input's cumulative modal
  allowance expired, because response checks only accounted the per-dialog
  deadline. Three new deterministic cases fail against the prior code with
  actual exit 1 and an accepted choice that should have been cancelled. They
  cover expiry before response admission, expiry between admission and native
  dispatch, and an unsent input's ordinary 30-second budget.
  `checkDialog` now accounts the same original epoch's pending input budget at
  both existing response checks. It preserves original actual work and joins
  an already-dispatched answer without substituting cancellation. Focused
  control/budget/dialog tests pass 114/114; both syntax checks pass. Report
  SHA256: `14cf4ab91505706e1e1afc37e5aca1796a221b31c36adfb58dd3f2a3d7138fa4`.
  Only control JS and its test change after the real run; this fix is not
  represented as having been executed in that frozen browser acceptance.
  Independent review repeats all 114 focused checks successfully and confirms
  original epoch fencing, pending native-work ownership and no replacement
  decision after dispatch. Independent report SHA256:
  `977a2a4be9a30c5f66d4c5697f3269d13a2685e4ae47029f60eae3928063444c`.
- Final internal build `mdb-final-bgwg8ysj` exits 0 with 2519/2519 Node tests
  and no skips. All 403 input snapshots remain unchanged during this build;
  exactly the two control files differ from the original real-run build. Go
  source is unchanged, so the original full Go tests/vet are retained rather
  than claimed as repeated; Go build and the 74-file extension build run again.
  EXE SHA256 remains
  `55eb1a28f3e07abf0799b8a659b66864bbd8792b21bc0bcdbe491ffd85885885`.
  Final build report SHA256:
  `89d6b06bd9c9230a996a0ff7ae516208c5fcab7cb656da735f8b46b56deed9f7`.
  This is an internal rebuild, not a release package or a new browser run.

## Remaining objective

Pre-Begin/first-frame/navigation/child-frame dialogs, beforeunload, ordinary
company Edge acceptance and the full P01–P15 matrix remain open. This slice does
not redefine parity around the already passing cases. Published package
`preview-20261018-853ea92` remains unchanged.

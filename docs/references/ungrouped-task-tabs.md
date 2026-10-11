# Ordinary task tabs without native groups

Opera's isolated native runs created a single-tab group successfully, then
observed that group disappear before its title update. The previous backend
stored the vanished group ID and rejected `newTab`; later task listing could
not find the created page. The raw event order and browser versions are in
[Chromium installation evidence](chromium-browser-installation.md). Events
establish order, not whether a browser feature or a user caused the removal.

The compatibility path reuses `AuxiliaryTabOwnership` for explicitly admitted
ordinary ungrouped pages. Native groups remain the default. This is an internal
ownership change; the public creation, claim, action and finalization APIs stay
the same. It does not activate pages, add an anchor tab or replace native input.

## Admission and ownership

A creation reserves capacity before the native call and binds its record only
to the actual returned tab ID and window. The original session, control epoch
and global revision fence the entire operation, including its final response
check and failure cleanup. Membership admissions for one session serialize;
ordinary page actions retain their existing queues.

Only new-page creation or an explicit claim may select ungrouped mode during
admission, after its own new single-tab group is confirmed absent and the page
is still eligible. A fresh explicit claim has user origin; reclaiming an existing
owned page preserves its origin. A
previously accepted grouped page never becomes an ungrouped owner merely
because its group disappears. Subsequent new pages in that ungrouped session
receive individual records instead of repeating the failing grouping attempt.
An unrelated persistence or control error is still a failure even when the
group also disappeared. The compatibility branch cannot hide a failed write.

The bounded registry has one reverse owner per tab. Its version 2 records
distinguish `kind: popup | ordinary` and `origin: user | agent`; legacy version 1
records migrate only to popup/user. Pending and quarantined records grant no
control. Agent-created pending records recovered after a worker interruption
remain quarantined rather than being discarded or automatically replayed.
An `excluded` ordinary/user record additionally stores the exact original
`excludedGroupId`; it grants no control and reserves capacity. Pause, end and
worker recovery preserve that denial. A live check proving departure from that
group/window, destruction, or a successful explicit same-session claim can retire
it. Failed persistence retains the denial and remains retryable.
The existing browser-lifetime storage wrapper prevents stale numeric tab IDs
from granting authority in a new incarnation.

Version 3 additionally stores agent-owned `background-window` records for
[explicit background windows](background-windows.md). Those records can coexist
with a native task group and do not select this ordinary compatibility mode.

Listing, raw target admission, page export and clipboard source checks use the
same explicit membership. Foreign sessions cannot claim an owned ungrouped
page. Ordinary navigation preserves accepted membership; moves to another
window or group, pinning and replacement revoke it. Moving a revoked page back
does not restore control. Existing popup and grouped-page rules remain in force.

## Failure and finalization

Failure cleanup waits for the actual native creation result. It may close only
its exact newly created, not yet accepted page when the observed state still
permits that cleanup. Activation, navigation or other evidence of user takeover
removes deletion eligibility, including on a later cleanup retry. A preserved
failed page still inside a pre-existing task group needs a durable exclusion in
the same registry, so group enumeration cannot silently grant control again.
That exclusion is distinct from an owned page or a pending cleanup; explicit
reclaim must use user origin. The sole active tab in a newly created unfocused
window is distinguished by the actual creation branch, not by `active:true`
alone. Unknown or failed cleanup remains observable; browser APIs do not offer
an atomic compare-and-remove operation.

An omitted agent-origin ordinary page closes on finalization; a user-origin
page is released. Reclaiming the same agent page does not downgrade its origin.
Handoff retains membership for a later explicit turn. An ordinary deliverable
remains as a real inactive page, releases task ownership and stores presentation
metadata without inventing a native group ID. Popup deliverables retain their
existing explicit limitation. Ending control still releases attachments and
input before disposition; no operation is automatically replayed.

The backend can establish that it constructed a successful response, not that
the SDK received it: the protocol has no delivery acknowledgement. Native group
events likewise cannot distinguish a user ungrouping exactly during new-page
admission from a browser removing that same short-lived group. Neither boundary
is an unconditional no-race guarantee.

## Verification

Deterministic tests must cover the observed group-return, group-removal,
update-failure order, cancellation around native/storage awaits, takeover,
cross-session exclusion, origin preservation, worker recovery and finalization.
Real browser acceptance additionally requires actual background navigation and
input, server receipts, continuous focus evidence and exact cleanup. Diagnostic
completion alone is not product acceptance.

The first frozen production acceptance passed on Opera `7IDBb7` and Brave
`vC2mkf`, with API diagnostics disabled. Each completed the standard background
task and the optional public-SDK ownership workflow: four real GETs, five
original trusted POSTs, cross-session rejection, handoff/reclaim, actual omitted
agent-page closure and fresh-scope denial of the delivered page. Native snapshots
confirmed Opera's ungrouped pages and Brave's grouped path. Independent audits
checked source/package identity, zero focus events/allowances, and exact native
process and registration cleanup. The 806 extension tests and full CI also pass.
These finite cases do not establish all brands or long-lived/restart behavior;
details and remaining failures are in the linked browser evidence.

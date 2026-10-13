# Recover website settings after a failed startup read

Status: this slice completed; overall Browser Use parity remains open.

The previous turn made concrete progress: HTML top-layer feedback was fixed,
verified and pushed as `2a01d19`. Overall Browser Use parity remains unproven.
Continue P14 reliability while ordinary Edge authorization is unavailable.

## Required behavior

Expose an explicit action in the live extension popup to read website settings
again. Only a settled read/validation failure grants a one-use recovery ID.
GET and polling do not read storage or retry anything. An unresolved native
operation and an observer timeout never create recovery authority.

Separate the policy failure from other startup readiness results, without
skipping lifetime/input-risk recovery or accepting failed durable control
stores. Startup failure must run actual Pause/drain and retire old epochs.
Recovery runs Pause before reading and stays paused afterward. A rejected
trusted-storage access setup may be retried only by this explicit action.

Read recovery does not save settings, increment/reset a persisted revision or
replace corrupt bytes. A valid saved policy is retained exactly. Confirmed
absence uses the same compatible default as normal startup and is labeled
Default rather than Saved; rejected reads and corrupt values stay unknown.
Replacing corrupt persisted settings would require a separate generation/CAS
design and is not implemented by this read-only operation.

## Verification

Keep module counterexamples for policy readiness, popup unknown state, and
backend control readiness. Cover delayed native settlement, repeated failures,
stale IDs/replies, concurrent popups, trusted-access failure, core failures,
durable Pause failure, old epoch rejection and explicit Resume/new-turn.

The isolated browser workflow preserves a valid restrictive policy, restarts
the actual worker and injects one controlled failure delivering the original
successful native read. Record native and derived Promise outcomes separately;
do not claim a natural storage failure. The popup must recover without policy
writes, remain paused, reject the old scope, then allow one original trusted
form POST after explicit Resume and a new turn. Keep original bytes, document
identity, source hashes and exact focus allowances. Root alone starts browsers.

No PR, no Pi-specific integration, no OS pointer use, no input replay, and no
changes to the previously delivered preview archives. Fullscreen, native UI,
ordinary installation and other parity gaps remain open.

## Implementation and retained failures

Added private failed-read identities and synchronous reservation of the actual
new read Promise. The trusted popup can request only that identity; it cannot
submit replacement settings. Keep failed-write retry separate. Confirmed absence
is labeled Default; corrupt records are never silently replaced.

Startup read failures now schedule an actual Pause and retire old epochs. A
separate read-recovery barrier waits for that Pause while controlReady releases
unbound requests waiting for startup. The original blocked export counterexample
exposed a circular wait; the fixed test holds a real Pause persistence ACK and
requires no recovery ID until its actual completion. Control-store loadError
keeps recovery unavailable without changing the established Pause error API.

Popup tests retain counterexamples for lost successful replies with a lower
revision and same-revision changed contents beneath a dirty draft. A fresh
confirmation of an explicit recovery can establish read authority once; older
responses remain fenced, and changed policy contents require draft review.

The first isolated run `lcHADe` failed before adapter connection because the
staged probe used top-level await, prohibited in Chromium service workers.
Preserve it as a harness failure. Static imports plus a test-only async
initialization wrapper fix that setup without editing production initialization.
The first broad Node run also preserves its failed existing Pause-state case;
the final run passes that original case with unchanged expectations.

## Evidence so far

Focused `yU2VGw` passes 2/2, actual exit 0, with frozen source/runtime hashes.
Native get actually fulfills before controlled delivery rejection. Explicit
popup recovery retains the restrictive policy and revision with zero policy
writes, stays paused, and rejects old control. Only explicit Resume/new-turn
produces the single original trusted form POST. Root inspected both popup PNGs.
The explicit popup opening accounts for two focus events under the unchanged
exact-context matcher; business input gains no focus exception.

Final Node groups: extension 1,346; scripts 278; integration helpers 1,513 pass
and one existing Windows file-symlink privilege skip. Actual exits are zero,
source snapshots unchanged. Targeted backend/Pause 59/59 and popup 49/49 pass.
The previously delivered three preview archives retain their original hashes.

First full run `8Fe9ev` retains actual exit 1, 146/148. A screenshot-drain
oracle incorrectly required the high-level wire timeout to equal the original
1,000 ms public budget; the unchanged SDK legitimately sent 999 ms after
subtracting elapsed preparation. Keep raw-CDP equality and original native
response/order checks, while testing the high-level remaining-budget contract.
The new recovery case also attempted a third popup opening after the previous
popup had closed, which Chromium rejected for an inactive window. Reuse the
existing live website-policy popup before its close; do not refocus the window
or expand focus exceptions. Preserve both failures before the next full run.

Related `GT3npA` passes 8/8 with actual exit 0 and frozen sources/runtimes.
It includes all five screenshot-drain variants, actual worker recovery, Pause,
website settings, borrowed-popup startup reread, tab revocation and host restart.
The new fixture tests retain four counterexamples, then pass 44/44. Final
complete `O0mB6k` passes 148/148, actual exit 0/signal null, with no source or
runtime drift. The previous 147 names retain their order. During 430,422 ms,
the focus observer records only the original 12 exact sole-tab activations and
four intentional control-popup focus events. Recovery borrows the existing
popup and adds no foreground allowance. Ordinary Edge authorization, native
permission UI, corrupt-record replacement and complete parity remain unverified.

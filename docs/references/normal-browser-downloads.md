# Ordinary-start Edge and original download acceptance

This development fixture targets the remaining ordinary-start authorization and
real Native Messaging boundary. It does not change the published preview package
or turn a launch-flag browser result into normal-installation evidence.

## Account boundary

A fresh directory is not an account-isolated Windows environment. Edge can
implicitly sign in with the OS account by default; Microsoft's
[ImplicitSignInEnabled policy](https://learn.microsoft.com/en-us/deployedge/microsoft-edge-policies/ImplicitSignInEnabled)
is not per-profile. Repointing environment variables does not establish the
absence of this mechanism. Do not change the current user's Edge policies to
make this fixture pass. An account-isolated OS user or VM is needed for further
ordinary-start testing when automatic sign-in occurs on the development host.

Read-only review of `5klS04` found a nonempty account list, completed sync setup
and a consented primary account in its newly created profile. No account values
or tokens are part of the evidence summary. That run's launch and cleanup facts
remain valid, but it did not prove account isolation. The browser was already
stopped before the review; no bound download task ran.

The runner now reads bounded, initialized `Local State` and `Default/Preferences`
metadata after bootstrap, before handoff/binding/business clients and after the
task. Evidence contains only fixed field names, booleans and counts. Missing,
malformed or uninitialized metadata rejects the run; default sync datatype
preferences alone do not count as an account session. Observed account or sync
session metadata prevents task acceptance. Browser stdout/stderr are retained
only as byte counts and hashes. These checkpoints detect observed state; they
cannot prevent startup sign-in or prove there were no changes between checks.
The guard rejects the terminated `5klS04` profile in a separate read-only audit;
that is not a new real-browser run of the guarded workflow.
Bootstrap extension inventory retains full metadata only for the exact two
enabled fixture extensions. Unknown, duplicate, disabled or malformed entries
fail with fixed errors and count summaries, without unrelated extension data.

## Running the fixture

On Windows, build the current native CLI and select the installed, signed Edge
binary. Run in an interactive terminal with the two explicit environment values:

```powershell
$env:OBU_TEST_CHROMIUM_BINARY = '<absolute path to msedge.exe>'
$env:OBU_TEST_HOST_BINARY = '<absolute path to the matching development open-browser-use.exe>'
node scripts/browser-integration/normal-browser-downloads-proof.mjs
```

The runner creates a new profile and a unique user-level Native Messaging host
registration under its private run directory. The bootstrap phase alone uses
remote-debugging startup flags and `Extensions.loadUnpacked`. It records the
real browser/native process termination before restarting the same private
profile without those flags. Source, staged extension, SDK and binary identities
are saved alongside the actual ordinary-start process command.

The `HANDOFF` line names a concrete `handoff.json`. Follow its instructions only
in that private Edge window. If unpacked installation did not persist, manually
load its two extension directories. Enable remote debugging on the inspect page,
then enter `bind` in the runner and approve Edge's connection prompt. Each extra
diagnostic Browser WebSocket can require another manual approval. The runner
does not click the checkbox, approve prompts or edit profile preferences.

`bind` invokes the production CLI once with the exact native endpoint, profile
root and original 120-second deadline. A failed attempt remains failed. `stop`
requests bounded cleanup, retaining actual process results; an unfinished task
never becomes PASS. EOF is a stop request, not authorization. The standalone
`normal-browser-downloads.mjs` entry has no business hook and therefore cannot
report successful download acceptance merely because binding succeeded.

## What the business hook verifies

One separately approved diagnostic Browser WebSocket observes the exact OBU
worker, sentinel and independent observer extension through flattened sessions.
It is not the host's production download socket. No `/json/*` HTTP probe is used
during the ordinary-start phase. Native Port identity and binding generation
remain checked through the production host and SDK.

The three JS owners perform the existing root/OOPIF/dynamic-OOPIF POST and Blob
cases: 18 original files, trusted page triggers, original GUID provenance,
foreign-owner rejection and the missing-file negative check. File bytes and
their analysis must agree with each fixture's unique content and server record.
This is not five-entry negative coverage or an open-web export workflow.
The normal fixture uses only these three JS owners. The separate five-entry
runner retains caller transcripts in its isolated download directory; its
caller-side reads are not covered by the shared-Downloads privacy guarantee
described here and must not be reused there without equivalent validation.

The download directory comes independently from the private profile's existing
download setting, or the actual Windows Downloads Known Folder. No controller
sets a download directory or derives it from a returned file path. The shared
proof rejects nonregular files, leaf links and canonical paths outside that
root, and records the opened file identity. Reads are bounded to 64 KiB and
contents are recorded only after exact fixture-byte and digest validation;
unexpected contents must not appear in artifacts or assertion diffs.
Cleanup touches only exact paths
whose original identity and fixture bytes were revalidated. The final check and
unlink are not an atomic guarantee against another process replacing the file.
No recursive cleanup of the user's Downloads directory is allowed.

Permission prompts and explicit sentinel setup precede the task focus interval.
The independent observer must remain continuous through owner finalization,
with no task activation/focus allowances. Observer/browser teardown follows the
final snapshot. A permission denial, missing observer, changed file, unexpected
focus event or incomplete cleanup prevents acceptance.

## Evidence status

The ordinary-start workflow remains unverified until a concrete run records
real user authorization, completed business assertions and actual cleanup.
Two initial bootstrap runs failed the process inventory gate. The first lacked
the remaining-process snapshot; the second preserved the original browser and
host exit 0 and identified a third-party input-method daemon as the remaining
descendant. Parentage alone does not establish fixture ownership. The external
process was left untouched; independent post-terminal cleanup removed only the
fixture's verified registration. Both failures remain archived.
The third run, `5klS04`, verified exact bootstrap browser/host exit 0 and reached
an actual ordinary launch without debugging or automation flags. The temporary
extensions had not persisted, so it requested manual installation and opt-in.
No binding was attempted. Review then found that the shared file proof could
record unexpected file contents before checking them; the same live runner was
stopped to repair that defect. Its `STOPPED` exit 0, `passed:false`, exact process
shutdown, empty descriptors and removed registration prove cleanup, not normal
authorization or download acceptance.
The [active execution plan](../exec-plans/active/2026-10-12-normal-browser-downloads.md)
tracks that boundary and the associated IPv6 discovery compatibility fix.
Unit tests and native WebSocket peers do not substitute for browser permission
UI or the full P01–P15 parity goal.
The final integration unit suite passes 1332 with one existing Windows file-link
privilege skip and actual exit 0. The runner's 68 cases and business hook's 36
cases pass; exact file growth and unverified-content checks are included. The
separate `aa3Fjb` Chromium five-entry regression passes 2/2 with 30 original
files/5200 bytes and no activation/focus during 14813 ms. It still uses the
Native Port adapter and does not close the ordinary-start evidence gap.

## [2026-10-16 01:30] | Task: Preserve network registration cleanup at its deadline

### 🤖 Execution Context

- **Agent ID**: `/root` with `/root/keyboard_chord_fixture`
- **Base Model**: `GPT-6`
- **Runtime**: `Codex desktop on Windows`

### 📥 User Query

> 已经结束了么，再打个新包吧。

Finish the current acceptance work and deliver a new package. Preserve the
previous published package and do not create a PR.

### 🛠 Changes Overview

**Scope:** Network wait registration and its shared Page setup deadline.

- Full Node CI exposed an existing failure: an arm expected
  `OBU_NETWORK_WAIT_TIMEOUT`, but received `OBU_NETWORK_WAIT_EXPIRED`. The engine
  deadline detached the Page while the original subscription enable ACK was
  pending; the resulting Page close removed the network wait first.
- Preserve two effective old-source regressions: dispatching the engine deadline
  first deterministically reproduced `EXPIRED`; a separate cold registration
  callback deadline demonstrated premature detach. Two earlier timer-selection
  harness attempts failed to select exactly the engine timer and are retained
  separately, not counted as product defect evidence.
- Add private `registrationOwnsCleanup`, defaulting to `false`. Only network
  registration opts in, together with `isolateTimeout`. Once registration starts,
  the registry retains the original enable/disable operations through cleanup;
  the engine deadline still rejects promptly but does not detach that Page first.
- Preserve queued-work and attachment-generation checks. Cold attachment setup
  retains its original timeout cleanup; other callers retain their existing
  behavior. This option grants no new page, document or input authority.
- The three affected test suites pass **119/119, actual exit 0**. The deterministic
  backend case verifies Pause remains pending through both original subscription
  ACKs. Existing legacy timeout cases remain in place. No deadline increase,
  alternate accepted error or input replay was introduced.

**Final validation:** Full browser `3GBPrq` passes 180/180; held `K6hnZi` and
normal navigation `4tsar9` each pass 2/2. Node passes 3,933 with one existing
Windows symlink-privilege skip. All runs have actual exit 0 and no source drift.
A fresh Windows preview is assembled from the final clean commit.
The earlier CI failure is retained and is not reported as a passing run.

### 🧠 Design Intent (Why)

The caller's deadline and ownership of actual cleanup are separate. A timer race
must not close the Page needed to finish the original subscription operations.
Keep the shared engine's default behavior and make this ownership explicit only
for the registry that already tracks those operations through Pause and End.

### 📁 Files Modified

- `apps/chrome-extension/background.js`
- `apps/chrome-extension/browser-action-engine.js`
- `apps/chrome-extension/network-wait-backend.test.mjs`
- `apps/chrome-extension/browser-action-engine.test.mjs`
- `docs/references/network-waits-design.md`
- This history record.

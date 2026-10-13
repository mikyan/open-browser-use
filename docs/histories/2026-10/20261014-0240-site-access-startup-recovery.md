## 2026-10-14 02:40 | Recover website settings after failed startup reads

### Execution context

- Agent: root with bounded implementation and independent review tasks.
- Runtime: Codex desktop, Windows; model identifier not asserted.

### User request

Continue Browser Use development while the user cannot complete manual ordinary
Edge setup. Preserve background operation and existing preview packages; push
the tested work to the existing fork without a PR.

### Changes and intent

The extension popup can explicitly reread website settings after a settled
startup read or validation failure. One-use failure identities reject stale or
concurrent attempts. GET never rereads storage. Recovery requires actual Pause
and cleanup, preserves the stored revision without policy writes, and remains
paused until explicit Resume/new-turn. Unread settings show an unknown state;
confirmed absence uses the compatible Default. Corrupt settings are not reset.

Separate input startup from read-recovery readiness to avoid startup Pause
waiting for an unbound operation that is itself waiting for startup. Preserve
the established control-store failure behavior while withholding policy recovery
authority. Keep real pending reads/access setup tracked beyond caller timeout.

Handle lost recovery replies and lower revisions without accepting old replies.
Preserve dirty drafts and require review when either revision or contents change.
Add an isolated original-document workflow with actual worker restart, native
read/controlled-delivery evidence, exact policy preservation and trusted POST
bytes. Its async initialization wrapper exists only in the staged fixture.

### Validation

Focused browser `yU2VGw`: 2/2, actual exit 0, no source/runtime drift. The original
native read fulfills; only its derived delivery rejects. Explicit recovery reads
the unchanged restrictive record with zero policy writes, stays paused, rejects
the old epoch and permits one original form submission after Resume/new-turn.
The existing exact-context matcher accounts for two intentional popup focus
events. This is not a natural native storage rejection or a zero-focus suite.

Node groups: 3,137 pass, zero failures and one existing Windows file-symlink
privilege skip, actual exits zero and frozen sources. Preserve the earlier
staged top-level-await startup failure and broad Pause-contract regression;
neither is silently replaced by passing evidence. First complete run `8Fe9ev`
retains 146/148 and actual exit 1: an overly exact high-level screenshot timeout
oracle and a third popup opening rejected by Chromium. Correct the remaining
budget oracle without changing screenshot execution; borrow the existing live
popup without focus restoration.
Related `GT3npA` passes 8/8, actual exit 0, including five original screenshot
drain cases and the recovery workflow borrowing the existing live popup.
Final complete `O0mB6k` passes 148/148, actual exit 0/signal null and no source
or runtime drift. Previous 147 case names retain their order. The 430,422 ms
observer interval contains only the original 12 exact sole-tab activations and
four intentional control-popup focus events. Recovery adds no foreground
exception. Documentation, repository hygiene and action-pinning checks pass.

### Key files

- Website policy, background startup/control and popup modules with tests.
- Startup recovery fixture, integration runner and existing policy fixtures.
- Website policy contract, architecture and execution/acceptance documents.

Ordinary Edge installation, native permission UI and full capability parity
remain open. The three previously delivered preview archives are unchanged.

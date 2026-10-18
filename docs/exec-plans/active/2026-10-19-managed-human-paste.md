# Text paste through the managed viewer

Status: active. Full Browser Use parity remains unproven. Start from clean
`ecda127`; the previous source-label slice and requested `3241ff0` package are
complete progress. The user has now requested another package after this slice;
build and publish it to the user's fork after validation. No PR is requested.

## Problem and intended behavior

The viewer currently prevents every shortcut keydown and forwards it as a remote
key. Ctrl/Meta+V therefore cannot perform the local browser's default paste, and
the beforeinput-only insertFromPaste handler is not evidence of actual paste.
Pasting the user's chosen plain text into the controlled page should use the
existing human text command, with the original lease, generation and one receipt.
It must not ask the remote browser to read its own clipboard or introduce an
asynchronous clipboard read that can outlive the user's selected input target.

First reproduce this with the current viewer and original browser events. Use
only repository-owned temporary browsers and known synthetic text. A new profile
does not isolate the system clipboard. Reuse the exact audited headless memory
clipboard guard, or re-audit the precise runtime before any clipboard access.
Never read, replace or restore the user's personal clipboard for these tests.

## Contract and verification

- Preserve local paste shortcuts and accept plain text from the original local
  paste event; HTML/files must not be executed or uploaded implicitly.
- Exactly one text operation per accepted paste; no duplicate beforeinput path,
  no forwarded paste shortcut, no replay after navigation, End or reconnection.
- Preserve the original held modifier releases, queue capacity, text bound,
  native ACK and failure/cleanup behavior. Do not broaden IME claims from paste.
- Validate actual trusted paste/default-event behavior independently of synthetic
  unit events, then use the formal viewer/host/extension route to verify exact
  Unicode/multiline insertion, one business POST and normal End/Stop.
- Keep original failures and logs. Unit tests and in-memory clipboard acceptance
  do not prove headed OS clipboard compatibility or complete Browser Use parity.

## Ownership

Root owns the UI implementation and final integration. Native reviewer checks
keyboard/input ownership; protocol reviewer proposes reuse of the formal human
runner; independent reviewer verifies memory clipboard isolation and evidence.
The viewer-only baseline reproduced the real default-paste failure before the
production change. Native input review proved direct insertion with held
Control/Meta/Shift using eight fixed-browser cases. Keep those original holds
and their actual releases; no extra paste queue or synthetic release is needed.

## Progress

- The original viewer prevented trusted Ctrl+V and sent the shortcut remotely.
  The same isolated memory-clipboard diagnostic now observes one trusted paste,
  one plain-text request and the original modifier release. This diagnostic has
  a mock controller and does not prove the complete native route.
- The UI preserves local paste defaults, consumes only synchronous plain text,
  rejects malformed UTF-16/control characters, and prevents a second submission
  through beforeinput. Original held key releases survive composition filtering.
- Native direct text insertion now allows exactly matched Shift/Control/Meta
  code/VK pairs while retaining their original holds. Other keys/buttons still
  reject text. Eight native cases and 110 UI tests pass.
- A fresh build passes full Go test/vet and 2888 top-level Node tests; the final
  harness separately passes 16 focused tests. The original `mhp-q6wHyJ` passed
  paste but failed subsequent wheel hit testing and remains failed. Only the
  harness targeting changed; new `mhp-hAL2oX` completed all six steps with one
  original text request, exact receipt/value, held-Shift End cleanup, unique POST
  and formal Stop. Independent audits and requested package delivery are next.

## Next broader work

Continue the full P01-P15 matrix after this slice. Restricted original HTTP/POST
download association, company Edge, broader input/IME/platform behavior and full
paired task comparison remain open; this plan does not redefine the goal.

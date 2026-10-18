# Native modal readiness diagnostic

This diagnostic measures the pinned Windows Chromium 156 transport. It does not
exercise a production human lease or viewer and never sets `featurePassed` to
true. The published e3fee2a preview and its support boundary are unchanged.

## Reproduction

Build and freeze the host, extension and build manifest first. Set these absolute
paths in PowerShell, then choose exactly one case per original run:

```powershell
$env:OBU_TEST_HOST_BINARY = '<frozen-build>/open-browser-use.exe'
$env:OBU_TEST_EXTENSION_DIR = '<frozen-build>/extension'
$env:OBU_TEST_BUILD_MANIFEST = '<frozen-build>/build.json'
$env:OBU_TEST_CHROMIUM_BINARY = '<pinned-runtime>/chrome.exe'
$env:OBU_TEST_MODAL_BOUNDARY_CASE = 'native-navigation'
node scripts/browser-integration/managed-modal-boundary-check.mjs
```

The other case is `native-pre-attach`. The runner requires Windows and the fixed
CfT binary hash, verifies the build inputs, and saves each original run under a
new ignored `mbd-*` directory. Its source and fixture have focused tests:

```powershell
node --test scripts/browser-integration/managed-modal-boundary-check.test.mjs scripts/browser-integration/managed-modal-boundary-fixture.test.mjs
```

The public SDK creates and delivers one page, then closes its original business
connection. Only after the original attachment has gone does an explicit native
diagnostic attachment take ownership. Worker binding events separately record
enqueue, actual native dispatch and actual settlement. Observation deadlines
never cancel or forget native Promises. Events before the diagnostic attach ACK
are retained as unowned observations and cannot authorize a response. A queued
cancel rechecks the same original modal at actual dispatch.

The fixture permits one navigation or one gate release, one original prompt and
at most one cancellation POST. Gate and HTTP markers are not native modal proof.
Without a unique original Opening, the runner makes no dialog response and uses
formal Stop. It never evaluates task-page JavaScript while an observed modal is
open, reopens the business URL, replays input, or uses the system mouse. Trace
loss, overflow and observer errors fail completion without skipping Stop.

## Original observations

Both cases used immutable `mof-build-0gxew513`, with 407 source inputs and 76
extension files. Its manifest SHA256 is
`e786c4675e7fb79f1f8995aec85b5aa19bcff9bda80a6f62da1a32d388efae5e`.
The two runner processes actually exited 0; this means the bounded diagnostic
and cleanup completed, not that initial/navigation human control is supported.

All 23 focused tests and two independent ownership regressions pass; the earlier
independent failure is retained. Independent lifecycle audits pass 55/55 and
51/51 checks. Each verifies 407 built sources, 377 diagnostic inputs, 76 extension
files and 26 SDK files; all four saved PNGs decode fully. Original FILETIME
identities come from the raw lifecycle decimal strings, not rounded JSON
numbers. Lifecycle audit SHA256s, navigation then pre-attachment:
`76e4abe93fbb1bd9be548a02ece7042672f6b3792f88fd093486a891c0dd7094` and
`650882ee30426bfaa50ff16fff37e27b48560ff0131f1b15de75d9da3b27b190`.
Independent event audits pass 310 and 49 checks, respectively, with actual exit
0. Their SHA256s are
`3c3652d68107f3f0e7425c8d97ae89320718ce39515823df883491cb583a5ba5` and
`a7bf5027b79701e81adbf6e3013afb5afe9bc8be33db0eb1845e27ea3bc552ce`.

### Navigation: mbd-q3T37z

Report SHA256:
`5d8f54fc50daf40a8a93f01d8599191870b14f2a4221535ab593cd9301356549`.
The original pointer-up dispatched at worker sequence 40 and acknowledged at 43,
before the prompt Opening at 54. This case does not demonstrate an input ACK
blocked by a modal. The destination's native frame/context events preceded its
Opening; they do not by themselves establish the full production policy proof.

| Original command | Dispatch | Actual ACK | Relation to original modal |
| --- | ---: | ---: | --- |
| stopScreencast | 56 | 57 | Before Closed |
| getFrameTree | 59 | 76 | After Closed |
| getLayoutMetrics | 61 | 77 | After Closed |
| Runtime.enable | 63 | 78 | After Closed; already enabled before navigation |
| Performance.enable | 65 | 79 | After Closed |
| Performance.getMetrics | 67 | 75 | After Closed |
| startScreencast | 69 | 70 | Before Closed |
| Original cancel | 72 | 74 | Original Closed at 73 |

All seven probes were dispatched while the unique original prompt was open.
Five remained unresolved at the observation deadline and completed only after
Closed. Start/stop ACKs therefore cannot stand in for renderer metadata readiness.
The original document then submitted one null-result POST. Four saved native
frames are retained; no screenshot is treated as a native dialog or ACK proof.
Fourteen observed original process identities, Job termination, both registry
views, named pipes and private endpoints were checked after formal Stop.

### Before attachment: mbd-Iw14Wg

Report SHA256:
`007f161a00319e82f23d0edccdcf72cf58e22e1cd6f01acc3de21ce2768a7ce8`.
The original server gate and before-call marker were observed before the new
attachment. Attach and Page.enable acknowledged, but the new attachment had no
Opening. No cancel or metadata probes were dispatched. The runner used formal
Stop; fifteen observed original processes and the private resources were gone.
There are no saved native frames in this case.

The fixture's null-result POST was recorded about 289 ms before the diagnostic
attach request/dispatch. Thus this case does not establish that a modal was
still open when the new attachment began. The original page returned null and
submitted; the trace does not explain whether or how a browser dialog appeared.

This does not prove a modal existed, was suppressed, or was absent. It establishes
only that the new attachment acquired no native authority to answer one. The
pinned PageHandler implementation keeps its dialog callback on the enabled
handler and does not replay old Openings from `Enable`:
[fixed Chromium source](https://chromium.googlesource.com/chromium/src/+/634b046faf2137b83af71c87baf362b533af9104/content/browser/devtools/protocol/page_handler.cc).

## Consequences and limits

A two-stage Begin still needs separate lease admission, document proof and
display readiness across extension, bridge, Go and UI. However, the document
proof must not assume fresh renderer queries can complete while a modal is
open. Investigate whether already recorded original frame/context/navigation
events and current browser policy can provide a complete immutable proof before
publication. If they cannot, keep the case explicitly unsupported. Never reuse
an old SDK attachment or treat the Opening URL as authorization.

The probes were concurrent and the repeated Runtime.enable was warm. This is
not evidence about cold Runtime setup, all Chromium internal dependencies,
child/OOPIF modals, outgoing-document navigation, first-frame acceptance or
ordinary company Edge. New rendering and input must still await original old
drains; this diagnostic does not authorize overlapping production streams.
Independent mock counterexamples also retain the current cross-layer readiness
limitations. Production changes and formal viewer acceptance remain pending.

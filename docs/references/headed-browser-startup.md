# Headed Chromium startup and first-frame diagnostics

Status: **test-environment diagnosis, not a general production workaround**.
Observed on 2026-10-11 with Windows Chromium `156.0.8078.4`, revision
`f842f52ef39fd97b449eb27cff414bf05a98ddce`, executable SHA-256
`7f08161bbeb2853ffe1780a9ded4985087f52efb9725d7d8207aabdd42f7cfb9`.
These results do not establish behavior on other Chromium builds or platforms.

## Retained observations

The isolated native probe used a fresh profile, synthetic loopback pages and a
minimal extension. Commands went through the extension's `chrome.debugger` API;
the external CDP connection only operated the worker. Both scenarios enabled
focus emulation, started a PNG screencast and acknowledged delivered frames.
They did not activate the target tab or restore focus afterward. Launch used
`windowsHide: true` and the existing test-only `--no-sandbox`, without headless
or native-occlusion-disable flags. This is not sandbox acceptance.

| Run / scenario | First frame and native action evidence | Focus evidence |
| --- | --- | --- |
| `native-window-render-igSkFc`, startup window | No frame or ACK within 10,002 ms, despite a complete document, nonzero viewport, emulated focus and a completed rAF callback. | Original sentinel stayed active; no recorded window-focus events. This run did not retain Win32 HWND observations. |
| Same process, subsequently created normal window with `focused: false` | First frame in 154 ms, two ACKs, one trusted click, and a retained 1,878 × 1,832 PNG whose bytes match its recorded digest. | Only the new window's initial sole-tab activation was recorded. The target stayed inactive, both sentinels stayed active, and no window-focus event occurred. |
| `native-window-render-LY1jkZ`, `--no-startup-window`, first explicit normal window with `focused: false` | No frame or ACK within 10,002 ms. Its native HWND was visible, not minimized or cloaked, and had nonzero bounds before and after the wait. | Only the new window's initial sole-tab activation; no recorded focus change. |
| `native-window-render-WKm5AW`, no startup window, explicit unfocused popup followed by an unfocused normal window | The second window's inactive target still received no frame or ACK within 10,008 ms. All native commands, including stop/detach, settled; no input or screenshot was attempted after the first-frame timeout. | Two exact sole-tab creation activations, no focus events, and both sentinels unchanged. |
| `native-window-render-Tm7h8l`, HTTP app startup window followed by an unfocused normal window | The startup app's synthetic active sentinel produced a first frame in 67 ms, two ACKs, one trusted click and a valid PNG. The second normal window's inactive target still received no frame or ACK within 10,015 ms. | One exact normal-window sole-tab creation activation and no focus events. This positive app result does **not** prove inactive-tab rendering. |

The first comparison is sequential: it does not isolate elapsed startup time,
viewport size or the initial window's creation path. The second run shows that
creating an unfocused window alone is insufficient. A recorded
`GetForegroundWindow() == 0` does not establish a locked desktop or its cause.
Browser event ledgers start after worker initialization; they do not prove that
process startup never attempted activation.

`--app=about:blank` did not create an app in this build; HTTP app startup reported
the native type `app`, not `popup`. Trying to create another tab in that app
returned a tab in a different normal window, so the completed app probe instead
used its original synthetic page. Setup assertions caught these differences;
those aborted attempts are not successful rendering observations. None of the
startup alternatives above is a demonstrated general workaround. The failed
normal-window waits also did not retry or send input after their deadlines.

## What the pinned source establishes

Node `24.14.1` sets `UV_PROCESS_WINDOWS_HIDE` for `windowsHide: true`. Its bundled
libuv sets `STARTF_USESHOWWINDOW` and `SW_HIDE`; it also adds `CREATE_NO_WINDOW`
when standard descriptors are not inherited. Thus this option affects GUI show
state as well as console creation. Windows ignores `CREATE_NO_WINDOW` for a
non-console application. See [Node's option mapping](https://github.com/nodejs/node/blob/v24.14.1/src/process_wrap.cc#L327)
and [libuv's exact launch code](https://github.com/nodejs/node/blob/v24.14.1/deps/uv/src/win/process.c#L1019),
plus [Win32 creation flags](https://learn.microsoft.com/en-us/windows/win32/procthread/process-creation-flags).

Chromium reads the startup show state, but its window handler explicitly calls
`ShowWindow` again with `SW_SHOWNORMAL` when the resolved native show state is
`SW_HIDE`, then activates normal/maximized windows. Consequently,
`windowsHide: true` is neither proof of permanent hiding nor a promise of
focus preservation. The exact branch depends on the requested show state.
See [initial-state lookup](https://github.com/chromium/chromium/blob/f842f52ef39fd97b449eb27cff414bf05a98ddce/chrome/browser/ui/views/frame/browser_desktop_window_tree_host_win.cc#L325)
and [the window show path](https://github.com/chromium/chromium/blob/f842f52ef39fd97b449eb27cff414bf05a98ddce/ui/views/win/hwnd_message_handler.cc#L771).

Focus emulation already increments the WebContents visible-capture count.
Screenshot capture instead acquires a hidden-capture count. These drive page
painting and an Aura video-capture lock; they are distinct from native window
focus. Native compositor-visibility updates also depend on the host having been
shown. In this revision, `CalculateNativeWinOcclusion` is enabled by default,
but `ApplyNativeOcclusionToCompositor` is disabled by default and has a separate
mode parameter. Runtime feature configuration must not be inferred from the
feature name alone. See [focus emulation](https://github.com/chromium/chromium/blob/f842f52ef39fd97b449eb27cff414bf05a98ddce/content/browser/devtools/protocol/emulation_handler.cc#L1042),
[capture and visibility](https://github.com/chromium/chromium/blob/f842f52ef39fd97b449eb27cff414bf05a98ddce/content/browser/web_contents/web_contents_impl.cc#L2828),
[native compositor visibility](https://github.com/chromium/chromium/blob/f842f52ef39fd97b449eb27cff414bf05a98ddce/ui/aura/window_tree_host.cc#L706)
and [feature defaults](https://github.com/chromium/chromium/blob/f842f52ef39fd97b449eb27cff414bf05a98ddce/ui/base/ui_base_features.cc#L38).

`Page.startScreencast` starts a video consumer and returns before receiving a
frame. Viz requires an activated Surface with an active, nonempty compositor
frame. If the capture region is unavailable because no first frame has been
composited or its size is zero, the capturer schedules another refresh. DOM
visibility, rAF completion and a successful start response therefore do not
prove that this capture prerequisite exists. See [screencast startup](https://github.com/chromium/chromium/blob/f842f52ef39fd97b449eb27cff414bf05a98ddce/content/browser/devtools/protocol/page_handler.cc#L1636),
[capture-region requirements](https://github.com/chromium/chromium/blob/f842f52ef39fd97b449eb27cff414bf05a98ddce/components/viz/service/frame_sinks/compositor_frame_sink_support.cc#L1367)
and [refresh behavior](https://github.com/chromium/chromium/blob/f842f52ef39fd97b449eb27cff414bf05a98ddce/components/viz/service/frame_sinks/video_capture/frame_sink_video_capturer_impl.cc#L657).

## Trace: child surface exists, capture does not complete

The fixed-configuration run `render-trace-gQvPvp` retained `content`, `viz`,
`gpu.capture` and compositor traces with stage clock markers. The trace contains
115,167 events, reports no data loss, and has SHA-256
`6a42fda25e11f433366eb23b1bd2bf244a331dd8c7a96c0369d0d405bd90767a`.
It disproves the initial hypothesis that the startup target never activates a
child Surface:

| Observed stage | Startup window | Secondary unfocused window |
| --- | --- | --- |
| Child Surface | `FrameSinkId(7, 7)` commits and activates; capture region is 1,877 × 1,748. | `FrameSinkId(13, 7)` commits and activates. |
| Capture | `Capture` and `CopyOutputRequest` begin, without a terminal event before tracing stops. | First `Capture` completes in 215.872 ms; two frames are delivered and acknowledged. |
| Display/copy service during the native test interval | No `Display::DrawAndSwap`, `Surface::RequestCopyOfOutput` or Skia `CopyOutput` event. | Root `FrameSinkId(0, 2)` activates; Display drawing, Surface copy dispatch and Skia copying occur. |
| Public observation | First-frame wait expires at 10,003.2 ms; no input follows. | First frame arrives in 236.1 ms; one trusted click and a valid PNG follow. |

The pinned implementation [queues the capture request](https://github.com/chromium/chromium/blob/f842f52ef39fd97b449eb27cff414bf05a98ddce/components/viz/service/frame_sinks/video_capture/frame_sink_video_capturer_impl.cc#L1270)
on [frame-sink support](https://github.com/chromium/chromium/blob/f842f52ef39fd97b449eb27cff414bf05a98ddce/components/viz/service/frame_sinks/compositor_frame_sink_support.cc#L1447).
[Surface aggregation takes that request](https://github.com/chromium/chromium/blob/f842f52ef39fd97b449eb27cff414bf05a98ddce/components/viz/service/display/surface_aggregator.cc#L2083)
for [Surface copy dispatch](https://github.com/chromium/chromium/blob/f842f52ef39fd97b449eb27cff414bf05a98ddce/components/viz/service/surfaces/surface.cc#L948).
The evidence therefore narrows this run's stall to after child-frame activation,
before root Display aggregation services the copy. It does not identify which
[DisplayScheduler drawing prerequisite](https://github.com/chromium/chromium/blob/f842f52ef39fd97b449eb27cff414bf05a98ddce/components/viz/service/display/display_scheduler.cc#L602)
was unsatisfied. Initial native window creation precedes the trace, so absence
of a recorded startup root-frame event is not proof that no root ever existed.

That startup scenario remains failed. All observed extension-native promises,
including stop/detach, settled; the trace stream closed and the browser root
exited normally. This does not claim that the uncompleted internal Viz capture
had already settled. The event ledger contains only the secondary window's
exact initial tab activation and no focus events, within the stated listener
coverage. This sequential, instrumented run is neither a production fix nor
evidence about OS foreground state, locked desktops or other Chromium builds.

## Startup trace: root Surface remains pending

The later `rendering-MCMbt8` probe starts tracing through a configuration file
passed before browser spawn. Its retained Perfetto trace begins 328.6355 ms
before the first `Widget::Init` and includes native `WM_NCCREATE`, `WM_CREATE`
and window-show events. Typed scheduler and Surface arguments are retained;
the analysis reports no trace errors or data loss. This closes the earlier
trace's missing startup interval without changing the extension's behavior.

The browser UI scheduler is visible, can draw, has an unpaused BeginFrame
source and an active layer-tree frame sink. Its frame number advances from 17
to 587, while one submitted frame remains pending and the last submitted frame
number stays at 2. Thus the trace does not support a simple absence of
BeginFrames or an invisible UI compositor as the explanation.

The initial root `FrameSinkId(0, 1)` commits a frame but never records
`Surface::ActivateFrame`. Its `SurfaceQueuedPending` interval remains open
through the trace's end. The dependency arguments identify two distinct sinks:

- `FrameSinkId(5, 3)` maps to the `chrome://webui-toolbar.top-chrome/` renderer.
- `FrameSinkId(6, 3)` maps to the initial `about:blank` renderer. After sentinel
  navigation replaces that renderer, the old sink unregisters; the root's
  pending interval still does not end within the trace.

The child page activates a Surface, but the root never activates or services
the queued copy. GPU `SendNoActiveSurface` events do not carry a sink ID, so
their individual counts cannot be attributed to this root or its deadline.
The evidence identifies the blocked root and its dependencies; it does not
alone explain every dependency's deadline behavior.

## Testing field trial and controlled comparisons

The original browser had no explicit feature-enabling argument, but its trace
metadata contains study/group hashes `3158107110 / 1621198459`. Applying
Chromium's [field-trial name hash](https://github.com/chromium/chromium/blob/f842f52ef39fd97b449eb27cff414bf05a98ddce/base/metrics/metrics_hashes.cc#L42)
to the pinned configuration yields exactly one matching pair:
`WebUIReloadButtonStudy / EnabledWithSurfaceSync_20260902`.
The [Windows experiment](https://github.com/chromium/chromium/blob/f842f52ef39fd97b449eb27cff414bf05a98ddce/testing/variations/fieldtrial_testing_config.json#L20542)
enables 23 features, including `InitialWebUI`, `InitialWebUISurfaceSync`,
`PerDependencyDeadlines` and individual WebUI toolbar controls. It configures
`deadline_in_frames=12000` and `renderer_commit_delay_ms=100000`, rather than
the feature's [source defaults](https://github.com/chromium/chromium/blob/f842f52ef39fd97b449eb27cff414bf05a98ddce/third_party/blink/common/features.cc#L813)
of 600 frames and 10,000 ms. Runtime membership is observed; those parameter
values come from the matching pinned experiment, not a separate runtime
parameter dump.

| Run | Explicit test-config change | Startup / secondary first frame | Native outcome |
| --- | --- | --- | --- |
| `rendering-MCMbt8` | None | Timeout at 10,011.6 ms / 84 ms | Startup: zero frames/ACKs, no input or PNG. Secondary: two ACKs, one trusted click and a valid PNG. |
| `rendering-3V0dDE` | Generated control: `--disable-features=InitialWebUISurfaceSync` | 83.6 / 53.3 ms | Both: two ACKs, one trusted click and valid PNGs. |
| `rendering-7USN6G` | Formal control: same single feature argument | 75 / 54.5 ms | Both: two ACKs, one trusted click and valid PNGs. |
| `rendering-b4WKbw` | `--disable-field-trial-config`; no feature override | 59.3 / 68.6 ms | Both: two ACKs, one trusted click and valid PNGs. |

All four runs retain zero observed window-focus events and exactly the
secondary window's initial sole-tab activation; both sentinels remain active.
The successful images are 1,877 × 1,748 and 1,878 × 1,832 pixels, with recorded
hashes. The three-run Surface audit independently checks PNG structure/pixels
for `MCMbt8`, `3V0dDE` and `b4WKbw`. Native command promises and cleanup settle.
The original startup failure remains a failure.

The single feature argument is **not a single effective-feature comparison**.
Chromium [skips an entire testing experiment](https://github.com/chromium/chromium/blob/f842f52ef39fd97b449eb27cff414bf05a98ddce/components/variations/field_trial_config/field_trial_util.cc#L84)
when any of its features is overridden on the command line, before creating
the trial or applying its parameters. The study hash is absent from both
single-feature control traces, consistent with that rule. Their success cannot
isolate `InitialWebUISurfaceSync` from the other features and parameters removed
with it. In `3V0dDE`, only the old page sink remains a root dependency, for
56.0126 ms before root activation. In `b4WKbw`, that pending interval ends after
62.923 ms and the startup root records 22 activations. Its trace also covers
native window creation, beginning 279.4215 ms before the first `Widget::Init`.

The retained audit inputs and queries are
`.tmp/p09-startup-surface-audit.json`,
`.tmp/first-surface-source/fieldtrial-runtime-match.json`, and each run's
`fieldtrial-metadata.csv`. They preserve the raw hashes, typed Surface
dependencies, trace/binary/config hashes, image checks and event ledgers.
`7USN6G` has native-result and field-trial/hash verification; its full Surface
timeline was not independently decoded for the three-run Surface audit.

## Why the explicit test baseline disables testing config

Chromium [documents this configuration](https://github.com/chromium/chromium/blob/f842f52ef39fd97b449eb27cff414bf05a98ddce/testing/variations/README.md#L6)
for developer and Chrome for Testing builds; Chrome-branded builds do not use
it by default. The first matching experiment is selected after platform
filtering. The same documentation lists `--disable-field-trial-config` as a
supported way for other Chromium builds to disable these testing experiments.

The installed Playwright **1.64.0** launcher also includes this flag in its
default Chromium arguments, matching its
[versioned official source](https://github.com/microsoft/playwright/blob/v1.64.0/packages/playwright-core/src/server/chromium/chromiumSwitches.ts#L56).
The local `playwright-core/lib/coreBundle.js` contains it at line 36207 and
expands those switches in `_innerDefaultArgs` at line 44754. The manual probe
borrowed only Playwright's executable path, so it did not inherit that default.

An explicit, reported testing-config baseline is therefore justified for this
isolated acceptance browser. It does not modify the extension, user profiles,
installed-browser feature settings or production behavior. It does not import
Playwright's unrelated background-throttling or occlusion switches. The saved
unmodified baseline and the whole-study confound remain part of the evidence;
the successful native probe alone is not a production-suite result.

## Headed integration under the declared baseline

The production build subsequently passed the focused `run-Uq8Fkj` **3/3**:
raw navigation before engine attachment, offscreen-frame element screenshots,
and page screenshots. Its continuous event ledger contains no activation or
window-focus event and passes final validation. Its recorded production
extension, native-host, JavaScript SDK and Python SDK hashes match the earlier
failed `run-XLWzut`; the passing comparison does not incorporate a production
rendering patch. The complete headed
`run-NJ72u2` then passed **61/61**, including the public SDK/CLI/MCP paths,
worker restart, Pause and website-access controls. Both runs record the exact
browser binary and `--disable-field-trial-config` in `browser-startup.json`.
The existing isolated loopback transport adapter and test-only lifecycle
injections remain declared in `sourceIdentity`; these are not unmodified
native-messaging transport acceptance runs.

The full run is **not zero-focus**. Its uninterrupted observer history contains
five activations, each bound to the observed creation interval of a synthetic
popup's sole tab, and four window-focus events. The latter are two exact pairs
`[sentinelWindowId, -1]`, occurring only during the harness's two deliberate
`chrome.action.openPopup` calls for Pause/Resume and website-access settings.
Each allowance retains its original event index, sequence, interval and live
`POPUP` context proof; the final sentinel stays active and
`focusLedger.finalValidation` is `passed`. There are no unaccounted events in
that observer interval. Process setup and teardown remain outside its scope.

An independent audit of `NJ72u2` verifies 35 retained PNGs (18 screenshots and
17 two-pixel media downloads), PNG CRCs/decoded pixels and recorded hashes,
plus the signatures, sizes and hashes of the five PDF/MHTML pairs. Its frozen
production extension, SDK and host hashes also match `Uq8Fkj` and `XLWzut`.
The saved audit is `.tmp/p09-headed-full-audit.json`; checks of those exact
test-run paths found no remaining browser, host or caller process.

## Remaining diagnosis

Startup tracing now identifies a nonactivating root Surface with WebUI toolbar
and initial-page dependencies, and runtime metadata establishes involvement of
the pinned testing experiment. It does not isolate one feature as the complete
cause, establish behavior under installed-browser Finch configurations, or
justify moving user tabs to another window. A true single-feature causal test
would need both arms to retain the same other experiment features and
parameters, with effective runtime configuration checked again.

The headed integration results above establish this build's tested actions
under the declared baseline, with real screenshot/input checks and the exact
event allowances described above. They do not erase the failed unmodified
testing configuration or establish a general extension-side rendering repair.
No arbitrary delays, focus restoration, headless substitution or persistent
system settings can replace that evidence. Screenshot-associated focus events
on other builds also remain a separate constraint; the startup diagnosis does
not authorize an exception for them.

## Acceptance event-log correction

The earlier integration runner copied activation/focus arrays between worker
and temporary observer contexts during a worker restart. Independent review
found gaps between snapshots and listener installation, plus a repeated append
in one cleanup path. Historical action/content results are retained, but those
old arrays alone cannot prove uninterrupted event coverage across restarts.

The revised runner keeps one staged-only observer document throughout all agent
actions and worker restarts. It records duplicates, rejects replacement or
truncated history, attributes only exact observed popup-event indices, and
checks the actual final saved snapshot again. A missing observer fails the run;
previous accepted history and the failed observation remain separate evidence.
This improves the acceptance mechanism, not Chromium's rendering. Initial
process/observer setup and teardown after the final checkpoint are outside its
continuous agent-action interval. See the [runner contract](../../scripts/browser-integration/README.md).

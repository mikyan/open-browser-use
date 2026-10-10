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

The startup scenario remains failed. All observed extension-native promises,
including stop/detach, settled; the trace stream closed and the browser root
exited normally. This does not claim that the uncompleted internal Viz capture
had already settled. The event ledger contains only the secondary window's
exact initial tab activation and no focus events, within the stated listener
coverage. This sequential, instrumented run is neither a production fix nor
evidence about OS foreground state, locked desktops or other Chromium builds.

## Remaining diagnosis

These runs record a first-window rendering difference; they
do not yet identify a single Chromium root cause or justify moving user tabs
to another window. A useful next comparison begins tracing before native
window creation and retains the startup UI compositor and DisplayScheduler
state: visibility, output-surface loss, missing root frame and pending damage.
Any proposed initialization change must then pass the ordinary headed suite
with the same strict activation/focus ledger and real screenshot/input checks.
Do not replace that evidence with arbitrary delays, focus restoration, a
headless run or persistent system settings.

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

# Explicit background task windows

`createTab({backgroundWindow: true})` creates a new normal browser window with
one selected `about:blank` tab and `focused: false`. It is useful for native
operations such as directory enumeration that require the selected tab in a
visible window. The window is visible and can appear on the taskbar; this is not
a hidden or headless browser. Other windows and their selected tabs are not moved
or activated. Omitting the option or passing `false` keeps ordinary tab creation.

`getInfo.metadata.backgroundWindowVersion === 1` advertises this contract. Public
clients check it before requesting the new route, so an older extension cannot
silently ignore the option and create an ordinary inactive tab instead. Only a
boolean is accepted. The backend creates the page; it never relocates an existing
user or task page to satisfy a directory upload, and never retries a file choice.

## Ownership and cleanup

Creation shares the existing admission transaction, capacity reservation,
control epoch, pause revision and first-document checks. The actual native
return supplies the tab and window identity. Creation events before that return
are matched to those identities; a URL or an active flag alone proves no ownership.

The auxiliary registry's version 3 adds `kind: background-window` with agent
origin. Older version 1 and 2 records remain readable. This record is separate
from ordinary ungrouped compatibility mode: a session can retain its existing
native group and also own several independent background windows. A new window
does not confer authority over other tabs later added to it.

Moving, regrouping, pinning or replacing the owned page withdraws that ownership.
An excluded background-window record retains a denial with user origin until
explicit reclaim or destruction; movement through an intermediate ungrouped
position cannot restore authority through the old task group. Pending creation
recovered after interruption stays quarantined; it does not replay window
creation or infer safe deletion. A revoked creation can clean up only its exact
page when the existing transaction still proves deletion is valid.

`finalizeTabs([])` closes the omitted agent tab. Chrome then closes an empty
window; the extension never closes the entire window by its ID. A later user tab
in that window therefore survives. Handoff preserves the owned page for a new
explicit turn; deliverable retains the page and releases task authority. Pause
and turn end release input and attachments without deleting accepted pages.

## Public entry points

- JavaScript: `browser.newTab({backgroundWindow: true, url})` or
  `client.createTab({backgroundWindow: true})`.
- Python: `browser.new_tab(url, background_window=True)` or
  `client.create_tab(background_window=True)`.
- Go: `client.CreateTabWithOptions(CreateTabOptions{BackgroundWindow: true})`;
  the browser facade adds `NewTabWithOptions` without changing `NewTab`.
- CLI: `open-browser-use open-tab --background-window`.
- MCP: `open_tab` with `background_window: true`.

See [file transfers](file-transfers.md) for directory completion and the original
node's native `FileList` semantics. An unfocused window still becomes unsuitable
if it is minimized or its task tab ceases to be selected. The backend reports a
native cancellation instead of switching it back to the foreground.

## Verification boundary

The isolated popup experiments established feasibility, not acceptance of this
public normal-window API. Production verification must use the public creation
option, original chooser/action deadlines and actual file bytes in root, existing
OOPIF and dynamic OOPIF layouts. Continuous focus evidence must identify each new
window's sole-tab creation separately and allow no window-focus events. Mixed
group/window ownership and preservation of a later unrelated tab require actual
native inventory after finalization. Browser and platform coverage remains finite.

The Windows Chromium 156 public-route run `UPWXAL` passed the directory and
mixed-window cases. Its complete selection was 4/5: the inactive cancellation
fixture captured its scope before the existing session initialization. Moving
that capture after the existing acknowledgement fixed the fixture; no browser
action, native completion event or deadline was changed.

The earlier full run `zyiYQg` passed all four new cases and retained the original
105 cases in order, but finished **106/109**, with three dynamic-OOPIF chooser
collection timeouts before any file setter. This is not a clean full regression.
The new background directory case checked 16 rounds, 13 actual HTTP submissions,
30 file payloads and 408 original file bytes across root, existing OOPIF and
dynamic OOPIF. Twelve selections had trusted native completion witnesses; the
other submission was the existing explicit clear operation with untrusted
programmatic events. The inactive case retained native trusted cancellation and
zero uploads. Mixed ownership cleanup closed only the three owned tabs and
preserved the extra unclaimed page before the fixture removed that page itself.

The continuous full-run ledger contained four new sole-tab creation activations,
one natural successor activation after closing an owned tab, and the original
six activations/four window-focus events from unrelated fixtures. Every event
was matched to its exact fixture identity; the new window cases added no window
focus, and the user sentinel remained selected. These results concern isolated
headed Chromium using the real Go host with a test-only native Port adapter;
they do not prove installation or foreground behavior on every browser/platform.
The published `preview-20261011-593a4ba` package predates this feature.

The next full run `XHmJdq` finished **108/109, exit 1**, with the original 105
cases passing in their original order and three of four new cases passing.
The background-directory case timed out collecting its first dynamic-OOPIF
chooser, before a file setter. Root and static OOPIF completed 12 rounds:
eight trusted directory selections, one synthetic clear, three rejected inputs,
and nine actual submissions containing 20 file payloads / 272 original bytes.
Return-time witnesses, exact owned-page cleanup and the extra unclaimed page's
survival were independently verified. The continuous 186630 ms ledger again
matched all 11 activations and four pre-existing popup focus events, with no
unknown events. Production, host and SDK hashes match the earlier run; these
results do not resolve either run's dynamic chooser failures. The failed
directory round had no failure-time DOM/native command record, so the evidence
cannot establish whether its acknowledged click reached the input.

# Agent feedback after same-document DOM replacement

An application can rebuild its root children or replace `documentElement`
without navigating. The content script stays alive, but its previous visual
feedback nodes may be detached. On the next visible feedback update, the
extension retires that renderer and creates a new owned host under the current
document root. A valid press can also recover the layer when the application
rebuilds between movement feedback and the original press notification.

## Lifetime and ownership

The current renderer must retain its original direct document-root parent,
open shadow root, layer and cursor relationships. Merely remaining connected
inside another application subtree is insufficient, including a layer moved
into another connected shadow root. Retirement clears rings and their timers,
cancels the old frame and removes only the retained owned layer and host.
An old callback cannot report arrival or retire a newer renderer.

Hidden state, turn end and pagehide do not allocate a replacement. The original
state-revision check rejects a late bootstrap reply. A frame that observes its
renderer detached only retires it; it does not recreate DOM. No polling
observer is installed. A body-only rebuild keeps a still-connected renderer.

If the document root is temporarily absent, feedback acknowledges the update
without creating application HTML. If an application has replaced the owned
host with its own element using the same ID, that element is never adopted,
cleared or removed. Feedback stays unavailable while the collision exists;
the next visible update can recover once it disappears. Scroll/resize alone
does not create a host. Native input and its existing best-effort feedback
semantics are unchanged; no input is replayed.

The recovered layer retains [top-layer isolation](top-layer-feedback.md),
[root zoom compensation](zoom-feedback.md) and print exclusion. Recovery
does not move the OS pointer, activate a tab, restore window focus or change
page-owned DOM to display the cursor.

## Verification and limits

The fixture uses one original trusted application action to rebuild root
children, replace the entire root, or rebuild body children as a control.
All three keep the same document/window. Original references and tokens
distinguish old and new business nodes and feedback owners. Public input
submits each original form once, retaining exact POST bytes and receipts.
PNG pixels separately verify the cursor and outline; click-ring geometry and
color are passive transient DOM evidence, not ring screenshot proof.

Old-source `bxYaz2` exits 1: all three submissions succeed (12,842 bytes), but
both root scenarios have zero cursor/outline pixels and update a detached
renderer. The body-only control retains correct feedback. The 3039ms focus
history contains no activation or window-focus events. Original failures,
source identity, screenshots, host exit and cleanup are preserved.

Fixed `RttFgP` passes 2/2, actual exit 0, with three original POSTs/13,147 bytes.
Independent PNG decoding and original bytes/geometry prove all three visual
results; root scenarios get a new owned renderer while body-only keeps its
original renderer. Initial hidden state and the later 567ms observation both
have zero open layers/rings and cursor opacity zero, without changing business
state. Its 4574ms interval has zero activation/focus events. Source/runtime
identity and exact-run process cleanup are confirmed.

Renderer tests pass 37/37. All Node groups pass 3270 tests with one existing
Windows file-symlink privilege skip, actual exits 0 and no source/runtime
drift. Related `ppBrxc` passes 11/11, including top layers, root zoom, ordinary
and strict-CSP PDF exclusion, raw-CDP coexistence, worker restart and Pause.
Full `uLJcAS` passes 157/157, actual exit 0, retaining the previous 156 case
names and order. Independent review confirms all three original PNGs, 13,039
POST bytes, stable hidden feedback after 574ms, unchanged source/runtime/build
identity and exact-run process cleanup. Its 460,718ms focus history contains
only the existing 12 activation/four control-focus permissions. Ordinary Edge
installation/consent, native UI, fullscreen and the overall parity matrix
remain separate acceptance work.

See the [execution plan](../exec-plans/completed/2026-10-14-dom-rebuild-feedback.md)
and the [integration guide](../../scripts/browser-integration/README.md).

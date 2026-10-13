# Native dialogs on explicitly allowed websites

- Status: complete (this slice; the parent parity goal remains active)
- Started: 2026-10-14
- Parent: [Browser Use parity](../active/2026-10-10-browser-use-parity.md), P14/P12.

## Problem and outcome

Restricted website access currently rejects armDialog, collectDialog and cancelDialog even on allowed pages. Permit the existing bounded native-dialog workflow when its original emitter and the live frame tree are authorized. Preserve original-dialog identity, actual native acknowledgements, Pause/drain, cancellation and deadlines.

## Contract and boundaries

- Remove only the three dialog methods from the restricted capability deny list. Do not broaden raw CDP, clipboard, downloads or network-data access.
- Validate ownership and the complete live website frame tree before subscription, after its actual ACK, on selected response and collection. Bind the current policy generation/revision and navigation version; synchronously recheck the resulting proof immediately before native dispatch and after awaited cleanup before returning content.
- A selected response also requires the original browser-issued opening URL to be an allowed HTTP(S) origin. Preserve its CDP frameId and invalidate the original dialog proof on that frame's navigation/removal. CDP frame IDs are not webNavigation numeric frame IDs. Unknown/opaque emitter origins fail closed in restricted mode.
- Keep all four existing dialog types. Real acceptance covers alert, confirm and prompt; the known beforeunload background-focus limitation remains open.
- A rejected or expired selected decision may only settle the same still-open original dialog using its existing stock default. Never borrow a successor dialog, replay input or release an uncertain native operation. No forbidden message/result may be returned.
- A fresh allowed dynamic frame may be checked at selection; a stale proof cannot authorize a changed tree, policy or document. Policy updates still Pause and retire old control epochs.

## Ownership and verification

- Root: background integration, permission admission, isolated browser launches, evidence, documentation, commit/push. Root alone launches test browsers; no daily profile or OS mouse.
- Module agent: browser-dialogs collection final fence and focused tests.
- Backend agent: dialog-backend restricted permission, emitter identity and actual-ACK race tests.
- Fixture agent: additive restricted five-entry/three-layout real cases and denial/revocation cases, borrowing the existing control popup. Preserve old defaults, case order, original native/POST oracle and focus allowances.
- First preserve the existing denial as a failing regression where practical; then targeted modules and frozen-source focused browser run. Shared admission changes justify full Node groups and full isolated integration. Audit actual exits, source/runtime identity, original native events, unique business POSTs, focus ledger and process cleanup.
- No PR. Push verified work to mikyan/open-browser-use on codex/browser-use-parity. Preserve existing preview ZIPs.

## Progress

- Previous slice 3e3d78e is verified progress: 150/150 browser integration, 3187 Node passes plus one existing Windows privilege skip. Full parity remains open.
- Read-only design found the special dialog send path bypasses ordinary website checks and collect lacks a final check after awaited cleanup. Chromium 156 original evidence includes frameId and emitter URL even for OOPIF events delivered through the root session; both must be retained.
- Ordinary Edge user consent remains deferred at the user's request; continue independent development.
- Implementation and independent review complete. Original production rejects the new allowed-site regression; a separate subscription-ACK race initially refreshed the policy revision and was fixed by retaining the original generation/revision. Module 20/20 and backend 32/32 pass, including real pending cleanup, cancellation and successor-dialog identity cases.
- All 11 Go artifacts rebuilt from 141 frozen inputs; only the dialog fixture helper input changed from the prior build manifest. Full Node groups pass 3222 tests with one existing Windows symlink privilege skip, actual exits 0 and no source/runtime drift.
- Preserve focused `MC3toy` actual exit 1 (4/10): new workflows did not run because the new fixture incorrectly required cleanupComplete=true after Resume. The production contract resets it to false when running. Correct only this oracle and its mock; keep paused cleanupComplete=true and durable policy checks strict, then rerun focused acceptance.
- Focused `N34ygI` actual exit 1 (4/10) proves root dialog decisions work but exposes allowed OOPIF admission failures. The public action error masks the original permission failure, so add an opt-in passive trace before changing admission. Also repair the test-only frame observer after a real worker restart; missing native history must not become an empty success witness.
- Node v2 retains one original-download HTTP test failure (`fetch failed`, no saved port or cause). Reuse the existing safe-port listener for that fixture; related 11/11 passes. This removes a known port risk without claiming it proves the original failure's cause. Preserve both original Node and browser failures.
- Passive diagnostic `LmLRV9` actual exit 1 proves the permission race: original inspection starts at navigation version 4, the allowed child commits to version 5, and Chrome returns a complete permitted root/child tree; the version mismatch alone then revokes the tab. All 2330 trace records are retained with no overflow, observer errors or pending calls, and original methods restored. The new check rereads only valid changing snapshots inside the original 1000ms monotonic deadline, capped at eight reads; actual input is never replayed. Original policy identity, immediate deny/revocation and single-snapshot revoked recovery remain mandatory.
- Preserve focused `wqb9w1` actual exit 1 (3/10): a new passive frame observer was installed before Chrome bindings became ready after a real worker restart. Move that installation after the already-required native adapter readiness; add no new input, retry or focus exception.
- Final focused `cin0qm` passes 10/10, actual exit 0. Independent raw evidence audit covers 15 layouts, 90 explicit decisions, 120 actual native responses and 105 original POSTs/26,592 bytes. Policy v1 readback, Pause/Resume, original URL/frame/document, denied boundaries and cleanup are retained; this is not an independent count of every storage.set call. The 37,425ms ledger has no activation and only the original two popup-focus events. Source/runtime/build hashes match; the original host exits 0 and exact-run process count is zero.
- Final Node groups pass 3251 tests with one existing Windows symlink privilege skip and all actual exits 0. After the final observer installation ordering change, the affected fixture group passes 38/38.
- Complete `BNmZJb` passes 156/156, actual exit 0. Independent audit preserves all previous 150 case names/order, the same 105 POSTs/26,592 bytes and 120 native responses, original policy and denied boundaries. Its 466,299ms observer interval contains only the existing 12 exact activations and four control-popup focus events. All source/runtime/build identities match. The old host's intentional restart signal and successor's EOF/exit 0 are confirmed; exact-run processes are zero. Ordinary Edge authorization and beforeunload's native focus limitation remain open.
- Documentation, repository hygiene, action-pinning and diff checks pass. Existing preview ZIP hashes are unchanged. This slice is complete; no PR is created and the parent parity goal remains active.

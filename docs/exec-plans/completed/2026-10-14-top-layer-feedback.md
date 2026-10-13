# Visible agent feedback over business dialogs

Status: complete for HTML dialog/popover feedback; overall parity remains open.

The user requires visible AI cursor, click positions and target outlines while
browser tasks run without taking the OS pointer or switching the active page.
An ordinary fixed overlay can be covered by HTML modal dialogs and popovers,
regardless of its z-index. Verify this with actual public input, original form
POSTs and screenshots of the opaque topmost business panel.

Acceptance covers an existing cursor followed by an outer modal, nested modal,
and simultaneously open manual/auto business popovers. Each original form must
submit once, retain its top-layer state, and keep expected input focus. Pixel
checks distinguish the cursor at the button center from the outline at its
edges; DOM visibility alone cannot prove composited visibility.

Proposed renderer: keep an owned non-interactive host and use a manual popover
inside its shadow tree. Isolate native toggle events from page delegates;
normalize its UA styles/backdrop without closing business popovers, restoring
focus or changing business nodes. Raise only for actual feedback, retain print
exclusion and turn/page cleanup. Confirm the design before implementation.

Preserve real red evidence, then run focused and related feedback/PDF/lifecycle
regression with frozen source/runtime hashes and the unchanged focus gate.
Only the root agent launches isolated test browsers. Old preview archives stay
unchanged; commit/push the existing fork branch without a PR. Fullscreen,
native browser dialogs and complete P01–P15 parity require separate evidence.

Baseline `FYfrul` (actual exit 1) preserves all three original form POSTs and
their trusted input/click/submit events. All business checks pass, while each
original screenshot has zero cursor-center dark pixels and zero blue outline
pixels within the opaque panel. Root inspected the nested-dialog screenshot.
The isolated observer records no activation/focus event or added allowance.
Earlier `U29MYN` is a retained fixture failure: an incorrect HTTP base caused
its exact document-URL receipt check to reject. Fix the base, retain failure
ledgers before cleanup, and do not count that run as product red evidence.

Implemented the owned manual popover inside Shadow DOM; native toggle events
remain isolated, and hit testing excludes both the outer host and inner layer.
No autofocus, focus restoration, business-node moves or per-frame reordering.
Native hide exceptions hide pixels but do not establish membership removal.

Focused `kVaOVU` 2/2 and related `gTjanh` 9/9 have actual exit 0, no source or
runtime drift, and zero activation/focus/allowances over 3,428/14,003 ms.
Three original submissions and screenshots pass; normal turn end closes both
original layers without changing focus/selection or business event ledgers.
Independent review caught and corrected SDK cleanup reopening a turn and an
end-state-only oracle; cleanup now removes exact tabs through the harness, and
the end check compares full existing business ledgers without SDK reattachment.
Ordinary/CSP PDFs were independently rendered again: eight pages preserve the
business report with zero feedback image/color leakage.

Module red 13 pass/5 fail became 31/31 combined cursor/pointer tests; fixture
tests 9/9. Full Node CI groups pass 3,092 tests with one existing Windows
file-symlink privilege skip. Documentation/hygiene/action-pinning checks pass.
Complete browser regression is warranted by the shared renderer/Shadow DOM
change. Complete `7uoTMN` passes 147/147 with actual child exit 0/signal null and
unchanged source/runtime hashes. It preserves the previous 144 names/order;
the 424,958 ms observer interval has only the original 12 activation and four
control-window focus allowances. No input transport or focus gate was changed.

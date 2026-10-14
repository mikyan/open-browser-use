# Coordinate target feedback inside frames

Coordinate mouse input can now show the element beneath its point inside an
already initialized Playwright Page. The public JS mouse API and direct root
CDP mouse input share this optional read. The original locator-selected target
continues to use its own [element feedback](frame-target-feedback.md).

This is a read-time hit-test snapshot. It does not prove which element received
an earlier input or continuously track subsequent layout changes. A cold raw
CDP attachment, before any Page exists, still has the root-document fallback.
The [active plan](../exec-plans/active/2026-10-15-raw-frame-feedback.md) remains
open for that route and for complete Browser Use parity.

## Read and ownership

The private runtime adapter starts a fractional `elementFromPoint` in the
original frame's existing utility context. It descends open shadow roots and
then verified iframe owners. It projects all four native border corners through
the actual renderer boundaries, rather than translating a frame-local AABB.
Same-origin, OOPIF, nested, dynamic, scaled and rotated frames use the same
geometry primitives as the locator adapter. Unknown frames, contexts, owners
or planes produce no rectangle, rather than claiming an ancestor as the leaf.

No Page, isolated world or engine attachment is created by this optional warm
read. The ready-Page cache is bound to the original promise and generation.
Every asynchronous step checks its original Page, attachment, frame, document,
parent, context and native route. A private candidate travels with a mouse
click's existing move/down/up sequence; public CDP parameters cannot supply
this authority. Pinned zero-delay click retains its original overlapping native
invocations and ACKs. No input is replayed or delayed to obtain geometry.

The existing registry bounds pending work to sixteen globally and two per
attachment. Each allocated remote object, including an exceptional or late
result, is owned before post-read validation. Cleanup uses only its original
native lease. Successful release ACKs are not repeated; failed release retains
the object and blocks admission until explicit cleanup succeeds. A native
context-destruction event is evidence that its objects are gone; replacing a
local Page or attachment is not.

## Caller completion and cleanup

Optional feedback must not extend an input's error or deadline. Action failure
starts the original attachment's full detach barrier, while the caller waits
only for its existing required cleanup, including held keys/buttons and other
required resources. The same captured lease signals that required completion;
full detach additionally waits for actual raw allocations and object releases.
Normal commands and successor attachment cannot pass the outstanding barrier.
End, Pause and explicit detach continue to wait for full cleanup.
The existing required-resource cleanup may itself remain pending; this change
removes only the new optional visual work from caller completion.

This separation does not cancel the original native read or claim that its
resource has been released. It preserves the original input error, avoids
turning a quick native rejection into a later timeout, and retains the original
attachment until cleanup is confirmed. Pure locator BoxModel reads acquire no
new handles and retain their prior cleanup contract.

## Retained evidence

Old-source run `R1aiOp` completed twelve unique original submissions and native
input checks across the two coordinate modes, while all twelve outlines framed
an ancestor iframe. The corrected native oracle allows the pinned JS mouse
click's overlapping ACKs, while still requiring ordered original invocations
and one actual successful ACK per invocation. Its earlier stricter failure
`VZh8hm` is retained.

Initial warm candidate `QOGMzJ` passes all twelve layouts and the mandatory raw
navigation case, with actual process exit 0 and unchanged source/runtime
identities. Independent CSS-plane and PNG analysis verifies every leaf border
and excludes extra ancestor borders. Twelve original trusted POSTs total 28,374
bytes. All 65 raw hit-test objects have unique original-route release ACKs.
The original 26 document observations remain hidden after 572/578 ms at End;
exact test tabs and child targets are removed. The 14,795 ms observer interval
has no activation, focus changes or allowances. Click-ring evidence is passive
DOM geometry, not a claim that transient rings appear in the PNGs.

That normal run does not prove failure-path timing. An independent deterministic
counterexample held either allocation or release: a 30 ms mouse request was
still pending at 100 ms, and its original immediate native error became a
timeout. This prompted the two-phase cleanup above; focused failure/timeout
regressions and final verification are recorded with the active plan.

Cold run `uGRF8J` preserves three successful original submissions (8,625 bytes),
three original native PNGs and seven unchanged documents, but all three target
outlines are still wrong. Its observer confirms the engine remains absent and
the original raw attachment is not migrated. Actual exit is 1; the 5,528 ms
focus interval contains no events or allowances. End remains hidden after
571 ms and exact tabs/targets are gone. This failure is not waived by the warm
result. Run it explicitly with `OBU_TEST_RAW_COLD_FEEDBACK=1` and
`OBU_TEST_CASES=^js-cold-cdp-frame-target-feedback$` in the integration runner.

## Remaining scope

Cold raw routing, fullscreen feedback, ordinary Edge installation and broader
cross-worker delivery remain open. Warm browser evidence uses the public JS
SDK and direct CDP entry; it does not establish independent five-entry visual
coverage, arbitrary CSS geometry, or parity of the entire product. Existing
preview archives are unchanged.

## Final warm increment verification

Final frozen run `xS4ddv` passes the default 180/180 browser cases with actual
exit 0, no source/runtime drift, and the preceding 178 case names/order retained.
The cold opt-in failure above is deliberately a separate unresolved case, not
part of this passing default count.

Independent original-record checks cover eighteen locator/mouse/CDP layouts,
eighteen native PNGs, eighteen unique trusted POSTs totaling 42,559 bytes and
39 original document observations. The two coordinate modes allocate 65 observed
hit-test objects, each released with one exact original-route ACK. End remains
hidden after 569/568/567 ms with unchanged business state and geometry; exact
test tabs and observed child targets are gone. The 533,948 ms focus interval
retains only the existing twelve activation and four control-popup focus
allowances. This is not a claim that the whole suite has zero focus events.

All three deterministic Node groups close with exit 0: 3666 pass and one
existing Windows file-symlink privilege skip. Targeted cases cover held optional
allocation/release, original error identity, the original running timeout,
required key release, rejected successor admission, pre-transport cleanup
failure and explicit recovery. Real-browser normal flows do not substitute for
those controlled timing counterexamples.

Independent input review verifies 33 original keyboard/pointer/drag scenarios:
179 native Input calls and 33 guard Runtime calls each settle once, and their
input parameters/order match the preceding full baseline. Twenty-six original
POSTs total 180,098 bytes. Seven original keyboard failures retain their actual
worker error replies. Five screenshot scenarios each retain one original native
capture and their 1000 ms request budget; seven PNGs total 196,735 bytes and
112 encoded image regions match. The counted-navigation scene retires its
receiver before final hide in this run; it does not re-prove the separate
delayed-hide race. No new input replay or focus allowance was introduced.

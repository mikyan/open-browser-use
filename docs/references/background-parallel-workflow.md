# Background idle and concurrent rendering

This acceptance task exercises independently owned background tabs while other
tasks continue working. Short sequential screenshots do not establish that an
idle renderer wakes correctly or that ending one task leaves the others usable.

The controlled fixture uses three SDK sessions with multiple owned tabs. Each
page has an independent nonce, editable data, an action that submits actual data
to the local server, and colored state markers in the root and frame documents.
The verifier checks decoded screenshot pixels and original submissions against
the expected page identity and state. It must not accept a nonempty PNG or a
changed image hash as proof of correct rendering.

Element captures also retain the original `Page.captureScreenshot.clip`, the
post-capture element box and main-frame scroll offset. The checker reconstructs
the enclosing integer CSS rectangle used by the bundled screenshot engine,
then applies DPR to check the exact PNG dimensions and marker positions.
Fractional coordinates do not justify an arbitrary dimension tolerance.

One session's tabs receive no browser commands for at least 310 seconds after
their baseline work finishes. Other sessions keep performing concurrent input
and rendering work. The first resumed request to each idle page is a screenshot;
only then may the caller inspect state, act, and capture the resulting update.
One task finalizes while another continues; their tab ownership, results and
cleanup must remain independent.

## Evidence boundary

The normal browser-integration runner provides the isolated profile, public
SDK/native-host path, and continuous independent focus ledger. A declared
test-only passive probe records original rendering command starts/settlements,
frame and acknowledgment metadata, detach and tab removal. It cannot alter
arguments, native results or event delivery. Actual intervals on different owned
tabs must overlap; launching promises together alone does not prove concurrent
rendering. Command records and original server requests are retained separately
from caller assertions, including on failures. Final native target/tab state
checks complement successful stop acknowledgments; no private queue is cleared
or rewritten to manufacture cleanup.

The case adds no focus allowance, does not activate a tab to recover it, and does
not change the browser's timer throttling flags. Chrome's
[background timer policy](https://developer.chrome.com/blog/timer-throttling-in-chrome-88/)
describes a five-minute threshold subject to other conditions. That motivates
the idle duration; elapsed time does not prove this browser entered that policy.
Document visibility and test clock intervals are evidence, not substitutes for
observing an internal scheduler state. A passing bounded run does not establish
unlimited load, arbitrary idle duration, other browsers, or OS-level pointer
behavior.

The first real fixture metrics reported `document.visibilityState === "visible"`
even though all task tabs were natively inactive. The existing browser route
uses focus emulation. This task keeps that production behavior and records the
reported state; command silence on an inactive tab must not be described as
proof of a hidden document or activation of intensive timer throttling.

This long case is opt-in so that the default regression suite remains useful.
Set `OBU_TEST_BACKGROUND_PARALLEL=1` and select
`OBU_TEST_CASES=background-parallel` with the normal headed runner prerequisites.
Shortened or mocked waits cannot be reported as the long-idle acceptance.

## Status

The first headed attempt, `run-8DMNGR`, passed the mandatory navigation case and
failed the new case in its first working round. At DPR 1.5, the four cross-origin
element PNGs were 92 pixels high, while the initial checker demanded 90. Their
original bytes and failed assertions are retained. This short failure is not a
long-idle result. The corrected checker uses the original native clip and a
post-scroll document rectangle; the failed run is not retroactively reclassified.

The corrected checker has seven passing unit tests, including fractional origins
and DPR 1.25, 1.5 and 1.75. The complete CI passes 927 Node tests (771 extension,
53 scripts, 103 browser-harness tests), 115 JavaScript SDK tests, 82 Python tests,
all Go packages and the repository checks. Initial CI setup failures from missing
`zip` on PATH and Windows' default package-script shell are retained separately;
the final run uses the existing zip tool and Git Bash. Runtime code and the
accepted extension ZIP remain unchanged.

The corrected headed `run-ttHLU9` completed **2/2**, including the mandatory raw
navigation prerequisite. Its measured command-free interval was **310,087.725 ms**
on each of two idle tabs. The first resumed SDK requests were screenshots; later
input changed their state from sequence 0 to 1 and the resulting PNGs matched.
Thirty-one sustained rounds plus the final resumed work produced **172** actual
POSTs and **182** PNGs. Eight created tabs were actually removed, including the
two retired at the midpoint. Native evidence records **490** closed rendering
intervals and **563** cross-owner interval overlaps. This counts observed stream
intervals, not internal GPU scheduling or a throughput benchmark.

Independent raw-evidence auditing checked all **2,912** marker samples and the
original POST bytes, native capture clips, frame/ACK ordering and stream
boundaries. The screenshots comprise 138 root, 20 same-origin and 24 cross-origin
captures, totaling 9,783,561 bytes; native iframe attachments are recorded for
every created root tab. The continuous focus ledger recorded **zero** activations,
**zero** focus changes and no added exemptions. All four original tabs retained
their metadata. The passive probe was restored and no native commands remained
pending. Initial visibility was `visible` on eight pages, and remained `visible`
on both idle pages after resuming. Source/runtime/binary identities and historical
evidence match the pre-run freeze.

The separate default regression `run-NDr4vF` passed **104/104**, with the exact
same case names as the preceding `run-WWWaGP`; it did not enable this long case.
Independent auditing rechecked its fifteen research tasks and the continuous
focus ledger. Its six activations and four focus events have the existing exact
fixture/control-panel allowances; there are no new allowances. The default
suite's success is reported separately from the long-idle result.

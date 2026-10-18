# Read-only Windows acceptance observer

This helper is for the browser acceptance runner, not the installed product. It
does not start a browser, open profiles, send input, change foreground windows,
read titles/text, or install keyboard/mouse-button hooks.

Build on Windows from the repository root:

```powershell
go build -o .tmp/windows-observation-probe.exe ./scripts/browser-integration/windows-observation-probe
go test ./scripts/browser-integration/windows-observation-probe
node --test scripts/browser-integration/windows-observation.test.mjs
```

The runner imports `startWindowsObservation` from `windows-observation.mjs`:

```js
const observer = await startWindowsObservation({
  executable: absoluteHelperPath,
  sampleMs: 50,
  onRecord: record => evidenceStream.write(JSON.stringify(record) + "\n"),
});
try {
  // Start the intended acceptance only after the real ready receipt.
  await workflow();
} finally {
  await observer.stop();
}
```

`ready` is emitted after the original thread installs an out-of-context
`EVENT_SYSTEM_FOREGROUND` hook, installs its timer, consumes its ready message
in the Windows message loop and successfully samples the foreground HWND/PID
and cursor coordinates. Earlier hook callbacks are counted as `preReadyEvents`,
outside the accepted observation interval. All callback and cleanup work uses
the same locked native thread. Input is only the helper's own stdin command;
`{"operation":"stop"}` or EOF stops it. Other input fails and still cleans up.

The helper emits ordered JSONL `ready`, `foreground`, `sample`, `error` and
`stopped` records. HWNDs are decimal strings, so 64-bit values do not lose
precision in JavaScript. A nonzero HWND with an unresolvable owner has `pid:null`,
not a guessed process. The raw event DWORD timestamp can wrap; `elapsedUs` is the
monotonic callback/sample receipt timestamp. UTC is informational and can jump.

`stopped` follows `KillTimer` and `UnhookWinEvent` results. `stop()` additionally
waits for the original child process's actual close, and is idempotent. A native
failure, malformed/truncated stream, missing stop receipt, failed evidence sink,
nonzero exit or forced termination never counts as successful coverage. The
wrapper immediately begins retirement on a post-ready failure. If graceful Stop
times out it terminates only the original `ChildProcess` and joins its close;
if exit still cannot be confirmed it reports `EXIT_UNCONFIRMED`. It never scans
for or terminates other processes. Thrown errors carry `error.observation` with
the original records, fixed failure codes and cleanup/close evidence. Unknown
output is retained only as bounded byte counts and hashes, not text.

The foreground hook supplies continuously delivered native foreground events
while installed; it does not attribute their cause to the agent or the user.
Records do not cover before readiness or after the hook is removed. Native event
delivery can lag generation, and events pending at hook removal are outside a
claim of complete event-generation timing. Stop should occur after the browser
workflow and its cleanup have settled. Cursor coordinates and additional
foreground snapshots are timer samples, not a continuous mouse trace or an
atomic joint snapshot. Sampling can be delayed/coalesced by Windows. Equal cursor
samples do not prove the cursor never moved between them. A PID match is only a
candidate owner; the runner needs its separate process creation/exit evidence
to distinguish PID reuse. No foreground HWND does not prove a locked desktop.

The unit tests inject only this helper's native platform and child-process seams;
they test failure cleanup and protocol order without native UI mutations. Real
smoke evidence must be recorded separately, and must not claim to exercise a
foreground event if no such event actually occurred.

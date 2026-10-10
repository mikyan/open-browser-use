import assert from "node:assert/strict";
import fs from "node:fs/promises";
import test from "node:test";
import vm from "node:vm";

// Execute the real worker-side function without importing the browser-launching
// module. Both unique anchors are intentional guards against source drift.
const source = await fs.readFile(new URL("./rendering-probe.mjs", import.meta.url), "utf8");
const startMarker = "async function nativeCheck(tabId) {";
const endMarker = "\nlet browser, worker, browserConnection;";
assert.equal(source.split(startMarker).length, 2, "nativeCheck source anchor must be unique");
assert.equal(source.split(endMarker).length, 2, "nativeCheck end anchor must be unique");
const start = source.indexOf(startMarker), end = source.indexOf(endMarker, start);
assert.ok(end > start, "nativeCheck extraction boundaries changed");
const nativeSource = source.slice(start, end).trim();
assert.ok(nativeSource.endsWith("\n}"), "nativeCheck must be the sole declaration between its anchors");
const script = new vm.Script(`(${nativeSource})`, { filename: "rendering-probe.mjs#nativeCheck" });

function createHarness({ frameAt, startAckMs = 2900 }) {
  let now = 0, nextTimer = 0, listener, done = false, result, error;
  const timers = new Map(), inputs = [], actualNativePending = new Set();
  const schedule = (fn, milliseconds) => {
    const id = ++nextTimer;
    timers.set(id, { at: now + milliseconds, fn });
    return id;
  };
  const state = () => ({
    viewport: [100, 100], visual: [100, 100], dpr: 1, scroll: [0, 0], sizes: [],
    clicks: inputs.length ? [{ trusted: true }] : []
  });
  const chrome = { debugger: {
    attach: async () => {}, detach: async () => {},
    onEvent: {
      addListener: fn => { listener = fn; },
      removeListener: fn => { assert.equal(listener, fn); listener = undefined; }
    },
    sendCommand: async (_target, method, params) => {
      if (method === "Page.startScreencast") {
        schedule(() => listener?.({ tabId: 1 }, "Page.screencastFrame", { sessionId: 1, metadata: {} }), frameAt);
        actualNativePending.add(method);
        return new Promise(resolve => schedule(() => {
          actualNativePending.delete(method); resolve();
        }, startAckMs));
      }
      if (method === "Runtime.evaluate") return { result: { value:
        params.expression.includes("getBoundingClientRect") ? { x: 1, y: 1 }
          : params.expression.startsWith("Promise.race") ? { at: now } : state()
      } };
      if (method === "Input.dispatchMouseEvent") inputs.push(params);
      if (method === "Page.captureScreenshot") return { data: "synthetic-result-unused-by-this-budget-test" };
      return {};
    }
  } };
  const records = [];
  const nativeCheck = script.runInNewContext({
    chrome, probeNativeRecords: records, performance: { now: () => now },
    setTimeout: schedule, clearTimeout: id => timers.delete(id)
  });
  nativeCheck(1).then(value => { result = value; done = true; }, value => { error = value; done = true; });
  // Flush promise continuations before advancing the deterministic timer queue;
  // there is no wall-clock sleep, native browser, or real asynchronous CDP here.
  const flush = async () => { for (let index = 0; index < 150; index++) await Promise.resolve(); };
  const advanceOne = async () => {
    const timer = [...timers].sort((a, b) => a[1].at - b[1].at || a[0] - b[0])[0];
    assert.ok(timer, "No scheduled work while the diagnostic is pending");
    timers.delete(timer[0]); now = timer[1].at; timer[1].fn(); await flush();
  };
  return {
    inputs, actualNativePending, records,
    get now() { return now; },
    async finishObservation() {
      await flush();
      for (let round = 0; round < 100 && !done; round++) await advanceOne();
      assert.equal(error, undefined); assert.ok(done, "Diagnostic failed to complete within the virtual timer bound");
      return result;
    },
    advanceOne
  };
}

for (const frameAt of [9900, 10000, 11000]) {
  test(`first-frame start plus ACK deadline: start responds at 2.9s, frame at ${frameAt / 1000}s`, async () => {
    const harness = createHarness({ frameAt });
    const result = await harness.finishObservation();
    assert.equal(result.startScreencastMs, 2900);
    assert.equal(result.firstFrameDeadlineMs, 10000);
    assert.equal(result.pendingNative.length, 0);
    assert.equal(harness.actualNativePending.size, 0);
    assert.ok(result.nativeCommands.every(command => command.status === "fulfilled"));
    if (frameAt < 10000) {
      assert.equal(result.firstFrame.settled, true);
      assert.equal(result.firstFrame.value, true);
      assert.equal(result.firstFrameWaitMs, frameAt);
      assert.deepEqual(Array.from(harness.inputs, input => input.type), ["mouseMoved", "mousePressed", "mouseReleased"]);
      assert.equal(result.frames[0].acknowledgedWithinDeadline, true);
    } else {
      assert.equal(harness.inputs.length, 0, "A late ACK must not deliver browser input");
      assert.notEqual(result.firstFrame.value, true);
      assert.equal(result.firstFrameWaitMs, 10000, "The 10s budget must not restart after the 2.9s start response");
      if (frameAt === 10000) assert.equal(result.frames[0].acknowledgedWithinDeadline, false);
      else {
        assert.equal(result.firstFrame.observationTimedOut, true);
        assert.equal(result.firstFrame.timeoutMs, 7100);
      }
    }
  });
}

test("start observation timeout preserves the real pending command until its native promise settles", async () => {
  const harness = createHarness({ startAckMs: 5000, frameAt: 11000 });
  const result = await harness.finishObservation();
  assert.equal(harness.now, 4000, "3s start observation plus 1s pending cleanup drain");
  assert.match(result.error, /observationTimedOut/);
  assert.equal(harness.inputs.length, 0);
  const startCommand = result.nativeCommands.find(command => command.method === "Page.startScreencast");
  assert.equal(startCommand.status, "pending");
  assert.equal(startCommand.endedMs, undefined);
  assert.deepEqual(Array.from(result.pendingNative), [startCommand.id]);
  assert.equal(harness.actualNativePending.has("Page.startScreencast"), true);
  assert.equal(result.cleanup.pendingDrain.settled, false);
  assert.equal(result.cleanup.pendingDrain.observationTimedOut, true);
  assert.equal(result.cleanup.stop.settled, true);
  assert.equal(result.cleanup.detach.settled, true);
  // A successful stop/detach or the outer observation race did not manufacture
  // settlement. Only completion of the separately tracked native promise does.
  await harness.advanceOne();
  assert.equal(harness.now, 5000);
  assert.equal(harness.actualNativePending.size, 0);
  assert.equal(startCommand.status, "fulfilled");
  assert.equal(startCommand.endedMs, 5000);
  assert.equal(harness.records[0].nativeCommands.find(command => command.id === startCommand.id).status, "fulfilled");
  assert.deepEqual(Array.from(result.pendingNative), [startCommand.id], "The earlier pending snapshot stays historical; the journal records late settlement");
  assert.equal(harness.inputs.length, 0, "Late native settlement must not resume the finished diagnostic");
});

function declarationBetween(first, next) {
  assert.equal(source.split(first).length, 2, `${first} must remain a unique source anchor`);
  assert.equal(source.split(next).length, 2, `${next} must remain a unique source anchor`);
  const begin = source.indexOf(first), finish = source.indexOf(next, begin);
  assert.ok(finish > begin);
  return source.slice(begin, finish).trim();
}
const traceDefinitions = declarationBetween('const TRACE_REVISION = ', '// Only read-only Win32 calls.');
const adoptionSource = declarationBetween('async function adoptStartupTrace() {', 'async function traceMarker(label) {');
const finishSource = declarationBetween('async function finishStartupTrace() {', 'function assertLedgerPrefix(before, after) {');
// Exact field names from rendering-0XvFUK's real Tracing.tracingComplete event.
// The request option is streamFormat; the native completion is traceFormat.
const nativeTraceComplete = { dataLossOccurred: false, stream: '1', traceFormat: 'proto', streamCompression: 'none' };

test("startup trace config keeps the original window policy and typed scheduler categories", () => {
  const configured = new vm.Script(`${traceDefinitions}\nstartupTraceConfiguration('isolated-run/config.json')`).runInNewContext();
  assert.deepEqual(Array.from(configured.args), ['--trace-config-file=isolated-run/config.json', '--trace-startup-owner=devtools']);
  assert.equal(configured.config.startup_duration, 0);
  assert.equal(configured.config.trace_config.record_mode, 'record-until-full');
  assert.equal(configured.config.trace_config.trace_buffer_size_in_kb, 65536);
  for (const category of ['views', 'cc', 'viz', 'disabled-by-default-cc.debug.scheduler', 'disabled-by-default-viz.surface_lifetime']) {
    assert.ok(configured.config.trace_config.included_categories.includes(category));
  }
});

test("the surface sync comparison adds only its explicit diagnostic feature override", () => {
  const configured = new vm.Script(`${traceDefinitions}\n[startupTraceConfiguration('isolated-run/config.json'), startupTraceConfiguration('isolated-run/config.json', { disableSurfaceSync: true })]`).runInNewContext();
  assert.deepEqual(Array.from(configured[1].args), [...configured[0].args, '--disable-features=InitialWebUISurfaceSync']);
  assert.deepEqual(configured[0].config, configured[1].config, 'Trace categories and budgets must remain identical');
});

test("the field trial comparison retains browser rendering flags and trace configuration", () => {
  const configured = new vm.Script(`${traceDefinitions}\n[startupTraceConfiguration('isolated-run/config.json'), startupTraceConfiguration('isolated-run/config.json', { disableFieldTrials: true })]`).runInNewContext();
  assert.deepEqual(Array.from(configured[1].args), [...configured[0].args, '--disable-field-trial-config']);
  assert.deepEqual(configured[0].config, configured[1].config);
});

test("only the pinned native adoption error is accepted; a successful late start is rejected without retry", async () => {
  for (const response of ['adopted', 'success', 'unrelated-error', 'wrong-revision']) {
    const calls = [], report = { browserVersion: { revision: response === 'wrong-revision' ? '@other' : '@f842f52ef39fd97b449eb27cff414bf05a98ddce' }, trace: {} };
    const context = vm.createContext({ assert, report, traceRequested: false, traceComplete: undefined,
      browserConnection: { onEvent() {}, async call(method, params) {
        calls.push({ method, params });
        if (response === 'adopted') throw new Error(JSON.stringify({ code: -32000, message: 'Tracing has already been started (possibly in another tab).' }));
        if (response === 'unrelated-error') throw new Error(JSON.stringify({ code: -32001, message: 'Tracing has already been started (possibly in another tab).' }));
        return {};
      } } });
    const adopt = new vm.Script(`${traceDefinitions}\n(${adoptionSource})`).runInContext(context);
    if (response === 'adopted') {
      await adopt(); assert.equal(report.trace.adoption.expectedPinnedResponse, true);
    } else await assert.rejects(adopt());
    assert.equal(calls.length, response === 'wrong-revision' ? 0 : 1, 'No fallback/second Tracing.start is allowed');
    if (calls.length) assert.equal(calls[0].params.streamFormat, 'proto');
  }
});

test("raw startup trace is retained without JSON conversion and the exact owned stream is closed", async () => {
  const calls = [], writes = [], bytes = Buffer.from([10, 2, 8, 1]), report = { trace: {} };
  const context = vm.createContext({ assert, Buffer, performance, report, traceRequested: true,
    traceComplete: Promise.resolve(nativeTraceComplete),
    observe: async promise => ({ settled: true, value: await promise }),
    browserConnection: { async call(method, params) {
      calls.push({ method, params });
      if (method === 'IO.read') return { data: bytes.toString('base64'), base64Encoded: true, eof: true };
      return {};
    } }, fs: { async writeFile(file, value) { writes.push({ file, value }); } },
    path: { join: (...parts) => parts.join('/') }, runDir: 'isolated-run', sha256: () => 'test-hash' });
  await new vm.Script(`(${finishSource})`).runInContext(context)();
  assert.deepEqual(calls.map(call => call.method), ['Tracing.end', 'IO.read', 'IO.close']);
  assert.equal(calls.at(-1).params.handle, '1');
  assert.equal(writes[0].file, 'isolated-run/startup-trace.pftrace');
  assert.deepEqual(writes[0].value, bytes);
  assert.equal(report.trace.artifact.decoded, false);
  assert.equal(report.trace.artifact.reportedTraceFormat, 'proto');
  assert.equal(report.trace.artifact.completeRead, true);
  assert.equal(report.trace.artifact.coverageVerified, false, 'Successful adoption does not manufacture proof of first-window coverage');
});

test("trace read failure closes its exact stream and retains partial bytes without claiming completion", async () => {
  const calls = [], writes = [], report = { trace: {} }; let readCount = 0;
  const context = vm.createContext({ assert, Buffer, performance, report, traceRequested: true,
    traceComplete: Promise.resolve(nativeTraceComplete),
    observe: async promise => ({ settled: true, value: await promise }),
    browserConnection: { async call(method, params) {
      calls.push({ method, params });
      if (method === 'IO.read') {
        if (readCount++) throw new Error('native stream read failed');
        return { data: Buffer.from([10, 2]).toString('base64'), base64Encoded: true, eof: false };
      }
      return {};
    } }, fs: { async writeFile(file, value) { writes.push({ file, value }); } },
    path: { join: (...parts) => parts.join('/') }, runDir: 'isolated-run', sha256: () => 'test-hash' });
  await assert.rejects(new vm.Script(`(${finishSource})`).runInContext(context)(), /native stream read failed/);
  assert.deepEqual(calls.map(call => call.method), ['Tracing.end', 'IO.read', 'IO.read', 'IO.close']);
  assert.equal(calls.at(-1).params.handle, '1');
  assert.equal(report.trace.artifact.completeRead, false);
  assert.deepEqual(writes[0].value, Buffer.from([10, 2]));
});

for (const format of ['json', 'unknown']) {
  test(`unexpected ${format} completion retains the native bytes before reporting an instrumentation failure`, async () => {
    const bytes = format === 'json' ? Buffer.from('{"traceEvents":[]}') : Buffer.from([1, 2, 3]);
    const writes = [], report = { trace: {} };
    const context = vm.createContext({ assert, Buffer, performance, report, traceRequested: true,
      traceComplete: Promise.resolve({ stream: 'original-stream', dataLossOccurred: false, ...(format === 'json' ? { traceFormat: 'json' } : {}) }),
      observe: async promise => ({ settled: true, value: await promise }),
      browserConnection: { async call(method) {
        if (method === 'IO.read') return { data: bytes.toString(format === 'json' ? 'utf8' : 'base64'), base64Encoded: format !== 'json', eof: true };
        return {};
      } }, fs: { async writeFile(file, value) { writes.push({ file, value }); } },
      path: { join: (...parts) => parts.join('/') }, runDir: 'isolated-run', sha256: () => 'test-hash' });
    await assert.rejects(new vm.Script(`(${finishSource})`).runInContext(context)());
    assert.deepEqual(writes[0].value, bytes);
    assert.equal(report.trace.artifact.completeRead, true);
    assert.equal(report.trace.artifact.coverageVerified, false);
    assert.equal(report.trace.artifact.filename, `startup-trace.${format === 'json' ? 'json' : 'bin'}`);
    assert.equal(report.trace.streamClose.settled, true);
  });
}

test("final marker and HWND failures cannot skip trace termination and retention", async () => {
  const block = declarationBetween('  if (traceRequested) {\n    try { await traceMarker("probe-before-cleanup"); }', '\n  if (worker) {');
  const calls = [], failures = [], report = { trace: {} };
  const cleanup = new vm.Script(`(async () => {${block}})`).runInNewContext({ report, traceRequested: true,
    traceMarker: async () => { calls.push('marker'); throw new Error('marker failed'); },
    windowSnapshot: async () => { calls.push('window'); throw new Error('window snapshot failed'); },
    finishStartupTrace: async () => { calls.push('finish'); },
    failure: (...args) => failures.push(args) });
  await cleanup();
  assert.deepEqual(calls, ['marker', 'window', 'finish']);
  assert.equal(failures.length, 2);
});

test("the HWND helper exposes only the fixed read-only Win32 imports", () => {
  const helper = declarationBetween('const NATIVE_WINDOW_SCRIPT = String.raw`', '\nconst sourceFile = ');
  const imports = [...helper.matchAll(/\[DllImport\("[^\"]+"\)\] public static extern [^;]+? (\w+)\(/g)].map(match => match[1]);
  assert.deepEqual(imports, ['EnumWindows', 'GetWindowThreadProcessId', 'IsIconic', 'IsWindowVisible', 'GetWindowRect', 'GetForegroundWindow', 'DwmGetWindowAttribute']);
  assert.match(helper, /if \(processId == desired\)/);
  assert.doesNotMatch(helper, /SetForegroundWindow|ShowWindow|SetWindowPos|GetWindowText/);
});

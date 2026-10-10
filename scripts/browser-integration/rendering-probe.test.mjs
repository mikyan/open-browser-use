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

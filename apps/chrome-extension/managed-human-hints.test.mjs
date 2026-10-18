import assert from "node:assert/strict";
import test from "node:test";
import { ManagedHumanControl } from "./managed-human-control.js";

const defer = () => {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
};
const tick = () => new Promise(resolve => setTimeout(resolve, 0));
function manualTiming() {
  let time = 0, sequence = 0;
  const timers = new Map();
  return { now: () => time, skip: ms => { time += ms; }, timers,
    setTimer: (fn, ms) => { const id = ++sequence; timers.set(id, { fn, at: time + ms }); return id; },
    clearTimer: id => timers.delete(id),
    advance: ms => {
      const end = time + ms;
      while (true) {
        const next = [...timers].filter(([, value]) => value.at <= end).sort((a, b) => a[1].at - b[1].at)[0];
        if (!next) break;
        timers.delete(next[0]); time = next[1].at; next[1].fn();
      }
      time = end;
    }
  };
}

// Only the Chrome/platform surface is simulated. Input admission, native
// document graph, hint gate, deadlines, retained reads and cleanup are real.
async function fixture(t, options = {}) {
  const url = "https://fixture.test/original", targetId = "original-target";
  const candidate = Object.freeze({ tabId: 7, targetId, documentId: "original-browser-document", navigationVersion: 0, url });
  const calls = [], reads = [], readHooks = [], pending = [], listeners = new Set(), risks = new Set();
  let paused = false;
  const event = (method, params) => { for (const listener of [...listeners]) listener({ targetId }, method, params); };
  const chrome = { debugger: {
    onEvent: { addListener: listener => listeners.add(listener), removeListener: listener => listeners.delete(listener) },
    async attach(target) { calls.push({ method: "attach", target }); },
    async detach(target) { calls.push({ method: "detach", target }); },
    async sendCommand(target, method, params) {
      calls.push({ method, target, params });
      if (method === "Runtime.enable") event("Runtime.executionContextCreated", { context: {
        id: 1, uniqueId: "original-default-context", origin: "https://fixture.test", auxData: { frameId: "root", isDefault: true }
      } });
      if (method === "Page.startScreencast") queueMicrotask(() => event("Page.screencastFrame", {
        data: "cGl4ZWxz", sessionId: 42,
        metadata: { deviceWidth: 800, deviceHeight: 600, pageScaleFactor: 1, offsetTop: 0, monotonicTimestamp: 101 }
      }));
      const supplied = await options.command?.(method, params, target);
      if (supplied !== undefined) return supplied;
      if (method === "Page.getFrameTree") return { frameTree: { frame: { id: "root", loaderId: "original-loader", url } } };
      if (method === "Performance.getMetrics") return { metrics: [{ name: "Timestamp", value: 100 }] };
      if (method === "Page.getLayoutMetrics") return { cssVisualViewport: { clientWidth: 800, clientHeight: 600, scale: 1, zoom: 1, offsetX: 0, offsetY: 0 } };
      return {};
    }
  } };
  const control = new ManagedHumanControl({ chrome, timing: options.timing,
    capture: async () => candidate,
    validate: async (original, validationOptions = {}) => {
      assert.equal(validationOptions.advance ?? false, false, "A URL hint cannot advance a document");
      assert.equal(original.documentId, candidate.documentId);
      reads.push(original);
      await readHooks.shift()?.();
      return Object.freeze({ ...original });
    },
    pause: async () => { paused = true; }, assertPaused: () => assert.equal(paused, true),
    markRisk: async lease => { risks.add(lease); }, clearRisk: async lease => { risks.delete(lease); },
    onFailure: error => calls.push({ method: "failure", error })
  });
  const admitted = control.begin(7, () => {}, () => {}), record = control.current;
  const handle = await admitted; await record.start;
  assert.equal(handle.info().state, "active");
  reads.length = 0;
  t.after(async () => {
    for (const original of pending) original.resolve();
    await handle.close(); control.assertReleased();
  });
  return { control, record, handle, calls, reads, risks, url,
    hint: () => assert.equal(control.navigationHint(7, { url }), true),
    nativeInputs: () => calls.filter(call => call.method.startsWith("Input.")),
    queueRead(read) { readHooks.push(read); },
    heldRead() {
      const actual = defer(), entered = defer(); pending.push(actual);
      return { ...actual, entered: entered.promise, hook: () => { entered.resolve(); return actual.promise; } };
    },
    input() { const info = handle.info(); return handle.input({ leaseId: info.leaseId, generation: info.generation,
      sequence: info.lastInputSequence + 1, input: { type: "text", text: "one original insertion" } }); }
  };
}

test("human input waits for the original hint read before one native dispatch", async t => {
  const f = await fixture(t), read = f.heldRead(), originalEpoch = f.record.epoch;
  f.queueRead(undefined); // Normal existing input policy read precedes the hint check.
  f.queueRead(read.hook); f.hint();
  const input = f.input(); await read.entered;
  assert.equal(f.nativeInputs().length, 0);
  assert.equal(f.record.hintReads.size, 1);
  const [retained] = f.record.hintReads;
  assert.equal(f.record.drains.has(retained), true);
  assert.equal(Boolean(originalEpoch.retired), false);
  read.resolve();
  assert.deepEqual(await input, { leaseId: f.record.leaseId, generation: originalEpoch.id, sequence: 1, acknowledged: true });
  assert.equal(f.nativeInputs().length, 1);
  assert.deepEqual(f.nativeInputs()[0].target, { targetId: "original-target" });
  assert.equal(f.record.hintReads.size, 0);
  assert.equal(f.record.urlHint, null);
  assert.equal(f.reads.length, 2);
});

test("a second hint in the approved-read to dispatch microtask gap requires its own read", async t => {
  const f = await fixture(t), first = f.heldRead(), second = f.heldRead();
  f.queueRead(undefined); f.queueRead(first.hook); f.queueRead(second.hook);
  const verify = f.control.verifyHint; let injected = false, approvals = 0;
  f.control.verifyHint = function (...args) {
    // Preserve real verification. Inject precisely after its fulfilled result,
    // before the caller's await can resume the final native-send segment.
    return Reflect.apply(verify, this, args).then(value => {
      approvals++;
      if (!injected) { assert.equal(f.record.urlHint, null); injected = true; f.hint(); }
      return value;
    });
  };
  f.hint(); const input = f.input(); await first.entered;
  first.resolve(); await second.entered;
  assert.equal(injected, true); assert.equal(approvals, 1);
  assert.equal(f.nativeInputs().length, 0, "First approval cannot authorize input after another hint");
  second.resolve(); assert.equal((await input).acknowledged, true);
  assert.equal(approvals, 2); assert.equal(f.nativeInputs().length, 1);
  assert.equal(f.reads.length, 3);
  assert.equal(f.reads[1], f.reads[2], "Both reads retain the caller's same original candidate");
});

test("hint timeout revokes unsent input but retains the actual browser read through End", async t => {
  const timing = manualTiming(), f = await fixture(t, { timing }), read = f.heldRead();
  f.queueRead(undefined); f.queueRead(read.hook); f.hint();
  const input = f.input(), rejected = assert.rejects(input, /OBU_HUMAN_STALE|revoked/);
  await read.entered;
  const [actualRead] = f.record.hintReads;
  let settled = false; actualRead.then(() => { settled = true; }, () => { settled = true; });
  timing.advance(4999); assert.equal(Boolean(f.record.revoked), false);
  timing.advance(1); assert.equal(f.record.revoked, true);
  await rejected;
  let closed = false; const closing = f.handle.close().then(() => { closed = true; }); await tick();
  assert.equal(settled, false); assert.equal(closed, false);
  assert.equal(f.record.hintReads.has(actualRead), true); assert.equal(f.record.drains.has(actualRead), true);
  assert.equal(f.nativeInputs().length, 0);
  assert.equal(f.calls.some(call => call.method === "detach"), false);
  assert.equal(f.risks.size, 1);
  read.resolve(); await closing;
  assert.equal(settled, true); assert.equal(f.record.hintReads.size, 0);
  assert.equal(f.nativeInputs().length, 0); assert.equal(f.risks.size, 0); assert.equal(timing.timers.size, 0);
});

test("late hint timer cannot authorize input when the browser read returns at its deadline", async t => {
  const timing = manualTiming(), f = await fixture(t, { timing }), read = f.heldRead();
  f.queueRead(undefined); f.queueRead(read.hook); f.hint();
  const input = f.input(), rejected = assert.rejects(input, /OBU_HUMAN_STALE|revoked/);
  await read.entered;
  const [actualRead] = f.record.hintReads;
  timing.skip(5000); // Deliberately do not execute the timer callback.
  assert.equal(Boolean(f.record.revoked), false);
  assert.equal(f.record.hintReads.has(actualRead), true); assert.equal(f.nativeInputs().length, 0);
  read.resolve(); await rejected; await f.handle.close();
  assert.match((await f.handle.closed).reason, /OBU_HUMAN_HINT_TIMEOUT/);
  assert.equal(f.nativeInputs().length, 0); assert.equal(timing.timers.size, 0);
});

test("repeated approved hints do not restart the one dispatch deadline", async t => {
  const timing = manualTiming(), f = await fixture(t, { timing }), first = f.heldRead(), second = f.heldRead();
  f.queueRead(undefined); f.queueRead(first.hook); f.queueRead(second.hook);
  const verify = f.control.verifyHint; let injected = false;
  f.control.verifyHint = function (...args) {
    return Reflect.apply(verify, this, args).then(value => {
      if (!injected) { injected = true; f.hint(); }
      return value;
    });
  };
  f.hint(); const input = f.input(), rejected = assert.rejects(input, /OBU_HUMAN_STALE|revoked/);
  await first.entered; timing.advance(4000); first.resolve(); await second.entered;
  timing.advance(999); assert.equal(Boolean(f.record.revoked), false);
  timing.advance(1); await rejected;
  assert.equal(f.record.revoked, true); assert.equal(f.record.hintReads.size, 1);
  assert.equal(f.nativeInputs().length, 0);
  second.resolve(); await f.handle.close(); assert.equal(timing.timers.size, 0);
});

test("the ninth dirty observation cannot start an unbounded verification chain", async t => {
  const timing = manualTiming(), f = await fixture(t, { timing });
  const verify = f.control.verifyHint; let verified = 0;
  f.control.verifyHint = function (...args) {
    return Reflect.apply(verify, this, args).then(value => { verified++; f.hint(); return value; });
  };
  f.hint(); await assert.rejects(f.input(), /OBU_HUMAN_STALE|revoked/);
  await f.handle.close();
  assert.equal(verified, 8);
  assert.equal(f.reads.length, 9, "One ordinary input read plus exactly eight hint reads");
  assert.match((await f.handle.closed).reason, /OBU_HUMAN_HINT_CAPACITY/);
  assert.equal(f.nativeInputs().length, 0); assert.equal(f.record.hintReads.size, 0);
  assert.equal(timing.now(), 0); assert.equal(timing.timers.size, 0);
});

test("hint and End after actual input dispatch preserve its original pending ACK", async t => {
  const native = defer(), entered = defer();
  t.after(() => native.resolve());
  const f = await fixture(t, { command: method => { if (method === "Input.insertText") { entered.resolve(); return native.promise; } } });
  const input = f.input(); await entered.promise;
  f.hint(); let closed = false; const closing = f.handle.close().then(() => { closed = true; }); await tick();
  assert.equal(closed, false); assert.equal(f.record.hintReads.size, 0);
  assert.equal(f.nativeInputs().length, 1); assert.equal(f.reads.length, 1);
  native.resolve(); assert.equal((await input).acknowledged, true); await closing;
  assert.equal(f.nativeInputs().length, 1); assert.equal(f.risks.size, 0);
});

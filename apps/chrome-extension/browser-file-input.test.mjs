import assert from "node:assert/strict";
import test from "node:test";
import vm from "node:vm";
import { captureFileInput, setLocatorInputFiles, validateFileInputPaths } from "./browser-file-input.js";
const deferred = () => { let resolve, reject; const promise = new Promise((a, b) => { resolve = a; reject = b; }); return { promise, resolve, reject }; };

test("strict paths preserve Unicode, absolute platform forms and empty clear, with immutable copies", () => {
  const files = ["/文件/😀", "C:\\files\\x", "D:/files/x", "\\\\server\\share\\file"];
  const result = validateFileInputPaths(files); files[0] = "relative";
  assert.equal(result[0], "/文件/😀"); assert.equal(Object.isFrozen(result), true);
  assert.deepEqual(validateFileInputPaths([]), []);
  for (const value of [null, {}, [""], ["a"], ["C:a"], ["\\a"], ["\\\\server"], ["/a\0b"], ["/a\ud800"], ["/\udc00"], new Array(1), new Array(1025).fill("/a"), ["/" + "x".repeat(131072)], new Array(65).fill("/" + "x".repeat(131071))]) assert.throws(() => validateFileInputPaths(value));
  assert.equal(validateFileInputPaths(["/" + "x".repeat(131071)])[0].length, 131072);
});

test("actual fixed renderer resolver is strict and accepts hidden input only, without focus or bytes", () => {
  const document = {}, calls = [];
  class HTMLInputElement { constructor() { this.ownerDocument = document; this.isConnected = true; this.type = "file"; this.hidden = true; } }
  const node = new HTMLInputElement();
  const resolve = vm.runInNewContext(`(${captureFileInput.toString()})`, { document, HTMLInputElement });
  const injected = { querySelector(...args) { calls.push(args); return node; } };
  assert.equal(resolve(injected, { info: { parsed: "native", strict: true } }), node);
  assert.deepEqual(calls, [["native", document, true]]);
  node.type = "text"; assert.throws(() => resolve(injected, { info: {} }), /input\[type=file\]/);
  node.type = "file"; node.isConnected = false; assert.throws(() => resolve(injected, { info: {} }), /disconnected/);
  assert.equal(resolve({ querySelector: () => null }, { info: {} }), null);
});

function fixture() {
  const calls = [], context = {}, node = { asElement() { return this; } };
  let observer, nextResolve, nextDescribe, nextSubmit, nextCheck;
  const identity = { target: { tabId: 7, sessionId: "child" }, frameId: "child-frame", check() { calls.push("identity"); }, async describe() { calls.push("describe"); await nextDescribe?.(); return 91; } };
  const resolved = { info: { world: "utility", strict: true }, injected: { _context: context }, frame: { _utilityContext: async () => context } };
  const frame = { selectors: { async resolveInjectedForSelector(_selector, options) { calls.push("resolve"); assert.equal(options.strict, true); return nextResolve ? nextResolve() : resolved; } },
    _isErrorThatCannotBeRetried: error => error.terminal === true,
    async retryWithProgressAndTimeouts(_progress, intervals, callback) { assert.deepEqual(intervals, [0, 20, 50, 100, 100, 500]); const again = Symbol(); for (let i = 0; i < 8; i++) { const result = await callback(again); if (result !== again) return result; } throw new Error("too many retries"); } };
  const native = { setHandleObserver(fn) { observer = fn; }, async evaluateHandle(_handle, fn) { assert.equal(fn, captureFileInput); calls.push("select"); observer(node); return node; },
    fileInputIdentity(handle) { assert.equal(handle, node); return identity; }, async dispose(handle) { assert.equal(handle, node); calls.push("dispose"); } };
  const options = { files: ["/file"], deadlineAt: performance.now() + 1000, async check() { calls.push("check"); await nextCheck?.(); },
    async runNativeTask(_locator, { timeoutMs }, task) { assert.ok(timeoutMs > 0 && timeoutMs <= 1000); return task(frame, "input", { throwIfAborted() {} }, native); },
    prepare(value) { assert.equal(value, identity); calls.push("prepare"); return { check() { calls.push("admission"); }, async submit(id, files) { assert.equal(id, 91); assert.deepEqual(files, ["/file"]); calls.push("submit"); await nextSubmit?.(); } }; } };
  return { calls, options, node, native, identity, resolved, setResolve: fn => nextResolve = fn, setDescribe: fn => nextDescribe = fn, setSubmit: fn => nextSubmit = fn, setCheck: fn => nextCheck = fn,
    run: () => setLocatorInputFiles({}, options) };
}

test("attached selector misses and pre-selection context loss wait, selected input is submitted only once", async () => {
  const f = fixture(); let count = 0;
  f.setResolve(() => { if (++count === 1) return null; if (count === 2) throw new Error("context destroyed"); return f.resolved; });
  await f.run(); assert.equal(count, 3); assert.equal(f.calls.filter(x => x === "submit").length, 1);
  assert.ok(f.calls.indexOf("prepare") < f.calls.indexOf("describe")); assert.equal(f.calls.at(-1), "dispose");
});

test("strict selector error is not retried and creates no input submission", async () => {
  const f = fixture(), error = Object.assign(new Error("strict mode violation"), { terminal: true });
  f.setResolve(() => { throw error; }); await assert.rejects(f.run(), value => value === error);
  assert.equal(f.calls.filter(x => x === "resolve").length, 1); assert.equal(f.calls.includes("submit"), false);
});

test("late node description cannot consume a changed context or revoked authority", async () => {
  for (const reason of ["context", "authority"]) {
    const f = fixture(), gate = deferred(), entered = deferred(), error = new Error(reason);
    f.setDescribe(async () => { entered.resolve(); await gate.promise; });
    const result = assert.rejects(f.run(), value => value === error);
    await entered.promise;
    if (reason === "context") f.identity.check = () => { throw error; };
    if (reason === "authority") f.setCheck(() => { throw error; });
    gate.resolve(); await result;
    assert.equal(f.calls.includes("submit"), false); assert.equal(f.calls.at(-1), "dispose");
  }
});

test("mutation rejection never re-resolves or repeats, and ordinary navigation after ACK remains valid", async () => {
  const f = fixture(), error = new Error("native lost ACK"); f.setSubmit(() => { throw error; });
  await assert.rejects(f.run(), value => value === error);
  assert.equal(f.calls.filter(x => x === "resolve").length, 1); assert.equal(f.calls.filter(x => x === "submit").length, 1);
  const next = fixture(); next.setSubmit(() => { next.identity.check = () => { throw new Error("old document gone"); }; });
  await next.run(); assert.equal(next.calls.at(-1), "dispose");
});

test("cleanup failure retains original error and the actual unresolved disposal is joined", async () => {
  const f = fixture(), gate = deferred(), entered = deferred(), original = new Error("write failed"), cleanup = new Error("release failed");
  f.setSubmit(() => { throw original; });
  f.native.dispose = async () => { entered.resolve(); await gate.promise; throw cleanup; };
  let settled = false;
  const result = assert.rejects(f.run(), error => error.mediaCleanupFailed && error.cause === original && error.cleanupErrors[0].cause === cleanup).then(() => { settled = true; });
  await entered.promise; assert.equal(settled, false); gate.resolve(); await result;
});


test("original monotonic deadline stops a late description without submission", async t => {
  let now = 0; t.mock.method(performance, "now", () => now);
  const f = fixture(), gate = deferred(), entered = deferred();
  f.options.deadlineAt = 10;
  f.setDescribe(async () => { entered.resolve(); await gate.promise; });
  const result = assert.rejects(f.run(), error => error.name === "TimeoutError");
  await entered.promise; now = 11; gate.resolve(); await result;
  assert.equal(f.calls.includes("submit"), false); assert.equal(f.calls.at(-1), "dispose");
});


test("uncertain frame-owner cleanup cannot enter selector retry or submit a replacement", async () => {
  const f = fixture(); let count = 0;
  const failure = Object.assign(new Error("owner handle release failed"), { mediaCleanupFailed: true });
  f.setResolve(() => { count++; throw failure; });
  await assert.rejects(f.run(), error => error === failure);
  assert.equal(count, 1); assert.equal(f.calls.includes("submit"), false);
});

import assert from "node:assert/strict";
import { test } from "node:test";
import { EventEmitter } from "node:events";
import { BrowserActionEngine, validateBrowserAction } from "./browser-action-engine.js";
import { BrowserDiagnostics } from "./browser-diagnostics.js";

const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };
const scope = { session_id: "body-owner", turn_id: "body-turn", control_epoch: 4 };
const tick = () => new Promise(resolve => setImmediate(resolve));
function fixture({ authorize = () => {}, restricted = () => false } = {}) {
  const sources = new WeakMap(), calls = [], detached = [];
  const runtime = { setOpenBrowserUseEventFilter() {}, setOpenBrowserUseCommandObserver() {},
    createOpenBrowserUseResponseBodyRead(response) {
      const source = sources.get(response); assert.ok(source); source.bound.resolve();
      return { finished: source.finished.promise, read: guard => {
        guard(); calls.push(source); source.entered.resolve();
        return source.native?.promise ?? Promise.resolve({ body: "original 🧪", base64Encoded: false });
      } };
    } };
  const engine = new BrowserActionEngine({ loadRuntime: async () => runtime, authorize, restrictedSelectors: restricted });
  const add = (tabId = 42, { wait = false, native } = {}) => {
    const page = new EventEmitter(), finished = deferred(), bound = deferred(), entered = deferred();
    page.keyboard = { insertText: async text => { assert.equal(text, "release original response"); finished.resolve(); } };
    const request = { url: () => "https://fixture.test/original", method: () => "POST", resourceType: () => "fetch",
      frame: () => ({ url: () => "https://fixture.test/" }), redirectedFrom: () => null };
    const response = { request: () => request, status: () => 200, statusText: () => "OK" };
    const diagnostics = new BrowserDiagnostics(page);
    diagnostics.record("response", response);
    const snapshot = diagnostics.snapshot(), ref = { captureId: snapshot.captureId, requestId: snapshot.entries[0].requestId };
    const source = { page, diagnostics, response, finished, bound, entered, native, ref, tabId };
    sources.set(response, source);
    engine.pages.set(tabId, Promise.resolve({ page, diagnostics, diagnosticsOwner: JSON.stringify([scope.session_id, scope.control_epoch]),
      app: { detach: async id => { detached.push(id); } } }));
    if (!wait) finished.resolve();
    source.read = (extra = {}) => engine.dispatch({ ...scope, tabId, action: "responseBody", args: ref, timeoutMs: 1000, ...extra });
    return source;
  };
  return { engine, add, calls, detached };
}

test("an original response can await completion while a later same-tab action finishes it", async () => {
  const f = fixture(), source = f.add(42, { wait: true });
  const pending = source.read(); await source.bound.promise;
  assert.equal(f.calls.length, 0);
  await f.engine.dispatch({ ...scope, tabId: 42, action: "keyboard.insertText", args: { text: "release original response" } });
  const result = await pending;
  assert.equal(Buffer.from(result.value.data, "base64").toString(), "original 🧪");
  assert.equal(result.value.captureId, source.ref.captureId);
  assert.equal(result.value.requestId, source.ref.requestId);
  assert.equal(result.engine.capabilities.responseBody, 1);
  assert.equal(f.calls.length, 1); assert.deepEqual(f.detached, []);
  assert.equal(f.engine.responseReads.size, 0);
});

test("an absent or foreign diagnostic capture cannot attach or issue a native read", async () => {
  const f = fixture();
  await assert.rejects(f.engine.dispatch({ ...scope, tabId: 42, action: "responseBody", args: { captureId: "missing", requestId: "request-1" } }), /OBU_RESPONSE_BODY_EXPIRED/);
  const source = f.add();
  await assert.rejects(source.read({ args: { ...source.ref, captureId: "another-capture" } }), /OBU_RESPONSE_BODY_EXPIRED/);
  await assert.rejects(source.read({ session_id: "another-owner" }), /OBU_RESPONSE_BODY_EXPIRED/);
  assert.equal(f.calls.length, 0); assert.deepEqual(f.detached, []);
  assert.equal(f.engine.responseReads.size, 0);
});

test("a queued body timeout preserves the preceding action and admits no late native read", async () => {
  const f = fixture(), source = f.add(), previous = deferred();
  f.engine.queues.set(42, previous.promise);
  await assert.rejects(source.read({ timeoutMs: 20 }), /OBU_RESPONSE_BODY_TIMEOUT/);
  assert.equal(f.calls.length, 0); assert.deepEqual(f.detached, []);
  assert.equal(f.engine.responseReads.size, 1, "unsettled original preparation stays bounded");
  previous.resolve(); await tick();
  assert.equal(f.calls.length, 0); assert.equal(f.engine.responseReads.size, 0);
});

test("two expired native reads retain capacity and drain identity until actual settlement", async () => {
  const f = fixture(), native = deferred(), original = f.add(42, { native });
  const first = original.read(), second = original.read();
  const failures = Promise.all([assert.rejects(first, /OBU_RESPONSE_BODY_EXPIRED/), assert.rejects(second, /OBU_RESPONSE_BODY_EXPIRED/)]);
  await original.entered.promise; await tick(); assert.equal(f.calls.length, 2);
  const retained = [...f.engine.responseReads].map(read => read.done);
  f.engine.forget(42); await failures;
  assert.deepEqual(f.engine.controlSnapshot().tabIds, [], "retired native reads retain drain identity only");
  const successor = f.add(42);
  await assert.rejects(successor.read(), /OBU_RESPONSE_BODY_CAPACITY/);
  for (const pending of retained) assert.ok(f.engine.controlSnapshot().pending.includes(pending));
  assert.equal(f.calls.length, 2); assert.deepEqual(f.detached, []);
  native.resolve({ body: "late old body", base64Encoded: false }); await Promise.all(retained);
  const fresh = await successor.read();
  assert.equal(Buffer.from(fresh.value.data, "base64").toString(), "original 🧪");
  assert.equal(f.calls.length, 3); assert.equal(f.engine.responseReads.size, 0);
});

test("a body deadline does not detach the page and late native bytes cannot become success", async () => {
  const f = fixture(), native = deferred(), source = f.add(42, { native });
  const pending = source.read({ timeoutMs: 30 });
  const failed = assert.rejects(pending, /OBU_RESPONSE_BODY_TIMEOUT/);
  await source.entered.promise; await failed;
  assert.deepEqual(f.detached, []); assert.equal(f.engine.responseReads.size, 1);
  native.resolve({ body: "too late", base64Encoded: false }); await tick();
  assert.equal(f.engine.responseReads.size, 0); assert.equal(f.calls.length, 1);
});

test("capture eviction cancels waiting without waiting for the response or reading its body", async () => {
  const f = fixture(), source = f.add(42, { wait: true });
  const pending = source.read();
  const failed = assert.rejects(pending, /OBU_RESPONSE_BODY_EXPIRED/);
  await source.bound.promise;
  for (let index = 0; index < 501; index++) source.diagnostics.record("console", { type: () => "log", text: () => "next entry", location: () => ({}) });
  await failed;
  assert.equal(f.calls.length, 0); assert.equal(f.engine.responseReads.size, 0);
});

test("authorization is checked again after headers finish and before any native read", async () => {
  let allowed = true;
  const f = fixture({ authorize: () => { if (!allowed) throw new Error("original scope revoked"); } });
  const source = f.add(42, { wait: true }), pending = source.read();
  const failed = assert.rejects(pending, /original scope revoked/);
  await source.bound.promise; allowed = false; source.finished.resolve();
  await failed;
  assert.equal(f.calls.length, 0); assert.equal(f.engine.responseReads.size, 0);
});

test("website restrictions refuse the body channel before binding native objects", async () => {
  const f = fixture({ restricted: () => true }), source = f.add();
  await assert.rejects(source.read(), /OBU_SITE_ACCESS_UNSUPPORTED/);
  assert.equal(f.calls.length, 0); assert.equal(f.engine.responseReads.size, 0);
});

test("a read awaiting authorization cannot reintroduce forgotten tab authority", async () => {
  const authorization = deferred(), entered = deferred();
  const f = fixture({ authorize: () => { entered.resolve(); return authorization.promise; } });
  const source = f.add(), pending = source.read();
  const failed = assert.rejects(pending, /OBU_RESPONSE_BODY_EXPIRED/);
  await entered.promise;
  const [record] = f.engine.responseReads;
  f.engine.forget(42); await failed;
  assert.deepEqual(f.engine.controlSnapshot().tabIds, []);
  assert.ok(f.engine.controlSnapshot().pending.includes(record.done));
  assert.equal(f.engine.queues.size, 0);
  authorization.resolve(); await record.done;
  assert.equal(f.calls.length, 0); assert.equal(f.engine.responseReads.size, 0);
});

test("asynchronous authorization after terminal response must settle before native send", async () => {
  let gate;
  const entered = deferred();
  const f = fixture({ authorize: () => { if (gate) { entered.resolve(); return gate.promise; } } });
  const source = f.add(42, { wait: true }), pending = source.read();
  const failed = assert.rejects(pending, /async scope revoked/);
  await source.bound.promise; await tick();
  gate = deferred(); source.finished.resolve(); await entered.promise;
  assert.equal(f.calls.length, 0);
  gate.reject(new Error("async scope revoked")); await failed;
  assert.equal(f.calls.length, 0); assert.equal(f.engine.responseReads.size, 0);
});

test("cancelled post-terminal authorization retains its original drain reservation", async () => {
  let gate;
  const entered = deferred();
  const f = fixture({ authorize: () => { if (gate) { entered.resolve(); return gate.promise; } } });
  const source = f.add(42, { wait: true }), pending = source.read();
  const failed = assert.rejects(pending, /OBU_RESPONSE_BODY_EXPIRED/);
  await source.bound.promise; await tick();
  gate = deferred(); source.finished.resolve(); await entered.promise;
  const [record] = f.engine.responseReads;
  f.engine.forget(42); await failed; await tick();
  assert.equal(record.checksPending, 1);
  assert.ok(f.engine.controlSnapshot().pending.includes(record.done));
  assert.deepEqual(f.engine.controlSnapshot().tabIds, []);
  gate.resolve(); await record.done;
  assert.equal(f.calls.length, 0); assert.equal(f.engine.responseReads.size, 0);
});

test("engine-wide capacity includes independent original tabs until completion", async () => {
  const f = fixture(), native = deferred(), reads = [];
  for (let id = 1; id <= 8; id++) {
    const source = f.add(id, { native }); reads.push(source.read()); await source.entered.promise;
  }
  await assert.rejects(f.add(9).read(), /OBU_RESPONSE_BODY_CAPACITY/);
  assert.equal(f.calls.length, 8);
  native.resolve({ body: "bounded", base64Encoded: false }); await Promise.all(reads);
  assert.equal(f.engine.responseReads.size, 0);
});

test("response body uses strict arguments, bounded references and no locator", () => {
  const request = { ...scope, tabId: 42, action: "responseBody", args: { captureId: "capture", requestId: "request-1" } };
  assert.equal(validateBrowserAction(request).args.maxBytes, 1024 * 1024);
  for (const extra of [{ locator: [{ kind: "css", selector: "body" }] },
    { args: { ...request.args, url: "https://other.test" } }, { args: { ...request.args, maxBytes: 0 } },
    { args: { ...request.args, maxBytes: 8 * 1024 * 1024 + 1 } }])
    assert.throws(() => validateBrowserAction({ ...request, ...extra }));
});

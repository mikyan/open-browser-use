import assert from "node:assert/strict";
import test from "node:test";
import vm from "node:vm";
import { ManagedHumanFileChoosers } from "./managed-human-file-chooser.js";

const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };
const tick = () => new Promise(resolve => setImmediate(resolve));
async function until(predicate) { for (let n = 0; n < 60; n++) { if (predicate()) return; await tick(); } assert.fail("Original directory stage was not reached"); }

// Execute the actual isolated-world guard on a minimal original native node.
// This verifies the chooser/registry boundary; real browser acceptance remains
// separate and must supply original trusted input and FileList evidence.
async function fixture(t, { child = false, directory = true, multiple = false, mode = "selectMultiple" } = {}) {
  const context = vm.createContext({ Date, Promise, WeakMap, Map });
  vm.runInContext(`
    globalThis.document={defaultView:globalThis};
    globalThis.HTMLInputElement=class {
      constructor(){this.type='file';this.isConnected=true;this.ownerDocument=document;this.webkitdirectory=${directory};this.multiple=${multiple};this.files=[];this.listeners=new Map()}
      addEventListener(type,fn){const list=this.listeners.get(type)||[];list.push(fn);this.listeners.set(type,list)}
      removeEventListener(type,fn){this.listeners.set(type,(this.listeners.get(type)||[]).filter(item=>item!==fn))}
      emit(type,trusted=true){for(const fn of [...(this.listeners.get(type)||[])])fn({type,target:this,isTrusted:trusted})}
    };
    globalThis.node=new HTMLInputElement();
  `, context);
  const calls = [], failures = [], notifications = [], objects = new Map(), node = context.node;
  const proof = Object.freeze({ generation: 1, contexts: {}, source: { origin: child ? "https://child.test" : "https://root.test", frame: child ? "child" : "top-level" } });
  const sessionId = child ? "original-child" : undefined, frameId = child ? "child-frame" : "root-frame";
  let serial = 0, interceptor, current = true, nativeWrites = 0;
  const remote = value => { const objectId = `object-${++serial}`; objects.set(objectId, value); return { objectId }; };
  async function execute(method, params) {
    if (method === "Page.setInterceptFileChooserDialog") return {};
    if (method === "DOM.setFileInputFiles") { nativeWrites++; return {}; }
    if (method === "Page.createIsolatedWorld") return { executionContextId: 51 };
    if (method === "DOM.resolveNode") return { object: remote(node) };
    if (method === "Runtime.releaseObject") { objects.delete(params.objectId); return {}; }
    assert.equal(method, "Runtime.callFunctionOn");
    try {
      const receiver = objects.get(params.objectId); assert.ok(receiver);
      let value = vm.runInContext(`(${params.functionDeclaration})`, context).apply(receiver, (params.arguments ?? []).map(row => row.value));
      if (params.awaitPromise) value = await value;
      return { result: params.returnByValue ? { value } : remote(value) };
    } catch (error) { return { exceptionDetails: { text: String(error) }, result: { ...remote(error), subtype: "error" } }; }
  }
  const send = (targetSession, method, params, check, original) => {
    const row = { sessionId: targetSession, method, params, proof: original }; calls.push(row);
    const run = () => { check?.(); return execute(method, params); };
    return Promise.resolve().then(() => interceptor ? interceptor(row, run) : run());
  };
  const choosers = new ManagedHumanFileChoosers({ leaseId: "lease", tabId: 7,
    capture: opening => { assert.deepEqual(opening, { sessionId, frameId }); return proof; },
    assertCurrent: original => { assert.equal(original, proof); if (!current) throw Error("original document retired"); },
    addressable: () => true, retirement: () => null, attached: () => true, send,
    notify: () => notifications.push(choosers.info()), onFailure: error => failures.push(error), assertIdle: () => {} });
  await choosers.enable(sessionId, () => {});
  const open = () => choosers.observe(sessionId, { frameId, backendNodeId: 17, mode });
  const sets = () => calls.filter(row => row.method === "DOM.setFileInputFiles");
  const request = () => { const { leaseId, generation, chooserId } = choosers.info(); return { leaseId, generation, chooserId, transferId: "server-transfer" }; };
  t.after(async () => { node.emit("cancel"); await choosers.close(); });
  return { choosers, proof, calls, failures, notifications, node, objects, open, request, sets, nativeWrites: () => nativeWrites,
    intercept: value => { interceptor = value; }, revokeDocument: () => { current = false; } };
}

for (const child of [false, true]) test(`directory ${child ? "OOPIF" : "root"} publishes original node mode and waits for actual trusted enumeration`, async t => {
  const f = await fixture(t, { child }); f.open();
  assert.equal(f.choosers.info(), null);
  await until(() => f.choosers.info());
  assert.equal(f.choosers.info().directory, true); assert.equal(f.choosers.info().multiple, false);
  assert.equal(Object.isFrozen(f.choosers.info()), true);
  const request = f.request(); f.choosers.begin(request);
  let finished = false;
  const result = f.choosers.commit({ ...request, files: ["C:\\private-transfer\\资料"] }).then(value => { finished = true; return value; });
  await until(() => f.choosers.registry.records.values().next().value?.nativeSettled);
  assert.equal(finished, false); assert.equal(f.sets().length, 1);
  assert.equal(f.sets()[0].proof, f.proof);
  assert.equal(f.sets()[0].sessionId, child ? "original-child" : undefined);
  assert.deepEqual(f.sets()[0].params, { backendNodeId: 17, files: ["C:\\private-transfer\\资料"] });
  f.node.emit("input", false); f.node.emit("change"); await tick(); assert.equal(finished, false);
  f.node.files = [{ name: "same.txt" }, { name: "same.txt" }]; f.node.emit("input");
  assert.deepEqual(await result, { ...request, acknowledged: true });
  assert.equal(f.choosers.info(), null); assert.equal(f.choosers.registry.size, 0);
  assert.equal(f.objects.size, 0); assert.equal(f.failures.length, 0);
});

test("original trusted input before native ACK cannot acknowledge the directory early", async t => {
  const f = await fixture(t), ack = deferred(); f.open(); await until(() => f.choosers.info());
  f.intercept(async (row, run) => {
    const result = await run();
    return row.method === "DOM.setFileInputFiles" ? ack.promise : result;
  });
  const request = f.request(); f.choosers.begin(request); let done = false;
  const commit = f.choosers.commit({ ...request, files: ["C:\\private\\root"] }).then(value => { done = true; return value; });
  await until(() => f.sets().length); f.node.emit("input"); await tick(); assert.equal(done, false);
  ack.resolve({}); assert.deepEqual(await commit, { ...request, acknowledged: true });
});

test("native directory cancel after ACK is a failure, never the ordinary ACK fallback", async t => {
  const f = await fixture(t); f.open(); await until(() => f.choosers.info());
  const request = f.request(); f.choosers.begin(request);
  const commit = f.choosers.commit({ ...request, files: ["C:\\private\\root"] });
  const rejected = assert.rejects(commit, /DIRECTORY_UPLOAD_CANCELLED/);
  await until(() => f.choosers.registry.records.values().next().value?.nativeSettled);
  f.node.emit("cancel"); await rejected; await f.choosers.drain();
  assert.equal(f.failures.length, 1); assert.equal(f.sets().length, 1);
  assert.throws(() => f.choosers.commit({ ...request, files: ["C:\\private\\root"] }), /FILE_STALE/);
});

test("directory claim rejects multiple roots and client-selected directory authority before writing", async t => {
  const f = await fixture(t); f.open(); await until(() => f.choosers.info());
  const request = f.request(); f.choosers.begin(request);
  for (const value of [{ ...request, files: ["C:\\private\\one", "C:\\private\\two"] },
    { ...request, files: ["C:\\private\\one"], directory: false }])
    assert.throws(() => f.choosers.commit(value), /FILE_INVALID/);
  assert.equal(f.sets().length, 0);
  assert.deepEqual(await f.choosers.cancel(request), { ...request, cancelled: true });
});

test("changing the original node directory mode after preparation cannot write", async t => {
  const f = await fixture(t); f.open(); await until(() => f.choosers.info());
  const request = f.request(); f.choosers.begin(request); f.node.webkitdirectory = false;
  await assert.rejects(f.choosers.commit({ ...request, files: ["C:\\private\\root"] }), /renderer admission failed/);
  assert.equal(f.sets().length, 0); await f.choosers.drain();
});

test("directory native dispatch retains the original final admission instead of adopting a later chooser", async t => {
  const f = await fixture(t), pending = deferred(), entered = deferred(); f.open(); await until(() => f.choosers.info());
  f.intercept(async (row, run) => {
    if (row.method === "DOM.setFileInputFiles") { entered.resolve(); await pending.promise; }
    return run();
  });
  const request = f.request(); f.choosers.begin(request);
  const commit = f.choosers.commit({ ...request, files: ["C:\\private\\root"] });
  const rejected = assert.rejects(commit, /original document retired/);
  await entered.promise; f.revokeDocument(); pending.resolve(); await rejected;
  // No mutation was dispatched, so no input/cancel event exists to await.
  // Teardown may dispose a failing fixture, but cannot satisfy this assertion.
  let drained = false; const draining = f.choosers.drain().then(() => { drained = true; });
  await until(() => drained); await draining;
  assert.equal(f.sets().length, 1); assert.equal(f.nativeWrites(), 0); assert.equal(f.failures.length, 1);
  assert.equal(f.objects.size, 0); assert.equal(f.choosers.registry.size, 0);
});

test("End during final admission before native dispatch drains without an invented terminal event", async t => {
  const f = await fixture(t), pending = deferred(), entered = deferred(); f.open(); await until(() => f.choosers.info());
  f.intercept(async (row, run) => {
    if (row.method === "DOM.setFileInputFiles") { entered.resolve(); await pending.promise; }
    return run();
  });
  const request = f.request(); f.choosers.begin(request);
  const commit = f.choosers.commit({ ...request, files: ["C:\\private\\root"] });
  const rejected = assert.rejects(commit, /FILE_STALE/);
  await entered.promise;
  let ended = false; const ending = f.choosers.close().then(() => { ended = true; });
  pending.resolve(); await rejected;
  await until(() => ended); await ending;
  assert.equal(f.nativeWrites(), 0); assert.equal(f.objects.size, 0);
  assert.equal(f.choosers.registry.size, 0); assert.equal(f.choosers.registry.operations.size, 0);
  assert.equal(f.calls.some(row => row.method === "Page.setInterceptFileChooserDialog" && !row.params.enabled), true);
});

test("End during enumeration waits the original terminal event and cannot publish a successful receipt", async t => {
  const f = await fixture(t); f.open(); await until(() => f.choosers.info());
  const request = f.request(); f.choosers.begin(request);
  const commit = f.choosers.commit({ ...request, files: ["C:\\private\\root"] });
  const rejected = assert.rejects(commit, /FILE_STALE/);
  await until(() => f.choosers.registry.records.values().next().value?.nativeSettled);
  let ended = false; const ending = f.choosers.close().then(() => { ended = true; });
  await rejected; await tick(); assert.equal(ended, false); assert.equal(f.choosers.info(), null);
  assert.equal(f.calls.some(row => row.method === "Page.setInterceptFileChooserDialog" && !row.params.enabled), false);
  f.node.emit("input"); await ending;
  assert.equal(f.sets().length, 1); assert.equal(f.objects.size, 0);
});

test("failure after actual directory dispatch remains unknown until the original native terminal event", async t => {
  const f = await fixture(t); f.open(); await until(() => f.choosers.info());
  f.intercept(async (row, run) => {
    const result = await run();
    if (row.method === "DOM.setFileInputFiles") throw new Error("original native acknowledgement unknown");
    return result;
  });
  const request = f.request(); f.choosers.begin(request);
  const record = f.choosers.current.reservation;
  await assert.rejects(f.choosers.commit({ ...request, files: ["C:\\private\\root"] }), /acknowledgement unknown/);
  assert.equal(record.dispatched, true); assert.equal(record.nativeSettled, true);
  assert.equal(f.nativeWrites(), 1); assert.equal(record.terminal, null); assert.equal(record.cleanupDone, false);
  let ended = false; const ending = f.choosers.close().then(() => { ended = true; });
  await tick(); assert.equal(ended, false); assert.equal(f.choosers.registry.size, 1);
  assert.equal(f.calls.some(row => row.method === "Page.setInterceptFileChooserDialog" && !row.params.enabled), false);
  f.node.emit("input"); await ending;
  assert.equal(f.nativeWrites(), 1); assert.equal(f.objects.size, 0); assert.equal(f.choosers.registry.size, 0);
  assert.match(record.error.message, /acknowledgement unknown/);
});

test("ordinary files retain metadata mode checks and ACK-only completion", async t => {
  const f = await fixture(t, { directory: false, mode: "selectSingle" }); f.open(); await until(() => f.choosers.info());
  assert.equal(f.choosers.info().directory, false);
  const request = f.request(); f.choosers.begin(request);
  assert.deepEqual(await f.choosers.commit({ ...request, files: ["C:\\private\\file.txt"] }), { ...request, acknowledged: true });
  assert.equal(f.calls.some(row => row.params?.awaitPromise === true), false);
  const wrong = await fixture(t, { directory: false, mode: "selectMultiple" }); wrong.open();
  await until(() => wrong.failures.length); assert.match(wrong.failures[0].message, /mode changed/);
  assert.equal(wrong.choosers.info(), null); assert.equal(wrong.sets().length, 0);
});

import assert from "node:assert/strict";
import test from "node:test";
import vm from "node:vm";
import { DirectoryUploadRegistry, DIRECTORY_UPLOAD_WORLD, installDirectoryUploadController } from "./browser-directory-upload.js";

const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };
const tick = () => new Promise(resolve => setImmediate(resolve));
async function until(predicate) { for (let i = 0; i < 40; i++) { if (predicate()) return; await tick(); } assert.fail("Expected native stage was not reached"); }

function fixture(t, { directory = true, child = false, timeout = 1000 } = {}) {
  const context = vm.createContext({ Date, Promise, WeakMap, Map, console });
  vm.runInContext(`
    globalThis.document = { defaultView: globalThis };
    globalThis.HTMLInputElement = class {
      constructor() { this.type='file'; this.isConnected=true; this.ownerDocument=document; this.webkitdirectory=${directory}; this.multiple=false; this.files=[]; this.listeners=new Map(); }
      addEventListener(type, callback, capture) { if(capture!==true) throw Error('capture expected'); const list=this.listeners.get(type)||[];list.push(callback);this.listeners.set(type,list); }
      removeEventListener(type, callback) { this.listeners.set(type,(this.listeners.get(type)||[]).filter(value=>value!==callback)); }
      emit(type, trusted=true) { for(const callback of [...(this.listeners.get(type)||[])]) callback({type,target:this,isTrusted:trusted}); }
    };
    globalThis.node = new HTMLInputElement();
  `, context);
  const node = context.node, objects = new Map(), commands = [], registries = [];
  const attachment = {}, identity = { tabId: 7, attachment, backendNodeId: 21, frameId: "original-frame", ...(child ? { sessionId: "child-session" } : {}) };
  let serial = 0, intercept, cleanupAllowed = true, authorityError;
  function remote(value) { const objectId = `object-${++serial}`; objects.set(objectId, value); return { objectId }; }
  async function execute(target, method, params) {
    if (method === "Page.createIsolatedWorld") return { executionContextId: 3 };
    if (method === "DOM.resolveNode") return { object: remote(node) };
    if (method === "DOM.setFileInputFiles") return {};
    if (method === "Runtime.releaseObject") { objects.delete(params.objectId); return {}; }
    assert.equal(method, "Runtime.callFunctionOn");
    try {
      const receiver = objects.get(params.objectId);
      assert.ok(receiver, "Object belongs to the original remote identity");
      const fn = vm.runInContext(`(${params.functionDeclaration})`, context);
      let value = fn.apply(receiver, (params.arguments ?? []).map(item => item.value));
      if (params.awaitPromise) value = await value;
      return { result: params.returnByValue ? { value } : remote(value) };
    } catch (error) { return { exceptionDetails: { text: "Uncaught", exception: { description: String(error) } }, result: { ...remote(error), subtype: "error" } }; }
  }
  const send = (target, method, params) => {
    const command = { target, method, params }; commands.push(command);
    const run = () => execute(target, method, params);
    return intercept ? intercept(command, run) : run();
  };
  const create = options => {
    const registry = new DirectoryUploadRegistry({ send, canCleanup: () => cleanupAllowed,
      checkCurrent: () => { if (authorityError) throw authorityError; }, ...options });
    registries.push(registry); return registry;
  };
  const registry = create();
  const reserve = (owner = registry, extra = {}) => owner.reserve({ identity, scope: { session_id: "original", turn_id: "turn", control_epoch: 1 },
    deadlineAt: Date.now() + timeout, ...extra });
  t.after(() => { for (const current of registries) current.invalidate({}, new Error("test cleanup")); });
  return { registry, create, reserve, node, context, commands, objects, identity,
    intercept: fn => { intercept = fn; }, setCanCleanup: value => { cleanupAllowed = value; }, revoke: error => { authorityError = error; },
    emit: (kind, trusted = true) => node.emit(kind, trusted),
    sets: () => commands.filter(command => command.method === "DOM.setFileInputFiles") };
}

test("directory requires both the original native ACK and trusted input, ignores synthetic events", async t => {
  const f = fixture(t), record = f.reserve();
  assert.deepEqual(await f.registry.prepare(record), { directory: true, multiple: false });
  let done = false;
  const result = f.registry.submit(record, ["C:\\fixture"]).then(value => { done = true; return value; });
  await until(() => record.nativeSettled);
  assert.equal(done, false); f.emit("input", false); f.emit("change"); await tick(); assert.equal(done, false);
  f.emit("input"); assert.deepEqual(await result, {});
  assert.equal(f.sets().length, 1); assert.equal(f.registry.size, 0);
  assert.equal(f.commands[0].params.worldName, DIRECTORY_UPLOAD_WORLD);
});

test("input arriving before ACK is not early success or early local retirement", async t => {
  const f = fixture(t), hold = deferred(), record = f.reserve(); await f.registry.prepare(record);
  f.intercept((command, run) => command.method === "DOM.setFileInputFiles" ? hold.promise : run());
  let done = false; const pending = f.registry.submit(record, ["/fixture"]).then(value => { done = true; return value; });
  await until(() => f.sets().length); f.emit("input"); await until(() => record.terminal);
  assert.equal(done, false); assert.equal(f.registry.size, 1); hold.resolve({}); await pending;
  assert.equal(f.registry.size, 0);
});

test("ordinary writes and clear retain ACK-only completion and return value", async t => {
  const f = fixture(t, { directory: false }), record = f.reserve(); await f.registry.prepare(record);
  let writes = 0;
  assert.equal(await f.registry.write(record, async () => { writes++; return "original ACK"; }), "original ACK");
  assert.equal(writes, 1); assert.equal(record.terminal, null); assert.equal(f.registry.size, 0);
  const clear = f.reserve(); await f.registry.prepare(clear);
  assert.equal(await f.registry.write(clear, () => 0), 0); assert.equal(f.registry.size, 0);
});

test("same physical node cannot be reserved through another chooser or owner", async t => {
  const f = fixture(t), record = f.reserve(); await f.registry.prepare(record);
  assert.throws(() => f.reserve(f.registry, { scope: { session_id: "other", control_epoch: 2 } }), /BUSY/);
  const second = f.create(), next = f.reserve(second);
  await assert.rejects(second.prepare(next), /OBU_DIRECTORY_UPLOAD_BUSY/);
  assert.equal(f.sets().length, 0);
});

test("timeout retains uncertain directory slot; late completion only cleans the original", async t => {
  const f = fixture(t), record = f.reserve(f.registry, { deadlineAt: Date.now() + 40 }); await f.registry.prepare(record);
  const result = assert.rejects(f.registry.submit(record, ["/fixture"]), /TIMEOUT/);
  await until(() => record.nativeSettled); await result;
  assert.equal(f.registry.size, 1); assert.throws(() => f.reserve(), /BUSY/);
  const successor = f.create(), blocked = f.reserve(successor);
  await assert.rejects(successor.prepare(blocked), /OBU_DIRECTORY_UPLOAD_BUSY/);
  f.emit("input"); await until(() => f.registry.size === 0);
  assert.equal(f.sets().length, 1); assert.match(record.error.message, /TIMEOUT/);
  const allowed = f.reserve(successor); await successor.prepare(allowed); await successor.write(allowed, async () => {});
});

test("new attachment and new worker cannot bypass the renderer's pending directory guard", async t => {
  const f = fixture(t), record = f.reserve(); await f.registry.prepare(record);
  const old = assert.rejects(f.registry.submit(record, ["/fixture"]), /detached/);
  await until(() => record.nativeSettled);
  const commandCount = f.commands.length;
  f.registry.invalidate({ tabId: 7, attachment: f.identity.attachment }, new Error("detached")); await old;
  assert.equal(f.commands.length, commandCount, "detach must not clean unknown renderer work");
  const nextRegistry = f.create(), nextIdentity = { ...f.identity, attachment: {} };
  const blocked = f.reserve(nextRegistry, { identity: nextIdentity });
  await assert.rejects(nextRegistry.prepare(blocked), /OBU_DIRECTORY_UPLOAD_BUSY/);
  await until(() => nextRegistry.size === 0);
  assert.equal(blocked.controllerObjectId, undefined);
  assert.equal(blocked.remoteErrorObjectIds.size, 1);
  for (const objectId of blocked.remoteErrorObjectIds) {
    assert.equal(f.objects.has(objectId), false, "Remote Error is released after BUSY");
    assert.ok(f.commands.some(command => command.method === "Runtime.releaseObject" && command.params.objectId === objectId));
    assert.equal(f.commands.some(command => command.method === "Runtime.callFunctionOn" && command.params.objectId === objectId), false);
  }
  f.emit("input"); await tick();
  const next = f.reserve(nextRegistry, { identity: nextIdentity }); await nextRegistry.prepare(next); await nextRegistry.write(next, async () => {});
  assert.equal(f.sets().length, 1);
});

test("lost begin ACK is safely rolled back only when no native write was sent", async t => {
  const f = fixture(t), held = deferred(), record = f.reserve(f.registry, { deadlineAt: Date.now() + 40 }); await f.registry.prepare(record);
  f.intercept(async (command, run) => {
    if (command.params.functionDeclaration?.includes("this.begin(")) { const value = await run(); await held.promise; return value; }
    return run();
  });
  await assert.rejects(f.registry.submit(record, ["/fixture"]), /TIMEOUT/);
  await until(() => f.registry.size === 0); assert.equal(f.sets().length, 0);
  held.resolve(); await tick(); assert.equal(f.sets().length, 0);
  const successor = f.reserve(); await f.registry.prepare(successor); f.intercept(null); await f.registry.write(successor, async () => {});
});

test("late installation ACK cleans its own object without overwriting a successor guard", async t => {
  const f = fixture(t), held = deferred(), record = f.reserve(f.registry, { deadlineAt: Date.now() + 40 });
  f.intercept(async (command, run) => {
    if (command.params.functionDeclaration === installDirectoryUploadController.toString()) { const value = await run(); await held.promise; return value; }
    return run();
  });
  await assert.rejects(f.registry.prepare(record), /TIMEOUT/); assert.equal(f.registry.size, 1);
  f.intercept(null);
  const nextRegistry = f.create(), next = f.reserve(nextRegistry); await nextRegistry.prepare(next);
  held.resolve(); await until(() => f.registry.size === 0);
  await nextRegistry.write(next, async () => {}); assert.equal(f.sets().length, 0);
});

test("trusted cancel fails and preserves the original native error if both fail", async t => {
  const f = fixture(t), record = f.reserve(); await f.registry.prepare(record);
  const failed = assert.rejects(f.registry.submit(record, ["/missing"]), /CANCELLED/);
  await until(() => record.nativeSettled); f.emit("cancel"); await failed; await until(() => f.registry.size === 0);
  const second = f.reserve(); await f.registry.prepare(second); const original = new Error("native failed");
  f.intercept((command, run) => command.method === "DOM.setFileInputFiles" ? Promise.reject(original) : run());
  await assert.rejects(f.registry.submit(second, ["/missing"]), error => error === original);
  assert.equal(f.registry.size, 1); f.emit("cancel"); await until(() => f.registry.size === 0);
  assert.equal(second.error, original);
});

test("directory completion before navigation may await ACK; navigation before evidence fails", async t => {
  const f = fixture(t), held = deferred(), record = f.reserve(); await f.registry.prepare(record);
  f.intercept((command, run) => command.method === "DOM.setFileInputFiles" ? held.promise : run());
  const pending = f.registry.submit(record, ["/fixture"]); await until(() => f.sets().length);
  f.emit("input"); await until(() => record.terminal);
  f.registry.invalidate({ tabId: 7 }, new Error("document changed"), { document: true }); held.resolve({});
  assert.deepEqual(await pending, {});
  f.intercept(null);
  const second = f.reserve(); await f.registry.prepare(second);
  const failed = assert.rejects(f.registry.submit(second, ["/fixture"]), /document changed/);
  await until(() => f.sets().length === 2);
  f.registry.invalidate({ tabId: 7 }, new Error("document changed"), { document: true }); await failed;
  f.emit("input"); await tick(); assert.equal(f.sets().length, 2);
});

test("ordinary write preserves successful input-handler navigation", async t => {
  const f = fixture(t, { directory: false }), held = deferred(), record = f.reserve(); await f.registry.prepare(record);
  const pending = f.registry.write(record, () => held.promise); await until(() => record.dispatched);
  f.registry.invalidate({ tabId: 7 }, new Error("navigation"), { document: true }); held.resolve("done");
  assert.equal(await pending, "done");
});

test("navigation never removes the caller deadline while its dispatched ACK is pending", async t => {
  for (const directory of [true, false]) {
    const f = fixture(t, { directory }), held = deferred();
    const record = f.reserve(f.registry, { deadlineAt: Date.now() + 40 }); await f.registry.prepare(record);
    f.intercept((command, run) => command.method === "DOM.setFileInputFiles" ? held.promise : run());
    const operation = directory ? f.registry.submit(record, ["/fixture"]) : f.registry.write(record, () => held.promise);
    const failed = assert.rejects(operation, /TIMEOUT/);
    await until(() => record.dispatched);
    if (directory) { f.emit("input"); await until(() => record.terminal); }
    f.registry.invalidate({ tabId: 7 }, new Error("navigation"), { document: true });
    assert.equal(f.registry.size, 0); await failed;
    held.resolve({}); await tick(); assert.match(record.error.message, /TIMEOUT/);
  }
});

test("invalidation cannot start old remote cleanup even when its previous identity hook still returns true", async t => {
  const f = fixture(t), record = f.reserve(); await f.registry.prepare(record);
  const commandCount = f.commands.length;
  f.registry.invalidate({ tabId: 7 }, new Error("detached")); await tick();
  assert.equal(f.commands.length, commandCount); assert.equal(f.registry.size, 0);
});

test("revocation after dispatch rejects, retaining unknown native directory state", async t => {
  const f = fixture(t), record = f.reserve(); await f.registry.prepare(record);
  const original = new Error("paused"); const pending = assert.rejects(f.registry.submit(record, ["/fixture"]), error => error === original);
  await until(() => record.nativeSettled); f.registry.cancelWhere(() => true, original); await pending;
  assert.equal(f.registry.size, 1); f.emit("input"); await until(() => f.registry.size === 0);
});

test("observation failure is not ACK success and keeps the physical guard", async t => {
  const f = fixture(t), record = f.reserve(); await f.registry.prepare(record);
  f.intercept((command, run) => command.params.awaitPromise ? Promise.resolve({ exceptionDetails: { text: "context lost" } }) : run());
  await assert.rejects(f.registry.submit(record, ["/fixture"]), /completion evidence/);
  assert.equal(f.registry.size, 1); assert.equal(f.sets().length, 1);
});

test("unavailable cleanup does not cache a fulfilled promise or silently succeed", async t => {
  const f = fixture(t, { directory: false }), record = f.reserve(); await f.registry.prepare(record); f.setCanCleanup(false);
  await assert.rejects(f.registry.write(record, async () => {}), /CLEANUP_FAILED/);
  assert.equal(record.cleanupPromise, undefined); assert.equal(f.registry.size, 1);
  f.setCanCleanup(true); await f.registry.cleanup(record); await tick(); assert.equal(f.registry.size, 0);
});

test("cleanup error is visible without replacing an original write error", async t => {
  const f = fixture(t, { directory: false }), record = f.reserve(); await f.registry.prepare(record);
  const cleanupError = new Error("release failed"), original = new Error("original write");
  f.intercept((command, run) => command.method === "Runtime.releaseObject" ? Promise.reject(cleanupError) : run());
  await assert.rejects(f.registry.write(record, async () => { throw original; }), error => error === original);
  await until(() => record.cleanupError); assert.equal(record.cleanupError, cleanupError); assert.equal(record.error, original);
  assert.equal(f.registry.size, 1);
});

test("OOPIF preparation and mutation keep exact target/context/node identity", async t => {
  const f = fixture(t, { child: true }), record = f.reserve(); await f.registry.prepare(record);
  const result = f.registry.submit(record, ["C:\\directory"]); await until(() => record.nativeSettled); f.emit("input"); await result;
  for (const command of f.commands) assert.deepEqual(command.target, { tabId: 7, sessionId: "child-session" });
  assert.deepEqual(f.commands.find(command => command.method === "DOM.resolveNode").params, { backendNodeId: 21, executionContextId: 3 });
  assert.equal(f.commands[0].params.frameId, "original-frame");
});

test("bounded reservations reject overflow and directory invalid paths never dispatch", async t => {
  const f = fixture(t), limited = f.create({ maxTotal: 1 }), first = f.reserve(limited);
  assert.throws(() => f.reserve(limited, { identity: { ...f.identity, backendNodeId: 22 } }), /LIMIT/);
  limited.cancel(first); await until(() => limited.size === 0);
  for (const paths of [[], ["relative"], ["C:relative"], ["/one", "/two"], ["/a\0b"]]) {
    const record = f.reserve(); await f.registry.prepare(record);
    await assert.rejects(f.registry.submit(record, paths), /exactly one absolute/);
    await until(() => f.registry.size === 0);
  }
  assert.equal(f.sets().length, 0);
});

test("renderer rejects wrong original node and directory property changes before dispatch", async t => {
  const f = fixture(t), first = f.reserve(); f.node.type = "text";
  await assert.rejects(f.registry.prepare(first), /guard could not be installed/); await until(() => f.registry.size === 0);
  f.node.type = "file"; const second = f.reserve(); await f.registry.prepare(second); f.node.webkitdirectory = false;
  await assert.rejects(f.registry.submit(second, ["/fixture"]), /admission failed/); await until(() => f.registry.size === 0);
  assert.equal(f.sets().length, 0);
});

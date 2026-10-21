import assert from "node:assert/strict";
import test from "node:test";
import { installManagedOopifBfcacheObserver, originalManagedOopifNativeIdentity, assessManagedOopifNativeReturn } from "./managed-oopif-bfcache-check.mjs";

const urls = { root: "http://127.0.0.1:50000/root", leaf: "http://localhost:50000/leaf" };
const originals = () => ({ overflow: false, events: [
  { sequence: 1, source: { tabId: 42 }, method: "Page.frameNavigated", params: { frame: { id: "root", loaderId: "root-loader", url: urls.root }, type: "Navigation" } },
  { sequence: 2, source: { tabId: 42 }, method: "Target.attachedToTarget", params: { sessionId: "leaf-session", targetInfo: { type: "iframe", targetId: "leaf", url: "" }, waitingForDebugger: false } },
  { sequence: 3, source: { tabId: 42, sessionId: "leaf-session" }, method: "Page.frameNavigated", params: { frame: { id: "leaf", parentId: "root", loaderId: "leaf-loader", url: urls.leaf }, type: "Navigation" } }
] });

test("observer retains native arrival order and full session fields without sending commands", () => {
  const listeners = new Set(), target = {};
  const chrome = { debugger: { sendCommand() { throw Error("Must not send"); }, onEvent: { addListener: fn => listeners.add(fn), removeListener: fn => listeners.delete(fn), hasListener: fn => listeners.has(fn) } } };
  const ready = installManagedOopifBfcacheObserver(chrome, target); assert.equal(ready.installed, true); assert.equal(listeners.size, 1);
  const emit = (...args) => [...listeners][0](...args);
  emit({ tabId: 42 }, "Network.dataReceived", { body: "not retained" });
  const source = { tabId: 42, sessionId: "outer" }, params = { sessionId: "inner", targetInfo: { type: "iframe", targetId: "leaf", url: "" }, waitingForDebugger: false };
  emit(source, "Target.attachedToTarget", params);
  params.targetInfo.targetId = "mutated"; source.sessionId = "mutated";
  emit({ tabId: 42 }, "Page.frameNavigated", { type: "BackForwardCacheRestore", frame: { id: "root", loaderId: "original" } });
  emit({ tabId: 42, sessionId: "outer" }, "Target.detachedFromTarget", { sessionId: "inner", targetId: "leaf" });
  const observed = target.__managedOopifBfcacheObservation.snapshot();
  assert.deepEqual(observed.events.map(row => row.sequence), [1, 2, 3]);
  assert.equal(observed.events[0].source.sessionId, "outer"); assert.equal(observed.events[0].params.targetInfo.targetId, "leaf");
  assert.equal(observed.events[1].params.type, "BackForwardCacheRestore"); assert.equal(observed.events[2].params.sessionId, "inner");
  observed.events.length = 0; assert.equal(target.__managedOopifBfcacheObservation.snapshot().events.length, 3);
  assert.throws(() => installManagedOopifBfcacheObserver(chrome, target), /already installed/);
  const stopped = target.__managedOopifBfcacheObservation.stop();
  assert.equal(stopped.stopped, true); assert.equal(stopped.listenerPresent, false); assert.equal(stopped.sendCommandRestored, true);
  assert.deepEqual(stopped.commands, []); assert.deepEqual(stopped.observationErrors, []);
  assert.equal(listeners.size, 0);
});

test("observer overflow remains explicit instead of silently claiming a complete native trace", () => {
  let listener; const target = {};
  installManagedOopifBfcacheObserver({ debugger: { sendCommand() {}, onEvent: { addListener: fn => { listener = fn; }, removeListener() {}, hasListener: () => false } } }, target);
  for (let index = 0; index <= 2048; index++) listener({ tabId: 42 }, "Runtime.executionContextsCleared", {});
  const observed = target.__managedOopifBfcacheObservation.snapshot(); assert.equal(observed.events.length, 2048); assert.equal(observed.overflow, true);
  assert.throws(() => originalManagedOopifNativeIdentity(observed, 42, urls));
});

function commandObserver(original) {
  const listeners = new Set(), target = {}, chrome = { debugger: { sendCommand: original,
    onEvent: { addListener: fn => listeners.add(fn), removeListener: fn => listeners.delete(fn), hasListener: fn => listeners.has(fn) } } };
  const descriptor = Object.getOwnPropertyDescriptor(chrome.debugger, "sendCommand");
  installManagedOopifBfcacheObserver(chrome, target);
  return { chrome, observer: target.__managedOopifBfcacheObservation, descriptor, listeners };
}

test("native command wrapper preserves original Promise, this, args and immediate return", async () => {
  let resolve; const originalPromise = new Promise(done => { resolve = done; }), calls = [];
  const f = commandObserver(function (...args) { calls.push({ receiver: this, args }); return originalPromise; });
  const receiver = { marker: "original receiver" }, target = { tabId: 7, sessionId: "child" }, params = { enabled: true };
  const returned = Reflect.apply(f.chrome.debugger.sendCommand, receiver, [target, "Page.setLifecycleEventsEnabled", params]);
  assert.equal(returned, originalPromise); assert.equal(calls.length, 1); assert.equal(calls[0].receiver, receiver);
  assert.equal(calls[0].args[0], target); assert.equal(calls[0].args[2], params);
  assert.equal(f.observer.snapshot().commands[0].state, "pending", "No waiting, replacement promise or synthetic ACK");
  const emit = (...args) => [...f.listeners][0](...args);
  emit({ tabId: 7 }, "Page.frameNavigated", { type: "BackForwardCacheRestore", frame: { id: "root" } });
  const result = { original: true }; resolve(result); assert.equal(await returned, result);
  emit({ tabId: 7 }, "Page.lifecycleEvent", { name: "load", frameId: "root" });
  const row = f.observer.snapshot().commands[0]; assert.equal(row.state, "fulfilled"); assert.equal(row.enabled, true);
  assert.deepEqual([row.startedOrder, f.observer.snapshot().events[0].observedOrder, row.settledOrder, f.observer.snapshot().events[1].observedOrder], [1, 2, 3, 4]);
  assert.deepEqual(f.observer.snapshot().events.map(event => event.sequence), [1, 2], "Shared ordering preserves native event sequence");
  assert.deepEqual(row.target, target); assert.equal(row.returnKind, "promise"); assert.ok(row.settledAt >= row.startedAt);
  const stop = f.observer.stop(); assert.equal(stop.sendCommandRestored, true); assert.deepEqual(stop.pendingAtStop, []);
  assert.deepEqual(Object.getOwnPropertyDescriptor(f.chrome.debugger, "sendCommand"), f.descriptor);
});

test("native command wrapper preserves synchronous object/value and exact thrown error identities", () => {
  const value = { original: "sync value" }, thrown = new Error("original sync failure"); let calls = 0;
  const f = commandObserver(function (_target, method) { calls++; if (method === "throw") throw thrown; return method === "value" ? value : 17; });
  assert.equal(f.chrome.debugger.sendCommand({ tabId: 7 }, "value"), value);
  assert.equal(f.chrome.debugger.sendCommand({ tabId: 7 }, "number"), 17);
  assert.throws(() => f.chrome.debugger.sendCommand({ tabId: 7 }, "throw"), error => error === thrown);
  assert.equal(calls, 3); assert.deepEqual(f.observer.snapshot().commands.map(row => row.state), ["returned", "returned", "threw"]);
  assert.equal(f.observer.snapshot().commands[2].error.message, thrown.message);
  assert.deepEqual(f.observer.stop().observationErrors, []);
});

test("native rejection retains its original Promise and error, without an observer rejection", async () => {
  const failure = new Error("original rejected command"), promise = Promise.reject(failure); let calls = 0;
  const f = commandObserver(() => { calls++; return promise; });
  const returned = f.chrome.debugger.sendCommand({ tabId: 7, sessionId: "child" }, "Page.enable");
  assert.equal(returned, promise); await assert.rejects(returned, error => error === failure);
  assert.equal(calls, 1); assert.equal(f.observer.snapshot().commands[0].state, "rejected");
  assert.deepEqual(f.observer.stop().observationErrors, []);
});

test("command projection records only frame identity tree and lifecycle flag, never script/input payloads", async () => {
  const result = { frameTree: { frame: { id: "root", loaderId: "root-loader", url: "secret URL" }, childFrames: [{ frame: { id: "child", parentId: "root", loaderId: "child-loader", securityOrigin: "secret origin" } }] } };
  const f = commandObserver(() => Promise.resolve(result));
  assert.equal(await f.chrome.debugger.sendCommand({ tabId: 7 }, "Page.getFrameTree", { script: "PRIVATE_SCRIPT" }), result);
  await f.chrome.debugger.sendCommand({ tabId: 7 }, "Runtime.evaluate", { expression: "PRIVATE_SCRIPT" });
  await f.chrome.debugger.sendCommand({ tabId: 7 }, "Input.insertText", { text: "PRIVATE_INPUT" });
  const trace = f.observer.stop();
  assert.deepEqual(trace.commands[0].frameTree, { frame: { id: "root", loaderId: "root-loader" }, childFrames: [{ frame: { id: "child", parentId: "root", loaderId: "child-loader" } }] });
  assert.doesNotMatch(JSON.stringify(trace), /PRIVATE_|secret/);
  assert.equal(trace.commands.length, 3);
});

test("observer projection failure never blocks original send and cannot look successful", () => {
  let calls = 0; const value = { original: true }, f = commandObserver(() => { calls++; return value; });
  const target = new Proxy({}, { getOwnPropertyDescriptor() { throw Error("synthetic observation failure"); } });
  assert.equal(f.chrome.debugger.sendCommand(target, "Runtime.enable"), value);
  assert.equal(calls, 1); assert.equal(f.observer.snapshot().observationErrors[0].phase, "command-start");
  assert.equal(f.observer.stop().sendCommandRestored, true);
});

test("bounded command observation never suppresses native calls", () => {
  let calls = 0; const f = commandObserver(() => { calls++; return undefined; });
  for (let index = 0; index < 1025; index++) f.chrome.debugger.sendCommand({ tabId: 7 }, "Runtime.enable");
  assert.equal(calls, 1025); const stopped = f.observer.stop(); assert.equal(stopped.commands.length, 1024); assert.equal(stopped.overflow, true);
});

test("stop preserves an external replacement and reports unresolved or late settlements explicitly", async () => {
  let resolve; const promise = new Promise(done => { resolve = done; }), original = () => promise;
  const f = commandObserver(original), wrapper = f.chrome.debugger.sendCommand;
  assert.equal(wrapper({ tabId: 7 }, "Runtime.enable"), promise);
  const replacement = () => "new owner"; f.chrome.debugger.sendCommand = replacement;
  const stopped = f.observer.stop(); assert.equal(stopped.sendCommandRestored, false); assert.deepEqual(stopped.pendingAtStop, [1]);
  assert.equal(stopped.observationErrors[0].phase, "command-observer-stop"); assert.equal(f.chrome.debugger.sendCommand, replacement);
  const before = JSON.stringify(stopped.commands); resolve({}); await promise; await Promise.resolve();
  assert.equal(JSON.stringify(f.observer.snapshot().commands), before, "Late ACK cannot mutate exported terminal command evidence");
  assert.equal(f.observer.snapshot().commands[0].state, "pending");
});

test("cross-origin URL requires matching original attached iframe target and session", () => {
  const before = originals(), identity = originalManagedOopifNativeIdentity(before, 42, urls);
  assert.deepEqual(identity.leaf, { frameId: "leaf", loaderId: "leaf-loader", sessionId: "leaf-session", targetId: "leaf", origin: "http://localhost:50000", eventSequence: 3, attachSequence: 2 });
  const missing = originals(); missing.events.splice(1, 1); assert.throws(() => originalManagedOopifNativeIdentity(missing, 42, urls), /OOPIF/);
  const wrong = originals(); wrong.events[1].params.targetInfo.targetId = "different"; assert.throws(() => originalManagedOopifNativeIdentity(wrong, 42, urls));
  assert.throws(() => originalManagedOopifNativeIdentity(before, 43, urls), /root/);
});

test("return evidence distinguishes native BFCache restore from reload and keeps early child contexts", () => {
  const before = originals(), identity = originalManagedOopifNativeIdentity(before, 42, urls);
  const after = structuredClone(before); after.events.push(
    { sequence: 4, source: { tabId: 42 }, method: "Target.attachedToTarget", params: { sessionId: "restored-leaf", targetInfo: { type: "iframe", targetId: "leaf" } } },
    { sequence: 5, source: { tabId: 42, sessionId: "restored-leaf" }, method: "Runtime.executionContextCreated", params: { context: { id: 11, uniqueId: "context", origin: "http://localhost:50000", auxData: { frameId: "leaf", isDefault: true } } } },
    { sequence: 6, source: { tabId: 42 }, method: "Page.frameNavigated", params: { type: "BackForwardCacheRestore", frame: { id: "root", loaderId: "root-loader" } } }
  );
  // The original iframe session must actually detach before the new owner can
  // be considered unique. A stale live sibling is not silently ignored.
  after.events.splice(3, 0, { sequence: 3.5, source: { tabId: 42 }, method: "Target.detachedFromTarget", params: { sessionId: "leaf-session" } });
  const proof = assessManagedOopifNativeReturn(after, identity, 3); assert.equal(proof.originalRootRestoreVerified, true);
  assert.equal(proof.restoredOopifContextVerified, true); assert.equal(proof.restoredLeafFrameLoaderVerified, false);
  assert.deepEqual(proof.notObserved, ["returned-leaf-native-frame-loader-parent"]);
  assert.equal(proof.leafAttachments[0].sequence, 4); assert.equal(proof.leafContexts[0].sequence, 5); assert.equal(proof.rootRestore.sequence, 6);
  const reloaded = structuredClone(after); reloaded.events.at(-1).params.type = "Navigation"; assert.equal(assessManagedOopifNativeReturn(reloaded, identity, 3).originalRootRestoreVerified, false);
  const changedLoader = structuredClone(after); changedLoader.events.at(-1).params.frame.loaderId = "different"; assert.equal(assessManagedOopifNativeReturn(changedLoader, identity, 3).originalRootRestoreVerified, false);
  assert.equal(assessManagedOopifNativeReturn(after, identity, 6).originalRootRestoreVerified, false);
});

test("retained original child session does not require a manufactured attach event", () => {
  const before = originals(), identity = originalManagedOopifNativeIdentity(before, 42, urls);
  before.events.push({ sequence: 4, source: { tabId: 42, sessionId: "leaf-session" }, method: "Runtime.executionContextCreated", params: { context: { id: 7, uniqueId: "original-context", origin: "http://localhost:50000", auxData: { frameId: "leaf", isDefault: true } } } });
  before.events.push({ sequence: 5, source: { tabId: 42 }, method: "Page.frameNavigated", params: { type: "BackForwardCacheRestore", frame: { id: "root", loaderId: "root-loader" } } });
  const proof = assessManagedOopifNativeReturn(before, identity, 3);
  assert.equal(proof.originalRootRestoreVerified, true); assert.equal(proof.restoredOopifContextVerified, true); assert.deepEqual(proof.leafAttachments, []);
  for (const [method, params] of [["Target.detachedFromTarget", { sessionId: "leaf-session" }], ["Runtime.executionContextsCleared", {}], ["Runtime.executionContextDestroyed", { executionContextId: 7 }], ["Runtime.executionContextDestroyed", { executionContextUniqueId: "original-context" }]]) {
    const invalidated = structuredClone(before); invalidated.events.push({ sequence: 6, source: { tabId: 42, sessionId: "leaf-session" }, method, params });
    assert.equal(assessManagedOopifNativeReturn(invalidated, identity, 3).restoredOopifContextVerified, false, method);
  }
  const foreignDestroy = structuredClone(before); foreignDestroy.events.push({ sequence: 6, source: { tabId: 42, sessionId: "another-session" }, method: "Runtime.executionContextDestroyed", params: { executionContextId: 7 } });
  assert.equal(assessManagedOopifNativeReturn(foreignDestroy, identity, 3).restoredOopifContextVerified, true);
});

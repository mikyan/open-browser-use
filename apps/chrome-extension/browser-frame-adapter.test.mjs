import assert from "node:assert/strict";
import { test } from "node:test";
import { observeCrxFrameMessage, prepareCrxChildFrame, refreshCrxCachedLifecycle } from "./browser-frame-adapter.js";

function fixture() {
  const events = [];
  const transport = {
    _tabToTarget: new Map([[7, {}]]),
    _sessions: new Map([["child-session", 7]]),
    getTargetId: tabId => tabId === 7 ? "root-frame" : undefined,
    _emitMessage(message) { observeCrxFrameMessage(this, message); events.push(message); }
  };
  observeCrxFrameMessage(transport, { method: "Page.getFrameTree", sessionId: "crx-tab-7", result: { frameTree: { frame: { id: "root-frame" } } } });
  const parent = { tabId: 7, sessionId: "crx-tab-7" };
  const event = { sessionId: "child-session", targetInfo: { type: "iframe", targetId: "child-frame" } };
  const tree = { frameTree: { frame: { id: "child-frame", parentId: "root-frame" } } };
  return { transport, events, parent, event, tree };
}

test("BFCache restoration requests real lifecycle state only from its owned session", async () => {
  const f = fixture(), calls = [];
  const send = async (...args) => { calls.push(args); return { frameTree: { frame: event.params.frame } }; };
  const event = { method: "Page.frameNavigated", sessionId: "crx-tab-7", params: { type: "BackForwardCacheRestore", frame: { id: "root-frame", loaderId: "original-loader" } } };
  observeCrxFrameMessage(f.transport, event);
  await refreshCrxCachedLifecycle(f.transport, event, send);
  assert.deepEqual(calls, [[{ tabId: 7 }, "Page.getFrameTree"], [{ tabId: 7 }, "Page.setLifecycleEventsEnabled", { enabled: true }]]);
  await refreshCrxCachedLifecycle(f.transport, { ...event, params: { ...event.params, type: "Navigation" } }, send);
  await refreshCrxCachedLifecycle(f.transport, { ...event, sessionId: "crx-tab-99" }, send);
  await refreshCrxCachedLifecycle(f.transport, { ...event, sessionId: "foreign-session" }, send);
  assert.equal(calls.length, 2);
  assert.deepEqual(f.events, [], "no lifecycle events are synthesized");
});

function cachedFixture() {
  const f = fixture();
  f.restore = { method: "Page.frameNavigated", sessionId: "crx-tab-7", params: { type: "BackForwardCacheRestore", frame: { id: "root-frame", loaderId: "original-loader" } } };
  f.cachedTree = { frameTree: { frame: f.restore.params.frame, childFrames: [{ frame: { id: "restored-child", parentId: "root-frame", loaderId: "child-loader", url: "https://original.test/child" } }] } };
  f.context = { method: "Runtime.executionContextCreated", sessionId: "crx-tab-7", params: { context: { id: 7, uniqueId: "original-context", name: "utility", auxData: { frameId: "restored-child", isDefault: false } } } };
  observeCrxFrameMessage(f.transport, f.context);
  observeCrxFrameMessage(f.transport, f.restore);
  return f;
}

test("BFCache repairs only native missing children before binding their still-live original contexts", async () => {
  const f = cachedFixture(), calls = [];
  await refreshCrxCachedLifecycle(f.transport, f.restore, async (target, method, params) => {
    calls.push({ target, method, params });
    if (method === "Page.getFrameTree") return f.cachedTree;
    assert.deepEqual(f.events.map(row => row.method), ["Page.frameAttached", "Page.frameNavigated", "Runtime.executionContextCreated"]);
  });
  assert.deepEqual(calls.map(row => row.method), ["Page.getFrameTree", "Page.setLifecycleEventsEnabled"]);
  assert.deepEqual(f.events[1].params.frame, f.cachedTree.frameTree.childFrames[0].frame);
  assert.equal(f.events[2], f.context, "Replay the exact original native payload, never a guessed context");
});

test("BFCache tree reads cannot resurrect destroyed contexts or cross navigation/attachment changes", async () => {
  for (const change of ["destroy", "clear", "navigate", "child-detach", "reattach", "wrong-loader"]) {
    const f = cachedFixture(); let resolve; const methods = [];
    const pending = refreshCrxCachedLifecycle(f.transport, f.restore, async (target, method) => {
      methods.push(method); if (method === "Page.getFrameTree") return new Promise(done => { resolve = done; });
    });
    assert.equal(typeof resolve, "function");
    if (change === "destroy") observeCrxFrameMessage(f.transport, { method: "Runtime.executionContextDestroyed", sessionId: "crx-tab-7", params: { executionContextId: 7 } });
    if (change === "clear") observeCrxFrameMessage(f.transport, { method: "Runtime.executionContextsCleared", sessionId: "crx-tab-7", params: {} });
    if (change === "navigate") observeCrxFrameMessage(f.transport, { ...f.restore, params: { frame: { id: "root-frame", loaderId: "successor" } } });
    if (change === "child-detach") observeCrxFrameMessage(f.transport, { method: "Page.frameDetached", sessionId: "crx-tab-7", params: { frameId: "restored-child", reason: "remove" } });
    if (change === "reattach") f.transport._tabToTarget.set(7, {});
    if (change === "wrong-loader") f.cachedTree.frameTree.frame = { id: "root-frame", loaderId: "successor" };
    resolve(f.cachedTree); await pending;
    if (["destroy", "clear"].includes(change)) assert.deepEqual(f.events.map(row => row.method), ["Page.frameAttached", "Page.frameNavigated"]);
    else { assert.deepEqual(f.events, [], change); assert.deepEqual(methods, ["Page.getFrameTree"], change); }
  }
});

test("late OOPIF repair uses only the owned child session's real frame identity", async () => {
  const { transport, events, parent, event, tree } = fixture();
  let reads = 0;
  const send = async (target, method) => {
    assert.deepEqual(target, { tabId: 7, sessionId: "child-session" });
    assert.equal(method, "Page.getFrameTree"); reads++; return tree;
  };
  await prepareCrxChildFrame(transport, parent, event, send);
  assert.deepEqual(events, [{ method: "Page.frameAttached", sessionId: "crx-tab-7", params: { frameId: "child-frame", parentFrameId: "root-frame" } }]);
  await prepareCrxChildFrame(transport, parent, event, send);
  assert.equal(reads, 1, "known frames must not be queried or replayed");
});

test("normally observed frames and foreign sessions never need a repair query", async () => {
  for (const known of [true, false]) {
    const { transport, parent, event } = fixture();
    if (known) observeCrxFrameMessage(transport, { method: "Page.frameAttached", sessionId: parent.sessionId, params: { frameId: "child-frame", parentFrameId: "root-frame" } });
    else transport._sessions.set("child-session", 8);
    await prepareCrxChildFrame(transport, parent, event, () => { throw new Error("Must not query"); });
  }
});

test("detach, navigation, or an intervening native attachment invalidates a pending repair", async () => {
  for (const invalidate of [
    f => f.transport._sessions.delete("child-session"),
    f => observeCrxFrameMessage(f.transport, { method: "Target.detachedFromTarget", sessionId: "", params: { sessionId: f.parent.sessionId } }),
    f => observeCrxFrameMessage(f.transport, { method: "Page.frameNavigated", sessionId: f.parent.sessionId, params: { frame: { id: "root-frame", url: "https://new.test" } } }),
    f => observeCrxFrameMessage(f.transport, { method: "Page.frameAttached", sessionId: f.parent.sessionId, params: { frameId: "child-frame", parentFrameId: "root-frame" } })
  ]) {
    const f = fixture();
    let resolve;
    const pending = prepareCrxChildFrame(f.transport, f.parent, f.event, () => new Promise(done => { resolve = done; }));
    invalidate(f); resolve(f.tree); await pending;
    assert.deepEqual(f.events, []);
  }
});

test("frame replacement removes descendants and accepts the new native frame, never a guessed parent", async () => {
  const f = fixture();
  await prepareCrxChildFrame(f.transport, f.parent, f.event, async () => f.tree);
  observeCrxFrameMessage(f.transport, { method: "Page.frameAttached", sessionId: f.parent.sessionId, params: { frameId: "nested", parentFrameId: "child-frame" } });
  observeCrxFrameMessage(f.transport, { method: "Page.frameDetached", sessionId: f.parent.sessionId, params: { frameId: "child-frame", reason: "remove" } });
  f.events.length = 0;
  await prepareCrxChildFrame(f.transport, f.parent, f.event, async () => ({ frameTree: { frame: { id: "child-frame", parentId: "nested" } } }));
  assert.deepEqual(f.events, []);
  await prepareCrxChildFrame(f.transport, f.parent, f.event, async () => f.tree);
  assert.equal(f.events.length, 1);
});

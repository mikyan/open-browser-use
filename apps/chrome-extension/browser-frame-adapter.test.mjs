import assert from "node:assert/strict";
import { test } from "node:test";
import { observeCrxFrameMessage, prepareCrxChildFrame, refreshCrxCachedLifecycle, bindCrxChildFrameSession, finishCrxFrameMessage, getCrxChildFrameAdmission } from "./browser-frame-adapter.js";

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

function remoteFixture() {
  const f = fixture();
  f.tree.frameTree.frame.loaderId = "original-child-loader";
  f.restore = { method: "Page.frameNavigated", sessionId: f.parent.sessionId, params: {
    type: "BackForwardCacheRestore", frame: { id: "root-frame", loaderId: "original-root-loader" }
  } };
  f.rootTree = { frameTree: { frame: f.restore.params.frame } };
  f.context = { method: "Runtime.executionContextCreated", sessionId: "child-session", params: {
    context: { id: 9, uniqueId: "original-child-context", auxData: { frameId: "child-frame", isDefault: true } }
  } };
  f.restores = []; f.commands = []; f.deliveries = 0;
  f.controller = { isCurrent: () => true, initialFrameCurrent: () => true,
    restore: tree => { f.restores.push(tree); return Promise.resolve(); } };
  f.deliver = () => {
    f.deliveries++;
    const message = { method: "Target.attachedToTarget", sessionId: f.parent.sessionId, params: f.event };
    observeCrxFrameMessage(f.transport, message);
    Promise.resolve().then(() => bindCrxChildFrameSession(f.transport, f.parent.sessionId, f.event, f.controller));
    finishCrxFrameMessage(f.transport, message);
  };
  f.send = async (target, method) => {
    f.commands.push({ target, method });
    return method === "Page.getFrameTree" ? target.sessionId ? f.tree : f.rootTree : {};
  };
  return f;
}

test("BFCache rebinds an already delivered child without another Target attachment", async () => {
  const f = remoteFixture();
  await prepareCrxChildFrame(f.transport, f.parent, f.event, async () => f.tree);
  f.deliver(); await Promise.resolve();
  observeCrxFrameMessage(f.transport, f.context);
  observeCrxFrameMessage(f.transport, f.restore);
  f.events.length = 0;
  await refreshCrxCachedLifecycle(f.transport, f.restore, f.send);
  assert.equal(f.deliveries, 1); assert.deepEqual(f.restores, [f.tree.frameTree]);
  assert.deepEqual(f.events, [f.context], "Only the original live child context is rebound");
  assert.deepEqual(f.commands.map(row => [row.target.sessionId, row.method]), [
    [undefined, "Page.getFrameTree"], ["child-session", "Page.getFrameTree"],
    ["child-session", "Page.setLifecycleEventsEnabled"], [undefined, "Page.setLifecycleEventsEnabled"]
  ]);
});

test("BFCache joins the original late Target delivery when its preparation crossed the root restore", async () => {
  const f = remoteFixture(); let settle;
  const preparing = prepareCrxChildFrame(f.transport, f.parent, f.event, () => new Promise(resolve => { settle = resolve; }));
  observeCrxFrameMessage(f.transport, f.restore);
  const restoring = refreshCrxCachedLifecycle(f.transport, f.restore, f.send);
  await Promise.resolve(); assert.deepEqual(f.restores, []);
  settle(f.tree); await preparing;
  assert.deepEqual(f.events, [], "The stale preparation did not attach to the successor graph");
  f.deliver(); await restoring;
  assert.equal(f.deliveries, 1); assert.deepEqual(f.restores, [f.tree.frameTree]);
});

test("BFCache cannot revive retired sessions, attachments, documents or destroyed child contexts", async () => {
  for (const change of ["detach", "root-detach", "attachment", "navigate", "child-navigation", "destroy", "clear", "foreign-destroy"]) {
    const f = remoteFixture();
    await prepareCrxChildFrame(f.transport, f.parent, f.event, async () => f.tree);
    f.deliver(); await Promise.resolve(); observeCrxFrameMessage(f.transport, f.context);
    observeCrxFrameMessage(f.transport, f.restore); f.events.length = 0;
    let settle;
    const restoring = refreshCrxCachedLifecycle(f.transport, f.restore, async (target, method) => {
      if (target.sessionId && method === "Page.getFrameTree") return new Promise(resolve => { settle = resolve; });
      return f.send(target, method);
    });
    while (!settle) await Promise.resolve();
    if (change === "detach") observeCrxFrameMessage(f.transport, { method: "Target.detachedFromTarget", sessionId: f.parent.sessionId, params: { sessionId: "child-session" } });
    if (change === "root-detach") observeCrxFrameMessage(f.transport, { method: "Target.detachedFromTarget", sessionId: "", params: { sessionId: f.parent.sessionId } });
    if (change === "attachment") f.transport._tabToTarget.set(7, {});
    if (change === "navigate") observeCrxFrameMessage(f.transport, { ...f.restore, params: { type: "Navigation", frame: { id: "root-frame", loaderId: "successor" } } });
    if (change === "child-navigation") observeCrxFrameMessage(f.transport, { method: "Page.frameNavigated", sessionId: "child-session", params: { frame: { id: "child-frame", parentId: "root-frame", loaderId: "successor" } } });
    if (change === "clear") observeCrxFrameMessage(f.transport, { method: "Runtime.executionContextsCleared", sessionId: "child-session", params: {} });
    if (["destroy", "foreign-destroy"].includes(change)) observeCrxFrameMessage(f.transport, { method: "Runtime.executionContextDestroyed", sessionId: change === "destroy" ? "child-session" : f.parent.sessionId, params: { executionContextId: 9 } });
    settle(f.tree); await restoring;
    if (["destroy", "clear", "foreign-destroy"].includes(change)) {
      assert.equal(f.restores.length, 1); assert.deepEqual(f.events, change === "foreign-destroy" ? [f.context] : [], change);
    } else { assert.deepEqual(f.restores, [], change); assert.deepEqual(f.events, [], change); }
  }
});

test("child navigation during original initialization prevents late context replay and lifecycle delivery", async () => {
  const f = remoteFixture(); let settle, started;
  const initializing = new Promise(resolve => { started = resolve; });
  f.controller.restore = tree => { f.restores.push(tree); started(); return new Promise(resolve => { settle = resolve; }); };
  await prepareCrxChildFrame(f.transport, f.parent, f.event, async () => f.tree);
  f.deliver(); await Promise.resolve(); observeCrxFrameMessage(f.transport, f.context);
  observeCrxFrameMessage(f.transport, f.restore); f.events.length = 0;
  const restoring = refreshCrxCachedLifecycle(f.transport, f.restore, f.send);
  await initializing;
  observeCrxFrameMessage(f.transport, { method: "Page.frameNavigated", sessionId: "child-session", params: { frame: { id: "child-frame", parentId: "root-frame", loaderId: "replacement" } } });
  settle(); await restoring;
  assert.deepEqual(f.events, []);
  assert.ok(f.commands.every(row => row.method === "Page.getFrameTree"));
});

test("the original child admission cannot be borrowed after retirement or by another event/parent", async () => {
  for (const change of ["detach", "remove", "attachment", "navigation"]) {
    const f = remoteFixture();
    await prepareCrxChildFrame(f.transport, f.parent, f.event, async () => f.tree);
    const admission = getCrxChildFrameAdmission(f.transport, f.parent.sessionId, f.event); assert.equal(admission(), true);
    assert.equal(getCrxChildFrameAdmission(f.transport, "foreign-parent", f.event), null);
    assert.equal(getCrxChildFrameAdmission(f.transport, f.parent.sessionId, { ...f.event }), null);
    if (change === "detach") observeCrxFrameMessage(f.transport, { method: "Target.detachedFromTarget", sessionId: f.parent.sessionId, params: { sessionId: "child-session" } });
    if (change === "remove") observeCrxFrameMessage(f.transport, { method: "Page.frameDetached", sessionId: f.parent.sessionId, params: { frameId: "child-frame", reason: "remove" } });
    if (change === "attachment") f.transport._tabToTarget.set(7, {});
    if (change === "navigation") observeCrxFrameMessage(f.transport, { ...f.restore, params: { type: "Navigation", frame: { id: "root-frame", loaderId: "replacement" } } });
    assert.equal(admission(), false, change);
    assert.equal(bindCrxChildFrameSession(f.transport, f.parent.sessionId, f.event, f.controller), false, change);
  }
});


test("BFCache tolerates original initialization tree ACKs while joining delivery and reading the child tree", async () => {
  for (const stage of ["delivery", "child-tree"]) {
    const f = remoteFixture();
    await prepareCrxChildFrame(f.transport, f.parent, f.event, async () => f.tree);
    observeCrxFrameMessage(f.transport, f.restore);
    let settle;
    const restoring = refreshCrxCachedLifecycle(f.transport, f.restore, async (target, method) => {
      if (stage === "child-tree" && target.sessionId && method === "Page.getFrameTree") return new Promise(resolve => { settle = resolve; });
      return f.send(target, method);
    });
    await Promise.resolve();
    if (stage === "child-tree") { f.deliver(); while (!settle) await Promise.resolve(); }
    observeCrxFrameMessage(f.transport, { method: "Page.getFrameTree", sessionId: "child-session", result: f.tree });
    if (stage === "delivery") f.deliver();
    else settle(f.tree);
    await restoring;
    assert.deepEqual(f.restores, [f.tree.frameTree], stage);
    assert.deepEqual(f.commands.filter(row => row.method === "Page.setLifecycleEventsEnabled").map(row => row.target),
      [{ tabId: 7, sessionId: "child-session" }, { tabId: 7 }], stage);
  }
});

import assert from "node:assert/strict";
import { test } from "node:test";
import { observeCrxFrameMessage, prepareCrxChildFrame, refreshCrxCachedLifecycle } from "./browser-frame-adapter.js";

function fixture() {
  const events = [];
  const transport = {
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
  const send = async (...args) => calls.push(args);
  const event = { method: "Page.frameNavigated", sessionId: "crx-tab-7", params: { type: "BackForwardCacheRestore", frame: { id: "root-frame" } } };
  await refreshCrxCachedLifecycle(f.transport, event, send);
  assert.deepEqual(calls, [[{ tabId: 7 }, "Page.setLifecycleEventsEnabled", { enabled: true }]]);
  await refreshCrxCachedLifecycle(f.transport, { ...event, params: { ...event.params, type: "Navigation" } }, send);
  await refreshCrxCachedLifecycle(f.transport, { ...event, sessionId: "crx-tab-99" }, send);
  await refreshCrxCachedLifecycle(f.transport, { ...event, sessionId: "foreign-session" }, send);
  assert.equal(calls.length, 1);
  assert.deepEqual(f.events, [], "no lifecycle events are synthesized");
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

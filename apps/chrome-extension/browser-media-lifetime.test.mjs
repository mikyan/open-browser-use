import assert from "node:assert/strict";
import { test } from "node:test";
import { MediaContextLifetimes } from "./browser-media-lifetime.js";

function event() {
  const listeners = new Set();
  return { listeners, addListener: callback => listeners.add(callback), removeListener: callback => listeners.delete(callback),
    emit: (...args) => { for (const callback of [...listeners]) callback(...args); } };
}
function fixture() {
  const events = { onEvent: event(), onDetach: event(), onTabRemoved: event() };
  return { ...events, registry: new MediaContextLifetimes(events), listenerCounts: () => Object.values(events).map(source => source.listeners.size) };
}

test("leases only listen while active and copy the exact native target before caller mutation", () => {
  const f = fixture(), target = { tabId: 7, sessionId: "child" };
  assert.deepEqual(f.listenerCounts(), [0, 0, 0]);
  const lease = f.registry.capture(target, 1); target.tabId = 8; target.sessionId = "different";
  assert.deepEqual(f.listenerCounts(), [1, 1, 1]); assert.equal(f.registry.size, 1);
  f.onEvent.emit(target, "Runtime.executionContextDestroyed", { executionContextId: 1 }); assert.equal(lease.isGone(), false);
  f.onEvent.emit({ tabId: 7, sessionId: "child" }, "Runtime.executionContextDestroyed", { executionContextId: 1 }); assert.equal(lease.isGone(), true);
  assert.equal(f.registry.size, 1, "native destruction cannot discard a still-pending call's lease");
  lease.close(); lease.close(); assert.equal(f.registry.size, 0); assert.deepEqual(f.listenerCounts(), [0, 0, 0]);
});

test("context destruction matches exact root/child session and numeric context, never a sibling", () => {
  const f = fixture();
  const a = f.registry.capture({ tabId: 7 }, 1), b = f.registry.capture({ tabId: 7, sessionId: "child" }, 1), c = f.registry.capture({ tabId: 7, sessionId: "child" }, 2), d = f.registry.capture({ tabId: 8, sessionId: "child" }, 1);
  f.onEvent.emit({ tabId: 7, sessionId: "child" }, "Runtime.executionContextDestroyed", { executionContextId: 1 });
  assert.deepEqual([a, b, c, d].map(lease => lease.isGone()), [false, true, false, false]);
  f.onEvent.emit({ tabId: 7, sessionId: "child" }, "Runtime.executionContextsCleared", {});
  assert.deepEqual([a, b, c, d].map(lease => lease.isGone()), [false, true, true, false]);
  for (const lease of [a, b, c, d]) lease.close(); assert.deepEqual(f.listenerCounts(), [0, 0, 0]);
});

test("reused numeric context IDs start with fresh evidence while old pending leases remain destroyed", () => {
  const f = fixture(), target = { tabId: 7 };
  const old = f.registry.capture(target, 1);
  f.onEvent.emit(target, "Runtime.executionContextDestroyed", { executionContextId: 1 });
  const replacement = f.registry.capture(target, 1);
  assert.equal(old.isGone(), true); assert.equal(replacement.isGone(), false);
  old.close(); assert.equal(replacement.isGone(), false); assert.equal(f.registry.size, 1);
  replacement.close(); assert.deepEqual(f.listenerCounts(), [0, 0, 0]);
  const newest = f.registry.capture(target, 1); assert.equal(newest.isGone(), false); newest.close();
});

test("synthetic page/frame closure, child detachment and canceled debugger do not prove object destruction", () => {
  const f = fixture(), target = { tabId: 7, sessionId: "child" }, lease = f.registry.capture(target, 1);
  for (const method of ["Page.frameDetached", "Target.detachedFromTarget", "Target.targetDestroyed", "Runtime.executionContextCreated", "OBU.contextClosed"])
    f.onEvent.emit(target, method, { executionContextId: 1, sessionId: "child" });
  f.onDetach.emit({ tabId: 7 }, "canceled_by_user");
  f.onDetach.emit({ tabId: 7 }, "unknown");
  assert.equal(lease.isGone(), false); lease.close();
});

test("real tab removal or target_closed destroys only the original tab's active leases", () => {
  for (const event of ["tab", "debugger"]) {
    const f = fixture(), a = f.registry.capture({ tabId: 7 }, 1), b = f.registry.capture({ tabId: 7, sessionId: "child" }, 2), other = f.registry.capture({ tabId: 8 }, 1);
    if (event === "tab") f.onTabRemoved.emit(7, { isWindowClosing: true });
    else f.onDetach.emit({ tabId: 7 }, "target_closed");
    assert.deepEqual([a, b, other].map(lease => lease.isGone()), [true, true, false]);
    for (const lease of [a, b, other]) lease.close();
  }
});

test("malformed identities and failed listener setup cannot leave partial active state", () => {
  const f = fixture();
  for (const [target, id] of [[{ tabId: -1 }, 1], [{ tabId: 7, sessionId: "" }, 1], [{ tabId: 7, targetId: "unscoped" }, 1], [{ tabId: 7 }, 0], [{ tabId: 7 }, NaN], [null, 1]])
    assert.throws(() => f.registry.capture(target, id), /Invalid native media context identity/);
  assert.equal(f.registry.size, 0); assert.deepEqual(f.listenerCounts(), [0, 0, 0]);
  f.onDetach.addListener = () => { throw new Error("listener unavailable"); };
  assert.throws(() => f.registry.capture({ tabId: 7 }, 1), /listener unavailable/);
  assert.equal(f.registry.size, 0); assert.deepEqual(f.listenerCounts(), [0, 0, 0]);
});

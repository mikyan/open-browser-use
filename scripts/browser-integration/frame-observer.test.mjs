import test from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";
import { installFrameObserver } from "./frame-observer.mjs";

function native() {
  const listeners = new Set();
  return { listeners, chrome: { debugger: { onEvent: { addListener: value => listeners.add(value), hasListener: value => listeners.has(value) } } },
    emit(source, method, params) { for (const listener of listeners) listener(source, method, params); } };
}
const source = { tabId: 71, sessionId: "root-child" }, params = { sessionId: "original-session", targetInfo: { targetId: "original-frame", type: "iframe", url: "http://localhost/frame" } };

test("worker-local observer preserves exact native attach fields and duplicate events across idempotent installation", () => {
  const f = native(), target = {};
  assert.deepEqual(installFrameObserver(f.chrome, target, "first-worker"), { identity: "first-worker", ready: true, count: 0 });
  f.emit(source, "Target.attachedToTarget", params);
  const original = target.__integrationFrames;
  assert.deepEqual(installFrameObserver(f.chrome, target, "first-worker"), { identity: "first-worker", ready: true, count: 1 });
  assert.equal(f.listeners.size, 1); assert.equal(target.__integrationFrames, original);
  f.emit(source, "Target.attachedToTarget", params); f.emit(source, "Page.frameAttached", params);
  f.emit(source, "Target.attachedToTarget", { ...params, targetInfo: { ...params.targetInfo, type: "page" } });
  assert.deepEqual(target.__integrationFrames, Array.from({ length: 2 }, () => ({ tabId: 71, source, sessionId: params.sessionId, targetId: params.targetInfo.targetId, type: "iframe", url: params.targetInfo.url })));
});

test("a real replacement worker gets its own observer and cannot borrow old attach history", () => {
  const old = native(), fresh = native(), before = {}, after = {};
  installFrameObserver(old.chrome, before, "old-worker"); old.emit(source, "Target.attachedToTarget", params);
  // Execute the serialized installer in a separate global, as the harness does
  // after obtaining the replacement worker's native debugger target.
  vm.runInNewContext(`(${installFrameObserver.toString()})(chrome,target,'new-worker')`, { chrome: fresh.chrome, target: after });
  assert.equal(after.__integrationFrames.length, 0); assert.equal(before.__integrationFrames.length, 1);
  fresh.emit({ tabId: 82 }, "Target.attachedToTarget", { ...params, sessionId: "new-session" });
  assert.equal(after.__integrationFrames.length, 1); assert.equal(after.__integrationFrames[0].tabId, 82);
  assert.equal(after.__integrationFrames[0].sessionId, "new-session"); assert.equal(after.__integrationFrameObserver.snapshot().identity, "new-worker");
  assert.equal(before.__integrationFrames[0].tabId, 71);
});

test("missing listener, substituted array and unknown existing history fail instead of returning an empty inventory", () => {
  for (const mutate of [(f, target) => f.listeners.clear(), (_f, target) => { target.__integrationFrames = []; }, (_f, target) => { delete target.__integrationFrames; }]) {
    const f = native(), target = {}; installFrameObserver(f.chrome, target, "worker"); mutate(f, target);
    assert.throws(() => target.__integrationFrameObserver.snapshot(), /replaced/);
    assert.throws(() => installFrameObserver(f.chrome, target, "worker"), /replaced/);
  }
  assert.throws(() => installFrameObserver(native().chrome, { __integrationFrames: [] }, "worker"), /Unproven/);
});

import assert from "node:assert/strict";
import { test } from "node:test";
import { captureAISnapshot, scrollAIRefIntoView } from "./browser-ai-snapshot.js";

function captureFixture() {
  const root = { _guid: "root-guid", isDetached: () => false };
  const child = { _guid: "child-guid", isDetached: () => false };
  const snapshot = '- button "名字 [ref=e999]" [ref=f1e2]';
  const result = { snapshot, refs: [{ ref: "f1e2", frameGuid: child._guid }], stats: { bytes: new TextEncoder().encode(snapshot).length, nodes: 3, refs: 1, frames: 2 }, complete: true };
  const calls = [];
  const page = { frames: () => [root, child], _channel: { snapshotForAI: async args => { calls.push(args); return result; } } };
  return { root, child, page, calls, result };
}

test("native metadata supplies exact refs and real client Frame identities, not text token matches", async () => {
  const f = captureFixture();
  const result = await captureAISnapshot(f.page, { timeoutMs: 500 });
  assert.deepEqual(result.refs, ["f1e2"]);
  assert.equal(result.refFrames.get("f1e2"), f.child);
  assert.equal(result.refFrames.has("e999"), false);
  assert.equal(f.calls[0].bounded, true);
  assert.equal(f.calls[0].maxBytes, 262144);
  assert.equal(f.calls[0].timeout, 500);
});

test("bounded adapter rejects malformed, excessive, incomplete or stale native metadata", async () => {
  for (const mutate of [
    f => { f.result.complete = false; },
    f => { f.result.stats.bytes++; },
    f => { f.result.refs.push(f.result.refs[0]); },
    f => { f.result.refs[0].frameGuid = "unknown"; },
    f => { f.result.refs[0].ref = "e2 >> button"; },
    f => { f.result.refs[0].ref = "e2\n"; },
    f => { f.child.isDetached = () => true; },
    f => { f.result.stats.nodes = 5001; }
  ]) { const f = captureFixture(); mutate(f); await assert.rejects(captureAISnapshot(f.page, { timeoutMs: 500 }), /INCOMPLETE/); }
  const f = captureFixture();
  for (const options of [{ maxBytes: 0 }, { maxDepth: 65 }, { maxNodes: 1.2 }, { timeoutMs: 0 }])
    await assert.rejects(captureAISnapshot(f.page, { timeoutMs: 500, ...options }), /LIMIT/);
  assert.equal(f.calls.length, 0);
});

function scrollFixture() {
  const calls = [];
  const root = { parentFrame: () => null, isDetached: () => false };
  const frame = (name, parent) => ({ parentFrame: () => parent, isDetached: () => false, frameElement: async () => {
    calls.push(["resolve", name]);
    return { scrollIntoViewIfNeeded: async options => { calls.push(["scroll", name, options.timeout]); }, dispose: async () => { calls.push(["dispose", name]); } };
  } });
  const outer = frame("outer", root), inner = frame("inner", outer);
  const page = { frames: () => [root, outer, inner] };
  return { page, calls, root, outer, inner, metadata: { refFrames: new Map([["f2e2", inner]]) } };
}

test("ref screenshot preparation resolves real ancestor handles outside-in and disposes each", async () => {
  const f = scrollFixture();
  let checks = 0;
  await scrollAIRefIntoView(f.page, "f2e2", f.metadata, { timeoutMs: 500, check: async () => { checks++; } });
  assert.deepEqual(f.calls.map(call => call.slice(0, 2)), [["resolve", "outer"], ["scroll", "outer"], ["dispose", "outer"], ["resolve", "inner"], ["scroll", "inner"], ["dispose", "inner"]]);
  assert.ok(checks >= 7);
  assert.ok(f.calls[4][2] <= f.calls[1][2]);
});

test("expired ownership after resolving a frame element disposes it without scrolling", async () => {
  const f = scrollFixture();
  await assert.rejects(scrollAIRefIntoView(f.page, "f2e2", f.metadata, { timeoutMs: 500, check: () => {
    if (f.calls.length) throw new Error("OBU_CAPTURE_EXPIRED");
  } }), /EXPIRED/);
  assert.deepEqual(f.calls.map(call => call.slice(0, 2)), [["resolve", "outer"], ["dispose", "outer"]]);
});

test("a ref scroll timeout or replaced frame cannot continue to another ancestor", async () => {
  const f = scrollFixture();
  const original = f.outer.frameElement;
  f.outer.frameElement = async () => {
    const element = await original();
    element.scrollIntoViewIfNeeded = async () => { f.outer.isDetached = () => true; };
    return element;
  };
  await assert.rejects(scrollAIRefIntoView(f.page, "f2e2", f.metadata, { timeoutMs: 500 }), /EXPIRED/);
  assert.ok(!f.calls.some(call => call[1] === "inner"));
  assert.ok(f.calls.some(call => call[0] === "dispose"));
});

import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { test } from "node:test";
import { validateSnapshotGeometry } from "./browser-snapshot-geometry.js";
import { captureAISnapshot } from "./browser-ai-snapshot.js";
import { BrowserObservation, AI_SNAPSHOT_LIMITS } from "./browser-observation.js";

const viewport = () => ({ width: 640, height: 480, scrollX: 3.5, scrollY: 200, devicePixelRatio: 1.5 });
function geometry() {
  return { coordinateSpace: "frame-viewport-css", frames: [
    { id: "root", parentId: null, ownerRef: null, viewport: viewport() },
    { id: "f32", parentId: "root", ownerRef: "e1", viewport: viewport() }
  ], boxes: [
    { ref: "e1", frameId: "root", box: { x: -7.5, y: 20.25, width: 400, height: 300 } },
    { ref: "f32e1", frameId: "f32", box: { x: 900, y: -100, width: 0, height: 0 } }
  ] };
}
const validate = value => validateSnapshotGeometry(value, { refs: ["e1", "f32e1"], frameCount: 2 });

test("geometry preserves fractional/offscreen/zero-sized CSS boxes and sparse stable frame slots", () => {
  const value = geometry();
  assert.equal(validate(value), value);
  assert.deepEqual(value.boxes[1].box, { x: 900, y: -100, width: 0, height: 0 });
});

test("geometry cannot register page-text refs or mix a child's box with its parent's coordinate space", () => {
  for (const mutate of [
    value => { value.boxes.pop(); },
    value => { value.boxes.push(value.boxes[0]); },
    value => { value.boxes[1].ref = "e999"; },
    value => { value.boxes[1].ref = "e1"; },
    value => { value.boxes[1].frameId = "root"; },
    value => { value.coordinateSpace = "top-viewport-css"; },
    value => { value.boxes[0].box = null; },
    value => { value.boxes[0].box.viewport = true; },
    value => { value.boxes[0].frameGuid = "internal"; },
    value => { value.extra = []; }
  ]) { const value = geometry(); mutate(value); assert.throws(() => validate(value), /INCOMPLETE/); }
});

test("geometry requires a unique rooted frame tree and an owner ref in each actual parent", () => {
  for (const mutate of [
    value => { value.frames.reverse(); },
    value => { value.frames[0].ownerRef = "e1"; },
    value => { value.frames[1].id = "root"; },
    value => { value.frames[1].parentId = "f32"; },
    value => { value.frames[1].ownerRef = "f32e1"; },
    value => { value.frames[1].ownerRef = "e999"; },
    value => { value.frames[1].frameGuid = "internal"; },
    value => { delete value.frames[1].viewport.scrollX; },
    value => { value.frames[1].id = "f33"; }
  ]) { const value = geometry(); mutate(value); assert.throws(() => validate(value), /INCOMPLETE/); }
  const value = geometry();
  value.frames.push({ id: "f2", parentId: "root", ownerRef: "e1", viewport: viewport() });
  assert.throws(() => validateSnapshotGeometry(value, { refs: ["e1", "f32e1"], frameCount: 3 }), /INCOMPLETE/);
  const emptyChild = geometry();
  emptyChild.boxes.pop(); emptyChild.frames[1].id = "f32\n";
  assert.throws(() => validateSnapshotGeometry(emptyChild, { refs: ["e1"], frameCount: 2 }), /INCOMPLETE/);
});

test("geometry rejects nonfinite, boolean and negative dimensions without coercion", () => {
  for (const section of ["viewport", "box"]) {
    for (const field of Object.keys(section === "viewport" ? viewport() : geometry().boxes[0].box)) {
      for (const invalid of [null, true, "1", NaN, Infinity, -Infinity]) {
        const value = geometry();
        (section === "viewport" ? value.frames[0].viewport : value.boxes[0].box)[field] = invalid;
        assert.throws(() => validate(value), /INCOMPLETE/);
      }
    }
  }
  for (const mutate of [
    value => { value.boxes[0].box.width = -1; },
    value => { value.frames[0].viewport.height = -1; },
    value => { value.frames[0].viewport.devicePixelRatio = 0; }
  ]) { const value = geometry(); mutate(value); assert.throws(() => validate(value), /INCOMPLETE/); }
});

function nativeFixture() {
  const page = new EventEmitter(), root = { _guid: "root-guid", isDetached: () => false, parentFrame: () => null };
  const child = { _guid: "child-guid", isDetached: () => false, parentFrame: () => root };
  page.frames = () => [root, child]; page.mainFrame = () => root;
  const snapshot = '- iframe [ref=e1] [box=-7.5,20.25,400,300]:\n  - button "fake [ref=e999]" [ref=f32e1] [box=900,-100,0,0]';
  const result = { snapshot, refs: [{ ref: "e1", frameGuid: root._guid }, { ref: "f32e1", frameGuid: child._guid }],
    stats: { bytes: Buffer.byteLength(snapshot), nodes: 5, refs: 2, frames: 2 }, complete: true, geometry: geometry() };
  result.geometry.frames[0].frameGuid = root._guid;
  result.geometry.frames[1].frameGuid = child._guid;
  const calls = [];
  page._channel = { snapshotForAI: async options => { calls.push(options); return result; } };
  return { page, root, child, result, calls };
}

test("native geometry binds real Frame ancestry and strips internal identities before publication", async () => {
  const f = nativeFixture();
  const result = await captureAISnapshot(f.page, { boxes: true, timeoutMs: 500 });
  assert.equal(f.calls.length, 1); assert.equal(f.calls[0].boxes, true);
  assert.deepEqual(result.geometry, geometry());
  assert.equal(result.refFrames.get("f32e1"), f.child);
  assert.equal(result.refFrames.has("e999"), false);
  const observation = new BrowserObservation(f.page);
  const value = observation.publish(result, observation.begin(), AI_SNAPSHOT_LIMITS, { boxes: true });
  assert.equal(JSON.stringify(value).includes("frameGuid"), false);
  value.geometry.boxes[0].box.x = 10000;
  assert.equal(result.geometry.boxes[0].box.x, -7.5);
});

test("native geometry cannot survive detached, swapped or unknown Frame identities", async () => {
  for (const mutate of [
    f => { f.child.isDetached = () => true; },
    f => { f.child.parentFrame = () => null; },
    f => { f.page.mainFrame = () => f.child; },
    f => { f.result.refs[1].frameGuid = f.root._guid; },
    f => { f.result.geometry.frames[1].frameGuid = "unknown"; },
    f => { f.result.geometry.frames[1].frameGuid = f.root._guid; },
    f => { delete f.result.geometry.frames[1].frameGuid; },
    f => { delete f.result.geometry; }
  ]) { const f = nativeFixture(); mutate(f); await assert.rejects(captureAISnapshot(f.page, { boxes: true, timeoutMs: 500 }), /INCOMPLETE/); }
});

test("empty child documents retain geometry and actual frame identity without inventing refs", async () => {
  const f = nativeFixture();
  f.result.refs.pop(); f.result.geometry.boxes.pop(); f.result.stats.refs = 1;
  const result = await captureAISnapshot(f.page, { boxes: true, timeoutMs: 500 });
  assert.equal(result.geometry.frames.length, 2);
  assert.equal(result.geometry.boxes.length, 1);
  f.result.geometry.frames[1].frameGuid = "unknown";
  await assert.rejects(captureAISnapshot(f.page, { boxes: true, timeoutMs: 500 }), /INCOMPLETE/);
});

test("boxes must be explicitly requested and malformed geometry cannot publish a valid capture", async () => {
  const f = nativeFixture();
  for (const boxes of [null, 0, "true"]) await assert.rejects(captureAISnapshot(f.page, { boxes, timeoutMs: 500 }), /invalid boxes/);
  assert.equal(f.calls.length, 0);
  await assert.rejects(captureAISnapshot(f.page, { boxes: false, timeoutMs: 500 }), /unexpected native geometry/);
  const result = await captureAISnapshot(f.page, { boxes: true, timeoutMs: 500 });
  const observation = new BrowserObservation(f.page);
  assert.throws(() => observation.publish(result, observation.begin(), AI_SNAPSHOT_LIMITS), /INCOMPLETE/);
  const first = observation.publish(result, observation.begin(), AI_SNAPSHOT_LIMITS, { boxes: true });
  const pending = observation.begin(); f.page.emit("framenavigated", f.child);
  assert.throws(() => observation.publish(result, pending, AI_SNAPSHOT_LIMITS, { boxes: true }), /EXPIRED/);
  assert.throws(() => observation.get({ captureId: first.captureId, ref: "e1" }), /EXPIRED/);
  result.geometry.boxes.pop();
  assert.throws(() => observation.publish(result, observation.begin(), AI_SNAPSHOT_LIMITS, { boxes: true }), /INCOMPLETE/);
});

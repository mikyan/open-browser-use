import assert from "node:assert/strict";
import test from "node:test";
import { OpenBrowserUseBrowser, OpenBrowserUseClient } from "../dist/index.js";

function capture(boxes = true) {
  const snapshot = '- iframe [ref=e1] [box=-1.5,2,100,50]\n  - button "fake [ref=e999] [box=0,0,1,1]" [ref=f32e2] [box=0,-20,0,0]';
  const result = { captureId: "capture", snapshot, refs: ["e1", "f32e2"], stats: { bytes: Buffer.byteLength(snapshot), nodes: 2, refs: 2, frames: 2 }, complete: true };
  if (boxes) result.geometry = {
    coordinateSpace: "frame-viewport-css",
    frames: [
      { id: "root", parentId: null, ownerRef: null, viewport: { width: 800, height: 600, scrollX: -1.25, scrollY: 100, devicePixelRatio: 1.5 } },
      { id: "f32", parentId: "root", ownerRef: "e1", viewport: { width: 100, height: 50, scrollX: 0, scrollY: 20, devicePixelRatio: 1.5 } },
    ],
    boxes: [ { ref: "e1", frameId: "root", box: { x: -1.5, y: 2, width: 100, height: 50 } },
      { ref: "f32e2", frameId: "f32", box: { x: 0, y: -20, width: 0, height: 0 } } ],
  };
  return result;
}
class Client extends OpenBrowserUseClient {
  calls = []; result = capture(); failure;
  constructor() { super({ socketPath: "unused" }); }
  async request(method, params) {
    this.calls.push({ method, params });
    if (this.failure) throw this.failure;
    return { value: this.result, engine: { name: "playwright-crx", version: "0.15.0", playwrightVersion: "1.53.0", capabilities: { snapshotAI: 1, captureRefs: 1, snapshotBoxes: 1 } } };
  }
}
function context() { const client = new Client(); return { client, tab: new OpenBrowserUseBrowser({ client }).tab(7) }; }

test("snapshot boxes preserve native refs, frame-local finite geometry and typed options without guessing text", async () => {
  const { client, tab } = context();
  const result = await tab.playwright.snapshotAI({ boxes: true, maxFrames: 2, timeoutMs: 500 });
  assert.deepEqual(result, capture());
  assert.deepEqual(client.calls[0].params.args, { boxes: true, maxFrames: 2 });
  assert.equal(client.calls[0].params.timeoutMs, 500);
  client.result = "original node";
  assert.equal(await tab.getByRef(result.captureId, result.refs[1]).innerText(), "original node");
  assert.deepEqual(client.calls[1].params.locator, [{ kind: "ref", captureId: "capture", ref: "f32e2" }]);
});

test("snapshot geometry must match explicit request; unsupported never falls back or replays", async () => {
  const { client, tab } = context();
  for (const boxes of [0, 1, "true", null, {}, []]) await assert.rejects(tab.snapshotAI({ boxes }), /boolean/);
  assert.equal(client.calls.length, 0);
  for (const options of [{}, { boxes: false }]) await assert.rejects(tab.snapshotAI(options), /Invalid snapshotAI/);
  client.result = capture(false);
  await assert.rejects(tab.snapshotAI({ boxes: true }), /Invalid snapshotAI/);
  assert.deepEqual(await tab.snapshotAI(), capture(false));
  assert.deepEqual(await tab.snapshotAI({ boxes: false }), capture(false));
  const before = client.calls.length;
  client.failure = new Error("unsupported boxes");
  await assert.rejects(tab.snapshotAI({ boxes: true }), /unsupported boxes/);
  assert.equal(client.calls.length, before + 1);
  assert.deepEqual(client.calls.at(-1).params.args, { boxes: true });
});

test("snapshot boxes reject ambiguous identity, topology, internal fields and invalid numeric schema", async () => {
  const { client, tab } = context();
  const mutations = {
    nullGeometry: g => null,
    extraGeometry: g => ({ ...g, frameGuid: "private" }),
    wrongSpace: g => ({ ...g, coordinateSpace: "main-viewport-css" }),
    missingBox: g => { g.boxes.pop(); return g; },
    extraBox: g => { g.boxes.push(g.boxes[0]); return g; },
    duplicateBox: g => { g.boxes[1] = g.boxes[0]; return g; },
    fakeRef: g => { g.boxes[1].ref = "e999"; return g; },
    wrongPrefix: g => { g.boxes[1].frameId = "root"; return g; },
    missingFrame: g => { g.frames.pop(); return g; },
    reorderedFrames: g => { g.frames.reverse(); return g; },
    duplicateFrame: g => { g.frames[1] = g.frames[0]; return g; },
    missingRefFrame: g => { g.frames[1].id = "f1"; return g; },
    rootOwner: g => { g.frames[0].ownerRef = "e1"; return g; },
    selfParent: g => { g.frames[1].parentId = "f32"; return g; },
    unknownParent: g => { g.frames[1].parentId = "f1"; return g; },
    wrongOwnerFrame: g => { g.frames[1].ownerRef = "f32e2"; return g; },
    unknownOwner: g => { g.frames[1].ownerRef = "e999"; return g; },
    internalFrame: g => { g.frames[1].frameGuid = "private"; return g; },
    extraBoxField: g => { g.boxes[0].quad = []; return g; },
    nullBox: g => { g.boxes[0].box = null; return g; },
    missingZero: g => { delete g.boxes[1].box.width; return g; },
    negativeWidth: g => { g.boxes[1].box.width = -1; return g; },
    negativeViewport: g => { g.frames[0].viewport.height = -1; return g; },
    zeroDPR: g => { g.frames[0].viewport.devicePixelRatio = 0; return g; },
    extraViewport: g => { g.frames[0].viewport.scale = 1; return g; },
  };
  for (const number of [true, null, "1", NaN, Infinity, -Infinity]) {
    mutations[`invalidNumber:${number}`] = g => { g.boxes[0].box.x = number; return g; };
    mutations[`invalidScroll:${number}`] = g => { g.frames[0].viewport.scrollY = number; return g; };
  }
  for (const [name, mutate] of Object.entries(mutations)) {
    client.result = capture(); client.result.geometry = mutate(client.result.geometry);
    await assert.rejects(tab.snapshotAI({ boxes: true }), /Invalid snapshotAI/, name);
  }
  client.result = capture();
  client.result.refs[1] = "f33e2"; client.result.geometry.boxes[1].ref = "f33e2";
  client.result.geometry.boxes[1].frameId = client.result.geometry.frames[1].id = "f33";
  await assert.rejects(tab.snapshotAI({ boxes: true }), /Invalid snapshotAI/);
  client.result = capture(); client.result.stats.frames = 3;
  client.result.geometry.frames.push({ ...client.result.geometry.frames[1], id: "f1" });
  await assert.rejects(tab.snapshotAI({ boxes: true }), /Invalid snapshotAI/, "one iframe owner cannot identify two children");
});

test("snapshot boxes allow root-only empty observations and enforce annotated byte budget", async () => {
  const { client, tab } = context();
  await assert.rejects(tab.snapshotAI({ boxes: true, maxBytes: 1 }), /Invalid snapshotAI/);
  client.result = capture();
  client.result.refs = []; client.result.geometry.boxes = []; client.result.geometry.frames.splice(1);
  client.result.stats.refs = 0; client.result.stats.frames = 1;
  assert.deepEqual((await tab.snapshotAI({ boxes: true })).geometry.boxes, []);
});

test("snapshot boxes keep the request schema across an awaited response and reject trailing frame ID data", async () => {
  const { client, tab } = context();
  let resolve;
  client.request = async () => ({ value: await new Promise(done => { resolve = done; }), engine: { name: "playwright-crx", version: "0.15.0", playwrightVersion: "1.53.0" } });
  const options = { boxes: true };
  const pending = tab.snapshotAI(options);
  options.boxes = false;
  resolve(capture());
  assert.ok((await pending).geometry);
  const value = capture();
  value.refs.pop(); value.stats.refs = 1; value.geometry.boxes.pop(); value.geometry.frames[1].id = "f1\n";
  const invalid = tab.snapshotAI({ boxes: true });
  resolve(value);
  await assert.rejects(invalid, /Invalid snapshotAI/);
});

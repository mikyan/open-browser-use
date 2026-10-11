import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import vm from "node:vm";
import { createRequire } from "node:module";
import { test } from "node:test";
import { createFrameGeometryRuntime, patchCrxFrameGeometry } from "./patch-frame-geometry.mjs";

const require = createRequire(new URL("../apps/chrome-extension/package.json", import.meta.url));
const directory = path.dirname(require.resolve("playwright-crx/package.json"));
const entry = await fs.readFile(path.join(directory, "lib/index.mjs"), "utf8");
const upstream = await fs.readFile(path.join(directory, "lib", /from ["']\.\/([^"']+\.mjs)/.exec(entry)[1]), "utf8");
const patched = patchCrxFrameGeometry(upstream);
const runtime = createFrameGeometryRuntime();
const deferred = () => { let resolve; const promise = new Promise((r) => { resolve = r; }); return { promise, resolve }; };
const plain = (value) => JSON.parse(JSON.stringify(value));
const near = (actual, expected, tolerance = 1e-8) => {
  for (const key of Object.keys(expected)) assert.ok(Math.abs(actual[key] - expected[key]) <= tolerance, `${key}: ${actual[key]} != ${expected[key]}`);
};
const rect = (x, y, width, height) => [x, y, x + width, y, x + width, y + height, x, y + height];

function method(source, from, to) {
  const start = source.indexOf(from), end = source.indexOf(to, start);
  assert.ok(start >= 0 && end > start);
  return source.slice(start, end);
}

// Execute the actual patched ElementHandle methods, serialized fixed utility
// functions, and original CRPage session/adoption route. Only CDP is simulated.
function fixture({ nested = true, onSend, onEvaluate, onAdopt, releaseError } = {}) {
  const calls = [], hits = [], releases = [], adopted = [], evaluations = [];
  let expired = false, serial = 0;
  const progress = { throwIfAborted() {}, timeUntilDeadline: () => expired ? 0 : 10000 };
  const FrameSession = vm.runInNewContext("class FrameSession {" +
    method(upstream, "  async _adoptBackendNodeId(backendNodeId, to) {", "\n}\nasync function emulateLocale") +
    "}; FrameSession", {
    kUnableToAdoptErrorMessage: "unable to adopt",
    createHandle$3(context, object) {
      const row = byObject.get(object.objectId);
      return { asElement() {
        const handle = { _context: context, _objectId: object.objectId, node: row.node,
          dispose: vm.runInNewContext("({" + method(upstream, "  dispose() {\n    if (this._disposed)", "  toString() {") + "})").dispose };
        adopted.push(handle); return handle;
      } };
    }
  });
  const Handle = vm.runInNewContext(
    method(patched, "const obuFrameGeometry =", "let ElementHandle$1 =") +
    "class Handle {" + method(patched, "  async _clickablePoint(progress)", "  async _retryAction(") +
    method(patched, "  async _checkFrameIsHitTarget(point, progress)", "\n};\nfunction throwRetargetableDOMError") +
    "}; Handle", { Error, Promise, Number, Map });
  const byObject = new Map(), byBackend = new Map(), frames = [], sessions = [];
  const delegate = {
    _sessions: new Map(),
    _sessionForFrame: vm.runInNewContext("(class Delegate {" + method(upstream, "  _sessionForFrame(frame) {", "  willBeginDownload() {") + "}).prototype")._sessionForFrame,
    _sessionForHandle(handle) { return this._sessionForFrame(handle._context.frame); }
  };
  const page = { delegate, frameManager: { frame: (id) => frames.find((frame) => frame._id === id) }, mainFrame: () => frames[0] };
  function makeFrame(id, parent, separate, geometry) {
    const frame = { _id: id, _page: page, parentFrame: () => parent,
      pendingDocument: () => frame.pending, _contextData: new Map(), async _utilityContext() { return frame.context; } };
    frames.push(frame);
    let session = parent && delegate._sessionForFrame(parent);
    if (!parent || separate) {
      session = new FrameSession(); session._targetId = id;
      session._client = { _sessionId: `session-${id}`,
        async send(name, params) {
          calls.push({ name, params: { ...params }, session: id });
          if (onSend) await onSend(name, params, frame);
          if (name === "DOM.getFrameOwner") return { backendNodeId: byBackend.get(params.frameId).backend };
          if (name === "DOM.resolveNode") {
            const owner = [...byBackend.values()].find((row) => row.backend === params.backendNodeId);
            const objectId = `owner-${++serial}`; byObject.set(objectId, owner);
            if (onAdopt) await onAdopt(owner, frame);
            return { object: { objectId, type: "object", subtype: "node" } };
          }
          if (name === "DOM.getBoxModel") return { model: { content: [...byObject.get(params.objectId).raw] } };
          if (name === "DOM.getContentQuads") return { quads: targetQuads ?? [targetRaw] };
          throw new Error(`Unexpected native call ${name}`);
        }
      };
      session._client._sendMayFail = session._client.send;
      delegate._sessions.set(id, session); sessions.push(session);
    }
    const document = { defaultView: { getComputedStyle: (node) => node.style } };
    const injected = { document, expectHitTarget(point, element) {
      const entry = { frame: id, node: element.id, point: { ...point } }; hits.push(entry);
      return frame.cover || "done";
    } };
    const viewport = { innerWidth: geometry?.viewportWidth ?? 1000, innerHeight: geometry?.viewportHeight ?? 1000,
      scrollX: 0, scrollY: 0, visualViewport: { offsetLeft: 0, offsetTop: 0, scale: 1 } };
    const context = { frame, world: "utility", delegate: { _contextId: frames.length, _client: session._client },
      _contextDestroyedScope: { isClosed: () => context.destroyed },
      async injectedScript() { return injected; },
      async releaseHandle(handle) { releases.push(handle._objectId); if (releaseError) throw releaseError; },
      async evaluate(fn, arg) {
        evaluations.push({ frame: id, name: fn.name });
        if (onEvaluate) await onEvaluate(fn, frame);
        const mapped = arg?.map ? arg.map((value) => value?.node ?? value) : arg;
        return vm.runInNewContext(`(${fn.toString()})(argument)`, { ...viewport, argument: mapped, Number });
      }
    };
    frame.context = context; frame._contextData.set("utility", { context });
    if (parent) {
      const node = { id: id + "-owner", localName: "iframe", isConnected: true, ownerDocument: parent.context.document,
        style: { width: `${geometry.width}px`, height: `${geometry.height}px`, boxSizing: "content-box",
          borderLeftWidth: "0px", borderRightWidth: "0px", borderTopWidth: "0px", borderBottomWidth: "0px",
          paddingLeft: "0px", paddingRight: "0px", paddingTop: "0px", paddingBottom: "0px" } };
      byBackend.set(id, { backend: 100 + frames.length, node, raw: geometry.raw });
    }
    context.document = document; frame.viewport = viewport;
    return frame;
  }
  const root = makeFrame("root", null, true);
  let target = root;
  let targetRaw = rect(40, 60, 50, 20);
  let targetQuads;
  if (nested) {
    const same = makeFrame("same", root, false, { width: 400.5, height: 300.25, viewportWidth: 401, viewportHeight: 300,
      raw: rect(100, 50, 801, 450.375) });
    const oopif = makeFrame("oopif", same, true, { width: 300.4, height: 200.25, viewportWidth: 300, viewportHeight: 200,
      raw: [540, 95, 540, 545.6, 139.5, 545.6, 139.5, 95] });
    target = makeFrame("leaf", oopif, false, { width: 200.5, height: 100.25, viewportWidth: 201, viewportHeight: 100,
      raw: rect(10, 20, 200.5, 100.25) });
  }
  const handle = new Handle();
  Object.assign(handle, { _page: page, _frame: target, _context: target.context, _objectId: "target",
    node: { isConnected: true, ownerDocument: target.context.document,
      style: { borderLeftWidth: "1.25px", borderTopWidth: "2.5px" }, getBoundingClientRect: () => ({ x: 30, y: 40 }) } });
  return { handle, progress, frames, sessions, calls, hits, releases, adopted, evaluations, byBackend,
    expire() { expired = true; }, setTargetRaw(value) { targetRaw = value; }, setTargetQuads(value) { targetQuads = value; },
    clickable: () => handle._clickablePoint(progress), hit: (point) => handle._checkFrameIsHitTarget(point, progress),
    offset: (offset) => handle._offsetPoint(offset, progress) };
}

test("pinned bundle patch installs progress-aware point and hit methods without transformed bypass", () => {
  assert.match(patched, /_offsetPoint\(position, progress2\).*_clickablePoint\(progress2\)/);
  assert.match(patched, /frameCheckResult = await this\._checkFrameIsHitTarget\(point, progress2\)/);
  assert.doesNotMatch(method(patched, "  async _checkFrameIsHitTarget(", "\n};\nfunction throwRetargetableDOMError"), /transformed|void 0/);
  assert.throws(() => patchCrxFrameGeometry(patched), /expected one|absent/);
  assert.throws(() => patchCrxFrameGeometry(upstream.replace("const frameCheckResult =", "const renamed =")), /frame hit progress/);
});

test("projective plane maps fractional, rotated and reflected corners without viewport normalization", () => {
  const q = [540, 95, 540, 545.6, 139.5, 545.6, 139.5, 95];
  const map = runtime.plane(q, 300.4, 200.25);
  near(runtime.project(map.forward, { x: 65, y: 70 }), { x: 400, y: 192.5 });
  near(runtime.project(map.inverse, { x: 400, y: 192.5 }), { x: 65, y: 70 });
  const reflected = runtime.plane([10, 20, -190, 20, -190, 70, 10, 70], 100, 50);
  near(runtime.project(reflected.forward, { x: 50, y: 25 }), { x: -90, y: 45 });
  const perspective = runtime.plane([0, 0, 100, 10, 80, 100, 10, 80], 200.5, 100.25);
  near(runtime.project(perspective.forward, { x: 200.5, y: 100.25 }), { x: 80, y: 100 });
  assert.throws(() => runtime.plane([0, 0, 1, 0, 1, 0, 0, 0], 1, 1), /Degenerate/);
  assert.throws(() => runtime.plane([0, 0, 1, 1, 1, 0, 0, 1], 1, 1), /Non-convex/);
  assert.throws(() => runtime.plane([0, 0, Infinity, 0, 1, 1, 0, 1], 1, 1), /Invalid/);
});

test("actual bundle projects nested local→OOPIF→local quads exactly once", async () => {
  const f = fixture(); const point = await f.clickable();
  near(point, { x: 400, y: 192.5 });
  const result = await f.hit(point);
  near(result.framePoint, { x: 55, y: 50 });
  assert.deepEqual(f.hits.map((hit) => [hit.frame, hit.node]), [["root", "same-owner"], ["same", "oopif-owner"], ["oopif", "leaf-owner"]]);
  near(f.hits[0].point, point); near(f.hits[1].point, { x: 150, y: 95 }); near(f.hits[2].point, { x: 65, y: 70 });
  assert.deepEqual(f.calls.filter((call) => call.name === "DOM.getContentQuads").map((call) => call.session), ["oopif"]);
  assert.equal(f.releases.length, 6); assert.equal(f.adopted.length, 6);
  assert.equal(result.frameGeometry[1].plane.width, 400.5);
  assert.equal(result.frameGeometry[1].viewport.width, 401);
  assert.equal(result.frameGeometry[2].localRootId, "oopif");
});

test("root point remains CSS coordinates and frame fingerprints do not include fresh remote handles", async () => {
  const f = fixture({ nested: false }); near(await f.clickable(), { x: 65, y: 70 });
  const first = await f.hit({ x: 65, y: 70 }), second = await f.hit({ x: 65, y: 70 });
  assert.deepEqual(plain(first.frameGeometry), plain(second.frameGeometry));
  const nested = fixture();
  assert.deepEqual(plain((await nested.hit({ x: 400, y: 192.5 })).frameGeometry), plain((await nested.hit({ x: 400, y: 192.5 })).frameGeometry));
});

test("fixed utility content sizing subtracts fractional border and padding for border-box", () => {
  const document = { defaultView: { getComputedStyle: (node) => node.style } };
  const style = { width: "400.5px", height: "210.25px", boxSizing: "border-box", borderLeftWidth: "2px", borderRightWidth: "2px",
    borderTopWidth: "2px", borderBottomWidth: "2px", paddingLeft: "4.75px", paddingRight: "4.75px", paddingTop: "3.25px", paddingBottom: "3.25px" };
  const result = runtime.readOwnerPlane([{ document }, { isConnected: true, localName: "iframe", ownerDocument: document, style }]);
  assert.equal(result.width, 387); assert.equal(result.height, 199.75);
  style.boxSizing = "content-box";
  assert.equal(runtime.readOwnerPlane([{ document }, { isConnected: true, localName: "IFRAME", ownerDocument: document, style }]).width, 400.5);
});

test("position retains leaf local padding-origin then projects through rotated iframe ancestors", async () => {
  const f = fixture(); const point = await f.offset({ x: 3.5, y: 4.25 });
  // leaf=(34.75,46.75), OOPIF=(44.75,66.75), root=(406.5,162.125).
  near(point, { x: 406.5, y: 162.125 });
  assert.equal(f.calls.some((call) => call.name === "DOM.getContentQuads"), false);
});

test("each original parent utility hit is authoritative, including transformed ancestor overlays", async () => {
  for (const index of [0, 1, 2]) {
    const f = fixture(); f.frames[index].cover = { hitTargetDescription: `cover-${index}` };
    const result = await f.hit({ x: 400, y: 192.5 });
    assert.equal(result.hitTargetDescription, `cover-${index}`);
    assert.equal(f.hits.length, index + 1);
    assert.equal(f.releases.length, 3);
  }
});

test("changed quad, resolved dimensions, owner or utility identity changes the fingerprint", async () => {
  for (const mutate of [
    (f) => { f.byBackend.get("oopif").raw = f.byBackend.get("oopif").raw.map((v, i) => v + (i % 2 ? 0 : 5)); },
    (f) => { f.byBackend.get("same").node.style.width = "400.75px"; },
    (f) => { f.byBackend.get("leaf").backend++; },
    (f) => { f.frames[1].context.delegate._contextId++; }
  ]) {
    const f = fixture(), before = await f.hit({ x: 400, y: 192.5 }); mutate(f);
    const after = await f.hit({ x: 400, y: 192.5 });
    assert.notEqual(JSON.stringify(before.frameGeometry), JSON.stringify(after.frameGeometry));
  }
});

test("real polygon clipping does not invent a point outside rotated visible content", () => {
  const diamond = [{ x: -4, y: 5 }, { x: 5, y: -4 }, { x: 14, y: 5 }, { x: 5, y: 14 }];
  const clipped = runtime.clip(diamond, [{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 10 }, { x: 0, y: 10 }]);
  assert.equal(clipped.length, 8); assert.equal(runtime.area(clipped), 98);
  assert.ok(clipped.every((p) => p.x >= 0 && p.x <= 10 && p.y >= 0 && p.y <= 10));
});

test("pending navigation, destroyed context and changed session stop before later native reads", async () => {
  for (const mutation of [
    (f) => { f.frames[1].pending = {}; },
    (f) => { f.frames[1].context.destroyed = true; },
    (f) => { f.frames[0]._page.delegate._sessions.set("same", {}); }
  ]) {
    let f; f = fixture({ onSend(name) { if (name === "DOM.getBoxModel") mutation(f); } });
    assert.equal(await f.hit({ x: 400, y: 192.5 }), "error:notconnected");
    assert.equal(f.calls.filter((call) => call.name === "DOM.getFrameOwner").length, 1);
    assert.equal(f.releases.length, 1);
  }
});

test("deadline before snapshot sends no CDP; expiry during native read sends no subsequent command", async () => {
  const early = fixture(); early.expire(); await assert.rejects(early.clickable(), /deadline/); assert.equal(early.calls.length, 0);
  let f; f = fixture({ onSend(name) { if (name === "DOM.getBoxModel") f.expire(); } });
  await assert.rejects(f.clickable(), /deadline/);
  assert.deepEqual(f.calls.map((call) => call.name), ["DOM.getFrameOwner", "DOM.resolveNode", "DOM.getBoxModel"]);
  assert.equal(f.releases.length, 1);
});

test("late adoption is released even after the original budget expires", async () => {
  const held = deferred(), entered = deferred();
  const f = fixture({ onAdopt() { entered.resolve(); return held.promise; } });
  const operation = f.clickable(); await entered.promise; f.expire(); held.resolve();
  await assert.rejects(operation, /deadline/);
  assert.equal(f.adopted.length, 1); assert.equal(f.releases.length, 1);
  assert.equal(f.calls.some((call) => call.name === "DOM.getBoxModel"), false);
});

test("unknown or degenerate geometry never returns the upstream transformed hit shortcut", async () => {
  const f = fixture(); f.byBackend.get("oopif").raw = [0, 0, 0, 0, 0, 0, 0, 0];
  const result = await f.hit({ x: 400, y: 192.5 });
  assert.match(result.hitTargetDescription, /unusable frame geometry/); assert.equal("framePoint" in result, false);
  assert.equal(f.hits.length, 0); assert.equal(f.releases.length, 2);
});

test("actual upstream best-effort dispose preserves original errors without claiming release ACK", async () => {
  const native = Object.freeze(new Error("native failed")), cleanup = new Error("release failed");
  const f = fixture({ onSend(name) { if (name === "DOM.getBoxModel") throw native; }, releaseError: cleanup });
  await assert.rejects(f.clickable(), (error) => error === native); assert.equal(f.releases.length, 1);
  const f2 = fixture({ releaseError: cleanup }); near(await f2.clickable(), { x: 400, y: 192.5 });
  assert.ok(f2.adopted.every((handle) => handle._disposed)); assert.equal(f2.releases.length, 3);
});

test("target quads keep visible later fragments after a zero-area fragment", async () => {
  const f = fixture(); f.setTargetQuads([rect(20, 30, 0, 0), rect(40, 60, 50, 20)]);
  near(await f.clickable(), { x: 400, y: 192.5 });
});

test("source subpixel targets retain the upstream area threshold in final root coordinates", async () => {
  const f = fixture(); f.setTargetRaw(rect(40, 60, 0.5, 1));
  // Local area 0.5 becomes root area 1.5 through the original scale(2,1.5).
  near(await f.clickable(), { x: 419, y: 155.375 });
  f.setTargetRaw(rect(40, 60, 0.25, 1));
  assert.equal(await f.clickable(), "error:notinviewport");
});

test("source clipping rejects a behind-horizon offscreen target and retains a covering target", async () => {
  const f = fixture();
  // Keep same-process ancestors as identity planes and put a perspective on
  // the OOPIF renderer boundary: x in [0,100] maps safely, x=200 is a horizon.
  f.byBackend.get("same").raw = rect(0, 0, 400.5, 300.25);
  f.byBackend.get("oopif").raw = [0, 0, 200, 0, 200, 200, 0, 100];
  Object.assign(f.byBackend.get("oopif").node.style, { width: "100px", height: "100px" });
  f.frames[2].viewport.innerWidth = 100; f.frames[2].viewport.innerHeight = 100;
  f.byBackend.get("leaf").raw = rect(0, 0, 100, 100);
  Object.assign(f.byBackend.get("leaf").node.style, { width: "100px", height: "100px" });
  f.setTargetRaw(rect(150, 10, 100, 10)); assert.equal(await f.clickable(), "error:notinviewport");
  f.setTargetRaw(rect(-50, 10, 300, 10));
  const point = await f.clickable(); assert.ok(Number.isFinite(point.x) && Number.isFinite(point.y));
  const local = runtime.project(runtime.plane([0, 0, 200, 0, 200, 200, 0, 100], 100, 100).inverse, point);
  assert.ok(local.x >= 0 && local.x <= 100 && local.y >= 10 && local.y <= 20);
});

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
const rounded = (point) => ({ x: (point.x * 100 | 0) / 100, y: (point.y * 100 | 0) / 100 });
const boxStyle = { display: "block", width: "200px", height: "100px", boxSizing: "content-box",
  borderLeftWidth: "0px", borderRightWidth: "0px", borderTopWidth: "0px", borderBottomWidth: "0px",
  paddingLeft: "0px", paddingRight: "0px", paddingTop: "0px", paddingBottom: "0px" };

function method(source, from, to) {
  const start = source.indexOf(from), end = source.indexOf(to, start);
  assert.ok(start >= 0 && end > start);
  return source.slice(start, end);
}

// Execute the actual patched ElementHandle methods, serialized fixed utility
// functions, and original CRPage session/adoption route. Only CDP is simulated.
function fixture({ nested = true, onSend, onEvaluate, onAdopt, releaseError } = {}) {
  const calls = [], hits = [], releases = [], adopted = [], evaluations = [];
  let expired = false, aborted = false, serial = 0;
  const progress = { throwIfAborted() { if (aborted) throw new Error("Original action aborted"); }, timeUntilDeadline: () => expired ? 0 : 10000 };
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
    method(patched, "  async boundingBox(progress)", "  async ariaSnapshot(") +
    method(patched, "  async _checkFrameIsHitTarget(point, progress, position)", "\n};\nfunction throwRetargetableDOMError") +
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
          if (name === "DOM.getBoxModel") return params.objectId === "target" ? { model: { padding: [...targetPadding], border: [...targetBorder] } } :
            { model: { content: [...byObject.get(params.objectId).raw] } };
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
  let targetPadding = rect(40, 60, 50, 20);
  let targetBorder = rect(40, 60, 50, 20);
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
    node: { isConnected: true, ownerDocument: target.context.document, namespaceURI: "http://www.w3.org/1999/xhtml", localName: "span",
      style: { display: "inline", borderLeftWidth: "1.25px", borderTopWidth: "2.5px" },
      getClientRects: () => [{}], getBoundingClientRect: () => ({ x: 30, y: 40, width: 50, height: 20 }) } });
  return { handle, progress, frames, sessions, calls, hits, releases, adopted, evaluations, byBackend,
    expire() { expired = true; }, abort() { aborted = true; }, setTargetRaw(value) { targetRaw = value; }, setTargetQuads(value) { targetQuads = value; },
    setTargetPadding(value) { targetPadding = value; }, setTargetBorder(value) { targetBorder = value; },
    clickable: () => handle._clickablePoint(progress), hit: (point, position) => handle._checkFrameIsHitTarget(point, progress, position),
    offset: (offset) => handle._offsetPoint(offset, progress), bounding: () => handle.boundingBox(progress) };
}

test("pinned bundle patch installs progress-aware point and hit methods without transformed bypass", () => {
  assert.match(patched, /_offsetPoint\(position, progress2\).*_clickablePoint\(progress2\)/);
  assert.match(patched, /frameCheckResult = await this\._checkFrameIsHitTarget\(point, progress2, position\)/);
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

test("legacy inline position retains leaf local AABB origin then projects through rotated iframe ancestors", async () => {
  const f = fixture(); const point = await f.offset({ x: 3.5, y: 4.25 });
  // leaf=(34.75,46.75), OOPIF=(44.75,66.75), root=(406.5,162.125).
  near(point, { x: 406.5, y: 162.125 });
  assert.equal(f.calls.some((call) => call.name === "DOM.getContentQuads"), false);
});

test("explicit canvas position maps its padding plane rather than another point on the same scaled node", async () => {
  const f = fixture({ nested: false });
  Object.assign(f.handle.node, { localName: "canvas", style: { ...boxStyle, display: "inline",
    borderLeftWidth: "10px", borderRightWidth: "10px", borderTopWidth: "10px", borderBottomWidth: "10px" },
    getBoundingClientRect: () => ({ x: 100, y: 100, width: 440, height: 240 }) });
  f.setTargetPadding(rect(120, 120, 400, 200));
  near(await f.offset({ x: 150, y: 50 }), { x: 420, y: 220 });
  const hit = await f.hit({ x: 420, y: 220 }, { x: 150, y: 50 });
  assert.equal(hit.frameGeometry.at(-1).elementPosition.mode, "padding");
  // The inherited AABB answer (260,160) is still inside the same canvas. The
  // original node hit test alone cannot reject this semantic position error.
  assert.match((await f.hit({ x: 260, y: 160 }, { x: 150, y: 50 })).hitTargetDescription, /position geometry changed/);
});

test("single CSS padding plane preserves fractional sizing in both box-sizing modes", () => {
  const f = fixture({ nested: false }), node = f.handle.node;
  node.style = { ...boxStyle, width: "200.5px", height: "120.25px", paddingLeft: "12.25px", paddingRight: "12.25px",
    paddingTop: "7.75px", paddingBottom: "7.75px", borderLeftWidth: "3px", borderRightWidth: "3px",
    borderTopWidth: "3px", borderBottomWidth: "3px" };
  const read = () => runtime.readElementPlane([{ document: node.ownerDocument }, node]);
  near(read(), { width: 225, height: 135.75 });
  node.style.boxSizing = "border-box"; near(read(), { width: 194.5, height: 114.25 });
  // An inline non-replaced node ignores even an explicitly specified width.
  node.style.display = "inline"; assert.equal(read().mode, "legacy");
});

test("position composes a native same-process padding quad with only its OOPIF session map", async () => {
  const f = fixture(); f.handle.node.style = { ...boxStyle, width: "50px", height: "20px" };
  f.setTargetPadding(rect(40, 60, 100, 40));
  near(await f.offset({ x: 12.5, y: 5 }), { x: 400, y: 192.5 });
  const targetCalls = f.calls.filter((call) => call.name === "DOM.getBoxModel" && call.params.objectId === "target");
  assert.deepEqual(targetCalls.map((call) => call.session), ["oopif"]);
  near((await f.hit({ x: 400, y: 192.5 }, { x: 12.5, y: 5 })).framePoint, { x: 55, y: 50 });
});

test("position planes handle fractional CSS zoom, reflection and finite perspective", async () => {
  const f = fixture({ nested: false });
  f.handle.node.style = { ...boxStyle, width: "200.5px", height: "120.25px", zoom: "1.25" };
  f.setTargetPadding(rect(30.125, 40.25, 250.625, 150.3125));
  near(await f.offset({ x: 100.25, y: 60.125 }), { x: 155.4375, y: 115.40625 });
  f.handle.node.style = { ...boxStyle };
  f.setTargetPadding([300, 100, 100, 100, 100, 200, 300, 200]);
  near(await f.offset({ x: 20, y: 30 }), { x: 280, y: 130 });
  f.handle.node.style.width = "100px";
  f.setTargetPadding([10, 20, 210, 20, 110, 120, 10, 120]);
  near(await f.offset({ x: 25, y: 75 }), { x: 67.5 / 1.75, y: 185 / 1.75 });
});

test("position geometry changes before the first hit are retried and changes about the same point alter the fingerprint", async () => {
  const f = fixture({ nested: false }); f.handle.node.style = { ...boxStyle };
  f.setTargetPadding(rect(100, 100, 200, 100));
  const position = { x: 100, y: 50 }, point = rounded(await f.offset(position));
  const before = await f.hit(point, position);
  f.setTargetPadding(rect(0, 50, 400, 200)); // Scale about the unchanged center.
  const after = await f.hit(point, position);
  assert.ok(after.frameGeometry);
  assert.notEqual(JSON.stringify(before.frameGeometry), JSON.stringify(after.frameGeometry));
  f.setTargetPadding(rect(101, 100, 200, 100));
  assert.match((await f.hit(point, position)).hitTargetDescription, /position geometry changed/);
  f.handle.node.style.width = "100px";
  assert.match((await f.hit(point, position)).hitTargetDescription, /position geometry changed/);
});

test("legacy SVG and fragmented boxes keep inherited positions without native plane guesses", async () => {
  for (const kind of ["svg", "fragment", "auto", "inline"]) {
    const f = fixture({ nested: false }); f.handle.node.style = { ...boxStyle, borderLeftWidth: "1.25px", borderTopWidth: "2.5px" };
    if (kind === "svg") f.handle.node.namespaceURI = "http://www.w3.org/2000/svg";
    if (kind === "fragment") f.handle.node.getClientRects = () => [{}, {}];
    if (kind === "auto") f.handle.node.style.width = "auto";
    if (kind === "inline") f.handle.node.style.display = "inline";
    const position = { x: 3.5, y: 4.25 }, point = await f.offset(position);
    near(point, { x: 34.75, y: 46.75 });
    assert.equal((await f.hit(point, position)).frameGeometry.at(-1).elementPosition.mode, "legacy");
    assert.equal(f.calls.some((call) => call.name === "DOM.getBoxModel"), false);
  }
});

test("ordinary clicks do not inspect or require the new target padding plane", async () => {
  const f = fixture({ nested: false });
  f.handle.node.getClientRects = () => { throw new Error("must not read target style or geometry"); };
  near(await f.clickable(), { x: 65, y: 70 });
  assert.ok((await f.hit({ x: 65, y: 70 })).frameGeometry);
  assert.equal(f.calls.some((call) => call.name === "DOM.getBoxModel"), false);
});

test("invalid position planes and changed original contexts stop without legacy fallback or later native calls", async () => {
  const f = fixture({ nested: false }); f.handle.node.style = { ...boxStyle };
  f.setTargetPadding(rect(0, 0, 0, 0));
  assert.equal(await f.offset({ x: 1, y: 2 }), "error:notvisible");
  assert.match((await f.hit({ x: 1, y: 2 }, { x: 1, y: 2 })).hitTargetDescription, /unusable frame geometry/);
  let g; g = fixture({ nested: false, onSend(name, params) { if (params.objectId === "target") g.expire(); } });
  g.handle.node.style = { ...boxStyle };
  await assert.rejects(g.offset({ x: 1, y: 2 }), /deadline/);
  assert.deepEqual(g.calls.map((call) => call.name), ["DOM.getBoxModel"]);
  let h; h = fixture({ nested: false, onSend(name, params) { if (params.objectId === "target") h.frames[0].context.destroyed = true; } });
  h.handle.node.style = { ...boxStyle };
  assert.equal(await h.offset({ x: 1, y: 2 }), "error:notconnected");
  assert.deepEqual(h.calls.map((call) => call.name), ["DOM.getBoxModel"]);
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

test("bounding preserves un-clipped native border coordinates, fractional and zero extents", async () => {
  const f = fixture({ nested: false });
  for (const [x, y, width, height] of [[-70.25, -40.5, 1400.75, 1200.125], [10, 20, 0, 30.25], [10, 20, 30.25, 0], [10, 20, 0, 0]]) {
    f.setTargetBorder(rect(x, y, width, height));
    near(await f.bounding(), { x, y, width, height });
  }
  assert.ok(f.calls.every((call) => call.name === "DOM.getBoxModel" && call.params.objectId === "target"));
  assert.equal(f.evaluations.length, 0, "bounding has no viewport clipping dependency");
  await assert.rejects(runtime.bounding(f.handle), /original action progress/);
});

test("bounding projects native border corners before deriving root AABB across renderer boundaries", async () => {
  const f = fixture();
  const transform = (x, y) => [100 + 1.2 * x - .7 * y, 50 + .8 * x + 1.1 * y];
  f.byBackend.get("oopif").raw = [[0, 0], [300.4, 0], [300.4, 200.25], [0, 200.25]].flatMap(([x, y]) => transform(x, y));
  f.setTargetBorder([40, 60, 80, 100, 60, 120, 20, 80]);
  near(await f.bounding(), { x: 68, y: 148, width: 58, height: 82 });
  // The local AABB followed by projection would produce width 114, height 114.
  assert.deepEqual(f.calls.filter((call) => call.params.objectId === "target").map((call) => call.session), ["oopif"]);
  assert.equal(f.releases.length, 3);
});

test("bounding supports finite perspective without using the target frame map twice", async () => {
  const f = fixture();
  const transform = (x, y) => { const w = 1 + .002 * x + .001 * y; return [(100 + 1.5 * x - .3 * y) / w, (50 + .4 * x + 1.2 * y) / w]; };
  f.byBackend.get("oopif").raw = [[0, 0], [300.4, 0], [300.4, 200.25], [0, 200.25]].flatMap(([x, y]) => transform(x, y));
  const points = [[40, 60], [80, 100], [60, 120], [20, 80]];
  f.setTargetBorder(points.flat());
  const expected = points.map(([x, y]) => transform(x, y));
  const x = Math.min(...expected.map((p) => p[0])), y = Math.min(...expected.map((p) => p[1]));
  near(await f.bounding(), { x, y, width: Math.max(...expected.map((p) => p[0])) - x, height: Math.max(...expected.map((p) => p[1])) - y });
});

test("bounding ignores same-renderer inverse requirements while retaining native no-layout and route checks", async () => {
  const f = fixture();
  f.byBackend.get("same").raw = rect(10, 20, 0, 0);
  f.byBackend.get("same").node.style.width = "0px";
  f.frames[1].viewport.innerWidth = 0;
  f.byBackend.get("leaf").raw = rect(40, 60, 0, 100);
  f.byBackend.get("leaf").node.style.width = "0px";
  f.frames[3].viewport.innerWidth = 0;
  // Native target coordinates already contain all same-renderer transforms.
  f.setTargetBorder(rect(40, 60, 0, 20));
  near(await f.bounding(), { x: 380, y: 155, width: 40, height: 0 });
  f.byBackend.get("oopif").raw = rect(10, 20, 0, 100);
  await assert.rejects(f.bounding(), /Degenerate/);
});

test("bounding returns null only for confirmed native missing layout, including hidden ancestors", async () => {
  for (const object of ["target", "owner"]) {
    const f = fixture({ onSend(name, params) {
      if (name === "DOM.getBoxModel" && (object === "target" ? params.objectId === "target" : params.objectId.startsWith("owner-")))
        throw new Error("Protocol error (DOM.getBoxModel): Could not compute box model.");
    } });
    assert.equal(await f.bounding(), null);
    assert.equal(f.releases.length, object === "target" ? 3 : 1);
  }
  const native = new Error("Protocol error: target session closed");
  const f = fixture({ onSend(name) { if (name === "DOM.getBoxModel") throw native; } });
  await assert.rejects(f.bounding(), (error) => error === native);
  const malformed = fixture({ nested: false }); malformed.setTargetBorder([0, 0, NaN, 1, 2, 2, 3, 3]);
  await assert.rejects(malformed.bounding(), /Invalid native border/);
});

test("bounding cancellation, navigation and route changes win over native missing-layout results", async () => {
  const mutations = [
    [(f) => f.abort(), /Original action aborted/],
    [(f) => f.expire(), /deadline/],
    [(f) => { f.frames[1].pending = {}; }, /changed document or route/],
    [(f) => { f.frames[1].context.destroyed = true; }, /changed document or route/],
    [(f) => { f.handle._page.delegate._sessions.set("same", {}); }, /changed document or route/]
  ];
  for (const [mutate, error] of mutations) {
    let f; f = fixture({ onSend(name) {
      if (name === "DOM.getBoxModel") { mutate(f); throw new Error("Could not compute box model"); }
    } });
    await assert.rejects(f.bounding(), error);
    assert.deepEqual(f.calls.map((call) => call.name), ["DOM.getFrameOwner", "DOM.resolveNode", "DOM.getBoxModel"]);
    assert.equal(f.releases.length, 1);
  }
  const early = fixture(); early.abort(); await assert.rejects(early.bounding(), /aborted/); assert.equal(early.calls.length, 0);
  let late; late = fixture({ onSend(name, params) {
    if (name === "DOM.getBoxModel" && params.objectId === "target") late.frames.at(-1).context.destroyed = true;
  } });
  await assert.rejects(late.bounding(), /changed document or route/);
  assert.equal(late.releases.length, 3);
});

test("bounding rejects unsupported horizon extrapolation while preserving ordinary offscreen boxes", async () => {
  const f = fixture();
  f.byBackend.get("oopif").raw = [0, 0, 200, 0, 200, 200, 0, 100];
  Object.assign(f.byBackend.get("oopif").node.style, { width: "100px", height: "100px" });
  for (const border of [rect(150, 10, 100, 10), rect(250, 10, 50, 10), rect(200, 10, 0, 10)]) {
    f.setTargetBorder(border); await assert.rejects(f.bounding(), /projective horizon/);
  }
  f.setTargetBorder(rect(-50, -20, 10, 10));
  const value = await f.bounding(); assert.ok(value.x < 0 && value.y < 0);
});

// Use the pinned client, dispatcher, selector-budget calculation and real
// ProgressController. Only the transport, clock and native reads are fixtures.
function boundingChannel(f, { selectionTime = 25, absent = false, onProgress } = {}) {
  let now = 100, disposed = 0;
  const timers = new Map(), timeouts = [], channelCalls = [], active = new Set();
  const sandbox = { assert, monotonicTime: () => now,
    setTimeout(fn, ms) { const key = {}; timers.set(key, fn); timeouts.push(ms); return key; }, clearTimeout(key) { timers.delete(key); } };
  const ProgressController = vm.runInNewContext(method(upstream, "class ManualPromise extends Promise {", "class LongStandingScope {") +
    "class TimeoutError$1 extends Error {}\n" + method(upstream, "class ProgressController {", "const fileUploadSizeLimit$1") + "ProgressController", sandbox);
  const Dispatcher = vm.runInNewContext("(class {" + method(patched, "  async boundingBox(params, metadata)", "  async screenshot(params, metadata)") + "})", { ProgressController });
  const ClientHandle = vm.runInNewContext("(class {" + method(patched, "  async boundingBox(options2 = {})", "  async screenshot(options2 = {})") + "})");
  const Locator = vm.runInNewContext(method(upstream, "class TimeoutError2 extends Error {", "class TargetClosedError2") + "class Locator {" +
    method(patched, "  async _withElement(task, options2)", "  _equals(locator)") +
    method(patched, "  async boundingBox(options2) {", "  async check(options2 = {})") + "}; Locator", {
    monotonicTime: () => now, ElementHandle2: { fromNullable: (value) => value }
  });
  f.handle.instrumentation = { onCallLog() {} }; f.handle.attribution = { context: { _activeProgressControllers: active } };
  const serverBounding = f.handle.boundingBox;
  f.handle.boundingBox = function(progress) { if (onProgress) onProgress(progress); return serverBounding.call(this, progress); };
  const dispatcher = new Dispatcher(); dispatcher._elementHandle = f.handle;
  const client = new ClientHandle();
  const frame = { _timeout: (options) => options?.timeout ?? 100, _wrapApiCall: (fn) => fn(), _channel: {
    async waitForSelector(params) {
      assert.equal(params.strict, true); assert.equal(params.state, "attached"); now += selectionTime;
      if (absent) throw new Error("selector deadline exceeded");
      return { element: client };
    }
  } };
  client._frame = frame; client.dispose = async () => { disposed++; };
  client._elementChannel = { boundingBox(params) { channelCalls.push(params); return dispatcher.boundingBox(params, { log: [] }); } };
  const locator = new Locator(); locator._frame = frame; locator._selector = "#original";
  return { locator, client, active, timers, timeouts, channelCalls, disposed: () => disposed,
    fireDeadline() { for (const timer of [...timers.values()]) timer(); } };
}

test("actual bounding channel preserves the locator's remaining budget through its real controller", async () => {
  const f = fixture(), c = boundingChannel(f);
  near(await c.locator.boundingBox({ timeout: 100 }), { x: 380, y: 155, width: 40, height: 75 });
  assert.deepEqual(plain(c.channelCalls), [{ timeout: 75 }]); assert.deepEqual(c.timeouts, [75]);
  assert.equal(c.disposed(), 1); assert.equal(c.active.size, 0); assert.equal(c.timers.size, 0);
  const unlimited = boundingChannel(fixture({ nested: false }), { selectionTime: 200 });
  await unlimited.locator.boundingBox({ timeout: 0 });
  assert.equal(unlimited.channelCalls[0].timeout, 0);
  assert.deepEqual(unlimited.timeouts, [2147483647], "explicit upstream unlimited timeout keeps its existing convention");
});

test("locator deadline exhausted by selector resolution never becomes an unlimited native bounding query", async () => {
  for (const selectionTime of [100, 101]) {
    const f = fixture(), c = boundingChannel(f, { selectionTime });
    await assert.rejects(c.locator.boundingBox({ timeout: 100 }), (error) => error.name === "TimeoutError" && /100ms/.test(error.message));
    assert.equal(f.calls.length, 0); assert.equal(c.channelCalls.length, 0); assert.equal(c.disposed(), 1);
  }
  const absent = fixture(), c = boundingChannel(absent, { selectionTime: 100, absent: true });
  await assert.rejects(c.locator.boundingBox({ timeout: 100 }), /selector deadline/);
  assert.equal(absent.calls.length, 0); assert.equal(c.channelCalls.length, 0); assert.equal(c.disposed(), 0);
});

test("actual controller cancellation releases a late owner without replaying or finishing a stale box", async () => {
  const held = deferred(), entered = deferred();
  const f = fixture({ onAdopt() { entered.resolve(); return held.promise; } }), c = boundingChannel(f);
  const result = c.locator.boundingBox({ timeout: 100 }); await entered.promise;
  assert.equal(c.active.size, 1); c.fireDeadline();
  await assert.rejects(result, /Timeout 75ms/);
  held.resolve(); await new Promise((resolve) => setImmediate(resolve));
  assert.equal(c.disposed(), 1); assert.equal(f.releases.length, 1);
  assert.equal(f.calls.some((call) => call.name === "DOM.getBoxModel"), false);
  assert.equal(c.active.size, 0);
});

test("native owner responses arriving after the controller deadline cannot resume geometry or return null", async () => {
  for (const missingLayout of [false, true]) {
    const held = deferred(), entered = deferred();
    const f = fixture({ async onSend(name) {
      if (name === "DOM.getBoxModel") {
        entered.resolve(); await held.promise;
        if (missingLayout) throw new Error("Could not compute box model");
      }
    } }), c = boundingChannel(f);
    const result = c.locator.boundingBox({ timeout: 100 }); await entered.promise; c.fireDeadline();
    await assert.rejects(result, /Timeout 75ms/);
    const callCount = f.calls.length; held.resolve(); await new Promise((resolve) => setImmediate(resolve));
    assert.equal(f.calls.length, callCount); assert.equal(f.releases.length, 1);
    assert.equal(c.disposed(), 1); assert.equal(c.active.size, 0);
  }
});

test("actual element screenshot uses its existing progress and projected root box before scroll and integer enclosure", async () => {
  const f = fixture(), captures = [], progressSeen = [];
  const Screenshotter = vm.runInNewContext("(class {" + method(patched, "  async screenshotElement(progress2, handle, options2)", "  async _preparePageForScreenshot(") + "})", {
    assert, validateScreenshotOptions: () => "png", helper: vm.runInNewContext("(class {" + method(upstream, "  static enclosingIntRect(rect)", "  static enclosingIntSize(size)") + "})")
  });
  const screenshotter = new Screenshotter(); f.progress.log = () => {};
  screenshotter._queue = { postTask: (fn) => fn() };
  screenshotter._page = f.handle._page;
  f.frames[0].waitForFunctionValueInUtility = async (progress) => { progressSeen.push(progress); return { x: 10.25, y: 20.75 }; };
  screenshotter._originalViewportSize = async (progress) => { progressSeen.push(progress); return { width: 1000, height: 1000 }; };
  screenshotter._preparePageForScreenshot = async (progress) => { progressSeen.push(progress); };
  screenshotter._restorePageAfterScreenshot = async () => {};
  f.handle._waitAndScrollIntoViewIfNeeded = async (progress) => { progressSeen.push(progress); };
  screenshotter._screenshot = async (progress, format, documentRect) => { progressSeen.push(progress); captures.push(plain(documentRect)); return "image"; };
  assert.equal(await screenshotter.screenshotElement(f.progress, f.handle, {}), "image");
  assert.deepEqual(captures, [{ x: 390, y: 175, width: 41, height: 76 }]);
  assert.ok(progressSeen.every((progress) => progress === f.progress));
  f.setTargetBorder(rect(40, 60, 0, 20));
  await assert.rejects(screenshotter.screenshotElement(f.progress, f.handle, {}), /Node has 0 height/);
  assert.equal(captures.length, 1, "zero-size bounding boxes retain screenshot's existing rejection");
  f.handle._waitAndScrollIntoViewIfNeeded = async (progress) => { assert.equal(progress, f.progress); f.expire(); };
  const nativeCount = f.calls.length;
  await assert.rejects(screenshotter.screenshotElement(f.progress, f.handle, {}), /deadline/);
  assert.equal(f.calls.length, nativeCount); assert.equal(captures.length, 1, "scrolling cannot refresh the screenshot budget");
});

test("every new fixed-bundle bounding and screenshot replacement fails closed on upstream drift", () => {
  for (const [anchor, label] of [
    ["return this._page.delegate.getBoundingBox(this);", "server bounding box"],
    ["const boundingBox = await handle.boundingBox();", "element screenshot progress"],
    ["scheme.ElementHandleBoundingBoxParams = tOptional(tObject({}));", "private timeout schema"],
    ["const value = await this._elementHandle.boundingBox();", "dispatcher progress"],
    ["const value = (await this._elementChannel.boundingBox()).value;", "client bounding box timeout"],
    ['return await this._withElement((h) => h.boundingBox(), { title: "Bounding box", timeout: options2 == null ? void 0 : options2.timeout });', "remaining timeout"]
  ]) assert.throws(() => patchCrxFrameGeometry(upstream.replace(anchor, anchor.slice(0, -1) + " /* drift */ " + anchor.at(-1))), new RegExp(label));
  assert.match(patched, /ElementHandleBoundingBoxParams = tOptional\(tObject\(\{ timeout: tOptional\(tNumber\) \}\)\)/);
});

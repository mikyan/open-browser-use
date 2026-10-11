// Opt-in geometry acceptance. The oracle reads fixture DOM in each document;
// it never uses locator.boundingBox or turns child coordinates into root ones.
import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import path from "node:path";
import { decodeParallelPNG, parallelMarkerCode } from "./background-parallel-workflow.mjs";
import { fixtureRef } from "./ai-snapshot-fixture.mjs";

const hash = value => createHash("sha256").update(value).digest("hex");
export const geometryRoles = ["root", "shadow", "marker", "same", "cross", "nested", "inner"];
export function resolveGeometryDPR(value, enabled) {
  if (!enabled) { assert.equal(value, undefined, "OBU_TEST_GEOMETRY_DPR requires OBU_TEST_SNAPSHOT_GEOMETRY=1"); return undefined; }
  assert.ok(["1", "1.5", "2"].includes(value), "OBU_TEST_GEOMETRY_DPR must be 1, 1.5 or 2 for snapshot geometry");
  return Number(value);
}
const label = role => `Geometry ${role} action`;

// All messages are restricted to the known direct WindowProxy, exact origin,
// nonce and request ID. No observer changes any snapshot result or input event.
function installGeometry(role, nonce) {
  const documentId = crypto.randomUUID();
  let phase = 0, serial = 0;
  const rect = node => { const r = node.getBoundingClientRect(); return { x: r.x, y: r.y, width: r.width, height: r.height }; };
  const frames = () => [...document.querySelectorAll("iframe[data-role]")];
  const local = () => ({ role, documentId, nonce, phase,
    viewport: { width: innerWidth, height: innerHeight, scrollX, scrollY, devicePixelRatio },
    targets: [{ role, box: rect(document.querySelector("#target")) }, ...(role === "root" ? [{ role: "shadow", box: rect(document.querySelector("#shadow").shadowRoot.querySelector("button")) }, { role: "marker", box: rect(document.querySelector("#marker")) }] : [])],
    owners: frames().map(frame => ({ role: frame.dataset.role, box: rect(frame) })) });
  function paint() {
    const marker = document.querySelector("#marker"); if (!marker) return;
    const code = nonce.slice(0, 8) + phase.toString(16).padStart(8, "0");
    marker.replaceChildren(...[...code].map(character => { const n = parseInt(character, 16), item = document.createElement("span"); item.style.background = `rgb(${40 + Math.floor(n / 4) * 48},${40 + n % 4 * 48},150)`; return item; }));
  }
  async function collect(change, requestedPhase) {
    if (change) {
      if (!Number.isInteger(requestedPhase) || requestedPhase < 0 || requestedPhase > 2) throw new Error("Invalid fixture phase");
      phase = requestedPhase;
      for (const frame of frames()) {
        frame.style.transformOrigin = "23px 17px";
        frame.style.transform = phase === 2 ? (frame.dataset.role === "same" ? "scale(0.8,1.1)" : "rotate(9deg) scale(1.1,0.85)") : "none";
      }
      scrollTo(phase === 0 ? 0 : role === "root" ? 36 : 12, phase === 0 ? 0 : role === "root" ? 160 : 72);
      paint();
    }
    const children = await Promise.all(frames().map(frame => new Promise((resolve, reject) => {
      const id = `${documentId}:${++serial}`, origin = new URL(frame.src).origin;
      const timer = setTimeout(() => { removeEventListener("message", listener); reject(new Error(`Fixture child ${frame.dataset.role} did not answer`)); }, 4000);
      const listener = event => {
        if (event.source !== frame.contentWindow || event.origin !== origin || event.data?.nonce !== nonce || event.data?.id !== id || event.data?.type !== "geometry-response") return;
        clearTimeout(timer); removeEventListener("message", listener);
        event.data.error ? reject(new Error(event.data.error)) : resolve(event.data.value);
      };
      addEventListener("message", listener);
      frame.contentWindow.postMessage({ type: "geometry-request", nonce, id, change, phase: requestedPhase }, origin);
    })));
    return { ...local(), children };
  }
  if (role === "root") {
    const root = document.querySelector("#shadow").attachShadow({ mode: "open" });
    root.innerHTML = '<style>button{box-sizing:border-box;width:177.5px;height:43.25px}</style><button>Geometry shadow action</button>';
  }
  addEventListener("message", event => {
    if (event.source !== parent || event.data?.type !== "geometry-request" || event.data?.nonce !== nonce || !["127.0.0.1", "localhost"].includes(new URL(event.origin).hostname) || new URL(event.origin).port !== location.port) return;
    collect(event.data.change === true, event.data.phase).then(value => event.source.postMessage({ type: "geometry-response", nonce, id: event.data.id, value }, event.origin), error => event.source.postMessage({ type: "geometry-response", nonce, id: event.data.id, error: String(error) }, event.origin));
  });
  globalThis.__snapshotGeometry = Object.freeze({ configure: value => collect(true, value), read: () => collect(false, phase) });
  paint();
}

export function geometryHTML(role, nonce, key, port) {
  assert.ok(["root", "same", "cross", "nested", "inner"].includes(role)); assert.match(nonce, /^[a-f0-9]{24}$/);
  const source = (child, host) => `http://${host}:${port}/snapshot-geometry-frame?key=${encodeURIComponent(key)}&role=${child}`;
  const iframe = (child, host, style) => `<iframe data-role="${child}" title="Geometry frame ${child}" src="${source(child, host)}" style="${style}"></iframe>`;
  const children = role === "root" ? iframe("same", "127.0.0.1", "left:40.25px;top:220.5px") + iframe("cross", "localhost", "left:520.5px;top:220.25px") + iframe("nested", "localhost", "left:40.75px;top:590.25px") : role === "nested" ? iframe("inner", "127.0.0.1", "left:24.25px;top:190.5px;width:340px;height:190px") : "";
  return `<!doctype html><meta charset="utf-8"><title>Snapshot geometry ${role}</title><style>
    body{margin:0;min-width:max(1600px,calc(100vw + 200px));min-height:max(2100px,calc(100vh + 200px));background:#fafafa;font:16px sans-serif}
    #target{position:absolute;left:80.25px;top:130.5px;box-sizing:border-box;width:170.5px;height:44.25px}
    #shadow{position:absolute;left:300.5px;top:130.25px}iframe{position:absolute;width:400px;height:250px;border:6px solid #627282}
    #marker{position:fixed;left:24px;top:16px;display:grid;grid-template-columns:repeat(8,30px);grid-template-rows:repeat(2,30px);width:240px;height:60px;border:0;padding:0;margin:0;box-sizing:border-box;z-index:5}#marker span{width:30px;height:30px}
    </style><button id="target">${label(role)}</button>${role === "root" ? '<div id="shadow"></div><button id="marker" aria-label="Geometry marker action"></button>' : ""}${children}<script>(${installGeometry.toString()})(${JSON.stringify(role)},${JSON.stringify(nonce)});</script>`;
}

export function createSnapshotGeometryFixture() {
  const records = new Map();
  return {
    handle(request, response, port) {
      const url = new URL(request.url, `http://${request.headers.host}`);
      if (!["/snapshot-geometry", "/snapshot-geometry-frame"].includes(url.pathname)) return false;
      const key = url.searchParams.get("key"), role = url.pathname === "/snapshot-geometry" ? "root" : url.searchParams.get("role");
      if (request.method !== "GET" || !/^[a-zA-Z0-9_-]{1,100}$/.test(key ?? "") || !["root", "same", "cross", "nested", "inner"].includes(role)) { response.writeHead(400); response.end("Invalid geometry request"); return true; }
      if (!records.has(key)) {
        if (role !== "root" || records.size >= 32) { response.writeHead(404); response.end("Unknown geometry task"); return true; }
        records.set(key, { key, nonce: randomBytes(12).toString("hex"), requests: [], overflow: false });
      }
      const record = records.get(key);
      if (record.requests.length >= 64) { record.overflow = true; response.writeHead(429); response.end("Geometry evidence limit"); return true; }
      const html = geometryHTML(role, record.nonce, key, port);
      record.requests.push({ at: Date.now(), method: request.method, url: url.href, role, bytes: Buffer.byteLength(html), sha256: hash(html) });
      response.setHeader("Content-Type", "text/html; charset=utf-8"); response.end(html); return true;
    },
    allStats: () => structuredClone([...records.values()])
  };
}

const near = (actual, expected, label) => assert.ok(Number.isFinite(actual) && Math.abs(actual - expected) <= 1e-6, `${label}: ${actual} != ${expected}`);
const fields = ["x", "y", "width", "height"];
const flatten = value => [value, ...value.children.flatMap(flatten)];
export function checkGeometryPhase(item) {
  const { before, after, capture, phase, dpr } = item;
  assert.equal(before.phase, phase); assert.equal(before.nonce, after.nonce); assert.match(before.nonce, /^[a-f0-9]{24}$/);
  assert.deepEqual(after, before, "Snapshot observation changed frame scroll, geometry or document identity");
  const documents = flatten(before); assert.deepEqual(documents.map(x => x.role), ["root", "same", "cross", "nested", "inner"]);
  assert.equal(capture.complete, true); assert.equal(capture.stats.frames, 5);
  assert.equal(capture.stats.bytes, Buffer.byteLength(capture.snapshot)); assert.equal(capture.stats.refs, capture.refs.length);
  const geometry = capture.geometry; assert.ok(geometry); assert.equal(geometry.coordinateSpace, "frame-viewport-css");
  assert.equal(geometry.frames.length, 5); assert.equal(geometry.frames[0].id, "root"); assert.equal(geometry.frames[0].parentId, null); assert.equal(geometry.frames[0].ownerRef, null);
  assert.equal(new Set(geometry.boxes.map(x => x.ref)).size, capture.refs.length); assert.deepEqual(geometry.boxes.map(x => x.ref).sort(), [...capture.refs].sort());
  const frames = new Map(), boxes = new Map(geometry.boxes.map(x => [x.ref, x]));
  for (const frame of geometry.frames) { assert.ok(!frames.has(frame.id)); if (frame.id !== "root") { assert.ok(frames.has(frame.parentId)); assert.equal(boxes.get(frame.ownerRef)?.frameId, frame.parentId); } frames.set(frame.id, frame); }
  const roleFrame = new Map(), checked = [];
  for (const document of documents) {
    assert.equal(document.nonce, before.nonce); assert.equal(document.phase, phase);
    for (const target of document.targets) {
      const ref = fixtureRef(capture, label(target.role)), native = boxes.get(ref); assert.ok(native);
      roleFrame.set(target.role, native.frameId);
      fields.forEach(field => near(native.box[field], target.box[field], `${target.role}.${field}`));
      const line = capture.snapshot.split("\n").find(value => value.includes(`button "${label(target.role)}"`));
      const inline = /\[box=([^\]]+)\]/.exec(line); assert.ok(inline, "Structured box has no inline coordinates");
      const numbers = inline[1].split(",").map(Number); assert.equal(numbers.length, 4); fields.forEach((field, index) => near(numbers[index], native.box[field], `inline ${target.role}.${field}`));
      const viewport = frames.get(native.frameId).viewport;
      for (const key of ["width", "height", "scrollX", "scrollY", "devicePixelRatio"]) near(viewport[key], document.viewport[key], `${target.role}.viewport.${key}`);
      checked.push({ role: target.role, ref, frameId: native.frameId, box: native.box, expected: target.box });
    }
  }
  assert.equal(roleFrame.get("root"), "root"); assert.equal(roleFrame.get("shadow"), "root"); assert.equal(roleFrame.get("marker"), "root");
  assert.equal(new Set(["root", "same", "cross", "nested", "inner"].map(role => roleFrame.get(role))).size, 5);
  for (const document of documents) for (const owner of document.owners) {
    const child = frames.get(roleFrame.get(owner.role)); assert.equal(child.parentId, roleFrame.get(document.role));
    fields.forEach(field => near(boxes.get(child.ownerRef).box[field], owner.box[field], `${owner.role}.owner.${field}`));
  }
  for (const document of documents) near(document.viewport.devicePixelRatio, dpr, `${document.role} startup DPR`);
  assert.equal(before.viewport.scrollX, phase === 0 ? 0 : 36); assert.equal(before.viewport.scrollY, phase === 0 ? 0 : 160);
  for (const document of documents.slice(1)) { assert.equal(document.viewport.scrollX, phase === 0 ? 0 : 12); assert.equal(document.viewport.scrollY, phase === 0 ? 0 : 72); }
  if (phase === 0) for (const old of [item.defaultCapture, item.falseCapture]) { assert.ok(old); assert.deepEqual(Object.keys(old).sort(), ["captureId", "complete", "refs", "snapshot", "stats"]); assert.equal(old.geometry, undefined); assert.ok(!old.snapshot.includes("[box=")); }
  const bytes = Buffer.from(item.screenshot.base64, "base64"), png = decodeParallelPNG(bytes); assert.equal(item.screenshot.mimeType, "image/png");
  assert.equal(png.width, Math.round(before.viewport.width * dpr)); assert.equal(png.height, Math.round(before.viewport.height * dpr));
  const code = parallelMarkerCode(before.nonce.slice(0, 8), phase), samples = [];
  const marker = checked.find(item => item.role === "marker");
  assert.deepEqual(marker.box, { x: 24, y: 16, width: 240, height: 60 });
  for (let i = 0; i < code.length; i++) { const n = parseInt(code[i], 16), x = Math.floor((marker.box.x + (i % 8 + 0.5) * marker.box.width / 8) * dpr), y = Math.floor((marker.box.y + (Math.floor(i / 8) + 0.5) * marker.box.height / 2) * dpr), expected = [40 + Math.floor(n / 4) * 48, 40 + n % 4 * 48, 150]; assert.deepEqual(png.pixel(x, y), expected); samples.push({ ref: marker.ref, x, y, rgb: expected }); }
  return { phase, dpr, nonce: before.nonce, checked, maximumBoxDeviation: Math.max(...checked.flatMap(item => fields.map(field => Math.abs(item.box[field] - item.expected[field])))), png: { bytes: bytes.length, sha256: hash(bytes), width: png.width, height: png.height, samples } };
}

function traced(detail, kind) { return async (operation, args, call) => { const record = { index: detail.trace.length, kind, operation, args, requestedAt: Date.now() }; detail.trace.push(record); try { const value = await call(); record.completedAt = Date.now(); return value; } catch (error) { record.error = String(error); throw error; } }; }
export async function checkGeometryCaller({ kind, key, endpoint, fixtureURL, expectedDPR, connectOpenBrowserUse, executable, subprocess, withMCPClient }) {
  assert.ok([1, 1.5, 2].includes(expectedDPR));
  const detail = { kind, key, expectedDPR, phases: [], trace: [] }, trace = traced(detail, kind);
  const workflow = async adapter => {
    let finalized = false;
    try {
      detail.scope = adapter.scope; detail.tabId = await adapter.create();
      await adapter.goto(new URL(`snapshot-geometry?key=${key}`, fixtureURL).href);
      for (const phase of [0, 1, 2]) {
        const dpr = expectedDPR;
        const item = { phase, dpr }; detail.phases.push(item);
        item.before = await adapter.evaluate(`__snapshotGeometry.configure(${phase})`);
        if (phase === 0) { item.defaultCapture = await adapter.capture({}); item.falseCapture = await adapter.capture({ boxes: false }); }
        item.capture = await adapter.capture({ boxes: true });
        item.after = await adapter.evaluate("__snapshotGeometry.read()");
        item.screenshot = await adapter.screenshot();
      }
      if (adapter.readRefs) detail.refReads = await adapter.readRefs(detail.phases.at(-1).capture);
      finalized = true; detail.finalizeResult = await adapter.finalize(); return detail;
    } catch (error) { detail.error = String(error); error.geometryEvidence = detail; throw error; }
    finally { if (!finalized) { try { detail.cleanupResult = await adapter.finalize(); } catch (error) { detail.cleanupError = String(error); } } adapter.close(); }
  };
  if (kind === "js") {
    const browser = await connectOpenBrowserUse({ socketPath: endpoint, sessionId: key, timeoutMs: 15000 }); let tab;
    try { await trace("beginTurn", {}, () => browser.client.beginTurn()); } catch (error) { browser.close(); detail.error = String(error); error.geometryEvidence = detail; throw error; }
    return workflow({ scope: { session_id: key, turn_id: browser.client.turnId, control_epoch: browser.client.controlEpoch }, create: () => trace("newTab", {}, async () => (tab = await browser.newTab()).id), goto: url => trace("goto", { url }, () => tab.goto(url)),
      evaluate: expression => trace("evaluate", { expression }, () => tab.evaluate(expression, { awaitPromise: true })),
      capture: options => trace("snapshotAI", options, () => tab.snapshotAI(options)), screenshot: () => trace("screenshot", {}, () => tab.screenshot()),
      readRefs: async capture => { const results = []; for (const role of ["root", "same", "cross", "inner"]) { const ref = fixtureRef(capture, label(role)), locator = tab.getByRef(capture.captureId, ref); const count = await trace("getByRef.count", { captureId: capture.captureId, ref }, () => locator.count()), text = await trace("getByRef.innerText", { captureId: capture.captureId, ref }, () => locator.innerText()); assert.equal(count, 1); assert.equal(text, label(role)); results.push({ role, ref, count, text }); } return results; },
      finalize: () => trace("finalizeTabs", {}, () => browser.client.finalizeTabs([])), close: () => browser.close() });
  }
  const wire = async call => {
    const control = await call("getControlState", { session_id: key, turn_id: "geometry" }), scope = { session_id: key, turn_id: "geometry", control_epoch: control.controlEpoch }; let tabId;
    const request = (method, params) => trace(method, params, () => call(method, { ...scope, ...params }));
    const action = async (name, args = {}) => (await request("browserAction", { tabId, action: name, args, timeoutMs: 10000 })).value;
    return workflow({ scope, create: async () => (tabId = (await request("createTab", {})).id), goto: url => action("goto", { url }), capture: args => action("snapshotAI", args), screenshot: () => action("screenshot"),
      evaluate: async expression => { const result = await request("executeCdp", { target: { tabId }, method: "Runtime.evaluate", commandParams: { expression, awaitPromise: true, returnByValue: true }, timeoutMs: 10000 }); assert.equal(result.exceptionDetails, undefined); return result.result.value; },
      finalize: () => request("finalizeTabs", { keep: [] }), close() {} });
  };
  if (kind === "mcp") return withMCPClient(executable, endpoint, key, wire);
  assert.equal(kind, "cli");
  return wire(async (method, params) => { const response = JSON.parse(await subprocess(path.resolve(executable), ["call", "--socket", endpoint, "--session-id", key, "--method", method, "--params", JSON.stringify(params), "--timeout", "15s"])); assert.equal(response.error, undefined, JSON.stringify(response.error)); return response.result; });
}

export async function checkGeometryLimits({ browser, fixtureURL }) {
  const tab = await browser.newTab();
  await tab.goto(new URL("snapshot-geometry?key=geometry-limits", fixtureURL).href);
  await tab.evaluate("__snapshotGeometry.configure(0)", { awaitPromise: true });
  const old = await tab.snapshotAI(), limitErrors = [];
  for (const field of ["maxBytes", "maxNodes", "maxRefs", "maxFrames", "maxDepth"]) {
    await assert.rejects(tab.snapshotAI({ boxes: true, [field]: 1, timeoutMs: 3000 }), error => { limitErrors.push({ field, error: String(error) }); return /OBU_SNAPSHOT_LIMIT/.test(String(error)); });
  }
  await assert.rejects(tab.snapshotAI({ boxes: true, maxBytes: old.stats.bytes + 1 }), /OBU_SNAPSHOT_LIMIT/);
  const capture = await tab.snapshotAI({ boxes: true }), ref = fixtureRef(capture, label("root"));
  await tab.goto(new URL("snapshot-geometry?key=geometry-limits-navigation", fixtureURL).href);
  await assert.rejects(tab.getByRef(capture.captureId, ref).count(), /OBU_CAPTURE_EXPIRED/);
  await tab.evaluate("document.body.remove()");
  const startedAt = Date.now(); let timeoutError;
  await assert.rejects(tab.snapshotAI({ boxes: true, timeoutMs: 600 }), error => { timeoutError = String(error); return /OBU_SNAPSHOT_INCOMPLETE|timed out|timeout/i.test(timeoutError); });
  const elapsedMs = Date.now() - startedAt; assert.ok(elapsedMs < 3000);
  return { tabId: tab.id, limitErrors, maxBytesIncludesInlineBoxes: true, expiredCapture: capture.captureId, timeoutError, elapsedMs };
}

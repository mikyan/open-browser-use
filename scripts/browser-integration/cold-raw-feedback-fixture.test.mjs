import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { deflateSync } from "node:zlib";
import { frameTargetURLs, frameTargetStyle, frameTargetGeometry, frameTargetRootPoint } from "./frame-target-feedback-fixture.mjs";
import { coldRawLayouts, coldRawInputPoint, coldRawAddPoint, checkColdRawBusiness, checkColdRawNative, checkColdRawFeedback, installColdRawProbe } from "./cold-raw-feedback-fixture.mjs";

const hash = bytes => createHash("sha256").update(bytes).digest("hex"), center = r => ({ x: r.x + r.width / 2, y: r.y + r.height / 2 });
const near = (a, b) => Math.abs(a - b) < .00001;
const copy = value => structuredClone(value);
const box = points => { const x = Math.min(...points.map(p => p.x)), y = Math.min(...points.map(p => p.y)); return { x, y, width: Math.max(...points.map(p => p.x)) - x, height: Math.max(...points.map(p => p.y)) - y }; };
function planePoint(x, y, { left, top, originX, originY, angle, sx = 1, sy = 1 }) { const r = angle * Math.PI / 180; return { x: left + originX + (x - originX) * Math.cos(r) * sx - (y - originY) * Math.sin(r) * sy, y: top + originY + (x - originX) * Math.sin(r) * sx + (y - originY) * Math.cos(r) * sy }; }
function matrix(angle, sx = 1, sy = 1) { const r = angle * Math.PI / 180; return `matrix(${[Math.cos(r) * sx, Math.sin(r) * sx, -Math.sin(r) * sy, Math.cos(r) * sy, 0, 0].join(", ")})`; }
function sample(layout, key, tabId, oldOutline) {
  const urls = frameTargetURLs("http://127.0.0.1:52001", key, layout), roles = layout === "nested" ? ["root", "middle", "leaf"] : ["root", "leaf"], value = `Cold original ${layout} π note`;
  const initial = roles.map((role, i) => {
    const leaf = role === "leaf", f = frameTargetStyle(layout, role), token = id => `${key}-${role}-${id}`;
    const business = { key, layout, role, href: urls[role], documentToken: `${key}-${role}-doc`, windowToken: `${key}-${role}-window`, sameDocument: true, sameWindow: true,
      nodes: (leaf ? ["note", "submit", "form", "panel", "proof"] : layout === "dynamic-oopif" ? ["add", "frame"] : ["frame"]).map(id => ({ id, token: token(id), connected: true, original: true })), value: leaf ? "" : null,
      activeElement: "", selection: leaf ? { start: 0, end: 0, direction: "none" } : null, events: [], focus: [], changes: [], errors: [], overflow: false, receipt: null };
    const angle = layout === "rotated-oopif" ? -7 : 0, markers = leaf ? [["nw", 0, 0], ["ne", 280, 0], ["se", 280, 64], ["sw", 0, 64]].map(([id, x, y]) => ({ id, ...planePoint(x, y, { left: 46, top: 134, originX: 27, originY: 19, angle }), width: 0, height: 0 })) : [];
    const button = leaf ? { id: "submit", connected: true, rect: box(markers), styles: { left: "46px", top: "134px", width: "280px", height: "64px", transform: matrix(angle), transformOrigin: "27px 19px", zoom: "1", boxSizing: "border-box" } } : null;
    const frame = leaf ? null : { id: "frame", connected: true, rect: box([[0, 0], [f.width + 2 * f.border, 0], [f.width + 2 * f.border, f.height + 2 * f.border], [0, f.height + 2 * f.border]].map(([x, y]) => planePoint(x, y, f))), styles: { left: `${f.left}px`, top: `${f.top}px`, width: `${f.width}px`, height: `${f.height}px`, boxSizing: "content-box", borderLeftWidth: `${f.border}px`, borderRightWidth: `${f.border}px`, borderTopWidth: `${f.border}px`, borderBottomWidth: `${f.border}px`, paddingLeft: "0px", paddingTop: "0px", zoom: "1", transform: matrix(f.angle, f.sx, f.sy), transformOrigin: `${f.originX}px ${f.originY}px` } };
    return { business, geometry: { viewport: { width: i === 0 ? 1000 : role === "middle" ? 590 : 510, height: i === 0 ? 700 : role === "middle" ? 380 : 300, dpr: 1, scrollX: 0, scrollY: 0 }, frame, button,
      proof: button && { ...copy(button), id: "proof" }, markers },
      inputGeometry: leaf ? { connected: true, token: token("note"), rect: { x: 46, y: 48, width: 280, height: 36 }, styles: { left: "46px", top: "48px", width: "280px", height: "36px", transform: "none", zoom: "1", boxSizing: "border-box" } } : null,
      addGeometry: !leaf && layout === "dynamic-oopif" ? { connected: true, token: token("add"), rect: { x: 76, y: 20, width: 210, height: 32 }, styles: { left: "76px", top: "20px", width: "210px", height: "32px", transform: "none", zoom: "1", boxSizing: "border-box" } } : null,
      feedback: { connected: true, currentRoot: true, currentCount: i === 0 ? 1 : 0, rootIndex: 0, cursor: null, target: null, modelPoint: null }, rings: [],
      nativeFrameId: i, nativeDocumentId: `${key}-native-${i}`, nativeProcessId: layout === "same" ? 1 : i % 2 + 1 };
  });
  let preAdd, addPoint;
  if (layout === "dynamic-oopif") {
    preAdd = [copy(initial[0])]; preAdd[0].geometry.frame = null; preAdd[0].business.nodes = preAdd[0].business.nodes.filter(node => node.id === "add"); addPoint = coldRawAddPoint(preAdd[0]);
    initial[0].business.events = ["pointerdown", "pointerup", "click"].map((type, i) => ({ sequence: i + 1, type, targetId: "add", nodeToken: `${key}-root-add`, trusted: true, ...addPoint }));
    initial[0].business.changes = [{ sequence: 1, type: "add-frame", trusted: true, documentToken: initial[0].business.documentToken, sourceNode: `${key}-root-add`, childURL: urls.leaf }];
  }
  const geometry = frameTargetGeometry(initial, layout), inputPoint = coldRawInputPoint(initial, layout), buttonPoint = center(geometry.button), before = copy(initial);
  const event = (type, targetId, point) => ({ type, targetId, nodeToken: `${key}-leaf-${targetId}`, trusted: true, ...(point ?? {}), value: type === "input" ? value : "", key: null });
  for (const [i, row] of before.entries()) { row.business.activeElement = i === before.length - 1 ? "note" : "frame"; row.business.focus.push({ type: "focusin", targetId: row.business.activeElement, trusted: true }); }
  const entered = before.at(-1).business; entered.value = value; entered.selection = { start: value.length, end: value.length, direction: "none" };
  entered.events = [event("pointerdown", "note", { x: 186, y: 66 }), event("pointerup", "note", { x: 186, y: 66 }), event("click", "note", { x: 186, y: 66 }), event("input", "note")].map((row, i) => ({ sequence: i + 1, ...row }));
  const ring = (point, sequence) => ({ sequence, documentToken: initial[0].business.documentToken, rootIndex: 0, connected: true, currentRoot: true,
    rect: { x: point.x - 14, y: point.y - 14, width: 28, height: 28 }, modelPoint: point, color: "rgb(20, 184, 166)", opacity: 1 });
  before[0].rings = [...(addPoint ? [ring(addPoint, 1)] : []), ring(inputPoint, addPoint ? 2 : 1)]; const rendered = copy(before);
  rendered[0].feedback = { connected: true, currentRoot: true, currentCount: 1, rootIndex: 0, modelPoint: buttonPoint, target: oldOutline ? geometry.parents[0] : geometry.button, cursor: { x: buttonPoint.x - 12, y: buttonPoint.y - 12, width: 24, height: 24 } };
  const after = copy(rendered), leaf = after.at(-1).business;
  for (const [type, id] of [["pointerdown", "submit"], ["pointerup", "submit"], ["click", "submit"], ["submit", "form"]]) leaf.events.push({ sequence: leaf.events.length + 1, ...event(type, id, type === "submit" ? undefined : center(initial.at(-1).geometry.button.rect)) });
  after[0].rings.push(ring(buttonPoint, after[0].rings.length + 1)); const body = { key, layout, trustedSubmit: true, business: copy(leaf) }, bodyBytes = Buffer.from(JSON.stringify(body));
  const receipt = { key, layout, index: 1, bodySHA256: hash(bodyBytes) }; leaf.receipt = receipt;
  return { key, layout, tabId, urls, value, preAdd, addPoint, initial, before, rendered, after, geometry, inputPoint, buttonPoint,
    server: { key, gets: initial.map(row => ({ role: row.business.role, url: row.business.href, documentToken: row.business.documentToken })), posts: [{ index: 1, bodyBytes: bodyBytes.length, bodyBase64: bodyBytes.toString("base64"), bodySHA256: hash(bodyBytes), value: body, receipt }] } };
}

function chunk(type, data) { const size = Buffer.alloc(4), crc = Buffer.alloc(4), body = Buffer.concat([Buffer.from(type), data]); size.writeUInt32BE(data.length); let value = 0xffffffff; for (const byte of body) { value ^= byte; for (let i = 0; i < 8; i++) value = value >>> 1 ^ (value & 1 ? 0xedb88320 : 0); } crc.writeUInt32BE((value ^ 0xffffffff) >>> 0); return Buffer.concat([size, body, crc]); }
function png(geometry, oldOutline) {
  const width = geometry.viewport.width, height = geometry.viewport.height, data = Buffer.alloc((width * 3 + 1) * height, 238), rect = oldOutline ? geometry.parents[0] : geometry.button, point = center(geometry.button);
  for (let y = 0; y < height; y++) { data[y * (width * 3 + 1)] = 0; for (let x = 0; x < width; x++) { let rgb;
    if (Math.abs(x + .5 - point.x) < 5 && Math.abs(y + .5 - point.y) < 6) rgb = [20, 20, 20];
    if ((Math.abs(x + .5 - rect.x) < 1 || Math.abs(x + .5 - rect.x - rect.width) < 1) && y > rect.y && y < rect.y + rect.height || (Math.abs(y + .5 - rect.y) < 1 || Math.abs(y + .5 - rect.y - rect.height) < 1) && x > rect.x && x < rect.x + rect.width) rgb = [79, 140, 255];
    if (rgb) for (let i = 0; i < 3; i++) data[y * (width * 3 + 1) + x * 3 + i + 1] = rgb[i];
  } }
  const header = Buffer.alloc(13); header.writeUInt32BE(width); header.writeUInt32BE(height, 4); header[8] = 8; header[9] = 2;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk("IHDR", header), chunk("IDAT", deflateSync(data)), chunk("IEND", Buffer.alloc(0))]);
}

// These doubles prove orchestration and evidence handling, not native trust.
function workflow({ oldOutline = false, warm = false, receiptError, resourceWait = 0 } = {}) {
  const items = [], calls = [], artifacts = [], order = []; let current, saved;
  const state = () => ({ backendCurrent: true, registryCurrent: true, engineAbsent: !warm, attached: true, attachmentKnown: true, originalAttachmentSeen: true, sameAttachment: true });
  const append = row => current.native.records.push({ sequence: current.native.records.length + 1, state: state(), ...row });
  const record = (method, params, result = {}) => { const sequence = current.native.records.length + 1; append({ kind: "invoke", source: { tabId: current.tabId }, method, params }); append({ kind: "settled", invocation: sequence, ok: true, result }); return result; };
  const privateRead = () => {
    const prefix = `obu-native-pointer-fixture-${current.tabId}`, rootGroup = `${prefix}-0`;
    record("Runtime.evaluate", { objectGroup: rootGroup }, { result: { objectId: "original-root-wrapper" } });
    if (current.layout === "same") { record("Runtime.releaseObjectGroup", { objectGroup: rootGroup }); return; }
    const owner = { leaseId: `lease-${current.tabId}`, targetId: `child-${current.tabId}`, rootTargetId: `root-${current.tabId}`, parentFrameId: `root-${current.tabId}`, originalAttachment: true };
    current.native.ownedTargets.push(owner);
    const child = (method, params = {}, result = {}, error) => {
      const sequence = current.native.records.length + 1;
      append({ kind: "invoke", source: { targetId: owner.targetId }, owner: copy(owner), method, params });
      append({ kind: "settled", invocation: sequence, ok: error === undefined, ...(error ? { error } : { result }) });
    };
    child("Target.getTargetInfo", {}, {}, `Error: Debugger is not attached to the target with id: ${owner.targetId}.`);
    child("debugger.attach", { version: "1.3" });
    child("Page.getFrameTree", {}, { frameTree: { frame: { id: owner.targetId, parentId: owner.parentFrameId } } });
    child("Runtime.evaluate", { objectGroup: `${prefix}-1` }, { result: { objectId: "original-child-wrapper" } });
    record("Runtime.releaseObjectGroup", { objectGroup: rootGroup });
    child("Runtime.releaseObjectGroup", { objectGroup: `${prefix}-1` });
    child("debugger.detach", { version: null });
  };
  const frames = item => (item.stage === "preAdd" ? item.preAdd : item.initial).map((row, i) => ({ url: row.business.href, frameId: i, parentFrameId: i - 1, documentId: row.nativeDocumentId, processId: row.nativeProcessId, documentLifecycle: "active", errorOccurred: false }));
  const browser = { async newTab(...args) { assert.deepEqual(args, [], "Cold newTab may not carry a goto URL"); const tab = { id: items.length + 1 }; calls.push({ type: "newTab", tabId: tab.id }); return tab; }, cdp: {
    async navigate(tabId, url) { const address = new URL(url); assert.equal(tabId, current.tabId); assert.equal(address.href, current.urls.root); calls.push({ type: "navigate", tabId, url }); record("debugger.attach", { version: "1.3" }); const result = record("Page.navigate", { url }, { frameId: `root-${tabId}`, loaderId: `loader-${tabId}` }); append({ kind: "event", source: { tabId }, method: "Page.frameNavigated", params: { frame: { id: result.frameId, loaderId: result.loaderId, url } } }); record("Runtime.evaluate", { expression: "({ href: window.location.href, readyState: document.readyState })", returnByValue: true }, { result: { type: "object", value: { href: url, readyState: "complete" } } }); return result; },
    async call(tabId, method, params) { assert.equal(tabId, current.tabId); calls.push({ type: "cdp", tabId, method, params: copy(params) });
      if (method === "Page.getFrameTree") return record(method, params, { frameTree: { frame: { id: `root-${tabId}`, loaderId: `loader-${tabId}`, url: current.urls.root } } });
      if (method === "Input.insertText") { assert.deepEqual(params, { text: current.value }); current.stage = "before"; return record(method, params); }
      if (method === "Page.captureScreenshot") { assert.equal(current.stage, "rendered"); return record(method, params, { data: current.bytes.toString("base64") }); }
      assert.equal(method, "Input.dispatchMouseEvent"); if (params.type === "mouseMoved" && near(params.x, current.buttonPoint.x) && near(params.y, current.buttonPoint.y)) current.stage = "rendered";
      if (params.type === "mouseReleased" && current.addPoint && near(params.x, current.addPoint.x) && near(params.y, current.addPoint.y)) current.stage = "initial";
      if (params.type === "mouseReleased" && near(params.x, current.buttonPoint.x) && near(params.y, current.buttonPoint.y)) { current.stage = "after"; current.submitted = true; }
      const result = record(method, params);
      if (params.type === "mouseMoved" && near(params.x, current.buttonPoint.x) && near(params.y, current.buttonPoint.y)) privateRead();
      return result;
    }
  } };
  const worker = { async evaluate(code) {
    if (code.includes("globalThis.__integrationBackend?.browserEngine")) return { engineAbsent: !warm };
    if (code.includes("function installColdRawProbe")) { const config = JSON.parse(code.match(/\(chrome,globalThis,(\{[^\n]+\})\)$/)[1]); const layout = coldRawLayouts[items.length]; current = sample(layout, config.id, config.tabId, oldOutline); current.stage = layout === "dynamic-oopif" ? "preAdd" : "initial"; current.bytes = png(current.geometry, oldOutline); current.native = { tabId: current.tabId, records: [], pending: 0, overflow: false, recordingErrors: 0, restored: false, state: state(), resources: { pointerRecords: 0, privateLeases: 0 }, ownedTargets: [] }; items.push(current); return state(); }
    if (code.includes(".mark(")) { append({ kind: "state", label: JSON.parse(code.match(/\.mark\((.+)\)/)[1]) }); return state(); }
    if (code.includes("probe.restore()")) { current.native.restored = true; return copy(current.native); }
    if (code.includes("probe.snapshot()")) {
      assert.equal(current.submitted, true, "Resource observation must follow the final original input");
      order.push("resource-observation"); current.resourceObservations = (current.resourceObservations ?? 0) + 1;
      const result = copy(current.native); if (current.resourceObservations <= resourceWait) { result.pending = 1; result.resources.pointerRecords = 1; result.resources.privateLeases = 1; }
      return result;
    }
    if (code.includes("chrome.tabs.query")) return { tabs: [], targets: [], engineAbsent: !warm };
    if (code.includes("targets:await chrome.debugger.getTargets")) return { frames: frames(current), targets: [], engineAbsent: !warm };
    if (code.includes("chrome.webNavigation.getAllFrames")) return frames(current);
    if (code.includes("function waitForFrameTargetFeedback")) return [{ frameId: 0, documentId: current.initial[0].nativeDocumentId, result: copy(current.rendered[0]) }];
    if (code.includes("function readColdRawDocument")) return current[current.stage].map(row => ({ frameId: row.nativeFrameId, documentId: row.nativeDocumentId, result: copy(row) }));
    throw Error(`Unexpected cold read: ${code.slice(0, 90)}`);
  } };
  const ledger = item => ({ ...copy(item.server), posts: item.submitted ? copy(item.server.posts) : [] });
  return { browser, getWorker: () => worker, fixtureURL: "http://127.0.0.1:52001", fixtures: { stats: key => ledger(items.find(item => item.key === key)), allStats: () => items.map(ledger) },
    until: async (predicate, label) => { let matched = false; for (let i = 0; i < 4 && !matched; i++) matched = await predicate(); assert.equal(matched, true); if (receiptError && label.includes("receipt")) throw receiptError; },
    saveArtifact: async (name, bytes) => artifacts.push({ name, bytes }), saveDetail: async detail => { saved = copy(detail); },
    checkEnd: async detail => { assert.equal(detail.states.length, 6); assert.equal(artifacts.length, 6); order.push("end"); return { hidden: true }; },
    closeTab: async tab => { if (!warm) assert.ok(order.includes("end")); order.push(tab.id); },
    calls, artifacts, order, detail: () => saved };
}

for (const oldOutline of [false, true]) test(`cold raw uses only blank creation and public CDP in all six layouts${oldOutline ? ", preserving original transactions through visual red" : ""}`, async () => {
  const harness = workflow({ oldOutline }), result = checkColdRawFeedback(harness);
  if (oldOutline) await assert.rejects(result, /Original leaf button outline/); else await result;
  const detail = harness.detail(); assert.deepEqual(detail.states.map(item => item.layout), coldRawLayouts); assert.deepEqual(harness.order, [...Array(6).fill("resource-observation"), "end", 1, 2, 3, 4, 5, 6]); assert.equal(detail.serverLedger.flatMap(row => row.posts).length, 6);
  for (const item of detail.states) { assert.equal(item.businessPassed, true); assert.equal(item.nativePassed, true); assert.equal(item.visiblePassed, !oldOutline); assert.equal(item.native.state.engineAbsent, true); assert.equal(item.native.state.sameAttachment, true); assert.deepEqual(item.childTargetIds, [], "Cold proof does not require engine child attachment records");
    const artifact = harness.artifacts.find(row => row.name === `cold-raw-frame-${item.layout}.png`); assert.equal(hash(artifact.bytes), item.pixels.sha256);
    const calls = harness.calls.filter(row => row.tabId === item.tabId); assert.deepEqual(calls.slice(0, 2).map(row => row.type), ["newTab", "navigate"]);
    assert.deepEqual(calls.slice(2).map(row => row.method), ["Page.getFrameTree", ...(item.layout === "dynamic-oopif" ? Array(3).fill("Input.dispatchMouseEvent") : []), "Input.dispatchMouseEvent", "Input.dispatchMouseEvent", "Input.dispatchMouseEvent", "Input.insertText", "Input.dispatchMouseEvent", "Page.captureScreenshot", "Input.dispatchMouseEvent", "Input.dispatchMouseEvent"]);
    for (const call of calls.filter(row => row.method === "Input.dispatchMouseEvent")) assert.ok([item.inputPoint, item.buttonPoint, item.addPoint].filter(Boolean).some(point => near(call.params.x, point.x) && near(call.params.y, point.y)));
  }
});

test("warm engine is rejected before any page or public input is created", async () => {
  const harness = workflow({ warm: true }); await assert.rejects(checkColdRawFeedback(harness)); assert.deepEqual(harness.calls, []); assert.deepEqual(harness.detail().tabIds, []); assert.equal(harness.detail().initialEngine.engineAbsent, false);
});

test("original receipt error is preserved while all single submissions, PNGs and End are retained", async () => {
  const original = Error("Original cold receipt timed out"), harness = workflow({ receiptError: original }); await assert.rejects(checkColdRawFeedback(harness), error => error === original);
  const detail = harness.detail(); assert.equal(detail.states.length, 6); assert.equal(detail.serverLedger.flatMap(row => row.posts).length, 6); assert.equal(harness.artifacts.length, 6); assert.deepEqual(harness.order, [...Array(6).fill("resource-observation"), "end", 1, 2, 3, 4, 5, 6]); assert.ok(detail.states.every(item => item.native.restored && item.receiptError.includes(original.message)));
});

test("cold evidence rejects engine migration, missing original ACK, changed input geometry and non-original business", async () => {
  const harness = workflow(); await checkColdRawFeedback(harness); const item = harness.detail().states[1], bytes = harness.artifacts[1].bytes;
  for (const mutate of [value => { value.native.state.engineAbsent = false; }, value => { value.native.records[3].state.sameAttachment = false; }, value => { value.native.records.find(row => row.kind === "settled").ok = false; }, value => {
    const records = value.native.records, ack = records.find(row => row.kind === "settled");
    records.splice(records.indexOf(ack), 1);
    for (const row of records) { if (row.invocation > ack.sequence) row.invocation--; if (row.sequence > ack.sequence) row.sequence--; }
  }, value => { value.native.records.push({ sequence: value.native.records.length + 1, kind: "detached", state: value.native.state }); }]) { const changed = copy(item); mutate(changed); assert.throws(() => checkColdRawNative(changed, bytes)); }
  const wrong = copy(item.initial); wrong.at(-1).inputGeometry.rect.x++; assert.throws(() => coldRawInputPoint(wrong, item.layout));
  for (const mutate of [value => { value.after.at(-1).business.events[2].trusted = false; }, value => { value.after.at(-1).nativeDocumentId = "replacement"; }, value => { value.rendered.at(-1).business.focus.push({ type: "focusout" }); }, value => { value.server.posts.push(copy(value.server.posts[0])); }]) { const changed = copy(item); mutate(changed); assert.throws(() => checkColdRawBusiness(changed)); }
});

test("cold transformed input uses the authored frame plane rather than its AABB or transformed submit", () => {
  for (const [layout, angle, sx, sy] of [["scaled-oopif", 0, 1.17, .88], ["rotated-oopif", 11, .94, 1]]) {
    const item = sample(layout, "frame-feedback-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", 7, false);
    // Authored note centre (186,66), frame border 6, origin (21,17).
    const expected = planePoint(192, 72, { left: 76, top: 74, originX: 21, originY: 17, angle, sx, sy });
    assert.ok(near(item.inputPoint.x, expected.x) && near(item.inputPoint.y, expected.y));
    assert.notDeepEqual(item.inputPoint, center(item.geometry.button));
    const aabb = item.initial[0].geometry.frame.rect;
    assert.notDeepEqual(item.inputPoint, { x: aabb.x + 192, y: aabb.y + 72 });
  }
});

test("dynamic cold creation requires the one original trusted Add before the same root document", () => {
  const item = sample("dynamic-oopif", "frame-feedback-bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb", 8, false);
  checkColdRawBusiness(item);
  for (const mutate of [value => { value.preAdd[0].nativeDocumentId = "replacement"; }, value => { value.initial[0].business.events[2].trusted = false; }, value => { value.initial[0].business.changes[0].sourceNode = "another-node"; }, value => { value.initial[0].business.events.push(copy(value.initial[0].business.events[2])); }, value => { value.addPoint.x++; }]) {
    const changed = copy(item); mutate(changed); assert.throws(() => checkColdRawBusiness(changed));
  }
});

test("cold observer returns the exact native Promise and preserves unknown actual settlement", async () => {
  const event = () => { const listeners = new Set(); return { listeners, addListener: listener => listeners.add(listener), removeListener: listener => listeners.delete(listener) }; };
  let resolve; const original = new Promise(done => { resolve = done; }), token = {};
  const sendCommand = function (source, method, params) { assert.equal(this, api.debugger); assert.deepEqual(source, { tabId: 7 }); assert.equal(method, "Input.insertText"); assert.deepEqual(params, { text: "π" }); return original; };
  const api = { debugger: { sendCommand, attach: () => Promise.resolve(), detach: () => Promise.resolve(), onEvent: event(), onDetach: event() } }, target = { __integrationBackend: { browserEngine: null, attachmentEpochs: new Map([[7, token]]), attachedTabs: new Set([7]) } };
  installColdRawProbe(api, target, { id: "original", tabId: 7 }); assert.equal(api.debugger.sendCommand({ tabId: 7 }, "Input.insertText", { text: "π" }), original);
  assert.equal(target.__obuColdRawFeedback.snapshot().pending, 1); assert.equal(target.__obuColdRawFeedback.snapshot().records.filter(row => row.kind === "settled").length, 0);
  assert.throws(() => target.__obuColdRawFeedback.restore(), /unresolved/);
  resolve({ originalACK: true }); await original; const result = target.__obuColdRawFeedback.restore(); assert.equal(result.pending, 0); assert.equal(result.restored, true); assert.equal(result.state.sameAttachment, true);
  assert.deepEqual(result.records.at(-1).result, { originalACK: true }); assert.equal(api.debugger.sendCommand, sendCommand); assert.equal(api.debugger.onEvent.listeners.size, 0); assert.equal(api.debugger.onDetach.listeners.size, 0); assert.equal(target.__obuColdRawFeedback, undefined);
});

test("private observation requires the exact live registry lease and never changes native promises", async () => {
  const event = () => ({ addListener() {}, removeListener() {} }), token = {}, foreignToken = {};
  let resolve; const held = new Promise(done => { resolve = done; }), other = Promise.resolve({ foreign: true });
  const entry = { id: "lease-original", root: { tabId: 7, attachment: token, rootTargetId: "root-original" }, target: { targetId: "child-original" }, data: { parentFrameId: "root-original" } };
  const foreign = { ...entry, id: "lease-other", root: { ...entry.root, attachment: foreignToken }, target: { targetId: "child-other" } };
  const registry = { entries: new Map([[entry.id, entry], [foreign.id, foreign]]), targets: new Map([[entry.target.targetId, entry], [foreign.target.targetId, foreign]]) };
  const record = { scope: { tabId: 7, attachment: token } }, pending = new Set([record]);
  const api = { debugger: { sendCommand: source => source.targetId === entry.target.targetId ? held : other, attach: () => other, detach: () => other, onEvent: event(), onDetach: event() } };
  const target = { __integrationBackend: { browserEngine: null, privatePointerTargets: registry, pointerFeedbackReads: { pending }, attachmentEpochs: new Map([[7, token]]), attachedTabs: new Set([7]) } };
  installColdRawProbe(api, target, { id: "private", tabId: 7 }); const probe = target.__obuColdRawFeedback;
  assert.equal(api.debugger.sendCommand(entry.target, "Runtime.evaluate", { objectGroup: "obu-native-pointer-test-0" }), held);
  assert.equal(api.debugger.sendCommand(foreign.target, "Runtime.evaluate", {}), other);
  assert.equal(api.debugger.sendCommand({ targetId: "unowned" }, "Runtime.evaluate", {}), other);
  assert.equal(probe.snapshot().records.filter(row => row.kind === "invoke").length, 1);
  assert.deepEqual(probe.snapshot().records.find(row => row.kind === "invoke").owner, { leaseId: entry.id, targetId: entry.target.targetId, rootTargetId: "root-original", parentFrameId: "root-original", originalAttachment: true });
  resolve({ result: { objectId: "original" } }); await held;
  assert.equal(probe.snapshot().pending, 0); assert.throws(() => probe.restore(), /unresolved/);
  pending.delete(record); assert.throws(() => probe.restore(), /unresolved/);
  registry.entries.delete(entry.id); registry.targets.delete(entry.target.targetId);
  const done = probe.restore(); assert.equal(done.resources.privateLeases, 0); assert.equal(done.ownedTargets.length, 1); assert.equal(registry.entries.size, 1);
});

test("private native evidence rejects borrowed clients, unknown failures, missing releases and premature detach", async () => {
  const harness = workflow(); await checkColdRawFeedback(harness); const item = harness.detail().states[1], bytes = harness.artifacts[1].bytes;
  const calls = value => value.native.records.filter(row => row.kind === "invoke"), ack = (value, call) => value.native.records.find(row => row.invocation === call.sequence);
  const query = value => calls(value).find(row => row.owner && row.method === "Target.getTargetInfo");
  const release = value => calls(value).find(row => row.owner && row.method === "Runtime.releaseObjectGroup");
  const detach = value => calls(value).find(row => row.owner && row.method === "debugger.detach");
  const cases = [
    value => { ack(value, query(value)).error = "Error: Permission denied"; },
    value => { ack(value, query(value)).error = "Error: Debugger is not attached to the target with id: wrong."; },
    value => { ack(value, query(value)).ok = true; },
    value => { query(value).owner.originalAttachment = false; },
    value => { release(value).params.objectGroup = "obu-native-pointer-foreign-1"; },
    value => { ack(value, release(value)).ok = false; ack(value, release(value)).error = "Error: original release failed"; },
    value => {
      const rows = value.native.records, call = detach(value), reply = ack(value, call), groupRelease = release(value);
      rows.splice(rows.indexOf(reply), 1); rows.splice(rows.indexOf(call), 1); rows.splice(rows.indexOf(groupRelease), 0, call, reply);
      const renumber = new Map(rows.map((row, index) => [row.sequence, index + 1]));
      for (const row of rows) { if (row.invocation !== undefined) row.invocation = renumber.get(row.invocation); row.sequence = renumber.get(row.sequence); }
    },
    value => { detach(value).source.targetId = "successor"; },
    value => { detach(value).method = "Input.dispatchMouseEvent"; },
    value => { value.native.resources.privateLeases = 1; },
    value => { value.native.ownedTargets = []; }
  ];
  for (const mutate of cases) { const changed = copy(item); mutate(changed); assert.throws(() => checkColdRawNative(changed, bytes)); }
  assert.equal(item.nativeProof.privateProof.leases.length, 1); assert.equal(item.nativeProof.privateProof.groups.length, 2);
});

test("cold completion observes held original resources only after all input and retains their final trace", async () => {
  const harness = workflow({ resourceWait: 2 }); await checkColdRawFeedback(harness);
  const detail = harness.detail(); assert.equal(harness.order.filter(value => value === "resource-observation").length, 18);
  assert.ok(detail.states.every(item => item.nativePassed && item.resourceSettlement.pending === 0 && item.native.restored));
  assert.equal(detail.serverLedger.flatMap(item => item.posts).length, 6); assert.equal(harness.artifacts.length, 6);
});

test("only the exact original navigation by-value read is exempt from remote object group accounting", async () => {
  const harness = workflow(); await checkColdRawFeedback(harness);
  assert.ok(harness.detail().states.every(item => item.nativeProof.privateProof.navigationReads.length === 1));
  const item = harness.detail().states[1], bytes = harness.artifacts[1].bytes;
  const read = value => value.native.records.find(row => row.kind === "invoke" && row.method === "Runtime.evaluate" && row.params.objectGroup === undefined);
  const ack = value => value.native.records.find(row => row.invocation === read(value).sequence);
  for (const mutate of [
    value => { read(value).params.expression = "document.body"; },
    value => { read(value).params.returnByValue = false; },
    value => { read(value).params.contextId = 19; },
    value => { ack(value).result.result.objectId = "unexpected-remote-handle"; },
    value => { ack(value).result.exceptionDetails = { exception: { objectId: "unexpected-exception" } }; },
    value => { ack(value).result.result.value.extra = { objectId: "not-navigation-state" }; },
    value => { ack(value).result.result.value.readyState = "unknown"; },
    value => { const owner = value.native.ownedTargets[0]; read(value).source = { targetId: owner.targetId }; read(value).owner = copy(owner); },
    value => {
      const call = copy(read(value)), reply = copy(ack(value)), rows = value.native.records;
      call.sequence = rows.length + 1; reply.sequence = rows.length + 2; reply.invocation = call.sequence; rows.push(call, reply);
    }
  ]) { const changed = copy(item); mutate(changed); assert.throws(() => checkColdRawNative(changed, bytes)); }
});

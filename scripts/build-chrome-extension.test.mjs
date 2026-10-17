import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { test } from "node:test";
import { createRequire } from "node:module";
import { EventEmitter } from "node:events";
import vm from "node:vm";
import { patchCrxAISnapshot, patchInjectedAISnapshot } from "./patch-ai-snapshot.mjs";

const require = createRequire(new URL("../apps/chrome-extension/package.json", import.meta.url));
const packageDir = path.dirname(require.resolve("playwright-crx/package.json"));
const entry = await fs.readFile(path.join(packageDir, "lib/index.mjs"), "utf8");
const chunkName = /from ["']\.\/([^"']+\.mjs)/.exec(entry)[1];
const upstream = await fs.readFile(path.join(packageDir, "lib", chunkName), "utf8");
import { buildChromeExtension, patchCrxTransport } from "./build-chrome-extension.mjs";

const injectedLine = upstream.split("\n").find(line => line.startsWith("const source$4 = "));
const originalInjected = vm.runInNewContext(injectedLine.slice("const source$4 = ".length, -1));

test("bounded snapshot patch verifies private schema, dispatch and original generated ARIA shapes", () => {
  assert.throws(() => patchCrxAISnapshot("different bundle"), /shape changed/);
  assert.throws(() => patchCrxAISnapshot(upstream.replace("scheme.PageSnapshotForAIParams", "scheme.OtherParams")), /shape changed/);
  assert.throws(() => patchInjectedAISnapshot(originalInjected.replace("    visited.add(node);", "    visited.add(changedNode);")), /shape changed/);
  assert.throws(() => patchCrxAISnapshot(upstream.replace("\nfunction parseSelector(selector) {", "\nfunction changedSelector(selector) {")), /parser shape changed/);
  assert.throws(() => patchCrxAISnapshot(upstream.replace("\nfunction visitAllSelectorParts(selector, visitor) {", "\nfunction changedVisitor(selector, visitor) {")), /parser shape changed/);
});

function nativeSelectorGuard() {
  const source = patchCrxAISnapshot(upstream);
  // Execute the pinned tokenizer, CSS parser and selector parser unchanged.
  // Only the bundler's ordinary class-field helper is supplied by this VM.
  const parser = source.slice(source.indexOf("const between = function(num, first, last) {"), source.indexOf("\nfunction parseAttributeSelector(selector, allowUnquotedStrings) {"));
  const guardStart = source.lastIndexOf("export function assertOpenBrowserUseSelector(");
  const guardEnd = source.indexOf("\nconst obuSnapshotCaps", guardStart);
  const guard = source.slice(guardStart, guardEnd).replace("export function", "function");
  return vm.runInNewContext(parser + guard + "\nassertOpenBrowserUseSelector;", {
    __publicField: (object, key, value) => Object.defineProperty(object, key, { value, enumerable: true, configurable: true, writable: true })
  });
}

test("native selector parser rejects direct, captured, composite and recursively nested unscoped refs", () => {
  const check = nativeSelectorGuard();
  const nested = (kind, value, distance = "") => `body >> ${kind}=${JSON.stringify(value)}${distance}`;
  for (const selector of [
    "aria-ref=e1", " aria-ref = f2e7 ", "*aria-ref=e1", "body >> aria-ref=e1", "body >> *aria-ref=f2e7",
    ...["internal:has", "internal:has-not", "internal:and", "internal:or", "internal:chain", "left-of", "right-of", "above", "below", "near"].map(kind => nested(kind, "aria-ref=e1")),
    nested("near", "aria-ref=e1", ",50"), nested("internal:or", nested("internal:has-not", "aria-ref=e1")),
    'iframe >> internal:control=enter-frame >> aria-ref=f1e3'
  ]) assert.throws(() => check(selector), /OBU_REF_SELECTOR_REQUIRES_CAPTURE/, selector);
  for (const selector of [
    '[data-x="aria-ref=e1"]', 'css=[data-x="body >> aria-ref=e1"]', 'text="aria-ref=e1"', '"aria-ref=e1"',
    ':text-is("aria-ref=e1")', ':has-text("body >> aria-ref=e1")', 'internal:text="aria-ref=e1"i',
    'xpath=//*[@data-x="aria-ref=e1"]', nested("internal:has", '[data-x="aria-ref=e1"]'),
    nested("internal:and", nested("internal:or", 'text="aria-ref=e1"')), '*css=button'
  ]) assert.doesNotThrow(() => check(selector), selector);
});

test("restricted native selector guard rejects custom and framework engines recursively", () => {
  const check = nativeSelectorGuard();
  const nested = (kind, value) => `body >> ${kind}=${JSON.stringify(value)}`;
  for (const selector of [
    "_react=Component", "_vue=Component", "custom=privatePayload", "body >> custom=privatePayload", "*custom=privatePayload",
    "internal:control=unknown", ...["internal:has", "internal:has-not", "internal:and", "internal:or", "internal:chain"].map(kind => nested(kind, "_react=Component")),
    nested("internal:and", nested("internal:or", "custom=privatePayload")),
    "iframe >> internal:control=enter-frame >> _vue=Component"
  ]) {
    assert.throws(() => check(selector, true), error => {
      assert.match(error.message, /OBU_SITE_ACCESS_UNSUPPORTED/);
      assert.ok(!error.message.includes("privatePayload"));
      return true;
    }, selector);
    assert.doesNotThrow(() => check(selector), `legacy guard: ${selector}`);
  }
  for (const selector of ["aria-ref=e1", nested("internal:has", "aria-ref=f2e3")])
    assert.throws(() => check(selector, true), /OBU_REF_SELECTOR_REQUIRES_CAPTURE/);
});

test("restricted selector parsing preserves typed semantics and harmless engine-name literals", () => {
  const check = nativeSelectorGuard();
  for (const selector of [
    "button", "css=button", "css:light=button", "xpath=//button", "xpath:light=//button", "text=Submit", "text:light=Submit",
    "id=submit", "data-testid=submit", "data-test-id:light=submit", "data-test=submit", "button >> nth=0", "button >> visible=true",
    'role=button[name="Submit"]', 'internal:role=button[name="Submit"s]', 'internal:label="Name"i', 'internal:testid=[data-testid="submit"s]',
    'internal:attr=[placeholder="Name"i]', 'internal:text="Submit"i', 'button >> internal:has-text="Submit"i',
    'button >> internal:has-not-text="Cancel"i', 'button >> internal:describe="fixture"',
    'body >> internal:has="button"', 'body >> internal:has-not="button"', 'button >> internal:or="a"',
    'iframe >> internal:control=enter-frame >> button', '[data-x="_react=Component"]', ':text-is("custom=thing")',
    'text="body >> _vue=Component"', 'body >> internal:has="[data-x=\\\"custom=thing\\\"]"',
    'css=[data-x="aria-ref=e1"]'
  ]) assert.doesNotThrow(() => check(selector, true), selector);
});

test("frame-relative operands reject actual frame controls while preserving CSS and text literals", () => {
  const check = nativeSelectorGuard();
  for (const selector of [
    "iframe >> internal:control=enter-frame >> button",
    'body >> internal:has="iframe >> internal:control=enter-frame >> button"',
    'body >> internal:and="iframe >> internal:control=enter-frame >> button"',
    '*internal:control=enter-frame'
  ]) {
    assert.doesNotThrow(() => check(selector, true));
    assert.throws(() => check(selector, false, true), /OBU_LOCATOR_FRAME_MISMATCH/);
    assert.throws(() => check(selector, true, true), /OBU_LOCATOR_FRAME_MISMATCH/);
  }
  for (const selector of [
    '[data-selector="internal:control=enter-frame"]', 'text="internal:control=enter-frame"',
    ':text-is("internal:control=enter-frame")', 'body >> internal:has="text=\\\"internal:control=enter-frame\\\""',
    'button >> visible=false'
  ]) assert.doesNotThrow(() => check(selector, true, true), selector);
});

test("bounded private channel retains old string client behavior and adds typed metadata", () => {
  const source = patchCrxAISnapshot(upstream);
  assert.match(source, /return typeof result === "string" \? \{ snapshot: result \} : result/);
  assert.match(source, /refs: tOptional\(tArray\(tObject\(\{ ref: tString, frameGuid: tString \}\)\)\)/);
  assert.match(source, /async _snapshotForAI\(\) \{\s+const result = await this\._channel\.snapshotForAI\(\);\s+return result\.snapshot/);
  assert.match(source, /this\.lastSnapshotFrameIds\.length > limits\.maxFrames/);
  assert.match(source, /depth \+ marker\.depth/);
  assert.ok(!source.includes("depth + marker.indent.length"));
});

test("private snapshot schema retains native frame GUIDs and nullable hierarchy while requiring boolean boxes", () => {
  const source = patchCrxAISnapshot(upstream);
  const validators = source.slice(source.indexOf("const tNumber = "), source.indexOf("scheme.StackFrame = "));
  const schemaStart = source.indexOf("scheme.PageSnapshotForAIParams = ");
  const schemas = source.slice(schemaStart, source.indexOf("\nscheme.", source.indexOf("scheme.PageSnapshotForAIResult = ", schemaStart) + 1));
  const schema = vm.runInNewContext(`class ValidationError extends Error {}\nconst scheme = {};\n${validators}\n${schemas}\nscheme;`);
  const context = { isUnderTest: () => false };
  assert.equal(schema.PageSnapshotForAIParams({ bounded: true, boxes: true }, "", context).boxes, true);
  assert.equal(schema.PageSnapshotForAIParams({ boxes: false }, "", context).boxes, false);
  assert.equal(Object.hasOwn(schema.PageSnapshotForAIParams({}, "", context), "boxes"), false);
  for (const boxes of [null, 0, 1, "true", {}]) assert.throws(() => schema.PageSnapshotForAIParams({ boxes }, "", context), /expected boolean/);
  const value = { snapshot: "", refs: [], stats: { bytes: 0, nodes: 1, refs: 0, frames: 1 }, complete: true,
    geometry: { coordinateSpace: "frame-viewport-css", frames: [{ id: "root", frameGuid: "actual-guid", parentId: null, ownerRef: null,
      viewport: { width: 0, height: 0, scrollX: -1.25, scrollY: 24, devicePixelRatio: 1.5 } }], boxes: [] } };
  assert.deepEqual(JSON.parse(JSON.stringify(schema.PageSnapshotForAIResult(value, "", context))), value);
  for (const field of ["frameGuid", "parentId", "ownerRef"])
    assert.throws(() => schema.PageSnapshotForAIResult({ ...value, geometry: { ...value.geometry, frames: [{ ...value.geometry.frames[0], [field]: undefined }] } }, "", context), /expected string/);
  const { geometry: _geometry, ...legacy } = value;
  assert.deepEqual(JSON.parse(JSON.stringify(schema.PageSnapshotForAIResult(legacy, "", context))), legacy);
});

function injectedFunction(name, next, context) {
  const source = patchInjectedAISnapshot(originalInjected);
  const start = source.indexOf(`function ${name}(`), end = source.indexOf(`\nfunction ${next}(`, start);
  assert.ok(start >= 0 && end > start);
  return vm.runInNewContext(`(${source.slice(start, end)})`, { TextEncoder, ...context });
}

test("native ARIA renderer records genuine refs and exact UTF-8 line budgets", () => {
  const render = injectedFunction("renderAriaTree", "convertToBestGuessRegex", {
    receivesPointerEvents2: () => true, hasPointerCursor: () => false,
    yamlEscapeKeyIfNeeded: value => value, yamlEscapeValueIfNeeded: value => value
  });
  const node = { role: "button", name: "文字 [ref=e999]", ref: "e2", children: [], props: {}, element: { nodeName: "BUTTON" }, obuDepth: 3 };
  const refs = [];
  const snapshot = { root: { role: "fragment", children: [node] } };
  const text = render(snapshot, { forAI: true, obuRefs: refs, obuLimits: { maxBytes: 1000, maxRefs: 1 } });
  assert.deepEqual(refs.map(item => item.ref), ["e2"]);
  assert.equal(refs[0].depth, 3);
  const bytes = new TextEncoder().encode(text).length;
  assert.ok(bytes > text.length);
  assert.equal(render(snapshot, { forAI: true, obuRefs: [], obuLimits: { maxBytes: bytes, maxRefs: 1 } }), text);
  assert.throws(() => render(snapshot, { forAI: true, obuRefs: [], obuLimits: { maxBytes: bytes - 1, maxRefs: 1 } }), /maxBytes/);
  assert.throws(() => render(snapshot, { forAI: true, obuRefs: [], obuLimits: { maxBytes: 1000, maxRefs: 0 } }), /maxRefs/);
});

function geometryRenderer() {
  return injectedFunction("renderAriaTree", "convertToBestGuessRegex", {
    receivesPointerEvents2: () => true, hasPointerCursor: () => false,
    yamlEscapeKeyIfNeeded: value => value, yamlEscapeValueIfNeeded: value => value
  });
}

test("opt-in native renderer samples each genuine ref once in CSS pixels and charges inline boxes to UTF-8 bytes", () => {
  const render = geometryRenderer();
  const reads = [];
  const makeNode = (ref, box) => ({ role: "button", name: "文字 [ref=forged] [box=1,2,3,4]", ref, children: [], props: {}, obuDepth: 2,
    element: { nodeName: "BUTTON", isConnected: true, getBoundingClientRect() { reads.push(ref); return box; } } });
  const boxes = [{ x: -18.125, y: 23.0625, width: 140.75, height: 22.5 }, { x: 0, y: -0.5, width: 0, height: 0 }];
  const snapshot = { root: { role: "fragment", children: boxes.map((box, index) => makeNode("e" + (index + 1), box)) } };
  const run = (options = {}) => {
    const refs = [];
    const text = render(snapshot, { forAI: true, obuRefs: refs, obuLimits: { maxBytes: 1000, maxRefs: 2 }, ...options });
    return { refs, text };
  };
  const original = run();
  assert.deepEqual(run({ boxes: false }), original);
  assert.deepEqual(reads, []);
  const result = run({ boxes: true });
  assert.deepEqual(reads, ["e1", "e2"]);
  assert.deepEqual(JSON.parse(JSON.stringify(result.refs.map(item => item.box))), boxes);
  assert.deepEqual(result.refs.map(item => item.ref), ["e1", "e2"]);
  assert.match(result.text, /\[ref=e1\] \[box=-18\.125,23\.0625,140\.75,22\.5\]/);
  assert.match(result.text, /\[ref=e2\] \[box=0,-0\.5,0,0\]/);
  const bytes = Buffer.byteLength(result.text);
  assert.equal(run({ boxes: true, obuLimits: { maxBytes: bytes, maxRefs: 2 } }).text, result.text);
  assert.throws(() => run({ boxes: true, obuLimits: { maxBytes: bytes - 1, maxRefs: 2 } }), /OBU_SNAPSHOT_LIMIT: maxBytes/);
  assert.ok(bytes > Buffer.byteLength(original.text));
});

test("native ref geometry rejects disconnected and non-finite or negative boxes without publishing that ref", () => {
  const render = geometryRenderer();
  for (const change of [
    { isConnected: false },
    ...["x", "y", "width", "height"].flatMap(key => [NaN, Infinity, -Infinity].map(value => ({ box: { [key]: value } }))),
    { box: { width: -1 } }, { box: { height: -0.5 } }, { detachDuringRead: true }
  ]) {
    const element = { nodeName: "BUTTON", isConnected: change.isConnected ?? true,
      getBoundingClientRect() { if (change.detachDuringRead) this.isConnected = false; return { x: 1, y: 2, width: 3, height: 4, ...change.box }; } };
    const snapshot = { root: { role: "fragment", children: [{ role: "button", ref: "e1", children: [], props: {}, element }] } };
    const refs = [];
    assert.throws(() => render(snapshot, { forAI: true, boxes: true, obuRefs: refs, obuLimits: { maxBytes: 1000, maxRefs: 1 } }), /OBU_SNAPSHOT_INCOMPLETE/);
    assert.equal(refs.length, 0);
  }
});

function nativeInjectedSnapshot(generateAriaTree) {
  const source = patchInjectedAISnapshot(originalInjected);
  const start = source.indexOf("  ariaSnapshot(node, options) {"), end = source.indexOf("\n  getAllByAria(", start);
  assert.ok(start >= 0 && end > start);
  return vm.runInNewContext(`({${source.slice(start, end)}}).ariaSnapshot`, {
    Node: { ELEMENT_NODE: 1 }, generateAriaTree, renderAriaTree: geometryRenderer()
  });
}

test("native injected ARIA call returns frame-local viewport, scroll and DPR synchronously without reading it by default", () => {
  const order = [];
  const view = {};
  const expectedViewport = { width: 641, height: 479, scrollX: -13.25, scrollY: 801.125, devicePixelRatio: 1.5 };
  for (const [key, value] of Object.entries({ innerWidth: 641, innerHeight: 479, scrollX: -13.25, scrollY: 801.125, devicePixelRatio: 1.5 }))
    Object.defineProperty(view, key, { get() { order.push(key); return value; }, configurable: true });
  const element = { nodeName: "BUTTON", isConnected: true, getBoundingClientRect() { order.push("rect"); return { x: 5.5, y: -700.125, width: 0, height: 0 }; } };
  const tree = { root: { role: "fragment", children: [{ role: "button", ref: "e1", children: [], props: {}, element }] }, obuNodeCount: 2 };
  const snapshot = nativeInjectedSnapshot(() => { order.push("aria"); return tree; });
  const node = { nodeType: 1, isConnected: true, ownerDocument: { defaultView: view } };
  const options = { forAI: true, obuLimits: { maxBytes: 1000, maxRefs: 1 } };
  const legacy = snapshot.call({}, node, options);
  assert.equal(Object.hasOwn(legacy, "viewport"), false);
  assert.deepEqual(order.splice(0), ["aria"]);
  assert.deepEqual(snapshot.call({}, node, { ...options, boxes: false }), legacy);
  assert.deepEqual(order.splice(0), ["aria"]);
  const result = snapshot.call({}, node, { ...options, boxes: true });
  assert.deepEqual(JSON.parse(JSON.stringify(result.viewport)), expectedViewport);
  assert.deepEqual(order, ["aria", "rect", "innerWidth", "innerHeight", "scrollX", "scrollY", "devicePixelRatio"]);
  assert.equal(result.refs[0].box.y, -700.125);
  assert.match(result.snapshot, /\[box=5\.5,-700\.125,0,0\]/);
});

test("native injected geometry rejects unavailable or invalid viewport instead of returning complete metadata", () => {
  const snapshot = nativeInjectedSnapshot(() => ({ root: { role: "fragment", children: [] }, obuNodeCount: 1 }));
  const view = { innerWidth: 800, innerHeight: 600, scrollX: 0, scrollY: 0, devicePixelRatio: 1 };
  for (const change of [
    { isConnected: false }, { defaultView: null },
    ...Object.keys(view).flatMap(key => [NaN, Infinity].map(value => ({ view: { [key]: value } }))),
    { view: { innerWidth: -1 } }, { view: { innerHeight: -1 } }, { view: { devicePixelRatio: 0 } }
  ]) {
    const node = { nodeType: 1, isConnected: change.isConnected ?? true,
      ownerDocument: { defaultView: Object.hasOwn(change, "defaultView") ? change.defaultView : { ...view, ...change.view } } };
    assert.throws(() => snapshot.call({}, node, { boxes: true, obuLimits: { maxBytes: 1000, maxRefs: 1 } }), /OBU_SNAPSHOT_INCOMPLETE/);
  }
});

test("bounded native iframe output keeps fallback text in a valid child collection without changing legacy rendering", () => {
  const render = injectedFunction("renderAriaTree", "convertToBestGuessRegex", {
    receivesPointerEvents2: () => true, hasPointerCursor: () => false,
    yamlEscapeKeyIfNeeded: value => value, yamlEscapeValueIfNeeded: value => value
  });
  const frame = { role: "iframe", ref: "e2", props: {}, element: { nodeName: "IFRAME" }, obuDepth: 2 };
  for (const children of [[], ["fallback text"], ["first", "second"]]) {
    const refs = [];
    const snapshot = { root: { role: "fragment", children: [{ ...frame, children }] } };
    const result = render(snapshot, { forAI: true, obuRefs: refs, obuLimits: { maxBytes: 1000, maxRefs: 1 } });
    assert.equal(result, ["- iframe [ref=e2]:", ...children.map(text => "  - text: " + text)].join("\n"));
    assert.equal(refs[0].line, 0);
    assert.equal(refs[0].iframe, true);
    if (children.length === 1) assert.equal(render(snapshot, { forAI: true }), "- iframe [ref=e2]: fallback text");
  }
});

test("native node traversal limits hidden/deep content before normalization and records actual iframe depth", () => {
  const make = (tag, child) => ({ nodeType: 1, nodeName: tag, firstChild: child, hasAttribute: () => false });
  const frame = make("IFRAME"), wrapper = make("DIV", frame), body = make("BODY", wrapper);
  const generate = injectedFunction("generateAriaTree", "ariaRef", {
    Node: { ELEMENT_NODE: 1, TEXT_NODE: 3 }, box: () => ({}), isElementHiddenForAria: () => false, isElementVisible: () => true,
    toAriaNode: element => ({ role: element.nodeName === "IFRAME" ? "iframe" : "generic", element, children: [], props: {} }),
    getElementComputedStyle: () => ({ display: "inline" }), getCSSContent: () => "",
    beginAriaCaches() {}, endAriaCaches() {}, normalizeStringChildren() {}, normalizeGenericRoles() {}
  });
  assert.throws(() => generate(body, { obuLimits: { maxNodes: 2, maxDepth: 8 } }), /maxNodes/);
  assert.throws(() => generate(body, { obuLimits: { maxNodes: 8, maxDepth: 2 } }), /maxDepth/);
  const result = generate(body, { obuLimits: { maxNodes: 3, maxDepth: 3 } });
  assert.equal(result.obuNodeCount, 3);
  const elementChildren = node => node.children.filter(child => typeof child === "object");
  assert.equal(elementChildren(elementChildren(elementChildren(result.root)[0])[0])[0].obuDepth, 3);
});

test("stable frame ordinal helper reuses holes without retargeting a live sibling", () => {
  const source = patchCrxAISnapshot(upstream);
  const start = source.lastIndexOf("function obuFrameOrdinal("), end = source.indexOf("\nfunction obuSnapshotTime", start);
  const ordinal = vm.runInNewContext(`(${source.slice(start, end)})`);
  const ids = ["same", "cross", null, "nested"];
  assert.equal(ordinal(ids, { _id: "prepended" }), 3);
  assert.equal(ordinal(ids, { _id: "same" }), 1);
  assert.equal(ordinal(ids, { _id: "nested" }), 4);
  for (let index = 0; index < 100; index++) assert.equal(ordinal(ids, { _id: "cross" }), 2);
  assert.equal(ids.length, 4);
});

test("recursive native capture charges real frame depth and aggregate bytes, and fails missing children", async () => {
  const source = patchCrxAISnapshot(upstream);
  const helpers = source.slice(source.lastIndexOf("const obuSnapshotCaps = "));
  const capture = vm.runInNewContext(helpers + "\nobuSnapshotFrame;", {
    performance, TextEncoder, TimeoutError$1: Error,
    ProgressController: class { run(callback) { return callback({}); } }
  });
  const calls = [];
  const makeFrame = (id, value) => ({ _id: id, guid: id,
    retryWithProgressAndTimeouts: async (_progress, _delays, callback) => callback(Symbol("poll")),
    _utilityContext: async () => ({ injectedScript: async () => ({ evaluate: async (_fn, options) => { calls.push({ id, options }); return value; } }) })
  });
  const child = makeFrame("child", { snapshot: '- button "文字" [ref=f1e1]', refs: [{ ref: "f1e1", line: 0, depth: 1 }], nodes: 2 });
  const root = makeFrame("root", { snapshot: "- iframe [ref=e1]:\n  - text: fallback", refs: [{ ref: "e1", iframe: true, line: 0, indent: "", depth: 5 }], nodes: 5 });
  root.selectors = { resolveFrameForSelector: async () => ({ frame: child }) };
  const budget = (maxBytes = 1024) => ({ limits: { maxBytes, maxNodes: 20, maxRefs: 10, maxFrames: 4, maxDepth: 8 }, deadline: performance.now() + 1000, refs: [], seenRefs: new Set(), lines: [], bytes: 0, nodes: 0, frames: 0 });
  const result = budget();
  await capture({}, root, 0, [], result);
  assert.equal(calls[1].options.obuLimits.maxDepth, 3);
  assert.equal(result.frames, 2);
  assert.equal(result.nodes, 7);
  assert.equal(result.bytes, new TextEncoder().encode(result.lines.join("\n")).length);
  assert.equal(result.refs[1].frameGuid, "child");
  assert.equal(result.lines.join("\n"), '- iframe [ref=e1]:\n  - button "文字" [ref=f1e1]\n  - text: fallback');
  await assert.rejects(capture({}, root, 0, [], budget(result.bytes - 1)), /maxBytes/);
  root.selectors.resolveFrameForSelector = async () => null;
  await assert.rejects(capture({}, root, 0, [], budget()), /OBU_SNAPSHOT_INCOMPLETE/);
});

test("recursive boxed capture preserves exact frame hierarchy and local CSS boxes including an empty child", async () => {
  const source = patchCrxAISnapshot(upstream);
  const helpers = source.slice(source.lastIndexOf("const obuSnapshotCaps = "));
  let now = 10;
  const capture = vm.runInNewContext(helpers + "\nobuSnapshotFrame;", {
    performance: { now: () => now }, TextEncoder, TimeoutError$1: Error,
    ProgressController: class { run(callback) { return callback({}); } }
  });
  const calls = [];
  const viewport = (dpr, scrollY) => ({ width: 400, height: 200, scrollX: 0, scrollY, devicePixelRatio: dpr });
  const makeFrame = (id, value) => ({ _id: id, guid: "guid-" + id,
    retryWithProgressAndTimeouts: async (_progress, _delays, callback) => callback(Symbol("poll")),
    _utilityContext: async () => ({ injectedScript: async () => ({ evaluate: async (_fn, options) => { calls.push({ id, options }); return value; } }) })
  });
  const leaf = makeFrame("leaf", { snapshot: "", refs: [], nodes: 1, viewport: viewport(1.5, 123.5) });
  const childBox = { x: 10.125, y: -15.5, width: 120.25, height: 50 };
  const rootBox = { x: 90.5, y: -201.75, width: 260, height: 100.5 };
  const child = makeFrame("child", { snapshot: "- iframe [ref=f2e1] [box=10.125,-15.5,120.25,50]:", nodes: 2, viewport: viewport(1.5, 15.5),
    refs: [{ ref: "f2e1", line: 0, depth: 1, indent: "", iframe: true, box: childBox }] });
  const root = makeFrame("root", { snapshot: "- iframe [ref=e1] [box=90.5,-201.75,260,100.5]:", nodes: 2, viewport: viewport(1.5, 201.75),
    refs: [{ ref: "e1", line: 0, depth: 1, indent: "", iframe: true, box: rootBox }] });
  root.selectors = { resolveFrameForSelector: async selector => { assert.equal(selector, "aria-ref=e1 >> internal:control=enter-frame >> body"); return { frame: child }; } };
  child.selectors = { resolveFrameForSelector: async selector => { assert.equal(selector, "aria-ref=f2e1 >> internal:control=enter-frame >> body"); return { frame: leaf }; } };
  const budget = () => ({ limits: { boxes: true, maxBytes: 1024, maxNodes: 20, maxRefs: 10, maxFrames: 4, maxDepth: 8 }, deadline: 100,
    refs: [], seenRefs: new Set(), lines: [], bytes: 0, nodes: 0, frames: 0,
    geometry: { coordinateSpace: "frame-viewport-css", frames: [], boxes: [] } });
  const result = budget();
  await capture({}, root, 0, ["other-live-frame"], result);
  assert.deepEqual(calls.map(item => [item.id, item.options.boxes, item.options.refPrefix]), [["root", true, ""], ["child", true, "f2"], ["leaf", true, "f3"]]);
  assert.deepEqual(JSON.parse(JSON.stringify(result.geometry)), { coordinateSpace: "frame-viewport-css", frames: [
    { id: "root", frameGuid: "guid-root", parentId: null, ownerRef: null, viewport: viewport(1.5, 201.75) },
    { id: "f2", frameGuid: "guid-child", parentId: "root", ownerRef: "e1", viewport: viewport(1.5, 15.5) },
    { id: "f3", frameGuid: "guid-leaf", parentId: "f2", ownerRef: "f2e1", viewport: viewport(1.5, 123.5) }
  ], boxes: [{ ref: "e1", frameId: "root", box: rootBox }, { ref: "f2e1", frameId: "f2", box: childBox }] });
  assert.deepEqual(JSON.parse(JSON.stringify(result.refs)), [{ ref: "e1", frameGuid: "guid-root" }, { ref: "f2e1", frameGuid: "guid-child" }]);
  assert.equal(result.bytes, Buffer.byteLength(result.lines.join("\n")));
  const limited = budget(); limited.limits.maxFrames = 2;
  await assert.rejects(capture({}, root, 0, ["other-live-frame"], limited), /maxFrames/);
  leaf._utilityContext = async () => ({ injectedScript: async () => ({ evaluate: async () => { now = 101; return { snapshot: "", refs: [], nodes: 1, viewport: viewport(1.5, 123.5) }; } }) });
  await assert.rejects(capture({}, root, 0, ["other-live-frame"], budget()), /OBU_SNAPSHOT_TIMEOUT/);
});

test("CRX observer patch fails closed when pinned upstream transport changes", async () => {
  const command = "return await chrome.debugger.sendCommand(debuggee, method, commandParams);";
  assert.throws(() => patchCrxTransport("unexpected library"), /shape changed/);
  assert.throws(() => patchCrxTransport(command + command), /shape changed/);
  assert.throws(() => patchCrxTransport(command), /frame transport shape changed/);
  const patched = patchCrxTransport(upstream);
  assert.match(patched, /Modified by Open Browser Use/);
  assert.match(patched, /method === "Input.dispatchMouseEvent"/);
  assert.match(patched, /return result/);
  assert.ok(!patched.includes("chrome.debugger.sendCommand ="));
  assert.match(patched, /await prepareCrxChildFrame/);
  assert.match(patched, /observeCrxFrameMessage\(this, message\)/);
  assert.match(patched, /refreshCrxCachedLifecycle\(this, message\)/);
  assert.match(patched, /openBrowserUseInputHooks\.send\(debuggee, method, commandParams, operation\)/);
  assert.match(patched, /observeCrxInputCommand\(this, debuggee, method, commandParams\)/);
  assert.throws(() => patchCrxTransport(upstream.replace('"_onPopupCreated"', '"_unexpectedPopupHandler"')), /popup attachment shape changed/);
});

test("production CRX popup creation cannot bypass backend ownership while standalone retains auto-attachment", async () => {
  const source = patchCrxTransport(upstream);
  const start = source.indexOf('__publicField(this, "_onPopupCreated"');
  const listener = source.slice(start, source.indexOf('__publicField(this, "_onRemoved"', start));
  const create = new Function('openBrowserUseInputHooks', '__publicField', listener + 'return this._onPopupCreated;');
  const attached = [];
  const transport = { _tabToTarget: new Map([[42, { targetId: 'owned-opener' }]]), attach: async id => { attached.push(id); } };
  const define = (object, name, value) => { object[name] = value; };
  const production = create.call(transport, { send() {} }, define);
  await production({ openerTabId: 42, id: 51 });
  await production({ openerTabId: 99, id: 52 });
  assert.deepEqual(attached, [], 'native attach must wait for explicit backend authorization');
  const standalone = create.call(transport, undefined, define);
  await standalone({ openerTabId: 42, id: 51 });
  await standalone({ openerTabId: 99, id: 52 });
  await standalone({ id: 53 });
  assert.deepEqual(attached, [51]);
});

function detachMethods(hooks, chrome, applicationHooks = hooks) {
  const source = patchCrxTransport(upstream);
  const transportBody = source.slice(source.indexOf('  async detach(tabOrTarget'), source.indexOf('  close() {', source.indexOf('  async detach(tabOrTarget')));
  const appBody = source.slice(source.indexOf('  async _doDetach(targetId)'), source.indexOf('\n};', source.indexOf('  async _doDetach(targetId)')));
  return {
    transport: new Function('openBrowserUseInputHooks', 'chrome', 'releaseCrxInput', 'return ({'+transportBody+'}).detach')(hooks, chrome, async () => {}),
    application: new Function('Page$1', 'openBrowserUseInputHooks', 'return ({'+appBody+'})._doDetach')({ Events: { Close: 'close' } }, applicationHooks)
  };
}
function transportFixture(detach, targetInfo = { targetId: 'same-target' }) {
  return { _tabToTarget: new Map([[42, targetInfo]]), _targetToTab: new Map([[targetInfo.targetId, 42]]), _emitDetachedToTarget() {}, isIncognito: () => false, detach };
}

test("CRX native cleanup preserves failures and binds input release before Page close", async () => {
  let token = {}, releases = 0, nativeDetaches = 0, finishRelease;
  const originalToken = token;
  const hooks = { prepareRelease: () => {
    const captured = token;
    return { release: async () => { releases++; await new Promise(resolve => { finishRelease = resolve; }); }, isCurrent: () => token === captured, detach: async () => { nativeDetaches++; } };
  } };
  const methods = detachMethods(hooks, {});
  const target = { targetId: 'same-target' };
  const transport = transportFixture(methods.transport, target);
  const oldDetach = transport.detach(42, target);
  assert.equal(releases, 1);
  token = {};
  const successor = { targetId: 'same-target' };
  transport._tabToTarget.set(42, successor);
  transport._targetToTab.set(successor.targetId, 42);
  finishRelease();
  await oldDetach;
  assert.equal(nativeDetaches, 0);
  assert.equal(transport._tabToTarget.get(42), successor);
  assert.notEqual(token, originalToken);

  let failRelease = true;
  const failureMethods = detachMethods({ prepareRelease: () => ({
    release: async () => { if (failRelease) throw new Error('release pending'); },
    isCurrent: () => true,
    detach: async () => { nativeDetaches++; throw new Error('native detach failed'); }
  }) }, {});
  await assert.rejects(failureMethods.transport.call(transportFixture(failureMethods.transport), 42), /release pending/);
  assert.equal(nativeDetaches, 0);
  failRelease = false;
  await assert.rejects(failureMethods.transport.call(transportFixture(failureMethods.transport), 42), /native detach failed/);
  assert.equal(nativeDetaches, 1);
});

test("old CRX application detach cannot remove a replacement attachment after awaited page initialization", async () => {
  let releases = 0, nativeDetaches = 0, finishInitialization;
  const methods = detachMethods({ prepareRelease: () => ({ release: async () => { releases++; }, isCurrent: () => true, detach: async () => { nativeDetaches++; } }) }, {}, null);
  const original = { targetId: 'same-target' };
  const transport = transportFixture(methods.transport, original);
  const page = Object.assign(new EventEmitter(), { hideHighlight: async () => {} });
  const app = { _transport: transport, isIncognito: () => false, _crPageByTargetId: () => ({ _page: { waitForInitializedOrError: () => new Promise(resolve => { finishInitialization = resolve; }) } }) };
  const oldDetach = methods.application.call(app, original.targetId);
  const successor = { targetId: original.targetId };
  transport._tabToTarget.set(42, successor);
  finishInitialization(page);
  await oldDetach;
  assert.equal(releases, 0);
  assert.equal(nativeDetaches, 0);
  assert.equal(transport._tabToTarget.get(42), successor);
  assert.equal(transport._targetToTab.get(successor.targetId), 42);

  app._crPageByTargetId = () => ({ _page: { waitForInitializedOrError: async () => page } });
  transport._emitDetachedToTarget = () => page.emit('close');
  await methods.application.call(app, successor.targetId);
  assert.equal(releases, 1);
  assert.equal(nativeDetaches, 1);
  assert.equal(transport._tabToTarget.size, 0);
});

test("production CRX detach closes Page before any optional initialization or highlight wait", async () => {
  let finishRelease, pageClosed = false, detached = false;
  const methods = detachMethods({ prepareRelease: () => ({
    release: () => new Promise(resolve => { finishRelease = resolve; }),
    isCurrent: () => true,
    detach: async () => { detached = true; }
  }) }, {});
  const transport = transportFixture(methods.transport);
  transport._emitDetachedToTarget = () => { pageClosed = true; };
  const app = { _transport: transport, isIncognito: () => false, _crPageByTargetId: () => ({
    _page: { waitForInitializedOrError() { throw new Error("must not wait for optional Page work before cancellation"); } }
  }) };
  const closing = methods.application.call(app, 'same-target');
  assert.equal(pageClosed, true);
  assert.equal(detached, false);
  finishRelease();
  await closing;
  assert.equal(detached, true);
});

test("extension build includes runnable pinned ESM and third-party notices, not tests", async () => {
  const output = await buildChromeExtension(path.resolve(".tmp/build-extension-test"));
  const vendor = path.join(output, "vendor/playwright-crx");
  assert.match(await fs.readFile(path.join(vendor, "LICENSE"), "utf8"), /Apache License/);
  assert.match(await fs.readFile(path.join(vendor, "NOTICE"), "utf8"), /Playwright/);
  assert.match(await fs.readFile(path.join(vendor, "MODIFICATIONS.txt"), "utf8"), /observer/);
  assert.match(await fs.readFile(path.join(vendor, "MODIFICATIONS.txt"), "utf8"), /BackForwardCacheRestore/);
  assert.match(await fs.readFile(path.join(vendor, "MODIFICATIONS.txt"), "utf8"), /popup auto-attachment/);
  assert.match(await fs.readFile(path.join(vendor, "MODIFICATIONS.txt"), "utf8"), /bounded.*ARIA|ARIA.*bounded/);
  assert.match(await fs.readFile(path.join(vendor, "MODIFICATIONS.txt"), "utf8"), /private client navigation Waiter hook/);
  assert.match(await fs.readFile(path.join(vendor, "MODIFICATIONS.txt"), "utf8"), /diagnostic admission boundary/);
  assert.match(await fs.readFile(path.join(vendor, "MODIFICATIONS.txt"), "utf8"), /Production locator fill.*trusted input receipt/);
  const runtimeChunk = await fs.readFile(path.join(vendor, "upstream", chunkName), "utf8");
  assert.match(runtimeChunk, /openBrowserUseInputHooks\?\.beginFillAction/);
  assert.match(runtimeChunk, /async function obuRunFill\(/);
  assert.match(runtimeChunk, /prepareOpenBrowserUseFill/);
  assert.match(runtimeChunk, /_validateOpenBrowserUsePress/);
  assert.match(runtimeChunk, /openBrowserUseInputHooks\?\.beginKeyboardPress/);
  assert.match(await fs.readFile(path.join(vendor, "MODIFICATIONS.txt"), "utf8"), /Keyboard.press validates every token/);
  assert.equal(JSON.parse(await fs.readFile(path.join(vendor, "version.json"), "utf8")).playwrightVersion, "1.53.0");
  const entry = await fs.readFile(path.join(vendor, "index.mjs"), "utf8");
  assert.match(entry, /assertOpenBrowserUseSelector/);
  assert.match(entry, /createOpenBrowserUseNavigationWait/);
  assert.match(await fs.readFile(path.join(output, "browser-file-input.js"), "utf8"), /export async function setLocatorInputFiles/);
  assert.match(await fs.readFile(path.join(output, "browser-runtime.js"), "utf8"), /setLocatorInputFiles/);
  assert.match(await fs.readFile(path.join(vendor, "MODIFICATIONS.txt"), "utf8"), /Locator file upload reuses/);
  for (const match of entry.matchAll(/from "(.+?)"/g)) await fs.access(path.join(vendor, match[1]));
  assert.ok(!(await fs.readdir(output)).some(file => file.endsWith(".test.mjs")));
  for (const file of ["managed-config.js", "managed-native-host.js", "browser-rendering.js", "managed-user-bridge.js", "managed-human-control.js", "managed-result-pages.js"]) {
    assert.equal(await fs.readFile(path.join(output, file), "utf8"),
      await fs.readFile(path.join("apps/chrome-extension", file), "utf8"));
  }
  const managedConfigSource = await fs.readFile(path.join(output, "managed-config.js"), "utf8");
  assert.equal((await import(`data:text/javascript,${encodeURIComponent(managedConfigSource)}`)).default, null);
  assert.equal(await fs.readFile(path.join(output, "auxiliary-tab-ownership.js"), "utf8"),
    await fs.readFile(path.join("apps/chrome-extension", "auxiliary-tab-ownership.js"), "utf8"));
  assert.equal(await fs.readFile(path.join(output, "browser-lifetime.js"), "utf8"),
    await fs.readFile(path.join("apps/chrome-extension", "browser-lifetime.js"), "utf8"));
  assert.equal(await fs.readFile(path.join(output, "browser-diagnostic-fence.js"), "utf8"),
    await fs.readFile(path.join("apps/chrome-extension", "browser-diagnostic-fence.js"), "utf8"));
  await fs.access(path.join(output, "browser-action-engine.js"));
  assert.equal(await fs.readFile(path.join(output, "browser-navigation-waits.js"), "utf8"),
    await fs.readFile(path.join("apps/chrome-extension", "browser-navigation-waits.js"), "utf8"));
  assert.equal(await fs.readFile(path.join(output, "browser-file-chooser-waits.js"), "utf8"),
    await fs.readFile(path.join("apps/chrome-extension", "browser-file-chooser-waits.js"), "utf8"));
  assert.equal(await fs.readFile(path.join(output, "browser-directory-upload.js"), "utf8"),
    await fs.readFile(path.join("apps/chrome-extension", "browser-directory-upload.js"), "utf8"));
  assert.equal(await fs.readFile(path.join(output, "browser-download-waits.js"), "utf8"),
    await fs.readFile(path.join("apps/chrome-extension", "browser-download-waits.js"), "utf8"));
  await fs.access(path.join(output, "browser-frame-adapter.js"));
  await fs.access(path.join(output, "browser-input-adapter.js"));
  await fs.access(path.join(output, "browser-diagnostics.js"));
  await fs.access(path.join(output, "browser-network-waits.js"));
  assert.equal(await fs.readFile(path.join(output, "browser-downloads.js"), "utf8"),
    await fs.readFile(path.join("apps/chrome-extension", "browser-downloads.js"), "utf8"));
  assert.equal(await fs.readFile(path.join(output, "browser-page-exports.js"), "utf8"),
    await fs.readFile(path.join("apps/chrome-extension", "browser-page-exports.js"), "utf8"));
  for (const file of ["browser-clipboard.js", "clipboard-broker.js", "clipboard-offscreen.html", "clipboard-offscreen.js"]) {
    assert.equal(await fs.readFile(path.join(output, file), "utf8"), await fs.readFile(path.join("apps/chrome-extension", file), "utf8"));
  }
  assert.equal(await fs.readFile(path.join(output, "native-message-receiver.js"), "utf8"),
    await fs.readFile(path.join("apps/chrome-extension", "native-message-receiver.js"), "utf8"));
  await fs.access(path.join(output, "browser-ai-snapshot.js"));
  await fs.access(path.join(output, "browser-observation.js"));
  assert.equal(await fs.readFile(path.join(output, "browser-snapshot-geometry.js"), "utf8"),
    await fs.readFile(path.join("apps/chrome-extension", "browser-snapshot-geometry.js"), "utf8"));
});

test("build refuses destructive output paths outside generated subtrees", async () => {
  await assert.rejects(buildChromeExtension("apps/chrome-extension"), /generated|child directory/);
  await assert.rejects(buildChromeExtension("dist"), /child directory/);
});

test("build rejects junction or symlink ancestors before clearing output", async () => {
  const target = path.resolve(".tmp/build-link-target");
  const link = path.resolve(".tmp/build-output-link");
  await fs.mkdir(target, { recursive: true });
  await fs.writeFile(path.join(target, "preserve.txt"), "preserve");
  try {
    await fs.symlink(target, link, process.platform === "win32" ? "junction" : "dir");
    await assert.rejects(buildChromeExtension(path.join(link, "nested")), /symlink|junction/);
    assert.equal(await fs.readFile(path.join(target, "preserve.txt"), "utf8"), "preserve");
  } finally { await fs.unlink(link).catch(error => { if (error.code !== "ENOENT") throw error; }); }
});

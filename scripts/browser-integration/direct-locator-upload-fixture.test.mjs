import assert from "node:assert/strict";
import test from "node:test";
import { createHash } from "node:crypto";
import { EventEmitter } from "node:events";
import { createDirectLocatorUploadFixtures, directLocatorUploadHTML, checkDirectUploadItem, checkDirectDirectoryImmediate } from "./direct-locator-upload-fixture.mjs";
import { installDirectUploadProbe, checkDirectUploadNative } from "./direct-locator-upload-native.mjs";

const hash = bytes => createHash("sha256").update(bytes).digest("hex");
function sample() {
  const files = [{ name: "中文.txt", relativePath: "", size: 2, sha256: hash(Buffer.from([0, 255])) }];
  const fileMeta = files.map(({ name, relativePath, size }) => ({ name, relativePath, size }));
  const before = { key: "direct-js-unit-root", variant: "root", directory: false, href: "http://127.0.0.1:1234/page", documentToken: "a".repeat(36), inputToken: "b".repeat(36), files: [], events: [], errors: [], clicks: [], submissions: 0, overflow: false,
    input: { tag: "INPUT", type: "file", multiple: true, directory: false, connected: true, original: true, display: "none" } };
  const uploaded = { ...structuredClone(before), files: fileMeta, submissions: 1, events: ["input", "change"].map(type => ({ type, trusted: true, original: true, files: fileMeta })) };
  const cleared = { ...structuredClone(uploaded), files: [], events: [...uploaded.events, ...["input", "change"].map(type => ({ type, trusted: false, original: true, files: [] }))] };
  const value = { ...structuredClone(uploaded), files: [{ ...fileMeta[0], base64: "AP8=" }] };
  const body = Buffer.from(JSON.stringify(value)), receipt = { key: before.key, variant: "root", documentToken: before.documentToken, inputToken: before.inputToken, submission: 1, files };
  return { files, item: { key: before.key, variant: "root", tabId: 1, passed: true, before, uploaded, cleared, receipt }, record: { posts: [{ value, bytes: body.length, base64: body.toString("base64"), sha256: hash(body), files, receipt }] } };
}

test("direct bytes checker links actual POST, trusted upload, original hidden node and synthetic clear", () => {
  const { files, item, record } = sample(); assert.equal(checkDirectUploadItem(item, files, record), item);
});
test("directory return checkpoint needs original trusted input already present, not a later receipt", () => {
  const { item, files } = sample(), value = { key: item.key, variant: item.variant, documentToken: item.before.documentToken, inputToken: item.before.inputToken, type: "input", trusted: true, original: true, files: item.uploaded.files };
  const raw = Buffer.from(JSON.stringify(value)), witness = { bytes: raw.length, base64: raw.toString("base64"), sha256: hash(raw), value };
  checkDirectDirectoryImmediate({ witnesses: [witness] }, { before: item.before, files });
  assert.throws(() => checkDirectDirectoryImmediate({ witnesses: [], posts: [{ receipt: {} }] }, { before: item.before, files }));
  const wrong = structuredClone(witness); wrong.value.inputToken = "c".repeat(36);
  assert.throws(() => checkDirectDirectoryImmediate({ witnesses: [wrong] }, { before: item.before, files }));
});
for (const [name, mutate] of Object.entries({
  "extra mutation": sample => sample.item.cleared.events.push(sample.item.cleared.events[0]),
  "clear false trust": sample => sample.item.cleared.events[2].trusted = true,
  "replacement node": sample => sample.item.cleared.inputToken = "c".repeat(36),
  "visible input": sample => sample.item.before.input.display = "block",
  "forged bytes": sample => sample.record.posts[0].base64 = "e30=",
  "duplicate POST": sample => sample.record.posts.push(sample.record.posts[0]),
  "click": sample => sample.item.before.clicks.push({ trusted: true }),
  "overflow": sample => sample.item.cleared.overflow = true,
})) test(`direct bytes checker rejects ${name}`, () => { const data = sample(); mutate(data); assert.throws(() => checkDirectUploadItem(data.item, data.files, data.record)); });

test("new fixture keeps hidden controls and creates dynamic OOPIF without input", () => {
  const html = directLocatorUploadHTML(new URL("http://127.0.0.1:1234/direct-locator-upload/page?key=direct-js-unit&variant=dynamic-oopif"), 1234);
  assert.match(html, /localhost:1234/); assert.match(html, /addEventListener\('load'/); assert.doesNotMatch(html, /\.click\(|showPicker|dispatchEvent/);
  const root = directLocatorUploadHTML(new URL("http://127.0.0.1:1234/direct-locator-upload/page?key=direct-js-unit&variant=root"), 1234);
  assert.match(root, /input\[type=file\]\{display:none\}/); assert.match(root, /f\.arrayBuffer\(\)/);
});

test("HTTP fixture retains original Unicode/binary body without rewriting it", async () => {
  const server = createDirectLocatorUploadFixtures(), request = new EventEmitter(); request.method = "POST"; request.url = "/direct-locator-upload/upload?key=direct-js-unit-root&variant=root"; request.headers = { host: "127.0.0.1:1234" };
  let resolve; const ended = new Promise(done => { resolve = done; }); const response = { setHeader() {}, writeHead(code) { this.status = code; }, end(body) { resolve(body); } };
  assert.equal(server.handle(request, response, 1234), true);
  const data = sample(), bytes = Buffer.from(JSON.stringify(data.record.posts[0].value)); request.emit("data", bytes); request.emit("end"); await ended;
  const post = server.stats("direct-js-unit-root").posts[0]; assert.equal(post.base64, bytes.toString("base64")); assert.equal(post.sha256, hash(bytes)); assert.deepEqual(post.files, data.files);
});

function probeHarness(send) {
  const listeners = new Set(), target = {};
  const api = { debugger: { sendCommand: send, onEvent: { addListener: fn => listeners.add(fn), removeListener: fn => listeners.delete(fn) } } };
  installDirectUploadProbe(api, target, { id: "unit", tabId: 7 });
  return { api, target, listeners };
}
test("native observer preserves exact receiver, Promise and synchronous exception; ignores foreign tab", async () => {
  const expected = {}, promise = Promise.resolve({}), failure = Error("original"); let receiver, sent;
  const h = probeHarness(function (...args) { receiver = this; sent = args; if (args[1] === "Input.fail") throw failure; return promise; });
  assert.equal(h.api.debugger.sendCommand.call(expected, { tabId: 7 }, "DOM.setFileInputFiles", { files: [] }), promise);
  assert.equal(receiver, expected); assert.deepEqual(sent, [{ tabId: 7 }, "DOM.setFileInputFiles", { files: [] }]); await promise; await Promise.resolve();
  const count = h.target.__obuDirectUpload.snapshot().records.length;
  assert.equal(h.api.debugger.sendCommand({ tabId: 8 }, "Input.insertText", {}), promise); assert.equal(h.target.__obuDirectUpload.snapshot().records.length, count);
  assert.throws(() => h.api.debugger.sendCommand({ tabId: 7 }, "Input.fail", {}), error => error === failure);
  const final = h.target.__obuDirectUpload.restore(); assert.equal(final.pending, 0); assert.equal(final.restored, true); assert.equal(h.listeners.size, 0);
});
test("native observer reports bounds instead of silently complete", () => {
  const h = probeHarness(() => Promise.resolve({})); const listener = [...h.listeners][0];
  for (let index = 0; index < 2050; index++) listener({ tabId: 7 }, "Page.fileChooserOpened", {});
  assert.equal(h.target.__obuDirectUpload.restore().overflow, true);
});
test("cancelled installation nonce cannot install after parent cleanup", () => {
  const target = { __obuDirectUploadClosed: new Set(["unit"]) };
  assert.throws(() => installDirectUploadProbe({}, target, { id: "unit", tabId: 7 }), /cancelled/);
  assert.equal(target.__obuDirectUpload, undefined);
});

function nativeSample() {
  const source = { tabId: 7, sessionId: "child" };
  return { tabId: 7, restored: true, overflow: false, pending: 0, errors: [], records: [
    { sequence: 1, kind: "send", source, method: "DOM.setFileInputFiles", params: { files: ["/file"], backendNodeId: 42 } },
    { sequence: 2, kind: "settled", call: 1, ok: true, result: {} },
    { sequence: 3, kind: "send", source, method: "DOM.resolveNode", params: { backendNodeId: 42 } },
    { sequence: 4, kind: "settled", call: 3, ok: true, result: { object: { objectId: "original-node" } } },
    { sequence: 5, kind: "send", source, method: "Runtime.callFunctionOn", params: { objectId: "original-node", functionDeclaration: 'function(){this.value = "";return this.files.length}' } },
    { sequence: 6, kind: "settled", call: 5, ok: true, result: { result: { value: 0 } } },
  ] };
}
test("native checker binds write ACK and clear object to exact original backend node", () => { assert.equal(checkDirectUploadNative(nativeSample(), { tabId: 7 }, ["/file"]).writes, 1); });
for (const [name, mutate] of Object.entries({
  "wrong clear object": p => p.records[4].params.objectId = "foreign",
  "wrong node": p => p.records[2].params.backendNodeId = 43,
  "wrong child": p => p.records[4].source = { tabId: 7, sessionId: "other" },
  "pending": p => p.pending = 1,
  "chooser": p => p.records.push({ sequence: 7, kind: "event", method: "Page.fileChooserOpened" }),
  "extra mutation": p => p.records[2].method = "DOM.setFileInputFiles",
})) test(`native checker rejects ${name}`, () => { const value = nativeSample(); mutate(value); assert.throws(() => checkDirectUploadNative(value, { tabId: 7 }, ["/file"])); });

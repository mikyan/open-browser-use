import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import path from "node:path";
import test from "node:test";
import vm from "node:vm";
import { assertManagedDownloadFrame, selectManagedDownloadFrame, assertManagedDownloadJournal, assertManagedDownloadTransfer, checkManagedDownloads, installManagedDownloadWitness } from "./managed-download-proof.mjs";

const bytes = value => { const data = Buffer.from(value); return { bytes: data.length, base64: data.toString("base64"), sha256: createHash("sha256").update(data).digest("hex") }; };
function chromeFixture() {
  const listeners = new Set();
  return { listeners, chrome: { debugger: { onEvent: { addListener: listener => listeners.add(listener), removeListener: listener => listeners.delete(listener) } } },
    emit(source, method, params) { for (const listener of listeners) listener(source, method, params); } };
}

test("managed download witness observes only admitted exact tabs and never calls native APIs", () => {
  const fixture = chromeFixture(), target = {};
  const start = installManagedDownloadWitness(fixture.chrome, target, "original");
  assert.equal(start.events.length, 0);
  target.__managedDownloadProof.watch(17);
  fixture.emit({ tabId: 18 }, "Page.downloadWillBegin", { guid: "foreign" });
  fixture.emit({ tabId: 17 }, "Input.dispatchMouseEvent", {});
  fixture.emit({ tabId: 17 }, "Target.attachedToTarget", { targetInfo: { type: "worker" } });
  const params = { guid: "original-guid", frameId: "original-frame" };
  fixture.emit({ tabId: 17, sessionId: "child" }, "Page.downloadWillBegin", params);
  params.guid = "changed";
  fixture.emit({ tabId: 17 }, "Target.attachedToTarget", { sessionId: "child", targetInfo: { type: "iframe", targetId: "original-frame" } });
  const final = target.__managedDownloadProof.stop();
  assert.equal(final.events.length, 2); assert.equal(final.events[0].params.guid, "original-guid");
  assert.equal(final.events[0].source.sessionId, "child"); assert.equal(final.stopped, true);
  assert.equal(fixture.listeners.size, 0); assert.equal(target.__managedDownloadProof, undefined);
});

test("managed witness exposes overflow and caps watched tabs without retiring old identity", () => {
  const fixture = chromeFixture(), target = {};
  installManagedDownloadWitness(fixture.chrome, target, "bounded", 1);
  for (let id = 0; id < 8; id++) target.__managedDownloadProof.watch(id);
  assert.throws(() => target.__managedDownloadProof.watch(8), /limit/);
  fixture.emit({ tabId: 0 }, "Page.downloadProgress", { guid: "a", state: "inProgress" });
  fixture.emit({ tabId: 0 }, "Page.downloadProgress", { guid: "a", state: "completed" });
  const final = target.__managedDownloadProof.stop(); assert.equal(final.events.length, 1); assert.equal(final.overflow, true);
});

function heldCase(cancelled) {
  const expected = bytes('{"key":"original","nonce":"nonce","owner":"task"}\nverified fixture');
  const record = { key: "original", nonce: "nonce", owner: "task", kind: "held", reportPath: "/original-negative/report", expected };
  const fields = { key: "original", nonce: "nonce", documentToken: "document", trusted: "true", buttonCount: "1" };
  const get = { method: "GET", status: 200, finished: true, closed: true, response: bytes("<html>original</html>") };
  const post = { method: "POST", url: record.reportPath, status: 200, fields, body: bytes(new URLSearchParams(fields).toString()), receivedBytes: Buffer.byteLength(new URLSearchParams(fields).toString()),
    response: expected, once: true, range: null, prefixFlushed: true, prefixBytes: 4096,
    closed: true, finished: !cancelled, aborted: cancelled, queuedBytes: cancelled ? 4096 : expected.bytes, ...(cancelled ? {} : { released: true }) };
  return { record, variant: "root", page: { key: "original", owner: "task", expectedSHA: expected.sha256, documentToken: "document", clicks: [{ trusted: true, buttonCount: 1, documentToken: "document" }] },
    server: { gets: [{}], requests: [get, post] }, ...(cancelled ? { cancelAcknowledgement: { cancelled: true }, pathRejection: { verified: true, error: { message: "OBU_NATIVE_DOWNLOAD_CANCELED: original download was canceled" } } } :
      { file: { ...expected, analysis: { key: "original", nonce: "nonce", owner: "task" } } }) };
}

test("native cancellation demands its own ACK, canceled path and untouched original HTTP outcome", () => {
  assertManagedDownloadTransfer(heldCase(true), { held: true, cancelled: true });
  for (const mutate of [item => { item.cancelAcknowledgement = {}; }, item => { item.server.requests[1].closedByFixture = true; },
    item => { item.server.requests[1].released = true; }, item => { item.server.requests[1].finished = true; },
    item => { item.pathRejection.error.message = "timeout"; }, item => { item.file = {}; }]) {
    const item = heldCase(true); mutate(item);
    assert.throws(() => assertManagedDownloadTransfer(item, { held: true, cancelled: true }));
  }
});

test("wait cancellation cannot masquerade as transfer cancellation or repeated request success", () => {
  assertManagedDownloadTransfer(heldCase(false), { held: true });
  for (const mutate of [item => { item.server.requests[1].released = false; }, item => { item.server.requests.push(structuredClone(item.server.requests[1])); },
    item => { item.server.requests[1].body.sha256 = "0".repeat(64); }, item => { item.page.clicks[0].trusted = false; },
    item => { item.server.requests[1].fields.documentToken = "other"; }]) {
    const item = heldCase(false); mutate(item);
    assert.throws(() => assertManagedDownloadTransfer(item, { held: true }));
  }
});

test("global journal rejects unassigned GET, invalid token POST and double-assigned requests", () => {
  const request = { sequence: 1, method: "POST", url: "/report", finished: true };
  const cases = [{ server: { requests: [request] } }], counts = { requests: 1, gets: 0, posts: 1 };
  assertManagedDownloadJournal({ requests: [request] }, cases, counts);
  for (const method of ["GET", "POST"]) assert.throws(() => assertManagedDownloadJournal({ requests: [request, { sequence: 2, method, url: "/report", status: 405 }] }, cases, counts), /unassigned/);
  assert.throws(() => assertManagedDownloadJournal({ requests: [request, request] }, [...cases, ...cases], { requests: 2, gets: 0, posts: 2 }));
  assert.throws(() => assertManagedDownloadJournal({ requests: [{ ...request, status: 500 }] }, cases, counts), /exact case request union/);
});

function frameEvidence(variant = "oopif") {
  const root = { frameId: 0, processId: 1, documentId: "root-document", url: "http://127.0.0.1/page?key=original" };
  const child = { frameId: 8, processId: 2, documentId: "child-document", parentDocumentId: root.documentId, parentFrameId: 0, url: "http://localhost/frame?key=original" };
  const documents = [root, child].map(frame => ({ frameId: frame.frameId, documentId: frame.documentId, result: { url: frame.url, state: { documentToken: frame.documentId + "-token" } } }));
  const attachedFrame = { sequence: 0, at: 10, source: { tabId: 17 }, method: "Target.attachedToTarget", params: { sessionId: "original-child-session", targetInfo: { type: "iframe", targetId: "child-target", parentFrameId: "root-target", parentId: "root-target" } } };
  const item = { variant, tabId: 17, record: { key: "original" }, rootTarget: { id: "root-target" },
    beforeTrigger: { frames: variant === "root" ? [root] : [root, child], documents: variant === "root" ? documents.slice(0, 1) : documents },
    nativeFrameTree: { frameTree: { frame: { id: "root-target", loaderId: "original-root-loader", url: root.url } } }, trigger: { at: 30 } };
  const trace = { events: variant === "root" ? [] : [attachedFrame] };
  if (variant !== "root") item.childNativeFrame = { ...structuredClone(selectManagedDownloadFrame(item, trace)), started: { at: 20 }, completed: { at: 25 },
    nativeFrameTree: { frameTree: { frame: { id: "child-target", parentId: "root-target", loaderId: "original-child-loader", url: child.url } } } };
  const begin = { sequence: 1, at: 40, source: variant === "root" ? { tabId: 17 } : { tabId: 17, sessionId: "original-child-session" }, params: { frameId: variant === "root" ? "root-target" : "child-target" } };
  return { item, trace, begin };
}

test("session-scoped remote child evidence accepts a root tree containing only the root", () => {
  for (const variant of ["root", "oopif", "dynamic-oopif"]) {
    const { item, trace, begin } = frameEvidence(variant);
    assert.equal(item.nativeFrameTree.frameTree.childFrames, undefined);
    assertManagedDownloadFrame(item, trace, begin);
    if (variant !== "root") {
      delete item.childNativeFrame.nativeFrameTree.frameTree.frame.parentId;
      assertManagedDownloadFrame(item, trace, begin);
    }
  }
});

test("remote native evidence rejects wrong session, target, parent, document, process and timing", () => {
  for (const mutate of [
    f => { f.begin.source.sessionId = "other"; }, f => { f.begin.source.tabId = 18; }, f => { f.begin.params.frameId = "root-target"; },
    f => { f.item.childNativeFrame.source.sessionId = "other"; }, f => { f.item.childNativeFrame.nativeFrameTree.frameTree.frame.id = "other"; },
    f => { f.item.childNativeFrame.nativeFrameTree.frameTree.frame.parentId = "other"; }, f => { f.item.childNativeFrame.nativeFrameTree.frameTree.frame.url += "-changed"; },
    f => { f.item.childNativeFrame.nativeFrameTree.frameTree.frame.loaderId = ""; }, f => { f.item.beforeTrigger.frames[1].documentId = "successor"; },
    f => { f.item.beforeTrigger.frames[1].parentDocumentId = "other"; }, f => { f.item.beforeTrigger.frames[1].processId = 1; },
    f => { f.trace.events[0].params.targetInfo.parentFrameId = "other"; }, f => { f.trace.events[0].params.targetInfo.parentId = "other"; },
    f => { f.trace.events[0].source.tabId = 18; }, f => { f.trace.events.push(structuredClone(f.trace.events[0])); },
    f => { f.item.childNativeFrame.completed.at = 35; }, f => { f.item.childNativeFrame.started.at = 5; },
    f => { delete f.item.childNativeFrame; }, f => { f.item.nativeFrameTree.frameTree.frame.id = "other-root"; },
  ]) {
    const fixture = frameEvidence(); mutate(fixture);
    assert.throws(() => assertManagedDownloadFrame(fixture.item, fixture.trace, fixture.begin));
  }
});

test("root native source cannot borrow a remote session or a different native frame", () => {
  for (const mutate of [f => { f.begin.source.sessionId = "remote"; }, f => { f.begin.params.frameId = "other"; },
    f => { f.item.nativeFrameTree.frameTree.frame.url = "http://localhost/other"; }]) {
    const fixture = frameEvidence("root"); mutate(fixture);
    assert.throws(() => assertManagedDownloadFrame(fixture.item, fixture.trace, fixture.begin));
  }
});

test("first arm failure preserves one original attempt, stops passive observer and never clicks or restarts", async () => {
  const native = chromeFixture(); let newTabs = 0, navigations = 0, arms = 0, clicks = 0, stoppedNotifications = 0;
  const original = new Error("original arm refused"), scope = { sessionId: "task", turnId: "turn", controlEpoch: 3 };
  const client = { ...scope, getTabs: async () => [], getInfo: async () => ({ metadata: { downloadWaitPathVersion: 1, pageDownloads: { available: true, generation: "generation" } } }),
    onNotification: () => () => { stoppedNotifications++; } };
  const owner = { client, newTab: async () => { newTabs++; return { id: 17, locator: () => ({ textContent: async () => "{}" }), expectDownload: async () => { arms++; throw original; },
    getByRole: () => ({ click: async () => { clicks++; } }) }; }, cdp: { navigate: async () => { navigations++; } } };
  const foreign = { client: { ...client, sessionId: "foreign" } };
  native.chrome.debugger.getTargets = async () => [{ id: "root-target", type: "page", tabId: 17 }];
  native.chrome.webNavigation = { getAllFrames: async () => [{ frameId: 0, processId: 1 }] };
  native.chrome.scripting = { executeScript: async () => [{ frameId: 0, documentId: "document", result: { url: "http://127.0.0.1/original", state: {} } }] };
  const context = vm.createContext({ chrome: native.chrome, structuredClone, performance });
  const worker = { evaluate: expression => vm.runInContext(expression, context) };
  const fixture = { createCase: () => ({ key: "original", kind: "post", owner: "task", urlPath: "/original" }), allStats: () => ({ preserved: true }) };
  const heldFixture = { allStats: () => ({ pendingOriginal: true }) }, detail = {};
  await assert.rejects(checkManagedDownloads({ owner, foreign, worker, fixture, heldFixture, fixtureURL: "http://127.0.0.1:50000/", downloadRoot: path.resolve(".tmp/fixture-only"), until: async () => { throw Error("unexpected poll"); }, detail }), error => error === original && error.managedDownloadDetail === detail);
  assert.equal(newTabs, 1); assert.equal(navigations, 1); assert.equal(arms, 1); assert.equal(clicks, 0);
  assert.equal(detail.cases.length, 1); assert.equal(detail.passed, false); assert.equal(detail.error.message, original.message);
  assert.equal(detail.operations.at(-1).label, "root-post.arm"); assert.equal(detail.operations.at(-1).error.message, original.message);
  assert.equal(detail.witnessFinal.stopped, true); assert.equal(native.listeners.size, 0); assert.equal(stoppedNotifications, 2);
  assert.deepEqual(detail.heldServerBeforeRunnerCleanup, { pendingOriginal: true });
});

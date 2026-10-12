import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createContext, runInContext } from "node:vm";
import test from "node:test";
import { assertCreatedPageReceipt, assertCreatedPageSource, checkCreatedPageProvenance, createdPageAction, installCreatedPageObserver } from "./created-page-provenance.mjs";

function observer() {
  const listeners = new Set(), chrome = { webNavigation: { onCreatedNavigationTarget: { addListener: fn => listeners.add(fn), removeListener: fn => listeners.delete(fn), hasListener: fn => listeners.has(fn) } } };
  const context = createContext({ chrome, structuredClone, Date });
  const ack = runInContext(`(${installCreatedPageObserver.toString()})(chrome,globalThis)`, context);
  return { ack, context, listeners, api: context.__createdPageProvenance, emit: details => { for (const fn of listeners) fn(details); } };
}
const native = (sourceTabId = 10, tabId = 30) => ({ sourceTabId, sourceFrameId: 2, sourceProcessId: 99, tabId, url: "http://127.0.0.1:8000/created-page/child", timeStamp: -1000 });

test("actual serialized worker observer arms before events, preserves complete native metadata and uses source IDs rather than URL", () => {
  const observed = observer(); assert.equal(observed.ack.installed, true);
  observed.emit(native()); assert.equal(observed.api.snapshot().events.length, 0);
  const ready = observed.api.register(10); assert.equal(ready.readySequence, 0);
  observed.emit({ ...native(20), extraNativeMetadata: "same URL, wrong source" }); assert.equal(observed.api.snapshot().events.length, 0);
  const original = { ...native(), extraNativeMetadata: { deep: "preserved" } }; observed.emit(original); original.extraNativeMetadata.deep = "changed";
  const snapshot = observed.api.snapshot(); assert.equal(snapshot.events.length, 1); assert.equal(snapshot.events[0].sequence, 1);
  assert.equal(snapshot.events[0].details.timeStamp, -1000); assert.equal(snapshot.events[0].details.extraNativeMetadata.deep, "preserved");
  snapshot.events.length = 0; assert.equal(observed.api.snapshot().events.length, 1);
  const stopped = observed.api.stop(); assert.equal(stopped.closed, true); assert.equal(stopped.listenerPresent, false); assert.equal(observed.listeners.size, 0);
  observed.emit(native()); assert.equal(observed.api.snapshot().events.length, 1); assert.throws(() => observed.api.register(11), /Invalid/);
});

test("observer registry and ledger have hard bounds with explicit overflow and actual listener removal", () => {
  const observed = observer();
  for (let id = 0; id < 6; id++) observed.api.register(id);
  for (const id of [0, 6, -1, "1", 1.5]) assert.throws(() => observed.api.register(id), /Invalid/);
  for (let index = 0; index < 65; index++) observed.emit(native(0, index + 100));
  const snapshot = observed.api.snapshot(); assert.equal(snapshot.sequence, 65); assert.equal(snapshot.events.length, 64); assert.equal(snapshot.overflow, true);
  assert.equal(observed.api.stop().listenerPresent, false); assert.equal(observed.listeners.size, 0);
});

function sourceProof() {
  const sourceBefore = { key: "case-first", owner: "first", sourceNonce: "source-original", documentToken: "original-source-dom", clicks: [] };
  const sourceFrame = { frameId: 2, parentFrameId: 0, processId: 99, documentId: "original-source-document", url: "http://localhost:8000/created-page/frame?key=case-first" };
  const item = { key: sourceBefore.key, owner: sourceBefore.owner, tabId: 10, childURL: native().url, observerReady: { readySequence: 0 }, sourceBefore, sourceFrame };
  return { item, events: [{ sequence: 1, details: native() }], afterFrames: [structuredClone(sourceFrame)], sourceState: { ...sourceBefore, clicks: [{ trusted: true, ctrlKey: true, metaKey: false, altKey: false, shiftKey: false, button: 0, sourceNonce: sourceBefore.sourceNonce, documentToken: sourceBefore.documentToken, href: item.childURL, sequence: 1 }] } };
}

test("source join uses exact numeric native frame/source IDs and stable document observations, never native timestamp arithmetic", () => {
  const proof = sourceProof(); assert.equal(assertCreatedPageSource(proof), 30);
  delete proof.item.sourceFrame.processId; delete proof.afterFrames[0].processId;
  assert.equal(assertCreatedPageSource(proof), 30, "getAllFrames versions without processId remain observational, native field retained");
});

test("same URL from a foreign source, wrong frame, document replacement, duplicate event and untrusted click all fail", () => {
  const mutations = [
    value => value.events[0].details.sourceTabId++, value => value.events[0].details.sourceFrameId++,
    value => value.events[0].details.sourceProcessId++, value => { value.events[0].details.sourceFrameId = "2"; },
    value => { value.afterFrames[0].documentId = "successor-document"; }, value => value.afterFrames[0].processId++,
    value => value.events.push(structuredClone(value.events[0])), value => { value.events[0].sequence = 0; },
    value => { value.sourceState.clicks[0].trusted = false; }, value => { value.sourceState.clicks[0].ctrlKey = false; },
    value => { value.sourceState.documentToken = "successor-dom"; }, value => { value.sourceState.sourceNonce = "successor-html"; }
  ];
  for (const mutate of mutations) { const proof = sourceProof(); mutate(proof); assert.throws(() => assertCreatedPageSource(proof)); }
});

const bytes = text => { const value = Buffer.from(text); return { bytes: value.length, sha256: createHash("sha256").update(value).digest("hex"), base64: value.toString("base64") }; };
function receiptProof() {
  const nonce = "original-child-nonce", documentToken = "child-dom-original";
  const item = { key: "case-first", owner: "first", childURL: native().url, childBefore: { documentNonce: nonce, documentToken }, childFrame: { documentId: "native-child-original" } };
  const fields = { key: item.key, owner: item.owner, documentNonce: nonce, documentToken, trusted: "true", buttonCount: "1" };
  const receipt = { ok: true, key: item.key, owner: item.owner, documentNonce: nonce };
  const post = { method: "POST", url: "/created-page/receipt", status: 200, once: true, finished: true, aborted: false,
    body: { ...bytes(new URLSearchParams(fields).toString()), truncated: false }, fields, fieldEntries: Object.entries(fields), response: bytes(JSON.stringify(receipt)) };
  const html = bytes(`<html>${nonce}</html>`), child = { nonce, posts: [post], html, get: { method: "GET", url: "/created-page/child", status: 200, finished: true, aborted: false, response: structuredClone(html) } };
  return { item, child, state: { documentNonce: nonce, documentToken, clicks: [{ trusted: true, sequence: 1, documentNonce: nonce, documentToken }] }, receipt, frames: [{ frameId: 0, documentId: item.childFrame.documentId, url: item.childURL }] };
}

test("receipt joins exact served child nonce, original request/response bytes, DOM token and unchanged child document", () => {
  const proof = receiptProof(); assert.deepEqual(assertCreatedPageReceipt(proof), { bytes: proof.child.posts[0].body.bytes, sha256: proof.child.posts[0].body.sha256 });
});

test("wrong owner/document, forged raw bytes, changed document, false trust and repeat POST cannot pass receipt gate", () => {
  const mutations = [value => { value.child.nonce = "other-same-url-child"; }, value => { value.child.posts[0].fields.owner = "second"; },
    value => { value.state.documentToken = "successor-dom"; }, value => { value.frames[0].documentId = "successor-document"; },
    value => { value.child.posts[0].body.base64 = Buffer.from("wrong original bytes").toString("base64"); },
    value => { value.child.posts[0].response.sha256 = "bad"; }, value => { value.child.posts[0].finished = false; },
    value => { value.child.posts[0].body.truncated = true; }, value => { value.child.posts[0].status = 409; },
    value => { value.state.clicks[0].trusted = false; }, value => value.child.posts.push(structuredClone(value.child.posts[0])),
    value => { value.child.get.url += "?guessed=1"; }];
  for (const mutate of mutations) { const proof = receiptProof(); mutate(proof); assert.throws(() => assertCreatedPageReceipt(proof)); }
});

test("original deadline truncates action, expired gate performs zero actions, late ACK fails without replay", async () => {
  let now = 100, calls = [];
  assert.equal(await createdPageAction(1100, options => { calls.push(options); return "ack"; }, () => now), "ack");
  assert.deepEqual(calls, [{ timeoutMs: 1000 }]);
  now = 1100; await assert.rejects(createdPageAction(1100, () => calls.push("wrong"), () => now), /before action/); assert.equal(calls.length, 1);
  now = 100; await assert.rejects(createdPageAction(1100, options => { calls.push(options); now = 1200; return "late actual ack"; }, () => now), /at ACK/);
  assert.equal(calls.length, 2); assert.deepEqual(calls[1], { timeoutMs: 1000 });
  const original = new Error("native original error"); await assert.rejects(createdPageAction(2000, () => { throw original; }, () => now), error => error === original);
});

test("partial owner setup failure still actually finalizes and closes established owner, saves original failure", async () => {
  const original = new Error("second connection failed"), calls = [], detail = {}; let connections = 0, saved;
  const browser = { client: { sessionId: "first", finalizeTabs: async options => { calls.push(["finalize", options]); } }, close() { calls.push(["close"]); } };
  await assert.rejects(checkCreatedPageProvenance({
    connectBrowser: async () => { if (connections++) throw original; return browser; },
    getWorker: () => ({ evaluate: async expression => { calls.push(["evaluate", expression]); return []; } }),
    fixtureURL: "http://127.0.0.1:8000/", server: { allStats: () => ({ cases: [] }) }, until: async () => { throw new Error("unexpected wait"); },
    saveDetail: async value => { saved = value; }, detail
  }), error => error === original && error.originalCreatedPageDetail === detail);
  assert.deepEqual(calls[0], ["finalize", []]); assert.deepEqual(calls.at(-1), ["close"]);
  assert.equal(saved, detail); assert.match(detail.error, /second connection failed/); assert.deepEqual(detail.remainingTabs, []);
  assert.ok(detail.cleanup.every(entry => entry.ok));
});

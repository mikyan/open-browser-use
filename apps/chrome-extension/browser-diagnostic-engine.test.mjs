import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { test } from "node:test";
import { BrowserActionEngine } from "./browser-action-engine.js";

const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };
const tick = () => new Promise(resolve => setImmediate(resolve));
const scope = { session_id: "original", turn_id: "turn", control_epoch: 1, tabId: 42 };
const log = text => ({ type: () => "log", text: () => text, location: () => ({}), args: () => [] });

function fixture({ restricted = true, authorize = async () => {}, subscription } = {}) {
  const page = new EventEmitter(), sources = new WeakMap(), calls = [], state = { document: {}, policy: {}, page };
  page._channel = { updateSubscription: params => { calls.push(["subscription", page, params]); return subscription?.(params) ?? Promise.resolve(); } };
  page.locator = () => ({ click: async () => { calls.push(["click"]); } });
  const app = { attach: async () => state.page, detach: async () => { calls.push(["detach"]); } };
  const capture = value => { const proof = sources.get(value); if (!proof) throw new Error("OBU_SITE_ACCESS_UNVERIFIED: original event source missing"); return proof; };
  const runtime = { crx: { start: async () => app }, setOpenBrowserUseEventFilter() {}, setOpenBrowserUseCommandObserver() {}, assertOpenBrowserUseSelector() {},
    captureOpenBrowserUseDiagnosticSource: (kind, value, originalPage) => { assert.equal(originalPage, page); return capture(value); },
    captureOpenBrowserUseNetworkWaitRequest: (value, originalPage) => { assert.equal(originalPage, page); return capture(value); },
    createOpenBrowserUseResponseBodyRead: response => ({ finished: Promise.resolve(), read: guard => {
      guard(); calls.push(["body", response]); return Promise.resolve({ body: "original bytes", base64Encoded: false });
    } }) };
  globalThis.chrome = { tabs: { get: async () => ({ incognito: false }) } };
  const engine = new BrowserActionEngine({ loadRuntime: async () => runtime, authorize, restrictedSelectors: () => restricted,
    captureDiagnosticAuthority() { const policy = state.policy; return { restricted, check(proof) {
      if (state.policy !== policy) throw new Error("OBU_SITE_ACCESS_UNVERIFIED: original policy ended");
      proof?.check();
      if (proof?.urls.some(url => !url.startsWith("https://allowed.test/"))) throw new Error("OBU_SITE_ACCESS_DENIED: original event origin denied");
    } }; } });
  const prove = (value, url = "https://allowed.test/page") => {
    const document = state.document;
    sources.set(value, { urls: [url], frameUrl: url, check() {
      if (document !== state.document) throw new Error("OBU_SITE_ACCESS_UNVERIFIED: original document ended");
    } }); return value;
  };
  const request = url => ({ url: () => url, method: () => "POST", resourceType: () => "fetch", frame: () => ({ url: () => "https://wrong-current.test/" }), redirectedFrom: () => null });
  return { page, state, engine, runtime, app, prove, request, calls,
    diagnostic: args => engine.dispatch({ ...scope, action: "diagnostics", args }),
    click: timeoutMs => engine.dispatch({ ...scope, action: "click", locator: [{ kind: "css", selector: "button" }], timeoutMs }),
    body: ref => engine.dispatch({ ...scope, action: "responseBody", args: ref }) };
}

test("restricted native sources retain ordinary console/errors and allowed bodies while denied or unknown entries drop individually", async () => {
  const f = fixture(); await f.diagnostic();
  f.page.emit("console", f.prove(log("allowed text")));
  f.page.emit("pageerror", f.prove(new Error("original error")));
  f.page.emit("console", log("unproved native Log or worker"));
  const denied = f.prove(f.request("https://denied.test/private"), "https://denied.test/private");
  f.page.emit("response", { request: () => denied, status: () => 200, statusText: () => "OK" });
  const original = f.prove(f.request("https://allowed.test/body"));
  const response = { request: () => original, status: () => 503, statusText: () => "Error response" };
  f.page.emit("response", response);
  const result = await f.diagnostic();
  assert.deepEqual(result.value.entries.map(row => row.kind), ["console", "pageerror", "response"]);
  assert.equal(result.value.dropped, 2); assert.equal(result.value.entries[2].frameUrl, "https://allowed.test/page");
  assert.equal(JSON.stringify(result).includes("private"), false);
  const ref = { captureId: result.value.captureId, requestId: result.value.entries[2].requestId };
  const body = await f.body(ref); f.engine.assertDiagnosticResult(body);
  assert.equal(Buffer.from(body.value.data, "base64").toString(), "original bytes");
  await f.body(ref); assert.deepEqual(f.calls.filter(row => row[0] === "body"), [["body", response], ["body", response]], "each explicit read uses its original response, never a cache/refetch");
  f.state.document = {};
  assert.throws(() => f.engine.assertDiagnosticResult(body), /original document ended/);
  await assert.rejects(f.body(ref), /original document ended/);
  assert.equal((await f.diagnostic()).value.entries.length, 0);
  await f.engine.detach(42);
});

test("the same selected snapshot is fenced through a later backend await without silently selecting a new document", async () => {
  const f = fixture(); await f.diagnostic();
  f.page.emit("console", f.prove(log("first document"))); const selected = await f.diagnostic();
  await tick(); f.state.document = {}; f.page.emit("console", f.prove(log("successor document")));
  assert.throws(() => f.engine.assertDiagnosticResult(selected), /original document ended/);
  const fresh = await f.diagnostic(); assert.equal(fresh.value.entries[0].text, "successor document");
  f.state.policy = {}; assert.throws(() => f.engine.assertDiagnosticResult(fresh), /original policy ended/);
  await assert.rejects(f.diagnostic(), /original policy ended/); await f.engine.detach(42);
});

test("a proven original response may finish its own allowed navigation before a fresh complete-tree check", async () => {
  let version = 1;
  const f = fixture({ authorize: async () => { const current = version; return () => {
    if (current !== version) throw new Error("OBU_SITE_ACCESS_UNVERIFIED: permission snapshot changed");
  }; } }), finished = deferred(), bound = deferred();
  await f.diagnostic();
  const req = f.prove(f.request("https://allowed.test/navigation")), response = { request: () => req, status: () => 200, statusText: () => "OK" };
  f.page.emit("response", response); const captured = await f.diagnostic();
  f.runtime.createOpenBrowserUseResponseBodyRead = original => {
    assert.equal(original, response); bound.resolve();
    return { finished: finished.promise, read: guard => { guard(); f.calls.push(["body", original]); return Promise.resolve({ body: "original", base64Encoded: false }); } };
  };
  const pending = f.body({ captureId: captured.value.captureId, requestId: captured.value.entries[0].requestId });
  await bound.promise; await tick(); version++; finished.resolve();
  const result = await pending; assert.equal(Buffer.from(result.value.data, "base64").toString(), "original");
  assert.equal(f.calls.filter(row => row[0] === "body").length, 1); await f.engine.detach(42);
});

test("policy change during final engine authorization prevents publication of the selected original values", async () => {
  let change = false, f;
  f = fixture({ authorize: async () => { if (change) { await tick(); f.state.policy = {}; } } });
  await f.diagnostic(); f.page.emit("console", f.prove(log("original")));
  const entry = await f.engine.pages.get(42), snapshot = entry.diagnostics.snapshot.bind(entry.diagnostics);
  entry.diagnostics.snapshot = args => { const value = snapshot(args); change = true; return value; };
  await assert.rejects(f.diagnostic(), /original policy ended/); await f.engine.detach(42);
});

test("diagnostics readiness gates the next original input on every actual filter ACK", async () => {
  const gate = deferred(), f = fixture({ subscription: params => params.event === "request" && params.enabled ? gate.promise : undefined });
  let settled = false; const action = f.click(1000).then(() => { settled = true; });
  await tick(); assert.equal(settled, false); assert.equal(f.calls.some(row => row[0] === "click"), false);
  gate.resolve(); await action; assert.equal(f.calls.filter(row => row[0] === "click").length, 1); await f.engine.detach(42);
});

test("expired registration keeps late enable and disable ACKs in the actual drain without late input", async () => {
  const enable = deferred(), disable = deferred(), f = fixture({ subscription: params => params.event === "request" ? (params.enabled ? enable.promise : disable.promise) : undefined });
  const action = f.click(20); await assert.rejects(action, /timed out/);
  const cleanup = f.engine.releases.get(42); assert.ok(cleanup);
  assert.ok(f.engine.controlSnapshot().pending.includes(cleanup));
  enable.resolve(); await tick(); assert.ok(f.engine.controlSnapshot().pending.includes(cleanup));
  assert.equal(f.calls.filter(row => row[0] === "click").length, 0);
  assert.deepEqual(f.calls.filter(row => row[0] === "subscription" && row[2].event === "request").map(row => row[2].enabled), [true, false]);
  disable.resolve(); await cleanup; await tick(); assert.equal(f.engine.controlSnapshot().pending.length, 0);
});

test("failed original disable ACK preserves cleanup for an explicit retry instead of acknowledging detach", async () => {
  let fail = true;
  const f = fixture({ subscription: params => params.event === "request" && !params.enabled && fail ? Promise.reject(new Error("native filter rejection")) : undefined });
  await f.diagnostic(); await assert.rejects(f.engine.detach(42), /OBU_DIAGNOSTICS_CLEANUP_FAILED/);
  assert.equal(f.calls.some(row => row[0] === "detach"), false); assert.ok(f.engine.pages.has(42)); assert.equal(f.engine.diagnosticCleanups.size, 1);
  fail = false;
  await assert.rejects(f.engine.detach(42), /OBU_DIAGNOSTICS_CLEANUP_FAILED/);
  assert.equal(f.calls.filter(row => row[0] === "subscription" && row[2].event === "request" && !row[2].enabled).length, 1, "automatic detach cannot replay failed cleanup");
  await f.engine.drainDiagnosticCleanup({ retryFailed: true }); await f.engine.detach(42);
  assert.equal(f.engine.pages.size, 0); assert.equal(f.engine.diagnosticCleanups.size, 0);
  assert.equal(f.calls.filter(row => row[0] === "detach").length, 1);
});

test("forget retains the old cleanup ACK without granting new attachment authority or touching a successor Page", async () => {
  const gate = deferred(), f = fixture({ subscription: params => params.event === "request" && !params.enabled ? gate.promise : undefined });
  await f.diagnostic(); f.engine.forget(42); await tick();
  const snapshot = f.engine.controlSnapshot(); assert.deepEqual(snapshot.tabIds, []); assert.equal(snapshot.pending.length, 1);
  const next = new EventEmitter(), nextCalls = []; next._channel = { updateSubscription: async params => { nextCalls.push(params); } }; f.state.page = next;
  await f.engine.attach(42); const successor = f.engine.pages.get(42);
  gate.resolve(); await Promise.all(snapshot.pending); assert.equal(f.engine.pages.get(42), successor); assert.deepEqual(nextCalls, []);
  await f.engine.detach(42);
});

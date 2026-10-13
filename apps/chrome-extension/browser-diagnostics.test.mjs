import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { test } from "node:test";
import { BrowserDiagnostics } from "./browser-diagnostics.js";
import { BrowserNetworkWaits } from "./browser-network-waits.js";

const log = text => ({ type: () => "log", text: () => text, location: () => ({ url: "https://fixture/", lineNumber: 4, columnNumber: 2 }) });
function request(url = "https://fixture/api", from = null) {
  return { url: () => url, method: () => "GET", resourceType: () => "fetch", frame: () => ({ url: () => "https://fixture/" }), redirectedFrom: () => from, failure: () => ({ errorText: "net::ERR_FAILED" }) };
}

test("real event shapes retain typed diagnostics, stable request IDs and redirect links without headers or bodies", () => {
  const page = new EventEmitter(), capture = new BrowserDiagnostics(page);
  const first = request(), redirected = request("https://fixture/next", first);
  page.emit("console", log("fixture log"));
  page.emit("pageerror", new TypeError("fixture error"));
  page.emit("request", first);
  page.emit("response", { request: () => first, status: () => 302, statusText: () => "Found" });
  page.emit("requestfinished", first);
  page.emit("request", redirected);
  page.emit("requestfailed", redirected);
  const result = capture.snapshot();
  assert.deepEqual(result.entries.map(entry => entry.kind), ["console", "pageerror", "request", "response", "requestfinished", "request", "requestfailed"]);
  assert.equal(result.entries[3].requestId, result.entries[2].requestId);
  assert.equal(result.entries[5].redirectedFrom, result.entries[2].requestId);
  assert.equal(result.entries[6].failure, "net::ERR_FAILED");
  assert.equal(result.entries[0].location.lineNumber, 4);
  assert.equal(result.entries[1].name, "TypeError");
  assert.ok(capture.requestIds instanceof WeakMap);
  assert.ok(result.entries.every(entry => !Object.hasOwn(entry, "headers") && !Object.hasOwn(entry, "body")));
});

test("cursor pagination has no duplicate entries and reports bounded-buffer eviction", () => {
  const page = new EventEmitter(), capture = new BrowserDiagnostics(page, { maxEntries: 3 });
  for (let i = 1; i <= 5; i++) page.emit("console", log(`log ${i}`));
  const first = capture.snapshot({ limit: 2 });
  assert.deepEqual(first.entries.map(entry => entry.sequence), [3, 4]);
  assert.equal(first.dropped, 2);
  const second = capture.snapshot({ after: first.cursor, limit: 2 });
  assert.deepEqual(second.entries.map(entry => entry.sequence), [5]);
  assert.deepEqual(capture.snapshot({ after: second.cursor }).entries, []);
  assert.throws(() => capture.snapshot({ after: { captureId: "other capture", sequence: 0 } }), /EXPIRED/);
  assert.throws(() => capture.snapshot({ after: { captureId: capture.captureId, sequence: 6 } }), /ahead/);
  first.entries[0].text = "changed by caller";
  assert.equal(capture.snapshot().entries[0].text, "log 3");
});

test("UTF-8 field truncation and total byte budget are bounded and visible", () => {
  const page = new EventEmitter(), capture = new BrowserDiagnostics(page, { maxBytes: 19000 });
  for (let i = 0; i < 4; i++) page.emit("console", log("🧪".repeat(10000)));
  const result = capture.snapshot();
  assert.ok(result.dropped >= 2);
  assert.ok(capture.bytes <= 19000);
  for (const entry of result.entries) {
    assert.equal(entry.truncated, true);
    assert.ok(Buffer.byteLength(entry.text) <= 8192);
    assert.ok(!entry.text.includes("�"));
  }
});

test("detach disposal clears retained state and listeners, rejects old cursors and cannot capture late events", () => {
  const page = new EventEmitter(), capture = new BrowserDiagnostics(page);
  page.emit("console", log("old owner"));
  const previous = capture.snapshot();
  page.emit("close");
  assert.equal(capture.entries.length, 0);
  assert.equal(page.eventNames().length, 0);
  assert.throws(() => capture.snapshot(), /EXPIRED/);
  page.emit("console", log("late event"));
  assert.equal(capture.entries.length, 0);
  const successor = new BrowserDiagnostics(page);
  assert.notEqual(successor.captureId, previous.captureId);
  assert.throws(() => successor.snapshot({ after: previous.cursor }), /EXPIRED/);
  assert.deepEqual(successor.snapshot().entries, []);
});

test("collector failure is accounted for without throwing into the browser action", () => {
  const page = new EventEmitter(), capture = new BrowserDiagnostics(page);
  page.emit("console", { type: () => { throw new Error("broken event"); } });
  page.emit("console", log("next"));
  const snapshot = capture.snapshot();
  assert.equal(snapshot.dropped, 1);
  assert.equal(snapshot.entries[0].sequence, 2);
});

test("console argument handles are released without evaluation, including on collector failure", async () => {
  const page = new EventEmitter(), capture = new BrowserDiagnostics(page);
  let disposed = 0;
  const args = () => [{ dispose: async () => { disposed++; } }, { dispose: async () => { disposed++; throw new Error("page already closed"); } }];
  page.emit("console", { ...log("object preview"), args });
  page.emit("console", { type: () => { throw new Error("broken event"); }, args });
  await Promise.resolve();
  assert.equal(disposed, 4);
  assert.equal(capture.snapshot().entries.length, 1);
});

test("body references bind exact response entries, not same-URL requests or caller-mutated snapshots", () => {
  const page = new EventEmitter(), capture = new BrowserDiagnostics(page);
  const first = request(), second = request();
  const response = value => ({ request: () => value, status: () => 200, statusText: () => "OK" });
  const a = response(first), b = response(second);
  page.emit("request", first); page.emit("response", a);
  page.emit("request", second); page.emit("response", b);
  const snapshot = capture.snapshot(), entries = snapshot.entries.filter(value => value.kind === "response");
  const ref = capture.response({ captureId: snapshot.captureId, requestId: entries[0].requestId });
  assert.equal(ref.response, a);
  assert.equal(capture.response({ captureId: snapshot.captureId, requestId: entries[1].requestId }).response, b);
  entries[0].requestId = entries[1].requestId;
  assert.equal(ref.response, a); ref.check();
  assert.throws(() => capture.response({ captureId: "foreign", requestId: ref.requestId }), /RESPONSE_BODY_EXPIRED/);
  assert.throws(() => capture.response({ captureId: snapshot.captureId, requestId: "request-300" }), /RESPONSE_BODY_EXPIRED/);
});

test("evicting a response invalidates it promptly even if its later finished entry is still retained", () => {
  const page = new EventEmitter(), capture = new BrowserDiagnostics(page, { maxEntries: 2 });
  const original = request(), value = { request: () => original, status: () => 200, statusText: () => "OK" };
  page.emit("response", value);
  const reference = capture.response({ captureId: capture.captureId, requestId: "diag-request-1" });
  const errors = [];
  reference.onInvalidated(error => { errors.push(error.message); throw new Error("observer cannot break collector"); });
  let unsubscribed = 0; reference.onInvalidated(() => { unsubscribed++; })();
  page.emit("requestfinished", original); page.emit("console", log("evict response only"));
  assert.equal(capture.responses.size, 0); assert.equal(errors.length, 1); assert.equal(unsubscribed, 0);
  assert.equal(capture.snapshot().entries[0].kind, "requestfinished");
  assert.throws(reference.check, /RESPONSE_BODY_EXPIRED/);
  let immediate = 0; reference.onInvalidated(() => { immediate++; }); assert.equal(immediate, 1);
  capture.dispose(); assert.equal(errors.length, 1);
});

test("duplicate response events and disposal do not revive old references or leak retained objects", () => {
  const page = new EventEmitter(), capture = new BrowserDiagnostics(page, { maxEntries: 2 });
  const original = request(), value = { request: () => original, status: () => 200, statusText: () => "OK" };
  page.emit("response", value);
  const first = capture.response({ captureId: capture.captureId, requestId: "diag-request-1" });
  page.emit("response", value);
  const second = capture.response({ captureId: capture.captureId, requestId: "diag-request-1" });
  assert.throws(first.check, /EXPIRED/); second.check();
  page.emit("console", log("evict old duplicate")); second.check();
  let disposed = 0; second.onInvalidated(() => { disposed++; });
  capture.dispose(); assert.equal(disposed, 1); assert.equal(capture.responses.size, 0);
  assert.throws(second.check, /EXPIRED/);
});

test("same-ordinal network wait IDs cannot be used as diagnostic response IDs", async () => {
  const page = new EventEmitter(), diagnostics = new BrowserDiagnostics(page), waits = new BrowserNetworkWaits();
  const params = { session_id: "owner", turn_id: "turn", control_epoch: 1, tabId: 42, event: "response", match: { url: "https://fixture/api" }, timeoutMs: 1000 };
  const record = waits.reserve(params);
  try {
    await waits.arm(record, page, { ...params, attachment: 1 }, async () => {});
    const original = request(), value = { request: () => original, status: () => 200, statusText: () => "OK" };
    page.emit("response", value);
    const waited = await waits.collect({ session_id: "owner", turn_id: "turn", control_epoch: 1, tabId: 42, waiterId: record.waiterId });
    const snapshot = diagnostics.snapshot(), observed = snapshot.entries[0];
    assert.equal(waited.requestId, "request-1", "network-wait namespace and version remain unchanged");
    assert.notEqual(observed.requestId, waited.requestId, "both are ordinal one, but only one is a diagnostics ID");
    assert.throws(() => diagnostics.response({ captureId: snapshot.captureId, requestId: waited.requestId }), /RESPONSE_BODY_EXPIRED/);
    assert.equal(diagnostics.response({ captureId: snapshot.captureId, requestId: observed.requestId }).response, value);
  } finally { waits.invalidateAll(); diagnostics.dispose(); }
});

test("restricted diagnostics admit each proven event kind and count unknown native sources without reading their text", async () => {
  const page = new EventEmitter(), proofs = new WeakMap(), seen = [];
  const capture = new BrowserDiagnostics(page, { captureProof(kind, value) {
    seen.push([kind, value]);
    const proof = proofs.get(value);
    if (!proof) throw new Error("OBU_SITE_ACCESS_UNVERIFIED: original native source is unknown");
    proof.check(); return proof;
  } });
  const proof = { check() {}, urls: ["https://fixture/"], frameUrl: "https://fixture/original" };
  const req = request(), response = { request: () => req, status: () => 503, statusText: () => "Unavailable" };
  const console = log("original context"), exception = new Error("original exception");
  for (const value of [req, response, console, exception]) proofs.set(value, proof);
  let disposed = 0, read = 0;
  const unknown = { type: () => "warning", text() { read++; return "private worker text"; }, location: () => ({ url: "https://fixture/forged.js", lineNumber: 1, columnNumber: 1 }),
    args: () => [{ dispose: async () => { disposed++; } }] };
  for (const [kind, value] of [["console", console], ["pageerror", exception], ["request", req], ["response", response], ["requestfinished", req], ["requestfailed", req], ["console", unknown]]) page.emit(kind, value);
  await Promise.resolve();
  const result = capture.snapshot();
  assert.deepEqual(result.entries.map(row => row.kind), ["console", "pageerror", "request", "response", "requestfinished", "requestfailed"]);
  assert.equal(seen.length, 7); assert.equal(result.dropped, 1); assert.equal(read, 0); assert.equal(disposed, 1);
  assert.equal(JSON.stringify(result).includes("private worker"), false);
  assert.equal(result.entries[2].frameUrl, proof.frameUrl, "use original event proof, not mutable Request.frame().url()");
  assert.deepEqual(Object.keys(result).sort(), ["captureId", "startedAt", "entries", "cursor", "dropped"].sort());
});

test("retained diagnostics recheck their original document and cannot regain authority from the same URL", () => {
  const page = new EventEmitter(), original = {}, state = { document: original };
  const capture = new BrowserDiagnostics(page, { captureProof() {
    const document = state.document;
    return { urls: ["https://fixture/"], check() { if (state.document !== document) throw new Error("OBU_SITE_ACCESS_UNVERIFIED: original document ended"); } };
  } });
  page.emit("console", log("old document")); page.emit("pageerror", new Error("old error"));
  state.document = {};
  page.emit("console", log("new document"));
  const result = capture.snapshot({ limit: 1 });
  assert.deepEqual(result.entries.map(row => row.text), ["new document"]); assert.equal(result.dropped, 2);
  assert.equal(result.cursor.sequence, 3);
  assert.equal(capture.snapshot({ after: result.cursor }).dropped, 2, "each removed original event is counted once");
  assert.equal(capture.entries.length, 1);
});

test("original response proof fences an already borrowed body reference and releases it on revoked collection", () => {
  const page = new EventEmitter(); let valid = true, invalidated = 0;
  const capture = new BrowserDiagnostics(page, { captureProof() { return { urls: ["https://fixture/"],
    check() { if (!valid) throw new Error("OBU_SITE_ACCESS_DENIED: original request permission ended"); } }; } });
  const req = request(), response = { request: () => req, status: () => 200, statusText: () => "OK" };
  page.emit("response", response);
  const reference = capture.response({ captureId: capture.captureId, requestId: "diag-request-1" });
  reference.onInvalidated(() => { invalidated++; }); reference.check(); valid = false;
  assert.throws(reference.check, /OBU_SITE_ACCESS_DENIED/);
  assert.deepEqual(capture.snapshot().entries, []);
  assert.equal(capture.snapshot().dropped, 1); assert.equal(invalidated, 1); assert.equal(capture.responses.size, 0);
  assert.throws(() => capture.response({ captureId: capture.captureId, requestId: reference.requestId }), /EXPIRED/);
});

test("denied first response cannot acquire a body reference through a later same-URL allowed response", () => {
  const page = new EventEmitter(), first = request(), second = request();
  const capture = new BrowserDiagnostics(page, { captureProof(kind, value) {
    const req = kind === "response" ? value.request() : value;
    if (req === first) throw new Error("OBU_SITE_ACCESS_DENIED: original request source denied");
    return { urls: ["https://fixture/"], check() {} };
  } });
  const response = req => ({ request: () => req, status: () => 200, statusText: () => "OK" });
  const denied = response(first), allowed = response(second);
  page.emit("response", denied); page.emit("response", allowed);
  const result = capture.snapshot(); assert.equal(result.dropped, 1); assert.equal(result.entries.length, 1);
  const reference = capture.response({ captureId: result.captureId, requestId: result.entries[0].requestId });
  assert.equal(reference.response, allowed); assert.notEqual(reference.response, denied);
  assert.equal(capture.responses.size, 1);
});

test("an unusable restricted proof fails closed and never becomes a legacy unverified record", () => {
  for (const proof of [null, undefined, {}, { check: 1 }, { check() { throw new Error("OBU_SITE_ACCESS_UNVERIFIED"); } }]) {
    const page = new EventEmitter(), capture = new BrowserDiagnostics(page, { captureProof: () => proof });
    page.emit("console", log("unverified"));
    assert.deepEqual(capture.snapshot().entries, []); assert.equal(capture.snapshot().dropped, 1);
  }
});

test("snapshot final publication checks the original selected proofs after an intervening authorization await", async () => {
  const page = new EventEmitter(); let original = true;
  const capture = new BrowserDiagnostics(page, { captureProof() { const selected = original; return {
    check() { if (!original || selected !== original) throw new Error("OBU_SITE_ACCESS_UNVERIFIED: selected original document ended"); }
  }; } });
  page.emit("console", log("original result"));
  const value = capture.snapshot();
  await Promise.resolve(); original = false;
  assert.equal(typeof capture.checkSnapshot, "function", "engine needs a private final guard, not replacement snapshot data");
  assert.throws(() => capture.checkSnapshot(value), /OBU_SITE_ACCESS_UNVERIFIED/);
  assert.equal(value.entries[0].text, "original result", "failed publication must not silently select a new result");
  assert.equal(Object.keys(value).includes("proof"), false);
});

const deferredAck = () => { let resolve, reject; const promise = new Promise((a, b) => { resolve = a; reject = b; }); return { promise, resolve, reject }; };
const microtasks = async () => { for (let index = 0; index < 12; index++) await Promise.resolve(); };

test("diagnostic ready and dispose wait for real PageDispatcher subscription acknowledgments", async () => {
  const page = new EventEmitter(), enable = deferredAck(), disable = deferredAck(), calls = [];
  page._channel = { updateSubscription(params) {
    calls.push({ ...params });
    if (params.event === "request") return params.enabled ? enable.promise : disable.promise;
    return Promise.resolve();
  } };
  const capture = new BrowserDiagnostics(page);
  let ready = false, disposed = false, cleanup;
  try {
    assert.equal(typeof capture.ready?.then, "function", "page.on alone does not acknowledge server filtering");
    const registration = capture.ready.then(() => { ready = true; }, () => {});
    await microtasks(); assert.equal(ready, false);
    assert.deepEqual(calls.map(row => row.event).sort(), ["console", "request", "response", "requestFinished", "requestFailed"].sort());
    cleanup = capture.dispose(); assert.equal(typeof cleanup?.then, "function"); cleanup.then(() => { disposed = true; });
    await microtasks(); assert.equal(disposed, false);
    assert.equal(calls.filter(row => row.event === "request").length, 1, "unsubscribe cannot overtake original enable ACK");
    enable.resolve(); await registration; await microtasks();
    assert.equal(disposed, false, "actual disable ACK still owns cleanup");
    assert.deepEqual(calls.filter(row => row.event === "request"), [{ event: "request", enabled: true }, { event: "request", enabled: false }]);
    disable.resolve(); await cleanup; assert.equal(disposed, true);
  } finally { enable.resolve(); disable.resolve(); await Promise.allSettled([capture.ready, cleanup, capture.dispose()]); }
});

test("diagnostics and network waits share the same Page event queue and cannot disable each other's listeners", async () => {
  const page = new EventEmitter(), held = deferredAck(), calls = [], waits = new BrowserNetworkWaits();
  page._channel = { updateSubscription(params) { calls.push({ ...params }); return params.event === "request" && calls.filter(row => row.event === "request").length === 1 ? held.promise : Promise.resolve(); } };
  const capture = new BrowserDiagnostics(page);
  const params = { session_id: "owner", turn_id: "turn", control_epoch: 1, tabId: 42, event: "request", match: { url: "https://fixture/api" }, timeoutMs: 1000 };
  const record = waits.reserve(params); let armed, cleanup;
  try {
    assert.equal(typeof capture.ready?.then, "function"); capture.ready.catch(() => {});
    await microtasks();
    armed = waits.arm(record, page, { ...params, attachment: 1 }, async () => {}); armed.catch(() => {});
    await microtasks(); assert.equal(calls.filter(row => row.event === "request").length, 1, "second module must not use a separate subscription queue");
    cleanup = capture.dispose(); await microtasks(); held.resolve(); await armed; await cleanup;
    assert.ok(calls.filter(row => row.event === "request").every(row => row.enabled), "remaining waiter keeps the native filter enabled");
    await waits.cancel({ session_id: params.session_id, turn_id: params.turn_id, control_epoch: params.control_epoch, tabId: params.tabId, waiterId: record.waiterId });
    assert.deepEqual(calls.filter(row => row.event === "request").at(-1), { event: "request", enabled: false });
  } finally { held.resolve(); await Promise.allSettled([armed, cleanup, capture.dispose(), waits.invalidateAll()]); }
});

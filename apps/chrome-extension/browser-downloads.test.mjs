import assert from "node:assert/strict";
import test from "node:test";
import { BrowserDownloads, downloadDeadline, validateDownloadSource, validateDownloadURL } from "./browser-downloads.js";

const deferred = () => { let resolve, reject; const promise = new Promise((done, fail) => { resolve = done; reject = fail; }); return { promise, resolve, reject }; };
const tick = () => new Promise(resolve => setTimeout(resolve, 0));
const request = (extra = {}) => ({ session_id: "one", turn_id: "turn", control_epoch: 1, tabId: 7, url: "https://fixture.test/file", ...extra });
const sourceRequest = (extra = {}) => { const { url: _url, ...params } = request(extra); return params; };
const scope = record => ({ ...record.params, attachment: {}, docRevision: 1 });
function fixture(options = {}) {
  let id = 0, current = true;
  const calls = [], items = new Map();
  const downloads = {
    async download(value) { calls.push(["download", value]); const next = ++id; items.set(next, { id: next, byExtensionId: "extension", state: "complete", danger: "safe", exists: true, filename: `/downloads/file-${next}` }); return next; },
    async search(value) { calls.push(["search", value]); return items.has(value.id) ? [{ ...items.get(value.id) }] : []; },
    async cancel(value) { calls.push(["cancel", value]); }
  };
  const registry = new BrowserDownloads({ downloads, extensionId: "extension", validateScope: async () => { if (!current) throw new Error("scope changed"); }, assertScope: () => { if (!current) throw new Error("scope changed"); }, pollMs: 2, ...options });
  async function launch(params = request()) {
    const record = registry.reserve(params);
    try { const ack = await registry.start(record, { ...params, attachment: {} }); return { record, params: { ...params, downloadId: ack.downloadId } }; }
    catch (error) { void registry.retire(record).catch(() => {}); throw error; }
  }
  return { registry, downloads, calls, items, launch, invalidateScope() { current = false; } };
}

test("strict GET URL, filename and deadline validation excludes options that change native behavior", () => {
  for (const url of ["file:///secret", "https://u:p@site.test", " https://site.test", "https://site.test/a b", "https://site.test/\n", "https://site.test/" + "界".repeat(3000)]) assert.throws(() => validateDownloadURL(request({ url })));
  for (const filename of ["", ".", "..", "../file", "C:\\file", "a/b", "a:b", "a?b", "a\0b", "file.", "file ", "CON", "lpt9.txt", "界".repeat(86)]) assert.throws(() => validateDownloadURL(request({ filename })));
  for (const timeoutMs of [null, 0, 120001, 1.2, Infinity, "10"]) assert.throws(() => downloadDeadline({ timeoutMs }));
  for (const extra of [{ headers: [] }, { saveAs: true }, { method: "POST" }, { overwrite: true }]) assert.throws(() => validateDownloadURL(request(extra)));
  assert.equal(validateDownloadURL(request({ filename: "中文.csv", url: "https://fixture.test/file#part" })).filename, "中文.csv");
});

test("same URL remains distinct by exact native ID; search only queries that ID", async () => {
  const env = fixture(), a = await env.launch(), b = await env.launch(request({ session_id: "two", tabId: 8 }));
  assert.notEqual(a.params.downloadId, b.params.downloadId);
  assert.deepEqual(await env.registry.path(a.params), { path: "/downloads/file-1" });
  assert.deepEqual(await env.registry.path(b.params), { path: "/downloads/file-2" });
  assert.deepEqual(env.calls.filter(([name]) => name === "search"), [["search", { id: 1 }], ["search", { id: 2 }]]);
  assert.deepEqual(env.calls[0], ["download", { url: request().url, saveAs: false, conflictAction: "uniquify" }]);
  for (const params of [{ ...a.params, session_id: "two" }, { ...a.params, turn_id: "later" }, { ...a.params, control_epoch: 2 }, { ...a.params, tabId: 8 }, { ...a.params, downloadId: 1 }]) await assert.rejects(env.registry.path(params), /OBU_DOWNLOAD_EXPIRED/);
});

test("late start ID after timeout is tracked and canceled exactly, never published", async () => {
  const env = fixture(), gate = deferred();
  env.downloads.download = () => gate.promise;
  await assert.rejects(env.launch(request({ timeoutMs: 15 })), /OBU_DOWNLOAD_TIMEOUT/);
  assert.equal(env.registry.records.size, 1);
  assert.ok(env.registry.controlSnapshot().pending.length > 0);
  gate.resolve(53);
  await env.registry.invalidateAll();
  assert.deepEqual(env.calls, [["cancel", 53]]);
  assert.equal(env.registry.records.size, 0);
});

test("end before start resolves retires the handle and drains actual native cancel", async () => {
  const env = fixture(), start = deferred(), cancel = deferred();
  env.downloads.download = () => start.promise;
  env.downloads.cancel = id => { env.calls.push(["cancel", id]); return cancel.promise; };
  const result = assert.rejects(env.launch(), /OBU_DOWNLOAD_EXPIRED/);
  await tick(); let drained = false;
  const cleanup = env.registry.invalidateSession("one").then(() => { drained = true; });
  await result; start.resolve(99); await tick();
  assert.equal(drained, false); assert.ok(env.registry.controlSnapshot().pending.length);
  cancel.resolve(); await cleanup;
  assert.deepEqual(env.calls, [["cancel", 99]]);
});

test("path deadline does not cancel or discard a download and a later call can complete", async () => {
  const env = fixture(), { params, record } = await env.launch();
  env.items.get(1).state = "in_progress";
  await assert.rejects(env.registry.path({ ...params, timeoutMs: 15 }), /OBU_DOWNLOAD_TIMEOUT/);
  assert.equal(record.cancellationListeners.size, 0);
  assert.equal(env.calls.some(([name]) => name === "cancel"), false);
  env.items.get(1).state = "complete";
  assert.equal((await env.registry.path(params)).path, "/downloads/file-1");
  assert.equal(record.cancellationListeners.size, 0);
});

test("cancel wakes a concurrent hung path but the genuine native query remains tracked", async () => {
  const env = fixture(), { params } = await env.launch(), query = deferred();
  env.downloads.search = () => query.promise;
  const waiting = assert.rejects(env.registry.path(params), /OBU_DOWNLOAD_EXPIRED/);
  await tick(); assert.deepEqual(await env.registry.cancel(params), { cancelled: true });
  await waiting;
  assert.ok(env.registry.controlSnapshot().pending.length);
  query.resolve([env.items.get(1)]); await tick();
  assert.equal(env.registry.controlSnapshot().pending.length, 0);
});

test("cleanup failure stays bounded and retryable, never becomes empty success", async () => {
  const env = fixture({ maxRecords: 1 }); await env.launch();
  env.downloads.cancel = async () => { throw new Error("native cancel failed"); };
  await assert.rejects(env.registry.invalidateAll(), /OBU_DOWNLOAD_CLEANUP_FAILED/);
  assert.equal(env.registry.records.size, 1);
  assert.throws(() => env.registry.reserve(request()), /OBU_DOWNLOAD_LIMIT/);
  env.downloads.cancel = async id => env.calls.push(["cancel", id]);
  await env.registry.invalidateAll();
  assert.equal(env.registry.records.size, 0);
  assert.deepEqual(env.calls.at(-1), ["cancel", 1]);
});

test("query responses cannot escape after live ownership, epoch, or identity changes", async () => {
  const env = fixture(), { params } = await env.launch(), gate = deferred();
  env.downloads.search = () => gate.promise;
  const reading = assert.rejects(env.registry.path(params), /scope changed/);
  await tick(); env.invalidateScope(); gate.resolve([env.items.get(1)]); await reading;
  await env.registry.invalidateAll();
});

test("native absence, identity mismatch, dangerous, interrupted, missing or relative path are explicit failures", async () => {
  const env = fixture(), { params } = await env.launch(), original = { ...env.items.get(1) };
  for (const [change, code] of [[{ id: 2 }, "NOT_FOUND"], [{ byExtensionId: "other" }, "NOT_FOUND"], [{ danger: "accepted" }, "DANGEROUS"], [{ state: "interrupted", error: "NETWORK_FAILED" }, "INTERRUPTED"], [{ exists: false }, "NOT_FOUND"], [{ filename: "relative/file" }, "PATH_UNAVAILABLE"], [{ filename: "/bad\0path" }, "PATH_UNAVAILABLE"], [{ filename: "" }, "PATH_UNAVAILABLE"]]) {
    env.items.set(1, { ...original, ...change });
    await assert.rejects(env.registry.path(params), new RegExp(`OBU_DOWNLOAD_${code}`));
  }
  env.items.set(1, { ...original, danger: "deepScannedSafe", filename: "C:\\Downloads\\file.csv" });
  assert.equal((await env.registry.path(params)).path, "C:\\Downloads\\file.csv");
});

test("only the exact unbound reservation survives an authorized attachment migration", async () => {
  const env = fixture(), preserved = env.registry.reserve(request()), other = env.registry.reserve(request());
  await env.registry.invalidateTab(7, preserved);
  env.registry.check(preserved);
  assert.throws(() => env.registry.check(other), /OBU_DOWNLOAD_EXPIRED/);
  await env.registry.invalidateAll();
});

test("cold setup timeout never starts a later download after admission unblocks", async () => {
  const env = fixture(), record = env.registry.reserve(request({ timeoutMs: 10 })), gate = deferred();
  const result = env.registry.within(record, record.deadlineAt, async () => { await gate.promise; return env.registry.start(record, { ...record.params, attachment: {} }); });
  await assert.rejects(result, /OBU_DOWNLOAD_TIMEOUT/);
  await env.registry.retire(record); gate.resolve(); await tick();
  assert.deepEqual(env.calls, []);
});

test("source reservations validate the base request without a placeholder URL and take capacity immediately", async () => {
  const env = fixture({ maxRecords: 1, now: () => 100 });
  for (const extra of [{ url: "https://fixture.test/file" }, { locator: {} }, { headers: [] }, { timeoutMs: null }, { control_epoch: 0 }, { filename: "../file" }])
    assert.throws(() => validateDownloadSource({ ...sourceRequest(), ...extra }));
  const params = sourceRequest({ filename: "图片.png", timeoutMs: 50 });
  const record = env.registry.reserveSource(params);
  params.filename = "changed.png"; params.timeoutMs = 120000;
  assert.equal(record.params.filename, "图片.png");
  assert.equal(record.deadlineAt, 150);
  assert.equal(Object.isFrozen(record.params), true);
  assert.equal(Object.hasOwn(record.params, "url"), false);
  assert.throws(() => env.registry.reserveSource(sourceRequest()), /OBU_DOWNLOAD_LIMIT/);
  assert.throws(() => env.registry.reserve(request()), /OBU_DOWNLOAD_LIMIT/);
  assert.deepEqual(env.calls, []);
  await env.registry.invalidateAll();
});

test("nested admission and source resolution produce one exact-ID handle after actual source cleanup", async () => {
  const env = fixture(), record = env.registry.reserveSource(sourceRequest({ filename: "picture.png" }));
  const disposal = deferred(), entered = deferred();
  const started = env.registry.within(record, record.deadlineAt, () => env.registry.startFromSource(record, scope(record), async options => {
    assert.equal(options.deadlineAt, record.deadlineAt);
    options.check(); entered.resolve();
    await disposal.promise;
    return { url: "https://fixture.test/current-picture.png" };
  }));
  await entered.promise;
  assert.deepEqual(env.calls, []);
  disposal.resolve();
  const ack = await started;
  await tick();
  assert.equal(record.pendingCount, 0);
  assert.equal(env.registry.records.size, 1);
  assert.deepEqual(env.calls, [["download", { url: "https://fixture.test/current-picture.png", filename: "picture.png", saveAs: false, conflictAction: "uniquify" }]]);
  assert.deepEqual(await env.registry.path({ ...record.params, ...ack }), { path: "/downloads/file-1" });
  await env.registry.invalidateAll();
});

test("source snapshot validation cannot start non-HTTP, malformed, or ambiguous resolver results", async () => {
  for (const source of [null, [], "https://fixture.test/file", {}, { url: request().url, extra: true }, { url: "blob:https://fixture.test/id" }, { url: "data:image/png;base64,eA==" }, { url: "https://u:p@fixture.test/file" }, { url: "https://fixture.test/a b" }]) {
    const env = fixture(), record = env.registry.reserveSource(sourceRequest());
    await assert.rejects(env.registry.startFromSource(record, scope(record), async () => source));
    await env.registry.invalidateAll(); await tick();
    assert.deepEqual(env.calls, []);
    assert.equal(env.registry.records.size, 0);
  }
});

test("source timeout retains the actual resolver and capacity until its native disposal settles", async () => {
  const env = fixture({ maxRecords: 1 }), record = env.registry.reserveSource(sourceRequest({ timeoutMs: 15 }));
  const nativeDisposal = deferred(), entered = deferred();
  const started = assert.rejects(env.registry.startFromSource(record, scope(record), async () => {
    entered.resolve(); await nativeDisposal.promise; return { url: request().url };
  }), /OBU_DOWNLOAD_TIMEOUT/);
  await entered.promise; await started;
  assert.equal(record.invalid, true);
  assert.equal(env.registry.records.size, 1);
  assert.ok(env.registry.controlSnapshot().pending.length > 0);
  assert.throws(() => env.registry.reserveSource(sourceRequest()), /OBU_DOWNLOAD_LIMIT/);
  let drained = false;
  const cleanup = env.registry.invalidateSession("one").then(() => { drained = true; });
  await tick(); assert.equal(drained, false);
  nativeDisposal.resolve(); await cleanup; await tick();
  assert.deepEqual(env.calls, []);
  assert.equal(env.registry.records.size, 0);
  assert.deepEqual(env.registry.controlSnapshot().pending, []);
});

test("canceled unbound admission avoids a detach cycle but retains capacity until the actual admission settles", async () => {
  const env = fixture({ maxRecords: 1 }), record = env.registry.reserveSource(sourceRequest());
  const admission = deferred(), entered = deferred(); let resolved = false;
  const running = assert.rejects(env.registry.within(record, record.deadlineAt, async () => {
    entered.resolve(); await admission.promise;
    return env.registry.startFromSource(record, scope(record), async () => { resolved = true; return { url: request().url }; });
  }), /OBU_DOWNLOAD_EXPIRED/);
  await entered.promise;
  // The real admission may be waiting for this very cleanup in a cold owner
  // migration. Cleanup must not await admission, while capacity must retain it.
  await env.registry.invalidateSession("one"); await running;
  assert.equal(record.scope, undefined);
  assert.equal(env.registry.records.size, 1);
  assert.throws(() => env.registry.reserveSource(sourceRequest()), /OBU_DOWNLOAD_LIMIT/);
  assert.ok(env.registry.controlSnapshot().pending.length > 0);
  admission.resolve(); await tick();
  assert.equal(resolved, false); assert.deepEqual(env.calls, []);
  assert.equal(env.registry.records.size, 0);
});

test("end during bound source resolution rejects promptly but drains the actual source before completing", async () => {
  const env = fixture(), record = env.registry.reserveSource(sourceRequest());
  const native = deferred(), entered = deferred();
  const started = assert.rejects(env.registry.startFromSource(record, scope(record), async ({ check }) => {
    entered.resolve(); await native.promise; check(); return { url: request().url };
  }), /OBU_DOWNLOAD_EXPIRED/);
  await entered.promise; let drained = false;
  const cleanup = env.registry.invalidateSession("one").then(() => { drained = true; });
  await started; await tick();
  assert.equal(drained, false);
  assert.ok(env.registry.controlSnapshot().pending.length > 0);
  native.resolve(); await cleanup; await tick();
  assert.equal(env.registry.records.size, 0); assert.deepEqual(env.calls, []);
});

test("source resolution and final asynchronous scope validation spend the original total deadline", async () => {
  let now = 100, validations = 0;
  const lastScope = deferred(), entered = deferred();
  const env = fixture({ now: () => now, validateScope: async () => { if (++validations === 2) { entered.resolve(); await lastScope.promise; } } });
  const record = env.registry.reserveSource(sourceRequest({ timeoutMs: 100 }));
  const started = assert.rejects(env.registry.startFromSource(record, scope(record), async ({ deadlineAt, check }) => {
    assert.equal(deadlineAt, 200); now = 190; check(); return { url: request().url };
  }), /OBU_DOWNLOAD_TIMEOUT/);
  await entered.promise; now = 201; lastScope.resolve(); await started;
  await env.registry.invalidateAll(); await tick();
  assert.deepEqual(env.calls, []);
  assert.equal(record.deadlineAt, 200);
  assert.equal(env.registry.records.size, 0);
});

test("a changed source document cannot publish or begin a download after source resolution", async () => {
  const env = fixture(), record = env.registry.reserveSource(sourceRequest());
  const source = deferred(), entered = deferred();
  const started = assert.rejects(env.registry.startFromSource(record, scope(record), () => { entered.resolve(); return source.promise; }), /scope changed/);
  await entered.promise; env.invalidateScope(); source.resolve({ url: request().url });
  await started; await env.registry.invalidateAll(); await tick();
  assert.deepEqual(env.calls, []); assert.equal(env.registry.records.size, 0);
});

test("a source start that times out after native dispatch cancels only its exact late numeric ID", async () => {
  const env = fixture(), record = env.registry.reserveSource(sourceRequest({ timeoutMs: 15 }));
  const native = deferred(), cancellation = deferred(), entered = deferred();
  env.downloads.download = options => { env.calls.push(["download", options]); entered.resolve(); return native.promise; };
  env.downloads.cancel = id => { env.calls.push(["cancel", id]); return cancellation.promise; };
  const started = assert.rejects(env.registry.startFromSource(record, scope(record), async () => ({ url: request().url })), /OBU_DOWNLOAD_TIMEOUT/);
  await entered.promise; await started;
  let drained = false; const cleanup = env.registry.invalidateAll().then(() => { drained = true; });
  native.resolve(84); await tick();
  assert.deepEqual(env.calls.at(-1), ["cancel", 84]); assert.equal(drained, false);
  cancellation.resolve(); await cleanup; await tick();
  assert.equal(env.registry.records.size, 0);
});

test("concurrent starts are fenced before ownership validation can await", async () => {
  for (const fromSource of [false, true]) {
    const validation = deferred(), entered = deferred();
    const env = fixture({ validateScope: async () => { entered.resolve(); await validation.promise; } });
    const record = fromSource ? env.registry.reserveSource(sourceRequest()) : env.registry.reserve(request());
    let resolutions = 0;
    const start = () => fromSource ? env.registry.startFromSource(record, scope(record), async () => { resolutions++; return { url: request().url }; }) : env.registry.start(record, scope(record));
    const first = start(); await entered.promise;
    await assert.rejects(start(), /OBU_DOWNLOAD_EXPIRED/);
    validation.resolve(); await first;
    assert.equal(resolutions, fromSource ? 1 : 0);
    assert.equal(env.calls.filter(([method]) => method === "download").length, 1);
    await env.registry.invalidateAll();
  }
});

test("only the exact unbound source survives migration; a bound source is canceled even when named for preservation", async () => {
  const env = fixture(), record = env.registry.reserveSource(sourceRequest()), other = env.registry.reserveSource(sourceRequest());
  await env.registry.invalidateTab(7, record);
  env.registry.check(record); assert.throws(() => env.registry.check(other), /OBU_DOWNLOAD_EXPIRED/);
  const source = deferred(), entered = deferred();
  const started = assert.rejects(env.registry.startFromSource(record, scope(record), () => { entered.resolve(); return source.promise; }), /OBU_DOWNLOAD_EXPIRED/);
  await entered.promise;
  const cleanup = env.registry.invalidateTab(7, record);
  await started;
  source.resolve({ url: request().url }); await cleanup; await tick();
  assert.deepEqual(env.calls, []); assert.equal(env.registry.records.size, 0);
});

test("same source URL in separate sessions retains exact native identity and old scope validation", async () => {
  const env = fixture();
  const a = env.registry.reserveSource(sourceRequest());
  const b = env.registry.reserveSource(sourceRequest({ session_id: "two", tabId: 8 }));
  const one = await env.registry.startFromSource(a, scope(a), async () => ({ url: request().url }));
  const two = await env.registry.startFromSource(b, scope(b), async () => ({ url: request().url }));
  assert.notEqual(one.downloadId, two.downloadId);
  assert.deepEqual(await env.registry.path({ ...a.params, ...one }), { path: "/downloads/file-1" });
  assert.deepEqual(await env.registry.path({ ...b.params, ...two }), { path: "/downloads/file-2" });
  await assert.rejects(env.registry.path({ ...b.params, ...one }), /OBU_DOWNLOAD_EXPIRED/);
  await env.registry.invalidateAll();
});

test("failed native source disposal stays bounded and only explicit lifecycle cleanup retries that handle", async () => {
  const env = fixture({ maxRecords: 1 }), record = env.registry.reserveSource(sourceRequest());
  let resolutions = 0, retries = 0, release = false;
  const failure = Object.assign(new Error("OBU_MEDIA_CLEANUP_FAILED: exact handle disposal failed"), {
    mediaCleanupFailed: true,
    async retryMediaCleanup() { retries++; if (!release) throw new Error("same handle still unavailable"); }
  });
  await assert.rejects(env.registry.startFromSource(record, scope(record), async () => { resolutions++; throw failure; }), /OBU_MEDIA_CLEANUP_FAILED/);
  await tick();
  // A wrapper rejecting the same RPC must not turn into an automatic retry.
  await assert.rejects(env.registry.retire(record), /OBU_MEDIA_CLEANUP_FAILED/);
  assert.equal(retries, 0);
  assert.equal(env.registry.records.size, 1);
  assert.throws(() => env.registry.reserveSource(sourceRequest()), /OBU_DOWNLOAD_LIMIT/);
  await assert.rejects(env.registry.invalidateAll(), /OBU_DOWNLOAD_CLEANUP_FAILED/);
  assert.equal(retries, 1); assert.equal(env.registry.records.size, 1);
  release = true;
  await env.registry.invalidateAttachedTab(7); await tick();
  assert.equal(retries, 2); assert.equal(resolutions, 1);
  assert.equal(env.registry.records.size, 0); assert.deepEqual(env.calls, []);
});

test("a pending cleanup retry stays visible and holds capacity until actual handle disposal settles", async () => {
  const env = fixture({ maxRecords: 1 }), record = env.registry.reserveSource(sourceRequest());
  const disposal = deferred(), entered = deferred();
  const failure = Object.assign(new Error("OBU_MEDIA_CLEANUP_FAILED"), {
    mediaCleanupFailed: true,
    retryMediaCleanup() { entered.resolve(); return disposal.promise; }
  });
  await assert.rejects(env.registry.startFromSource(record, scope(record), async () => { throw failure; }), /OBU_MEDIA_CLEANUP_FAILED/);
  await tick(); let drained = false;
  const cleanup = env.registry.invalidateSession("one").then(() => { drained = true; });
  await entered.promise;
  assert.equal(drained, false);
  assert.ok(env.registry.controlSnapshot().pending.length > 0);
  assert.throws(() => env.registry.reserveSource(sourceRequest()), /OBU_DOWNLOAD_LIMIT/);
  disposal.resolve(); await cleanup; await tick();
  assert.equal(env.registry.records.size, 0);
  assert.deepEqual(env.registry.controlSnapshot().pending, []);
});

test("nested admission preserves the original source failure instead of masking it with retirement", async () => {
  const env = fixture(), record = env.registry.reserveSource(sourceRequest());
  const original = new Error("OBU_MEDIA_UNSUPPORTED: fixture source is not an HTTP image");
  const pending = env.registry.within(record, record.deadlineAt, () =>
    env.registry.startFromSource(record, scope(record), async () => { throw original; }));
  await assert.rejects(pending, error => error === original);
  await env.registry.invalidateAll(); await tick();
  assert.equal(env.registry.records.size, 0); assert.deepEqual(env.calls, []);
});

test("an earlier external cancellation keeps precedence over a late source failure", async () => {
  const env = fixture(), record = env.registry.reserveSource(sourceRequest());
  const entered = deferred(), source = deferred();
  const original = new Error("OBU_MEDIA_UNSUPPORTED: late fixture source error");
  const pending = assert.rejects(env.registry.within(record, record.deadlineAt, () =>
    env.registry.startFromSource(record, scope(record), async () => { entered.resolve(); await source.promise; throw original; })), /OBU_DOWNLOAD_EXPIRED/);
  await entered.promise;
  const cleanup = env.registry.invalidateSession("one");
  await pending;
  source.resolve(); await cleanup; await tick();
  assert.equal(record.error, undefined);
  assert.equal(env.registry.records.size, 0); assert.deepEqual(env.calls, []);
});

const sourceBytes = (bytes = Buffer.from([0, 1, 2, 255]), mimeType = "image/png") => ({ bytesBase64: bytes.toString("base64"), mimeType, byteLength: bytes.length });
const sourceReservationBytes = 8 * 1024 * 1024;

test("private embedded bytes use an exact data download ID without expanding public downloadURL", async () => {
  const env = fixture();
  const payload = sourceBytes();
  assert.throws(() => validateDownloadURL(request({ url: `data:image/png;base64,${payload.bytesBase64}` })));
  const a = env.registry.reserveSource(sourceRequest({ filename: "image.png" }));
  const b = env.registry.reserveSource(sourceRequest({ session_id: "two", tabId: 8 }));
  const one = await env.registry.startFromSource(a, scope(a), async () => payload);
  const two = await env.registry.startFromSource(b, scope(b), async () => payload);
  assert.notEqual(one.downloadId, two.downloadId);
  assert.deepEqual(env.calls.filter(([name]) => name === "download"), [
    ["download", { url: "data:image/png;base64,AAEC/w==", filename: "image.png", saveAs: false, conflictAction: "uniquify" }],
    ["download", { url: "data:image/png;base64,AAEC/w==", saveAs: false, conflictAction: "uniquify" }]
  ]);
  assert.equal(a.sourceURL, undefined);
  assert.equal(a.sourcePromise, null);
  assert.equal(env.registry.pendingSourceBytes, 0);
  assert.deepEqual(await env.registry.path({ ...a.params, ...one }), { path: "/downloads/file-1" });
  assert.deepEqual(await env.registry.path({ ...b.params, ...two }), { path: "/downloads/file-2" });
  await assert.rejects(env.registry.path({ ...b.params, ...one }), /OBU_DOWNLOAD_EXPIRED/);
  await env.registry.invalidateAll();
  assert.deepEqual(env.calls.filter(([name]) => name === "cancel"), [["cancel", 1], ["cancel", 2]]);
});

test("embedded source validation rejects malformed or ambiguous payloads before native dispatch", async () => {
  let getterCalled = false;
  const accessor = { ...sourceBytes() }; Object.defineProperty(accessor, "bytesBase64", { enumerable: true, get() { getterCalled = true; return "AA=="; } });
  const nonenumerable = { ...sourceBytes() }; Object.defineProperty(nonenumerable, "extra", { value: 1 });
  const failures = [
    { ...sourceBytes(), url: request().url }, { ...sourceBytes(), extra: true }, accessor, nonenumerable,
    { ...sourceBytes(), [Symbol("extra")]: true },
    ...[undefined, null, 0, -1, 1.5, "4", Number.MAX_SAFE_INTEGER + 1].map(byteLength => ({ ...sourceBytes(), byteLength })),
    ...["", "AAEC/w", "AAEC_w==", "AAEC/w==\n", "AAEC/===", "AAEC/x==", "aA==", "AAEC/w===", "data:image/png;base64,AAEC/w=="].map(bytesBase64 => ({ ...sourceBytes(), bytesBase64 })),
    ...["", "text/html", "Image/PNG", "image/png;name=x", "image/png\n", "image/png,xx", "image/", "image/" + "a".repeat(128)].map(mimeType => ({ ...sourceBytes(), mimeType }))
  ];
  for (const payload of failures) {
    const env = fixture(), record = env.registry.reserveSource(sourceRequest());
    await assert.rejects(env.registry.startFromSource(record, scope(record), async () => payload), /OBU_MEDIA_SOURCE_INVALID|OBU_MEDIA_LIMIT/);
    await env.registry.invalidateAll(); await tick();
    assert.deepEqual(env.calls, []);
    assert.equal(env.registry.pendingSourceBytes, 0);
  }
  assert.equal(getterCalled, false);
});

test("embedded bytes enforce the exact 8 MiB hard bound and preserve canonical base64", async () => {
  const env = fixture();
  const bytes = Buffer.alloc(sourceReservationBytes, 0xa5);
  const payload = sourceBytes(bytes, "audio/wav");
  const record = env.registry.reserveSource(sourceRequest());
  await env.registry.startFromSource(record, scope(record), async () => payload);
  assert.equal(env.calls[0][1].url, `data:audio/wav;base64,${payload.bytesBase64}`);
  await env.registry.invalidateAll();
  for (const oversized of [sourceBytes(Buffer.alloc(sourceReservationBytes + 1)), { ...sourceBytes(), byteLength: sourceReservationBytes + 1 }]) {
    const next = env.registry.reserveSource(sourceRequest());
    const count = env.calls.length;
    await assert.rejects(env.registry.startFromSource(next, scope(next), async () => oversized), /OBU_MEDIA_LIMIT/);
    await env.registry.invalidateAll();
    assert.equal(env.calls.length, count);
  }
});

test("the global byte budget is reserved before source resolution, independently of metadata capacity", async () => {
  const env = fixture();
  const records = Array.from({ length: 8 }, (_, index) => env.registry.reserveSource(sourceRequest({ tabId: index })));
  assert.equal(env.registry.pendingSourceBytes, 64 * 1024 * 1024);
  assert.throws(() => env.registry.reserveSource(sourceRequest()), /OBU_MEDIA_LIMIT/);
  const ordinary = env.registry.reserve(request());
  assert.equal(env.registry.records.size, 9);
  await env.registry.retire(records[0]);
  assert.equal(env.registry.pendingSourceBytes, 56 * 1024 * 1024);
  env.registry.reserveSource(sourceRequest());
  await env.registry.retire(ordinary);
  await env.registry.invalidateAll();
  assert.equal(env.registry.pendingSourceBytes, 0);
});

test("HTTP source settlement releases the byte reservation before an unresolved native GET start", async () => {
  const env = fixture({ maxPendingSourceBytes: sourceReservationBytes });
  const native = deferred(), entered = deferred();
  env.downloads.download = () => { entered.resolve(); return native.promise; };
  const record = env.registry.reserveSource(sourceRequest());
  const running = env.registry.startFromSource(record, scope(record), async () => ({ url: request().url }));
  await entered.promise;
  assert.equal(env.registry.pendingSourceBytes, 0);
  const next = env.registry.reserveSource(sourceRequest());
  await env.registry.retire(next);
  native.resolve(77); await running; await env.registry.invalidateAll();
});

test("embedded timeout retains byte capacity until the exact late native start settles", async () => {
  const env = fixture({ maxPendingSourceBytes: sourceReservationBytes });
  const native = deferred(), entered = deferred();
  env.downloads.download = options => { env.calls.push(["download", options]); entered.resolve(); return native.promise; };
  const record = env.registry.reserveSource(sourceRequest({ timeoutMs: 20 }));
  const pending = assert.rejects(env.registry.startFromSource(record, scope(record), async () => sourceBytes()), /OBU_DOWNLOAD_TIMEOUT/);
  await entered.promise; await pending;
  assert.equal(env.registry.pendingSourceBytes, sourceReservationBytes);
  assert.throws(() => env.registry.reserveSource(sourceRequest()), /OBU_MEDIA_LIMIT/);
  const cleanup = env.registry.invalidateAll();
  native.resolve(902); await cleanup; await tick();
  assert.equal(env.registry.pendingSourceBytes, 0);
  assert.deepEqual(env.calls.at(-1), ["cancel", 902]);
  assert.equal(env.registry.records.size, 0);
});

test("source cancellation invokes abort before joining real cleanup, not just a caller timeout race", async () => {
  const env = fixture({ maxPendingSourceBytes: sourceReservationBytes });
  const entered = deferred(), nativeRead = deferred(), nativeAbort = deferred();
  let aborts = 0, cleaned = false;
  const record = env.registry.reserveSource(sourceRequest());
  const pending = assert.rejects(env.registry.startFromSource(record, scope(record), async ({ onCancel }) => {
    const unsubscribe = onCancel(() => { aborts++; return nativeAbort.promise; });
    entered.resolve();
    try { await nativeRead.promise; return sourceBytes(); }
    finally { cleaned = true; unsubscribe(); }
  }), /OBU_DOWNLOAD_EXPIRED/);
  await entered.promise;
  let ended = false; const end = env.registry.invalidateSession("one").then(() => { ended = true; });
  assert.equal(aborts, 1); await pending;
  nativeRead.resolve(); await tick();
  assert.equal(cleaned, true); assert.equal(ended, false);
  assert.equal(env.registry.pendingSourceBytes, sourceReservationBytes);
  assert.ok(env.registry.controlSnapshot().pending.length);
  nativeAbort.resolve(); await end; await tick();
  assert.equal(ended, true); assert.equal(env.registry.pendingSourceBytes, 0);
  assert.deepEqual(env.calls, []);
});

test("a binding arriving after cancellation immediately receives abort and cannot start a download", async () => {
  const env = fixture(), entered = deferred(), binding = deferred(), abort = deferred();
  const record = env.registry.reserveSource(sourceRequest()); let calls = 0;
  const pending = assert.rejects(env.registry.startFromSource(record, scope(record), async ({ onCancel }) => {
    entered.resolve(); await binding.promise;
    const unsubscribe = onCancel(() => { calls++; return abort.promise; });
    assert.equal(calls, 1);
    await abort.promise; unsubscribe(); return sourceBytes();
  }), /OBU_DOWNLOAD_EXPIRED/);
  await entered.promise;
  const end = env.registry.invalidateAll(); await pending;
  binding.resolve(); await tick();
  assert.equal(calls, 1); assert.equal(env.registry.pendingSourceBytes, sourceReservationBytes);
  abort.resolve(); await end; await tick();
  assert.deepEqual(env.calls, []); assert.equal(env.registry.pendingSourceBytes, 0);
});

test("a failed abort remains retryable and an explicit retry can unblock the already pending cleanup", async () => {
  const env = fixture(), entered = deferred(), source = deferred(); let attempts = 0;
  const record = env.registry.reserveSource(sourceRequest());
  const pending = assert.rejects(env.registry.startFromSource(record, scope(record), async ({ onCancel }) => {
    const unsubscribe = onCancel(async () => {
      attempts++; if (attempts === 1) throw new Error("exact binding abort failed");
      source.resolve();
    });
    entered.resolve(); await source.promise; unsubscribe(); return sourceBytes();
  }), /OBU_DOWNLOAD_EXPIRED/);
  await entered.promise;
  let ended = false; const end = env.registry.invalidateSession("one").then(() => { ended = true; });
  await pending; await tick(); assert.equal(ended, false); assert.equal(attempts, 1);
  await env.registry.invalidateAll(); await end; await tick();
  assert.equal(attempts, 2); assert.equal(env.registry.pendingSourceBytes, 0);
  assert.deepEqual(env.calls, []);
});

test("abort rejection after a naturally settled source still prevents empty cleanup success", async () => {
  const env = fixture(), entered = deferred(), source = deferred(); let allow = false, attempts = 0;
  const record = env.registry.reserveSource(sourceRequest());
  const pending = assert.rejects(env.registry.startFromSource(record, scope(record), async ({ onCancel }) => {
    const unsubscribe = onCancel(() => { attempts++; if (!allow) throw new Error("exact abort failed"); });
    entered.resolve(); await source.promise; unsubscribe(); return sourceBytes();
  }), /OBU_DOWNLOAD_EXPIRED/);
  await entered.promise;
  const failed = assert.rejects(env.registry.invalidateAll(), /OBU_DOWNLOAD_CLEANUP_FAILED: exact abort failed/);
  await pending; source.resolve(); await failed; await tick();
  assert.equal(env.registry.pendingSourceBytes, sourceReservationBytes);
  assert.equal(attempts, 1); allow = true;
  await env.registry.invalidateAll(); await tick();
  assert.equal(attempts, 2); assert.equal(env.registry.pendingSourceBytes, 0);
});

test("dual abort and disposal failure retries exact source disposal before confirming cancellation", async () => {
  const env = fixture({ maxPendingSourceBytes: sourceReservationBytes });
  const entered = deferred(), source = deferred(), disposed = deferred(), finalAbort = deferred();
  let cleaned = false, cleanupAllowed = false, retryCalls = 0, abortCalls = 0;
  const events = [];
  const failure = Object.assign(new Error("OBU_MEDIA_CLEANUP_FAILED: first exact disposal failed"), {
    mediaCleanupFailed: true,
    async retryMediaCleanup() {
      retryCalls++; events.push("dispose-retry");
      if (!cleanupAllowed) throw new Error("exact disposal still failed");
      await disposed.promise; cleaned = true; events.push("disposed");
    }
  });
  const record = env.registry.reserveSource(sourceRequest());
  const running = assert.rejects(env.registry.startFromSource(record, scope(record), async ({ onCancel }) => {
    onCancel(async () => {
      abortCalls++; events.push(cleaned ? "abort-confirm" : "abort-failed");
      if (!cleaned) throw new Error("native abort failed");
      await finalAbort.promise;
    });
    entered.resolve(); await source.promise; throw failure;
  }), /OBU_DOWNLOAD_EXPIRED/);
  await entered.promise;
  // Ordinary RPC retirement neither retries cancellation nor failed disposal.
  const first = assert.rejects(env.registry.retire(record), /first exact disposal failed/);
  source.resolve(); await running; await first; await tick();
  assert.equal(retryCalls, 0); assert.equal(abortCalls, 1);
  await assert.rejects(env.registry.invalidateAll(), /OBU_DOWNLOAD_CLEANUP_FAILED: exact disposal still failed/);
  assert.equal(retryCalls, 1); assert.equal(abortCalls, 1);
  assert.equal(env.registry.pendingSourceBytes, sourceReservationBytes);
  cleanupAllowed = true;
  let ended = false; const ending = env.registry.invalidateAll().then(() => { ended = true; });
  await tick(); assert.equal(retryCalls, 2); assert.equal(abortCalls, 1); assert.equal(ended, false);
  disposed.resolve(); await tick();
  assert.equal(abortCalls, 2); assert.equal(ended, false);
  assert.ok(events.indexOf("disposed") < events.indexOf("abort-confirm"));
  assert.ok(env.registry.controlSnapshot().pending.length);
  assert.equal(env.registry.pendingSourceBytes, sourceReservationBytes);
  finalAbort.resolve(); await ending; await tick();
  assert.equal(env.registry.records.size, 0); assert.equal(env.registry.pendingSourceBytes, 0);
  assert.deepEqual(env.calls, []);
});

import assert from "node:assert/strict";
import test from "node:test";
import { BrowserDownloads, downloadDeadline, validateDownloadURL } from "./browser-downloads.js";

const deferred = () => { let resolve, reject; const promise = new Promise((done, fail) => { resolve = done; reject = fail; }); return { promise, resolve, reject }; };
const tick = () => new Promise(resolve => setTimeout(resolve, 0));
const request = (extra = {}) => ({ session_id: "one", turn_id: "turn", control_epoch: 1, tabId: 7, url: "https://fixture.test/file", ...extra });
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

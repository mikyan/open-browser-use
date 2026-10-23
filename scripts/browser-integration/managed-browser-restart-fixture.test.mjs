import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import vm from "node:vm";
import { createHash, randomUUID } from "node:crypto";
import { createManagedBrowserRestartFixture, managedBrowserRestartURLs } from "./managed-browser-restart-fixture.mjs";

async function withServer(operation) {
  const fixture = createManagedBrowserRestartFixture();
  const server = http.createServer((request, response) => {
    if (!fixture.handle(request, response, server.address().port)) { response.writeHead(404); response.end("outside fixture"); }
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  try { return await operation({ fixture, port: server.address().port, base: `http://127.0.0.1:${server.address().port}` }); }
  finally { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
}
async function read(url, options) {
  const response = await fetch(url, { redirect: "manual", ...options });
  return { status: response.status, headers: response.headers, body: await response.text() };
}
const post = (url, value, headers = {}) => read(url, { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded", ...headers }, body: typeof value === "string" ? value : new URLSearchParams(value).toString() });
const originalFields = (record, kind) => ({ scenarioId: record.scenarioId, operationId: record.operations[kind], note: `原始${kind}报告：中文事实 <script> & 可核验` });
const followupFields = record => ({ scenarioId: record.scenarioId, operationId: record.operations.followup, receiptId: record.receipts.prg.receiptId, note: "重启后独立确认，仅提交一次" });
const decode = value => value.replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");
const receiptFrom = body => JSON.parse(decode(body.match(/<pre id="receipt-json">([\s\S]*?)<\/pre>/)[1]));
function assertBodyEvidence(entry) {
  assert.equal(Buffer.byteLength(entry.raw), entry.bytes);
  assert.equal(Buffer.from(entry.base64, "base64").toString("utf8"), entry.raw);
  assert.equal(createHash("sha256").update(entry.raw).digest("hex"), entry.sha256);
  assert.equal(entry.truncated, false);
}

test("native forms expose separate visible operations and never submit automatically", () => withServer(async ({ fixture, port }) => {
  const urls = managedBrowserRestartURLs(port, "forms");
  const work = await read(urls.work);
  assert.equal(work.status, 200);
  assert.match(work.body, /保存浏览器草稿/); assert.match(work.body, /暂存内存草稿/);
  assert.match(work.body, /aria-label="持久草稿状态"/); assert.match(work.body, /aria-label="内存草稿状态"/);
  const record = fixture.stats("forms");
  assert.equal(new Set(Object.values(record.operations)).size, 4);
  for (const [kind, url] of Object.entries(urls.prepare)) {
    const page = await read(url);
    assert.equal(page.status, 200); assert.match(page.body, /form method="post"/);
    assert.ok(page.body.includes(`action="/managed-restart/forms/original/${kind}"`));
    assert.ok(page.body.includes(record.operations[kind]));
    assert.match(page.body, /<label>场景编号<input/); assert.match(page.body, /<label>报告说明<textarea/);
    assert.doesNotMatch(page.body, /type="hidden"|fetch\(|XMLHttpRequest|\.submit\(/);
  }
  for (const script of work.body.matchAll(/<script>([\s\S]*?)<\/script>/g)) new vm.Script(script[1]);
  assert.doesNotMatch(work.body, /fetch\(|XMLHttpRequest|\.submit\(/);
  assert.deepEqual(fixture.stats("forms").originalPOST, []);
  assert.deepEqual(fixture.stats("forms").followupPOST, []);
}));

test("browser state script stores cookie/localStorage only on explicit click; a new document resets visible memory state", () => withServer(async ({ port }) => {
  const work = await read(managedBrowserRestartURLs(port, "drafts").work);
  const script = work.body.match(/<script>([\s\S]*?)<\/script>/)[1], values = new Map(), writes = []; let cookieValue = "";
  function document() {
    const elements = new Map(["persistent-draft", "persistent-status", "cookie-status", "memory-draft", "memory-status", "document-instance", "save-persistent", "save-memory"].map(id => [id, { value: "", textContent: id === "memory-status" ? "未暂存" : "", addEventListener(event, callback) { this[event] = callback; } }]));
    const dom = { getElementById: id => elements.get(id), get cookie() { return cookieValue; }, set cookie(value) { writes.push(["cookie", value]); cookieValue = value.split(";")[0]; } };
    vm.runInNewContext(script, { document: dom, crypto: { randomUUID }, localStorage: { getItem: key => values.get(key) ?? null, setItem(key, value) { writes.push(["localStorage", key, value]); values.set(key, value); } } });
    return elements;
  }
  const original = document(); assert.deepEqual(writes, []);
  original.get("persistent-draft").value = "持久中文 + &"; original.get("save-persistent").click();
  original.get("memory-draft").value = "仅原文档内存"; original.get("save-memory").click();
  assert.equal(original.get("persistent-status").textContent, "持久中文 + &");
  assert.equal(original.get("cookie-status").textContent, "持久中文 + &");
  assert.equal(original.get("memory-status").textContent, "仅原文档内存");
  assert.equal(writes.length, 2); assert.match(writes[1][1], /Path=\/managed-restart\/drafts; Max-Age=86400; SameSite=Strict$/);
  const replacement = document();
  assert.equal(replacement.get("persistent-draft").value, "持久中文 + &");
  assert.equal(replacement.get("cookie-status").textContent, "持久中文 + &");
  assert.equal(replacement.get("memory-status").textContent, "未暂存");
  assert.notEqual(replacement.get("document-instance").textContent, original.get("document-instance").textContent);
  assert.equal(writes.length, 2, "reading a replacement document must not save anything");
}));

test("three native POST branches issue distinct original receipts; GET reads do not repeat business", () => withServer(async ({ fixture, port }) => {
  const urls = managedBrowserRestartURLs(port, "branches"); await read(urls.work);
  const before = fixture.stats("branches"), ids = new Set();
  assert.equal((await read(urls.report)).status, 404);
  for (const kind of ["prg", "cache", "no-store"]) {
    const response = await post(urls.original[kind], originalFields(before, kind));
    assert.equal(response.status, kind === "prg" ? 303 : 200);
    assert.equal(response.headers.get("cache-control"), kind === "cache" ? "public, max-age=3600" : "no-store");
    if (kind === "cache") assert.equal(response.headers.get("content-location"), urls.original.cache);
    let report = response;
    if (kind === "prg") { assert.equal(response.headers.get("location"), "/managed-restart/branches/report"); report = await read(urls.report); }
    const receipt = receiptFrom(report.body); ids.add(receipt.receiptId);
    assert.equal(receipt.kind, kind); assert.equal(receipt.scenarioId, "branches");
    assert.equal(receipt.note, originalFields(before, kind).note);
    assert.deepEqual(receipt, fixture.stats("branches").receipts[kind]);
    assert.ok(report.body.includes("&lt;script&gt; &amp;"));
    assert.equal((await read(urls.original[kind])).status, 405);
  }
  for (let index = 0; index < 3; index++) assert.equal((await read(urls.report)).status, 200);
  const record = fixture.stats("branches");
  assert.equal(ids.size, 3); assert.equal(record.originalPOST.length, 3); assert.deepEqual(record.followupPOST, []);
  assert.deepEqual(record.originalPOST.map(entry => entry.status), [303, 200, 200]);
  record.originalPOST.forEach(assertBodyEvidence);
  assert.ok(record.requests.every((entry, index) => entry.sequence === index + 1 && Number.isSafeInteger(entry.at) && entry.status !== null));
}));

test("duplicate and concurrent original submissions are retained and refused without changing the first receipt", () => withServer(async ({ fixture, port }) => {
  const urls = managedBrowserRestartURLs(port, "duplicates"); await read(urls.work);
  const original = originalFields(fixture.stats("duplicates"), "prg");
  const responses = await Promise.all([post(urls.original.prg, original), post(urls.original.prg, original)]);
  assert.deepEqual(responses.map(value => value.status).sort(), [303, 409]);
  const first = fixture.stats("duplicates").receipts.prg;
  assert.equal((await post(urls.original.prg, original)).status, 409);
  const record = fixture.stats("duplicates");
  assert.equal(record.originalPOST.length, 3);
  assert.equal(record.originalPOST.filter(entry => entry.status === 303).length, 1);
  assert.deepEqual(record.receipts.prg, first);
  assert.equal(record.originalPOST.filter(entry => entry.receiptId).length, 1);
}));

for (const source of ["work", "report"]) test(`one independent followup from ${source} references the first receipt and creates a second receipt`, () => withServer(async ({ fixture, port }) => {
  const id = `followup-${source}`, urls = managedBrowserRestartURLs(port, id); await read(urls.work);
  await post(urls.original.prg, originalFields(fixture.stats(id), "prg"));
  const before = fixture.stats(id), fields = followupFields(before);
  const response = await post(urls.followup[source], fields);
  assert.equal(response.status, 303); assert.equal(response.headers.get("location"), `/managed-restart/${id}/followup-report`);
  const saved = receiptFrom((await read(urls.followupReport)).body);
  assert.equal(saved.originalReceiptId, before.receipts.prg.receiptId); assert.equal(saved.source, source);
  assert.notEqual(saved.receiptId, before.receipts.prg.receiptId);
  assert.equal((await post(urls.followup[source === "work" ? "report" : "work"], fields)).status, 409);
  for (const url of [urls.work, urls.report, urls.followupReport]) assert.equal((await read(url)).status, 200);
  const record = fixture.stats(id);
  assert.equal(record.originalPOST.length, 1); assert.equal(record.followupPOST.length, 2);
  assert.deepEqual(record.followupPOST.map(value => value.status), [303, 409]);
  assert.deepEqual(record.receipts.prg, before.receipts.prg); assert.deepEqual(record.receipts.followup, saved);
  record.followupPOST.forEach(assertBodyEvidence);
}));

test("foreign scenario/operation/receipt and premature followup attempts never produce receipts", () => withServer(async ({ fixture, port }) => {
  const urls = managedBrowserRestartURLs(port, "target"), foreign = managedBrowserRestartURLs(port, "foreign");
  await read(urls.work); await read(foreign.work);
  const targetRecord = fixture.stats("target"), foreignRecord = fixture.stats("foreign");
  assert.notEqual(targetRecord.nonce, foreignRecord.nonce);
  const malformed = [originalFields(foreignRecord, "prg"), { ...originalFields(targetRecord, "prg"), operationId: foreignRecord.operations.prg }, { ...originalFields(targetRecord, "prg"), scenarioId: "foreign" }];
  for (const fields of malformed) assert.equal((await post(urls.original.prg, fields)).status, 422);
  assert.equal((await post(urls.followup.work, { scenarioId: "target", operationId: targetRecord.operations.followup, receiptId: "absent", note: "premature" })).status, 422);
  await post(foreign.original.prg, originalFields(foreignRecord, "prg"));
  await post(urls.original.prg, originalFields(targetRecord, "prg"));
  const fields = followupFields(fixture.stats("target")); fields.receiptId = fixture.stats("foreign").receipts.prg.receiptId;
  assert.equal((await post(urls.followup.report, fields)).status, 422);
  assert.equal(fixture.stats("target").receipts.followup, null);
  assert.equal(fixture.stats("foreign").followupPOST.length, 0);
  assert.equal(fixture.stats("target").originalPOST.filter(value => value.status === 303).length, 1);
}));

test("bounded form parsing records invalid content, duplicate keys and actual oversized bytes", () => withServer(async ({ fixture, port }) => {
  const urls = managedBrowserRestartURLs(port, "invalid"); await read(urls.work);
  const fields = originalFields(fixture.stats("invalid"), "cache"), encoded = new URLSearchParams(fields).toString();
  for (const bad of [{ ...fields, note: " " }, { ...fields, extra: "unknown" }, { ...fields, note: "bad\0text" }, { ...fields, note: "x".repeat(1001) }, `${encoded}&scenarioId=invalid`]) assert.equal((await post(urls.original.cache, bad)).status, 422);
  assert.equal((await post(urls.original.cache, JSON.stringify(fields), { "Content-Type": "application/json" })).status, 415);
  const oversized = encoded + "&overflow=" + "x".repeat(16 * 1024);
  assert.equal((await post(urls.original.cache, oversized)).status, 413);
  const record = fixture.stats("invalid"), entry = record.originalPOST.at(-1);
  assert.equal(entry.bytes, Buffer.byteLength(oversized)); assert.equal(entry.truncated, true);
  assert.equal(Buffer.from(entry.base64, "base64").length, 16 * 1024);
  assert.equal(entry.sha256, createHash("sha256").update(oversized).digest("hex"));
  assert.equal(record.receipts.cache, null);
}));

test("unknown paths, methods and scenarios cannot create reports or hide cross-scenario attempts", () => withServer(async ({ fixture, port, base }) => {
  const urls = managedBrowserRestartURLs(port, "routes"); await read(urls.work);
  assert.equal((await read(`${base}/unrelated`)).status, 404);
  assert.equal((await read(`${urls.work}?unexpected=yes`)).status, 404);
  assert.equal((await read(`${base}/managed-restart/routes/unknown`)).status, 404);
  assert.equal((await read(urls.work, { method: "PUT", body: "unused" })).status, 405);
  assert.equal((await post(`${base}/managed-restart/missing/original/prg`, "note=unused")).status, 404);
  assert.equal((await read(`${base}/managed-restart/bad%20id/work`)).status, 404);
  assert.equal(fixture.stats("missing"), null); assert.equal(fixture.allStats().length, 1);
  assert.equal(fixture.rejectedStats().requests.length, 3);
  assert.deepEqual(fixture.stats("routes").originalPOST, []);
  const clone = fixture.stats("routes"); clone.receipts.prg = { forged: true };
  assert.equal(fixture.stats("routes").receipts.prg, null);
  assert.throws(() => managedBrowserRestartURLs(0, "x"), /Invalid fixture/);
  assert.throws(() => managedBrowserRestartURLs(port, "bad/id"), /Invalid fixture/);
}));

test("the actual scenario cookie header is retained while unrelated cookies are excluded", () => withServer(async ({ fixture, port }) => {
  const urls = managedBrowserRestartURLs(port, "cookie");
  await read(urls.work, { headers: { Cookie: "unrelated=omit; obu_restart_cookie=%E4%B8%AD%E6%96%87" } });
  assert.equal(fixture.stats("cookie").requests[0].cookie, "obu_restart_cookie=%E4%B8%AD%E6%96%87");
  assert.equal(fixture.stats("cookie").requests[0].method, "GET");
}));

test("request evidence capacity fails explicitly and never overwrites early requests", () => withServer(async ({ fixture, port }) => {
  const urls = managedBrowserRestartURLs(port, "capacity"); await read(urls.work);
  for (let index = 0; index < 511; index++) assert.equal((await read(urls.report)).status, 404);
  const first = fixture.stats("capacity").requests[0];
  assert.equal((await read(urls.work)).status, 503);
  const record = fixture.stats("capacity"); assert.equal(record.requests.length, 512); assert.equal(record.overflow, true);
  assert.deepEqual(record.requests[0], first);
}));

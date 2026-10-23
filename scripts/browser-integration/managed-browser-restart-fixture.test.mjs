import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import vm from "node:vm";
import { createHash, randomUUID } from "node:crypto";
import { createManagedBrowserRestartFixture, managedBrowserRestartURLs } from "./managed-browser-restart-fixture.mjs";

async function withServer(operation, options = {}) {
  const fixture = createManagedBrowserRestartFixture(options);
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
const authFrom = body => JSON.parse(decode(body.match(/<pre id="server-auth-json">([\s\S]*?)<\/pre>/)[1]));
const sha256 = value => createHash("sha256").update(value).digest("hex");
async function loginForm(fixture, port, id) {
  const urls = managedBrowserRestartURLs(port, id, { authenticated: true }), page = await read(urls.auth.login), record = fixture.stats(id);
  assert.equal(page.status, 200);
  const credential = page.body.match(/<code id="synthetic-login-token">([^<]+)<\/code>/)[1];
  return { urls, page, fields: { scenarioId: id, operationId: record.auth.loginOperationId, credential } };
}
async function login(fixture, port, id) {
  const form = await loginForm(fixture, port, id), response = await post(form.urls.auth.login, form.fields);
  assert.equal(response.status, 303);
  const header = response.headers.get("set-cookie"), cookie = header.split(";")[0];
  return { ...form, response, header, cookie, headers: { Cookie: cookie } };
}
function assertAuthEvidence(page, record, method, path) {
  const proof = authFrom(page.body), entry = record.requests.find(value => value.sequence === proof.requestSequence), receipt = record.auth.receipt;
  assert.deepEqual(proof, { authenticated: true, scenarioId: record.scenarioId, loginId: receipt.loginId, principal: receipt.principal,
    loginRequestSequence: receipt.loginRequestSequence, requestSequence: entry.sequence, requestMethod: method, requestPath: path, cookieSHA256: receipt.cookieSHA256 });
  assert.equal(entry.method, method); assert.equal(entry.path, path); assert.equal(entry.status, 200);
  assert.equal(entry.authentication.accepted, true); assert.equal(entry.authentication.cookieSHA256, receipt.cookieSHA256);
  assert.deepEqual(record.auth.requests.find(value => value.sequence === entry.sequence), entry);
  assert.ok(Number.isSafeInteger(entry.responseFinishedAt) && entry.responseFinishedAt >= entry.at);
  assert.equal(page.headers.get("set-cookie"), null, "protected responses must not repair or refresh login");
  return proof;
}
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

test("authentication is opt-in and leaves the existing URL and evidence schema unchanged", () => withServer(async ({ fixture, port, base }) => {
  const urls = managedBrowserRestartURLs(port, "ordinary"); await read(urls.work);
  assert.equal(Object.hasOwn(urls, "auth"), false);
  assert.equal((await read(`${base}/managed-restart/ordinary/auth/login`)).status, 404);
  const record = fixture.stats("ordinary");
  assert.equal(Object.hasOwn(record, "auth"), false);
  assert.equal(Object.hasOwn(record.urls, "auth"), false);
  assert.ok(record.requests.every(entry => !Object.hasOwn(entry, "authentication") && !Object.hasOwn(entry, "responseFinishedAt")));
  assert.throws(() => createManagedBrowserRestartFixture({ authenticated: "true" }), /authenticated must be a boolean/);
  assert.throws(() => managedBrowserRestartURLs(port, "ordinary", { authenticated: 1 }), /Invalid fixture/);
}));

test("all authenticated business routes reject absent login and retain refused POST bodies without creating receipts", () => withServer(async ({ fixture, port }) => {
  const { urls } = await loginForm(fixture, port, "protected"), before = fixture.stats("protected");
  for (const url of [urls.auth.check, urls.work, urls.report, urls.followupReport, ...Object.values(urls.prepare), ...Object.values(urls.original), ...Object.values(urls.followup)]) {
    const response = await read(url);
    assert.equal(response.status, 401); assert.equal(response.headers.get("set-cookie"), null);
    assert.doesNotMatch(response.body, /id="server-auth-json"|id="receipt-json"/);
  }
  for (const kind of ["prg", "cache", "no-store"]) {
    const response = await post(urls.original[kind], originalFields(before, kind), { Cookie: "obu_restart_protected=client-draft" });
    assert.equal(response.status, 401); assert.equal(response.headers.get("set-cookie"), null);
  }
  const followup = { scenarioId: before.scenarioId, operationId: before.operations.followup, receiptId: "missing", note: "not authorized" };
  for (const url of Object.values(urls.followup)) assert.equal((await post(url, followup)).status, 401);
  const record = fixture.stats("protected");
  assert.equal(record.auth.receipt, null); assert.deepEqual(record.auth.loginPOST, []);
  assert.deepEqual(record.receipts, { prg: null, cache: null, "no-store": null, followup: null });
  assert.deepEqual(record.auth.refusals, record.auth.requests);
  assert.ok(record.auth.requests.every(entry => entry.status === 401 && entry.authentication.reason === "missing-cookie" && entry.authentication.cookieSHA256 === null));
  for (const entry of [...record.originalPOST, ...record.followupPOST]) {
    assertBodyEvidence(entry); assert.equal(entry.status, 401); assert.equal(entry.authentication.accepted, false);
    assert.ok(Number.isSafeInteger(entry.responseFinishedAt));
  }
}, { authenticated: true }));

test("real login POST issues one scoped persistent HttpOnly cookie and authenticated GETs prove the exact server request", () => withServer(async ({ fixture, port }) => {
  const session = await login(fixture, port, "login-proof"), { urls, page, response, header, cookie, headers, fields } = session;
  assert.match(page.body, /<label>合成登录口令<input name="credential" value=""/);
  assert.match(page.body, /<button type="submit">建立合成登录<\/button>/);
  assert.doesNotMatch(page.body, /type="hidden"|fetch\(|XMLHttpRequest|\.submit\(/);
  assert.equal(response.headers.get("location"), "/managed-restart/login-proof/auth/check");
  const record = fixture.stats("login-proof"), receipt = record.auth.receipt, issued = record.auth.loginPOST[0], value = cookie.slice(cookie.indexOf("=") + 1);
  assert.match(value, /^[a-f0-9]{64}$/); assert.notEqual(value, fields.credential);
  assert.equal(header, `${cookie}; Path=/managed-restart/login-proof/; Max-Age=86400; HttpOnly; SameSite=Strict`);
  assert.equal(record.auth.cookieSHA256, sha256(cookie));
  assert.deepEqual(receipt.cookie, { name: "obu_restart_auth_login-proof", path: "/managed-restart/login-proof/", maxAge: 86400, httpOnly: true, sameSite: "Strict" });
  assert.deepEqual(issued.setCookie, { ...receipt.cookie, cookieSHA256: sha256(cookie), valueSHA256: sha256(value), headerSHA256: sha256(header) });
  assert.equal(issued.loginId, receipt.loginId); assert.equal(issued.status, 303); assert.equal(issued.sequence, receipt.loginRequestSequence);
  assert.ok(Number.isFinite(Date.parse(receipt.issuedAt))); assertBodyEvidence(issued);
  assert.equal(issued.responseFinishedAt, record.requests.find(entry => entry.sequence === issued.sequence).responseFinishedAt);
  assert.ok(issued.responseFinishedAt >= issued.at);
  assert.equal(JSON.stringify(record).includes(value), false, "raw bearer cookie must not enter stored server evidence");
  const proofSequences = new Set();
  for (const url of [urls.auth.check, urls.work, urls.work, ...Object.values(urls.prepare)]) {
    const result = await read(url, { headers }); assert.equal(result.status, 200);
    const proof = assertAuthEvidence(result, fixture.stats("login-proof"), "GET", new URL(url).pathname);
    proofSequences.add(proof.requestSequence); assert.equal(result.body.includes(value), false);
  }
  assert.equal(proofSequences.size, 6);
  const after = fixture.stats("login-proof");
  assert.deepEqual(after.auth.receipt, receipt); assert.deepEqual(after.originalPOST, []); assert.deepEqual(after.followupPOST, []);
  assert.equal(after.auth.loginPOST.length, 1); assert.deepEqual(after.auth.refusals, []);
}, { authenticated: true }));

test("authenticated original reports and one followup preserve the business ledger separately from login", () => withServer(async ({ fixture, port }) => {
  const { urls, headers } = await login(fixture, port, "auth-business"), before = fixture.stats("auth-business"), receipts = {};
  for (const kind of ["prg", "cache", "no-store"]) {
    const response = await post(urls.original[kind], originalFields(before, kind), headers);
    assert.equal(response.status, kind === "prg" ? 303 : 200); assert.equal(response.headers.get("set-cookie"), null);
    assert.equal(response.headers.get("cache-control"), kind === "cache" ? "private, max-age=3600" : "no-store");
    const saved = kind === "prg" ? await read(urls.report, { headers }) : response;
    assertAuthEvidence(saved, fixture.stats("auth-business"), kind === "prg" ? "GET" : "POST", new URL(kind === "prg" ? urls.report : urls.original[kind]).pathname);
    receipts[kind] = receiptFrom(saved.body);
    assert.deepEqual(receipts[kind], fixture.stats("auth-business").receipts[kind]);
    assert.equal((await read(urls.original[kind], { headers })).status, 405);
  }
  for (let index = 0; index < 2; index++) {
    const report = await read(urls.report, { headers }); assert.deepEqual(receiptFrom(report.body), receipts.prg);
    assertAuthEvidence(report, fixture.stats("auth-business"), "GET", new URL(urls.report).pathname);
  }
  const followup = await post(urls.followup.report, followupFields(fixture.stats("auth-business")), headers);
  assert.equal(followup.status, 303); assert.equal(followup.headers.get("set-cookie"), null);
  const followupReport = await read(urls.followupReport, { headers });
  assertAuthEvidence(followupReport, fixture.stats("auth-business"), "GET", new URL(urls.followupReport).pathname);
  assert.equal(receiptFrom(followupReport.body).originalReceiptId, receipts.prg.receiptId);
  const after = fixture.stats("auth-business"), allPosts = after.requests.filter(entry => entry.method === "POST");
  assert.equal(allPosts.length, 5); assert.equal(after.auth.loginPOST.length, 1); assert.equal(after.originalPOST.length, 3); assert.equal(after.followupPOST.length, 1);
  assert.deepEqual(new Set(allPosts.map(entry => entry.sequence)), new Set([...after.auth.loginPOST, ...after.originalPOST, ...after.followupPOST].map(entry => entry.sequence)));
  for (const entry of [...after.originalPOST, ...after.followupPOST]) {
    assertBodyEvidence(entry); assert.equal(entry.authentication.cookieSHA256, before.auth.cookieSHA256); assert.equal(entry.authentication.loginId, before.auth.receipt.loginId);
  }
  assert.deepEqual(after.auth.receipt, before.auth.receipt); assert.deepEqual(after.auth.refusals, []);
}, { authenticated: true }));

test("cross-scenario, forged and duplicate authentication cookies fail closed; a separate draft cookie is only observed", () => withServer(async ({ fixture, port }) => {
  const a = await login(fixture, port, "auth-a"), b = await login(fixture, port, "auth-b"), original = fixture.stats("auth-b"), name = original.auth.cookieName;
  const invalidCookies = [a.cookie, `${name}=${a.cookie.split("=")[1]}`, `${name}=wrong`, `${b.cookie}; ${b.cookie}`, `${b.cookie}; ${name}=wrong`, `${name}=wrong; ${b.cookie}`];
  for (const cookie of invalidCookies) {
    const page = await read(b.urls.work, { headers: { Cookie: cookie } });
    assert.equal(page.status, 401); assert.equal(page.headers.get("set-cookie"), null); assert.doesNotMatch(page.body, /server-auth-json/);
  }
  assert.deepEqual(fixture.stats("auth-b").auth.refusals.map(entry => entry.authentication.reason), ["missing-cookie", "invalid-cookie", "invalid-cookie", "ambiguous-cookie", "ambiguous-cookie", "ambiguous-cookie"]);
  const draft = "obu_restart_auth-b=%E6%96%B0%E8%8D%89%E7%A8%BF", response = await read(b.urls.work, { headers: { Cookie: `${b.cookie}; ${draft}` } });
  assertAuthEvidence(response, fixture.stats("auth-b"), "GET", new URL(b.urls.work).pathname);
  const record = fixture.stats("auth-b"); assert.equal(record.requests.at(-1).cookie, draft); assert.deepEqual(record.auth.receipt, original.auth.receipt);
  const script = response.body.match(/<script>([\s\S]*?)<\/script>/)[1];
  assert.ok(script.includes('cookieName="obu_restart_auth-b"')); assert.equal(script.includes(name), false);
  const failed = await post(b.urls.original.prg, originalFields(original, "prg"), { Cookie: a.cookie });
  assert.equal(failed.status, 401); assert.equal(fixture.stats("auth-b").receipts.prg, null);
  assert.equal((await post(b.urls.original.prg, originalFields(original, "prg"), b.headers)).status, 303, "refused auth must not consume the original operation");
  assert.deepEqual(fixture.stats("auth-b").auth.receipt, original.auth.receipt);
}, { authenticated: true }));

test("concurrent and repeated login cannot create a second session or repair a missing cookie", () => withServer(async ({ fixture, port }) => {
  const form = await loginForm(fixture, port, "one-login");
  const responses = await Promise.all([post(form.urls.auth.login, form.fields), post(form.urls.auth.login, form.fields)]);
  assert.deepEqual(responses.map(response => response.status).sort(), [303, 409]);
  assert.equal(responses.filter(response => response.headers.has("set-cookie")).length, 1);
  const original = fixture.stats("one-login").auth.receipt;
  const repeat = await post(form.urls.auth.login, form.fields); assert.equal(repeat.status, 409); assert.equal(repeat.headers.get("set-cookie"), null);
  assert.equal((await read(form.urls.auth.check)).status, 401, "a repeated login did not repair the client cookie");
  const record = fixture.stats("one-login"); assert.deepEqual(record.auth.receipt, original);
  assert.equal(record.auth.loginPOST.length, 3); assert.equal(record.auth.loginPOST.filter(entry => entry.setCookie).length, 1);
  record.auth.loginPOST.forEach(assertBodyEvidence);
  assert.deepEqual(record.originalPOST, []); assert.deepEqual(record.followupPOST, []);
}, { authenticated: true }));

test("malformed or foreign login fields never issue cookies and keep complete bounded body evidence", () => withServer(async ({ fixture, port }) => {
  const a = await loginForm(fixture, port, "login-input"), b = await loginForm(fixture, port, "login-foreign"), encoded = new URLSearchParams(a.fields).toString();
  for (const [fields, status] of [[{ ...a.fields, credential: b.fields.credential }, 401], [{ ...a.fields, operationId: b.fields.operationId }, 422], [{ ...a.fields, scenarioId: "login-foreign" }, 422], [{ ...a.fields, extra: "unknown" }, 422], [`${encoded}&credential=duplicate`, 422]]) {
    const response = await post(a.urls.auth.login, fields); assert.equal(response.status, status); assert.equal(response.headers.get("set-cookie"), null);
  }
  assert.equal((await post(a.urls.auth.login, JSON.stringify(a.fields), { "Content-Type": "application/json" })).status, 415);
  const oversized = encoded + "&overflow=" + "x".repeat(16 * 1024);
  assert.equal((await post(a.urls.auth.login, oversized)).status, 413);
  const record = fixture.stats("login-input"), large = record.auth.loginPOST.at(-1);
  assert.equal(record.auth.receipt, null); assert.equal(record.auth.cookieSHA256, null);
  record.auth.loginPOST.slice(0, -1).forEach(assertBodyEvidence);
  assert.equal(large.bytes, Buffer.byteLength(oversized)); assert.equal(large.sha256, sha256(oversized)); assert.equal(large.truncated, true);
  assert.equal(Buffer.from(large.base64, "base64").length, 16 * 1024);
  assert.ok(record.auth.loginPOST.every(entry => !entry.setCookie && Number.isSafeInteger(entry.responseFinishedAt)));
  assert.deepEqual(fixture.stats("login-foreign").auth.loginPOST, []);
}, { authenticated: true }));

test("changed observes all finish timestamps even when the final response has no subsequent request", async () => {
  let activeFixture, lastSnapshot;
  await withServer(async ({ fixture, port }) => {
    activeFixture = fixture;
    const session = await login(fixture, port, "finish");
    assert.deepEqual(lastSnapshot, fixture.stats("finish"));
    const loginPost = lastSnapshot.auth.loginPOST[0];
    assert.ok(Number.isSafeInteger(loginPost.responseFinishedAt));
    assert.equal(loginPost.responseFinishedAt, lastSnapshot.requests.at(-1).responseFinishedAt);
    const page = await read(session.urls.auth.check, { headers: session.headers }); assert.equal(page.status, 200);
    assert.deepEqual(lastSnapshot, fixture.stats("finish"));
    assert.ok(Number.isSafeInteger(lastSnapshot.requests.at(-1).responseFinishedAt));
    assert.deepEqual(lastSnapshot.auth.requests.at(-1), lastSnapshot.requests.at(-1));
    await post(session.urls.original.prg, originalFields(lastSnapshot, "prg"), session.headers);
    assert.deepEqual(lastSnapshot, fixture.stats("finish"));
    assert.equal(lastSnapshot.originalPOST[0].responseFinishedAt, lastSnapshot.requests.at(-1).responseFinishedAt);
  }, { authenticated: true, changed() { lastSnapshot = activeFixture.stats("finish"); } });
});

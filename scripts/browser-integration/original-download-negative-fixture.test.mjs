import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createServer, request as httpRequest } from "node:http";
import { Script, createContext } from "node:vm";
import test from "node:test";
import { createOriginalDownloadNegativeFixtures } from "./original-download-negative-fixture.mjs";
import { listenFixture } from "./fixture-listener.mjs";

const hash = bytes => createHash("sha256").update(bytes).digest("hex");
const bodyFor = (item, extra = {}) => new URLSearchParams({ key: item.key, nonce: item.nonce, documentToken: "test-document", trusted: "true", buttonCount: "1", ...extra }).toString();
const post = body => ({ method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body });

async function serve(t) {
  const fixture = createOriginalDownloadNegativeFixtures();
  const server = createServer((req, res) => { if (!fixture.handle(req, res)) { res.writeHead(404); res.end("outside fixture"); } });
  await listenFixture(server);
  t.after(async () => { fixture.close(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
  return { fixture, base: `http://127.0.0.1:${server.address().port}` };
}

// Use the actual HTTP stream, not a mocked response object: end and abort are
// independently observed by the receiver before comparing the server ledger.
async function stream(base, item, t) {
  const body = bodyFor(item);
  return new Promise((resolve, reject) => {
    const request = httpRequest(base + item.reportPath, { ...post(body), headers: { ...post(body).headers, "Content-Length": Buffer.byteLength(body) }, agent: false });
    request.once("error", reject); t.after(() => request.destroy());
    request.once("response", response => {
      const result = { response, chunks: [], ended: false, aborted: false, errors: [] }; let prefixReady;
      result.prefix = new Promise(resolve => { prefixReady = resolve; });
      result.done = new Promise(resolve => { response.once("close", () => resolve(result)); });
      response.on("data", chunk => { result.chunks.push(chunk); if (Buffer.concat(result.chunks).length >= item.prefixBytes) prefixReady(); });
      response.once("end", () => { result.ended = true; });
      response.once("aborted", () => { result.aborted = true; });
      response.on("error", error => { result.errors.push(String(error)); });
      resolve(result);
    });
    request.end(body);
  });
}

async function until(check) {
  const deadline = performance.now() + 2000;
  while (!check()) { assert.ok(performance.now() < deadline, "HTTP ledger event did not settle"); await new Promise(resolve => setTimeout(resolve, 5)); }
}

function servedPage(html) {
  const inputs = new Map(), state = { textContent: "" }, button = {};
  const form = { append: input => inputs.set(input.name, input), elements: { namedItem: name => inputs.get(name) } };
  const document = { querySelector: selector => ({ "#report": form, "#download": button, "#state": state })[selector], createElement: () => ({}) };
  button.addEventListener = (name, callback) => { assert.equal(name, "click"); button.click = callback; };
  const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)]; assert.equal(scripts.length, 1);
  new Script(scripts[0][1]).runInContext(createContext({ document, crypto: { randomUUID: () => "test-document" } }));
  return { click: trusted => button.click({ isTrusted: trusted }), state: () => JSON.parse(state.textContent),
    body: () => new URLSearchParams([...inputs].map(([name, value]) => [name, value.value])).toString() };
}

test("concurrent owners use one POST URL and filename but retain distinct original full bytes", { timeout: 10000 }, async t => {
  const { fixture, base } = await serve(t), cases = ["owned", "unowned"].map(owner => fixture.createCase({ key: owner, owner, kind: "complete" }));
  assert.equal(cases[0].reportPath, "/original-negative/report"); assert.equal(cases[0].reportPath, cases[1].reportPath);
  assert.notEqual(cases[0].nonce, cases[1].nonce); assert.notEqual(cases[0].expected.sha256, cases[1].expected.sha256);
  await Promise.all(cases.map(async item => {
    const html = await (await fetch(base + item.urlPath)).text();
    assert.equal(html.includes(item.expected.base64), false); assert.match(html, /action="\/original-negative\/report" method="post"/);
    assert.doesNotMatch(html, /fetch\(|downloadURL|chrome\.downloads|preventDefault/);
    const page = servedPage(html); page.click(item.owner === "owned");
    const state = page.state(); assert.equal(state.expectedSHA, item.expected.sha256); assert.equal(state.clicks[0].trusted, item.owner === "owned");
    const body = page.body(), response = await fetch(base + item.reportPath, post(body)), bytes = Buffer.from(await response.arrayBuffer());
    assert.equal(response.status, 200); assert.equal(response.headers.get("content-disposition"), 'attachment; filename="report.bin"');
    assert.equal(bytes.length, 16384); assert.deepEqual(bytes, Buffer.from(item.expected.base64, "base64")); assert.equal(hash(bytes), item.expected.sha256);
    assert.ok(bytes.includes(Buffer.from(item.nonce))); assert.ok(bytes.includes(Buffer.from("原始报表 UTF-8"))); assert.ok(bytes.includes(0)); assert.ok(bytes.includes(255));
    const stats = fixture.stats(item.key), hit = stats.requests.find(hit => hit.method === "POST");
    assert.equal(hit.body.base64, Buffer.from(body).toString("base64")); assert.equal(hit.fields.trusted, String(item.owner === "owned"));
    assert.equal(hit.fields.documentToken, state.documentToken); assert.equal(hit.once, true); assert.equal(hit.finished, true); assert.equal(hit.endCalled, true);
    assert.deepEqual(Buffer.from(stats.gets[0].base64, "base64"), Buffer.from(html));
    page.click(false); assert.equal(page.state().clicks[1].buttonCount, 2); assert.equal(page.state().clicks[1].trusted, false);
  }));
  assert.equal(fixture.allStats().requests.filter(hit => hit.method === "POST").length, 2);
});

test("held response sends a real prefix and release completes only that original one-time POST", { timeout: 10000 }, async t => {
  const { fixture, base } = await serve(t), item = fixture.createCase({ owner: "held", kind: "held" });
  assert.throws(() => fixture.release(item.key), /No active/);
  const transfer = await stream(base, item, t); await transfer.prefix;
  await until(() => fixture.stats(item.key).requests[0].prefixFlushed);
  assert.equal(transfer.ended, false); assert.equal(Buffer.concat(transfer.chunks).length, 4096);
  const before = fixture.stats(item.key).requests[0]; assert.equal(before.queuedBytes, 4096); assert.equal(before.endCalled, false); assert.equal(before.finished, false);
  const duplicate = await fetch(base + item.reportPath, post(bodyFor(item, { buttonCount: "2" })));
  assert.equal(duplicate.status, 409); assert.match(await duplicate.text(), /ALREADY_USED/);
  assert.equal(fixture.release(item.key), true); await transfer.done;
  assert.equal(transfer.ended, true); assert.equal(transfer.aborted, false);
  assert.deepEqual(Buffer.concat(transfer.chunks), Buffer.from(item.expected.base64, "base64"));
  await until(() => fixture.stats(item.key).requests[0].closed);
  const hit = fixture.stats(item.key).requests[0]; assert.equal(hit.released, true); assert.equal(hit.finished, true); assert.equal(hit.aborted, false);
  assert.equal(hit.queuedBytes, 16384); assert.equal(fixture.stats(item.key).requests.length, 2);
  assert.throws(() => fixture.release(item.key), /No active/);
});

test("interrupt destroys the original in-flight socket after prefix without HTML or a replacement GET", { timeout: 10000 }, async t => {
  const { fixture, base } = await serve(t), item = fixture.createCase({ owner: "interrupted", kind: "interrupted" });
  const transfer = await stream(base, item, t); await transfer.prefix;
  await until(() => fixture.stats(item.key).requests[0].prefixFlushed);
  assert.equal(transfer.response.statusCode, 200); assert.equal(transfer.response.headers["content-type"], "application/octet-stream");
  assert.equal(transfer.response.headers["content-length"], "16384");
  assert.equal(fixture.interrupt(item.key), true); await transfer.done;
  assert.equal(transfer.ended, false); assert.equal(transfer.aborted, true); assert.ok(transfer.errors.length > 0);
  assert.deepEqual(Buffer.concat(transfer.chunks), Buffer.from(item.expected.base64, "base64").subarray(0, 4096));
  await until(() => fixture.stats(item.key).requests[0].closed);
  const hit = fixture.stats(item.key).requests[0];
  assert.equal(hit.socketDestroyed, true); assert.equal(hit.aborted, true); assert.equal(hit.endCalled, false); assert.equal(hit.finished, false); assert.equal(hit.queuedBytes, 4096);
  assert.equal(fixture.allStats().requests.length, 1); assert.throws(() => fixture.interrupt(item.key), /No active/);
  const retry = await fetch(base + item.reportPath, post(bodyFor(item))); assert.equal(retry.status, 409); await retry.text();
  const substitute = await fetch(base + item.reportPath, { headers: { Range: "bytes=4096-" } }); assert.equal(substitute.status, 405); await substitute.text();
  assert.equal(fixture.allStats().requests[2].range, "bytes=4096-");
  assert.equal(fixture.allStats().requests[2].error, "ORIGINAL_REPORT_REQUIRES_POST");
});

test("invalid fields, nonce, URL tokens and oversized bodies cannot consume an original response", { timeout: 10000 }, async t => {
  const { fixture, base } = await serve(t), item = fixture.createCase({ owner: "validation", kind: "complete" });
  for (const [suffix, body, status] of [
    ["", bodyFor(item, { nonce: "wrong" }), 403], ["", bodyFor(item) + "&nonce=" + item.nonce, 400],
    ["?key=" + item.key, bodyFor(item), 400], ["", bodyFor(item, { trusted: "synthetic" }), 400],
    ["", bodyFor(item, { buttonCount: "0" }), 400], ["", "x".repeat(65537), 413]
  ]) {
    const response = await fetch(base + item.reportPath + suffix, post(body)); assert.equal(response.status, status); await response.text();
    assert.equal(fixture.stats(item.key).consumed, false);
  }
  const oversized = fixture.allStats().requests.at(-1); assert.equal(oversized.receivedBytes, 65537); assert.equal(oversized.body.bytes, 65536); assert.equal(oversized.body.truncated, true);
  const response = await fetch(base + item.reportPath, post(bodyFor(item, { trusted: "false" }))); assert.equal(response.status, 200); await response.arrayBuffer();
  const snapshot = fixture.stats(item.key); snapshot.requests.length = 0; snapshot.expected.base64 = "changed";
  assert.ok(fixture.stats(item.key).requests.length > 0); assert.notEqual(fixture.stats(item.key).expected.base64, "changed");
});

test("client abort remains recorded and does not make its one-time transfer reusable", { timeout: 10000 }, async t => {
  const { fixture, base } = await serve(t), item = fixture.createCase({ owner: "client-abort", kind: "held" });
  const transfer = await stream(base, item, t); await transfer.prefix; transfer.response.destroy(); await transfer.done;
  await until(() => fixture.stats(item.key).requests[0].closed);
  const hit = fixture.stats(item.key).requests[0]; assert.equal(hit.aborted, true); assert.equal(hit.finished, false); assert.equal(hit.interrupted, undefined);
  assert.throws(() => fixture.release(item.key), /No active/);
  const retry = await fetch(base + item.reportPath, post(bodyFor(item))); assert.equal(retry.status, 409); await retry.text();
});

test("an aborted partial POST retains its actual body and does not spend a nonce before validation", { timeout: 10000 }, async t => {
  const { fixture, base } = await serve(t), item = fixture.createCase({ owner: "upload-abort", kind: "complete" });
  const partial = "key=" + item.key;
  const request = httpRequest(base + item.reportPath, { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded", "Content-Length": 1000 }, agent: false });
  const errors = []; request.on("error", error => errors.push(String(error))); t.after(() => request.destroy());
  const closed = new Promise(resolve => request.once("close", resolve));
  request.write(partial); await until(() => fixture.allStats().requests[0]?.receivedBytes === partial.length);
  request.destroy(); await closed; await until(() => fixture.allStats().requests[0].requestAborted);
  const hit = fixture.allStats().requests[0];
  assert.equal(hit.requestEnded, false); assert.equal(hit.once, false); assert.equal(hit.error, "REQUEST_ABORTED");
  assert.equal(hit.body.base64, Buffer.from(partial).toString("base64")); assert.equal(hit.receivedBytes, partial.length); assert.ok(errors.length > 0);
  assert.equal(fixture.stats(item.key).consumed, false);
  const valid = await fetch(base + item.reportPath, post(bodyFor(item))); assert.equal(valid.status, 200); await valid.arrayBuffer();
});

test("close aborts only this fixture's held responses and preserves shutdown evidence", { timeout: 10000 }, async t => {
  const { fixture, base } = await serve(t), cases = ["held", "interrupted"].map(kind => fixture.createCase({ owner: kind, kind }));
  const transfers = await Promise.all(cases.map(item => stream(base, item, t))); await Promise.all(transfers.map(item => item.prefix));
  assert.deepEqual(fixture.close().sort(), cases.map(item => item.key).sort());
  await Promise.all(transfers.map(item => item.done)); await until(() => cases.every(item => fixture.stats(item.key).requests[0].closed));
  for (const item of cases) { const hit = fixture.stats(item.key).requests[0]; assert.equal(hit.closedByFixture, true); assert.equal(hit.aborted, true); assert.equal(hit.finished, false); }
  assert.deepEqual(fixture.close(), []); assert.equal(fixture.allStats().controls.length, 2); assert.equal(fixture.allStats().closed, true);
  const outside = await fetch(base + "/outside"); assert.equal(outside.status, 404); await outside.text();
  const stopped = await fetch(base + cases[0].urlPath); assert.equal(stopped.status, 503); await stopped.text();
  assert.throws(() => fixture.createCase({ owner: "late", kind: "complete" }), /closed/);
});

test("fixture configuration and unknown routes fail explicitly without claiming other fixture paths", { timeout: 10000 }, async t => {
  const { fixture, base } = await serve(t);
  for (const options of [{ owner: "ok", kind: "blob" }, { owner: "", kind: "complete" }, { key: "a?b", owner: "ok", kind: "held" }]) assert.throws(() => fixture.createCase(options));
  fixture.createCase({ key: "unique", owner: "ok", kind: "complete" });
  assert.throws(() => fixture.createCase({ key: "unique", owner: "ok", kind: "complete" }), /Duplicate/);
  assert.throws(() => fixture.stats("missing"), /Unknown/);
  const unrelated = await fetch(base + "/original-download/page?key=unique"); assert.equal(unrelated.status, 404); await unrelated.text();
  assert.equal(fixture.allStats().requests.length, 0);
  const missing = await fetch(base + "/original-negative/page?key=missing"); assert.equal(missing.status, 404); await missing.text();
  assert.equal(fixture.allStats().requests.length, 1);
});

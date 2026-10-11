import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import vm from "node:vm";
import { createResearchWorkflowFixture, researchWorkflowTask, checkResearchReceipt } from "./research-workflow-fixture.mjs";

async function withServer(operation) {
  const fixture = createResearchWorkflowFixture();
  const server = http.createServer((request, response) => {
    if (!fixture.handle(request, response, server.address().port)) { response.writeHead(404); response.end(); }
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  try { return await operation({ fixture, base: `http://127.0.0.1:${server.address().port}` }); }
  finally { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
}

const post = async (url, payload) => {
  const response = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: typeof payload === "string" ? payload : JSON.stringify(payload) });
  return { status: response.status, body: await response.json() };
};
const decode = value => value.replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");
const bodyFields = body => Object.fromEntries([...body.matchAll(/<dd data-field="([^"]+)">([^<]*)<\/dd>/g)].map(match => [match[1], decode(match[2])]));

// Synthetic unit-test payloads are not browser acceptance: isTrusted cannot be
// authenticated by an HTTP server. The headed caller/observer supplies that evidence.
function payloadFor(record) {
  return { nonce: record.nonce, rows: structuredClone(record.oracle.rows), selection: record.oracle.selection,
    summary: "已核对三家当前报价与交付保修条款，依据全部要求和准确总价完成本次模拟采购评审。",
    events: [{ type: "click", trusted: true, id: "save-report", at: Date.now() }, { type: "submit", trusted: true, id: "report-form", at: Date.now() }] };
}
async function readAllSources(record) {
  for (const row of record.oracle.rows) for (const field of ["quoteURL", "termsURL"]) assert.equal((await fetch(row[field])).status, 200);
}

test("three layouts show raw dynamic sources, visible task and script syntax, never a client-side answer oracle", () => withServer(async ({ fixture, base }) => {
  const seenRevisions = new Set(), fingerprints = new Set();
  for (const variant of [1, 2, 3]) {
    const key = `layout-${variant}`, body = await (await fetch(`${base}/research-task/${key}?variant=${variant}`)).text();
    assert.ok(body.includes(researchWorkflowTask()));
    assert.deepEqual(bodyFields(body), { quantity: "12", budget: "9000", deadline: "2026-11-20", pdWatts: "90", ethernetMbps: "1000", warrantyMonths: "24" });
    const record = fixture.stats(key); fingerprints.add(record.nonce);
    for (const id of ["a", "b", "c"]) {
      const href = decode(body.match(new RegExp(`<a data-vendor="${id}" href="([^"]+)"`))[1]);
      const supplier = await (await fetch(new URL(href, base))).text();
      assert.ok(supplier.includes('aria-label="过期摘要"'));
      assert.equal(supplier.includes('<section aria-label="当前报价"'), variant === 1);
      assert.equal(supplier.includes('id="expand-terms"'), variant === 3);
      for (const source of [supplier, await (await fetch(record.documents[id].termsURL)).text(), await (await fetch(record.documents[id].quoteURL)).text()]) {
        assert.doesNotMatch(source, /oracle|expected|"selection"|"eligible"|"total"/);
        for (const script of source.matchAll(/<script>([\s\S]*?)<\/script>/g)) new vm.Script(script[1]);
      }
      seenRevisions.add(record.documents[id].quote.revision); seenRevisions.add(record.documents[id].terms.revision);
    }
    const editor = await (await fetch(`${base}/research-task/${key}/editor`)).text();
    assert.doesNotMatch(editor, /oracle|expected|"rows":|"unitPrice":\d/);
    for (const script of editor.matchAll(/<script>([\s\S]*?)<\/script>/g)) new vm.Script(script[1]);
    assert.equal((await fetch(`${base}/research-task/${key}/evidence`)).status, 404);
  }
  assert.equal(fingerprints.size, 3); assert.equal(seenRevisions.size, 18);
}));

test("oracle independently compares nonce-generated offers and six actual sources, with one persisted human-readable report", () => withServer(async ({ fixture, base }) => {
  for (const variant of [1, 2, 3]) {
    const key = `completed-${variant}`; await fetch(`${base}/research-task/${key}?variant=${variant}`);
    const record = fixture.stats(key); await readAllSources(record);
    // Recompute the decision from raw source facts, without trusting the generator's selection.
    const candidates = Object.entries(record.documents).map(([id, { quote: q, terms: t }]) => ({ id, total: 12 * q.unitPrice + t.shipping,
      eligible: q.available >= 12 && q.pdWatts >= 90 && q.ethernetMbps >= 1000 && t.warrantyMonths >= 24 && t.deliverBy <= "2026-11-20" && 12 * q.unitPrice + t.shipping <= 9000 }));
    assert.equal(record.oracle.selection, candidates.filter(row => row.eligible).sort((a, b) => a.total - b.total)[0]?.id ?? "none");
    const saved = await post(`${base}/research-task/${key}/submit`, payloadFor(record)); assert.equal(saved.status, 201);
    const report = await (await fetch(base + saved.body.reportURL)).text();
    assert.ok(report.includes("三家方案比较")); assert.ok(report.includes("这是一份已保存的评审报告"));
    assert.ok(report.includes('<details open>')); assert.equal((report.match(/<a href=/g) ?? []).length, 6);
    const receipt = JSON.parse(decode(report.match(/<pre id="receipt-json">([\s\S]*?)<\/pre>/)[1]));
    assert.equal(checkResearchReceipt(receipt, fixture.stats(key)).sourceCount, 6);
    assert.equal((await post(`${base}/research-task/${key}/submit`, payloadFor(record))).status, 409);
    assert.throws(() => checkResearchReceipt(receipt, fixture.stats(key)), /strictly equal/);
  }
}));

test("wrong data, stale/foreign citations, wrong choice and absent reasons never create a report or expose the right answer", () => withServer(async ({ fixture, base }) => {
  const key = "invalid"; await fetch(`${base}/research-task/${key}?variant=2`); const record = fixture.stats(key);
  const mutations = [payload => { payload.rows[0].unitPrice++; }, payload => { payload.rows[0].total++; }, payload => { payload.rows[0].quoteURL += "-old"; },
    payload => { payload.rows[0].termsURL = payload.rows[1].termsURL; }, payload => { payload.rows[0].reason = "已核实"; },
    payload => { payload.rows[0].extra = true; }, payload => { payload.rows[1] = payload.rows[0]; }, payload => { payload.selection = record.oracle.selection === "a" ? "b" : "a"; },
    payload => { payload.rows[0].eligible = !payload.rows[0].eligible; }, payload => { payload.nonce = "foreign"; }];
  for (const mutate of mutations) {
    const payload = payloadFor(record); mutate(payload);
    const rejected = await post(`${base}/research-task/${key}/submit`, payload); assert.equal(rejected.status, 422);
    assert.deepEqual(rejected.body, { error: "Report does not match the current sources and task requirements" });
  }
  assert.equal((await post(`${base}/research-task/${key}/submit`, "{")).status, 400);
  assert.equal((await post(`${base}/research-task/${key}/submit`, "x".repeat(128 * 1024 + 1))).status, 413);
  assert.equal(fixture.stats(key).receipt, null);
  const stale = new URL(record.documents.a.quoteURL); stale.searchParams.set("revision", "past"); assert.equal((await fetch(stale)).status, 409);
  assert.equal((await fetch(`${base}/research-task/${key}/report`)).status, 404);
}));

test("post-hoc evidence rejects missing source reads, repeated submissions, byte tampering and synthetic untrusted save", () => withServer(async ({ fixture, base }) => {
  const key = "evidence"; await fetch(`${base}/research-task/${key}`); const record = fixture.stats(key); await readAllSources(record);
  const saved = await post(`${base}/research-task/${key}/submit`, payloadFor(record)); await fetch(base + saved.body.reportURL);
  const ledger = fixture.stats(key); checkResearchReceipt(ledger.receipt, ledger);
  const missing = structuredClone(ledger); missing.requests = missing.requests.filter(request => request.url !== ledger.oracle.rows[0].termsURL);
  assert.throws(() => checkResearchReceipt(missing.receipt, missing), /was served/);
  const tampered = structuredClone(ledger); tampered.posts[0].base64 = Buffer.from("changed").toString("base64"); assert.throws(() => checkResearchReceipt(tampered.receipt, tampered));
  const mutated = fixture.stats(key); mutated.oracle.rows[0].unitPrice = 1; assert.notEqual(fixture.stats(key).oracle.rows[0].unitPrice, 1);
  const noRead = structuredClone(ledger); noRead.requests = noRead.requests.filter(request => request.route !== "report"); assert.throws(() => checkResearchReceipt(noRead.receipt, noRead), /actually read/);
  const untrustedKey = "untrusted"; await fetch(`${base}/research-task/${untrustedKey}`); const untrustedRecord = fixture.stats(untrustedKey); await readAllSources(untrustedRecord);
  const untrusted = payloadFor(untrustedRecord); untrusted.events[0].trusted = false;
  const result = await post(`${base}/research-task/${untrustedKey}/submit`, untrusted); await fetch(base + result.body.reportURL);
  const untrustedLedger = fixture.stats(untrustedKey); assert.throws(() => checkResearchReceipt(untrustedLedger.receipt, untrustedLedger), /save action/);
}));

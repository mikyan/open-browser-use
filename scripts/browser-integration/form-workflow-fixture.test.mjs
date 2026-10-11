import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import vm from "node:vm";
import { createFormWorkflowFixture, expectedFormWorkflow, formWorkflowTask, formWorkflowSteps, checkFormReceipt } from "./form-workflow-fixture.mjs";

async function withServer(operation) {
  const fixture = createFormWorkflowFixture(), server = http.createServer((req, res) => {
    if (!fixture.handle(req, res, server.address().port)) { res.writeHead(404); res.end(); }
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  try { return await operation({ fixture, base }); }
  finally { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
}

const post = async (url, value) => {
  const response = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: typeof value === "string" ? value : JSON.stringify(value) });
  return { status: response.status, data: await response.json() };
};

// These are deliberately synthetic transport witnesses for unit tests. Native trust is
// checked only by checkFormWorkflow against events from the real browser acceptance run.
function unitEvents(frame = false) {
  const result = [], add = (type, id, extras = {}) => result.push({ sequence: result.length, type, trusted: true, id, value: "", ...extras });
  for (const id of frame ? ["confirm"] : ["choose-research", "recipient-confirm", "voucher-digital", "subscribe", "terms", "submit-request"]) { add("pointerdown", id); add("click", id); }
  if (!frame) { add("keydown", "recipient-name", { key: "End" }); add("change", "delivery", { trusted: false }); add("change", "materials", { trusted: false }); }
  return result;
}

function rootPayload(record) {
  const { department, preference, ...values } = expectedFormWorkflow(record.variant);
  return { nonce: record.nonce, variant: record.variant, values, events: unitEvents() };
}

async function saveFrames(base, key, record) {
  const expected = expectedFormWorkflow(record.variant);
  for (const [scope, note] of [["same", expected.department], ["cross", expected.preference]]) {
    assert.equal((await post(`${base}/form-task/${key}/save/${scope}`, { nonce: record.nonce, note, events: unitEvents(true) })).status, 200);
  }
}

test("all three variants and both independent frame scripts are syntactically valid, with visible receipt evidence", () => withServer(async ({ fixture, base }) => {
  const bodies = [];
  for (const variant of [1, 2, 3]) {
    const key = `script-${variant}`, body = await (await fetch(`${base}/form-task/${key}?variant=${variant}`)).text(); bodies.push(body);
    assert.ok(body.includes(formWorkflowTask(variant))); assert.ok(body.includes('aria-label="物资套装"'));
    assert.ok(body.includes(`http://localhost:${new URL(base).port}/form-task/${key}/frame/cross`));
    assert.ok(body.includes("attachShadow({mode:'open'})"));
    for (const source of [body, ...await Promise.all(["same", "cross"].map(scope => fetch(`${base}/form-task/${key}/frame/${scope}`).then(res => res.text())))]) {
      const scripts = [...source.matchAll(/<script>([\s\S]*?)<\/script>/g)]; assert.equal(scripts.length, 1); new vm.Script(scripts[0][1]);
    }
    assert.equal(fixture.stats(key).requests.length, 3);
  }
  assert.notEqual(bodies[0], bodies[1]); assert.ok(bodies[2].indexOf("账单信息</legend>") < bodies[2].indexOf("收件信息</legend>"));
}));

test("actual HTTP server validates all fields, frames, independent runs and exactly one submit for every variant", () => withServer(async ({ fixture, base }) => {
  for (const variant of [1, 2, 3]) {
    const key = `complete-${variant}`; await fetch(`${base}/form-task/${key}?variant=${variant}`); const record = fixture.stats(key);
    assert.deepEqual(await (await fetch(`${base}/form-task/${key}/ready`)).json(), { ready: false });
    await saveFrames(base, key, record);
    assert.deepEqual(await (await fetch(`${base}/form-task/${key}/ready`)).json(), { ready: true });
    const submitted = await post(`${base}/form-task/${key}/submit`, rootPayload(record)); assert.equal(submitted.status, 201);
    const ledger = fixture.stats(key); checkFormReceipt(ledger.receipt, ledger, variant);
    const receiptHTML = await (await fetch(base + submitted.data.receiptURL)).text(); assert.ok(receiptHTML.includes('id="receipt-json"')); assert.ok(receiptHTML.includes(`SIM-${key}`));
    const evidenceHTML = await (await fetch(`${base}/form-task/${key}/evidence`)).text(); assert.ok(evidenceHTML.includes('id="evidence-json"')); assert.ok(evidenceHTML.includes('&quot;acceptedSubmissions&quot;: 1'));
    assert.equal((await post(`${base}/form-task/${key}/submit`, rootPayload(record))).status, 409);
    assert.equal(fixture.stats(key).acceptedSubmissions, 1); assert.equal(fixture.stats(key).duplicateSubmissions, 1);
  }
  assert.equal(new Set(fixture.allStats().map(record => record.nonce)).size, 3);
}));

test("wrong fields, missing frame save, foreign nonce and malformed evidence never become a receipt", () => withServer(async ({ fixture, base }) => {
  const key = "invalid"; await fetch(`${base}/form-task/${key}`); const record = fixture.stats(key), endpoint = `${base}/form-task/${key}/submit`;
  assert.equal((await post(endpoint, rootPayload(record))).status, 422);
  await saveFrames(base, key, record);
  for (const [name, value] of [["billingName", "changed"], ["materials", ["manual"]], ["recipientName", "林晓"], ["subscribe", true], ["terms", false], ["recipientConfirmed", false]]) {
    const data = rootPayload(record); data.values[name] = value; assert.equal((await post(endpoint, data)).status, 422, name);
  }
  const extra = rootPayload(record); extra.values.unexpected = true; assert.equal((await post(endpoint, extra)).status, 422);
  const wrong = rootPayload(record); wrong.nonce = "foreign"; assert.equal((await post(endpoint, wrong)).status, 400);
  for (const events of [[null], [{ type: "click" }], "not-events"]) { const data = rootPayload(record); data.events = events; assert.equal((await post(endpoint, data)).status, 400); }
  assert.equal((await post(endpoint, "{broken")).status, 400);
  assert.equal((await post(endpoint, " ".repeat(128 * 1024 + 1))).status, 413);
  assert.equal(fixture.stats(key).receipt, null); assert.equal(fixture.stats(key).acceptedSubmissions, 0);
}));

test("evidence checker rejects untrusted clicks, missing keyboard, unrelated writes and duplicate idempotent events", () => withServer(async ({ fixture, base }) => {
  const key = "evidence"; await fetch(`${base}/form-task/${key}`); const record = fixture.stats(key); await saveFrames(base, key, record);
  await post(`${base}/form-task/${key}/submit`, rootPayload(record)); const ledger = fixture.stats(key);
  checkFormReceipt(ledger.receipt, ledger);
  const mutate = change => { const copy = structuredClone(ledger), item = copy.posts.find(entry => entry.route === "submit"), payload = JSON.parse(item.raw); change(payload.events); item.raw = JSON.stringify(payload); return copy; };
  for (const copy of [mutate(events => { events.find(event => event.type === "click").trusted = false; }), mutate(events => { events.splice(events.findIndex(event => event.type === "keydown"), 1); }),
    mutate(events => events.push({ type: "change", id: "billing-name" })), mutate(events => events.push({ type: "click", id: "terms", trusted: true }))]) assert.throws(() => checkFormReceipt(copy.receipt, copy));
  ledger.saved.same.note = "mutated copy"; assert.equal(fixture.stats(key).saved.same.note, "研发二组");
}));

test("shared public workflow has composed scoped locators, label-string and mixed selects, and no script/endpoint shortcut", () => {
  const steps = formWorkflowSteps();
  assert.equal(steps.at(-1).id, "submit-once"); assert.equal(steps.filter(step => step.id === "submit-once").length, 1);
  assert.deepEqual(steps.find(step => step.id === "materials-mixed").args.values, ["手册", { index: 2 }]);
  assert.equal(steps.find(step => step.id === "delivery-label-string").args.values, "自提");
  assert.deepEqual(steps.find(step => step.id === "delivery-label-string").locator, [{ kind: "role", role: "combobox", name: "配送方式", exact: true }]);
  for (const id of ["materials-mixed", "materials-descriptors"]) assert.deepEqual(steps.find(step => step.id === id).locator, [{ kind: "role", role: "listbox", name: "附加材料", exact: true }]);
  assert.equal(steps.find(step => step.id === "composed-kit-count").expected, 1);
  const kinds = new Set(JSON.stringify(steps).match(/"kind":"[^"]+"/g));
  for (const name of ["and", "or", "filter", "frame"]) assert.ok(kinds.has(`"kind":"${name}"`));
  assert.ok(steps.every(step => !["evaluate", "request", "fetch"].includes(step.action)));
  assert.throws(() => formWorkflowSteps(4));
});

import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import vm from "node:vm";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import { buildManagedAgentFormApp, createManagedAgentFormFixture } from "./managed-agent-form-fixture.mjs";

const tasks = [
  { slot: 1, round: 1, side: "obu", taskId: "form-r1-obu" }, { slot: 2, round: 1, side: "codex", taskId: "form-r1-codex" },
  { slot: 3, round: 2, side: "codex", taskId: "form-r2-codex" }, { slot: 4, round: 2, side: "obu", taskId: "form-r2-obu" },
];
const hash = value => createHash("sha256").update(value).digest("hex");
const decode = text => text.replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");
function request(url, payload, options = {}) {
  const body = payload === undefined ? undefined : typeof payload === "string" || Buffer.isBuffer(payload) ? payload : JSON.stringify(payload);
  return new Promise((resolve, reject) => {
    const req = http.request(url, { method: body === undefined ? "GET" : "POST", agent: false, headers: { "Content-Type": "application/json" }, ...options }, response => {
      const chunks = [];
      response.on("data", chunk => chunks.push(chunk)); response.once("error", reject); response.once("aborted", () => reject(Error("Response aborted")));
      response.once("end", () => { const text = Buffer.concat(chunks).toString("utf8"); resolve({ status: response.statusCode, text, json: () => JSON.parse(text) }); });
    });
    req.setTimeout(5000, () => req.destroy(Error("Local unit HTTP timeout"))); req.once("error", reject); req.end(body);
  });
}
async function withServer(operation) {
  const fixture = createManagedAgentFormFixture({ tasks, appJavaScript: "/* unit bundle */" });
  const server = http.createServer((req, res) => { if (!fixture.handle(req, res, server.address().port)) { res.writeHead(404); res.end(); } });
  await new Promise((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
  try { return await operation({ fixture, base: `http://127.0.0.1:${server.address().port}`, port: server.address().port }); }
  finally { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
}
const recordFor = (fixture, taskId) => fixture.allStats().find(record => record.taskId === taskId);
// Unit tests deliberately synthesize transport payloads. They do not establish
// native event trust, real React event delivery or browser frame identity.
const events = [{ sequence: 0, type: "click", trusted: true, id: "unit-only", value: "", key: "", at: 1000 }];
function savePayload(record, scope) {
  return { nonce: record.nonce, documentToken: record.frames[scope === "same" ? "same" : "cross2"].documentToken,
    generation: scope === "same" ? 1 : 2, note: record.expected[scope === "same" ? "department" : "preference"], events, overflow: false };
}
function rootPayload(record) {
  const { department, preference, ...values } = record.expected;
  return { nonce: record.nonce, documentToken: record.rootDocumentToken, round: record.round, values, stateRevision: 10,
    transitions: ["same-saved", "cross-preview-loaded", "cross-replaced", "cross-current-loaded", "cross-saved"].map((kind, index) => ({ kind, at: 1000 + index })), events, overflow: false };
}
async function open(fixture, base, taskId = tasks[0].taskId) {
  assert.equal((await request(`${base}/agent-form/${taskId}`)).status, 200);
  return recordFor(fixture, taskId);
}
async function frames(fixture, base, record) {
  const url = `${base}/agent-form/${record.taskId}`;
  assert.equal((await request(url + "/frame/same")).status, 200);
  assert.equal((await request(url + "/save/same", savePayload(record, "same"))).status, 200);
  for (const generation of [1, 2]) assert.equal((await request(url + `/frame/cross?generation=${generation}`)).status, 200);
  assert.equal((await request(url + "/save/cross", savePayload(record, "cross"))).status, 200);
  return recordFor(fixture, record.taskId);
}

test("public tasks pair business facts by round while task and document nonces remain independent", () => {
  const fixture = createManagedAgentFormFixture({ tasks, appJavaScript: "/* unit */" }), cards = fixture.publicTasks(55555), records = fixture.allStats();
  assert.deepEqual(cards.map(card => Object.keys(card).sort()), cards.map(() => ["slot", "round", "side", "taskId", "url", "instructions"].sort()));
  assert.equal(cards[0].instructions, cards[1].instructions); assert.equal(cards[2].instructions, cards[3].instructions); assert.notEqual(cards[0].instructions, cards[2].instructions);
  assert.deepEqual(records[0].expected, records[1].expected); assert.deepEqual(records[2].expected, records[3].expected); assert.notDeepEqual(records[0].expected, records[2].expected);
  assert.equal(new Set(records.map(row => row.nonce)).size, 4); assert.equal(new Set(records.flatMap(row => [row.rootDocumentToken, ...Object.values(row.frames).map(frame => frame.documentToken)])).size, 16);
  records[0].expected.recipientName = "modified copy"; assert.notEqual(fixture.allStats()[0].expected.recipientName, "modified copy");
  for (const invalid of [[tasks[0], tasks[0]], [{ ...tasks[0], taskId: "../escape" }], [{ ...tasks[0], round: 3 }], [{ ...tasks[0], answer: "private" }]]) assert.throws(() => createManagedAgentFormFixture({ tasks: invalid, appJavaScript: "x" }));
});

test("real React bundle builds without disk output and binds app, React and bundler bytes", async () => {
  const { code, metadata } = await buildManagedAgentFormApp(); new vm.Script(code);
  assert.equal(metadata.sha256, hash(Buffer.from(code))); assert.equal(metadata.bytes, Buffer.byteLength(code));
  assert.ok(Object.keys(metadata.inputHashes).some(file => file.endsWith("managed-agent-form-app.jsx")));
  assert.ok(Object.keys(metadata.inputHashes).some(file => file.includes("react-dom")));
  assert.ok(Object.keys(metadata.toolHashes).some(file => file.includes("@esbuild/")));
  assert.ok(Object.values(metadata.inputHashes).every(value => /^[a-f0-9]{64}$/.test(value)));
  assert.equal(metadata.provenance.version, 1); assert.equal(metadata.provenance.method, "discovery-then-snapshotted-final-build");
  assert.deepEqual(metadata.provenance.before, metadata.provenance.after);
  assert.deepEqual(metadata.inputHashes, metadata.provenance.before.inputs); assert.deepEqual(metadata.toolHashes, metadata.provenance.before.tools);
  assert.match(metadata.provenance.boundary, /do not prove continuous immutability/);
});

test("final build rejects changed source loads, dependency sets and before/after tool bytes", async t => {
  // Synthetic read substitutions exercise the actual builder without changing
  // repository/dependency files or claiming that a filesystem race occurred.
  for (const [label, target, occurrence, appended, pattern] of [
    ["changed actual source load", "managed-agent-form-app.jsx", 3, "\n/* changed final load */", /loaded input bytes differ/],
    ["changed dependency set", "managed-agent-form-app.jsx", 3, '\nimport "./react-app.jsx";', /input set changed/],
    ["source changed after final build", "managed-agent-form-app.jsx", 4, "\n/* changed after build */", /input bytes changed/],
    ["tool changed after final build", "package-lock.json", 2, "\n", /tool bytes changed/],
  ]) {
    await t.test(label, async t => {
      const original = fs.readFile; let reads = 0;
      t.mock.method(fs, "readFile", async function (file, ...args) {
        const value = await Reflect.apply(original, this, [file, ...args]);
        return String(file).endsWith(target) && ++reads === occurrence ? Buffer.concat([value, Buffer.from(appended)]) : value;
      });
      await assert.rejects(buildManagedAgentFormApp(), pattern);
    });
  }
});

test("root ships public instructions and configuration, same frame code parses, and no private evidence route exists", () => withServer(async ({ fixture, base }) => {
  const taskId = tasks[0].taskId, root = await request(`${base}/agent-form/${taskId}`), record = recordFor(fixture, taskId);
  assert.equal(root.status, 200); assert.ok(root.text.includes("task-instructions")); assert.doesNotMatch(root.text, /"expected"|"department":|"preference":/);
  const configuration = JSON.parse(root.text.match(/<script id="task-config" type="application\/json">([^]*?)<\/script>/)[1]);
  assert.equal(configuration.documentToken, record.rootDocumentToken); assert.equal(configuration.nonce, record.nonce);
  assert.equal((await request(`${base}/agent-form/${taskId}/app.js`)).text, "/* unit bundle */");
  const frame = await request(`${base}/agent-form/${taskId}/frame/same`); new vm.Script(frame.text.match(/<script>([^]*?)<\/script>/)[1]);
  assert.equal((await request(`${base}/agent-form/${taskId}/evidence`)).status, 404);
  assert.equal((await request(`${base}/agent-form/${taskId}/receipt`)).status, 409);
  assert.equal((await request(`${base}/agent-form/${taskId}`)).status, 409);
}));

test("each round accepts exactly two current frame saves and one original state submission with visible receipt", () => withServer(async ({ fixture, base }) => {
  for (const { taskId } of tasks) {
    const record = await frames(fixture, base, await open(fixture, base, taskId)), url = `${base}/agent-form/${taskId}`;
    const submitted = await request(url + "/submit", rootPayload(record)); assert.equal(submitted.status, 201);
    const receiptHTML = await request(base + submitted.json().receiptURL), receipt = JSON.parse(decode(receiptHTML.text.match(/<pre id="receipt-json">([^]*?)<\/pre>/)[1]));
    const final = recordFor(fixture, taskId);
    assert.deepEqual(receipt, final.receipt); assert.equal(final.submitAttempts, 1); assert.equal(final.acceptedSubmissions, 1); assert.equal(final.posts.length, 3); assert.ok(final.posts.every(post => post.accepted));
    assert.deepEqual(receipt.saves.map(save => [save.scope, save.generation]), [["same", 1], ["cross", 2]]);
    assert.equal(new Set(receipt.saves.map(save => save.saveId)).size, 2); assert.ok(receipt.saves.every(save => save.sequence < receipt.submitSequence));
    for (const post of final.posts) { assert.equal(hash(Buffer.from(post.base64, "base64")), post.sha256); assert.equal(Buffer.byteLength(post.raw), post.bytes); }
  }
}));

test("cross-origin generation order, original document tokens and mandatory frame loads are enforced", () => withServer(async ({ fixture, base }) => {
  const record = await open(fixture, base), url = `${base}/agent-form/${record.taskId}`;
  assert.equal((await request(url + "/save/same", savePayload(record, "same"))).status, 422);
  assert.equal((await request(url + "/frame/cross?generation=1")).status, 409);
  await request(url + "/frame/same"); await request(url + "/save/same", savePayload(record, "same"));
  assert.equal((await request(url + "/frame/cross?generation=2")).status, 409);
  await request(url + "/frame/cross?generation=1");
  assert.equal((await request(url + "/save/cross", { ...savePayload(record, "cross"), generation: 1, documentToken: record.frames.cross1.documentToken })).status, 422);
  assert.equal((await request(url + "/save/cross", savePayload(record, "cross"))).status, 422);
  await request(url + "/frame/cross?generation=2");
  assert.equal((await request(url + "/save/cross", { ...savePayload(record, "cross"), documentToken: record.frames.cross1.documentToken })).status, 422);
  assert.equal((await request(url + "/frame/cross?generation=1")).status, 409);
  assert.equal((await request(url + "/save/cross", savePayload(record, "cross"))).status, 200);
}));

test("wrong controlled values, missing state revision and omitted or reordered lifecycle cannot submit", () => withServer(async ({ fixture, base }) => {
  let record = await open(fixture, base), url = `${base}/agent-form/${record.taskId}`;
  assert.equal((await request(url + "/submit", rootPayload(record))).status, 422);
  record = await frames(fixture, base, record);
  for (const mutate of [value => { value.values.billingName = "changed"; }, value => { value.values.materials = ["manual"]; }, value => { value.values.recipientConfirmed = false; },
    value => { value.values.recipientName = "林晓"; }, value => { value.values.kit = "field"; }, value => { value.values.subscribe = true; }, value => { value.values.terms = false; },
    value => { value.round = 2; }, value => { value.stateRevision = 0; }, value => { delete value.values.greeting; }, value => { value.values.injected = "extra"; },
    value => { value.transitions.splice(2, 1); }, value => { value.transitions.reverse(); }, value => { value.documentToken = "foreign"; }]) {
    const payload = rootPayload(record); mutate(payload); assert.equal((await request(url + "/submit", payload)).status, 422);
  }
  assert.equal(recordFor(fixture, record.taskId).receipt, null);
}));

test("malformed, oversized, foreign and overflowed evidence stays rejected with the original body preserved", () => withServer(async ({ fixture, base }) => {
  const record = await open(fixture, base), url = `${base}/agent-form/${record.taskId}/submit`;
  for (const payload of ["{", { ...rootPayload(record), nonce: "foreign" }, { ...rootPayload(record), events: [null] }, { ...rootPayload(record), overflow: true }]) assert.equal((await request(url, payload)).status, 400);
  assert.equal((await request(url, "x".repeat(128 * 1024 + 1))).status, 413);
  const final = recordFor(fixture, record.taskId); assert.equal(final.posts.length, 5); assert.equal(final.posts[0].raw, "{"); assert.equal(final.posts.at(-1).raw, null); assert.equal(final.acceptedSubmissions, 0);
}));

test("duplicate frame saves and application submissions retain first receipt and record rejection", () => withServer(async ({ fixture, base }) => {
  const record = await frames(fixture, base, await open(fixture, base)), url = `${base}/agent-form/${record.taskId}`;
  for (const scope of ["same", "cross"]) assert.equal((await request(url + `/save/${scope}`, savePayload(record, scope))).status, 409);
  assert.equal((await request(url + "/submit", rootPayload(record))).status, 201); const original = recordFor(fixture, record.taskId).receipt;
  assert.equal((await request(url + "/submit", rootPayload(record))).status, 409);
  const final = recordFor(fixture, record.taskId); assert.deepEqual(final.receipt, original); assert.equal(final.acceptedSubmissions, 1); assert.equal(final.duplicateSubmissions, 1); assert.equal(final.submitAttempts, 2);
}));

test("bounded original request ledger records rejected routes and stops at capacity", () => withServer(async ({ fixture, base }) => {
  const record = await open(fixture, base), url = `${base}/agent-form/${record.taskId}`;
  assert.equal((await request(url + "?extra=1")).status, 400);
  for (let index = 2; index < 128; index++) assert.equal((await request(url + "/app.js")).status, 200);
  assert.equal((await request(url + "/app.js")).status, 429);
  const final = recordFor(fixture, record.taskId); assert.equal(final.requests.length, 128); assert.equal(final.overflow, true); assert.ok(final.requests.every(entry => entry.finished && !entry.aborted));
}));

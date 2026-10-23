import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import os from "node:os";
import { createServer } from "node:http";
import { createResearchWorkflowFixture, researchWorkflowTask } from "./research-workflow-fixture.mjs";
import { parseManagedPairedResearchArguments, selectPairedResearchTask, managedPairedResearchLaunchCard, verifyPairedResearchViewerTabs,
  verifyPairedResearchTiming, verifyPairedResearchBusiness, verifyPairedResearchMaterials } from "./managed-paired-research-support.mjs";

function ready(origin = "http://127.0.0.1:23456") {
  return { url: `${origin}/`, output: path.join(os.tmpdir(), "paired-server-owned-by-root"), startedAt: new Date(1000).toISOString(), node: process.version, pid: process.pid,
    fixtureSha256: "a".repeat(64), serverSha256: "b".repeat(64),
    tasks: [1, 2].flatMap(round => ["obu", "codex"].map((side, index) => ({ id: "R", round, side, pairId: `p15-research-r${round}`,
      url: `${origin}/research-task/p15-r${round}-${side}-${String(round * 2 + index).repeat(32)}?variant=3`, instructions: researchWorkflowTask() }))) };
}
const socketPath = "\\\\.\\pipe\\original-paired-native";
const choice = () => selectPairedResearchTask(ready(), { round: 1 });
const cardOptions = () => ({ sdkPath: path.join(os.tmpdir(), "sdk/index.js"), recordingModule: path.join(os.tmpdir(), "recorded-agent-sdk.mjs"), socketPath,
  artifactDir: path.join(os.tmpdir(), "only-this-solver"), selection: choice() });

test("argument parser selects one original ready and round without replay options", () => {
  const file = path.join(os.tmpdir(), "ready.json");
  assert.deepEqual(parseManagedPairedResearchArguments(["--ready", file, "--round", "2"]), { readyFile: path.resolve(file), round: 2 });
  for (const args of [[], ["--ready", file], ["--ready", file, "--ready", file], ["--ready", "relative.json", "--round", "1"],
    ["--ready", file, "--round", "3"], ["--ready", file, "--retry", "1"]]) assert.throws(() => parseManagedPairedResearchArguments(args));
});

test("unordered ready lookup preserves four fixed slots and distinct task keys", () => {
  const value = ready(); value.tasks.reverse();
  for (const [round, side, slot] of [[1, "obu", 1], [1, "codex", 2], [2, "codex", 3], [2, "obu", 4]]) {
    const selected = selectPairedResearchTask(value, { round, side });
    assert.equal(selected.slot, slot); assert.equal(selected.task.attempt, 1); assert.equal(selected.task.budgetMs, 900000);
    assert.equal(selected.task.url, value.tasks.find(task => task.round === round && task.side === side).url);
  }
});

test("ready rejects malformed identity, ambiguous slots, cross-origin and private fields", () => {
  const mutations = [value => value.tasks.pop(), value => value.tasks.push(value.tasks[0]), value => { value.tasks[3] = value.tasks[0]; },
    value => { value.tasks[0].side = "codex"; }, value => { value.tasks[0].round = 2; }, value => { value.tasks[0].pairId = "another"; },
    value => { value.tasks[0].url = value.tasks[1].url; }, value => { value.tasks[0].url = value.tasks[0].url.replace("127.0.0.1", "localhost"); },
    value => { value.tasks[0].url += "&other=1"; }, value => { value.tasks[0].url = value.tasks[0].url.replace("variant=3", "variant=1"); },
    value => { value.tasks[0].url += "#private"; }, value => { value.tasks[0].url = value.tasks[0].url.replace("p15-r1-obu-", "other-"); },
    value => { value.tasks[0].instructions += " extra answer"; }, value => { value.tasks[0].oracle = {}; }, value => { value.seed = "private"; },
    value => { value.url = "http://127.0.0.1/"; }, value => { value.url = "http://user@127.0.0.1:23456/"; },
    value => { value.output = "relative"; }, value => { value.startedAt = "invalid"; }, value => { value.pid = 0; }, value => { value.fixtureSha256 = "unknown"; }];
  for (const mutate of mutations) { const value = ready(); mutate(value); assert.throws(() => selectPairedResearchTask(value, { round: 1 })); }
});

test("single public card cannot project the other three tasks or private server fields", () => {
  const options = cardOptions(); options.selection.privateOracle = { answer: "secret" }; options.selection.ready = ready();
  const card = managedPairedResearchLaunchCard(options), text = JSON.stringify(card);
  assert.equal(card.tasks.length, 1); assert.equal(card.tasks[0].taskId, options.selection.task.taskId);
  assert.equal(card.tasks[0].recordingDir, path.join(options.artifactDir, "recording-1"));
  for (const task of ready().tasks.slice(1)) assert.ok(!text.includes(task.url));
  assert.ok(!text.includes(ready().output)); assert.ok(!text.includes("secret")); assert.equal(card.instructions, researchWorkflowTask());
  assert.match(card.protocol, /Only connectOpenBrowserUse and beginTurn/); assert.match(card.protocol, /there is no next task/);
  assert.match(card.protocol, /not proof of solver process liveness/);
  assert.throws(() => managedPairedResearchLaunchCard({ ...options, selection: selectPairedResearchTask(ready(), { round: 1, side: "codex" }) }));
});

test("single-report viewer retains all initial pages and the exact original delivery", () => {
  const initialTabs = [{ id: 1, kind: "browser", title: "about:blank" }], resultEntry = { id: 2, kind: "result", watchable: true, deliveryId: "original" };
  const input = { initialTabs, resultEntry, currentTabs: [resultEntry, ...initialTabs] };
  assert.deepEqual(verifyPairedResearchViewerTabs(input), { originalTabIds: [1], reportTabId: 2, total: 2 });
  for (const currentTabs of [[], [resultEntry], initialTabs, [...input.currentTabs, resultEntry], [...input.currentTabs, { id: 3, kind: "browser" }],
    [initialTabs[0], { ...resultEntry, deliveryId: "replacement" }]]) assert.throws(() => verifyPairedResearchViewerTabs({ ...input, currentTabs }));
});

const argumentsRecord = (...values) => ({ $type: "Array", properties: { ...Object.fromEntries(values.map((value, index) => [index, value])), length: values.length } });
const objectRecord = properties => ({ $type: "Object", properties });
function trace() {
  const task = choice().task, rows = [], tick = wallMs => ({ wallMs, monotonicNs: String(wallMs * 1000000) });
  const add = (operation, kind, args, start, end) => {
    const callId = `call-${rows.length / 2 + 1}`, receiver = { kind, $sdkRef: kind }, stamp = tick(start);
    rows.push({ version: 1, phase: "start", callId, receiver, operation, args, start: stamp });
    rows.push({ version: 1, phase: "return", callId, receiver, operation, start: stamp, end: tick(end), result: null });
  };
  add("connectOpenBrowserUse", "module", argumentsRecord(objectRecord({ socketPath, sessionId: task.taskId })), 1000, 1010);
  add("beginTurn", "OpenBrowserUseClient", argumentsRecord(), 1020, 1030);
  add("newTab", "OpenBrowserUseBrowser", argumentsRecord(objectRecord({ url: task.url })), 1040, 1050);
  add("domSnapshot", "OpenBrowserUseTab", argumentsRecord(), 1060, 1070);
  add("finalizeTabs", "OpenBrowserUseClient", argumentsRecord(argumentsRecord(objectRecord({ tabId: 15, status: "deliverable" }))), 1080, 1090);
  add("close", "OpenBrowserUseBrowser", argumentsRecord(), 1100, 1110);
  rows.push({ version: 1, phase: "close", at: tick(1120), calls: 6, pendingCalls: [] });
  const options = { task, socketPath, enabledAt: 990, receivedAt: 1140, terminal: { startedAt: 1035, completedAt: 1130, reportTabId: 15 } };
  return { rows, options };
}
const log = rows => rows.map(row => JSON.stringify(row)).join("\n") + "\n";

test("actual trace measures business before the first call and cleanup after its last settlement", () => {
  const { rows, options } = trace();
  assert.deepEqual(verifyPairedResearchTiming(log(rows), options), { firstBusinessCallId: "call-3", firstBusinessAt: 1040, lastBusinessAt: 1070, businessMs: 30,
    cleanupMs: 60, finalizationCallId: "call-5", closedAt: 1120, calls: 6, semanticReadingAudit: "pending" });
});

test("getInfo is business, and a late marker cannot hide its time in preparation", () => {
  const { rows, options } = trace(); rows[2].operation = rows[3].operation = "getInfo";
  assert.throws(() => verifyPairedResearchTiming(log(rows), options), /preceded/);
  options.terminal.startedAt = 1015;
  assert.equal(verifyPairedResearchTiming(log(rows), options).firstBusinessAt, 1020);
});

test("timing rejects missing closure, pending calls, wrong original identity and wrong deliverable", () => {
  const mutations = [({ rows }) => rows.pop(), ({ rows }) => { rows.at(-1).pendingCalls.push("call-99"); },
    ({ rows }) => { rows[0].args.properties[0].properties.socketPath = "another-pipe"; },
    ({ rows }) => { rows[0].args.properties[0].properties.sessionId = "other-task"; },
    ({ rows }) => { rows[8].args.properties[0].properties[0].properties.tabId = 99; },
    ({ rows }) => { rows[8].args.properties[0].properties[0].properties.status = "keep"; },
    ({ rows }) => { rows[9].phase = "throw"; }, ({ rows }) => { rows[10].operation = rows[11].operation = "getInfo"; },
    ({ rows }) => { rows[4].args.properties[0].properties.url = "http://127.0.0.1:23456/other"; },
    ({ options }) => { options.terminal.startedAt = 1041; }, ({ options }) => { options.terminal.completedAt = 1119; },
    ({ rows }) => { rows[6].start.wallMs = 1000; }, ({ rows }) => { rows[6].start.wallMs = 1060.25; }];
  for (const mutate of mutations) { const value = trace(); mutate(value); assert.throws(() => verifyPairedResearchTiming(log(value.rows), value.options)); }
});

test("business and cleanup budgets are independent even when the combined allowance fits", () => {
  const business = trace();
  for (const row of business.rows.slice(7)) for (const field of ["start", "end", "at"]) if (row[field]) {
    row[field] = { ...row[field], wallMs: row[field].wallMs + 900000 };
  }
  // The original start value is shared by the synthetic return; retain its paired start.
  business.rows[7].start = business.rows[6].start;
  business.options.receivedAt += 900000; business.options.terminal.completedAt += 900000;
  assert.throws(() => verifyPairedResearchTiming(log(business.rows), business.options), /business budget/);
  const cleanup = trace(); cleanup.options.terminal.completedAt = 1070 + 60001; cleanup.options.receivedAt = cleanup.options.terminal.completedAt;
  assert.throws(() => verifyPairedResearchTiming(log(cleanup.rows), cleanup.options), /cleanup budget/);
});

async function withFixture(operation) {
  const nonces = ["11111111-1111-4111-8111-111111111111", "22222222-2222-4222-8222-222222222222"];
  const fixture = createResearchWorkflowFixture({ nonceFactory: key => nonces[Number(key.match(/^p15-r([12])-/)[1]) - 1] });
  const server = createServer((request, response) => { if (!fixture.handle(request, response, server.address().port)) { response.writeHead(404); response.end(); } });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  try { return await operation({ fixture, originalReady: ready(`http://127.0.0.1:${server.address().port}`) }); }
  finally { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
}
async function response(url, options) { const value = await fetch(url, options); return { status: value.status, text: await value.text() }; }
async function submitFixture(selection, fixture) {
  const businessStartedAt = Date.now(); assert.equal((await response(selection.task.url)).status, 200);
  const row = fixture.stats(selection.task.taskId);
  for (const vendor of Object.values(row.documents)) for (const field of ["quoteURL", "termsURL"]) assert.equal((await response(vendor[field])).status, 200);
  // This synthetic HTTP payload tests audit rejection. Its oracle/trusted flags
  // are never a browser acceptance or available to an actual solver.
  const payload = { nonce: row.nonce, rows: row.oracle.rows, selection: row.oracle.selection,
    summary: "本单元测试核对全部六份来源和正确的报告账本，仅验证审计函数而不证明浏览器可信操作。",
    events: [{ type: "click", trusted: true, id: "save-report", at: Date.now() }, { type: "submit", trusted: true, at: Date.now() }] };
  const saved = await response(`${selection.origin}/research-task/${selection.task.taskId}/submit`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload) });
  assert.equal(saved.status, 201); assert.equal((await response(new URL(JSON.parse(saved.text).reportURL, selection.origin))).status, 200);
  const ledger = fixture.stats(selection.task.taskId);
  return { selection, receipt: ledger.receipt, ledger, businessStartedAt, businessCompletedAt: Date.now(), payload };
}

test("real fixture HTTP keeps paired facts equal, separate single submissions and new second-round material", () => withFixture(async ({ fixture, originalReady }) => {
  for (const selected of originalReady.tasks.map(task => selectPairedResearchTask(originalReady, task))) {
    const result = await submitFixture(selected, fixture);
    assert.equal(verifyPairedResearchBusiness(result).knownTaskPOSTs, 1);
  }
  assert.deepEqual(verifyPairedResearchMaterials(originalReady, fixture.allStats()), { rounds: 2, attempts: 4, sameRoundFacts: true, separateTaskKeys: true, newSecondRoundMaterial: true });
  const changed = fixture.allStats(); changed[1].documents.a.quote.unitPrice++;
  assert.throws(() => verifyPairedResearchMaterials(originalReady, changed), /facts/);
  const stale = fixture.allStats(); stale[2].nonce = stale[3].nonce = stale[0].nonce;
  assert.throws(() => verifyPairedResearchMaterials(originalReady, stale));
  assert.throws(() => verifyPairedResearchMaterials(originalReady, fixture.allStats().slice(1)), "Missing initialization is unverified, not a replaced attempt");
}));

test("final business audit rejects missing sources, wrong receipt, early requests and post-time hiding", () => withFixture(async ({ fixture, originalReady }) => {
  const input = await submitFixture(selectPairedResearchTask(originalReady, { round: 1 }), fixture);
  const mutations = [value => { value.ledger.requests = value.ledger.requests.filter(row => row.url !== value.ledger.documents.a.termsURL); },
    value => { value.receipt.rows[0].total++; }, value => { value.ledger.requests[0].at = value.businessStartedAt - 1; },
    value => { value.businessCompletedAt = value.businessStartedAt; }, value => { value.ledger.posts[0].base64 = "corrupt"; },
    value => { value.ledger.requests.push({ method: "DELETE", at: value.businessCompletedAt, route: "report" }); }];
  for (const mutate of mutations) { const value = structuredClone(input); mutate(value); assert.throws(() => verifyPairedResearchBusiness(value)); }
}));

for (const [name, route, body, status] of [["unknown POST route", "unexpected", "x", 405], ["oversized POST omitted from posts", "submit", "x".repeat(128 * 1024 + 1), 413]]) {
  test(`full known-task HTTP collection rejects ${name}`, () => withFixture(async ({ fixture, originalReady }) => {
    const input = await submitFixture(selectPairedResearchTask(originalReady, { round: 1 }), fixture);
    assert.equal((await response(`${input.selection.origin}/research-task/${input.selection.task.taskId}/${route}`, { method: "POST", body })).status, status);
    input.ledger = fixture.stats(input.selection.task.taskId); assert.equal(input.ledger.posts.length, 1);
    assert.throws(() => verifyPairedResearchBusiness(input), /Every known-task POST/);
  }));
}

test("a duplicate real submission is retained and cannot become a passed attempt", () => withFixture(async ({ fixture, originalReady }) => {
  const input = await submitFixture(selectPairedResearchTask(originalReady, { round: 1 }), fixture);
  assert.equal((await response(`${input.selection.origin}/research-task/${input.selection.task.taskId}/submit`, { method: "POST", body: JSON.stringify(input.payload) })).status, 409);
  input.ledger = fixture.stats(input.selection.task.taskId); assert.equal(input.ledger.posts.length, 2);
  assert.throws(() => verifyPairedResearchBusiness(input));
}));

test("runner import is inert and never launches a browser", async () => {
  assert.equal(typeof (await import("./managed-paired-research-check.mjs")).runManagedPairedResearchCheck, "function");
});

import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import os from "node:os";
import { managedAgentFormInstructions } from "./managed-agent-form-fixture.mjs";
import { selectManagedAgentFormTask, managedAgentFormLaunchCard, managedAgentFormSourceFiles,
  verifyManagedAgentFormRound, verifyManagedAgentFormDocument } from "./managed-agent-form-support.mjs";

const taskIdFor = slot => {
  const [round, side] = [[1, "obu"], [1, "codex"], [2, "codex"], [2, "obu"]][slot - 1];
  return `maf-r${round}-${side}-${String(slot).repeat(32)}`;
};
function ready() {
  const origin = "http://127.0.0.1:24567";
  return { version: 1, kind: "managed-agent-form", pid: process.pid, node: process.version,
    startedAt: new Date(1000).toISOString(), output: path.join(os.tmpdir(), "original-form-server"), origin,
    sources: Object.fromEntries(managedAgentFormSourceFiles.map(file => [file.entry, "a".repeat(64)])),
    app: { sha256: "b".repeat(64), bytes: 4096 },
    tasks: [[1, "obu"], [1, "codex"], [2, "codex"], [2, "obu"]].map(([round, side], index) => ({
      slot: index + 1, round, side, taskId: taskIdFor(index + 1), url: `${origin}/agent-form/${taskIdFor(index + 1)}`,
      instructions: managedAgentFormInstructions(round) })) };
}
const choice = () => selectManagedAgentFormTask(ready(), { round: 1 });

test("fixed four-slot selection retains same-round instructions and fresh second round", () => {
  for (const [round, side, slot] of [[1, "obu", 1], [1, "codex", 2], [2, "codex", 3], [2, "obu", 4]]) {
    const selected = selectManagedAgentFormTask(ready(), { round, side });
    assert.equal(selected.slot, slot); assert.equal(selected.task.round, round);
    assert.equal(selected.task.attempt, 1); assert.equal(selected.task.budgetMs, 900000);
  }
});

test("identity, source and material substitution cannot become another original task", () => {
  const mutations = [
    row => row.tasks.reverse(), row => { row.tasks[3] = row.tasks[0]; },
    row => { [row.tasks[0].taskId, row.tasks[1].taskId] = [row.tasks[1].taskId, row.tasks[0].taskId]; [row.tasks[0].url, row.tasks[1].url] = [row.tasks[1].url, row.tasks[0].url]; },
    row => { row.tasks[0].url += "?other=1"; }, row => { row.tasks[0].url = row.tasks[1].url; },
    row => { row.tasks[1].instructions += " different values"; },
    row => { row.tasks[0].instructions = row.tasks[1].instructions = "Both sides receive a different task despite unchanged source hashes."; },
    row => { row.tasks[2].instructions = row.tasks[3].instructions = row.tasks[0].instructions; },
    row => { row.tasks[0].oracle = {}; }, row => { row.seed = "private"; },
    row => { row.origin = "http://localhost:24567"; }, row => { row.origin = "http://user@127.0.0.1:24567"; },
    row => { row.app.bytes = 0; }, row => { row.app.sha256 = "unknown"; },
    row => { delete row.sources[managedAgentFormSourceFiles[0].entry]; },
    row => { row.sources.extra = "c".repeat(64); }, row => { row.output = "relative"; }
  ];
  for (const mutate of mutations) { const value = ready(); mutate(value); assert.throws(() => selectManagedAgentFormTask(value, { round: 1 })); }
});

test("public solver card exposes only its own task and keeps terminal diagnostics separate", () => {
  const selection = choice(); selection.privateAnswer = { hidden: "do-not-project" }; selection.otherTasks = ready().tasks;
  const input = { selection, sdkPath: path.join(os.tmpdir(), "sdk/index.js"), recordingModule: path.join(os.tmpdir(), "recorder.mjs"),
    artifactDir: path.join(os.tmpdir(), "solver"), socketPath: "\\\\.\\pipe\\original-form" };
  const card = managedAgentFormLaunchCard(input), text = JSON.stringify(card);
  assert.equal(card.tasks.length, 1); assert.equal(card.tasks[0].taskId, taskIdFor(1));
  assert.equal(card.tasks[0].recordingDir, path.join(input.artifactDir, "recording-1"));
  assert.ok(!text.includes("do-not-project")); assert.ok(!text.includes("original-form-server"));
  for (const task of ready().tasks.slice(1)) assert.ok(!text.includes(task.url));
  assert.match(card.protocol, /EXACTLY these seven fields/); assert.match(card.protocol, /separate artifact files/);
  assert.match(card.protocol, /not proof of solver process liveness/);
  assert.throws(() => managedAgentFormLaunchCard({ ...input, selection: selectManagedAgentFormTask(ready(), { round: 1, side: "codex" }) }));
});

function observation() {
  const selection = choice(), blank = { id: 1, url: "about:blank", windowId: 1, groupId: -1, pinned: false, active: true };
  const report = { id: 2, url: `${selection.origin}/agent-form/${taskIdFor(1)}/receipt`, windowId: 2, groupId: -1, pinned: false, active: false };
  const before = { identity: "observer", overflow: false, stopped: false, events: [], tabs: [blank] };
  const after = { identity: "observer", overflow: false, events: [{ sequence: 0, at: 1100, type: "created", tab: { ...report, url: "about:blank" } }],
    tabs: [blank, report], targets: [{ id: "target-2", tabId: 2, url: report.url, attached: false }] };
  return { task: selection.task, terminal: { success: true, reportTabId: 2 }, before, after, fixtureURL: selection.origin };
}

test("single-form delivery preserves originals and exact native event accounting", () => {
  const result = verifyManagedAgentFormRound(observation());
  assert.deepEqual(result.createdTabIds, [2]); assert.deepEqual(result.closedTabIds, []); assert.equal(result.target.id, "target-2");
  const input = observation();
  input.after.events.push({ sequence: 1, at: 1200, type: "created", tab: { id: 3 } }, { sequence: 2, at: 1300, type: "removed", tabId: 3 });
  assert.deepEqual(verifyManagedAgentFormRound(input).closedTabIds, [3]);
});

test("missing original, unrecorded creation, changed selection and wrong native receipt all fail", () => {
  const mutations = [
    row => { row.after.tabs = row.after.tabs.slice(1); }, row => { row.after.events = []; },
    row => { row.after.tabs[1].active = true; }, row => { row.after.tabs[0] = { ...row.after.tabs[0], active: false }; },
    row => { row.after.tabs.push({ id: 4 }); }, row => { row.after.targets[0].attached = true; },
    row => { row.after.targets[0].url += "?changed"; }, row => { row.after.tabs[1].url = row.after.tabs[1].url.replace(taskIdFor(1), taskIdFor(2)); },
    row => { row.after.events.push({ sequence: 1, at: 1200, type: "focus", windowId: 2 }); },
    row => { row.after.events.push({ sequence: 1, at: 1200, type: "removed", tabId: 1 }); },
    row => { row.after.identity = "replacement"; }, row => { row.after.overflow = true; }
  ];
  for (const mutate of mutations) { const input = observation(); mutate(input); assert.throws(() => verifyManagedAgentFormRound(input)); }
});

test("public document identity never substitutes for final semantic/server audit", () => {
  const { task, fixtureURL } = observation();
  const receipt = { version: 1, taskId: task.taskId, round: 1, receiptId: "receipt-1", values: { public: "original" }, saves: [{ scope: "same" }, { scope: "cross" }] };
  const document = { url: `${fixtureURL}/agent-form/${task.taskId}/receipt`, title: "Original receipt", text: "Original submitted values", receiptText: JSON.stringify(receipt), links: [] };
  const input = { task, document, receipt, fixtureURL };
  assert.equal(verifyManagedAgentFormDocument(input).businessAudit, "pending-final-server-audit");
  for (const change of [value => { value.receipt.taskId = "other"; }, value => { value.receipt.round = 2; },
    value => { value.receipt.saves[1].scope = "same"; }, value => { value.document.url += "#other"; },
    value => { value.document.receiptText = "null"; }]) {
    const value = structuredClone(input); change(value); assert.throws(() => verifyManagedAgentFormDocument(value));
  }
});

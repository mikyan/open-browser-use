// Fixed controlled-form contract for the shared formal managed runner.
// This module never performs a business action or reads a private answer.
import assert from "node:assert/strict";
import path from "node:path";
import { managedAgentFormInstructions } from "./managed-agent-form-fixture.mjs";
import { managedResearchBudgetMs, managedResearchCleanupBudgetMs, managedResearchStartupBudgetMs,
  managedResearchObservationDelta } from "./managed-research-support.mjs";

const keys = (value, expected, label) => {
  assert.ok(value && typeof value === "object" && !Array.isArray(value), label);
  assert.deepEqual(Object.keys(value).sort(), [...expected].sort(), label);
};
const sha = value => assert.ok(typeof value === "string" && /^[0-9a-f]{64}$/.test(value), "Original SHA-256 required");
const integer = value => assert.ok(Number.isSafeInteger(value) && value > 0);
const ordered = values => [...values].sort((a, b) => a - b);
const slots = [[1, "obu"], [1, "codex"], [2, "codex"], [2, "obu"]];
const sourceNames = ["managed-agent-form-fixture.mjs", "managed-agent-form-app.jsx", "managed-agent-form-server.mjs", "research-request-ledger.mjs", "fixture-listener.mjs"];

export const managedAgentFormSourceFiles = sourceNames.map(entry => ({ readyField: "sources", entry, path: `scripts/browser-integration/${entry}` }));
export const managedAgentFormScope = "One original independent controlled-form task through formal managed, public recorded SDK, actual delivered DOM/viewer, native/OS observations and complete original Stop/cleanup. Runner pass is not business or comparison pass.";
export const managedAgentFormLimits = "No fixture oracle or server ledger is read by this runner. Independent final audit must verify real controlled-state inputs, original current-frame saves, unique submission, same-round materials and all HTTP after all solvers and the original server exit. Keep every first failure. OS samples do not prove continuous cursor immobility. Protocol files are milestones, never solver process liveness.";

export function selectManagedAgentFormTask(ready, { round, side = "obu" }) {
  assert.ok([1, 2].includes(round) && ["obu", "codex"].includes(side));
  keys(ready, ["version", "kind", "pid", "node", "startedAt", "output", "origin", "sources", "app", "tasks"], "Original controlled-form ready schema required");
  assert.equal(ready.version, 1); assert.equal(ready.kind, "managed-agent-form");
  integer(ready.pid); assert.match(ready.node, /^v\d+\.\d+\.\d+$/);
  assert.equal(new Date(ready.startedAt).toISOString(), ready.startedAt);
  assert.ok(typeof ready.output === "string" && path.isAbsolute(ready.output));
  const origin = new URL(ready.origin);
  assert.equal(origin.protocol, "http:"); assert.equal(origin.hostname, "127.0.0.1");
  assert.ok(Number(origin.port) > 0 && Number(origin.port) <= 65535);
  assert.equal(ready.origin, origin.origin, "Exact credential-free loopback origin required");
  keys(ready.sources, sourceNames, "Exact frozen source set required");
  Object.values(ready.sources).forEach(sha);
  keys(ready.app, ["sha256", "bytes"], "Original application bundle metadata required");
  sha(ready.app.sha256); integer(ready.app.bytes); assert.ok(ready.app.bytes <= 8 * 1024 * 1024);
  assert.ok(Array.isArray(ready.tasks)); assert.equal(ready.tasks.length, 4);
  const taskIDs = new Set(), instructions = new Map();
  for (let index = 0; index < slots.length; index++) {
    const item = ready.tasks[index], [expectedRound, expectedSide] = slots[index];
    keys(item, ["slot", "round", "side", "taskId", "url", "instructions"], "Only public task fields are accepted");
    assert.equal(item.slot, index + 1); assert.equal(item.round, expectedRound); assert.equal(item.side, expectedSide);
    assert.match(item.taskId, new RegExp(`^maf-r${expectedRound}-${expectedSide}-[0-9a-f]{32}$`), "Original key must bind its side and round");
    assert.equal(taskIDs.has(item.taskId), false, "Each first attempt requires an independent task key"); taskIDs.add(item.taskId);
    assert.equal(item.url, `${origin.origin}/agent-form/${item.taskId}`);
    assert.ok(typeof item.instructions === "string" && item.instructions.length > 20 && item.instructions.length <= 12000);
    assert.equal(item.instructions, managedAgentFormInstructions(item.round), "Public instructions must match the frozen task");
    if (instructions.has(item.round)) assert.equal(item.instructions, instructions.get(item.round), "Same-round public instructions must match");
    else instructions.set(item.round, item.instructions);
  }
  assert.notEqual(instructions.get(1), instructions.get(2), "The second round must have fresh requested values");
  const item = ready.tasks.find(task => task.round === round && task.side === side);
  return { round, side, slot: item.slot, origin: origin.origin, instructions: item.instructions,
    task: { attempt: 1, taskId: item.taskId, url: item.url, budgetMs: managedResearchBudgetMs, round } };
}

export function managedAgentFormLaunchCard({ sdkPath, recordingModule, socketPath, artifactDir, selection }) {
  for (const file of [sdkPath, recordingModule, artifactDir]) assert.ok(typeof file === "string" && path.isAbsolute(file));
  assert.ok(typeof socketPath === "string" && socketPath.startsWith("\\\\.\\pipe\\"));
  assert.equal(selection.side, "obu");
  const { task } = selection;
  assert.equal(task.attempt, 1); assert.equal(task.budgetMs, managedResearchBudgetMs);
  assert.equal(task.round, selection.round); assert.ok([1, 2].includes(task.round));
  assert.match(task.taskId, new RegExp(`^maf-r${selection.round}-obu-[0-9a-f]{32}$`));
  assert.equal(task.url, `${selection.origin}/agent-form/${task.taskId}`);
  return { version: 1, sdkPath, recordingModule, socketPath, artifactDir, instructions: selection.instructions,
    tasks: [{ attempt: 1, taskId: task.taskId, url: task.url, budgetMs: managedResearchBudgetMs, recordingDir: path.join(artifactDir, "recording-1") }],
    startupObservationBudgetMs: managedResearchStartupBudgetMs, cleanupBudgetMs: managedResearchCleanupBudgetMs,
    protocol: "One original controlled-form task only. Use createRecordedAgentSDK({sdkPath,directory:tasks[0].recordingDir}) from recordingModule and connect once through the supplied named pipe with sessionId equal to taskId; then await browser.client.beginTurn(). Only connectOpenBrowserUse and beginTurn are preparation. Before creating the recorder or connecting, record const preparationStartedAt=Date.now() and atomically persist preparation.json with exactly {taskId,preparationStartedAt}. This separate preparation record is not the business start marker. Immediately before the first other public API call record const startedAt=Date.now() and atomically write start-1.json with exactly {attempt:1,taskId,startedAt}. Protocol times are positive safe-integer UTC milliseconds, never filesystem times. Read the public task through the formal SDK and solve independently. Do not read fixture/server/ready files, other attempts, scoring or audit outputs. Do not use host CDP, direct HTTP, browser-internal state, framework state or page-script mutations to perform business. Preserve original errors without replaying submissions. Read the original saved receipt through the public SDK, then await browser.client.finalizeTabs([{tabId:originalReceiptTabId,status:'deliverable'}]); explicitly browser.close(), await recording.closeLog(), and atomically write attempt-1.json with EXACTLY these seven fields: {attempt:1,taskId,success,reportTabId,summary,startedAt,completedAt:Date.now()}. Put local errors, partial results and pending-call details in separate artifact files, never add terminal fields; use summary to reference them. reportTabId may be null on failure. If start-1.json exists, terminal.startedAt must equal that original business startedAt for success or failure. Only on preparation failure with no business start marker use preparationStartedAt as terminal.startedAt and record the actual completedAt. Await ack-1.json then end; there is no next task. Business is limited to 900000ms from the first non-preparation call, cleanup to 60000ms after the last business settlement. No business call may follow finalizeTabs. closeLog does not wait for or cancel pending SDK calls. Protocol files are milestones, not proof of solver process liveness." };
}

export function verifyManagedAgentFormRound({ task, terminal, before, after, fixtureURL }) {
  assert.equal(terminal.success, true, "Original independent solver did not report success");
  const events = managedResearchObservationDelta(before, after);
  assert.deepEqual(events.filter(event => event.type === "activated" || event.type === "focus"), [], "Unexpected activation/focus");
  const createdTabIds = events.filter(event => event.type === "created").map(event => event.tab.id);
  const closedTabIds = events.filter(event => event.type === "removed").map(event => event.tabId);
  assert.ok(createdTabIds.length >= 1 && createdTabIds.every(Number.isSafeInteger));
  assert.equal(new Set(createdTabIds).size, createdTabIds.length);
  assert.equal(new Set(closedTabIds).size, closedTabIds.length);
  assert.deepEqual(ordered([...closedTabIds, terminal.reportTabId]), ordered(createdTabIds));
  assert.ok(createdTabIds.every(id => !before.tabs.some(tab => tab.id === id)));
  assert.ok(closedTabIds.every(id => !after.tabs.some(tab => tab.id === id)));
  assert.deepEqual(ordered(after.tabs.map(tab => tab.id)), ordered([...before.tabs.map(tab => tab.id), terminal.reportTabId]));
  for (const original of before.tabs) {
    const current = after.tabs.find(tab => tab.id === original.id);
    for (const field of ["url", "windowId", "groupId", "pinned", "active"]) assert.equal(current?.[field], original[field], `Original tab ${field} changed`);
  }
  const report = after.tabs.find(tab => tab.id === terminal.reportTabId);
  assert.ok(report); assert.equal(report.url, `${fixtureURL}/agent-form/${task.taskId}/receipt`);
  assert.equal(report.active, false, "Receipt must remain inactive");
  const targets = after.targets.filter(target => target.tabId === terminal.reportTabId);
  assert.equal(targets.length, 1); assert.equal(targets[0].url, report.url);
  assert.equal(targets[0].attached, false, "Original receipt must be detached before viewer selection");
  return { report, createdTabIds, closedTabIds, events, before: before.tabs, after: after.tabs, target: targets[0] };
}

export function readManagedAgentFormReport() {
  return { url: location.href, title: document.title, text: document.body.innerText,
    receiptText: document.querySelector("#receipt-json")?.textContent ?? null,
    links: Array.from(document.querySelectorAll("a[href]"), element => ({ text: element.textContent, href: element.href })) };
}

export function verifyManagedAgentFormDocument({ task, document, receipt, fixtureURL }) {
  assert.equal(document.url, `${fixtureURL}/agent-form/${task.taskId}/receipt`);
  assert.ok(typeof document.title === "string" && document.title.length > 0);
  assert.ok(typeof document.text === "string" && document.text.length > 0);
  assert.ok(typeof document.receiptText === "string" && document.receiptText.length <= 256 * 1024);
  assert.deepEqual(JSON.parse(document.receiptText), receipt);
  assert.equal(receipt.version, 1); assert.equal(receipt.taskId, task.taskId); assert.equal(receipt.round, task.round);
  assert.ok(typeof receipt.receiptId === "string" && receipt.receiptId.length > 0 && receipt.receiptId.length <= 128);
  assert.ok(receipt.values && typeof receipt.values === "object" && !Array.isArray(receipt.values));
  assert.ok(Array.isArray(receipt.saves)); assert.equal(receipt.saves.length, 2);
  assert.deepEqual(receipt.saves.map(save => save.scope).sort(), ["cross", "same"]);
  // Full controlled-state values, frame generations, event provenance and
  // unique HTTP submits are deliberately left to the sealed independent audit.
  return { taskId: receipt.taskId, receiptId: receipt.receiptId, businessAudit: "pending-final-server-audit" };
}

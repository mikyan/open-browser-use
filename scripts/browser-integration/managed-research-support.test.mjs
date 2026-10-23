import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { managedResearchLaunchCard, validateManagedResearchAttempt, validateManagedResearchStart, installManagedResearchObservation,
  managedResearchObservationDelta, verifyManagedResearchRound, managedResearchBudgetMs, verifyClosedManagedResearchRecording, verifyManagedResearchViewerTabs } from "./managed-research-support.mjs";

const task = { attempt: 1, taskId: "research-a", url: "http://127.0.0.1:23456/research-task/research-a?variant=3", budgetMs: managedResearchBudgetMs };
const terminal = { attempt: 1, taskId: "research-a", success: true, reportTabId: 15, summary: "The original report was saved and read.", startedAt: 2000, completedAt: 4000 };
const timing = { enabledAt: 1000, receivedAt: 5000 };
function tab(id, fields = {}) { return { id, url: `http://127.0.0.1:23456/research-task/research-a/supplier/${id}`, active: false, windowId: 1, groupId: -1, pinned: false, ...fields }; }
function round() {
  const original = tab(1, { url: "about:blank", active: true });
  const created = [12, 13, 14, 15].map(id => tab(id));
  const events = created.map(value => ({ type: "created", tab: value }));
  events.push(...[12, 13, 14].map(tabId => ({ type: "removed", tabId, windowId: 1, isWindowClosing: false })));
  events.forEach((event, index) => Object.assign(event, { sequence: index, at: 2000 + index }));
  const before = { identity: "fixed-observer", at: 1000, overflow: false, stopped: false, events: [], tabs: [original], targets: [] };
  const report = tab(15, { url: "http://127.0.0.1:23456/research-task/research-a/report" });
  const after = { ...before, at: 5000, events, tabs: [original, report], targets: [{ id: "original-report-target", tabId: 15, url: report.url, attached: false }] };
  return { task, terminal, before, after, fixtureURL: "http://127.0.0.1:23456" };
}

test("launch card selects only public fields, two fresh tasks and exact input paths", () => {
  const card = managedResearchLaunchCard({ sdkPath: path.resolve("sdk/index.js"), recordingModule: path.resolve("record.mjs"), artifactDir: path.resolve("solver"), socketPath: "\\\\.\\pipe\\owned", tasks: [{ ...task, oracle: { answer: "secret" } }, { ...task, attempt: 2, taskId: "research-b", url: task.url.replace("research-a?", "research-b?") }] });
  assert.equal(card.tasks.length, 2); assert.equal(card.tasks[0].budgetMs, 900000);
  assert.equal(JSON.stringify(card).includes("secret"), false); assert.equal(JSON.stringify(card).includes("oracle"), false);
  assert.equal(card.recordingModule, path.resolve("record.mjs"));
  assert.equal(card.tasks[1].recordingDir, path.resolve("solver", "recording-2"));
});
test("launch card rejects duplicate keys or a private/non-task route", () => {
  const base = { sdkPath: path.resolve("sdk"), recordingModule: path.resolve("recorder"), artifactDir: path.resolve("solver"), socketPath: "\\\\.\\pipe\\owned" };
  assert.throws(() => managedResearchLaunchCard({ ...base, tasks: [task, { ...task, attempt: 2 }] }));
  assert.throws(() => managedResearchLaunchCard({ ...base, tasks: [task, { ...task, attempt: 2, taskId: "b", url: "http://127.0.0.1:23456/private?variant=3" }] }));
});
test("terminal protocol binds task, order, complete shape and original clock", () => {
  assert.deepEqual(validateManagedResearchAttempt(terminal, task, timing), terminal);
  for (const mutation of [{ attempt: 2 }, { taskId: "wrong" }, { success: 1 }, { reportTabId: null }, { startedAt: 900 }, { startedAt: 2000.7422 }, { completedAt: 4000.125 }, { completedAt: 6000 }, { completedAt: 1999 }, { answer: "extra" }]) {
    assert.throws(() => validateManagedResearchAttempt({ ...terminal, ...mutation }, task, timing), JSON.stringify(mutation));
  }
});
test("start marker is separate from preparation and terminal must retain its exact clock", () => {
  const marker = { attempt: 1, taskId: task.taskId, startedAt: 2000 };
  assert.deepEqual(validateManagedResearchStart(marker, task, timing), marker);
  for (const mutation of [{ attempt: 2 }, { taskId: "other" }, { startedAt: 999 }, { startedAt: 2000.7422 }, { startedAt: 6000 }, { private: true }]) assert.throws(() => validateManagedResearchStart({ ...marker, ...mutation }, task, timing));
  assert.deepEqual(validateManagedResearchAttempt(terminal, task, { ...timing, startedAt: marker.startedAt }), terminal);
  assert.throws(() => validateManagedResearchAttempt(terminal, task, { ...timing, startedAt: marker.startedAt + 1 }), /original start marker/);
});
test("a failed solver terminal is retained without requiring a successful report", () => {
  const failure = { ...terminal, success: false, reportTabId: null, summary: "Original input failed; no replay." };
  assert.deepEqual(validateManagedResearchAttempt(failure, task, timing), failure);
  assert.throws(() => verifyManagedResearchRound({ ...round(), terminal: failure }), /Independent solver failed/);
});
test("terminal time includes at most the documented business and cleanup budgets", () => {
  assert.throws(() => validateManagedResearchAttempt({ ...terminal, completedAt: 962001 }, task, { ...timing, receivedAt: 963000 }), /budget exceeded/);
});
test("original create/remove history proves four-page solution and one retained report", () => {
  const evidence = round(), result = verifyManagedResearchRound(evidence);
  assert.deepEqual(result.createdTabIds, [12, 13, 14, 15]); assert.deepEqual(result.closedTabIds, [12, 13, 14]);
  assert.equal(result.target.id, "original-report-target");
});
test("second-round baseline can contain the earlier delivered report and must preserve it", () => {
  const evidence = round(), earlier = tab(9, { url: "http://127.0.0.1:23456/research-task/previous/report", groupId: 5, pinned: true });
  evidence.before.tabs.push(earlier); evidence.after.tabs.push(structuredClone(earlier));
  assert.equal(verifyManagedResearchRound(evidence).report.id, 15);
  evidence.after.tabs.find(value => value.id === 9).groupId = 6;
  assert.throws(() => verifyManagedResearchRound(evidence), /Preserve tab 9 groupId/);
});
test("retained report must be inactive, detached and the exact task's URL", () => {
  for (const mutation of [
    value => { value.after.tabs[1].active = true; },
    value => { value.after.targets[0].attached = true; },
    value => { value.after.targets[0].tabId = 99; },
    value => { value.after.tabs[1].url = "http://127.0.0.1:23456/research-task/other/report"; },
    value => { value.after.tabs.push(tab(12)); }
  ]) { const value = round(); mutation(value); assert.throws(() => verifyManagedResearchRound(value)); }
});
test("native activation/focus cannot be excused by a restored final selection", () => {
  for (const type of ["activated", "focus"]) {
    const value = round(); value.after.events.push({ type, tabId: 12, windowId: 1, sequence: value.after.events.length, at: 4999 });
    assert.throws(() => verifyManagedResearchRound(value), /activation\/focus/);
  }
});
test("observer reset, overflow, event omission or prefix rewrite invalidate evidence", () => {
  const value = round(); value.before.events = [value.after.events[0]];
  assert.equal(managedResearchObservationDelta(value.before, value.after).length, 6);
  for (const mutation of [
    after => { after.identity = "new"; }, after => { after.overflow = true; },
    after => { after.events[0].at++; }, after => { after.events[1].sequence++; },
    after => { after.events = []; }
  ]) { const after = structuredClone(value.after); mutation(after); assert.throws(() => managedResearchObservationDelta(value.before, after)); }
});
test("passive observer records all native event kinds and removes every listener", async () => {
  const event = () => {
    const callbacks = new Set(); return { addListener: fn => callbacks.add(fn), removeListener: fn => callbacks.delete(fn), hasListener: fn => callbacks.has(fn), emit: (...args) => { for (const fn of callbacks) fn(...args); }, get size() { return callbacks.size; } };
  };
  const chrome = { tabs: { onCreated: event(), onRemoved: event(), onActivated: event(), query: async () => [tab(1)] }, windows: { onFocusChanged: event(), getAll: async () => [{ id: 1, focused: false }] }, debugger: { getTargets: async () => [{ type: "page", id: "p", tabId: 1, url: "about:blank", attached: false }, { type: "worker", id: "w" }] } };
  const target = {}, installed = installManagedResearchObservation(chrome, target);
  assert.throws(() => installManagedResearchObservation(chrome, target), /already exists/);
  chrome.tabs.onCreated.emit(tab(4)); chrome.tabs.onRemoved.emit(4, { windowId: 1, isWindowClosing: false }); chrome.tabs.onActivated.emit({ tabId: 1, windowId: 1 }); chrome.windows.onFocusChanged.emit(-1);
  const snapshot = await target.__managedResearchObservation.snapshot();
  assert.equal(snapshot.identity, installed.identity); assert.deepEqual(snapshot.events.map(item => item.type), ["created", "removed", "activated", "focus"]); assert.equal(snapshot.targets.length, 1);
  const stopped = await target.__managedResearchObservation.stop(); assert.equal(stopped.stopped, true); assert.deepEqual(stopped.listenersPresent, [false, false, false, false]);
  chrome.tabs.onCreated.emit(tab(5)); assert.equal((await target.__managedResearchObservation.snapshot()).events.length, 4);
});
function completeLog() {
  const start = { version: 1, phase: "start", callId: "call-1", receiver: { $sdkModule: "file:///sdk/index.js" }, operation: "connectOpenBrowserUse", start: { wallMs: 1000, monotonicNs: "1000000" }, args: [] };
  return [start, { ...start, phase: "return", result: { $sdkRef: "object-1" } }, { version: 1, phase: "close", calls: 1, pendingCalls: [], at: { wallMs: 2000, monotonicNs: "2000000" } }];
}
const jsonl = rows => rows.map(row => JSON.stringify(row)).join("\n") + "\n";

function viewerInventory() {
  const initialTabs = [{ id: 10, kind: "browser", url: "about:blank", title: "about:blank", watchable: true, takeover: true, pageSelectionId: "original-page" }];
  const resultEntries = [11, 12].map(id => ({ id, kind: "result", url: `http://127.0.0.1/report/${id}`, title: "Report", watchable: true, takeover: true, deliveryId: `original-delivery-${id}` }));
  return { initialTabs, resultEntries, currentTabs: [...structuredClone(resultEntries), ...structuredClone(initialTabs)] };
}

test("two delivered reports coexist with the original blank page in the actual viewer inventory", () => {
  const inventory = viewerInventory();
  assert.deepEqual(verifyManagedResearchViewerTabs(inventory), { originalTabIds: [10], reportTabIds: [11, 12], total: 3 });
  assert.deepEqual(inventory.currentTabs.map(row => row.id), [11, 12, 10], "Checking must not mutate the original response");
});

test("viewer inventory rejects lost or changed original pages, extra pages and replaced deliveries", () => {
  for (const mutate of [
    rows => rows.pop(), rows => rows.push({ ...rows[2], id: 13 }), rows => rows.push({ ...rows[0] }),
    rows => { rows[2].url = "http://127.0.0.1/changed"; }, rows => { rows[2].pageSelectionId = "replacement"; },
    rows => { rows[0].deliveryId = "replacement"; }, rows => { rows[0].watchable = false; },
    rows => { rows[1].kind = "browser"; }, rows => rows.shift(),
  ]) { const inventory = viewerInventory(); mutate(inventory.currentTabs); assert.throws(() => verifyManagedResearchViewerTabs(inventory)); }
});
test("closed recording binds every start to one original settlement and final zero-pending close", () => {
  const result = verifyClosedManagedResearchRecording(jsonl(completeLog()));
  assert.equal(result.calls, 1); assert.equal(result.settlements, 1); assert.deepEqual(result.pendingCalls, []);
});
test("partial, duplicate, pending, reidentified or appended public recording cannot pass", () => {
  for (const mutation of [
    rows => rows.slice(0, 2), rows => [rows[0], rows[2]], rows => [rows[0], rows[0], rows[1], rows[2]],
    rows => [rows[0], { ...rows[1], operation: "other" }, rows[2]],
    rows => [rows[0], { ...rows[1], receiver: { $sdkRef: "foreign" } }, rows[2]],
    rows => [rows[0], { ...rows[1], start: { wallMs: 2000 } }, rows[2]],
    rows => [rows[0], rows[1], { ...rows[2], pendingCalls: ["call-2"] }],
    rows => [...rows, rows[0]], rows => [rows[0], rows[1], { ...rows[2], calls: 2 }]
  ]) assert.throws(() => verifyClosedManagedResearchRecording(jsonl(mutation(completeLog()))));
  assert.throws(() => verifyClosedManagedResearchRecording(jsonl(completeLog()).trimEnd()));
});

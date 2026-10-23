// Passive evidence and file protocol for a separately instructed research solver.
// No answer generation, page action, browser startup, or private-data publication.
import assert from "node:assert/strict";
import path from "node:path";
import { checkResearchTabDisposition } from "./research-workflow-evidence.mjs";

export const managedResearchBudgetMs = 900000;
export const managedResearchCleanupBudgetMs = 60000;
export const managedResearchStartupBudgetMs = 180000;

export function managedResearchLaunchCard({ sdkPath, recordingModule, socketPath, artifactDir, tasks }) {
  for (const file of [sdkPath, recordingModule, artifactDir]) assert.ok(typeof file === "string" && path.isAbsolute(file), "Explicit absolute solver input required");
  assert.ok(typeof socketPath === "string" && socketPath.startsWith("\\\\.\\pipe\\"), "Original managed named pipe required");
  assert.equal(tasks.length, 2);
  const publicTasks = tasks.map((task, index) => {
    assert.equal(task.attempt, index + 1);
    assert.match(task.taskId, /^[A-Za-z0-9_-]{1,100}$/);
    const url = new URL(task.url);
    assert.equal(url.protocol, "http:"); assert.equal(url.hostname, "127.0.0.1");
    assert.equal(url.pathname, `/research-task/${task.taskId}`); assert.equal(url.search, "?variant=3");
    return { attempt: task.attempt, taskId: task.taskId, url: task.url, budgetMs: managedResearchBudgetMs, recordingDir: path.join(artifactDir, `recording-${task.attempt}`) };
  });
  assert.notEqual(publicTasks[0].taskId, publicTasks[1].taskId);
  return { version: 1, sdkPath, recordingModule, socketPath, artifactDir, tasks: publicTasks, startupObservationBudgetMs: managedResearchStartupBudgetMs, cleanupBudgetMs: managedResearchCleanupBudgetMs,
    protocol: "For each attempt use createRecordedAgentSDK({sdkPath,directory: task.recordingDir}) from recordingModule; the factory creates that fresh directory. After reading API docs and connecting, immediately before the first public task-URL call atomically write start-N.json {attempt,taskId,startedAt}, using integer UTC epoch milliseconds from Date.now(); verify Number.isSafeInteger for every protocol time. Record the preparation start with Date.now() before preparation, never from filesystem birthtimeMs/mtimeMs or inferred after failure. There is a separate 180000ms startup observation limit after task enablement; it is not business time or proof of solver liveness. Business budget begins on the actual first public task-URL call; cleanup has a separate 60000ms budget, both verified from original public trace. After original finalize settles, explicitly browser.close(), await recording.closeLog(), then atomically write attempt-N.json including failures. closeLog neither waits for nor cancels an SDK operation: preserve failures and pending status without replay. Fields: attempt, taskId, success, reportTabId (null on failure without a report), summary, startedAt matching start-N.json and completedAt (UTC epoch milliseconds). If preparation fails before writing start, write a failed attempt immediately using its actual start/completion times. Wait for ack-N.json. Only continue:true permits the next attempt; ack-2 ends the task. Do not inspect files outside artifactDir or the supplied public SDK/recorder/API documentation. Do not read server evidence, fixture source, other agents' outputs, or private scoring. Preserve the first result; do not replay submissions. Files record protocol milestones, never solver process liveness." };
}

export function validateManagedResearchStart(value, task, { enabledAt, receivedAt }) {
  assert.ok(value && typeof value === "object" && !Array.isArray(value), "Expected original start marker");
  assert.deepEqual(Object.keys(value).sort(), ["attempt", "taskId", "startedAt"].sort());
  assert.equal(value.attempt, task.attempt); assert.equal(value.taskId, task.taskId);
  for (const time of [value.startedAt, enabledAt, receivedAt]) assert.ok(Number.isSafeInteger(time) && time > 0);
  assert.ok(value.startedAt >= enabledAt && value.startedAt <= receivedAt, "Start marker is outside its enabled observation interval");
  return structuredClone(value);
}

export function validateManagedResearchAttempt(value, task, { enabledAt, receivedAt, startedAt }) {
  assert.ok(value && typeof value === "object" && !Array.isArray(value), "Expected terminal attempt object");
  assert.deepEqual(Object.keys(value).sort(), ["attempt", "taskId", "success", "reportTabId", "summary", "startedAt", "completedAt"].sort());
  assert.equal(value.attempt, task.attempt); assert.equal(value.taskId, task.taskId);
  assert.equal(typeof value.success, "boolean");
  assert.ok(Number.isSafeInteger(value.reportTabId) || !value.success && value.reportTabId === null);
  assert.ok(typeof value.summary === "string" && value.summary.length <= 20000);
  for (const time of [value.startedAt, value.completedAt, enabledAt, receivedAt]) assert.ok(Number.isSafeInteger(time) && time > 0);
  assert.ok(value.startedAt >= enabledAt, "Task started before its permission boundary");
  if (startedAt !== undefined) assert.equal(value.startedAt, startedAt, "Terminal does not match the original start marker");
  assert.ok(value.completedAt >= value.startedAt && value.completedAt <= receivedAt, "Invalid terminal time");
  assert.ok(value.completedAt - value.startedAt <= task.budgetMs + managedResearchCleanupBudgetMs, "Task and cleanup budget exceeded");
  return structuredClone(value);
}

export function verifyClosedManagedResearchRecording(text) {
  assert.ok(typeof text === "string" && text.endsWith("\n"), "Complete newline-terminated public call log required");
  const lines = text.trimEnd().split("\n"), pending = new Map(), started = new Set(); let closed = false, settled = 0, close;
  assert.ok(lines.length >= 3 && lines.length <= 20001);
  for (const line of lines) {
    const record = JSON.parse(line); assert.equal(record.version, 1); assert.equal(closed, false, "Public call after log close");
    if (record.phase === "start") {
      assert.match(record.callId, /^call-[1-9][0-9]*$/); assert.equal(started.has(record.callId), false, "Duplicate original public call");
      assert.equal(record.callId, `call-${started.size + 1}`); assert.equal(typeof record.operation, "string");
      pending.set(record.callId, record); started.add(record.callId);
    } else if (record.phase === "return" || record.phase === "throw") {
      const original = pending.get(record.callId); assert.ok(original, "Public settlement lacks its original pending call");
      assert.equal(record.operation, original.operation); assert.deepEqual(record.receiver, original.receiver); assert.deepEqual(record.start, original.start);
      pending.delete(record.callId); settled++;
    } else {
      assert.equal(record.phase, "close"); assert.equal(pending.size, 0, "Public calls remain pending at log close");
      assert.deepEqual(record.pendingCalls, []); assert.equal(record.calls, started.size); assert.equal(settled, started.size); closed = true; close = record;
    }
  }
  assert.equal(closed, true, "Missing original log close");
  return { calls: started.size, settlements: settled, pendingCalls: [], close };
}

// The viewer also lists the original browser pages. Deliveries do not replace
// that inventory, and a solver must not close an existing page to satisfy it.
export function verifyManagedResearchViewerTabs({ initialTabs, resultEntries, currentTabs }) {
  assert.equal(resultEntries.length, 2);
  assert.ok(resultEntries.every(row => row.kind === "result" && row.watchable === true && typeof row.deliveryId === "string" && row.deliveryId.length > 0));
  assert.ok(initialTabs.every(row => row.kind === "browser"));
  const expected = [...initialTabs, ...resultEntries];
  for (const rows of [expected, currentTabs]) {
    assert.ok(rows.every(row => Number.isSafeInteger(row.id)));
    assert.equal(new Set(rows.map(row => row.id)).size, rows.length, "Duplicate viewer page identity");
  }
  const ordered = rows => [...rows].sort((left, right) => left.id - right.id);
  assert.deepEqual(ordered(currentTabs.filter(row => row.kind === "result")), ordered(resultEntries), "Original two result entries changed");
  assert.deepEqual(ordered(currentTabs), ordered(expected), "Viewer must retain the original browser pages and exact two reports");
  return { originalTabIds: initialTabs.map(row => row.id), reportTabIds: resultEntries.map(row => row.id), total: expected.length };
}

// This function is serialized into the owned extension worker. Chrome metadata
// and native event listeners are read-only; they do not control task pages.
export function installManagedResearchObservation(chrome, target) {
  if (target.__managedResearchObservation) throw Error("Research observer already exists");
  const events = [], identity = crypto.randomUUID(); let overflow = false, stopped = false;
  const append = (type, value) => {
    if (events.length >= 4096) { overflow = true; return; }
    events.push({ sequence: events.length, at: Date.now(), type, ...value });
  };
  const created = tab => append("created", { tab: { ...tab } });
  const removed = (tabId, info) => append("removed", { tabId, ...info });
  const activated = info => append("activated", { ...info });
  const focused = windowId => append("focus", { windowId });
  chrome.tabs.onCreated.addListener(created); chrome.tabs.onRemoved.addListener(removed);
  chrome.tabs.onActivated.addListener(activated); chrome.windows.onFocusChanged.addListener(focused);
  const snapshot = async () => {
    const tabs = await chrome.tabs.query({}), windows = await chrome.windows.getAll({ populate: false }), targets = await chrome.debugger.getTargets();
    return { identity, at: Date.now(), overflow, stopped, events: events.map(event => structuredClone(event)), tabs, windows,
      targets: targets.filter(row => row.type === "page").map(row => ({ id: row.id, tabId: row.tabId, url: row.url, attached: row.attached })) };
  };
  target.__managedResearchObservation = { snapshot, async stop() {
    chrome.tabs.onCreated.removeListener(created); chrome.tabs.onRemoved.removeListener(removed);
    chrome.tabs.onActivated.removeListener(activated); chrome.windows.onFocusChanged.removeListener(focused); stopped = true;
    return { ...await snapshot(), listenersPresent: [chrome.tabs.onCreated.hasListener(created), chrome.tabs.onRemoved.hasListener(removed), chrome.tabs.onActivated.hasListener(activated), chrome.windows.onFocusChanged.hasListener(focused)] };
  } };
  return { installed: true, identity };
}

export function managedResearchObservationDelta(before, after) {
  assert.equal(after.identity, before.identity, "Original observer identity changed");
  assert.equal(before.overflow, false); assert.equal(after.overflow, false);
  assert.equal(before.stopped, false);
  assert.ok(Array.isArray(before.events) && Array.isArray(after.events));
  for (const [index, event] of after.events.entries()) {
    assert.equal(event.sequence, index); assert.ok(Number.isSafeInteger(event.at));
    assert.ok(["created", "removed", "activated", "focus"].includes(event.type));
  }
  assert.ok(after.events.length >= before.events.length);
  assert.deepEqual(after.events.slice(0, before.events.length), before.events, "Original event prefix changed");
  return after.events.slice(before.events.length);
}

export function verifyManagedResearchRound({ task, terminal, before, after, fixtureURL }) {
  assert.equal(terminal.success, true, `Independent solver failed: ${terminal.summary}`);
  const events = managedResearchObservationDelta(before, after);
  assert.deepEqual(events.filter(event => event.type === "activated" || event.type === "focus"), [], "Unexpected original browser activation/focus event");
  const createdTabIds = events.filter(event => event.type === "created").map(event => event.tab.id);
  const closedTabIds = events.filter(event => event.type === "removed").map(event => event.tabId);
  const caller = { key: task.taskId, reportTabId: terminal.reportTabId, createdTabIds, closedTabIds, keptTabIds: [terminal.reportTabId] };
  const disposition = checkResearchTabDisposition(caller, before.tabs, after.tabs, events, fixtureURL);
  for (const original of before.tabs) assert.equal(after.tabs.find(tab => tab.id === original.id)?.active, original.active, "Pre-existing tab selection changed");
  const native = after.targets.filter(row => row.tabId === terminal.reportTabId);
  assert.equal(native.length, 1); assert.equal(native[0].url, disposition.report.url);
  assert.equal(native[0].attached, false, "Finalized report still attached before viewing");
  return { ...disposition, target: native[0] };
}

export function readManagedResearchReport() {
  // A read-only post-solver observation of the public saved DOM, not the fixture
  // oracle or a source of answers sent back to the solver.
  return { url: location.href, receiptText: document.querySelector("#receipt-json")?.textContent ?? null,
    text: document.body.innerText, links: Array.from(document.querySelectorAll("tbody a[href]"), element => ({ text: element.textContent, href: element.href })) };
}

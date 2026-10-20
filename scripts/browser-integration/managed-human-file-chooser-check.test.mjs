import assert from "node:assert/strict";
import { test } from "node:test";
import { installManagedFileChooserObserver, classifyManagedFileChooserBaseline, assertManagedFileChooserLedger, managedFileChooserCompletion, submitManagedFileWorkflowOriginal, readManagedFileTarget } from "./managed-human-file-chooser-check.mjs";

test("original target observation reads bounded tab/window metadata without attachment or window changes", async () => {
  const calls = [], chrome = {
    debugger: { async getTargets() { calls.push("targets"); return [{ type: "page", id: "original", tabId: 7, url: "http://127.0.0.1/original", attached: true }]; } },
    tabs: { async get(id) { calls.push(["tab", id]); return { id, windowId: 9, groupId: -1, active: false, pinned: false, title: "not-recorded" }; } },
    windows: { async get(id) { calls.push(["window", id]); return { id, type: "normal", state: "minimized", focused: false, tabs: ["not-recorded"] }; } },
  };
  const result = await readManagedFileTarget(chrome, 7);
  assert.deepEqual(calls, ["targets", ["tab", 7], ["window", 9]]);
  assert.deepEqual(result.tab, { id: 7, windowId: 9, groupId: -1, active: false, pinned: false });
  assert.deepEqual(result.window, { id: 9, type: "normal", state: "minimized", focused: false });
  assert.equal(JSON.stringify(result).includes("not-recorded"), false);
});

test("original submission records snapshot then the unchanged locator click without changing either timeout", async () => {
  for (const kind of ["root", "oopif"]) {
    const trace = [], row = {}, text = "原文".repeat(10000);
    const locator = { async click(options) { trace.push(["click", options]); } };
    const current = {
      async domSnapshot(options) { trace.push(["snapshot", options]); assert.ok(row.submission.snapshot.startedAt); return text; },
      locator(selector) { trace.push(["locator", selector]); return locator; },
      frameLocator(selector) { trace.push(["frame", selector]); return this; },
    };
    await submitManagedFileWorkflowOriginal(current, { fixture: { kind } }, row);
    assert.deepEqual(trace, [["snapshot", { timeoutMs: 10000 }], ...(kind === "oopif" ? [["frame", "#child"]] : []),
      ["locator", "#submit"], ["click", { timeoutMs: 10000 }]]);
    assert.ok(row.submission.snapshot.resolvedAt <= row.submission.click.startedAt);
    assert.ok(row.submission.click.resolvedAt >= row.submission.click.startedAt);
    assert.equal(row.submission.snapshot.result.bytes, Buffer.byteLength(text));
    assert.equal(row.submission.snapshot.result.truncated, true);
    assert.ok(row.submission.snapshot.result.text.length <= 16384);
    assert.match(row.submission.snapshot.result.sha256, /^[0-9a-f]{64}$/);
  }
});

test("snapshot and click rejection retain the original error and stage, without retry or follow-on input", async () => {
  for (const failure of ["snapshot", "click"]) {
    const row = {}, trace = [], originalError = Error(`original ${failure} timeout`);
    const current = {
      async domSnapshot() { trace.push("snapshot"); if (failure === "snapshot") throw originalError; return "button"; },
      locator() { return { async click() { trace.push("click"); throw originalError; } }; },
    };
    await assert.rejects(submitManagedFileWorkflowOriginal(current, { fixture: { kind: "root" } }, row), error => error === originalError);
    assert.deepEqual(trace, failure === "snapshot" ? ["snapshot"] : ["snapshot", "click"]);
    assert.ok(row.submission[failure].rejectedAt >= row.submission[failure].startedAt);
    assert.equal(row.submission[failure].resolvedAt, undefined);
    assert.match(row.submission[failure].error, new RegExp(`original ${failure} timeout`));
    if (failure === "snapshot") assert.equal(row.submission.click, undefined);
    else assert.equal(row.submission.snapshot.result.text, "button");
  }
});

test("explicit private diagnostics never become feature acceptance, even when every business step completes", () => {
  assert.deepEqual(managedFileChooserCompletion("workflow", true, true), { featurePassed: false, diagnosticCompleted: true });
  assert.deepEqual(managedFileChooserCompletion("workflow", true, false), { featurePassed: false, diagnosticCompleted: false });
  assert.deepEqual(managedFileChooserCompletion("workflow", false, true), { featurePassed: true, diagnosticCompleted: false });
  assert.deepEqual(managedFileChooserCompletion("baseline", false, true), { featurePassed: false, diagnosticCompleted: true });
  assert.throws(() => managedFileChooserCompletion("baseline", true, true));
});

function eventBus() {
  const listeners = new Set();
  return { addListener: fn => listeners.add(fn), removeListener: fn => listeners.delete(fn),
    emit: (...args) => { for (const fn of listeners) fn(...args); }, count: () => listeners.size };
}
const native = () => ({ sequence: 1, at: 110, source: { targetId: "root", tabId: 3 }, method: "Page.fileChooserOpened",
  params: { frameId: "root", backendNodeId: 7, mode: "selectSingle" } });
const options = () => ({ events: [native()], target: { id: "root", tabId: 3 }, frameId: "root", clickAt: 100,
  ui: { fileInputs: [], chooserStateKeys: [] }, inputReplies: [{ result: {} }] });

test("passive observer needs no native commands and records only bounded metadata", () => {
  const onEvent = eventBus(), onDetach = eventBus(), target = {};
  const chrome = { debugger: { onEvent, onDetach } };
  assert.equal(installManagedFileChooserObserver(chrome, target).interceptionEnabledByObserver, false);
  onEvent.emit({ tabId: 3 }, "Page.fileChooserOpened", { frameId: "f", mode: "selectSingle", backendNodeId: 7, unexpected: "never copy" });
  onEvent.emit({ tabId: 3 }, "Page.screencastFrame", { sessionId: 2, data: "never copy image base64" });
  onEvent.emit({ tabId: 3 }, "Runtime.consoleAPICalled", { args: ["never copy body"] });
  const result = target.__managedFileChooserDiagnostic.snapshot();
  assert.equal(result.events.length, 2); assert.deepEqual(result.events.map(row => row.sequence), [1, 2]);
  assert.deepEqual(result.events[1].params, { sessionId: 2 });
  assert.equal(JSON.stringify(result).includes("never copy"), false);
  result.events[0].params.frameId = "modified";
  assert.equal(target.__managedFileChooserDiagnostic.snapshot().events[0].params.frameId, "f");
  assert.equal(target.__managedFileChooserDiagnostic.stop().active, false);
  assert.equal(onEvent.count() + onDetach.count(), 0);
});

test("observer overflow is explicit and never presented as complete evidence", () => {
  const onEvent = eventBus(), onDetach = eventBus(), target = {};
  installManagedFileChooserObserver({ debugger: { onEvent, onDetach } }, target);
  for (let i = 0; i < 513; i++) onEvent.emit({ tabId: 3 }, "Page.fileChooserOpened", { frameId: "f", mode: "selectSingle" });
  const result = target.__managedFileChooserDiagnostic.stop();
  assert.equal(result.events.length, 512); assert.equal(result.overflow, true);
});
test("observer preserves original default context origin/frame/session metadata without scripts or context names", () => {
  const onEvent = eventBus(), onDetach = eventBus(), target = {};
  installManagedFileChooserObserver({ debugger: { onEvent, onDetach } }, target);
  const source = { targetId: "root", sessionId: "original-child" };
  onEvent.emit(source, "Runtime.executionContextCreated", { context: { id: 9, uniqueId: "original", origin: "https://child.example",
    name: "private context name", auxData: { frameId: "child", isDefault: true, type: "default", privateField: "no" } } });
  onEvent.emit(source, "Runtime.executionContextDestroyed", { executionContextId: 9, executionContextUniqueId: "original", secret: "no" });
  const rows = target.__managedFileChooserDiagnostic.stop().events;
  assert.deepEqual(rows[0].params, { context: { id: 9, uniqueId: "original", origin: "https://child.example", auxData: { frameId: "child", isDefault: true, type: "default" } } });
  assert.deepEqual(rows[0].source, source);
  assert.deepEqual(rows[1].params, { executionContextId: 9, executionContextUniqueId: "original" });
});

test("a current native chooser and absent UI establish missing channel, never feature success", () => {
  const result = classifyManagedFileChooserBaseline(options());
  assert.equal(result.outcome, "observed-native-chooser-without-upload-channel");
  assert.equal(result.missingChannelObserved, true); assert.equal(result.featurePassed, false);
});

test("no native event or only an earlier event is unproved, not a confirmed missing chooser", () => {
  for (const events of [[], [{ ...native(), at: 99 }]]) {
    const result = classifyManagedFileChooserBaseline({ ...options(), events });
    assert.equal(result.outcome, "native-chooser-unobserved"); assert.equal(result.missingChannelObserved, false);
  }
});

test("native pending and native error remain independent from chooser observation", () => {
  assert.equal(classifyManagedFileChooserBaseline({ ...options(), inputReplies: [{ pending: true }] }).inputOutcome, "native-input-pending-at-observation");
  assert.equal(classifyManagedFileChooserBaseline({ ...options(), inputReplies: [{ error: { code: "UNKNOWN" } }] }).inputOutcome, "native-input-error");
});

test("contradictory source, child session, replacement frame and repeated opening are rejected", () => {
  for (const mutate of [
    row => { row.source.tabId = 4; },
    row => { row.source.targetId = "other"; },
    row => { row.source.sessionId = "unproved-child"; },
    row => { row.params.frameId = "other"; },
    row => { row.params.backendNodeId = 0; },
    row => { row.params.mode = "selectMultiple"; },
  ]) { const row = native(); mutate(row); assert.throws(() => classifyManagedFileChooserBaseline({ ...options(), events: [row] })); }
  assert.throws(() => classifyManagedFileChooserBaseline({ ...options(), events: [native(), native()] }));
});

test("an existing chooser channel invalidates the old missing-channel baseline", () => {
  for (const ui of [{ fileInputs: [{ id: "file" }], chooserStateKeys: [] }, { fileInputs: [], chooserStateKeys: ["pendingFileChooser"] }])
    assert.throws(() => classifyManagedFileChooserBaseline({ ...options(), ui }));
});

const lease = { leaseId: "owned", generation: 2 };
const command = (action, sequence) => ({ operation: "humanInput", ...lease, sequence, input: { type: "pointer", action, button: "left" } });
test("one pointer gesture ledger has only original contiguous lease input", () => {
  assert.equal(assertManagedFileChooserLedger([command("move", 1), command("down", 2), command("up", 3)], lease).length, 3);
  for (const rows of [[command("down", 1)], [command("down", 1), command("up", 3)],
    [command("down", 1), command("up", 2), command("down", 3), command("up", 4)],
    [command("down", 1), { ...command("up", 2), generation: 3 }]])
    assert.throws(() => assertManagedFileChooserLedger(rows, lease));
});

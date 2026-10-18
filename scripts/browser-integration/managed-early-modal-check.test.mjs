import assert from "node:assert/strict";
import test from "node:test";
import { managedEarlyModalState, assertManagedEarlyModalPreparation, assertManagedEarlyModalOpening, summarizeManagedEarlyModalSetup } from "./managed-early-modal-check.mjs";

const identity = { targetId: "root", tabId: 7, url: "http://127.0.0.1:55000/source" };
const source = { targetId: "root" };
const context = { id: 1, uniqueId: "current-context", origin: "http://127.0.0.1:55000", auxData: { isDefault: true, frameId: "root" } };
function trace() {
  const rows = []; let serial = 0;
  const add = value => { const row = { sequence: rows.length + 1, at: rows.length + 100, ...value }; rows.push(row); return row; };
  const request = method => { const id = ++serial; add({ kind: "request", id, method, source, params: {} }); return id; };
  const dispatch = (id, method) => add({ kind: "dispatch", id, method, source, params: {} });
  const settle = (id, method, result = {}) => add({ kind: "settlement", id, method, status: "fulfilled", result });
  const command = (method, result = {}) => { const id = request(method); dispatch(id, method); settle(id, method, result); return id; };
  const native = (method, params, eventSource = source) => add({ kind: "native", source: eventSource, method, params });
  const attachId = command("attach"), pageEnableId = command("Page.enable");
  return { rows, add, request, dispatch, settle, command, native, attachId, pageEnableId };
}
function config(t, scenario = "cold-runtime") { return { ...identity, scenario, attachId: t.attachId, pageEnableId: t.pageEnableId }; }
function opening(t) { return t.native("Page.javascriptDialogOpening", { frameId: "root", type: "prompt", url: identity.url, message: "original" }); }
function warm(t) {
  const warmRuntimeId = t.command("Runtime.enable"); t.native("Runtime.executionContextCreated", { context });
  const start = managedEarlyModalState(t.rows, identity);
  const tree = { frameTree: { frame: { id: "root", url: identity.url, loaderId: "original-loader" } } };
  const firstId = t.command("Page.getFrameTree", tree), secondId = t.command("Page.getFrameTree", structuredClone(tree));
  const end = managedEarlyModalState(t.rows, identity);
  return { ...config(t, "warm-document"), warmRuntimeId, warmWindow: { start, end, firstId, secondId } };
}

test("cold proves current attach/Page ACK with no Runtime, context, start or frame", () => {
  const t = trace(), preGate = assertManagedEarlyModalPreparation(t.rows, config(t)); opening(t);
  assert.equal(assertManagedEarlyModalOpening(t.rows, { ...identity, message: "original", preGate, scenario: "cold-runtime" }).beforeFirstStartAndFrame, true);
});
test("cold rejects queued Runtime even before actual dispatch", () => { const t = trace(); t.request("Runtime.enable"); assert.throws(() => assertManagedEarlyModalPreparation(t.rows, config(t))); });
test("cold rejects observed default context even if later destroyed", () => { const t = trace(); t.native("Runtime.executionContextCreated", { context }); t.native("Runtime.executionContextDestroyed", { executionContextId: 1 }); assert.throws(() => assertManagedEarlyModalPreparation(t.rows, config(t))); });
test("old unowned context is recorded but gives no current attachment context", () => {
  const t = trace(); t.add({ kind: "unowned-native", source, method: "Runtime.executionContextCreated", params: { context } });
  assert.deepEqual(assertManagedEarlyModalPreparation(t.rows, config(t)).state.contexts, []);
});
for (const kind of ["queued-start", "actual-frame"]) test(`pre-gate refuses ${kind}`, () => {
  const t = trace(); if (kind === "queued-start") t.request("Page.startScreencast"); else t.add({ kind: "frame", source, method: "Page.screencastFrame", params: {} });
  assert.throws(() => assertManagedEarlyModalPreparation(t.rows, config(t)));
});
test("warm accepts matching actual double-tree under one current context/revision", () => {
  const t = trace(), c = warm(t), preGate = assertManagedEarlyModalPreparation(t.rows, c); opening(t);
  assert.deepEqual(assertManagedEarlyModalOpening(t.rows, { ...identity, message: "original", preGate, scenario: c.scenario }).currentContextAtOpening, [context]);
});
test("warm refuses altered original loader between two trees", () => {
  const t = trace(), c = warm(t); t.rows.find(row => row.id === c.warmWindow.secondId && row.kind === "settlement").result.frameTree.frame.loaderId = "replacement";
  assert.throws(() => assertManagedEarlyModalPreparation(t.rows, c));
});
test("warm refuses context replacement and equal-looking tree after revision changed", () => {
  const t = trace(), c = warm(t); t.native("Runtime.executionContextsCleared", {}); t.native("Runtime.executionContextCreated", { context: { ...context, uniqueId: "replacement" } });
  assert.throws(() => assertManagedEarlyModalPreparation(t.rows, c));
});
test("warm rejects an event inside the tree window even when current context is unchanged", () => {
  const t = trace(), c = warm(t); const insertion = t.rows.findIndex(row => row.id === c.warmWindow.secondId && row.kind === "request");
  t.rows.splice(insertion, 0, { kind: "native", source, method: "webNavigation.onHistoryStateUpdated", params: { tabId: 7 } }); t.rows.forEach((row, i) => row.sequence = i + 1);
  c.warmWindow.end = managedEarlyModalState(t.rows, identity);
  assert.throws(() => assertManagedEarlyModalPreparation(t.rows, c));
});
test("warm refuses fabricated window snapshot or missing current unique context", () => {
  const t = trace(), c = warm(t); c.warmWindow.start.revision++;
  assert.throws(() => assertManagedEarlyModalPreparation(t.rows, c));
  const v = trace(); const d = warm(v); v.native("Runtime.executionContextDestroyed", { executionContextUniqueId: context.uniqueId });
  assert.throws(() => assertManagedEarlyModalPreparation(v.rows, d));
});
test("metadata cannot substitute another tab/session/context origin", () => {
  for (const [eventSource, eventContext] of [[{ ...source, tabId: 8 }, context], [{ ...source, sessionId: "old" }, context], [source, { ...context, origin: "https://other.invalid" }]]) {
    const t = trace(); t.native("Runtime.executionContextCreated", { context: eventContext }, eventSource);
    assert.throws(() => managedEarlyModalState(t.rows, identity));
  }
});
test("Page.enable must have actual successful ACK after attach", () => {
  const t = trace(); t.rows.pop(); assert.throws(() => assertManagedEarlyModalPreparation(t.rows, config(t)));
  const v = trace(); v.rows.at(-1).status = "rejected"; assert.throws(() => assertManagedEarlyModalPreparation(v.rows, config(v)));
});
test("Opening cannot borrow marker, prior Page handler, or a late frame boundary", () => {
  const t = trace(), preGate = assertManagedEarlyModalPreparation(t.rows, config(t));
  assert.throws(() => assertManagedEarlyModalOpening(t.rows, { ...identity, message: "original", preGate, scenario: "cold-runtime" }));
  t.command("Page.startScreencast"); opening(t);
  assert.throws(() => assertManagedEarlyModalOpening(t.rows, { ...identity, message: "original", preGate, scenario: "cold-runtime" }));
});
test("document invalidation after gate cannot retain preparation proof", () => {
  const t = trace(), preGate = assertManagedEarlyModalPreparation(t.rows, config(t)); t.native("Page.frameNavigated", { frame: { id: "root" } }); opening(t);
  assert.throws(() => assertManagedEarlyModalOpening(t.rows, { ...identity, message: "original", preGate, scenario: "cold-runtime" }));
});
test("setup preserves pending promises and classifies actual late ACK by native sequence", () => {
  const t = trace(), opened = opening(t), runtime = t.request("Runtime.enable"); t.dispatch(runtime, "Runtime.enable");
  const tree = t.request("Page.getFrameTree"); t.dispatch(tree, "Page.getFrameTree");
  const start = t.command("Page.startScreencast");
  const before = summarizeManagedEarlyModalSetup(t.rows, [runtime, tree, start], { proved: true, opening: opened, closed: null });
  assert.equal(before.commands[0].settlementPhase, "pending-original-promise"); assert.equal(before.commands[2].settlementPhase, "while-original-modal-open");
  const closed = t.native("Page.javascriptDialogClosed", { frameId: "root", result: false }); t.settle(runtime, "Runtime.enable"); t.native("Runtime.executionContextCreated", { context });
  const after = summarizeManagedEarlyModalSetup(t.rows, [runtime, tree, start], { proved: true, opening: opened, closed });
  assert.equal(after.commands[0].settlementPhase, "after-original-Closed"); assert.equal(after.commands[1].settlementPhase, "pending-original-promise"); assert.equal(after.contexts[0].phase, "after-original-Closed");
});
test("trace gaps and observer errors cannot become complete preparation", () => {
  const t = trace(); t.rows.at(-1).sequence++; assert.throws(() => assertManagedEarlyModalPreparation(t.rows, config(t)));
  const v = trace(); v.add({ kind: "observer-error", error: "lost" }); assert.throws(() => assertManagedEarlyModalPreparation(v.rows, config(v)));
});

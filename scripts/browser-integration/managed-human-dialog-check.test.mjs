import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { projectHumanDialogCommand, assertManagedDialogNativePair, assertManagedDialogEnded } from "./managed-human-dialog-check.mjs";

const decision = { id: 7, operation: "humanDialogRespond", leaseId: "original-lease", generation: 3, dialogId: "original-dialog", accept: true };

test("dialog command observer preserves the exact original six-field scope", () => {
  assert.deepEqual(projectHumanDialogCommand(decision), decision);
  assert.deepEqual(projectHumanDialogCommand({ ...decision, accept: false }), { ...decision, accept: false });
});

test("prompt observation stores original UTF-8 length and hash, not content", () => {
  const promptText = "原始人工输入 中文π 🙂";
  const value = projectHumanDialogCommand({ ...decision, promptText });
  assert.equal(Object.hasOwn(value, "promptText"), false);
  assert.deepEqual(value, { ...decision, promptBytes: Buffer.byteLength(promptText), promptSHA256: createHash("sha256").update(promptText).digest("hex") });
});

test("dialog observer rejects extra fields, invalid scope, and invalid prompt bodies", () => {
  for (const extra of [{ id: 0 }, { generation: 0 }, { leaseId: "" }, { dialogId: "bad\n" }, { accept: 1 }, { extra: true }, { promptText: undefined }, { promptText: "\ud800" }, { promptText: "x".repeat(8193) }, { accept: false, promptText: "" }]) {
    assert.throws(() => projectHumanDialogCommand({ ...decision, ...extra }));
  }
  for (const key of Object.keys(decision)) { const value = { ...decision }; delete value[key]; assert.throws(() => projectHumanDialogCommand(value)); }
});

test("existing observer semantics still project ordinary human and viewer requests", () => {
  assert.deepEqual(projectHumanDialogCommand({ id: 8, operation: "humanEnd", leaseId: "original-lease" }), { id: 8, operation: "humanEnd", leaseId: "original-lease" });
  assert.deepEqual(projectHumanDialogCommand({ id: 9, operation: "status" }), { id: 9, operation: "status" });
});

function pair() {
  const original = { tabId: 71, target: { id: "original-root" } };
  const record = { endInstead: false, originalScope: { leaseId: "original-lease", generation: 3 }, pendingDialog: { dialogId: "original-dialog" },
    opening: { method: "Page.javascriptDialogOpening", sequence: 5, at: 1000, source: { targetId: "original-root" }, params: { frameId: "original-root" } },
    closed: { method: "Page.javascriptDialogClosed", sequence: 6, at: 1200, source: { targetId: "original-root" }, params: { frameId: "original-root" } } };
  return { original, record, decision: { ...decision, at: 1100 } };
}

test("native pair requires the original root source, ordered events, and actual sent decision", () => {
  const value = pair(); assert.equal(assertManagedDialogNativePair(value.record, value.original, value.decision).decisionDelayMs, 100);
  value.record.endInstead = true; assert.equal(assertManagedDialogNativePair(value.record, value.original, { operation: "humanEnd", leaseId: "original-lease", at: 1150 }).decisionDelayMs, 150);
});

test("native pair rejects conflicting or secondary sources, skipped events, stale decisions and late sends", () => {
  for (const mutate of [
    value => { value.record.opening.source.tabId = 72; },
    value => { value.record.opening.source.sessionId = "child-session"; },
    value => { value.record.opening.source.extensionId = "other-extension"; },
    value => { value.record.closed.source = { tabId: 71 }; },
    value => { value.record.closed.params.frameId = "child-frame"; },
    value => { value.record.closed.sequence = 7; },
    value => { value.record.closed.at = 1099; },
    value => { value.decision.dialogId = "successor"; },
    value => { value.decision.at = 999; },
    value => { value.decision.at = 6000; value.record.closed.at = 6001; },
  ]) { const value = pair(); mutate(value); assert.throws(() => assertManagedDialogNativePair(value.record, value.original, value.decision)); }
});

test("End receipt must release the exact original human lease", () => {
  const value = { human: null, pendingDialog: null, status: { state: "paused" }, viewerCleanupComplete: true, humanCleanup: { leaseId: "original-lease", cleanupConfirmed: true } };
  assertManagedDialogEnded(value, "original-lease");
  assert.throws(() => assertManagedDialogEnded(value, "successor"));
  assert.throws(() => assertManagedDialogEnded({ ...value, viewerCleanupComplete: false }, "original-lease"));
  assert.throws(() => assertManagedDialogEnded({ ...value, humanCleanup: { leaseId: "original-lease", cleanupConfirmed: false } }, "original-lease"));
});

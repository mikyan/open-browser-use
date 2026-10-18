import test from "node:test";
import assert from "node:assert/strict";
import { assertDialogBudgetHeld, readDialogBudgetSample, assertDialogBudgetSample, assertDialogBudgetNativePair, managedDialogBudgetCases, dialogBudgetLimits } from "./managed-human-dialog-budget-check.mjs";
import { managedDialogUnicode } from "./managed-dialog-fixture.mjs";

const pending = { leaseId: "original", generation: 1, dialogId: "original-dialog", type: "prompt", message: "original prompt", defaultPrompt: "default" };
function fixture() {
  const business = { target: { id: "original-root" } };
  const record = { originalScope: { leaseId: "original", generation: 1 }, pendingDialog: pending,
    opening: { method: "Page.javascriptDialogOpening", source: { targetId: "original-root" }, params: { frameId: "original-root" }, at: 1000, sequence: 1 },
    closed: { method: "Page.javascriptDialogClosed", source: { targetId: "original-root" }, params: { frameId: "original-root", result: true, userInput: managedDialogUnicode }, at: 41100, sequence: 2 },
    request: { operation: "humanDialogRespond", leaseId: "original", generation: 1, dialogId: "original-dialog", at: 41000 } };
  const sample = { at: 41000, completedAt: 41000, human: { state: "active", leaseId: "original", generation: 1 }, pendingDialog: pending, triggerResponse: null, nativeClosed: null, dialogVisible: true };
  return { business, record, sample };
}

test("finite fixture modes separate old cancellation from delayed success and native cap", () => {
  assert.deepEqual(managedDialogBudgetCases("old-cap-diagnostic"), [[{ id: "prompt-old-cap", type: "prompt", answer: null }]]);
  assert.equal(managedDialogBudgetCases("acceptance").length, 2);
  assert.equal(managedDialogBudgetCases("acceptance")[0][0].answer, managedDialogUnicode);
  assert.equal(managedDialogBudgetCases("acceptance")[1][0].answer, null);
  assert.throws(() => managedDialogBudgetCases("retry"));
  assert.deepEqual(dialogBudgetLimits, { deliberateMs: 40000, capMs: 300000, capObservationMs: 340000, capEarliestCloseMs: 299750, capLatestCloseMs: 305000 });
});

test("forty-second sample preserves original active tuple and a pending native input", () => {
  const { sample, record } = fixture(); assertDialogBudgetHeld(sample, record);
  for (const extra of [{ human: null }, { human: { ...sample.human, generation: 2 } }, { pendingDialog: { ...pending, dialogId: "successor" } }, { triggerResponse: { result: { inputReceipt: { acknowledged: true } } } }, { triggerResponse: { error: { code: "OPERATION_UNCONFIRMED" } } }, { nativeClosed: {} }, { dialogVisible: false }]) assert.throws(() => assertDialogBudgetHeld({ ...sample, ...extra }, record));
});

test("delayed decision uses its actual outgoing request and exact original source", () => {
  const { business, record } = fixture(); assert.equal(assertDialogBudgetNativePair(record, business, "deliberate").elapsedMs, 40100);
  assert.throws(() => assertDialogBudgetNativePair({ ...record, request: { ...record.request, at: 40999 } }, business, "deliberate"));
  assert.throws(() => assertDialogBudgetNativePair({ ...record, opening: { ...record.opening, source: { targetId: "original-root", sessionId: "child" } } }, business, "deliberate"));
  assert.throws(() => assertDialogBudgetNativePair({ ...record, closed: { ...record.closed, sequence: 3 } }, business, "deliberate"));
  for (const wrong of [{ leaseId: "successor" }, { generation: 2 }, { dialogId: "other-dialog" }]) assert.throws(() => assertDialogBudgetNativePair({ ...record, request: { ...record.request, ...wrong } }, business, "deliberate"));
});

test("terminal sampling uses the same passive-listener boundary as the native pair", () => {
  const { sample, record } = fixture();
  const terminal = { ...sample, human: null, pendingDialog: null, nativeClosed: null, dialogVisible: false };
  const interval = elapsed => ({ at: record.opening.at + elapsed, completedAt: record.opening.at + elapsed });
  assert.equal(assertDialogBudgetSample({ ...sample, ...interval(299749) }, record, "cap"), true);
  assert.throws(() => assertDialogBudgetSample({ ...terminal, ...interval(299749) }, record, "cap"));
  for (const elapsed of [299750, 299999, 300000]) assert.equal(assertDialogBudgetSample({ ...terminal, ...interval(elapsed) }, record, "cap"), false);
  assert.throws(() => assertDialogBudgetSample({ ...terminal, ...interval(39999) }, record, "deliberate"));
  assert.equal(assertDialogBudgetSample({ ...sample, ...interval(40000) }, record, "deliberate"), false);
  assert.equal(assertDialogBudgetSample(terminal, record, "old-cap-diagnostic"), false);
});

test("sample captures events after awaited UI reads without treating a crossing interval as early closure", async () => {
  const { sample: active, record } = fixture();
  let status = { human: active.human, pendingDialog: pending }, triggerResponse = null, nativeClosed = null;
  let clock = record.opening.at + 299740;
  const sample = await readDialogBudgetSample({ readStatus: () => status, readTriggerResponse: () => triggerResponse, readNativeClosed: () => nativeClosed,
    now: () => clock,
    readDialogVisible: async () => { clock += 20; return false; },
    readViewerInput: async () => {
      status = { human: null, pendingDialog: null }; clock += 5;
      nativeClosed = { ...record.closed, at: record.opening.at + 299755, params: { ...record.closed.params, result: false, userInput: "" } };
      triggerResponse = { at: clock, error: { code: "OPERATION_UNCONFIRMED" } }; return "false";
    } });
  assert.equal(sample.at - record.opening.at, 299740); assert.equal(sample.completedAt - record.opening.at, 299765);
  assert.equal(sample.human, null); assert.equal(sample.nativeClosed, nativeClosed); assert.equal(sample.triggerResponse, triggerResponse);
  assert.equal(assertDialogBudgetSample(sample, record, "cap"), false);
  const { request, ...unanswered } = record;
  assert.equal(assertDialogBudgetNativePair({ ...unanswered, closed: nativeClosed }, fixture().business, "cap").elapsedMs, 299755);
});

test("late sample completion cannot excuse an actually early native cancellation or invent missing legacy timestamps", () => {
  const { sample, record, business } = fixture(); const { request, ...unanswered } = record;
  const closed = { ...record.closed, at: record.opening.at + 299749, params: { ...record.closed.params, result: false, userInput: "" } };
  const terminal = { ...sample, at: record.opening.at + 299740, completedAt: record.opening.at + 299765, human: null, nativeClosed: closed, dialogVisible: false };
  assert.throws(() => assertDialogBudgetSample(terminal, record, "cap"));
  assert.throws(() => assertDialogBudgetNativePair({ ...unanswered, closed }, business, "cap"));
  assert.throws(() => assertDialogBudgetSample({ ...sample, completedAt: undefined }, record, "cap"), /legacy samples cannot be retrofitted/);
  assert.throws(() => assertDialogBudgetSample({ ...sample, completedAt: sample.at - 1 }, record, "cap"));
});

test("native cap cannot be replaced with the old deadline or the outer fallback", () => {
  const { business, record } = fixture(); delete record.request; record.closed.params = { frameId: "original-root", result: false, userInput: "" }; record.closed.at = record.opening.at + 300020;
  assert.equal(assertDialogBudgetNativePair(record, business, "cap").elapsedMs, 300020);
  for (const duration of [299750, 299999, 304999]) assert.equal(assertDialogBudgetNativePair({ ...record, closed: { ...record.closed, at: record.opening.at + duration } }, business, "cap").elapsedMs, duration);
  for (const duration of [29999, 299749, 305000, 335000]) assert.throws(() => assertDialogBudgetNativePair({ ...record, closed: { ...record.closed, at: record.opening.at + duration } }, business, "cap"));
  record.closed.at = record.opening.at + 30001; assert.equal(assertDialogBudgetNativePair(record, business, "old-cap-diagnostic").elapsedMs, 30001);
  assert.throws(() => assertDialogBudgetNativePair({ ...record, request: { operation: "humanEnd", at: 31000 } }, business, "cap"));
});

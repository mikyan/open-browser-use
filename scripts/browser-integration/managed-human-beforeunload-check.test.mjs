import assert from "node:assert/strict";
import test from "node:test";
import { assertManagedHumanDialogScenario, managedDialogScenarioOutcome } from "./managed-human-dialog-check.mjs";
import { createManagedBeforeunloadScenario, runManagedBeforeunloadDiagnostic, summarizeManagedBeforeunloadTrace, assertBeforeunloadStayed, assertBeforeunloadReceipt, assertBeforeunloadDecodedFrame, collectManagedBeforeunloadInputs, assertBeforeunloadDecision } from "./managed-human-beforeunload-check.mjs";
import { beforeunloadDraft } from "./managed-human-beforeunload-fixture.mjs";

test("existing dialog mode stays default and the one scenario seam requires an instrumented beforeunload contract", () => {
  assertManagedHumanDialogScenario(undefined); const scenario = createManagedBeforeunloadScenario(); assertManagedHumanDialogScenario(scenario);
  assert.equal(scenario.fixtures.length, 1);
  assert.equal(scenario.fixtures[0].variant, "root-anchor");
  const child = createManagedBeforeunloadScenario({ variant: "child-navigates-parent" }); assertManagedHumanDialogScenario(child);
  assert.equal(child.fixtures[0].variant, "child-navigates-parent"); assert.notEqual(child.measureButton, scenario.measureButton);
  for (const replacement of [{ kind: "acceptance" }, { instrumented: false }, { fixtures: [] }, { observerExpression: "arbitrary" }, { run: null }]) assert.throws(() => assertManagedHumanDialogScenario({ ...scenario, ...replacement }));
});

test("formal opt-in uses only a passive observer and completion cannot turn a diagnostic into acceptance", () => {
  for (const variant of ["root-anchor", "child-navigates-parent"]) {
    const formal = createManagedBeforeunloadScenario({ variant, acceptance: true }); assertManagedHumanDialogScenario(formal);
    assert.equal(formal.instrumented, false); assert.equal(formal.observerExpression, "__managedBeforeunloadObservation");
    assert.equal(managedDialogScenarioOutcome(formal, true, true).featurePassed, true);
    assert.equal(managedDialogScenarioOutcome(formal, true, false).featurePassed, false);
    assert.equal(managedDialogScenarioOutcome(formal, false, true).featurePassed, false);
    assert.equal(managedDialogScenarioOutcome(createManagedBeforeunloadScenario({ variant }), true, true).featurePassed, false);
  }
  assert.throws(() => createManagedBeforeunloadScenario({ acceptance: "true" }));
  assert.equal(managedDialogScenarioOutcome(undefined, true).featurePassed, true);
});

test("Stay requires the original document and draft, a trusted beforeunload and no premature navigation or POST", () => {
  const before = { documentId: "original", state: { documentToken: "token", workflowId: "flow" } };
  const after = { ...before, frameId: 0, draft: "edited original", state: { ...before.state, phase: "draft", error: null, eventOverflow: false, beforeunloads: [{ trusted: true, hasBeenActive: true }] } };
  assertBeforeunloadStayed(before, after, after.draft, { requests: [{ method: "GET", path: "/draft" }] });
  for (const patch of [{ documentId: "replacement" }, { draft: "lost edit" }, { state: { ...after.state, beforeunloads: [{ trusted: false, hasBeenActive: true }] } }])
    assert.throws(() => assertBeforeunloadStayed(before, { ...after, ...patch }, after.draft, { requests: [] }));
  for (const request of [{ method: "GET", path: "/flow/review" }, { method: "POST", path: "/flow/receipt" }])
    assert.throws(() => assertBeforeunloadStayed(before, after, after.draft, { requests: [request] }));
});

test("receipt requires the real successor document, one trusted commit and original POST response bytes", () => {
  const original = { documentId: "original", state: { documentToken: "old" } }, destination = { documentId: "new", state: { documentToken: "new-token" } };
  const receipt = { ok: true, workflowId: "flow", documentToken: "new-token", originalToken: "old", submitCount: 1 };
  const body = { workflowId: "flow", documentToken: "new-token", originalToken: "old", postAttempts: 1, clicks: [{ trusted: true, button: 0 }] };
  const after = { documentId: "new", state: { ...body, phase: "committed", error: null }, result: receipt };
  const fixture = { overflow: false, attempted: true, workflowId: "flow", receipt, requests: [{ method: "POST", status: 200, finished: true, aborted: false,
    body: { base64: Buffer.from(JSON.stringify(body)).toString("base64") }, response: { base64: Buffer.from(JSON.stringify(receipt)).toString("base64") } }] };
  assertBeforeunloadReceipt(fixture, original, destination, after);
  assert.throws(() => assertBeforeunloadReceipt({ ...fixture, requests: [...fixture.requests, ...fixture.requests] }, original, destination, after));
  assert.throws(() => assertBeforeunloadReceipt(fixture, original, { ...destination, documentId: "original" }, after));
  assert.throws(() => assertBeforeunloadReceipt(fixture, original, destination, { ...after, documentId: "replacement" }));
  assert.throws(() => assertBeforeunloadReceipt(fixture, original, destination, { ...after, result: { ...receipt, submitCount: 2 } }));
  assert.throws(() => assertBeforeunloadReceipt({ ...fixture, requests: [{ ...fixture.requests[0], aborted: true }] }, original, destination, after));
});

test("accepted successor pixels require the exact decoded native PNG, current lease and a strictly newer generation", () => {
  const frame = { controlMode: "human", humanLeaseId: "lease", generation: 3, streamId: "stream", sequence: 1, width: 640, height: 480, file: "native-frame-0012.png", sha256: "a".repeat(64), at: 200, bytes: 400 };
  const image = { hidden: false, complete: true, controlMode: "human", humanLeaseId: "lease", generation: "3", streamId: "stream", frameSequence: "1", width: 640, height: 480 };
  assertBeforeunloadDecodedFrame({ image, frame }, "lease", 2, 199);
  for (const patch of [{ streamId: "other" }, { frameSequence: "2" }, { generation: "2" }, { width: 1 }, { complete: false }, { humanLeaseId: "old" }])
    assert.throws(() => assertBeforeunloadDecodedFrame({ image: { ...image, ...patch }, frame }, "lease", 2, 199));
  for (const patch of [{ file: undefined }, { at: 198 }, { sha256: "metadata only" }])
    assert.throws(() => assertBeforeunloadDecodedFrame({ image, frame: { ...frame, ...patch } }, "lease", 2, 199));
  assert.throws(() => assertBeforeunloadDecodedFrame({ image, frame }, "lease", 3, 199));
});

test("input evidence waits for unsent viewer transitions and every original ACK before completing a gesture", async () => {
  const report = { viewerCommands: [], viewerMessages: [] }, stages = []; let pending = "3";
  const request = sequence => ({ id: sequence, operation: "humanInput", leaseId: "lease", generation: 2, sequence, input: { type: "pointer", action: ["move", "down", "up"][sequence - 1] } });
  const ack = sequence => ({ type: "response", id: sequence, result: { inputReceipt: { leaseId: "lease", generation: 2, sequence, acknowledged: true } } });
  const context = { report, start: 0, label: "click", leaseId: "lease", generation: 2, state: () => ({ human: { leaseId: "lease", generation: 2 } }),
    page: { locator: () => ({ getAttribute: async name => name === "data-pending" ? pending : "3" }) },
    wait: async (read, label) => {
      let result = await read();
      if (label.endsWith("outgoing input")) { assert.equal(result, undefined); report.viewerCommands.push(request(1)); stages.push("first outgoing"); }
      else if (label.endsWith("queue settled")) {
        assert.equal(result, false); report.viewerCommands.push(request(2), request(3)); report.viewerMessages.push(ack(1), ack(2)); pending = "0"; stages.push("all transitions sent");
      } else if (!result) { report.viewerMessages.push(ack(3)); stages.push("last original ACK"); }
      result = await read(); assert.ok(result); return result;
    } };
  const receipts = await collectManagedBeforeunloadInputs(context);
  assert.deepEqual(receipts.map(row => row.request.sequence), [1, 2, 3]);
  assert.deepEqual(stages, ["first outgoing", "all transitions sent", "last original ACK"]);
});

test("a pending modal queue cannot be called complete, and a new generation never substitutes for the original receipt", async () => {
  const request = { id: 9, operation: "humanInput", leaseId: "lease", generation: 2, sequence: 4, input: { type: "pointer", action: "up" } };
  const reply = { type: "response", id: 9, result: { inputReceipt: { leaseId: "lease", generation: 2, sequence: 4, acknowledged: true } } };
  const report = { viewerCommands: [request], viewerMessages: [reply] }; let pending = "1";
  const context = { report, start: 0, label: "Leave", leaseId: "lease", generation: 2, state: () => ({ human: { leaseId: "lease", generation: 3 } }),
    page: { locator: () => ({ getAttribute: async name => name === "data-pending" ? pending : "0" }) },
    wait: async (read, label) => { const result = await read(); if (!result) throw Error(label); return result; } };
  await assert.rejects(collectManagedBeforeunloadInputs(context), /input queue settled/);
  pending = "0"; assert.equal((await collectManagedBeforeunloadInputs(context))[0].response, reply);
  report.viewerMessages = []; await assert.rejects(collectManagedBeforeunloadInputs(context), /original input ACK/);
  report.viewerMessages = [{ ...reply, error: { code: "OPERATION_UNCONFIRMED" } }];
  await assert.rejects(collectManagedBeforeunloadInputs(context), /OPERATION_UNCONFIRMED/);
});

test("native close may precede the later framesent observation timestamp while the original sequence and exact receipt still bind the decision", () => {
  const pending = { leaseId: "lease", generation: 2, dialogId: "dialog" }, source = { targetId: "root" };
  const request = { id: 28, operation: "humanDialogRespond", ...pending, accept: true, at: 1792535090107 };
  const reply = { dialogReceipt: { ...pending, acknowledged: true } };
  const decision = { accept: true, pending, request, reply,
    opening: { sequence: 6, method: "Page.javascriptDialogOpening", source, at: 1792535089954, params: { type: "beforeunload", frameId: "root" } },
    closed: { sequence: 7, method: "Page.javascriptDialogClosed", source, at: 1792535090106, params: { frameId: "root", result: true } } };
  const value = { decision, original: { tabId: 7, target: { id: "root" } }, requests: [request], responses: [{ id: 28, type: "response", result: reply, at: 1792535090148 }] };
  const proof = assertBeforeunloadDecision(value); assert.equal(proof.timing.closedWorkerAt, proof.timing.requestObservedAt - 1);
  assert.equal(proof.closedSequence, 7); assert.equal(proof.requestId, 28);
  for (const patch of [{ sequence: 5 }, { source: { targetId: "different" } }, { source: { targetId: "root", sessionId: "child" } },
    { params: { frameId: "different", result: true } }, { params: { frameId: "root", result: false } }])
    assert.throws(() => assertBeforeunloadDecision({ ...value, decision: { ...decision, closed: { ...decision.closed, ...patch } } }));
  for (const patch of [{ leaseId: "old" }, { generation: 1 }, { dialogId: "other" }, { acknowledged: false }]) {
    const wrong = { dialogReceipt: { ...reply.dialogReceipt, ...patch } };
    assert.throws(() => assertBeforeunloadDecision({ ...value, decision: { ...decision, reply: wrong }, responses: [{ ...value.responses[0], result: wrong }] }));
  }
  assert.throws(() => assertBeforeunloadDecision({ ...value, requests: [request, { ...request, id: 29 }] }));
  assert.throws(() => assertBeforeunloadDecision({ ...value, responses: [] }));
  assert.throws(() => assertBeforeunloadDecision({ ...value, responses: [{ ...value.responses[0], id: 29 }] }));
  assert.throws(() => assertBeforeunloadDecision({ ...value, responses: [...value.responses, ...value.responses] }));
});

test("ordering summary distinguishes original native send/ACK, web events and dialog close without inventing causality", () => {
  const source = { tabId: 7 }, original = { tabId: 7, target: { id: "target" } };
  const records = [
    { sequence: 1, kind: "send", source, method: "Input.dispatchMouseEvent" },
    { sequence: 2, kind: "webNavigation", source, method: "onBeforeNavigate" },
    { sequence: 3, kind: "event", source, method: "Page.javascriptDialogOpening" },
    { sequence: 4, kind: "event", source, method: "Page.javascriptDialogClosed" },
    { sequence: 5, kind: "resolved", source, method: "Input.dispatchMouseEvent" },
  ];
  const summary = summarizeManagedBeforeunloadTrace(records, original);
  assert.deepEqual(summary.ordering, records); assert.deepEqual(summary.openingSequences, [3]); assert.deepEqual(summary.closedSequences, [4]);
  assert.throws(() => summarizeManagedBeforeunloadTrace([records[1], records[0]], original));
  assert.deepEqual(summarizeManagedBeforeunloadTrace(records, { tabId: 8, target: { id: "other" } }).ordering, []);
});

test("missing production Stay UI preserves original failed observation and never answers, navigates or clicks again", async () => {
  const before = { documentId: "document", state: { documentToken: "token", clicks: [], beforeunloads: [] }, draft: beforeunloadDraft };
  const report = { viewerCommands: [], viewerMessages: [] }, native = [], calls = [];
  const source = { targetId: "target" }, viewState = { human: { leaseId: "lease", generation: 1, viewport: { width: 600, height: 400 } }, pendingDialog: null };
  const originalError = new Error("original beforeunload Stay decision must reach the viewer");
  const context = {
    report, business: { before, tabId: 7, target: { id: "target" } }, state: () => viewState,
    fixture: { paths: { destination: "/review" }, stats: () => ({ requests: [] }) },
    decodedHuman: async () => ({ image: { width: 600, height: 400 } }), readDocument: async () => before,
    measureButton: async () => ({ clickable: true, rect: { x: 20, y: 180, width: 200, height: 40 } }),
    nativeEvents: () => native,
    worker: { evaluate: async () => ({ records: native, pending: [] }) },
    page: { locator: () => ({ boundingBox: async () => ({ x: 10, y: 50, width: 600, height: 400 }), isVisible: async () => false }),
      mouse: { click: async () => { calls.push("click"); native.push({ sequence: 1, kind: "event", source, method: "Page.javascriptDialogOpening", params: { type: "beforeunload" } },
        { sequence: 2, kind: "event", source, method: "Page.javascriptDialogClosed", params: { result: true } }); } } },
    wait: async (read, label) => { const value = await read(); if (value) return value; assert.equal(label, originalError.message); throw originalError; },
    uiAction: async () => { calls.push("answer"); throw Error("must not be called"); },
    uiObservation: async () => ({ pendingDialog: null }), screenshot: async () => ({ file: "original.png" }), save: async () => { calls.push("save"); },
  };
  await assert.rejects(runManagedBeforeunloadDiagnostic(context), error => error === originalError);
  assert.deepEqual(calls, ["click", "save"]); assert.equal(report.beforeunload.gestureCount, 1);
  assert.equal(report.beforeunload.native.length, 2); assert.equal(report.beforeunload.finalScreenshot.file, "original.png");
  assert.equal(report.beforeunload.traceSnapshot.pending.length, 0); assert.equal(report.beforeunload.userCouldStay, undefined);
});

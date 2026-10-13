import assert from "node:assert/strict";
import { checkDialogReceipt, checkDialogResult, dialogCases, dialogLayouts, dialogMessage } from "./dialog-fixture.mjs";

const openingMethod = "Page.javascriptDialogOpening", closedMethod = "Page.javascriptDialogClosed", commandMethod = "Page.handleJavaScriptDialog";
const object = value => value !== null && typeof value === "object" && !Array.isArray(value);
const own = (value, key) => Object.hasOwn(value, key);
function targetKey(target) {
  assert.ok(object(target) && Number.isSafeInteger(target.tabId) && target.tabId >= 0, "Native tab identity required");
  if (own(target, "sessionId")) assert.ok(typeof target.sessionId === "string" && target.sessionId, "Invalid native child session");
  return JSON.stringify([target.tabId, target.sessionId ?? ""]);
}

// Sequence is captured synchronously by the passive observer. ACK timestamps do
// not order events: Chrome may close a dialog before its command Promise settles.
function nativeTransactions(evidence, tabIds) {
  assert.ok(object(evidence) && Array.isArray(evidence.events) && Array.isArray(evidence.commands), "Original native evidence required");
  assert.equal(evidence.overflow, false, "Truncated native evidence cannot prove a single response");
  const rows = [];
  for (const [kind, values] of [["event", evidence.events], ["command", evidence.commands]]) {
    let previous = 0;
    for (const row of values) {
      assert.ok(object(row) && Number.isSafeInteger(row.sequence) && row.sequence > previous, "Original native sequence is invalid");
      previous = row.sequence;
      assert.ok(Number.isSafeInteger(row.at) && row.at > 0, "Native timestamp required");
      const target = kind === "command" ? row.target : row.source, key = targetKey(target);
      assert.ok(tabIds.has(target.tabId), "Unexpected tab in native dialog evidence");
      rows.push({ kind, row, target, key });
    }
  }
  rows.sort((a, b) => a.row.sequence - b.row.sequence);
  const live = new Map(), completed = [];
  for (const [index, { kind, row, target, key }] of rows.entries()) {
    assert.equal(row.sequence, index + 1, "Missing or duplicate original native evidence");
    assert.ok(object(row.params), "Original native parameters required");
    if (kind === "event" && row.method === openingMethod) {
      assert.ok(!live.has(key), "A second opening replaced an unclosed dialog");
      live.set(key, { target, opening: row });
    } else if (kind === "command") {
      assert.equal(row.method, commandMethod);
      const transaction = live.get(key); assert.ok(transaction, "Native response has no original opening on this target");
      assert.equal(transaction.command, undefined, "The original dialog received more than one native response");
      assert.equal(own(row, "error"), false, "Native command rejected or threw");
      assert.equal(own(row, "ack"), true, "Original native ACK is missing"); assert.deepEqual(row.ack, {});
      assert.ok(Number.isSafeInteger(row.settledAt) && row.settledAt >= row.at, "Original command settlement required");
      transaction.command = row;
    } else {
      assert.equal(row.method, closedMethod, "Unexpected native dialog event");
      const transaction = live.get(key); assert.ok(transaction?.command, "Native close has no original response on this target");
      transaction.closed = row; completed.push(transaction); live.delete(key);
    }
  }
  assert.equal(live.size, 0, "Original dialog has no native closed event");
  return completed.sort((a, b) => a.opening.sequence - b.opening.sequence);
}

function documentFor(server, layout) {
  assert.ok(object(server) && Array.isArray(server.documents) && Array.isArray(server.posts));
  const controls = server.documents.filter(document => document.controls === true);
  assert.equal(controls.length, 1, "Exactly one original control document is required");
  const document = controls[0];
  assert.equal(document.layout, layout); assert.ok(typeof document.token === "string" && document.token);
  assert.ok(typeof document.href === "string" && document.href);
  return document;
}
function receipt(received, expected) {
  assert.ok(received && typeof received.bodyBase64 === "string");
  assert.equal(Buffer.from(received.bodyBase64, "base64").toString("base64"), received.bodyBase64, "Receipt bytes must use canonical base64");
  assert.equal(received.path, "/native-dialogs/result?" + new URLSearchParams({ key: expected.key }));
  checkDialogReceipt(received, expected);
}
function matchNative(transaction, expected, item, document) {
  assert.ok(transaction, "Expected native dialog is missing");
  const { opening, command, closed, target } = transaction, params = opening.params;
  assert.equal(target.tabId, item.tabId);
  assert.ok(typeof params.frameId === "string" && params.frameId, "Original native dialog frame identity required");
  assert.equal(closed.params.frameId, params.frameId, "Native opening and close must belong to the same original frame");
  if (item.layout !== "root") {
    // In run-5tMxBX, Chrome routed OOPIF dialogs through the root CDP target;
    // the original child is identified by the event's frameId, not by an
    // invented child session on that event. The independent attach witness
    // binds this frame to this tab, while getTargets proves its current URL.
    assert.ok(Array.isArray(item.oopifTargets) && Array.isArray(item.targets), "Original native OOPIF witnesses required");
    const attached = item.oopifTargets.filter(value => value.tabId === item.tabId && value.source?.tabId === item.tabId && value.type === "iframe" && value.targetId === params.frameId);
    assert.ok(attached.length > 0, "Original dialog frame has no OOPIF attach witness on this tab");
    assert.ok(attached.every(value => typeof value.sessionId === "string" && value.sessionId), "Native OOPIF attachment session required");
    if (target.sessionId !== undefined) assert.ok(attached.some(value => value.sessionId === target.sessionId), "Dialog child session differs from the original OOPIF attachment");
    const current = item.targets.filter(value => value.id === params.frameId);
    assert.equal(current.length, 1, "Original OOPIF target is missing or ambiguous");
    assert.equal(current[0].url, document.href); assert.equal(current[0].attached, true);
    assert.ok(["other", "iframe"].includes(current[0].type), "Original child must be a native non-page target");
  }
  assert.equal(params.type, expected.type); assert.equal(params.message, expected.message);
  assert.equal(params.url, document.href, "Native dialog URL must be the original control document");
  if (expected.type === "prompt") assert.equal(params.defaultPrompt, "original default");
  else assert.ok(params.defaultPrompt === undefined || params.defaultPrompt === "", "Unexpected native default prompt");
  const nativeDecision = { accept: expected.accept };
  if (expected.type === "prompt" && expected.accept) nativeDecision.promptText = expected.promptText ?? "";
  assert.deepEqual(command.params, nativeDecision, "Native response differs from the exact original decision");
  assert.equal(closed.params.result, expected.accept, "Native closed result differs from the response");
  if (expected.type === "prompt" && expected.accept) assert.equal(closed.params.userInput, nativeDecision.promptText);
  else assert.ok(closed.params.userInput === undefined || closed.params.userInput === "", "Unexpected native user input");
  return { tabId: item.tabId, sessionId: target.sessionId ?? null, frameId: params.frameId, type: expected.type, message: expected.message,
    role: expected.role, dialogId: expected.dialogId ?? null, openingSequence: opening.sequence,
    commandSequence: command.sequence, closedSequence: closed.sequence, commandSettledAt: command.settledAt };
}

/** Verify original native transactions against the fixture's SDK and HTTP results. */
export function checkDialogEvidence(detail, { lifecycle = false, beforeunload = false } = {}) {
  assert.ok(object(detail) && Array.isArray(detail.variants));
  assert.deepEqual(detail.variants.map(item => item.layout), lifecycle ? ["root"] : dialogLayouts);
  const ids = detail.variants.map(item => item.tabId); assert.equal(new Set(ids).size, ids.length);
  const transactions = nativeTransactions(detail.nativeEvidence, new Set(ids)), proof = [], dialogIds = new Set();
  const identify = id => { assert.ok(typeof id === "string" && id && !dialogIds.has(id), "Original ready IDs must be nonempty and distinct"); dialogIds.add(id); };
  if (lifecycle) {
    const item = detail.variants[0], key = item.key, document = documentFor(detail.server, "root");
    assert.equal(key, "js-dialog-lifecycle"); assert.equal(detail.server.posts.length, 3);
    for (const name of ["cancelled", "expired", ...(beforeunload ? ["beforeunload"] : []), "ended"]) identify(detail[name]?.dialogId);
    if (beforeunload) {
      assert.deepEqual(detail.beforeunload.original, { token: document.token, href: document.href });
      const before = detail.beforeunload.result;
      assert.ok(object(before) && typeof before.message === "string");
      assert.deepEqual(before, { type: "beforeunload", message: before.message, defaultValue: "", accepted: false });
    } else assert.equal(own(detail, "beforeunload"), false, "Beforeunload evidence requires the explicit diagnostic option");
    for (let index = 0; index < 3; index++) receipt(detail.server.posts[index], { key, type: "confirm", answer: false, sequence: index + 1, document });
    const expected = [
      { type: "confirm", message: dialogMessage(key, "confirm"), accept: false, role: "after-cancel" },
      { type: "confirm", message: dialogMessage(key, "confirm"), accept: false, role: "after-expiry" },
      ...(beforeunload ? [{ type: "beforeunload", message: detail.beforeunload.result.message, accept: false, role: "beforeunload", dialogId: detail.beforeunload.dialogId }] : []),
      { type: "confirm", message: dialogMessage(key, "confirm"), accept: false, role: "after-turn-end" }
    ];
    assert.equal(transactions.length, expected.length);
    expected.forEach((value, index) => proof.push(matchNative(transactions[index], value, item, document)));
  } else {
    for (const item of detail.variants) {
      assert.equal(item.key, `${detail.keyPrefix ?? detail.caller}-dialogs-${item.layout}`);
      const document = documentFor(item.server, item.layout), expected = [];
      assert.equal(item.decisions.length, dialogCases.length); assert.equal(item.server.posts.length, dialogCases.length + 1);
      for (const [index, selected] of dialogCases.entries()) {
        const decision = { ...selected.decision, message: dialogMessage(item.key, selected.decision.type) }, actual = item.decisions[index];
        identify(actual.dialogId); assert.deepEqual(actual.decision, decision);
        assert.ok(Number.isFinite(actual.remainingMs) && actual.remainingMs > 0 && actual.remainingMs <= 10000);
        checkDialogResult(actual.result, decision, item.key);
        receipt(item.server.posts[index], { key: item.key, type: selected.action, answer: selected.answer, sequence: index + 1, document });
        if (selected.action === "sequence") expected.push({ type: "alert", message: `unmatched: ${item.key}`, accept: false, role: "unmatched-default" });
        expected.push({ ...decision, role: "explicit", dialogId: actual.dialogId });
      }
      receipt(item.server.posts[dialogCases.length], { key: item.key, type: "confirm", answer: false, sequence: dialogCases.length + 1, document });
      expected.push({ type: "confirm", message: dialogMessage(item.key, "confirm"), accept: false, role: "unarmed-default" });
      const original = transactions.filter(value => value.target.tabId === item.tabId);
      assert.equal(original.length, expected.length, "Native transactions must match every original fixture action exactly once");
      expected.forEach((value, index) => proof.push(matchNative(original[index], value, item, document)));
    }
  }
  return { passed: true, transactions: proof, openingCount: transactions.length, commandCount: detail.nativeEvidence.commands.length,
    boundary: "Exact original target/session and opening/closed frame identity, response parameters, native ACK, closed result and HTTP bytes. OOPIF identity uses independent native attach and current target witnesses; dialogs may route through the root target. Native dialog IDs do not exist in CDP; SDK IDs label the matching fixture sequence, not a browser-issued ID. ACK may arrive after closed." };
}

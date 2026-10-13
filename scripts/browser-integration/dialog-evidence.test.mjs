import test from "node:test";
import assert from "node:assert/strict";
import { checkDialogEvidence } from "./dialog-evidence.mjs";
import { dialogCases, dialogLayouts, dialogMessage } from "./dialog-fixture.mjs";

function fixture(lifecycle = false, beforeunload = false) {
  const detail = { caller: "test", variants: [], nativeEvidence: { events: [], commands: [], overflow: false } };
  let sequence = 0;
  const native = (item, document, decision) => {
    const target = { tabId: item.tabId }, frameId = `native-frame-${item.tabId}`;
    const at = 1000 + sequence * 10;
    detail.nativeEvidence.events.push({ sequence: ++sequence, at, method: "Page.javascriptDialogOpening", source: { ...target },
      params: { frameId, type: decision.type, message: decision.message, url: document.href, hasBrowserHandler: true, ...(decision.type === "prompt" ? { defaultPrompt: "original default" } : {}) } });
    detail.nativeEvidence.commands.push({ sequence: ++sequence, at: at + 1, settledAt: at + 9, ack: {}, method: "Page.handleJavaScriptDialog", target: { ...target },
      params: { accept: decision.accept, ...(decision.type === "prompt" && decision.accept ? { promptText: decision.promptText ?? "" } : {}) } });
    detail.nativeEvidence.events.push({ sequence: ++sequence, at: at + 2, method: "Page.javascriptDialogClosed", source: { ...target },
      params: { frameId, result: decision.accept, userInput: decision.type === "prompt" && decision.accept ? decision.promptText ?? "" : "" } });
  };
  const post = (item, document, type, answer, index) => {
    const value = { key: item.key, token: document.token, href: document.href, type, answer, trusted: true, sequence: index };
    const bytes = Buffer.from(JSON.stringify(value));
    item.server.posts.push({ method: "POST", path: "/native-dialogs/result?" + new URLSearchParams({ key: item.key }), bodyBase64: bytes.toString("base64"), bytes: bytes.length, value });
  };
  for (const [index, layout] of (lifecycle ? ["root"] : dialogLayouts).entries()) {
    const key = lifecycle ? "js-dialog-lifecycle" : `test-dialogs-${layout}`;
    const document = { token: `original-${layout}`, href: `http://${layout === "root" ? "127.0.0.1" : "localhost"}:1234/native-dialogs${layout === "root" ? "" : "/frame"}?key=${key}&layout=${layout}`, layout, controls: true };
    const item = { key, layout, tabId: 7 + index, decisions: [], server: { documents: [document], posts: [] } }; detail.variants.push(item);
    if (layout !== "root") {
      item.oopifTargets = [{ tabId: item.tabId, source: { tabId: item.tabId }, targetId: `native-frame-${item.tabId}`, sessionId: `child-${item.tabId}`, type: "iframe", url: "" }];
      item.targets = [{ id: `native-frame-${item.tabId}`, type: "other", attached: true, url: document.href }];
    }
    if (lifecycle) {
      detail.server = item.server;
      for (const name of ["cancelled", "expired", ...(beforeunload ? ["beforeunload"] : []), "ended"]) detail[name] = { dialogId: name };
      if (beforeunload) {
        detail.beforeunload.original = { token: document.token, href: document.href };
        detail.beforeunload.result = { type: "beforeunload", message: "", defaultValue: "", accepted: false };
      }
      const decision = { type: "confirm", message: dialogMessage(key, "confirm"), accept: false };
      native(item, document, decision); native(item, document, decision);
      if (beforeunload) native(item, document, { type: "beforeunload", message: "", accept: false });
      native(item, document, decision);
      for (let i = 1; i <= 3; i++) post(item, document, "confirm", false, i);
      continue;
    }
    for (const [index, selected] of dialogCases.entries()) {
      const decision = { ...selected.decision, message: dialogMessage(key, selected.decision.type) };
      const result = { type: decision.type, message: decision.message, defaultValue: decision.type === "prompt" ? "original default" : "", accepted: decision.accept,
        ...(decision.type === "prompt" && decision.accept ? { promptText: decision.promptText ?? "" } : {}) };
      item.decisions.push({ decision, result, dialogId: `${layout}-${index}`, remainingMs: 9000 });
      if (selected.action === "sequence") native(item, document, { type: "alert", message: `unmatched: ${key}`, accept: false });
      native(item, document, decision); post(item, document, selected.action, selected.answer, index + 1);
    }
    native(item, document, { type: "confirm", message: dialogMessage(key, "confirm"), accept: false }); post(item, document, "confirm", false, 7);
  }
  return detail;
}
function rejects(mutate, lifecycle = false, beforeunload = false) { const value = fixture(lifecycle, beforeunload); mutate(value); assert.throws(() => checkDialogEvidence(value, { lifecycle, beforeunload })); }

test("original 3-layout transactions bind native target/ACK/closed to exact SDK decisions and HTTP bytes", () => {
  const value = fixture(), proof = checkDialogEvidence(value);
  assert.equal(proof.passed, true); assert.equal(proof.transactions.length, 24); assert.equal(proof.commandCount, 24);
  assert.equal(proof.transactions.filter(item => item.role === "unmatched-default").length, 3);
  assert.equal(proof.transactions.filter(item => item.role === "unarmed-default").length, 3);
  assert.ok(value.nativeEvidence.commands.every((command, index) => command.settledAt > value.nativeEvidence.events[index * 2 + 1].at), "Closed-before-ACK must remain valid");
});
test("same-count target/session substitution and a second response to the original opening are rejected", () => {
  rejects(value => { value.nativeEvidence.commands[0].target.tabId = 8; });
  rejects(value => { value.nativeEvidence.commands[8].target.sessionId = "different-child"; });
  rejects(value => { value.nativeEvidence.events[17].source.sessionId = "different-child"; });
  rejects(value => { value.nativeEvidence.commands[1].sequence = 3; value.nativeEvidence.events[1].sequence = 5; });
  rejects(value => {
    const rows = [...value.nativeEvidence.events.map(row => ({ row, kind: "event" })), ...value.nativeEvidence.commands.map(row => ({ row, kind: "command" }))].sort((a, b) => a.row.sequence - b.row.sequence);
    rows.splice(2, 0, { row: structuredClone(rows[1].row), kind: "command" });
    rows.forEach(({ row }, index) => { row.sequence = index + 1; });
    value.nativeEvidence.events = rows.filter(value => value.kind === "event").map(value => value.row);
    value.nativeEvidence.commands = rows.filter(value => value.kind === "command").map(value => value.row);
  });
});
test("counts cannot replace original ordering, completeness or successful native ACK", () => {
  for (const mutate of [
    value => { value.nativeEvidence.overflow = true; },
    value => { delete value.nativeEvidence.commands[0].ack; },
    value => { value.nativeEvidence.commands[0].ack = { guessed: true }; },
    value => { value.nativeEvidence.commands[0].error = "native rejection"; },
    value => { delete value.nativeEvidence.commands[0].settledAt; },
    value => { value.nativeEvidence.events.splice(1, 1); },
    value => { value.nativeEvidence.commands[0].sequence = value.nativeEvidence.events[0].sequence; }
  ]) rejects(mutate);
});
test("explicit accept, exact prompt text and original native source metadata are independent checks", () => {
  rejects(value => { value.nativeEvidence.commands[0].params.accept = false; });
  rejects(value => { value.nativeEvidence.commands[1].params.promptText = "original default"; });
  rejects(value => { value.nativeEvidence.events[3].params.userInput = "replacement"; });
  rejects(value => { value.nativeEvidence.events[2].params.defaultPrompt = "replacement"; });
  rejects(value => { value.nativeEvidence.events[0].params.url += "&replacement=1"; });
  rejects(value => { value.nativeEvidence.events[0].params.message = "confirm: different"; });
  rejects(value => { value.nativeEvidence.events[1].params.frameId = "replacement-frame"; });
  rejects(value => { value.nativeEvidence.events[1].params.result = false; });
  rejects(value => { value.nativeEvidence.commands[0].params.promptText = ""; });
});
test("root-routed OOPIF dialogs require independent original frame attach and current native target identity", () => {
  assert.equal(checkDialogEvidence(fixture()).transactions.filter(row => row.sessionId === null).length, 24);
  for (const mutate of [
    value => { delete value.variants[1].oopifTargets; },
    value => { value.variants[1].oopifTargets[0].tabId = 7; },
    value => { value.variants[1].oopifTargets[0].source.tabId = 7; },
    value => { value.variants[1].oopifTargets[0].targetId = "replacement-frame"; },
    value => { value.variants[1].oopifTargets[0].type = "page"; },
    value => { value.variants[1].targets[0].id = "replacement-frame"; },
    value => { value.variants[1].targets[0].url += "&replacement=1"; },
    value => { value.variants[1].targets[0].attached = false; },
    value => { value.variants[1].targets[0].type = "page"; },
    value => { value.nativeEvidence.events[16].params.frameId = "replacement-frame"; value.nativeEvidence.events[17].params.frameId = "replacement-frame"; }
  ]) rejects(mutate);
  const childRouted = fixture();
  for (const row of childRouted.nativeEvidence.events) if (row.source.tabId === 8) row.source.sessionId = "child-8";
  for (const row of childRouted.nativeEvidence.commands) if (row.target.tabId === 8) row.target.sessionId = "child-8";
  assert.equal(checkDialogEvidence(childRouted).transactions.filter(row => row.sessionId === "child-8").length, 8);
  childRouted.variants[1].oopifTargets[0].sessionId = "foreign-child";
  assert.throws(() => checkDialogEvidence(childRouted));
});
test("unmatched and unarmed defaults must retain their exact place, messages and decline decisions", () => {
  rejects(value => { value.nativeEvidence.commands[2].params.accept = true; });
  rejects(value => { value.nativeEvidence.events[4].params.message = "alert: test-dialogs-root"; });
  rejects(value => { value.nativeEvidence.commands[7].params.accept = true; });
  rejects(value => { value.nativeEvidence.events[14].params.type = "alert"; });
});
test("native success cannot override altered SDK results, ready identity or original receipt bytes", () => {
  rejects(value => { value.variants[0].decisions[0].result.accepted = false; });
  rejects(value => { value.variants[0].decisions[1].dialogId = value.variants[0].decisions[0].dialogId; });
  rejects(value => { value.variants[0].server.posts[0].value.trusted = false; });
  rejects(value => { value.variants[0].server.posts[0].bodyBase64 += "="; });
  rejects(value => { value.variants[0].server.posts[0].path = "/native-dialogs/result?key=other"; });
  rejects(value => { value.variants[0].server.documents[0].token = "replacement"; });
  rejects(value => { value.variants[0].server.posts.push(value.variants[0].server.posts[0]); });
});
test("default lifecycle proves cancel, expiry and ended defaults and rejects unrequested beforeunload evidence", () => {
  const proof = checkDialogEvidence(fixture(true), { lifecycle: true });
  assert.deepEqual(proof.transactions.map(value => value.role), ["after-cancel", "after-expiry", "after-turn-end"]);
  assert.throws(() => checkDialogEvidence(fixture(true, true), { lifecycle: true }));
  const extra = fixture(true, true); delete extra.beforeunload;
  assert.throws(() => checkDialogEvidence(extra, { lifecycle: true }));
  rejects(value => { value.beforeunload = null; }, true);
  rejects(value => { value.nativeEvidence.commands[2].params.accept = true; }, true);
  assert.throws(() => checkDialogEvidence(fixture(true), { lifecycle: true, beforeunload: true }));
});
test("explicit beforeunload diagnostic proves original dismissal without claiming background focus behavior", () => {
  const detail = fixture(true, true), proof = checkDialogEvidence(detail, { lifecycle: true, beforeunload: true });
  assert.deepEqual(proof.transactions.map(value => value.role), ["after-cancel", "after-expiry", "beforeunload", "after-turn-end"]);
  rejects(value => { value.nativeEvidence.commands[2].params.accept = true; }, true, true);
  rejects(value => { value.nativeEvidence.events[4].params.message = "unrelated beforeunload"; }, true, true);
  rejects(value => { value.beforeunload.original.token = "replacement"; }, true, true);
  rejects(value => { value.nativeEvidence.commands[3].params.accept = true; }, true, true);
});

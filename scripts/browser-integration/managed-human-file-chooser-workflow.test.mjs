import assert from "node:assert/strict";
import { test } from "node:test";
import { createHash } from "node:crypto";
import { assertManagedFileTransferLedger, projectManagedFileCommand, proveManagedFileOpening, assertManagedFileWorkflowFinalFixtures, resumeManagedFileWorkflowOriginals } from "./managed-human-file-chooser-workflow.mjs";

const sha = bytes => createHash("sha256").update(bytes).digest("hex");
const pending = { leaseId: "original", generation: 1, chooserId: "chooser" };
function ledger() {
  const payloads = [{ name: "same.txt", buffer: Buffer.from("original") }, { name: "same.txt", buffer: Buffer.alloc(0) }];
  const commands = [
    { id: 1, operation: "humanFileBegin", ...pending, files: payloads.map(file => ({ name: file.name, size: file.buffer.length })) },
    { id: 2, operation: "humanFileChunk", ...pending, transferId: "transfer", fileIndex: 0, offset: 0, dataBytes: 8, dataSHA256: sha(payloads[0].buffer) },
    { id: 3, operation: "humanFileCommit", ...pending, transferId: "transfer" },
  ];
  const messages = [
    { type: "response", id: 1, result: { fileTransfer: { ...pending, transferId: "transfer", fileCount: 2, totalBytes: 8 } } },
    { type: "response", id: 2, result: { fileChunk: { ...pending, transferId: "transfer", fileIndex: 0, nextOffset: 8 } } },
    { type: "response", id: 3, result: { fileChooserReceipt: { ...pending, transferId: "transfer", acknowledged: true } } },
  ];
  return { payloads, commands, messages };
}
const proveLedger = value => assertManagedFileTransferLedger(value.commands, value.messages, pending, value.payloads, true);
test("file wire projection retains exact original tuple and hash without carrying file bytes", () => {
  const value = { id: 8, operation: "humanFileChunk", ...pending, transferId: "t", fileIndex: 0, offset: 0, data: Buffer.from("private bytes").toString("base64") };
  const result = projectManagedFileCommand(value, () => { throw Error("wrong projection"); });
  assert.equal(result.data, undefined); assert.equal(result.dataBytes, 13); assert.equal(result.dataSHA256, sha(Buffer.from("private bytes")));
  for (const data of ["", "bad===", Buffer.alloc(16385).toString("base64")]) assert.throws(() => projectManagedFileCommand({ ...value, data }, () => {}));
  assert.throws(() => projectManagedFileCommand({ ...value, path: "forbidden" }, () => {}));
  assert.equal(projectManagedFileCommand({ operation: "status" }, value => value.operation), "status");
});
test("original transfer ledger proves same-name empty file and one exact native commit ACK", () => {
  assert.deepEqual(proveLedger(ledger()).bytesSent, [8, 0]);
});
test("transfer proof refuses replacements, gaps, changed bytes, incomplete/duplicated/reordered commits and missing actual replies", () => {
  for (const mutate of [
    value => { value.commands[0].generation++; },
    value => { value.messages[0].result.fileTransfer.chooserId = "replacement"; },
    value => { value.commands[1].offset++; },
    value => { value.commands[1].dataSHA256 = sha(Buffer.from("modified")); },
    value => { value.messages[1].result.fileChunk.nextOffset--; },
    value => { value.messages[2].result.fileChooserReceipt.acknowledged = false; },
    value => { value.commands.push({ ...value.commands[2] }); },
    value => { [value.commands[1], value.commands[2]] = [value.commands[2], value.commands[1]]; },
    value => { value.messages.pop(); },
    value => { value.messages.push(structuredClone(value.messages[2])); },
    value => { value.messages[1] = { type: "response", id: 2, error: { code: "STALE" } }; },
  ]) { const value = ledger(); mutate(value); assert.throws(() => proveLedger(value)); }
});
test("retired transfer accepts its actual failed chunk but never a commit or pending response", () => {
  const value = ledger(); value.commands.pop(); value.messages.pop(); value.messages[1] = { type: "response", id: 2, error: { code: "STALE" } };
  assert.equal(assertManagedFileTransferLedger(value.commands, value.messages, pending, value.payloads, false).commits, 0);
  value.messages.pop(); assert.throws(() => assertManagedFileTransferLedger(value.commands, value.messages, pending, value.payloads, false));
  assert.throws(() => { const completed = ledger(); assertManagedFileTransferLedger(completed.commands, completed.messages, pending, completed.payloads, false); });
});

function opening(child = false) {
  const root = { documentId: "root-document", url: "http://127.0.0.1:50001/root", state: { role: "root" } };
  const leaf = { documentId: "child-document", url: "http://localhost:50001/leaf", state: { role: "leaf" } };
  return { pending: { ...pending, multiple: child, source: { origin: child ? "http://localhost:50001" : "http://127.0.0.1:50001", frame: child ? "child" : "top-level" } },
    original: pending, documents: child ? [root, leaf] : [root],
    webFrames: [{ documentId: root.documentId, url: root.url, frameId: 0, processId: 10 }, ...(child ? [{ documentId: leaf.documentId, url: leaf.url, frameId: 4, processId: 20 }] : [])],
    target: { id: "root-target", tabId: 7 }, begunAt: 100, clickedAt: 150,
    events: [
      { sequence: 1, at: 110, source: { targetId: "root-target" }, method: "Runtime.executionContextCreated",
        params: { context: { id: 1, uniqueId: "root-context", origin: "http://127.0.0.1:50001", auxData: { frameId: "root-target", isDefault: true } } } },
      ...(child ? [{ sequence: 2, at: 120, source: { targetId: "root-target" }, method: "Target.attachedToTarget", params: { sessionId: "child-session", targetInfo: { targetId: "child-target", type: "iframe", url: leaf.url } } },
        { sequence: 3, at: 130, source: { targetId: "root-target", sessionId: "child-session" }, method: "Runtime.executionContextCreated",
          params: { context: { id: 2, uniqueId: "child-context", origin: "http://localhost:50001", auxData: { frameId: "child-target", isDefault: true } } } }] : []),
      { sequence: 4, at: 160, source: { targetId: "root-target", tabId: 7, ...(child ? { sessionId: "child-session" } : {}) },
        method: "Page.fileChooserOpened", params: { frameId: child ? "child-target" : "root-target", mode: child ? "selectMultiple" : "selectSingle", backendNodeId: 8 } }] };
}
test("native chooser proves root and the actual original attached OOPIF session/process", () => {
  assert.equal(proveManagedFileOpening(opening()).documentId, "root-document");
  assert.equal(proveManagedFileOpening(opening(true)).documentId, "child-document");
});
test("directory Opening mode does not redefine the original input multiple attribute", () => {
  const value = opening(true); value.pending.directory = true; value.pending.multiple = false;
  assert.equal(proveManagedFileOpening(value).documentId, "child-document");
  value.events.at(-1).params.mode = "unknown"; assert.throws(() => proveManagedFileOpening(value));
  const ordinary = opening(true); ordinary.pending.directory = false; ordinary.pending.multiple = false;
  assert.throws(() => proveManagedFileOpening(ordinary));
});
test("native chooser refuses URL-only child proof, stale attach, equal process, source mismatch and duplicated opening", () => {
  for (const mutate of [
    value => { value.events.at(-1).source.tabId = 8; },
    value => { value.events[1].params.targetInfo.targetId = "replacement"; },
    value => { value.events[1].at = 99; },
    value => { value.webFrames[1].processId = 10; },
    value => { value.pending.source.origin = value.webFrames[0].url; },
    value => { value.events.push(structuredClone(value.events.at(-1))); },
    value => { value.events.splice(3, 0, { sequence: 3.5, at: 140, method: "Target.detachedFromTarget", params: { sessionId: "child-session" } }); },
    value => { value.events.at(-1).params.frameId = "root-target"; },
  ]) { const value = opening(true); mutate(value); assert.throws(() => proveManagedFileOpening(value)); }
});

test("native origin requires the actual current default context in the original session", () => {
  const value = opening(true);
  assert.deepEqual(proveManagedFileOpening(value).actualOrigins, ["http://localhost:50001", "http://127.0.0.1:50001"]);
  for (const mutate of [
    row => { row.events.splice(2, 1); },
    row => { row.events[2].source.sessionId = "previous-session"; },
    row => { row.events[2].at = 99; },
    row => { row.events[2].params.context.auxData.isDefault = false; },
    row => { row.events[2].params.context.origin = "http://127.0.0.1:50001"; },
    row => { row.events[2].params.context.auxData.frameId = "replacement-frame"; },
    row => { row.events.splice(3, 0, { sequence: 3.5, at: 140, source: row.events[2].source, method: "Runtime.executionContextsCleared", params: {} }); },
    row => { row.events.splice(3, 0, { sequence: 3.5, at: 140, source: row.events[2].source, method: "Runtime.executionContextDestroyed", params: { executionContextId: 2, executionContextUniqueId: "child-context" } }); },
    row => { row.events.splice(3, 0, { sequence: 3.5, at: 140, source: row.events[2].source, method: "Page.frameNavigated", params: { frame: { id: "child-target" } } }); },
  ]) { const row = opening(true); mutate(row); assert.throws(() => proveManagedFileOpening(row)); }
});

function terminalFixtures() {
  const fixtures = [], results = [];
  for (const kind of ["root", "oopif", "transfer-end", "transfer-navigation"]) {
    const urls = Object.fromEntries(["root", "emitter", "receipt", "gate", "landed"].map(name => [name, `http://127.0.0.1:50001/${kind}/${name}`]));
    const request = (method, url) => ({ method, path: new URL(url).pathname, status: 200, finished: true, aborted: false, at: 120 });
    const requests = [request("GET", urls.root)], success = ["root", "oopif"].includes(kind);
    if (kind === "oopif") requests.push(request("GET", urls.emitter));
    if (kind === "transfer-navigation") requests.push(request("GET", urls.gate), request("GET", urls.landed));
    if (success) requests.push(request("POST", urls.receipt));
    const receipt = success ? { ok: true, posts: 1, documentToken: kind } : null;
    fixtures.push({ kind, urls, requests, overflow: false, posted: success, receipt });
    results.push({ kind, receipt, endedAt: 100, submitStartedAt: 110 });
  }
  return { fixtures, results };
}
test("terminal fixture proof rejects late POST, navigation, abort, overflow and changed receipt after business success", () => {
  const original = terminalFixtures();
  assert.equal(assertManagedFileWorkflowFinalFixtures(original.fixtures, original.results).originalPosts, 2);
  for (const mutate of [
    value => { value.fixtures[0].requests.push(structuredClone(value.fixtures[0].requests.at(-1))); },
    value => { value.fixtures[2].requests.push({ method: "POST", path: "/late" }); },
    value => { value.fixtures[1].overflow = true; },
    value => { value.fixtures[0].requests.at(-1).finished = false; },
    value => { value.fixtures[3].requests.at(-1).aborted = true; },
    value => { value.fixtures[1].receipt = { ok: true, posts: 2 }; },
    value => { value.results[0].submitStartedAt = 99; },
    value => { value.fixtures[0].requests.at(-1).at = 109; },
  ]) { const value = terminalFixtures(); mutate(value); assert.throws(() => assertManagedFileWorkflowFinalFixtures(value.fixtures, value.results)); }
});

function originalSubmission(kind = "root") {
  const target = { id: "original-target", tabId: 7, url: "http://127.0.0.1:50001/root", attached: false,
    tab: { id: 7, windowId: 9, groupId: -1, active: true, pinned: false },
    window: { id: 9, type: "normal", state: "normal", focused: false } };
  const before = [{ documentId: "original-document", frameId: 0, url: target.url,
    state: { role: kind === "oopif" ? "leaf" : "root", workflowId: "workflow", documentToken: "original-token", phase: "ready", posts: 0,
      events: [{ type: "change", trusted: true }] },
    files: [{ name: "original.bin", size: 8, lastModified: 123, type: "" }], receipt: null }];
  const trace = [], item = { tabId: 7, target, fixture: { kind, stats: () => ({ receipt: { posts: 1 } }) } };
  const row = { kind, after: structuredClone(before) };
  let submitted = false;
  const io = {
    async resumeAgent() { trace.push("resume+beginTurn"); },
    async originalTarget() { trace.push("target"); return structuredClone(target); },
    async read() {
      trace.push("read"); const rows = structuredClone(before);
      if (submitted) rows[0].state.phase = "committed";
      return rows;
    },
    async claimOriginal(value) { trace.push("claim:" + value.tabId); return { id: value.tabId, url: target.url, active: true }; },
    async submitOriginal(value, retainedRow) { assert.equal(value, item); assert.equal(retainedRow, row); trace.push("submit"); submitted = true; },
    async wait(read) { const value = await read(); assert.ok(value); return value; },
  };
  return { io, item, row, trace, run: () => resumeManagedFileWorkflowOriginals(io, [item], [row]) };
}
test("original submission waits for Resume/new turn and the actual public claim receipt before reading or submitting", async () => {
  const value = originalSubmission(); let resumed, claimed;
  value.io.resumeAgent = () => new Promise(resolve => { resumed = resolve; value.trace.push("resume-pending"); });
  value.io.claimOriginal = item => new Promise(resolve => { claimed = resolve; value.trace.push("claim:" + item.tabId); });
  const running = value.run();
  assert.deepEqual(value.trace, ["resume-pending"]);
  resumed(); await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(value.trace, ["resume-pending", "target", "read", "claim:7"]);
  const receipt = { id: 7, url: value.item.target.url, active: true };
  claimed(receipt); await running;
  assert.equal(value.row.claim.receipt, receipt);
  assert.deepEqual(value.trace, ["resume-pending", "target", "read", "claim:7", "target", "read", "submit", "read"]);
  assert.ok(value.row.claim.acknowledgedAt <= value.row.claim.verifiedAt);
  assert.ok(value.row.claim.verifiedAt <= value.row.submitStartedAt);
});
test("claim failure or changed original target, document, token or FileList prevents submission without retry", async () => {
  for (const mutation of ["reject", "receipt-id", "receipt-url", "target", "document", "token", "files"]) {
    const value = originalSubmission(), originalRead = value.io.read; let claimed = false;
    value.io.claimOriginal = async item => {
      value.trace.push("claim:" + item.tabId); claimed = true;
      if (mutation === "reject") throw Error("original claim rejected");
      return { id: mutation === "receipt-id" ? 8 : 7, url: mutation === "receipt-url" ? "http://127.0.0.1:50001/new" : item.target.url };
    };
    value.io.originalTarget = async () => ({ ...value.item.target, id: claimed && mutation === "target" ? "replacement" : value.item.target.id });
    value.io.read = async () => {
      const rows = await originalRead();
      if (claimed && mutation === "document") rows[0].documentId = "replacement";
      if (claimed && mutation === "token") rows[0].state.documentToken = "replacement";
      if (claimed && mutation === "files") rows[0].files = [];
      return rows;
    };
    await assert.rejects(value.run(), undefined, mutation);
    assert.equal(value.trace.filter(step => step === "claim:7").length, 1);
    assert.equal(value.trace.includes("submit"), false);
    if (mutation !== "reject") assert.ok(value.row.claim.receipt, "Keep the actual receipt even when a later identity check fails");
  }
});
test("a changed original document before claim is rejected without claiming or submitting", async () => {
  const value = originalSubmission(); value.row.after[0].files[0].size++;
  await assert.rejects(value.run());
  assert.equal(value.trace.some(step => step.startsWith("claim:")), false);
  assert.equal(value.trace.includes("submit"), false);
});

test("root and OOPIF claim must preserve original placement before any submit", async () => {
  for (const kind of ["root", "oopif"]) {
    const unchanged = originalSubmission(kind); await unchanged.run();
    assert.equal(unchanged.row.claim.placementUnchanged, true);
    assert.equal(unchanged.trace.filter(value => value === "submit").length, 1);
    for (const mutate of [
      value => { value.tab.windowId++; value.window.id++; },
      value => { value.tab.groupId = 18; },
      value => { value.tab.active = false; },
      value => { value.tab.pinned = true; },
      value => { value.window.focused = true; },
      value => { value.window.type = "popup"; },
      value => { value.window.state = "minimized"; },
      value => { delete value.tab.groupId; },
    ]) {
      const sample = originalSubmission(kind); let reads = 0;
      sample.io.originalTarget = async () => {
        const value = structuredClone(sample.item.target); if (++reads === 2) mutate(value); return value;
      };
      await assert.rejects(sample.run());
      assert.equal(sample.trace.filter(value => value === "claim:7").length, 1);
      assert.equal(sample.trace.includes("submit"), false);
      assert.ok(sample.row.claim.receipt);
      assert.ok(sample.row.claim.afterDocuments);
      assert.equal(sample.row.claim.placementUnchanged, undefined);
    }
  }
});

import assert from "node:assert/strict";
import { test } from "node:test";
import { EventEmitter } from "node:events";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import vm from "node:vm";
import { createManagedDirectoryFixture, managedDirectoryPayloads, prepareManagedDirectory, directorySort } from "./managed-human-directory-fixture.mjs";
import { assertManagedDirectoryTransfer, assertManagedDirectoryTerminalFixtures, assertManagedDirectoryCommitWitness } from "./managed-human-directory-workflow.mjs";
import { managedFileChooserCompletion } from "./managed-human-file-chooser-check.mjs";
const sha = bytes => createHash("sha256").update(bytes).digest("hex");
const pending = { leaseId: "original", generation: 1, chooserId: "directory" };

function ledger() {
  const files = managedDirectoryPayloads("root").reverse(), commands = [], messages = [];
  const add = (command, reply) => {
    const id = commands.length + 1; commands.push({ id, ...pending, ...command }); messages.push({ type: "response", id, result: reply });
  };
  add({ operation: "humanFileBegin", files: files.map(file => ({ name: file.name, size: file.buffer.length, relativePath: file.relativePath })) },
    { fileTransfer: { ...pending, transferId: "transfer", fileCount: files.length, totalBytes: files.reduce((n, file) => n + file.buffer.length, 0) } });
  for (let index = 0; index < files.length; index++) for (let offset = 0; offset < files[index].buffer.length; offset += 16384) {
    const bytes = files[index].buffer.subarray(offset, offset + 16384);
    add({ operation: "humanFileChunk", transferId: "transfer", fileIndex: index, offset, dataBytes: bytes.length, dataSHA256: sha(bytes) },
      { fileChunk: { ...pending, transferId: "transfer", fileIndex: index, nextOffset: offset + bytes.length } });
  }
  add({ operation: "humanFileCommit", transferId: "transfer" }, { fileChooserReceipt: { ...pending, transferId: "transfer", acknowledged: true } });
  return { commands, messages, files };
}
const prove = value => assertManagedDirectoryTransfer(value.commands, value.messages, pending, "root", true);
test("directory wire preserves native order while comparing exact relative-path content", () => {
  const value = ledger(), result = prove(value);
  assert.deepEqual(result.originalOrder, value.files.map(file => file.relativePath));
  assert.deepEqual(result.bytesSent, value.files.map(file => file.buffer.length));
  assert.equal(result.commits, 1);
});
test("directory wire refuses duplicate paths, renamed files, same-basename swaps and missing bytes", () => {
  for (const mutate of [
    value => { value.commands[0].files[1].relativePath = value.commands[0].files[2].relativePath; },
    value => { value.commands[0].files[0].relativePath = "different-root/zero.bin"; },
    value => { value.commands[0].files[0].name = "wrong.bin"; },
    value => { const rows = value.commands[0].files.filter(file => file.name === "same.txt"); [rows[0].relativePath, rows[1].relativePath] = [rows[1].relativePath, rows[0].relativePath]; },
    value => { value.commands.find(row => row.operation === "humanFileChunk").dataSHA256 = "0".repeat(64); },
    value => { value.messages.pop(); }, value => { value.commands.push(structuredClone(value.commands.at(-1))); },
  ]) { const value = ledger(); mutate(value); assert.throws(() => prove(value)); }
});
test("retired directory transfer keeps exact partial chunks and refuses a completed commit", () => {
  const value = ledger(); value.commands = value.commands.slice(0, 3); value.messages = value.messages.slice(0, 3);
  const result = assertManagedDirectoryTransfer(value.commands, value.messages, pending, "root", false);
  assert.equal(result.commits, 0);
  assert.throws(() => { const whole = ledger(); assertManagedDirectoryTransfer(whole.commands, whole.messages, pending, "root", false); });
});

function requestFixture(fixture, url, method = "GET", value) {
  const request = new EventEmitter(), response = new EventEmitter(); let body, status;
  const parsed = new URL(url); Object.assign(request, { method, url: parsed.pathname, headers: { host: parsed.host }, resume() {} });
  response.writeHead = code => { status = code; };
  response.end = data => { body = data; response.writableFinished = true; response.emit("finish"); };
  assert.equal(fixture.handle(request, response), true);
  if (value !== undefined) { request.emit("data", Buffer.from(JSON.stringify(value))); request.emit("end"); }
  return { body, status };
}
function business(fixture) {
  const stats = fixture.stats(), files = managedDirectoryPayloads(stats.kind);
  const metadata = files.map(file => ({ name: file.name, relativePath: file.relativePath, size: file.buffer.length }));
  const event = { type: "input", trusted: true, originalNode: true, files: metadata };
  const identity = { workflowId: stats.workflowId, documentToken: stats.tokens[stats.kind === "oopif" ? "leaf" : "root"], inputToken: "original-input" };
  return { witness: { ...identity, event }, post: { ...identity, posts: 1,
    files: files.map(file => ({ name: file.name, relativePath: file.relativePath, size: file.buffer.length, data: file.buffer.toString("base64") })),
    events: [event, { type: "change", trusted: true }, { type: "submit", trusted: true }] } };
}
test("root directory fixture records one trusted completion witness and later exact original bytes", () => {
  const fixture = createManagedDirectoryFixture({ baseURL: "http://127.0.0.1:53001", kind: "root" });
  const original = requestFixture(fixture, fixture.urls.root);
  assert.equal(original.status, 200); assert.match(original.body, /webkitdirectory multiple/);
  new vm.Script(original.body.match(/<script>([\s\S]*)<\/script>/)[1]);
  assert.match(original.body, /witness failed';render\(\)\}\}\},\{capture:true\}\)/,
    "The early page listener must observe input before the later production capture guard can resolve");
  const value = business(fixture);
  assert.equal(requestFixture(fixture, fixture.urls.witness, "POST", value.witness).status, 200);
  assert.equal(fixture.stats().posted, false);
  assert.equal(requestFixture(fixture, fixture.urls.receipt, "POST", value.post).status, 200);
  assert.deepEqual(fixture.stats().receipt.files, directorySort(managedDirectoryPayloads("root").map(file => ({ name: file.name, relativePath: file.relativePath, size: file.buffer.length, sha256: sha(file.buffer) }))));
  assert.equal(requestFixture(fixture, fixture.urls.receipt, "POST", value.post).status, 400);
});
test("OOPIF native directory input deliberately omits multiple while accepting a complete tree", () => {
  const fixture = createManagedDirectoryFixture({ baseURL: "http://127.0.0.1:53001", kind: "oopif" });
  assert.equal(requestFixture(fixture, fixture.urls.root).status, 200);
  const child = requestFixture(fixture, fixture.urls.emitter); assert.equal(child.status, 200);
  new vm.Script(child.body.match(/<script>([\s\S]*)<\/script>/)[1]);
  assert.equal(new URL(fixture.urls.emitter).hostname, "localhost");
  assert.match(child.body, /type="file" webkitdirectory ><button/); assert.doesNotMatch(child.body, /webkitdirectory multiple/);
  const value = business(fixture);
  assert.equal(requestFixture(fixture, fixture.urls.witness, "POST", value.witness).status, 200);
  assert.equal(requestFixture(fixture, fixture.urls.receipt, "POST", value.post).status, 200);
});
test("fixture refuses false native input and directory metadata changes without completing business", () => {
  for (const mutate of [value => { value.event.trusted = false; }, value => { value.event.originalNode = false; },
    value => { value.event.files[0].relativePath = "other-root/中文.txt"; }, value => { value.event.files.push(value.event.files[0]); }]) {
    const fixture = createManagedDirectoryFixture({ baseURL: "http://127.0.0.1:53001", kind: "root" }); requestFixture(fixture, fixture.urls.root);
    const value = business(fixture); mutate(value.witness);
    assert.equal(requestFixture(fixture, fixture.urls.witness, "POST", value.witness).status, 400);
    assert.equal(fixture.stats().posted, false); assert.deepEqual(fixture.stats().witnesses, []);
  }
});
test("pre-reply trusted input must belong to the original directory node, document and bytes", () => {
  const files = managedDirectoryPayloads("root"), original = { documentId: "native-original", state: { workflowId: "workflow", documentToken: "document", inputToken: "input" } };
  const valid = { workflowId: "workflow", documentToken: "document", inputToken: "input", event: { type: "input", trusted: true, originalNode: true,
    files: files.map(file => ({ name: file.name, size: file.buffer.length, relativePath: file.relativePath })) } };
  assert.equal(assertManagedDirectoryCommitWitness([valid], original, files).trustedInputBeforeReply, true);
  for (const mutate of [value => { value.workflowId = "other"; }, value => { value.documentToken = "other"; }, value => { value.inputToken = "other"; },
    value => { value.event.type = "change"; }, value => { value.event.trusted = false; }, value => { value.event.originalNode = false; },
    value => { value.event.files[0].relativePath = "other/中文.txt"; }, value => { value.event.files.pop(); }]) {
    const changed = structuredClone(valid); mutate(changed); assert.throws(() => assertManagedDirectoryCommitWitness([changed], original, files));
  }
  assert.throws(() => assertManagedDirectoryCommitWitness([], original, files));
  assert.throws(() => assertManagedDirectoryCommitWitness([valid, valid], original, files));
});
test("generated local tree preserves UTF-8 names, nested duplicate basenames and empty files", async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "obu-directory-fixture-"));
  t.after(async () => { assert.ok(path.resolve(root).startsWith(path.resolve(os.tmpdir()) + path.sep)); await fs.rm(root, { recursive: true, force: true }); });
  const value = await prepareManagedDirectory(root, "root");
  for (const file of value.files) {
    const data = await fs.readFile(path.join(path.dirname(value.root), ...file.relativePath.split("/")));
    assert.equal(data.length, file.size); assert.equal(sha(data), file.sha256);
  }
  assert.equal(value.files.filter(file => file.name === "same.txt").length, 2);
  assert.equal(value.files.find(file => file.name === "zero.bin").size, 0);
  assert.deepEqual(await fs.readdir(path.join(value.root, "空子目录")), []);
});
test("directory workflow alone enables acceptance, and private diagnostics never do", () => {
  assert.deepEqual(managedFileChooserCompletion("directory-workflow", false, true), { featurePassed: true, diagnosticCompleted: false });
  assert.deepEqual(managedFileChooserCompletion("directory-workflow", true, true), { featurePassed: false, diagnosticCompleted: true });
});
test("terminal directory oracle refuses an incomplete workflow and absent pre-reply witness", () => {
  assert.throws(() => assertManagedDirectoryTerminalFixtures([], []));
  const fixtures = [], rows = [];
  for (const kind of ["root", "oopif", "transfer-end", "transfer-navigation"]) {
    const fixture = createManagedDirectoryFixture({ baseURL: "http://127.0.0.1:53001", kind });
    requestFixture(fixture, fixture.urls.root);
    if (kind === "oopif") requestFixture(fixture, fixture.urls.emitter);
    if (["root", "oopif"].includes(kind)) {
      const value = business(fixture); requestFixture(fixture, fixture.urls.witness, "POST", value.witness); requestFixture(fixture, fixture.urls.receipt, "POST", value.post);
    }
    if (kind === "transfer-navigation") { requestFixture(fixture, fixture.urls.gate); fixture.releaseNavigation(); requestFixture(fixture, fixture.urls.landed); }
    const stats = fixture.stats(); fixtures.push(stats);
    rows.push({ kind, receipt: stats.receipt, endedAt: 1, submitStartedAt: 2, immediateWitnesses: stats.witnesses });
  }
  assert.equal(assertManagedDirectoryTerminalFixtures(fixtures, rows).originalBusinessPosts, 2);
  rows[0].immediateWitnesses = []; assert.throws(() => assertManagedDirectoryTerminalFixtures(fixtures, rows));
});

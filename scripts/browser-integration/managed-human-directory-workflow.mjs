import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { managedDirectoryPayloads, directorySort } from "./managed-human-directory-fixture.mjs";
import { assertManagedFileTransferLedger, proveManagedFileOpening, resumeManagedFileWorkflowOriginals } from "./managed-human-file-chooser-workflow.mjs";

const sha = bytes => createHash("sha256").update(bytes).digest("hex");
const tuple = value => ({ leaseId: value.leaseId, generation: value.generation, chooserId: value.chooserId });
const metadata = files => directorySort(files.map(file => ({ name: file.name, size: file.size ?? file.buffer.length, relativePath: file.relativePath })));

export function assertManagedDirectoryCommitWitness(witnesses, originalDocument, payloads) {
  assert.equal(witnesses.length, 1, "Original trusted input must already be observed when the commit reply arrives");
  const witness = witnesses[0];
  assert.equal(witness.workflowId, originalDocument.state.workflowId);
  assert.equal(witness.documentToken, originalDocument.state.documentToken);
  assert.equal(witness.inputToken, originalDocument.state.inputToken);
  assert.equal(witness.event.type, "input"); assert.equal(witness.event.trusted, true); assert.equal(witness.event.originalNode, true);
  assert.deepEqual(metadata(witness.event.files), metadata(payloads));
  return { originalDocumentId: originalDocument.documentId, documentToken: witness.documentToken,
    inputToken: witness.inputToken, trustedInputBeforeReply: true };
}

export function assertManagedDirectoryTransfer(commands, messages, pending, kind, committed) {
  const begin = commands.filter(row => row.operation === "humanFileBegin" && row.leaseId === pending.leaseId && row.chooserId === pending.chooserId);
  assert.equal(begin.length, 1);
  const expected = managedDirectoryPayloads(kind);
  assert.deepEqual(metadata(begin[0].files), metadata(expected));
  assert.equal(new Set(begin[0].files.map(file => file.relativePath)).size, expected.length);
  const ordered = begin[0].files.map(file => expected.find(value => value.relativePath === file.relativePath));
  // Native directory enumeration is unordered. Each transmitted index is still
  // joined to its exact original relative path before reusing byte/ACK checks.
  const projected = commands.map(row => row === begin[0] ? { ...row, files: row.files.map(({ name, size }) => ({ name, size })) } : row);
  return { ...assertManagedFileTransferLedger(projected, messages, pending, ordered, committed),
    originalOrder: begin[0].files.map(file => file.relativePath) };
}

export function assertManagedDirectoryTerminalFixtures(fixtures, results) {
  assert.equal(fixtures.length, 4); assert.equal(results.length, 4);
  assert.deepEqual(fixtures.map(value => value.kind).sort(), ["oopif", "root", "transfer-end", "transfer-navigation"]);
  for (const fixture of fixtures) {
    const row = results.find(value => value.kind === fixture.kind); assert.ok(row);
    const success = ["root", "oopif"].includes(fixture.kind);
    assert.equal(fixture.overflow, false); assert.equal(fixture.posted, success);
    assert.equal(fixture.witnesses.length, success ? 1 : 0);
    assert.deepEqual(fixture.receipt, success ? row.receipt : null);
    const business = fixture.requests.filter(value => value.path === new URL(fixture.urls.receipt).pathname);
    assert.equal(business.length, success ? 1 : 0);
    if (success) {
      assert.equal(row.receipt.ok, true); assert.equal(row.receipt.posts, 1);
      assert.ok(row.submitStartedAt >= row.endedAt); assert.ok(business[0].at >= row.submitStartedAt);
      assert.equal(row.immediateWitnesses.length, 1, "Trusted input must already be observed when original commit reply arrives");
      assert.deepEqual(row.immediateWitnesses, fixture.witnesses);
    }
    const expected = [["GET", new URL(fixture.urls.root).pathname]];
    if (fixture.kind === "oopif") expected.push(["GET", new URL(fixture.urls.emitter).pathname]);
    if (fixture.kind === "transfer-navigation") expected.push(["GET", new URL(fixture.urls.gate).pathname], ["GET", new URL(fixture.urls.landed).pathname]);
    if (success) expected.push(["POST", new URL(fixture.urls.witness).pathname], ["POST", new URL(fixture.urls.receipt).pathname]);
    assert.deepEqual(fixture.requests.map(value => [value.method, value.path]), expected);
    for (const hit of fixture.requests) { assert.equal(hit.status, 200); assert.equal(hit.finished, true); assert.equal(hit.aborted, false); assert.equal(hit.validationError, undefined); }
  }
  return { verified: true, fixtureCount: 4, originalBusinessPosts: 2, originalInputWitnesses: 2 };
}

export async function runManagedDirectoryWorkflow(io, cases) {
  const results = [];
  for (const item of cases) {
    const row = { kind: item.fixture.kind, tabId: item.tabId, startedAt: Date.now(), instrumented: Boolean(io.instrumented) };
    results.push(row); io.record(results);
    row.begin = await io.begin(item); row.lease = structuredClone(io.state().human);
    assert.equal(row.lease.fileChooserVersion, 2);
    row.before = await io.read(item); row.webFrames = await io.webFrames(item);
    const emitter = row.before.find(document => document.input);
    assert.deepEqual(emitter.input, { directory: true, multiple: row.kind !== "oopif", type: "file", connected: true });
    row.click = await io.clickInput(item, row.before);
    row.pending = await io.wait(() => io.state()?.pendingFileChooser, "original directory chooser");
    assert.equal(row.pending.directory, true); assert.equal(row.pending.multiple, emitter.input.multiple);
    row.nativeProof = proveManagedFileOpening({ events: await io.nativeEvents(), pending: row.pending, original: row.lease,
      documents: row.before, webFrames: row.webFrames, target: item.target, begunAt: row.startedAt, clickedAt: row.click.startedAt });
    const payloads = managedDirectoryPayloads(row.kind);
    row.payloads = payloads.map(file => ({ name: file.name, relativePath: file.relativePath, bytes: file.buffer.length, sha256: sha(file.buffer) }));
    await io.screenshot("directory-pending-" + row.kind);
    row.picker = await io.pickDirectory(item);
    if (["root", "oopif"].includes(row.kind)) {
      row.commitReply = await io.waitReply("humanFileCommit", row.pending, 30000);
      row.immediateWitnesses = io.commitWitnesses(row.commitReply.id);
      row.commitWitnessProof = assertManagedDirectoryCommitWitness(row.immediateWitnesses, emitter, payloads);
      row.after = await io.read(item);
      const leaf = row.after.find(document => document.input);
      assert.equal(leaf.documentId, emitter.documentId); assert.equal(leaf.state.inputToken, emitter.state.inputToken);
      assert.deepEqual(metadata(leaf.files), metadata(payloads));
      assert.equal(leaf.state.events.filter(event => event.type === "input").length, 1);
      assert.equal(leaf.state.events.filter(event => event.type === "change").length, 1);
      assert.ok(leaf.state.events.every(event => event.trusted)); assert.equal(leaf.state.posts, 0); assert.equal(leaf.state.error, null);
      row.transfer = assertManagedDirectoryTransfer(io.commands(), io.messages(), row.pending, row.kind, true);
      row.deliveredFiles = await io.transferDirectoryFiles(row.transfer.transferId, payloads);
      if (row.kind === "root") {
        row.cancelClick = await io.clickInput(item, row.after);
        row.cancelPending = await io.wait(() => io.state()?.pendingFileChooser, "second original directory chooser");
        assert.notEqual(row.cancelPending.chooserId, row.pending.chooserId); assert.equal(row.cancelPending.directory, true);
        row.cancelNativeProof = proveManagedFileOpening({ events: await io.nativeEvents(), pending: row.cancelPending, original: row.lease,
          documents: row.after, webFrames: await io.webFrames(item), target: item.target, begunAt: row.startedAt, clickedAt: row.cancelClick.startedAt });
        row.cancelReply = await io.uiAction("#file-cancel", "humanFileCancel");
        assert.deepEqual(row.cancelReply.fileChooserCancellation, { ...tuple(row.cancelPending), cancelled: true });
        row.afterCancel = await io.read(item); assert.deepEqual(row.afterCancel[0].files, leaf.files);
        assert.equal(row.afterCancel[0].state.events.filter(event => ["input", "change"].includes(event.type)).length, 2);
      }
      row.end = await io.end(row.lease);
      row.filesAfterEnd = await io.transferDirectoryFiles(row.transfer.transferId, payloads);
    } else {
      row.firstChunk = await io.wait(() => io.commands().find(command => command.operation === "humanFileChunk" && command.chooserId === row.pending.chooserId), "first original directory chunk");
      assert.equal(io.commands().some(command => command.operation === "humanFileCommit" && command.chooserId === row.pending.chooserId), false, "A finished transfer cannot substitute for the cancellation case");
      if (row.kind === "transfer-navigation") {
        row.fixtureNavigationReleasedAt = Date.now(); item.fixture.releaseNavigation();
        row.landed = await io.wait(async () => (await io.read(item, false)).find(document => document.state.role === "landed"), "original directory page navigated during transfer");
        assert.notEqual(row.landed.documentId, item.before[0].documentId);
      }
      row.end = await io.end(row.lease); await io.wait(() => !io.pagePending(), "original directory requests settled after retirement");
      row.transfer = assertManagedDirectoryTransfer(io.commands(), io.messages(), row.pending, row.kind, false);
      row.stagingRemoved = await io.waitTransferRemoved(row.transfer.transferId);
      assert.equal(item.fixture.stats().posted, false); assert.deepEqual(item.fixture.stats().witnesses, []);
      if (row.kind === "transfer-end") { row.after = await io.read(item); assert.deepEqual(row.after[0].files, []); }
    }
    await io.screenshot("directory-ended-" + row.kind); row.endedAt = Date.now(); io.record(results);
  }
  await resumeManagedFileWorkflowOriginals(io, cases, results);
  assert.equal((await io.nativeEvents()).filter(event => event.method === "Page.fileChooserOpened").length, 5);
  for (const row of results) {
    assertManagedDirectoryTransfer(io.commands(), io.messages(), row.pending, row.kind, ["root", "oopif"].includes(row.kind));
    const inputs = io.commands().filter(command => command.operation === "humanInput" && command.leaseId === row.lease.leaseId);
    assert.deepEqual(inputs.map(command => command.id), [...row.click.inputRequests, ...(row.cancelClick?.inputRequests ?? [])]);
    assert.deepEqual(inputs.map(command => command.sequence), inputs.map((_command, index) => index + 1));
  }
  io.record(results); return results;
}

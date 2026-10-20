import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { managedFileWorkflowPayloads } from "./managed-human-file-chooser-fixture.mjs";

const sha = bytes => createHash("sha256").update(bytes).digest("hex");
const tuple = value => ({ leaseId: value.leaseId, generation: value.generation, chooserId: value.chooserId });
const sourceMatches = (source, target, sessionId) =>
  source && (source.targetId !== undefined || source.tabId !== undefined) &&
  (source.targetId === undefined || source.targetId === target.id) &&
  (source.tabId === undefined || source.tabId === target.tabId) && (source.sessionId ?? null) === sessionId;

function originalDefaultContext(events, target, sessionId, frameId, begunAt, opening) {
  const candidates = events.filter(row => row.method === "Runtime.executionContextCreated" && row.at >= begunAt &&
    row.sequence < opening.sequence && sourceMatches(row.source, target, sessionId) &&
    row.params.context.auxData?.isDefault === true && row.params.context.auxData.frameId === frameId);
  assert.ok(candidates.length, "Original human attachment must supply an observed default context; no URL-only fallback");
  const created = candidates.at(-1), context = created.params.context;
  assert.ok(Number.isSafeInteger(context.id) && context.id > 0);
  assert.ok(typeof context.uniqueId === "string" && context.uniqueId.length > 0);
  const origin = new URL(context.origin); assert.ok(["http:", "https:"].includes(origin.protocol));
  assert.equal(origin.origin, context.origin, "Policy origin must come from the native default context");
  for (const row of events.filter(value => value.sequence > created.sequence && value.sequence < opening.sequence)) {
    if (!sourceMatches(row.source, target, sessionId)) continue;
    assert.notEqual(row.method, "Runtime.executionContextsCleared");
    assert.notEqual(row.method, "debugger.onDetach");
    if (row.method === "Runtime.executionContextDestroyed")
      assert.ok(row.params.executionContextId !== context.id && row.params.executionContextUniqueId !== context.uniqueId);
    if (row.method === "Page.frameNavigated") assert.notEqual(row.params.frame.id, frameId);
    if (row.method === "Page.frameDetached") assert.notEqual(row.params.frameId, frameId);
  }
  return { sequence: created.sequence, source: created.source, id: context.id, uniqueId: context.uniqueId, frameId, origin: context.origin };
}
export function projectManagedFileCommand(value, fallback) {
  if (!["humanFileBegin", "humanFileChunk", "humanFileCommit", "humanFileCancel"].includes(value?.operation)) return fallback(value);
  const fields = ["id", "operation", "leaseId", "generation", "chooserId"];
  if (value.operation === "humanFileBegin") fields.push("files");
  if (value.operation === "humanFileChunk") fields.push("transferId", "fileIndex", "offset", "data");
  if (value.operation === "humanFileCommit" || value.operation === "humanFileCancel" && value.transferId !== undefined) fields.push("transferId");
  assert.deepEqual(Object.keys(value).sort(), fields.sort());
  const result = structuredClone(value);
  if (value.operation === "humanFileChunk") {
    assert.equal(typeof value.data, "string");
    const data = Buffer.from(value.data, "base64"); assert.equal(data.toString("base64"), value.data);
    assert.ok(data.length > 0 && data.length <= 16384);
    delete result.data; result.dataBytes = data.length; result.dataSHA256 = sha(data);
  }
  return result;
}

export function assertManagedFileTransferLedger(commands, messages, original, payloads, committed) {
  const rows = commands.filter(row => row.leaseId === original.leaseId && row.chooserId === original.chooserId);
  assert.ok(rows.length > 0); assert.equal(rows[0].operation, "humanFileBegin");
  assert.equal(rows.filter(row => row.operation === "humanFileBegin").length, 1);
  assert.deepEqual(rows[0].files, payloads.map(file => ({ name: file.name, size: file.buffer.length })));
  const replies = row => messages.filter(value => value.type === "response" && value.id === row.id);
  const beginReplies = replies(rows[0]); assert.equal(beginReplies.length, 1); assert.equal(beginReplies[0].error, undefined);
  assert.deepEqual(tuple(rows[0]), tuple(original));
  const begun = beginReplies[0].result.fileTransfer; assert.deepEqual(tuple(begun), tuple(original)); assert.ok(begun.transferId);
  assert.equal(begun.fileCount, payloads.length); assert.equal(begun.totalBytes, payloads.reduce((n, f) => n + f.buffer.length, 0));
  const offsets = payloads.map(() => 0), receipts = [];
  let previousIndex = 0;
  for (const row of rows.slice(1)) {
    assert.ok(["humanFileChunk", "humanFileCommit"].includes(row.operation));
    assert.deepEqual(tuple(row), tuple(original)); assert.equal(row.transferId, begun.transferId);
    const received = replies(row); assert.equal(received.length, 1, "Every actually sent request must retain its actual response");
    receipts.push(received[0]);
    if (row.operation === "humanFileChunk") {
      assert.ok(row.fileIndex >= previousIndex); previousIndex = row.fileIndex;
      const file = payloads[row.fileIndex]; assert.ok(file);
      assert.equal(row.offset, offsets[row.fileIndex]); assert.ok(row.dataBytes > 0 && row.dataBytes <= 16384);
      assert.equal(row.dataSHA256, sha(file.buffer.subarray(row.offset, row.offset + row.dataBytes)));
      offsets[row.fileIndex] += row.dataBytes; assert.ok(offsets[row.fileIndex] <= file.buffer.length);
      if (!received[0].error) assert.deepEqual(received[0].result.fileChunk, { ...tuple(original), transferId: begun.transferId, fileIndex: row.fileIndex, nextOffset: offsets[row.fileIndex] });
      else assert.equal(committed, false, "A normal complete transfer cannot contain a failed chunk");
    }
  }
  const commits = rows.filter(row => row.operation === "humanFileCommit");
  assert.equal(commits.length, committed ? 1 : 0, "No original commit or cut-like effect may be replayed");
  if (committed) {
    assert.equal(rows.at(-1), commits[0], "Commit must follow every original chunk");
    assert.deepEqual(offsets, payloads.map(file => file.buffer.length));
    const result = replies(commits[0])[0]; assert.equal(result.error, undefined);
    assert.deepEqual(result.result.fileChooserReceipt, { ...tuple(original), transferId: begun.transferId, acknowledged: true });
  }
  return { transferId: begun.transferId, requests: rows.map(row => row.id), bytesSent: offsets, commits: commits.length, receipts };
}

export function proveManagedFileOpening({ events, pending, original, documents, webFrames, target, begunAt, clickedAt = begunAt }) {
  assert.equal(pending.leaseId, original.leaseId); assert.equal(pending.generation, original.generation);
  const emitter = documents.find(row => row.state.role === (documents.length === 2 ? "leaf" : "root"));
  const root = documents.find(row => row.state.role === "root");
  assert.ok(emitter && root); const web = webFrames.find(row => row.documentId === emitter.documentId);
  const webRoot = webFrames.find(row => row.documentId === root.documentId);
  assert.ok(web && webRoot); assert.equal(web.url, emitter.url); assert.equal(webRoot.frameId, 0);
  assert.ok([web.processId, webRoot.processId].every(value => Number.isSafeInteger(value) && value >= 0));
  const openings = events.filter(row => row.method === "Page.fileChooserOpened" && row.at >= clickedAt);
  assert.equal(openings.length, 1); const opening = openings[0];
  if (opening.source.targetId !== undefined) assert.equal(opening.source.targetId, target.id);
  if (opening.source.tabId !== undefined) assert.equal(opening.source.tabId, target.tabId);
  assert.ok(opening.source.targetId !== undefined || opening.source.tabId !== undefined);
  if (pending.directory === true) assert.ok(["selectSingle", "selectMultiple"].includes(opening.params.mode));
  else assert.equal(opening.params.mode, pending.multiple ? "selectMultiple" : "selectSingle");
  assert.ok(Number.isSafeInteger(opening.params.backendNodeId) && opening.params.backendNodeId > 0);
  const rootContext = originalDefaultContext(events, target, null, target.id, begunAt, opening);
  assert.equal(rootContext.origin, new URL(root.url).origin);
  const context = emitter === root ? rootContext : originalDefaultContext(events, target, opening.source.sessionId, opening.params.frameId, begunAt, opening);
  assert.equal(context.origin, new URL(emitter.url).origin, "This HTTP fixture's native policy origin must match its original document");
  assert.deepEqual(pending.source, { origin: context.origin, frame: emitter === root ? "top-level" : "child" });
  if (emitter === root) { assert.equal(opening.params.frameId, target.id); assert.equal(opening.source.sessionId, undefined); }
  else {
    assert.notEqual(web.processId, webRoot.processId, "Actual OOPIF process separation required");
    assert.ok(opening.source.sessionId);
    const attached = events.filter(row => row.method === "Target.attachedToTarget" &&
      row.params.sessionId === opening.source.sessionId && row.sequence < opening.sequence && row.at >= begunAt);
    assert.equal(attached.length, 1); assert.equal(attached[0].source.targetId, target.id);
    assert.equal(attached[0].params.targetInfo.targetId, opening.params.frameId);
    assert.equal(attached[0].params.targetInfo.url, emitter.url); assert.equal(attached[0].params.targetInfo.type, "iframe");
    assert.equal(events.some(row => row.method === "Target.detachedFromTarget" && row.params.sessionId === opening.source.sessionId &&
      row.sequence > attached[0].sequence && row.sequence < opening.sequence), false);
  }
  return { opening, documentId: emitter.documentId, processId: web.processId, rootProcessId: webRoot.processId,
    source: pending.source, nativeDefaultContext: context, rootDefaultContext: rootContext,
    actualOrigins: emitter === root ? [context.origin] : [context.origin, rootContext.origin] };
}

export function assertManagedFileWorkflowFinalFixtures(fixtures, results) {
  assert.equal(fixtures.length, 4); assert.equal(results.length, 4);
  assert.deepEqual(fixtures.map(value => value.kind).sort(), ["oopif", "root", "transfer-end", "transfer-navigation"]);
  for (const fixture of fixtures) {
    const row = results.find(value => value.kind === fixture.kind); assert.ok(row);
    assert.equal(fixture.overflow, false);
    const success = ["root", "oopif"].includes(fixture.kind);
    assert.equal(fixture.requests.filter(value => value.method === "POST").length, success ? 1 : 0);
    assert.equal(fixture.posted, success);
    assert.deepEqual(fixture.receipt, success ? row.receipt : null);
    if (success) {
      assert.equal(fixture.receipt?.ok, true); assert.equal(fixture.receipt.posts, 1);
      assert.ok(row.submitStartedAt >= row.endedAt);
      assert.ok(fixture.requests.find(value => value.method === "POST").at >= row.submitStartedAt);
    }
    const paths = fixture.requests.map(value => [value.method, value.path]);
    const expected = [["GET", new URL(fixture.urls.root).pathname]];
    if (fixture.kind === "oopif") expected.push(["GET", new URL(fixture.urls.emitter).pathname]);
    if (fixture.kind === "transfer-navigation") expected.push(["GET", new URL(fixture.urls.gate).pathname], ["GET", new URL(fixture.urls.landed).pathname]);
    if (success) expected.push(["POST", new URL(fixture.urls.receipt).pathname]);
    assert.deepEqual(paths, expected, "No extra request may arrive between business proof and real fixture close");
    for (const hit of fixture.requests) {
      assert.equal(hit.status, 200); assert.equal(hit.finished, true); assert.equal(hit.aborted, false);
      assert.equal(hit.validationError, undefined);
    }
  }
  return { verified: true, fixtureCount: fixtures.length, originalPosts: fixtures.reduce((n, value) => n + value.requests.filter(row => row.method === "POST").length, 0) };
}

export async function resumeManagedFileWorkflowOriginals(io, cases, results) {
  await io.resumeAgent(); // Explicit viewer Resume and the actual new SDK turn must both settle.
  const targetIdentity = value => ({ id: value.id, tabId: value.tabId, url: value.url });
  const placement = value => {
    const { tab, window } = value;
    assert.equal(tab?.id, value.tabId);
    assert.ok(Number.isSafeInteger(tab?.windowId) && tab.windowId >= 0);
    assert.ok(Number.isSafeInteger(tab?.groupId) && tab.groupId >= -1);
    assert.equal(window?.id, tab.windowId);
    for (const flag of [tab.active, tab.pinned, window.focused]) assert.equal(typeof flag, "boolean");
    assert.equal(typeof window.type, "string"); assert.equal(typeof window.state, "string");
    return { tab: { id: tab.id, windowId: tab.windowId, groupId: tab.groupId, active: tab.active, pinned: tab.pinned },
      window: { id: window.id, type: window.type, state: window.state, focused: window.focused } };
  };
  const documents = rows => rows.map(({ documentId, frameId, url, state, files, receipt }) =>
    ({ documentId, frameId, url, state, files, receipt })).sort((a, b) => a.frameId - b.frameId);
  for (const item of cases.filter(value => ["root", "oopif"].includes(value.fixture.kind))) {
    const row = results.find(value => value.kind === item.fixture.kind);
    row.claim = { startedAt: Date.now(), requestedTabId: item.tabId };
    row.claim.beforeTarget = await io.originalTarget(item);
    assert.deepEqual(targetIdentity(row.claim.beforeTarget), targetIdentity(item.target));
    const beforePlacement = placement(row.claim.beforeTarget);
    row.claim.beforeDocuments = await io.read(item);
    assert.deepEqual(documents(row.claim.beforeDocuments), documents(row.afterCancel ?? row.after));
    // finalizeTabs(deliverable) removed task ownership. A local SDK tab handle
    // does not reclaim that original page; only this public call does.
    row.claim.receipt = await io.claimOriginal(item);
    row.claim.acknowledgedAt = Date.now();
    assert.equal(row.claim.receipt.id, item.tabId); assert.equal(row.claim.receipt.url, item.target.url);
    row.claim.afterTarget = await io.originalTarget(item);
    assert.deepEqual(targetIdentity(row.claim.afterTarget), targetIdentity(item.target));
    row.claim.afterDocuments = await io.read(item);
    assert.deepEqual(documents(row.claim.afterDocuments), documents(row.claim.beforeDocuments),
      "Claim must preserve the original documents, FileList and events before submission");
    assert.deepEqual(placement(row.claim.afterTarget), beforePlacement,
      "Explicit claim must preserve original window, group, tab activation and window focus");
    row.claim.placementUnchanged = true;
    row.claim.verifiedAt = Date.now(); row.beforeSubmit = row.claim.afterDocuments;
    row.submitStartedAt = Date.now(); await io.submitOriginal(item, row);
    row.receipt = await io.wait(() => item.fixture.stats().receipt, "one original post after End");
    assert.equal(row.receipt.posts, 1);
    row.afterSubmit = await io.wait(async () => {
      const rows = await io.read(item), emitter = rows.find(value => value.state.role === (row.kind === "oopif" ? "leaf" : "root"));
      assert.notEqual(emitter.state.phase, "failed", emitter.state.error);
      return emitter.state.phase === "committed" && rows;
    }, "original page consumed its one POST response");
  }
}

// A scenario owns no browser/process lifecycle. All IO passes through the
// baseline runner's existing original-session facade.
export async function runManagedFileWorkflow(io, cases) {
  const results = [];
  for (const item of cases) {
    const row = { kind: item.fixture.kind, tabId: item.tabId, startedAt: Date.now(), instrumented: Boolean(io.instrumented) };
    results.push(row); io.record(results);
    row.begin = await io.begin(item); row.lease = structuredClone(io.state().human);
    assert.ok([1, 2].includes(row.lease.fileChooserVersion));
    row.before = await io.read(item); row.webFrames = await io.webFrames(item);
    row.click = await io.clickInput(item, row.before);
    row.pending = await io.wait(() => io.state()?.pendingFileChooser, "original pending chooser");
    if (row.lease.fileChooserVersion === 2) assert.equal(row.pending.directory, false);
    row.nativeProof = proveManagedFileOpening({ events: await io.nativeEvents(), pending: row.pending, original: row.lease,
      documents: row.before, webFrames: row.webFrames, target: item.target, begunAt: row.startedAt, clickedAt: row.click.startedAt });
    row.payloads = managedFileWorkflowPayloads(row.kind).map(file => ({ name: file.name, bytes: file.buffer.length, sha256: sha(file.buffer) }));
    await io.screenshot("pending-" + row.kind);
    const payloads = managedFileWorkflowPayloads(row.kind);
    row.picker = await io.pick(payloads);
    if (row.kind === "root" || row.kind === "oopif") {
      row.commitReply = await io.waitReply("humanFileCommit", row.pending, 30000);
      row.after = await io.read(item);
      const leaf = row.after.find(value => value.state.role === (row.kind === "oopif" ? "leaf" : "root"));
      assert.deepEqual(leaf.files.map(file => [file.name, file.size]), payloads.map(file => [file.name, file.buffer.length]));
      assert.equal(leaf.state.events.filter(event => event.type === "change").length, 1);
      assert.ok(leaf.state.events.every(event => event.trusted)); assert.equal(leaf.state.posts, 0);
      row.transfer = assertManagedFileTransferLedger(io.commands(), io.messages(), row.pending, payloads, true);
      row.deliveredFiles = await io.transferFiles(row.transfer.transferId, payloads);
      if (row.kind === "root") {
        row.cancelClick = await io.clickInput(item, row.after);
        row.cancelPending = await io.wait(() => io.state()?.pendingFileChooser, "second original chooser to cancel");
        assert.notEqual(row.cancelPending.chooserId, row.pending.chooserId);
        row.cancelNativeProof = proveManagedFileOpening({ events: await io.nativeEvents(), pending: row.cancelPending, original: row.lease,
          documents: row.after, webFrames: await io.webFrames(item), target: item.target, begunAt: row.startedAt, clickedAt: row.cancelClick.startedAt });
        row.cancelReply = await io.uiAction("#file-cancel", "humanFileCancel");
        assert.deepEqual(row.cancelReply.fileChooserCancellation, { ...tuple(row.cancelPending), cancelled: true });
        row.afterCancel = await io.read(item);
        assert.deepEqual(row.afterCancel[0].files, leaf.files);
        assert.equal(row.afterCancel[0].state.events.filter(event => ["input", "change"].includes(event.type)).length,
          leaf.state.events.filter(event => ["input", "change"].includes(event.type)).length);
      }
      row.end = await io.end(row.lease);
      row.filesAfterEnd = await io.transferFiles(row.transfer.transferId, payloads);
    } else {
      row.firstChunk = await io.wait(() => io.commands().find(value => value.operation === "humanFileChunk" && value.chooserId === row.pending.chooserId), "first original chunk");
      assert.equal(io.commands().some(value => value.operation === "humanFileCommit" && value.chooserId === row.pending.chooserId), false, "If transfer already committed, fail; never replay");
      if (row.kind === "transfer-navigation") {
        row.fixtureNavigationReleasedAt = Date.now(); item.fixture.releaseNavigation();
        row.landed = await io.wait(async () => {
          const documents = await io.read(item, false); return documents.find(value => value.state.role === "landed") ?? false;
        }, "original document navigated during transfer");
        assert.notEqual(row.landed.documentId, item.before[0].documentId);
      }
      row.end = await io.end(row.lease);
      await io.wait(() => !io.pagePending(), "viewer file requests actually settled after retirement");
      row.transfer = assertManagedFileTransferLedger(io.commands(), io.messages(), row.pending, payloads, false);
      row.stagingRemoved = await io.waitTransferRemoved(row.transfer.transferId);
      assert.equal(item.fixture.stats().posted, false);
      if (row.kind === "transfer-end") { row.after = await io.read(item); assert.deepEqual(row.after[0].files, []); }
    }
    await io.screenshot("ended-" + row.kind);
    row.endedAt = Date.now(); io.record(results);
  }
  await resumeManagedFileWorkflowOriginals(io, cases, results);
  const nativeEvents = await io.nativeEvents();
  assert.equal(nativeEvents.filter(value => value.method === "Page.fileChooserOpened").length, 5);
  for (const row of results) {
    assertManagedFileTransferLedger(io.commands(), io.messages(), row.pending, managedFileWorkflowPayloads(row.kind), ["root", "oopif"].includes(row.kind));
    const inputs = io.commands().filter(value => value.operation === "humanInput" && value.leaseId === row.lease.leaseId);
    assert.deepEqual(inputs.map(value => value.id), [...row.click.inputRequests, ...(row.cancelClick?.inputRequests ?? [])]);
    assert.deepEqual(inputs.map(value => value.sequence), inputs.map((_value, i) => i + 1));
    const fixture = cases.find(item => item.fixture.kind === row.kind).fixture;
    assert.equal(fixture.stats().overflow, false);
    assert.equal(fixture.stats().requests.filter(value => value.method === "POST").length, ["root", "oopif"].includes(row.kind) ? 1 : 0);
  }
  io.record(results);
  return results;
}

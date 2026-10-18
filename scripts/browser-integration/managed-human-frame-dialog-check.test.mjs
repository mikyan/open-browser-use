import assert from "node:assert/strict";
import test from "node:test";
import { proveManagedFrameDialogDocuments, managedFrameDialogRootPoint, assertManagedFrameDialogPair, classifyManagedFrameDialog, assertManagedFrameDialogMode, projectManagedFrameDialogEvent, assertManagedFrameDialogSourceBinding, managedFrameDialogEndReady, managedFrameDialogDocumentsReady } from "./managed-human-frame-dialog-check.mjs";
import { managedDialogUnicode } from "./managed-dialog-fixture.mjs";

function fixture(layout = "nested") {
  const roles = layout === "root" ? ["root"] : layout === "nested" ? ["root", "middle", "leaf"] : ["root", "leaf"];
  const f = { layout, roles, workflowId: "original", urls: Object.fromEntries(roles.map(role => [role, `http://${layout === "oopif" && role === "leaf" ? "localhost" : "127.0.0.1"}:50000/${role}`])) };
  const frames = roles.map((role, i) => ({ frameId: i, parentFrameId: i - 1, documentId: `document-${i}`, processId: layout === "oopif" && i ? 20 : 10, documentLifecycle: "active", url: f.urls[role] }));
  const documents = frames.map((frame, i) => ({ ...frame, state: { workflowId: f.workflowId, role: roles[i], documentToken: `token-${i}` } }));
  let child; for (let i = roles.length - 1; i >= 0; i--) child = { frame: { id: `native-${i}`, loaderId: `loader-${i}`, url: frames[i].url }, ...(child ? { childFrames: [child] } : {}) };
  return { f, frames, documents, tree: { frameTree: child }, target: { id: "native-0" } };
}

test("independent source binding must identify this exact manifest, executable and complete source set", () => {
  const build = { exeSHA256: "exe", sourceInputs: { "first.js": "a", "second.js": "b" }, extensionFiles: { "first.js": "a" } };
  const value = { passed: true, commit: "a".repeat(40), manifestSHA256: "manifest", exeSHA256: "exe", sourceSnapshots: 2, gitCleanMatches: 2, extensionFiles: 1, limit: "Independent report, not the build's recorded base field" };
  assert.equal(assertManagedFrameDialogSourceBinding(value, build, "manifest").commit, value.commit);
  for (const change of [{ passed: false }, { commit: "base" }, { manifestSHA256: "other" }, { exeSHA256: "other" }, { sourceSnapshots: 1 }, { gitCleanMatches: 1 }, { extensionFiles: 2 }]) assert.throws(() => assertManagedFrameDialogSourceBinding({ ...value, ...change }, build, "manifest"));
});

function ended(leaseId = "current") { return { human: null, pendingDialog: null, status: { state: "paused" }, viewerCleanupComplete: true, humanCleanup: { leaseId, cleanupConfirmed: true } }; }
test("automatic End ignores the previous lease cleanup in an intermediate state", () => {
  assert.equal(managedFrameDialogEndReady({ ...ended("previous"), viewerCleanupComplete: false }, "current"), false);
  assert.equal(managedFrameDialogEndReady(ended("previous"), "current"), false);
});
test("automatic End waits for every original cleanup field and returns a detached snapshot", () => {
  for (const change of [{ viewerCleanupComplete: false }, { pendingDialog: { dialogId: "old" } }, { status: { state: "ready" } }, { human: { leaseId: "current" } }, { humanCleanup: { leaseId: "current", cleanupConfirmed: false } }]) assert.equal(managedFrameDialogEndReady({ ...ended(), ...change }, "current"), false);
  const state = ended(), got = managedFrameDialogEndReady(state, "current"); assert.deepEqual(got, state); assert.notEqual(got, state); assert.notEqual(got.humanCleanup, state.humanCleanup);
});
function documentRead() {
  const x = fixture("same"); x.f.emitterRole = "leaf";
  for (const row of x.documents) Object.assign(row.state, { phase: row.state.role === "leaf" ? "committed" : "container", error: null });
  return { documents: x.documents, business: { before: structuredClone(x.documents) }, fixture: x.f };
}
test("a server POST receipt waits for its original document to process the response", () => {
  const x = documentRead(); x.documents.at(-1).state.phase = "posting";
  assert.equal(managedFrameDialogDocumentsReady(x.documents, x.business, x.fixture), false);
  x.documents.at(-1).state.phase = "committed";
  assert.deepEqual(managedFrameDialogDocumentsReady(x.documents, x.business, x.fixture), x.documents);
});
test("the POST response wait rejects document replacement and page failures instead of replaying", () => {
  for (const mutate of [x => { x.documents.at(-1).documentId = "replacement"; }, x => { x.documents.at(-1).state.documentToken = "replacement"; }, x => { x.documents.at(-1).state.error = "fetch failed"; }, x => { x.documents.at(-1).state.phase = "failed"; }]) {
    const x = documentRead(); mutate(x); assert.throws(() => managedFrameDialogDocumentsReady(x.documents, x.business, x.fixture));
  }
});
test("root, same, nested and actual OOPIF document proofs retain native and browser identities", () => {
  for (const layout of ["root", "same", "nested", "oopif"]) { const { f, frames, documents, tree, target } = fixture(layout); assert.equal(proveManagedFrameDialogDocuments(f, frames, documents, tree, target).length, f.roles.length); }
});
test("proof rejects wrong parents, replaced documents, stale loaders and fake OOPIF process separation", () => {
  for (const mutate of [x => { x.frames[1].parentFrameId = -1; }, x => { x.documents[1].documentId = "replaced"; }, x => { x.tree.frameTree.childFrames[0].frame.loaderId = ""; }, x => { x.frames[1].processId = 10; }]) {
    const x = fixture("oopif"); mutate(x); assert.throws(() => proveManagedFrameDialogDocuments(x.f, x.frames, x.documents, x.tree, x.target));
  }
});
test("root tree omission preserves the real OOPIF but cannot supply a native emitter identity", () => {
  const x = fixture("oopif"); delete x.tree.frameTree.childFrames;
  const proof = proveManagedFrameDialogDocuments(x.f, x.frames, x.documents, x.tree, x.target);
  assert.equal(proof.at(-1).nativeTreeWitness, "missing-remote-frame"); assert.equal(proof.at(-1).nativeFrameId, null);
  assert.equal(proof.at(-1).documentId, x.frames.at(-1).documentId); assert.notEqual(proof.at(-1).processId, proof[0].processId);
  const { record } = pair(); assert.throws(() => assertManagedFrameDialogPair(record, { target: x.target, proof }, []), /Missing native emitter proof/);
});
test("passive Runtime projection preserves default-context origin identity without script strings", () => {
  const source = { targetId: "original", sessionId: "child" };
  const value = projectManagedFrameDialogEvent(source, "Runtime.executionContextCreated", { context: { id: 7, uniqueId: "unique", origin: "http://localhost:50000", name: "exclude", auxData: { frameId: "frame", isDefault: true, type: "default", secret: "exclude" }, expression: "exclude" }, expression: "exclude" });
  assert.deepEqual(value, { source, method: "Runtime.executionContextCreated", params: { context: { id: 7, uniqueId: "unique", origin: "http://localhost:50000", auxData: { isDefault: true, type: "default", frameId: "frame" } } } });
  assert.deepEqual(projectManagedFrameDialogEvent(source, "Runtime.executionContextDestroyed", { executionContextId: 7, executionContextUniqueId: "unique", expression: "exclude" }).params, { executionContextId: 7, executionContextUniqueId: "unique" });
  assert.deepEqual(projectManagedFrameDialogEvent(source, "Runtime.executionContextsCleared", { expression: "exclude" }).params, {});
  assert.equal(projectManagedFrameDialogEvent(source, "Debugger.scriptParsed", { script: "exclude" }), null);
});
test("nested point projection uses measured content offsets and refuses clipping", () => {
  const outer = { id: "child", clickable: true, rect: { x: 10, y: 20 }, contentOffset: { x: 2, y: 2 }, contentSize: { width: 250, height: 180 }, viewport: { width: 500, height: 300 } };
  const leaf = { id: "prompt", clickable: true, point: { x: 40, y: 40 } };
  assert.deepEqual(managedFrameDialogRootPoint([outer, outer, leaf]), { x: 64, y: 84 });
  assert.throws(() => managedFrameDialogRootPoint([outer, { ...leaf, point: { x: 260, y: 40 } }]));
});
function pair() {
  const x = fixture("same"), proof = proveManagedFrameDialogDocuments(x.f, x.frames, x.documents, x.tree, x.target);
  const business = { proof, target: x.target, tabId: 10, humanStartedAt: 500 };
  const record = { originalScope: { leaseId: "lease", generation: 1 }, pendingDialog: { dialogId: "dialog" },
    opening: { method: "Page.javascriptDialogOpening", sequence: 1, at: 1000, source: { targetId: x.target.id }, params: { frameId: proof.at(-1).nativeFrameId, type: "prompt", url: proof.at(-1).url } },
    closed: { method: "Page.javascriptDialogClosed", sequence: 2, at: 1100, source: { targetId: x.target.id }, params: { frameId: proof.at(-1).nativeFrameId, result: true, userInput: managedDialogUnicode } },
    request: { operation: "humanDialogRespond", at: 1099, leaseId: "lease", generation: 1, dialogId: "dialog" } };
  return { business, record };
}
test("a frame dialog requires exact original emitter and source, not a matching URL alone", () => {
  const { business, record } = pair(); assert.equal(assertManagedFrameDialogPair(record, business, []).answered, true);
  for (const mutate of [x => { x.opening.source.tabId = 99; }, x => { x.opening.source.extensionId = "foreign"; }, x => { x.opening.params.frameId = business.target.id; }, x => { x.request.dialogId = "other"; }, x => { x.request.at = 6000; }]) { const changed = structuredClone(record); mutate(changed); assert.throws(() => assertManagedFrameDialogPair(changed, business, [])); }
});
test("child session routing requires a live original attachedToTarget witness", () => {
  const { business, record } = pair(); record.opening.source.sessionId = record.closed.source.sessionId = "child-session";
  record.opening.sequence = 2; record.closed.sequence = 3;
  const attached = { method: "Target.attachedToTarget", sequence: 1, at: 600, source: { targetId: business.target.id }, params: { sessionId: "child-session", targetInfo: { type: "iframe", targetId: business.proof.at(-1).nativeFrameId, url: business.proof.at(-1).url } } };
  assert.equal(assertManagedFrameDialogPair(record, business, [attached]).answered, true);
  assert.throws(() => assertManagedFrameDialogPair(record, business, []));
  assert.throws(() => assertManagedFrameDialogPair(record, business, [{ ...attached, at: 499 }]));
  assert.throws(() => assertManagedFrameDialogPair(record, business, [attached, { method: "Target.detachedFromTarget", sequence: 2, params: { sessionId: "child-session" } }]));
});
test("a null POST without native dialog evidence never counts as answering", () => {
  assert.equal(classifyManagedFrameDialog({ receipt: { answer: null }, pendingSeen: false }), "native-dialog-not-observed");
  assert.throws(() => classifyManagedFrameDialog({ receipt: { answer: managedDialogUnicode }, pendingSeen: false }));
  assert.throws(() => classifyManagedFrameDialog({ receipt: { answer: null }, pendingSeen: true }));
  const outcomes = ["root", "same", "nested", "oopif"].map(layout => ({ layout, outcome: "native-dialog-not-observed" }));
  assert.equal(assertManagedFrameDialogMode("diagnostic", outcomes).diagnosticCompleted, true); assert.throws(() => assertManagedFrameDialogMode("acceptance", outcomes));
  for (const row of outcomes.slice(0, 3)) row.outcome = "answered";
  assert.deepEqual(assertManagedFrameDialogMode("acceptance", outcomes).acceptedLayouts, ["root", "same", "nested"]);
});

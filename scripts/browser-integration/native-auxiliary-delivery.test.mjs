import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { assertInterruptedDeliveryHeld, assertInterruptedDeliveryState, assertInterruptedDeliveryRuntime,
  assertInterruptedDeliveryDocuments, assertInterruptedDeliveryTiming, assertInterruptedDeliveryOutcome, checkNativeInterruptedPopupDelivery } from "./native-auxiliary-delivery.mjs";

// Evidence acceptance tests only. These are deliberately not browser/native-host
// acceptance and do not simulate the helper's entire successful orchestration.
const copy = value => structuredClone(value);
const describe = value => { const bytes = Buffer.from(value); return { bytes: bytes.length, base64: bytes.toString("base64"), sha256: createHash("sha256").update(bytes).digest("hex") }; };
function fixture(phase = "claim-delete", interruption = "host-loss") {
  const scope = { session_id: "original", turn_id: "business", control_epoch: 7 };
  const source = { id: 10, windowId: 2, active: true, groupId: -1, pinned: false, url: "http://127.0.0.1/source" };
  const child = { id: 11, windowId: 1, active: false, groupId: -1, pinned: false, url: "http://127.0.0.1/created-page/child" };
  const sentinel = { id: 9, windowId: 1, active: true, groupId: -1, pinned: false, url: "http://127.0.0.1/sentinel" };
  const claim = (tab, kind) => ({ ...scope, claimId: kind + "-original", tabId: tab.id, windowId: tab.windowId, phase: "committed", kind, origin: "user" });
  const sourceClaim = claim(source, "popup"), childClaim = claim(child, "created-page");
  const item = { scope, tabId: source.id, childId: child.id, workTabId: 12, sourceWindow: { id: 2 }, destinationWindow: { id: 1 }, sentinel,
    sourceURL: source.url, childURL: child.url, childBirth: child, sourceOwnership: { owner: sourceClaim }, childOwnership: { owner: childClaim } };
  const native = { tabs: [source, child, sentinel], windows: [{ id: 1, type: "normal", focused: true, state: "normal" }, { id: 2, type: "popup", focused: false, state: "normal" }], targets: [] };
  const marker = tab => ({ windowId: tab.windowId, groupId: tab.groupId, pinned: tab.pinned, deliveryId: "delivery-" + tab.id, deliveredAt: 100 });
  const markers = phase === "marker-write" ? { 10: marker(source), 11: marker(child) } : {};
  const heldState = { native: copy(native), ownership: [
    { tabId: 10, owner: null, entry: phase === "claim-delete" ? { ...sourceClaim, phase: "quarantined" } : null, stored: [] },
    { tabId: 11, owner: phase === "claim-delete" ? childClaim : null, entry: phase === "claim-delete" ? childClaim : null, stored: phase === "claim-delete" ? [childClaim] : [] },
  ], delivery: copy(markers), storedDelivery: copy(markers) };
  const args = phase === "claim-delete" ? { omitted: [{ tabId: 10, claimId: sourceClaim.claimId }], selectedRemaining: [{ tabId: 11, claimId: childClaim.claimId, phase: "committed" }] } : { markers: Object.entries(markers).map(([id, value]) => ({ tabId: Number(id), ...value })) };
  const snapshot = { scope, stage: phase, tabIds: [10, 11], overflow: false, errors: [],
    gate: { operationId: 1, held: true, nativeSettled: true, released: false, published: false, gateTabId: phase === "claim-delete" ? 10 : undefined, nativeSequence: 2, heldSequence: 3 },
    records: [{ kind: "call", operationId: 1, sequence: 1, selectedGate: true, args }, { kind: "native-fulfilled", operationId: 1, sequence: 2 }, { kind: "held", operationId: 1, sequence: 3 }],
    current: { ending: true, finalizing: phase === "marker-write", sameIncarnation: true, claims: [10, 11].map(tabId => ({ tabId, replaced: false, proofPresent: true })) } };
  const retained = phase === "claim-delete" && interruption === "host-loss", retainedMarkers = phase === "marker-write" && interruption === "worker-stop";
  const state = { native: copy(native), ownership: [
    { tabId: 10, owner: null, entry: null, stored: [] },
    { tabId: 11, owner: retained ? childClaim : null, entry: retained ? childClaim : null, stored: retained ? [childClaim] : [] },
  ], delivery: retainedMarkers ? copy(markers) : {}, storedDelivery: retainedMarkers ? copy(markers) : {} };
  return { item, phase, interruption, snapshot, heldState, state, held: heldState };
}

for (const phase of ["claim-delete", "marker-write"]) for (const interruption of ["host-loss", "worker-stop"]) {
  test(`${phase}/${interruption} preserves its distinct partial-disposition contract`, () => {
    const f = fixture(phase, interruption);
    assertInterruptedDeliveryHeld({ ...f, state: f.heldState });
    assert.deepEqual(assertInterruptedDeliveryState(f), { retainedChild: phase === "claim-delete" && interruption === "host-loss", markerRetained: phase === "marker-write" && interruption === "worker-stop" });
  });
}

for (const [name, change] of [
  ["last child gate cannot replace the first source deletion", f => { f.snapshot.gate.gateTabId = 11; }],
  ["two deleted claims are not the partial batch boundary", f => { f.snapshot.records[0].args.selectedRemaining = []; }],
  ["native pending cannot count as a real ACK", f => { f.snapshot.gate.nativeSettled = false; }],
  ["already published result is no longer held", f => { f.snapshot.gate.published = true; }],
  ["timer expiry cannot masquerade as intentional interruption", f => { f.snapshot.gate.timedOut = true; }],
  ["failure cannot be relabeled success", f => { f.snapshot.records[1].kind = "native-rejected"; }],
  ["wrong ACK order", f => { f.snapshot.records[1].sequence = 4; }],
  ["claim replacement", f => { f.snapshot.current.claims[1].replaced = true; }],
  ["foreign original scope", f => { f.snapshot.scope = { ...f.snapshot.scope, session_id: "foreign" }; }],
  ["missing native work-page close", f => { f.heldState.native.tabs.push({ id: 12 }); }],
  ["in-memory removal without durable source deletion", f => { f.heldState.ownership[0].stored = [f.item.sourceOwnership.owner]; }],
  ["observer overflow", f => { f.snapshot.overflow = true; }],
]) test(`held evidence refuses ${name}`, () => {
  const f = fixture(); change(f); assert.throws(() => assertInterruptedDeliveryHeld({ ...f, state: f.heldState }));
});

test("host loss cannot be reported as if a collected original child was revoked", () => {
  const f = fixture(); f.state.ownership[1] = { tabId: 11, owner: null, entry: null, stored: [] };
  assert.throws(() => assertInterruptedDeliveryState(f), /retains/);
});
test("worker loss cannot inherit the collected child's durable authority", () => {
  const f = fixture("claim-delete", "worker-stop"); f.state.ownership[1] = copy(f.heldState.ownership[1]);
  assert.throws(() => assertInterruptedDeliveryState(f));
});
test("marker survives worker destruction strictly as presentation, not authority", () => {
  const f = fixture("marker-write", "worker-stop"); f.state.ownership[1].owner = f.item.childOwnership.owner;
  assert.throws(() => assertInterruptedDeliveryState(f));
});
for (const [name, change] of [
  ["host rollback left stale persisted marker", f => { f.state.storedDelivery = copy(f.heldState.storedDelivery); }],
  ["page moved to another group", f => { f.state.native.tabs[1].groupId = 44; }],
  ["page was replaced", f => { f.state.native.tabs[1].id = 55; }],
  ["source focused", f => { f.state.native.windows[1].focused = true; }],
  ["remaining debugger attachment", f => { f.state.native.targets.push({ tabId: 11, attached: true }); }],
]) test(`retirement refuses ${name}`, () => {
  const f = fixture("marker-write", "host-loss"); change(f); assert.throws(() => assertInterruptedDeliveryState(f));
});
test("a replacement presentation marker is not the original interrupted delivery", () => {
  const f = fixture("marker-write", "worker-stop"); f.state.delivery[11].deliveryId = "replacement"; f.state.storedDelivery[11].deliveryId = "replacement";
  assert.throws(() => assertInterruptedDeliveryState(f), /original delivery identity/);
});

function runtime(interruption) {
  const before = { browserPid: 1, browserId: "browser", extensionId: "extension", extensionInstanceId: "instance", incarnation: "same-browser-lifetime", observerTarget: "persistent", workerTarget: "worker-one", contextId: "context-one", lifecycle: { bootId: "boot-one" }, host: { pid: 3, socketPath: "pipe-one" } };
  const after = { ...copy(before), host: { pid: 4, socketPath: "pipe-two" } };
  if (interruption === "worker-stop") Object.assign(after, { workerTarget: "worker-two", contextId: "context-two", lifecycle: { bootId: "boot-two" } });
  return { before, after };
}
for (const interruption of ["host-loss", "worker-stop"]) test(`native runtime ${interruption} has exact generation boundaries`, () => {
  const { before, after } = runtime(interruption); assertInterruptedDeliveryRuntime(before, after, interruption);
  const changed = copy(after); changed.incarnation = "extension-reload";
  assert.throws(() => assertInterruptedDeliveryRuntime(before, changed, interruption), /incarnation/);
  changed.incarnation = before.incarnation; changed.host = before.host;
  assert.throws(() => assertInterruptedDeliveryRuntime(before, changed, interruption));
});
test("runtime.reload cannot substitute for actual worker-only stop", () => {
  const { before, after } = runtime("worker-stop"); after.incarnation = "new-incarnation";
  assert.throws(() => assertInterruptedDeliveryRuntime(before, after, "worker-stop"), /incarnation/);
});
test("same worker cannot substitute for stop/start", () => {
  const { before, after } = runtime("host-loss"); assert.throws(() => assertInterruptedDeliveryRuntime(before, after, "worker-stop"));
});

function documentFixture() {
  const { item } = fixture(); item.key = "key"; item.owner = "owner";
  item.sourceFrame = item.rootFrame = { frameId: 0, documentId: "source-document", url: item.sourceURL };
  item.childFrame = { frameId: 0, documentId: "child-document", url: item.childURL };
  item.sourceAfter = item.rootAfter = { sourceNonce: "source-nonce", documentToken: "source-token", clicks: [{ trusted: true, sequence: 1 }], frameAdds: [] };
  item.childBefore = { documentNonce: "child-nonce", documentToken: "child-token" };
  item.childAfter = { ...item.childBefore, clicks: [{ trusted: true, sequence: 1, documentNonce: "child-nonce", documentToken: "child-token" }] };
  item.receipt = { ok: true, key: item.key, owner: item.owner, documentNonce: "child-nonce" };
  const fields = { key: item.key, owner: item.owner, ...item.childBefore, trusted: "true", buttonCount: "1" }, fieldEntries = Object.entries(fields);
  const post = { method: "POST", url: "/created-page/receipt", status: 200, once: true, finished: true, aborted: false,
    body: { ...describe(new URLSearchParams(fieldEntries).toString()), truncated: false }, fieldEntries, fields, response: describe(JSON.stringify(item.receipt)) };
  const html = describe('<html data-nonce="child-nonce"></html>');
  item.originalChild = { nonce: "child-nonce", html, get: { method: "GET", url: "/created-page/child", status: 200, finished: true, aborted: false, response: html }, posts: [post] };
  item.sourceDocuments = [{ nonce: "source-nonce", ...describe("source html") }]; item.serverChildrenAtBusiness = 1;
  const observation = (frame, state, receipt = null) => ({ documentId: frame.documentId, frameId: frame.frameId, result: { href: frame.url, state, receipt } });
  const observations = { source: observation(item.sourceFrame, item.sourceAfter), root: observation(item.rootFrame, item.rootAfter), child: observation(item.childFrame, item.childAfter, item.receipt), sourceFrames: [item.sourceFrame], childFrames: [item.childFrame] };
  const server = { overflow: false, cases: [{ key: item.key, documents: item.sourceDocuments }], children: [item.originalChild] };
  // Native observations and saved HTTP baselines arrive through independent
  // JSON boundaries; they must not share in-memory references in this test.
  return JSON.parse(JSON.stringify({ item, observations, server }));
}
test("read-only document evidence binds the original successful GET/POST and bytes", () => {
  const f = documentFixture(); assert.deepEqual(assertInterruptedDeliveryDocuments(f), { bytes: f.item.originalChild.posts[0].body.bytes, sha256: f.item.originalChild.posts[0].body.sha256 });
});
for (const [name, change] of [
  ["replacement source document", f => { f.observations.source.documentId = "replacement"; }],
  ["changed original child token", f => { f.observations.child.result.state.documentToken = "replacement"; }],
  ["second trusted submit", f => { f.observations.child.result.state.clicks.push(copy(f.observations.child.result.state.clicks[0])); }],
  ["extra original child POST", f => { f.server.children[0].posts.push(copy(f.server.children[0].posts[0])); }],
  ["new child document", f => { f.server.children.push({ nonce: "replacement" }); }],
  ["source HTML replay", f => { f.server.cases[0].documents.push(copy(f.server.cases[0].documents[0])); }],
  ["untrusted original submit despite consistent copied state", f => { f.item.childAfter.clicks[0].trusted = false; f.observations.child.result.state.clicks[0].trusted = false; }],
]) test(`non-replay evidence refuses ${name}`, () => {
  const f = documentFixture(); change(f); assert.throws(() => assertInterruptedDeliveryDocuments(f));
});
test("child response bytes cannot be forged by matching only parsed receipt", () => {
  const f = documentFixture(); for (const child of [f.item.originalChild, f.server.children[0]]) child.posts[0].response.sha256 = "0".repeat(64);
  assert.throws(() => assertInterruptedDeliveryDocuments(f));
});

function timingFixture(interruption) {
  const { snapshot: held } = fixture(); Object.assign(held.gate, { nativeAt: 101, heldAt: 102 }); held.holdTimeoutMs = 20000;
  const before = { host: { pid: 42 }, workerTarget: "original-worker" };
  const evidence = interruption === "host-loss" ? { killed: { pid: 42, requestedAt: 103, exitedAt: 105, exactHandle: true } } : {
    before: copy(before), requestedAt: 103, stopAcknowledgedAt: 105, stopInvocations: 1, version: { versionId: "original-version" },
    workerEvents: [{ method: "ServiceWorker.workerVersionUpdated", params: { versions: [{ versionId: "original-version", runningStatus: "stopped" }] } }],
  };
  return { submittedAt: 100, interruption, evidence, held, before };
}
for (const interruption of ["host-loss", "worker-stop"]) test(`${interruption} must really occur while the original request and after-ACK hold are live`, () => {
  assert.deepEqual(assertInterruptedDeliveryTiming(timingFixture(interruption)), { interruptedAt: 105, originalDeadlineAt: 20100, remainingMs: 19995 });
});
for (const [name, interruption, change] of [
  ["host exit at deadline", "host-loss", f => { f.evidence.killed.exitedAt = 20100; }],
  ["worker stop after deadline", "worker-stop", f => { f.evidence.stopAcknowledgedAt = 20101; }],
  ["host exit timestamp absent", "host-loss", f => { delete f.evidence.killed.exitedAt; }],
  ["worker stop timestamp absent", "worker-stop", f => { delete f.evidence.stopAcknowledgedAt; }],
  ["host killed before gate held", "host-loss", f => { f.evidence.killed.exitedAt = 101; }],
  ["gate auto-expired before worker stop", "worker-stop", f => { f.held.holdTimeoutMs = 2; }],
  ["host gate released while controller was running", "host-loss", f => { f.held.gate.released = true; }],
  ["host gate timeout instead of controller interruption", "host-loss", f => { f.held.gate.timedOut = true; }],
  ["wrong native process handle", "host-loss", f => { f.evidence.killed.pid = 99; }],
  ["wrong worker stopped event", "worker-stop", f => { f.evidence.workerEvents[0].params.versions[0].versionId = "replacement-version"; }],
  ["repeated worker stop", "worker-stop", f => { f.evidence.stopInvocations = 2; }],
]) test(`native interruption evidence refuses ${name}`, () => {
  const f = timingFixture(interruption); change(f); assert.throws(() => assertInterruptedDeliveryTiming(f));
});

test("original SDK deadline has a real non-replay observation interval", () => {
  const value = { submittedAt: 100, observedThrough: 20350, outcome: { fulfilled: false, error: "Error: native socket disconnected", settledAt: 110 } };
  assertInterruptedDeliveryOutcome(value);
  assert.throws(() => assertInterruptedDeliveryOutcome({ ...value, observedThrough: 20349 }), /deadline/);
  assert.throws(() => assertInterruptedDeliveryOutcome({ ...value, outcome: { fulfilled: true, settledAt: 110 } }), /success/);
  assert.throws(() => assertInterruptedDeliveryOutcome({ ...value, outcome: { ...value.outcome, error: "unrelated assertion failed" } }));
});
for (const error of ["Error: native connection timeout", "Error: finalizeTabs timed out after 20000 ms"]) test(`original SDK ${error} cannot replace timely EOF`, () => {
  assert.throws(() => assertInterruptedDeliveryOutcome({ submittedAt: 100, observedThrough: 20350, outcome: { fulfilled: false, error, settledAt: 110 } }), /timeout/);
});
test("a real disconnect result received at the original deadline is too late", () => {
  assert.throws(() => assertInterruptedDeliveryOutcome({ submittedAt: 100, observedThrough: 20350, outcome: { fulfilled: false, error: "Error: native socket disconnected", settledAt: 20100 } }), /original deadline/);
});
test("invalid scene configuration fails before invoking any native controller", async () => {
  let calls = 0; const unexpected = () => { calls++; throw Error("must not run"); };
  const options = { phase: "claim-delete", interruption: "host-loss", variant: "root", connect: unexpected, getWorker: unexpected, createPopup: unexpected, readFocus: unexpected, identity: unexpected, terminateHost: unexpected, reconnectHost: unexpected };
  for (const change of [{ phase: "detach" }, { interruption: "runtime.reload" }, { variant: "unknown" }, { terminateHost: undefined }])
    await assert.rejects(checkNativeInterruptedPopupDelivery({ ...options, ...change }));
  assert.equal(calls, 0);
});

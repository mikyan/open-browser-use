import assert from "node:assert/strict";
import test from "node:test";
import vm from "node:vm";
import { managedReadinessGateCandidate, managedReadinessSource, assertManagedReadinessNativeBoundary, assertManagedReadinessInputOutcome,
  assertManagedReadinessAdmission, managedReadinessPendingObservation, assertManagedReadinessCurrentDialog,
  projectManagedReadinessTabUpdate, installReadinessObservation, assertManagedReadinessDialogRequest } from "./managed-human-readiness-dialog-check.mjs";
import { projectManagedOopifEvent, managedOopifWebNavigationEvents } from "./managed-human-oopif-dialog-evidence.mjs";
import { projectHumanDialogCommand } from "./managed-human-dialog-check.mjs";
import { managedReadinessDialogUnicode } from "./managed-human-readiness-dialog-fixture.mjs";

const business = { tabId: 7, target: { id: "root" }, observerBoundary: { sequence: 10 } };
const source = { targetId: "root" }, sourceURL = "http://127.0.0.1:55000/source", emitterURL = "http://127.0.0.1:55000/destination";
function admittedBusiness() {
  const selected = { workerBootId: "worker", eventSequence: 2, selectedTabId: 7, view: { state: "active", leaseId: "old-view", tabId: 7 } };
  const admitted = { workerBootId: "worker", eventSequence: 5, retiredSequence: 4, selectedTabId: 7, view: null, viewerCleanupComplete: true,
    status: { state: "paused", cleanupComplete: true, revision: 1 }, human: { leaseId: "original", tabId: 7, generation: 0, state: "preparing", viewport: null } };
  return { ...business, observerBoundary: { sequence: 10, at: 30 }, delivery: { deliveryId: "delivery" },
    selection: { request: { id: 3, operation: "select", tabId: 7, deliveryId: "delivery", at: 10 }, response: { id: 3, type: "response", at: 20, result: selected } },
    admission: { request: { id: 4, operation: "humanBegin", tabId: 7, deliveryId: "delivery", at: 40 }, response: { id: 4, type: "response", at: 50, result: admitted } } };
}
function candidate(generation = 1) {
  const human = { leaseId: "original", tabId: 7, state: "preparing", generation, viewport: null };
  return { tabId: 7, beginRequest: { id: 2, operation: "humanBegin", tabId: 7 }, beginResponse: { type: "response", id: 2, at: 500, result: { human: { ...human, generation: 0 }, eventSequence: 3, status: { revision: 2, state: "paused" } } }, state: { human, eventSequence: 4, status: { revision: 2, state: "paused" }, pendingDialog: null }, frames: [] };
}
test("Begin g0 followed by current preparing g1 admits original gate", () => {
  assert.deepEqual(managedReadinessGateCandidate(candidate()).scope, { leaseId: "original", generation: 1 });
});
test("state-first without original successful Begin cannot release", () => { const c = candidate(); delete c.beginResponse; assert.equal(managedReadinessGateCandidate(c), null); });
test("Begin response-first g0 waits for later preparation", () => { assert.equal(managedReadinessGateCandidate(candidate(0)), null); });
test("an older state cannot release even when apparently preparing", () => { const c = candidate(); c.state.eventSequence = 2; assert.equal(managedReadinessGateCandidate(c), null); });
test("wrong Begin ID, failure, tab or old lease cannot release", () => {
  for (const mutate of [c => c.beginResponse.id++, c => c.beginResponse.error = { code: "ERROR" }, c => c.state.human.leaseId = "other", c => c.state.human.tabId = 8]) {
    const c = candidate(); mutate(c); assert.throws(() => managedReadinessGateCandidate(c));
  }
});
test("actual human frame or viewport means missed boundary, not delayed replay", () => {
  const a = candidate(); a.frames.push({ controlMode: "human", humanLeaseId: "original" }); assert.throws(() => managedReadinessGateCandidate(a));
  const b = candidate(); b.state.human.viewport = { width: 800, height: 600 }; assert.throws(() => managedReadinessGateCandidate(b));
  const c = candidate(); c.state.human.state = "active"; assert.throws(() => managedReadinessGateCandidate(c));
});
test("old view and retired human frame do not substitute current human frame", () => {
  const c = candidate(); c.frames.push({ controlMode: "view", humanLeaseId: "original" }, { controlMode: "human", humanLeaseId: "retired" });
  assert.ok(managedReadinessGateCandidate(c));
});
function fixture(scenario) {
  const events = [], add = (method, params = {}) => { const row = { sequence: events.length + 11, source, method, params }; events.push(row); return row; };
  add("Runtime.executionContextCreated", { context: { id: 1, uniqueId: "current", origin: new URL(sourceURL).origin, auxData: { isDefault: true, frameId: "root" } } });
  if (scenario === "navigation") { add("Page.screencastFrame"); add("Page.frameNavigated", { frame: { id: "root", loaderId: "new-document", url: emitterURL } }); }
  const opening = add("Page.javascriptDialogOpening", { type: "prompt", frameId: "root", url: scenario === "navigation" ? emitterURL : sourceURL });
  return { events, add, config: { scenario, business: admittedBusiness(), opening, sourceURL, emitterURL: opening.params.url } };
}
test("native first-frame proof uses original retirement replies and current context without onDetach", () => {
  const f = fixture("before-first-frame"); assert.equal(assertManagedReadinessNativeBoundary(f.events, f.config).firstNativeFrameSequence, null);
  f.add("Page.javascriptDialogClosed"); f.add("Page.screencastFrame"); assert.ok(assertManagedReadinessNativeBoundary(f.events, f.config).firstNativeFrameSequence > f.config.opening.sequence);
});
test("old native view frame before the recorded observation boundary is excluded", () => {
  const f = fixture("before-first-frame"); f.events.unshift({ sequence: 10, source, method: "Page.screencastFrame", params: {} });
  assert.ok(assertManagedReadinessNativeBoundary(f.events.filter(row => row.sequence > f.config.business.observerBoundary.sequence), f.config));
});
test("native frame before original Opening fails boundary", () => {
  const f = fixture("before-first-frame"); f.events.splice(1, 0, { source, method: "Page.screencastFrame", params: {} }); f.events.forEach((row,i)=>row.sequence=i+11);
  assert.throws(() => assertManagedReadinessNativeBoundary(f.events, f.config));
});
test("missing original retirement reply or current default context cannot prove human first frame", () => {
  const a = fixture("before-first-frame"); a.config.business.admission.response.result.viewerCleanupComplete = false;
  assert.throws(() => assertManagedReadinessNativeBoundary(a.events, a.config));
  const b = fixture("before-first-frame"); b.events = b.events.filter(event => event.method !== "Runtime.executionContextCreated");
  assert.throws(() => assertManagedReadinessNativeBoundary(b.events, b.config));
});
test("navigation permits prior source frame but requires original new loader before Opening", () => {
  const f = fixture("navigation"); assert.ok(assertManagedReadinessNativeBoundary(f.events, f.config));
  f.events.find(row => row.method === "Page.frameNavigated").params.frame.loaderId = "";
  assert.throws(() => assertManagedReadinessNativeBoundary(f.events, f.config));
});
test("navigation new frame before Opening does not count as pre-frame modal", () => {
  const f = fixture("navigation"); f.events.splice(-1, 0, { source, method: "Page.screencastFrame", params: {} }); f.events.forEach((row,i)=>row.sequence=i+11);
  assert.throws(() => assertManagedReadinessNativeBoundary(f.events, f.config));
});
test("exact original source rejects contradictory tab and remote session", () => {
  assert.equal(managedReadinessSource({ targetId: "unrelated", tabId: 9 }, business), false);
  for (const s of [{ targetId: "root", tabId: 8 }, { targetId: "root", sessionId: "remote" }, { tabId: 7, targetId: "replacement" }]) assert.throws(() => managedReadinessSource(s, business));
});

test("later preparing state cannot roll back successful Begin generation",()=>{const c=candidate();c.beginResponse.result.human.generation=2;assert.throws(()=>managedReadinessGateCandidate(c));});
test("navigation original up records the public stale code without creating a receipt",()=>{
 const scope={leaseId:"original",generation:1},request={id:10,...scope,sequence:3,input:{type:"pointer",action:"up"}};
 for(const code of ["HUMAN_GENERATION_STALE","OPERATION_UNCONFIRMED"]){const response={type:"response",id:10,error:{code}};assert.deepEqual(assertManagedReadinessInputOutcome(request,response,scope),{acknowledged:false,originalGeneration:1,code});}
 for(const code of ["GENERATION_STALE","HUMAN_STALE","INVALID_MESSAGE"]){assert.throws(()=>assertManagedReadinessInputOutcome(request,{type:"response",id:10,error:{code}},scope));}
 assert.throws(()=>assertManagedReadinessInputOutcome({...request,input:{type:"pointer",action:"down"}},{type:"response",id:10,error:{code:"HUMAN_GENERATION_STALE"}},scope));
 assert.throws(()=>assertManagedReadinessInputOutcome(request,{type:"response",id:10,error:{code:"HUMAN_GENERATION_STALE"},result:{inputReceipt:{}}},scope));
 assert.throws(()=>assertManagedReadinessInputOutcome(request,{type:"response",id:10,result:{inputReceipt:{...scope,generation:2,sequence:3,acknowledged:true}}},scope));
 assert.equal(assertManagedReadinessInputOutcome(request,{type:"response",id:10,result:{inputReceipt:{...scope,sequence:3,acknowledged:true}}},scope).acknowledged,true);
});

test("original selection and Begin must match delivery, worker, retirement and actual request ordering", () => {
  assert.equal(assertManagedReadinessAdmission(admittedBusiness()).viewLeaseId, "old-view");
  for (const mutate of [b => b.selection.response.id++, b => b.admission.response.error = { code: "FAILED" },
    b => b.admission.request.deliveryId = "replacement", b => b.admission.response.result.view = b.selection.response.result.view,
    b => b.admission.response.result.workerBootId = "replacement", b => b.admission.response.result.retiredSequence = 1,
    b => b.observerBoundary.at = 41, b => b.admission.response.result.status.cleanupComplete = false]) {
    const b = admittedBusiness(); mutate(b); assert.throws(() => assertManagedReadinessAdmission(b));
  }
});

function pendingSequence(scenario = "before-first-frame") {
  const business = admittedBusiness(), generation = scenario === "navigation" ? 2 : 1;
  const first = { type: "state", workerBootId: "worker", eventSequence: 8, at: 70, status: { state: "paused", revision: 1 },
    human: { leaseId: "original", tabId: 7, generation, state: scenario === "navigation" ? "navigating" : "preparing", viewport: null },
    pendingDialog: { leaseId: "original", generation, dialogId: "original-dialog", type: "prompt", message: "Original", defaultPrompt: "" } };
  const active = structuredClone(first); active.eventSequence++; active.at += 3; active.human.state = "active"; active.human.viewport = { width: 800, height: 600 };
  const messages = [business.admission.response, first, active, { type: "frame", humanLeaseId: "original", generation }];
  return { business, first, active, messages, config: { business, scenario, generation: 1 } };
}

for (const scenario of ["before-first-frame", "navigation"]) test(`original ${scenario} pending publication survives same-tuple active readiness`, () => {
  const f = pendingSequence(scenario), proof = managedReadinessPendingObservation(f.messages, f.active, f.config);
  assert.equal(proof.firstPublicationPhase, scenario === "navigation" ? "navigating" : "preparing");
  assert.equal(proof.pendingState.human.viewport, null); assert.equal(proof.eventSequence, 8);
  assertManagedReadinessCurrentDialog(f.active, proof.pendingState);
});

test("an active-only publication cannot stand in for the original preparing proof", () => {
  const f = pendingSequence(); f.messages.splice(1, 1);
  assert.throws(() => managedReadinessPendingObservation(f.messages, f.active, f.config));
});

test("state before Begin response and a missing pending dialog do not grant early answer proof", () => {
  const f = pendingSequence();
  assert.equal(managedReadinessPendingObservation([f.first, f.business.admission.response], f.first, f.config), null);
  assert.equal(managedReadinessPendingObservation([f.business.admission.response], f.active, f.config), null);
});

test("original early publication cannot authorize a later lease, generation, worker, closed or replacement dialog", () => {
  for (const mutate of [s => s.human.leaseId = "replacement", s => s.human.generation++, s => s.workerBootId = "replacement",
    s => s.pendingDialog = null, s => s.pendingDialog.dialogId = "replacement", s => s.status.state = "degraded"]) {
    const f = pendingSequence(); mutate(f.active);
    assert.throws(() => managedReadinessPendingObservation(f.messages, f.active, f.config));
  }
});

test("current human frame before the first pending publication fails even if latest state looks ready", () => {
  const f = pendingSequence(); f.messages.splice(1, 0, { type: "frame", humanLeaseId: "original", generation: 1 });
  assert.throws(() => managedReadinessPendingObservation(f.messages, f.active, f.config));
});

test("passive tab updates preserve only bounded original URL/status and exact tab identity", () => {
  assert.deepEqual(projectManagedReadinessTabUpdate(7, { url: sourceURL, status: "loading", title: "exclude", favIconUrl: "exclude", cookie: "exclude" }),
    { source: { tabId: 7 }, method: "tabs.onUpdated", params: { url: sourceURL, status: "loading" } });
  assert.deepEqual(projectManagedReadinessTabUpdate(7, { status: "complete" }).params, { status: "complete" });
  assert.deepEqual(projectManagedReadinessTabUpdate(7, { url: sourceURL }).params, { url: sourceURL });
  assert.equal(projectManagedReadinessTabUpdate(7, { title: "unneeded", favIconUrl: "unneeded" }), null);
  assert.equal(projectManagedReadinessTabUpdate(7, { url: "x".repeat(8192) }).params.url.length, 8192);
  for (const [tabId, changes] of [[-1, {}], [1.5, {}], [7, null], [7, { url: "x".repeat(8193) }], [7, { url: {} }], [7, { status: "unknown" }]])
    assert.throws(() => projectManagedReadinessTabUpdate(tabId, changes));
});

function observerFixture() {
  const event = () => {
    const listeners = new Set();
    return { listeners, addListener(listener) { listeners.add(listener); }, removeListener(listener) { listeners.delete(listener); },
      emit(...args) { for (const listener of listeners) listener(...args); } };
  };
  const chrome = { debugger: { onEvent: event(), onDetach: event() }, tabs: { onUpdated: event() },
    webNavigation: Object.fromEntries(managedOopifWebNavigationEvents.map(name => [name, event()])) };
  const sent = [], target = { __obuManagedReadinessDialogEvent: raw => sent.push(JSON.parse(raw)) };
  // Exercise the exact self-contained functions serialized into the worker.
  const install = vm.runInNewContext(`(${installReadinessObservation.toString()})`, { structuredClone });
  const projectTab = vm.runInNewContext(`(${projectManagedReadinessTabUpdate.toString()})`);
  const projectNative = vm.runInNewContext(`(${projectManagedOopifEvent.toString()})`, { structuredClone });
  const installed = install(chrome, target, projectNative, [...managedOopifWebNavigationEvents], projectTab);
  return { chrome, sent, installed, observer: target.__managedReadinessDialogDiagnostic };
}

test("worker tab updates share the original native/web sequence and stop removes all listeners", () => {
  const f = observerFixture();
  assert.deepEqual([...f.installed.tabEvents], ["onUpdated"]);
  f.chrome.debugger.onEvent.emit(source, "Runtime.executionContextsCleared", {});
  f.chrome.tabs.onUpdated.emit(7, { url: emitterURL, status: "loading", title: "exclude" }, new Proxy({}, { get() { throw Error("full tab must not be read"); } }));
  f.chrome.webNavigation.onCommitted.emit({ tabId: 7, frameId: 0, documentId: "new", url: emitterURL });
  f.chrome.tabs.onUpdated.emit(7, { title: "not recorded" });
  assert.deepEqual(f.sent.map(row => [row.sequence, row.method]), [[1, "Runtime.executionContextsCleared"], [2, "tabs.onUpdated"], [3, "webNavigation.onCommitted"]]);
  assert.deepEqual(f.sent[1].source, { tabId: 7 });
  assert.deepEqual(f.sent[1].params, { url: emitterURL, status: "loading" });
  const lateUpdate = [...f.chrome.tabs.onUpdated.listeners][0], lateNative = [...f.chrome.debugger.onEvent.listeners][0];
  assert.equal(f.observer.mark().sequence, 3);
  const stopped = f.observer.stop();
  assert.equal(stopped.active, false); assert.equal(stopped.overflow, false); assert.equal(stopped.sequence, 3);
  for (const event of [f.chrome.tabs.onUpdated, f.chrome.debugger.onEvent, f.chrome.debugger.onDetach, ...Object.values(f.chrome.webNavigation)]) assert.equal(event.listeners.size, 0);
  lateUpdate(7, { url: "late" }); lateNative(source, "Runtime.executionContextsCleared", {});
  assert.equal(f.sent.length, 3); assert.equal(f.observer.stop().sequence, 3);
});

test("passive tab metadata cannot exceed the shared event cap or silently truncate required fields", () => {
  const f = observerFixture();
  for (let i = 0; i < 4096; i++) f.chrome.tabs.onUpdated.emit(7, { status: "loading" });
  f.chrome.debugger.onEvent.emit(source, "Runtime.executionContextsCleared", {});
  assert.equal(f.sent.length, 4096); assert.equal(f.observer.snapshot().sequence, 4096); assert.equal(f.observer.snapshot().overflow, true);
  f.observer.stop();
  const invalid = observerFixture();
  invalid.chrome.tabs.onUpdated.emit(7, { url: "x".repeat(8193) });
  assert.equal(invalid.sent.length, 0); assert.equal(invalid.observer.snapshot().overflow, true);
  invalid.observer.stop();
});

test("the original viewer dialog command projection proves Unicode bytes without retaining promptText", () => {
  const scope = { leaseId: "original", generation: 1 }, dialogId = "original-dialog";
  const projected = projectHumanDialogCommand({ id: 5, operation: "humanDialogRespond", ...scope, dialogId, accept: true, promptText: managedReadinessDialogUnicode });
  assert.equal(Object.hasOwn(projected, "promptText"), false);
  assertManagedReadinessDialogRequest(projected, scope, dialogId);
});

test("projected answer proof still rejects missing, different or foreign original request data", () => {
  const scope = { leaseId: "original", generation: 1 }, dialogId = "original-dialog";
  const original = { id: 5, operation: "humanDialogRespond", ...scope, dialogId, accept: true, promptText: managedReadinessDialogUnicode };
  const projected = projectHumanDialogCommand(original);
  for (const fields of [{ operation: "humanInput" }, { leaseId: "other" }, { generation: 2 }, { dialogId: "other" },
    { accept: false }, { promptBytes: undefined }, { promptBytes: projected.promptBytes + 1 },
    { promptSHA256: undefined }, { promptSHA256: "0".repeat(64) }])
    assert.throws(() => assertManagedReadinessDialogRequest({ ...projected, ...fields }, scope, dialogId));
  for (const promptText of ["", managedReadinessDialogUnicode + "x", managedReadinessDialogUnicode.replace("原", "旧")])
    assert.throws(() => assertManagedReadinessDialogRequest(projectHumanDialogCommand({ ...original, promptText }), scope, dialogId));
  const { promptText: _omitted, ...missing } = original;
  assert.throws(() => assertManagedReadinessDialogRequest(projectHumanDialogCommand(missing), scope, dialogId));
});

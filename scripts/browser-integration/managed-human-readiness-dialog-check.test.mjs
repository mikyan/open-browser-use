import assert from "node:assert/strict";
import test from "node:test";
import { managedReadinessGateCandidate, managedReadinessSource, assertManagedReadinessNativeBoundary, assertManagedReadinessInputOutcome } from "./managed-human-readiness-dialog-check.mjs";

const business = { tabId: 7, target: { id: "root" }, observerBoundary: { sequence: 10 } };
const source = { targetId: "root" }, sourceURL = "http://127.0.0.1:55000/source", emitterURL = "http://127.0.0.1:55000/destination";
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
  add("debugger.onDetach", { reason: "canceled_by_user" });
  add("Runtime.executionContextCreated", { context: { id: 1, uniqueId: "current", origin: new URL(sourceURL).origin, auxData: { isDefault: true, frameId: "root" } } });
  if (scenario === "navigation") { add("Page.screencastFrame"); add("Page.frameNavigated", { frame: { id: "root", loaderId: "new-document", url: emitterURL } }); }
  const opening = add("Page.javascriptDialogOpening", { type: "prompt", frameId: "root", url: scenario === "navigation" ? emitterURL : sourceURL });
  return { events, add, config: { scenario, business, opening, sourceURL, emitterURL: opening.params.url } };
}
test("native first-frame proof starts after actual view detach and current context", () => {
  const f = fixture("before-first-frame"); assert.equal(assertManagedReadinessNativeBoundary(f.events, f.config).firstNativeFrameSequence, null);
  f.add("Page.javascriptDialogClosed"); f.add("Page.screencastFrame"); assert.ok(assertManagedReadinessNativeBoundary(f.events, f.config).firstNativeFrameSequence > f.config.opening.sequence);
});
test("old native view frame before current attachment does not invalidate current zero-frame proof", () => {
  const f = fixture("before-first-frame"); f.events.unshift({ source, method: "Page.screencastFrame", params: {} }); f.events.forEach((row,i)=>row.sequence=i+11);
  assert.ok(assertManagedReadinessNativeBoundary(f.events, f.config));
});
test("native frame before original Opening fails boundary", () => {
  const f = fixture("before-first-frame"); f.events.splice(2, 0, { source, method: "Page.screencastFrame", params: {} }); f.events.forEach((row,i)=>row.sequence=i+11);
  assert.throws(() => assertManagedReadinessNativeBoundary(f.events, f.config));
});
test("no actual view detach or current default context cannot prove human first frame", () => {
  for (const method of ["debugger.onDetach", "Runtime.executionContextCreated"]) {
    const f = fixture("before-first-frame"); f.events = f.events.filter(event => event.method !== method); assert.throws(() => assertManagedReadinessNativeBoundary(f.events, f.config));
  }
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

import assert from "node:assert/strict";
import test from "node:test";
import { createNativePointerRoute } from "./browser-native-pointer-route.js";
import { PrivateTargetRegistry } from "./browser-private-targets.js";
import { PassivePointerReads } from "./browser-pointer-feedback.js";

const deferred = () => { let resolve, reject; const promise = new Promise((a,b) => { resolve=a; reject=b; }); return {promise,resolve,reject}; };
const tick = () => new Promise(setImmediate);
const realmIdentity = Object.freeze({ kernelABI: "1",
  worldName: "Open Browser Use passive pointer 00000000-0000-4000-8000-000000000001 1",
  kernelKey: "__obuNativePointer_00000000-0000-4000-8000-000000000002_1",
  kernelToken: "00000000-0000-4000-8000-000000000003:1" });

// Deterministic CDP replies exercise ownership and actual Promise composition.
// They are not evidence for native browser permissions or rendered pixels.
async function fixture({ remote = false, registered = true, realm = realmIdentity } = {}) {
  const calls = [], ledger = [], attached = new Set(), objects = new Map();
  let valid = true, live = true, gone = false, successor = false, hook = async () => {}, serial = 0;
  const scope = { tabId: 7, attachment: {}, session_id: "original", turn_id: "turn" };
  const check = () => { if (!valid) throw Error("original authority revoked"); };
  const native = {
    async getTargets() { calls.push({method:"getTargets"}); return [{id:"child",type:"iframe"}]; },
    async attach(target) { const c={method:"attach",target}; calls.push(c); await hook(c); attached.add(target.targetId); c.ack=true; },
    async detach(target) { const c={method:"detach",target}; calls.push(c); await hook(c); attached.delete(target.targetId); c.ack=true; },
    async send(target, method, params = {}) {
      const c = { target, method, params }; calls.push(c);
      const override = await hook(c); let result = override;
      const frame = target.targetId ?? "root";
      const allocate = kind => { const objectId = `${frame}:${kind}:${++serial}`; objects.set(objectId,{frame,kind,group:params.objectGroup}); return {result:{objectId}}; };
      if (result === undefined) {
        if (method === "Target.getTargetInfo") {
          if (target.targetId && (frame === "root" ? !live : !attached.has(target.targetId))) throw Error(`Debugger is not attached to the target with id: ${target.targetId}.`);
          result = {targetInfo:{targetId:frame,type:frame === "root" ? "page" : "iframe"}};
        } else if (method === "Page.getFrameTree") result = {frameTree:{frame:{id:frame,loaderId:"loader-"+frame,...(frame === "child" ? {parentId:"root"} : {})}}};
        else if (method === "Page.createIsolatedWorld") result = {executionContextId:frame === "root" ? 1 : 2};
        else if (method === "Runtime.evaluate") result = allocate("document");
        else if (method === "Runtime.callFunctionOn") {
          if (params.functionDeclaration.includes("function originalRoot(")) result = allocate("root");
          else if (params.functionDeclaration.includes("function hitAt(")) result = allocate("hit");
          else if (params.functionDeclaration.includes("function originalNode(")) result = {result:{value:true}};
          else if (params.functionDeclaration.includes("function ownerPlane(")) result = {result:{value:{width:200,height:100}}};
          else assert.fail("Unexpected fixed function");
        } else if (method === "DOM.describeNode") {
          const object = objects.get(params.objectId); assert.ok(object);
          result = {node:object.kind === "root" ? {frameId:frame,backendNodeId:frame === "root" ? 1 : 2,localName:"html"} :
            frame === "root" && remote ? {frameId:"child",backendNodeId:3,localName:"iframe"} : {backendNodeId:4,localName:"button"}};
        } else if (method === "DOM.getFrameOwner") result = {backendNodeId:3};
        else if (method === "DOM.getBoxModel") result = {model:frame === "root" && remote ?
          {content:[10,20,210,20,210,120,10,120]} : {border:[40,40,80,40,80,60,40,60]}};
        else if (method === "Runtime.releaseObjectGroup") {
          for (const [id, object] of objects) if (object.group === params.objectGroup) objects.delete(id);
          result = {};
        } else assert.fail("Unexpected CDP command " + method);
      }
      c.ack = true; c.result = result; return result;
    }
  };
  const registry = registered ? new PrivateTargetRegistry({load:async()=>({fresh:true,incarnation:"browser"}),
    save:async value=>{ledger.push(structuredClone(value));},incarnation:()=>"browser",native}) : null;
  await registry?.ready;
  const route = createNativePointerRoute({scope,x:55,y:50,check,native,registry,realm,
    cleanupAuthority(){if(!live)throw Error("original root no longer available");},
    cleanupExclusive(){if(successor)throw Error("original root exclusion lost");},destroyed:()=>gone});
  const reads = new PassivePointerReads();
  return {scope,route,reads,calls,objects,registry,ledger,attached,check,hook:value=>hook=value,
    revoke(){valid=false;},destroy(){gone=true;live=false;valid=false;},cancel(){live=false;valid=false;},replace(){successor=true;},
    start(){return reads.start({...route,scope});}};
}

test("root native route uses the actual root identity and releases its own group", async()=>{
  const f=await fixture(); assert.deepEqual(await f.start().result,{x:40,y:40,width:40,height:20});
  assert.equal(f.calls[0].method,"Target.getTargetInfo"); assert.equal(f.objects.size,0); assert.equal(f.reads.pending.size,0);
  assert.equal(f.calls.filter(c=>c.method==="Runtime.releaseObjectGroup").length,1);
  assert.equal(f.calls.find(c=>c.method==="Page.createIsolatedWorld").params.worldName,realmIdentity.worldName);
  const expression=f.calls.find(c=>c.method==="Runtime.evaluate").params.expression;
  assert.ok(expression.includes(JSON.stringify(realmIdentity.kernelKey)));assert.ok(expression.includes(JSON.stringify(realmIdentity.kernelToken)));
  assert.ok(f.calls.every(c=>!/^Input\.|enable$|disable$|getDocument|focus|attach$/.test(c.method)));
});

test("unavailable or incompatible realm drops the route before the original root query",async()=>{
  for(const realm of [null,{}, {...realmIdentity,kernelABI:"2"}, {...realmIdentity,worldName:""}]) {
    const f=await fixture({realm});assert.equal(f.route,undefined);assert.equal(f.calls.length,0);
    assert.equal(f.objects.size,0);assert.equal(f.attached.size,0);
  }
});

test("remote route keeps the original root and releases all groups before independent detach",async()=>{
  const f=await fixture({remote:true}); assert.deepEqual(await f.start().result,{x:50,y:60,width:40,height:20});
  assert.equal(f.attached.size,0); assert.equal(f.registry.entries.size,0); assert.equal(f.objects.size,0);
  assert.equal(f.calls.filter(c=>c.method==="attach").length,1);
  assert.equal(f.calls.find(c=>c.method==="attach").target.targetId,"child");
  const release=f.calls.filter(c=>c.method==="Runtime.releaseObjectGroup"); assert.equal(release.length,2);
  assert.ok(release.every(c=>c.ack && f.calls.indexOf(c)<f.calls.findIndex(c=>c.method==="detach")));
  assert.deepEqual(f.ledger.map(v=>v.records.map(r=>r.phase)),[[],["intent"],["owned"],[]]);
});

test("unknown private ledger yields no ancestor fallback while the root group is still cleaned",async()=>{
  const f=await fixture({remote:true,registered:false}); assert.equal(await f.start().result,null);
  assert.equal(f.objects.size,0); assert.equal(f.calls.filter(c=>c.method==="attach").length,0);
});

test("cleanup during original root query waits its real reply and never starts late allocation",async()=>{
  const f=await fixture(), gate=deferred(); f.hook(c=>c.method==="Target.getTargetInfo" ? gate.promise : undefined);
  const candidate=f.start(); let complete=false; const cleanup=f.route.cleanup().then(()=>complete=true);
  await tick(); assert.equal(complete,false); assert.equal(f.calls.length,1);
  gate.resolve(); await cleanup; assert.equal(await candidate.result,null); assert.equal(f.calls.length,1);
});

test("revocation while allocation is pending keeps original objects until actual group release",async()=>{
  const f=await fixture(), gate=deferred(); f.hook(c=>c.method==="Runtime.evaluate" ? gate.promise : undefined);
  const candidate=f.start(); await tick(); f.revoke(); let done=false; const drain=f.reads.drain().then(()=>done=true);
  await tick(); assert.equal(done,false); gate.resolve(); await drain;
  assert.equal(await candidate.result,null); assert.equal(f.objects.size,0);
  assert.equal(f.calls.filter(c=>c.method==="Runtime.evaluate").length,1);
  assert.equal(f.calls.filter(c=>c.method==="Runtime.releaseObjectGroup").length,1);
});

test("held root release remains one actual attempt under ordinary drains",async()=>{
  const f=await fixture(), gate=deferred(); f.hook(c=>c.method==="Runtime.releaseObjectGroup" ? gate.promise : undefined);
  const candidate=f.start(); await tick(); let done=false; const drain=f.reads.drain().then(()=>done=true);
  await tick(); assert.equal(done,false); assert.equal(candidate.settled,false);
  const retry=f.reads.drain(()=>true,{retryFailed:true}); await tick();
  assert.equal(f.calls.filter(c=>c.method==="Runtime.releaseObjectGroup").length,1);
  gate.resolve(); await Promise.all([drain,retry]); assert.deepEqual(await candidate.result,{x:40,y:40,width:40,height:20});
});

test("explicit cleanup replaces a failed drain synchronously and never replays the root read",async()=>{
  const f=await fixture(), gate=deferred(); let attempts=0;
  f.hook(c=>{if(c.method==="Runtime.releaseObjectGroup"){if(++attempts===1)throw Error("actual release failure");return gate.promise;}});
  const candidate=f.start(); assert.equal(await candidate.result,null); await assert.rejects(f.reads.drain(),/actual release failure/);
  assert.equal(attempts,1);
  const retry=f.reads.drain(()=>true,{retryFailed:true}); let done=false;
  const joined=f.reads.drain().then(()=>done=true); await tick(); assert.equal(done,false); assert.equal(attempts,2);
  gate.resolve(); await Promise.all([retry,joined]); assert.equal(f.objects.size,0); assert.equal(f.reads.pending.size,0);
  assert.equal(f.calls.filter(c=>c.method==="Target.getTargetInfo"&&c.target.tabId).length,1);
  assert.equal(f.calls.filter(c=>c.method==="Target.getTargetInfo"&&c.target.targetId==="root").length,1);
});

test("child group retry retains root group ACK and performs detach only after actual child release",async()=>{
  const f=await fixture({remote:true}), gate=deferred(); let attempts=0;
  f.hook(c=>{if(c.method==="Runtime.releaseObjectGroup"&&c.target.targetId){if(++attempts===1)throw Error("child group failure");return gate.promise;}});
  const candidate=f.start(); assert.equal(await candidate.result,null); assert.equal(f.registry.snapshot().failed.length,1);
  assert.equal(f.calls.filter(c=>c.method==="detach").length,0);
  const retry=f.reads.drain(()=>true,{retryFailed:true}); await tick(); assert.equal(attempts,2);
  assert.equal(f.calls.filter(c=>c.method==="detach").length,0);
  gate.resolve(); await retry; assert.equal(f.registry.entries.size,0); assert.equal(f.objects.size,0);
  assert.equal(f.calls.filter(c=>c.method==="Runtime.releaseObjectGroup"&&c.target.tabId).length,1);
  assert.equal(f.calls.filter(c=>c.method==="attach").length,1);
});

for(const replacement of [{targetInfo:{targetId:"root",type:"iframe"}}, {targetInfo:{targetId:"wrong",type:"page"}}])
test("unproved root identity rejects the optional read: "+JSON.stringify(replacement),async()=>{
  const f=await fixture(); f.hook(c=>c.method==="Target.getTargetInfo"?replacement:undefined);
  assert.equal(await f.start().result,null); assert.equal(f.objects.size,0);
  assert.equal(f.calls.filter(c=>c.method==="Runtime.evaluate").length,0);
});

test("exact root destruction retires group cleanup without claiming a release ACK",async()=>{
  const f=await fixture(), gate=deferred(); f.hook(c=>c.method==="Runtime.evaluate"?gate.promise:undefined);
  const candidate=f.start(); await tick(); f.destroy(); gate.resolve(); assert.equal(await candidate.result,null);
  assert.equal(f.calls.filter(c=>c.method==="Runtime.releaseObjectGroup").length,0); assert.equal(f.reads.pending.size,0);
});

test("cancelled root requires a fresh exact opaque-target absence query after actual read settlement",async()=>{
  const f=await fixture(), gate=deferred(); f.hook(c=>c.method==="Runtime.evaluate"?gate.promise:undefined);
  const candidate=f.start(); await tick(); f.cancel(); await tick();
  assert.equal(f.calls.filter(c=>c.target?.targetId==="root").length,0);
  gate.resolve(); assert.equal(await candidate.result,null); assert.equal(f.reads.pending.size,0);
  assert.equal(f.calls.filter(c=>c.method==="Runtime.releaseObjectGroup").length,0);
  const queries=f.calls.filter(c=>c.target?.targetId==="root"); assert.equal(queries.length,1); assert.equal(queries[0].method,"Target.getTargetInfo");
});

for (const response of [{targetInfo:{targetId:"root",type:"page"}},new Error("No target with given id another."),new Error("Permission denied")])
test("root cleanup retains its original failure without exact absence: "+String(response.message??"client-present"),async()=>{
  const f=await fixture(), gate=deferred();
  f.hook(c=>{if(c.method==="Runtime.evaluate")return gate.promise;if(c.target.targetId==="root"){if(response instanceof Error)throw response;return response;}});
  const candidate=f.start(); await tick(); f.cancel(); gate.resolve(); assert.equal(await candidate.result,null);
  await assert.rejects(f.reads.drain(),/original root no longer available/); assert.equal(f.reads.pending.size,1);
});

test("a late absence reply cannot bypass loss of original root exclusion",async()=>{
  const f=await fixture(), allocation=deferred(), query=deferred();
  f.hook(c=>c.method==="Runtime.evaluate"?allocation.promise:c.target.targetId==="root"?query.promise:undefined);
  const candidate=f.start(); await tick(); f.cancel(); allocation.resolve(); await tick();
  assert.equal(candidate.settled,false); f.replace(); query.reject(Error("Debugger is not attached to the target with id: root."));
  assert.equal(await candidate.result,null); await assert.rejects(f.reads.drain(),/exclusion lost/); assert.equal(f.reads.pending.size,1);
});

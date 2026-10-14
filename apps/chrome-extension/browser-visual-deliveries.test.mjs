import assert from "node:assert/strict";
import test from "node:test";
import { VisualDeliveries } from "./browser-visual-deliveries.js";
const scope={tabId:7,session_id:"session",turn_id:"turn",control_epoch:1};
const deferred=()=>{let resolve,reject;const promise=new Promise((a,b)=>{resolve=a;reject=b;});return {promise,resolve,reject};};
const tick=()=>new Promise(setImmediate);
const ack={ok:true,receiverToken:"receiver"};
const bind=async ticket=>{await ticket.bind("original");ticket.acceptToken(ack);};

test("recovery is cleanup-only and joins original inspection and final hide", async () => {
  const inspection = deferred(), hidden = deferred(); let hides = 0;
  const registry = new VisualDeliveries({ hide: (tabId, documentId, token) => {
    assert.deepEqual([tabId, documentId, token], [7, "original", "receiver"]); hides++; return hidden.promise;
  } });
  const closing = registry.recover(scope, run => run("RECOVERY_PING", () => inspection.promise));
  let done = false; closing.then(() => { done = true; }); await tick();
  assert.equal(done, false); assert.equal(hides, 0);
  assert.ok([...registry.pending].some(value => value.promise === inspection.promise));
  assert.equal(registry.bootstrapAllowed(7, "original", "receiver", scope), false);
  inspection.resolve({ documentId: "original", receiverToken: "receiver" }); await tick();
  assert.equal(hides, 1); assert.equal(done, false); assert.equal([...registry.records][0].closed, true);
  hidden.resolve(ack); await closing; assert.equal(registry.records.size, 0);
});

test("failed recovery inspection remains failed until explicit settled retry", async () => {
  let attempts = 0, hides = 0;
  const registry = new VisualDeliveries({ hide: () => { hides++; return Promise.resolve(ack); } });
  const inspect = async () => { attempts++; if (attempts === 1) throw Error("original lookup failed"); return { documentId: "original", receiverToken: "receiver" }; };
  await assert.rejects(registry.recover(scope, inspect), /original lookup failed/);
  await assert.rejects(registry.recover(scope, inspect), /original lookup failed/);
  assert.equal(attempts, 1); assert.equal(hides, 0);
  await registry.recover(scope, inspect, { retryFailed: true }); assert.equal(attempts, 2); assert.equal(hides, 1);
});

test("recovery with no receiver does not inject, while malformed receiver identity fails", async () => {
  let hides = 0; const registry = new VisualDeliveries({ hide: () => { hides++; return Promise.resolve(ack); } });
  await registry.recover(scope, async () => null); assert.equal(hides, 0);
  await assert.rejects(registry.recover(scope, async () => ({ documentId: "original" })), /OBU_VISUAL_CLEANUP_FAILED/);
  assert.equal(hides, 0);
});

test("close joins the exact original Promise then the original document's actual hidden ACK",async()=>{
 const original=deferred(),hidden=deferred(),calls=[];
 const registry=new VisualDeliveries({hide:(tabId,documentId)=>{calls.push([tabId,documentId]);return hidden.promise;}});
 const ticket=registry.ticket(scope);await bind(ticket);
 assert.equal(ticket.run("CURSOR",()=>original.promise,{mayDisplay:true}),original.promise);
 assert.equal([...registry.pending][0].promise,original.promise);
 let completed=false;const closing=registry.close().then(()=>completed=true);await tick();
 assert.equal(completed,false);assert.deepEqual(calls,[]);assert.throws(()=>ticket.run("POINTER",()=>{}),/OBU_VISUAL_EXPIRED/);
 original.resolve(ack);await tick();assert.deepEqual(calls,[[7,"original"]]);assert.equal(completed,false);
 assert.equal([...registry.pending][0].promise,hidden.promise);hidden.resolve(ack);await closing;
 assert.equal(registry.pending.size,0);assert.equal(registry.cleanups.size,0);
});

test("PING failure alone needs no speculative hide or injection",async()=>{
 let hides=0;const registry=new VisualDeliveries({hide:()=>{hides++;throw Error("No receiver");}}),ticket=registry.ticket(scope);
 await bind(ticket);await assert.rejects(ticket.run("PING",()=>Promise.reject(Error("No receiver"))));
 await registry.close();assert.equal(hides,0);
});

test("injection rejection is actual settlement but injection alone never grants visible bootstrap authority",async()=>{
 const calls=[];const registry=new VisualDeliveries({hide:(tab,id)=>{calls.push([tab,id]);return Promise.resolve(ack);}}),ticket=registry.ticket(scope);
 await bind(ticket);await assert.rejects(ticket.run("INJECT",()=>Promise.reject(Error("Unconfirmed injection")),{mayDisplay:true}));
 assert.equal(registry.bootstrapAllowed(7,"original","receiver",scope),false);
 await registry.close();assert.deepEqual(calls,[]);
});

test("same owner producers share one final hide and failed settled hide retries only explicitly",async()=>{
 const firstHide=deferred(),retryHide=deferred();let hides=0;
 const registry=new VisualDeliveries({hide:()=>++hides===1?firstHide.promise:retryHide.promise});
 const a=registry.ticket(scope),b=registry.ticket({...scope,attachment:{}});await bind(a);await bind(b);
 await a.run("CURSOR",()=>Promise.resolve(ack),{mayDisplay:true});await b.run("STATE",()=>Promise.resolve(ack),{mayDisplay:true});
 const first=registry.close(),duplicate=registry.close(()=>true,{retryFailed:true});first.catch(()=>{});duplicate.catch(()=>{});await tick();
 assert.equal(hides,1);firstHide.resolve({ok:false});await assert.rejects(first,/OBU_VISUAL_CLEANUP_FAILED/);await assert.rejects(duplicate,/OBU_VISUAL_CLEANUP_FAILED/);
 await assert.rejects(registry.close(),/OBU_VISUAL_CLEANUP_FAILED/);assert.equal(hides,1);
 const retry=registry.close(()=>true,{retryFailed:true});await tick();assert.equal(hides,2);assert.equal(registry.cleanups.size,1);
 retryHide.resolve(ack);await retry;assert.equal(registry.records.size,0);
});

test("successor's optional display waits original hidden ACK while independent native work can complete",async()=>{
 const hidden=deferred();const registry=new VisualDeliveries({hide:()=>hidden.promise}),old=registry.ticket(scope);
 await bind(old);await old.run("CURSOR",()=>Promise.resolve(ack),{mayDisplay:true});const closing=registry.close();
 const successor=registry.ticket({...scope,turn_id:"next",control_epoch:2});let bound=false;const binding=successor.bind("original").then(()=>bound=true);
 assert.equal(await Promise.resolve("original native result"),"original native result");await tick();assert.equal(bound,false);
 hidden.resolve(ack);await closing;await binding;assert.equal(bound,true);
});

test("exact tab removal skips hidden send but cannot claim actual pending operation settled",async()=>{
 const original=deferred();let hides=0;const registry=new VisualDeliveries({hide:()=>{hides++;return Promise.resolve(ack);}}),ticket=registry.ticket(scope);
 await bind(ticket);ticket.run("CURSOR",()=>original.promise,{mayDisplay:true});let done=false;const removing=registry.tabRemoved(7).then(()=>done=true);
 await tick();assert.equal(done,false);assert.equal(registry.pending.size,1);original.reject(Error("Tab actually removed"));await removing;
 assert.equal(hides,0);assert.equal(registry.pending.size,0);
});

test("late read cannot bind or dispatch after synchronous producer revocation",async()=>{
 const read=deferred();const registry=new VisualDeliveries({hide:()=>{throw Error("no visible work");}}),ticket=registry.ticket(scope);
 const preparing=ticket.run("DOCUMENT",()=>read.promise).then(value=>ticket.bind(value.documentId));preparing.catch(()=>{});
 const closing=registry.close();read.resolve({documentId:"successor"});await assert.rejects(preparing,/OBU_VISUAL_EXPIRED/);await closing;
 assert.equal(registry.pending.size,0);
});

test("bootstrap cannot borrow a closed or different owner's original document",async()=>{
 const original=deferred();const registry=new VisualDeliveries({hide:()=>Promise.resolve(ack)}),ticket=registry.ticket(scope);
 await bind(ticket);ticket.run("INJECT",()=>original.promise,{mayDisplay:true});
 assert.equal(registry.bootstrapAllowed(7,"original","receiver",scope),false);assert.equal(registry.bootstrapAllowed(7,"other","receiver",scope),false);
 assert.equal(registry.bootstrapAllowed(7,"original","receiver",{...scope,turn_id:"next"}),false);
 const closing=registry.close();assert.equal(registry.bootstrapAllowed(7,"original","receiver",scope),false);original.resolve([]);await closing;
});

test('exact retirement completes a pure hide obligation while retaining its unsettled native Promise',async()=>{
 const hidden=deferred();const registry=new VisualDeliveries({hide:()=>hidden.promise}),ticket=registry.ticket(scope);
 await bind(ticket);await ticket.run('CURSOR',()=>Promise.resolve(ack),{mayDisplay:true});
 let done=false;const closing=registry.close().then(()=>done=true);await tick();
 const drain=Promise.allSettled(registry.snapshot());let drained=false;drain.then(()=>drained=true);
 assert.equal(registry.retired(7,'original','foreign-receiver'),false);await tick();assert.equal(done,false);assert.equal(drained,false);
 assert.equal(registry.retired(7,'original','receiver'),true);await tick();assert.equal(done,true);assert.equal(drained,true);
 assert.equal(registry.pending.size,1);assert.equal([...registry.pending][0].promise,hidden.promise,'Retirement is not a fabricated native settlement');
 await closing;assert.equal(registry.cleanups.size,0);
 const successor=registry.ticket({...scope,turn_id:'successor',control_epoch:2});await successor.bind('original');successor.acceptToken({ok:true,receiverToken:'fresh'});
 hidden.reject(Error('Original document navigated'));await tick();assert.equal(registry.pending.size,0);assert.equal(successor.receiverToken,'fresh');
});

test('original bootstrap during pending injection can identify but cannot authorize its token, even while closing',async()=>{
 const injected=deferred();let hides=0;const registry=new VisualDeliveries({hide:()=>{hides++;return Promise.resolve(ack);}}),ticket=registry.ticket(scope);
 await ticket.bind('original');ticket.run('INJECT',()=>injected.promise,{mayDisplay:true});
 const closing=registry.close();assert.equal(registry.observeBootstrap(7,'successor','receiver'),false);
 assert.equal(registry.observeBootstrap(7,'original','receiver'),true);
 assert.equal(registry.bootstrapAllowed(7,'original','receiver',scope),false);
 assert.equal(registry.retired(7,'original','receiver'),true);assert.equal(registry.pending.size,1);
 injected.resolve([]);await closing;assert.equal(hides,0);assert.equal(registry.pending.size,0);
});

test('failed injections cannot exceed the original receiver-state capacity', async () => {
  const registry = new VisualDeliveries({ hide: () => { throw Error('Unknown injection must bootstrap hidden'); } });
  let invocations = 0;
  for (let i = 0; i < 128; i++) {
    const ticket = registry.ticket(scope); await ticket.bind('original');
    await assert.rejects(ticket.run('INJECT', () => { invocations++; return Promise.reject(Error('Original injection rejected')); }, { mayDisplay: true }), /Original injection rejected/);
  }
  assert.equal(registry.pending.size, 0);
  const extra = registry.ticket(scope); await extra.bind('original');
  assert.throws(() => extra.run('INJECT', () => { invocations++; return Promise.resolve(); }, { mayDisplay: true }), /OBU_VISUAL_EXPIRED/);
  assert.equal(invocations, 128); assert.equal([...registry.records][0].documents.size, 128);
  await registry.close(); assert.equal(registry.records.size, 0);
});

test('the last reserved receiver state may accept its actual token at capacity', async () => {
  let hides = 0;
  const registry = new VisualDeliveries({ hide: () => { hides++; return Promise.resolve({ok:true,receiverToken:'last'}); } });
  for (let i = 0; i < 127; i++) {
    const ticket = registry.ticket(scope); await ticket.bind('original');
    await assert.rejects(ticket.run('INJECT', () => Promise.reject(Error('Original injection rejected')), { mayDisplay: true }), /Original injection rejected/);
  }
  const last = registry.ticket(scope); await last.bind('original');
  await last.run('INJECT', () => Promise.resolve(), { mayDisplay: true });
  last.acceptToken({ok:true,receiverToken:'last'});
  await last.run('CURSOR', () => Promise.resolve({ok:true}), {mayDisplay:true});
  assert.equal([...registry.records][0].documents.size, 128);
  await registry.close(); assert.equal(hides, 1); assert.equal(registry.records.size, 0);
});

test('accepting an injection bootstrap token retains its original receiver retirement identity', async () => {
  let resolve;
  const pending = new Promise(done => { resolve = done; });
  const registry = new VisualDeliveries({ hide: () => { throw Error('Retired receiver must not need another hide'); } });
  const ticket = registry.ticket(scope); await ticket.bind('original');
  const injection = ticket.run('INJECT', () => pending, {mayDisplay:true});
  assert.equal(registry.observeBootstrap(7, 'original', 'receiver'), true);
  const original = [...registry.records][0].documents.values().next().value;
  resolve(); await injection;
  ticket.acceptToken({ok:true,receiverToken:'receiver'});
  assert.equal([...registry.records][0].documents.has(original), true);
  assert.equal(registry.retired(7, 'original', 'receiver'), true);
  assert.throws(() => ticket.run('CURSOR', () => Promise.resolve({ok:true}), {mayDisplay:true}), /OBU_VISUAL_EXPIRED/);
  await registry.close(); assert.equal(registry.records.size, 0);
});

test('exact tab removal clears a settled failed recovery inspection', async () => {
  const registry = new VisualDeliveries({hide:()=>{throw Error('Removed tab must not receive hide');}});
  await assert.rejects(registry.recover(scope, async () => {throw Error('Original lookup failed');}), /Original lookup failed/);
  assert.equal(registry.records.size, 1);
  await registry.tabRemoved(7);
  assert.equal(registry.records.size, 0); assert.equal(registry.cleanups.size, 0); assert.equal(registry.pending.size, 0);
});

test('exact tab removal cannot skip an actual pending recovery read', async () => {
  let reject; const pending = new Promise((_, no) => {reject=no;});
  const registry = new VisualDeliveries({hide:()=>{throw Error('Removed tab must not receive hide');}});
  const recovery = registry.recover(scope, run => run('RECOVERY_PRESENCE', () => pending));
  const removed = registry.tabRemoved(7); let complete=false;
  removed.then(()=>{complete=true;},()=>{complete=true;});
  await new Promise(setImmediate);
  assert.equal(complete,false); assert.ok([...registry.pending].some(item=>item.promise===pending));
  reject(Error('Actual original read rejected'));
  await Promise.all([recovery,removed]);
  assert.equal(registry.records.size,0); assert.equal(registry.pending.size,0);
});

import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import vm from "node:vm";
import { test } from "node:test";
import { buildChromeExtension } from "./build-chrome-extension.mjs";
import { patchCrxPointerFeedback, pointerFeedbackBridge } from "./patch-pointer-feedback.mjs";
import { PassivePointerReads, pointerFeedbackTarget, tagPointerFeedback, pointerCommandTarget } from "../apps/chrome-extension/browser-pointer-feedback.js";
const tagPointerCommand = params => params;

// Build the pinned, digest-checked production chain. Execute its actual mouse
// classes below; only the native transport and original page model are fakes.
const output = await fs.mkdtemp(new URL("../.tmp/pointer-feedback-pinned-", import.meta.url));
await buildChromeExtension(output);
const folder = path.join(output, "vendor/playwright-crx/upstream");
const entry = await fs.readFile(path.join(folder, "index.mjs"), "utf8");
const code = await fs.readFile(path.join(folder, /from ["']\.\/([^"']+\.mjs)/.exec(entry)[1]), "utf8");
const part = (start, end) => { const i = code.indexOf(start), j = code.indexOf(end, i); assert.ok(i >= 0 && j > i); return code.slice(i, j); };
const json = value => JSON.parse(JSON.stringify(value));
const deferred = () => { let resolve; const promise = new Promise(r => resolve = r); return { promise, resolve }; };

function mouseFixture(capture = () => undefined, send) {
  const commands = [], drops = [];
  const symbols = { pointerFeedbackTarget, tagPointerFeedback, tagPointerCommand, obuPointerTicket: Symbol(), obuDragProgress: Symbol() };
  const { Mouse, Raw } = vm.runInNewContext(part("let Mouse$1 = class Mouse", "const aliases =") + part("let RawMouseImpl$3 =", "let RawTouchscreenImpl$3 =") + "\n({ Mouse:Mouse$1, Raw:RawMouseImpl$3 });", {
    ...symbols, obuCaptureRawPointerTarget: capture, setTimeout, toModifiersMask$2: () => 0, toButtonsMask$2: buttons => buttons.size ? 1 : 0
  });
  let dragging = false;
  const drag = { isDragging: () => dragging, interceptDragCausedByMove: async (_x,_y,_b,_bs,_m,move) => move(),
    drop: async (...args) => drops.push(args) };
  const raw = new Raw({}, { send: async (method, params) => { commands.push({method, params, visual:pointerCommandTarget(params)}); return send?.(method, params); } }, drag);
  const mouse = new Mouse(raw, { keyboard:{ _modifiers:()=>new Set() } });
  return {mouse,commands,drops,symbols,setDragging: value => dragging=value};
}

for (const method of ["move", "click", "dblclick"]) test(`actual pinned Mouse.${method} carries original private target without changing native coordinates`, async () => {
  const f=mouseFixture(), target={originalNode:{}};
  await f.mouse[method](123,87,{[pointerFeedbackTarget]:target});
  assert.equal(f.commands.length,method==='move'?1:method==='click'?3:5);
  for(const row of f.commands){assert.equal(row.visual,target); assert.equal(row.params.x,123);assert.equal(row.params.y,87); assert.equal(JSON.stringify(row.params).includes('originalNode'),false);}
});

test('actual pinned drag drop retains the destination target and ordinary raw movement has no fabricated hint',async()=>{
 const f=mouseFixture(), visual={}; await f.mouse.move(9,10); assert.equal(f.commands[0].visual,undefined);
 f.setDragging(true); await f.mouse.up({[pointerFeedbackTarget]:visual}); assert.equal(f.drops[0].at(-1),visual);
});

test('actual raw click uses one candidate and retains parallel move/down/up before native ACKs',async()=>{
 const native=deferred(), visual={value:null,result:new Promise(()=>{})};let captures=0;
 const f=mouseFixture(()=>{captures++;return visual;},()=>native.promise);
 const clicked=f.mouse.click(17.25,28.5);
 await new Promise(setImmediate);
 assert.equal(captures,1);assert.deepEqual(f.commands.map(row=>row.params.type),['mouseMoved','mousePressed','mouseReleased']);
 assert.ok(f.commands.every(row=>row.visual===visual));
 native.resolve();await clicked;assert.equal(captures,1);
});

test('actual counted delayed raw click retains one candidate across every native pair',async()=>{
 let captures=0;const visual={};const f=mouseFixture(()=>{captures++;return visual;});
 await f.mouse.click(20,30,{clickCount:3,delay:1});
 assert.equal(captures,1);assert.equal(f.commands.length,7);assert.ok(f.commands.every(row=>row.visual===visual));
});

test('independent raw move/down/up/wheel capture independent optional hints',async()=>{
 const values=[];const f=mouseFixture(()=>{const value={index:values.length};values.push(value);return value;});
 await f.mouse.move(20,30);await f.mouse.down();await f.mouse.up();await f.mouse.wheel(0,5);
 assert.equal(values.length,4);for(let i=0;i<4;i++)assert.equal(f.commands[i].visual,values[i]);
});

function geometryFixture({child=false,cached}={}) {
 const attachment={}, context={world:'utility',_contextDestroyedScope:{isClosed:()=>false}}, currentDocument={};
 const frame={_id:'original-frame',_currentDocument:currentDocument,parentFrame:()=>null,pendingDocument:()=>null,_contextData:new Map([['utility',{context}]])};
 const native=deferred(), admission=deferred(), calls=[]; let disposed=false, held=false, sends=0;
 const transport={_tabToTarget:new Map([[7,attachment]]),_sessions:new Map(child?[['original-child',7]]:[]),async _send(target,method,params,beforeSend){calls.push({target,method,params}); if(held)await admission.promise; beforeSend(); sends++;return native.promise;}};
 const client={_sessionId:child?'original-child':'crx-tab-7',_connection:{_transport:transport}};
 const session={_client:client}, page={frameManager:{frame:()=>frame},delegate:{_sessionForHandle:()=>session,_sessionForFrame:()=>session}};
 const handle={_objectId:'original-object',_page:page};
 const state={rows:[{frame,parent:null,session,context}],sessionMaps:new Map([[session,[2,0,30,0,3,40,0,0,1]]]),check(){if(disposed)throw Error('disposed original handle or deadline');}};
 const reads=new PassivePointerReads(); let spec;
 const capture=vm.runInNewContext(pointerFeedbackBridge+'\nobuCapturePointerTarget;',{
  openBrowserUseInputHooks:{capturePointerFeedback(value){spec=value;return reads.start({...value,scope:{attachment}});}},
  obuFrameGeometry:{project:(m,p)=>({x:m[0]*p.x+m[1]*p.y+m[2],y:m[3]*p.x+m[4]*p.y+m[5]})}
 });
 return {capture:()=>capture(handle,{},state,cached),get spec(){return spec;},frame,context,transport,client,attachment,reads,native,admission,calls,get sends(){return sends;},dispose(){disposed=true;},hold(){held=true;}};
}
const model={model:{border:[1,2,11,2,11,12,1,12],content:[4,5,8,5,8,9,4,9]}};

for(const child of [false,true]) test(`original ${child?'child':'root'} route border is projected and normal handle disposal after send does not erase its snapshot`,async()=>{
 const f=geometryFixture({child}), c=f.capture(); assert.equal(f.sends,1); f.dispose(); f.native.resolve(model);
 assert.deepEqual(json(await c.result),{x:32,y:46,width:20,height:30});
 assert.deepEqual(json(f.calls[0]),{target:child?{tabId:7,sessionId:'original-child'}:{tabId:7},method:'DOM.getBoxModel',params:{objectId:'original-object'}});
});
test('explicit position reuses the exact original BoxModel border rather than reading or outlining its padding',async()=>{
 const f=geometryFixture({cached:model}),c=f.capture(); assert.deepEqual(json(await c.result),{x:32,y:46,width:20,height:30});assert.equal(f.calls.length,0);
});
test('original handle/deadline is checked after asynchronous native admission and before the actual read',async()=>{
 const f=geometryFixture(); f.hold();const c=f.capture(); f.dispose();f.admission.resolve();assert.equal(await c.result,null);assert.equal(f.sends,0);assert.equal(f.reads.pending.size,0);
});
for(const kind of ['document','context','route']) test(`native ACK held across original ${kind} loss cannot publish or borrow successor proof`,async()=>{
 const f=geometryFixture(),c=f.capture();
 if(kind==='document')f.frame._currentDocument={};
 if(kind==='context')f.frame._contextData.set('utility',{context:{}});
 if(kind==='route')f.transport._tabToTarget.set(7,{});
 f.native.resolve(model); assert.equal(await c.result,null);assert.equal(f.sends,1);
});
test('patch rejects a missing pinned adapter or repeated application',()=>{
 assert.throws(()=>patchCrxPointerFeedback(''),/requires/); assert.throws(()=>patchCrxPointerFeedback(code),/requires/);
});

function transportFixture({observer,hooks,send}={}) {
 const methods=part('  async _send(debuggee, method, commandParams, diagnosticGuard, pointerGuard) {','  _emitMessage(message) {');
 const Transport=vm.runInNewContext('class Transport {'+methods+'}; Transport;',{
  Promise,
  debugLogger:{isEnabled:()=>false},openBrowserUseCommandObserver:observer,openBrowserUseInputHooks:hooks,
  pointerCommandTarget,observeCrxInputCommand(){},chrome:{debugger:{sendCommand:send}}
 });
 return new Transport();
}

test('actual pinned standalone observer is notified only after the original native success ACK',async()=>{
 const native=deferred(),seen=[],original={value:'native'};
 const transport=transportFixture({observer:event=>seen.push(event),send:()=>native.promise});
 const sending=transport._send({tabId:7},'Input.dispatchMouseEvent',{type:'mouseMoved',x:4,y:5});
 const premature=seen.length; native.resolve(original); assert.equal(await sending,original);
 assert.equal(premature,0);assert.equal(seen.length,1);assert.equal(Object.hasOwn(seen[0],'phase'),false);
});

test('actual pinned failed native command never notifies a legacy observer',async()=>{
 const failure=Error('native rejection'); let notifications=0;
 const transport=transportFixture({observer:()=>notifications++,send:async()=>{throw failure;}});
 await assert.rejects(transport._send({tabId:7},'Input.dispatchMouseEvent',{}),error=>error===failure);
 assert.equal(notifications,0);
});

test('legacy observer rejected Promise is consumed without changing successful native result',async()=>{
 const rejected=Promise.reject(Error('observer failed'));let consumed=0;
 const originalCatch=rejected.catch.bind(rejected); originalCatch(()=>{}); // keep the red implementation from leaking into node:test
 rejected.catch=callback=>{consumed++;return originalCatch(callback);};
 const result={original:true},transport=transportFixture({observer:()=>rejected,send:async()=>result});
 assert.equal(await transport._send({tabId:7},'Input.dispatchMouseEvent',{}),result);
 await new Promise(setImmediate);assert.equal(consumed,1);
});

test('production prepare protocol captures private evidence before send and publishes only after the same ACK',async()=>{
 const native=deferred(),events=[],visual={original:true},params=tagPointerFeedback({type:'mouseMoved'},visual);
 const transport=transportFixture({hooks:{capturePointerFeedback(){},send:(_target,_method,_params,operation)=>operation()},
  observer:event=>{events.push(['prepare',event]);return ()=>events.push(['publish']);},send:()=>{events.push(['native']);return native.promise;}});
 const sending=transport._send({tabId:7},'Input.dispatchMouseEvent',params);
 assert.deepEqual(events.map(x=>x[0]),['prepare','native']);assert.equal(events[0][1].feedbackTarget,visual);
 native.resolve('actual');assert.equal(await sending,'actual');assert.deepEqual(events.map(x=>x[0]),['prepare','native','publish']);
});

import test from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";
import { EventEmitter } from "node:events";
import { createHash } from "node:crypto";
import { dragCommitCases as allDragCommitCases, installDragCommitHotspotDocument, checkDragCommitHotspot, dragCommitURLs, dragCommitHTML, createDragCommitFixtures, installDragCommitDocument, installDragCommitProbe,
  checkDragCommitTrace, checkDragCommitGuardTrace, checkDragCommitDocuments, checkDragCommit } from "./drag-commit-fixture.mjs";
const dragCommitCases = allDragCommitCases.filter(value => !value.hotspot);

const copy = value => structuredClone(value), sha = value => createHash("sha256").update(value).digest("hex"), base = "http://127.0.0.1:4321/", keyFor = name => `drag-commit-${"a".repeat(32)}-${name}`;
function documentFixture(spec, role = spec.layout === "root" ? "root" : "target") {
  const key=keyFor(spec.name),urls=dragCommitURLs(base,key),nodes=new Map(),windowEvents=new Map(),fetches=[];let now=0;
  const document={querySelector:selector=>nodes.get(selector.slice(1))??null};
  const makeNode=(id,box={x:0,y:0,width:0,height:0})=>({id,ownerDocument:document,isConnected:true,dataset:{},style:{},textContent:"",listeners:new Map(),captured:new Set(),box:{...box},
    getBoundingClientRect(){const n={...this.box};for(const [key,css]of[["x","left"],["y","top"],["width","width"],["height","height"]])if(this.style[css])n[key]=parseFloat(this.style[css]);if(this.style.transform==="translateX(160px)")n.x+=160;return n;},
    addEventListener(type,fn){if(!this.listeners.has(type))this.listeners.set(type,[]);this.listeners.get(type).push(fn);},
    cloneNode(){const node=makeNode(this.id,this.box);node.dataset={...this.dataset};node.style={...this.style};return node;},
    replaceWith(node){this.isConnected=false;nodes.set(this.id,node);},setPointerCapture(id){this.captured.add(id);},hasPointerCapture(id){return this.captured.has(id);}
  });
  document.createElement=()=>makeNode("");document.body={append:node=>nodes.set(node.id,node)};
  if(role!=="root"||spec.layout==="root"){nodes.set("source",makeNode("source",{x:60,y:70,width:130,height:80}));nodes.set("destination",makeNode("destination",{x:430,y:210,width:170,height:110}));nodes.set("trap",makeNode("trap",{x:60,y:70,width:130,height:80}));}
  const data=new Map(),context={document,window:{addEventListener:(type,fn)=>{if(!windowEvents.has(type))windowEvents.set(type,[]);windowEvents.get(type).push(fn);}},crypto:{randomUUID:()=>`document-${role}`},performance:{timeOrigin:1000,now:()=>++now},
    location:{href:role==="root"?urls.root:urls.target},innerWidth:1000,innerHeight:700,devicePixelRatio:1,scrollX:0,scrollY:0,structuredClone,URLSearchParams,
    fetch:async(url,options)=>{const bytes=Buffer.from(options.body);fetches.push({url,bytes,receipt:JSON.parse(options.body)});return{ok:true,json:async()=>({key,index:fetches.at(-1).receipt.index})};}};
  vm.runInNewContext(`(${installDragCommitDocument.toString()})(${JSON.stringify({key,spec,role})})`,context);
  const emit=(type,id="source",options={},windowOnly=false)=>{const node=typeof id==="string"?nodes.get(id):id;const event={type,target:node,isTrusted:true,clientX:125,clientY:110,buttons:0,button:0,pointerId:1,pointerType:"mouse",...options,composedPath:()=>[node,document],preventDefault(){this.defaultPrevented=true;},dataTransfer:{setData:(k,v)=>data.set(k,v),getData:k=>data.get(k)}};
    for(const listener of windowEvents.get(type)??[])listener(event);if(!windowOnly)for(const listener of node?.listeners.get(type)??[])listener(event);return event;};
  const read=()=>JSON.parse(JSON.stringify(context.readDragCommitDocument()));
  return{spec,key,urls,nodes,fetches,emit,read,settle:async()=>{for(let i=0;i<8;i++)await Promise.resolve();},document};
}
async function completedScene(spec,{oldLate=false,wrongDrop=false}={}) {
  const f=documentFixture(spec),before=f.read();
  if(spec.change==="source-hover-shift")f.emit("pointermove");
  f.emit("pointerdown","source",{buttons:1});
  if(spec.mode==="pointer") {f.emit("pointermove","source",{buttons:1,clientX:515,clientY:265});f.emit("pointerup","source",{buttons:0,clientX:515,clientY:265});f.nodes.get("source").captured.clear();}
  else if(spec.change!=="replace-after-down") {
    f.emit("dragstart","source",{buttons:1});f.emit("dragenter","destination",{clientX:515,clientY:265});
    if(spec.change!=="enter-cover") f.emit("dragover","destination",{clientX:515,clientY:265});
    if(spec.change==="late-dragover-cover"&&!oldLate)f.emit("dragover","destination",{clientX:515,clientY:265});
    if(spec.outcome==="drop"||oldLate)f.emit("drop","destination",{clientX:515,clientY:265});
    else if(spec.change==="late-dragover-cover")f.emit("drop","cover",{clientX:515,clientY:265},!wrongDrop);
  }
  if(wrongDrop&&spec.change==="enter-cover")f.emit("drop","cover",{clientX:515,clientY:265});
  if(wrongDrop&&spec.change==="replace-after-down"){f.emit("dragstart");f.emit("drop","destination",{clientX:515,clientY:265});}
  await f.settle();const after=f.read(),augment=(doc,i)=>({...doc,nativeDocumentId:`native-document-${i}`,nativeFrameId:i,nativeProcessId:i+1});
  const root=spec.layout==="oopif"?documentFixture(spec,"root"):null;
  const item={spec,key:f.key,before:root?[augment(root.read(),0),augment(before,1)]:[augment(before,0)],after:root?[augment(root.read(),0),augment(after,1)]:[augment(after,0)],
    ...(spec.outcome==="reject"&&!oldLate?{actionError:"OBU_POINTER_DRAG_CHANGED: original drag target changed"}:{}),server:{posts:f.fetches.map(value=>({bytes:value.bytes.length,bodyBase64:value.bytes.toString("base64"),sha256:sha(value.bytes),receipt:value.receipt,completedAt:2000}))}};
  return{f,item};
}
function trace(spec){const records=[],invoke=(method,params)=>{const sequence=records.length+1;records.push({sequence,kind:"invoke",source:{tabId:7},method,params},{sequence:sequence+1,kind:"settled",invocation:sequence,ok:true,result:{}});};
  invoke("Input.dispatchMouseEvent",{type:"mouseMoved",buttons:0,x:125,y:110});if(spec.change==="source-hover-shift")invoke("Input.dispatchMouseEvent",{type:"mouseMoved",buttons:0,x:285,y:110});
  invoke("Input.dispatchMouseEvent",{type:"mousePressed",button:"left",buttons:1,x:spec.change==="source-hover-shift"?285:125,y:110});
  if(spec.outcome==="drop"||spec.change==="late-dragover-cover")invoke("Input.dispatchDragEvent",{type:"drop",x:515,y:265});else invoke("Input.dispatchMouseEvent",{type:"mouseReleased",button:"left",buttons:0,x:515,y:265});
  return{version:1,id:"probe",tabId:7,pending:0,overflow:false,recordingErrors:0,restored:true,records};}

test("seven independent HTML fixtures include real OOPIF, original token observer and second-dragover mutation",()=>{
  assert.equal(dragCommitCases.length,7);for(const spec of dragCommitCases){const urls=dragCommitURLs(base,keyFor(spec.name)),root=dragCommitHTML(new URL(urls.root));assert.match(root,/readDragCommitDocument/);assert.match(root,/event\.isTrusted/);if(spec.layout==="oopif"){assert.equal(new URL(urls.target).hostname,"localhost");assert.match(root,/id="drag-frame"/);assert.match(dragCommitHTML(new URL(urls.target)),/id="source"/);}else assert.equal(urls.root,urls.target);}
  assert.throws(()=>dragCommitURLs(base,"bad"));assert.throws(()=>dragCommitHTML(new URL("/other?key="+keyFor("root-html"),base)));
});

test("fixture server preserves every successful or erroneous business POST's exact bytes",()=>{
  const fixtures=createDragCommitFixtures(),key=keyFor("root-html"),replies=[],response=()=>({writeHead:(status,headers)=>replies.push({status,headers}),end:body=>{replies.at(-1).body=body;}}),url=new URL(dragCommitURLs(base,key).root);
  assert.equal(fixtures.handle({method:"GET"},response(),url),true);const served=replies.at(-1).body;assert.equal(fixtures.stats(key).gets[0].sha256,sha(served));
  const req=new EventEmitter();req.method="POST";const body=Buffer.from(JSON.stringify({key,scene:"root-html",index:1,reason:"wrong-drop",correct:false}));
  fixtures.handle(req,response(),new URL(`/drag-commit/post?key=${key}`,base));req.emit("data",body.subarray(0,13));req.emit("data",body.subarray(13));req.emit("end");
  const post=fixtures.stats(key).posts[0];assert.equal(replies.at(-1).status,200);assert.equal(post.receipt.correct,false);assert.equal(post.bodyBase64,body.toString("base64"));assert.equal(post.sha256,sha(body));assert.equal(post.chunks,2);
  const cloned=fixtures.stats(key);cloned.posts.length=0;assert.equal(fixtures.allStats()[0].posts.length,1);
  fixtures.handle({method:"POST"},response(),url);assert.equal(replies.at(-1).status,405);assert.equal(fixtures.handle({method:"GET"},response(),new URL("/other",base)),false);
});

test("actual serialized page handlers mutate only on trusted hover/down and retain the original node",async()=>{
  const spec=dragCommitCases.find(v=>v.change==="source-hover-shift"),f=documentFixture(spec),original=f.nodes.get("source");f.emit("pointermove","source",{isTrusted:false});assert.equal(f.read().shifted,false);
  f.emit("pointermove");assert.equal(f.read().shifted,true);assert.equal(f.read().source.rect.x,220);assert.equal(f.nodes.get("source"),original);f.emit("pointermove");assert.equal(f.read().mutations.length,1);
  f.emit("pointerdown","trap",{buttons:1});await f.settle();assert.equal(f.fetches.length,1);assert.equal(f.fetches[0].receipt.reason,"wrong-source-down");assert.equal(f.fetches[0].receipt.correct,false);
  const replacement=documentFixture(dragCommitCases.find(v=>v.change==="replace-after-down")),old=replacement.nodes.get("destination");replacement.emit("pointerdown","source",{buttons:1});assert.equal(old.isConnected,false);assert.equal(replacement.read().destinationIsOriginal,false);assert.equal(replacement.read().currentDestination.token,"replacement-destination");
});

test("all seven final-contract document ledgers satisfy actual handler, node and business receipt checks",async()=>{
  for(const spec of dragCommitCases){const {item}=await completedScene(spec);const proof=checkDragCommitDocuments(item);assert.equal(proof.sourcePresses,1);assert.equal(proof.businessDrops,spec.outcome==="drop"?1:0);}
});

test("cover and replacement business handlers make old misdrops explicit rather than silently timing out",async()=>{
  for(const name of ["enter-cover","replace-after-down","late-dragover-cover"]){const spec=dragCommitCases.find(v=>v.name===name),{item}=await completedScene(spec,{wrongDrop:true});assert.equal(item.server.posts.length,1);assert.equal(item.server.posts[0].receipt.correct,false);assert.equal(item.server.posts[0].receipt.reason,"wrong-drop");assert.throws(()=>checkDragCommitDocuments(item));}
});

test("a missing second dragover is retained as an untriggered mutation, not evidence of an old misdrop",async()=>{
  const spec=dragCommitCases.find(v=>v.name==="late-dragover-cover"),{item}=await completedScene(spec,{oldLate:true});assert.equal(item.after[0].dragovers,1);assert.equal(item.after[0].mutations.length,0);assert.equal(item.server.posts[0].receipt.correct,true);assert.equal(item.actionError,undefined);assert.throws(()=>checkDragCommitDocuments(item));
});

test("late native drop may be passively observed but must never reach a business handler",async()=>{
  const spec=dragCommitCases.find(v=>v.name==="late-dragover-cover"),{item}=await completedScene(spec),proof=checkDragCommitDocuments(item);assert.equal(proof.observedDropEvents,1);assert.equal(proof.businessDrops,0);assert.equal(item.server.posts.length,0);
  const changed=copy(item);changed.after[0].businessDrops=1;assert.throws(()=>checkDragCommitDocuments(changed),/business drop handler/);
});

test("capture-mode release proves original source capture and submits the exact destination coordinates",async()=>{
  const spec=dragCommitCases.find(v=>v.mode==="pointer"),{item}=await completedScene(spec),receipt=item.server.posts[0].receipt;assert.equal(receipt.captured,true);assert.equal(receipt.event.sourceInPath,true);assert.equal(receipt.correct,true);assert.equal(item.after[0].capturedPointer,false);checkDragCommitDocuments(item);
  const changed=copy(item);changed.after[0].capturedPointer=true;assert.throws(()=>checkDragCommitDocuments(changed));
});

test("native ledgers require original root routing, settled ordered press and no replay after commitment",()=>{
  for(const spec of dragCommitCases)checkDragCommitTrace(trace(spec),spec);
  const spec=dragCommitCases[0];for(const mutate of [v=>{v.pending=1;},v=>{v.records[0].source.sessionId="child";},v=>{v.records.pop();},v=>{v.records[2].params.type="mouseMoved";},v=>{v.records[1].ok=false;},v=>{v.records[4].params.type="mousePressed";},v=>{v.overflow=true;}]){const changed=trace(spec);mutate(changed);assert.throws(()=>checkDragCommitTrace(changed,spec));}
  const shift=dragCommitCases.find(v=>v.change==="source-hover-shift"),changed=trace(shift);changed.records[2].params.x=changed.records[0].params.x;assert.throws(()=>checkDragCommitTrace(changed,shift));
});

test("transparent native observer retains original Promise, receiver, payload and rejected native ACK",async()=>{
  const listeners=new Set(),target={},source={tabId:7},params={type:"mouseMoved",x:1,y:2};let seen;const originalPromise=Promise.resolve({ack:"native"});const api={debugger:{sendCommand:function(...args){seen={receiver:this,args};return originalPromise;},onEvent:{addListener:fn=>listeners.add(fn),removeListener:fn=>listeners.delete(fn)}}},original=api.debugger.sendCommand;
  installDragCommitProbe(api,target,{id:"x",tabId:7});const result=api.debugger.sendCommand(source,"Input.dispatchMouseEvent",params);assert.equal(result,originalPromise);assert.equal(seen.receiver,api.debugger);assert.equal(seen.args[0],source);assert.equal(seen.args[2],params);await result;
  const snapshot=target.__obuDragCommit.restore();assert.equal(snapshot.pending,0);assert.equal(snapshot.records[1].result.ack,"native");assert.equal(api.debugger.sendCommand,original);assert.equal(listeners.size,0);
  const error=Error("native rejected"),failed=Promise.reject(error);failed.catch(()=>{});api.debugger.sendCommand=()=>failed;installDragCommitProbe(api,target,{id:"y",tabId:7});assert.equal(api.debugger.sendCommand(source,"Input.dispatchMouseEvent",params),failed);await assert.rejects(failed,e=>e===error);const failure=target.__obuDragCommit.restore();assert.equal(failure.records[1].ok,false);assert.match(failure.records[1].error,/native rejected/);
});

test("guard observer binds original factory result, true cancel ACK and release across a child session without observing unrelated Runtime",async()=>{
  const listeners=new Set(),target={},source={tabId:7,sessionId:"original-child"},calls=[],cancel="async function() { try { await this.cancel(); return true; } catch { return false; } }";
  let returnValue={};const api={debugger:{sendCommand:function(...args){const promise=Promise.resolve(returnValue);calls.push({receiver:this,args,promise});return promise;},onEvent:{addListener:fn=>listeners.add(fn),removeListener:fn=>listeners.delete(fn)}}};
  installDragCommitProbe(api,target,{id:"guard-probe",tabId:7});
  const send=async(method,params,value={})=>{returnValue=value;const result=api.debugger.sendCommand(source,method,params);assert.equal(result,calls.at(-1).promise);assert.equal(calls.at(-1).receiver,api.debugger);assert.equal(calls.at(-1).args[2],params);await result;};
  await send("Runtime.callFunctionOn",{objectId:"target-node",functionDeclaration:"function unrelatedInjectedScript() { return 'unrelated'; }"});
  await send("Runtime.callFunctionOn",{objectId:"target-node",functionDeclaration:"function() { return (function createDragCommitGuard(node, options) {})(this, {}); }"},{result:{type:"object",objectId:"guard-object"}});
  await send("Runtime.callFunctionOn",{objectId:"guard-object",functionDeclaration:"function(){ return this.read(); }"},{result:{value:{ready:true}}});
  await send("Runtime.releaseObject",{objectId:"unrelated-object"});
  await send("Runtime.callFunctionOn",{objectId:"guard-object",functionDeclaration:cancel},{result:{value:true}});
  await send("Runtime.releaseObject",{objectId:"guard-object"});
  const probe=target.__obuDragCommit.restore(),proof=checkDragCommitGuardTrace(probe);assert.equal(proof.installed,1);assert.equal(proof.leases[0].objectId,"guard-object");assert.deepEqual(proof.leases[0].source,source);assert.equal(probe.records.length,6);assert.equal(calls.length,6);assert.equal(listeners.size,0);
  for(const mutate of [v=>{v.records[3].result.result.value=false;},v=>{v.records[4].source.sessionId="successor";},v=>{v.records[4].params.objectId="wrong-object";},v=>{v.records[5].ok=false;},v=>{v.records[1].result.result.objectId="unknown-guard";},v=>{v.records[4].sequence=3;}]){const changed=copy(probe);mutate(changed);assert.throws(()=>checkDragCommitGuardTrace(changed));}
  assert.equal(checkDragCommitGuardTrace(trace(dragCommitCases[0])).installed,0,"old baseline absence is retained, not candidate cleanup evidence");
});

test("document replacement, bad native identity, duplicate POST and altered bytes cannot pass",async()=>{
  const {item}=await completedScene(dragCommitCases[0]);for(const mutate of [v=>{v.after[0].documentToken="replacement";},v=>{v.after[0].nativeDocumentId="replacement";},v=>{v.after[0].sourceIsOriginal=false;},v=>{v.after[0].ledger[0].sourceInPath=false;},v=>{v.server.posts.push(copy(v.server.posts[0]));},v=>{v.server.posts[0].bodyBase64=Buffer.from("altered").toString("base64");},v=>{v.after[0].pendingReceipts=1;},v=>{v.after[0].overflow=true;}]){const changed=copy(item);mutate(changed);assert.throws(()=>checkDragCommitDocuments(changed));}
});

test("one failed original scene does not discard later baseline attempts or overwrite its error",async()=>{
  let attempts=0;const original=Error("first real action failure"),detail={},server=createDragCommitFixtures();await assert.rejects(checkDragCommit({browser:{newTab:async()=>{attempts++;throw attempts===1?original:Error("later");}},worker:{},fixtureURL:base,server,until:()=>{},detail}),error=>error===original);assert.equal(attempts,10);assert.equal(detail.cases.length,10);assert.equal(detail.passed,false);assert.match(detail.error,/first real action failure/);
});


function hotspotFixture(spec) {
  const key = keyFor(spec.name), urls = dragCommitURLs(base, key), nodes = new Map(), listeners = new Map(), posts = [], transfer = new Map(); let now = 0;
  const document = { querySelector: selector => nodes.get(selector.slice(1)) ?? null };
  const makeNode = (id, box) => ({ id, box, ownerDocument: document, isConnected: true, dataset: {}, style: {}, listeners: new Map(), children: [],
    append(child) { child.parentElement = this; this.children.push(child); },
    addEventListener(type, fn) { const list = this.listeners.get(type) ?? []; list.push(fn); this.listeners.set(type, list); },
    getBoundingClientRect() { if (this.box) return { ...this.box }; const parent = this.parentElement, b = parent.box, css = computed(parent), x = parseFloat(css.borderLeftWidth) + parseFloat(this.style.left), y = parseFloat(css.borderTopWidth) + parseFloat(this.style.top), rotated = css.rotate === "180deg"; return { x: b.x + (rotated ? b.width - x : x), y: b.y + (rotated ? b.height - y : y), width: 0, height: 0 }; }
  });
  nodes.set("source", makeNode("source", { x: 60, y: 70, width: 130, height: 80 })); nodes.set("destination", makeNode("destination", { x: 430, y: 210, width: 170, height: 110 }));
  document.createElement = () => makeNode("");
  const computed = node => ({ boxSizing: "border-box", left: node.box.x + "px", top: node.box.y + "px", width: node.box.width + "px", height: node.box.height + "px", transform: "none", transformOrigin: `${node.box.width / 2}px ${node.box.height / 2}px`, rotate: "none", zoom: "1", borderLeftWidth: "4px", borderTopWidth: "4px", ...node.style });
  const context = { document, window: { addEventListener(type, fn) { const list = listeners.get(type) ?? []; list.push(fn); listeners.set(type, list); } }, getComputedStyle: computed,
    crypto: { randomUUID: () => "original-hotspot-document" }, performance: { timeOrigin: 1000, now: () => ++now }, location: { href: urls.root }, innerWidth: 1000, innerHeight: 700, devicePixelRatio: 1, scrollX: 0, scrollY: 0, structuredClone, URLSearchParams,
    fetch: async (url, options) => { const bytes = Buffer.from(options.body), receipt = JSON.parse(options.body); posts.push({ bytes: bytes.length, bodyBase64: bytes.toString("base64"), sha256: sha(bytes), receipt, completedAt: 2000 }); return { ok: true, json: async () => ({ key, index: receipt.index }) }; }
  };
  vm.runInNewContext(`(${installDragCommitHotspotDocument.toString()})(${JSON.stringify({ key, spec, role: "root" })})`, context);
  const emit = (type, id, options = {}, windowOnly = false) => { const node = nodes.get(id), event = { type, target: node, isTrusted: true, clientX: id === "source" ? 88 : 474, clientY: id === "source" ? 94 : 244, buttons: type === "pointerdown" ? 1 : 0, button: 0, pointerId: 1, pointerType: "mouse", ...options,
    composedPath: () => [node, document], preventDefault() {}, dataTransfer: { setData: (k, v) => transfer.set(k, v), getData: k => transfer.get(k) } };
    for (const fn of listeners.get(type) ?? []) fn(event); if (!windowOnly) for (const fn of node.listeners.get(type) ?? []) fn(event); return event;
  };
  const read = () => JSON.parse(JSON.stringify(context.readDragCommitDocument()));
  return { spec, key, posts, nodes, emit, read, async settle() { for (let i = 0; i < 8; i++) await Promise.resolve(); } };
}

async function hotspotScene(spec, { wrongDrop = false, dropX = 474, dropY = 244 } = {}) {
  const f = hotspotFixture(spec), before = f.read(); f.emit("pointerdown", "source"); f.emit("dragstart", "source"); f.emit("dragenter", "destination"); f.emit("dragover", "destination");
  if (spec.change) f.emit("dragover", "destination");
  f.emit("drop", "destination", { clientX: dropX, clientY: dropY }, Boolean(spec.change && !wrongDrop)); await f.settle();
  const augment = value => ({ ...value, nativeDocumentId: "exact-native-document", nativeFrameId: 0, nativeProcessId: 7 });
  return { f, item: { spec, key: f.key, before: [augment(before)], after: [augment(f.read())], server: { posts: f.posts }, ...(spec.change && !wrongDrop ? { actionError: "Original target geometry changed during native drop" } : {}) } };
}

test("three explicit-position fixtures request independent source and target padding hotspots", () => {
  assert.equal(allDragCommitCases.length, 10); assert.deepEqual(allDragCommitCases.slice(0, 7), dragCommitCases);
  for (const spec of allDragCommitCases.filter(value => value.hotspot)) {
    assert.deepEqual(spec.sourcePosition, { x: 24, y: 20 }); assert.deepEqual(spec.targetPosition, { x: 40, y: 30 });
    const html = dragCommitHTML(new URL(dragCommitURLs(base, keyFor(spec.name)).root)); assert.match(html, /installDragCommitHotspotDocument/); assert.match(html, /pointerEvents: "none"/); assert.match(html, /dragovers !== 2/);
  }
});

test("actual hotspot page handlers and independent markers distinguish correct explicit drops from late wrong local points", async () => {
  for (const spec of allDragCommitCases.filter(value => value.hotspot)) {
    const { item } = await hotspotScene(spec); checkDragCommitDocuments(item);
    const proof = item.after[0].hotspots.destination; checkDragCommitHotspot(proof, "destination");
    const expected = spec.change === "late-individual-rotate" ? { x: 556, y: 286 } : spec.change === "late-border-origin" ? { x: 494, y: 264 } : { x: 474, y: 244 };
    assert.deepEqual(proof.expectedClientPoint, expected); assert.deepEqual(proof.markerPoint, expected);
    if (spec.change) {
      const old = await hotspotScene(spec, { wrongDrop: true }), receipt = old.item.server.posts[0].receipt;
      assert.equal(old.item.server.posts.length, 1); assert.equal(receipt.reason, "wrong-hotspot-drop"); assert.equal(receipt.correct, false); assert.equal(receipt.hotspot.correct, false);
      assert.deepEqual(receipt.hotspot.local, spec.change === "late-individual-rotate" ? { x: 122, y: 72 } : { x: 20, y: 10 });
      assert.deepEqual(JSON.parse(Buffer.from(old.item.server.posts[0].bodyBase64, "base64").toString()), receipt);
      assert.throws(() => checkDragCommitDocuments(old.item));
    } else { assert.equal(item.server.posts[0].receipt.correct, true); assert.deepEqual(item.server.posts[0].receipt.hotspot.local, spec.targetPosition); }
  }
});

test("the second trusted dragover is required for both same-AABB geometry mutations", () => {
  for (const spec of allDragCommitCases.filter(value => value.hotspot && value.change)) {
    const f = hotspotFixture(spec); f.emit("dragover", "destination", { isTrusted: false }); assert.equal(f.read().dragovers, 0);
    f.emit("dragover", "destination"); assert.equal(f.read().mutations.length, 0); f.emit("dragover", "destination"); assert.equal(f.read().mutations.length, 1);
    assert.deepEqual(f.read().mutations[0].beforeHotspot.rect, f.read().mutations[0].afterHotspot.rect); assert.equal(f.read().mutations[0].dragovers, 2);
  }
});

test("explicit geometry proof rejects forged markers, CSS, local arithmetic and shifted native points", async () => {
  const spec = allDragCommitCases.find(value => value.name === "explicit-position"), { item } = await hotspotScene(spec), proof = item.server.posts[0].receipt.hotspot;
  for (const mutate of [v => { v.markerPoint.x++; }, v => { v.local.x++; }, v => { v.correct = false; }, v => { v.css.borderLeftWidth = "5px"; }, v => { v.rect.width++; }, v => { v.css.rotate = "90deg"; }]) {
    const changed = copy(proof); mutate(changed); assert.throws(() => checkDragCommitHotspot(changed, "destination"));
  }
  for (const scene of allDragCommitCases.filter(value => value.hotspot)) {
    const value = trace({ ...scene, change: "late-dragover-cover" }); for (const row of value.records.filter(row => row.kind === "invoke")) { row.params.x = row.params.type === "drop" ? 474 : 88; row.params.y = row.params.type === "drop" ? 244 : 94; }
    checkDragCommitTrace(value, scene); value.records.find(row => row.params?.type === "drop").params.x += .1; assert.throws(() => checkDragCommitTrace(value, scene), /explicit point/);
  }
});

test("root explicit drop requires exact marker delivery even inside its twelve-pixel business hotspot", async () => {
  const spec = allDragCommitCases.find(value => value.name === "explicit-position");
  for (const offset of [{ dropX: 475 }, { dropY: 245 }]) {
    const { item } = await hotspotScene(spec, offset);
    assert.equal(item.server.posts[0].receipt.correct, true, "This event still reaches the business hotspot");
    assert.throws(() => checkDragCommitDocuments(item), /Root explicit drop must match/);
  }
});

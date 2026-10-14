import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { deflateSync } from "node:zlib";
import { boundingGeometryCases, boundingGeometryURLs, boundingGeometryHTML, boundingFrameStyle, boundingRootPoint, boundingRendererSession,
  createBoundingGeometryFixtures, installBoundingGeometryProbe, checkBoundingGeometryDocuments, checkBoundingGeometryTrace,
  checkBoundingGeometryPixels, checkBoundingGeometryPhase, checkBoundingGeometry } from "./bounding-geometry-fixture.mjs";
import { parallelElementClip } from "./background-parallel-workflow.mjs";

const key = name => `bounding-${"a".repeat(32)}-${name}`, base = "http://127.0.0.1:4321/", sha = value => createHash("sha256").update(value).digest("hex");
const copy = value => structuredClone(value), boundsSpec = boundingGeometryCases.find(value => value.bounds);
const points = [["nw",0,0],["ne",280,0],["se",280,160],["sw",0,160],["body",195,105],["patch",63,48],["border",4,80]];
function rootDocument({ dpr = 1, phase = 0 } = {}) {
  const styles = { width: "280px", height: "160px", boxSizing: "border-box", display: "block", transform: "matrix(1, 0, 0, 1, 0, 0)", borderLeftWidth: "8px" };
  const rect = { x: 90.25, y: 85.5, width: 280, height: 160 };
  return { role: "root", href: boundingGeometryURLs(base, key("root-bounds")).root, documentToken: "original", nativeDocumentId: "doc-0", nativeFrameId: 0, nativeProcessId: 1, inputEvents: 0,
    viewport: { width: 1000, height: 800, dpr, scrollX: 0, scrollY: 0 }, originalNode: true,
    target: { id: "target", connected: true, rect, styles }, proof: { id: "proof", connected: true, rect: copy(rect), styles: copy(styles) }, phase,
    markers: points.map(([id,x,y]) => ({ id, x: x + rect.x, y: y + rect.y, width: 0, height: 0 })) };
}
function ownerDocument(spec, role = "root", { scrollX = 0, scrollY = 0 } = {}) {
  const f = boundingFrameStyle(spec, role), radians = f.angle * Math.PI / 180, a = f.sx * Math.cos(radians), b = f.sx * Math.sin(radians), c = -f.sy * Math.sin(radians), d = f.sy * Math.cos(radians);
  const map = (x,y) => ({ x: f.left + f.originX + a * (x - f.originX) + c * (y - f.originY) - scrollX, y: f.top + f.originY + b * (x - f.originX) + d * (y - f.originY) - scrollY });
  const corners = [[0,0],[f.width + 2*f.border,0],[f.width+2*f.border,f.height+2*f.border],[0,f.height+2*f.border]].map(([x,y])=>map(x,y));
  const minX = Math.min(...corners.map(p=>p.x)), minY = Math.min(...corners.map(p=>p.y));
  const styles = Object.fromEntries(Object.entries({ width:f.width,height:f.height,left:f.left,top:f.top,borderLeftWidth:f.border,borderRightWidth:f.border,borderTopWidth:f.border,borderBottomWidth:f.border,paddingLeft:0,paddingRight:0,paddingTop:0,paddingBottom:0 }).map(([k,v])=>[k,`${v}px`]));
  Object.assign(styles, { boxSizing:"content-box",zoom:"1",transformOrigin:`${f.originX}px ${f.originY}px`,transform:`matrix(${[a,b,c,d,0,0].join(", ")})` });
  return { ...rootDocument(), role, originalNode:null, target:null,proof:null,markers:[],viewport:{width:1000,height:800,dpr:1,scrollX,scrollY},
    frame:{id:"geometry-frame",connected:true,styles,rect:{x:minX,y:minY,width:Math.max(...corners.map(p=>p.x))-minX,height:Math.max(...corners.map(p=>p.y))-minY}} };
}
function chunk(type, data) {
  const body = Buffer.concat([Buffer.from(type), data]), header = Buffer.alloc(4), trailer = Buffer.alloc(4); header.writeUInt32BE(data.length);
  let crc = 0xffffffff; for (const byte of body) { crc ^= byte; for (let bit=0;bit<8;bit++) crc=(crc>>>1)^((crc&1)?0xedb88320:0); }
  trailer.writeUInt32BE((crc ^ 0xffffffff) >>> 0); return Buffer.concat([header,body,trailer]);
}
function png(document, { phase = 0, corrupt = false, extraWidth = 0 } = {}) {
  const clip = parallelElementClip(document.target.rect), dpr = document.viewport.dpr, width = Math.round(clip.width*dpr)+extraWidth, height = Math.round(clip.height*dpr), stride=width*3, raw=Buffer.alloc((stride+1)*height);
  for(let y=0;y<height;y++) for(let x=0;x<width;x++) {
    const localX=(x+.5)/dpr+clip.x-document.target.rect.x, localY=(y+.5)/dpr+clip.y-document.target.rect.y;
    let color = localX<0||localY<0||localX>=280||localY>=160 ? [248,250,252] : localX<8||localY<8||localX>=272||localY>=152 ? [204,34,136] : localX>=33&&localX<93&&localY>=28&&localY<68 ? phase?[244,200,61]:[34,153,221] : [34,204,136];
    if(corrupt) color=[0,0,0]; const i=y*(stride+1)+1+x*3; color.forEach((v,c)=>{raw[i+c]=v;});
  }
  const header=Buffer.alloc(13);header.writeUInt32BE(width);header.writeUInt32BE(height,4);header[8]=8;header[9]=2;
  return Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10]),chunk("IHDR",header),chunk("IDAT",deflateSync(raw)),chunk("IEND",Buffer.alloc(0))]);
}
function phaseFixture() {
  const document=rootDocument(), bytes=png(document), border=document.markers.slice(0,4).flatMap(p=>[p.x,p.y]), clip=parallelElementClip(document.target.rect), records=[];
  const invoke=(phase,method,params,result,source={tabId:7})=>{const sequence=records.length+1;records.push({sequence,kind:"invoke",phase,source,method,params},{sequence:sequence+1,kind:"settled",phase,invocation:sequence,ok:true,result});};
  invoke("bbox","DOM.getBoxModel",{objectId:"target-object"},{model:{border}});invoke("screenshot","DOM.getBoxModel",{objectId:"target-object"},{model:{border}});invoke("screenshot","Page.captureScreenshot",{clip},{data:bytes.toString("base64")});
  const hidden = { ...copy(document), role:"target",nativeDocumentId:"hidden-doc",documentToken:"hidden-token",nativeProcessId:2,href:"http://localhost:4321/hidden" };
  return { phase:0,before:[document],after:[copy(document)],box:copy(document.target.rect),screenshot:{mimeType:"image/png",base64:bytes.toString("base64")},
    probe:{version:1,restored:true,pending:0,overflow:false,recordingErrors:0,tabId:7,records},native:{targets:[],attachments:[]},hiddenParentBefore:hidden,hiddenParentAfter:copy(hidden),
    bounds:{negative:{box:{x:-30.5,y:-18.25,width:80,height:40}},far:{box:{x:80.5,y:1460.25,width:72,height:36}},zero:{box:{x:520.5,y:70.25,width:0,height:28}},"zero-height":{box:{x:560.5,y:70.25,width:25,height:0}},hidden:{box:null},"hidden-parent":{box:null}} };
}

test("seven fixture routes preserve distinct original documents, cross-origin local root and replacement", () => {
  assert.equal(boundingGeometryCases.length,7);
  for(const spec of boundingGeometryCases) {
    const urls=boundingGeometryURLs(base,key(spec.name)); const html=boundingGeometryHTML(new URL(urls.root));
    assert.match(html,/readBoundingGeometryDocument/);assert.match(html,/pointer-events:none/);
    if(spec.layout!=="root") {const child=boundingGeometryHTML(new URL(urls.target));assert.match(child,/id="target"/);assert.match(child,/id="mark-nw" style="left:-8px;top:-8px"/);assert.equal(new URL(urls.target).hostname,spec.layout==="same"?"127.0.0.1":"localhost");}
    if(spec.layout==="nested") {assert.equal(new URL(urls.middle).origin,new URL(urls.target).origin);assert.match(boundingGeometryHTML(new URL(urls.middle)),/id="geometry-frame"/);}
    if(spec.navigation) {const next=boundingGeometryURLs(base,key(spec.name),1);assert.equal(next.root,urls.root);assert.notEqual(next.target,urls.target);assert.match(boundingGeometryHTML(new URL(next.target)),/#f4c83d/);}
  }
  const html=boundingGeometryHTML(new URL(boundingGeometryURLs(base,key("root-bounds")).root));
  assert.match(html,/id="zero-height"/);assert.match(html,/#hidden-owner\{display:none\}/);const hidden=/id="hidden-owner" src="([^"]+)"/.exec(html)[1];assert.equal(new URL(hidden).hostname,"localhost");assert.doesNotMatch(boundingGeometryHTML(new URL(hidden)),/id="hidden-owner"/);
  assert.throws(()=>boundingGeometryURLs(base,"unsafe-key"));assert.throws(()=>boundingGeometryURLs(base,key("root"),1));
});

test("server logs exact served HTML bytes and rejects invalid mutations", () => {
  const fixtures=createBoundingGeometryFixtures(), url=new URL(boundingGeometryURLs(base,key("root")).root), replies=[];
  const response={writeHead:(status,headers)=>replies.push({status,headers}),end:body=>replies.at(-1).body=body};
  assert.equal(fixtures.handle({method:"GET"},response,url),true);assert.equal(replies[0].status,200);
  const entry=fixtures.stats(key("root"));assert.equal(entry.gets[0].sha256,sha(replies[0].body));assert.equal(entry.gets[0].bytes,replies[0].body.length);
  entry.gets.length=0;assert.equal(fixtures.stats(key("root")).gets.length,1);assert.equal(fixtures.handle({method:"POST"},response,url),true);assert.equal(replies.at(-1).status,405);
  const bad=new URL(url);bad.searchParams.set("key","bad");fixtures.handle({method:"GET"},response,bad);assert.equal(replies.at(-1).status,400);
  assert.equal(fixtures.handle({method:"GET"},response,new URL("/other",base)),false);
});

test("independent parent projection includes scale, border, origin, scrolling and nested local-root transforms", () => {
  const spec=boundingGeometryCases.find(v=>v.name==="oopif-scale"), root=ownerDocument(spec), child={...rootDocument(),role:"target",nativeDocumentId:"doc-1"}, point=boundingRootPoint({x:100,y:200},[root,child],spec);
  assert.ok(Math.abs(point.x-195.8)<1e-10);assert.ok(Math.abs(point.y-237.48)<1e-10);
  root.viewport.scrollX=12;root.viewport.scrollY=20;const scrolled=boundingRootPoint({x:100,y:200},[root,child],spec);assert.ok(Math.abs(scrolled.x-(195.8-12))<1e-10);assert.ok(Math.abs(scrolled.y-(237.48-20))<1e-10);
  const nested=boundingGeometryCases.find(v=>v.layout==="nested"), docs=[ownerDocument(nested),ownerDocument(nested,"middle"),child], projected=boundingRootPoint({x:100,y:200},docs,nested);
  assert.ok(Math.abs(projected.x-196.93177586212192)<1e-9);assert.ok(Math.abs(projected.y-321.553045776595)<1e-9);
});

test("original-node identity, exact document and authored frame contracts cannot silently drift", () => {
  const spec=boundingGeometryCases.find(v=>v.name==="oopif-scale"), docs=[ownerDocument(spec),{...rootDocument(),role:"target",nativeDocumentId:"doc-1"}];
  checkBoundingGeometryDocuments(docs,copy(docs),spec);
  for(const mutate of [v=>{v[1].originalNode=false;},v=>{v[1].documentToken="replacement";},v=>{v[1].proof.rect.width++;},v=>{v[0].frame.styles.borderLeftWidth="5px";},v=>{v[0].frame.styles.transform="matrix(1,0,0,1,0,0)";},v=>{v[1].inputEvents=1;}]) {const changed=copy(docs);mutate(changed);assert.throws(()=>checkBoundingGeometryDocuments(docs,changed,spec));}
});

test("transparent native observer retains original Promise/receiver/arguments and actual capture ACK bytes", async () => {
  const events=new Set(),target={},source={tabId:7},params={clip:{x:0,y:0,width:2,height:2,scale:1}}, value={data:"native-image"};let received;const promise=Promise.resolve(value);
  const api={debugger:{sendCommand:function(...args){received={receiver:this,args};return promise;},onEvent:{addListener:fn=>events.add(fn),removeListener:fn=>events.delete(fn)}}},original=api.debugger.sendCommand;
  installBoundingGeometryProbe(api,target,{id:"probe",tabId:7});target.__obuBoundingGeometry.mark("screenshot");const returned=api.debugger.sendCommand(source,"Page.captureScreenshot",params);
  assert.equal(returned,promise);assert.equal(received.receiver,api.debugger);assert.equal(received.args[0],source);assert.equal(received.args[2],params);await returned;
  const result=target.__obuBoundingGeometry.restore(),trace=checkBoundingGeometryTrace(result);assert.equal(api.debugger.sendCommand,original);assert.equal(events.size,0);assert.equal(trace.acknowledgements.get(trace.captures[0].sequence).result.data,value.data);
});

test("optional raw runtime observation preserves original allocations and release acknowledgements",async()=>{
  for(const captureRuntime of [false,true]){
    const events=new Set(),target={},promises=[],source={tabId:7,sessionId:"original-child"};let release;
    const api={debugger:{sendCommand(_source,method){const promise=method==="Runtime.releaseObject"?new Promise(resolve=>{release=resolve;}):Promise.resolve({result:{objectId:"original-object"}});promises.push(promise);return promise;},onEvent:{addListener:fn=>events.add(fn),removeListener:fn=>events.delete(fn)}}};
    const original=api.debugger.sendCommand;installBoundingGeometryProbe(api,target,{id:"raw",tabId:7,captureRuntime});
    for(const method of ["Runtime.evaluate","Runtime.callFunctionOn"]){const promise=api.debugger.sendCommand(source,method,{});assert.equal(promise,promises.at(-1));await promise;}
    const pending=api.debugger.sendCommand(source,"Runtime.releaseObject",{objectId:"original-object"});assert.equal(pending,promises.at(-1));
    assert.equal(target.__obuBoundingGeometry.snapshot().pending,captureRuntime?1:0);release();await pending;
    const result=target.__obuBoundingGeometry.restore();assert.equal(api.debugger.sendCommand,original);assert.equal(events.size,0);assert.equal(result.pending,0);
    assert.equal(result.records.length,captureRuntime?6:0);if(captureRuntime){assert.deepEqual(result.records.filter(row=>row.kind==="invoke").map(row=>row.method),["Runtime.evaluate","Runtime.callFunctionOn","Runtime.releaseObject"]);assert.equal(result.records.at(-1).ok,true);}
  }
});

test("native ledger rejects missing ACK, wrong capture route, overflow and native Input", () => {
  checkBoundingGeometryTrace(phaseFixture().probe);
  for(const mutate of [v=>{v.records.pop();},v=>{v.records[4].source.sessionId="child";},v=>{v.overflow=true;},v=>{v.records[0].method="Input.dispatchMouseEvent";},v=>{v.pending=1;},v=>{v.records[1].invocation=900;}]) {const probe=phaseFixture().probe;mutate(probe);assert.throws(()=>checkBoundingGeometryTrace(probe));}
});

test("renderer identity joins getTargets other type with exact attachedToTarget iframe ID and session", () => {
  const url = "http://localhost:4321/original-document", native = { targets: [{ id: "native-target", url, type: "other", attached: true }],
    attachments: [{ targetId: "native-target", tabId: 7, source: { tabId: 7 }, type: "iframe", sessionId: "original-session", url: "" }] };
  assert.equal(boundingRendererSession(native, url, 7), "original-session");
  for (const mutate of [v=>{v.targets[0].url+="?replacement";},v=>{v.targets[0].id="replacement";},v=>{v.targets.push(copy(v.targets[0]));},v=>{v.targets[0].attached=false;},
    v=>{v.attachments[0].type="page";},v=>{v.attachments[0].tabId=8;},v=>{v.attachments[0].source={tabId:8};},v=>{v.attachments[0].source.sessionId="wrong-parent";},v=>{v.attachments[0].sessionId="";},v=>{v.attachments.push(copy(v.attachments[0]));}]) {
    const changed=copy(native);mutate(changed);assert.throws(()=>boundingRendererSession(changed,url,7));
  }
});

test("actual PNG dimensions and body, patch, border pixels identify the captured content at reported DPR", () => {
  for(const dpr of [1,1.25,2]) for(const phase of [0,1]) {const document=rootDocument({dpr,phase}),bytes=png(document,{phase}),options={clip:parallelElementClip(document.target.rect),documents:[document],spec:boundsSpec,phase};
    const result=checkBoundingGeometryPixels(bytes,options);assert.equal(result.dpr,dpr);assert.deepEqual(result.samples.map(v=>v.id),["body","patch","border"]);assert.equal(result.sha256,sha(bytes));
    assert.throws(()=>checkBoundingGeometryPixels(png(document,{phase,corrupt:true}),options),/Wrong actual screenshot/);assert.throws(()=>checkBoundingGeometryPixels(png(document,{phase,extraWidth:1}),options));
    assert.throws(()=>checkBoundingGeometryPixels(bytes,{...options,phase:1-phase}),/patch/);
  }
});

test("public results require original native target quad, exact capture clip and actual returned bytes", () => {
  const item=phaseFixture(), proof=checkBoundingGeometryPhase(item,boundsSpec);assert.equal(proof.targetBoxes.length,2);assert.equal(proof.nativeInputs,0);
  for(const mutate of [v=>{v.box.x+=2;},v=>{v.probe.records[0].source.sessionId="wrong-renderer";},v=>{v.probe.records[1].result.model.border[0]+=3;},v=>{v.probe.records[4].params.clip.width++;},v=>{v.screenshot.base64=png(rootDocument(),{corrupt:true}).toString("base64");},v=>{v.hiddenParentAfter.documentToken="replaced";}]) {const changed=phaseFixture();mutate(changed);assert.throws(()=>checkBoundingGeometryPhase(changed,boundsSpec));}
});

test("negative/offscreen boxes retain coordinates, zero extents remain boxes and hidden OOPIF returns null", () => {
  checkBoundingGeometryPhase(phaseFixture(),boundsSpec);
  for(const mutate of [v=>{v.bounds.negative.box.x=0;},v=>{v.bounds.far.box.y=800;},v=>{v.bounds.zero.box=null;},v=>{v.bounds["zero-height"].box=null;},v=>{v.bounds.hidden.box={x:0,y:0,width:0,height:0};},v=>{v.bounds["hidden-parent"].box={x:90,y:85,width:280,height:160};},v=>{v.hiddenParentBefore.nativeProcessId=1;}]) {const changed=phaseFixture();mutate(changed);assert.throws(()=>checkBoundingGeometryPhase(changed,boundsSpec));}
});

test("old-production failures retain all subsequent scene attempts and preserve the first failure", async () => {
  const first=Error("original scene failure"),detail={},fixtures=createBoundingGeometryFixtures();let calls=0;
  await assert.rejects(checkBoundingGeometry({browser:{newTab:async()=>{calls++;throw calls===1?first:Error(`later scene ${calls}`);}},worker:{},fixtureURL:base,until:()=>{},detail,server:fixtures}),error=>error===first);
  assert.equal(calls,7);assert.equal(detail.cases.length,7);assert.ok(detail.cases.every(value=>value.error));assert.equal(detail.passed,false);assert.match(detail.error,/original scene failure/);
});

import assert from 'node:assert/strict';
import test from 'node:test';
import vm from 'node:vm';
import { createRawPointerFeedbackRuntime } from './raw-pointer-feedback.mjs';
import { createFrameGeometryRuntime } from './patch-frame-geometry.mjs';
import { PassivePointerReads } from '../apps/chrome-extension/browser-pointer-feedback.js';

const geometry = createFrameGeometryRuntime();
const deferred = () => { let resolve, reject; const promise = new Promise((a,b) => {resolve=a; reject=b;}); return {promise,resolve,reject}; };
const flat = points => points.flatMap(p => [p.x,p.y]);
const corners = (x,y,w,h) => [{x,y},{x:x+w,y},{x:x+w,y:y+h},{x,y:y+h}];
const near = (a,b) => { for (const k of Object.keys(b)) assert.ok(Math.abs(a[k]-b[k]) < 1e-8, `${k}: ${a[k]} != ${b[k]}`); };

function fixture({ oopif=false, transformed=false, nested=false }={}) {
  const calls=[], releases=[], closed=[], frames=new Map(), objects=new Map(), attachment={};
  const transport={_tabToTarget:new Map([[7,attachment]]),_sessions:new Map()};
  const connection={_transport:transport};
  const rootSession={_client:{_sessionId:'crx-tab-7',_connection:connection}};
  const childSession={_targetId:'child',_client:{_sessionId:'original-child',_connection:connection}};
  transport._sessions.set('original-child',7);
  let next=0;
  function frame(id,parent,session) {
    const f={_id:id,parentFrame:()=>parent,_currentDocument:{},pendingDocument:()=>null,session};
    const context={world:'utility',delegate:{_client:session._client,_contextId:++next},_contextDestroyedScope:{isClosed:()=>false}};
    f._contextData=new Map([['utility',{context}]]); f.context=context; f.backendNodeId=100+next;
    frames.set(id,f);objects.set('node-'+id,f);return f;
  }
  const root=frame('root',null,rootSession);
  const child=frame('child',root,oopif?childSession:rootSession); root.child=child;
  const angle=transformed?Math.PI/6:0, scale=transformed?1.25:1;
  const authored = p => ({x:10+scale*(Math.cos(angle)*p.x-Math.sin(angle)*p.y),y:20+scale*(Math.sin(angle)*p.x+Math.cos(angle)*p.y)});
  root.content=flat(corners(0,0,200,100).map(authored));root.size={width:200,height:100};
  let leaf=child, leafLocal=corners(40,40,40,20), rootPoints=leafLocal.map(authored);
  if(nested){
    leaf=frame('leaf',child,oopif?childSession:rootSession);child.child=leaf;
    const inner=corners(20,10,120,80);
    child.content=flat(oopif?inner:inner.map(authored));child.size={width:120,height:80};
    leafLocal=corners(20,30,40,20);rootPoints=leafLocal.map(p=>authored({x:p.x+20,y:p.y+10}));
    leaf.border=flat(oopif?leafLocal.map(p=>({x:p.x+20,y:p.y+10})):rootPoints);
  }else leaf.border=flat(oopif?leafLocal:rootPoints);
  const point=authored({x:55.375,y:50.625});
  let onSend, onRelease, gone=false;
  transport._send=async(target,method,params,guard)=>{
    guard?.();calls.push({target,method,params});
    const override=await onSend?.({target,method,params});
    if(override!==undefined)return override;
    let f=objects.get(params.objectId);
    if(method==='Runtime.evaluate'){
      f=[...frames.values()].find(f=>f.context.delegate._contextId===params.contextId);
      assert.equal(target.sessionId, f.session===rootSession?undefined:'original-child');
      return {result:{objectId:'node-'+f._id}};
    }
    if(method==='DOM.describeNode')return {node:{backendNodeId:f.backendNodeId,localName:f.child?'iframe':'button',...(f.child?{frameId:f.child._id}:{})}};
    if(method==='DOM.getBoxModel')return {model:f.child?{content:f.content}:{border:f.border}};
    if(method==='DOM.getFrameOwner')return {backendNodeId:frames.get(params.frameId).parentFrame().backendNodeId};
    if(method==='Runtime.callFunctionOn')return {result:{value:f.size}};
    throw Error('Unexpected native read '+method);
  };
  const hooks={prepareMediaCleanup(target,contextId){return {
    release:async objectId=>{releases.push({target,contextId,objectId});if(!gone)await onRelease?.(objectId);},
    close:()=>closed.push(contextId)
  };}};
  const page={mainFrame:()=>root,frameManager:{frame:id=>frames.get(id)},delegate:{_sessionForFrame:f=>f.session}};
  const reads=new PassivePointerReads();let valid=true;
  const start=()=>{const spec=createRawPointerFeedbackRuntime(geometry)(page,point.x,point.y,hooks);return reads.start({...spec,scope:{attachment,tabId:7},check:()=>{if(!valid)throw Error('old scope');spec.check();}});};
  return {calls,releases,closed,frames,root,child,leaf,page,transport,reads,start,point,
    expected:{x:Math.min(...rootPoints.map(p=>p.x)),y:Math.min(...rootPoints.map(p=>p.y)),width:Math.max(...rootPoints.map(p=>p.x))-Math.min(...rootPoints.map(p=>p.x)),height:Math.max(...rootPoints.map(p=>p.y))-Math.min(...rootPoints.map(p=>p.y))},
    onSend:fn=>onSend=fn,onRelease:fn=>onRelease=fn,revoke:()=>valid=false,destroy:()=>gone=true};
}

for(const opts of [{},{oopif:true},{oopif:true,nested:true},{nested:true},{oopif:true,transformed:true},{transformed:true,nested:true}])
test(`raw fractional target projects actual native corners through ${JSON.stringify(opts)}`,async()=>{
 const f=fixture(opts), candidate=f.start();near(await candidate.result,f.expected);
 assert.equal(f.releases.length,f.frames.size);assert.equal(f.closed.length,f.frames.size);assert.equal(f.reads.pending.size,0);
 assert.ok(f.calls.every(c=>!c.method.startsWith('Input.')&&!/focus|scroll|bringToFront|attach/i.test(c.method)));
 const childEval=f.calls.filter(c=>c.method==='Runtime.evaluate')[1];
 assert.match(childEval.params.expression,/55\.37/);assert.match(childEval.params.expression,/50\.62/);
});

test('fixed hit test retains root interaction selector semantics and fractional arguments',async()=>{
 const f=fixture();let expression;
 f.onSend(({method,params})=>{if(method==='Runtime.evaluate'&&!expression)expression=params.expression;});
 await f.start().result;
 let selector,point;
 const target={isConnected:true};const hit={localName:'span',closest:value=>{selector=value;return target;}};
 const document={elementFromPoint:(...p)=>{point=p;return hit;}};target.ownerDocument=document;
 assert.equal(vm.runInNewContext(expression,{document}),target);near({x:point[0],y:point[1]},f.point);
 for(const part of ['a[href]','[role="checkbox"]','[role="radio"]','[role="switch"]','[role="textbox"]','[contenteditable]:not([contenteditable="false"])','[tabindex]:not([tabindex="-1"])'])assert.ok(selector.split(',').includes(part));
 hit.localName='iframe';hit.isConnected=true;hit.ownerDocument=document;hit.closest=()=>{throw Error('must descend the owner itself');};
 assert.equal(vm.runInNewContext(expression,{document}),hit);
});

for(const change of ['owner','missing-child','document','context','route','invalid-quad','child-target','uninitialized-child-target'])test(`ambiguous ${change} evidence returns null and never outlines the ancestor`,async()=>{
 const f=fixture({oopif:true});
 if(change==='child-target')f.child.session._targetId='other-frame';
 if(change==='uninitialized-child-target')delete f.child.session._targetId;
 f.onSend(({method,params})=>{
   if(change==='owner'&&method==='DOM.getFrameOwner')return {backendNodeId:999};
   if(change==='missing-child'&&method==='DOM.describeNode')return {node:{backendNodeId:101,localName:'iframe',frameId:'unrelated'}};
   if(change==='document'&&method==='Runtime.evaluate')f.root._currentDocument={};
   if(change==='context'&&method==='Runtime.evaluate')f.root._contextData.set('utility',{context:{}});
   if(change==='route'&&method==='Runtime.evaluate')f.transport._tabToTarget.set(7,{});
   if(change==='invalid-quad'&&method==='DOM.getBoxModel')return {model:{content:[0,0,1,0,1,0,0,0]}};
 });
 assert.equal(await f.start().result,null);assert.equal(f.reads.pending.size,0);assert.ok(f.releases.length>=1);
});

test('actual late allocation and release remain in cleanup after authority loss',async()=>{
 const f=fixture(),allocation=deferred(),release=deferred();let entered;
 const entering=new Promise(r=>entered=r);
 f.onSend(({method})=>{if(method==='Runtime.evaluate'){entered();return allocation.promise;}});
 f.onRelease(()=>release.promise);
 const candidate=f.start();await entering;f.revoke();
 let drained=false;const drain=f.reads.drain().then(()=>drained=true);
 allocation.resolve({result:{objectId:'late-original'},exceptionDetails:{exception:{objectId:'late-exception'}}});
 await new Promise(setImmediate);assert.equal(drained,false);assert.equal(f.reads.pending.size,1);
 release.resolve();await drain;assert.equal(await candidate.result,null);
 assert.deepEqual(f.releases.map(x=>x.objectId),['late-original','late-exception']);assert.equal(f.closed.length,1);
});

test('failed actual object release remains owned and explicitly retries only original cleanup',async()=>{
 const f=fixture(),error=Error('release unconfirmed');let fail=true;
 f.onRelease(()=>{if(fail)throw error;});
 const candidate=f.start();assert.equal(await candidate.result,null);const count=f.calls.length;
 assert.equal(f.reads.pending.size,1);await assert.rejects(f.reads.drain(),e=>e===error);
 assert.equal(f.closed.length,0);fail=false;
 await f.reads.drain(()=>true,{resourcesOnly:true,retryFailed:true});
 assert.equal(f.reads.pending.size,0);assert.equal(f.calls.length,count);assert.equal(f.closed.length,2);
 assert.equal(f.releases[0].objectId,f.releases[1].objectId);
});

test('native context destruction permits original lease cleanup after failed release',async()=>{
 const f=fixture();f.onRelease(()=>{throw Error('native failure');});
 assert.equal(await f.start().result,null);f.destroy();
 await f.reads.drain(()=>true,{retryFailed:true});assert.equal(f.reads.pending.size,0);
});

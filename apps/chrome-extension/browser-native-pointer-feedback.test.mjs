import assert from 'node:assert/strict';
import test from 'node:test';
import vm from 'node:vm';
import { createNativePointerFeedback, NATIVE_POINTER_KERNEL_ABI } from './browser-native-pointer-feedback.js';
import { createFrameGeometryRuntime } from '../../scripts/patch-frame-geometry.mjs';
import { PassivePointerReads } from './browser-pointer-feedback.js';

const geometry = createFrameGeometryRuntime();
const realmIdentity = Object.freeze({ kernelABI: '1',
  worldName: 'Open Browser Use passive pointer 00000000-0000-4000-8000-000000000001 1',
  kernelKey: '__obuNativePointer_00000000-0000-4000-8000-000000000002_1',
  kernelToken: '00000000-0000-4000-8000-000000000003:1' });
const flat = points => points.flatMap(p => [p.x, p.y]);
const corners = (x, y, w, h) => [{x,y},{x:x+w,y},{x:x+w,y:y+h},{x,y:y+h}];
const deferred = () => { let resolve, reject; const promise = new Promise((a,b) => { resolve=a; reject=b; }); return {promise,resolve,reject}; };
const tick = () => new Promise(setImmediate);
const near = (value, expected) => {
  for (const key of Object.keys(expected)) assert.ok(Math.abs(value[key]-expected[key]) < 1e-8, `${key}: ${value[key]} != ${expected[key]}`);
};
const key = target => JSON.stringify(target);

// This is a deterministic native-response seam, not proof that a particular
// browser permits acquiring an OOPIF target. Remote projection cases explicitly
// inject an owned route; unavailable routes must return null in production.
function fixture({rootOnly=false, remote=false, nested=false, angle=0, scale=1, realm=realmIdentity}={}) {
  const rootTarget={tabId:7}, childTarget={targetId:'exact-child-target'};
  const calls=[], cleanupCalls=[], routeCalls=[], frames=[], objects=new Map(), groups=new Map();
  const projected = p => ({x:10+scale*(Math.cos(angle)*p.x-Math.sin(angle)*p.y),y:20+scale*(Math.sin(angle)*p.x+Math.cos(angle)*p.y)});
  let serial=0, current=true, routeCurrent=true, onSend, onCleanup, onAcquire, onRouteRelease;
  const node=(frame,localName,id) => Object.assign(new frame.realm.Element(), {
    _localName:localName,_connected:true,_document:frame.document,backendNodeId:id,frame
  });
  const makeFrame=(id,parent,target) => {
    const f={id,parent,target,contextId:frames.length+1,loaderId:'loader-'+id};
    // Persistent per-frame isolated realm with native-like prototype accessors.
    // Own-property/prototype poisoning must not mutate the backing DOM state.
    class NativeNode {
      get isConnected(){return this._connected;} set isConnected(value){this._connected=value;}
      get ownerDocument(){return this._document;}
      contains(node){return this._children?.includes(node)??false;}
    }
    class NativeElement extends NativeNode {
      get localName(){return this._localName;}
      get shadowRoot(){return this._shadow??null;}
      closest(selector){return this._closest?this._closest(selector):this;}
    }
    class NativeDocument extends NativeNode {
      get documentElement(){return this._root;} set documentElement(value){this._root=value;}
      get body(){return this._body;} set body(value){this._body=value;}
      get defaultView(){return f.realmGlobal;}
      elementFromPoint(x,y){f.lastPoint={x,y};return f.hit;}
    }
    class NativeShadowRoot extends NativeNode {
      elementFromPoint(){return this._hit;}
    }
    class NativeStyle {
      constructor(style){this._style=style;}
      getPropertyValue(property){
        const camel=property.replace(/-([a-z])/g,(_,c)=>c.toUpperCase());
        return this._style[camel]??'';
      }
    }
    f.realm=vm.createContext({Document:NativeDocument,Node:NativeNode,Element:NativeElement,
      ShadowRoot:NativeShadowRoot,CSSStyleDeclaration:NativeStyle,getComputedStyle:node=>new NativeStyle(node.style)});
    Object.defineProperty(f.realm,'document',{configurable:false,get(){return f.windowDocument;},set(value){f.windowDocument=value;}});
    f.realmGlobal=vm.runInContext('this',f.realm);
    f.document=new NativeDocument();f.windowDocument=f.document;
    f.document.documentElement=node(f,'html',100+frames.length);
    f.document.body=node(f,'body',200+frames.length);
    frames.push(f);return f;
  };
  const root=makeFrame('root',null,rootTarget);let child,leaf=root,rootPoints;
  if(rootOnly){
    root.hit=node(root,'button',300);root.hit.model={border:flat(corners(40,40,40,20))};rootPoints=corners(40,40,40,20);
  }else{
    child=makeFrame('child',root,remote?childTarget:rootTarget);leaf=child;
    root.hit=node(root,'iframe',301);root.hit.child=child;root.hit.model={content:flat(corners(0,0,200.5,100.25).map(projected))};
    root.hit.style={width:'200.5px',height:'100.25px',boxSizing:'content-box',borderLeftWidth:'1px',borderRightWidth:'1px',borderTopWidth:'1px',borderBottomWidth:'1px',paddingLeft:'0px',paddingRight:'0px',paddingTop:'0px',paddingBottom:'0px'};
    if(nested){
      leaf=makeFrame('leaf',child,child.target);child.hit=node(child,'iframe',302);child.hit.child=leaf;
      const inner=corners(20,10,120.25,80.5);child.hit.model={content:flat(remote?inner:inner.map(projected))};
      child.hit.style={...root.hit.style,width:'120.25px',height:'80.5px'};
    }
    leaf.hit=node(leaf,'button',303);
    rootPoints=corners(40,40,40,20).map(projected);
    leaf.hit.model={border:flat(remote?corners(40,40,40,20):rootPoints)};
  }
  const point=rootOnly?{x:55.375,y:50.625}:projected({x:55.375,y:50.625});
  const getTree=target=>{
    const local=frames.filter(f=>key(f.target)===key(target));
    const top=local.find(f=>!f.parent||key(f.parent.target)!==key(target));
    const pack=f=>({frame:{id:f.id,loaderId:f.loaderId,...(f.parent?{parentId:f.parent.id}:{})},
      childFrames:local.filter(c=>c.parent===f).map(pack)});
    return {frameTree:pack(top)};
  };
  const allocate=(value,group)=>{
    if(value===null||typeof value!=='object')return {result:{value}};
    const objectId='object-'+(++serial);objects.set(objectId,{value,group});
    return {result:{type:'object',objectId}};
  };
  const native=async(target,method,params)=>{
    const entry={target:{...target},method,params,settled:false};calls.push(entry);
    try {
      const override=await onSend?.(entry);
      let result=override;
      if(result===undefined){
        if(method==='Page.getFrameTree')result=getTree(target);
        else if(method==='Page.createIsolatedWorld'){
          const f=frames.find(f=>f.id===params.frameId&&key(f.target)===key(target));
          assert.ok(f);assert.equal(params.worldName,realmIdentity.worldName);assert.equal(params.grantUniveralAccess,false);
          result={executionContextId:f.contextId};
        }else if(method==='Runtime.evaluate'){
          const f=frames.find(f=>f.contextId===params.contextId&&key(f.target)===key(target));assert.ok(f);
          result=allocate(vm.runInContext(params.expression,f.realm),params.objectGroup);
        }else if(method==='Runtime.callFunctionOn'){
          const fn=vm.runInNewContext('('+params.functionDeclaration+')');
          const args=params.arguments.map(a=>a.objectId?objects.get(a.objectId)?.value:a.value);
          const value=fn.apply(objects.get(params.objectId)?.value,args);
          result=params.returnByValue?{result:{value}}:allocate(value,params.objectGroup);
        }else if(method==='DOM.describeNode'){
          const n=objects.get(params.objectId)?.value;assert.ok(n);
          result={node:{backendNodeId:n.backendNodeId,localName:n._localName,...(n._localName==='html'?{frameId:n.frame.id}:n.child?{frameId:n.child.id}:{})}};
        }else if(method==='DOM.getBoxModel')result={model:objects.get(params.objectId)?.value.model};
        else if(method==='DOM.getFrameOwner'){
          const f=frames.find(f=>f.id===params.frameId);assert.equal(key(f.parent.target),key(target));
          result={backendNodeId:f.parent.hit.backendNodeId};
        }else throw Error('Unexpected native command '+method);
      }
      entry.settled=true;return result;
    }catch(error){entry.settled=true;entry.error=error;throw error;}
  };
  const adapter={
    check(){if(!current)throw Error('original attachment expired');},
    send:native,
    prepareGroup(target,name){
      const g={target:{...target},name,closed:false};groups.set(name,g);
      return {
        async releaseObject(objectId){const e={kind:'object',target:{...target},name,objectId,settled:false};cleanupCalls.push(e);await onCleanup?.(e);objects.delete(objectId);e.settled=true;},
        async releaseGroup(){const e={kind:'group',target:{...target},name,settled:false};cleanupCalls.push(e);await onCleanup?.(e);for(const [id,o] of objects)if(o.group===name)objects.delete(id);e.settled=true;},
        close(){g.closed=true;}
      };
    },
    acquireChild({parentTarget,parentFrameId,frameId}){
      const e={parentTarget:{...parentTarget},parentFrameId,frameId};routeCalls.push(e);
      const custom=onAcquire?.(e);if(custom!==undefined)return custom;
      return {ready:Promise.resolve(childTarget),check(){if(!routeCurrent)throw Error('original child route expired');},
        async release(){const e={release:true,settled:false};routeCalls.push(e);await onRouteRelease?.(e);e.settled=true;}};
    }
  };
  const spec=()=>createNativePointerFeedback({target:rootTarget,...point,geometry,adapter,realm});
  const reads=new PassivePointerReads();
  const start=()=>reads.start({...spec(),scope:{attachment:adapter,tabId:7}});
  const expected={x:Math.min(...rootPoints.map(p=>p.x)),y:Math.min(...rootPoints.map(p=>p.y)),
    width:Math.max(...rootPoints.map(p=>p.x))-Math.min(...rootPoints.map(p=>p.x)),height:Math.max(...rootPoints.map(p=>p.y))-Math.min(...rootPoints.map(p=>p.y))};
  return {rootTarget,childTarget,calls,cleanupCalls,routeCalls,groups,objects,frames,root,child,leaf,point,expected,adapter,reads,spec,start,allocate,node,
    onSend:fn=>onSend=fn,onCleanup:fn=>onCleanup=fn,onAcquire:fn=>onAcquire=fn,onRouteRelease:fn=>onRouteRelease=fn,
    revoke:()=>current=false,revokeRoute:()=>routeCurrent=false};
}

for(const options of [{rootOnly:true},{},{nested:true},{angle:Math.PI/6},{scale:1.375,nested:true},
  {remote:true},{remote:true,nested:true,angle:Math.PI/6,scale:1.375}])
test(`fractional native-reader geometry contract ${JSON.stringify(options)}`,async()=>{
  const f=fixture(options);near(await f.start().result,f.expected);
  assert.equal(f.reads.pending.size,0);assert.equal(f.objects.size,0);
  assert.ok([...f.groups.values()].every(g=>g.closed));
  assert.equal(f.cleanupCalls.filter(c=>c.kind==='group').length,options.remote?2:1);
  assert.ok(f.calls.every(c=>c.settled&&!/^(Input\.|Target\.)|enable$|disable$|getDocument|focus|scroll|bringToFront/.test(c.method)));
  assert.ok(f.calls.filter(c=>c.method.startsWith('Runtime.')).every(c=>c.params.awaitPromise===false&&c.params.userGesture===false&&c.params.objectGroup));
  assert.equal(f.calls.filter(c=>c.method==='Runtime.evaluate').length,f.frames.length);
  const p=f.leaf.lastPoint;near(p,options.rootOnly?f.point:options.nested?{x:35.375,y:40.625}:{x:55.375,y:50.625});
});

test('missing remote acquisition returns null without outlining the owner or attaching anything',async()=>{
  const f=fixture({remote:true});delete f.adapter.acquireChild;
  assert.equal(await f.start().result,null);assert.equal(f.routeCalls.length,0);
  assert.equal(f.calls.filter(c=>c.method==='Page.createIsolatedWorld').length,1);
  assert.equal(f.objects.size,0);
});

for(const change of ['wrong-root-frame','changed-root-backend','wrong-owner','loader','parent','document-open','navigation-document','node-detached','child-route'])
test(`stale ${change} never publishes a parent/leaf rectangle`,async()=>{
  const f=fixture({remote:change==='child-route'});let rootDescriptions=0,treeReads=0;
  f.onSend(({target,method,params})=>{
    if(method==='DOM.describeNode'&&f.objects.get(params.objectId)?.value===f.root.document.documentElement){
      rootDescriptions++;
      if(change==='wrong-root-frame')return {node:{backendNodeId:100,localName:'html',frameId:'wrong-frame'}};
      if(change==='changed-root-backend'&&rootDescriptions>1)return {node:{backendNodeId:999,localName:'html',frameId:'root'}};
    }
    if(change==='wrong-owner'&&method==='DOM.getFrameOwner')return {backendNodeId:999};
    if(method==='Page.getFrameTree'&&key(target)===key(f.rootTarget)){
      treeReads++;if(treeReads>1){if(change==='loader')f.root.loaderId='replacement-loader';if(change==='parent')f.child.parent=f.leaf;}
    }
    if(method==='DOM.getBoxModel'&&f.objects.get(params.objectId)?.value===f.leaf.hit){
      if(change==='document-open')f.root.document.documentElement={...f.root.document.documentElement};
      if(change==='navigation-document')f.root.document.defaultView.document={};
      if(change==='node-detached')f.leaf.hit.isConnected=false;
      if(change==='child-route')f.revokeRoute();
    }
  });
  assert.equal(await f.start().result,null);assert.equal(f.reads.pending.size,0);assert.equal(f.objects.size,0);
});

test('initial numeric-context reuse is rejected by original root native frame ID',async()=>{
  const f=fixture();
  f.onSend(({method,params})=>{
    if(method==='Runtime.evaluate')return f.allocate(vm.runInContext(params.expression,f.child.realm),params.objectGroup);
  });
  assert.equal(await f.start().result,null);
  assert.equal(f.calls.filter(c=>c.method==='DOM.getBoxModel').length,0);
  assert.equal(f.objects.size,0);
});

test('fixed receiver functions never read a later global document or lose semantic hit selectors',async()=>{
  const f=fixture({rootOnly:true});let selector;
  const button=f.root.hit;
  f.root.hit=f.node(f.root,'span',304);f.root.hit._closest=value=>{selector=value;return button;};
  near(await f.start().result,f.expected);
  for(const part of ['a[href]','[role="checkbox"]','[role="radio"]','[role="switch"]','[role="textbox"]','[contenteditable]:not([contenteditable="false"])','[tabindex]:not([tabindex="-1"])'])assert.ok(selector.split(',').includes(part));
  // The seam executes callFunctionOn with no global document at all. Passing
  // proves the fixed receiver path rather than a numeric-context/global retry.
  assert.equal(f.calls.filter(c=>c.method==='Runtime.evaluate').length,1);
});

test('actual late allocation and exceptional handles remain owned through revoked cleanup',async()=>{
  const f=fixture({rootOnly:true}),allocation=deferred(),release=deferred(),entered=deferred();
  f.onSend(({method})=>{if(method==='Runtime.evaluate'){entered.resolve();return allocation.promise;}});
  f.onCleanup(()=>release.promise);
  const candidate=f.start();await entered.promise;f.revoke();
  let drained=false;const drain=f.reads.drain().then(()=>drained=true);
  const group=f.calls.find(c=>c.method==='Runtime.evaluate').params.objectGroup;
  f.objects.set('late-result',{group});f.objects.set('late-exception',{group});
  allocation.resolve({result:{objectId:'late-result'},exceptionDetails:{exception:{objectId:'late-exception'}}});
  await tick();assert.equal(drained,false);assert.equal(f.reads.pending.size,1);
  release.resolve();await drain;assert.equal(await candidate.result,null);
  assert.equal(f.cleanupCalls.length,1);assert.equal(f.cleanupCalls[0].name,group);
  assert.equal(f.cleanupCalls[0].kind,'group');assert.ok(f.cleanupCalls.every(c=>c.settled));assert.equal(f.objects.size,0);
});

test('failed group ACK keeps exact resources and retries no native read',async()=>{
  const f=fixture({rootOnly:true}),failure=Error('actual cleanup failed');let fail=true;
  f.onCleanup(()=>{if(fail)throw failure;});
  const candidate=f.start();assert.equal(await candidate.result,null);const count=f.calls.length;
  assert.equal(f.reads.pending.size,1);await assert.rejects(f.reads.drain(),e=>e===failure);
  assert.ok([...f.groups.values()].every(g=>!g.closed));fail=false;
  await f.reads.drain(()=>true,{resourcesOnly:true,retryFailed:true});
  assert.equal(f.calls.length,count);assert.equal(f.reads.pending.size,0);assert.equal(f.objects.size,0);
  const attempts=f.cleanupCalls;assert.equal(attempts[0].name,attempts[1].name);
});

test('explicit early cleanup waits original allocation, shares its promise and prevents subsequent reads',async()=>{
  const f=fixture({rootOnly:true}),allocation=deferred(),entered=deferred(),spec=f.spec();
  f.onSend(({method})=>{if(method==='Runtime.evaluate'){entered.resolve();return allocation.promise;}});
  const read=spec.read(()=>{});read.catch(()=>{});await entered.promise;
  const cleanup=spec.cleanup();assert.equal(spec.cleanup(),cleanup);
  let settled=false;cleanup.then(()=>settled=true);await tick();assert.equal(settled,false);
  allocation.resolve({result:{objectId:'late-after-cleanup'}});
  await cleanup;assert.equal(settled,true);await assert.rejects(read);
  assert.equal(f.cleanupCalls.length,1);assert.equal(f.cleanupCalls[0].kind,'group');
  assert.throws(()=>spec.read(()=>{}),/cannot be replayed/);
  const untouched=f.spec();await untouched.cleanup();assert.throws(()=>untouched.read(()=>{}),/cannot be replayed/);
});

test('navigation can destroy individual handles while the original group ACK still completes cleanup',async()=>{
  const f=fixture({rootOnly:true});
  f.onSend(({method,params})=>{
    if(method==='DOM.getBoxModel'){
      f.root.document.defaultView.document={};
      // Object IDs are no longer usable after this reply. The group is still
      // releasable by its original native session without a context-ID waiver.
      for(const o of f.objects.values())o.individuallyGone=true;
      return {model:{border:flat(corners(40,40,40,20))}};
    }
  });
  f.onCleanup(e=>{if(e.kind==='object')throw Error('Cannot find context with specified id');});
  assert.equal(await f.start().result,null);
  assert.equal(f.cleanupCalls.length,1);assert.equal(f.cleanupCalls[0].kind,'group');
  assert.equal(f.objects.size,0);assert.equal(f.reads.pending.size,0);
});

test('late owned route acquisition is retained and detached only after group cleanup ACKs',async()=>{
  const f=fixture({remote:true}),attach=deferred(),entered=deferred(),detach=deferred();let detached=false;
  f.onAcquire(()=>({ready:(entered.resolve(),attach.promise),check(){},async release(){assert.ok(f.cleanupCalls.every(c=>c.settled));await detach.promise;detached=true;}}));
  const candidate=f.start();await entered.promise;f.revoke();
  let drained=false;const drain=f.reads.drain().then(()=>drained=true);
  attach.resolve(f.childTarget);await tick();assert.equal(drained,false);assert.equal(detached,false);
  detach.resolve();await drain;assert.equal(await candidate.result,null);assert.equal(detached,true);
});

test('failed owned route release retains original attempt and retries only its cleanup',async()=>{
  const f=fixture({remote:true}),failure=Error('original owned detach failed');let fail=true;
  f.onRouteRelease(()=>{if(fail)throw failure;});assert.equal(await f.start().result,null);
  const count=f.calls.length,groups=f.cleanupCalls.length;
  await assert.rejects(f.reads.drain(),e=>e===failure);fail=false;
  await f.reads.drain(()=>true,{retryFailed:true});
  assert.equal(f.calls.length,count);assert.equal(f.cleanupCalls.length,groups);
  assert.equal(f.routeCalls.filter(c=>c.release).length,2);assert.equal(f.reads.pending.size,0);
});

test('group names are unique per candidate and stable across local frame worlds',async()=>{
  const f=fixture({nested:true});await f.start().result;await f.start().result;
  assert.equal(f.groups.size,2);assert.equal(new Set(f.calls.filter(c=>c.method==='Page.createIsolatedWorld').map(c=>c.params.worldName)).size,1);
  assert.equal(new Set(f.calls.filter(c=>c.method==='Runtime.evaluate').map(c=>c.params.objectGroup)).size,2);
});

test('one supplied identity reuses its world and immutable kernel across compatible modules',async()=>{
  const first=fixture({rootOnly:true}),second=fixture();
  near(await first.start().result,first.expected);near(await first.start().result,first.expected);
  near(await second.start().result,second.expected);
  const kernel=Object.getOwnPropertyDescriptor(first.root.realm,realmIdentity.kernelKey).value;
  const nextModule=await import('./browser-native-pointer-feedback.js?identity-test');
  assert.equal(nextModule.NATIVE_POINTER_KERNEL_ABI,NATIVE_POINTER_KERNEL_ABI);
  const next=nextModule.createNativePointerFeedback({target:first.rootTarget,...first.point,geometry,adapter:first.adapter,realm:realmIdentity});
  near(await first.reads.start({...next,scope:{attachment:first.adapter,tabId:7}}).result,first.expected);
  assert.equal(Object.getOwnPropertyDescriptor(first.root.realm,realmIdentity.kernelKey).value,kernel);
  const worlds=[...first.calls,...second.calls].filter(c=>c.method==='Page.createIsolatedWorld').map(c=>c.params.worldName);
  assert.deepEqual([...new Set(worlds)],[realmIdentity.worldName]);
});

test('missing, incompatible or malformed realm identity starts no native work and has no fallback',()=>{
  const f=fixture({rootOnly:true});let accessorCalls=0;
  const accessor={...realmIdentity};Object.defineProperty(accessor,'worldName',{get(){accessorCalls++;throw Error('must not invoke unknown identity getter');}});
  const invalid=[undefined,null,{},[],{...realmIdentity,kernelABI:'2'},{...realmIdentity,kernelABI:1},
    {...realmIdentity,extra:'unrecognized'},accessor];
  for(const key of ['worldName','kernelKey','kernelToken'])
    for(const value of ['',null,42,' leading','trailing ','line\nbreak','x'.repeat(257)])invalid.push({...realmIdentity,[key]:value});
  for(const realm of invalid)assert.equal(createNativePointerFeedback({target:f.rootTarget,...f.point,geometry,adapter:f.adapter,realm}),undefined);
  assert.equal(accessorCalls,0);assert.equal(f.calls.length,0);assert.equal(f.groups.size,0);assert.equal(f.routeCalls.length,0);
});

test('a candidate pins supplied identity values before asynchronous reads',async()=>{
  const realm={...realmIdentity},f=fixture({rootOnly:true,realm}),spec=f.spec();
  realm.worldName='later world';realm.kernelKey='later key';realm.kernelToken='later token';realm.kernelABI='2';
  near(await f.reads.start({...spec,scope:{attachment:f.adapter,tabId:7}}).result,f.expected);
  assert.ok(Object.getOwnPropertyDescriptor(f.root.realm,realmIdentity.kernelKey));
  assert.equal(Object.getOwnPropertyDescriptor(f.root.realm,'later key'),undefined);
});

test('a valid realm identity grants no original route authority',()=>{
  const f=fixture({rootOnly:true});f.revoke();assert.equal(f.spec(),undefined);assert.equal(f.calls.length,0);
});

test('main and formerly shared named worlds do not select the private isolated realm',async()=>{
  const f=fixture({rootOnly:true});let poisonCalls=0;
  const poisoned=()=>{poisonCalls++;return f.node(f.root,'button',999);};
  // A caller can pre-create the old published name, or poison its main world.
  // Neither supplies the independently named realm selected by native routing.
  const main=vm.createContext({document:{elementFromPoint:poisoned}});
  const namedWorlds=new Map([['Open Browser Use passive pointer v1',main]]);
  f.onSend(({method,params})=>{
    if(method==='Page.createIsolatedWorld')assert.equal(namedWorlds.has(params.worldName),false);
    if(method==='Runtime.evaluate')assert.notEqual(f.root.realm,main);
  });
  near(await f.start().result,f.expected);assert.equal(poisonCalls,0);
});

for(const collision of ['global-accessor','mutable-value','foreign-immutable','kernel-accessor'])
test(`unknown bootstrap ${collision} is rejected without executing an accessor`,async()=>{
  const f=fixture({rootOnly:true});let getterCalls=0;
  f.onSend(({method,params})=>{
    if(method!=='Runtime.evaluate')return;
    const args=params.expression.match(/\)\(this,("[^"]+"),("[^"]+"),\(/);assert.ok(args);
    const key=JSON.parse(args[1]);let descriptor;
    if(collision==='global-accessor')descriptor={get(){getterCalls++;throw Error('unknown bootstrap getter invoked');}};
    else if(collision==='mutable-value')descriptor={value:{},writable:true};
    else if(collision==='foreign-immutable')descriptor={value:Object.freeze({token:'other',capture(){throw Error('unknown capture invoked');}})};
    else descriptor={value:Object.freeze(Object.defineProperty({},'token',{get(){getterCalls++;throw Error('unknown token getter invoked');}}))};
    Object.defineProperty(f.root.realm,key,{...descriptor,configurable:false});
  });
  assert.equal(await f.start().result,null);assert.equal(getterCalls,0);
  assert.equal(f.calls.filter(c=>c.method==='DOM.getBoxModel').length,0);assert.equal(f.objects.size,0);
});

test('captured hit survives document own-method and prototype poisoning after bootstrap',async()=>{
  const f=fixture({rootOnly:true});const intended=f.root.hit,wrong=f.node(f.root,'button',9876);
  wrong.model={border:flat(corners(700,400,80,40))};let poisoned=false,poisonCalls=0;
  f.onSend(({method})=>{
    if(method==='Runtime.callFunctionOn'&&!poisoned){
      poisoned=true;
      const poison=()=>{poisonCalls++;return wrong;};
      f.root.document.elementFromPoint=poison;
      f.root.realm.Document.prototype.elementFromPoint=poison;
      intended.closest=poison;f.root.realm.Element.prototype.closest=poison;
    }
  });
  near(await f.start().result,f.expected);near(await f.start().result,f.expected);
  const boxes=f.calls.filter(c=>c.method==='DOM.getBoxModel');assert.equal(boxes.length,2);
  assert.equal(poisonCalls,0);assert.equal(f.objects.size,0);
});

test('captured document and node getters preserve identity checks after bootstrap',async()=>{
  const f=fixture({rootOnly:true});near(await f.start().result,f.expected);
  let poisonCalls=0;const poison=()=>{poisonCalls++;return null;};
  for(const [proto,names] of [[f.root.realm.Document.prototype,['documentElement','body','defaultView']],
    [f.root.realm.Node.prototype,['isConnected','ownerDocument']],[f.root.realm.Element.prototype,['localName','shadowRoot']]])
    for(const name of names)Object.defineProperty(proto,name,{get:poison,configurable:true});
  for(const name of ['documentElement','body','defaultView'])Object.defineProperty(f.root.document,name,{get:poison});
  for(const name of ['isConnected','ownerDocument','localName','shadowRoot'])Object.defineProperty(f.root.hit,name,{get:poison});
  near(await f.start().result,f.expected);assert.equal(poisonCalls,0);
  f.onSend(({method})=>{if(method==='DOM.getBoxModel')f.root.document._root=f.node(f.root,'html',1000);});
  assert.equal(await f.start().result,null);assert.equal(poisonCalls,0);
});

test('kernel and per-read wrapper expose only immutable own entries',async()=>{
  const f=fixture({rootOnly:true});let checked=false;
  f.onSend(({method,params})=>{
    if(method!=='Runtime.callFunctionOn'||checked)return;
    checked=true;
    const wrapper=f.objects.get(params.objectId).value;assert.equal(Object.isFrozen(wrapper),true);
    assert.equal(Reflect.set(wrapper,'hit',()=>null),false);
    const kernelKey=Object.getOwnPropertyNames(f.root.realm).find(name=>name.startsWith('__obuNativePointer_'));
    assert.ok(kernelKey);const descriptor=Object.getOwnPropertyDescriptor(f.root.realm,kernelKey);
    assert.equal(descriptor.configurable,false);assert.equal(descriptor.writable,false);assert.equal(descriptor.get,undefined);
    assert.equal(Object.isFrozen(descriptor.value),true);assert.equal(Reflect.set(descriptor.value,'capture',()=>null),false);
  });
  near(await f.start().result,f.expected);assert.equal(checked,true);
});

test('captured shadow hit and contains cannot be redirected after bootstrap',async()=>{
  const f=fixture({rootOnly:true}),button=f.root.hit,host=f.node(f.root,'div',400);
  const shadow=new f.root.realm.ShadowRoot();shadow._hit=button;shadow._children=[button];host._shadow=shadow;f.root.hit=host;
  near(await f.start().result,f.expected);let poisonCalls=0;
  const poison=()=>{poisonCalls++;return null;};
  f.root.realm.ShadowRoot.prototype.elementFromPoint=poison;shadow.elementFromPoint=poison;
  f.root.realm.Node.prototype.contains=poison;shadow.contains=poison;
  near(await f.start().result,f.expected);assert.equal(poisonCalls,0);
});

test('captured owner styles preserve shared fractional border-box sizing after bootstrap',async()=>{
  const f=fixture({angle:Math.PI/6,scale:1.375,nested:true});
  // Content width stays 200.5 / 100.25 after subtracting fractional borders and
  // padding using the unchanged shared readOwnerPlane formula.
  f.root.hit.style={...f.root.hit.style,width:'204px',height:'104.5px',boxSizing:'border-box',
    borderLeftWidth:'0.625px',borderRightWidth:'0.875px',paddingLeft:'0.75px',paddingRight:'1.25px',
    borderTopWidth:'0.5px',borderBottomWidth:'0.75px',paddingTop:'1.125px',paddingBottom:'1.875px'};
  near(await f.start().result,f.expected);let poisonCalls=0;
  const poison=()=>{poisonCalls++;return '10000px';};
  for(const frame of f.frames){
    frame.realm.getComputedStyle=poison;
    frame.realm.CSSStyleDeclaration.prototype.getPropertyValue=poison;
    Object.defineProperty(frame.realm.CSSStyleDeclaration.prototype,'width',{get:poison});
  }
  near(await f.start().result,f.expected);assert.equal(poisonCalls,0);
});

test('owned route acquisition records the exact original parent frame',async()=>{
  const f=fixture({remote:true});near(await f.start().result,f.expected);
  assert.deepEqual(f.routeCalls.filter(c=>!c.release),[{parentTarget:f.rootTarget,parentFrameId:'root',frameId:'child'}]);
});

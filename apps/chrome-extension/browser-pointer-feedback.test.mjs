import assert from 'node:assert/strict';
import test from 'node:test';
import { PassivePointerReads, tagPointerFeedback, pointerCommandTarget } from './browser-pointer-feedback.js';
const deferred = () => { let resolve, reject; const promise = new Promise((a,b)=>{resolve=a;reject=b;}); return {promise,resolve,reject}; };
const rect={x:12,y:24,width:60,height:30};

test('private feedback tag never serializes into native CDP fields',()=>{
 const target={identity:{}}; const params=tagPointerFeedback({type:'mouseMoved',x:4,y:8},target);
 assert.equal(pointerCommandTarget(params),target);
 assert.equal(JSON.stringify(params),'{"type":"mouseMoved","x":4,"y":8}');
 assert.equal(pointerCommandTarget({...params}),undefined);
});
test('actual optional native read remains pending through abandoned publication and cleanup joins it',async()=>{
 const reads=new PassivePointerReads(), native=deferred(), attachment={}, scope={attachment}; let valid=true, count=0;
 const candidate=reads.start({scope,check(){if(!valid)throw Error('old scope');},read(){count++;return native.promise;},decode:x=>x});
 valid=false; let drained=false; const drain=reads.drain().then(()=>drained=true);
 await new Promise(setImmediate); assert.equal(drained,false); assert.equal(reads.pending.size,1); assert.equal(count,1);
 native.resolve(rect); await drain; assert.equal(await candidate.result,null); assert.equal(reads.pending.size,0);
});
test('capacity drops new visual hints without releasing or duplicating original actual reads',async()=>{
 const reads=new PassivePointerReads(), native=deferred(); let count=0;
 const start=attachment=>reads.start({scope:{attachment},check(){},read(){count++;return native.promise;},decode:x=>x});
 const attachments=Array.from({length:8},()=>({}));
 for(const a of attachments){start(a);start(a);}
 assert.equal(count,16); const overflow=start({}); assert.equal(await overflow.result,null); assert.equal(reads.pending.size,16);
 const same=start(attachments[0]); assert.equal(await same.result,null); assert.equal(count,16);
 native.resolve(rect); await reads.drain(); assert.equal(reads.pending.size,0);
});
test('per original attachment capacity leaves unrelated attachments usable',async()=>{
 const reads=new PassivePointerReads(), held=deferred(), first={}; let count=0;
 const start=attachment=>reads.start({scope:{attachment},check(){},read(){count++;return held.promise;},decode:x=>x});
 start(first);start(first); assert.equal(await start(first).result,null); const other=start({}); assert.equal(count,3);
 held.resolve(rect); assert.deepEqual(await other.result,rect); await reads.drain();
});
test('position reuses original BoxModel and malformed/rejected evidence never retries',async()=>{
 const reads=new PassivePointerReads(); let count=0;
 const candidate=reads.start({scope:{attachment:{}},check(){},cached:rect,read(){count++;},decode:x=>x});
 assert.deepEqual(await candidate.result,rect); assert.equal(count,0);
 for(const value of [{...rect,width:Infinity},{...rect,height:0},null]){
  const c=reads.start({scope:{attachment:{}},check(){},read(){count++;return value;},decode:x=>x}); assert.equal(await c.result,null);
 }
 const c=reads.start({scope:{attachment:{}},check(){},read(){count++;throw Error('actual native failure');},decode:x=>x});
 assert.equal(await c.result,null); assert.equal(count,4);
});

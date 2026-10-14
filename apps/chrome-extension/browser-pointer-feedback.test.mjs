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

test('cold latest scheduling keeps one actual read and starts only the newest candidate after cleanup ACK',async()=>{
 const reads=new PassivePointerReads(),attachment={},native=deferred(),released=deferred();let calls=[],cleanupCalls=[];
 const start=id=>reads.start({scope:{attachment},schedule:'latest',check(){},read(){calls.push(id);return id===1?native.promise:{...rect,x:id};},decode:x=>x,
  cleanup(){cleanupCalls.push(id);return id===1?released.promise:Promise.resolve();}});
 const first=start(1),replaced=start(2),latest=start(3);
 try{
  assert.deepEqual(calls,[1]);assert.equal(reads.pending.size,2);assert.equal(await replaced.result,null);assert.equal(replaced.settled,true);
  native.resolve(rect);await new Promise(setImmediate);assert.deepEqual(calls,[1]);assert.deepEqual(cleanupCalls,[1]);
  released.resolve();assert.deepEqual(await first.result,rect);assert.deepEqual(await latest.result,{...rect,x:3});
  assert.deepEqual(calls,[1,3]);assert.deepEqual(cleanupCalls,[1,3]);assert.equal(reads.pending.size,0);
 }finally{native.resolve(rect);released.resolve();await reads.drain();}
});

test('cold queued evidence rechecks original authority and never allocates after turn or attachment revocation',async()=>{
 for(const change of ['turn','attachment']){
  const reads=new PassivePointerReads(),attachment={},held=deferred();let valid=true,started=0,queuedCleanup=0;
  const first=reads.start({scope:{attachment},schedule:'latest',check(){},read:()=>held.promise,decode:x=>x,cleanup:async()=>{}});
  const queued=reads.start({scope:{attachment},schedule:'latest',check(){if(!valid)throw Error(change+' ended');},read(){started++;return rect;},decode:x=>x,cleanup(){queuedCleanup++;}});
  valid=false;held.resolve(rect);await first.result;assert.equal(await queued.result,null);
  assert.equal(started,0);assert.equal(queuedCleanup,0);assert.equal(reads.pending.size,0);
 }
});

test('drain synchronously cancels queued cold evidence and joins only the original actual cleanup',async()=>{
 const reads=new PassivePointerReads(),attachment={},native=deferred(),cleanup=deferred();let started=0,cleaned=0;
 const first=reads.start({scope:{attachment},schedule:'latest',check(){},read(){started++;return native.promise;},decode:x=>x,cleanup:()=>cleanup.promise});
 const queued=reads.start({scope:{attachment},schedule:'latest',check(){},read(){started++;return rect;},decode:x=>x,cleanup(){cleaned++;}});
 let done=false;const drain=reads.drain(()=>true,{resourcesOnly:true}).then(()=>done=true);
 assert.equal(queued.settled,true);assert.equal(await queued.result,null);assert.equal(reads.pending.size,1);
 native.resolve(rect);await new Promise(setImmediate);assert.equal(done,false);assert.equal(started,1);assert.equal(cleaned,0);
 cleanup.resolve();await drain;await first.result;assert.equal(reads.pending.size,0);
});

test('failed cold cleanup drops queued hints, retains the original error, and retries only through explicit drain',async()=>{
 const reads=new PassivePointerReads(),attachment={},native=deferred(),retryACK=deferred(),failure=Error('original cold group release failed');let started=0,attempts=0;
 const start=()=>reads.start({scope:{attachment},schedule:'latest',check(){},read(){started++;return native.promise;},decode:x=>x,
  cleanup(){attempts++;throw failure;},retryCleanup(){attempts++;return retryACK.promise;}});
 const first=start(),queued=start();native.resolve(rect);assert.equal(await first.result,null);assert.equal(await queued.result,null);
 assert.equal(started,1);assert.equal(attempts,1);assert.equal(reads.pending.size,1);assert.equal(await start().result,null);
 await assert.rejects(reads.drain(),error=>error===failure);assert.equal(attempts,1);
 let done=false;const retry=reads.drain(()=>true,{retryFailed:true}).then(()=>done=true);
 const sameRetry=reads.drain(()=>true,{retryFailed:true});await new Promise(setImmediate);
 assert.equal(done,false);assert.equal(attempts,2);assert.equal(await start().result,null);assert.equal(started,1);
 retryACK.resolve();await retry;await sameRetry;assert.equal(reads.pending.size,0);
 const fresh=reads.start({scope:{attachment},schedule:'latest',check(){},read(){started++;return rect;},decode:x=>x,cleanup:async()=>{}});
 assert.deepEqual(await fresh.result,rect);assert.equal(started,2);
});

test('cold native read rejection is not replayed and a successfully cleaned lane can run its latest request',async()=>{
 const reads=new PassivePointerReads(),attachment={},native=deferred();let calls=[];
 const first=reads.start({scope:{attachment},schedule:'latest',check(){},read(){calls.push(1);return native.promise;},decode:x=>x,cleanup:async()=>{}});
 const last=reads.start({scope:{attachment},schedule:'latest',check(){},read(){calls.push(2);return rect;},decode:x=>x,cleanup:async()=>{}});
 native.reject(Error('original optional native read failed'));assert.equal(await first.result,null);assert.deepEqual(await last.result,rect);
 assert.deepEqual(calls,[1,2]);assert.equal(reads.pending.size,0);
});

test('cold latest actual and queued records stay globally bounded while replacing at capacity',async()=>{
 const reads=new PassivePointerReads(),native=deferred(),attachments=Array.from({length:8},()=>({}));let started=0,cleaned=0;
 const start=attachment=>reads.start({scope:{attachment},schedule:'latest',check(){},read(){started++;return native.promise;},decode:x=>x,cleanup(){cleaned++;}});
 const queued=[];for(const attachment of attachments){start(attachment);queued.push(start(attachment));}
 assert.equal(started,8);assert.equal(reads.pending.size,16);assert.equal(await start({}).result,null);assert.equal(reads.pending.size,16);
 const latest=start(attachments[0]);assert.equal(await queued[0].result,null);assert.equal(reads.pending.size,16);assert.equal(started,8);
 const draining=reads.drain();assert.equal(latest.settled,true);assert.equal(reads.pending.size,8);
 native.resolve(rect);await draining;assert.equal(started,8);assert.equal(cleaned,8);assert.equal(reads.pending.size,0);
});

test('cold queues do not change warm native admission or borrow a warm cleanup lane',async()=>{
 const reads=new PassivePointerReads(),attachment={},native=deferred();let warm=0,cold=0;
 const startWarm=()=>reads.start({scope:{attachment},check(){},read(){warm++;return native.promise;},decode:x=>x});
 startWarm();startWarm();assert.equal(warm,2);
 const candidate=reads.start({scope:{attachment},schedule:'latest',check(){},read(){cold++;return rect;},decode:x=>x,cleanup:async()=>{}});
 assert.equal(await candidate.result,null);assert.equal(cold,0);assert.equal(reads.pending.size,2);
 native.resolve(rect);await reads.drain();assert.equal(reads.pending.size,0);
});

test('a scoped drain cancels only matching queued evidence while unrelated latest reads still advance',async()=>{
 const reads=new PassivePointerReads(),native=deferred(),a={},b={};let calls=[];
 const start=(attachment,id)=>reads.start({scope:{attachment},schedule:'latest',check(){},read(){calls.push(id);return id.endsWith('first')?native.promise:rect;},decode:x=>x,cleanup:async()=>{}});
 start(a,'a-first');const aq=start(a,'a-last');start(b,'b-first');const bq=start(b,'b-last');
 const drain=reads.drain(record=>record.scope.attachment===a);assert.equal(aq.settled,true);assert.equal(bq.settled,false);
 native.resolve(rect);await drain;assert.deepEqual(await bq.result,rect);assert.deepEqual(calls,['a-first','b-first','b-last']);assert.equal(reads.pending.size,0);
});

test('a later warm cleanup ACK advances cold evidence queued before that immediate admission',async()=>{
 const reads=new PassivePointerReads(),attachment={},native=deferred(),warmACK=deferred();const calls=[];
 const first=reads.start({scope:{attachment},schedule:'latest',check(){},read(){calls.push('first');return native.promise;},decode:x=>x,cleanup(){calls.push('first-cleanup');}});
 const queued=reads.start({scope:{attachment},schedule:'latest',check(){},read(){calls.push('queued');return rect;},decode:x=>x,cleanup(){calls.push('queued-cleanup');}});
 const warm=reads.start({scope:{attachment},check(){},read(){calls.push('warm-read');return rect;},decode:x=>x,cleanup(){calls.push('warm-cleanup');return warmACK.promise;}});
 try{
  await new Promise(setImmediate);native.resolve(rect);await first.result;await new Promise(setImmediate);
  assert.equal(queued.settled,false);assert.deepEqual(calls,['first','warm-cleanup','first-cleanup']);
  warmACK.resolve();assert.equal(await warm.result,null);await new Promise(setImmediate);
  assert.equal(queued.settled,true);assert.deepEqual(await queued.result,rect);
  assert.deepEqual(calls,['first','warm-cleanup','first-cleanup','queued','queued-cleanup']);assert.equal(reads.pending.size,0);
 }finally{native.resolve(rect);warmACK.resolve();await reads.drain();}
});

test('a later warm cleanup failure cancels existing cold queued evidence and retains its exact failed fence',async()=>{
 const reads=new PassivePointerReads(),attachment={},native=deferred(),warmACK=deferred(),failure=Error('original warm cleanup failed');let started=0,queuedCleanup=0,attempts=0;
 const first=reads.start({scope:{attachment},schedule:'latest',check(){},read(){started++;return native.promise;},decode:x=>x,cleanup:async()=>{}});
 const queued=reads.start({scope:{attachment},schedule:'latest',check(){},read(){started++;return rect;},decode:x=>x,cleanup(){queuedCleanup++;}});
 const warm=reads.start({scope:{attachment},check(){},read(){started++;return rect;},decode:x=>x,cleanup(){attempts++;return warmACK.promise;},retryCleanup(){attempts++;}});
 try{
  await new Promise(setImmediate);warmACK.reject(failure);assert.equal(await warm.result,null);
  assert.equal(queued.settled,true);assert.equal(await queued.result,null);assert.equal(started,1);assert.equal(queuedCleanup,0);assert.equal(attempts,1);
  native.resolve(rect);await first.result;assert.equal(reads.pending.size,1);
  const fresh=reads.start({scope:{attachment},schedule:'latest',check(){},read(){started++;return rect;},decode:x=>x,cleanup:async()=>{}});
  assert.equal(await fresh.result,null);assert.equal(started,1);await assert.rejects(reads.drain(),error=>error===failure);assert.equal(attempts,1);
  await reads.drain(()=>true,{retryFailed:true});assert.equal(attempts,2);assert.equal(reads.pending.size,0);
 }finally{native.resolve(rect);warmACK.resolve();await reads.drain(()=>true,{retryFailed:true});}
});

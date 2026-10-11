import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";

// Test-only fault injection into the exact selected utility context. Unlike a
// held transport response, the native prepareMediaBytes call remains pending
// in the renderer until the production binding's AbortSignal is aborted.
const injection = "exact utility-world blob fetch replaced by an AbortSignal gate; actual renderer Runtime.callFunctionOn remains pending until production cancellation";
const fixedInstall = `function(mode) {
  if (globalThis.__obuMediaReadGate) throw new Error('Media read gate already installed');
  const originalFetch = globalThis.fetch;
  const state = globalThis.__obuMediaReadGate = { started:0, aborted:0, settled:0, mode, originalFetch };
  globalThis.fetch = function(input, options) {
    const url = typeof input === 'string' ? input : input.url;
    if (!url.startsWith('blob:')) return originalFetch.call(this, input, options);
    state.started++;
    if(mode==='reader') {
      const signal=options?.signal;
      if(!(signal instanceof AbortSignal)) throw new Error('Expected native AbortSignal');
      const complete=()=>{if(!state.settled)state.settled=1;};
      const body=state.body=new ReadableStream({
        start(controller) {
          const abort=()=>{state.aborted++;complete();controller.error(new DOMException('Fixture body aborted','AbortError'));};
          if(signal.aborted)abort();else signal.addEventListener('abort',abort,{once:true});
        },
        cancel(){complete();}
      });
      return Promise.resolve(new Response(body,{headers:{'Content-Type':'image/png'}}));
    }
    return new Promise((resolve,reject) => {
      const signal = options?.signal;
      if (!(signal instanceof AbortSignal)) { state.settled++; reject(new Error('Expected native AbortSignal')); return; }
      const abort = () => { state.aborted++; state.settled++; reject(new DOMException('Fixture source aborted', 'AbortError')); };
      if (signal.aborted) abort(); else signal.addEventListener('abort', abort, {once:true});
    });
  };
  return true;
}`;
const fixedRead = "function() { const s=globalThis.__obuMediaReadGate; return s ? {started:s.started,aborted:s.aborted,settled:s.settled,mode:s.mode,readerLocked:s.body?.locked??false} : null; }";
const fixedRestore = "function() { const s=globalThis.__obuMediaReadGate; if(s) { globalThis.fetch=s.originalFetch; delete globalThis.__obuMediaReadGate; } return true; }";

async function install(worker, tabId, id, mode) {
  await worker.evaluate(`(() => {
    if(globalThis.__mediaContentLifecycle) throw new Error('Media content lifecycle probe already installed');
    const original=chrome.debugger.sendCommand;
    const p=globalThis.__mediaContentLifecycle={id:${JSON.stringify(id)},tabId:${tabId},original,events:[],downloadCalls:[],overflow:false,sequence:0};
    if(globalThis.__integrationNativeRPCObserver) throw new Error('Native RPC observer already in use');
    globalThis.__integrationNativeRPCObserver=(direction,message)=>{
      if(direction==='request' && message.method==='turnEnded' && message.params?.session_id===${JSON.stringify(`media-read-${id}`)})
        p.endRequestId=message.id;
      if(direction==='response' && p.endRequestId!==undefined && message.id===p.endRequestId) {
        push({phase:'turn-end-ack',acknowledged:!message.error,preparePending:p.preparePending,
          renderer:p.rendererFinal,restored:p.restored===true,
          bindingReleased:p.events.some(e=>e.phase==='release-done' && e.objectId===p.binding),downloadCalls:p.downloadCalls.length});
      }
    };
    p.originalDownload=chrome.downloads.download;
    p.downloadWrapper=async function(options) {
      const entry={scheme:String(options?.url??'').split(':',1)[0]};
      if(p.downloadCalls.length>=16)p.overflow=true;else p.downloadCalls.push(entry);
      entry.nativeId=await p.originalDownload.call(chrome.downloads,options);return entry.nativeId;
    };
    chrome.downloads.download=p.downloadWrapper;
    const push=event=>{ if(p.events.length>=128) p.overflow=true; else p.events.push({sequence:++p.sequence,...event}); };
    const saveRenderer=async()=>{
      const r=await original.call(chrome.debugger,p.target,'Runtime.callFunctionOn',{
        objectId:p.receiver,functionDeclaration:${JSON.stringify(fixedRead)},returnByValue:true,awaitPromise:true,userGesture:false});
      if(r.exceptionDetails) throw new Error('Media gate final read failed');
      p.rendererFinal=r.result?.value;
      const restored=await original.call(chrome.debugger,p.target,'Runtime.callFunctionOn',{
        objectId:p.receiver,functionDeclaration:${JSON.stringify(fixedRestore)},returnByValue:true,awaitPromise:true,userGesture:false});
      if(restored.exceptionDetails || restored.result?.value!==true) throw new Error('Media gate restoration failed');
      p.restored=true;
    };
    p.wrapper=async function(target,method,params) {
      if(target.tabId!==p.tabId) return original.call(chrome.debugger,target,method,params);
      const capture=method==='Runtime.callFunctionOn' && params.functionDeclaration?.includes('function captureImageBinding(');
      const prepare=method==='Runtime.callFunctionOn' && params.functionDeclaration?.includes('function prepareMediaBytes(');
      const release=method==='Runtime.releaseObject';
      if(capture) {
        if(p.target) throw new Error('Media source must not be selected twice');
        p.target={...target};p.receiver=params.objectId;
        const installed=await original.call(chrome.debugger,target,'Runtime.callFunctionOn',{
          objectId:p.receiver,functionDeclaration:${JSON.stringify(fixedInstall)},arguments:[{value:${JSON.stringify(mode)}}],returnByValue:true,awaitPromise:true,userGesture:false});
        if(installed.exceptionDetails || installed.result?.value!==true) throw new Error('Media gate injection failed');
      }
      if(prepare) {p.preparePending=true;push({phase:'prepare-sent',target:{...target},objectId:params.objectId});}
      if(release) push({phase:'release-sent',target:{...target},objectId:params.objectId});
      try {
        const result=await original.call(chrome.debugger,target,method,params);
        if(capture) {p.binding=result.result?.objectId;push({phase:'capture',target:{...target},objectId:p.binding});}
        if(prepare) {p.preparePending=false;push({phase:'prepare-settled',exception:!!result.exceptionDetails,target:{...target}});await saveRenderer();}
        if(release) push({phase:'release-done',target:{...target},objectId:params.objectId});
        return result;
      } catch(error) {
        if(prepare && p.preparePending) {p.preparePending=false;push({phase:'prepare-rejected',message:String(error.message),target:{...target}});await saveRenderer();}
        if(release) push({phase:'release-failed',target:{...target},objectId:params.objectId});
        throw error;
      }
    };
    chrome.debugger.sendCommand=p.wrapper;
  })()`);
}

async function trace(worker, id) {
  return worker.evaluate(`(async () => {
    const p=globalThis.__mediaContentLifecycle;
    if(!p || p.id!==${JSON.stringify(id)}) throw new Error('Media content probe replaced');
    let renderer=p.rendererFinal??null;
    if(!p.rendererFinal && p.target && p.receiver) {
      const r=await p.original.call(chrome.debugger,p.target,'Runtime.callFunctionOn',{
        objectId:p.receiver,functionDeclaration:${JSON.stringify(fixedRead)},returnByValue:true,awaitPromise:true,userGesture:false});
      if(r.exceptionDetails) throw new Error('Media gate read failed');
      renderer=r.result?.value;
    }
    return {id:p.id,tabId:p.tabId,target:p.target,binding:p.binding,preparePending:p.preparePending,
      events:p.events,downloadCalls:p.downloadCalls,overflow:p.overflow,renderer,restored:p.restored===true};
  })()`);
}

async function restore(worker, id) {
  await worker.evaluate(`(async () => {
    const p=globalThis.__mediaContentLifecycle;
    if(!p) return;
    if(p.id!==${JSON.stringify(id)}) throw new Error('Media content probe replaced');
    try {
      if(!p.restored && p.target && p.receiver) await p.original.call(chrome.debugger,p.target,'Runtime.callFunctionOn',{
        objectId:p.receiver,functionDeclaration:${JSON.stringify(fixedRestore)},returnByValue:true,awaitPromise:true,userGesture:false});
    } finally {
      if(chrome.debugger.sendCommand!==p.wrapper) throw new Error('Media content wrapper replaced');
      if(chrome.downloads.download!==p.downloadWrapper) throw new Error('Media download observer replaced');
      chrome.downloads.download=p.originalDownload;
      delete globalThis.__integrationNativeRPCObserver;
      chrome.debugger.sendCommand=p.original;delete globalThis.__mediaContentLifecycle;
    }
  })()`);
}

export async function checkMediaReadCancellation({ browser, fixtureURL, server, worker, until }) {
  const evidence={faultInjection:injection,scenarios:[]};
  for(const [reason,mode] of [["turn-end","fetch"],["deadline","fetch"],["turn-end","reader"],["deadline","reader"]]) {
    const id=randomUUID();
    let tab,pending,ending,installed=false,failure;
    const detail={reason,mode,id}; evidence.scenarios.push(detail);
    try {
      // Independent scopes make an ended turn incapable of authorizing the
      // next case. Browser construction uses the frozen public SDK class.
      const owner=new browser.constructor({socketPath:browser.client.socketPath,sessionId:`media-read-${id}`,timeoutMs:15000});
      detail.owner=owner;
      await owner.connect();
      tab=await owner.newTab({url:fixtureURL+"media-downloads/page"});
      await tab.waitForLoadState({state:"load"});
      await tab.evaluate(`(async () => {
        const image=document.createElement('img');image.id='cancellable-blob';
        const response=await fetch('/media-downloads/selected.png');
        image.src=URL.createObjectURL(await response.blob());document.body.append(image);await image.decode();
      })()`,{awaitPromise:true});
      detail.tabId=tab.id;
      await install(worker,tab.id,id,mode);installed=true;
      const before=server.stats().length;
      let outcome;
      pending=tab.locator('#cancellable-blob').downloadMedia({filename:`cancelled-${reason}.png`,timeoutMs:reason==='deadline'?2500:10000})
        .then(handle=>{outcome={succeeded:true,downloadId:handle.downloadId};},error=>{outcome={error:error.message};});
      await until(async()=>{ const t=await trace(worker,id);return t.preparePending===true && t.renderer?.started===1 && (mode!=='reader'||t.renderer.readerLocked===true); },'actual renderer media read pending',2000);
      detail.pending=await trace(worker,id);
      assert.deepEqual(detail.pending.renderer,{started:1,aborted:0,settled:0,mode,readerLocked:mode==='reader'});
      if(reason==='turn-end') {ending=owner.client.turnEnded();ending.catch(()=>{});}
      await pending;
      assert.match(outcome.error??'',reason==='deadline'?/OBU_DOWNLOAD_TIMEOUT|timed out/i:/OBU_DOWNLOAD_EXPIRED|OBU_MEDIA_CANCELLED|turn|control|epoch/i);
      if(ending) await ending;
      await until(async()=>{
        const t=await trace(worker,id);
        return t.renderer?.aborted===1 && t.preparePending===false && t.events.some(e=>e.phase==='release-done' && e.objectId===t.binding);
      },'actual renderer abort and exact source handle release',5000);
      detail.final=await trace(worker,id);detail.outcome=outcome;
      assert.equal(detail.final.overflow,false);
      assert.equal(detail.final.restored,true,'The renderer fetch hook must be removed before source cleanup permits native detach');
      assert.deepEqual(detail.final.renderer,{started:1,aborted:1,settled:1,mode,readerLocked:false});
      assert.deepEqual(detail.final.downloadCalls,[],'Cancelled source must not create a native download, including data URLs');
      const releases=detail.final.events.filter(e=>e.objectId===detail.final.binding && e.phase.startsWith('release-'));
      assert.deepEqual(releases.map(e=>e.phase),['release-sent','release-done']);
      assert.ok(releases.every(e=>JSON.stringify(e.target)===JSON.stringify(detail.final.target)));
      const reads=detail.final.events.filter(e=>e.phase.startsWith('prepare-'));
      assert.equal(reads.length,2);assert.equal(reads[0].phase,'prepare-sent');
      assert.ok(['prepare-settled','prepare-rejected'].includes(reads[1].phase));
      const capture=detail.final.events.find(e=>e.phase==='capture');
      assert.ok(capture.sequence<reads[0].sequence && reads[0].sequence<reads[1].sequence &&
        reads[1].sequence<releases[0].sequence && releases[0].sequence<releases[1].sequence,
      'Actual renderer settlement must precede exact binding release');
      if(reason==='turn-end') {
        const acknowledgements=detail.final.events.filter(e=>e.phase==='turn-end-ack');
        assert.equal(acknowledgements.length,1);
        const ack=acknowledgements[0];
        assert.equal(ack.acknowledged,true);assert.equal(ack.preparePending,false);
        assert.equal(ack.bindingReleased,true);assert.equal(ack.restored,true);assert.equal(ack.downloadCalls,0);
        assert.deepEqual(ack.renderer,{started:1,aborted:1,settled:1,mode,readerLocked:false});
        assert.ok(releases[1].sequence<ack.sequence,'Native end acknowledgement must follow actual source cleanup');
      }
      assert.equal(server.stats().length,before,'Cancelled embedded sources cannot start a new HTTP download');
      detail.requests=[];
      const observed=await worker.evaluate(`chrome.scripting.executeScript({target:{tabId:${tab.id}},world:'MAIN',func:()=>({events:mediaEvents,traps:getterTraps})})`);
      assert.equal(observed.length,1);assert.equal(observed[0].frameId,0);
      detail.page=observed[0].result;
      assert.deepEqual(detail.page,{events:[],traps:[]});
    } catch(error) {failure=error;error.mediaContentEvidence=evidence;throw error;}
    finally {
      const owner=detail.owner;delete detail.owner;
      // A failed assertion must still end the authorized source, then wait for
      // its real settlement before restoring the native instrumentation.
      const errors=[];
      if(owner) {
        try {await (ending??owner.client.turnEnded());}catch(error){errors.push(error);}
      }
      if(pending) await pending;
      if(installed) {try {await restore(worker,id);}catch(error){errors.push(error);}}
      if(owner) {
        try {await owner.client.finalizeTabs([]);}catch(error){errors.push(error);}
        owner.close();
      }
      if(errors.length && !failure) throw new AggregateError(errors,'Media read fixture cleanup failed');
      if(errors.length) detail.cleanupErrors=errors.map(e=>String(e.message));
    }
  }
  return evidence;
}

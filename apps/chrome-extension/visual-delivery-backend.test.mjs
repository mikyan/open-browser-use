import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import vm from "./test-support/backend-vm.mjs";
import { BrowserActionEngine } from "./browser-action-engine.js";

const source = (await readFile(new URL("./background.js", import.meta.url), "utf8")).replace('import { createBrowserActionEngine } from "./browser-runtime.js";', "").replace('import { NativeInputTracker } from "./browser-input-adapter.js";', (await readFile(new URL("./browser-input-adapter.js", import.meta.url), "utf8")).replace(/^export /gm, "") + "\nglobalThis.performance ??= { now: () => Date.now() };");
const runtimeStart = source.indexOf("chrome.runtime.onInstalled.addListener");
assert.notEqual(runtimeStart, -1);
const session = { session_id: "visual-delivery-test", turn_id: "turn-1" };
const json = (value) => JSON.parse(JSON.stringify(value));
const mouse = (type = "mouseMoved", extra = {}) => ({
  ...session, target: { tabId: 7 }, method: "Input.dispatchMouseEvent",
  commandParams: { type, x: 120, y: 80 }, ...extra
});
const deferred = () => {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
};

async function loadBackend({ sendCommand, sendMessage, inject, getFrame, rawReplies = false, storage = {} } = {}) {
  const calls = { commands: [], messages: [], injections: [], focus: [] };
  const removedListeners = new Set(); let tabExists = true;
  const result = { synthetic: "CDP result" };
  const chrome = {
    debugger: {
      onDetach: { addListener() {} },
      async detach() {},
      async sendCommand(...args) {
        calls.commands.push(json(args));
        return sendCommand ? await sendCommand(...args) : result;
      }
    },
    storage: { local: { async get(key) { return Object.hasOwn(storage, key) ? { [key]: json(storage[key]) } : {}; }, async set(value) { Object.assign(storage, json(value)); } } },
    webNavigation: { async getFrame(params) { return getFrame ? getFrame(params) : { documentId: "original-document" }; } },
    tabGroups: { async get() { return { id: 10 }; } },
    tabs: {
      onRemoved: { addListener: listener => removedListeners.add(listener) },
      async query() { return tabExists ? [{ id: 7, groupId: 10, url: "https://example.test" }] : []; },
      async update(...args) { calls.focus.push(args); },
      async sendMessage(tabId, message, destination) {
        calls.messages.push({ tabId, ...json(message) });
        const response = sendMessage ? await sendMessage(tabId, message, destination) : { ok: true };
        return !rawReplies && response?.ok === true && (message.type === "OPEN_BROWSER_USE_PING" || message.type === "OPEN_BROWSER_USE_CURSOR_STATE" && !message.state?.isVisible)
          ? { ...response, receiverToken: message.receiverToken ?? "original-receiver" } : response;
      }
    },
    windows: { async update(...args) { calls.focus.push(args); } },
    scripting: {
      async executeScript(options) {
        calls.injections.push(json(options));
        return inject?.(options);
      }
    }
  };
  const BrowserBackend = vm.runInNewContext(
    `${source.slice(0, runtimeStart)}\nBrowserBackend;`,
    { chrome, Date, setTimeout, clearTimeout }
  );
  const backend = new BrowserBackend();
  await backend.store.ready;
  await backend.requireSession(session);
  const state = await backend.store.getSession(session.session_id);
  state.chromeGroupId = 10;
  state.activeTabId = 7;
  backend.activeTabsBySession.set(session.session_id, 7);
  backend.attachedTabs.add(7);
  backend.attachmentEpochs.set(7, {});
  backend.inputTracker.register(7, backend.attachmentEpochs.get(7));
  return { backend, calls, result, restart: () => { removedListeners.clear(); return new BrowserBackend(); },
    removeTab: () => { tabExists = false; for (const listener of removedListeners) listener(7); } };
}

async function flushFeedback(backend) {
  await Promise.all([...backend.pointerFeedbackByTabId.values()].map((queue) => queue.running));
}

test('a stale end admission cannot revoke the current visual producer', async () => {
  const { backend, calls } = await loadBackend();
  await backend.executeCdp(mouse()); await flushFeedback(backend);
  const original = [...backend.visualDeliveries.records][0], before = calls.messages.length;
  assert.ok(original && !original.closed);
  await assert.rejects(backend.endSessionControl({ ...session, control_epoch: 999 }, () => { throw Error('Stale finish ran'); }), /OBU_STALE_CONTROL_EPOCH/);
  assert.equal(original.closed, false);
  assert.equal(calls.messages.length, before);
});

test('an explicitly retired receiver is not treated as a missing script to reinject', async () => {
  const { backend, calls } = await loadBackend({ sendMessage: async () => ({ ok: false, error: 'OBU_VISUAL_RECEIVER_RETIRED' }) });
  await backend.executeCdp(mouse()); await flushFeedback(backend);
  assert.equal(calls.injections.length, 0);
  assert.ok(calls.messages.every(message => message.type === 'OPEN_BROWSER_USE_PING'));
});

test('worker recovery hides the original live receiver without granting a new visible producer', async () => {
  let visible = false;
  const f = await loadBackend({ sendMessage: async (_tab, message) => {
    if (message.type === 'OPEN_BROWSER_USE_CURSOR') visible = true;
    if (message.type === 'OPEN_BROWSER_USE_CURSOR_STATE') visible = message.state.isVisible;
    return { ok: true };
  } });
  await f.backend.store.save(); await f.backend.executeCdp(mouse()); await flushFeedback(f.backend);
  assert.equal(visible, true);
  const before = f.calls.messages.length, restarted = f.restart();
  await restarted.controlReady;
  assert.equal(visible, false, 'Worker recovery left the old content receiver visible');
  const messages = f.calls.messages.slice(before);
  assert.deepEqual(messages.map(message => message.type), ['OPEN_BROWSER_USE_PING', 'OPEN_BROWSER_USE_CURSOR_STATE']);
  assert.equal(messages[1].state.isVisible, false); assert.equal(messages[1].receiverToken, 'original-receiver');
  assert.equal(restarted.visualDeliveries.records.size, 0); assert.equal(restarted.visualRecoverySessions.size, 0);
});

test('worker recovery retains a pending final hide and does not inject or complete early', async () => {
  const entered = deferred(), hidden = deferred(); let hold = false;
  const f = await loadBackend({ sendMessage: async (_tab, message) => {
    if (hold && message.type === 'OPEN_BROWSER_USE_CURSOR_STATE' && !message.state.isVisible) { entered.resolve(); await hidden.promise; }
    return { ok: true };
  } });
  await f.backend.store.save(); await f.backend.executeCdp(mouse()); await flushFeedback(f.backend); hold = true;
  const injections = f.calls.injections.length, restarted = f.restart(); await entered.promise;
  const pending = await observePending(restarted.controlReady);
  assert.equal(pending, true); assert.ok(restarted.visualDeliveries.pending.size > 0);
  hidden.resolve(); await restarted.controlReady;
  assert.equal(f.calls.injections.length, injections); assert.equal(restarted.visualDeliveries.pending.size, 0);
});

for (const empty of [undefined, null]) test(`worker recovery checks an absent receiver after ${String(empty)} from another listener`, async () => {
  const f = await loadBackend({ rawReplies: true, sendMessage: async () => empty, inject: async options => {
    assert.deepEqual(json(options.target), { tabId: 7, documentIds: ['original-document'] });
    assert.equal(options.world, 'ISOLATED'); assert.equal(options.files, undefined);
    assert.equal(vm.runInNewContext(`(${options.func.toString()})()`, {}), true);
    return [{ frameId: 0, documentId: 'original-document', result: true }];
  } });
  await f.backend.store.save(); const restarted = f.restart(); await restarted.controlReady;
  assert.equal(restarted.visualRecoverySessions.size, 0);
  assert.equal(restarted.visualDeliveries.records.size, 0);
  assert.equal(f.calls.injections.length, 1, 'one read-only original-document presence check');
  assert.ok(f.calls.messages.every(message => message.type === 'OPEN_BROWSER_USE_PING'));
});

test('worker recovery keeps its original presence read pending until the real result arrives', async () => {
  const entered = deferred(), gate = deferred();
  const f = await loadBackend({ rawReplies: true, sendMessage: async () => undefined, inject: options => { entered.resolve(options); return gate.promise; } });
  await f.backend.store.save(); const restarted = f.restart(); await entered.promise;
  assert.equal(await observePending(restarted.controlReady), true);
  assert.ok([...restarted.visualDeliveries.pending].some(value => value.kind === 'RECOVERY_PRESENCE'));
  gate.resolve([{ frameId: 0, documentId: 'original-document', result: true }]);
  await restarted.controlReady; assert.equal(restarted.visualDeliveries.pending.size, 0);
});

test('exact removed-tab cleanup releases its original failed backend recovery item', async () => {
  const f = await loadBackend({ rawReplies: true, sendMessage: async () => ({ ok: false, error: 'Original recovery unavailable' }) });
  await f.backend.store.save(); const restarted = f.restart(); await restarted.controlReady;
  const recovery = restarted.visualRecoverySessions.get(session.session_id);
  assert.equal(recovery.tabs.get(7).state, 'failed');
  f.removeTab(); await Promise.all([...restarted.visualDeliveries.cleanups].map(record => record.promise)); await new Promise(setImmediate);
  assert.equal(restarted.visualDeliveries.records.size, 0); assert.equal(recovery.tabs.has(7), false);
  await restarted.clearSessionActivity(session.session_id); assert.equal(restarted.visualRecoverySessions.size, 0);
});

test('removed-tab cleanup waits for the actual read and preserves replacement and foreign recovery items', async () => {
  const entered = deferred(), gate = deferred();
  const f = await loadBackend({ rawReplies: true, sendMessage: async () => undefined, inject: () => { entered.resolve(); return gate.promise; } });
  await f.backend.store.save(); const restarted = f.restart(); await entered.promise;
  const recovery = restarted.visualRecoverySessions.get(session.session_id), original = recovery.tabs.get(7);
  f.removeTab();
  assert.equal(await observePending(restarted.controlReady), true); assert.equal(recovery.tabs.get(7), original);
  assert.ok([...restarted.visualDeliveries.pending].some(value => value.kind === 'RECOVERY_PRESENCE'));
  const replacement = { state: 'pending' }, foreign = { state: 'failed' };
  recovery.tabs.set(7, replacement); recovery.tabs.set(8, foreign);
  gate.resolve(Promise.reject(Error('Actual read rejected after exact removal')));
  await restarted.controlReady; await new Promise(setImmediate);
  assert.equal(restarted.visualDeliveries.pending.size, 0); assert.equal(restarted.visualDeliveries.records.size, 0);
  assert.equal(recovery.tabs.get(7), replacement); assert.equal(recovery.tabs.get(8), foreign);
});

test('worker recovery retains failure when the original presence read rejects', async () => {
  const f = await loadBackend({ rawReplies: true, sendMessage: async () => undefined, inject: async () => { throw Error('Original presence read failed'); } });
  await f.backend.store.save(); const restarted = f.restart(); await restarted.controlReady;
  assert.equal(restarted.visualRecoverySessions.size, 1);
  assert.equal(restarted.visualDeliveries.pending.size, 0);
  assert.ok([...restarted.visualDeliveries.records].some(record => record.cleanupState === 'failed'));
  await assert.rejects(restarted.recoverSessionVisuals(session.session_id, [{ id: 7 }], true), /Original presence read failed/);
});

for (const result of [[], [{ frameId: 0, documentId: 'other-document', result: true }],
  [{ frameId: 1, documentId: 'original-document', result: true }],
  [{ frameId: 0, documentId: 'original-document' }], [{ frameId: 0, documentId: 'original-document', result: false }]])
test(`empty recovery PING cannot use ambiguous presence evidence: ${JSON.stringify(result)}`, async () => {
  const f = await loadBackend({ rawReplies: true, sendMessage: async () => undefined, inject: async () => result });
  await f.backend.store.save(); const restarted = f.restart(); await restarted.controlReady;
  assert.equal(restarted.visualRecoverySessions.size, 1);
  assert.ok([...restarted.visualDeliveries.records].some(record => record.cleanupState === 'failed'));
  await assert.rejects(restarted.recoverSessionVisuals(session.session_id, [{ id: 7 }], true), /OBU_VISUAL_CLEANUP_FAILED/);
});

for (const response of [{ ok: true }, { ok: false, error: 'OBU_VISUAL_RECEIVER_RETIRED' }])
test(`malformed or retired recovery response is not absence: ${JSON.stringify(response)}`, async () => {
  const f = await loadBackend({ rawReplies: true, sendMessage: async () => response });
  await f.backend.store.save(); const restarted = f.restart(); await restarted.controlReady;
  assert.equal(restarted.visualRecoverySessions.size, 1);
  assert.equal(f.calls.injections.length, 0);
});

// These gates delay the original Chrome API Promise, not its observation or a
// replacement result. The ledger records dispatch order; it is not pixel proof.
const waitImmediate = () => new Promise(setImmediate);
async function observePending(promise) {
 let settled=false; promise.finally(()=>{settled=true;}).catch(()=>{});
 await new Promise(resolve=>setTimeout(resolve,25)); return !settled;
}

for(const kind of ['CURSOR','POINTER_EVENT','CURSOR_STATE']) test(`turn end drains the original ${kind} delivery before its final hidden state`,async()=>{
 const gate=deferred(),entered=deferred(),delivered=[];let held=false;
 const {backend,calls}=await loadBackend({sendMessage:async(_tab,message,destination)=>{
  if(!held&&message.type===`OPEN_BROWSER_USE_${kind}`&&(kind!=='CURSOR_STATE'||message.state?.isVisible)){
   held=true;entered.resolve();await gate.promise;
  }
  if(message.type!=='OPEN_BROWSER_USE_PING')delivered.push({message:json(message),destination:json(destination??{})});
  return {ok:true};
 }});
 let original;
 if(kind==='CURSOR_STATE')original=backend.publishCursorState(7,session);
 else original=backend.executeCdp(mouse(kind==='POINTER_EVENT'?'mousePressed':'mouseMoved'));
 original.catch(()=>{});await entered.promise;
 if(kind!=='CURSOR_STATE')await original; // optional UI may not hold native input
 const ending=backend.turnEnded(session);ending.catch(()=>{});
 const pending=await observePending(ending);
 gate.resolve();await original;await ending;await waitImmediate();
 assert.equal(pending,true,'End acknowledged while original delivery was still pending');
 assert.equal(delivered.at(-1).message.type,'OPEN_BROWSER_USE_CURSOR_STATE');
 assert.equal(delivered.at(-1).message.state.isVisible,false);
 assert.equal(calls.commands.filter(row=>row[1]==='Input.dispatchMouseEvent').length,kind==='CURSOR_STATE'?0:1);
});

test('manual moveMouse delivery joins end even when its public wait has not completed',async()=>{
 const gate=deferred(),entered=deferred(),delivered=[];
 const {backend}=await loadBackend({sendMessage:async(_tab,message)=>{
  if(message.type==='OPEN_BROWSER_USE_CURSOR'){entered.resolve();await gate.promise;}
  if(message.type!=='OPEN_BROWSER_USE_PING')delivered.push(json(message));return {ok:true};
 }});
 const move=backend.moveMouse({...session,tabId:7,x:120,y:80,waitForArrival:false});move.catch(()=>{});await entered.promise;
 const ending=backend.turnEnded(session);ending.catch(()=>{});const pending=await observePending(ending);
 gate.resolve();await Promise.allSettled([move]);await ending;await waitImmediate();
 assert.equal(pending,true);assert.equal(delivered.at(-1).type,'OPEN_BROWSER_USE_CURSOR_STATE');assert.equal(delivered.at(-1).state.isVisible,false);
});

test('explicit detach drains original delivery and waits for a positive final hidden ACK',async()=>{
 const gate=deferred(),entered=deferred(),delivered=[];
 const {backend}=await loadBackend({sendMessage:async(_tab,message)=>{
  if(message.type==='OPEN_BROWSER_USE_CURSOR'){entered.resolve();await gate.promise;}
  if(message.type!=='OPEN_BROWSER_USE_PING')delivered.push(json(message));return {ok:true};
 }});
 await backend.executeCdp(mouse());await entered.promise;
 const detaching=backend.detach({...session,tabId:7});detaching.catch(()=>{});const pending=await observePending(detaching);
 gate.resolve();await detaching;await waitImmediate();
 assert.equal(pending,true);assert.equal(delivered.at(-1).type,'OPEN_BROWSER_USE_CURSOR_STATE');assert.equal(delivered.at(-1).state.isVisible,false);
});

test('Pause cannot claim cleanupComplete while the original visual Chrome API remains pending',async()=>{
 const gate=deferred(),entered=deferred(),delivered=[];
 const {backend}=await loadBackend({sendMessage:async(_tab,message)=>{
  if(message.type==='OPEN_BROWSER_USE_CURSOR'){entered.resolve();await gate.promise;}
  if(message.type!=='OPEN_BROWSER_USE_PING')delivered.push(json(message));return {ok:true};
 }});
 await backend.executeCdp(mouse());await entered.promise;
 const pausing=backend.pauseAutomation();pausing.catch(()=>{});const pending=await observePending(pausing);
 gate.resolve();await pausing;await waitImmediate();
 assert.equal(pending,true);assert.equal(delivered.at(-1).type,'OPEN_BROWSER_USE_CURSOR_STATE');assert.equal(delivered.at(-1).state.isVisible,false);
});

test('late injection cannot install a visible bootstrap after end has declared cleanup complete',async()=>{
 const gate=deferred(),entered=deferred(),events=[];let installed=false;
 const {backend}=await loadBackend({sendMessage:async(_tab,message)=>{
  if(message.type==='OPEN_BROWSER_USE_PING'&&!installed)throw Error('original listener not installed');
  if(message.type==='OPEN_BROWSER_USE_CURSOR_STATE')events.push(['state',message.state?.isVisible]);
  return {ok:true};
 },inject:async()=>{entered.resolve();await gate.promise;installed=true;events.push(['injected']);}});
 await backend.executeCdp(mouse());await entered.promise;
 const ending=backend.turnEnded(session);ending.catch(()=>{});const pending=await observePending(ending);
 gate.resolve();await ending;await waitImmediate();
 assert.equal(pending,true);assert.equal(events.filter(x=>x[0]==='injected').length,1,'cleanup must never inject a replacement renderer');
 assert.equal(events.some(row=>row[0]==='state'&&row[1]===true),false,'closed bootstrap has no visible token authority');
});

test('an unconfirmed final hidden response is not successful End cleanup',async()=>{
 const {backend}=await loadBackend({sendMessage:async(_tab,message)=>message.type==='OPEN_BROWSER_USE_CURSOR_STATE'&&!message.state?.isVisible?{ok:false}:{ok:true}});
 await backend.executeCdp(mouse());await flushFeedback(backend);
 await assert.rejects(backend.turnEnded(session),/OBU_VISUAL_CLEANUP_FAILED/);
});

test('End drains an already dispatched original TARGET_RECT patch after its geometry read settled',async()=>{
 const geometry=deferred(),delivery=deferred(),entered=deferred(),delivered=[];
 const {backend}=await loadBackend({sendMessage:async(_tab,message,destination)=>{
  if(message.type==='OPEN_BROWSER_USE_TARGET_RECT'){entered.resolve();await delivery.promise;}
  if(message.type!=='OPEN_BROWSER_USE_PING')delivered.push({message:json(message),destination:json(destination??{})});
  return {ok:true};
 }});
 await backend.executeCdp(mouse());await flushFeedback(backend);
 backend.browserEngine={active:new Map([[7,{...session,control_epoch:backend.controlLedger.assertCurrent(session).epoch}]])};
 const candidate=backend.capturePointerTarget({target:{tabId:7},check(){},read:()=>geometry.promise,decode:value=>value});
 backend.browserEngine=undefined;
 backend.preparePointerFeedback({...mouse(),feedbackTarget:candidate})();await flushFeedback(backend);
 geometry.resolve({x:20,y:30,width:40,height:50});await entered.promise;
 assert.equal(backend.pointerFeedbackReads.pending.size,0,'the held work is actual message delivery, not native geometry');
 const ending=backend.turnEnded(session);ending.catch(()=>{});const pending=await observePending(ending);
 delivery.resolve();await ending;await waitImmediate();
 assert.equal(pending,true);assert.equal(delivered.at(-1).message.state?.isVisible,false);
 assert.deepEqual(delivered.find(row=>row.message.type==='OPEN_BROWSER_USE_TARGET_RECT').destination,{documentId:'original-document'});
});

test('unattached visible STATE is original session work and must drain before End final hide',async()=>{
 const gate=deferred(),entered=deferred(),delivered=[];
 const {backend}=await loadBackend({sendMessage:async(_tab,message)=>{
  if(message.type==='OPEN_BROWSER_USE_CURSOR_STATE'&&message.state?.isVisible){entered.resolve();await gate.promise;}
  if(message.type!=='OPEN_BROWSER_USE_PING')delivered.push(json(message));return {ok:true};
 }});
 backend.inputTracker.forget(7);backend.attachedTabs.delete(7);backend.attachmentEpochs.delete(7);
 const publishing=backend.publishCursorState(7,session);publishing.catch(()=>{});await entered.promise;
 const ending=backend.turnEnded(session);ending.catch(()=>{});const pending=await observePending(ending);
 gate.resolve();await publishing;await ending;await waitImmediate();
 assert.equal(pending,true);assert.equal(delivered.at(-1).state?.isVisible,false);
});

test('a PING-only producer revoked before injection needs no hide and cannot inject after End',async()=>{
 const ping=deferred(),entered=deferred();let first=true;
 const {backend,calls}=await loadBackend({sendMessage:async(_tab,message)=>{
  if(message.type==='OPEN_BROWSER_USE_PING'&&first){first=false;entered.resolve();return ping.promise;}
  throw Error('No owned content script has ever existed');
 },inject:()=>{throw Error('injection must not be attempted after producer revocation');}});
 await backend.executeCdp(mouse());await entered.promise;
 const ending=backend.turnEnded(session);ending.catch(()=>{});const pending=await observePending(ending);
 ping.resolve({ok:false});await ending;await flushFeedback(backend);
 assert.equal(pending,true,'even read-only actual Chrome PING settlement stays tracked');
 assert.equal(calls.injections.length,0,'a closed producer cannot start a new injection');
 assert.equal(calls.messages.some(row=>row.type!=='OPEN_BROWSER_USE_PING'),false,'no possible visual effect requires no speculative hidden send');
});

test('final hide itself is actual pending cleanup, and malformed ACK leaves original scope closing',async()=>{
 for(const response of [{ok:true},{ok:true,receiverToken:'wrong'}]){
  const gate=deferred(),entered=deferred();let hides=0;
  const {backend}=await loadBackend({rawReplies:true,sendMessage:async(_tab,message)=>{
   if(message.type==='OPEN_BROWSER_USE_PING')return {ok:true,receiverToken:'original-receiver'};
   if(message.type==='OPEN_BROWSER_USE_CURSOR_STATE'&&!message.state?.isVisible){hides++;entered.resolve();return gate.promise;}
   return {ok:true};
  }});
  await backend.executeCdp(mouse());await flushFeedback(backend);
  const ending=backend.turnEnded(session);ending.catch(()=>{});await entered.promise;
  assert.equal(await observePending(ending),true);assert.equal(hides,1);
  assert.equal(backend.readCursorOverlayState(7).isVisible,false);
  gate.resolve(response);await assert.rejects(ending,/OBU_VISUAL_CLEANUP_FAILED/);
  assert.equal(backend.controlLedger.records.get(session.session_id).status,'closing');
  assert.equal(backend.visualDeliveries.cleanups.size,1);
 }
});

test('original pagehide receipt cannot release an unsettled message and foreign receipt cannot retire it',async()=>{
 const gate=deferred(),entered=deferred();
 const {backend,calls}=await loadBackend({sendMessage:async(_tab,message)=>{
  if(message.type==='OPEN_BROWSER_USE_CURSOR'){entered.resolve();await gate.promise;}return {ok:true};
 }});
 await backend.executeCdp(mouse());await entered.promise;
 assert.equal(backend.visualDeliveries.retired(7,'successor-document','original-receiver'),false);
 assert.equal(backend.visualDeliveries.retired(7,'original-document','wrong'),false);
 assert.equal(backend.visualDeliveries.retired(7,'original-document','original-receiver'),true);
 const ending=backend.turnEnded(session);ending.catch(()=>{});
 assert.equal(await observePending(ending),true);assert.equal(backend.visualDeliveries.pending.size,1);
 gate.resolve();await ending;
 assert.equal(calls.messages.some(value=>value.type==='OPEN_BROWSER_USE_CURSOR_STATE'),false,'a real retired receiver receipt proves only that exact generation hidden');
});

test('actual Engine timeout does not await optional delivery; successor native input runs while its visual waits old hide',async()=>{
 const oldDelivery=deferred(),entered=deferred(),hideGate=deferred(),hideEntered=deferred(),delivered=[];let first=true;
 const {backend,calls}=await loadBackend({sendMessage:async(_tab,message)=>{
  if(message.type==='OPEN_BROWSER_USE_CURSOR'&&first){first=false;entered.resolve();await oldDelivery.promise;}
  if(message.type==='OPEN_BROWSER_USE_CURSOR_STATE'&&!message.state?.isVisible){hideEntered.resolve();await hideGate.promise;}
  if(message.type!=='OPEN_BROWSER_USE_PING')delivered.push(json(message));return {ok:true};
 }});
 await backend.executeCdp(mouse());await entered.promise;
 let rejectAction;const actionEntered=deferred();
 const page={on(){},off(){},locator(){return {count(){actionEntered.resolve();return new Promise((_,reject)=>rejectAction=reject);}};}};
 const app={attach:async()=>page,detach:async()=>{const release=backend.prepareInputRelease(7);rejectAction?.(Error('Page closed'));await release.release();await release.detach();}};
 globalThis.chrome={tabs:{get:async()=>({incognito:false})}};
 const engine=new BrowserActionEngine({loadRuntime:async()=>({crx:{start:async()=>app},setOpenBrowserUseCommandObserver(){},setOpenBrowserUseEventFilter(){},assertOpenBrowserUseSelector(){}}),onDetached:()=>backend.releaseEngineAttachment(7)});
 backend.browserEngine=engine;
 const action=engine.dispatch({...session,tabId:7,action:'count',locator:[{kind:'css',selector:'button'}],timeoutMs:25});
 const failed=assert.rejects(action,/timed out after 25ms/);await actionEntered.promise;
 await Promise.race([failed,new Promise((_,reject)=>setTimeout(()=>reject(Error('optional visual extended input deadline')),300))]);
 assert.equal(backend.visualDeliveries.pending.size,1);
 backend.browserEngine=undefined;backend.attachedTabs.add(7);backend.attachmentEpochs.set(7,{});backend.inputTracker.register(7,backend.attachmentEpochs.get(7));
 await backend.executeCdp(mouse('mouseMoved',{commandParams:{type:'mouseMoved',x:240,y:160}}));
 assert.equal(calls.commands.filter(value=>value[1]==='Input.dispatchMouseEvent').length,2);
 oldDelivery.resolve();await hideEntered.promise;
 assert.equal(delivered.some(value=>value.type==='OPEN_BROWSER_USE_CURSOR'&&value.x===240),false);
 hideGate.resolve();await flushFeedback(backend);
 assert.deepEqual(delivered.map(value=>value.type==='OPEN_BROWSER_USE_CURSOR'?value.x:'hidden'),[120,'hidden',240]);
});

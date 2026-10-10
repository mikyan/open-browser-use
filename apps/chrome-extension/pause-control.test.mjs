import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from './test-support/backend-vm.mjs';
import test from 'node:test';

const source = (await readFile(new URL('./background.js', import.meta.url), 'utf8')).replace('import { createBrowserActionEngine } from "./browser-runtime.js";', '').replace('import { NativeInputTracker } from "./browser-input-adapter.js";', (await readFile(new URL("./browser-input-adapter.js", import.meta.url), "utf8")).replace(/^export /gm, "") + "\nglobalThis.performance ??= { now: () => Date.now() };");
const code = source.slice(0, source.indexOf('chrome.runtime.onInstalled.addListener'));
const handler = source.slice(source.indexOf('async function handleAutomationControlMessage'), source.indexOf('chrome.runtime.onMessage.addListener'));
const KEY = 'OPEN_BROWSER_USE_AUTOMATION_CONTROL';
const clone = value => JSON.parse(JSON.stringify(value));
const tick = () => new Promise(resolve => setTimeout(resolve, 0));
const deferred = () => { let resolve, reject; const promise = new Promise((done, fail) => { resolve = done; reject = fail; }); return { promise, resolve, reject }; };
const params = (epoch, extra = {}) => ({session_id:'task',turn_id:'turn',...(epoch ? {control_epoch:epoch} : {}),...extra});
function environment({storage={}, write, read, attachGate, createBrowserActionEngine}={}) {
  const calls=[], attached=new Set(), tabs=new Map([[7,{id:7,groupId:10,windowId:1,url:'https://fixture.test'}]]);
  const chrome={
    storage:{local:{async get(key){await read?.(key);return Object.hasOwn(storage,key)?{[key]:clone(storage[key])}:{}},async set(value){await write?.(value);Object.assign(storage,clone(value));calls.push(['save',Object.keys(value)[0]])}}},
    debugger:{onDetach:{addListener(){}},onEvent:{addListener(){},removeListener(){}},async attach({tabId}){await attachGate?.promise;attached.add(tabId);calls.push(['attach',tabId])},async detach({tabId}){attached.delete(tabId);calls.push(['detach',tabId])},async sendCommand(target,method){calls.push([method,target.tabId]);return {}}},
    tabs:{async query(filter){return [...tabs.values()].filter(tab=>filter?.groupId===undefined||tab.groupId===filter.groupId)},async get(tabId){return tabs.get(tabId)},async remove(ids){calls.push(['remove',ids]);for(const id of [].concat(ids))tabs.delete(id)},async ungroup(ids){calls.push(['ungroup',ids])},async sendMessage(tabId,message){calls.push([message.type,tabId]);return {ok:true}}},
    tabGroups:{async update(){},async get(){return {}},async query(){return []},async group(){calls.push(['group']);return 10}},
    runtime:{id:'fixture',getURL:path=>`chrome-extension://fixture/${path}`,async getContexts(){return [{contextType:'POPUP',documentUrl:'chrome-extension://fixture/popup.html',documentId:'popup-doc'}]}}
  };
  const context={chrome,Date,URL,setTimeout,clearTimeout,crypto,createBrowserActionEngine};
  const classes=vm.runInNewContext(`${code}\n({BrowserBackend,AutomationControlGate});`,context);
  return {...classes,chrome,storage,calls,attached,tabs,context};
}
async function backendFor(env,options){const backend=new env.BrowserBackend(options);await backend.controlReady;const session=await backend.store.getSession('task');session.chromeGroupId=10;session.tabOrigins={7:'agent'};await backend.store.save();return backend}

test('pause retires idle and active epochs and all legacy work without tab disposition',async()=>{
  const env=environment(),backend=await backendFor(env);
  const first=await backend.getControlState({session_id:'task'}),idle=await backend.getControlState({session_id:'idle'});
  await backend.attach(params(first.controlEpoch,{tabId:7}));
  const paused=await backend.pauseAutomation();assert.equal(paused.state,'paused');assert.equal(env.attached.size,0);
  assert.equal(env.calls.some(([method])=>['remove','ungroup','group'].includes(method)),false);
  await assert.rejects(backend.getControlState({session_id:'task'}),/OBU_AUTOMATION_PAUSED/);
  await assert.rejects(backend.nameSession(params(first.controlEpoch,{name:'bad'})),/OBU_AUTOMATION_PAUSED/);
  await assert.rejects(backend.resumeAutomation(paused.revision-1),/REVISION_CONFLICT/);
  await backend.resumeAutomation(paused.revision);
  for(const [session,epoch] of [['task',first.controlEpoch],['idle',idle.controlEpoch]])await assert.rejects(backend.nameSession({session_id:session,turn_id:'late',control_epoch:epoch,name:'bad'}),/STALE_CONTROL_EPOCH/);
  await assert.rejects(backend.nameSession(params(undefined,{name:'legacy'})),/BOOTSTRAP_REQUIRED/);
  const future=await backend.getControlState({session_id:'new-session'});
  await assert.rejects(backend.nameSession({session_id:'new-session',turn_id:'unobserved',name:'legacy'}),/BOOTSTRAP_REQUIRED/);
  await backend.nameSession({session_id:'new-session',turn_id:future.nextTurnId,control_epoch:future.controlEpoch,name:'new'});
});

test('pause is durable across worker restart and resume requires explicit successor epoch',async()=>{
 const env=environment(),backend=await backendFor(env),first=await backend.getControlState({session_id:'task'});
 await backend.pauseAutomation();const restarted=new env.BrowserBackend();await restarted.controlReady;
 const state=await restarted.getAutomationControlStatus();assert.equal(state.state,'paused');assert.equal(env.storage[KEY].paused,true);
 await assert.rejects(restarted.attach(params(first.controlEpoch,{tabId:7})),/AUTOMATION_PAUSED/);
 await restarted.resumeAutomation(state.revision);await assert.rejects(restarted.attach(params(first.controlEpoch,{tabId:7})),/STALE_CONTROL_EPOCH/);
});

test('invalid or unreadable persisted pause state fails closed and cannot be overwritten by Resume',async()=>{
 for(const options of [{storage:{[KEY]:{version:1,paused:'false',revision:1}}},{read:async key=>{if(key===KEY)throw new Error('storage unavailable')}}]){
  const env=environment(options),backend=await backendFor(env),state=await backend.getAutomationControlStatus();assert.equal(state.state,'error');assert.equal(state.inputBlocked,true);
  await assert.rejects(backend.getControlState({session_id:'task'}),/AUTOMATION_PAUSED/);
  await assert.rejects(backend.resumeAutomation(state.revision),/PAUSE_INCOMPLETE/);
 }
});

test('failed persistence immediately cancels known control and keeps admission blocked',async()=>{
 let fail=false;const env=environment({write:async value=>{if(fail&&value[KEY])throw new Error('quota')}}),backend=await backendFor(env);
 await backend.attach(params(undefined,{tabId:7}));fail=true;
 await assert.rejects(backend.pauseAutomation(),/PAUSE_FAILED.*quota/);assert.equal(env.attached.size,0);
 const state=await backend.getAutomationControlStatus();assert.equal(state.state,'error');
 await assert.rejects(backend.attach(params(undefined,{tabId:7})),/AUTOMATION_PAUSED/);
 await assert.rejects(backend.resumeAutomation(state.revision),/PAUSE_INCOMPLETE/);
 fail=false;assert.equal((await backend.pauseAutomation()).state,'paused');
});

test('late native attachment is drained and never initializes focus after pause',async()=>{
 const gate=deferred(),env=environment({attachGate:gate}),backend=await backendFor(env);
 const attaching=assert.rejects(backend.attach(params(undefined,{tabId:7})),/AUTOMATION_PAUSED/);await tick();
 let finished=false;const pausing=backend.pauseAutomation().then(()=>{finished=true});await tick();assert.equal(finished,false);
 gate.resolve();await Promise.all([attaching,pausing]);assert.equal(env.attached.size,0);
 assert.equal(env.calls.some(([method])=>method==='Emulation.setFocusEmulationEnabled'),false);
});

test('pause drains the issued finalization close but blocks later ungroup and group',async()=>{
 const env=environment(),backend=await backendFor(env),gate=deferred();env.tabs.set(8,{id:8,groupId:10,windowId:1});
 const remove=env.chrome.tabs.remove;env.chrome.tabs.remove=async ids=>{await gate.promise;await remove(ids)};
 const ending=assert.rejects(backend.finalizeTabs(params(undefined,{keep:[]})),/AUTOMATION_PAUSED/);await tick();
 let finished=false;const pausing=backend.pauseAutomation().then(()=>{finished=true});await tick();assert.equal(finished,false);
 gate.resolve();await Promise.all([ending,pausing]);assert.equal(env.calls.filter(([method])=>method==='remove').length,1);
 assert.equal(env.calls.some(([method])=>['ungroup','group'].includes(method)),false);
});

test('pause interrupts cursor-arrival wait and suppresses late overlay publication',async()=>{
 const env=environment(),backend=await backendFor(env);
 const moving=assert.rejects(backend.moveMouse(params(undefined,{tabId:7,x:10,y:20})),/AUTOMATION_PAUSED/);await tick();
 assert.equal(backend.cursorArrivalWaitersByKey.size,1);await backend.pauseAutomation();await moving;
 assert.equal(backend.cursorArrivalWaitersByKey.size,0);assert.equal(backend.readCursorOverlayState(7).isVisible,false);
});

test('a newer Pause supersedes Resume while its storage write is pending',async()=>{
 const gate=deferred();let delay=false;const env=environment({write:async value=>{if(delay&&value[KEY]?.paused===false)await gate.promise}}),backend=await backendFor(env);
 const paused=await backend.pauseAutomation();delay=true;
 const resuming=assert.rejects(backend.resumeAutomation(paused.revision),/newer Pause/);await tick();
 const pausing=backend.pauseAutomation();gate.resolve();await Promise.all([resuming,pausing]);
 assert.equal(env.storage[KEY].paused,true);assert.equal((await backend.getAutomationControlStatus()).state,'paused');
});

test('only the current real action popup can mutate user control',async()=>{
 const env=environment(),backend=await backendFor(env);
 const invoke=vm.runInNewContext(`${handler}\nhandleAutomationControlMessage`,{...env.context,backend});
 const sender={id:'fixture',url:'chrome-extension://fixture/popup.html',origin:'chrome-extension://fixture'};
 for(const invalid of [{...sender,id:'other'},{...sender,url:'https://fixture.test'},{...sender,tab:{id:7}},{...sender,documentId:'stale'}])await assert.rejects(invoke({type:'PAUSE_AUTOMATION'},invalid),/CONTROL_FORBIDDEN/);
 env.chrome.runtime.getContexts=async()=>[];await assert.rejects(invoke({type:'PAUSE_AUTOMATION'},sender),/CONTROL_FORBIDDEN/);
 env.chrome.runtime.getContexts=async()=>[{contextType:'POPUP',documentUrl:sender.url,documentId:'live'}];
 const paused=await invoke({type:'PAUSE_AUTOMATION'},sender);assert.equal(paused.state,'paused');
 const running=await invoke({type:'RESUME_AUTOMATION',expectedRevision:paused.revision},sender);assert.equal(running.state,'running');
});

test('raw timeout does not hide a late native down from pause cleanup',async()=>{
 const env=environment(),backend=await backendFor(env),native=deferred();await backend.attach(params(undefined,{tabId:7}));
 env.chrome.debugger.sendCommand=async(target,method,command)=>{env.calls.push([method,command?.type]);if(method==='Input.dispatchMouseEvent'&&command.type==='mousePressed')await native.promise;return {}};
 await assert.rejects(backend.executeCdp(params(undefined,{target:{tabId:7},method:'Input.dispatchMouseEvent',commandParams:{type:'mousePressed',button:'left',x:5,y:5},timeoutMs:10})),/Timed out/);
 let finished=false;const pausing=backend.pauseAutomation().then(()=>{finished=true});await tick();assert.equal(finished,false);
 assert.equal(env.attached.has(7),true);assert.equal(env.calls.some(([method,type])=>method==='Input.dispatchMouseEvent'&&type==='mouseReleased'),false);
 native.resolve();await pausing;assert.equal(env.attached.size,0);assert.ok(env.calls.some(([method,type])=>method==='Input.dispatchMouseEvent'&&type==='mouseReleased'));
});

test('failed native release retains the same attachment for a confirmed retry',async()=>{
 const env=environment(),backend=await backendFor(env);await backend.attach(params(undefined,{tabId:7}));let fail=true;
 env.chrome.debugger.sendCommand=async(target,method,command)=>{if(fail&&method==='Input.dispatchMouseEvent'&&command.type==='mouseReleased')throw new Error('release failed');return {}};
 await backend.executeCdp(params(undefined,{target:{tabId:7},method:'Input.dispatchMouseEvent',commandParams:{type:'mousePressed',button:'left',x:5,y:5}}));
 const token=backend.attachmentEpochs.get(7);await assert.rejects(backend.pauseAutomation(),/release failed/);
 assert.equal(env.attached.has(7),true);assert.equal(backend.attachmentEpochs.get(7),token);assert.equal(env.storage[KEY].pendingTabIds[0],7);
 await assert.rejects(backend.resumeAutomation((await backend.getAutomationControlStatus()).revision),/PAUSE_INCOMPLETE/);
 fail=false;assert.equal((await backend.pauseAutomation()).state,'paused');assert.equal(env.attached.size,0);assert.deepEqual(env.storage[KEY].pendingTabIds,[]);
});

test('restart cannot convert an unfinished input release into an empty successful cleanup',async()=>{
 const env=environment({storage:{[KEY]:{version:1,paused:true,revision:4,pendingTabIds:[7]}}}),backend=await backendFor(env);
 assert.equal((await backend.getAutomationControlStatus()).state,'error');
 await assert.rejects(backend.pauseAutomation(),/INPUT_RELEASE_UNCONFIRMED/);
 env.tabs.delete(7);env.chrome.tabs.get=async()=>{throw new Error('No tab with id: 7')};
 assert.equal((await backend.pauseAutomation()).state,'paused');assert.deepEqual(env.storage[KEY].pendingTabIds,[]);
});

test('bootstrap racing pause cannot return a successor epoch',async()=>{
 const gate=deferred();let block=false;const env=environment({write:async value=>{if(block&&value.OPEN_BROWSER_USE_CONTROL_STATE){block=false;await gate.promise}}}),backend=await backendFor(env);
 block=true;const bootstrap=assert.rejects(backend.getControlState({session_id:'new-idle'}),/AUTOMATION_PAUSED/);await tick();
 const pausing=backend.pauseAutomation();gate.resolve();await Promise.all([bootstrap,pausing]);
 const old=backend.controlLedger.records.get('new-idle').epoch;
 await backend.resumeAutomation((await backend.getAutomationControlStatus()).revision);
 await assert.rejects(backend.nameSession({session_id:'new-idle',turn_id:'late',control_epoch:old-1,name:'bad'}),/STALE_CONTROL_EPOCH/);
});

test('an unsettled native input produces bounded failed pause without claiming release',async()=>{
 const env=environment(),backend=await backendFor(env,{automationCleanupTimeoutMs:30}),native=deferred();
 await backend.attach(params(undefined,{tabId:7}));
 env.chrome.debugger.sendCommand=async(target,method,command)=>{env.calls.push([method,command?.type]);if(method==='Input.dispatchMouseEvent'&&command.type==='mousePressed')await native.promise;return {}};
 await assert.rejects(backend.executeCdp(params(undefined,{target:{tabId:7},method:'Input.dispatchMouseEvent',commandParams:{type:'mousePressed',button:'left',x:5,y:5},timeoutMs:5})),/Timed out/);
 const started=Date.now();await assert.rejects(backend.pauseAutomation(),/PAUSE_FAILED.*CLEANUP_TIMEOUT/);
 assert.ok(Date.now()-started<1000);assert.equal(env.attached.has(7),true);assert.deepEqual(env.storage[KEY].pendingTabIds,[7]);
 assert.equal((await backend.getAutomationControlStatus()).state,'error');
 assert.equal(env.calls.some(([method,type])=>method==='Input.dispatchMouseEvent'&&type==='mouseReleased'),false);
 await assert.rejects(backend.resumeAutomation((await backend.getAutomationControlStatus()).revision),/PAUSE_INCOMPLETE/);
 native.resolve();await tick();assert.equal((await backend.pauseAutomation()).state,'paused');assert.equal(env.attached.size,0);
});

test('an unsettled attachment produces bounded failed pause and cannot initialize late',async()=>{
 const gate=deferred(),env=environment({attachGate:gate}),backend=await backendFor(env,{automationCleanupTimeoutMs:30});
 const attaching=assert.rejects(backend.attach(params(undefined,{tabId:7})),/AUTOMATION_PAUSED/);await tick();
 await assert.rejects(backend.pauseAutomation(),/PAUSE_FAILED.*CLEANUP_TIMEOUT/);
 assert.deepEqual(env.storage[KEY].pendingTabIds,[7]);assert.equal((await backend.getAutomationControlStatus()).inputBlocked,true);
 gate.resolve();await attaching;assert.equal(env.calls.some(([method])=>method==='Emulation.setFocusEmulationEnabled'),false);
 assert.equal((await backend.pauseAutomation()).state,'paused');assert.equal(env.attached.size,0);
});

test('pause cancels current and queued rendering even when native input release fails',async()=>{
 const env=environment(),backend=await backendFor(env),listeners=new Set();
 env.chrome.debugger.onEvent={addListener:callback=>listeners.add(callback),removeListener:callback=>listeners.delete(callback)};
 await backend.attach(params(undefined,{tabId:7}));
 let fail=true,executed=0;
 env.chrome.debugger.sendCommand=async(target,method,command)=>{
  if(method==='Page.startScreencast')queueMicrotask(()=>{for(const listener of listeners)listener(target,'Page.screencastFrame',{sessionId:1})});
  if(fail&&method==='Input.dispatchMouseEvent'&&command.type==='mouseReleased')throw new Error('release failed');return {};
 };
 await backend.executeCdp(params(undefined,{target:{tabId:7},method:'Input.dispatchMouseEvent',commandParams:{type:'mousePressed',button:'left',x:5,y:5}}));
 const current=assert.rejects(backend.withRenderingLease({tabId:7},500,()=>{executed++;return new Promise(()=>{})}),/cancelled because tab control ended/);
 await tick();const queued=assert.rejects(backend.withRenderingLease({tabId:7},500,()=>{executed++;return 'unexpected'}),/AUTOMATION_PAUSED/);
 await assert.rejects(backend.pauseAutomation(),/release failed/);await Promise.all([current,queued]);
 assert.equal(executed,1);assert.equal(listeners.size,0);assert.equal(env.attached.has(7),true);
 fail=false;assert.equal((await backend.pauseAutomation()).state,'paused');
});

test('a bound release cannot release or detach a replacement attachment',async()=>{
 const env=environment(),backend=await backendFor(env);await backend.attach(params(undefined,{tabId:7}));
 const old=backend.prepareInputRelease(7);await backend.detachTab(7);await backend.attach(params(undefined,{tabId:7}));
 await backend.executeCdp(params(undefined,{target:{tabId:7},method:'Input.dispatchMouseEvent',commandParams:{type:'mousePressed',button:'left',x:5,y:5}}));
 const mutations=()=>env.calls.filter(([method])=>method==='detach'||method.startsWith('Input.')).length;
 const current=backend.attachmentEpochs.get(7),count=mutations();assert.equal(old.isCurrent(),false);
 await old.release();await old.detach();assert.equal(mutations(),count);assert.equal(backend.attachmentEpochs.get(7),current);assert.equal(env.attached.has(7),true);
 await backend.pauseAutomation();
});

test('pause while startup storage loads has one serialized recovery transition',async()=>{
 const gate=deferred(),env=environment({read:async key=>{if(key===KEY)await gate.promise}}),backend=new env.BrowserBackend();
 const pausing=backend.pauseAutomation();gate.resolve();await Promise.all([pausing,backend.controlReady]);
 assert.equal((await backend.getAutomationControlStatus()).state,'paused');assert.equal(backend.automationControl.revision,1);
});

test('a stuck startup storage read returns failed pause status without waiting twice',async()=>{
 const gate=deferred(),env=environment({read:async key=>{if(key===KEY)await gate.promise}}),backend=new env.BrowserBackend({automationCleanupTimeoutMs:30});
 await assert.rejects(backend.pauseAutomation(),/CLEANUP_TIMEOUT/);
 assert.equal((await backend.getAutomationControlStatus()).state,'error');
 gate.resolve();await backend.controlReady;assert.equal((await backend.getAutomationControlStatus()).state,'error');
 assert.equal((await backend.pauseAutomation()).state,'paused');
});

test('end cannot expose the epoch retired by a concurrent pause after cleanup',async()=>{
 const env=environment(),backend=await backendFor(env),gate=deferred();const first=await backend.getControlState({session_id:'task'});
 const clear=backend.clearSessionActivity.bind(backend);let once=true;
 backend.clearSessionActivity=async sessionId=>{if(once){once=false;await gate.promise}return clear(sessionId)};
 const ending=assert.rejects(backend.turnEnded(params(first.controlEpoch)),/AUTOMATION_PAUSED/);await tick();
 const pausing=backend.pauseAutomation();gate.resolve();await Promise.all([ending,pausing]);assert.equal((await backend.getAutomationControlStatus()).state,'paused');
});

test('own extension tabs and pending navigation cannot be claimed or controlled',async()=>{
 const env=environment(),backend=await backendFor(env);
 for(const field of ['url','pendingUrl']){
  env.tabs.set(7,{id:7,groupId:10,windowId:1,url:'https://fixture.test',[field]:'chrome-extension://fixture/popup.html?x=1#control'});
  await assert.rejects(backend.claimUserTab(params(undefined,{tabId:7})),/EXTENSION_UI_PROTECTED/);
  await assert.rejects(backend.attach(params(undefined,{tabId:7})),/EXTENSION_UI_PROTECTED/);
  await assert.rejects(backend.browserAction(params(undefined,{tabId:7,action:'title'})),/EXTENSION_UI_PROTECTED/);
 }
 assert.equal(env.calls.some(([method])=>method==='attach'),false);
 env.tabs.set(7,{id:7,groupId:10,windowId:1,url:'https://fixture.test'});await backend.attach(params(undefined,{tabId:7}));
 for(const url of ['chrome-extension://fixture/popup.html','\tchrome-extension://fixture/popup.html?x#y']){
  await assert.rejects(backend.browserAction(params(undefined,{tabId:7,action:'goto',args:{url}})),/EXTENSION_UI_PROTECTED/);
  for(const method of ['Page.navigate','Target.createTarget'])await assert.rejects(backend.executeCdp(params(undefined,{target:{tabId:7},method,commandParams:{url}})),/EXTENSION_UI_PROTECTED/);
 }
 for(const url of ['https://fixture.test','data:text/html,fixture','chrome-extension://different-extension/page.html']){
  await backend.executeCdp(params(undefined,{target:{tabId:7},method:'Page.navigate',commandParams:{url}}));
 }
});

test('raw Target commands cannot tunnel across the proven root or reach its own UI',async()=>{
 const env=environment(),backend=await backendFor(env);await backend.attach(params(undefined,{tabId:7}));
 env.chrome.debugger.getTargets=async()=>[{id:'owned',tabId:7,url:'https://fixture.test'},{id:'foreign',tabId:8,url:'https://other.test'}];
 for(const method of ['Target.attachToTarget','Target.attachToBrowserTarget','Target.sendMessageToTarget']){
  await assert.rejects(backend.executeCdp(params(undefined,{target:{tabId:7},method,commandParams:{targetId:'foreign'}})),/CDP_TARGET_UNOWNED/);
 }
 for(const method of ['Target.closeTarget','Target.activateTarget','Target.getTargetInfo']){
  await assert.rejects(backend.executeCdp(params(undefined,{target:{tabId:7},method,commandParams:{targetId:'foreign'}})),/CDP_TARGET_UNOWNED/);
 }
 await backend.executeCdp(params(undefined,{target:{tabId:7},method:'Target.getTargetInfo',commandParams:{targetId:'owned'}}));
 await backend.executeCdp(params(undefined,{target:{tabId:7},method:'Target.setAutoAttach',commandParams:{autoAttach:true,flatten:true}}));
 env.chrome.debugger.getTargets=async()=>[{id:'own-ui',tabId:7,url:'chrome-extension://fixture/popup.html'}];
 await assert.rejects(backend.executeCdp(params(undefined,{target:{tabId:7},method:'Target.getTargetInfo',commandParams:{targetId:'own-ui'}})),/EXTENSION_UI_PROTECTED/);
 const inventory=await backend.executeCdp(params(undefined,{method:'Target.getTargets'}));assert.equal(inventory.targetInfos.length,0);
});

test('a notification validated before pause is suppressed in its final microtask',async()=>{
 const env=environment(),backend=await backendFor(env);await backend.attach(params(undefined,{tabId:7}));
 const notifications=[];let eventListener;
 env.chrome.debugger.onEvent.addListener=listener=>{eventListener=listener};
 const forwarding=source.slice(source.indexOf('chrome.debugger.onEvent.addListener((source, method, params) => {'),source.indexOf('backend.addDownloadChangeListener((change) => {'));
 const safeSend=source.slice(source.indexOf('function safeSendNotification(peer, method, params)'));
 vm.runInNewContext(`${forwarding}\n${safeSend}`,{chrome:env.chrome,backend,peer:{sendNotification:(method,params)=>notifications.push({method,params})}});
 eventListener({tabId:7},'Runtime.consoleAPICalled',{type:'log'});await tick();assert.equal(notifications.length,1);
 const metadata=backend.cdpEventMetadata.bind(backend);let pausing;
 backend.cdpEventMetadata=source=>metadata(source).then(value=>{queueMicrotask(()=>{pausing=backend.pauseAutomation()});return value});
 eventListener({tabId:7},'Runtime.consoleAPICalled',{type:'late'});await tick();await pausing;
 assert.equal(notifications.length,1);assert.equal((await backend.getAutomationControlStatus()).state,'paused');
});

test('initial status bounds a stuck storage read and a late running value cannot reopen admission',async()=>{
 const load=deferred(),env=environment({storage:{[KEY]:{version:1,paused:false,revision:3,pendingTabIds:[]}},read:async key=>{if(key===KEY)await load.promise}});
 const backend=new env.BrowserBackend({automationCleanupTimeoutMs:30}),started=Date.now();
 const failed=await backend.getAutomationControlStatus();assert.ok(Date.now()-started<1000);
 assert.equal(failed.state,'error');assert.equal(failed.inputBlocked,true);assert.equal(failed.cleanupComplete,false);assert.match(failed.error,/CLEANUP_TIMEOUT/);
 load.resolve();await backend.controlReady;assert.equal((await backend.getAutomationControlStatus()).state,'error');assert.equal(backend.automationControl.inputBlocked,true);
 await assert.rejects(backend.getControlState({session_id:'task'}),/AUTOMATION_PAUSED/);
 assert.equal((await backend.pauseAutomation()).state,'paused');assert.equal(env.storage[KEY].paused,true);
});

test('Resume and a queued Pause share entry deadlines while storage is stuck',async()=>{
 const storageGate=deferred(),entered=deferred();let delay=false;
 const env=environment({write:async value=>{if(delay&&value[KEY]?.paused===false){entered.resolve();await storageGate.promise}}}),backend=await backendFor(env,{automationCleanupTimeoutMs:30});
 const paused=await backend.pauseAutomation();delay=true;
 const resuming=assert.rejects(backend.resumeAutomation(paused.revision),/CLEANUP_TIMEOUT/);await entered.promise;
 const started=Date.now(),pausing=assert.rejects(backend.pauseAutomation(),/PAUSE_FAILED.*CLEANUP_TIMEOUT/);
 assert.equal(backend.automationControl.state,'pausing');assert.equal(backend.automationControl.cleanupComplete,false);
 await Promise.all([resuming,pausing]);assert.ok(Date.now()-started<1000);assert.equal((await backend.getAutomationControlStatus()).state,'error');
 await assert.rejects(backend.getControlState({session_id:'task'}),/AUTOMATION_PAUSED/);
 storageGate.resolve();await backend.automationControl.writes;await backend.automationTransitions.catch(()=>{});
 assert.equal(backend.automationControl.inputBlocked,true);assert.equal(env.storage[KEY].paused,true);
 assert.equal((await backend.pauseAutomation()).state,'paused');
});

test('a timed-out Resume queues durable paused repair and never unlocks on late completion',async()=>{
 const falseWrite=deferred(),trueWrite=deferred();let delay=false;
 const env=environment({write:async value=>{if(delay&&value[KEY])await(value[KEY].paused?trueWrite.promise:falseWrite.promise)}}),backend=await backendFor(env,{automationCleanupTimeoutMs:30});
 const paused=await backend.pauseAutomation();delay=true;
 await assert.rejects(backend.resumeAutomation(paused.revision),/CLEANUP_TIMEOUT/);
 falseWrite.resolve();await tick();assert.equal(env.storage[KEY].paused,false);
 assert.equal(backend.automationControl.inputBlocked,true);assert.equal((await backend.getAutomationControlStatus()).state,'error');
 await assert.rejects(backend.getControlState({session_id:'task'}),/AUTOMATION_PAUSED/);
 trueWrite.resolve();await backend.automationControl.writes;assert.equal(env.storage[KEY].paused,true);assert.equal(backend.automationControl.inputBlocked,true);
 delay=false;assert.equal((await backend.pauseAutomation()).state,'paused');
});

test('Resume timing out before startup load cannot overwrite unread pending recovery state',async()=>{
 const load=deferred(),stored={version:1,paused:true,revision:17,pendingTabIds:[7]};
 const env=environment({storage:{[KEY]:stored},read:async key=>{if(key===KEY)await load.promise}}),backend=new env.BrowserBackend({automationCleanupTimeoutMs:30});
 await assert.rejects(backend.resumeAutomation(17),/CLEANUP_TIMEOUT/);
 assert.deepEqual(env.storage[KEY],stored);assert.equal(env.calls.some(([method])=>method==='save'),false);
 load.resolve();await backend.controlReady;await tick();await backend.automationControl.writes;
 assert.deepEqual(env.storage[KEY],stored);assert.equal(backend.automationControl.inputBlocked,true);
 await assert.rejects(backend.pauseAutomation(),/INPUT_RELEASE_UNCONFIRMED/);
 assert.deepEqual(env.storage[KEY].pendingTabIds,[7]);
});

test('CRX Runtime mutation commands are blocked by both pause and attachment release',async()=>{
 let hooks;const env=environment({createBrowserActionEngine:value=>{hooks=value;return {}}}),backend=await backendFor(env);
 await backend.attach(params(undefined,{tabId:7}));await backend.getBrowserEngine();let sent=0;
 const runtimeMutation=()=>hooks.inputHooks.send({tabId:7},'Runtime.callFunctionOn',{},async()=>{sent++});
 await runtimeMutation();assert.equal(sent,1);
 await backend.releaseTrackedInput(7);
 assert.throws(runtimeMutation,/RELEASE_IN_PROGRESS/);assert.equal(sent,1);
 backend.automationControl.block();assert.throws(runtimeMutation,/AUTOMATION_PAUSED/);assert.equal(sent,1);
});

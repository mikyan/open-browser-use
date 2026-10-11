import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import vm from "./test-support/backend-vm.mjs";
import test from "node:test";
import { BrowserActionEngine } from "./browser-action-engine.js";

const source = (await readFile(new URL("./background.js", import.meta.url), "utf8"))
  .replace('import { createBrowserActionEngine } from "./browser-runtime.js";', "").replace('import { NativeInputTracker } from "./browser-input-adapter.js";', (await readFile(new URL("./browser-input-adapter.js", import.meta.url), "utf8")).replace(/^export /gm, "") + "\nglobalThis.performance ??= { now: () => Date.now() };");
const code = source.slice(0, source.indexOf("chrome.runtime.onInstalled.addListener"));
const clone = value => JSON.parse(JSON.stringify(value));
const tick = () => new Promise(resolve => setTimeout(resolve, 0));
const deferred = () => { let resolve, reject; const promise = new Promise((done, fail) => { resolve = done; reject = fail; }); return { promise, resolve, reject }; };
const params = (turn = "first", extra = {}) => ({ session_id: "task", turn_id: turn, ...extra });

function environment({ attachGate, storage = {}, write, downloads } = {}) {
  const calls = [], attached = new Set(), tabs = new Map([[7, { id: 7, groupId: 10, windowId: 1, url: "https://fixture.test" }]]);
  const events = {};
  const chrome = {
    downloads,
    storage: { local: {
      async get(key) { return Object.hasOwn(storage, key) ? { [key]: clone(storage[key]) } : {}; },
      async set(value) { await write?.(value); Object.assign(storage, clone(value)); calls.push(["save", Object.keys(value)[0]]); }
    } },
    debugger: {
      onDetach: { addListener() {} }, onEvent: { addListener() {}, removeListener() {} },
      async attach({ tabId }) { calls.push(["attach", tabId]); await attachGate?.promise; attached.add(tabId); },
      async detach({ tabId }) { calls.push(["detach", tabId]); attached.delete(tabId); },
      async sendCommand(target, method) { calls.push([method, target.tabId]); return {}; }
    },
    tabs: {
      onUpdated: { addListener(listener) { events.updated = listener; } },
      onDetached: { addListener(listener) { events.detached = listener; } },
      onReplaced: { addListener(listener) { events.replaced = listener; } },
      async query(filter) { return [...tabs.values()].filter(tab => filter?.groupId === undefined || tab.groupId === filter.groupId); },
      async remove(ids) { for (const id of Array.isArray(ids) ? ids : [ids]) tabs.delete(id); },
      async ungroup(ids) { for (const id of Array.isArray(ids) ? ids : [ids]) tabs.get(id).groupId = -1; },
      async sendMessage() { return {}; }
    },
    tabGroups: { async update() {} }
  };
  const createBrowserActionEngine = hooks => {
    const attached = new Set(), pending = new Map();
    return {
      async attach(tabId) {
        if (attached.has(tabId)) return;
        if (pending.has(tabId)) return pending.get(tabId);
        const operation = (async () => { await hooks.onBeforeAttach(tabId);await chrome.debugger.attach({tabId});await hooks.onAttached(tabId);attached.add(tabId); })();
        pending.set(tabId,operation);try { await operation; } finally { pending.delete(tabId); }
      },
      async detach(tabId) { attached.delete(tabId);await chrome.debugger.detach({tabId});await hooks.onDetached(tabId); },
      forget(tabId) { attached.delete(tabId); }
    };
  };
  const classes = vm.runInNewContext(`${code}\n({BrowserBackend,ControlLedger,JsonRpcPeer});`, { chrome, Date, setTimeout, clearTimeout, crypto, createBrowserActionEngine });
  return { ...classes, chrome, calls, tabs, attached, storage, events };
}

async function backendFor(env) {
  const backend = new env.BrowserBackend();
  await backend.controlReady;
  const session = await backend.store.getSession("task");
  session.chromeGroupId = 10;
  session.tabOrigins = { 7: "agent" };
  await backend.store.save();
  return backend;
}


async function twoSessions() {
  const env = environment(), backend = await backendFor(env);
  env.tabs.set(8, { id: 8, groupId: 20, windowId: 1 });
  const other = await backend.store.getSession("other");other.chromeGroupId=20;other.tabOrigins={8:"agent"};await backend.store.save();
  const commands=[];env.chrome.debugger.sendCommand=async(target,method,commandParams)=>{commands.push({target,method,commandParams});return method === "DOM.resolveNode" ? { object: { objectId: "exact-node" } } : method === "Runtime.callFunctionOn" ? { result: { value: 0 } } : {}};
  return {...env,backend,commands};
}
const task=(tabId=7,extra={})=>params('files',{tabId,...extra});
const other=(extra={})=>({session_id:'other',turn_id:'files',tabId:8,...extra});
const begin=(backend,tabId,guid)=>backend.handleCdpEvent({tabId},'Page.downloadWillBegin',{guid,frameId:'root',url:'https://identical.fixture/download',suggestedFilename:'same.txt'});
const progress=(backend,tabId,guid)=>backend.handleCdpEvent({tabId},'Page.downloadProgress',{guid,state:'completed',receivedBytes:20,totalBytes:20});

test('download waits use native tab identity and GUID, never global cache or identical URL',async()=>{
 const {backend}=await twoSessions();
 const a=backend.waitForDownload(task()),b=backend.waitForDownload(other());await tick();
 backend.handleDownloadCreated({id:99,filename:'foreign.txt',url:'https://identical.fixture/download'});
 backend.handleDownloadChanged({id:99,state:{current:'complete'}});
 assert.equal(backend.downloadsById.size,0);
 begin(backend,8,'guid-b');begin(backend,7,'guid-a');
 assert.equal((await a).downloadId,'guid-a');assert.equal((await b).downloadId,'guid-b');
 await assert.rejects(backend.downloadPath(other({downloadId:'guid-a'})),/Unknown or unowned/);
 await assert.rejects(backend.downloadPath(task(7,{downloadId:'guid-a'})),/OBU_DOWNLOAD_PATH_UNAVAILABLE/);
 const newer=assert.rejects(backend.waitForDownload(task(7,{timeoutMs:20})),/OBU_TRANSFER_TIMEOUT/);await newer;
});

test('turn end cancels download and chooser waits and prevents late event resurrection',async()=>{
 const {backend}=await twoSessions();
 const download=assert.rejects(backend.waitForDownload(task()),/OBU_TRANSFER_CANCELLED/);
 const chooser=assert.rejects(backend.waitForFileChooser(task()),/OBU_TRANSFER_CANCELLED/);
 await tick();await backend.turnEnded(params('end'));await Promise.all([download,chooser]);
 begin(backend,7,'late');assert.equal(backend.downloadWaiters.size,0);assert.equal(backend.downloadsById.size,0);assert.equal(backend.fileChooserWaitersByTabId.size,0);
});

test('a child chooser preserves native session routing, permits clear, and rejects a foreign caller',async()=>{
 const {backend,commands}=await twoSessions();await backend.getBrowserEngine();await backend.attach(task());
 backend.handleCdpEvent({tabId:7},'Target.attachedToTarget',{sessionId:'child',targetInfo:{type:'iframe'}});
 const pending=backend.waitForFileChooser(task());await tick();
 backend.handleCdpEvent({tabId:7,sessionId:'child'},'Page.fileChooserOpened',{backendNodeId:123,mode:'selectSingle',frameId:'frame-child'});
 const chooser=await pending;
 await assert.rejects(backend.setFileChooserFiles({...other(),fileChooserId:chooser.fileChooserId,files:[]}),/Unknown or unowned/);
 await backend.setFileChooserFiles({...task(),fileChooserId:chooser.fileChooserId,files:[]});
 const command=commands.find(call=>call.method==='DOM.resolveNode');
 assert.equal(command.target.sessionId,'child');assert.equal(command.commandParams.backendNodeId,123);assert.ok(commands.some(call=>call.method==='Runtime.callFunctionOn'&&call.target.sessionId==='child'&&call.commandParams.objectId==='exact-node'));
 assert.ok(commands.some(call=>call.target.sessionId==='child'&&call.method==='Page.setInterceptFileChooserDialog'&&call.commandParams.enabled));
});

test('navigation invalidates a chooser backend node before file input dispatch',async()=>{
 const {backend,commands}=await twoSessions();const pending=backend.waitForFileChooser(task());await tick();
 backend.handleCdpEvent({tabId:7},'Page.fileChooserOpened',{backendNodeId:123,mode:'selectSingle',frameId:'root'});
 const chooser=await pending;backend.handleCdpEvent({tabId:7},'Page.frameNavigated',{frame:{id:'root'}});
 await assert.rejects(backend.setFileChooserFiles({...task(),fileChooserId:chooser.fileChooserId,files:['fixture.txt']}),/Unknown or unowned/);
 assert.equal(commands.some(call=>call.method==='DOM.setFileInputFiles'),false);
});

test('old chooser cleanup cannot disable a successor attachment interception',async()=>{
 const {backend,commands,chrome}=await twoSessions(),gate=deferred();
 chrome.debugger.sendCommand=async(target,method,commandParams)=>{commands.push({target,method,commandParams});if(method==='Page.setInterceptFileChooserDialog'&&commandParams.enabled)await gate.promise;return {}};
 const first=assert.rejects(backend.waitForFileChooser(task()),/OBU_TRANSFER_CANCELLED/);await tick();
 // A native enable must settle before capacity can be reused. An externally
 // destroyed attachment does not license an old disable on its successor.
 backend.browserEngine.forget(7);backend.releaseEngineAttachment(7);await first;
 await assert.rejects(backend.waitForFileChooser(task()),/OBU_FILE_CHOOSER_WAIT_LIMIT/);
 gate.resolve();await tick();
 chrome.debugger.sendCommand=async(target,method,commandParams)=>{commands.push({target,method,commandParams});return method === "DOM.resolveNode" ? { object: { objectId: "exact-node" } } : method === "Runtime.callFunctionOn" ? { result: { value: 0 } } : {}};
 const second=backend.waitForFileChooser(task());await tick();const checkpoint=commands.length;await tick();
 assert.equal(commands.slice(checkpoint).some(call=>call.method==='Page.setInterceptFileChooserDialog'&&!call.commandParams.enabled),false);
 backend.handleCdpEvent({tabId:7},'Page.fileChooserOpened',{backendNodeId:456,mode:'selectSingle'});await second;
});

test('unknown and stale CDP event sources have no outbound metadata',async()=>{
 const {backend,tabs}=await twoSessions();assert.equal(await backend.cdpEventMetadata({tabId:7}),null);
 await backend.attach(task());const metadata=await backend.cdpEventMetadata({tabId:7});assert.equal(metadata.session_id,'task');assert.ok(metadata.control_epoch>0);
 tabs.get(7).groupId=20;assert.equal(await backend.cdpEventMetadata({tabId:7}),null);
});

test('download progress uses the same proven source and bounded records',async()=>{
 const {backend}=await twoSessions(),events=[];backend.addDownloadChangeListener(change=>events.push(change));
 const pending=backend.waitForDownload(task());await tick();begin(backend,7,'owned');progress(backend,8,'owned');await pending;
 assert.notEqual(backend.downloadsById.get('owned').status,'complete');progress(backend,7,'owned');await tick();
 assert.equal(events.at(-1).status,'complete');assert.equal(events.at(-1).session_id,'task');assert.equal(events.at(-1).tabId,7);assert.ok(events.at(-1).control_epoch>0);
});

test('download progress revalidates live ownership, not just the surviving attachment', async () => {
  const { backend, tabs } = await twoSessions(), events = [];
  backend.addDownloadChangeListener(change => events.push(change));
  const pending = backend.waitForDownload(task()); await tick(); begin(backend, 7, 'moved'); await pending;
  events.length = 0; tabs.get(7).groupId = 20;
  progress(backend, 7, 'moved'); await tick();
  assert.deepEqual(events, []); assert.equal(backend.downloadsById.has('moved'), false);
});

test('old progress validation cannot publish over a newer state or replaced record', async () => {
  const { backend } = await twoSessions(), events = [], gate = deferred();
  backend.addDownloadChangeListener(change => events.push(change));
  const pending = backend.waitForDownload(task()); await tick(); begin(backend, 7, 'ordered'); await pending;
  const original = backend.validateTransferScope.bind(backend); let first = true;
  backend.validateTransferScope = async scope => { if (first) { first = false; await gate.promise; } return original(scope); };
  events.length = 0;
  backend.handleCdpEvent({tabId:7}, 'Page.downloadProgress', {guid:'ordered',state:'inProgress'});
  progress(backend, 7, 'ordered'); await tick(); gate.resolve(); await tick();
  assert.deepEqual(events.map(event => event.status), ['complete']);
  const replacementGate = deferred(); backend.validateTransferScope = async () => replacementGate.promise;
  progress(backend,7,'ordered'); const replacement = { ...backend.downloadsById.get('ordered'), status:'started' };
  backend.downloadsById.set('ordered',replacement); replacementGate.resolve(); await tick();
  assert.equal(replacement.status,'started'); assert.equal(events.length,1);
});

async function directEnvironment() {
  const native = [], items = new Map(); let id = 0;
  const downloads = {
    async download(options) { native.push(['download', options]); const next = ++id;items.set(next,{id:next,state:'complete',danger:'safe',filename:`C:\\Downloads\\${next}.csv`});return next; },
    async search(query) { native.push(['search',query]);return items.has(query.id) ? [items.get(query.id)] : []; },
    async cancel(value) { native.push(['cancel',value]); }
  };
  const env = environment({downloads}), backend = await backendFor(env);
  const state = await backend.getControlState(params('direct'));
  const direct = {...params('direct'),control_epoch:state.controlEpoch,tabId:7,url:'https://fixture.test/file'};
  return {...env,backend,direct,native,items};
}

test('cold direct download and later engine attachment retain the same exact handle', async () => {
  const {backend,direct,native}=await directEnvironment();
  // Exercise raw-to-engine migration, then reuse that engine for another action.
  await backend.attach(direct);
  const result=await backend.downloadURL(direct);
  await (await backend.getBrowserEngine()).attach(7);
  assert.equal((await backend.downloadPath({...direct,...result})).path,'C:\\Downloads\\1.csv');
  assert.deepEqual(native.filter(([method])=>method==='search'),[['search',{id:1}]]);
  await backend.turnEnded(direct);
  assert.deepEqual(native.at(-1),['cancel',1]);
});

test('first download by a proven new owner preserves only its own unbound setup', async () => {
  const {backend,direct,tabs,native}=await directEnvironment();
  await backend.attach(direct);
  const next=await backend.store.getSession('other');next.chromeGroupId=20;next.tabOrigins={7:'user'};await backend.store.save();
  tabs.get(7).groupId=20;
  const state=await backend.getControlState({session_id:'other',turn_id:'direct'});
  const params={...direct,session_id:'other',control_epoch:state.controlEpoch};
  const result=await backend.downloadURL(params);
  assert.equal((await backend.downloadPath({...params,...result})).path,'C:\\Downloads\\1.csv');
  assert.equal(native.filter(([method])=>method==='download').length,1);
});

test('explicit download is isolated from native Page waiters and guessed numeric IDs', async () => {
  const {backend,direct}=await directEnvironment();
  const handle=await backend.downloadURL(direct);
  const waiting=assert.rejects(backend.waitForDownload({...direct,timeoutMs:15}),/OBU_TRANSFER_TIMEOUT/);
  await backend.downloadPath({...direct,...handle});await waiting;
  await assert.rejects(backend.downloadPath({...direct,downloadId:'1'}),/OBU_DOWNLOAD_EXPIRED/);
  await backend.cancelDownload({...direct,...handle});
  await assert.rejects(backend.downloadPath({...direct,...handle}),/OBU_DOWNLOAD_EXPIRED/);
});

test('group movement invalidates transfers immediately and cancels only direct native IDs', async () => {
  const {backend,direct,events,tabs,native}=await directEnvironment();
  const handle=await backend.downloadURL(direct);
  tabs.get(7).groupId=20;events.updated(7,{groupId:20});await tick();
  assert.deepEqual(native.at(-1),['cancel',1]);
  await assert.rejects(backend.downloadPath({...direct,...handle}),/OBU_DOWNLOAD_EXPIRED/);
});

test('detach failure keeps its real cleanup barrier until delayed native detach settles', async () => {
  const {backend,direct,chrome}=await directEnvironment(),gate=deferred();
  await backend.downloadURL(direct);
  chrome.downloads.cancel=async()=>{throw new Error('cancel failed');};
  chrome.debugger.detach=async()=>gate.promise;
  const first=backend.detachTab(7);const rejected=assert.rejects(first,/cancel failed/);
  await tick();assert.equal(backend.controlReleases.get(7),first);
  const second=backend.detachTab(7);const secondRejected=assert.rejects(second,/cancel failed/);
  assert.equal(backend.controlReleases.get(7),second);
  gate.resolve();await rejected;await secondRejected;
  assert.equal(backend.controlReleases.has(7),false);
  chrome.downloads.cancel=async()=>{};await backend.detachTab(7);
  assert.equal(backend.directDownloads.records.size,0);
});

test('Pause does not report cleanup complete while a native direct start is still unresolved', async () => {
  const {backend,direct,chrome,native}=await directEnvironment(),gate=deferred();
  backend.automationCleanupTimeoutMs=25;
  chrome.downloads.download=()=>gate.promise;
  const starting=assert.rejects(backend.downloadURL(direct),/OBU_DOWNLOAD_EXPIRED|OBU_AUTOMATION_PAUSED/);
  await tick();await assert.rejects(backend.pauseAutomation(),/OBU_AUTOMATION_PAUSE_FAILED/);await starting;
  const failed=await backend.getAutomationControlStatus();
  assert.equal(failed.state,'error');assert.equal(failed.cleanupComplete,false);assert.ok(backend.directDownloads.controlSnapshot().pending.length);
  gate.resolve(81);await tick();
  const paused=await backend.pauseAutomation();
  assert.equal(paused.state,'paused');assert.equal(paused.cleanupComplete,true);assert.deepEqual(native.at(-1),['cancel',81]);
});

test('new direct setup waits for prior native cleanup and does not start after its own deadline', async () => {
  const {backend,direct,native,calls}=await directEnvironment(),gate=deferred();
  backend.controlReleases.set(7,gate.promise);
  await assert.rejects(backend.downloadURL({...direct,timeoutMs:15}),/OBU_DOWNLOAD_TIMEOUT|OBU_TRANSFER_TIMEOUT/);
  assert.equal(calls.some(([name])=>name==='attach'),false);assert.deepEqual(native,[]);
  gate.resolve();await tick();assert.deepEqual(native,[]);
});

test('retired cold setup cannot attach after asynchronous engine lookup', async () => {
  const {backend,direct,native,calls}=await directEnvironment(),gate=deferred();
  const engine=await backend.getBrowserEngine();backend.getBrowserEngine=async()=>{await gate.promise;return engine;};
  const starting=assert.rejects(backend.downloadURL(direct),/OBU_DOWNLOAD_EXPIRED/);
  await tick();await backend.directDownloads.invalidateTab(7);gate.resolve();await starting;await tick();
  assert.equal(calls.some(([name])=>name==='attach'),false);assert.deepEqual(native,[]);
});

test('explicit detach during owner migration cancels its previously preserved download reservation', async () => {
  const {backend,direct,tabs,chrome,native}=await directEnvironment(),gate=deferred();
  await backend.attach(direct);
  const next=await backend.store.getSession('other');next.chromeGroupId=20;next.tabOrigins={7:'user'};await backend.store.save();
  tabs.get(7).groupId=20;
  const state=await backend.getControlState({session_id:'other',turn_id:'direct'});
  const params={...direct,session_id:'other',control_epoch:state.controlEpoch};
  chrome.debugger.detach=async()=>gate.promise;
  const starting=assert.rejects(backend.downloadURL(params),/OBU_DOWNLOAD_EXPIRED/);
  await tick();assert.ok(backend.controlReleases.has(7));
  const detached=backend.detach(params);await tick();gate.resolve();
  await detached;await starting;await tick();
  assert.equal(native.some(([method])=>method==='download'),false);
  assert.equal(backend.directDownloads.records.size,0);
});

test('transfer deadlines reject invalid values before touching the browser',async()=>{
 const {backend,commands}=await twoSessions();for(const timeoutMs of [0,-1,1.5,120001,null,'10']){
 await assert.rejects(backend.waitForDownload(task(7,{timeoutMs})),/timeoutMs/);
 await assert.rejects(backend.waitForFileChooser(task(7,{timeoutMs})),/timeoutMs/);
 }assert.equal(commands.length,0);
});

test('a regrouped tab must release its old attachment before the new session attaches',async()=>{
 const {backend,tabs,calls}=await twoSessions();await backend.attach(task());const oldToken=backend.attachmentEpochs.get(7);
 tabs.get(7).groupId=20;
 await assert.rejects(backend.executeCdp({...other(),target:{tabId:7},method:'Runtime.evaluate',commandParams:{expression:'1'}}),/attach again/);
 await backend.attach({...other(),tabId:7});
 assert.notEqual(backend.attachmentEpochs.get(7),oldToken);assert.equal(backend.attachmentOwners.get(7).session_id,'other');
 assert.deepEqual(calls.filter(call=>['attach','detach'].includes(call[0])).map(call=>call[0]),['attach','detach','attach']);
 await assert.rejects(backend.attach(task()),/not part of browser session/);
});

test('an ownership transfer rechecks the group after the old release settles',async()=>{
 const {backend,tabs,chrome}=await twoSessions();await backend.attach(task());tabs.get(7).groupId=20;
 const gate=deferred(),detach=chrome.debugger.detach;chrome.debugger.detach=async target=>{await gate.promise;return detach(target)};
 const transferring=assert.rejects(backend.attach({...other(),tabId:7}),/not part of browser session/);await tick();
 tabs.get(7).groupId=10;gate.resolve();await transferring;
 assert.equal(backend.attachedTabs.has(7),false);
 await backend.attach(task());assert.equal(backend.attachmentOwners.get(7).session_id,'task');
});

test('browserAction waits for chooser setup ACK and keeps its original deadline',async()=>{
 const {backend,chrome}=await twoSessions(),gate=deferred();
 const engine=await backend.getBrowserEngine();let dispatched=false,received;
 engine.dispatch=async action=>{dispatched=true;received=action;backend.handleCdpEvent({tabId:7},'Page.fileChooserOpened',{backendNodeId:1,mode:'selectSingle'});return {value:null}};
 const original=chrome.debugger.sendCommand;chrome.debugger.sendCommand=async(target,method,commandParams)=>{if(method==='Page.setInterceptFileChooserDialog'&&commandParams.enabled)await gate.promise;return original(target,method,commandParams)};
 const chooser=backend.waitForFileChooser(task());
 const action=backend.browserAction({...task(),action:'click',locator:[{kind:'css',selector:'input'}],timeoutMs:1000});
 await new Promise(resolve=>setTimeout(resolve,20));assert.equal(dispatched,false);gate.resolve();await Promise.all([chooser,action]);
 assert.ok(received.timeoutMs<1000&&received.timeoutMs>0);
});

for (const method of ['waitForFileChooser', 'waitForDownload']) {
  test(`${method} timeout fences its late native attachment before a successor`, async () => {
    const env = environment(), backend = await backendFor(env), gate = deferred(), entered = deferred();
    const previousChrome = globalThis.chrome;
    globalThis.chrome = { tabs: { get: async () => ({ incognito: false }) } };
    let first = true;
    const app = {
      async attach(tabId) { if (first) { first = false; entered.resolve(); await gate.promise; } env.attached.add(tabId); return {}; },
      async detach(tabId) { env.attached.delete(tabId); }
    };
    const engine = new BrowserActionEngine({
      loadRuntime: async () => ({ crx: { start: async () => app }, setOpenBrowserUseEventFilter() {}, setOpenBrowserUseCommandObserver() {} }),
      onBeforeAttach: tabId => backend.prepareEngineAttachment(tabId),
      onAttached: tabId => backend.registerEngineAttachment(tabId),
      onDetached: tabId => backend.releaseEngineAttachment(tabId)
    });
    backend.browserEngine = engine;
    try {
      const expired = assert.rejects(backend[method](task(7, { timeoutMs: 30 })), /OBU_TRANSFER_TIMEOUT/);
      await entered.promise;
      await expired;
      assert.equal(engine.generations.get(7), 1);
      assert.equal(engine.releases.has(7), true);
      const release = engine.releases.get(7);
      // The successor must wait for the old native attach to be cleaned up.
      const successor = backend[method](task(7, { timeoutMs: 1000 }));
      gate.resolve();
      await release.catch(() => {});
      for (let attempt = 0; attempt < 20; attempt++) {
        if (method === 'waitForFileChooser' ? backend.fileChooserWaitersByTabId.get(7)?.state === 'pending' : backend.downloadWaiters.size) break;
        await tick();
      }
      if (method === 'waitForFileChooser') backend.handleCdpEvent({ tabId: 7 }, 'Page.fileChooserOpened', { backendNodeId: 123, mode: 'selectSingle' });
      else begin(backend, 7, 'successor-guid');
      await successor;
      assert.equal(env.attached.has(7), true);
      assert.equal(backend.attachedTabs.has(7), true);
      assert.equal(engine.generations.get(7), 1);
      await engine.detach(7);
    } finally { gate.resolve(); globalThis.chrome = previousChrome; }
  });
}

async function chooserReadyEnvironment() {
  const env = await twoSessions();
  const control = await env.backend.getControlState(task());
  return { ...env, scope: { ...task(), control_epoch: control.controlEpoch } };
}
const chooserEvent = (backend, sessionId, backendNodeId = 51) => backend.handleCdpEvent({ tabId: 7, ...(sessionId ? { sessionId } : {}) },
  "Page.fileChooserOpened", { frameId: sessionId ? "child-frame" : "root-frame", backendNodeId, mode: "selectSingle" });

test("new public chooser readiness completes before the trigger and legacy waits share its capacity", async () => {
  const { backend, scope, commands } = await chooserReadyEnvironment();
  const ack = await backend.armFileChooserWait({ ...scope, timeoutMs: 1000 });
  assert.equal(typeof ack.waiterId, "string"); assert.ok(ack.remainingMs > 0 && ack.remainingMs <= 1000);
  assert.ok(commands.some(call => call.method === "Page.setInterceptFileChooserDialog" && call.commandParams.enabled));
  await assert.rejects(backend.waitForFileChooser(scope), /WAIT_LIMIT/);
  chooserEvent(backend); const chooser = await backend.collectFileChooserWait({ ...scope, waiterId: ack.waiterId });
  assert.equal(chooser.isMultiple, false);
  await backend.setFileChooserFiles({ ...scope, fileChooserId: chooser.fileChooserId, files: ["fixture.bin"] });
  assert.equal(commands.find(call => call.method === "DOM.setFileInputFiles").commandParams.backendNodeId, 51);
  await assert.rejects(backend.collectFileChooserWait({ ...scope, waiterId: ack.waiterId }), /EXPIRED/);
});

test("new chooser schema rejects malformed arm/collect/cancel before touching Chrome", async () => {
  const { backend, scope, commands } = await chooserReadyEnvironment(); commands.length = 0;
  await assert.rejects(backend.armFileChooserWait({ ...scope, extra: true }), /does not support/);
  await assert.rejects(backend.armFileChooserWait({ ...scope, control_epoch: undefined }), /control_epoch/);
  await assert.rejects(backend.collectFileChooserWait({ ...scope, waiterId: "unknown", timeoutMs: 1 }), /does not support/);
  await assert.rejects(backend.cancelFileChooserWait({ ...scope, waiterId: "unknown", timeoutMs: 1 }), /does not support/);
  assert.deepEqual(commands, []);
});

test("new chooser arm keeps its admission deadline while control bootstrap is blocked", async () => {
  const { backend, scope, commands } = await chooserReadyEnvironment(), gate = deferred();
  backend.controlReady = gate.promise;
  await assert.rejects(backend.armFileChooserWait({ ...scope, timeoutMs: 20 }), /WAIT_TIMEOUT/);
  gate.resolve(); await tick(); assert.equal(commands.some(call => call.method === "Page.setInterceptFileChooserDialog"), false);
  assert.equal(backend.fileChooserWaits.records.size, 0);
});

for (const order of ["swap-before-commit", "commit-before-swap"]) test(`dynamic OOPIF ${order} joins readiness before browser input`, async () => {
  const { backend, scope, chrome, commands } = await chooserReadyEnvironment(), gate = deferred();
  const ack = await backend.armFileChooserWait({ ...scope, timeoutMs: 1000 });
  backend.handleCdpEvent({ tabId: 7 }, "Page.frameAttached", { frameId: "child-frame", parentFrameId: "root-frame" });
  const swap = () => backend.handleCdpEvent({ tabId: 7 }, "Page.frameDetached", { frameId: "child-frame", reason: "swap" });
  if (order === "swap-before-commit") swap();
  const original = chrome.debugger.sendCommand;
  chrome.debugger.sendCommand = async (target, method, args) => {
    if (target.sessionId === "dynamic" && method === "Page.setInterceptFileChooserDialog" && args.enabled) await gate.promise;
    return original(target, method, args);
  };
  backend.handleCdpEvent({ tabId: 7 }, "Target.attachedToTarget", { sessionId: "dynamic", targetInfo: { type: "iframe", targetId: "child-frame", parentFrameId: "root-frame" } });
  backend.handleCdpEvent({ tabId: 7, sessionId: "dynamic" }, "Page.frameNavigated", { frame: { id: "child-frame", parentId: "root-frame", loaderId: "initial-loader", url: "https://child.fixture" } });
  if (order === "commit-before-swap") swap();
  let dispatched = false;
  backend.browserEngine.dispatch = async () => { dispatched = true; chooserEvent(backend, "dynamic"); return { value: null }; };
  const action = backend.browserAction({ ...scope, action: "click", locator: [{ kind: "css", selector: "input" }], timeoutMs: 1000 });
  await tick(); assert.equal(dispatched, false);
  gate.resolve(); await action;
  const chooser = await backend.collectFileChooserWait({ ...scope, waiterId: ack.waiterId });
  await backend.setFileChooserFiles({ ...scope, fileChooserId: chooser.fileChooserId, files: ["child.bin"] });
  assert.equal(commands.find(call => call.method === "DOM.setFileInputFiles").target.sessionId, "dynamic");
});

test("dynamic OOPIF initialization cannot exempt a second navigation, swap, or real removal", async () => {
  for (const invalidation of ["navigation", "swap", "remove", "wrong-parent-source", "reattach"]) {
    const { backend, scope } = await chooserReadyEnvironment();
    const ack = await backend.armFileChooserWait({ ...scope, timeoutMs: 1000 });
    const root = { tabId: 7 }, child = { tabId: 7, sessionId: "dynamic" };
    const attach = () => backend.handleCdpEvent(root, "Page.frameAttached", { frameId: "child-frame", parentFrameId: "root-frame" });
    const navigate = loaderId => backend.handleCdpEvent(child, "Page.frameNavigated", { frame: { id: "child-frame", parentId: "root-frame", loaderId, url: "https://child.fixture" } });
    attach();
    backend.handleCdpEvent(root, "Target.attachedToTarget", { sessionId: "dynamic", targetInfo: { type: "iframe", targetId: "child-frame", parentFrameId: "root-frame" } });
    navigate("initial-loader");
    if (invalidation !== "wrong-parent-source") backend.handleCdpEvent(root, "Page.frameDetached", { frameId: "child-frame", reason: "swap" });
    assert.equal(backend.fileChooserWaits.records.get(ack.waiterId).invalid, undefined);
    if (invalidation === "reattach") attach();
    if (["navigation", "reattach"].includes(invalidation)) navigate("replacement-loader");
    else backend.handleCdpEvent(invalidation === "wrong-parent-source" ? child : root, "Page.frameDetached", { frameId: "child-frame", reason: invalidation === "remove" ? "remove" : "swap" });
    await assert.rejects(backend.collectFileChooserWait({ ...scope, waiterId: ack.waiterId }), /EXPIRED/, invalidation);
    await backend.cancelFileChooserWait({ ...scope, waiterId: ack.waiterId });
  }
});

test("a new child session grants no initialization exemption without matching frame and parent identities", async () => {
  for (const mismatch of ["no-frame-attach", "target-frame", "target-parent", "target-source", "navigation-source", "navigation-parent"]) {
    const { backend, scope } = await chooserReadyEnvironment();
    const ack = await backend.armFileChooserWait({ ...scope, timeoutMs: 1000 });
    if (mismatch !== "no-frame-attach") backend.handleCdpEvent({ tabId: 7 }, "Page.frameAttached", { frameId: "child-frame", parentFrameId: "root-frame" });
    backend.handleCdpEvent({ tabId: 7, ...(mismatch === "target-source" ? { sessionId: "wrong" } : {}) }, "Target.attachedToTarget",
      { sessionId: "dynamic", targetInfo: { type: "iframe", targetId: mismatch === "target-frame" ? "other-frame" : "child-frame", parentFrameId: mismatch === "target-parent" ? "other-parent" : "root-frame" } });
    backend.handleCdpEvent({ tabId: 7, sessionId: mismatch === "navigation-source" ? "wrong" : "dynamic" }, "Page.frameNavigated",
      { frame: { id: "child-frame", parentId: mismatch === "navigation-parent" ? "other-parent" : "root-frame", loaderId: "initial-loader", url: "https://child.fixture" } });
    await assert.rejects(backend.collectFileChooserWait({ ...scope, waiterId: ack.waiterId }), /EXPIRED/, mismatch);
    await backend.cancelFileChooserWait({ ...scope, waiterId: ack.waiterId });
  }
});

test("a delayed initial parent swap cannot exempt a chooser that has already matched", async () => {
  const { backend, scope } = await chooserReadyEnvironment();
  const ack = await backend.armFileChooserWait({ ...scope, timeoutMs: 1000 });
  backend.handleCdpEvent({ tabId: 7 }, "Page.frameAttached", { frameId: "child-frame", parentFrameId: "root-frame" });
  backend.handleCdpEvent({ tabId: 7 }, "Target.attachedToTarget", { sessionId: "dynamic", targetInfo: { type: "iframe", targetId: "child-frame", parentFrameId: "root-frame" } });
  backend.handleCdpEvent({ tabId: 7, sessionId: "dynamic" }, "Page.frameNavigated", { frame: { id: "child-frame", parentId: "root-frame", loaderId: "initial-loader", url: "https://child.fixture" } });
  await tick(); chooserEvent(backend, "dynamic"); await tick();
  assert.equal(backend.fileChooserWaits.records.get(ack.waiterId).state, "matched");
  backend.handleCdpEvent({ tabId: 7 }, "Page.frameDetached", { frameId: "child-frame", reason: "swap" });
  await assert.rejects(backend.collectFileChooserWait({ ...scope, waiterId: ack.waiterId }), /EXPIRED/);
  assert.equal(backend.fileChoosersById.size, 0);
  await backend.cancelFileChooserWait({ ...scope, waiterId: ack.waiterId });
});

test("matched chooser cannot escape document invalidation through new-frame initialization exemption", async () => {
  const { backend, scope, chrome } = await chooserReadyEnvironment(), gate = deferred();
  const ack = await backend.armFileChooserWait({ ...scope, timeoutMs: 1000 });
  const original = chrome.debugger.sendCommand;
  chrome.debugger.sendCommand = async (target, method, args) => {
    if (method === "Page.setInterceptFileChooserDialog" && !args.enabled) await gate.promise;
    return original(target, method, args);
  };
  chooserEvent(backend); await tick();
  assert.ok(backend.fileChooserWaits.records.get(ack.waiterId).result);
  backend.handleCdpEvent({ tabId: 7 }, "Page.frameAttached", { frameId: "new-frame", parentFrameId: "root-frame" });
  backend.handleCdpEvent({ tabId: 7 }, "Page.frameNavigated", { frame: { id: "new-frame", parentId: "root-frame" } });
  await assert.rejects(backend.collectFileChooserWait({ ...scope, waiterId: ack.waiterId }), /EXPIRED/);
  gate.resolve(); await tick(); assert.equal(backend.fileChoosersById.size, 0); assert.equal(backend.fileChooserWaits.records.size, 0);
});

test("existing frame navigation and true detach invalidate an armed chooser", async () => {
  const { backend, scope } = await chooserReadyEnvironment();
  for (const [method, event] of [["Page.frameNavigated", { frame: { id: "root-frame" } }], ["Page.frameDetached", { frameId: "known-frame", reason: "remove" }], ["Page.documentOpened", {}]]) {
    const ack = await backend.armFileChooserWait(scope);
    backend.handleCdpEvent({ tabId: 7 }, method, event);
    await assert.rejects(backend.collectFileChooserWait({ ...scope, waiterId: ack.waiterId }), /EXPIRED/);
    await backend.cancelFileChooserWait({ ...scope, waiterId: ack.waiterId });
  }
});

test("cancel acknowledgement waits for actual disable and permits the next arm without a sleep", async () => {
  const { backend, scope, chrome } = await chooserReadyEnvironment(), gate = deferred();
  const ack = await backend.armFileChooserWait(scope);
  const original = chrome.debugger.sendCommand;
  chrome.debugger.sendCommand = async (target, method, args) => {
    if (method === "Page.setInterceptFileChooserDialog" && !args.enabled) await gate.promise;
    return original(target, method, args);
  };
  let completed = false; const cancelling = backend.cancelFileChooserWait({ ...scope, waiterId: ack.waiterId }).then(() => { completed = true; });
  await tick(); assert.equal(completed, false); await assert.rejects(backend.armFileChooserWait(scope), /LIMIT/);
  gate.resolve(); await cancelling;
  const next = await backend.armFileChooserWait(scope); await backend.cancelFileChooserWait({ ...scope, waiterId: next.waiterId });
});

test("Pause retains unconfirmed chooser cleanup and only succeeds after exact retry", async () => {
  const { backend, scope, chrome } = await chooserReadyEnvironment();
  const ack = await backend.armFileChooserWait(scope);
  const original = chrome.debugger.sendCommand; let failing = true;
  chrome.debugger.sendCommand = async (target, method, args) => {
    if (method === "Page.setInterceptFileChooserDialog" && !args.enabled && failing) throw new Error("fixture native disable failure");
    return original(target, method, args);
  };
  await assert.rejects(backend.pauseAutomation(), /CLEANUP_FAILED|AUTOMATION_PAUSE_FAILED/);
  assert.equal(backend.fileChooserWaits.records.size, 1); assert.equal(backend.fileChooserWaits.records.get(ack.waiterId).invalid, true);
  failing = false; assert.equal((await backend.pauseAutomation()).cleanupComplete, true); assert.equal(backend.fileChooserWaits.records.size, 0);
});

test("cold chooser migration preserves only its own unbound setup", async () => {
  const { backend, scope, tabs } = await chooserReadyEnvironment();
  await backend.attach(scope); tabs.get(7).groupId = 20;
  const control = await backend.getControlState(other());
  const nextScope = { ...other(), tabId: 7, control_epoch: control.controlEpoch };
  const ack = await backend.armFileChooserWait(nextScope);
  chooserEvent(backend); const result = await backend.collectFileChooserWait({ ...nextScope, waiterId: ack.waiterId });
  assert.equal(backend.fileChoosersById.get(result.fileChooserId).scope.session_id, "other");
  await backend.setFileChooserFiles({ ...nextScope, fileChooserId: result.fileChooserId, files: [] });
});

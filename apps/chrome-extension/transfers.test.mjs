import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import vm from "node:vm";
import test from "node:test";
import { BrowserActionEngine } from "./browser-action-engine.js";

const source = (await readFile(new URL("./background.js", import.meta.url), "utf8"))
  .replace('import { createBrowserActionEngine } from "./browser-runtime.js";', "").replace('import { NativeInputTracker } from "./browser-input-adapter.js";', (await readFile(new URL("./browser-input-adapter.js", import.meta.url), "utf8")).replace(/^export /gm, "") + "\nglobalThis.performance ??= { now: () => Date.now() };");
const code = source.slice(0, source.indexOf("chrome.runtime.onInstalled.addListener"));
const clone = value => JSON.parse(JSON.stringify(value));
const tick = () => new Promise(resolve => setTimeout(resolve, 0));
const deferred = () => { let resolve, reject; const promise = new Promise((done, fail) => { resolve = done; reject = fail; }); return { promise, resolve, reject }; };
const params = (turn = "first", extra = {}) => ({ session_id: "task", turn_id: turn, ...extra });

function environment({ attachGate, storage = {}, write } = {}) {
  const calls = [], attached = new Set(), tabs = new Map([[7, { id: 7, groupId: 10, windowId: 1, url: "https://fixture.test" }]]);
  const chrome = {
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
  return { ...classes, chrome, calls, tabs, attached, storage };
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
 await backend.detach(task());await first;
 chrome.debugger.sendCommand=async(target,method,commandParams)=>{commands.push({target,method,commandParams});return method === "DOM.resolveNode" ? { object: { objectId: "exact-node" } } : method === "Runtime.callFunctionOn" ? { result: { value: 0 } } : {}};
 const second=backend.waitForFileChooser(task());await tick();const checkpoint=commands.length;gate.resolve();await tick();
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
 assert.notEqual(backend.downloadsById.get('owned').status,'complete');progress(backend,7,'owned');
 assert.equal(events.at(-1).status,'complete');assert.equal(events.at(-1).session_id,'task');assert.equal(events.at(-1).tabId,7);assert.ok(events.at(-1).control_epoch>0);
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
        if (method === 'waitForFileChooser' ? backend.fileChooserWaitersByTabId.has(7) : backend.downloadWaiters.size) break;
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

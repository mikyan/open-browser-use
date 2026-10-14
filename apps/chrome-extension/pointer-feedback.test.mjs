import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import vm from "./test-support/backend-vm.mjs";
import { BrowserActionEngine } from "./browser-action-engine.js";

const source = (await readFile(new URL("./background.js", import.meta.url), "utf8")).replace('import { createBrowserActionEngine } from "./browser-runtime.js";', "").replace('import { NativeInputTracker } from "./browser-input-adapter.js";', (await readFile(new URL("./browser-input-adapter.js", import.meta.url), "utf8")).replace(/^export /gm, "") + "\nglobalThis.performance ??= { now: () => Date.now() };");
const runtimeStart = source.indexOf("chrome.runtime.onInstalled.addListener");
assert.notEqual(runtimeStart, -1);
const session = { session_id: "pointer-test", turn_id: "turn-1" };
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

async function loadBackend({ sendCommand, sendMessage, inject, getFrame } = {}) {
  const calls = { commands: [], messages: [], injections: [], focus: [] };
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
    storage: { local: { async get() { return {}; }, async set() {} } },
    webNavigation: { async getFrame(params) { return getFrame ? getFrame(params) : { documentId: "original-document" }; } },
    tabGroups: { async get() { return { id: 10 }; } },
    tabs: {
      async query() { return [{ id: 7, groupId: 10, url: "https://example.test" }]; },
      async update(...args) { calls.focus.push(args); },
      async sendMessage(tabId, message, destination) {
        calls.messages.push({ tabId, ...json(message) });
        return sendMessage ? await sendMessage(tabId, message, destination) : { ok: true };
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
  const state = await backend.store.getSession(session.session_id);
  state.chromeGroupId = 10;
  state.activeTabId = 7;
  backend.activeTabsBySession.set(session.session_id, 7);
  backend.attachedTabs.add(7);
  backend.attachmentEpochs.set(7, {});
  backend.inputTracker.register(7, backend.attachmentEpochs.get(7));
  return { backend, calls, result };
}

async function flushFeedback(backend) {
  await Promise.all([...backend.pointerFeedbackByTabId.values()].map((queue) => queue.running));
}

for (const type of ["mouseMoved", "mousePressed", "mouseReleased", "mouseWheel"]) {
  test(`raw ${type} updates the page pointer without focusing the browser`, async () => {
    const { backend, calls, result } = await loadBackend();
    assert.equal(await backend.executeCdp(mouse(type)), result);
    await flushFeedback(backend);
    assert.deepEqual(calls.commands, [[{ tabId: 7 }, "Input.dispatchMouseEvent", { type, x: 120, y: 80 }]]);
    const updates = calls.messages.filter(({ type }) => type !== "OPEN_BROWSER_USE_PING");
    assert.deepEqual(updates[0], {
      tabId: 7, type: "OPEN_BROWSER_USE_CURSOR", sessionId: session.session_id,
      turnId: session.turn_id, feedbackSequence: 1, moveSequence: 1, animateMovement: false,
      visible: true, x: 120, y: 80
    });
    assert.equal(updates.length, type === "mousePressed" ? 2 : 1);
    if (type === "mousePressed") {
      assert.deepEqual(updates[1], {
        tabId: 7, type: "OPEN_BROWSER_USE_POINTER_EVENT", sessionId: session.session_id,
        turnId: session.turn_id, eventType: type, feedbackSequence: 1, x: 120, y: 80
      });
    }
    assert.equal(backend.cursorArrivalWaitersByKey.size, 0);
    assert.deepEqual(calls.focus, []);
  });
}

test("raw input reuses an existing move sequence at the same point and reports every press", async () => {
  const { backend, calls } = await loadBackend();
  await backend.moveMouse({ ...session, tabId: 7, x: 120, y: 80, waitForArrival: false });
  const sequence = backend.cursorByTabId.get(7).moveSequence;
  await backend.executeCdp(mouse("mousePressed"));
  await backend.executeCdp(mouse("mouseReleased"));
  await backend.executeCdp(mouse("mousePressed"));
  await flushFeedback(backend);
  assert.equal(backend.cursorByTabId.get(7).moveSequence, sequence);
  assert.equal(calls.messages.filter(({ type }) => type === "OPEN_BROWSER_USE_POINTER_EVENT").length, 2);
});

test("non-pointer, invalid coordinate and child-session commands do not guess a top-level position", async () => {
  const { backend, calls } = await loadBackend();
  for (const params of [
    { ...mouse(), method: "Input.insertText", commandParams: { text: "example" } },
    mouse("mouseMoved", { target: { tabId: 7, sessionId: "child-frame" } }),
    ...[NaN, Infinity, "120", undefined].map((x) => mouse("mouseMoved", { commandParams: { type: "mouseMoved", x, y: 80 } })),
    mouse("unknown"),
    mouse("mouseMoved", { commandParams: undefined })
  ]) {
    await backend.executeCdp(params);
  }
  assert.deepEqual(calls.messages, []);
  assert.equal(backend.cursorByTabId.size, 0);
});

test("CDP failures and unauthorized tabs never display a successful input", async () => {
  const failure = new Error("Input rejected");
  const { backend, calls } = await loadBackend({ sendCommand: async () => { throw failure; } });
  await assert.rejects(backend.executeCdp(mouse()), (error) => error === failure);
  await assert.rejects(backend.executeCdp(mouse("mouseMoved", { target: { tabId: 99 } })), /not part/);
  assert.equal(calls.commands.length, 1);
  assert.deepEqual(calls.messages, []);
});

test("restricted pages and failed feedback keep the original successful CDP result", async () => {
  for (const options of [
    { sendMessage: async () => { throw new Error("No receiver"); }, inject: async () => { throw new Error("Restricted"); } },
    { sendMessage: async (_id, message) => { if (message.type !== "OPEN_BROWSER_USE_PING") throw new Error("Navigated"); return { ok: true }; } }
  ]) {
    const { backend, result, calls } = await loadBackend(options);
    assert.equal(await backend.executeCdp(mouse("mousePressed")), result);
    await flushFeedback(backend);
    assert.equal(calls.commands.length, 1);
  }
});

test("an unresponsive content script cannot consume the successful CDP request deadline", async () => {
  const ping = deferred();
  const { backend, calls, result } = await loadBackend({
    sendMessage: async (_id, message) => message.type === "OPEN_BROWSER_USE_PING" ? ping.promise : { ok: true }
  });
  let deadline;
  try {
    const response = await Promise.race([
      backend.executeCdp(mouse("mousePressed", { timeoutMs: 25 })),
      new Promise((_, reject) => {
        deadline = setTimeout(() => reject(new Error("Feedback delayed the input response")), 100);
      })
    ]);
    assert.equal(response, result);
  } finally {
    clearTimeout(deadline);
  }
  assert.equal(calls.commands.length, 1);
  await flushFeedback(backend);
  ping.resolve({ ok: true });
  await new Promise(setImmediate);
  assert.deepEqual(calls.messages.map(({ type }) => type), ["OPEN_BROWSER_USE_PING"]);
});

test("accepted press and release feedback preserves click rings without serializing original input", async () => {
  const ping = deferred();
  const started = deferred();
  let first = true;
  const { backend, calls } = await loadBackend({ sendMessage: async (_id, message) => {
    if (message.type === "OPEN_BROWSER_USE_PING" && first) {
      first = false;
      started.resolve();
      return ping.promise;
    }
    return { ok: true };
  } });
  await backend.executeCdp(mouse("mousePressed"));
  await started.promise;
  await backend.executeCdp(mouse("mouseReleased"));
  await backend.executeCdp(mouse("mouseMoved", { commandParams: { type: "mouseMoved", x: 240, y: 160 } }));
  assert.equal(calls.commands.length, 3);
  assert.equal(calls.messages.some(({ type }) => type === "OPEN_BROWSER_USE_CURSOR"), false);
  ping.resolve({ ok: true });
  await flushFeedback(backend);
  const updates = calls.messages.filter(({ type }) => type === "OPEN_BROWSER_USE_CURSOR");
  assert.deepEqual(updates.map(({ x }) => x), [120, 120, 240]);
  assert.equal(calls.messages.filter(({ type }) => type === "OPEN_BROWSER_USE_POINTER_EVENT").length, 1);
  assert.equal(backend.cursorByTabId.get(7).x, 240);
});

test("turn end clears feedback and suppresses an in-flight update", async () => {
  const ping = deferred();
  const started = deferred();
  let first = true;
  const { backend, calls } = await loadBackend({ sendMessage: async (_id, message) => {
    if (message.type === "OPEN_BROWSER_USE_PING" && first) {
      first = false;
      started.resolve();
      return ping.promise;
    }
    return { ok: true };
  } });
  const input = backend.executeCdp(mouse("mousePressed"));
  await started.promise;
  await backend.executeCdp(mouse("mouseReleased"));
  const queue = backend.pointerFeedbackByTabId.get(7);
  await backend.turnEnded(session);
  assert.equal(backend.pointerFeedbackByTabId.size, 0);
  ping.resolve({ ok: true });
  await input;
  await queue.running;
  assert.equal(backend.cursorByTabId.size, 0);
  const updates = calls.messages.filter(({ type }) => type !== "OPEN_BROWSER_USE_PING");
  assert.deepEqual(updates, [{ tabId: 7, type: "OPEN_BROWSER_USE_CURSOR_STATE", state: {
    cursor: null, isVisible: false, sessionId: null, turnId: null
  } }]);
});

test("feedback backlog is bounded and adjacent moves keep only the latest position", async () => {
  const ping = deferred();
  let first = true;
  const { backend, calls } = await loadBackend({ sendMessage: async (_id, message) => {
    if (message.type === "OPEN_BROWSER_USE_PING" && first) {
      first = false;
      return ping.promise;
    }
    return { ok: true };
  } });
  await backend.executeCdp(mouse("mousePressed"));
  const queue = backend.pointerFeedbackByTabId.get(7);
  for (let index = 0; index < 20; index++) {
    await backend.executeCdp(mouse("mousePressed", { commandParams: { type: "mousePressed", x: index, y: 80 } }));
    assert.ok(queue.pending.length <= 7);
  }
  for (let index = 0; index < 20; index++) {
    await backend.executeCdp(mouse("mouseMoved", { commandParams: { type: "mouseMoved", x: 200 + index, y: 80 } }));
    assert.ok(queue.pending.length <= 7);
  }
  assert.equal(calls.commands.length, 41);
  assert.equal(queue.pending.filter(({ commandParams }) => commandParams.type === "mouseMoved").length, 1);
  ping.resolve({ ok: true });
  await flushFeedback(backend);
  assert.equal(backend.cursorByTabId.get(7).x, 219);
  assert.equal(calls.messages.filter(({ type }) => type === "OPEN_BROWSER_USE_CURSOR").length, 8);
  assert.equal(backend.pointerFeedbackByTabId.size, 0);
});

test("a detached queue cannot revive after a new attachment creates another queue", async () => {
  const ping = deferred();
  let first = true;
  const { backend, calls } = await loadBackend({ sendMessage: async (_id, message) => {
    if (message.type === "OPEN_BROWSER_USE_PING" && first) {
      first = false;
      return ping.promise;
    }
    return { ok: true };
  } });
  await backend.executeCdp(mouse("mousePressed"));
  const oldQueue = backend.pointerFeedbackByTabId.get(7);
  await backend.detachTab(7);
  backend.attachedTabs.add(7);
  backend.attachmentEpochs.set(7, {});
  backend.inputTracker.register(7, backend.attachmentEpochs.get(7));
  await backend.executeCdp(mouse("mouseMoved", { commandParams: { type: "mouseMoved", x: 240, y: 160 } }));
  await flushFeedback(backend);
  ping.resolve({ ok: true });
  await oldQueue.running;
  const updates = calls.messages.filter(({ type }) => type === "OPEN_BROWSER_USE_CURSOR");
  assert.deepEqual(updates.map(({ x }) => x), [240]);
  assert.equal(calls.messages.some(({ type }) => type === "OPEN_BROWSER_USE_POINTER_EVENT"), false);
  assert.equal(backend.cursorByTabId.get(7).x, 240);
});

test("raw JSON cannot forge private target geometry or feedback ordering", async () => {
  const {backend,calls}=await loadBackend();
  await backend.executeCdp(mouse("mousePressed", {feedbackTarget:{value:{x:1,y:2,width:3,height:4},settled:true},feedbackSequence:999,feedbackAuthority:{}}));
  await flushFeedback(backend);
  const cursor=calls.messages.find(x=>x.type==='OPEN_BROWSER_USE_CURSOR');
  assert.equal(cursor.feedbackSequence,1); assert.equal(Object.hasOwn(cursor,'targetRect'),false);
});

test("original native ACK order cannot make an old same-coordinate hinted action supersede new raw feedback", async () => {
  const held=deferred(), started=deferred(); let count=0;
  const {backend,calls}=await loadBackend({sendCommand:async()=>{if(++count===1){started.resolve();await held.promise;}return {};}});
  const old=backend.executeCdp(mouse()); await started.promise;
  await backend.executeCdp(mouse()); await flushFeedback(backend);
  const latest=backend.cursorByTabId.get(7); assert.equal(latest.feedbackSequence,2);
  held.resolve(); await old; await flushFeedback(backend);
  assert.equal(backend.cursorByTabId.get(7),latest);
  assert.equal(calls.messages.filter(x=>x.type==='OPEN_BROWSER_USE_CURSOR').length,1);
  assert.equal(calls.commands.length,2);
});

async function visualFixture() {
 const f=await loadBackend(); await f.backend.executeCdp(mouse()); await flushFeedback(f.backend); f.calls.messages.length=0;
 f.backend.browserEngine={active:new Map([[7,{...session,control_epoch:f.backend.controlLedger.assertCurrent(session).epoch}]])};
 return f;
}

test('optional original target read does not block position or click ring and patches only its original sequence',async()=>{
 const {backend,calls}=await visualFixture(), held=deferred(); let reads=0;
 const candidate=backend.capturePointerTarget({target:{tabId:7},check(){},read(){reads++;return held.promise;},decode:x=>x});
 const publish=backend.preparePointerFeedback({...mouse('mousePressed'),feedbackTarget:candidate}); publish(); await flushFeedback(backend);
 const initial=calls.messages.filter(x=>x.type!=='OPEN_BROWSER_USE_PING');
 assert.equal(initial.length,2); assert.equal(initial[0].targetRect,null); assert.equal(initial[1].eventType,'mousePressed');
 assert.equal(backend.pointerFeedbackReads.pending.size,1);
 const rect={x:20,y:30,width:40,height:50}; held.resolve(rect); await candidate.result; await new Promise(setImmediate);
 const patch=calls.messages.find(x=>x.type==='OPEN_BROWSER_USE_TARGET_RECT'); assert.deepEqual(patch.targetRect,rect);
 assert.equal(patch.feedbackSequence,initial[0].feedbackSequence); assert.equal(reads,1);
});

test('same-coordinate raw feedback and original document loss both reject late original target patches',async()=>{
 for(const change of ['raw','document','attachment']){
  const {backend,calls}=await visualFixture(), held=deferred();
  const candidate=backend.capturePointerTarget({target:{tabId:7},check(){},read:()=>held.promise,decode:x=>x});
  backend.preparePointerFeedback({...mouse(),feedbackTarget:candidate})(); await flushFeedback(backend);
  if(change==='raw'){await backend.executeCdp(mouse());await flushFeedback(backend);}
  if(change==='document')backend.exportDocumentRevisions.set(7,1);
  if(change==='attachment')backend.attachmentEpochs.set(7,{});
  held.resolve({x:1,y:2,width:3,height:4}); await candidate.result; await new Promise(setImmediate);
  assert.equal(calls.messages.some(x=>x.type==='OPEN_BROWSER_USE_TARGET_RECT'),false,change);
 }
});

test('explicit detach joins actual visual native read without granting a successor authority',async()=>{
 const {backend}=await visualFixture(), held=deferred();
 const token=backend.attachmentEpochs.get(7);
 const candidate=backend.capturePointerTarget({target:{tabId:7},check(){},read:()=>held.promise,decode:x=>x});
 backend.browserEngine=undefined; let settled=false;
 const releasing=backend.detachTab(7).then(()=>settled=true); await new Promise(setImmediate); assert.equal(settled,false);
 assert.equal(backend.pointerFeedbackReads.pending.size,1);
 held.resolve({x:1,y:2,width:3,height:4}); await candidate.result; await releasing;
 assert.equal(settled,true); assert.equal(backend.pointerFeedbackReads.pending.size,0); assert.equal(token===backend.attachmentEpochs.get(7),false);
});

test('default-mode feedback binds every payload to the original Chrome document, even if delivery is delayed',async()=>{
 const delivered=[], gate=deferred(); let destination;
 const {backend,calls}=await loadBackend({sendMessage:async(_tab,message,options)=>{
   if(message.type==='OPEN_BROWSER_USE_CURSOR'){destination=options;await gate.promise;delivered.push({message,options});}return {ok:true};
 }});
 await backend.executeCdp(mouse('mousePressed'));
 while(!destination)await new Promise(setImmediate);
 backend.exportDocumentRevisions.set(7,1); gate.resolve(); await flushFeedback(backend);
 assert.deepEqual(json(destination),{documentId:'original-document'});
 assert.equal(delivered.length,1); assert.equal(delivered[0].options.documentId,'original-document');
 assert.equal(calls.messages.some(x=>x.type==='OPEN_BROWSER_USE_POINTER_EVENT'),false);
});

test('navigation during root document lookup discards feedback without delaying or replaying native input',async()=>{
 const gate=deferred(),started=deferred();
 const {backend,calls}=await loadBackend({getFrame:async()=>{started.resolve();await gate.promise;return {documentId:'successor-document'};}});
 await backend.executeCdp(mouse()); await started.promise; backend.exportDocumentRevisions.set(7,1); gate.resolve(); await flushFeedback(backend);
 assert.equal(calls.messages.some(x=>x.type==='OPEN_BROWSER_USE_CURSOR'),false);assert.equal(calls.commands.length,1);
});

for(const requiredHeld of [false,true]) test(`actual Engine timeout ${requiredHeld?'still waits for required input cleanup':'does not wait for a prior optional pure read'}`,async()=>{
 const inputGate=deferred(), keyupStarted=deferred(), readGate=deferred();
 const {backend}=await loadBackend({sendCommand:async(_target,method,params)=>{
  if(requiredHeld&&method==='Input.dispatchKeyEvent'&&params.type==='keyUp'){keyupStarted.resolve();await inputGate.promise;} return {};
 }});
 await backend.executeCdp(mouse()); await flushFeedback(backend);
 if(requiredHeld)await backend.executeCdp({...mouse(),method:'Input.dispatchKeyEvent',commandParams:{type:'keyDown',key:'Shift',code:'ShiftLeft',windowsVirtualKeyCode:16,modifiers:8}});
 let rejectAction; const entered=deferred();
 const page={on(){},off(){},locator(){return {count(){entered.resolve();return new Promise((_,reject)=>rejectAction=reject);}};}};
 const app={attach:async()=>page,detach:async()=>{const release=backend.prepareInputRelease(7);rejectAction?.(new Error('Page closed'));await release.release();await release.detach();}};
 globalThis.chrome={tabs:{get:async()=>({incognito:false})}};
 const engine=new BrowserActionEngine({loadRuntime:async()=>({crx:{start:async()=>app},setOpenBrowserUseCommandObserver(){},setOpenBrowserUseEventFilter(){},assertOpenBrowserUseSelector(){}}),onDetached:()=>backend.releaseEngineAttachment(7)});
 backend.browserEngine=engine;engine.active.set(7,{...session,control_epoch:backend.controlLedger.assertCurrent(session).epoch});
 const candidate=backend.capturePointerTarget({target:{tabId:7},check(){},read:()=>readGate.promise,decode:x=>x});
 let finished=false;
 const action=engine.dispatch({...session,tabId:7,action:'count',locator:[{kind:'css',selector:'button'}],timeoutMs:25});
 const rejected=assert.rejects(action,/timed out after 25ms/).then(()=>finished=true);
 await entered.promise;
 if(requiredHeld){await keyupStarted.promise;await new Promise(setImmediate);assert.equal(finished,false);inputGate.resolve();}
 await Promise.race([rejected,new Promise((_,reject)=>setTimeout(()=>reject(Error('optional read extended action deadline')),300))]);
 assert.equal(backend.pointerFeedbackReads.pending.size,1);assert.equal(finished,true);
 readGate.resolve({x:1,y:2,width:3,height:4});assert.equal(await candidate.result,null);assert.equal(backend.pointerFeedbackReads.pending.size,0);
});

test('accepted press still emits its unique original ring when same-point release ACK wins the root document lookup',async()=>{
 const lookup=deferred(),entered=deferred();let reads=0;
 const {backend,calls}=await loadBackend({getFrame:async()=>{if(++reads===1){entered.resolve();await lookup.promise;}return {documentId:'original-document'};}});
 await backend.executeCdp(mouse('mousePressed'));await entered.promise;
 await backend.executeCdp(mouse('mouseReleased'));
 assert.equal(calls.commands.length,2);assert.equal(backend.pointerFeedbackLatest.get(7),2);
 assert.equal(calls.messages.some(value=>value.type==='OPEN_BROWSER_USE_POINTER_EVENT'),false);
 lookup.resolve();await flushFeedback(backend);
 const emitted=calls.messages.filter(value=>value.type!=='OPEN_BROWSER_USE_PING');
 assert.deepEqual(emitted.map(value=>[value.type,value.feedbackSequence]),[
  ['OPEN_BROWSER_USE_CURSOR',1],['OPEN_BROWSER_USE_POINTER_EVENT',1],['OPEN_BROWSER_USE_CURSOR',2]
 ]);
 assert.equal(emitted[1].x,120);assert.equal(emitted[1].y,80);assert.equal(backend.cursorByTabId.get(7).feedbackSequence,2);
});

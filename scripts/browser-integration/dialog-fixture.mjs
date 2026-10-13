import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";

export const dialogLayouts = ["root", "oopif", "dynamic-oopif"];
export const dialogAnswer = "确认：研发二组 🧪\n第二行";
export const dialogCases = [
  { button: "Confirm transfer", action: "confirm", decision: { type: "confirm", accept: true }, answer: true },
  { button: "Enter reference", action: "prompt", decision: { type: "prompt", accept: true, promptText: dialogAnswer }, answer: dialogAnswer },
  { button: "Notice then confirm", action: "sequence", decision: { type: "confirm", accept: true }, answer: true },
  { button: "Confirm transfer", action: "confirm", decision: { type: "confirm", accept: false }, answer: false },
  { button: "Enter reference", action: "prompt", decision: { type: "prompt", accept: false }, answer: null },
  { button: "Show notice", action: "alert", decision: { type: "alert", accept: true }, answer: null }
];
const json = value => JSON.stringify(value).replace(/</g, "\\u003c");
export const dialogMessage = (key, type) => `${type}: ${key}`;
export const dialogURL = (base, key, layout) => base + "native-dialogs?" + new URLSearchParams({ key, layout });

// All decisions happen through real window dialogs. The fixture records the
// original document and trusted trigger in its one HTTP receipt per action.
export function createDialogFixtures() {
  const entries = new Map();
  const entry = key => {
    if (!entries.has(key)) entries.set(key, { documents: [], posts: [] });
    return entries.get(key);
  };
  return {
    stats: key => structuredClone(entry(key)),
    handle(request, response, port) {
      const url = new URL(request.url, "http://localhost");
      if (!url.pathname.startsWith("/native-dialogs")) return false;
      const key = url.searchParams.get("key");
      if (!key || key.length > 200) { response.writeHead(400); response.end(); return true; }
      if (url.pathname === "/native-dialogs/result") {
        if (request.method !== "POST") { response.writeHead(405); response.end(); return true; }
        const chunks = []; let bytes = 0, failed = false;
        request.on("data", chunk => {
          bytes += chunk.length;
          if (bytes > 32768) { failed = true; response.writeHead(413); response.end(); request.destroy(); }
          else chunks.push(chunk);
        });
        request.on("end", () => {
          if (failed) return;
          const body = Buffer.concat(chunks);
          try {
            const value = JSON.parse(body.toString("utf8"));
            entry(key).posts.push({ method: request.method, path: request.url, bodyBase64: body.toString("base64"), bytes: body.length, value });
            response.writeHead(200, { "Content-Type": "application/json" }); response.end('{"saved":true}');
          } catch { response.writeHead(400); response.end(); }
        });
        return true;
      }
      if (!["/native-dialogs", "/native-dialogs/frame", "/native-dialogs/left"].includes(url.pathname)) {
        response.writeHead(404); response.end(); return true;
      }
      response.setHeader("Content-Type", "text/html; charset=utf-8"); response.setHeader("Cache-Control", "no-store");
      if (url.pathname === "/native-dialogs/left") { response.end("<!doctype html><title>Navigation completed</title><p>Left the original page</p>"); return true; }
      const layout = url.searchParams.get("layout") ?? "root", child = url.pathname.endsWith("/frame");
      if (!dialogLayouts.includes(layout)) { response.writeHead(400); response.end(); return true; }
      const token = randomUUID(), controls = child || layout === "root";
      entry(key).documents.push({ token, href: `http://${request.headers.host}${request.url}`, controls, layout });
      const frame = `http://localhost:${port}/native-dialogs/frame?` + new URLSearchParams({ key, layout });
      const controlsHTML = '<button id="confirm">Confirm transfer</button><button id="prompt">Enter reference</button><button id="alert">Show notice</button><button id="sequence">Notice then confirm</button><button id="dirty">Protect this page</button><button id="clean">Allow leaving</button><output id="done">idle</output>';
      response.end(`<!doctype html><meta charset="utf-8"><title>Native dialog task</title>
        ${controls ? controlsHTML : layout === "oopif" ? `<iframe id="dialog-frame" src="${frame}"></iframe>` : '<button id="add-frame">Add dialog frame</button>'}
        <script>
        const key=${json(key)}, token=${json(token)};
        globalThis.dialogEvidence={key,token,href:location.href,triggers:[],results:[]};
        ${controls ? `
        const save=async(type,answer,event)=>{
          const result={key,token,href:location.href,type,answer,trusted:event.isTrusted,sequence:dialogEvidence.results.length+1};
          dialogEvidence.results.push(result);
          const response=await fetch('/native-dialogs/result?'+new URLSearchParams({key}),{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(result)});
          if(!response.ok)throw Error('Receipt failed');document.querySelector('#done').textContent=type+':'+result.sequence;
        };
        for(const type of ['confirm','prompt','alert','sequence'])document.querySelector('#'+type).onclick=event=>{
          dialogEvidence.triggers.push({type,trusted:event.isTrusted});let answer;
          if(type==='alert'){alert('alert: '+key);answer=null}
          else if(type==='prompt')answer=prompt('prompt: '+key,'original default');
          else {if(type==='sequence')alert('unmatched: '+key);answer=confirm('confirm: '+key)}
          save(type,answer,event).catch(error=>{document.querySelector('#done').textContent=String(error)});
        };
        const before=event=>{event.preventDefault();event.returnValue='';};
        document.querySelector('#dirty').onclick=()=>{addEventListener('beforeunload',before);globalThis.dialogDirty=true;};
        document.querySelector('#clean').onclick=()=>{removeEventListener('beforeunload',before);globalThis.dialogDirty=false;};
        ` : layout === "dynamic-oopif" ? `document.querySelector('#add-frame').onclick=()=>{const frame=document.createElement('iframe');frame.id='dialog-frame';frame.src=${json(frame)};document.body.append(frame);document.querySelector('#add-frame').disabled=true;};` : ""}
        </script>`);
      return true;
    }
  };
}

export function checkDialogReceipt(receipt, { key, type, answer, sequence, document }) {
  assert.equal(receipt.method, "POST");
  const bytes = Buffer.from(receipt.bodyBase64, "base64"); assert.equal(bytes.length, receipt.bytes);
  assert.deepEqual(JSON.parse(bytes.toString("utf8")), receipt.value);
  assert.deepEqual(receipt.value, { key, token: document.token, href: document.href, type, answer, trusted: true, sequence });
  return receipt.value;
}

export function checkDialogResult(value, decision, key) {
  const expected = { type: decision.type, message: dialogMessage(key, decision.type), defaultValue: decision.type === "prompt" ? "original default" : "", accepted: decision.accept };
  if (decision.type === "prompt" && decision.accept) expected.promptText = decision.promptText ?? "";
  assert.deepEqual(value, expected); return value;
}

export async function prepareDialogTab({ browser, fixtureURL, key, layout }) {
  const tab = await browser.newTab(); await tab.goto(dialogURL(fixtureURL, key, layout));
  const target = layout === "root" ? tab : tab.frameLocator("#dialog-frame");
  if (layout !== "dynamic-oopif") await target.getByRole("button", { name: "Confirm transfer", exact: true }).waitFor({ state: "visible" });
  return { tab, target };
}

async function withDialogCleanup(wait, record, run, extra = []) {
  let failure, value;
  try { value = await run(); } catch (error) { failure = error; record.error = error?.stack ?? String(error); }
  for (const [name, cleanup] of [["cancel", () => wait.cancel()], ...extra]) {
    try { await cleanup(); }
    catch (error) { (record.cleanupErrors ??= []).push({ name, error: error?.stack ?? String(error) }); failure ??= error; }
  }
  if (failure) throw failure;
  return value;
}

export async function checkDialogWorkflow({ browser, fixtureURL, server, until, worker, makeDialog = (tab, decision, options) => tab.expectDialog(decision, options), caller = "js", keyPrefix = caller, detail = {} }) {
  detail.caller = caller; detail.variants = []; detail.passed = false;
  if (keyPrefix !== caller) detail.keyPrefix = keyPrefix;
  for (const layout of dialogLayouts) {
    const key = `${keyPrefix}-dialogs-${layout}`, item = { key, layout, decisions: [] }; detail.variants.push(item);
    const { tab, target } = await prepareDialogTab({ browser, fixtureURL, key, layout }); item.tabId = tab.id;
    for (const [index, selected] of dialogCases.entries()) {
      const { button, action, answer } = selected, decision = { ...selected.decision, message: dialogMessage(key, selected.decision.type) };
      const wait = await makeDialog(tab, decision, { timeoutMs: 10000 });
      const record = { decision, dialogId: wait.dialogId, remainingMs: wait.remainingMs }; item.decisions.push(record);
      await withDialogCleanup(wait, record, async () => {
        if (layout === "dynamic-oopif" && index === 0) {
          await tab.getByRole("button", { name: "Add dialog frame", exact: true }).click();
          await target.getByRole("button", { name: "Confirm transfer", exact: true }).waitFor({ state: "visible" });
        }
        await target.getByRole("button", { name: button, exact: true }).click();
        record.result = checkDialogResult(await wait.result(), decision, key);
        await until(() => server.stats(key).posts.length === index + 1, "Original dialog business receipt");
        const documents = server.stats(key).documents.filter(document => document.controls); assert.equal(documents.length, 1);
        checkDialogReceipt(server.stats(key).posts[index], { key, type: action, answer, sequence: index + 1, document: documents[0] });
      });
    }
    // No active decision must preserve the existing default decline.
    await target.getByRole("button", { name: "Confirm transfer", exact: true }).click();
    await until(() => server.stats(key).posts.length === 7, "Original default dialog receipt");
    item.server = server.stats(key);
    const document = item.server.documents.find(value => value.controls);
    checkDialogReceipt(item.server.posts[6], { key, type: "confirm", answer: false, sequence: 7, document });
    item.frames = await worker.evaluate(`chrome.webNavigation.getAllFrames({tabId:${tab.id}})`);
    assert.equal(item.frames.filter(frame => frame.url === document.href).length, 1);
    if (layout !== "root") {
      item.targets = await worker.evaluate("chrome.debugger.getTargets()");
      item.oopifTargets = await worker.evaluate(`globalThis.__integrationFrames.filter(target=>target.tabId===${tab.id})`);
      assert.ok(item.oopifTargets.some(target => target.type === "iframe" &&
        item.targets.some(live => live.id === target.targetId && live.attached && live.url === document.href)), "Original attached OOPIF target required");
    }
  }
  detail.passed = true; return detail;
}

export async function checkExternalDialogWorkflow({ detail, kind, keyPrefix = kind, server, until, worker }) {
  assert.equal(detail.caller, kind); assert.equal(detail.passed, true); assert.equal(detail.variants.length, 3);
  assert.equal(detail.keyPrefix ?? kind, keyPrefix);
  assert.deepEqual(detail.variants.map(item => item.layout), dialogLayouts);
  assert.equal(new Set(detail.variants.map(item => item.tabId)).size, 3);
  for (const item of detail.variants) {
    assert.equal(item.key, `${keyPrefix}-dialogs-${item.layout}`); assert.equal(item.decisions.length, dialogCases.length);
    await until(() => server.stats(item.key).posts.length === 7, "Original external dialog receipts");
    item.server = server.stats(item.key);
    const documents = item.server.documents.filter(document => document.controls); assert.equal(documents.length, 1);
    for (const [index, selected] of dialogCases.entries()) {
      const decision = { ...selected.decision, message: dialogMessage(item.key, selected.decision.type) };
      const actual = item.decisions[index]; assert.deepEqual(actual.decision, decision);
      assert.ok(typeof actual.dialogId === "string" && actual.dialogId); assert.ok(actual.remainingMs > 0 && actual.remainingMs <= 10000);
      checkDialogResult(actual.result, decision, item.key);
      checkDialogReceipt(item.server.posts[index], { key: item.key, type: selected.action, answer: selected.answer, sequence: index + 1, document: documents[0] });
    }
    checkDialogReceipt(item.server.posts[6], { key: item.key, type: "confirm", answer: false, sequence: 7, document: documents[0] });
    item.frames = await worker.evaluate(`chrome.webNavigation.getAllFrames({tabId:${item.tabId}})`);
    assert.equal(item.frames.filter(frame => frame.url === documents[0].href).length, 1);
    if (item.layout !== "root") {
      item.targets = await worker.evaluate("chrome.debugger.getTargets()");
      item.oopifTargets = await worker.evaluate(`globalThis.__integrationFrames.filter(target=>target.tabId===${item.tabId})`);
      assert.ok(item.oopifTargets.some(target => target.type === "iframe" &&
        item.targets.some(live => live.id === target.targetId && live.attached && live.url === documents[0].href)), "Original attached OOPIF target required");
    }
  }
}

export async function checkDialogLifecycle({ browser, fixtureURL, server, until, beforeunload = false, detail = {} }) {
  const key = "js-dialog-lifecycle", { tab, target } = await prepareDialogTab({ browser, fixtureURL, key, layout: "root" });
  detail.variants = [{ key, layout: "root", tabId: tab.id }]; detail.passed = false;
  const decline = async sequence => {
    await target.getByRole("button", { name: "Confirm transfer", exact: true }).click();
    await until(() => server.stats(key).posts.length === sequence, "Default confirmation after lifecycle boundary");
    const document = server.stats(key).documents.find(value => value.controls);
    checkDialogReceipt(server.stats(key).posts[sequence - 1], { key, type: "confirm", answer: false, sequence, document });
  };
  const cancelled = await tab.expectDialog({ type: "confirm", accept: true }, { timeoutMs: 5000 });
  detail.cancelled = { dialogId: cancelled.dialogId };
  await cancelled.cancel();
  await assert.rejects(() => cancelled.result(), /cancel|consumed|expired|unavailable|invalid/i);
  await decline(1);
  const expired = await tab.expectDialog({ type: "confirm", accept: true }, { timeoutMs: 1000 });
  detail.expired = { dialogId: expired.dialogId, remainingMs: expired.remainingMs };
  await withDialogCleanup(expired, detail.expired, () => assert.rejects(() => expired.result(), /timeout|timed out|deadline/i));
  await decline(2);

  if (beforeunload) {
    // Explicit diagnostic: Chromium's native beforeunload UI activates the tab.
    // Keep the unchanged focus gate so this known background gap remains red.
    await target.getByRole("button", { name: "Protect this page", exact: true }).click();
    const original = await tab.evaluate("({token:dialogEvidence.token,href:location.href})");
    const leave = await tab.expectDialog({ type: "beforeunload", accept: false }, { timeoutMs: 10000 });
    detail.beforeunload = { dialogId: leave.dialogId, original };
    await withDialogCleanup(leave, detail.beforeunload, async () => {
      try { detail.beforeunload.navigation = await tab.goto(fixtureURL + "native-dialogs/left?key=" + key); }
      catch (error) { detail.beforeunload.navigationError = String(error); }
      detail.beforeunload.result = await leave.result();
      assert.equal(detail.beforeunload.result.type, "beforeunload"); assert.equal(detail.beforeunload.result.accepted, false);
      assert.deepEqual(await tab.evaluate("({token:dialogEvidence.token,href:location.href})"), original);
    }, [["clear-beforeunload", () => target.getByRole("button", { name: "Allow leaving", exact: true }).click()]]);
  }

  const old = await tab.expectDialog({ type: "confirm", accept: true }, { timeoutMs: 10000 });
  detail.ended = { dialogId: old.dialogId, previousEpoch: browser.client.controlEpoch };
  await browser.client.turnEnded();
  await assert.rejects(() => old.result(), /ended|expired|stale|control|cancel|bootstrap|scope/i);
  detail.ended.resumed = await browser.client.beginTurn();
  await decline(3);
  detail.server = server.stats(key); assert.equal(detail.server.posts.length, 3);
  detail.passed = true; return detail;
}

export async function installDialogEvidence(worker) {
  await worker.evaluate(`(() => {
    if (globalThis.__obuDialogEvidence) throw Error('Dialog observer already installed');
    const record={events:[],commands:[],overflow:false}, original=chrome.debugger.sendCommand;
    let sequence=0;
    const push=(list,value)=>{if(list.length>=1024){record.overflow=true;return}list.push({sequence:++sequence,at:Date.now(),...value});};
    const listener=(source,method,params)=>{if(method==='Page.javascriptDialogOpening'||method==='Page.javascriptDialogClosed')push(record.events,{source,method,params});};
    const wrapped=function(target,method,params){
      if(method!=='Page.handleJavaScriptDialog')return original.call(this,target,method,params);
      const item={target:structuredClone(target),method,params:structuredClone(params)};push(record.commands,item);
      const saved=record.commands.at(-1);let promise;
      try{promise=original.call(this,target,method,params)}catch(error){saved.error=String(error);throw error}
      promise.then(value=>{saved.settledAt=Date.now();saved.ack=structuredClone(value??{});},error=>{saved.settledAt=Date.now();saved.error=String(error);});
      return promise;
    };
    chrome.debugger.onEvent.addListener(listener);chrome.debugger.sendCommand=wrapped;
    globalThis.__obuDialogEvidence={record,original,wrapped,listener};
  })()`);
  return async () => worker.evaluate(`(() => {
    const state=globalThis.__obuDialogEvidence;if(!state)throw Error('Dialog observer missing');
    if(chrome.debugger.sendCommand!==state.wrapped)throw Error('Dialog native observer was replaced');
    chrome.debugger.sendCommand=state.original;chrome.debugger.onEvent.removeListener(state.listener);
    delete globalThis.__obuDialogEvidence;return state.record;
  })()`);
}

import assert from "node:assert/strict";

// These are private synthetic pages and observation hooks. All agent actions
// still cross the public SDK, real host, and production extension.
export function lifecycleRecoveryFixture() {
  return `<!doctype html><meta charset="utf-8"><title>Lifecycle recovery fixture</title>
    <style>button,input{display:block;margin:25px;padding:15px}</style>
    <button id="held">Hold pointer</button><label>Name<input id="name"></label>
    <script>
      globalThis.events=[];globalThis.lateClicks=0;
      for(const type of ['pointerdown','pointerup','click','keydown','keyup'])
        document.addEventListener(type,event=>{
          events.push({type,trusted:event.isTrusted,buttons:event.buttons,key:event.key,pointerId:event.pointerId,target:event.target.id});
          if(type==='pointerdown')event.target.setPointerCapture(event.pointerId);
        });
    </script>`;
}

async function pageState(worker, tabId, addTarget = false) {
  const result = await worker.evaluate(`chrome.scripting.executeScript({
    target:{tabId:${tabId}},world:'MAIN',args:[${addTarget}],func:addTarget=>{
      if(addTarget&&!document.getElementById('late-action')){
        const button=document.createElement('button');button.id='late-action';button.textContent='Late action';
        button.onclick=()=>globalThis.lateClicks++;document.body.append(button);
      }
      const down=events.find(event=>event.type==='pointerdown');
      return {events:[...events],lateClicks,heldCapture:!!down&&document.getElementById('held').hasPointerCapture(down.pointerId),name:document.getElementById('name').value};
    }
  })`);
  assert.equal(result.length, 1); assert.equal(result[0].frameId, 0);
  assert.equal(typeof result[0].documentId, "string");
  return { ...result[0].result, documentId: result[0].documentId };
}

async function installJournal(worker, tabIds) {
  await worker.evaluate(`(()=>{
    if(globalThis.__recoveryJournal)throw new Error('Recovery journal already installed');
    const p=globalThis.__recoveryJournal={original:chrome.debugger.sendCommand,tabIds:${JSON.stringify(tabIds)},events:[],seenSelector:false,overflow:false};
    const push=event=>{if(p.events.length===1024)p.overflow=true;else p.events.push({sequence:p.events.length,...event})};
    p.wrapper=function(target,method,params){
      let selected=false;
      if(p.tabIds.includes(target.tabId)){
        selected=method==='Runtime.callFunctionOn'&&JSON.stringify(params).includes('late-action');
        if(selected)p.seenSelector=true;
        push({kind:'command',tabId:target.tabId,sessionId:target.sessionId??null,method,type:params?.type,selected});
      }
      let sent;
      try{sent=p.original.call(chrome.debugger,target,method,params)}catch(error){
        if(selected)push({kind:'selector-settled',tabId:target.tabId,ok:false,error:String(error)});throw error;
      }
      if(!selected)return sent;
      return Promise.resolve(sent).then(value=>{
        push({kind:'selector-settled',tabId:target.tabId,ok:true});return value;
      },error=>{push({kind:'selector-settled',tabId:target.tabId,ok:false,error:String(error)});throw error});
    };
    p.updated=(tabId,change)=>{if(p.tabIds.includes(tabId)&&Object.hasOwn(change,'groupId'))push({kind:'group',tabId,groupId:change.groupId})};
    p.detached=tabId=>{if(p.tabIds.includes(tabId))push({kind:'move',tabId})};
    p.debuggerDetached=source=>{if(p.tabIds.includes(source.tabId))push({kind:'debugger-detach',tabId:source.tabId})};
    chrome.tabs.onUpdated.addListener(p.updated);chrome.tabs.onDetached.addListener(p.detached);
    chrome.debugger.onDetach.addListener(p.debuggerDetached);chrome.debugger.sendCommand=p.wrapper;
  })()`);
}

async function journal(worker) {
  return worker.evaluate(`(()=>{const p=globalThis.__recoveryJournal;return{events:p.events,seenSelector:p.seenSelector,overflow:p.overflow}})()`);
}

async function removeJournal(worker) {
  await worker.evaluate(`(()=>{
    const p=globalThis.__recoveryJournal;if(!p)return;
    if(chrome.debugger.sendCommand!==p.wrapper)throw new Error('Recovery journal was replaced');
    chrome.debugger.sendCommand=p.original;chrome.tabs.onUpdated.removeListener(p.updated);
    chrome.tabs.onDetached.removeListener(p.detached);chrome.debugger.onDetach.removeListener(p.debuggerDetached);
    delete globalThis.__recoveryJournal;
  })()`);
}

async function holdInputs(browser, tab) {
  const point = await tab.evaluate("(()=>{const r=document.getElementById('held').getBoundingClientRect();return{x:r.x+r.width/2,y:r.y+r.height/2}})()");
  await browser.cdp.call(tab.id, "Input.dispatchMouseEvent", { type: "mouseMoved", ...point });
  await browser.cdp.call(tab.id, "Input.dispatchMouseEvent", { type: "mousePressed", ...point, button: "left", buttons: 1, clickCount: 1 });
  await browser.cdp.call(tab.id, "Input.dispatchKeyEvent", { type: "keyDown", key: "Shift", code: "ShiftLeft", windowsVirtualKeyCode: 16, modifiers: 8 });
}

function assertReleased(state) {
  assert.ok(state.events.some(event => event.type === "pointerdown" && event.trusted));
  assert.ok(state.events.some(event => event.type === "pointerup" && event.trusted && event.buttons === 0), "native pointer release missing");
  assert.ok(state.events.some(event => event.type === "keyup" && event.trusted && event.key === "Shift"), "native key release missing");
  assert.equal(state.heldCapture, false, "native pointer capture survived revocation");
}

async function assertDetached(worker, until, tabIds) {
  return until(async () => {
    const targets = await worker.evaluate("chrome.debugger.getTargets()");
    const observed = tabIds.map(tabId => {
      const target = targets.find(target => target.tabId === tabId);
      return { tabId, present: !!target, attached: target?.attached === true };
    });
    return observed.every(target => !target.attached) ? observed : false;
  }, "old native attachments released", 10000);
}

function pendingClick(tab) {
  const started = Date.now();
  const pending = tab.locator("#late-action").click({ timeoutMs: 15000 }).then(
    () => ({ succeeded: true, elapsedMs: Date.now() - started }),
    error => ({ error: error.message, elapsedMs: Date.now() - started })
  ).then(outcome => { pending.outcome = outcome; return outcome; });
  return pending;
}

async function assertPending(worker, pending) {
  const native = await journal(worker);
  assert.equal(pending.outcome, undefined, "action settled before the revocation stimulus");
  assert.equal(native.seenSelector, true);
  assert.equal(native.events.some(event => event.kind === "selector-settled" && !event.ok), false, "locator native call failed before revocation");
  return { actionPending: true, native };
}

function assertCancelled(outcome) {
  assert.ok(outcome.error, "old click succeeded after revocation");
  assert.doesNotMatch(outcome.error, /15000ms exceeded|timed out after 15000/i, "revocation only waited for the action timeout");
  assert.ok(outcome.elapsedMs < 10000, "revocation did not promptly cancel the action");
}

async function cleanup(detail, operations, saveDetail = async () => {}) {
  const failures = [];
  for (const operation of operations) {
    try { await operation(); } catch (error) { failures.push(error); }
  }
  if (failures.length) detail.cleanupErrors = failures.map(error => error.stack ?? String(error));
  try { await saveDetail(detail); } catch (error) { failures.push(error); }
  if (failures.length) throw new AggregateError(failures, `Recovery fixture cleanup failed${detail.error ? ` after: ${detail.error}` : ""}`);
}

const removeTabs = (worker, ids) => worker.evaluate(`Promise.all(${JSON.stringify(ids ?? [])}.map(id=>chrome.tabs.remove(id).catch(error=>{if(!/No tab|Invalid tab/i.test(String(error)))throw error})))`);

export async function checkOwnedTabRevocation({ connect, fixtureURL, worker, until, createWindow, closeWindow, saveDetail }) {
  const detail = { observation: "exact synthetic tab scripting reads; no SDK reattachment", scenarios: [] };
  try {
    for (const kind of ["ungroup", "foreign-group", "move-window"]) {
      let owner, foreign, popup, pending, probeInstalled = false;
      const scenario = { kind }; detail.scenarios.push(scenario);
      try {
        owner = await connect(`revocation-${kind}`); foreign = await connect(`revocation-destination-${kind}`);
        const a = await owner.newTab({ url: fixtureURL + "lifecycle-recovery" });
        const b = await owner.newTab({ url: fixtureURL + "lifecycle-recovery" });
        const anchor = await foreign.newTab({ url: fixtureURL + "lifecycle-recovery" });
        scenario.tabIds = [a.id, b.id];
        const originalTabs = await worker.evaluate(`Promise.all([${a.id},${b.id}].map(id=>chrome.tabs.get(id)))`);
        await a.domSnapshot(); await holdInputs(owner, b);
        scenario.before = await pageState(worker, b.id); assert.equal(scenario.before.heldCapture, true);
        await installJournal(worker, scenario.tabIds); probeInstalled = true;
        pending = pendingClick(a);
        await until(async () => (await journal(worker)).seenSelector, "real pending locator selector query");
        if (kind === "move-window") popup = await createWindow(fixtureURL + "lifecycle-recovery?auxiliary=ownership-move");
        scenario.preRevocation = await assertPending(worker, pending);
        if (kind === "foreign-group") scenario.destinationGroupId = await worker.evaluate(`chrome.tabs.get(${anchor.id}).then(tab=>tab.groupId)`);
        scenario.revokedAt = Date.now();
        if (kind === "ungroup") await worker.evaluate(`chrome.tabs.ungroup(${JSON.stringify(scenario.tabIds)})`);
        else if (kind === "foreign-group") await worker.evaluate(`chrome.tabs.get(${anchor.id}).then(tab=>chrome.tabs.group({tabIds:${JSON.stringify(scenario.tabIds)},groupId:tab.groupId}))`);
        else await worker.evaluate(`chrome.tabs.move(${JSON.stringify(scenario.tabIds)},{windowId:${popup.id},index:-1})`);
        await pageState(worker, a.id, true);
        scenario.pending = await pending; assertCancelled(scenario.pending);
        scenario.detachedTargets = await assertDetached(worker, until, scenario.tabIds);
        scenario.after = await pageState(worker, b.id); assertReleased(scenario.after);
        scenario.actionPage = await pageState(worker, a.id); assert.equal(scenario.actionPage.lateClicks, 0);
        await assert.rejects(owner.cdp.call(a.id, "Runtime.evaluate", { expression: "globalThis.lateClicks++" }), error => {
          scenario.oldOwnerError = error.message; return /not part|ownership|OBU_/i.test(error.message);
        });
        scenario.tabs = await worker.evaluate(`Promise.all(${JSON.stringify(scenario.tabIds)}.map(id=>chrome.tabs.get(id)))`);
        for (const tab of scenario.tabs) {
          assert.equal(tab.active, false, "revocation activated a task tab");
          if (kind === "ungroup") { assert.equal(tab.groupId, -1); assert.equal(tab.windowId, originalTabs[0].windowId); }
          if (kind === "foreign-group") assert.equal(tab.groupId, scenario.destinationGroupId);
          if (kind === "move-window") assert.equal(tab.windowId, popup.id);
        }
        scenario.native = await journal(worker); assert.equal(scenario.native.overflow, false);
        assert.ok(scenario.native.events.some(event => event.kind === "group" || event.kind === "move"));
        // Only an explicit new claim may resume control. Reuse the exact page,
        // and prove the previously admitted click was not replayed.
        if (kind === "foreign-group") await worker.evaluate(`chrome.tabs.ungroup(${a.id})`);
        await owner.client.claimUserTab(a.id);
        await a.getByLabel("Name").fill("explicitly reclaimed");
        scenario.reclaimed = await pageState(worker, a.id);
        assert.equal(scenario.reclaimed.name, "explicitly reclaimed"); assert.equal(scenario.reclaimed.lateClicks, 0);
      } catch (error) { scenario.error = error.stack; throw error; }
      finally {
        // Finalization does not own tabs already released to the user. Close
        // exact fixture IDs separately after recording all behavior.
        await cleanup(scenario, [
          async () => { if (probeInstalled) scenario.native ??= await journal(worker); },
          () => probeInstalled && removeJournal(worker),
          () => owner?.client.finalizeTabs([]), () => foreign?.client.finalizeTabs([]),
          () => owner?.close(), () => foreign?.close(),
          () => removeTabs(worker, scenario.tabIds), () => popup && closeWindow(popup.id),
          () => pending
        ]);
      }
    }
    return detail;
  } catch (error) { detail.error = error.stack; throw error; }
  finally { await saveDetail(detail); }
}

export async function checkNativeHostRestart({ connect, fixtureURL, worker, until, restartHost, saveDetail }) {
  const sessionId = "native-host-recovery";
  const detail = { observation: "same real browser/worker; actual native host process termination and replacement" };
  let owner, recovered, pending, probeInstalled = false;
  try {
    owner = await connect(sessionId);
    const a = await owner.newTab({ url: fixtureURL + "lifecycle-recovery" });
    const b = await owner.newTab({ url: fixtureURL + "lifecycle-recovery" });
    detail.tabIds = [a.id, b.id]; detail.oldEpoch = owner.client.controlEpoch; detail.oldTurn = owner.client.turnId;
    await a.domSnapshot(); await holdInputs(owner, b);
    detail.before = await pageState(worker, b.id); assert.equal(detail.before.heldCapture, true);
    await installJournal(worker, detail.tabIds); probeInstalled = true;
    pending = pendingClick(a);
    await until(async () => (await journal(worker)).seenSelector, "real pending locator before host termination");
    detail.preDisconnect = await assertPending(worker, pending);
    detail.restart = await restartHost();
    detail.pending = await pending; assertCancelled(detail.pending);
    await pageState(worker, a.id, true);
    detail.detachedTargets = await assertDetached(worker, until, detail.tabIds);
    detail.after = await pageState(worker, b.id); assertReleased(detail.after);
    detail.actionPage = await pageState(worker, a.id); assert.equal(detail.actionPage.lateClicks, 0);
    recovered = await connect(sessionId);
    await recovered.client.beginTurn();
    detail.newEpoch = recovered.client.controlEpoch;
    assert.ok(detail.newEpoch > detail.oldEpoch, "host reconnect retained the old control epoch");
    await assert.rejects(recovered.client.request("getTabs", { turn_id: detail.oldTurn, control_epoch: detail.oldEpoch }), error => {
      detail.staleEpochError = error.message; return /OBU_STALE_CONTROL_EPOCH|OBU_CONTROL_BOOTSTRAP_REQUIRED/.test(error.message);
    });
    assert.ok((await recovered.getTabs()).some(tab => tab.id === a.id), "host reconnect lost same-browser tab ownership");
    await recovered.tab(a.id).getByLabel("Name").fill("explicitly reconnected");
    detail.recovered = await pageState(worker, a.id);
    assert.equal(detail.recovered.name, "explicitly reconnected"); assert.equal(detail.recovered.lateClicks, 0);
    detail.native = await journal(worker); assert.equal(detail.native.overflow, false);
    return detail;
  } catch (error) { detail.error = error.stack; throw error; }
  finally {
    await cleanup(detail, [
      async () => { if (probeInstalled) detail.native ??= await journal(worker); },
      () => probeInstalled && removeJournal(worker),
      () => recovered?.client.finalizeTabs([]), () => recovered?.close(), () => owner?.close(),
      () => removeTabs(worker, detail.tabIds), () => pending
    ], saveDetail);
  }
}

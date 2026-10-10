export function pauseFixture() {
  return `<!doctype html><meta charset="utf-8"><title>Pause fixture</title>
    <style>button,input{display:block;margin:25px;padding:15px}</style>
    <button id="held">Hold pointer</button><label>Name<input id="name"></label>
    <script>globalThis.events=[];for(const type of ['pointerdown','pointerup','pointermove','click','keydown','keyup'])document.addEventListener(type,event=>{events.push({type,trusted:event.isTrusted,buttons:event.buttons,key:event.key,pointerId:event.pointerId,target:event.target.id});if(type==='pointerdown')event.target.setPointerCapture(event.pointerId)});</script>`;
}

export async function checkGlobalPause({ connectBrowser, getWorker, connectPage, popupURL, windowId, fixtureURL, restartWorker, capture, saveDetail, assert, until, traceFocus = async () => {} }) {
  const first = await connectBrowser("pause-first"), second = await connectBrowser("pause-second");
  let forgedPage, forgedTab, popup;
  const detail = {};
  try {
    await traceFocus("pause-fixture:start");
    await getWorker().evaluate(`globalThis.__pauseTargets=[];
      chrome.debugger.onEvent.addListener((source,method,params)=>{if(method==='Target.attachedToTarget'&&__pauseTargets.length<100)__pauseTargets.push({source,method,params})});
      chrome.tabs.onCreated.addListener(tab=>{if(__pauseTargets.length<100)__pauseTargets.push({createdTab:tab})})`);
    const a = await first.newTab({ url: fixtureURL + "pause-fixture" });
    const b = await second.newTab({ url: fixtureURL + "pause-fixture" });
    forgedTab = await getWorker().evaluate(`chrome.tabs.create({url:${JSON.stringify(popupURL)},active:false})`);
    forgedPage = await connectPage(popupURL);
    await until(() => forgedPage.evaluate('typeof chrome.runtime?.sendMessage==="function"'), "ordinary extension tab runtime");
    detail.forgedTab = await forgedPage.evaluate(`Promise.all([
      chrome.runtime.sendMessage({type:'PAUSE_AUTOMATION'}),
      chrome.runtime.sendMessage({type:'RESUME_AUTOMATION',expectedRevision:0})])`);
    assert.ok(detail.forgedTab.every(result => result.ok === false && /OBU_CONTROL_FORBIDDEN/.test(result.error)));
    detail.protectedRoutes = {};
    const rejectProtected = async (name, operation) => assert.rejects(operation, error => {
      detail.protectedRoutes[name] = error.message;
      return /OBU_EXTENSION_UI_PROTECTED/.test(error.message);
    });
    await rejectProtected("claim", first.client.claimUserTab(forgedTab.id));
    // Simulate a user manually moving this page into the agent's group. The
    // source restriction must still hold after the ownership check succeeds.
    await getWorker().evaluate(`chrome.tabs.get(${a.id}).then(tab=>chrome.tabs.group({tabIds:${forgedTab.id},groupId:tab.groupId}))`);
    await rejectProtected("attach", first.client.attach(forgedTab.id));
    await rejectProtected("goto", a.goto(popupURL));
    await rejectProtected("rawNavigate", first.cdp.call(a.id, "Page.navigate", { url: popupURL }));
    await getWorker().evaluate(`chrome.tabs.remove(${forgedTab.id})`); forgedTab = null;
    forgedPage.close(); forgedPage = null;
    detail.forgedContentScript = await getWorker().evaluate(`chrome.scripting.executeScript({target:{tabId:${a.id}},world:'ISOLATED',func:async()=>Promise.all([
      chrome.runtime.sendMessage({type:'PAUSE_AUTOMATION'}),
      chrome.runtime.sendMessage({type:'RESUME_AUTOMATION',expectedRevision:0})])}).then(results=>results[0].result)`);
    assert.ok(detail.forgedContentScript.every(result => result.ok === false && /OBU_CONTROL_FORBIDDEN/.test(result.error)));
    await assert.rejects(first.client.request("resumeAutomation", { expectedRevision: 0 }), /unknown|unsupported|not.*allowed|method.*found|No handler registered/i);
    detail.stage = "hold raw pointer and key";
    const point = await b.evaluate("(()=>{const rect=held.getBoundingClientRect();return{x:rect.x+rect.width/2,y:rect.y+rect.height/2}})()");
    await second.cdp.call(b.id, "Input.dispatchMouseEvent", { type: "mouseMoved", ...point });
    await second.cdp.call(b.id, "Input.dispatchMouseEvent", { type: "mousePressed", ...point, button: "left", buttons: 1, clickCount: 1 });
    for (const type of ["dragEnter", "dragOver", "dragCancel"]) {
      await second.cdp.call(b.id, "Input.dispatchDragEvent", { type, ...point, data: { items: [], dragOperationsMask: 1 } });
    }
    detail.afterDragCancel = await b.evaluate("({events:[...events],captured:held.hasPointerCapture(events.find(event=>event.type==='pointerdown').pointerId)})");
    assert.equal(detail.afterDragCancel.captured, true, "native dragCancel unexpectedly released the held pointer; update the fixture's precondition");
    await second.cdp.call(b.id, "Input.dispatchKeyEvent", { type: "keyDown", key: "Shift", code: "ShiftLeft", windowsVirtualKeyCode: 16, modifiers: 8 });
    const pending = a.locator("#never-present").click({ timeoutMs: 15000 }).then(() => ({ succeeded: true }), error => ({ error: error.message }));
    detail.stage = "open action popup";
    await traceFocus("action-popup:before-open");
    await getWorker().evaluate(`chrome.action.openPopup({windowId:${windowId}})`);
    await traceFocus("action-popup:after-open");
    detail.stage = "connect action popup";
    popup = await connectPage(popupURL);
    const view = () => popup.evaluate(`({state:document.querySelector('#automation-status-label')?.textContent,revision:Number(document.querySelector('#automation-status-pill')?.dataset.revision),button:document.querySelector('#automation-toggle')?.textContent,disabled:document.querySelector('#automation-toggle')?.disabled,hint:document.querySelector('#automation-hint')?.textContent})`);
    detail.stage = "read Running popup";
    await until(async () => (await view()).state === "Running", "real popup Running");
    detail.popupContexts = await getWorker().evaluate("chrome.runtime.getContexts({contextTypes:['POPUP']})");
    assert.ok(detail.popupContexts.some(context => context.documentUrl === popupURL && context.contextType === "POPUP"));
    await capture("popup-running", popup);
    const before = await popup.evaluate("chrome.runtime.sendMessage({type:'GET_AUTOMATION_CONTROL_STATUS'})");
    detail.before = before.status;
    const pauseStarted = Date.now();
    detail.stage = "pause from real popup";
    await traceFocus("pause:before-toggle");
    await popup.evaluate("document.querySelector('#automation-toggle').click()");
    await until(async () => (await view()).state === "Paused", "real popup Paused");
    await traceFocus("pause:after-paused");
    detail.pauseElapsedMs = Date.now() - pauseStarted;
    detail.pending = await pending;
    assert.match(detail.pending.error, /paused|ended|cancel|stale/i);
    assert.ok(detail.pauseElapsedMs < 10000, "pause did not promptly cancel in-flight work");
    await capture("popup-paused", popup);
    detail.paused = (await popup.evaluate("chrome.runtime.sendMessage({type:'GET_AUTOMATION_CONTROL_STATUS'})")).status;
    assert.equal(detail.paused.inputBlocked, true); assert.equal(detail.paused.cleanupComplete, true);
    for (const browser of [first, second]) await assert.rejects(browser.client.createTab(), /OBU_AUTOMATION_PAUSED/);
    await assert.rejects(second.cdp.call(b.id, "Runtime.evaluate", { expression: "document.querySelector('#name').value='must not run'" }), /OBU_AUTOMATION_PAUSED/);
    await assert.rejects(second.client.request("executeCdp", { target: { tabId: b.id }, method: "Runtime.evaluate", commandParams: { expression: "document.querySelector('#name').value='must not run either'" } }), /OBU_AUTOMATION_PAUSED/);
    detail.stage = "restart paused worker";
    await traceFocus("paused-worker:before-restart");
    detail.restart = await restartWorker(popup);
    await traceFocus("paused-worker:after-restart");
    await until(async () => (await view()).state === "Paused", "persisted pause after worker restart");
    detail.afterRestart = (await popup.evaluate("chrome.runtime.sendMessage({type:'GET_AUTOMATION_CONTROL_STATUS'})")).status;
    assert.equal(detail.afterRestart.inputBlocked, true);
    await assert.rejects(first.client.createTab(), /OBU_AUTOMATION_PAUSED/);
    detail.staleResume = await popup.evaluate(`chrome.runtime.sendMessage({type:'RESUME_AUTOMATION',expectedRevision:${before.status.revision}})`);
    assert.equal(detail.staleResume.ok, false); assert.match(detail.staleResume.error, /OBU_CONTROL_REVISION_CONFLICT/);
    await until(async () => (await view()).revision === detail.afterRestart.revision, "popup current revision after worker restart");
    await traceFocus("resume:before-toggle");
    await popup.evaluate("document.querySelector('#automation-toggle').click()");
    detail.stage = "resume from real popup";
    await until(async () => (await view()).state === "Running", "real popup resumed Running");
    await traceFocus("resume:after-running");
    assert.match((await view()).hint, /ask your agent to continue/);
    for (const browser of [first, second]) await assert.rejects(browser.client.getTabs(), /OBU_STALE_CONTROL_EPOCH|OBU_CONTROL_BOOTSTRAP_REQUIRED/);
    await first.client.beginTurn(); await second.client.beginTurn();
    detail.releasedEvents = await b.evaluate("events");
    assert.ok(detail.releasedEvents.some(event => event.type === "pointerup" && event.trusted && event.buttons === 0), "pause did not release held raw pointer");
    assert.ok(detail.releasedEvents.some(event => event.type === "keyup" && event.trusted && event.key === "Shift"), "pause did not release held raw key");
    assert.equal(await b.evaluate("held.hasPointerCapture(events.find(event=>event.type==='pointerdown').pointerId)"), false, "pause left native pointer capture active");
    await b.mouse.move(point.x + 5, point.y + 5);
    const moves = (await b.evaluate("events")).filter(event => event.type === "pointermove");
    assert.equal(moves.at(-1).buttons, 0);
    assert.equal(await b.getByLabel("Name").inputValue(), "");
    await a.getByLabel("Name").fill("explicitly resumed");
    assert.equal(await a.getByLabel("Name").inputValue(), "explicitly resumed");
    await traceFocus("resumed-actions:complete");
    await first.client.finalizeTabs([]); await second.client.finalizeTabs([]);
    await traceFocus("pause-fixture:finalized");
    detail.stage = "complete";
    return detail;
  } catch (error) {
    detail.error = error.stack;
    try { detail.targetTrace = await getWorker().evaluate("(async()=>({events:globalThis.__pauseTargets,contexts:await chrome.runtime.getContexts({})}))()"); } catch {}
    if (popup) {
      try {
        detail.failedState = await popup.evaluate("chrome.runtime.sendMessage({type:'GET_AUTOMATION_CONTROL_STATUS'})");
        await capture("popup-at-failure", popup);
      } catch {}
    }
    throw error;
  } finally {
    await saveDetail(detail);
    first.close(); second.close(); forgedPage?.close();
    if (forgedTab) await getWorker().evaluate(`chrome.tabs.remove(${forgedTab.id})`).catch(() => {});
    if (popup) {
      await traceFocus("action-popup:before-close");
      try { await popup.evaluate("window.close()"); } catch {} popup.close();
      await traceFocus("action-popup:after-close");
    }
  }
}

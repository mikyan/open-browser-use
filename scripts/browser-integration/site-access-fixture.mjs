export function siteAccessFixture(route, port, query) {
  if (route === "/site-access-child") return '<!doctype html><meta charset="utf-8"><p>Blocked embedded content</p>';
  const frame = query.has("mixed") ? `<iframe src="http://localhost:${port}/site-access-child"></iframe>` : "";
  return `<!doctype html><meta charset="utf-8"><title>Website access fixture</title>
    <style>body{font:16px sans-serif;margin:30px}input,button{padding:12px;margin:10px}iframe{width:400px;height:100px}</style>
    <h1>Website access fixture</h1><label>Allowed field<input id="allowed-field"></label>
    <button id="allowed-click">Allowed action</button><output id="trusted-click"></output>${frame}
    <script>document.querySelector('#allowed-click').onclick=event=>document.querySelector('#trusted-click').textContent=String(event.isTrusted);</script>`;
}

export async function checkSiteAccess({ connectBrowser, getWorker, connectPage, popupURL, windowId,
  fixtureURL, restartWorker, capture, saveDetail, assert, until, traceFocus }) {
  const browser = await connectBrowser("site-access");
  const allowedOrigin = new URL(fixtureURL).origin;
  const blockedOrigin = allowedOrigin.replace("127.0.0.1", "localhost");
  const allowedURL = `${allowedOrigin}/site-access`, blockedURL = `${blockedOrigin}/site-access`;
  const detail = { allowedOrigin, blockedOrigin, denied: {} };
  let popup, forgedPage, forgedTab, unownedBlockedTab, pending;
  const policyError = /OBU_SITE_ACCESS_(?:DENIED|UNVERIFIED|UNSUPPORTED)/;
  const view = () => popup.evaluate(`({mode:document.querySelector('#site-access-mode').value,text:document.querySelector('#site-access-origins').value,
    status:document.querySelector('#site-access-status').textContent,revision:Number(document.querySelector('#site-access-status').dataset.revision),
    disabled:document.querySelector('#site-access-apply').disabled,error:document.querySelector('#site-access-error').textContent,
    automation:document.querySelector('#automation-status-label').textContent})`);
  const readPolicy = async () => {
    const response = await popup.evaluate("chrome.runtime.sendMessage({type:'GET_SITE_ACCESS_POLICY'})");
    assert.equal(response.ok, true, JSON.stringify(response));
    return response.policy;
  };
  async function apply(mode, origins) {
    const before = await readPolicy();
    await popup.evaluate("document.querySelector('#site-access-reload').click()");
    await until(async () => { const value = await view(); return value.revision === before.revision && value.status === "Saved"; }, "fresh website settings");
    await popup.evaluate(`(()=>{const mode=document.querySelector('#site-access-mode'),text=document.querySelector('#site-access-origins');
      mode.value=${JSON.stringify(mode)};mode.dispatchEvent(new Event('change',{bubbles:true}));
      text.value=${JSON.stringify(origins.join("\n"))};text.dispatchEvent(new Event('input',{bubbles:true}));
      document.querySelector('#site-access-apply').click()})()`);
    await until(async () => { const value = await view(); if (value.error) throw new Error(value.error); return value.status === "Saved" && value.revision > before.revision; }, "website policy save", 15000);
    const result = await readPolicy();
    assert.equal(result.mode, mode); assert.deepEqual(result.origins, origins); assert.equal(result.ready, true);
    const automation = await popup.evaluate("chrome.runtime.sendMessage({type:'GET_AUTOMATION_CONTROL_STATUS'})");
    assert.equal(automation.status.state, "paused"); assert.equal(automation.status.inputBlocked, true);
    assert.equal(automation.status.cleanupComplete, true);
    return result;
  }
  async function resume() {
    await until(async () => (await view()).automation === "Paused", "paused website settings UI");
    await popup.evaluate("document.querySelector('#automation-toggle').click()");
    await until(async () => (await view()).automation === "Running", "explicit user resume");
  }
  const denied = async (name, operation) => assert.rejects(operation, error => {
    detail.denied[name] = error.message;
    return policyError.test(error.message);
  });
  try {
    detail.stage = "prepare permitted and blocked pages";
    const allowed = await browser.newTab({ url: allowedURL });
    const mixed = await browser.newTab({ url: `${allowedURL}?mixed=1` });
    const redirected = await browser.newTab({ url: allowedURL });
    unownedBlockedTab = await getWorker().evaluate(`chrome.tabs.create({url:${JSON.stringify(blockedURL)},active:false})`);
    await until(async () => (await getWorker().evaluate(`chrome.tabs.get(${unownedBlockedTab.id})`)).status === "complete", "unowned blocked page");

    detail.stage = "reject ordinary extension page and content senders";
    forgedTab = await getWorker().evaluate(`chrome.tabs.create({url:${JSON.stringify(popupURL)},active:false})`);
    forgedPage = await connectPage(popupURL);
    await until(() => forgedPage.evaluate('typeof chrome.runtime?.sendMessage==="function"'), "ordinary extension page loaded");
    const setter = { type: "SET_SITE_ACCESS_POLICY", policy: { mode: "block", origins: [allowedOrigin] }, expectedRevision: 0 };
    detail.forgedPage = await forgedPage.evaluate(`chrome.runtime.sendMessage(${JSON.stringify(setter)})`);
    assert.equal(detail.forgedPage.ok, false); assert.match(detail.forgedPage.error, /OBU_CONTROL_FORBIDDEN/);
    forgedPage.close(); forgedPage = null;
    await getWorker().evaluate(`chrome.tabs.remove(${forgedTab.id})`); forgedTab = null;
    detail.forgedContent = await getWorker().evaluate(`chrome.scripting.executeScript({target:{tabId:${allowed.id}},world:'ISOLATED',func:async(message)=>chrome.runtime.sendMessage(message),args:[${JSON.stringify({ ...setter, sender: { id: "forged-extension-id", url: popupURL } })}]}).then(results=>results[0].result)`);
    assert.equal(detail.forgedContent.ok, false); assert.match(detail.forgedContent.error, /OBU_CONTROL_FORBIDDEN/);
    await assert.rejects(browser.client.request("setSiteAccessPolicy", setter), /unknown|unsupported|not.*allowed|method.*found|No handler registered/i);

    detail.stage = "open actual action popup";
    await allowed.domSnapshot();
    let pendingOutcome;
    pending = allowed.locator("#site-never").click({ timeoutMs: 30000 }).then(() => pendingOutcome = { succeeded: true }, error => pendingOutcome = { error: error.message });
    await traceFocus("action-popup:before-open");
    await getWorker().evaluate(`chrome.action.openPopup({windowId:${windowId}})`);
    await traceFocus("action-popup:after-open");
    popup = await connectPage(popupURL);
    await until(async () => (await view()).status === "Saved", "initial real website settings");
    detail.initial = await readPolicy();
    assert.equal(detail.initial.mode, "all");
    assert.equal(pendingOutcome, undefined, "waiting click ended before policy application");
    await capture("site-access-all", popup);
    const previousEpoch = browser.client.controlEpoch;
    const started = Date.now();
    detail.allow = await apply("allow", [allowedOrigin]);
    await pending;
    detail.pending = pendingOutcome; detail.applyElapsedMs = Date.now() - started;
    assert.match(pendingOutcome.error, /paused|ended|cancel|stale/i);
    assert.ok(detail.applyElapsedMs < 15000, "policy save failed to promptly cancel the waiting click");
    await capture("site-access-only-listed", popup);
    await assert.rejects(allowed.getByLabel("Allowed field").fill("must not run"), /OBU_AUTOMATION_PAUSED/);
    await resume();
    await assert.rejects(allowed.domSnapshot(), /OBU_STALE_CONTROL_EPOCH|OBU_CONTROL_BOOTSTRAP_REQUIRED/);
    assert.equal(browser.client.controlEpoch, previousEpoch);
    await browser.client.beginTurn();

    detail.stage = "exercise restricted public actions";
    const blank = browser.tab(Number((await browser.client.createTab()).id));
    await denied("blankSnapshot", blank.domSnapshot());
    await blank.goto(allowedURL);
    await blank.getByLabel("Allowed field").fill("allowed blank bootstrap");
    assert.equal(await blank.getByLabel("Allowed field").inputValue(), "allowed blank bootstrap");
    detail.blankBootstrap = { tabId: blank.id, completed: true };
    await allowed.goto(allowedURL);
    await allowed.getByLabel("Allowed field").fill("permitted 中文");
    assert.equal(await allowed.getByLabel("Allowed field").inputValue(), "permitted 中文");
    await allowed.getByRole("button", { name: "Allowed action", exact: true }).click();
    assert.equal(await allowed.locator("#trusted-click").textContent(), "true");
    assert.match(await allowed.domSnapshot(), /Website access fixture/);
    detail.allowedScreenshot = await capture("site-access-allowed-page", await allowed.screenshot());
    await denied("goto", allowed.goto(blockedURL));
    await denied("claim", browser.client.claimUserTab(unownedBlockedTab.id));
    await denied("rawCDP", browser.client.request("executeCdp", { target: { tabId: allowed.id }, method: "Runtime.evaluate", commandParams: { expression: "document.querySelector('#allowed-field').value='forbidden'" } }));
    assert.equal(await allowed.getByLabel("Allowed field").inputValue(), "permitted 中文");
    await denied("mixedFrame", mixed.getByLabel("Allowed field").fill("must not run"));
    await denied("redirect", redirected.goto(`${allowedOrigin}/site-access-redirect`));
    await denied("redirectedSnapshot", redirected.domSnapshot());
    detail.mixedValue = await getWorker().evaluate(`chrome.scripting.executeScript({target:{tabId:${mixed.id}},func:()=>document.querySelector('#allowed-field').value}).then(results=>results[0].result)`);
    assert.equal(detail.mixedValue, "");

    detail.stage = "persist policy through worker restart";
    detail.restart = await restartWorker(popup);
    detail.afterRestart = await readPolicy();
    assert.deepEqual(detail.afterRestart, detail.allow);
    await assert.rejects(allowed.domSnapshot(), /OBU_STALE_CONTROL_EPOCH|OBU_CONTROL_BOOTSTRAP_REQUIRED/);
    await browser.client.beginTurn();
    await denied("blockedAfterRestart", allowed.goto(blockedURL));
    assert.equal(await allowed.getByLabel("Allowed field").inputValue(), "permitted 中文");

    detail.stage = "exercise block-list mode";
    detail.block = await apply("block", [blockedOrigin]);
    await capture("site-access-block-listed", popup);
    await resume(); await browser.client.beginTurn();
    await allowed.getByLabel("Allowed field").fill("block-list permits this origin");
    assert.equal(await allowed.getByLabel("Allowed field").inputValue(), "block-list permits this origin");
    await denied("blockListedGoto", allowed.goto(blockedURL));
    detail.stage = "complete";
    return detail;
  } catch (error) {
    detail.error = error.stack;
    if (popup) try { detail.failedView = await view(); await capture("site-access-failure", popup); } catch {}
    throw error;
  } finally {
    if (popup) {
      try {
        detail.restored = await apply("all", []);
        await resume(); await browser.client.beginTurn();
        await browser.client.finalizeTabs([]);
      } catch (error) { detail.restoreError = error.stack; }
      await traceFocus("site-access:before-close");
      try { await popup.evaluate("window.close()"); } catch {} popup.close();
      await traceFocus("site-access:after-close");
    }
    if (pending) await pending;
    browser.close(); forgedPage?.close();
    for (const tab of [forgedTab, unownedBlockedTab]) if (tab) await getWorker().evaluate(`chrome.tabs.remove(${tab.id})`).catch(() => {});
    await saveDetail(detail);
    if (detail.restoreError) throw new Error(`Website access fixture failed to restore all-sites mode: ${detail.restoreError}`);
  }
}

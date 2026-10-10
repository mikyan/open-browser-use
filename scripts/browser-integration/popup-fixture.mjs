// This fixture checks the real tabs.onCreated authorization path using an
// extension-created background child. It deliberately does not claim that
// renderer window.open/target=_blank preserves foreground focus: those native
// paths still activate the new tab/window, and moving an independent popup into
// the task group can leave its first rendering lease waiting without a frame.
export function popupFixture(port) {
  return `<!doctype html><meta charset="utf-8"><title>Child tab authorization</title>
    <button id="child-action" onclick="childClicks.push({trusted:event.isTrusted});document.querySelector('#child-result').textContent='clicked'">Child action</button>
    <output id="child-result"></output>
    <button onclick="fetch('/diagnostics/data?popup=1').then(response=>response.text()).then(()=>document.querySelector('#network-result').textContent='complete')">Popup request</button><output id="network-result"></output>
    <iframe id="popup-cross" src="http://localhost:${port}/frame"></iframe>
    <script>globalThis.childClicks=[];</script>`;
}

export async function checkChildTabAuthorization({ connectBrowser, getWorker, fixtureURL, assert, until, saveDetail = async () => {} }) {
  const browser = await connectBrowser("child-authorization");
  const foreign = await connectBrowser("child-foreign");
  let child;
  const detail = { scope: "background child-tab authorization; native popup focus/first-frame semantics remain unverified" };
  const attachment = async tabId => {
    const targets = await getWorker().evaluate("chrome.debugger.getTargets()");
    return targets.find(target => target.tabId === tabId)?.attached === true;
  };
  try {
    const opener = await browser.newTab({ url: fixtureURL + "popup-child-authorization" });
    await opener.domSnapshot(); // The CRX opener must actually be attached.
    assert.equal(await attachment(opener.id), true);
    child = await getWorker().evaluate(`chrome.tabs.create({url:${JSON.stringify(fixtureURL + "popup-child-authorization?child=1")},openerTabId:${opener.id},active:false})`);
    await until(() => getWorker().evaluate(`chrome.tabs.get(${child.id}).then(tab=>tab.status==='complete')`), "loaded background child tab");
    // An explicit ungroup prevents any browser-specific group inheritance from
    // accidentally authorizing the new tab before the public claim operation.
    if (child.groupId !== -1) await getWorker().evaluate(`chrome.tabs.ungroup(${child.id})`);
    detail.openerId = opener.id;
    detail.childId = child.id;
    detail.openerTabId = child.openerTabId;
    assert.equal(child.openerTabId, opener.id);
    assert.equal(child.active, false);
    await assert.rejects(browser.tab(child.id).domSnapshot(), /not part of browser session/);
    detail.attachedBeforeClaim = await attachment(child.id);
    assert.equal(detail.attachedBeforeClaim, false, "onCreated must not bypass backend attachment authorization");
    await browser.client.claimUserTab(child.id);
    const controlled = browser.tab(child.id);
    detail.snapshot = await controlled.domSnapshot();
    assert.match(detail.snapshot, /button "Child action"/);
    assert.equal(await controlled.locator("#child-result").textContent(), "");
    await controlled.getByRole("button", { name: "Child action", exact: true }).click();
    detail.result = await controlled.locator("#child-result").textContent();
    assert.equal(detail.result, "clicked");
    detail.attachedAfterClaim = await attachment(child.id);
    assert.equal(detail.attachedAfterClaim, true);
    await assert.rejects(foreign.tab(child.id).domSnapshot(), /not part of browser session/);
    detail.foreignRejected = true;
    await browser.client.turnEnded();
    detail.attachedAfterEnd = await attachment(child.id);
    assert.equal(detail.attachedAfterEnd, false, "the authorized child attachment must participate in normal control cleanup");
    await saveDetail(detail);
    return detail;
  } finally {
    try { await browser.client.finalizeTabs([]); } finally {
      if (child?.id) await getWorker().evaluate(`chrome.tabs.remove(${child.id}).catch(()=>{})`).catch(() => {});
      browser.close(); foreign.close();
    }
  }
}

const ownershipError = /OBU_AUXILIARY_|not part of browser session|already part of browser session/i;

async function isAttached(getWorker, tabId) {
  return (await getWorker().evaluate("chrome.debugger.getTargets()")).some(target => target.tabId === tabId && target.attached);
}

// A real Chrome popup window created unfocused separates ownership/rendering
// from renderer window.open's still-unresolved initial foreground activation.
export async function checkAuxiliaryPopupRendering({ connectBrowser, getWorker, fixtureURL, createPopup, closePopup, assert, until, saveDetail, saveScreenshot }) {
  const browser = await connectBrowser("auxiliary-rendering"), foreign = await connectBrowser("auxiliary-foreign");
  let popup;
  const detail = { scope: "explicit claim in a real unfocused popup; renderer-created foreground behavior remains outside this case" };
  try {
    detail.auxiliaryTabsVersion = (await browser.client.getInfo()).metadata.auxiliaryTabsVersion;
    assert.equal(detail.auxiliaryTabsVersion, 1);
    const opener = await browser.newTab({ url: fixtureURL + "popup-child-authorization" });
    await opener.domSnapshot();
    popup = await createPopup(fixtureURL + "popup-child-authorization?auxiliary=rendering");
    const tabId = popup.tabs[0].id, controlled = browser.tab(tabId);
    detail.before = { tab: popup.tabs[0], window: { id: popup.id, type: popup.type, focused: popup.focused } };
    await until(() => getWorker().evaluate(`chrome.tabs.get(${tabId}).then(tab=>tab.status==='complete')`), "unfocused popup loaded");
    await assert.rejects(controlled.domSnapshot(), ownershipError);
    assert.equal(await isAttached(getWorker, tabId), false);
    await browser.client.claimUserTab(tabId);
    // The first engine operation after claim is the exact click that previously
    // stalled after a cross-window group move. It is never retried.
    const started = Date.now();
    await controlled.getByRole("button", { name: "Child action", exact: true }).click({ timeoutMs: 10000 });
    detail.firstClickMs = Date.now() - started;
    assert.equal(await controlled.locator("#child-result").textContent(), "clicked");
    detail.firstClickEvents = await controlled.evaluate("childClicks");
    assert.deepEqual(detail.firstClickEvents, [{ trusted: true }]);
    detail.screenshot = await saveScreenshot("auxiliary-popup", await controlled.screenshot({ timeoutMs: 10000 }), controlled);
    assert.match(await controlled.domSnapshot(), /button "Child action"/);
    const rawTab = await getWorker().evaluate(`chrome.tabs.get(${tabId})`);
    const rawWindow = await getWorker().evaluate(`chrome.windows.get(${popup.id})`);
    assert.equal(rawTab.windowId, popup.id); assert.equal(rawTab.groupId, -1);
    assert.equal(rawWindow.type, "popup"); assert.equal(rawWindow.focused, false);
    const listed = await browser.getTabs(); assert.equal(listed.filter(tab => tab.id === tabId).length, 1); assert.ok(listed.some(tab => tab.id === opener.id));
    await browser.client.claimUserTab(tabId); assert.equal((await browser.getTabs()).filter(tab => tab.id === tabId).length, 1);
    await assert.rejects(foreign.client.claimUserTab(tabId), ownershipError);
    await assert.rejects(foreign.tab(tabId).domSnapshot(), ownershipError);
    const target = (await getWorker().evaluate("chrome.debugger.getTargets()")).find(target => target.tabId === tabId);
    const command = { target: { targetId: target.id }, method: "Runtime.evaluate", commandParams: { expression: "document.title", returnByValue: true } };
    assert.equal((await browser.client.request("executeCdp", command)).result.value, "Child tab authorization");
    await assert.rejects(foreign.client.request("executeCdp", command), ownershipError);
    const response = await controlled.expectResponse({ url: fixtureURL + "diagnostics/data?popup=1", status: 200 }, { timeoutMs: 5000 });
    await controlled.getByRole("button", { name: "Popup request", exact: true }).click();
    detail.network = await response.result(); await response.cancel();
    assert.equal(detail.network.frameUrl, fixtureURL + "popup-child-authorization?auxiliary=rendering");
    const child = controlled.frameLocator("#popup-cross");
    await child.getByLabel("Frame field").fill("Popup OOPIF");
    await child.getByRole("button", { name: "Frame action", exact: true }).click();
    assert.equal(await child.locator("#frame-result").textContent(), "clicked");
    assert.equal(await child.getByLabel("Frame field").inputValue(), "Popup OOPIF");
    assert.ok((await getWorker().evaluate("globalThis.__integrationFrames")).some(frame => frame.tabId === tabId), "Popup OOPIF was not observed as a child target");
    await browser.client.turnEnded();
    assert.equal(await isAttached(getWorker, tabId), false);
    assert.ok((await browser.getTabs()).some(tab => tab.id === tabId));
    detail.after = { tab: await getWorker().evaluate(`chrome.tabs.get(${tabId})`), window: await getWorker().evaluate(`chrome.windows.get(${popup.id})`) };
    assert.equal(detail.after.tab.windowId, popup.id); assert.equal(detail.after.window.type, "popup");
    await saveDetail("auxiliary-popup-rendering", detail);
    return detail;
  } catch (error) {
    detail.error = error.stack;
    detail.windowsAtFailure = await getWorker().evaluate("chrome.windows.getAll({populate:true})").catch(() => undefined);
    await saveDetail("auxiliary-popup-rendering", detail);
    throw error;
  } finally {
    try { await browser.client.finalizeTabs([]); await foreign.client.finalizeTabs([]); }
    finally { browser.close(); foreign.close(); if (popup) await closePopup(popup.id); }
  }
}

export async function checkAuxiliaryPopupLifecycle({ connectBrowser, getWorker, fixtureURL, createPopup, closePopup, sentinelWindowId, assert, until, saveDetail }) {
  const first = await connectBrowser("auxiliary-first"), second = await connectBrowser("auxiliary-second");
  const popups = [];
  const detail = {};
  let movedTabId;
  try {
    detail.auxiliaryTabsVersion = (await first.client.getInfo()).metadata.auxiliaryTabsVersion;
    assert.equal(detail.auxiliaryTabsVersion, 1);
    const popup = await createPopup(fixtureURL + "popup-child-authorization?auxiliary=lifecycle"); popups.push(popup);
    const tabId = popup.tabs[0].id;
    await until(() => getWorker().evaluate(`chrome.tabs.get(${tabId}).then(tab=>tab.status==='complete')`), "lifecycle popup loaded");
    const claims = await Promise.allSettled([first.client.claimUserTab(tabId), second.client.claimUserTab(tabId)]);
    assert.equal(claims.filter(result => result.status === "fulfilled").length, 1);
    const winner = claims[0].status === "fulfilled" ? first : second, loser = winner === first ? second : first;
    assert.match(String(claims.find(result => result.status === "rejected").reason), ownershipError);
    detail.claims = claims.map(result => result.status === "fulfilled" ? { status: result.status } : { status: result.status, error: String(result.reason) });
    await winner.tab(tabId).getByRole("button", { name: "Child action", exact: true }).click();
    const epoch = winner.client.controlEpoch;
    await assert.rejects(winner.client.finalizeTabs([{ tabId, status: "deliverable" }]), /handoff|deliverable|OBU_AUXILIARY/i);
    assert.equal(winner.client.controlEpoch, epoch); assert.equal(await isAttached(getWorker, tabId), true);
    assert.equal((await getWorker().evaluate(`chrome.tabs.get(${tabId})`)).windowId, popup.id);
    await winner.client.finalizeTabs([{ tabId, status: "handoff" }]);
    assert.equal(await isAttached(getWorker, tabId), false);
    assert.ok((await winner.getTabs()).some(tab => tab.id === tabId));
    await assert.rejects(loser.client.claimUserTab(tabId), ownershipError);
    await winner.client.finalizeTabs([]);
    assert.equal((await getWorker().evaluate(`chrome.tabs.get(${tabId})`)).windowId, popup.id);
    await loser.client.claimUserTab(tabId);
    await loser.tab(tabId).domSnapshot();
    // Model the user's external move, not a product claim-induced move. Do not
    // assert rendering recovery after it: the Chromium compositor issue remains.
    await getWorker().evaluate(`chrome.tabs.move(${tabId},{windowId:${sentinelWindowId},index:-1})`);
    movedTabId = tabId;
    await until(async () => !(await isAttached(getWorker, tabId)), "moved popup control released");
    await assert.rejects(loser.tab(tabId).domSnapshot(), ownershipError);
    // Native detach can settle before the final ownership write. A public end
    // acknowledgement drains that exact retirement before explicit reclamation.
    await loser.client.turnEnded();
    await winner.client.claimUserTab(tabId);
    assert.ok((await winner.getTabs()).some(tab => tab.id === tabId));
    detail.moved = await getWorker().evaluate(`chrome.tabs.get(${tabId})`);
    assert.equal(detail.moved.windowId, sentinelWindowId);
    const closed = await createPopup(fixtureURL + "popup-child-authorization?auxiliary=closed"); popups.push(closed);
    const closedId = closed.tabs[0].id;
    await loser.client.claimUserTab(closedId); await loser.tab(closedId).domSnapshot();
    await closePopup(closed.id);
    await until(async () => !(await loser.getTabs()).some(tab => tab.id === closedId), "closed window ownership removed");
    await assert.rejects(loser.tab(closedId).domSnapshot(), ownershipError);
    detail.handoffRetained = detail.omissionReleased = detail.closeInvalidated = true;
    await saveDetail("auxiliary-popup-lifecycle", detail);
    return detail;
  } catch (error) {
    detail.error = error.stack;
    detail.windowsAtFailure = await getWorker().evaluate("chrome.windows.getAll({populate:true})").catch(() => undefined);
    await saveDetail("auxiliary-popup-lifecycle", detail);
    throw error;
  } finally {
    try { await first.client.finalizeTabs([]); await second.client.finalizeTabs([]); }
    finally {
      first.close(); second.close();
      for (const popup of popups) await closePopup(popup.id);
      if (movedTabId) await getWorker().evaluate(`chrome.tabs.remove(${movedTabId}).catch(()=>{})`).catch(() => {});
    }
  }
}

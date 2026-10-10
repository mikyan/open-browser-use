// This fixture checks the real tabs.onCreated authorization path using an
// extension-created background child. It deliberately does not claim that
// renderer window.open/target=_blank preserves foreground focus: those native
// paths still activate the new tab/window, and moving an independent popup into
// the task group can leave its first rendering lease waiting without a frame.
export function popupFixture() {
  return `<!doctype html><meta charset="utf-8"><title>Child tab authorization</title>
    <button id="child-action" onclick="document.querySelector('#child-result').textContent='clicked'">Child action</button>
    <output id="child-result"></output>`;
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

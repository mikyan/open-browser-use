import assert from "node:assert/strict";
import { createHash } from "node:crypto";

const traceName = "__createdPageProvenance";
const ownershipError = /not part of browser session|already part of browser session|OBU_AUXILIARY_/i;
const scope = browser => {
  const value = { session_id: browser.client.sessionId, turn_id: browser.client.turnId, control_epoch: browser.client.controlEpoch };
  assert.ok(typeof value.session_id === "string" && value.session_id && typeof value.turn_id === "string" && value.turn_id);
  assert.ok(Number.isSafeInteger(value.control_epoch) && value.control_epoch >= 1, "Original production control epoch must be present"); return value;
};

// This is only a passive test observer, independent of the product waiter.
// Its sequence numbers belong to this one worker;
// native event timeStamp is preserved, never compared to another process clock.
export function installCreatedPageObserver(chrome, target) {
  if (target.__createdPageProvenance) throw new Error("Created page observer already installed");
  const allowed = new Set(), events = [], state = { sequence: 0, overflow: false, closed: false };
  const listener = details => {
    if (!allowed.has(details.sourceTabId) || state.closed) return;
    const sequence = ++state.sequence;
    if (events.length >= 64) { state.overflow = true; return; }
    events.push({ sequence, receivedAt: Date.now(), details: structuredClone(details) });
  };
  const snapshot = () => ({ ...state, sourceTabIds: [...allowed], events: structuredClone(events) });
  target.__createdPageProvenance = {
    register(tabId) {
      if (state.closed || !Number.isSafeInteger(tabId) || tabId < 0 || allowed.size >= 6 || allowed.has(tabId)) throw new Error("Invalid created page source registration");
      allowed.add(tabId); return { tabId, readySequence: state.sequence, registeredAt: Date.now() };
    }, snapshot,
    stop() { if (!state.closed) { chrome.webNavigation.onCreatedNavigationTarget.removeListener(listener); state.closed = true; } return { ...snapshot(), listenerPresent: chrome.webNavigation.onCreatedNavigationTarget.hasListener(listener) }; }
  };
  chrome.webNavigation.onCreatedNavigationTarget.addListener(listener);
  return { installed: true, sequence: state.sequence };
}

export function assertCreatedPageSource({ item, events, afterFrames, sourceState }) {
  assert.equal(events.length, 1, "Exactly one native child per original source");
  const event = events[0], native = event.details, before = item.sourceFrame;
  assert.equal(native.sourceTabId, item.tabId); assert.equal(native.sourceFrameId, before.frameId);
  assert.ok(Number.isInteger(native.sourceProcessId), "Original native source process field");
  assert.ok(Number.isSafeInteger(native.tabId) && native.tabId >= 0 && native.tabId !== item.tabId);
  assert.equal(native.url, item.childURL); assert.ok(event.sequence > item.observerReady.readySequence);
  const after = afterFrames.filter(frame => frame.frameId === before.frameId);
  assert.equal(after.length, 1); assert.ok(before.documentId); assert.equal(after[0].documentId, before.documentId);
  assert.equal(after[0].url, before.url); assert.equal(after[0].parentFrameId, before.parentFrameId);
  if (before.processId !== undefined) {
    assert.equal(after[0].processId, before.processId);
    if (before.processId >= 0) assert.equal(native.sourceProcessId, before.processId);
  }
  assert.equal(sourceState.key, item.key); assert.equal(sourceState.owner, item.owner);
  assert.equal(sourceState.sourceNonce, item.sourceBefore.sourceNonce); assert.equal(sourceState.documentToken, item.sourceBefore.documentToken);
  assert.deepEqual(sourceState.clicks, [{ trusted: true, ctrlKey: true, metaKey: false, altKey: false, shiftKey: false, button: 0,
    sourceNonce: item.sourceBefore.sourceNonce, documentToken: item.sourceBefore.documentToken, href: item.childURL, sequence: 1 }]);
  return native.tabId;
}

function assertBytes(value) {
  const bytes = Buffer.from(value.base64, "base64"); assert.equal(bytes.length, value.bytes);
  assert.equal(createHash("sha256").update(bytes).digest("hex"), value.sha256); return bytes;
}

export function assertCreatedPageReceipt({ item, child, state, receipt, frames }) {
  assert.equal(child.nonce, item.childBefore.documentNonce); assert.equal(state.documentNonce, child.nonce);
  assert.equal(state.documentToken, item.childBefore.documentToken);
  assert.deepEqual(state.clicks, [{ trusted: true, sequence: 1, documentNonce: child.nonce, documentToken: state.documentToken }]);
  assert.equal(child.posts.length, 1); const post = child.posts[0];
  assert.equal(post.method, "POST"); assert.equal(post.url, "/created-page/receipt"); assert.equal(post.status, 200);
  assert.equal(post.once, true); assert.equal(post.finished, true); assert.equal(post.aborted, false); assert.equal(post.body.truncated, false);
  assert.deepEqual(post.fields, { key: item.key, owner: item.owner, documentNonce: child.nonce, documentToken: state.documentToken, trusted: "true", buttonCount: "1" });
  assert.deepEqual([...new URLSearchParams(assertBytes(post.body).toString())], post.fieldEntries);
  assert.equal(post.fieldEntries.length, 6); assert.deepEqual(Object.fromEntries(post.fieldEntries), post.fields);
  const expected = { ok: true, key: item.key, owner: item.owner, documentNonce: child.nonce };
  assert.deepEqual(receipt, expected); assert.deepEqual(JSON.parse(assertBytes(post.response).toString()), expected);
  assert.equal(child.get.method, "GET"); assert.equal(child.get.url, "/created-page/child"); assert.equal(child.get.status, 200);
  assert.equal(child.get.finished, true); assert.equal(child.get.aborted, false); assert.deepEqual(child.html, child.get.response);
  assert.ok(assertBytes(child.html).includes(Buffer.from(child.nonce)), "Nonce belongs to the exact original served child HTML");
  const root = frames.filter(frame => frame.frameId === 0); assert.equal(root.length, 1);
  assert.equal(root[0].documentId, item.childFrame.documentId); assert.equal(root[0].url, item.childURL);
  return { bytes: post.body.bytes, sha256: post.body.sha256 };
}

export async function createdPageAction(deadline, operation, now = () => performance.now()) {
  const remaining = Math.floor(deadline - now()); assert.ok(remaining > 0, "Original created page deadline expired before action");
  const result = await operation({ timeoutMs: Math.min(5000, remaining) });
  assert.ok(now() < deadline, "Original created page deadline expired at ACK"); return result;
}

export async function checkCreatedPageProvenance({ connectBrowser, getWorker, fixtureURL, server, until, saveDetail = async () => {}, detail = {}, productReady = false }) {
  const owners = [], sources = new Map(), pageWaits = new Map(), pageDeadlines = new Map(); let installed = false, failure;
  Object.assign(detail, { feasibilityOnly: !productReady, boundary: productReady ? "Public JS expectPage readiness, original trusted Control-click, result Tab and follow-up business action; passive native events independently verify returned identity. Document continuity is observational, not atomic event-document binding." : "Passive native created-target event followed by existing explicit claimUserTab; no product expectPage/ready API. getAllFrames before/after is observational document continuity, not atomic event-document binding.", cases: [], groups: [], cleanup: [] });
  const worker = () => getWorker(), evaluate = expression => worker().evaluate(expression);
  const frames = tabId => evaluate(`chrome.webNavigation.getAllFrames({tabId:${tabId}})`);
  const trace = () => evaluate(`${traceName}.snapshot()`);
  // The runner's general until retries errors. These observations only retry
  // genuinely absent data; preserve the first actual RPC/identity error.
  const wait = async (read, label, deadline) => {
    let value, error;
    await until(async () => { try { value = await read(); return Boolean(value); } catch (caught) { error = caught; return true; } }, label, Math.max(1, deadline - performance.now()));
    if (error) throw error; assert.ok(performance.now() < deadline, "Original created page deadline expired while waiting"); return value;
  };
  const readState = async (target, deadline) => {
    let state;
    await wait(async () => { const text = await createdPageAction(deadline, options => target.locator("#state").textContent(options)); if (!text) return false; state = JSON.parse(text); return Boolean(state.documentToken); }, "original fixture document script", deadline);
    return state;
  };
  try {
    for (const name of ["created-page-first", "created-page-second"]) owners.push(await connectBrowser(name));
    detail.observer = await evaluate(`(${installCreatedPageObserver.toString()})(chrome,globalThis)`); installed = true;
    for (const variant of ["root", "oopif", "dynamic-oopif"]) {
      const group = [], groupDetail = { variant, ready: [] }; detail.groups.push(groupDetail);
      for (const [index, browser] of owners.entries()) {
        const record = server.createCase({ owner: `created-${index}-${variant}`, variant }), tab = await browser.newTab();
        const item = { key: record.key, owner: record.owner, ownerIndex: index, variant, tabId: tab.id, scope: scope(browser), sourceURL: new URL(record.urlPath, fixtureURL).href, childURL: new URL("/created-page/child", fixtureURL).href };
        sources.set(tab.id, item); detail.cases.push(item);
        item.createdTab = await evaluate(`chrome.tabs.get(${tab.id})`); assert.equal(item.createdTab.active, false);
        item.observerReady = await evaluate(`${traceName}.register(${tab.id})`);
        await browser.cdp.navigate(tab.id, item.sourceURL);
        let prepareDeadline = performance.now() + 15000;
        const arm = async () => {
          await readState(tab, prepareDeadline);
          const startedAt = Date.now(), deadline = performance.now() + 20000;
          pageDeadlines.set(tab.id, deadline);
          const waiter = await tab.expectPage({ timeoutMs: 20000 }); pageWaits.set(tab.id, waiter);
          assert.ok(performance.now() < deadline, "Original created page deadline expired at ready ACK");
          prepareDeadline = Math.min(prepareDeadline, deadline);
          item.productReady = { waiterId: waiter.waiterId, remainingMs: waiter.remainingMs, startedAt, acknowledgedAt: Date.now(), timeoutMs: 20000 };
        };
        if (productReady && variant === "dynamic-oopif") await arm();
        if (variant === "dynamic-oopif") await createdPageAction(prepareDeadline, options => tab.getByRole("button", { name: "Add source frame", exact: true }).click(options));
        const target = variant === "root" ? tab : tab.frameLocator("#created-page-frame");
        item.sourceBefore = await readState(target, prepareDeadline); assert.equal(item.sourceBefore.clicks.length, 0);
        item.rootBefore = variant === "root" ? item.sourceBefore : await readState(tab, prepareDeadline);
        assert.deepEqual(item.rootBefore.frameAdds, variant === "dynamic-oopif" ? [{ trusted: true, sequence: 1 }] : []);
        item.framesBefore = await frames(tab.id);
        const expectedSourceURL = variant === "root" ? item.sourceURL : new URL(`/created-page/frame?key=${encodeURIComponent(record.key)}`, fixtureURL.replace("127.0.0.1", "localhost")).href;
        const matches = item.framesBefore.filter(frame => frame.url === expectedSourceURL && (variant === "root" ? frame.frameId === 0 : frame.frameId !== 0 && frame.parentFrameId === 0));
        assert.equal(matches.length, 1); item.sourceFrame = matches[0]; assert.ok(item.sourceFrame.documentId);
        item.sourceHTML = server.stats(item.key).documents.filter(document => document.nonce === item.sourceBefore.sourceNonce);
        assert.equal(item.sourceHTML.length, 1); assert.equal(item.sourceHTML[0].url, new URL(expectedSourceURL).pathname + new URL(expectedSourceURL).search);
        assert.ok(assertBytes(item.sourceHTML[0]).includes(Buffer.from(item.sourceBefore.sourceNonce)));
        if (variant !== "root") {
          item.renderer = await evaluate(`(async()=>({attachments:(globalThis.__integrationFrames??[]).filter(frame=>frame.tabId===${tab.id}),targets:await chrome.debugger.getTargets()}))()`);
          const matches = item.renderer.targets.filter(native => native.url === expectedSourceURL && item.renderer.attachments.some(attachment => attachment.targetId === native.id && attachment.type === 'iframe' && attachment.sessionId));
          assert.equal(matches.length, 1, "Exact original OOPIF renderer attachment"); item.rendererTarget = matches[0];
        }
        if (productReady && variant !== "dynamic-oopif") await arm();
        group.push({ browser, tab, target, item }); groupDetail.ready.push({ tabId: tab.id, scope: item.scope, at: Date.now() });
      }
      groupDetail.releasedAt = Date.now();
      // Drain both actual click promises even on failure. Never replay a link
      // click, infer a child from a URL inventory, or simulate window.open.
      const results = await Promise.allSettled(group.map(async ({ browser, target, item }) => {
        const deadline = productReady ? pageDeadlines.get(item.tabId) : performance.now() + 20000; item.startedAt = Date.now();
        try {
          item.stage = "original-ctrl-click";
          await createdPageAction(deadline, options => target.getByRole("link", { name: "Open original child", exact: true }).click({ ...options, modifiers: ["Control"] }));
          item.clickAcknowledgedAt = Date.now(); item.stage = "native-created-target";
          let childTab;
          if (productReady) {
            childTab = await pageWaits.get(item.tabId).result();
            item.productResult = { tabId: childTab.id, acknowledgedAt: Date.now() };
          }
          await wait(async () => { const observed = await trace(); assert.equal(observed.overflow, false); return observed.events.some(event => event.details.sourceTabId === item.tabId); }, "exact source created target", deadline);
          const observed = await trace(); assert.equal(observed.overflow, false);
          item.events = observed.events.filter(event => event.details.sourceTabId === item.tabId);
          item.framesAfterClick = await frames(item.tabId); item.sourceAfter = await readState(target, deadline);
          item.childId = assertCreatedPageSource({ item, events: item.events, afterFrames: item.framesAfterClick, sourceState: item.sourceAfter });
          item.nativeChild = await evaluate(`chrome.tabs.get(${item.childId})`);
          assert.equal(item.nativeChild.active, false); assert.equal(item.nativeChild.windowId, item.createdTab.windowId);
          item.beforeClaimTabs = await browser.getTabs(); item.alreadyOwned = item.beforeClaimTabs.some(tab => tab.id === item.childId);
          item.stage = "foreign-rejection";
          try { await createdPageAction(deadline, options => owners[1 - item.ownerIndex].tab(item.childId).domSnapshot(options)); throw new Error("Foreign child access unexpectedly succeeded"); }
          catch (error) { assert.match(String(error), ownershipError); item.foreignError = String(error); }
          item.stage = productReady ? "public-page-result" : "existing-explicit-claim"; assert.ok(performance.now() < deadline);
          if (productReady) assert.equal(childTab.id, item.childId, "Public result matches independent original native source event");
          else item.claim = await createdPageAction(deadline, options => browser.client.request("claimUserTab", { tabId: item.childId }, options));
          assert.ok(performance.now() < deadline, "Original created page deadline expired at claim ACK");
          item.scopeAfterClaim = scope(browser); assert.deepEqual(item.scopeAfterClaim, item.scope);
          childTab ??= browser.tab(item.childId); item.childBefore = await readState(childTab, deadline);
          item.childFramesBefore = await frames(item.childId); const roots = item.childFramesBefore.filter(frame => frame.frameId === 0);
          assert.equal(roots.length, 1); item.childFrame = roots[0]; assert.ok(item.childFrame.documentId); assert.equal(item.childFrame.url, item.childURL);
          item.stage = "child-business-action";
          await createdPageAction(deadline, options => childTab.getByLabel("Source key", { exact: true }).fill(item.key, options));
          await createdPageAction(deadline, options => childTab.getByLabel("Owner", { exact: true }).fill(item.owner, options));
          await createdPageAction(deadline, options => childTab.getByRole("button", { name: "Commit child receipt", exact: true }).click(options));
          await wait(async () => { const text = await createdPageAction(deadline, options => childTab.locator("#result").textContent(options)); if (!text) return false; item.receipt = JSON.parse(text); return true; }, "original child POST response", deadline);
          item.childAfter = await readState(childTab, deadline); item.childFramesAfter = await frames(item.childId);
          const children = server.allStats().children.filter(child => child.nonce === item.childBefore.documentNonce); assert.equal(children.length, 1); item.originalChild = children[0];
          item.business = assertCreatedPageReceipt({ item, child: item.originalChild, state: item.childAfter, receipt: item.receipt, frames: item.childFramesAfter });
          assert.ok(performance.now() < deadline, "Original created page deadline expired before receipt verification");
          item.stage = "complete"; item.completedAt = Date.now(); item.ok = true;
        } catch (error) { item.error = error.stack; throw error; }
      }));
      groupDetail.results = results.map(result => result.status === "fulfilled" ? { status: result.status } : { status: result.status, error: String(result.reason) });
      const rejected = results.find(result => result.status === "rejected"); if (rejected) throw rejected.reason;
      assert.equal(new Set(group.map(entry => entry.item.childId)).size, 2); assert.equal(new Set(group.map(entry => entry.item.childBefore.documentNonce)).size, 2);
    }
    detail.trace = await trace(); assert.equal(detail.trace.overflow, false); assert.equal(detail.trace.events.length, 6);
    assert.equal(new Set(detail.cases.map(item => item.childId)).size, 6);
    detail.server = server.allStats(); assert.equal(detail.server.overflow, false); assert.equal(detail.server.children.length, 6);
    const posts = detail.server.requests.filter(hit => hit.method === "POST"); assert.equal(posts.length, 6); assert.ok(posts.every(hit => hit.once && hit.status === 200));
  } catch (error) { failure = error; detail.error = error.stack; }
  finally {
    const cleanup = async (kind, identity, action) => {
      const entry = { kind, identity, startedAt: Date.now() }; detail.cleanup.push(entry);
      try { entry.result = await action(); entry.ok = true; }
      catch (error) { entry.error = String(error); failure ??= error; }
      entry.completedAt = Date.now();
    };
    if (installed) await cleanup("remove-listener", traceName, async () => {
      const checked = detail.trace; detail.trace = await evaluate(`${traceName}.stop()`);
      assert.equal(detail.trace.closed, true); assert.equal(detail.trace.listenerPresent, false);
      if (!failure) { assert.equal(detail.trace.overflow, false); assert.equal(detail.trace.events.length, 6); assert.deepEqual(detail.trace.events, checked.events, "No late additional created-target events"); }
      return { closed: true, listenerPresent: false };
    });
    for (const [tabId, waiter] of pageWaits) await cleanup("cancel-page-wait", tabId, () => waiter.cancel());
    for (const browser of owners) await cleanup("formal-finalize", browser.client.sessionId, () => browser.client.finalizeTabs([]));
    // claimUserTab can preserve these children as user-origin tabs. Explicit
    // removal here is test cleanup, not a product automatic-close guarantee.
    const ids = new Set([...(detail.trace?.events ?? []).map(event => event.details.tabId), ...sources.keys()]);
    for (const tabId of ids) await cleanup("exact-fixture-tab", tabId, () => evaluate(`(async()=>{let tab;try{tab=await chrome.tabs.get(${tabId})}catch(error){if(/No tab|Invalid tab/i.test(String(error)))return{alreadyClosed:true};throw error}const urls=${JSON.stringify([new URL("/created-page/child", fixtureURL).href, sources.get(tabId)?.sourceURL].filter(Boolean))};if(!urls.includes(tab.url)&&!urls.includes(tab.pendingUrl))throw new Error('Fixture tab document changed before cleanup');await chrome.tabs.remove(${tabId});return{removed:tab}})()`));
    await cleanup("verify-exact-tabs-absent", [...ids], async () => { const remaining = await evaluate(`chrome.tabs.query({}).then(tabs=>tabs.filter(tab=>${JSON.stringify([...ids])}.includes(tab.id)))`); detail.remainingTabs = remaining; assert.deepEqual(remaining, []); return { remaining }; });
    for (const browser of owners) await cleanup("close-sdk", browser.client.sessionId, () => browser.close());
    detail.server = server.allStats();
    try { await saveDetail(detail); } catch (error) { failure ??= error; }
  }
  if (failure) { failure.originalCreatedPageDetail = detail; throw failure; }
  return detail;
}

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import { installCreatedPageObserver, assertCreatedPageSource, assertCreatedPageReceipt } from "./created-page-provenance.mjs";
import { installCreatedPageWireObserver, assertCreatedPageWire } from "./created-page-wire.mjs";

const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const scopeOf = browser => ({ session_id: browser.client.sessionId, turn_id: browser.client.turnId, control_epoch: browser.client.controlEpoch });
const errorText = error => error?.stack ?? String(error);

// A failed caller aborts both barriers. The barrier never releases a subset,
// and a late arrival cannot turn a failed gate into a successful one.
export function createdPageBarrier(count, detail = {}) {
  assert.ok(Number.isSafeInteger(count) && count > 0 && count <= 16);
  const waiting = Promise.withResolvers(), arrivals = new Set();
  waiting.promise.catch(() => {});
  let failure;
  Object.assign(detail, { arrivals: [], releasedAt: null });
  return {
    enter(key, value) {
      if (failure) return Promise.reject(failure);
      if (arrivals.has(key) || arrivals.size >= count) {
        const error = new Error("Duplicate or excess created-page gate arrival"); this.abort(error); return Promise.reject(error);
      }
      arrivals.add(key); detail.arrivals.push({ key, at: Date.now(), value: structuredClone(value) });
      if (arrivals.size === count) { detail.releasedAt = Date.now(); waiting.resolve(); }
      return waiting.promise;
    },
    abort(error) { if (!failure) { failure = error; detail.error = errorText(error); waiting.reject(error); } },
  };
}

export async function withinCreatedPageBudget(deadline, operation, now = () => performance.now()) {
  const remaining = Math.floor(deadline - now());
  assert.ok(remaining > 0, "Original created-page deadline expired before operation");
  let timer;
  try {
    const value = await Promise.race([Promise.resolve().then(operation), new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error("Original created-page deadline expired during gate")), remaining);
    })]);
    assert.ok(now() < deadline, "Original created-page deadline expired at acknowledgement"); return value;
  } finally { clearTimeout(timer); }
}

// Only missing publication is retryable. Helpers publish with an atomic link;
// malformed/nonmatching records and real filesystem errors are evidence failures.
export async function readCreatedPageGate({ path, token, child, deadline, readFile = fs.readFile }) {
  const exited = child.then(() => { throw new Error("Created-page caller exited before gate release"); });
  return withinCreatedPageBudget(deadline, async () => {
    while (true) {
      assert.ok(performance.now() < deadline, "Original created-page gate deadline expired");
      const read = (async () => {
        let raw;
        try { raw = await readFile(path, "utf8"); }
        catch (error) { if (error.code === "ENOENT") return null; throw error; }
        assert.ok(Buffer.byteLength(raw) <= 65536, "Created-page gate record exceeds bound");
        const value = JSON.parse(raw); assert.equal(value.token, token); return value;
      })();
      const value = await Promise.race([read, exited]);
      if (value) return value;
      await Promise.race([delay(Math.min(25, Math.max(1, deadline - performance.now()))), exited]);
    }
  });
}

export function assertCreatedPageGate(value, item, prepared = false) {
  assert.deepEqual(value.scope, item.scope); assert.equal(value.tabId, item.tabId);
  assert.ok(typeof value.waiterId === "string" && value.waiterId.length > 0 && Buffer.byteLength(value.waiterId) <= 128 && !value.waiterId.includes("\0"));
  assert.ok(typeof value.remainingMs === "number" && Number.isFinite(value.remainingMs) && value.remainingMs > 0 && value.remainingMs <= 20000);
  const at = prepared ? value.preparedAt : value.readyAt; assert.ok(Number.isSafeInteger(at) && at > 0);
  if (prepared) {
    assert.equal(value.waiterId, item.ready.waiterId); assert.ok(value.remainingMs <= item.ready.remainingMs);
    assert.equal(value.key, item.key); assert.equal(value.owner, item.owner); assert.equal(value.variant, item.variant);
  }
}

export async function runCreatedPageJSCaller({ connect, scope, tabId, variant, key, owner, afterReady, afterPrepared, detail = {} }) {
  let browser, waiter, failure, deadline = performance.now() + 20000;
  Object.assign(detail, { caller: "js", scope, tabId, variant, key, owner, firstRequestAt: Date.now(), stages: [], waitCleanup: { attempted: false, ok: false }, clientClose: { attempted: false, ok: false }, ok: false });
  const budget = () => { const ms = Math.floor(deadline - performance.now()); assert.ok(ms > 0, "Original created-page deadline expired"); return ms; };
  const stage = async (name, operation) => {
    const record = { name, startedAt: Date.now(), ok: false }; detail.stages.push(record);
    try { budget(); const value = await operation(); budget(); record.ok = true; return value; }
    catch (error) { record.error = errorText(error); throw error; }
    finally { record.finishedAt = Date.now(); }
  };
  const action = operation => {
    const timeoutMs = Math.min(5000, budget() - 1000); assert.ok(timeoutMs > 0, "No created-page action transport budget remains");
    return operation({ timeoutMs });
  };
  const read = async (target, selector = "#state") => {
    while (true) {
      const raw = await action(options => target.locator(selector).textContent(options)); budget();
      assert.ok(typeof raw === "string" && Buffer.byteLength(raw) <= 65536);
      if (raw !== "") return JSON.parse(raw);
      await delay(Math.min(25, budget()));
    }
  };
  const source = value => { assert.equal(value.key, key); assert.equal(value.owner, owner); assert.ok(value.sourceNonce && value.documentToken); return value; };
  try {
    browser = await stage("connect", connect);
    detail.scopeBefore = await stage("scopeBefore", () => browser.client.request("getControlState", scope, { timeoutMs: budget() }));
    assert.equal(detail.scopeBefore.controlEpoch, scope.control_epoch); assert.equal(detail.scopeBefore.closing, false);
    assert.equal(detail.scopeBefore.lifecycleVersion, 1); assert.ok(typeof detail.scopeBefore.nextTurnId === "string" && detail.scopeBefore.nextTurnId);
    const tab = browser.tab(tabId);
    detail.rootBefore = source(await stage("rootBefore", () => read(tab)));
    assert.deepEqual(detail.rootBefore.frameAdds, []); assert.deepEqual(scopeOf(browser), scope);
    waiter = await stage("ready", () => tab.expectPage({ timeoutMs: budget() }));
    deadline = Math.min(deadline, performance.now() + waiter.remainingMs);
    Object.assign(detail, { waiterId: waiter.waiterId, remainingMs: waiter.remainingMs, readyAt: Date.now() });
    await stage("gate", () => withinCreatedPageBudget(deadline, () => afterReady(detail)));
    if (variant === "dynamic-oopif") await stage("addFrame", () => action(options => tab.locator("#add-frame").click(options)));
    const target = variant === "root" ? tab : tab.frameLocator("#created-page-frame");
    detail.sourceBefore = source(await stage("sourceBefore", () => read(target))); assert.deepEqual(detail.sourceBefore.clicks, []);
    Object.assign(detail, { preparedAt: Date.now(), preparedRemainingMs: budget() });
    await stage("preparedGate", () => withinCreatedPageBudget(deadline, () => afterPrepared({ ...detail, remainingMs: detail.preparedRemainingMs })));
    await stage("click", () => action(options => target.locator("#open-child").click({ ...options, modifiers: ["Control"] })));
    const child = await stage("collect", () => waiter.result()); detail.childId = child.id;
    detail.sourceAfter = source(await stage("sourceAfter", () => read(target)));
    detail.rootAfter = variant === "root" ? detail.sourceAfter : source(await stage("rootAfter", () => read(tab)));
    detail.childBefore = await stage("childBefore", () => read(child));
    assert.ok(detail.childBefore.documentNonce && detail.childBefore.documentToken); assert.deepEqual(detail.childBefore.clicks, []);
    await stage("fillKey", () => action(options => child.getByLabel("Source key", { exact: true }).fill(key, options)));
    await stage("fillOwner", () => action(options => child.getByLabel("Owner", { exact: true }).fill(owner, options)));
    await stage("commit", () => action(options => child.locator("#commit").click(options)));
    detail.receipt = await stage("receipt", () => read(child, "#result"));
    detail.childAfter = await stage("childAfter", () => read(child));
    assert.deepEqual(detail.receipt, { ok: true, key, owner, documentNonce: detail.childBefore.documentNonce });
    detail.completedAt = Date.now(); budget();
  } catch (error) { failure = error; detail.error = errorText(error); }
  finally {
    if (waiter) {
      detail.waitCleanup.attempted = true;
      try { await waiter.cancel(); detail.waitCleanup.ok = true; } catch (error) { detail.waitCleanup.error = errorText(error); failure ??= error; }
    }
    if (browser) {
      detail.clientClose.attempted = true;
      try { await browser.close(); detail.clientClose.ok = true; } catch (error) { detail.clientClose.error = errorText(error); failure ??= error; }
    }
    detail.ok = !failure;
  }
  if (failure) { failure.createdPageCallerDetail = detail; throw failure; } return detail;
}

export async function checkCreatedPageFiveEntry({ connectBrowser, connectCaller, callExternal, getWorker, connectionState, fixtureURL, server, saveDetail = async () => {}, detail = {} }) {
  const kinds = ["js", "python", "go", "cli", "mcp"], owners = [], sources = new Map();
  let nativeInstalled = false, wireInstalled = false, failure;
  Object.assign(detail, { boundary: "Five public callers, same-URL native children, original 20s workflow budgets and two all-caller gates. Native source frame/document observations surround the trigger; child native frames are observed after business completion. Observations do not establish atomic event/document binding or first admission of an unowned child.", kinds, cases: [], groups: [], cleanup: [] });
  const evaluate = expression => getWorker().evaluate(expression);
  const frames = tabId => evaluate(`chrome.webNavigation.getAllFrames({tabId:${tabId}})`);
  const trace = () => evaluate("__createdPageProvenance.snapshot()");
  const bytes = value => { const raw = Buffer.from(value.base64, "base64"); assert.equal(raw.length, value.bytes); assert.equal(createHash("sha256").update(raw).digest("hex"), value.sha256); return raw; };
  try {
    for (const kind of kinds) owners.push(await connectBrowser(`created-five-${kind}`));
    detail.connectionBefore = connectionState();
    detail.observer = await evaluate(`(${installCreatedPageObserver.toString()})(chrome,globalThis,{maxSources:15})`); nativeInstalled = true;
    detail.wireObserver = await evaluate(`(${installCreatedPageWireObserver.toString()})(chrome,globalThis,${JSON.stringify({ sessions: owners.map(browser => browser.client.sessionId), generation: detail.connectionBefore.generation })})`); wireInstalled = true;
    for (const variant of ["root", "oopif", "dynamic-oopif"]) {
      const group = [], gates = { variant, ready: {}, prepared: {} }; detail.groups.push(gates);
      const readyGate = createdPageBarrier(5, gates.ready), preparedGate = createdPageBarrier(5, gates.prepared);
      for (const [index, browser] of owners.entries()) {
        const kind = kinds[index], record = server.createCase({ owner: `created-${kind}-${variant}`, variant });
        const tab = await browser.newTab();
        const item = { kind, ownerIndex: index, key: record.key, owner: record.owner, variant, tabId: tab.id, scope: scopeOf(browser), sourceURL: new URL(record.urlPath, fixtureURL).href, childURL: new URL("/created-page/child", fixtureURL).href };
        sources.set(tab.id, item); detail.cases.push(item); group.push({ browser, item });
        item.createdTab = await evaluate(`chrome.tabs.get(${tab.id})`); assert.equal(item.createdTab.active, false);
        item.observerReady = await evaluate(`__createdPageProvenance.register(${tab.id})`);
        await browser.cdp.navigate(tab.id, item.sourceURL);
      }
      const results = await Promise.allSettled(group.map(async ({ item }) => {
        const afterReady = async value => {
          assertCreatedPageGate(value, item);
          item.ready = structuredClone(value);
          await readyGate.enter(item.key, { scope: value.scope, tabId: value.tabId, waiterId: value.waiterId, remainingMs: value.remainingMs, readyAt: value.readyAt });
        };
        const afterPrepared = async value => {
          assertCreatedPageGate(value, item, true);
          item.sourceBefore = structuredClone(value.sourceBefore); assert.equal(item.sourceBefore.key, item.key); assert.equal(item.sourceBefore.owner, item.owner); assert.deepEqual(item.sourceBefore.clicks, []);
          item.framesBefore = await frames(item.tabId);
          const expectedURL = variant === "root" ? item.sourceURL : new URL(`/created-page/frame?key=${encodeURIComponent(item.key)}`, fixtureURL.replace("127.0.0.1", "localhost")).href;
          const matching = item.framesBefore.filter(frame => frame.url === expectedURL && (variant === "root" ? frame.frameId === 0 : frame.frameId !== 0 && frame.parentFrameId === 0));
          assert.equal(matching.length, 1); item.sourceFrame = matching[0]; assert.ok(item.sourceFrame.documentId);
          item.sourceHTML = server.stats(item.key).documents.filter(document => document.nonce === item.sourceBefore.sourceNonce);
          assert.equal(item.sourceHTML.length, 1); assert.equal(item.sourceHTML[0].url, new URL(expectedURL).pathname + new URL(expectedURL).search);
          assert.ok(bytes(item.sourceHTML[0]).includes(Buffer.from(item.sourceBefore.sourceNonce)));
          if (variant !== "root") {
            item.renderer = await evaluate(`(async()=>({attachments:(globalThis.__integrationFrames??[]).filter(frame=>frame.tabId===${item.tabId}),targets:await chrome.debugger.getTargets()}))()`);
            const targets = item.renderer.targets.filter(native => native.url === expectedURL && item.renderer.attachments.some(attachment => attachment.targetId === native.id && attachment.type === "iframe" && attachment.sessionId));
            assert.equal(targets.length, 1, "Original OOPIF renderer attachment"); item.rendererTarget = targets[0];
          }
          item.prepared = { at: Date.now(), remainingMs: value.remainingMs, preparedAt: value.preparedAt };
          await preparedGate.enter(item.key, { scope: value.scope, tabId: value.tabId, waiterId: value.waiterId, remainingMs: value.remainingMs, preparedAt: value.preparedAt });
        };
        try {
          const params = { scope: item.scope, tabId: item.tabId, variant, key: item.key, owner: item.owner, afterReady, afterPrepared };
          item.caller = item.kind === "js" ? await runCreatedPageJSCaller({ ...params, connect: () => connectCaller(item.scope) }) : await callExternal(item.kind, params);
          assert.equal(item.caller.ok, true); assert.equal(item.caller.waitCleanup.ok, true); assert.equal(item.caller.clientClose.ok, true);
          item.childId = item.caller.childId; Object.assign(item, { rootBefore: item.caller.rootBefore, sourceAfter: item.caller.sourceAfter, childBefore: item.caller.childBefore, childAfter: item.caller.childAfter, receipt: item.caller.receipt });
          assert.deepEqual(item.caller.sourceBefore, item.sourceBefore);
          assert.deepEqual(item.rootBefore.frameAdds, []);
          if (variant === "dynamic-oopif") assert.deepEqual(item.caller.rootAfter.frameAdds, [{ trusted: true, sequence: 1 }]);
          const observed = await trace(); assert.equal(observed.overflow, false); item.events = observed.events.filter(event => event.details.sourceTabId === item.tabId);
          item.framesAfterClick = await frames(item.tabId);
          assert.equal(assertCreatedPageSource({ item, events: item.events, afterFrames: item.framesAfterClick, sourceState: item.sourceAfter }), item.childId);
          item.nativeChild = await evaluate(`chrome.tabs.get(${item.childId})`);
          assert.equal(item.nativeChild.active, false); assert.equal(item.nativeChild.windowId, item.createdTab.windowId);
          item.childFramesObserved = await frames(item.childId); const roots = item.childFramesObserved.filter(frame => frame.frameId === 0);
          assert.equal(roots.length, 1); item.childFrame = roots[0]; assert.ok(item.childFrame.documentId);
          item.childFramesAfter = await frames(item.childId);
          const children = server.allStats().children.filter(child => child.nonce === item.childBefore.documentNonce); assert.equal(children.length, 1); item.originalChild = children[0];
          item.business = assertCreatedPageReceipt({ item, child: item.originalChild, state: item.childAfter, receipt: item.receipt, frames: item.childFramesAfter });
          item.ok = true;
        } catch (error) {
          item.error = errorText(error); item.caller ??= error.createdPageCallerDetail;
          readyGate.abort(error); preparedGate.abort(error); throw error;
        }
      }));
      gates.results = results.map(result => ({ status: result.status, ...(result.status === "rejected" ? { error: errorText(result.reason) } : {}) }));
      const rejected = results.find(result => result.status === "rejected"); if (rejected) throw rejected.reason;
      assert.equal(new Set(group.map(({ item }) => item.childId)).size, 5); assert.equal(new Set(group.map(({ item }) => item.childBefore.documentNonce)).size, 5);
    }
    detail.trace = await trace(); assert.equal(detail.trace.overflow, false); assert.equal(detail.trace.events.length, 15);
    detail.wire = await evaluate("__createdPageWire.stop()");
    detail.connectionAfter = connectionState(); assert.deepEqual(detail.connectionAfter, detail.connectionBefore, "Original host generation, process and endpoint must remain");
    detail.wireChecks = assertCreatedPageWire({ snapshot: detail.wire, items: detail.cases.map(item => ({ ...item, sessionId: item.scope.session_id, turnId: item.scope.turn_id, controlEpoch: item.scope.control_epoch })) });
    detail.server = server.allStats(); assert.equal(detail.server.overflow, false); assert.equal(detail.server.children.length, 15);
    const posts = detail.server.requests.filter(request => request.method === "POST"); assert.equal(posts.length, 15); assert.ok(posts.every(post => post.once && post.status === 200 && post.finished));
    assert.equal(new Set(detail.cases.map(item => item.childId)).size, 15);
  } catch (error) { failure = error; detail.error = errorText(error); }
  finally {
    const cleanup = async (kind, identity, operation) => {
      const entry = { kind, identity, startedAt: Date.now() }; detail.cleanup.push(entry);
      try { entry.result = await operation(); entry.ok = true; } catch (error) { entry.error = errorText(error); failure ??= error; }
      entry.completedAt = Date.now();
    };
    if (wireInstalled) await cleanup("remove-wire-observer", "__createdPageWire", async () => {
      detail.wire = await evaluate("__createdPageWire.stop()"); assert.equal(detail.wire.closed, true); assert.equal(detail.wire.restored, true); return { closed: true, restored: true };
    });
    if (nativeInstalled) await cleanup("remove-native-observer", "__createdPageProvenance", async () => {
      const previous = detail.trace; detail.trace = await evaluate("__createdPageProvenance.stop()"); assert.equal(detail.trace.closed, true); assert.equal(detail.trace.listenerPresent, false);
      if (!failure) assert.deepEqual(detail.trace.events, previous.events, "No late native child"); return { closed: true, listenerPresent: false };
    });
    for (const browser of owners) await cleanup("formal-finalize", browser.client.sessionId, () => browser.client.finalizeTabs([]));
    const ids = new Set([...sources.keys(), ...(detail.trace?.events ?? []).map(event => event.details.tabId)]);
    for (const tabId of ids) await cleanup("exact-fixture-tab", tabId, () => evaluate(`(async()=>{let tab;try{tab=await chrome.tabs.get(${tabId})}catch(error){if(/No tab|Invalid tab/i.test(String(error)))return{alreadyClosed:true};throw error}const urls=${JSON.stringify([new URL("/created-page/child", fixtureURL).href, sources.get(tabId)?.sourceURL].filter(Boolean))};if(!urls.includes(tab.url)&&!urls.includes(tab.pendingUrl))throw new Error('Fixture tab document changed before cleanup');await chrome.tabs.remove(${tabId});return{removed:tab}})()`));
    await cleanup("verify-exact-tabs-absent", [...ids], async () => { detail.remainingTabs = await evaluate(`chrome.tabs.query({}).then(tabs=>tabs.filter(tab=>${JSON.stringify([...ids])}.includes(tab.id)))`); assert.deepEqual(detail.remainingTabs, []); return { remaining: detail.remainingTabs }; });
    for (const browser of owners) await cleanup("close-parent-sdk", browser.client.sessionId, () => browser.close());
    detail.server = server.allStats();
    try { await saveDetail(detail); } catch (error) { failure ??= error; }
  }
  if (failure) { failure.originalCreatedPageDetail = detail; throw failure; } return detail;
}

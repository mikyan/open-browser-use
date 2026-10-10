import assert from "node:assert/strict";

export const navigationButton = "Navigate fixture";
export const navigationPageURL = (base, key, mode = "document") => base + "navigation-waits?" + new URLSearchParams({ key, mode });
export const navigationTargetURL = (base, key) => base + "navigation-waits/target?" + new URLSearchParams({ key });
const expired = /OBU_NAVIGATION_WAIT_EXPIRED|OBU_STALE_CONTROL_EPOCH|OBU_CONTROL_BOOTSTRAP_REQUIRED|cancel|closed|not part of browser session/i;
const timeout = /OBU_NAVIGATION_WAIT_TIMEOUT|timed out|timeout/i;

export function createNavigationWaitFixtures() {
  const entries = new Map(), gates = new Set();
  const entry = key => {
    if (!entries.has(key)) entries.set(key, { documents: 0, targets: 0, redirects: 0, hits: 0, gates: [], released: [] });
    return entries.get(key);
  };
  const release = (key, kind) => {
    for (const gate of [...gates]) if (gate.key === key && gate.kind === kind) { gates.delete(gate); gate.finish(); }
  };
  return {
    stats: key => structuredClone(entry(key)), allStats: () => Object.fromEntries([...entries].map(([key, value]) => [key, structuredClone(value)])), release,
    close() { for (const gate of gates) gate.finish(); gates.clear(); },
    handle(request, response) {
      const url = new URL(request.url, "http://fixture");
      if (!url.pathname.startsWith("/navigation-waits")) return false;
      const key = url.searchParams.get("key") || "unspecified", stats = entry(key);
      const target = "/navigation-waits/target?" + new URLSearchParams({ key });
      response.setHeader("Cache-Control", "no-store");
      if (url.pathname === "/navigation-waits/stats") { response.setHeader("Content-Type", "application/json"); response.end(JSON.stringify(stats)); return true; }
      if (url.pathname === "/navigation-waits/hit") { stats.hits++; response.end("ok"); return true; }
      if (url.pathname === "/navigation-waits/redirect") { stats.redirects++; response.writeHead(302, { Location: target }); response.end(); return true; }
      if (url.pathname.startsWith("/navigation-waits/gate-")) {
        const kind = url.pathname.slice("/navigation-waits/gate-".length);
        stats.gates.push(kind);
        const gate = { key, kind, response, finish: () => {
          if (response.destroyed) return;
          stats.released.push(kind);
          if (kind === "image") { response.setHeader("Content-Type", "image/png"); response.end(Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a9p8AAAAASUVORK5CYII=", "base64")); }
          else if (kind === "script") { response.setHeader("Content-Type", "text/javascript"); response.end("globalThis.parserGateReleased=true"); }
          else { response.setHeader("Content-Type", "application/json"); response.end("{}"); }
        } };
        gates.add(gate); response.on("close", () => gates.delete(gate)); return true;
      }
      response.setHeader("Content-Type", "text/html; charset=utf-8");
      const storageKey = "navigation-clicks-" + key;
      const initialize = `globalThis.navigationClicks=JSON.parse(sessionStorage.getItem(${JSON.stringify(storageKey)})||'[]');function recordClick(event){navigationClicks.push({trusted:event.isTrusted});sessionStorage.setItem(${JSON.stringify(storageKey)},JSON.stringify(navigationClicks))}function hit(){return fetch('/navigation-waits/hit?key='+encodeURIComponent(${JSON.stringify(key)})).then(response=>response.text()).then(value=>{globalThis.hitFinished=true;return value})}`;
      if (url.pathname === "/navigation-waits/gated") {
        stats.documents++;
        response.end(`<!doctype html><meta charset="utf-8"><title>Gated navigation</title><script>${initialize};globalThis.lifecycleEvents=[];document.addEventListener('DOMContentLoaded',()=>lifecycleEvents.push('domcontentloaded'));addEventListener('load',()=>lifecycleEvents.push('load'));fetch('/navigation-waits/gate-fetch?key='+encodeURIComponent(${JSON.stringify(key)})).then(response=>response.text()).then(()=>globalThis.fetchFinished=true)</script>
          <button onclick="recordClick(event);hit();document.querySelector('#done').textContent='clicked'">During loading action</button><output id="done"></output>
          <script src="/navigation-waits/gate-script?key=${encodeURIComponent(key)}"></script><img src="/navigation-waits/gate-image?key=${encodeURIComponent(key)}">`);
        return true;
      }
      if (url.pathname === "/navigation-waits/target") stats.targets++; else stats.documents++;
      const mode = url.searchParams.get("mode") || "document";
      const destination = mode === "redirect" ? "/navigation-waits/redirect?" + new URLSearchParams({ key }) : target;
      const navigate = mode === "spa" || mode === "intermediate"
        ? `hit();${mode === "intermediate" ? `history.pushState({},'',${JSON.stringify("/navigation-waits/intermediate?" + new URLSearchParams({ key }))});` : ""}history.${mode === "intermediate" ? "replaceState" : "pushState"}({},'',${JSON.stringify(target)});document.querySelector('#done').textContent='arrived'`
        : `location.assign(${JSON.stringify(destination)})`;
      response.end(`<!doctype html><meta charset="utf-8"><title>Navigation waits fixture</title><script>${initialize}</script>
        <button id="navigate">${navigationButton}</button><output id="done">${url.pathname === "/navigation-waits/target" ? "arrived" : "idle"}</output>
        <button id="delayed" style="display:none">Delayed navigation fixture action</button><output id="delayed-result"></output>
        <script>document.querySelector('#navigate').addEventListener('click',event=>{recordClick(event);${navigate}});document.querySelector('#delayed').addEventListener('click',event=>{recordClick(event);hit();document.querySelector('#delayed-result').textContent='clicked'})</script>`);
      return true;
    }
  };
}

async function coldTab(browser, fixtureURL, key, mode) {
  const tab = await browser.newTab();
  await browser.cdp.navigate(tab.id, navigationPageURL(fixtureURL, key, mode));
  return tab;
}
export async function navigationWitness(tab, server, key, { document = true } = {}) {
  const clicks = await tab.evaluate("navigationClicks");
  assert.deepEqual(clicks, [{ trusted: true }]);
  const counts = server.stats(key);
  if (document) assert.equal(counts.targets, 1, "Navigation trigger was replayed");
  return { clicks, server: counts };
}

export async function checkNavigationDirectAndReady({ browser, fixtureURL, server, until }) {
  assert.equal((await browser.client.getInfo()).metadata.navigationWaitVersion, 1);
  const detail = {};
  const directKey = "js-navigation-direct-cold", direct = await coldTab(browser, fixtureURL, directKey);
  await Promise.all([
    direct.waitForURL(navigationTargetURL(fixtureURL, directKey), { timeoutMs: 5000 }),
    direct.getByRole("button", { name: navigationButton, exact: true }).click({ timeoutMs: 5000 })
  ]);
  detail.direct = await navigationWitness(direct, server, directKey);

  for (const mode of ["document", "spa", "intermediate", "redirect"]) {
    const key = "js-navigation-ready-" + mode, tab = await coldTab(browser, fixtureURL, key, mode);
    const target = navigationTargetURL(fixtureURL, key);
    const match = mode === "intermediate" ? "**/navigation-waits/intermediate?key=" + key : target;
    const ready = await tab.expectURL(match, { waitUntil: "commit", timeoutMs: 5000 });
    await tab.getByRole("button", { name: navigationButton, exact: true }).click();
    assert.equal(await ready.result(), undefined); assert.equal(await ready.result(), undefined);
    assert.equal(await tab.evaluate("location.href"), target);
    if (["spa", "intermediate"].includes(mode)) await until(() => server.stats(key).hits === 1, "single same-document trigger");
    detail[mode] = await navigationWitness(tab, server, key, { document: !["spa", "intermediate"].includes(mode) });
    if (mode === "redirect") assert.equal(detail[mode].server.redirects, 1);
    await ready.cancel();
    if (mode === "spa") {
      const backwards = await tab.expectURL("**/navigation-waits?key=" + key + "&mode=spa", { timeoutMs: 5000 });
      await tab.goBack(); await backwards.result(); await backwards.cancel();
      const forwards = await tab.expectURL(target, { timeoutMs: 5000 });
      await tab.goForward(); await forwards.result(); await forwards.cancel();
      assert.equal(server.stats(key).hits, 1);
    }
    if (mode === "intermediate") {
      const old = await tab.expectURL(match, { waitUntil: "commit", timeoutMs: 250 });
      await assert.rejects(old.result(), timeout); await old.cancel();
    }
    // These observe the current document. They must not wait for a new navigation.
    const current = await tab.expectURL(target, { timeoutMs: 1000 });
    await current.result(); await current.cancel();
    const loaded = await tab.expectLoadState({ state: "load", timeoutMs: 1000 });
    await loaded.result(); await loaded.cancel();
    await tab.waitForURL(target, { timeoutMs: 1000 }); await tab.waitForLoadState({ timeoutMs: 1000 });
  }
  return detail;
}

export async function checkNavigationLoadStates({ browser, fixtureURL, server, until, startTrace, getTrace }) {
  const key = "js-navigation-lifecycle-gates", tab = await browser.newTab();
  const started = performance.now(), trace = [];
  const stage = name => { trace.push({ stage: name, elapsedMs: Math.round(performance.now() - started), server: server.stats(key) }); };
  let committed, dcl, loaded, idle, capturedEvidence;
  const evidence = async () => {
    if (capturedEvidence) return capturedEvidence;
    const results = await Promise.allSettled([
      browser.cdp.call(tab.id, "Runtime.evaluate", { expression: "({hitFinished:globalThis.hitFinished===true,fetchFinished:globalThis.fetchFinished===true,parserGateReleased:globalThis.parserGateReleased===true,readyState:document.readyState,lifecycleEvents:globalThis.lifecycleEvents,url:location.href})", returnByValue: true }, { timeoutMs: 3000 }),
      tab.diagnostics({ limit: 200, timeoutMs: 3000 }), getTrace(tab.id)
    ]);
    capturedEvidence = Object.fromEntries(["page", "diagnostics", "nativeNetwork"].map((key, index) => [key, results[index].status === "fulfilled" ? results[index].value : { error: String(results[index].reason) }]));
    return capturedEvidence;
  };
  try {
    await startTrace(tab.id);
    const url = fixtureURL + "navigation-waits/gated?key=" + key;
    // The existing raw goto helper intentionally supports only DCL/load.
    // Register the public native commit observer before issuing raw navigation
    // so the parser-blocking fixture can remain loading during later checks.
    committed = await tab.expectURL(url, { waitUntil: "commit", timeoutMs: 10000 });
    stage("commit-armed");
    const navigation = await browser.cdp.call(tab.id, "Page.navigate", { url });
    assert.equal(navigation.errorText, undefined);
    await committed.result(); stage("commit-complete");
    await until(() => ["script", "image", "fetch"].every(kind => server.stats(key).gates.includes(kind)), "three independent HTTP lifecycle gates");
    stage("all-gate-requests-arrived");
    dcl = await tab.expectLoadState({ state: "domcontentloaded", timeoutMs: 10000 });
    stage("domcontentloaded-armed");
    loaded = await tab.expectLoadState({ state: "load", timeoutMs: 10000 });
    stage("load-armed");
    idle = await tab.expectLoadState({ state: "networkidle", timeoutMs: 10000 });
    stage("networkidle-armed");
    let directDone = false, loadDone = false, idleDone = false;
    const direct = tab.waitForLoadState({ state: "domcontentloaded", timeoutMs: 10000 }).then(() => { directDone = true; stage("direct-domcontentloaded-complete"); });
    stage("direct-domcontentloaded-submitted");
    const loadResult = loaded.result().then(() => { loadDone = true; stage("load-complete"); });
    const idleResult = idle.result().then(() => { idleDone = true; stage("networkidle-complete"); });
    for (const pending of [direct, loadResult, idleResult]) pending.catch(() => {});
    // A real action must run while the direct state waiter remains pending.
    stage("click-submitted");
    await tab.getByRole("button", { name: "During loading action", exact: true }).click({ timeoutMs: 5000 });
    stage("click-complete");
    assert.equal(await tab.locator("#done").textContent(), "clicked");
    assert.equal(directDone, false); assert.equal(loadDone, false); assert.equal(idleDone, false);
    server.release(key, "script"); stage("script-released"); await dcl.result(); stage("domcontentloaded-complete"); await direct;
    assert.equal(loadDone, false); assert.equal(idleDone, false);
    server.release(key, "image"); stage("image-released"); await loadResult;
    assert.equal(idleDone, false);
    server.release(key, "fetch"); stage("fetch-released"); await idleResult;
    const witness = await navigationWitness(tab, server, key, { document: false });
    assert.equal(witness.server.hits, 1);
    assert.deepEqual(await tab.evaluate("lifecycleEvents"), ["domcontentloaded", "load"]);
    const captured = await evidence();
    assert.equal(captured.page.result.value.hitFinished, true);
    assert.equal(captured.page.result.value.fetchFinished, true);
    assert.equal(captured.nativeNetwork.dropped, 0);
    const completedRequests = {};
    for (const kind of ["hit", "gate-fetch"]) {
      const requests = captured.nativeNetwork.events.filter(event => event.method === "Network.requestWillBeSent" && event.request?.url === fixtureURL + "navigation-waits/" + kind + "?key=" + key);
      assert.equal(requests.length, 1, `Expected one native ${kind} request`);
      const requestId = requests[0].requestId;
      assert.ok(captured.nativeNetwork.events.some(event => event.method === "Network.loadingFinished" && event.requestId === requestId), `${kind} response body did not finish`);
      completedRequests[kind] = requestId;
    }
    return { ...witness, directWaitDidNotBlockClick: true, independentDCLLoadAndIdle: true, trace, ...captured, completedRequests };
  } catch (error) {
    // Preserve the exact pre-cleanup state: finally necessarily opens all gates
    // and must not be mistaken for normal successful release sequencing.
    error.navigationFixture = { trace: structuredClone(trace), serverBeforeFinally: server.stats(key), ...await evidence() };
    throw error;
  } finally {
    for (const kind of ["script", "image", "fetch"]) server.release(key, kind);
    for (const handle of [committed, dcl, loaded, idle]) if (handle) await handle.cancel().catch(() => {});
  }
}

export async function checkNavigationLifecycle({ browser, fixtureURL, server, until, connectOther, ungroup }) {
  const key = "js-navigation-timeout-action", tab = await coldTab(browser, fixtureURL, key);
  const missing = await tab.expectURL("**/never-navigation", { timeoutMs: 250 });
  const action = tab.getByRole("button", { name: "Delayed navigation fixture action", exact: true }).click({ timeoutMs: 5000 });
  action.catch(() => {});
  await assert.rejects(missing.result(), timeout);
  // Raw CDP is already part of the public SDK and can reveal the fixture while
  // the real click waits. A waiter timeout must not detach/cancel that action.
  await browser.cdp.call(tab.id, "Runtime.evaluate", { expression: "document.querySelector('#delayed').style.display='block'" });
  await action; assert.equal(await tab.locator("#delayed-result").textContent(), "clicked");
  await until(() => server.stats(key).hits === 1, "single delayed fixture trigger");
  const witness = await navigationWitness(tab, server, key, { document: false });
  assert.equal(witness.server.hits, 1); await missing.cancel();
  const cancelled = await tab.expectURL("**/never-navigation", { timeoutMs: 5000 });
  await cancelled.cancel(); await cancelled.cancel(); await assert.rejects(cancelled.result(), expired);
  const ended = await tab.expectURL("**/never-navigation", { timeoutMs: 5000 });
  const endResult = ended.result().then(() => ({ success: true }), error => ({ error: String(error) }));
  await browser.client.turnEnded(); assert.match((await endResult).error, expired); await assert.rejects(ended.result(), expired);
  const detached = await tab.expectLoadState({ state: "load", timeoutMs: 5000 });
  await browser.client.detach(tab.id); await assert.rejects(detached.result(), expired);
  const other = await connectOther();
  try {
    const transfer = await tab.expectURL("**/never-navigation", { timeoutMs: 5000 });
    await ungroup(tab.id); await other.client.claimUserTab(tab.id);
    await assert.rejects(transfer.result(), expired);
    await assert.rejects(other.client.request("collectNavigationWait", { tabId: tab.id, waiterId: transfer.waiterId }), /EXPIRED/);
    const closedTab = await other.newTab({ url: navigationPageURL(fixtureURL, "js-navigation-closed") });
    const closed = await closedTab.expectURL("**/never-navigation", { timeoutMs: 5000 });
    await closedTab.close(); await assert.rejects(closed.result(), expired);
    return { timeoutKeptConcurrentAction: witness, cancel: true, ended: true, detached: true, ownerChanged: true, closed: true };
  } finally { try { await other.client.finalizeTabs([]); } finally { other.close(); } }
}

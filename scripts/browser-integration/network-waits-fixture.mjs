import assert from "node:assert/strict";

const timeoutError = /OBU_NETWORK_WAIT_TIMEOUT|timed out|timeout/i;
const expiredError = /OBU_NETWORK_WAIT_EXPIRED|OBU_STALE_CONTROL_EPOCH|OBU_CONTROL_BOOTSTRAP_REQUIRED|cancel|closed|not part of browser session/i;
export const networkButton = "Send main network request";
const childButton = "Send child network request";

export function networkPageURL(base, key, { mode = "normal", status = 201, method = "POST", apiKey = key } = {}) {
  return base + "network-waits?" + new URLSearchParams({ key, mode, status: String(status), method, apiKey });
}
export function networkAPIURL(base, key, { mode = "normal", status = 201 } = {}) {
  return base + "network-waits/api?" + new URLSearchParams({ key, mode, status: String(status) });
}

// Real HTTP fixture gates let the test prove response-vs-body timing without
// sleeping, mocking Page events, or making another browser controller connect.
export function createNetworkWaitFixtures() {
  const entries = new Map();
  const gates = new Set();
  const entry = key => {
    if (!entries.has(key)) entries.set(key, { requests: [], headersSent: 0, bodiesFinished: 0 });
    return entries.get(key);
  };
  const release = (key, phase) => {
    for (const gate of [...gates]) if (gate.key === key && gate.phase === phase) { gates.delete(gate); gate.finish(); }
  };
  return {
    stats: key => structuredClone(entry(key)),
    allStats: () => Object.fromEntries([...entries].map(([key, value]) => [key, structuredClone(value)])),
    releaseHeaders: key => release(key, "headers"),
    releaseBody: key => release(key, "body"),
    close: () => { for (const gate of gates) gate.finish(); gates.clear(); },
    handle(request, response, port) {
      const url = new URL(request.url, "http://localhost");
      if (!url.pathname.startsWith("/network-waits")) return false;
      const key = url.searchParams.get("key") || "unspecified";
      if (url.pathname === "/network-waits/stats") {
        response.setHeader("Content-Type", "application/json"); response.end(JSON.stringify(entry(key))); return true;
      }
      if (url.pathname === "/network-waits/api") {
        const record = entry(key);
        const hit = { method: request.method, mode: url.searchParams.get("mode") ?? "normal", path: request.url, body: "" };
        record.requests.push(hit);
        request.on("data", data => { hit.body += data.toString(); });
        const status = Number(url.searchParams.get("status") ?? 201);
        const finish = () => {
          if (response.destroyed) return;
          record.bodiesFinished++;
          response.end(JSON.stringify({ key, count: record.requests.length }));
        };
        const headers = () => {
          if (response.destroyed) return;
          record.headersSent++;
          response.writeHead(status, { "Content-Type": "application/json", "Cache-Control": "no-store" });
          response.flushHeaders();
          if (hit.mode === "body-gate") gates.add({ key, response, phase: "body", finish }); else finish();
        };
        if (hit.mode === "redirect") {
          const destination = new URL(request.url, `http://${request.headers.host}`);
          destination.searchParams.set("mode", "final"); destination.searchParams.set("status", "200");
          record.headersSent++; record.bodiesFinished++;
          response.writeHead(302, { Location: destination.pathname + destination.search }); response.end();
        } else if (hit.mode === "fail") request.socket.destroy();
        else if (hit.mode === "headers-gate") gates.add({ key, response, phase: "headers", finish: headers });
        else headers();
        response.on("close", () => { for (const gate of [...gates]) if (gate.response === response) gates.delete(gate); });
        return true;
      }
      const child = url.pathname === "/network-waits/frame";
      const apiKey = url.searchParams.get("apiKey") || key;
      const config = { key, mode: url.searchParams.get("mode") || "normal", status: Number(url.searchParams.get("status") || 201), method: url.searchParams.get("method") || "POST", apiKey };
      const api = "/network-waits/api?" + new URLSearchParams({ key: apiKey, mode: config.mode, status: String(config.status) });
      const frameQuery = new URLSearchParams({ ...config, key: key + "-child", apiKey: apiKey + "-child", status: String(config.status) });
      response.setHeader("Content-Type", "text/html; charset=utf-8");
      response.end(`<!doctype html><meta charset="utf-8"><title>Network waits fixture</title>
        <button id="send">${child ? childButton : networkButton}</button><output id="done">idle</output>
        ${child ? "" : `<iframe id="cross" src="http://localhost:${port}/network-waits/frame?${frameQuery}"></iframe>`}
        <script>globalThis.networkClicks=[];globalThis.networkFetches=0;document.querySelector('#send').onclick=async event=>{
          networkClicks.push({trusted:event.isTrusted});document.querySelector('#done').textContent='pending';
          try{networkFetches++;const response=await fetch(${JSON.stringify(api)},{method:${JSON.stringify(config.method)},...(${JSON.stringify(config.method)}==='GET'?{}:{body:JSON.stringify({fixture:${JSON.stringify(key)}})})});globalThis.networkHeaders=response.status;await response.text();document.querySelector('#done').textContent='complete'}
          catch(error){document.querySelector('#done').textContent='failed';globalThis.networkError=String(error)}
        };</script>`);
      return true;
    }
  };
}

function checkEvent(value, { event = "response", url, method = "POST", status = 201, framePart } = {}) {
  assert.equal(value.event, event); assert.equal(value.url, url); assert.equal(value.method, method);
  assert.equal(typeof value.requestId, "string"); assert.ok(value.requestId.length > 0);
  assert.equal(value.resourceType, "fetch");
  if (event === "response") assert.equal(value.status, status);
  if (framePart) assert.ok(value.frameUrl?.includes(framePart), JSON.stringify(value));
  for (const field of ["headers", "cookies", "postData", "body"]) assert.equal(value[field], undefined);
  return value;
}

async function coldTab(browser, url) {
  const tab = await browser.newTab();
  await browser.cdp.navigate(tab.id, url);
  return tab;
}

async function clickOnce(tab, server, key, until, child = false) {
  const target = child ? tab.frameLocator("#cross") : tab;
  await target.getByRole("button", { name: child ? childButton : networkButton, exact: true }).click();
  if (!child) assert.deepEqual(await tab.evaluate("networkClicks"), [{ trusted: true }]);
  await until(() => server.stats(key).requests.length > 0, "server received the single network trigger");
  assert.equal(server.stats(key).requests.length, 1, "A single user trigger sent more than one request");
}

export async function checkNetworkReady({ browser, fixtureURL, server, until, oopifTargets }) {
  const detail = {};
  // These tabs have no engine actions before arm: readiness must include cold
  // attachment, including the OOPIF listener, before the first locator click.
  for (const child of [false, true]) {
    const key = child ? "js-network-cold-child" : "js-network-cold-main";
    const tab = await coldTab(browser, networkPageURL(fixtureURL, key));
    const actualKey = child ? key + "-child" : key;
    const base = child ? fixtureURL.replace("127.0.0.1", "localhost") : fixtureURL;
    const url = networkAPIURL(base, actualKey);
    const request = await tab.expectRequest({ url, method: "POST" }, { timeoutMs: 5000 });
    const response = await tab.expectResponse({ url, method: "POST", status: 201 }, { timeoutMs: 5000 });
    await clickOnce(tab, server, actualKey, until, child);
    const sent = checkEvent(await request.result(), { event: "request", url, framePart: child ? "/network-waits/frame" : "/network-waits?" });
    const received = checkEvent(await response.result(), { url, framePart: child ? "/network-waits/frame" : "/network-waits?" });
    assert.equal(received.requestId, sent.requestId);
    assert.deepEqual(await response.result(), received, "Repeated collect changed a matched event");
    if (child) assert.ok((await oopifTargets()).some(target => target.tabId === tab.id), "Cold child network event was not observed from an actual OOPIF attachment");
    await request.cancel(); await response.cancel();
    detail[child ? "oopif" : "main"] = { request: sent, response: received, server: server.stats(actualKey) };
  }

  const bodyKey = "js-network-body-gate";
  const body = await coldTab(browser, networkPageURL(fixtureURL, bodyKey, { mode: "body-gate" }));
  const headers = await body.expectResponse({ url: networkAPIURL(fixtureURL, bodyKey, { mode: "body-gate" }), status: 201 }, { timeoutMs: 5000 });
  try {
    await clickOnce(body, server, bodyKey, until);
    detail.headersBeforeBody = await headers.result();
    assert.equal(server.stats(bodyKey).headersSent, 1); assert.equal(server.stats(bodyKey).bodiesFinished, 0);
    assert.equal(await body.locator("#done").textContent(), "pending", "Response waiter waited for body completion");
  } finally { server.releaseBody(bodyKey); await headers.cancel(); }
  await until(async () => await body.locator("#done").textContent() === "complete", "released HTTP body");

  // Request starts before response registration; only the selected event's
  // timing matters. A server gate, rather than a timer, controls the headers.
  const earlyKey = "js-network-request-before-arm";
  const early = await coldTab(browser, networkPageURL(fixtureURL, earlyKey, { mode: "headers-gate" }));
  await early.getByRole("button", { name: networkButton, exact: true }).click();
  await until(() => server.stats(earlyKey).requests.length === 1, "server received request before response arm");
  const lateArm = await early.expectResponse({ url: networkAPIURL(fixtureURL, earlyKey, { mode: "headers-gate" }) }, { timeoutMs: 5000 });
  try { server.releaseHeaders(earlyKey); detail.requestBeforeArm = await lateArm.result(); }
  finally { server.releaseHeaders(earlyKey); await lateArm.cancel(); }

  const redirectKey = "js-network-redirect";
  const redirected = await coldTab(browser, networkPageURL(fixtureURL, redirectKey, { mode: "redirect" }));
  const sourceURL = networkAPIURL(fixtureURL, redirectKey, { mode: "redirect" });
  const finalURL = networkAPIURL(fixtureURL, redirectKey, { mode: "final", status: 200 });
  const first = await redirected.expectRequest({ url: sourceURL }, { timeoutMs: 5000 });
  const redirect = await redirected.expectResponse({ url: sourceURL, status: 302 }, { timeoutMs: 5000 });
  const final = await redirected.expectResponse({ url: finalURL, method: "GET", status: 200 }, { timeoutMs: 5000 });
  await redirected.getByRole("button", { name: networkButton, exact: true }).click();
  const source = await first.result(), hop = await redirect.result(), destination = await final.result();
  assert.equal(hop.requestId, source.requestId); assert.equal(destination.redirectedFrom, source.requestId);
  assert.notEqual(destination.requestId, source.requestId);
  assert.deepEqual(server.stats(redirectKey).requests.map(hit => hit.method), ["POST", "GET"]);
  await first.cancel(); await redirect.cancel(); await final.cancel();
  detail.redirect = { source, hop, destination, server: server.stats(redirectKey) };
  return detail;
}

export async function checkNetworkMatching({ browser, fixtureURL, server, until }) {
  const key = "js-network-match";
  const tab = await coldTab(browser, networkPageURL(fixtureURL, key, { status: 503 }));
  const url = networkAPIURL(fixtureURL, key, { status: 503 });
  const started = Date.now();
  const exact = await tab.expectResponse({ url, status: 503, method: "POST" }, { timeoutMs: 3000 });
  const contains = await tab.expectResponse({ url: "/network-waits/api?key=" + key, urlMatch: "contains", status: 503 }, { timeoutMs: 3000 });
  const misses = [
    await tab.expectResponse({ url: fixtureURL + "network-waits/api", urlMatch: "exact" }, { timeoutMs: 3000 }),
    await tab.expectResponse({ url, method: "GET" }, { timeoutMs: 3000 }),
    await tab.expectResponse({ url, status: 404 }, { timeoutMs: 3000 })
  ];
  await clickOnce(tab, server, key, until);
  for (const waiter of misses) { await assert.rejects(waiter.result(), timeoutError); await waiter.cancel(); }
  assert.ok(Date.now() - started >= 3000, "Late collect did not pass the original matching deadline");
  const event = checkEvent(await exact.result(), { url, status: 503 });
  assert.deepEqual(await contains.result(), event); assert.deepEqual(await exact.result(), event);
  await exact.cancel(); await contains.cancel();
  const historical = await tab.expectResponse({ url }, { timeoutMs: 250 });
  await assert.rejects(historical.result(), timeoutError);
  await assert.rejects(historical.result(), timeoutError);
  await historical.cancel();
  const cancelled = await tab.expectRequest({ url }, { timeoutMs: 5000 });
  await cancelled.cancel(); await cancelled.cancel();
  await assert.rejects(cancelled.result(), /OBU_NETWORK_WAIT_EXPIRED/);
  assert.equal(server.stats(key).requests.length, 1, "Matching/history checks replayed the trigger");

  for (const [eventType, match] of [
    ["response", { url, urlMatch: "regex" }], ["response", { url, predicate: "true" }],
    ["response", { url: "x".repeat(4097) }], ["response", { url, method: "X".repeat(129) }],
    ["response", { url, status: 99 }], ["request", { url, status: 200 }]
  ]) await assert.rejects(browser.client.request("armNetworkWait", { tabId: tab.id, event: eventType, match }), /url|method|status|match|support|field|byte/i);

  const failKey = "js-network-fail";
  const failed = await coldTab(browser, networkPageURL(fixtureURL, failKey, { mode: "fail" }));
  const absent = await failed.expectResponse({ url: networkAPIURL(fixtureURL, failKey, { mode: "fail" }) }, { timeoutMs: 700 });
  // Chromium may retry a POST whose connection closes before any response.
  // Keep transport attempts visible; prove this case invoked fetch just once
  // instead of treating those native retries as extra agent clicks.
  await failed.getByRole("button", { name: networkButton, exact: true }).click();
  await assert.rejects(absent.result(), timeoutError); await absent.cancel();
  await until(async () => await failed.locator("#done").textContent() === "failed", "failed fetch settled");
  const failedFetch = await failed.evaluate("({clicks:networkClicks,fetchInvocations:networkFetches})");
  assert.deepEqual(failedFetch.clicks, [{ trusted: true }]); assert.equal(failedFetch.fetchInvocations, 1);
  const failedRequests = server.stats(failKey);
  assert.ok(failedRequests.requests.length >= 1);
  assert.ok(failedRequests.requests.every(hit => hit.method === "POST" && hit.mode === "fail"));
  assert.equal(failedRequests.headersSent, 0); assert.equal(failedRequests.bodiesFinished, 0);
  failedFetch.transportAttempts = failedRequests.requests.length;

  const capKey = "js-network-capacity";
  const capped = await coldTab(browser, networkPageURL(fixtureURL, capKey));
  const retained = [];
  for (let index = 0; index < 16; index++) retained.push(await capped.expectResponse({ url: networkAPIURL(fixtureURL, capKey) }, { timeoutMs: 5000 }));
  await clickOnce(capped, server, capKey, until);
  const matched = await Promise.all(retained.map(waiter => waiter.result()));
  assert.ok(matched.every(value => value.requestId === matched[0].requestId));
  await assert.rejects(capped.expectResponse({ url: networkAPIURL(fixtureURL, capKey) }), /OBU_NETWORK_WAIT_LIMIT/);
  for (const waiter of retained) await waiter.cancel();
  const reclaimed = await capped.expectResponse({ url: networkAPIURL(fixtureURL, capKey) }); await reclaimed.cancel();
  return { event, lateCollectMs: Date.now() - started, historicalRejected: true, cancelledRejected: true, retainedCapacity: matched.length, failedFetch, counters: { matching: server.stats(key), failed: server.stats(failKey), capacity: server.stats(capKey) } };
}

export async function checkNetworkLifecycle({ browser, connectSuccessor, fixtureURL, server, ungroup }) {
  const other = await connectSuccessor();
  const key = "js-network-shared";
  try {
    const left = await coldTab(browser, networkPageURL(fixtureURL, "js-network-left", { apiKey: key }));
    const right = await coldTab(other, networkPageURL(fixtureURL, "js-network-right", { apiKey: key }));
    const url = networkAPIURL(fixtureURL, key);
    const first = await browser.client.request("armNetworkWait", { tabId: left.id, event: "response", match: { url }, timeoutMs: 5000 });
    const second = await right.expectResponse({ url }, { timeoutMs: 5000 });
    await assert.rejects(other.client.request("collectNetworkWait", { tabId: right.id, waiterId: first.waiterId }), /OBU_NETWORK_WAIT_EXPIRED/);
    await assert.rejects(browser.client.request("collectNetworkWait", { tabId: left.id, waiterId: first.waiterId, turn_id: "different-network-turn", control_epoch: browser.client.controlEpoch }), /OBU_NETWORK_WAIT_EXPIRED/);
    let rightSettled = false;
    const pendingRight = second.result().then(value => { rightSettled = true; return { value }; }, error => ({ error }));
    await left.getByRole("button", { name: networkButton, exact: true }).click();
    const leftEvent = await browser.client.request("collectNetworkWait", { tabId: left.id, waiterId: first.waiterId });
    assert.ok(leftEvent.frameUrl.includes("js-network-left"));
    assert.equal(rightSettled, false, "A foreign tab satisfied the same-URL waiter");
    await right.getByRole("button", { name: networkButton, exact: true }).click();
    const rightOutcome = await pendingRight;
    if (rightOutcome.error) throw rightOutcome.error;
    const rightEvent = rightOutcome.value; assert.ok(rightEvent.frameUrl.includes("js-network-right"));
    assert.equal(server.stats(key).requests.length, 2);
    await browser.client.request("cancelNetworkWait", { tabId: left.id, waiterId: first.waiterId }); await second.cancel();

    const ended = await left.expectResponse({ url: fixtureURL + "network-never" }, { timeoutMs: 5000 });
    const collect = ended.result().then(value => ({ value }), error => ({ error: String(error) }));
    await browser.client.turnEnded();
    assert.match((await collect).error, expiredError);
    await assert.rejects(ended.result(), expiredError);
    const detached = await left.expectRequest({ url }, { timeoutMs: 5000 });
    await browser.client.detach(left.id); await assert.rejects(detached.result(), expiredError);

    const transferred = await browser.client.request("armNetworkWait", { tabId: left.id, event: "response", match: { url }, timeoutMs: 5000 });
    await ungroup(left.id); await other.client.claimUserTab(left.id);
    const moved = other.tab(left.id);
    const replacement = await moved.expectResponse({ url }, { timeoutMs: 5000 });
    await assert.rejects(other.client.request("collectNetworkWait", { tabId: left.id, waiterId: transferred.waiterId }), /OBU_NETWORK_WAIT_EXPIRED/);
    await moved.getByRole("button", { name: networkButton, exact: true }).click();
    assert.equal((await replacement.result()).url, url); await replacement.cancel();
    const closed = await right.expectRequest({ url }, { timeoutMs: 5000 });
    await right.close(); await assert.rejects(closed.result(), expiredError);
    return { leftEvent, rightEvent, server: server.stats(key), ended: true, detached: true, transferred: true, closed: true };
  } finally { try { await other.client.finalizeTabs([]); } finally { other.close(); } }
}

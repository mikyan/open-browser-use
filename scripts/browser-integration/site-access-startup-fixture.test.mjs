import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import vm from "node:vm";
import { createHash } from "node:crypto";
import { checkSiteAccessStartupNative, checkSiteAccessStartupSubmission, createSiteAccessStartupFixtures, installSiteAccessStartupProbe, siteAccessStartupPrefix, checkSiteAccessStartupRecovery } from "./site-access-startup-fixture.mjs";

const key = "OPEN_BROWSER_USE_SITE_ACCESS_POLICY", markerKey = "__OBU_TEST_SITE_STARTUP_0123456789abcdef", nonce = "a".repeat(32), options = { markerKey, nonce };
const policy = { version: 1, revision: 7, mode: "allow", origins: ["https://allowed.test"] };
const sha = bytes => createHash("sha256").update(bytes).digest("hex");
function fixture({ marker = { version: 1, nonce, armed: true }, get } = {}) {
  const calls = [], target = {}, session = marker === undefined ? {} : { [markerKey]: marker };
  const local = { get(...args) { const call = { name: "get", args, receiver: this }; calls.push(call); call.promise = get ? get(call) : Promise.resolve({ [key]: structuredClone(policy) }); return call.promise; },
    set(...args) { const call = { name: "set", args, receiver: this, promise: Promise.resolve() }; calls.push(call); return call.promise; } };
  const chrome = { runtime: { id: "private-test-extension" }, storage: { local, session: {
    async get(name) { calls.push({ name: "marker-get" }); return Object.hasOwn(session, name) ? { [name]: structuredClone(session[name]) } : {}; },
    async remove(name) { calls.push({ name: "marker-remove" }); delete session[name]; }
  } } };
  return { chrome, local, target, calls, session, originalGet: local.get, originalSet: local.set };
}

test("selected startup delivery failure retains the fulfilled original native Promise and one-shot marker consumption", async () => {
  const f = fixture(); await installSiteAccessStartupProbe(f.chrome, f.target, options);
  assert.deepEqual(f.session, {}); assert.deepEqual(f.calls.map(row => row.name), ["marker-get", "marker-remove"]);
  const delivery = f.local.get(key), native = f.calls.at(-1).promise; assert.notEqual(delivery, native);
  assert.deepEqual(await native, { [key]: policy }); await assert.rejects(delivery, /original native read fulfilled/);
  checkSiteAccessStartupNative(f.target.__siteAccessStartupProbe.snapshot(), policy);
  const recovered = f.local.get(key); assert.equal(recovered, f.calls.at(-1).promise); await recovered;
  checkSiteAccessStartupNative(f.target.__siteAccessStartupProbe.snapshot(), policy, { recovered: true });
  const final = f.target.__siteAccessStartupProbe.stop(); checkSiteAccessStartupNative(final, policy, { recovered: true, stopped: true });
  assert.equal(f.local.get, f.originalGet); assert.equal(f.local.set, f.originalSet); assert.equal(f.target.__siteAccessStartupProbe, undefined);
  // A later worker cannot repeat this failure without an explicit new marker.
  assert.deepEqual(await installSiteAccessStartupProbe(f.chrome, f.target, options), { armed: false });
});

test("unselected reads/writes retain exact arguments, receiver and original Promise", async () => {
  const f = fixture(); await installSiteAccessStartupProbe(f.chrome, f.target, options); const receiver = {};
  for (const args of [["another-key"], [[key]], [key, undefined]]) {
    const value = f.local.get.apply(receiver, args), call = f.calls.at(-1); assert.equal(value, call.promise); assert.equal(call.receiver, receiver); assert.deepEqual(call.args, args); await value;
  }
  const value = { unrelated: true }, written = f.local.set.call(receiver, value), call = f.calls.at(-1);
  assert.equal(written, call.promise); assert.equal(call.receiver, receiver); assert.equal(call.args[0], value); await written;
  assert.equal(f.target.__siteAccessStartupProbe.snapshot().rows.length, 0); f.target.__siteAccessStartupProbe.stop();
});

test("native rejection and synchronous throw cannot masquerade as fulfilled-native controlled delivery proof", async () => {
  const error = Error("original native rejection"), f = fixture({ get: () => Promise.reject(error) }); await installSiteAccessStartupProbe(f.chrome, f.target, options);
  await assert.rejects(f.local.get(key), value => value === error); const snapshot = f.target.__siteAccessStartupProbe.stop();
  assert.deepEqual(snapshot.rows.map(row => row.kind), ["call", "native-rejected"]); assert.throws(() => checkSiteAccessStartupNative(snapshot, policy));
  const g = fixture({ get: () => { throw error; } }); await installSiteAccessStartupProbe(g.chrome, g.target, options);
  assert.throws(() => g.local.get(key), value => value === error); assert.deepEqual(g.target.__siteAccessStartupProbe.stop().rows.map(row => row.kind), ["call", "native-threw"]);
});

test("pending native read and policy writes remain visible, and incomplete stop freezes its evidence", async () => {
  let resolve; const pending = new Promise(done => { resolve = done; }), f = fixture({ get: () => pending }); await installSiteAccessStartupProbe(f.chrome, f.target, options);
  const delivery = f.local.get(key), rejected = assert.rejects(delivery, /controlled delivery/);
  assert.equal(f.target.__siteAccessStartupProbe.snapshot().pending, 1);
  const value = { [key]: policy }, written = f.local.set(value); assert.equal(written, f.calls.at(-1).promise); assert.equal(f.calls.at(-1).args[0], value); await written;
  const api = f.target.__siteAccessStartupProbe, final = api.stop(); assert.equal(final.writes, 1); assert.match(final.errors[0], /unsettled/);
  resolve({ [key]: policy }); await rejected; assert.deepEqual(api.snapshot(), final);
});

test("staged prefix installs before the next constructor read, and foreign marker cannot arm it", async () => {
  const f = fixture(), context = { chrome: f.chrome, structuredClone };
  await assert.rejects(new vm.Script(`(async()=>{${siteAccessStartupPrefix(options)}return chrome.storage.local.get(${JSON.stringify(key)})})()`).runInNewContext(context), /controlled delivery/);
  assert.deepEqual(f.calls.map(row => row.name), ["marker-get", "marker-remove", "get"]);
  const bad = fixture({ marker: { version: 1, nonce: "b".repeat(32), armed: true } });
  await assert.rejects(installSiteAccessStartupProbe(bad.chrome, bad.target, options), /Unexpected startup probe marker/); assert.equal(bad.local.get, bad.originalGet); assert.ok(bad.session[markerKey]);
});

test("native oracle rejects changed stored value, invented settlement and replayed recovery read", async () => {
  const f = fixture(); await installSiteAccessStartupProbe(f.chrome, f.target, options); await assert.rejects(f.local.get(key)); await f.local.get(key);
  const original = f.target.__siteAccessStartupProbe.snapshot();
  for (const mutate of [s => s.rows[1].value[key].revision++, s => s.rows[1].kind = "native-rejected", s => s.rows[3].controlled = true, s => s.reads++, s => s.writes++, s => s.pending++]) {
    const changed = structuredClone(original); mutate(changed); assert.throws(() => checkSiteAccessStartupNative(changed, policy, { recovered: true }));
  }
  f.target.__siteAccessStartupProbe.stop();
});

test("HTTP fixture preserves split UTF-8 original bytes, exact document receipt and rejects replay", async () => {
  const fixtures = createSiteAccessStartupFixtures(), server = http.createServer((request, response) => {
    if (!fixtures.handle(request, response, new URL(request.url, `http://127.0.0.1:${server.address().port}`))) { response.writeHead(404); response.end(); }
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  try {
    const base = `http://127.0.0.1:${server.address().port}`, caseKey = `startup-${"c".repeat(32)}`, url = `${base}/site-access-startup/page?key=${caseKey}`;
    const html = await (await fetch(url)).text(); new vm.Script(html.match(/<script>([\s\S]*)<\/script>/)[1]); const record = fixtures.stats(caseKey);
    assert.equal(sha(Buffer.from(html)), record.get.sha256);
    const value = "原文 π", snapshot = { key: caseKey, documentToken: record.documentToken, nodeToken: record.nodeToken, href: url, original: true, value, submits: 1, overflow: false, errors: [],
      events: [{ sequence: 1, type: "input", trusted: true, originalInput: true, value }, { sequence: 2, type: "click", trusted: true, target: "BUTTON" }, { sequence: 3, type: "submit", trusted: true, originalForm: true }] };
    // These synthetic flags test the oracle only; root's browser run proves trust.
    const bytes = Buffer.from(JSON.stringify({ trustedSubmit: true, snapshot })), cut = bytes.indexOf(Buffer.from("原")) + 1;
    const send = () => new Promise((resolve, reject) => { const request = http.request(`${base}/site-access-startup/post?key=${caseKey}`, { method: "POST" }, response => {
      const parts = []; response.on("data", chunk => parts.push(chunk)); response.on("end", () => resolve({ status: response.statusCode, text: Buffer.concat(parts).toString("utf8") }));
    }); request.on("error", reject); request.write(bytes.subarray(0, cut)); request.end(bytes.subarray(cut)); });
    const response = await send(); assert.equal(response.status, 200); const after = { ...snapshot, receipt: JSON.parse(response.text) };
    const submitted = fixtures.stats(caseKey); assert.equal(submitted.posts[0].bodyBase64, bytes.toString("base64")); checkSiteAccessStartupSubmission(submitted, after, value);
    for (const mutate of [r => r.posts[0].bodySHA256 = "bad", r => r.posts[0].value.snapshot.documentToken = "foreign", r => r.posts[0].value.snapshot.events[0].trusted = false]) {
      const changed = structuredClone(submitted); mutate(changed); assert.throws(() => checkSiteAccessStartupSubmission(changed, after, value));
    }
    assert.equal((await send()).status, 400); assert.equal(fixtures.stats(caseKey).posts.length, 2);
  } finally { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
});

for (const borrowed of [true, false]) test(`${borrowed ? "borrowed" : "standalone"} popup preserves ownership and restores settings after the original restart failure`, async () => {
  const primary = Object.freeze(Error("original worker restart failed")), calls = [], phases = [];
  const original = { version: 1, ready: true, stored: true, revision: 2, mode: "all", origins: [] };
  let status = structuredClone(original), automation = "Running", pageURL, saved, applyCount = 0;
  const popup = { async evaluate(source) {
    if (source.includes("GET_SITE_ACCESS_POLICY")) return { ok: true, policy: structuredClone(status) };
    if (source.startsWith("({label:")) return { label: "Saved", automation };
    if (source.includes("#site-access-reload")) return;
    if (source.includes("mode.value=")) {
      applyCount++; calls.push("apply"); automation = "Paused";
      status = { ...original, revision: status.revision + 1, ...(applyCount === 1 ? { mode: "allow", origins: ["http://127.0.0.1:8080"] } : {}) }; return;
    }
    if (source.includes("#automation-toggle")) { calls.push("resume"); automation = "Running"; return; }
    if (source === "window.close()") { calls.push("window-close"); return; }
    throw Error(`Unexpected popup read: ${source}`);
  }, close() { calls.push("popup-close"); } };
  const worker = { async evaluate(source) {
    if (source.startsWith("chrome.webNavigation.getAllFrames")) return [{ frameId: 0, url: pageURL, documentId: "original-document" }];
    if (source.startsWith("chrome.scripting.executeScript")) return { documentToken: "original-document", nodeToken: "original-input" };
    if (source.startsWith("chrome.action.openPopup")) { calls.push("open-popup"); return; }
    if (source.startsWith("chrome.storage.local.get")) { const { ready, stored, ...persisted } = status; return { [key]: persisted }; }
    if (source.startsWith("chrome.storage.session.get")) return {};
    if (source.startsWith("chrome.storage.session.set")) { calls.push("arm"); return; }
    if (source.startsWith("globalThis.__siteAccessStartupProbe?.stop")) { calls.push("stop-probe"); return null; }
    if (source.startsWith("chrome.storage.session.remove")) { calls.push("remove-marker"); return; }
    if (source === "chrome.tabs.remove(7)") { calls.push("remove-original-tab"); return; }
    throw Error(`Unexpected worker operation: ${source}`);
  } };
  await assert.rejects(checkSiteAccessStartupRecovery({
    connectBrowser: async () => ({ client: { controlEpoch: 3 }, async newTab({ url }) { pageURL = url; return { id: 7 }; }, close() { calls.push("browser-close"); } }),
    getWorker: () => worker, connectPage: async () => { calls.push("connect-popup"); return popup; },
    ...(borrowed ? { existingPopup: popup } : {}), popupURL: "chrome-extension://private-test-extension/popup.html", windowId: 9,
    fixtureURL: "http://127.0.0.1:8080/", restartWorker: async received => { assert.equal(received, popup); calls.push("restart"); throw primary; },
    capture: () => { throw Error("No screenshot before restart"); }, saveDetail: async detail => { saved = structuredClone(detail); },
    until: async predicate => { const value = await predicate(); assert.ok(value); return value; }, traceFocus: async phase => { phases.push(phase); },
    fixtures: { allStats: () => [{ originalLedger: true }] }, markerKey, nonce
  }), error => error === primary);
  assert.equal(applyCount, 2); assert.equal(automation, "Running"); assert.equal(status.mode, original.mode); assert.deepEqual(status.origins, original.origins);
  assert.deepEqual(calls, [...(borrowed ? [] : ["open-popup", "connect-popup"]), "apply", "arm", "restart", "stop-probe", "remove-marker", "apply", "resume", "remove-original-tab",
    ...(borrowed ? [] : ["window-close", "popup-close"]), "browser-close"]);
  assert.deepEqual(phases, borrowed ? [] : ["action-popup:before-open", "action-popup:after-open", "startup-popup:before-close", "startup-popup:after-close"]);
  assert.equal(saved.popupOwnership, borrowed ? "borrowed" : "owned"); assert.deepEqual(saved.serverLedger, [{ originalLedger: true }]); assert.match(saved.error, /original worker restart failed/);
  assert.equal(saved.restored.mode, original.mode); assert.equal(saved.restoreError, undefined);
});

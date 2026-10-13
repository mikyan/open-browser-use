import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { EventEmitter } from "node:events";
import http from "node:http";
import vm from "node:vm";
import { listenFixture } from "./fixture-listener.mjs";
import { checkRestrictedNetworkCaller, checkRestrictedNetworkEvidence, checkRestrictedNetworkBoundaryEvidence, checkRestrictedNetworkBoundaries, createRestrictedNetworkFixtures, installRestrictedNetworkEvidence, restrictedNetworkAPIURL, restrictedNetworkURL, runRestrictedNetworkWireCaller } from "./site-access-network-fixture.mjs";
const sha = bytes => createHash("sha256").update(bytes).digest("hex");
const scope = { session_id: "network-test", turn_id: "original-turn", control_epoch: 19 };
const config = { key: "network-test-root", layout: "root", tabId: 41, scope, apiURL: "http://127.0.0.1:49152/restricted-network/api?key=network-test-root&layout=root&mode=normal", value: "原文 π" };

test("wire caller waits for both original ready ACKs before any trigger and preserves original scope", async () => {
  const calls = [], value = { event: "response", requestId: "request-1" };
  const result = await runRestrictedNetworkWireCaller(async (method, params) => {
    calls.push({ method, params }); assert.equal(params.tabId, config.tabId); for (const [key, value] of Object.entries(scope)) assert.equal(params[key], value);
    if (method === "armNetworkWait") return { waiterId: params.event, remainingMs: 9000 };
    if (method === "collectNetworkWait") return params.waiterId === "request" ? { ...value, event: "request" } : value;
    if (method === "cancelNetworkWait") return {};
    return { value: params.action === "textContent" ? "Saved original" : null };
  }, { ...config, layout: "dynamic-oopif" });
  assert.deepEqual(calls.slice(0, 2).map(call => call.method), ["armNetworkWait", "armNetworkWait"]);
  const actions = calls.filter(call => call.method === "browserAction"); assert.deepEqual(actions.map(call => call.params.action), ["click", "fill", "click", "waitFor", "textContent"]);
  assert.deepEqual(actions[0].params.locator, [{ kind: "css", selector: "#add-network-frame" }]); assert.equal(actions[1].params.locator[0].kind, "frame");
  assert.equal(actions[1].params.args.value, config.value); assert.deepEqual(result.responseAgain, result.response); assert.equal(result.cancelled, true);
  assert.equal(calls.filter(call => call.method === "cancelNetworkWait").length, 2);
});

test("old-source arm denial retains the original error, zero inputs and exact already-armed cancellation", async () => {
  for (const deniedAt of [1, 2]) {
    const original = Error("OBU_SITE_ACCESS_DENIED: original"), calls = [], detail = {}; let arms = 0;
    await assert.rejects(runRestrictedNetworkWireCaller(async (method, params) => {
      calls.push({ method, params }); if (method === "armNetworkWait") { if (++arms === deniedAt) throw original; return { waiterId: "first", remainingMs: 9999 }; }
      if (method === "cancelNetworkWait") return {}; throw Error("Input must never be reached");
    }, config, detail), error => error === original);
    assert.equal(calls.some(call => call.method === "browserAction"), false); assert.equal(calls.filter(call => call.method === "cancelNetworkWait").length, deniedAt - 1); assert.match(detail.error, /original/);
  }
});

test("passive native observer retains original event identities without enabling or mutating traffic", () => {
  const listeners = new Set(), api = { debugger: { onEvent: { addListener: listener => listeners.add(listener), removeListener: listener => listeners.delete(listener), hasListener: listener => listeners.has(listener) } } }, target = {};
  installRestrictedNetworkEvidence(api, target, 41); const listener = [...listeners][0], params = { requestId: "native-1", frameId: "child-target", request: { url: config.apiURL, method: "POST", postData: "original" } }, original = structuredClone(params);
  listener({ tabId: 99 }, "Network.requestWillBeSent", params); listener({ tabId: 41, sessionId: "child-session" }, "Network.requestWillBeSent", params);
  listener({ tabId: 41, sessionId: "child-session" }, "Network.responseReceived", { requestId: "native-1", response: { url: config.apiURL, status: 201 } });
  const snapshot = target.__restrictedNetworkEvidence.snapshot(); snapshot.rows[0].params.request.url = "mutated copy"; assert.equal(listeners.size, 1);
  const detail = target.__restrictedNetworkEvidence.stop(); assert.deepEqual(params, original); assert.equal(detail.rows.length, 2); assert.equal(detail.rows[0].source.sessionId, "child-session"); assert.equal(detail.rows[0].params.frameId, "child-target"); assert.equal(detail.restored, true); assert.equal(detail.removed, true); assert.equal(listeners.size, 0);
});

test("HTTP fixture records original UTF8 bytes and holds headers without replay or second request", async () => {
  const fixtures = createRestrictedNetworkFixtures(), server = http.createServer((request, response) => { if (!fixtures.handle(request, response, new URL(request.url, `http://127.0.0.1:${server.address().port}`))) { response.writeHead(404); response.end(); } });
  await listenFixture(server);
  try {
    const url = restrictedNetworkURL(`http://127.0.0.1:${server.address().port}/`, "network-http-test", "root", "headers-gate"), html = await (await fetch(url)).text(); new vm.Script(html.match(/<script>([\s\S]*)<\/script>/)[1]);
    const original = fixtures.stats("network-http-test").documents[0]; assert.equal(original.sha256, sha(Buffer.from(html)));
    const body = JSON.stringify({ key: original.key, trustedSubmit: true, documentToken: original.documentToken, href: url, value: "Original π 原文" });
    const pending = fetch(restrictedNetworkAPIURL(url), { method: "POST", body });
    await new Promise((resolve, reject) => { const started = Date.now(); const check = () => { if (fixtures.stats(original.key).posts[0]?.bodySHA256) return resolve(); if (Date.now() - started > 2000) return reject(Error("HTTP body not recorded")); setTimeout(check, 5); }; check(); });
    assert.equal(fixtures.stats(original.key).posts[0].headersAt, undefined); fixtures.release(original.key); const response = await pending; assert.equal(response.status, 201);
    const receipt = await response.json(), post = fixtures.stats(original.key).posts[0]; assert.equal(post.bodyBase64, Buffer.from(body).toString("base64")); assert.equal(post.bodySHA256, sha(Buffer.from(body))); assert.equal(receipt.bodySHA256, post.bodySHA256); assert.equal(fixtures.stats(original.key).posts.length, 1);
  } finally { fixtures.close(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
});

test("child original document and API keep actual localhost host despite a loopback runner base", () => {
  const fixtures = createRestrictedNetworkFixtures(), request = new EventEmitter(); Object.assign(request, { method: "GET", url: "/restricted-network/frame?key=child-native&layout=oopif&mode=normal", headers: { host: "localhost:49152" } });
  let status; const response = { writeHead: value => { status = value; }, end() {} };
  assert.equal(fixtures.handle(request, response, new URL(request.url, "http://127.0.0.1:49152")), true); assert.equal(status, 200);
  const doc = fixtures.stats("child-native").documents[0]; assert.equal(new URL(doc.href).hostname, "localhost"); assert.equal(new URL(doc.apiURL).hostname, "localhost");
  request.headers.host = "foreign.example:49152"; fixtures.handle(request, response, new URL(request.url, "http://127.0.0.1:49152")); assert.equal(status, 400);
});

function evidence() {
  const url = restrictedNetworkURL("http://127.0.0.1:49152/", config.key), token = "document-original", events = ["input", "click", "submit"].map((type, index) => ({ type, targetId: ["note", "save", "form"][index], trusted: true }));
  const value = { key: config.key, href: url, documentToken: token, nodeToken: `${token}-note`, value: config.value, events, trustedSubmit: true }, bytes = Buffer.from(JSON.stringify(value)), receipt = { key: config.key, index: 1, documentToken: token, bodySHA256: sha(bytes) };
  const record = { documents: [{ child: false, documentToken: token, href: url }], posts: [{ value, bodyBytes: bytes.length, bodyBase64: bytes.toString("base64"), bodySHA256: sha(bytes), receipt, status: 201, finishedAt: 10 }] };
  const state = { documentToken: token, original: true, overflow: false, errors: [], href: url, value: config.value, nodeToken: value.nodeToken, events, receipt, completions: [{ status: 201, url: config.apiURL }] };
  const request = { event: "request", requestId: "request-1", url: config.apiURL, method: "POST", resourceType: "fetch", frameUrl: url }, response = { ...request, event: "response", status: 201, statusText: "Created" };
  const item = { ...config, callerResult: { scope, tabId: config.tabId, requestAck: { waiterId: "request-wait", remainingMs: 9990 }, responseAck: { waiterId: "response-wait", remainingMs: 9980 }, request, response, responseAgain: structuredClone(response), cancelled: true, receipt: `Saved ${config.key} 1 ${sha(bytes)}` },
    before: { documents: [{ documentId: "original-native-document", result: { documentToken: token } }] }, after: { documents: [{ documentId: "original-native-document", result: state }], targets: [{ type: "page", id: "root-target", tabId: config.tabId }] },
    nativeEvidence: { overflow: false, restored: true, removed: true, rows: [{ method: "Network.requestWillBeSent", source: { tabId: config.tabId }, params: { requestId: "native-1", frameId: "root-target", request: { url: config.apiURL, method: "POST", postData: bytes.toString("utf8") } } }, { method: "Network.responseReceived", source: { tabId: config.tabId }, params: { requestId: "native-1", response: { url: config.apiURL, status: 201 } } }] } };
  return { item, record };
}

test("metadata oracle binds original request/response, native route, trusted bytes and retained document", () => {
  const original = evidence(); assert.equal(checkRestrictedNetworkEvidence(original.item, original.record).posts, 1);
  for (const mutate of [x => x.item.callerResult.response.requestId = "request-2", x => x.item.callerResult.request.headers = { secret: "bad" }, x => x.item.callerResult.response.frameUrl = "http://foreign/", x => x.item.after.documents[0].documentId = "changed",
    x => x.item.after.documents[0].result.events[0].trusted = false, x => x.record.posts[0].bodySHA256 = "bad", x => x.item.nativeEvidence.rows[0].source.tabId = 99, x => x.item.nativeEvidence.rows[1].params.requestId = "native-2", x => x.item.nativeEvidence.rows.push(structuredClone(x.item.nativeEvidence.rows[0]))]) {
    const copy = structuredClone(original); mutate(copy); assert.throws(() => checkRestrictedNetworkEvidence(copy.item, copy.record));
  }
});

test("orchestrator retains before/after and zero POST ledger when original arm is denied", async () => {
  const original = Error("OBU_SITE_ACCESS_DENIED: old production"), detail = {}, page = { observer: { ready: true }, documents: [{ documentId: "doc", result: { documentToken: "original" } }] };
  let inputs = 0, stopped = 0; const tab = { id: 41, expectRequest: async () => { throw original; }, locator: () => ({ click: () => inputs++ }) };
  const worker = { async evaluate(script) { if (script.includes(".stop()")) { stopped++; return { rows: [], restored: true, removed: true, overflow: false }; } if (script.includes("const observer=")) return page; return undefined; } };
  await assert.rejects(checkRestrictedNetworkCaller({ kind: "js", browser: { client: { sessionId: scope.session_id, turnId: scope.turn_id, controlEpoch: scope.control_epoch }, newTab: async () => tab }, fixtureURL: "http://fixture/", fixtures: { stats: () => ({ posts: [] }), allStats: () => [{ posts: [] }] }, getWorker: () => worker, until: callback => callback(), detail }), error => error === original);
  assert.equal(detail.variants.length, 1); assert.deepEqual(detail.variants[0].before, page); assert.deepEqual(detail.variants[0].after, page); assert.equal(detail.variants[0].server.posts.length, 0); assert.equal(stopped, 1); assert.equal(inputs, 0); assert.match(detail.variants[0].callerResult.error, /old production/);
});

function boundaryEvidence() {
  const { item, record } = evidence(); Object.assign(item, { name: "original", url: record.documents[0].href, mode: "normal", server: record,
    submissions: [{ value: config.value, completed: true, status: 201, responseURL: config.apiURL, receipt: item.callerResult.receipt }],
    acks: { request: item.callerResult.requestAck, response: item.callerResult.responseAck }, results: { request: item.callerResult.request, response: item.callerResult.response },
    expectedResults: { request: { event: "request", url: config.apiURL, method: "POST" }, response: { event: "response", url: config.apiURL, method: "POST", status: 201 } }, rejections: [], cancellations: [{ name: "request", success: true }, { name: "response", success: true }] });
  item.before.documents[0].frameId = 0; Object.assign(item.before.documents[0].result, { original: true, events: [], href: item.url }); item.after.documents[0].frameId = 0;
  record.redirects = []; record.posts[0].index = 1; record.posts[0].method = "POST"; record.posts[0].href = item.apiURL;
  item.after.documents[0].result.completions[0].receipt = record.posts[0].receipt;
  item.nativeEvidence.rows[0].params.loaderId = "original-loader"; item.nativeEvidence.rows.push({ method: "Network.loadingFinished", source: { tabId: config.tabId }, params: { requestId: "native-1" } });
  item.nativeEvidence.rows.forEach((row, index) => { row.sequence = index + 1; });
  return item;
}

test("boundary oracle independently binds each unique trusted POST, native completion and exact metadata", () => {
  const original = boundaryEvidence(); assert.equal(checkRestrictedNetworkBoundaryEvidence(original).posts, 1);
  for (const mutate of [x => x.server.posts.push(structuredClone(x.server.posts[0])), x => x.nativeEvidence.rows.push(structuredClone(x.nativeEvidence.rows[0])), x => x.nativeEvidence.rows.pop(),
    x => x.nativeEvidence.rows[0].params.loaderId = "", x => x.nativeEvidence.rows[0].params.frameId = "foreign", x => x.nativeEvidence.rows[1].source.sessionId = "foreign", x => x.nativeEvidence.rows[2].sequence = 0, x => x.results.response.requestId = "other-request", x => x.results.response.body = "forbidden body",
    x => x.after.documents[0].documentId = "different", x => x.after.documents[0].result.original = false, x => x.server.posts[0].bodyBase64 = Buffer.from("{}", "utf8").toString("base64"),
    x => x.cancellations.pop(), x => x.cancellations[0].error = "OBU_NETWORK_WAIT_TIMEOUT", x => x.expectedResults.extra = { event: "request" }, x => x.rejections.push({ name: "denied", authority: "denied", error: "OBU_NETWORK_WAIT_FAILED: unrelated" }),
    x => x.rejections.push({ name: "expired", authority: "retired", error: "OBU_NETWORK_WAIT_TIMEOUT: elapsed" }), x => x.rejections.push({ name: "denied", authority: "denied", error: "OBU_SITE_ACCESS_DENIED", metadata: {} })]) {
    const copy = structuredClone(original); mutate(copy); assert.throws(() => checkRestrictedNetworkBoundaryEvidence(copy));
  }
});

test("retained response navigation requires a new native document and original pre-navigation receipt", () => {
  const item = boundaryEvidence(); item.beforeNavigation = structuredClone(item.after); item.navigated = true;
  Object.assign(item.after.documents[0], { documentId: "new-document" }); Object.assign(item.after.documents[0].result, { documentToken: "new-token", events: [], completions: [], receipt: null });
  item.rejections.push({ name: "retained", authority: "retired", error: "OBU_NETWORK_WAIT_EXPIRED: original document" }); assert.equal(checkRestrictedNetworkBoundaryEvidence(item).posts, 1);
  for (const mutate of [x => x.after.documents[0].documentId = x.before.documents[0].documentId, x => x.after.documents[0].result.documentToken = x.before.documents[0].result.documentToken,
    x => delete x.beforeNavigation, x => x.beforeNavigation.documents[0].result.completions[0].receipt.bodySHA256 = "other", x => x.beforeNavigation.documents[0].result.events[0].trusted = false]) {
    const copy = structuredClone(item); mutate(copy); assert.throws(() => checkRestrictedNetworkBoundaryEvidence(copy));
  }
});

test("policy epoch cancellation rejects control errors only; site-only cancellation still requires success", () => {
  const item = boundaryEvidence(); item.policyRetired = true; item.cancellations = [{ name: "request", error: "OBU_STALE_CONTROL_EPOCH: old" }, { name: "response", error: "OBU_AUTOMATION_PAUSED: old" }];
  assert.equal(checkRestrictedNetworkBoundaryEvidence(item).posts, 1);
  for (const error of ["OBU_SITE_ACCESS_DENIED", "OBU_NETWORK_WAIT_EXPIRED", "OBU_NETWORK_WAIT_FAILED", "OBU_NETWORK_WAIT_TIMEOUT"]) { const copy = structuredClone(item); copy.cancellations[0].error = error; assert.throws(() => checkRestrictedNetworkBoundaryEvidence(copy)); }
  const sameEpoch = structuredClone(item); delete sameEpoch.policyRetired; assert.throws(() => checkRestrictedNetworkBoundaryEvidence(sameEpoch));
});

test("held response evidence refuses an already delivered response or already sent headers", () => {
  const item = boundaryEvidence(); item.heldBeforeArm = { nativePosts: [item.nativeEvidence.rows[0]], nativeResponses: [] }; checkRestrictedNetworkBoundaryEvidence(item);
  for (const mutate of [x => x.heldBeforeArm.headersAt = 1, x => x.heldBeforeArm.nativePosts.push(x.nativeEvidence.rows[0]), x => x.heldBeforeArm.nativeResponses.push(x.nativeEvidence.rows[1])]) {
    const copy = structuredClone(item); mutate(copy); assert.throws(() => checkRestrictedNetworkBoundaryEvidence(copy));
  }
});

test("navigation no-response requires original server closure before headers, a new committed document and original timeout without claiming native cancellation", () => {
  const item = boundaryEvidence(); item.name = "navigation-no-response"; item.mode = "headers-gate"; item.navigated = true; item.submissions[0].completed = false;
  Object.assign(item.after.documents[0], { documentId: "new-document" }); Object.assign(item.after.documents[0].result, { documentToken: "new-token", events: [], completions: [], receipt: null, value: "" });
  item.server.documents.push({ href: item.url, documentToken: "new-token" }); const post = item.server.posts[0]; post.responseClosedBeforeHeaders = true; for (const field of ["status", "headersAt", "finishedAt"]) delete post[field];
  item.results = {}; item.expectedResults = {}; delete item.acks.request; item.cancellations = [{ name: "response", success: true }]; item.ackTiming = { response: { startedAt: 1000, readyAt: 1001, timeoutMs: 3000 } };
  item.acks.response.remainingMs = 2999; item.rejections = [{ name: "original-response-timeout-after-navigation", authority: "no-response", error: "OBU_NETWORK_WAIT_TIMEOUT: initial deadline", at: 4001 }];
  item.nativeEvidence.rows[0].params.documentURL = item.url;
  item.nativeEvidence.rows = [item.nativeEvidence.rows[0],
    { sequence: 2, method: "Network.requestWillBeSent", source: { tabId: config.tabId }, params: { requestId: "navigation", loaderId: "new-loader", frameId: "root-target", documentURL: item.url, type: "Document", request: { method: "GET", url: item.url } } },
    { sequence: 3, method: "Network.responseReceived", source: { tabId: config.tabId }, params: { requestId: "navigation", response: { url: item.url, status: 200 } } },
    { sequence: 4, method: "Page.frameNavigated", source: { tabId: config.tabId }, params: { frame: { id: "root-target", loaderId: "new-loader", url: item.url } } },
    { sequence: 5, method: "Network.loadingFinished", source: { tabId: config.tabId }, params: { requestId: "navigation" } }
  ];
  item.heldBeforeNavigation = { nativePosts: [structuredClone(item.nativeEvidence.rows[0])], nativeResponses: [] };
  const proof = checkRestrictedNetworkBoundaryEvidence(item); assert.equal(proof.posts, 1); assert.equal(proof.authorityRejections, 0); assert.equal(proof.noResponseTimeouts, 1); assert.equal(item.noResponseProof.classification, "navigation-no-response");
  // A delivered native failure remains original evidence, but neither its
  // presence nor its canceled flag substitutes for the server/commit proof.
  const withNativeFailure = structuredClone(item); const failure = { sequence: 6, method: "Network.loadingFailed", source: { tabId: config.tabId }, params: { requestId: "native-1", canceled: false, errorText: "original native failure" } };
  withNativeFailure.nativeEvidence.rows.push(failure); checkRestrictedNetworkBoundaryEvidence(withNativeFailure); assert.deepEqual(withNativeFailure.nativeEvidence.rows.at(-1), failure);
  for (const mutate of [x => delete x.server.posts[0].responseClosedBeforeHeaders, x => x.server.posts[0].responseClosedBeforeHeaders = false,
    ...["headersAt", "status", "finishedAt"].map(field => x => x.server.posts[0][field] = undefined),
    x => x.nativeEvidence.rows.push({ method: "Network.responseReceived", params: { requestId: "native-1" } }), x => x.nativeEvidence.rows.push({ method: "Network.loadingFinished", params: { requestId: "native-1" } }),
    x => x.nativeEvidence.rows[1].params.frameId = "foreign", x => x.nativeEvidence.rows[1].params.loaderId = "original-loader", x => x.nativeEvidence.rows[3].params.frame.loaderId = "foreign",
    x => x.nativeEvidence.rows[1].params.request.method = "POST", x => x.nativeEvidence.rows[1].params.documentURL = "foreign", x => x.nativeEvidence.rows[3].sequence = 0,
    x => x.server.documents[1].documentToken = "wrong", x => x.after.documents[0].documentId = x.before.documents[0].documentId, x => x.server.posts.push(structuredClone(x.server.posts[0])),
    x => x.rejections[0].at = 3999, x => x.ackTiming.response.timeoutMs = 10000, x => x.name = "policy-revocation", x => x.rejections[0].authority = "retired",
    ...["OBU_NETWORK_WAIT_FAILED: unrelated", "OBU_NETWORK_WAIT_EXPIRED: unrelated", "OBU_SITE_ACCESS_DENIED: unrelated"].map(error => x => x.rejections[0].error = error)]) {
    const copy = structuredClone(item); mutate(copy); assert.throws(() => checkRestrictedNetworkBoundaryEvidence(copy));
  }
});

test("legitimate document navigation binds original request-event frame URL to a distinct committed loader and document", () => {
  const item = boundaryEvidence(), token = "next-token"; item.name = "allowed-document-navigation"; item.destinationURL = `${item.url}&navigation=destination`; item.submissions = []; item.server.posts = [];
  item.server.documents.push({ documentToken: token, child: false, href: item.destinationURL });
  Object.assign(item.after.documents[0], { documentId: "next-document" }); Object.assign(item.after.documents[0].result, { documentToken: token, href: item.destinationURL, events: [], completions: [], receipt: null });
  for (const event of ["request", "response"]) Object.assign(item.results[event], { url: item.destinationURL, method: "GET", resourceType: "document", ...(event === "response" ? { status: 200 } : {}) });
  item.nativeEvidence.rows = [
    { sequence: 1, source: { tabId: config.tabId }, method: "Network.requestWillBeSent", params: { requestId: "native-navigation", frameId: "root-target", loaderId: "new-loader", type: "Document", documentURL: item.destinationURL, request: { method: "GET", url: item.destinationURL } } },
    { sequence: 2, source: { tabId: config.tabId }, method: "Network.responseReceived", params: { requestId: "native-navigation", response: { url: item.destinationURL, status: 200 } } },
    { sequence: 3, source: { tabId: config.tabId }, method: "Page.frameNavigated", params: { frame: { id: "root-target", loaderId: "new-loader", url: item.destinationURL } } },
    { sequence: 4, source: { tabId: config.tabId }, method: "Network.loadingFinished", params: { requestId: "native-navigation" } }
  ];
  assert.equal(checkRestrictedNetworkBoundaryEvidence(item).navigationGETs, 1);
  for (const mutate of [x => x.results.request.frameUrl = x.destinationURL, x => x.results.response.requestId = "other", x => x.nativeEvidence.rows[2].params.frame.loaderId = "other",
    x => x.nativeEvidence.rows[2].sequence = 0, x => x.nativeEvidence.rows[0].params.documentURL = x.url, x => x.after.documents[0].documentId = x.before.documents[0].documentId,
    x => x.server.posts.push({}), x => x.nativeEvidence.rows.push(structuredClone(x.nativeEvidence.rows[0]))]) {
    const copy = structuredClone(item); mutate(copy); assert.throws(() => checkRestrictedNetworkBoundaryEvidence(copy));
  }
});

test("real HTTP redirect fixture preserves the one original POST and ordered cross-origin GET hops", async () => {
  const fixtures = createRestrictedNetworkFixtures(), server = http.createServer((request, response) => { if (!fixtures.handle(request, response, new URL(request.url, `http://127.0.0.1:${server.address().port}`))) { response.writeHead(404); response.end(); } });
  await listenFixture(server);
  try {
    for (const mode of ["redirect", "redirect-denied"]) {
      const key = `http-${mode}`, url = restrictedNetworkURL(`http://127.0.0.1:${server.address().port}`, key, "root", mode); await (await fetch(url)).text(); const doc = fixtures.stats(key).documents[0];
      const body = JSON.stringify({ key, documentToken: doc.documentToken, href: url, trustedSubmit: true, value: "唯一原文 π" });
      const response = await fetch(restrictedNetworkAPIURL(url), { method: "POST", headers: { "Content-Type": "text/plain;charset=UTF-8" }, body }); assert.equal(response.status, 200);
      const receipt = await response.json(), record = fixtures.stats(key); assert.equal(record.posts.length, 1); assert.equal(record.posts[0].bodySHA256, sha(Buffer.from(body))); assert.deepEqual(receipt, record.posts[0].receipt);
      assert.deepEqual(record.redirects.map(row => [row.method, new URL(row.href).hostname]), mode === "redirect" ? [["GET", "localhost"]] : [["GET", "localhost"], ["GET", "127.0.0.1"]]);
      assert.equal(new URL(response.url).hostname, mode === "redirect" ? "localhost" : "127.0.0.1");
    }
  } finally { fixtures.close(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
});

test("boundary arm failure preserves zero triggers, original error and exact cleanup secondary errors", async () => {
  for (const failFinalize of [false, true]) {
  const original = Error("OBU_SITE_ACCESS_DENIED: original arm"), saved = [], removed = [], cleanupOrder = [], state = { documents: [{ documentId: "original", frameId: 0, result: { documentToken: "original", original: true, events: [] } }] }; let stopped = 0, closed = 0, inputs = 0;
  const worker = { async evaluate(script) { if (script.includes(".stop()")) { stopped++; return { rows: [], restored: true, removed: true, overflow: false }; } if (script.includes("const observer=")) return state;
    if (script.includes(".map(row=>row.targetId)")) return []; if (script.includes("chrome.tabs.remove")) { cleanupOrder.push("remove"); removed.push(41); throw Error("cleanup secondary"); } if (script.includes("probePresent")) return { tabs: [], targets: [], probePresent: false }; } };
  const tab = { id: 41, expectRequest: async () => { throw original; }, locator: () => ({ click: () => inputs++ }) };
  const finalizeACK = { endedTurnId: scope.turn_id, control_epoch: scope.control_epoch + 1 };
  await assert.rejects(checkRestrictedNetworkBoundaries({ connectBrowser: async () => ({ client: { sessionId: scope.session_id, turnId: scope.turn_id, controlEpoch: scope.control_epoch, beginTurn() { throw Error("Cleanup must not begin another turn"); }, async finalizeTabs(keep) { assert.deepEqual(keep, []); cleanupOrder.push("finalize"); if (failFinalize) throw Error("finalize secondary"); return finalizeACK; } }, newTab: async () => tab, close: () => { cleanupOrder.push("close"); closed++; } }), getWorker: () => worker,
    fixtureURL: "http://127.0.0.1:49152/", fixtures: { release() {}, stats: () => ({ documents: [], posts: [], redirects: [] }), allStats: () => [] }, controls: {}, until: callback => callback(), saveDetail: detail => saved.push(detail) }), error => error === original);
  assert.equal(inputs, 0); assert.equal(stopped, 1); assert.equal(closed, 1); assert.deepEqual(removed, [41]); assert.equal(saved[0].cases.length, 1); assert.equal(saved[0].cases[0].server.posts.length, 0);
  assert.match(saved[0].error, /original arm/); assert.match(saved[0].tabCleanupErrors[0].error, /cleanup secondary/);
  assert.deepEqual(cleanupOrder, ["remove", "finalize", "close"]); assert.deepEqual(saved[0].finalizeScope, scope);
  if (failFinalize) assert.match(saved[0].finalizeError, /finalize secondary/); else assert.equal(saved[0].finalize, finalizeACK);
  }
});

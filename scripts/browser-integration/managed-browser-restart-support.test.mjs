import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { createHash } from "node:crypto";
import { createManagedBrowserRestartFixture, managedBrowserRestartURLs } from "./managed-browser-restart-fixture.mjs";
import { managedBrowserRestartMode, readManagedRestartPreferences, managedRestartTaskGeneration, readManagedRestartRunInventory, classifyManagedRestartStartup, assertManagedRestartLaunch, assertManagedRestartManifest, selectManagedRestartWorker, assertManagedRestartWorkerRuntime, assertManagedRestartIdentity, assertManagedRestartOriginalPosts, assertManagedRestartFollowup, assertManagedRestartPostLedger, assertManagedRestartNativeTarget, assertManagedRestartFinalResults, assertManagedRestartDefaultEmpty, assertManagedRestartCrashTerminal, assertManagedRestartRestoredDraft, assertManagedRestartAuthenticationSeed, assertManagedRestartAuthenticatedPostLedger, assertManagedRestartAuthentication } from "./managed-browser-restart-support.mjs";

const stats = () => ({ overflow: false, originalPOST: ["prg", "cache", "no-store"].map(kind => ({ kind, status: kind === "prg" ? 303 : 200, receiptId: kind })), followupPOST: [], receipts: Object.fromEntries(["prg", "cache", "no-store"].map(kind => [kind, { receiptId: kind }])) });
test("case arguments are explicit and do not silently select crash", () => {
  assert.equal(managedBrowserRestartMode([]), "normal"); for (const mode of ["normal", "crash", "crash-established", "crash-authenticated", "default"]) assert.equal(managedBrowserRestartMode(["--case", mode]), mode);
  for (const args of [["--crash"], ["--case", "all"], ["--case", "crash", "ignored"]]) assert.throws(() => managedBrowserRestartMode(args));
});
const preferenceIO = (value, file = {}) => {
  const bytes = Buffer.isBuffer(value) ? value : Buffer.from(JSON.stringify(value));
  return { lstat: async () => ({ size: bytes.length, isFile: () => true, isSymbolicLink: () => false, ...file }), readFile: async () => bytes };
};
test("native preference observation hashes actual bytes and does not invent a crash checkpoint", async () => {
  const bytes = Buffer.from('{"profile":{"exit_type":"Crashed"}}');
  const value = await readManagedRestartPreferences("unused", preferenceIO(bytes));
  assert.equal(value.exists, true); assert.equal(value.exitType, "Crashed"); assert.equal(value.bytes, bytes.length); assert.match(value.sha256, /^[0-9a-f]{64}$/);
  const spaced = await readManagedRestartPreferences("unused", preferenceIO(Buffer.concat([bytes, Buffer.from("\n")]))); assert.notEqual(value.sha256, spaced.sha256);
  assert.equal((await readManagedRestartPreferences("unused", preferenceIO({ profile: { exit_type: "Normal" } }))).exitType, "Normal");
  assert.equal((await readManagedRestartPreferences("unused", preferenceIO({ profile: {} }))).exitType, null);
  const missing = await readManagedRestartPreferences("unused", { lstat: async () => { throw Object.assign(Error("missing"), { code: "ENOENT" }); } }); assert.equal(missing.exists, false); assert.equal(missing.exitType, undefined);
});
test("native preference observation rejects malformed, non-file, unknown-state and inaccessible evidence", async () => {
  for (const bytes of [Buffer.from("{"), Buffer.from("null"), Buffer.from("[]"), Buffer.from('{"profile":[]}'), Buffer.from('{"profile":{"exit_type":"unknown"}}'), Buffer.from([0xff])]) await assert.rejects(readManagedRestartPreferences("unused", preferenceIO(bytes)));
  for (const file of [{ isFile: () => false }, { isSymbolicLink: () => true }, { size: 4 * 1024 * 1024 + 1 }]) await assert.rejects(readManagedRestartPreferences("unused", preferenceIO({ profile: {} }, file)));
  for (const code of ["EACCES", "EIO", "ENOTDIR"]) await assert.rejects(readManagedRestartPreferences("unused", { lstat: async () => { throw Object.assign(Error(code), { code }); } }), { code });
});
test("replacement references original task generation even when profile establishment comes first", () => {
  const seed = { number: 0 }, original = { number: 1 }, replacement = { number: 2 };
  assert.equal(managedRestartTaskGeneration([seed, original, replacement]), original); assert.equal(managedRestartTaskGeneration([original, replacement]), original);
  assert.throws(() => managedRestartTaskGeneration([seed, replacement])); assert.throws(() => managedRestartTaskGeneration([seed, original, { number: 1 }]));
});
test("run inventory distinguishes initial absence from filesystem failures and unknown entries", async () => {
  const readError = code => ({ readdir: async () => { throw Object.assign(Error(code), { code }); } });
  const missing = await readManagedRestartRunInventory("unused", readError("ENOENT")); assert.equal(missing.exists, false); assert.deepEqual(missing.runIds, []);
  for (const code of ["EACCES", "ENOTDIR", "EIO"]) await assert.rejects(readManagedRestartRunInventory("unused", readError(code)), { code });
  const entry = { name: "a".repeat(32), isDirectory: () => true, isSymbolicLink: () => false };
  assert.deepEqual((await readManagedRestartRunInventory("unused", { readdir: async () => [entry] })).runIds, [entry.name]);
  for (const rows of [[{ ...entry, name: "unknown" }], [{ ...entry, isDirectory: () => false }], [{ ...entry, isSymbolicLink: () => true }], [entry, entry]]) await assert.rejects(readManagedRestartRunInventory("unused", { readdir: async () => rows }));
});
const startupFailure = () => ({ before: { exists: true, runIds: ["a".repeat(32)] }, after: { exists: true, runIds: ["a".repeat(32)] }, readyObserved: false,
  terminal: { pid: 123, startedAt: 100, exitedAt: 200, closedAt: 201, code: 1, signal: null, stdout: "", stderr: "original managed startup failure\n" } });
test("startup before run creation records the original failed launcher without inventing lifecycle cleanup", () => {
  const value = startupFailure(), result = classifyManagedRestartStartup(value); assert.equal(result.phase, "before-run-created"); assert.equal(result.lifecycleCreated, false); assert.deepEqual(result.createdRunIds, []);
  assert.equal(result.launcher.stderr, value.terminal.stderr); assert.equal(result.launcher.code, 1);
  const initial = startupFailure(); initial.before = initial.after = { exists: false, runIds: [] }; assert.equal(classifyManagedRestartStartup(initial).phase, "before-run-created");
});
test("a created run still requires its own lifecycle and ambiguous or disappeared directories fail", () => {
  const value = startupFailure(); value.after.runIds.push("b".repeat(32)); assert.deepEqual(classifyManagedRestartStartup(value), { phase: "run-created", runId: "b".repeat(32) });
  value.after.runIds.push("c".repeat(32)); assert.throws(() => classifyManagedRestartStartup(value));
  for (const after of [{ exists: false, runIds: [] }, { exists: true, runIds: [] }, { exists: true, runIds: ["a".repeat(32), "a".repeat(32)] }]) assert.throws(() => classifyManagedRestartStartup({ ...startupFailure(), after }));
});
test("no directory difference cannot excuse a live, forced, ready or ambiguous launcher", () => {
  for (const mutate of [value => value.readyObserved = true, value => delete value.terminal.closedAt, value => delete value.terminal.exitedAt, value => value.terminal.closedAt = 99, value => value.terminal.code = 0, value => value.terminal.code = null, value => value.terminal.signal = "SIGTERM", value => value.terminal.termination = { reason: "timeout" }, value => value.terminal.spawnError = "spawn failed", value => value.terminal.closeIncomplete = true, value => value.terminal.stdout = '{"state":"ready"}', value => value.terminal.stdout = '{"state":', value => delete value.terminal.stderr]) {
    const value = startupFailure(); mutate(value); assert.throws(() => classifyManagedRestartStartup(value));
  }
});
test("explicit restore requires exactly both native flags while default launch has neither", () => {
  const life = { info: { restoreRequested: true }, commandLine: ["chrome.exe", "--headless=new", "--restore-last-session", "--hide-crash-restore-bubble"] };
  assertManagedRestartLaunch(life, true);
  assert.throws(() => assertManagedRestartLaunch({ ...life, commandLine: [...life.commandLine, "about:blank"] }, true));
  assert.throws(() => assertManagedRestartLaunch({ ...life, commandLine: [...life.commandLine, "--no-sandbox"] }, true));
  assert.throws(() => assertManagedRestartLaunch(life, false));
  for (const flag of ["--restore-last-session", "--hide-crash-restore-bubble"]) {
    assert.throws(() => assertManagedRestartLaunch({ ...life, commandLine: life.commandLine.filter(value => value !== flag) }, true));
    assert.throws(() => assertManagedRestartLaunch({ ...life, commandLine: [...life.commandLine, flag] }, true));
    assert.throws(() => assertManagedRestartLaunch({ ...life, commandLine: life.commandLine.map(value => value === flag ? `${flag}=true` : value) }, true));
  }
  const defaultLife = { info: {}, commandLine: ["chrome.exe", "--headless=new", "about:blank"] }; assertManagedRestartLaunch(defaultLife, false);
  assert.throws(() => assertManagedRestartLaunch({ ...defaultLife, commandLine: [...defaultLife.commandLine, "--hide-crash-restore-bubble"] }, false));
  assert.throws(() => assertManagedRestartLaunch({ ...defaultLife, commandLine: [...defaultLife.commandLine, "--restore-last-session=true"] }, false));
});
test("manifest evidence observes natural numeric increase or decrease without imposing either", () => {
  const manifest = { version: "2.10.0.1", version_name: "0.1.0" };
  assert.equal(assertManagedRestartManifest(manifest, manifest, "2.9.99.99").comparison.direction, "increase");
  assert.equal(assertManagedRestartManifest(manifest, manifest, "3.0.0.0").comparison.direction, "decrease");
  assert.throws(() => assertManagedRestartManifest(manifest, { ...manifest, version: "2.9.99.99" }, "2.9.99.99"));
  assert.throws(() => assertManagedRestartManifest(manifest, manifest, manifest.version));
  assert.throws(() => assertManagedRestartManifest(manifest, { ...manifest, version_name: "other" }));
  assert.throws(() => assertManagedRestartManifest({ ...manifest, background: { service_worker: "current.js", type: "module" } }, { ...manifest, background: { service_worker: "old.js", type: "module" } }));
});
const worker = digit => {
  const info = { runId: digit.repeat(32), extensionId: "a".repeat(32) }, entry = `managed-worker-${info.runId}.js`, manifest = { background: { service_worker: entry, type: "module" } };
  const target = { id: `target-${digit}`, type: "service_worker", url: `chrome-extension://${info.extensionId}/${entry}`, webSocketDebuggerUrl: `ws://127.0.0.1:1/${digit}` }; return { info, manifest, target };
};
test("worker selection requires the exact staged per-run entry, not any extension worker", () => {
  const old = worker("1"), fresh = worker("2"), targets = [old.target, { ...fresh.target, id: "old-background", url: `chrome-extension://${fresh.info.extensionId}/background.js` }, fresh.target];
  assert.equal(selectManagedRestartWorker(fresh.info, fresh.manifest, targets).target.id, fresh.target.id);
  for (const rows of [[old.target], [fresh.target, fresh.target], [{ ...fresh.target, type: "page" }], [{ ...fresh.target, url: fresh.target.url + "?other" }]]) assert.throws(() => selectManagedRestartWorker(fresh.info, fresh.manifest, rows));
  for (const entry of [old.manifest.background.service_worker, "background.js", "../worker.js", fresh.target.url]) assert.throws(() => selectManagedRestartWorker(fresh.info, { background: { service_worker: entry, type: "module" } }, targets));
  assert.throws(() => selectManagedRestartWorker(fresh.info, { background: { service_worker: fresh.manifest.background.service_worker } }, targets));
});
test("connected runtime location and replacement entry must match original target evidence", () => {
  const old = worker("1"), fresh = worker("2"), selectedOld = selectManagedRestartWorker(old.info, old.manifest, [old.target]), selected = selectManagedRestartWorker(fresh.info, fresh.manifest, [fresh.target]);
  const before = assertManagedRestartWorkerRuntime(selectedOld, old.target.url), after = assertManagedRestartWorkerRuntime(selected, fresh.target.url, before); assert.equal(after.previousEntry, before.entry);
  assert.throws(() => assertManagedRestartWorkerRuntime(selected, old.target.url, before));
  assert.throws(() => assertManagedRestartWorkerRuntime(selectedOld, old.target.url, before));
  assert.throws(() => assertManagedRestartWorkerRuntime({ ...selected, target: { ...selected.target, id: before.targetId } }, fresh.target.url, before));
});
test("new process identity accepts PID reuse only with a new creation time", () => {
  const make = value => ({ info: { profileDir: "profile", runId: value, runDir: value, socketPath: value, nativeHostName: value, extensionId: "same" }, browserIncarnation: value, workerBootId: value, browserRoot: value, browser: { ProcessId: 1, CreationDate: value }, native: { ProcessId: 2, CreationDate: value } });
  const old = make("old"), fresh = make("new"); assertManagedRestartIdentity(old, fresh);
  for (const field of ["browser", "native", "browserIncarnation", "workerBootId", "browserRoot"]) assert.throws(() => assertManagedRestartIdentity(old, { ...fresh, [field]: old[field] }));
  assert.throws(() => assertManagedRestartIdentity(old, { ...fresh, info: { ...fresh.info, socketPath: old.info.socketPath } }));
});
test("a rejected duplicate is still a replay failure", () => {
  const value = stats(); assertManagedRestartOriginalPosts(value); value.originalPOST.push({ kind: "cache", status: 409 }); assert.throws(() => assertManagedRestartOriginalPosts(value));
});
test("unchanged original receipts include original request records", () => {
  const old = stats(), fresh = structuredClone(old); assertManagedRestartOriginalPosts(fresh, old);
  fresh.originalPOST[0].at = 123; assert.throws(() => assertManagedRestartOriginalPosts(fresh, old));
});
test("followup must be one distinct work-page transaction tied to the old receipt", () => {
  const value = stats(); value.followupPOST = [{ status: 303, receiptId: "followup" }]; value.receipts.followup = { receiptId: "followup", originalReceiptId: "prg", source: "work", note: "after" };
  assertManagedRestartFollowup(value, value.receipts.prg, "after"); value.receipts.followup.originalReceiptId = "other"; assert.throws(() => assertManagedRestartFollowup(value, value.receipts.prg, "after"));
});
const ledger = () => {
  const value = stats(); value.urls = { original: Object.fromEntries(["prg", "cache", "no-store"].map(kind => [kind, `http://127.0.0.1:1/original/${kind}`])), followup: { work: "http://127.0.0.1:1/followup/work" } };
  value.originalPOST.forEach((row, index) => Object.assign(row, { sequence: index + 1, at: 123 + index, path: `/original/${row.kind}` }));
  value.requests = value.originalPOST.map(({ sequence, at, path, status }) => ({ sequence, at, path, status, method: "POST", search: "" })); return value;
};
test("POST ledger accounts for unknown routes, rejected queries and external routes", () => {
  const rejected = { overflow: false, requests: [] }; assertManagedRestartPostLedger(ledger(), rejected, [], 0);
  const unknown = ledger(); unknown.requests.push({ method: "POST", path: "/unknown", sequence: 4, status: 405 }); assert.throws(() => assertManagedRestartPostLedger(unknown, rejected, [], 0));
  assert.throws(() => assertManagedRestartPostLedger(ledger(), { ...rejected, requests: [{ method: "POST", search: "?wrong" }] }, [], 0));
  assert.throws(() => assertManagedRestartPostLedger(ledger(), rejected, [{ method: "POST", url: "/outside" }], 0));
  assert.throws(() => assertManagedRestartPostLedger(ledger(), { ...rejected, overflow: true }, [], 0));
});
test("POST request and classified body records form a bijection", () => {
  for (const mutate of [value => value.requests[0].status = 422, value => value.requests[0].search = "?bad", value => value.requests[0].sequence = 2, value => value.originalPOST[0].path = "/unknown", value => value.requests.pop()]) {
    const value = ledger(); mutate(value); assert.throws(() => assertManagedRestartPostLedger(value, { overflow: false, requests: [] }, [], 0));
  }
  const value = ledger(), post = { kind: "followup", source: "work", sequence: 5, at: 200, path: "/followup/work", status: 303 }; value.followupPOST.push(post); value.requests.push({ ...post, method: "POST", search: "" });
  assertManagedRestartPostLedger(value, { overflow: false, requests: [] }, [], 1);
  value.followupPOST[0].status = value.requests.at(-1).status = 409; assert.throws(() => assertManagedRestartPostLedger(value, { overflow: false, requests: [] }, [], 1));
});
test("native target identity binds tabId rather than a matching URL", () => {
  const original = { tabId: 4, id: "old" }, fresh = { overflow: false, tabs: [{ id: 9 }], targets: [{ tabId: 9, id: "fresh", url: "chrome-error://chromewebdata/" }, { tabId: 10, id: "unrelated", url: "http://same/" }] };
  assert.equal(assertManagedRestartNativeTarget(fresh, 9, original).id, "fresh");
  for (const changed of [{ ...fresh, tabs: [] }, { ...fresh, targets: [{ tabId: 10, id: "same-url", url: "http://same/" }] }, { ...fresh, targets: [fresh.targets[0], fresh.targets[0]] }, { ...fresh, targets: [{ tabId: 9, id: "old" }] }]) assert.throws(() => assertManagedRestartNativeTarget(changed, 9, original));
});
test("final results must remain present with two exact new delivery records", () => {
  const expected = [1, 2].map(id => ({ id, kind: "result", watchable: true, deliveryId: `new-${id}` })), old = [{ deliveryId: "old" }], observation = { tabs: expected.map(row => ({ id: row.id, active: false })) }, viewer = { tabs: [{ id: 3, kind: "browser" }, ...expected] };
  assertManagedRestartFinalResults(observation, viewer, expected, old);
  assert.throws(() => assertManagedRestartFinalResults({ tabs: [] }, viewer, expected, old));
  assert.throws(() => assertManagedRestartFinalResults({ tabs: [{ id: 1, active: true }, { id: 2, active: false }] }, viewer, expected, old));
  for (const tabs of [viewer.tabs.slice(0, 2), [...viewer.tabs, { id: 4, kind: "result", deliveryId: "extra" }], viewer.tabs.map(row => row.id === 1 ? { ...row, deliveryId: "old" } : row)]) assert.throws(() => assertManagedRestartFinalResults(observation, { tabs }, expected, old));
  const inherited = expected.map(row => row.id === 1 ? { ...row, deliveryId: "old" } : row); assert.throws(() => assertManagedRestartFinalResults(observation, { tabs: inherited }, inherited, old));
});
test("the final stopped observer also rejects delayed default restoration", () => {
  const oldURL = "http://old/", stopped = { stopped: true, overflow: false, tabs: [{ id: 1, url: "about:blank" }], targets: [{ id: "new", url: "about:blank" }] };
  assertManagedRestartDefaultEmpty(stopped, [oldURL]);
  for (const changed of [{ ...stopped, tabs: [{ pendingUrl: oldURL }] }, { ...stopped, targets: [{ url: oldURL }] }, { ...stopped, overflow: true }]) assert.throws(() => assertManagedRestartDefaultEmpty(changed, [oldURL]));
});

test("only the separate authenticated crash case observes rather than requires the new draft cookie", () => {
  const restored = { persistent: "saved", memory: "未暂存", cookie: "未保存" };
  const observed = assertManagedRestartRestoredDraft(restored, "saved", "crash-authenticated");
  assert.equal(observed.newDraftCookiePreserved, false); assert.equal(observed.newDraftCookieRequired, false);
  for (const mode of ["normal", "crash", "crash-established"]) {
    assert.throws(() => assertManagedRestartRestoredDraft(restored, "saved", mode));
    assert.equal(assertManagedRestartRestoredDraft({ ...restored, cookie: "saved" }, "saved", mode).newDraftCookieRequired, true);
  }
  for (const mode of ["normal", "crash", "crash-established", "crash-authenticated"]) {
    assert.throws(() => assertManagedRestartRestoredDraft({ ...restored, persistent: "lost" }, "saved", mode));
    assert.throws(() => assertManagedRestartRestoredDraft({ ...restored, memory: "old memory" }, "saved", mode));
  }
  assert.throws(() => assertManagedRestartRestoredDraft(restored, "saved", "default"));
});

// Real local HTTP fixture + assertion contract only. These tests do not launch
// a browser or claim native persistence; the formal runner owns those proofs.
async function withAuthenticatedFixture(operation) {
  const fixture = createManagedBrowserRestartFixture({ authenticated: true });
  const server = http.createServer((request, response) => {
    if (!fixture.handle(request, response, server.address().port)) { response.writeHead(404); response.end("outside"); }
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  const id = "support-auth", urls = managedBrowserRestartURLs(server.address().port, id, { authenticated: true });
  const request = async (url, options = {}) => { const response = await fetch(url, { redirect: "manual", signal: AbortSignal.timeout(5000), ...options }); return { url, status: response.status, headers: response.headers, body: await response.text() }; };
  const post = (url, fields, cookie) => request(url, { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded", ...(cookie ? { Cookie: cookie } : {}) }, body: new URLSearchParams(fields).toString() });
  const document = response => {
    const encoded = response.body.match(/<pre id="server-auth-json">([\s\S]*?)<\/pre>/)?.[1]; assert.ok(encoded);
    return { url: response.url, cookieNames: [], serverAuthText: encoded.replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&") };
  };
  try {
    const startedAt = Date.now(), login = await request(urls.auth.login), before = fixture.stats(id);
    const credential = login.body.match(/<code id="synthetic-login-token">([^<]+)<\/code>/)?.[1]; assert.ok(credential);
    const loginReply = await post(urls.auth.login, { scenarioId: id, operationId: before.auth.loginOperationId, credential }); assert.equal(loginReply.status, 303);
    const header = loginReply.headers.get("set-cookie"), cookie = header.split(";", 1)[0];
    const check = document(await request(urls.auth.check, { headers: { Cookie: cookie } }));
    const seed = fixture.stats(id), originalAuth = structuredClone(seed.auth);
    assert.equal(originalAuth.loginPOST[0].setCookie.headerSHA256, createHash("sha256").update(header).digest("hex"));
    assert.match(header, /; Max-Age=86400; HttpOnly; SameSite=Strict$/);
    assertManagedRestartAuthenticationSeed(seed, fixture.rejectedStats(), []);
    assertManagedRestartAuthentication(check, seed, originalAuth, startedAt);
    return await operation({ fixture, id, urls, request, post, document, cookie, credential, seed, originalAuth, startedAt, check });
  } finally { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
}

test("actual fixture login, fresh authenticated GETs and 3+1 business POSTs satisfy one-login ledger", () => withAuthenticatedFixture(async ({ fixture, id, urls, request, post, document, cookie, originalAuth }) => {
  const startedAt = Date.now(), work = document(await request(urls.work, { headers: { Cookie: cookie } }));
  assertManagedRestartAuthentication(work, fixture.stats(id), originalAuth, startedAt);
  for (const kind of ["prg", "cache", "no-store"]) {
    const stats = fixture.stats(id), reply = await post(urls.original[kind], { scenarioId: id, operationId: stats.operations[kind], note: `report-${kind}` }, cookie);
    assert.equal(reply.status, kind === "prg" ? 303 : 200);
  }
  assert.equal(assertManagedRestartAuthenticatedPostLedger(fixture.stats(id), fixture.rejectedStats(), [], 0, originalAuth).allPOSTs, 4);
  const secondStartedAt = Date.now(), secondWork = document(await request(urls.work, { headers: { Cookie: cookie } })), report = document(await request(urls.report, { headers: { Cookie: cookie } }));
  for (const page of [secondWork, report]) assertManagedRestartAuthentication(page, fixture.stats(id), originalAuth, secondStartedAt);
  const stats = fixture.stats(id); assert.equal((await post(urls.followup.work, { scenarioId: id, operationId: stats.operations.followup, receiptId: stats.receipts.prg.receiptId, note: "independent" }, cookie)).status, 303);
  const followup = document(await request(urls.followupReport, { headers: { Cookie: cookie } }));
  assertManagedRestartAuthentication(followup, fixture.stats(id), originalAuth, secondStartedAt);
  const ledger = assertManagedRestartAuthenticatedPostLedger(fixture.stats(id), fixture.rejectedStats(), [], 1, originalAuth);
  assert.equal(ledger.loginPOSTs, 1); assert.equal(ledger.originalPOSTs, 3); assert.equal(ledger.followupPOSTs, 1); assert.equal(ledger.allPOSTs, 5);
  assert.throws(() => assertManagedRestartPostLedger(fixture.stats(id), fixture.rejectedStats(), [], 1), "Old modes must not silently ignore a login POST");
  const unauthorized = structuredClone(fixture.stats(id)); unauthorized.requests.find(row => row.method === "POST" && row.authentication).authentication.accepted = false;
  assert.throws(() => assertManagedRestartAuthenticatedPostLedger(unauthorized, fixture.rejectedStats(), [], 1, originalAuth));
  const unknown = structuredClone(fixture.stats(id)); unknown.requests.push({ method: "POST", sequence: 999, path: "/unknown", at: Date.now(), status: 405 });
  assert.throws(() => assertManagedRestartAuthenticatedPostLedger(unknown, fixture.rejectedStats(), [], 1, originalAuth));
  assert.throws(() => assertManagedRestartAuthenticatedPostLedger(fixture.stats(id), fixture.rejectedStats(), [], 1));
}));

test("actual authentication proof rejects old-generation HTML, changed login, missing HTTP evidence and non-HttpOnly exposure", () => withAuthenticatedFixture(async ({ fixture, id, seed, originalAuth, startedAt, check }) => {
  const proof = JSON.parse(check.serverAuthText), request = seed.requests.find(row => row.sequence === proof.requestSequence);
  assert.throws(() => assertManagedRestartAuthentication(check, seed, originalAuth, request.at + 1));
  for (const mutate of [value => value.auth.receipt.loginId = "replacement", value => value.auth.receipt.principal = "other", value => value.auth.receipt.cookie.httpOnly = false,
    value => value.auth.loginPOST.push({ ...value.auth.loginPOST[0], status: 409 }), value => delete value.auth.loginPOST[0].responseFinishedAt,
    value => value.auth.loginPOST[0].setCookie.httpOnly = false, value => value.auth.loginPOST[0].setCookie.headerSHA256 = "unbound",
    value => value.requests.splice(value.requests.findIndex(row => row.sequence === proof.requestSequence), 1), value => value.auth.refusals.push({ reason: "missing-cookie" })]) {
    const changed = structuredClone(seed); mutate(changed); assert.throws(() => assertManagedRestartAuthentication(check, changed, originalAuth, startedAt));
  }
  for (const mutate of [value => value.loginId = "other", value => value.cookieSHA256 = "0".repeat(64), value => value.requestSequence = 999, value => value.requestMethod = "POST", value => value.requestPath = "/wrong", value => value.authenticated = false]) {
    const changed = structuredClone(proof); mutate(changed); assert.throws(() => assertManagedRestartAuthentication({ ...check, serverAuthText: JSON.stringify(changed) }, seed, originalAuth, startedAt));
  }
  assert.throws(() => assertManagedRestartAuthentication({ ...check, serverAuthText: null }, seed, originalAuth, startedAt));
  assert.throws(() => assertManagedRestartAuthentication({ ...check, cookieNames: [seed.auth.cookieName] }, seed, originalAuth, startedAt));
  assert.throws(() => assertManagedRestartAuthentication({ ...check, url: check.url + "?stale" }, seed, originalAuth, startedAt));
  const business = structuredClone(seed); business.originalPOST.push({ status: 200 }); assert.throws(() => assertManagedRestartAuthenticationSeed(business, fixture.rejectedStats(), []));
  assert.throws(() => assertManagedRestartAuthenticationSeed(seed, fixture.rejectedStats(), [{ method: "POST", url: "/outside" }]));
}));

test("real duplicate login and missing-cookie requests remain failures instead of recovery", () => withAuthenticatedFixture(async ({ fixture, id, urls, request, post, cookie, credential, originalAuth, startedAt, check }) => {
  assert.equal((await request(urls.work)).status, 401);
  assert.throws(() => assertManagedRestartAuthentication(check, fixture.stats(id), originalAuth, startedAt));
  assert.equal((await post(urls.auth.login, { scenarioId: id, operationId: originalAuth.loginOperationId, credential }, cookie)).status, 409);
  assert.throws(() => assertManagedRestartAuthenticationSeed(fixture.stats(id), fixture.rejectedStats(), []));
}));
const crash = () => {
  const ack = { at: "2026-10-23T00:00:00Z" }, info = { runId: "original", extensionId: "extension" }, nativeExit = { ...ack, code: 0 };
  return { version: 1, state: "closed", info, readyAt: ack.at, endedAt: ack.at, forced: false, error: "managed process exited with code 9", browserClose: { ...ack, result: {} }, browserExit: { ...ack, code: 9, error: "managed process exited with code 9" }, nativeExit,
    nativeConnections: [{ epoch: 1, exitConfirmed: true, exit: nativeExit, controllerCleanup: { ...ack, result: { cleanupConfirmed: true, cleanupProof: "session-terminated", status: { connected: false, selectedTabId: null } } } }], jobEmpty: { ...ack, result: { activeProcesses: 0 } }, registrationCleanup: ack, endpointCleanup: ack };
};
test("crash cleanup requires exact original fault lines and successful cleanup receipts", () => {
  const life = crash(); assertManagedRestartCrashTerminal(life, life.info);
  for (const mutate of [value => value.browserExit.code = 0, value => value.forced = true, value => delete value.error, value => value.error += "\nprofile lock cleanup failed", value => value.endpointCleanup.error = "unknown", value => value.nativeConnections[0].controllerCleanup.error = "staging failed", value => delete value.nativeConnections[0].controllerCleanup, value => value.jobEmpty.result.activeProcesses = 1, value => value.nativeConnections[0].exitConfirmed = false]) {
    const value = structuredClone(life); mutate(value); assert.throws(() => assertManagedRestartCrashTerminal(value, value.info));
  }
});
test("a Browser.close deadline or protocol failure is not a crash disconnection", () => {
  for (const message of ["context deadline exceeded", "managed Browser response identity mismatch", "managed Browser response has no result", "EOF\nunknown cleanup failure"]) {
    const value = crash(); value.browserClose.error = message; value.error = `managed Browser.close was not acknowledged: ${message}\n${value.error}`; assert.throws(() => assertManagedRestartCrashTerminal(value, value.info));
  }
  const value = crash(); value.browserClose.error = "failed to get reader: failed to read frame header: EOF"; value.error = `managed Browser.close was not acknowledged: ${value.browserClose.error}\n${value.error}`; assertManagedRestartCrashTerminal(value, value.info);
  value.error = value.error.split("\n").at(-1); assert.throws(() => assertManagedRestartCrashTerminal(value, value.info));
});
const windowsCrashReset = () => {
  const life = crash(), browserRoot = "ws://127.0.0.1:7671/devtools/browser/original";
  life.readyAt = "2026-10-23T02:34:57.2399083Z"; life.browserExit.at = "2026-10-23T02:35:03.461326Z"; life.browserClose.at = "2026-10-23T02:35:03.4627894Z";
  life.browserClose.error = "failed to write msg: failed to write frame: failed to flush: write tcp 127.0.0.1:7672->127.0.0.1:7671: wsasend: An existing connection was forcibly closed by the remote host.";
  life.error = `managed Browser.close was not acknowledged: ${life.browserClose.error}\n${life.browserExit.error}`;
  return { life, evidence: { browserRoot, crash: { command: "Browser.crash", submissions: 1, originalBrowserRoot: browserRoot, submittedAt: 1792722901989 } } };
};
test("observed Windows reset binds the single original crash, endpoint and exit ordering", () => {
  const { life, evidence } = windowsCrashReset(); const result = assertManagedRestartCrashTerminal(life, life.info, evidence);
  assert.equal(result.browserCloseFault.kind, "original-browser-crash-windows-remote-reset"); assert.equal(result.browserCloseFault.remotePort, 7671);
  assert.throws(() => assertManagedRestartCrashTerminal(life, life.info));
  for (const mutate of [value => delete value.evidence.crash, value => value.evidence.crash.submissions = 2, value => value.evidence.crash.command = "Browser.close", value => value.evidence.crash.originalBrowserRoot += "-other", value => value.evidence.browserRoot = value.evidence.browserRoot.replace(":7671", ":7673"), value => value.evidence.crash.submittedAt = Date.parse(value.life.browserExit.at) + 1, value => value.life.browserClose.at = "2026-10-23T02:35:03.460Z", value => value.life.readyAt = "2026-10-23T03:00:00Z", value => value.life.nativeConnections[0].controllerCleanup.error = "cleanup failed", value => value.life.error += "\nunknown cleanup failure"]) {
    const value = windowsCrashReset(); mutate(value); assert.throws(() => assertManagedRestartCrashTerminal(value.life, value.life.info, value.evidence));
  }
});
test("Windows reset classification rejects changed endpoints, text and trailing newline", () => {
  for (const change of [text => text + "\n", text => text + " unknown", text => text.replace("127.0.0.1:7672", "192.0.2.1:7672"), text => text.replace("->127.0.0.1", "->127.0.0.2"), text => text.replace(":7672", ":65536"), text => text.replace(":7672", ":0"), text => text.replace(":7671", ":7673"), text => text.replace("wsasend:", "wsarecv:"), text => text.replace("An existing connection was forcibly closed by the remote host.", "context deadline exceeded")]) {
    const { life, evidence } = windowsCrashReset(); life.browserClose.error = change(life.browserClose.error); life.error = `managed Browser.close was not acknowledged: ${life.browserClose.error}\n${life.browserExit.error}`;
    assert.throws(() => assertManagedRestartCrashTerminal(life, life.info, evidence));
  }
});
test("native nonzero Stop faults bind the original epoch and exit code", () => {
  const value = crash(); Object.assign(value.nativeConnections[0].exit, { code: 8, error: "managed process exited with code 8" }); value.error += "\nnative connection 1 exited during Stop with code 8"; assertManagedRestartCrashTerminal(value, value.info);
  value.error = value.error.replace("connection 1", "connection 2"); assert.throws(() => assertManagedRestartCrashTerminal(value, value.info));
});
test("worker execution retirement is not a worker cleanup acknowledgement", () => {
  const value = crash(), native = value.nativeConnections[0]; native.worker = { targetId: "worker", contextUniqueId: "context", workerBootId: "boot", contextId: 1 };
  native.executionEnd = { ...native.worker, at: value.endedAt, method: "Runtime.executionContextDestroyed", sessionId: "original-session" };
  native.controllerCleanup.result = { transportRetired: true, cleanupConfirmed: false, cleanupProof: "worker-execution-ended", status: { connected: false, selectedTabId: null } };
  assert.deepEqual(assertManagedRestartCrashTerminal(value, value.info).cleanupProofs, ["transport-retired-and-original-job-empty"]);
  native.executionEnd.workerBootId = "other"; assert.throws(() => assertManagedRestartCrashTerminal(value, value.info));
  native.controllerCleanup.result.cleanupProof = "file-staging-unconfirmed"; assert.throws(() => assertManagedRestartCrashTerminal(value, value.info));
});
test("normal controller ACK must contain actual original channel cleanup", () => {
  const value = crash(), native = value.nativeConnections[0]; native.binding = { extensionInstanceId: "instance", workerBootId: "boot", portId: "port" };
  native.controllerCleanup.result = { disconnected: true, status: { ...native.binding, runId: value.info.runId, extensionId: value.info.extensionId, connected: false, selectedTabId: null, tabs: [], cleanupPending: 0, automation: { cleanupComplete: true }, human: null, view: null, pendingDialog: null, pendingFileChooser: null, stream: { state: "idle", streamId: null } } };
  assertManagedRestartCrashTerminal(value, value.info);
  native.controllerCleanup.result.status.cleanupPending = 1; assert.throws(() => assertManagedRestartCrashTerminal(value, value.info));
});

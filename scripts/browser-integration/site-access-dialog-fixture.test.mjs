import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import vm from "node:vm";
import { createRestrictedDialogFixtures, checkRestrictedDialogPolicy, checkRestrictedDialogBoundaries, checkRestrictedDialogBoundaryEvidence } from "./site-access-dialog-fixture.mjs";
import { listenFixture } from "./fixture-listener.mjs";

function evidence() {
  const detail = { previousEpoch: 3, newEpoch: 4, nativeEvidence: { events: [], commands: [], overflow: false } };
  for (const [index, name] of ["mixed", "dynamic", "policyRetired"].entries()) {
    const key = name, href = `http://127.0.0.1:8080/restricted-dialog-boundary?key=${name}`, token = `original-${index}`;
    const original = { key, href, token, child: false };
    const before = { key, href, token, original: true, triggers: [], results: [] };
    const item = detail[name] = { key, tabId: index + 1, documentId: `document-${index}`, before, after: structuredClone(before), server: { documents: [original], posts: [] }, frames: [{ frameId: 0, documentId: `document-${index}`, url: href }] };
    if (name !== "policyRetired") {
      const child = { key, href: href.replace("127.0.0.1", "localhost") + "&document=child", token: `child-${index}`, child: true };
      item.server.documents.push(child); item.frames.push({ frameId: 4, parentFrameId: 0, documentId: `child-document-${index}`, url: child.href });
    }
  }
  detail.policyRetired.dialogId = "original-wait"; detail.policyRetired.error = "OBU_STALE_CONTROL_EPOCH: old";
  detail.mixed.armError = "OBU_SITE_ACCESS_DENIED: child"; detail.mixed.rootActionError = "OBU_SITE_ACCESS_UNVERIFIED: revoked";
  detail.dynamic.dialogId = "dynamic-wait"; detail.dynamic.collectError = "OBU_DIALOG_EXPIRED: revoked";
  detail.dynamic.after.triggers = [{ type: "add", trusted: true }]; return detail;
}

test("restricted boundary oracle requires original documents, one trusted add, no dialog/native/POST and explicit refusals", () => {
  assert.deepEqual(checkRestrictedDialogBoundaryEvidence(evidence()), { passed: true, trustedAdds: 1, postCount: 0, nativeDialogCount: 0 });
  for (const mutate of [
    value => { value.nativeEvidence.commands.push({ method: "Page.handleJavaScriptDialog" }); },
    value => { value.nativeEvidence.events.push({ method: "Page.javascriptDialogOpening" }); },
    value => { value.nativeEvidence.overflow = true; },
    value => { value.dynamic.after.triggers[0].trusted = false; },
    value => { value.dynamic.after.triggers.push({ type: "add", trusted: true }); },
    value => { value.dynamic.after.token = "replacement"; },
    value => { value.mixed.after.original = false; },
    value => { value.dynamic.server.posts.push({ guessed: true }); },
    value => { value.dynamic.frames[1].url = value.dynamic.frames[0].url; },
    value => { value.mixed.armError = "OBU_SITE_ACCESS_UNSUPPORTED: old blanket deny"; },
    value => { value.dynamic.collectError = "OBU_DIALOG_TIMEOUT: no revocation"; },
    value => { value.dynamic.collectError = "OBU_DIALOG_FAILED: unrelated subscription error"; },
    value => { value.policyRetired.error = "OBU_DIALOG_FAILED: unrelated native error"; },
    value => { value.newEpoch = value.previousEpoch; },
    value => { value.dynamic.dialogId = value.policyRetired.dialogId; }
  ]) { const changed = evidence(); mutate(changed); assert.throws(() => checkRestrictedDialogBoundaryEvidence(changed)); }
});

for (const fail of [false, true]) test(`borrowed popup restores canonical policy after ${fail ? "the original caller failure" : "both workflows"}`, async () => {
  const primary = Object.freeze(Error("original dialog caller failure")), calls = []; let saved;
  let policy = { ready: true, stored: true, version: 1, generation: "original-generation", revision: 4, mode: "all", origins: [] }, automation = "Running";
  const popup = { async evaluate(source) {
    if (source.includes("GET_SITE_ACCESS_POLICY")) return { ok: true, policy: structuredClone(policy) };
    if (source.startsWith("({mode:")) return { status: "Saved", revision: policy.revision, error: "", automation };
    if (source.includes("#site-access-reload")) { calls.push("review"); return; }
    if (source.includes("mode.value=")) {
      const mode = JSON.parse(source.match(/mode\.value=("(?:[^"\\]|\\.)*")/)[1]);
      const origins = JSON.parse(source.match(/origins\.value=("(?:[^"\\]|\\.)*")/)[1]);
      policy = { ...policy, revision: policy.revision + 1, mode, origins: origins ? origins.split("\n") : [] };
      automation = "Paused"; calls.push(`save:${mode}`); return;
    }
    if (source.includes("GET_AUTOMATION_CONTROL_STATUS")) return { ok: true, status: { state: automation.toLowerCase(), inputBlocked: automation === "Paused", cleanupComplete: automation === "Paused" } };
    if (source.startsWith("chrome.storage.local.get")) { const { version, revision, mode, origins } = policy; return { OPEN_BROWSER_USE_SITE_ACCESS_POLICY: { version, revision, mode, origins } }; }
    if (source.includes("#automation-toggle")) { assert.equal(automation, "Paused"); automation = "Running"; calls.push("resume"); return; }
    throw Error(`Unexpected popup operation: ${source}`);
  }, close() { assert.fail("A borrowed popup must never be closed"); } };
  const options = { popup, fixtureURL: "http://127.0.0.1:8080/", until: async predicate => { const value = await predicate(); assert.ok(value); return value; },
    runAllowed: async current => { calls.push("allowed"); assert.equal(automation, "Running"); assert.deepEqual(current.origins, ["http://127.0.0.1:8080", "http://localhost:8080"]); if (fail) throw primary; },
    runBoundaries: async controls => { calls.push("boundaries"); await controls.apply("allow", ["http://127.0.0.1:8080"]); await controls.resume(); },
    saveDetail: async value => { saved = structuredClone(value); } };
  if (fail) await assert.rejects(checkRestrictedDialogPolicy(options), error => error === primary);
  else await checkRestrictedDialogPolicy(options);
  assert.equal(policy.mode, "all"); assert.deepEqual(policy.origins, []); assert.equal(automation, "Running"); assert.equal(policy.generation, "original-generation");
  assert.equal(saved.popupOwnership, "borrowed"); assert.equal(saved.restored.policy.mode, "all");
  assert.deepEqual(saved.allowed.resume, { state: "running", inputBlocked: false, cleanupComplete: false }); assert.equal(saved.restored.durable.OPEN_BROWSER_USE_SITE_ACCESS_POLICY.mode, "all");
  assert.deepEqual(calls, ["review", "save:allow", "resume", "allowed", ...(fail ? [] : ["boundaries", "review", "save:allow", "resume"]), "review", "save:all", "resume"]);
  if (fail) assert.match(saved.error, /original dialog caller failure/);
});

test("boundary server keeps distinct original documents and any forbidden POST bytes", async () => {
  const fixtures = createRestrictedDialogFixtures();
  const server = http.createServer((request, response) => { if (!fixtures.handle(request, response, new URL(request.url, `http://127.0.0.1:${server.address().port}`))) { response.writeHead(404); response.end(); } });
  await listenFixture(server);
  try {
    const base = `http://127.0.0.1:${server.address().port}`, root = `${base}/restricted-dialog-boundary?key=original&mixed=1`;
    const html = await (await fetch(root)).text(); new vm.Script(html.match(/<script>([\s\S]*)<\/script>/)[1]);
    assert.ok(html.includes(`http://localhost:${server.address().port}/restricted-dialog-boundary`));
    assert.equal((await fetch(root + "&document=child")).status, 200);
    const bytes = Buffer.from('unexpected 中文'); assert.equal((await fetch(root, { method: "POST", body: bytes })).status, 200);
    const record = fixtures.stats("original"); assert.equal(record.documents.length, 2); assert.notEqual(record.documents[0].token, record.documents[1].token);
    assert.equal(record.documents[0].child, false); assert.equal(record.documents[1].child, true); assert.equal(record.posts[0].bodyBase64, bytes.toString("base64")); assert.equal(record.posts[0].bytes, bytes.length);
    assert.deepEqual(fixtures.allStats(), [{ key: "original", ...record }]);
  } finally { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
});

test("an original policy failure keeps every secondary failure and attempts cleanup of all exact created tabs", async () => {
  const primary = Object.freeze(Error("original policy transition failed")), cleanup = []; let id = 0, saved;
  const urls = new Map(), browser = { client: { controlEpoch: 3 }, async newTab({ url }) {
    const tabId = ++id; urls.set(tabId, url);
    return { id: tabId, getByRole: () => ({ waitFor: async () => {} }), expectDialog: async () => ({ dialogId: "original-ready" }) };
  }, close() { cleanup.push("close"); throw Error("connection cleanup failed"); } };
  const worker = { async evaluate(source) {
    if (source === "globalThis.__integrationFrameObserver.snapshot()") return { identity: "original-worker", ready: true, count: 0 };
    if (source.includes("const record={events:")) return;
    if (source.includes("const state=globalThis.__obuDialogEvidence")) { cleanup.push("native"); throw Error("native observer cleanup failed"); }
    if (source.startsWith("chrome.webNavigation.getAllFrames")) {
      const tabId = Number(source.match(/tabId:(\d+)/)[1]);
      return [{ frameId: 0, documentId: `document-${tabId}`, url: urls.get(tabId) }, ...(tabId === 1 ? [{ frameId: 1, documentId: "child", url: "http://localhost:8080/child" }] : [])];
    }
    if (source.startsWith("chrome.scripting.executeScript")) return { original: true, triggers: [], results: [] };
    if (source.startsWith("globalThis.__integrationFrames")) return ["original-child"];
    if (source.startsWith("chrome.tabs.remove")) { const tabId = Number(source.match(/remove\((\d+)\)/)[1]); cleanup.push(tabId); if (tabId === 1) throw Error("first tab cleanup failed"); return; }
    if (source.startsWith("(async()=>({tabs:")) return { tabs: [{ id: 1 }], targets: [] };
    throw Error(`Unexpected worker operation: ${source}`);
  } };
  await assert.rejects(checkRestrictedDialogBoundaries({ connectBrowser: async () => browser, getWorker: () => worker,
    fixtureURL: "http://127.0.0.1:8080/", fixtures: { allStats() { throw Error("ledger read failed"); } },
    controls: { apply() { throw primary; } }, until: async predicate => { const value = await predicate(); assert.ok(value); return value; }, saveDetail: async detail => { saved = structuredClone(detail); }
  }), error => error === primary);
  assert.deepEqual(cleanup, ["native", 1, 2, 3, "close"]); assert.deepEqual(saved.tabIds, [1, 2, 3]);
  assert.match(saved.error, /original policy transition failed/); assert.match(saved.nativeEvidenceError, /native observer cleanup failed/);
  assert.match(saved.serverLedgerError, /ledger read failed/); assert.match(saved.tabCleanupErrors[0].error, /first tab cleanup failed/); assert.equal(saved.tabCleanupErrors[0].tabId, 1);
  assert.match(saved.connectionCleanupError, /connection cleanup failed/); assert.ok(saved.cleanupError);
});

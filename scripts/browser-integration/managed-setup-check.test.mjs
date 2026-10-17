import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createServer } from "node:http";
import test from "node:test";
import { assertSetupInfo, assertSetupTerminal, assertSetupTransaction, deriveSetupExtensionIdentities, assertSetupTargetInventory } from "./managed-setup-check.mjs";
import { createManagedSetupFixture } from "./managed-setup-fixture.mjs";
import { listenFixture } from "./fixture-listener.mjs";
import { assertVisibleSetupWindow } from "./managed-setup-window-probe.mjs";

const hash = value => createHash("sha256").update(value).digest("hex");
const info = () => ({ name: "setup", mode: "setup", runId: "a".repeat(32), browserPID: 5, nativePID: 0, socketPath: "", nativeHostName: "", extensionId: "", extensionInstanceId: "", profileDir: "private-profile" });

test("setup target inventory rejects exact project IDs while preserving other extensions as unclassified", () => {
  const key = Buffer.from("synthetic public key bytes").toString("base64"), storeId = "a".repeat(32);
  const source = `const betaExtensionPublicKey = "${key}"\nconst defaultChromeExtensionID = "${storeId}"`;
  const identity = deriveSetupExtensionIdentities({}, source);
  assert.equal(identity.manifestId, null); assert.equal(identity.manifestKeyPresent, false);
  assert.equal(identity.managedId, hash(Buffer.from(key, "base64")).slice(0, 32).split("").map(value => String.fromCharCode(97 + Number.parseInt(value, 16))).join(""));
  const explicit = deriveSetupExtensionIdentities({ key: Buffer.from("different manifest key").toString("base64") }, source);
  assert.equal(explicit.projectIds.length, 3);
  const original = { targetId: "original-page", type: "page", url: "about:blank" };
  const unknown = { targetId: "unknown-worker", type: "service_worker", url: `chrome-extension://${"b".repeat(32)}/worker.js` };
  const result = assertSetupTargetInventory([original, unknown], explicit);
  assert.deepEqual(result.unclassified, [{ ...unknown, extensionId: "b".repeat(32), classification: "unclassified non-project extension target" }]);
  for (const projectId of explicit.projectIds) assert.throws(() => assertSetupTargetInventory([original, { ...unknown, url: `chrome-extension://${projectId}/background.js` }], explicit), /project extension/);
  assert.throws(() => deriveSetupExtensionIdentities({}, source.replace("betaExtensionPublicKey", "unrelatedKey")));
  assert.throws(() => deriveSetupExtensionIdentities({ key: "not!base64" }, source));
  assert.throws(() => assertSetupTargetInventory([unknown], explicit));
});
function terminal(reason = "requested") {
  const value = { version: 1, state: "closed", info: info(), readyAt: "ready", endedAt: "ended", forced: false, closeReason: reason,
    browserExit: { at: "2026-10-17T06:00:00Z", code: 0 }, jobEmpty: { at: "2026-10-17T06:00:00Z", result: { activeProcesses: 0 } },
    commandLine: ["--user-data-dir=private-profile", "--disable-extensions", "about:blank"] };
  if (reason === "requested") value.browserClose = { at: "2026-10-17T06:00:00Z", result: {} };
  return value;
}

test("setup identity rejects task endpoints and terminal proof never invents a native host", () => {
  assert.doesNotThrow(() => assertSetupInfo(info()));
  for (const change of [{ socketPath: "task-pipe" }, { nativePID: 8 }, { nativeHostName: "task-host" }, { mode: "" }, { extensionId: "task-extension" }])
    assert.throws(() => assertSetupInfo({ ...info(), ...change }));
  for (const reason of ["requested", "browser-exited"]) assert.doesNotThrow(() => assertSetupTerminal(terminal(reason), info(), reason));
  for (const mutate of [
    value => { value.nativeExit = { code: 0 }; }, value => { value.registrationCleanup = { result: {} }; },
    value => { value.browserExit.code = 1; }, value => { value.jobEmpty.result.activeProcesses = 1; },
    value => { value.forced = true; }, value => { value.browserClose.result = null; },
    value => { value.commandLine.push("--headless=new"); }, value => { value.commandLine.push("--load-extension=private"); },
    value => { value.commandLine.push("--no-sandbox"); }
  ]) { const changed = terminal(); mutate(changed); assert.throws(() => assertSetupTerminal(changed, info(), "requested")); }
  const invented = terminal("browser-exited"); invented.browserClose = { at: "2026-10-17T06:00:00Z", result: {} };
  assert.throws(() => assertSetupTerminal(invented, info(), "browser-exited"));
});

test("visible setup proof requires an original nonminimized noncloaked native window", () => {
  const observation = { processId: 7, at: "2026-10-17T06:00:00Z", windows: [{ handle: "123", processId: 7, visible: true, iconic: false, dwmResult: 0, cloaked: 0, hasRect: true, rect: { Left: 10, Top: 10, Right: 900, Bottom: 700 } }] };
  assert.deepEqual(assertVisibleSetupWindow(observation, 7).visibleHandles, ["123"]);
  for (const fields of [{ processId: 8 }, { visible: false }, { iconic: true }, { cloaked: 1 }, { dwmResult: 1 }, { hasRect: false }, { rect: { Left: 10, Top: 10, Right: 10, Bottom: 10 } }]) {
    const changed = structuredClone(observation); Object.assign(changed.windows[0], fields); assert.throws(() => assertVisibleSetupWindow(changed, 7));
  }
  assert.throws(() => assertVisibleSetupWindow({ ...observation, windows: [] }, 7));
});

async function withFixture(operation) {
  const fixture = createManagedSetupFixture(), server = createServer((request, response) => { if (!fixture.handle(request, response)) { request.resume(); response.writeHead(404); response.end(); } });
  await listenFixture(server); const origin = `http://127.0.0.1:${server.address().port}`;
  try { await operation(fixture, origin); }
  finally { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
}
async function login(fixture, origin, extra = {}) {
  const response = await fetch(origin + "/setup-login"); await response.text();
  const documentToken = fixture.stats().requests.at(-1).documentToken;
  const body = new URLSearchParams({ ...fixture.credentials(), documentToken, trusted: "true", buttonCount: "1", ...extra });
  const posted = await fetch(origin + "/setup-login", { method: "POST", body });
  return { posted, documentToken, body: body.toString() };
}

test("local login sets a persistent HttpOnly cookie and one authenticated receipt requires the original storage marker", async () => {
  await withFixture(async (fixture, origin) => {
    const { posted, documentToken, body } = await login(fixture, origin);
    assert.equal(posted.status, 200); const cookie = posted.headers.get("set-cookie"), result = await posted.json();
    assert.match(cookie, /; HttpOnly; Max-Age=3600; SameSite=Lax; Path=\/$/);
    const requestCookie = cookie.split(";")[0];
    const protectedResponse = await fetch(origin + "/setup-protected", { headers: { Cookie: requestCookie } });
    assert.equal(protectedResponse.status, 200); await protectedResponse.text();
    const childDocument = fixture.stats().requests.at(-1).documentToken;
    const commit = await fetch(origin + "/setup-receipt", { method: "POST", headers: { Cookie: requestCookie }, body: new URLSearchParams({ documentToken: childDocument, marker: result.marker, trusted: "true", buttonCount: "1" }) });
    assert.equal(commit.status, 200); const receipt = await commit.json();
    const loginState = { documentToken, clicks: [{ trusted: true, sequence: 1 }] }, protectedState = { documentToken: childDocument, clicks: [{ trusted: true, sequence: 1 }] };
    const stats = fixture.stats(); assert.equal(stats.requests[1].body.sha256, hash(body));
    assertSetupTransaction(stats, loginState, receipt, protectedState);
    for (const mutate of [value => value.requests.push(structuredClone(value.requests[1])), value => { value.requests[1].trusted = false; }, value => { value.requests.at(-1).cookieAuthenticated = false; }, value => { value.requests.at(-1).storageMatches = false; }]) {
      const changed = structuredClone(stats); mutate(changed); assert.throws(() => assertSetupTransaction(changed, loginState, receipt, protectedState));
    }
    const serialized = JSON.stringify(stats);
    for (const secret of [fixture.credentials().password, requestCookie.split("=")[1], result.marker]) {
      assert.equal(serialized.includes(secret), false, "Fixture stats retained a secret"); assert.equal(fixture.redact(`failed ${secret}`).includes(secret), false);
    }
    assert.equal(stats.requests.some(row => row.body?.base64 || row.response?.base64), false);
    assert.equal((await fetch(origin + "/setup-protected")).status, 401, "Another cookie jar must not inherit login");
  });
});

test("synthetic login refuses repeated original consumption and duplicate form fields", async () => {
  await withFixture(async (fixture, origin) => {
    const original = await login(fixture, origin); assert.equal(original.posted.status, 200); await original.posted.text();
    const repeated = await fetch(origin + "/setup-login", { method: "POST", body: original.body }); assert.equal(repeated.status, 409); await repeated.text();
    const malformed = await fetch(origin + "/setup-login", { method: "POST", body: original.body + "&trusted=true" }); assert.equal(malformed.status, 400); await malformed.text();
    assert.equal(fixture.stats().requests.filter(row => row.cookieIssued).length, 1);
  });
});

test("synthetic login rejects untrusted input and receipt cannot be forged with only the cookie", async () => {
  await withFixture(async (fixture, origin) => {
    const untrusted = await login(fixture, origin, { trusted: "false" }); assert.equal(untrusted.posted.status, 400); await untrusted.posted.text();
    assert.equal(fixture.stats().loggedIn, false);
    const original = await login(fixture, origin); assert.equal(original.posted.status, 200); const cookie = original.posted.headers.get("set-cookie").split(";")[0]; await original.posted.text();
    await (await fetch(origin + "/setup-protected", { headers: { Cookie: cookie } })).text();
    const token = fixture.stats().requests.at(-1).documentToken;
    const invalid = await fetch(origin + "/setup-receipt", { method: "POST", headers: { Cookie: cookie }, body: new URLSearchParams({ documentToken: token, marker: "not-the-original-persistent-state", trusted: "true", buttonCount: "1" }) });
    assert.equal(invalid.status, 403); await invalid.text(); assert.equal(fixture.stats().committed, false);
  });
});

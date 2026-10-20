import assert from "node:assert/strict";
import test from "node:test";
import { createServer } from "node:http";
import { createContext, Script } from "node:vm";
import { createManagedBeforeunloadFixture, beforeunloadDraft, measureManagedBeforeunloadChildElement, projectManagedBeforeunloadChildMeasurements } from "./managed-human-beforeunload-fixture.mjs";
import { listenFixture } from "./fixture-listener.mjs";

async function serve(t, options) {
  const fixture = createManagedBeforeunloadFixture(options);
  const server = createServer((request, response) => { if (!fixture.handle(request, response)) { request.resume(); response.writeHead(404); response.end(); } });
  await listenFixture(server); t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
  const base = `http://127.0.0.1:${server.address().port}`;
  const get = route => fetch(base + route);
  return { fixture, base, get };
}

test("isolated draft uses one ordinary link and native beforeunload, without self-answer or draft persistence", async t => {
  const { fixture, get } = await serve(t), response = await get(fixture.paths.page), html = await response.text();
  assert.equal(response.status, 200); assert.match(html, new RegExp(`href="${fixture.paths.destination}"`));
  assert.doesNotMatch(html, /window\.confirm|window\.alert|handleJavaScriptDialog|dispatchEvent|localStorage|sessionStorage|setTimeout|location\.(assign|replace)/);
  const listeners = {}, state = { textContent: "" }, draft = { value: "" }, link = { addEventListener(type, listener) { listeners[type] = listener; } };
  const context = createContext({ document: { querySelector: selector => ({ "#draft": draft, "#state": state, "#dialog-leave": link })[selector] },
    navigator: { userActivation: { hasBeenActive: true } }, window: { addEventListener(type, listener) { listeners[type] = listener; } } });
  new Script(html.match(/<script>([\s\S]*?)<\/script>/)[1]).runInContext(context);
  assert.equal(draft.value, beforeunloadDraft);
  let prevented = 0; const click = { isTrusted: true, button: 0, defaultPrevented: false, preventDefault() { prevented++; } };
  listeners.click(click); assert.equal(prevented, 0, "Fixture must preserve the original anchor default action");
  const unloading = { isTrusted: true, returnValue: undefined, preventDefault() { prevented++; } };
  listeners.beforeunload(unloading); assert.equal(unloading.returnValue, ""); assert.equal(prevented, 1);
  const observed = JSON.parse(state.textContent); assert.equal(observed.clicks.length, 1); assert.equal(observed.beforeunloads.length, 1);
  assert.equal(observed.clicks[0].trusted, true); assert.equal(observed.beforeunloads[0].hasBeenActive, true); assert.equal(draft.value, beforeunloadDraft);
  assert.equal(fixture.stats().requests.length, 1, "Bookkeeping model has not navigated or posted");
});

test("server rejects reload/repeated destination and binds exactly one destination receipt to original documents", async t => {
  const { fixture, base, get } = await serve(t);
  assert.equal((await get(fixture.paths.destination)).status, 409);
  assert.equal((await get(fixture.paths.page)).status, 200); assert.equal((await get(fixture.paths.page)).status, 409);
  assert.equal((await get(fixture.paths.destination)).status, 200); assert.equal((await get(fixture.paths.destination)).status, 409);
  const original = fixture.stats(); assert.ok(original.originalToken); assert.notEqual(original.originalToken, original.destinationToken);
  const body = JSON.stringify({ workflowId: original.workflowId, documentToken: original.destinationToken, originalToken: original.originalToken,
    postAttempts: 1, clicks: [{ trusted: true, button: 0 }] });
  const response = await fetch(base + fixture.paths.receipt, { method: "POST", body }); assert.equal(response.status, 200);
  assert.equal((await response.json()).submitCount, 1);
  assert.equal((await fetch(base + fixture.paths.receipt, { method: "POST", body })).status, 409);
  const accepted = fixture.stats().requests.filter(row => row.method === "POST" && row.status === 200); assert.equal(accepted.length, 1);
  assert.equal(Buffer.from(accepted[0].body.base64, "base64").toString(), body);
});

test("wrong original identity consumes its one POST without a success or retry", async t => {
  const { fixture, base, get } = await serve(t); await get(fixture.paths.page); await get(fixture.paths.destination);
  assert.equal((await fetch(base + fixture.paths.receipt, { method: "POST", body: JSON.stringify({ workflowId: "foreign" }) })).status, 400);
  assert.equal(fixture.stats().receipt, null); assert.equal(fixture.stats().attempted, true);
  assert.equal((await fetch(base + fixture.paths.receipt, { method: "POST", body: "{}" })).status, 409);
});

test("cross-site child uses an ordinary target=_top link and records its own click without parent script access", async t => {
  const { fixture, get } = await serve(t, { variant: "child-navigates-parent" });
  const html = await (await get(fixture.paths.page)).text();
  const childURL = fixture.stats().childOrigin + fixture.paths.child;
  const childResponse = await fetch(childURL), child = await childResponse.text(); assert.equal(childResponse.status, 200);
  assert.ok(html.includes(`src="${childURL}"`)); assert.ok(child.includes(`href="${fixture.stats().rootOrigin + fixture.paths.destination}" target="_top"`));
  const script = child.match(/<script>([\s\S]*?)<\/script>/)[1];
  assert.doesNotMatch(script, /parent\.|location\.|dispatchEvent|beforeunload|setTimeout|fetch\(/);
  let click; const state = { textContent: "" }, link = { addEventListener(type, handler) { assert.equal(type, "click"); click = handler; } };
  const context = createContext({ document: { querySelector: selector => ({ "#state": state, "#dialog-leave": link })[selector] }, navigator: { userActivation: { hasBeenActive: true } } });
  new Script(script).runInContext(context);
  let prevented = false; click({ isTrusted: true, button: 0, defaultPrevented: false, preventDefault() { prevented = true; } });
  assert.equal(prevented, false); const observed = JSON.parse(state.textContent);
  assert.deepEqual(observed.clicks, [{ sequence: 1, trusted: true, button: 0, defaultPrevented: false, hasBeenActive: true }]);
  assert.equal(observed.documentToken, fixture.stats().childToken); assert.equal(observed.role, "child");
  assert.equal((await get(fixture.paths.child)).status, 400, "Root host cannot serve the child identity");
  assert.equal((await fetch(childURL)).status, 409); assert.throws(() => createManagedBeforeunloadFixture({ variant: "other" }));
});

test("independent original-document geometry preserves frame identities and includes iframe border offsets", () => {
  const style = { display: "block", visibility: "visible", opacity: "1", transform: "none", zoom: "1" };
  const outer = { x: 30, y: 100, width: 308, height: 108, right: 338, bottom: 208 }, inner = { x: 20, y: 10, width: 150, height: 40, right: 170, bottom: 50 };
  function read(role, rect, viewport, documentId, frameId) {
    const node = { id: role === "root" ? "leave-child" : "dialog-leave", tagName: role === "root" ? "IFRAME" : "A", target: "_top", dataset: { dialogCase: "leave" },
      clientLeft: 4, clientTop: 4, clientWidth: 300, clientHeight: 100, offsetWidth: rect.width, offsetHeight: rect.height, getBoundingClientRect: () => rect, contains: candidate => candidate === node };
    const state = { workflowId: "workflow", documentToken: documentId };
    const context = createContext({ document: { getElementById: id => id === node.id ? node : null, elementFromPoint: () => node, querySelector: () => ({ textContent: JSON.stringify(state) }) },
      location: { href: role === "root" ? "http://127.0.0.1:55000/root" : "http://localhost:55000/child" }, getComputedStyle: () => style, innerWidth: viewport.width, innerHeight: viewport.height });
    return { documentId, frameId, ...JSON.parse(JSON.stringify(new Script(`(${measureManagedBeforeunloadChildElement.toString()})('leave')`).runInContext(context))) };
  }
  const root = read("root", outer, { width: 600, height: 400 }, "root-doc", 0), child = read("child", inner, { width: 300, height: 100 }, "child-doc", 9);
  const measured = projectManagedBeforeunloadChildMeasurements([root, child]);
  assert.deepEqual(measured.rect, { x: 54, y: 114, width: 150, height: 40 }); assert.deepEqual(measured.point, { x: 129, y: 134 });
  assert.equal(measured.child.documentId, "child-doc"); assert.equal(measured.root.frameId, 0); assert.deepEqual(measured.measurements, [root, child]);
  assert.throws(() => projectManagedBeforeunloadChildMeasurements([root, { ...child, documentId: "root-doc" }]));
  assert.throws(() => projectManagedBeforeunloadChildMeasurements([root, { ...child, viewport: { width: 301, height: 100 } }]));
  assert.throws(() => projectManagedBeforeunloadChildMeasurements([root, { ...child, clickable: false }]));
});

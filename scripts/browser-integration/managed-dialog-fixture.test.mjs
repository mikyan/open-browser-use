import assert from "node:assert/strict";
import { createServer } from "node:http";
import { createContext, Script } from "node:vm";
import test from "node:test";
import { createManagedDialogFixture, managedDialogCases, managedDialogUnicode, readManagedDialogDocument, measureManagedDialogButton } from "./managed-dialog-fixture.mjs";
import { listenFixture } from "./fixture-listener.mjs";

async function serve(t, options) {
  const fixture = createManagedDialogFixture(options);
  const server = createServer((req, res) => { if (!fixture.handle(req, res)) { req.resume(); res.writeHead(404); res.end(); } });
  await listenFixture(server);
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
  const base = `http://127.0.0.1:${server.address().port}`;
  const request = async (route, method = "GET", body) => {
    const response = await fetch(base + route, { method, body });
    return { status: response.status, text: await response.text() };
  };
  return { fixture, base, request };
}

// This tiny DOM executes the actual served script and supplies dialog stubs.
// It checks fixture bookkeeping only, never real dialogs or trusted OS input.
function pageModel(html, base, fixture, { answer, onDialog = () => {} } = {}) {
  const state = { textContent: "" }, result = { textContent: "" }, phase = { textContent: "" };
  const buttons = new Map(fixture.cases.map((item, index) => {
    const button = { id: "dialog-" + item.id, tagName: "BUTTON", dataset: { dialogCase: item.id }, disabled: false,
      box: { x: 10, y: 80 + index * 52, width: 200, height: 40 }, style: { display: "block", visibility: "visible", opacity: "1" },
      addEventListener(type, listener) { assert.equal(type, "click"); this.listener = listener; },
      getBoundingClientRect() { return this.box; }, contains(node) { return node === this; } };
    return [item.id, button];
  }));
  const document = { title: "Original managed dialog",
    getElementById: id => [...buttons.values()].find(button => button.id === id),
    querySelector: selector => ({ "#state": state, "#result": result, "#phase": phase })[selector],
    querySelectorAll: selector => { assert.equal(selector, "button[data-dialog-case]"); return [...buttons.values()]; },
    elementFromPoint: (x, y) => [...buttons.values()].find(button => x >= button.box.x && x <= button.box.x + button.box.width && y >= button.box.y && y <= button.box.y + button.box.height),
  };
  const calls = [], posts = [];
  const native = (type, message, defaultValue) => {
    const item = fixture.cases[calls.length]; calls.push({ type, message, defaultValue });
    assert.equal(type, item.type); assert.equal(message, item.message);
    onDialog({ item, state: JSON.parse(state.textContent), posts: [...posts] });
    return answer ? answer(item) : item.answer;
  };
  const context = createContext({ document, window: {
    alert: message => native("alert", message), confirm: message => native("confirm", message), prompt: (message, value) => native("prompt", message, value),
  }, location: { href: base + fixture.paths.page }, innerWidth: 640, innerHeight: 480, scrollX: 0, scrollY: 0, devicePixelRatio: 1,
  getComputedStyle: button => button.style,
  fetch: async (route, options) => { posts.push({ route, ...options }); return fetch(base + route, options); } });
  const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)]; assert.equal(scripts.length, 1);
  new Script(scripts[0][1]).runInContext(context);
  const read = () => JSON.parse(JSON.stringify(new Script(`(${readManagedDialogDocument.toString()})()`).runInContext(context)));
  const measure = id => JSON.parse(JSON.stringify(new Script(`(${measureManagedDialogButton.toString()})(${JSON.stringify(id)})`).runInContext(context)));
  return { calls, posts, read, measure, buttons, document,
    click: (id, overrides = {}) => {
      const button = buttons.get(id); assert.ok(button);
      return button.listener({ currentTarget: button, isTrusted: true, button: 0, ctrlKey: false, altKey: false, shiftKey: false, metaKey: false, ...overrides });
    } };
}

test("single prompt keeps its original document and emits one POST only after the native return", async t => {
  const { fixture, base, request } = await serve(t, { cases: [{ id: "prompt", type: "prompt", answer: managedDialogUnicode, defaultValue: "默认值", message: "Enter reference </script>" }] });
  const loaded = await request(fixture.paths.page); assert.equal(loaded.status, 200); assert.ok(!loaded.text.includes(managedDialogUnicode));
  let before;
  const model = pageModel(loaded.text, base, fixture, { onDialog: value => {
    before = value; assert.equal(value.state.phase, "dialog"); assert.equal(value.state.activeCase, "prompt");
    assert.equal(value.state.events.length, 1); assert.equal(value.state.events[0].phase, "before");
    assert.deepEqual(value.state.results, []); assert.deepEqual(value.posts, []);
    assert.equal(fixture.stats().requests.filter(hit => hit.method === "POST").length, 0);
  } });
  const initial = model.read(); await model.click("prompt"); const after = model.read();
  assert.equal(after.state.documentToken, initial.state.documentToken); assert.equal(before.state.documentToken, initial.state.documentToken);
  assert.equal(model.calls[0].defaultValue, "默认值"); assert.equal(after.state.results[0].answer, managedDialogUnicode);
  assert.equal(model.posts.length, 1); assert.equal(after.state.events[1].phase, "after");
  assert.equal(fixture.verify(after).postAttempts, 1); assert.equal(fixture.stats().requestCount, 2);
});

test("all three native dialog types and cancel values share one original final receipt", async t => {
  const { fixture, base, request } = await serve(t), loaded = await request(fixture.paths.page);
  const model = pageModel(loaded.text, base, fixture);
  for (const [index, item] of fixture.cases.entries()) {
    await model.click(item.id);
    assert.equal(model.posts.length, index + 1 === fixture.cases.length ? 1 : 0);
    assert.equal(model.buttons.get(item.id).disabled, true);
  }
  const after = model.read(), receipt = fixture.verify(after);
  assert.deepEqual(after.state.results.map(item => item.answer), [null, true, false, managedDialogUnicode, null]);
  assert.equal(after.state.events.length, 10); assert.equal(receipt.cases, 5);
  const detached = fixture.stats(); detached.receipt.ok = false; detached.requests.length = 0;
  assert.equal(fixture.stats().receipt.ok, true); assert.equal(fixture.stats().requests.length, 2);
});

test("native exception and duplicate clicks never answer, reopen or retry the original operation", async t => {
  const { fixture, base, request } = await serve(t, { cases: [managedDialogCases[3]] });
  const model = pageModel((await request(fixture.paths.page)).text, base, fixture, { answer: () => { throw Error("native outcome unknown"); } });
  const id = fixture.cases[0].id;
  await model.click(id); await model.click(id);
  assert.equal(model.calls.length, 1); assert.equal(model.posts.length, 0);
  const after = model.read(); assert.equal(after.state.phase, "failed"); assert.match(after.state.error, /native outcome unknown/);
  assert.equal(after.state.events.length, 1); assert.deepEqual(after.state.results, []);
  assert.equal(fixture.stats().postAttempted, false); assert.throws(() => fixture.verify(after));
});

test("wrong native return is preserved and one failed receipt cannot be repaired by replay", async t => {
  const { fixture, base, request } = await serve(t, { cases: [managedDialogCases[3]] });
  const model = pageModel((await request(fixture.paths.page)).text, base, fixture, { answer: () => "unexpected original value" });
  const id = fixture.cases[0].id; await model.click(id);
  const after = model.read(); assert.equal(after.state.results[0].answer, "unexpected original value");
  assert.equal(after.state.phase, "failed"); assert.equal(after.result.ok, false); assert.equal(fixture.stats().committed, false);
  await model.click(id); assert.equal(model.calls.length, 1); assert.equal(model.posts.length, 1);
  assert.equal((await request(fixture.paths.receipt, "POST", model.posts[0].body)).status, 409);
  assert.equal(fixture.stats().requests.filter(hit => hit.method === "POST").length, 2);
});

test("untrusted, modified and out-of-order clicks stop before any dialog or business request", async t => {
  for (const [caseId, event] of [["alert", { isTrusted: false }], ["alert", { ctrlKey: true }], ["confirm-accept", {}]]) {
    const { fixture, base, request } = await serve(t);
    const model = pageModel((await request(fixture.paths.page)).text, base, fixture);
    await model.click(caseId, event);
    assert.equal(model.calls.length, 0); assert.equal(model.posts.length, 0); assert.equal(model.read().state.phase, "failed");
  }
});

test("server binds the exact route, original document, canonical body and first POST attempt", async t => {
  const { fixture, request } = await serve(t, { cases: [managedDialogCases[0]] });
  assert.equal((await request("/unrelated")).status, 404);
  assert.equal((await request(fixture.paths.page + "?retry=1")).status, 400);
  assert.equal((await request(fixture.paths.page, "POST", "{}")).status, 405);
  assert.equal((await request(fixture.paths.page)).status, 200);
  assert.equal((await request(fixture.paths.page)).status, 409);
  assert.equal((await request(fixture.paths.receipt)).status, 405);
  assert.equal((await request(fixture.paths.receipt, "POST", '{"workflowId":"wrong","workflowId":"wrong"}')).status, 400);
  assert.equal((await request(fixture.paths.receipt, "POST", "{}")).status, 409);
  assert.equal(fixture.stats().postAttempted, true); assert.equal(fixture.stats().committed, false);
});

test("oversized bodies and request overflow remain bounded, visible failures", async t => {
  const { fixture, request } = await serve(t);
  await request(fixture.paths.page);
  assert.equal((await request(fixture.paths.receipt, "POST", "x".repeat(32769))).status, 413);
  const body = fixture.stats().requests[1].body;
  assert.equal(body.receivedBytes, 32769); assert.equal(body.truncated, true); assert.ok(body.bytes <= 32768);
  for (let i = 0; i < 30; i++) assert.equal((await request(fixture.paths.page)).status, 409);
  assert.equal((await request(fixture.paths.page)).status, 429);
  assert.equal(fixture.stats().requests.length, 32); assert.equal(fixture.stats().requestCount, 33); assert.equal(fixture.stats().overflow, true);
});

test("read and measurement helpers observe geometry without scrolling, focusing or dispatching", async t => {
  const { fixture, base, request } = await serve(t, { cases: [managedDialogCases[0]] });
  const model = pageModel((await request(fixture.paths.page)).text, base, fixture), before = model.read();
  const button = model.buttons.get("alert");
  button.click = button.focus = button.scrollIntoView = () => assert.fail("Read-only helper dispatched input");
  assert.deepEqual(model.measure("alert").point, { x: 110, y: 100 });
  assert.deepEqual(model.read(), before); assert.deepEqual(model.calls, []); assert.deepEqual(model.posts, []);
  button.disabled = true; assert.equal(model.measure("alert").point, null); button.disabled = false;
  button.box.x = 700; assert.equal(model.measure("alert").point, null); button.box.x = 10;
  model.document.elementFromPoint = () => ({ id: "cover" }); assert.equal(model.measure("alert").clickable, false);
  assert.throws(() => model.measure("missing"), /missing/); assert.throws(() => model.measure("../outside"), /Known fixture/);
});

test("case definitions and detached configuration cannot broaden the original fixture", () => {
  for (const options of [
    { cases: [] }, { cases: Array(9).fill(managedDialogCases[0]) }, { cases: [managedDialogCases[0], managedDialogCases[0]] },
    { cases: [{ id: "../x", type: "alert", answer: null }] }, { cases: [{ id: "x", type: "confirm", answer: "true" }] },
    { cases: [{ id: "x", type: "prompt", answer: "x".repeat(1025) }] }, { cases: [{ id: "x", type: "alert", answer: null, defaultValue: "x" }] },
    { cases: [{ id: "x", type: "prompt", answer: null, fallback: true }] },
  ]) assert.throws(() => createManagedDialogFixture(options));
  const fixture = createManagedDialogFixture({ cases: [managedDialogCases[0]] });
  fixture.cases[0].answer = "replacement"; assert.equal(fixture.stats().cases[0].answer, null);
  assert.throws(() => { fixture.paths.page = "/replacement"; }, TypeError);
});

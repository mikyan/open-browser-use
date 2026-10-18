import assert from "node:assert/strict";
import { createServer } from "node:http";
import { createContext, Script } from "node:vm";
import test from "node:test";
import { createManagedWorkflowFixture } from "./managed-workflow-fixture.mjs";
import { listenFixture } from "./fixture-listener.mjs";

async function serve(t) {
  const fixture = createManagedWorkflowFixture();
  const server = createServer((req, res) => { if (!fixture.handle(req, res)) { res.writeHead(404); res.end(); } });
  await listenFixture(server);
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
  const base = `http://127.0.0.1:${server.address().port}`;
  const get = async route => { const response = await fetch(base + route); return { status: response.status, text: await response.text(), headers: response.headers }; };
  const post = async (route, body) => { const response = await fetch(base + route, { method: "POST", body: JSON.stringify(body) }); return { status: response.status, json: await response.json() }; };
  return { fixture, base, get, post };
}

// Small DOM contract executes the actual served source script. It is not a
// browser/trusted-event claim; the real runner independently checks those.
function sourceScript(html) {
  const state = { textContent: "" }, button = { addEventListener(_event, fn) { this.click = fn; } }, opens = [];
  const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)]; assert.equal(scripts.length, 1);
  new Script(scripts[0][1]).runInContext(createContext({ document: { querySelector: selector => ({ "#state": state, "#open-task": button })[selector] }, window: { open: (...args) => { opens.push(args); return {}; } } }));
  return { click: () => button.click({ currentTarget: button, isTrusted: true, button: 0, ctrlKey: false, altKey: false, shiftKey: false, metaKey: false }), opens, state: () => JSON.parse(state.textContent) };
}

test("five unique callers preserve original one-time submission and download bytes", async t => {
  const { fixture, get, post } = await serve(t);
  for (const caller of ["js", "python", "go", "cli", "mcp"]) {
    const item = fixture.createTask({ taskId: `task-${caller}`, caller });
    const source = await get(item.sourcePath); assert.equal(source.status, 200);
    const script = sourceScript(source.text); script.click(); script.click();
    assert.deepEqual(script.opens, [[item.childPath, "_blank"]]); assert.equal(script.state().clicks.length, 2);
    const child = await get(item.childPath); assert.equal(child.status, 200);
    const task = fixture.stats().tasks.find(entry => entry.taskId === item.taskId);
    const body = { ...item.expected, documentToken: task.documentToken };
    const result = await post(item.commitPath, body); assert.equal(result.status, 200);
    const file = await get(item.downloadPath); assert.equal(file.status, 200);
    assert.equal(file.text, JSON.stringify(result.json) + "\n");
    assert.equal(file.headers.get("content-disposition"), `attachment; filename="managed-${item.taskId}.json"`);
    const current = fixture.stats().tasks.find(entry => entry.taskId === item.taskId);
    const proof = fixture.verifyTask({ ok: true, taskId: item.taskId, kind: caller, receipt: result.json,
      file: current.file, sourceTabId: 1, resultTabId: 2, finalize: { lifecycleVersion: 1 } });
    assert.equal(proof.posts, 1); assert.equal(proof.requests, 4);
  }
  assert.equal(fixture.stats().requests.length, 20);
  assert.throws(() => fixture.createTask({ taskId: "extra", caller: "js" }));
});

test("duplicate originals, wrong bodies and method/URL substitutions remain visible failures", async t => {
  const { fixture, get, post } = await serve(t), item = fixture.createTask({ taskId: "once", caller: "js" });
  assert.equal((await get(item.childPath)).status, 409);
  assert.equal((await get(item.sourcePath + "?retry=1")).status, 409);
  assert.equal((await get(item.sourcePath)).status, 200);
  assert.equal((await get(item.sourcePath)).status, 409);
  assert.equal((await get(item.childPath)).status, 200);
  assert.equal((await get(item.downloadPath)).status, 409);
  const token = fixture.stats().tasks[0].documentToken;
  assert.equal((await post(item.commitPath, { ...item.expected, documentToken: "wrong" })).status, 409);
  const body = { ...item.expected, documentToken: token };
  assert.equal((await post(item.commitPath, body)).status, 200);
  assert.equal((await post(item.commitPath, body)).status, 409);
  assert.equal((await get(item.downloadPath)).status, 200);
  assert.equal((await get(item.downloadPath)).status, 409);
  assert.throws(() => fixture.verifyTask({ taskId: item.taskId, kind: "js", ok: true }), /deep|equal/i);
});

test("fixture input/body bounds and detached stats do not grant replacement originals", async t => {
  const { fixture, get, post } = await serve(t);
  for (const taskId of ["../task", "", "A", "a".repeat(65)]) assert.throws(() => fixture.createTask({ taskId, caller: "js" }));
  const item = fixture.createTask({ taskId: "bounded", caller: "python" });
  assert.throws(() => fixture.createTask({ taskId: "second", caller: "python" }));
  await get(item.sourcePath); await get(item.childPath);
  assert.equal((await post(item.commitPath, { padding: "x".repeat(16384) })).status, 409);
  const copy = fixture.stats(); copy.tasks[0].committed = true; copy.requests.length = 0;
  assert.equal(fixture.stats().tasks[0].committed, false); assert.equal(fixture.stats().requests.length, 3);
});

import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { once } from "node:events";
import { createDialogFixtures, checkDialogReceipt, checkDialogResult, dialogAnswer } from "./dialog-fixture.mjs";

const document = { token: "original-token", href: "http://localhost/native-dialogs?key=sample" };
const value = { key: "sample", token: document.token, href: document.href, type: "prompt", answer: dialogAnswer, trusted: true, sequence: 1 };
function receipt(selected = value) {
  const bytes = Buffer.from(JSON.stringify(selected));
  return { method: "POST", bodyBase64: bytes.toString("base64"), bytes: bytes.length, value: selected };
}
const expected = { key: "sample", type: "prompt", answer: dialogAnswer, sequence: 1, document };

test("dialog receipt verifies original UTF-8 bytes and source document", () => {
  assert.deepEqual(checkDialogReceipt(receipt(), expected), value);
  for (const altered of [{ ...value, trusted: false }, { ...value, token: "replacement" }, { ...value, answer: "" }, { ...value, sequence: 2 }])
    assert.throws(() => checkDialogReceipt(receipt(altered), expected));
  assert.throws(() => checkDialogReceipt({ ...receipt(), bytes: 1 }, expected));
  assert.throws(() => checkDialogReceipt({ ...receipt(), value: { ...value, trusted: false } }, expected));
});

test("dialog result rejects default dismiss as an explicit accepted prompt", () => {
  const decision = { type: "prompt", accept: true, promptText: dialogAnswer };
  const result = { type: "prompt", message: "prompt: sample", defaultValue: "original default", accepted: true, promptText: dialogAnswer };
  assert.deepEqual(checkDialogResult(result, decision, "sample"), result);
  assert.throws(() => checkDialogResult({ ...result, accepted: false }, decision, "sample"));
  assert.throws(() => checkDialogResult({ ...result, promptText: "original default" }, decision, "sample"));
  assert.throws(() => checkDialogResult({ ...result, message: "prompt: foreign" }, decision, "sample"));
});

test("dialog HTTP fixture keeps original body bytes and rejects non-POST receipts", async () => {
  const fixture = createDialogFixtures(); let port;
  const server = createServer((request, response) => { if (!fixture.handle(request, response, port)) { response.writeHead(404); response.end(); } });
  server.listen(0, "127.0.0.1"); await once(server, "listening"); port = server.address().port;
  try {
    const base = `http://127.0.0.1:${port}`;
    assert.equal((await fetch(base + "/native-dialogs/result?key=sample")).status, 405);
    const body = JSON.stringify(value);
    assert.equal((await fetch(base + "/native-dialogs/result?key=sample", { method: "POST", body })).status, 200);
    const data = fixture.stats("sample"); assert.equal(data.posts.length, 1);
    assert.equal(Buffer.from(data.posts[0].bodyBase64, "base64").toString("utf8"), body);
    const html = await (await fetch(base + "/native-dialogs?key=sample&layout=dynamic-oopif")).text();
    assert.ok(html.includes("Add dialog frame")); assert.ok(html.includes(`http://localhost:${port}/native-dialogs/frame?`));
    assert.equal(fixture.stats("sample").documents[0].controls, false);
  } finally { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
});

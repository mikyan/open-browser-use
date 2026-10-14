import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createServer } from "node:http";
import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Script, createContext } from "node:vm";
import test from "node:test";
import { createOriginalDownloadFixtures } from "./original-download-fixture.mjs";
import { startOriginalDownloadFixtureServer } from "./original-download-server.mjs";
import { listenFixture } from "./fixture-listener.mjs";

const hash = bytes => createHash("sha256").update(bytes).digest("hex");
const postBody = (item, extra = {}) => new URLSearchParams({ owner: item.owner, token: item.token,
  documentToken: "original-document", trusted: "true", buttonCount: "1", ...extra }).toString();
const post = body => ({ method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body });

async function serve(t) {
  const fixture = createOriginalDownloadFixtures(); let base;
  const server = createServer((req, res) => {
    if (!fixture.handle(req, res, base)) { res.writeHead(404); res.end("outside fixture"); }
  });
  await listenFixture(server);
  base = `http://127.0.0.1:${server.address().port}/`;
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
  return { fixture, base };
}

// Execute the actual served script with a small DOM contract. These are
// deterministic fixture checks, not claims about browser trust or downloads.
function pageScript(html, { leaf = true, dynamic = false, clickError, frame, parent, origin = "http://127.0.0.1", documentToken = "original-document" } = {}) {
  const inputs = new Map(), children = [], calls = [], blobs = new Map(), state = { textContent: "" };
  const listeners = [];
  const form = { append: input => inputs.set(input.name, input), elements: { namedItem: name => inputs.get(name) } };
  const button = { addEventListener: (_name, listener) => { button.listener = listener; } }, add = {};
  const document = {
    querySelector: selector => ({ "#state": state, "#report": leaf && form, "#download": leaf && button, "#add-frame": dynamic && add, "#download-frame": frame })[selector] || null,
    body: { append: element => children.push(element) },
    createElement: tag => ({ tag, remove() { calls.push("remove"); }, click() { calls.push("click"); if (clickError) throw clickError; } })
  };
  const context = createContext({ document, crypto: { randomUUID: () => documentToken }, Blob, atob, parent, origin, addEventListener: (type, listener) => { assert.equal(type, "message"); listeners.push(listener); },
    URL: { createObjectURL: blob => { const url = `blob:${origin}/test-${blobs.size}`; blobs.set(url, blob); calls.push("create"); return url; },
      revokeObjectURL: url => { assert.ok(blobs.has(url)); calls.push("revoke"); } } });
  const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)]; assert.equal(scripts.length, 1);
  new Script(scripts[0][1]).runInContext(context);
  return { inputs, children, calls, blobs, state: () => JSON.parse(state.textContent), disabled: () => button.disabled, message: event => listeners.forEach(listener => listener(event)),
    click(trusted) { let prevented = false; button.listener({ isTrusted: trusted, preventDefault() { prevented = true; } }); return prevented; },
    add(trusted) { add.onclick({ isTrusted: trusted }); return add.disabled; } };
}

test("same report URL and filename deliver each concurrent owner's exact one-time POST bytes", async t => {
  const { fixture, base } = await serve(t);
  const cases = ["owner-A", "owner-B"].map(owner => fixture.createCase({ kind: "post", owner }));
  assert.equal(cases[0].reportPath, "/report"); assert.equal(cases[0].reportPath, cases[1].reportPath);
  assert.notEqual(cases[0].token, cases[1].token); assert.notEqual(cases[0].nonce, cases[1].nonce);
  assert.notEqual(cases[0].expected.sha256, cases[1].expected.sha256);
  await Promise.all(cases.map(async item => {
    const htmlResponse = await fetch(base + item.urlPath.slice(1)), html = await htmlResponse.text();
    assert.equal(html.includes(item.expected.base64), false, "POST bytes must only arrive in the original response, not the DOM");
    const page = pageScript(html); assert.equal(page.click(true), false, "POST uses native form default action");
    const body = new URLSearchParams([...page.inputs].map(([name, input]) => [name, input.value])).toString();
    assert.equal(body, postBody(item));
    const response = await fetch(base + "report", post(body)), bytes = Buffer.from(await response.arrayBuffer());
    assert.equal(response.status, 200); assert.equal(response.headers.get("content-disposition"), 'attachment; filename="report.bin"');
    assert.deepEqual(bytes, Buffer.from(item.expected.base64, "base64")); assert.equal(hash(bytes), item.expected.sha256);
    assert.match(bytes.toString("utf8"), /原始报表 UTF-8/); assert.ok(bytes.includes(0)); assert.ok(bytes.includes(255));
    const evidence = fixture.stats(item.key), hit = evidence.requests.find(hit => hit.method === "POST");
    assert.deepEqual(Buffer.from(hit.body.base64, "base64"), Buffer.from(body)); assert.equal(hit.body.sha256, hash(Buffer.from(body)));
    assert.equal(hit.fields.documentToken, page.state().documentToken); assert.equal(hit.fields.trusted, "true");
    assert.equal(hit.finished, true); assert.equal(evidence.consumed, true);
    assert.deepEqual(Buffer.from(evidence.gets[0].base64, "base64"), Buffer.from(html));
  }));
  assert.equal(fixture.allStats().requests.filter(hit => hit.method === "POST").length, 2);
});

test("duplicate POSTs and replacement GETs remain visible errors and never reproduce the original file", async t => {
  const { fixture, base } = await serve(t), item = fixture.createCase({ kind: "post", owner: "once" });
  const original = await fetch(base + "report", post(postBody(item))); await original.arrayBuffer();
  const duplicate = await fetch(base + "report", post(postBody(item, { buttonCount: "2" })));
  assert.equal(duplicate.status, 409); assert.match(await duplicate.text(), /ONE_TIME_TOKEN_ALREADY_USED/);
  const substitute = await fetch(base + "report"); assert.equal(substitute.status, 405);
  assert.match(await substitute.text(), /ORIGINAL_REPORT_REQUIRES_POST/);
  const all = fixture.allStats(), posts = fixture.stats(item.key).requests;
  assert.equal(posts.length, 2); assert.equal(all.requests.length, 3);
  assert.equal(posts[1].fields.buttonCount, "2"); assert.equal(all.requests[2].error, "ORIGINAL_REPORT_REQUIRES_POST");
  for (const hit of all.requests.slice(1)) assert.notEqual(hit.response.sha256, item.expected.sha256);
});

test("owner mismatch, duplicate fields, invalid tokens and URL-bound tokens cannot spend a valid case", async t => {
  const { fixture, base } = await serve(t), item = fixture.createCase({ kind: "post", owner: "right" });
  for (const [url, body, status] of [
    ["report", postBody(item, { owner: "other" }), 403],
    ["report", postBody(item) + "&token=" + item.token, 400],
    ["report", postBody(item, { token: "unknown" }), 403],
    ["report?token=" + item.token, postBody(item), 400]
  ]) {
    const response = await fetch(base + url, post(body)); assert.equal(response.status, status); await response.arrayBuffer();
    assert.equal(fixture.stats(item.key).consumed, false);
  }
  const valid = await fetch(base + "report", post(postBody(item))); assert.equal(valid.status, 200); await valid.arrayBuffer();
  assert.equal(fixture.allStats().requests.length, 5);
  const snapshot = fixture.stats(item.key); snapshot.requests.length = 0; snapshot.expected.base64 = "changed";
  assert.equal(fixture.stats(item.key).requests.length, 4); assert.notEqual(fixture.stats(item.key).expected.base64, "changed");
});

test("Blob page creates the original binary and synchronously revokes each clicked URL", async t => {
  const { fixture, base } = await serve(t), item = fixture.createCase({ kind: "blob", owner: 'owner </script> & " Ω' });
  const html = await (await fetch(base + item.urlPath.slice(1))).text(), page = pageScript(html);
  assert.equal(page.click(true), true); assert.deepEqual(page.calls, ["create", "click", "revoke", "remove"]);
  const state = page.state(), blob = page.blobs.get(state.blobURL), bytes = Buffer.from(await blob.arrayBuffer());
  assert.equal(state.documentToken, "original-document"); assert.equal(state.clicks.length, 1);
  assert.equal(state.clicks[0].trusted, true); assert.equal(state.clicks[0].revoked, true);
  assert.equal(state.expectedSHA, item.expected.sha256); assert.equal(hash(bytes), item.expected.sha256);
  assert.deepEqual(bytes, Buffer.from(item.expected.base64, "base64"));
  assert.equal(page.children[0].download, "report.bin"); assert.equal(page.children[0].href, state.blobURL);
  page.click(false); assert.equal(page.state().clicks[1].trusted, false); assert.equal(page.state().clicks[1].buttonCount, 2);
  assert.equal(fixture.allStats().requests.length, 1, "Blob script performs no file GET/POST or re-fetch");
  const broken = pageScript(html, { clickError: new Error("native-link-error") });
  assert.throws(() => broken.click(true), /native-link-error/); assert.deepEqual(broken.calls, ["create", "click", "revoke", "remove"]);
  const forged = await fetch(base + "report", post(postBody(item))); assert.equal(forged.status, 403); await forged.arrayBuffer();
});

test("frame variants keep source documents separate and create dynamic children only on explicit action", async t => {
  const { fixture, base } = await serve(t);
  for (const variant of ["oopif", "dynamic-oopif"]) {
    const item = fixture.createCase({ kind: "blob", owner: variant, variant });
    const html = await (await fetch(base + item.urlPath.slice(1))).text();
    const root = pageScript(html, { leaf: false, dynamic: variant === "dynamic-oopif" });
    if (variant === "oopif") assert.match(html, /<iframe[^>]+http:\/\/localhost:/);
    else {
      assert.doesNotMatch(html, /<iframe/); assert.equal(root.children.length, 0); assert.equal(root.add(true), true);
      const child = new URL(root.children[0].src); assert.equal(child.hostname, "localhost"); assert.equal(child.port, new URL(base).port);
      assert.equal(child.searchParams.get("key"), item.key); assert.equal(root.state().frameAdds[0].trusted, true);
    }
    const frameHTML = await (await fetch(base + "original-download/frame?key=" + item.key)).text();
    const child = pageScript(frameHTML); assert.equal(child.click(true), true); assert.equal(child.state().key, item.key);
    assert.equal(root.state().clicks.length, 0); assert.equal(fixture.stats(item.key).gets.length, 2);
  }
});

test("fixture rejects unsupported configuration and unrelated requests stay outside its ledger", async t => {
  const { fixture, base } = await serve(t);
  assert.throws(() => fixture.createCase({ kind: "get", owner: "owner" }), /kind/);
  assert.throws(() => fixture.createCase({ kind: "post", owner: "" }), /owner/);
  assert.throws(() => fixture.createCase({ kind: "post", owner: "owner", variant: "invented" }), /variant/);
  assert.throws(() => fixture.stats("missing"), /Unknown/);
  assert.throws(() => fixture.handle({ url: "/report" }, {}, "https://example.com/"), /Loopback/);
  const outside = await fetch(base + "elsewhere"); assert.equal(outside.status, 404); await outside.arrayBuffer();
  assert.equal(fixture.allStats().requests.length, 0);
});

test("opaque Blob iframe is explicitly sandboxed without changing ordinary source fixtures", async t => {
  const { fixture, base } = await serve(t);
  const opaque = fixture.createCase({ kind: "blob", owner: "opaque", variant: "oopif", opaque: true });
  const html = await (await fetch(base + opaque.urlPath.slice(1))).text();
  assert.match(html, /<iframe id="download-frame" sandbox="allow-scripts allow-downloads" src="http:\/\/localhost:/);
  assert.doesNotMatch(html, /allow-same-origin/); assert.equal(fixture.stats(opaque.key).opaque, true);
  const ordinary = fixture.createCase({ kind: "blob", owner: "ordinary", variant: "oopif" });
  assert.equal(Object.hasOwn(ordinary, "opaque"), false);
  assert.doesNotMatch(await (await fetch(base + ordinary.urlPath.slice(1))).text(), /sandbox=/);
  assert.throws(() => fixture.createCase({ kind: "post", owner: "wrong", variant: "oopif", opaque: true }), /Opaque/);
  assert.throws(() => fixture.createCase({ kind: "blob", owner: "wrong", variant: "root", opaque: true }), /Opaque/);
});

test("shared Blob is created by the original same-origin parent, consumed by the opaque child once, then revoked by its creator after the real message", async t => {
  const { fixture, base } = await serve(t), record = fixture.createCase({ kind: "blob", owner: "shared-opaque", variant: "oopif", opaque: true, sharedBlob: true });
  const rootHTML = await (await fetch(base + record.urlPath.slice(1))).text(), childHTML = await (await fetch(base + "original-download/frame?key=" + record.key)).text();
  assert.ok(rootHTML.includes(`sandbox="allow-scripts allow-downloads" src="${base}original-download/frame?`));
  const messages = []; let root, child;
  const parentWindow = { postMessage: data => messages.push(() => root.message({ source: childWindow, origin: "null", data })) };
  const childWindow = { postMessage: data => messages.push(() => child.message({ source: parentWindow, origin: new URL(base).origin, data })) };
  root = pageScript(rootHTML, { leaf: false, frame: { contentWindow: childWindow }, origin: new URL(base).origin, documentToken: "creator-document" });
  child = pageScript(childHTML, { parent: parentWindow, origin: "null", documentToken: "opaque-document" });
  assert.equal(child.disabled(), true); assert.deepEqual(root.calls, []);
  root.message({ source: {}, origin: "null", data: { key: record.key, type: "shared-ready", documentToken: "foreign" } }); assert.deepEqual(root.calls, []);
  messages.shift()(); messages.shift()(); assert.equal(child.disabled(), false); assert.equal(messages.length, 0);
  const shared = root.state().sharedBlob; assert.deepEqual(child.state().sharedBlob, shared); assert.equal(shared.creatorDocumentToken, "creator-document"); assert.equal(shared.childDocumentToken, "opaque-document");
  assert.equal(new URL(shared.url).origin, new URL(base).origin); assert.deepEqual(Buffer.from(await root.blobs.get(shared.url).arrayBuffer()), Buffer.from(record.expected.base64, "base64"));
  assert.equal(child.click(true), true); assert.deepEqual(child.calls, ["click", "remove"]); assert.deepEqual(root.calls, ["create"]); assert.equal(child.state().clicks[0].revoked, undefined);
  messages.shift()(); assert.deepEqual(root.calls, ["create", "revoke"]); assert.equal(child.state().clicks[0].revoked, undefined); messages.shift()();
  assert.equal(messages.length, 0); assert.equal(child.state().clicks.length, 1); assert.equal(child.state().clicks[0].trusted, true); assert.equal(child.state().clicks[0].revoked, true); assert.equal(child.state().clicks[0].revocation, "parent-message-ack");
  assert.deepEqual(child.state().sharedBlob, { ...shared, revoked: true }); assert.deepEqual(root.state().clicks, []); assert.equal(fixture.stats(record.key).requests.length, 2);
  assert.throws(() => fixture.createCase({ kind: "blob", owner: "wrong", sharedBlob: true }), /Shared/);
});

async function temporaryOutput(t) {
  const parent = await fs.realpath(os.tmpdir()), directory = await fs.mkdtemp(path.join(parent, "obu-original-download-"));
  t.after(async () => {
    const resolved = await fs.realpath(directory);
    assert.equal(path.dirname(resolved), parent); assert.ok(path.basename(resolved).startsWith("obu-original-download-"));
    await fs.rm(resolved, { recursive: true, force: true });
  });
  return path.join(directory, "new-evidence");
}

test("standalone server reaches both loopback families and persists cases without overwriting evidence", async t => {
  const output = await temporaryOutput(t), server = await startOriginalDownloadFixtureServer({ output });
  try {
    const port = Number(new URL(server.baseURL).port);
    assert.ok(port >= 49152 && port <= 65535, "Automatic fixture endpoints stay outside Fetch restricted service ports");
    assert.deepEqual(server.ready.cases.map(item => item.owner), ["iab-post", "iab-blob", "edge-post", "edge-blob"]);
    await assert.rejects(startOriginalDownloadFixtureServer({ output }), /EEXIST/);
    const response = await fetch(server.baseURL + "__original-download/cases", { method: "POST", body: JSON.stringify({ kind: "post", owner: "child-owner", variant: "oopif" }) });
    assert.equal(response.status, 201); const child = await response.json();
    const ipv6 = new URL(child.urlPath, server.baseURL); ipv6.hostname = "[::1]";
    const html = await (await fetch(ipv6)).text(); assert.match(html, /http:\/\/localhost:/);
    assert.equal(html.includes(child.expected.base64), false);
    const stats = await (await fetch(server.baseURL + "__original-download/stats")).json();
    assert.equal(stats.cases.length, 5); assert.equal(stats.requests.length, 1);
    const result = await server.close(); assert.equal(result.requests.length, 1); assert.deepEqual(await server.close(), result);
    const saved = JSON.parse(await fs.readFile(path.join(output, "stats.json"), "utf8")); assert.deepEqual(saved, result);
    const cases = (await fs.readFile(path.join(output, "cases.jsonl"), "utf8")).trim().split("\n").map(JSON.parse);
    assert.equal(cases.length, 5); assert.equal(cases.at(-1).key, child.key);
    assert.deepEqual(JSON.parse(await fs.readFile(path.join(output, "ready.json"), "utf8")), server.ready);
  } finally { await server.close(); }
});

test("standalone explicit ports retain the original bind error and never fall back", async () => {
  const occupied = createServer();
  try {
    const port = await listenFixture(occupied);
    await assert.rejects(startOriginalDownloadFixtureServer({ port }), error => error.code === "EADDRINUSE" && error.port === port);
    assert.equal(occupied.listening, true); assert.equal(occupied.address().port, port);
  } finally {
    if (occupied.listening) await new Promise((resolve, reject) => occupied.close(error => error ? reject(error) : resolve()));
  }
});

test("CLI stop drains the real server then writes final ledger and exits successfully", { timeout: 10000 }, async t => {
  const output = await temporaryOutput(t), script = fileURLToPath(new URL("./original-download-server.mjs", import.meta.url));
  const child = spawn(process.execPath, [script, "--output", output], { windowsHide: true, stdio: ["pipe", "pipe", "pipe"] });
  t.signal.addEventListener("abort", () => child.kill(), { once: true });
  let stdout = "", stderr = "", resolveReady, rejectReady;
  const ready = new Promise((resolve, reject) => { resolveReady = resolve; rejectReady = reject; });
  const closed = new Promise((resolve, reject) => { child.once("error", reject); child.once("close", (code, signal) => resolve({ code, signal })); });
  child.once("error", rejectReady);
  child.stdout.on("data", chunk => { stdout += chunk; if (stdout.includes("\n")) resolveReady(JSON.parse(stdout.slice(0, stdout.indexOf("\n")))); });
  child.stderr.on("data", chunk => { stderr += chunk; });
  child.once("exit", code => { if (!stdout.includes("\n")) rejectReady(Error(`Fixture exited before ready: ${code}: ${stderr}`)); });
  try {
    const started = await ready, item = started.cases[0];
    const response = await fetch(started.baseURL + "report", post(postBody(item)));
    assert.deepEqual(Buffer.from(await response.arrayBuffer()), Buffer.from(item.expected.base64, "base64"));
    child.stdin.write("stop\n");
    assert.deepEqual(await closed, { code: 0, signal: null }); assert.equal(stderr, "");
    const phases = stdout.trim().split("\n").map(JSON.parse); assert.deepEqual(phases.map(value => value.phase), ["ready", "stopped"]);
    const saved = JSON.parse(await fs.readFile(path.join(output, "stats.json"), "utf8"));
    assert.equal(saved.requests.length, 1); assert.equal(saved.requests[0].finished, true);
    assert.equal(saved.requests[0].response.sha256, item.expected.sha256); assert.equal(phases[1].requests, 1);
    await assert.rejects(fetch(started.baseURL + "report"), /fetch failed/);
  } finally { if (child.exitCode === null) child.kill(); await closed; }
});

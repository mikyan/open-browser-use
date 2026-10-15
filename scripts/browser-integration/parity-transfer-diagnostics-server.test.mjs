import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { get } from "node:http";
import { createInterface } from "node:readline";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { directLocatorUploadHTML } from "./direct-locator-upload-fixture.mjs";
import { diagnosticsFixture } from "./diagnostics-fixture.mjs";
import { startParityTransferDiagnosticsServer, parityTransferDiagnosticsInstructions } from "./parity-transfer-diagnostics-server.mjs";

const script = fileURLToPath(new URL("./parity-transfer-diagnostics-server.mjs", import.meta.url));
const hash = bytes => createHash("sha256").update(bytes).digest("hex");
async function start(t) {
  const parent = await fs.mkdtemp(path.join(os.tmpdir(), "obu-parity-server-unit-")), output = path.join(parent, "fresh-attempt");
  const child = spawn(process.execPath, [script, "--output", output], { stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
  const messages = []; let stderr = "", stdout = "", terminated = false, readyResolve, readyReject;
  const ready = new Promise((resolve, reject) => { readyResolve = resolve; readyReject = reject; });
  child.stderr.on("data", chunk => { stderr += chunk; }); child.stdout.on("data", chunk => { stdout += chunk; });
  const lines = createInterface({ input: child.stdout });
  lines.on("line", line => { try { const value = JSON.parse(line); messages.push(value); if (value.phase === "ready") readyResolve(value); } catch (error) { readyReject(error); } });
  child.once("error", readyReject);
  const closed = new Promise(resolve => child.once("close", (code, signal) => {
    terminated = true; const value = { pid: child.pid, code, signal, closeObserved: true, stdout, stderr };
    readyReject(Error(`Server closed before ready: ${code}/${signal}: ${stderr}`)); resolve(value);
  }));
  const timer = setTimeout(() => { readyReject(Error("Server startup deadline expired")); child.kill(); }, 8000);
  t.after(async () => { clearTimeout(timer); lines.close(); if (!terminated) child.kill(); await closed; });
  const info = await ready; clearTimeout(timer);
  return { child, ready: info, messages, output, async finish(command = "stop") {
    if (command === "stop") { child.stdin.write("st"); child.stdin.end("op\n"); } else child.stdin.end();
    const actual = await closed;
    await fs.writeFile(path.join(output, "unit-process-close.json"), JSON.stringify(actual, null, 2) + "\n", { flag: "wx" });
    assert.equal(actual.code, 0); assert.equal(actual.signal, null); assert.equal(actual.closeObserved, true); assert.equal(actual.stderr, "");
    assert.equal(messages.filter(message => message.phase === "stopped").length, 1);
    return actual;
  } };
}

test("standalone tasks preserve original pages, upload bytes and diagnostic routes; split stdin stop really closes", { timeout: 15000 }, async t => {
  const server = await start(t), { ready } = server, uploadURL = new URL(ready.tasks.U.url), port = Number(uploadURL.port);
  assert.deepEqual(Object.keys(ready.tasks), ["U", "X"]); assert.equal(ready.tasks.U.instructions, parityTransferDiagnosticsInstructions.U);
  assert.equal(ready.tasks.X.instructions, parityTransferDiagnosticsInstructions.X); assert.equal(ready.tasks.U.files.length, 3);
  assert.equal(Object.hasOwn(ready.tasks.U, "expected"), false); assert.equal(Object.hasOwn(ready.tasks.X, "expected"), false);
  await assert.rejects(fs.readFile(path.join(server.output, "server-evidence.json")), error => error.code === "ENOENT");
  assert.equal(await (await fetch(uploadURL)).text(), directLocatorUploadHTML(uploadURL, port));
  assert.equal(await (await fetch(ready.tasks.X.url)).text(), diagnosticsFixture(false, port));
  const childURL = `http://localhost:${port}/diagnostics/frame`;
  assert.equal(await (await fetch(childURL)).text(), diagnosticsFixture(true, port));
  const ipv6 = `http://[::1]:${port}/diagnostics/data?child-marker`;
  assert.deepEqual(await (await fetch(ipv6)).json(), { ok: true });
  const redirect = await fetch(`http://localhost:${port}/diagnostics/redirect?child-marker`, { redirect: "manual" });
  assert.equal(redirect.status, 302); assert.equal(redirect.headers.get("location"), "/diagnostics/data?child-marker"); await redirect.arrayBuffer();
  await assert.rejects(new Promise((resolve, reject) => { const request = get(`http://localhost:${port}/diagnostics/fail?child-marker`, resolve); request.once("error", reject); }));
  for (const route of ["/server-evidence.json", "/__stats", "/direct-locator-files/bytes.bin"])
    assert.equal((await fetch(new URL(route, uploadURL))).status, 404);
  // HTTP adapter verification only: this constructed body makes no claim about
  // browser trust, native file selection or the later public-tool comparison.
  const files = await Promise.all(ready.tasks.U.files.map(async filename => {
    const bytes = await fs.readFile(filename); return { name: path.basename(filename), size: bytes.length, relativePath: "", base64: bytes.toString("base64") };
  }));
  const body = JSON.stringify({ key: uploadURL.searchParams.get("key"), variant: "root", files, documentToken: "unit-document", inputToken: "unit-input", submissions: 1, events: [] });
  const postURL = new URL(uploadURL); postURL.pathname = "/direct-locator-upload/upload";
  const response = await fetch(postURL, { method: "POST", headers: { "Content-Type": "application/json" }, body });
  assert.equal(response.status, 200); const receipt = await response.json(); assert.equal(receipt.files.length, 3);
  await server.finish();
  const evidenceBytes = await fs.readFile(path.join(server.output, "server-evidence.json")), evidence = JSON.parse(evidenceBytes);
  const closed = JSON.parse(await fs.readFile(path.join(server.output, "closed.json"), "utf8"));
  assert.equal(closed.reason, "stdin-stop"); assert.equal(closed.serverClosed, true); assert.equal(closed.openConnections, 0);
  assert.equal(closed.evidenceSHA256, hash(evidenceBytes)); assert.equal(closed.uploadCount, 1); assert.equal(evidence.overflow, false);
  assert.equal(evidence.uploads.length, 1); assert.equal(evidence.uploads[0].posts.length, 1);
  const original = evidence.uploads[0].posts[0]; assert.equal(original.sha256, hash(Buffer.from(body))); assert.equal(Buffer.from(original.base64, "base64").toString(), body);
  assert.deepEqual(original.receipt, receipt);
  const failure = evidence.requests.filter(row => row.socketDestroyed); assert.equal(failure.length, 1); assert.equal(failure[0].closedBeforeFinish, true); assert.equal(Object.hasOwn(failure[0], "status"), false);
  assert.ok(evidence.requests.some(row => row.url === childURL && row.status === 200));
  for (const [name, sha] of Object.entries(ready.sources)) assert.equal(sha, hash(await fs.readFile(new URL(name, import.meta.url))));
});

test("stdin EOF stops without task input and preserves actual process-close evidence", { timeout: 15000 }, async t => {
  const server = await start(t); await server.finish("eof");
  const closed = JSON.parse(await fs.readFile(path.join(server.output, "closed.json"), "utf8"));
  assert.equal(closed.reason, "stdin-eof"); assert.equal(closed.requestCount, 0); assert.equal(closed.uploadCount, 0);
  const evidence = JSON.parse(await fs.readFile(path.join(server.output, "server-evidence.json"), "utf8"));
  assert.deepEqual(evidence.requests, []); assert.deepEqual(evidence.uploads, []);
  await assert.rejects(startParityTransferDiagnosticsServer({ output: server.output }), error => error.code === "EEXIST");
  assert.deepEqual(JSON.parse(await fs.readFile(path.join(server.output, "closed.json"), "utf8")), closed);
});

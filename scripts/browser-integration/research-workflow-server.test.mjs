import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { readFile, mkdir } from "node:fs/promises";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { researchWorkflowTask } from "./research-workflow-fixture.mjs";

test("paired comparison publishes four public URLs, shares only same-round material and closes its actual process", { timeout: 15000 }, async t => {
  const file = fileURLToPath(new URL("./research-workflow-server.mjs", import.meta.url));
  const child = spawn(process.execPath, [file, "--paired-comparison"], { windowsHide: true, stdio: ["pipe", "pipe", "pipe"] });
  let stdout = "", stderr = "", settled = false;
  child.stderr.setEncoding("utf8"); child.stderr.on("data", value => { stderr += value; });
  const closed = new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (code, signal) => { settled = true; resolve({ code, signal }); });
  });
  t.after(async () => { if (!settled) { child.kill(); await closed; } });
  const ready = await new Promise((resolve, reject) => {
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", value => {
      stdout += value;
      if (stdout.includes("\n")) { try { resolve(JSON.parse(stdout.split("\n")[0])); } catch (error) { reject(error); } }
    });
    child.once("error", reject); child.once("close", () => reject(Error("Research server closed before ready")));
  });
  assert.equal(ready.pid, child.pid);
  assert.deepEqual(ready.tasks.map(({ id, round, side, pairId }) => ({ id, round, side, pairId })),
    [1, 2].flatMap(round => ["obu", "codex"].map(side => ({ id: "R", round, side, pairId: `p15-research-r${round}` }))));
  assert.equal(new Set(ready.tasks.map(task => task.url)).size, 4);
  for (const task of ready.tasks) {
    assert.deepEqual(Object.keys(task).sort(), ["id", "instructions", "pairId", "round", "side", "url"]);
    assert.equal(task.instructions, researchWorkflowTask());
    const url = new URL(task.url); assert.equal(url.search, "?variant=3");
    const response = await fetch(url); assert.equal(response.status, 200);
    const body = await response.text(); assert.ok(body.includes(researchWorkflowTask()));
    assert.doesNotMatch(body, /oracle|expected|"selection"|"eligible"|"total"/);
  }
  assert.equal((await fetch(new URL("research-task/not-a-paired-task?variant=3", ready.url))).status, 404);
  assert.equal((await fetch(new URL("__research/stats", ready.url))).status, 404);
  const rejected = await fetch(new URL("outside-allowlist?attempt=1", ready.url), { method: "POST", body: "synthetic-rejected-submit" });
  assert.equal(rejected.status, 404); await rejected.text();
  child.stdin.end("stop\n");
  assert.deepEqual(await closed, { code: 0, signal: null }); assert.equal(stderr, "");
  const marker = JSON.parse(await readFile(path.join(ready.output, "closed.json"), "utf8")); assert.equal(marker.failure, null);
  const ledgerBytes = await readFile(path.join(ready.output, "request-ledger.json")), ledger = JSON.parse(ledgerBytes);
  assert.equal(marker.requestLedger.sha256, createHash("sha256").update(ledgerBytes).digest("hex"));
  assert.equal(marker.requestLedger.bytes, ledgerBytes.length);
  assert.equal(ledger.complete, true); assert.equal(ledger.received, 7); assert.equal(ledger.pending, 0); assert.equal(ledger.overflow, 0);
  assert.deepEqual(ledger.requests.map(row => row.sequence), [1, 2, 3, 4, 5, 6, 7]);
  assert.deepEqual(ledger.requests.map(row => row.status), [200, 200, 200, 200, 404, 404, 404]);
  assert.ok(ledger.requests.every(row => row.responseFinishedAt && row.requestComplete && !row.responseAbortedAt && !row.requestAbortedAt));
  assert.deepEqual(ledger.requests.filter(row => row.method === "POST").map(({ url, status }) => ({ url, status })),
    [{ url: "/outside-allowlist?attempt=1", status: 404 }]);
  assert.ok(Date.parse(ledger.requests.at(-1).responseFinishedAt) <= Date.parse(ledger.sealedAt));
  assert.ok(Date.parse(ledger.sealedAt) <= Date.parse(marker.at));
  const records = JSON.parse(await readFile(path.join(ready.output, "server-evidence.json"), "utf8")); assert.equal(records.length, 4);
  const byTask = task => records.find(row => new URL(task.url).pathname === `/research-task/${row.key}`);
  for (const round of [1, 2]) {
    const [a, b] = ready.tasks.filter(task => task.round === round).map(byTask);
    assert.equal(a.nonce, b.nonce); assert.notEqual(a.key, b.key);
    for (const id of ["a", "b", "c"]) for (const type of ["quote", "terms"]) assert.deepEqual(a.documents[id][type], b.documents[id][type]);
    assert.deepEqual(a.posts, []); assert.deepEqual(b.posts, []); assert.equal(a.receipt, null); assert.equal(b.receipt, null);
    assert.ok(a.requests.every(row => row.url.includes(a.key))); assert.ok(b.requests.every(row => row.url.includes(b.key)));
    assert.ok(!stdout.includes(a.nonce), "Public ready must not expose the material seed");
  }
  assert.notEqual(byTask(ready.tasks[0]).nonce, byTask(ready.tasks[2]).nonce);
  assert.equal(stdout.trim().split(/\r?\n/).length, 1);
});

test("ledger write failure seals a failed marker and a nonzero actual server exit", { timeout: 15000 }, async t => {
  const file = fileURLToPath(new URL("./research-workflow-server.mjs", import.meta.url));
  const child = spawn(process.execPath, [file, "--paired-comparison"], { windowsHide: true, stdio: ["pipe", "pipe", "pipe"] });
  let stdout = "", stderr = "", settled = false;
  child.stderr.setEncoding("utf8"); child.stderr.on("data", value => { stderr += value; });
  const closed = new Promise((resolve, reject) => {
    child.once("error", reject); child.once("close", (code, signal) => { settled = true; resolve({ code, signal }); });
  });
  t.after(async () => { if (!settled) { child.kill(); await closed; } });
  const ready = await new Promise((resolve, reject) => {
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", value => { stdout += value; if (stdout.includes("\n")) resolve(JSON.parse(stdout.split("\n")[0])); });
    child.once("error", reject); child.once("close", () => reject(Error("Research server closed before ready")));
  });
  // An existing destination must never be replaced with a claimed complete ledger.
  await mkdir(path.join(ready.output, "request-ledger.json"));
  const response = await fetch(new URL("outside-allowlist", ready.url), { method: "POST", body: "synthetic" });
  assert.equal(response.status, 404); await response.text(); child.stdin.end("stop\n");
  assert.deepEqual(await closed, { code: 1, signal: null }); assert.match(stderr, /EEXIST/);
  const marker = JSON.parse(await readFile(path.join(ready.output, "closed.json"), "utf8"));
  assert.match(marker.failure, /EEXIST/); assert.equal(marker.requestLedger, null);
});

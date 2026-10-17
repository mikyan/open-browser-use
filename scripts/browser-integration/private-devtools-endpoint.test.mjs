import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import { waitPrivateDevToolsEndpoint } from "./private-devtools-endpoint.mjs";

const ready = "49231\n/devtools/browser/original-id\n";
const busy = () => Object.assign(new Error("original file sharing violation"), { code: "EBUSY" });
function harness(read) {
  let clock = 0;
  const reads = [], waits = [];
  return { reads, waits, options: {
    timeoutMs: 20000, intervalMs: 50, assertAlive() {}, now: () => clock,
    async wait(ms) { waits.push(ms); clock += ms; },
    async readFile(file, encoding) { reads.push({ file, encoding, at: clock }); return read(reads.length); }
  } };
}

test("original endpoint tolerates busy then partial publication without changing its path or startup budget", async () => {
  const h = harness(count => { if (count === 1) throw busy(); return count === 2 ? "49231\n" : ready; });
  const endpoint = await waitPrivateDevToolsEndpoint("original-profile", h.options);
  assert.equal(endpoint.url, "ws://127.0.0.1:49231/devtools/browser/original-id");
  assert.deepEqual(h.waits, [50, 50]);
  assert.deepEqual(h.reads.map(row => row.file), Array(3).fill(path.join("original-profile", "DevToolsActivePort")));
  assert.deepEqual(h.reads.map(row => row.at), [0, 50, 100]);
});

test("busy publication expires at the original deadline and retains its first error", async () => {
  const original = busy(), h = harness(() => { throw original; });
  await assert.rejects(waitPrivateDevToolsEndpoint("original-profile", h.options), error => {
    assert.match(error.message, /timed out/); assert.equal(error.cause, original); return true;
  });
  assert.equal(h.waits.reduce((total, value) => total + value, 0), 20000);
  assert.equal(h.reads.length, 400);
  assert.equal(h.reads.at(-1).at, 19950);
});

test("an exited original process fails before reading or waiting and cannot accept its stale ready file", async () => {
  const original = new Error("original browser exited 3"), h = harness(() => ready);
  h.options.assertAlive = () => { throw original; };
  await assert.rejects(waitPrivateDevToolsEndpoint("original-profile", h.options), error => error === original);
  assert.deepEqual(h.reads, []); assert.deepEqual(h.waits, []);
});

test("death during a busy read is reported immediately without another retry", async () => {
  const original = new Error("original browser exited 3"); let exited = false;
  const h = harness(() => { exited = true; throw busy(); });
  h.options.assertAlive = () => { if (exited) throw original; };
  await assert.rejects(waitPrivateDevToolsEndpoint("original-profile", h.options), error => error === original);
  assert.equal(h.reads.length, 1); assert.deepEqual(h.waits, []);
});

test("only explicit publication errors retry; access failures and complete malformed records remain failures", async () => {
  for (const code of ["EACCES", "EPERM", "EIO"]) {
    const original = Object.assign(new Error("original filesystem failure"), { code }), h = harness(() => { throw original; });
    await assert.rejects(waitPrivateDevToolsEndpoint("original-profile", h.options), error => error === original);
    assert.deepEqual(h.waits, []);
  }
  for (const value of ["65536\n/devtools/browser/id\n", ready + "extra\n", "49231\n/devtools/page/foreign\n", "x".repeat(4097)]) {
    const h = harness(() => value);
    await assert.rejects(waitPrivateDevToolsEndpoint("original-profile", h.options));
    assert.deepEqual(h.waits, []);
  }
  for (const transient of [{ code: "ENOENT" }, { code: "ERROR_SHARING_VIOLATION" }, { win32Code: 32 }]) {
    const h = harness(count => { if (count === 1) throw transient; return ready; });
    assert.equal((await waitPrivateDevToolsEndpoint("original-profile", h.options)).port, 49231);
    assert.deepEqual(h.waits, [50]);
  }
});

test("a completed read cannot extend the original deadline", async () => {
  const h = harness(async () => { await h.options.wait(20000); return ready; });
  await assert.rejects(waitPrivateDevToolsEndpoint("original-profile", h.options), /timed out/);
  assert.equal(h.reads.length, 1);
});

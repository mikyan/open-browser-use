import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import vm from "node:vm";

// Exercise the actual helper without importing the opt-in browser launcher.
const source = await fs.readFile(new URL("./native-lifecycle.mjs", import.meta.url), "utf8");
const start = "function subprocess(command, args, options = {}) {", end = "\nasync function hashes(directory)";
assert.equal(source.split(start).length, 2);
assert.equal(source.split(end).length, 2);
const declaration = source.slice(source.indexOf(start), source.indexOf(end));

function fixture() {
  const children = new Set(), spawned = [];
  const subprocess = vm.runInNewContext(`(${declaration})`, {
    path, setTimeout, clearTimeout, subprocessChildren: children,
    spawn(...args) { const child = spawn(...args); spawned.push(child); return child; }
  });
  return { subprocess, children, spawned };
}

test("native helper preserves split Unicode and drains output before completing", async () => {
  const f = fixture();
  const script = "const b=Buffer.from('测试🙂done');process.stdout.write(b.subarray(0,4));setTimeout(()=>process.stdout.write(b.subarray(4)),15)";
  assert.equal(await f.subprocess(process.execPath, ["-e", script]), "测试🙂done");
  assert.equal(f.children.size, 0);
  assert.equal(f.spawned[0].exitCode, 0);
});

test("native helper timeout waits for its exact child to close before allowing cleanup", async () => {
  const f = fixture(); let closed = false;
  const pending = f.subprocess(process.execPath, ["-e", "setInterval(()=>{},1000)"], { timeoutMs: 100 });
  f.spawned[0].once("close", () => { closed = true; });
  await assert.rejects(pending, /timed out/);
  assert.equal(closed, true, "Timed-out registry helper could still race cleanup");
  assert.equal(f.children.size, 0);
  assert.throws(() => process.kill(f.spawned[0].pid, 0), error => error.code === "ESRCH");
});

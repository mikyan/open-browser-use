import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { parsePrivateDevToolsPort, sleep } from "./normal-browser-downloads-support.mjs";

// Chromium publishes this file directly. A Windows sharing violation or a
// partial write belongs to the original startup attempt, never a fresh launch.
export async function waitPrivateDevToolsEndpoint(profile, {
  assertAlive, timeoutMs = 20000, intervalMs = 50,
  readFile = fs.readFile, now = Date.now, wait = sleep
} = {}) {
  assert.equal(typeof assertAlive, "function", "The original process must remain observable");
  assert.ok(Number.isFinite(timeoutMs) && timeoutMs > 0);
  assert.ok(Number.isFinite(intervalMs) && intervalMs > 0);
  const file = path.join(profile, "DevToolsActivePort"), deadline = now() + timeoutMs;
  let firstPublicationError;
  const checkDeadline = () => {
    if (now() >= deadline) throw new Error("original private DevTools endpoint timed out", { cause: firstPublicationError });
  };
  while (true) {
    await assertAlive();
    checkDeadline();
    let text;
    try { text = await readFile(file, "utf8"); }
    catch (error) {
      if (!["ENOENT", "EBUSY", "ERROR_SHARING_VIOLATION"].includes(error?.code) && error?.win32Code !== 32) throw error;
      firstPublicationError ??= error;
    }
    await assertAlive();
    checkDeadline();
    if (text !== undefined) {
      assert.ok(typeof text === "string" && Buffer.byteLength(text) <= 4096, "Invalid private DevTools publication size");
      if (text.trim().split(/\r?\n/).length >= 2) return parsePrivateDevToolsPort(text);
    }
    await wait(Math.min(intervalMs, deadline - now()));
  }
}

import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { createServer } from "node:net";
import { endianness, tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { OpenBrowserUseClient, connectOpenBrowserUse, encodeFrame } from "../dist/index.js";

test("encodes native-endian length-prefixed JSON frames", () => {
  const frame = encodeFrame({ id: 1, method: "getInfo" });
  const length = endianness() === "LE" ? frame.readUInt32LE(0) : frame.readUInt32BE(0);
  assert.equal(length, frame.length - 4);
  assert.deepEqual(JSON.parse(frame.subarray(4).toString("utf8")), {
    id: 1,
    method: "getInfo"
  });
});

test("dispatches JSON-RPC notifications from the native socket", async () => {
  const directory = await mkdtemp(join(tmpdir(), "obu-sdk-js-"));
  const socketPath = process.platform === "win32" ? `\\\\.\\pipe\\obu-sdk-js-${randomUUID()}` : join(directory, "obu.sock");
  const server = createServer((socket) => {
    socket.write(
      encodeFrame({
        jsonrpc: "2.0",
        method: "onDownloadChange",
        params: { id: "1", status: "started" }
      })
    );
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(socketPath, resolve);
  });

  const client = new OpenBrowserUseClient({ socketPath });
  try {
    const notification = await new Promise((resolve) => {
      client.onNotification(resolve);
      void client.connect();
    });
    assert.deepEqual(notification, {
      method: "onDownloadChange",
      params: { id: "1", status: "started" }
    });
  } finally {
    client.close();
    server.close();
    await new Promise((resolve) => server.once("close", resolve));
    await rm(directory, { recursive: true, force: true });
  }
});

test("high-level browser tabs can goto, wait for load state, and read a DOM snapshot", async () => {
  const directory = await mkdtemp(join(tmpdir(), "obu-sdk-js-"));
  const socketPath = process.platform === "win32" ? `\\\\.\\pipe\\obu-sdk-js-${randomUUID()}` : join(directory, "obu.sock");
  const calls = [];
  const server = createServer((socket) => {
    let pending = Buffer.alloc(0);
    socket.on("data", (chunk) => {
      pending = Buffer.concat([pending, chunk]);
      while (pending.length >= 4) {
        const length = endianness() === "LE" ? pending.readUInt32LE(0) : pending.readUInt32BE(0);
        if (pending.length < 4 + length) {
          return;
        }
        const request = JSON.parse(pending.subarray(4, 4 + length).toString("utf8"));
        pending = pending.subarray(4 + length);
        calls.push([request.method, request.params.action ?? request.params.method ?? null]);
        let result = {};
        if (request.method === "createTab") {
          result = { id: 123 };
        } else if (request.method === "browserAction") {
          result = {
            value: request.params.action === "snapshot" ? '- heading "Issues"\n- link "Open"\n- link "Closed"' : null,
            engine: { name: "playwright-crx", version: "0.15.0", playwrightVersion: "1.53.0" }
          };
        }
        socket.write(encodeFrame({ jsonrpc: "2.0", id: request.id, result }));
      }
    });
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(socketPath, resolve);
  });

  const browser = await connectOpenBrowserUse({ socketPath });
  try {
    const tab = await browser.newTab();
    await tab.goto("https://example.test/issues", { waitUntil: "domcontentloaded", timeoutMs: 1000 });
    await tab.playwright.waitForLoadState({ state: "domcontentloaded", timeoutMs: 1000 });
    assert.equal(await tab.playwright.domSnapshot(), '- heading "Issues"\n- link "Open"\n- link "Closed"');
    assert.deepEqual(calls, [
      ["getInfo", null],
      ["createTab", null],
      ["browserAction", "goto"],
      ["browserAction", "waitForLoadState"],
      ["browserAction", "snapshot"]
    ]);
  } finally {
    browser.close();
    server.close();
    await new Promise((resolve) => server.once("close", resolve));
    await rm(directory, { recursive: true, force: true });
  }
});

test("sends file chooser wrapper requests", async () => {
  const directory = await mkdtemp(join(tmpdir(), "obu-sdk-js-"));
  const socketPath = process.platform === "win32" ? `\\\\.\\pipe\\obu-sdk-js-${randomUUID()}` : join(directory, "obu.sock");
  const server = createServer((socket) => {
    socket.on("data", (chunk) => {
      const length = endianness() === "LE" ? chunk.readUInt32LE(0) : chunk.readUInt32BE(0);
      const request = JSON.parse(chunk.subarray(4, 4 + length).toString("utf8"));
      if (request.method === "getInfo") { socket.write(encodeFrame({jsonrpc: "2.0", id: request.id, result: {}})); return; }
      assert.equal(request.method, "waitForFileChooser");
      assert.equal(request.params.tabId, 123);
      socket.write(
        encodeFrame({
          jsonrpc: "2.0",
          id: request.id,
          result: { fileChooserId: "chooser-1", isMultiple: false }
        })
      );
    });
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(socketPath, resolve);
  });

  const client = new OpenBrowserUseClient({ socketPath });
  try {
    assert.deepEqual(await client.waitForFileChooser(123), {
      fileChooserId: "chooser-1",
      isMultiple: false
    });
  } finally {
    client.close();
    server.close();
    await new Promise((resolve) => server.once("close", resolve));
    await rm(directory, { recursive: true, force: true });
  }
});

test("sends download and clipboard wrapper requests", async () => {
  const directory = await mkdtemp(join(tmpdir(), "obu-sdk-js-"));
  const socketPath = process.platform === "win32" ? `\\\\.\\pipe\\obu-sdk-js-${randomUUID()}` : join(directory, "obu.sock");
  const expected = [
    ["waitForDownload", { tabId: 123, timeoutMs: 5000 }],
    ["downloadPath", { downloadId: "download-1" }],
    ["readClipboardText", { tabId: 123 }],
    ["writeClipboardText", { tabId: 123, text: "hello" }]
  ];
  const server = createServer((socket) => {
    let index = 0;
    socket.on("data", (chunk) => {
      const length = endianness() === "LE" ? chunk.readUInt32LE(0) : chunk.readUInt32BE(0);
      const request = JSON.parse(chunk.subarray(4, 4 + length).toString("utf8"));
      if (request.method === "getInfo") { socket.write(encodeFrame({jsonrpc: "2.0", id: request.id, result: {}})); return; }
      const [method, params] = expected[index++];
      assert.equal(request.method, method);
      if (method === "waitForDownload") {
        assert.ok(Number.isInteger(request.params.timeoutMs) && request.params.timeoutMs > 0 && request.params.timeoutMs <= params.timeoutMs);
      }
      assert.deepEqual(
        Object.fromEntries(Object.entries(params).filter(([key]) => key !== "timeoutMs").map(([key]) => [key, request.params[key]])),
        Object.fromEntries(Object.entries(params).filter(([key]) => key !== "timeoutMs"))
      );
      socket.write(encodeFrame({ jsonrpc: "2.0", id: request.id, result: {} }));
    });
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(socketPath, resolve);
  });

  const client = new OpenBrowserUseClient({ socketPath });
  try {
    await client.waitForDownload(123, 5000);
    await client.downloadPath("download-1");
    await client.readClipboardText(123);
    await client.writeClipboardText(123, "hello");
    assert.equal(expected.length, 4);
  } finally {
    client.close();
    server.close();
    await new Promise((resolve) => server.once("close", resolve));
    await rm(directory, { recursive: true, force: true });
  }
});

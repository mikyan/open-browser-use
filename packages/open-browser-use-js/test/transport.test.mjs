import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:net";
import { endianness, tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { OpenBrowserUseClient, encodeFrame } from "../dist/index.js";

async function fixture(t, handleConnection, { listen = true } = {}) {
  const directory = await mkdtemp(join(tmpdir(), "obu-ipc-js-"));
  const socketPath = process.platform === "win32" ? `\\\\.\\pipe\\obu-sdk-js-${randomUUID()}` : join(directory, "obu.sock");
  const sockets = new Set();
  const server = createServer(socket => {
    sockets.add(socket);
    socket.once("close", () => sockets.delete(socket));
    handleConnection(socket);
  });
  const start = () => new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(socketPath, resolve);
  });
  if (listen) await start();
  const client = new OpenBrowserUseClient({ socketPath, timeoutMs: 500 });
  t.after(async () => {
    client.close();
    for (const socket of sockets) socket.destroy();
    if (server.listening) await new Promise(resolve => server.close(resolve));
    await rm(directory, { recursive: true, force: true });
  });
  return { client, server, start };
}

function onFrames(socket, receive) {
  let buffer = Buffer.alloc(0);
  socket.on("data", chunk => {
    buffer = Buffer.concat([buffer, chunk]);
    while (buffer.length >= 4) {
      const length = endianness() === "LE" ? buffer.readUInt32LE(0) : buffer.readUInt32BE(0);
      if (buffer.length < length + 4) return;
      const frame = JSON.parse(buffer.subarray(4, length + 4).toString("utf8"));
      buffer = buffer.subarray(length + 4);
      if (frame.method === "getInfo") socket.write(response(frame, { metadata: {} }));
      else receive(frame);
    }
  });
}

function response(request, result = { ok: true }) {
  return encodeFrame({ jsonrpc: "2.0", id: request.id, result });
}

test("concurrent requests share one in-flight connection", async t => {
  let connections = 0;
  const { client } = await fixture(t, socket => {
    connections++;
    onFrames(socket, request => socket.write(response(request, { method: request.method })));
  });
  const results = await Promise.all(Array.from({ length: 12 }, (_, i) => client.request(`request-${i}`)));
  assert.deepEqual(results, Array.from({ length: 12 }, (_, i) => ({ method: `request-${i}` })));
  assert.equal(connections, 1);
});

test("failed connection can retry after the host starts", async t => {
  const { client, start } = await fixture(t, socket => onFrames(socket, request => socket.write(response(request))), { listen: false });
  await assert.rejects(client.request("ping"));
  await start();
  assert.deepEqual(await client.request("ping"), { ok: true });
});

test("EOF mid-frame preserves the original error and makes the bound client terminal", async t => {
  let connections = 0;
  const { client } = await fixture(t, socket => {
    const first = ++connections === 1;
    onFrames(socket, request => {
      const frame = response(request);
      if (first) socket.end(frame.subarray(0, 2));
      else socket.write(frame);
    });
  });
  await assert.rejects(client.request("ping"), /incomplete frame/);
  await assert.rejects(client.request("ping"), /OBU_SDK_BROWSER_DISCONNECTED/);
  assert.equal(connections, 1);
});

test("fragmented headers, coalesced responses, and notifications preserve request IDs", async t => {
  const requests = [];
  const { client } = await fixture(t, socket => onFrames(socket, request => {
    requests.push(request);
    if (requests.length !== 2) return;
    const bytes = Buffer.concat([
      encodeFrame({ jsonrpc: "2.0", method: "heartbeat", params: { ok: true } }),
      response(requests[1], "second"), response(requests[0], "first")
    ]);
    socket.write(bytes.subarray(0, 1));
    setImmediate(() => {
      socket.write(bytes.subarray(1, 3));
      setImmediate(() => socket.write(bytes.subarray(3)));
    });
  }));
  const notifications = [];
  client.onNotification(notification => notifications.push(notification));
  assert.deepEqual(await Promise.all([client.request("ping"), client.request("ping")]), ["first", "second"]);
  assert.deepEqual(notifications, [{ method: "heartbeat", params: { ok: true } }]);
});

test("malformed or oversized frames fail promptly and make the bound client terminal", async t => {
  for (const kind of ["json", "size"]) {
    await t.test(kind, async t => {
      let connections = 0;
      const { client } = await fixture(t, socket => {
        const first = ++connections === 1;
        onFrames(socket, request => {
          if (!first) { socket.write(response(request)); return; }
          const bytes = Buffer.alloc(kind === "json" ? 5 : 4);
          const length = kind === "json" ? 1 : 64 * 1024 * 1024 + 1;
          if (endianness() === "LE") bytes.writeUInt32LE(length); else bytes.writeUInt32BE(length);
          if (kind === "json") bytes[4] = "{".charCodeAt(0);
          socket.write(bytes);
        });
      });
      await assert.rejects(client.request("ping"), kind === "size" ? /frame too large/ : SyntaxError);
      await assert.rejects(client.request("ping"), /OBU_SDK_BROWSER_DISCONNECTED/);
      assert.equal(connections, 1);
    });
  }
});

test("request deadline does not poison later requests or accept a late response for another ID", async t => {
  let expired;
  const { client } = await fixture(t, socket => onFrames(socket, request => {
    if (!expired) { expired = request; return; }
    socket.write(Buffer.concat([response(expired, "late"), response(request, "current")]));
  }));
  await assert.rejects(client.request("ping"), /timed out/);
  assert.equal(await client.request("ping"), "current");
});

test("explicit close preserves the pending error and forbids reconnect", async t => {
  let notifyRequest;
  const received = new Promise(resolve => { notifyRequest = resolve; });
  let connections = 0;
  const { client } = await fixture(t, socket => {
    const first = ++connections === 1;
    onFrames(socket, request => first ? notifyRequest() : socket.write(response(request)));
  });
  const pending = client.request("ping");
  const rejection = assert.rejects(pending, /client closed/);
  await received;
  client.close();
  await rejection;
  await assert.rejects(client.request("ping"), /OBU_SDK_BROWSER_DISCONNECTED/);
  assert.equal(connections, 1);
});

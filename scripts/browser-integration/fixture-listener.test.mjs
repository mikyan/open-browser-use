import assert from "node:assert/strict";
import { createServer } from "node:http";
import { EventEmitter } from "node:events";
import { randomInt } from "node:crypto";
import test from "node:test";
import { listenFixture } from "./fixture-listener.mjs";

test("real loopback listener serves its retained endpoint and retries an occupied port before returning", async () => {
  const occupied = createServer(), fixture = createServer((_request, response) => response.end("original fixture"));
  try {
    const occupiedPort = await listenFixture(occupied);
    let calls = 0;
    const port = await listenFixture(fixture, { choosePort: () => ++calls === 1 ? occupiedPort : randomInt(49152, 65536) });
    assert.ok(calls >= 2); assert.notEqual(port, occupiedPort);
    assert.equal(await (await fetch(`http://127.0.0.1:${port}/`)).text(), "original fixture");
    assert.equal(occupied.listening, true); assert.equal(fixture.listening, true);
    // Node's HTTP server installs its own listening handler. A failed bind
    // must leave no extra listener compared with a normal successful bind.
    assert.equal(fixture.listenerCount("error"), occupied.listenerCount("error"));
    assert.equal(fixture.listenerCount("listening"), occupied.listenerCount("listening"));
  } finally {
    for (const server of [fixture, occupied]) if (server.listening) await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  }
});

class FailedServer extends EventEmitter {
  listening = false;
  calls = [];
  constructor(code) { super(); this.code = code; }
  listen(options) { this.calls.push(options); queueMicrotask(() => this.emit("error", Object.assign(new Error(this.code), { code: this.code }))); }
}

test("bounded bind conflicts fail before any fixture is published and retain the actual bind error", async () => {
  for (const code of ["EADDRINUSE", "EACCES"]) {
    const server = new FailedServer(code);
    await assert.rejects(listenFixture(server, { choosePort: () => 55000, attempts: 3 }), error => error.cause?.code === code);
    assert.equal(server.calls.length, 3); assert.ok(server.calls.every(options => options.host === "127.0.0.1" && options.exclusive));
    assert.equal(server.listenerCount("error"), 0); assert.equal(server.listenerCount("listening"), 0);
  }
});

test("other bind failures and invalid port configuration are not retried", async () => {
  const server = new FailedServer("EAFNOSUPPORT");
  await assert.rejects(listenFixture(server), { code: "EAFNOSUPPORT" }); assert.equal(server.calls.length, 1);
  for (const port of [0, 6697, 10080, 49151, 65536, NaN]) {
    const other = new FailedServer("EADDRINUSE");
    await assert.rejects(listenFixture(other, { choosePort: () => port }), /dynamic\/private/); assert.equal(other.calls.length, 0);
  }
  for (const attempts of [0, 17, 1.5]) await assert.rejects(listenFixture(new FailedServer("EADDRINUSE"), { attempts }), /bind limit/);
});

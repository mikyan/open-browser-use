import test from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";
import { createEmbeddedMediaFixtures, prepareEmbeddedMediaTab } from "./media-embedded-fixture.mjs";
import { embeddedLimit, embeddedPNG, embeddedBoundaryPNG, embeddedWAV, embeddedWebM, mediaAssetIdentity, verifyRedGreenPNG } from "./media-fixture-assets.mjs";

function request(server, url) {
  let body, status = 200; const headers = {};
  const accepted = server.handle({ url, method: "GET", headers: { host: "127.0.0.1:1234", "sec-fetch-dest": "video" } }, {
    setHeader(name, value) { headers[name] = value; }, writeHead(code) { status = code; }, end(value) { body = value; }
  }, 1234);
  return { accepted, status, body, headers };
}

test("embedded synthetic assets retain actual PNG pixels, PCM geometry and pinned VP8 bytes", () => {
  assert.deepEqual(verifyRedGreenPNG(embeddedPNG).pixels, [[255, 0, 0, 255], [0, 255, 0, 255]]);
  const bad = Buffer.from(embeddedPNG); bad[20] ^= 1; assert.throws(() => verifyRedGreenPNG(bad));
  assert.equal(embeddedWAV.toString("ascii", 0, 4), "RIFF"); assert.equal(embeddedWAV.toString("ascii", 8, 16), "WAVEfmt ");
  assert.equal(embeddedWAV.readUInt32LE(4) + 8, embeddedWAV.length); assert.equal(embeddedWAV.readUInt32LE(40), 1600);
  assert.equal(embeddedWAV.readUInt16LE(20), 1); assert.equal(embeddedWAV.readUInt16LE(22), 1); assert.equal(embeddedWAV.readUInt32LE(24), 8000);
  for (let n = 0; n < 800; n++) assert.equal(embeddedWAV.readInt16LE(44 + n * 2), n % 20 < 10 ? 2048 : -2048);
  assert.equal(embeddedWebM.length, 524); assert.equal(mediaAssetIdentity.webm.sha256, "9b608ca1acd16d6d6026b72a8fa395452f99d26fb5e1f1c4b471c15a64313a8f");
  assert.equal(embeddedBoundaryPNG.length, embeddedLimit);
  assert.deepEqual(embeddedBoundaryPNG.subarray(0, embeddedPNG.length), embeddedPNG);
  assert.ok(embeddedBoundaryPNG.subarray(embeddedPNG.length).every(byte => byte === 0));
});

test("media resource server retains exact requests and serves bytes without fabricating an HTTP media response", () => {
  const server = createEmbeddedMediaFixtures();
  for (const [name, bytes, mime] of [["png", embeddedPNG, "image/png"], ["wav", embeddedWAV, "audio/wav"], ["webm", embeddedWebM, "video/webm"]]) {
    const response = request(server, `/media-breadth/selected.${name}?scope=cross`);
    assert.equal(response.status, 200); assert.equal(response.headers["Content-Type"], mime); assert.deepEqual(response.body, bytes);
  }
  assert.equal(request(server, "/media-breadth/missing").status, 404);
  assert.equal(request(server, "/other").accepted, false);
  assert.equal(server.stats().length, 4);
  assert.deepEqual(server.stats().map(value => value.index), [0, 1, 2, 3]);
  const copy = server.stats(); copy[0].host = "changed"; assert.equal(server.stats()[0].host, "127.0.0.1:1234");
});

test("all root, nested, OOPIF and negative fixture scripts parse as real browser JavaScript", () => {
  const server = createEmbeddedMediaFixtures();
  for (const query of ["", "?boundary=1", "?scope=same", "?scope=cross", "?scope=nested", "?negative=1"]) {
    const { body } = request(server, "/media-breadth/page" + query);
    const scripts = [...body.matchAll(/<script>([\s\S]*?)<\/script>/g)]; assert.equal(scripts.length, 1);
    assert.doesNotThrow(() => new vm.Script(scripts[0][1]));
    assert.ok(scripts[0][1].includes("loadedmetadata")); assert.ok(scripts[0][1].includes("element.decode()"));
  }
  for (const pathname of ["partition", "partition-frame"]) {
    const { body } = request(server, `/media-breadth/${pathname}?blob=${encodeURIComponent("blob:http://127.0.0.1:1234/synthetic")}`);
    assert.doesNotThrow(() => new vm.Script([...body.matchAll(/<script>([\s\S]*?)<\/script>/g)][0][1]));
  }
});

test("browser readiness awaits the actual media promise after document load", async () => {
  const calls = [], readiness = { webmCapability: "probably", states: [{ id: "blob-wav", tag: "AUDIO", readyState: 2, duration: 0.1, paused: true, events: ["loadedmetadata", "loadeddata"] }] };
  const tab = { async waitForLoadState() { calls.push("load"); }, async evaluate(expression, options) {
    calls.push(expression); assert.deepEqual(options, { awaitPromise: true }); return readiness;
  } };
  const result = await prepareEmbeddedMediaTab({ async newTab() { return tab; } }, "http://127.0.0.1:1234/");
  assert.equal(result.readiness, readiness); assert.deepEqual(calls, ["load", "mediaReady"]);
});

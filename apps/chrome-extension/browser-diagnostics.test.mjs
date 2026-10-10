import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { test } from "node:test";
import { BrowserDiagnostics } from "./browser-diagnostics.js";

const log = text => ({ type: () => "log", text: () => text, location: () => ({ url: "https://fixture/", lineNumber: 4, columnNumber: 2 }) });
function request(url = "https://fixture/api", from = null) {
  return { url: () => url, method: () => "GET", resourceType: () => "fetch", frame: () => ({ url: () => "https://fixture/" }), redirectedFrom: () => from, failure: () => ({ errorText: "net::ERR_FAILED" }) };
}

test("real event shapes retain typed diagnostics, stable request IDs and redirect links without headers or bodies", () => {
  const page = new EventEmitter(), capture = new BrowserDiagnostics(page);
  const first = request(), redirected = request("https://fixture/next", first);
  page.emit("console", log("fixture log"));
  page.emit("pageerror", new TypeError("fixture error"));
  page.emit("request", first);
  page.emit("response", { request: () => first, status: () => 302, statusText: () => "Found" });
  page.emit("requestfinished", first);
  page.emit("request", redirected);
  page.emit("requestfailed", redirected);
  const result = capture.snapshot();
  assert.deepEqual(result.entries.map(entry => entry.kind), ["console", "pageerror", "request", "response", "requestfinished", "request", "requestfailed"]);
  assert.equal(result.entries[3].requestId, result.entries[2].requestId);
  assert.equal(result.entries[5].redirectedFrom, result.entries[2].requestId);
  assert.equal(result.entries[6].failure, "net::ERR_FAILED");
  assert.equal(result.entries[0].location.lineNumber, 4);
  assert.equal(result.entries[1].name, "TypeError");
  assert.ok(capture.requestIds instanceof WeakMap);
  assert.ok(result.entries.every(entry => !Object.hasOwn(entry, "headers") && !Object.hasOwn(entry, "body")));
});

test("cursor pagination has no duplicate entries and reports bounded-buffer eviction", () => {
  const page = new EventEmitter(), capture = new BrowserDiagnostics(page, { maxEntries: 3 });
  for (let i = 1; i <= 5; i++) page.emit("console", log(`log ${i}`));
  const first = capture.snapshot({ limit: 2 });
  assert.deepEqual(first.entries.map(entry => entry.sequence), [3, 4]);
  assert.equal(first.dropped, 2);
  const second = capture.snapshot({ after: first.cursor, limit: 2 });
  assert.deepEqual(second.entries.map(entry => entry.sequence), [5]);
  assert.deepEqual(capture.snapshot({ after: second.cursor }).entries, []);
  assert.throws(() => capture.snapshot({ after: { captureId: "other capture", sequence: 0 } }), /EXPIRED/);
  assert.throws(() => capture.snapshot({ after: { captureId: capture.captureId, sequence: 6 } }), /ahead/);
  first.entries[0].text = "changed by caller";
  assert.equal(capture.snapshot().entries[0].text, "log 3");
});

test("UTF-8 field truncation and total byte budget are bounded and visible", () => {
  const page = new EventEmitter(), capture = new BrowserDiagnostics(page, { maxBytes: 19000 });
  for (let i = 0; i < 4; i++) page.emit("console", log("🧪".repeat(10000)));
  const result = capture.snapshot();
  assert.ok(result.dropped >= 2);
  assert.ok(capture.bytes <= 19000);
  for (const entry of result.entries) {
    assert.equal(entry.truncated, true);
    assert.ok(Buffer.byteLength(entry.text) <= 8192);
    assert.ok(!entry.text.includes("�"));
  }
});

test("detach disposal clears retained state and listeners, rejects old cursors and cannot capture late events", () => {
  const page = new EventEmitter(), capture = new BrowserDiagnostics(page);
  page.emit("console", log("old owner"));
  const previous = capture.snapshot();
  page.emit("close");
  assert.equal(capture.entries.length, 0);
  assert.equal(page.eventNames().length, 0);
  assert.throws(() => capture.snapshot(), /EXPIRED/);
  page.emit("console", log("late event"));
  assert.equal(capture.entries.length, 0);
  const successor = new BrowserDiagnostics(page);
  assert.notEqual(successor.captureId, previous.captureId);
  assert.throws(() => successor.snapshot({ after: previous.cursor }), /EXPIRED/);
  assert.deepEqual(successor.snapshot().entries, []);
});

test("collector failure is accounted for without throwing into the browser action", () => {
  const page = new EventEmitter(), capture = new BrowserDiagnostics(page);
  page.emit("console", { type: () => { throw new Error("broken event"); } });
  page.emit("console", log("next"));
  const snapshot = capture.snapshot();
  assert.equal(snapshot.dropped, 1);
  assert.equal(snapshot.entries[0].sequence, 2);
});

test("console argument handles are released without evaluation, including on collector failure", async () => {
  const page = new EventEmitter(), capture = new BrowserDiagnostics(page);
  let disposed = 0;
  const args = () => [{ dispose: async () => { disposed++; } }, { dispose: async () => { disposed++; throw new Error("page already closed"); } }];
  page.emit("console", { ...log("object preview"), args });
  page.emit("console", { type: () => { throw new Error("broken event"); }, args });
  await Promise.resolve();
  assert.equal(disposed, 4);
  assert.equal(capture.snapshot().entries.length, 1);
});

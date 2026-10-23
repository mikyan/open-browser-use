import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { pathToFileURL } from "node:url";
import { createHash } from "node:crypto";
import { Worker } from "node:worker_threads";
import { createRecordedAgentSDK } from "./recorded-agent-sdk.mjs";

const source = `
export const state = { calls: [], plain: { unchanged: true }, syncError: new Error("original synchronous failure"), asyncError: new Error("original rejected failure") };
export class OpenBrowserUseClient {
  #brand = true;
  finalizeTabs(keep) { if (!this.#brand) throw Error("brand"); state.calls.push(["finalizeTabs", keep]); return Promise.resolve({ keep, controlEpoch: 2, closing: false, endedTurnId: "original-turn" }); }
  request(method, params, options) { if (!this.#brand) throw Error("brand"); state.calls.push(["request", method, params, options]); return Promise.resolve({ method, params, options }); }
}
export class OpenBrowserUseBrowser {
  #brand = true;
  constructor() { this.client = new OpenBrowserUseClient(); }
  tab(id) { if (!this.#brand) throw Error("brand"); state.calls.push(["tab", id]); return new OpenBrowserUseTab(id); }
  async newTab(options) { if (!this.#brand) throw Error("brand"); state.calls.push(["newTab", options]); return new OpenBrowserUseTab(71); }
  get label() { return this.#brand ? "original browser" : "bad"; }
  plain() { state.calls.push(["plain"]); return state.plain; }
  value(value) { if (!this.#brand) throw Error("brand"); state.calls.push(["value", value]); return value; }
  nested(value) { state.calls.push(["nested", value]); return { tabs: [value], same: value }; }
  failSync() { state.calls.push(["failSync"]); throw state.syncError; }
  async failAsync() { state.calls.push(["failAsync"]); throw state.asyncError; }
  pending() { state.calls.push(["pending"]); return new Promise((resolve, reject) => { state.resolve = resolve; state.reject = reject; }); }
  close() { if (!this.#brand) throw Error("brand"); state.calls.push(["close"]); }
}
export class OpenBrowserUseTab {
  #brand = true;
  constructor(id) { this.id = id; this.playwright = new OpenBrowserUseLocator(this, []); }
  locator(value) { if (!this.#brand) throw Error("brand"); state.calls.push(["locator", value]); return new OpenBrowserUseLocator(this, [value]); }
  frameLocator(value) { return this.locator(value); }
  async screenshot() { if (!this.#brand) throw Error("brand"); state.calls.push(["screenshot"]); return state.screenshot; }
}
export class OpenBrowserUseLocator {
  #brand = true;
  constructor(tab, steps) { this.tab = tab; this.steps = steps; this.privateCompiledField = "do not serialize SDK internals"; }
  #other(other) { if (!other.#brand) throw Error("wrong brand"); return other; }
  locator(value) { if (!this.#brand) throw Error("brand"); state.calls.push(["locator-chain", value]); return new OpenBrowserUseLocator(this.tab, [...this.steps, value]); }
  and(other) { this.#other(other); state.calls.push(["and", other]); return this; }
  or(other) { this.#other(other); state.calls.push(["or", other]); return this; }
  filter(options) { this.#other(options.has); this.#other(options.hasNot); state.calls.push(["filter", options]); return this; }
  async dragTo(other, options) { this.#other(other); state.calls.push(["dragTo", other, options]); }
  async click(options) { if (!this.#brand) throw Error("brand"); state.calls.push(["click", options]); }
  async textContent() { if (!this.#brand) throw Error("brand"); state.calls.push(["textContent"]); return "original text"; }
}
export async function connectOpenBrowserUse(options) { state.calls.push(["connect", options]); if (options.fail) throw state.asyncError; return new OpenBrowserUseBrowser(); }
`;

async function setup(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "obu-recorded-sdk-"));
  const sdkPath = path.join(root, "fake-sdk.mjs"), directory = path.join(root, "attempt");
  await fs.writeFile(sdkPath, source, { flag: "wx" });
  const module = await import(pathToFileURL(sdkPath).href);
  const recorder = await createRecordedAgentSDK({ sdkPath, directory });
  t.after(async () => {
    await recorder.closeLog().catch(() => {});
    // Only remove the exact temporary root returned by mkdtemp for this test.
    assert.equal(path.dirname(root), path.resolve(os.tmpdir()));
    assert.ok(path.basename(root).startsWith("obu-recorded-sdk-"));
    await fs.rm(root, { recursive: true, force: true });
  });
  return { root, sdkPath, directory, recorder, ...module };
}
async function records(context) {
  await context.recorder.flush();
  return (await fs.readFile(path.join(context.directory, "calls.jsonl"), "utf8")).trim().split("\n").filter(Boolean).map(JSON.parse);
}
const returns = rows => rows.filter(row => row.phase === "return");
const properties = value => value.properties;

test("factory, calls and close record monotonic durations without host process, performance, Buffer or URL globals", { timeout: 15000 }, async t => {
  const c = await setup(t), directory = path.join(c.root, "without-host-globals");
  // Isolate removal from the test runner and other tests. The fake SDK has no
  // transport: this verifies runtime compatibility, not a browser connection.
  const worker = new Worker(new URL(`data:text/javascript,${encodeURIComponent(`
    import { parentPort, workerData } from "node:worker_threads";
    import { setTimeout as delay } from "node:timers/promises";
    import { pathToFileURL } from "node:url";
    for (const key of ["process", "performance", "Buffer", "URL"]) delete globalThis[key];
    const absent = ["process", "performance", "Buffer", "URL"].every(key => typeof globalThis[key] === "undefined");
    const { createRecordedAgentSDK } = await import(workerData.recorderURL);
    const sdk = await import(pathToFileURL(workerData.sdkPath).href);
    const recorder = await createRecordedAgentSDK({ sdkPath: pathToFileURL(workerData.sdkPath), directory: workerData.directory });
    const browser = await recorder.connect({});
    const bytes = new Uint8Array([0, 1, 255, 128]);
    const same = browser.value(bytes) === bytes;
    const pending = browser.pending();
    await delay(15);
    sdk.state.resolve("original completion");
    const result = await pending;
    browser.close();
    const closed = await recorder.closeLog();
    parentPort.postMessage({ absent, same, result, closed });
  `)}`), { workerData: { recorderURL: new URL("./recorded-agent-sdk.mjs", import.meta.url).href, sdkPath: c.sdkPath, directory } });
  t.after(() => worker.terminate());
  let message;
  await new Promise((resolve, reject) => {
    worker.once("message", value => { message = value; });
    worker.once("error", reject);
    worker.once("exit", code => code === 0 ? resolve() : reject(Error(`Isolated recorder worker exited ${code}`)));
  });
  assert.equal(message.absent, true);
  assert.equal(message.same, true);
  assert.equal(message.result, "original completion");
  assert.deepEqual(message.closed.pendingCalls, []);
  const metadata = JSON.parse(await fs.readFile(path.join(directory, "recording.json"), "utf8"));
  const rows = (await fs.readFile(path.join(directory, "calls.jsonl"), "utf8")).trim().split("\n").map(JSON.parse);
  assert.deepEqual(rows.map(row => row.phase), ["start", "return", "start", "return", "start", "return", "start", "return", "close"]);
  let previous = BigInt(metadata.created.monotonicNs);
  for (const clock of [metadata.created, ...rows.map(row => row.end ?? row.start ?? row.at)]) {
    assert.ok(Number.isSafeInteger(clock.wallMs));
    assert.match(clock.monotonicNs, /^\d+$/);
    assert.ok(BigInt(clock.monotonicNs) >= previous);
    previous = BigInt(clock.monotonicNs);
  }
  for (const row of returns(rows)) assert.equal(BigInt(row.elapsedNs), BigInt(row.end.monotonicNs) - BigInt(row.start.monotonicNs));
  const pending = rows.find(row => row.operation === "pending" && row.phase === "return");
  assert.ok(BigInt(pending.elapsedNs) >= 10_000_000n, "the real async wait is measured in nanosecond units");
  const artifact = rows.find(row => row.operation === "value" && row.phase === "return").result;
  assert.deepEqual([...await fs.readFile(path.join(directory, artifact.$artifact))], [0, 1, 255, 128]);
});

test("actual exported SDK classes retain private brands, public getters and stable proxy identity", async t => {
  const c = await setup(t), options = Object.freeze({ socketPath: "owned-test-socket", sessionId: "test-session" });
  const browser = await c.recorder.connect(options);
  assert.equal(c.state.calls[0][1], options);
  assert.ok(browser instanceof c.OpenBrowserUseBrowser);
  assert.equal(browser.label, "original browser");
  assert.equal(browser.client, browser.client);
  const tab = browser.tab(53), locator = tab.frameLocator("iframe").locator("button");
  assert.equal(locator.tab.id, 53);
  assert.equal(locator.and(locator), locator);
  assert.equal(await locator.textContent(), "original text");
  const detached = browser.tab;
  assert.equal(detached(54).id, 54, "saved method uses its original receiver");
  browser.close();
  const rows = await records(c), call = rows.find(row => row.operation === "textContent" && row.phase === "start");
  assert.equal(call.receiver.kind, "OpenBrowserUseLocator"); assert.equal(call.receiver.tabId, 53);
  assert.ok(!JSON.stringify(rows).includes("do not serialize SDK internals"));
  assert.equal(rows.filter(row => row.phase === "start").length, c.state.calls.length);
  for (const row of returns(rows)) {
    assert.ok(Number.isSafeInteger(row.start.wallMs)); assert.ok(row.end.wallMs >= row.start.wallMs);
    assert.ok(BigInt(row.end.monotonicNs) >= BigInt(row.start.monotonicNs));
    assert.equal(BigInt(row.elapsedNs), BigInt(row.end.monotonicNs) - BigInt(row.start.monotonicNs));
  }
});

test("full typed finalize objects and arbitrary public request options pass through unchanged", async t => {
  const c = await setup(t), browser = await c.recorder.connect({ socketPath: "socket" });
  const keep = Object.freeze([Object.freeze({ tabId: 91, status: "deliverable" }), Object.freeze({ tabId: 92, status: "handoff" })]);
  const result = await browser.client.finalizeTabs(keep);
  assert.equal(c.state.calls.at(-1)[1], keep); assert.equal(result.keep, keep);
  const params = { keep, nested: { x: true } }, options = Object.freeze({ timeoutMs: 137, custom: false });
  await browser.client.request("custom-public-method", params, options);
  assert.deepEqual(c.state.calls.at(-1), ["request", "custom-public-method", params, options]);
  assert.equal(c.state.calls.at(-1)[2], params); assert.equal(c.state.calls.at(-1)[3], options);
  const row = (await records(c)).find(row => row.operation === "finalizeTabs" && row.phase === "start");
  const first = properties(properties(row.args)["0"])["0"];
  assert.equal(properties(first).tabId, 91); assert.equal(properties(first).status, "deliverable");
});

test("locator and/or/filter/drag arguments unwrap nested SDK references without mutating inputs", async t => {
  const c = await setup(t), browser = await c.recorder.connect({}), tab = browser.tab(7);
  const left = tab.locator("left"), right = tab.locator("right");
  assert.equal(left.and(right).or(right), left);
  const nested = Object.freeze({ has: right, hasNot: right, visible: true });
  assert.equal(left.filter(nested), left);
  const actual = c.state.calls.at(-1)[1];
  assert.notEqual(actual, nested); assert.equal(nested.has, right); assert.notEqual(actual.has, right);
  assert.equal(actual.has, actual.hasNot); assert.equal(actual.has.tab.id, 7);
  const options = Object.freeze({ timeoutMs: 1234, force: false });
  await left.dragTo(right, options); assert.equal(c.state.calls.at(-1)[2], options);
  assert.notEqual(c.state.calls.at(-1)[1], right);
  const rows = await records(c), and = rows.find(row => row.operation === "and" && row.phase === "start");
  assert.equal(properties(and.args)["0"].kind, "OpenBrowserUseLocator");
  assert.equal(properties(and.args)["0"].tabId, 7);
});

test("plain result identity, callbacks, cyclic data, symbols and holes are preserved", async t => {
  const c = await setup(t), browser = await c.recorder.connect({});
  assert.equal(browser.plain(), c.state.plain);
  const callback = () => "unchanged", symbol = Symbol("key");
  assert.equal(browser.value(callback), callback);
  const original = { tab: browser.tab(3), callback, list: [, "one"] };
  original.self = original; original[symbol] = original.tab;
  const result = browser.value(original), actual = c.state.calls.at(-1)[1];
  assert.equal(result.self, result); assert.equal(result.tab, original.tab); assert.equal(result[symbol], original.tab);
  assert.equal(result.callback, callback); assert.ok(!(0 in result.list));
  assert.equal(original.self, original); assert.equal(original.tab.id, 3); assert.notEqual(actual.tab, original.tab);
  const nested = browser.nested(original.tab);
  assert.equal(nested.tabs[0], original.tab); assert.equal(nested.same, original.tab);
  const rows = await records(c); assert.ok(JSON.stringify(rows).includes('"$cycle"'));
});

test("synchronous and asynchronous original errors, including connection failure, propagate once", async t => {
  const c = await setup(t), browser = await c.recorder.connect({});
  assert.throws(() => browser.failSync(), error => error === c.state.syncError);
  await assert.rejects(browser.failAsync(), error => error === c.state.asyncError);
  await assert.rejects(c.recorder.connect({ fail: true }), error => error === c.state.asyncError);
  const rows = await records(c), failures = rows.filter(row => row.phase === "throw");
  assert.deepEqual(failures.map(row => [row.operation, row.asynchronous]), [["failSync", false], ["failAsync", true], ["connectOpenBrowserUse", true]]);
  assert.equal(c.state.calls.filter(([op]) => op === "failSync").length, 1);
  assert.equal(c.state.calls.filter(([op]) => op === "failAsync").length, 1);
  assert.equal(properties(failures[0].error).message, c.state.syncError.message);
});

test("flush reports a genuinely pending original promise; close cannot finish or replay it", async t => {
  const c = await setup(t), browser = await c.recorder.connect({}), pending = browser.pending();
  const snapshot = await c.recorder.flush(); assert.equal(snapshot.pendingCalls.length, 1);
  await assert.rejects(c.recorder.closeLog(), /still pending/);
  assert.equal(c.state.calls.filter(([op]) => op === "pending").length, 1);
  c.state.resolve(c.state.plain); assert.equal(await pending, c.state.plain);
  assert.deepEqual((await c.recorder.flush()).pendingCalls, []);
  await c.recorder.closeLog();
  assert.throws(() => browser.tab(8), /log is closed/);
  assert.equal(c.state.calls.filter(([op]) => op === "tab").length, 0);
});

test("large strings and original bytes are durable independent hashed artifacts with no data loss", async t => {
  const c = await setup(t), browser = await c.recorder.connect({}), tab = browser.tab(71);
  c.state.screenshot = { mimeType: "image/png", base64: Buffer.alloc(40000, 77).toString("base64") };
  assert.equal(await tab.screenshot(), c.state.screenshot);
  const bytes = Buffer.from([0, 1, 255, 128]), weird = "x".repeat(40000) + "\ud800";
  assert.equal(browser.value(bytes), bytes); assert.equal(browser.value(weird), weird);
  const rows = returns(await records(c));
  const screenshot = properties(rows.find(row => row.operation === "screenshot").result).base64;
  const string = rows.at(-1).result, buffer = rows.at(-2).result;
  for (const item of [screenshot, string, buffer]) {
    const data = await fs.readFile(path.join(c.directory, item.$artifact));
    assert.equal(data.length, item.bytes); assert.equal(createHash("sha256").update(data).digest("hex"), item.sha256);
  }
  assert.equal(JSON.parse(await fs.readFile(path.join(c.directory, screenshot.$artifact), "utf8")), c.state.screenshot.base64);
  assert.equal(JSON.parse(await fs.readFile(path.join(c.directory, string.$artifact), "utf8")), weird);
  assert.deepEqual(await fs.readFile(path.join(c.directory, buffer.$artifact)), bytes);
});

test("input accessors are neither invoked by serialization nor rewritten", async t => {
  const c = await setup(t), browser = await c.recorder.connect({}); let reads = 0;
  const value = { get secret() { reads++; throw Error("not a logging input"); } };
  assert.equal(browser.value(value), value); assert.equal(reads, 0);
  const row = returns(await records(c)).at(-1);
  assert.deepEqual(properties(row.result).secret, { $type: "accessor", get: true, set: false, observed: false });
});

test("artifact write failure cannot turn a real SDK success into failure, and flush must fail", async t => {
  const c = await setup(t), browser = await c.recorder.connect({});
  await fs.rename(path.join(c.directory, "artifacts"), path.join(c.directory, "original-artifacts"));
  await fs.writeFile(path.join(c.directory, "artifacts"), "not a directory", { flag: "wx" });
  const bytes = Buffer.from([1, 2, 3]); assert.equal(browser.value(bytes), bytes);
  await assert.rejects(c.recorder.flush(), /ENOTDIR|ENOENT/);
  await assert.rejects(c.recorder.closeLog(), /ENOTDIR|ENOENT/);
  assert.equal(c.state.calls.filter(([op]) => op === "value").length, 1);
});

test("recording structure limits fail the audit without rewriting or replaying the original result", async t => {
  const c = await setup(t), browser = await c.recorder.connect({}), many = Array.from({ length: 21000 }, (_, index) => index);
  assert.equal(browser.value(many), many);
  await assert.rejects(c.recorder.flush(), /structure limit/);
  await assert.rejects(c.recorder.closeLog(), /structure limit/);
  assert.equal(c.state.calls.filter(([op]) => op === "value").length, 1);
});

test("a previous attempt is never overwritten and closeLog joins concurrent callers", async t => {
  const c = await setup(t);
  const before = await fs.readFile(path.join(c.directory, "recording.json"));
  await assert.rejects(createRecordedAgentSDK({ sdkPath: c.sdkPath, directory: c.directory }), { code: "EEXIST" });
  assert.deepEqual(await fs.readFile(path.join(c.directory, "recording.json")), before);
  const [a, b] = await Promise.all([c.recorder.closeLog(), c.recorder.closeLog()]); assert.deepEqual(a, b);
  const rows = (await fs.readFile(path.join(c.directory, "calls.jsonl"), "utf8")).trim().split("\n").map(JSON.parse);
  assert.equal(rows.filter(row => row.phase === "close").length, 1);
});

test("current formal SDK dist preserves real locator composition, drag and finalize shapes with a stubbed transport", async t => {
  const c = await setup(t), sdkPath = new URL("../../packages/open-browser-use-js/dist/index.js", import.meta.url);
  const sdk = await import(sdkPath.href), client = new sdk.OpenBrowserUseClient({ socketPath: "unused-shape-only" }), calls = [];
  // These two seams are local to this test's instance. No SDK source, browser,
  // socket or native host is touched. This is an API-shape test, not acceptance.
  client.connect = async () => client;
  client.request = async (method, params, options) => {
    calls.push({ method, params, options });
    return method === "browserAction" ? { value: null, engine: { name: "playwright-crx", version: "shape-test", playwrightVersion: "shape-test" } } : { ok: true };
  };
  const directory = path.join(c.root, "formal-sdk-shape"), recorder = await createRecordedAgentSDK({ sdkPath, directory });
  t.after(() => recorder.closeLog());
  const browser = await recorder.connect({ client });
  assert.equal(browser.client.turnId, client.turnId); assert.equal(browser.client.controlEpoch, null);
  const tab = browser.tab(128), left = tab.frameLocator("iframe").locator(".left"), right = tab.frameLocator("iframe").locator(".right");
  const filtered = left.filter({ has: right, hasNot: right, visible: true }).and(right).or(right);
  await filtered.click({ timeoutMs: 4000, modifiers: ["Shift"] });
  await left.dragTo(right, { timeoutMs: 6000, targetPosition: { x: 2, y: 3 } });
  const keep = [{ tabId: 128, status: "deliverable" }];
  await browser.client.finalizeTabs(keep);
  assert.equal(calls.length, 3);
  assert.equal(calls[0].params.action, "click");
  assert.deepEqual(calls[0].params.locator.map(step => step.kind), ["frame", "css", "filter", "and", "or"]);
  assert.equal(calls[1].params.action, "dragTo"); assert.deepEqual(calls[1].params.args.target, right.steps);
  assert.deepEqual(calls[1].params.args.targetPosition, { x: 2, y: 3 });
  assert.deepEqual(calls[2], { method: "finalizeTabs", params: { keep }, options: undefined });
  assert.equal(calls[2].params.keep, keep);
  await recorder.closeLog();
  const rows = (await fs.readFile(path.join(directory, "calls.jsonl"), "utf8")).trim().split("\n").map(JSON.parse);
  for (const operation of ["click", "dragTo", "finalizeTabs"]) assert.equal(rows.filter(row => row.operation === operation && row.phase === "return").length, 1);
});

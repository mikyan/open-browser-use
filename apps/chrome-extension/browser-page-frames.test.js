import assert from "node:assert/strict";
import test from "node:test";
import { BrowserPageFrames } from "./browser-page-frames.js";

const frame = (frameId = 0, parentFrameId = -1, documentId = `document-${frameId}`) => ({ frameId, parentFrameId, documentId, processId: 100 + frameId, documentLifecycle: "active", url: "https://same.example/" });
const event = (sourceFrameId = 0, tabId = 20) => ({ sourceTabId: 10, sourceFrameId, sourceProcessId: 100 + sourceFrameId, tabId, url: "https://same.example/", timeStamp: -1 });
async function pinned(values = [frame(), frame(2, 0), frame(3, 2)]) {
  const ledger = new BrowserPageFrames(), entry = ledger.create(10); await ledger.snapshot(entry, async () => values); return { ledger, entry, values };
}

test("root and nested native numeric frames pin original document without timestamp comparisons", async () => {
  const { ledger, entry } = await pinned();
  assert.equal(ledger.candidate(entry, event(3)).documentId, "document-3"); assert.equal(ledger.candidate(entry, event()).documentId, "document-0");
  for (const override of [{ sourceTabId: 11 }, { sourceFrameId: "3" }, { sourceProcessId: 999 }, { tabId: 10 }, { sourceFrameId: 8 }]) assert.equal(ledger.candidate(entry, { ...event(3), ...override }), null);
});

test("new frame first document joins live root; an existing frame navigation permanently excludes its subtree", async () => {
  const { ledger, entry, values } = await pinned();
  ledger.navigation(entry, "onBeforeNavigate", { tabId: 10, frameId: 4 });
  ledger.navigation(entry, "onCommitted", { tabId: 10, ...frame(4, 0) });
  values.push(frame(4, 0)); await ledger.snapshot(entry, async () => values);
  assert.equal(ledger.candidate(entry, event(4)).documentId, "document-4");
  ledger.navigation(entry, "onBeforeNavigate", { tabId: 10, frameId: 2 });
  assert.equal(ledger.candidate(entry, event(2)), null); assert.equal(ledger.candidate(entry, event(3)), null);
  ledger.navigation(entry, "onCommitted", { tabId: 10, ...frame(2, 0, "replacement") });
  ledger.navigation(entry, "onCommitted", { tabId: 10, ...frame(5, 2) });
  assert.equal(ledger.candidate(entry, event(2)), null); assert.equal(ledger.candidate(entry, event(5)), null); assert.ok(ledger.candidate(entry, event(4)));
});

test("root navigation invalidates every source including dynamic frames", async () => {
  const { ledger, entry } = await pinned();
  ledger.navigation(entry, "onBeforeNavigate", { tabId: 10, frameId: 0 });
  assert.throws(() => ledger.check(entry), /SOURCE_CHANGED/); assert.equal(ledger.candidate(entry, event(3)), null);
});

test("versioned getAllFrames rejects an event interleaved with its actual asynchronous response", async () => {
  const { ledger, entry, values } = await pinned(); let resolve;
  const pending = ledger.snapshot(entry, () => new Promise(done => { resolve = done; }));
  ledger.navigation(entry, "onCommitted", { tabId: 10, ...frame(4, 0) }); resolve([...values, frame(4, 0)]);
  await assert.rejects(pending, /SOURCE_CHANGED/);
});

test("snapshot detects replacement/removal/process changes even without a routed navigation event", async () => {
  for (const change of [values => values.filter(value => value.frameId !== 3), values => values.map(value => value.frameId === 3 ? { ...value, documentId: "new" } : value), values => values.map(value => value.frameId === 3 ? { ...value, processId: 999 } : value)]) {
    const { ledger, entry, values } = await pinned(); const candidate = ledger.candidate(entry, event(3));
    await ledger.snapshot(entry, async () => change(values)); assert.throws(() => ledger.validate(entry, candidate), /SOURCE_CHANGED/);
  }
});

test("malformed, duplicate, detached and cyclic native frame graphs cannot establish readiness", async () => {
  for (const values of [[], [frame(), frame()], [frame(), frame(2, 9)], [frame(), frame(2, 3), frame(3, 2)], [{ ...frame(), documentId: "" }], [{ ...frame(), documentLifecycle: "prerender" }]]) {
    const ledger = new BrowserPageFrames(); await assert.rejects(ledger.snapshot(ledger.create(10), async () => values), /SOURCE_CHANGED/);
  }
});

test("frame and navigation history remain bounded instead of evicting excluded identities", async () => {
  const ledger = new BrowserPageFrames({ maxFrames: 3 }), entry = ledger.create(10); await ledger.snapshot(entry, async () => [frame()]);
  for (let id = 1; id <= 4; id++) ledger.navigation(entry, "onBeforeNavigate", { tabId: 10, frameId: id });
  assert.throws(() => ledger.check(entry), /SOURCE_CHANGED/);
  await assert.rejects(ledger.snapshot(ledger.create(11), async () => [frame(), frame(1, 0), frame(2, 0), frame(3, 0)]), /SOURCE_CHANGED/);
});

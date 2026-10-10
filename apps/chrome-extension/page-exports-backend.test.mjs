import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import vm from "./test-support/backend-vm.mjs";
import { SITE_ACCESS_POLICY_KEY } from "./site-access-policy.js";

const source = (await readFile(new URL("./background.js", import.meta.url), "utf8"))
  .replace('import { createBrowserActionEngine } from "./browser-runtime.js";', "")
  .replace('import { NativeInputTracker } from "./browser-input-adapter.js";',
    (await readFile(new URL("./browser-input-adapter.js", import.meta.url), "utf8")).replace(/^export /gm, ""));
const code = source.slice(0, source.indexOf("chrome.runtime.onInstalled.addListener"));
const tick = () => new Promise(resolve => setTimeout(resolve, 0));
const event = () => { const listeners = []; return { addListener: fn => listeners.push(fn), removeListener() {}, emit: (...args) => listeners.forEach(fn => fn(...args)) }; };
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };

async function fixture(t, restricted = false) {
  const state = restricted ? { [SITE_ACCESS_POLICY_KEY]: { version: 1, revision: 1, mode: "allow", origins: ["https://allowed.test"] } } : {};
  const calls = [], hooks = {}, gates = [], tabs = new Map([[7, { id: 7, groupId: 10, windowId: 1, url: "https://allowed.test/page" }], [8, { id: 8, groupId: 20, windowId: 1, url: "https://allowed.test/other" }]]);
  const frames = [{ frameId: 0, parentFrameId: -1, url: tabs.get(7).url, documentLifecycle: "active", errorOccurred: false }];
  const chrome = {
    storage: { local: { async get(key) { return { [key]: structuredClone(state[key]) }; }, async set(value) { Object.assign(state, structuredClone(value)); } } },
    runtime: { id: "fixture", getManifest: () => ({ version: "test" }), getURL: path => `chrome-extension://fixture/${path}` },
    debugger: { onDetach: event(), onEvent: event(), async attach() { await hooks.attach?.(); }, async detach({ tabId }) { calls.push(["detach", tabId]); },
      async sendCommand(target, method, args) {
        calls.push([method, target.tabId, args]);
        if (hooks.command) { const result = await hooks.command(method, args); if (result !== undefined) return result; }
        if (method === "Page.printToPDF") return { stream: `stream-${target.tabId}` };
        if (method === "IO.read") return { data: btoa("%PDF-fixture"), base64Encoded: true, eof: true };
        if (method === "Page.captureSnapshot") return { data: "MIME-Version: 1.0\r\nContent-Type: multipart/related\r\n\r\n中文" };
        return {};
      } },
    tabs: { onUpdated: event(), onDetached: event(), onReplaced: event(), onRemoved: event(),
      async get(id) { return structuredClone(tabs.get(id)); },
      async query(filter = {}) { await hooks.query?.(); return [...tabs.values()].filter(tab => filter.groupId === undefined || filter.groupId === tab.groupId).map(tab => structuredClone(tab)); },
      async sendMessage() { return {}; }, async update() { throw new Error("must not activate a tab"); } },
    windows: { async update() { throw new Error("must not focus a window"); } },
    webNavigation: { onBeforeNavigate: event(), onCommitted: event(), onErrorOccurred: event(), onHistoryStateUpdated: event(), onReferenceFragmentUpdated: event(), async getAllFrames() { return structuredClone(frames); } },
    tabGroups: { async update() {} }
  };
  const createBrowserActionEngine = hooks => {
    const pages = new Map(), generations = new Map();
    return { pages, generations,
      async attach(id) { if (pages.has(id)) return; await hooks.onBeforeAttach(id); await chrome.debugger.attach({ tabId: id }); await hooks.onAttached(id); pages.set(id, {}); },
      async detach(id) { pages.delete(id); await chrome.debugger.detach({ tabId: id }); await hooks.onDetached(id); }, forget(id) { pages.delete(id); } };
  };
  const Backend = vm.runInNewContext(`${code}\nBrowserBackend`, { chrome, crypto, Date, URL, setTimeout, clearTimeout, createBrowserActionEngine });
  const backend = new Backend(); await backend.controlReady;
  for (const [name, groupId, tabId] of [["task", 10, 7], ["other", 20, 8]]) {
    const session = await backend.store.getSession(name); session.chromeGroupId = groupId; session.tabOrigins = { [tabId]: "agent" };
  }
  await backend.store.save();
  const current = await backend.getControlState({ session_id: "task" });
  const params = { session_id: "task", turn_id: "turn", control_epoch: current.controlEpoch, tabId: 7, format: "pdf" };
  t.after(async () => { for (const gate of gates) gate.resolve(); delete hooks.command; delete hooks.query; delete hooks.attach; await backend.pageExports.invalidateAll(); await Promise.all([...backend.attachedTabs].map(id => backend.detachTab(id))); });
  return { backend, chrome, calls, hooks, tabs, frames, params, gate() { const gate = deferred(); gates.push(gate); return gate; } };
}

test("public page export uses owned native attachment, closes PDF and supports MHTML without activating tabs", async t => {
  const f = await fixture(t);
  const pdf = await f.backend.exportPage(f.params);
  assert.equal(atob(pdf.data), "%PDF-fixture"); assert.equal(pdf.byteLength, 12);
  assert.equal(f.calls.filter(([method]) => method === "IO.close").length, 1);
  const mhtml = await f.backend.exportPage({ ...f.params, format: "mhtml" });
  assert.match(Buffer.from(mhtml.data, "base64").toString(), /中文/);
  assert.equal(f.backend.pageExports.controlSnapshot().pending.length, 0);
  assert.equal((await f.backend.getInfo()).metadata.pageExportVersion, 1);
});

test("foreign and non-HTTP pages fail before native export or attachment", async t => {
  const f = await fixture(t);
  await assert.rejects(f.backend.exportPage({ ...f.params, tabId: 8 }), /not part|owned/);
  f.tabs.get(7).url = "file:///private/document.html";
  await assert.rejects(f.backend.exportPage(f.params), /OBU_EXPORT_UNSUPPORTED/);
  assert.equal(f.calls.length, 0);
});

for (const kind of ["root", "child", "opened", "history", "moved"]) test(`export rejects ${kind} document/ownership change and closes the exact late stream`, async t => {
  const f = await fixture(t), gate = f.gate(), printing = f.gate();
  f.hooks.command = async method => { if (method === "Page.printToPDF") { printing.resolve(); await gate.promise; } };
  const pending = assert.rejects(f.backend.exportPage(f.params), /OBU_EXPORT_(DOCUMENT_CHANGED|CANCELLED)/);
  await printing.promise;
  if (kind === "root") f.backend.handleCdpEvent({ tabId: 7 }, "Page.frameNavigated", { frame: { id: "root" } });
  if (kind === "child") f.backend.handleCdpEvent({ tabId: 7, sessionId: "child" }, "Page.frameDetached", { frameId: "child" });
  if (kind === "opened") f.backend.handleCdpEvent({ tabId: 7 }, "Page.documentOpened", {});
  if (kind === "history") f.chrome.webNavigation.onHistoryStateUpdated.emit({ tabId: 7, frameId: 0, url: "https://allowed.test/new" });
  if (kind === "moved") f.chrome.tabs.onDetached.emit(7);
  await pending;
  assert.ok(f.backend.globalControlSnapshot().pending.length > 0);
  gate.resolve(); await f.backend.pageExports.invalidateAll();
  assert.equal(f.calls.filter(([method]) => method === "IO.read").length, 0);
  assert.equal(f.calls.filter(([method]) => method === "IO.close").length, 1);
});

test("detach waits for late stream close and preserves failure for an explicit retry", async t => {
  const f = await fixture(t), gate = f.gate(), printing = f.gate(); let failClose = true;
  f.hooks.command = async method => {
    if (method === "Page.printToPDF") { printing.resolve(); await gate.promise; }
    if (method === "IO.close" && failClose) throw new Error("native close failure");
  };
  const pending = assert.rejects(f.backend.exportPage(f.params), /OBU_EXPORT_CANCELLED/);
  await printing.promise;
  const release = assert.rejects(f.backend.detachTab(7), /OBU_EXPORT_CLEANUP_FAILED/);
  await pending; await tick(); assert.equal(f.calls.some(([method]) => method === "detach"), false);
  gate.resolve(); await release;
  assert.equal(f.calls.some(([method]) => method === "detach"), false);
  failClose = false; await f.backend.detachTab(7);
  assert.equal(f.calls.filter(([method]) => method === "IO.close").length, 2);
  assert.ok(f.calls.findIndex(([method]) => method === "detach") > f.calls.findLastIndex(([method]) => method === "IO.close"));
});

test("cold admission timeout cannot start a native export later", async t => {
  const f = await fixture(t), gate = f.gate();
  f.hooks.query = () => gate.promise;
  await assert.rejects(f.backend.exportPage({ ...f.params, timeoutMs: 20 }), /OBU_EXPORT_TIMEOUT/);
  assert.ok(f.backend.globalControlSnapshot().pending.length > 0);
  gate.resolve(); delete f.hooks.query; await tick();
  assert.equal(f.calls.some(([method]) => method.startsWith("Page.")), false);
});

test("deadline expiring in the final ownership inspection prevents native dispatch", async t => {
  const f = await fixture(t), gate = f.gate(), inspecting = f.gate();
  const validate = f.backend.validatePageExportScope.bind(f.backend); let checks = 0;
  f.backend.validatePageExportScope = async scope => { await validate(scope); if (++checks === 2) { inspecting.resolve(); await gate.promise; } };
  const pending = assert.rejects(f.backend.exportPage({ ...f.params, timeoutMs: 30 }), /OBU_EXPORT_TIMEOUT/);
  await inspecting.promise; await pending;
  gate.resolve(); await f.backend.pageExports.invalidateAll();
  assert.equal(f.calls.some(([method]) => method === "Page.printToPDF"), false);
});

test("ending the session drains native close before releasing its attachment", async t => {
  const f = await fixture(t), gate = f.gate(), printing = f.gate();
  f.hooks.command = async method => { if (method === "Page.printToPDF") { printing.resolve(); await gate.promise; } };
  const pending = assert.rejects(f.backend.exportPage(f.params), /OBU_EXPORT_CANCELLED/);
  await printing.promise;
  let ended = false;
  const ending = f.backend.turnEnded(f.params).then(() => { ended = true; });
  await pending; await tick(); assert.equal(ended, false);
  assert.equal(f.calls.some(([method]) => method === "detach"), false);
  gate.resolve(); await ending;
  assert.equal(f.calls.filter(([method]) => method === "IO.close").length, 1);
  assert.equal(f.backend.pageExports.records.size, 0);
});

test("the CRX captured release hook drains exports before its internal native detach", async t => {
  const f = await fixture(t), gate = f.gate(), printing = f.gate();
  f.hooks.command = async method => { if (method === "Page.printToPDF") { printing.resolve(); await gate.promise; } };
  const pending = assert.rejects(f.backend.exportPage(f.params), /OBU_EXPORT_CANCELLED/);
  await printing.promise;
  const captured = f.backend.prepareInputRelease(7);
  let released = false;
  const release = captured.release().then(async () => { released = true; await captured.detach(); });
  await pending; await tick(); assert.equal(released, false);
  assert.equal(f.calls.some(([method]) => method === "detach"), false);
  gate.resolve(); await release;
  assert.ok(f.calls.findIndex(([method]) => method === "detach") > f.calls.findIndex(([method]) => method === "IO.close"));
});

test("discovering a moved auxiliary window during scope inspection cannot deadlock its own cleanup", { timeout: 1000 }, async t => {
  const f = await fixture(t);
  Object.assign(f.tabs.get(7), { groupId: -1, windowId: 2 });
  const claim = f.backend.auxiliaryTabs.reserve(f.params);
  await f.backend.auxiliaryTabs.commit(claim, { windowId: 2, control_epoch: f.params.control_epoch, check() {}, async validate() {} });
  f.hooks.command = async method => { if (method === "IO.read") f.tabs.get(7).windowId = 3; };
  await assert.rejects(f.backend.exportPage(f.params), /OBU_EXPORT_CANCELLED/);
  await Promise.all([...f.backend.auxiliaryReleases.values()]);
  assert.equal(f.backend.pageExports.records.size, 0);
  assert.equal(f.backend.auxiliaryTabs.entry(7), undefined);
  assert.equal(f.calls.filter(([method]) => method === "IO.close").length, 1);
});

test("restricted PDF checks all frames; MHTML is rejected before native capture", async t => {
  const f = await fixture(t, true);
  assert.equal((await f.backend.exportPage(f.params)).format, "pdf");
  await assert.rejects(f.backend.exportPage({ ...f.params, format: "mhtml" }), /OBU_SITE_ACCESS_UNSUPPORTED/);
  f.frames.push({ frameId: 1, parentFrameId: 0, url: "https://denied.test/secret", documentLifecycle: "active", errorOccurred: false });
  await assert.rejects(f.backend.exportPage(f.params), /OBU_SITE_ACCESS_DENIED|OBU_EXPORT_CANCELLED/);
  assert.equal(f.calls.filter(([method]) => method === "Page.printToPDF").length, 1);
  assert.equal(f.calls.some(([method]) => method === "Page.captureSnapshot"), false);
});

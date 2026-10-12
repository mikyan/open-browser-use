import assert from "node:assert/strict";
import test from "node:test";
import { createContext, runInContext } from "node:vm";
import { AuxiliaryTabOwnership, AUXILIARY_TABS_KEY } from "../../apps/chrome-extension/auxiliary-tab-ownership.js";
import { installCreatedPageAdoptionObserver } from "./created-page-adoption-observer.mjs";
import {
  assertPopupSourcePlacement, assertPopupChildPlacement, assertPopupFocusUnchanged,
  assertPopupRetirement, assertPopupAdoption, assertPopupNativeControl, checkCreatedPagePopupSource,
} from "./created-page-popup-source.mjs";

const copy = value => structuredClone(value);
const plain = value => JSON.parse(JSON.stringify(value));
function placement() {
  const sentinel = { id: 1, windowId: 10, url: "https://example.invalid/sentinel", active: true, groupId: -1, pinned: false };
  const source = { id: 2, windowId: 20, url: "http://127.0.0.1/source", active: true, groupId: -1, pinned: false };
  // Chromium may assign the selected normal-window tab as opener. The native
  // created-target source and original document nonce establish provenance.
  const child = { id: 3, windowId: 10, url: "http://127.0.0.1/created-page/child", active: false, groupId: -1, pinned: false, openerTabId: 1 };
  const windows = [{ id: 10, type: "normal", focused: true, state: "normal" }, { id: 20, type: "popup", focused: false, state: "normal" }];
  const item = { tabId: 2, childId: 3, sourceURL: source.url, childURL: child.url, sentinel, destinationWindow: windows[0], sourceWindow: windows[1], childBirth: copy(child),
    scope: { session_id: "popup-owner", turn_id: "original-turn", control_epoch: 7 }, waiterId: "original-wait", sourceFrame: { frameId: 9 } };
  return { item, birth: item.childBirth, native: { tabs: [sentinel, source, child], windows, targets: [] } };
}

test("popup feasibility accepts the same native cross-window child even when opener names the sentinel", () => {
  const value = placement(); assertPopupSourcePlacement(value);
  assert.equal(assertPopupChildPlacement(value).id, 3); assert.equal(value.birth.openerTabId, value.item.sentinel.id);
});

for (const [name, mutate] of [
  ["child selected", value => { value.birth.active = true; value.native.tabs[2].active = true; }],
  ["child created in the source window", value => { value.birth.windowId = 20; value.native.tabs[2].windowId = 20; }],
  ["child moved after its native birth", value => { value.native.tabs[2].windowId = 30; }],
  ["child regrouped", value => { value.native.tabs[2].groupId = 17; }],
  ["child replaced", value => { value.native.tabs[2].id = 4; }],
  ["child URL replaced", value => { value.native.tabs[2].url += "?replacement"; }],
  ["source window focused", value => { value.native.windows[1].focused = true; }],
  ["destination not already focused", value => { value.native.windows[0].focused = false; }],
  ["source popup replaced by normal window", value => { value.native.windows[1].type = "normal"; }],
  ["second normal window", value => { value.native.windows.push({ id: 30, type: "normal", focused: false }); }],
  ["sentinel selected identity changed", value => { value.native.tabs[0] = { ...value.native.tabs[0], id: 99 }; }],
  ["source popup acquired another tab", value => { value.native.tabs.push({ id: 99, windowId: 20 }); }],
]) test(`popup feasibility rejects ${name}`, () => { const value = placement(); mutate(value); assert.throws(() => assertPopupChildPlacement(value)); });

test("focus evidence rejects a transient focus that was later restored, and rewritten histories", () => {
  const before = { identity: "observer", ready: true, overflow: false, at: 1, events: [] };
  assertPopupFocusUnchanged(before, { ...before, at: 2 });
  const restored = { ...before, at: 4, events: [{ sequence: 0, at: 2, kind: "focus", value: 20 }, { sequence: 1, at: 3, kind: "focus", value: 10 }] };
  assert.throws(() => assertPopupFocusUnchanged(before, restored), /activation or focus/);
  assert.throws(() => assertPopupFocusUnchanged(restored, before), /truncated/);
  assert.throws(() => assertPopupFocusUnchanged(before, { ...before, identity: "replacement" }), /document changed/);
});

test("finalize preserves exact user pages while removing all authority and debugger attachments", () => {
  const value = { ...placement(), ownership: [2, 3].map(tabId => ({ tabId, owner: null, entry: null, stored: [] })), tabs: [] };
  assertPopupRetirement(value);
  for (const mutate of [
    v => { v.ownership[0].owner = { session_id: "popup-owner" }; },
    v => { v.ownership[1].stored = [{ tabId: 3 }]; },
    v => { v.native.targets = [{ tabId: 3, attached: true }]; },
    v => { v.tabs = [{ id: 2 }]; },
    v => { v.native.tabs = v.native.tabs.filter(tab => tab.id !== 2); },
  ]) { const invalid = copy(value); mutate(invalid); assert.throws(() => assertPopupRetirement(invalid)); }
});

async function adoptionEvidence() {
  const { item } = placement(), scope = { ...item.scope, tabId: item.tabId, controlRevision: 2 };
  const source = { claimId: "original-popup-claim", ...scope, windowId: item.sourceWindow.id, kind: "popup", origin: "user", phase: "committed" };
  const chrome = { tabs: { get: async () => copy(item.childBirth) }, storage: { session: { set: async () => {} } } };
  const auxiliaryTabs = new AuxiliaryTabOwnership({ createId: () => "native-child-claim", storage: {
    setAccessLevel: async () => {}, get: async () => ({ [AUXILIARY_TABS_KEY]: { version: 4, records: [source] } }), set: value => chrome.storage.session.set(value),
  } });
  await auxiliaryTabs.ready;
  const backend = { auxiliaryTabs, async adoptCreatedPage(current, event, record) {
    const tab = await chrome.tabs.get(event.tabId), claim = this.auxiliaryTabs.reserve({ ...current, tabId: tab.id }); record.pageAdmission = claim;
    await this.auxiliaryTabs.commit(claim, { windowId: tab.windowId, kind: "created-page", control_epoch: current.control_epoch, controlRevision: current.controlRevision,
      check: () => {}, validate: async () => { await chrome.tabs.get(event.tabId); } });
    return { tabId: tab.id };
  } };
  const context = createContext({ backend, chrome, Date, TextEncoder });
  runInContext(`(${installCreatedPageAdoptionObserver.toString()})(backend,chrome,globalThis,${JSON.stringify({ sessions: [scope.session_id] })})`, context);
  await backend.adoptCreatedPage(scope, { sourceTabId: item.tabId, sourceFrameId: item.sourceFrame.frameId, sourceProcessId: 43, tabId: item.childId, url: item.childURL },
    { waiterId: item.waiterId, params: { ...scope, timeoutMs: 20000 }, state: "matching", deadlineAt: 50000 });
  return { item, snapshot: plain(context.__createdPageAdoption.stop()) };
}

const recount = snapshot => { snapshot.records.forEach((row, i) => { row.sequence = i + 1; }); snapshot.bytes = snapshot.records.reduce((sum, row) => sum + Buffer.byteLength(JSON.stringify(row)), 0); };
test("cross-window admission assertion reads real user-popup auxiliary persistence and original observer ACKs", async () => {
  const { item, snapshot } = await adoptionEvidence();
  assert.deepEqual(assertPopupAdoption({ snapshot, items: [item] }), [{ sourceTabId: 2, childId: 3, claimId: "native-child-claim", sourceWindowId: 20, childWindowId: 10 }]);
});

test("adoption evidence rejects agent-source substitution, wrong native source and missing durable commit ACK", async () => {
  const { item, snapshot } = await adoptionEvidence();
  for (const mutate of [
    value => { const row = value.records.find(row => row.kind === "adoption-enter"); row.source.entry.origin = row.source.owner.origin = "agent"; },
    value => { value.records.find(row => row.kind === "adoption-enter").event.sourceTabId = item.sentinel.id; },
    value => { value.records.find(row => row.kind === "adoption-enter").event.sourceFrameId++; },
    value => { value.records.find(row => row.kind === "adoption-enter").child.owner = { tabId: 3 }; },
    value => { value.records.find(row => row.kind === "commit-enter").options.windowId = item.sourceWindow.id; },
    value => { const write = value.records.findLast(row => row.kind === "storage-set-call"); value.records = value.records.filter(row => !(row.operationId === write.operationId && row.kind === "storage-set-fulfilled")); },
    value => { value.records = value.records.filter(row => row.kind !== "adoption-fulfilled"); },
    value => { value.pendingOperations.push({ kind: "storage-set", operationId: 99 }); },
    value => { value.overflow = true; },
  ]) { const invalid = copy(snapshot); mutate(invalid); recount(invalid); assert.throws(() => assertPopupAdoption({ snapshot: invalid, items: [item] })); }
});

function nativeEvidence() {
  const { item } = placement(), records = [];
  const add = row => records.push({ sequence: records.length + 1, receivedAt: records.length + 1, ...row });
  const call = (api, args, operationId) => { add({ kind: "call", api, args, operationId }); add({ kind: "fulfilled", api, operationId }); };
  call("windows.create", [{ type: "popup", focused: false, url: "about:blank" }], 1);
  for (const [i, type] of ["mousePressed", "mouseReleased"].entries()) call("debugger.sendCommand", [{ tabId: item.tabId }, "Input.dispatchMouseEvent", { type, modifiers: 2, button: "left", clickCount: 1 }], i + 2);
  add({ kind: "event", api: "tabs.onCreated", args: [copy(item.childBirth)] });
  return { item, snapshot: { closed: true, restored: true, listenersRemoved: true, overflow: false, errors: [], pendingOperations: [], records } };
}
test("native-control evidence requires original Control press and release ACKs without creation or focus substitutes", () => {
  const { item, snapshot } = nativeEvidence(); assert.equal(assertPopupNativeControl({ snapshot, items: [item] }).calls, 3);
  for (const mutate of [
    value => { value.records.find(row => row.kind === "fulfilled" && row.operationId === 3).kind = "rejected"; },
    value => { value.records = value.records.filter(row => !(row.kind === "fulfilled" && row.operationId === 2)); },
    value => { value.records.find(row => row.api === "tabs.onCreated").args[0].id = 4; },
    value => { value.records[0].args[0].type = "normal"; },
    value => { value.records[0].args[0].focused = true; },
    value => { value.records[2].api = "tabs.update"; },
    value => { value.records[2].args[1] = "Page.bringToFront"; },
    value => { value.records[4].args[2].type = "mousePressed"; },
    value => { value.pendingOperations.push({ operationId: 3 }); },
  ]) { const invalid = copy(snapshot); mutate(invalid); assert.throws(() => assertPopupNativeControl({ snapshot: invalid, items: [item] })); }
});

test("partial setup retains its primary failure and closes the already connected session without browser work", async () => {
  const original = new Error("second connection failed"), calls = [], detail = {};
  const first = { client: { sessionId: "first", finalizeTabs: async () => { calls.push("finalize"); } }, close: async () => { calls.push("close"); } };
  let count = 0;
  await assert.rejects(checkCreatedPagePopupSource({
    connectBrowser: async () => { if (++count === 1) return first; throw original; },
    getWorker: () => { throw Error("No worker may be touched before successful setup"); },
    createPopup: () => { throw Error("No window should be created"); },
    readFocus: () => { throw Error("No focus operation"); }, fixtureURL: "http://127.0.0.1/", server: { allStats: () => ({ children: [] }) }, detail,
    saveDetail: async value => { calls.push("save"); assert.equal(value.passed, false); },
  }), error => error === original && error.createdPagePopupSourceDetail === detail);
  assert.deepEqual(calls, ["finalize", "close", "save"]); assert.equal(detail.cases.length, 0);
});

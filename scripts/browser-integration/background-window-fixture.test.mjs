import assert from "node:assert/strict";
import test from "node:test";
import { FocusLedger } from "./focus-ledger.mjs";
import { checkBackgroundWindowCreated, checkBackgroundWindowCleanup, checkBackgroundWindowSuccessor, createBackgroundWindowRecorder, checkBackgroundWindowOwnership } from "./background-window-fixture.mjs";

const clone = value => structuredClone(value);
const window = (id, focused = false) => ({ id, type: "normal", focused, state: "normal" });
const tab = (id, windowId, active = false, groupId = -1) => ({ id, windowId, active, groupId, pinned: false, url: "about:blank", status: "complete" });
const baseline = { tabs: [tab(1, 10, true)], windows: [window(10, true)], targets: [] };
const created = { tabs: [...baseline.tabs, tab(2, 20, true)], windows: [...baseline.windows, window(20)], targets: [] };
function focus(events = []) { return { identity: "unit-observer", ready: true, overflow: false, at: Date.now(), events: clone(events) }; }

test("background creation needs a new normal unfocused window, sole active tab, and untouched original tabs/windows", () => {
  assert.deepEqual(checkBackgroundWindowCreated(baseline, created, 2), { tabId: 2, windowId: 20 });
  for (const mutation of [
    state => { state.tabs[1].windowId = 10; }, state => { state.windows[1].focused = true; },
    state => { state.windows[1].type = "popup"; }, state => { state.tabs[1].active = false; },
    state => { state.tabs[1].groupId = 8; }, state => { state.tabs.push(tab(3, 20)); },
    state => { state.tabs[0].url = "http://changed/"; }, state => { state.windows[0].focused = false; }
  ]) { const state = clone(created); mutation(state); assert.throws(() => checkBackgroundWindowCreated(baseline, state, 2)); }
});

test("cleanup cannot pass with retained tab, window or native attachment", () => {
  checkBackgroundWindowCleanup(baseline, [{ tabId: 2, windowId: 20 }]);
  for (const state of [created, { ...baseline, windows: created.windows }, { ...baseline, targets: [{ tabId: 2, attached: true }] }])
    assert.throws(() => checkBackgroundWindowCleanup(state, [{ tabId: 2, windowId: 20 }]));
});

test("successor allowance requires exact removed active agent, sole retained formerly inactive user page and zero focus events", () => {
  const before = { ...created, tabs: [...created.tabs, tab(3, 20)] }, after = { ...created, tabs: [baseline.tabs[0], tab(3, 20, true)] };
  const f = focus(), event = { kind: "activation", value: { tabId: 3, windowId: 20 }, sequence: 0, at: f.at };
  const args = { before, after, focusBefore: f, focusAfter: focus([event]), agentTabId: 2, extraTabId: 3, windowId: 20 };
  const [allowance] = checkBackgroundWindowSuccessor(args); assert.equal(allowance.closedAgentTabId, 2); assert.match(allowance.reason, /naturally activated/);
  assert.deepEqual(checkBackgroundWindowSuccessor({ ...args, focusAfter: focus() }), []);
  for (const events of [[event, { ...event, sequence: 1 }], [{ ...event, kind: "focus", value: 20 }], [{ ...event, value: { tabId: 4, windowId: 20 } }]])
    assert.throws(() => checkBackgroundWindowSuccessor({ ...args, focusAfter: focus(events) }));
  for (const mutation of [
    value => { value.before.tabs[2].active = true; }, value => { value.after.tabs.push(tab(2, 20)); },
    value => { value.after.windows[1].focused = true; }, value => { value.after.tabs[1].url = "http://replaced/"; }
  ]) { const bad = clone(args); mutation(bad); assert.throws(() => checkBackgroundWindowSuccessor(bad)); }
});

function environment(options = {}) {
  let state = clone(baseline), nextId = 2, now = 0;
  const events = [], owned = new Set(), log = [], allowedActivations = [], allowedFocus = [], focusLedger = new FocusLedger();
  const append = value => events.push({ sequence: events.length, at: Date.now(), kind: "activation", value });
  const readNative = async () => { now++; return clone({ ...state, requestedAt: now, completedAt: now }); };
  const readFocus = async () => focus(events);
  const browser = {
    client: { sessionId: "owner", turnId: "original", controlEpoch: 3,
      getInfo: async () => ({ metadata: { backgroundWindowVersion: 1 } }),
      getTabs: async () => clone(state.tabs.filter(tab => owned.has(tab.id))),
      beginTurn: async () => { browser.client.turnId = "fresh"; browser.client.controlEpoch++; },
      finalizeTabs: async keep => {
        log.push({ method: "finalize", keep });
        if (options.finalizeError) throw options.finalizeError;
        if (!options.retainOwned) state.tabs = state.tabs.filter(tab => !owned.has(tab.id));
        for (const win of state.windows) {
          const tabs = state.tabs.filter(tab => tab.windowId === win.id);
          if (tabs.length === 1 && !tabs[0].active) { tabs[0].active = true; append({ tabId: tabs[0].id, windowId: win.id }); }
        }
        state.windows = state.windows.filter(window => state.tabs.some(tab => tab.windowId === window.id)); owned.clear(); return {};
      }
    },
    newTab: async opts => {
      log.push({ method: "newTab", opts }); const id = nextId++, background = opts?.backgroundWindow === true;
      const windowId = background ? 20 : 10; if (background) { state.windows.push(window(20)); append({ tabId: id, windowId }); }
      state.tabs.push(tab(id, windowId, background, background ? -1 : 7)); owned.add(id); return { id };
    },
    cdp: { navigate: async (id, url) => { log.push({ method: "navigate", id, url }); if (options.navigateError) throw options.navigateError; state.tabs.find(tab => tab.id === id).url = url; return {}; } }
  };
  const common = { browser, readNative, readFocus, focusLedger, allowedActivations, allowedFocus };
  return { ...common, fixtureURL: "http://127.0.0.1:1234/", recorder: createBackgroundWindowRecorder(common),
    until: async (read, label) => { if (!await read()) throw new Error(`not ready: ${label}`); },
    createExtra: async ({ windowId, url, active }) => { assert.equal(active, false); const extra = { ...tab(nextId++, windowId), url }; state.tabs.push(extra); log.push({ method: "extra", id: extra.id }); return clone(extra); },
    removeExtra: async ({ tabId, windowId }) => { log.push({ method: "removeExtra", tabId, windowId }); const extra = state.tabs.find(tab => tab.id === tabId); assert.equal(extra.windowId, windowId); state.tabs = state.tabs.filter(tab => tab.id !== tabId); state.windows = state.windows.filter(window => state.tabs.some(tab => tab.windowId === window.id)); },
    log, get state() { return clone(state); }
  };
}

test("recorder invokes only the public create option and ties exact creation events to native returned identities", async () => {
  const env = environment(), created = await env.recorder.createTab();
  assert.equal(created.id, 2); assert.deepEqual(env.log, [{ method: "newTab", opts: { backgroundWindow: true } }]);
  assert.equal(env.allowedActivations.length, 1); assert.equal(env.recorder.records[0].windowId, 20);
  assert.deepEqual(env.allowedFocus, []);
});

test("mixed session keeps ordinary group before/after background creation; finalize preserves extra user tab then exact fixture cleanup", async () => {
  const env = environment(), detail = await checkBackgroundWindowOwnership(env);
  assert.equal(detail.passed, true); assert.equal(detail.ownerTabs.length, 3); assert.deepEqual(detail.ownerTabsAfterFinalize, []);
  assert.equal(detail.afterFinalize.tabs.length, 2); assert.equal(detail.cleanup.extraRemoved, true);
  assert.equal(env.allowedActivations.length, 2); assert.equal(detail.successorAllowances.length, 1); assert.deepEqual(env.allowedFocus, []);
  assert.equal(env.log.filter(x => x.method === "finalize").length, 1); assert.equal(env.log.filter(x => x.method === "removeExtra").length, 1);
  assert.deepEqual(env.state, baseline);
});

test("unknown finalize ACK is never replayed and cleanup failure cannot replace original error", async () => {
  const original = new Error("uncertain finalize"), env = environment({ finalizeError: original });
  await assert.rejects(checkBackgroundWindowOwnership(env), error => { assert.equal(error, original); assert.equal(error.backgroundWindowDetail.passed, false); assert.ok(error.backgroundWindowDetail.cleanup.observationError); return true; });
  assert.equal(env.log.filter(x => x.method === "finalize").length, 1);
  assert.equal(env.log.filter(x => x.method === "removeExtra").length, 1);
});

test("failure before background creation finalizes only owned work and preserves original business error", async () => {
  const original = new Error("original navigation failed"), env = environment({ navigateError: original });
  await assert.rejects(checkBackgroundWindowOwnership(env), error => { assert.equal(error, original); return true; });
  assert.equal(env.log.filter(x => x.method === "finalize").length, 1);
  assert.equal(env.log.filter(x => x.method === "removeExtra").length, 0); assert.deepEqual(env.state, baseline);
});

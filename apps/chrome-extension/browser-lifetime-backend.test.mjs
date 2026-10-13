import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import vm from "./test-support/backend-vm.mjs";

const input = (await readFile(new URL("./browser-input-adapter.js", import.meta.url), "utf8")).replace(/^export /gm, "");
const source = (await readFile(new URL("./background.js", import.meta.url), "utf8"))
  .replace('import { createBrowserActionEngine } from "./browser-runtime.js";', "")
  .replace('import { NativeInputTracker } from "./browser-input-adapter.js";', input);
const code = source.slice(0, source.indexOf("chrome.runtime.onInstalled.addListener"));
const unavailable = /OBU_AUXILIARY_|not part of browser session|already part of browser session|closed|No tab|No window|cancel|ended|STALE_CONTROL_EPOCH|AUTOMATION_PAUSED/i;
const clone = value => structuredClone(value);
const tick = () => new Promise(resolve => setTimeout(resolve, 0));
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
const event = () => {
  const listeners = new Set();
  return { addListener: fn => listeners.add(fn), removeListener: fn => listeners.delete(fn), clear: () => listeners.clear(), emit: (...args) => { for (const listener of listeners) listener(...args); } };
};
async function until(check, label) {
  for (let attempt = 0; attempt < 100; attempt++) { if (check()) return; await tick(); }
  throw new Error(`Fixture did not reach ${label}`);
}

async function holdInput(f) {
  await f.backend.attach(f.params);
  for (const [method, commandParams] of [
    ["Input.dispatchMouseEvent", { type: "mousePressed", button: "left", x: 10, y: 20 }],
    ["Input.dispatchKeyEvent", { type: "keyDown", key: "Shift", code: "ShiftLeft" }]
  ]) await f.backend.executeCdp({ ...f.params, target: { tabId: 7 }, method, commandParams });
}

const STATE = "OPEN_BROWSER_USE_SESSION_STATE", CONTROL = "OPEN_BROWSER_USE_CONTROL_STATE";
const LIFE = "OPEN_BROWSER_USE_BROWSER_LIFETIME", RISKS = "OPEN_BROWSER_USE_INPUT_RISKS";
const mutations = calls => calls.filter(([name]) => ["attach", "attach-start", "detach", "group", "group-update", "ungroup", "remove"].includes(name));

test("unbound legacy IDs cannot authorize, rename, detach or dispose replacement browser tabs", async t => {
  const f = await fixture(t, { initialize: false, localSeed: {
    [STATE]: { sessions: { task: { chromeGroupId: 10, activeTabId: 7, title: "old", tabOrigins: { 7: "agent" } } }, deliverableGroupId: 20 },
    [CONTROL]: { version: 1, counter: 4, records: [["task", { epoch: 4, status: "idle", legacyTurns: [] }]] }
  } });
  const state = await f.backend.store.getSession("task");
  assert.equal(state.chromeGroupId, null); assert.equal(state.activeTabId, null);
  assert.deepEqual(clone(state.tabOrigins), {}); assert.equal(f.backend.store.state.deliverableGroupId, null);
  assert.deepEqual(mutations(f.calls), []);
  const fresh = await f.backend.getControlState({ session_id: "task" });
  assert.ok(fresh.controlEpoch > 4);
  await assert.rejects(f.backend.attach({ session_id: "task", turn_id: "old", control_epoch: 4, tabId: 7 }), /STALE_CONTROL_EPOCH/);
  await assert.rejects(f.backend.attach({ session_id: "task", turn_id: fresh.nextTurnId, control_epoch: fresh.controlEpoch, tabId: 7 }), /not part/);
  assert.deepEqual(mutations(f.calls), []);
});

test("worker restart retains browser bindings; loss of incarnation invalidates even idle epochs", async t => {
  const f = await fixture(t), prior = f.backend.browserLifetime.incarnation;
  const old = await f.backend.getControlState({ session_id: "task" });
  for (const e of f.events) e.clear();
  const worker = new f.Backend(); await worker.controlReady;
  assert.equal(worker.store.state.sessions.task.chromeGroupId, 10);
  assert.equal(worker.browserLifetime.incarnation, prior);
  delete f.session[LIFE]; for (const e of f.events) e.clear();
  const changed = new f.Backend(); await changed.controlReady;
  assert.notEqual(changed.browserLifetime.incarnation, prior);
  assert.equal(changed.store.state.sessions.task.chromeGroupId, null);
  const current = await changed.getControlState({ session_id: "task" });
  assert.ok(current.controlEpoch > old.controlEpoch);
  assert.deepEqual(mutations(f.calls), []);
});

test("lost running held input blocks replacement worker instead of empty-tracker detach success", async t => {
  const f = await fixture(t); await holdInput(f);
  assert.equal(f.local[RISKS].risks.length, 1);
  for (const e of f.events) e.clear();
  const before = f.calls.length, worker = new f.Backend(); await worker.controlReady;
  assert.equal(worker.inputTracker.attachments.size, 0);
  assert.equal(worker.automationControl.inputBlocked, true);
  assert.match(worker.automationControl.error, /INPUT_RELEASE_UNCONFIRMED/);
  assert.deepEqual(clone((await worker.getAutomationControlStatus()).inputRecovery), { action: "close-controlled-pages" });
  assert.deepEqual(mutations(f.calls.slice(before)), []);
  await assert.rejects(worker.pauseAutomation(), /INPUT_RELEASE_UNCONFIRMED/);
  await f.chrome.tabs.remove(7); await worker.browserLifetime.writes;
  await worker.pauseAutomation();
  assert.equal(worker.automationControl.cleanupComplete, true);
  assert.deepEqual(f.local[RISKS].risks, []);
});

test("reload recovery status remains blocked after old-tab removal, then drops restart advice after positive startup proof", async t => {
  const f = await fixture(t); await f.backend.browserLifetime.observeStartup(); await holdInput(f);
  const savedRisk = clone(f.local[RISKS].risks);
  for (const e of f.events) e.clear(); delete f.session[LIFE];
  const worker = new f.Backend(); await worker.controlReady;
  let status = await worker.getAutomationControlStatus();
  assert.equal(status.state, "error"); assert.equal(status.inputBlocked, true);
  assert.deepEqual(clone(status.inputRecovery), { action: "restart-browser", restartMayNeedRepeat: false });
  await f.chrome.tabs.remove(7); await worker.browserLifetime.writes;
  await assert.rejects(worker.pauseAutomation(), /INPUT_RELEASE_UNCONFIRMED/);
  assert.deepEqual(f.local[RISKS].risks, savedRisk);
  assert.equal((await worker.getAutomationControlStatus()).inputRecovery.action, "restart-browser");
  // A deterministic native-event fixture, not a claim of a real browser restart.
  await worker.browserLifetime.observeStartup();
  assert.deepEqual(f.local[RISKS].risks, []);
  status = await worker.getAutomationControlStatus();
  assert.equal(status.state, "error"); assert.equal(status.inputBlocked, true);
  assert.match(status.error, /INPUT_RELEASE_UNCONFIRMED/);
  assert.equal(Object.hasOwn(status, "inputRecovery"), false, "stale failure text must not keep prescribing restarts");
  await worker.pauseAutomation();
  status = await worker.getAutomationControlStatus();
  assert.equal(status.state, "paused"); assert.equal(status.cleanupComplete, true);
  assert.equal(status.inputBlocked, true, "successful recovery still requires explicit Resume");
});

test("tab-list absence after worker downtime cannot prove original target destruction", async t => {
  const f = await fixture(t); await holdInput(f);
  for (const e of f.events) e.clear(); f.tabs.delete(7); f.attached.delete(7);
  const worker = new f.Backend(); await worker.controlReady;
  assert.equal(worker.automationControl.inputBlocked, true);
  assert.equal(f.local[RISKS].risks.length, 1);
});

for (const change of ["pause", "ungroup", "end"]) test(`${change} during durable input intent prevents the upcoming native input`, async t => {
  const f = await fixture(t); await f.backend.attach(f.params);
  const gate = f.gate(); let storing = false;
  f.hooks.write = async (area, values) => { if (area === "local" && values[RISKS]?.risks.length) { storing = true; await gate.promise; } };
  const sending = f.backend.executeCdp({ ...f.params, target: { tabId: 7 }, method: "Input.dispatchMouseEvent", commandParams: { type: "mousePressed", button: "left", x: 10, y: 20 } });
  const outcome = sending.then(() => null, error => error);
  await until(() => storing, "durable input intent");
  let cleanup;
  if (change === "pause") cleanup = f.backend.pauseAutomation();
  else if (change === "end") cleanup = f.backend.turnEnded(f.params);
  else { f.tabs.get(7).groupId = -1; f.chrome.tabs.onUpdated.emit(7, { groupId: -1 }); cleanup = f.backend.controlReleases.get(7); }
  cleanup?.catch(() => {});
  if (change === "end") await until(() => f.backend.controlLedger.records.get("task").status === "closing", "retired input owner epoch");
  gate.resolve();
  assert.ok(await outcome);
  await cleanup;
  assert.equal(f.calls.some(([method, , value]) => method === "Input.dispatchMouseEvent" && value.type === "mousePressed"), false);
});

test("durable mark failure blocks automation and never dispatches native input", async t => {
  const f = await fixture(t); await f.backend.attach(f.params);
  f.hooks.write = async (area, values) => { if (area === "local" && values[RISKS]) throw new Error("fixture journal failure"); };
  await assert.rejects(f.backend.executeCdp({ ...f.params, target: { tabId: 7 }, method: "Input.dispatchMouseEvent", commandParams: { type: "mousePressed", button: "left", x: 10, y: 20 } }), /journal failure/);
  assert.equal(f.backend.automationControl.inputBlocked, true);
  assert.equal(f.calls.some(([method, , value]) => method === "Input.dispatchMouseEvent" && value.type === "mousePressed"), false);
});

test("a later profile witness retires prior witnessed input without touching reused tab IDs or resuming", async t => {
  const f = await fixture(t); await f.backend.browserLifetime.observeStartup(); await holdInput(f);
  assert.ok(f.local[RISKS].risks[0].startupWitness);
  for (const e of f.events) e.clear();
  delete f.session[LIFE];
  const before = f.calls.length, next = new f.Backend(); await next.controlReady;
  assert.equal(next.automationControl.inputBlocked, true);
  assert.equal(next.store.state.sessions.task.chromeGroupId, null);
  await next.browserLifetime.observeStartup();
  assert.deepEqual(f.local[RISKS].risks, []);
  assert.equal(next.automationControl.inputBlocked, true);
  await next.pauseAutomation();
  assert.equal(next.automationControl.state, "paused");
  assert.deepEqual(mutations(f.calls.slice(before)), []);
});

test("raw caller timeout during durable intent cannot submit the native input later", async t => {
  const f = await fixture(t); await f.backend.attach(f.params);
  const gate = f.gate(); let storing = false;
  f.hooks.write = async (area, values) => { if (area === "local" && values[RISKS]?.risks.length) { storing = true; await gate.promise; } };
  const sending = f.backend.executeCdp({ ...f.params, timeoutMs: 25, target: { tabId: 7 }, method: "Input.dispatchKeyEvent", commandParams: { type: "keyDown", key: "Shift", code: "ShiftLeft" } });
  await until(() => storing, "durability pending");
  await assert.rejects(sending, /timed out/i);
  gate.resolve(); await Promise.allSettled(f.backend.inputTracker.controlSnapshot().pending);
  assert.equal(f.calls.some(([method, , value]) => method === "Input.dispatchKeyEvent" && value.type === "keyDown"), false);
});

test("restricted frame proof is rechecked after durable input intent before native send", async t => {
  const f = await fixture(t); await f.backend.attach(f.params); await f.backend.getBrowserEngine();
  f.backend.siteAccess = { restricted: true, assertReady() {} };
  let navigation = 0;
  f.backend.assertSiteTab = async () => ({ navigation });
  f.backend.assertSiteProof = proof => { if (proof.navigation !== navigation) throw new Error("OBU_SITE_ACCESS_DENIED: document changed"); };
  const gate = f.gate(); let storing = false, sends = 0;
  f.hooks.write = async (area, values) => { if (area === "local" && values[RISKS]?.risks.length) { storing = true; await gate.promise; } };
  const sending = f.engineOptions.inputHooks.send({ tabId: 7 }, "Input.dispatchMouseEvent", { type: "mousePressed", button: "left", x: 10, y: 20 }, async () => sends++);
  const rejected = assert.rejects(sending, /SITE_ACCESS_DENIED/);
  await until(() => storing, "durability pending after proof");
  navigation++; gate.resolve(); await rejected;
  assert.equal(sends, 0);
});

async function pointerHookFixture(t) {
  const f = await fixture(t);
  await f.backend.attach(f.params);
  await f.backend.getBrowserEngine();
  const target = { tabId: 7 }, params = { type: "mouseMoved", button: "none", buttons: 0, x: 10, y: 20 };
  return { ...f, pointerHooks: f.engineOptions.inputHooks, target, move: params,
    sendMove: ticket => f.engineOptions.inputHooks.send(target, "Input.dispatchMouseEvent", params,
      () => f.chrome.debugger.sendCommand(target, "Input.dispatchMouseEvent", params), ticket) };
}

test("backend keyboard admission captures original action authority and permits confirmed held Control", async t => {
  const f = await pointerHookFixture(t); let expired = false, captures = 0;
  const original = new Error("original keyboard action ended");
  f.backend.browserEngine.captureKeyboardPress = tabId => {
    assert.equal(tabId, 7); captures++;
    return () => { if (expired) throw original; };
  };
  await f.pointerHooks.send(f.target, "Input.dispatchKeyEvent", { type: "rawKeyDown", key: "Control", code: "ControlLeft" }, async () => ({}));
  const ticket = f.pointerHooks.beginKeyboardPress(f.target, () => {});
  assert.equal(captures, 1); ticket.check();
  f.backend.browserEngine.captureKeyboardPress = () => () => {};
  const params = { type: "rawKeyDown", key: "a", code: "KeyA", modifiers: 2 };
  await f.pointerHooks.send(f.target, "Input.dispatchKeyEvent", params,
    () => f.chrome.debugger.sendCommand(f.target, "Input.dispatchKeyEvent", params), ticket);
  expired = true;
  assert.throws(() => ticket.check(), error => error === original);
  assert.throws(() => f.pointerHooks.send(f.target, "Input.dispatchKeyEvent", params, () => assert.fail("old action cannot send"), ticket), error => error === original);
  ticket.close();
  assert.equal(f.calls.filter(([method]) => method === "Input.dispatchKeyEvent").length, 1);
});

test("backend keyboard preserves original engine deadline through durable storage before native dispatch", async t => {
  const f = await pointerHookFixture(t), gate = f.gate(); let expired = false, storing = false;
  const original = new Error("original engine keyboard deadline");
  f.backend.browserEngine.captureKeyboardPress = () => () => { if (expired) throw original; };
  const ticket = f.pointerHooks.beginKeyboardPress(f.target, () => {});
  f.hooks.write = async (area, values) => { if (area === "local" && values[RISKS]?.risks.length) { storing = true; await gate.promise; } };
  try {
    const params = { type: "rawKeyDown", key: "Control", code: "ControlLeft" };
    const sending = f.pointerHooks.send(f.target, "Input.dispatchKeyEvent", params,
      () => f.chrome.debugger.sendCommand(f.target, "Input.dispatchKeyEvent", params), ticket);
    const rejected = assert.rejects(sending, error => error === original);
    await until(() => storing, "keyboard durable intent"); expired = true; gate.resolve(); await rejected;
    assert.equal(f.calls.some(([method]) => method === "Input.dispatchKeyEvent"), false);
  } finally { gate.resolve(); ticket.close(); }
});

test("backend keyboard rejects absent action admission and later Pause before native input", async t => {
  const f = await pointerHookFixture(t);
  f.backend.browserEngine.captureKeyboardPress = () => { throw new Error("OBU_KEYBOARD_PRESS_REJECTED: no action"); };
  assert.throws(() => f.pointerHooks.beginKeyboardPress(f.target, () => {}), /OBU_KEYBOARD_PRESS_REJECTED/);
  f.backend.browserEngine.captureKeyboardPress = () => () => {};
  const ticket = f.pointerHooks.beginKeyboardPress(f.target, () => {});
  f.backend.automationControl.block();
  assert.throws(() => ticket.check(), /AUTOMATION_PAUSED/);
  assert.throws(() => f.pointerHooks.send(f.target, "Input.dispatchKeyEvent", { type: "rawKeyDown", key: "a", code: "KeyA" }, () => assert.fail("paused native key"), ticket), /AUTOMATION_PAUSED/);
  ticket.close();
});

test("backend fill rejects pre-held Control, then forwards an idle ticket through original native input", async t => {
  const f = await pointerHookFixture(t);
  const key = type => f.pointerHooks.send(f.target, "Input.dispatchKeyEvent", { type, key: "Control", code: "ControlLeft" }, async () => ({}));
  await key("rawKeyDown");
  assert.throws(() => f.pointerHooks.beginFillAction(f.target, () => {}), /OBU_FILL_ACTION_BUSY/);
  await key("keyUp");
  const ticket = f.pointerHooks.beginFillAction(f.target, () => {});
  const params = { text: "one fill" };
  try {
    await f.pointerHooks.send(f.target, "Input.insertText", params,
      () => f.chrome.debugger.sendCommand(f.target, "Input.insertText", params), ticket);
    ticket.check();
    assert.equal(f.calls.filter(([method]) => method === "Input.insertText").length, 1);
    await f.backend.executeCdp({ ...f.params, target: f.target, method: "Input.insertText", commandParams: { text: "foreign" } });
    assert.throws(() => ticket.check(), /POINTER_ACTION_INVALIDATED/);
  } finally { ticket.close(); }
});

test("backend fill refuses expired admission and observes Pause before any new native input", async t => {
  const f = await pointerHookFixture(t), expired = Object.freeze(new Error("original fill deadline"));
  assert.throws(() => f.pointerHooks.beginFillAction(f.target, () => { throw expired; }), error => error === expired);
  const ticket = f.pointerHooks.beginFillAction(f.target, () => {});
  try {
    f.backend.automationControl.block();
    assert.throws(() => ticket.check(), /AUTOMATION_PAUSED/);
    assert.throws(() => f.pointerHooks.beginFillAction(f.target, () => {}), /AUTOMATION_PAUSED/);
    assert.throws(() => f.pointerHooks.send(f.target, "Input.insertText", { text: "late" }, () => assert.fail("late native input"), ticket), /AUTOMATION_PAUSED/);
  } finally { ticket.close(); }
});

test("backend fill cannot send after a durable journal ACK crosses its original deadline", async t => {
  const f = await pointerHookFixture(t), gate = f.gate(), original = Object.freeze(new Error("original fill expired"));
  let expired = false, storing = false;
  const ticket = f.pointerHooks.beginFillAction(f.target, () => { if (expired) throw original; });
  f.hooks.write = async (area, values) => {
    if (area === "local" && values[RISKS]?.risks.length) { storing = true; await gate.promise; }
  };
  try {
    const params = { text: "late text" };
    const sending = f.pointerHooks.send(f.target, "Input.insertText", params,
      () => f.chrome.debugger.sendCommand(f.target, "Input.insertText", params), ticket);
    const rejected = assert.rejects(sending, error => error === original);
    await until(() => storing, "fill durable intent"); expired = true; gate.resolve(); await rejected;
    assert.equal(f.calls.some(([method]) => method === "Input.insertText"), false);
  } finally { ticket.close(); }
});

test("backend hover admission preserves confirmed pre-held keys and forwards an idle ticket", async t => {
  const f = await pointerHookFixture(t);
  const key = type => f.pointerHooks.send(f.target, "Input.dispatchKeyEvent", { type, key: "Shift", code: "ShiftLeft" }, async () => ({}));
  await key("rawKeyDown");
  assert.equal(f.pointerHooks.beginHoverAction(f.target, () => {}), null);
  await key("keyUp");
  const ticket = f.pointerHooks.beginHoverAction(f.target, () => {});
  try {
    await f.sendMove(ticket); ticket.check();
    assert.throws(() => f.pointerHooks.beginHoverAction(f.target, () => {}), /POINTER_ACTION_BUSY/);
  } finally { ticket.close(); }
});

test("backend hover pre-held compatibility still checks the original deadline and Pause", async t => {
  const f = await pointerHookFixture(t), expired = Object.freeze(new Error("original hover deadline"));
  await f.pointerHooks.send(f.target, "Input.dispatchKeyEvent", { type: "rawKeyDown", key: "Shift", code: "ShiftLeft" }, async () => ({}));
  assert.throws(() => f.pointerHooks.beginHoverAction(f.target, () => { throw expired; }), error => error === expired);
  f.backend.automationControl.block();
  assert.throws(() => f.pointerHooks.beginHoverAction(f.target, () => {}), /AUTOMATION_PAUSED/);
});

test("backend hover refuses a rejected native move even after a later acknowledged move", async t => {
  const f = await pointerHookFixture(t), failed = new Error("unknown native hover movement");
  await assert.rejects(f.pointerHooks.send(f.target, "Input.dispatchMouseEvent", f.move, async () => { throw failed; }), error => error === failed);
  await f.sendMove();
  assert.throws(() => f.pointerHooks.beginHoverAction(f.target, () => {}), /POINTER_ACTION_BUSY/);
});

test("pointer progress expiring behind the transfer gate prevents native input before any journal intent", async t => {
  const f = await pointerHookFixture(t), gate = f.gate();
  const originalError = Object.freeze(new Error("original pointer deadline expired"));
  let expired = false, entered = false;
  const ticket = f.pointerHooks.beginPointerAction(f.target, () => { if (expired) throw originalError; });
  f.backend.fileChooserWaitersByTabId.set(7, {});
  const originalWait = f.backend.waitForTransferTargets;
  f.backend.waitForTransferTargets = async tabId => { assert.equal(tabId, 7); entered = true; await gate.promise; };
  try {
    const sending = f.sendMove(ticket), rejected = assert.rejects(sending, error => error === originalError);
    await until(() => entered, "pointer transfer gate");
    expired = true;
    gate.resolve();
    await rejected;
    assert.equal(f.calls.some(([method]) => method.startsWith("Input.")), false);
    assert.equal(f.backend.inputTracker.attachments.get(7).states.size, 0, "the expired ticket fails before input intent");
  } finally {
    ticket.close();
    f.backend.fileChooserWaitersByTabId.delete(7);
    f.backend.waitForTransferTargets = originalWait;
  }
});

test("pointer progress expiring during real durable input persistence prevents the original native send", async t => {
  const f = await pointerHookFixture(t), gate = f.gate();
  const originalError = Object.freeze(new Error("original pointer progress aborted"));
  let expired = false, storing = false;
  const ticket = f.pointerHooks.beginPointerAction(f.target, () => { if (expired) throw originalError; });
  f.hooks.write = async (area, values) => {
    if (area === "local" && values[RISKS]?.risks.length) { storing = true; await gate.promise; }
  };
  try {
    const sending = f.sendMove(ticket), rejected = assert.rejects(sending, error => error === originalError);
    await until(() => storing, "guarded durable input intent");
    assert.equal(f.calls.some(([method]) => method.startsWith("Input.")), false);
    expired = true;
    gate.resolve();
    await rejected;
    assert.equal(f.calls.some(([method]) => method.startsWith("Input.")), false);
  } finally { ticket.close(); }
});

test("backend forwards a live pointer ticket and a foreign executeCdp input invalidates it without replay", async t => {
  const f = await pointerHookFixture(t);
  const ticket = f.pointerHooks.beginPointerAction(f.target, () => {});
  try {
    await f.sendMove(ticket);
    ticket.check(); // Fails if background.send accidentally drops the private ticket.
    await f.backend.executeCdp({ ...f.params, target: f.target, method: "Input.insertText", commandParams: { text: "foreign raw input" } });
    assert.throws(() => ticket.check(), /POINTER_ACTION_INVALIDATED/);
    const down = { ...f.move, type: "mousePressed", button: "left", buttons: 1 };
    assert.throws(() => f.pointerHooks.send(f.target, "Input.dispatchMouseEvent", down,
      () => f.chrome.debugger.sendCommand(f.target, "Input.dispatchMouseEvent", down), ticket), /POINTER_ACTION_INVALIDATED/);
    assert.deepEqual(f.calls.filter(([method]) => method.startsWith("Input.")).map(([method, , params]) => [method, params.type ?? params.text]), [
      ["Input.dispatchMouseEvent", "mouseMoved"], ["Input.insertText", "foreign raw input"]
    ]);
    assert.equal(f.backend.inputTracker.hasHeld(f.backend.inputTracker.attachments.get(7)), false);
  } finally { ticket.close(); }
});

test("restricted pointer ticket survives its own input but rejects a stale site proof after the journal", async t => {
  const f = await pointerHookFixture(t);
  f.backend.siteAccess = { restricted: true, assertReady() {} };
  let navigation = 0;
  const denied = Object.freeze(new Error("OBU_SITE_ACCESS_DENIED: original document changed"));
  f.backend.assertSiteTab = async () => ({ navigation });
  f.backend.assertSiteProof = proof => { if (proof.navigation !== navigation) throw denied; };
  const ticket = f.pointerHooks.beginPointerAction(f.target, () => {});
  try {
    await f.sendMove(ticket);
    ticket.check(); // Covers forwarding through the restricted proof branch too.
    const before = f.calls.length, gate = f.gate();
    let storing = false;
    f.hooks.write = async (area, values) => {
      if (area === "local" && values[RISKS]?.risks.length) { storing = true; await gate.promise; }
    };
    const sending = f.sendMove(ticket), rejected = assert.rejects(sending, error => error === denied);
    await until(() => storing, "guarded restricted proof journal");
    navigation++;
    gate.resolve();
    await rejected;
    assert.equal(f.calls.slice(before).some(([method]) => method.startsWith("Input.")), false);
  } finally { ticket.close(); }
});

test("backend pointer ticket observes Pause synchronously before later native input", async t => {
  const f = await pointerHookFixture(t), ticket = f.pointerHooks.beginPointerAction(f.target, () => {});
  try {
    f.backend.automationControl.block();
    assert.throws(() => ticket.check(), /AUTOMATION_PAUSED/);
    assert.throws(() => f.sendMove(ticket), /AUTOMATION_PAUSED/);
    assert.equal(f.calls.some(([method]) => method.startsWith("Input.")), false);
  } finally { ticket.close(); }
});

test("detach waiting on actual resource cleanup rejects an input whose durable intent settles later", async t => {
  const f = await fixture(t); await f.backend.attach(f.params);
  const storage = f.gate(), resource = f.gate(); let storing = false;
  f.hooks.write = async (area, values) => { if (area === "local" && values[RISKS]?.risks.length) { storing = true; await storage.promise; } };
  const sending = f.backend.executeCdp({ ...f.params, target: { tabId: 7 }, method: "Input.dispatchKeyEvent", commandParams: { type: "keyDown", key: "Shift", code: "ShiftLeft" } });
  const rejected = assert.rejects(sending, /RELEASE_IN_PROGRESS|CONTROL_REVOKED/);
  await until(() => storing, "durable intent entry");
  f.backend.clipboardBroker.waitForTab = () => resource.promise;
  const releasing = f.backend.detachTab(7);
  storage.resolve(); await rejected;
  assert.equal(f.calls.some(([method, , value]) => method === "Input.dispatchKeyEvent" && value.type === "keyDown"), false);
  assert.equal(f.attached.has(7), true);
  resource.resolve(); await releasing;
});

// Models the pinned native debugger contract: only this extension's exact
// target client can answer sendCommand or be detached. Foreign clients remain.
function installNativeOwnership(f) {
  const foreign = new Set(), detached = [], probed = [];
  f.chrome.debugger.attach = async ({ tabId }) => {
    if (f.attached.has(tabId)) throw new Error("Another debugger is already attached");
    if (foreign.has(tabId)) throw new Error("Cannot attach to this target");
    f.attached.add(tabId); f.calls.push(["attach", tabId]);
  };
  f.chrome.debugger.sendCommand = async (target, method, params) => {
    f.calls.push([method, target.tabId, clone(params)]);
    if (!f.attached.has(target.tabId)) throw new Error("Debugger is not attached by this extension");
    await f.hooks.command?.(target, method, params);
    if (method === "Target.getTargetInfo") {
      probed.push(target.tabId);
      return { targetInfo: { targetId: `native-page-${target.tabId}`, type: "page" } };
    }
    return {};
  };
  f.chrome.debugger.detach = async target => {
    const tabId = target.tabId ?? Number(target.targetId?.replace("native-page-", ""));
    if (!f.attached.has(tabId)) throw new Error("Debugger is not attached by this extension");
    await f.hooks.detach?.(tabId);
    f.attached.delete(tabId); detached.push(clone(target)); f.calls.push(["detach", tabId]);
  };
  return { foreign, detached, probed };
}

async function replaceWorkerWithoutMarker(f) {
  for (const e of f.events) e.clear();
  delete f.session[LIFE];
  const worker = new f.Backend(); await worker.controlReady;
  return worker;
}

test("explicit claim resets only the surviving own orphan before fresh attachment", async t => {
  const f = await fixture(t), native = installNativeOwnership(f);
  await f.backend.attach(f.params);
  const worker = await replaceWorkerWithoutMarker(f);
  const current = await worker.getControlState({ session_id: "task" }), params = f.fresh(f.params, current);
  assert.equal(worker.attachedTabs.size, 0); assert.equal(f.attached.has(7), true);
  await assert.rejects(worker.attach(params), /not part/);
  assert.deepEqual(native.detached, []); assert.deepEqual(native.probed, []);
  await worker.claimUserTab(params);
  assert.deepEqual(native.detached, [{ targetId: "native-page-7" }]);
  assert.equal(f.attached.has(7), false);
  await worker.attach(params);
  assert.equal(f.attached.has(7), true); assert.equal(worker.attachedTabs.has(7), true);
  assert.equal(f.calls.some(([method]) => method.startsWith("Input.")), false);
});

test("cold explicit claim never resets a foreign debugger or treats its probe failure as ownership", async t => {
  const f = await fixture(t), native = installNativeOwnership(f); native.foreign.add(8);
  const params = { ...f.params, tabId: 8 };
  await f.backend.claimUserTab(params);
  assert.deepEqual(native.detached, []); assert.equal(native.foreign.has(8), true);
  await assert.rejects(f.backend.attach(params), /Cannot attach/);
  assert.equal(native.foreign.has(8), true);
});

test("explicit claim preserves current tracked resources and rejects a foreign task before native probe", async t => {
  const f = await fixture(t), native = installNativeOwnership(f); await f.backend.attach(f.params);
  await f.backend.claimUserTab(f.params);
  assert.deepEqual(native.probed, []); assert.deepEqual(native.detached, []);
  await assert.rejects(f.backend.claimUserTab({ ...f.foreign, tabId: 7 }), /already part/);
  assert.deepEqual(native.probed, []); assert.deepEqual(native.detached, []);
});

test("recovered unknown input blocks explicit orphan reset before any native probe", async t => {
  const f = await fixture(t), native = installNativeOwnership(f); await holdInput(f);
  const worker = await replaceWorkerWithoutMarker(f);
  await assert.rejects(worker.claimUserTab(f.params), /INPUT_RELEASE_UNCONFIRMED|AUTOMATION_PAUSED/);
  assert.deepEqual(native.probed, []); assert.deepEqual(native.detached, []);
  assert.equal(f.attached.has(7), true); assert.equal(f.local[RISKS].risks.length, 1);
});

test("claim end during the own-client probe cannot later detach or acquire the tab", async t => {
  const f = await fixture(t), native = installNativeOwnership(f); f.attached.add(8);
  const gate = f.gate(); let probing = false;
  f.hooks.command = async (_target, method) => { if (method === "Target.getTargetInfo") { probing = true; await gate.promise; } };
  const params = { ...f.params, tabId: 8 };
  const claim = f.backend.claimUserTab(params); const outcome = claim.then(() => null, error => error);
  await until(() => probing, "own-client probe");
  const ending = f.backend.turnEnded(params); ending.catch(() => {});
  await until(() => f.backend.controlLedger.records.get("task").status === "closing", "claim epoch retired");
  gate.resolve(); assert.ok(await outcome); await ending;
  assert.deepEqual(native.detached, []); assert.equal(f.backend.auxiliaryTabs.owner(8), undefined);
});

test("orphan detach stays tracked and blocks native admission until its actual completion", async t => {
  const f = await fixture(t), native = installNativeOwnership(f); f.attached.add(7);
  const gate = f.gate(); let detaching = false;
  f.hooks.detach = async () => { detaching = true; await gate.promise; };
  const claim = f.backend.claimUserTab(f.params);
  await until(() => detaching, "actual orphan detach");
  const release = f.backend.controlReleases.get(7);
  assert.ok(release); assert.ok(f.backend.globalControlSnapshot().pending.includes(release));
  await assert.rejects(f.backend.executeCdp({ ...f.params, target: { tabId: 7 }, method: "Runtime.evaluate", commandParams: { expression: "do not run" } }), /TAB_CONTROL_REVOKED/);
  assert.equal(native.detached.length, 0);
  gate.resolve(); await claim;
  assert.deepEqual(native.detached, [{ targetId: "native-page-7" }]);
  assert.equal(f.backend.controlReleases.has(7), false); assert.equal(f.backend.coldAttachmentResets.size, 0);
});

test("Pause drains an actually pending orphan detach without admitting the cancelled claim", async t => {
  const f = await fixture(t), native = installNativeOwnership(f); f.attached.add(7);
  const gate = f.gate(); let detaching = false;
  f.hooks.detach = async () => { detaching = true; await gate.promise; };
  const claim = f.backend.claimUserTab(f.params), outcome = claim.then(() => null, error => error);
  await until(() => detaching, "actual orphan detach");
  let paused = false;
  const pausing = f.backend.pauseAutomation().then(value => { paused = true; return value; });
  pausing.catch(() => {});
  await until(() => f.backend.automationControl.inputBlocked, "Pause synchronous gate");
  assert.equal(paused, false); assert.equal(native.detached.length, 0);
  gate.resolve(); assert.ok(await outcome); await pausing;
  assert.equal(paused, true); assert.equal(f.backend.automationControl.cleanupComplete, true);
  assert.deepEqual(native.detached, [{ targetId: "native-page-7" }]);
});

test("timed-out repeated popup claim preserves its owner and cannot later reset the orphan", async t => {
  const f = await fixture(t, { claimTimeoutMs: 25 }), native = installNativeOwnership(f), params = { ...f.params, tabId: 8 };
  await f.backend.claimUserTab(params);
  const owner = f.backend.auxiliaryTabs.owner(8); assert.ok(owner);
  f.attached.add(8);
  const gate = f.gate(); let probing = false;
  f.hooks.command = async (_target, method) => { if (method === "Target.getTargetInfo") { probing = true; await gate.promise; } };
  const claim = f.backend.claimUserTab(params);
  await until(() => probing, "repeat claim own-client probe");
  await assert.rejects(claim, /OBU_AUXILIARY_CLAIM_TIMEOUT/);
  assert.deepEqual(native.detached, []);
  assert.equal(f.backend.auxiliaryTabs.owner(8), owner);
  gate.resolve(); await Promise.allSettled(f.backend.globalControlSnapshot().pending);
  assert.deepEqual(native.detached, []); assert.equal(f.attached.has(8), true);
  assert.equal(f.backend.auxiliaryTabs.owner(8), owner);
});

test("actual orphan detach failure is visible and does not commit auxiliary ownership", async t => {
  const f = await fixture(t), native = installNativeOwnership(f); f.attached.add(8);
  f.hooks.detach = async () => { throw new Error("fixture native reset failed"); };
  await assert.rejects(f.backend.claimUserTab({ ...f.params, tabId: 8 }), /fixture native reset failed/);
  assert.equal(f.backend.auxiliaryTabs.owner(8), undefined);
  assert.equal(f.attached.has(8), true); assert.deepEqual(native.detached, []);
});

async function fixture(t, { localSeed = {}, sessionSeed = {}, initialize = true, claimTimeoutMs } = {}) {
  const local = clone(localSeed), session = clone(sessionSeed), calls = [], attached = new Set(), hooks = {}, gates = [];
  const tabs = new Map([
    [7, { id: 7, groupId: 10, windowId: 1, url: "https://fixture.test/main", active: false }],
    [8, { id: 8, groupId: -1, windowId: 2, url: "https://fixture.test/popup", active: true }],
    [9, { id: 9, groupId: 20, windowId: 1, url: "https://fixture.test/other", active: false }]
  ]);
  const windows = new Map([[1, { id: 1, type: "normal", focused: true }], [2, { id: 2, type: "popup", focused: false }], [3, { id: 3, type: "popup", focused: false }]]);
  const groups = new Map([[10, { id: 10, windowId: 1 }], [20, { id: 20, windowId: 1 }]]);
  const requireTab = id => { const tab = tabs.get(id); if (!tab) throw new Error(`No tab with id: ${id}`); return tab; };
  const area = (name, state) => ({
    async get(key) { await hooks.read?.(name, key); return clone(Object.hasOwn(state, key) ? { [key]: state[key] } : {}); },
    async set(value) { const captured = clone(value); await hooks.write?.(name, captured); Object.assign(state, captured); calls.push([`${name}.set`, clone(captured)]); },
    async setAccessLevel(value) { calls.push([`${name}.setAccessLevel`, value]); }
  });
  const chrome = {
    storage: { local: area("local", local), session: area("session", session) },
    runtime: { onStartup: event(), onInstalled: event(), id: "fixture", getURL: path => `chrome-extension://fixture/${path}`, getManifest: () => ({ version: "test" }) },
    debugger: { onDetach: event(), onEvent: event(),
      async attach({ tabId }) { calls.push(["attach-start", tabId]); await hooks.attach?.(tabId); requireTab(tabId); attached.add(tabId); calls.push(["attach", tabId]); },
      async detach({ tabId }) { await hooks.detach?.(tabId); attached.delete(tabId); calls.push(["detach", tabId]); },
      async getTargets() { return [...tabs.values()].map(tab => ({ id: `target-${tab.id}`, tabId: tab.id, type: "page", url: tab.url, attached: attached.has(tab.id) })); },
      async sendCommand(target, method, params) { calls.push([method, target.tabId, clone(params)]); await hooks.command?.(target, method, params); return { result: { value: "fixture" } }; }
    },
    tabs: { onRemoved: event(), onUpdated: event(), onDetached: event(), onAttached: event(), onMoved: event(), onReplaced: event(),
      async get(id) { await hooks.getTab?.(id); return clone(requireTab(id)); },
      async query(filter = {}) { await hooks.query?.(filter); return [...tabs.values()].filter(tab => (filter.groupId === undefined || tab.groupId === filter.groupId) && (filter.windowId === undefined || tab.windowId === filter.windowId)).map(clone); },
      async group({ tabIds, groupId }) { calls.push(["group", [...tabIds], groupId]); groupId ??= 30; if (!groups.has(groupId)) groups.set(groupId, { id: groupId, windowId: requireTab(tabIds[0]).windowId }); for (const id of tabIds) { const tab = requireTab(id); tab.groupId = groupId; tab.windowId = groups.get(groupId).windowId; } return groupId; },
      async ungroup(ids) { calls.push(["ungroup", [].concat(ids)]); for (const id of [].concat(ids)) { requireTab(id).groupId = -1; chrome.tabs.onUpdated.emit(id, { groupId: -1 }, clone(requireTab(id))); } },
      async remove(ids) { calls.push(["remove", [].concat(ids)]); for (const id of [].concat(ids)) { const tab = requireTab(id); tabs.delete(id); attached.delete(id); chrome.tabs.onRemoved.emit(id, { windowId: tab.windowId, isWindowClosing: false }); } },
      async sendMessage() { return { ok: true }; }
    },
    tabGroups: {
      async get(id) { if (!groups.has(id)) throw new Error(`No group with id: ${id}`); return clone(groups.get(id)); },
      async update(id, value) { calls.push(["group-update", id]); Object.assign(groups.get(id) ?? {}, value); },
      async query() { return [...groups.values()].map(clone); }
    },
    windows: { onRemoved: event(), onFocusChanged: event(),
      async get(id) { await hooks.getWindow?.(id); if (!windows.has(id)) throw new Error(`No window with id: ${id}`); return clone(windows.get(id)); },
      async getAll() { return [...windows.values()].map(clone); }
    }
  };
  let engineOptions;
  let fixtureCode = code;
  if (claimTimeoutMs !== undefined) {
    const anchor = "const DEFAULT_CDP_TIMEOUT_MS = 10_000;";
    assert.equal(fixtureCode.split(anchor).length, 2, "native claim timeout source shape changed");
    fixtureCode = fixtureCode.replace(anchor, `const DEFAULT_CDP_TIMEOUT_MS = ${claimTimeoutMs};`);
  }
  const { BrowserBackend: Backend, NativeTransport } = vm.runInNewContext(`${fixtureCode}\n({ BrowserBackend, NativeTransport })`, { chrome, crypto, Date, URL, setTimeout, clearTimeout, createBrowserActionEngine: options => { engineOptions = options; return hooks.engine?.(options) ?? { pages: new Map(), queues: new Map(), invalidate() {}, detach: async () => {} }; } });
  const backend = new Backend();
  await backend.controlReady;
  if (initialize) for (const [id, groupId, tabId] of [["task", 10, 7], ["other", 20, 9]]) {
    const state = await backend.store.getSession(id); state.chromeGroupId = groupId; state.tabOrigins = { [tabId]: "agent" };
  }
  await backend.store.save();
  const current = initialize ? await backend.getControlState({ session_id: "task" }) : {}, other = initialize ? await backend.getControlState({ session_id: "other" }) : {};
  const params = { session_id: "task", turn_id: "turn", control_epoch: current.controlEpoch, tabId: 8 };
  const foreign = { session_id: "other", turn_id: "other-turn", control_epoch: other.controlEpoch, tabId: 8 };
  t.after(async () => {
    for (const gate of gates) gate.resolve();
    for (const key of Object.keys(hooks)) delete hooks[key];
    backend.networkWaits.invalidateAll();
    await Promise.allSettled([...backend.attachedTabs].map(id => backend.detachTab(id)));
  });
  return { Backend, NativeTransport, backend, chrome, local, session, calls, attached, hooks, tabs, windows, groups, params: { ...params, tabId: 7 }, foreign,
    get engineOptions() { return engineOptions; },
    gate() { const value = deferred(); gates.push(value); return value; },
    fresh(previous, next) { return { ...previous, turn_id: next.nextTurnId, control_epoch: next.controlEpoch }; },
    events: [chrome.runtime.onStartup, chrome.runtime.onInstalled, chrome.debugger.onDetach, chrome.debugger.onEvent, ...Object.values(chrome.tabs).filter(item => item?.emit), ...Object.values(chrome.windows).filter(item => item?.emit)]
  };
}

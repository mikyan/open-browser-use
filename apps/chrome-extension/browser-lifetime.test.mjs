import assert from "node:assert/strict";
import test from "node:test";
import { BrowserLifetime, BROWSER_LIFETIME_KEY, INPUT_RISK_KEY } from "./browser-lifetime.js";

const event = () => { const listeners = new Set(); return { addListener: fn => listeners.add(fn), emit: (...args) => { for (const fn of listeners) fn(...args); } }; };
const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };
function fixture() {
  const local = {}, session = {}, hooks = {}, onStartup = event(), onInstalled = event();
  let sequence = 0;
  const area = (name, data) => ({
    async get(key) { await hooks.get?.(name, key); return structuredClone(Object.hasOwn(data, key) ? { [key]: data[key] } : {}); },
    async set(values) { const snapshot = structuredClone(values); await hooks.set?.(name, snapshot); Object.assign(data, snapshot); }
  });
  const storage = { local: area("local", local), session: area("session", session) };
  return { local, session, hooks, onStartup, onInstalled,
    create: options => new BrowserLifetime({ storage, onStartup, onInstalled, randomUUID: () => `fixture-${++sequence}`, ...options }) };
}

test("worker replacement retains its incarnation; missing session storage creates a distinct identity", async () => {
  const f = fixture(), first = f.create(); await first.ready;
  const worker = f.create(); await worker.ready;
  assert.equal(worker.incarnation, first.incarnation);
  delete f.session[BROWSER_LIFETIME_KEY];
  const reload = f.create(); await reload.ready;
  assert.notEqual(reload.incarnation, first.incarnation);
  assert.equal(reload.isCurrent(first.incarnation), false);
});

test("input intent is durable before acknowledgement and a later mark cannot be erased by an old clear", async () => {
  const f = fixture(), life = f.create(); await life.ready;
  const gate = deferred(); let entered;
  f.hooks.set = async (area, value) => { if (area === "local" && value[INPUT_RISK_KEY]?.risks.length === 0) { entered = true; await gate.promise; } };
  await life.markInputRisk({ riskId: "input", tabId: 7 });
  const clearing = life.clearInputRisk("input"), marked = life.markInputRisk({ riskId: "input", tabId: 7 });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(entered, true);
  assert.equal(life.controlSnapshot().pending.length, 2);
  gate.resolve(); await Promise.all([clearing, marked]);
  assert.equal(f.local[INPUT_RISK_KEY].risks[0].riskId, "input");
  assert.equal(life.controlSnapshot().pending.length, 0);
});

test("failed clear keeps the actual record and explicit retry persists its removal", async () => {
  const f = fixture(), life = f.create(); await life.ready;
  await life.markInputRisk({ riskId: "held", tabId: 7 });
  f.hooks.set = async () => { throw new Error("disk failure"); };
  await assert.rejects(life.clearInputRisk("held"), /disk failure/);
  assert.equal(life.records.size, 1);
  delete f.hooks.set; await life.clearInputRisk("held");
  assert.equal(life.records.size, 0);
  assert.deepEqual(f.local[INPUT_RISK_KEY].risks, []);
});

test("unknown input stays blocked on reload and late startup, including reused numeric tab removal", async () => {
  const f = fixture(), first = f.create(); await first.ready;
  await first.markInputRisk({ riskId: "original", tabId: 7 });
  delete f.session[BROWSER_LIFETIME_KEY];
  const reload = f.create(); await reload.ready;
  f.onStartup.emit(); await reload.writes; await new Promise(resolve => setImmediate(resolve));
  await reload.originalTabRemoved(7);
  assert.throws(() => reload.assertInputRecoveryClear(), /INPUT_RELEASE_UNCONFIRMED/);
  await assert.rejects(reload.clearInputRisk("original"), /INPUT_RELEASE_UNCONFIRMED/);
  assert.equal(f.local[INPUT_RISK_KEY].risks.length, 1);
});

test("a true tab removal in the unchanged incarnation retires its recovered risk", async () => {
  const f = fixture(), first = f.create(); await first.ready;
  await first.markInputRisk({ riskId: "original", tabId: 7 });
  const worker = f.create(); await worker.ready;
  assert.throws(() => worker.assertInputRecoveryClear(), /INPUT_RELEASE_UNCONFIRMED/);
  await worker.originalTabRemoved(8);
  assert.equal(worker.recoveredRisks().length, 1);
  await worker.originalTabRemoved(7);
  worker.assertInputRecoveryClear();
  assert.deepEqual(f.local[INPUT_RISK_KEY].risks, []);
});

test("legacy Pause IDs migrate durably without acquiring current-incarnation identity", async () => {
  const f = fixture(), life = f.create({ legacyPending: async () => ({ tabIds: [7] }) }); await life.ready;
  assert.equal(life.recoveredRisks()[0].incarnation, null);
  assert.equal(f.local[INPUT_RISK_KEY].risks[0].tabId, 7);
  await life.originalTabRemoved(7);
  assert.throws(() => life.assertInputRecoveryClear(), /INPUT_RELEASE_UNCONFIRMED/);
});

test("an unreadable marker rejects ready and does not rewrite identity or input risk", async () => {
  const f = fixture(); f.hooks.get = async area => { if (area === "session") throw new Error("unreadable"); };
  const life = f.create(); await assert.rejects(life.ready, /unreadable/);
  assert.deepEqual(f.local, {}); assert.deepEqual(f.session, {});
});

test("startup before storage settles never clears new or legacy risks", async () => {
  const f = fixture(), gate = deferred();
  f.hooks.get = async area => { if (area === "session") await gate.promise; };
  const life = f.create({ legacyPending: async () => ({ tabIds: [7] }) });
  f.onStartup.emit(); gate.resolve(); await life.ready;
  await life.markInputRisk({ riskId: "new", tabId: 8 });
  await life.writes;
  assert.equal(f.local[INPUT_RISK_KEY].risks.length, 2);
  assert.throws(() => life.assertInputRecoveryClear(), /INPUT_RELEASE_UNCONFIRMED/);
});

test("an unwitnessed old risk is stamped once and only a later profile startup can retire it", async () => {
  const f = fixture(), first = f.create(); await first.ready;
  await first.markInputRisk({ riskId: "old", tabId: 7 });
  delete f.session[BROWSER_LIFETIME_KEY];
  const second = f.create(); await second.ready;
  await second.observeStartup();
  assert.equal(second.recoveredRisks().length, 1);
  const witness = f.local[INPUT_RISK_KEY].risks[0].startupWitness;
  assert.ok(witness);
  await second.observeStartup();
  assert.equal(second.recoveredRisks().length, 1);
  delete f.session[BROWSER_LIFETIME_KEY];
  const third = f.create(); await third.ready;
  assert.throws(() => third.assertInputRecoveryClear(), /INPUT_RELEASE_UNCONFIRMED/);
  await third.observeStartup();
  third.assertInputRecoveryClear();
  assert.deepEqual(f.local[INPUT_RISK_KEY].risks, []);
  assert.notEqual(third.marker.startupWitness, witness);
});

test("already-witnessed current-incarnation input survives duplicate or delayed startup delivery", async () => {
  const f = fixture(), first = f.create(); await first.ready;
  await first.observeStartup();
  await first.markInputRisk({ riskId: "live", tabId: 7 });
  const worker = f.create(); await worker.ready;
  await worker.observeStartup();
  assert.equal(worker.recoveredRisks().length, 1);
  assert.throws(() => worker.assertInputRecoveryClear(), /INPUT_RELEASE_UNCONFIRMED/);
});

test("worker loss between journal stamping and startup commit does not clear the newly stamped risk", async () => {
  const f = fixture(), first = f.create(); await first.ready;
  await first.markInputRisk({ riskId: "old", tabId: 7 });
  delete f.session[BROWSER_LIFETIME_KEY];
  const next = f.create(); await next.ready;
  f.hooks.set = async (area, values) => {
    if (area === "session" && values[BROWSER_LIFETIME_KEY]?.startupConsumed) throw new Error("worker lost before commit");
  };
  await assert.rejects(next.observeStartup(), /worker lost/);
  const witness = f.local[INPUT_RISK_KEY].risks[0].startupWitness;
  assert.equal(f.session[BROWSER_LIFETIME_KEY].startupConsumed, false);
  delete f.hooks.set;
  const worker = f.create(); await worker.ready;
  assert.equal(worker.recoveredRisks()[0].startupWitness, witness);
  assert.equal(worker.recoveredRisks().length, 1);
  assert.equal(f.session[BROWSER_LIFETIME_KEY].startupConsumed, true);
});

test("extension reload without another native startup never clears a witnessed risk", async () => {
  const f = fixture(), first = f.create(); await first.ready;
  await first.observeStartup(); await first.markInputRisk({ riskId: "held", tabId: 7 });
  delete f.session[BROWSER_LIFETIME_KEY];
  const reload = f.create(); f.onInstalled.emit({ reason: "update" }); await reload.ready;
  assert.equal(reload.recoveredRisks().length, 1);
  assert.equal(reload.marker.startupWitness, null);
  assert.throws(() => reload.assertInputRecoveryClear(), /INPUT_RELEASE_UNCONFIRMED/);
});

test("recovery guidance distinguishes current pages from cross-reload risks without changing the journal", async () => {
  const f = fixture(), first = f.create(); await first.ready;
  assert.equal(first.inputRecoveryGuidance(), null);
  await first.observeStartup(); await first.markInputRisk({ riskId: "private-risk", tabId: 7 });
  assert.equal(first.inputRecoveryGuidance(), null, "live tracked input is not a recovered risk");
  const worker = f.create(); await worker.ready;
  const saved = structuredClone(f.local);
  assert.deepEqual(worker.inputRecoveryGuidance(), { action: "close-controlled-pages" });
  assert.deepEqual(f.local, saved);
  delete f.session[BROWSER_LIFETIME_KEY];
  const reload = f.create(); await reload.ready;
  assert.deepEqual(reload.inputRecoveryGuidance(), { action: "restart-browser", restartMayNeedRepeat: false });
  await reload.originalTabRemoved(7);
  assert.deepEqual(f.local, saved, "guidance must not turn tab removal after reload into destruction proof");
  assert.throws(() => reload.assertInputRecoveryClear(), error => {
    assert.match(error.message, /OBU_INPUT_RELEASE_UNCONFIRMED/);
    assert.doesNotMatch(error.message, /private-risk|original-target/);
    return true;
  });
});

test("unwitnessed recovery guidance changes after stamping and disappears only when risks actually retire", async () => {
  const f = fixture(), first = f.create(); await first.ready;
  await first.markInputRisk({ riskId: "held", tabId: 7 });
  delete f.session[BROWSER_LIFETIME_KEY];
  const reload = f.create(); await reload.ready;
  assert.deepEqual(reload.inputRecoveryGuidance(), { action: "restart-browser", restartMayNeedRepeat: true });
  await reload.observeStartup();
  assert.deepEqual(reload.inputRecoveryGuidance(), { action: "restart-browser", restartMayNeedRepeat: false });
  assert.throws(() => reload.assertInputRecoveryClear(), /INPUT_RELEASE_UNCONFIRMED/);
  delete f.session[BROWSER_LIFETIME_KEY];
  const next = f.create(); await next.ready;
  await next.observeStartup();
  assert.equal(next.inputRecoveryGuidance(), null);
  next.assertInputRecoveryClear();
});

test("mixed and legacy risks require restart guidance instead of advice to close current pages", async () => {
  const f = fixture(), life = f.create({ legacyPending: async () => ({ tabIds: [7] }) }); await life.ready;
  await life.markInputRisk({ riskId: "current", tabId: 8 });
  const worker = f.create(); await worker.ready;
  const saved = structuredClone(f.local);
  assert.deepEqual(worker.inputRecoveryGuidance(), { action: "restart-browser", restartMayNeedRepeat: true });
  await worker.originalTabRemoved(8);
  assert.deepEqual(worker.inputRecoveryGuidance(), { action: "restart-browser", restartMayNeedRepeat: true });
  assert.deepEqual(f.local[INPUT_RISK_KEY].risks, saved[INPUT_RISK_KEY].risks.filter(record => record.tabId === 7));
});

import assert from "node:assert/strict";
import { createContext, runInContext } from "node:vm";
import test from "node:test";
import { AuxiliaryTabOwnership, AUXILIARY_TABS_KEY } from "../../apps/chrome-extension/auxiliary-tab-ownership.js";
import { assertCreatedPageAdoption, installCreatedPageAdoptionObserver } from "./created-page-adoption-observer.mjs";

const plain = value => JSON.parse(JSON.stringify(value));
const scopeOf = index => ({ session_id: `owner-${index}`, turn_id: `original-turn-${index}`, control_epoch: index + 7, controlRevision: 2, tabId: index + 10 });
const childOf = index => index + 100;
const eventOf = index => ({ sourceTabId: scopeOf(index).tabId, sourceFrameId: index % 3, sourceProcessId: 400 + index,
  tabId: childOf(index), url: "http://example.invalid/created-page/child", timeStamp: 1_700_000_000_000 + index });
const waitOf = index => ({ waiterId: `original-wait-${index}`, params: { ...scopeOf(index), timeoutMs: 20000 }, state: "matching", deadlineAt: 50000 });
const itemOf = index => ({ sessionId: scopeOf(index).session_id, turnId: scopeOf(index).turn_id, controlEpoch: scopeOf(index).control_epoch,
  tabId: scopeOf(index).tabId, childId: childOf(index), waiterId: waitOf(index).waiterId, childURL: eventOf(index).url, sourceFrame: { frameId: eventOf(index).sourceFrameId } });
const deferred = () => Promise.withResolvers();

async function fixture({ count = 2, limits = {}, manualWrites = false, selected } = {}) {
  const scopes = Array.from({ length: count }, (_, index) => scopeOf(index));
  const initial = scopes.map(scope => ({ claimId: `source-${scope.tabId}`, ...scope, windowId: 500 + scope.tabId,
    kind: "background-window", origin: "agent", phase: "committed" }));
  const calls = { gets: [], sets: [], adopts: [], commits: [], reserves: [] }, gates = [];
  const tabs = new Map(scopes.map((scope, index) => [childOf(index), { id: childOf(index), groupId: -1, windowId: 500 + scope.tabId,
    pinned: false, active: false, url: eventOf(index).url }]));
  const chrome = {
    tabs: { get(...args) { const promise = Promise.resolve(tabs.get(args[0])); calls.gets.push({ receiver: this, args, promise }); return promise; } },
    storage: { session: { set(...args) {
      const gate = deferred(), promise = manualWrites ? gate.promise : Promise.resolve();
      calls.sets.push({ receiver: this, args, promise }); gates.push(gate); return promise;
    } } },
  };
  let nextClaim = 0;
  const auxiliary = new AuxiliaryTabOwnership({ createId: () => `child-claim-${++nextClaim}`, storage: {
    setAccessLevel: async () => {}, get: async () => ({ [AUXILIARY_TABS_KEY]: { version: 4, records: initial } }),
    set: values => chrome.storage.session.set({ [AUXILIARY_TABS_KEY]: { ...values[AUXILIARY_TABS_KEY], incarnation: "original-browser-incarnation" } }),
  } });
  await auxiliary.ready;
  const reserve = auxiliary.reserve, commit = auxiliary.commit;
  Object.defineProperty(auxiliary, "reserve", { configurable: true, enumerable: false, writable: true,
    value: function (...args) { const value = reserve.apply(this, args); calls.reserves.push({ receiver: this, args, value }); return value; } });
  auxiliary.commit = function (...args) { const promise = commit.apply(this, args); calls.commits.push({ receiver: this, args, promise }); return promise; };
  const backendPrototype = { adoptCreatedPage(...args) {
    const [scope, event, record] = args;
    const promise = (async () => {
      await this.auxiliaryTabs.ready;
      const tab = await chrome.tabs.get(event.tabId);
      const claim = this.auxiliaryTabs.reserve({ ...scope, tabId: tab.id }); record.pageAdmission = claim;
      await this.auxiliaryTabs.commit(claim, { windowId: tab.windowId, kind: "created-page", control_epoch: scope.control_epoch, controlRevision: scope.controlRevision,
        check: () => {}, validate: async () => { await chrome.tabs.get(event.tabId); } });
      record.pageResult = { tabId: tab.id, claim };
      return { tabId: tab.id };
    })();
    calls.adopts.push({ receiver: this, args, promise }); return promise;
  } };
  const backend = Object.assign(Object.create(backendPrototype), { auxiliaryTabs: auxiliary });
  const original = { adopt: backend.adoptCreatedPage, reserve: auxiliary.reserve, commit: auxiliary.commit, get: chrome.tabs.get, set: chrome.storage.session.set,
    reserveDescriptor: Object.getOwnPropertyDescriptor(auxiliary, "reserve") };
  const context = createContext({ backend, chrome, Date, TextEncoder });
  const sessions = selected ?? scopes.map(scope => scope.session_id);
  const installed = plain(runInContext(`(${installCreatedPageAdoptionObserver.toString()})(backend,chrome,globalThis,${JSON.stringify({ sessions, ...limits })})`, context));
  const api = context.__createdPageAdoption;
  return { auxiliary, backend, chrome, calls, gates, tabs, scopes, initial, original, context, installed, api,
    snapshot: () => plain(api.snapshot()), stop: () => plain(api.stop()), adopt: index => backend.adoptCreatedPage(scopeOf(index), eventOf(index), waitOf(index)) };
}

test("serialized staged observer proves concurrent original unowned admissions with actual auxiliary persistence", async () => {
  const observed = await fixture({ count: 6 });
  assert.deepEqual(observed.installed, { installed: true, sessions: observed.scopes.map(scope => scope.session_id), maxRecords: 4000, maxBytes: 4 * 1024 * 1024 });
  const actual = observed.scopes.map((_, index) => observed.adopt(index));
  for (const [index, promise] of actual.entries()) assert.equal(promise, observed.calls.adopts[index].promise, "Original adoption promise identity");
  await Promise.all(actual);
  const snapshot = observed.stop(), result = assertCreatedPageAdoption({ snapshot, items: observed.scopes.map((_, index) => itemOf(index)) });
  assert.equal(result.adoptions, 6);
  assert.equal(observed.calls.reserves.length, 6); assert.equal(observed.calls.commits.length, 6);
  for (const call of observed.calls.gets) { assert.equal(call.receiver, observed.chrome.tabs); assert.equal(call.args.length, 1); }
  for (const call of observed.calls.sets) { assert.equal(call.receiver, observed.chrome.storage.session); assert.equal(call.args.length, 1); }
  for (const call of [...observed.calls.reserves, ...observed.calls.commits]) assert.equal(call.receiver, observed.auxiliary);
  for (const call of observed.calls.adopts) assert.equal(call.receiver, observed.backend);
  assert.equal(observed.backend.adoptCreatedPage, observed.original.adopt); assert.equal(Object.hasOwn(observed.backend, "adoptCreatedPage"), false);
  assert.deepEqual(Object.getOwnPropertyDescriptor(observed.auxiliary, "reserve"), observed.original.reserveDescriptor);
  assert.equal(observed.chrome.tabs.get, observed.original.get); assert.equal(observed.chrome.storage.session.set, observed.original.set);
  assert.deepEqual(observed.stop(), snapshot);
});

test("wrappers preserve exact original promises, this, arguments and synchronous reservation identity", async () => {
  const observed = await fixture({ count: 1 }); await observed.adopt(0);
  const extra = { noChange: true };
  const getResult = observed.chrome.tabs.get(childOf(0), extra);
  assert.equal(getResult, observed.calls.gets.at(-1).promise); assert.equal(observed.calls.gets.at(-1).args[1], extra);
  const values = { [AUXILIARY_TABS_KEY]: { version: 4, incarnation: "original-browser-incarnation", records: [observed.auxiliary.entry(childOf(0))] } };
  const setResult = observed.chrome.storage.session.set(values, extra);
  assert.equal(setResult, observed.calls.sets.at(-1).promise); assert.equal(observed.calls.sets.at(-1).args[0], values); assert.equal(observed.calls.sets.at(-1).args[1], extra);
  const params = { ...scopeOf(0), tabId: childOf(0) };
  const reserved = observed.auxiliary.reserve(params, extra);
  assert.equal(reserved, observed.calls.reserves.at(-1).value); assert.equal(observed.calls.reserves.at(-1).args[0], params); assert.equal(observed.calls.reserves.at(-1).args[1], extra);
  const options = { windowId: reserved.windowId, kind: "created-page", check: () => {}, validate: async () => {} };
  const commitResult = observed.auxiliary.commit(reserved, options, extra);
  assert.equal(commitResult, observed.calls.commits.at(-1).promise); assert.equal(observed.calls.commits.at(-1).args[1], options); assert.equal(observed.calls.commits.at(-1).args[2], extra);
  await Promise.all([getResult, setResult, commitResult]);
  assert.deepEqual(observed.stop().errors, []);
});

test("unresolved actual storage ACK remains pending and cannot masquerade as durable child ownership", async () => {
  const observed = await fixture({ count: 1, manualWrites: true }), adoption = observed.adopt(0);
  for (let index = 0; index < 20 && !observed.gates.length; index++) await Promise.resolve();
  assert.equal(observed.gates.length, 1); assert.equal(observed.auxiliary.owner(childOf(0)), undefined);
  let snapshot = observed.snapshot();
  assert.equal(snapshot.records.filter(row => row.kind === "storage-set-call").length, 1);
  assert.equal(snapshot.records.filter(row => row.kind === "storage-set-fulfilled").length, 0);
  assert.ok(snapshot.pendingOperations.some(row => row.kind === "storage-set"));
  observed.gates[0].resolve();
  for (let index = 0; index < 30 && observed.gates.length < 2; index++) await Promise.resolve();
  assert.equal(observed.gates.length, 2); assert.equal(observed.auxiliary.entry(childOf(0)).phase, "committed");
  assert.equal(observed.auxiliary.owner(childOf(0)), undefined, "Committed phase without actual write ACK is not an owner");
  snapshot = observed.snapshot(); assert.equal(snapshot.records.filter(row => row.kind === "commit-fulfilled").length, 0);
  observed.gates[1].resolve(); await adoption;
  assert.equal(assertCreatedPageAdoption({ snapshot: observed.stop(), items: [itemOf(0)] }).adoptions, 1);
});

test("historical admission survives later authority removal and snapshots are immutable copies", async () => {
  const observed = await fixture({ count: 1 }); await observed.adopt(0);
  const record = observed.auxiliary.entry(childOf(0)), before = observed.snapshot();
  await observed.auxiliary.remove(record);
  assert.equal(observed.auxiliary.entry(childOf(0)), undefined);
  const snapshot = observed.stop(); assert.equal(assertCreatedPageAdoption({ snapshot, items: [itemOf(0)] }).adoptions, 1);
  const original = before.records.find(row => row.kind === "commit-fulfilled"); assert.equal(original.result.phase, "committed");
  original.result.phase = "tampered"; before.records.length = 0;
  assert.equal(observed.snapshot().records.find(row => row.kind === "commit-fulfilled").result.phase, "committed");
});

test("foreign sessions and unrelated tabs or storage fields are not captured", async () => {
  const observed = await fixture({ count: 2, selected: [scopeOf(0).session_id] });
  await observed.adopt(1); await observed.chrome.tabs.get(999);
  assert.deepEqual(observed.snapshot().records, []);
  await observed.adopt(0);
  await observed.chrome.storage.session.set({ [AUXILIARY_TABS_KEY]: { version: 4, incarnation: "original-browser-incarnation", records: [
    { ...observed.auxiliary.entry(childOf(1)), secret: "foreign-secret" }, observed.auxiliary.entry(childOf(0)),
  ] }, unrelated: { secret: "other-storage-secret" } });
  const snapshot = observed.stop(), serialized = JSON.stringify(snapshot);
  assert.ok(!serialized.includes("foreign-secret") && !serialized.includes("other-storage-secret"));
  assert.equal(assertCreatedPageAdoption({ snapshot, items: [itemOf(0)] }).adoptions, 1);
});

test("bounded record or byte overflow never prevents the original native call and fails evidence", async () => {
  for (const limits of [{ maxRecords: 2 }, { maxBytes: 1 }]) {
    const observed = await fixture({ count: 1, limits }); await observed.adopt(0);
    assert.equal(observed.auxiliary.owner(childOf(0)).kind, "created-page");
    const snapshot = observed.stop(); assert.equal(snapshot.overflow, true);
    assert.ok(snapshot.records.length <= snapshot.maxRecords && snapshot.bytes <= snapshot.maxBytes);
    assert.throws(() => assertCreatedPageAdoption({ snapshot, items: [itemOf(0)] }), /bounded/);
  }
});

test("snapshot serialization errors do not suppress original calls or replace their result", async () => {
  const observed = await fixture({ count: 1 }), scope = scopeOf(0); scope.circular = scope;
  const promise = observed.backend.adoptCreatedPage(scope, eventOf(0), waitOf(0));
  assert.equal(promise, observed.calls.adopts[0].promise);
  await promise; assert.equal(observed.auxiliary.owner(childOf(0)).kind, "created-page");
  const snapshot = observed.stop(); assert.ok(snapshot.errors.length > 0);
  assert.throws(() => assertCreatedPageAdoption({ snapshot, items: [itemOf(0)] }), /observer errors/);
});

test("original rejection and synchronous reserve failure remain visible without false successful ACKs", async () => {
  const observed = await fixture({ count: 1, manualWrites: true }), failure = Error("native storage failure"), adoption = observed.adopt(0);
  for (let index = 0; index < 20 && !observed.gates.length; index++) await Promise.resolve();
  observed.gates[0].reject(failure);
  // The real auxiliary class records a quarantine write after failure.
  for (let index = 0; index < 40 && observed.gates.length < 2; index++) await Promise.resolve();
  for (const gate of observed.gates.slice(1)) gate.resolve();
  await assert.rejects(adoption, error => error === failure);
  await observed.auxiliary.writes;
  assert.equal(observed.auxiliary.owner(childOf(0)), undefined);
  const conflict = observed.auxiliary.reserve;
  let originalError;
  try { observed.original.reserve.call(observed.auxiliary, { ...scopeOf(0), tabId: childOf(0) }); } catch (error) { originalError = error; }
  assert.ok(originalError);
  assert.throws(() => conflict.call(observed.auxiliary, { ...scopeOf(0), tabId: childOf(0) }), /OBU_AUXILIARY_CLEANUP_REQUIRED/);
  const snapshot = observed.stop(); assert.ok(snapshot.records.some(row => row.kind === "reserve-threw"));
  assert.ok(snapshot.records.some(row => row.kind === "storage-set-rejected")); assert.ok(snapshot.records.some(row => row.kind === "adoption-rejected"));
  assert.ok(!snapshot.records.some(row => row.kind === "commit-fulfilled"));
  assert.throws(() => assertCreatedPageAdoption({ snapshot, items: [itemOf(0)] }));
});

test("synchronous original exceptions retain identity and do not become promises", async () => {
  const observed = await fixture({ count: 1 }); observed.stop();
  const failure = Error("original synchronous exception"), args = [scopeOf(0), eventOf(0), waitOf(0)];
  let receiver, received;
  observed.backend.adoptCreatedPage = function (...values) { receiver = this; received = values; throw failure; };
  observed.chrome.tabs.get = function () { assert.equal(this, observed.chrome.tabs); throw failure; };
  const target = {}; installCreatedPageAdoptionObserver(observed.backend, observed.chrome, target, { sessions: [scopeOf(0).session_id] });
  assert.throws(() => observed.backend.adoptCreatedPage(...args), error => error === failure);
  assert.equal(receiver, observed.backend); args.forEach((value, index) => assert.equal(received[index], value));
  assert.throws(() => observed.chrome.tabs.get(childOf(0)), error => error === failure);
  const snapshot = target.__createdPageAdoption.stop(); assert.deepEqual(snapshot.errors, []);
  assert.equal(snapshot.records.filter(row => row.kind.endsWith("-threw")).length, 2); assert.deepEqual(snapshot.pendingOperations, []);
});

test("additional original child lookups before reservation retain all ACKs without demanding one call site", async () => {
  const observed = await fixture({ count: 1 }); observed.stop();
  observed.backend.adoptCreatedPage = async function (scope, event) {
    const tab = await observed.chrome.tabs.get(event.tabId);
    await observed.chrome.tabs.get(event.tabId); // A second original site-validation read.
    const record = this.auxiliaryTabs.reserve({ ...scope, tabId: event.tabId });
    await this.auxiliaryTabs.commit(record, { windowId: tab.windowId, kind: "created-page", control_epoch: scope.control_epoch,
      check: () => {}, validate: async () => {} });
    return { tabId: event.tabId };
  };
  const target = {}; installCreatedPageAdoptionObserver(observed.backend, observed.chrome, target, { sessions: [scopeOf(0).session_id] });
  await observed.adopt(0);
  const snapshot = target.__createdPageAdoption.stop(); assert.equal(snapshot.records.filter(row => row.kind === "tabs-get-fulfilled").length, 2);
  assert.equal(assertCreatedPageAdoption({ snapshot, items: [itemOf(0)] }).adoptions, 1);
});

test("stop preserves third-party replacements and marks incomplete hook restoration", async () => {
  const observed = await fixture({ count: 1 }), replacement = () => Promise.resolve({ id: 999 });
  observed.chrome.tabs.get = replacement;
  const snapshot = observed.stop(); assert.equal(observed.chrome.tabs.get, replacement);
  assert.equal(snapshot.closed, true); assert.equal(snapshot.restored, false); assert.match(snapshot.errors.join(" "), /replaced before stop/);
  assert.equal(observed.backend.adoptCreatedPage, observed.original.adopt); assert.equal(observed.chrome.storage.session.set, observed.original.set);
});

test("stop during pending actual work retains the incomplete evidence and late completion does not mutate it", async () => {
  const observed = await fixture({ count: 1, manualWrites: true }), adoption = observed.adopt(0);
  for (let index = 0; index < 20 && !observed.gates.length; index++) await Promise.resolve();
  const snapshot = observed.stop(); assert.ok(snapshot.pendingOperations.length > 0);
  observed.gates[0].resolve();
  for (let index = 0; index < 30 && observed.gates.length < 2; index++) await Promise.resolve();
  observed.gates[1].resolve(); await adoption;
  assert.deepEqual(observed.snapshot(), snapshot);
  assert.throws(() => assertCreatedPageAdoption({ snapshot, items: [itemOf(0)] }), /settled before stop/);
});

test("invalid installation and duplicate observer fail before changing any original method", async () => {
  for (const limits of [{ sessions: [] }, { sessions: ["a", "a"] }, { maxRecords: 0 }, { maxRecords: 10001 }, { maxBytes: 0 }, { maxBytes: 8 * 1024 * 1024 + 1 }]) {
    const observed = await fixture({ count: 1 }); observed.stop();
    const before = observed.backend.adoptCreatedPage;
    assert.throws(() => installCreatedPageAdoptionObserver(observed.backend, observed.chrome, {}, { sessions: ["a"], ...limits }), /Invalid/);
    assert.equal(observed.backend.adoptCreatedPage, before);
  }
  const observed = await fixture({ count: 1 }), hook = observed.backend.adoptCreatedPage;
  assert.throws(() => installCreatedPageAdoptionObserver(observed.backend, observed.chrome, observed.context, { sessions: ["a"] }), /Invalid/);
  assert.equal(observed.backend.adoptCreatedPage, hook); observed.stop();
  Object.defineProperty(observed.chrome.tabs, "get", { value: observed.original.get, configurable: false, writable: false });
  assert.throws(() => installCreatedPageAdoptionObserver(observed.backend, observed.chrome, {}, { sessions: ["a"] }), /Cannot observe/);
  assert.equal(observed.backend.adoptCreatedPage, observed.original.adopt);
});

function recalculate(snapshot) {
  snapshot.records.forEach((row, index) => { row.sequence = index + 1; });
  snapshot.bytes = snapshot.records.reduce((sum, row) => sum + Buffer.byteLength(JSON.stringify(row)), 0);
}

for (const [label, mutate] of [
  ["child already had authority at entry", value => { const row = value.records.find(row => row.kind === "adoption-enter"); row.child.owner = { session_id: "owner-0" }; }],
  ["child had pending claim immediately before reserve", value => { value.records.find(row => row.kind === "reserve-enter").before.entry = { phase: "pending" }; }],
  ["first Chrome tab ACK already grouped", value => { value.records.find(row => row.kind === "tabs-get-fulfilled").result.groupId = 27; }],
  ["child moved to another window", value => { value.records.find(row => row.kind === "tabs-get-fulfilled").result.windowId++; }],
  ["wrong source session", value => { value.records.find(row => row.kind === "adoption-enter").scope.session_id = "other"; }],
  ["wrong native source frame", value => { value.records.find(row => row.kind === "adoption-enter").event.sourceFrameId++; }],
  ["source not background-window authority", value => { const row = value.records.find(row => row.kind === "adoption-enter"); row.source.entry.kind = row.source.owner.kind = "ordinary"; }],
  ["wrong native child", value => { value.records.find(row => row.kind === "adoption-fulfilled").result.tabId++; }],
  ["commit changed the turn", value => { value.records.find(row => row.kind === "commit-fulfilled").result.turn_id = "new-turn"; }],
  ["storage incarnation absent", value => { delete value.records.find(row => row.kind === "storage-set-call").value.incarnation; }],
  ["stored child has wrong kind", value => { value.records.find(row => row.kind === "storage-set-call").value.records[0].kind = "popup"; }],
  ["storage rejection is not ACK", value => { value.records.find(row => row.kind === "storage-set-fulfilled").kind = "storage-set-rejected"; }],
  ["unresolved storage operation", value => { value.records.splice(value.records.findIndex(row => row.kind === "storage-set-fulfilled"), 1); }],
  ["duplicate actual adoption", value => { value.records.push({ ...value.records.find(row => row.kind === "adoption-enter") }); }],
  ["commit returns before durable storage ACK", value => {
    const index = value.records.findIndex(row => row.kind === "commit-fulfilled"), [row] = value.records.splice(index, 1);
    value.records.splice(value.records.findIndex(row => row.kind === "storage-set-fulfilled"), 0, row);
  }],
]) test(`verifier rejects ${label}`, async () => {
  const observed = await fixture({ count: 1 }); await observed.adopt(0);
  const snapshot = observed.stop(); assertCreatedPageAdoption({ snapshot, items: [itemOf(0)] });
  mutate(snapshot); recalculate(snapshot);
  assert.throws(() => assertCreatedPageAdoption({ snapshot, items: [itemOf(0)] }));
});

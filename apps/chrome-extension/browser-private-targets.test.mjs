import test from "node:test";
import assert from "node:assert/strict";
import { PrivateTargetRegistry } from "./browser-private-targets.js";
import { PassivePointerReads } from "./browser-pointer-feedback.js";

const deferred = () => { let resolve, reject; const promise = new Promise((a, b) => { resolve = a; reject = b; }); return { promise, resolve, reject }; };
const tick = async () => { for (let i = 0; i < 12; i++) await Promise.resolve(); };
const absent = target => Error(`Debugger is not attached to the target with id: ${target}.`);
const row = (target = "child", phase = "owned") => ({ leaseId: "original", tabId: 7, rootTargetId: "root", targetId: target, parentFrameId: "parent", phase });

function harness({ ledger, fresh = ledger === undefined, load, save, send, attach, detach, getTargets } = {}) {
  let incarnation = "browser-original", counter = 0, scope = true, stored = ledger;
  const calls = [], writes = [], clients = new Set(), objects = new Set();
  const root = { tabId: 7, rootTargetId: "root", attachment: {}, check() { if (!scope) throw Error("Original scope revoked"); } };
  const native = {
    getTargets() { calls.push({ method: "getTargets" }); return getTargets?.() ?? Promise.resolve([{ id: "child", attached: true }, ...Array.from({ length: 64 }, (_, i) => ({ id: `child-${i}` }))]); },
    send(target, method, params) {
      calls.push({ method, target: { ...target }, params });
      if (send) { const result = send(target, method, params); if (result) return result; }
      if (method === "Target.getTargetInfo") return clients.has(target.targetId) ? Promise.resolve({ targetInfo: { targetId: target.targetId } }) : Promise.reject(absent(target.targetId));
      if (method === "Runtime.evaluate") { objects.add(`${target.targetId}:${params.objectGroup}`); return Promise.resolve({ result: { objectId: "original-object" } }); }
      if (method === "Runtime.releaseObjectGroup") objects.delete(`${target.targetId}:${params.objectGroup}`);
      return Promise.resolve({});
    },
    attach(target, version) {
      calls.push({ method: "attach", target: { ...target }, version });
      if (attach) { const result = attach(target); if (result) return result; }
      assert.equal(clients.has(target.targetId), false); clients.add(target.targetId); return Promise.resolve();
    },
    detach(target) {
      calls.push({ method: "detach", target: { ...target } });
      if (detach) { const result = detach(target); if (result) return result; }
      assert.equal(clients.delete(target.targetId), true); for (const key of objects) if (key.startsWith(target.targetId + ":")) objects.delete(key); return Promise.resolve();
    }
  };
  const registry = new PrivateTargetRegistry({
    load: load ?? (() => Promise.resolve({ ledger, fresh, incarnation })),
    save: value => { writes.push(structuredClone(value)); const result = save?.(value); if (result) return result; stored = structuredClone(value); return Promise.resolve(); },
    incarnation: () => incarnation, native, randomUUID: () => `lease-${++counter}`
  });
  return { registry, root, calls, writes, clients, objects, get stored() { return stored; }, revoke() { scope = false; }, changeIncarnation() { incarnation = "different-browser"; } };
}

const allocate = (h, target = "child", root = h.root) => h.registry.acquire({ root, targetId: target, parentFrameId: "parent" });
const evaluating = (lease, group = "group") => lease.send("Runtime.evaluate", { expression: "({})", objectGroup: group, awaitPromise: false, userGesture: false });

test("fresh initialization and actual intent/attach/owned/clear ACKs control admission", async () => {
  const intent = deferred(), attached = deferred(), owned = deferred(), cleared = deferred(); let write = 0;
  const h = harness({ save() { write++; return write === 2 ? intent.promise : write === 3 ? owned.promise : write === 4 ? cleared.promise : undefined; }, attach: () => attached.promise });
  assert.equal(allocate(h), null); await h.registry.ready;
  const lease = allocate(h); await tick();
  assert.equal(h.writes.at(-1).records[0].phase, "intent"); assert.equal(h.calls.some(c => c.method === "attach"), false);
  intent.resolve(); await tick(); assert.equal(h.calls.at(-1).method, "attach"); assert.throws(lease.check);
  h.clients.add("child"); attached.resolve(); await tick(); assert.equal(h.writes.at(-1).records[0].phase, "owned"); assert.throws(lease.check);
  owned.resolve(); assert.deepEqual(await lease.ready, { targetId: "child" }); lease.check();
  const release = lease.release(); await tick(); assert.equal(h.calls.at(-1).method, "detach"); assert.equal(h.registry.snapshot().leases.length, 1); assert.equal(allocate(h), null);
  cleared.resolve(); await release; assert.equal(h.registry.snapshot().leases.length, 0); assert.equal(h.clients.size, 0);
});

test("a held native allocation and exception response drain before group release and detach", async () => {
  const allocation = deferred(), groupACK = deferred(), detached = deferred();
  const h = harness({ send(_target, method) { if (method === "Runtime.evaluate") return allocation.promise; if (method === "Runtime.releaseObjectGroup") return groupACK.promise; }, detach: () => detached.promise });
  await h.registry.ready; const lease = allocate(h); await lease.ready; const group = lease.prepareGroup("group");
  const actual = evaluating(lease); assert.equal(actual, allocation.promise); const release = lease.release(); await tick();
  assert.equal(h.calls.some(c => c.method === "Runtime.releaseObjectGroup" || c.method === "detach"), false); assert.throws(() => evaluating(lease));
  allocation.resolve({ result: { objectId: "thrown-result" }, exceptionDetails: { exception: { objectId: "thrown-exception" } } }); await tick();
  assert.equal(h.calls.at(-1).method, "Runtime.releaseObjectGroup"); assert.equal(h.calls.some(c => c.method === "detach"), false);
  groupACK.resolve({}); await tick(); assert.equal(h.calls.at(-1).method, "detach"); group.close();
  assert.equal(h.registry.snapshot().leases.length, 1); detached.resolve(); await release; assert.equal(h.registry.snapshot().leases.length, 0);
});

test("root revocation during attach retains late native ownership and never restores reads", async () => {
  const attached = deferred(); const h = harness({ attach: () => attached.promise }); await h.registry.ready;
  const lease = allocate(h); await tick(); h.revoke(); const release = h.registry.revokeRoot(h.root.attachment); await tick();
  assert.equal(h.calls.some(c => c.method === "detach"), false); h.clients.add("child"); attached.resolve();
  await assert.rejects(lease.ready, /unavailable/); await release;
  assert.deepEqual(h.calls.map(c => c.method), ["getTargets", "Target.getTargetInfo", "attach", "detach"]); assert.throws(lease.check); assert.equal(h.registry.snapshot().leases.length, 0);
});

test("group release failure keeps the exact target fenced and only explicit retry starts another attempt", async () => {
  const failure = Error("original native release failure"); let attempts = 0;
  const h = harness({ send(_target, method) { if (method === "Runtime.releaseObjectGroup" && ++attempts === 1) return Promise.reject(failure); } });
  await h.registry.ready; const lease = allocate(h); await lease.ready; lease.prepareGroup("group"); await evaluating(lease);
  const first = lease.release(); await assert.rejects(first, error => error === failure);
  assert.equal(lease.release(), first); assert.equal(allocate(h), null); assert.deepEqual(h.registry.snapshot().failed, [lease.leaseId]); assert.equal(h.calls.some(c => c.method === "detach"), false);
  await h.registry.retry(lease.leaseId); assert.equal(attempts, 2); assert.equal(h.clients.size, 0); assert.equal(h.registry.snapshot().leases.length, 0);
});

test("explicit retry during actual pending cleanup shares it; detach failure is retained", async () => {
  const detached = deferred(); let attempts = 0; const failure = Error("actual detach failure");
  const h = harness({ detach() { if (++attempts === 1) return detached.promise; } }); await h.registry.ready;
  const lease = allocate(h); await lease.ready; const release = lease.release(); await tick();
  assert.equal(h.registry.retry(lease.leaseId), release); assert.equal(attempts, 1);
  detached.reject(failure); await assert.rejects(release, error => error === failure); assert.equal(allocate(h), null);
  await h.registry.retry(lease.leaseId); assert.equal(attempts, 2); assert.equal(h.registry.snapshot().leases.length, 0);
});

test("durable clear failure never duplicates successful detach and requires explicit retry", async () => {
  let clears = 0; const failure = Error("clear write failed");
  const h = harness({ save(value) { if (value.records.length === 0 && ++clears === 2) return Promise.reject(failure); } });
  await h.registry.ready; const lease = allocate(h); await lease.ready;
  await assert.rejects(lease.release(), error => error === failure); assert.equal(h.clients.size, 0); assert.equal(allocate(h), null);
  await h.registry.retry(lease.leaseId); assert.equal(h.calls.filter(c => c.method === "detach").length, 1); assert.deepEqual(h.stored.records, []);
});

test("intent write failure sends no attach; uncertain durable intent remains until its clear ACK", async () => {
  const failure = Error("intent write ACK failed"); let writes = 0;
  const h = harness({ save() { if (++writes === 2) return Promise.reject(failure); } }); await h.registry.ready;
  const lease = allocate(h); await assert.rejects(lease.ready, error => error === failure);
  assert.equal(h.calls.some(c => c.method === "attach"), false); assert.equal(allocate(h), null); await lease.release();
  assert.equal(h.calls.some(c => c.method === "detach"), false); assert.deepEqual(h.stored.records, []);
});

test("owned write failure retains acquired native client and original readiness error", async () => {
  const failure = Error("owned write failed"); let writes = 0;
  const h = harness({ save() { if (++writes === 3) return Promise.reject(failure); } }); await h.registry.ready;
  const lease = allocate(h); await assert.rejects(lease.ready, error => error === failure); assert.equal(h.clients.size, 1); assert.throws(lease.check);
  await lease.release(); assert.equal(h.clients.size, 0); assert.equal(h.calls.filter(c => c.method === "detach").length, 1);
});

test("only exact original target no-client error admits attach, never an existing or unknown client", async () => {
  for (const response of [{ targetInfo: { targetId: "child" } }, Error("Debugger is not attached to the target with id: other."), Error("Debugger is not attached"), Error("Permission denied")]) {
    const h = harness({ send(_target, method) { if (method === "Target.getTargetInfo") return response instanceof Error ? Promise.reject(response) : Promise.resolve(response); } });
    await h.registry.ready; const lease = allocate(h); await assert.rejects(lease.ready); await lease.release();
    assert.equal(h.calls.length, 2); assert.equal(h.writes.length, 1); assert.equal(h.registry.snapshot().leases.length, 0);
  }
});

test("missing, unreadable, malformed, old-version and different-incarnation ledgers stay unknown without native calls", async () => {
  const values = [undefined, { version: 2, incarnation: "browser-original", records: [] }, { version: 1, incarnation: "other", records: [row()] }, { version: 1, incarnation: "browser-original", records: [row(), row()] }];
  for (const ledger of values) {
    const h = harness({ ledger, fresh: false }); await assert.rejects(h.registry.ready); assert.equal(allocate(h), null); assert.ok(h.registry.snapshot().unknown); assert.equal(h.calls.length, 0); assert.equal(h.writes.length, 0);
  }
  const h = harness({ load: () => Promise.reject(Error("read failed")) }); await assert.rejects(h.registry.ready); assert.equal(h.registry.snapshot().enabled, false); assert.equal(h.calls.length, 0);
});

test("recognized same-browser intent and owned records are quarantined and explicitly recovered, never read", async () => {
  for (const phase of ["intent", "owned"]) {
    const detached = deferred(), h = harness({ ledger: { version: 1, incarnation: "browser-original", records: [row("child", phase)] }, detach: () => detached.promise }); h.clients.add("child");
    await h.registry.ready; assert.deepEqual(h.registry.snapshot().quarantined, ["original"]); assert.equal(allocate(h, "new-child"), null); assert.equal(h.calls.length, 0);
    const recovery = h.registry.recover("original"); await tick(); assert.deepEqual(h.calls.map(c => c.method), ["Target.getTargetInfo", "detach"]);
    assert.equal(h.registry.snapshot().quarantined.length, 1); detached.resolve(); await recovery; assert.equal(h.registry.snapshot().quarantined.length, 0);
  }
});

test("recovery exact no-client proof clears original intent; unknown errors and wrong target cannot detach", async () => {
  const h = harness({ ledger: { version: 1, incarnation: "browser-original", records: [row("child", "intent")] } }); await h.registry.ready; await h.registry.recover("original");
  assert.deepEqual(h.calls.map(c => c.method), ["Target.getTargetInfo"]); assert.deepEqual(h.stored.records, []);
  for (const result of [Error("No target with given id"), { targetInfo: { targetId: "different" } }]) {
    const f = harness({ ledger: { version: 1, incarnation: "browser-original", records: [row()] }, send: () => result instanceof Error ? Promise.reject(result) : Promise.resolve(result) });
    await f.registry.ready; await assert.rejects(f.registry.recover("original")); assert.equal(f.registry.snapshot().quarantined.length, 1); assert.equal(f.calls.some(c => c.method === "detach"), false); assert.equal(f.writes.length, 0);
  }
});

test("startup quarantine load blocks every acquisition until original storage completes", async () => {
  const loaded = deferred(), h = harness({ load: () => loaded.promise }); assert.equal(allocate(h), null); assert.equal(h.calls.length, 0);
  loaded.resolve({ ledger: { version: 1, incarnation: "browser-original", records: [row()] } }); await h.registry.ready; assert.equal(allocate(h), null); assert.equal(h.calls.length, 0);
});

test("target-only onDetach and root detach are revocations, never successful native cleanup", async () => {
  const detached = deferred(), h = harness({ detach: () => detached.promise }); await h.registry.ready; const lease = allocate(h); await lease.ready;
  h.registry.observeDetach({ targetId: "child" }); assert.throws(lease.check); assert.equal(h.registry.snapshot().leases.length, 1); assert.equal(h.calls.some(c => c.method === "detach"), false);
  const release = h.registry.revokeRoot(h.root.attachment); await tick(); assert.equal(h.calls.at(-1).method, "detach"); assert.equal(h.registry.snapshot().leases.length, 1);
  detached.resolve(); await release; assert.equal(h.registry.snapshot().leases.length, 0);
});

test("incarnation change revokes a live route without authorizing detach in another browser", async () => {
  const h = harness(); await h.registry.ready; const lease = allocate(h); await lease.ready; h.changeIncarnation(); assert.throws(lease.check); await assert.rejects(lease.release());
  assert.equal(h.calls.some(c => c.method === "detach"), false); assert.equal(h.registry.snapshot().unknown, "incarnation-changed"); assert.equal(h.registry.snapshot().leases.length, 1);
});

test("child-client budget allows deep candidates and stays bounded at sixty-four across roots", async () => {
  const h = harness(); await h.registry.ready; const leases = [];
  for (let index = 0; index < 8; index++) {
    const root = { ...h.root, tabId: index, attachment: {} };
    for (let child = 0; child < 8; child++) { const lease = allocate(h, `child-${index * 8 + child}`, root); assert.ok(lease); leases.push(lease); }
  }
  assert.equal(allocate(h, "global-excess", { ...h.root, attachment: {} }), null); assert.equal(allocate(h, "child-0", { ...h.root, attachment: {} }), null);
  await Promise.all(leases.map(l => l.ready)); await Promise.all(leases.map(l => l.release())); assert.equal(h.registry.snapshot().leases.length, 0); assert.deepEqual(h.stored.records, []);
});

test("one original attachment can reserve two depth-thirty-two child budgets but never a sixty-fifth client", async () => {
  const h = harness(); await h.registry.ready; const leases = [];
  for (let child = 0; child < 64; child++) {
    const lease = h.registry.acquire({ root: h.root, targetId: `child-${child}`, parentFrameId: child % 32 ? `child-${child - 1}` : "parent" });
    assert.ok(lease); leases.push(lease);
  }
  assert.equal(allocate(h, "per-root-excess"), null);
  await Promise.all(leases.map(lease => lease.ready)); await Promise.all(leases.map(lease => lease.release()));
  assert.equal(h.registry.snapshot().leases.length, 0); assert.equal(h.clients.size, 0);
});

test("registry refuses domain changes, unregistered allocation groups and new allocation during group cleanup", async () => {
  const h = harness(); await h.registry.ready; const lease = allocate(h); await lease.ready;
  for (const method of ["Runtime.enable", "DOM.getDocument", "Target.setAutoAttach", "Input.dispatchMouseEvent"]) assert.throws(() => lease.send(method, {}));
  assert.throws(() => evaluating(lease)); const group = lease.prepareGroup("group"); assert.throws(() => evaluating(lease, "unknown")); assert.throws(() => group.close());
  const released = group.releaseGroup(); assert.throws(() => evaluating(lease)); await released; group.close(); await lease.release();
  assert.equal(h.calls.filter(c => c.method === "Runtime.releaseObjectGroup").length, 1);
});

test("discovery is actual exact-ID materialization, never attached state or a matching URL", async () => {
  for (const targets of [[{ id: "other", url: "https://same.example/" }], [{ id: "child" }, { id: "child" }], []]) {
    const h = harness({ getTargets: () => Promise.resolve(targets) }); await h.registry.ready;
    const lease = allocate(h); await assert.rejects(lease.ready); await lease.release();
    assert.deepEqual(h.calls.map(c => c.method), ["getTargets"]); assert.equal(h.writes.length, 1);
  }
  const discovery = deferred(), h = harness({ getTargets: () => discovery.promise }); await h.registry.ready;
  const lease = allocate(h); assert.ok(h.registry.snapshot().pending.includes(discovery.promise));
  const release = lease.release(); await tick(); assert.equal(h.registry.snapshot().leases.length, 1);
  discovery.resolve([{ id: "child", attached: false }]); await assert.rejects(lease.ready); await release;
  assert.deepEqual(h.calls.map(c => c.method), ["getTargets"]);
});

test("No target errors remain failures after discovery; they never become no-client proof", async () => {
  const failure = Error("No target with given id child.");
  const h = harness({ send(_target, method) { if (method === "Target.getTargetInfo") return Promise.reject(failure); } });
  await h.registry.ready; const lease = allocate(h); await assert.rejects(lease.ready, error => error === failure); await lease.release();
  assert.deepEqual(h.calls.map(c => c.method), ["getTargets", "Target.getTargetInfo"]); assert.equal(h.writes.length, 1);
});

test("a delayed fresh witness is bound to its original incarnation and cannot initialize another browser", async () => {
  const loaded = deferred(), h = harness({ load: () => loaded.promise });
  h.changeIncarnation(); loaded.resolve({ fresh: true, incarnation: "browser-original" });
  await assert.rejects(h.registry.ready); assert.equal(h.registry.snapshot().enabled, false); assert.equal(h.writes.length, 0); assert.equal(h.calls.length, 0);
  const missing = harness({ load: () => Promise.resolve({ fresh: true }) });
  await assert.rejects(missing.registry.ready); assert.equal(missing.writes.length, 0);
});

test("original PassivePointerReads group-first failure can be explicitly retried without replaying the read", async () => {
  const failure = Error("actual group ACK failed"); let attempts = 0, nativeReads = 0;
  const h = harness({ send(_target, method) { if (method === "Runtime.releaseObjectGroup" && ++attempts === 1) return Promise.reject(failure); } });
  await h.registry.ready; const lease = allocate(h); await lease.ready; const group = lease.prepareGroup("group"); const reads = new PassivePointerReads();
  const candidate = reads.start({ scope: { attachment: h.root.attachment }, check: lease.check, decode: value => value,
    read: async () => { nativeReads++; await evaluating(lease); return { x: 1, y: 2, width: 3, height: 4 }; },
    cleanup: async () => { await group.releaseGroup(); group.close(); await lease.release(); } });
  assert.equal(await candidate.result, null); assert.equal(reads.pending.size, 1); assert.deepEqual(h.registry.snapshot().failed, [lease.leaseId]); assert.throws(lease.check);
  await assert.rejects(reads.drain(() => true, { retryFailed: true }), error => error === failure); assert.equal(attempts, 1);
  await h.registry.retry(lease.leaseId); await reads.drain(() => true, { retryFailed: true });
  assert.equal(attempts, 2); assert.equal(nativeReads, 1); assert.equal(reads.pending.size, 0); assert.equal(h.clients.size, 0);
});

test("cleanup absence requires actual allocation drain then a second exact native query, not an event", async () => {
  const allocation = deferred(), proof = deferred(); let destroyed = false;
  const failure = Error("No target with given id child.");
  const h = harness({ send(_target, method) {
    if (method === "Runtime.evaluate") return allocation.promise;
    if (method === "Runtime.releaseObjectGroup") { destroyed = true; return Promise.reject(failure); }
    if (method === "Target.getTargetInfo" && destroyed) return proof.promise;
  } });
  await h.registry.ready; const lease = allocate(h); await lease.ready;
  const group = lease.prepareGroup("first"); lease.prepareGroup("held"); const actual = evaluating(lease, "held");
  const cleanup = group.releaseGroup(); h.registry.observeDetach({ targetId: "child" }); await tick();
  assert.equal(h.calls.filter(c => c.method === "Target.getTargetInfo").length, 1); assert.equal(h.registry.snapshot().leases[0].retiredByNativeAbsence, false);
  h.clients.delete("child"); allocation.resolve({ result: { objectId: "late-exception-result" }, exceptionDetails: { exception: { objectId: "late-exception" } } }); await actual; await tick();
  assert.equal(h.calls.filter(c => c.method === "Target.getTargetInfo").length, 2); assert.equal(h.registry.snapshot().leases.length, 1);
  proof.reject(Error("No target with given id child.")); await cleanup; group.close();
  const evidence = await lease.release(); assert.equal(evidence.detached, false); assert.equal(evidence.retiredByNativeAbsence, true);
  assert.equal(evidence.absenceEvidence[0].trigger, failure); assert.match(evidence.absenceEvidence[0].queryError.message, /^No target with given id child\.$/);
  assert.equal(h.calls.some(c => c.method === "detach"), false); assert.deepEqual(h.stored.records, []);
});

test("a late old target event plus an existing client cannot turn an earlier absence error into cleanup", async () => {
  const failure = Error("No target with given id child."); let attempts = 0;
  const h = harness({ send(_target, method) { if (method === "Runtime.releaseObjectGroup" && ++attempts === 1) return Promise.reject(failure); } });
  await h.registry.ready; const lease = allocate(h); await lease.ready; lease.prepareGroup("group");
  h.registry.observeDetach({ targetId: "child" }); await assert.rejects(lease.release(), error => error === failure);
  assert.equal(h.registry.snapshot().leases[0].retiredByNativeAbsence, false); assert.equal(h.clients.size, 1); assert.equal(h.calls.some(c => c.method === "detach"), false);
  await h.registry.retry(lease.leaseId); assert.equal(h.calls.filter(c => c.method === "detach").length, 1); assert.equal(h.clients.size, 0);
});

test("near-match, wrong-ID and policy errors cannot retire owned cleanup or trigger an absence query", async () => {
  for (const message of ["No target with given id other.", "No target with given id child", "Debugger is not attached", "Debugger is not attached to the target with id: other.", "Permission denied"]) {
    const failure = Error(message), h = harness({ send(_target, method) { if (method === "Runtime.releaseObjectGroup") return Promise.reject(failure); } });
    await h.registry.ready; const lease = allocate(h); await lease.ready; lease.prepareGroup("group"); await assert.rejects(lease.release(), error => error === failure);
    assert.equal(h.calls.filter(c => c.method === "Target.getTargetInfo").length, 1); assert.equal(h.registry.snapshot().leases[0].retiredByNativeAbsence, false); assert.equal(h.clients.size, 1);
  }
});

test("an exact release absence followed by policy or wrong-target query failure retains original cleanup error", async () => {
  for (const queryError of [Error("Permission denied"), Error("No target with given id other.")]) {
    const failure = absent("child"); let released = false;
    const h = harness({ send(_target, method) { if (method === "Runtime.releaseObjectGroup") { released = true; return Promise.reject(failure); } if (method === "Target.getTargetInfo" && released) return Promise.reject(queryError); } });
    await h.registry.ready; const lease = allocate(h); await lease.ready; lease.prepareGroup("group"); await assert.rejects(lease.release(), error => error === failure);
    const state = h.registry.snapshot().leases[0]; assert.equal(state.retiredByNativeAbsence, false); assert.equal(state.absenceEvidence[0].queryError, queryError); assert.equal(h.clients.size, 1);
  }
});

test("detach absence proof and a failed durable clear retry only the clear, without inventing detach ACK", async () => {
  let destroyed = false, clears = 0; const failure = Error("clear actual failure"), detachError = absent("child");
  const h = harness({
    send(_target, method) { if (method === "Target.getTargetInfo" && destroyed) return Promise.reject(absent("child")); },
    detach() { destroyed = true; return Promise.reject(detachError); },
    save(value) { if (value.records.length === 0 && ++clears === 2) return Promise.reject(failure); }
  });
  await h.registry.ready; const lease = allocate(h); await lease.ready; await assert.rejects(lease.release(), error => error === failure);
  const state = h.registry.snapshot().leases[0]; assert.equal(state.detached, false); assert.equal(state.retiredByNativeAbsence, true); const count = h.calls.length;
  const result = await h.registry.retry(lease.leaseId); assert.equal(h.calls.length, count); assert.equal(result.detached, false); assert.equal(result.retiredByNativeAbsence, true); assert.deepEqual(h.stored.records, []);
});

test("recognized recovered ledger may retire exact absent host without enumeration or a fake detach ACK", async () => {
  const original = Error("No target with given id child.");
  const h = harness({ ledger: { version: 1, incarnation: "browser-original", records: [row()] }, send: () => Promise.reject(original) });
  await h.registry.ready; const result = await h.registry.recover("original");
  assert.deepEqual(h.calls.map(c => c.method), ["Target.getTargetInfo"]); assert.equal(result.detached, false); assert.equal(result.retiredByNativeAbsence, true); assert.equal(result.absenceEvidence[0].queryError, original); assert.deepEqual(h.stored.records, []);
});

test("prepared cleanup retry preserves all-group ACK then reverse detach for three original child routes", async () => {
  const failure = Error("first original child group failed"); let failed = false, nativeReads = 0;
  const h = harness({ send(target, method) {
    if (method === "Runtime.releaseObjectGroup" && target.targetId === "child-0" && !failed) { failed = true; return Promise.reject(failure); }
  } });
  await h.registry.ready; const leases = [], groups = [];
  for (let depth = 0; depth < 3; depth++) {
    const lease = h.registry.acquire({ root: h.root, targetId: `child-${depth}`, parentFrameId: depth ? `child-${depth - 1}` : "parent" });
    assert.ok(lease); await lease.ready; leases.push(lease); groups.push(lease.prepareGroup(`group-${depth}`));
  }
  const reads = new PassivePointerReads();
  const candidate = reads.start({ scope: { attachment: h.root.attachment }, check() {}, decode: value => value,
    read: async () => { nativeReads++; await Promise.all(leases.map((lease, depth) => evaluating(lease, `group-${depth}`))); return { x: 1, y: 2, width: 3, height: 4 }; },
    cleanup: async () => { for (const group of groups) { await group.releaseGroup(); group.close(); } for (const lease of [...leases].reverse()) await lease.release(); } });
  assert.equal(await candidate.result, null); assert.equal(reads.pending.size, 1);
  const before = h.calls.length;
  assert.equal(h.registry.prepareCleanupRetry(leases[0].leaseId), true);
  assert.equal(h.registry.prepareCleanupRetry(leases[1].leaseId), false);
  assert.equal(h.registry.prepareCleanupRetry(leases[2].leaseId), false);
  assert.equal(h.calls.length, before); assert.throws(leases[0].check); assert.equal(allocate(h, "child-0"), null);
  await reads.drain(() => true, { retryFailed: true });
  assert.deepEqual(h.calls.slice(before).map(call => [call.method, call.target.targetId]), [
    ["Runtime.releaseObjectGroup", "child-0"], ["Runtime.releaseObjectGroup", "child-1"], ["Runtime.releaseObjectGroup", "child-2"],
    ["detach", "child-2"], ["detach", "child-1"], ["detach", "child-0"]
  ]);
  assert.equal(nativeReads, 1); assert.equal(h.clients.size, 0); assert.equal(reads.pending.size, 0);
  const after = h.calls.length; assert.equal(h.registry.prepareCleanupRetry(leases[0].leaseId), false); assert.equal(h.calls.length, after);
});

test("cleanup retry preparation never resets an actual pending group or full release", async () => {
  const failure = Error("original release error"), second = deferred(); let attempts = 0;
  const h = harness({ send(_target, method) { if (method === "Runtime.releaseObjectGroup") return ++attempts === 1 ? Promise.reject(failure) : second.promise; } });
  await h.registry.ready; const lease = allocate(h); await lease.ready; const group = lease.prepareGroup("group");
  await assert.rejects(group.releaseGroup(), error => error === failure);
  assert.equal(h.registry.prepareCleanupRetry(lease.leaseId), true); const pendingGroup = group.releaseGroup(); await tick();
  const before = h.calls.length; assert.equal(h.registry.prepareCleanupRetry(lease.leaseId), false); assert.equal(group.releaseGroup(), pendingGroup);
  const release = lease.release(); await tick(); assert.equal(h.registry.prepareCleanupRetry(lease.leaseId), false);
  assert.equal(lease.release(), release); assert.equal(h.registry.retry(lease.leaseId), release); assert.equal(h.calls.length, before);
  assert.throws(lease.check); assert.equal(allocate(h), null); second.resolve({}); await release;
  assert.equal(attempts, 2); assert.equal(h.calls.filter(call => call.method === "detach").length, 1);
});

test("prepared detach retry skips already released children and never releases a successor lease", async () => {
  const failure = Error("original first detach failed"); let fail = true;
  const h = harness({ detach(target) { if (target.targetId === "child-0" && fail) return Promise.reject(failure); } });
  await h.registry.ready; const first = allocate(h, "child-0"), second = allocate(h, "child-1"); await Promise.all([first.ready, second.ready]);
  await second.release(); await assert.rejects(first.release(), error => error === failure); fail = false;
  const successor = allocate(h, "child-1"); await successor.ready;
  const before = h.calls.length; assert.equal(h.registry.prepareCleanupRetry(second.leaseId), false); successor.check();
  assert.equal(h.registry.prepareCleanupRetry(first.leaseId), true); assert.equal(h.calls.length, before); assert.throws(first.check);
  await first.release(); successor.check(); assert.equal(h.clients.has("child-1"), true); await successor.release();
});

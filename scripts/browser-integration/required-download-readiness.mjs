import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { downloadScope } from "./download-waits-fixture.mjs";
import { assertNegativeRelay } from "./original-download-negative-cases.mjs";

const unavailable = /OBU_DOWNLOAD_PATH_UNAVAILABLE/;
const retired = /OBU_DOWNLOAD_PATH_UNAVAILABLE|OBU_DOWNLOAD_WAIT_EXPIRED/;
const describe = error => error?.stack ?? String(error);

// Serialized into the isolated worker. This observes only the exact fixture
// tab. The optional gate holds delivery of one successful native Page.enable
// ACK, never its invocation, arguments, result, or the production deadline.
export function installRequiredDownloadProbe(api, target, options) {
  const scopeFields = ["session_id", "turn_id", "control_epoch"];
  const { id, tabId, scope, hold = false, holdTimeoutMs = 20000, installBefore } = options ?? {};
  if (typeof id !== "string" || !id || !Number.isSafeInteger(tabId) || tabId < 0 ||
      !scope?.session_id || !scope.turn_id || !Number.isSafeInteger(scope.control_epoch) || scope.control_epoch < 1 ||
      typeof hold !== "boolean" || !Number.isInteger(holdTimeoutMs) || holdTimeoutMs < 20 || holdTimeoutMs > 20000 ||
      (installBefore !== undefined && (!Number.isSafeInteger(installBefore) || Date.now() >= installBefore)) ||
      target.__requiredDownloadProbe || target.__integrationNativeRPCObserver) throw Error("Invalid required-download probe installation");
  const original = api.debugger.sendCommand, records = [], requests = new Map();
  let sequence = 0, bytes = 0, overflow = false, recordingErrors = 0, nativePending = 0, deliveryPending = 0;
  let selected = false, released = false, restored = false, watchdog = false, timer, releaseGate;
  const gate = new Promise(resolve => { releaseGate = resolve; });
  const append = value => {
    try {
      const row = { sequence: ++sequence, at: Date.now(), ...structuredClone(value) };
      const size = JSON.stringify(row).length;
      if (records.length >= 256 || bytes + size > 131072) { overflow = true; return row; }
      records.push(row); bytes += size; return row;
    } catch { recordingErrors++; return { sequence: ++sequence }; }
  };
  const release = (reason = "explicit") => {
    if (!released) { released = true; clearTimeout(timer); append({ kind: "release", reason }); releaseGate(); }
    return snapshot();
  };
  function wrapper(...args) {
    const [source, method, params] = args;
    const enable = source?.tabId === tabId && source.sessionId == null && method === "Page.enable";
    const input = source?.tabId === tabId && typeof method === "string" && method.startsWith("Input.");
    if (!enable && !input) return Reflect.apply(original, this, args);
    const send = append({ kind: "send", source, method, params: params ?? {} });
    const take = hold && enable && !selected && [...requests.values()].some(row => row.method === "armDownloadWait" && row.requirePath === true);
    if (take) selected = true;
    nativePending++;
    let native;
    try { native = Reflect.apply(original, this, args); }
    catch (error) { nativePending--; append({ kind: "native-settled", sendSequence: send.sequence, ok: false, error: String(error) }); throw error; }
    if (!native || typeof native.then !== "function") { nativePending--; recordingErrors++; return native; }
    const observed = native.then(value => {
      nativePending--; append({ kind: "native-settled", sendSequence: send.sequence, ok: true }); return value;
    }, error => { nativePending--; append({ kind: "native-settled", sendSequence: send.sequence, ok: false, error: String(error) }); throw error; });
    observed.catch(() => {});
    if (!take) return native;
    return observed.then(async value => {
      deliveryPending++; append({ kind: "held", sendSequence: send.sequence });
      if (!released) timer = setTimeout(() => { watchdog = true; release("watchdog"); }, holdTimeoutMs);
      await gate;
      deliveryPending--; append({ kind: "published", sendSequence: send.sequence });
      return value;
    });
  }
  const onEvent = (source, method, params) => {
    if (source?.tabId === tabId && ["Page.downloadWillBegin", "Page.downloadProgress"].includes(method))
      append({ kind: "page-event", source, method, params });
  };
  const onRPC = (direction, message) => {
    if (direction === "request") {
      const p = message?.params;
      if (!["armDownloadWait", "collectDownloadWait", "cancelDownloadWait"].includes(message?.method) || p?.tabId !== tabId ||
          !scopeFields.every(key => p[key] === scope[key])) return;
      if (typeof message.id !== "string" || message.id.length > 128 || requests.has(message.id) || requests.size >= 32) { overflow = true; return; }
      requests.set(message.id, append({ kind: "request", requestId: message.id, method: message.method, scope,
        ...(message.method === "armDownloadWait" ? { requirePath: p.requirePath, timeoutMs: p.timeoutMs } : { waiterId: p.waiterId }) }));
    } else if (direction === "response" && requests.has(message?.id)) {
      const request = requests.get(message.id);
      append({ kind: "response", requestId: message.id, requestSequence: request.sequence, ok: !message.error,
        ...(message.error ? { error: String(message.error.message ?? message.error).slice(0, 4096) } : { result: message.result }) });
    }
  };
  function snapshot() { return structuredClone({ version: 1, id, tabId, scope, hold, records, overflow, recordingErrors,
    nativePending, deliveryPending, selected, released, restored, watchdog }); }
  const controller = { id, snapshot, release, restore() {
    release("restore");
    const changed = api.debugger.sendCommand !== wrapper || target.__integrationNativeRPCObserver !== onRPC || target.__requiredDownloadProbe !== controller;
    if (api.debugger.sendCommand === wrapper) api.debugger.sendCommand = original;
    api.debugger.onEvent.removeListener(onEvent);
    if (target.__integrationNativeRPCObserver === onRPC) delete target.__integrationNativeRPCObserver;
    if (target.__requiredDownloadProbe === controller) delete target.__requiredDownloadProbe;
    restored = !changed;
    if (changed) throw Error("Required-download probe was replaced");
    if (nativePending || deliveryPending) throw Error("Required-download native setup has not settled");
    return snapshot();
  } };
  api.debugger.sendCommand = wrapper; api.debugger.onEvent.addListener(onEvent);
  target.__integrationNativeRPCObserver = onRPC; target.__requiredDownloadProbe = controller;
  return snapshot();
}

export function assertRequiredDownloadProbe(probe, { complete = false, held = false } = {}) {
  assert.equal(probe.version, 1); assert.equal(probe.overflow, false); assert.equal(probe.recordingErrors, 0); assert.equal(probe.watchdog, false);
  assert.ok(probe.records.every((row, index) => row.sequence === index + 1));
  assert.equal(probe.records.filter(row => row.kind === "send" && row.method.startsWith("Input.")).length, 0, "Rejected preparation must not dispatch input");
  assert.equal(probe.records.filter(row => row.kind === "page-event").length, 0, "No Page download may begin or progress");
  for (const row of probe.records.filter(row => row.kind === "request" && row.method === "armDownloadWait")) assert.equal(row.requirePath, true);
  if (held || probe.hold && complete) {
    const holds = probe.records.filter(row => row.kind === "held"); assert.equal(holds.length, 1);
    const sends = probe.records.filter(row => row.sequence === holds[0].sendSequence);
    assert.equal(sends.length, 1); assert.equal(sends[0].method, "Page.enable"); assert.equal(sends[0].source.tabId, probe.tabId); assert.equal(sends[0].source.sessionId, undefined);
    const ack = probe.records.filter(row => row.kind === "native-settled" && row.sendSequence === sends[0].sequence);
    assert.equal(ack.length, 1); assert.equal(ack[0].ok, true); assert.ok(sends[0].sequence < ack[0].sequence && ack[0].sequence < holds[0].sequence);
    if (held) { assert.equal(probe.deliveryPending, 1); assert.equal(probe.released, false); assert.equal(probe.records.filter(row => row.kind === "published").length, 0); }
    if (complete) {
      const publication = probe.records.filter(row => row.kind === "published"); assert.equal(publication.length, 1);
      assert.equal(publication[0].sendSequence, sends[0].sequence); assert.ok(publication[0].sequence > holds[0].sequence);
      assert.ok(probe.records.some(row => row.kind === "release" && row.reason === "explicit" && row.sequence < publication[0].sequence));
    }
  }
  if (complete) { assert.equal(probe.restored, true); assert.equal(probe.nativePending, 0); assert.equal(probe.deliveryPending, 0); }
  return { inputCommands: 0, pageEvents: 0, heldACKs: probe.records.filter(row => row.kind === "held").length };
}

export function assertRequiredDownloadRejection(trace, method, error, { waiterId, allowExpired = false } = {}) {
  const requests = trace.records.filter(row => row.kind === "request" && row.method === method && (waiterId === undefined || row.waiterId === waiterId));
  assert.ok(requests.length > 0, "The public request must reach the backend; a local SDK error is insufficient");
  const request = requests.at(-1), responses = trace.records.filter(row => row.kind === "response" && row.requestSequence === request.sequence);
  assert.equal(responses.length, 1); assert.equal(responses[0].ok, false); assert.ok(responses[0].sequence > request.sequence);
  assert.match(responses[0].error, allowExpired ? retired : unavailable);
  assert.equal(error, responses[0].error, "Preserve the exact backend rejection");
  return { request, response: responses[0] };
}

export function assertRequiredDownloadRPCs(item) {
  const { trace } = item, requests = trace.records.filter(row => row.kind === "request"), responses = trace.records.filter(row => row.kind === "response");
  const readyCase = item.label === "ready-disconnect-rebind";
  assert.deepEqual(requests.map(row => row.method), readyCase
    ? ["armDownloadWait", "collectDownloadWait", "collectDownloadWait", "armDownloadWait", "cancelDownloadWait"]
    : ["armDownloadWait"], "No preparation, collection or cancellation may be replayed");
  assert.equal(new Set(requests.map(row => row.requestId)).size, requests.length);
  assert.equal(responses.length, requests.length);
  let armIndex = 0, collectIndex = 0;
  for (const request of requests) {
    assert.deepEqual(request.scope, item.scope);
    const replies = responses.filter(row => row.requestSequence === request.sequence);
    assert.equal(replies.length, 1, "Every original public request needs exactly one final response");
    const response = replies[0]; assert.equal(response.requestId, request.requestId); assert.ok(response.sequence > request.sequence);
    if (request.method === "armDownloadWait") {
      const arm = item.arms[armIndex++]; assert.equal(arm.settled, true); assert.equal(request.requirePath, true);
      assert.ok(Number.isInteger(request.timeoutMs) && request.timeoutMs > 0 && request.timeoutMs <= arm.timeoutMs);
      assert.equal(response.ok, arm.ready);
      if (arm.ready) {
        assert.ok(typeof arm.waiterId === "string" && arm.waiterId.length > 0);
        assert.ok(Number.isFinite(arm.remainingMs) && arm.remainingMs > 0 && arm.remainingMs <= request.timeoutMs);
        assert.deepEqual(response.result, { waiterId: arm.waiterId, remainingMs: arm.remainingMs }, "SDK ready must be the original backend acknowledgement");
      } else { assert.match(response.error, unavailable); assert.equal(response.error, arm.error); }
    } else if (request.method === "collectDownloadWait") {
      const collect = item.collects[collectIndex++];
      assert.equal(request.waiterId, item.ready.waiterId); assert.equal(response.ok, false);
      assert.match(response.error, retired); assert.equal(response.error, collect.error);
      assert.deepEqual(request, collect.proof.request); assert.deepEqual(response, collect.proof.response);
    } else {
      assert.equal(request.waiterId, item.freshReady.waiterId); assert.equal(response.ok, true); assert.deepEqual(response.result, {});
      assert.equal(item.freshCancelled, true);
    }
  }
  assert.equal(armIndex, item.arms.length); assert.equal(collectIndex, item.collects?.length ?? 0);
  return { requests: requests.length, responses: responses.length, ready: item.arms.filter(row => row.ready).length };
}

export function assertRequiredDownloadZero(item, server) {
  assert.equal(item.before.documents.length, 1); assert.equal(item.after.documents.length, 1);
  const before = item.before.documents[0], after = item.after.documents[0];
  assert.equal(after.documentId, before.documentId); assert.equal(after.frameId, 0); assert.equal(after.result.href, item.url);
  assert.equal(after.result.state.key, item.key); assert.equal(after.result.state.documentToken, before.result.state.documentToken);
  assert.deepEqual(before.result.state.clicks, []); assert.deepEqual(before.result.state.frameAdds, []);
  assert.deepEqual(after.result.state.clicks, []); assert.deepEqual(after.result.state.frameAdds, []);
  assert.equal(server.key, item.key); assert.equal(server.consumed, false);
  assert.equal(server.requests.filter(row => row.method === "POST" || row.url === "/report").length, 0);
  assert.equal(server.gets.length, 1, "Do not reload the original document");
  assert.equal(item.after.tab.id, item.tabId); assert.equal(item.after.tab.url, item.url);
  assertRequiredDownloadProbe(item.trace, { complete: true });
  return { clicks: 0, posts: 0, nativeInput: 0, pageDownloads: 0, documentId: after.documentId, documentToken: after.result.state.documentToken };
}

async function bounded(promise, label, timeoutMs = 7000) {
  let timer;
  try { return await Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(Error(`Required-download ${label} timed out`)), timeoutMs); })]); }
  finally { clearTimeout(timer); }
}

export async function checkRequiredDownloadReadiness({ owner, worker, fixture, fixtureURL, until, bind, connectionState, detail = {} }) {
  Object.assign(detail, { passed: false, cases: [], bindings: [], connections: [], relays: [], cleanup: [],
    boundary: "JS required-path preparation on fresh exact POST fixtures. Explicit Browser relay disconnection and one held successful Page.enable ACK publication are controlled faults, not natural transport loss. No business click, download replay, inferred path or Native Port restart." });
  const tabs = [], relays = [], waiters = [], generations = new Set();
  let current, installed, activeItem, pendingArm, primary, originalConnection, originalScope;
  const control = method => bounded(worker.evaluate(`(()=>{const p=globalThis.__requiredDownloadProbe;if(!p||p.id!==${JSON.stringify(activeItem?.probeId)})throw Error('Required-download probe missing/replaced');return p[${JSON.stringify(method)}]()})()`), `probe ${method}`);
  const identity = async label => {
    const value = await connectionState();
    assert.equal(value.nativeSocketReadyState, 1); assert.equal(value.hostExitCode, null); assert.ok(Number.isSafeInteger(value.hostPid) && value.hostPid > 0);
    originalConnection ??= value; assert.deepEqual(value, originalConnection, "The original Native Port/host must stay alive");
    assert.deepEqual(downloadScope(owner), originalScope); detail.connections.push({ label, value });
  };
  const info = async available => {
    const value = await owner.client.getInfo(); assert.equal(value.metadata.downloadWaitPathVersion, 1);
    assert.equal(value.metadata.pageDownloads.available, available); return value;
  };
  const unavailableInfo = () => until(async () => { const value = await owner.client.getInfo(); return value.metadata.pageDownloads.available === false ? value : false; }, "required original Browser binding revoked", 5000);
  const openBinding = async label => {
    const result = await bounded(bind(), "production binding", 30000); current = result.relay; relays.push(current);
    const available = await info(true), generation = available.metadata.pageDownloads.generation;
    assert.ok(typeof generation === "string" && generation && !generations.has(generation)); generations.add(generation);
    assert.equal(result.binding.result.bound, true); assert.equal(result.binding.result.generation, generation);
    assert.equal(result.bindingProcess.closeObserved, true); assert.equal(result.bindingProcess.exitCode, 0);
    detail.bindings.push({ label, binding: result.binding, bindingProcess: result.bindingProcess, capabilities: available, proof: result.proof });
    if (detail.bindings.length > 1) for (const key of ["extensionId", "extensionInstanceId", "workerBootId", "portId"])
      assert.equal(result.proof[key], detail.bindings[0].proof[key]);
    await identity(label); return available;
  };
  const cut = async label => {
    assert.ok(current); const evidence = { label, requestedAt: Date.now() };
    await bounded(current.disconnect(), "actual relay disconnect", 7000);
    evidence.closedAt = Date.now(); evidence.capabilities = await unavailableInfo();
    const snapshot = current.snapshot(); assertNegativeRelay(snapshot);
    assert.equal(snapshot.upstream.closeObserved, true); assert.equal(snapshot.downstream.closeObserved, true);
    assert.ok(snapshot.faultInjection?.actualCloseObserved); evidence.relay = snapshot;
    await identity(label); return evidence;
  };
  const readPage = tabId => bounded(worker.evaluate(`(async()=>({tab:await chrome.tabs.get(${tabId}),documents:await chrome.scripting.executeScript({target:{tabId:${tabId},frameIds:[0]},world:'MAIN',func:()=>({href:location.href,state:JSON.parse(document.querySelector('#state').textContent)})})}))()`), "original page read");
  const startCase = async (label, hold = false) => {
    const record = fixture.createCase({ kind: "post", owner: `required-${label}`, variant: "root" });
    const item = { label, key: record.key, url: new URL(record.urlPath, fixtureURL).href, scope: downloadScope(owner), probeId: randomUUID(), passed: false };
    detail.cases.push(item); activeItem = item;
    const tab = await owner.newTab(); tabs.push({ tab, item }); item.tabId = tab.id;
    item.createdTab = await bounded(worker.evaluate(`chrome.tabs.get(${tab.id})`), "created fixture identity");
    await owner.cdp.navigate(tab.id, item.url);
    assert.equal(await tab.getByRole("button", { name: "Download original report", exact: true }).textContent({ timeoutMs: 5000 }), "Download original report");
    item.before = await readPage(tab.id); assert.equal(item.before.tab.url, item.url); assert.equal(item.before.tab.active, false);
    installed = true;
    item.installation = await bounded(worker.evaluate(`(${installRequiredDownloadProbe.toString()})(chrome,globalThis,${JSON.stringify({ id: item.probeId, tabId: tab.id, scope: item.scope, hold, installBefore: Date.now() + 6000 })})`), "probe installation");
    return { tab, item };
  };
  const startArm = (tab, item) => {
    const record = { startedAt: Date.now(), timeoutMs: 15000, settled: false, ready: false }; (item.arms ??= []).push(record);
    const promise = tab.expectDownload({ timeoutMs: record.timeoutMs, requirePath: true }).then(waiter => {
      Object.assign(record, { settled: true, ready: true, settledAt: Date.now(), waiterId: waiter.waiterId, remainingMs: waiter.remainingMs });
      waiters.push({ waiter, item }); return { waiter };
    }, error => { Object.assign(record, { settled: true, settledAt: Date.now(), error: error?.message ?? String(error) }); return { error }; });
    pendingArm = promise; return { record, promise };
  };
  const rejectedArm = async (arm, item) => {
    const value = await bounded(arm.promise, "original arm result", 17000); assert.ok(value.error, "Required preparation unexpectedly became ready");
    assert.match(arm.record.error, unavailable); item.rejection = assertRequiredDownloadRejection(await control("snapshot"), "armDownloadWait", arm.record.error);
  };
  const rejectedCollect = async (waiter, item, label) => {
    let error; try { await bounded(waiter.result(), "original waiter collect", 6000); } catch (value) { error = value; }
    assert.ok(error, "The old required waiter regained authority"); const message = error?.message ?? String(error); assert.match(message, retired);
    (item.collects ??= []).push({ label, error: message, proof: assertRequiredDownloadRejection(await control("snapshot"), "collectDownloadWait", message, { waiterId: waiter.waiterId, allowExpired: true }) });
  };
  const finishCase = async item => {
    item.beforeRestore = await control("snapshot"); assertRequiredDownloadProbe(item.beforeRestore);
    item.trace = await control("restore"); installed = false;
    item.rpc = assertRequiredDownloadRPCs(item);
    item.after = await readPage(item.tabId); item.server = fixture.stats(item.key); item.zero = assertRequiredDownloadZero(item, item.server);
    await identity(item.label); item.passed = true; pendingArm = null;
  };
  try {
    await owner.client.getTabs(); originalScope = downloadScope(owner); detail.scope = originalScope;
    detail.initialCapabilities = await info(false); await identity("initial");
    {
      const { tab, item } = await startCase("unbound"); await rejectedArm(startArm(tab, item), item); await finishCase(item);
    }
    {
      const available = await openBinding("cached-info"); const { tab, item } = await startCase("cached-info-disconnect"); item.cachedInfo = available;
      item.disconnect = await cut("after-getInfo"); await rejectedArm(startArm(tab, item), item); await finishCase(item);
    }
    {
      await openBinding("arm-in-flight"); const { tab, item } = await startCase("arm-in-flight", true); const arm = startArm(tab, item);
      await Promise.race([until(async () => { const snapshot = await control("snapshot"); return snapshot.deliveryPending === 1 ? snapshot : false; }, "successful original Page.enable ACK held", 5000),
        arm.promise.then(value => { throw value.error ?? Error("Required arm became ready before held ACK"); })]);
      item.held = await control("snapshot"); assertRequiredDownloadProbe(item.held, { held: true });
      item.disconnect = await cut("arm-before-ready"); item.beforeRelease = { ...arm.record }; assert.equal(item.beforeRelease.ready, false);
      item.released = await control("release"); await rejectedArm(arm, item);
      await until(async () => { const s = await control("snapshot"); return s.nativePending === 0 && s.deliveryPending === 0; }, "original Page.enable publication drained", 5000);
      await finishCase(item);
    }
    {
      await openBinding("ready"); const { tab, item } = await startCase("ready-disconnect-rebind"); const arm = startArm(tab, item), value = await bounded(arm.promise, "required ready", 17000);
      assert.ok(value.waiter); assert.ok(arm.record.remainingMs > 0 && arm.record.remainingMs <= 15000); item.ready = { ...arm.record };
      item.disconnect = await cut("after-ready"); await rejectedCollect(value.waiter, item, "disconnected");
      await openBinding("replacement"); await rejectedCollect(value.waiter, item, "rebound");
      const fresh = startArm(tab, item), freshValue = await bounded(fresh.promise, "fresh required ready", 17000); assert.ok(freshValue.waiter);
      assert.notEqual(freshValue.waiter.waiterId, value.waiter.waiterId); item.freshReady = { ...fresh.record };
      await bounded(freshValue.waiter.cancel(), "fresh waiter cancellation"); item.freshCancelled = true;
      await finishCase(item);
    }
    detail.passed = true;
  } catch (error) { primary = error; detail.error = describe(error); }
  finally {
    const cleanup = async (kind, run) => { const record = { kind, ok: false }; detail.cleanup.push(record); try { await run(record); record.ok = true; } catch (error) { record.error = describe(error); primary ??= error; } };
    if (installed) await cleanup("release-held-ACK", async record => { record.snapshot = await control("release"); });
    if (pendingArm) await cleanup("settle-original-arm", () => bounded(pendingArm, "cleanup original arm", 17000));
    if (installed) {
      await cleanup("drain-native-setup", () => until(async () => { const s = await control("snapshot"); return s.nativePending === 0 && s.deliveryPending === 0; }, "cleanup native setup", 5000));
      await cleanup("restore-probe", async record => { record.snapshot = await control("restore"); activeItem.finalTrace = record.snapshot; installed = false; });
    }
    for (const { waiter } of waiters) await cleanup(`cancel-waiter:${waiter.waiterId}`, () => bounded(waiter.cancel(), "cleanup waiter"));
    for (const relay of relays) await cleanup("close-original-relay", () => bounded(relay.close(), "relay close", 12000));
    await cleanup("final-unavailable", async record => { detail.finalCapabilities = await unavailableInfo(); assert.equal(detail.finalCapabilities.metadata.downloadWaitPathVersion, 1); await identity("final-unavailable"); record.available = false; });
    for (const { tab, item } of tabs) await cleanup(`close-exact-tab:${tab.id}`, async () => {
      const live = await bounded(worker.evaluate(`chrome.tabs.get(${tab.id})`), "exact fixture identity");
      const original = item.before?.tab ?? item.createdTab;
      for (const key of ["id", "windowId", "groupId", "pinned"]) assert.equal(live[key], original[key], `Fixture tab changed ${key}`);
      assert.ok(live.url === (item.before?.tab.url ?? item.createdTab.url) || !item.before && live.url === item.url, "Fixture tab URL changed");
      await bounded(tab.close(), "exact fixture tab close");
    });
    await cleanup("exact-tab-target-absence", async () => {
      const ids = tabs.map(({ tab }) => tab.id); detail.after = await bounded(worker.evaluate(`(async()=>({tabIds:${JSON.stringify(ids)},tabs:(await chrome.tabs.query({})).filter(t=>${JSON.stringify(ids)}.includes(t.id)),targets:(await chrome.debugger.getTargets()).filter(t=>${JSON.stringify(ids)}.includes(t.tabId))}))()`), "native cleanup evidence");
      assert.deepEqual(detail.after.tabs, []); assert.deepEqual(detail.after.targets, []);
    });
    await cleanup("complete-relay-evidence", async () => {
      detail.relays = relays.map(relay => relay.snapshot());
      for (const snapshot of detail.relays) {
        const records = assertNegativeRelay(snapshot); assert.equal(snapshot.attemptCount, 1); assert.deepEqual(snapshot.errors, []);
        assert.equal(snapshot.upstream.closeObserved, true); assert.equal(snapshot.downstream.closeObserved, true); assert.equal(snapshot.server.closeObserved, true);
        assert.equal(records.filter(row => ["Browser.downloadWillBegin", "Browser.downloadProgress", "Browser.cancelDownload"].includes(row.json?.method)).length, 0);
      }
      for (const item of detail.cases) { item.finalServer = fixture.stats(item.key); assert.equal(item.finalServer.requests.filter(row => row.method === "POST" || row.url === "/report").length, 0); }
    });
    if (primary) { detail.passed = false; primary.requiredDownloadReadinessDetail = detail; }
  }
  if (primary) throw primary;
  return detail;
}

import assert from "node:assert/strict";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { installManagedUserBridge } from "./managed-user-bridge.js";

const runId = "0123456789abcdef0123456789abcdef";
const config = { version: 1, nativeHostName: `com.openbrowseruse.managed.n${runId}` };
const key = "a".repeat(64);
const deferred = () => { let resolve, reject; const promise = new Promise((a, b) => { resolve = a; reject = b; }); return { promise, resolve, reject }; };
const flush = async () => { await delay(0); };

function fixture(t, options = {}) {
  let time = 0, channelCount = 0;
  const timers = new Set(), events = [], subscriptions = [], calls = [], state = { state: "running", revision: 0, cleanupComplete: false };
  const proof = Object.freeze({ nonce: "native-challenge", extensionId: "a".repeat(32), extensionInstanceId: "instance", workerBootId: "worker", portId: "port" });
  const target = { __obuNativeDownloadBinding: proof, __obuManagedViewerEvent: raw => events.push(JSON.parse(raw)) };
  const f = { target, events, subscriptions, calls, state, liveTabs: [{ id: 7, title: "Owned tab", url: "https://example.test/" }], resumeGate: null, subscribeGate: null, closeGate: null,
    openArgs: { version: 1, runId, extensionId: proof.extensionId, extensionInstanceId: proof.extensionInstanceId, workerBootId: proof.workerBootId, portId: proof.portId, channelKey: key } };
  const backend = {
    onManagedNativeLoss(listener) { f.nativeLostListener = listener; },
    async waitManagedNativeRecovery(epoch) { await epoch?.promise; },
    async prepareManagedUserOpen() {
      const epoch = f.nativeEpoch;
      await backend.waitManagedNativeRecovery(epoch);
      return epoch;
    },
    commitManagedUserOpen(epoch) {
      if (epoch !== f.nativeEpoch) throw new Error("OBU_MANAGED_NATIVE_CHANGED");
      if (epoch && (state.state !== "paused" || !state.cleanupComplete)) throw new Error("OBU_MANAGED_NATIVE_PAUSE_INCOMPLETE");
      f.openCommitted = true;
    },
    async getAutomationControlStatus() { return { ...state }; },
    async getManagedViewerTabs() { return f.liveTabs; },
    async managedViewerSubscribe(tabId, onFrame) {
      calls.push(["subscribe", tabId]);
      const closed = deferred();
      const record = { tabId, onFrame, closeCalls: 0, closed, handle: {
        closed: closed.promise,
        async close() { record.closeCalls++; calls.push(["close", tabId]); await f.closeGate?.promise; closed.resolve({ reason: "closed" }); }
      } };
      subscriptions.push(record);
      await f.subscribeGate?.promise;
      return record.handle;
    },
    async pauseAutomation() {
      calls.push(["pause"]); state.state = "pausing";
      await flush(); state.state = "paused"; state.revision++; state.cleanupComplete = true;
      return { ...state };
    },
    async resumeAutomation(revision, assertAuthority) {
      calls.push(["resume", revision]);
      assertAuthority();
      if (revision !== state.revision) throw new Error("OBU_CONTROL_REVISION_CONFLICT");
      if (state.state !== "paused" || !state.cleanupComplete) throw new Error("OBU_AUTOMATION_PAUSE_INCOMPLETE");
      assertAuthority(); await f.resumeGate?.promise; assertAuthority();
      state.state = "running"; state.revision++; state.cleanupComplete = false;
      return { ...state };
    }
  };
  f.backend = backend;
  f.api = installManagedUserBridge({ config, backend, getInstanceId: async () => proof.extensionInstanceId, target,
    now: () => time, wallNow: () => 1700000000000 + time, newChannelId: () => `channel-${++channelCount}`,
    setTimer: (fn, ms) => { const timer = setTimeout(() => { timers.delete(timer); fn(); }, options.fastTimers ? Math.min(ms, 10) : ms); timers.add(timer); return timer; },
    clearTimer: timer => { clearTimeout(timer); timers.delete(timer); }, ...options.install });
  f.open = extra => f.api.open({ ...f.openArgs, ...extra });
  f.request = (operation, extra = {}) => f.api.request({ operation, channelKey: key, ...extra });
  f.frame = (sequence, extra = {}, subscription = subscriptions.at(-1)) => subscription.onFrame({ tabId: subscription.tabId, streamId: `stream-${subscription.tabId}`, sequence,
    mimeType: "image/png", data: Buffer.from(`frame ${sequence}`).toString("base64"), metadata: { deviceWidth: 800, deviceHeight: 600, timestamp: sequence, documentId: "not-proof" }, ...extra });
  f.advance = ms => { time += ms; };
  f.retire = (opened, extra = {}) => f.api.request({ operation: "retire", ...f.openArgs, channelId: opened.channelId, ...extra });
  f.loseNative = () => {
    f.nativeEpoch = deferred(); f.openCommitted = false;
    target.__obuNativeDownloadBinding = undefined;
    state.state = "pausing"; state.cleanupComplete = false;
    f.nativeLostListener(f.nativeEpoch);
    return f.nativeEpoch;
  };
  t.after(async () => {
    f.resumeGate?.resolve(); f.subscribeGate?.resolve(); f.closeGate?.resolve();
    f.humanBeginGate?.resolve(); f.humanInputGate?.resolve(); f.humanCloseGate?.resolve();
    for (const name of ["pageListGate", "pageCommitGate", "pageDeliveryGate", "catalogDrainGate"]) f[name]?.resolve();
    for (const gate of f.dialogGates ?? []) gate.resolve();
    try { await f.request("disconnect"); } catch { /* already revoked */ }
    for (const timer of timers) clearTimeout(timer);
  });
  return f;
}

function humanFixture(t, { inputBudgetVersion, clipboardTransferVersion, fileChooserVersion } = {}) {
  const f = fixture(t);
  f.humans = []; f.dialogGates = []; let dialogCounter = 0;
  f.backend.beginManagedHuman = async (tabId, authority, onFrame, onState, options = {}) => {
    f.calls.push(["humanBegin", tabId]); authority();
    const closed = deferred(), record = { tabId, authority, onFrame, onState, options, closed, closeCalls: 0, inputCalls: 0, dialogClaims: new Set(), dialogPending: new Set(),
      info: { state: "starting", leaseId: `human-${f.humans.length + 1}`, tabId, generation: 0, viewport: { width: 800, height: 600 }, lastInputSequence: 0,
        ...(inputBudgetVersion === undefined ? {} : { inputBudgetVersion }),
        ...(fileChooserVersion === undefined ? {} : { fileChooserVersion }),
        ...(clipboardTransferVersion === undefined ? {} : { clipboardTransferVersion }) } };
    const handle = record.handle = {
      info: () => ({ ...record.info }), closed: closed.promise,
      pendingDialog: () => record.dialog ?? null,
      pendingFileChooser: () => record.chooser ?? null,
      beginFile(envelope) {
        authority();
        if (record.fileClaim) throw new Error("OBU_HUMAN_FILE_STALE");
        record.fileClaim = { ...envelope }; f.calls.push(["humanFileBegin", envelope]);
        return { ...envelope };
      },
      async commitFile(envelope) {
        authority(); f.calls.push(["humanFileCommit", envelope]);
        const { files, ...receipt } = envelope;
        if (record.fileClaim?.transferId !== envelope.transferId) throw new Error("OBU_HUMAN_FILE_STALE");
        record.fileClaim = null;
        await f.fileCommitGate?.promise;
        record.chooser = null;
        return { ...receipt, acknowledged: true, ...(f.fileReplyOverride ?? {}) };
      },
      cancelFile(envelope) {
        authority(); f.calls.push(["humanFileCancel", envelope]); record.chooser = null;
        return { ...envelope, cancelled: true };
      },
      respondDialog(envelope) {
        authority(); const original = record.dialog;
        if (!original || original.dialogId !== envelope.dialogId || record.dialogClaims.has(original.dialogId)) throw new Error("OBU_HUMAN_DIALOG_STALE");
        record.dialogClaims.add(original.dialogId); f.calls.push(["humanDialogRespond", envelope]);
        const gate = f.dialogResponseGate;
        const actual = (async () => {
          await gate?.promise;
          return { leaseId: original.leaseId, generation: original.generation, dialogId: original.dialogId, acknowledged: true, ...(f.dialogReplyOverride ?? {}) };
        })();
        record.dialogPending.add(actual);
        actual.finally(() => record.dialogPending.delete(actual)).catch(() => {});
        return actual;
      },
      input(envelope) {
        authority(); record.inputCalls++; f.calls.push(["humanInput", envelope.sequence]);
        const pending = record.pending = (async () => {
          await f.humanInputGate?.promise;
          authority();
          if (record.info.generation === envelope.generation) record.info.lastInputSequence = envelope.sequence;
          return { leaseId: envelope.leaseId, generation: envelope.generation, sequence: envelope.sequence, acknowledged: true, ...(f.inputReplyOverride ?? {}) };
        })();
        return pending;
      },
      close() {
        if (record.closing) return record.closing;
        record.closeCalls++; record.info.state = "releasing"; closed.resolve({ reason: "released" });
        record.closing = (async () => {
          await Promise.allSettled([record.pending, ...record.dialogPending].filter(Boolean));
          await f.humanCloseGate?.promise;
          if (f.humanCleanupError) throw f.humanCleanupError;
          record.info.state = "released"; f.calls.push(["humanReleased", tabId]);
        })();
        return record.closing;
      }
    };
    f.humans.push(record);
    try {
      await f.humanBeginGate?.promise; authority();
      await f.backend.pauseAutomation(); authority();
      record.info.state = "active";
      if (f.earlyHumanFrame) f.humanFrame(1, {}, record);
      return handle;
    } catch (error) {
      try { await handle.close(); }
      catch (cleanupError) { throw Object.assign(cleanupError, { humanCleanupIncomplete: true }); }
      throw error;
    }
  };
  f.humanFrame = (sequence, extra = {}, record = f.humans.at(-1)) => {
    if (!record.info.generation) record.info.generation = 1;
    record.onFrame({ tabId: record.tabId, streamId: `human-stream-${record.info.leaseId}`, sequence,
      mimeType: "image/png", data: Buffer.from(`human frame ${sequence}`).toString("base64"),
      metadata: { deviceWidth: 800, deviceHeight: 600, pageScaleFactor: 1 },
      controlMode: "human", humanLeaseId: record.info.leaseId, generation: record.info.generation, ...extra });
  };
  f.begin = async () => {
    const result = await f.request("humanBegin", { tabId: 7 });
    f.humanFrame(1); await flush();
    return result;
  };
  f.input = (sequence, extra = {}) => f.request("humanInput", {
    leaseId: f.humans.at(-1).info.leaseId, generation: 1, sequence, input: { type: "text", text: "synthetic" }, ...extra
  });
  f.dialog = (extra = {}, record = f.humans.at(-1)) => {
    record.dialog = { leaseId: record.info.leaseId, generation: record.info.generation, dialogId: `dialog-${++dialogCounter}`, type: "confirm", message: "<b>Original?</b>", ...extra };
    record.onState({ ...record.info }); return record.dialog;
  };
  f.answerDialog = (extra = {}, dialog = f.humans.at(-1).dialog) => f.request("humanDialogRespond", {
    leaseId: dialog.leaseId, generation: dialog.generation, dialogId: dialog.dialogId, accept: true, ...extra
  });
  f.navigate = (generation, record = f.humans.at(-1)) => {
    Object.assign(record.info, { state: "navigating", generation, viewport: null, lastInputSequence: 0 });
    record.onState({ ...record.info });
  };
  f.arrive = (generation, sequence = 1, record = f.humans.at(-1)) => {
    Object.assign(record.info, { state: "active", generation, viewport: { width: 800, height: 600 } });
    record.onState({ ...record.info });
    f.humanFrame(sequence, { streamId: `human-stream-${record.info.leaseId}-g${generation}` }, record);
  };
  return f;
}

for (const version of [1, 2]) test(`v${version} typed file claim, native receipt and logical cancellation remain separate from input receipts`, async t => {
  const f = humanFixture(t, { fileChooserVersion: version }); await f.open(); await f.begin();
  const record = f.humans[0];
  record.chooser = { leaseId: record.info.leaseId, generation: 1, chooserId: "original-file", multiple: true,
    ...(version === 2 ? { directory: false } : {}), source: { origin: "https://child.test", frame: "child" } };
  assert.deepEqual((await f.request("status")).status.pendingFileChooser, record.chooser);
  const request = { leaseId: record.info.leaseId, generation: 1, chooserId: "original-file", transferId: "server-generated" };
  const claim = await f.request("humanFileBegin", request);
  assert.deepEqual(claim.fileChooserClaim, request); assert.equal(claim.inputReceipt, undefined);
  await assert.rejects(f.request("humanFileBegin", request), /FILE_STALE/);
  f.fileCommitGate = deferred();
  const result = f.request("humanFileCommit", { ...request, files: ["C:\\server\\name.txt", "C:\\server\\other.txt"] });
  await flush();
  assert.equal(f.calls.filter(call => call[0] === "humanFileCommit").length, 1);
  f.fileCommitGate.resolve();
  const committed = await result;
  assert.deepEqual(committed.fileChooserReceipt, { ...request, acknowledged: true });
  assert.equal(committed.inputReceipt, undefined); assert.equal(committed.status.pendingFileChooser, null);
  record.chooser = { leaseId: request.leaseId, generation: 1, chooserId: "cancel-me", multiple: false, ...(version === 2 ? { directory: false } : {}) };
  const cancel = { leaseId: request.leaseId, generation: 1, chooserId: "cancel-me" };
  assert.deepEqual((await f.request("humanFileCancel", cancel)).fileChooserCancellation, { ...cancel, cancelled: true });
  await f.request("humanEnd", { leaseId: request.leaseId });
  assert.equal((await f.request("disconnect")).status.pendingFileChooser, null);
});

test("v2 directory claim uses the original typed handle without exposing its server path in the receipt", async t => {
  const f = humanFixture(t, { fileChooserVersion: 2 }); await f.open(); await f.begin();
  const record = f.humans[0], request = { leaseId: record.info.leaseId, generation: 1, chooserId: "directory", transferId: "server-transfer" };
  record.chooser = { leaseId: request.leaseId, generation: 1, chooserId: "directory", directory: true, multiple: false };
  assert.deepEqual((await f.request("status")).status.pendingFileChooser, record.chooser);
  await f.request("humanFileBegin", request); f.fileCommitGate = deferred(); let completed = false;
  const commit = f.request("humanFileCommit", { ...request, files: ["C:\\server\\original-root"] }).then(value => { completed = true; return value; });
  await flush(); assert.equal(completed, false); f.fileCommitGate.resolve();
  assert.deepEqual((await commit).fileChooserReceipt, { ...request, acknowledged: true });
  assert.equal(f.calls.filter(row => row[0] === "humanFileCommit").length, 1);
});

test("file chooser version and directory shape cannot downgrade a directory into a legacy ordinary claim", async t => {
  for (const [version, extra] of [[1, { directory: false }], [1, { directory: true }], [2, {}], [2, { directory: null }], [2, { directory: 1 }], [3, { directory: true }]]) {
    const f = humanFixture(t, { fileChooserVersion: version }); await f.open(); await f.begin();
    const record = f.humans[0], request = { leaseId: record.info.leaseId, generation: 1, chooserId: "original", transferId: "server-transfer" };
    record.chooser = { leaseId: request.leaseId, generation: 1, chooserId: request.chooserId, multiple: true, ...extra };
    await assert.rejects(f.request("humanFileBegin", request), /FILE_STALE/);
    assert.equal(f.calls.some(row => row[0] === "humanFileBegin"), false);
  }
});

test("file operations reject foreign, unadvertised, zero-generation and unsolicited path authority before the native handle", async t => {
  const f = humanFixture(t, { fileChooserVersion: 1 }); await f.open(); await f.begin();
  const record = f.humans[0], request = { leaseId: record.info.leaseId, generation: 1, chooserId: "file", transferId: "transfer" };
  record.chooser = { leaseId: request.leaseId, generation: 1, chooserId: "file", multiple: false };
  for (const changed of [{ leaseId: "foreign" }, { generation: 2 }, { chooserId: "foreign" }, { generation: 0 },
    { files: ["C:\\caller\\path"] }, { source: { origin: "https://forged.test", frame: "child" } }])
    await assert.rejects(f.request("humanFileBegin", { ...request, ...changed }), /FILE_STALE|FILE_INVALID|PROTOCOL/);
  delete record.info.fileChooserVersion;
  await assert.rejects(f.request("humanFileBegin", request), /FILE_STALE/);
  assert.equal(f.calls.some(call => call[0] === "humanFileBegin"), false);
});

test("a mismatched file receipt withdraws the original lease and cannot be called an acknowledgement", async t => {
  const f = humanFixture(t, { fileChooserVersion: 1 }); await f.open(); await f.begin();
  const record = f.humans[0], request = { leaseId: record.info.leaseId, generation: 1, chooserId: "file", transferId: "transfer" };
  record.chooser = { leaseId: request.leaseId, generation: 1, chooserId: "file", multiple: false };
  await f.request("humanFileBegin", request); f.fileReplyOverride = { transferId: "forged" };
  await assert.rejects(f.request("humanFileCommit", { ...request, files: ["C:\\server\\one.txt"] }), /FILE_UNCONFIRMED/);
  assert.equal(record.closeCalls, 1);
  assert.equal((await f.request("status")).status.pendingFileChooser, null);
});

const transferInput = { type: "key", action: "down", key: "x", code: "KeyX", windowsVirtualKeyCode: 88, modifiers: 2, clipboardTransfer: "cut" };
test("human authority retains only its authenticated channel's immutable native browser version", async t => {
  const f = humanFixture(t);
  const browserVersion = { product: "Chrome/156.0.8078.4", revision: "@f842f52ef39fd97b449eb27cff414bf05a98ddce" };
  const expected = { ...browserVersion };
  await f.open({ browserVersion });
  browserVersion.product = "forged successor";
  await f.begin();
  assert.deepEqual(f.humans[0].options.browserVersion, expected);
  assert.equal(Object.isFrozen(f.humans[0].options.browserVersion), true);
});

test("malformed native browser metadata cannot open a user channel or invoke an accessor", async t => {
  let reads = 0;
  for (const browserVersion of [null, {}, { product: "Chrome/x", revision: "@x", userAgent: "forged" },
    { product: "Chrome x", revision: "@x" },
    Object.defineProperty({ revision: "@x" }, "product", { enumerable: true, get() { reads++; return "Chrome/x"; } })]) {
    const f = humanFixture(t);
    await assert.rejects(f.open({ browserVersion }), /IDENTITY|PROTOCOL/);
    assert.equal(f.openCommitted, undefined);
  }
  assert.equal(reads, 0);
});

test("clipboard transfer requires the actual advertised lease and preserves the native receipt", async t => {
  const f = humanFixture(t, { inputBudgetVersion: 1, clipboardTransferVersion: 1 });
  await f.open(); await f.begin();
  assert.equal((await f.request("status")).status.human.clipboardTransferVersion, 1);
  f.inputReplyOverride = { clipboardTransfer: { operation: "cut", status: "ready", text: "中文\ncopy" } };
  const result = await f.input(1, { input: transferInput });
  assert.equal(result.inputReceipt.acknowledged, true);
  assert.deepEqual(result.inputReceipt.clipboardTransfer, f.inputReplyOverride.clipboardTransfer);
});

test("navigation during final status collection suppresses retired clipboard text but retains the native ACK", async t => {
  const f = humanFixture(t, { inputBudgetVersion: 1, clipboardTransferVersion: 1 });
  await f.open(); await f.begin();
  f.inputReplyOverride = { clipboardTransfer: { operation: "cut", status: "ready", text: "retired source text" } };
  const entered = deferred(), release = deferred(), original = f.backend.getAutomationControlStatus;
  let first = true;
  f.backend.getAutomationControlStatus = async () => {
    if (first) { first = false; entered.resolve(); await release.promise; }
    return original();
  };
  const pending = f.input(1, { input: transferInput });
  await entered.promise;
  f.navigate(2); release.resolve();
  const result = await pending;
  assert.equal(result.status.human.generation, 2);
  assert.equal(result.inputReceipt.acknowledged, true);
  assert.deepEqual(result.inputReceipt.clipboardTransfer, { operation: "cut", status: "failed", code: "CANCELLED" });
});

test("clipboard receipt corruption cannot erase an actual cut ACK or expose unrelated contents", async t => {
  const f = humanFixture(t, { inputBudgetVersion: 1, clipboardTransferVersion: 1 });
  await f.open(); await f.begin();
  for (const [index, invalid] of [undefined, null, { operation: "copy", status: "ready", text: "wrong operation" },
    { operation: "cut", status: "ready", text: "hidden", private: true }].entries()) {
    f.inputReplyOverride = invalid === undefined ? {} : { clipboardTransfer: invalid };
    const result = await f.input(index + 1, { input: transferInput });
    assert.equal(result.inputReceipt.acknowledged, true);
    assert.deepEqual(result.inputReceipt.clipboardTransfer, { operation: "cut", status: "failed", code: "READ_FAILED" });
  }
  f.inputReplyOverride = { clipboardTransfer: { operation: "cut", status: "ready", text: "unsolicited" } };
  const ordinary = await f.input(5);
  assert.equal(Object.hasOwn(ordinary.inputReceipt, "clipboardTransfer"), false);
});

test("legacy human lease rejects transfer before the native shortcut", async t => {
  const f = humanFixture(t); await f.open(); await f.begin();
  await assert.rejects(f.input(1, { input: transferInput }), /HUMAN_STALE/);
  assert.equal(f.humans[0].inputCalls, 0);
});

test("native loss retires the exact channel synchronously and only its full identity can join original cleanup", async t => {
  const f = humanFixture(t), opened = await f.open();
  await f.begin();
  f.humanCloseGate = deferred();
  const epoch = f.loseNative();
  await assert.rejects(f.request("status"), /CLOSED/);
  await assert.rejects(f.request("resume", { expectedRevision: f.state.revision, expectedWorkerBootId: "worker" }), /CLOSED/);
  for (const extra of [{ channelKey: "z".repeat(64) }, { channelId: "other" }, { portId: "replacement" }, { workerBootId: "replacement" }, { runId: "0".repeat(32) }])
    await assert.rejects(f.retire(opened, extra), /IDENTITY/);
  const retiring = f.retire(opened);
  let done = false; retiring.then(() => { done = true; });
  await flush(); assert.equal(done, false);
  f.humanCloseGate.resolve(); await flush(); assert.equal(done, false, "native cleanup is separate from original user release");
  Object.assign(f.state, { state: "paused", cleanupComplete: true }); epoch.resolve();
  const result = await retiring;
  assert.equal(result.status.portId, "port");
  assert.equal(result.status.view, null); assert.equal(result.status.human, null);
  assert.deepEqual(result.status.humanCleanup, { leaseId: "human-1", cleanupConfirmed: true });
  assert.equal(result.status.cleanupPending, 0);
  assert.equal(f.humans[0].closeCalls, 1);
  assert.equal(result.status.eventSequence, f.events.at(-1).sequence);
});

test("an old retire receipt neither closes nor pauses a new native channel", async t => {
  const f = fixture(t), opened = await f.open();
  const epoch = f.loseNative();
  Object.assign(f.state, { state: "paused", cleanupComplete: true }); epoch.resolve();
  await f.retire(opened);
  const proof = Object.freeze({ nonce: "new-nonce", ...f.openArgs, portId: "new-port" });
  f.target.__obuNativeDownloadBinding = proof;
  const newKey = "b".repeat(64);
  const successor = await f.open({ portId: "new-port", channelKey: newKey });
  const selected = await f.api.request({ operation: "select", channelKey: newKey, tabId: 7 });
  const calls = f.calls.length;
  const original = await f.retire(opened);
  assert.equal(original.status.channelId, opened.channelId);
  assert.equal(original.status.portId, "port");
  assert.equal(f.calls.length, calls);
  const status = await f.api.request({ operation: "status", channelKey: newKey });
  assert.equal(status.status.channelId, successor.channelId);
  assert.equal(status.status.selectedTabId, selected.status.selectedTabId);
  await f.api.request({ operation: "disconnect", channelKey: newKey });
});

test("retire waits for pending Begin and preserves unconfirmed original human release", async t => {
  const f = humanFixture(t), opened = await f.open();
  f.humanBeginGate = deferred(); f.humanCloseGate = deferred();
  const beginning = f.begin(); const beginRejected = assert.rejects(beginning, /unconfirmed original release/);
  await flush(); assert.equal(f.humans.length, 1);
  const epoch = f.loseNative(); epoch.resolve();
  f.humanCleanupError = new Error("unconfirmed original release");
  const retiring = f.retire(opened); const retireRejected = assert.rejects(retiring, /unconfirmed original release/);
  f.humanBeginGate.resolve(); await flush();
  assert.equal(f.humans[0].info.state, "releasing");
  f.humanCloseGate.resolve(); await Promise.all([beginRejected, retireRejected]);
  f.target.__obuNativeDownloadBinding = Object.freeze({ nonce: "replacement", ...f.openArgs, portId: "replacement" });
  await assert.rejects(f.open({ portId: "replacement", channelKey: "b".repeat(64) }), /CLEANUP/);
});

test("normal retire joins resources without requiring or causing an unrelated Pause", async t => {
  const f = fixture(t), opened = await f.open();
  await f.request("select", { tabId: 7 });
  const result = await f.retire(opened);
  assert.equal(result.status.automation.state, "running");
  assert.equal(f.calls.filter(call => call[0] === "pause").length, 0);
  assert.equal(f.subscriptions[0].closeCalls, 1);
  await assert.rejects(f.request("status"), /CLOSED/);
});

test("open cannot commit a recovery which changed during original metadata inspection", async t => {
  const f = fixture(t);
  const original = f.backend.getManagedViewerTabs;
  f.backend.getManagedViewerTabs = async () => { f.nativeEpoch = deferred(); return original(); };
  await assert.rejects(f.open(), /NATIVE_CHANGED/);
  assert.equal(f.openCommitted, undefined);
  await assert.rejects(f.request("status"), /CLOSED/);
});

test("open retains its original deadline and one-shot key while native recovery is unresolved", async t => {
  const f = fixture(t), gate = deferred();
  f.backend.prepareManagedUserOpen = () => gate.promise;
  const opening = f.open(), rejected = assert.rejects(opening, /open admission expired/);
  f.advance(10001);
  await assert.rejects(f.open({ channelKey: "b".repeat(64) }), /BUSY/);
  gate.resolve(); await rejected;
  assert.equal(f.openCommitted, undefined);
  assert.equal(f.events.length, 0);
  await assert.rejects(f.open(), /REPLAY/);
  await f.open({ channelKey: "b".repeat(64) });
  await f.api.request({ operation: "disconnect", channelKey: "b".repeat(64) });
});

test("ordinary package installs no control surface; managed surface is immutable", t => {
  const target = {};
  assert.equal(installManagedUserBridge({ config: null, target }), null);
  assert.equal(Object.hasOwn(target, "__obuManagedUser"), false);
  assert.throws(() => installManagedUserBridge({ config: undefined, target }), /OBU_MANAGED_CONFIG_INVALID/);
  const f = fixture(t);
  assert.equal(Object.isFrozen(f.api), true);
  assert.deepEqual(Object.keys(f.api), ["open", "request"]);
  assert.deepEqual(Object.getOwnPropertyDescriptor(f.target, "__obuManagedUser"), { value: f.api, writable: false, configurable: false, enumerable: false });
  assert.throws(() => { f.target.__obuManagedUser = {}; }, TypeError);
});

test("open proves original worker identity and returns metadata without channel secret", async t => {
  const f = fixture(t), opened = await f.open();
  assert.equal(opened.channelId, "channel-1");
  assert.equal(opened.workerBootId, "worker");
  assert.deepEqual(opened.status.tabs, f.liveTabs);
  assert.equal(opened.status.selectedTabId, null);
  assert.equal(opened.status.leaseMs, 10000);
  assert.equal(opened.status.heartbeatMs, 3000);
  assert.equal(JSON.stringify(opened).includes(key), false);
  await assert.rejects(f.open({ channelKey: "b".repeat(64) }), /BUSY/);
  await assert.rejects(f.request("status", { channelKey: "b".repeat(64) }), /IDENTITY/);
  assert.deepEqual(f.calls, []);
});

test("malformed and inherited fields never invoke getters or backend controls", async t => {
  const f = fixture(t);
  let getterCalls = 0;
  const accessor = { ...f.openArgs }; Object.defineProperty(accessor, "runId", { get() { getterCalls++; return runId; } });
  for (const value of [null, [], Object.create(f.openArgs), { ...f.openArgs, extra: true }, { ...f.openArgs, [Symbol("extra")]: true }, accessor])
    await assert.rejects(f.api.open(value), /PROTOCOL/);
  const coercible = { toString() { getterCalls++; return key; } };
  for (const extra of [{ runId: "f".repeat(32) }, { extensionId: "x".repeat(32) }, { extensionId: coercible }, { workerBootId: "other" }, { channelKey: "short" }, { channelKey: `${key}\n` }, { channelKey: coercible }, { version: 2 }])
    await assert.rejects(f.open(extra), /IDENTITY/);
  await f.open();
  const operations = ["evaluate", "click", "attach", "Page.startScreencast", "SET_SITE_ACCESS_POLICY"];
  for (const operation of operations) await assert.rejects(f.request(operation), /PROTOCOL/);
  for (const [operation, extra] of [["status", { tabId: 7 }], ["select", { tabId: "7" }], ["select", { tabId: -1 }], ["resume", { expectedRevision: 0 }], ["ack", { sequence: 0 }], ["pause", { expectedRevision: 0 }]])
    await assert.rejects(f.request(operation, extra), /PROTOCOL/);
  const request = { channelKey: key }; Object.defineProperty(request, "operation", { get() { getterCalls++; return "pause"; } });
  await assert.rejects(f.api.request(request), /PROTOCOL/);
  assert.equal(getterCalls, 0); assert.deepEqual(f.calls, []);
});

test("open cannot cross an asynchronous native proof replacement", async t => {
  const gate = deferred();
  const f = fixture(t, { install: { getInstanceId: () => gate.promise } });
  const pending = f.open();
  f.target.__obuNativeDownloadBinding = Object.freeze({ ...f.target.__obuNativeDownloadBinding });
  gate.resolve("instance");
  await assert.rejects(pending, /IDENTITY/);
  assert.deepEqual(f.calls, []);
});

test("one outstanding frame and one replaceable latest frame, with independent sequences", async t => {
  const f = fixture(t); await f.open(); await f.request("select", { tabId: 7 });
  f.frame(10); f.frame(11); f.frame(12);
  let frames = f.events.filter(event => event.type === "frame");
  assert.equal(frames.length, 1); assert.equal(frames[0].frameSequence, 10);
  assert.equal(frames[0].metadata.documentId, undefined);
  assert.equal(JSON.stringify(f.events).includes(key), false);
  await assert.rejects(f.request("ack", { sequence: frames[0].sequence + 100 }), /ACK/);
  await f.request("heartbeat");
  await f.request("ack", { sequence: frames[0].sequence });
  frames = f.events.filter(event => event.type === "frame");
  assert.deepEqual(frames.map(event => event.frameSequence), [10, 12]);
  assert.ok(frames[1].sequence > frames[0].sequence + 1);
  await assert.rejects(f.request("ack", { sequence: frames[0].sequence }), /ACK/);
  await f.request("ack", { sequence: frames[1].sequence });
  f.frame(12); f.frame(13);
  assert.deepEqual(f.events.filter(event => event.type === "frame").map(event => event.frameSequence), [10, 12, 13]);
});

test("a decoded 4 MiB frame is allowed and oversize or malformed frames revoke viewing", async t => {
  const f = fixture(t); await f.open(); await f.request("select", { tabId: 7 });
  f.frame(1, { data: Buffer.alloc(4 * 1024 * 1024).toString("base64") });
  assert.equal(f.events.filter(event => event.type === "frame").length, 1);
  f.frame(2, { data: Buffer.alloc(4 * 1024 * 1024 + 1).toString("base64") });
  await flush();
  assert.equal(f.subscriptions[0].closeCalls, 1);
  assert.equal((await f.request("status")).status.selectedTabId, null);
  assert.match(f.events.find(event => event.type === "error").error, /4 MiB|oversized/);
  await f.request("select", { tabId: 7 });
  f.frame(3, { data: "!!!!" }); await flush();
  assert.equal(f.subscriptions[1].closeCalls, 1);
});

test("selection only uses live owned attachments and null stops watching without closing channel", async t => {
  const f = fixture(t); await f.open();
  await assert.rejects(f.request("select", { tabId: 8 }), /TAB/);
  assert.deepEqual(f.calls, []);
  await f.request("select", { tabId: 7 }); f.frame(1); f.frame(2);
  await f.request("select", { tabId: null }); f.frame(3);
  assert.equal(f.subscriptions[0].closeCalls, 1);
  assert.equal(f.events.filter(event => event.type === "frame").length, 1);
  assert.equal((await f.request("status")).status.connected, true);
  await f.request("select", { tabId: 7 }); f.frame(1);
  assert.equal(f.subscriptions.length, 2);
  assert.equal(f.events.filter(event => event.type === "frame").length, 2);
});

test("changing selection waits for actual old cleanup and ignores old frames", async t => {
  const f = fixture(t); f.liveTabs.push({ id: 8, title: "Second", url: "https://second.test/" });
  await f.open(); await f.request("select", { tabId: 7 });
  f.closeGate = deferred();
  const switching = f.request("select", { tabId: 8 }); await flush();
  f.frame(1); assert.equal(f.subscriptions.length, 1);
  assert.equal(f.events.filter(event => event.type === "frame").length, 0);
  f.closeGate.resolve(); await switching;
  assert.equal(f.subscriptions.length, 2);
  f.frame(1, {}, f.subscriptions[0]); f.frame(1);
  assert.deepEqual(f.events.filter(event => event.type === "frame").map(event => event.tabId), [8]);
});

test("attachment loss and producer retirement clear the original frame without subscribing again", async t => {
  const f = fixture(t); await f.open(); await f.request("select", { tabId: 7 }); f.frame(1);
  f.subscriptions[0].closed.resolve({ reason: "original attachment revoked" }); await flush();
  assert.equal((await f.request("status")).status.selectedTabId, null);
  f.frame(2); assert.equal(f.events.filter(event => event.type === "frame").length, 1);
  await f.request("select", { tabId: 7 });
  f.liveTabs = [];
  assert.deepEqual((await f.request("status")).status.tabs, []);
  assert.equal(f.subscriptions[1].closeCalls, 1);
  assert.equal(f.calls.filter(call => call[0] === "subscribe").length, 2);
});

test("lease expiration runs asynchronously, cancels its stream, and never resumes automation", async t => {
  const f = fixture(t, { fastTimers: true }); await f.open(); await f.request("select", { tabId: 7 }); f.frame(1);
  f.advance(9999); await delay(15);
  assert.equal(f.events.some(event => event.type === "closed"), false);
  f.advance(1); await delay(25);
  assert.equal(f.subscriptions[0].closeCalls, 1);
  assert.equal(f.events.at(-1).type, "closed");
  f.frame(2); await assert.rejects(f.request("heartbeat"), /CLOSED/);
  assert.equal(f.calls.some(call => call[0] === "resume"), false);
  await assert.rejects(f.open(), /REPLAY/);
});

test("only heartbeat renews the lease; status and frames do not keep it alive", async t => {
  const f = fixture(t); await f.open();
  f.advance(9000); await f.request("heartbeat");
  f.advance(9000); assert.equal((await f.request("status")).status.connected, true);
  f.advance(1000); await assert.rejects(f.request("status"), /CLOSED/);
  assert.equal(f.events.at(-1).type, "closed");
});

test("native proof or binding replacement revokes original channel without publishing late frames", async t => {
  const f = fixture(t); await f.open(); await f.request("select", { tabId: 7 }); f.frame(1);
  f.target.__obuNativeDownloadBinding = Object.freeze({ ...f.target.__obuNativeDownloadBinding });
  f.frame(2); await flush();
  assert.equal(f.events.filter(event => event.type === "frame").length, 1);
  assert.equal(f.subscriptions[0].closeCalls, 1);
  await assert.rejects(f.request("status"), /CLOSED/);
  await f.open({ channelKey: "b".repeat(64) });
  f.target.__obuManagedViewerEvent = () => {};
  await assert.rejects(f.api.request({ channelKey: "b".repeat(64), operation: "pause" }), /CLOSED/);
  assert.equal(f.calls.some(call => call[0] === "pause"), false);
});

test("pause uses existing backend control and resume requires current boot and revision", async t => {
  const f = fixture(t); await f.open(); await f.request("select", { tabId: 7 });
  const paused = await f.request("pause");
  assert.equal(paused.status.automation.state, "paused"); assert.equal(f.subscriptions[0].closeCalls, 1);
  await assert.rejects(f.request("resume", { expectedRevision: 1, expectedWorkerBootId: "old-worker" }), /REVISION/);
  assert.equal(f.calls.some(call => call[0] === "resume"), false);
  await assert.rejects(f.request("resume", { expectedRevision: 0, expectedWorkerBootId: "worker" }), /REVISION_CONFLICT/);
  assert.equal(f.state.state, "paused");
  const resumed = await f.request("resume", { expectedRevision: 1, expectedWorkerBootId: "worker" });
  assert.equal(resumed.status.automation.state, "running");
  assert.equal(resumed.status.workerBootId, "worker");
  assert.equal(f.calls.filter(call => call[0] === "subscribe").length, 1);
});

test("in-flight Resume cannot unblock after lease expiration while persistence is pending", async t => {
  const f = fixture(t, { fastTimers: true }); await f.open(); await f.request("pause");
  f.resumeGate = deferred();
  const resumed = f.request("resume", { expectedRevision: 1, expectedWorkerBootId: "worker" });
  const rejected = assert.rejects(resumed, /CLOSED/);
  await flush(); f.advance(10000); await delay(25);
  assert.equal(f.calls.filter(call => call[0] === "pause").length, 2);
  f.resumeGate.resolve(); await rejected;
  assert.equal(f.state.state, "paused");
});

test("disconnect during pending Subscribe fences callback then awaits original handle cleanup", async t => {
  const f = fixture(t); await f.open(); f.subscribeGate = deferred();
  const selected = f.request("select", { tabId: 7 });
  const rejected = assert.rejects(selected, /CLOSED/); await flush();
  let disconnected = false;
  const stopped = f.request("disconnect").then(value => { disconnected = true; return value; });
  await flush(); f.frame(1);
  assert.equal(disconnected, false); assert.equal(f.events.some(event => event.type === "frame"), false);
  await assert.rejects(f.open({ channelKey: "b".repeat(64) }), /CLEANUP/);
  f.subscribeGate.resolve(); await rejected;
  assert.equal((await stopped).status.connected, false);
  assert.equal(f.subscriptions[0].closeCalls, 1);
});

test("explicit disconnect is final and retired channel keys cannot replay", async t => {
  const f = fixture(t); await f.open();
  assert.equal((await f.request("disconnect")).disconnected, true);
  await assert.rejects(f.request("resume", { expectedRevision: 0, expectedWorkerBootId: "worker" }), /CLOSED/);
  await assert.rejects(f.open(), /REPLAY/);
  const second = await f.open({ channelKey: "b".repeat(64) });
  assert.equal(second.channelId, "channel-2");
  await assert.rejects(f.request("status"), /IDENTITY/);
  await f.api.request({ channelKey: "b".repeat(64), operation: "disconnect" });
});

test("actual close failure is reported and prevents a fresh subscription or channel", async t => {
  const f = fixture(t); await f.open(); await f.request("select", { tabId: 7 });
  f.subscriptions[0].handle.close = async () => { throw new Error("native stop refused"); };
  await assert.rejects(f.request("select", { tabId: null }), /native stop refused/);
  await assert.rejects(f.request("select", { tabId: 7 }), /CLEANUP/);
  await assert.rejects(f.request("disconnect"), /CLEANUP/);
  await assert.rejects(f.open({ channelKey: "b".repeat(64) }), /CLEANUP/);
});

test("disconnect joins cleanup already started by producer retirement", async t => {
  const f = fixture(t); await f.open(); await f.request("select", { tabId: 7 });
  f.closeGate = deferred();
  f.subscriptions[0].closed.resolve({ reason: "original page retired" }); await flush();
  assert.equal((await f.request("status")).status.cleanupPending, 1);
  let settled = false;
  const stopped = f.request("disconnect").then(() => { settled = true; });
  await flush(); assert.equal(settled, false);
  await assert.rejects(f.open({ channelKey: "b".repeat(64) }), /CLEANUP/);
  f.closeGate.resolve(); await stopped;
  assert.equal(f.subscriptions[0].closeCalls, 1);
});

test("new selection joins cleanup started before it was requested", async t => {
  const f = fixture(t); await f.open(); await f.request("select", { tabId: 7 });
  f.closeGate = deferred();
  f.subscriptions[0].closed.resolve({ reason: "original stream retired" }); await flush();
  const selected = f.request("select", { tabId: 7 }); await flush();
  assert.equal(f.subscriptions.length, 1);
  f.closeGate.resolve(); await selected;
  assert.equal(f.subscriptions.length, 2);
});

test("failed Subscribe preserves explicitly unconfirmed native cleanup", async t => {
  const f = fixture(t); await f.open();
  f.backend.managedViewerSubscribe = async () => { throw Object.assign(new Error("native stop failed during startup"), { viewerCleanupIncomplete: true }); };
  await assert.rejects(f.request("select", { tabId: 7 }), /native stop failed/);
  assert.match((await f.request("status")).status.cleanupError, /native stop failed/);
  await assert.rejects(f.request("select", { tabId: 7 }), /CLEANUP/);
  await assert.rejects(f.request("disconnect"), /CLEANUP/);
});

test("live status is bounded and contains only allowed tab metadata", async t => {
  const f = fixture(t);
  f.liveTabs[0].body = "page contents must not be read";
  f.liveTabs[0].secret = "backend-private";
  const opened = await f.open();
  assert.deepEqual(Object.keys(opened.status.tabs[0]), ["id", "title", "url"]);
  f.liveTabs = Array.from({ length: 200 }, (_, id) => ({ id, title: "t", url: "x".repeat(8192) }));
  await assert.rejects(f.request("status"), /CAPACITY/);
  assert.deepEqual(f.calls, []);
});

test("status snapshot sequence matches its actual event and later clear supersedes old replies", async t => {
  const f = fixture(t); const opened = await f.open();
  assert.equal(opened.status.eventSequence, 0);
  const selected = await f.request("select", { tabId: 7 });
  const published = f.events.at(-1);
  assert.equal(selected.status.eventSequence, published.sequence);
  assert.equal(published.status.eventSequence, published.sequence);
  f.frame(1);
  const oldStatus = await f.request("status");
  assert.equal(oldStatus.status.eventSequence, f.events.at(-1).sequence);
  const unselected = await f.request("select", { tabId: null });
  assert.ok(unselected.status.eventSequence > oldStatus.status.eventSequence);
  assert.equal(unselected.status.eventSequence, f.events.at(-1).sequence);
});

test("Resume requires viewer cleanup even when backend automation is otherwise paused", async t => {
  const f = fixture(t); await f.open(); await f.request("select", { tabId: 7 });
  f.closeGate = deferred(); f.subscriptions[0].closed.resolve({ reason: "stream retired" }); await flush();
  Object.assign(f.state, { state: "paused", cleanupComplete: true, revision: 1 });
  await assert.rejects(f.request("resume", { expectedRevision: 1, expectedWorkerBootId: "worker" }), /CLEANUP/);
  assert.equal(f.calls.some(call => call[0] === "resume"), false);
  f.closeGate.resolve(); await flush();
  assert.equal((await f.request("resume", { expectedRevision: 1, expectedWorkerBootId: "worker" })).status.automation.state, "running");
});

test("a status waiting on tab metadata cannot publish automation older than a completed Pause", async t => {
  const f = fixture(t); await f.open();
  const entered = deferred(), held = deferred();
  let first = true;
  f.backend.getManagedViewerTabs = async () => {
    if (first) { first = false; entered.resolve(); await held.promise; }
    return f.liveTabs;
  };
  const older = f.request("status"); await entered.promise;
  const paused = await f.request("pause");
  held.resolve(); const refreshed = await older;
  assert.equal(paused.status.automation.state, "paused");
  assert.equal(refreshed.status.automation.state, "paused");
  assert.equal(refreshed.status.automation.revision, paused.status.automation.revision);
  assert.ok(refreshed.status.eventSequence >= paused.status.eventSequence);
  assert.equal(f.calls.filter(call => call[0] === "pause").length, 1);
});

test("a delayed old automation snapshot is reread after Resume without replaying control", async t => {
  const f = fixture(t); await f.open(); const paused = await f.request("pause");
  const entered = deferred(), held = deferred(); let first = true, observations = 0;
  f.backend.getAutomationControlStatus = async () => {
    observations++; const snapshot = { ...f.state };
    if (first) { first = false; entered.resolve(); await held.promise; }
    return snapshot;
  };
  const older = f.request("status"); await entered.promise;
  const resumed = await f.request("resume", { expectedRevision: paused.status.automation.revision, expectedWorkerBootId: "worker" });
  held.resolve(); const refreshed = await older;
  assert.equal(refreshed.status.automation.state, "running");
  assert.equal(refreshed.status.automation.revision, resumed.status.automation.revision);
  assert.ok(observations >= 3);
  assert.equal(f.calls.filter(call => call[0] === "resume").length, 1);
});

test("human takeover retires observation, publishes actual geometry and returns an original input receipt", async t => {
  const f = humanFixture(t); await f.open(); await f.request("select", { tabId: 7 });
  const starting = await f.begin();
  assert.equal(f.subscriptions[0].closeCalls, 1);
  assert.equal(starting.status.human.generation, 0);
  assert.equal(starting.status.automation.state, "paused");
  const frames = f.events.filter(event => event.type === "frame");
  assert.equal(frames.length, 1); assert.equal(frames[0].controlMode, "human");
  assert.equal(frames[0].humanLeaseId, "human-1");
  assert.ok(f.events.some(event => event.type === "status" && event.status.human?.generation === 1));
  await assert.rejects(f.request("resume", { expectedRevision: f.state.revision, expectedWorkerBootId: "worker" }), /HUMAN_BUSY/);
  await assert.rejects(f.input(1, { generation: 2 }), /HUMAN_STALE/);
  await assert.rejects(f.input(1, { leaseId: "retired-lease" }), /HUMAN_STALE/);
  assert.equal(f.humans[0].inputCalls, 0);
  const applied = await f.input(1);
  assert.deepEqual(applied.inputReceipt, { leaseId: "human-1", generation: 1, sequence: 1, acknowledged: true });
  const ended = await f.request("humanEnd", { leaseId: "human-1" });
  assert.equal(ended.status.human, null);
  assert.deepEqual(ended.status.humanCleanup, { leaseId: "human-1", cleanupConfirmed: true });
  assert.equal(ended.status.automation.state, "paused");
  await assert.rejects(f.input(2), /HUMAN_STALE/);
});

test("human budget capability remains the original handle field through navigation while legacy handles omit it", async t => {
  for (const inputBudgetVersion of [undefined, 1]) {
    const f = humanFixture(t, { inputBudgetVersion }); await f.open(); await f.begin();
    const first = (await f.request("status")).status;
    assert.equal(first.human.inputBudgetVersion, inputBudgetVersion);
    assert.equal(Object.hasOwn(first.human, "inputBudgetVersion"), inputBudgetVersion !== undefined);
    f.navigate(2); await flush(); f.arrive(2); await flush();
    const next = (await f.request("status")).status;
    assert.equal(next.human.leaseId, first.human.leaseId); assert.equal(next.human.inputBudgetVersion, inputBudgetVersion);
    assert.equal(next.human.generation, 2); assert.equal(next.view, null);
  }
});

test("a first human frame during Begin is kept until the original handle becomes active", async t => {
  const f = humanFixture(t); f.earlyHumanFrame = true; await f.open();
  const result = await f.request("humanBegin", { tabId: 7 }); await flush();
  assert.equal(result.status.human.generation, 1);
  assert.deepEqual(f.events.filter(event => event.type === "frame").map(event => [event.humanLeaseId, event.generation, event.frameSequence]), [["human-1", 1, 1]]);
  assert.equal(f.humans[0].closeCalls, 0);
});

test("input acknowledgement cannot be fabricated from the requested sequence", async t => {
  const f = humanFixture(t); await f.open(); await f.begin();
  f.inputReplyOverride = { sequence: 0 };
  await assert.rejects(f.input(1), /HUMAN_UNCONFIRMED/);
  assert.equal(f.humans[0].inputCalls, 1);
  assert.equal(f.humans[0].info.lastInputSequence, 1);
  assert.equal(f.humans[0].info.state, "released");
  await assert.rejects(f.input(2), /HUMAN_STALE/);
});

test("navigation keeps one human lease and publishes the new generation before its first frame", async t => {
  const f = humanFixture(t); await f.open(); await f.begin();
  const start = f.events.length;
  f.navigate(2); await flush();
  const navigating = (await f.request("status")).status;
  assert.equal(navigating.human.state, "navigating");
  assert.equal(navigating.human.leaseId, "human-1");
  assert.equal(navigating.human.viewport, null);
  assert.equal(navigating.selectedTabId, 7);
  assert.equal(navigating.humanCleanup, undefined);
  await assert.rejects(f.input(1), /HUMAN_GENERATION_STALE/);
  await assert.rejects(f.input(1, { generation: 2 }), /HUMAN_GENERATION_STALE/);
  assert.equal(f.humans[0].inputCalls, 0);
  f.arrive(2); await flush();
  const events = f.events.slice(start), frameIndex = events.findIndex(event => event.type === "frame");
  assert.ok(frameIndex > 0);
  assert.ok(events.slice(0, frameIndex).some(event => event.type === "status" && event.status.human.generation === 2));
  assert.equal(events.some(event => event.type === "clear"), false);
  assert.equal(events[frameIndex].generation, 2);
  assert.equal(f.humans[0].closeCalls, 0);
  assert.equal(f.calls.filter(call => call[0] === "humanBegin").length, 1);
  assert.deepEqual((await f.input(1, { generation: 2 })).inputReceipt,
    { leaseId: "human-1", generation: 2, sequence: 1, acknowledged: true });
  assert.equal(f.state.state, "paused");
});

test("a navigation-triggering native acknowledgement belongs to the old generation without ending the new one", async t => {
  const f = humanFixture(t); await f.open(); await f.begin();
  f.humanInputGate = deferred();
  const original = f.input(1); await flush();
  f.navigate(2); f.arrive(2); await flush();
  f.humanInputGate.resolve();
  const reply = await original;
  assert.deepEqual(reply.inputReceipt, { leaseId: "human-1", generation: 1, sequence: 1, acknowledged: true });
  assert.equal(reply.status.human.generation, 2);
  assert.equal(reply.status.human.lastInputSequence, 0);
  assert.equal(f.humans[0].closeCalls, 0);
  assert.deepEqual((await f.input(1, { generation: 2 })).inputReceipt,
    { leaseId: "human-1", generation: 2, sequence: 1, acknowledged: true });
});

test("an exact retired frame credit settles once without clearing the new outstanding credit", async t => {
  const f = humanFixture(t); await f.open(); await f.begin();
  const oldFrame = f.events.findLast(event => event.type === "frame");
  f.navigate(2); f.arrive(2); await flush();
  const newFrame = f.events.findLast(event => event.type === "frame");
  assert.notEqual(newFrame.sequence, oldFrame.sequence);
  await f.request("ack", { sequence: oldFrame.sequence });
  await assert.rejects(f.request("ack", { sequence: oldFrame.sequence }), /ACK/);
  f.humanFrame(2, { streamId: newFrame.streamId });
  assert.equal(f.events.findLast(event => event.type === "frame").sequence, newFrame.sequence);
  await f.request("ack", { sequence: newFrame.sequence });
  assert.equal(f.events.findLast(event => event.type === "frame").frameSequence, 2);
});

test("old human state and old encoded frames cannot revoke or repaint a successor generation", async t => {
  const f = humanFixture(t); await f.open(); await f.begin();
  const record = f.humans[0], oldInfo = { ...record.info };
  f.navigate(2); f.arrive(2); await flush();
  const frameCount = f.events.filter(event => event.type === "frame").length;
  record.onState(oldInfo);
  f.humanFrame(99, { generation: 1, streamId: "original-retired-stream" }); await flush();
  assert.equal(f.events.filter(event => event.type === "frame").length, frameCount);
  assert.equal(record.closeCalls, 0);
  assert.equal((await f.request("status")).status.human.generation, 2);
  const ended = await f.request("humanEnd", { leaseId: "human-1" });
  assert.deepEqual(ended.status.humanCleanup, { leaseId: "human-1", cleanupConfirmed: true });
});

test("coalesced navigation waits for actual state publication and keeps only the newest matching frame", async t => {
  const f = humanFixture(t); await f.open(); await f.begin();
  const held = deferred(), entered = deferred(); let block = true;
  f.backend.getAutomationControlStatus = async () => {
    if (block) { block = false; entered.resolve(); await held.promise; }
    return { ...f.state };
  };
  const start = f.events.length;
  f.navigate(2); await entered.promise;
  f.arrive(2); f.navigate(4); f.arrive(4, 1);
  f.humanFrame(2, { streamId: "human-stream-human-1-g4" });
  assert.equal(f.events.slice(start).some(event => event.type === "frame"), false);
  held.resolve(); await flush();
  const events = f.events.slice(start), frames = events.filter(event => event.type === "frame");
  assert.deepEqual(frames.map(frame => [frame.generation, frame.frameSequence]), [[4, 2]]);
  assert.equal(events[0].type, "status");
  assert.equal(events[0].status.human.generation, 4);
  assert.equal(f.humans[0].closeCalls, 0);
});

test("navigation during publication completion publishes its state without waiting for a frame", async t => {
  const f = humanFixture(t); await f.open(); await f.begin();
  const start = f.events.length;
  let once = true;
  f.backend.getAutomationControlStatus = () => {
    if (once) { once = false; queueMicrotask(() => queueMicrotask(() => f.navigate(2))); }
    return Promise.resolve({ ...f.state });
  };
  f.humans[0].onState({ ...f.humans[0].info });
  await flush();
  // Do not issue a status request: the unsolicited navigation publication is
  // what disables the viewer while no successor frame is available yet.
  const automatic = f.events.slice(start).filter(event => event.type === "status");
  assert.equal(automatic.at(-1).status.human.state, "navigating");
  assert.equal(automatic.at(-1).status.human.generation, 2);
  assert.equal(automatic.at(-1).status.human.viewport, null);
  assert.equal(f.humans[0].closeCalls, 0);
  assert.ok(automatic.length <= 3, "A finite state change must not create an unbounded publication loop");
});

test("human navigation clears the old address and publishes current page metadata with the new frame", async t => {
  const f = humanFixture(t); await f.open(); await f.begin();
  const record = f.humans[0];
  record.handle.tabInfo = () => record.info.state === "navigating"
    ? { id: 7, title: "页面正在跳转", url: "" }
    : { id: 7, title: record.info.generation === 1 ? "Page A" : "Page B", url: `https://example.test/${record.info.generation === 1 ? "a" : "b"}` };
  assert.equal((await f.request("status")).status.tabs[0].url, "https://example.test/a");
  f.navigate(2); await flush();
  assert.deepEqual(f.events.findLast(event => event.type === "status").status.tabs, [{ id: 7, title: "页面正在跳转", url: "" }]);
  f.arrive(2); await flush();
  const current = f.events.findLast(event => event.type === "status");
  assert.deepEqual(current.status.tabs, [{ id: 7, title: "Page B", url: "https://example.test/b" }]);
  const frame = f.events.findLast(event => event.type === "frame");
  assert.ok(current.sequence < frame.sequence);
  assert.equal(record.closeCalls, 0);
});

test("End during navigation releases the whole lease and late state cannot reopen it", async t => {
  const f = humanFixture(t); await f.open(); await f.begin();
  f.navigate(2); await flush();
  const end = await f.request("humanEnd", { leaseId: "human-1" });
  assert.equal(end.status.human, null);
  assert.deepEqual(end.status.humanCleanup, { leaseId: "human-1", cleanupConfirmed: true });
  const count = f.events.filter(event => event.type === "frame").length;
  f.arrive(2); await flush();
  assert.equal(f.events.filter(event => event.type === "frame").length, count);
  assert.equal((await f.request("status")).status.human, null);
  assert.equal(f.humans[0].closeCalls, 1);
});

test("human End revokes immediately but waits for the original input and cleanup", async t => {
  const f = humanFixture(t); await f.open(); await f.begin();
  f.humanInputGate = deferred(); f.humanCloseGate = deferred();
  const input = f.input(1), rejected = assert.rejects(input, /HUMAN_STALE/);
  await flush();
  let ended = false;
  const end = f.request("humanEnd", { leaseId: "human-1" }).then(result => { ended = true; return result; });
  await flush();
  await assert.rejects(f.input(2), /HUMAN_STALE/);
  await assert.rejects(f.request("resume", { expectedRevision: f.state.revision, expectedWorkerBootId: "worker" }), /CLEANUP/);
  assert.equal(ended, false); assert.equal(f.humans[0].closeCalls, 1);
  f.humanInputGate.resolve(); await rejected; await flush(); assert.equal(ended, false);
  f.humanCloseGate.resolve();
  assert.deepEqual((await end).status.humanCleanup, { leaseId: "human-1", cleanupConfirmed: true });
  assert.equal(f.humans[0].inputCalls, 1);
});

test("unselect fences Begin while original tab inspection is still pending", async t => {
  const f = humanFixture(t); await f.open();
  const entered = deferred(), held = deferred(); let first = true;
  f.backend.getManagedViewerTabs = async () => { if (first) { first = false; entered.resolve(); await held.promise; } return f.liveTabs; };
  const begin = f.request("humanBegin", { tabId: 7 }), rejected = assert.rejects(begin, /CLOSED/);
  await entered.promise;
  let completed = false;
  const clear = f.request("select", { tabId: null }).then(result => { completed = true; return result; });
  await flush(); assert.equal(completed, false);
  held.resolve(); await rejected;
  assert.equal((await clear).status.human, null);
  assert.equal(f.humans.length, 0);
});

test("unselect does not queue cancellation behind an in-progress human Begin", async t => {
  const f = humanFixture(t); await f.open(); f.humanBeginGate = deferred(); f.humanCloseGate = deferred();
  const begin = f.request("humanBegin", { tabId: 7 }), rejected = assert.rejects(begin, /HUMAN_STALE/);
  await flush(); assert.equal(f.humans.length, 1);
  let cleared = false;
  const clear = f.request("select", { tabId: null }).then(result => { cleared = true; return result; });
  await flush(); assert.equal(cleared, false);
  assert.throws(f.humans[0].authority, /HUMAN_STALE/);
  f.humanBeginGate.resolve(); await flush(); assert.equal(cleared, false);
  f.humanCloseGate.resolve(); await rejected; await clear;
  assert.equal(f.humans[0].info.state, "released");
  assert.equal(f.calls.some(call => call[0] === "pause"), false);
});

test("Pause retires a queued human Begin without starting it after the old subscription settles", async t => {
  const f = humanFixture(t); await f.open(); f.subscribeGate = deferred();
  const select = f.request("select", { tabId: 7 }), selectRejected = assert.rejects(select, /CLOSED/);
  await flush();
  const begin = f.request("humanBegin", { tabId: 7 }), beginRejected = assert.rejects(begin, /CLOSED/);
  const pause = f.request("pause"); await flush(); f.subscribeGate.resolve();
  await Promise.all([selectRejected, beginRejected, pause]);
  assert.equal(f.humans.length, 0); assert.equal(f.state.state, "paused");
  assert.equal(f.subscriptions[0].closeCalls, 1);
});

test("disconnect waits for original human input release and blocks a replacement channel", async t => {
  const f = humanFixture(t); await f.open(); await f.begin(); f.humanInputGate = deferred();
  const input = f.input(1), rejected = assert.rejects(input, /CLOSED/); await flush();
  let done = false; const close = f.request("disconnect").then(result => { done = true; return result; });
  await flush(); assert.equal(done, false);
  await assert.rejects(f.open({ channelKey: "b".repeat(64) }), /CLEANUP/);
  f.humanInputGate.resolve(); await rejected;
  const result = await close;
  assert.equal(f.humans[0].info.state, "released");
  assert.equal(f.calls.filter(call => call[0] === "humanReleased").length, 1);
  assert.equal(result.status.human, null);
  assert.deepEqual(result.status.humanCleanup, { leaseId: "human-1", cleanupConfirmed: true });
  assert.equal(result.status.cleanupPending, 0);
});

test("disconnect reports the newly released human lease and final event sequence, not the previous lease snapshot", async t => {
  const f = humanFixture(t); await f.open(); await f.begin();
  await f.request("humanEnd", { leaseId: "human-1" });
  await f.begin();
  const before = (await f.request("status")).status;
  assert.equal(before.human.leaseId, "human-2");
  assert.deepEqual(before.humanCleanup, { leaseId: "human-1", cleanupConfirmed: true });
  f.humanCloseGate = deferred();
  let done = false;
  const disconnect = f.request("disconnect").then(result => { done = true; return result; });
  await flush(); assert.equal(done, false);
  assert.equal(f.humans[1].info.state, "releasing");
  f.humanCloseGate.resolve();
  const result = await disconnect;
  assert.equal(f.humans[1].info.state, "released");
  assert.equal(result.disconnected, true);
  assert.equal(result.status.connected, false);
  assert.equal(result.status.selectedTabId, null);
  assert.equal(result.status.human, null);
  assert.deepEqual(result.status.humanCleanup, { leaseId: "human-2", cleanupConfirmed: true });
  assert.equal(result.status.cleanupPending, 0);
  assert.equal(Object.hasOwn(result.status, "cleanupError"), false);
  assert.deepEqual(result.status.stream, { state: "idle", streamId: null });
  assert.deepEqual(result.status.tabs, []);
  assert.equal(f.events.at(-1).type, "closed");
  assert.equal(result.status.eventSequence, f.events.at(-1).sequence);
  assert.ok(result.status.eventSequence > before.eventSequence);
});

test("disconnect never confirms a human close rejection or a resolved close without actual released state", async t => {
  for (const mode of ["reject", "unconfirmed"]) {
    const f = humanFixture(t); await f.open(); await f.begin();
    await f.request("humanEnd", { leaseId: "human-1" }); await f.begin();
    if (mode === "reject") f.humanCleanupError = new Error("original native release unconfirmed");
    else f.humans[1].handle.close = async () => { f.humans[1].info.state = "releasing"; };
    await assert.rejects(f.request("disconnect"), /release.*unconfirmed|release was not confirmed/);
    assert.notEqual(f.humans[1].info.state, "released");
    await assert.rejects(f.open({ channelKey: "b".repeat(64) }), /CLEANUP/);
  }
});

test("disconnect joins a pending Begin that returns its original handle after cancellation", async t => {
  const f = humanFixture(t); await f.open(); await f.begin();
  await f.request("humanEnd", { leaseId: "human-1" });
  const originalBegin = f.backend.beginManagedHuman, delivery = deferred();
  f.backend.beginManagedHuman = async (...args) => { const handle = await originalBegin(...args); await delivery.promise; return handle; };
  const begin = f.request("humanBegin", { tabId: 7 }), rejected = assert.rejects(begin, /CLOSED/);
  await flush(); await flush();
  assert.equal(f.humans[1].info.state, "active");
  f.humanCloseGate = deferred();
  let done = false;
  const disconnect = f.request("disconnect").then(result => { done = true; return result; });
  await flush(); assert.equal(done, false);
  assert.throws(f.humans[1].authority, /CLOSED/);
  delivery.resolve(); await rejected; await flush(); assert.equal(done, false);
  f.humanCloseGate.resolve();
  const result = await disconnect;
  assert.equal(f.humans[1].closeCalls, 1);
  assert.equal(f.humans[1].info.state, "released");
  assert.equal(result.status.human, null);
  assert.deepEqual(result.status.humanCleanup, { leaseId: "human-2", cleanupConfirmed: true });
  assert.equal(result.status.cleanupPending, 0);
});

test("disconnect joins rejected Begin cleanup without inventing an undelivered human lease receipt", async t => {
  const f = humanFixture(t); await f.open(); f.humanBeginGate = deferred(); f.humanCloseGate = deferred();
  const begin = f.request("humanBegin", { tabId: 7 }), rejected = assert.rejects(begin, /CLOSED/);
  await flush(); assert.equal(f.humans.length, 1);
  let done = false;
  const disconnect = f.request("disconnect").then(result => { done = true; return result; });
  await flush(); f.humanBeginGate.resolve(); await flush(); assert.equal(done, false);
  assert.equal(f.humans[0].info.state, "releasing");
  f.humanCloseGate.resolve(); await rejected;
  const result = await disconnect;
  assert.equal(f.humans[0].info.state, "released");
  assert.equal(result.status.human, null);
  assert.equal(result.status.cleanupPending, 0);
  assert.equal(Object.hasOwn(result.status, "humanCleanup"), false);
});

test("disconnect preserves a pending Begin cleanup failure instead of returning a disconnected receipt", async t => {
  const f = humanFixture(t); await f.open(); f.humanBeginGate = deferred(); f.humanCloseGate = deferred();
  f.humanCleanupError = new Error("original pending Begin release unconfirmed");
  const begin = f.request("humanBegin", { tabId: 7 });
  const beginRejected = assert.rejects(begin, /pending Begin release unconfirmed/);
  await flush(); assert.equal(f.humans.length, 1);
  const disconnectRejected = assert.rejects(f.request("disconnect"), /pending Begin release unconfirmed|CLEANUP/);
  f.humanBeginGate.resolve(); await flush();
  assert.equal(f.humans[0].info.state, "releasing");
  f.humanCloseGate.resolve(); await Promise.all([beginRejected, disconnectRejected]);
  assert.notEqual(f.humans[0].info.state, "released");
  await assert.rejects(f.open({ channelKey: "b".repeat(64) }), /CLEANUP/);
});

test("disconnect does not substitute a stale automation snapshot when the final status read fails", async t => {
  const f = humanFixture(t); await f.open(); await f.begin();
  f.backend.getAutomationControlStatus = async () => { throw new Error("original automation status unavailable"); };
  await assert.rejects(f.request("disconnect"), /original automation status unavailable/);
  assert.equal(f.humans[0].info.state, "released");
  assert.equal(f.humans[0].closeCalls, 1);
});

test("disconnect refreshes automation after fencing a pending Resume", async t => {
  const f = fixture(t); await f.open(); await f.request("pause");
  const before = (await f.request("status")).status;
  f.resumeGate = deferred();
  const resume = f.request("resume", { expectedRevision: f.state.revision, expectedWorkerBootId: "worker" });
  const rejected = assert.rejects(resume, /CLOSED/); await flush();
  const disconnect = await f.request("disconnect");
  assert.equal(disconnect.status.automation.state, "paused");
  assert.ok(disconnect.status.automation.revision > before.automation.revision);
  assert.deepEqual(disconnect.status.automation, f.state);
  f.resumeGate.resolve(); await rejected;
  assert.deepEqual(disconnect.status.automation, f.state);
});

test("failed human Begin cleanup remains a sticky barrier with no delivered handle", async t => {
  const f = humanFixture(t); await f.open();
  f.backend.beginManagedHuman = async () => { throw Object.assign(new Error("unconfirmed native release"), { humanCleanupIncomplete: true }); };
  await assert.rejects(f.request("humanBegin", { tabId: 7 }), /unconfirmed native release/);
  await assert.rejects(f.request("select", { tabId: 7 }), /unconfirmed native release|CLEANUP/);
  await assert.rejects(f.request("disconnect"), /unconfirmed native release|CLEANUP/);
  await assert.rejects(f.open({ channelKey: "b".repeat(64) }), /CLEANUP/);
});

test("mismatched human frame cannot grant input or replace the original lease", async t => {
  for (const changed of [{ humanLeaseId: "different" }, { generation: 2 }, { controlMode: undefined }]) {
    const f = humanFixture(t); await f.open(); await f.request("humanBegin", { tabId: 7 });
    f.humanFrame(1, changed); await flush();
    assert.equal(f.events.filter(event => event.type === "frame").length, 0);
    assert.equal(f.humans[0].closeCalls, 1);
    assert.equal((await f.request("status")).status.human, null);
  }
});

function resultFixture(t) {
  const f = humanFixture(t);
  f.views = [];
  f.liveTabs = [{ id: 7, kind: "result", deliveryId: "delivery-original", watchable: true, takeover: true, title: "Original result", url: "https://example.test/result" }];
  f.backend.managedViewerSubscribe = async (tabId, onFrame, onState, options, authority) => {
    authority(); assert.deepEqual(options, { deliveryId: f.liveTabs.find(tab => tab.id === tabId)?.deliveryId });
    const closed = deferred(), record = { tabId, onFrame, onState, authority, closeCalls: 0,
      info: { state: "active", leaseId: `view-${f.views.length + 1}`, tabId, generation: 1, viewport: { width: 800, height: 600 }, lastInputSequence: 0 } };
    record.handle = { info: () => ({ ...record.info }), tabInfo: () => ({ id: tabId, title: "Original result", url: "https://example.test/result" }), closed: closed.promise,
      close() {
        if (record.closing) return record.closing;
        record.closeCalls++; record.info.state = "releasing"; closed.resolve({ reason: "ended" });
        return record.closing = (async () => { await f.closeGate?.promise; if (f.viewCleanupError) throw f.viewCleanupError;
          record.info.state = "released"; f.calls.push(["viewReleased", tabId]); })();
      } };
    f.views.push(record); f.calls.push(["viewBegin", tabId]);
    await f.subscribeGate?.promise;
    authority();
    if (f.earlyViewFrame) f.viewFrame(1, {}, record);
    return record.handle;
  };
  f.viewFrame = (sequence, extra = {}, record = f.views.at(-1)) => record.onFrame({ tabId: record.tabId,
    streamId: `view-stream-${record.info.leaseId}-g${record.info.generation}`, sequence, mimeType: "image/png",
    data: Buffer.from(`view frame ${sequence}`).toString("base64"), metadata: { deviceWidth: 800, deviceHeight: 600, pageScaleFactor: 1 },
    controlMode: "user-view", viewLeaseId: record.info.leaseId, generation: record.info.generation, ...extra });
  f.view = () => f.request("select", { tabId: 7, deliveryId: "delivery-original" });
  f.navigateView = generation => {
    Object.assign(f.views.at(-1).info, { state: "navigating", generation, viewport: null });
    f.views.at(-1).onState({ ...f.views.at(-1).info });
  };
  f.arriveView = generation => {
    Object.assign(f.views.at(-1).info, { state: "active", generation, viewport: { width: 800, height: 600 } });
    f.views.at(-1).onState({ ...f.views.at(-1).info }); f.viewFrame(1);
  };
  return f;
}

test("a delivered result is viewed while paused without human input authority", async t => {
  const f = resultFixture(t); await f.open(); await f.request("pause"); f.calls.length = 0;
  f.earlyViewFrame = true;
  const result = await f.view(); await flush();
  assert.equal(result.status.automation.state, "paused"); assert.equal(result.status.human, null);
  assert.equal(result.status.view.leaseId, "view-1"); assert.equal(f.views[0].handle.input, undefined);
  assert.equal(result.status.tabs[0].deliveryId, "delivery-original");
  const frame = f.events.find(e => e.type === "frame"); assert.equal(frame.controlMode, "user-view");
  const announcement = f.events.find(e => e.type === "status" && e.status.view?.leaseId === frame.viewLeaseId);
  assert.ok(announcement.sequence < frame.sequence);
  await assert.rejects(f.request("humanInput", { leaseId: "view-1", generation: 1, sequence: 1, input: { type: "text", text: "must not send" } }), /HUMAN_STALE/);
  assert.deepEqual(f.calls, [["viewBegin", 7]]);
});

test("result selections require their exact delivery identity and declared capabilities", async t => {
  const f = resultFixture(t); await f.open();
  for (const operation of ["select", "humanBegin"]) {
    for (const deliveryId of [undefined, "replacement", ""]) await assert.rejects(f.request(operation, { tabId: 7, ...(deliveryId === undefined ? {} : { deliveryId }) }), /TAB|PROTOCOL/);
  }
  f.liveTabs[0].watchable = false; await assert.rejects(f.view(), /TAB/);
  f.liveTabs[0].takeover = false; await assert.rejects(f.request("humanBegin", { tabId: 7, deliveryId: "delivery-original" }), /TAB/);
  assert.equal(f.views.length, 0); assert.equal(f.humans.length, 0);
  f.liveTabs = [{ id: 7, title: "Task" }]; await assert.rejects(f.view(), /TAB/);
  for (const changed of [{ watchable: "yes" }, { deliveryId: undefined }, { kind: "unknown" }]) {
    f.liveTabs = [{ id: 7, kind: "result", deliveryId: "delivery-original", watchable: true, takeover: true, ...changed }];
    await assert.rejects(f.request("status"), /TABS/);
  }
});

test("result viewing navigation announces the successor before frames and retires exact old credit once", async t => {
  const f = resultFixture(t); await f.open(); await f.view(); f.viewFrame(1); await flush();
  const original = f.events.find(e => e.type === "frame");
  f.navigateView(2); await flush(); f.arriveView(2); await flush();
  const successor = f.events.filter(e => e.type === "frame").at(-1);
  assert.equal(successor.generation, 2); assert.equal(f.views.length, 1);
  const announcement = f.events.find(e => e.type === "status" && e.status.view?.generation === 2 && e.status.view.state === "active");
  assert.ok(announcement.sequence < successor.sequence);
  f.viewFrame(99, { generation: 1, streamId: original.streamId });
  await f.request("ack", { sequence: original.sequence });
  await assert.rejects(f.request("ack", { sequence: original.sequence }), /ACK/);
  f.viewFrame(2); assert.equal(f.events.filter(e => e.type === "frame").at(-1), successor);
  await f.request("ack", { sequence: successor.sequence });
  assert.equal(f.events.filter(e => e.type === "frame").at(-1).frameSequence, 2);
  assert.equal(f.views[0].closeCalls, 0);
});

test("a late result-view navigation notification cannot disappear during status publication", async t => {
  const f = resultFixture(t); await f.open(); await f.view();
  const eventPush = f.events.push.bind(f.events); let navigated = false;
  f.events.push = (...events) => { const n = eventPush(...events);
    if (!navigated && events.some(e => e.type === "status" && e.status.view?.state === "active")) {
      navigated = true; queueMicrotask(() => f.navigateView(2));
    } return n;
  };
  f.viewFrame(1); await flush(); await flush();
  assert.equal(f.events.filter(e => e.type === "status").at(-1).status.view.state, "navigating");
  assert.equal(f.events.filter(e => e.type === "status").at(-1).status.view.generation, 2);
});

test("explicit result takeover joins original view cleanup before sending Begin and retains deliveryId", async t => {
  const f = resultFixture(t); await f.open(); await f.view(); f.closeGate = deferred();
  const originalBegin = f.backend.beginManagedHuman;
  f.backend.beginManagedHuman = (...args) => { assert.deepEqual(args[4], { deliveryId: "delivery-original" }); return originalBegin(...args); };
  const takeover = f.request("humanBegin", { tabId: 7, deliveryId: "delivery-original" }); await flush();
  assert.equal(f.humans.length, 0); assert.equal(f.views[0].info.state, "releasing");
  assert.throws(f.views[0].authority, /CLOSED/);
  f.closeGate.resolve(); const result = await takeover;
  assert.equal(result.status.view, null); assert.equal(result.status.human.leaseId, "human-1");
  assert.ok(f.calls.findIndex(c => c[0] === "viewReleased") < f.calls.findIndex(c => c[0] === "humanBegin"));
});

test("Resume waits for original result viewing cleanup without gaining input from its lease", async t => {
  const f = resultFixture(t); await f.open(); await f.request("pause"); await f.view(); f.closeGate = deferred();
  const resume = f.request("resume", { expectedRevision: f.state.revision, expectedWorkerBootId: "worker" }); await flush();
  assert.equal(f.calls.some(c => c[0] === "resume"), false); assert.equal(f.state.state, "paused");
  f.closeGate.resolve(); const result = await resume;
  assert.equal(result.status.automation.state, "running"); assert.equal(result.status.view, null);
  assert.ok(f.calls.findIndex(c => c[0] === "viewReleased") < f.calls.findIndex(c => c[0] === "resume"));
});

test("result view cleanup failure blocks takeover, Resume and replacement channel", async t => {
  const f = resultFixture(t); await f.open(); await f.request("pause"); await f.view();
  f.viewCleanupError = new Error("original view detach remains unknown");
  await assert.rejects(f.request("humanBegin", { tabId: 7, deliveryId: "delivery-original" }), /detach remains unknown/);
  await assert.rejects(f.request("resume", { expectedRevision: f.state.revision, expectedWorkerBootId: "worker" }), /CLEANUP/);
  await assert.rejects(f.request("disconnect"), /CLEANUP|detach remains unknown/);
  await assert.rejects(f.open({ channelKey: "b".repeat(64) }), /CLEANUP/);
  assert.equal(f.humans.length, 0); assert.equal(f.state.state, "paused");
});

test("a selection cannot introduce a new result lease across an in-flight Resume", async t => {
  const f = resultFixture(t); await f.open(); await f.request("pause");
  f.resumeGate = deferred();
  const resume = f.request("resume", { expectedRevision: f.state.revision, expectedWorkerBootId: "worker" }); await flush();
  await assert.rejects(f.view(), /BUSY/);
  await assert.rejects(f.request("humanBegin", { tabId: 7, deliveryId: "delivery-original" }), /BUSY/);
  assert.equal(f.views.length, 0); assert.equal(f.humans.length, 0);
  f.resumeGate.resolve(); await resume; assert.equal(f.state.state, "running");
});

test("replacement delivery at the same tab retires the old selection and rejects its old choice", async t => {
  const f = resultFixture(t); await f.open(); await f.view();
  f.liveTabs[0].deliveryId = "delivery-replacement";
  const result = await f.request("status");
  assert.equal(result.status.view, null); assert.equal(result.status.selectedTabId, null);
  assert.equal(f.views[0].info.state, "released"); await assert.rejects(f.view(), /TAB/);
});


test("trusted replacement open forwards only the frozen recovery contract and returns its actual private receipt", async t => {
  const f = fixture(t), recoveryState = { version: 1, browserIncarnation: "browser-A", journalId: "journal-A", workerEpoch: 2 };
  const recovery = { kind: "worker-replacement", previousWorkerBootId: "old-worker", browserIncarnation: "browser-A",
    expectedJournalId: "journal-A", expectedWorkerEpoch: 1, nonce: "original-recovery" };
  const workerRecovery = { kind: recovery.kind, nonce: recovery.nonce, previousWorkerBootId: recovery.previousWorkerBootId,
    workerBootId: "worker", browserIncarnation: "browser-A", journalId: "journal-A", fromWorkerEpoch: 1, toWorkerEpoch: 2,
    inputRiskClear: true, paused: true, retiredViews: [{ leaseId: "original-view", targetId: "original-target",
      outcome: "stopped-and-detached", stopAcknowledged: true, detachAcknowledged: true }] };
  const admission = { recoveryState, workerRecovery };
  f.backend.prepareManagedUserOpen = async (request, check) => {
    assert.deepEqual(request, { workerBootId: "worker", recovery }); assert.equal(Object.isFrozen(request.recovery), true);
    check(); f.state.state = "paused"; f.state.cleanupComplete = true; return admission;
  };
  f.backend.commitManagedUserOpen = token => { assert.equal(token, admission); f.openCommitted = true; };
  const opened = await f.open({ recovery });
  assert.deepEqual(opened.recoveryState, recoveryState); assert.deepEqual(opened.workerRecovery, workerRecovery);
  assert.equal(f.openCommitted, true); assert.equal(opened.status.automation.state, "paused");
  assert.equal(f.calls.some(([operation]) => operation === "resume"), false);
});

test("pending dialog is persistent status metadata and publishes without a new encoded frame", async t => {
  const f = humanFixture(t); await f.open(); await f.begin();
  const frames = f.events.filter(value => value.type === "frame").length;
  const dialog = f.dialog({ type: "prompt", defaultPrompt: "原值" }); await flush();
  const status = (await f.request("status")).status;
  assert.deepEqual(status.pendingDialog, dialog); assert.equal(f.events.filter(value => value.type === "frame").length, frames);
  assert.deepEqual(f.events.filter(value => value.type === "status").at(-1).status.pendingDialog, dialog);
  assert.equal(status.human.lastInputSequence, 0);
  const ended = await f.request("humanEnd", { leaseId: dialog.leaseId }); assert.equal(ended.status.pendingDialog, null);
  assert.equal((await f.request("disconnect")).status.pendingDialog, null);
});

test("typed dialog response bypasses a pending human input and owns a separate original receipt", async t => {
  const f = humanFixture(t); await f.open(); await f.begin(); f.humanInputGate = deferred();
  const input = f.input(1); await flush(); const dialog = f.dialog();
  const response = await f.answerDialog();
  assert.deepEqual(response.dialogReceipt, { leaseId: dialog.leaseId, generation: 1, dialogId: dialog.dialogId, acknowledged: true });
  assert.equal(Object.hasOwn(response, "inputReceipt"), false); assert.equal(response.status.human.lastInputSequence, 0);
  assert.deepEqual(response.status.pendingDialog, dialog, "response ACK does not manufacture a closed event");
  f.humanInputGate.resolve(); assert.equal((await input).inputReceipt.sequence, 1);
});

test("old dialog ACK cannot clear a newer dialog and the new decision does not queue behind it", async t => {
  const f = humanFixture(t); await f.open(); await f.begin();
  const oldGate = deferred(); f.dialogGates.push(oldGate); f.dialogResponseGate = oldGate;
  const first = f.dialog(), old = f.answerDialog(); await flush();
  f.dialogResponseGate = null; const second = f.dialog({ message: "Next native opening" });
  assert.equal((await f.answerDialog()).dialogReceipt.dialogId, second.dialogId);
  oldGate.resolve(); const late = await old;
  assert.equal(late.dialogReceipt.dialogId, first.dialogId); assert.deepEqual(late.status.pendingDialog, second);
  assert.equal(f.calls.filter(([name]) => name === "humanDialogRespond").length, 2);
});

test("stale, duplicate, malformed and non-human dialog requests cannot become native decisions", async t => {
  const f = humanFixture(t); await f.open();
  const fields = { leaseId: "human-1", generation: 1, dialogId: "missing", accept: true };
  await assert.rejects(f.request("humanDialogRespond", fields), /DIALOG_STALE/);
  await f.begin(); const dialog = f.dialog();
  for (const extra of [{ leaseId: "view-1" }, { generation: 2 }, { dialogId: "old" }]) await assert.rejects(f.answerDialog(extra), /DIALOG_STALE/);
  for (const extra of [{ accept: 1 }, { promptText: "\ud800" }, { accept: false, promptText: "no" }, { method: "Page.handleJavaScriptDialog" }])
    await assert.rejects(f.answerDialog(extra), /DIALOG_INVALID|PROTOCOL/);
  assert.equal(f.calls.some(([name]) => name === "humanDialogRespond"), false);
  await f.answerDialog(); await assert.rejects(f.answerDialog(), /DIALOG_STALE/);
  assert.equal(f.calls.filter(([name]) => name === "humanDialogRespond").length, 1);
  await f.request("humanEnd", { leaseId: dialog.leaseId });
  await assert.rejects(f.answerDialog({}, dialog), /DIALOG_STALE/);
});

test("dialog receipt mismatch retires the original lease without manufacturing acknowledgement", async t => {
  const f = humanFixture(t); await f.open(); await f.begin(); f.dialog(); f.dialogReplyOverride = { dialogId: "forged" };
  await assert.rejects(f.answerDialog(), /DIALOG_UNCONFIRMED/);
  const status = (await f.request("status")).status;
  assert.equal(status.human, null); assert.equal(status.pendingDialog, null); assert.equal(f.humans[0].closeCalls, 1);
});

test("worker replacement schema rejects extra capabilities, same boot, invalid epoch and getters before backend admission", async t => {
  const recovery = { kind: "worker-replacement", previousWorkerBootId: "old-worker", browserIncarnation: "browser-A",
    expectedJournalId: "journal-A", expectedWorkerEpoch: 1, nonce: "recovery" };
  for (const invalid of [{ ...recovery, inputRiskClear: true }, { ...recovery, previousWorkerBootId: "worker" },
    { ...recovery, expectedWorkerEpoch: 0 }, { ...recovery, expectedWorkerEpoch: Number.MAX_SAFE_INTEGER + 1 },
    Object.defineProperty({ ...recovery }, "nonce", { get() { throw Error("getter invoked"); } })]) {
    const f = fixture(t); let entered = false;
    f.backend.prepareManagedUserOpen = async () => { entered = true; };
    await assert.rejects(f.open({ recovery: invalid }), /PROTOCOL|IDENTITY/);
    assert.equal(entered, false);
  }
});

test("replacement open cannot commit after original native proof changed or after unknown input rejection", async t => {
  for (const kind of ["proof", "risk", "deadline"]) await t.test(kind, async t => {
    const f = fixture(t); let committed = false;
    f.backend.prepareManagedUserOpen = async (_request, check) => {
      if (kind === "risk") throw Error("OBU_INPUT_RELEASE_UNCONFIRMED: original held input unknown");
      if (kind === "proof") f.target.__obuNativeDownloadBinding = { ...f.target.__obuNativeDownloadBinding, portId: "other" };
      else f.advance(10001);
      check(); throw Error("unreachable admission");
    };
    f.backend.commitManagedUserOpen = () => { committed = true; };
    await assert.rejects(f.open(), /IDENTITY|CLOSED|INPUT_RELEASE_UNCONFIRMED/);
    assert.equal(committed, false); assert.equal(f.calls.some(([operation]) => operation === "resume"), false);
  });
});

function preparingFixture(t, generation = 0) {
  const f = humanFixture(t, { inputBudgetVersion: 1 }), original = f.backend.beginManagedHuman;
  f.backend.beginManagedHuman = async (...args) => {
    const handle = await original(...args);
    Object.assign(f.humans.at(-1).info, { state: "preparing", generation, viewport: null });
    return handle;
  };
  return f;
}

for (const generation of [0, 1]) test(`preparing owner generation ${generation} returns admission and End joins actual cleanup`, async t => {
  const f = preparingFixture(t, generation); await f.open();
  const result = await f.request("humanBegin", { tabId: 7 });
  assert.equal(result.status.human.state, "preparing"); assert.equal(result.status.human.generation, generation);
  assert.equal(result.status.human.inputBudgetVersion, 1); assert.equal(result.status.human.viewport, null);
  assert.equal(f.events.some(x => x.type === "frame"), false);
  await assert.rejects(f.input(1), /HUMAN_STALE/); assert.equal(f.humans[0].inputCalls, 0);
  f.humanCloseGate = deferred(); let settled = false;
  const end = f.request("humanEnd", { leaseId: result.status.human.leaseId }).then(value => { settled = true; return value; });
  await flush(); assert.equal(settled, false); assert.equal(f.humans[0].closeCalls, 1);
  f.humanCloseGate.resolve(); const closed = await end;
  assert.equal(closed.status.humanCleanup.cleanupConfirmed, true);
});

test("preparing positive generation needs an original pending dialog, not just a generation", async t => {
  const f = preparingFixture(t, 1); await f.open(); await f.request("humanBegin", { tabId: 7 });
  await assert.rejects(f.request("humanDialogRespond", { leaseId: "human-1", generation: 1, dialogId: "missing", accept: true }), /DIALOG_STALE/);
  const original = f.dialog({ type: "prompt", defaultPrompt: "原值" }); await flush();
  assert.deepEqual(f.events.filter(x => x.type === "status").at(-1).status.pendingDialog, original);
  const answer = await f.answerDialog({ promptText: "回答😀" });
  assert.equal(answer.dialogReceipt.dialogId, original.dialogId); assert.equal(answer.dialogReceipt.acknowledged, true);
  assert.equal(f.humans[0].inputCalls, 0);
});

test("preparing zero generation cannot submit a dialog decision", async t => {
  const f = preparingFixture(t); await f.open(); await f.request("humanBegin", { tabId: 7 }); f.dialog();
  await assert.rejects(f.answerDialog(), /DIALOG_INVALID/);
  assert.equal(f.calls.some(([name]) => name === "humanDialogRespond"), false);
});

test("navigation dialog responds while the original input still owns its pending promise", async t => {
  const f = humanFixture(t); await f.open(); await f.begin(); f.humanInputGate = deferred();
  let settled = false; const input = f.input(1).then(value => { settled = true; return value; }); await flush();
  f.navigate(2); const original = f.dialog(); const answer = await f.answerDialog();
  assert.equal(answer.dialogReceipt.generation, 2); assert.equal(answer.dialogReceipt.dialogId, original.dialogId);
  assert.equal(settled, false); assert.equal(f.humans[0].inputCalls, 1);
  f.humanInputGate.resolve(); assert.equal((await input).inputReceipt.generation, 1);
});

test("late preparing handle after disconnect is closed rather than granting a new owner", async t => {
  const f = preparingFixture(t); await f.open(); f.humanBeginGate = deferred();
  const begin = f.request("humanBegin", { tabId: 7 }); const rejected = assert.rejects(begin, /CLOSED|RETIRED|STALE|AUTHORITY/);
  await flush(); const disconnect = f.request("disconnect"); await flush();
  f.humanBeginGate.resolve(); await rejected; const closed = await disconnect;
  assert.equal(closed.status.connected, false); assert.equal(f.humans[0].closeCalls, 1);
  assert.equal(f.humans[0].info.state, "released");
});

function pageChoicesFixture(t) {
  const f = resultFixture(t);
  f.pageTabs = [{ id: 8, kind: "browser", pageSelectionId: "original-choice", title: "Native child", url: "https://child.test/",
    watchable: true, takeover: true }];
  f.catalogs = []; f.pageSelectCalls = [];
  f.pageSelectEntered = deferred(); f.pageCommitted = deferred();
  f.backend.getManagedViewerTabs = async ({ excludeTabId } = {}) => {
    f.listExclusions ??= []; f.listExclusions.push(excludeTabId);
    return f.liveTabs.filter(tab => tab.id !== excludeTabId);
  };
  f.backend.createManagedPageChoices = ({ check }) => {
    const owner = { revoked: false, pending: new Set() }; f.catalogs.push(owner);
    const current = () => { check(); if (owner.revoked) throw new Error("catalog revoked"); };
    return {
      async list() { current(); await f.pageListGate?.promise; current(); return f.pageTabs; },
      select(tabId, pageSelectionId, { check: selectionCheck }) {
        const actual = (async () => {
          current(); selectionCheck();
          assert.equal(f.state.state, "paused"); assert.equal(f.state.cleanupComplete, true);
          assert.ok(f.pageTabs.some(tab => tab.id === tabId && tab.pageSelectionId === pageSelectionId));
          f.pageSelectCalls.push({ tabId, pageSelectionId });
          f.pageSelectEntered.resolve();
          await f.pageCommitGate?.promise; current(); selectionCheck();
          const deliveryId = `retained-${tabId}`;
          const { pageSelectionId: _, ...tab } = f.pageTabs.find(tab => tab.id === tabId);
          f.liveTabs.push({ ...tab, kind: "result", deliveryId });
          f.pageTabs = f.pageTabs.filter(tab => tab.id !== tabId);
          f.calls.push(["pageCommitted", tabId]);
          f.pageCommitted.resolve();
          await f.pageDeliveryGate?.promise; current(); selectionCheck();
          return { tabId, pageSelectionId, deliveryId, retained: true, ...f.pageReceiptOverride };
        })();
        owner.pending.add(actual);
        actual.then(() => owner.pending.delete(actual), () => owner.pending.delete(actual));
        return actual;
      },
      revoke() { owner.revoked = true; },
      async drain() {
        await Promise.allSettled([...owner.pending]); await f.catalogDrainGate?.promise;
        if (f.catalogCleanupError) throw f.catalogCleanupError;
      }
    };
  };
  f.choose = (operation = "select", extra = {}) => f.request(operation, { tabId: 8, pageSelectionId: "original-choice", ...extra });
  return f;
}

test("a channel pins browser-page capability and projects only original catalog metadata", async t => {
  const f = pageChoicesFixture(t);
  f.pageTabs[0].secret = "not-public";
  const opened = await f.open();
  assert.equal(opened.status.pageSelectionVersion, 1);
  assert.equal(opened.status.tabs.length, 2);
  assert.equal(opened.status.tabs[1].pageSelectionId, "original-choice");
  assert.equal(opened.status.tabs[1].secret, undefined);
  delete f.backend.createManagedPageChoices;
  assert.equal((await f.request("status")).status.pageSelectionVersion, 1);
  const closed = await f.request("disconnect");
  assert.equal(closed.status.pageSelectionVersion, 1); assert.equal(f.catalogs[0].revoked, true);
  assert.equal((await f.open({ channelKey: "b".repeat(64) })).status.pageSelectionVersion, undefined);
});

test("a native browser choice pauses the Agent and returns the exact committed result receipt", async t => {
  const f = pageChoicesFixture(t); await f.open(); f.calls.length = 0;
  const reply = await f.choose();
  assert.deepEqual(reply.pageSelectionReceipt, { tabId: 8, pageSelectionId: "original-choice", deliveryId: "retained-8", retained: true });
  assert.deepEqual(f.calls, [["pause"], ["pageCommitted", 8], ["viewBegin", 8]]);
  assert.equal(reply.status.automation.state, "paused"); assert.equal(reply.status.human, null);
  assert.equal(reply.status.tabs.find(tab => tab.id === 8).kind, "result");
  assert.equal(reply.status.tabs.find(tab => tab.id === 8).pageSelectionId, undefined);
  await assert.rejects(f.choose(), /TAB/);
  const old = await f.request("select", { tabId: 8, deliveryId: "retained-8" });
  assert.equal(old.pageSelectionReceipt, undefined); assert.equal(f.pageSelectCalls.length, 1);
});

test("direct human Begin on a browser choice uses the real retained delivery after prior view cleanup", async t => {
  const f = pageChoicesFixture(t); await f.open(); await f.view(); f.closeGate = deferred();
  const begun = f.choose("humanBegin"); await flush();
  assert.equal(f.pageSelectCalls.length, 0); assert.equal(f.humans.length, 0);
  f.closeGate.resolve(); const reply = await begun;
  assert.equal(reply.pageSelectionReceipt.deliveryId, "retained-8");
  assert.deepEqual(f.humans[0].options, { deliveryId: "retained-8" });
  assert.ok(f.calls.findIndex(call => call[0] === "viewReleased") < f.calls.findIndex(call => call[0] === "pageCommitted"));
});

test("active human metadata coexists with other native pages without validating that human result again", async t => {
  const f = pageChoicesFixture(t); await f.open();
  await f.request("humanBegin", { tabId: 7, deliveryId: "delivery-original" });
  f.humans[0].handle.tabInfo = () => ({ id: 7, title: "Current human document", url: "https://callback.test/" });
  f.pageTabs.push({ ...f.pageTabs[0], id: 7, pageSelectionId: "duplicate-human" });
  const reply = await f.request("status");
  assert.equal(f.listExclusions.at(-1), 7);
  assert.deepEqual(reply.status.tabs.map(tab => tab.id), [7, 8]);
  assert.equal(reply.status.tabs[0].title, "Current human document");
  assert.equal(reply.status.tabs[0].kind, "result");
  for (const operation of ["select", "humanBegin"]) await assert.rejects(f.choose(operation), /HUMAN_BUSY/);
  assert.equal(f.pageSelectCalls.length, 0);
});

test("switching after End cannot publish another page before the original human cleanup settles", async t => {
  const f = pageChoicesFixture(t); await f.open();
  await f.request("humanBegin", { tabId: 7, deliveryId: "delivery-original" });
  f.humanCloseGate = deferred();
  const ended = f.request("humanEnd", { leaseId: "human-1" }); await flush();
  const chosen = f.choose(); await flush(); assert.equal(f.pageSelectCalls.length, 0);
  f.humanCloseGate.resolve(); const end = await ended, choice = await chosen;
  assert.deepEqual(end.status.humanCleanup, { leaseId: "human-1", cleanupConfirmed: true });
  assert.equal(choice.pageSelectionReceipt.deliveryId, "retained-8");
  assert.ok(f.calls.findIndex(call => call[0] === "humanReleased") < f.calls.findIndex(call => call[0] === "pageCommitted"));
});

test("invalid selector combinations and unadvertised page choices never reach the catalog", async t => {
  const f = pageChoicesFixture(t); await f.open();
  for (const operation of ["select", "humanBegin"]) {
    for (const change of [{ deliveryId: "delivery-original" }, { pageSelectionId: "wrong" }, { pageSelectionId: "" },
      { pageSelectionId: undefined }, { tabId: null }, { tabId: 7 }]) await assert.rejects(f.choose(operation, change), /TAB|PROTOCOL/);
  }
  assert.equal(f.pageSelectCalls.length, 0);
  const legacy = fixture(t); await legacy.open();
  await assert.rejects(legacy.request("select", { tabId: 7, pageSelectionId: "unexpected" }), /PROTOCOL/);
});

test("catalog capabilities cannot smuggle a delivery, duplicate an original ID or omit its choice", async t => {
  const f = pageChoicesFixture(t); await f.open();
  const original = { ...f.pageTabs[0] };
  for (const change of [{ deliveryId: "forged" }, { pageSelectionId: undefined }, { kind: "result" }, { watchable: "yes" }]) {
    f.pageTabs = [{ ...original, ...change }]; await assert.rejects(f.request("status"), /TABS/);
  }
  f.pageTabs = [original, { ...original }]; await assert.rejects(f.request("status"), /TABS/);
});

test("a mismatched or unsolicited retention receipt never starts a view or human lease", async t => {
  for (const change of [{ tabId: 9 }, { pageSelectionId: "foreign" }, { deliveryId: "" }, { retained: false }, { extra: true }]) {
    const f = pageChoicesFixture(t); await f.open(); f.pageReceiptOverride = change;
    await assert.rejects(f.choose("humanBegin"), /PAGE_UNCONFIRMED|PROTOCOL/);
    assert.equal(f.humans.length, 0); assert.equal(f.views.length, 0);
    assert.equal(f.liveTabs.find(tab => tab.id === 8).deliveryId, "retained-8");
  }
});

test("Resume cannot cross an in-flight browser selection or its actual commit", async t => {
  const f = pageChoicesFixture(t); await f.open(); f.pageCommitGate = deferred();
  const chosen = f.choose(); await f.pageSelectEntered.promise;
  assert.equal(f.pageSelectCalls.length, 1);
  await assert.rejects(f.request("resume", { expectedRevision: f.state.revision, expectedWorkerBootId: "worker" }), /BUSY/);
  assert.equal(f.calls.some(call => call[0] === "resume"), false);
  f.pageCommitGate.resolve(); await chosen;
});

test("disconnect joins an actual committed selection but never delivers or starts its late lease", async t => {
  const f = pageChoicesFixture(t); await f.open(); f.pageDeliveryGate = deferred();
  const chosen = assert.rejects(f.choose(), /CLOSED|revoked/); await f.pageCommitted.promise;
  assert.equal(f.liveTabs.find(tab => tab.id === 8).deliveryId, "retained-8");
  let settled = false;
  const closed = f.request("disconnect").then(value => { settled = true; return value; }); await flush();
  assert.equal(settled, false); assert.equal(f.catalogs[0].revoked, true);
  f.pageDeliveryGate.resolve(); await chosen;
  assert.equal((await closed).status.connected, false);
  assert.equal(f.views.length, 0); assert.equal(f.humans.length, 0);
  assert.equal(f.liveTabs.find(tab => tab.id === 8).deliveryId, "retained-8");
});

test("clear selection during original commit fences its late receipt and waits for actual settlement", async t => {
  const f = pageChoicesFixture(t); await f.open(); f.pageDeliveryGate = deferred();
  const chosen = assert.rejects(f.choose(), /CLOSED/); await f.pageCommitted.promise;
  let settled = false;
  const cleared = f.request("select", { tabId: null }).then(value => { settled = true; return value; }); await flush();
  assert.equal(settled, false); assert.equal(f.views.length, 0);
  f.pageDeliveryGate.resolve(); await chosen;
  assert.equal((await cleared).status.selectedTabId, null);
});

test("catalog drain failure remains a cleanup barrier for channel replacement", async t => {
  const f = pageChoicesFixture(t); await f.open(); f.catalogCleanupError = new Error("original catalog cleanup unconfirmed");
  await assert.rejects(f.request("disconnect"), /cleanup unconfirmed/);
  await assert.rejects(f.open({ channelKey: "b".repeat(64) }), /CLEANUP/);
});

async function closedOriginal(t) {
  const f = humanFixture(t);
  await f.open(); await f.begin();
  f.humanCloseGate = deferred();
  f.liveTabs = [];
  const child = f.humans[0];
  const realClose = child.handle.close();
  await flush();
  assert.ok(f.events.some(event => event.type === "clear"));
  const state = (await f.request("status")).status;
  assert.equal(state.human, null);
  assert.equal(state.selectedTabId, null);
  assert.equal(state.cleanupPending, 1);
  assert.equal(state.humanCleanup, undefined);
  return { f, child, realClose };
}

test("native child close lets exact humanEnd wait for actual cleanup and return its receipt", async t => {
  const { f, child, realClose } = await closedOriginal(t);
  let settled = false;
  const result = f.request("humanEnd", { leaseId: child.info.leaseId }).then(value => { settled = true; return value; }, error => { settled = true; throw error; });
  result.catch(() => {});
  await flush();
  assert.equal(settled, false, "exact retired lease End must join actual original close, not reject immediately");
  f.humanCloseGate.resolve(); await realClose;
  const response = await result;
  assert.deepEqual(response.status.humanCleanup, { leaseId: child.info.leaseId, cleanupConfirmed: true });
  assert.equal(response.status.cleanupPending, 0);
  assert.equal(response.status.human, null);
});

test("unknown retired lease is rejected without starting another close", async t => {
  const { f, child, realClose } = await closedOriginal(t);
  await assert.rejects(f.request("humanEnd", { leaseId: "unknown" }), /HUMAN_STALE/);
  assert.equal(child.closeCalls, 1);
  f.humanCloseGate.resolve(); await realClose;
});
test("concurrent exact End joins one actual close and repeated cleanup preserves exact receipt", async t => {
  const { f, child, realClose } = await closedOriginal(t);
  const requests = [f.request("humanEnd", { leaseId: child.info.leaseId }), f.request("humanEnd", { leaseId: child.info.leaseId })];
  let settled = 0; for (const request of requests) request.then(() => settled++, () => settled++);
  await flush(); assert.equal(settled, 0); assert.equal(child.closeCalls, 1);
  f.humanCloseGate.resolve(); await realClose;
  for (const result of await Promise.all(requests)) assert.deepEqual(result.status.humanCleanup, { leaseId: child.info.leaseId, cleanupConfirmed: true });
  const repeated = await f.request("humanEnd", { leaseId: child.info.leaseId });
  assert.deepEqual(repeated.status.humanCleanup, { leaseId: child.info.leaseId, cleanupConfirmed: true });
  assert.equal(child.closeCalls, 1);
});
test("failed actual cleanup never manufactures a retired release receipt", async t => {
  const { f, child, realClose } = await closedOriginal(t);
  f.humanCleanupError = new Error("original cleanup failed");
  const result = f.request("humanEnd", { leaseId: child.info.leaseId });
  const rejected = assert.rejects(result, /original cleanup failed/);
  realClose.catch(() => {});
  f.humanCloseGate.resolve(); await rejected;
  const state = (await f.request("status")).status;
  assert.equal(state.humanCleanup, undefined);
  assert.match(state.cleanupError, /original cleanup failed/);
});
test("a new human lease prevents old End from touching its owner", async t => {
  const { f, child, realClose } = await closedOriginal(t);
  f.humanCloseGate.resolve(); await realClose; await flush();
  f.liveTabs = [{ id: 7, title: "Parent", url: "https://example.test/parent" }];
  await f.begin();
  await assert.rejects(f.request("humanEnd", { leaseId: child.info.leaseId }), /HUMAN_STALE/);
  assert.equal(f.humans[1].closeCalls, 0);
  assert.equal((await f.request("status")).status.human.leaseId, "human-2");
});
test("a new selected view prevents old End from touching its owner", async t => {
  const { f, child, realClose } = await closedOriginal(t);
  f.humanCloseGate.resolve(); await realClose; await flush();
  f.liveTabs = [{ id: 7, title: "Parent", url: "https://example.test/parent" }];
  await f.request("select", { tabId: 7 });
  await assert.rejects(f.request("humanEnd", { leaseId: child.info.leaseId }), /HUMAN_STALE/);
  assert.equal(f.subscriptions.at(-1).closeCalls, 0);
  assert.equal((await f.request("status")).status.selectedTabId, 7);
});
test("disconnect while retired End is awaiting cleanup revokes its publication", async t => {
  const { f, child, realClose } = await closedOriginal(t);
  const result = f.request("humanEnd", { leaseId: child.info.leaseId });
  const rejected = assert.rejects(result, /CLOSED/);
  const disconnected = f.request("disconnect");
  f.humanCloseGate.resolve(); await realClose; await rejected; await disconnected;
});
test("actual native input receipt survives original child closure in bridge", async t => {
  const f = humanFixture(t); await f.open(); await f.begin();
  const child = f.humans[0], native = deferred();
  child.handle.input = envelope => { child.pending = native.promise; return native.promise.then(() => ({ leaseId: envelope.leaseId, generation: envelope.generation, sequence: envelope.sequence, acknowledged: true })); };
  const result = f.input(1); await flush();
  const realClose = child.handle.close(); await flush();
  const end = f.request("humanEnd", { leaseId: child.info.leaseId });
  native.resolve();
  const original = await result; await realClose; const released = await end;
  assert.deepEqual(original.inputReceipt, { leaseId: child.info.leaseId, generation: 1, sequence: 1, acknowledged: true });
  assert.deepEqual(released.status.humanCleanup, { leaseId: child.info.leaseId, cleanupConfirmed: true });
});

for (const successor of ["human", "view"]) test(`retired End response cannot cross a new ${successor} admitted during status read`, async t => {
  const { f, child, realClose } = await closedOriginal(t);
  f.humanCloseGate.resolve(); await realClose; await flush();
  const readEntered = deferred(), readReturned = deferred();
  const original = f.backend.getManagedViewerTabs;
  let first = true;
  f.backend.getManagedViewerTabs = async (...args) => {
    if (first) { first = false; readEntered.resolve(); await readReturned.promise; }
    return original(...args);
  };
  const end = f.request("humanEnd", { leaseId: child.info.leaseId });
  const rejected = assert.rejects(end, /HUMAN_STALE/);
  await readEntered.promise;
  f.liveTabs = [{ id: 7, title: "Parent", url: "https://example.test/parent" }];
  if (successor === "human") await f.begin(); else await f.request("select", { tabId: 7 });
  readReturned.resolve(); await rejected;
  assert.equal((await f.request("status")).status.selectedTabId, 7);
  assert.equal(successor === "human" ? f.humans[1].closeCalls : f.subscriptions.at(-1).closeCalls, 0);
});
test("actual native input rejection survives child closure without a manufactured ACK", async t => {
  const f = humanFixture(t); await f.open(); await f.begin();
  const child = f.humans[0], native = deferred();
  child.handle.input = () => { child.pending = native.promise; return native.promise; };
  const result = f.input(1); const rejected = assert.rejects(result, /actual native target closed/); await flush();
  const realClose = child.handle.close(); await flush();
  const end = f.request("humanEnd", { leaseId: child.info.leaseId });
  native.reject(new Error("actual native target closed"));
  await rejected; await realClose;
  const released = await end;
  assert.equal(released.inputReceipt, undefined);
  assert.deepEqual(released.status.humanCleanup, { leaseId: child.info.leaseId, cleanupConfirmed: true });
});

for (const failCleanup of [false, true]) test(`reentrant exact End joins original actual cleanup (${failCleanup ? "reject" : "resolve"})`, async t => {
  const f = humanFixture(t); await f.open(); await f.begin();
  const child = f.humans[0]; f.humanCloseGate = deferred();
  if (failCleanup) f.humanCleanupError = new Error("original cleanup failed");
  let reentrant, outcome = "pending";
  const push = f.events.push;
  f.events.push = function(event) {
    const value = push.call(this, event);
    if (event.type === "clear" && !reentrant) {
      reentrant = f.request("humanEnd", { leaseId: child.info.leaseId });
      reentrant.then(() => { outcome = "resolved"; }, () => { outcome = "rejected"; });
    }
    return value;
  };
  const actual = child.handle.close(); actual.catch(() => {});
  await flush();
  assert.ok(reentrant, "Clear must trigger the same original End synchronously");
  assert.equal(outcome, "pending", "End must join actual original cleanup rather than await null or return early");
  f.humanCloseGate.resolve();
  if (failCleanup) { await assert.rejects(actual, /original cleanup failed/); await assert.rejects(reentrant, /original cleanup failed/); }
  else {
    await actual; const result = await reentrant;
    assert.deepEqual(result.status.humanCleanup, { leaseId: child.info.leaseId, cleanupConfirmed: true });
    assert.equal(result.status.cleanupPending, 0);
  }
  assert.equal(child.closeCalls, 1);
});
test("reentrant disconnect joins original cleanup already registered before Clear", async t => {
  const f = humanFixture(t); await f.open(); await f.begin();
  const child=f.humans[0]; f.humanCloseGate=deferred();
  let disconnected, settled=false;
  const push=f.events.push;
  f.events.push=function(event) {
    const value=push.call(this,event);
    if(event.type === "clear" && !disconnected) { disconnected=f.request("disconnect"); disconnected.then(()=> {settled=true;},()=> {settled=true;}); }
    return value;
  };
  const actual=child.handle.close(); await flush();
  assert.ok(disconnected); assert.equal(settled,false);
  f.humanCloseGate.resolve(); await actual;
  const result=await disconnected;
  assert.equal(result.status.connected,false);
  assert.deepEqual(result.status.humanCleanup,{leaseId:child.info.leaseId,cleanupConfirmed:true});
});

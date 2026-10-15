import assert from "node:assert/strict";
import { checkColdNavigation, coldNavigationHeldMove } from "./cold-navigation-fixture.mjs";

const json = JSON.stringify, errorText = error => error?.stack ?? String(error);
const hitDeclaration = "function hitAt(x, y) { return this.hit(x, y); }";
const scopeOf = browser => ({ session_id: browser.client.sessionId, turn_id: browser.client.turnId, control_epoch: browser.client.controlEpoch });

// Installed OUTSIDE the existing passive world observer. That observer retains
// the original Chrome Promise/ACK; only one already-successful hit reply is held
// on delivery to the reader. No native command, input or result is synthesized.
export function installColdHeldNavigationProbe(api, target, options) {
  const { tabId, documentId, contextId, contextUniqueId, frameId, scope, point, holdTimeoutMs = 15000 } = options ?? {};
  const backend = target.__integrationBackend, world = target.__obuColdWorldLifetime;
  if (target.__obuColdHeldNavigation || !world || !backend || !Number.isSafeInteger(tabId) || !documentId || !frameId ||
      !Number.isSafeInteger(contextId) || !contextUniqueId || !scope?.session_id || !scope.turn_id || !Number.isSafeInteger(scope.control_epoch) ||
      !Number.isFinite(point?.x) || !Number.isFinite(point?.y) || !Number.isInteger(holdTimeoutMs) || holdTimeoutMs < 20 || holdTimeoutMs > 30000)
    throw Error("Invalid original held-navigation observer");
  const attachment = backend.attachmentEpochs.get(tabId), initialRevision = backend.exportDocumentRevisions.get(tabId) ?? 0;
  if (!attachment || backend.browserEngine !== null || !backend.attachedTabs.has(tabId)) throw Error("Original cold attachment required");
  const nativeThen = Promise.prototype.then, original = api.debugger.sendCommand, originalMessage = api.tabs.sendMessage;
  const records = [], captures = new Map(); let size = 0, nativePending = 0, messagePending = 0, deliveryPending = 0;
  let selected, selectedRecord, originalValue, selectedNative, delivered, released = false, restored = false, watchdog = false, overflow = false, recordingErrors = 0, timer, releaseGate;
  const gate = new Promise(resolve => { releaseGate = resolve; });
  const clone = value => structuredClone(value);
  const state = () => ({ engineAbsent: backend.browserEngine === null, sameAttachment: backend.attachmentEpochs.get(tabId) === attachment,
    attached: backend.attachedTabs.has(tabId), revision: backend.exportDocumentRevisions.get(tabId) ?? 0,
    pointerPending: [...backend.pointerFeedbackReads.pending].filter(row => row.scope.tabId === tabId).length,
    selectedRetained: !!selectedRecord && backend.pointerFeedbackReads.pending.has(selectedRecord),
    selectedState: selectedRecord?.state ?? null, selectedSettled: selectedRecord?.candidate.settled ?? null,
    selectedValue: selectedRecord?.candidate.value ?? null, privateLeases: [...backend.privatePointerTargets.entries.values()].filter(row => row.root?.tabId === tabId).length });
  const append = value => {
    try { const row = clone({ sequence: records.length + 1, at: Date.now(), worldSequence: world.snapshot().records.at(-1)?.sequence ?? 0, ...value }), bytes = JSON.stringify(row).length;
      if (records.length >= 4096 || size + bytes > 24 * 1024 * 1024) { overflow = true; return null; }
      size += bytes; records.push(row); return row;
    } catch { recordingErrors++; return null; }
  };
  const snapshot = () => clone({ tabId, documentId, contextId, contextUniqueId, frameId, scope, point, initialRevision, records,
    selected: selected?.sequence ?? null, nativePending, messagePending, deliveryPending, released, restored, watchdog, overflow, recordingErrors,
    nativeAndDeliveryDistinct: !!selectedNative && !!delivered && selectedNative !== delivered, state: state() });
  const release = reason => { if (!released) { released = true; clearTimeout(timer); append({ kind: "release", reason, state: state() }); releaseGate(); } return snapshot(); };
  const exactRoot = destination => destination?.tabId === tabId && Object.keys(destination).length === 1;
  function wrapper(...args) {
    const [destination, method, params = {}] = args;
    if (!exactRoot(destination)) return Reflect.apply(original, this, args);
    const capture = captures.get(params.objectId);
    const matches = !selected && method === "Runtime.callFunctionOn" && params.functionDeclaration === "function hitAt(x, y) { return this.hit(x, y); }" &&
      params.returnByValue === false && params.awaitPromise === false && params.userGesture === false && params.silent === true &&
      capture && capture.group === params.objectGroup && capture.contextId === contextId &&
      JSON.stringify(params.arguments) === JSON.stringify([{ value: point.x }, { value: point.y }]);
    const call = append({ kind: "call", target: destination, method, params, ...(matches ? { capture } : {}) });
    if (matches) {
      const owners = [...backend.pointerFeedbackReads.pending].filter(row => row.scope.tabId === tabId && row.scope.attachment === attachment &&
        row.scope.session_id === scope.session_id && row.scope.turn_id === scope.turn_id && row.scope.control_epoch === scope.control_epoch && row.state === "running");
      if (owners.length === 1) { selected = call; selectedRecord = owners[0]; append({ kind: "selected", call: call.sequence, state: state() }); }
    }
    let native;
    try { native = Reflect.apply(original, this, args); }
    catch (error) { append({ kind: "native-settled", call: call?.sequence, ok: false, synchronous: true, error: String(error) }); throw error; }
    nativePending++;
    nativeThen.call(native, value => {
      nativePending--; const ack = append({ kind: "native-settled", call: call?.sequence, ok: true, value });
      if (method === "Runtime.evaluate" && params.contextId === contextId && /^obu-native-pointer-/.test(params.objectGroup ?? "") &&
          typeof params.expression === "string" && params.expression.startsWith("(function captureDocument(") && !value?.exceptionDetails && value?.result?.objectId)
        captures.set(value.result.objectId, { group: params.objectGroup, contextId, invocation: call.sequence, ack: ack?.sequence, objectId: value.result.objectId });
    }, error => { nativePending--; append({ kind: "native-settled", call: call?.sequence, ok: false, error: String(error) }); });
    if (selected !== call) return native;
    selectedNative = native;
    delivered = nativeThen.call(native, value => {
      originalValue = value;
      if (value?.exceptionDetails || !value?.result?.objectId || value.result.subtype !== "node" || value.result.className !== "HTMLButtonElement") {
        append({ kind: "unqualified-reply", call: call.sequence, value }); return value;
      }
      deliveryPending++; append({ kind: "held", call: call.sequence, nativeAlreadyFulfilled: true, state: state() });
      if (!released) timer = setTimeout(() => { watchdog = true; release("watchdog"); }, holdTimeoutMs);
      return gate.then(() => value);
    });
    nativeThen.call(delivered, value => { if (deliveryPending) deliveryPending--; append({ kind: "delivery-settled", call: call.sequence, ok: true, value, sameOriginalValue: value === originalValue }); },
      error => { if (deliveryPending) deliveryPending--; append({ kind: "delivery-settled", call: call.sequence, ok: false, error: String(error) }); });
    return delivered;
  }
  function messageWrapper(...args) {
    const [destination, message, destinationOptions] = args;
    if (destination !== tabId || !/^OPEN_BROWSER_USE_(?:PING$|CURSOR|POINTER_EVENT|TARGET_RECT)/.test(message?.type ?? "")) return Reflect.apply(originalMessage, this, args);
    const row = append({ kind: "visual-call", tabId, message, options: destinationOptions ?? null }); let native;
    try { native = Reflect.apply(originalMessage, this, args); }
    catch (error) { append({ kind: "visual-settled", call: row?.sequence, ok: false, synchronous: true, error: String(error) }); throw error; }
    messagePending++;
    nativeThen.call(native, value => { messagePending--; append({ kind: "visual-settled", call: row?.sequence, ok: true, value }); },
      error => { messagePending--; append({ kind: "visual-settled", call: row?.sequence, ok: false, error: String(error) }); });
    return native;
  }
  const controller = { snapshot, release,
    checkpoint(label) { append({ kind: "checkpoint", label, state: state() }); return snapshot(); },
    restore() {
      release("restore");
      if (nativePending || messagePending || deliveryPending || selectedRecord && backend.pointerFeedbackReads.pending.has(selectedRecord)) throw Error("Original held-navigation resources remain pending");
      if (api.debugger.sendCommand !== wrapper || api.tabs.sendMessage !== messageWrapper || target.__obuColdHeldNavigation !== controller) throw Error("Held-navigation observer identity changed");
      api.debugger.sendCommand = original; api.tabs.sendMessage = originalMessage; clearTimeout(timer); restored = true;
      const result = snapshot(); delete target.__obuColdHeldNavigation; return result;
    }
  };
  api.debugger.sendCommand = wrapper; api.tabs.sendMessage = messageWrapper; target.__obuColdHeldNavigation = controller;
  append({ kind: "installed", state: state() }); return snapshot();
}

export function checkColdHeldNavigationEvidence(detail) {
  const evidence = detail.heldRead, p = evidence.final, records = p.records, common = detail.native.records;
  assert.equal(p.restored, true); assert.equal(p.released, true); assert.equal(p.watchdog, false); assert.equal(p.overflow, false); assert.equal(p.recordingErrors, 0);
  for (const name of ["nativePending", "messagePending", "deliveryPending"]) assert.equal(p[name], 0);
  assert.equal(p.nativeAndDeliveryDistinct, true); assert.ok(records.every((row, index) => row.sequence === index + 1));
  const one = kind => { const values = records.filter(row => row.kind === kind && row.call === p.selected); assert.equal(values.length, 1, `Original selected ${kind}`); return values[0]; };
  const call = records.find(row => row.sequence === p.selected), ack = one("native-settled"), held = one("held"), delivery = one("delivery-settled");
  assert.equal(call.method, "Runtime.callFunctionOn"); assert.deepEqual(call.target, { tabId: detail.tabId });
  assert.equal(call.params.functionDeclaration, hitDeclaration); assert.equal(call.params.returnByValue, false);
  assert.deepEqual(call.params.arguments, [{ value: coldNavigationHeldMove.x }, { value: coldNavigationHeldMove.y }]);
  assert.equal(call.params.objectId, call.capture.objectId); assert.equal(call.params.objectGroup, call.capture.group);
  assert.equal(call.capture.contextId, detail.phases[0].contexts.worlds[0].id); assert.equal(p.contextUniqueId, detail.phases[0].contexts.worlds[0].uniqueId);
  const captureCall = records.find(row => row.sequence === call.capture.invocation), captureACK = records.find(row => row.sequence === call.capture.ack);
  assert.equal(captureCall.method, "Runtime.evaluate"); assert.deepEqual(captureCall.target, call.target);
  assert.equal(captureCall.params.contextId, call.capture.contextId); assert.equal(captureCall.params.objectGroup, call.capture.group);
  assert.equal(captureACK.kind, "native-settled"); assert.equal(captureACK.call, captureCall.sequence); assert.equal(captureACK.ok, true);
  assert.equal(captureACK.value.exceptionDetails, undefined); assert.equal(captureACK.value.result.objectId, call.params.objectId); assert.ok(captureACK.sequence < call.sequence);
  assert.equal(ack.ok, true); assert.equal(ack.value.exceptionDetails, undefined); assert.equal(ack.value.result.subtype, "node"); assert.equal(ack.value.result.className, "HTMLButtonElement"); assert.ok(ack.value.result.objectId);
  assert.equal(held.nativeAlreadyFulfilled, true); assert.ok(ack.sequence < held.sequence); assert.equal(delivery.ok, true); assert.equal(delivery.sameOriginalValue, true); assert.deepEqual(delivery.value, ack.value);
  const releases = records.filter(row => row.kind === "release"); assert.equal(releases.length, 1); const release = releases[0];
  assert.equal(release.reason, "original-B-committed"); assert.ok(held.sequence < release.sequence && release.sequence < delivery.sequence);
  assert.equal(evidence.input.ok, true); assert.deepEqual(evidence.input.params, coldNavigationHeldMove);
  for (const snapshot of [evidence.held, evidence.bCommitted]) {
    assert.equal(snapshot.released, false); assert.equal(snapshot.deliveryPending, 1); assert.equal(snapshot.state.engineAbsent, true); assert.equal(snapshot.state.sameAttachment, true);
    assert.equal(snapshot.state.selectedRetained, true); assert.equal(snapshot.state.selectedState, "running"); assert.equal(snapshot.state.selectedSettled, false); assert.equal(snapshot.state.pointerPending, 1); assert.equal(snapshot.state.privateLeases, 0);
  }
  assert.equal(evidence.held.state.revision, p.initialRevision); assert.notEqual(evidence.bCommitted.state.revision, p.initialRevision);
  for (const snapshot of [evidence.drained, p]) { assert.equal(snapshot.state.selectedRetained, false); assert.equal(snapshot.state.selectedSettled, true); assert.equal(snapshot.state.selectedValue, null); }
  assert.equal(evidence.drained.state.sameAttachment, true); assert.equal(evidence.drained.state.pointerPending, 0); assert.equal(evidence.drained.nativePending, 0);
  const inputs = common.filter(row => row.kind === "call" && row.method.startsWith("Input.")), nav = common.filter(row => row.kind === "call" && row.method === "Page.navigate")[1];
  assert.equal(inputs.length, 10); assert.deepEqual(inputs[1].params, coldNavigationHeldMove);
  const commonACK = row => { const values = common.filter(ack => ack.kind === "settled" && ack.invocation === row.sequence); assert.equal(values.length, 1); assert.equal(values[0].ok, true); return values[0]; };
  assert.ok(commonACK(inputs[1]).sequence <= evidence.input.checkpointWorldSequence && evidence.input.checkpointWorldSequence < nav.sequence);
  const heldCall = common.filter(row => row.kind === "call" && row.method === call.method && row.params.objectId === call.params.objectId && row.params.functionDeclaration === hitDeclaration);
  assert.equal(heldCall.length, 1); assert.deepEqual(commonACK(heldCall[0]).value, ack.value); assert.ok(commonACK(heldCall[0]).sequence < nav.sequence);
  const commits = common.filter(row => row.kind === "event" && row.source.tabId === detail.tabId && !row.source.sessionId && row.method === "Page.frameNavigated" && row.params.frame.loaderId === detail.phases[1].tree.frameTree.frame.loaderId);
  assert.equal(commits.length, 1); assert.ok(commits[0].sequence <= release.worldSequence);
  const group = call.params.objectGroup, groupRelease = common.filter(row => row.kind === "call" && row.method === "Runtime.releaseObjectGroup" && row.params.objectGroup === group);
  assert.equal(groupRelease.length, 1); assert.ok(groupRelease[0].sequence > delivery.worldSequence); assert.ok(commonACK(groupRelease[0]).sequence < inputs[2].sequence);
  const oldObjects = new Set([call.params.objectId, ack.value.result.objectId]);
  for (const row of common.filter(row => row.kind === "call" && row.params?.objectGroup === group && ["Runtime.evaluate", "Runtime.callFunctionOn"].includes(row.method))) {
    const value = commonACK(row).value;
    for (const remote of [value?.result, value?.exceptionDetails?.exception]) if (remote?.objectId) oldObjects.add(remote.objectId);
  }
  assert.ok(!common.some(row => row.kind === "call" && row.sequence > heldCall[0].sequence &&
    !["Runtime.releaseObjectGroup", "Runtime.releaseObject"].includes(row.method) &&
    (row.params?.objectGroup === group || oldObjects.has(row.params?.objectId) || row.params?.arguments?.some(arg => oldObjects.has(arg.objectId)))),
  "Retired A candidate cannot continue old object reads, including DOM calls without objectGroup");
  const oldMoves = records.filter(row => row.kind === "visual-call" && row.message.type === "OPEN_BROWSER_USE_CURSOR" && row.message.x === p.point.x && row.message.y === p.point.y);
  for (const row of oldMoves) assert.equal(row.options.documentId, p.documentId);
  const oldSequences = new Set(oldMoves.map(row => row.message.feedbackSequence));
  for (const row of records.filter(row => row.kind === "visual-call" && row.sequence > release.sequence)) {
    if (row.message.type === "OPEN_BROWSER_USE_TARGET_RECT" && oldSequences.has(row.message.feedbackSequence)) assert.fail("Retired A target patch was published after release");
    if (["OPEN_BROWSER_USE_CURSOR", "OPEN_BROWSER_USE_POINTER_EVENT", "OPEN_BROWSER_USE_TARGET_RECT"].includes(row.message.type) && row.options?.documentId === detail.phases[1].before.nativeDocumentId) {
      assert.ok(!oldSequences.has(row.message.feedbackSequence));
      if (row.message.targetRect) assert.notDeepEqual(row.message.targetRect, detail.phases[0].after.geometry.button);
    }
  }
  return { selectedCall: call.sequence, nativeACK: ack.sequence, held: held.sequence, release: release.sequence, delivered: delivery.sequence,
    originalGroup: group, releaseInvocation: groupRelease[0].sequence, releaseACK: commonACK(groupRelease[0]).sequence, bMove: inputs[2].sequence,
    classification: "Successful native reply with controlled delayed delivery; old candidate revoked, actual group released, one subsequent B read" };
}

export async function checkColdHeldNavigation(args) {
  const { getWorker, until } = args;
  let installed = false;
  const control = (method, values = []) => getWorker().evaluate(`(()=>{const p=globalThis.__obuColdHeldNavigation;if(!p)throw Error('Held navigation observer missing');return p[${json(method)}](...${json(values)})})()`);
  const drain = () => until(async () => { const p = await control("snapshot"); return p.nativePending === 0 && p.deliveryPending === 0 && (p.selected === null || p.state.selectedSettled === true) && !p.state.selectedRetained && p.state.pointerPending === 0; }, "original held hit and group cleanup", 5000);
  return checkColdNavigation({ ...args, heldReadNavigation: {
    kind: "late-hit-navigation",
    async afterADrain({ browser, tab, detail }) {
      const a = detail.phases[0], options = { tabId: tab.id, documentId: a.before.nativeDocumentId, frameId: a.tree.frameTree.frame.id,
        contextId: a.contexts.worlds[0].id, contextUniqueId: a.contexts.worlds[0].uniqueId, scope: scopeOf(browser), point: { x: coldNavigationHeldMove.x, y: coldNavigationHeldMove.y } };
      const evidence = detail.heldRead = { options };
      installed = true; evidence.initial = await getWorker().evaluate(`(${installColdHeldNavigationProbe.toString()})(chrome,globalThis,${json(options)})`);
      try { const value = await browser.cdp.call(tab.id, "Input.dispatchMouseEvent", coldNavigationHeldMove); evidence.input = { ok: true, value, params: coldNavigationHeldMove }; }
      catch (error) { evidence.input = { ok: false, error: errorText(error), params: coldNavigationHeldMove }; throw error; }
      const input = await control("checkpoint", ["original-A-input-returned"]); evidence.input.checkpointWorldSequence = input.records.at(-1).worldSequence;
      await until(async () => { const p = await control("snapshot"); if (p.deliveryPending !== 1 || p.released) return false; evidence.held = p; return true; }, "original A hit ACK deliberately held", 5000);
    },
    async beforeBMove({ detail }) {
      detail.heldRead.bCommitted = await control("checkpoint", ["original-B-committed-before-release"]);
      detail.heldRead.released = await control("release", ["original-B-committed"]);
      await drain(); detail.heldRead.drained = await control("checkpoint", ["old-A-candidate-and-group-settled"]);
    },
    async releaseFinally({ detail }) {
      if (!installed) return;
      detail.heldRead.finallyRelease = await control("release", ["finally"]);
      await drain();
    },
    async restore({ detail }) {
      if (!installed) return;
      await until(async () => { const p = await control("snapshot"); return p.nativePending === 0 && p.messagePending === 0 && p.deliveryPending === 0; }, "original held observer calls settle", 5000);
      detail.heldRead.final = await control("restore"); installed = false;
    },
    check: checkColdHeldNavigationEvidence
  } });
}

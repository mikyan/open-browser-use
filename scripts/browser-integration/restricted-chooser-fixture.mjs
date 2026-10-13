import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { chooserVariants, chooserPageURL, chooserScope, checkChooserReceipts } from "./chooser-waits-fixture.mjs";
import { checkResponseBodyOOPIF } from "./response-body-fixture.mjs";
import { restrictedDialogPolicyControls } from "./site-access-dialog-fixture.mjs";

const text = error => error?.stack ?? String(error), json = value => JSON.stringify(value).replace(/</g, "\\u003c");
const sameTarget = (left, right) => left.tabId === right.tabId && left.sessionId === right.sessionId;
export const restrictedChooserLayouts = chooserVariants;

// The passive path returns the exact original promise. The explicit late-ACK
// boundary holds delivery only after one real native write has fulfilled.
export function installRestrictedChooserEvidence(api, target, tabId) {
  if (target.__restrictedChooserEvidence) throw Error("Chooser evidence already installed");
  const original = api.debugger.sendCommand, rows = []; let pending = 0, overflow = false, holdNext = false, held;
  const append = value => { if (rows.length >= 512) { overflow = true; return { sequence: -1 }; } const row = { sequence: rows.length + 1, at: Date.now(), ...value }; rows.push(row); return row; };
  const events = new Set(["Page.fileChooserOpened", "Page.frameNavigated", "Page.frameDetached", "Target.attachedToTarget", "Target.detachedFromTarget"]);
  const listener = (source, method, params) => { if (source.tabId === tabId && events.has(method)) append({ kind: "event", source: { ...source }, method, params: structuredClone(params) }); };
  function wrapper(...args) {
    const [source, method, params] = args;
    if (source.tabId !== tabId || !["Page.setInterceptFileChooserDialog", "DOM.resolveNode", "DOM.setFileInputFiles", "Runtime.callFunctionOn", "Runtime.releaseObject"].includes(method)) return Reflect.apply(original, this, args);
    const row = append({ kind: "native", source: { ...source }, method, params: structuredClone(params ?? {}) }); let result;
    try { result = Reflect.apply(original, this, args); } catch (error) { append({ kind: "rejected", call: row.sequence, error: String(error) }); throw error; }
    const selected = holdNext && method === "DOM.setFileInputFiles"; if (selected) holdNext = false;
    pending++; result.then(value => append({ kind: "ack", call: row.sequence, result: structuredClone(value) }), error => append({ kind: "rejected", call: row.sequence, error: String(error) })).catch(() => {});
    const delivery = selected ? result.then(value => new Promise(resolve => { append({ kind: "deliveryHeld", call: row.sequence }); held = { call: row.sequence, value, resolve }; })) : result;
    delivery.then(() => { pending--; }, () => { pending--; }); return delivery;
  }
  api.debugger.sendCommand = wrapper; api.debugger.onEvent.addListener(listener);
  target.__restrictedChooserEvidence = { snapshot: () => structuredClone({ rows, pending, overflow, held: !!held }), holdNextWrite() { if (holdNext || held) throw Error("Chooser write already selected"); holdNext = true; }, release() { if (held) { const current = held; held = undefined; append({ kind: "deliveryReleased", call: current.call }); current.resolve(current.value); } }, stop() {
    if (pending) throw Error("Original chooser native operations still pending"); if (api.debugger.sendCommand !== wrapper) throw Error("Original chooser native wrapper changed");
    api.debugger.sendCommand = original; api.debugger.onEvent.removeListener(listener); delete target.__restrictedChooserEvidence;
    return { rows, pending, overflow, restored: api.debugger.sendCommand === original && !api.debugger.onEvent.hasListener(listener), removed: !target.__restrictedChooserEvidence };
  } };
}

export function readRestrictedChooserDocument() {
  const input = document.querySelector("#upload"), evidence = globalThis.chooserEvidence;
  return { href: location.href, evidence: evidence ? structuredClone(evidence) : null,
    input: input ? { id: input.id, type: input.type, connected: input.isConnected, files: [...input.files].map(file => ({ name: file.name, size: file.size })), value: input.value } : null,
    receipt: document.querySelector("#receipt")?.textContent ?? null };
}
async function snapshot(worker, tabId) {
  return worker.evaluate(`(async()=>{const observer=globalThis.__integrationFrameObserver.snapshot();return{observer,frames:await chrome.webNavigation.getAllFrames({tabId:${tabId}}),documents:await chrome.scripting.executeScript({target:{tabId:${tabId},allFrames:true},world:'MAIN',func:${readRestrictedChooserDocument.toString()}}),targets:await chrome.debugger.getTargets(),oopifs:globalThis.__integrationFrames.filter(row=>row.tabId===${tabId})}})()`);
}

async function workflow(operations, config, detail) {
  Object.assign(detail, { tabId: config.tabId, scope: structuredClone(config.scope), waits: [], receipts: [] }); let failure;
  for (const sequence of [1, 2]) {
    const round = { sequence }; detail.waits.push(round); let handle;
    try {
      round.armStartedAt = Date.now(); handle = await operations.arm(); Object.assign(round, handle.ack, { readyAt: Date.now() });
      if (sequence === 1 && config.layout === "dynamic-oopif") await operations.add();
      round.triggerSubmittedAt = Date.now(); await operations.click(); round.triggerCompletedAt = Date.now();
      round.result = await handle.result(); round.collectedAt = Date.now(); assert.equal(round.result.isMultiple, config.layout !== "root");
      round.files = sequence === 1 ? [...config.paths] : []; round.setStartedAt = Date.now(); round.setResult = await operations.set(round.result.fileChooserId, round.files); round.setCompletedAt = Date.now();
      const deadline = Date.now() + 5000;
      for (let attempt = 0; ; attempt++) { const raw = await operations.receipt(); const receipt = raw ? JSON.parse(raw) : null;
        if (receipt?.sequence === sequence) { round.receipt = receipt; detail.receipts.push(receipt); break; }
        if (Date.now() >= deadline || attempt >= 100) throw Error("Original chooser receipt did not arrive"); await new Promise(resolve => setTimeout(resolve, 25)); }
    } catch (error) { failure = error; round.error = text(error); }
    finally { if (handle) try { round.cancelResult = await handle.cancel(); round.cancelled = true; } catch (error) { round.cancelError = text(error); failure ??= error; } }
    if (failure) break;
  }
  if (failure) { detail.error = text(failure); throw failure; } return detail;
}

export function runRestrictedChooserWireCaller(call, config, detail = {}) {
  const invoke = (method, params) => call(method, { ...config.scope, ...params });
  const locator = [...(config.layout === "root" ? [] : [{ kind: "frame", selector: "#upload-frame" }]), { kind: "label", value: "Upload fixture", exact: true }];
  const action = (action, steps = locator) => invoke("browserAction", { tabId: config.tabId, action, locator: steps, args: {}, timeoutMs: 5000 });
  return workflow({ arm: async () => { const ack = await invoke("armFileChooserWait", { tabId: config.tabId, timeoutMs: 10000 }); return { ack,
    result: () => invoke("collectFileChooserWait", { tabId: config.tabId, waiterId: ack.waiterId }), cancel: () => invoke("cancelFileChooserWait", { tabId: config.tabId, waiterId: ack.waiterId }) }; },
    add: () => action("click", [{ kind: "role", role: "button", name: "Add upload frame", exact: true }]), click: () => action("click"),
    set: (fileChooserId, files) => invoke("setFileChooserFiles", { fileChooserId, files }),
    receipt: async () => (await action("textContent", [...locator.slice(0, -1), { kind: "css", selector: "#receipt" }])).value }, config, detail);
}
function typedCaller(tab, config, detail) {
  const target = config.layout === "root" ? tab : tab.frameLocator("#upload-frame");
  return workflow({ arm: async () => { const wait = await tab.expectFileChooser({ timeoutMs: 10000 }); return { ack: { waiterId: wait.waiterId, remainingMs: wait.remainingMs }, result: () => wait.result(), cancel: () => wait.cancel() }; },
    add: () => tab.getByRole("button", { name: "Add upload frame", exact: true }).click(), click: () => target.getByLabel("Upload fixture", { exact: true }).click({ timeoutMs: 5000 }),
    set: (id, files) => tab.browser.client.setFileChooserFiles(id, files), receipt: () => target.locator("#receipt").textContent() }, config, detail);
}

export function checkRestrictedChooserEvidence(item, record, files) {
  checkChooserReceipts(record, files, item.layout); const result = item.callerResult, native = item.nativeEvidence;
  for (const post of record.posts) { const raw = JSON.parse(Buffer.from(post.bodyBase64, "base64")); for (const field of ["documentToken", "clicks", "changes", "href", "sequence", "variant"]) assert.deepEqual(raw[field], post[field]); assert.equal(raw.key, item.key); assert.deepEqual(post.receipt, { key: item.key, variant: item.layout, sequence: post.sequence, documentToken: post.documentToken, files: post.files }); }
  assert.deepEqual(result.scope, item.scope); assert.equal(result.tabId, item.tabId); assert.equal(result.waits.length, 2); assert.deepEqual(result.receipts, record.posts.map(post => post.receipt));
  assert.notEqual(result.waits[0].waiterId, result.waits[1].waiterId); assert.notEqual(result.waits[0].result.fileChooserId, result.waits[1].result.fileChooserId);
  for (const [index, round] of result.waits.entries()) { assert.equal(round.sequence, index + 1); assert.ok(round.waiterId && round.remainingMs > 0 && round.remainingMs <= 10000); assert.equal(round.cancelled, true); assert.equal(round.error, undefined); assert.equal(round.cancelError, undefined); assert.equal(round.result.isMultiple, item.layout !== "root"); assert.ok(round.triggerSubmittedAt >= round.readyAt && round.collectedAt >= round.triggerSubmittedAt); assert.deepEqual(round.files, index === 0 ? item.paths : []); assert.ok(Object.hasOwn(round, "setResult")); }
  const href = record.posts[0].href, documents = item.after.documents.filter(row => row.result.href === href); assert.equal(documents.length, 1); const original = documents[0], state = original.result;
  assert.equal(state.evidence.documentToken, record.posts[0].documentToken); assert.deepEqual(state.evidence.clicks, record.posts[1].clicks); assert.deepEqual(state.evidence.changes, record.posts[1].changes);
  assert.deepEqual(state.input, { id: "upload", type: "file", connected: true, files: [], value: "" }); assert.deepEqual(JSON.parse(state.receipt), record.posts[1].receipt);
  const before = item.before.documents.find(row => row.result.href === href); if (item.layout !== "dynamic-oopif") { assert.ok(before?.documentId); assert.equal(before.documentId, original.documentId); assert.equal(before.result.evidence.documentToken, state.evidence.documentToken); }
  const rootBefore = item.before.documents.find(row => row.frameId === 0), rootAfter = item.after.documents.find(row => row.frameId === 0); assert.equal(rootAfter.documentId, rootBefore.documentId); assert.equal(rootAfter.result.evidence.documentToken, rootBefore.result.evidence.documentToken);
  assert.deepEqual(rootAfter.result.evidence.frameAdds, item.layout === "dynamic-oopif" ? [{ trusted: true }] : []);
  assert.equal(native.overflow, false); assert.equal(native.pending, 0); assert.equal(native.restored, true); assert.equal(native.removed, true);
  const opened = native.rows.filter(row => row.kind === "event" && row.method === "Page.fileChooserOpened"); assert.equal(opened.length, 2);
  assert.equal(opened[0].params.backendNodeId, opened[1].params.backendNodeId); assert.equal(opened[0].params.frameId, opened[1].params.frameId); assert.ok(Number.isInteger(opened[0].params.backendNodeId)); assert.ok(sameTarget(opened[0].source, opened[1].source));
  const writes = native.rows.filter(row => row.kind === "native" && row.method === "DOM.setFileInputFiles"); assert.equal(writes.length, 1); const write = writes[0]; assert.equal(write.params.backendNodeId, opened[0].params.backendNodeId); assert.ok(sameTarget(write.source, opened[0].source)); assert.deepEqual(write.params.files, item.paths);
  const clears = native.rows.filter(row => row.kind === "native" && row.method === "Runtime.callFunctionOn" && row.params.functionDeclaration?.includes('this.value = ""')); assert.equal(clears.length, 1); const clear = clears[0]; assert.ok(sameTarget(clear.source, opened[1].source));
  const resolved = native.rows.filter(row => row.kind === "native" && row.method === "DOM.resolveNode" && row.sequence > opened[1].sequence && row.sequence < clear.sequence && row.params.backendNodeId === opened[1].params.backendNodeId && sameTarget(row.source, clear.source));
  assert.ok(resolved.some(row => native.rows.some(ack => ack.kind === "ack" && ack.call === row.sequence && ack.result.object?.objectId === clear.params.objectId)), "Clear uses the exact original chooser node");
  for (const call of [write, clear]) { const acks = native.rows.filter(row => row.kind === "ack" && row.call === call.sequence); assert.equal(acks.length, 1); assert.equal(native.rows.filter(row => row.kind === "rejected" && row.call === call.sequence).length, 0); if (call === clear) { assert.equal(acks[0].result.exceptionDetails, undefined); assert.equal(acks[0].result.result?.value, 0); } }
  assert.ok(opened[0].sequence < write.sequence && write.sequence < opened[1].sequence && opened[1].sequence < clear.sequence);
  if (item.layout !== "root") { item.oopifProof = checkResponseBodyOOPIF({ ...item.after, tab: { id: item.tabId } }, { tabId: item.tabId, rootURL: rootAfter.result.href, childURL: href }); assert.equal(opened[0].source.sessionId, item.oopifProof.sessionId); assert.equal(opened[0].params.frameId, item.oopifProof.targetId); }
  else { assert.equal(opened[0].source.sessionId, undefined); const target = item.after.targets.find(row => row.tabId === item.tabId && row.type === "page"); assert.ok(target); assert.equal(opened[0].params.frameId, target.id); }
  return { posts: 2, bytes: record.posts.reduce((sum, post) => sum + post.bodyBytes, 0), fileBytes: record.posts[0].files.reduce((sum, file) => sum + file.size, 0), documentId: original.documentId, backendNodeId: opened[0].params.backendNodeId, chooserEvents: 2, nativeWrites: 1, nativeClears: 1 };
}

export async function checkRestrictedChooserCaller({ kind, browser, fixtureURL, fixtures, files, getWorker, until, caller, detail = {} }) {
  Object.assign(detail, { caller: kind, variants: [], boundary: "Each upload and clear uses its own original chooser event and one click/POST. The upload change is trusted; existing explicit clear change is programmatic. Private file hashes and native evidence never select files for a caller." }); let failure;
  for (const layout of chooserVariants) {
    const key = `restricted-chooser-${kind}-${layout}`, tab = await browser.newTab(), item = { key, layout, tabId: tab.id, scope: chooserScope(browser), paths: (layout === "root" ? files.slice(0, 1) : files).map(file => file.path), callerResult: {} }; detail.variants.push(item); let installed = false;
    try {
      await getWorker().evaluate(`(${installRestrictedChooserEvidence.toString()})(chrome,globalThis,${tab.id})`); installed = true; await tab.goto(chooserPageURL(fixtureURL, key, layout));
      await until(async () => { const value = await snapshot(getWorker(), tab.id); return value.documents.length === (layout === "oopif" ? 2 : 1) && value.documents.every(row => row.result?.evidence?.documentToken) ? (item.before = value) : false; }, "original restricted chooser documents");
      const config = { key, layout, tabId: tab.id, scope: { ...item.scope }, paths: [...item.paths] };
      item.callerResult = caller ? await caller(config, item) : await typedCaller(tab, config, item.callerResult);
    } catch (error) { failure = error; item.error = text(error); }
    finally {
      if (installed) try { await until(() => getWorker().evaluate("globalThis.__restrictedChooserEvidence.snapshot().pending===0"), "original chooser native operations settle"); item.nativeEvidence = await getWorker().evaluate("globalThis.__restrictedChooserEvidence.stop()"); } catch (error) { item.nativeEvidenceError = text(error); failure ??= error; }
      try { item.after = await snapshot(getWorker(), tab.id); } catch (error) { item.afterError = text(error); failure ??= error; }
      try { item.server = fixtures.stats(key); } catch (error) { item.serverError = text(error); failure ??= error; }
    }
    if (!failure) try { item.proof = checkRestrictedChooserEvidence(item, item.server, files); item.passed = true; } catch (error) { failure = error; item.error = text(error); }
    if (failure) break;
  }
  detail.serverLedger = fixtures.allStats(); if (failure) { detail.error = text(failure); throw failure; } return detail;
}

export async function checkRestrictedChooserPolicy({ popup, fixtureURL, until, runAllowed, runBoundaries, saveDetail }) {
  assert.ok(popup, "Restricted chooser policy borrows the existing popup"); const controls = restrictedDialogPolicyControls({ popup, until }), detail = { popupOwnership: "borrowed" }; let failure;
  try { detail.originalPolicy = await controls.read(); detail.origins = [new URL(fixtureURL).origin, new URL(fixtureURL).origin.replace("127.0.0.1", "localhost")].sort();
    detail.allowed = await controls.apply("allow", detail.origins); detail.allowed.resume = await controls.resume(); if (runAllowed) await runAllowed(detail.allowed.policy); if (runBoundaries) await runBoundaries(controls, detail.allowed.policy);
  } catch (error) { failure = error; }
  finally { if (detail.originalPolicy) try { detail.restored = await controls.apply(detail.originalPolicy.mode, detail.originalPolicy.origins); detail.restored.resume = await controls.resume(); } catch (error) { detail.restoreError = text(error); failure ??= error; }
    if (failure) detail.error = text(failure); try { await saveDetail(detail); } catch (error) { failure ??= error; } }
  if (failure) throw failure; return detail;
}

const sourceDenied = /OBU_SITE_ACCESS_(?:DENIED|UNVERIFIED)/;
const controlDenied = /OBU_STALE_CONTROL_EPOCH|OBU_CONTROL_BOOTSTRAP_REQUIRED|OBU_AUTOMATION_PAUSED/;
const chooserRetired = /OBU_FILE_CHOOSER_WAIT_(?:EXPIRED|CANCELLED)|Unknown or unowned file chooser id|File chooser became stale|OBU_DIRECTORY_UPLOAD_(?:EXPIRED|CANCELLED)|OBU_TRANSFER_CANCELLED|OBU_SITE_ACCESS_(?:DENIED|UNVERIFIED)/;
const outcome = promise => promise.then(value => ({ ok: true, value }), error => ({ ok: false, error: String(error?.message ?? error) }));

export function checkRestrictedChooserBoundaryEvidence(item, files) {
  const native = item.nativeEvidence, before = item.before.documents.find(row => row.frameId === 0), after = item.after.documents.find(row => row.frameId === 0);
  assert.equal(native.overflow, false); assert.equal(native.pending, 0); assert.equal(native.restored, true); assert.equal(native.removed, true);
  assert.ok(before.documentId && after.documentId); assert.ok(before.result.evidence.documentToken); assert.equal(after.result.href, before.result.href);
  const replaced = item.name === "same-url-new-document", late = item.name === "late-native-policy", openedExpected = ["same-url-new-document", "policy-revocation", "late-native-policy"].includes(item.name) ? 1 : 0;
  if (replaced) { assert.notEqual(before.documentId, after.documentId); assert.notEqual(before.result.evidence.documentToken, after.result.evidence.documentToken); }
  else { assert.equal(before.documentId, after.documentId); assert.equal(before.result.evidence.documentToken, after.result.evidence.documentToken); }
  assert.deepEqual(before.result.evidence.clicks, []); assert.deepEqual(before.result.evidence.changes, []);
  assert.deepEqual(after.result.evidence.clicks, openedExpected && !replaced ? [{ trusted: true }] : []);
  assert.deepEqual(after.result.evidence.changes, late ? [{ trusted: true, count: 1 }] : []);
  assert.deepEqual(after.result.evidence.frameAdds, item.name === "future-denied-child" ? [{ trusted: true }] : []);
  const openings = native.rows.filter(row => row.kind === "event" && row.method === "Page.fileChooserOpened"), writes = native.rows.filter(row => row.kind === "native" && (row.method === "DOM.setFileInputFiles" || row.method === "Runtime.callFunctionOn" && row.params.functionDeclaration?.includes('this.value = ""')));
  assert.equal(openings.length, openedExpected); assert.equal(writes.length, late ? 1 : 0);
  if (openedExpected) { const opening = openings[0], root = item.before.targets.find(row => row.tabId === item.tabId && row.type === "page"); assert.ok(root); assert.equal(opening.source.tabId, item.tabId); assert.equal(opening.source.sessionId, undefined); assert.equal(opening.params.frameId, root.id); assert.ok(Number.isSafeInteger(opening.params.backendNodeId) && opening.params.backendNodeId > 0); assert.ok(item.chosen.fileChooserId); assert.equal(item.chosen.isMultiple, false); }
  if (replaced) { const original = item.beforeNavigation.documents.find(row => row.frameId === 0); assert.equal(original.documentId, before.documentId); assert.equal(original.result.evidence.documentToken, before.result.evidence.documentToken); assert.deepEqual(original.result.evidence.clicks, [{ trusted: true }]); assert.deepEqual(original.result.evidence.changes, []); }
  if (item.name === "explicit-cancel") { const toggles = native.rows.filter(row => row.kind === "native" && row.method === "Page.setInterceptFileChooserDialog" && row.source.tabId === item.tabId && row.source.sessionId === undefined); assert.deepEqual(toggles.map(row => row.params.enabled), [true, false]); for (const call of toggles) assert.equal(native.rows.filter(row => row.kind === "ack" && row.call === call.sequence).length, 1); assert.ok(toggles[0].sequence < toggles[1].sequence); }
  for (const rejection of item.rejections) { assert.equal(rejection.ok, false); assert.equal(Object.hasOwn(rejection, "value"), false); const pattern = rejection.authority === "control" ? controlDenied : rejection.authority === "source" ? sourceDenied : rejection.authority === "timeout" ? /OBU_DIRECTORY_UPLOAD_TIMEOUT|request timed out|Request timeout/i : chooserRetired; assert.match(rejection.error, pattern); }
  const expectedRejections = { "explicit-cancel": [], "same-url-new-document": ["old-document-setter"], "late-native-policy": ["original-setter-timeout", "old-policy-setter"], "policy-revocation": ["old-policy-setter", "old-policy-cancel"], "mixed-denied-child": ["mixed-tree-arm"], "future-denied-child": ["future-tree-collect"] };
  assert.deepEqual(item.rejections.map(row => row.name), expectedRejections[item.name]);
  if (["explicit-cancel", "same-url-new-document", "future-denied-child"].includes(item.name)) assert.equal(item.cancelled, true);
  if (item.name === "future-denied-child" || item.name === "mixed-denied-child") {
    const child = item.after.documents.filter(row => row.frameId !== 0); assert.equal(child.length, 1); assert.equal(new URL(child[0].result.href).hostname, "localhost"); assert.ok(child[0].documentId); assert.deepEqual(child[0].result.evidence.clicks, []); assert.deepEqual(child[0].result.evidence.changes, []);
    assert.ok(item.after.frames.some(frame => frame.frameId === child[0].frameId && frame.documentId === child[0].documentId && frame.parentDocumentId === after.documentId));
    if (item.addError) assert.match(item.addError, sourceDenied);
  }
  if (item.name === "policy-revocation" || late) { assert.ok(Number.isSafeInteger(item.newScope.control_epoch) && item.newScope.control_epoch > item.scope.control_epoch); assert.equal(item.newScope.session_id, item.scope.session_id); assert.equal(typeof item.newScope.turn_id, "string"); assert.ok(item.newScope.turn_id); assert.notEqual(item.newScope.turn_id, item.scope.turn_id); assert.equal(item.policyChanged.control.state, "paused"); assert.equal(item.policyChanged.control.cleanupComplete, true); }
  if (!late) { assert.deepEqual(item.server.posts, []); assert.deepEqual(after.result.input?.files ?? [], []); }
  else {
    assert.equal(item.server.posts.length, 1); const post = item.server.posts[0], original = JSON.parse(Buffer.from(post.bodyBase64, "base64")); const write = writes[0], opening = openings[0];
    assert.equal(post.method, "POST"); assert.equal(post.sequence, 1); assert.equal(post.variant, "root"); assert.equal(post.error, undefined); assert.equal(post.href, before.result.href); assert.equal(post.documentToken, before.result.evidence.documentToken);
    const bytes = Buffer.from(post.bodyBase64, "base64"); assert.equal(bytes.length, post.bodyBytes); assert.equal(createHash("sha256").update(bytes).digest("hex"), post.bodySHA256);
    const expected = files.slice(0, 1).map(({ name, size, sha256 }) => ({ name, size, sha256 })); assert.deepEqual(post.files, expected); assert.deepEqual(original.files.map(file => ({ name: file.name, size: Buffer.from(file.base64, "base64").length, sha256: createHash("sha256").update(Buffer.from(file.base64, "base64")).digest("hex") })), expected);
    assert.deepEqual(original.clicks, [{ trusted: true }]); assert.deepEqual(original.changes, [{ trusted: true, count: 1 }]); assert.equal(original.documentToken, post.documentToken); assert.equal(original.key, item.key); assert.deepEqual(JSON.parse(after.result.receipt), post.receipt);
    assert.deepEqual(write.params.files, [files[0].path]); assert.equal(write.params.backendNodeId, opening.params.backendNodeId); assert.ok(sameTarget(write.source, opening.source));
    const acks = native.rows.filter(row => row.kind === "ack" && row.call === write.sequence), held = native.rows.filter(row => row.kind === "deliveryHeld" && row.call === write.sequence), releases = native.rows.filter(row => row.kind === "deliveryReleased" && row.call === write.sequence);
    assert.equal(acks.length, 1); assert.equal(held.length, 1); assert.equal(releases.length, 1); assert.ok(write.sequence < acks[0].sequence && acks[0].sequence < held[0].sequence && held[0].sequence < releases[0].sequence);
    assert.equal(item.held.held, true); assert.equal(item.held.pending, 1); assert.equal(item.blocked.state, "error"); assert.equal(item.blocked.inputBlocked, true); assert.equal(item.blocked.cleanupComplete, false); assert.equal(item.cleanupTimeoutMs, 10000);
    // controls.apply observes popup UI; its wait timeout is not a backend reply.
    // The original control state, still held write and unchanged durable policy
    // independently establish the real production cleanup deadline failure.
    assert.match(item.blocked.error, /^OBU_AUTOMATION_PAUSE_FAILED:.*OBU_AUTOMATION_CLEANUP_TIMEOUT:/s);
    assert.equal(item.failedApply.ok, false); assert.ok(item.failedApply.error === "Timed out waiting for restricted dialog policy saved" || /^OBU_(?:SITE_ACCESS_UNAVAILABLE|AUTOMATION_PAUSE_FAILED):/.test(item.failedApply.error)); assert.ok(item.pauseFailedAt - item.applyStartedAt >= item.cleanupTimeoutMs);
    assert.equal(item.heldAfterFailed.held, true); assert.equal(item.heldAfterFailed.pending, 1); assert.equal(item.heldAfterFailed.rows.some(row => row.kind === "deliveryReleased"), false);
    assert.deepEqual(item.policyAfterFailed, item.policyBeforeHold); assert.deepEqual(item.durableAfterFailed, item.durableBeforeHold); assert.equal(item.operationsAfterRelease, 0); assert.ok(item.expiredAt - item.setStartedAt >= 900);
    assert.deepEqual(item.policyChanged.policy, { ...item.policyBeforeHold, revision: item.policyBeforeHold.revision + 1 });
  }
  return { posts: item.server.posts.length, bytes: item.server.posts.reduce((sum, post) => sum + post.bodyBytes, 0), nativeChooserEvents: openings.length, nativeFileWrites: writes.length };
}

export async function checkRestrictedChooserBoundaries({ connectBrowser, getWorker, fixtureURL, fixtures, files, controls, until, saveDetail }) {
  const browser = await connectBrowser("js-restricted-chooser-boundaries"), detail = { tabIds: [], cases: [], executionOrder: [], boundary: "Original native nodes are never replaced or retried. The one late setter holds ACK delivery after the actual native write; its one POST can complete before the caller times out. Clear's programmatic change is not described as trusted." }; let failure;
  const create = async (name, layout = "root") => {
    const key = `restricted-chooser-boundary-${name}`, tab = await browser.newTab(), item = { name, key, layout, tabId: tab.id, url: chooserPageURL(fixtureURL, key, layout), rejections: [] }; detail.cases.push(item); detail.tabIds.push(tab.id); return { item, tab };
  };
  const ready = async ({ item, tab }) => { await tab.goto(item.url); await until(async () => { const value = await snapshot(getWorker(), tab.id); return value.documents.length === (item.layout === "oopif" ? 2 : 1) && value.documents.every(row => row.result?.evidence?.documentToken) ? (item.before = value) : false; }, "original chooser boundary documents"); };
  const run = async (context, action) => {
    const { item, tab } = context; let first, installed = false; const pending = []; detail.executionOrder.push(item.name);
    const reject = async (name, promise, authority) => { const value = { name, authority, ...await outcome(promise) }; item.rejections.push(value); assert.equal(value.ok, false, `${name} unexpectedly succeeded`); return value; };
    const arm = async () => { const wait = await tab.expectFileChooser({ timeoutMs: 10000 }); item.wait = { waiterId: wait.waiterId, remainingMs: wait.remainingMs }; return wait; };
    const open = async () => { const wait = await arm(); await tab.getByLabel("Upload fixture", { exact: true }).click({ timeoutMs: 5000 }); item.chosen = await wait.result(); return wait; };
    const setOriginal = () => browser.client.request("setFileChooserFiles", { ...item.scope, fileChooserId: item.chosen.fileChooserId, files: [files[0].path] });
    try { item.scope = chooserScope(browser); await getWorker().evaluate(`(${installRestrictedChooserEvidence.toString()})(chrome,globalThis,${tab.id})`); installed = true; if (!item.before) await ready(context); await action({ item, tab, arm, open, reject, setOriginal, pending }); }
    catch (error) { first = error; item.error = text(error); }
    finally {
      if (installed) try { await getWorker().evaluate("globalThis.__restrictedChooserEvidence.release()"); await Promise.all(pending); await until(() => getWorker().evaluate("globalThis.__restrictedChooserEvidence.snapshot().pending===0"), "original boundary chooser operations settle"); item.nativeEvidence = await getWorker().evaluate("globalThis.__restrictedChooserEvidence.stop()"); } catch (error) { item.nativeEvidenceError = text(error); first ??= error; }
      try { item.after = await snapshot(getWorker(), tab.id); } catch (error) { item.afterError = text(error); first ??= error; }
      try { item.server = fixtures.stats(item.key); } catch (error) { item.serverLedgerError = text(error); first ??= error; }
    }
    if (!first) try { item.proof = checkRestrictedChooserBoundaryEvidence(item, files); item.passed = true; } catch (error) { first = error; item.error = text(error); }
    if (first) throw first;
  };
  try {
    await run(await create("explicit-cancel"), async ({ item, arm }) => { const wait = await arm(); item.cancelResult = await wait.cancel(); item.cancelled = true; });
    await run(await create("same-url-new-document"), async ({ item, tab, open, reject, setOriginal }) => { const wait = await open(); item.beforeNavigation = await snapshot(getWorker(), tab.id); await tab.goto(item.url); await reject("old-document-setter", setOriginal(), "chooser"); item.cancelResult = await wait.cancel(); item.cancelled = true; });
    await run(await create("late-native-policy"), async ({ item, tab, open, reject, setOriginal, pending }) => {
      await open(); await getWorker().evaluate("globalThis.__restrictedChooserEvidence.holdNextWrite()"); item.setStartedAt = Date.now();
      const result = outcome(browser.client.setFileChooserFiles(item.chosen.fileChooserId, [files[0].path], 1000)); pending.push(result);
      await until(() => getWorker().evaluate("globalThis.__restrictedChooserEvidence.snapshot().held"), "original native chooser ACK held"); item.held = await getWorker().evaluate("globalThis.__restrictedChooserEvidence.snapshot()");
      const expired = await result; item.expiredAt = Date.now(); item.rejections.push({ name: "original-setter-timeout", authority: "timeout", ...expired }); assert.equal(expired.ok, false);
      await until(async () => { const value = await snapshot(getWorker(), tab.id); return value.documents[0]?.result.receipt ? (item.afterWrite = value) : false; }, "original native chooser upload receipt");
      const origins = [new URL(fixtureURL).origin, new URL(fixtureURL).origin.replace("127.0.0.1", "localhost")].sort(); item.policyBeforeHold = await controls.read();
      item.durableBeforeHold = await getWorker().evaluate("chrome.storage.local.get(['OPEN_BROWSER_USE_SITE_ACCESS_POLICY'])"); item.cleanupTimeoutMs = await getWorker().evaluate("globalThis.__integrationBackend.automationCleanupTimeoutMs"); assert.equal(item.cleanupTimeoutMs, 10000);
      item.applyStartedAt = Date.now(); const policy = outcome(controls.apply("allow", origins)); pending.push(policy); item.failedApply = await policy; item.failedApplyObservation = "Trusted popup saved-status observation, not the original backend reply"; assert.equal(item.failedApply.ok, false, "Policy Apply incorrectly completed before original file ACK delivery");
      await until(async () => { const state = await getWorker().evaluate("globalThis.__integrationBackend.automationControl.status()"); return state.state === "error" && state.inputBlocked && !state.cleanupComplete ? (item.blocked = state) : false; }, "original Pause cleanup deadline reaches Failed"); item.pauseFailedAt = Date.now();
      item.heldAfterFailed = await getWorker().evaluate("globalThis.__restrictedChooserEvidence.snapshot()"); item.policyAfterFailed = await controls.read(); item.durableAfterFailed = await getWorker().evaluate("chrome.storage.local.get(['OPEN_BROWSER_USE_SITE_ACCESS_POLICY'])");
      await reject("old-policy-setter", setOriginal(), "control"); await getWorker().evaluate("globalThis.__restrictedChooserEvidence.release()");
      await until(async () => { const state = await getWorker().evaluate("({pending:globalThis.__restrictedChooserEvidence.snapshot().pending,operations:globalThis.__integrationBackend.directoryUploads.operations.size})"); return state.pending === 0 && state.operations === 0 ? (item.operationsAfterRelease = state.operations, true) : false; }, "original file write and cleanup actually settle");
      item.policyChanged = await controls.apply("allow", origins); item.resume = await controls.resume(); await browser.client.beginTurn(); item.newScope = chooserScope(browser);
    });
    const mixed = await create("mixed-denied-child", "oopif"); await ready(mixed);
    await run(await create("policy-revocation"), async ({ item, open, reject, setOriginal }) => {
      const wait = await open(); item.policyChanged = await controls.apply("allow", [new URL(fixtureURL).origin]);
      await reject("old-policy-setter", setOriginal(), "control"); await reject("old-policy-cancel", wait.cancel(), "control"); item.resume = await controls.resume(); await browser.client.beginTurn(); item.newScope = chooserScope(browser);
    });
    await run(mixed, async ({ tab, reject }) => { await reject("mixed-tree-arm", tab.expectFileChooser({ timeoutMs: 5000 }), "source"); });
    await run(await create("future-denied-child", "dynamic-oopif"), async ({ item, tab, arm, reject }) => {
      const wait = await arm(); try { await tab.getByRole("button", { name: "Add upload frame", exact: true }).click({ timeoutMs: 5000 }); } catch (error) { item.addError = text(error); assert.match(item.addError, sourceDenied); }
      await until(async () => (await getWorker().evaluate(`chrome.webNavigation.getAllFrames({tabId:${tab.id}})`)).some(row => row.parentFrameId === 0 && new URL(row.url).hostname === "localhost"), "actual denied chooser child committed");
      await reject("future-tree-collect", wait.result(), "chooser"); item.cancelResult = await wait.cancel(); item.cancelled = true;
    });
    assert.deepEqual(detail.executionOrder, ["explicit-cancel", "same-url-new-document", "late-native-policy", "policy-revocation", "mixed-denied-child", "future-denied-child"]);
    detail.proof = { cases: detail.cases.length, posts: detail.cases.reduce((sum, item) => sum + item.proof.posts, 0), bytes: detail.cases.reduce((sum, item) => sum + item.proof.bytes, 0) }; assert.equal(detail.proof.cases, 6); assert.equal(detail.proof.posts, 1);
  } catch (error) { failure = error; }
  finally {
    try { detail.serverLedger = fixtures.allStats(); } catch (error) { detail.serverLedgerError = text(error); failure ??= error; }
    try { detail.childTargetIds = await getWorker().evaluate(`globalThis.__integrationFrames.filter(row=>${json(detail.tabIds)}.includes(row.tabId)).map(row=>row.targetId)`); } catch (error) { detail.childTargetReadError = text(error); failure ??= error; }
    for (const id of detail.tabIds) try { await getWorker().evaluate(`chrome.tabs.remove(${id})`); } catch (error) { (detail.tabCleanupErrors ??= []).push({ tabId: id, error: text(error) }); failure ??= error; }
    try { assert.ok(Array.isArray(detail.childTargetIds)); detail.cleanup = await getWorker().evaluate(`(async()=>({tabs:(await chrome.tabs.query({})).filter(row=>${json(detail.tabIds)}.includes(row.id)),targets:(await chrome.debugger.getTargets()).filter(row=>${json(detail.tabIds)}.includes(row.tabId)||${json(detail.childTargetIds)}.includes(row.id)),probePresent:!!globalThis.__restrictedChooserEvidence}))()`); assert.deepEqual(detail.cleanup, { tabs: [], targets: [], probePresent: false }); } catch (error) { detail.cleanupError = text(error); failure ??= error; }
    try { detail.finalizeScope = chooserScope(browser); assert.ok(Number.isSafeInteger(detail.finalizeScope.control_epoch) && detail.finalizeScope.control_epoch > 0); detail.finalize = await browser.client.finalizeTabs([]); } catch (error) { detail.finalizeError = text(error); failure ??= error; }
    try { browser.close(); } catch (error) { detail.connectionCleanupError = text(error); failure ??= error; }
    if (failure) detail.error = text(failure); try { await saveDetail(detail); } catch (error) { failure ??= error; }
  }
  if (failure) throw failure; return detail;
}

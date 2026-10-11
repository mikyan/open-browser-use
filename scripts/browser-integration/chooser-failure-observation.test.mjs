import assert from "node:assert/strict";
import test from "node:test";
import vm from "node:vm";
import { chooserFailureDocument, observeChooserFailure, finishChooserCase, chooserPointerEvidenceComplete, chooserFailedCallerItem, observeChooserCallerFailure } from "./chooser-failure-observation.mjs";
import { checkChooserReady, installChooserPointerEvidence } from "./chooser-waits-fixture.mjs";

function fixture(variant = "dynamic-oopif", fixtureKind = "chooser", key = "unit-chooser") {
  const fixtureURL = "http://127.0.0.1:8123/", item = { tabId: 42, key, variant };
  const route = fixtureKind === "directory" ? "directory-upload" : "chooser-waits";
  const root = `${fixtureURL}${route}/page?key=${key}&variant=${variant}`;
  const child = `http://localhost:8123/${route}/frame?key=${key}&variant=${variant}`;
  const frames = [{ frameId: 0, parentFrameId: -1, documentId: "root-doc", documentLifecycle: "active", errorOccurred: false, processId: 1, url: root },
    ...(variant === "root" ? [] : [{ frameId: 8, parentFrameId: 0, documentId: "child-doc", documentLifecycle: "active", errorOccurred: false, processId: 2, url: child }])];
  const metadata = { tab: { id: 42, windowId: 9, active: false, url: root }, frames, frameCount: frames.length };
  const results = frames.map(frame => ({ frameId: frame.frameId, documentId: frame.documentId,
    result: { observed: true, href: frame.url, truncated: false,
      [fixtureKind === "directory" ? "directoryEvidence" : "chooserEvidence"]: { documentToken: `${frame.documentId}-fixture`, clicks: [], frameAdds: [],
        ...(fixtureKind === "directory" ? { inputToken: `${frame.documentId}-input`, events: [], errors: [] } : { changes: [] }) } } }));
  const calls = [];
  return { fixtureURL, fixtureKind, item, metadata, results, calls,
    readMetadata: async () => { calls.push("metadata"); return metadata; },
    readDocuments: async targets => { calls.push(targets); return results; } };
}

function callerFixture(kind = "mcp", count = 3) {
  const prefix = `${kind}-chooser`, sessionId = ["cli", "mcp"].includes(kind) ? `${kind}-chooser-ready` : prefix;
  const variants = ["root", "oopif", "dynamic-oopif"].slice(0, count);
  const f = fixture(variants.at(-1), "chooser", `${prefix}-${variants.at(-1)}`);
  const callerResult = { caller: kind, independentConnections: true, error: "original collect timeout",
    variants: variants.map((variant, index) => ({ variant, key: `${prefix}-${variant}`, tabId: 43 - count + index,
      passed: index < count - 1, ...(index < count - 1
        ? { scope: { session_id: sessionId, turn_id: "chooser-ready", control_epoch: 1 } }
        : { error: "original collect timeout", failedStage: "collect", waits: [{ sequence: 0, triggerCompletedAt: 10 }] }) })) };
  return { ...f, kind, prefix, sessionId, callerResult, detail: { error: "original collect timeout" }, callerClosed: true };
}

function freezeTree(value) {
  if (value && typeof value === "object") { for (const child of Object.values(value)) freezeTree(child); Object.freeze(value); }
  return value;
}

test("closed caller partials select the original failed variant without mutating retained evidence", async () => {
  for (const kind of ["cli", "mcp", "python", "go"]) for (const count of [1, 2, 3]) {
    const f = callerFixture(kind, count), before = structuredClone(f.callerResult);
    freezeTree(f.callerResult);
    const selected = chooserFailedCallerItem(f.callerResult, f);
    assert.deepEqual(selected, f.callerResult.variants.at(-1));
    assert.notEqual(selected, f.callerResult.variants.at(-1));
    const report = await observeChooserCallerFailure(f);
    assert.equal(report.complete, true, `${kind}/${count}: ${report.errors}`);
    assert.equal(report.callerClosed, true); assert.equal(report.passed, undefined);
    assert.equal(report.tabId, 42); assert.equal(f.calls.length, 2);
    assert.deepEqual(f.callerResult, before);
    assert.equal(await observeChooserCallerFailure(f), report); assert.equal(f.calls.length, 2);
  }
});

for (const [name, mutate] of [
  ["unknown caller", f => { f.kind = "unknown"; }],
  ["foreign caller", f => { f.callerResult.caller = "go"; }],
  ["foreign prefix", f => { f.prefix = "go-chooser"; }],
  ["foreign session", f => { f.sessionId = "foreign"; }],
  ["missing original error", f => { delete f.callerResult.error; }],
  ["unconfirmed connections", f => { f.callerResult.independentConnections = false; }],
  ["unrelated diagnostic", f => { f.callerResult.diagnostic = {}; }],
  ["unrelated child process", f => { f.callerResult.childProcess = {}; }],
  ["previous top observation", f => { f.callerResult.failureObservation = {}; }],
  ["missing variants", f => { delete f.callerResult.variants; }],
  ["empty variants", f => { f.callerResult.variants = []; }],
  ["extra variant", f => { f.callerResult.variants.push({ ...f.callerResult.variants.at(-1) }); }],
  ["missing earlier variant", f => { f.callerResult.variants.shift(); }],
  ["out of order", f => { f.callerResult.variants.reverse(); }],
  ["foreign key", f => { f.callerResult.variants.at(-1).key = "other-chooser-dynamic-oopif"; }],
  ["duplicate tab", f => { f.callerResult.variants.at(-1).tabId = f.callerResult.variants[0].tabId; }],
  ["newTab failed without identity", f => { delete f.callerResult.variants.at(-1).tabId; }],
  ["negative tab", f => { f.callerResult.variants.at(-1).tabId = -1; }],
  ["unsafe tab", f => { f.callerResult.variants.at(-1).tabId = Number.MAX_SAFE_INTEGER + 1; }],
  ["previous item observation", f => { f.callerResult.variants[0].failureObservation = {}; }],
  ["foreign scope session", f => { f.callerResult.variants[0].scope.session_id = "foreign"; }],
  ["foreign scope turn", f => { f.callerResult.variants[0].scope.turn_id = "foreign"; }],
  ["invalid scope epoch", f => { f.callerResult.variants[0].scope.control_epoch = 0; }],
  ["earlier unsuccessful item", f => { f.callerResult.variants[0].passed = false; }],
  ["earlier failed timestamp", f => { f.callerResult.variants[0].failedAt = 1; }],
  ["earlier original error", f => { f.callerResult.variants[0].originalError = "earlier failure"; }],
  ["close-only failure after all passed", f => { const item = f.callerResult.variants.at(-1); item.passed = true; delete item.error; delete item.failedStage; }],
  ["failed item lacks error", f => { delete f.callerResult.variants.at(-1).error; }],
  ["kill requested without close", f => { f.callerClosed = false; }],
  ["missing close", f => { delete f.callerClosed; }],
  ["truthy non-boolean close", f => { f.callerClosed = 1; }],
  ["stdout/file mismatch", f => { f.callerReadError = "stdout differs from file"; }]
]) test(`caller rejection performs zero browser reads: ${name}`, async () => {
  const f = callerFixture(); mutate(f);
  const report = await observeChooserCallerFailure(f);
  assert.equal(report.complete, false); assert.equal(report.errors.length, 1);
  assert.deepEqual(f.calls, []); assert.equal(report.passed, undefined);
  assert.equal(await observeChooserCallerFailure(f), report); assert.deepEqual(f.calls, []);
});

test("caller observer registers before awaiting and does not duplicate reads on concurrent failure handling", async () => {
  const f = callerFixture(); let release;
  f.readMetadata = () => { f.calls.push("metadata"); return new Promise(resolve => { release = resolve; }); };
  const pending = observeChooserCallerFailure(f), inFlight = await observeChooserCallerFailure(f);
  assert.equal(inFlight.complete, false); assert.deepEqual(f.calls, ["metadata"]);
  release(f.metadata);
  assert.equal(await pending, inFlight); assert.equal(inFlight.complete, true); assert.equal(f.calls.length, 2);
});

test("valid caller identity still rejects recycled tabs and replacement documents without hiding the frozen business error", async () => {
  for (const stage of ["metadata", "document"]) {
    const f = callerFixture("python"), original = Object.freeze(new Error("original timeout"));
    if (stage === "metadata") f.metadata.tab.id++;
    else f.results[1].documentId = "replacement";
    await assert.rejects((async () => { try { throw original; } catch (error) { await observeChooserCallerFailure(f); throw error; } })(), error => error === original);
    assert.equal(f.detail.failureObservation.complete, false);
    assert.equal(f.calls.length, stage === "metadata" ? 1 : 2);
    assert.equal(f.callerResult.variants.at(-1).error, "original collect timeout");
  }
});

test("one bounded failure observation binds exact root/child native document IDs without granting case success", async () => {
  const f = fixture(), r = await observeChooserFailure(f);
  assert.equal(r.complete, true); assert.equal(r.passed, undefined); assert.deepEqual(r.errors, []);
  assert.deepEqual(f.calls, ["metadata", { tabId: 42, documentIds: ["root-doc", "child-doc"], expectedURLs: f.frames ?? f.metadata.frames.map(frame => frame.url) }]);
  assert.equal(await observeChooserFailure(f), r); assert.equal(f.calls.length, 2, "Repeated catch must not retry observation");
});

for (const [name, mutate] of [
  ["recycled tab", f => { f.metadata.tab.id = 43; }],
  ["different root URL", f => { f.metadata.tab.url = "http://127.0.0.1:8123/other"; }],
  ["pending foreign navigation", f => { f.metadata.tab.pendingUrl = "http://localhost:8123/other"; }],
  ["ambiguous child", f => { f.metadata.frames.push({ ...f.metadata.frames[1], frameId: 9, documentId: "second" }); f.metadata.frameCount++; }],
  ["missing document ID", f => { delete f.metadata.frames[1].documentId; }],
  ["truncated metadata", f => { f.metadata.frameCount++; }]
]) test(`identity rejection prevents document reads: ${name}`, async () => {
  const f = fixture(); mutate(f); const r = await observeChooserFailure(f);
  assert.equal(r.complete, false); assert.equal(r.errors.length, 1); assert.deepEqual(f.calls, ["metadata"]);
});

test("missing dynamic child retains root evidence but cannot claim complete child observation", async () => {
  const f = fixture(); f.metadata.frames.pop(); f.metadata.frameCount--; f.results.pop();
  const r = await observeChooserFailure(f); assert.equal(r.complete, false); assert.equal(r.childStatus, "missing-current-child");
  assert.equal(r.results.length, 1); assert.deepEqual(r.errors, []);
});

test("a known prior document token mismatch is explicitly incomplete, not the original document", async () => {
  const f = fixture(); f.item.documentToken = "prior-fixture-document";
  const r = await observeChooserFailure(f);
  assert.equal(r.priorDocumentTokenMatches, false); assert.equal(r.documentStatus, "different-document");
  assert.equal(r.complete, false); assert.equal(r.results.length, 2);
});

test("directory mode requires its own exact route/evidence and retains known input replacement as incomplete", async () => {
  const f = fixture("dynamic-oopif", "directory"), r = await observeChooserFailure(f);
  assert.equal(r.complete, true); assert.equal(r.fixtureKind, "directory");
  assert.equal(r.expected.root, f.metadata.tab.url); assert.match(r.expected.child, /\/directory-upload\/frame\?/);
  for (const change of [
    value => { value.metadata.tab.url = value.metadata.tab.url.replace("directory-upload", "chooser-waits"); },
    value => { value.results[1].result.chooserEvidence = value.results[1].result.directoryEvidence; delete value.results[1].result.directoryEvidence; },
    value => { value.item.inputToken = "prior-input"; },
    value => { value.fixtureKind = "arbitrary-path"; }
  ]) {
    const bad = fixture("dynamic-oopif", "directory"); change(bad); const observed = await observeChooserFailure(bad);
    assert.equal(observed.complete, false);
    if (bad.item.inputToken) { assert.equal(observed.priorInputTokenMatches, false); assert.equal(observed.inputStatus, "different-input-token"); }
    if (bad.fixtureKind === "arbitrary-path") assert.deepEqual(bad.calls, []);
  }
});

test("different/duplicate result document, URL, and truncated evidence all reject completeness", async () => {
  for (const mutate of [
    f => { f.results[1].documentId = "replacement"; },
    f => { f.results[1] = f.results[0]; },
    f => { f.results[1].result.href += "&different=1"; },
    f => { f.results[1].result.truncated = true; },
    f => { delete f.results[1].result.chooserEvidence; }
  ]) { const f = fixture(); mutate(f); const r = await observeChooserFailure(f); assert.equal(r.complete, false); assert.equal(r.errors.length, 1); }
});

test("metadata timeout never issues a late document read; hanging reads do not block original error propagation", async () => {
  const f = fixture(); let release;
  f.readMetadata = () => new Promise(resolve => { release = resolve; });
  const original = new Error("original chooser timeout");
  await assert.rejects((async () => { try { throw original; } catch (error) { await observeChooserFailure({ ...f, budgetMs: 15 }); throw error; } })(), error => error === original);
  assert.equal(f.item.failureObservation.complete, false); assert.match(f.item.failureObservation.errors[0], /budget expired/);
  release(f.metadata); await new Promise(resolve => setImmediate(resolve)); assert.deepEqual(f.calls, []);
});

test("a late metadata settlement is rejected even before its timer callback runs", async () => {
  const f = fixture(); let time = 10;
  f.readMetadata = async () => { time = 3010; return f.metadata; };
  const r = await observeChooserFailure({ ...f, now: () => time });
  assert.equal(r.complete, false); assert.match(r.errors[0], /after its original budget/); assert.deepEqual(f.calls, []);
});

test("document read error or hanging result remains observation-only and is not retried", async () => {
  for (const readDocuments of [async () => { throw new Error("scripting rejected"); }, () => new Promise(() => {})]) {
    const f = fixture(); const r = await observeChooserFailure({ ...f, budgetMs: 15, readDocuments });
    assert.equal(r.complete, false); assert.equal(r.errors.length, 1); assert.equal(r.reads.length, 2);
  }
});

test("serialized worker operations that execute after deadline issue no late native API", async () => {
  for (const lateStage of ["metadata", "document"]) {
    const f = fixture(); let workerClock = 10; const calls = [];
    const context = vm.createContext({ Date: { now: () => workerClock }, chrome: {
      tabs: { get: async () => { calls.push("tabs.get"); return f.metadata.tab; } },
      webNavigation: { getAllFrames: async () => { calls.push("getAllFrames"); return f.metadata.frames; } },
      scripting: { executeScript: async () => { calls.push("executeScript"); return f.results; } }
    } });
    let evaluations = 0;
    const worker = { evaluate(expression) {
      evaluations++;
      if (lateStage === "metadata" || evaluations === 2) workerClock = 3010;
      return vm.runInContext(expression, context);
    } };
    const r = await observeChooserFailure({ item: f.item, fixtureURL: f.fixtureURL, worker, now: () => 10 });
    assert.equal(r.complete, false); assert.match(r.errors[0], /deadline expired before native read/);
    assert.deepEqual(calls, lateStage === "metadata" ? [] : ["tabs.get", "getAllFrames"]);
    assert.equal(evaluations, lateStage === "metadata" ? 1 : 2);
  }
});

test("late injected document function returns expired before reading location or DOM", () => {
  let reads = 0;
  const context = vm.createContext({ Date: { now: () => 100 },
    get location() { reads++; throw new Error("must not read"); }, get document() { reads++; throw new Error("must not read"); } });
  const result = vm.runInContext(`(${chooserFailureDocument.toString()})([],100)`, context);
  assert.equal(result.observed, false); assert.equal(result.reason, "observation deadline expired"); assert.equal(reads, 0);
});

test("default ready keeps original failure identity when observation, cancel and native trace cleanup all fail", async () => {
  const original = new Error("original chooser timeout"), order = [];
  const wait = { waiterId: "waiter", remainingMs: 10000,
    result: async () => { order.push("collect"); throw original; },
    cancel: async () => { order.push("cancel"); throw new Error("cancel failed"); } };
  const owner = { client: { getInfo: async () => ({ metadata: { fileChooserWaitVersion: 1 } }) },
    newTab: async () => ({ id: 42, expectFileChooser: async () => wait }), cdp: { navigate: async () => {} } };
  const trigger = { tab: () => ({ getByLabel: () => ({ click: async () => { order.push("click"); } }) }) };
  const worker = { evaluate: async expression => {
    if (expression.includes("chrome.tabs.get")) { order.push("observation"); throw new Error("observation failed"); }
    if (expression.includes("removeListener")) { order.push("trace-cleanup"); throw new Error("trace cleanup failed"); }
    order.push("trace-start");
  } };
  await assert.rejects(checkChooserReady({ owner, trigger, worker, fixtureURL: "http://127.0.0.1/", prefix: "unit",
    server: { stats: () => ({ posts: [] }) } }), error => {
    assert.equal(error, original); const item = error.chooserDetail.variants[0];
    assert.equal(item.error, original.stack); assert.match(item.waits[0].cancelError, /cancel failed/);
    assert.match(item.nativeTraceError, /trace cleanup failed/); assert.match(item.failureObservation.errors[0], /observation failed/);
    return true;
  });
  assert.deepEqual(order, ["trace-start", "click", "collect", "observation", "cancel", "trace-cleanup"]);
});

test("parent cleanup attempts each connection once and preserves original error through finalize, close and persistence failures", async () => {
  const original = new Error("original collect failure"), order = [], detail = { error: original.stack }, logs = [];
  await assert.rejects((async () => {
    try { throw original; }
    finally {
      await finishChooserCase({ detail, originalError: original, cleanup: [
        { name: "finalize", run: async () => { order.push("finalize"); throw new Error("finalize failed"); } },
        { name: "owner-close", run: () => { order.push("owner-close"); throw new Error("owner close failed"); } },
        { name: "trigger-close", run: () => { order.push("trigger-close"); } }
      ], save: async value => { order.push("save"); assert.equal(value.cleanupErrors.length, 2); throw new Error("disk failed"); },
      reportErrors: errors => logs.push(structuredClone(errors)) });
    }
  })(), error => error === original);
  assert.deepEqual(order, ["finalize", "owner-close", "trigger-close", "save"]);
  assert.deepEqual(detail.cleanupErrors.map(item => item.stage), ["finalize", "owner-close", "persist"]);
  assert.equal(original.chooserCleanupErrors, detail.cleanupErrors); assert.deepEqual(logs, [detail.cleanupErrors]);
});

test("cleanup-only errors still fail the case; diagnostic cleanup cannot prevent finalization", async () => {
  const originalCleanup = new Error("diagnostic cleanup failed"), order = [], detail = {}; let saved;
  await assert.rejects(finishChooserCase({ detail, cleanup: [
    { name: "diagnostic-cleanup", run: async () => { order.push("diagnostic"); throw originalCleanup; } },
    { name: "finalize", run: async () => { order.push("finalize"); } },
    { name: "close", run: () => { order.push("close"); } }
  ], save: async value => { order.push("save"); saved = structuredClone(value); }, reportErrors: () => {} }), error => error === originalCleanup);
  assert.deepEqual(order, ["diagnostic", "finalize", "close", "save"]);
  assert.deepEqual(saved, detail); assert.equal(saved.cleanupErrors.length, 1);
});

test("successful cleanup invokes only the original operations and one save; persistence-only failure cannot pass", async () => {
  const order = [], detail = { passed: true };
  await finishChooserCase({ detail, cleanup: [{ name: "finalize", run: () => order.push("finalize") },
    { name: "close", run: () => order.push("close") }], save: value => { assert.equal(value, detail); order.push("save"); } });
  assert.deepEqual(order, ["finalize", "close", "save"]); assert.deepEqual(detail, { passed: true });
  const error = new Error("persistence failed");
  await assert.rejects(finishChooserCase({ detail: {}, cleanup: [], save: () => { throw error; }, reportErrors: () => { throw new Error("log failed"); } }), value => value === error);
});

test("frozen business and cleanup errors preserve their identity when metadata cannot be attached", async () => {
  const original = Object.freeze(new Error("frozen original")), cleanupError = Object.freeze(new Error("frozen cleanup"));
  for (const originalError of [original, undefined]) {
    const detail = {}, logs = [];
    await assert.rejects((async () => {
      try { if (originalError) throw originalError; }
      finally { await finishChooserCase({ detail, originalError,
        cleanup: [{ name: "finalize", run: () => { throw cleanupError; } }], save: () => {}, reportErrors: value => logs.push(value) }); }
    })(), error => error === (originalError ?? cleanupError));
    assert.equal(detail.cleanupErrors.length, 1); assert.equal(logs[0], detail.cleanupErrors);
  }
});

test("serialized fixed reader refuses a replacement page before accessing its document", () => {
  let documentReads = 0;
  const context = vm.createContext({ location: { href: "https://unrelated.invalid/" }, get document() { documentReads++; throw new Error("must not read"); } });
  const value = vm.runInContext(`(${chooserFailureDocument.toString()})(['http://127.0.0.1:8123/chooser-waits/page'],${Date.now() + 10000})`, context);
  assert.equal(value.observed, false); assert.equal(documentReads, 0);
});

test("serialized reader retains real event values and geometry without installing handlers or input actions", () => {
  const input = { tagName: "INPUT", id: "upload", isConnected: true, disabled: false, files: [],
    getAttribute: () => "file", getBoundingClientRect: () => ({ x: 7, y: 8, width: 9, height: 10 }) };
  const url = "http://localhost:8123/chooser-waits/frame?key=unit&variant=oopif";
  const context = vm.createContext({ location: { href: url }, document: { readyState: "complete", visibilityState: "hidden", hasFocus: () => false,
    activeElement: input, querySelector: () => input, querySelectorAll: () => [] },
    innerWidth: 600, innerHeight: 260, scrollX: 0, scrollY: 0, devicePixelRatio: 1.5,
    chooserEvidence: { documentToken: "original-node-document", clicks: [{ trusted: true }], changes: [], frameAdds: [] } });
  const value = vm.runInContext(`(${chooserFailureDocument.toString()})(${JSON.stringify([url])},${Date.now() + 10000})`, context);
  assert.equal(value.observed, true); assert.equal(value.truncated, false); assert.equal(value.chooserEvidence.clicks[0].trusted, true);
  assert.deepEqual(JSON.parse(JSON.stringify(value.input.rect)), { x: 7, y: 8, width: 9, height: 10 });
  context.chooserEvidence.clicks = Array.from({ length: 129 }, () => ({ trusted: false }));
  const limited = vm.runInContext(`(${chooserFailureDocument.toString()})(${JSON.stringify([url])},${Date.now() + 10000})`, context);
  assert.equal(limited.truncated, true); assert.equal(limited.chooserEvidence.clicks.length, 128);
});

test("directory serialized reader records only existing bounded event metadata, never File contents", () => {
  let fileReads = 0;
  const file = { arrayBuffer() { fileReads++; throw new Error("must not read File bytes"); } };
  const input = { tagName: "INPUT", id: "upload", isConnected: true, disabled: false, webkitdirectory: true, multiple: true,
    files: [file], getAttribute: () => "file", getBoundingClientRect: () => ({ x: 10, y: 20, width: 300, height: 45 }) };
  const url = "http://localhost:8123/directory-upload/frame?key=unit&variant=dynamic-oopif";
  const context = vm.createContext({ location: { href: url }, document: { readyState: "complete", visibilityState: "hidden", hasFocus: () => false,
    activeElement: input, querySelector: () => input, querySelectorAll: () => [] },
    innerWidth: 650, innerHeight: 280, scrollX: 0, scrollY: 0, devicePixelRatio: 1.5,
    directoryEvidence: { documentToken: "document", inputToken: "original-input", clicks: [{ trusted: true }], frameAdds: [], errors: [],
      events: [{ event: "cancel", eventIndex: 1, sequence: 1, trusted: true, files: [file],
        input: { id: "upload", type: "file", webkitdirectory: true, multiple: true, connected: true, originalNode: true } }] } });
  const read = () => vm.runInContext(`(${chooserFailureDocument.toString()})(${JSON.stringify([url])},${Date.now() + 10000},"directory")`, context);
  const value = read();
  assert.equal(value.observed, true); assert.equal(value.truncated, false); assert.equal(value.chooserEvidence, undefined);
  assert.equal(value.directoryEvidence.events[0].event, "cancel"); assert.equal(value.directoryEvidence.events[0].fileCount, 1);
  assert.equal(value.directoryEvidence.events[0].input.originalNode, true); assert.equal(value.input.webkitdirectory, true);
  assert.equal(fileReads, 0);
  context.directoryEvidence.events = Array.from({ length: 129 }, () => context.directoryEvidence.events[0]);
  const limited = read(); assert.equal(limited.truncated, true); assert.equal(limited.directoryEvidence.events.length, 128); assert.equal(fileReads, 0);
});

function pointerFixture() {
  const evidence = { documentToken: "pointer-document", clicks: [], changes: [], frameAdds: [] }, listeners = new Map();
  const input = { nodeType: 1, tagName: "INPUT", id: "upload", isConnected: true, disabled: false, files: [],
    getAttribute: name => name === "id" ? "upload" : "file", getBoundingClientRect: () => ({ x: 7, y: 8, width: 9, height: 10 }) };
  const url = "http://localhost:8123/chooser-waits/frame?key=unit&variant=oopif";
  const document = { readyState: "complete", visibilityState: "hidden", hasFocus: () => false, activeElement: null,
    querySelector: () => input, querySelectorAll: () => [], addEventListener: (type, callback) => listeners.set(type, callback) };
  installChooserPointerEvidence(document, evidence, input, null);
  const context = vm.createContext({ location: { href: url }, document, chooserEvidence: evidence,
    innerWidth: 600, innerHeight: 260, scrollX: 0, scrollY: 0, devicePixelRatio: 1.5 });
  const read = (enabled = true) => vm.runInContext(`(${chooserFailureDocument.toString()})(${JSON.stringify([url])},${Date.now() + 10000},"chooser",${enabled})`, context);
  const emit = () => listeners.get("mousedown")({ type: "mousedown", timeStamp: 4, isTrusted: true, target: input,
    clientX: 8, clientY: 9, button: 0, buttons: 1 });
  return { evidence, input, context, read, emit };
}

test("pointer-only fixed reader projects known bounded fields and leaves optional evidence completely untouched when off", () => {
  const f = pointerFixture(); f.emit();
  Object.defineProperty(f.evidence.pointerEvidence, "privatePayload", { get() { throw new Error("arbitrary ledger property read"); } });
  Object.defineProperty(f.evidence.pointerEvidence.records[0], "privatePayload", { get() { throw new Error("arbitrary event property read"); } });
  const value = f.read();
  assert.equal(value.truncated, false); assert.equal(chooserPointerEvidenceComplete(value.chooserEvidence), true);
  assert.deepEqual(JSON.parse(JSON.stringify(value.chooserEvidence.pointerEvidence)), f.evidence.pointerEvidence);
  assert.equal(value.chooserEvidence.pointerEvidence.records[0].targetIsOriginalUpload, true);
  Object.defineProperty(f.evidence, "pointerEvidence", { get() { throw new Error("pointer field read while disabled"); } });
  const off = f.read(false); assert.equal(off.truncated, false); assert.equal(Object.hasOwn(off.chooserEvidence, "pointerEvidence"), false);
  const failed = f.read(); assert.equal(failed.chooserEvidence.pointerEvidence, null); assert.match(failed.chooserEvidence.pointerReadError, /could not be read/);
});

test("pointer-only projection enforces record/string/character limits and does not normalize missing nullable fields into valid evidence", () => {
  for (const mutate of [
    value => { value.evidence.pointerEvidence.records[0].target.id = "x".repeat(129); },
    value => { value.evidence.pointerEvidence.records = Array.from({ length: 257 }, () => value.evidence.pointerEvidence.records[0]); },
    value => { const record = value.evidence.pointerEvidence.records[0]; record.target = { tag: "x".repeat(128), id: "x".repeat(128), type: "x".repeat(128) }; value.evidence.pointerEvidence.records = Array.from({ length: 256 }, () => record); }
  ]) {
    const f = pointerFixture(); f.emit(); mutate(f); const value = f.read();
    assert.equal(value.truncated, true); assert.ok(value.chooserEvidence.pointerEvidence.records.length <= 256);
    assert.ok(value.chooserEvidence.pointerEvidence.records.reduce((sum, row) => sum + JSON.stringify(row).length, 0) <= 65536);
    assert.equal(chooserPointerEvidenceComplete(value.chooserEvidence), false);
  }
  for (const key of ["pointerId", "pointerType", "target", "trusted"]) {
    const f = pointerFixture(); f.emit(); delete f.evidence.pointerEvidence.records[0][key];
    assert.equal(chooserPointerEvidenceComplete(f.read().chooserEvidence), false, key);
  }
});

test("pointer-only observation accepts empty root/child logs and fails missing or damaged logs under the same document identity checks", async () => {
  for (const defect of [null, "missing", "overflow", "errors", "wrong-document", "prior-document"]) {
    const f = fixture();
    for (const result of f.results) installChooserPointerEvidence({ addEventListener() {} }, result.result.chooserEvidence, null, null);
    const child = f.results[1].result.chooserEvidence;
    if (defect === "missing") delete child.pointerEvidence;
    if (defect === "overflow") child.pointerEvidence.overflow = true;
    if (defect === "errors") child.pointerEvidence.recordingErrors = 1;
    if (defect === "wrong-document") f.results[1].documentId = "replacement";
    if (defect === "prior-document") f.item.documentToken = "old-document";
    const report = await observeChooserFailure({ ...f, pointerEvidence: true });
    assert.equal(report.pointerObservationRequested, true); assert.equal(report.pointerObservationComplete, defect === null);
    assert.equal(report.complete, defect === null); assert.equal(report.passed, undefined);
    assert.equal(await observeChooserFailure({ ...f, pointerEvidence: true }), report); assert.equal(f.calls.length, 2);
  }
  const off = fixture();
  Object.defineProperty(off.results[0].result.chooserEvidence, "pointerEvidence", { get() { throw new Error("must not read pointer"); } });
  const report = await observeChooserFailure(off);
  assert.equal(report.complete, true); assert.equal(report.pointerObservationRequested, false); assert.equal(report.pointerObservationComplete, null);
});

test("pointer-only passes its option only to the exact documentId scripting read after the original failure", async () => {
  const f = fixture("root"); installChooserPointerEvidence({ addEventListener() {} }, f.results[0].result.chooserEvidence, null, null);
  const requests = [], context = vm.createContext({ chrome: {
    tabs: { get: async () => f.metadata.tab }, webNavigation: { getAllFrames: async () => f.metadata.frames },
    scripting: { executeScript: async request => { requests.push(request); return f.results; } }
  } });
  const worker = { evaluate: expression => vm.runInContext(expression, context) };
  const report = await observeChooserFailure({ item: f.item, fixtureURL: f.fixtureURL, worker, pointerEvidence: true });
  assert.equal(report.complete, true); assert.equal(requests.length, 1);
  assert.deepEqual(Array.from(requests[0].target.documentIds), ["root-doc"]); assert.equal(requests[0].target.tabId, 42);
  assert.equal(requests[0].args[1], report.deadline); assert.equal(requests[0].args[3], true); assert.equal(report.budgetMs, 3000);
});

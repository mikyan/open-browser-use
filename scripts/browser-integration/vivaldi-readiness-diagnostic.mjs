// Harness-only, pre-attach experiment. Never loaded into the extension.
import assert from "node:assert/strict";

export function vivaldiReadinessEnabled(value, { name, nativeDiagnostics = false } = {}) {
  if (value === undefined || value === "" || value === "0") return false;
  assert.equal(value, "1", "OBU_TEST_VIVALDI_READINESS must be unset, empty, 0 or 1");
  assert.equal(name, "vivaldi", "Vivaldi readiness diagnostics require the actual Vivaldi browser");
  assert.equal(nativeDiagnostics, false, "Readiness and native API diagnostics cannot be combined");
  return true;
}

// Check before invoking the thunk, and after settlement. A timed-out outer
// operation cannot later continue with another create/connect/evaluate step.
export function readinessBudget({ requestedAt, timeoutMs = 25000, now = Date.now }) {
  const deadline = requestedAt + timeoutMs;
  let expired = false;
  const remaining = () => {
    const value = deadline - now();
    if (expired || value <= 0) throw new Error("Vivaldi readiness absolute deadline expired");
    return value;
  };
  const run = async (operation, label) => {
    const timeout = remaining(); let timer;
    try {
      const result = await Promise.race([operation(), new Promise((_, reject) => {
        timer = setTimeout(() => { expired = true; reject(new Error(`${label}: Vivaldi readiness absolute deadline expired`)); }, timeout);
      })]);
      remaining(); return result;
    } finally { clearTimeout(timer); }
  };
  return { deadline, remaining, run };
}

function metadata(value, fields, record) {
  const result = {};
  for (const key of fields) if (value?.[key] !== undefined) {
    const item = value[key];
    assert.ok(["string", "number", "boolean"].includes(typeof item), `Invalid readiness ${key}`);
    if (typeof item === "string" && item.length > 2000) record.payloadTruncated = true;
    result[key] = typeof item === "string" ? item.slice(0, 2000) : item;
  }
  return result;
}

export async function openVivaldiReadinessPage({ url, purpose, createTarget, targets, connect, record, persist, failureTargets, diagnosticTimeoutMs = 2500, timeoutMs = 25000, maximumSamples = 400, now = Date.now, sleep = ms => new Promise(resolve => setTimeout(resolve, ms)) }) {
  assert.ok(["installation-manager", "focus-observer"].includes(purpose));
  assert.ok(Number.isInteger(maximumSamples) && maximumSamples > 0 && maximumSamples <= 400);
  const budget = readinessBudget({ requestedAt: now(), timeoutMs, now });
  Object.assign(record, { mode: "vivaldi-readiness-diagnostic", purpose, requestedUrl: url, background: true, requestedAt: budget.deadline - timeoutMs, deadline: budget.deadline, timeoutMs, stage: "create-target", samples: [], sampleCount: 0, maximumSamples, overflow: false, dropped: 0, payloadTruncated: false, connectionCount: 0, evaluationCount: 0 });
  let page, created;
  try {
    await budget.run(persist, "initial evidence");
    created = await budget.run(() => createTarget(budget), "vendor creation and association");
    assert.ok(created?.targetId && Number.isInteger(created.tabId) && Number.isInteger(created.windowId));
    assert.equal(typeof created.readTab, "function");
    Object.assign(record, { targetId: created.targetId, tabId: created.tabId, windowId: created.windowId, createdAt: now(), stage: "pre-attach-native-readiness" });
    const expectedSocket = created.target.webSocketDebuggerUrl;
    assert.equal(created.target.id, created.targetId); assert.equal(created.target.url, url); assert.equal(created.target.type, "page");
    assert.ok(typeof expectedSocket === "string" && expectedSocket.length > 0);
    do {
      const sample = { index: ++record.sampleCount, requestedAt: now() };
      record.lastSample = sample; if (!record.firstSample) record.firstSample = sample;
      if (record.samples.length < maximumSamples) record.samples.push(sample);
      else { record.overflow = true; record.dropped++; }
      // Read failures are terminal. Only successful, incomplete state repeats.
      try {
        const tab = await budget.run(() => created.readTab(budget), "native tabs.get");
        sample.tabReadAt = now(); sample.tab = metadata(tab, ["id", "windowId", "active", "url", "pendingUrl", "status", "pinned", "groupId", "discarded", "frozen"], record);
        const values = await budget.run(() => targets(budget), "original target metadata");
        const matches = values.filter(value => value.id === created.targetId);
        assert.equal(matches.length, 1, "Original Vivaldi target disappeared or became ambiguous");
        const target = matches[0];
        sample.targetReadAt = now(); sample.target = metadata(target, ["id", "type", "url", "title", "webSocketDebuggerUrl", "attached"], record);
        assert.equal(tab.id, created.tabId); assert.equal(tab.windowId, created.windowId); assert.equal(tab.active, false);
        assert.ok(["loading", "complete"].includes(tab.status), "Unknown native tab status");
        assert.ok(tab.url === "" || tab.url === url, "Original tab changed URL");
        assert.ok(!tab.pendingUrl || tab.pendingUrl === url, "Original tab has a different pending URL");
        assert.equal(target.type, "page"); assert.equal(target.webSocketDebuggerUrl, expectedSocket);
        assert.ok(target.url === "" || target.url === url, "Original target changed URL");
        assert.notEqual(target.attached, true, "Target was already attached before readiness gate");
        sample.ready = tab.url === url && tab.status === "complete" && !tab.pendingUrl && target.url === url;
        sample.completedAt = now();
      } catch (error) { sample.error = error.stack ?? String(error); sample.failedAt = now(); throw error; }
      assert.equal(record.payloadTruncated, false, "Readiness identity metadata was truncated");
      assert.equal(record.overflow, false, "Readiness samples overflowed");
      if (sample.ready) break;
      await budget.run(() => sleep(Math.min(75, budget.remaining())), "native readiness sampling interval");
    } while (true);
    record.nativeReadyAt = now(); record.stage = "connect";
    record.advertisedTarget = record.lastSample.target;
    await budget.run(persist, "pre-attach evidence");
    record.connection = { requestedAt: now(), url: expectedSocket }; record.connectionCount++;
    page = await budget.run(() => connect(expectedSocket, { budget, connectionRecord: record.connection }), "first target connection");
    record.connection.connectedAt = now(); record.stage = "document-ready";
    do {
      const evaluation = { requestedAt: now() };
      record.lastEvaluation = evaluation; if (!record.firstEvaluation) record.firstEvaluation = evaluation;
      record.evaluationCount++;
      try {
        const value = await budget.run(() => page.evaluate("({url:location.href,title:document.title,readyState:document.readyState})", { budget }), "document readiness evaluation");
        evaluation.value = metadata(value, ["url", "title", "readyState"], record);
        assert.equal(record.payloadTruncated, false, "Document readiness metadata was truncated");
        evaluation.completedAt = now();
      } catch (error) { evaluation.failedAt = now(); evaluation.error = error.stack ?? String(error); throw error; }
      assert.equal(evaluation.value?.url, url, "Attached document changed URL");
      assert.ok(["loading", "interactive", "complete"].includes(evaluation.value?.readyState));
      if (evaluation.value.readyState === "complete") break;
      await budget.run(() => sleep(Math.min(75, budget.remaining())), "document readiness interval");
    } while (true);
    record.stage = "ready"; record.completedAt = now();
    await persist(); return { targetId: created.targetId, page };
  } catch (error) {
    record.failedAt = now(); record.error = error.stack ?? String(error);
    if (record.connection) record.connection.state = page?.state?.() ?? "not-connected";
    if (failureTargets) {
      const diagnostic = record.failureDiagnostics = { requestedAt: now(), timeoutMs: diagnosticTimeoutMs, outsideSuccessBudget: true, purpose: "Read-only target state after original failure; no reconnect or document evaluation" };
      try {
        assert.ok(diagnosticTimeoutMs > 0 && diagnosticTimeoutMs <= 2500);
        const failureBudget = readinessBudget({ requestedAt: now(), timeoutMs: diagnosticTimeoutMs, now });
        diagnostic.deadline = failureBudget.deadline;
        const [targetResult, tabResult] = await Promise.allSettled([
          failureBudget.run(failureTargets, "failure target snapshot"),
          created ? failureBudget.run(() => created.readTab(failureBudget), "failure native tab snapshot") : Promise.resolve(null),
        ]);
        diagnostic.nativeTab = tabResult.status === "fulfilled" ? (tabResult.value ? metadata(tabResult.value, ["id", "windowId", "active", "url", "pendingUrl", "status", "pinned", "groupId", "discarded", "frozen"], diagnostic) : null) : { error: tabResult.reason.stack ?? String(tabResult.reason) };
        if (targetResult.status === "rejected") throw targetResult.reason;
        const values = targetResult.value;
        const fields = ["id", "type", "url", "title", "webSocketDebuggerUrl", "attached"];
        diagnostic.count = values.length; diagnostic.truncated = values.length > 80;
        diagnostic.originalTarget = values.some(value => value.id === record.targetId) ? metadata(values.find(value => value.id === record.targetId), fields, diagnostic) : null;
        diagnostic.targets = values.slice(0, 80).map(value => metadata(value, fields, diagnostic));
        diagnostic.completedAt = now();
      } catch (readError) { diagnostic.error = readError.stack ?? String(readError); diagnostic.failedAt = now(); }
    }
    try { await persist(); } catch (persistError) { record.persistenceError = persistError.stack ?? String(persistError); }
    throw error;
  }
}

export function vivaldiReadinessResult({ pages = [], taskReached, cleanupComplete, taskRequestsOverflow = false }) {
  const observationsComplete = pages.length === 2 && ["installation-manager", "focus-observer"].every(purpose => pages.filter(page => page.purpose === purpose && page.stage === "ready" && !page.error && !page.overflow && !page.payloadTruncated && page.connectionCount === 1 && page.evaluationCount >= 1 && page.completedAt < page.deadline).length === 1);
  const diagnosticCompleted = observationsComplete && taskReached === true && cleanupComplete === true && taskRequestsOverflow === false;
  return { passed: false, diagnosticCompleted, observationsComplete, exitCode: diagnosticCompleted ? 0 : 1 };
}

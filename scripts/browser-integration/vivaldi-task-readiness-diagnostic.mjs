import assert from "node:assert/strict";
import { readinessBudget } from "./vivaldi-readiness-diagnostic.mjs";

export function vivaldiTaskReadinessEnabled(value, { name, input = false, readiness = false, nativeDiagnostics = false, ownership = false } = {}) {
  if (value === undefined || value === "" || value === "0") return false;
  assert.equal(value, "1", "OBU_TEST_VIVALDI_TASK_READY must be unset, empty, 0 or 1");
  assert.equal(name, "vivaldi", "Task readiness diagnostics require the actual Vivaldi browser");
  assert.equal(input || readiness || nativeDiagnostics || ownership, false, "Task readiness diagnostics cannot be combined with other explicit modes");
  return true;
}

function pick(value, keys, record) {
  const result = {};
  for (const key of keys) if (value?.[key] !== undefined) {
    assert.ok(["string", "number", "boolean"].includes(typeof value[key]), `Invalid native metadata ${key}`);
    if (typeof value[key] === "string" && value[key].length > 2000) record.payloadTruncated = true;
    result[key] = typeof value[key] === "string" ? value[key].slice(0, 2000) : value[key];
  }
  return result;
}

// Additional diagnostic phase, not an extension of newTab or goto deadlines.
// Reads use already connected observer/worker contexts, never the task renderer.
export async function waitForVivaldiTaskCommit({ tabId, windowId, readTab, readTargets, record, persist, timeoutMs = 5000, maximumSamples = 80, now = Date.now, sleep = ms => new Promise(resolve => setTimeout(resolve, ms)) }) {
  assert.ok(Number.isInteger(tabId) && Number.isInteger(windowId));
  assert.ok(Number.isInteger(maximumSamples) && maximumSamples > 0 && maximumSamples <= 80);
  const budget = readinessBudget({ requestedAt: now(), timeoutMs, now });
  Object.assign(record, { version: 1, tabId, windowId, expectedURL: "about:blank", requestedAt: budget.deadline - timeoutMs, deadline: budget.deadline, timeoutMs, maximumSamples, samples: [], sampleCount: 0, overflow: false, dropped: 0, payloadTruncated: false, ready: false, stage: "initial-commit", readSources: { tab: "existing independent tabs-only observer: chrome.tabs.get(exact tabId)", targets: "existing production worker: chrome.debugger.getTargets() (read-only native API, no private maps)" }, boundary: "An extra diagnostic stage after the original public newTab ACK and before the original goto. Only successful incomplete states repeat; no task attach, evaluation, navigation, activation, replacement or failed-command retry. Original goto options/deadline are unchanged. Native geometry is recorded, not a readiness condition." });
  try {
    await budget.run(persist, "task gate initial evidence");
    do {
      const sample = { index: ++record.sampleCount, requestedAt: now() };
      record.lastSample = sample; if (!record.firstSample) record.firstSample = sample;
      if (record.samples.length >= maximumSamples) { record.overflow = true; record.dropped++; throw new Error("Task readiness sample overflow"); }
      record.samples.push(sample);
      try {
        sample.tabRequestedAt = now();
        const tab = await budget.run(() => readTab(budget), "task native tab read");
        sample.tabReadAt = now(); sample.tab = pick(tab, ["id", "windowId", "active", "url", "pendingUrl", "status", "width", "height", "groupId", "pinned", "discarded", "frozen"], record);
        assert.equal(tab.id, tabId); assert.equal(tab.windowId, windowId); assert.equal(tab.active, false);
        assert.ok(["loading", "complete"].includes(tab.status), "Unknown task tab status");
        assert.ok(tab.url === "" || tab.url === "about:blank", "Original task tab changed URL");
        assert.ok(!tab.pendingUrl || tab.pendingUrl === "about:blank", "Original task tab changed pending URL");
        sample.targetsRequestedAt = now();
        const targets = await budget.run(() => readTargets(budget), "task native target read");
        sample.targetsReadAt = now();
        const matches = targets.filter(target => target.tabId === tabId);
        sample.matchingTargetCount = matches.length;
        sample.targets = matches.slice(0, 2).map(target => pick(target, ["id", "tabId", "type", "url", "title", "attached"], record));
        assert.ok(matches.length <= 1, "Ambiguous native target for exact task tab");
        const target = matches[0];
        if (record.targetId) assert.equal(target?.id, record.targetId, "Bound task target disappeared or changed identity");
        if (target) {
          assert.ok(typeof target.id === "string" && target.id.length > 0); assert.equal(target.type, "page"); assert.equal(target.attached, false);
          assert.ok(target.url === "" || target.url === "about:blank", "Original task target changed URL");
          record.targetId ??= target.id;
        }
        assert.equal(record.payloadTruncated, false, "Task readiness metadata was truncated");
        sample.ready = tab.url === "about:blank" && tab.status === "complete" && !tab.pendingUrl && target?.url === "about:blank";
        sample.completedAt = now();
      } catch (error) { sample.error = error.stack ?? String(error); sample.failedAt = now(); throw error; }
      if (sample.ready) break;
      await budget.run(() => sleep(Math.min(75, budget.remaining())), "task readiness sampling interval");
    } while (true);
    budget.remaining(); record.nativeReadyAt = now(); record.stage = "persist-ready";
    await budget.run(persist, "task gate ready evidence");
    record.ready = true; record.stage = "ready"; record.completedAt = now(); return record;
  } catch (error) {
    record.stage = "failed"; record.ready = false; record.error = error.stack ?? String(error); record.failedAt = now();
    // Keep failure in the shared report for the runner's existing cleanup
    // checkpoints. Never repeat a potentially still-pending evidence write.
    throw error;
  }
}

export function taskReadinessDiagnosticResult({ gate, inputResult }) {
  const gateComplete = gate?.ready === true && gate.stage === "ready" && !gate.error && !gate.persistenceFailures && !gate.overflow && !gate.payloadTruncated && gate.sampleCount > 0 && gate.lastSample?.ready === true && gate.completedAt < gate.deadline;
  const diagnosticCompleted = gateComplete && inputResult?.diagnosticCompleted === true;
  return { passed: false, diagnosticCompleted, gateComplete, exitCode: diagnosticCompleted ? 0 : 1 };
}

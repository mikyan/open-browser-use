import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { installChooserDiagnostic, chooserTraceComplete } from "./chooser-ready-diagnostic.mjs";

// Serialized into the isolated worker. These four reads have no dependent
// browser actions; a late result cannot initiate another request.
export async function goChooserNativeObservation(api, tabId) {
  let overflow = false;
  const scalar = value => {
    if (value === undefined || value === null) return null;
    if (typeof value === "boolean" || (typeof value === "number" && Number.isFinite(value))) return value;
    if (typeof value === "string") {
      if (value.length > 8192) { overflow = true; return value.slice(0, 8192); }
      return value;
    }
    overflow = true; return null;
  };
  const pick = (value, fields) => Object.fromEntries(fields.map(field => [field, scalar(value?.[field])]));
  const list = (values, fields) => {
    if (!Array.isArray(values)) throw new Error("Native metadata did not return an array");
    if (values.length > 64) overflow = true;
    return { total: values.length, entries: values.slice(0, 64).map(value => pick(value, fields)) };
  };
  const capture = async operation => { try { return { value: await operation() }; } catch (error) { return { error: String(error).slice(0, 2048) }; } };
  const windowFields = ["id", "type", "state", "focused", "left", "top", "width", "height"];
  const requestedAt = Date.now();
  const [tab, windows, currentWindow, frames] = await Promise.all([
    capture(async () => pick(await api.tabs.get(tabId), ["id", "windowId", "groupId", "active", "status", "url", "pendingUrl", "discarded", "frozen"])),
    capture(async () => list(await api.windows.getAll({ populate: false }), windowFields)),
    capture(async () => pick(await api.windows.getCurrent({ populate: false }), windowFields)),
    capture(async () => list(await api.webNavigation.getAllFrames({ tabId }), ["frameId", "parentFrameId", "processId", "documentId", "documentLifecycle", "url", "errorOccurred"]))
  ]);
  return { requestedAt, completedAt: Date.now(), tab, windows, currentWindow, frames, overflow };
}

function traceIdentity(trace, value) {
  return trace?.version === 1 && trace.kind === undefined && trace.tabId === value.tabId &&
    typeof trace.bootId === "string" && trace.bootId.length > 0 && trace.bootId === value.installed?.bootId &&
    trace.goChooserSetupId === value.setupId && Array.isArray(trace.records);
}

export function createGoChooserDiagnostic({ worker, readFocus }) {
  const records = [], errors = [], owned = new WeakMap();
  const ownerId = randomUUID(), read = expression => worker.evaluate(expression);
  const message = error => String(error).slice(0, 2048);
  const noteError = error => { if (errors.length < 32) errors.push(message(error)); };
  let closed = false;
  async function within(deadline, operation) {
    if (Date.now() >= deadline) throw new Error("Go chooser diagnostic budget expired before send");
    let timer;
    try {
      const result = await Promise.race([operation(), new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error("Go chooser diagnostic budget expired; read outcome unknown")), Math.max(1, deadline - Date.now()));
      })]);
      if (Date.now() >= deadline) throw new Error("Go chooser diagnostic settled after its original budget");
      return result;
    } finally { clearTimeout(timer); }
  }

  function snapshotExpression(value) {
    return `(()=>{const probe=globalThis.__obuChooserDiagnostic;if(!probe||probe.goChooserSetupId!==${JSON.stringify(value.setupId)})throw new Error('Go chooser diagnostic installation identity missing or changed');return{...probe.snapshot(),goChooserSetupId:probe.goChooserSetupId}})()`;
  }
  function restoreExpression(value, cleanup) {
    // A cleanup that overtakes a delayed install records this nonce as revoked.
    // The small tombstone remains for this worker lifetime, so a late evaluation
    // cannot install after cleanup even if its clock/deadline is still earlier.
    return `(()=>{const ownerId=${JSON.stringify(ownerId)},setupId=${JSON.stringify(value.setupId)};
      const states=globalThis.__obuGoChooserDiagnosticSetups??=new Map();
      const previous=states.get(setupId);if(previous&&previous.ownerId!==ownerId)throw new Error('Go chooser diagnostic cleanup owner changed');
      states.set(setupId,{ownerId,cancelled:true});
      const probe=globalThis.__obuChooserDiagnostic;
      if(!probe||probe.goChooserSetupId!==setupId){${cleanup ? "return{status:'no-owned-probe'}" : "throw new Error('Go chooser diagnostic installation lost or replaced')"};}
      const before=probe.snapshot();
      if(before.tabId!==${value.tabId}${value.installed ? `||before.bootId!==${JSON.stringify(value.installed.bootId)}` : ""})throw new Error('Go chooser diagnostic worker/tab identity changed before cleanup');
      const trace=probe.restore();if(trace.restored&&globalThis.__obuChooserDiagnostic===probe)delete globalThis.__obuChooserDiagnostic;
      return{...trace,goChooserSetupId:setupId,restoredBeforeFinish:before.restored};})()`;
  }

  return {
    records, errors,
    async start({ item }) {
      assert.equal(closed, false, "Go chooser diagnostic already cleaned up");
      assert.ok(item && Number.isSafeInteger(item.tabId) && item.tabId >= 0, "Go chooser diagnostic requires an exact tab");
      assert.equal(item.diagnostic, undefined, "Go chooser diagnostic already started for this item");
      assert.ok(records.length < 16, "Go chooser diagnostic record capacity reached");
      const value = item.diagnostic = { version: 1, mode: "go-chooser-ready-diagnostic", acceptancePassed: false,
        observationScope: "native-trace-and-browser-metadata", domObservation: "not-requested",
        key: item.key, variant: item.variant, tabId: item.tabId, setupId: randomUUID(), startedAt: Date.now(),
        failureRead: null, collectionComplete: false };
      owned.set(item, value); records.push(value);
      value.setupDeadline = value.startedAt + 1500;
      try {
        value.initialAttachmentRead = await within(value.setupDeadline, () => read(`(()=>{const all=globalThis.__integrationFrames;if(!Array.isArray(all))throw new Error('Initial native attachments unavailable');
          const entries=all.filter(entry=>entry.tabId===${value.tabId});let overflow=entries.length>64;
          const scalar=value=>{if(typeof value==='string'){if(value.length>8192){overflow=true;return value.slice(0,8192)}return value}if(value==null||typeof value==='number'||typeof value==='boolean')return value;overflow=true;return null};
          const bounded=entries.slice(0,64).map(entry=>({tabId:entry.tabId,source:{tabId:scalar(entry.source?.tabId),sessionId:scalar(entry.source?.sessionId)},sessionId:scalar(entry.sessionId),targetId:scalar(entry.targetId),type:scalar(entry.type),url:scalar(entry.url)}));
          return{total:entries.length,overflow,entries:bounded}})()`));
        assert.ok(Array.isArray(value.initialAttachmentRead?.entries) && value.initialAttachmentRead.overflow === false && value.initialAttachmentRead.total === value.initialAttachmentRead.entries.length, "Initial attachment observation incomplete");
        value.initialAttachments = value.initialAttachmentRead.entries;
        assert.equal(closed, false, "Go chooser diagnostic cleaned up during setup");
        value.installAttempted = true;
        value.installed = await within(value.setupDeadline, () => read(`(()=>{const ownerId=${JSON.stringify(ownerId)},setupId=${JSON.stringify(value.setupId)};
          if(Date.now()>=${value.setupDeadline})throw new Error('Go chooser diagnostic setup deadline expired in worker');
          const states=globalThis.__obuGoChooserDiagnosticSetups??=new Map();
          if(states.has(setupId))throw new Error('Go chooser diagnostic installation cancelled or already attempted');
          if(states.size>=64)throw new Error('Go chooser diagnostic installation capacity reached');
          states.set(setupId,{ownerId,cancelled:false});
          const snapshot=(${installChooserDiagnostic.toString()})(chrome,globalThis,${value.tabId});
          globalThis.__obuChooserDiagnostic.goChooserSetupId=setupId;
          return{...snapshot,goChooserSetupId:setupId};})()`));
        assert.ok(traceIdentity(value.installed, value) && value.installed.restored === false, "Go chooser diagnostic installation identity invalid");
        value.setupCompletedAt = Date.now();
      } catch (error) { value.setupError = message(error); noteError(error); throw error; }
    },
    async failure({ item }) {
      const value = owned.get(item);
      if (!value || value.failureRead) return;
      const requestedAt = Date.now(), deadline = requestedAt + 3000;
      const observation = value.failureRead = { requestedAt, deadline, budgetMs: 3000, errors: [],
        observationScope: value.observationScope, domObservation: value.domObservation,
        timing: "Once after the original failure and before remaining cleanup. Operation failures are observed before cancel; a cancel-only failure is observed after that failed cancellation. One separate total budget; no wait identity, SDK bootstrap, attachment or DOM request." };
      try {
        observation.trace = await within(deadline, () => read(snapshotExpression(value)));
        if (!traceIdentity(observation.trace, value) || observation.trace.restored !== false) throw new Error("Go chooser diagnostic worker/tab identity missing, changed or no longer recording");
        observation.nativeState = await within(deadline, () => read(`(${goChooserNativeObservation.toString()})(chrome,${value.tabId})`));
        observation.focus = await within(deadline, () => readFocus());
      } catch (error) { observation.errors.push({ kind: "diagnostic-read", error: message(error) }); noteError(error); }
      observation.completedAt = Date.now();
      const state = observation.nativeState;
      observation.complete = observation.completedAt < deadline && observation.errors.length === 0 && state?.overflow === false &&
        ["tab", "windows", "currentWindow", "frames"].every(key => state?.[key] && !state[key].error) && state.tab.value?.id === value.tabId &&
        !!observation.focus && typeof observation.focus === "object" && !Array.isArray(observation.focus);
    },
    async finish({ item }) {
      const value = owned.get(item);
      if (!value || value.finishStartedAt !== undefined) return;
      value.finishStartedAt = Date.now();
      try {
        if (!value.installAttempted) throw new Error("Go chooser diagnostic was not installed");
        value.trace = await within(value.finishStartedAt + 1500, () => read(restoreExpression(value, false)));
        value.traceComplete = traceIdentity(value.trace, value) && value.trace.restoredBeforeFinish === false && value.trace.restored === true && chooserTraceComplete(value.trace);
        value.observationComplete = !value.failureRead || value.failureRead.complete === true;
        value.collectionComplete = !value.setupError && value.traceComplete && value.observationComplete;
      } catch (error) { value.collectionComplete = false; value.error = message(error); noteError(error); }
      value.completedAt = Date.now();
    },
    async cleanup() {
      if (closed) return;
      closed = true;
      // One total cleanup budget, not 1.5 seconds per old variant. Never clears
      // a foreign controller, even when this installation ACK was lost.
      const deadline = Date.now() + 1500;
      for (const value of records.filter(record => record.installAttempted)) {
        value.cleanup = { requestedAt: Date.now() };
        try {
          value.cleanup.result = await within(deadline, () => read(restoreExpression(value, true)));
          value.cleanup.complete = value.cleanup.result.status === "no-owned-probe" || value.cleanup.result.restored === true;
          if (!value.cleanup.complete) throw new Error("Go chooser diagnostic native wrapper cleanup incomplete");
        } catch (error) { value.cleanup.complete = false; value.cleanup.error = message(error); value.collectionComplete = false; noteError(error); }
        value.cleanup.completedAt = Date.now();
      }
    }
  };
}

import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { installChooserDiagnostic, chooserChildTarget, chooserTraceComplete } from "./chooser-ready-diagnostic.mjs";

export const downloadDiagnosticCases = ["js-page-download-ready-two-connections", "js-raw-navigation-before-engine"];
export function downloadDiagnosticEnabled(env) {
  const flag = env.OBU_TEST_DOWNLOAD_DIAGNOSTIC;
  assert.ok(flag === undefined || flag === "1", "OBU_TEST_DOWNLOAD_DIAGNOSTIC must be 1 or unset");
  if (flag !== "1") return false;
  for (const name of ["OBU_TEST_CASES", "OBU_TEST_CHOOSER_DIAGNOSTIC", "OBU_TEST_MCP_BINDING", "OBU_TEST_SNAPSHOT_GEOMETRY", "OBU_TEST_GEOMETRY_DPR", "OBU_TEST_BACKGROUND_PARALLEL", "OBU_TEST_MEMORY_CLIPBOARD"])
    assert.equal(env[name], undefined, `Download diagnostic cannot be combined with ${name}`);
  return true;
}

// This observation runs once, after a failure. It never invokes an action or
// installs a listener. All rectangles/center hits describe this later document.
export function downloadDocumentObservation(point) {
  let truncated = false;
  const text = (value, maximum = 8192) => {
    if (typeof value !== "string") return null;
    if (value.length > maximum) { truncated = true; return value.slice(0, maximum); }
    return value;
  };
  const rect = element => {
    if (!element) return null;
    const value = element.getBoundingClientRect();
    return { x: value.x, y: value.y, width: value.width, height: value.height };
  };
  const describe = element => element ? { tag: text(element.tagName, 128), id: text(element.id, 256), type: text(element.getAttribute("type"), 128) } : null;
  const evidence = globalThis.downloadEvidence;
  const list = (value, fields) => {
    if (!Array.isArray(value)) return null;
    if (value.length > 16) truncated = true;
    return value.slice(0, 16).map(entry => Object.fromEntries(fields.map(field => [field, ["boolean", "number"].includes(typeof entry?.[field]) ? entry[field] : null])));
  };
  const link = document.querySelector("#download"), add = document.querySelector("#add-frame"), box = rect(link);
  const center = box && { x: box.x + box.width / 2, y: box.y + box.height / 2 };
  const frames = [...document.querySelectorAll("iframe")];
  if (frames.length > 16) truncated = true;
  const result = {
    at: Date.now(), href: text(location.href), readyState: document.readyState, hasFocus: document.hasFocus(), visibility: document.visibilityState,
    viewport: { width: innerWidth, height: innerHeight, scrollX, scrollY, devicePixelRatio },
    downloadEvidence: evidence && typeof evidence === "object" ? {
      documentToken: text(evidence.documentToken, 128), clicks: list(evidence.clicks, ["trusted", "sequence"]), frameAdds: list(evidence.frameAdds, ["trusted"])
    } : null,
    activeElement: describe(document.activeElement),
    link: link ? { node: describe(link), rect: box, href: text(link.href), hrefAttribute: text(link.getAttribute("href")), download: text(link.getAttribute("download"), 256) } : null,
    addFrame: add ? { node: describe(add), rect: rect(add), disabled: add.disabled } : null,
    frames: frames.slice(0, 16).map(frame => ({ node: describe(frame), src: text(frame.src), rect: rect(frame) })),
    nativeRootPoint: point, nativeRootHit: point ? describe(document.elementFromPoint(point.x, point.y)) : null,
    laterLinkCenter: center, laterLinkCenterHit: center ? describe(document.elementFromPoint(center.x, center.y)) : null,
    boundary: "Current DOM after the failure. The last observed root press may belong to Add frame rather than the download link. Child center is later child-viewport evidence, never a projection of the native root point."
  };
  return { ...result, truncated };
}

// Four read-only native requests begin together. Their results are projected to
// finite fields; a delayed result cannot initiate a follow-up browser request.
export async function downloadNativeObservation(api, tabId) {
  let overflow = false;
  const text = value => {
    if (typeof value !== "string") return value ?? null;
    if (value.length > 8192) { overflow = true; return value.slice(0, 8192); }
    return value;
  };
  const pick = (value, fields) => Object.fromEntries(fields.map(field => [field, text(value?.[field])]));
  const array = (values, fields) => {
    if (!Array.isArray(values)) throw new Error("Native metadata did not return an array");
    if (values.length > 64) overflow = true;
    return { total: values.length, entries: values.slice(0, 64).map(value => pick(value, fields)) };
  };
  const windowFields = ["id", "type", "state", "focused", "left", "top", "width", "height"];
  const capture = async operation => { try { return { value: await operation() }; } catch (error) { return { error: String(error).slice(0, 2048) }; } };
  const requestedAt = Date.now();
  const [tab, windows, currentWindow, frames] = await Promise.all([
    capture(async () => pick(await api.tabs.get(tabId), ["id", "windowId", "groupId", "active", "status", "url", "pendingUrl", "discarded", "frozen"])),
    capture(async () => array(await api.windows.getAll({ populate: false }), windowFields)),
    capture(async () => pick(await api.windows.getCurrent({ populate: false }), windowFields)),
    capture(async () => array(await api.webNavigation.getAllFrames({ tabId }), ["frameId", "parentFrameId", "processId", "documentId", "documentLifecycle", "url", "errorOccurred"]))
  ]);
  return { requestedAt, completedAt: Date.now(), tab, windows, currentWindow, frames, overflow };
}

function traceIdentity(trace, value) {
  return trace?.version === 1 && trace.kind === "download" && trace.tabId === value.tabId &&
    typeof trace.bootId === "string" && trace.bootId.length > 0 && trace.bootId === value.installed?.bootId && Array.isArray(trace.records);
}
function documentComplete(record) {
  const result = record.result?.result?.value, evidence = result?.downloadEvidence;
  return !record.error && !record.result?.exceptionDetails && result?.truncated === false &&
    typeof result.href === "string" && typeof result.readyState === "string" &&
    typeof evidence?.documentToken === "string" && evidence.documentToken.length > 0 &&
    Array.isArray(evidence.clicks) && Array.isArray(evidence.frameAdds);
}
function exactChild(trace, initial) {
  const child = chooserChildTarget(trace, initial);
  if (child.target && (typeof child.target.sessionId !== "string" || !child.target.sessionId ||
      typeof child.candidates[0]?.targetId !== "string" || !child.candidates[0].targetId))
    return { ...child, status: "unknown-invalid-observed-identity", target: null };
  return child;
}

export function createDownloadDiagnostic({ worker, readFocus }) {
  const errors = [], read = expression => worker.evaluate(expression);
  const noteError = error => { if (errors.length < 32) errors.push(String(error).slice(0, 2048)); };
  const traceExpression = "globalThis.__obuDownloadDiagnostic?.snapshot()";
  async function within(deadline, operation) {
    const remaining = deadline - Date.now();
    if (remaining <= 0) throw new Error("Download diagnostic budget expired before send");
    let timer;
    try {
      const result = await Promise.race([operation(remaining), new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error("Download diagnostic budget expired; read outcome unknown")), remaining);
      })]);
      if (Date.now() >= deadline) throw new Error("Download diagnostic settled after its original budget");
      return result;
    } finally { clearTimeout(timer); }
  }
  return {
    errors,
    async start({ owner, item }) {
      assert.equal(item.diagnostic, undefined, "Download diagnostic already started for this variant");
      const scope = Object.freeze({ session_id: owner.client.sessionId, turn_id: owner.client.turnId, control_epoch: owner.client.controlEpoch });
      const value = item.diagnostic = { version: 1, mode: "download-ready-diagnostic", acceptancePassed: false,
        scope, tabId: item.tabId, setupId: randomUUID(), startedAt: Date.now(), failureRead: null, collectionComplete: false };
      value.setupDeadline = value.startedAt + 1500;
      try {
        assert.ok(Number.isSafeInteger(item.tabId) && item.tabId >= 0);
        assert.ok(typeof scope.session_id === "string" && scope.session_id && typeof scope.turn_id === "string" && scope.turn_id && Number.isSafeInteger(scope.control_epoch) && scope.control_epoch > 0);
        value.initialAttachmentRead = await within(value.setupDeadline, () => read(`(()=>{const entries=globalThis.__integrationFrames.filter(entry=>entry.tabId===${item.tabId});return{total:entries.length,overflow:entries.length>64,entries:entries.slice(0,64)}})()`));
        assert.ok(Array.isArray(value.initialAttachmentRead?.entries) && value.initialAttachmentRead.overflow === false && value.initialAttachmentRead.total === value.initialAttachmentRead.entries.length, "Initial attachment observation incomplete");
        value.initialAttachments = value.initialAttachmentRead.entries;
        value.installAttempted = true;
        value.installed = await within(value.setupDeadline, () => read(`(()=>{if(Date.now()>=${value.setupDeadline})throw new Error('Download diagnostic setup deadline expired in worker');const snapshot=(${installChooserDiagnostic.toString()})(chrome,globalThis,${item.tabId},{kind:'download'});globalThis.__obuDownloadDiagnostic.downloadDiagnosticSetupId=${JSON.stringify(value.setupId)};return snapshot})()`));
        assert.ok(traceIdentity(value.installed, value) && value.installed.restored === false, "Download diagnostic installation identity invalid");
        value.setupCompletedAt = Date.now();
      } catch (error) { value.setupError = String(error).slice(0, 2048); noteError(error); throw error; }
    },
    async failure({ owner, item }) {
      const value = item.diagnostic;
      if (!value || value.failureRead) return;
      const requestedAt = Date.now(), deadline = requestedAt + 3000;
      const observation = value.failureRead = { requestedAt, deadline, budgetMs: 3000, reads: [], errors: [],
        timing: "After original failure, before original cancel/finalize. One separate budget for trace/native/focus/DOM; the expired download wait is never resumed." };
      try {
        observation.trace = await within(deadline, () => read(traceExpression));
        if (!traceIdentity(observation.trace, value) || observation.trace.restored !== false) throw new Error("Download diagnostic worker/tab identity missing, changed or no longer recording");
        observation.nativeState = await within(deadline, () => read(`(${downloadNativeObservation.toString()})(chrome,${value.tabId})`));
        try { observation.focus = await within(deadline, () => readFocus()); }
        catch (error) { observation.errors.push({ kind: "focus-read", error: String(error).slice(0, 2048) }); }
        observation.child = exactChild(observation.trace, value.initialAttachments);
        const lastPress = observation.trace.records.filter(record => record.kind === "start" && record.method === "Input.dispatchMouseEvent" && record.params?.type === "mousePressed" && record.target?.tabId === value.tabId && record.target.sessionId === undefined).at(-1);
        const point = Number.isFinite(lastPress?.params?.x) && Number.isFinite(lastPress?.params?.y) ? { x: lastPress.params.x, y: lastPress.params.y, commandSequence: lastPress.sequence, callId: lastPress.callId } : null;
        const targets = [{ tabId: value.tabId }, ...(item.variant === "root" || !observation.child.target ? [] : [observation.child.target])];
        for (const target of targets) {
          const record = { target, requestedAt: Date.now() }; observation.reads.push(record);
          if (deadline <= Date.now()) { record.skipped = true; record.error = "Download DOM-read budget expired before send"; continue; }
          try {
            record.result = await within(deadline, remaining => owner.client.request("executeCdp", { ...value.scope, target, method: "Runtime.evaluate", commandParams: {
              expression: `(${downloadDocumentObservation.toString()})(${JSON.stringify(target.sessionId ? null : point)})`, returnByValue: true, awaitPromise: false
            }, timeoutMs: remaining }, { timeoutMs: remaining }));
            record.completedAt = Date.now();
          } catch (error) { record.error = String(error).slice(0, 2048); record.failedAt = Date.now(); }
        }
      } catch (error) { observation.errors.push({ kind: "diagnostic-read", error: String(error).slice(0, 2048) }); }
      observation.completedAt = Date.now();
      const state = observation.nativeState;
      observation.complete = observation.completedAt < deadline && observation.errors.length === 0 && state?.overflow === false &&
        ["tab", "windows", "currentWindow", "frames"].every(key => state?.[key] && !state[key].error) && state.tab.value?.id === value.tabId &&
        !!observation.focus && observation.reads.length === (item.variant === "root" ? 1 : 2) && observation.reads.every(documentComplete);
    },
    async finish({ item }) {
      const value = item.diagnostic;
      if (!value || value.finishStartedAt !== undefined) return;
      value.finishStartedAt = Date.now();
      try {
        if (!value.installAttempted) throw new Error("Download diagnostic was not installed");
        value.trace = await within(value.finishStartedAt + 1500, () => read(`(()=>{const probe=globalThis.__obuDownloadDiagnostic;if(!probe)throw new Error('Download diagnostic lost');if(probe.downloadDiagnosticSetupId!==${JSON.stringify(value.setupId)})throw new Error('Download diagnostic setup identity changed before cleanup');const before=probe.snapshot();if(before.kind!=='download'||before.tabId!==${value.tabId}${value.installed ? `||before.bootId!==${JSON.stringify(value.installed.bootId)}` : ""})throw new Error('Download diagnostic identity changed before cleanup');const trace=probe.restore();if(trace.restored)delete globalThis.__obuDownloadDiagnostic;return{...trace,restoredBeforeFinish:before.restored}})()`));
        value.traceComplete = traceIdentity(value.trace, value) && value.trace.restoredBeforeFinish === false && value.trace.restored === true && chooserTraceComplete(value.trace);
        value.observationComplete = !value.failureRead || value.failureRead.complete === true;
        value.collectionComplete = !value.setupError && value.traceComplete && value.observationComplete;
      } catch (error) { value.collectionComplete = false; value.error = String(error).slice(0, 2048); noteError(error); }
      value.completedAt = Date.now();
    }
  };
}

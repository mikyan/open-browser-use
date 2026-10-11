import assert from "node:assert/strict";

// Serialized only after a failed fixture operation. No listeners, writes,
// focus changes, file operations, or CDP attachment are installed here.
export function chooserFailureDocument(expectedURLs, deadline, fixtureKind = "chooser") {
  if (!Number.isFinite(deadline) || Date.now() >= deadline) return { observed: false, reason: "observation deadline expired" };
  if (!["chooser", "directory"].includes(fixtureKind)) return { observed: false, reason: "unknown fixture kind" };
  const href = location.href;
  if (!expectedURLs.includes(href)) return { observed: false, reason: "document URL changed" };
  let truncated = false;
  const text = value => {
    if (typeof value !== "string") return null;
    if (value.length > 2048) { truncated = true; return value.slice(0, 2048); }
    return value;
  };
  const node = element => element ? { tag: element.tagName, id: text(element.id), type: text(element.getAttribute("type")) } : null;
  const rect = element => {
    if (!element) return null;
    const { x, y, width, height } = element.getBoundingClientRect();
    return { x, y, width, height };
  };
  const evidence = fixtureKind === "directory" ? globalThis.directoryEvidence : globalThis.chooserEvidence;
  const list = (items, project) => {
    if (!Array.isArray(items)) return null;
    if (items.length > 128) truncated = true;
    return items.slice(0, 128).map(project);
  };
  const events = (items, changes = false) => {
    return list(items, item => ({ trusted: typeof item?.trusted === "boolean" ? item.trusted : null,
      ...(changes ? { count: Number.isSafeInteger(item?.count) ? item.count : null } : {}) }));
  };
  const bool = value => typeof value === "boolean" ? value : null;
  const evidenceValue = evidence && typeof evidence === "object" ? { documentToken: text(evidence.documentToken),
    clicks: events(evidence.clicks), frameAdds: events(evidence.frameAdds),
    ...(fixtureKind === "directory" ? { inputToken: text(evidence.inputToken), errors: list(evidence.errors, text),
      events: list(evidence.events, item => ({ event: text(item?.event), trusted: bool(item?.trusted),
        sequence: Number.isSafeInteger(item?.sequence) ? item.sequence : null,
        eventIndex: Number.isSafeInteger(item?.eventIndex) ? item.eventIndex : null,
        fileCount: Array.isArray(item?.files) ? item.files.length : null,
        input: item?.input ? { id: text(item.input.id), type: text(item.input.type), webkitdirectory: bool(item.input.webkitdirectory),
          multiple: bool(item.input.multiple), connected: bool(item.input.connected), originalNode: bool(item.input.originalNode) } : null }))
    } : { changes: events(evidence.changes, true) }) } : null;
  const input = document.querySelector("#upload"), frames = [...document.querySelectorAll("iframe")];
  if (frames.length > 16) truncated = true;
  const value = { observed: true, at: Date.now(), href, readyState: document.readyState, visibility: document.visibilityState,
    hasFocus: document.hasFocus(), viewport: { width: innerWidth, height: innerHeight, scrollX, scrollY, devicePixelRatio },
    [fixtureKind === "directory" ? "directoryEvidence" : "chooserEvidence"]: evidenceValue,
    activeElement: node(document.activeElement), input: input ? { node: node(input), connected: input.isConnected,
      disabled: input.disabled, files: input.files?.length ?? null, rect: rect(input),
      ...(fixtureKind === "directory" ? { webkitdirectory: bool(input.webkitdirectory), multiple: bool(input.multiple) } : {}) } : null,
    frames: frames.slice(0, 16).map(frame => ({ node: node(frame), src: text(frame.src), rect: rect(frame) })) };
  return { ...value, truncated };
}

function expectedPages(fixtureURL, item, fixtureKind) {
  assert.ok(["chooser", "directory"].includes(fixtureKind), "Unknown fixture kind");
  assert.ok(Number.isSafeInteger(item.tabId) && item.tabId >= 0, "Missing original chooser tab ID");
  assert.match(item.key, /^[a-z0-9-]{1,100}$/);
  assert.ok(["root", "oopif", "dynamic-oopif"].includes(item.variant), "Invalid chooser variant");
  const base = new URL(fixtureURL);
  assert.equal(base.protocol, "http:"); assert.ok(["127.0.0.1", "localhost"].includes(base.hostname), "Loopback fixture required");
  assert.equal(base.username, ""); assert.equal(base.password, "");
  const route = fixtureKind === "directory" ? "/directory-upload/" : "chooser-waits/";
  const root = new URL(route + "page", base);
  root.search = new URLSearchParams({ key: item.key, variant: item.variant }).toString(); root.hash = "";
  const child = new URL(root); child.hostname = "localhost"; child.pathname = fixtureKind === "directory" ? "/directory-upload/frame" : "/chooser-waits/frame";
  return { root: root.href, child: child.href };
}

function selectDocuments(metadata, item, expected) {
  assert.equal(metadata.tab?.id, item.tabId, "Native tab identity changed");
  assert.equal(metadata.tab.url, expected.root, "Original fixture root URL is no longer current");
  assert.ok(!metadata.tab.pendingUrl || metadata.tab.pendingUrl === expected.root, "Root navigation is pending");
  assert.ok(Array.isArray(metadata.frames) && metadata.frames.length <= 32 && metadata.frameCount === metadata.frames.length, "Native frame metadata truncated/missing");
  const roots = metadata.frames.filter(frame => frame.frameId === 0 && frame.parentFrameId === -1 && frame.url === expected.root);
  assert.equal(roots.length, 1, "Expected one exact current root frame");
  const selected = [{ ...roots[0], expectedURL: expected.root }];
  if (item.variant !== "root") {
    const children = metadata.frames.filter(frame => frame.parentFrameId === 0 && frame.frameId !== 0 && frame.url === expected.child);
    assert.ok(children.length <= 1, "Ambiguous current chooser child");
    if (children.length) selected.push({ ...children[0], expectedURL: expected.child });
  }
  const ids = new Set();
  for (const frame of selected) {
    assert.ok(Number.isSafeInteger(frame.frameId) && frame.frameId >= 0, "Native frame ID missing");
    assert.ok(typeof frame.documentId === "string" && frame.documentId.length > 0 && frame.documentId.length <= 128, "Native document identity missing");
    assert.equal(frame.documentLifecycle, "active", "Fixture document is not active");
    assert.equal(frame.errorOccurred, false, "Fixture frame navigation failed");
    assert.ok(!ids.has(frame.documentId), "Duplicate document identity"); ids.add(frame.documentId);
  }
  return selected;
}

// This helper never determines whether the original case passed. Its one budget
// starts after failure; expiry cannot start another read or replace that error.
export async function observeChooserFailure({ worker, item, fixtureURL, budgetMs = 3000, now = () => Date.now(),
  setTimer = setTimeout, clearTimer = clearTimeout, readMetadata, readDocuments,
  fixtureKind = "chooser", timing = "After original failure, before waiter cancellation/finalization" }) {
  if (item.failureObservation) return item.failureObservation;
  const requestedAt = now(), report = item.failureObservation = { version: 1, tabId: item.tabId, key: item.key, variant: item.variant,
    fixtureKind,
    requestedAt, deadline: requestedAt + budgetMs, budgetMs, timing, complete: false, reads: [], errors: [],
    boundary: "Test-only read of the current fixture documents after failure. Native documentIds bind metadata to this later DOM read, not to the click-time document. No production authority is inferred from URL; no input, attachment, listener, navigation, retry, or original deadline extension." };
  async function within(stage, operation) {
    const remaining = report.deadline - now();
    if (remaining <= 0) throw new Error("Failure observation budget expired before read");
    const read = { stage, requestedAt: now() }; report.reads.push(read); let timer;
    try {
      const result = await Promise.race([operation(), new Promise((_, reject) => {
        timer = setTimer(() => reject(new Error("Failure observation budget expired; read outcome unknown")), remaining);
      })]);
      if (now() >= report.deadline) throw new Error("Failure observation settled after its original budget");
      read.completedAt = now(); return result;
    } catch (error) { read.error = String(error); throw error; }
    finally { clearTimer(timer); }
  }
  try {
    assert.ok(Number.isInteger(budgetMs) && budgetMs > 0 && budgetMs <= 3000, "Invalid failure observation budget");
    report.expected = expectedPages(fixtureURL, item, fixtureKind);
    readMetadata ??= () => worker.evaluate(`(async()=>{const read=async operation=>{if(Date.now()>=${report.deadline})throw new Error('Failure observation deadline expired before native read');return operation()};const [tab,frames]=await Promise.all([read(()=>chrome.tabs.get(${item.tabId})),read(()=>chrome.webNavigation.getAllFrames({tabId:${item.tabId}}))]);return{tab:{id:tab.id,windowId:tab.windowId,url:tab.url,pendingUrl:tab.pendingUrl,active:tab.active,status:tab.status},frameCount:frames?.length,frames:frames?.slice(0,32)}})()`);
    report.metadata = await within("native-metadata", readMetadata);
    report.documents = selectDocuments(report.metadata, item, report.expected);
    report.childStatus = item.variant === "root" ? "not-required" : report.documents.length === 2 ? "unique-current-child" : "missing-current-child";
    const documentIds = report.documents.map(frame => frame.documentId), expectedURLs = report.documents.map(frame => frame.expectedURL);
    readDocuments ??= () => worker.evaluate(`(()=>{if(Date.now()>=${report.deadline})throw new Error('Failure observation deadline expired before native read');return chrome.scripting.executeScript({target:{tabId:${item.tabId},documentIds:${JSON.stringify(documentIds)}},world:"MAIN",func:${chooserFailureDocument.toString()},args:[${JSON.stringify(expectedURLs)},${report.deadline},${JSON.stringify(fixtureKind)}]})})()`);
    report.results = await within("document-observation", () => readDocuments({ tabId: item.tabId, documentIds, expectedURLs }));
    assert.ok(Array.isArray(report.results) && report.results.length === report.documents.length, "Document observation result count differs");
    const seen = new Set();
    for (const result of report.results) {
      const frame = report.documents.find(frame => frame.documentId === result.documentId && frame.frameId === result.frameId);
      assert.ok(frame && !seen.has(result.documentId), "Native script result has a different/duplicate document identity"); seen.add(result.documentId);
      assert.equal(result.result?.observed, true, "Document observation refused: URL changed or deadline expired");
      assert.equal(result.result.href, frame.expectedURL, "Observed fixture URL differs");
      assert.equal(result.result.truncated, false, "Fixture observation truncated");
      const evidence = result.result[fixtureKind === "directory" ? "directoryEvidence" : "chooserEvidence"];
      assert.ok(evidence && typeof evidence.documentToken === "string" && evidence.documentToken.length > 0, "Fixture document token missing");
      for (const name of ["clicks", "frameAdds", ...(fixtureKind === "directory" ? ["events", "errors"] : ["changes"])])
        assert.ok(Array.isArray(evidence[name]), "Fixture event evidence missing");
      if (fixtureKind === "directory") {
        assert.ok(typeof evidence.inputToken === "string" && evidence.inputToken.length > 0, "Fixture input token missing");
        if (item.inputToken && (item.variant === "root" || frame.frameId !== 0)) {
          report.priorInputTokenMatches = evidence.inputToken === item.inputToken;
          report.inputStatus = report.priorInputTokenMatches ? "matches-prior-fixture-token" : "different-input-token";
        }
      }
      if (item.documentToken && (item.variant === "root" || frame.frameId !== 0)) {
        report.priorDocumentTokenMatches = evidence.documentToken === item.documentToken;
        report.documentStatus = report.priorDocumentTokenMatches ? "matches-prior-fixture-token" : "different-document";
      }
    }
    report.complete = report.childStatus !== "missing-current-child" && report.priorDocumentTokenMatches !== false && report.priorInputTokenMatches !== false;
  } catch (error) { report.errors.push(String(error)); }
  report.completedAt = now(); return report;
}

// Complete each existing cleanup once and persist its outcome. A failed cleanup
// must neither skip closing the other connection nor replace the task's error.
export async function finishChooserCase({ detail, originalError, cleanup, save, reportErrors = value => console.error("Chooser cleanup errors", value) }) {
  const errors = []; let firstError;
  const remember = (stage, error) => {
    firstError ??= error;
    errors.push({ stage, error: error?.stack ?? String(error) });
    detail.cleanupErrors = errors;
  };
  for (const step of cleanup) {
    try { await step.run(); } catch (error) { remember(step.name, error); }
  }
  try { await save(detail); } catch (error) { remember("persist", error); }
  if (errors.length) {
    // The log still retains the evidence if writing the artifact itself failed.
    try { reportErrors(errors); } catch { /* Logging cannot suppress cleanup/original failure. */ }
    const retainedError = originalError ?? firstError;
    try { retainedError.chooserCleanupErrors = errors; } catch { /* Frozen errors retain their original identity; detail/log already hold metadata. */ }
    if (!originalError) throw firstError;
  }
}

import assert from "node:assert/strict";

export const browserRestartCases = Object.freeze([
  "browser-restart-unpaused", "browser-restart-paused", "same-browser-session-state-loss", "worker-input-state-loss",
  "extension-reload-unpaused", "extension-reload-paused", "extension-reload-held-unwitnessed", "extension-reload-held-witnessed"
]);

export function allBrowserRestartCasesPassed(records) {
  return records.length === browserRestartCases.length &&
    browserRestartCases.every(name => records.filter(record => record.name === name && record.passed === true).length === 1);
}

export function assertHeldNativeInput(state, previous) {
  assert.equal(typeof state.documentId, "string");
  assert.equal(typeof state.documentToken, "string");
  assert.ok(Array.isArray(state.inputEvents));
  const down = state.inputEvents.filter(event => event.type === "pointerdown" && event.target === "held");
  assert.equal(down.length, 1, "The synthetic page did not observe exactly one held pointer press");
  assert.equal(down[0].trusted, true); assert.equal(down[0].buttons, 1);
  assert.ok(state.inputEvents.some(event => event.type === "keydown" && event.key === "Shift" && event.trusted === true), "No trusted Shift keydown reached the original page");
  assert.equal(state.heldCapture, true, "The original page no longer holds pointer capture");
  assert.equal(state.inputEvents.some(event => event.type === "pointerup" || event.type === "lostpointercapture" || (event.type === "keyup" && event.key === "Shift")), false, "A native release was observed before the unknown-input recovery check");
  if (previous) {
    assert.equal(state.documentId, previous.documentId, "Input observation changed the original document");
    assert.equal(state.documentToken, previous.documentToken);
    assert.deepEqual(state.inputEvents.slice(0, previous.inputEvents.length), previous.inputEvents, "Native input evidence was reset or changed across worker restart");
  }
}

export function assertUnconfirmedInputBlocked(status) {
  assert.equal(status.state, "error", "Unknown input recovery must remain Failed until positive target destruction");
  assert.equal(status.inputBlocked, true);
  assert.equal(status.cleanupComplete, false, "An empty replacement tracker is not input-release evidence");
  assert.match(status.error ?? "", /OBU_INPUT_RELEASE_UNCONFIRMED/);
}

export function assertSamePopupDocument(original, contexts) {
  assert.equal(original?.contextType, "POPUP");
  for (const key of ["contextId", "documentId", "documentUrl"]) assert.ok(typeof original[key] === "string" && original[key].length > 0);
  assert.ok(Array.isArray(contexts)); assert.equal(contexts.length, 1, "The original control popup is no longer uniquely live");
  for (const key of ["contextType", "contextId", "documentId", "documentUrl", "tabId"]) {
    assert.equal(contexts[0][key], original[key], `Control popup ${key} changed during recovery`);
  }
}

export function popupUIReflectsStatus(status, ui) {
  const expected = {
    error: ["Failed", "Retry pause"],
    paused: ["Paused", "Resume control"],
    running: ["Running", "Pause all agents"]
  }[status?.state];
  return Boolean(expected && (status.state !== "paused" || status.cleanupComplete === true) &&
    ui?.state === status.state && ui.label === expected[0] && ui.buttonText === expected[1] &&
    ui.buttonDisabled === false);
}

export function assertNoNewFocusEvents(original, current) {
  assert.equal(original?.ready, true); assert.equal(current?.ready, true);
  assert.equal(original.overflow, false); assert.equal(current.overflow, false);
  assert.ok(typeof original.identity === "string" && original.identity.length > 0);
  assert.equal(current.identity, original.identity, "The continuous observer was replaced during popup recovery");
  assert.ok(Array.isArray(original.events)); assert.ok(Array.isArray(current.events));
  assert.deepEqual(current.events, original.events, "Popup recovery caused activation/focus events after its one allowed opening interval");
}

export function assertBrowserReplacement(previous, next) {
  assert.notEqual(next.pid, previous.pid, "Browser process was not replaced");
  assert.notEqual(next.browserId, previous.browserId, "Browser-level CDP identity was not replaced");
  assert.notEqual(next.workerTarget, previous.workerTarget, "Extension worker target was not replaced");
  assert.equal(next.profile, previous.profile, "Restart changed the tested profile");
  assert.equal(next.binarySha256, previous.binarySha256, "Restart changed the browser binary");
  assert.deepEqual(next.args, previous.args, "Restart changed the startup policy");
  assert.equal(previous.args.filter(argument => argument === "--restore-last-session").length, 1, "Same-profile restart requires one explicit restoration flag in every generation");
  assert.equal(next.extensionInstanceId, previous.extensionInstanceId, "Restart changed the installed extension instance");
  assert.notEqual(next.host.pid, previous.host.pid, "Browser restart reused the old host process");
  assert.notEqual(next.host.endpoint, previous.host.endpoint, "Browser restart reused the old native endpoint");
  assert.ok(Number.isFinite(previous.exitedAt) && previous.exitedAt <= next.startedAt, "Replacement started before the old browser exited");
}

export function assertIndependentFocusSegments(segments) {
  const identities = new Set();
  for (const segment of segments) {
    assert.equal(segment.finalValidation, "passed", "Browser generation has no validated final focus snapshot");
    assert.ok(segment.lastAccepted?.identity, "Browser generation has no observer identity");
    assert.ok(!identities.has(segment.lastAccepted.identity), "Different browser processes reused an observer identity");
    identities.add(segment.lastAccepted.identity);
    assert.ok(segment.coverageStartedAt <= segment.coverageEndedAt);
  }
}

export function assertNoRestoredOwnership(tabs, restored, label) {
  assert.ok(Array.isArray(tabs), `${label}: getTabs returned an invalid list`);
  const expected = new Set(restored.map(tab => tab.id));
  assert.equal(tabs.some(tab => expected.has(tab.id)), false, `${label}: persisted numeric group/tab identifiers authorized restored pages`);
}

export function assertRestoredFixtureDocument(tab, expectedURL, results) {
  assert.equal(tab.url, expectedURL);
  assert.equal(tab.status, "complete", "Restored URL metadata is not a loaded document");
  assert.equal(tab.discarded, false);
  assert.ok(Array.isArray(results)); assert.equal(results.length, 1);
  assert.equal(results[0].frameId, 0);
  assert.equal(typeof results[0].documentId, "string"); assert.ok(results[0].documentId.length > 0);
  assert.equal(results[0].result?.url, expectedURL, "Restored tab has not committed the expected HTTP document");
  assert.equal(results[0].result?.readyState, "complete");
  assert.equal(typeof results[0].result?.documentToken, "string"); assert.ok(results[0].result.documentToken.length > 0);
  assert.equal(results[0].result?.hasFixture, true);
}

export function assertRestoredTabPreserved(before, after) {
  const identity = value => {
    assert.ok(value?.tab, "Original restored tab disappeared");
    const { id, url, windowId, groupId } = value.tab;
    assert.ok(Number.isSafeInteger(id) && Number.isSafeInteger(windowId) && Number.isSafeInteger(groupId) && groupId >= 0);
    assert.equal(typeof url, "string");
    assert.ok(value.group, "Original restored tab group disappeared");
    assert.equal(value.group.id, groupId); assert.equal(value.group.windowId, windowId);
    return { id, url, windowId, groupId, group: { id: value.group.id, windowId: value.group.windowId, title: value.group.title, color: value.group.color } };
  };
  assert.deepEqual(identity(after), identity(before), "Cleanup or denied input changed an unowned restored tab/group identity");
}

export function restartFixtureHTML(url) {
  const marker = url.searchParams.get("marker") ?? "sentinel";
  return `<!doctype html><meta charset="utf-8"><title>Browser lifecycle ${marker.replaceAll(/[<>"&]/g, "")}</title>
    <style>body{font:18px sans-serif;margin:40px}input,button{padding:12px;margin:20px}</style>
    <h1>Same-profile lifecycle fixture</h1><label>Name<input id="name"></label><button id="action">Explicit action</button><button id="held">Hold pointer</button>
    <script>globalThis.documentToken=crypto.randomUUID();globalThis.clicks=[];globalThis.lateClicks=0;globalThis.inputEvents=[];
      for(const type of ['pointerdown','pointerup','pointermove','gotpointercapture','lostpointercapture','click','keydown','keyup'])document.addEventListener(type,event=>{
        if(inputEvents.length>=500)throw new Error('Synthetic input journal overflow');
        inputEvents.push({type,trusted:event.isTrusted,buttons:event.buttons??null,key:event.key??null,pointerId:event.pointerId??null,target:event.target.id,shiftKey:event.shiftKey??null});
        if(type==='pointerdown'&&event.target.id==='held')event.target.setPointerCapture(event.pointerId);
      });
      document.querySelector('#action').onclick=event=>{clicks.push({trusted:event.isTrusted});fetch('/witness?marker='+encodeURIComponent(${JSON.stringify(marker)})+'&kind=explicit',{method:'POST'})};
    </script>`;
}

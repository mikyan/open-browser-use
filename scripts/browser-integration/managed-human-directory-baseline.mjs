import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";

// A separate baseline: the existing product already supports ordinary files.
// One original directory click must not be mistaken for the older no-UI gap.
export function createManagedHumanDirectoryBaselineFixture() {
  const workflowId = randomUUID(), route = `/human-directory-baseline/${workflowId}`;
  let documentToken = null, overflow = false;
  const requests = [];
  return { workflowId, route,
    stats: () => structuredClone({ workflowId, route, documentToken, overflow, requests }),
    handle(request, response) {
      const url = new URL(request.url, "http://127.0.0.1");
      if (url.pathname !== route) return false;
      request.resume();
      if (requests.length >= 8) { overflow = true; response.writeHead(429); response.end(); return true; }
      const hit = { method: request.method, path: url.pathname, exact: request.url === route, status: null, finished: false, aborted: false };
      requests.push(hit);
      response.once("finish", () => { hit.finished = true; });
      response.once("close", () => { hit.aborted = !response.writableFinished; });
      hit.status = request.url !== route ? 400 : request.method !== "GET" ? 405 : documentToken ? 409 : 200;
      if (hit.status === 200) documentToken = randomUUID();
      const state = JSON.stringify({ workflowId, documentToken, events: [], overflow: false }).replaceAll("<", "\\u003c");
      const body = hit.status !== 200 ? "Original GET only; do not replay" : `<!doctype html><meta charset="utf-8"><title>Original directory chooser</title><link rel="icon" href="data:,">
<style>body{margin:20px;font:16px sans-serif;background:#eef5ff;color:#17324d}input{display:block;width:420px;height:48px;font-size:18px;margin:20px 0}</style>
<h1>Original directory chooser</h1><label for="upload">Select one local directory</label><input type="file" id="upload" webkitdirectory multiple>
<p>One original click. This baseline supplies no directory or file bytes.</p><pre id="state" hidden></pre>
<script>const state=${state},input=document.getElementById('upload'),render=()=>document.getElementById('state').textContent=JSON.stringify(state);
for(const type of ['pointerdown','pointerup','mousedown','mouseup','click','input','change','cancel'])input.addEventListener(type,event=>{
if(state.events.length>=32){state.overflow=true;render();return}
state.events.push({sequence:state.events.length+1,type,trusted:event.isTrusted,button:event.button??null,ctrlKey:event.ctrlKey??false,altKey:event.altKey??false,shiftKey:event.shiftKey??false,metaKey:event.metaKey??false,files:input.files.length});render()});render();</script>`;
      response.writeHead(hit.status, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" }); response.end(body); return true;
    }
  };
}

export function readManagedHumanDirectoryBaselineDocument() {
  const input = document.querySelector("#upload"), raw = document.querySelector("#state")?.textContent;
  if (!input || !raw) throw Error("Original directory fixture missing");
  const rect = input.getBoundingClientRect();
  return { url: location.href, state: JSON.parse(raw), fileCount: input.files.length, inputType: input.type,
    directory: input.webkitdirectory, multiple: input.multiple,
    files: Array.from(input.files, file => ({ name: file.name, size: file.size, relativePath: file.webkitRelativePath })),
    rect: { x: rect.x, y: rect.y, width: rect.width, height: rect.height }, viewport: { width: innerWidth, height: innerHeight },
    clickable: !input.disabled && rect.width > 0 && rect.height > 0 &&
      document.elementFromPoint(rect.x + Math.min(40, rect.width / 2), rect.y + rect.height / 2) === input };
}

export function classifyManagedHumanDirectoryBaseline({ events, target, frameId, clickAt, ui, inputReplies, commands, lease }) {
  assert.equal(lease.fileChooserVersion, 1, "This rejection baseline belongs to the original ordinary-file runtime");
  assert.ok(ui.fileInputs.some(input => input.id === "file-picker"), "The ordinary local picker must already exist");
  const openings = events.filter(row => row.method === "Page.fileChooserOpened" && row.at >= clickAt);
  assert.equal(openings.length, 1, "An absent directory Opening is missing evidence, not a passing rejection baseline");
  const opening = openings[0];
  assert.equal(opening.params.frameId, frameId); assert.equal(opening.params.mode, "selectMultiple");
  assert.ok(Number.isSafeInteger(opening.params.backendNodeId) && opening.params.backendNodeId > 0);
  assert.ok(opening.source.targetId !== undefined || opening.source.tabId !== undefined);
  if (opening.source.targetId !== undefined) assert.equal(opening.source.targetId, target.id);
  if (opening.source.tabId !== undefined) assert.equal(opening.source.tabId, target.tabId);
  assert.equal(opening.source.sessionId, undefined);
  assert.equal(ui.publishedState.pendingFileChooser ?? null, null, "The rejected directory must not be published as an ordinary picker");
  assert.equal(commands.some(row => row.operation.startsWith("humanFile")), false, "The baseline must never supply or assign files");
  const failed = inputReplies.some(row => row.error), pending = inputReplies.some(row => row.pending);
  return { outcome: "native-directory-rejected-with-existing-ordinary-file-channel", featurePassed: false,
    missingDirectoryChannelObserved: true, nativeOpening: opening,
    inputOutcome: failed ? "native-input-error" : pending ? "native-input-pending-at-observation" : "acknowledged",
    automaticRetirementObserved: ui.publishedState.human?.leaseId !== lease.leaseId,
    originalUIError: ui.error, originalHumanStatus: ui.humanStatus };
}

export function assertManagedHumanDirectoryBaselineDocument(before, after) {
  assert.equal(before.directory, true); assert.equal(before.multiple, true);
  assert.equal(after.directory, true); assert.equal(after.multiple, true);
  assert.deepEqual(before.files, []); assert.deepEqual(after.files, before.files);
  return { directory: true, originalFileListUnchanged: true };
}

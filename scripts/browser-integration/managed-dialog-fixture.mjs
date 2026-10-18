import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";

const encode = value => {
  const bytes = Buffer.from(value);
  return { bytes: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex"), base64: bytes.toString("base64") };
};
const scriptJSON = value => JSON.stringify(value).replaceAll("<", "\\u003c");
const identifier = value => typeof value === "string" && /^[a-z][a-z0-9-]{0,31}$/.test(value);
const text = value => typeof value === "string" && Buffer.byteLength(value) <= 1024 && !value.includes("\0");
export const managedDialogUnicode = "原始人工输入 中文π 🙂";
export const managedDialogCases = Object.freeze([
  Object.freeze({ id: "alert", type: "alert", answer: null }),
  Object.freeze({ id: "confirm-accept", type: "confirm", answer: true }),
  Object.freeze({ id: "confirm-cancel", type: "confirm", answer: false }),
  Object.freeze({ id: "prompt-unicode", type: "prompt", answer: managedDialogUnicode }),
  Object.freeze({ id: "prompt-cancel", type: "prompt", answer: null }),
]);

// Only the ordinary page's click handlers open native dialogs. No fixture code
// answers a dialog, dispatches input, retries a request, or recreates a document.
export function createManagedDialogFixture({ cases = managedDialogCases } = {}) {
  assert.ok(Array.isArray(cases) && cases.length > 0 && cases.length <= 8);
  const selected = cases.map(item => {
    assert.ok(item && Object.keys(item).every(key => ["id", "type", "answer", "message", "defaultValue"].includes(key)));
    assert.ok(identifier(item.id) && ["alert", "confirm", "prompt"].includes(item.type));
    assert.ok(item.type === "alert" ? item.answer === null : item.type === "confirm" ? typeof item.answer === "boolean" : item.answer === null || text(item.answer));
    const message = item.message ?? `${item.type}: ${item.id}`, defaultValue = item.type === "prompt" ? item.defaultValue ?? "original default" : "";
    assert.ok(text(message) && text(defaultValue));
    assert.ok(item.type === "prompt" || item.defaultValue === undefined);
    return { id: item.id, type: item.type, answer: item.answer, message, defaultValue };
  });
  assert.equal(new Set(selected.map(item => item.id)).size, selected.length);
  const workflowId = randomUUID(), paths = Object.freeze({ page: `/managed-dialog/${workflowId}/page`, receipt: `/managed-dialog/${workflowId}/receipt` });
  const requests = [];
  let documentToken = null, postAttempted = false, committed = false, overflow = false, requestCount = 0, receipt = null;
  const stats = () => structuredClone({ workflowId, documentToken, cases: selected, requests, postAttempted, committed, overflow, requestCount, receipt });
  function page() {
    // Expected answers stay server-side. The page reports the actual native return.
    const instructions = selected.map(({ answer: _answer, ...item }) => item);
    return `<!doctype html><meta charset="utf-8"><title>Original managed dialog</title><link rel="icon" href="data:,">
<style>*{box-sizing:border-box}body{margin:12px;font:16px sans-serif;background:#eef5ff;color:#17324d}h1{font-size:21px;margin:0 0 10px}button{display:block;font:16px sans-serif;padding:10px 14px;margin:8px 0}pre{white-space:pre-wrap;overflow-wrap:anywhere}[hidden]{display:none!important}</style>
<h1>Original managed dialog</h1><p>Open each dialog once, in order.</p>
${selected.map(item => `<button type="button" id="dialog-${item.id}" data-dialog-case="${item.id}">${item.id}</button>`).join("\n")}
<p id="phase">ready</p><pre id="state" hidden></pre><pre id="result"></pre><script>
const cases=${scriptJSON(instructions)},state={workflowId:${scriptJSON(workflowId)},documentToken:${scriptJSON(documentToken)},phase:'ready',activeCase:null,clicks:[],events:[],results:[],postAttempts:0,eventOverflow:false,error:null};
const render=()=>{document.querySelector('#state').textContent=JSON.stringify(state);document.querySelector('#phase').textContent=state.phase};
const fail=error=>{state.error??=String(error).slice(0,1024);state.phase='failed';render()};
for(const item of cases)document.getElementById('dialog-'+item.id).addEventListener('click',async event=>{
if(state.clicks.length>=32){state.eventOverflow=true;fail('click capacity exceeded');return}
const click={sequence:state.clicks.length+1,caseId:item.id,trusted:event.isTrusted,button:event.button,ctrlKey:event.ctrlKey,altKey:event.altKey,shiftKey:event.shiftKey,metaKey:event.metaKey};state.clicks.push(click);
if(state.error||state.activeCase||state.postAttempts||cases[state.results.length]?.id!==item.id){fail('original ordered click cannot be repeated');return}
if(!click.trusted||click.button!==0||click.ctrlKey||click.altKey||click.shiftKey||click.metaKey){fail('original unmodified trusted click required');return}
event.currentTarget.disabled=true;state.activeCase=item.id;state.phase='dialog';
state.events.push({sequence:state.events.length+1,caseId:item.id,type:item.type,phase:'before'});render();
try{
let answer=null;
if(item.type==='alert')window.alert(item.message);
else if(item.type==='confirm')answer=window.confirm(item.message);
else answer=window.prompt(item.message,item.defaultValue);
if(typeof answer==='string'&&answer.length>1024)throw Error('native prompt return exceeds fixture bound');
state.events.push({sequence:state.events.length+1,caseId:item.id,type:item.type,phase:'after',answer});
state.results.push({caseId:item.id,type:item.type,answer});state.activeCase=null;state.phase='ready';render();
if(state.results.length!==cases.length)return;
state.postAttempts++;state.phase='posting';render();
const body={workflowId:state.workflowId,documentToken:state.documentToken,clicks:state.clicks,events:state.events,results:state.results,postAttempts:state.postAttempts,eventOverflow:state.eventOverflow};
const response=await fetch(${scriptJSON(paths.receipt)},{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});
const value=await response.json();document.querySelector('#result').textContent=JSON.stringify(value);
if(!response.ok||value.ok!==true)throw Error('original dialog receipt rejected');state.phase='committed';render();
}catch(error){fail(error)}
});render();</script>`;
  }
  function reply(response, hit, status, value, type = "application/json; charset=utf-8") {
    const bytes = Buffer.from(value); Object.assign(hit, { status, response: encode(bytes) });
    response.writeHead(status, { "Content-Type": type, "Content-Length": bytes.length, "Cache-Control": "no-store" }); response.end(bytes);
  }
  function expectedBody() {
    return { workflowId, documentToken,
      clicks: selected.map((item, index) => ({ sequence: index + 1, caseId: item.id, trusted: true, button: 0, ctrlKey: false, altKey: false, shiftKey: false, metaKey: false })),
      events: selected.flatMap((item, index) => [
        { sequence: index * 2 + 1, caseId: item.id, type: item.type, phase: "before" },
        { sequence: index * 2 + 2, caseId: item.id, type: item.type, phase: "after", answer: item.answer },
      ]),
      results: selected.map(item => ({ caseId: item.id, type: item.type, answer: item.answer })), postAttempts: 1, eventOverflow: false };
  }
  function handle(request, response) {
    let url; try { url = new URL(request.url, "http://127.0.0.1"); } catch { return false; }
    if (!Object.values(paths).includes(url.pathname)) return false;
    requestCount++;
    if (requests.length >= 32) { overflow = true; request.resume(); response.writeHead(429); response.end(); return true; }
    const hit = { sequence: requests.length + 1, method: request.method, path: url.pathname, requestTarget: encode(request.url),
      body: encode(""), finished: false, closed: false, aborted: false, errors: [] };
    requests.push(hit);
    response.once("finish", () => { hit.finished = true; });
    response.once("close", () => { hit.closed = true; hit.aborted = !response.writableFinished; });
    response.once("error", error => { hit.errors.push(String(error).slice(0, 1024)); });
    request.once("error", error => { hit.errors.push(String(error).slice(0, 1024)); });
    request.once("aborted", () => { hit.requestAborted = true; });
    const reject = (status, error) => reply(response, hit, status, JSON.stringify({ ok: false, error }));
    if (request.url !== url.pathname) { request.resume(); reject(400, "exact original route required"); return true; }
    if (request.method === "GET" && url.pathname === paths.page) {
      request.resume();
      if (documentToken) { reject(409, "original document already served"); return true; }
      documentToken = hit.documentToken = randomUUID(); reply(response, hit, 200, page(), "text/html; charset=utf-8"); return true;
    }
    if (request.method !== "POST" || url.pathname !== paths.receipt) { request.resume(); reject(405, "original method required"); return true; }
    const alreadyAttempted = postAttempted; postAttempted = true;
    const chunks = []; let size = 0;
    request.on("data", bytes => { size += bytes.length; if (size <= 32768) chunks.push(bytes); });
    request.once("end", () => {
      const bytes = Buffer.concat(chunks); hit.body = { ...encode(bytes), receivedBytes: size, truncated: size > 32768 };
      if (alreadyAttempted) { reject(409, "receipt already attempted; do not replay"); return; }
      if (size > 32768) { reject(413, "bounded receipt required"); return; }
      try {
        assert.ok(documentToken, "original page required");
        const raw = bytes.toString("utf8"), value = JSON.parse(raw);
        assert.equal(JSON.stringify(value), raw, "original canonical JSON body required");
        assert.deepEqual(value, expectedBody());
        committed = true; hit.once = true;
        receipt = { ok: true, workflowId, documentToken, receiptId: randomUUID(), cases: selected.length, postAttempts: 1, results: value.results };
        reply(response, hit, 200, JSON.stringify(receipt));
      } catch { reject(400, "complete original dialog results required"); }
    });
    return true;
  }
  function verify(after) {
    assert.equal(overflow, false); assert.equal(committed, true);
    assert.deepEqual(requests.map(hit => [hit.method, hit.path, hit.status]), [["GET", paths.page, 200], ["POST", paths.receipt, 200]]);
    for (const hit of requests) { assert.equal(hit.finished, true); assert.equal(hit.aborted, false); assert.deepEqual(hit.errors, []); }
    assert.equal(after.state.workflowId, workflowId); assert.equal(after.state.documentToken, documentToken);
    assert.equal(after.state.phase, "committed"); assert.equal(after.state.activeCase, null); assert.equal(after.state.error, null);
    const expected = expectedBody();
    for (const key of Object.keys(expected)) assert.deepEqual(after.state[key], expected[key]);
    assert.deepEqual(after.result, receipt);
    return structuredClone(receipt);
  }
  return { handle, stats, verify, workflowId, paths, cases: structuredClone(selected) };
}

// These functions are self-contained for an existing read-only observer. They
// never focus, scroll, click, answer a dialog, or write to the observed document.
export function readManagedDialogDocument() {
  const read = selector => { const raw = document.querySelector(selector)?.textContent; return raw ? JSON.parse(raw) : null; };
  const boxes = Object.fromEntries([...document.querySelectorAll("button[data-dialog-case]")].map(button => {
    const rect = button.getBoundingClientRect();
    return [button.dataset.dialogCase, { x: rect.x, y: rect.y, width: rect.width, height: rect.height, disabled: button.disabled }];
  }));
  return { state: read("#state"), result: read("#result"), url: location.href, title: document.title, boxes,
    viewport: { width: innerWidth, height: innerHeight, scrollX, scrollY, devicePixelRatio } };
}

export function measureManagedDialogButton(caseId) {
  if (typeof caseId !== "string" || !/^[a-z][a-z0-9-]{0,31}$/.test(caseId)) throw Error("Known fixture case required");
  const button = document.getElementById("dialog-" + caseId);
  if (!button || button.tagName !== "BUTTON" || button.dataset.dialogCase !== caseId) throw Error("Original fixture button missing");
  const r = button.getBoundingClientRect(), style = getComputedStyle(button);
  const rect = { x: r.x, y: r.y, width: r.width, height: r.height };
  const left = Math.max(0, r.x), top = Math.max(0, r.y), right = Math.min(innerWidth, r.x + r.width), bottom = Math.min(innerHeight, r.y + r.height);
  const visible = Object.values(rect).every(Number.isFinite) && r.width > 0 && r.height > 0 && right > left && bottom > top && style.display !== "none" && style.visibility === "visible" && Number(style.opacity) > 0;
  const center = visible ? { x: (left + right) / 2, y: (top + bottom) / 2 } : null;
  const hit = center ? document.elementFromPoint(center.x, center.y) : null;
  const clickable = visible && !button.disabled && (hit === button || button.contains(hit));
  return { caseId, id: button.id, rect, disabled: button.disabled, visible, clickable, point: clickable ? center : null,
    hitTargetId: hit?.id ?? null, viewport: { width: innerWidth, height: innerHeight, scrollX, scrollY, devicePixelRatio } };
}

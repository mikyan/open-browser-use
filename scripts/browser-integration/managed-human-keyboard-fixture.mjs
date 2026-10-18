import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { humanKeyboardCases, assertManagedHumanKeyboardValues } from "./managed-human-keyboard.mjs";
export { humanKeyboardCases, assertManagedHumanKeyboardCase, assertManagedHumanKeyboardReceipt, assertManagedHumanKeyboardLedger } from "./managed-human-keyboard.mjs";

const sha = bytes => createHash("sha256").update(bytes).digest("hex");

export function createManagedHumanKeyboardFixture() {
  const workflowId = randomUUID(), requests = [], tokens = new Set(); let committed = false, overflow = false;
  const reply = (response, hit, status, body, contentType = "application/json; charset=utf-8") => {
    const bytes = Buffer.from(body); Object.assign(hit, { status, response: { bytes: bytes.length, sha256: sha(bytes), base64: bytes.toString("base64") } });
    response.writeHead(status, { "Content-Type": contentType, "Content-Length": bytes.length, "Cache-Control": "no-store" }); response.end(bytes);
  };
  function handle(request, response) {
    const url = new URL(request.url, "http://127.0.0.1"); if (!["/human-keyboard-form", "/human-keyboard-receipt"].includes(url.pathname)) return false;
    if (requests.length >= 16) { overflow = true; request.resume(); response.writeHead(503).end(); return true; }
    const hit = { sequence: requests.length + 1, method: request.method, path: url.pathname, at: Date.now(), finished: false, closed: false, aborted: false, errors: [] }; requests.push(hit);
    response.once("finish", () => { hit.finished = true; }); response.once("close", () => { hit.closed = true; hit.aborted = !response.writableFinished; });
    response.on("error", error => hit.errors.push(error.message)); request.on("error", error => hit.errors.push(error.message));
    if (url.search) { request.resume(); reply(response, hit, 400, '{"error":"query"}'); return true; }
    if (request.method === "GET" && url.pathname === "/human-keyboard-form") {
      request.resume(); const documentToken = randomUUID(); tokens.add(documentToken); hit.documentToken = documentToken;
      const fields = humanKeyboardCases.map(spec => {
        const field = spec.kind === "textarea" ? `<textarea id="${spec.id}">${spec.initial}</textarea>` : spec.kind === "contenteditable" ? `<div id="${spec.id}" contenteditable="true" role="textbox" aria-label="${spec.id}">${spec.initial}</div>` : `<input id="${spec.id}" value="${spec.initial}">`;
        const label = `<label>${spec.id}${field}</label>`;
        return spec.kind === "submit" ? `<form id="submit-form">${label}<button type="submit" hidden>Submit original keyboard receipt</button></form>` : `<section>${label}</section>`;
      }).join("");
      const html = `<!doctype html><meta charset="utf-8"><title>Original managed keyboard form</title>
<style>body{font:16px sans-serif;margin:16px;background:#eef4ff;color:#132641}h1{font-size:20px;margin:0 0 12px}.grid{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:12px}label{display:grid;gap:5px;font-size:12px}textarea,input,[contenteditable]{box-sizing:border-box;width:100%;min-height:48px;border:1px solid #456;padding:7px;font:16px sans-serif;background:white;color:#123}textarea{resize:none}input{min-height:34px}#result{font:12px monospace;white-space:pre-wrap}</style>
<h1>Original Enter behavior</h1><div class="grid">${fields}</div><pre id="result"></pre><pre id="state" hidden></pre>
<script>
const cases=${JSON.stringify(humanKeyboardCases)},state={workflowId:${JSON.stringify(workflowId)},documentToken:${JSON.stringify(documentToken)},events:[],eventOverflow:false,heldKeys:[],heldButtons:[],submits:0,controls:{},receipt:null};
const controls=()=>Object.fromEntries(cases.map(spec=>{const el=document.getElementById(spec.id);return[spec.id,spec.kind==='contenteditable'?{kind:spec.kind,textContent:el.textContent,innerText:el.innerText,innerHTML:el.innerHTML,lineBreaks:el.querySelectorAll('br,div,p').length}:{kind:spec.kind,value:el.value,selectionStart:el.selectionStart,selectionEnd:el.selectionEnd}]}));
const render=()=>{state.controls=controls();document.getElementById('state').textContent=JSON.stringify(state)};
const record=e=>{if(state.events.length>=256){state.eventOverflow=true;render();return}const row={sequence:state.events.length+1,at:Date.now(),type:e.type,target:e.target.id,trusted:e.isTrusted,defaultPrevented:e.defaultPrevented};if(e.type.startsWith('key')){Object.assign(row,{key:e.key,code:e.code,keyCode:e.keyCode,charCode:e.charCode,location:e.location,repeat:e.repeat,shiftKey:e.shiftKey,ctrlKey:e.ctrlKey,altKey:e.altKey,metaKey:e.metaKey,isComposing:e.isComposing});if(e.type==='keydown'&&!state.heldKeys.includes(e.code))state.heldKeys.push(e.code);if(e.type==='keyup')state.heldKeys=state.heldKeys.filter(code=>code!==e.code)}if(e.type.startsWith('pointer')||e.type.startsWith('mouse')){Object.assign(row,{button:e.button,buttons:e.buttons,x:e.clientX,y:e.clientY});if(e.type==='mousedown'&&!state.heldButtons.includes(e.button))state.heldButtons.push(e.button);if(e.type==='mouseup')state.heldButtons=state.heldButtons.filter(button=>button!==e.button)}if(e.type==='beforeinput'||e.type==='input')Object.assign(row,{inputType:e.inputType,data:e.data,isComposing:e.isComposing});state.events.push(row);render()};
document.getElementById('prevented-enter').addEventListener('keydown',e=>{if(e.key==='Enter')e.preventDefault()});
for(const type of ['keydown','keypress','keyup','beforeinput','input','pointerdown','pointerup','mousedown','mouseup'])document.addEventListener(type,record,{passive:true});
document.getElementById('submit-form').addEventListener('submit',async e=>{e.preventDefault();state.submits++;record(e);const body=JSON.stringify({workflowId:state.workflowId,documentToken:state.documentToken,submits:state.submits,controls:state.controls});const response=await fetch('/human-keyboard-receipt',{method:'POST',headers:{'Content-Type':'application/json'},body});const text=await response.text();document.getElementById('result').textContent=text;state.receipt=JSON.parse(text);render()});render();
</script>`;
      reply(response, hit, 200, html, "text/html; charset=utf-8"); return true;
    }
    if (request.method !== "POST" || url.pathname !== "/human-keyboard-receipt") { request.resume(); reply(response, hit, 405, '{"error":"method"}'); return true; }
    const chunks = []; let size = 0; request.on("data", bytes => { size += bytes.length; if (size <= 16384) chunks.push(bytes); });
    request.once("aborted", () => { hit.requestAborted = true; }); request.once("end", () => {
      const bytes = Buffer.concat(chunks); hit.body = { bytes: size, sha256: sha(bytes), base64: bytes.toString("base64"), truncated: size > 16384 };
      let body; try {
        assert.ok(size <= 16384); body = JSON.parse(bytes); assert.deepEqual(Object.keys(body).sort(), ["controls", "documentToken", "submits", "workflowId"]);
        assert.equal(body.workflowId, workflowId); assert.ok(tokens.has(body.documentToken)); assert.equal(body.submits, 1); assertManagedHumanKeyboardValues(body.controls);
      } catch { reply(response, hit, 400, '{"error":"original keyboard outcomes required"}'); return; }
      if (committed) { reply(response, hit, 409, '{"error":"receipt already consumed"}'); return; }
      committed = true; hit.once = true; hit.documentToken = body.documentToken;
      const receipt = { ok: true, workflowId, documentToken: body.documentToken, controlsSHA256: sha(JSON.stringify(body.controls)), submits: 1 };
      hit.publicReceipt = receipt; reply(response, hit, 200, JSON.stringify(receipt));
    }); return true;
  }
  return { handle, workflowId, cases: humanKeyboardCases, stats: () => structuredClone({ workflowId, requests, committed, overflow }) };
}

// Read only the bounded synthetic fixture. Native documentId is supplied by the
// original scripting result outside this function; it is never invented here.
export function readManagedHumanKeyboardDocument() {
  const state = JSON.parse(document.getElementById("state").textContent), rect = element => { const r = element.getBoundingClientRect(); return { x: r.x, y: r.y, width: r.width, height: r.height }; };
  const controls = Object.fromEntries(Object.keys(state.controls).map(id => {
    const el = document.getElementById(id), spec = state.controls[id];
    return [id, spec.kind === "contenteditable" ? { kind: spec.kind, textContent: el.textContent, innerText: el.innerText, innerHTML: el.innerHTML, lineBreaks: el.querySelectorAll("br,div,p").length } : { kind: spec.kind, value: el.value, selectionStart: el.selectionStart, selectionEnd: el.selectionEnd }];
  }));
  state.controls = controls;
  return { state, activeElement: document.activeElement?.id, result: document.getElementById("result").textContent,
    viewport: { width: innerWidth, height: innerHeight, scrollX, scrollY, devicePixelRatio },
    boxes: Object.fromEntries(Object.keys(controls).map(id => [id, rect(document.getElementById(id))])) };
}

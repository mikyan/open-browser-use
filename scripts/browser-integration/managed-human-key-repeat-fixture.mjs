import { randomUUID } from "node:crypto";
import { humanKeyRepeatCases } from "./managed-human-key-repeat.mjs";

export function createManagedKeyRepeatFixture() {
  const requests = []; let overflow = false;
  function handle(request, response) {
    const url = new URL(request.url, "http://127.0.0.1"); if (url.pathname !== "/human-key-repeat") return false;
    if (requests.length >= 8) { overflow = true; request.resume(); response.writeHead(503).end(); return true; }
    const hit = { sequence: requests.length + 1, method: request.method, path: url.pathname, at: Date.now(), finished: false, aborted: false }; requests.push(hit);
    response.once("finish", () => { hit.finished = true; }); response.once("close", () => { hit.aborted = !response.writableFinished; });
    request.resume();
    if (request.method !== "GET" || url.search) { hit.status = 405; response.writeHead(405).end(); return true; }
    const token = randomUUID(); hit.documentToken = token; hit.status = 200;
    const html = `<!doctype html><meta charset="utf-8"><title>Original native key repeat</title>
<style>body{font:16px sans-serif;margin:16px;background:#eef4ff;color:#132641}.grid{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:14px}label{display:grid;gap:6px}textarea{box-sizing:border-box;width:100%;height:70px;padding:8px;font:18px monospace;resize:none}</style>
<h1>Original native key repeat</h1><div class="grid">${humanKeyRepeatCases.map(row => `<label>${row.id}<textarea id="${row.id}">${row.initial}</textarea></label>`).join("")}</div><pre id="state" hidden></pre>
<script>
const cases=${JSON.stringify(humanKeyRepeatCases)},state={documentToken:${JSON.stringify(token)},events:[],eventOverflow:false,heldKeys:[],heldButtons:[],controls:{}};
const controls=()=>Object.fromEntries(cases.map(row=>{const el=document.getElementById(row.id);return[row.id,{value:el.value,selectionStart:el.selectionStart,selectionEnd:el.selectionEnd}]}));
const render=()=>{state.controls=controls();document.getElementById('state').textContent=JSON.stringify(state)};
document.getElementById('repeat-prevented').addEventListener('keydown',event=>{if(event.key==='Backspace')event.preventDefault()});
for(const type of ['keydown','keyup','keypress','beforeinput','input','mousedown','mouseup','submit'])document.addEventListener(type,event=>{if(state.events.length>=256){state.eventOverflow=true;render();return}const row={sequence:state.events.length+1,at:Date.now(),type,target:event.target.id,trusted:event.isTrusted,defaultPrevented:event.defaultPrevented};if(type.startsWith('key')){Object.assign(row,{key:event.key,code:event.code,repeat:event.repeat});if(type==='keydown'&&!state.heldKeys.includes(event.code))state.heldKeys.push(event.code);if(type==='keyup')state.heldKeys=state.heldKeys.filter(code=>code!==event.code)}if(type==='beforeinput'||type==='input')Object.assign(row,{inputType:event.inputType,data:event.data,isComposing:event.isComposing});if(type==='mousedown'&&!state.heldButtons.includes(event.button))state.heldButtons.push(event.button);if(type==='mouseup')state.heldButtons=state.heldButtons.filter(button=>button!==event.button);state.events.push(row);render()},{passive:true});render();
</script>`;
    response.writeHead(200, { "Content-Type": "text/html;charset=utf-8", "Cache-Control": "no-store" }); response.end(html); return true;
  }
  return { handle, stats: () => structuredClone({ requests, overflow }) };
}

export function readManagedKeyRepeatDocument() {
  const state = JSON.parse(document.getElementById("state").textContent), boxes = {};
  for (const id of Object.keys(state.controls)) {
    const element = document.getElementById(id), box = element.getBoundingClientRect();
    state.controls[id] = { value: element.value, selectionStart: element.selectionStart, selectionEnd: element.selectionEnd };
    boxes[id] = { x: box.x, y: box.y, width: box.width, height: box.height };
  }
  return { state, boxes, activeElement: document.activeElement?.id };
}

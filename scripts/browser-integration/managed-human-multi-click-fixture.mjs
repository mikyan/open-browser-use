import { randomUUID } from "node:crypto";
import { humanMultiClickCases } from "./managed-human-multi-click-workflow.mjs";

export function createManagedMultiClickFixture() {
  const requests = []; let overflow = false;
  function handle(request, response) {
    const url = new URL(request.url, "http://127.0.0.1");
    if (url.pathname !== "/human-multi-click") return false;
    if (requests.length >= 8) { overflow = true; request.resume(); response.writeHead(503).end(); return true; }
    const hit = { sequence: requests.length + 1, method: request.method, path: url.pathname, at: Date.now(), finished: false, aborted: false };
    requests.push(hit); request.resume();
    response.once("finish", () => { hit.finished = true; });
    response.once("close", () => { hit.aborted = !response.writableFinished; });
    if (request.method !== "GET" || url.search || requests.length !== 1) { hit.status = 405; response.writeHead(405).end(); return true; }
    hit.status = 200; hit.documentToken = randomUUID();
    response.writeHead(200, { "Content-Type": "text/html;charset=utf-8", "Cache-Control": "no-store" });
    response.end(`<!doctype html><meta charset="utf-8"><title>Original multi-click selection</title>
<style>body{font:16px sans-serif;margin:16px;background:#eef4ff;color:#132641}label{display:block;margin:12px 0}textarea{display:block;box-sizing:border-box;width:480px;height:88px;padding:8px;border:1px solid #456;font:20px/28px "Courier New",monospace;letter-spacing:0;resize:none;white-space:pre}</style>
<h1>Original double and triple click</h1>${humanMultiClickCases.map(row => `<label>${row.id}<textarea id="${row.id}" wrap="off">${row.initial}</textarea></label>`).join("")}<pre id="state" hidden></pre>
<script>
const ids=${JSON.stringify(humanMultiClickCases.map(row => row.id))},state={documentToken:${JSON.stringify(hit.documentToken)},events:[],eventOverflow:false,heldButtons:[]};
const render=()=>document.getElementById('state').textContent=JSON.stringify(state);
for(const type of ['pointerdown','pointerup','mousedown','mouseup','click','dblclick','beforeinput','input'])document.addEventListener(type,event=>{
 if(!ids.includes(event.target.id))return;
 if(state.events.length>=128){state.eventOverflow=true;render();return}
 if(type==='mousedown'&&!state.heldButtons.includes(event.button))state.heldButtons.push(event.button);
 if(type==='mouseup')state.heldButtons=state.heldButtons.filter(button=>button!==event.button);
 state.events.push({sequence:state.events.length+1,at:Date.now(),type,target:event.target.id,trusted:event.isTrusted,detail:event.detail??null,button:event.button??null,buttons:event.buttons??null,defaultPrevented:event.defaultPrevented});
 render();
},{passive:true});render();
</script>`);
    return true;
  }
  return { handle, stats: () => structuredClone({ requests, overflow }) };
}

// Read original geometry and native selection only. The canvas is detached and
// measures the textarea's actual computed font; no caret/selection is changed.
export function readManagedMultiClickDocument() {
  const state = JSON.parse(document.getElementById("state").textContent), controls = {}, points = {};
  for (const id of ["double-word", "triple-line"]) {
    const el = document.getElementById(id), rect = el.getBoundingClientRect(), style = getComputedStyle(el);
    const canvas = document.createElement("canvas"), context = canvas.getContext("2d"); context.font = style.font;
    const prefixWidth = context.measureText("alpha ").width, wordWidth = context.measureText("BRAVO").width;
    const x = rect.x + el.clientLeft + parseFloat(style.paddingLeft) + prefixWidth + wordWidth / 2 - el.scrollLeft;
    const y = rect.y + el.clientTop + parseFloat(style.paddingTop) + parseFloat(style.lineHeight) / 2 - el.scrollTop;
    controls[id] = { value: el.value, selectionStart: el.selectionStart, selectionEnd: el.selectionEnd, selectionDirection: el.selectionDirection,
      selected: el.value.slice(el.selectionStart, el.selectionEnd) };
    points[id] = { x: x - 1, y: y - 1, width: 2, height: 2 };
  }
  return { state, controls, points, activeElement: document.activeElement?.id };
}

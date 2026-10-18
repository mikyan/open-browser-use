import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";

const hash = bytes => createHash("sha256").update(bytes).digest("hex");

// Independent zero-business document. It has no form, fetch or POST handler.
// Its hidden event journal cannot change geometry during the held-input test.
export function createManagedWorkerHeldFixture() {
  const documentToken = randomUUID(), requests = []; let opened = false;
  const route = "/managed-worker-held";
  function handle(request, response) {
    if (new URL(request.url, "http://127.0.0.1").pathname !== route) return false;
    const hit = { method: request.method, url: request.url, at: Date.now(), finished: false, closed: false }; requests.push(hit);
    request.resume(); response.once("finish", () => { hit.finished = true; }); response.once("close", () => { hit.closed = true; hit.aborted = !response.writableFinished; });
    const reply = (status, body) => { const bytes = Buffer.from(body); hit.status = status; hit.response = { bytes: bytes.length, sha256: hash(bytes), base64: bytes.toString("base64") }; response.writeHead(status, { "Content-Type": "text/html; charset=utf-8", "Content-Length": bytes.length, "Cache-Control": "no-store" }); response.end(bytes); };
    if (request.method !== "GET" || request.url !== route || opened) { reply(409, "Original held-input document cannot be recreated"); return true; }
    opened = true;
    reply(200, `<!doctype html><meta charset="utf-8"><title>Held input worker replacement boundary</title>
<style>html{overflow:hidden}body{font:17px sans-serif;margin:16px;background:#edf5ff;color:#14283b}h1{font-size:22px}input{font:17px sans-serif;width:600px;padding:6px}#held{width:260px;height:100px;margin-top:20px;background:#c8e1ff;border:2px solid #315e87;display:flex;align-items:center;justify-content:center}#state{display:none}</style>
<h1>Independent held-input boundary</h1><label>Focus target<input id="note" autocomplete="off"></label><div id="held" tabindex="0">Hold Shift and left pointer here</div><pre id="state"></pre>
<script>
const state={documentToken:${JSON.stringify(documentToken)},events:[],heldKeys:[],heldButtons:[],pointerCaptured:false,overflow:false};
const render=()=>{document.querySelector('#state').textContent=JSON.stringify(state)};
const held=document.querySelector('#held');
const record=e=>{if(state.events.length>=128){state.overflow=true;render();return}const value={type:e.type,target:e.target?.id??'',trusted:e.isTrusted};if(e.type.startsWith('key')){value.key=e.key;value.code=e.code;if(e.type==='keydown'&&!state.heldKeys.includes(e.code))state.heldKeys.push(e.code);if(e.type==='keyup')state.heldKeys=state.heldKeys.filter(x=>x!==e.code)}if(e.type==='mousedown'){value.button=e.button;if(!state.heldButtons.includes(e.button))state.heldButtons.push(e.button)}if(e.type==='mouseup'){value.button=e.button;state.heldButtons=state.heldButtons.filter(x=>x!==e.button)}if(e.type==='pointerdown'&&e.target===held){held.setPointerCapture(e.pointerId);state.pointerCaptured=held.hasPointerCapture(e.pointerId)}if(e.type==='lostpointercapture')state.pointerCaptured=false;state.events.push(value);render()};
for(const type of ['keydown','keyup','mousedown','mouseup','pointerdown','pointerup','lostpointercapture'])document.addEventListener(type,record,{capture:true,passive:true});render();
</script>`);
    return true;
  }
  return { handle, paths: { form: route }, stats: () => structuredClone({ documentToken, opened, requests }) };
}

export function readManagedWorkerHeldDocument() {
  const state = JSON.parse(document.querySelector("#state")?.textContent ?? "null");
  const box = id => { const r = document.getElementById(id).getBoundingClientRect(); return { x: r.x, y: r.y, width: r.width, height: r.height }; };
  return { state, title: document.title, url: location.href, boxes: { note: box("note"), held: box("held") },
    viewport: { width: innerWidth, height: innerHeight, clientWidth: document.documentElement.clientWidth, clientHeight: document.documentElement.clientHeight } };
}

export function assertZeroBusinessHeldFixture(stats) {
  assert.equal(stats.opened, true); assert.equal(stats.requests.length, 1);
  const hit = stats.requests[0]; assert.equal(hit.method, "GET"); assert.equal(hit.status, 200); assert.equal(hit.finished, true); assert.equal(hit.aborted, false);
  const bytes = Buffer.from(hit.response.base64, "base64"); assert.equal(bytes.length, hit.response.bytes); assert.equal(hash(bytes), hit.response.sha256);
  assert.ok(!/<form\b|fetch\s*\(|XMLHttpRequest/.test(bytes.toString()));
  return { requests: 1, posts: 0, documentToken: stats.documentToken, originalResponse: hit.response };
}

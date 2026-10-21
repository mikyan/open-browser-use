import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";

export const managedPrintableLayouts = Object.freeze(["root", "oopif"]);
export const managedPrintableCases = Object.freeze([
  { id: "checkbox", focus: "checkbox-anchor", tab: true, key: "Space", code: "Space", character: " " },
  { id: "space-button", focus: "button-anchor", tab: true, key: "Space", code: "Space", character: " " },
  { id: "grid", focus: "grid", key: "7", code: "Digit7", character: "7", prevented: true },
  { id: "blocked", focus: "blocked", end: true, key: "x", code: "KeyX", character: "x", prevented: true },
  { id: "lower", focus: "lower", key: "a", code: "KeyA", character: "a" },
  { id: "upper", focus: "upper", key: "Shift+KeyA", code: "KeyA", character: "A", shift: true },
  { id: "symbol", focus: "symbol", key: "Shift+Digit1", code: "Digit1", character: "!", shift: true },
].map(Object.freeze));
const sha = value => createHash("sha256").update(value).digest("hex");
const json = value => JSON.stringify(value).replaceAll("<", "\\u003c");

// The original application consumes native events. The observer never focuses,
// edits or dispatches events. Baseline POSTs retain wrong values instead of
// preventing evidence collection when a feature assertion fails.
export function createManagedPrintableFixture({ baseURL, kind }) {
  assert.ok(managedPrintableLayouts.includes(kind));
  const base = new URL(baseURL); assert.equal(base.hostname, "127.0.0.1"); assert.equal(base.protocol, "http:");
  const workflowId = randomUUID(), prefix = `/human-printable/${workflowId}/`;
  const root = new URL(prefix + "root", base), leaf = new URL(prefix + "leaf", base);
  if (kind === "oopif") leaf.hostname = "localhost";
  const emitter = kind === "oopif" ? leaf : root;
  const urls = { root: root.href, emitter: emitter.href, receipt: new URL(prefix + "receipt", emitter).href };
  const tokens = {}, requests = []; let posted = false, receipt = null, overflow = false;
  function html(role) {
    const active = role === (kind === "oopif" ? "leaf" : "root");
    const initial = { workflowId, kind, role, documentToken: tokens[role], events: [], overflow: false,
      heldKeys: [], heldButtons: [], buttonClicks: 0, gridText: "", posts: 0, phase: "ready", error: null };
    return `<!doctype html><meta charset="utf-8"><title>Original ${kind} printable keyboard</title><link rel="icon" href="data:,">
<style>*{box-sizing:border-box}body{margin:8px;font:15px sans-serif;background:#eef5ff;color:#17324d}h1{font-size:18px;margin:0 0 8px}.row{display:flex;align-items:center;gap:12px;margin:8px 0}input[type=text],#grid{width:180px;height:34px;border:1px solid #345;padding:5px;font:16px monospace}button{padding:6px;font:14px sans-serif}iframe{width:700px;height:440px;border:2px solid #789}#receipt{font-size:11px;max-width:680px;overflow:hidden;max-height:48px}</style>
<h1>${kind} ${role}: original keyboard actions</h1>${active ? `<form id="form">
<div class="row"><button type="button" id="checkbox-anchor">Focus before checkbox</button><input type="checkbox" id="checkbox"><label for="checkbox">Approve original quantity</label></div>
<div class="row"><button type="button" id="button-anchor">Focus before action</button><button type="button" id="space-button">Accept original item</button></div>
<div class="row"><span>Keyboard quantity grid</span><div id="grid" role="gridcell" tabindex="0" aria-label="Original quantity grid"></div></div>
<div class="row"><label>Block x <input type="text" id="blocked" value="seed"></label><label>Lowercase <input type="text" id="lower"></label></div>
<div class="row"><label>Uppercase <input type="text" id="upper"></label><label>Symbol <input type="text" id="symbol"></label></div>
<button id="submit" type="submit">Submit original keyboard result</button></form>` : `<iframe id="child" src=${json(urls.emitter)}></iframe>`}
<pre id="state" hidden></pre><pre id="receipt"></pre><script>
const state=${json(initial)};
const controls=()=>document.getElementById('checkbox')?{checkbox:document.getElementById('checkbox').checked,buttonClicks:state.buttonClicks,grid:document.getElementById('grid').textContent,blocked:document.getElementById('blocked').value,lower:document.getElementById('lower').value,upper:document.getElementById('upper').value,symbol:document.getElementById('symbol').value}:null;
const render=()=>{state.controls=controls();document.getElementById('state').textContent=JSON.stringify(state)};
${active ? `document.getElementById('space-button').addEventListener('click',()=>{state.buttonClicks++;render()});
document.getElementById('grid').addEventListener('keydown',event=>{if(!event.ctrlKey&&!event.altKey&&!event.metaKey&&/^[0-9]$/.test(event.key)){event.preventDefault();state.gridText+=event.key;event.currentTarget.textContent=state.gridText;render()}});
document.getElementById('blocked').addEventListener('keydown',event=>{if(event.key==='x')event.preventDefault()});
const record=event=>{if(state.events.length>=512){state.overflow=true;render();return}const row={sequence:state.events.length+1,at:Date.now(),type:event.type,target:event.target?.id??'',trusted:event.isTrusted,defaultPrevented:event.defaultPrevented};
if(event.type.startsWith('key')){Object.assign(row,{key:event.key,code:event.code,keyCode:event.keyCode,charCode:event.charCode,location:event.location,repeat:event.repeat,shiftKey:event.shiftKey,ctrlKey:event.ctrlKey,altKey:event.altKey,metaKey:event.metaKey,isComposing:event.isComposing});if(event.type==='keydown'&&!state.heldKeys.includes(event.code))state.heldKeys.push(event.code);if(event.type==='keyup')state.heldKeys=state.heldKeys.filter(code=>code!==event.code)}
if(event.type.startsWith('pointer')||event.type.startsWith('mouse')||event.type==='click'){Object.assign(row,{button:event.button,buttons:event.buttons,detail:event.detail});if(event.type==='mousedown'&&!state.heldButtons.includes(event.button))state.heldButtons.push(event.button);if(event.type==='mouseup')state.heldButtons=state.heldButtons.filter(button=>button!==event.button)}
if(event.type==='input'||event.type==='beforeinput')Object.assign(row,{inputType:event.inputType??null,data:event.data??null,isComposing:event.isComposing??false});state.events.push(row);render()};
for(const type of ['keydown','keypress','keyup','beforeinput','input','change','pointerdown','pointerup','mousedown','mouseup','click'])document.addEventListener(type,record,{passive:true});
document.getElementById('form').addEventListener('submit',async event=>{event.preventDefault();record(event);if(state.posts++){state.error='No replay';render();return}state.phase='posting';render();
try{const response=await fetch(${json(urls.receipt)},{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({workflowId:state.workflowId,documentToken:state.documentToken,posts:state.posts,controls:controls(),events:state.events})});const receipt=await response.json();document.getElementById('receipt').textContent=JSON.stringify(receipt);if(!response.ok||!receipt.recorded)throw Error('Original observation rejected');state.phase='committed';render()}catch(error){state.error=String(error);state.phase='failed';render()}});` : ""}
render();</script>`;
  }
  const reply = (res, hit, status, body, type = "application/json; charset=utf-8") => {
    const bytes = Buffer.from(body); hit.status = status; hit.response = { bytes: bytes.length, sha256: sha(bytes), base64: bytes.toString("base64") };
    res.writeHead(status, { "Content-Type": type, "Cache-Control": "no-store", "Content-Length": bytes.length }); res.end(bytes);
  };
  function handle(req, res) {
    const url = new URL(req.url, base); if (!url.pathname.startsWith(prefix)) return false;
    if (requests.length >= 8) { overflow = true; req.resume(); res.writeHead(429).end(); return true; }
    const hit = { method: req.method, path: url.pathname, host: req.headers.host, at: Date.now(), finished: false, aborted: false, errors: [] }; requests.push(hit);
    res.once("finish", () => { hit.finished = true; }); res.once("close", () => { hit.aborted = !res.writableFinished; });
    res.on("error", error => hit.errors.push(error.message)); req.on("error", error => hit.errors.push(error.message));
    const role = url.pathname === prefix + "root" ? "root" : url.pathname === prefix + "leaf" ? "leaf" : null;
    const expected = role === "root" ? root : role === "leaf" ? leaf : new URL(urls.receipt);
    if (req.url !== url.pathname || req.headers.host !== expected.host) { req.resume(); reply(res, hit, 400, "{}"); return true; }
    if (req.method === "GET" && role) {
      req.resume(); if (tokens[role] || role === "leaf" && (kind !== "oopif" || !tokens.root)) { reply(res, hit, 409, "{}"); return true; }
      tokens[role] = randomUUID(); reply(res, hit, 200, html(role), "text/html; charset=utf-8"); return true;
    }
    if (req.method !== "POST" || url.pathname !== prefix + "receipt") { req.resume(); reply(res, hit, 405, "{}"); return true; }
    const duplicate = posted; posted = true; const chunks = []; let size = 0;
    req.on("data", bytes => { size += bytes.length; if (size <= 256 * 1024) chunks.push(bytes); });
    req.once("end", () => {
      const raw = Buffer.concat(chunks); hit.body = { bytes: size, sha256: sha(raw), base64: raw.toString("base64"), truncated: size > 256 * 1024 };
      try {
        assert.equal(duplicate, false); assert.ok(size <= 256 * 1024);
        const body = JSON.parse(raw); assert.deepEqual(Object.keys(body).sort(), ["controls", "documentToken", "events", "posts", "workflowId"]);
        assert.equal(body.workflowId, workflowId); assert.equal(body.documentToken, tokens[kind === "oopif" ? "leaf" : "root"]); assert.equal(body.posts, 1);
        assert.ok(Array.isArray(body.events) && body.events.length <= 512); assert.ok(body.events.every((row, i) => row.sequence === i + 1 && row.trusted === true));
        assert.equal(body.events.filter(row => row.type === "submit").length, 1);
        assert.deepEqual(Object.keys(body.controls).sort(), ["blocked", "buttonClicks", "checkbox", "grid", "lower", "symbol", "upper"]);
        assert.equal(typeof body.controls.checkbox, "boolean"); assert.ok(Number.isSafeInteger(body.controls.buttonClicks));
        for (const key of ["blocked", "grid", "lower", "upper", "symbol"]) assert.ok(typeof body.controls[key] === "string" && body.controls[key].length <= 256);
        receipt = { recorded: true, workflowId, documentToken: body.documentToken, posts: 1, controls: body.controls, eventsSHA256: sha(JSON.stringify(body.events)), bodySHA256: sha(raw) };
        reply(res, hit, 200, JSON.stringify(receipt));
      } catch (error) { hit.validationError = String(error); reply(res, hit, 400, '{"recorded":false}'); }
    }); return true;
  }
  return { kind, workflowId, urls, handle, stats: () => structuredClone({ kind, workflowId, urls, tokens, requests, posted, receipt, overflow }) };
}

// Passive read of exact fixture documents. No focus/scroll/value setter or
// event dispatch; documentId and process identity come from browser APIs.
export function readManagedPrintableDocument() {
  const raw = document.getElementById("state")?.textContent; if (!raw) return null;
  const state = JSON.parse(raw), child = document.getElementById("child");
  const rect = el => { if (!el) return null; const r = el.getBoundingClientRect(); return { x: r.x, y: r.y, width: r.width, height: r.height }; };
  const ids = ["checkbox-anchor", "checkbox", "button-anchor", "space-button", "grid", "blocked", "lower", "upper", "symbol", "submit"];
  const controls = document.getElementById("checkbox") ? { checkbox: document.getElementById("checkbox").checked, buttonClicks: state.buttonClicks,
    grid: document.getElementById("grid").textContent, blocked: document.getElementById("blocked").value, lower: document.getElementById("lower").value,
    upper: document.getElementById("upper").value, symbol: document.getElementById("symbol").value } : null;
  return { url: location.href, state, controls, activeElement: document.activeElement?.id,
    boxes: Object.fromEntries(ids.filter(id => document.getElementById(id)).map(id => [id, rect(document.getElementById(id))])),
    childRect: rect(child), childInset: child ? { x: child.clientLeft, y: child.clientTop } : null,
    viewport: { width: innerWidth, height: innerHeight }, receipt: JSON.parse(document.getElementById("receipt").textContent || "null") };
}

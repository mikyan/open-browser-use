import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";

const hash = bytes => createHash("sha256").update(bytes).digest("hex");
export const recoveryBeforeNote = "before-native-loss";
export const recoveryAfterNote = " recovered-人工π";

// Exactly one real business request; result-note/review gestures never submit.
// Hidden observation data cannot change the original viewport's scrollbars.
export function createManagedNativeRecoveryFixture() {
  const workflowId = randomUUID(), draft = `original-${randomUUID()}`;
  const paths = { form: "/managed-recovery-form", receipt: "/managed-recovery-receipt" };
  const requests = []; let originalToken = null, committed = false, overflow = false;
  const reply = (response, hit, status, body, contentType = "application/json; charset=utf-8") => {
    const data = Buffer.from(body);
    Object.assign(hit, { status, response: { bytes: data.length, sha256: hash(data), base64: data.toString("base64") } });
    response.writeHead(status, { "Content-Type": contentType, "Content-Length": data.length, "Cache-Control": "no-store" }); response.end(data);
  };
  function handle(request, response) {
    const url = new URL(request.url, "http://127.0.0.1");
    if (!Object.values(paths).includes(url.pathname)) return false;
    if (requests.length >= 8) { overflow = true; request.resume(); response.writeHead(503); response.end(); return true; }
    const hit = { sequence: requests.length + 1, method: request.method, path: url.pathname, at: Date.now(), finished: false, closed: false, aborted: false, errors: [] }; requests.push(hit);
    response.once("finish", () => { hit.finished = true; }); response.once("close", () => { hit.closed = true; hit.aborted = !response.writableFinished; });
    response.on("error", error => hit.errors.push(error.message)); request.on("error", error => hit.errors.push(error.message));
    if (url.search) { request.resume(); reply(response, hit, 400, '{"error":"unexpected query"}'); return true; }
    if (request.method === "GET" && url.pathname === paths.form) {
      request.resume();
      if (originalToken !== null) { reply(response, hit, 409, '{"error":"original document cannot be recreated"}'); return true; }
      originalToken = randomUUID(); hit.documentToken = originalToken;
      const html = `<!doctype html><meta charset="utf-8"><title>Original delivered recovery result</title>
<style>html{overflow:hidden}body{font:17px sans-serif;margin:16px;background:#edf5ff;color:#14283b}h1{font-size:22px;margin:0 0 10px}label{display:block;margin:6px 0}input{box-sizing:border-box;font:17px sans-serif;width:650px;max-width:95%;padding:5px}button{font:16px sans-serif;margin:6px 0;padding:6px}#receipt{display:block;white-space:normal;overflow-wrap:anywhere}#state{display:none}</style>
<h1>Original delivered result</h1><form id="form"><label>Original draft<input id="draft" autocomplete="off"></label><button id="submit" type="submit">Commit once</button></form>
<output id="receipt">No business receipt yet</output><label>Result note<input id="note" autocomplete="off"></label><button id="review" type="button">Mark result reviewed</button><span id="review-count">0 reviews</span><pre id="state"></pre>
<script>
const state={workflowId:${JSON.stringify(workflowId)},documentToken:${JSON.stringify(originalToken)},submits:0,receipt:null,reviews:[],events:[],overflow:false,heldKeys:[],heldButtons:[]};
const render=()=>{document.querySelector('#state').textContent=JSON.stringify(state);document.querySelector('#review-count').textContent=state.reviews.length+' reviews'};
const record=e=>{if(state.events.length>=256){state.overflow=true;render();return}const v={type:e.type,target:e.target?.id??'',trusted:e.isTrusted};if(e.type==='input'){v.inputType=e.inputType;v.data=e.data}if(e.type.startsWith('key')){v.key=e.key;v.code=e.code;if(e.type==='keydown'&&!state.heldKeys.includes(e.code))state.heldKeys.push(e.code);if(e.type==='keyup')state.heldKeys=state.heldKeys.filter(x=>x!==e.code)}if(e.type==='mousedown'){v.button=e.button;if(!state.heldButtons.includes(e.button))state.heldButtons.push(e.button)}if(e.type==='mouseup'){v.button=e.button;state.heldButtons=state.heldButtons.filter(x=>x!==e.button)}state.events.push(v);render()};
for(const name of ['keydown','keyup','mousedown','mouseup','input'])document.addEventListener(name,record,{capture:true,passive:true});
document.querySelector('#review').addEventListener('click',e=>{state.reviews.push({trusted:e.isTrusted,sequence:state.reviews.length+1});render()});
document.querySelector('#form').addEventListener('submit',async e=>{e.preventDefault();state.submits++;document.querySelector('#submit').disabled=true;render();const body=new URLSearchParams({workflowId:state.workflowId,documentToken:state.documentToken,draft:document.querySelector('#draft').value,submits:String(state.submits),trusted:String(e.isTrusted)});const r=await fetch(${JSON.stringify(paths.receipt)},{method:'POST',body});state.receipt=await r.json();document.querySelector('#receipt').textContent=state.receipt.ok?'Original receipt '+state.receipt.receiptId:'Business failed';render()});render();
</script>`;
      reply(response, hit, 200, html, "text/html; charset=utf-8"); return true;
    }
    if (request.method !== "POST" || url.pathname !== paths.receipt) { request.resume(); reply(response, hit, 405, '{"error":"method"}'); return true; }
    const chunks = []; let size = 0;
    request.on("data", data => { size += data.length; if (size <= 8192) chunks.push(data); }); request.once("aborted", () => { hit.requestAborted = true; });
    request.once("end", () => {
      const data = Buffer.concat(chunks), fields = new URLSearchParams(data.toString());
      hit.body = { bytes: size, sha256: hash(data), base64: data.toString("base64"), truncated: size > 8192 };
      const names = ["workflowId", "documentToken", "draft", "submits", "trusted"];
      if (size > 8192 || names.some(name => fields.getAll(name).length !== 1) || [...fields.keys()].some(name => !names.includes(name))) { reply(response, hit, 400, '{"error":"fields"}'); return; }
      hit.originalDocument = originalToken !== null && fields.get("documentToken") === originalToken;
      if (!hit.originalDocument || fields.get("workflowId") !== workflowId || fields.get("draft") !== draft || fields.get("submits") !== "1" || fields.get("trusted") !== "true") { reply(response, hit, 400, '{"error":"original one-shot form required"}'); return; }
      if (committed) { reply(response, hit, 409, '{"error":"receipt consumed"}'); return; }
      committed = true; hit.once = true;
      hit.receipt = { ok: true, workflowId, documentToken: originalToken, receiptId: randomUUID(), draftSHA256: hash(draft) };
      reply(response, hit, 200, JSON.stringify(hit.receipt));
    }); return true;
  }
  return { handle, paths, workflowId, draft, stats: () => structuredClone({ workflowId, originalToken, committed, overflow, requests }) };
}

export function readManagedNativeRecoveryDocument() {
  const state = JSON.parse(document.getElementById("state")?.textContent ?? "null");
  const rectangle = id => { const r = document.getElementById(id)?.getBoundingClientRect(); return r && { x: r.x, y: r.y, width: r.width, height: r.height }; };
  return { state, title: document.title, url: location.href, draft: document.getElementById("draft")?.value, note: document.getElementById("note")?.value, receiptText: document.getElementById("receipt")?.textContent,
    viewport: { width: innerWidth, height: innerHeight, clientWidth: document.documentElement.clientWidth, clientHeight: document.documentElement.clientHeight, scrollWidth: document.documentElement.scrollWidth, scrollHeight: document.documentElement.scrollHeight, scrollX, scrollY },
    boxes: Object.fromEntries(["note", "review"].map(id => [id, rectangle(id)])) };
}

export function assertManagedNativeRecoveryReceipt(stats, original, current) {
  assert.equal(stats.overflow, false); assert.equal(stats.committed, true);
  const gets = stats.requests.filter(hit => hit.method === "GET"), posts = stats.requests.filter(hit => hit.method === "POST");
  assert.equal(gets.length, 1, "The original page must not be reopened"); assert.equal(posts.length, 1, "The original business must never be replayed");
  assert.equal(gets[0].documentToken, original.state.documentToken); assert.equal(current.state.documentToken, original.state.documentToken);
  assert.equal(current.documentId, original.documentId); assert.equal(current.state.submits, 1); assert.equal(current.state.overflow, false);
  assert.deepEqual(current.state.heldKeys, []); assert.deepEqual(current.state.heldButtons, []);
  const post = posts[0]; assert.equal(post.status, 200); assert.equal(post.once, true); assert.equal(post.body.truncated, false);
  for (const evidence of [post.body, post.response]) { const data = Buffer.from(evidence.base64, "base64"); assert.equal(data.length, evidence.bytes); assert.equal(hash(data), evidence.sha256); }
  const body = new URLSearchParams(Buffer.from(post.body.base64, "base64").toString());
  assert.equal(body.get("documentToken"), original.state.documentToken); assert.equal(body.get("draft"), current.draft);
  assert.deepEqual(JSON.parse(Buffer.from(post.response.base64, "base64")), current.state.receipt); assert.deepEqual(post.receipt, current.state.receipt);
  for (const hit of stats.requests) { assert.equal(hit.finished, true); assert.equal(hit.aborted, false); assert.deepEqual(hit.errors, []); }
  return { originalDocument: current.documentId, documentToken: current.state.documentToken, gets: gets.length, posts: posts.length, receipt: post.receipt, originalBytes: post.body, originalResponseBytes: post.response };
}

import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";

// A native file input with passive event recording only. No interception,
// showPicker(), synthetic click, file assignment, upload or replay is installed.
export function createManagedHumanFileChooserFixture() {
  const workflowId = randomUUID(), route = `/human-file-chooser/${workflowId}`;
  let documentToken = null, overflow = false;
  const requests = [];
  const stats = () => structuredClone({ workflowId, route, documentToken, overflow, requests });
  const html = () => `<!doctype html><meta charset="utf-8"><title>Original file chooser</title><link rel="icon" href="data:,">
<style>body{margin:20px;font:16px sans-serif;background:#eef5ff;color:#17324d}h1{font-size:22px}
input{display:block;width:420px;height:48px;font-size:18px;margin:20px 0}pre{white-space:pre-wrap}</style>
<h1>Original file chooser</h1><label for="upload">Select one local file</label>
<input type="file" id="upload"><p>One original click. No file is supplied by this diagnostic.</p><pre id="state" hidden></pre>
<script>
const state={workflowId:${JSON.stringify(workflowId)},documentToken:${JSON.stringify(documentToken)},events:[],overflow:false};
const input=document.getElementById('upload');
const render=()=>{document.getElementById('state').textContent=JSON.stringify(state)};
for(const type of ['pointerdown','pointerup','mousedown','mouseup','click','input','change','cancel']){
input.addEventListener(type,event=>{
 if(state.events.length>=32){state.overflow=true;render();return}
 state.events.push({sequence:state.events.length+1,type,trusted:event.isTrusted,button:event.button??null,
   ctrlKey:event.ctrlKey??false,altKey:event.altKey??false,shiftKey:event.shiftKey??false,metaKey:event.metaKey??false,
   files:input.files.length});
 render();
});
}
render();
</script>`;
  function handle(request, response) {
    let url; try { url = new URL(request.url, "http://127.0.0.1"); } catch { return false; }
    if (url.pathname !== route) return false;
    request.resume();
    if (requests.length >= 8) { overflow = true; response.writeHead(429); response.end(); return true; }
    const hit = { method: request.method, path: url.pathname, exact: request.url === route, status: null, finished: false, aborted: false };
    requests.push(hit);
    response.once("finish", () => { hit.finished = true; });
    response.once("close", () => { hit.aborted = !response.writableFinished; });
    hit.status = request.url !== route ? 400 : request.method !== "GET" ? 405 : documentToken ? 409 : 200;
    if (hit.status === 200) documentToken = randomUUID();
    const body = hit.status === 200 ? html() : "Original GET only; do not replay";
    response.writeHead(hit.status, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" }); response.end(body);
    return true;
  }
  return { workflowId, route, handle, stats };
}

// Invoked in the already-owned worker through chrome.scripting; never focuses,
// scrolls, opens a chooser or accesses a file's content/path.
export function readManagedHumanFileChooserDocument() {
  const input = document.querySelector("#upload"), raw = document.querySelector("#state")?.textContent;
  if (!input || !raw) throw Error("Original chooser fixture missing");
  const rect = input.getBoundingClientRect();
  return { url: location.href, state: JSON.parse(raw), fileCount: input.files.length, inputType: input.type,
    rect: { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
    viewport: { width: innerWidth, height: innerHeight },
    clickable: !input.disabled && rect.width > 0 && rect.height > 0 &&
      document.elementFromPoint(rect.x + Math.min(40, rect.width / 2), rect.y + rect.height / 2) === input };
}

export function assertManagedHumanFileChooserDocument(before, after) {
  assert.equal(after.documentId, before.documentId); assert.equal(after.frameId, 0);
  assert.equal(after.url, before.url); assert.equal(after.state.workflowId, before.state.workflowId);
  assert.equal(after.state.documentToken, before.state.documentToken); assert.equal(after.state.overflow, false);
  assert.equal(before.fileCount, 0); assert.equal(after.fileCount, 0); assert.equal(after.inputType, "file");
  assert.deepEqual(after.state.events.slice(0, before.state.events.length), before.state.events);
  const clicks = after.state.events.slice(before.state.events.length).filter(row => row.type === "click");
  assert.equal(clicks.length, 1, "Exactly one original click; no retry");
  assert.equal(clicks[0].trusted, true); assert.equal(clicks[0].button, 0);
  for (const key of ["ctrlKey", "altKey", "shiftKey", "metaKey"]) assert.equal(clicks[0][key], false);
  assert.equal(after.state.events.some(row => ["input", "change"].includes(row.type)), false, "No diagnostic file assignment");
  return { originalDocumentId: before.documentId, documentToken: before.state.documentToken, trustedClicks: 1, selectedFiles: 0 };
}

export const managedFileWorkflowCases = Object.freeze(["root", "oopif", "transfer-end", "transfer-navigation"]);
export function managedFileWorkflowPayloads(kind) {
  assert.ok(managedFileWorkflowCases.includes(kind));
  if (kind === "oopif") return [{ name: "same.txt", mimeType: "text/plain", buffer: Buffer.from("Original child 中文 \0 bytes\n") },
    { name: "same.txt", mimeType: "text/plain", buffer: Buffer.alloc(0) }];
  const buffer = Buffer.alloc(kind === "root" ? 40001 : 16 * 1024 * 1024);
  for (let i = 0; i < buffer.length; i++) buffer[i] = i * 37 % 251;
  return [{ name: kind === "root" ? "original.bin" : "unfinished.bin", mimeType: "application/octet-stream", buffer }];
}

export function createManagedFileWorkflowFixture({ baseURL, kind }) {
  assert.ok(managedFileWorkflowCases.includes(kind));
  const base = new URL(baseURL); assert.equal(base.hostname, "127.0.0.1"); assert.equal(base.protocol, "http:");
  const workflowId = randomUUID(), prefix = `/human-files/${workflowId}/`;
  const root = new URL(prefix + "root", base), leaf = new URL(prefix + "leaf", base);
  if (kind === "oopif") leaf.hostname = "localhost";
  const emitter = kind === "oopif" ? leaf : root;
  const urls = { root: root.href, emitter: emitter.href, receipt: new URL(prefix + "receipt", emitter).href,
    gate: new URL(prefix + "gate", emitter).href, landed: new URL(prefix + "landed", emitter).href };
  const tokens = {}, requests = []; let overflow = false, posted = false, receipt = null, gateResponse = null, gateReleased = false;
  const stats = () => structuredClone({ workflowId, kind, urls, tokens, requests, overflow, posted, receipt, gateReleased });
  const json = value => JSON.stringify(value).replaceAll("<", "\\u003c");
  const page = role => {
    const active = role === (kind === "oopif" ? "leaf" : "root");
    const state = { workflowId, kind, role, documentToken: tokens[role], events: [], overflow: false, posts: 0, phase: "ready", error: null };
    return `<!doctype html><meta charset="utf-8"><title>Original ${kind} upload</title><link rel="icon" href="data:,">
<style>*{box-sizing:border-box}body{margin:8px;font:15px sans-serif;background:#eef5ff;color:#17324d}h1{font-size:18px;margin:0 0 8px}input{display:block;width:420px;height:42px;margin:12px 0;font:16px sans-serif}iframe{width:700px;height:265px;border:2px solid #789}button{padding:8px;font:16px sans-serif}</style>
<h1>${kind} ${role}</h1>${active ? `<form id="form"><input id="upload" type="file" ${kind === "oopif" ? "multiple" : ""}><button id="submit">Submit original files</button></form>` : `<iframe id="child" src=${json(urls.emitter)}></iframe>`}<pre id="state" hidden></pre><pre id="receipt"></pre>
<script>const state=${json(state)},render=()=>document.getElementById('state').textContent=JSON.stringify(state);
const input=document.getElementById('upload');
const metadata=()=>Array.from(input?.files??[],f=>({name:f.name,size:f.size,type:f.type,lastModified:f.lastModified}));
${active ? `for(const type of ['click','input','change','cancel'])input.addEventListener(type,e=>{if(state.events.length>=32){state.overflow=true;render();return}state.events.push({type,trusted:e.isTrusted,files:metadata()});render()});
document.getElementById('form').addEventListener('submit',async e=>{e.preventDefault();state.events.push({type:'submit',trusted:e.isTrusted,files:metadata()});if(state.posts++)throw Error('No replay');
state.phase='posting';render();try{const files=[];for(const f of input.files){const bytes=new Uint8Array(await f.arrayBuffer());let binary='';for(const b of bytes)binary+=String.fromCharCode(b);files.push({name:f.name,size:f.size,data:btoa(binary)})}
const response=await fetch(${json(urls.receipt)},{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({workflowId:state.workflowId,documentToken:state.documentToken,posts:state.posts,files,events:state.events})});
const receipt=await response.json();document.getElementById('receipt').textContent=JSON.stringify(receipt);if(!response.ok||!receipt.ok)throw Error('Original upload rejected');state.phase='committed';render()}catch(error){state.error=String(error);state.phase='failed';render()}});
${kind === "transfer-navigation" ? `fetch(${json(urls.gate)}).then(r=>{if(!r.ok)throw Error('gate failed');return r.json()}).then(v=>{if(v.navigate===true)location.href=${json(urls.landed)}}).catch(e=>{state.error=String(e);render()});` : ""}` : ""}
render();</script>`;
  };
  const reply = (res, hit, code, body, type = "application/json") => {
    hit.status = code; res.writeHead(code, { "Content-Type": type, "Cache-Control": "no-store" }); res.end(body);
  };
  const handle = (req, res) => {
    let url; try { url = new URL(req.url, base); } catch { return false; }
    if (!url.pathname.startsWith(prefix)) return false;
    if (requests.length >= 16) { overflow = true; req.resume(); res.writeHead(429); res.end(); return true; }
    const hit = { method: req.method, path: url.pathname, host: req.headers.host, at: Date.now(), finished: false, aborted: false }; requests.push(hit);
    res.once("finish", () => { hit.finished = true; }); res.once("close", () => { hit.aborted = !res.writableFinished; });
    const role = ["root", "leaf", "landed"].find(value => url.pathname === prefix + value);
    const expected = role === "root" ? root : new URL(role === "leaf" ? urls.emitter : role === "landed" ? urls.landed : url.pathname === prefix + "gate" ? urls.gate : urls.receipt);
    if (req.url !== url.pathname || req.headers.host !== expected.host) { req.resume(); reply(res, hit, 400, "{}"); return true; }
    if (req.method === "GET" && role) {
      req.resume(); if (tokens[role] || role === "leaf" && (!tokens.root || kind !== "oopif") || role === "landed" && !gateReleased) { reply(res, hit, 409, "{}"); return true; }
      tokens[role] = randomUUID();
      reply(res, hit, 200, role === "landed" ? `<!doctype html><title>Navigation finished</title><link rel="icon" href="data:,"><pre id="state">${json({ workflowId, role, documentToken: tokens[role], phase: "landed", events: [], overflow: false })}</pre>` : page(role), "text/html; charset=utf-8"); return true;
    }
    if (req.method === "GET" && url.pathname === prefix + "gate" && kind === "transfer-navigation" && !gateResponse) {
      req.resume(); gateResponse = { res, hit }; return true;
    }
    if (req.method !== "POST" || url.pathname !== prefix + "receipt" || !["root", "oopif"].includes(kind)) { req.resume(); reply(res, hit, 405, "{}"); return true; }
    const duplicate = posted; posted = true; let size = 0; const chunks = [];
    req.on("data", data => { size += data.length; if (size <= 256 * 1024) chunks.push(data); });
    req.once("end", () => {
      if (duplicate || size > 256 * 1024) { reply(res, hit, 409, "{}"); return; }
      try {
        const raw = Buffer.concat(chunks), body = JSON.parse(raw);
        hit.bodySHA256 = createHash("sha256").update(raw).digest("hex"); hit.bodyBytes = size;
        assert.equal(body.workflowId, workflowId); assert.equal(body.documentToken, tokens[kind === "oopif" ? "leaf" : "root"]); assert.equal(body.posts, 1);
        const expectedFiles = managedFileWorkflowPayloads(kind);
        assert.equal(body.files.length, expectedFiles.length);
        const files = body.files.map((file, i) => {
          assert.equal(file.name, expectedFiles[i].name); assert.equal(file.size, expectedFiles[i].buffer.length);
          const bytes = Buffer.from(file.data, "base64"); assert.equal(bytes.toString("base64"), file.data); assert.deepEqual(bytes, expectedFiles[i].buffer);
          return { name: file.name, size: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex") };
        });
        assert.equal(body.events.filter(row => row.type === "submit").length, 1); assert.ok(body.events.every(row => row.trusted));
        receipt = { ok: true, workflowId, documentToken: body.documentToken, files, events: body.events, posts: 1 };
        reply(res, hit, 200, JSON.stringify(receipt));
      } catch (error) { hit.validationError = String(error); reply(res, hit, 400, '{"ok":false}'); }
    }); return true;
  };
  return { kind, workflowId, urls, handle, stats, releaseNavigation() {
    assert.equal(kind, "transfer-navigation"); assert.ok(gateResponse && !gateReleased);
    gateReleased = true; reply(gateResponse.res, gateResponse.hit, 200, '{"navigate":true}');
  } };
}

export function readManagedFileWorkflowDocument() {
  const raw = document.getElementById("state")?.textContent;
  if (!raw) return null; // A loading child may still be about:blank; it is never treated as an original document.
  const state = JSON.parse(raw), input = document.getElementById("upload"), child = document.getElementById("child"), submit = document.getElementById("submit");
  const rectangle = element => { if (!element) return null; const r = element.getBoundingClientRect(); return { x: r.x, y: r.y, width: r.width, height: r.height }; };
  const submitRect = rectangle(submit), style = submit ? getComputedStyle(submit) : null;
  const centerHit = submitRect ? document.elementFromPoint(submitRect.x + submitRect.width / 2, submitRect.y + submitRect.height / 2) : null;
  return { url: location.href, state, files: Array.from(input?.files ?? [], f => ({ name: f.name, size: f.size, type: f.type, lastModified: f.lastModified })),
    inputRect: rectangle(input), childRect: rectangle(child), childInset: child ? { x: child.clientLeft, y: child.clientTop } : null,
    documentVisibility: { state: document.visibilityState, hidden: document.hidden, hasFocus: document.hasFocus() },
    submit: submit ? { rect: submitRect, disabled: submit.disabled, hidden: submit.hidden,
      display: style.display, visibility: style.visibility, pointerEvents: style.pointerEvents,
      centerHit: centerHit ? { id: centerHit.id.slice(0, 64), tag: centerHit.tagName.slice(0, 32), isSubmit: centerHit === submit } : null } : null,
    viewport: { width: innerWidth, height: innerHeight }, receipt: JSON.parse(document.getElementById("receipt")?.textContent || "null") };
}

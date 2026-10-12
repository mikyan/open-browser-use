import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";

const prefix = "/created-page/";
const describe = bytes => ({ bytes: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex"), base64: bytes.toString("base64") });
const json = value => JSON.stringify(value).replaceAll("<", "\\u003c");
const shell = content => `<!doctype html><meta charset="utf-8"><title>Created page provenance</title><style>body{font:16px sans-serif;padding:20px}a,button{display:inline-block;padding:18px;margin:12px}iframe{width:620px;height:260px;border:4px solid #345}label{display:block;margin:12px}input{padding:8px}</style>${content}`;

function sourceHTML(record, nonce, frame, port) {
  const childURL = `http://127.0.0.1:${port}${prefix}child`, frameURL = `http://localhost:${port}${prefix}frame?key=${encodeURIComponent(record.key)}`;
  const link = frame || record.variant === "root", dynamic = !frame && record.variant === "dynamic-oopif";
  return shell(`${link ? `<a id="open-child" href="${childURL}">Open original child</a>` : dynamic ? '<button id="add-frame">Add source frame</button>' : `<iframe id="created-page-frame" src="${frameURL}"></iframe>`}<pre id="state"></pre><script>(()=>{
    const state={...${json({ key: record.key, owner: record.owner, variant: record.variant, sourceNonce: nonce })},documentToken:crypto.randomUUID(),clicks:[],frameAdds:[]};
    const render=()=>document.querySelector('#state').textContent=JSON.stringify(state),link=document.querySelector('#open-child'),add=document.querySelector('#add-frame');
    if(link)link.addEventListener('click',event=>{state.clicks.push({trusted:event.isTrusted,ctrlKey:event.ctrlKey,metaKey:event.metaKey,altKey:event.altKey,shiftKey:event.shiftKey,button:event.button,sourceNonce:state.sourceNonce,documentToken:state.documentToken,href:link.href,sequence:state.clicks.length+1});render()});
    if(add)add.addEventListener('click',event=>{state.frameAdds.push({trusted:event.isTrusted,sequence:state.frameAdds.length+1});const frame=document.createElement('iframe');frame.id='created-page-frame';frame.src=${json(frameURL)};document.body.append(frame);add.disabled=true;render()});render();
  })();</script>`);
}

function childHTML(nonce) {
  return shell(`<form id="receipt"><label>Source key<input name="key"></label><label>Owner<input name="owner"></label><button id="commit" type="submit">Commit child receipt</button></form><pre id="state"></pre><output id="result"></output><script>(()=>{
    const state={documentNonce:${json(nonce)},documentToken:crypto.randomUUID(),clicks:[]},form=document.querySelector('#receipt'),render=()=>document.querySelector('#state').textContent=JSON.stringify(state);
    document.querySelector('#commit').addEventListener('click',event=>{state.clicks.push({trusted:event.isTrusted,sequence:state.clicks.length+1,documentNonce:state.documentNonce,documentToken:state.documentToken});render()});
    form.addEventListener('submit',async event=>{event.preventDefault();const click=state.clicks.at(-1),body={key:form.elements.key.value,owner:form.elements.owner.value,documentNonce:state.documentNonce,documentToken:state.documentToken,trusted:String(click?.trusted),buttonCount:String(state.clicks.length)};const response=await fetch('${prefix}receipt',{method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded'},body:new URLSearchParams(body)});document.querySelector('#result').textContent=await response.text()});render();
  })();</script>`);
}

export function createCreatedPageFixtures() {
  const cases = new Map(), children = new Map(), requests = []; let overflow = false;
  const reply = (response, hit, status, bytes, type = "text/plain; charset=utf-8") => {
    hit.status = status; hit.response = describe(bytes);
    response.writeHead(status, { "Content-Type": type, "Content-Length": bytes.length, "Cache-Control": "no-store" }); response.end(bytes);
  };
  const fail = (response, hit, status, error) => { hit.error = error; reply(response, hit, status, Buffer.from(error)); };
  return {
    createCase({ owner, variant, key = randomUUID() }) {
      assert.ok(typeof owner === "string" && owner.length > 0 && owner.length <= 100);
      assert.ok(["root", "oopif", "dynamic-oopif"].includes(variant)); assert.match(key, /^[a-zA-Z0-9._-]{1,100}$/);
      assert.ok(cases.size < 16 && !cases.has(key), "Created page fixture case limit or duplicate");
      const record = { key, owner, variant, urlPath: prefix + "source?key=" + encodeURIComponent(key), documents: [], requests: [] };
      cases.set(key, record); return structuredClone(record);
    },
    stats(key) { assert.ok(cases.has(key)); return structuredClone(cases.get(key)); },
    allStats: () => structuredClone({ cases: [...cases.values()], children: [...children.values()], requests, overflow }),
    handle(request, response) {
      const url = new URL(request.url, "http://127.0.0.1"); if (!url.pathname.startsWith(prefix)) return false;
      if (requests.length >= 128) { overflow = true; response.writeHead(503); response.end("FIXTURE_LIMIT"); request.resume(); return true; }
      const hit = { sequence: requests.length, at: Date.now(), method: request.method, url: request.url, status: null, finished: false, closed: false, aborted: false, errors: [] }; requests.push(hit);
      response.once("finish", () => { hit.finished = true; }); response.once("close", () => { hit.closed = true; hit.aborted = !response.writableFinished; });
      response.on("error", error => hit.errors.push(String(error))); request.on("error", error => hit.errors.push(String(error)));
      if ([prefix + "source", prefix + "frame"].includes(url.pathname)) {
        request.resume(); const record = cases.get(url.searchParams.get("key"));
        if (request.method !== "GET" || !record) { fail(response, hit, 404, "UNKNOWN_SOURCE"); return true; }
        const nonce = randomUUID(), bytes = Buffer.from(sourceHTML(record, nonce, url.pathname.endsWith("/frame"), request.socket.localPort));
        record.documents.push({ nonce, url: request.url, ...describe(bytes) }); record.requests.push(hit);
        reply(response, hit, 200, bytes, "text/html; charset=utf-8"); return true;
      }
      if (url.pathname === prefix + "child") {
        request.resume();
        if (request.method !== "GET" || url.search || children.size >= 32) { fail(response, hit, 400, "INVALID_CHILD_REQUEST"); return true; }
        const nonce = randomUUID(), bytes = Buffer.from(childHTML(nonce));
        children.set(nonce, { nonce, get: hit, html: describe(bytes), posts: [], consumed: false });
        reply(response, hit, 200, bytes, "text/html; charset=utf-8"); return true;
      }
      if (url.pathname !== prefix + "receipt" || request.method !== "POST" || url.search) { request.resume(); fail(response, hit, 405, "INVALID_RECEIPT_REQUEST"); return true; }
      const chunks = []; let size = 0;
      request.on("data", chunk => { if (size < 8192) chunks.push(chunk.subarray(0, 8192 - size)); size += chunk.length; hit.receivedBytes = size; });
      request.once("aborted", () => { hit.requestAborted = true; hit.body = { ...describe(Buffer.concat(chunks)), truncated: size > 8192 }; });
      request.once("end", () => {
        const bytes = Buffer.concat(chunks); hit.body = { ...describe(bytes), truncated: size > 8192 };
        const fields = new URLSearchParams(bytes.toString()); hit.fieldEntries = [...fields]; hit.fields = Object.fromEntries(fields);
        const names = ["key", "owner", "documentNonce", "documentToken", "trusted", "buttonCount"];
        if (size > 8192 || names.some(name => fields.getAll(name).length !== 1) || [...fields.keys()].some(name => !names.includes(name))) { fail(response, hit, 400, "INVALID_RECEIPT_FIELDS"); return; }
        const record = cases.get(fields.get("key")), child = children.get(fields.get("documentNonce"));
        if (!record || record.owner !== fields.get("owner") || !child || !fields.get("documentToken")) { fail(response, hit, 403, "WRONG_DOCUMENT_OR_OWNER"); return; }
        record.requests.push(hit); child.posts.push(hit);
        if (child.consumed) { fail(response, hit, 409, "CHILD_ALREADY_CONSUMED"); return; }
        child.consumed = true;
        if (fields.get("trusted") !== "true" || fields.get("buttonCount") !== "1") { fail(response, hit, 400, "INVALID_CHILD_CLICK"); return; }
        hit.once = true; reply(response, hit, 200, Buffer.from(JSON.stringify({ ok: true, key: record.key, owner: record.owner, documentNonce: child.nonce })));
      });
      return true;
    }
  };
}

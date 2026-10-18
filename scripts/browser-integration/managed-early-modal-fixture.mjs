import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";

export const managedEarlyModalCases = Object.freeze(["cold-runtime", "warm-document"]);
export const managedEarlyModalUnicode = "首帧之前 · 原始回答 ✅";
const encoded = value => { const bytes = Buffer.from(value); return { bytes: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex"), base64: bytes.toString("base64") }; };
const js = value => JSON.stringify(value).replaceAll("<", "\\u003c");

// The HTTP gate only orders the fixture. It cannot prove a native dialog exists.
// The same original document is usable later by a real viewer; this module never
// attaches, responds to a dialog, injects input, navigates or replays a request.
export function createManagedEarlyModalFixture({ baseURL, caseId, answerMode = "cancel-only" }) {
  const base = new URL(baseURL);
  assert.equal(base.protocol, "http:"); assert.equal(base.hostname, "127.0.0.1");
  assert.ok(Number(base.port) >= 49152 && Number(base.port) <= 65535);
  assert.equal(base.pathname, "/"); assert.equal(base.search + base.hash + base.username + base.password, "");
  assert.ok(managedEarlyModalCases.includes(caseId)); assert.ok(["cancel-only", "viewer-unicode"].includes(answerMode));
  const workflowId = randomUUID(), prefix = `/early-modal/${workflowId}/`;
  const urls = Object.fromEntries(["source", "gate", "entered", "receipt"].map(role => [role, new URL(prefix + role, base).href]));
  const prompt = Object.freeze({ type: "prompt", message: `Original ${caseId} early prompt`, defaultPrompt: "原始默认值" });
  const expectedAnswer = answerMode === "cancel-only" ? null : managedEarlyModalUnicode;
  const requests = []; let documentToken, overflow = false, receipt = null, attempted = false, gate, gateReleased = false;
  const stats = () => structuredClone({ workflowId, caseId, answerMode, urls, documentToken, requests, overflow, receipt, gateReleased });
  function expectedBody() {
    assert.ok(documentToken);
    return { workflowId, caseId, documentToken, events: [{ phase: "before", type: "prompt" }, { phase: "after", type: "prompt", answer: expectedAnswer }], answer: expectedAnswer, postAttempts: 1 };
  }
  function html() {
    const state = { workflowId, caseId, documentToken, phase: "waiting", events: [], answer: null, postAttempts: 0, error: null };
    return `<!doctype html><meta charset="utf-8"><title>Original early modal</title><link rel="icon" href="data:,">
<style>body{font:18px sans-serif;margin:20px;background:#edf4ff;color:#17324d}pre{white-space:pre-wrap}[hidden]{display:none!important}</style>
<h1>${caseId}</h1><p id="phase"></p><pre id="state" hidden></pre><pre id="result"></pre><script>
const state=${js(state)},render=()=>{document.querySelector('#state').textContent=JSON.stringify(state);document.querySelector('#phase').textContent=state.phase};render();
(async()=>{try{const gate=await fetch(${js(urls.gate)},{cache:'no-store'});if(!gate.ok||await gate.text()!=='release-original-once')throw Error('original gate rejected');
state.phase='dialog';state.events.push({phase:'before',type:'prompt'});render();
fetch(${js(urls.entered)},{cache:'no-store'}).catch(()=>{});
const answer=window.prompt(${js(prompt.message)},${js(prompt.defaultPrompt)});
if(answer!==${js(expectedAnswer)})throw Error('unexpected original answer');
state.answer=answer;state.events.push({phase:'after',type:'prompt',answer});state.postAttempts++;state.phase='posting';render();
const body={workflowId:state.workflowId,caseId:state.caseId,documentToken:state.documentToken,events:state.events,answer:state.answer,postAttempts:state.postAttempts};
const response=await fetch(${js(urls.receipt)},{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});
const result=await response.json();document.querySelector('#result').textContent=JSON.stringify(result);if(!response.ok||result.ok!==true)throw Error('original receipt rejected');state.phase='committed';render();
}catch(error){state.error=String(error).slice(0,1024);state.phase='failed';render()}})();
</script>`;
  }
  function handle(request, response) {
    let url; try { url = new URL(request.url, base); } catch { return false; }
    if (!url.pathname.startsWith(prefix)) return false;
    if (requests.length >= 16) { overflow = true; request.resume(); response.writeHead(429); response.end(); return true; }
    const hit = { sequence: requests.length + 1, at: Date.now(), method: request.method, host: request.headers.host, url: request.url, body: encoded(""), finished: false, aborted: false, errors: [] }; requests.push(hit);
    response.once("finish", () => { hit.finished = true; }); response.once("close", () => { hit.aborted = !response.writableFinished; });
    for (const stream of [request, response]) stream.once("error", error => hit.errors.push(String(error).slice(0, 256)));
    const reply = (status, text, type = "application/json; charset=utf-8") => { const bytes = Buffer.from(text); hit.status = status; hit.response = encoded(bytes); response.writeHead(status, { "Content-Type": type, "Content-Length": bytes.length, "Cache-Control": "no-store" }); response.end(bytes); };
    const reject = (status, message) => { request.resume(); reply(status, JSON.stringify({ ok: false, error: message })); };
    if (request.url !== url.pathname || request.headers.host !== base.host) { reject(400, "exact original host/route required"); return true; }
    const role = Object.keys(urls).find(role => new URL(urls[role]).pathname === url.pathname);
    if (!role) { reject(404, "unknown original route"); return true; }
    if (request.method === "GET") {
      request.resume();
      if (requests.some(row => row !== hit && row.method === "GET" && row.url === request.url)) { reject(409, "GET replay forbidden"); return true; }
      if (role === "source") { documentToken = randomUUID(); hit.documentToken = documentToken; reply(200, html(), "text/html; charset=utf-8"); return true; }
      if (role === "gate" && documentToken) { gate = { reply }; return true; }
      if (role === "entered" && documentToken && gateReleased) { reply(200, '{"observed":"before-call-marker-only"}'); return true; }
      reject(409, "original document order required"); return true;
    }
    if (request.method !== "POST" || role !== "receipt") { reject(405, "original receipt POST required"); return true; }
    const duplicate = attempted; attempted = true; let size = 0; const chunks = [];
    request.on("data", bytes => { size += bytes.length; if (size <= 16384) chunks.push(bytes); });
    request.once("end", () => {
      const bytes = Buffer.concat(chunks); hit.body = { ...encoded(bytes), receivedBytes: size, truncated: size > 16384 };
      if (duplicate || size > 16384) { reply(duplicate ? 409 : 413, '{"ok":false}'); return; }
      try {
        assert.ok(gateReleased && requests.some(row => row.url === new URL(urls.entered).pathname && row.status === 200));
        const body = JSON.parse(bytes); assert.equal(JSON.stringify(body), bytes.toString()); assert.deepEqual(body, expectedBody());
        receipt = { ok: true, workflowId, caseId, documentToken, answer: expectedAnswer, postAttempts: 1, receiptId: randomUUID() }; reply(200, JSON.stringify(receipt));
      } catch { reply(400, '{"ok":false,"error":"original evidence mismatch"}'); }
    }); return true;
  }
  function releaseGate() { assert.ok(gate && !gateReleased); gateReleased = true; gate.reply(200, "release-original-once", "text/plain; charset=utf-8"); return { at: Date.now(), scope: "server gate release is not native modal proof" }; }
  function verify(document) {
    assert.ok(receipt); assert.equal(overflow, false); assert.equal(requests.filter(row => row.method === "POST").length, 1);
    assert.ok(requests.every(row => row.finished && !row.aborted && !row.errors.length && row.status === 200));
    assert.deepEqual(requests.map(row => row.url).sort(), Object.values(urls).map(url => new URL(url).pathname).sort());
    assert.equal(document.url, urls.source); assert.equal(document.state.phase, "committed"); assert.equal(document.state.error, null);
    for (const [key, value] of Object.entries(expectedBody())) assert.deepEqual(document.state[key], value);
    assert.deepEqual(document.result, receipt); return structuredClone(receipt);
  }
  return { workflowId, caseId, answerMode, urls: Object.freeze(urls), emitterRole: "source", prompt, handle, stats, releaseGate, verify };
}

export function readManagedEarlyModalDocument() { const read = id => JSON.parse(document.querySelector(id).textContent || "null"); return { url: location.href, state: read("#state"), result: read("#result") }; }

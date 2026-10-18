import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { managedDialogUnicode } from "./managed-dialog-fixture.mjs";

export const managedFrameDialogLayouts = Object.freeze(["root", "same", "nested", "oopif"]);
const encode = value => { const bytes = Buffer.from(value); return { bytes: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex"), base64: bytes.toString("base64") }; };
const scriptJSON = value => JSON.stringify(value).replaceAll("<", "\\u003c");

// The emitter itself opens the native prompt and posts its actual return. Parent
// documents do not relay answers or requests. No synthetic input or replay.
export function createManagedFrameDialogFixture({ baseURL, layout }) {
  const base = new URL(baseURL);
  assert.equal(base.protocol, "http:"); assert.equal(base.hostname, "127.0.0.1");
  assert.ok(Number(base.port) >= 49152 && Number(base.port) <= 65535);
  assert.equal(base.pathname, "/"); assert.equal(base.search + base.hash + base.username + base.password, "");
  assert.ok(managedFrameDialogLayouts.includes(layout));
  const workflowId = randomUUID(), prefix = `/managed-frame-dialog/${workflowId}/`;
  const roles = layout === "root" ? ["root"] : layout === "nested" ? ["root", "middle", "leaf"] : ["root", "leaf"];
  const emitterRole = roles.at(-1), urls = Object.fromEntries(roles.map(role => {
    const url = new URL(prefix + role, base); if (layout === "oopif" && role === "leaf") url.hostname = "localhost";
    return [role, url.href];
  }));
  const receiptURL = new URL(prefix + "receipt", urls[emitterRole]).href;
  const prompt = Object.freeze({ type: "prompt", message: `Original ${layout} frame prompt`, defaultValue: "原始默认值" });
  const tokens = {}, requests = []; let postAttempted = false, committed = false, overflow = false, requestCount = 0, receipt = null;
  const stats = () => structuredClone({ workflowId, layout, roles, emitterRole, urls, receiptURL, tokens, requests, requestCount, postAttempted, committed, overflow, receipt });
  function page(role) {
    const emitter = role === emitterRole, child = roles[roles.indexOf(role) + 1];
    const state = { workflowId, layout, role, documentToken: tokens[role], rootDocumentToken: tokens.root, phase: emitter ? "ready" : "container", clicks: [], events: [], answer: null, postAttempts: 0, error: null };
    return `<!doctype html><meta charset="utf-8"><title>Original ${layout} ${role}</title><link rel="icon" href="data:,">
<style>*{box-sizing:border-box}html,body{margin:0;width:100%;height:100%;overflow:hidden}body{padding:8px;font:15px sans-serif;background:#eef5ff;color:#17324d}h1{font-size:18px;margin:0 0 8px}button{font:16px sans-serif;padding:9px 14px}iframe{display:block;width:calc(100% - 16px);height:220px;border:2px solid #789;margin:8px 0}pre{white-space:pre-wrap;overflow-wrap:anywhere}[hidden]{display:none!important}</style>
<h1>${layout} · ${role}</h1>${emitter ? '<button id="prompt" type="button">Open original prompt</button>' : `<iframe id="child" title="Original ${child}" src=${scriptJSON(urls[child])}></iframe>`}
<p id="phase">${state.phase}</p><pre id="state" hidden></pre><pre id="result"></pre><script>
const state=${scriptJSON(state)},render=()=>{document.querySelector('#state').textContent=JSON.stringify(state);document.querySelector('#phase').textContent=state.phase};
${emitter ? `document.querySelector('#prompt').addEventListener('click',async event=>{
if(state.clicks.length>=4)return;
const click={trusted:event.isTrusted,button:event.button,ctrlKey:event.ctrlKey,altKey:event.altKey,shiftKey:event.shiftKey,metaKey:event.metaKey};state.clicks.push(click);
if(state.clicks.length!==1||state.phase!=='ready'||!click.trusted||click.button!==0||click.ctrlKey||click.altKey||click.shiftKey||click.metaKey){state.error='one original unmodified trusted click required';state.phase='failed';render();return}
event.currentTarget.disabled=true;state.phase='dialog';state.events.push({phase:'before',type:'prompt'});render();
try{const answer=window.prompt(${scriptJSON(prompt.message)},${scriptJSON(prompt.defaultValue)});
if(answer!==null&&(typeof answer!=='string'||answer.length>1024))throw Error('bounded native return required');
state.answer=answer;state.events.push({phase:'after',type:'prompt',answer});state.postAttempts++;state.phase='posting';render();
const body={workflowId:state.workflowId,layout:state.layout,role:state.role,documentToken:state.documentToken,rootDocumentToken:state.rootDocumentToken,clicks:state.clicks,events:state.events,answer:state.answer,postAttempts:state.postAttempts};
const response=await fetch(${scriptJSON(receiptURL)},{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});
const result=await response.json();document.querySelector('#result').textContent=JSON.stringify(result);if(!response.ok||result.ok!==true)throw Error('original receipt rejected');state.phase='committed';render();
}catch(error){state.error=String(error).slice(0,1024);state.phase='failed';render()}});` : ""}
render();</script>`;
  }
  const expectedBody = answer => ({ workflowId, layout, role: emitterRole, documentToken: tokens[emitterRole], rootDocumentToken: tokens.root,
    clicks: [{ trusted: true, button: 0, ctrlKey: false, altKey: false, shiftKey: false, metaKey: false }],
    events: [{ phase: "before", type: "prompt" }, { phase: "after", type: "prompt", answer }], answer, postAttempts: 1 });
  function handle(request, response) {
    let url; try { url = new URL(request.url, base); } catch { return false; }
    if (!url.pathname.startsWith(prefix)) return false;
    requestCount++;
    if (requests.length >= 24) { overflow = true; request.resume(); response.writeHead(429); response.end(); return true; }
    const hit = { sequence: requests.length + 1, at: Date.now(), method: request.method, host: request.headers.host, target: encode(request.url), body: encode(""), finished: false, aborted: false, errors: [] };
    requests.push(hit); response.once("finish", () => { hit.finished = true; }); response.once("close", () => { hit.aborted = !response.writableFinished; });
    for (const stream of [request, response]) stream.once("error", error => hit.errors.push(String(error).slice(0, 256)));
    const reply = (status, value, type = "application/json; charset=utf-8") => { const bytes = Buffer.from(value); hit.status = status; hit.response = encode(bytes); response.writeHead(status, { "Content-Type": type, "Content-Length": bytes.length, "Cache-Control": "no-store" }); response.end(bytes); };
    const reject = (status, error) => { request.resume(); reply(status, JSON.stringify({ ok: false, error })); };
    if (request.url !== url.pathname) { reject(400, "exact original route required"); return true; }
    const role = roles.find(role => new URL(urls[role]).pathname === url.pathname), isReceipt = url.pathname === new URL(receiptURL).pathname;
    const expectedURL = role ? new URL(urls[role]) : isReceipt ? new URL(receiptURL) : null;
    if (!expectedURL || request.headers.host !== expectedURL.host) { reject(400, "exact original host and route required"); return true; }
    if (request.method === "GET" && role) {
      request.resume(); const index = roles.indexOf(role);
      if (tokens[role] || index > 0 && !tokens[roles[index - 1]]) { reject(409, "original ordered document required"); return true; }
      tokens[role] = randomUUID(); hit.documentToken = tokens[role]; reply(200, page(role), "text/html; charset=utf-8"); return true;
    }
    if (request.method !== "POST" || !isReceipt) { reject(405, "original method required"); return true; }
    const repeated = postAttempted; postAttempted = true; const chunks = []; let size = 0;
    request.on("data", bytes => { size += bytes.length; if (size <= 16384) chunks.push(bytes); });
    request.once("end", () => {
      const bytes = Buffer.concat(chunks); hit.body = { ...encode(bytes), receivedBytes: size, truncated: size > 16384 };
      if (repeated || size > 16384) { reply(repeated ? 409 : 413, '{"ok":false,"error":"bounded single original POST required"}'); return; }
      try {
        assert.ok(roles.every(role => tokens[role])); const raw = bytes.toString("utf8"), body = JSON.parse(raw); assert.equal(JSON.stringify(body), raw);
        assert.ok(body.answer === null || body.answer === managedDialogUnicode, "only the original diagnostic cancellation or defined viewer answer");
        assert.deepEqual(body, expectedBody(body.answer));
        committed = true; receipt = { ok: true, workflowId, layout, role: emitterRole, documentToken: tokens[emitterRole], rootDocumentToken: tokens.root, receiptId: randomUUID(), answer: body.answer, postAttempts: 1 };
        reply(200, JSON.stringify(receipt));
      } catch { reply(400, '{"ok":false,"error":"complete original emitter evidence required"}'); }
    }); return true;
  }
  function verify(documents, { answer }) {
    assert.ok(answer === null || answer === managedDialogUnicode); assert.equal(committed, true); assert.equal(overflow, false);
    assert.equal(requests.length, roles.length + 1);
    assert.deepEqual(requests.map(row => [row.method, row.status]), [...roles.map(() => ["GET", 200]), ["POST", 200]]);
    assert.ok(requests.every(row => row.finished && !row.aborted && row.errors.length === 0));
    assert.equal(documents.length, roles.length);
    for (const role of roles) {
      const rows = documents.filter(row => row.state?.role === role); assert.equal(rows.length, 1); const row = rows[0];
      assert.equal(row.url, urls[role]); assert.equal(row.state.documentToken, tokens[role]); assert.equal(row.state.rootDocumentToken, tokens.root);
      assert.equal(row.state.workflowId, workflowId); assert.equal(row.state.layout, layout); assert.equal(row.state.error, null);
      if (role !== emitterRole) { assert.equal(row.state.phase, "container"); assert.deepEqual(row.state.clicks, []); assert.equal(row.state.postAttempts, 0); }
      else { for (const [key, value] of Object.entries(expectedBody(answer))) assert.deepEqual(row.state[key], value); assert.equal(row.state.phase, "committed"); assert.deepEqual(row.result, receipt); }
    }
    return structuredClone(receipt);
  }
  return { handle, stats, verify, workflowId, layout, roles: [...roles], emitterRole, urls: Object.freeze(urls), receiptURL, prompt };
}

// Executed only as read-only functions in explicit original browser documents.
export function readManagedFrameDialogDocument() {
  const read = selector => { const raw = document.querySelector(selector)?.textContent; return raw ? JSON.parse(raw) : null; };
  return { state: read("#state"), result: read("#result"), url: location.href, viewport: { width: innerWidth, height: innerHeight, scrollX, scrollY, devicePixelRatio } };
}
export function measureManagedFrameDialogElement(id) {
  if (!["prompt", "child"].includes(id)) throw Error("known original fixture element required");
  const node = document.getElementById(id); if (!node || node.tagName !== (id === "prompt" ? "BUTTON" : "IFRAME")) throw Error("original fixture element missing");
  const r = node.getBoundingClientRect(), style = getComputedStyle(node), point = { x: r.x + r.width / 2, y: r.y + r.height / 2 };
  if (style.transform !== "none" || style.zoom !== "1") throw Error("fixture geometry must remain untransformed");
  const hit = document.elementFromPoint(point.x, point.y), visible = r.width > 0 && r.height > 0 && point.x > 0 && point.x < innerWidth && point.y > 0 && point.y < innerHeight && style.display !== "none" && style.visibility === "visible";
  return { id, rect: { x: r.x, y: r.y, width: r.width, height: r.height }, contentOffset: { x: node.clientLeft, y: node.clientTop }, contentSize: { width: node.clientWidth, height: node.clientHeight }, point,
    clickable: visible && !node.disabled && (hit === node || node.contains(hit)), viewport: { width: innerWidth, height: innerHeight }, url: location.href };
}

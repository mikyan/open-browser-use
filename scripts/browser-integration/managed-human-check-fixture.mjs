// One synthetic same-document handoff. Only the final Agent action may POST.
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { humanIMEText } from "./managed-human-ime.mjs";

const sha256 = bytes => createHash("sha256").update(bytes).digest("hex");
export const humanASCII = " human-ASCII";
export const humanUnicode = " 人工接管π";
export const humanPasteText = " 人工粘贴😀 e\u0301\n第二行 π\nthird line";

export function createManagedHumanFixture({ scenario = "handoff" } = {}) {
  assert.ok(["handoff", "local-paste", "ime"].includes(scenario));
  const paste = scenario === "local-paste", ime = scenario === "ime", suffix = paste ? humanPasteText : ime ? humanIMEText.repeat(2) : humanASCII + humanUnicode;
  const workflowId = randomUUID(), draft = `unsubmitted-${randomUUID()}`;
  const requests = [], documents = new Set();
  let committed = false, overflow = false;
  function reply(response, hit, status, body, contentType = "application/json; charset=utf-8") {
    const bytes = Buffer.from(body);
    Object.assign(hit, { status, response: { bytes: bytes.length, sha256: sha256(bytes), base64: bytes.toString("base64") } });
    response.writeHead(status, { "Content-Type": contentType, "Content-Length": bytes.length, "Cache-Control": "no-store" });
    response.end(bytes);
  }
  function handle(request, response) {
    const url = new URL(request.url, "http://127.0.0.1");
    if (!["/human-form", "/human-receipt", "/human-control", ...(paste ? ["/human-clipboard-donor"] : [])].includes(url.pathname)) return false;
    if (requests.length >= 16) { overflow = true; request.resume(); response.writeHead(503); response.end(); return true; }
    const hit = { sequence: requests.length + 1, method: request.method, path: url.pathname, at: Date.now(), finished: false, closed: false, aborted: false, errors: [] };
    requests.push(hit);
    response.once("finish", () => { hit.finished = true; });
    response.once("close", () => { hit.closed = true; hit.aborted = !response.writableFinished; });
    response.on("error", error => hit.errors.push(error.message));
    request.on("error", error => hit.errors.push(error.message));
    if (url.search) { request.resume(); reply(response, hit, 400, '{"error":"unexpected query"}'); return true; }
    if (paste && request.method === "GET" && url.pathname === "/human-clipboard-donor") {
      request.resume(); reply(response, hit, 200, '<!doctype html><meta charset="utf-8"><title>Synthetic memory clipboard donor</title><label>Donor<textarea id="donor"></textarea></label><label>Neutral control<textarea id="neutral"></textarea></label>', "text/html; charset=utf-8"); return true;
    }
    if (request.method === "GET" && url.pathname === "/human-control") {
      request.resume();
      reply(response, hit, 200, '<!doctype html><meta charset="utf-8"><title>Independent release check</title><style>body{font:24px sans-serif;background:#def;padding:32px}</style><h1>Independent human release check</h1><p>No form, external account, or business submission on this page.</p>', "text/html; charset=utf-8"); return true;
    }
    if (request.method === "GET" && url.pathname === "/human-form") {
      request.resume(); const documentToken = randomUUID(); documents.add(documentToken); hit.documentToken = documentToken;
      const html = `<!doctype html><meta charset="utf-8"><title>Original managed human form</title>
<style>body{font:20px sans-serif;margin:24px;background:#eff5ff;color:#132641}label{display:block;margin:18px 0}input,textarea{font:20px sans-serif;width:650px;padding:12px}button{font:20px sans-serif;padding:14px;margin:8px}#hold{width:240px;height:90px;background:#e1c6ff;display:grid;place-content:center;user-select:none}#spacer{height:1500px;background:linear-gradient(#eff5ff,#cce3e8)}#state{font:12px monospace;white-space:pre-wrap;overflow-wrap:anywhere;max-width:900px}#bottom{height:200px}</style>
<h1>Continue the original unsaved form</h1><form id="form"><label>Original draft${paste ? '<textarea name="draft" id="draft" autocomplete="off" rows="3"></textarea>' : '<input name="draft" id="draft" autocomplete="off">'}</label><button type="button" id="human-button">Human confirmation</button><div id="hold" tabindex="0">Hold target for disconnect</div><div id="spacer"></div><section id="bottom"><button type="submit" id="commit">Commit original handoff receipt</button><pre id="result"></pre></section></form><pre id="state"></pre>
<script>
const state={workflowId:${JSON.stringify(workflowId)},documentToken:${JSON.stringify(documentToken)},events:[],eventOverflow:false,clicks:[],submits:0,scrollY:0,maximumScrollY:0,heldKeys:[],heldButtons:[]};
const render=()=>{state.scrollY=scrollY;state.maximumScrollY=Math.max(state.maximumScrollY,scrollY);document.querySelector('#state').textContent=JSON.stringify(state)};
const record=e=>{if(state.events.length>=256){state.eventOverflow=true;return}const item={type:e.type,target:e.target?.id??'',trusted:e.isTrusted};if(e.type.startsWith('key')){item.key=e.key;item.code=e.code;item.repeat=e.repeat;if(e.type==='keydown'){if(!state.heldKeys.includes(e.code))state.heldKeys.push(e.code)}else state.heldKeys=state.heldKeys.filter(k=>k!==e.code)}if(e.type.startsWith('pointer')||e.type.startsWith('mouse')){item.button=e.button;item.buttons=e.buttons;item.x=e.clientX;item.y=e.clientY;if(e.type==='mousedown'&&!state.heldButtons.includes(e.button))state.heldButtons.push(e.button);if(e.type==='mouseup')state.heldButtons=state.heldButtons.filter(b=>b!==e.button)}if(e.type==='input'||e.type==='beforeinput'){item.inputType=e.inputType;item.data=e.data}if(e.type.startsWith('composition'))item.data=e.data;if(e.type==='wheel'){item.deltaX=e.deltaX;item.deltaY=e.deltaY}state.events.push(item);render()};
for(const name of ['keydown','keyup','pointerdown','pointerup','mousedown','mouseup','input','wheel',...${JSON.stringify(paste ? ["beforeinput", "paste", "copy", "cut"] : ime ? ["beforeinput", "compositionstart", "compositionupdate", "compositionend", "paste", "copy", "cut"] : [])}])document.addEventListener(name,record,{capture:true,passive:true});
addEventListener('scroll',render,{passive:true});
document.querySelector('#human-button').addEventListener('click',e=>{state.clicks.push({trusted:e.isTrusted,sequence:state.clicks.length+1});render()});
document.querySelector('#form').addEventListener('submit',async e=>{e.preventDefault();state.submits++;render();const body=new URLSearchParams({workflowId:state.workflowId,documentToken:state.documentToken,draft:document.querySelector('#draft').value,humanClicks:String(state.clicks.length),humanTrusted:String(state.clicks.every(item=>item.trusted)),submitCount:String(state.submits),heldKeys:String(state.heldKeys.length),heldButtons:String(state.heldButtons.length),maximumScrollY:String(state.maximumScrollY)});const response=await fetch('/human-receipt',{method:'POST',body});document.querySelector('#result').textContent=await response.text()});render();
</script>`;
      reply(response, hit, 200, html, "text/html; charset=utf-8"); return true;
    }
    if (request.method !== "POST" || url.pathname !== "/human-receipt") { request.resume(); reply(response, hit, 405, '{"error":"method"}'); return true; }
    const chunks = []; let size = 0;
    request.on("data", bytes => { size += bytes.length; if (size <= 8192) chunks.push(bytes); });
    request.once("aborted", () => { hit.requestAborted = true; });
    request.once("end", () => {
      const bytes = Buffer.concat(chunks), fields = new URLSearchParams(bytes.toString());
      hit.body = { bytes: size, sha256: sha256(bytes), base64: bytes.toString("base64"), truncated: size > 8192 };
      const names = ["workflowId", "documentToken", "draft", "humanClicks", "humanTrusted", "submitCount", "heldKeys", "heldButtons", "maximumScrollY"];
      hit.fieldNames = [...fields.keys()];
      if (size > 8192 || names.some(name => fields.getAll(name).length !== 1) || hit.fieldNames.some(name => !names.includes(name))) { reply(response, hit, 400, '{"error":"fields"}'); return; }
      hit.documentToken = fields.get("documentToken");
      hit.originalDocument = documents.has(hit.documentToken);
      hit.draftMatches = fields.get("draft") === draft + suffix;
      hit.humanClicks = Number(fields.get("humanClicks")); hit.submitCount = Number(fields.get("submitCount"));
      hit.maximumScrollY = Number(fields.get("maximumScrollY"));
      if (fields.get("workflowId") !== workflowId || !hit.originalDocument || !hit.draftMatches || hit.humanClicks !== 1 || fields.get("humanTrusted") !== "true" || hit.submitCount !== 1 || fields.get("heldKeys") !== "0" || fields.get("heldButtons") !== "0" || !(hit.maximumScrollY > 300)) { reply(response, hit, 400, '{"error":"original human handoff required"}'); return; }
      if (committed) { reply(response, hit, 409, '{"error":"receipt already consumed"}'); return; }
      committed = true; hit.once = true;
      const receipt = { ok: true, workflowId, documentToken: hit.documentToken, draftSHA256: sha256(fields.get("draft")), humanClicks: hit.humanClicks, submitCount: hit.submitCount };
      hit.publicReceipt = receipt; reply(response, hit, 200, JSON.stringify(receipt));
    });
    return true;
  }
  return { handle, workflowId, draft, scenario, expectedDraft: draft + suffix,
    stats: () => structuredClone({ workflowId, requests, committed, overflow }) };
}

// Invoked by a read-only worker scripting observer; never attaches a page or
// sends input. Explicitly synthetic fields only, not a general DOM dump.
export function readManagedHumanDocument() {
  const state = JSON.parse(document.querySelector("#state")?.textContent ?? "null");
  const rect = id => { const r = document.getElementById(id)?.getBoundingClientRect(); return r ? { x: r.x, y: r.y, width: r.width, height: r.height } : null; };
  return { state, draft: document.querySelector("#draft")?.value, result: document.querySelector("#result")?.textContent,
    viewport: { width: innerWidth, height: innerHeight, scrollX, scrollY, devicePixelRatio,
      clientWidth: document.documentElement.clientWidth, clientHeight: document.documentElement.clientHeight,
      scrollWidth: document.documentElement.scrollWidth, scrollHeight: document.documentElement.scrollHeight },
    boxes: Object.fromEntries(["draft", "human-button", "hold", "commit"].map(id => [id, rect(id)])) };
}

export function assertManagedHumanReceipt(stats, original, after, receipt) {
  assert.equal(stats.overflow, false); assert.equal(stats.committed, true);
  const gets = stats.requests.filter(value => value.method === "GET" && value.path === "/human-form"), posts = stats.requests.filter(value => value.method === "POST");
  assert.equal(gets.length, 1, "The original form must not be recreated");
  assert.equal(posts.length, 1, "Exactly one original business POST is allowed");
  assert.equal(gets[0].documentToken, original.state.documentToken);
  assert.equal(after.state.documentToken, original.state.documentToken);
  assert.equal(after.state.eventOverflow, false); assert.equal(after.state.submits, 1);
  assert.deepEqual(after.state.heldKeys, []); assert.deepEqual(after.state.heldButtons, []);
  assert.equal(after.state.clicks.length, 1); assert.equal(after.state.clicks[0].trusted, true);
  const post = posts[0], bytes = Buffer.from(post.body.base64, "base64"), body = new URLSearchParams(bytes.toString());
  assert.equal(post.status, 200); assert.equal(post.once, true); assert.equal(post.body.truncated, false);
  assert.equal(bytes.length, post.body.bytes); assert.equal(sha256(bytes), post.body.sha256);
  assert.equal(body.get("documentToken"), original.state.documentToken); assert.equal(body.get("draft"), after.draft);
  assert.deepEqual(receipt, post.publicReceipt);
  const response = Buffer.from(post.response.base64, "base64");
  assert.equal(response.length, post.response.bytes); assert.equal(sha256(response), post.response.sha256);
  assert.deepEqual(JSON.parse(response), receipt);
  for (const hit of stats.requests) { assert.equal(hit.finished, true); assert.equal(hit.aborted, false); assert.deepEqual(hit.errors, []); }
  return { documentToken: original.state.documentToken, requests: stats.requests.length, originalFormLoads: gets.length, posts: posts.length, post: post.body, response: post.response };
}

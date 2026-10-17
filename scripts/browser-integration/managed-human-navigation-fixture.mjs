// One original A -> redirect -> B -> SPA handoff. Synthetic localhost data only.
// HTTP tests validate this fixture's bookkeeping, not real trusted browser input.
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";

const sha256 = bytes => createHash("sha256").update(bytes).digest("hex");
const encoded = value => { const bytes = Buffer.from(value); return { bytes: bytes.length, sha256: sha256(bytes), base64: bytes.toString("base64") }; };
export const navigationASCII = " human-ASCII";
export const navigationContinuation = " continued";
export const navigationUnicode = " 连续接管π";
const paths = Object.freeze({ a: "/nav-a", next: "/nav-next", b: "/nav-b", receipt: "/nav-receipt", frame: "/nav-frame" });
const postNames = ["workflowId", "documentAToken", "documentBToken", "draft", "nextClicks", "nextTrusted", "spaClicks", "spaTrusted", "route", "submitCount", "heldKeys", "heldButtons", "frameClicks", "frameTrusted", "frameDocumentToken", "eventOverflow"];

export function createManagedHumanNavigationFixture({ requireFrameNavigation = false } = {}) {
  assert.equal(typeof requireFrameNavigation, "boolean");
  const workflowId = randomUUID(), draft = `original-${randomUUID()}`;
  const expectedNextDraft = draft + navigationASCII, expectedBDraft = expectedNextDraft + navigationContinuation;
  const expectedDraft = expectedBDraft + navigationUnicode;
  const requests = [], frames = new Map();
  let documentAToken = null, documentBToken = null, nextAttempted = false, bServed = false, postAttempted = false, committed = false, overflow = false;
  const stats = () => structuredClone({ workflowId, documentAToken, documentBToken, requests, committed, overflow, requireFrameNavigation });
  const exact = (fields, names) => names.every(name => fields.getAll(name).length === 1) && [...fields.keys()].every(name => names.includes(name));
  function reply(response, hit, status, body, headers = {}) {
    const bytes = Buffer.from(body);
    Object.assign(hit, { status, response: encoded(bytes), headers });
    response.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Content-Length": bytes.length, "Cache-Control": "no-store", ...headers });
    response.end(bytes);
  }
  function page(pageName) {
    const isA = pageName === "A", token = isA ? documentAToken : documentBToken;
    const state = { page: pageName, workflowId, documentToken: token, documentAToken, documentBToken: isA ? null : documentBToken,
      handoffDraft: isA ? null : expectedNextDraft, route: "initial", events: [], eventOverflow: false,
      nextClicks: isA ? [] : [{ sequence: 1, trusted: true }], spaClicks: [], frameClicks: [], inputCount: 0, trustedInputCount: 0, submits: 0, heldKeys: [], heldButtons: [] };
    return `<!doctype html><meta charset="utf-8"><title>Navigation handoff ${pageName}</title>
<style>*{box-sizing:border-box}html,body{margin:0;width:100%;height:100%;overflow:hidden}body{padding:12px;font:16px sans-serif;background:#eef5ff;color:#16314c}h1{font-size:20px;margin:0 0 10px}label{display:block;margin:6px 0}input{font:16px sans-serif;width:100%;height:34px;padding:5px}button{font:15px sans-serif;padding:7px 12px;margin:6px 6px 6px 0}#route{height:24px;margin:4px 0}#hold{height:32px;background:#dcc9ff;padding:6px;user-select:none}iframe{display:block;width:100%;height:52px;border:1px solid #abc;margin-top:8px}[hidden]{display:none!important}</style>
<h1>${isA ? "A · Original unsaved draft" : "B · Continue the original handoff"}</h1><form id="form"><label>Original draft<input id="draft" name="draft" autocomplete="off"></label><p id="route">Initial route</p>
${isA ? '<button id="next" type="button">Next original document</button>' : '<button id="spa" type="button">Continue within this document</button><button id="frame-next" type="button">Navigate child frame</button><button id="commit" type="submit">Commit original receipt</button>'}
<div id="hold" tabindex="0">Held input boundary</div></form>${isA ? "" : '<iframe id="child" title="Original child document"></iframe>'}<pre id="state" hidden></pre><pre id="result" hidden></pre>
<script>
const state=${JSON.stringify(state)},render=()=>{document.querySelector('#state').textContent=JSON.stringify(state)};
document.querySelector('#draft').value=${JSON.stringify(isA ? "" : expectedNextDraft)};
const record=e=>{if(state.events.length>=256){state.eventOverflow=true;render();return}const item={type:e.type,target:e.target?.id??'',trusted:e.isTrusted};if(e.type.startsWith('key')){item.key=e.key;item.code=e.code;if(e.type==='keydown'&&!state.heldKeys.includes(e.code))state.heldKeys.push(e.code);if(e.type==='keyup')state.heldKeys=state.heldKeys.filter(k=>k!==e.code)}if(e.type==='mousedown'||e.type==='mouseup'){item.button=e.button;item.buttons=e.buttons;if(e.type==='mousedown'&&!state.heldButtons.includes(e.button))state.heldButtons.push(e.button);if(e.type==='mouseup')state.heldButtons=state.heldButtons.filter(b=>b!==e.button)}if(e.type==='input'){item.inputType=e.inputType;item.data=e.data;state.inputCount++;if(e.isTrusted)state.trustedInputCount++}state.events.push(item);render()};
for(const name of ['keydown','keyup','mousedown','mouseup','input'])document.addEventListener(name,record,{capture:true,passive:true});
${isA ? `document.querySelector('#next').addEventListener('click',e=>{state.nextClicks.push({sequence:state.nextClicks.length+1,trusted:e.isTrusted});render();if(state.nextClicks.length!==1)return;const query=new URLSearchParams({workflowId:state.workflowId,documentAToken:state.documentAToken,draft:document.querySelector('#draft').value,trusted:String(e.isTrusted),count:String(state.nextClicks.length),heldKeys:String(state.heldKeys.length),heldButtons:String(state.heldButtons.length)});location.assign('${paths.next}?'+query)});document.querySelector('#form').addEventListener('submit',e=>e.preventDefault());` : `
const child=document.querySelector('#child');child.src='${paths.frame}?'+new URLSearchParams({workflowId:state.workflowId,documentBToken:state.documentBToken,step:'0'});
document.querySelector('#spa').addEventListener('click',e=>{state.spaClicks.push({sequence:state.spaClicks.length+1,trusted:e.isTrusted});if(state.spaClicks.length===1){history.pushState({fixtureRoute:'spa'},'','#spa');state.route='spa';document.querySelector('#route').textContent='SPA route · same original document'}render()});
document.querySelector('#frame-next').addEventListener('click',e=>{state.frameClicks.push({sequence:state.frameClicks.length+1,trusted:e.isTrusted});render();if(state.frameClicks.length===1)child.src='${paths.frame}?'+new URLSearchParams({workflowId:state.workflowId,documentBToken:state.documentBToken,step:'1',trusted:String(e.isTrusted),count:String(state.frameClicks.length)})});
document.querySelector('#form').addEventListener('submit',async e=>{e.preventDefault();state.submits++;render();const childState=JSON.parse(child.contentDocument?.querySelector('#state')?.textContent??'null');const body=new URLSearchParams({workflowId:state.workflowId,documentAToken:state.documentAToken,documentBToken:state.documentBToken,draft:document.querySelector('#draft').value,nextClicks:String(state.nextClicks.length),nextTrusted:String(state.nextClicks.every(item=>item.trusted)),spaClicks:String(state.spaClicks.length),spaTrusted:String(state.spaClicks.every(item=>item.trusted)),route:state.route==='spa'&&location.hash==='#spa'?'spa':'invalid',submitCount:String(state.submits),heldKeys:String(state.heldKeys.length),heldButtons:String(state.heldButtons.length),frameClicks:String(state.frameClicks.length),frameTrusted:String(state.frameClicks.every(item=>item.trusted)),frameDocumentToken:childState?.documentToken??'',eventOverflow:String(state.eventOverflow)});const response=await fetch('${paths.receipt}',{method:'POST',body});document.querySelector('#result').textContent=await response.text()});`}
render();</script>`;
  }
  function handle(request, response) {
    const url = new URL(request.url, "http://127.0.0.1");
    if (!Object.values(paths).includes(url.pathname)) return false;
    if (requests.length >= 32) { overflow = true; request.resume(); response.writeHead(503); response.end(); return true; }
    const hit = { sequence: requests.length + 1, at: Date.now(), method: request.method, path: url.pathname,
      requestTarget: encoded(request.url), body: encoded(""), finished: false, closed: false, aborted: false, errors: [] };
    requests.push(hit);
    response.once("finish", () => { hit.finished = true; });
    response.once("close", () => { hit.closed = true; hit.aborted = !response.writableFinished; });
    response.on("error", error => hit.errors.push(error.message)); request.on("error", error => hit.errors.push(error.message));
    if (request.method === "GET") {
      request.resume();
      if (url.pathname === paths.a) {
        if (url.search) { reply(response, hit, 400, '{"error":"unexpected query"}'); return true; }
        if (documentAToken) { reply(response, hit, 409, '{"error":"original A already loaded"}'); return true; }
        documentAToken = hit.documentToken = randomUUID();
        reply(response, hit, 200, page("A"), { "Content-Type": "text/html; charset=utf-8" }); return true;
      }
      if (url.pathname === paths.next) {
        if (nextAttempted) { reply(response, hit, 409, '{"error":"Next already attempted; do not replay"}'); return true; }
        nextAttempted = true;
        const fields = url.searchParams;
        if (!exact(fields, ["workflowId", "documentAToken", "draft", "trusted", "count", "heldKeys", "heldButtons"]) ||
            !documentAToken || fields.get("workflowId") !== workflowId || fields.get("documentAToken") !== documentAToken || fields.get("draft") !== expectedNextDraft || fields.get("trusted") !== "true" || fields.get("count") !== "1" || fields.get("heldKeys") !== "0" || fields.get("heldButtons") !== "0") {
          reply(response, hit, 400, '{"error":"original trusted Next and complete draft required"}'); return true;
        }
        documentBToken = randomUUID();
        Object.assign(hit, { once: true, documentAToken, documentBToken, draftSHA256: sha256(expectedNextDraft), trusted: true });
        reply(response, hit, 302, JSON.stringify({ next: "B", documentAToken, documentBToken }), { Location: paths.b + "?" + new URLSearchParams({ workflowId, documentBToken }) }); return true;
      }
      if (url.pathname === paths.b) {
        if (!documentBToken || !exact(url.searchParams, ["workflowId", "documentBToken"]) || url.searchParams.get("workflowId") !== workflowId || url.searchParams.get("documentBToken") !== documentBToken) {
          reply(response, hit, 400, '{"error":"original redirect required"}'); return true;
        }
        if (bServed) { reply(response, hit, 409, '{"error":"original B already loaded"}'); return true; }
        bServed = true; hit.documentToken = documentBToken;
        reply(response, hit, 200, page("B"), { "Content-Type": "text/html; charset=utf-8" }); return true;
      }
      if (url.pathname === paths.frame) {
        const fields = url.searchParams, step = fields.get("step");
        const names = ["workflowId", "documentBToken", "step", ...(step === "1" ? ["trusted", "count"] : [])];
        if (!bServed || !exact(fields, names) || fields.get("workflowId") !== workflowId || fields.get("documentBToken") !== documentBToken || !["0", "1"].includes(step) || step === "1" && (!frames.has("0") || fields.get("trusted") !== "true" || fields.get("count") !== "1")) {
          reply(response, hit, 400, '{"error":"original child navigation required"}'); return true;
        }
        if (frames.has(step)) { reply(response, hit, 409, '{"error":"child document already loaded"}'); return true; }
        const token = randomUUID(); frames.set(step, token); Object.assign(hit, { documentToken: token, step: Number(step) });
        const child = { workflowId, documentBToken, documentToken: token, step: Number(step) };
        reply(response, hit, 200, `<!doctype html><meta charset="utf-8"><style>html,body{margin:0;overflow:hidden;font:14px sans-serif;background:#dceef0}p{margin:8px}</style><p>Child document ${step}</p><pre id="state" hidden>${JSON.stringify(child)}</pre>`, { "Content-Type": "text/html; charset=utf-8" }); return true;
      }
      reply(response, hit, 405, '{"error":"method"}'); return true;
    }
    if (request.method !== "POST" || url.pathname !== paths.receipt || url.search) { request.resume(); reply(response, hit, 405, '{"error":"method"}'); return true; }
    const alreadyAttempted = postAttempted; postAttempted = true;
    const chunks = []; let size = 0;
    request.on("data", bytes => { size += bytes.length; if (size <= 8192) chunks.push(bytes); });
    request.once("aborted", () => { hit.requestAborted = true; });
    request.once("end", () => {
      const bytes = Buffer.concat(chunks), fields = new URLSearchParams(bytes.toString());
      hit.body = { ...encoded(bytes), bytes: size, truncated: size > 8192 };
      if (alreadyAttempted) { reply(response, hit, 409, '{"error":"receipt already attempted; do not replay"}'); return; }
      if (size > 8192 || !exact(fields, postNames)) { reply(response, hit, 400, '{"error":"fields"}'); return; }
      const frameStep = fields.get("frameClicks");
      if (!bServed || fields.get("workflowId") !== workflowId || fields.get("documentAToken") !== documentAToken || fields.get("documentBToken") !== documentBToken || fields.get("draft") !== expectedDraft ||
          fields.get("nextClicks") !== "1" || fields.get("nextTrusted") !== "true" || fields.get("spaClicks") !== "1" || fields.get("spaTrusted") !== "true" || fields.get("route") !== "spa" || fields.get("submitCount") !== "1" || fields.get("heldKeys") !== "0" || fields.get("heldButtons") !== "0" || fields.get("eventOverflow") !== "false" ||
          !["0", "1"].includes(frameStep) || requireFrameNavigation && frameStep !== "1" || fields.get("frameTrusted") !== "true" || !frames.has(frameStep) || fields.get("frameDocumentToken") !== frames.get(frameStep) || frames.size !== Number(frameStep) + 1) {
        reply(response, hit, 400, '{"error":"complete original navigation handoff and released input required"}'); return;
      }
      committed = true; hit.once = true;
      const receipt = { ok: true, workflowId, documentAToken, documentBToken, draftSHA256: sha256(expectedDraft), nextClicks: 1, spaClicks: 1, frameNavigations: Number(frameStep), frameDocumentToken: frames.get(frameStep), submitCount: 1 };
      hit.publicReceipt = receipt; reply(response, hit, 200, JSON.stringify(receipt));
    });
    return true;
  }
  return { handle, stats, workflowId, draft, expectedNextDraft, expectedBDraft, expectedDraft, paths };
}

// Execute this function unchanged through the existing read-only worker observer.
export function readManagedHumanNavigationDocument() {
  const state = JSON.parse(document.querySelector("#state")?.textContent ?? "null");
  const rect = id => { const r = document.getElementById(id)?.getBoundingClientRect(); return r ? { x: r.x, y: r.y, width: r.width, height: r.height } : null; };
  const child = document.querySelector("#child");
  return { state, draft: document.querySelector("#draft")?.value, result: document.querySelector("#result")?.textContent,
    childState: JSON.parse(child?.contentDocument?.querySelector("#state")?.textContent ?? "null"),
    url: location.href, viewport: { width: innerWidth, height: innerHeight, scrollX, scrollY, devicePixelRatio,
      clientWidth: document.documentElement.clientWidth, clientHeight: document.documentElement.clientHeight,
      scrollWidth: document.documentElement.scrollWidth, scrollHeight: document.documentElement.scrollHeight },
    boxes: { ...Object.fromEntries(["draft", "next", "spa", "frame-next", "commit", "hold", "child"].map(id => [id, rect(id)])),
      input: rect("draft"), submit: rect("commit"), frameNavigate: rect("frame-next") } };
}

export function assertManagedHumanNavigationReceipt(stats, originalA, originalB, after, receipt) {
  assert.equal(stats.overflow, false); assert.equal(stats.committed, true);
  const hits = name => stats.requests.filter(hit => hit.path === paths[name]);
  const a = hits("a"), next = hits("next"), b = hits("b"), frames = hits("frame"), posts = stats.requests.filter(hit => hit.method === "POST");
  assert.equal(a.length, 1); assert.equal(next.length, 1, "Next is one original navigation, never replayed"); assert.equal(b.length, 1); assert.equal(posts.length, 1, "Exactly one final business POST");
  assert.equal(a[0].status, 200); assert.equal(next[0].status, 302); assert.equal(next[0].once, true); assert.equal(b[0].status, 200);
  for (const hit of [...a, ...next, ...b, ...frames]) assert.equal(hit.method, "GET");
  assert.equal(next[0].headers.Location, Buffer.from(b[0].requestTarget.base64, "base64").toString(), "B was requested through the original redirect target");
  assert.equal(a[0].documentToken, originalA.state.documentToken); assert.equal(b[0].documentToken, originalB.state.documentToken);
  assert.notEqual(originalA.state.documentToken, originalB.state.documentToken);
  assert.equal(next[0].documentAToken, originalA.state.documentToken); assert.equal(next[0].documentBToken, originalB.state.documentToken);
  assert.equal(next[0].draftSHA256, sha256(originalB.draft)); assert.equal(next[0].trusted, true);
  assert.equal(after.state.documentToken, originalB.state.documentToken, "SPA and child navigation preserve original B document");
  assert.equal(originalB.state.documentAToken, originalA.state.documentToken);
  assert.equal(originalB.draft, originalB.state.handoffDraft); assert.equal(after.state.handoffDraft, originalB.draft);
  assert.equal(after.state.route, "spa"); assert.equal(after.state.eventOverflow, false); assert.equal(after.state.submits, 1);
  assert.ok(after.state.inputCount > 0); assert.equal(after.state.trustedInputCount, after.state.inputCount);
  assert.deepEqual(after.state.heldKeys, []); assert.deepEqual(after.state.heldButtons, []);
  assert.equal(after.state.spaClicks.length, 1); assert.equal(after.state.spaClicks[0].trusted, true);
  assert.equal(after.state.nextClicks.length, 1); assert.equal(after.state.nextClicks[0].trusted, true);
  assert.equal(after.state.frameClicks.length, receipt.frameNavigations); assert.ok(after.state.frameClicks.every(click => click.trusted));
  assert.equal(frames.length, receipt.frameNavigations + 1); assert.equal(after.childState.documentToken, receipt.frameDocumentToken);
  assert.equal(frames.at(-1).documentToken, receipt.frameDocumentToken);
  if (receipt.frameNavigations) assert.notEqual(frames[0].documentToken, frames[1].documentToken);
  if (stats.requireFrameNavigation) assert.equal(receipt.frameNavigations, 1);
  const post = posts[0], body = new URLSearchParams(Buffer.from(post.body.base64, "base64").toString());
  assert.equal(post.path, paths.receipt); assert.equal(receipt.workflowId, stats.workflowId);
  assert.deepEqual([...body.keys()].sort(), [...postNames].sort());
  for (const [name, value] of Object.entries({ workflowId: stats.workflowId, nextClicks: "1", nextTrusted: "true", spaClicks: "1", spaTrusted: "true", route: "spa", submitCount: "1", heldKeys: "0", heldButtons: "0", frameClicks: String(receipt.frameNavigations), frameTrusted: "true", frameDocumentToken: receipt.frameDocumentToken, eventOverflow: "false" })) assert.equal(body.get(name), value);
  assert.equal(post.status, 200); assert.equal(post.once, true); assert.equal(post.body.truncated, false);
  assert.equal(body.get("draft"), after.draft); assert.equal(body.get("documentAToken"), originalA.state.documentToken); assert.equal(body.get("documentBToken"), originalB.state.documentToken);
  assert.equal(sha256(after.draft), receipt.draftSHA256); assert.deepEqual(receipt, post.publicReceipt);
  for (const hit of stats.requests) {
    for (const value of [hit.requestTarget, hit.body, hit.response]) {
      const bytes = Buffer.from(value.base64, "base64"); assert.equal(bytes.length, value.bytes); assert.equal(sha256(bytes), value.sha256);
    }
    assert.equal(hit.finished, true); assert.equal(hit.aborted, false); assert.deepEqual(hit.errors, []);
  }
  assert.deepEqual(JSON.parse(Buffer.from(post.response.base64, "base64")), receipt);
  return { documentAToken: originalA.state.documentToken, documentBToken: originalB.state.documentToken, originalDocumentLoads: 2, redirects: 1, spaClicks: 1, frameNavigations: receipt.frameNavigations, posts: 1, post: post.body, response: post.response };
}

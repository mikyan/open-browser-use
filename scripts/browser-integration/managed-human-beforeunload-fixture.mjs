import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";

const encoded = value => { const bytes = Buffer.from(value); return { bytes: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex"), base64: bytes.toString("base64") }; };
const json = value => JSON.stringify(value).replaceAll("<", "\\u003c");
export const beforeunloadDraft = "Unsubmitted travel request 中文 — keep this original draft";

// The ordinary anchor is the only navigation trigger. The native beforeunload
// handler never answers itself, retries navigation, or copies the unsaved draft.
export function createManagedBeforeunloadFixture({ variant = "root-anchor" } = {}) {
  assert.ok(["root-anchor", "child-navigates-parent"].includes(variant));
  const childNavigation = variant === "child-navigates-parent";
  const workflowId = randomUUID(), paths = { page: `/managed-beforeunload/${workflowId}/draft`, destination: `/managed-beforeunload/${workflowId}/review`, receipt: `/managed-beforeunload/${workflowId}/receipt` };
  if (childNavigation) paths.child = `/managed-beforeunload/${workflowId}/child`;
  const requests = []; let originalToken = null, childToken = null, rootOrigin = null, childOrigin = null, destinationToken = null, receipt = null, overflow = false, attempted = false;
  const cases = [{ id: "leave", type: "beforeunload" }];
  const stats = () => structuredClone({ workflowId, originalToken, destinationToken, requests, receipt, overflow, attempted, ...(childNavigation ? { variant, childToken, rootOrigin, childOrigin } : {}) });
  const style = "<style>body{margin:20px;font:16px sans-serif;background:#eef5ff;color:#17324d}h1{font-size:22px}textarea{display:block;width:570px;height:80px;font:16px sans-serif;margin:12px 0}a,button{display:inline-block;padding:12px;background:#fff;border:1px solid #446;color:#17324d}pre{white-space:pre-wrap}[hidden]{display:none!important}</style>";
  function draftPage() {
    return `<!doctype html><meta charset="utf-8"><title>Original unsaved travel request</title><link rel="icon" href="data:,">${style}
<h1>Original unsaved travel request</h1><label>Unsaved request<textarea id="draft"></textarea></label>${childNavigation ? `<iframe id="leave-child" title="Review navigation" src="${childOrigin + paths.child}" style="display:block;width:600px;height:92px;border:4px solid #446;padding:0"></iframe>` : `<a id="dialog-leave" data-dialog-case="leave" href="${paths.destination}">Leave draft and review</a>`}<pre id="state" hidden></pre><pre id="result"></pre><script>
const state={workflowId:${json(workflowId)},documentToken:${json(originalToken)},phase:'draft',results:[],clicks:[],beforeunloads:[],events:[],error:null,eventOverflow:false};
const draft=document.querySelector('#draft');draft.value=${json(beforeunloadDraft)};
const render=()=>document.querySelector('#state').textContent=JSON.stringify(state);
${childNavigation ? "" : "document.querySelector('#dialog-leave').addEventListener('click',event=>{if(state.clicks.length>=2){state.eventOverflow=true;event.preventDefault();render();return}state.clicks.push({sequence:state.clicks.length+1,trusted:event.isTrusted,button:event.button,defaultPrevented:event.defaultPrevented,hasBeenActive:navigator.userActivation.hasBeenActive});render()});"}
window.addEventListener('beforeunload',event=>{if(state.beforeunloads.length>=4){state.eventOverflow=true;render();return}state.beforeunloads.push({sequence:state.beforeunloads.length+1,trusted:event.isTrusted,hasBeenActive:navigator.userActivation.hasBeenActive});event.preventDefault();event.returnValue='';render()});
for(const type of ['pagehide','pageshow'])window.addEventListener(type,event=>{if(state.events.length<8)state.events.push({type,trusted:event.isTrusted,persisted:event.persisted});else state.eventOverflow=true;render()});render();</script>`;
  }
  function childPage() {
    return `<!doctype html><meta charset="utf-8"><title>Child starts parent navigation</title><link rel="icon" href="data:,">${style}
<a id="dialog-leave" data-dialog-case="leave" href="${rootOrigin + paths.destination}" target="_top">Leave parent draft and review</a><pre id="state" hidden></pre><script>
const state={workflowId:${json(workflowId)},documentToken:${json(childToken)},role:'child',clicks:[],error:null},render=()=>document.querySelector('#state').textContent=JSON.stringify(state);
document.querySelector('#dialog-leave').addEventListener('click',event=>{if(state.clicks.length>=2){state.error='original child click capacity exceeded';event.preventDefault();render();return}state.clicks.push({sequence:state.clicks.length+1,trusted:event.isTrusted,button:event.button,defaultPrevented:event.defaultPrevented,hasBeenActive:navigator.userActivation.hasBeenActive});render()});render();</script>`;
  }
  function destinationPage() {
    return `<!doctype html><meta charset="utf-8"><title>Review travel request</title><link rel="icon" href="data:,">${style}
<h1>Review travel request</h1><p>The original unsaved draft was left by an explicit navigation.</p><button id="commit" type="button">Submit reviewed request</button><pre id="state" hidden></pre><pre id="result"></pre><script>
const state={workflowId:${json(workflowId)},documentToken:${json(destinationToken)},originalToken:${json(originalToken)},phase:'review',results:[],clicks:[],postAttempts:0,error:null,eventOverflow:false};
const render=()=>document.querySelector('#state').textContent=JSON.stringify(state);
document.querySelector('#commit').addEventListener('click',async event=>{state.clicks.push({trusted:event.isTrusted,button:event.button});if(state.postAttempts++||!event.isTrusted||event.button!==0){state.error='one original trusted commit required';render();return}event.currentTarget.disabled=true;render();try{const response=await fetch(${json(paths.receipt)},{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({workflowId:state.workflowId,documentToken:state.documentToken,originalToken:state.originalToken,postAttempts:state.postAttempts,clicks:state.clicks})});const value=await response.json();document.querySelector('#result').textContent=JSON.stringify(value);state.phase=response.ok?'committed':'failed';if(!response.ok)state.error='receipt rejected';render()}catch{state.error='original receipt unavailable';render()}});render();</script>`;
  }
  function reply(response, row, status, value, type = "application/json; charset=utf-8") {
    const bytes = Buffer.from(value); Object.assign(row, { status, response: encoded(bytes) });
    response.writeHead(status, { "Content-Type": type, "Content-Length": bytes.length, "Cache-Control": "no-store" }); response.end(bytes);
  }
  function handle(request, response) {
    let url; try { url = new URL(request.url, "http://127.0.0.1"); } catch { return false; }
    if (!Object.values(paths).includes(url.pathname)) return false;
    if (requests.length >= 16) { overflow = true; request.resume(); response.writeHead(429); response.end(); return true; }
    const row = { sequence: requests.length + 1, at: Date.now(), method: request.method, path: url.pathname, ...(childNavigation ? { host: request.headers.host } : {}), body: encoded(""), finished: false, closed: false, aborted: false };
    requests.push(row); response.once("finish", () => { row.finished = true; }); response.once("close", () => { row.closed = true; row.aborted = !response.writableFinished; });
    const reject = (status, error) => { request.resume(); reply(response, row, status, JSON.stringify({ ok: false, error })); };
    if (request.url !== url.pathname) { reject(400, "exact route required"); return true; }
    if (childNavigation) {
      if (!rootOrigin && request.method === "GET" && url.pathname === paths.page && /^127\.0\.0\.1:\d{5}$/.test(request.headers.host ?? "")) {
        const port = Number(request.headers.host.split(":").at(-1));
        if (port >= 49152 && port <= 65535) { rootOrigin = "http://" + request.headers.host; childOrigin = `http://localhost:${port}`; }
      }
      const expectedHost = url.pathname === paths.child ? childOrigin : rootOrigin;
      if (!expectedHost || request.headers.host !== new URL(expectedHost).host) { reject(400, "exact original root or child origin required"); return true; }
    }
    if (request.method === "GET" && url.pathname === paths.page) {
      if (originalToken) reject(409, "original draft cannot be reloaded");
      else { originalToken = randomUUID(); reply(response, row, 200, draftPage(), "text/html; charset=utf-8"); }
    } else if (childNavigation && request.method === "GET" && url.pathname === paths.child) {
      if (!originalToken || childToken) reject(409, "one original child document required");
      else { childToken = randomUUID(); reply(response, row, 200, childPage(), "text/html; charset=utf-8"); }
    } else if (request.method === "GET" && url.pathname === paths.destination) {
      if (!originalToken || destinationToken) reject(409, "one original navigation required");
      else { destinationToken = randomUUID(); reply(response, row, 200, destinationPage(), "text/html; charset=utf-8"); }
    } else if (request.method === "POST" && url.pathname === paths.receipt) {
      if (!destinationToken || attempted) { reject(409, "one original destination commit required"); return true; }
      attempted = true; const chunks = []; let size = 0;
      request.on("data", chunk => { size += chunk.length; if (size <= 4096) chunks.push(chunk); });
      request.once("end", () => {
        const bytes = Buffer.concat(chunks); row.body = encoded(bytes);
        if (size > 4096) { reply(response, row, 413, '{"ok":false}'); return; }
        try {
          const value = JSON.parse(bytes.toString("utf8"));
          assert.deepEqual(value, { workflowId, documentToken: destinationToken, originalToken, postAttempts: 1, clicks: [{ trusted: true, button: 0 }] });
          receipt = { ok: true, workflowId, documentToken: destinationToken, originalToken, submitCount: 1 };
          reply(response, row, 200, JSON.stringify(receipt));
        } catch { reply(response, row, 400, '{"ok":false,"error":"original workflow mismatch"}'); }
      });
      request.once("error", () => { row.requestError = true; }); request.once("aborted", () => { row.requestAborted = true; });
    } else reject(405, "method rejected");
    return true;
  }
  return { workflowId, paths, cases, handle, stats, variant };
}

export function readManagedBeforeunloadDocument() {
  const read = selector => { const text = document.querySelector(selector)?.textContent; return text ? JSON.parse(text) : null; };
  const draft = document.querySelector("#draft"), bounds = draft?.getBoundingClientRect();
  return { state: read("#state"), result: read("#result"), draft: document.querySelector("#draft")?.value ?? null,
    draftRect: bounds ? { x: bounds.x, y: bounds.y, width: bounds.width, height: bounds.height } : null,
    draftHit: bounds ? document.elementFromPoint(bounds.x + bounds.width / 2, bounds.y + bounds.height / 2)?.id : null,
    url: location.href, title: document.title, visibilityState: document.visibilityState, hasFocus: document.hasFocus(),
    userActivation: { hasBeenActive: navigator.userActivation.hasBeenActive, isActive: navigator.userActivation.isActive },
    viewport: { width: innerWidth, height: innerHeight, scrollX, scrollY, devicePixelRatio } };
}

export function measureManagedBeforeunloadLink(caseId) {
  if (caseId !== "leave") throw Error("Original leave link required");
  const link = document.getElementById("dialog-leave");
  if (link?.tagName !== "A" || link.dataset.dialogCase !== "leave") throw Error("Original leave link missing");
  const r = link.getBoundingClientRect(), style = getComputedStyle(link), rect = { x: r.x, y: r.y, width: r.width, height: r.height };
  const left = Math.max(0, r.x), top = Math.max(0, r.y), right = Math.min(innerWidth, r.right), bottom = Math.min(innerHeight, r.bottom);
  const point = { x: (left + right) / 2, y: (top + bottom) / 2 }, hit = document.elementFromPoint(point.x, point.y);
  const visible = Object.values(rect).every(Number.isFinite) && right > left && bottom > top && style.display !== "none" && style.visibility === "visible" && Number(style.opacity) > 0;
  return { caseId, id: link.id, rect, point, visible, clickable: visible && (hit === link || link.contains(hit)), hitTargetId: hit?.id ?? null };
}

// Runs independently in each original document through scripting allFrames.
// No parent/frame DOM access, input dispatch, focus or scrolling is performed.
export function measureManagedBeforeunloadChildElement(caseId) {
  if (caseId !== "leave") throw Error("Original child leave link required");
  const root = document.getElementById("leave-child"), node = root ?? document.getElementById("dialog-leave"), role = root ? "root" : "child";
  if (node?.tagName !== (root ? "IFRAME" : "A") || !root && (node.target !== "_top" || node.dataset.dialogCase !== "leave")) throw Error("Original child navigation element missing");
  const r = node.getBoundingClientRect(), style = getComputedStyle(node), rect = { x: r.x, y: r.y, width: r.width, height: r.height };
  if (style.transform !== "none" || style.zoom !== "1" || root && (r.width !== node.offsetWidth || r.height !== node.offsetHeight)) throw Error("Unexpected transformed fixture geometry");
  const left = Math.max(0, r.x), top = Math.max(0, r.y), right = Math.min(innerWidth, r.right), bottom = Math.min(innerHeight, r.bottom);
  const point = { x: (left + right) / 2, y: (top + bottom) / 2 }, hit = document.elementFromPoint(point.x, point.y);
  const visible = Object.values(rect).every(Number.isFinite) && right > left && bottom > top && style.display !== "none" && style.visibility === "visible" && Number(style.opacity) > 0;
  return { caseId, role, id: node.id, rect, point, visible, clickable: visible && (hit === node || node.contains(hit)), hitTargetId: hit?.id ?? null,
    contentOffset: { x: node.clientLeft, y: node.clientTop }, contentSize: { width: node.clientWidth, height: node.clientHeight },
    url: location.href, state: JSON.parse(document.querySelector("#state").textContent), viewport: { width: innerWidth, height: innerHeight }, target: root ? null : node.target };
}

export function projectManagedBeforeunloadChildMeasurements(rows) {
  assert.equal(rows.length, 2); const root = rows.find(row => row.role === "root"), child = rows.find(row => row.role === "child");
  assert.ok(root && child && root.clickable && child.clickable); assert.equal(root.frameId, 0); assert.ok(child.frameId > 0);
  assert.notEqual(root.documentId, child.documentId); assert.ok(root.documentId && child.documentId); assert.equal(root.state.workflowId, child.state.workflowId);
  assert.deepEqual(root.contentSize, child.viewport); assert.equal(child.target, "_top");
  const left = Math.max(0, child.rect.x), top = Math.max(0, child.rect.y), right = Math.min(child.viewport.width, child.rect.x + child.rect.width), bottom = Math.min(child.viewport.height, child.rect.y + child.rect.height);
  const rect = { x: root.rect.x + root.contentOffset.x + left, y: root.rect.y + root.contentOffset.y + top, width: right - left, height: bottom - top };
  assert.ok(rect.width > 0 && rect.height > 0);
  const rootLeft = Math.max(0, rect.x), rootTop = Math.max(0, rect.y), rootRight = Math.min(root.viewport.width, rect.x + rect.width), rootBottom = Math.min(root.viewport.height, rect.y + rect.height);
  assert.ok(rootRight > rootLeft && rootBottom > rootTop);
  return { caseId: "leave", id: child.id, rect, point: { x: (rootLeft + rootRight) / 2, y: (rootTop + rootBottom) / 2 },
    clickable: true, visible: true, root, child, measurements: structuredClone(rows) };
}

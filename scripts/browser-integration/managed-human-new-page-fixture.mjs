import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";

// The child cannot complete itself: only its original trusted button click
// sends the callback POST. One read-only parent long poll also works when a
// target=_blank link has the browser's default noopener semantics.
export function createManagedHumanNewPageFixture({ trigger = "window-open", variant = "standard", waitMs = 60000 } = {}) {
  assert.ok(["window-open", "target-blank"].includes(trigger));
  assert.ok(["standard", "iframe", "parent-navigate", "child-close"].includes(variant));
  if (variant !== "standard") assert.equal(trigger, "window-open");
  assert.ok(Number.isSafeInteger(waitMs) && waitMs >= 20 && waitMs <= 60000);
  const key = randomUUID(), parentToken = randomUUID(), childToken = randomUUID(), frameToken = randomUUID(), returnedParentToken = randomUUID();
  const prefix = `/human-new-page/${key}`, requests = [], pending = new Set();
  let addresses, overflow = false, closed = false, callback = null;
  const seen = new Set();
  function urls(origin) {
    const root = new URL(origin); assert.equal(root.hostname, "127.0.0.1"); assert.equal(root.protocol, "http:");
    assert.ok(root.port); assert.equal(root.pathname, "/"); assert.equal(root.search + root.hash, "");
    const child = new URL(root); child.hostname = "localhost";
    const result = { parent: root.origin + prefix + "/parent", child: child.origin + prefix + "/child", parentOrigin: root.origin, childOrigin: child.origin,
      ...(variant === "iframe" ? { frame: child.origin + prefix + "/frame" } : {}),
      ...(variant === "parent-navigate" ? { returnedParent: root.origin + prefix + "/parent-returned" } : {}) };
    if (addresses) assert.deepEqual(result, addresses); else addresses = result;
    return structuredClone(result);
  }
  function settlePending(value) { for (const finish of [...pending]) finish(value); }
  function handle(request, response) {
    const url = new URL(request.url, "http://127.0.0.1");
    if (!url.pathname.startsWith(prefix + "/")) return false;
    if (requests.length >= 12) { overflow = true; request.resume(); response.writeHead(503).end(); return true; }
    const hit = { sequence: requests.length + 1, method: request.method, path: url.pathname, at: Date.now(), finished: false, aborted: false };
    requests.push(hit); response.once("finish", () => { hit.finished = true; });
    response.once("close", () => { hit.aborted = !response.writableFinished; });
    const reject = status => { hit.status = status; request.resume(); response.writeHead(status).end(); return true; };
    if (!addresses || closed || url.search || ![new URL(addresses.parent).host, new URL(addresses.child).host].includes(request.headers.host)) return reject(400);
    const route = url.pathname.slice(prefix.length), expectedMethod = route === "/callback" ? "POST" : "GET";
    const routes = ["/parent", "/child", "/await-return", "/callback", ...(variant === "iframe" ? ["/frame"] : []), ...(variant === "parent-navigate" ? ["/parent-returned"] : [])];
    if (!routes.includes(route) || request.method !== expectedMethod || seen.has(route)) return reject(405);
    if (route === "/parent-returned" && !callback) return reject(409);
    if (request.headers.host !== new URL(["/child", "/callback", "/frame"].includes(route) ? addresses.child : addresses.parent).host) return reject(400);
    seen.add(route);
    if (route === "/callback") {
      let body = Buffer.alloc(0);
      request.on("data", chunk => { body = Buffer.concat([body, chunk]); if (body.length > 2048) { overflow = true; request.destroy(); } });
      request.on("end", () => {
        hit.bodyBytes = body.length;
        let value; try { value = JSON.parse(body.toString("utf8")); } catch { reject(400); return; }
        const expected = { key, documentToken: childToken, trusted: true, ...(variant === "child-close" ? { events: [{ type: "click", trusted: true }], submitted: true, closeRequested: true } : {}) };
        if (!seen.has("/child") || JSON.stringify(value) !== JSON.stringify(expected)) { reject(400); return; }
        if (variant === "child-close") hit.body = body.toString("utf8");
        callback = { key, documentToken: childToken, sequence: 1 };
        hit.status = 200; hit.receipt = structuredClone(callback);
        response.writeHead(200, { "Content-Type": "application/json", "Cache-Control": "no-store" }).end(JSON.stringify(callback));
        settlePending(callback);
      });
      return true;
    }
    request.resume();
    if (route === "/await-return") {
      const finish = value => {
        clearTimeout(timer); pending.delete(finish); if (response.destroyed || response.writableEnded) return;
        hit.status = value ? 200 : 204; hit.returned = Boolean(value);
        response.writeHead(hit.status, { "Content-Type": "application/json", "Cache-Control": "no-store" }).end(value ? JSON.stringify(value) : undefined);
      };
      const timer = setTimeout(() => { hit.timedOut = true; finish(null); }, waitMs); timer.unref();
      pending.add(finish); response.once("close", () => { clearTimeout(timer); pending.delete(finish); });
      if (callback) finish(callback);
      return true;
    }
    hit.status = 200; hit.documentToken = route === "/parent" ? parentToken : route === "/frame" ? frameToken : route === "/parent-returned" ? returnedParentToken : childToken;
    response.writeHead(200, { "Content-Type": "text/html;charset=utf-8", "Cache-Control": "no-store" });
    const common = `<!doctype html><meta charset="utf-8"><style>body{font:18px sans-serif;margin:18px;background:#eef4ff;color:#132641}button,a{display:inline-block;padding:14px;margin:12px 0}textarea{display:block;width:520px;height:70px}</style>`;
    const pointerEvents = `for(const type of ['pointerdown','pointerup','mousedown','mouseup','click'])document.addEventListener(type,e=>{if(e.target.id!=='open')return;if(state.events.length>=32){state.overflow=true;render();return}state.events.push({sequence:state.events.length+1,type,trusted:e.isTrusted,button:e.button,detail:e.detail,ctrlKey:e.ctrlKey,metaKey:e.metaKey,altKey:e.altKey,shiftKey:e.shiftKey});render()},{passive:true});`;
    if (route === "/frame") {
      response.end(`${common}<title>Original cross-site opener frame</title><button id="open" type="button">Open child from original frame</button><pre id="state" hidden></pre><script>
const state={key:${JSON.stringify(key)},role:'source-frame',documentToken:${JSON.stringify(frameToken)},events:[],overflow:false,callbacks:[]};const render=()=>document.getElementById('state').textContent=JSON.stringify(state);
${pointerEvents}
document.getElementById('open').addEventListener('click',e=>{if(!e.isTrusted)return;window.open(${JSON.stringify(addresses.child)},'_blank');parent.postMessage({key:state.key,type:'original-child-opened'},${JSON.stringify(addresses.parentOrigin)})});render();
</script>`);
    } else if (route === "/parent-returned") {
      response.end(`${common}<title>Original parent after callback navigation</title><h1>Original parent callback completed</h1><textarea id="draft"></textarea><p id="return-status">Original child returned</p><pre id="state" hidden></pre><script>
const state={key:${JSON.stringify(key)},role:'parent-returned',trigger:${JSON.stringify(trigger)},documentToken:${JSON.stringify(returnedParentToken)},previousDocumentToken:${JSON.stringify(parentToken)},events:[],overflow:false,callbacks:[${JSON.stringify(callback)}],waitState:'returned'};
document.getElementById('draft').value=sessionStorage.getItem(${JSON.stringify(key)})??'';sessionStorage.removeItem(${JSON.stringify(key)});document.getElementById('state').textContent=JSON.stringify(state);
</script>`);
    } else if (route === "/parent") {
      const control = variant === "iframe" ? `<iframe id="source-frame" src="${addresses.frame}" style="display:block;width:620px;height:180px;border:0"></iframe>`
        : trigger === "window-open" ? '<button id="open" type="button">Open original child</button>' : `<a id="open" href="${addresses.child}" target="_blank">Open original child</a>`;
      response.end(`${common}<title>Original human new-page parent</title><h1>Keep this original parent</h1><textarea id="draft">Original unsaved parent draft</textarea>${control}<p id="return-status">Child has not returned</p><pre id="state" hidden></pre><script>
const state={key:${JSON.stringify(key)},role:'parent',trigger:${JSON.stringify(trigger)},documentToken:${JSON.stringify(parentToken)},events:[],overflow:false,callbacks:[],waitState:'none'};
const render=()=>document.getElementById('state').textContent=JSON.stringify(state);
${pointerEvents}
const awaitReturn=()=>{if(state.waitState!=='none')throw Error('duplicate open');state.waitState='waiting';render();fetch(${JSON.stringify(prefix + "/await-return")}).then(async r=>{if(r.status===204){state.waitState='no-return';render();return}if(!r.ok)throw Error('return rejected');const value=await r.json();if(value.key!==state.key)throw Error('wrong return');state.callbacks.push(value);state.waitState='returned';document.getElementById('return-status').textContent='Original child returned';render();${variant === "parent-navigate" ? `sessionStorage.setItem(${JSON.stringify(key)},document.getElementById('draft').value);location.assign(${JSON.stringify(addresses.returnedParent)});` : ""}}).catch(()=>{state.waitState='read-ended';render()})};
${variant === "iframe" ? `window.addEventListener('message',e=>{if(e.source===document.getElementById('source-frame').contentWindow&&e.origin===${JSON.stringify(addresses.childOrigin)}&&e.data?.key===state.key&&e.data.type==='original-child-opened')awaitReturn()});`
  : `document.getElementById('open').addEventListener('click',e=>{if(!e.isTrusted)return;${trigger === "window-open" ? `window.open(${JSON.stringify(addresses.child)},'_blank');` : ""}awaitReturn()});`}render();
</script>`);
    } else {
      response.end(`${common}<title>Original cross-site child</title><h1>Human action required in this child</h1><button id="return" type="button">Return to original parent</button><pre id="state" hidden></pre><script>
const state={key:${JSON.stringify(key)},role:'child',documentToken:${JSON.stringify(childToken)},events:[],overflow:false,submitted:false,receipt:null};
const render=()=>document.getElementById('state').textContent=JSON.stringify(state);
document.getElementById('return').addEventListener('click',async e=>{if(state.events.length>=8){state.overflow=true;render();return}state.events.push({type:'click',trusted:e.isTrusted});render();if(!e.isTrusted||state.submitted)return;state.submitted=true;render();const r=await fetch(${JSON.stringify(prefix + "/callback")},{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({key:state.key,documentToken:state.documentToken,trusted:e.isTrusted${variant === "child-close" ? ",events:state.events,submitted:state.submitted,closeRequested:true" : ""}})});if(!r.ok)throw Error('callback rejected');state.receipt=await r.json();render();${variant === "child-close" ? "window.close();" : ""}});render();
</script>`);
    }
    return true;
  }
  return { trigger, variant, key, urls, handle, close() { closed = true; settlePending(null); },
    stats: () => structuredClone({ trigger, variant, key, parentToken, childToken, frameToken, returnedParentToken, addresses, requests, overflow, closed, callback, pendingReads: pending.size }) };
}

// Original-page read only: no focus, selection, click, URL or ownership change.
export function readManagedHumanNewPageDocument() {
  const stored = document.getElementById("state");
  // A committed original document may precede its inline initialization.
  // Only this explicit not-ready condition is polled; malformed state fails.
  if (!stored || stored.textContent === "") return { ready: false, url: location.href };
  const state = JSON.parse(stored.textContent);
  const element = document.getElementById(state.role === "child" ? "return" : state.role === "parent-returned" ? "return-status" : "open") ?? document.getElementById("source-frame"), rect = element.getBoundingClientRect();
  return { ready: true, state, url: location.href, openerPresent: window.opener !== null, draft: document.getElementById("draft")?.value ?? null,
    point: { x: rect.x, y: rect.y, width: rect.width, height: rect.height }, visibilityState: document.visibilityState, hasFocus: document.hasFocus() };
}

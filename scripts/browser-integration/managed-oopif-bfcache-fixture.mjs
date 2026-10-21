import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";

const hash = bytes => createHash("sha256").update(bytes).digest("hex");
const bytesRecord = bytes => ({ bytes: bytes.length, sha256: hash(bytes), base64: bytes.toString("base64") });
const json = value => JSON.stringify(value).replaceAll("<", "\\u003c");

// A real A -> B -> back task. Drafts exist only in the two original DOMs:
// there is no storage restore, reload fallback, lifecycle POST or cross-frame
// relay. Root and leaf record their own native pagehide/pageshow independently.
export function createManagedOopifBfcacheFixture({ baseURL }) {
  const base = new URL(baseURL);
  assert.equal(base.protocol, "http:"); assert.equal(base.hostname, "127.0.0.1");
  assert.equal(base.pathname, "/"); assert.equal(base.search, ""); assert.equal(base.hash, "");
  assert.equal(base.username, ""); assert.equal(base.password, "");
  const workflowId = randomUUID(), prefix = `/managed-oopif-bfcache/${workflowId}/`;
  const root = new URL(prefix + "root", base), leaf = new URL(prefix + "leaf", base), away = new URL(prefix + "away", base);
  leaf.hostname = "localhost";
  const urls = { root: root.href, leaf: leaf.href, away: away.href, receipt: new URL(prefix + "receipt", leaf).href };
  const drafts = { root: `root-unsaved-${randomUUID()}-根`, leaf: `leaf-unsaved-${randomUUID()}-子` };
  const tokens = {}, requests = [];
  let posted = false, overflow = false;
  const stats = () => structuredClone({ workflowId, urls, drafts, tokens, requests, posted, overflow });

  function html(role) {
    const initial = { workflowId, role, documentToken: tokens[role], lifecycle: [], events: [], overflow: false, posts: 0, error: null };
    const body = role === "root"
      ? '<label>Root unsaved draft<input id="root-draft" autocomplete="off"></label><a id="leave" href=' + json(urls.away) + '>Review separate page B</a><iframe id="child" src=' + json(urls.leaf) + '></iframe>'
      : role === "leaf"
        ? '<form id="form"><label>Frame unsaved draft<input id="leaf-draft" autocomplete="off"></label><button id="submit" type="submit">Submit original frame draft once</button></form><pre id="receipt"></pre>'
        : '<p id="away">Separate page B. Return with the public goBack command.</p>';
    return `<!doctype html><meta charset="utf-8"><title>Original BFCache ${role}</title><link rel="icon" href="data:,">
<style>body{font:16px sans-serif;background:#edf4ff;color:#17324d;margin:20px}input{display:block;width:600px;font:16px monospace;padding:8px;margin:10px 0}a,button{display:inline-block;font:16px sans-serif;padding:8px;margin:12px 0}iframe{display:block;width:700px;height:300px;border:2px solid #678}pre{white-space:pre-wrap;overflow-wrap:anywhere}</style>
<h1>Original ${role} BFCache document</h1><pre id="instructions">${role === "away" ? "" : json({ role, draft: drafts[role] })}</pre>${body}<pre id="state" hidden></pre>
<script>
const state=${json(initial)},input=document.getElementById(state.role+'-draft');
const render=()=>{document.getElementById('state').textContent=JSON.stringify(state)};
const record=event=>{if(state.events.length>=64){state.overflow=true;render();return}
state.events.push({sequence:state.events.length+1,type:event.type,target:event.target?.id??'',trusted:event.isTrusted,value:input?.value??null});render()};
for(const type of ['beforeinput','input','change','click'])document.addEventListener(type,record,{capture:true,passive:true});
for(const type of ['pagehide','pageshow'])addEventListener(type,event=>{if(state.lifecycle.length>=16){state.overflow=true;render();return}
state.lifecycle.push({sequence:state.lifecycle.length+1,type,persisted:event.persisted,trusted:event.isTrusted,value:input?.value??null});render()});
${role === "leaf" ? `document.getElementById('form').addEventListener('submit',async event=>{
event.preventDefault();record(event);if(state.posts++){state.error='Original submission cannot be replayed';render();return}render();
const body={workflowId:state.workflowId,documentToken:state.documentToken,draft:input.value,posts:state.posts,lifecycle:state.lifecycle,events:state.events};
try{const response=await fetch(${json(urls.receipt)},{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});
const receipt=await response.json();document.getElementById('receipt').textContent=JSON.stringify(receipt);if(!response.ok||!receipt.recorded)throw Error('Original receipt rejected');render()}
catch(error){state.error=String(error);render()}});` : ""}
render();</script>`;
  }
  function reply(response, hit, status, body, type = "application/json; charset=utf-8") {
    const bytes = Buffer.from(body); hit.status = status; hit.response = bytesRecord(bytes);
    // Deliberately no no-store, unload handler or artificial BFCache flag.
    // Cache hits alone never prove BFCache: the runner must retain document,
    // loader, original drafts and genuine pageshow.persisted evidence.
    response.writeHead(status, { "Content-Type": type, "Content-Length": bytes.length });
    response.end(bytes);
  }
  function handle(request, response) {
    const url = new URL(request.url, base);
    if (!url.pathname.startsWith(prefix)) return false;
    if (requests.length >= 12) { overflow = true; request.resume(); response.writeHead(429).end(); return true; }
    const route = url.pathname.slice(prefix.length);
    const hit = { sequence: requests.length + 1, route, method: request.method, url: request.url, host: request.headers.host,
      at: Date.now(), finished: false, closed: false, aborted: false, errors: [] };
    requests.push(hit);
    response.once("finish", () => { hit.finished = true; });
    response.once("close", () => { hit.closed = true; hit.aborted = !response.writableFinished; });
    response.on("error", error => hit.errors.push(String(error)));
    request.on("error", error => hit.errors.push(String(error)));
    const exact = request.url === prefix + route && !url.search;
    const expectedHost = route === "leaf" || route === "receipt" ? leaf.host : root.host;
    if (!exact || request.headers.host !== expectedHost || !["root", "leaf", "away", "receipt"].includes(route)) {
      request.resume(); reply(response, hit, 400, '{"error":"exact original route and host required"}'); return true;
    }
    if (route !== "receipt") {
      request.resume();
      if (request.method !== "GET") reply(response, hit, 405, '{"error":"GET required"}');
      else if (tokens[route]) reply(response, hit, 409, '{"error":"original document cannot be recreated"}');
      else {
        tokens[route] = randomUUID(); hit.documentToken = tokens[route];
        reply(response, hit, 200, html(route), "text/html; charset=utf-8");
      }
      return true;
    }
    if (request.method !== "POST") { request.resume(); reply(response, hit, 405, '{"error":"POST required"}'); return true; }
    let size = 0; const chunks = [];
    request.on("data", chunk => { size += chunk.length; if (size <= 32768) chunks.push(chunk); });
    request.once("aborted", () => { hit.requestAborted = true; });
    request.once("end", () => {
      const bytes = Buffer.concat(chunks); hit.body = { ...bytesRecord(bytes), receivedBytes: size, truncated: size > 32768 };
      if (size > 32768 || posted) { reply(response, hit, posted ? 409 : 413, '{"error":"one bounded original receipt required"}'); return; }
      let body;
      try {
        body = JSON.parse(bytes.toString("utf8"));
        assert.deepEqual(Object.keys(body).sort(), ["documentToken", "draft", "events", "lifecycle", "posts", "workflowId"]);
        assert.equal(body.workflowId, workflowId); assert.equal(body.documentToken, tokens.leaf);
        assert.equal(body.posts, 1); assert.equal(typeof body.draft, "string"); assert.ok(body.draft.length <= 1024);
        assert.ok(Array.isArray(body.lifecycle) && body.lifecycle.length <= 16);
        assert.ok(Array.isArray(body.events) && body.events.length <= 64);
      } catch { reply(response, hit, 400, '{"error":"original leaf receipt required"}'); return; }
      posted = true; hit.submitted = body;
      // Retain a wrong value/lifecycle as an actual business result. The oracle
      // must fail it separately instead of preventing baseline evidence.
      hit.publicReceipt = { recorded: true, workflowId, documentToken: body.documentToken, draftSHA256: hash(body.draft) };
      reply(response, hit, 200, JSON.stringify(hit.publicReceipt));
    });
    return true;
  }
  return { workflowId, urls, drafts, handle, stats };
}

// Read-only original page observation for scripting.executeScript({world:"MAIN"})
// selected by exact documentIds. It does not navigate, focus, edit or submit.
export function readManagedOopifBfcacheDocument() {
  const state = JSON.parse(document.getElementById("state")?.textContent ?? "null");
  return { url: location.href, title: document.title, state,
    draft: state ? document.getElementById(state.role + "-draft")?.value ?? null : null,
    instructions: document.getElementById("instructions")?.textContent ?? null,
    receipt: document.getElementById("receipt")?.textContent ?? null };
}

// This establishes only the fixture's document/lifecycle witness. Independent
// native OOPIF/session/frame/loader and SDK results remain required by a runner.
export function assessManagedOopifBfcacheDocuments({ before, restored }) {
  const issues = [], draftIssues = [];
  for (const role of ["root", "leaf"]) {
    const originals = before?.filter(row => row.state?.role === role) ?? [], returns = restored?.filter(row => row.state?.role === role) ?? [];
    const first = originals[0], last = returns[0];
    if (!first || !last) { issues.push(`${role}:original document unobserved`); continue; }
    if (originals.length !== 1 || returns.length !== 1) issues.push(`${role}:ambiguous document witness`);
    if (!first.documentId || !first.state.documentToken || !first.state.workflowId || last.documentId !== first.documentId ||
        last.state.documentToken !== first.state.documentToken || last.state.workflowId !== first.state.workflowId)
      issues.push(`${role}:original document identity changed`);
    if (last.state.overflow) issues.push(`${role}:event overflow`);
    if (typeof first.draft !== "string" || !first.draft.length || last.draft !== first.draft)
      draftIssues.push(`${role}:original draft changed`);
    const lifecycle = last.state.lifecycle ?? [];
    if (JSON.stringify(lifecycle.map(row => [row.sequence, row.type, row.persisted, row.trusted])) !==
        JSON.stringify([[1, "pageshow", false, true], [2, "pagehide", true, true], [3, "pageshow", true, true]]) ||
        JSON.stringify(first.state.lifecycle) !== JSON.stringify(lifecycle.slice(0, 1)))
      issues.push(`${role}:native persisted lifecycle unproved`);
  }
  // Coverage and business correctness are separate. Proven BFCache with a
  // changed draft is a failed business case, never merely "not covered".
  return { bfcacheWitnessVerified: issues.length === 0, originalDraftsPreserved: draftIssues.length === 0, issues, draftIssues };
}

export function assertManagedOopifBfcacheReceipt(stats, { before, restored, after, receipt }) {
  const witness = assessManagedOopifBfcacheDocuments({ before, restored });
  assert.equal(witness.bfcacheWitnessVerified, true, witness.issues.join("; "));
  assert.equal(witness.originalDraftsPreserved, true, witness.draftIssues.join("; "));
  assert.equal(stats.overflow, false); assert.equal(stats.posted, true);
  assert.equal(stats.requests.length, 4, "Only three original document GETs and one original POST");
  assert.deepEqual(stats.requests.filter(hit => hit.method === "GET").map(hit => hit.route).sort(), ["away", "leaf", "root"]);
  const posts = stats.requests.filter(hit => hit.method === "POST");
  assert.equal(posts.length, 1); const post = posts[0]; assert.equal(post.route, "receipt");
  for (const hit of stats.requests) {
    assert.equal(hit.status, 200); assert.equal(hit.finished, true); assert.equal(hit.aborted, false); assert.deepEqual(hit.errors, []);
    assert.deepEqual(bytesRecord(Buffer.from(hit.response.base64, "base64")), hit.response);
  }
  assert.equal(post.body.truncated, false); const bodyBytes = Buffer.from(post.body.base64, "base64");
  assert.equal(post.body.receivedBytes, bodyBytes.length); assert.equal(post.body.bytes, bodyBytes.length); assert.equal(post.body.sha256, hash(bodyBytes));
  const body = JSON.parse(bodyBytes.toString("utf8"));
  assert.deepEqual(body, post.submitted); assert.equal(body.workflowId, stats.workflowId);
  assert.equal(body.documentToken, stats.tokens.leaf); assert.equal(body.draft, stats.drafts.leaf); assert.equal(body.posts, 1);
  for (const role of ["root", "leaf"]) {
    const original = before.find(row => row.state?.role === role), returned = restored.find(row => row.state?.role === role);
    const final = after.find(row => row.state?.role === role); assert.ok(final);
    assert.equal(original.state.documentToken, stats.tokens[role]); assert.equal(original.state.workflowId, stats.workflowId);
    assert.equal(final.documentId, original.documentId); assert.equal(final.state.documentToken, original.state.documentToken);
    assert.equal(original.draft, stats.drafts[role]); assert.equal(returned.draft, stats.drafts[role]); assert.equal(final.draft, stats.drafts[role]);
    assert.equal(final.state.overflow, false); assert.equal(final.state.error, null);
    assert.deepEqual(final.state.lifecycle, returned.state.lifecycle);
    assert.ok(final.state.events.every(event => event.trusted === true));
    assert.deepEqual(final.state.events.map(event => event.sequence), final.state.events.map((_event, index) => index + 1));
    assert.ok(original.state.events.some(event => event.type === "input" && event.target === role + "-draft" && event.value === stats.drafts[role]));
    assert.deepEqual(final.state.events.slice(0, original.state.events.length), original.state.events);
  }
  const root = after.find(row => row.state?.role === "root"), leaf = after.find(row => row.state?.role === "leaf");
  assert.equal(root.state.events.filter(event => event.type === "click" && event.target === "leave").length, 1);
  assert.equal(root.state.posts, 0); assert.equal(leaf.state.posts, 1);
  assert.deepEqual(body.events.filter(event => event.type === "submit").map(event => [event.target, event.trusted]), [["form", true]]);
  assert.equal(body.events.filter(event => event.type === "click" && event.target === "submit").length, 1);
  assert.deepEqual(body.events, leaf.state.events); assert.deepEqual(body.lifecycle, leaf.state.lifecycle);
  assert.deepEqual(receipt, post.publicReceipt); assert.deepEqual(JSON.parse(leaf.receipt), receipt);
  return { verified: true, requests: 4, posts: 1, bodySHA256: post.body.sha256, bodyBytes: post.body.bytes, witness };
}

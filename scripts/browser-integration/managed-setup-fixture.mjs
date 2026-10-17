// Synthetic local login only. Credentials and cookie values never enter stats.
import assert from "node:assert/strict";
import { createHash, randomBytes, randomUUID } from "node:crypto";

const digest = bytes => createHash("sha256").update(bytes).digest("hex");
export const setupStorageKey = "obu.setup.fixture.marker";
export const setupCookieName = "obu_setup_fixture";

export function createManagedSetupFixture() {
  const password = randomBytes(32).toString("hex"), cookie = randomBytes(32).toString("hex"), marker = randomBytes(32).toString("hex");
  const login = "synthetic-setup-user", loginReceiptId = randomUUID(), workflowId = randomUUID();
  const requests = [], loginDocuments = new Set(), protectedDocuments = new Set();
  let loggedIn = false, committed = false, overflow = false;
  const stats = () => structuredClone({ workflowId, requests, overflow, loggedIn, committed,
    cookie: { name: setupCookieName, sha256: digest(cookie), httpOnly: true, maxAgeSeconds: 3600, sameSite: "Lax", path: "/", secure: false },
    storage: { key: setupStorageKey, sha256: digest(marker) } });
  const redact = text => [password, cookie, marker].reduce((value, secret) => value.replaceAll(secret, "[fixture-secret-redacted]"), String(text));
  function reply(response, hit, status, body, headers = {}) {
    const bytes = Buffer.from(body);
    Object.assign(hit, { status, response: { bytes: bytes.length, sha256: digest(bytes) } });
    response.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Content-Length": bytes.length, "Cache-Control": "no-store", ...headers });
    response.end(bytes);
  }
  const stateScript = token => `const state={documentToken:${JSON.stringify(token)},clicks:[]};const render=()=>document.querySelector('#state').textContent=JSON.stringify(state);document.querySelector('button').addEventListener('click',e=>{state.clicks.push({trusted:e.isTrusted,sequence:state.clicks.length+1});render()});render();`;
  function handle(request, response) {
    const url = new URL(request.url, "http://127.0.0.1");
    if (!["/setup-login", "/setup-protected", "/setup-receipt"].includes(url.pathname)) return false;
    if (requests.length >= 32) { overflow = true; request.resume(); response.writeHead(503); response.end(); return true; }
    const authenticated = loggedIn && String(request.headers.cookie ?? "").split(/;\s*/).filter(value => value === `${setupCookieName}=${cookie}`).length === 1;
    const hit = { sequence: requests.length + 1, at: Date.now(), method: request.method, path: url.pathname, cookieAuthenticated: authenticated,
      finished: false, closed: false, aborted: false, errors: [] };
    requests.push(hit);
    response.once("finish", () => { hit.finished = true; });
    response.once("close", () => { hit.closed = true; hit.aborted = !response.writableFinished; });
    response.on("error", error => hit.errors.push(redact(error.message)));
    request.on("error", error => hit.errors.push(redact(error.message)));
    if (url.search) { request.resume(); reply(response, hit, 400, '{"error":"unexpected query"}'); return true; }
    if (request.method === "GET" && url.pathname === "/setup-login") {
      request.resume(); const token = randomUUID(); loginDocuments.add(token); hit.documentToken = token;
      const html = `<!doctype html><meta charset="utf-8"><title>Synthetic managed setup login</title><h1>Local test login</h1><p>Synthetic test credentials only; no external account or MFA.</p><form id="login"><label>Fixture user<input name="login" autocomplete="off"></label><label>Fixture password<input name="password" type="password" autocomplete="off"></label><button>Sign in to local fixture</button></form><pre id="result"></pre><pre id="state"></pre><script>${stateScript(token)}document.querySelector('form').addEventListener('submit',async e=>{e.preventDefault();const form=e.currentTarget,body=new URLSearchParams({login:form.elements.login.value,password:form.elements.password.value,documentToken:state.documentToken,trusted:String(state.clicks.at(-1)?.trusted),buttonCount:String(state.clicks.length)});form.elements.password.value='';const response=await fetch('/setup-login',{method:'POST',body});const result=await response.json();if(response.ok)localStorage.setItem(${JSON.stringify(setupStorageKey)},result.marker);document.querySelector('#result').textContent=JSON.stringify({ok:result.ok===true,loginReceiptId:result.loginReceiptId??null})});</script>`;
      reply(response, hit, 200, html, { "Content-Type": "text/html; charset=utf-8" }); return true;
    }
    if (request.method === "GET" && url.pathname === "/setup-protected") {
      request.resume(); if (!authenticated) { reply(response, hit, 401, '{"authenticated":false}'); return true; }
      const token = randomUUID(); protectedDocuments.add(token); hit.documentToken = token;
      const html = `<!doctype html><meta charset="utf-8"><title>Authenticated managed setup fixture</title><h1>Authenticated after browser restart</h1><button>Commit authenticated receipt</button><pre id="result"></pre><pre id="state"></pre><script>${stateScript(token)}document.querySelector('button').addEventListener('click',async()=>{const body=new URLSearchParams({documentToken:state.documentToken,marker:localStorage.getItem(${JSON.stringify(setupStorageKey)})??'',trusted:String(state.clicks.at(-1)?.trusted),buttonCount:String(state.clicks.length)});const response=await fetch('/setup-receipt',{method:'POST',body});document.querySelector('#result').textContent=await response.text()});</script>`;
      reply(response, hit, 200, html, { "Content-Type": "text/html; charset=utf-8" }); return true;
    }
    if (request.method !== "POST" || !["/setup-login", "/setup-receipt"].includes(url.pathname)) { request.resume(); reply(response, hit, 405, '{"error":"method"}'); return true; }
    const chunks = []; let size = 0;
    request.on("data", bytes => { size += bytes.length; if (size <= 8192) chunks.push(bytes); });
    request.once("aborted", () => { hit.requestAborted = true; });
    request.once("end", () => {
      const bytes = Buffer.concat(chunks), fields = new URLSearchParams(bytes.toString());
      hit.body = { bytes: size, sha256: digest(bytes), truncated: size > 8192 };
      const names = url.pathname === "/setup-login" ? ["login", "password", "documentToken", "trusted", "buttonCount"] : ["documentToken", "marker", "trusted", "buttonCount"];
      hit.fieldNames = [...fields.keys()];
      if (size > 8192 || names.some(name => fields.getAll(name).length !== 1) || hit.fieldNames.some(name => !names.includes(name))) { reply(response, hit, 400, '{"error":"fields"}'); return; }
      hit.documentToken = fields.get("documentToken"); hit.trusted = fields.get("trusted") === "true"; hit.buttonCount = Number(fields.get("buttonCount"));
      if (!hit.trusted || hit.buttonCount !== 1) { reply(response, hit, 400, '{"error":"original input required"}'); return; }
      if (url.pathname === "/setup-login") {
        hit.credentialsMatch = fields.get("login") === login && fields.get("password") === password;
        if (!loginDocuments.has(hit.documentToken) || !hit.credentialsMatch) { reply(response, hit, 403, '{"error":"synthetic credential mismatch"}'); return; }
        if (loggedIn) { reply(response, hit, 409, '{"error":"login already consumed"}'); return; }
        loggedIn = true; hit.once = true; hit.cookieIssued = true;
        reply(response, hit, 200, JSON.stringify({ ok: true, loginReceiptId, marker }), { "Set-Cookie": `${setupCookieName}=${cookie}; HttpOnly; Max-Age=3600; SameSite=Lax; Path=/` });
      } else {
        hit.storageMatches = fields.get("marker") === marker; hit.storageSHA256 = digest(fields.get("marker") ?? "");
        if (!authenticated || !protectedDocuments.has(hit.documentToken) || !hit.storageMatches) { reply(response, hit, 403, '{"error":"original persisted session required"}'); return; }
        if (committed) { reply(response, hit, 409, '{"error":"receipt already consumed"}'); return; }
        committed = true; hit.once = true;
        const receipt = { ok: true, workflowId, loginReceiptId, documentToken: hit.documentToken, storageSHA256: digest(marker) };
        hit.publicReceipt = receipt; reply(response, hit, 200, JSON.stringify(receipt));
      }
    });
    return true;
  }
  return {
    handle, stats, redact,
    credentials: () => ({ login, password }),
    verifyStorage(value) { assert.ok(value === marker, "Original persistent localStorage marker mismatch"); return { key: setupStorageKey, bytes: Buffer.byteLength(value), sha256: digest(value), matches: true }; },
    verifyCookie(value) {
      assert.ok(value?.name === setupCookieName && value.value === cookie && value.httpOnly && value.expires > Date.now() / 1000 + 3000 && value.path === "/", "Original persistent HttpOnly cookie mismatch");
      return { name: value.name, sha256: digest(value.value), httpOnly: value.httpOnly, secure: value.secure, sameSite: value.sameSite, path: value.path, expires: value.expires };
    }
  };
}

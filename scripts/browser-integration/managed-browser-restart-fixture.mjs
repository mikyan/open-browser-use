// Synthetic server evidence for an actual Browser restart. This fixture never
// restores a browser, retries a submission, or treats a repeated GET as a POST.
import { createHash, randomUUID } from "node:crypto";

export const MANAGED_BROWSER_RESTART_FIXTURE_VERSION = 1;
const PREFIX = "/managed-restart/";
const BODY_LIMIT = 16 * 1024, REQUEST_LIMIT = 512, SCENARIO_LIMIT = 32;
const kinds = ["prg", "cache", "no-store"];
const validId = value => typeof value === "string" && /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/.test(value);
const escape = value => String(value).replace(/[&<>"']/g, character => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[character]);
const json = value => JSON.stringify(value).replace(/</g, "\\u003c");
const kindTitle = kind => ({ prg: "跳转报告", cache: "可缓存 POST 报告", "no-store": "不缓存 POST 报告" })[kind];

export function managedBrowserRestartURLs(port, scenarioId, { authenticated = false } = {}) {
  if (!Number.isSafeInteger(port) || port < 1 || port > 65535 || !validId(scenarioId) || typeof authenticated !== "boolean") throw new Error("Invalid fixture address");
  const base = `http://127.0.0.1:${port}${PREFIX}${scenarioId}`;
  return { work: `${base}/work`, report: `${base}/report`, followupReport: `${base}/followup-report`,
    prepare: Object.fromEntries(kinds.map(kind => [kind, `${base}/prepare/${kind}`])),
    original: Object.fromEntries(kinds.map(kind => [kind, `${base}/original/${kind}`])),
    followup: { work: `${base}/followup/work`, report: `${base}/followup/report` },
    ...(authenticated ? { auth: { login: `${base}/auth/login`, check: `${base}/auth/check` } } : {}) };
}

function shell(title, content, script = "") {
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>${escape(title)}</title><style>
  *{box-sizing:border-box}body{font:16px/1.5 system-ui,sans-serif;max-width:1000px;margin:0 auto;padding:24px;background:#f4f7fa;color:#173044}h1{font-size:27px}section,fieldset{background:white;border:1px solid #bdd0df;padding:18px;margin:18px 0;border-radius:8px}label{display:block;margin:12px 0}input,textarea,button{font:inherit;padding:8px;border:1px solid #8fa8ba;border-radius:4px}input,textarea{width:100%}textarea{min-height:70px}input[readonly]{background:#eef3f7}button{background:#dceefc;cursor:pointer}dl{display:grid;grid-template-columns:170px 1fr;gap:8px}dd{margin:0;overflow-wrap:anywhere}a{color:#125b98}pre{white-space:pre-wrap;overflow-wrap:anywhere}output{display:block;padding:6px 0;white-space:pre-wrap}</style></head><body>${content}${script ? `<script>${script}</script>` : ""}</body></html>`;
}

const field = (label, name, value = "", readonly = false) => `<label>${label}<input name="${name}" value="${escape(value)}"${readonly ? " readonly" : ""} required maxlength="1000" autocomplete="off"></label>`;
const basePath = record => `${PREFIX}${record.scenarioId}`;
const digest = value => createHash("sha256").update(value).digest("hex");
function authEvidence(proof) {
  return proof ? `<section aria-label="服务器登录验证"><h2>服务器登录验证</h2><pre id="server-auth-json">${escape(JSON.stringify(proof, null, 2))}</pre></section>` : "";
}
function loginPage(record, credential) {
  return shell("合成服务器登录", `<h1>合成服务器登录</h1><p>仅用于本地验收，不使用真实账户。合成口令：<code id="synthetic-login-token">${escape(credential)}</code></p>
    <form method="post" action="${basePath(record)}/auth/login" enctype="application/x-www-form-urlencoded">${identityFields(record, record.auth.loginOperationId)}
    ${field("合成登录口令", "credential")}<button type="submit">建立合成登录</button></form>`);
}
function identityFields(record, operationId) {
  return field("场景编号", "scenarioId", record.scenarioId, true) + field("操作编号", "operationId", operationId, true);
}
function followupForm(record, source) {
  const receipt = record.receipts.prg;
  return `<section aria-label="后续独立操作"><h2>后续独立操作</h2><p>仅在原跳转报告已保存后提交一次。这里不会再次提交原报告。</p><form method="post" action="${basePath(record)}/followup/${source}" enctype="application/x-www-form-urlencoded">
    ${identityFields(record, record.operations.followup)}${field("原报告回执", "receiptId", receipt?.receiptId ?? "", source === "report")}
    <label>后续说明<textarea name="note" required maxlength="1000" autocomplete="off"></textarea></label><button type="submit">提交后续操作</button></form></section>`;
}
function workPage(record, proof) {
  const storageKey = `obu-restart-${record.scenarioId}`, cookieName = `obu_restart_${record.scenarioId}`;
  return shell("重启接续工作页", `<h1>重启接续工作页</h1><p>场景 <strong data-field="scenarioId">${escape(record.scenarioId)}</strong>。浏览器草稿与内存草稿分别保存，页面载入时不会自动提交业务。</p>${authEvidence(proof)}
    <section aria-label="浏览器状态"><h2>浏览器状态</h2><label>持久草稿<input id="persistent-draft" autocomplete="off" maxlength="1000"></label><button id="save-persistent" type="button">保存浏览器草稿</button>
    <output aria-label="持久草稿状态" id="persistent-status"></output><output aria-label="Cookie 状态" id="cookie-status"></output>
    <label>内存草稿<input id="memory-draft" autocomplete="off" maxlength="1000"></label><button id="save-memory" type="button">暂存内存草稿</button><output aria-label="内存草稿状态" id="memory-status">未暂存</output>
    <p>当前文档编号 <span id="document-instance"></span></p></section><section><h2>原始报告</h2><ul>${kinds.map(kind => `<li><a href="${basePath(record)}/prepare/${kind}">准备${kindTitle(kind)}</a></li>`).join("")}</ul><a href="${basePath(record)}/report">查看已保存跳转报告</a></section>${followupForm(record, "work")}`, `
    const storageKey=${json(storageKey)}, cookieName=${json(cookieName)}, cookiePath=${json(basePath(record))};
    const draft=document.getElementById('persistent-draft'), persisted=document.getElementById('persistent-status'), cookie=document.getElementById('cookie-status');
    function showCookie(){const pair=document.cookie.split('; ').find(value=>value.startsWith(cookieName+'='));cookie.textContent=pair?decodeURIComponent(pair.slice(cookieName.length+1)):'未保存';}
    try{const value=localStorage.getItem(storageKey);draft.value=value??'';persisted.textContent=value??'未保存';showCookie();}catch{persisted.textContent='读取失败';cookie.textContent='读取失败';}
    document.getElementById('document-instance').textContent=crypto.randomUUID();
    document.getElementById('save-persistent').addEventListener('click',()=>{try{localStorage.setItem(storageKey,draft.value);document.cookie=cookieName+'='+encodeURIComponent(draft.value)+'; Path='+cookiePath+'; Max-Age=86400; SameSite=Strict';persisted.textContent=localStorage.getItem(storageKey);showCookie();}catch{persisted.textContent='保存失败';}});
    document.getElementById('save-memory').addEventListener('click',()=>{document.getElementById('memory-status').textContent=document.getElementById('memory-draft').value;});`);
}
function preparePage(record, kind, proof) {
  return shell(`准备${kindTitle(kind)}`, `<h1>准备${kindTitle(kind)}</h1><p>原生表单直接提交一次。原回执仅在首次接受时产生；重复提交会被拒绝并留在请求记录中。</p>${authEvidence(proof)}
    <form method="post" action="${basePath(record)}/original/${kind}" enctype="application/x-www-form-urlencoded">${identityFields(record, record.operations[kind])}
    <label>报告说明<textarea name="note" required maxlength="1000" autocomplete="off"></textarea></label><button type="submit">保存${kindTitle(kind)}</button></form>`);
}
function reportPage(record, receipt, followup = false, proof) {
  return shell(followup ? "后续操作回执" : kindTitle(receipt.kind), `<h1>${followup ? "后续操作回执" : kindTitle(receipt.kind)}</h1><p>这是原服务器首次接受后保存的回执。重新读取不会创建新回执。</p>${authEvidence(proof)}
    <section aria-label="已保存回执"><dl><dt>场景编号</dt><dd data-field="scenarioId">${escape(receipt.scenarioId)}</dd><dt>回执编号</dt><dd data-field="receiptId">${escape(receipt.receiptId)}</dd><dt>说明</dt><dd data-field="note">${escape(receipt.note)}</dd>${receipt.originalReceiptId ? `<dt>原报告回执</dt><dd data-field="originalReceiptId">${escape(receipt.originalReceiptId)}</dd>` : ""}</dl><pre id="receipt-json">${escape(JSON.stringify(receipt, null, 2))}</pre></section>
    ${receipt.kind === "prg" ? followupForm(record, "report") : ""}<p><a href="${basePath(record)}/work">返回工作页</a></p>`);
}

function readBody(request, entry) {
  return new Promise(resolve => {
    const chunks = [], hash = createHash("sha256"); let bytes = 0, retained = 0, settled = false;
    const finish = error => {
      if (settled) return; settled = true;
      const body = Buffer.concat(chunks);
      Object.assign(entry, { bytes, sha256: hash.digest("hex"), base64: body.toString("base64"), raw: body.toString("utf8"), truncated: bytes > BODY_LIMIT, ...(error ? { readError: error } : {}) });
      resolve();
    };
    request.on("data", chunk => {
      if (settled) return;
      bytes += chunk.length; hash.update(chunk);
      const part = chunk.subarray(0, Math.max(0, BODY_LIMIT - retained));
      if (part.length) { chunks.push(part); retained += part.length; }
    });
    request.on("end", () => finish());
    request.on("aborted", () => finish("aborted"));
    request.on("error", () => finish("read failed"));
  });
}
function payload(entry, request, keys) {
  if (entry.readError) return { error: 400 };
  if (entry.truncated) return { error: 413 };
  if (!/^application\/x-www-form-urlencoded(?:\s*;\s*charset=utf-8)?$/i.test(request.headers["content-type"] ?? "")) return { error: 415 };
  const params = new URLSearchParams(entry.raw);
  if ([...params.keys()].length !== keys.length || keys.some(key => params.getAll(key).length !== 1) || [...params.keys()].some(key => !keys.includes(key))) return { error: 422 };
  const result = Object.fromEntries(params);
  if (keys.includes("note") && (typeof result.note !== "string" || !result.note.trim() || result.note.length > 1000 || result.note.includes("\0"))) return { error: 422 };
  return { value: result };
}

export function createManagedBrowserRestartFixture({ changed = () => {}, authenticated = false } = {}) {
  if (typeof changed !== "function") throw new Error("changed must be a function");
  if (typeof authenticated !== "boolean") throw new Error("authenticated must be a boolean");
  const records = new Map(), authSecrets = new Map(), rejectedRequests = []; let rejectionOverflow = false;
  const notify = () => { changed(); };
  function handle(request, response, port) {
    let url;
    try { url = new URL(request.url, `http://127.0.0.1:${port}`); } catch { return false; }
    if (!url.pathname.startsWith(PREFIX)) return false;
    const parts = url.pathname.slice(PREFIX.length).split("/"), scenarioId = parts.shift(), route = parts.join("/");
    const entry = { method: request.method, path: url.pathname, search: url.search, at: Date.now(), status: null };
    const reply = (status, body, headers = {}) => {
      entry.status = status;
      response.writeHead(status, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff", ...headers }); response.end(body); notify();
    };
    const reject = (status, message) => reply(status, shell("请求未被接受", `<h1>请求未被接受</h1><p>${escape(message)}</p>`));
    let record = records.get(scenarioId);
    if (!validId(scenarioId) || url.search || !record && !(request.method === "GET" && (route === "work" || /^prepare\/(prg|cache|no-store)$/.test(route) || authenticated && route === "auth/login"))) {
      if (rejectedRequests.length < REQUEST_LIMIT) rejectedRequests.push(entry); else rejectionOverflow = true;
      request.resume(); reject(404, "场景或路径不可用"); return true;
    }
    if (!record) {
      if (records.size >= SCENARIO_LIMIT) { request.resume(); reject(503, "场景容量已满"); return true; }
      const nonce = randomUUID();
      record = { version: MANAGED_BROWSER_RESTART_FIXTURE_VERSION, scenarioId, nonce, createdAt: Date.now(),
        operations: Object.fromEntries([...kinds, "followup"].map(kind => [kind, `${nonce}:${kind}`])),
        urls: managedBrowserRestartURLs(port, scenarioId, { authenticated }), requests: [], originalPOST: [], followupPOST: [], receipts: { prg: null, cache: null, "no-store": null, followup: null }, overflow: false };
      if (authenticated) {
        record.auth = { required: true, cookieName: `obu_restart_auth_${scenarioId}`, cookiePath: `${basePath(record)}/`, loginOperationId: `${nonce}:login`, loginPOST: [], receipt: null, cookieSHA256: null, requests: [], refusals: [] };
        authSecrets.set(scenarioId, { credential: randomUUID(), cookie: null });
      }
      records.set(scenarioId, record);
    }
    if (record.requests.length >= REQUEST_LIMIT) { record.overflow = true; request.resume(); reject(503, "请求记录容量已满"); return true; }
    entry.sequence = record.requests.length + 1;
    const cookieName = `obu_restart_${scenarioId}`;
    entry.cookie = String(request.headers.cookie ?? "").split(/;\s*/).filter(value => value.startsWith(`${cookieName}=`)).join("; ").slice(0, 4096);
    record.requests.push(entry);
    let completedPost;
    if (authenticated) response.once("finish", () => {
      entry.responseFinishedAt = Date.now();
      if (completedPost) completedPost.responseFinishedAt = entry.responseFinishedAt;
      // Persist the final response after all related entries have their finish
      // timestamp, including when no later request triggers another snapshot.
      try { notify(); } catch { entry.completionReportingError = true; }
    });
    if (authenticated && route === "auth/login") {
      const secret = authSecrets.get(scenarioId);
      if (request.method === "GET") { request.resume(); reply(200, loginPage(record, secret.credential)); return true; }
      if (request.method !== "POST") { request.resume(); reject(405, "不支持此请求方法"); return true; }
      const post = { sequence: entry.sequence, at: entry.at, path: entry.path, kind: "login", status: null };
      record.auth.loginPOST.push(post);
      completedPost = post;
      void readBody(request, post).then(() => {
        const failed = (status, message) => { post.status = status; reject(status, message); };
        if (record.auth.receipt) { failed(409, "合成登录已建立；拒绝再次登录或补发 Cookie"); return; }
        const parsed = payload(post, request, ["scenarioId", "operationId", "credential"]);
        if (parsed.error) { failed(parsed.error, "登录表单格式无效"); return; }
        const value = parsed.value;
        if (value.scenarioId !== scenarioId || value.operationId !== record.auth.loginOperationId) { failed(422, "登录场景或操作不匹配"); return; }
        if (value.credential !== secret.credential) { failed(401, "合成登录口令不匹配"); return; }
        const token = randomUUID().replaceAll("-", "") + randomUUID().replaceAll("-", "");
        secret.cookie = `${record.auth.cookieName}=${token}`;
        record.auth.cookieSHA256 = digest(secret.cookie);
        const cookie = { name: record.auth.cookieName, path: record.auth.cookiePath, maxAge: 86400, httpOnly: true, sameSite: "Strict" };
        const header = `${secret.cookie}; Path=${cookie.path}; Max-Age=${cookie.maxAge}; HttpOnly; SameSite=${cookie.sameSite}`;
        record.auth.receipt = { scenarioId, loginId: `LOGIN-${randomUUID()}`, principal: `synthetic-${scenarioId}`, loginOperationId: record.auth.loginOperationId,
          loginRequestSequence: entry.sequence, cookieSHA256: record.auth.cookieSHA256, issuedAt: new Date().toISOString(), cookie };
        post.loginId = record.auth.receipt.loginId;
        post.setCookie = { ...cookie, cookieSHA256: record.auth.cookieSHA256, valueSHA256: digest(token), headerSHA256: digest(header) };
        post.status = 303;
        reply(303, shell("合成登录已建立", "<h1>合成登录已建立</h1><p>正在读取服务器认证结果。</p>"), { Location: `${basePath(record)}/auth/check`, "Set-Cookie": header });
      }).catch(() => {
        post.processingError = true;
        if (post.status === null) post.status = 500;
        if (!response.headersSent) {
          entry.status = 500;
          response.writeHead(500, { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store" }); response.end("处理失败");
        }
      });
      return true;
    }
    const original = /^original\/(prg|cache|no-store)$/.exec(route), followup = /^followup\/(work|report)$/.exec(route);
    let proof;
    if (authenticated && (route === "auth/check" || route === "work" || route === "report" || route === "followup-report" || /^prepare\/(prg|cache|no-store)$/.test(route) || original || followup)) {
      const supplied = String(request.headers.cookie ?? "").split(";").map(value => value.trim()).filter(value => value.startsWith(`${record.auth.cookieName}=`));
      const receipt = record.auth.receipt, secret = authSecrets.get(scenarioId);
      const reason = supplied.length === 0 ? "missing-cookie" : supplied.length !== 1 ? "ambiguous-cookie" : !receipt ? "unknown-session" : supplied[0] !== secret.cookie ? "invalid-cookie" : "authenticated";
      entry.authentication = { required: true, accepted: reason === "authenticated", reason, cookieName: record.auth.cookieName,
        cookieSHA256: supplied.length ? digest(supplied.join("; ")) : null, loginId: reason === "authenticated" ? receipt.loginId : null };
      record.auth.requests.push(entry);
      if (!entry.authentication.accepted) record.auth.refusals.push(entry);
      else proof = { authenticated: true, scenarioId, loginId: receipt.loginId, principal: receipt.principal, loginRequestSequence: receipt.loginRequestSequence,
        requestSequence: entry.sequence, requestMethod: entry.method, requestPath: entry.path, cookieSHA256: entry.authentication.cookieSHA256 };
    }
    if (request.method === "POST" && (original || followup)) {
      const post = { sequence: entry.sequence, at: entry.at, path: entry.path, kind: original?.[1] ?? "followup", ...(followup ? { source: followup[1] } : {}), status: null };
      completedPost = post;
      if (entry.authentication) post.authentication = structuredClone(entry.authentication);
      (original ? record.originalPOST : record.followupPOST).push(post);
      void readBody(request, post).then(() => {
        const failed = (status, message) => { post.status = status; reject(status, message); };
        if (entry.authentication && !entry.authentication.accepted) { failed(401, "需要原服务器合成登录"); return; }
        const parsed = payload(post, request, original ? ["scenarioId", "operationId", "note"] : ["scenarioId", "operationId", "receiptId", "note"]);
        if (parsed.error) { failed(parsed.error, "表单格式无效"); return; }
        const value = parsed.value, kind = post.kind;
        if (value.scenarioId !== scenarioId || value.operationId !== record.operations[kind] || followup && (!record.receipts.prg || value.receiptId !== record.receipts.prg.receiptId)) { failed(422, "场景、操作或原报告回执不匹配"); return; }
        if (record.receipts[kind]) { failed(409, "原操作已经提交；拒绝再次提交"); return; }
        const receipt = { scenarioId, kind, receiptId: `RESTART-${randomUUID()}`, operationId: value.operationId, note: value.note.trim(), savedAt: new Date().toISOString(), requestSequence: entry.sequence,
          ...(followup ? { originalReceiptId: record.receipts.prg.receiptId, source: followup[1] } : {}) };
        record.receipts[kind] = receipt; post.receiptId = receipt.receiptId;
        if (kind === "prg" || followup) {
          post.status = 303; reply(303, shell("报告已保存", "<h1>报告已保存</h1><p>正在转到原回执页面。</p>"), { Location: `${basePath(record)}/${followup ? "followup-report" : "report"}` });
        } else {
          post.status = 200; reply(200, reportPage(record, receipt, false, proof), kind === "cache" ? { "Cache-Control": `${authenticated ? "private" : "public"}, max-age=3600`, "Content-Location": record.urls.original.cache } : {});
        }
      }).catch(() => {
        // A reporting callback cannot rewrite an already accepted server reply
        // or erase its receipt. Preserve the actual HTTP outcome independently.
        post.processingError = true;
        if (post.status === null) post.status = 500;
        if (!response.headersSent) {
          entry.status = 500;
          response.writeHead(500, { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store" }); response.end("处理失败");
        }
      });
      return true;
    }
    request.resume();
    if (entry.authentication && !entry.authentication.accepted) { reject(401, "需要原服务器合成登录"); return true; }
    if (request.method !== "GET") { reject(405, "不支持此请求方法"); return true; }
    if (authenticated && route === "auth/check") { reply(200, shell("服务器登录验证", `<h1>服务器登录验证</h1>${authEvidence(proof)}`)); return true; }
    if (route === "work") { reply(200, workPage(record, proof)); return true; }
    const prepare = /^prepare\/(prg|cache|no-store)$/.exec(route);
    if (prepare) { reply(200, preparePage(record, prepare[1], proof)); return true; }
    if (route === "report" || route === "followup-report") {
      const receipt = record.receipts[route === "report" ? "prg" : "followup"];
      if (receipt) reply(200, reportPage(record, receipt, route === "followup-report", proof)); else reject(404, "报告尚未保存");
      return true;
    }
    if (original || followup) { reject(405, "原 POST 回执不可通过 GET 重新生成"); return true; }
    reject(404, "路径不可用"); return true;
  }
  return { handle, stats: scenarioId => structuredClone(records.get(scenarioId) ?? null), allStats: () => structuredClone([...records.values()]),
    rejectedStats: () => structuredClone({ requests: rejectedRequests, overflow: rejectionOverflow }) };
}

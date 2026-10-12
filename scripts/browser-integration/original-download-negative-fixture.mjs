import assert from "node:assert/strict";
import { createHash, randomBytes, randomUUID } from "node:crypto";

const prefix = "/original-negative/", reportPath = prefix + "report", prefixBytes = 4096;
const describe = bytes => ({ bytes: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex"), base64: bytes.toString("base64") });
const scriptJSON = value => JSON.stringify(value).replaceAll("<", "\\u003c");

function pageHTML(record) {
  const config = scriptJSON({ key: record.key, nonce: record.nonce, owner: record.owner, kind: record.kind, expectedSHA: record.expected.sha256 });
  return `<!doctype html><meta charset="utf-8"><title>Original negative download</title>
<style>body{font:16px sans-serif}button{padding:16px;margin:16px}</style>
<form id="report" action="${reportPath}" method="post"><button id="download" type="submit">Download original report</button></form>
<pre id="state"></pre><script>(()=>{
 const config=${config},state={...config,documentToken:crypto.randomUUID(),clicks:[]};
 const form=document.querySelector('#report'),render=()=>document.querySelector('#state').textContent=JSON.stringify(state);
 for(const name of ['key','nonce','documentToken','trusted','buttonCount']){const input=document.createElement('input');input.type='hidden';input.name=name;form.append(input)}
 document.querySelector('#download').addEventListener('click',event=>{
  const click={key:config.key,nonce:config.nonce,documentToken:state.documentToken,trusted:event.isTrusted,buttonCount:state.clicks.length+1};
  state.clicks.push(click);for(const [name,value] of Object.entries(click))form.elements.namedItem(name).value=String(value);render();
 });render();
})();</script>`;
}

// Independent HTTP evidence only: owner/key/nonce must never map product GUIDs
// to paths. The page reports isTrusted; the server does not authenticate it.
export function createOriginalDownloadNegativeFixtures() {
  const records = new Map(), pending = new Map(), requests = [], controls = [];
  let closed = false;
  const get = key => { assert.ok(records.has(key), "Unknown original-negative case"); return records.get(key); };
  const control = (key, action) => { const item = { key, action, at: Date.now() }; controls.push(item); return item; };
  const reply = (response, hit, status, bytes, headers = {}) => {
    hit.status = status; hit.response = describe(bytes); hit.queuedBytes = bytes.length; hit.endCalled = true;
    response.writeHead(status, { "Cache-Control": "no-store", "Content-Type": "text/plain; charset=utf-8", "Content-Length": bytes.length, ...headers });
    response.end(bytes);
  };
  const fail = (response, hit, status, error) => { hit.error = error; reply(response, hit, status, Buffer.from(error + "\n")); };
  const active = (key, kind) => {
    assert.equal(get(key).kind, kind, `Expected ${kind} case`);
    const gate = pending.get(key);
    assert.ok(gate && !gate.response.destroyed && !gate.response.writableEnded, "No active original response");
    assert.equal(gate.hit.prefixFlushed, true, "Original prefix has not flushed yet");
    return gate;
  };
  return {
    createCase({ key = randomUUID(), nonce = randomUUID(), owner, kind }) {
      assert.equal(closed, false, "Fixture is closed");
      assert.ok(typeof key === "string" && /^[A-Za-z0-9][A-Za-z0-9._-]{0,159}$/.test(key), "Invalid fixture key");
      assert.ok(!records.has(key), "Duplicate fixture key");
      assert.ok(typeof nonce === "string" && /^[A-Za-z0-9][A-Za-z0-9._-]{0,159}$/.test(nonce), "Invalid fixture nonce");
      assert.ok(typeof owner === "string" && owner.length > 0 && owner.length <= 160, "Fixture owner required");
      assert.ok(["complete", "held", "interrupted"].includes(kind), "Unknown original-negative kind");
      const heading = Buffer.from(JSON.stringify({ key, nonce, owner, kind }) + "\n原始报表 UTF-8\n");
      const bytes = Buffer.concat([heading, Buffer.from([0, 255, 195, 40, 10, 128]), randomBytes(16384 - heading.length - 6)]);
      const record = { key, nonce, owner, kind, reportPath, urlPath: prefix + "page?key=" + encodeURIComponent(key),
        suggestedFilename: "report.bin", prefixBytes, expected: describe(bytes), consumed: false, gets: [], requests: [] };
      records.set(key, record); return structuredClone(record);
    },
    stats: key => structuredClone(get(key)),
    allStats: () => structuredClone({ cases: [...records.values()], requests, controls, closed }),
    release(key) {
      const { response, hit, bytes } = active(key, "held");
      pending.delete(key); control(key, "release"); hit.released = true; hit.endCalled = true; hit.queuedBytes = bytes.length;
      response.end(bytes.subarray(prefixBytes)); return true;
    },
    interrupt(key) {
      const { response, hit } = active(key, "interrupted");
      pending.delete(key); control(key, "interrupt"); hit.interrupted = true;
      response.socket.destroy(); hit.socketDestroyed = true; return true;
    },
    close() {
      closed = true; const keys = [...pending.keys()];
      for (const [key, { response, hit }] of pending) { control(key, "close"); hit.closedByFixture = true; response.destroy(); }
      pending.clear(); return keys;
    },
    handle(request, response) {
      const url = new URL(request.url, "http://127.0.0.1");
      if (!url.pathname.startsWith(prefix)) return false;
      const hit = { sequence: requests.length + 1, at: Date.now(), method: request.method, url: request.url,
        contentType: request.headers["content-type"] ?? null, range: request.headers.range ?? null,
        once: false, status: null, queuedBytes: 0, prefixBytes: 0, prefixWritten: false, prefixFlushed: false,
        endCalled: false, finished: false, closed: false, aborted: false, requestEnded: false, requestAborted: false, requestClosed: false, errors: [] };
      requests.push(hit);
      response.once("finish", () => { hit.finished = true; hit.finishedAt = Date.now(); });
      response.once("close", () => { hit.closed = true; hit.aborted = !response.writableFinished; hit.closedAt = Date.now(); if (pending.get(hit.fields?.key)?.hit === hit) pending.delete(hit.fields.key); });
      response.on("error", error => { hit.errors.push(String(error)); });
      request.once("close", () => { hit.requestClosed = true; });
      request.on("error", error => { hit.errors.push(String(error)); });
      if (closed) { fail(response, hit, 503, "FIXTURE_CLOSED"); request.resume(); return true; }
      if (url.pathname !== reportPath) {
        const record = records.get(url.searchParams.get("key"));
        if (record) record.requests.push(hit);
        request.resume();
        if (url.pathname !== prefix + "page" || !record) { fail(response, hit, 404, "UNKNOWN_CASE_OR_ROUTE"); return true; }
        if (request.method !== "GET") { fail(response, hit, 405, "PAGE_REQUIRES_GET"); return true; }
        const bytes = Buffer.from(pageHTML(record)); record.gets.push({ url: request.url, ...describe(bytes) });
        reply(response, hit, 200, bytes, { "Content-Type": "text/html; charset=utf-8" }); return true;
      }
      if (request.method !== "POST") { fail(response, hit, 405, "ORIGINAL_REPORT_REQUIRES_POST"); request.resume(); return true; }
      const chunks = []; let size = 0;
      const captureBody = () => { hit.body = { ...describe(Buffer.concat(chunks)), truncated: size > 65536 }; hit.receivedBytes = size; };
      request.on("data", bytes => { if (size < 65536) chunks.push(bytes.subarray(0, 65536 - size)); size += bytes.length; hit.receivedBytes = size; });
      request.once("aborted", () => { hit.requestAborted = true; hit.error = "REQUEST_ABORTED"; captureBody(); });
      request.once("end", () => {
        hit.requestEnded = true; captureBody();
        try {
          if (size > 65536) { fail(response, hit, 413, "POST_TOO_LARGE"); return; }
          const fields = new URLSearchParams(Buffer.concat(chunks).toString("utf8"));
          hit.fieldEntries = [...fields]; hit.fields = Object.fromEntries(fields);
          const record = records.get(fields.get("key")); if (record) record.requests.push(hit);
          if (url.search || hit.range || !/^application\/x-www-form-urlencoded(?:;|$)/i.test(hit.contentType ?? "")) { fail(response, hit, 400, "INVALID_REPORT_REQUEST"); return; }
          const names = ["key", "nonce", "documentToken", "trusted", "buttonCount"];
          if (names.some(name => fields.getAll(name).length !== 1) || [...fields.keys()].some(name => !names.includes(name))) { fail(response, hit, 400, "INVALID_POST_FIELDS"); return; }
          if (!record || fields.get("nonce") !== record.nonce) { fail(response, hit, 403, "INVALID_ONE_TIME_NONCE"); return; }
          if (!fields.get("documentToken") || fields.get("documentToken").length > 160 || !["true", "false"].includes(fields.get("trusted")) || !/^[1-9][0-9]{0,8}$/.test(fields.get("buttonCount"))) { fail(response, hit, 400, "INVALID_CLICK_EVIDENCE"); return; }
          if (record.consumed) { fail(response, hit, 409, "ONE_TIME_NONCE_ALREADY_USED"); return; }
          record.consumed = true; hit.once = true;
          const bytes = Buffer.from(record.expected.base64, "base64");
          const headers = { "Content-Type": "application/octet-stream", "Content-Disposition": 'attachment; filename="report.bin"' };
          if (record.kind === "complete") { reply(response, hit, 200, bytes, headers); return; }
          hit.status = 200; hit.response = describe(bytes); hit.prefixBytes = prefixBytes; hit.prefixWritten = true; hit.queuedBytes = prefixBytes;
          pending.set(record.key, { response, hit, bytes });
          response.writeHead(200, { ...headers, "Cache-Control": "no-store", "Content-Length": bytes.length });
          response.write(bytes.subarray(0, prefixBytes), error => { if (error) hit.errors.push(String(error)); else { hit.prefixFlushed = true; hit.prefixFlushedAt = Date.now(); } });
        } catch (error) {
          hit.error = "FIXTURE_HANDLER_ERROR"; hit.errors.push(String(error));
          if (response.headersSent || response.destroyed) response.destroy(); else fail(response, hit, 500, "FIXTURE_HANDLER_ERROR");
        }
      });
      return true;
    }
  };
}

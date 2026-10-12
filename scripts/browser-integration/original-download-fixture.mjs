import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";

const hash = bytes => createHash("sha256").update(bytes).digest("hex");
const describeBytes = bytes => ({ bytes: bytes.length, sha256: hash(bytes), base64: bytes.toString("base64") });
const scriptJSON = value => JSON.stringify(value).replaceAll("<", "\\u003c");
const variants = ["root", "oopif", "dynamic-oopif"];
const prefix = "/original-download/", reportPath = "/report";

function pageHTML(record, base, frame) {
  const child = new URL(`${prefix}frame?key=${record.key}`, base);
  child.hostname = base.hostname === "localhost" ? "127.0.0.1" : "localhost";
  const leaf = frame || record.variant === "root";
  const config = scriptJSON({ key: record.key, owner: record.owner, kind: record.kind, token: record.token,
    expectedSHA: record.expected.sha256, ...(record.kind === "blob" ? { payload: record.expected.base64 } : {}), childURL: child.href });
  return `<!doctype html><meta charset="utf-8"><title>Original page download</title>
<style>body{font:16px sans-serif}button{padding:16px;margin:16px}iframe{width:700px;height:380px}</style>
${leaf ? '<form id="report" action="/report" method="post"><button id="download" type="submit">Download original report</button></form>' : ""}
${!leaf && record.variant === "oopif" ? `<iframe id="download-frame" src="${child.href}"></iframe>` : ""}
${!leaf && record.variant === "dynamic-oopif" ? '<button id="add-frame">Add download frame</button>' : ""}
<pre id="state"></pre><script>(()=>{
 const config=${config},state={key:config.key,owner:config.owner,kind:config.kind,documentToken:crypto.randomUUID(),expectedSHA:config.expectedSHA,clicks:[],frameAdds:[]};
 const render=()=>document.querySelector('#state').textContent=JSON.stringify(state);render();
 const add=document.querySelector('#add-frame');
 if(add)add.onclick=event=>{state.frameAdds.push({trusted:event.isTrusted});const frame=document.createElement('iframe');frame.id='download-frame';frame.src=config.childURL;document.body.append(frame);add.disabled=true;render()};
 const form=document.querySelector('#report'),button=document.querySelector('#download');
 if(!button)return;
 for(const name of ['owner','token','documentToken','trusted','buttonCount']){const input=document.createElement('input');input.type='hidden';input.name=name;form.append(input)}
 button.addEventListener('click',event=>{
  const click={trusted:event.isTrusted,buttonCount:state.clicks.length+1,documentToken:state.documentToken};state.clicks.push(click);
  for(const [name,value] of Object.entries({owner:config.owner,token:config.token,...click}))form.elements.namedItem(name).value=String(value);
  if(config.kind==='blob'){
   event.preventDefault();const bytes=Uint8Array.from(atob(config.payload),value=>value.charCodeAt(0));
   const url=URL.createObjectURL(new Blob([bytes],{type:'application/octet-stream'}));click.blobURL=url;state.blobURL=url;
   const link=document.createElement('a');link.href=url;link.download='report.bin';document.body.append(link);
   try{link.click()}finally{URL.revokeObjectURL(url);link.remove();click.revoked=true}
  }
  render();
 });
})();</script>`;
}

// This ledger is an independent test witness. It must never map product GUIDs
// to files using URL, filename, timestamps, or the fixture's private token.
export function createOriginalDownloadFixtures() {
  const records = new Map(), tokens = new Map(), requests = [];
  const get = key => { assert.ok(records.has(key), "Unknown original-download case"); return records.get(key); };
  const reply = (response, hit, status, bytes, headers = {}) => {
    hit.status = status; hit.response = describeBytes(bytes);
    response.once("finish", () => { hit.finished = true; });
    response.once("close", () => { hit.closed = true; });
    response.writeHead(status, { "Cache-Control": "no-store", "Content-Type": "text/plain; charset=utf-8", "Content-Length": bytes.length, ...headers });
    response.end(bytes);
  };
  const fail = (response, hit, status, error) => { hit.error = error; reply(response, hit, status, Buffer.from(error + "\n")); };
  return {
    createCase({ kind, owner, variant = "root" }) {
      assert.ok(["post", "blob"].includes(kind), "Unknown original-download kind");
      assert.ok(typeof owner === "string" && owner.length > 0 && owner.length <= 160, "Fixture owner required");
      assert.ok(variants.includes(variant), "Unknown original-download variant");
      const key = randomUUID(), token = randomUUID(), nonce = randomUUID();
      const bytes = Buffer.concat([Buffer.from(JSON.stringify({ key, kind, owner, nonce }) + "\n原始报表 UTF-8\n"), Buffer.from([0, 255, 195, 40, 10, 128])]);
      const record = { key, kind, owner, variant, token, nonce, reportPath, suggestedFilename: "report.bin",
        urlPath: `${prefix}page?key=${key}`, expected: describeBytes(bytes), consumed: false, gets: [], requests: [] };
      records.set(key, record); tokens.set(token, record); return structuredClone(record);
    },
    stats: key => structuredClone(get(key)),
    allStats: () => structuredClone({ cases: [...records.values()], requests }),
    handle(request, response, baseURL) {
      const base = new URL(baseURL);
      assert.ok(base.protocol === "http:" && ["127.0.0.1", "localhost", "[::1]"].includes(base.hostname), "Loopback HTTP baseURL required");
      const url = new URL(request.url, base);
      if (!url.pathname.startsWith(prefix) && url.pathname !== reportPath) return false;
      const hit = { sequence: requests.length + 1, at: Date.now(), method: request.method, url: request.url, finished: false, closed: false };
      requests.push(hit);
      if (url.pathname !== reportPath) {
        const record = records.get(url.searchParams.get("key"));
        if (!record) { fail(response, hit, 404, "UNKNOWN_CASE"); return true; }
        record.requests.push(hit);
        if (request.method !== "GET") { fail(response, hit, 405, "PAGE_REQUIRES_GET"); return true; }
        if (![`${prefix}page`, `${prefix}frame`].includes(url.pathname)) { fail(response, hit, 404, "UNKNOWN_ROUTE"); return true; }
        const bytes = Buffer.from(pageHTML(record, base, url.pathname.endsWith("/frame")));
        record.gets.push({ url: request.url, ...describeBytes(bytes) });
        reply(response, hit, 200, bytes, { "Content-Type": "text/html; charset=utf-8" }); return true;
      }
      if (request.method !== "POST") { fail(response, hit, 405, "ORIGINAL_REPORT_REQUIRES_POST"); return true; }
      const chunks = []; let size = 0;
      request.on("data", bytes => { size += bytes.length; if (size <= 65536) chunks.push(bytes); });
      request.on("aborted", () => { hit.error = "REQUEST_ABORTED"; hit.receivedBytes = size; });
      request.on("error", error => { hit.error = String(error); });
      request.on("end", () => {
        const bytes = Buffer.concat(chunks); hit.body = describeBytes(bytes); hit.receivedBytes = size;
        if (size > 65536) { hit.body.truncated = true; fail(response, hit, 413, "POST_TOO_LARGE"); return; }
        const fields = new URLSearchParams(bytes.toString("utf8")); hit.fields = Object.fromEntries(fields);
        const record = tokens.get(fields.get("token"));
        if (record) record.requests.push(hit);
        if (url.search || !String(request.headers["content-type"] ?? "").startsWith("application/x-www-form-urlencoded")) { fail(response, hit, 400, "INVALID_REPORT_REQUEST"); return; }
        if ([...fields.keys()].some(key => fields.getAll(key).length !== 1)) { fail(response, hit, 400, "DUPLICATE_POST_FIELD"); return; }
        if (!record || record.kind !== "post" || fields.get("owner") !== record.owner) { fail(response, hit, 403, "INVALID_ONE_TIME_TOKEN"); return; }
        if (record.consumed) { fail(response, hit, 409, "ONE_TIME_TOKEN_ALREADY_USED"); return; }
        record.consumed = true;
        reply(response, hit, 200, Buffer.from(record.expected.base64, "base64"), {
          "Content-Type": "application/octet-stream", "Content-Disposition": 'attachment; filename="report.bin"'
        });
      });
      return true;
    }
  };
}

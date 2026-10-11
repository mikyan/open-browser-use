import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

export const directUploadVariants = Object.freeze(["root", "same", "dynamic-oopif"]);
export const directUploadRoute = "/direct-locator-upload/";
const hash = bytes => createHash("sha256").update(bytes).digest("hex");
const keyPattern = /^direct-(?:js|cli|mcp|python|go|directory)-[a-z0-9-]{1,90}$/;
const sorted = files => [...files].sort((a, b) => (a.relativePath || a.name).localeCompare(b.relativePath || b.name));
const metadata = files => sorted(files.map(({ name, size, relativePath }) => ({ name, size, relativePath })));

// This is ordinary page application code: changes read the ORIGINAL FileList,
// and one nonempty selection submits its real bytes. Clearing never submits.
export function directLocatorUploadHTML(url, port) {
  const key = url.searchParams.get("key"), variant = url.searchParams.get("variant"), directory = url.searchParams.get("directory") === "1";
  assert.match(key, keyPattern); assert.ok(directUploadVariants.includes(variant));
  const child = url.pathname.endsWith("/frame"), ownsInput = child || variant === "root";
  const frameURL = new URL(url); frameURL.pathname = directUploadRoute + "frame";
  frameURL.hostname = variant === "same" ? "127.0.0.1" : "localhost"; frameURL.port = String(port);
  return `<!doctype html><meta charset="utf-8"><title>Direct locator upload ${key}</title>
<style>input[type=file]{display:none}pre{white-space:pre-wrap;overflow-wrap:anywhere}iframe{width:720px;height:600px}</style>
<h1>Direct locator upload</h1>${ownsInput ? `<input id="upload" type="file" multiple ${directory ? "webkitdirectory" : ""} aria-label="Hidden upload"><input class="ambiguous" type="file"><input class="ambiguous" type="file"><input id="non-file" type="text"><pre id="state"></pre><pre id="receipt" hidden></pre>` : variant === "same" ? `<iframe id="upload-frame" src="${frameURL.href.replaceAll("&", "&amp;")}"></iframe>` : ""}
<script>
(()=>{
 const key=${JSON.stringify(key)},variant=${JSON.stringify(variant)},input=document.querySelector('#upload');
 const state={key,variant,directory:${directory},documentToken:crypto.randomUUID(),inputToken:input?crypto.randomUUID():null,events:[],clicks:[],errors:[],overflow:false,submissions:0};
 const files=()=>input?[...input.files].map(f=>({name:f.name,size:f.size,relativePath:f.webkitRelativePath})):[];
 const render=()=>{if(input)document.querySelector('#state').textContent=JSON.stringify({...state,href:location.href,files:files(),input:{tag:input.tagName,type:input.type,multiple:input.multiple,directory:input.webkitdirectory,connected:input.isConnected,original:document.querySelector('#upload')===input,display:getComputedStyle(input).display}})};
 document.addEventListener('click',event=>{if(state.clicks.length>=32)state.overflow=true;else state.clicks.push({trusted:event.isTrusted,tag:event.target.tagName,id:event.target.id});render()},true);
 if(input)for(const type of ['input','change','cancel'])input.addEventListener(type,event=>{
  const record={type,trusted:event.isTrusted,original:event.target===input,files:files()};
  if(state.events.length>=32)state.overflow=true;else state.events.push(record);render();
  if(state.directory&&type==='input'){try{const request=new XMLHttpRequest();request.open('POST','${directUploadRoute}witness?'+new URLSearchParams({key,variant}),false);request.setRequestHeader('Content-Type','application/json');request.send(JSON.stringify({...record,key,variant,documentToken:state.documentToken,inputToken:state.inputToken}));if(request.status!==200)throw Error('Directory witness HTTP '+request.status)}catch(error){state.errors.push(String(error));render();throw error}}
  if(type!=='change'||!input.files.length)return;
  const chosen=[...input.files];state.submissions++;render();
  void(async()=>{const payload=await Promise.all(chosen.map(async f=>{const bytes=new Uint8Array(await f.arrayBuffer());let raw='';for(const b of bytes)raw+=String.fromCharCode(b);return{name:f.name,size:f.size,relativePath:f.webkitRelativePath,base64:btoa(raw)}}));
   const body={...state,href:location.href,files:payload};const response=await fetch('${directUploadRoute}upload?'+new URLSearchParams({key,variant}),{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});const receipt=await response.json();if(!response.ok)throw Error(JSON.stringify(receipt));const out=document.querySelector('#receipt');out.textContent=JSON.stringify(receipt);out.hidden=false;
  })().catch(error=>{state.errors.push(String(error));render()});
 });
 render();
 ${!ownsInput && variant === "dynamic-oopif" ? `addEventListener('load',()=>{const iframe=document.createElement('iframe');iframe.id='upload-frame';iframe.src=${JSON.stringify(frameURL.href)};document.body.append(iframe)},{once:true});` : ""}
})();</script>`;
}

export function createDirectLocatorUploadFixtures() {
  const records = new Map();
  const entry = key => { if (!records.has(key)) records.set(key, { key, requests: [], posts: [], witnesses: [] }); return records.get(key); };
  return {
    stats: key => structuredClone(entry(key)), allStats: () => structuredClone([...records.values()]),
    handle(request, response, portOrURL) {
      const url = portOrURL instanceof URL ? portOrURL : new URL(request.url, `http://${request.headers.host}`);
      if (!url.pathname.startsWith(directUploadRoute)) return false;
      const key = url.searchParams.get("key"), variant = url.searchParams.get("variant");
      if (!keyPattern.test(key ?? "") || !directUploadVariants.includes(variant)) { response.writeHead(400); response.end("Invalid fixture identity"); return true; }
      const record = entry(key); record.requests.push({ method: request.method, url: url.href, at: Date.now() });
      response.setHeader("Cache-Control", "no-store");
      if (request.method === "GET" && [directUploadRoute + "page", directUploadRoute + "frame"].includes(url.pathname)) {
        const port = typeof portOrURL === "number" ? portOrURL : Number(url.port || new URL(`http://${request.headers.host}`).port);
        const body = Buffer.from(directLocatorUploadHTML(url, port)); record.requests.at(-1).sha256 = hash(body);
        response.setHeader("Content-Type", "text/html; charset=utf-8"); response.end(body); return true;
      }
      if (request.method !== "POST" || ![directUploadRoute + "upload", directUploadRoute + "witness"].includes(url.pathname)) { response.writeHead(404); response.end(); return true; }
      const witness = url.pathname.endsWith("/witness");
      const hit = { at: Date.now(), method: request.method }, chunks = []; let size = 0; (witness ? record.witnesses : record.posts).push(hit);
      request.on("data", chunk => { size += chunk.length; if (size <= 512 * 1024) chunks.push(chunk); });
      request.on("error", error => { hit.error = String(error); });
      request.on("aborted", () => { hit.error = "Request aborted"; });
      request.on("end", () => {
        try {
          assert.ok(size <= 512 * 1024); const body = Buffer.concat(chunks);
          Object.assign(hit, { bytes: body.length, base64: body.toString("base64"), sha256: hash(body) });
          const value = JSON.parse(body.toString("utf8")); assert.equal(value.key, key); assert.equal(value.variant, variant);
          assert.ok(Array.isArray(value.files) && (witness || value.files.length > 0) && value.files.length <= 64);
          if (witness) { assert.equal(value.type, "input"); assert.equal(value.original, true); assert.equal(typeof value.trusted, "boolean"); hit.value = value; response.end("{}"); return; }
          hit.value = value; hit.files = sorted(value.files.map(file => {
            const bytes = Buffer.from(file.base64, "base64"); assert.equal(bytes.toString("base64"), file.base64); assert.equal(bytes.length, file.size);
            return { name: file.name, relativePath: file.relativePath, size: bytes.length, sha256: hash(bytes) };
          }));
          hit.receipt = { key, variant, documentToken: value.documentToken, inputToken: value.inputToken, submission: value.submissions, files: hit.files };
          response.setHeader("Content-Type", "application/json"); response.end(JSON.stringify(hit.receipt));
        } catch (error) { hit.error = String(error); response.writeHead(400); response.end(JSON.stringify({ error: hit.error })); }
      });
      return true;
    },
  };
}

export async function prepareDirectLocatorUploadFiles(runDir) {
  const dir = path.join(runDir, "direct-locator-files"); await fs.mkdir(dir);
  const values = [["资料-🙂.txt", Buffer.from("Direct locator 中文🙂\n")], ["bytes.bin", Buffer.from([0, 1, 10, 127, 128, 254, 255])], ["empty.dat", Buffer.alloc(0)]];
  const files = [];
  for (const [name, bytes] of values) { const filename = path.join(dir, name); await fs.writeFile(filename, bytes, { flag: "wx" }); files.push({ path: filename, name, size: bytes.length, relativePath: "", sha256: hash(bytes) }); }
  return files;
}

export function checkDirectUploadState(state, { key, variant, files, previous, cleared = false, directory = false }) {
  assert.equal(state.key, key); assert.equal(state.variant, variant); assert.equal(state.directory, directory);
  assert.equal(state.overflow, false); assert.deepEqual(state.errors, []); assert.deepEqual(state.clicks, []);
  assert.match(state.documentToken, /^[0-9a-f-]{36}$/); assert.match(state.inputToken, /^[0-9a-f-]{36}$/);
  assert.deepEqual(state.input, { tag: "INPUT", type: "file", multiple: true, directory, connected: true, original: true, display: "none" });
  assert.deepEqual(metadata(state.files), metadata(cleared ? [] : files));
  if (previous) { assert.equal(state.documentToken, previous.documentToken); assert.equal(state.inputToken, previous.inputToken); assert.equal(state.href, previous.href); }
  return state;
}

export function checkDirectUploadResult(result, files, server) {
  assert.equal(result.passed, true); assert.deepEqual(result.variants.map(item => item.variant), directUploadVariants);
  assert.ok(["js", "cli", "mcp", "python", "go"].includes(result.caller)); assert.ok(result.key.startsWith(`direct-${result.caller}-`));
  assert.equal(result.scope.session_id, result.key); assert.ok(typeof result.scope.turn_id === "string" && result.scope.turn_id.length > 0);
  assert.ok(Number.isSafeInteger(result.scope.control_epoch) && result.scope.control_epoch > 0);
  assert.equal(new Set(result.variants.map(item => item.tabId)).size, 3);
  assert.deepEqual(result.createdTabIds, result.variants.map(item => item.tabId));
  for (const item of result.variants) {
    assert.equal(item.key, `${result.key}-${item.variant}`);
    checkDirectUploadItem(item, files, server.stats(item.key));
    if (item.variant === "root") {
      assert.deepEqual(item.negatives.map(value => value.name), ["strict", "non-file", "null", "relative"]);
      for (const rejected of item.negatives) { assert.ok(rejected.error); assert.doesNotMatch(rejected.error, /timed out|timeout|deadline|disconnect/i); }
      assert.deepEqual(item.afterNegatives, item.before);
    }
  }
  assert.ok(result.finalizeResult !== undefined); assert.equal(result.cleanupError, undefined);
  return result;
}

export function checkDirectUploadItem(item, files, record, directory = false) {
    assert.equal(item.passed, true); assert.ok(Number.isSafeInteger(item.tabId) && item.tabId >= 0);
    const options = { key: item.key, variant: item.variant, files, directory };
    checkDirectUploadState(item.before, { ...options, files: [] });
    checkDirectUploadState(item.uploaded, { ...options, previous: item.before });
    checkDirectUploadState(item.cleared, { ...options, previous: item.before, cleared: true });
    assert.deepEqual(item.before.events, []); assert.equal(item.before.submissions, 0);
    assert.deepEqual(item.uploaded.events.map(event => event.type), ["input", "change"]);
    assert.deepEqual(item.cleared.events.map(event => event.type), ["input", "change", "input", "change"]);
    assert.ok(item.uploaded.events.every(event => event.trusted && event.original));
    assert.ok(item.cleared.events.every(event => event.original)); assert.equal(item.cleared.submissions, 1);
    for (const event of item.cleared.events.slice(2)) { assert.deepEqual(event.files, []); assert.equal(event.trusted, false); }
    assert.equal(record.posts.length, 1); const post = record.posts[0];
    assert.equal(post.error, undefined); const raw = Buffer.from(post.base64, "base64"); assert.equal(raw.length, post.bytes); assert.equal(hash(raw), post.sha256);
    assert.deepEqual(JSON.parse(raw.toString("utf8")), post.value); assert.deepEqual(post.value.events, item.uploaded.events);
    assert.equal(post.value.submissions, 1); assert.deepEqual(post.value.clicks, []); assert.deepEqual(post.value.errors, []); assert.equal(post.value.overflow, false);
    assert.equal(post.value.documentToken, item.before.documentToken); assert.equal(post.value.inputToken, item.before.inputToken);
    assert.deepEqual(post.files, sorted(files.map(({ name, size, relativePath, sha256 }) => ({ name, size, relativePath, sha256 }))));
    assert.deepEqual(item.receipt, post.receipt); item.server = record;
    return item;
}

export function checkDirectDirectoryImmediate(record, { before, files, clear = false }) {
  assert.equal(record.witnesses.length, clear ? 2 : 1, "Directory setter resolved before its original input completion");
  const hit = record.witnesses.at(-1); assert.equal(hit.error, undefined);
  const raw = Buffer.from(hit.base64, "base64"); assert.equal(raw.length, hit.bytes); assert.equal(hash(raw), hit.sha256); assert.deepEqual(JSON.parse(raw.toString("utf8")), hit.value);
  const value = hit.value; assert.equal(value.key, before.key); assert.equal(value.variant, before.variant);
  assert.equal(value.documentToken, before.documentToken); assert.equal(value.inputToken, before.inputToken);
  assert.equal(value.type, "input"); assert.equal(value.original, true); assert.equal(value.trusted, !clear);
  assert.deepEqual(metadata(value.files), metadata(clear ? [] : files));
}

export const directUploadKey = kind => `direct-${kind}-${randomUUID()}`;

import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

const sha = bytes => createHash("sha256").update(bytes).digest("hex");
export const managedDirectoryCases = Object.freeze(["root", "oopif", "transfer-end", "transfer-navigation"]);
export const directorySort = files => [...files].sort((a, b) => a.relativePath.localeCompare(b.relativePath, "en"));
export function managedDirectoryPayloads(kind) {
  assert.ok(managedDirectoryCases.includes(kind));
  const root = "目录-资料";
  const first = Buffer.alloc(["root", "oopif"].includes(kind) ? 40001 : 16 * 1024 * 1024);
  for (let i = 0; i < first.length; i++) first[i] = i * 37 % 251;
  return [
    ["中文.txt", first], ["甲/same.txt", Buffer.from("First original 中文\n")],
    ["乙/same.txt", Buffer.from("Second original same basename\0\n")],
    ["嵌套/更深/binary.dat", Buffer.from([0, 1, 127, 128, 254, 255])], ["zero.bin", Buffer.alloc(0)],
  ].map(([relative, buffer]) => ({ name: path.posix.basename(relative), relativePath: `${root}/${relative}`, buffer }));
}
export async function prepareManagedDirectory(runDir, kind) {
  const files = managedDirectoryPayloads(kind), parent = path.join(runDir, "directory-inputs", kind);
  const root = path.join(parent, files[0].relativePath.split("/")[0]);
  await fs.mkdir(root, { recursive: true });
  for (const file of files) {
    const target = path.join(parent, ...file.relativePath.split("/"));
    await fs.mkdir(path.dirname(target), { recursive: true }); await fs.writeFile(target, file.buffer, { flag: "wx" });
  }
  // Browser FileList cannot represent an empty directory; it is not fabricated.
  await fs.mkdir(path.join(root, "空子目录"));
  return { root, files: files.map(file => ({ name: file.name, relativePath: file.relativePath, size: file.buffer.length, sha256: sha(file.buffer) })) };
}
export function createManagedDirectoryFixture({ baseURL, kind }) {
  assert.ok(managedDirectoryCases.includes(kind));
  const base = new URL(baseURL); assert.equal(base.hostname, "127.0.0.1"); assert.equal(base.protocol, "http:");
  const workflowId = randomUUID(), prefix = `/human-directory/${workflowId}/`;
  const root = new URL(prefix + "root", base), leaf = new URL(prefix + "leaf", base);
  if (kind === "oopif") leaf.hostname = "localhost";
  const emitter = kind === "oopif" ? leaf : root;
  const urls = Object.fromEntries(["receipt", "witness", "gate", "landed"].map(name => [name, new URL(prefix + name, emitter).href]));
  Object.assign(urls, { root: root.href, emitter: emitter.href });
  const tokens = {}, requests = [], witnesses = []; let overflow = false, posted = false, receipt = null, gateResponse = null, gateReleased = false;
  const stats = () => structuredClone({ workflowId, kind, urls, tokens, requests, witnesses, overflow, posted, receipt, gateReleased });
  const json = value => JSON.stringify(value).replaceAll("<", "\\u003c");
  const page = role => {
    const active = role === (kind === "oopif" ? "leaf" : "root");
    const state = { workflowId, kind, role, documentToken: tokens[role], inputToken: active ? randomUUID() : null,
      events: [], overflow: false, posts: 0, phase: "ready", error: null };
    return `<!doctype html><meta charset="utf-8"><title>Original ${kind} directory</title><link rel="icon" href="data:,">
<style>*{box-sizing:border-box}body{margin:8px;font:15px sans-serif;background:#eef5ff;color:#17324d}h1{font-size:18px;margin:0 0 8px}input{display:block;width:420px;height:42px;margin:12px 0;font:16px sans-serif}iframe{width:700px;height:265px;border:2px solid #789}button{padding:8px;font:16px sans-serif}</style>
<h1>${kind} ${role} directory</h1>${active ? `<form id="form"><input id="upload" type="file" webkitdirectory ${kind === "oopif" ? "" : "multiple"}><button id="submit">Submit original directory</button></form>` : `<iframe id="child" src=${json(urls.emitter)}></iframe>`}<pre id="state" hidden></pre><pre id="receipt"></pre>
<script>const state=${json(state)},render=()=>document.getElementById('state').textContent=JSON.stringify(state),input=document.getElementById('upload');
const metadata=()=>Array.from(input?.files??[],f=>({name:f.name,size:f.size,relativePath:f.webkitRelativePath}));
${active ? `for(const type of ['click','input','change','cancel'])input.addEventListener(type,e=>{
if(state.events.length>=32){state.overflow=true;render();return}
const event={type,trusted:e.isTrusted,files:metadata(),originalNode:e.target===input&&input.isConnected&&document.getElementById('upload')===input};state.events.push(event);render();
if(type==='input'){const xhr=new XMLHttpRequest();xhr.open('POST',${json(urls.witness)},false);xhr.setRequestHeader('Content-Type','application/json');xhr.send(JSON.stringify({workflowId:state.workflowId,documentToken:state.documentToken,inputToken:state.inputToken,event}));if(xhr.status!==200){state.error='input witness failed';render()}}},{capture:true});
document.getElementById('form').addEventListener('submit',async e=>{e.preventDefault();state.events.push({type:'submit',trusted:e.isTrusted,files:metadata()});if(state.posts++)throw Error('No replay');
state.phase='posting';render();try{const files=[];for(const f of input.files){const bytes=new Uint8Array(await f.arrayBuffer());let binary='';for(const b of bytes)binary+=String.fromCharCode(b);files.push({name:f.name,size:f.size,relativePath:f.webkitRelativePath,data:btoa(binary)})}
const response=await fetch(${json(urls.receipt)},{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({workflowId:state.workflowId,documentToken:state.documentToken,inputToken:state.inputToken,posts:state.posts,files,events:state.events})});
const receipt=await response.json();document.getElementById('receipt').textContent=JSON.stringify(receipt);if(!response.ok||!receipt.ok)throw Error('Original directory rejected');state.phase='committed';render()}catch(error){state.error=String(error);state.phase='failed';render()}});
${kind === "transfer-navigation" ? `fetch(${json(urls.gate)}).then(r=>{if(!r.ok)throw Error('gate failed');return r.json()}).then(v=>{if(v.navigate===true)location.href=${json(urls.landed)}}).catch(e=>{state.error=String(e);render()});` : ""}` : ""}
render();</script>`;
  };
  const reply = (res, hit, code, body, type = "application/json") => { hit.status = code; res.writeHead(code, { "Content-Type": type, "Cache-Control": "no-store" }); res.end(body); };
  function handle(req, res) {
    const url = new URL(req.url, base); if (!url.pathname.startsWith(prefix)) return false;
    if (requests.length >= 20) { overflow = true; req.resume(); res.writeHead(429); res.end(); return true; }
    const hit = { method: req.method, path: url.pathname, host: req.headers.host, at: Date.now(), finished: false, aborted: false }; requests.push(hit);
    res.once("finish", () => { hit.finished = true; }); res.once("close", () => { hit.aborted = !res.writableFinished; });
    const role = ["root", "leaf", "landed"].find(value => url.pathname === prefix + value);
    const expected = role === "root" ? root : emitter;
    if (req.url !== url.pathname || req.headers.host !== expected.host) { req.resume(); reply(res, hit, 400, "{}"); return true; }
    if (req.method === "GET" && role) {
      req.resume(); if (tokens[role] || role === "leaf" && (!tokens.root || kind !== "oopif") || role === "landed" && !gateReleased) { reply(res, hit, 409, "{}"); return true; }
      tokens[role] = randomUUID();
      reply(res, hit, 200, role === "landed" ? `<!doctype html><title>Directory navigation finished</title><link rel="icon" href="data:,"><pre id="state">${json({ workflowId, role, documentToken: tokens[role], phase: "landed", events: [], overflow: false })}</pre>` : page(role), "text/html; charset=utf-8"); return true;
    }
    if (req.method === "GET" && url.pathname === prefix + "gate" && kind === "transfer-navigation" && !gateResponse) { req.resume(); gateResponse = { res, hit }; return true; }
    const witness = url.pathname === prefix + "witness", business = url.pathname === prefix + "receipt";
    if (req.method !== "POST" || !["root", "oopif"].includes(kind) || !witness && !business) { req.resume(); reply(res, hit, 405, "{}"); return true; }
    const duplicate = business && posted; if (business) posted = true;
    let size = 0; const chunks = [];
    req.on("data", data => { size += data.length; if (size <= 256 * 1024) chunks.push(data); });
    req.once("end", () => {
      try {
        assert.equal(duplicate, false); assert.ok(size <= 256 * 1024);
        const raw = Buffer.concat(chunks), body = JSON.parse(raw);
        Object.assign(hit, { bodySHA256: sha(raw), bodyBytes: size, bodyBase64: raw.toString("base64") });
        assert.equal(body.workflowId, workflowId); assert.equal(body.documentToken, tokens[kind === "oopif" ? "leaf" : "root"]);
        assert.ok(typeof body.inputToken === "string" && body.inputToken);
        const expectedFiles = managedDirectoryPayloads(kind);
        const metadata = files => directorySort(files.map(file => ({ name: file.name, size: file.size ?? file.buffer.length, relativePath: file.relativePath })));
        if (witness) {
          assert.equal(witnesses.length, 0); assert.equal(body.event.type, "input"); assert.equal(body.event.trusted, true); assert.equal(body.event.originalNode, true);
          assert.deepEqual(metadata(body.event.files), metadata(expectedFiles)); witnesses.push({ at: hit.at, ...body });
          reply(res, hit, 200, '{"ok":true}'); return;
        }
        assert.equal(body.posts, 1); assert.equal(witnesses.length, 1); assert.equal(body.inputToken, witnesses[0].inputToken);
        assert.deepEqual(metadata(body.files), metadata(expectedFiles));
        const files = directorySort(body.files.map(file => {
          const expectedFile = expectedFiles.find(value => value.relativePath === file.relativePath); assert.ok(expectedFile);
          const bytes = Buffer.from(file.data, "base64"); assert.equal(bytes.toString("base64"), file.data); assert.deepEqual(bytes, expectedFile.buffer);
          return { name: file.name, relativePath: file.relativePath, size: bytes.length, sha256: sha(bytes) };
        }));
        assert.equal(body.events.filter(event => event.type === "input").length, 1);
        assert.equal(body.events.filter(event => event.type === "change").length, 1);
        assert.equal(body.events.filter(event => event.type === "submit").length, 1); assert.ok(body.events.every(event => event.trusted));
        receipt = { ok: true, workflowId, documentToken: body.documentToken, inputToken: body.inputToken, files, events: body.events, posts: 1 };
        reply(res, hit, 200, JSON.stringify(receipt));
      } catch (error) { hit.validationError = String(error); reply(res, hit, 400, '{"ok":false}'); }
    }); return true;
  }
  return { kind, workflowId, urls, handle, stats, releaseNavigation() {
    assert.equal(kind, "transfer-navigation"); assert.ok(gateResponse && !gateReleased);
    gateReleased = true; reply(gateResponse.res, gateResponse.hit, 200, '{"navigate":true}');
  } };
}

export function readManagedDirectoryDocument() {
  const raw = document.getElementById("state")?.textContent; if (!raw) return null;
  const state = JSON.parse(raw), input = document.getElementById("upload"), child = document.getElementById("child"), submit = document.getElementById("submit");
  const rectangle = element => { if (!element) return null; const r = element.getBoundingClientRect(); return { x: r.x, y: r.y, width: r.width, height: r.height }; };
  return { url: location.href, state, files: Array.from(input?.files ?? [], file => ({ name: file.name, size: file.size, relativePath: file.webkitRelativePath })),
    input: input ? { directory: input.webkitdirectory, multiple: input.multiple, type: input.type, connected: input.isConnected } : null,
    inputRect: rectangle(input), childRect: rectangle(child), childInset: child ? { x: child.clientLeft, y: child.clientTop } : null,
    documentVisibility: { state: document.visibilityState, hidden: document.hidden, hasFocus: document.hasFocus() }, submit: submit ? { rect: rectangle(submit) } : null,
    viewport: { width: innerWidth, height: innerHeight }, receipt: JSON.parse(document.getElementById("receipt")?.textContent || "null") };
}

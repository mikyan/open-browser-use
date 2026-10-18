import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";

const hash = bytes => createHash("sha256").update(bytes).digest("hex");
const jsonScript = value => JSON.stringify(value).replaceAll("<", "\\u003c");
const identity = value => typeof value === "string" && /^[a-z][a-z0-9-]{0,63}$/.test(value);
const bytesRecord = bytes => ({ bytes: bytes.length, sha256: hash(bytes), base64: bytes.toString("base64") });
const shell = (title, body, script) => `<!doctype html><meta charset="utf-8"><title>${title}</title>
<link rel="icon" href="data:,">
<style>body{font:16px sans-serif;margin:20px;max-width:650px;background:#f3f7ff;color:#17324d}h1{font-size:22px}label{display:block;margin:12px 0}input,textarea,button{font:inherit;padding:8px}input,textarea{display:block;width:540px;box-sizing:border-box}button{margin:8px 12px 8px 0}pre{white-space:pre-wrap;overflow-wrap:anywhere;font:13px monospace}#state{display:none}</style>
${body}<pre id="state"></pre><script>${script}</script>`;

// The fixture records original requests and rejects retries of every business
// route. Only the public browser clients perform page actions; this server
// never repairs a caller's page, creates a replacement, or replays a submission.
export function createManagedWorkflowFixture() {
  const tasks = new Map(), requests = [];
  function createTask({ taskId, caller }) {
    assert.ok(identity(taskId), "Bounded fixture task identity");
    assert.ok(["js", "python", "go", "cli", "mcp"].includes(caller));
    assert.ok(tasks.size < 5 && !tasks.has(taskId), "Exactly one original task per caller");
    assert.ok(![...tasks.values()].some(task => task.caller === caller), "Duplicate caller task");
    const prefix = `/managed-workflow/${taskId}`;
    const expected = { taskId, reference: `REF-${randomUUID().slice(0, 8)}`, amount: "137.25", note: `Reviewed ${caller} 原始报表` };
    const item = { taskId, caller, sourcePath: prefix + "/source", childPath: prefix + "/child", commitPath: prefix + "/commit", downloadPath: prefix + "/report", expected,
      sourceToken: randomUUID(), documentToken: randomUUID(), receiptId: randomUUID(), requests: [], sourceOpened: false, childOpened: false, committed: false, downloaded: false };
    tasks.set(taskId, item);
    return structuredClone({ taskId, caller, sourcePath: item.sourcePath, childPath: item.childPath, commitPath: item.commitPath, downloadPath: item.downloadPath, expected });
  }
  function sourcePage(task) {
    return shell(`Managed workflow ${task.caller} source`, `<h1>Original ${task.caller} task</h1><p id="task-id">${task.taskId}</p><button id="open-task" type="button">Open task form</button>`, `
const state={taskId:${jsonScript(task.taskId)},documentToken:${jsonScript(task.sourceToken)},clicks:[],opened:false};
const render=()=>document.querySelector('#state').textContent=JSON.stringify(state);render();
document.querySelector('#open-task').addEventListener('click',event=>{
state.clicks.push({trusted:event.isTrusted,button:event.button,ctrlKey:event.ctrlKey,altKey:event.altKey,shiftKey:event.shiftKey,metaKey:event.metaKey});
if(state.clicks.length!==1){render();return}event.currentTarget.disabled=true;
state.opened=!!window.open(${jsonScript(task.childPath)},'_blank');render();});`);
  }
  function childPage(task) {
    return shell(`Managed workflow ${task.caller} result`, `<h1>Review original report</h1><p id="task-id">${task.taskId}</p><pre id="instructions"></pre>
<form id="form"><label>Reference<input name="reference" autocomplete="off" required></label><label>Amount<input name="amount" autocomplete="off" required></label><label>Review note<textarea name="note" required></textarea></label><button id="submit-task" type="submit">Submit task once</button></form>
<button id="download-report" type="button" disabled>Download original report</button><h2>Original receipt</h2><pre id="receipt"></pre>`, `
const instructions=${jsonScript(task.expected)},state={taskId:instructions.taskId,documentToken:${jsonScript(task.documentToken)},submits:[],downloads:[],inputs:[],error:null};
document.querySelector('#instructions').textContent=JSON.stringify(instructions);
const render=()=>document.querySelector('#state').textContent=JSON.stringify(state);render();
document.querySelector('#form').addEventListener('input',event=>{if(state.inputs.length<64)state.inputs.push({name:event.target.name,value:event.target.value,trusted:event.isTrusted});else state.error='input overflow';render()});
document.querySelector('#form').addEventListener('submit',async event=>{
event.preventDefault();state.submits.push({trusted:event.isTrusted,submitter:event.submitter?.id??null});render();
if(state.submits.length!==1)return;document.querySelector('#submit-task').disabled=true;
const data={taskId:instructions.taskId,reference:document.querySelector('[name=reference]').value,amount:document.querySelector('[name=amount]').value,note:document.querySelector('[name=note]').value,documentToken:state.documentToken};
try{const response=await fetch(${jsonScript(task.commitPath)},{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(data)});const receipt=await response.json();if(!response.ok||!receipt.ok)throw Error('original submission rejected');document.querySelector('#receipt').textContent=JSON.stringify(receipt);document.querySelector('#download-report').disabled=false;}catch(error){state.error=String(error)}render();});
document.querySelector('#download-report').addEventListener('click',event=>{
state.downloads.push({trusted:event.isTrusted,button:event.button});render();if(state.downloads.length!==1)return;event.currentTarget.disabled=true;location.href=${jsonScript(task.downloadPath)};});`);
  }
  function handle(request, response) {
    const url = new URL(request.url, "http://127.0.0.1"), match = /^\/managed-workflow\/([a-z][a-z0-9-]{0,63})\/(source|child|commit|report)$/.exec(url.pathname);
    if (!match || !tasks.has(match[1])) return false;
    const task = tasks.get(match[1]), route = match[2];
    if (requests.length >= 64) { request.resume(); response.writeHead(429); response.end("Fixture request capacity exceeded"); return true; }
    const entry = { taskId: task.taskId, route, method: request.method, url: request.url, at: Date.now(), finished: false, closed: false };
    requests.push(entry); task.requests.push(entry);
    response.once("finish", () => { entry.finished = true; });
    response.once("close", () => { entry.closed = true; entry.aborted = !response.writableFinished; });
    const reply = (status, body, type = "application/json; charset=utf-8", headers = {}) => {
      const bytes = Buffer.isBuffer(body) ? body : Buffer.from(body); entry.status = status; entry.response = bytesRecord(bytes);
      response.writeHead(status, { "Content-Type": type, "Content-Length": bytes.length, "Cache-Control": "no-store", ...headers }); response.end(bytes);
    };
    const reject = message => reply(409, JSON.stringify({ ok: false, error: message }));
    if (url.search || request.url !== url.pathname) { request.resume(); reject("Exact original route required"); return true; }
    if (route === "commit" && request.method === "POST") {
      const chunks = []; let size = 0;
      request.on("data", chunk => { size += chunk.length; if (size <= 16384) chunks.push(chunk); });
      request.on("error", error => { entry.requestError = String(error); });
      request.on("end", () => {
        const bytes = Buffer.concat(chunks); entry.body = bytesRecord(bytes); entry.receivedBytes = size;
        if (size > 16384 || !task.childOpened || task.committed) { reject("Original submission cannot be repeated"); return; }
        try {
          const submitted = JSON.parse(bytes.toString("utf8"));
          assert.deepEqual(submitted, { ...task.expected, documentToken: task.documentToken });
          task.receipt = { ok: true, ...submitted, receiptId: task.receiptId }; task.committed = true;
          task.file = bytesRecord(Buffer.from(JSON.stringify(task.receipt) + "\n"));
          reply(200, JSON.stringify(task.receipt));
        } catch { reject("Submission does not match this original task"); }
      });
      return true;
    }
    request.resume();
    if (request.method !== "GET") { reject("Original method required"); return true; }
    if (route === "source" && !task.sourceOpened) { task.sourceOpened = true; reply(200, sourcePage(task), "text/html; charset=utf-8"); }
    else if (route === "child" && task.sourceOpened && !task.childOpened) { task.childOpened = true; reply(200, childPage(task), "text/html; charset=utf-8"); }
    else if (route === "report" && task.committed && !task.downloaded) {
      task.downloaded = true;
      reply(200, Buffer.from(task.file.base64, "base64"), "application/octet-stream", { "Content-Disposition": `attachment; filename="managed-${task.taskId}.json"` });
    } else reject("Original page or report cannot be recreated");
    return true;
  }
  const stats = () => structuredClone({ tasks: [...tasks.values()], requests });
  function verifyTask(summary) {
    const task = tasks.get(summary.taskId); assert.ok(task, "Known original task");
    assert.equal(summary.ok, true); assert.equal(summary.kind, task.caller);
    assert.deepEqual(task.requests.map(hit => [hit.method, hit.route, hit.status]), [["GET", "source", 200], ["GET", "child", 200], ["POST", "commit", 200], ["GET", "report", 200]]);
    for (const hit of task.requests) {
      assert.equal(hit.finished, true); assert.equal(hit.aborted, false);
      const bytes = Buffer.from(hit.response.base64, "base64"); assert.deepEqual(bytesRecord(bytes), hit.response);
    }
    assert.deepEqual(summary.receipt, task.receipt);
    assert.equal(summary.file.bytes, task.file.bytes); assert.equal(summary.file.sha256, task.file.sha256);
    assert.ok(Number.isSafeInteger(summary.sourceTabId) && Number.isSafeInteger(summary.resultTabId) && summary.sourceTabId !== summary.resultTabId);
    assert.ok(summary.finalize && typeof summary.finalize === "object");
    return { taskId: task.taskId, caller: task.caller, requests: 4, posts: 1, file: { bytes: task.file.bytes, sha256: task.file.sha256 }, receiptId: task.receiptId, documentToken: task.documentToken };
  }
  return { createTask, handle, stats, verifyTask };
}

// Read-only fixture evidence for the parent runner. These are observations,
// never page-control capabilities or substitutes for public caller receipts.
export function readManagedWorkflowDocument() {
  const text = selector => document.querySelector(selector)?.textContent ?? null;
  const parse = selector => { const raw = text(selector); return raw ? JSON.parse(raw) : null; };
  return { url: location.href, title: document.title, taskId: text("#task-id"), state: parse("#state"), receipt: parse("#receipt"), instructions: parse("#instructions") };
}

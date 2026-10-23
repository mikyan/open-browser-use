// A complete controlled-form task. Private expected values stay in this server;
// an independent solver receives only the public task and ordinary browser UI.
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const directory = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(directory, "../..");
const hash = bytes => createHash("sha256").update(bytes).digest("hex");
const escape = value => String(value).replace(/[&<>"']/g, character => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[character]);
const scriptJSON = value => JSON.stringify(value).replaceAll("<", "\\u003c");
const exactKeys = (value, names) => value !== null && typeof value === "object" && !Array.isArray(value) && Object.keys(value).sort().join("|") === [...names].sort().join("|");
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const maxBody = 128 * 1024;

function requirements(round) {
  assert.ok([1, 2].includes(round));
  return round === 1 ? {
    recipientName: "林晓🧪", recipientEmail: "lin@example.test", billingName: "保留账单账户", kit: "research", delivery: "pickup",
    materials: ["manual", "sticker"], voucher: "digital", subscribe: false, terms: true, greeting: "谢谢，团队 🚀", recipientConfirmed: true,
    department: "研发二组", preference: "周三上午",
  } : {
    recipientName: "陈禾🌱", recipientEmail: "chen@example.test", billingName: "保留账单账户", kit: "field", delivery: "courier",
    materials: ["checklist", "adapter"], voucher: "digital", subscribe: false, terms: true, greeting: "一路顺利，伙伴 🛰️", recipientConfirmed: true,
    department: "现场三组", preference: "周五下午",
  };
}

function instructions(round) {
  const value = requirements(round);
  return `Complete this local simulated equipment request; no payment is involved. Choose the available, active ${value.kit === "research" ? "Research kit" : "Field kit"}. In Recipient details only, set Name to “${value.recipientName}”, then press End in that field, and Email to “${value.recipientEmail}”; click that group's Confirm. Leave the Billing details Name “${value.billingName}” unchanged. Select ${value.delivery === "pickup" ? "Pickup" : "Courier"} delivery and only ${round === 1 ? "Manual and Stickers" : "Checklist and Adapter"} as Materials. Select Digital voucher, turn off Subscribe, and accept the simulation terms. Set Greeting to “${value.greeting}”. In the Department settings frame, save Note “${value.department}” once. This reveals a delivery preview frame. Once the preview has loaded, click Update delivery form in the parent page to replace it with the current version. In that current Delivery preferences frame, save Note “${value.preference}” once. When Submit request becomes available, submit exactly once. Read the saved receipt JSON and leave that receipt as the sole task deliverable.`;
}

export { instructions as managedAgentFormInstructions };

function shell(title, body) {
  return `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="icon" href="data:,"><title>${escape(title)}</title><style>body{font:16px system-ui,sans-serif;max-width:980px;margin:24px auto;padding:0 22px;background:#f7f9fc;color:#20334c}fieldset,section{border:1px solid #bac8da;border-radius:8px;padding:16px;margin:14px 0;background:white}label{display:block;margin:10px 0}input,select,textarea,button{font:inherit;padding:8px}button{margin:5px;cursor:pointer}button:disabled{cursor:default}li{padding:8px}iframe{display:block;width:100%;height:255px;border:2px solid #aabed4;margin:12px 0}output{display:block;margin:8px 0}pre{white-space:pre-wrap;overflow-wrap:anywhere}[hidden]{display:none!important}</style>${body}</html>`;
}

// Browser event fields are observations supplied by the fixture page, not
// cryptographic proof of isTrusted. Public traces and independent native/page
// observations must be audited alongside the original HTTP record.
function validEvents(events) {
  return Array.isArray(events) && events.length <= 256 && events.every((event, index) =>
    exactKeys(event, ["sequence", "type", "trusted", "id", "value", "key", "at"]) && event.sequence === index &&
    ["pointerdown", "click", "keydown", "input", "change", "submit"].includes(event.type) && typeof event.trusted === "boolean" &&
    typeof event.id === "string" && event.id.length <= 80 && typeof event.key === "string" && event.key.length <= 80 &&
    Number.isSafeInteger(event.at) && event.at > 0 && (typeof event.value === "boolean" || typeof event.value === "string" && event.value.length <= 256 ||
      Array.isArray(event.value) && event.value.length <= 4 && event.value.every(item => typeof item === "string" && item.length <= 32)));
}

function frameHTML(record, scope, generation, port) {
  const base = `/agent-form/${record.taskId}`, frame = record.frames[scope === "same" ? "same" : `cross${generation}`];
  const title = scope === "same" ? "Department settings" : "Delivery preferences";
  if (scope === "cross" && generation === 1) return shell(title, `<h1>Delivery preview · version 1</h1><p>This preview is obsolete. Use Update delivery form in the parent page before entering the delivery note.</p><output id="preview-ready">Preview loaded</output>`);
  return shell(title, `<h1>${title}${scope === "cross" ? " · current version 2" : ""}</h1><form id="frame-form"><label>Note <input id="frame-note" autocomplete="off" required></label><button id="save-frame" type="submit">Save settings</button><output id="frame-status" role="status">Not saved</output></form><script>
const base=${scriptJSON(base)},nonce=${scriptJSON(record.nonce)},documentToken=${scriptJSON(frame.documentToken)},scope=${scriptJSON(scope)},generation=${generation},events=[];let overflow=false,submitted=false;
for(const type of ['pointerdown','click','keydown','input','change','submit'])document.addEventListener(type,event=>{if(events.length>=256){overflow=true;return}const node=event.composedPath()[0];events.push({sequence:events.length,type,trusted:event.isTrusted,id:node.id??'',value:String(node.value??'').slice(0,256),key:event.key??'',at:Date.now()});},true);
document.querySelector('form').addEventListener('submit',async event=>{event.preventDefault();if(submitted)return;submitted=true;document.getElementById('save-frame').disabled=true;
fetch(base+'/save/'+scope,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({nonce,documentToken,generation,note:document.getElementById('frame-note').value,events,overflow})}).then(async response=>{const data=await response.json();if(!response.ok)throw Error(data.error);document.getElementById('frame-status').textContent='Saved';parent.postMessage({tag:'managed-agent-form-saved',nonce,scope,generation,documentToken},${scriptJSON(`http://127.0.0.1:${port}`)});}).catch(error=>{document.getElementById('frame-status').textContent='Save failed: '+error.message;});});</script>`);
}

export async function buildManagedAgentFormApp() {
  const esbuild = await import("esbuild"), source = path.join(directory, "managed-agent-form-app.jsx");
  assert.ok(!process.env.ESBUILD_BINARY_PATH, "An overridden esbuild binary has no frozen provenance here");
  const relative = file => {
    const value = path.relative(repo, path.resolve(file)).replaceAll("\\", "/");
    assert.ok(value && !value.startsWith("../") && value !== ".." && !path.isAbsolute(value)); return value;
  };
  const snapshot = async files => Object.fromEntries(await Promise.all([...files].sort().map(async file => [relative(file), hash(await fs.readFile(file))])));
  const bundle = async () => {
    const loaded = new Map();
    const result = await esbuild.build({ absWorkingDir: repo, entryPoints: [source], bundle: true, write: false, format: "iife", platform: "browser", metafile: true,
      define: { "process.env.NODE_ENV": '"production"' }, logLevel: "silent", plugins: [{ name: "record-original-bundle-inputs", setup(build) {
        build.onLoad({ filter: /\.(?:js|jsx)$/ }, async ({ path: file }) => {
          const contents = await fs.readFile(file); loaded.set(path.resolve(file), contents);
          return { contents, loader: file.endsWith(".jsx") ? "jsx" : "js", resolveDir: path.dirname(file) };
        });
      } }] });
    assert.equal(result.outputFiles.length, 1);
    const inputHashes = {};
    for (const file of Object.keys(result.metafile.inputs).sort()) {
      const absolute = path.resolve(repo, file), original = loaded.get(absolute); assert.ok(original, "Every bundle source must be captured when loaded");
      inputHashes[relative(absolute)] = hash(original);
    }
    return { code: result.outputFiles[0].text, inputHashes };
  };
  const require = createRequire(import.meta.url), nativeNames = { "win32-x64": "@esbuild/win32-x64/esbuild.exe", "linux-x64": "@esbuild/linux-x64/bin/esbuild", "darwin-arm64": "@esbuild/darwin-arm64/bin/esbuild", "darwin-x64": "@esbuild/darwin-x64/bin/esbuild" };
  const native = nativeNames[`${process.platform}-${process.arch}`]; assert.ok(native, "Explicit esbuild native platform provenance required");
  const toolFiles = [require.resolve("esbuild"), require.resolve("esbuild/package.json"), require.resolve(native), path.join(directory, "package.json"), path.join(directory, "package-lock.json")];
  // Discovery establishes only the input set. Only the second build's output is
  // delivered; its actual source loads and both surrounding snapshots must agree.
  const discovered = await bundle(), inputFiles = Object.keys(discovered.inputHashes).map(file => path.resolve(repo, file));
  const before = { inputs: await snapshot(inputFiles), tools: await snapshot(toolFiles) };
  const { code, inputHashes } = await bundle();
  const after = { inputs: await snapshot(Object.keys(inputHashes).map(file => path.resolve(repo, file))), tools: await snapshot(toolFiles) };
  assert.deepEqual(Object.keys(inputHashes).sort(), Object.keys(before.inputs).sort(), "Final bundle input set changed after discovery");
  assert.deepEqual(inputHashes, before.inputs, "Final bundle loaded input bytes differ from the before snapshot");
  assert.deepEqual(after.inputs, before.inputs, "Bundle input bytes changed across the final build");
  assert.deepEqual(after.tools, before.tools, "Bundle tool bytes changed across the final build");
  return { code, metadata: { sha256: hash(Buffer.from(code)), bytes: Buffer.byteLength(code), sourceSha256: inputHashes[relative(source)], esbuildVersion: esbuild.version,
    inputHashes, toolHashes: after.tools, provenance: { version: 1, method: "discovery-then-snapshotted-final-build", before, after,
      boundary: "Input hashes bind the final build's actual source loads and observed before/after bytes. Tool hashes observe on-disk files before and after that final build. These observations do not prove continuous immutability or independently attest an already loaded tool process." } } };
}

export function createManagedAgentFormFixture({ tasks, appJavaScript }) {
  assert.ok(Array.isArray(tasks) && tasks.length >= 1 && tasks.length <= 4);
  assert.ok(typeof appJavaScript === "string" || Buffer.isBuffer(appJavaScript));
  const app = Buffer.from(appJavaScript); assert.ok(app.length > 0 && app.length <= 2 * 1024 * 1024);
  const records = new Map(), slots = new Set();
  for (const task of tasks) {
    assert.ok(exactKeys(task, ["slot", "round", "side", "taskId"]));
    assert.ok(Number.isInteger(task.slot) && task.slot >= 1 && task.slot <= 4 && [1, 2].includes(task.round) && ["obu", "codex"].includes(task.side));
    assert.match(task.taskId, /^[a-z][a-z0-9-]{0,79}$/); assert.ok(!records.has(task.taskId) && !slots.has(task.slot)); slots.add(task.slot);
    records.set(task.taskId, { ...task, nonce: randomUUID(), rootDocumentToken: randomUUID(), expected: requirements(task.round),
      frames: Object.fromEntries(["same", "cross1", "cross2"].map(name => [name, { documentToken: randomUUID(), loads: 0 }])),
      currentCrossGeneration: 0, requests: [], posts: [], saves: {}, rootLoads: 0, submitAttempts: 0, acceptedSubmissions: 0, duplicateSubmissions: 0, receipt: null, overflow: false });
  }
  const publicTasks = port => {
    assert.ok(Number.isInteger(port) && port > 0 && port <= 65535);
    return [...records.values()].map(({ slot, round, side, taskId }) => ({ slot, round, side, taskId, url: `http://127.0.0.1:${port}/agent-form/${taskId}`, instructions: instructions(round) }));
  };
  const allStats = () => structuredClone([...records.values()]);
  function handle(request, response, port) {
    const url = new URL(request.url, "http://127.0.0.1"), matched = /^\/agent-form\/([a-z][a-z0-9-]{0,79})(?:\/(app\.js|frame\/(?:same|cross)|save\/(?:same|cross)|submit|receipt))?$/.exec(url.pathname);
    if (!matched || !records.has(matched[1])) return false;
    const record = records.get(matched[1]), route = matched[2] ?? "root";
    if (record.requests.length >= 128) { record.overflow = true; request.resume(); response.writeHead(429); response.end("Fixture request capacity exceeded"); return true; }
    const entry = { sequence: record.requests.length, method: request.method, route, url: request.url, at: Date.now(), finished: false, aborted: false };
    record.requests.push(entry);
    response.once("finish", () => { entry.finished = true; }); response.once("close", () => { entry.aborted = !response.writableFinished; });
    const reply = (status, data, type = "application/json; charset=utf-8") => {
      const bytes = Buffer.isBuffer(data) ? data : Buffer.from(type.startsWith("application/json") ? JSON.stringify(data) : data);
      entry.status = status; entry.responseBytes = bytes.length; entry.responseSHA256 = hash(bytes);
      response.writeHead(status, { "Content-Type": type, "Content-Length": bytes.length, "Cache-Control": "no-store" }); response.end(bytes);
    };
    const reject = (status, error) => { request.resume(); reply(status, { error }); };
    if (url.hash || request.url !== url.pathname + url.search || (route !== "frame/cross" && url.search)) { reject(400, "Exact fixture route required"); return true; }
    if (request.method === "GET") {
      request.resume();
      if (route === "root") {
        if (record.rootLoads++) { reply(409, { error: "Original form cannot be recreated" }); return true; }
        const config = { taskId: record.taskId, round: record.round, nonce: record.nonce, documentToken: record.rootDocumentToken, instructions: instructions(record.round),
          base: `/agent-form/${record.taskId}`, rootOrigin: `http://127.0.0.1:${port}`, crossOrigin: `http://localhost:${port}` };
        reply(200, shell("Controlled equipment request", `<h1>Equipment request · round ${record.round}</h1><p id="task-instructions">${escape(config.instructions)}</p><div id="app-root"></div><script id="task-config" type="application/json">${scriptJSON(config)}</script><script src="${config.base}/app.js" defer></script>`), "text/html; charset=utf-8"); return true;
      }
      if (!record.rootLoads) { reply(409, { error: "Open the original form first" }); return true; }
      if (route === "app.js") { reply(200, app, "application/javascript; charset=utf-8"); return true; }
      if (route === "frame/same") {
        if (record.frames.same.loads++) { reply(409, { error: "Original frame cannot be recreated" }); return true; }
        reply(200, frameHTML(record, "same", 1, port), "text/html; charset=utf-8"); return true;
      }
      if (route === "frame/cross") {
        const generation = Number(url.searchParams.get("generation"));
        if (![1, 2].includes(generation) || url.search !== `?generation=${generation}` || !record.saves.same || generation !== record.currentCrossGeneration + 1) { reply(409, { error: "Frame generation is not current" }); return true; }
        record.currentCrossGeneration = generation; record.frames[`cross${generation}`].loads++;
        reply(200, frameHTML(record, "cross", generation, port), "text/html; charset=utf-8"); return true;
      }
      if (route === "receipt" && record.receipt) { reply(200, shell("Saved equipment receipt", `<h1>Request saved</h1><p>This is the original saved request.</p><pre id="receipt-json">${escape(JSON.stringify(record.receipt, null, 2))}</pre>`), "text/html; charset=utf-8"); return true; }
      reply(409, { error: "No saved receipt or unsupported GET" }); return true;
    }
    if (request.method !== "POST" || !["save/same", "save/cross", "submit"].includes(route)) { reject(405, "Unsupported fixture method"); return true; }
    const chunks = []; let bytes = 0;
    const post = { sequence: entry.sequence, route, at: Date.now(), accepted: false, completed: false }; record.posts.push(post);
    if (route === "submit") record.submitAttempts++;
    request.on("data", chunk => { bytes += chunk.length; if (bytes <= maxBody) chunks.push(chunk); });
    request.once("aborted", () => { post.aborted = true; }); request.once("error", () => { post.error = "Request error"; });
    request.once("end", () => {
      const original = bytes <= maxBody ? Buffer.concat(chunks) : null;
      post.completed = true; post.bytes = bytes; post.raw = original?.toString("utf8") ?? null; post.base64 = original?.toString("base64") ?? null; post.sha256 = original ? hash(original) : null;
      const fail = (status, error) => { post.error = error; post.status = status; reply(status, { error }); };
      if (bytes > maxBody) { fail(413, "Body exceeds fixture limit"); return; }
      let data; try { data = JSON.parse(post.raw); } catch { fail(400, "Malformed JSON"); return; }
      if (!record.rootLoads || data?.nonce !== record.nonce || !validEvents(data.events) || data.overflow !== false) { fail(400, "Invalid original task or event evidence"); return; }
      if (route.startsWith("save/")) {
        const scope = route.slice(5), generation = scope === "same" ? 1 : 2, frame = record.frames[scope === "same" ? "same" : "cross2"];
        if (!exactKeys(data, ["nonce", "documentToken", "generation", "note", "events", "overflow"]) || data.documentToken !== frame.documentToken || data.generation !== generation || frame.loads !== 1 ||
          scope === "cross" && (record.currentCrossGeneration !== 2 || !record.saves.same) || data.note !== record.expected[scope === "same" ? "department" : "preference"]) { fail(422, "Frame values or current document failed validation"); return; }
        if (record.saves[scope]) { fail(409, "Frame settings were already saved"); return; }
        record.saves[scope] = { scope, saveId: `SAVE-${randomUUID()}`, sequence: entry.sequence, generation, documentToken: data.documentToken, note: data.note, events: data.events };
        post.accepted = true; post.status = 200; reply(200, { saved: scope, generation, saveId: record.saves[scope].saveId }); return;
      }
      if (record.receipt) { record.duplicateSubmissions++; fail(409, "Request was already submitted"); return; }
      const { department, preference, ...expectedValues } = record.expected;
      const transitions = ["same-saved", "cross-preview-loaded", "cross-replaced", "cross-current-loaded", "cross-saved"];
      if (!exactKeys(data, ["nonce", "documentToken", "round", "values", "stateRevision", "transitions", "events", "overflow"]) || data.documentToken !== record.rootDocumentToken || data.round !== record.round ||
        !exactKeys(data.values, Object.keys(expectedValues)) || Object.keys(expectedValues).some(key => !same(data.values[key], expectedValues[key])) ||
        !Number.isSafeInteger(data.stateRevision) || data.stateRevision < 10 || !record.saves.same || !record.saves.cross || record.currentCrossGeneration !== 2 ||
        !Array.isArray(data.transitions) || data.transitions.length !== transitions.length || data.transitions.some((item, index) => !exactKeys(item, ["kind", "at"]) || item.kind !== transitions[index] || !Number.isSafeInteger(item.at) || item.at <= 0 || index > 0 && item.at < data.transitions[index - 1].at)) {
        fail(422, "Controlled request or frame lifecycle failed validation"); return;
      }
      record.acceptedSubmissions++; post.accepted = true; post.status = 201;
      record.receipt = { version: 1, taskId: record.taskId, round: record.round, values: data.values,
        saves: ["same", "cross"].map(scope => { const { events, ...saved } = record.saves[scope]; return saved; }),
        receiptId: `FORM-${randomUUID()}`, documentToken: record.rootDocumentToken, stateRevision: data.stateRevision, transitions: data.transitions, submitSequence: entry.sequence };
      reply(201, { receiptURL: `/agent-form/${record.taskId}/receipt`, receiptId: record.receipt.receiptId });
    });
    return true;
  }
  return { handle, allStats, publicTasks };
}

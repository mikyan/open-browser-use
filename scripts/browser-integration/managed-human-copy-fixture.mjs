import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";

export const humanCopyText = "Shared 中文 🧭 original";
export const humanCutText = "Cut 中文 🧭 once";
export const humanCustomCopyText = "Custom handler 中文 🧭";
const humanCopyValues = Object.freeze({
  copy: humanCopyText, empty: "", custom: "Selection must not replace handler output", cut: humanCutText,
  "cancel-copy": "Keep selected copy 中文 🧭", "cancel-cut": "Keep selected cut 中文 🧭"
});
export const humanCopyCases = Object.freeze([
  { id: "copy-original", target: "copy", operation: "copy", selected: true, status: "ready", text: humanCopyText, value: humanCopyText,
    defaultPrevented: false, editEvents: [], selectionEnd: humanCopyText.length },
  { id: "copy-same-again", target: "copy", operation: "copy", selected: true, status: "ready", text: humanCopyText, value: humanCopyText,
    defaultPrevented: false, editEvents: [], selectionEnd: humanCopyText.length },
  { id: "copy-no-selection", target: "empty", operation: "copy", selected: false, status: "unchanged", text: humanCopyText, value: "",
    defaultPrevented: false, editEvents: [], selectionEnd: 0 },
  { id: "copy-custom-handler", target: "custom", operation: "copy", selected: true, status: "ready", text: humanCustomCopyText, value: humanCopyValues.custom,
    defaultPrevented: true, editEvents: [], selectionEnd: humanCopyValues.custom.length },
  { id: "cut-original", target: "cut", operation: "cut", selected: true, status: "ready", text: humanCutText, value: "",
    defaultPrevented: false, editEvents: ["beforeinput:deleteByCut", "input:deleteByCut"], selectionEnd: 0 },
  { id: "copy-cancelled", target: "cancel-copy", operation: "copy", selected: true, status: "unchanged", text: humanCutText, value: humanCopyValues["cancel-copy"],
    defaultPrevented: true, editEvents: [], selectionEnd: humanCopyValues["cancel-copy"].length },
  { id: "cut-cancelled", target: "cancel-cut", operation: "cut", selected: true, status: "unchanged", text: humanCutText, value: humanCopyValues["cancel-cut"],
    defaultPrevented: true, editEvents: [], selectionEnd: humanCopyValues["cancel-cut"].length }
]);

export function createManagedHumanCopyFixture() {
  const requests = []; let overflow = false;
  function handle(request, response) {
    const url = new URL(request.url, "http://127.0.0.1");
    if (!["/human-copy", "/human-copy-local", "/human-clipboard-donor"].includes(url.pathname)) return false;
    if (requests.length >= 16) { overflow = true; request.resume(); response.writeHead(503).end(); return true; }
    const hit = { sequence: requests.length + 1, path: url.pathname, method: request.method, at: Date.now(), finished: false, aborted: false };
    requests.push(hit); request.resume();
    response.once("finish", () => { hit.finished = true; });
    response.once("close", () => { hit.aborted = !response.writableFinished; });
    if (request.method !== "GET" || url.search) { hit.status = 405; response.writeHead(405).end(); return true; }
    hit.status = 200;
    if (url.pathname === "/human-clipboard-donor") {
      response.writeHead(200, { "Content-Type": "text/html;charset=utf-8", "Cache-Control": "no-store" });
      response.end('<!doctype html><meta charset="utf-8"><title>Synthetic memory clipboard donor</title><label>Donor<textarea id="donor"></textarea></label><label>Neutral control<textarea id="neutral"></textarea></label>');
      return true;
    }
    if (url.pathname === "/human-copy-local") {
      response.writeHead(200, { "Content-Type": "text/html;charset=utf-8", "Cache-Control": "no-store" });
      response.end('<!doctype html><meta charset="utf-8"><title>Memory clipboard readback</title><label>Original native paste<textarea id="neutral" autocomplete="off"></textarea></label>');
      return true;
    }
    const token = randomUUID(); hit.documentToken = token;
    const values = humanCopyValues;
    const html = `<!doctype html><meta charset="utf-8"><title>Original human clipboard transfer</title>
<style>body{font:18px sans-serif;margin:20px;background:#eef4ff;color:#132641}.grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:16px}label{display:grid;gap:6px}textarea{box-sizing:border-box;width:100%;height:70px;padding:8px;font:18px sans-serif;resize:none}</style>
<h1>Original copy and cut</h1><div class="grid">${Object.entries(values).map(([id, value]) => `<label>${id}<textarea id="${id}" autocomplete="off">${value}</textarea></label>`).join("")}</div><pre id="state" hidden></pre>
<script>
const ids=${JSON.stringify(Object.keys(values))},state={documentToken:${JSON.stringify(token)},events:[],eventOverflow:false,heldKeys:[],heldButtons:[],controls:{}};
const render=()=>{state.controls=Object.fromEntries(ids.map(id=>{const e=document.getElementById(id);return[id,{value:e.value,selectionStart:e.selectionStart,selectionEnd:e.selectionEnd}]}));document.getElementById('state').textContent=JSON.stringify(state)};
document.getElementById('custom').addEventListener('copy',event=>{event.clipboardData.setData('text/plain',${JSON.stringify(humanCustomCopyText)});event.preventDefault()});
document.getElementById('cancel-copy').addEventListener('copy',event=>event.preventDefault());
document.getElementById('cancel-cut').addEventListener('cut',event=>event.preventDefault());
for(const type of ['keydown','keyup','keypress','copy','cut','paste','beforeinput','input','mousedown','mouseup'])document.addEventListener(type,event=>{if(state.events.length>=256){state.eventOverflow=true;render();return}const row={sequence:state.events.length+1,at:Date.now(),type,target:event.target.id,trusted:event.isTrusted,defaultPrevented:event.defaultPrevented};if(type.startsWith('key')){Object.assign(row,{key:event.key,code:event.code,repeat:event.repeat});if(type==='keydown'&&!state.heldKeys.includes(event.code))state.heldKeys.push(event.code);if(type==='keyup')state.heldKeys=state.heldKeys.filter(code=>code!==event.code)}if(type==='beforeinput'||type==='input')Object.assign(row,{inputType:event.inputType,data:event.data});if(type==='mousedown'&&!state.heldButtons.includes(event.button))state.heldButtons.push(event.button);if(type==='mouseup')state.heldButtons=state.heldButtons.filter(button=>button!==event.button);state.events.push(row);render()},{passive:true});render();
</script>`;
    response.writeHead(200, { "Content-Type": "text/html;charset=utf-8", "Cache-Control": "no-store" }); response.end(html);
    return true;
  }
  return { handle, stats: () => structuredClone({ requests, overflow }) };
}

export function readManagedHumanCopyDocument() {
  const state = JSON.parse(document.getElementById("state").textContent), boxes = {};
  for (const id of Object.keys(state.controls)) {
    const element = document.getElementById(id), box = element.getBoundingClientRect();
    state.controls[id] = { value: element.value, selectionStart: element.selectionStart, selectionEnd: element.selectionEnd };
    boxes[id] = { x: box.x, y: box.y, width: box.width, height: box.height };
  }
  return { state, boxes, activeElement: document.activeElement?.id };
}

// Passive local readback: no read(), write(), permission grant or synthesized event.
export function installManagedCopyReadbackObserver() {
  const events = [], listeners = []; let active = true, overflow = false;
  for (const type of ["keydown", "keyup", "paste", "beforeinput", "input"]) {
    const listener = event => {
      if (event.target?.id !== "neutral") return;
      if (events.length >= 32) { overflow = true; return; }
      const text = event.type === "paste" ? event.clipboardData.getData("text/plain") : null;
      if (text !== null && text.length > 4096) { overflow = true; return; }
      events.push({ sequence: events.length + 1, type, trusted: event.isTrusted, key: event.key ?? null, code: event.code ?? null,
        inputType: event.inputType ?? null, text, value: event.target.value });
    };
    document.addEventListener(type, listener, { passive: true }); listeners.push({ type, listener });
  }
  const snapshot = () => ({ events: structuredClone(events), active, overflow, value: document.getElementById("neutral").value });
  globalThis.__managedCopyReadback = { stop() { for (const { type, listener } of listeners) document.removeEventListener(type, listener); active = false; return snapshot(); } };
}

export function assertManagedHumanCopyCase({ definition, original, before, after, commands, replies, scope, local }) {
  assert.equal(after.documentId, original.documentId); assert.equal(before.documentId, original.documentId);
  assert.equal(after.state.documentToken, original.state.documentToken); assert.equal(before.state.documentToken, original.state.documentToken);
  assert.equal(after.state.eventOverflow, false);
  assert.equal(original.state.controls[definition.target].value, humanCopyValues[definition.target]);
  assert.deepEqual(before.state.controls[definition.target], {
    value: humanCopyValues[definition.target], selectionStart: 0,
    selectionEnd: definition.selected ? humanCopyValues[definition.target].length : 0
  });
  assert.deepEqual(after.state.events.slice(0, before.state.events.length), before.state.events);
  const events = after.state.events.slice(before.state.events.length);
  assert.ok(events.every(event => event.trusted));
  const key = definition.operation === "cut" ? "KeyX" : "KeyC";
  const gestures = ["ControlLeft:down", `${key}:down`, `${key}:up`, "ControlLeft:up"];
  assert.deepEqual(commands.map(row => `${row.input.code}:${row.input.action}`), gestures);
  commands.forEach((request, i) => {
    assert.equal(request.operation, "humanInput"); assert.equal(request.leaseId, scope.leaseId); assert.equal(request.generation, scope.generation);
    if (i) assert.equal(request.sequence, commands[i - 1].sequence + 1);
    const reply = replies.find(row => row.connection === request.connection && row.id === request.id);
    assert.equal(reply?.type, "response"); assert.equal(reply.error, undefined);
    const receipt = reply.result.inputReceipt, { clipboardTransfer, ...base } = receipt;
    assert.deepEqual(base, { leaseId: request.leaseId, generation: request.generation, sequence: request.sequence, acknowledged: true });
    if (i === 1) {
      assert.equal(request.input.clipboardTransfer, definition.operation);
      assert.deepEqual(clipboardTransfer, { operation: definition.operation, status: definition.status,
        ...(definition.status === "ready" ? { text: definition.text } : {}) });
    } else { assert.equal(request.input.clipboardTransfer, undefined); assert.equal(clipboardTransfer, undefined); }
  });
  assert.deepEqual(events.filter(event => event.type === "keydown" || event.type === "keyup").map(event => `${event.code}:${event.type}`),
    gestures.map(value => value.replace(":down", ":keydown").replace(":up", ":keyup")));
  const clipboardEvents = events.filter(event => ["copy", "cut", "paste"].includes(event.type));
  if (!definition.selected) assert.ok(clipboardEvents.length <= 1);
  else assert.equal(clipboardEvents.length, 1);
  for (const event of clipboardEvents) {
    assert.equal(event.type, definition.operation);
    assert.equal(event.defaultPrevented, definition.defaultPrevented);
  }
  assert.deepEqual(events.filter(event => ["beforeinput", "input"].includes(event.type)).map(event => `${event.type}:${event.inputType}`),
    definition.editEvents);
  assert.deepEqual(after.state.controls[definition.target], { value: definition.value, selectionStart: 0, selectionEnd: definition.selectionEnd });
  for (const [id, value] of Object.entries(before.state.controls)) if (id !== definition.target) assert.deepEqual(after.state.controls[id], value);
  assert.deepEqual(after.state.heldKeys, []); assert.deepEqual(after.state.heldButtons, []);
  assert.equal(local.active, false); assert.equal(local.overflow, false); assert.equal(local.value, definition.text);
  const pastes = local.events.filter(event => event.type === "paste");
  assert.equal(pastes.length, 1); assert.equal(pastes[0].text, definition.text);
  assert.ok(local.events.every(event => event.trusted));
  assert.equal(local.events.filter(event => event.type === "beforeinput" && event.inputType === "insertFromPaste").length, 1);
  assert.equal(local.events.filter(event => event.type === "input" && event.inputType === "insertFromPaste").length, 1);
  return { requestId: commands[1].id, sequence: commands[1].sequence, status: definition.status, operation: definition.operation,
    boundary: "Exact original native key receipt, unchanged task document, original task events and later trusted local Ctrl+V readback after End. Browser shared clipboard, not page-origin provenance." };
}

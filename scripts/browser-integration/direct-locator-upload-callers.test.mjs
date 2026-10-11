import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { directUploadAdapter, executeDirectUpload, runDirectUploadProcess } from "./direct-locator-upload-callers.mjs";

function harness(kind) {
  const detail = { key: `direct-${kind}-unit`, caller: kind, variants: [], createdTabIds: [], trace: [], passed: false };
  const calls = [], states = new Map(); let id = 0;
  const action = (tabId, name, selector, args = {}) => {
    calls.push({ tabId, name, selector, args });
    if (name === "setInputFiles") {
      if (selector !== "#upload" || args.files === null || args.files?.[0] === "relative.txt") throw Error("Invalid file input");
      states.set(tabId, args.files.length ? "uploaded" : "cleared");
    }
    if (name === "innerText") return JSON.stringify({ state: selector === "#receipt" ? "receipt" : states.get(tabId) ?? "empty" });
  };
  const scoped = params => { assert.equal(params.session_id, detail.key); assert.equal(params.turn_id, detail.key + "-turn"); assert.equal(params.control_epoch, 7); };
  const wire = async (method, params) => {
    if (method === "getControlState") return { closing: false, controlEpoch: 7 };
    scoped(params);
    if (method === "createTab") return { id: ++id };
    if (method === "finalizeTabs") return { finalized: true };
    const engine = { name: "playwright-crx", capabilities: { locatorFileUpload: 1 } };
    if (params.action === "engineInfo") return { engine, value: engine };
    return { engine, value: action(params.tabId, params.action, params.locator?.at(-1).selector, params.args) ?? null };
  };
  const browser = {
    client: { sessionId: detail.key, turnId: detail.key + "-turn", controlEpoch: 7, beginTurn: async () => {}, finalizeTabs: async () => ({ finalized: true }), browserAction: (tabId, name, options) => wire("browserAction", { session_id: detail.key, turn_id: detail.key + "-turn", control_epoch: 7, tabId, action: name, ...options }) },
    newTab: async () => ({ id: ++id }), close: () => calls.push({ name: "close" }),
    tab(tabId) {
      const factory = { frameLocator: () => factory, locator: selector => ({ setInputFiles: (files, options) => action(tabId, "setInputFiles", selector, { files, ...options }), innerText: () => action(tabId, "innerText", selector), waitFor: () => action(tabId, "waitFor", selector) }) };
      return { playwright: factory, goto: url => action(tabId, "goto", null, { url }) };
    },
  };
  return { detail, calls, options: { kind, key: detail.key, call: wire, connectOpenBrowserUse: async () => browser, files: [{ path: "/资料.bin" }], fixtureURL: "http://127.0.0.1:1234", onStart: async item => calls.push({ name: "start", tabId: item.tabId }), onFinish: async item => calls.push({ name: "finish", tabId: item.tabId }) } };
}
for (const kind of ["js", "cli", "mcp"]) test(`${kind} own public entry sends one upload and one clear per layout, no chooser/click`, async () => {
  const h = harness(kind), adapter = await directUploadAdapter(h.options, h.detail); await executeDirectUpload(adapter, h.options, h.detail);
  assert.equal(h.detail.passed, true); assert.deepEqual(h.detail.variants.map(item => item.variant), ["root", "same", "dynamic-oopif"]);
  const writes = h.calls.filter(call => call.name === "setInputFiles" && call.selector === "#upload" && Array.isArray(call.args.files) && call.args.files[0] !== "relative.txt");
  assert.deepEqual(writes.map(call => call.args.files), [["/资料.bin"], [], ["/资料.bin"], [], ["/资料.bin"], []]);
  assert.equal(h.calls.some(call => /click|chooser|evaluate/i.test(call.name)), false);
  for (const item of h.detail.variants) assert.ok(h.calls.findIndex(call => call.name === "start" && call.tabId === item.tabId) < h.calls.findIndex(call => call.name === "goto" && call.tabId === item.tabId));
});
test("original mutation error survives observer and cleanup errors without retry", async () => {
  const h = harness("js"), adapter = await directUploadAdapter(h.options, h.detail), original = Object.freeze(Error("Original write failed"));
  const action = adapter.action; let count = 0;
  adapter.action = (...args) => { if (args[1] === "setInputFiles" && args[2].at(-1).selector === "#upload") { count++; throw original; } return action(...args); };
  adapter.finalize = async () => { throw Error("Finalize failed"); }; h.options.onFinish = async () => { throw Error("Observer failed"); };
  await assert.rejects(executeDirectUpload(adapter, h.options, h.detail), error => error === original);
  assert.equal(count, 1); assert.match(h.detail.cleanupError, /Finalize failed/); assert.match(h.detail.variants[0].observerError, /Observer failed/);
});

test("external protocol keeps Unicode bytes, original business failure and actual close", async () => {
  const script = `const r=require('readline').createInterface({input:process.stdin});let id=1;const item={key:'direct-python-unit-root',variant:'root',tabId:9};function hook(kind){console.log(JSON.stringify({type:'hook',version:1,id,kind,item}))};r.on('line',line=>{const ack=JSON.parse(line);if(ack.id!==id)process.exit(9);if(id++===1)hook('finish');else{const text=JSON.stringify({type:'result',version:1,result:{passed:false,error:'原错误🙂'}})+'\\n';const bytes=Buffer.from(text);for(const byte of bytes)process.stdout.write(Buffer.from([byte]));r.close();process.exitCode=1}});hook('start');`;
  const hooks = [];
  const result = await runDirectUploadProcess(process.execPath, ["-e", script], { onHook: async message => hooks.push(message.kind), timeoutMs: 2000 });
  assert.deepEqual(hooks, ["start", "finish"]); assert.equal(result.process.closeObserved, true); assert.equal(result.process.exitCode, 1); assert.equal(result.complete, true); assert.equal(result.result.error, "原错误🙂");
});
test("foreign external identity causes no observer calls and actual process close", async () => {
  let calls = 0;
  const script = `console.log(JSON.stringify({type:'hook',version:1,id:1,kind:'start',item:{key:'other',variant:'root',tabId:7}}));setInterval(()=>{},1000);`;
  const result = await runDirectUploadProcess(process.execPath, ["-e", script], { onHook: async () => calls++, timeoutMs: 2000 });
  assert.equal(calls, 0); assert.equal(result.complete, false); assert.equal(result.process.closeObserved, true); assert.ok(result.errors.length);
});

test("Python workflow uses typed locator API for all layouts, preserves failure and avoids success observations", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "obu-direct-python-"));
  try {
    const source = path.resolve("scripts/browser-integration/direct-locator-upload-checks.py");
    const script = `import importlib.util,sys,types,json
calls=[]
class Locator:
 def __init__(self,tab,selector):self.tab,self.selector=tab,selector
 def set_input_files(self,files,**kw):
  calls.append(['set',self.tab.id,self.selector,files,kw])
  if self.selector!='#upload':raise ValueError('Invalid input')
  self.tab.state='uploaded' if files else 'cleared'
 def inner_text(self,**kw):return json.dumps({'state':self.tab.state if self.selector=='#state' else 'receipt'})
 def wait_for(self,**kw):calls.append(['wait',self.tab.id])
class Tab:
 def __init__(self,id):self.id,self.state=id,'empty'
 def goto(self,url):calls.append(['goto',self.id,url])
 def locator(self,selector):return Locator(self,selector)
 def frame_locator(self,selector):calls.append(['frame',self.id]);return self
class Browser:
 def __init__(self):self.client=self;self.n=0
 def begin_turn(self):return {'nextTurnId':'turn','controlEpoch':7}
 def new_tab(self):self.n+=1;return Tab(self.n)
 def browser_action(self,id,action,**kw):
  if action=='engineInfo':return {'engine':{'capabilities':{'locatorFileUpload':1}}}
  raise ValueError('Invalid files')
 def finalize_tabs(self,keep):calls.append(['finalize',keep]);return {'ok':True}
 def close(self):calls.append(['close'])
sys.modules['open_browser_use']=types.SimpleNamespace(connect_open_browser_use=lambda *a,**kw:Browser())
spec=importlib.util.spec_from_file_location('caller',sys.argv[1]);m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m)
result=m.run('endpoint','http://127.0.0.1:1234',[{'path':'/中文.bin'}],lambda kind,item:calls.append(['hook',kind,item['tabId']]))
print(json.dumps({'result':result,'calls':calls}))
`;
    const file = path.join(root, "test.py"); await fs.writeFile(file, script);
    const result = spawnSync(process.env.OBU_TEST_PYTHON || "python", [file, source], { encoding: "utf8", env: { ...process.env, PYTHONDONTWRITEBYTECODE: "1", PYTHONIOENCODING: "utf-8" } });
    assert.equal(result.status, 0, result.stderr); const value = JSON.parse(result.stdout); assert.equal(value.result.passed, true, value.result.error);
    assert.deepEqual(value.calls.filter(call => call[0] === "set" && call[2] === "#upload").map(call => call[3]), [["/中文.bin"], [], ["/中文.bin"], [], ["/中文.bin"], []]);
    assert.equal(value.calls.filter(call => call[0] === "finalize").length, 1); assert.deepEqual(value.calls.at(-1), ["close"]);
  } finally { assert.equal(path.dirname(root), path.resolve(os.tmpdir())); assert.ok(path.basename(root).startsWith("obu-direct-python-")); await fs.rm(root, { recursive: true, force: true }); }
});

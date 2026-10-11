import assert from "node:assert/strict";
import test from "node:test";
import { spawnSync } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const source = fileURLToPath(new URL("./chooser-waits-checks.py", import.meta.url));
const python = process.env.OBU_TEST_PYTHON || "python";
// Only this synchronous SDK-shaped double is imported by the real Python
// subprocess. It never connects to a host or launches a browser.
const fakeSDK = `import json, os
from urllib.parse import urlsplit, parse_qs
config=json.loads(os.environ.get('CHOOSER_TEST_CONFIG','{}'))
calls=[]
errors={name: RuntimeError(name+' 原始错误') for name in ['connectOwner','connectTrigger','newTab','arm','collect','cancel','triggerClose','ownerClose','ownerControlState']}
tabs={}
connections=0
def record(name,*args): calls.append([name,*args])
def fail(name,variant=None):
    if config.get('failAt')==name and (variant is None or variant==config.get('variant','dynamic-oopif')): raise errors[name]
class Locator:
    def __init__(self,tab,frame=None,kind=None,name=None,options=None): self.tab,self.frame,self.kind,self.name,self.options=tab,frame,kind,name,options
    def click(self,**kwargs): record('click',self.tab.id,self.frame,self.kind,self.name,self.options,kwargs)
    def text_content(self):
        record('textContent',self.tab.id,self.frame,self.name)
        self.tab.polls+=1
        return '' if self.tab.polls==1 else json.dumps({'sequence':self.tab.sequence,'note':'原始收据'})
class Frame:
    def __init__(self,tab,frame=None): self.tab,self.frame=tab,frame
    def get_by_label(self,name,**kwargs): return Locator(self.tab,self.frame,'label',name,kwargs)
    def locator(self,name): return Locator(self.tab,self.frame,'locator',name)
class Wait:
    def __init__(self,tab): self.tab=tab; self.waiter_id='wait-'+str(tab.id)+'-'+str(tab.sequence); self.remaining_ms=9900
    def result(self):
        record('collect',self.tab.id,self.tab.sequence)
        fail('collect',self.tab.variant)
        return {'fileChooserId':self.waiter_id,'isMultiple':self.tab.variant!='root'}
    def cancel(self):
        record('cancel',self.tab.id,self.tab.sequence)
        if config.get('cancel') and self.tab.variant==config.get('variant','dynamic-oopif'): raise errors['cancel']
class Tab(Frame):
    def __init__(self,id): self.id=id; self.variant=None; self.sequence=0; self.polls=0; super().__init__(self)
    def frame_locator(self,frame): return Frame(self,frame)
    def get_by_role(self,role,**kwargs): return Locator(self,None,'role',role,kwargs)
    def expect_file_chooser(self,**kwargs):
        self.sequence+=1; self.polls=0
        record('arm',self.id,kwargs)
        fail('arm',self.variant)
        return Wait(self)
    def evaluate(self,expression): record('evaluate',self.id,expression); return [{'trusted':True}]
class CDP:
    def navigate(self,id,url): record('navigate',id,url); tabs[id].variant=parse_qs(urlsplit(url).query)['variant'][0]
class Client:
    def __init__(self,owner): self.owner=owner
    def get_info(self): record('getInfo'); return {'metadata':{'fileChooserWaitVersion':1}}
    def set_file_chooser_files(self,id,files): record('setFiles',id,files)
    def request(self,method):
        record('request',self.owner,method)
        if self.owner=='owner': fail('ownerControlState',tabs[max(tabs)].variant)
        return {'controlEpoch':7}
class Browser:
    def __init__(self,owner): self.owner=owner; self.client=Client(owner); self.cdp=CDP()
    def new_tab(self):
        record('newTab')
        fail('newTab')
        id=41+len(tabs); tabs[id]=Tab(id); return tabs[id]
    def tab(self,id): return tabs[id]
    def close(self):
        name=self.owner+'Close'; record(name)
        if config.get(name): raise errors[name]
def connect_open_browser_use(endpoint,**kwargs):
    global connections
    owner='owner' if connections==0 else 'trigger'; connections+=1
    record('connect',endpoint,kwargs)
    fail('connectOwner' if owner=='owner' else 'connectTrigger')
    return Browser(owner)
`;
const driver = `import importlib.util,json,sys
import open_browser_use as sdk
spec=importlib.util.spec_from_file_location('chooser_caller',sys.argv[1]); module=importlib.util.module_from_spec(spec);spec.loader.exec_module(module)
result=module.new_result(); caught=None; same=False
try: module.run('unused-endpoint','http://127.0.0.1:8123/','python-chooser',['one.txt','two.bin'],result)
except Exception as error:
    caught=str(error); same=error is sdk.errors.get(sdk.config.get('failAt')) or (not sdk.config.get('failAt') and error is sdk.errors.get('triggerClose'))
print(json.dumps({'result':result,'calls':sdk.calls,'caught':caught,'sameError':same},ensure_ascii=False))
`;

async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "obu-chooser-python-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await fs.writeFile(path.join(root, "open_browser_use.py"), fakeSDK);
  await fs.writeFile(path.join(root, "driver.py"), driver);
  const execute = (args, config = {}) => {
    const value = spawnSync(python, args, { encoding: "utf8", windowsHide: true, timeout: 15000,
      env: { ...process.env, PYTHONPATH: root, PYTHONDONTWRITEBYTECODE: "1", PYTHONIOENCODING: "utf-8", CHOOSER_TEST_CONFIG: JSON.stringify(config) } });
    assert.ifError(value.error); assert.equal(value.signal, null); return value;
  };
  return { root, execute, run: config => {
    const value = execute([path.join(root, "driver.py"), source], config);
    assert.equal(value.status, 0, value.stderr); assert.equal(value.stderr, ""); return JSON.parse(value.stdout);
  } };
}

function originalSuccessCalls() {
  const options = { session_id: "python-chooser", turn_id: "chooser-ready", timeout: 15 };
  const calls = [["connect", "unused-endpoint", options], ["connect", "unused-endpoint", options], ["getInfo"]];
  for (const [i, variant] of ["root", "oopif", "dynamic-oopif"].entries()) {
    const id = 41 + i, frame = variant === "root" ? null : "#upload-frame";
    calls.push(["newTab"], ["navigate", id, `http://127.0.0.1:8123/chooser-waits/page?key=python-chooser-${variant}&variant=${variant}`]);
    for (const sequence of [1, 2]) {
      calls.push(["arm", id, { timeout_ms: 10000 }]);
      if (variant === "dynamic-oopif" && sequence === 1) calls.push(["click", id, null, "role", "button", { name: "Add upload frame", exact: true }, {}]);
      calls.push(["click", id, frame, "label", "Upload fixture", { exact: true }, { timeout_ms: 5000 }], ["collect", id, sequence],
        ["setFiles", `wait-${id}-${sequence}`, sequence === 2 ? [] : variant === "root" ? ["one.txt"] : ["one.txt", "two.bin"]],
        ["textContent", id, frame, "#receipt"], ["textContent", id, frame, "#receipt"], ["cancel", id, sequence]);
    }
    calls.push(["request", "owner", "getControlState"], ["request", "trigger", "getControlState"]);
    if (variant === "dynamic-oopif") calls.push(["evaluate", id, "chooserEvidence.frameAdds"]);
  }
  calls.push(["triggerClose"], ["ownerClose"]); return calls;
}

test("Python success keeps every original SDK request, argument, deadline, poll and close in order", async t => {
  const { run } = await fixture(t), value = run({});
  assert.deepEqual(value.calls, originalSuccessCalls()); assert.equal(value.caught, null);
  assert.equal(value.result.passed, true); assert.equal(value.result.variants.length, 3);
  for (const item of value.result.variants) {
    assert.equal(item.passed, true); assert.deepEqual(item.scope, { session_id: "python-chooser", turn_id: "chooser-ready", control_epoch: 7 });
    assert.equal(item.waits.length, 2);
    for (const event of item.waits) {
      assert.equal(event.passed, true); assert.ok(event.triggerCompletedAt >= event.triggerSubmittedAt);
      assert.ok(event.stages.arm.completedAt >= event.stages.arm.startedAt);
      assert.ok(event.stages.cancel.completedAt >= event.stages.cancel.startedAt);
      assert.equal(event.result.fileChooserId, event.waiterId);
    }
  }
});

test("dynamic collect failure survives cancel and both close failures with original exception identity", async t => {
  const { run } = await fixture(t), value = run({ failAt: "collect", cancel: true, triggerClose: true, ownerClose: true });
  assert.equal(value.sameError, true); assert.equal(value.caught, "collect 原始错误");
  const result = value.result, item = result.variants.at(-1), event = item.waits[0];
  assert.equal(result.error, value.caught); assert.equal(result.originalError, value.caught); assert.equal(result.failedStage, "collect");
  assert.deepEqual(result.variants.map(v => v.passed), [true, true, false]);
  assert.equal(item.key, "python-chooser-dynamic-oopif"); assert.equal(item.tabId, 43); assert.equal(item.scope, undefined);
  assert.equal(item.waits.length, 1); assert.equal(event.sequence, 1); assert.equal(event.result, undefined);
  assert.equal(event.stages.click.completedAt !== undefined, true); assert.equal(event.stages.collect.completedAt, undefined);
  assert.equal(event.failedStage, "collect"); assert.equal(event.cancelError, "cancel 原始错误"); assert.equal(event.error, value.caught);
  assert.equal(result.triggerCloseError, "triggerClose 原始错误"); assert.equal(result.ownerCloseError, "ownerClose 原始错误");
  assert.deepEqual(value.calls.slice(-3), [["cancel", 43, 1], ["triggerClose"], ["ownerClose"]]);
  assert.equal(value.calls.filter(call => call[0] === "setFiles").length, 4);
});

test("connect/newTab/arm failures retain only observed identity, never invent a waiter or cancellation", async t => {
  const { run } = await fixture(t);
  const connect = run({ failAt: "connectTrigger" });
  assert.equal(connect.sameError, true); assert.deepEqual(connect.result.variants, []); assert.deepEqual(connect.calls.at(-1), ["ownerClose"]);
  assert.equal(connect.calls.some(call => call[0] === "triggerClose"), false);
  const created = run({ failAt: "newTab" }), item = created.result.variants[0];
  assert.equal(created.sameError, true); assert.equal(item.tabId, undefined); assert.deepEqual(item.waits, []); assert.equal(item.failedStage, "newTab");
  const arm = run({ failAt: "arm", variant: "root" }), round = arm.result.variants[0].waits[0];
  assert.equal(arm.sameError, true); assert.equal(round.sequence, 1); assert.equal(round.waiterId, undefined); assert.equal(round.result, undefined);
  assert.equal(round.failedStage, "arm"); assert.equal(arm.calls.some(call => ["cancel", "collect", "click"].includes(call[0])), false);
});

test("close-only and post-round scope failures do not rewrite successful rounds as failed input", async t => {
  const { run } = await fixture(t), close = run({ triggerClose: true, ownerClose: true });
  assert.equal(close.sameError, true); assert.equal(close.result.passed, false); assert.equal(close.result.originalError, undefined);
  assert.ok(close.result.variants.every(item => item.passed && item.waits.every(wait => wait.passed)));
  const scope = run({ failAt: "ownerControlState", variant: "root" });
  assert.equal(scope.sameError, true); assert.equal(scope.result.failedStage, "ownerControlState");
  assert.ok(scope.result.variants[0].waits.every(wait => wait.passed && wait.error === undefined));
});

test("actual Python process saves identical partial JSON to stdout/file and exits 1; exclusive files are not overwritten", async t => {
  const { root, execute } = await fixture(t), output = path.join(root, "partial.json");
  const args = [source, "unused-endpoint", "http://127.0.0.1:8123/", "python-chooser", output, "one.txt", "two.bin"];
  const child = execute(args, { failAt: "collect", cancel: true, triggerClose: true, ownerClose: true });
  assert.equal(child.status, 1); assert.match(child.stderr, /RuntimeError: collect 原始错误/);
  assert.equal(await fs.readFile(output, "utf8"), child.stdout);
  const result = JSON.parse(child.stdout); assert.equal(result.caller, "python"); assert.equal(result.variants.at(-1).failedStage, "collect");
  const before = await fs.readFile(output), second = execute(args, { failAt: "connectOwner" });
  assert.equal(second.status, 1); assert.ok(JSON.parse(second.stdout).outputError); assert.deepEqual(await fs.readFile(output), before);
});

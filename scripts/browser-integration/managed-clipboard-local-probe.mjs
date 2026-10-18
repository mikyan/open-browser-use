import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createServer } from 'node:http';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { managedProcess, connectNormalCDP, bound, poll } from './normal-browser-downloads-support.mjs';
import { waitPrivateDevToolsEndpoint } from './private-devtools-endpoint.mjs';
import { browserStartupOptions } from './browser-startup.mjs';
import { observedProcessDescendants } from './observed-process-descendants.mjs';
import { verifyMemoryClipboard } from './memory-clipboard.mjs';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const executable = process.env.OBU_TEST_CLIPBOARD_CHROMIUM_BINARY;
assert.ok(executable && path.isAbsolute(executable), 'Set OBU_TEST_CLIPBOARD_CHROMIUM_BINARY to the absolute guarded Chromium executable');
const outputRoot = path.join(repo, '.tmp/browser-integration');
await fs.mkdir(outputRoot, { recursive: true });
const run = await fs.mkdtemp(path.join(outputRoot, 'clipboard-local-'));
const profile = path.join(run, 'profile'); await fs.mkdir(profile);
const hash = data => createHash('sha256').update(data).digest('hex');
const report = { startedAt: Date.now(), runDir: run, scope: 'Native keyboard initiating async ClipboardItem Promise on a synthetic loopback viewer. No production bridge or task clipboard, no permission grant, no OS clipboard, no retries. Guarded fixed HeadlessClipboard only.', commands: [], cases: [], requests: [], cleanup: [] };
const registry = new Set(); let owner, cdp, session;
const text = 'copied 中文\nline two 🧭';
const fixture = `<!doctype html><meta charset="utf-8"><title>Async local clipboard diagnostic</title>
<textarea id="seed"></textarea><textarea id="viewer"></textarea><textarea id="output"></textarea>
<script>
globalThis.probe={events:[],writes:[],caseId:''};
for(const type of ['keydown','keyup','copy','cut','paste','beforeinput','input'])document.addEventListener(type,e=>{
 probe.events.push({caseId:probe.caseId,type,target:e.target.id,trusted:e.isTrusted,key:e.key??null,inputType:e.inputType??null,clipboardText:e.type==='paste'?e.clipboardData.getData('text/plain'):null,value:e.target.value??null});
},true);
document.querySelector('#viewer').addEventListener('keydown',e=>{
 if(!e.ctrlKey||!['c','x'].includes(e.key.toLowerCase()))return;
 e.preventDefault();
 const row={caseId:probe.caseId,type:e.key.toLowerCase(),trusted:e.isTrusted,activation:navigator.userActivation.isActive,secure:isSecureContext};probe.writes.push(row);
 const data=new Promise((resolve,reject)=>{probe.resolve=resolve;probe.reject=reject;});
 try{probe.settled=navigator.clipboard.write([new ClipboardItem({'text/plain':data})]).then(()=>{row.status='resolved';},error=>{row.status='rejected';row.errorName=error.name;row.message=error.message;});row.started=true;}
 catch(error){row.status='sync-error';row.errorName=error.name;row.message=error.message;probe.settled=Promise.resolve();}
});
</script>`;
const server = createServer((request,response)=>{ report.requests.push({method:request.method,url:request.url}); response.writeHead(200,{'Content-Type':'text/html; charset=utf-8','Cache-Control':'no-store'}); response.end(fixture); });
const persist = () => fs.writeFile(path.join(run, 'results.json'), JSON.stringify(report,null,2)+'\n');
// Omitted session uses the page; explicit null always addresses the Browser root.
async function native(method,params={},id=session){
 const sessionId=id===null?undefined:id;
 const item={sequence:report.commands.length+1,method,params,sessionId,requestedAt:Date.now()};report.commands.push(item);
 try{item.result=await cdp.call(method,params,10000,sessionId);item.acknowledgedAt=Date.now();return item.result;}
 catch(error){item.failedAt=Date.now();item.error=error.message;throw error;}
}
async function evaluate(expression,awaitPromise=false){const value=await native('Runtime.evaluate',{expression,returnByValue:true,awaitPromise});assert.equal(value.exceptionDetails,undefined);return value.result.value;}
async function gesture(code,key,vk){
 await native('Input.dispatchKeyEvent',{type:'rawKeyDown',key:'Control',code:'ControlLeft',windowsVirtualKeyCode:17,modifiers:2});
 await native('Input.dispatchKeyEvent',{type:'rawKeyDown',key,code,windowsVirtualKeyCode:vk,modifiers:2});
 await native('Input.dispatchKeyEvent',{type:'keyUp',key,code,windowsVirtualKeyCode:vk,modifiers:2});
 await native('Input.dispatchKeyEvent',{type:'keyUp',key:'Control',code:'ControlLeft',windowsVirtualKeyCode:17,modifiers:0});
}
async function table(){const record={};const value=await managedProcess('powershell.exe',['-NoProfile','-NonInteractive','-Command',"@(Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,ExecutablePath,@{n='CreationDate';e={$_.CreationDate.ToUniversalTime().ToString('o')}}) | ConvertTo-Json -Compress"],{registry,record,timeoutMs:15000}).completed;assert.equal(value.code,0);return JSON.parse(value.stdout);}
try{
 report.sources={runner:hash(await fs.readFile(fileURLToPath(import.meta.url))),fixture:hash(fixture),browser:hash(await fs.readFile(executable))};
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));report.url=`http://127.0.0.1:${server.address().port}/`;
 const startup=browserStartupOptions([`--user-data-dir=${profile}`,'--headless=new','--enable-automation','--remote-debugging-port=0','--no-first-run','--no-default-browser-check','--disable-background-networking','--disable-extensions','--disable-component-extensions-with-background-pages','about:blank']);report.startup=startup;
 report.process={};owner=managedProcess(executable,startup.args,{cwd:repo,registry,record:report.process});
 report.endpoint=await waitPrivateDevToolsEndpoint(profile,{assertAlive:()=>assert.equal(report.process.exitedAt,undefined)});
 report.connection={};cdp=await connectNormalCDP(report.endpoint.url,{record:report.connection,authorizationRequired:false});
 report.guard=await verifyMemoryClipboard({call:(method,params)=>native(method,params,null)},executable);assert.equal(report.guard.verified,true);
 const targets=await native('Target.getTargets',{},null);const pages=targets.targetInfos.filter(target=>target.type==='page');assert.equal(pages.length,1);
 report.target=pages[0];session=(await native('Target.attachToTarget',{targetId:pages[0].targetId,flatten:true},null)).sessionId;
 await native('Page.enable');await native('Runtime.enable');await native('Page.navigate',{url:report.url});
 await poll(()=>evaluate('Boolean(globalThis.probe)'),{timeoutMs:10000});
 report.initial=await evaluate("({secure:isSecureContext,clipboard:typeof navigator.clipboard?.write,item:typeof ClipboardItem,focused:document.hasFocus()})");
 assert.equal(report.initial.clipboard,'function');assert.equal(report.initial.item,'function');
 report.originalProcesses=observedProcessDescendants(await table(),report.process.pid);
 for(const [caseId,copyKey,reject] of [['copy-resolve','c',false],['copy-reject','c',true],['cut-resolve','x',false]]){
  const item={caseId,firstCommand:report.commands.length+1};report.cases.push(item);
  await evaluate(`(()=>{probe.caseId=${JSON.stringify(caseId)};const e=document.querySelector('#seed');e.value=${JSON.stringify('unchanged seed '+caseId)};e.focus();e.select();document.querySelector('#output').value='';return true})()`);
  await gesture('KeyC','c',67);
  await evaluate("document.querySelector('#viewer').focus();true");
  await gesture(copyKey==='c'?'KeyC':'KeyX',copyKey,copyKey==='c'?67:88);
  item.beforeResolution=await evaluate('structuredClone(probe.writes.at(-1))');
  assert.equal(item.beforeResolution.started,true);assert.equal(item.beforeResolution.trusted,true);assert.equal(item.beforeResolution.secure,true);assert.equal(item.beforeResolution.status,undefined);
  await evaluate(reject?"probe.reject(new Error('original remote lease ended'));true":`probe.resolve(new Blob([${JSON.stringify(text)}],{type:'text/plain'}));true`);
  item.result=await evaluate('probe.settled.then(()=>structuredClone(probe.writes.at(-1)))',true);
  assert.equal(item.result.status,reject?'rejected':'resolved');
  await evaluate("document.querySelector('#output').focus();true");await gesture('KeyV','v',86);
  item.after=await evaluate('({value:document.querySelector("#output").value,events:probe.events.filter(e=>e.caseId===probe.caseId)})');
  assert.equal(item.after.value,reject?'unchanged seed '+caseId:text);
  assert.equal(item.after.events.filter(e=>e.type==='paste').length,1);
  assert.ok(item.after.events.every(e=>e.trusted));assert.equal(item.after.events.some(e=>['copy','cut'].includes(e.type)&&e.target==='viewer'),false);
  item.passed=true;item.lastCommand=report.commands.length;await persist();
 }
 report.featurePassed=true;
}catch(error){report.error={message:error.message,stack:error.stack};process.exitCode=1;}
finally{
 if(cdp){report.nativeEvents=cdp.events;try{await native('Browser.close',{},null);}catch(error){report.cleanup.push({step:'browser-close',message:error.message});}try{await cdp.close();}catch(error){report.cleanup.push({step:'socket-close',message:error.message});}}
 if(owner){try{const result=await bound(owner.completed,15000,'original browser exit');report.ownerExit={code:result.code,closedAt:result.closedAt,exitedAt:result.exitedAt};assert.equal(result.code,0);}catch(error){report.cleanup.push({step:'original-exit',message:error.message});if(!report.process.exitedAt){owner.terminate('diagnostic-cleanup');report.forcedCleanup=true;await owner.completed.catch(()=>{});}}}
 if(report.originalProcesses)try{report.identityCleanup=await poll(async()=>{const now=await table();const remaining=report.originalProcesses.filter(before=>now.some(after=>after.ProcessId===before.ProcessId&&after.CreationDate===before.CreationDate));return !remaining.length&&{originalCount:report.originalProcesses.length,remaining,checkedAt:Date.now()};},{timeoutMs:15000});}catch(error){report.cleanup.push({step:'process-identities',message:error.message});}
 if(server.listening)await new Promise(resolve=>server.close(resolve));
 report.registryRemaining=registry.size;report.sourcesUnchanged=report.sources?.runner===hash(await fs.readFile(fileURLToPath(import.meta.url)))&&report.sources?.browser===hash(await fs.readFile(executable));
 report.passed=Boolean(report.featurePassed&&report.sourcesUnchanged&&!report.cleanup.length&&!report.forcedCleanup&&!registry.size);report.completedAt=Date.now();await persist();if(!report.passed)process.exitCode=1;
 console.log(JSON.stringify({runDir:run,passed:report.passed,cases:report.cases.map(({caseId,passed})=>({caseId,passed})),error:report.error,cleanup:report.cleanup}));
}

// Native transport diagnostic, not a managed human feature acceptance.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createServer } from "node:http";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createManagedEarlyModalFixture, managedEarlyModalCases, readManagedEarlyModalDocument } from "./managed-early-modal-fixture.mjs";
import { projectManagedOopifEvent, managedOopifWebNavigationEvents } from "./managed-human-oopif-dialog-evidence.mjs";
import { connectNormalCDP, managedProcess, runProcess, bound, poll } from "./normal-browser-downloads-support.mjs";
import { listenFixture } from "./fixture-listener.mjs";
import { waitPrivateDevToolsEndpoint } from "./private-devtools-endpoint.mjs";
import { parseManagedReadyOutput, assertManagedStopReply } from "./managed-download-check.mjs";
import { projectManagedViewerLifecycle, assertManagedViewerTerminal, assertManagedViewerBrowserCommand } from "./managed-viewer-check.mjs";
import { observedProcessDescendants } from "./observed-process-descendants.mjs";

import { installManagedModalProbe, managedModalCommandLedger, managedModalPair } from "./managed-modal-boundary-check.mjs";

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const sha = bytes => createHash("sha256").update(bytes).digest("hex");
const json = value => JSON.stringify(value, (_key,item)=>typeof item==="string"?item.replace(/(#ticket=)[A-Za-z0-9_-]+/g,"$1[redacted]"):item,2);
const allowedMethods = ["Page.enable","Runtime.enable","Page.getFrameTree","Page.getLayoutMetrics","Performance.enable","Performance.getMetrics","Page.startScreencast","Page.stopScreencast","Input.dispatchMouseEvent","Emulation.setFocusEmulationEnabled"];

const documentEvents = new Set(["Runtime.executionContextCreated", "Runtime.executionContextDestroyed", "Runtime.executionContextsCleared", "debugger.onDetach", "Page.frameStartedNavigating", "Page.frameNavigated", "Page.documentOpened", "Page.navigatedWithinDocument", "Page.frameDetached", "Page.frameSubtreeWillBeDetached", ...managedOopifWebNavigationEvents.map(name => "webNavigation." + name)]);
function sameSource(source, { targetId, tabId }) {
  return source && source.sessionId === undefined && source.extensionId === undefined &&
    (source.targetId === targetId || source.tabId === tabId) &&
    (source.targetId === undefined || source.targetId === targetId) && (source.tabId === undefined || source.tabId === tabId);
}

// A revision is an original event revision, not a command count or a wall clock.
// This is intentionally narrower than production document-graph authorization.
export function managedEarlyModalState(rows, identity, through = Infinity) {
  managedModalCommandLedger(rows);
  const contexts = new Map(); let revision = 0, sequence = 0;
  for (const row of rows) {
    if (row.sequence > through) break;
    sequence = row.sequence;
    if (row.kind !== "native") continue;
    assert.ok(sameSource(row.source, identity), "original current attachment envelope required");
    if (documentEvents.has(row.method)) revision++;
    if (["Runtime.executionContextsCleared", "debugger.onDetach"].includes(row.method)) contexts.clear();
    if (row.method === "Runtime.executionContextDestroyed") {
      for (const [id, context] of contexts) if (id === row.params.executionContextId || context.uniqueId === row.params.executionContextUniqueId) contexts.delete(id);
    }
    if (row.method === "Runtime.executionContextCreated" && row.params.context?.auxData?.isDefault === true) {
      const context = row.params.context;
      if (context.auxData.frameId === identity.targetId) {
        assert.ok(Number.isSafeInteger(context.id) && context.id > 0 && typeof context.uniqueId === "string" && context.uniqueId.length);
        assert.equal(context.origin, new URL(identity.url).origin);
        contexts.set(context.id, structuredClone(context));
      }
    }
  }
  return { sequence, revision, contexts: [...contexts.values()].sort((a, b) => a.id - b.id) };
}

function noFirstFrame(rows) {
  assert.equal(rows.filter(row => row.kind === "frame" || row.method === "Page.screencastFrame").length, 0, "no original screencast frame before boundary");
  assert.equal(rows.filter(row => row.method === "Page.startScreencast" && ["request", "dispatch"].includes(row.kind)).length, 0, "no queued or dispatched original startScreencast before boundary");
}
function successfulEntry(ledger, id, method, identity) {
  const entry = ledger.find(entry => entry.request.id === id);
  assert.ok(entry && entry.dispatch && entry.settlement, "original actual native ACK required");
  assert.equal(entry.request.method, method); assert.equal(entry.settlement.status, "fulfilled");
  assert.ok(sameSource(entry.request.source, identity) && sameSource(entry.dispatch.source, identity));
  assert.ok(entry.request.sequence < entry.dispatch.sequence && entry.dispatch.sequence < entry.settlement.sequence);
  return entry;
}

export function assertManagedEarlyModalPreparation(rows, config) {
  const { scenario, attachId, pageEnableId, warmRuntimeId, warmWindow, ...identity } = config;
  assert.ok(managedEarlyModalCases.includes(scenario));
  const ledger = managedModalCommandLedger(rows), attach = successfulEntry(ledger, attachId, "attach", identity), page = successfulEntry(ledger, pageEnableId, "Page.enable", identity);
  assert.ok(attach.settlement.sequence < page.dispatch.sequence);
  assert.equal(ledger.filter(entry => entry.request.method === "attach").length, 1);
  assert.equal(rows.filter(row => row.kind === "native" && ["Page.javascriptDialogOpening", "Page.javascriptDialogClosed"].includes(row.method)).length, 0, "pre-gate modal proof must not be borrowed");
  noFirstFrame(rows);
  const state = managedEarlyModalState(rows, identity), runtime = ledger.filter(entry => entry.request.method === "Runtime.enable");
  if (scenario === "cold-runtime") {
    assert.equal(runtime.length, 0, "cold setup has no earlier current Runtime.enable request");
    assert.equal(state.contexts.length, 0);
    assert.equal(rows.filter(row => row.kind === "native" && row.method === "Runtime.executionContextCreated" && row.params.context?.auxData?.isDefault === true).length, 0, "cold setup has no current default context history");
  } else {
    assert.equal(runtime.length, 1);
    const enabled = successfulEntry(ledger, warmRuntimeId, "Runtime.enable", identity);
    assert.ok(page.settlement.sequence < enabled.dispatch.sequence);
    assert.ok(warmWindow); const { start, end, firstId, secondId } = warmWindow;
    assert.deepEqual(start, managedEarlyModalState(rows, identity, start.sequence));
    assert.deepEqual(end, managedEarlyModalState(rows, identity, end.sequence));
    assert.equal(start.contexts.length, 1); assert.deepEqual(start.contexts, end.contexts); assert.deepEqual(end.contexts, state.contexts);
    assert.equal(start.revision, end.revision, "both original trees require a stable event revision"); assert.equal(end.revision, state.revision);
    assert.ok(enabled.settlement.sequence <= start.sequence);
    const first = successfulEntry(ledger, firstId, "Page.getFrameTree", identity), second = successfulEntry(ledger, secondId, "Page.getFrameTree", identity);
    assert.ok(start.sequence < first.dispatch.sequence && first.settlement.sequence < second.dispatch.sequence && second.settlement.sequence <= end.sequence);
    assert.deepEqual(first.settlement.result, second.settlement.result, "original double tree must match");
    const frame = first.settlement.result?.frameTree?.frame;
    assert.equal(frame?.id, identity.targetId); assert.equal(frame?.url, identity.url);
    assert.ok(typeof frame.loaderId === "string" && frame.loaderId.length);
  }
  return { scenario, ...identity, throughSequence: rows.at(-1)?.sequence ?? 0, pageEnableACK: page.settlement.sequence, attachACK: attach.settlement.sequence, zeroStartDispatches: true, zeroFrames: true, state, scope: "current diagnostic attachment native evidence only; not production policy or graph authorization" };
}

export function assertManagedEarlyModalOpening(rows, { preGate, scenario, ...identity }) {
  const pair = managedModalPair(rows, identity); assert.equal(pair.proved, true); assert.equal(pair.closed, null);
  assert.ok(pair.opening.sequence > preGate.throughSequence && preGate.pageEnableACK < pair.opening.sequence);
  const prefix = rows.filter(row => row.sequence <= pair.opening.sequence); noFirstFrame(prefix);
  const state = managedEarlyModalState(prefix, identity);
  assert.equal(state.revision, preGate.state.revision, "document or context changed between preparation and original Opening");
  assert.deepEqual(state.contexts, preGate.state.contexts);
  if (scenario === "cold-runtime") assert.equal(prefix.filter(row => row.kind === "dispatch" && row.method === "Runtime.enable").length, 0);
  return { openingSequence: pair.opening.sequence, beforeFirstStartAndFrame: true, currentContextAtOpening: state.contexts, revision: state.revision };
}

export function summarizeManagedEarlyModalSetup(rows, ids, native) {
  assert.equal(native.proved, true);
  const ledger = managedModalCommandLedger(rows), commands = ids.map(id => {
    const entry = ledger.find(entry => entry.request.id === id); assert.ok(entry?.dispatch);
    assert.ok(entry.dispatch.sequence > native.opening.sequence);
    return { ...entry, settlementPhase: !entry.settlement ? "pending-original-promise" : entry.settlement.sequence < (native.closed?.sequence ?? Infinity) ? "while-original-modal-open" : "after-original-Closed" };
  });
  const contexts = rows.filter(row => row.kind === "native" && row.method === "Runtime.executionContextCreated").map(row => ({ sequence: row.sequence, at: row.at, context: row.params.context, phase: row.sequence < native.opening.sequence ? "before-Opening" : row.sequence < (native.closed?.sequence ?? Infinity) ? "while-original-modal-open" : "after-original-Closed" }));
  return { commands, contexts, firstStartDispatch: rows.find(row => row.kind === "dispatch" && row.method === "Page.startScreencast") ?? null, firstFrame: rows.find(row => row.kind === "frame")?.sequence ?? null };
}

async function hashes(directory){const result={};for(const entry of await fs.readdir(directory,{recursive:true,withFileTypes:true})){assert.ok(!entry.isSymbolicLink());if(entry.isFile()){const file=path.join(entry.parentPath,entry.name);result[path.relative(directory,file).replaceAll("\\","/")]=sha(await fs.readFile(file));}}return result;}
export async function runManagedEarlyModalCheck() {
  assert.equal(process.platform,"win32");const scenario=process.env.OBU_TEST_EARLY_MODAL_CASE;assert.ok(managedEarlyModalCases.includes(scenario));
  const executable=process.env.OBU_TEST_HOST_BINARY,extension=process.env.OBU_TEST_EXTENSION_DIR,chromium=process.env.OBU_TEST_CHROMIUM_BINARY,buildFile=process.env.OBU_TEST_BUILD_MANIFEST;
  for(const file of [executable,extension,chromium,buildFile]){assert.ok(typeof file==="string"&&path.isAbsolute(file));await fs.access(file);}
  await fs.mkdir(path.join(repo,".tmp/browser-integration"),{recursive:true});
  const runDir=await fs.mkdtemp(path.join(repo,".tmp/browser-integration/med-")),root=path.join(runDir,"r"),name="n";
  const report={runDir,scenario,startedAt:Date.now(),steps:[],commands:[],nativeTrace:[],observations:[],processObservations:[],lifecycleSnapshots:[],screenshots:[],cleanup:{},cleanupErrors:[],unexpectedRequests:[],featurePassed:false,
    scope:"Single original raw native transport diagnostic after formal SDK delivery. No production human lease, viewer, OS input, personal profile, URL reopening or business replay. Pending observations do not cancel native promises. Only one exact observed original prompt may be cancelled; absent Opening remains unknown and only formal Stop follows."};
  const save=()=>fs.writeFile(path.join(runDir,"results.json"),json(report));const registry=new Set();let launcher,info,worker,sdk,fixture,tab,stopPromise,finalSaved=false;
  const server=createServer((req,res)=>{if(!fixture?.handle(req,res)){report.unexpectedRequests.push({method:req.method,url:req.url});req.resume();res.writeHead(404);res.end();}});
  const launch=(program,args,options={})=>{const record={};report.commands.push(record);return managedProcess(program,args,{cwd:repo,registry,record,maximumBytes:8*1024*1024,...options});};
  const command=async args=>{const value=await launch(executable,args,{timeoutMs:args[1]==="stop"?55000:35000}).completed;assert.equal(value.code,0);return value;};
  async function step(label,fn){const row={label,startedAt:Date.now()};report.steps.push(row);console.log("STEP",label);try{await fn();row.passed=true;}catch(error){row.passed=false;row.error=error.stack;throw error;}finally{row.endedAt=Date.now();await save();}}
  async function cleanup(label,fn){try{report.cleanup[label]=await fn();}catch(error){report.cleanupErrors.push({label,error:error.stack,at:Date.now()});}}
  function collect(){if(!worker)return report.nativeTrace;const found=new Map(report.nativeTrace.map(row=>[row.sequence,row]));for(const raw of worker.events.filter(row=>row.method==="Runtime.bindingCalled"&&row.params?.name==="__obuModalProbeEvent")){const row=JSON.parse(raw.params.payload);if(found.has(row.sequence))assert.deepEqual(found.get(row.sequence),row);else found.set(row.sequence,row);}report.nativeTrace=[...found.values()].sort((a,b)=>a.sequence-b.sequence);managedModalCommandLedger(report.nativeTrace);return report.nativeTrace;}
  async function observe(label,ms){const startedAt=Date.now(),deadline=startedAt+ms;while(Date.now()<deadline){collect();await new Promise(resolve=>setTimeout(resolve,Math.min(50,deadline-Date.now())));}collect();const at=Date.now();report.observations.push({label,startedAt,at,ledger:managedModalCommandLedger(report.nativeTrace,at)});await save();return report.nativeTrace;}
  async function enqueue(method,params={},label=method){const value=await worker.evaluate(`__managedModalProbe.enqueue(${JSON.stringify(method)},${JSON.stringify(params)},${JSON.stringify(label)})`,3000);collect();return value.id;}
  const settlement=id=>collect().find(row=>row.kind==="settlement"&&row.id===id);
  async function requireACK(id,label,ms=5000){const row=await poll(()=>settlement(id),{timeoutMs:ms,intervalMs:25,label});assert.equal(row.status,"fulfilled",row.error);return row.result;}
  async function table(){const record={};(report.processProbes??=[]).push(record);await runProcess("powershell.exe",["-NoProfile","-NonInteractive","-Command","@(Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,ExecutablePath,@{n='CreationDate';e={$_.CreationDate.ToUniversalTime().ToString('o')}}) | ConvertTo-Json -Compress"],{registry,record,timeoutMs:15000});const rows=JSON.parse(record.stdout);record.stdout={bytes:Buffer.byteLength(record.stdout),sha256:sha(record.stdout)};return rows;}
  async function remember(label){const rows=await table();report.processObservations.push({label,at:Date.now(),processes:observedProcessDescendants(rows,info.browserPID)});}
  async function lifecycle(label){let directory=info?.runDir;if(!directory){const entries=await fs.readdir(path.join(root,name,"runs"));assert.equal(entries.length,1);assert.match(entries[0],/^[a-f0-9]{32}$/);directory=path.join(root,name,"runs",entries[0]);}const bytes=await fs.readFile(path.join(directory,"lifecycle.json")),{value,...metadata}=projectManagedViewerLifecycle(bytes);const file=`lifecycle-${label}.json`;await fs.writeFile(path.join(runDir,file),bytes,{flag:"wx"});report.lifecycleSnapshots.push({label,file,...metadata});if(label==="final"){report.lifecycle=value;finalSaved=true;}return value;}
  const pair=()=>managedModalPair(collect(),{targetId:report.target.id,tabId:tab.id,url:fixture.urls[fixture.emitterRole],message:fixture.prompt.message});
  async function stopOriginal(){if(stopPromise)return stopPromise;stopPromise=(async()=>{if(info)await cleanup("beforeStopProcesses",()=>remember("before-stop"));await cleanup("beforeStopEvidence",async()=>{collect();report.beforeStop={at:Date.now(),fixture:fixture?.stats(),ledger:managedModalCommandLedger(report.nativeTrace)};await save();return{saved:true};});
    if(worker?.state()==="open"&&report.probeInstall)await cleanup("observerBeforeStop",async()=>{report.observerBeforeStop=await worker.evaluate("__managedModalProbe.status()",3000);collect();assert.equal(report.observerBeforeStop.overflow,false);assert.ok((report.nativeTrace.at(-1)?.sequence??0)>=report.observerBeforeStop.sequence);return{completeThrough:report.observerBeforeStop.sequence};});
    const value=await command(["managed","stop","--root",root,"--name",name]);report.stopReply=assertManagedStopReply(JSON.parse(value.stdout),info?.runId);
    const ended=await bound(launcher.completed,10000,"original supervisor exit");assert.equal(ended.code,0);assert.equal(ended.termination,undefined);report.supervisorExit={code:ended.code,exitedAt:ended.exitedAt,closedAt:ended.closedAt};
    const final=await lifecycle("final");assertManagedViewerTerminal(final,info);const ready=report.lifecycleSnapshots.find(row=>row.label==="ready"),last=report.lifecycleSnapshots.at(-1);assert.equal(last.nativeCreationTimeDecimal,ready.nativeCreationTimeDecimal);report.lifecycleIdentityAuthority={file:last.file,sha256:last.sha256,nativeCreationTimeDecimal:last.nativeCreationTimeDecimal};return{stopped:true};})();return stopPromise;}
  try{
    await step("freeze-runtime-and-fixture",async()=>{
      const bytes=await fs.readFile(buildFile),build=JSON.parse(bytes);assert.equal(build.passed,true);report.buildEvidence={path:buildFile,sha256:sha(bytes)};await fs.writeFile(path.join(runDir,"build-manifest.json"),bytes,{flag:"wx"});
      report.source={executable:sha(await fs.readFile(executable)),browser:sha(await fs.readFile(chromium)),extension:await hashes(extension),sdk:await hashes(path.join(repo,"packages/open-browser-use-js/dist")),harness:{},builtInputs:build.sourceInputs};
      assert.equal(report.source.executable,build.exeSHA256);assert.deepEqual(report.source.extension,build.extensionFiles);assert.equal(report.source.browser,"566971689aecea06a88355ea1e9020c908b7a3b093dd0d2a12ae7073489a77aa");
      for(const [file,expected]of Object.entries(build.sourceInputs)){const content=await fs.readFile(path.join(path.dirname(buildFile),"source-snapshot",file));assert.equal(sha(content),expected);const destination=path.join(runDir,"built-source-snapshot",file);await fs.mkdir(path.dirname(destination),{recursive:true});await fs.writeFile(destination,content,{flag:"wx"});}
      const listed=await launch("git",["ls-files","--cached","--others","--exclude-standard","--","scripts/browser-integration"],{timeoutMs:15000}).completed;assert.equal(listed.code,0);
      for(const file of listed.stdout.trim().split(/\r?\n/).sort()){const content=await fs.readFile(path.join(repo,file));report.source.harness[file]=sha(content);const destination=path.join(runDir,"source-snapshot",file);await fs.mkdir(path.dirname(destination),{recursive:true});await fs.writeFile(destination,content,{flag:"wx"});}
      await fs.cp(path.join(repo,"packages/open-browser-use-js/dist"),path.join(runDir,"sdk-input"),{recursive:true});await fs.cp(extension,path.join(runDir,"extension-input"),{recursive:true});
      await listenFixture(server);fixture=createManagedEarlyModalFixture({baseURL:`http://127.0.0.1:${server.address().port}`,caseId:scenario});report.fixtureDefinition={workflowId:fixture.workflowId,urls:fixture.urls,prompt:fixture.prompt};
    });
    await step("formal-start-and-original-delivery",async()=>{
      launcher=launch(executable,["managed","run","--root",root,"--name",name,"--browser-path",chromium,"--extension-dir",extension,"--startup-timeout","30s"]);
      const ready=await poll(()=>{assert.ok(!launcher.record.closedAt);return parseManagedReadyOutput(launcher.record.stdout);},{timeoutMs:40000,intervalMs:50,label:"managed ready"});assert.equal(ready.state,"ready");info=ready.info;report.info=info;
      const life=await lifecycle("ready");assertManagedViewerBrowserCommand(life,chromium);assert.deepEqual(life.info,info);
      const endpoint=await waitPrivateDevToolsEndpoint(info.profileDir,{assertAlive(){assert.ok(!launcher.record.closedAt);}});const response=await fetch(`http://127.0.0.1:${endpoint.port}/json/list`,{signal:AbortSignal.timeout(10000)});const workers=(await response.json()).filter(row=>row.type==="service_worker"&&row.url===`chrome-extension://${info.extensionId}/background.js`);assert.equal(workers.length,1);
      report.workerConnection={};worker=await connectNormalCDP(workers[0].webSocketDebuggerUrl,{record:report.workerConnection,handshakeTimeoutMs:10000,authorizationRequired:false});await worker.call("Runtime.enable");await worker.call("Runtime.addBinding",{name:"__obuModalProbeEvent"});
      const{connectOpenBrowserUse}=await import(pathToFileURL(path.join(runDir,"sdk-input/index.js")));sdk=await connectOpenBrowserUse({socketPath:info.socketPath,sessionId:"native-early-modal",timeoutMs:10000});tab=await sdk.newTab({url:fixture.urls.source,backgroundWindow:true});report.initialSnapshot=await tab.domSnapshot();
      report.originalDocuments=await worker.evaluate(`chrome.scripting.executeScript({target:{tabId:${tab.id}},func:${readManagedEarlyModalDocument.toString()}}).then(rows=>rows.map(row=>({documentId:row.documentId,frameId:row.frameId,...row.result})))`,3000);assert.equal(report.originalDocuments.length,1);assert.equal(report.originalDocuments[0].state.workflowId,fixture.workflowId);
      report.finalize=await sdk.client.finalizeTabs([{tabId:tab.id,status:"deliverable"}]);await bound(sdk.close(),5000,"original SDK close");sdk=null;
      const targets=await worker.evaluate(`chrome.debugger.getTargets().then(rows=>rows.filter(row=>row.type==='page'&&row.tabId===${tab.id}).map(row=>({id:row.id,tabId:row.tabId,url:row.url,attached:row.attached})))`,3000);assert.equal(targets.length,1);assert.equal(targets[0].attached,false);report.target=targets[0];
      const config={targetId:report.target.id,tabId:tab.id,emitterURL:fixture.urls[fixture.emitterRole],message:fixture.prompt.message,methods:allowedMethods,webEvents:managedOopifWebNavigationEvents};report.probeInstall=await worker.evaluate(`(${installManagedModalProbe.toString()})(chrome,globalThis,${JSON.stringify(config)},${projectManagedOopifEvent.toString()})`,3000);await remember("ready");
    });
    await step("single-original-early-modal",async()=>{
      await poll(()=>fixture.stats().requests.some(row=>row.url===new URL(fixture.urls.gate).pathname),{timeoutMs:5000,intervalMs:25,label:"original gate request"});
      report.attachId=await enqueue("attach");await requireACK(report.attachId,"original new diagnostic attachment");
      report.pageEnableId=await enqueue("Page.enable");await requireACK(report.pageEnableId,"current Page.enable before original gate");
      const identity={targetId:report.target.id,tabId:tab.id,url:fixture.urls.source};
      if(scenario==="warm-document"){
        report.warmRuntimeId=await enqueue("Runtime.enable",{},"first-current-attachment-runtime-enable");await requireACK(report.warmRuntimeId,"warm current Runtime.enable");
        await poll(()=>managedEarlyModalState(collect(),identity).contexts.length===1,{timeoutMs:5000,intervalMs:25,label:"current original default context"});
        const start=managedEarlyModalState(collect(),identity),firstId=await enqueue("Page.getFrameTree",{},"warm-original-tree-one");await requireACK(firstId,"warm original tree one");
        const secondId=await enqueue("Page.getFrameTree",{},"warm-original-tree-two");await requireACK(secondId,"warm original tree two");
        report.warmWindow={start,end:managedEarlyModalState(collect(),identity),firstId,secondId};
      }
      report.preGateProof=assertManagedEarlyModalPreparation(collect(),{...identity,scenario,attachId:report.attachId,pageEnableId:report.pageEnableId,warmRuntimeId:report.warmRuntimeId,warmWindow:report.warmWindow});
      report.gateRelease=fixture.releaseGate();await observe("native-opening-before-first-screencast",1500);
      let native=pair();report.openingObservation=native;
      if(!native.proved){report.outcome="native-opening-unproved; formal Stop only";return;}
      if(native.closed){report.outcome="original-native-closed-before-probes";return;}
      report.openingBoundary=assertManagedEarlyModalOpening(collect(),{...identity,message:fixture.prompt.message,preGate:report.preGateProof,scenario});
      report.modalProbeIds=[];
      for(const [method,params]of [["Runtime.enable",{}],["Page.getFrameTree",{}],["Page.startScreencast",{format:"png",everyNthFrame:1}]])report.modalProbeIds.push(await enqueue(method,params,"modal-"+method));
      await observe("first-frame-setup-pending-or-acknowledged",1500);native=pair();
      if(!native.closed){report.cancelCommandId=await enqueue("Page.handleJavaScriptDialog",{accept:false},"one-original-cancel");await observe("original-cancel-and-late-acks",1500);}
      native=pair();report.nativePair=native;
      if(native.closed){assert.equal(native.closed.params.result,false);await poll(()=>fixture.stats().receipt,{timeoutMs:5000,intervalMs:25,label:"original cancellation POST"});
        const frames=await worker.evaluate(`chrome.webNavigation.getAllFrames({tabId:${tab.id}})`,3000);const emitter=frames.filter(row=>row.frameId===0&&row.url===fixture.urls.source);assert.equal(emitter.length,1);report.emitterFrame=emitter[0];
        assert.equal(emitter[0].documentId,report.originalDocuments[0].documentId,"same original document after native response");
        const document=await poll(async()=>{const rows=await worker.evaluate(`chrome.scripting.executeScript({target:{tabId:${tab.id},documentIds:${JSON.stringify([emitter[0].documentId])}},func:${readManagedEarlyModalDocument.toString()}}).then(rows=>rows.map(row=>({documentId:row.documentId,frameId:row.frameId,...row.result})))`,3000);return rows.length===1&&rows[0].state?.phase==="committed"&&rows[0];},{timeoutMs:5000,intervalMs:50,label:"original document receipt publication"});report.finalDocument=document;report.receipt=fixture.verify(document);report.outcome="original-native-cancelled-and-single-post";
      }else report.outcome="original-native-response-unconfirmed; formal Stop only";
      await observe("before-formal-stop",250);report.finalLedger=managedModalCommandLedger(collect());
      report.setupEvidence=summarizeManagedEarlyModalSetup(collect(),report.modalProbeIds,native);
    });
    await step("formal-stop",stopOriginal);
  }catch(error){report.error=error.stack??String(error);console.error(String(error));}
  finally{
    if(sdk)await cleanup("sdk",()=>bound(sdk.close(),5000,"original SDK close"));
    if(launcher&&!report.supervisorExit)await cleanup("stop",stopOriginal);
    if(launcher&&!launcher.record.closedAt)await cleanup("supervisorFallback",async()=>{launcher.terminate("original-modal-diagnostic-fallback");await bound(launcher.completed.catch(()=>{}),12000,"original supervisor fallback");throw Error("forced original supervisor fallback required");});
    if(launcher&&!finalSaved)await cleanup("finalLifecycle",()=>lifecycle("final"));
    if(worker)await cleanup("observer",async()=>{try{collect();report.workerEventOverflow=report.workerConnection.eventsDropped;report.workerEnded=worker.state()!=="open";if(worker.state()==="open"&&report.probeInstall)report.observerFinal=await worker.evaluate("__managedModalProbe.stop()",3000);assert.equal(report.workerEventOverflow,0);}finally{await worker.close();}return{closed:true};});
    await cleanup("frames",async()=>{for(const row of report.nativeTrace.filter(row=>row.kind==="frame"&&row.data)){const bytes=Buffer.from(row.data,"base64"),file=`native-frame-${String(row.sequence).padStart(4,"0")}.png`;assert.equal(bytes.subarray(0,8).toString("hex"),"89504e470d0a1a0a");await fs.writeFile(path.join(runDir,file),bytes,{flag:"wx"});report.screenshots.push({file,bytes:bytes.length,sha256:sha(bytes),sequence:row.sequence});delete row.data;}return{saved:report.screenshots.length};});
    if(info)await cleanup("originalProcesses",async()=>{const originals=[...new Map(report.processObservations.flatMap(row=>row.processes).map(row=>[`${row.ProcessId}/${row.CreationDate}`,row])).values()];report.originalProcesses=originals;return poll(async()=>{const rows=await table(),remaining=originals.filter(before=>rows.some(after=>before.ProcessId===after.ProcessId&&before.CreationDate===after.CreationDate));return !remaining.length&&{originalIdentities:originals.length,remaining};},{timeoutMs:15000,intervalMs:100,label:"original private process identities gone"});});
    if(info)await cleanup("privateResources",async()=>{
      const scope={host:info.nativeHostName,pipes:[info.socketPath,"\\\\.\\pipe\\open-browser-use-managed-"+sha(path.resolve(root).toLowerCase()+"\0"+name).slice(0,40)]};assert.match(scope.host,/^com\.openbrowseruse\.managed\.n[0-9a-f]{32}$/);
      const script=String.raw`$ErrorActionPreference='Stop'
$scope=$env:OBU_MODAL_RESOURCE_PROBE | ConvertFrom-Json
$keys=@()
foreach($view in @([Microsoft.Win32.RegistryView]::Registry32,[Microsoft.Win32.RegistryView]::Registry64)) {
 $base=[Microsoft.Win32.RegistryKey]::OpenBaseKey([Microsoft.Win32.RegistryHive]::CurrentUser,$view);$key=$null
 try {$key=$base.OpenSubKey(('Software\Google\Chrome\NativeMessagingHosts\'+$scope.host),$false);$keys+=@{view=$view.ToString();absent=($null -eq $key)}} finally {if($null -ne $key){$key.Close()};$base.Close()}
}
$present=@([IO.Directory]::GetFiles('\\.\pipe\') | Where-Object {$scope.pipes -contains $_})
@{registration=$keys;presentOriginalPipes=$present} | ConvertTo-Json -Compress -Depth 5`;
      const record={};report.resourceProbe=record;await runProcess("powershell.exe",["-NoProfile","-NonInteractive","-Command",script],{registry,record,env:{...process.env,OBU_MODAL_RESOURCE_PROBE:JSON.stringify(scope)},timeoutMs:15000});const result=JSON.parse(record.stdout);assert.equal(result.registration.length,2);assert.ok(result.registration.every(row=>row.absent));assert.deepEqual(result.presentOriginalPipes,[]);const endpointEntries=await fs.readdir(path.join(info.runDir,"temp/open-browser-use"));assert.deepEqual(endpointEntries,[]);return{...result,endpointEntries};
    });
    await cleanup("fixture",async()=>{server.closeAllConnections();if(server.listening)await new Promise(resolve=>server.close(resolve));return{closed:!server.listening};});
    if(report.source)await cleanup("sourceIntegrity",async()=>{assert.equal(sha(await fs.readFile(executable)),report.source.executable);assert.equal(sha(await fs.readFile(chromium)),report.source.browser);assert.equal(sha(await fs.readFile(buildFile)),report.buildEvidence.sha256);assert.deepEqual(await hashes(extension),report.source.extension);assert.deepEqual(await hashes(path.join(repo,"packages/open-browser-use-js/dist")),report.source.sdk);for(const[file,expected]of Object.entries(report.source.harness))assert.equal(sha(await fs.readFile(path.join(repo,file))),expected);return{unchanged:true};});
    report.fixture=fixture?.stats();report.endedAt=Date.now();report.liveRunnerChildren=[...registry].map(child=>child.pid);report.completed=!report.error&&!report.cleanupErrors.length&&!registry.size&&report.steps.length===4&&report.steps.every(row=>row.passed);report.diagnosticCompleted=report.completed;report.featurePassed=false;
    report.limits=["Raw diagnostic attachment is not a production human/viewer lease or feature acceptance.","Gate/entered GETs prove fixture sequencing, never native modal existence. Missing Opening stays unproved.","Current attachment evidence starts only after its original attach ACK; old SDK contexts or frames confer no authority.","Warm double-tree/default-context evidence is native document evidence, not complete production policy or graph authorization.","Zero frame and startScreencast proof applies to this current diagnostic attachment before the gate and original Opening, not the lifetime of the browser.","Concurrent Runtime.enable, tree and screencast probes measure this combination, not isolated command causality; observation deadlines do not settle or forget original native promises.","The cold Runtime.enable is the first dispatch on this attachment. Warm Runtime.enable is idempotent setup after its original context and tree proof.","Original promise rejection on browser destruction is distinct from successful native setup or a dialog response.","Saved PNG signatures are checked; this runner does not claim complete image decoding.","Raw lifecycle file is the uint64 identity authority; copied JSON numbers are not process identity."];
    await save();console.log("RESULT",JSON.stringify({runDir,scenario,completed:report.completed,outcome:report.outcome,featurePassed:false}));
  }
  return report;
}
if(process.argv[1]&&pathToFileURL(path.resolve(process.argv[1])).href===import.meta.url){assert.equal(process.argv.length,2);const result=await runManagedEarlyModalCheck();if(!result.completed)process.exitCode=1;}

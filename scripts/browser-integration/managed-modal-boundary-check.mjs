// Native transport diagnostic, not a managed human feature acceptance.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createServer } from "node:http";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createManagedModalBoundaryFixture, managedModalBoundaryCases, readManagedModalBoundaryDocument, measureManagedModalBoundaryLink } from "./managed-modal-boundary-fixture.mjs";
import { projectManagedOopifEvent, managedOopifWebNavigationEvents } from "./managed-human-oopif-dialog-evidence.mjs";
import { connectNormalCDP, managedProcess, runProcess, bound, poll } from "./normal-browser-downloads-support.mjs";
import { listenFixture } from "./fixture-listener.mjs";
import { waitPrivateDevToolsEndpoint } from "./private-devtools-endpoint.mjs";
import { parseManagedReadyOutput, assertManagedStopReply } from "./managed-download-check.mjs";
import { projectManagedViewerLifecycle, assertManagedViewerTerminal, assertManagedViewerBrowserCommand } from "./managed-viewer-check.mjs";
import { observedProcessDescendants } from "./observed-process-descendants.mjs";

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const sha = bytes => createHash("sha256").update(bytes).digest("hex");
const json = value => JSON.stringify(value, (_key,item)=>typeof item==="string"?item.replace(/(#ticket=)[A-Za-z0-9_-]+/g,"$1[redacted]"):item,2);
const allowedMethods = ["Page.enable","Runtime.enable","Page.getFrameTree","Page.getLayoutMetrics","Performance.enable","Performance.getMetrics","Page.startScreencast","Page.stopScreencast","Input.dispatchMouseEvent","Emulation.setFocusEmulationEnabled"];

// This function is serialized into the isolated extension worker. It owns a
// separate explicit diagnostic attachment, never borrows a production lease.
// enqueue returns immediately; a Node observation timeout cannot settle, cancel
// or forget an original native promise. No original task Runtime.evaluate exists.
export function installManagedModalProbe(chrome, target, config, project) {
  if (target.__managedModalProbe || typeof target.__obuModalProbeEvent !== "function") throw Error("new original probe required");
  const source=Object.freeze({targetId:config.targetId}), rows=[], pending=new Map(), ids=new Set();
  let sequence=0, serial=0, attached=false, attachAttempted=false, active=true, overflow=false, current=null, ambiguous=false, frameCount=0;
  const emit = value => { if(rows.length>=2048){overflow=true;return;}const row={sequence:++sequence,at:Date.now(),monotonic:performance.now(),...value};rows.push(row);target.__obuModalProbeEvent(JSON.stringify(row));return row; };
  const matches = value => value && value.sessionId===undefined && value.extensionId===undefined &&
    (value.targetId===config.targetId||value.tabId===config.tabId) && (value.targetId===undefined||value.targetId===config.targetId) && (value.tabId===undefined||value.tabId===config.tabId);
  function enqueue(method, params={}, label=method) {
    let dialogClaim=null;
    if(!active||overflow||ids.size>=256)throw Error("probe admission closed");
    if(method==="attach"){if(attachAttempted)throw Error("original attach cannot replay");attachAttempted=true;}
    else if(!attached)throw Error("original attachment ACK required");
    if(method!=="attach"&&method!=="detach"&&!config.methods.includes(method)&&!["Page.screencastFrameAck","Page.handleJavaScriptDialog"].includes(method))throw Error("native method not allowlisted");
    if(method==="Page.handleJavaScriptDialog"){
      if(!current||current.closed||current.claimed||ambiguous||current.params.type!=="prompt"||current.params.frameId!==config.targetId||current.params.url!==config.emitterURL||current.params.message!==config.message)throw Error("one exact original native Opening required");
      if(Object.keys(params).length!==1||params.accept!==false)throw Error("diagnostic only cancels original once");dialogClaim=current;current.claimed=true;
    }
    const id=++serial;ids.add(id);emit({kind:"request",id,method,label,source,params:structuredClone(params)});
    const actual=Promise.resolve().then(()=>{
      if(!active||overflow||method!=="attach"&&!attached)throw Error("original native dispatch authority ended");
      if(dialogClaim&&(current!==dialogClaim||dialogClaim.closed||ambiguous))throw Error("original native dialog changed before dispatch");
      emit({kind:"dispatch",id,method,source,params:structuredClone(params)});
      return method==="attach"?chrome.debugger.attach(source,"1.3"):method==="detach"?chrome.debugger.detach(source):chrome.debugger.sendCommand(source,method,params);
    });
    pending.set(id,actual);
    actual.then(result=>{if(method==="attach")attached=true;if(method==="detach")attached=false;const copy=result===undefined?null:structuredClone(result);if(JSON.stringify(copy).length>512*1024)throw Error("native result exceeds diagnostic bound");emit({kind:"settlement",id,method,status:"fulfilled",result:copy});},error=>{emit({kind:"settlement",id,method,status:"rejected",error:String(error).slice(0,4096)});}).catch(error=>{emit({kind:"observer-error",id,error:String(error)});}).finally(()=>pending.delete(id));
    return {id,method,admitted:true};
  }
  const onEvent=(eventSource,method,params)=>{
    if(!matches(eventSource))return;
    if(!attached){const value=project(eventSource,method,params,config.webEvents);if(value)emit({kind:"unowned-native",...value,reason:"diagnostic attachment has no original ACK"});return;}
    if(method==="Page.screencastFrame"){
      if(++frameCount>128||typeof params.data!=="string"||params.data.length>6*1024*1024){overflow=true;return;}
      emit({kind:"frame",source:structuredClone(eventSource),method,params:{sessionId:params.sessionId,metadata:structuredClone(params.metadata)},...(frameCount<=4?{data:params.data}:{})});
      if(attached)enqueue("Page.screencastFrameAck",{sessionId:params.sessionId},"original-frame-ack");return;
    }
    const value=project(eventSource,method,params,config.webEvents);if(!value)return;
    const row=emit({kind:"native",...value});
    if(method==="Page.javascriptDialogOpening"){if(current&&!current.closed)ambiguous=true;current={sequence:row?.sequence,params:structuredClone(params),closed:false,claimed:false};}
    if(method==="Page.javascriptDialogClosed"){if(!current||current.closed||params.frameId!==current.params.frameId)ambiguous=true;else current.closed=true;}
  };
  const onDetach=(s,reason)=>{if(matches(s)){attached=false;emit({kind:"native",source:structuredClone(s),method:"debugger.onDetach",params:{reason}});}};
  chrome.debugger.onEvent.addListener(onEvent);chrome.debugger.onDetach.addListener(onDetach);
  const navigation=[];
  for(const name of config.webEvents){const listener=params=>{if(params.tabId===config.tabId){const value=project({tabId:params.tabId},"webNavigation."+name,params,config.webEvents);if(value)emit({kind:"native",...value});}};chrome.webNavigation[name].addListener(listener);navigation.push({name,listener});}
  target.__managedModalProbe={enqueue,snapshot:()=>({rows:structuredClone(rows),pending:[...pending.keys()],attached,active,overflow,ambiguous}),status:()=>({sequence,pending:[...pending.keys()],attached,active,overflow,ambiguous}),
    stop(){chrome.debugger.onEvent.removeListener(onEvent);chrome.debugger.onDetach.removeListener(onDetach);for(const{name,listener}of navigation)chrome.webNavigation[name].removeListener(listener);active=false;return{pending:[...pending.keys()],attached,active};}};
  return {installed:true,source,scope:"explicit diagnostic attachment; no production lease or business JS evaluation"};
}

export function managedModalCommandLedger(rows, observationAt=Infinity) {
  let previous=0;const entries=new Map();
  for(const row of rows){assert.ok(Number.isSafeInteger(row.sequence)&&row.sequence===previous+1,"original observer sequence must be complete");previous=row.sequence;assert.notEqual(row.kind,"observer-error","original observer failed to retain complete native evidence");
    if(row.kind==="request"){assert.ok(!entries.has(row.id));entries.set(row.id,{request:row,dispatch:null,settlement:null});}
    if(row.kind==="dispatch"){const entry=entries.get(row.id);assert.ok(entry&&!entry.dispatch&&!entry.settlement);assert.equal(entry.request.method,row.method);entry.dispatch=row;}
    if(row.kind==="settlement"){const entry=entries.get(row.id);assert.ok(entry&&!entry.settlement);assert.equal(entry.request.method,row.method);assert.ok(row.sequence>entry.request.sequence);if(row.status==="fulfilled")assert.ok(entry.dispatch);entry.settlement=row;}
  }
  return [...entries.values()].map(entry=>({...entry,pendingAtObservation:entry.request.at<=observationAt&&(!entry.settlement||entry.settlement.at>observationAt)}));
}
export function managedModalPair(rows,{targetId,tabId,url,message}) {
  const dialogs=rows.filter(row=>row.kind==="native"&&["Page.javascriptDialogOpening","Page.javascriptDialogClosed"].includes(row.method));
  for(const row of dialogs){assert.equal(row.source.sessionId,undefined);assert.equal(row.source.extensionId,undefined);assert.ok(row.source.targetId===targetId||row.source.tabId===tabId);if(row.source.targetId!==undefined)assert.equal(row.source.targetId,targetId);if(row.source.tabId!==undefined)assert.equal(row.source.tabId,tabId);assert.equal(row.params.frameId,targetId);}
  const openings=dialogs.filter(row=>row.method==="Page.javascriptDialogOpening"),closed=dialogs.filter(row=>row.method==="Page.javascriptDialogClosed");
  assert.ok(openings.length<=1&&closed.length<=1);if(!openings.length){assert.equal(closed.length,0);return{proved:false,reason:"no original native Opening; gate/HTTP markers are not proof"};}
  const opening=openings[0];assert.equal(opening.params.url,url);assert.equal(opening.params.type,"prompt");assert.equal(opening.params.message,message);
  if(closed.length){assert.ok(closed[0].sequence>opening.sequence);assert.deepEqual(closed[0].source,opening.source);}
  return{proved:true,opening,closed:closed[0]??null};
}

async function hashes(directory){const result={};for(const entry of await fs.readdir(directory,{recursive:true,withFileTypes:true})){assert.ok(!entry.isSymbolicLink());if(entry.isFile()){const file=path.join(entry.parentPath,entry.name);result[path.relative(directory,file).replaceAll("\\","/")]=sha(await fs.readFile(file));}}return result;}
export async function runManagedModalBoundaryCheck() {
  assert.equal(process.platform,"win32");const scenario=process.env.OBU_TEST_MODAL_BOUNDARY_CASE;assert.ok(managedModalBoundaryCases.includes(scenario));
  const executable=process.env.OBU_TEST_HOST_BINARY,extension=process.env.OBU_TEST_EXTENSION_DIR,chromium=process.env.OBU_TEST_CHROMIUM_BINARY,buildFile=process.env.OBU_TEST_BUILD_MANIFEST;
  for(const file of [executable,extension,chromium,buildFile]){assert.ok(typeof file==="string"&&path.isAbsolute(file));await fs.access(file);}
  await fs.mkdir(path.join(repo,".tmp/browser-integration"),{recursive:true});
  const runDir=await fs.mkdtemp(path.join(repo,".tmp/browser-integration/mbd-")),root=path.join(runDir,"r"),name="n";
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
      await listenFixture(server);fixture=createManagedModalBoundaryFixture({baseURL:`http://127.0.0.1:${server.address().port}`,scenario});report.fixtureDefinition={workflowId:fixture.workflowId,urls:fixture.urls,prompt:fixture.prompt};
    });
    await step("formal-start-and-original-delivery",async()=>{
      launcher=launch(executable,["managed","run","--root",root,"--name",name,"--browser-path",chromium,"--extension-dir",extension,"--startup-timeout","30s"]);
      const ready=await poll(()=>{assert.ok(!launcher.record.closedAt);return parseManagedReadyOutput(launcher.record.stdout);},{timeoutMs:40000,intervalMs:50,label:"managed ready"});assert.equal(ready.state,"ready");info=ready.info;report.info=info;
      const life=await lifecycle("ready");assertManagedViewerBrowserCommand(life,chromium);assert.deepEqual(life.info,info);
      const endpoint=await waitPrivateDevToolsEndpoint(info.profileDir,{assertAlive(){assert.ok(!launcher.record.closedAt);}});const response=await fetch(`http://127.0.0.1:${endpoint.port}/json/list`,{signal:AbortSignal.timeout(10000)});const workers=(await response.json()).filter(row=>row.type==="service_worker"&&row.url===`chrome-extension://${info.extensionId}/background.js`);assert.equal(workers.length,1);
      report.workerConnection={};worker=await connectNormalCDP(workers[0].webSocketDebuggerUrl,{record:report.workerConnection,handshakeTimeoutMs:10000,authorizationRequired:false});await worker.call("Runtime.enable");await worker.call("Runtime.addBinding",{name:"__obuModalProbeEvent"});
      const{connectOpenBrowserUse}=await import(pathToFileURL(path.join(runDir,"sdk-input/index.js")));sdk=await connectOpenBrowserUse({socketPath:info.socketPath,sessionId:"native-modal-boundary",timeoutMs:10000});tab=await sdk.newTab({url:fixture.urls.source,backgroundWindow:true});report.initialSnapshot=await tab.domSnapshot();
      report.originalDocuments=await worker.evaluate(`chrome.scripting.executeScript({target:{tabId:${tab.id}},func:${readManagedModalBoundaryDocument.toString()}}).then(rows=>rows.map(row=>({documentId:row.documentId,frameId:row.frameId,...row.result})))`,3000);assert.equal(report.originalDocuments.length,1);assert.equal(report.originalDocuments[0].state.workflowId,fixture.workflowId);
      if(scenario==="native-navigation")report.point=(await worker.evaluate(`chrome.scripting.executeScript({target:{tabId:${tab.id}},func:${measureManagedModalBoundaryLink.toString()}}).then(rows=>rows.map(row=>row.result))`,3000))[0];
      report.finalize=await sdk.client.finalizeTabs([{tabId:tab.id,status:"deliverable"}]);await bound(sdk.close(),5000,"original SDK close");sdk=null;
      const targets=await worker.evaluate(`chrome.debugger.getTargets().then(rows=>rows.filter(row=>row.type==='page'&&row.tabId===${tab.id}).map(row=>({id:row.id,tabId:row.tabId,url:row.url,attached:row.attached})))`,3000);assert.equal(targets.length,1);assert.equal(targets[0].attached,false);report.target=targets[0];
      const config={targetId:report.target.id,tabId:tab.id,emitterURL:fixture.urls[fixture.emitterRole],message:fixture.prompt.message,methods:allowedMethods,webEvents:managedOopifWebNavigationEvents};report.probeInstall=await worker.evaluate(`(${installManagedModalProbe.toString()})(chrome,globalThis,${JSON.stringify(config)},${projectManagedOopifEvent.toString()})`,3000);await remember("ready");
    });
    await step("single-original-modal-boundary",async()=>{
      if(scenario==="native-pre-attach"){
        await poll(()=>fixture.stats().requests.some(row=>row.url===new URL(fixture.urls.gate).pathname),{timeoutMs:5000,intervalMs:25,label:"original gate request"});report.gateRelease=fixture.releaseGate();
        await poll(()=>fixture.stats().requests.some(row=>row.url===new URL(fixture.urls.entered).pathname),{timeoutMs:5000,intervalMs:25,label:"before-call telemetry, not modal proof"});await observe("before-attach-marker-only",250);
      }
      await requireACK(await enqueue("attach"),"original diagnostic attach");
      report.pageEnableId=await enqueue("Page.enable");
      if(scenario==="native-navigation"){
        await requireACK(report.pageEnableId,"source Page.enable before modal");
        for(const [method,params]of [["Runtime.enable",{}],["Performance.enable",{timeDomain:"timeTicks"}],["Emulation.setFocusEmulationEnabled",{enabled:true}]])await requireACK(await enqueue(method,params),method);
        report.beforeTree=await requireACK(await enqueue("Page.getFrameTree"),"original source tree");assert.equal(report.beforeTree.frameTree.frame.id,report.target.id);assert.equal(report.beforeTree.frameTree.frame.url,fixture.urls.source);
        await requireACK(await enqueue("Page.startScreencast",{format:"png",everyNthFrame:1},"source-startScreencast"),"source startScreencast");await poll(()=>collect().some(row=>row.kind==="frame"),{timeoutMs:5000,intervalMs:25,label:"source native frame"});
        const{x,y}=report.point;await requireACK(await enqueue("Input.dispatchMouseEvent",{type:"mouseMoved",x,y,button:"none",buttons:0},"source-move"),"original move");await requireACK(await enqueue("Input.dispatchMouseEvent",{type:"mousePressed",x,y,button:"left",buttons:1,clickCount:1},"source-down"),"original down");
        report.originalInputId=await enqueue("Input.dispatchMouseEvent",{type:"mouseReleased",x,y,button:"left",buttons:0,clickCount:1},"original-navigation-up");
      }
      await observe("native-opening-window",1500);let native=pair();report.openingObservation=native;
      if(!native.proved){report.outcome="native-opening-unproved; formal Stop only";return;}
      if(native.closed){report.outcome="original-native-closed-before-probes";return;}
      report.modalProbeIds=[];
      for(const [method,params]of [["Page.stopScreencast",{}],["Page.getFrameTree",{}],["Page.getLayoutMetrics",{}],["Runtime.enable",{}],["Performance.enable",{timeDomain:"timeTicks"}],["Performance.getMetrics",{}],["Page.startScreencast",{format:"png",everyNthFrame:1}]])report.modalProbeIds.push(await enqueue(method,params,"modal-"+method));
      await observe("modal-commands-pending-or-acknowledged",1500);native=pair();
      if(!native.closed){report.cancelCommandId=await enqueue("Page.handleJavaScriptDialog",{accept:false},"one-original-cancel");await observe("original-cancel-and-late-acks",1500);}
      native=pair();report.nativePair=native;
      if(native.closed){assert.equal(native.closed.params.result,false);await poll(()=>fixture.stats().receipt,{timeoutMs:5000,intervalMs:25,label:"original cancellation POST"});
        const frames=await worker.evaluate(`chrome.webNavigation.getAllFrames({tabId:${tab.id}})`,3000);const emitter=frames.filter(row=>row.frameId===0&&row.url===fixture.urls[fixture.emitterRole]);assert.equal(emitter.length,1);report.emitterFrame=emitter[0];
        const document=await poll(async()=>{const rows=await worker.evaluate(`chrome.scripting.executeScript({target:{tabId:${tab.id},documentIds:${JSON.stringify([emitter[0].documentId])}},func:${readManagedModalBoundaryDocument.toString()}}).then(rows=>rows.map(row=>({documentId:row.documentId,frameId:row.frameId,...row.result})))`,3000);return rows.length===1&&rows[0].state?.phase==="committed"&&rows[0];},{timeoutMs:5000,intervalMs:50,label:"original document receipt publication"});report.finalDocument=document;report.receipt=fixture.verify(document);report.outcome="original-native-cancelled-and-single-post";
      }else report.outcome="original-native-response-unconfirmed; formal Stop only";
      await observe("before-formal-stop",250);report.finalLedger=managedModalCommandLedger(collect());
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
    report.limits=["Raw diagnostic attachment is not a production human/viewer lease or feature acceptance.","Gate/entered GETs prove fixture sequencing, never native modal existence. Missing Opening stays unproved.","Debugger events before original attach ACK are unowned metadata and cannot authorize a response.","Probe dispatch is intentionally concurrent; pending intervals establish observations for this combination, not isolated command behavior or internal Chromium wait-for causality.","In native-navigation Runtime.enable already ACKed before the click; its modal probe is warm/idempotent and does not prove cold setup before the first frame.","Original promise rejection on browser destruction is distinct from an input ACK or successful dialog response.","Raw lifecycle file is the uint64 identity authority; copied JSON numbers are not process identity."];
    await save();console.log("RESULT",JSON.stringify({runDir,scenario,completed:report.completed,outcome:report.outcome,featurePassed:false}));
  }
  return report;
}
if(process.argv[1]&&pathToFileURL(path.resolve(process.argv[1])).href===import.meta.url){assert.equal(process.argv.length,2);const result=await runManagedModalBoundaryCheck();if(!result.completed)process.exitCode=1;}

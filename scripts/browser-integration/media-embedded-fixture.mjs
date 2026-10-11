import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { embeddedLimit, embeddedPNG, embeddedBoundaryPNG, embeddedWAV, embeddedWebM, mediaAssetHash, mediaAssetIdentity, verifyRedGreenPNG } from "./media-fixture-assets.mjs";

export function createEmbeddedMediaFixtures() {
  const requests = [];
  return {
    stats: () => structuredClone(requests),
    handle(request, response, port) {
      const url = new URL(request.url, "http://localhost");
      if (!url.pathname.startsWith("/media-breadth/")) return false;
      requests.push({ index: requests.length, at: Date.now(), path: url.pathname, query: url.search,
        host: request.headers.host, method: request.method, destination: request.headers["sec-fetch-dest"] ?? "",
        range: request.headers.range ?? null });
      response.setHeader("Cache-Control", "no-store");
      const assets = { "/media-breadth/selected.png": ["image/png", embeddedPNG], "/media-breadth/selected.wav": ["audio/wav", embeddedWAV], "/media-breadth/selected.webm": ["video/webm", embeddedWebM] };
      if (assets[url.pathname]) {
        const [type, data] = assets[url.pathname];
        response.setHeader("Content-Type", type); response.setHeader("Content-Length", data.length);
        response.end(data); return true;
      }
      if (url.pathname === "/media-breadth/poison") { response.writeHead(500); response.end("Getter interception must never be fetched"); return true; }
      if (url.pathname === "/media-breadth/partition") {
        response.setHeader("Content-Type", "text/html; charset=utf-8");
        const blob = url.searchParams.get("blob");
        assert.ok(blob?.startsWith(`blob:http://127.0.0.1:${port}/`));
        response.end(`<!doctype html><title>Blob partition comparison</title><iframe id="reader"></iframe><script>
          globalThis.partitionReady=new Promise(resolve=>addEventListener('message',event=>{if(event.data?.tag==='partition-result')resolve(event.data.result)}));
          document.querySelector('#reader').src=${JSON.stringify(`http://127.0.0.1:${port}/media-breadth/partition-frame?blob=${encodeURIComponent(blob)}`)};
          </script>`); return true;
      }
      if (url.pathname === "/media-breadth/partition-frame") {
        response.setHeader("Content-Type", "text/html; charset=utf-8");
        const blob = url.searchParams.get("blob"); assert.ok(blob?.startsWith(`blob:http://127.0.0.1:${port}/`));
        response.end(`<!doctype html><title>Partitioned frame</title><img id="partition-image"><script>
          const source=${JSON.stringify(blob)},img=document.querySelector('#partition-image');
          (async()=>{const result={source,origin:location.origin};
            try{const response=await fetch(source),bytes=await response.arrayBuffer();result.fetch={allowed:true,bytes:bytes.byteLength,sha256:Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',bytes)),x=>x.toString(16).padStart(2,'0')).join('')}}catch(error){result.fetch={allowed:false,error:error.name+': '+error.message}}
            img.src=source;try{await img.decode();result.image={loaded:true,width:img.naturalWidth,height:img.naturalHeight}}catch(error){result.image={loaded:false,error:error.name}}
            result.currentSrc=img.currentSrc;top.postMessage({tag:'partition-result',result},'*');})();
          </script>`); return true;
      }
      if (url.pathname !== "/media-breadth/page") { response.writeHead(404); response.end(); return true; }
      response.setHeader("Content-Type", "text/html; charset=utf-8");
      response.end(embeddedMediaHTML({ port, scope: url.searchParams.get("scope") || "root", negative: url.searchParams.has("negative"), boundary: url.searchParams.has("boundary") }));
      return true;
    }
  };
}

function embeddedMediaHTML({ port, scope, negative, boundary }) {
  assert.ok(["root", "same", "cross", "nested", "partition-owner", "partition-reader"].includes(scope));
  return `<!doctype html><meta charset="utf-8"><title>Synthetic embedded media</title>
    <style>body{font:16px sans-serif}canvas,img{image-rendering:pixelated}iframe{width:450px;height:200px}</style>
    <h1>Synthetic media breadth</h1><div id="media"></div><div id="shadow"></div>
    <script>
    const fixtureScope=${JSON.stringify(scope)}, negative=${negative}, boundary=${boundary}, port=${port};
    const asset={png:${JSON.stringify(embeddedPNG.toString("base64"))},wav:${JSON.stringify(embeddedWAV.toString("base64"))},webm:${JSON.stringify(embeddedWebM.toString("base64"))}};
    const MIME={png:'image/png',wav:'audio/wav',webm:'video/webm'};
    const nativeFetch=fetch.bind(globalThis), nativeImageSrc=Object.getOwnPropertyDescriptor(HTMLImageElement.prototype,'currentSrc').get;
    const nativeMediaSrc=Object.getOwnPropertyDescriptor(HTMLMediaElement.prototype,'currentSrc').get;
    const nativeCanvasData=HTMLCanvasElement.prototype.toDataURL;
    globalThis.mediaEvents=[];globalThis.getterTraps=[];globalThis.mediaFrameReports={};
    for(const event of ['pointerdown','click','focus','keydown','wheel'])addEventListener(event,()=>mediaEvents.push(event),true);
    addEventListener('message',event=>{if(event.data?.tag==='obu-media-breadth-ready')mediaFrameReports[event.data.scope]=event.data.state});
    const raw=base64=>Uint8Array.from(atob(base64),c=>c.charCodeAt(0));
    const blobURL=kind=>URL.createObjectURL(new Blob([raw(asset[kind])],{type:MIME[kind]}));
    const dataURL=kind=>'data:'+MIME[kind]+';base64,'+asset[kind];
    const states=[], urls=[], tracks=[];
    function observe(element){const src=(element instanceof HTMLImageElement?nativeImageSrc:nativeMediaSrc).call(element);return {id:element.id,tag:element.tagName,src:src.length<=4096?src:src.slice(0,96),srcLength:src.length,srcTruncated:src.length>4096,
      ...(element instanceof HTMLImageElement?{complete:element.complete,width:element.naturalWidth,height:element.naturalHeight}:
      {readyState:element.readyState,duration:element.duration,width:element.videoWidth??null,height:element.videoHeight??null,paused:element.paused}),events:[...(element.fixtureEvents??[])]}}
    async function loaded(element){
      if(element instanceof HTMLImageElement) await element.decode();
      else await new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(Error('Native media readiness timeout '+element.id)),12000);
        const done=()=>{if(element.readyState>=2){clearTimeout(timer);resolve()}};
        element.addEventListener('loadeddata',done,{once:true});element.addEventListener('error',()=>{clearTimeout(timer);reject(Error('Native media decode failed '+element.id+':'+element.error?.code))},{once:true});done()});
      const state=observe(element);states.push(state);return state;
    }
    function media(id,kind,src,parent=document.querySelector('#media')){
      const element=document.createElement(kind==='png'?'img':kind==='wav'?'audio':'video');element.id=id;element.fixtureEvents=[];
      for(const name of ['loadedmetadata','loadeddata','load'])element.addEventListener(name,()=>element.fixtureEvents.push(name));
      if(kind!=='png'){element.preload='auto';element.muted=true;}element.src=src;parent.append(element);return element;
    }
    function canvas(id,width=2,height=1){const element=document.createElement('canvas');element.id=id;element.width=width;element.height=height;document.querySelector('#media').append(element);
      if(width===2&&height===1){const c=element.getContext('2d');c.fillStyle='#ff0000';c.fillRect(0,0,1,1);c.fillStyle='#00ff00';c.fillRect(1,0,1,1);}return element}
    globalThis.mediaReady=(async()=>{
      const local={scope:fixtureScope,states,assets:${JSON.stringify(mediaAssetIdentity)},webmCapability:document.createElement('video').canPlayType('video/webm; codecs="vp8"'),negative:{}};
      const pending=[];
      for(const kind of ['png','wav','webm'])for(const mode of ['data','blob']){const src=mode==='data'?dataURL(kind):blobURL(kind);if(mode==='blob')urls.push(src);pending.push(loaded(media(mode+'-'+kind,kind,src)))}
      pending.push(loaded(media('http-wav','wav','/media-breadth/selected.wav?scope='+fixtureScope)));
      pending.push(loaded(media('http-webm','webm','/media-breadth/selected.webm?scope='+fixtureScope)));
      const rootCanvas=canvas('canvas');local.canvasBase64=nativeCanvasData.call(rootCanvas,'image/png').split(',')[1];
      const shadow=document.querySelector('#shadow').attachShadow({mode:'open'}),shadowURL=blobURL('png');urls.push(shadowURL);pending.push(loaded(media('shadow-blob','png',shadowURL,shadow)));
      await Promise.all(pending);
      if(boundary&&fixtureScope==='root'){
        const bytes=new Uint8Array(${embeddedLimit});bytes.set(raw(asset.png));
        const blob=URL.createObjectURL(new Blob([bytes],{type:'image/png'}));urls.push(blob);await loaded(media('boundary-blob','png',blob));
        let encoded='';for(let n=0;n<bytes.length;n+=16384)encoded+=String.fromCharCode(...bytes.subarray(n,n+16384));
        await loaded(media('boundary-data','png','data:image/png;base64,'+btoa(encoded)));
        local.boundary={bytes:bytes.length,trailer:'zero bytes after valid PNG IEND; both sources passed native image.decode'};
      }
      if(negative){
        for(const [id,tag] of [['empty-img','img'],['empty-audio','audio'],['empty-video','video']]){const e=document.createElement(tag);e.id=id;document.querySelector('#media').append(e)}
        canvas('zero-canvas',0,0);canvas('oversize-canvas',4097,4096);
        const taint=canvas('tainted-canvas'),taintImage=new Image();taintImage.src='http://localhost:'+port+'/media-breadth/selected.png?taint=1';await taintImage.decode();taint.getContext('2d').drawImage(taintImage,0,0);
        try{taint.getContext('2d').getImageData(0,0,1,1);throw Error('Expected real cross-origin canvas taint')}catch(error){if(error.name!=='SecurityError')throw error;local.negative.tainted=error.name}
        const revoked=blobURL('png');const revokedImage=media('revoked-blob','png',revoked);await loaded(revokedImage);URL.revokeObjectURL(revoked);local.negative.revoked=observe(revokedImage);
        const large=new Uint8Array(${embeddedLimit}+1);large.set(raw(asset.png));
        const largeBlob=URL.createObjectURL(new Blob([large],{type:'image/png'}));urls.push(largeBlob);await loaded(media('oversize-blob','png',largeBlob));
        let encoded='';for(let n=0;n<large.length;n+=16384)encoded+=String.fromCharCode(...large.subarray(n,n+16384));
        await loaded(media('oversize-data','png','data:image/png;base64,'+btoa(encoded)));local.negative.oversizeBytes=large.length;
        const mse=new MediaSource(),mseURL=URL.createObjectURL(mse);urls.push(mseURL);
        const mseVideo=media('mse-video','webm',mseURL);
        await new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(Error('MSE did not open')),5000);mse.addEventListener('sourceopen',()=>{clearTimeout(timer);resolve()},{once:true});if(mse.readyState==='open'){clearTimeout(timer);resolve()}});
        local.negative.mse={readyState:mse.readyState,currentSrc:nativeMediaSrc.call(mseVideo)};
        const stream=rootCanvas.captureStream(0);tracks.push(...stream.getTracks());const streamVideo=document.createElement('video');streamVideo.id='src-object';streamVideo.srcObject=stream;document.querySelector('#media').append(streamVideo);
        local.negative.srcObject={isMediaStream:streamVideo.srcObject instanceof MediaStream,tracks:stream.getTracks().map(track=>track.kind)};
        try{const access=await navigator.requestMediaKeySystemAccess('org.w3.clearkey',[{initDataTypes:['webm'],videoCapabilities:[{contentType:'video/webm; codecs="vp8"'}]}]);
          const keys=await access.createMediaKeys(),drm=media('drm-video','webm',dataURL('webm'));await drm.setMediaKeys(keys);local.negative.drm={available:drm.mediaKeys!==null,keySystem:access.keySystem};
        }catch(error){local.negative.drm={available:false,error:error.name+': '+error.message,coverage:'not exercised; no native MediaKeys object available'}}
      }
      for(const prototype of [HTMLImageElement.prototype,HTMLMediaElement.prototype])Object.defineProperty(prototype,'currentSrc',{get(){getterTraps.push('prototype-currentSrc');return location.origin+'/media-breadth/poison'}});
      for(const element of document.querySelectorAll('img,audio,video'))Object.defineProperty(element,'currentSrc',{get(){getterTraps.push('instance-currentSrc');return location.origin+'/media-breadth/poison'}});
      for(const name of ['toDataURL','toBlob'])HTMLCanvasElement.prototype[name]=function(){getterTraps.push(name);throw Error('page canvas trap')};
      globalThis.fetch=function(){getterTraps.push('fetch');throw Error('page fetch trap')};
      globalThis.mediaOwnReady=local;
      if(fixtureScope!=='root'){top.postMessage({tag:'obu-media-breadth-ready',scope:fixtureScope,state:local},'*');return local}
      if(!negative){
        for(const [id,origin,child] of [['same',location.origin,'same'],['cross','http://localhost:'+port,'cross'],['nested',location.origin,'nested']]){
          const frame=document.createElement('iframe');frame.id=id;frame.src=origin+'/media-breadth/page?scope='+child;
          // Nested is genuinely inside the same-origin child, not another root frame.
          if(id==='nested')continue;document.body.append(frame)
        }
        await new Promise((resolve,reject)=>{const started=Date.now();const timer=setInterval(()=>{
          if(['same','cross','nested'].every(key=>mediaFrameReports[key])){clearInterval(timer);resolve()}
          else if(Date.now()-started>15000){clearInterval(timer);reject(Error('Child media readiness incomplete '+Object.keys(mediaFrameReports)))}},25)});
        local.frames=mediaFrameReports;
      }
      return local;
    })();
    if(fixtureScope==='same'){const child=document.createElement('iframe');child.id='nested';child.src='/media-breadth/page?scope=nested';document.body.append(child)}
    mediaReady.catch(error=>{globalThis.mediaReadinessError=error.stack;top.postMessage({tag:'obu-media-breadth-failed',scope:fixtureScope,error:error.message},'*')});
    addEventListener('pagehide',()=>{for(const url of urls)URL.revokeObjectURL(url);for(const track of tracks)track.stop()},{once:true});
    </script>`;
}

export async function prepareEmbeddedMediaTab(browser, fixtureURL, { negative = false, boundary = false } = {}) {
  const url = new URL("media-breadth/page", fixtureURL);
  if (negative) url.searchParams.set("negative", "1");
  if (boundary) url.searchParams.set("boundary", "1");
  const tab = await browser.newTab({ url: url.href });
  await tab.waitForLoadState({ state: "load" });
  const readiness = await tab.evaluate("mediaReady", { awaitPromise: true });
  assert.ok(["probably", "maybe"].includes(readiness.webmCapability), "Required VP8 native codec is unavailable");
  for (const frame of [readiness, ...Object.values(readiness.frames ?? {})]) {
    for (const state of frame.states.filter(state => !state.id.startsWith("oversize") && state.id !== "revoked-blob")) {
      if (state.tag === "IMG") { assert.equal(state.complete, true); assert.equal(state.width, 2); assert.equal(state.height, 1); }
      else { assert.ok(state.readyState >= 2 && state.duration > 0); assert.equal(state.paused, true);
        assert.ok(state.events.includes("loadedmetadata"), "Native loadedmetadata event missing");
        if (state.tag === "VIDEO") { assert.equal(state.width, 16); assert.equal(state.height, 16); }
      }
    }
  }
  return { tab, readiness };
}

export async function verifyEmbeddedMediaFile(filename, root, kind, expectedCanvas) {
  const actual = await fs.realpath(filename), expectedRoot = await fs.realpath(root);
  assert.equal(path.dirname(actual), expectedRoot, "Media file escaped this run's download directory");
  const bytes = await fs.readFile(actual);
  const expected = { png: embeddedPNG, boundary: embeddedBoundaryPNG, wav: embeddedWAV, webm: embeddedWebM, canvas: expectedCanvas && Buffer.from(expectedCanvas, "base64") }[kind];
  assert.ok(expected, `Unknown or unbound expected media kind ${kind}`);
  assert.deepEqual(bytes, expected, `Exact ${kind} payload differs from the synthetic selected source`);
  return { path: actual, kind, bytes: bytes.length, sha256: mediaAssetHash(bytes), ...(kind === "png" || kind === "canvas" ? verifyRedGreenPNG(bytes) : kind === "boundary" ? { ...verifyRedGreenPNG(bytes.subarray(0, embeddedPNG.length)), trailerBytes: bytes.length - embeddedPNG.length } : {}) };
}

export async function readMediaFrameEvidence(worker, tabId) {
  const frames = await worker.evaluate(`chrome.scripting.executeScript({target:{tabId:${JSON.stringify(tabId)},allFrames:true},world:'MAIN',func:()=>({scope:globalThis.mediaOwnReady?.scope,events:globalThis.mediaEvents,traps:globalThis.getterTraps})})`);
  assert.ok(frames.length > 0);
  for (const frame of frames) {
    assert.ok(frame.result.scope, "Expected synthetic media document");
    assert.deepEqual(frame.result.events, [], `Unexpected input in ${frame.result.scope}`);
    assert.deepEqual(frame.result.traps, [], `Main-world interception in ${frame.result.scope}`);
  }
  return frames;
}

async function compareBlobPartition({ browser, owner, fixtureURL, downloadRoot }) {
  const source = await owner.evaluate("document.querySelector('#blob-png').getAttribute('src')");
  const destination = new URL("media-breadth/partition", fixtureURL); destination.hostname = "localhost"; destination.searchParams.set("blob", source);
  const tab = await browser.newTab({ url: destination.href });
  const detail = await tab.evaluate("partitionReady", { awaitPromise: true });
  detail.topLevelOrigin = destination.origin; detail.tabId = tab.id;
  if (detail.fetch.allowed) {
    assert.equal(detail.fetch.sha256, mediaAssetIdentity.png.sha256);
    assert.equal(detail.image.loaded, true, "Partition comparison lacks a selected image");
    const download = await tab.frameLocator("#reader").locator("#partition-image").downloadMedia({ filename: "breadth-partition-policy-permitted.png", timeoutMs: 5000 });
    try { detail.source = { allowed: true, file: await verifyEmbeddedMediaFile(await download.path({ timeoutMs: 5000 }), downloadRoot, "png") }; }
    finally { await download.cancel({ timeoutMs: 5000 }); }
    detail.coverage = "Browser permitted the cross-partition normal fetch; this run does not prove a blocked partition boundary.";
  } else {
    await assert.rejects(tab.frameLocator("#reader").locator("#partition-image").downloadMedia({ timeoutMs: 3000 }), error => {
      detail.source = { allowed: false, error: error.message }; return /OBU_MEDIA_(READ_FAILED|UNSUPPORTED)/.test(error.message);
    });
    detail.coverage = "The same-origin frame normal fetch and media source both rejected the foreign top-level partition blob.";
  }
  return detail;
}

export async function checkEmbeddedMedia({ browser, foreignBrowser, fixtureURL, server, downloadRoot, saveDetail, worker }) {
  const detail = { assets: mediaAssetIdentity, files: [], cleanup: [], requests: [] };
  const handles = [];
  try {
    const { tab, readiness } = await prepareEmbeddedMediaTab(browser, fixtureURL, { boundary: true }); detail.tabId = tab.id; detail.readiness = readiness;
    const cases = [
      ...["wav", "webm"].map(kind => [tab.locator(`#http-${kind}`), kind, `http-${kind}`, null]),
      ...["png", "wav", "webm"].flatMap(kind => ["data", "blob"].map(mode => [tab.locator(`#${mode}-${kind}`), kind, `${mode}-${kind}`, null])),
      [tab.locator("#canvas"), "canvas", "canvas", readiness.canvasBase64],
      ...["blob", "data"].map(mode => [tab.locator(`#boundary-${mode}`), "boundary", `boundary-${mode}`, null]),
      [tab.locator("#shadow-blob"), "png", "shadow-blob", null],
      [tab.frameLocator("#same").locator("#blob-wav"), "wav", "same-blob-wav", null],
      [tab.frameLocator("#cross").locator("#blob-png"), "png", "cross-blob-png", null],
      [tab.frameLocator("#same").frameLocator("#nested").locator("#canvas"), "canvas", "nested-canvas", readiness.frames.nested.canvasBase64]
    ];
    for (const [target, kind, name, expected] of cases) {
      const before = server.stats().length;
      const handle = await target.downloadMedia({ filename: `breadth-js-${name}.${["canvas", "boundary"].includes(kind) ? "png" : kind}`, timeoutMs: kind === "boundary" ? 15000 : 10000 }); handles.push(handle);
      const file = await verifyEmbeddedMediaFile(await handle.path({ timeoutMs: 5000 }), downloadRoot, kind, expected);
      const requests = server.stats().slice(before); detail.requests.push(...requests);
      if (name.startsWith("http-")) { assert.equal(requests.length, 1); assert.equal(requests[0].method, "GET"); assert.equal(requests[0].path, `/media-breadth/selected.${kind}`); }
      else assert.equal(requests.length, 0, "Local embedded bytes must not produce a page/server HTTP download");
      detail.files.push({ ...file, name, downloadId: handle.downloadId, requests }); await saveDetail(detail);
    }
    await assert.rejects(foreignBrowser.tab(tab.id).locator("#blob-wav").downloadMedia({ timeoutMs: 1000 }), /session|owned|claim|part of/);
    detail.frames = await readMediaFrameEvidence(worker, tab.id);
    detail.partition = await compareBlobPartition({ browser, owner: tab, fixtureURL, downloadRoot });
    detail.foreignDenied = true;
    return detail;
  } finally {
    const cleanup = await Promise.allSettled(handles.map(handle => handle.cancel({ timeoutMs: 5000 })));
    detail.cleanup = cleanup.map((result, index) => ({ downloadId: handles[index].downloadId, cancelled: result.status === "fulfilled", ...(result.status === "rejected" ? { error: result.reason.message } : {}) }));
    detail.serverRequests = server.stats(); await saveDetail(detail);
    const failed = cleanup.filter(result => result.status === "rejected");
    if (failed.length) throw new AggregateError(failed.map(result => result.reason), "Media handle cleanup failed");
  }
}

export async function checkEmbeddedMediaNegative({ browser, fixtureURL, server, downloadRoot, saveDetail, worker }) {
  const detail = { negative: [], requests: [] };
  try {
    const { tab, readiness } = await prepareEmbeddedMediaTab(browser, fixtureURL, { negative: true }); detail.tabId = tab.id; detail.readiness = readiness;
    const cases = [
      ["empty-img", /OBU_MEDIA_UNSUPPORTED/], ["empty-audio", /OBU_MEDIA_UNSUPPORTED/], ["empty-video", /OBU_MEDIA_UNSUPPORTED/],
      ["zero-canvas", /OBU_MEDIA_UNSUPPORTED|OBU_MEDIA_LIMIT/], ["oversize-canvas", /OBU_MEDIA_LIMIT/],
      ["tainted-canvas", /OBU_MEDIA_TAINTED/], ["revoked-blob", /OBU_MEDIA_READ_FAILED/],
      ["oversize-blob", /OBU_MEDIA_LIMIT/], ["oversize-data", /OBU_MEDIA_LIMIT/],
      ["mse-video", /OBU_MEDIA_READ_FAILED|OBU_MEDIA_UNSUPPORTED/], ["src-object", /OBU_MEDIA_UNSUPPORTED/]
    ];
    if (readiness.negative.drm.available) cases.push(["drm-video", /OBU_MEDIA_UNSUPPORTED/]);
    for (const [id, pattern] of cases) {
      const before = server.stats().length, filesBefore = (await fs.readdir(downloadRoot)).sort(), witness = { id, expected: pattern.source };
      detail.negative.push(witness);
      await assert.rejects(tab.locator(`#${id}`).downloadMedia({ filename: `must-not-download-${id}.bin`, timeoutMs: 3000 }), error => { witness.error = error.message; return pattern.test(error.message); });
      witness.requests = server.stats().slice(before); assert.deepEqual(witness.requests, []);
      witness.filesUnchanged = JSON.stringify(filesBefore) === JSON.stringify((await fs.readdir(downloadRoot)).sort());
      assert.equal(witness.filesUnchanged, true, "Rejected source created a download file"); await saveDetail(detail);
    }
    detail.frames = await readMediaFrameEvidence(worker, tab.id);
    return detail;
  } finally { detail.serverRequests = server.stats(); await saveDetail(detail); }
}

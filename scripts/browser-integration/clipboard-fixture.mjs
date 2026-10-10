import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { deflateSync } from "node:zlib";

export function clipboardFixture() {
  return { type: "text/html; charset=utf-8", body: `<!doctype html><meta charset="utf-8"><title>Clipboard isolation fixture</title>
    <h1>Clipboard isolation</h1><p>Only synthetic clipboard content belongs to this test.</p><script>
    globalThis.clipboardInterceptions=[];
    Object.defineProperty(navigator,'clipboard',{value:{read(){clipboardInterceptions.push('read');throw Error('page trap')},write(){clipboardInterceptions.push('write');throw Error('page trap')},readText(){clipboardInterceptions.push('readText');throw Error('page trap')},writeText(){clipboardInterceptions.push('writeText');throw Error('page trap')}}});
    for(const name of ['Blob','ClipboardItem','FileReader']) globalThis[name]=function(){clipboardInterceptions.push(name);throw Error('page trap')};
    </script>` };
}

// Independent deterministic PNG fixture: two opaque pixels, red then green.
export function clipboardPNG() {
  const chunk = (name, bytes) => {
    const data = Buffer.concat([Buffer.from(name), bytes]);
    let crc = 0xffffffff;
    for (const byte of data) {
      crc ^= byte;
      for (let bit=0;bit<8;bit++) crc = (crc>>>1)^((crc&1)?0xedb88320:0);
    }
    const length=Buffer.alloc(4), checksum=Buffer.alloc(4);
    length.writeUInt32BE(bytes.length); checksum.writeUInt32BE((crc^0xffffffff)>>>0);
    return Buffer.concat([length,data,checksum]);
  };
  const header=Buffer.alloc(13);header.writeUInt32BE(2);header.writeUInt32BE(1,4);header[8]=8;header[9]=6;
  return Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10]),chunk("IHDR",header),chunk("IDAT",deflateSync(Buffer.from([0,255,0,0,255,0,255,0,255]))),chunk("IEND",Buffer.alloc(0))]);
}

export function assertMemoryClipboardGuard(guard) {
  assert.equal(process.env.OBU_TEST_MEMORY_CLIPBOARD,"1");
  assert.equal(guard?.verified,true);
  assert.equal(guard?.mode,"chromium-headless-memory");
}

export async function checkClipboard({ browser, foreignBrowser, fixtureURL, guard, saveArtifact }) {
  assertMemoryClipboardGuard(guard);
  assert.equal((await browser.client.getInfo()).metadata.clipboardVersion,1);
  const tab=await browser.newTab({url:fixtureURL+"clipboard"});
  await tab.playwright.domSnapshot();
  const text="OBU synthetic clipboard 中文 😀\nsecond line";
  const nativeText=text.replaceAll("\n","\r\n"); // Pinned Windows clipboard normalizes line endings.
  await tab.clipboard.writeText(text);
  assert.equal(await tab.clipboard.readText(),nativeText);
  const items=[{entries:[
    {mime_type:"text/plain",text},
    {mime_type:"text/html",text:'<b data-test="clipboard">OBU synthetic 中文</b>'},
    {mime_type:"image/png",base64:clipboardPNG().toString("base64")}
  ],presentation_style:"unspecified"}];
  await tab.clipboard.write(items);
  const read=await tab.clipboard.read();
  assert.equal(read.length,1);
  assert.deepEqual(read[0].entries.map(entry=>entry.mime_type).sort(),["image/png","text/html","text/plain"]);
  assert.equal(read[0].entries.find(entry=>entry.mime_type==="text/plain").text,nativeText);
  assert.match(read[0].entries.find(entry=>entry.mime_type==="text/html").text,/OBU synthetic 中文/);
  const png=Buffer.from(read[0].entries.find(entry=>entry.mime_type==="image/png").base64,"base64");
  assert.equal(png.readUInt32BE(16),2);assert.equal(png.readUInt32BE(20),1);
  await saveArtifact("clipboard-js.png",png);
  await saveArtifact("clipboard-js.json",Buffer.from(JSON.stringify({items:read})));
  await tab.clipboard.write([]);
  assert.equal(await tab.clipboard.readText(),nativeText,"Empty rich write unexpectedly cleared the clipboard");
  await assert.rejects(tab.clipboard.read({maxBytes:1}),/LIMIT|size|bytes/i);
  await assert.rejects(browser.client.request("writeClipboard",{tabId:tab.id,items:[{entries:[{mime_type:"application/unknown",text:"never written"}]}]}),/INVALID|unsupported|mime/i);
  await assert.rejects(foreignBrowser.client.readClipboardText(tab.id),/owned|session|control|claim/i);
  assert.equal(await tab.clipboard.readText(),nativeText,"Rejected request changed clipboard");
  assert.deepEqual(await tab.evaluate("clipboardInterceptions"),[]);
  return {mode:guard.mode,tabId:tab.id,types:read[0].entries.map(entry=>entry.mime_type),pngBytes:png.length,pngSHA256:createHash("sha256").update(png).digest("hex"),pageInterceptions:[],emptyWriteNoOp:true,limitsAndForeignDenied:true};
}

export async function holdClipboardPreparation(worker) {
  // Deterministic fault injection: hold the real worker's final scope check
  // after the production offscreen document prepares the write. No native
  // clipboard API or authorization result is mocked.
  await worker.evaluate(`(()=>{
    globalThis.__clipboardReady=false;
    globalThis.__clipboardBroker=__integrationClipboardBackend.clipboardBroker;
    globalThis.__clipboardOriginalValidation=__clipboardBroker.validateScope;
    __clipboardBroker.validateScope=async scope=>{await __clipboardOriginalValidation(scope);__clipboardReady=true;await new Promise(resolve=>globalThis.__clipboardContinue=resolve);};
  })()`);
}

export async function checkClipboardLifecycle({ browser, fixtureURL, guard, worker, until }) {
  assertMemoryClipboardGuard(guard);
  const tab=await browser.newTab({url:fixtureURL+"clipboard"});
  const sentinel="OBU clipboard survives cancelled preparation 中文";
  await tab.clipboard.writeText(sentinel);
  await holdClipboardPreparation(worker);
  let outcome, endDone=false, ending, writing;
  try {
    writing=tab.clipboard.writeText("must never commit").then(()=>outcome={success:true},error=>outcome={error:error.message});
    await until(()=>worker.evaluate("__clipboardReady"),"clipboard prepared before cancellation");
    ending=browser.client.turnEnded().then(value=>{endDone=true;return value;});
    await until(()=>outcome,"pending clipboard caller was cancelled");
    assert.match(outcome.error,/CANCELLED|control ended|epoch|ended/i);
    assert.equal(endDone,false,"Task end acknowledged before real broker cleanup");
    await worker.evaluate("__clipboardContinue();__clipboardBroker.validateScope=__clipboardOriginalValidation;");
    await writing;await ending;
    await browser.client.beginTurn();
    assert.equal(await tab.clipboard.readText(),sentinel,"Cancelled preparation committed a native write");
    assert.deepEqual(await tab.evaluate("clipboardInterceptions"),[]);
    return {faultInjection:"hold final scope validation after native broker preparation",beforeCommitCancelled:true,endAwaitedCleanup:true,clipboardUnchanged:true,noReplay:true};
  } finally {
    // If setup/assertions fail, revoke before releasing the held validation.
    // Otherwise a failed fixture could commit its write during cleanup.
    if (writing && !ending) {
      ending=browser.client.turnEnded();
      ending.catch(()=>{});
      await until(()=>outcome,"clipboard fixture cleanup cancellation").catch(()=>{});
    }
    await worker.evaluate("globalThis.__clipboardContinue?.();if(globalThis.__clipboardOriginalValidation)__clipboardBroker.validateScope=__clipboardOriginalValidation;").catch(()=>{});
    await writing;
    await ending?.catch(()=>{});
  }
}

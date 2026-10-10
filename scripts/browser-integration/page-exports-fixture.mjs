import { createHash } from "node:crypto";

export function pageExportFixture(route, port) {
  if (route === "/page-exports/style.css") return { type: "text/css; charset=utf-8", body: "body{font:20px sans-serif;margin:32px;color:#132c4f}h1{color:#165ba8}iframe{width:650px;height:150px;border:2px solid #165ba8}img{display:block;width:280px;height:70px;margin:20px 0}@page{size:A4;margin:15mm}" };
  if (route === "/page-exports/resource.svg") return { type: "image/svg+xml", body: '<svg xmlns="http://www.w3.org/2000/svg" width="280" height="70"><rect width="280" height="70" fill="#dceeff"/><text x="12" y="42" font-size="19" fill="#132c4f">OBU-EXPORT-RESOURCE</text></svg>' };
  if (route === "/page-exports/frame") return { type: "text/html; charset=utf-8", body: '<!doctype html><meta charset="utf-8"><title>Export frame</title><h2>OBU-PDF-FRAME-2026</h2><p>跨域子页面中文内容</p>' };
  return { type: "text/html; charset=utf-8", body: `<!doctype html><meta charset="utf-8"><title>OBU page export fixture</title>
    <link rel="stylesheet" href="/page-exports/style.css"><h1>OBU-PDF-MAIN-2026</h1>
    <p>导出示例：中文可搜索文本</p><img src="/page-exports/resource.svg" alt="Exported resource">
    <iframe id="export-frame" src="http://localhost:${port}/page-exports/frame"></iframe>` };
}

// Artifact checks are separate from the transport response schema. The complete
// PDF render and MIME-part text verification is performed on retained bytes.
export function verifyExportBytes(data, format, assert) {
  assert.ok(data.length > 1000 && data.length <= 16 * 1024 * 1024);
  if (format === "pdf") {
    assert.equal(data.subarray(0, 5).toString(), "%PDF-");
    assert.match(data.subarray(-128).toString(), /%%EOF\s*$/);
  } else {
    const text = data.toString("utf8");
    assert.equal(Buffer.from(text).compare(data), 0, "MHTML was not UTF-8");
    assert.match(text, /^MIME-Version: 1\.0\r?$/m);
    assert.match(text, /Content-Type: multipart\/related/);
    for (const resource of ["/page-exports/style.css", "/page-exports/resource.svg", "/page-exports/frame"])
      assert.ok(text.includes(resource), `MHTML omitted ${resource}`);
    assert.ok((text.match(/Content-Location:/g) ?? []).length >= 4, "MHTML omitted MIME parts");
  }
  return { bytes: data.length, sha256: createHash("sha256").update(data).digest("hex") };
}

export async function preparePageExportTab(browser, fixtureURL, assert) {
  const tab = await browser.newTab({ url: fixtureURL + "page-exports" });
  assert.equal(await tab.frameLocator("#export-frame").getByText("跨域子页面中文内容", { exact: true }).textContent(), "跨域子页面中文内容");
  const ready = await tab.evaluate("document.fonts.ready.then(()=>[...document.images].every(image=>image.complete&&image.naturalWidth>0))", { awaitPromise: true });
  assert.equal(ready, true);
  return tab;
}

export async function checkPageExports({ browser, foreignBrowser, fixtureURL, saveArtifact, saveDetail, assert }) {
  const detail = { mode: "headed-public-export-api", exports: {}, limits: {} };
  try {
    assert.equal((await browser.client.getInfo()).metadata.pageExportVersion, 1);
    const tab = await preparePageExportTab(browser, fixtureURL, assert);
    detail.source = { tabId: tab.id, url: await tab.evaluate("location.href"), frameText: await tab.frameLocator("#export-frame").locator("body").innerText() };
    for (const format of ["pdf", "mhtml"]) {
      const started = performance.now();
      const result = format === "pdf" ? await tab.exportPDF({ pdf: { printBackground: true, preferCSSPageSize: true } }) : await tab.exportMHTML();
      assert.deepEqual(Object.keys(result).sort(), ["byteLength", "data", "encoding", "format", "mimeType"]);
      assert.equal(result.encoding, "base64"); assert.equal(result.format, format);
      assert.equal(result.mimeType, format === "pdf" ? "application/pdf" : "multipart/related");
      const bytes = Buffer.from(result.data, "base64");
      assert.equal(bytes.length, result.byteLength); assert.equal(bytes.toString("base64"), result.data);
      detail.exports[format] = { ...verifyExportBytes(bytes, format, assert), elapsedMs: performance.now() - started,
        artifact: await saveArtifact(`page-export-js.${format}`, bytes) };
      await assert.rejects(tab.exportPage(format, { maxBytes: 64 }), error => {
        detail.limits[format] = error.message; return /OBU_EXPORT_LIMIT/.test(error.message);
      });
    }
    const other = await preparePageExportTab(foreignBrowser, fixtureURL, assert);
    await assert.rejects(foreignBrowser.tab(tab.id).exportPDF(), error => {
      detail.foreignDenied = error.message; return /session|owned|claim|control/i.test(error.message);
    });
    const second = await other.exportMHTML();
    detail.independentSession = { tabId: other.id, ...verifyExportBytes(Buffer.from(second.data, "base64"), "mhtml", assert) };
    const recovered = await tab.exportPDF();
    detail.afterLimits = verifyExportBytes(Buffer.from(recovered.data, "base64"), "pdf", assert);
    return detail;
  } finally { await saveDetail(detail); }
}

// This fault-injection case holds only completion of the real native print
// Promise. Chrome still creates the actual stream; production cleanup must
// close that exact handle without reading or returning it after turn end.
export async function checkPageExportLifecycle({ browser, fixtureURL, worker, assert, until, saveDetail }) {
  const detail = { faultInjection: "hold real Page.printToPDF completion after native stream creation" };
  const tab = await preparePageExportTab(browser, fixtureURL, assert);
  await worker.evaluate(`(()=>{
    const original=chrome.debugger.sendCommand;
    globalThis.__exportLifecycle={original,tabId:${tab.id},trace:[],held:false,release:null,hold:true};
    chrome.debugger.sendCommand=async function(target,method,params){
      const probe=globalThis.__exportLifecycle;
      if(target.tabId!==probe.tabId)return original.call(chrome.debugger,target,method,params);
      if(method==='Page.printToPDF'||method==='IO.read'||method==='IO.close')probe.trace.push({method,handle:params?.handle});
      const result=await original.call(chrome.debugger,target,method,params);
      if(method==='Page.printToPDF'&&probe.hold){probe.hold=false;probe.stream=result.stream;probe.held=true;await new Promise(resolve=>probe.release=resolve);}
      if(method==='IO.close')probe.trace.push({method:'IO.close:done',handle:params.handle});
      return result;
    };
  })()`);
  let outcome, ended = false;
  const pending = tab.exportPDF({ timeoutMs: 10000 }).then(value => outcome = { succeeded: true, bytes: value.byteLength }, error => outcome = { error: error.message });
  let ending;
  try {
    await until(() => worker.evaluate("__exportLifecycle.held"), "real PDF native stream held");
    ending = browser.client.turnEnded().then(value => { ended = true; return value; });
    await until(() => outcome, "turn end rejects held PDF result");
    assert.match(outcome.error, /OBU_EXPORT_CANCELLED|ended|cancel/i);
    assert.equal(ended, false, "turn end acknowledged before the real native result drained");
    await worker.evaluate("__exportLifecycle.release()");
    await ending; await pending;
    detail.trace = await worker.evaluate("({stream:__exportLifecycle.stream,events:__exportLifecycle.trace})");
    assert.equal(detail.trace.events.filter(event => event.method === "IO.read").length, 0);
    assert.deepEqual(detail.trace.events.filter(event => event.method === "IO.close:done").map(event => event.handle), [detail.trace.stream]);
    detail.outcome = outcome; detail.endAcknowledged = ended;
    const next = await tab.exportPDF();
    detail.recovered = verifyExportBytes(Buffer.from(next.data, "base64"), "pdf", assert);
    return detail;
  } finally {
    await worker.evaluate("(()=>{const p=globalThis.__exportLifecycle;p.release?.();chrome.debugger.sendCommand=p.original;delete globalThis.__exportLifecycle})()").catch(()=>{});
    await pending; if(ending) await ending;
    await saveDetail(detail);
  }
}

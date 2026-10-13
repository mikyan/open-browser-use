import assert from "node:assert/strict";
import { verifyExportBytes } from "./page-exports-fixture.mjs";

// The business document is deliberately achromatic. Any blue/green pixels in
// its printed pages belong to the agent's feedback, not to report content.
export function cursorPrintHTML({ strictCSP = false } = {}) {
  return `<!doctype html><meta charset="utf-8"><title>Agent feedback print fixture</title>
  ${strictCSP ? `<meta http-equiv="Content-Security-Policy" content="style-src 'nonce-obu-print-fixture'; script-src 'nonce-obu-print-fixture'; object-src 'none'">` : ""}
  <style nonce="obu-print-fixture">
    @page { size:800px 1000px; margin:0 }
    * { box-sizing:border-box }
    body { margin:0; background:white; color:black; font:20px Arial,sans-serif }
    section { height:900px; padding:64px }
    section+section { break-before:page }
    h1 { font-size:30px } label,input,button,output { display:block; margin:20px 0 }
    input,button { width:360px; height:60px; border:2px solid #333; border-radius:0;
      color:black; background:#eee; font:20px Arial,sans-serif }
    button { appearance:none } output { padding:16px; border:2px solid #333 }
    .chart { width:500px; height:80px; background:#888; border:3px solid black }
  </style>
  <section><h1>Report prepared in the browser</h1>
    <form><label for="author">Report author</label><input id="author" autocomplete="off">
      <button>Prepare report</button></form>
    <output id="receipt">Waiting for preparation</output><div class="chart"></div>
  </section><section><h1>OBU-PRINT-SECOND-PAGE</h1><p>Report appendix remains printable.</p>
    <div class="chart"></div></section>
  <script nonce="obu-print-fixture">
    window.pageStyleBlocked=false;
    ${strictCSP ? `document.addEventListener('securitypolicyviolation',event=>{
      if(event.effectiveDirective==='style-src-elem'&&event.blockedURI==='inline')window.pageStyleBlocked=true;
    });
    const forbiddenStyle=document.createElement('style');
    forbiddenStyle.textContent='body { color:rgb(255,0,0) !important }';
    document.head.append(forbiddenStyle);` : ""}
    window.receiptEvidence=null;
    document.querySelector('form').addEventListener('submit',event=>{
      event.preventDefault();
      window.receiptEvidence={trusted:event.isTrusted,author:document.querySelector('input').value};
      document.querySelector('output').textContent='OBU-PRINT-RECEIPT-2026 '+window.receiptEvidence.author;
    });
  </script>`;
}

const feedbackState = `(()=>{
  const root=document.querySelector('#open-browser-use-cursor-root'),tree=root?.shadowRoot??root;
  const cursor=tree?.querySelector('[data-testid="browser-agent-cursor"]');
  const target=tree?.querySelector('[data-testid="browser-agent-target"]');
  const visible=element=>!!element&&getComputedStyle(element).display!=='none'&&getComputedStyle(element).visibility!=='hidden'&&Number(getComputedStyle(element).opacity)>0;
  return {root:visible(root),cursor:visible(cursor),target:visible(target),
    imageLoaded:!!cursor?.querySelector('img')?.naturalWidth,
    receipt:window.receiptEvidence,activeElement:document.activeElement?.tagName};
})()`;

export async function checkCursorPrint({ browser, fixtureURL, strictCSP = false, saveArtifact, saveDetail, verifyArtifacts }) {
  const detail = { exports: {}, feedback: {}, strictCSP, mode: "public-input-and-public-pdf-export" };
  try {
    const tab = await browser.newTab({ url: fixtureURL + (strictCSP ? "cursor-print-csp" : "cursor-print") });
    detail.tabId = tab.id;
    await tab.getByLabel("Report author").fill("Prepared by browser agent");
    const button = tab.getByRole("button", { name: "Prepare report", exact: true });
    await button.click();
    assert.equal(await tab.locator("#receipt").textContent(), "OBU-PRINT-RECEIPT-2026 Prepared by browser agent");
    await button.hover();
    if (strictCSP) {
      detail.csp = await tab.evaluate("({blocked:window.pageStyleBlocked,color:getComputedStyle(document.body).color})");
      assert.deepEqual(detail.csp, { blocked: true, color: "rgb(0, 0, 0)" });
    }
    // Wait for the existing cursor image, without creating/moving/hiding any
    // feedback or changing its animation/printing behavior in the fixture.
    assert.equal(await tab.evaluate(`(()=>{const root=document.querySelector('#open-browser-use-cursor-root'),tree=root?.shadowRoot??root;return Promise.all([document.fonts.ready,...[...document.images,...(tree?.querySelectorAll('img')??[])].map(image=>image.decode())]).then(()=>true)})()`, { awaitPromise: true }), true);
    const capture = async name => {
      const state = await tab.evaluate(feedbackState);
      detail.feedback[name] = state;
      assert.equal(state.root && state.cursor && state.target && state.imageLoaded, true, JSON.stringify(state));
      assert.deepEqual(state.receipt, { trusted: true, author: "Prepared by browser agent" });
      const shot = await tab.screenshot();
      assert.equal(shot.mimeType, "image/png");
      await saveArtifact(`cursor-print-${name}.png`, Buffer.from(shot.base64, "base64"));
    };
    await capture("before");
    for (const [name, printBackground] of [["background", true], ["default", false]]) {
      const pdf = await tab.exportPDF({ pdf: { preferCSSPageSize: true, printBackground } });
      const bytes = Buffer.from(pdf.data, "base64");
      assert.equal(bytes.length, pdf.byteLength);
      const artifact = `cursor-print-${name}.pdf`;
      detail.exports[name] = { ...verifyExportBytes(bytes, "pdf", assert), artifact };
      await saveArtifact(artifact, bytes);
    }
    // Printing changes viewport geometry, whose existing resize handler clears
    // an obsolete target outline. The cursor itself must survive; a separate
    // subsequent hover must still create normal feedback for the next action.
    detail.feedback.afterPrint = await tab.evaluate(feedbackState);
    assert.equal(detail.feedback.afterPrint.root && detail.feedback.afterPrint.cursor, true);
    await button.hover();
    await capture("after");
    assert.equal(detail.feedback.after.activeElement, detail.feedback.before.activeElement);
    detail.artifacts = await verifyArtifacts();
    return detail;
  } finally { await saveDetail(detail); }
}

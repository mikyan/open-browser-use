export function diagnosticsFixture(child, port) {
  const marker = child ? "child-marker" : "main-marker";
  return `<!doctype html><title>Diagnostics fixture</title><h1>${marker}</h1>
    <button id="emit">Emit diagnostics</button>
    ${child ? "" : `<iframe id="cross" src="http://localhost:${port}/diagnostics/frame"></iframe>`}
    <script>window.done=false;emit.onclick=async()=>{
      console.info('${marker}',{native:true});
      setTimeout(()=>{throw new TypeError('${marker}-error')},0);
      await fetch('/diagnostics/data?${marker}');await fetch('/diagnostics/redirect?${marker}');
      try{await fetch('/diagnostics/fail?${marker}')}catch{}
      window.done=true;
    };</script>`;
}

export async function checkDiagnostics(browser, url, assert, until, { ungroup, connectSuccessor }) {
  const tab = await browser.newTab();
  const initial = await tab.diagnostics();
  await tab.goto(url + "diagnostics");
  await tab.getByRole("button", { name: "Emit diagnostics", exact: true }).click();
  await until(() => tab.evaluate("window.done"), "main diagnostic events");
  await tab.frameLocator("#cross").getByRole("button", { name: "Emit diagnostics", exact: true }).click();
  let captured;
  await until(async () => {
    captured = await tab.diagnostics({ after: initial.cursor, limit: 200 });
    return ["main-marker", "child-marker"].every(marker => captured.entries.some(entry => entry.kind === "requestfailed" && entry.url.includes(marker)));
  }, "main and OOPIF diagnostics");
  for (const marker of ["main-marker", "child-marker"]) {
    assert.ok(captured.entries.some(entry => entry.kind === "console" && entry.text.includes(marker)), marker + " console");
    assert.ok(captured.entries.some(entry => entry.kind === "pageerror" && entry.message.includes(marker)), marker + " pageerror");
    const requests = captured.entries.filter(entry => entry.kind === "request" && entry.url.includes(marker));
    assert.ok(requests.length >= 3);
    assert.ok(requests.some(entry => entry.redirectedFrom), "redirect request identity");
    assert.ok(captured.entries.some(entry => entry.kind === "response" && entry.status === 302 && entry.url.includes(marker)));
    assert.ok(captured.entries.some(entry => entry.kind === "response" && entry.status === 200 && entry.url.includes(marker)));
    assert.ok(captured.entries.some(entry => entry.kind === "requestfailed" && entry.failure && entry.url.includes(marker)));
  }
  assert.ok(captured.entries.every(entry => !["headers", "body", "postData"].some(key => key in entry)));
  const page1 = await tab.diagnostics({ after: initial.cursor, limit: 2 });
  const page2 = await tab.diagnostics({ after: page1.cursor, limit: 2 });
  assert.equal(page1.entries.length, 2); assert.equal(page2.entries.length, 2);
  assert.ok(page2.entries[0].sequence > page1.entries.at(-1).sequence);
  await tab.evaluate("for(let i=0;i<525;i++)console.log('overflow-'+i)");
  const overflow = await tab.diagnostics({ limit: 200 });
  assert.ok(overflow.dropped >= 25); assert.ok(overflow.entries.length <= 200);
  await tab.evaluate("console.log(String.fromCodePoint(0x1f9ea).repeat(10000))");
  let tail = overflow; const entries = [];
  for (let index = 0; index < 4; index++) {
    tail = await tab.diagnostics({ after: tail.cursor, limit: 200 });
    entries.push(...tail.entries);
    if (!tail.entries.length) break;
  }
  const truncated = entries.find(entry => entry.kind === "console" && entry.truncated);
  assert.ok(truncated); assert.ok(Buffer.byteLength(truncated.text) <= 8192);
  await browser.client.turnEnded();
  await assert.rejects(tab.diagnostics({ after: tail.cursor }), /OBU_DIAGNOSTICS_EXPIRED/);
  const next = await tab.diagnostics();
  assert.notEqual(next.captureId, initial.captureId);
  assert.ok(!next.entries.some(entry => entry.text?.includes("marker") || entry.text?.includes("overflow")));
  await tab.evaluate("console.log('prior-owner-only')");
  const prior = await tab.diagnostics();
  await ungroup(tab.id);
  const successor = await connectSuccessor();
  let transferred;
  try {
    await successor.client.claimUserTab(tab.id);
    const transferredTab = successor.tab(tab.id);
    transferred = await transferredTab.diagnostics();
    assert.notEqual(transferred.captureId, prior.captureId);
    assert.ok(!transferred.entries.some(entry => entry.text?.includes("prior-owner")));
    await assert.rejects(transferredTab.diagnostics({ after: prior.cursor }), /OBU_DIAGNOSTICS_EXPIRED/);
    await assert.rejects(tab.diagnostics(), /session|owned|control|group/i);
  } finally {
    try { await successor.client.finalizeTabs([]); } finally { successor.close(); }
  }
  return { captured, dropped: overflow.dropped, truncatedBytes: Buffer.byteLength(truncated.text), newCaptureId: next.captureId, transferredCaptureId: transferred.captureId };
}

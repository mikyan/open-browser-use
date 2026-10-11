export function diagnosticsFixture(child, port) {
  const marker = child ? "child-marker" : "main-marker";
  return `<!doctype html><title>Diagnostics fixture</title><h1>${marker}</h1>
    <button id="emit">Emit diagnostics</button>
    <button id="fresh">Emit fresh diagnostics</button>
    ${child ? "" : `<iframe id="cross" src="http://localhost:${port}/diagnostics/frame"></iframe>`}
    <script>window.done=false;fresh.onclick=()=>{console.info('${child ? "current-child-only" : "current-owner-only"}');setTimeout(()=>{throw new TypeError('${child ? "current-child-only" : "current-owner-only"}-error')},0)};emit.onclick=async()=>{
      console.info('${marker}',{native:true});
      setTimeout(()=>{throw new TypeError('${marker}-error')},0);
      await fetch('/diagnostics/data?${marker}');await fetch('/diagnostics/redirect?${marker}');
      try{await fetch('/diagnostics/fail?${marker}')}catch{}
      window.done=true;
    };</script>`;
}

export async function checkDiagnostics(browser, url, assert, until, { ungroup, connectSuccessor, worker, saveDetail = async () => {} }) {
  const evidence = {};
  const tab = await browser.newTab();
  await worker.evaluate(`(() => {
    if(globalThis.__diagnosticsEvidence)throw new Error('Diagnostics observer already installed');
    const p=globalThis.__diagnosticsEvidence={tabId:${tab.id},phase:'initial',events:[],overflow:false,phases:[]};
    p.listener=(target,method,params)=>{
      if(target.tabId!==p.tabId || !['Runtime.consoleAPICalled','Runtime.exceptionThrown','Log.entryAdded'].includes(method))return;
      const text=(method==='Runtime.consoleAPICalled' ? (params.args??[]).filter(x=>typeof x.value==='string').map(x=>x.value).join(' ') : method==='Runtime.exceptionThrown' ? params.exceptionDetails?.exception?.description??params.exceptionDetails?.text??'' : params.entry?.text??'').slice(0,160);
      if(!/marker|overflow|owner-only|child-only|successor-only/.test(text))return;
      if(p.events.length>=4096){p.overflow=true;return;}
      p.events.push({phase:p.phase,method,receivedAt:performance.timeOrigin+performance.now(),timestamp:params.timestamp??params.entry?.timestamp,
        executionContextId:params.executionContextId,target:{...target},text});
    };
    chrome.debugger.onEvent.addListener(p.listener);
  })()`);
  const readNative = () => worker.evaluate("(() => {const p=globalThis.__diagnosticsEvidence;return {tabId:p.tabId,events:p.events,phases:p.phases,overflow:p.overflow}})()");
  const phase = name => worker.evaluate(`(() => {const p=globalThis.__diagnosticsEvidence;p.phase=${JSON.stringify(name)};p.phases.push({name:p.phase,at:performance.timeOrigin+performance.now()})})()`);
  try {
  const initial = await tab.diagnostics();
  evidence.initial = initial;
  await tab.goto(url + "diagnostics");
  await tab.getByRole("button", { name: "Emit diagnostics", exact: true }).click();
  await until(() => tab.evaluate("window.done"), "main diagnostic events");
  await tab.frameLocator("#cross").getByRole("button", { name: "Emit diagnostics", exact: true }).click();
  let captured;
  await until(async () => {
    captured = await tab.diagnostics({ after: initial.cursor, limit: 200 });
    return ["main-marker", "child-marker"].every(marker => captured.entries.some(entry => entry.kind === "requestfailed" && entry.url.includes(marker)));
  }, "main and OOPIF diagnostics");
  evidence.captured = captured; await saveDetail(evidence);
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
  evidence.overflow = overflow; await saveDetail(evidence);
  assert.ok(overflow.dropped >= 25); assert.ok(overflow.entries.length <= 200);
  await tab.evaluate("console.log(String.fromCodePoint(0x1f9ea).repeat(10000))");
  let tail = overflow; const entries = [];
  for (let index = 0; index < 4; index++) {
    tail = await tab.diagnostics({ after: tail.cursor, limit: 200 });
    entries.push(...tail.entries);
    if (!tail.entries.length) break;
  }
  const truncated = entries.find(entry => entry.kind === "console" && entry.truncated);
  evidence.tail = tail; evidence.truncated = truncated; await saveDetail(evidence);
  assert.ok(truncated); assert.ok(Buffer.byteLength(truncated.text) <= 8192);
  await browser.client.turnEnded();
  await phase("renewed");
  await assert.rejects(tab.diagnostics({ after: tail.cursor }), /OBU_DIAGNOSTICS_EXPIRED/);
  // Runtime.enable really replays retained native messages. Observe both
  // original targets before checking the new capture, so an early empty
  // snapshot alone cannot make the isolation assertion pass.
  await until(async () => {
    const replay = (await readNative()).events.filter(event => event.phase === "renewed");
    return replay.some(event => event.text.startsWith("overflow-")) && replay.some(event => event.text === "child-marker");
  }, "actual root and OOPIF console replay after reattachment");
  await tab.getByRole("button", { name: "Emit fresh diagnostics", exact: true }).click();
  await tab.frameLocator("#cross").getByRole("button", { name: "Emit fresh diagnostics", exact: true }).click();
  let next;
  await until(async () => {
    next = await tab.diagnostics({ limit: 200 });
    return ["current-owner-only", "current-child-only"].every(marker => next.entries.some(entry => entry.kind === "console" && entry.text === marker) && next.entries.some(entry => entry.kind === "pageerror" && entry.message.includes(marker + "-error")));
  }, "current root and OOPIF console events after reattachment");
  evidence.next = next; await saveDetail(evidence);
  assert.notEqual(next.captureId, initial.captureId);
  assert.ok(!next.entries.some(entry => /marker|overflow/.test(entry.text ?? entry.message ?? "")));
  await tab.evaluate("console.log('prior-owner-only')");
  const prior = await tab.diagnostics();
  evidence.prior = prior; await saveDetail(evidence);
  await ungroup(tab.id);
  await phase("transferred");
  const successor = await connectSuccessor();
  let transferred;
  try {
    await successor.client.claimUserTab(tab.id);
    const transferredTab = successor.tab(tab.id);
    transferred = await transferredTab.diagnostics();
    await until(async () => (await readNative()).events.some(event => event.phase === "transferred" && event.text === "prior-owner-only"), "actual prior-owner native console replay");
    await transferredTab.evaluate("console.info('successor-only');setTimeout(()=>{throw new TypeError('successor-only-error')},0)");
    await until(async () => { transferred = await transferredTab.diagnostics({ limit: 200 }); return transferred.entries.some(entry => entry.text === "successor-only") && transferred.entries.some(entry => entry.kind === "pageerror" && entry.message.includes("successor-only-error")); }, "current successor console and error events");
    evidence.transferred = transferred; await saveDetail(evidence);
    assert.notEqual(transferred.captureId, prior.captureId);
    assert.ok(!transferred.entries.some(entry => /prior-owner|current-owner|current-child|marker|overflow/.test(entry.text ?? entry.message ?? "")));
    await assert.rejects(transferredTab.diagnostics({ after: prior.cursor }), /OBU_DIAGNOSTICS_EXPIRED/);
    await assert.rejects(tab.diagnostics(), /session|owned|control|group/i);
  } finally {
    try { await successor.client.finalizeTabs([]); } finally { successor.close(); }
  }
  evidence.native = await readNative(); assert.equal(evidence.native.overflow, false);
  for (const name of ["renewed", "transferred"]) {
    const since = evidence.native.phases.find(value => value.name === name).at;
    const replay = evidence.native.events.filter(event => event.phase === name && (name === "renewed" ? /^(overflow-|child-marker$)/.test(event.text) : event.text === "prior-owner-only"));
    assert.ok(replay.length > 0 && replay.every(event => Number.isFinite(event.timestamp) && event.timestamp < since), "Native replay timestamps must precede the new attachment");
  }
  return { captured, dropped: overflow.dropped, truncatedBytes: Buffer.byteLength(truncated.text), newCaptureId: next.captureId, transferredCaptureId: transferred.captureId, native: evidence.native };
  } finally {
    try { evidence.native = await readNative(); await saveDetail(evidence); }
    finally { await worker.evaluate("(() => {const p=globalThis.__diagnosticsEvidence;if(p){chrome.debugger.onEvent.removeListener(p.listener);delete globalThis.__diagnosticsEvidence}})()"); }
  }
}

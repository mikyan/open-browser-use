export function actionsFixture(route, visit) {
  return `<!doctype html><title>Input and history fixture</title>
  <style>body{font:16px sans-serif;margin:20px}#source,#drop,#pointer{width:150px;height:80px;margin:20px;border:2px solid black;display:inline-block}#bottom{margin-top:2500px}</style>
  <h1>${route}</h1><output id="visit">${visit}</output>
  <label>Type here<input id="field"></label>
  <div id="source" draggable="true">Source</div><div id="drop">Drop</div><output id="result"></output>
  <div id="pointer">Pointer drag</div><output id="pointer-result"></output><button id="bottom">Bottom</button>
  <script>
    window.events=[];
    for(const type of ['dragstart','dragenter','dragover','drop','dragend','pointerdown','pointerup','pointermove','click','keydown','keyup','input','focusin'])
      document.addEventListener(type,event=>events.push({type,id:event.target.id,key:event.key,value:event.target.value,buttons:event.buttons,trusted:event.isTrusted}));
    source.ondragstart=event=>event.dataTransfer.setData('text/plain','real drag');
    drop.ondragover=event=>event.preventDefault();
    drop.ondrop=event=>{event.preventDefault();document.querySelector('#result').textContent=event.dataTransfer.getData('text/plain')};
    pointer.onpointerdown=event=>{pointer.setPointerCapture(event.pointerId);pointer.dataset.dragging='yes'};
    pointer.onpointermove=event=>{if(event.buttons)document.querySelector('#pointer-result').textContent=event.clientX+','+event.clientY};
    pointer.onpointerup=()=>pointer.dataset.dragging='no';
  </script>`;
}

export async function checkExtendedActions(browser, url, assert) {
  const checks = [];
  const tab = await browser.newTab({ url: url + "actions/a" });
  await tab.goto(url + "actions/b");
  assert.equal((await tab.goBack()).url, url + "actions/a");
  assert.equal(await tab.locator("h1").textContent(), "/actions/a");
  assert.equal((await tab.goForward()).url, url + "actions/b");
  const visit = await tab.locator("#visit").textContent();
  await tab.reload();
  assert.notEqual(await tab.locator("#visit").textContent(), visit);
  checks.push("history-and-reload");

  await tab.getByLabel("Type here").focus();
  assert.equal(await tab.evaluate("document.activeElement.id"), "field");
  await tab.getByLabel("Type here").pressSequentially("Ab1", { delay: 3 });
  assert.equal(await tab.getByLabel("Type here").inputValue(), "Ab1");
  const keys = await tab.evaluate("events.filter(e=>e.id==='field'&&['keydown','keyup','input'].includes(e.type))");
  assert.equal(keys.filter(event => event.type === "keydown").length, 3);
  assert.ok(keys.every(event => event.trusted));
  checks.push("focus-and-trusted-key-sequence");

  await tab.locator("#bottom").scrollIntoViewIfNeeded();
  assert.ok(await tab.evaluate("document.querySelector('#bottom').getBoundingClientRect().bottom<=innerHeight"));
  await tab.locator("#source").scrollIntoViewIfNeeded();
  await tab.locator("#source").dragTo(tab.locator("#drop"));
  assert.equal(await tab.locator("#result").textContent(), "real drag");
  const drags = await tab.evaluate("events.filter(e=>e.type.startsWith('drag')||e.type==='drop')");
  assert.ok(drags.some(event => event.type === "drop" && event.id === "drop" && event.trusted));
  assert.ok(drags.every(event => event.trusted));
  checks.push("scroll-and-trusted-html-drop");

  const box = await tab.locator("#pointer").boundingBox();
  await tab.mouse.move(box.x + 10, box.y + 10);
  await tab.mouse.down();
  await tab.mouse.move(box.x + 65, box.y + 50, { steps: 4 });
  await tab.mouse.up();
  assert.equal(await tab.evaluate("pointer.dataset.dragging"), "no");
  assert.notEqual(await tab.locator("#pointer-result").textContent(), "");
  checks.push("manual-pointer-drag");

  await tab.evaluate("events=[]");
  await assert.rejects(tab.locator("#source").dragTo(tab.locator("#missing-target"), { timeoutMs: 1000 }), /timed out|Timeout/);
  assert.ok(!(await tab.evaluate("events")).some(event => event.type === "pointerdown"), "Drag pressed before resolving its target");
  await tab.evaluate("events=[];source.addEventListener('pointerdown',()=>{drop.style.display='none'},{once:true})");
  // The original destination disappears after the one committed press. This
  // is terminal: the new drag contract neither waits to retarget nor replays.
  await assert.rejects(tab.locator("#source").dragTo(tab.locator("#drop"), { timeoutMs: 1000 }), /OBU_POINTER_DELIVERY_UNCONFIRMED: original drag destination was lost/);
  const cancelled = await tab.evaluate("events");
  const committed = cancelled.filter(event => event.type === "pointerdown");
  assert.equal(committed.length, 1, JSON.stringify(cancelled));
  assert.equal(committed[0].id, "source");
  assert.equal(committed[0].trusted, true);
  assert.ok(!cancelled.some(event => event.type === "drop"), JSON.stringify(cancelled));
  // Browser input is not transactional: releasing an already delivered down
  // can produce a trusted click. Record it; never hide it or replay the drag.
  await tab.mouse.move(box.x + 10, box.y + 10);
  const lastMove = (await tab.evaluate("events.filter(e=>e.type==='pointermove')")).at(-1);
  assert.ok(lastMove?.trusted && lastMove.buttons === 0, JSON.stringify(lastMove));
  checks.push("drag-failure-releases-buttons-without-replay-and-raw-cdp-recovers");

  await tab.mouse.move(box.x + 10, box.y + 10);
  await tab.mouse.down();
  await browser.client.turnEnded();
  assert.equal(await tab.evaluate("pointer.dataset.dragging"), "no");
  await tab.mouse.move(box.x + 65, box.y + 50);
  const afterEnd = (await tab.evaluate("events.filter(e=>e.type==='pointermove')")).at(-1);
  assert.ok(afterEnd?.trusted && afterEnd.buttons === 0, JSON.stringify(afterEnd));
  checks.push("turn-end-releases-held-pointer");
  return { checks, keys, drags, cancelled };
}

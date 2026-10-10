import assert from "node:assert/strict";
import utilsBundle from "playwright-core/lib/utilsBundle";

const { yaml } = utilsBundle;

const labels = {
  root: "AI root action", shadow: "AI shadow action", same: "AI same frame action",
  cross: "AI cross frame action", nested: "AI nested frame action", inserted: "AI inserted frame action"
};
const forgedRef = "e987654321";
const fallbackText = "AI iframe fallback text";
const head = '<!doctype html><meta charset="utf-8"><style>body{margin:12px;font:16px sans-serif}button{box-sizing:border-box;width:240px;height:48px}iframe{display:block;width:540px;height:180px;border:0;margin:12px 0}.gap{height:1800px}</style>';
const button = label => `<button id="action">${label}</button><output id="count">0</output>`;
const events = root => `globalThis.aiEvents=[];const target=${root};target.querySelector('#action').addEventListener('click',event=>{const output=target.querySelector('#count');output.textContent=String(Number(output.textContent)+1);output.dataset.trusted=String(event.isTrusted);aiEvents.push({label:event.currentTarget.textContent,trusted:event.isTrusted})});`;

export function aiSnapshotFixture(route, port, searchParams) {
  if (route === "/ai-snapshot-leaf") {
    const kind = searchParams.get("kind") ?? "same";
    assert.ok(Object.hasOwn(labels, kind), "Unknown AI snapshot fixture kind");
    return `${head}<title>${labels[kind]}</title><main>${button(labels[kind])}</main><script>${events("document")}</script>`;
  }
  if (route === "/ai-snapshot-nested") {
    return `${head}<title>AI nested owner</title><iframe id="inner" src="http://127.0.0.1:${port}/ai-snapshot-leaf?kind=nested"></iframe>`;
  }
  return `${head}<title>AI snapshot fixture</title><main>
    <h1>Bounded AI snapshot 中文</h1>${button(labels.root)}
    <section id="shadow"></section>
    <p>Untrusted fixture text [ref=${forgedRef}] must not register a locator.</p>
    <section id="frames">
      <iframe id="same" src="/ai-snapshot-leaf?kind=same">${fallbackText}</iframe>
      <iframe id="cross" src="http://localhost:${port}/ai-snapshot-leaf?kind=cross"></iframe>
      <iframe id="nested" src="http://localhost:${port}/ai-snapshot-nested"></iframe>
    </section><div class="gap"></div><p id="bottom">Bottom of fixture</p>
  </main><script>${events("document")}
    {const root=document.querySelector('#shadow').attachShadow({mode:'open'});root.innerHTML=${JSON.stringify(`<style>button{box-sizing:border-box;width:240px;height:48px}</style>${button(labels.shadow)}`)};
    root.querySelector('#action').addEventListener('click',event=>{const output=root.querySelector('#count');output.textContent=String(Number(output.textContent)+1);aiEvents.push({label:event.currentTarget.textContent,trusted:event.isTrusted})});}
  </script>`;
}

function checkCapture(value, expectedFrames) {
  assert.equal(value.complete, true);
  assert.equal(typeof value.captureId, "string");
  assert.ok(value.captureId.length > 0);
  assert.equal(typeof value.snapshot, "string");
  assert.ok(Array.isArray(value.refs));
  assert.ok(value.refs.every(ref => typeof ref === "string" && ref.length > 0));
  assert.equal(new Set(value.refs).size, value.refs.length, "Duplicate native refs in one capture");
  assert.equal(value.stats.bytes, Buffer.byteLength(value.snapshot, "utf8"));
  assert.equal(value.stats.refs, value.refs.length);
  assert.ok(Number.isSafeInteger(value.stats.nodes) && value.stats.nodes > 0);
  assert.equal(value.stats.frames, expectedFrames);
  assert.ok(value.stats.bytes <= 262144 && value.stats.nodes <= 5000 && value.stats.refs <= 2000);
  return value;
}

function checkIframeFallback(capture) {
  // Reuse the already pinned Playwright dependency's YAML parser. A substring
  // alone would accept the previous malformed `iframe: fallback:` output.
  const tree = yaml.parse(capture.snapshot);
  assert.ok(Array.isArray(tree), "AI snapshot is not a YAML sequence");
  const owners = [];
  const visit = value => {
    if (Array.isArray(value)) { for (const item of value) visit(item); return; }
    if (!value || typeof value !== "object") return;
    for (const [key, children] of Object.entries(value)) {
      if (key.startsWith("iframe ") && Array.isArray(children) && children.some(child => child?.text === fallbackText)) owners.push(children);
      visit(children);
    }
  };
  visit(tree);
  assert.equal(owners.length, 1, "Fallback text must be a child of its iframe's YAML collection");
  const hasButton = value => typeof value === "string" ? value.includes(`button "${labels.same}"`) :
    Array.isArray(value) ? value.some(hasButton) : value && typeof value === "object" &&
      Object.entries(value).some(([key, child]) => key.includes(`button "${labels.same}"`) || hasButton(child));
  assert.ok(hasButton(owners[0]), "The fallback iframe lost its recursively captured child button");
}

// This parser selects only the known unique button line in this fixed local
// fixture. Production authorization must use renderer-provided refs, never
// a regex over potentially hostile snapshot text.
export function fixtureRef(capture, label) {
  const lines = capture.snapshot.split("\n").filter(line => line.includes(`button "${label}"`));
  assert.equal(lines.length, 1, `Expected one fixture button line for ${label}`);
  const matches = [...lines[0].matchAll(/\[ref=([^\]]+)\]/g)];
  assert.equal(matches.length, 1, `Expected one generated ref on fixture line: ${lines[0]}`);
  const ref = matches[0][1];
  assert.ok(capture.refs.includes(ref), `Fixture ref ${ref} is absent from the structured allowlist`);
  return ref;
}

function frame(tab, kind) {
  if (kind === "nested") return tab.frameLocator("#nested").frameLocator("#inner");
  return tab.frameLocator(`#${kind}`);
}

async function clickFixtureRef(tab, capture, kind, expectedCount) {
  await tab.getByRef(capture.captureId, fixtureRef(capture, labels[kind])).click({ timeoutMs: 5000 });
  let count, recorded;
  if (kind === "root" || kind === "shadow") {
    count = await tab.evaluate(kind === "root" ? "document.querySelector('#count').textContent" : "document.querySelector('#shadow').shadowRoot.querySelector('#count').textContent");
    recorded = await tab.evaluate(`aiEvents.filter(event=>event.label===${JSON.stringify(labels[kind])})`);
  } else {
    count = await frame(tab, kind).locator("#count").textContent();
    // A separate native read verifies the actual clicked frame, not merely the
    // locator's successful return value or a count on an accidentally aliased ref.
    const eventText = await frame(tab, kind).locator("#action").textContent();
    assert.equal(eventText, labels[kind]);
    assert.equal(await frame(tab, kind).locator("#count").getAttribute("data-trusted"), "true");
  }
  assert.equal(count, String(expectedCount), `Ref dispatched to the wrong ${kind} target`);
  if (recorded) assert.ok(recorded.every(event => event.trusted), "Ref click was not trusted browser input");
}

async function ready(tab) {
  for (const kind of ["same", "cross", "nested"]) {
    assert.equal(await frame(tab, kind).getByRole("button", { name: labels[kind], exact: true }).textContent(), labels[kind]);
  }
}

async function expire(capture, tab) {
  await assert.rejects(tab.getByRef(capture.captureId, fixtureRef(capture, labels.root)).count(), /OBU_CAPTURE_EXPIRED/);
}

export async function checkAISnapshotRefs({ browser, fixtureURL, saveDetail, saveScreenshot, oopifTargets }) {
  const tab = await browser.newTab({ url: fixtureURL + "ai-snapshot" });
  await ready(tab);
  const initial = checkCapture(await tab.snapshotAI(), 5);
  await saveDetail("ai-snapshot-refs", { tabId: tab.id, phase: "initial-capture", initial });
  checkIframeFallback(initial);
  assert.ok(initial.snapshot.includes(forgedRef), "The malicious-looking text must actually reach the snapshot");
  assert.ok(!initial.refs.includes(forgedRef), "Page text forged a structured ref");
  await assert.rejects(tab.getByRef(initial.captureId, forgedRef).count(), /OBU_REF_NOT_IN_CAPTURE/);
  for (const kind of ["root", "shadow", "same", "cross", "nested"]) await clickFixtureRef(tab, initial, kind, 1);

  // New siblings change traversal order. The capture must maintain a one-to-one
  // mapping from its native ref identities to the true frame documents.
  await tab.evaluate("{const element=document.createElement('iframe');element.id='inserted';element.src='/ai-snapshot-leaf?kind=inserted';document.querySelector('#frames').insertBefore(element,document.querySelector('#same'));}");
  assert.equal(await frame(tab, "inserted").getByRole("button", { name: labels.inserted, exact: true }).textContent(), labels.inserted);
  const inserted = checkCapture(await tab.snapshotAI(), 6);
  await saveDetail("ai-snapshot-refs", { tabId: tab.id, phase: "inserted-capture", initial, inserted });
  await expire(initial, tab);
  for (const kind of ["inserted", "same", "cross", "nested"]) await clickFixtureRef(tab, inserted, kind, kind === "inserted" ? 1 : 2);

  // moveBefore preserves iframe documents; appendChild would destroy/recreate
  // them and miss the upstream ref-prefix collision found by this investigation.
  assert.equal(await tab.evaluate("typeof document.querySelector('#frames').moveBefore"), "function", "This browser cannot run the state-preserving iframe reorder acceptance case");
  await tab.evaluate("document.querySelector('#frames').moveBefore(document.querySelector('#cross'),document.querySelector('#inserted'))");
  const reordered = checkCapture(await tab.snapshotAI(), 6);
  await saveDetail("ai-snapshot-refs", { tabId: tab.id, phase: "reordered-capture", initial, inserted, reordered });
  await expire(inserted, tab);
  for (const kind of ["cross", "inserted", "same", "nested"]) await clickFixtureRef(tab, reordered, kind, kind === "inserted" ? 2 : 3);

  let latest = reordered;
  const repeated = [], churn = [];
  for (let index = 0; index < 20; index++) {
    latest = checkCapture(await tab.snapshotAI({ maxFrames: 6 }), 6);
    assert.equal(await tab.getByRef(latest.captureId, fixtureRef(latest, labels.cross)).textContent(), labels.cross);
    repeated.push({ captureId: latest.captureId, stats: latest.stats });
  }
  assert.equal(new Set(repeated.map(capture => capture.captureId)).size, 20);
  for (let index = 0; index < 8; index++) {
    await tab.evaluate(`{document.querySelector('#inserted').remove();const element=document.createElement('iframe');element.id='inserted';element.src='/ai-snapshot-leaf?kind=inserted&churn=${index}';document.querySelector('#frames').insertBefore(element,document.querySelector('#same'));}`);
    assert.equal(await frame(tab, "inserted").getByRole("button", { name: labels.inserted, exact: true }).textContent(), labels.inserted);
    // Only six live frames exist. Repeated replacement must not exhaust an
    // internal prefix/slot budget; the assertion uses the public cap alone.
    latest = checkCapture(await tab.snapshotAI({ maxFrames: 6 }), 6);
    for (const kind of ["root", "shadow", "same", "cross", "nested", "inserted"]) {
      assert.equal(await tab.getByRef(latest.captureId, fixtureRef(latest, labels[kind])).textContent(), labels[kind]);
    }
    await clickFixtureRef(tab, latest, "inserted", 1);
    churn.push({ captureId: latest.captureId, stats: latest.stats });
  }
  await saveDetail("ai-snapshot-refs", { tabId: tab.id, phase: "repeated-and-churned", initial, inserted, reordered, repeated, churn, latest });

  // Ref screenshots must resolve the real owner frame for ancestor scrolling.
  await tab.evaluate("window.scrollTo(0,document.documentElement.scrollHeight)");
  const screenshotDetails = [];
  const captureElement = async (name, locator) => {
    const png = await locator.screenshot({ timeoutMs: 10000 });
    const bytes = Buffer.from(png.base64, "base64");
    // Preserve the actual output even when a later dimension assertion fails.
    await saveScreenshot(name, bytes);
    assert.equal(png.mimeType, "image/png");
    assert.deepEqual(bytes.subarray(0, 8), Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
    const box = await locator.boundingBox();
    const viewport = await tab.evaluate("({dpr:devicePixelRatio,scrollX,scrollY})");
    const x = box.x + viewport.scrollX, y = box.y + viewport.scrollY;
    // Playwright 1.53 screenshotElement encloses the document rect in integer
    // CSS pixels before capture. Fractional iframe origins can add a CSS pixel
    // even when the button itself is exactly 240x48. Match that native clip,
    // rather than assuming round(elementSize * dpr) is the resulting PNG size.
    const clip = { x: Math.floor(x + 1e-3), y: Math.floor(y + 1e-3),
      width: Math.ceil(x + box.width - 1e-3) - Math.floor(x + 1e-3),
      height: Math.ceil(y + box.height - 1e-3) - Math.floor(y + 1e-3) };
    const detail = { name, box, viewport, clip, width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) };
    screenshotDetails.push(detail);
    await saveDetail("ai-snapshot-screenshot", { tabId: tab.id, captures: screenshotDetails });
    assert.equal(box.width, 240); assert.equal(box.height, 48);
    assert.equal(detail.width, Math.round(clip.width * viewport.dpr));
    assert.equal(detail.height, Math.round(clip.height * viewport.dpr));
    return detail;
  };
  await captureElement("ai-ref-nested-offscreen", tab.getByRef(latest.captureId, fixtureRef(latest, labels.nested)));
  // Public ordinary locator to the same real element is the control case for
  // ref resolution, owner scrolling and native screenshot clipping semantics.
  await captureElement("ai-semantic-nested-control", frame(tab, "nested").getByRole("button", { name: labels.nested, exact: true }));
  const targets = await oopifTargets();
  assert.ok(targets.some(target => target.tabId === tab.id && target.type === "iframe"), "No real OOPIF observed for AI refs");
  const detail = { tabId: tab.id, initial, inserted, reordered, repeated, churn, latest, screenshots: screenshotDetails };
  await saveDetail("ai-snapshot-refs", detail);
  return detail;
}

export async function checkAISnapshotLifecycle({ browser, fixtureURL, saveDetail, ungroup, connectSuccessor }) {
  const tab = await browser.newTab({ url: fixtureURL + "ai-snapshot" });
  await ready(tab);
  const details = [];
  let capture = checkCapture(await tab.snapshotAI(), 5);
  const nativeRef = fixtureRef(capture, labels.root);
  const unscoped = [
    tab.locator(`aria-ref=${nativeRef}`),
    tab.locator(`body >> aria-ref=${nativeRef}`),
    tab.locator(`body >> internal:has=${JSON.stringify(`aria-ref=${nativeRef}`)}`),
    tab.frameLocator(`aria-ref=${nativeRef}`).locator("button"),
    tab.frameLocator("#same").locator(`aria-ref=${nativeRef}`)
  ];
  for (const locator of unscoped) await assert.rejects(locator.count(), /OBU_REF_SELECTOR_REQUIRES_CAPTURE/);
  await tab.evaluate("document.querySelector('#action').setAttribute('data-ai-literal','aria-ref=e1')");
  assert.equal(await tab.locator('[data-ai-literal="aria-ref=e1"]').count(), 1,
    "A normal CSS attribute value must not be treated as a native ref selector");
  details.push("unscoped-native-ref-selectors-rejected-and-css-literal-preserved");
  const replacement = checkCapture(await tab.snapshotAI(), 5);
  assert.notEqual(capture.captureId, replacement.captureId);
  await expire(capture, tab); details.push("new-capture");
  await tab.getByRole("button", { name: labels.root, exact: true }).ariaSnapshot();
  await expire(replacement, tab); details.push("ordinary-aria-snapshot");

  capture = checkCapture(await tab.snapshotAI(), 5);
  await tab.evaluate("document.querySelector('#cross').src='/ai-snapshot-leaf?kind=cross&navigated=1'");
  assert.equal(await frame(tab, "cross").getByRole("button", { name: labels.cross, exact: true }).textContent(), labels.cross);
  await expire(capture, tab); details.push("child-navigation");

  capture = checkCapture(await tab.snapshotAI(), 5);
  await tab.evaluate("{const old=document.querySelector('#cross');const replacement=old.cloneNode();replacement.src='/ai-snapshot-leaf?kind=cross&replacement=1';old.replaceWith(replacement)}");
  assert.equal(await frame(tab, "cross").getByRole("button", { name: labels.cross, exact: true }).textContent(), labels.cross);
  await expire(capture, tab); details.push("iframe-owner-replacement");

  capture = checkCapture(await tab.snapshotAI(), 5);
  await tab.goto(fixtureURL + "ai-snapshot?navigated=1");
  await expire(capture, tab); details.push("root-navigation");
  await ready(tab);

  // ARIA/name changes must not retarget the ref. Replacement at the same DOM
  // position is a different Element and cannot inherit the old capture's ref.
  await tab.evaluate("{const element=document.createElement('button');element.id='mutable';element.textContent='AI mutable node';element.onclick=event=>{element.dataset.clicked=String(event.isTrusted)};document.body.appendChild(element)}");
  const mutableCapture = checkCapture(await tab.snapshotAI(), 5);
  const mutable = tab.getByRef(mutableCapture.captureId, fixtureRef(mutableCapture, "AI mutable node"));
  await tab.evaluate("document.querySelector('#mutable').textContent='AI renamed node'");
  assert.equal(await mutable.textContent(), "AI renamed node");
  await mutable.click();
  assert.equal(await tab.locator("#mutable").getAttribute("data-clicked"), "true");
  await tab.evaluate("document.querySelector('#mutable').remove()");
  assert.equal(await mutable.count(), 0, "A removed Element remained queryable by ref");
  await tab.evaluate("{const element=document.createElement('button');element.id='mutable';element.textContent='AI replacement node';element.onclick=event=>{element.dataset.clicked=String(event.isTrusted)};document.body.appendChild(element)}");
  assert.equal(await mutable.count(), 0, "A replacement Element inherited an old native ref");
  const mutableReplacement = checkCapture(await tab.snapshotAI(), 5);
  const newMutable = tab.getByRef(mutableReplacement.captureId, fixtureRef(mutableReplacement, "AI replacement node"));
  assert.equal(await newMutable.textContent(), "AI replacement node");
  await newMutable.click();
  assert.equal(await tab.locator("#mutable").getAttribute("data-clicked"), "true");
  await assert.rejects(mutable.count(), /OBU_CAPTURE_EXPIRED/);
  details.push("ref-node-rename-and-replacement-identity");
  assert.match(await newMutable.ariaSnapshot(), /button "AI replacement node"/);
  await assert.rejects(newMutable.count(), /OBU_CAPTURE_EXPIRED/);
  details.push("ref-scoped-aria-snapshot-expires-capture");

  capture = checkCapture(await tab.snapshotAI(), 5);
  await browser.client.turnEnded();
  await expire(capture, tab); details.push("turn-ended");
  capture = checkCapture(await tab.snapshotAI(), 5);

  await ungroup(tab.id);
  const successor = await connectSuccessor();
  try {
    await successor.client.claimUserTab(tab.id);
    const next = successor.tab(tab.id);
    await next.domSnapshot(); // Force normal backend ownership/attachment transfer.
    await assert.rejects(next.getByRef(capture.captureId, fixtureRef(capture, labels.root)).count(), /OBU_CAPTURE_EXPIRED/);
    await assert.rejects(tab.getByRef(capture.captureId, fixtureRef(capture, labels.root)).count(), /session|owned|control|group/i);
    const successorCapture = checkCapture(await next.snapshotAI(), 5);
    await clickFixtureRef(next, successorCapture, "root", 1);
    details.push("foreign-owner-transfer");
  } finally { try { await successor.client.finalizeTabs([]); } finally { successor.close(); } }
  await saveDetail("ai-snapshot-lifecycle", { tabId: tab.id, expiredBy: details });
  return { tabId: tab.id, expiredBy: details };
}

export async function checkAISnapshotLimits({ browser, fixtureURL, saveDetail }) {
  const tab = await browser.newTab({ url: fixtureURL + "ai-snapshot" });
  await ready(tab);
  const limits = ["maxBytes", "maxNodes", "maxRefs", "maxFrames", "maxDepth"];
  for (const field of limits) await assert.rejects(tab.snapshotAI({ [field]: 1, timeoutMs: 3000 }), /OBU_SNAPSHOT_LIMIT/, field);
  checkCapture(await tab.snapshotAI(), 5);

  // A missing child body must not become a successful partial capture.
  await tab.evaluate("document.querySelector('#same').contentDocument.body.remove()");
  const childStart = Date.now();
  await assert.rejects(tab.snapshotAI({ timeoutMs: 600 }), /OBU_SNAPSHOT_INCOMPLETE|timed out|timeout/i);
  const incompleteMs = Date.now() - childStart;
  assert.ok(incompleteMs < 3000, "Child capture failure exceeded its bounded deadline");

  const empty = await browser.newTab({ url: fixtureURL + "ai-snapshot-leaf?kind=root" });
  await empty.evaluate("document.body.remove()");
  const timeoutStart = Date.now();
  await assert.rejects(empty.snapshotAI({ timeoutMs: 600 }), /OBU_SNAPSHOT_INCOMPLETE|timed out|timeout/i);
  const timeoutMs = Date.now() - timeoutStart;
  assert.ok(timeoutMs < 3000, "No-body snapshot exceeded its bounded deadline");

  const pending = empty.snapshotAI({ timeoutMs: 5000 }).then(value => ({ ok: true, value }), error => ({ ok: false, error: String(error) }));
  // A real public raw-CDP round trip confirms the no-body document still exists
  // while the submitted snapshot is outstanding; no fixed sleep arms this test.
  assert.equal(await empty.evaluate("document.body===null"), true);
  const endStart = Date.now();
  await browser.client.turnEnded();
  const cancelled = await pending;
  assert.equal(cancelled.ok, false, "Ending control returned a usable pending capture");
  assert.match(cancelled.error, /cancel|control|epoch|closed|ended/i);
  const cancelledMs = Date.now() - endStart;
  assert.ok(cancelledMs < 3000, "End did not promptly cancel the pending snapshot");
  const detail = { limits, incompleteMs, timeoutMs, cancelledMs, cancelled: cancelled.error };
  await saveDetail("ai-snapshot-limits", detail);
  return detail;
}

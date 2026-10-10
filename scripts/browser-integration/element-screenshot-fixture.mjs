import assert from "node:assert/strict";
import { createHash } from "node:crypto";

export function elementScreenshotFixture(route, port, replacement = "") {
  const head = '<!doctype html><meta charset="utf-8"><style>body{margin:0;font:20px sans-serif}.tile{box-sizing:border-box;width:280px;height:120px;background:#a9d9e8;padding:20px}iframe{width:540px;height:320px;border:0;display:block}.gap{height:1600px}</style>';
  const label = replacement === "1" ? "Navigated screenshot 中文" : replacement === "2" ? "Replacement screenshot 中文" : "Frame screenshot 中文";
  if (route === "/element-screenshot-leaf") return `${head}<div class="gap"></div><div class="tile" id="tile">${label}</div><div class="gap"></div>`;
  if (route === "/element-screenshot-nested") return `${head}<div class="gap"></div><iframe id="inner" src="http://127.0.0.1:${port}/element-screenshot-leaf${replacement === "1" ? "?replacement=1" : ""}"></iframe><div class="gap"></div>`;
  return `${head}<title>Element screenshot fixture</title>
    <iframe id="same" src="/element-screenshot-leaf"></iframe><div class="gap"></div>
    <iframe id="cross" src="http://localhost:${port}/element-screenshot-leaf"></iframe><div class="gap"></div>
    <iframe id="nested" src="http://localhost:${port}/element-screenshot-nested"></iframe><div class="gap"></div>
    <div class="tile" id="root-tile">Root screenshot 中文</div><div class="gap"></div>`;
}

export async function checkElementScreenshots({ browser, fixtureURL, saveScreenshot, oopifTargets }) {
  const tab = await browser.newTab();
  await tab.goto(fixtureURL + "element-screenshots");
  const dpr = await tab.evaluate("devicePixelRatio");
  const results = [];
  const capture = async (name, locator) => {
    const started = Date.now();
    const result = await locator.screenshot({ timeoutMs: 12000 });
    assert.equal(result.mimeType, "image/png");
    const bytes = Buffer.from(result.base64, "base64");
    assert.deepEqual(bytes.subarray(0, 8), Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
    assert.equal(bytes.readUInt32BE(16), Math.round(280 * dpr));
    assert.equal(bytes.readUInt32BE(20), Math.round(120 * dpr));
    const box = await locator.boundingBox();
    assert.equal(box.width, 280);
    assert.equal(box.height, 120);
    await saveScreenshot(name, bytes);
    results.push({ name, cssWidth: 280, cssHeight: 120, dpr, pixelWidth: bytes.readUInt32BE(16), pixelHeight: bytes.readUInt32BE(20), elapsedMs: Date.now() - started, sha256: createHash("sha256").update(bytes).digest("hex") });
    return results.at(-1).sha256;
  };
  // Scroll the root far past every iframe first. These must work without a
  // caller pre-scrolling the owner iframe or activating the browser tab.
  const root = tab.locator("#root-tile");
  await capture("element-root", root);
  const same = tab.frameLocator("#same").locator("#tile");
  await capture("element-same-frame", same);
  await capture("element-root-again", root);
  const cross = tab.frameLocator("#cross").locator("#tile");
  await assert.rejects(cross.screenshot({ clip: { x: 0, y: 0, width: 1, height: 1 } }), /clip.*page|page.*clip/i);
  await assert.rejects(cross.screenshot({ fullPage: false }), /fullPage.*page|page.*fullPage/i);
  await capture("element-cross-frame", cross);
  await capture("element-root-before-nested", root);
  const nested = tab.frameLocator("#nested").frameLocator("#inner").locator("#tile");
  const before = await capture("element-nested-frame", nested);
  // Navigate the actual nested child; old frame/session identities cannot be
  // used to satisfy a screenshot of the replacement document.
  await tab.evaluate("document.querySelector('#nested').src += '?replacement=1'");
  assert.equal(await tab.frameLocator("#nested").frameLocator("#inner").getByText("Navigated screenshot 中文", { exact: true }).textContent(), "Navigated screenshot 中文");
  const after = await capture("element-nested-after-navigation", nested);
  assert.notEqual(before, after, "Navigation did not change the captured element pixels");
  await tab.evaluate("document.querySelector('#nested').src = '/element-screenshot-leaf?replacement=2'");
  const replacement = tab.frameLocator("#nested").locator("#tile");
  assert.equal(await tab.frameLocator("#nested").getByText("Replacement screenshot 中文", { exact: true }).textContent(), "Replacement screenshot 中文");
  await capture("element-replacement-frame", replacement);
  assert.notEqual(results[0].sha256, before, "Element screenshots unexpectedly contain identical root/frame pixels");
  const targets = await oopifTargets();
  assert.ok(targets.some(target => target.tabId === tab.id && target.type === "iframe"), "No native OOPIF target observed for element screenshots");
  return { tabId: tab.id, results };
}

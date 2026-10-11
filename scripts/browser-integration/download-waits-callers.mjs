import assert from "node:assert/strict";
import { downloadVariants, downloadPageURL, downloadScope } from "./download-waits-fixture.mjs";

export async function checkDownloadWireCaller({ kind, owner, callA, callB, fixtureURL }) {
  assert.equal((await callA("getInfo", {})).metadata.downloadWaitVersion, 1);
  const detail = { caller: kind, independentConnections: true, variants: [] };
  try {
    for (const variant of downloadVariants) {
      const key = `${kind}-page-download-${variant}`, tab = await owner.newTab();
      await owner.cdp.navigate(tab.id, downloadPageURL(fixtureURL, key, variant));
      const scope = downloadScope(owner), ack = await callA("armDownloadWait", { ...scope, tabId: tab.id, timeoutMs: 10000 });
      const item = { key, variant, tabId: tab.id, scope, ...ack, readyAt: Date.now() }; detail.variants.push(item);
      const locator = [...(variant === "root" ? [] : [{ kind: "frame", selector: "#download-frame" }]), { kind: "role", role: "link", name: "Download fixture", exact: true }];
      try {
        if (variant === "dynamic-oopif") await callB("browserAction", { ...scope, tabId: tab.id, action: "click", locator: [{ kind: "role", role: "button", name: "Add download frame", exact: true }], timeoutMs: 5000 });
        item.triggerSubmittedAt = Date.now();
        await callB("browserAction", { ...scope, tabId: tab.id, action: "click", locator, timeoutMs: 5000 });
        item.result = await callA("collectDownloadWait", { ...scope, tabId: tab.id, waiterId: ack.waiterId }); item.collectedAt = Date.now();
        const target = variant === "root" ? tab : tab.frameLocator("#download-frame");
        item.page = JSON.parse(await target.locator("#evidence").textContent());
        if (variant === "dynamic-oopif") item.frameAdds = await tab.evaluate("downloadEvidence.frameAdds");
      } finally { await callA("cancelDownloadWait", { ...scope, tabId: tab.id, waiterId: ack.waiterId }); }
    }
    return checkDownloadCallerResult(detail, kind);
  } catch (error) { error.downloadDetail = detail; throw error; }
}

export function checkDownloadCallerResult(detail, kind) {
  assert.equal(detail.caller, kind); assert.equal(detail.independentConnections, true);
  assert.deepEqual(detail.variants.map(item => item.variant), downloadVariants);
  for (const item of detail.variants) {
    assert.equal(item.key, `${kind}-page-download-${item.variant}`);
    assert.ok(item.waiterId && item.remainingMs > 0 && item.remainingMs <= 10000);
    assert.ok(item.triggerSubmittedAt >= item.readyAt && item.collectedAt >= item.triggerSubmittedAt);
    assert.equal(typeof item.result.downloadId, "string"); assert.ok(item.result.downloadId);
    assert.deepEqual(item.page.clicks, [{ trusted: true, sequence: 1 }]);
    if (item.variant === "dynamic-oopif") assert.deepEqual(item.frameAdds, [{ trusted: true }]);
  }
  assert.equal(new Set(detail.variants.map(item => item.result.downloadId)).size, 3);
  return detail;
}

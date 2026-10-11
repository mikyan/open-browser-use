import assert from "node:assert/strict";
import { chooserVariants, chooserPageURL, chooserScope, chooserFrameEvidence, checkChooserReceipts } from "./chooser-waits-fixture.mjs";

// Both call functions are separate CLI processes / live MCP clients. Every
// request carries the original legal scope; collecting never creates a turn.
export async function checkChooserWireCaller({ kind, owner, callA, callB, fixtureURL, files, server, worker, until }) {
  assert.equal((await callA("getInfo", {})).metadata.fileChooserWaitVersion, 1);
  const detail = { caller: kind, independentConnections: true, variants: [] };
  for (const variant of chooserVariants) {
    const key = `${kind}-chooser-${variant}`, tab = await owner.newTab();
    await owner.cdp.navigate(tab.id, chooserPageURL(fixtureURL, key, variant));
    const scope = chooserScope(owner), item = { key, variant, tabId: tab.id, scope, waits: [] }; detail.variants.push(item);
    const locator = [...(variant === "root" ? [] : [{ kind: "frame", selector: "#upload-frame" }]), { kind: "label", value: "Upload fixture", exact: true }];
    for (let sequence = 1; sequence <= 2; sequence++) {
      const ack = await callA("armFileChooserWait", { ...scope, tabId: tab.id, timeoutMs: 10000 });
      const event = { ...ack, readyAt: Date.now() }; item.waits.push(event); assert.ok(ack.waiterId && ack.remainingMs > 0);
      try {
        if (variant === "dynamic-oopif" && sequence === 1) await callB("browserAction", { ...scope, tabId: tab.id, action: "click", locator: [{ kind: "role", role: "button", name: "Add upload frame", exact: true }], timeoutMs: 5000 });
        event.triggerSubmittedAt = Date.now();
        await callB("browserAction", { ...scope, tabId: tab.id, action: "click", locator, timeoutMs: 5000 });
        event.result = await callA("collectFileChooserWait", { ...scope, tabId: tab.id, waiterId: ack.waiterId }); event.collectedAt = Date.now();
        assert.equal(event.result.isMultiple, variant !== "root"); assert.equal(typeof event.result.fileChooserId, "string");
        await callA("setFileChooserFiles", { ...scope, fileChooserId: event.result.fileChooserId, files: sequence === 1 ? (variant === "root" ? files.slice(0, 1) : files).map(file => file.path) : [] });
        await until(() => server.stats(key).posts.length === sequence && server.stats(key).posts.at(-1).receipt, `${kind} selected file bytes reached server`);
      } finally { await callA("cancelFileChooserWait", { ...scope, tabId: tab.id, waiterId: ack.waiterId }); }
    }
    assert.notEqual(item.waits[0].result.fileChooserId, item.waits[1].result.fileChooserId);
    item.server = checkChooserReceipts(server.stats(key), files, variant); item.frames = await chooserFrameEvidence(worker, tab.id, key, variant);
    if (variant === "dynamic-oopif") assert.deepEqual(await tab.evaluate("chooserEvidence.frameAdds"), [{ trusted: true }]);
  }
  return detail;
}

export function checkChooserCallerResult(result, kind, prefix, files, server) {
  assert.equal(result.caller, kind); assert.equal(result.independentConnections, true);
  assert.deepEqual(result.variants.map(value => value.variant), chooserVariants);
  for (const item of result.variants) {
    assert.equal(item.key, `${prefix}-${item.variant}`); assert.equal(item.waits.length, 2);
    for (const event of item.waits) {
      assert.ok(event.waiterId && event.remainingMs > 0); assert.equal(event.result.isMultiple, item.variant !== "root");
      assert.ok(event.triggerSubmittedAt >= event.readyAt && event.collectedAt >= event.triggerSubmittedAt);
    }
    assert.notEqual(item.waits[0].result.fileChooserId, item.waits[1].result.fileChooserId);
    item.server = checkChooserReceipts(server.stats(item.key), files, item.variant);
    assert.deepEqual(item.receipts, item.server.posts.map(post => post.receipt), "Caller DOM receipt differs from independent server bytes");
    if (item.variant === "dynamic-oopif") assert.deepEqual(item.frameAdds, [{ trusted: true }]);
  }
  return result;
}

import assert from "node:assert/strict";
import { chooserVariants, chooserPageURL, chooserScope, chooserFrameEvidence, checkChooserReceipts } from "./chooser-waits-fixture.mjs";

// Both call functions are separate CLI processes / live MCP clients. Every
// request carries the original legal scope; collecting never creates a turn.
export async function checkChooserWireCaller({ kind, owner, callA, callB, fixtureURL, files, server, worker, until,
  detail = { caller: kind, independentConnections: true, variants: [] } }) {
  assert.equal(detail.caller, kind); assert.equal(detail.independentConnections, true);
  assert.ok(Array.isArray(detail.variants) && detail.variants.length === 0, "Wire chooser detail must start with no variants");
  detail.passed = false; detail.startedAt = Date.now();
  // These are synchronous annotations around the original awaits. They neither
  // schedule a browser operation nor introduce a readiness wait before input.
  const start = (record, stage) => { record.stage = stage; record[`${stage}StartedAt`] = Date.now(); };
  const complete = record => { record[`${record.stage}CompletedAt`] = Date.now(); };
  const fail = (record, error, stage = record.stage, at = Date.now()) => {
    if (record.failedAt !== undefined) return;
    record.passed = false; record.failedStage = stage; record.failedAt = at;
    record[`${stage}FailedAt`] = at;
    record.error = error?.stack ?? String(error); record.originalError = error?.message ?? String(error);
  };
  try {
    start(detail, "getInfo");
    assert.equal((await callA("getInfo", {})).metadata.fileChooserWaitVersion, 1);
    complete(detail);
    for (const variant of chooserVariants) {
      const key = `${kind}-chooser-${variant}`;
      const item = { key, variant, waits: [], passed: false, startedAt: Date.now() }; detail.variants.push(item);
      try {
        start(item, "newTab");
        const tab = await owner.newTab(); item.tabId = tab.id; complete(item);
        start(item, "navigate");
        await owner.cdp.navigate(tab.id, chooserPageURL(fixtureURL, key, variant)); complete(item);
        const scope = item.scope = chooserScope(owner);
        const locator = [...(variant === "root" ? [] : [{ kind: "frame", selector: "#upload-frame" }]), { kind: "label", value: "Upload fixture", exact: true }];
        for (let sequence = 1; sequence <= 2; sequence++) {
          const event = { sequence, passed: false }; item.waits.push(event);
          try {
            start(event, "arm");
            const ack = await callA("armFileChooserWait", { ...scope, tabId: tab.id, timeoutMs: 10000 });
            event.waiterId = ack.waiterId; event.remainingMs = ack.remainingMs; event.readyAt = Date.now();
            assert.ok(ack.waiterId && ack.remainingMs > 0); complete(event);
            let businessFailed = false;
            try {
              if (variant === "dynamic-oopif" && sequence === 1) {
                start(event, "addFrame");
                await callB("browserAction", { ...scope, tabId: tab.id, action: "click", locator: [{ kind: "role", role: "button", name: "Add upload frame", exact: true }], timeoutMs: 5000 });
                complete(event);
              }
              start(event, "click"); event.triggerSubmittedAt = Date.now();
              await callB("browserAction", { ...scope, tabId: tab.id, action: "click", locator, timeoutMs: 5000 });
              event.triggerCompletedAt = Date.now(); complete(event);
              start(event, "collect");
              event.result = await callA("collectFileChooserWait", { ...scope, tabId: tab.id, waiterId: ack.waiterId }); event.collectedAt = Date.now();
              assert.equal(event.result.isMultiple, variant !== "root"); assert.equal(typeof event.result.fileChooserId, "string"); complete(event);
              start(event, "setFiles");
              await callA("setFileChooserFiles", { ...scope, fileChooserId: event.result.fileChooserId, files: sequence === 1 ? (variant === "root" ? files.slice(0, 1) : files).map(file => file.path) : [] }); complete(event);
              start(event, "receipt");
              await until(() => server.stats(key).posts.length === sequence && server.stats(key).posts.at(-1).receipt, `${kind} selected file bytes reached server`); complete(event);
            } catch (error) {
              businessFailed = true; fail(event, error); throw error;
            } finally {
              start(event, "cancel");
              try { await callA("cancelFileChooserWait", { ...scope, tabId: tab.id, waiterId: ack.waiterId }); complete(event); }
              catch (error) {
                event.cancelError = error?.stack ?? String(error); event.cancelFailedAt = Date.now();
                if (!businessFailed) throw error;
              }
            }
            event.passed = true; event.completedAt = Date.now();
          } catch (error) {
            fail(event, error); fail(item, error, event.failedStage, event.failedAt); throw error;
          }
        }
        start(item, "verify");
        assert.notEqual(item.waits[0].result.fileChooserId, item.waits[1].result.fileChooserId);
        item.server = checkChooserReceipts(server.stats(key), files, variant); complete(item);
        start(item, "frames"); item.frames = await chooserFrameEvidence(worker, tab.id, key, variant); complete(item);
        if (variant === "dynamic-oopif") {
          start(item, "frameAdds"); assert.deepEqual(await tab.evaluate("chooserEvidence.frameAdds"), [{ trusted: true }]); complete(item);
        }
        item.passed = true; item.completedAt = Date.now();
      } catch (error) {
        fail(item, error); fail(detail, error, item.failedStage, item.failedAt); throw error;
      }
    }
    detail.passed = true; detail.completedAt = Date.now(); return detail;
  } catch (error) { fail(detail, error); throw error; }
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

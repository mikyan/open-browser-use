import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { downloadScope } from "./download-waits-fixture.mjs";

// Feasibility mode reads the original native event path; product modes read only
// paths returned by their public entry point. Neither mode guesses a filename.
function installTrace(chrome, target) {
  if (target.__originalDownloadTrace) throw new Error("Original download trace already exists");
  const trace = { events: [], overflow: false };
  trace.listener = (source, method, params) => {
    if (!["Page.downloadWillBegin", "Page.downloadProgress"].includes(method)) return;
    if (trace.events.length >= 512) { trace.overflow = true; return; }
    trace.events.push({ at: Date.now(), source: structuredClone(source), method, params: structuredClone(params) });
  };
  target.__originalDownloadTrace = trace;
  chrome.debugger.onEvent.addListener(trace.listener);
}
const readTrace = worker => worker.evaluate("({events:__originalDownloadTrace.events,overflow:__originalDownloadTrace.overflow})");

export async function checkOriginalDownloadProof({ owners, worker, native, fixture, fixtureURL, downloadRoot, until, behavior, product = false, callers }) {
  if (callers) {
    assert.equal(product, true);
    assert.equal(callers.length, owners.length);
  } else assert.equal(owners.length, 3);
  const expectedFiles = owners.length * 6;
  const detail = { behavior, boundary: product ? `${callers ? "Five public SDK/CLI/MCP entry points" : "Public JS SDK paths"} through explicitly bound production host; fresh isolated profile` : "Harness-only native Browser connection in a fresh isolated profile; SDK path remains unavailable", cases: [], groups: [], notifications: owners.map(() => []) };
  const unsubscribes = owners.map((owner, index) => owner.client.onNotification(event => {
    if (event.method === "onDownloadChange") detail.notifications[index].push(structuredClone(event.params));
  }));
  const waiters = [];
  let tracing = false, failure;
  async function cancelWait(entry) {
    entry.attempted = true;
    try { await entry.waiter.cancel(); entry.item.waitCleanup = { completed: true }; }
    catch (error) { entry.item.waitCleanup = { error: error.stack }; throw error; }
  }
  try {
    for (const owner of owners) await owner.client.getTabs();
    await worker.evaluate(`(${installTrace.toString()})(chrome,globalThis)`); tracing = true;
    for (const variant of ["root", "oopif", "dynamic-oopif"]) {
      for (const kind of ["post", "blob"]) {
        const group = [];
        const readiness = { variant, kind, ready: [] }; detail.groups.push(readiness);
        const waiting = new Map(); let gateError;
        const rejectGate = error => {
          gateError ??= error;
          readiness.error ??= String(error);
          for (const pending of waiting.values()) { clearTimeout(pending.timer); pending.reject(gateError); }
          waiting.clear();
        };
        const afterReady = (item, ack) => new Promise((resolve, reject) => {
          try {
            if (gateError) throw gateError;
            assert.equal(ack.tabId, item.tabId); assert.deepEqual(ack.scope, item.scope);
            assert.ok(ack.waiterId && Number.isFinite(ack.readyAt) && ack.remainingMs > 0 && ack.remainingMs <= 15000);
            assert.ok(!readiness.ready.some(entry => entry.ownerIndex === item.ownerIndex));
            const remaining = ack.readyAt + ack.remainingMs - Date.now();
            assert.ok(remaining > 0, "Original wait expired before all callers were ready");
            readiness.ready.push({ ownerIndex: item.ownerIndex, ...ack, observedAt: Date.now() });
            const timer = setTimeout(() => rejectGate(new Error("Original wait expired at all-ready barrier")), remaining);
            waiting.set(item.ownerIndex, { resolve, reject, timer });
            if (waiting.size === owners.length) {
              readiness.releasedAt = Date.now();
              for (const entry of readiness.ready) assert.ok(readiness.releasedAt < entry.readyAt + entry.remainingMs);
              for (const pending of waiting.values()) { clearTimeout(pending.timer); pending.resolve(); }
              waiting.clear();
            }
          } catch (error) { rejectGate(error); reject(error); }
        });
        // The third connection is an unrelated task using the identical URL and
        // suggested filename. Its events must never reach the first two owners.
        for (const [index, owner] of owners.entries()) {
          const record = fixture.createCase({ kind, owner: `native-${behavior}-${index}-${variant}-${kind}`, variant });
          const tab = await owner.newTab(); await owner.cdp.navigate(tab.id, fixtureURL + record.urlPath.slice(1));
          const item = { key: record.key, ownerIndex: index, kind, variant, tabId: tab.id, scope: downloadScope(owner) };
          detail.cases.push(item);
          // Arm before a dynamic child exists, as in the public ready contract.
          const caller = callers?.[index];
          let waiter, cleanup, waitDeadline;
          if (!caller) {
            const armStarted = performance.now();
            waiter = await tab.expectDownload({ timeoutMs: 15000, ...(product ? { requirePath: true } : {}) }); item.requirePath = product; item.waiterId = waiter.waiterId; item.readyAt = Date.now();
            waitDeadline = Math.min(armStarted + 15000, performance.now() + waiter.remainingMs);
            cleanup = { item, waiter, attempted: false }; waiters.push(cleanup);
            if (!callers && variant === "dynamic-oopif") await tab.getByRole("button", { name: "Add download frame", exact: true }).click();
          }
          const target = variant === "root" ? tab : tab.frameLocator("#download-frame");
          group.push({ item, record, tab, target, waiter, cleanup, caller, waitDeadline });
        }
        // Observe every settled attempt before proceeding, including a failed
        // click. No replay or second download request is used to repair failure.
        const settled = await Promise.allSettled(group.map(async ({ item, record, tab, target, waiter, cleanup, caller, waitDeadline }) => {
          try {
            if (caller) {
              item.caller = await caller({ tabId: item.tabId, scope: item.scope, variant, kind, key: item.key, afterReady: ack => afterReady(item, ack) });
              assert.equal(item.caller.ok, true);
              assert.deepEqual(item.caller.scope, item.scope);
              assert.equal(item.caller.tabId, item.tabId);
              assert.equal(item.caller.variant, variant);
              assert.equal(item.caller.kind, kind);
              assert.equal(item.caller.key, item.key);
              assert.ok(item.caller.remainingMs > 0 && item.caller.remainingMs <= 15000);
              for (const key of ["waiterId", "readyAt", "triggerAt", "downloadId", "collectedAt", "productPath"]) item[key] = item.caller[key];
              assert.ok(typeof item.waiterId === "string" && item.waiterId);
              assert.ok(Number.isFinite(item.readyAt) && item.triggerAt >= item.readyAt && item.collectedAt >= item.triggerAt);
              assert.equal(item.caller.waitCleanup.ok, true);
            } else {
              const clickOptions = () => {
                if (!callers) return { timeoutMs: 5000 };
                const remaining = Math.floor(waitDeadline - performance.now());
                assert.ok(remaining > 0, "Original download wait expired before click");
                return { timeoutMs: Math.min(5000, remaining) };
              };
              if (callers) {
                await afterReady(item, { tabId: item.tabId, scope: item.scope, waiterId: item.waiterId, remainingMs: waiter.remainingMs, readyAt: item.readyAt });
                if (variant === "dynamic-oopif") await tab.getByRole("button", { name: "Add download frame", exact: true }).click(clickOptions());
              }
              const options = clickOptions();
              item.triggerAt = Date.now();
              await target.getByRole("button", { name: "Download original report", exact: true }).click(options);
              const download = await waiter.result(); item.downloadId = download.downloadId; item.collectedAt = Date.now();
              try { item.productPath = await download.path({ timeoutMs: product ? 10000 : 1000 }); }
              catch (error) { item.productPathError = String(error); }
            }
            if (product) {
              assert.equal(item.productPathError, undefined);
              assert.equal(typeof item.productPath, "string");
            } else assert.match(item.productPathError ?? "", /OBU_DOWNLOAD_PATH_UNAVAILABLE/, "Do not silently claim this harness transport is a product path");
            item.page = JSON.parse(await target.locator("#state").textContent());
            assert.equal(item.page.key, item.key); assert.equal(item.page.clicks.length, 1); assert.equal(item.page.clicks[0].trusted, true);
            if (kind === "blob") assert.equal(item.page.clicks[0].revoked, true);
            if (variant === "dynamic-oopif") {
              item.rootPage = JSON.parse(await tab.locator("#state").textContent());
              assert.deepEqual(item.rootPage.frameAdds, [{ trusted: true }]);
            }
            // until() intentionally swallows transient reads in the old runner.
            // Inspect raw completion first so missing native filePath is then
            // reported directly instead of being mistaken for observation lag.
            if (!product) {
              await until(() => native.snapshot().events.some(({ message: event }) => event.method === "Browser.downloadProgress" && event.params.guid === item.downloadId && event.params.state !== "inProgress"), "original Browser download terminal event");
              item.native = native.download(item.downloadId);
            }
            const trace = await readTrace(worker);
            assert.equal(trace.overflow, false);
            const begins = trace.events.filter(event => event.method === "Page.downloadWillBegin" && event.params.guid === item.downloadId);
            assert.equal(begins.length, 1); item.pageBegin = begins[0];
            assert.equal(item.pageBegin.source.tabId, item.tabId);
            if (!product) {
              assert.equal(item.native.guid, item.downloadId);
              assert.equal(item.native.begin.frameId, item.pageBegin.params.frameId);
              assert.equal(item.native.begin.url, item.pageBegin.params.url);
              assert.equal(item.native.begin.suggestedFilename, "report.bin");
            }
            assert.ok(item.pageBegin.at >= item.readyAt);
            if (!product) item.targets = await native.call("Target.getTargets");
            item.frameEvidence = await worker.evaluate(`(async()=>({frames:await chrome.webNavigation.getAllFrames({tabId:${item.tabId}}),targets:await chrome.debugger.getTargets(),attachedTargets:globalThis.__integrationFrames.filter(frame=>frame.tabId===${item.tabId})}))()`);
            const topTarget = item.frameEvidence.targets.find(entry => entry.tabId === item.tabId);
            assert.ok(topTarget);
            if (!product) assert.ok(item.targets.targetInfos.some(entry => entry.targetId === topTarget.id));
            if (variant !== "root") {
              const frames = item.frameEvidence.frames, root = frames.find(frame => frame.frameId === 0);
              const child = frames.find(frame => frame.parentFrameId === 0 && frame.url.includes(`key=${item.key}`));
              assert.ok(root && child); assert.notEqual(root.processId, child.processId);
              const attached = item.frameEvidence.attachedTargets.find(frame => frame.targetId === item.pageBegin.params.frameId);
              assert.ok(attached && attached.sessionId); item.attached = attached;
              if (!product) assert.ok(item.targets.targetInfos.some(entry => entry.targetId === attached.targetId));
              if (item.pageBegin.source.sessionId) assert.equal(item.pageBegin.source.sessionId, attached.sessionId);
            }
            const deliveredPath = product ? item.productPath : item.native.filePath;
            const relative = path.relative(downloadRoot, deliveredPath);
            assert.ok(relative && !relative.startsWith("..") && !path.isAbsolute(relative), "Native path must remain in the isolated download directory");
            const handle = await fs.open(deliveredPath, "r");
            try {
              const stat = await handle.stat(); assert.ok(stat.isFile() && stat.size < 65536);
              const bytes = await handle.readFile();
              const sha256 = createHash("sha256").update(bytes).digest("hex");
              item.file = { path: deliveredPath, bytes: bytes.length, sha256, base64: bytes.toString("base64"), analysis: JSON.parse(bytes.subarray(0, bytes.indexOf(10)).toString("utf8")) };
              assert.deepEqual(bytes, Buffer.from(record.expected.base64, "base64")); assert.equal(sha256, record.expected.sha256);
              assert.equal(item.file.analysis.key, item.key); assert.equal(item.file.analysis.nonce, record.nonce);
              if (caller) for (const field of ["bytes", "sha256", "base64", "analysis"]) assert.deepEqual(item.caller.file[field], item.file[field]);
              if (behavior === "allowAndName") assert.equal(path.basename(deliveredPath), item.downloadId);
            } finally { await handle.close(); }
            await until(() => detail.notifications[item.ownerIndex].some(event => event.id === item.downloadId && event.status === "complete"), "owner completed notification");
            for (const [index, notifications] of detail.notifications.entries()) {
              if (index !== item.ownerIndex) assert.ok(notifications.every(event => event.id !== item.downloadId));
              else for (const event of notifications.filter(event => event.id === item.downloadId)) {
                assert.equal(event.tabId, item.tabId);
                for (const field of ["session_id", "turn_id", "control_epoch"]) assert.equal(event[field], item.scope[field]);
              }
            }
            item.server = fixture.stats(item.key);
            const posts = item.server.requests.filter(hit => hit.method === "POST");
            assert.equal(posts.length, kind === "post" ? 1 : 0);
            if (kind === "post") {
              assert.equal(posts[0].status, 200); assert.equal(posts[0].finished, true);
              assert.equal(posts[0].fields.documentToken, item.page.documentToken); assert.equal(posts[0].fields.trusted, "true");
              assert.equal(posts[0].fields.buttonCount, "1"); assert.equal(posts[0].response.sha256, item.file.sha256);
            }
          } catch (error) { rejectGate(error); item.error = error.stack; item.callerFailure = error.originalDownloadDetail; throw error; }
          finally { if (cleanup) try { await cancelWait(cleanup); } catch (error) { if (!item.error) throw error; } }
        }));
        const errors = settled.filter(result => result.status === "rejected").map(result => result.reason);
        if (errors.length) throw new AggregateError(errors, errors.map(error => error.message).join("; "));
        if (callers) {
          assert.equal(readiness.ready.length, owners.length);
          assert.ok(Math.max(...readiness.ready.map(entry => entry.observedAt)) <= readiness.releasedAt);
          assert.ok(Math.min(...group.map(({ item }) => item.triggerAt)) >= readiness.releasedAt);
        }
        for (const { item } of group) for (const [index, owner] of owners.entries()) if (index !== item.ownerIndex) {
          await assert.rejects(owner.client.downloadPath(item.downloadId), /Unknown or unowned download id/);
          if (product) await assert.rejects(owner.client.request("cancelDownload", { downloadId: item.downloadId }), /unknown or unowned/i);
        }
      }
    }
    assert.equal(fixture.allStats().requests.filter(hit => hit.url === "/report" && hit.method !== "POST").length, 0);
    assert.equal(new Set(detail.cases.map(item => item.downloadId)).size, expectedFiles);
    assert.equal(new Set(detail.cases.map(item => item.file.sha256)).size, expectedFiles);
    if (product) {
      const original = detail.cases[0];
      await fs.unlink(original.productPath);
      await assert.rejects(owners[original.ownerIndex].client.downloadPath(original.downloadId), /OBU_NATIVE_DOWNLOAD_FILE_UNAVAILABLE/);
      detail.missingFileRejected = true;
    }
    const allIds = new Map(detail.cases.map(item => [item.downloadId, item]));
    for (const [index, notifications] of detail.notifications.entries()) for (const event of notifications) {
      const item = allIds.get(event.id);
      assert.ok(item, "Unknown GUID delivered to an original-download owner");
      assert.equal(item.ownerIndex, index); assert.equal(event.tabId, item.tabId);
      for (const field of ["session_id", "turn_id", "control_epoch"]) assert.equal(event[field], item.scope[field]);
    }
    return detail;
  } catch (error) { failure = error; error.originalDownloadDetail = detail; throw error; }
  finally {
    for (const unsubscribe of unsubscribes) unsubscribe();
    detail.cleanupErrors = [];
    const pendingCleanup = await Promise.allSettled(waiters.filter(entry => !entry.attempted).map(cancelWait));
    for (const result of pendingCleanup) if (result.status === "rejected") detail.cleanupErrors.push(String(result.reason));
    if (tracing) {
      try { detail.pageTrace = await readTrace(worker); }
      catch (error) { detail.cleanupErrors.push(String(error)); }
      try { await worker.evaluate("(()=>{chrome.debugger.onEvent.removeListener(__originalDownloadTrace.listener);delete globalThis.__originalDownloadTrace})()"); }
      catch (error) { detail.cleanupErrors.push(String(error)); }
    }
    if (!failure && detail.cleanupErrors.length) {
      const error = new Error(detail.cleanupErrors.join("; ")); error.originalDownloadDetail = detail; throw error;
    }
  }
}

export async function checkProductDownloadLifecycle({ owner, fixture, fixtureURL, until, detail }) {
  detail.lifecycle = [];
  for (const mode of ["cancel", "revoke"]) {
    const key = `product-native-${mode}`, item = { mode, key };
    detail.lifecycle.push(item); fixture.hold(key);
    let waiter;
    try {
      const tab = await owner.newTab(); item.tabId = tab.id;
      await owner.cdp.navigate(tab.id, fixtureURL + `download-waits/page?key=${key}&variant=root`);
      waiter = await tab.expectDownload({ timeoutMs: 10000 });
      await tab.getByRole("link", { name: "Download fixture", exact: true }).click();
      const download = await waiter.result(); item.downloadId = download.downloadId;
      await assert.rejects(download.path({ timeoutMs: 100 }), /TIMEOUT|deadline|timed out/i);
      item.pendingPathRejected = true;
      if (mode === "cancel") {
        await download.cancel(); item.cancelAcknowledged = true;
        await assert.rejects(download.path(), /CANCELED|canceled/i);
        await until(() => fixture.stats(key).requests[0]?.closed, "server observes original download cancellation");
        item.server = fixture.stats(key);
        assert.equal(item.server.requests[0].finished, false);
      } else {
        await tab.close(); item.tabClosed = true;
        await assert.rejects(download.path(), /EXPIRED|CANCELLED|unowned|STALE|closed|no longer|not part of browser session/i);
        item.pathRevoked = true;
        fixture.release(key);
        await until(() => fixture.stats(key).requests[0]?.closed, "revoked observation's original HTTP response finishes");
        item.server = fixture.stats(key);
        assert.equal(item.server.requests[0].finished, true, "Revoking ownership must not cancel the browser download");
      }
      assert.equal(item.server.requests.length, 1);
      assert.equal(item.server.requests[0].sequence, 1);
    } catch (error) { item.error = error.stack; throw error; }
    finally {
      fixture.release(key);
      // A closed tab has already revoked the observer; its cancel handle is stale.
      if (waiter && !item.tabClosed) await waiter.cancel();
    }
  }
}

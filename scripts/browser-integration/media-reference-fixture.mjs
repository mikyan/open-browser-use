import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { verifyMediaFile } from "./media-downloads-fixture.mjs";

// Only this fixed local fixture's unique accessible names are parsed here.
// Production authorization uses the capture's structured native ref allowlist.
function imageRef(capture, name) {
  assert.equal(capture.complete, true);
  const lines = capture.snapshot.split("\n").filter(line => line.includes(`img ${JSON.stringify(name)} `));
  assert.equal(lines.length, 1, `Expected one native image entry named ${name}`);
  const matches = [...lines[0].matchAll(/\[ref=([^\]]+)\]/g)];
  assert.equal(matches.length, 1);
  const ref = matches[0][1];
  assert.ok(capture.refs.includes(ref), "Image ref must occur in the structured native allowlist");
  return ref;
}

async function nameImages(tab) {
  // The fixture intentionally replaces main-world currentSrc getters. Changing
  // only alt names supplies unique snapshot labels without touching provenance.
  await tab.evaluate(`(() => {
    document.querySelector('#selected').alt='Reference root media';
    document.querySelector('#shadow').shadowRoot.querySelector('#shadow-image').alt='Reference shadow media';
    const same=document.querySelector('#same').contentDocument;
    same.querySelector('#selected').alt='Reference same media';
    same.querySelector('#nested').contentDocument.querySelector('#selected').alt='Reference nested media';
  })()`);
}

export async function checkMediaReferences({ browser, fixtureURL, server, downloadRoot }) {
  assert.equal((await browser.client.getInfo()).metadata.mediaDownloadsVersion, 1);
  // Construct a second public client of the exact same snapshotted SDK class.
  // No extra module import can accidentally load a different working-tree SDK.
  const foreign = new browser.constructor({
    socketPath: browser.client.socketPath,
    sessionId: `media-reference-${randomUUID()}`,
    timeoutMs: 15000
  });
  const handles = [], results = [], captures = [];
  const evidence = { captures, files: results, requests: [], pairFiles: [], pairRequests: [], cleanup: [] };
  let failure;
  try {
    await foreign.connect();
    const tab = await browser.newTab({ url: fixtureURL + "media-downloads/page" });
    const other = await foreign.newTab({ url: fixtureURL + "media-downloads/page" });
    await Promise.all([tab.waitForLoadState({ state: "load" }), other.waitForLoadState({ state: "load" })]);
    evidence.tabIds = [tab.id, other.id];
    await nameImages(tab); await nameImages(other);
    const capture = await tab.snapshotAI(); captures.push(capture);
    assert.equal(capture.stats.frames, 4);
    const before = server.stats().length;
    const cases = [
      ["Reference root media", "root"], ["Reference shadow media", "shadow-root"],
      ["Reference same media", "same"], ["Selected media", "cross"], ["Reference nested media", "nested"]
    ];
    for (const [name, scope] of cases) {
      const ref = imageRef(capture, name);
      const download = await tab.getByRef(capture.captureId, ref).downloadMedia({ filename: `media-ref-${scope}.png`, timeoutMs: 5000 });
      handles.push(download);
      results.push({ name, ref, scope, downloadId: download.downloadId, ...await verifyMediaFile(await download.path({ timeoutMs: 5000 }), downloadRoot) });
      evidence.requests = server.stats().slice(before);
    }
    const requests = server.stats().slice(before);
    assert.equal(requests.length, cases.length, "One GET per exact native image reference");
    assert.deepEqual(requests.map(request => request.scope), cases.map(([, scope]) => scope));
    assert.ok(requests.every(request => request.path === "/media-downloads/selected.png" && request.method === "GET"));
    assert.equal(requests.find(request => request.scope === "cross").host, new URL(fixtureURL).host.replace("127.0.0.1", "localhost"));

    const rootRef = imageRef(capture, "Reference root media");
    const otherCapture = await other.snapshotAI(); captures.push(otherCapture);
    await assert.rejects(other.getByRef(capture.captureId, rootRef).downloadMedia({ timeoutMs: 1000 }), /OBU_CAPTURE_EXPIRED/);
    await assert.rejects(foreign.tab(tab.id).getByRef(capture.captureId, rootRef).downloadMedia({ timeoutMs: 1000 }), /session|owned|claim|part of/);
    for (const method of ["downloadPath", "cancelDownload"])
      await assert.rejects(foreign.client.request(method, { downloadId: handles[0].downloadId, timeoutMs: 1000 }), /OBU_DOWNLOAD_EXPIRED/);
    assert.equal(server.stats().length, before + cases.length, "Foreign refs/handles cannot start or cancel another session's GET");
    // The legitimate owner remains able to retrieve the exact same handle.
    await verifyMediaFile(await handles[0].path({ timeoutMs: 5000 }), downloadRoot);

    const pairBefore = server.stats().length;
    const pairSettled = await Promise.allSettled([
      tab.getByRef(capture.captureId, rootRef).downloadMedia({ filename: "media-ref-shared.png", timeoutMs: 5000 }),
      other.getByRef(otherCapture.captureId, imageRef(otherCapture, "Reference root media")).downloadMedia({ filename: "media-ref-shared.png", timeoutMs: 5000 })
    ].map(operation => operation.then(handle => { handles.push(handle); return handle; })));
    const pairErrors = pairSettled.filter(result => result.status === "rejected").map(result => result.reason);
    if (pairErrors.length) throw pairErrors.length === 1 ? pairErrors[0] : new AggregateError(pairErrors, "Both reference downloads failed");
    const pair = pairSettled.map(result => result.value);
    const pairFiles = await Promise.all(pair.map(async download => ({ downloadId: download.downloadId, ...await verifyMediaFile(await download.path({ timeoutMs: 5000 }), downloadRoot) })));
    evidence.pairFiles = pairFiles;
    assert.notEqual(pairFiles[0].downloadId, pairFiles[1].downloadId);
    assert.notEqual(pairFiles[0].path, pairFiles[1].path, "Exact same URL in two sessions must produce separately owned native files");
    assert.equal(pairFiles[0].sha256, pairFiles[1].sha256);
    const pairRequests = server.stats().slice(pairBefore);
    evidence.pairRequests = pairRequests;
    assert.equal(pairRequests.length, 2);
    assert.ok(pairRequests.every(request => request.scope === "root" && request.path === "/media-downloads/selected.png" && request.method === "GET"));

    const latest = await tab.snapshotAI(); captures.push(latest);
    const staleBefore = server.stats().length;
    await assert.rejects(tab.getByRef(capture.captureId, rootRef).downloadMedia({ timeoutMs: 1000 }), /OBU_CAPTURE_EXPIRED/);
    assert.equal(server.stats().length, staleBefore, "An expired capture cannot initiate any request");
    const removed = tab.getByRef(latest.captureId, imageRef(latest, "Reference root media"));
    await tab.evaluate("document.querySelector('#selected').remove()");
    assert.equal(await removed.count(), 0);
    await assert.rejects(removed.downloadMedia({ timeoutMs: 400 }), /OBU_DOWNLOAD_TIMEOUT/);
    const removalRequests = server.stats().slice(staleBefore);
    evidence.rendererRemovalRequests = removalRequests.map((request, index) => ({ index: staleBefore + index, ...request }));
    // Removing this img from its picture can make Chromium load its fallback
    // candidate even while disconnected. run-cAYlXr recorded that exact request
    // as destination=image; all explicit downloads were destination=empty.
    // Permit only that one renderer resource, retaining its full witness. An
    // accidental download, another selected image or any other URL still fails.
    assert.ok(removalRequests.length <= 1, "Removing one picture image must not cause repeated/unrelated requests");
    for (const request of removalRequests) assert.deepEqual(request, {
      path: "/media-downloads/fallback.png", scope: null, host: new URL(fixtureURL).host,
      cookie: true, destination: "image", method: "GET"
    }, "Removed refs must not initiate a download or resolve a replacement image");
    assert.deepEqual(await tab.evaluate("({events:mediaEvents,traps:getterTraps})"), { events: [], traps: [] });
    assert.deepEqual(await other.evaluate("({events:mediaEvents,traps:getterTraps})"), { events: [], traps: [] });
    return Object.assign(evidence, { requests, pairFiles, pairRequests,
      staleCaptureRejected: true, removedRefRejected: true, crossSessionRejected: true, inputEvents: [], getterTraps: [] });
  } catch (error) {
    failure = error;
    throw error;
  } finally {
    const errors = [];
    const cancelled = await Promise.allSettled(handles.map(handle => handle.cancel({ timeoutMs: 1000 })));
    for (const [index, result] of cancelled.entries()) {
      evidence.cleanup.push({ phase: "cancel", downloadId: handles[index].downloadId, status: result.status,
        ...(result.status === "rejected" ? { error: String(result.reason?.message ?? result.reason) } : {}) });
      if (result.status === "rejected") errors.push(result.reason);
    }
    try { await foreign.client.finalizeTabs([]); evidence.cleanup.push({ phase: "foreign-finalize", status: "fulfilled" }); }
    catch (error) { errors.push(error); evidence.cleanup.push({ phase: "foreign-finalize", status: "rejected", error: String(error?.message ?? error) }); }
    finally {
      try { foreign.close(); }
      catch (error) { errors.push(error); evidence.cleanup.push({ phase: "foreign-close", status: "rejected", error: String(error?.message ?? error) }); }
    }
    evidence.serverRequests = server.stats();
    if (failure) {
      failure.mediaReferences = evidence;
      if (errors.length) failure.mediaCleanupErrors = errors.map(error => String(error?.message ?? error));
    } else if (errors.length) {
      const error = new AggregateError(errors, "Media reference fixture cleanup failed");
      error.mediaReferences = evidence;
      throw error;
    }
  }
}

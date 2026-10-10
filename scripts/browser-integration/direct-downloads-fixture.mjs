import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

const cookieName = "obu_direct_download_fixture";
const cookieValue = "http-only-fixture-cookie";
export const directDownloadErrors = {
  unowned: /OBU_DOWNLOAD_EXPIRED/,
  expired: /OBU_DOWNLOAD_EXPIRED/,
  cancelled: /OBU_DOWNLOAD_EXPIRED/,
  timeout: /OBU_DOWNLOAD_TIMEOUT/,
  epoch: /OBU_STALE_CONTROL_EPOCH|OBU_CONTROL_BOOTSTRAP_REQUIRED/,
  paused: /OBU_AUTOMATION_PAUSED|OBU_DOWNLOAD_EXPIRED|OBU_STALE_CONTROL_EPOCH/
};
export const directDownloadURL = (base, key, mode = "fast") => base + "direct-downloads/file?" + new URLSearchParams({ key, mode });
export const directDownloadPage = base => base + "direct-downloads/page";

// Every byte comes from this HTTP server. A body gate, not a timer, controls
// completion so synchronous SDKs can exercise an in-progress native download.
// Chromium's MIME sniffer can hold response delivery until 1024 bytes or EOF:
// https://raw.githubusercontent.com/chromium/chromium/main/net/base/mime_sniffer.h
// Send a 4096-byte prefix before gating the suffix, so the download can start.
export function createDirectDownloadFixtures() {
  const entries = new Map(), gates = new Map();
  const entry = key => {
    if (!entries.has(key)) entries.set(key, { requests: [] });
    return entries.get(key);
  };
  return {
    stats: key => structuredClone(entry(key)),
    allStats: () => Object.fromEntries([...entries].map(([key, value]) => [key, structuredClone(value)])),
    release(key) {
      for (const [response, gate] of [...gates]) if (gate.key === key) { gates.delete(response); gate.finish(); }
    },
    close() { for (const response of gates.keys()) response.destroy(); gates.clear(); },
    handle(request, response) {
      const url = new URL(request.url, "http://localhost");
      if (!url.pathname.startsWith("/direct-downloads/")) return false;
      response.setHeader("Cache-Control", "no-store");
      if (url.pathname === "/direct-downloads/page") {
        response.setHeader("Set-Cookie", `${cookieName}=${cookieValue}; HttpOnly; SameSite=Lax; Path=/direct-downloads`);
        response.setHeader("Content-Type", "text/html; charset=utf-8");
        response.end('<!doctype html><title>Direct downloads fixture</title><h1>Direct downloads</h1>');
        return true;
      }
      const key = url.searchParams.get("key") || "missing";
      if (url.pathname === "/direct-downloads/stats") {
        response.setHeader("Content-Type", "application/json"); response.end(JSON.stringify(entry(key))); return true;
      }
      if (url.pathname !== "/direct-downloads/file") { response.writeHead(404); response.end(); return true; }
      const state = entry(key), ordinal = state.requests.length + 1;
      const cookie = (request.headers.cookie || "").split(/;\s*/).includes(`${cookieName}=${cookieValue}`);
      const heading = `OBU direct download ${key} #${ordinal}\nHttpOnly cookie: ${cookie ? "present" : "missing"}\n中文 bytes\n`;
      const payload = heading + ".".repeat(Math.max(0, 4096 - Buffer.byteLength(heading))) + "\n";
      const bytes = Buffer.from(payload), prefixBytes = bytes.length - 1, suffixBytes = 1;
      const record = { ordinal, method: request.method, cookie, payload, bytes: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex"), prefixBytes, suffixBytes, sentPrefixBytes: 0, sentSuffixBytes: 0, headersSent: false, finished: false, closed: false };
      state.requests.push(record);
      response.on("close", () => { record.closed = true; gates.delete(response); });
      if (url.searchParams.get("mode") === "fail") { response.destroy(); return true; }
      const finish = () => { if (!response.destroyed) { record.finished = true; record.sentSuffixBytes = suffixBytes; response.end(bytes.subarray(prefixBytes)); } };
      const headers = () => {
        if (response.destroyed) return;
        record.headersSent = true;
        response.writeHead(200, { "Content-Type": "text/plain; charset=utf-8", "Content-Disposition": 'attachment; filename="same-direct-download.txt"', "Content-Length": bytes.length });
        response.write(bytes.subarray(0, prefixBytes));
        record.sentPrefixBytes = prefixBytes;
        if (["slow", "headers"].includes(url.searchParams.get("mode"))) gates.set(response, { key, finish }); else finish();
      };
      if (url.searchParams.get("mode") === "headers") gates.set(response, { key, finish: headers }); else headers();
      return true;
    }
  };
}

export async function verifyDownloadedFile(filename, server, key, downloadRoot) {
  assert.equal(typeof filename, "string"); assert.ok(path.isAbsolute(filename));
  const root = await fs.realpath(downloadRoot), actual = await fs.realpath(filename);
  const relative = path.relative(root, actual);
  assert.ok(relative && !relative.startsWith(".." + path.sep) && relative !== ".." && !path.isAbsolute(relative), "Returned download path escaped the isolated fixture directory");
  const bytes = await fs.readFile(actual), sha256 = createHash("sha256").update(bytes).digest("hex");
  const expected = server.stats(key).requests.find(item => item.sha256 === sha256);
  assert.ok(expected, "Returned path did not contain one exact server response");
  assert.equal(bytes.length, expected.bytes); assert.equal(bytes.toString("utf8"), expected.payload);
  assert.equal(expected.method, "GET"); assert.equal(expected.cookie, true, "Native download omitted the HttpOnly cookie");
  return { path: actual, bytes: bytes.length, sha256, ordinal: expected.ordinal };
}

export async function prepareDirectDownloadTab(browser, fixtureURL) {
  assert.equal((await browser.client.getInfo()).metadata.directDownloadsVersion, 1);
  const tab = await browser.newTab({ url: directDownloadPage(fixtureURL) });
  assert.equal(await tab.evaluate(`document.cookie.includes(${JSON.stringify(cookieName)})`), false, "Fixture cookie was exposed to page JavaScript");
  return tab;
}

export async function checkDirectDownloads({ connectBrowser, fixtureURL, server, until, downloadRoot, unownedDownload, nativeItem, errors = directDownloadErrors }) {
  const first = await connectBrowser("direct-first"), second = await connectBrowser("direct-second");
  const detail = {};
  try {
    const [a, b] = await Promise.all([prepareDirectDownloadTab(first, fixtureURL), prepareDirectDownloadTab(second, fixtureURL)]);
    const key = "js-direct-same-url", url = directDownloadURL(fixtureURL, key);
    const handles = await Promise.all([a.downloadURL(url, { filename: "same-direct.txt" }), b.downloadURL(url, { filename: "same-direct.txt" })]);
    assert.notEqual(handles[0].downloadId, handles[1].downloadId);
    const filenames = await Promise.all(handles.map(handle => handle.path({ timeoutMs: 10000 })));
    assert.notEqual(filenames[0], filenames[1], "uniquify overwrote a concurrent task's download");
    detail.sameURL = await Promise.all(filenames.map(filename => verifyDownloadedFile(filename, server, key, downloadRoot)));
    assert.deepEqual(detail.sameURL.map(item => item.ordinal).sort(), [1, 2]);
    assert.equal(server.stats(key).requests.length, 2, "Download was replayed");
    for (const [client, other] of [[first.client, handles[1]], [second.client, handles[0]]]) {
      await assert.rejects(client.request("downloadPath", { downloadId: other.downloadId, timeoutMs: 500 }), errors.unowned);
      await assert.rejects(client.request("cancelDownload", { downloadId: other.downloadId, timeoutMs: 500 }), errors.unowned);
    }

    const slowKey = "js-direct-path-timeout", slow = await a.downloadURL(directDownloadURL(fixtureURL, slowKey, "slow"), { timeoutMs: 5000 });
    await until(() => server.stats(slowKey).requests.length === 1, "slow download request");
    await assert.rejects(slow.path({ timeoutMs: 200 }), errors.timeout);
    assert.equal(server.stats(slowKey).requests[0].closed, false, "path timeout canceled the native download");
    server.release(slowKey);
    detail.afterPathTimeout = await verifyDownloadedFile(await slow.path({ timeoutMs: 5000 }), server, slowKey, downloadRoot);
    assert.equal(server.stats(slowKey).requests.length, 1);

    const cancelKey = "js-direct-cancel", cancelled = await a.downloadURL(directDownloadURL(fixtureURL, cancelKey, "slow"));
    await until(() => server.stats(cancelKey).requests.length === 1, "cancellable download request");
    await cancelled.cancel();
    await assert.rejects(cancelled.path({ timeoutMs: 500 }), errors.cancelled);
    await until(() => server.stats(cancelKey).requests[0].closed, "explicit cancellation closed native response");
    assert.equal(server.stats(cancelKey).requests[0].finished, false);
    detail.cancel = server.stats(cancelKey);

    const lateKey = "js-direct-late-start";
    const lateStart = a.downloadURL(directDownloadURL(fixtureURL, lateKey, "headers"), { timeoutMs: 300 });
    const expiredStart = assert.rejects(lateStart, errors.timeout);
    await until(() => server.stats(lateKey).requests.length === 1, "download request before late numeric ID");
    await expiredStart;
    assert.equal(server.stats(lateKey).requests[0].headersSent, false);
    server.release(lateKey);
    await until(() => server.stats(lateKey).requests[0].closed, "late numeric ID canceled after start deadline");
    assert.equal(server.stats(lateKey).requests[0].finished, false);
    detail.lateStart = server.stats(lateKey);

    // This separate native download was never issued by a task RPC. Its numeric
    // browser ID cannot be promoted into an owned public handle.
    const outsideKey = "unowned-native-download", outside = await unownedDownload(directDownloadURL(fixtureURL, outsideKey, "slow"));
    await until(async () => (await nativeItem(outside))?.state === "in_progress", "unowned native download started");
    for (const client of [first.client, second.client]) {
      await assert.rejects(client.request("downloadPath", { downloadId: String(outside), timeoutMs: 500 }), errors.unowned);
      await assert.rejects(client.request("cancelDownload", { downloadId: String(outside), timeoutMs: 500 }), errors.unowned);
    }
    const stateAfterRejectedOperations = (await nativeItem(outside)).state;
    const serverAfterRejectedOperations = server.stats(outsideKey);
    assert.equal(stateAfterRejectedOperations, "in_progress", "An unowned native download was canceled");
    assert.equal(serverAfterRejectedOperations.requests.length, 1);
    assert.equal(serverAfterRejectedOperations.requests[0].closed, false, "An unowned response was closed by a task");
    assert.equal(serverAfterRejectedOperations.requests[0].finished, false);
    server.release(outsideKey);
    await until(async () => (await nativeItem(outside))?.state === "complete", "unowned native download completed after owner release");
    detail.unowned = { nativeId: outside, stateAfterRejectedOperations, serverAfterRejectedOperations, stateAfterRelease: "complete", serverAfterRelease: server.stats(outsideKey) };
    return detail;
  } finally {
    server.release("js-direct-path-timeout"); server.release("js-direct-cancel"); server.release("js-direct-late-start"); server.release("unowned-native-download");
    await Promise.all([first, second].map(async browser => { try { await browser.client.finalizeTabs([]); } finally { browser.close(); } }));
  }
}

export async function checkDirectDownloadLifecycle({ connectBrowser, fixtureURL, server, until, ungroup, errors = directDownloadErrors }) {
  const detail = {};
  for (const boundary of ["epoch", "detach", "transfer"]) {
    const browser = await connectBrowser(`direct-${boundary}`), other = await connectBrowser(`direct-${boundary}-successor`);
    const key = `js-direct-${boundary}`;
    try {
      const tab = await prepareDirectDownloadTab(browser, fixtureURL);
      const download = await tab.downloadURL(directDownloadURL(fixtureURL, key, "slow"));
      await until(() => server.stats(key).requests.length === 1, `${boundary} download started`);
      const oldScope = { turn_id: browser.client.turnId, control_epoch: browser.client.controlEpoch };
      if (boundary === "epoch") await browser.client.turnEnded();
      if (boundary === "detach") await browser.client.detach(tab.id);
      if (boundary === "transfer") { await ungroup(tab.id); await other.client.claimUserTab(tab.id); await other.client.attach(tab.id); }
      await assert.rejects(download.path({ timeoutMs: 500 }), boundary === "epoch" ? errors.epoch : errors.expired);
      if (boundary === "epoch") await browser.client.beginTurn();
      await assert.rejects(browser.client.request("downloadPath", { downloadId: download.downloadId, timeoutMs: 500 }), errors.expired);
      if (boundary === "epoch") await assert.rejects(browser.client.request("downloadPath", { ...oldScope, downloadId: download.downloadId, timeoutMs: 500 }), errors.epoch);
      await until(() => server.stats(key).requests[0].closed, `${boundary} canceled its owned native download`);
      assert.equal(server.stats(key).requests[0].finished, false);
      detail[boundary] = { oldScope, server: server.stats(key) };
    } finally {
      server.release(key);
      await Promise.all([browser, other].map(async connection => { try { await connection.client.finalizeTabs([]); } finally { connection.close(); } }));
    }
  }
  return detail;
}

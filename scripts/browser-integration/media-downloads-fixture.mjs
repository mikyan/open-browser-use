import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { clipboardPNG } from "./clipboard-fixture.mjs";

export const mediaPNG = clipboardPNG();
const sha256 = bytes => createHash("sha256").update(bytes).digest("hex");

export function createMediaDownloadFixtures() {
  const requests = [];
  return {
    stats: () => structuredClone(requests),
    handle(request, response, port) {
      const url = new URL(request.url, "http://localhost");
      if (!url.pathname.startsWith("/media-downloads/")) return false;
      response.setHeader("Cache-Control", "no-store");
      if (url.pathname.endsWith(".png")) {
        const selected = url.pathname.endsWith("/selected.png");
        requests.push({ path: url.pathname, scope:url.searchParams.get("scope"), host:request.headers.host, cookie: (request.headers.cookie || "").includes("obu_media=fixture"),
          destination: request.headers["sec-fetch-dest"] || "", method: request.method });
        response.setHeader("Content-Type", selected ? "image/png" : "image/svg+xml");
        response.end(selected ? mediaPNG : '<svg xmlns="http://www.w3.org/2000/svg" width="1" height="1"/>');
        return true;
      }
      response.setHeader("Set-Cookie", "obu_media=fixture; HttpOnly; SameSite=Lax; Path=/media-downloads");
      response.setHeader("Content-Type", "text/html; charset=utf-8");
      const scope = ["same","cross","nested"].includes(url.searchParams.get("scope")) ? url.searchParams.get("scope") : "root";
      const image = `<picture><source media="(min-width:0px)" srcset="/media-downloads/selected.png?scope=${scope}"><img id="selected" alt="Selected media" src="/media-downloads/fallback.png"></picture>`;
      const child = url.pathname.endsWith("/frame");
      response.end(`<!doctype html><meta charset="utf-8"><title>Media downloads fixture</title>${image}
        <div id="not-media"><img src="/media-downloads/selected.png" alt="descendant"></div>
        <img id="empty"><img id="inline" src="data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///ywAAAAAAQABAAACAUwAOw==">
        <canvas id="canvas"></canvas><video id="video" src="/media-downloads/selected.png"></video>
        <span id="shadow"></span>
        ${child ? scope === "same" ? '<iframe id="nested" src="/media-downloads/frame?scope=nested"></iframe>' : "" : `<iframe id="same" src="/media-downloads/frame?scope=same"></iframe><iframe id="cross" src="http://localhost:${port}/media-downloads/frame?scope=cross"></iframe>`}
        <script>
        globalThis.mediaEvents=[];for(const event of ['pointerdown','click','focus','keydown','wheel'])addEventListener(event,()=>mediaEvents.push(event),true);
        document.querySelector('#shadow').attachShadow({mode:'open'}).innerHTML='<img id="shadow-image" alt="Shadow media" src="/media-downloads/selected.png?scope=shadow-${scope}">';
        globalThis.getterTraps=[];
        Object.defineProperty(HTMLImageElement.prototype,'currentSrc',{get(){getterTraps.push('prototype');return location.origin+'/media-downloads/poison.png'}});
        Object.defineProperty(document.querySelector('#selected'),'currentSrc',{get(){getterTraps.push('instance');return location.origin+'/media-downloads/poison.png'}});
        </script>`);
      return true;
    }
  };
}

export async function verifyMediaFile(filename, root) {
  const actual = await fs.realpath(filename), expectedRoot = await fs.realpath(root);
  assert.equal(path.dirname(actual), expectedRoot, "media file must belong to this run's download directory");
  const bytes = await fs.readFile(actual);
  assert.deepEqual(bytes, mediaPNG, "download bytes must match the browser-selected image, not fallback or patched getter");
  return { path: actual, bytes: bytes.length, sha256: sha256(bytes) };
}

export async function checkMediaDownloads({ browser, foreignBrowser, fixtureURL, server, downloadRoot }) {
  assert.equal((await browser.client.getInfo()).metadata.mediaDownloadsVersion, 1);
  const tab = await browser.newTab({url: fixtureURL + "media-downloads/page"});
  await tab.waitForLoadState({state:"load"});
  const before = server.stats().length;
  const results = [];
  const targets = [tab.locator("#selected"), tab.getByAltText("Selected media"), tab.locator("#shadow-image"),
    tab.frameLocator("#same").locator("#selected"), tab.frameLocator("#cross").locator("#selected"),
    tab.frameLocator("#same").frameLocator("#nested").locator("#selected")];
  for (const [index, target] of targets.entries()) {
    const download = await target.downloadMedia({filename:`media-js-${index}.png`, timeoutMs:5000});
    results.push(await verifyMediaFile(await download.path({timeoutMs:5000}), downloadRoot));
    await download.cancel({timeoutMs:5000});
  }
  for (const selector of ["#not-media", "#empty", "#inline", "#canvas", "#video"]) {
    await assert.rejects(tab.locator(selector).downloadMedia({timeoutMs:1000}), /OBU_MEDIA_/);
  }
  await assert.rejects(tab.locator("img").downloadMedia({timeoutMs:1000}), /strict mode/);
  await assert.rejects(foreignBrowser.tab(tab.id).locator("#selected").downloadMedia(), /session|owned|claim|part of/);
  const actual = server.stats().slice(before);
  assert.equal(actual.length, targets.length, "one new GET for each source, no implicit retry or unsupported download");
  assert.ok(actual.every(item => item.path === "/media-downloads/selected.png" && item.method === "GET"));
  assert.deepEqual(actual.map(item=>item.scope),["root","root","shadow-root","same","cross","nested"]);
  // The cross-site document's Set-Cookie is subject to third-party policy.
  // A downloads GET does not promise that document's partitioned credentials.
  assert.ok(actual.filter(item=>item.scope!=="cross").every(item=>item.cookie));
  assert.deepEqual(await tab.evaluate("({events:mediaEvents,traps:getterTraps})"), {events:[],traps:[]});
  return { files:results, requests:actual, isolatedGetters:true, inputEvents:[], unsupportedRejected:5, strictness:true, foreignDenied:true };
}

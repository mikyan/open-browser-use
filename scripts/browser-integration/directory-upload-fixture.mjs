import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { chooserVariants, chooserScope } from "./chooser-waits-fixture.mjs";
import { observeChooserFailure } from "./chooser-failure-observation.mjs";

const hash = bytes => createHash("sha256").update(bytes).digest("hex");
const errorRecord = error => ({ name: error?.name ?? "Error", message: String(error?.message ?? error), stack: error?.stack });
const sorted = files => [...files].sort((a, b) => a.relativePath.localeCompare(b.relativePath, "en"));
const metadata = files => sorted(files.map(({ name, size, relativePath }) => ({ name, size, relativePath })));
const route = "/directory-upload/";
const keyPattern = /^[a-z0-9-]{1,100}$/;

export function directoryPageHTML(url, port) {
  const key = url.searchParams.get("key"), variant = url.searchParams.get("variant");
  assert.match(key, keyPattern); assert.ok(chooserVariants.includes(variant));
  const root = url.pathname.endsWith("/page"), upload = !root || variant === "root";
  const childURL = `http://localhost:${port}${route}frame?` + new URLSearchParams({ key, variant });
  return `<!doctype html><meta charset="utf-8"><title>Directory upload fixture</title>
    <style>body{font:16px sans-serif}button,input{padding:12px;margin:15px}iframe{width:650px;height:280px}</style>
    ${upload ? '<label>Upload directory<input id="upload" type="file" webkitdirectory multiple></label><output id="receipt"></output>' : ""}
    ${root && variant === "oopif" ? `<iframe id="upload-frame" src="${childURL}"></iframe>` : ""}
    ${root && variant === "dynamic-oopif" ? '<button id="add-frame">Add upload frame</button>' : ""}
    <script>
      const key=${JSON.stringify(key)},variant=${JSON.stringify(variant)};
      globalThis.directoryEvidence={documentToken:crypto.randomUUID(),inputToken:crypto.randomUUID(),clicks:[],events:[],frameAdds:[],errors:[]};
      const input=document.querySelector('#upload'),add=document.querySelector('#add-frame');
      if(add)add.onclick=event=>{directoryEvidence.frameAdds.push({trusted:event.isTrusted});const frame=document.createElement('iframe');frame.id='upload-frame';frame.src=${JSON.stringify(childURL)};document.body.append(frame);add.disabled=true};
      if(input){
        input.onclick=event=>directoryEvidence.clicks.push({trusted:event.isTrusted});
        for(const type of ['input','change','cancel'])input.addEventListener(type,event=>{
          const chosen=[...input.files],files=chosen.map(file=>({name:file.name,size:file.size,relativePath:file.webkitRelativePath}));
          const record={key,variant,documentToken:directoryEvidence.documentToken,inputToken:directoryEvidence.inputToken,href:location.href,sequence:directoryEvidence.clicks.length,eventIndex:directoryEvidence.events.length+1,event:type,trusted:event.isTrusted,files,clicks:[...directoryEvidence.clicks],input:{id:input.id,type:input.type,webkitdirectory:input.webkitdirectory,multiple:input.multiple,connected:input.isConnected,originalNode:event.target===input&&document.querySelector('#upload')===input}};
          directoryEvidence.events.push(record);
          // Synchronous short metadata only. The server never waits for the SDK.
          // The checker snapshots its memory in the SDK resolution continuation,
          // before any subsequent browser request or receipt polling.
          try{const request=new XMLHttpRequest();request.open('POST','${route}witness?'+new URLSearchParams({key,variant}),false);request.setRequestHeader('Content-Type','application/json');request.send(JSON.stringify(record));if(request.status!==200)throw new Error('witness HTTP '+request.status)}catch(error){directoryEvidence.errors.push(String(error));throw error}
          if(type==='change')void(async()=>{
            const payload=await Promise.all(chosen.map(async(file,index)=>{const bytes=new Uint8Array(await file.arrayBuffer());let raw='';for(const byte of bytes)raw+=String.fromCharCode(byte);return{...files[index],base64:btoa(raw)}}));
            const response=await fetch('${route}upload?'+new URLSearchParams({key,variant}),{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({...record,files:payload})});
            const receipt=await response.json();if(!response.ok)throw new Error(JSON.stringify(receipt));document.querySelector('#receipt').textContent=JSON.stringify(receipt);
          })().catch(error=>directoryEvidence.errors.push(String(error)));
        },{capture:true});
      }
    </script>`;
}

export function createDirectoryUploadFixtures() {
  const records = new Map();
  const entry = key => { if (!records.has(key)) records.set(key, { key, witnesses: [], posts: [] }); return records.get(key); };
  return {
    stats: key => structuredClone(entry(key)), allStats: () => [...records.values()].map(value => structuredClone(value)),
    handle(request, response, portOrURL) {
      const url = portOrURL instanceof URL ? portOrURL : new URL(request.url, `http://${request.headers.host ?? "127.0.0.1"}`);
      if (!url.pathname.startsWith(route)) return false;
      const key = url.searchParams.get("key"), variant = url.searchParams.get("variant");
      if (!keyPattern.test(key ?? "") || !chooserVariants.includes(variant)) { response.writeHead(400); response.end("invalid key/variant"); return true; }
      response.setHeader("Cache-Control", "no-store");
      if ([route + "page", route + "frame"].includes(url.pathname) && request.method === "GET") {
        const port = typeof portOrURL === "number" ? portOrURL : Number(url.port || new URL(`http://${request.headers.host}`).port);
        assert.ok(Number.isInteger(port) && port > 0 && port <= 65535);
        response.setHeader("Content-Type", "text/html; charset=utf-8"); response.end(directoryPageHTML(url, port)); return true;
      }
      if (![route + "witness", route + "upload"].includes(url.pathname) || request.method !== "POST") { response.writeHead(404); response.end(); return true; }
      const record = entry(key), witness = url.pathname.endsWith("/witness");
      const hit = { at: Date.now(), method: request.method, variant }; (witness ? record.witnesses : record.posts).push(hit);
      const chunks = []; let length = 0;
      const limit = witness ? 64 * 1024 : 256 * 1024;
      request.on("data", chunk => { length += chunk.length; if (length <= limit) chunks.push(chunk); });
      request.once("aborted", () => { hit.error = "HTTP request aborted"; });
      request.once("error", error => { hit.error = String(error.message); });
      request.on("end", () => {
        try {
          assert.ok(length <= limit, "Directory fixture body too large");
          const body = Buffer.concat(chunks), value = JSON.parse(body.toString("utf8"));
          hit.bodyBytes = length; hit.bodyBase64 = body.toString("base64"); hit.bodySHA256 = hash(body);
          assert.equal(value.key, key); assert.equal(value.variant, variant);
          assert.ok(Number.isSafeInteger(value.sequence) && value.sequence > 0);
          assert.ok(Number.isSafeInteger(value.eventIndex) && value.eventIndex > 0);
          assert.ok(["input", "change", "cancel"].includes(value.event)); assert.equal(typeof value.trusted, "boolean");
          assert.ok(typeof value.documentToken === "string" && value.documentToken.length > 0 && value.documentToken.length <= 128);
          assert.ok(typeof value.inputToken === "string" && value.inputToken.length > 0 && value.inputToken.length <= 128);
          assert.ok(Array.isArray(value.files) && value.files.length <= 64);
          for (const file of value.files) {
            assert.ok(typeof file.name === "string" && file.name.length > 0);
            assert.ok(typeof file.relativePath === "string" && file.relativePath.length > 0 && !file.relativePath.includes("\\") && !file.relativePath.startsWith("/") && !file.relativePath.split("/").includes(".."));
            assert.ok(Number.isSafeInteger(file.size) && file.size >= 0);
          }
          assert.equal(new Set(value.files.map(file => file.relativePath)).size, value.files.length);
          hit.value = value;
          if (!witness) {
            assert.equal(value.event, "change");
            hit.files = sorted(value.files.map(file => {
              const bytes = Buffer.from(file.base64, "base64"); assert.equal(bytes.toString("base64"), file.base64); assert.equal(bytes.length, file.size);
              return { name: file.name, relativePath: file.relativePath, size: bytes.length, sha256: hash(bytes) };
            }));
          }
          hit.receipt = { key, variant, sequence: value.sequence, eventIndex: value.eventIndex, documentToken: value.documentToken, ...(witness ? { event: value.event } : { files: hit.files }) };
          response.setHeader("Content-Type", "application/json"); response.end(JSON.stringify(hit.receipt));
        } catch (error) { hit.error = String(error.message); response.writeHead(400, { "Content-Type": "application/json" }); response.end(JSON.stringify({ error: hit.error })); }
      });
      return true;
    }
  };
}

export async function prepareDirectoryFiles(runDir) {
  const root = path.join(runDir, "directory-资料"), empty = path.join(runDir, "directory-empty");
  await fs.mkdir(root); await fs.mkdir(empty);
  for (const child of ["甲", "乙", "嵌套/更深", "空子目录"]) await fs.mkdir(path.join(root, child), { recursive: true });
  const values = [
    ["中文.txt", Buffer.from("Directory upload 中文🙂\n")], ["甲/same.txt", Buffer.from("first same name\n")],
    ["乙/same.txt", Buffer.from("second same name\n")], ["嵌套/更深/binary.dat", Buffer.from([0, 1, 127, 128, 254, 255, 10])], ["zero.bin", Buffer.alloc(0)]
  ];
  const files = [];
  for (const [relative, bytes] of values) {
    const filename = path.join(root, relative); await fs.writeFile(filename, bytes, { flag: "wx" });
    files.push({ path: filename, name: path.basename(filename), relativePath: `${path.basename(root)}/${relative}`, size: bytes.length, sha256: hash(bytes) });
  }
  return { root, empty, missing: path.join(runDir, "directory-does-not-exist"), files: sorted(files) };
}

function parsedHit(hit) {
  assert.equal(hit.error, undefined); assert.equal(hit.method, "POST");
  const bytes = Buffer.from(hit.bodyBase64, "base64"); assert.equal(bytes.length, hit.bodyBytes); assert.equal(hash(bytes), hit.bodySHA256);
  const value = JSON.parse(bytes.toString("utf8")); assert.deepEqual(value, hit.value); return value;
}

export function checkDirectoryImmediate(record, { sequence, files, documentToken, inputToken, clear = false }) {
  const events = record.witnesses.map(parsedHit).filter(value => value.sequence === sequence);
  const inputs = events.filter(value => value.event === "input"), cancels = events.filter(value => value.event === "cancel");
  assert.ok(inputs.length === 1 && cancels.length === 0,
    "setFileChooserFiles returned before a unique directory completion witness (no polling permitted)");
  assert.ok(events.filter(value => value.event === "change").length <= 1, "Duplicate directory change");
  const completed = inputs[0];
  assert.equal(completed.trusted, !clear); assert.deepEqual(metadata(completed.files), metadata(files));
  assert.deepEqual(completed.input, { id: "upload", type: "file", webkitdirectory: true, multiple: true, connected: true, originalNode: true });
  assert.deepEqual(completed.clicks, Array.from({ length: sequence }, () => ({ trusted: true })));
  if (documentToken !== undefined) assert.equal(completed.documentToken, documentToken, "Directory chooser changed document");
  assert.ok(typeof completed.inputToken === "string" && completed.inputToken.length > 0);
  if (inputToken !== undefined) assert.equal(completed.inputToken, inputToken, "Directory chooser changed its original input node");
  return completed;
}

export function checkDirectoryRound(record, options) {
  const completed = checkDirectoryImmediate(record, options);
  const witnesses = record.witnesses.map(parsedHit).filter(value => value.sequence === options.sequence);
  assert.deepEqual(witnesses.map(value => value.event), ["input", "change"]);
  for (const value of witnesses) {
    assert.equal(value.documentToken, completed.documentToken); assert.equal(value.inputToken, completed.inputToken); assert.equal(value.trusted, completed.trusted);
    assert.deepEqual(metadata(value.files), metadata(options.files)); assert.deepEqual(value.input, completed.input); assert.deepEqual(value.clicks, completed.clicks);
  }
  const posts = record.posts.filter(hit => hit.value?.sequence === options.sequence);
  assert.equal(posts.length, 1);
  for (const hit of posts) {
    const value = parsedHit(hit), change = witnesses.find(value => value.event === "change");
    assert.deepEqual({ ...value, files: metadata(value.files) }, { ...change, files: metadata(change.files) });
    const actual = sorted(value.files.map(file => {
      const bytes = Buffer.from(file.base64, "base64"); assert.equal(bytes.toString("base64"), file.base64); assert.equal(bytes.length, file.size);
      return { name: file.name, relativePath: file.relativePath, size: bytes.length, sha256: hash(bytes) };
    }));
    const expected = sorted(options.files.map(({ name, relativePath, size, sha256 }) => ({ name, relativePath, size, sha256 })));
    assert.deepEqual(actual, expected); assert.deepEqual(hit.files, expected); assert.deepEqual(hit.receipt.files, expected);
  }
  return { completion: completed.event, files: metadata(options.files), posts: posts.length };
}

async function frameEvidence(worker, tabId, expectedURL, variant) {
  const evidence = await worker.evaluate(`(async()=>({frames:await chrome.webNavigation.getAllFrames({tabId:${tabId}}),targets:await chrome.debugger.getTargets(),attachedTargets:globalThis.__integrationFrames.filter(target=>target.tabId===${tabId})}))()`);
  if (variant !== "root") {
    const root = evidence.frames.find(frame => frame.frameId === 0), frames = evidence.frames.filter(frame => frame.parentFrameId === 0 && frame.url === expectedURL);
    assert.equal(frames.length, 1); assert.ok(root && root.processId !== frames[0].processId, "Directory child must be a real OOPIF");
    const targets = evidence.targets.filter(target => target.url === expectedURL && target.attached === true); assert.equal(targets.length, 1);
    const attached = evidence.attachedTargets.filter(value => value.source?.tabId === tabId && value.source.sessionId === undefined && value.type === "iframe" && value.targetId === targets[0].id && value.sessionId);
    assert.equal(attached.length, 1, "Directory child must have one exact root attachment");
    evidence.target = { tabId, sessionId: attached[0].sessionId };
  } else evidence.target = { tabId };
  return evidence;
}

export async function checkDirectoryUpload({ browser, fixtureURL, server, files, worker, until, createTab = () => browser.newTab() }) {
  const detail = { caller: "js", independentConnections: true, variants: [] };
  let trigger, failure;
  try {
    // Use the exact loaded public SDK constructor, not a second imported build.
    trigger = new browser.constructor({ socketPath: browser.client.socketPath, sessionId: browser.client.sessionId, turnId: browser.client.turnId, timeoutMs: browser.client.timeoutMs });
    await trigger.connect(); await browser.client.getTabs(); await trigger.client.getTabs();
    assert.notEqual(browser.client, trigger.client); detail.scope = chooserScope(browser); assert.deepEqual(chooserScope(trigger), detail.scope);
    detail.info = await browser.client.getInfo(); // Record capability, but run old-production reproduction too.
    for (const variant of chooserVariants) {
      const key = `directory-${variant}-${randomUUID()}`, item = { key, variant, rounds: [] }; detail.variants.push(item);
      try {
        const tab = await createTab(); item.tabId = tab.id;
        const url = new URL(route + "page", fixtureURL); url.search = new URLSearchParams({ key, variant }).toString();
        await browser.cdp.navigate(tab.id, url.href);
        const documentURL = new URL(url); if (variant !== "root") { documentURL.hostname = "localhost"; documentURL.pathname = route + "frame"; }
        const sender = trigger.tab(tab.id), input = (variant === "root" ? sender : sender.frameLocator("#upload-frame")).getByLabel("Upload directory", { exact: true });
        const cases = [
          { name: "directory", paths: [files.root], expected: files.files },
          { name: "repeat-directory", paths: [files.root], expected: files.files },
          ...(variant === "root" ? [{ name: "explicit-clear", paths: [], expected: [], clear: true }] : []),
          { name: "empty-directory", paths: [files.empty], expected: [] },
          { name: "repeat-empty-directory", paths: [files.empty], expected: [] },
          ...(variant === "root" ? [{ name: "missing-directory", paths: [files.missing], invalid: true },
            { name: "file-as-directory", paths: [files.files[0].path], invalid: true },
            { name: "multiple-directories", paths: [files.root, files.empty], invalid: true }] : [])
        ];
        for (const [index, spec] of cases.entries()) {
          const sequence = index + 1, round = { sequence, name: spec.name, paths: spec.paths, armStartedAt: Date.now() }; item.rounds.push(round);
          let wait, roundFailure;
          try {
            wait = await tab.expectFileChooser({ timeoutMs: 10000 }); round.readyAt = Date.now(); round.waiterId = wait.waiterId; round.remainingMs = wait.remainingMs;
            if (variant === "dynamic-oopif" && sequence === 1) { round.addFrameStartedAt = Date.now(); await sender.getByRole("button", { name: "Add upload frame", exact: true }).click(); round.addFrameCompletedAt = Date.now(); }
            round.clickStartedAt = Date.now(); await input.click(); round.clickCompletedAt = Date.now();
            round.chooser = await wait.result(); round.collectedAt = Date.now(); assert.equal(round.chooser.isMultiple, true);
            if (!item.frames) item.frames = await frameEvidence(worker, tab.id, documentURL.href, variant);
            assert.deepEqual(chooserScope(browser), detail.scope); assert.deepEqual(chooserScope(trigger), detail.scope);
            round.before = server.stats(key); round.setStartedAt = Date.now();
            // No await, CDP observation, sleep or receipt polling may occur between
            // API resolution and this independent server-memory snapshot.
            await browser.client.setFileChooserFiles(round.chooser.fileChooserId, spec.paths).then(value => {
              round.atReturn = server.stats(key); round.setCompletedAt = Date.now(); round.result = value ?? null;
            }, error => { round.atReturn = server.stats(key); round.setFailedAt = Date.now(); round.setError = errorRecord(error); if (!spec.invalid) throw error; });
            if (spec.invalid) {
              assert.ok(round.setError, "Invalid directory argument was silently accepted");
              assert.doesNotMatch(round.setError.message, /timed out|timeout|deadline|OBU_STALE_CONTROL|OBU_AUTOMATION_PAUSED/i, "Invalid directory needs an explicit rejection, not timeout/revocation");
              assert.deepEqual(round.atReturn.posts, round.before.posts, "Invalid directory uploaded bytes");
              const extra = round.atReturn.witnesses.slice(round.before.witnesses.length).map(parsedHit);
              assert.ok(extra.every(value => value.event === "cancel" && value.trusted === true), "Invalid directory emitted a successful selection event");
            } else {
              const expected = { sequence, files: spec.expected, documentToken: item.documentToken, inputToken: item.inputToken, clear: spec.clear };
              const witness = checkDirectoryImmediate(round.atReturn, expected); item.documentToken ??= witness.documentToken; item.inputToken ??= witness.inputToken;
              assert.equal(witness.href, documentURL.href);
              await until(() => {
                const stats = server.stats(key), posts = stats.posts.filter(hit => hit.value?.sequence === sequence);
                assert.ok(posts.length <= 1, "Duplicate directory upload POST"); return posts.length === 1 && posts[0].receipt;
              }, "directory upload byte receipt after return-time witness");
              round.after = server.stats(key); round.checked = checkDirectoryRound(round.after, expected);
              round.repeatStartedAt = Date.now();
              await assert.rejects(browser.client.setFileChooserFiles(round.chooser.fileChooserId, spec.paths), /OBU_FILE_CHOOSER_CONSUMED|Unknown or unowned file chooser id/);
              round.repeatCompletedAt = Date.now(); round.afterRepeat = server.stats(key); assert.deepEqual(round.afterRepeat, round.after, "Consumed chooser produced more events/POSTs");
            }
            round.passed = true;
          } catch (error) {
            roundFailure = error; round.error = errorRecord(error);
            await observeChooserFailure({ worker, item, fixtureURL, fixtureKind: "directory" });
            throw error;
          }
          finally {
            if (wait) { round.cancelStartedAt = Date.now(); try { await wait.cancel(); round.cancelCompletedAt = Date.now(); } catch (error) { round.cancelError = errorRecord(error); if (!roundFailure) throw error; } }
          }
        }
        item.framesAtEnd = await frameEvidence(worker, tab.id, documentURL.href, variant); assert.deepEqual(item.framesAtEnd.target, item.frames.target);
        if (variant === "dynamic-oopif") { item.frameAdds = await tab.evaluate("directoryEvidence.frameAdds"); assert.deepEqual(item.frameAdds, [{ trusted: true }]); }
        assert.deepEqual(chooserScope(browser), detail.scope); assert.deepEqual(chooserScope(trigger), detail.scope);
        // A later native callback must not silently add success evidence to an
        // earlier rejected round while subsequent cases were running.
        item.finalServer = server.stats(key);
        const finalEvents = item.finalServer.witnesses.map(parsedHit);
        assert.deepEqual(finalEvents.map(value => value.eventIndex), Array.from({ length: finalEvents.length }, (_, index) => index + 1));
        assert.ok(finalEvents.every(value => Number.isSafeInteger(value.sequence) && value.sequence >= 1 && value.sequence <= cases.length));
        assert.ok(item.finalServer.posts.every(hit => hit.value && Number.isSafeInteger(hit.value.sequence) && hit.value.sequence >= 1 && hit.value.sequence <= cases.length && !hit.error));
        for (const [index, spec] of cases.entries()) {
          if (!spec.invalid) checkDirectoryRound(item.finalServer, { sequence: index + 1, files: spec.expected, documentToken: item.documentToken, inputToken: item.inputToken, clear: spec.clear });
          else {
            assert.equal(item.finalServer.posts.filter(hit => hit.value?.sequence === index + 1).length, 0);
            const extra = item.finalServer.witnesses.map(parsedHit).filter(value => value.sequence === index + 1);
            assert.ok(extra.every(value => value.event === "cancel" && value.trusted === true), "Rejected directory later emitted successful input");
          }
        }
        item.passed = true;
      } catch (error) { item.error = errorRecord(error); throw error; }
      finally { item.serverAtEnd = server.stats(key); }
    }
    return detail;
  } catch (error) {
    failure = error;
    try { error.chooserDetail = detail; error.directoryDetail = detail; } catch { /* Preserve frozen/read-only original errors. */ }
    throw error;
  }
  finally { if (trigger) try { trigger.close(); } catch (error) {
    detail.closeError = errorRecord(error);
    if (!failure) { try { error.chooserDetail = detail; error.directoryDetail = detail; } catch { /* Preserve the cleanup error itself. */ } throw error; }
  } }
}

export function checkInactiveDirectoryCancellation(record, { key, url }) {
  assert.equal(record.key, key); assert.deepEqual(record.posts, [], "Inactive directory selection uploaded bytes");
  assert.equal(record.witnesses.length, 1, "Inactive directory selection needs one real terminal cancel event");
  const value = parsedHit(record.witnesses[0]);
  assert.equal(value.key, key); assert.equal(value.variant, "root"); assert.equal(value.href, url);
  assert.equal(value.event, "cancel"); assert.equal(value.trusted, true);
  assert.equal(value.sequence, 1); assert.equal(value.eventIndex, 1); assert.deepEqual(value.files, []);
  assert.deepEqual(value.clicks, [{ trusted: true }]);
  assert.ok(typeof value.documentToken === "string" && value.documentToken.length > 0);
  assert.ok(typeof value.inputToken === "string" && value.inputToken.length > 0);
  assert.deepEqual(value.input, { id: "upload", type: "file", webkitdirectory: true, multiple: true, connected: true, originalNode: true });
  return value;
}

// Chromium's inactive-tab restriction remains a real negative result. This
// checks explicit native cancel, not an early ACK, timeout, or empty selection.
export async function checkInactiveDirectoryRejection({ browser, fixtureURL, server, files, worker, expectedWindowId }) {
  const key = `directory-inactive-${randomUUID()}`, url = new URL(route + "page", fixtureURL);
  url.search = new URLSearchParams({ key, variant: "root" }).toString();
  const detail = { key, url: url.href, startedAt: Date.now(), boundary: "Default inactive newTab remains unable to enumerate this directory; explicit trusted native cancel and no upload are the expected negative result, not directory capability success." };
  let trigger, wait, failure;
  try {
    trigger = new browser.constructor({ socketPath: browser.client.socketPath, sessionId: browser.client.sessionId, turnId: browser.client.turnId, timeoutMs: browser.client.timeoutMs });
    await trigger.connect(); await browser.client.getTabs(); await trigger.client.getTabs();
    assert.notEqual(browser.client, trigger.client); detail.scope = chooserScope(browser); assert.deepEqual(chooserScope(trigger), detail.scope);
    const tab = await browser.newTab(); detail.tabId = tab.id;
    await browser.cdp.navigate(tab.id, url.href);
    detail.nativeBefore = await worker.evaluate(`(async()=>{const tab=await chrome.tabs.get(${tab.id});return{tab,window:await chrome.windows.get(tab.windowId)}})()`);
    assert.equal(detail.nativeBefore.tab.id, tab.id); assert.equal(detail.nativeBefore.tab.active, false);
    assert.equal(detail.nativeBefore.tab.windowId, expectedWindowId); assert.equal(detail.nativeBefore.window.id, expectedWindowId);
    detail.armStartedAt = Date.now(); wait = await tab.expectFileChooser({ timeoutMs: 10000 });
    detail.readyAt = Date.now(); detail.remainingMs = wait.remainingMs; detail.waiterId = wait.waiterId;
    detail.clickStartedAt = Date.now(); await trigger.tab(tab.id).getByLabel("Upload directory", { exact: true }).click(); detail.clickCompletedAt = Date.now();
    detail.chooser = await wait.result(); detail.collectedAt = Date.now(); assert.equal(detail.chooser.isMultiple, true);
    detail.before = server.stats(key); assert.deepEqual(detail.before.witnesses, []); assert.deepEqual(detail.before.posts, []);
    detail.setStartedAt = Date.now();
    await browser.client.setFileChooserFiles(detail.chooser.fileChooserId, [files.root]).then(value => {
      detail.atReturn = server.stats(key); detail.setCompletedAt = Date.now(); detail.result = value ?? null;
    }, error => { detail.atReturn = server.stats(key); detail.setFailedAt = Date.now(); detail.setError = errorRecord(error); });
    assert.ok(detail.setError, "Inactive directory setter incorrectly reported successful completion");
    assert.match(detail.setError.message, /^OBU_DIRECTORY_UPLOAD_CANCELLED:/, "Inactive selection must be a native cancel, not an unrelated rejection/timeout");
    detail.cancelWitness = checkInactiveDirectoryCancellation(detail.atReturn, detail);
    detail.nativeAfter = await worker.evaluate(`(async()=>{const tab=await chrome.tabs.get(${tab.id});return{tab,window:await chrome.windows.get(tab.windowId)}})()`);
    assert.equal(detail.nativeAfter.tab.id, tab.id); assert.equal(detail.nativeAfter.tab.active, false); assert.equal(detail.nativeAfter.tab.windowId, expectedWindowId);
    assert.deepEqual(chooserScope(browser), detail.scope); assert.deepEqual(chooserScope(trigger), detail.scope);
    detail.passed = true; return detail;
  } catch (error) { failure = error; detail.passed = false; detail.error = errorRecord(error); error.directoryDetail = detail; throw error; }
  finally {
    if (wait) {
      try { await wait.cancel(); detail.cancelCompletedAt = Date.now(); }
      catch (error) { detail.cancelError = errorRecord(error); if (!failure) { failure = error; error.directoryDetail = detail; } }
    }
    if (trigger) try { trigger.close(); } catch (error) { detail.closeError = errorRecord(error); if (!failure) { failure = error; error.directoryDetail = detail; } }
    detail.finalServer = server.stats(key);
    if (!failure) {
      try { checkInactiveDirectoryCancellation(detail.finalServer, detail); assert.deepEqual(detail.finalServer, detail.atReturn, "Inactive selection produced late events after returning"); }
      catch (error) { failure = error; error.directoryDetail = detail; }
    }
    if (failure) { detail.passed = false; if (!detail.error) { detail.error = errorRecord(failure); throw failure; } }
  }
}

import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { chooserScope } from "./chooser-waits-fixture.mjs";
import { installCountedPointerEvidence, installCountedPointerProbe } from "./pointer-delivery-cases.mjs";

const route = "/transformed-pointer/";
const hash = bytes => createHash("sha256").update(bytes).digest("hex");
const errorText = error => error?.stack ?? String(error);
export const transformedPointerCases = Object.freeze([
  { name: "scale-same", layout: "same", mutation: null, outcome: "success" },
  { name: "rotate-oopif", layout: "oopif", mutation: null, outcome: "success" },
  { name: "nested-mixed", layout: "nested", mutation: null, outcome: "success" },
  { name: "cover-after-move", layout: "same", mutation: "cover-move", outcome: "no-buttons" },
  { name: "shift-after-move", layout: "same", mutation: "shift-move", outcome: "success" },
  { name: "cover-after-first", layout: "nested", mutation: "cover-click", outcome: "partial" },
  { name: "rotate-narrow", layout: "oopif", mutation: null, outcome: "success", position: Object.freeze({ x: 6, y: 6 }) }
].map(Object.freeze));
const keyPattern = new RegExp(`^transformed-([a-f0-9]{32})-(${transformedPointerCases.map(value => value.name).join("|")})$`);
function specFor(key) {
  const match = keyPattern.exec(key ?? ""); assert.ok(match, "Invalid transformed fixture key");
  return transformedPointerCases.find(value => value.name === match[2]);
}

export function transformedPointerURLs(base, key) {
  const spec = specFor(key), root = new URL(`${route}page`, base); root.search = new URLSearchParams({ key });
  const target = new URL(root); target.pathname = `${route}frame`; target.searchParams.set("role", "target");
  if (spec.layout !== "same") target.hostname = "localhost";
  const middle = spec.layout === "nested" ? new URL(target) : null;
  if (middle) middle.searchParams.set("role", "middle");
  return { root: root.href, middle: middle?.href ?? null, target: target.href };
}

// Page behavior is deliberately adversarial in three cases. Only genuine target
// events trigger the one-time parent mutation; no input is synthesized here.
// The target and its immediate parent are same-origin even in the nested OOPIF
// case, so the mutation is synchronous rather than a postMessage timing guess.
export function installTransformedPointerDocument(config, recordEvents) {
  const { key, spec, role } = config;
  const node = document.querySelector("#target"), frame = document.querySelector("#transform-frame"), cover = document.querySelector("#cover");
  const evidence = globalThis.transformedPointerEvidence = {
    key, caseName: spec.name, role, documentToken: crypto.randomUUID(), clicks: 0, posts: 0, mutations: []
  };
  recordEvents(document, evidence, node);
  const rect = element => { const value = element.getBoundingClientRect(); return { x: value.x, y: value.y, width: value.width, height: value.height }; };
  const describe = element => {
    if (!element) return null;
    const style = getComputedStyle(element);
    return { id: element.id, connected: element.isConnected, rect: rect(element), transform: style.transform,
      transformOrigin: style.transformOrigin, zoom: style.zoom, display: style.display, visibility: style.visibility,
      borderLeft: style.borderLeftWidth, borderTop: style.borderTopWidth, paddingLeft: style.paddingLeft, paddingTop: style.paddingTop };
  };
  const geometry = () => ({ viewport: { width: innerWidth, height: innerHeight, devicePixelRatio, scrollX, scrollY },
    target: describe(node), frame: describe(frame), wrapper: describe(document.querySelector("#transform-wrapper")), cover: describe(cover) });
  globalThis.readTransformedPointerDocument = () => ({ key, href: location.href, role, evidence: structuredClone(evidence),
    geometry: geometry(), originalNodeConnected: node?.isConnected ?? null, visibleResult: document.querySelector("#result")?.textContent ?? null });
  globalThis.mutateTransformedParent = (source, trigger) => {
    if (!frame || source !== frame.contentWindow || evidence.mutations.length || !spec.mutation) throw Error("Unexpected transformed mutation identity");
    if (trigger.key !== key || trigger.trusted !== true || trigger.originalNode !== true || typeof trigger.documentToken !== "string") throw Error("Invalid transformed trigger");
    const before = geometry();
    if (spec.mutation === "shift-move") frame.style.transform += " translate(150px, 36px)";
    else cover.style.display = "block";
    const mutation = { kind: spec.mutation, parentDocumentToken: evidence.documentToken, trigger, before, after: geometry() };
    evidence.mutations.push(mutation); return structuredClone(mutation);
  };
  const mutate = event => {
    if (evidence.mutations.length) return;
    const trigger = { key, documentToken: evidence.documentToken, type: event.type, trusted: event.isTrusted,
      originalNode: event.target === node, recordSequence: evidence.records.at(-1)?.sequence, timeStamp: event.timeStamp,
      clientX: event.clientX, clientY: event.clientY, pointerType: event.pointerType ?? null, isPrimary: event.isPrimary ?? null, buttons: event.buttons };
    try { evidence.mutations.push(parent.mutateTransformedParent(window, trigger)); }
    catch (error) { evidence.errors.push(String(error)); }
  };
  if (node) {
    node.addEventListener("pointermove", event => {
      if (spec.mutation?.endsWith("-move") && event.isTrusted && event.pointerType === "mouse" && event.isPrimary && event.buttons === 0) mutate(event);
    }, { passive: true });
    node.addEventListener("click", event => {
      evidence.clicks++; document.querySelector("#result").textContent = `${evidence.clicks} clicks`;
      if (spec.mutation === "cover-click" && evidence.clicks === 1) mutate(event);
      evidence.posts++;
      const body = { key, caseName: spec.name, href: location.href, trusted: event.isTrusted,
        documentToken: evidence.documentToken, evidence: structuredClone(evidence) };
      fetch(`/transformed-pointer/post?${new URLSearchParams({ key })}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) })
        .then(response => { if (!response.ok) throw Error(`Receipt HTTP ${response.status}`); return response.json(); })
        .then(receipt => { evidence.receipt = receipt; }).catch(error => evidence.errors.push(String(error)));
    });
  }
}

export function transformedPointerHTML(url) {
  const key = url.searchParams.get("key"), spec = specFor(key);
  const role = url.pathname === `${route}page` ? "root" : url.searchParams.get("role");
  assert.ok(role === "root" || url.pathname === `${route}frame` && ["middle", "target"].includes(role));
  assert.ok(role !== "middle" || spec.layout === "nested");
  const urls = transformedPointerURLs(url, key), ownsFrame = role !== "target";
  const child = role === "root" ? urls.middle ?? urls.target : urls.target;
  // Keep the target well inside both viewports. Positive cases exercise a
  // transformed owner and a transformed non-frame ancestor, plus nested maps.
  const wrapperTransform = role === "root" && spec.layout !== "same" ? "rotate(9deg)" : "none";
  const frameTransform = role === "middle" ? "rotate(-7deg) scale(0.92,1.08)" : "scale(0.86,1.09)";
  const narrowStyle = spec.name === "rotate-narrow" ? "#target{left:137.25px;top:91.5px;width:12px;height:12px;overflow:hidden;font-size:1px}" : "";
  return `<!doctype html><meta charset="utf-8"><title>Transformed pointer ${key} ${role}</title>
<style>html,body{margin:0;background:#f8fafc;font:16px sans-serif}#transform-wrapper{position:absolute;left:${role === "middle" ? 24.25 : 110.25}px;top:${role === "middle" ? 25.5 : 95.5}px;transform:${wrapperTransform};transform-origin:31px 19px}iframe{display:block;width:${role === "middle" ? 420 : 610}px;height:${role === "middle" ? 240 : 350}px;border:4px solid #334155;padding:0;transform-origin:23px 17px}#target{position:absolute;left:55.25px;top:65.5px;width:176px;height:64px;margin:0;border:0;padding:0;background:#22c55e;color:#052e16}#result{position:absolute;left:55px;top:145px}#cover{display:none;position:fixed;inset:0;background:rgba(239,68,68,.8);z-index:2147483647}${narrowStyle}</style>
${ownsFrame ? `<div id="transform-wrapper"><iframe id="transform-frame" title="Transformed ${role === "root" && urls.middle ? "middle" : "target"}" src="${child}" style="transform:${frameTransform}"></iframe></div><div id="cover">Parent obstruction</div>` : '<button id="target">Transformed receipt</button><output id="result">0 clicks</output>'}
<script>(${installTransformedPointerDocument.toString()})(${JSON.stringify({ key, spec, role })},${installCountedPointerEvidence.toString()});</script>`;
}

export function createTransformedPointerFixtures() {
  const records = new Map();
  const entry = key => { specFor(key); if (!records.has(key)) records.set(key, { key, gets: [], posts: [] }); return records.get(key); };
  return {
    stats: key => structuredClone(entry(key)), allStats: () => structuredClone([...records.values()]),
    handle(request, response, url) {
      if (![`${route}page`, `${route}frame`, `${route}post`].includes(url.pathname)) return false;
      const key = url.searchParams.get("key");
      if (!keyPattern.test(key ?? "")) { response.writeHead(400); response.end("Invalid transformed key"); return true; }
      const record = entry(key);
      if (url.pathname !== `${route}post`) {
        if (request.method !== "GET") { response.writeHead(405); response.end(); return true; }
        let html; try { html = transformedPointerHTML(url); } catch { response.writeHead(400); response.end("Invalid transformed page"); return true; }
        const bytes = Buffer.from(html); record.gets.push({ at: Date.now(), url: url.href, method: "GET", bytes: bytes.length, sha256: hash(bytes) });
        response.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" }); response.end(html); return true;
      }
      if (request.method !== "POST") { response.writeHead(405); response.end(); return true; }
      const post = { receivedAt: Date.now(), method: "POST", url: url.href }; record.posts.push(post);
      const chunks = []; let size = 0;
      request.on("data", chunk => { size += chunk.length; if (size <= 192 * 1024) chunks.push(chunk); });
      request.once("aborted", () => { post.error = "HTTP request aborted"; });
      request.once("error", error => { post.error = String(error); });
      request.once("end", () => {
        const bytes = Buffer.concat(chunks);
        Object.assign(post, { completedAt: Date.now(), bodyBytes: size, bodyBase64: bytes.toString("base64"), bodySHA256: hash(bytes) });
        try {
          assert.ok(size <= 192 * 1024); post.value = JSON.parse(bytes.toString("utf8")); assert.equal(post.value.key, key);
          post.receipt = { key, index: record.posts.length, bodySHA256: post.bodySHA256 };
          response.writeHead(200, { "Content-Type": "application/json" }); response.end(JSON.stringify(post.receipt));
        } catch (error) { post.error = errorText(error); response.writeHead(400); response.end("Invalid transformed receipt"); }
      });
      return true;
    }
  };
}

export function checkTransformedPointerTrace(probe, spec) {
  assert.equal(probe?.version, 1); assert.equal(probe.mode, "observe"); assert.equal(probe.dropped, 0);
  assert.equal(probe.restored, true); assert.equal(probe.overflow, false); assert.equal(probe.recordingErrors, 0); assert.equal(probe.pending, 0);
  assert.ok(probe.records.every((value, index) => value.sequence === index + 1), "Native sequence has a gap");
  const calls = probe.records.filter(value => value.kind === "invoke"), acknowledgements = new Map();
  assert.equal(probe.records.length, calls.length * 2, "Unknown or missing native records");
  for (const call of calls) {
    assert.equal(call.dispatched, true); assert.deepEqual(call.source, { tabId: probe.tabId }, "All input must retain root routing");
    assert.equal(call.method, "Input.dispatchMouseEvent", "Unexpected Input command");
    assert.ok(["mouseMoved", "mousePressed", "mouseReleased"].includes(call.params.type));
    assert.ok(Number.isFinite(call.params.x) && Number.isFinite(call.params.y));
    assert.equal(call.params.modifiers ?? 0, 0);
    const acks = probe.records.filter(value => value.invocation === call.sequence); assert.equal(acks.length, 1);
    assert.equal(acks[0].kind, "settled"); assert.equal(acks[0].ok, true); assert.ok(acks[0].sequence > call.sequence); acknowledgements.set(call.sequence, acks[0]);
  }
  const moves = calls.filter(value => value.params.type === "mouseMoved"), buttons = calls.filter(value => value.params.type !== "mouseMoved");
  assert.ok(moves.length > 0, "No actual native move");
  for (const move of moves) { assert.equal(move.params.button ?? "none", "none"); assert.equal(move.params.buttons ?? 0, 0); }
  assert.equal(buttons.length, spec.outcome === "no-buttons" ? 0 : 2, "Unexpected native button count");
  if (buttons.length) {
    const [down, up] = buttons; assert.equal(down.params.type, "mousePressed"); assert.equal(up.params.type, "mouseReleased");
    for (const call of buttons) { assert.equal(call.params.button, "left"); assert.equal(call.params.clickCount, 1); }
    assert.equal(down.params.buttons, 1); assert.equal(up.params.buttons, 0);
    assert.deepEqual([down.params.x, down.params.y], [up.params.x, up.params.y]);
    assert.ok(moves.every(value => value.sequence < down.sequence), "Move occurred after the first button");
    assert.ok(acknowledgements.get(moves.at(-1).sequence).sequence < down.sequence, "Move was not ACKed before press");
    assert.ok(acknowledgements.get(down.sequence).sequence < up.sequence, "Press was not ACKed before release");
  }
  if (spec.mutation === "shift-move") {
    assert.ok(moves.length >= 2, "Hover transform change did not cause a new verified move");
    assert.notDeepEqual([moves[0].params.x, moves[0].params.y], [moves.at(-1).params.x, moves.at(-1).params.y], "Move coordinates did not follow the changed transform");
  }
  return { nativeMoves: moves.length, presses: buttons.length / 2, releases: buttons.length / 2, commands: calls.length };
}

export function checkTransformedPointerDocuments({ spec, key, before, after, server, actionError }) {
  const roles = spec.layout === "nested" ? ["root", "middle", "target"] : ["root", "target"];
  assert.deepEqual(before.map(value => value.role), roles); assert.deepEqual(after.map(value => value.role), roles);
  for (let index = 0; index < roles.length; index++) {
    const first = before[index], last = after[index], evidence = last.evidence;
    assert.equal(first.key, key); assert.equal(last.key, key); assert.equal(last.href, first.href);
    assert.equal(evidence.documentToken, first.evidence.documentToken); assert.ok(evidence.documentToken);
    assert.equal(evidence.role, roles[index]); assert.equal(evidence.key, key); assert.equal(evidence.caseName, spec.name);
    assert.equal(evidence.maximumRecords, 256); assert.equal(evidence.overflow, false); assert.deepEqual(evidence.errors, []);
    assert.equal(evidence.nextSequence, evidence.records.length); assert.ok(evidence.records.length <= 256);
    assert.deepEqual(first.evidence.records, [], "Input occurred before the original action");
    assert.ok(evidence.records.every((value, sequence) => value.sequence === sequence && value.documentToken === evidence.documentToken && value.trusted === true &&
      ["pointermove", "pointerdown", "pointerup", "mousemove", "mousedown", "mouseup", "click", "dblclick", "keydown", "keyup"].includes(value.type) &&
      typeof value.originalNode === "boolean" && typeof value.targetId === "string" && value.targetId.length <= 128 && Number.isFinite(value.timeStamp)));
    assert.ok(last.geometry.viewport.width > 0 && last.geometry.viewport.height > 0 && last.geometry.viewport.devicePixelRatio > 0);
    if (roles[index] !== "target") {
      assert.notEqual(first.geometry.frame.transform, "none", "The original iframe must actually be transformed");
      if (index === 0 && spec.layout !== "same") assert.notEqual(first.geometry.wrapper.transform, "none", "The outer non-frame ancestor must actually be transformed");
      assert.equal(evidence.clicks, 0); assert.equal(evidence.posts, 0);
      assert.equal(evidence.records.filter(value => /down|up|click/i.test(value.type)).length, 0, "Input hit an ancestor/overlay instead of the original target");
    }
  }
  const target = after.at(-1), evidence = target.evidence, expected = spec.outcome === "no-buttons" ? 0 : 1;
  assert.equal(target.originalNodeConnected, true); assert.deepEqual(target.geometry.target.rect, before.at(-1).geometry.target.rect, "Mutation must not change the target's local geometry");
  const moves = evidence.records.filter(value => value.type === "pointermove" && value.originalNode && value.pointerType === "mouse" && value.isPrimary === true && value.buttons === 0);
  assert.ok(moves.length > 0, "Original target never received a trusted mouse move");
  const types = ["pointerdown", "mousedown", "pointerup", "mouseup", "click"];
  const buttons = evidence.records.filter(value => types.includes(value.type) || value.type === "dblclick");
  assert.deepEqual(buttons.map(value => value.type), expected ? types : [], "Original target button sequence differs");
  assert.ok(buttons.every(value => value.originalNode && value.targetId === "target"));
  if (expected) assert.ok(moves[0].sequence < buttons[0].sequence);
  if (spec.name === "rotate-narrow") {
    const box = target.geometry.target.rect; assert.deepEqual(box, { x: 137.25, y: 91.5, width: 12, height: 12 });
    for (const event of [...moves, ...buttons.filter(value => value.type.startsWith("pointer"))]) {
      assert.ok(event.clientX >= box.x && event.clientX < box.x + box.width && event.clientY >= box.y && event.clientY < box.y + box.height,
        "Native pointer coordinates did not reach the narrow original target");
    }
  }
  assert.equal(evidence.clicks, expected); assert.equal(evidence.posts, expected); assert.equal(target.visibleResult, `${expected} clicks`);
  const mutations = after.flatMap(value => value.evidence.mutations);
  if (spec.mutation) {
    assert.equal(mutations.length, 2, "One parent mutation and its target-side receipt are required");
    const parent = after.at(-2), mutation = parent.evidence.mutations[0]; assert.deepEqual(mutation, evidence.mutations[0]);
    assert.equal(mutation.kind, spec.mutation); assert.equal(mutation.parentDocumentToken, parent.evidence.documentToken);
    const trigger = mutation.trigger, event = evidence.records[trigger.recordSequence];
    assert.equal(trigger.key, key); assert.equal(trigger.documentToken, evidence.documentToken); assert.equal(trigger.trusted, true); assert.equal(trigger.originalNode, true);
    assert.ok(event); assert.equal(event.type, spec.mutation === "cover-click" ? "click" : "pointermove");
    for (const field of ["type", "timeStamp", "clientX", "clientY", "buttons"]) assert.equal(trigger[field], event[field]);
    if (spec.mutation === "shift-move") { assert.notEqual(mutation.before.frame.transform, mutation.after.frame.transform); assert.notDeepEqual(mutation.before.frame.rect, mutation.after.frame.rect); }
    else { assert.equal(mutation.before.cover.display, "none"); assert.equal(mutation.after.cover.display, "block"); assert.equal(parent.geometry.cover.display, "block"); }
  } else assert.deepEqual(mutations, []);
  if (spec.outcome === "success") assert.equal(actionError, undefined);
  else {
    assert.equal(typeof actionError, "string");
    assert.match(actionError, spec.outcome === "partial" ? /OBU_POINTER_/ : /OBU_POINTER_|timed?\s*out|timeout/i);
  }
  assert.equal(server.key, key); assert.equal(server.posts.length, expected, "Business POST count differs");
  for (const post of server.posts) {
    const bytes = Buffer.from(post.bodyBase64, "base64"); assert.equal(bytes.length, post.bodyBytes); assert.equal(hash(bytes), post.bodySHA256);
    const value = JSON.parse(bytes.toString("utf8")); assert.deepEqual(value, post.value); assert.equal(post.error, undefined);
    assert.equal(post.receipt?.bodySHA256, post.bodySHA256); assert.equal(value.key, key); assert.equal(value.caseName, spec.name);
    assert.equal(value.href, target.href); assert.equal(value.documentToken, evidence.documentToken); assert.equal(value.trusted, true);
    assert.equal(value.evidence.clicks, 1); assert.equal(value.evidence.posts, 1); assert.deepEqual(value.evidence.errors, []);
    assert.deepEqual(value.evidence.records, evidence.records.slice(0, value.evidence.records.length));
    assert.equal(value.evidence.records.filter(record => record.type === "click" && record.originalNode && record.trusted).length, 1);
  }
  return { targetMoves: moves.length, targetClicks: expected, posts: server.posts.length, parentMutations: mutations.length / 2 };
}

async function bounded(promise, ms, label) {
  assert.ok(ms > 0, `${label} deadline expired`); let timer;
  try { return await Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(Error(`${label} timed out`)), ms); })]); }
  finally { clearTimeout(timer); }
}

function selectFrames(frames, urls, spec) {
  const selected = []; let parentFrameId = -1;
  for (const url of [urls.root, urls.middle, urls.target].filter(Boolean)) {
    const matches = frames?.filter(value => value.url === url && value.parentFrameId === parentFrameId && value.documentLifecycle === "active" && value.errorOccurred === false && typeof value.documentId === "string" && value.documentId) ?? [];
    if (matches.length !== 1) return null; selected.push(matches[0]); parentFrameId = matches[0].frameId;
  }
  assert.ok(selected.every(value => Number.isSafeInteger(value.frameId) && value.frameId >= 0 && Number.isSafeInteger(value.processId) && value.processId >= 0));
  assert.equal(new Set(selected.map(value => value.frameId)).size, selected.length);
  assert.equal(new Set(selected.map(value => value.documentId)).size, selected.length);
  assert.equal(selected[0].frameId, 0);
  if (spec.layout === "same") assert.equal(selected[0].processId, selected[1].processId);
  else assert.notEqual(selected[0].processId, selected[1].processId, "A real OOPIF is required");
  if (spec.layout === "nested") assert.equal(selected[1].processId, selected[2].processId, "Nested target and its immediate parent must be same-origin/process");
  return selected;
}

async function readDocuments(worker, tabId, frames) {
  const documents = await bounded(worker.evaluate(`chrome.scripting.executeScript({target:{tabId:${tabId},documentIds:${JSON.stringify(frames.map(value => value.documentId))}},world:'MAIN',func:()=>globalThis.readTransformedPointerDocument?.()??null})`), 3000, "transformed original document evidence");
  return frames.map(frame => {
    const matches = documents.filter(value => value.frameId === frame.frameId && value.documentId === frame.documentId); assert.equal(matches.length, 1);
    assert.ok(matches[0].result, "Original document evidence missing"); assert.equal(matches[0].result.href, frame.url); return { ...matches[0].result, nativeFrameId: frame.frameId, nativeDocumentId: frame.documentId, nativeProcessId: frame.processId };
  });
}

// The runner retains session finalization and continuous focus ownership. An
// explicit subset is diagnostic only and is labelled fullCoverage:false.
export async function checkTransformedPointer({ browser, worker, fixtureURL, server, until, detail = {}, caseNames = transformedPointerCases.map(value => value.name) }) {
  assert.ok(Array.isArray(caseNames) && caseNames.length > 0); assert.equal(new Set(caseNames).size, caseNames.length);
  const specs = transformedPointerCases.filter(value => caseNames.includes(value.name)); assert.deepEqual(specs.map(value => value.name), caseNames);
  Object.assign(detail, { version: 1, passed: false, expectedCases: [...caseNames], fullCoverage: specs.length === transformedPointerCases.length,
    cases: [], cleanupErrors: [], boundary: "Original root-routed public clicks only, no suppressed/replayed input. Parent changes are genuine page hover/click side effects. Native and DOM ledgers are bounded observations and can change scheduling; isTrusted is not CDP authentication. All post-action document reads use original native document identities. Runner owns finalization and the unchanged focus ledger." });
  let firstFailure;
  for (const spec of specs) {
    const id = randomUUID(), key = `transformed-${id.replaceAll("-", "")}-${spec.name}`, urls = transformedPointerURLs(fixtureURL, key);
    const item = { id, key, spec, urls, passed: false }; detail.cases.push(item); let failure, installationAttempted = false;
    try {
      const tab = await browser.newTab(); item.tabId = tab.id;
      await browser.cdp.navigate(tab.id, urls.root);
      item.frameReadSamples = []; const deadline = Date.now() + 5000;
      await until(async () => {
        const remaining = deadline - Date.now(); if (remaining <= 0) throw Error("Transformed frame preparation deadline expired");
        const frames = await bounded(worker.evaluate(`chrome.webNavigation.getAllFrames({tabId:${tab.id}})`), remaining, "transformed frame preparation");
        if (Date.now() >= deadline) throw Error("Transformed frame preparation completed late");
        if (item.frameReadSamples.length >= 80) throw Error("Transformed frame sample overflow");
        item.frameReadSamples.push({ at: Date.now(), frames }); const selected = selectFrames(frames, urls, spec);
        if (!selected) return false; item.framesBefore = selected; return true;
      }, "original transformed frame documents committed", 5000);
      item.before = await readDocuments(worker, tab.id, item.framesBefore); item.scope = chooserScope(browser);
      const setupDeadline = Date.now() + 3000; installationAttempted = true;
      item.installation = await bounded(worker.evaluate(`(()=>{if(Date.now()>=${setupDeadline})throw Error('Transformed probe setup expired');return (${installCountedPointerProbe.toString()})(chrome,globalThis,${JSON.stringify({ id, tabId: tab.id, mode: "observe" })})})()`), 3000, "transformed input observer installation");
      let frame = tab.frameLocator("#transform-frame"); if (spec.layout === "nested") frame = frame.frameLocator("#transform-frame");
      const locator = frame.getByRole("button", { name: "Transformed receipt", exact: true });
      item.options = { timeoutMs: 5000, ...(spec.outcome === "partial" ? { clickCount: 2, delay: 150 } : {}), ...(spec.position ? { position: { ...spec.position } } : {}) };
      item.startedAt = Date.now();
      try { await locator.click(item.options); item.completedAt = Date.now(); }
      catch (error) { item.failedAt = Date.now(); item.actionError = errorText(error); if (spec.outcome === "success") failure = error; }
      if (spec.outcome !== "no-buttons") {
        await until(() => { const posts = server.stats(key).posts; return posts.length > 0 && posts.every(value => value.receipt || value.error); }, "original transformed business POST completed", 3000);
      }
    } catch (error) { failure ??= error; item.error = errorText(error); }
    finally {
      if (installationAttempted) try {
        item.probe = await bounded(worker.evaluate(`(()=>{const probe=globalThis.__obuCountedPointer;if(!probe)return null;if(probe.id!==${JSON.stringify(id)})throw Error('Transformed probe identity changed');return probe.restore()})()`), 3000, "transformed input observer restoration");
      } catch (error) { item.restoreError = errorText(error); detail.cleanupErrors.push(item.restoreError); failure ??= error; }
    }
    item.server = server.stats(key);
    if (item.framesBefore) try {
      assert.deepEqual(chooserScope(browser), item.scope);
      item.native = await bounded(worker.evaluate(`(async()=>({tab:await chrome.tabs.get(${item.tabId}),frames:await chrome.webNavigation.getAllFrames({tabId:${item.tabId}}),targets:await chrome.debugger.getTargets(),attachments:globalThis.__integrationFrames.filter(value=>value.tabId===${item.tabId})}))()`), 3000, "transformed native final identity");
      assert.equal(item.native.tab.id, item.tabId); assert.equal(item.native.tab.active, false); assert.equal(item.native.tab.url, urls.root);
      const frames = selectFrames(item.native.frames, urls, spec); assert.ok(frames);
      assert.deepEqual(frames.map(value => [value.frameId, value.documentId, value.processId]), item.framesBefore.map(value => [value.frameId, value.documentId, value.processId]));
      item.after = await readDocuments(worker, item.tabId, item.framesBefore);
      item.traceProof = checkTransformedPointerTrace(item.probe, spec);
      item.documentProof = checkTransformedPointerDocuments({ spec, key, before: item.before, after: item.after, server: item.server, actionError: item.actionError });
    } catch (error) { item.evidenceError = errorText(error); failure ??= error; }
    if (failure) { item.error ??= errorText(failure); firstFailure ??= failure; } else item.passed = true;
    // Every attempted case is retained even when an older engine fails one of
    // the positives/obstruction cases. No failed public action is repeated.
  }
  detail.server = server.allStats(); detail.passed = !firstFailure && detail.cases.every(value => value.passed);
  if (firstFailure) { detail.error = errorText(firstFailure); throw firstFailure; }
  return detail;
}

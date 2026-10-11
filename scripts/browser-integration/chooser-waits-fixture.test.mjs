import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createServer } from "node:http";
import test from "node:test";
import { Script, runInNewContext } from "node:vm";
import { chooserPageHTML, chooserVariants, createChooserWaitFixtures, checkChooserReceipts, installChooserTrace, installChooserPointerEvidence, checkChooserReady } from "./chooser-waits-fixture.mjs";
import { chooserPointerEvidenceComplete } from "./chooser-ready-diagnostic.mjs";

const bytes = Buffer.from("actual file 中文\0bytes");
const files = [{ name: "fixture.txt", size: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex") }];
const payload = (sequence, variant = "root") => ({ key: "test-root", variant, sequence, documentToken: "document-one",
  href: `http://${variant === "root" ? "127.0.0.1" : "localhost"}:1234/chooser-waits/page`,
  clicks: Array.from({ length: sequence }, () => ({ trusted: true })),
  changes: [{ trusted: true, count: 1 }, ...(sequence === 2 ? [{ trusted: false, count: 0 }] : [])],
  files: sequence === 1 ? [{ name: files[0].name, size: bytes.length, base64: bytes.toString("base64") }] : [] });

test("chooser native trace retains exact bounded event order and ignores other tabs/methods", () => {
  let listener; const target = {}, chrome = { debugger: { onEvent: { addListener(value) { listener = value; } } } };
  installChooserTrace(chrome, target, 42, 2);
  listener({ tabId: 43 }, "Page.frameNavigated", { frame: { id: "foreign" } });
  listener({ tabId: 42 }, "Runtime.consoleAPICalled", { type: "log" });
  const source = { tabId: 42, sessionId: "native-child" }, params = { frame: { id: "frame", parentId: "root", loaderId: "loader", url: "about:blank" }, type: "Navigation" };
  listener(source, "Page.frameNavigated", params); params.frame.url = "changed";
  listener(source, "Page.frameDetached", { frameId: "frame", reason: "swap" });
  listener(source, "Page.fileChooserOpened", { frameId: "frame" });
  assert.equal(target.__chooserReadyTrace.overflow, true);
  assert.deepEqual(target.__chooserReadyTrace.events.map(({ sequence, source, method, params }) => ({ sequence, source, method, params })), [
    { sequence: 0, source, method: "Page.frameNavigated", params: { frame: { id: "frame", parentId: "root", loaderId: "loader", url: "about:blank" }, type: "Navigation" } },
    { sequence: 1, source, method: "Page.frameDetached", params: { frameId: "frame", reason: "swap" } }
  ]);
});

test("chooser fixture root and static/dynamic cross-origin scripts parse and retain real File bytes and event trust", () => {
  for (const variant of chooserVariants) for (const route of ["page", "frame"]) {
    const html = chooserPageHTML(new URL(`http://127.0.0.1/chooser-waits/${route}?key=test-root&variant=${variant}`), 1234);
    for (const [, script] of html.matchAll(/<script>([\s\S]*?)<\/script>/g)) new Script(script);
    assert.match(html, /file\.arrayBuffer\(\)/); assert.match(html, /event\.isTrusted/);
    if (variant === "dynamic-oopif" && route === "page") { assert.match(html, /Add upload frame/); assert.doesNotMatch(html, /<iframe/); }
    if (variant === "oopif" && route === "page") assert.match(html, /<iframe[^>]+localhost:1234/);
  }
});

function pointerDocument({ installationFailure = false } = {}) {
  const listeners = new Map(), options = [], evidence = { documentToken: "original-document" };
  const element = (tag, id, type = "") => ({ nodeType: 1, tagName: tag, getAttribute: name => ({ id, type })[name] ?? null });
  const input = element("INPUT", "upload", "file"), add = element("BUTTON", "add-frame"), other = element("DIV", "wrong-target");
  const document = { addEventListener(type, listener, value) {
    if (installationFailure && type === "pointerup") throw new Error("listener failed");
    listeners.set(type, listener); options.push(value);
  } };
  const install = runInNewContext(`(${installChooserPointerEvidence.toString()})`);
  install(document, evidence, input, add);
  const emit = (type, target = input, overrides = {}) => listeners.get(type)(Object.defineProperties({ type, target, isTrusted: true,
    timeStamp: 3, clientX: 20, clientY: 30, button: 0, buttons: 1 }, Object.getOwnPropertyDescriptors(overrides)));
  return { evidence, input, add, other, emit, options, listeners };
}

test("opt-in fixture serializes passive root/child listeners; default and false HTML have no added bytes or POST fields", () => {
  for (const variant of chooserVariants) for (const route of ["page", "frame"]) {
    const url = new URL(`http://127.0.0.1/chooser-waits/${route}?key=test-root&variant=${variant}`);
    const original = chooserPageHTML(url, 1234), off = chooserPageHTML(url, 1234, { pointerEvidence: false });
    const on = chooserPageHTML(url, 1234, { pointerEvidence: true });
    assert.equal(original, off); assert.doesNotMatch(original, /pointerEvidence|installChooserPointerEvidence/);
    assert.match(on, /installChooserPointerEvidence/);
    for (const [, script] of on.matchAll(/<script>([\s\S]*?)<\/script>/g)) new Script(script);
    const postBody = html => html.match(/body:JSON.stringify\(([^\n]+)\)/)[1];
    assert.equal(postBody(on), postBody(off));
  }
  assert.throws(() => createChooserWaitFixtures({ pointerEvidence: "1" }));
  const fixture = createChooserWaitFixtures({ pointerEvidence: true }); let body;
  fixture.handle({ url: "/chooser-waits/frame?key=test-root&variant=oopif" }, { setHeader() {}, end(value) { body = value; } }, 1234);
  assert.match(body, /installChooserPointerEvidence/);
});

test("pointer key filtering snapshots a bounded exact key list and leaves every other fixture HTML byte unchanged", () => {
  const keys = ["js-chooser-root", "js-chooser-oopif", "js-chooser-dynamic-oopif"];
  const filtered = createChooserWaitFixtures({ pointerEvidence: true, pointerEvidenceKeys: keys });
  keys[0] = "mutated-key"; keys.push("cli-chooser-root");
  const render = (fixture, url) => {
    let body;
    assert.equal(fixture.handle({ url: url.pathname + url.search }, { setHeader() {}, end(value) { body = value; } }, 1234), true);
    return body;
  };
  const ordinary = createChooserWaitFixtures(), oldOptIn = createChooserWaitFixtures({ pointerEvidence: true });
  for (const variant of chooserVariants) for (const route of ["page", "frame"]) {
    for (const key of [`js-chooser-${variant}`, `js-chooser-submission-${variant}`, "js-chooser-lifecycle", `cli-chooser-${variant}`,
      `mcp-chooser-${variant}`, `python-chooser-${variant}`, `go-chooser-${variant}`, `js-chooser-${variant}-extra`, "mutated-key"]) {
      const url = new URL(`http://127.0.0.1/chooser-waits/${route}?key=${key}&variant=${variant}`);
      const target = key === `js-chooser-${variant}`;
      assert.equal(render(filtered, url), chooserPageHTML(url, 1234, { pointerEvidence: target }));
      if (!target) assert.equal(render(filtered, url), render(ordinary, url));
      else assert.equal(render(filtered, url), render(oldOptIn, url));
    }
  }
  for (const pointerEvidenceKeys of [null, "key", [""], ["UPPER"], ["a/b"], ["x".repeat(101)], [1], new Array(1), ["same", "same"], Array.from({ length: 33 }, (_, i) => `key-${i}`)])
    assert.throws(() => createChooserWaitFixtures({ pointerEvidence: true, pointerEvidenceKeys }));
  assert.throws(() => createChooserWaitFixtures({ pointerEvidenceKeys: ["key"] }));
  const empty = createChooserWaitFixtures({ pointerEvidence: true, pointerEvidenceKeys: [] });
  const url = new URL("http://127.0.0.1/chooser-waits/page?key=js-chooser-root&variant=root");
  assert.equal(render(empty, url), render(ordinary, url));
});

test("serialized pointer capture records exact node identity, trust and order without touching original event behavior", () => {
  const state = pointerDocument();
  assert.equal(chooserPointerEvidenceComplete(state.evidence), true, "zero delivered events remain complete");
  assert.equal(state.listeners.size, 8);
  for (const options of state.options) { assert.equal(options.capture, true); assert.equal(options.passive, true); }
  const forbidden = () => { throw new Error("event behavior changed"); };
  state.emit("pointerdown", state.input, { pointerId: 4, pointerType: "mouse", preventDefault: forbidden, stopPropagation: forbidden });
  state.emit("mouseup", state.other, { isTrusted: false, buttons: 0 });
  state.emit("click", state.add, { buttons: 0 });
  const rows = state.evidence.pointerEvidence.records;
  assert.deepEqual(Array.from(rows, row => [row.sequence, row.type, row.trusted, row.targetIsOriginalUpload, row.targetIsOriginalAdd]),
    [[0, "pointerdown", true, true, false], [1, "mouseup", false, false, false], [2, "click", true, false, true]]);
  assert.equal(rows[1].target.id, "wrong-target"); assert.equal(rows[0].pointerId, 4); assert.equal(rows[1].pointerId, null);
  assert.equal(chooserPointerEvidenceComplete(state.evidence), true);
});

test("pointer records/characters are bounded and drops, truncation, installation or recording errors fail completeness", () => {
  const count = pointerDocument();
  for (let index = 0; index < 300; index++) count.emit("mousemove");
  assert.ok(count.evidence.pointerEvidence.records.length <= 256);
  assert.ok(count.evidence.pointerEvidence.retainedCharacters <= 65536);
  assert.equal(count.evidence.pointerEvidence.nextSequence, 300); assert.ok(count.evidence.pointerEvidence.dropped > 0);
  assert.equal(chooserPointerEvidenceComplete(count.evidence), false);
  const clipped = pointerDocument();
  clipped.input.getAttribute = () => "x".repeat(129); clipped.emit("click");
  assert.ok(clipped.evidence.pointerEvidence.truncations > 0); assert.equal(chooserPointerEvidenceComplete(clipped.evidence), false);
  const failed = pointerDocument();
  failed.emit("click", failed.input, { get clientX() { throw new Error("read failed"); } });
  assert.equal(failed.evidence.pointerEvidence.recordingErrors, 1); assert.equal(chooserPointerEvidenceComplete(failed.evidence), false);
  assert.equal(chooserPointerEvidenceComplete(pointerDocument({ installationFailure: true }).evidence), false);
});

test("HTTP chooser witness computes actual decoded bytes and rejects mismatched lengths", async () => {
  const fixture = createChooserWaitFixtures();
  const server = createServer((request, response) => { if (!fixture.handle(request, response, server.address().port)) { response.writeHead(404); response.end(); } });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  const endpoint = `http://127.0.0.1:${server.address().port}/chooser-waits/upload?key=test-root&variant=root`;
  const post = value => fetch(endpoint, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(value) });
  try {
    for (const sequence of [1, 2]) {
      const response = await post(payload(sequence)); assert.equal(response.status, 200);
      const receipt = await response.json(); assert.deepEqual(receipt.files, sequence === 1 ? files : []);
    }
    const record = fixture.stats("test-root"); checkChooserReceipts(record, files, "root");
    const wrong = payload(3); wrong.files = [{ name: "fixture.txt", size: 100, base64: bytes.toString("base64") }];
    assert.equal((await post(wrong)).status, 400); assert.ok(fixture.stats("test-root").posts[2].error);
    // A server-successful RPC/POST is insufficient: exact trust, multiplicity,
    // bytes and same document must independently match the retained witness.
    for (const mutate of [
      value => value.posts.push(structuredClone(value.posts[1])),
      value => { value.posts[0].files[0].sha256 = "forged"; },
      value => { value.posts[0].clicks[0].trusted = false; },
      value => { value.posts[1].documentToken = "replaced"; },
      value => { value.posts[1].files = files; }
    ]) { const invalid = structuredClone(record); mutate(invalid); assert.throws(() => checkChooserReceipts(invalid, files, "root")); }
  } finally { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
});

test("pointer-only ready failures use the original failure observer before cancel and preserve frozen business errors", async () => {
  for (const frozen of [false, true]) {
    const original = new Error("original collect timeout"); if (frozen) Object.freeze(original);
    const calls = [];
    const wait = { waiterId: "wait", remainingMs: 10000, result: async () => { calls.push("collect"); throw original; },
      cancel: async () => { calls.push("cancel"); throw new Error("cancel failed"); } };
    const owner = { client: { getInfo: async () => ({ metadata: { fileChooserWaitVersion: 1 } }) },
      newTab: async () => ({ id: 42, expectFileChooser: async ({ timeoutMs }) => { assert.equal(timeoutMs, 10000); return wait; } }), cdp: { navigate: async () => {} } };
    const trigger = { tab: () => ({ getByLabel: () => ({ click: async options => { calls.push("click"); assert.equal(options.timeoutMs, 5000); } }) }) };
    const worker = { evaluate: async expression => {
      assert.doesNotMatch(expression, /installChooserDiagnostic|__obuChooserDiagnostic/);
      if (expression.includes("chrome.tabs.get")) { calls.push("failure-observation"); throw new Error("read failed"); }
      if (expression.includes("removeListener")) { calls.push("trace-cleanup"); throw new Error("cleanup failed"); }
      calls.push("existing-trace-start");
    } };
    await assert.rejects(checkChooserReady({ owner, trigger, worker, pointerEvidence: true, fixtureURL: "http://127.0.0.1/", prefix: "unit",
      server: { stats: () => ({ posts: [] }) } }), error => {
      assert.equal(error, original);
      if (!frozen) {
        const observation = error.chooserDetail.variants[0].failureObservation;
        assert.equal(observation.pointerEvidenceExpected, true); assert.equal(observation.pointerObservationRequested, false);
        assert.equal(observation.pointerObservationComplete, false); assert.equal(observation.complete, false);
      }
      return true;
    });
    assert.deepEqual(calls, ["existing-trace-start", "click", "collect", "failure-observation", "cancel", "trace-cleanup"]);
  }
});

test("pointer-only successful ready executes the identical three-variant public operations with no failure scripting or diagnostic hooks", async () => {
  async function run(pointerEvidence) {
    const calls = [], records = new Map(); let current;
    const client = { sessionId: "session", turnId: "turn", controlEpoch: 1,
      getInfo: async () => ({ metadata: { fileChooserWaitVersion: 1 } }),
      setFileChooserFiles: async (_id, selected) => {
        calls.push(["set", selected]); const record = records.get(current.key), sequence = record.posts.length + 1;
        const value = payload(sequence, current.variant); value.key = current.key;
        const body = Buffer.from(JSON.stringify(value));
        record.posts.push({ method: "POST", variant: current.variant, sequence, documentToken: value.documentToken, href: value.href,
          clicks: value.clicks, changes: value.changes, files: sequence === 1 ? files : [], receipt: {},
          bodyBase64: body.toString("base64"), bodyBytes: body.length, bodySHA256: createHash("sha256").update(body).digest("hex") });
      } };
    let serial = 0;
    const tab = { id: 42, expectFileChooser: async ({ timeoutMs }) => {
      calls.push(["arm", timeoutMs]); const id = ++serial;
      return { waiterId: `wait-${id}`, remainingMs: timeoutMs, result: async () => {
        calls.push(["collect", id]); if (timeoutMs === 250) throw new Error("OBU_FILE_CHOOSER_WAIT_TIMEOUT");
        return { fileChooserId: `chooser-${id}`, isMultiple: current.variant !== "root" };
      }, cancel: async () => { calls.push(["cancel", id]); } };
    }, evaluate: async expression => { calls.push(["evaluate", expression]); return [{ trusted: true }]; } };
    const owner = { client, newTab: async () => { calls.push("newTab"); return tab; }, cdp: { navigate: async (_id, href) => {
      const url = new URL(href); current = { key: url.searchParams.get("key"), variant: url.searchParams.get("variant") };
      records.set(current.key, { posts: [] }); calls.push(["navigate", href]);
    } } };
    const target = { getByLabel: () => ({ click: async options => { calls.push(["click-input", options]); } }),
      getByRole: () => ({ click: async () => { calls.push("click-add"); } }) }; target.frameLocator = () => target;
    const worker = { evaluate: async expression => {
      assert.doesNotMatch(expression, /scripting\.executeScript|installChooserDiagnostic|__obuChooserDiagnostic|chrome\.tabs\.get/);
      if (expression.includes("__integrationFrames")) {
        calls.push("frame-evidence"); return { frames: [{ parentFrameId: 0, url: `http://localhost/chooser-waits/frame?key=${current.key}&` }],
          targets: [], attachedTargets: [{ tabId: 42, type: "iframe", sessionId: "child" }] };
      }
      calls.push(expression.includes("removeListener") ? "trace-cleanup" : "existing-trace-start"); return { events: [], overflow: false };
    } };
    const result = await checkChooserReady({ owner, trigger: { client, tab: () => target }, worker, pointerEvidence,
      fixtureURL: "http://127.0.0.1/", prefix: "unit", server: { stats: key => records.get(key) }, files: [{ ...files[0], path: "fixture.txt" }],
      until: async predicate => { assert.ok(predicate()); } });
    assert.equal(result.variants.length, 3); for (const item of result.variants) assert.equal(item.failureObservation, undefined);
    return calls;
  }
  assert.deepEqual(await run(true), await run(false));
});

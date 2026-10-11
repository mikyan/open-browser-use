import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import vm from "node:vm";
import { checkDirectoryImmediate, checkDirectoryRound, checkDirectoryUpload, checkInactiveDirectoryRejection, checkInactiveDirectoryCancellation, createDirectoryUploadFixtures, directoryPageHTML, prepareDirectoryFiles } from "./directory-upload-fixture.mjs";

const hash = bytes => createHash("sha256").update(bytes).digest("hex");
function hit(value) {
  const body = Buffer.from(JSON.stringify(value));
  return { method: "POST", bodyBase64: body.toString("base64"), bodyBytes: body.length, bodySHA256: hash(body), value: structuredClone(value) };
}
const file = { name: "same.txt", relativePath: "folder/子目录/same.txt", size: 3, sha256: hash(Buffer.from([0, 128, 255])) };
function witness(event = "input", overrides = {}) {
  return { key: "unit", variant: "root", sequence: 1, eventIndex: event === "input" ? 1 : 2, documentToken: "original", inputToken: "original-input", href: "http://127.0.0.1/directory-upload/page?key=unit&variant=root", event, trusted: true,
    files: [{ name: file.name, relativePath: file.relativePath, size: file.size }], clicks: [{ trusted: true }], input: { id: "upload", type: "file", webkitdirectory: true, multiple: true, connected: true, originalNode: true }, ...overrides };
}
const expected = { sequence: 1, files: [file], documentToken: "original", inputToken: "original-input" };

test("immediate completion rejects absent/duplicate/foreign/untrusted witnesses without waiting", () => {
  checkDirectoryImmediate({ witnesses: [hit(witness())], posts: [] }, expected);
  for (const records of [[], [hit(witness()), hit(witness())], [hit(witness("input", { trusted: false }))], [hit(witness("input", { documentToken: "replacement" }))],
    [hit(witness("input", { files: [{ ...file, relativePath: "other/same.txt" }] }))], [hit(witness("input", { input: { ...witness().input, connected: false } }))],
    [hit(witness("input", { inputToken: "replacement-input" }))], [hit(witness("input", { input: { ...witness().input, originalNode: false } }))],
    [hit(witness("cancel"))], [hit(witness()), hit(witness("cancel"))]]) {
    assert.throws(() => checkDirectoryImmediate({ witnesses: records, posts: [] }, expected));
  }
  assert.throws(() => checkDirectoryImmediate({ witnesses: [hit(witness("cancel", { files: [] }))], posts: [] }, { ...expected, files: [] }), /returned before/);
  checkDirectoryImmediate({ witnesses: [hit(witness("input", { files: [], trusted: false }))], posts: [] }, { ...expected, files: [], clear: true });
});

test("round validation preserves relative-path and binary identities and exact event/POST counts", () => {
  const change = witness("change"), body = { ...change, files: [{ ...change.files[0], base64: Buffer.from([0, 128, 255]).toString("base64") }] };
  const record = { witnesses: [hit(witness()), hit(change)], posts: [{ ...hit(body), files: [file], receipt: { files: [file] } }] };
  checkDirectoryRound(record, expected);
  for (const mutate of [
    value => value.posts.push(structuredClone(value.posts[0])),
    value => { const bad = structuredClone(body); bad.files[0].base64 = Buffer.from([0, 128, 254]).toString("base64"); Object.assign(value.posts[0], hit(bad)); },
    value => { value.witnesses[1] = hit(witness("change", { documentToken: "replaced" })); },
    value => value.witnesses.push(hit(change)),
    value => { value.posts[0].bodySHA256 = "0".repeat(64); }
  ]) { const bad = structuredClone(record); mutate(bad); assert.throws(() => checkDirectoryRound(bad, expected)); }
});

test("prepared tree includes unicode, duplicate basenames, nested binary, zero-byte and empty directories", async () => {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), "obu-directory-files-"));
  try {
    const files = await prepareDirectoryFiles(temp);
    assert.equal(files.files.length, 5); assert.equal(files.files.filter(file => file.name === "same.txt").length, 2);
    assert.deepEqual(await fs.readdir(files.empty), []); assert.deepEqual(await fs.readdir(path.join(files.root, "空子目录")), []);
    assert.ok(files.files.some(file => file.size === 0)); assert.ok(files.files.some(file => file.relativePath.includes("嵌套/更深")));
    for (const file of files.files) { const bytes = await fs.readFile(file.path); assert.equal(file.size, bytes.length); assert.equal(file.sha256, hash(bytes)); }
    await assert.rejects(prepareDirectoryFiles(temp), /EEXIST/);
  } finally { await fs.rm(temp, { recursive: true, force: true }); }
});

// Evaluate only our page script against a controlled DOM. This proves the
// witness/byte-read ordering, not trusted browser events or real FileLists.
test("page writes synchronous metadata before awaiting file bytes; no synthetic input or polling", async () => {
  const html = directoryPageHTML(new URL("http://127.0.0.1:1234/directory-upload/page?key=unit&variant=root"), 1234);
  assert.match(html, /webkitdirectory multiple/); assert.doesNotMatch(html, /dispatchEvent|setTimeout|setInterval/);
  const events = new Map(), log = []; let release;
  const bytes = new Promise(resolve => { release = resolve; });
  const chosen = { name: "unit.bin", size: 2, type: "", webkitRelativePath: "directory/unit.bin", arrayBuffer: () => { log.push("arrayBuffer"); return bytes; } };
  const input = { id: "upload", type: "file", webkitdirectory: true, multiple: true, isConnected: true, files: [chosen], addEventListener: (type, handler, options) => {
    assert.deepEqual({ ...options }, { capture: true }, "Witness capture must register at page load before the production controller"); events.set(type, handler);
  } };
  const context = vm.createContext({ crypto: { randomUUID: () => "document-1" }, location: { href: "http://127.0.0.1:1234/directory-upload/page?key=unit&variant=root" },
    document: { querySelector: selector => selector === "#upload" ? input : selector === "#receipt" ? {} : null }, URLSearchParams, Uint8Array,
    XMLHttpRequest: class { open(method, url, async) { assert.equal(async, false); assert.equal(method, "POST"); assert.match(url, /\/witness\?/); } setRequestHeader() {} send(body) { log.push(JSON.parse(body)); this.status = 200; } },
    fetch: async (url, init) => { log.push({ upload: JSON.parse(init.body) }); return { ok: true, json: async () => ({}) }; }, btoa: value => Buffer.from(value, "binary").toString("base64") });
  vm.runInContext(html.match(/<script>([\s\S]*)<\/script>/)[1], context);
  input.onclick({ isTrusted: true }); events.get("input")({ isTrusted: true, target: input }); events.get("change")({ isTrusted: true, target: input });
  assert.deepEqual(log.map(value => typeof value === "string" ? value : value.event), ["input", "change", "arrayBuffer"]);
  assert.deepEqual(log[0].files, [{ name: "unit.bin", size: 2, relativePath: "directory/unit.bin" }]);
  release(Uint8Array.from([128, 255]).buffer); await new Promise(resolve => setImmediate(resolve));
  assert.equal(log[3].upload.files[0].base64, "gP8="); assert.deepEqual([...context.directoryEvidence.errors], []);
});

function request(url, body) {
  return new Promise((resolve, reject) => {
    const req = http.request(url, { method: body === undefined ? "GET" : "POST", agent: false, headers: { "content-type": "application/json" } }, res => {
      const chunks = []; res.on("data", chunk => chunks.push(chunk)); res.once("error", reject); res.once("aborted", () => reject(new Error("HTTP aborted")));
      res.once("end", () => { clearTimeout(timer); resolve({ status: res.statusCode, text: Buffer.concat(chunks).toString("utf8") }); });
    });
    const timer = setTimeout(() => req.destroy(new Error("HTTP unit timeout")), 2000);
    req.once("error", error => { clearTimeout(timer); reject(error); }); req.end(body === undefined ? undefined : JSON.stringify(body));
  });
}
async function httpFixture(run) {
  const fixture = createDirectoryUploadFixtures();
  const server = http.createServer((req, res) => { if (!fixture.handle(req, res, new URL(req.url, `http://${req.headers.host}`))) { res.writeHead(404); res.end(); } });
  await new Promise((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
  const base = `http://127.0.0.1:${server.address().port}/`;
  try { await run({ fixture, base }); } finally { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
}

test("real HTTP fixture retains exact witness and upload bytes and rejects traversal/duplicate paths", () => httpFixture(async ({ fixture, base }) => {
  assert.equal((await request(base + "directory-upload/page?key=unit&variant=root")).status, 200);
  assert.equal((await request(base + "directory-upload/page?key=bad!&variant=root")).status, 400);
  assert.equal((await request(base + "unrelated")).status, 404);
  const value = witness(); assert.equal((await request(base + "directory-upload/witness?key=unit&variant=root", value)).status, 200);
  assert.deepEqual(parsed(fixture.stats("unit").witnesses[0]), value);
  for (const files of [[{ ...value.files[0], relativePath: "../same.txt" }], [value.files[0], value.files[0]]])
    assert.equal((await request(base + "directory-upload/witness?key=unit&variant=root", { ...value, files })).status, 400);
  const all = fixture.allStats(); all[0].witnesses.length = 0; assert.equal(fixture.stats("unit").witnesses.length, 3);
}));
function parsed(hit) { return JSON.parse(Buffer.from(hit.bodyBase64, "base64").toString("utf8")); }

async function harness(run, options = {}) {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), "obu-directory-workflow-"));
  try { await httpFixture(async ({ fixture, base }) => {
    const files = await prepareDirectoryFiles(temp), tabs = new Map(), chooser = new Map(), log = [];
    let nextTab = 100, nextChooser = 1, untilCalls = 0;
    const scope = { sessionId: "unit-directory", turnId: "original", controlEpoch: options.coldClient ? null : 7, socketPath: "unit-socket", timeoutMs: 15000 };
    async function post(state, event, selected, trusted) {
      const value = { key: state.key, variant: state.variant, sequence: state.clicks, eventIndex: ++state.eventIndex, documentToken: state.documentToken, inputToken: state.inputToken, href: state.href, event, trusted,
        files: selected.map(({ name, relativePath, size }) => ({ name, relativePath, size })), clicks: Array.from({ length: state.clicks }, () => ({ trusted: true })), input: witness().input };
      assert.equal((await request(base + `directory-upload/witness?key=${state.key}&variant=${state.variant}`, value)).status, 200);
      if (event === "change") {
        const payload = await Promise.all(selected.map(async file => ({ name: file.name, relativePath: file.relativePath, size: file.size, base64: (await fs.readFile(file.path)).toString("base64") })));
        assert.equal((await request(base + `directory-upload/upload?key=${state.key}&variant=${state.variant}`, { ...value, files: payload })).status, 200);
      }
    }
    class Browser {
      constructor(settings = scope) {
        this.client = { ...scope, ...settings, getTabs: async () => {
          if (options.coldClient) { log.push({ kind: "getTabs", controlEpoch: this.client.controlEpoch }); this.client.controlEpoch = 7; }
          return [];
        }, getInfo: async () => ({ metadata: {} }),
          setFileChooserFiles: async (id, paths) => {
            log.push({ kind: "set", id, paths }); const item = chooser.get(id); assert.ok(item);
            if (item.consumed) throw new Error("Unknown or unowned file chooser id");
            const state = item.state;
            const invalid = paths.length > 1 || paths[0] === files.missing || paths[0] === files.files[0].path;
            if (invalid && !options.acceptInvalid) throw new Error(options.invalidTimeout ? "Directory timed out" : "Invalid directory path");
            item.consumed = true;
            if (options.earlyReturn) return {};
            if (options.inactiveCancel) { await post(state, "cancel", [], options.syntheticCancel ? false : true); throw new Error(options.wrongCancelError ? "Timed out" : "OBU_DIRECTORY_UPLOAD_CANCELLED: directory selection did not complete"); }
            const selected = paths[0] === files.root ? files.files : [], cancel = options.emptyCancel && paths[0] === files.empty;
            if (cancel) await post(state, "cancel", selected, true);
            else { await post(state, "input", selected, paths.length !== 0); await post(state, "change", selected, paths.length !== 0); }
            state.wasEmpty = selected.length === 0; return {};
          }
        };
        this.cdp = { navigate: async (tabId, url) => {
          const state = tabs.get(tabId), target = new URL(url); state.variant = target.searchParams.get("variant"); state.key = target.searchParams.get("key");
          state.rootHref = target.href;
          if (state.variant !== "root") { target.hostname = "localhost"; target.pathname = "/directory-upload/frame"; } state.href = target.href;
        } };
      }
      async connect() { log.push({ kind: "connect" }); return this; }
      close() { log.push({ kind: "close" }); }
      async newTab() {
        if (options.coldClient) { log.push({ kind: "newTab", controlEpoch: this.client.controlEpoch }); this.client.controlEpoch = 7; }
        const id = nextTab++; tabs.set(id, { tabId: id, clicks: 0, eventIndex: 0, documentToken: `document-${id}`, inputToken: `input-${id}`, wasEmpty: true, frameAdds: [] }); return this.tab(id);
      }
      tab(id) {
        const state = tabs.get(id);
        const locator = { frameLocator(selector) { assert.equal(selector, "#upload-frame"); return this; }, getByLabel(label, value) { assert.equal(label, "Upload directory"); assert.deepEqual(value, { exact: true }); return this; },
          async click(...args) { assert.deepEqual(args, []); log.push({ kind: "click", tabId: id }); if (options.clickError) throw options.clickError; state.clicks++; },
          getByRole(role, value) { assert.equal(role, "button"); assert.deepEqual(value, { name: "Add upload frame", exact: true }); return { click: async () => { state.frameAdds.push({ trusted: true }); log.push({ kind: "addFrame" }); } }; }
        };
        return { id, ...locator,
          expectFileChooser: async ({ timeoutMs }) => { assert.equal(timeoutMs, 10000); const token = `chooser-${nextChooser++}`; chooser.set(token, { state }); return { waiterId: `wait-${token}`, remainingMs: 9900,
            result: async () => { if (options.collectError && state.variant === "dynamic-oopif") { log.push({ kind: "collect-failed", tabId: id }); throw options.collectError; } return { fileChooserId: token, isMultiple: true }; },
            cancel: async () => { log.push({ kind: "cancel", tabId: id }); if (options.cancelError && (!options.cancelErrorVariant || state.variant === options.cancelErrorVariant)) throw options.cancelError; } }; },
          evaluate: async expression => { assert.equal(expression, "directoryEvidence.frameAdds"); return structuredClone(state.frameAdds); }
        };
      }
    }
    const worker = { evaluate: async expression => {
      const nativeId = Number(expression.match(/chrome\.tabs\.get\((\d+)\)/)?.[1]);
      const observationFrames = state => [{ frameId: 0, parentFrameId: -1, documentId: `root-${state.tabId}`, documentLifecycle: "active", errorOccurred: false, processId: 1, url: state.rootHref },
        ...(state.variant === "root" ? [] : [{ frameId: 1, parentFrameId: 0, documentId: `child-${state.tabId}`, documentLifecycle: "active", errorOccurred: false, processId: 2, url: state.href }])];
      if (nativeId && expression.includes("frameCount:")) {
        log.push({ kind: "failure-metadata", tabId: nativeId });
        if (options.observationError) throw options.observationError;
        const state = tabs.get(nativeId), frames = observationFrames(state);
        return { tab: { id: nativeId, windowId: 73, url: state.rootHref }, frames, frameCount: frames.length };
      }
      if (expression.includes("chrome.scripting.executeScript")) {
        const id = Number(expression.match(/target:\{tabId:(\d+)/)?.[1]), state = tabs.get(id); assert.ok(state);
        log.push({ kind: "failure-document", tabId: id });
        return observationFrames(state).map(frame => ({ frameId: frame.frameId, documentId: frame.documentId,
          result: { observed: true, href: frame.url, truncated: false, directoryEvidence: {
            documentToken: frame.frameId === 0 && state.variant !== "root" ? `root-document-${id}` : state.documentToken,
            inputToken: frame.frameId === 0 && state.variant !== "root" ? `root-input-${id}` : state.inputToken,
            clicks: frame.frameId !== 0 || state.variant === "root" ? Array.from({ length: state.clicks }, () => ({ trusted: true })) : [],
            frameAdds: frame.frameId === 0 ? structuredClone(state.frameAdds) : [], events: [], errors: []
          } } }));
      }
      if (nativeId) return { tab: { id: nativeId, windowId: 73, active: options.nativeActive ?? false }, window: { id: 73, focused: true } };
      const id = Number(expression.match(/getAllFrames\(\{tabId:(\d+)\}\)/)?.[1]), state = tabs.get(id); assert.ok(state);
      const result = { frames: [{ frameId: 0, processId: 1 }], targets: [], attachedTargets: [] };
      if (state.variant !== "root") {
        result.frames.push({ frameId: 1, parentFrameId: 0, processId: options.sameProcess ? 1 : 2, url: state.href });
        result.targets.push({ id: `target-${id}`, url: state.href, attached: true }); result.attachedTargets.push({ tabId: id, source: { tabId: id }, type: "iframe", targetId: `target-${id}`, sessionId: `child-${id}` });
      } return result;
    } };
    await run({ browser: new Browser(), fixtureURL: base, server: fixture, files, worker, until: async callback => { untilCalls++; assert.ok(await callback()); } }, { log, fixture, get untilCalls() { return untilCalls; } });
  }); } finally { await fs.rm(temp, { recursive: true, force: true }); }
}

test("public two-connection workflow covers 12 directory rounds, clear, three invalid new choosers and consumed repeats", () => harness(async (args, evidence) => {
  const detail = await checkDirectoryUpload(args);
  assert.deepEqual(detail.variants.map(item => item.variant), ["root", "oopif", "dynamic-oopif"]);
  assert.deepEqual(detail.variants.map(item => item.rounds.length), [8, 4, 4]); assert.ok(detail.variants.every(item => item.passed));
  assert.equal(evidence.log.filter(item => item.kind === "click").length, 16); assert.equal(evidence.log.filter(item => item.kind === "addFrame").length, 1);
  assert.equal(evidence.log.filter(item => item.kind === "cancel").length, 16); assert.equal(evidence.log.filter(item => item.kind === "set").length, 29);
  assert.equal(evidence.log.filter(item => item.kind === "close").length, 1);
  assert.equal(evidence.log.filter(item => item.kind.startsWith("failure-")).length, 0, "Successful path must not send post-failure reads");
  assert.ok(detail.variants.every(item => item.rounds[0].atReturn.witnesses.length === 2));
}));

test("early API return fails before any receipt poll and retains partial return snapshot", () => harness(async (args, evidence) => {
  await assert.rejects(checkDirectoryUpload(args), error => {
    assert.match(error.message, /returned before/); assert.equal(error.chooserDetail, error.directoryDetail);
    const round = error.directoryDetail.variants[0].rounds[0]; assert.deepEqual(round.atReturn.witnesses, []); assert.ok(round.setCompletedAt); assert.ok(round.cancelCompletedAt); return true;
  });
  assert.equal(evidence.untilCalls, 0); assert.equal(evidence.log.filter(item => item.kind === "click").length, 1);
}, { earlyReturn: true }));

for (const [name, options, message] of [["invalid selection accepted", { acceptInvalid: true }, /silently accepted/], ["timeout masquerading as validation", { invalidTimeout: true }, /explicit rejection/], ["same-process child", { sameProcess: true }, /real OOPIF/], ["empty selection only cancels", { emptyCancel: true }, /returned before/]])
  test(`workflow rejects ${name} and retains original evidence`, () => harness(async args => {
    await assert.rejects(checkDirectoryUpload(args), error => { assert.match(error.message, message); assert.ok(error.directoryDetail.variants.at(-1).serverAtEnd); return true; });
  }, options));

test("click business failure survives waiter cancel failure and trigger connection closes", () => {
  const original = new Error("Original click failure"), cleanup = new Error("Cancel failed");
  return harness(async (args, evidence) => {
    await assert.rejects(checkDirectoryUpload(args), error => {
      assert.equal(error, original); const round = error.directoryDetail.variants[0].rounds[0]; assert.equal(round.error.message, original.message); assert.equal(round.cancelError.message, cleanup.message); return true;
    });
    assert.equal(evidence.log.filter(item => item.kind === "set").length, 0); assert.equal(evidence.log.filter(item => item.kind === "close").length, 1);
  }, { clickError: original, cancelError: cleanup });
});

test("dynamic first collect failure captures exact current directory documents before cancel without reaching setter", () => {
  const original = new Error("OBU_FILE_CHOOSER_WAIT_TIMEOUT: original deadline expired"), cancelError = new Error("Cancel failed");
  return harness(async (args, evidence) => {
    await assert.rejects(checkDirectoryUpload(args), error => {
      assert.equal(error, original); const item = error.directoryDetail.variants.at(-1), round = item.rounds[0];
      assert.equal(item.variant, "dynamic-oopif"); assert.equal(round.chooser, undefined); assert.equal(round.setStartedAt, undefined);
      assert.equal(item.failureObservation.complete, true); assert.equal(item.failureObservation.fixtureKind, "directory");
      assert.equal(item.failureObservation.results[0].result.directoryEvidence.frameAdds[0].trusted, true);
      assert.equal(item.failureObservation.results[1].result.directoryEvidence.clicks.length, 1);
      assert.equal(round.error.message, original.message); assert.equal(round.cancelError.message, cancelError.message);
      assert.deepEqual(item.serverAtEnd, { key: item.key, witnesses: [], posts: [] });
      const index = evidence.log.findIndex(value => value.kind === "collect-failed");
      assert.deepEqual(evidence.log.slice(index).map(value => value.kind), ["collect-failed", "failure-metadata", "failure-document", "cancel", "close"]);
      return true;
    });
    assert.equal(evidence.log.filter(value => value.kind === "click").length, 13); assert.equal(evidence.log.filter(value => value.kind === "addFrame").length, 1);
  }, { collectError: original, cancelError, cancelErrorVariant: "dynamic-oopif" });
});

test("directory observation rejection and cancel failure cannot replace a frozen original error", () => {
  const original = Object.freeze(new Error("Frozen original click failure"));
  return harness(async (args, evidence) => {
    await assert.rejects(checkDirectoryUpload(args), error => error === original);
    assert.deepEqual(evidence.log.map(value => value.kind), ["connect", "click", "failure-metadata", "cancel", "close"]);
  }, { clickError: original, observationError: new Error("worker unavailable"), cancelError: new Error("cancel failed") });
});

test("inactive negative requires native cancel immediately and after cleanup, with one original chooser submission", () => harness(async (args, evidence) => {
  const value = await checkInactiveDirectoryRejection({ ...args, expectedWindowId: 73 });
  assert.equal(value.passed, true); assert.equal(value.cancelWitness.trusted, true);
  assert.deepEqual(value.finalServer, value.atReturn); assert.deepEqual(value.atReturn.posts, []);
  assert.deepEqual(evidence.log.map(value => value.kind), ["connect", "click", "set", "cancel", "close"]);
  assert.equal(evidence.untilCalls, 0);
}, { inactiveCancel: true }));

test("inactive negative captures the original scope after both cold clients bootstrap through public getTabs", () => harness(async (args, evidence) => {
  assert.equal(args.browser.client.controlEpoch, null);
  const value = await checkInactiveDirectoryRejection({ ...args, expectedWindowId: 73 });
  assert.equal(value.passed, true); assert.equal(value.scope.control_epoch, 7); assert.equal(value.scope.turn_id, "original");
  assert.deepEqual(evidence.log.slice(0, 4), [
    { kind: "connect" }, { kind: "getTabs", controlEpoch: null }, { kind: "getTabs", controlEpoch: null }, { kind: "newTab", controlEpoch: 7 }
  ]);
  assert.equal(evidence.log.filter(item => item.kind === "set").length, 1);
  assert.deepEqual(value.atReturn.posts, []); assert.deepEqual(value.finalServer, value.atReturn);
}, { coldClient: true, inactiveCancel: true }));

for (const [name, options, pattern] of [
  ["early native ACK", { earlyReturn: true }, /incorrectly reported/],
  ["timeout", { inactiveCancel: true, wrongCancelError: true }, /native cancel/],
  ["synthetic cancel", { inactiveCancel: true, syntheticCancel: true }, /Expected values/],
  ["already active native tab", { inactiveCancel: true, nativeActive: true }, /Expected values/]
]) test(`inactive negative rejects ${name}`, () => harness(async args => {
  await assert.rejects(checkInactiveDirectoryRejection({ ...args, expectedWindowId: 73 }), error => { assert.match(error.message, pattern); assert.equal(error.directoryDetail.passed, false); return true; });
}, options));

test("inactive cancellation rejects any later input/change/upload evidence", () => {
  const value = witness("cancel", { files: [], eventIndex: 1 });
  const record = { key: "unit", witnesses: [hit(value)], posts: [] };
  checkInactiveDirectoryCancellation(record, { key: "unit", url: value.href });
  for (const bad of [{ ...record, witnesses: [] }, { ...record, witnesses: [hit(value), hit(witness())] }, { ...record, posts: [hit(witness("change"))] }])
    assert.throws(() => checkInactiveDirectoryCancellation(bad, { key: "unit", url: value.href }));
});
